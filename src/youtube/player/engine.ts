// What the player's engines share (player/dash.ts for DASH, player/sabr-engine.ts
// for SABR, player/live-engine.ts for live streams): the interface the player
// uses, their common limits, where the buffered part around a time ends, and two
// Media Source fixes: a hole just ahead of a stalled playhead is hopped over, and
// a seek that sticks is nudged on.

import { Format } from '../api/streams.js';

/** What the player needs from an engine */
export interface Engine {
    /** preview: a tile's preview (an engine may then use what was fetched ahead differently) */
    load(video: Format, audio: Format, startAt: number, preview?: boolean): void;
    seek(t: number): void;
    jump(to: number, from: number): void;
    /** Where a seek not yet run goes (s; -1: none): SABR moves the playhead only once the media there is in */
    seekTarget?(): number;
    /** Stops; the pipeline is kept, paused, for the next video (player/pipeline.ts) */
    stop(): void;
    /** Takes new URLs for the playing formats (the old ones expired) and continues in place, keeping the buffer;
     * false if the formats differ (or the engine does not support it) */
    renew?(video: Format, audio: Format): boolean;
    /** Switches a format in place, about ahead s ahead of the playhead (an engine without: the player restarts);
     * soon: the video as near as the TV allows, the new format's first part fetched before the old one goes */
    switchVideo?(f: Format, ahead?: number, soon?: boolean): void;
    switchAudio?(f: Format, ahead?: number): void;
    /** The parts the player will skip (an engine may load past them) */
    skips?: () => Skip[];
    /** Told each video download's bytes and ms, where the engine fetches them itself (the connection's speed) */
    loaded?: (bytes: number, ms: number) => void;
    /** Buffers at most s ahead (0: as usual again): a video loaded ahead needs only what the TV decodes before its
     * first picture */
    hold(s: number): void;
    /** Quick jumps (Settings): a seek gets a window of its own, as a start has one (an engine without: its seeks as
     * before) */
    quick?: boolean;
    /** The video's real length (s) while the engine tells the TV a shorter one (a seek's window, a start's until its
     * picture has moved), else 0: the element's length is the window's end meanwhile */
    realLength?(): number;
}

/** A part the player will skip (s) */
export interface Skip {
    start: number;
    end: number;
}

/** Up to this much is kept ahead of the playhead and behind it (MB per track); behind, also BEHIND_S at most */
export var AHEAD_MB = 32;
export var BEHIND_MB = 16;
export var BEHIND_S = 20;
export var MB = 1024 * 1024;
/** Loading less than this far ahead of the playhead (s), AHEAD_MB holds no loading back: a dense part of a video
 * (4K: a 5 s segment of over 40 MB) plays on instead of standing at the end of what came (the buffer's own limit still
 * holds: a full append waits for a trim) */
export var ALWAYS_AHEAD_S = 6;

/** Whether a track may load more: at most most s buffered ahead, and at most AHEAD_MB unless its loading is less than
 * ALWAYS_AHEAD_S ahead of the playhead (reach, s; by default what is buffered: a hole at the playhead then counts as
 * none) */
export function roomAhead(seconds: number, bytes: number, most: number, reach?: number): boolean {
    return seconds <= most && (bytes <= AHEAD_MB * MB || (reach === undefined ? seconds : reach) < ALWAYS_AHEAD_S);
}
export var TICK_MS = 500;
/** A failed request is tried RETRIES times more, then again while at least STILL_AHEAD s are buffered ahead */
export var RETRIES = 3;
export var STILL_AHEAD = 3;
/** How long a request may take (ms) */
export var TIMEOUT_MS = 20000;
/** A start's window (the quick start): the TV is told the video ends at most this far after the start (s) until it
 * plays, as this TV's browser starts at once within 10 s of the end (else after ~3 s of fed video) */
export var WINDOW_S = 9.5;

/** Where a start's window may end (s; 0: none, for a start this near the end) */
export function windowFrom(start: number, length: number): number {
    return length - start > WINDOW_S + 1 ? start + WINDOW_S : 0;
}
/** A seek's window (quick jumps, Engine.quick): as a start's, the TV is told the video ends within WINDOW_S of where
 * the seek lands, so its engine shows the picture at once (measured on the TV, guest 4K, to the picture moving: a jump
 * into what is buffered 1.8-2.3 -> 0.45-0.55 s, one past it 2.2 -> 0.75-1.1 s, one back 1.9-2.1 -> 0.5-1 s). What is
 * buffered past the window is removed first (this TV's network keeps no media: loaded again once the window lifts),
 * so only with at least QUICK_MIN_S of video in the window, and with the last video download at least QUICK_SPEED
 * times the format's bitrate (or none of SPEED_BYTES measured yet). Then the seek, and only then the length: told
 * first, a jump back (the playhead past the new length) makes the browser hop to that end before the seek. The
 * window lifts once the picture has moved LIFT_S past the landing (LIFT_MS), or is within LIFT_END_S of the window's
 * end: at 'playing' (where a start's lifts) the TV may not have shown a frame yet and, given the real length, waits
 * its 3 s after all (one jump in three) */
export var QUICK_MIN_S = 1.5;
export var QUICK_SPEED = 1.5;
/** A seek whose window needs a removal waits for a seek in a window still on its way (a removal during a seek hangs
 * on this TV), until that one has been on its way this long (ms): measured, it ends 0.25-0.3 s after it is asked with
 * its landing buffered, 0.3-0.7 s with it fetched (guest 4K) */
export var QUICK_WAIT_MS = 1200;
export var SPEED_BYTES = 512 * 1024;
export var LIFT_S = 0.25;
export var LIFT_END_S = 0.5;
/** The element's time counts for a seek's window's lift only this long after the seek's end (ms): until then it is
 * the browser's own guess, running on from the landing at once, while the TV shows its first frame ~0.35 s after the
 * seek's end and reports its own time ~0.45-0.55 s after it (the element's time then steps back ~0.3 s). A window
 * lifted on that guess, before a frame shows, can leave the TV waiting its 3 s after all (one jump in twelve) */
export var LIFT_MS = 600;
/** A jump lands this far after the keyframe (s): inside the buffer, not just before its first frame (that seek never ends) */
export var KEYFRAME_IN = 0.05;
/** A hole this short just ahead of the playhead is hopped over (s); a seek still not done after SEEK_STUCK_MS is
 * nudged on NUDGE_S */
var HOLE_S = 1;
var SEEK_STUCK_MS = 5000;
var NUDGE_S = 0.1;

/** Where a jump from from towards to lands: the start (a keyframe, s) nearest to, beyond a second from from on that
 * side (and nearer to than within s, if given), KEYFRAME_IN into it; to itself without one */
export function jumpTarget(starts: number[], to: number, from: number, within?: number): number {
    var best = -1;
    for (var i = 0; i < starts.length; i++) {
        var s = starts[i];
        var near = Math.abs(s - to);
        if ((to > from ? s > from + 1 : s < from - 1) && (!within || near < within) && (best < 0 || near < Math.abs(best - to))) {
            best = s;
        }
    }
    return best < 0 ? to : best + KEYFRAME_IN;
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

/** Moves a stalled playhead over a short hole just before buffered data */
export function hopHole(v: HTMLVideoElement): void {
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

/** Seeks v to t; returns the timer that nudges the seek on if it is not done after SEEK_STUCK_MS */
export function seekNudged(v: HTMLVideoElement, t: number): number {
    v.currentTime = t;
    return setTimeout(function () {
        if (v.seeking) {
            v.currentTime = v.currentTime + NUDGE_S;
        }
    }, SEEK_STUCK_MS) as unknown as number;
}
