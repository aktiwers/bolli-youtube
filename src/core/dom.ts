// Small DOM helpers. Elements are built once and then only updated, which
// is far cheaper on the TV than rebuilding them.

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
 * style pass instead of rebuilding the whole page. */
export function setShown(el: HTMLElement, shown: boolean): void {
    el.style.visibility = shown ? '' : 'hidden';
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
