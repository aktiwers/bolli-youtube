// DASH engine of the player: plays a video's separate video and audio formats (api/streams.ts: MP4 with a sidx
// index, WebM with Cues) through Media Source. Each track first fetches its head (init and index, plus the first
// piece of media when starting at 0, saving a round trip), then its segments in ~1 s ranged requests (YouTube
// throttles one long request), up to AHEAD s / AHEAD_MB ahead; media the player will skip (skips: SponsorBlock's)
// is not loaded, the time and bytes ahead count on past it. Data behind is trimmed at segment starts and only
// between segments: a trim with a segment half appended makes the TV's Media Source drop the rest of it.
// Jumps land on keyframes (segment starts): the TV's decoder decodes from the previous keyframe at ~2.3x speed.
// Seeks wait while a buffer updates; no trim runs during a seek (it hangs). A 403 fails as 'expired' (renew
// continues with new URLs); a request that gets no data for a while, or no answer, goes at once to another of the
// video's networks while there is one (networks.ts); other errors fail as 'network' after retries. prefetchHeads
// fetches heads ahead. A start tells the TV the video ends at most WINDOW_S after it and loads no further until it
// plays: this TV's browser waits for ~3 s of fed video before playing (~1.5 s more of decoding), but not within 10 s
// of the end; then the real length comes back and the audio segment the window cut is appended again past the cut.

import { Format } from '../api/streams.js';
import { parseCues, parseSidx, Segment } from './containers.js';
import { AHEAD_MB, BEHIND_MB, BEHIND_S, bufferedEnd, Engine, hopHole, jumpTarget, KEYFRAME_IN, MB, RETRIES, seekNudged, Skip, STILL_AHEAD, TICK_MS, TIMEOUT_MS } from './engine.js';
import { networkFailed, onNetwork, stallWatch } from './networks.js';
import { growLength, keepPipeline, openPipeline, Pipeline, setLength, spoilingFail } from './pipeline.js';

/** A start's window (windowEnd): the TV is told the video ends at most this far after the start (s) */
var WINDOW_S = 9.5;
/** Buffer up to this far ahead of the playhead (s; and up to AHEAD_MB per track); BEHIND_S, BEHIND_MB are kept behind
 * it, so a jump back stays buffered */
var AHEAD = 30;
/** A request fetches about CHUNK_S of the format (CHUNK_MIN to CHUNK_MAX bytes); the first after a start or a
 * seek a third of that, for a faster first frame */
var CHUNK_S = 1.2;
var CHUNK_MIN = 1024 * 1024;
var CHUNK_MAX = 4 * 1024 * 1024;
var FIRST_MIN = 384 * 1024;
/** A format switch (switchVideo, switchAudio) takes effect about this far ahead of the playhead (s); video never
 * nearer than SWITCH_MIN_S (removing what the TV's decoder already holds, ~3 s, breaks playback), retried every
 * SWITCH_RETRY_MS until the buffer reaches that far */
var SWITCH_S = 3;
var SWITCH_MIN_S = 4;
var SWITCH_RETRY_MS = 1000;
/** A part the player skips (SponsorBlock) is not loaded from this far into it on (s; its start stays, so the jump
 * comes before the gap), and parts this close after each other are one jump (the player's jumps too) */
var SKIP_IN_S = 1;
export var SKIP_CHAIN_S = 0.5;

/** The skips in order, those that follow each other at once joined */
export function joinedSkips(skips: Skip[]): Skip[] {
    var out: Skip[] = [];
    skips.slice().sort(function (a, b) { return a.start - b.start; }).forEach(function (s) {
        var last = out[out.length - 1];
        if (last && s.start <= last.end + SKIP_CHAIN_S) {
            last.end = Math.max(last.end, s.end);
        } else {
            out.push({ start: s.start, end: s.end });
        }
    });
    return out;
}

/** Where loading goes on instead of media segment i: past a skip it lies in (from SKIP_IN_S into the skip, after the
 * playhead at now), at the segment the jump lands in; else i */
export function pastSkip(segments: Segment[], i: number, skips: Skip[], now: number): number {
    var seg = segments[i];
    for (var k = 0; seg && seg.start > now && k < skips.length; k++) {
        if (seg.start >= skips[k].start + SKIP_IN_S && seg.end <= skips[k].end) {
            var to = segmentAt(segments, skips[k].end);
            // Not one to the end (an outro): the stream would end early, and the video's length shrink to it
            return to < segments.length ? Math.max(i + 1, to) : i;
        }
    }
    return i;
}

