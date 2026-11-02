// Live engine of the player: plays a live stream's video and audio formats (api/streams.ts Live) through Media Source.
// YouTube serves a live stream as numbered segments of ~5 s, each with its own init (an MP4 with its moov, a WebM with
// its header: VP9 too, so the pipeline kept from a VP9 video plays on without a new one); a request
// for one not made yet waits until it is, so each track asks for its next one at once, and a request without a number
// gives the latest, with the head's number in a header. Playback starts START_BEHIND segments behind the head; each
// track fetches one segment at a time up to AHEAD_S ahead of the playhead and trims what is BEHIND_S behind it. The
// segments' own times run from the stream's start (days: further than the TV's decoder counts), so both buffers shift
// them to start at a base past the stream's window (timestampOffset, from the first video segment's time). A jump
// moves by whole segments, back at most to the window's start and forward to the head. A 403 fails as 'expired',
// other errors as 'network' after retries. prefetchLive fetches a start ahead (its tile rests in focus): the head's
// number and both tracks' first segments, which the next start of those formats takes while fresh.

import { clock, progress } from '../../core/time.js';
import { Format, Live } from '../api/streams.js';
import { bufferedEnd, Engine, findBox, u64, webmStart } from './dash.js';
import { keepPipeline, openPipeline, Pipeline, setLength, spoilingFail } from './pipeline.js';
import { note } from './play-log.js';

/** Segments behind the head a start begins at (YouTube's own players stay about this far behind) */
var START_BEHIND = 3;
/** Buffer up to this far ahead of the playhead (s); keep this much behind it (s) */
var AHEAD_S = 15;
var BEHIND_S = 20;
var TICK_MS = 500;
var RETRIES = 3;
/** Failed requests keep being retried while this much is still buffered ahead (s) */
var STILL_AHEAD_S = 3;
/** A request for the next segment waits until YouTube has made it (~5 s) */
var TIMEOUT_MS = 30000;
/** A jump lands this far after its segment's start (s): inside the buffer, not just before its first frame */
var LAND_IN = 0.05;
/** Within this of the head (s) the time reads LIVE */
var LIVE_NEAR_S = 25;
/** A start fetched ahead is taken this long (ms): the head moves on a segment each ~5 s */
var EARLY_MS = 10000;

type Got = { data: ArrayBuffer; head: number };

/** The start fetched ahead (null: none): the audio format's URL it is for, when, the head's probe, and the first
 * segments by URL and number */
var early: { audio: string; at: number; probe: Promise<Got>; segments: { [key: string]: Promise<Got> } } | null = null;

/** Fetches a live start ahead: the head's number, then both tracks' first segments (as a start would ask for them) */
export function prefetchLive(video: Format, audio: Format): void {
    var segments: { [key: string]: Promise<Got> } = {};
    var probe = fetchSegment(audio.url, -1);
    probe.then(function (r) {
        var start = Math.max(0, r.head - START_BEHIND);
        [video, audio].forEach(function (f) {
            var got = segments[f.url + '#' + start] = fetchSegment(f.url, start);
            got.then(null, function () { delete segments[f.url + '#' + start]; });
        });
    }, function () { return undefined; });
    early = { audio: audio.url, at: Date.now(), probe: probe, segments: segments };
}

/** A live stream's window on the playhead's scale (s): from its oldest segment to its head */
export interface LiveSpan {
    from: number;
    edge: number;
}

/** The time of t in a live stream: LIVE near the head, else how far behind it */
export function liveTime(t: number, span: LiveSpan): string {
    var behind = span.edge - t;
    return behind < LIVE_NEAR_S ? 'LIVE' : '\u2212' + clock(behind);
}

/** Where t lies in a live stream's window (0-1) */
export function liveShare(t: number, span: LiveSpan): number {
    return progress(span.from, span.edge, t);
}

class LiveTrack {
    sb: SourceBuffer | null = null;
    /** The next segment to fetch, whether one is being fetched, and its request (null: fetched ahead) */
    sq = -1;
    busy = false;
    xhr: XMLHttpRequest | null = null;
    /** Counts jumps and format switches: a reply to a request made before one is dropped */
    gen = 0;
    /** Fetched segments waiting for the buffer */
    waiting: ArrayBuffer[] = [];
    failures = 0;

    constructor(public format: Format) {}
}

