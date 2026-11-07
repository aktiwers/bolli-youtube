// Live engine of the player: plays a live stream's video and audio formats (api/streams.ts Live) through Media Source.
// YouTube serves a live stream as numbered segments of ~5 s, each with its own init (an MP4 with its moov, a WebM with
// its header: VP9 too, so the pipeline kept from a VP9 video plays on without a new one); a request
// for one not made yet waits until it is, so each track asks for its next one at once, and a request without a number
// gives the latest, with the head's number in a header. Playback starts START_BEHIND segments behind the head; each
// track fetches one segment at a time up to AHEAD_S ahead of the playhead and trims what is BEHIND_S behind it. The
// segments' own times run from the stream's start (days: further than the TV's decoder counts), so both buffers shift
// them to start at a base past the stream's window (timestampOffset, from the first video segment's time). A jump
// moves by whole segments, back at most to the window's start and forward to the head; a viewer following it live (not
// after their own jump, seek or pause) who fell behind by a stall catches up (keepUp). A 403 fails as 'expired'; a
// segment already made that gets no data for a while, or a request with no answer, goes at once to another of the
// stream's networks (networks.ts, as dash.ts's); other errors fail as 'network' after retries. prefetchLive fetches a
// start ahead (its tile rests in focus): the head's number and both tracks' first segments, which the next start of
// those formats takes while fresh. A start tells the TV the stream ends just
// after the whole segments within WINDOW_S of it, and feeds no more until it plays (the quick start, as dash.ts's): then
// the day-long length comes back.

import { clock, progress } from '../core/time.js';
import { tr } from '../core/i18n.js';
import { Format, Live } from '../api/streams.js';
import { oneFragment, segmentStart } from './containers.js';
import { BEHIND_S, bufferedEnd, Engine, KEYFRAME_IN, RETRIES, STILL_AHEAD, TICK_MS, WINDOW_S } from './engine.js';
import { keepPipeline, openPipeline, Pipeline, setLength, setLengthSoon, spoilingFail } from './pipeline.js';
import { onLost, onNetwork } from './networks.js';
import { note } from './play-log.js';

/** Segments behind the head a start begins at (YouTube's own players stay about this far behind) */
var START_BEHIND = 3;
/** A live stream's length past its base: a day of playing on */
var DAY_S = 86400;
/** Buffer up to this far ahead of the playhead (s; BEHIND_S kept behind it) */
var AHEAD_S = 15;
/** A request for the next segment waits until YouTube has made it (~5 s) */
var TIMEOUT_MS = 30000;
/** Within this of the head (s) the time reads LIVE */
var LIVE_NEAR_S = 25;
/** A playhead this much further behind than a start plays (s; a stall) catches up (keepUp) */
var CATCH_UP_S = 15;
/** A start fetched ahead is taken this long (ms): the head moves on a segment each ~5 s */
var EARLY_MS = 10000;

type Got = { data: ArrayBuffer; head: number };

/** The start fetched ahead (null: none): the audio format's URL it is for, when, the head's probe, and the first
 * segments by URL and number */
var early: { audio: string; at: number; probe: Promise<Got>; segments: { [key: string]: Promise<Got> } } | null = null;

/** Fetches a live start ahead: the head's number, then both tracks' first segments (as a start would ask for them) */
export function prefetchLive(video: Format, audio: Format): void {
    var segments: { [key: string]: Promise<Got> } = {};
    // (the latest segment and those behind it are made: watched for no data)
    var probe = fetchSegment(audio.url, -1, undefined, true);
    probe.then(function (r) {
        var start = Math.max(0, r.head - START_BEHIND);
        [video, audio].forEach(function (f) {
            var got = segments[f.url + '#' + start] = fetchSegment(f.url, start, undefined, true);
            got.then(null, function () { delete segments[f.url + '#' + start]; });
        });
    }, function () { return undefined; });
    var at = Date.now();
    early = { audio: audio.url, at: at, probe: probe, segments: segments };
    // Not taken in time (or a video started instead): its data goes (the timer keeps only the time, not the data)
    setTimeout(function () {
        if (early && early.at === at) {
            early = null;
        }
    }, EARLY_MS);
}

/** A live stream's window on the playhead's scale (s): from its oldest segment to its head */
export interface LiveSpan {
    from: number;
    edge: number;
}