/** Seconds buffered ahead of now, going on past the parts of skips not loaded (the player jumps over them; skips in
 * order) */
export function aheadOf(b: TimeRanges, now: number, skips: Skip[]): number {
    var end = bufferedEnd(b, now);
    var ahead = end - now;
    for (var k = 0; k < skips.length; k++) {
        if (skips[k].start < end && end < skips[k].end) {
            var after = bufferedEnd(b, skips[k].end);
            ahead += after - skips[k].end;
            end = after;
        }
    }
    return ahead;
}

/** The first segment ending past t (or the last) */
function segmentAcross(segments: Segment[], t: number): number {
    var i = 0;
    while (i < segments.length - 1 && segments[i].end <= t) {
        i++;
    }
    return i;
}

/** Resets a buffer's parser (it may be mid-segment) and its append window */
function resetParser(sb: SourceBuffer): void {
    try {
        sb.abort();
    } catch (e) {
        // Source no longer open: stop is near
    }
}

/** Index of the segment playing at time t (past the end: their count) */
export function segmentAt(segments: Segment[], t: number): number {
    for (var i = 0; i < segments.length; i++) {
        if (segments[i].end > t + 0.05) {
            return i;
        }
    }
    return segments.length;
}

/** Bytes from..to of url, from its network that has not failed lately (onNetwork); a failure rejects with the HTTP
 * status (0: no answer or aborted, 'timeout'), or 'moved' when no answer or no data came and the video's next network
 * is left for the next request */
function fetchBytes(url: string, from: number, to: number): { xhr: XMLHttpRequest; done: Promise<ArrayBuffer> } {
    var xhr = new XMLHttpRequest();
    var used = onNetwork(url);
    var done = new Promise<ArrayBuffer>(function (resolve, reject) {
        // Range as a URL parameter, as YouTube's player does: no Range header, so no CORS preflight
        xhr.open('GET', used + '&range=' + from + '-' + to, true);
        xhr.responseType = 'arraybuffer';
        xhr.timeout = TIMEOUT_MS;
        xhr.onload = function () {
            if (xhr.status >= 200 && xhr.status < 300) {
                resolve(xhr.response as ArrayBuffer);
            } else {
                reject(xhr.status);
            }
        };
        var lost = function (stalled: boolean): void {
            reject(networkFailed(used, stalled) ? 'moved' : 0);
        };
        xhr.onerror = function () {
            lost(false);
        };
        // (a stalled one rejects before its abort)
        xhr.onabort = function () {
            reject(0);
        };
        xhr.ontimeout = function () {
            reject('timeout');
        };
        stallWatch(xhr, function () { lost(true); });
        xhr.send();
    });
    return { xhr: xhr, done: done };
}

class Track {
    sb: SourceBuffer | null = null;
    segments: Segment[] = [];
    /** The init section (appended first, then released), and how many bytes of the first segment came with it */
    init: ArrayBuffer | null = null;
    started = 0;
    /** The segment loading (or next), and its next byte to request */
    next = 0;
    pos = 0;
    /** The next request is the first after a start or a seek */
    fresh = true;
    /** Bytes per request */
    chunk: number;
    xhr: XMLHttpRequest | null = null;
    /** Incremented by a seek and by stop: responses still in flight are discarded */
    gen = 0;
    /** Data not appended yet; full: because the buffer was full */
    waiting: ArrayBuffer | null = null;
    full = false;
    failures = 0;
    /** A failed request's wait (1 s more per failure in a row, up to 5 s): no request meanwhile, not even from the
     * tick; it pumps at its end (also when paused: no tick then) */
    retryTimer = 0;
    /** Count of switches requested (a later one cancels one still waiting for its place) */
    switchAsked = 0;
    /** A format switch waiting for its buffer (switchTrack): from segment index, cut at from (s); removed: the old
     * format's data from there has been removed */
    switching: { format: Format; segments: Segment[]; init: ArrayBuffer; index: number; from: number; removed?: boolean } | null = null;
    /** Append window start for a switched audio track's first segment (s; -1: none) */
    cut = -1;
    /** The segment across the start's window (-1: none) */
    windowCut = -1;

    constructor(public format: Format) {
        this.chunk = chunkOf(format);
    }

    /** Moves to the start of segment i */
    at(i: number): void {
        this.next = i;
        this.pos = i < this.segments.length ? this.segments[i].from : 0;
        this.fresh = true;
    }

