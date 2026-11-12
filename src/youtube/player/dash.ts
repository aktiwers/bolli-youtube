// DASH engine of the player: plays a video's separate video and audio formats (api/streams.ts: MP4 with a sidx
// index, WebM with Cues) through Media Source. Each track first fetches its head (init and index, plus the first
// piece of media when starting at 0, saving a round trip), then its segments in ~1 s ranged requests (YouTube
// throttles one long request), up to AHEAD s / AHEAD_MB ahead (engine.ts roomAhead); media the player will skip (skips: SponsorBlock's)
// is not loaded, the time and bytes ahead count on past it. Data behind is trimmed at segment starts and only
// between segments: a trim with a segment half appended makes the TV's Media Source drop the rest of it.
// Jumps land on keyframes (segment starts): the TV's decoder decodes from the previous keyframe at ~2.3x speed.
// Seeks wait while a buffer updates; no trim runs during a seek (it hangs). A 403 fails as 'expired' (renew
// continues with new URLs); a request that gets no data for a while, or no answer, goes at once to another of the
// video's networks while there is one (networks.ts); other errors fail as 'network' after retries. prefetchHeads
// fetches heads ahead. A start tells the TV the video ends at most WINDOW_S after it and loads no further until it
// plays: this TV's browser waits for ~3 s of fed video before playing (~1.5 s more of decoding), but not within 10 s
// of the end; then the real length comes back and the audio segment the window cut is appended again past the cut,
// its frames from the cut on only (containers.ts framesFrom: else the TV plays ~46 ms of sound twice, late after it).
// A seek has its window too (quick jumps: engine.ts QUICK_MIN_S, windowFor): the TV waits the same 3 s after every
// seek. What is buffered past the window is removed first (never during a seek: waitSeek) and loaded again once the picture
// moves there.

import { Format } from '../api/streams.js';
import { framesFrom, parseCues, parseSidx, Segment, trackScale } from './containers.js';
import { BEHIND_MB, BEHIND_S, bufferedEnd, Engine, hopHole, jumpTarget, KEYFRAME_IN, LIFT_END_S, LIFT_MS, LIFT_S, MB, QUICK_MIN_S, QUICK_SPEED, QUICK_WAIT_MS, RETRIES, roomAhead, seekNudged, Skip, SPEED_BYTES, STILL_AHEAD, TICK_MS, TIMEOUT_MS, WINDOW_S, windowFrom } from './engine.js';
import { onLost, onNetwork } from './networks.js';
import { keepPipeline, openPipeline, Pipeline, setLength, setLengthSoon, spoilingFail } from './pipeline.js';

/** Buffer up to this far ahead of the playhead (s; and up to AHEAD_MB per track); BEHIND_S, BEHIND_MB are kept behind
 * it, so a jump back stays buffered */
var AHEAD = 30;
/** A request fetches about CHUNK_S of the format (CHUNK_MIN to CHUNK_MAX bytes); the first after a start or a
 * seek FIRST_SHARE of that, for a faster first frame: this TV shows a start's picture with ~0.18 s of video in (not
 * with 0.13 s), and a dense 4K keyframe with those frames is up to 0.4 of a request (measured: 1.35-1.45 MB of 3.6;
 * with less, the picture waits for a whole request more, ~0.7 s). In a start's
 * or a seek's window the requests stay that small until FIRST_S of video are in where it starts (short) */
var CHUNK_S = 1.2;
var CHUNK_MIN = 1024 * 1024;
var CHUNK_MAX = 4 * 1024 * 1024;
var FIRST_MIN = 384 * 1024;
var FIRST_SHARE = 0.42;
var FIRST_S = 0.2;
/** A format switch (switchVideo, switchAudio) takes effect about this far ahead of the playhead (s); video never
 * nearer than SWITCH_MIN_S (the TV has taken in the video 4.7-4.9 s ahead of the picture it shows: replacing what it
 * holds makes the picture stand for seconds at the switch), nor than the distance the caller asks (the new format's
 * first segment has that long to come: the old format's data from the switch point is removed, and a picture that
 * runs into the gap stands until the freeze watcher nudges it), retried every SWITCH_RETRY_MS until the buffer
 * reaches that far */
var SWITCH_S = 3;
export var SWITCH_MIN_S = 5.5;
var SWITCH_RETRY_MS = 1000;
/** A video switch to come soon (switchSoon) fetches the new format's first part before the old one's data goes, so
 * its point is only SWITCH_MIN_S and that fetch ahead: the part's bytes at the line's speed, SOON_MARGIN times, and a
 * round trip of SOON_TRIP_S (no speed measured yet, as in a preview's small downloads: SOON_S in all, a quick line's;
 * a part that comes too late for its keyframe costs only the next try, at the keyframe a longer wait would have
 * picked). Failed or come too late, it is tried again (further ahead), up to SOON_TRIES times in all; with the part
 * here, the old format's buffer is looked at every SOON_CHECK_MS until it reaches the point */
var SOON_MARGIN = 1.5;
var SOON_TRIP_S = 0.3;
var SOON_S = 0.4;
var SOON_TRIES = 3;
var SOON_CHECK_MS = 200;
/** A part the player skips (SponsorBlock) is not loaded from this far into it on (s; its start stays, so the jump
 * comes before the gap), and parts this close after each other are one jump (the player's jumps too) */
var SKIP_IN_S = 1;
export var SKIP_CHAIN_S = 0.5;
/** The video downloads whose speeds are kept for a seek's window (slow) */
var SPEEDS = 3;
/** A seek that lands this little past the end of what is buffered goes on from that end (s: a jump lands KEYFRAME_IN
 * after its keyframe, an audio frame is 21-32 ms) */
var NEAR_S = 0.1;
/** A seek's window does not cut an audio segment that ends this little after it (s): what is left of it, should a
 * seek come before it is loaded again, would later pass for nothing missing (a segment counts as whole from 0.05 s
 * before its end: pump), a hole in the sound */
