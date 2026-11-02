// DASH engine of the player: plays a video's separate video and audio formats (api/streams.ts: MP4 with a sidx
// index, WebM with Cues) through Media Source. Each track first fetches its head (init and index, plus the first
// piece of media when starting at 0, saving a round trip), then its segments in ~1 s ranged requests (YouTube
// throttles one long request), up to AHEAD s / AHEAD_MB ahead. Data behind is trimmed at segment starts and only
// between segments: a trim with a segment half appended makes the TV's Media Source drop the rest of it.
// Jumps land on keyframes (segment starts): the TV's decoder decodes from the previous keyframe at ~2.3x speed.
// Seeks wait while a buffer updates; no trim runs during a seek (it hangs). A 403 fails as 'expired' (renew
// continues with new URLs), other errors as 'network' after retries. prefetchHeads fetches heads ahead.

import { Format } from '../api/streams.js';
import { keepPipeline, openPipeline, Pipeline, setLength, spoilingFail } from './pipeline.js';

/** Buffer up to this far ahead of the playhead (s, and MB per track); keep up to this much behind it, so a
 * jump back stays buffered */
var AHEAD = 30;
var AHEAD_MB = 32;
var BEHIND = 20;
var BEHIND_MB = 16;
/** A request fetches about CHUNK_S of the format (CHUNK_MIN to CHUNK_MAX bytes); the first after a start or a
 * seek a third of that, for a faster first frame */
var CHUNK_S = 1.2;
var CHUNK_MIN = 1024 * 1024;
var CHUNK_MAX = 4 * 1024 * 1024;
var FIRST_MIN = 384 * 1024;
var MB = 1024 * 1024;
var TICK_MS = 500;
/** A jump lands this far after the keyframe (s): inside the buffer, not just before its first frame (that seek never ends) */
var KEYFRAME_IN = 0.05;
/** A hole this short just ahead of the playhead is hopped over (s) */
var HOLE_S = 1;
/** A format switch (switchVideo, switchAudio) takes effect about this far ahead of the playhead (s); video never
 * nearer than SWITCH_MIN_S (removing what the TV's decoder already holds, ~3 s, breaks playback), retried every
 * SWITCH_RETRY_MS until the buffer reaches that far */
var SWITCH_S = 3;
var SWITCH_MIN_S = 4;
var SWITCH_RETRY_MS = 1000;
/** A seek still not done after this is nudged on a little */
var SEEK_STUCK_MS = 5000;
var NUDGE_S = 0.1;
var RETRIES = 3;
var TIMEOUT_MS = 20000;
/** Downloads keep being retried while this much is still buffered ahead (seconds) */
var STILL_AHEAD = 3;

/** What the player needs from an engine (this one, and player/sabr-engine.ts for SABR) */
export interface Engine {
    /** preview: a tile's preview (an engine may then use what was fetched ahead differently) */
    load(video: Format, audio: Format, startAt: number, preview?: boolean): void;
    seek(t: number): void;
    jump(to: number, from: number): void;
    /** Stops; the pipeline is kept, paused, for the next video (player/pipeline.ts) */
    stop(): void;
    /** Takes new URLs for the playing formats (the old ones expired) and continues in place, keeping the buffer;
     * false if the formats differ (or the engine does not support it) */
    renew?(video: Format, audio: Format): boolean;
}

/** A segment: its times (s) and its bytes (inclusive) */
export interface Segment {
    start: number;
    end: number;
    from: number;
    to: number;
}

/** The segments of an MP4 file, from its first bytes (up to the end of its sidx box); [] without one */
export function parseSidx(data: ArrayBuffer): Segment[] {
    var view = new DataView(data);
    var box = findBox(view, 0, data.byteLength, 'sidx');
    return box ? sidxSegments(view, box.at, box.size) : [];
}

/** The MP4 box of this type among the boxes from from to to: its offset and size (null: none) */
export function findBox(view: DataView, from: number, to: number, type: string): { at: number; size: number } | null {
    var at = from;
    while (at + 8 <= to) {
        var size = view.getUint32(at);
        if (size === 1 && at + 16 <= to) {
            size = u64(view, at + 8);
        }
        if (size < 8) {
            return null;
        }
        if (String.fromCharCode(view.getUint8(at + 4), view.getUint8(at + 5), view.getUint8(at + 6), view.getUint8(at + 7)) === type) {
            return { at: at, size: size };
        }
        at += size;
    }
    return null;
}

