// Where Left/Right presses aim a jump (the player runs it at once, a held key's once its repeats stop): single
// presses add up 10 s each; holding the key, as in YouTube's player, jumps further the longer it is held; a quick
// second press goes to the next or previous chapter instead, and each further press as quick to another.

import { Chapter } from '../api/watch.js';
import { chapterJump } from './bar-marks.js';

/** Holding Left/Right (the remote repeats every ~120 ms after ~560 ms; a press the same way within HOLD_GAP_MS
 * continues the hold, as a busy TV delivers the repeats unevenly): the jump doubles every HOLD_DOUBLE_MS once held
 * HOLD_GROW_MS, up to HOLD_MOST of the video. Single presses stay the same. */
var HOLD_GAP_MS = 350;
/** A held key's jump is made once its repeats stop this long (ms; longer than a gap within the hold) */
export var HOLD_REST_MS = HOLD_GAP_MS + 50;
/** A second press this soon after a first one jumps to the next or previous chapter instead (and each further press
 * as quick, another chapter) */
var DOUBLE_MS = 350;
/** A press is a first one only this long after the press before: a held key starts repeating after ~0.5 s */
var FRESH_MS = 700;
var HOLD_GROW_MS = 1000;
var HOLD_DOUBLE_MS = 1500;
var HOLD_MOST = 0.04;

/** The presses so far: the last one's time, direction (s) and gap to the one before; when the hold began; whether
 * presses are jumping chapter by chapter (a double press began it), where the first press of a run jumped from, and
 * whether the last press is a held key's repeat (its jump waits until the repeats stop) */
export interface Presses {
    at: number;
    by: number;
    gap: number;
    heldSince: number;
    chapterRun: boolean;
    firstFrom: number;
    held: boolean;
}

export function noPresses(): Presses {
    return { at: 0, by: 0, gap: 0, heldSince: 0, chapterRun: false, firstFrom: 0, held: false };
}

/** Where a press of seconds (-10: Left, 10: Right) at now aims, from the jump pending (pending; -1: none) or the
 * playhead (at), within the video's window w (s); chapters: the video's, if known. Updates p. */
export function pressAim(p: Presses, seconds: number, now: number, at: number, pending: number, w: { from: number; to: number },
    chapters: Chapter[] | null): number {
    var gap = now - p.at;
    var same = seconds * p.by > 0;
    var to = same && gap < DOUBLE_MS && (p.chapterRun || p.gap >= FRESH_MS) && chapters ?
        chapterJump(chapters, p.chapterRun ? pending : p.firstFrom, seconds) : -1;
    var fresh = !same || gap >= HOLD_GAP_MS;
    p.at = now;
    p.gap = gap;
    p.chapterRun = to >= 0;
    p.held = to < 0 && !fresh;
    if (to >= 0) {
        return Math.min(w.to - 1, to);
    }
    if (fresh) {
        p.heldSince = now;
    }
    p.by = seconds;
    var grow = Math.pow(2, Math.max(0, now - p.heldSince - HOLD_GROW_MS) / HOLD_DOUBLE_MS);
    var step = Math.round(Math.min(Math.abs(seconds) * grow, Math.max(Math.abs(seconds), (w.to - w.from) * HOLD_MOST)));
    var from = pending >= 0 ? pending : at;
    p.firstFrom = from;
    return Math.max(w.from, Math.min(w.to - 1, from + (seconds < 0 ? -step : step)));
}
