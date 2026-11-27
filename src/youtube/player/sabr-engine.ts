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
// a whole 4K answer from text blocked the main thread for over a second). That first segment's
// media goes into the buffer as it comes (media: its first piece, then each time as much again
// has come), so the picture shows with its first frames in, as dash.ts's first piece, not once
// its 15-22 MB (4K) are whole. Each read of the text costs as much as all of it so far (on the
// TV ~15 ms a megabyte, and ~33 ms a megabyte read for the first time): it is read when due,
// not at each progress.
// The back buffer is trimmed at segment starts between appends (trimming mid-append leaves a
// hole). A seek outside the buffered data drops requests in flight and completes once both
// tracks cover the target. A resume start lands on the video keyframe there (decoding up to a
// later point runs at only ~2.3x play speed); audio is requested from that keyframe.
// A request that gets no data for a while, or no answer, goes at once to another of the
// video's networks while there is one (networks.ts).
// Fails as 'expired' (403, or the server wants a fresh /player reply), 'protection' (device
// attestation wanted), 'sabr' (server error or empty answers), 'network', 'media'.
// A start tells the TV the video ends WINDOW_S after it (a resume start: after its keyframe) and appends no video
// segment ending past that, the audio cut there, until its picture moves (the quick start, as dash.ts's: land): then
// the real length, and the audio segment across the window appended again from the cut on (kept: not asked of the
// server again; its frames from the cut on only, containers.ts framesFrom: else the TV plays ~46 ms of sound twice,
// late after it).
// A seek has its window too (quick jumps: engine.ts QUICK_MIN_S; narrow): what is buffered past it is removed first
// (never during a seek on its way: waitSeek), its segments forgotten (asked of the server again), then the seek, then
// the length told; it lifts once the picture moves (land). The audio segment across its end, sent again, goes in from
// the cut on only (resume).

import { fakedRequest } from '../core/fake-net.js';
import { base64Bytes, BufferedRange, FormatId, SabrAnswer, SabrReader, sabrRequest, SabrSegment } from '../api/sabr.js';
import { streamRequest } from '../api/sabr-stream.js';
import { Format, Sabr } from '../api/streams.js';
import { youtubePage } from '../api/youtube.js';
import { BEHIND_MB, BEHIND_S, bufferedEnd, decodeLoad, Engine, hopHole, jumpTarget, KEYFRAME_IN, landingBetween, LIFT_END_S, LIFT_MS, LIFT_S, MB, QUICK_MIN_S, QUICK_SPEED, QUICK_WAIT_MS, RETRIES, roomAhead, seekTold, SPEED_BYTES, STILL_AHEAD, SWITCH_MIN_S, TICK_MS, TIMEOUT_MS, windowFrom } from './engine.js';
import { framesFrom, trackScale, wholeFrames } from './containers.js';
import { lineAnswered, networkFailed, onNetwork, stallWatch } from './networks.js';
import { keepPipeline, openPipeline, Pipeline, setLength, setLengthSoon, spoilingFail } from './pipeline.js';
import { note } from './play-log.js';

/** Request more once less than this is buffered ahead of the playhead (s), unless more than AHEAD_MB of the track is
 * (engine.ts roomAhead);
 * trimmed to half once BEHIND_S or BEHIND_MB lie behind it */
var READAHEAD_S = 10;
/** A streamed answer's text is read at once (for a segment's header; at each progress until the video segment's has
 * come, where a resume start or a jump waits for it to ask for the sound: read only when due, that request went out a
 * progress event or two later, 50-100 ms), when the segment coming in is whole (the header
 * tells its length) and every this many bytes meanwhile (bytes), not at each progress: each read costs as much as all
 * the text so far (a 4K start's first answer, 17 MB, on the TV: 20 reads at each progress take 2.1 s, 6 when due 1.2 s;
 * a single read at the end shows the picture 0.8 s later) */
var READ_EVERY = 4 * MB;
/** While a resume start or a jump waits for the video segment's header, the text is read at each progress up to this
 * many bytes (the header comes within the answer's first kilobytes; an answer that never brings it is not read whole
 * at every progress) */
var SNAP_READ = 512 * 1024;
/** A start from under this far in (s) is one from 0: a video's first segment is at least this long, and a start lands
 * on its segment's keyframe */
var FROM_START_S = 2;
/** An init goes into the buffer with the segment behind it as one append where that segment is at most this large
 * (joining them copies it once) */
var JOIN_BYTES = 1024 * 1024;
/** Where a start's first piece is whole in an answer is told to the worker this many bytes on: its parts' own headers */
var PIECE_SLACK = 1024;
/** A start's or a seek's first video segment goes into the buffer as it comes: first once about FIRST_S of the format
 * are in (FIRST_MIN to FIRST_MAX bytes: this TV shows a start's picture with ~0.18 s of video in, and a dense 4K
 * keyframe with those frames is ~1.4 MB; as dash.ts's first piece), then each time as much again has come (so the
 * reads, each costing as much as all the text so far, stay few: for 22 MB five, not one every megabyte) */
var FIRST_S = 0.45;
var FIRST_MIN = 384 * 1024;
var FIRST_MAX = 1600 * 1024;
/** The first video answer of a run of the app (none has come whole yet: warm) brings its first second slower than a
 * dense format plays, on a connection just made. With FIRST_S of 4K60 in HDR (29 Mbit/s) in, the TV's picture ran dry
 * 0.6 s in and stood 1.7 to 2.7 s, in five of seven first starts (2026-11-25; the starts after it, three of three,
 * did not, nor the same video's SDR copy or its 1080p). So a dense format's first piece (one of DENSE_BYTES or more:
 * about 18 Mbit/s up) is then FIRST_COLD_S of it, FIRST_COLD_MAX bytes at most: the picture a moment later, and
 * enough behind it to last until the line has come up */
var FIRST_COLD_S = 1.2;
var FIRST_COLD_MAX = 5 * MB;
var DENSE_BYTES = MB;
var warm = false;
/** A sound's switch in place is made within a segment only with this much of the segment left after its point (s):
 * nearer its end, from the end */
var SOUND_CUT_MIN_S = 0.5;
/** An answer all there whose text is not all read yet (a segment going in by its parts, the buffer busy): looked at
 * again this often (ms) */
var REST_MS = 30;
/** Answers in a row that only name another address are followed at once this many times; then as ones with nothing new */
var REDIRECTS = 3;
/** Answers in a row that bring a track nothing new before it gives up */
var EMPTY_ANSWERS = 5;
/** The video answers whose speeds judge the line for a seek's window (their median: one alone may be a pause of the
 * page) */
