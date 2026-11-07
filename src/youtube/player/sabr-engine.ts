// Playback engine for videos whose formats come by SABR (api/sabr.ts; api/streams.ts
// sabrStreams): the same interface as dash.ts's engine, but the server decides what each
// answer holds. A request names both formats, the playhead, each format's buffered runs of
// segments (so nothing is sent twice) and the last answer's cookie; the answer brings the init
// segment once, then whole segments from the playhead up to the server's readahead (~15 s).
// Each track requests on its own, one request at a time: in a combined answer the audio came
// after all video segments (9-22 MB in 4K), delaying the start.
// The video track's first answer after a start or seek is read as it arrives (as text: Chrome
// 38's XMLHttpRequest has no streamed binary; x-user-defined keeps each byte) until its first
// segment is complete, then aborted; the rest comes with the next request as bytes (converting
// a whole 4K answer from text blocked the main thread for over a second).
// The back buffer is trimmed at segment starts between appends (trimming mid-append leaves a
// hole). A seek outside the buffered data drops requests in flight and completes once both
// tracks cover the target. A resume start lands on the video keyframe there (decoding up to a
// later point runs at only ~2.3x play speed); audio is requested from that keyframe.
// A request that gets no data for a while, or no answer, goes at once to another of the
// video's networks while there is one (networks.ts).
// Fails as 'expired' (403, or the server wants a fresh /player reply), 'protection' (device
// attestation wanted), 'sabr' (server error or empty answers), 'network', 'media'.
// A start tells the TV the video ends WINDOW_S after it (a resume start: after its keyframe) and appends no video
// segment ending past that, the audio cut there, until it plays (the quick start, as dash.ts's): then the real length,
// and the audio segment across the window appended again from the cut on (kept: not asked of the server again; its
// frames from the cut on only, containers.ts framesFrom: else the TV plays ~46 ms of sound twice, late after it).

import { base64Bytes, BufferedRange, FormatId, SabrAnswer, SabrReader, sabrRequest, SabrSegment } from '../api/sabr.js';
import { Format, Sabr } from '../api/streams.js';
import { youtubePage } from '../api/youtube.js';
import { BEHIND_MB, BEHIND_S, bufferedEnd, Engine, hopHole, jumpTarget, KEYFRAME_IN, MB, RETRIES, roomAhead, seekNudged, STILL_AHEAD, TICK_MS, TIMEOUT_MS, windowFrom } from './engine.js';
import { framesFrom, trackScale, wholeFrames } from './containers.js';
import { networkFailed, onNetwork, stallWatch } from './networks.js';
import { keepPipeline, openPipeline, Pipeline, setLength, setLengthSoon, spoilingFail } from './pipeline.js';

/** Request more once less than this is buffered ahead of the playhead (s), unless more than AHEAD_MB of the track is
 * (engine.ts roomAhead);
 * trimmed to half once BEHIND_S or BEHIND_MB lie behind it */
var READAHEAD_S = 10;
/** Answers in a row that bring a track nothing new before it gives up */
var EMPTY_ANSWERS = 5;
/** A jump snaps to a segment start within this distance of its target (s) */
var SNAP_S = 3;
/** Track types for a request (enabledTrackTypesBitfield) */
var SOUND = 1;
var PICTURE = 2;

/** A segment a track has: its number, times (ms) and bytes; in the buffer, or still to be appended */
interface Piece {
    num: number;
    startMs: number;
    endMs: number;
    size: number;
    appended: boolean;
}

class Track {
    sb: SourceBuffer | null = null;
    /** Its init segment is in (or on its way into) the buffer, and its timescale (an MP4's) */
    inited = false;
    scale = 0;
    /** Segments to append, in order */
    queue: SabrSegment[] = [];
    /** The segments it has, by number */
    pieces: Piece[] = [];
    /** Its last segment number (0: not known yet) */
    last = 0;
    id: FormatId;
    xhr: XMLHttpRequest | null = null;
    waitUntil = 0;
    failures = 0;
    /** Answers in a row that brought it nothing new; its buffer was full at the last append */
    empty = 0;
    full = false;
    /** Bumped by a seek outside its data and by stop: an answer still in flight is ignored */
    gen = 0;