    /** No wait after failures: the next request goes at once, its failures counted anew */
    retryNow(): void {
        clearTimeout(this.retryTimer);
        this.retryTimer = 0;
        this.failures = 0;
    }

    /** The first byte of the segment playing at t */
    byteAt(t: number): number {
        var i = Math.min(segmentAt(this.segments, t), this.segments.length - 1);
        return this.segments[i].from;
    }
}

/** Bytes per request of a format: about CHUNK_S of it */
function chunkOf(f: Format): number {
    return Math.max(CHUNK_MIN, Math.min(CHUNK_MAX, Math.round(f.bitrate / 8 * CHUNK_S)));
}

/** Bytes of the first request after a start or a seek: a third of the usual, for a faster first frame */
function pieceOf(chunk: number): number {
    return Math.max(FIRST_MIN, Math.round(chunk / 3));
}

/** Heads fetched ahead (prefetchHeads), by URL and range */
var ahead: { [key: string]: { xhr: XMLHttpRequest; done: Promise<ArrayBuffer>; read?: boolean } } = {};

/** End byte of the first request of a start at startAt (s): the head; when starting at 0 also the first piece of
 * media, which follows the index */
function headEnd(f: Format, startAt: number): number {
    return startAt < 1 ? Math.min(f.index.end + pieceOf(chunkOf(f)), f.length ? f.length - 1 : Infinity) : f.index.end;
}

function headKey(f: Format, end: number): string {
    return f.url + ' ' + end;
}

/** Fetches the heads for a start at startAt ahead of time (used for the focused tile's video). Only the latest
 * pair is kept; earlier ones are aborted, failed ones dropped. */
export function prefetchHeads(video: Format, audio: Format, startAt: number): void {
    var next: typeof ahead = {};
    [video, audio].forEach(function (f) {
        var end = headEnd(f, startAt);
        var key = headKey(f, end);
        var got = next[key] = ahead[key] || fetchBytes(f.url, 0, end);
        delete ahead[key];
        got.done.then(null, function () {
            if (ahead[key] === got) {
                delete ahead[key];
            }
        });
    });
    dropAhead();
    ahead = next;
}

/** Aborts and drops prefetched heads not taken by a start (takeOver: a start takes a preview over, whose engine
 * waits on the heads it reads: those are left to finish) */
export function dropAhead(takeOver?: boolean): void {
    for (var key in ahead) {
        if (!(takeOver && ahead[key].read)) {
            ahead[key].xhr.abort();
        }
    }
    ahead = {};
}

/** A prefetched head (taken once; read: left for the next caller), else fetched now */
function head(f: Format, end: number, read: boolean): Promise<ArrayBuffer> {
    var key = headKey(f, end);
    var had = ahead[key];
    if (read && had) {
        had.read = true;
    } else {
        delete ahead[key];
    }
    return had ? had.done : fetchBytes(f.url, 0, end).done;
}

/** A format's segments and init section, from its head (its first bytes, through the index) */
function headParts(f: Format, data: ArrayBuffer): { segments: Segment[]; init: ArrayBuffer } {
    return { segments: /webm/.test(f.mime) ? parseCues(data, f.length, f.duration) : parseSidx(data), init: data.slice(0, f.init.end + 1) };
}

export class DashEngine implements Engine {
    private tracks: Track[] = [];
    private timer = 0;
    private stopped = false;
    private listeners: { [event: string]: () => void } = {};
    private pipe: Pipeline | null = null;
    /** A seek waiting for the buffers to finish updating (-1: none), and the watchdog of the running seek */
    private pending = -1;
    private stuckTimer = 0;
    /** At most this far ahead (s; 0: AHEAD): hold */
    private most = 0;
    /** The start's window: the length the TV is told until the video plays (s; 0: none), the real length, and where
     * the window ended once lifted */
    private window = 0;
    private length = 0;
    private cutAt = 0;

    /** onFail: 'expired' (the URLs expired), 'media' (Media Source or the decoder), 'network', 'stream' (no index) */
    private onFail: (why: string) => void;
    /** The parts the player will skip (SponsorBlock's, not skipped yet): their media is not loaded, what follows is */
    skips: () => Skip[] = function () { return []; };

    constructor(private video: HTMLVideoElement, onFail: (why: string) => void) {
        // A pipeline whose decoder failed is not kept for the next video
        this.onFail = spoilingFail(onFail);
    }