var SPEEDS = 3;
/** A start's first segments told in the play log (SabrEngine.tell) */
var TOLD = 8;
var JUMP_TOLD = 6;
/** The seeks' windows' audio cuts kept (SabrEngine.tails) */
var TAILS = 4;
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
    /** Answers in a row that only sent it to another address */
    redirects = 0;
    /** Bumped by a seek outside its data and by stop: an answer still in flight is ignored */
    gen = 0;
    /** A media segment coming in whose parts go into the buffer as they come (SabrEngine.media): its number, the parts
     * waiting for the buffer, the bytes that came so far, and whether it is whole (null: none) */
    streamed: { num: number; parts: Uint8Array[]; bytes: number; whole: boolean } | null = null;

    /** A segment that came in by its parts was let go half in the buffer: the buffer's parser is reset before the
     * next append (SabrEngine.feed) */
    torn = false;

    /** The bytes of a segment coming in by its parts that go in first, as one piece (FIRST_S of the format) */
    firstPiece(): number {
        return warm ? this.piece : this.cold;
    }

    private piece: number;
    /** The same for the run's first video answer (FIRST_COLD_S of a dense format) */
    private cold: number;

    constructor(public format: Format, public kind: number) {
        this.id = idOf(format);
        this.piece = Math.max(FIRST_MIN, Math.min(FIRST_MAX, Math.round(format.bitrate / 8 * FIRST_S)));
        this.cold = this.piece < DENSE_BYTES ? this.piece : Math.max(this.piece, Math.min(FIRST_COLD_MAX, Math.round(format.bitrate / 8 * FIRST_COLD_S)));
    }

    /** Its request in flight dropped (an answer still on its way is ignored), the server's backoff and its empty
     * answers forgotten: asked anew at the next pump */
    unask(): void {
        this.gen++;
        if (this.xhr) {
            this.xhr.abort();
            this.xhr = null;
        }
        this.waitUntil = 0;
        this.empty = 0;
    }

    /** Another format of the same kind from here on (SabrEngine.switchVideo): named in the requests, its init still
     * to come */
    becomes(format: Format): void {
        this.format = format;
        this.id = idOf(format);
        this.inited = false;
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

    /** The segment coming in by its parts has its first part in the buffer */
    started(): boolean {
        var by = this.streamed;
        return !!by && this.pieces.some(function (p) { return p.num === by!.num && p.appended; });
    }

    /** Queues a new segment and records it among its pieces; false if it already has it */
    take(seg: SabrSegment): boolean {
        if (this.pieces.some(function (p) { return p.num === seg.num; })) {
            return false;
        }
        this.record(seg, seg.data.length);
        this.queue.push(seg);
        return true;
    }

    /** A segment among its pieces, in order (size: its bytes, 0 while they come) */
    record(seg: SabrSegment, size: number): void {
        var i = 0;
        while (i < this.pieces.length && this.pieces[i].num < seg.num) {
            i++;
        }
        this.pieces.splice(i, 0, { num: seg.num, startMs: seg.startMs, endMs: seg.startMs + seg.durationMs, size: size, appended: false });
    }

    /** Its request is over: the segment coming in by its parts let go if not whole (unstream) */
    ended(): void {
        this.xhr = null;
        this.unstream();
    }

    /** The segment coming in by its parts will not be whole (its request failed, or its answer ended without it): let
     * go and asked for again, the buffer's parser reset first where a part of it is in (feed). Else it would count as
     * there for good, the server never asked for it again, and nothing behind it would go in. */
    unstream(): void {
        var by = this.streamed;
        if (by && !by.whole) {
            this.dropStreamed();
        }
    }

    /** The segment coming in by its parts let go: its piece forgotten, the buffer's parser reset before the next append
     * where a part of it is in (feed) */
    private dropStreamed(): void {
        var by = this.streamed;
        if (!by) {
            return;
        }
        this.torn = this.torn || this.started();
        this.pieces = this.pieces.filter(function (p) { return p.num !== by!.num; });
        this.streamed = null;
    }

    /** Drops the request in flight and queued, unappended segments (a seek outside its data) */
    restart(): void {
        this.unask();
        this.queue = this.queue.filter(function (q) { return q.init; });
        // (one coming in by its parts is not whole in the buffer: asked for again, written over what is there of it)
        this.dropStreamed();
        this.pieces = this.pieces.filter(function (p) { return p.appended; });
    }
}

/** A format as the requests name it */
function idOf(format: Format): FormatId {
    return { itag: format.itag, lmt: format.lmt, xtags: format.xtags };
}

/** The keyframes a jump into a segment may land on (s): its own, and the next one's where another follows it (endMs:
 * -1 none); engine.ts jumpTarget takes the nearer on the jump's side of where it came from, as for a guest's jump by
 * its index (a landing between keyframes has this TV decode from the one before it, 2-8 s for a 4K video) */
function keyframes(startMs: number, endMs: number): number[] {
    return endMs >= 0 ? [startMs / 1000, endMs / 1000] : [startMs / 1000];
}

/** Where a jump from `from` (s; -1: a start) past a part skipped up to t (s) lands by the video segment there (its
 * start and end, ms; last: the video's last one, no keyframe follows): KEYFRAME_IN into the segment if t is at most
 * that far into it; else by engine.ts landingBetween its keyframe and the next one's (load: the format's
 * decodeLoad) */
function startFrom(startMs: number, endMs: number, last: boolean, t: number, load: number, from: number): number {
    var start = startMs / 1000;
    return t <= start + KEYFRAME_IN ? start + KEYFRAME_IN : landingBetween(start, last ? -1 : endMs / 1000, t, load, from);
}

/** How heavy a format is for the TV's decoder (engine.ts decodeLoad) */
function heavy(f: Format): number {
    return decodeLoad(f.width, f.height, f.fps);
}

/** Parts as one array (one part: itself) */
function joined(parts: Uint8Array[]): Uint8Array {
    if (parts.length === 1) {
        return parts[0];
    }
    var size = 0;
    parts.forEach(function (p) { size += p.length; });
    var all = new Uint8Array(size);
    var at = 0;
    parts.forEach(function (p) {
        all.set(p, at);
        at += p.length;
    });
    return all;
}

/** Marks a track's piece of a media segment as in the buffer */
function markAppended(track: Track, seg: SabrSegment): void {
    track.pieces.forEach(function (p) {
        if (!seg.init && p.num === seg.num) {
            p.appended = true;
        }
    });
}