    constructor(public format: Format, public kind: number) {
        this.id = { itag: format.itag, lmt: format.lmt, xtags: format.xtags };
    }

    /** Each contiguous run of its segments, in the request's form */
    buffered(): BufferedRange[] {
        var out: BufferedRange[] = [];
        var id = this.id;
        var first: Piece | null = null;
        this.pieces.forEach(function (p, i, all) {
            first = first || p;
            var next = all[i + 1];
            if (!next || next.num !== p.num + 1) {
                out.push({ format: id, startMs: first.startMs, durationMs: p.endMs - first.startMs, firstSegment: first.num, lastSegment: p.num });
                first = null;
            }
        });
        return out;
    }

    /** The run at t: where it ends (s) and how many bytes of it lie after t (none: t itself) */
    ahead(t: number): { end: number; bytes: number } {
        var at = this.at(t);
        if (at < 0) {
            return { end: t, bytes: 0 };
        }
        var bytes = 0;
        var i = at;
        for (; i < this.pieces.length && (i === at || this.pieces[i].num === this.pieces[i - 1].num + 1); i++) {
            bytes += this.pieces[i].size;
        }
        return { end: this.pieces[i - 1].endMs / 1000, bytes: bytes };
    }

    /** The piece at t (s; -1 none) */
    at(t: number): number {
        for (var i = 0; i < this.pieces.length; i++) {
            if (this.pieces[i].startMs / 1000 <= t + 0.1 && t < this.pieces[i].endMs / 1000) {
                return i;
            }
        }
        return -1;
    }

    /** It has all there is from t (s) */
    doneFrom(t: number): boolean {
        var last = this.pieces[this.pieces.length - 1];
        return this.last > 0 && !!last && last.num >= this.last && this.ahead(t).end >= last.endMs / 1000;
    }

    /** It has the segment at t (s), or all there is up to its end */
    covers(t: number): boolean {
        var last = this.pieces[this.pieces.length - 1];
        return this.at(t) >= 0 || this.last > 0 && !!last && last.num >= this.last && t >= last.endMs / 1000;
    }

    /** Queues a new segment and records it among its pieces; false if it already has it */
    take(seg: SabrSegment): boolean {
        if (this.pieces.some(function (p) { return p.num === seg.num; })) {
            return false;
        }
        var piece = { num: seg.num, startMs: seg.startMs, endMs: seg.startMs + seg.durationMs, size: seg.data.length, appended: false };
        var i = 0;
        while (i < this.pieces.length && this.pieces[i].num < seg.num) {
            i++;
        }
        this.pieces.splice(i, 0, piece);
        this.queue.push(seg);
        return true;
    }

    /** Drops the request in flight and queued, unappended segments (a seek outside its data) */
    restart(): void {
        this.gen++;
        if (this.xhr) {
            this.xhr.abort();
            this.xhr = null;
        }
        this.queue = this.queue.filter(function (q) { return q.init; });
        this.pieces = this.pieces.filter(function (p) { return p.appended; });
        this.waitUntil = 0;
        this.empty = 0;
    }
}

export class SabrEngine implements Engine {
    private tracks: Track[] = [];
    private timer = 0;
    private stopped = false;
    private listeners: { [event: string]: () => void } = {};
    private pipe: Pipeline | null = null;
    private startAt = 0;
    /** At most this far ahead (s; 0: READAHEAD_S): hold */
    private most = 0;
    private url: string;
    private config: Uint8Array;
    private cookie: Uint8Array | null = null;
    /** Contexts the server gave (by type), and those it wants sent */
    private contexts: { [type: number]: Uint8Array } = {};
    private active: { [type: number]: boolean } = {};
    private rn = 0;
    /** A seek waiting for the metadata, idle buffers and both tracks covering it (-1: none); snap: a resume start or a
     * jump to where no segment is known, moved to the video keyframe there once its first segment header arrives (the
     * TV decodes from the keyframe anyway, at ~2.3x: landing on it saves that); snapFrom: the jump's origin (-1: a
     * resume start), a forward jump snapping only to a keyframe still ahead of it */
    private pending = -1;
    private snap = false;
    private snapFrom = -1;
    private stuckTimer = 0;
    /** The start's window (s; 0: none), the real length, the audio segment across it, where it ended (-1: the audio's
     * append window reset) */
    private window = 0;
    private length = 0;
    private cut: SabrSegment | null = null;
    private cutAt = -1;

