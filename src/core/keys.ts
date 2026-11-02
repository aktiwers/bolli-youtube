// Remote keys and dispatch to the active view. Codes are those of LG's webOS remote; Back needs
// "disableBackHistoryAPI" in appinfo. Google TV's remote has few keys (arrows, OK, Back), so holding OK is the
// extra: with setHoldOk(true) OK acts on release, and OK held for HOLD_MS sends KEY.HOLD (OK where unhandled).

import { noteKey } from './perf.js';

export var KEY = {
    LEFT: 37,
    UP: 38,
    RIGHT: 39,
    DOWN: 40,
    OK: 13,
    BACK: 461,
    CH_UP: 33,
    CH_DOWN: 34,
    RED: 403,
    GREEN: 404,
    YELLOW: 405,
    BLUE: 406,
    /** The number keys send 48..57 */
    NUM_0: 48,
    /** LIST, next to 0 on LG's remotes */
    LIST: 1056,
    /** GUIDE (VK_GUIDE on LG remotes) */
    GUIDE: 458,
    /** OK held down (no remote sends it: see setHoldOk) */
    HOLD: 10013,
    /** A remote's search key (sent by the Android app; Google TV keeps its
     * Assistant key to itself) */
    VOICE: 10084
};

/** The number on a number key, or -1 */
export function digit(code: number): number {
    return code >= 48 && code <= 57 ? code - 48 : -1;
}

export interface KeyHandler {
    /** Return true when the key was used */
    onKey(code: number): boolean;
}

var active: KeyHandler | null = null;
// A held arrow repeats faster than the TV can draw; drop repeats that arrive
// sooner than this after the last handled one so no backlog builds up.
var REPEAT_MS = 80;
var lastCode = -1;
var lastTime = 0;
var HOLD_MS = 500;
var holdOk = false;
var okDown = false;
var okTimer = 0;
var okHeld = false;

export function setActive(handler: KeyHandler): void {
    active = handler;
}

/** OK acts on release, and held down sends KEY.HOLD (for Google TV's remote) */
export function setHoldOk(on: boolean): void {
    holdOk = on;
    releaseOk();
}

export function initKeys(): void {
    document.addEventListener('keydown', function (e: KeyboardEvent) {
        if (down(e.keyCode)) {
            e.preventDefault();
        }
    }, true);
    document.addEventListener('keyup', function (e: KeyboardEvent) {
        if (up(e.keyCode)) {
            e.preventDefault();
        }
    }, true);
    // The Android app intercepts the remote's keys before its web view and
    // passes each one here as the codes above (android/: MainActivity)
    (window as unknown as { bolliKey?: (code: number, isUp?: boolean) => void }).bolliKey = function (code: number, isUp?: boolean) {
        if (isUp) {
            up(code);
        } else {
            down(code);
        }
    };
    // An OK release while the app is hidden never arrives
    document.addEventListener('visibilitychange', releaseOk);
}

/** Marks OK as released (cancels a pending hold) */
function releaseOk(): void {
    clearTimeout(okTimer);
    okDown = false;
}

function down(code: number): boolean {
    if (code !== KEY.OK || !holdOk) {
        return press(code);
    }
    // Auto-repeats while held are ignored until release
    if (!okDown) {
        okDown = true;
        okHeld = false;
        okTimer = setTimeout(function () {
            okHeld = true;
            if (!press(KEY.HOLD)) {
                press(KEY.OK);
            }
        }, HOLD_MS) as unknown as number;
    }
    return true;
}

function up(code: number): boolean {
    if (code !== KEY.OK || !okDown) {
        return false;
    }
    releaseOk();
    if (!okHeld) {
        press(KEY.OK);
    }
    return true;
}

/** True when the key was used (a dropped repeat counts as used) */
function press(code: number): boolean {
    var now = Date.now();
    if (code === lastCode && now - lastTime < REPEAT_MS) {
        return true;
    }
    lastCode = code;
    lastTime = now;
    var used = active ? active.onKey(code) : false;
    noteKey(code, now);
    return used;
}