export class SabrEngine implements Engine {
    /** Engine.bySabr: the account's streams */
    bySabr = true;
    loaded?: (bytes: number, ms: number) => void;
    private tracks: Track[] = [];
    /** How many of the start's segments the play log was told of (tell) */
    private told = 0;
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
     * resume start), a forward jump snapping only to a keyframe still ahead of it; snapPast: a jump past a skipped
     * part, landing by the segment the answer brings there (startFrom) */
    private pending = -1;
    /** The video format a switch in place is still to be made to (switchVideo; null: none), and whether from where
     * what is loaded ends */
    private switchTo: Format | null = null;
    private switchAfter = false;
    /** The sound format a switch in place is still to be made to (switchAudio; null: none) and how far ahead of the
     * playhead it is to be heard (s) */
    private soundTo: Format | null = null;
    private soundAhead = 0;
    private snap = false;
    private snapFrom = -1;
    private snapPast = false;
    private stuckTimer = 0;
    /** The window up (s; 0: none): a start's, or a seek's (narrow); the real length, the audio segment across it, where
     * it ended (-1: the audio's append window reset) */
    private window = 0;
    private length = 0;
    private cut: SabrSegment | null = null;
    private cutAt = -1;
    /** A seek (not a start's own) waits to be asked: it may get a window of its own (narrow). clearing: that window's
     * end while what lies past it is being removed (0: not) */
    private going = false;
    private clearing = 0;
    /** Where the seek of the seek's window up landed (s; -1: no seek's window up), when that seek ended (ms; 0: not
     * yet), and when the last seek was asked (ms) */
    private landed = -1;
    private seekedAt = 0;
    private soughtAt = 0;
    /** An answer's bytes are being read (read): no append meanwhile */
    private reading = false;
    /** The seek on its way was asked before its media was in (a start's own, a jump's into a segment coming in) */
    private ahead = false;
    /** The video's length is still to be told: after the first seek of a start on a kept pipeline (load, settle) */
    private lengthDue = false;
    /** A start's window: whether it began to play, when (ms) and where (s); it lifts once the picture moved (land) */
    private played = false;
    private playedAt = 0;
    private playedFrom = 0;
    /** A seek whose window must remove waits for the seek on its way (waitSeek: 1; -1: waited QUICK_WAIT_MS, no
     * window) */
    private waits = 0;
    private waitTimer = 0;
    /** Where seeks' windows cut the audio buffer, and sound switches made within a segment (s; the last TAILS): the
     * audio segment across one, sent again or in the new sound, goes in from there on only (resume) */
    private tails: number[] = [];
    /** The last video answers' speeds (bit/s; those of SPEED_BYTES or more, up to SPEEDS) */
    private speeds: number[] = [];
    /** Seeks get a window of their own (Engine.quick) */
    quick = false;

    /** onFail: 'expired', 'protection', 'sabr', 'network', 'media' */
    private onFail: (why: string) => void;
    /** The line is down: no request is made (wait) */
    private lineWait = false;

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
        // (a start this near the beginning lands on the first segment's keyframe, at 0: as a start from 0, with no
        // header to wait for before its seek and its sound)
        if (startAt < FROM_START_S) {
            startAt = 0;
        }
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
        // (a start from a resume point seeks itself, once its keyframe's header is in: no seek by the pipeline before)
        openPipeline(this.video, [video.mime, audio.mime], startAt > 0).then(function (pipe) {
                self.pipe = pipe;
            // Stopped meanwhile: kept for the next video
            if (self.stopped) {
                keepPipeline(self.video, pipe);
                return;
            }
            try {
                // (a start that seeks on a kept pipeline: the length after its seek, settle; the video stands where
                // the last one did until then, maybe past this one's window)
                // (also where a jump has taken the start's place: the video stands where the last one did all the same)
                self.lengthDue = startAt > 0 && self.video.readyState >= 1;
                if (!self.lengthDue) {
                    setLength(pipe, self.window || self.length);
                }
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
            self.on('seeked', function () {
                self.ahead = false;
                clearTimeout(self.stuckTimer);
                self.seekedAt = Date.now();
                // (a seek that waited for this one: waitSeek; or one asked while this one's window was up, its
                // landing held back by that window: nothing updates to bring settle again)
                if (self.waits > 0 || self.behind()) {
                    self.settle();
                }
            });
            self.on('waiting', function () { self.hop(); });
            self.on('loadedmetadata', function () { self.settle(); });
            self.on('playing', function () {
                // (a start's window, as a seek's, lifts once the picture moves: land; one being made for a seek is not
                // a start's)
                if (self.window && self.landed < 0 && !self.going && !self.played) {
                    self.played = true;
                    self.playedAt = Date.now();
                    self.playedFrom = self.video.currentTime;
                }
            });
            self.on('timeupdate', function () { self.land(); });
            self.on('error', function () { self.onFail('media'); });
            self.timer = setInterval(function () {
                self.land();
                self.hop();
                // (a quick jump still waiting: its landing may have come without a buffer's update, or since the seek
                // before it ended)
                if (self.pending >= 0 && (self.quick || self.startSeek())) {
                    self.settle();
                }
                self.pump();
            }, TICK_MS) as unknown as number;
            // A kept pipeline already has its metadata (no loadedmetadata comes): a start's seek first, if where it
            // lands is known already, then what has come
            self.settle();
            self.tracks.forEach(function (track) { self.feed(track); });
        }, function (e) {
            // Superseded by a newer request: ignore
            if (!self.stopped && e !== 'stale') {
                self.onFail('media');
            }
        });
    }

    /** Seeks to t (s), the step inside a jump (the player jumps: jump), once the metadata is in, no buffer is updating
     * and both tracks cover it (requested from there) */
    seek(t: number): void {
        this.go(t, -1);
    }

    /** Seeks to t; from: a jump's origin when it is to snap to the keyframe its first answer brings (else -1), past:
     * to the first one at or after t (snapPast) */
    private go(t: number, from: number, past?: boolean): void {
        if (!this.tracks.length) {
            return;
        }
        this.ahead = false;
        // (a segment still coming in by its parts: let go, asked for anew where the seek needs it; a seek's window
        // and its removals deal in whole segments)
        this.tracks.forEach(function (track) {
            if (track.streamed) {
                track.restart();
            }
        });
        // (a seek's window whose seek is still on its way stays up: narrow lifts it, once that seek may be waited for)
        if (!(this.landed >= 0 && this.video.seeking)) {
            this.lift();
        }
        this.pending = t;
        this.going = true;
        this.clearing = 0;
        // (a jump's first asks and headers are told as a start's: tell)
        this.told = Math.min(this.told, TOLD - JUMP_TOLD);
        note('sabr to seek', 'to ' + t.toFixed(2) + (from >= 0 ? ' from ' + from.toFixed(2) : '') + (past ? ', past a part' : ''));
        // (a wait given up for the seek before: this one may wait again)
        if (this.waits < 0) {
            this.waits = 0;
        }
        this.snap = from >= 0;
        this.snapFrom = from;
        this.snapPast = !!past;
        this.restart(t);
        this.settle();
        this.pump();
    }

    /** Jumps to about `to` (s) from `from`: to the nearer keyframe of the segment known there and the next one's, else
     * as the segment its first answer brings says (snap, header). past (a part skipped up to `to`): with quick jumps by the segment known there
     * (startFrom: its start if `to` is just after that, else `to` itself or the next one's start, whichever is the
     * sooner way on), and with none known there, by the segment the first answer brings (snapPast); without quick
     * jumps to `to` itself */
    jump(to: number, from: number, past?: boolean): void {
        var video = this.tracks[0];
        if (!video) {
            return;
        }
        if (past) {
            var piece = this.quick ? video.pieces[video.at(to)] : null;
            // (snapped only where an answer is to come: not past all there is)
            var snap = this.quick && !piece && !video.covers(to);
            this.go(piece ? startFrom(piece.startMs, piece.endMs, video.last > 0 && piece.num >= video.last, to, heavy(video.format), from) : to, snap ? from : -1, snap);
            return;
        }
        // In a segment known: on the nearer of its keyframe and the next one's (keyframes); else where the first answer
        // says (header)
        var at = video.pieces[video.at(to)];
        var target = at ? jumpTarget(keyframes(at.startMs, video.last > 0 && at.num >= video.last ? -1 : at.endMs), to, from) : to;
        this.go(target, video.covers(target) ? -1 : from);
    }

    seekTarget(): number {
        return this.pending;
    }

    /** Switches the video format in place (the same codec and range: the player asks no other), with no stop, as
     * dash.ts's engine does: the old format's data from the first keyframe SWITCH_MIN_S ahead (what the TV has taken
     * in: replacing that makes the picture stand) is removed and forgotten, and the server is asked for the new format
     * from there: named as the video's in the requests from now, its init first (the track counts as not initialised),
     * the segments kept before that point told as buffered so that it goes on after them. after: from where what is
     * loaded ends, nothing removed (a step down with little ahead). Made once nothing stands in its way (switchNow);
     * a later one replaces one still waiting, one back to the format playing gives it up. Until this was here every
     * quality picked on the signed-in streams, and the player's Super resolution switch, started the video anew. */
    switchVideo(f: Format, ahead?: number, soon?: boolean, after?: boolean): void {
        var track = this.tracks[0];
        if (!track || this.stopped) {
            return;
        }
        this.switchTo = f.itag === track.format.itag ? null : f;
        this.switchAfter = !!after;
        this.switchNow();
    }

    /** The switch asked for (switchVideo), once no seek is asked or on its way, no window is up (a start's, a seek's:
     * their removals and lengths are their own), no segment comes in by its parts, and the buffer is free; else again
     * at the next pump */
    private switchNow(): void {
        var f = this.switchTo;
        var track = this.tracks[0];
        if (!f || !this.free(track)) {
            return;
        }
        this.switchTo = null;
        var t = this.video.currentTime;
        var last = track.pieces[track.pieces.length - 1];
        var cut = last ? last.endMs / 1000 : t;
        if (!this.switchAfter) {
            for (var i = 0; i < track.pieces.length; i++) {
                if (track.pieces[i].startMs / 1000 >= t + SWITCH_MIN_S) {
                    cut = track.pieces[i].startMs / 1000;
                    break;
                }
            }
        }
        var inBuffer = track.pieces.some(function (p) { return p.appended && p.startMs / 1000 >= cut - 0.01; });
        note('sabr switches', track.format.itag + ' -> ' + f.itag + ' from ' + cut.toFixed(2) + ', playing at ' + t.toFixed(2) + (inBuffer ? ' (the old format removed from there)' : ''));
        this.swap(track, f, cut, inBuffer);
    }

    /** Nothing stands in the way of a switch in place on track: no seek asked or on its way, no window up (a start's, a
     * seek's: their removals and lengths are their own), no segment coming in by its parts, its buffer idle */
    private free(track: Track | undefined): boolean {
        var sb = track && track.sb;
        return !!sb && !this.stopped && this.pending < 0 && !this.going && !this.window && this.landed < 0 && !this.video.seeking && !track!.streamed &&
            !sb.updating;
    }

    /** track switched in place to f from s on: its request in flight dropped (it brings the old format, its answer
     * ignored), the old format's data from s forgotten and, where the buffer has it (inBuffer), removed; f named in the
     * requests from now, its init first */
    private swap(track: Track, f: Format, s: number, inBuffer: boolean): void {
        track.unask();
        this.forget(track, s);
        if (inBuffer) {
            try {
                track.sb!.remove(s, Math.max(this.length, s) + 1);
            } catch (e) {
                // (the source no longer open: stop is near)
            }
        }
        track.becomes(f);
        this.pump();
    }

    /** Engine.switchAudio: another sound of the same type (another language's track, the stable volume copy, Voice
     * boost) from about ahead s past the playhead on, with no stop: the old sound's data from that very point is
     * removed, the new format named as the sound's in the requests from now, its init first, and its segment across
     * the point put in from the point on (a sound segment is 10 s: at a segment's start the change would be heard
     * up to 10 s late). With nothing loaded that far, or the point within half a second of a segment's end, from
     * the segment's end, nothing cut. Made once nothing stands in its way (soundNow); a later one replaces one still
     * waiting, one back to the sound playing gives it up. Until this was here every change of the sound on the
     * signed-in streams started the video anew. */
    switchAudio(f: Format, ahead?: number): void {
        var track = this.tracks[1];
        if (!track || this.stopped) {
            return;
        }
        var now = track.format;
        this.soundTo = f.itag === now.itag && f.lmt === now.lmt && f.xtags === now.xtags ? null : f;
        this.soundAhead = ahead || 0;
        this.soundNow();
    }

    /** The sound's switch asked for (switchAudio), once nothing stands in its way (free), no jump snaps and no cut
     * is going in; made within a segment, its point is kept as a window's cut is (tails): the new sound's segment
     * across it goes in from there on (resume), if what is buffered still ends there then */
    private soundNow(): void {
        var f = this.soundTo;
        var track = this.tracks[1];
        if (!f || !this.free(track) || this.snap || this.cut || this.cutAt >= 0) {
            return;
        }
        this.soundTo = null;
        var t = this.video.currentTime;
        var at = t + this.soundAhead;
        var p = track.pieces[track.at(at)];
        var from: number;
        var within = false;
        if (!p) {
            // (with nothing loaded there, from where what is loaded ends)
            from = Math.max(t, track.ahead(t).end);
        } else {
            var start = p.startMs / 1000;
            var end = p.endMs / 1000;
            within = at - start > 0.01 && end - at >= SOUND_CUT_MIN_S;
            // (not within a segment: from its start where the point is that, from its end where the point is near that)
            from = within ? at : at - start <= 0.01 ? start : end;
        }
        var inBuffer = track.pieces.some(function (q) { return q.appended && q.endMs / 1000 > from + 0.01; });
        if (within) {
            this.keepTail(from);
        }
        note('sabr sound switches', track.format.itag + ' -> ' + f.itag + ' from ' + from.toFixed(2) + (within ? ' (within its segment)' : '') + ', playing at ' + t.toFixed(2));
        this.swap(track, f, from, inBuffer);
    }

    /** The real length while the TV is told a window's (a seek's, and a start's until its picture has moved) or
     * still has a lifted one's */
    realLength(): number {
        // (a lifted window's end stays the element's length until its buffers are idle: pipeline.ts setLengthSoon)
        return this.window || this.length > 0 && this.video.duration < this.length - 0.5 ? this.length : 0;
    }

    /** A seek waits behind an earlier seek's window still up (its segments past that window are held back) */
    private behind(): boolean {
        return this.pending >= 0 && this.landed >= 0;
    }

    /** Engine.wait: none of its requests while the line is down */
    wait(on: boolean, ask?: boolean): void {
        this.lineWait = on;
        if (on) {
            this.letGo();
        } else if (ask !== false) {
            this.pump();
        }
    }

    /** Engine.letGo: each track's request on its way and what it holds unappended dropped (the next pump asks anew) */
    letGo(): void {
        this.tracks.forEach(function (track) { track.restart(); });
    }

    stop(): void {
        this.stopped = true;
        clearInterval(this.timer);
        clearTimeout(this.stuckTimer);
        this.stopWait();
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
        // (a start that seeks on a kept pipeline: told after its seek, settle)
        if (this.window && this.pipe && !this.lengthDue) {
            setLengthSoon(this.pipe, this.window);
        }
    }

    /** The window lifted (its picture moved, or a seek moves it): the real length */
    private lift(): void {
        if (!this.window) {
            return;
        }
        this.cutAt = this.window;
        this.window = 0;
        this.landed = -1;
        this.played = false;
        this.clearing = 0;
        // (not before a start's own seek on a kept pipeline: told after it, settle)
        if (this.pipe && !this.lengthDue) {
            setLengthSoon(this.pipe, this.length);
        }
        this.pump();
    }

    /** A seek's window lifts once the picture moves where it landed (LIFT_S, by the TV's own clock: for LIFT_MS after
     * the seek's end the element's time is the browser's guess), or nears where the window's video ends (LIFT_END_S). A
     * start's the same way from where and when it began to play: lifted before its first frame shows, the TV at times
     * falls back to its slow start */
    private land(): void {
        var v = this.video;
        var seek = this.landed >= 0;
        // (a start's: not before it began to play, nor while a seek's window is being made in its place)
        if (!this.window || this.pending >= 0 || v.seeking || v.paused || !seek && (!this.played || this.going)) {
            return;
        }
        var from = seek ? this.landed : this.playedFrom;
        var since = seek ? this.seekedAt : this.playedAt;
        var edge = this.within(this.window, from) || this.window;
        if (v.currentTime > from + LIFT_S && (!seek || since > 0) && Date.now() - since >= LIFT_MS || v.currentTime > edge - LIFT_END_S) {
            this.lift();
        }
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
        // (a switch of the video's format still waiting for its moment: switchVideo)
        if (this.switchTo) {
            this.switchNow();
        }
        if (this.soundTo) {
            this.soundNow();
        }
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

    /** Engine.readahead: at most this much is loaded ahead (a video loaded ahead of its start: what it holds), which
     * Auto judges what is loaded against (it had waited for 15 s ahead to step up, which never comes) */
    get readahead(): number {
        return this.most || READAHEAD_S;
    }

    private ask(track: Track): void {
        if (this.lineWait) {
            return;
        }
        if (this.told < TOLD) {
            note('sabr asks', track.kind === PICTURE ? 'video' : 'audio');
        }
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
                // (its own: a sound segment the answer brings first, taken while the sound's own request waits for
                // a resume start's keyframe, does not end it)
                enough = enough || streaming && seg.itag === track.format.itag;
            }
        }, function (header) {
            if (gen === track.gen) {
                self.header(header, streaming ? track : null);
            }
        }, streaming ? function (header, part) {
            var took = gen === track.gen && self.media(track, header, part);
            if (took) {
                parts++;
                largest = Math.max(largest, part.length);
            }
            return took;
        } : undefined);
        // (for the play log: the media parts that went into the buffer as they came, and the largest)
        var parts = 0;
        var largest = 0;
        var failed = function (): void {
            if (gen === track.gen) {
                track.ended();
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
                // Sent from youtube.com's page, as its own player does; an answer read as it comes by a worker of that
                // page where one can be had (api/sabr-stream.ts: the page's thread stays free for the appends and the
                // picture), else by the page itself, as text
                var faked = fakedRequest();
                var stream = streaming && !faked ? streamRequest(w) : null;
                if (stream) {
                    // (whatever comes while a start's keyframe is waited for: its header may come after a sound
                    // segment's media)
                    stream.reads = { early: self.snap ? SNAP_READ : 0, first: track.firstPiece(), most: READ_EVERY };
                }
                var xhr = track.xhr = faked || stream as unknown as XMLHttpRequest || new (w as unknown as { XMLHttpRequest: typeof XMLHttpRequest }).XMLHttpRequest();
                xhr.open('POST', url, true);
                var asked = Date.now();
                var read = 0;
                // The streamed text's next read is due once this much of the answer is in (0: at the next progress)
                var due = 0;
                // (for the play log: its reads, those after which no segment's end was known, and their time)
                var reads = 0;
                var untold = 0;
                var readMs = 0;
                // Reads what has come since the last read, at most `most` bytes of it (0: all)
                var more = function (most: number): void {
                    var t0 = Date.now();
                    if (stream) {
                        // (the worker's: bytes already, as it read them)
                        var chunks = stream.take();
                        reads += chunks.length;
                        for (var c = 0; c < chunks.length; c++) {
                            read += chunks[c].length;
                        }
                        if (chunks.length) {
                            self.read(reader, chunks);
                        }
                        readMs += Date.now() - t0;
                        return;
                    }
                    var got = xhr.responseText;
                    reads++;
                    var to = most ? Math.min(got.length, read + most) : got.length;
                    if (to > read) {
                        var b = new Uint8Array(to - read);
                        for (var i = 0; i < b.length; i++) {
                            b[i] = got.charCodeAt(read + i) & 0xff;
                        }
                        read = to;
                        self.read(reader, [b]);
                    }
                    readMs += Date.now() - t0;
                };
                // A segment going in by its parts: how much of it the next read takes (its first piece, then as much
                // again each time, READ_EVERY at most: a step's bytes are turned from text and appended in less time
                // than they play; 0: none goes so, all that came), and whether the buffer still takes what came of it
                // (no read then: a read holds the page, and the append with it; the first piece then showed a second
                // late)
                var step = function (): number {
                    var by = track.streamed;
                    var first = track.firstPiece();
                    return !by ? 0 : by.bytes < first ? first - by.bytes : Math.min(READ_EVERY, by.bytes);
                };
                var taking = function (): boolean {
                    var by = track.streamed;
                    return !!by && (track.started() || by.bytes >= track.firstPiece()) && (by.parts.length > 0 || !!track.sb && track.sb.updating);
                };
                var done = function (): void {
                    track.failures = 0;
                    // (the answer ended with its segment not whole: asked for again)
                    track.unstream();
                    var bytes = streaming ? read : (xhr.response as ArrayBuffer).byteLength;
                    var ms = Date.now() - asked;
                    if (track.kind === PICTURE && bytes >= SPEED_BYTES && ms > 0) {
                        // (a video answer has come whole: the line is up for the starts after this one)
                        warm = true;
                        self.speeds.push(bytes * 8000 / ms);
                        if (self.speeds.length > SPEEDS) {
                            self.speeds.shift();
                        }
                    }
                    // (the connection's speed for the player's Auto quality, as the guest's engine tells it)
                    if (track.kind === PICTURE && self.loaded) {
                        self.loaded(bytes, ms);
                    }
                    if (streaming) {
                        note('sabr streamed', Math.round(read / 1024) + ' KB, ' + reads + ' reads (' + untold + ' no end known) ' + readMs + ' ms' + (stream ? ' (read by the worker, first bytes after ' + stream.first + ' ms)' : '') +
                            (parts ? ', in as it came: ' + parts + ' parts, the largest ' + Math.round(largest / 1024) + ' KB' : ''));
                    }
                    if (!taken) {
                        var a = reader.answer;
                        note('sabr nothing', (track.kind === PICTURE ? 'video' : 'audio') + ' answer of ' + bytes + ' B: wait ' + a.backoffMs + ' ms' + (a.redirect ? ', another address' : '') +
                            (a.protection ? ', protection ' + a.protection : '') + (a.error ? ', error ' + a.error : '') + (a.reload ? ', reload' : ''));
                    }
                    self.answered(track, reader.answer, taken);
                };
                // The answer all there (or cut): what is left of its text read step by step as the buffer takes it
                // (the text grows no more: a read costs its own bytes alone now), then the answer is done
                var rest = function (): void {
                    if (gen !== track.gen || track.xhr !== xhr) {
                        return;
                    }
                    if (!stream && taking()) {
                        setTimeout(rest, REST_MS);
                        return;
                    }
                    more(step());
                    // (a header in what was read may have asked anew in this request's place, a jump's next
                    // keyframe: that request is the track's now)
                    if (gen !== track.gen || track.xhr !== xhr) {
                        return;
                    }
                    if (!stream && !enough && read < xhr.responseText.length) {
                        setTimeout(rest, REST_MS);
                        return;
                    }
                    track.xhr = null;
                    done();
                };
                if (streaming) {
                    xhr.overrideMimeType('text/plain; charset=x-user-defined');
                    xhr.onprogress = function (e: ProgressEvent) {
                        if (gen !== track.gen || xhr.status < 200 || xhr.status >= 300 || track.xhr !== xhr || !stream && (e.loaded < due || taking())) {
                            return;
                        }
                        more(step());
                        // (asked anew in this request's place meanwhile: as in rest)
                        if (gen !== track.gen || track.xhr !== xhr) {
                            return;
                        }
                        if (enough) {
                            // The rest comes with the next request
                            track.xhr = null;
                            xhr.abort();
                            done();
                            return;
                        }
                        if (stream) {
                            // (the worker reads by its own steps; where the start's first piece is whole, or the
                            // segment coming in, at once: its steps count the answer's bytes, sound and headers too)
                            var by = track.streamed;
                            var piece = by && !by.whole && !track.started() ? read + track.firstPiece() - by.bytes + PIECE_SLACK : -1;
                            var whole = reader.segmentEnd();
                            var at = piece > read && (whole < 0 || piece < whole) ? piece : whole;
                            if (at > read) {
                                stream.readAt(at);
                            }
                            return;
                        }
                        // (while the video's keyframe is waited for, the sound's request with it: at each progress,
                        // the text still short; the segment the answer opens first, a sound one, ends after the video's)
                        var end = reader.segmentEnd();
                        due = end < 0 || self.snap && read < SNAP_READ ? 0 : Math.min(end, read + (step() || READ_EVERY));
                        untold += end < 0 ? 1 : 0;
                    };
                } else {
                    xhr.responseType = 'arraybuffer';
                }
                xhr.timeout = TIMEOUT_MS;
                xhr.onload = function () {
                    // (any answer: the line is up)
                    lineAnswered();
                    if (gen !== track.gen || track.xhr !== xhr) {
                        return;
                    }
                    if (xhr.status === 403) {
                        track.ended();
                        self.onFail('expired');
                    } else if (xhr.status < 200 || xhr.status >= 300) {
                        track.ended();
                        self.retry(track);
                    } else if (streaming) {
                        // (its request counts as on its way until its text is read: nothing asked meanwhile)
                        rest();
                    } else {
                        track.xhr = null;
                        self.read(reader, [new Uint8Array(xhr.response as ArrayBuffer)]);
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
                        track.ended();
                    } else {
                        failed();
                    }
                };
                xhr.onerror = function () {
                    lost(false);
                };
                stallWatch(xhr, function () { lost(true); });
                xhr.send(body);
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
        // Another address to ask at: taken for this engine and for the video's next start, and asked at once where
        // the answer brought nothing else (a few times in a row at most: no wait as for an answer with nothing new)
        var redirected = false;
        if (a.redirect) {
            this.url = a.redirect;
            this.sabr.url = a.redirect;
            redirected = !taken && ++track.redirects <= REDIRECTS;
        }
        if (taken) {
            track.redirects = 0;
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
        track.empty = taken || redirected ? 0 : track.empty + 1;
        if (track.empty > EMPTY_ANSWERS) {
            this.onFail('sabr nothing came');
            return;
        }
        track.waitUntil = redirected ? 0 : Date.now() + Math.max(a.backoffMs, track.empty ? 1000 * track.empty : 0);
        // A resume start or jump whose video answer had no segment: play from the requested time (not one that only
        // named another address: the answer from there brings the keyframe)
        if (this.snap && track.kind === PICTURE && !redirected) {
            this.snapped();
        }
        // A quick jump waiting for what this answer brought: under its window a segment can be taken without an
        // append (its part before the cut is in the buffer already), and then no buffer's update comes to make the
        // seek. And a start's own seek, which what waits for the buffers waits for (feed): no update brings it either
        if (this.pending >= 0 && (this.quick || this.startSeek())) {
            this.settle();
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

    /** An answer's bytes to its reader; what they bring goes into the buffers once they are read through (an init
     * with the segment behind it as one append, a segment coming in by its parts with what came of it: feed) */
    private read(reader: SabrReader, bytes: Uint8Array[]): void {
        var self = this;
        this.reading = true;
        try {
            for (var i = 0; i < bytes.length; i++) {
                reader.push(bytes[i]);
            }
        } finally {
            this.reading = false;
        }
        this.tracks.forEach(function (track) { self.feed(track); });
    }

    /** A segment header arrived: a resume start or a jump lands on the first video segment there (its keyframe); a
     * forward jump only on one still ahead of where it came from. A resume start opens its window there. stream: the
     * track whose answer, read as it comes, brought it: its segment may go into the buffer by its parts (parts). */
    private header(h: SabrSegment, stream?: Track | null): void {
        this.tell('header', h);
        var track = this.tracks[0];
        var own = !h.init && h.itag === track.format.itag;
        var snapped = this.snap && own;
        if (snapped) {
            var start = h.startMs / 1000;
            var end = (h.startMs + h.durationMs) / 1000;
            var last = track.last > 0 && h.num >= track.last;
            if (this.snapPast && this.pending >= 0) {
                this.pending = startFrom(h.startMs, h.startMs + h.durationMs, last, this.pending, heavy(track.format), this.snapFrom);
            } else if (this.snapFrom >= 0 && this.pending >= 0 && start <= this.pending && this.pending < end) {
                // A jump: on the nearer of this segment's keyframe and the next one's (keyframes); the next one's is
                // asked for in this one's place, and landed on at its header
                var to = jumpTarget(keyframes(h.startMs, last ? -1 : h.startMs + h.durationMs), this.pending, this.snapFrom);
                this.pending = to;
                if (to > end) {
                    // (this answer's segment is not the one to land in: let go. The next one's is asked for, unless
                    // it is there already, a jump back to just before what is buffered: no header would come for
                    // that, and the jump would never be made)
                    track.restart();
                    if (!track.covers(to)) {
                        this.pump();
                        return;
                    }
                }
            } else if (this.snapFrom < 0 && this.pending >= 0 && start <= this.pending && this.pending - start < 10) {
                this.pending = start + KEYFRAME_IN;
            }
            this.snapped();
        }
        if (own && stream === track) {
            this.parts(track, h);
        }
        // (the seek at once, what waited for it then fed once the answer's bytes are read: read; also a start's
        // whose wait for its keyframe an answer without one ended)
        if (snapped || own && this.startSeek()) {
            this.settle();
            this.pump();
        }
    }

    /** The picture's segment whose header an answer read as it comes just brought is to go into the buffer by its
     * parts (media), where it is the one a start or a jump begins in and nothing but the init waits before it: a
     * start's first (nothing of the track there yet; a window it ends past is lifted, as feed does for a first
     * segment), or the one a jump lands on the keyframe of (its window is made with its seek, before the first part goes
     * in: a removal with a segment half in makes the TV drop the rest of it; so also with a window of a seek before it
     * still up, which that seek's own lifts first: narrow. Refused then, as it was, a jump made while the one before was
     * on its way waited for its whole segment before its seek: 25 MB of a 4K60 video in HDR, 3.2 s, the picture 5 s
     * after the last key). Its piece counts from here: the seek, its window and the sound's requests go by it, the server is not
     * asked for it again. */
    private parts(track: Track, h: SabrSegment): void {
        var start = h.startMs / 1000;
        var end = (h.startMs + h.durationMs) / 1000;
        if (track.streamed || track.queue.some(function (q) { return !q.init; }) || track.pieces.some(function (p) { return p.num === h.num; })) {
            return;
        }
        if (this.going || this.landed >= 0) {
            // (a landing between keyframes: whole, then the seek; asked before its target is in, the TV took 9 s)
            if (!this.going || this.pending < start || this.pending > start + KEYFRAME_IN + 0.001) {
                return;
            }
        } else if (track.pieces.length) {
            return;
        } else if (this.window && end > this.window + 0.01) {
            this.lift();
        }
        track.streamed = { num: h.num, parts: [], bytes: 0, whole: false };
        track.record(h, 0);
    }

    /** A start's first segments are written in the play log as their headers come and as they are whole (TOLD of them:
     * what an answer brought, in which order) */
    private tell(what: string, seg: SabrSegment): void {
        if (this.told < TOLD) {
            this.told++;
            note('sabr ' + what, seg.itag + (seg.init ? ' init' : ' #' + seg.num + ' ' + (seg.startMs / 1000).toFixed(2) + '-' + ((seg.startMs + seg.durationMs) / 1000).toFixed(2)) +
                (seg.data.length ? ', ' + seg.data.length + ' B' : ''));
        }
    }

    /** A complete segment arrived: queued for its track (once) and appended; true if it was new to the track */
    private segment(seg: SabrSegment): boolean {
        var track = this.tracks.filter(function (t) { return t.format.itag === seg.itag; })[0];
        var taken = false;
        this.tell(track ? 'segment' : 'segment of no track', seg);
        if (!track) {
            return false;
        }
        if (seg.init) {
            if (!track.inited) {
                track.inited = true;
                track.scale = trackScale(seg.data);
                track.queue.push(seg);
            }
        } else if (seg.streamed) {
            // Its parts went into the buffer as they came (media): whole now, its piece known since its first part
            var by = track.streamed;
            if (by && by.num === seg.num) {
                by.whole = true;
                track.pieces.forEach(function (p) {
                    if (p.num === seg.num) {
                        p.size = seg.streamed as number;
                    }
                });
                taken = true;
            }
        } else {
            taken = track.take(seg);
        }
        // (appended once the answer's bytes are read through: read)
        return taken;
    }

    /** A part of a media segment as it comes in a streamed answer: taken for the buffer (true) where its segment
     * goes in by its parts (parts, at its header). Appended by feed, once a read is through. */
    private media(track: Track, h: SabrSegment, part: Uint8Array): boolean {
        var by = track.streamed;
        if (!by || h.init || h.itag !== track.format.itag || by.num !== h.num || by.whole) {
            return false;
        }
        by.parts.push(part);
        by.bytes += part.length;
        return true;
    }

    /** Appends the track's next segment (one at a time): none past the start's window (no window at all for a first
     * video segment longer than it), the audio cut there; once lifted, the audio's cut segment again from the cut on */
    private feed(track: Track): void {
        var sb = track.sb;
        // (not while an answer's bytes are being read: what they bring goes in together once they are read through)
        if (this.stopped || !sb || sb.updating || this.reading) {
            return;
        }
        // (a start's own seek goes first where the element takes one, a kept pipeline: settle, at its keyframe's
        // header; a jump's into a segment coming in by its parts before the first of them: its window's removals)
        if (this.video.readyState >= 1 && (this.startSeek() || track.kind === PICTURE && this.jumpAhead())) {
            return;
        }
        if (track.torn) {
            track.torn = false;
            try {
                sb.abort();
            } catch (e) {
                // (the source no longer open: stop is near)
            }
        }
        if (track.kind === SOUND && this.tails.length && this.resume(track, sb)) {
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
                    track.full = false;
                } catch (e) {
                    // Full: again once more is trimmed (trim leaves a track with segments waiting alone unless full)
                    this.cut = again;
                    if ((e as Error).name !== 'QuotaExceededError') {
                        this.onFail('media');
                    } else {
                        track.full = true;
                    }
                }
                return;
            }
            sb.appendWindowStart = 0;
            this.cutAt = -1;
        }
        var seg = track.queue[0];
        // The init goes in with what is at hand behind it, as one append (each is a round of the TV's, 10-25 ms: a
        // small video's start has its first segment whole with the init's answer)
        var init = seg && seg.init ? seg : null;
        // A segment coming in by its parts (media): what has come of it since goes in, after the init and before any
        // segment queued behind it; its piece counts as in the buffer from its first part there (a restart drops it).
        // Its first piece as one: not what a read before it brought of it
        var by = track.streamed;
        var piece = !!by && by.parts.length > 0 && (by.whole || track.started() || by.bytes >= track.firstPiece());
        if (by && (piece || !init)) {
            if (piece) {
                try {
                    sb.appendBuffer(joined(init ? [init.data].concat(by.parts) : by.parts));
                    track.full = false;
                } catch (e) {
                    // Full: again once more is trimmed (trim leaves a track with segments waiting alone unless full)
                    if ((e as Error).name === 'QuotaExceededError') {
                        track.full = true;
                    } else {
                        this.onFail('media');
                    }
                    return;
                }
                if (init) {
                    track.queue.shift();
                }
                by.parts = [];
                track.pieces.forEach(function (p) {
                    if (p.num === by!.num) {
                        p.appended = true;
                    }
                });
                return;
            }
            if (by.parts.length || !by.whole) {
                return;
            }
            track.streamed = by = null;
        }
        if (!seg) {
            return;
        }
        // (while one comes in by its parts the init alone: the segments queued behind it wait for it)
        var next = init && !by ? track.queue[1] : null;
        // (not one across a cut still to make (tails): a sound switched within a segment, its init first, alone)
        var both = next && !next.init && next.data.length <= JOIN_BYTES && !(track.kind === SOUND && this.tailIn(next) >= 0) ? next : null;
        var media = init ? both : seg;
        if (this.window && media) {
            var end = (media.startMs + media.durationMs) / 1000;
            var first = track.kind === PICTURE && end > this.window + 0.01 && !track.pieces.some(function (p) { return p.appended; });
            if (first && !both) {
                // (a first video segment longer than the window: no window at all; the lift feeds the tracks)
                this.lift();
                return;
            }
            if (first || (track.kind === PICTURE ? end > this.window + 0.01 : media.startMs / 1000 >= this.window)) {
                // (not now: the init alone, if it is one)
                if (!both) {
                    return;
                }
                both = media = null;
            }
            if (media && track.kind === SOUND) {
                sb.appendWindowEnd = this.window;
                if (end > this.window) {
                    this.cut = media;
                }
            }
        }
        track.queue.splice(0, both ? 2 : 1);
        try {
            sb.appendBuffer(both ? joined([seg.data, both.data]) : seg.data);
            track.full = false;
        } catch (e) {
            if ((e as Error).name === 'QuotaExceededError') {
                // Full: retried (pump) once more is trimmed
                if (both) {
                    track.queue.unshift(both);
                }
                track.queue.unshift(seg);
                track.full = true;
                return;
            }
            this.onFail('media');
            return;
        }
        markAppended(track, seg);
        if (both) {
            markAppended(track, both);
        }
    }

    /** A cut kept (tails): the last TAILS */
    private keepTail(at: number): void {
        if (this.tails.indexOf(at) < 0) {
            this.tails.push(at);
            if (this.tails.length > TAILS) {
                this.tails.shift();
            }
        }
    }

    /** Which of the cuts kept (tails) seg lies across (-1: none) */
    private tailIn(seg: SabrSegment): number {
        var start = seg.startMs / 1000;
        var end = (seg.startMs + seg.durationMs) / 1000;
        for (var k = 0; k < this.tails.length; k++) {
            if (start < this.tails[k] - 0.01 && end > this.tails[k] + 0.01) {
                return k;
            }
        }
        return -1;
    }

    /** The audio segment across a cut kept (tails: a seek's window's, sent again; a sound switched within a segment,
     * in the new sound), while what is buffered there ends at the cut (else it is appended whole: the cut is stale, a
     * jump since; as the old sound or what is not buffered, it goes in over what is about to play or fills the gap):
     * taken without an append, and the window's cut segment (the lift appends it from the cut on); with no window up,
     * appended from the cut on through the cut (feed); with a window up that ends further on, its part from the cut to
     * the window now. True: feed goes no further (an append began, or waits on a full buffer). */
    private resume(track: Track, sb: SourceBuffer): boolean {
        var seg = track.queue[0];
        if (!seg || seg.init) {
            return false;
        }
        var start = seg.startMs / 1000;
        var end = (seg.startMs + seg.durationMs) / 1000;
        var k = this.tailIn(seg);
        // (a start's cut segment still to go in: first)
        if (k < 0 || this.cut && !this.window) {
            return false;
        }
        var tail = this.tails[k];
        var held = bufferedEnd(sb.buffered, start, 0.05);
        if (held < tail - 0.05 || held > tail + 0.1) {
            this.tails.splice(k, 1);
            return false;
        }
        if (!this.window || tail >= this.window - 0.01) {
            this.tails.splice(k, 1);
            track.queue.shift();
            markAppended(track, seg);
            this.cut = seg;
            if (!this.window) {
                this.cutAt = tail;
            }
            return false;
        }
        var dropped = wholeFrames(track.format.mime);
        try {
            sb.appendWindowStart = 0;
            sb.appendWindowEnd = this.window;
            sb.appendWindowStart = dropped ? 0 : tail;
            sb.appendBuffer(framesFrom(seg.data, tail, track.scale, dropped));
            track.full = false;
        } catch (e) {
            // Full: again once more is trimmed (as above)
            if ((e as Error).name !== 'QuotaExceededError') {
                this.onFail('media');
            } else {
                track.full = true;
            }
            return true;
        }
        this.tails.splice(k, 1);
        track.queue.shift();
        markAppended(track, seg);
        if (end > this.window) {
            this.cut = seg;
        }
        return true;
    }

    /** A start's own seek is still to be asked: none asked yet, no jump in its place */
    private startSeek(): boolean {
        return this.pending >= 0 && !this.going && this.landed < 0 && !this.soughtAt;
    }

    /** A jump is still to be asked whose segment there is coming in by its parts, none of them in the buffer yet */
    private jumpAhead(): boolean {
        var video = this.tracks[0];
        return this.going && !this.snap && this.pending >= 0 && !!video.streamed && !video.started() && video.covers(this.pending);
    }

    /** Performs the pending seek once the metadata is in and no buffer is updating: a start's own as soon as where it
     * lands is known, a jump's once both tracks cover the target (a seek's window made first: narrow); one not done
     * within SEEK_STUCK_MS is nudged */
    private settle(): void {
        var t = this.pending;
        var v = this.video;
        // Not before the pipeline is in: a kept one has the previous video's metadata
        if (t < 0 || v.readyState < 1 || this.snap || !this.pipe) {
            return;
        }
        // A start's own seek is asked as soon as where it lands is known, before its media is in, as the guest
        // engine asks its: the TV then has the place when the first piece comes, and shows it ~50 ms sooner. A jump's
        // too where the segment it lands in is coming in by its parts (its window made first: no part in yet)
        var own = this.lengthDue;
        var ahead = this.startSeek() || this.jumpAhead();
        for (var i = 0; i < this.tracks.length; i++) {
            var track = this.tracks[i];
            // (else once both tracks have the segment there)
            if (track.sb && track.sb.updating || !ahead && (!track.covers(t) || track.streamed && !track.started())) {
                return;
            }
        }
        this.ahead = ahead;
        var w = this.going ? this.narrow(t) : 0;
        if (w < 0) {
            return;
        }
        this.going = false;
        this.pending = -1;
        clearTimeout(this.stuckTimer);
        note('sabr seeks', 'to ' + t.toFixed(2) + (w ? ', its window to ' + w.toFixed(2) : ''));
        this.soughtAt = Date.now();
        this.seekedAt = 0;
        // The length told with the seek (the playhead, now the seek's target, lies within it): a seek's window, or a
        // start's own on a kept pipeline (engine.ts seekTold)
        this.lengthDue = false;
        this.stuckTimer = seekTold(v, this.pipe, t, w || (own ? this.window || this.length : 0), own);
        if (w) {
            this.landed = t;
        }
    }

    /** A seek's window, before the seek (quick jumps): the window from where the seek lands (engine.ts windowFrom),
     * with the video of the landing's run that ends within it (at least QUICK_MIN_S). What is buffered past it is
     * removed (the video from where that video ends, the audio from the window: its segment across the window goes in
     * again from there, resume) and those segments are forgotten at once (asked of the server again; a seek that comes
     * before this one is asked does not take them as there). Not during a seek on its way (waitSeek): an earlier seek's
     * window still up is lifted only then, and a start's or a window's audio cut goes in first. Returns the window's
     * end; 0: none (quick jumps off, a slow line, near the end, the stream ended, a seek not waited for); -1: settle
     * comes again (the buffers update, or a seek is waited for). */
    private narrow(t: number): number {
        if (this.clearing) {
            var cleared = this.clearing;
            this.clearing = 0;
            return cleared;
        }
        var plan = this.plan(t);
        if (plan && this.video.seeking && this.removes(plan.w, plan.end)) {
            if (this.waitSeek()) {
                return -1;
            }
            plan = null;
        }
        this.stopWait();
        // (with the buffers updating for it, decided anew at their end)
        if (this.window) {
            this.lift();
            if (this.updating()) {
                return -1;
            }
        }
        if (!plan) {
            return 0;
        }
        var audio = this.tracks[1];
        if (this.cutAt >= 0) {
            this.feed(audio);
            if (this.updating()) {
                return -1;
            }
            // (waits on a full buffer: a plain seek)
            if (this.cutAt >= 0) {
                return 0;
            }
        }
        var w = plan.w;
        this.window = w;
        var removing = false;
        try {
            for (var i = 0; i < this.tracks.length; i++) {
                var track = this.tracks[i];
                var sb = track.sb as SourceBuffer;
                var b = sb.buffered;
                var last = b.length ? b.end(b.length - 1) : 0;
                var from = i ? w : plan.end;
                // (an audio frame across the window's end stays)
                if (last > from + 0.05) {
                    sb.remove(from, last);
                    removing = true;
                    this.forget(track, from);
                    if (i) {
                        this.keepTail(w);
                    }
                }
            }
        } catch (e) {
            // No window: a plain seek, once a removal begun has ended
            this.lift();
            this.going = false;
            return this.updating() ? -1 : 0;
        }
        if (removing) {
            this.clearing = w;
            return -1;
        }
        return w;
    }

    /** The window a seek to t would get, and where its video ends (null: none) */
    private plan(t: number): { w: number; end: number } | null {
        var pipe = this.pipe as Pipeline;
        if (!this.quick || pipe.source.readyState !== 'open' || this.slow()) {
            return null;
        }
        var w = windowFrom(t, this.length);
        var end = w ? this.within(w, t) : 0;
        return end - t >= QUICK_MIN_S ? { w: w, end: end } : null;
    }

    /** Whether a window to w, its video ending at end, has anything to remove from a buffer */
    private removes(w: number, end: number): boolean {
        for (var i = 0; i < this.tracks.length; i++) {
            var b = (this.tracks[i].sb as SourceBuffer).buffered;
            if (b.length && b.end(b.length - 1) > (i ? w : end) + 0.05) {
                return true;
            }
        }
        return false;
    }

    /** A seek whose window must remove, with another seek on its way (this TV hangs on a removal during a seek). True:
     * that one is waited for (settle comes again at its 'seeked'), but only one in a window of its own, which ends within
     * QUICK_WAIT_MS of being asked. False: no window for this seek. (Also where the seek waited for cannot end, its
     * segment let go for this one, two jumps back in a row to where nothing is loaded: not waiting then was tried on
     * the TV, 2026-11-25, and was slower: the plain seek that follows, asked that much sooner before its media is in,
     * took 3-9 s with a 4K60 video in HDR, against 1.5-4.4 s after the wait.) */
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
        }
        return true;
    }

    private stopWait(): void {
        clearTimeout(this.waitTimer);
        this.waitTimer = 0;
        this.waits = 0;
    }

    /** The line's speed (bit/s): the median of the last video answers (0: none measured yet) */
    private speed(): number {
        return this.speeds.length ? this.speeds.slice().sort(function (a, b) { return a - b; })[this.speeds.length >> 1] : 0;
    }

    /** A line too slow for a seek's window: under QUICK_SPEED times the video format's bitrate (none measured: not) */
    private slow(): boolean {
        var speed = this.speed();
        return speed > 0 && speed < QUICK_SPEED * this.tracks[0].format.bitrate;
    }

    /** Where the video of a window ending at w ends: the end of the last segment, of the run the video track has at t,
     * that ends within the window (s; 0: none) */
    private within(w: number, t: number): number {
        var pieces = this.tracks[0].pieces;
        var at = this.tracks[0].at(t);
        var end = 0;
        for (var i = at; i >= 0 && i < pieces.length && (i === at || pieces[i].num === pieces[i - 1].num + 1) && pieces[i].endMs / 1000 <= w + 0.01; i++) {
            end = pieces[i].endMs / 1000;
        }
        return end;
    }

    /** A track's segments whose data a removal from s on takes (the video's starting there or later, the audio's ending
     * past it) are its no longer, queued or not: the server sends them again */
    private forget(track: Track, s: number): void {
        var gone: { [num: number]: boolean } = {};
        track.pieces.forEach(function (p) {
            if (track.kind === PICTURE ? p.startMs / 1000 >= s - 0.01 : p.endMs / 1000 > s + 0.01) {
                gone[p.num] = true;
            }
        });
        track.pieces = track.pieces.filter(function (p) { return !gone[p.num]; });
        track.queue = track.queue.filter(function (q) { return q.init || !gone[q.num]; });
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

    /** Moves the playhead over a small gap just before buffered data (playback stalls there) */
    private hop(): void {
        // (in a seek's window not while a buffer updates, as the length just told may make it: on at its updateend)
        if (this.pending < 0 && this.video.readyState <= 2 && this.tracks.length && !(this.landed >= 0 && this.updating())) {
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
        // (asked before its media was in: its tracks are on their way there, nothing to ask anew)
        if (this.ahead) {
            this.pump();
            return;
        }
        // (a seek's window up: the landing is where this seek goes, also a hop's or a nudge's)
        if (this.landed >= 0) {
            this.landed = this.video.currentTime;
        }
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
            // (not with a segment half in, coming by its parts: a removal then makes the TV drop the rest of it)
            if (!sb || sb.updating || track.queue.length && !track.full || !sb.buffered.length || track.streamed) {
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
        // (not while the last segment still comes in by its parts: counted from its first part, not in the queue)
        var all = this.tracks.every(function (track) { return track.doneFrom(t) && !track.queue.length && !track.streamed && !!track.sb && !track.sb.updating; });
        if (all && this.pipe && this.pipe.source.readyState === 'open') {
            this.pipe.source.endOfStream();
        }
    }
}