    /** onFail: 'expired', 'protection', 'sabr', 'network', 'media' */
    private onFail: (why: string) => void;

    constructor(private video: HTMLVideoElement, private sabr: Sabr, onFail: (why: string) => void) {
        // A failed decoder's pipeline is not kept for the next video
        this.onFail = spoilingFail(onFail);
        this.url = sabr.url;
        this.config = base64Bytes(sabr.config);
    }

    /** Plays the formats from startAt (s); the first requests go out while Media Source opens */
    load(video: Format, audio: Format, startAt: number): void {
        var self = this;
        this.tracks = [new Track(video, PICTURE), new Track(audio, SOUND)];
        this.startAt = startAt;
        this.length = Math.max(video.duration, audio.duration) || 1;
        if (startAt > 0) {
            this.pending = startAt;
            this.snap = true;
            this.snapFrom = -1;
        } else {
            this.openWindow(0);
        }
        this.pump();
        // The pipeline the previous video left if it fits these formats, else a fresh one
        openPipeline(this.video, [video.mime, audio.mime]).then(function (pipe) {
                self.pipe = pipe;
            // Stopped meanwhile: kept for the next video
            if (self.stopped) {
                keepPipeline(self.video, pipe);
                return;
            }
            try {
                setLength(pipe, self.window || self.length);
                self.tracks.forEach(function (track, i) {
                    track.sb = pipe.buffers[i];
                });
                pipe.onUpdate = function (i) {
                    var track = self.tracks[i];
                    if (track) {
                        self.settle();
                        self.feed(track);
                        self.pump();
                    }
                };
            } catch (e) {
                self.onFail('media');
                return;
            }
            self.on('seeking', function () { self.seeked(); });
            self.on('seeked', function () { clearTimeout(self.stuckTimer); });
            self.on('waiting', function () { self.hop(); });
            self.on('loadedmetadata', function () { self.settle(); });
            self.on('playing', function () { self.lift(); });
            self.on('error', function () { self.onFail('media'); });
            self.timer = setInterval(function () {
                self.hop();
                self.pump();
            }, TICK_MS) as unknown as number;
            self.tracks.forEach(function (track) { self.feed(track); });
            // A kept pipeline already has its metadata: no loadedmetadata comes
            self.settle();
        }, function (e) {
            // Superseded by a newer request: ignore
            if (!self.stopped && e !== 'stale') {
                self.onFail('media');
            }
        });
    }

    /** Seeks to t (s) once the metadata is in, no buffer is updating and both tracks cover it (requested from there) */
    seek(t: number): void {
        this.go(t, -1);
    }

    /** Seeks to t; from: a jump's origin when it is to snap to the keyframe its first answer brings (else -1) */
    private go(t: number, from: number): void {
        if (!this.tracks.length) {
            return;
        }
        this.lift();
        this.pending = t;
        this.snap = from >= 0;
        this.snapFrom = from;
        this.restart(t);
        this.settle();
        this.pump();
    }

    /** Jumps to about `to` (s) from `from`: to a nearby known segment start, else to the keyframe of the segment its
     * first answer brings (snap) */
    jump(to: number, from: number): void {
        if (this.tracks.length) {
            var target = jumpTarget(this.tracks[0].pieces.map(function (p) { return p.startMs / 1000; }), to, from, SNAP_S);
            this.go(target, target === to && !this.tracks[0].covers(to) ? from : -1);
        }
    }