export class LiveEngine implements Engine {
    private tracks: LiveTrack[] = [];
    private pipe: Pipeline | null = null;
    private stopped = false;
    private timer = 0;
    private onError: (() => void) | null = null;
    /** What the segments' own times are shifted by (s; NaN: not known yet), and the base they start at */
    private shift = NaN;
    private base: number;
    /** The latest segment's number YouTube reported */
    private head = -1;
    /** Each video segment's start (s, shifted) by number, as it came, and the latest of them (-1: none yet) */
    private starts: { [sq: number]: number } = {};
    private latest = -1;
    /** A jump's or the start's segment (-1: none): once its video is in, the playhead moves to its start */
    private landing = -1;
    /** The start fetched ahead this one takes (null: none) */
    private early: typeof early = null;
    private onFail: (why: string) => void;

    /** onFail: 'expired' (the URLs expired), 'media' (Media Source or the decoder), 'network' */
    constructor(private video: HTMLVideoElement, private live: Live, onFail: (why: string) => void) {
        this.onFail = spoilingFail(onFail);
        // Past the stream's window, so its oldest segment still lies after 0
        this.base = Math.max(live.dvr, 3600) + 60;
    }

    /** Plays the formats at the live head (startAt is for videos: a live stream starts behind its head) */
    load(video: Format, audio: Format, startAt: number): void {
        var self = this;
        this.tracks = [new LiveTrack(video), new LiveTrack(audio)];
        // The head's number from the audio track's latest segment (small), while Media Source opens; fetched ahead if
        // its tile rested in focus
        this.early = early && early.audio === audio.url && Date.now() - early.at < EARLY_MS ? early : null;
        early = null;
        var probe = (this.early ? this.early.probe : fetchSegment(audio.url, -1)).then(function (got) {
            self.head = got.head;
            note('live', 'head ' + got.head + (self.early ? ' (fetched ahead)' : ''));
        });
        var opened = openPipeline(this.video, [video.mime, audio.mime]).then(function (pipe) {
            self.pipe = pipe;
            if (self.stopped) {
                keepPipeline(self.video, pipe);
            }
        });
        Promise.all([probe, opened]).then(function () {
            if (!self.stopped) {
                self.open();
            }
        }, function (e) {
            if (!self.stopped && e !== 'stale') {
                self.onFail(e === 403 ? 'expired' : e === 'media' ? e : 'network');
            }
        });
    }

    /** Takes new URLs for the same formats and goes on where it was */
    renew(video: Format, audio: Format): boolean {
        var tracks = this.tracks;
        if (this.stopped || !tracks[0] || tracks[0].format.itag !== video.itag || tracks[1].format.itag !== audio.itag) {
            return false;
        }
        tracks[0].format = video;
        tracks[1].format = audio;
        tracks.forEach(function (t) { t.failures = 0; });
        this.pump();
        return true;
    }

    /** Jumps from from towards to (s) by whole segments, within the window (from a jump still landing: from its
     * segment) */
    jump(to: number, from: number): void {
        var at = this.landing >= 0 ? this.landing : this.segmentAt(from);
        if (at < 0) {
            return;
        }
        this.goTo(at + Math.round((to - from) / this.live.segment));
    }

    seek(t: number): void {
        this.jump(t, this.video.currentTime);
    }

    /** Plays another video format from the segment after the playhead's on (a quality change, or a preview taken over
     * full screen) */
    switchVideo(f: Format): void {
        var t = this.tracks[0];
        if (!t || this.stopped) {
            return;
        }
        t.format = f;
        this.restart(t);
        var at = this.landing >= 0 ? this.landing : this.segmentAt(this.video.currentTime);
        if (at >= 0) {
            t.sq = at + 1;
        }
        this.pump();
    }

    stop(): void {
        this.stopped = true;
        clearInterval(this.timer);
        if (this.onError) {
            this.video.removeEventListener('error', this.onError);
        }
        this.tracks.forEach(function (t) {
            if (t.xhr) {
                t.xhr.abort();
            }
        });
        this.tracks = [];
        // (Emptied there, the shift too, for the next video)
        keepPipeline(this.video, this.pipe);
    }

    /** The live head's time on the playhead's scale (s; 0: not known yet) */
    get edge(): number {
        return this.latest < 0 ? 0 : this.starts[this.latest] + (this.head - this.latest + 1) * this.live.segment;
    }

    /** The window's start on the playhead's scale (s) */
    get oldest(): number {
        return Math.max(0, this.edge - this.live.dvr);
    }

    private open(): void {
        var self = this;
        var pipe = this.pipe as Pipeline;
        try {
            // Long enough for a day of playing on
            setLength(pipe, this.base + 86400);
            this.tracks.forEach(function (t, i) {
                t.sb = pipe.buffers[i];
            });
        } catch (e) {
            this.onFail('media');
            return;
        }
        var start = Math.max(0, this.head - START_BEHIND);
        this.tracks.forEach(function (t) { t.sq = start; });
        this.landing = start;
        pipe.onUpdate = function (i) {
            var t = self.tracks[i];
            if (t) {
                self.land();
                self.trim(t);
                self.feedAll();
                self.pump();
            }
        };
        this.onError = function () { self.onFail('media'); };
        this.video.addEventListener('error', this.onError);
        // (Also what an update did not take: a full buffer is trimmed and appended to again)
        this.timer = setInterval(function () {
            self.tracks.forEach(function (t) { self.trim(t); });
            self.feedAll();
            self.pump();
        }, TICK_MS) as unknown as number;
        this.pump();
    }