/** The time of t in a live stream: LIVE near the head, else how far behind it */
export function liveTime(t: number, span: LiveSpan): string {
    var behind = span.edge - t;
    return behind < LIVE_NEAR_S ? tr('LIVE') : '\u2212' + clock(behind);
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
    private listeners: { [event: string]: () => void } = {};
    /** The viewer follows the stream live: from the start, again once near its head; not after their own jump, seek or
     * pause */
    private following = true;
    /** What the segments' own times are shifted by (s; NaN: not known yet), and the base they start at */
    private shift = NaN;
    private base: number;
    /** The latest segment's number YouTube reported, and when (ms) */
    private head = -1;
    private headAt = 0;
    /** Each video segment's start (s, shifted) by number, as it came, and the latest of them (-1: none yet) */
    private starts: { [sq: number]: number } = {};
    private latest = -1;
    /** A jump's or the start's segment (-1: none): once its video is in, the playhead moves to its start */
    private landing = -1;
    /** The start's window (lift): the segment no track feeds until the stream plays (-1: none) */
    private windowSq = -1;
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
        // Once more on a passing error (also one fetched ahead), as segments are; not for expired URLs nor once stopped
        var again = function (e: unknown): Promise<Got> {
            if (e === 403 || self.stopped) {
                throw e;
            }
            return fetchSegment(audio.url, -1, undefined, true);
        };
        var probe = (this.early ? this.early.probe : fetchSegment(audio.url, -1, undefined, true)).then(null, again).then(function (got) {
            self.head = got.head;
            self.headAt = Date.now();
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
     * segment). The viewer's: no longer following live */
    jump(to: number, from: number): void {
        this.following = false;
        var at = this.landing >= 0 ? this.landing : this.segmentAt(from);
        if (at < 0) {
            return;
        }
        this.goTo(at + Math.round((to - from) / this.live.segment));
    }

    /** Where a jump still landing goes, on the playhead's scale (s; -1: none) */
    seekTarget(): number {
        var at = this.segmentAt(this.video.currentTime);
        return this.landing >= 0 && at >= 0 ? this.video.currentTime + (this.landing - at) * this.live.segment : -1;
    }

    /** To t on the playhead's scale (from the playhead's segment, also during a landing: t is measured from there). The
     * viewer's (a phone's seek, a restart): no longer following live */
    seek(t: number): void {
        this.following = false;
        var at = this.segmentAt(this.video.currentTime);
        if (at >= 0) {
            this.goTo(at + Math.round((t - this.video.currentTime) / this.live.segment));
        }
    }

    /** (a live stream is not loaded ahead) */
    hold(): void {
        return;
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
        // During a landing from its segment (it lands only once that is in), else from the one after the playhead's
        var at = this.segmentAt(this.video.currentTime);
        if (this.landing >= 0) {
            t.sq = this.landing;
        } else if (at >= 0) {
            t.sq = at + 1;
        }
        this.pump();
    }

    stop(): void {
        this.stopped = true;
        this.windowSq = -1;
        clearInterval(this.timer);
        for (var event in this.listeners) {
            this.video.removeEventListener(event, this.listeners[event]);
        }
        this.listeners = {};
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
        var start = Math.max(0, this.head - START_BEHIND);
        // The start's window: the whole segments within WINDOW_S of the start (and a little over them: a segment runs
        // a few ms longer than its nominal length)
        var whole = Math.floor((WINDOW_S - 0.5) / this.live.segment);
        this.windowSq = whole > 0 ? start + whole : -1;
        try {
            setLength(pipe, this.base + (this.windowSq >= 0 ? whole * this.live.segment + 0.5 : DAY_S));
            this.tracks.forEach(function (t, i) {
                t.sb = pipe.buffers[i];
            });
        } catch (e) {
            this.onFail('media');
            return;
        }
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
        this.on('error', function () { self.onFail('media'); });
        // (its data may be in before the metadata: then nothing else would land it during the start's window)
        this.on('loadedmetadata', function () { self.land(); });
        this.on('playing', function () {
            self.lift();
            self.keepUp();
        });
        // Played after a pause: the viewer's resume (a stall's end fires 'playing' only), or a start (following again
        // once near the head)
        this.on('play', function () { self.following = false; });
        // (Also what an update did not take: a full buffer is trimmed and appended to again; a landing missed)
        this.timer = setInterval(function () {
            self.land();
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
        var key = t.format.url + '#' + sq;
        var kept = this.early ? this.early.segments : {};
        var ahead = kept[key];
        // Taken: not kept for the rest of the stream
        delete kept[key];
        var got = ahead || fetchSegment(t.format.url, sq, function (xhr) { t.xhr = xhr; }, sq <= this.head);
        t.busy = true;
        got.then(function (r) {
            // Stopped, or a jump or switch moved the track on meanwhile
            if (self.stopped || t.gen !== gen) {
                return;
            }
            t.busy = false;
            t.xhr = null;
            t.failures = 0;
            if (r.head >= self.head) {
                self.head = r.head;
                self.headAt = Date.now();
            }
            note('live', (t === self.tracks[0] ? 'video ' : 'audio ') + sq + ': ' + Math.round(r.data.byteLength / 1024) + ' KB');
            t.sq = sq + 1;
            // (a low-latency stream's fragment per frame as one: containers.ts)
            var data = oneFragment(r.data);
            t.waiting.push(data);
            if (t === self.tracks[0]) {
                self.timeOf(sq, data);
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
            } else if (e === 'moved') {
                // At once from the stream's next network
                self.pump();
            } else if (++t.failures > RETRIES && self.ahead(t) < STILL_AHEAD) {
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

    /** Appends the track's next fetched segment once its buffer is free, setting the shift there (setting it on a busy
     * buffer throws); none past the start's window */
    private feed(t: LiveTrack): void {
        if (!t.sb || t.sb.updating || !t.waiting.length || isNaN(this.shift) || this.windowSq >= 0 && t.sq - t.waiting.length >= this.windowSq) {
            return;
        }
        try {
            if (t.sb.timestampOffset !== this.shift) {
                t.sb.timestampOffset = this.shift;
            }
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
        var at = this.landing >= 0 ? this.starts[this.landing] : undefined;
        if (at !== undefined && this.video.readyState >= 1 && this.buffered(this.tracks[0], at + KEYFRAME_IN) &&
            this.buffered(this.tracks[1], at + KEYFRAME_IN)) {
            this.video.currentTime = at + KEYFRAME_IN;
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

    /** Playing again: a viewer near the head follows it live; one following it who fell behind (a stall) is moved back
     * to START_BEHIND segments behind the head, as a start plays, once the lag is CATCH_UP_S more than that */
    private keepUp(): void {
        var t = this.video.currentTime;
        // (The head moves on in real time: after a pause, nothing fetched meanwhile told it)
        if (this.edge + (Date.now() - this.headAt) / 1000 - t < LIVE_NEAR_S) {
            this.following = true;
            return;
        }
        var at = this.segmentAt(t);
        var to = this.head - START_BEHIND;
        if (this.following && at >= 0 && this.landing < 0 && (to - at) * this.live.segment >= CATCH_UP_S) {
            note('live', 'caught up from ' + (this.head - at) + ' segments behind the head');
            this.goTo(to);
        }
    }

    private on(event: string, listener: () => void): void {
        this.listeners[event] = listener;
        this.video.addEventListener(event, listener);
    }

    /** The start's window lifted (the stream plays, or a jump moves it): the day-long length, the rest fed */
    private lift(): void {
        if (this.windowSq >= 0) {
            this.windowSq = -1;
            setLengthSoon(this.pipe as Pipeline, this.base + DAY_S);
            this.feedAll();
        }
    }

    /** Plays from segment sq (within the window and up to the head): from the buffer if it holds it, else fetched
     * anew */
    private goTo(sq: number): void {
        this.lift();
        // (Not the oldest segment itself: it may be gone by the time it is asked for)
        var first = this.head - Math.floor(this.live.dvr / this.live.segment) + 2;
        sq = Math.min(this.head, Math.max(first, sq));
        var at = this.starts[sq];
        if (at !== undefined && this.buffered(this.tracks[0], at + KEYFRAME_IN) && this.buffered(this.tracks[1], at + KEYFRAME_IN)) {
            this.video.currentTime = at + KEYFRAME_IN;
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
                    // The old data stays: the same stream's, valid where it lies
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
            if (this.starts[sq] <= t + KEYFRAME_IN && (best < 0 || +sq > best)) {
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

/** Live segment sq (-1: the latest) of a format, from a network that has not failed lately (networks.ts): its bytes
 * and the head's number; rejects with the HTTP status, 'abort', 'network', or 'moved' (no data or no answer from its
 * network: another of the stream's is there to ask at once). started: given the request, to abort it; made: the
 * segment exists already (one not made yet waits ~5 s for YouTube to make it), so getting no data for a while is a
 * stuck network */
function fetchSegment(url: string, sq: number, started?: (xhr: XMLHttpRequest) => void, made?: boolean): Promise<Got> {
    return new Promise<Got>(function (resolve, reject) {
        var xhr = new XMLHttpRequest();
        var used = onNetwork(url);
        xhr.open('GET', used + (sq >= 0 ? '&sq=' + sq : ''), true);
        xhr.responseType = 'arraybuffer';
        xhr.timeout = TIMEOUT_MS;
        xhr.onload = function () {
            if (xhr.status === 200 && xhr.response) {
                resolve({ data: xhr.response as ArrayBuffer, head: +(xhr.getResponseHeader('X-Head-Seqnum') || -1) });
            } else {
                reject(xhr.status || 'network');
            }
        };
        onLost(xhr, used, function () { reject('moved'); }, function () { reject('network'); }, !!made);
        xhr.ontimeout = function () { reject('network'); };
        // (a stalled one rejects before its abort)
        xhr.onabort = function () { reject('abort'); };
        if (started) {
            started(xhr);
        }
        xhr.send();
    });
}