    seekTarget(): number {
        return this.pending;
    }

    stop(): void {
        this.stopped = true;
        clearInterval(this.timer);
        clearTimeout(this.stuckTimer);
        this.tracks.forEach(function (track) { track.restart(); });
        for (var event in this.listeners) {
            this.video.removeEventListener(event, this.listeners[event]);
        }
        this.listeners = {};
        this.tracks = [];
        keepPipeline(this.video, this.pipe);
    }

    private on(event: string, listener: () => void): void {
        this.listeners[event] = listener;
        this.video.addEventListener(event, listener);
    }

    /** The start's window from start (s), once the start is known; the told length now, or once the buffers are free
     * (only the inits can be in) */
    private openWindow(start: number): void {
        this.window = windowFrom(start, this.length);
        if (this.window && this.pipe) {
            setLengthSoon(this.pipe, this.window);
        }
    }

    /** The start's window lifted (the video plays, or a seek moves it): the real length */
    private lift(): void {
        if (!this.window) {
            return;
        }
        this.cutAt = this.window;
        this.window = 0;
        if (this.pipe) {
            setLengthSoon(this.pipe, this.length);
        }
        this.pump();
    }

    /** Where the playhead is or is going (s; until the pipeline is in, currentTime may be the previous video's) */
    private get playhead(): number {
        return this.pending >= 0 ? this.pending : this.pipe ? this.video.currentTime : this.startAt;
    }

    /** Sends each track's next request when due: it needs more, has none in flight and the server's backoff is over (a
     * resume start's or a snapping jump's audio waits for the video keyframe); also retries a segment waiting on a full buffer */
    private pump(): void {
        if (this.stopped || !this.tracks.length) {
            return;
        }
        var self = this;
        this.trim();
        this.tracks.forEach(function (track) { self.feed(track); });
        this.endIfDone();
        var t = this.playhead;
        var now = Date.now();
        this.tracks.forEach(function (track) {
            var ahead = track.ahead(t);
            if (!track.doneFrom(t) && roomAhead(ahead.end - t, ahead.bytes, self.most || READAHEAD_S) && !track.xhr && now >= track.waitUntil &&
                !(self.snap && track.kind === SOUND)) {
                self.ask(track);
            }
        });
    }

    hold(s: number): void {
        this.most = s;
        this.pump();
    }