    /** Each idle track fetches its next segment while less than AHEAD_S is buffered ahead (not past the next one to
     * come); both at once (the audio's first waits to be appended until the video's sets the shift) */
    private pump(): void {
        if (this.stopped) {
            return;
        }
        for (var i = 0; i < this.tracks.length; i++) {
            var t = this.tracks[i];
            if (!t.busy && !t.waiting.length && t.sq <= this.head + 1 && this.ahead(t) < AHEAD_S) {
                this.fetch(t);
            }
        }
    }

    private fetch(t: LiveTrack): void {
        var self = this;
        var sq = t.sq;
        var gen = t.gen;
        var ahead = this.early && this.early.segments[t.format.url + '#' + sq];
        var got = ahead || fetchSegment(t.format.url, sq, function (xhr) { t.xhr = xhr; });
        t.busy = true;
        got.then(function (r) {
            // Stopped, or a jump or switch moved the track on meanwhile
            if (self.stopped || t.gen !== gen) {
                return;
            }
            t.busy = false;
            t.xhr = null;
            t.failures = 0;
            self.head = Math.max(self.head, r.head);
            note('live', (t === self.tracks[0] ? 'video ' : 'audio ') + sq + ': ' + Math.round(r.data.byteLength / 1024) + ' KB');
            t.sq = sq + 1;
            t.waiting.push(r.data);
            if (t === self.tracks[0]) {
                self.timeOf(sq, r.data);
            }
            // (The video's first segment also lets the audio's, fetched before it, in)
            self.feedAll();
        }, function (e) {
            if (self.stopped || t.gen !== gen) {
                return;
            }
            t.busy = false;
            t.xhr = null;
            if (e === 403) {
                self.onFail('expired');
            } else if (++t.failures > RETRIES && self.ahead(t) < STILL_AHEAD_S) {
                self.onFail('network');
            }
            // Else asked again on the next tick
        });
    }

    /** Notes video segment sq's start; the first one sets the shift of both buffers */
    private timeOf(sq: number, data: ArrayBuffer): void {
        var own = segmentStart(data);
        if (isNaN(own)) {
            return;
        }
        if (isNaN(this.shift)) {
            this.shift = this.base - own;
            var shift = this.shift;
            this.tracks.forEach(function (t) {
                if (t.sb) {
                    t.sb.timestampOffset = shift;
                }
            });
        }
        this.starts[sq] = own + this.shift;
        this.latest = Math.max(this.latest, sq);
        // Out of the window: forgotten
        delete this.starts[sq - Math.ceil(this.live.dvr / this.live.segment) - 1];
    }

    private feedAll(): void {
        for (var i = 0; i < this.tracks.length; i++) {
            this.feed(this.tracks[i]);
        }
    }

    /** Appends the track's next fetched segment once its buffer is free */
    private feed(t: LiveTrack): void {
        if (!t.sb || t.sb.updating || !t.waiting.length || isNaN(this.shift)) {
            return;
        }
        try {
            t.sb.appendBuffer(t.waiting[0]);
            t.waiting.shift();
        } catch (e) {
            // Full: the trim after the next update makes room
            if ((e as Error).name !== 'QuotaExceededError') {
                this.onFail('media');
            }
        }
    }

    /** Moves the playhead to the landing segment's start once both tracks hold it (and the video has its metadata) */
    private land(): void {
        var at = this.starts[this.landing];
        if (this.landing >= 0 && at !== undefined && this.video.readyState >= 1 && this.buffered(this.tracks[0], at + LAND_IN) &&
            this.buffered(this.tracks[1], at + LAND_IN)) {
            this.video.currentTime = at + LAND_IN;
            note('live', 'landed at ' + this.landing);
            this.landing = -1;
        }
    }

    /** Removes what lies more than BEHIND_S behind the playhead (not while landing) */
    private trim(t: LiveTrack): void {
        var b = t.sb && t.sb.buffered;
        var until = this.video.currentTime - BEHIND_S;
        if (!b || !b.length || t.sb!.updating || this.landing >= 0 || b.start(0) >= until) {
            return;
        }
        try {
            t.sb!.remove(b.start(0), until);
        } catch (e) {
            // tried again after the next update
        }
    }