    renew(video: Format, audio: Format): boolean {
        var tracks = this.tracks;
        var same = function (track: Track | undefined, f: Format): boolean {
            return !!track && track.format.itag === f.itag && track.format.lmt === f.lmt;
        };
        // Not open yet: the caller starts anew
        if (this.stopped || !same(tracks[0], video) || !same(tracks[1], audio) || !tracks[0].sb) {
            return false;
        }
        tracks[0].format = video;
        tracks[1].format = audio;
        for (var i = 0; i < tracks.length; i++) {
            tracks[i].retryNow();
            this.pump(tracks[i]);
        }
        return true;
    }

    /** Seeks to t (s): now, or once no buffer is updating */
    seek(t: number): void {
        this.widen();
        this.pending = t;
        this.settle();
    }

    /** Jumps from from towards to (s): to the nearest keyframe (a video segment's start) on that side of from */
    jump(to: number, from: number): void {
        this.seek(jumpTarget((this.tracks.length ? this.tracks[0].segments : []).map(function (s) { return s.start; }), to, from));
    }

    seekTarget(): number {
        return this.pending;
    }

    /** Plays the formats from startAt (s); preview: prefetched heads are only read, left for the player's start */
    load(video: Format, audio: Format, startAt: number, preview?: boolean): void {
        var self = this;
        var tracks = [new Track(video), new Track(audio)];
        this.tracks = tracks;
        // Fetch the heads while Media Source opens
        var heads = Promise.all(tracks.map(function (track) {
            var f = track.format;
            var end = headEnd(f, startAt);
            var tried = false;
            var again = function (e: unknown): Promise<ArrayBuffer> {
                // Once more, as segments are (a passing error), and again while another network is left; not for
                // expired URLs nor once stopped
                if (e === 403 || self.stopped || tried && e !== 'moved') {
                    throw e;
                }
                tried = true;
                return fetchBytes(f.url, 0, end).done.then(null, again);
            };
            return head(f, end, !!preview).then(null, again).then(function (data) {
                var parts = headParts(f, data);
                track.segments = parts.segments;
                if (!track.segments.length) {
                    throw 'stream';
                }
                track.init = parts.init;
                var media = data.byteLength - (f.index.end + 1);
                if (media > 0 && track.segments[0].from === f.index.end + 1) {
                    // Init and media in one append; the track goes on after them
                    var both = new Uint8Array(track.init.byteLength + media);
                    both.set(new Uint8Array(track.init), 0);
                    both.set(new Uint8Array(data, f.index.end + 1), track.init.byteLength);
                    track.init = both.buffer;
                    track.started = media;
                }
            });
        }));
        // Reuse the previous video's pipeline if it takes these formats, else open a fresh one
        var opened = openPipeline(this.video, [video.mime, audio.mime]).then(function (pipe) {
            self.pipe = pipe;
            // Stopped meanwhile: keep it for the next video
            if (self.stopped) {
                keepPipeline(self.video, pipe);
            }
        });
        Promise.all([heads, opened]).then(function () {
            if (!self.stopped) {
                self.open(startAt);
            }
        }, function (e) {
            // 'stale': superseded by a newer request
            if (!self.stopped && e !== 'stale') {
                self.onFail(e === 403 ? 'expired' : e === 'stream' || e === 'media' ? e : 'network');
            }
        });
    }

    /** Switches the video format in place (switchTrack), e.g. when a preview taken over full screen moves to the
     * full-screen quality */
    switchVideo(f: Format, ahead?: number): void {
        this.switchTrack(0, f, ahead);
    }

    /** Switches the audio format in place (switchTrack): another language, or stable volume on or off */
    switchAudio(f: Format, ahead?: number): void {
        this.switchTrack(1, f, ahead);
    }

    /** Switches a track's format in place (same codec, same Media Source) about aheadS ahead of the playhead, within
     * the buffered range: the old format's data from there is removed, the parser reset, then the new init and
     * segments are appended. Video switches at a keyframe (YouTube cuts all formats of a video at the same places)
     * between SWITCH_MIN_S ahead and the buffer's end, retried every SWITCH_RETRY_MS while none exists; audio switches
     * at the exact point (its segments are 10 s, so the append window drops the frames before it). If the new head
     * fails or the end is near, the old format continues. A newer switch of the track replaces a pending one. */
    private switchTrack(index: number, f: Format, ahead?: number): void {
        var self = this;
        var track = this.tracks[index];
        if (!track || this.stopped || track.format.url === f.url) {
            return;
        }
        var asked = ++track.switchAsked;
        head(f, f.index.end, false).then(function (data) {
            self.placeSwitch(track, index, f, headParts(f, data), ahead || SWITCH_S, asked);
        }, function () { return undefined; });
    }