export function u64(view: DataView, at: number): number {
    return view.getUint32(at) * 4294967296 + view.getUint32(at + 4);
}

function sidxSegments(view: DataView, box: number, size: number): Segment[] {
    var p = box + 8;
    var version = view.getUint8(p);
    p += 8;
    var timescale = view.getUint32(p);
    p += 4;
    var time = version ? u64(view, p) : view.getUint32(p);
    var first = version ? u64(view, p + 8) : view.getUint32(p + 4);
    p += version ? 16 : 8;
    var count = view.getUint16(p + 2);
    p += 4;
    // Offsets count from the first byte after the box
    var offset = box + size + first;
    var segments: Segment[] = [];
    for (var i = 0; i < count && p + 12 <= view.byteLength; i++, p += 12) {
        var bytes = view.getUint32(p) & 0x7fffffff;
        var duration = view.getUint32(p + 4);
        segments.push({ start: time / timescale, end: (time + duration) / timescale, from: offset, to: offset + bytes - 1 });
        offset += bytes;
        time += duration;
    }
    return segments;
}

/** An EBML number at at: its value and its length; an id keeps its marker bit. Null past the data. */
function vint(view: DataView, at: number, id: boolean): { value: number; length: number } | null {
    if (at >= view.byteLength) {
        return null;
    }
    var first = view.getUint8(at);
    var length = 1;
    var mask = 0x80;
    while (length <= 8 && !(first & mask)) {
        length++;
        mask >>= 1;
    }
    if (length > 8 || at + length > view.byteLength) {
        return null;
    }
    var value = id ? first : first & (mask - 1);
    var all = value === mask - 1;
    for (var i = 1; i < length; i++) {
        var b = view.getUint8(at + i);
        all = all && b === 0xff;
        value = value * 256 + b;
    }
    // All ones: unknown size (a Segment written while streaming)
    return { value: !id && all ? Infinity : value, length: length };
}

function uint(view: DataView, at: number, size: number): number {
    var value = 0;
    for (var i = 0; i < size; i++) {
        value = value * 256 + view.getUint8(at + i);
    }
    return value;
}

/** A WebM file's start (s): its first Cluster's Timecode by the TimecodeScale of its Info (a live segment, which
 * carries its own header); NaN if not found */
export function webmStart(data: ArrayBuffer): number {
    var view = new DataView(data);
    var SEGMENT = 0x18538067, INFO = 0x1549A966, SCALE = 0x2AD7B1, CLUSTER = 0x1F43B675, TIMECODE = 0xE7;
    var scale = 1000000;
    var at = 0;
    while (at < data.byteLength) {
        var id = vint(view, at, true);
        var size = id ? vint(view, at + id.length, false) : null;
        if (!id || !size) {
            return NaN;
        }
        var start = at + id.length + size.length;
        // Into these: their children follow
        if (id.value === SEGMENT || id.value === INFO || id.value === CLUSTER) {
            at = start;
            continue;
        }
        if (id.value === SCALE) {
            scale = uint(view, start, size.value);
        } else if (id.value === TIMECODE) {
            return uint(view, start, size.value) * scale / 1e9;
        }
        if (size.value === Infinity) {
            return NaN;
        }
        at = start + size.value;
    }
    return NaN;
}

/** The segments (clusters, from the Cues) of a WebM file, from its first bytes up to the end of the Cues;
 * length: the file size (end of the last cluster), duration (s): end time of the last one */
