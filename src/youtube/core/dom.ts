// Small DOM helpers. Elements are built once and then only updated, which
// is far cheaper on the TV than rebuilding them.

import { load, save } from './store.js';

export function h(tag: string, className?: string, text?: string): HTMLElement {
    var el = document.createElement(tag);
    if (className) {
        el.className = className;
    }
    if (text) {
        el.textContent = text;
    }
    return el;
}

/** Set text only when it changed (avoids needless style and layout work) */
export function setText(el: HTMLElement, text: string): void {
    if (el.textContent !== text) {
        el.textContent = text;
    }
}

/** Set the class name only when it changed (an unchanged write still costs a style check) */
export function setClass(el: HTMLElement, cls: string): void {
    if (el.className !== cls) {
        el.className = cls;
    }
}

/** Add or remove one modifier class */
export function toggleClass(el: HTMLElement, name: string, on: boolean): void {
    var has = (' ' + el.className + ' ').indexOf(' ' + name + ' ') !== -1;
    if (on && !has) {
        el.className += ' ' + name;
    } else if (!on && has) {
        el.className = (' ' + el.className + ' ').replace(' ' + name + ' ', ' ').replace(/^\s+|\s+$/g, '');
    }
}

/** Show or hide a screen. visibility (not display) keeps its layout and
 * decoded images, so coming back to it (Back, a section switch) costs one
 * style pass instead of rebuilding the whole page. Written only when it
 * changes: the TV restyles an element at any write to its style, the same
 * value too (Settings' colour picker ticks its 112 tiles at every arrow:
 * 112 elements restyled each time, 2026-11-16). */
export function setShown(el: HTMLElement, shown: boolean): void {
    var to = shown ? '' : 'hidden';
    if (el.style.visibility !== to) {
        el.style.visibility = to;
    }
}

/** Puts a screen out of sight while it stays drawn (by: true), or back in its place: the stylesheet's by-standby moves
 * it below the screen's foot. What is drawn there keeps its layers and its decoded pictures, so back in place it
 * shows at the next frame with nothing drawn anew (hidden and shown again, the TV draws a screen of tiles in
 * 0.3-0.6 s). */
export function standsBy(el: HTMLElement, by: boolean): void {
    toggleClass(el, 'by-standby', by);
}

/** Whether el stands by (standsBy) */
export function isStandingBy(el: HTMLElement): boolean {
    return (' ' + el.className + ' ').indexOf(' by-standby ') >= 0;
}

/** How far to scroll list (in a view this tall) to keep el centred, clamped at both ends (-1: not laid out yet) */
export function centred(list: HTMLElement, view: number, el: HTMLElement): number {
    return view ? Math.max(0, Math.min(list.offsetHeight - view, el.offsetTop + el.offsetHeight / 2 - view / 2)) : -1;
}

/** Scrolls list (in a view this tall) to keep el centred, as centred() says (not laid out: left as it was); the
 * offset it is scrolled by now (was: before) */
export function keepCentred(list: HTMLElement, view: number, el: HTMLElement, was: number): number {
    var to = centred(list, view, el);
    if (to < 0 || to === was) {
        return was;
    }
    translate(list, 0, -to);
    return to;
}

/** Move an element as a composited layer (no layout) */
export function translate(el: HTMLElement, x: number, y: number): void {
    el.style.webkitTransform = 'translate3d(' + x + 'px,' + y + 'px,0)';
}

/** Set an image source only when it changed (a bd-fade image fades in again) */
export function setSrc(img: HTMLImageElement, src: string): void {
    if (!src) {
        img.style.visibility = 'hidden';
        return;
    }
    img.style.visibility = '';
    if (img.getAttribute('src') !== src) {
        toggleClass(img, 'bd-fade--in', false);
        img.src = src;
    }
}

/** A loaded picture this narrow is a stand-in: i.ytimg answers a size a video lacks with a 120x90 picture and a
 * 404, which this browser shows as loaded, without an error */
var STAND_IN_WIDTH = 120;
/** Pictures that came as stand-ins: their fallback is asked at once. Kept across starts (MISSING_KEY, the latest
 * MISSING_MAX), so each costs one failed request on this TV, not one each start (seen in the logs, 2026-11-17: the same
 * thumbnails' 404s after a relaunch); read the first time a picture is drawn, written once things rest after a new one */
var missing: { [src: string]: boolean } | null = null;
var missingOrder: string[] = [];
var MISSING_KEY = 'youtube.missingPictures';
var MISSING_MAX = 300;
var MISSING_SAVE_MS = 2000;
var missingTimer = 0;

/** The pictures known to come as stand-ins, read from where they are kept the first time */
function missingMap(): { [src: string]: boolean } {
    if (!missing) {
        missing = {};
        var kept = load<string[]>(MISSING_KEY);
        // (kept as saved: never more than MISSING_MAX)
        missingOrder = Array.isArray(kept) ? kept : [];
        for (var i = 0; i < missingOrder.length; i++) {
            missing[missingOrder[i]] = true;
        }
    }
    return missing;
}

/** Whether src is known to come as a stand-in */
function isMissing(src: string): boolean {
    return !!missingMap()[src];
}