var TAIL_S = 0.1;

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
        onLost(xhr, used, function () { reject('moved'); }, function () { reject(0); }, true);
        // (a stalled one rejects before its abort)
        xhr.onabort = function () {
            reject(0);
        };
        xhr.ontimeout = function () {
            reject('timeout');
        };
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
    /** The format a switch on its way brings (its URL; '': none on its way) */
    switchTo = '';
    /** A switch to come soon: its request for the new format's first part, on its way (switchSoon), and how many of
     * them were made (a download beside one shares the line: its speed says little, pump) */
    soon: XMLHttpRequest | null = null;
    soons = 0;
    /** A format switch waiting for its buffer (switchTrack): from segment index, cut at from (s); removed: the old
     * format's data from there has been removed */
    switching: { format: Format; segments: Segment[]; init: ArrayBuffer; index: number; from: number; removed?: boolean } | null = null;
    /** Append window start for a switched audio track's first segment (s; -1: none): that segment loaded whole goes in
     * from the cut on only (framesFrom, by the timescale of the init section appended last: an MP4's; 0 a WebM) */
    cut = -1;
    scale = 0;
    /** The segment across the start's window (-1: none) */
    windowCut = -1;
    /** For a seek's window (narrow): left to go on loading into it (its parser mid-segment), else what of it is
     * removed before the seek: from here on (s) */
    kept = false;
    clearFrom = 0;
    /** Moved for a seek's window (narrow), its parser not reset yet: clear does that once what it removes is gone. A
     * seek that takes that window's place first must not take the track as loading on (kept), nor leave its parser
     * mid-segment where it stands */
    moved = false;
    /** For a seek's window, the audio: the segment only partly buffered where the landing's buffer ends is appended
     * again from where its part ends (resumeFrom, s), as the segment a window cut is after the lift (-1: none) */
    resume = -1;
    resumeFrom = 0;
    /** Its append window's end is to be opened again before its next append (a cut given up: seeked) */
    open = false;
    /** The segment it loads goes in over a part of it that was there already (left mid-download by an earlier visit) */
    over = false;
    /** Its first media request of a start or a seek, made before it can be appended (early, landing): its bytes, when
     * asked (ms). The track's next request takes it, if it is that one. part: the first part of a switch to come soon
     * (placeSoon), here already, of the format with this URL: taken as long as it is, its speed not measured (it
     * waited). */
    early: { from: number; to: number; at: number; came?: number; req: { xhr: XMLHttpRequest; done: Promise<ArrayBuffer> }; part?: string } | null = null;

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

    /** The time at byte at of the segment loading (next), its bytes taken as spread evenly over its time (a segment can
     * be over 40 MB); past the last segment its end */
    timeNear(at: number): number {
        var s = this.segments[this.next];
        if (!s) {
            var last = this.segments[this.segments.length - 1];
            return last ? last.end : 0;
        }
        var size = s.to - s.from + 1;
        return s.start + Math.max(0, Math.min(1, (at - s.from) / size)) * (s.end - s.start);
    }
}

/** Bytes per request of a format: about CHUNK_S of it */
function chunkOf(f: Format): number {
    return Math.max(CHUNK_MIN, Math.min(CHUNK_MAX, Math.round(f.bitrate / 8 * CHUNK_S)));
}

