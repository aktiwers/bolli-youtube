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
    /** Switches a format in place, about ahead s ahead of the playhead (an engine without: the player restarts) */
    switchVideo?(f: Format, ahead?: number): void;
    switchAudio?(f: Format, ahead?: number): void;
    /** The parts the player will skip (an engine may load past them) */
    skips?: () => Skip[];
    /** Buffers at most s ahead (0: as usual again): a video loaded ahead needs only what the TV decodes before its
     * first picture */
    hold(s: number): void;
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