    private ask(track: Track): void {
        var self = this;
        var gen = track.gen;
        var contexts: { type: number; value: Uint8Array }[] = [];
        var unsent: number[] = [];
        for (var type in this.contexts) {
            if (this.active[type as unknown as number]) {
                contexts.push({ type: +type, value: this.contexts[type as unknown as number] });
            } else {
                unsent.push(+type);
            }
        }
        var video = this.tracks[0];
        var audio = this.tracks[1];
        var body = sabrRequest({
            playerMs: this.playhead * 1000,
            tracks: track.kind,
            video: video.id,
            audio: audio.id,
            height: video.format.height,
            audioTrack: audio.format.track || '',
            drc: !!audio.format.drc,
            initialized: this.tracks.filter(function (t) { return t.inited; }).map(function (t) { return t.id; }),
            buffered: video.buffered().concat(audio.buffered()),
            config: this.config,
            client: this.sabr.client,
            cookie: this.cookie,
            contexts: contexts,
            unsent: unsent
        });
        var url = onNetwork(this.url) + '&rn=' + (++this.rn);
        // The video track's first answer after a start or seek is read as it arrives, until its first new segment is complete
        var streaming = track.kind === PICTURE && track.at(this.playhead) < 0;
        var enough = false;
        var taken = 0;
        var reader = new SabrReader(function (seg) {
            if (gen === track.gen && self.segment(seg)) {
                taken++;
                enough = enough || streaming;
            }
        }, function (header) {
            if (gen === track.gen) {
                self.header(header);
            }
        });
        var failed = function (): void {
            if (gen === track.gen) {
                track.xhr = null;
                self.retry(track);
            }
        };
        // Marked busy at once: the frame's XMLHttpRequest is created a moment later
        var busy = track.xhr = { abort: function () { return undefined; } } as XMLHttpRequest;
        youtubePage().then(function (w) {
            if (gen !== track.gen || track.xhr !== busy) {
                return;
            }
            try {
                // Sent from youtube.com's page, as its own player does
                var xhr = track.xhr = new (w as unknown as { XMLHttpRequest: typeof XMLHttpRequest }).XMLHttpRequest();
                xhr.open('POST', url, true);
                var read = 0;
                var more = function (): void {
                    var got = xhr.responseText;
                    if (got.length > read) {
                        var b = new Uint8Array(got.length - read);
                        for (var i = 0; i < b.length; i++) {
                            b[i] = got.charCodeAt(read + i) & 0xff;
                        }
                        read = got.length;
                        reader.push(b);
                    }
                };
                var done = function (): void {
                    track.failures = 0;
                    self.answered(track, reader.answer, taken);
                };
                if (streaming) {
                    xhr.overrideMimeType('text/plain; charset=x-user-defined');
                    xhr.onprogress = function () {
                        if (gen !== track.gen || xhr.status < 200 || xhr.status >= 300 || track.xhr !== xhr) {
                            return;
                        }
                        more();
                        if (enough) {
                            // The rest comes with the next request
                            track.xhr = null;
                            xhr.abort();
                            done();
                        }
                    };
                } else {
                    xhr.responseType = 'arraybuffer';
                }
                xhr.timeout = TIMEOUT_MS;
                xhr.onload = function () {
                    if (gen !== track.gen || track.xhr !== xhr) {
                        return;
                    }
                    track.xhr = null;
                    if (xhr.status === 403) {
                        self.onFail('expired');
                    } else if (xhr.status < 200 || xhr.status >= 300) {
                        self.retry(track);
                    } else {
                        if (streaming) {
                            more();
                        } else {
                            reader.push(new Uint8Array(xhr.response as ArrayBuffer));
                        }
                        done();
                    }
                };
                xhr.ontimeout = function () {
                    if (track.xhr === xhr) {
                        failed();
                    }
                };
                // No answer or no data: at once from the next network if one is left, else retried as any failure
                var lost = function (stalled: boolean): void {
                    if (track.xhr !== xhr) {
                        return;
                    }
                    if (gen === track.gen && networkFailed(url, stalled)) {
                        track.xhr = null;
                    } else {
                        failed();
                    }
                };
                xhr.onerror = function () {
                    lost(false);
                };
                stallWatch(xhr, function () { lost(true); });
                xhr.send(body.buffer);
            } catch (e) {
                failed();
            }
        }, failed);
    }

    /** Failed request: retried after a delay while the buffer plays, else a 'network' failure */
    private retry(track: Track): void {
        var ahead = bufferedEnd(this.video.buffered, this.video.currentTime) - this.video.currentTime;
        if (++track.failures > RETRIES && ahead < STILL_AHEAD) {
            this.onFail('network');
            return;
        }
        track.waitUntil = Date.now() + 1000 * Math.min(track.failures, 5);
    }

    /** Handles a parsed answer (taken: its segments new to the track) */
    private answered(track: Track, a: SabrAnswer, taken: number): void {
        var self = this;
        if (a.error) {
            this.onFail('sabr ' + a.error);
            return;
        }
        // New streams wanted: the ladder fetches them as for expired URLs, its /player request with the server's token
        if (a.reload) {
            this.sabr.reloadToken = a.reloadToken;
            this.onFail('expired');
            return;
        }
        if (a.protection === 3) {
            this.onFail('protection');
            return;
        }
        if (a.redirect) {
            this.url = a.redirect;
        }
        if (a.cookie) {
            this.cookie = a.cookie;
        }
        a.contexts.forEach(function (c) {
            self.contexts[c.type] = c.value;
            if (c.byDefault) {
                self.active[c.type] = true;
            }
        });
        a.start.forEach(function (type) { self.active[type] = true; });
        a.stop.forEach(function (type) { delete self.active[type]; });
        a.discard.forEach(function (type) { delete self.contexts[type]; });
        this.tracks.forEach(function (t) {
            var end = a.ends[t.format.itag];
            if (end && end.segment) {
                t.last = end.segment;
            }
        });
        // Nothing new (attestation still pending, or nothing the track lacks): retried after a growing wait, a few times
        track.empty = taken ? 0 : track.empty + 1;
        if (track.empty > EMPTY_ANSWERS) {
            this.onFail('sabr nothing came');
            return;
        }
        track.waitUntil = Date.now() + Math.max(a.backoffMs, track.empty ? 1000 * track.empty : 0);
        // A resume start or jump whose video answer had no segment: play from the requested time
        if (this.snap && track.kind === PICTURE) {
            this.snapped();
        }
        this.pump();
    }