    /** Schedules the switch of track to f (parts: from its head), now or once the buffer reaches the switch point */
    private placeSwitch(track: Track, index: number, f: Format, parts: { segments: Segment[]; init: ArrayBuffer }, aheadS: number, asked: number): void {
        var self = this;
        var segments = parts.segments;
        if (this.stopped || this.tracks[index] !== track || !track.sb || !segments.length || track.switchAsked !== asked) {
            return;
        }
        var now = this.video.currentTime;
        var end = bufferedEnd(track.sb.buffered, now);
        var i = -1;
        var from = 0;
        if (index === 0) {
            // The first keyframe aheadS ahead, else the last one before the buffer's end, never nearer than SWITCH_MIN_S
            for (var k = 0; k < segments.length && segments[k].start <= end; k++) {
                if (segments[k].start >= now + SWITCH_MIN_S) {
                    i = k;
                    if (segments[k].start >= now + aheadS) {
                        break;
                    }
                }
            }
        } else {
            from = Math.min(now + aheadS, end);
            i = from < now + 0.5 ? -1 : segmentAt(segments, from);
        }
        if (i < 0) {
            // Too little buffered yet (as after a seek): retry later, the old format fills the buffer meanwhile
            if (segmentAt(segments, now) < segments.length - 1) {
                setTimeout(function () { self.placeSwitch(track, index, f, parts, aheadS, asked); }, SWITCH_RETRY_MS);
            }
            return;
        }
        if (index === 0) {
            from = segments[i].start;
        }
        this.drop(track);
        track.switching = { format: f, segments: segments, init: parts.init, index: i, from: from };
        this.pump(track);
    }

    stop(): void {
        this.stopped = true;
        this.window = 0;
        clearInterval(this.timer);
        clearTimeout(this.stuckTimer);
        for (var event in this.listeners) {
            this.video.removeEventListener(event, this.listeners[event]);
        }
        this.listeners = {};
        for (var i = 0; i < this.tracks.length; i++) {
            this.drop(this.tracks[i]);
        }
        this.tracks = [];
        keepPipeline(this.video, this.pipe);
    }

    private open(startAt: number): void {
        var self = this;
        var pipe = this.pipe as Pipeline;
        try {
            var tracks = this.tracks;
            // A seek requested before the source opened (e.g. a segment skipped at the start) wins
            if (this.pending >= 0) {
                startAt = this.pending;
            }
            // Not from 0: both tracks start at the keyframe at or before startAt
            if (startAt > 0) {
                var keys = tracks[0].segments;
                startAt = keys[Math.min(segmentAt(keys, startAt), keys.length - 1)].start + KEYFRAME_IN;
            }
            this.length = Math.max(tracks[0].segments[tracks[0].segments.length - 1].end, tracks[1].segments[tracks[1].segments.length - 1].end);
            this.window = windowEnd(tracks[0].segments, startAt, this.length);
            for (var i = 0; i < tracks.length; i++) {
                var track = tracks[i];
                track.sb = pipe.buffers[i];
                // The audio cut at the window, also what came with its head
                if (this.window && i > 0) {
                    track.sb.appendWindowEnd = this.window;
                    track.windowCut = segmentAcross(track.segments, this.window);
                }
                track.at(segmentAt(track.segments, startAt));
                if (track.started && !track.next) {
                    // Media came with the head: continue after it (a short first segment may be complete)
                    track.fresh = false;
                    track.pos += track.started;
                    while (track.next < track.segments.length && track.pos > track.segments[track.next].to) {
                        track.next++;
                    }
                    // Not the video past the start's window: the length set back to the window (as the TV puts the
                    // previous video's back) removes it, and the rest of its segment cannot be decoded without it
                    var after = i === 0 && this.window ? segmentAcross(track.segments, this.window) : -1;
                    if (after >= 0 && track.pos > track.segments[after].from) {
                        var head = track.init as ArrayBuffer;
                        var past = track.pos - track.segments[after].from;
                        track.init = head.slice(0, head.byteLength - past);
                        track.started -= past;
                        track.next = after;
                        track.pos = track.segments[after].from;
                    }
                } else if (track.started) {
                    // A seek before the open moved the start (a segment skipped at once): the head's media, the first
                    // segment's start, is not appended (before another segment it broke the stream: a media error)
                    var init = track.init as ArrayBuffer;
                    track.init = init.slice(0, init.byteLength - track.started);
                    track.started = 0;
                }
            }
            pipe.onUpdate = function (i) {
                var track = self.tracks[i];
                if (track) {
                    self.settle();
                    self.hop();
                    self.pump(track);
                }
            };
            // Last: a kept pipeline's longer length shortened removes the data past it, the buffers updating meanwhile
            setLength(pipe, this.window || this.length);
        } catch (e) {
            this.onFail('media');
            return;
        }
        this.on('seeking', function () { self.seeked(); });
        this.on('seeked', function () { clearTimeout(self.stuckTimer); });
        this.on('waiting', function () { self.hop(); });
        this.on('pause', function () { self.rest(); });
        this.on('playing', function () {
            self.widen();
            self.arm();
        });
        this.on('error', function () { self.onFail('media'); });
        if (startAt > 0) {
            // Seek once the metadata is in (not possible before); requests start from there meanwhile
            this.pending = startAt;
            this.on('loadedmetadata', function () {
                self.video.removeEventListener('loadedmetadata', self.listeners.loadedmetadata);
                self.settle();
            });
            // A kept pipeline already has its metadata, so no event comes
            this.settle();
        }
        this.arm();
        this.pumpAll();
    }