/** src came as a stand-in: remembered, and kept once things rest */
function noteMissing(src: string): void {
    var map = missingMap();
    if (map[src]) {
        return;
    }
    map[src] = true;
    missingOrder.push(src);
    if (missingOrder.length > MISSING_MAX) {
        delete map[missingOrder.shift() as string];
    }
    clearTimeout(missingTimer);
    missingTimer = setTimeout(function () { save(MISSING_KEY, missingOrder); }, MISSING_SAVE_MS) as unknown as number;
}

/** Shows src in img, or fallback once src fails or comes as a stand-in (at once when it did before). Every picture
 * with a fallback goes through here; without one, src as it is. */
export function setPicture(img: HTMLImageElement, src: string, fallback?: string): void {
    var other = fallback && fallback !== src ? fallback : '';
    // (one hidden while it fell back before: seen again as this picture comes)
    if (img.style.opacity === '0') {
        img.style.opacity = '';
    }
    img.onerror = other ? function () { fallBack(img, src, other, false); } : null;
    img.onload = other ? function () {
        if (img.naturalWidth <= STAND_IN_WIDTH) {
            fallBack(img, src, other, true);
        } else if (img.style.opacity === '0') {
            img.style.opacity = '';
        }
    } : null;
    img.src = other && isMissing(src) ? other : src;
}

/** The first of srcs that loads as a real picture (one that fails or comes as a stand-in is remembered as setPicture
 * does, and the next tried; one known missing is skipped), given to got; none: got is not called */
export function firstPicture(srcs: string[], got: (img: HTMLImageElement, src: string) => void): void {
    var left = srcs.filter(function (src) { return !isMissing(src); });
    if (!left.length) {
        return;
    }
    var img = new Image();
    var src = left[0];
    var next = function (): void {
        firstPicture(left.slice(1), got);
    };
    // (a failure may pass: only a stand-in is remembered, as setPicture does)
    img.onerror = next;
    img.onload = function () {
        if (img.naturalWidth <= STAND_IN_WIDTH) {
            noteMissing(src);
            next();
        } else {
            got(img, src);
        }
    };
    img.src = src;
}

/** Puts other in img where src still shows; a stand-in is remembered (a failure may pass, so src is tried again) */
function fallBack(img: HTMLImageElement, src: string, other: string, standIn: boolean): void {
    if (img.getAttribute('src') === src) {
        if (standIn) {
            noteMissing(src);
        }
        // Hidden until the fallback loads (the stand-in, YouTube's grey "no picture", would show meanwhile): a tile's by its
        // fade, any other picture (the player's start picture: seen on the TV 2026-11-17) by its opacity
        toggleClass(img, 'bd-fade--in', false);
        img.style.opacity = '0';
        img.src = other;
    }
}

/** Remove the image sources under root to free their decoded bitmaps, which
 * are most of the app's memory (e.g. while a full-screen player covers it).
 * restoreImages puts them back. keep: images to leave as they are. */
export function releaseImages(root: HTMLElement, keep?: Element[]): void {
    var imgs = root.getElementsByTagName('img');
    for (var i = 0; i < imgs.length; i++) {
        var src = imgs[i].getAttribute('src');
        if (src && !(keep && keep.indexOf(imgs[i]) >= 0)) {
            imgs[i].setAttribute('data-src', src);
            imgs[i].removeAttribute('src');
        }
    }
}

/** The images under root that are on screen now and have a source */
export function imagesInSight(root: HTMLElement): Element[] {
    return [].filter.call(root.getElementsByTagName('img'), function (img: HTMLImageElement) {
        if (!img.getAttribute('src')) {
            return false;
        }
        var r = img.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < LAYOUT_WIDTH && r.top < LAYOUT_HEIGHT;
    });
}

export function restoreImages(root: HTMLElement): void {
    var imgs = root.querySelectorAll('img[data-src]');
    for (var i = 0; i < imgs.length; i++) {
        var img = imgs[i] as HTMLImageElement;
        if (!img.getAttribute('src')) {
            img.setAttribute('src', img.getAttribute('data-src') as string);
        }
        img.removeAttribute('data-src');
    }
}

/** Run fn once the window has loaded (at once if it has). Requests made before
 * load delay it, and webOS shows an app only after load. */
export function whenLoaded(fn: () => void): void {
    if (document.readyState === 'complete') {
        fn();
    } else {
        window.addEventListener('load', function () { fn(); });
    }
}

/** Images with the class bd-fade fade in once loaded instead of popping in.
 * One listener for the whole app: load does not bubble, but it passes the
 * document on the way down (capture), so no image needs its own handler. */
export function fadeInImages(): void {
    document.addEventListener('load', function (e) {
        var el = e.target as HTMLElement;
        if (el.tagName === 'IMG' && (' ' + el.className + ' ').indexOf(' bd-fade ') !== -1) {
            toggleClass(el, 'bd-fade--in', true);
        }
    }, true);
}

/** Layout is written in 1280x720 units; index.html zooms it to the viewport */
export var LAYOUT_WIDTH = 1280;
export var LAYOUT_HEIGHT = 720;

/** Images are requested at this factor so they stay sharp */
export function uiScale(): number {
    return Math.max(1, window.innerWidth / LAYOUT_WIDTH);
}

/** A pixel size from the 1280 layout, as the image size to request */
export function px(size: number): number {
    return Math.round(size * uiScale());
}