    /** The snap is over: a resume start's window opens where it lands */
    private snapped(): void {
        this.snap = false;
        if (this.snapFrom < 0) {
            this.openWindow(this.pending);
        }
    }

    /** A segment header arrived: a resume start or a jump lands on the first video segment there (its keyframe); a
     * forward jump only on one still ahead of where it came from. A resume start opens its window there. */
    private header(h: SabrSegment): void {
        var track = this.tracks[0];
        if (this.snap && !h.init && h.itag === track.format.itag) {
            var start = h.startMs / 1000;
            // A jump's within SNAP_S (as a known start: jumpTarget), on its side of where it came from
            var jumped = this.snapFrom >= 0;
            var side = !jumped || (this.pending > this.snapFrom ? start > this.snapFrom + 1 : start < this.snapFrom - 1);
            if (this.pending >= 0 && start <= this.pending && this.pending - start < (jumped ? SNAP_S : 10) && side) {
                this.pending = start + KEYFRAME_IN;
            }
            this.snapped();
            this.pump();
        }
    }

    /** A complete segment arrived: queued for its track (once) and appended; true if it was new to the track */
    private segment(seg: SabrSegment): boolean {
        var track = this.tracks.filter(function (t) { return t.format.itag === seg.itag; })[0];
        var taken = false;
        if (!track) {
            return false;
        }
        if (seg.init) {
            if (!track.inited) {
                track.inited = true;
                track.scale = trackScale(seg.data);
                track.queue.push(seg);
            }
        } else {
            taken = track.take(seg);
        }
        this.feed(track);
        return taken;
    }

    /** Appends the track's next segment (one at a time): none past the start's window (no window at all for a first
     * video segment longer than it), the audio cut there; once lifted, the audio's cut segment again from the cut on */
    private feed(track: Track): void {
        var sb = track.sb;
        if (this.stopped || !sb || sb.updating) {
            return;
        }
        if (track.kind === SOUND && this.cutAt >= 0 && !this.window) {
            var again = this.cut;
            this.cut = null;
            sb.appendWindowEnd = Infinity;
            // (nothing of it from the cut on: on to the next)
            // (Dolby: from the frame across the cut, which the browser dropped whole at the window's end)
            var dropped = wholeFrames(track.format.mime);
            var part = again ? framesFrom(again.data, this.cutAt, track.scale, dropped) : null;
            if (again && part && part.byteLength) {
                sb.appendWindowStart = dropped ? 0 : this.cutAt;
                try {
                    sb.appendBuffer(part);
                } catch (e) {
                    // Full: again once more is trimmed
                    this.cut = again;
                    if ((e as Error).name !== 'QuotaExceededError') {
                        this.onFail('media');
                    }
                }
                return;
            }
            sb.appendWindowStart = 0;
            this.cutAt = -1;
        }
        var seg = track.queue[0];
        if (!seg) {
            return;
        }
        if (this.window && !seg.init) {
            var end = (seg.startMs + seg.durationMs) / 1000;
            if (track.kind === PICTURE && end > this.window + 0.01 && !track.pieces.some(function (p) { return p.appended; })) {
                this.lift();
            } else if (track.kind === PICTURE ? end > this.window + 0.01 : seg.startMs / 1000 >= this.window) {
                return;
            }
            if (track.kind === SOUND) {
                sb.appendWindowEnd = this.window;
                if (end > this.window) {
                    this.cut = seg;
                }
            }
        }
        track.queue.shift();
        try {
            sb.appendBuffer(seg.data);
            track.full = false;
        } catch (e) {
            if ((e as Error).name === 'QuotaExceededError') {
                // Full: retried (pump) once more is trimmed
                track.queue.unshift(seg);
                track.full = true;
                return;
            }
            this.onFail('media');
            return;
        }
        track.pieces.forEach(function (p) {
            if (!seg.init && p.num === seg.num) {
                p.appended = true;
            }
        });
    }

