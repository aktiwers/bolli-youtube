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
// Fails as 'expired' (403, or the server wants a fresh /player reply), 'protection' (device
// attestation wanted), 'sabr' (server error or empty answers), 'network', 'media'.

import { base64Bytes, BufferedRange, FormatId, SabrAnswer, SabrReader, sabrRequest, SabrSegment } from '../api/sabr.js';
import { Format, Sabr } from '../api/streams.js';
import { youtubePage } from '../api/youtube.js';
import { bufferedEnd, Engine } from './dash.js';
import { keepPipeline, openPipeline, Pipeline, setLength, spoilingFail } from './pipeline.js';

/** Request more once less than this is buffered ahead of the playhead (s), unless more than AHEAD_MB of the track is */
var READAHEAD_S = 10;
var AHEAD_MB = 32;
/** Kept behind the playhead before trimming to half (s, and MB per track) */
var BEHIND_S = 20;
var BEHIND_MB = 16;
var MB = 1024 * 1024;
var TICK_MS = 500;
var TIMEOUT_MS = 20000;
var RETRIES = 3;
/** Answers in a row that bring a track nothing new before it gives up */
var EMPTY_ANSWERS = 5;
/** A failed request is retried while at least this much is buffered ahead (s) */
var STILL_AHEAD = 3;
/** Offset after a keyframe to land on (s): inside the buffer, not just before its first frame */
var KEYFRAME_IN = 0.05;
/** A jump snaps to a segment start within this distance of its target (s) */
var SNAP_S = 3;
/** A gap this short just ahead of the playhead is skipped (s); a seek not done after SEEK_STUCK_MS is nudged */
var HOLE_S = 1;
var SEEK_STUCK_MS = 5000;
var NUDGE_S = 0.1;
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
    /** Its init segment is in (or on its way into) the buffer */
    inited = false;
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
    private url: string;
    private config: Uint8Array;
    private cookie: Uint8Array | null = null;
    /** Contexts the server gave (by type), and those it wants sent */
    private contexts: { [type: number]: Uint8Array } = {};
    private active: { [type: number]: boolean } = {};
    private rn = 0;
    /** A seek waiting for the metadata, idle buffers and both tracks covering it (-1: none); snap: a resume start,
     * moved to the video keyframe there once its first segment header arrives */
    private pending = -1;
    private snap = false;
    private stuckTimer = 0;

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
        if (startAt > 0) {
            this.pending = startAt;
            this.snap = true;
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
                setLength(pipe, Math.max(video.duration, audio.duration) || 1);
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
        if (!this.tracks.length) {
            return;
        }
        this.pending = t;
        this.snap = false;
        this.restart(t);
        this.settle();
        this.pump();
    }

    /** Jumps to about `to` (s) from `from`: to a nearby known segment start, else to `to` itself */
    jump(to: number, from: number): void {
        if (!this.tracks.length) {
            return;
        }
        var best = -1;
        this.tracks[0].pieces.forEach(function (p) {
            var s = p.startMs / 1000;
            if ((to > from ? s > from + 1 : s < from - 1) && Math.abs(s - to) < SNAP_S && (best < 0 || Math.abs(s - to) < Math.abs(best - to))) {
                best = s;
            }
        });
        this.seek(best < 0 ? to : best + KEYFRAME_IN);
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

    /** Where the playhead is or is going (s; until the pipeline is in, currentTime may be the previous video's) */
    private get playhead(): number {
        return this.pending >= 0 ? this.pending : this.pipe ? this.video.currentTime : this.startAt;
    }

    /** Sends each track's next request when due: it needs more, has none in flight and the server's backoff is over (a
     * resume start's audio waits for the video keyframe); also retries a segment waiting on a full buffer */
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
            if (!track.doneFrom(t) && ahead.end - t < READAHEAD_S && ahead.bytes < AHEAD_MB * MB && !track.xhr && now >= track.waitUntil &&
                !(self.snap && track.kind === SOUND)) {
                self.ask(track);
            }
        });
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
        var url = this.url + '&rn=' + (++this.rn);
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
                xhr.onerror = xhr.ontimeout = function () {
                    if (track.xhr === xhr) {
                        failed();
                    }
                };
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
        if (a.reload) {
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
        // A resume start whose video answer had no segment: play from the requested time
        if (this.snap && track.kind === PICTURE) {
            this.snap = false;
        }
        this.pump();
    }

    /** A segment header arrived: a resume start lands on the first video segment there (its keyframe) */
    private header(h: SabrSegment): void {
        var track = this.tracks[0];
        if (this.snap && !h.init && h.itag === track.format.itag) {
            if (this.pending >= 0 && h.startMs / 1000 <= this.pending && this.pending - h.startMs / 1000 < 10) {
                this.pending = h.startMs / 1000 + KEYFRAME_IN;
            }
            this.snap = false;
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
                track.queue.push(seg);
            }
        } else {
            taken = track.take(seg);
        }
        this.feed(track);
        return taken;
    }

    /** Appends the track's next segment (one at a time) */
    private feed(track: Track): void {
        var sb = track.sb;
        if (this.stopped || !sb || sb.updating || !track.queue.length) {
            return;
        }
        var seg = track.queue.shift() as SabrSegment;
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
        v.currentTime = t;
        clearTimeout(this.stuckTimer);
        this.stuckTimer = setTimeout(function () {
            if (v.seeking) {
                v.currentTime = v.currentTime + NUDGE_S;
            }
        }, SEEK_STUCK_MS) as unknown as number;
    }

    /** Moves the playhead over a small gap just before buffered data (playback stalls there) */
    private hop(): void {
        var v = this.video;
        if (this.pending >= 0 || v.readyState > 2 || !this.tracks.length) {
            return;
        }
        var t = v.currentTime;
        var b = v.buffered;
        for (var i = 0; i < b.length; i++) {
            if (b.start(i) <= t && t < b.end(i)) {
                return;
            }
            if (b.start(i) > t && b.start(i) - t < HOLE_S) {
                v.currentTime = b.start(i) + 0.01;
                return;
            }
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
