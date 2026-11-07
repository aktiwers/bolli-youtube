// The Magic Remote's pointer (webOS), as YouTube's TV app takes it there (its code, LG's page with
// supports_pointer_remote, run with a mouse to compare): hovering only highlights (CSS :hover under bd-pointer, on
// <html> while the pointer shows; the keys' focus stays where it is); a click is OK on what is under the pointer, on
// release (held HOLD_MS: the long press, KEY.HOLD, as OK held); the wheel is Up or Down on the focused item wherever
// the pointer is (sideways too, one step per WHEEL_MS); nothing scrolls by itself and there are no buttons of the
// pointer's own. What can be clicked says how it takes the focus (takesPointer): each container from the clicked
// element up, innermost first (a tile in a row in a screen); then the key is pressed as the remote's. While a dialog,
// panel or menu is open, its clicks go to it alone and one beside it is Back (as over YouTube's layer behind its
// panels). The mouse events themselves stay swallowed (platform.ts ignorePointer); not used on Android.

import { toggleClass, uiScale } from './dom.js';
import { KEY } from './keys.js';

/** How a container took the focus to a clicked element in it */
export interface Taken {
    /** Puts the focus back as it was: the innermost one's makes the click act in place, all put back after it (a tile:
     * YouTube's opens without the keys' focus moving, its long press too) */
    undo?: () => void;
    /** The key the click then presses (innermost's; default OK, held: KEY.HOLD; 0: none, e.g. a chapter's first click
     * only picks it) */
    key?: number;
}

/** Takes the focus to target, inside the container it was given for (null: nothing there to act on); under: what took
 * it inside this container (null: nothing, this is the innermost; a container's part moves nothing for a click on its
 * empty space: toPart) */
export type Taker = (target: HTMLElement, under: Taken | null) => Taken | null;

/** What is open on top (a dialog, a panel, a menu): its clicks go to what is in el alone; a click beside it is Back,
 * or beside (the open rail: closed, into the screen) */
export interface Layer {
    el: HTMLElement;
    beside?: () => void;
}

/** A press that drags: the pointer's moves (x in layout units, as getBoundingClientRect gives them here) and its
 * release go here, no key (a progress bar) */
export interface Drag {
    move: (x: number) => void;
    end: () => void;
}

var HOLD_MS = 500;
var WHEEL_MS = 100;
/** The pointer's moves are passed on at most this often (they keep the player's info shown: timers of seconds) */
var MOVE_MS = 250;
var POINTER_CLASS = 'bd-pointer';

/** Gives el's clicks to take (replacing any before) */
export function takesPointer(el: HTMLElement, take: Taker): void {
    (el as unknown as { bdTake?: Taker }).bdTake = take;
}

/** A press on el drags (start: at x, in layout units; null: not now, a click as usual) */
export function dragsPointer(el: HTMLElement, start: (x: number) => Drag | null): void {
    (el as unknown as { bdDrag?: (x: number) => Drag | null }).bdDrag = start;
}

/** A container's part taking a click in it: go(to) there, go(was) back after a click that acts in place; only once
 * what is inside took it (under; on the part's empty space nothing moves); itself: the part is what was clicked (a back
 * arrow, a description), pressed as it is */
export function toPart<P>(under: Taken | null, go: (part: P) => void, was: P, to: P, itself?: boolean): Taken | null {
    if (!under && !itself) {
        return null;
    }
    if (to === was) {
        return {};
    }
    go(to);
    return itself ? {} : { undo: function () { go(was); } };
}

/** Which of list (by their el; missing ones skipped) holds target (-1: none) */
export function holding(list: ({ el: HTMLElement } | null | undefined)[], target: HTMLElement): number {
    for (var i = 0; i < list.length; i++) {
        var item = list[i];
        if (item && item.el.contains(target)) {
            return i;
        }
    }
    return -1;
}

var movers: (() => void)[] = [];
/** What waits for the click acting now to put the focus back (null: no click acting) */
var settling: (() => void)[] | null = null;

/** Runs done once the click acting now (its key pressed) has put the focus back, else at once: what depends on where the
 * keys' focus is (fresh rows swapped in around it) is not misled by a tile opened in place */
export function afterClick(done: () => void): void {
    if (settling) {
        settling.push(done);
    } else {
        done();
    }
}

/** Called as the pointer moves, at most every MOVE_MS (the player keeps its info shown a while longer) */
export function onPointerMove(moved: () => void): void {
    movers.push(moved);
}

/** Takes the pointer's events: press handles a key as the remote's (main.ts pressKey); open: what is open on top (null:
 * nothing); drawn: redraws what has the focus after a click that pressed no key (a key's press does that) */