    private on(event: string, listener: () => void): void {
        this.listeners[event] = listener;
        this.video.addEventListener(event, listener);
    }

    private arm(): void {
        if (!this.timer && !this.stopped) {
            var self = this;
            this.timer = setInterval(function () {
                self.hop();
                self.pumpAll();
            }, TICK_MS) as unknown as number;
        }
    }

    private rest(): void {
        clearInterval(this.timer);
        this.timer = 0;
    }


    /** Runs the pending seek once the metadata is in and no buffer is updating; a seek not done in SEEK_STUCK_MS
     * is nudged on */
    private settle(): void {
        // Not before the buffers are attached: a kept pipeline has the previous video's metadata, and a seek
        // requested meanwhile becomes the start position
        var first = this.tracks[0];
        if (this.pending < 0 || this.video.readyState < 1 || !first || !first.sb) {
            return;
        }
        for (var i = 0; i < this.tracks.length; i++) {
            var sb = this.tracks[i].sb;
            if (sb && sb.updating) {
                // Retried on the buffer's updateend
                return;
            }
        }
        var t = this.pending;
        this.pending = -1;
        clearTimeout(this.stuckTimer);
        this.stuckTimer = seekNudged(this.video, t);
    }

    /** Moves a stalled playhead over a short hole just before buffered data */
    private hop(): void {
        if (this.pending < 0 && this.video.readyState <= 2 && this.tracks.length) {
            hopHole(this.video);
        }
    }

    /** The start's window lifted (the video plays, or a seek moves it): the real length again, loading past it */
    private widen(): void {
        if (!this.window || !this.pipe) {
            return;
        }
        this.cutAt = this.window;
        this.window = 0;
        growLength(this.pipe, this.length);
        this.pumpAll();
    }

    private pumpAll(): void {
        for (var i = 0; i < this.tracks.length; i++) {
            this.pump(this.tracks[i]);
        }
    }

    hold(s: number): void {
        this.most = s;
        this.pumpAll();
    }