    /** Performs the pending seek once the metadata is in, no buffer is updating and both tracks cover the target; one
     * not done within SEEK_STUCK_MS is nudged */
    private settle(): void {
        var t = this.pending;
        var v = this.video;
        // Not before the pipeline is in: a kept one has the previous video's metadata
        if (t < 0 || v.readyState < 1 || this.snap || !this.pipe) {
            return;
        }
        for (var i = 0; i < this.tracks.length; i++) {
            var track = this.tracks[i];
            if (track.sb && track.sb.updating || !track.covers(t)) {
                return;
            }
        }
        this.pending = -1;
        clearTimeout(this.stuckTimer);
        this.stuckTimer = seekNudged(v, t);
    }

    /** Moves the playhead over a small gap just before buffered data (playback stalls there) */
    private hop(): void {
        if (this.pending < 0 && this.video.readyState <= 2 && this.tracks.length) {
            hopHole(this.video);
        }
    }

    /** Restarts each track that lacks t (s), dropping its data in flight (the others continue) */
    private restart(t: number): void {
        this.tracks.forEach(function (track) {
            if (!track.covers(t)) {
                track.restart();
            }
        });
    }

    /** The playhead moved (an app or player seek): a track lacking that position requests from there */
    private seeked(): void {
        this.restart(this.video.currentTime);
        this.pump();
    }

    /** Over BEHIND_S or BEHIND_MB behind the playhead: trims to half, at a segment start, between appends (a segment
     * waiting on a full buffer does not block it) */
    private trim(): void {
        var t = this.video.currentTime;
        if (this.video.seeking || this.pending >= 0) {
            return;
        }
        this.tracks.forEach(function (track) {
            var sb = track.sb;
            if (!sb || sb.updating || track.queue.length && !track.full || !sb.buffered.length) {
                return;
            }
            var behind = track.pieces.filter(function (p) { return p.endMs / 1000 <= t; });
            var bytes = behind.reduce(function (sum, p) { return sum + p.size; }, 0);
            if (t - sb.buffered.start(0) <= BEHIND_S && bytes <= BEHIND_MB * MB) {
                return;
            }
            // From the oldest on, until what is left behind is half the limits
            var cut = 0;
            for (var i = 0; i < behind.length; i++) {
                if (t - behind[i].startMs / 1000 <= BEHIND_S / 2 && bytes <= BEHIND_MB * MB / 2) {
                    break;
                }
                bytes -= behind[i].size;
                cut = i + 1 < behind.length ? behind[i + 1].startMs / 1000 : behind[i].endMs / 1000;
            }
            cut = Math.min(cut, t - 1);
            if (cut > sb.buffered.start(0)) {
                sb.remove(sb.buffered.start(0), cut);
                track.pieces = track.pieces.filter(function (p) { return p.startMs / 1000 >= cut; });
            }
        });
    }

    /** Signals end of stream once both formats have all their segments in */
    private endIfDone(): void {
        var t = this.video.currentTime;
        var all = this.tracks.every(function (track) { return track.doneFrom(t) && !track.queue.length && !!track.sb && !track.sb.updating; });
        if (all && this.pipe && this.pipe.source.readyState === 'open') {
            this.pipe.source.endOfStream();
        }
    }
}