export function initPointer(press: (code: number) => boolean, open: () => Layer | null, drawn: () => void): void {
    var root = document.documentElement;
    // index.html zooms the 1280x720 layout to the screen: the events' x is the screen's, the boxes' the layout's
    var zoom = uiScale();
    var shown = false;
    /** What a press went down on (null: none, or taken by a drag or a long press) */
    var down: HTMLElement | null = null;
    var drag: Drag | null = null;
    var holdTimer = 0;
    var wheelAt = 0;
    var movedAt = 0;
    var show = function (on: boolean): void {
        if (on !== shown) {
            shown = on;
            toggleClass(root, POINTER_CLASS, on);
        }
    };
    // A press given up without its release (a key, the pointer or the app hidden): no long press; a drag ends there
    var drop = function (): void {
        clearTimeout(holdTimer);
        down = null;
        if (drag) {
            var ending = drag;
            drag = null;
            ending.end();
        }
    };
    // The containers from target up take the focus to it, innermost first, up to the open layer (beside it: its way,
    // else Back): the innermost's Taken and every undo (null: nothing there to act on, nothing moved)
    var take = function (target: HTMLElement): { taken: Taken; undos: (() => void)[] } | null {
        var top = open();
        if (top && !top.el.contains(target)) {
            if (top.beside) {
                top.beside();
                return { taken: { key: 0 }, undos: [] };
            }
            return { taken: { key: KEY.BACK }, undos: [] };
        }
        var first: Taken | null = null;
        var undos: (() => void)[] = [];
        for (var el: HTMLElement | null = target; el; el = top && el === top.el ? null : el.parentElement) {
            var taker = (el as unknown as { bdTake?: Taker }).bdTake;
            if (!taker) {
                continue;
            }
            var taken = taker(target, first);
            if (!taken) {
                if (!first) {
                    return null;
                }
                continue;
            }
            first = first || taken;
            if (taken.undo) {
                undos.push(taken.undo);
            }
        }
        return first ? { taken: first, undos: undos } : null;
    };
    // Its key pressed, then the focus put back (outer first) after a click that acts in place, then what waited for that
    // (afterClick)
    var act = function (got: { taken: Taken; undos: (() => void)[] }, held: boolean): void {
        var key = got.taken.key === undefined ? (held ? KEY.HOLD : KEY.OK) : got.taken.key;
        var waiting: (() => void)[] = settling = [];
        try {
            if (key) {
                press(key);
            } else {
                drawn();
            }
            if (got.taken.undo) {
                for (var i = got.undos.length - 1; i >= 0; i--) {
                    got.undos[i]();
                }
            }
        } finally {
            settling = null;
            for (var j = 0; j < waiting.length; j++) {
                waiting[j]();
            }
        }
    };
    document.addEventListener('mousemove', function (e: MouseEvent) {
        show(true);
        if (drag) {
            drag.move(e.clientX / zoom);
        }
        var now = Date.now();
        if (now - movedAt >= MOVE_MS) {
            movedAt = now;
            for (var i = 0; i < movers.length; i++) {
                movers[i]();
            }
        }
    }, true);
    document.addEventListener('mousedown', function (e: MouseEvent) {
        show(true);
        drop();
        if (e.button !== 0) {
            return;
        }
        var target = e.target as HTMLElement;
        // A bar drags from the press (no wait for a hold; nothing takes the focus before the release otherwise); not
        // beside an open layer (a click there is Back)
        var top = open();
        for (var el: HTMLElement | null = top && !top.el.contains(target) ? null : target; el && !drag; el = el.parentElement) {
            var start = (el as unknown as { bdDrag?: (x: number) => Drag | null }).bdDrag;
            drag = start ? start(e.clientX / zoom) : null;
        }
        if (drag) {
            return;
        }
        down = target;
        holdTimer = setTimeout(function () {
            var held = down;
            down = null;
            var got = held && take(held);
            if (got) {
                act(got, true);
            }
        }, HOLD_MS) as unknown as number;
    }, true);
    document.addEventListener('mouseup', function (e: MouseEvent) {
        clearTimeout(holdTimer);
        if (drag) {
            drop();
            return;
        }
        var pressed = down;
        down = null;
        if (!pressed || e.button !== 0) {
            return;
        }
        // On release, on what is under the pointer then (as YouTube's: the press and release may be apart)
        var got = take(e.target as HTMLElement);
        if (got) {
            act(got, false);
        }
    }, true);
    var wheel = function (e: Event): void {
        var w = e as WheelEvent & { wheelDelta?: number };
        // (mousewheel: wheelDelta, up positive; wheel: deltaY, down positive; sideways counts as down or up)
        var delta = w.deltaY || w.deltaX || -(w.wheelDelta || 0);
        var now = Date.now();
        if (!delta || drag || now - wheelAt < WHEEL_MS) {
            return;
        }
        wheelAt = now;
        show(true);
        press(delta > 0 ? KEY.DOWN : KEY.UP);
    };
    document.addEventListener('mousewheel', wheel, true);
    document.addEventListener('wheel', wheel, true);
    // webOS hides the pointer after an arrow key or a rest: the highlight goes with it (else it stays where the
    // pointer was last); its keys for that (webOS 1) are not the app's (this listener comes before keys.ts's)
    document.addEventListener('cursorStateChange', function (e: Event) {
        var detail = (e as CustomEvent).detail;
        var on = !!(detail && detail.visibility);
        if (!on) {
            drop();
        }
        show(on);
    }, false);
    document.addEventListener('keydown', function (e: KeyboardEvent) {
        if (e.keyCode === 1536 || e.keyCode === 1537) {
            e.stopImmediatePropagation();
            e.preventDefault();
            show(e.keyCode === 1536);
        }
        drop();
    }, true);
    document.addEventListener('visibilitychange', function () {
        if (document.hidden) {
            drop();
        }
    }, false);
}