    private pump(track: Track): void {
        var sb = track.sb;
        if (this.stopped || !sb || sb.updating || track.xhr || track.retryTimer) {
            return;
        }
        // The start's window lifted (widen): the segment it cut loaded again, its frames before the cut dropped (as a
        // switched audio track's first segment), if any of it went in
        if (track.windowCut >= 0 && !this.window) {
            var c = track.windowCut;
            track.windowCut = -1;
            sb.appendWindowEnd = Infinity;
            if (track.next > c || track.next === c && track.pos > track.segments[c].from) {
                // (the parser may be mid-segment: reset first, as for a switch)
                resetParser(sb);
                track.waiting = null;
                track.at(c);
                track.cut = this.cutAt;
                sb.appendWindowStart = this.cutAt;
            }
        }
        // A format switch: remove the old format's data from the switch point, then load the new one from there
        // (not during a seek: seeked() applies it at the new place)
        var sw = track.switching;
        if (sw && this.pending < 0 && !this.video.seeking) {
            // Once: an audio frame across the cut stays (it ends where the new format's next one starts)
            var b = sb.buffered;
            if (!sw.removed && b.length && b.end(b.length - 1) > sw.from + 0.01) {
                sw.removed = true;
                sb.remove(sw.from, b.end(b.length - 1));
                return;
            }
            this.takeSwitch(track);
            track.at(sw.index);
            // The parser may be mid-segment of the old format: reset it before the new init
            resetParser(sb);
            if (sw.from > sw.segments[sw.index].start + 0.01) {
                track.cut = sw.from;
                sb.appendWindowStart = sw.from;
            }
        }
        if (track.waiting) {
            // Buffer full: trim what is behind first
            if (!track.full || !this.trim(track)) {
                this.append(track, track.waiting);
            }
            return;
        }
        if (track.init) {
            var init = track.init;
            track.init = null;
            this.append(track, init);
            return;
        }
        // A switched audio track's first segment is in: append the rest whole
        if (track.cut >= 0 && (track.next >= track.segments.length || track.segments[track.next].start >= track.cut)) {
            track.cut = -1;
            sb.appendWindowStart = 0;
        }
        if (this.trim(track)) {
            return;
        }
        // A seek pending with metadata in: load nothing more at the old place (the tracks move once it runs)
        if (this.pending >= 0 && this.video.readyState >= 1) {
            return;
        }
        // The playhead, or the target of the start's seek (a start from a resume point, not from 0)
        var now = this.pending >= 0 ? this.pending : this.video.currentTime;
        var segments = track.segments;
        var skips = joinedSkips(this.skips());
        // Media the player will skip is not loaded: on from where its jump lands (it lands in loaded media)
        if (track.next < segments.length && track.pos === segments[track.next].from) {
            var past = pastSkip(segments, track.next, skips, now);
            if (past !== track.next) {
                track.at(past);
            }
        }
        if (track.next >= segments.length) {
            this.endIfDone();
            return;
        }
        if (aheadOf(sb.buffered, now, skips) > (this.most || AHEAD) || this.bytesAhead(track, now, skips) > AHEAD_MB * MB) {
            return;
        }
        var segment = segments[track.next];
        if (this.window && segment.start >= this.window) {
            return;
        }
        var to = Math.min(segment.to, track.pos + (track.fresh ? pieceOf(track.chunk) : track.chunk) - 1);
        var self = this;
        var gen = track.gen;
        var req = fetchBytes(track.format.url, track.pos, to);
        track.xhr = req.xhr;
        req.done.then(function (data) {
            if (track.gen !== gen) {
                return;
            }
            track.xhr = null;
            track.failures = 0;
            track.fresh = false;
            if (to < segment.to) {
                track.pos = to + 1;
            } else {
                track.next++;
                track.pos = track.next < segments.length ? segments[track.next].from : 0;
            }
            self.append(track, data);
        }, function (e) {
            if (track.gen !== gen) {
                // Dropped for a seek or stop
                return;
            }
            track.xhr = null;
            if (e === 403) {
                self.onFail('expired');
                return;
            }
            // No answer or no data: at once from the next network (both tracks go there)
            if (e === 'moved') {
                self.pump(track);
                return;
            }
            // While the buffer still plays, a short network drop is waited out
            var ahead = bufferedEnd(self.video.buffered, self.video.currentTime) - self.video.currentTime;
            if (++track.failures > RETRIES && ahead < STILL_AHEAD) {
                self.onFail('network');
                return;
            }
            track.retryTimer = setTimeout(function () {
                track.retryTimer = 0;
                self.pump(track);
            }, 1000 * Math.min(track.failures, 5)) as unknown as number;
        });
    }

    /** Bytes loaded (or asked for) ahead of the playhead at now, not counting the media of skips left out */
    private bytesAhead(track: Track, now: number, skips: Skip[]): number {
        var bytes = track.pos - track.byteAt(now);
        var segments = track.segments;
        if (!skips.length) {
            return bytes;
        }
        var b = (track.sb as SourceBuffer).buffered;
        for (var k = segmentAt(segments, now); k < track.next && k < segments.length; k++) {
            // (one loaded before the skip was known stays counted)
            if (pastSkip(segments, k, skips, now) !== k && bufferedEnd(b, segments[k].start, 0) <= segments[k].start) {
                bytes -= segments[k].to - segments[k].from + 1;
            }
        }
        return bytes;
    }