    /** Plays from segment sq (within the window and up to the head): from the buffer if it holds it, else fetched
     * anew */
    private goTo(sq: number): void {
        // (Not the oldest segment itself: it may be gone by the time it is asked for)
        var first = this.head - Math.floor(this.live.dvr / this.live.segment) + 2;
        sq = Math.min(this.head, Math.max(first, sq));
        var at = this.starts[sq];
        if (at !== undefined && this.buffered(this.tracks[0], at + LAND_IN) && this.buffered(this.tracks[1], at + LAND_IN)) {
            this.video.currentTime = at + LAND_IN;
            return;
        }
        this.landing = sq;
        this.early = null;
        var self = this;
        this.tracks.forEach(function (t) {
            self.restart(t);
            t.sq = sq;
            if (t.sb && t.sb.buffered.length) {
                try {
                    if (t.sb.updating) {
                        t.sb.abort();
                    }
                    t.sb.remove(0, Infinity);
                } catch (e) {
                    // emptied after the next update instead
                }
            }
        });
        this.pump();
    }

    /** Drops the track's request and what it fetched (a reply to it is dropped too) */
    private restart(t: LiveTrack): void {
        t.gen++;
        if (t.xhr) {
            t.xhr.abort();
            t.xhr = null;
        }
        t.busy = false;
        t.waiting = [];
        t.failures = 0;
    }

    /** The segment the time t (s) lies in (-1: none known) */
    private segmentAt(t: number): number {
        var best = -1;
        for (var sq in this.starts) {
            if (this.starts[sq] <= t + LAND_IN && (best < 0 || +sq > best)) {
                best = +sq;
            }
        }
        return best;
    }

    /** Seconds buffered ahead of the playhead in the track */
    private ahead(t: LiveTrack): number {
        var now = this.video.currentTime;
        return t.sb ? bufferedEnd(t.sb.buffered, now, 1) - now : 0;
    }

    private buffered(t: LiveTrack, at: number): boolean {
        return !!t.sb && bufferedEnd(t.sb.buffered, at, 0.001) > at;
    }
}

/** Live segment sq (-1: the latest) of a format: its bytes and the head's number; rejects with the HTTP status, 'abort'
 * or 'network'. started: given the request, to abort it */
function fetchSegment(url: string, sq: number, started?: (xhr: XMLHttpRequest) => void): Promise<Got> {
    return new Promise<Got>(function (resolve, reject) {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', url + (sq >= 0 ? '&sq=' + sq : ''), true);
        xhr.responseType = 'arraybuffer';
        xhr.timeout = TIMEOUT_MS;
        xhr.onload = function () {
            if (xhr.status === 200 && xhr.response) {
                resolve({ data: xhr.response as ArrayBuffer, head: +(xhr.getResponseHeader('X-Head-Seqnum') || -1) });
            } else {
                reject(xhr.status || 'network');
            }
        };
        xhr.onerror = xhr.ontimeout = function () { reject('network'); };
        xhr.onabort = function () { reject('abort'); };
        if (started) {
            started(xhr);
        }
        xhr.send();
    });
}

/** A segment's start (s): a WebM's (webmStart), an MP4's fragment decode time (moof > traf > tfdt) by its track's
 * timescale (moov > trak > mdia > mdhd); NaN if not found */
export function segmentStart(data: ArrayBuffer): number {
    var view = new DataView(data);
    if (data.byteLength >= 4 && view.getUint32(0) === 0x1A45DFA3) {
        return webmStart(data);
    }
    var mdhd = boxPath(view, ['moov', 'trak', 'mdia', 'mdhd']);
    var tfdt = boxPath(view, ['moof', 'traf', 'tfdt']);
    if (mdhd < 0 || tfdt < 0) {
        return NaN;
    }
    // Full boxes: version, then (mdhd) creation and modification times before the timescale
    var scale = view.getUint8(mdhd + 8) === 1 ? view.getUint32(mdhd + 28) : view.getUint32(mdhd + 20);
    var time = view.getUint8(tfdt + 8) === 1 ? u64(view, tfdt + 12) : view.getUint32(tfdt + 12);
    return scale ? time / scale : NaN;
}

/** The offset of the box at the end of path, each one inside the one before (-1: none) */
function boxPath(view: DataView, path: string[]): number {
    var from = 0;
    var to = view.byteLength;
    var box: { at: number; size: number } | null = null;
    for (var i = 0; i < path.length; i++) {
        box = findBox(view, from, to, path[i]);
        if (!box) {
            return -1;
        }
        from = box.at + 8;
        to = Math.min(to, box.at + box.size);
    }
    return box ? box.at : -1;
}