/** Bytes of the first request after a start or a seek: FIRST_SHARE of the usual, for a faster first frame */
function pieceOf(chunk: number): number {
    return Math.max(FIRST_MIN, Math.round(chunk * FIRST_SHARE));
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
        // (a head kept is read from there)
        if (keptHead(f, end)) {
            return;
        }
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

/** Heads read lately (init and index, without media), by video, format and its version: a start mid-video, a reopen
 * or a switch to a format read lately reads it here instead of waiting for its request (its media asked at once) */
var kept: { key: string; data: ArrayBuffer }[] = [];
var KEPT_HEADS = 6;

function keptKey(f: Format): string {
    var id = /[?&]id=([^&]+)/.exec(f.url);
    return (id ? id[1] : f.url) + ' ' + f.itag + ' ' + f.lmt;
}

/** Keeps f's head from data (read through its index, maybe media after it: that part not kept), as the latest */
function keepHead(f: Format, data: ArrayBuffer): void {
    var key = keptKey(f);
    var head = data.byteLength === f.index.end + 1 ? data : data.slice(0, f.index.end + 1);
    kept = kept.filter(function (k) { return k.key !== key; });
    kept.push({ key: key, data: head });
    if (kept.length > KEPT_HEADS) {
        kept.shift();
    }
}

/** f's head no longer kept */
function forgetHead(f: Format): void {
    var key = keptKey(f);
    kept = kept.filter(function (k) { return k.key !== key; });
}

/** f's head kept, for a request through end (only through its index: no media wanted with it); null: none */
function keptHead(f: Format, end: number): ArrayBuffer | null {
    if (end !== f.index.end) {
        return null;
    }
    var key = keptKey(f);
    for (var i = 0; i < kept.length; i++) {
        if (kept[i].key === key) {
            return kept[i].data;
        }
    }
    return null;
}

/** A head kept (only through its index: no media wanted with it), else a prefetched one (taken once; read: left for
 * the next caller), else fetched now */
function head(f: Format, end: number, read: boolean): Promise<ArrayBuffer> {
    var stored = keptHead(f, end);
    if (stored) {
        return Promise.resolve(stored);
    }
    var key = headKey(f, end);
    var had = ahead[key];
    if (read && had) {
        had.read = true;
    } else {
        delete ahead[key];
    }
    return had ? had.done : fetchBytes(f.url, 0, end).done;
}

/** A format's segments and init section, from its head (its first bytes, through the index); a head that parsed is
 * kept, if keep (not a preview's: a later start seldom takes its format) */
function headParts(f: Format, data: ArrayBuffer, keep: boolean): { segments: Segment[]; init: ArrayBuffer } {
    var parts = { segments: /webm/.test(f.mime) ? parseCues(data, f.length, f.duration) : parseSidx(data), init: data.slice(0, f.init.end + 1) };
    if (keep && parts.segments.length) {
        keepHead(f, data);
    }
    return parts;
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
    /** A seek's window (narrow) is being made: settle clears what is buffered past it (cleared: asked for), seeks and
     * tells the TV; where that seek lands (s; -1: no seek's window up: a start's lifts when it plays) */
    private narrowing = false;
    private cleared = false;
    private landed = -1;
    /** A start's window: whether it began to play, when (ms) and where (s). It lifts once the picture has moved
     * (land) */
    private played = false;
    private playedAt = 0;
    private playedFrom = 0;
    /** A seek waits for the one on its way before its window's removal (waitSeek: 1; -1: waited QUICK_WAIT_MS, no
     * window); when the last seek was asked (ms) */
    private waits = 0;
    private waitTimer = 0;
    private soughtAt = 0;
    /** Count of seeks asked */
    private sought = 0;
    /** When the last seek ended (ms; 0: not yet) */
    private seekedAt = 0;
    /** The last video downloads' speeds (bit/s; those of SPEED_BYTES or more, up to SPEEDS: their median is the line's,
     * one alone being mostly a round trip or a pause of the page) */
    private speeds: number[] = [];
    /** Seeks get a window of their own (Engine.quick) */
    quick = false;

    /** onFail: 'expired' (the URLs expired), 'media' (Media Source or the decoder), 'network', 'stream' (no index) */
    private onFail: (why: string) => void;
    /** The parts the player will skip (SponsorBlock's, not skipped yet): their media is not loaded, what follows is */
    skips: () => Skip[] = function () { return []; };
    /** A video download done: its bytes and ms (Engine.loaded) */
    loaded: (bytes: number, ms: number) => void = function () { return undefined; };

    constructor(private video: HTMLVideoElement, onFail: (why: string) => void) {
        var self = this;
        // A pipeline whose decoder failed is not kept for the next video, nor the heads kept for its formats (one may
        // be what broke it: read anew next time)
        var fail = spoilingFail(onFail);
        this.onFail = function (why) {
            if (why === 'media' || why === 'stream') {
                self.tracks.forEach(function (track) { forgetHead(track.format); });
            }
            fail(why);
        };
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

    /** Seeks to t (s): now, or once no buffer is updating (settle), then in a window of its own (windowFor). A window
     * up is lifted first, but a seek's whose seek is still on its way in settle: that seek may be let end first (waitSeek) */
    seek(t: number): void {
        if (!(this.landed >= 0 && this.video.seeking)) {
            this.widen();
        }
        this.pending = t;
        this.landing(t);
        this.settle();
    }

    /** A seek to where a track has nothing buffered: its first media there asked for now. The tracks only move when the
     * seek's 'seeking' comes (seeked), after what is buffered past its window is removed and the seek asked: ~0.1 s
     * later on the TV, of every jump that must fetch its landing. Not for a track already there, nor one switching
     * format (its segments change). */
    private landing(t: number): void {
        for (var i = 0; i < this.tracks.length; i++) {
            var track = this.tracks[i];
            var sb = track.sb;
            var k = sb && !track.switching ? segmentAt(track.segments, t) : -1;
            if (!sb || k < 0 || k >= track.segments.length || k === track.next || bufferedEnd(sb.buffered, t, 0.04) > t) {
                continue;
            }
            var from = track.segments[k].from;
            var to = Math.min(track.segments[k].to, from + pieceOf(track.chunk) - 1);
            if (track.early && track.early.from === from && track.early.to === to) {
                continue;
            }
            this.unask(track);
            this.askAhead(track, from, to);
        }
    }

    /** Asks for a track's bytes ahead of its turn (early, landing: pump takes the request up as its own), noting when
     * the answer came: its speed is the download's, not the wait for pump with it. A failure is taken where the
     * request is (pump). */
    private askAhead(track: Track, from: number, to: number): void {
        var req = fetchBytes(track.format.url, from, to);
        var ahead: Track['early'] = { from: from, to: to, at: Date.now(), req: req };
        req.done.then(function () {
            (ahead as { came?: number }).came = Date.now();
        }, function () { return undefined; });
        track.early = ahead;
    }

    /** Gives up a track's request made ahead (early, landing) */
    private unask(track: Track): void {
        if (track.early) {
            track.early.req.xhr.abort();
            track.early = null;
        }
    }

    /** The window a seek to t gets (engine.ts QUICK_MIN_S; 0: none), decided when the seek can run (settle: the
     * metadata in, no buffer updating, so what a track got is buffered or waits in it), and what each track does for
     * it. One still loading into the window from where the landing's buffer ends (or the landing itself), with nothing
     * of it past the window, is left to go on (kept: its parser is mid-segment, and its download not started over).
     * Any other is moved to the window's end (narrow), and of its buffer goes what lies past the window (clearFrom),
     * and with it a video segment only partly there at the end of the landing's buffer: it is loaded whole again, over
     * nothing (this TV stalls on a segment appended again over frames about to play); an audio segment partly there
     * is appended again from where its part ends instead (resume). Not with the stream ended (its length cannot be
     * set), nor on a slow line. */
    private windowFor(t: number): number {
        var tracks = this.tracks;
        var pipe = this.pipe;
        var video = tracks[0];
        if (!this.quick || !pipe || pipe.source.readyState !== 'open' || tracks.length < 2 || !video.sb || !tracks[1].sb) {
            return 0;
        }
        var w = windowEnd(video.segments, t, this.length);
        if (w - t < QUICK_MIN_S || this.slow(video, t, w)) {
            return 0;
        }
        for (var i = 0; i < tracks.length; i++) {
            var track = tracks[i];
            var segments = track.segments;
            var b = (track.sb as SourceBuffer).buffered;
            var last = b.length ? b.end(b.length - 1) : 0;
            // (the track's end of the window: the audio's may be a little past it, audioEnd)
            var we = i > 0 ? this.audioEnd(w) : w;
            // Where the landing's buffer ends (t: nothing there; a landing just past the end of what is buffered, as a
            // jump on from a window's end: that end), the segment that goes on from there, and how far that one is
            // buffered from its start (its start: not)
            var end = bufferedEnd(b, t, 0.04);
            if (end === t) {
                var near = bufferedEnd(b, t - NEAR_S, 0.001);
                end = near > t - NEAR_S && near < t ? near : t;
            }
            var on = segmentAt(segments, end);
            // (the audio's buffer ending where a window cut it: the segment cut, however little of it is missing)
            if (i > 0 && on > 0 && segments[on - 1].end > end + 0.005 && (Math.abs(end - this.cutAt) < 0.05 || this.window > 0 && Math.abs(end - this.window) < 0.05)) {
                on--;
            }
            var upTo = on < segments.length ? bufferedEnd(b, segments[on].start + 0.01, 0.001) : 0;
            // (of the audio a frame counts: 21 ms or more; of the video what passes for a start, 0.05 s)
            var part = on < segments.length && upTo > segments[on].start + (i > 0 ? 0.015 : 0.05);
            // The video: the first segment from there to the window's end that is only partly buffered (one left
            // mid-download by an earlier seek): the track, loading up to it, would append it again over its part
            var first = -1;
            for (var k = on; i === 0 && first < 0 && k < segments.length && segments[k].start < we - 0.05; k++) {
                var to = k === on ? upTo : bufferedEnd(b, segments[k].start + 0.01, 0.001);
                first = to > segments[k].start + 0.05 && to < segments[k].end - 0.05 ? k : -1;
            }
            // (its last piece still waiting to be appended: the track is at the next one's start)
            var tail = !!track.waiting && !track.fresh && on === track.next - 1 && track.pos === (track.next < segments.length ? segments[track.next].from : 0);
            // (not one going in over an old part of its segment: more of that may lie ahead of what it has appended)
            track.kept = !track.moved && end < we - 0.05 && last <= we + 0.05 && !track.switching && track.cut < 0 && (first < 0 || first === on) &&
                !(track.over && i === 0) && (tail || on === track.next && (!part || track.pos > segments[on].from));
            // A segment only partly there: the video's goes, with what follows it (whole again, over nothing); the
            // audio's stays and is appended again from where its part ends (any audio frame can follow another: no
            // removal, so none while the seek before is still on its way, as two presses on make it)
            track.clearFrom = !track.kept && first >= 0 ? segments[first].start : we;
            track.resume = !track.kept && i > 0 && part && end < we - 0.05 ? on : -1;
            track.resumeFrom = upTo;
        }
        return w;
    }

    /** Where a seek's window to w ends for the audio: at w, or where the audio segment across w ends if that is within
     * TAIL_S (that segment is not cut then) */
    private audioEnd(w: number): number {
        var s = this.tracks[1].segments;
        var c = segmentAcross(s, w);
        return s[c].start < w && s[c].end > w && s[c].end - w < TAIL_S ? s[c].end : w;
    }

    /** Whether the window decided (windowFor) has anything to remove from a buffer first */
    private removes(): boolean {
        for (var i = 0; i < this.tracks.length; i++) {
            var track = this.tracks[i];
            var b = (track.sb as SourceBuffer).buffered;
            // (an audio frame across the window's end stays: it ends where the cut segment's next one starts)
            if (!track.kept && b.length && b.end(b.length - 1) > track.clearFrom + 0.05) {
                return true;
            }
        }
        return false;
    }

    /** A seek whose window has something to remove, with another seek still on its way (this TV hangs on a removal
     * during a seek). True: that seek is waited for (settle comes again at its 'seeked'; its tracks load on for it
     * meanwhile: pump), but only one in a window of its own, which ends within QUICK_WAIT_MS of being asked (any other
     * takes the TV's 3 s). False: no window for this seek. */
    private waitSeek(): boolean {
        var self = this;
        var left = QUICK_WAIT_MS - (Date.now() - this.soughtAt);
        if (this.waits < 0 || !this.window || this.landed < 0 || left <= 0) {
            return false;
        }
        if (!this.waits) {
            this.waits = 1;
            this.waitTimer = setTimeout(function () {
                self.waitTimer = 0;
                self.waits = -1;
                self.settle();
            }, left) as unknown as number;
            // (what the seek on its way still needs)
            this.pumpAll();
        }
        return true;
    }

    private stopWait(): void {
        clearTimeout(this.waitTimer);
        this.waitTimer = 0;
        this.waits = 0;
    }

    /** Makes the window w decided for the seek to come (windowFor): the window set, a track not kept dropped where it
     * loads (that would land past the window or at the old place) and moved to the window's end, where it goes on
     * once the window lifts (the seek's own handling, seeked, moves it back to the end of what is buffered at the
     * landing, if that is before the window's end), the audio to the segment it appends again from where its part
     * ends (resume). Then clear, the seek, and the length (settle). */
    private narrow(w: number): void {
        var tracks = this.tracks;
        var we = this.audioEnd(w);
        this.window = w;
        this.narrowing = true;
        this.cleared = false;
        for (var i = 0; i < tracks.length; i++) {
            var track = tracks[i];
            var segments = track.segments;
            // The audio segment across the window's end (the audio's: audioEnd): what of it is past the window is
            // loaded again from the cut once the window lifts (pump), as after a start
            track.windowCut = i > 0 ? segmentAcross(segments, we) : -1;
            track.open = false;
            if (track.kept) {
                continue;
            }
            this.drop(track);
            track.moved = true;
            track.cut = -1;
            var at = segmentAt(segments, w);
            if (i > 0) {
                var c = track.windowCut;
                at = segments[c].start < we - 0.01 ? c + 1 : c;
            }
            if (track.resume >= 0) {
                // (its append window's start: clear, after the parser's reset)
                at = track.resume;
                track.cut = track.resumeFrom;
            }
            track.at(at);
        }
        // The audio cut at the window from now on (a kept track's answer may come before the seek runs; a track moved
        // has its parser reset in clear, which sets it again)
        try {
            (tracks[1].sb as SourceBuffer).appendWindowEnd = we;
        } catch (e) {
            // (set in clear)
        }
    }

    /** The line's speed (bit/s): the median of the last video downloads (0: none measured yet) */
    private speed(): number {
        return this.speeds.length ? this.speeds.slice().sort(function (a, b) { return a - b; })[this.speeds.length >> 1] : 0;
    }

    /** A line too slow for a seek's window: the median of the last video downloads under QUICK_SPEED times what the
     * video needs from the landing to one window's length past the window's end (those segments' own bytes: a dense
     * part is several times the format's average). None measured yet: not slow. */
    private slow(track: Track, t: number, w: number): boolean {
        var speed = this.speed();
        if (!speed) {
            return false;
        }
        var s = track.segments;
        var from = Math.min(segmentAt(s, t), s.length - 1);
        var to = Math.min(segmentAt(s, w + WINDOW_S), s.length - 1);
        return speed < QUICK_SPEED * (s[to].to - s[from].from + 1) * 8 / (s[to].end - s[from].start);
    }

    /** Jumps from from towards to (s): to the nearest keyframe (a video segment's start) on that side of from */
    jump(to: number, from: number): void {
        this.seek(jumpTarget((this.tracks.length ? this.tracks[0].segments : []).map(function (s) { return s.start; }), to, from));
    }

    seekTarget(): number {
        return this.pending;
    }

    /** The real length while the TV is told a window's (a seek's, and a start's until its picture has moved) */
    realLength(): number {
        return this.window ? this.length : 0;
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
                var parts = headParts(f, data, !preview);
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
        // The first media of a start mid-video asked while the pipeline opens
        heads.then(function () {
            if (!self.stopped && self.tracks === tracks) {
                self.early(startAt);
            }
        }, function () { return undefined; });
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

    /** A start mid-video (its heads in: the segments known) asks for each track's first media now, not only once the
     * pipeline is open (emptying a kept one takes ~50 ms, a fresh one far longer: the answer is on its way meanwhile);
     * pump takes these requests for its first ones, if it starts where they do (not after a seek asked meanwhile). A
     * start from 0 has its first media with the head. */
    private early(startAt: number): void {
        var tracks = this.tracks;
        if (startAt < 1 || this.pending >= 0 || this.pipe) {
            return;
        }
        var keys = tracks[0].segments;
        var at = keys[Math.min(segmentAt(keys, startAt), keys.length - 1)].start + KEYFRAME_IN;
        for (var i = 0; i < tracks.length; i++) {
            var track = tracks[i];
            var k = segmentAt(track.segments, at);
            if (k >= track.segments.length) {
                continue;
            }
            var from = track.segments[k].from;
            this.askAhead(track, from, Math.min(track.segments[k].to, from + pieceOf(track.chunk) - 1));
        }
    }

    /** Switches the video format in place (switchTrack), e.g. when a preview taken over full screen moves to the
     * full-screen quality; soon: as near as the TV allows (switchSoon) */
    switchVideo(f: Format, ahead?: number, soon?: boolean): void {
        this.switchTrack(0, f, ahead, soon);
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
     * fails or the end is near, the old format continues. A newer switch of the track replaces a pending one; one
     * back to the format the track has, before the switch away from it has its place, only gives that one up. */
    private switchTrack(index: number, f: Format, ahead?: number, soon?: boolean): void {
        var self = this;
        var track = this.tracks[index];
        // (to the format it has, or the one a switch on its way brings: nothing to do)
        if (!track || this.stopped || (track.switchTo || track.format.url) === f.url) {
            return;
        }
        var asked = ++track.switchAsked;
        this.unsoon(track);
        if (track.format.url === f.url && !track.switching) {
            track.switchTo = '';
            return;
        }
        track.switchTo = f.url;
        head(f, f.index.end, false).then(function (data) {
            var parts = headParts(f, data, true);
            if (soon && index === 0) {
                self.switchSoon(track, f, parts, ahead, asked, 0, self.fetchS(chunkOf(f)));
            } else {
                self.placeSwitch(track, index, f, parts, ahead, asked);
            }
        }, function () {
            if (track.switchAsked === asked) {
                track.switchTo = '';
            }
        });
    }

    /** How long bytes should take to come (s): at the line's speed with a margin, and a round trip */
    private fetchS(bytes: number): number {
        var speed = this.speed();
        return speed ? bytes * 8 / speed * SOON_MARGIN + SOON_TRIP_S : SOON_S;
    }

    /** Gives up a track's request for a switch to come soon */
    private unsoon(track: Track): void {
        if (track.soon) {
            var xhr = track.soon;
            track.soon = null;
            xhr.abort();
        }
    }

    /** A video switch to come soon: the new format's first part at the switch point is fetched while the old format
     * plays on and stays, and only with it here is the old one's data from there removed (placeSoon, pump), the part
     * going in right after: no picture runs into a gap however long the part takes, so the point is the first keyframe
     * SWITCH_MIN_S (what the TV's decoder holds) and the fetch (waitS, at the speed it plays) ahead. Tried tries times
     * so far (the part failed or came too late); after SOON_TRIES the plain way (placeSwitch). After a seek on its way
     * or its window (little is buffered there). */
    private switchSoon(track: Track, f: Format, parts: { segments: Segment[]; init: ArrayBuffer }, ahead: number | undefined, asked: number, tries: number, waitS: number): void {
        var self = this;
        var segments = parts.segments;
        if (this.stopped || this.tracks[0] !== track || track.switchAsked !== asked) {
            return;
        }
        if (!segments.length) {
            track.switchTo = '';
            return;
        }
        // (the pipeline not open yet: once it is)
        if (!track.sb || this.pending >= 0 || this.video.seeking || this.window) {
            setTimeout(function () { self.switchSoon(track, f, parts, ahead, asked, tries, waitS); }, track.sb ? SWITCH_RETRY_MS : SOON_CHECK_MS);
            return;
        }
        if (tries >= SOON_TRIES) {
            this.placeSwitch(track, 0, f, parts, ahead, asked);
            return;
        }
        var least = this.video.currentTime + SWITCH_MIN_S + waitS * (this.video.playbackRate || 1);
        var i = 0;
        while (i < segments.length && segments[i].start < least) {
            i++;
        }
        if (i >= segments.length) {
            // (the end is near: the old format plays on)
            track.switchTo = '';
            return;
        }
        var from = segments[i].from;
        var to = Math.min(segments[i].to, from + chunkOf(f) - 1);
        var at = Date.now();
        var sought = this.sought;
        var req = fetchBytes(f.url, from, to);
        track.soon = req.xhr;
        track.soons++;
        req.done.then(function () {
            if (track.soon === req.xhr) {
                track.soon = null;
                self.placeSoon(track, f, parts, ahead, asked, tries, i, { from: from, to: to, at: at, req: req, part: f.url }, (Date.now() - at) / 1000, sought);
            }
        }, function () {
            if (track.soon === req.xhr) {
                track.soon = null;
                self.switchSoon(track, f, parts, ahead, asked, tries + 1, waitS);
            }
        });
    }

    /** The first part of a switch to come soon is here (first: as the request the track then takes, pump; it took
     * took s): the switch gets its place at segment i's keyframe, once the old format's buffer reaches it (and a
     * switch before it mid-way, the old data going, is taken). That keyframe too near by now for the TV's decoder:
     * again (switchSoon), ahead by what the part took; a seek since the part was asked (sought: the count of seeks
     * then; the playhead is elsewhere now): again where it is, after it. */
    private placeSoon(track: Track, f: Format, parts: { segments: Segment[]; init: ArrayBuffer }, ahead: number | undefined, asked: number, tries: number, i: number,
        first: { from: number; to: number; at: number; req: { xhr: XMLHttpRequest; done: Promise<ArrayBuffer> }; part: string }, took: number, sought: number): void {
        var self = this;
        var sb = track.sb;
        if (this.stopped || this.tracks[0] !== track || !sb || track.switchAsked !== asked) {
            return;
        }
        var wait = took * SOON_MARGIN + SOON_TRIP_S;
        if (this.pending >= 0 || this.video.seeking || this.window || this.sought !== sought) {
            this.switchSoon(track, f, parts, ahead, asked, tries, wait);
            return;
        }
        var from = parts.segments[i].start;
        var now = this.video.currentTime;
        if (from < now + SWITCH_MIN_S) {
            this.switchSoon(track, f, parts, ahead, asked, tries + 1, wait);
            return;
        }
        if (track.switching && track.switching.removed || bufferedEnd(sb.buffered, now) < from) {
            setTimeout(function () { self.placeSoon(track, f, parts, ahead, asked, tries, i, first, took, sought); }, SOON_CHECK_MS);
            return;
        }
        this.drop(track);
        this.unask(track);
        track.early = first;
        track.switching = { format: f, segments: parts.segments, init: parts.init, index: i, from: from };
        this.pump(track);
    }

    /** Schedules the switch of track to f (parts: from its head), now or once the buffer reaches the switch point (ahead:
     * the distance asked, also the least for video; none: SWITCH_S) */
    private placeSwitch(track: Track, index: number, f: Format, parts: { segments: Segment[]; init: ArrayBuffer }, ahead: number | undefined, asked: number): void {
        var aheadS = ahead || SWITCH_S;
        var least = Math.max(SWITCH_MIN_S, ahead || 0);
        var self = this;
        var segments = parts.segments;
        if (this.stopped || this.tracks[index] !== track || track.switchAsked !== asked) {
            return;
        }
        if (!segments.length) {
            track.switchTo = '';
            return;
        }
        // (the pipeline not open yet, or a switch before it mid-way, the old data going: once it is, once that one is
        // taken)
        if (!track.sb || track.switching && track.switching.removed) {
            setTimeout(function () { self.placeSwitch(track, index, f, parts, ahead, asked); }, SOON_CHECK_MS);
            return;
        }
        var now = this.video.currentTime;
        var end = bufferedEnd(track.sb.buffered, now);
        var i = -1;
        var from = 0;
        if (index === 0) {
            // The first keyframe aheadS ahead, else the last one before the buffer's end, never nearer than least
            for (var k = 0; k < segments.length && segments[k].start <= end; k++) {
                if (segments[k].start >= now + least) {
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
                setTimeout(function () { self.placeSwitch(track, index, f, parts, ahead, asked); }, SWITCH_RETRY_MS);
            } else {
                track.switchTo = '';
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
        this.stopWait();
        clearInterval(this.timer);
        clearTimeout(this.stuckTimer);
        for (var event in this.listeners) {
            this.video.removeEventListener(event, this.listeners[event]);
        }
        this.listeners = {};
        for (var i = 0; i < this.tracks.length; i++) {
            this.drop(this.tracks[i]);
            this.unask(this.tracks[i]);
            this.unsoon(this.tracks[i]);
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
        this.on('seeked', function () {
            clearTimeout(self.stuckTimer);
            self.seekedAt = Date.now();
            // (a seek that waited for this one: waitSeek)
            self.settle();
        });
        this.on('waiting', function () { self.hop(); });
        this.on('pause', function () { self.rest(); });
        this.on('playing', function () {
            // (a start's window, as a seek's, waits for the picture to move: land; one being made is not a start's)
            if (self.window && self.landed < 0 && !self.narrowing && !self.played) {
                self.played = true;
                self.playedAt = Date.now();
                self.playedFrom = self.video.currentTime;
            }
            self.arm();
        });
        this.on('timeupdate', function () { self.land(); });
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
                self.land();
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
        // A seek's window, decided now that the seek can run (windowFor; not for a start's own seek, whose window is
        // up): what is buffered past it out first (clear: the buffers update, on at their updateend)
        if (!this.narrowing && (!this.window || this.landed >= 0)) {
            var w = this.windowFor(this.pending);
            if (w && this.video.seeking && this.removes()) {
                if (this.waitSeek()) {
                    return;
                }
                w = 0;
            }
            this.stopWait();
            // (a seek's window still up lifts now; decided again after it: the lift moves the audio back to the
            // segment its window cut)
            if (this.window) {
                this.widen();
                w = w && this.windowFor(this.pending);
                // (a removal only now: none during the seek on its way)
                if (w && this.video.seeking && this.removes()) {
                    w = 0;
                }
            }
            if (w) {
                this.narrow(w);
            }
        }
        if (this.narrowing && !this.clear()) {
            return;
        }
        var t = this.pending;
        this.pending = -1;
        clearTimeout(this.stuckTimer);
        this.soughtAt = Date.now();
        this.sought++;
        this.seekedAt = 0;
        this.stuckTimer = seekNudged(this.video, t);
        // The length told after the seek is asked (the playhead, now the seek's target, lies within it)
        if (this.narrowing) {
            this.narrowing = false;
            this.landed = t;
            try {
                // (to where the window ends for the audio, audioEnd: nothing buffered lies past the length told)
                setLength(this.pipe as Pipeline, this.audioEnd(this.window));
            } catch (e) {
                // Not told: the TV shows the picture after its 3 s, as after any seek; the window lifts as usual
            }
        }
    }

    /** Before a seek in a window: what narrow marked is removed from each buffer, once (false while a buffer updates
     * with it: settle comes again), then the parsers of the tracks moved are reset (one may be mid-segment of what was
     * on its way; this clears the append windows too) and the audio is cut at the window. A track kept loading is
     * left as it is: a removal with a segment half appended makes the TV's Media Source drop the rest of it. A failure
     * leaves a plain seek. */
    private clear(): boolean {
        var w = this.audioEnd(this.window);
        var audio = this.tracks[1].sb as SourceBuffer;
        try {
            if (!this.cleared) {
                this.cleared = true;
                var removing = false;
                for (var i = 0; i < this.tracks.length; i++) {
                    var track = this.tracks[i];
                    var sb = track.sb as SourceBuffer;
                    var b = sb.buffered;
                    var last = b.length ? b.end(b.length - 1) : 0;
                    // (an audio frame across the window's end stays: it ends where the cut segment's next one starts)
                    if (!track.kept && last > track.clearFrom + 0.05) {
                        sb.remove(track.clearFrom, last + 1);
                        removing = true;
                    }
                }
                if (removing) {
                    return false;
                }
            }
            for (var k = 0; k < this.tracks.length; k++) {
                if (!this.tracks[k].kept) {
                    resetParser(this.tracks[k].sb as SourceBuffer);
                    this.tracks[k].moved = false;
                }
            }
            audio.appendWindowEnd = w;
            // (the audio appended again from where its part ends: narrow)
            if (!this.tracks[1].kept && this.tracks[1].cut >= 0) {
                audio.appendWindowStart = this.tracks[1].cut;
            }
        } catch (e) {
            // No window: a plain seek, the tracks passing over what is still buffered where they stand
            this.window = 0;
            this.narrowing = false;
            this.landed = -1;
            this.tracks[1].windowCut = -1;
            // (the audio's cut: given up by the seek's own handling, which moves the track)
            if (this.tracks[1].cut > 0) {
                this.tracks[1].cut = 0;
            }
            try {
                audio.appendWindowEnd = Infinity;
            } catch (e2) {
                // (updating: before its next append)
                this.tracks[1].open = true;
            }
            // (a removal begun: the seek waits for it, as for any update; settle decides anew then)
            for (var u = 0; u < this.tracks.length; u++) {
                if ((this.tracks[u].sb as SourceBuffer).updating) {
                    return false;
                }
            }
        }
        return true;
    }

    /** A seek's window lifts once the picture moves where it landed (LIFT_S, by the TV's own clock: for LIFT_MS after
     * the seek's end the element's time is the browser's guess, running whether or not a frame shows), or nears the
     * window's end. A start's the same way from where it began to play: told the real length before its first frame
     * shows (the TV's comes ~0.35 s after 'playing'), the TV at times falls back to its slow start, the picture
     * standing a second more */
    private land(): void {
        var v = this.video;
        var seek = this.landed >= 0;
        // (a start's: not before it began to play, nor while a seek's window is being made in its place)
        if (!this.window || this.pending >= 0 || v.seeking || v.paused || !seek && (!this.played || this.narrowing)) {
            return;
        }
        var from = seek ? this.landed : this.playedFrom;
        var since = seek ? this.seekedAt : this.playedAt;
        if (v.currentTime > from + LIFT_S && (!seek || since > 0) && Date.now() - since >= LIFT_MS || v.currentTime > this.window - LIFT_END_S) {
            this.widen();
        }
    }

    /** Moves a stalled playhead over a short hole just before buffered data */
    private hop(): void {
        // (in a seek's window not while a buffer updates, as the length just told may make it: on at its updateend)
        if (this.pending < 0 && this.video.readyState <= 2 && this.tracks.length && !(this.landed >= 0 && this.updating())) {
            hopHole(this.video);
        }
    }

    private updating(): boolean {
        for (var i = 0; i < this.tracks.length; i++) {
            var sb = this.tracks[i].sb;
            if (sb && sb.updating) {
                return true;
            }
        }
        return false;
    }

    /** The start's window lifted (the video plays, or a seek moves it): the real length again, loading past it */
    private widen(): void {
        if (!this.window) {
            return;
        }
        this.cutAt = this.window;
        this.window = 0;
        this.landed = -1;
        this.played = false;
        this.narrowing = false;
        setLengthSoon(this.pipe as Pipeline, this.length);
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
            track.scale = trackScale(new Uint8Array(init));
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
        // A seek pending with metadata in: load nothing more at the old place (the tracks move once it runs), unless it
        // waits for the seek on its way to end (waitSeek), which needs what loads for it
        var waited = this.waits > 0;
        if (this.pending >= 0 && !waited && this.video.readyState >= 1) {
            return;
        }
        // The playhead, or the target of the start's seek (a start from a resume point, not from 0)
        var now = this.pending >= 0 && !waited ? this.pending : this.video.currentTime;
        var segments = track.segments;
        var skips = joinedSkips(this.skips());
        // Between segments, on past media the player will skip (its jump lands in loaded media) and past segments the
        // buffer holds whole already (a jump back came up to the range it left ahead; not in a switch or a start's cut,
        // which append over what is there), in a seek's window up to its end (before a range it kept: the segment
        // across the window's end is there as far as the window lets it in)
        var b = sb.buffered;
        var inSeek = this.window > 0 && this.landed >= 0;
        var held = !track.switching && track.cut < 0 && (track.windowCut < 0 || inSeek);
        while (track.next < segments.length && track.pos === segments[track.next].from) {
            var past = pastSkip(segments, track.next, skips, now);
            var at = segments[track.next];
            if (past !== track.next) {
                track.at(past);
            } else if (held && bufferedEnd(b, at.start + 0.01, 0.001) >= (inSeek && this.window > at.start + 0.1 ? Math.min(at.end, this.window) : at.end) - 0.05) {
                track.at(track.next + 1);
            } else {
                break;
            }
        }
        if (track.next >= segments.length) {
            this.endIfDone();
            return;
        }
        // (how far ahead its loading is: a hole at the playhead does not lift the byte limit)
        if (!roomAhead(aheadOf(b, now, skips), this.bytesAhead(track, now, skips), this.most || AHEAD, track.timeNear(track.pos) - now)) {
            return;
        }
        var segment = segments[track.next];
        if (this.window && segment.start >= this.window) {
            return;
        }
        var to = Math.min(segment.to, track.pos + (track.fresh || this.short(track, now) ? pieceOf(track.chunk) : track.chunk) - 1);
        if (track.pos === segment.from) {
            track.over = bufferedEnd(b, segment.start + 0.01, 0.001) > segment.start + 0.05;
        }
        // (the request made while the pipeline opened, if this is it: early; a switch's first part, of this format, as
        // long as it is)
        var early = track.early;
        // (a landing asked for a seek that waits for the one on its way, waitSeek: kept for it while this track loads
        // on for the first)
        if (early && !early.part && this.waits > 0 && early.from !== track.pos) {
            early = null;
        } else {
            track.early = null;
        }
        var mine = !early || !early.part || early.part === track.format.url;
        if (early && early.part && mine && early.from === track.pos && early.to <= segment.to) {
            to = early.to;
        }
        if (early && (!mine || early.from !== track.pos || early.to !== to)) {
            early.req.xhr.abort();
            early = null;
        }
        var whole = track.pos === segment.from && to === segment.to;
        var self = this;
        var gen = track.gen;
        var asked = early ? early.at : Date.now();
        // (its speed counts unless it is a switch's first part or shared the line with one)
        var timed = !(early && early.part) && !track.soon;
        var soons = track.soons;
        var req = early ? early.req : fetchBytes(track.format.url, track.pos, to);
        // (one asked ahead may have its answer already)
        var ahead = early;
        track.xhr = req.xhr;
        req.done.then(function (data) {
            if (track.gen !== gen) {
                return;
            }
            track.xhr = null;
            track.failures = 0;
            track.fresh = false;
            if (track === self.tracks[0] && timed && track.soons === soons) {
                var ms = (ahead && ahead.came || Date.now()) - asked;
                self.loaded(data.byteLength, ms);
                if (data.byteLength >= SPEED_BYTES && ms > 0) {
                    self.speeds.push(data.byteLength * 8000 / ms);
                    if (self.speeds.length > SPEEDS) {
                        self.speeds.shift();
                    }
                }
            }
            if (to < segment.to) {
                track.pos = to + 1;
            } else {
                track.next++;
                track.pos = track.next < segments.length ? segments[track.next].from : 0;
            }
            var put = whole && track.cut > 0 ? framesFrom(new Uint8Array(data), track.cut, track.scale).buffer : data;
            // (nothing of it from the cut on: on to the next)
            if (put.byteLength) {
                self.append(track, put);
            } else {
                self.pump(track);
            }
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

    /** The video has under FIRST_S buffered at now, where a start's or a seek's window begins: too little for the TV to
     * show the picture (a keyframe took the first request): what it asks next is small again, there the sooner */
    private short(track: Track, now: number): boolean {
        return track === this.tracks[0] && this.window > 0 && bufferedEnd((track.sb as SourceBuffer).buffered, now, 0.1) - now < FIRST_S;
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
        if (track.switchTo === sw.format.url) {
            track.switchTo = '';
        }
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
            if (track.open) {
                track.open = false;
                sb.appendWindowEnd = Infinity;
            }
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
        // (a seek's window up: the landing is where this seek goes, also a hop's or a nudge's)
        if (this.landed >= 0) {
            this.landed = t;
        }
        for (var i = 0; i < this.tracks.length; i++) {
            var track = this.tracks[i];
            // A pending format switch: load the new format from the new place (position set below)
            if (track.switching) {
                this.takeSwitch(track);
                track.next = -1;
            }
            var sb = track.sb;
            if (!sb) {
                continue;
            }
            // Continue from the segment at the end of what is buffered at the new time (a segment already in flight
            // there is kept, as is one loaded but still appending: not in buffered yet), asked for now: paused, the
            // tick rests until it plays, which needs it
            var end = bufferedEnd(sb.buffered, t, 0.04);
            var next = segmentAt(track.segments, end);
            // (the audio a seek's window set to go on from where its part ends, narrow: that segment, however little of
            // it is missing)
            if (this.window && track.cut >= 0 && track.resume >= 0 && track.resume === track.next && Math.abs(end - track.cut) < 0.06) {
                next = track.next;
            }
            // Still appending (or waiting to): the segment the last answer since a move completed (the track is at the
            // next one's start), right after what is buffered at t, or the one at t itself (nothing of it in yet: a
            // start's or a jump's first answer, come before its seek: else it was asked for twice)
            var appending = (sb.updating || !!track.waiting) && !track.fresh && next === track.next - 1 &&
                track.pos === (track.next < track.segments.length ? track.segments[track.next].from : 0);
            // During the start's window, loaded up to it is all there is to load
            var loaded = this.window > 0 && end >= this.window - 0.05;
            // (one moved for a window that never came to its reset is taken up afresh where it stands: nothing of it
            // is on its way)
            if (track.next < 0 || track.moved || next !== track.next && !appending && !loaded) {
                // A switched audio track's cut (or the window's) no longer applies: the append window resets once
                // nothing is appending (a request kept for the cut segment keeps it: its answer is cut as before)
                if (track.cut > 0) {
                    track.cut = 0;
                }
                this.drop(track);
                // The parser may be mid-segment: reset it, as the new segment starts afresh (the window's cut again)
                resetParser(sb);
                track.moved = false;
                if (this.window && track.windowCut >= 0) {
                    // (a seek's window: where it ends for the audio, audioEnd; a start's: at the window)
                    sb.appendWindowEnd = this.landed >= 0 ? this.audioEnd(this.window) : this.window;
                } else if (track.windowCut >= 0) {
                    // The cut of a window no longer up (lifted by a seek that got none of its own, its cut segment not
                    // loaded again yet): given up, else the next pump took the track back there
                    track.windowCut = -1;
                    track.open = true;
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

/** Where a start's window ends: the end of the last video segment ending within it (a video segment cut would lose its
 * frames after the cut until the next keyframe; 0: none: a video ending near there anyway, or a first segment longer
 * than the window) */
function windowEnd(video: Segment[], startAt: number, length: number): number {
    var until = windowFrom(startAt, length);
    var end = 0;
    for (var i = Math.max(0, segmentAt(video, startAt)); i < video.length && video[i].end <= until; i++) {
        end = video[i].end;
    }
    return end;
}