    /** Trims data more than BEHIND_S or BEHIND_MB behind the playhead to half that, at a segment start (a keyframe).
     * Not during a seek, nor with a segment half appended unless the buffer is full. True when a trim began. */
    private trim(track: Track): boolean {
        var v = this.video;
        var b = (track.sb as SourceBuffer).buffered;
        var segments = track.segments;
        if (!b.length || v.seeking || this.pending >= 0 || !track.full && track.next < segments.length && track.pos !== segments[track.next].from) {
            return false;
        }
        var now = v.currentTime;
        var playing = track.byteAt(now);
        if (now - b.start(0) <= BEHIND_S && playing - track.byteAt(b.start(0)) <= BEHIND_MB * MB) {
            return false;
        }
        for (var i = segmentAt(segments, b.start(0)) + 1; i < segments.length && segments[i].from < playing; i++) {
            if (now - segments[i].start <= BEHIND_S / 2 && playing - segments[i].from <= BEHIND_MB * MB / 2) {
                break;
            }
        }
        if (i >= segments.length || segments[i].start <= b.start(0)) {
            return false;
        }
        (track.sb as SourceBuffer).remove(b.start(0), segments[i].start);
        return true;
    }

    /** Moves the track to its pending switch's format (the caller sets the position) */
    private takeSwitch(track: Track): void {
        var sw = track.switching;
        if (!sw) {
            return;
        }
        track.switching = null;
        this.drop(track);
        track.format = sw.format;
        track.chunk = chunkOf(sw.format);
        track.segments = sw.segments;
        track.init = sw.init;
        track.started = 0;
    }

    /** Drops whatever the track has in flight (on a seek or stop) */
    private drop(track: Track): void {
        track.gen++;
        track.waiting = null;
        track.full = false;
        track.retryNow();
        if (track.xhr) {
            track.xhr.abort();
            track.xhr = null;
        }
    }

    private append(track: Track, data: ArrayBuffer): void {
        var sb = track.sb as SourceBuffer;
        if (sb.updating) {
            track.waiting = data;
            return;
        }
        try {
            sb.appendBuffer(data);
            track.waiting = null;
            track.full = false;
        } catch (e) {
            if ((e as Error).name !== 'QuotaExceededError') {
                this.onFail('media');
                return;
            }
            // Buffer full: retried on the next tick, once there is more behind to trim
            track.waiting = data;
            track.full = true;
        }
    }

    private seeked(): void {
        var t = this.video.currentTime;
        for (var i = 0; i < this.tracks.length; i++) {
            var track = this.tracks[i];
            // A pending format switch: load the new format from the new place (position set below)
            if (track.switching) {
                this.takeSwitch(track);
                track.next = -1;
            }
            var sb = track.sb;
            // A switched audio track's cut no longer applies: the append window resets once nothing is appending
            if (track.cut > 0) {
                track.cut = 0;
            }
            if (!sb) {
                continue;
            }
            // Continue from the segment at the end of what is buffered at the new time (a segment already in flight
            // there is kept, as is one loaded but still appending: not in buffered yet), asked for now: paused, the
            // tick rests until it plays, which needs it
            var end = bufferedEnd(sb.buffered, t, 0.04);
            var next = segmentAt(track.segments, end);
            // Still appending (or waiting to): the segment the last answer since a move completed (the track is at the
            // next one's start), right after what is buffered at t
            var appending = (sb.updating || !!track.waiting) && !track.fresh && end > t && next === track.next - 1 &&
                track.pos === (track.next < track.segments.length ? track.segments[track.next].from : 0);
            // During the start's window, loaded up to it is all there is to load
            var loaded = this.window > 0 && end >= this.window - 0.05;
            if (next !== track.next && !appending && !loaded) {
                this.drop(track);
                // The parser may be mid-segment: reset it, as the new segment starts afresh (the window's cut again)
                resetParser(sb);
                if (this.window && track.windowCut >= 0) {
                    sb.appendWindowEnd = this.window;
                }
                track.at(next);
            }
            this.pump(track);
        }
    }

    /** Ends the stream once all segments of all tracks are appended */
    private endIfDone(): void {
        for (var i = 0; i < this.tracks.length; i++) {
            var track = this.tracks[i];
            if (track.next < track.segments.length || track.xhr || track.waiting || (track.sb && track.sb.updating)) {
                return;
            }
        }
        if (this.pipe && this.pipe.source.readyState === 'open') {
            this.pipe.source.endOfStream();
        }
    }
}

/** Where a start's window ends: the end of the last video segment ending within WINDOW_S of startAt (a video segment
 * cut would lose its frames after the cut until the next keyframe; 0: none: a video ending near there anyway, or a
 * first segment longer than that) */
export function windowEnd(video: Segment[], startAt: number, length: number): number {
    if (length - startAt <= WINDOW_S + 1) {
        return 0;
    }
    var end = 0;
    for (var i = Math.max(0, segmentAt(video, startAt)); i < video.length && video[i].end <= startAt + WINDOW_S; i++) {
        end = video[i].end;
    }
    return end;
}