export function parseCues(data: ArrayBuffer, length: number, duration: number): Segment[] {
    var view = new DataView(data);
    var SEGMENT = 0x18538067, INFO = 0x1549A966, SCALE = 0x2AD7B1, CUES = 0x1C53BB6B, POINT = 0xBB, TIME = 0xB3,
        POSITIONS = 0xB7, CLUSTER = 0xF1;
    var scale = 1000000;
    var segmentStart = -1;
    var cues: { time: number; pos: number }[] = [];
    var at = 0;
    var end = data.byteLength;
    while (at < end) {
        var id = vint(view, at, true);
        var size = id ? vint(view, at + id.length, false) : null;
        if (!id || !size) {
            break;
        }
        var start = at + id.length + size.length;
        if (id.value === SEGMENT) {
            // Descend into the Segment: its children follow
            segmentStart = start;
            at = start;
            continue;
        }
        if (id.value === INFO || id.value === CUES || id.value === POINT || id.value === POSITIONS) {
            // Descend into these too; their children are read in turn
            if (id.value === POINT) {
                cues.push({ time: 0, pos: -1 });
            }
            at = start;
            continue;
        }
        if (start + size.value > end && id.value !== CLUSTER) {
            break;
        }
        if (id.value === SCALE) {
            scale = uint(view, start, size.value);
        } else if (id.value === TIME && cues.length) {
            cues[cues.length - 1].time = uint(view, start, size.value);
        } else if (id.value === CLUSTER && cues.length && cues[cues.length - 1].pos < 0) {
            cues[cues.length - 1].pos = uint(view, start, size.value);
        }
        at = start + size.value;
    }
    var segments: Segment[] = [];
    if (segmentStart < 0) {
        return segments;
    }
    for (var i = 0; i < cues.length; i++) {
        var next = cues[i + 1];
        segments.push({
            start: cues[i].time * scale / 1e9,
            end: next ? next.time * scale / 1e9 : duration,
            from: segmentStart + cues[i].pos,
            to: (next ? segmentStart + next.pos : length) - 1
        });
    }
    return segments;
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

/** The end of the buffered part that t is in (within slack), else t */
export function bufferedEnd(b: TimeRanges, t: number, slack?: number): number {
    for (var i = 0; i < b.length; i++) {
        if (b.start(i) <= t + (slack || 0.25) && b.end(i) >= t) {
            return b.end(i);
        }
    }
    return t;
}

/** A video's length when it is known (else 0) */
export function lengthOf(v: HTMLVideoElement): number {
    return v.duration > 0 && isFinite(v.duration) ? v.duration : 0;
}

/** Bytes from..to of url; a failure rejects with the HTTP status (0: none, 'timeout') */
function fetchBytes(url: string, from: number, to: number): { xhr: XMLHttpRequest; done: Promise<ArrayBuffer> } {
    var xhr = new XMLHttpRequest();
    var done = new Promise<ArrayBuffer>(function (resolve, reject) {
        // Range as a URL parameter, as YouTube's player does: no Range header, so no CORS preflight
        xhr.open('GET', url + '&range=' + from + '-' + to, true);
        xhr.responseType = 'arraybuffer';
        xhr.timeout = TIMEOUT_MS;
        xhr.onload = function () {
            if (xhr.status >= 200 && xhr.status < 300) {
                resolve(xhr.response as ArrayBuffer);
            } else {
                reject(xhr.status);
            }
        };
        xhr.onerror = xhr.onabort = function () {
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
    /** Count of switches requested (a later one cancels one still waiting for its place) */
    switchAsked = 0;
    /** A format switch waiting for its buffer (switchTrack): from segment index, cut at from (s); removed: the old
     * format's data from there has been removed */
    switching: { format: Format; segments: Segment[]; init: ArrayBuffer; index: number; from: number; removed?: boolean } | null = null;
    /** Append window start for a switched audio track's first segment (s; -1: none) */
    cut = -1;

    constructor(public format: Format) {
        this.chunk = chunkOf(format);
    }

    /** Bytes of the first request after a start or a seek */
    firstPiece(): number {
        return pieceOf(this.chunk);
    }

    /** Moves to the start of segment i */
    at(i: number): void {
        this.next = i;
        this.pos = i < this.segments.length ? this.segments[i].from : 0;
        this.fresh = true;
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
var ahead: { [key: string]: { xhr: XMLHttpRequest; done: Promise<ArrayBuffer> } } = {};

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
        var key = headKey(f, headEnd(f, startAt));
        var got = next[key] = ahead[key] || fetchBytes(f.url, 0, headEnd(f, startAt));
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

/** Aborts and drops prefetched heads not taken by a start */
export function dropAhead(): void {
    for (var key in ahead) {
        ahead[key].xhr.abort();
    }
    ahead = {};
}

/** A prefetched head (taken once; read: left for the next caller), else fetched now */
function head(f: Format, end: number, read: boolean): Promise<ArrayBuffer> {
    var key = headKey(f, end);
    var had = ahead[key];
    if (!read) {
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

    /** onFail: 'expired' (the URLs expired), 'media' (Media Source or the decoder), 'network', 'stream' (no index) */
    private onFail: (why: string) => void;

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
            tracks[i].failures = 0;
            this.pump(tracks[i]);
        }
        return true;
    }

    /** Seeks to t (s): now, or once no buffer is updating */
    seek(t: number): void {
        this.pending = t;
        this.settle();
    }

    /** Jumps from from towards to (s): to the nearest keyframe (a video segment's start) on that side of from */
    jump(to: number, from: number): void {
        var segments = this.tracks.length ? this.tracks[0].segments : [];
        var best = -1;
        for (var i = 0; i < segments.length; i++) {
            var s = segments[i].start;
            if ((to > from ? s > from + 1 : s < from - 1) && (best < 0 || Math.abs(s - to) < Math.abs(best - to))) {
                best = s;
            }
        }
        this.seek(best < 0 ? to : best + KEYFRAME_IN);
    }

    /** Plays the formats from startAt (s); preview: prefetched heads are only read, left for the player's start */
    load(video: Format, audio: Format, startAt: number, preview?: boolean): void {
        var self = this;
        var tracks = [new Track(video), new Track(audio)];
        this.tracks = tracks;
        // Fetch the heads while Media Source opens
        var heads = Promise.all(tracks.map(function (track) {
            var f = track.format;
            return head(f, headEnd(f, startAt), !!preview).then(function (data) {
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
            setLength(pipe, Math.max(tracks[0].segments[tracks[0].segments.length - 1].end, tracks[1].segments[tracks[1].segments.length - 1].end));
            for (var i = 0; i < tracks.length; i++) {
                var track = tracks[i];
                track.sb = pipe.buffers[i];
                track.at(segmentAt(track.segments, startAt));
                if (track.started && !track.next) {
                    // Media came with the head: continue after it (a short first segment may be complete)
                    track.fresh = false;
                    track.pos += track.started;
                    while (track.next < track.segments.length && track.pos > track.segments[track.next].to) {
                        track.next++;
                    }
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
        } catch (e) {
            this.onFail('media');
            return;
        }
        this.on('seeking', function () { self.seeked(); });
        this.on('seeked', function () { clearTimeout(self.stuckTimer); });
        this.on('waiting', function () { self.hop(); });
        this.on('pause', function () { self.rest(); });
        this.on('playing', function () { self.arm(); });
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
        var v = this.video;
        this.pending = -1;
        v.currentTime = t;
        clearTimeout(this.stuckTimer);
        this.stuckTimer = setTimeout(function () {
            if (v.seeking) {
                v.currentTime = v.currentTime + NUDGE_S;
            }
        }, SEEK_STUCK_MS) as unknown as number;
    }

    /** Moves a stalled playhead over a short hole just before buffered data */
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

    private pumpAll(): void {
        for (var i = 0; i < this.tracks.length; i++) {
            this.pump(this.tracks[i]);
        }
    }

    private pump(track: Track): void {
        var sb = track.sb;
        if (this.stopped || !sb || sb.updating || track.xhr) {
            return;
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
            try {
                sb.abort();
            } catch (e) {
                // Source no longer open: stop is near
            }
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
        if (track.next >= segments.length) {
            this.endIfDone();
            return;
        }
        if (bufferedEnd(sb.buffered, now) - now > AHEAD || track.pos - track.byteAt(now) > AHEAD_MB * MB) {
            return;
        }
        var segment = segments[track.next];
        var to = Math.min(segment.to, track.pos + (track.fresh ? track.firstPiece() : track.chunk) - 1);
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
            // While the buffer still plays, a short network drop is waited out
            var ahead = bufferedEnd(self.video.buffered, self.video.currentTime) - self.video.currentTime;
            if (++track.failures > RETRIES && ahead < STILL_AHEAD) {
                self.onFail('network');
                return;
            }
            setTimeout(function () { self.pump(track); }, 1000 * Math.min(track.failures, 5));
        });
    }

    /** Trims data more than BEHIND s or BEHIND_MB behind the playhead to half that, at a segment start (a keyframe).
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
        if (now - b.start(0) <= BEHIND && playing - track.byteAt(b.start(0)) <= BEHIND_MB * MB) {
            return false;
        }
        for (var i = segmentAt(segments, b.start(0)) + 1; i < segments.length && segments[i].from < playing; i++) {
            if (now - segments[i].start <= BEHIND / 2 && playing - segments[i].from <= BEHIND_MB * MB / 2) {
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
        track.failures = 0;
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
            // Continue from the segment at the end of what is buffered at the new time; a segment already in
            // flight there is kept
            var next = segmentAt(track.segments, bufferedEnd(sb.buffered, t, 0.04));
            if (next === track.next) {
                continue;
            }
            this.drop(track);
            // The parser may be mid-segment: reset it, as the new segment starts afresh
            try {
                sb.abort();
            } catch (e) {
                // Source no longer open: stop is near
            }
            track.at(next);
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
