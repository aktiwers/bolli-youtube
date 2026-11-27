// Whether a picture is light where white text is drawn over it, so a dark fade goes behind the text there only (the
// player's info bar, a channel's cover) and every other picture keeps the look it has. A small copy of the picture is
// read on a canvas, from a picture asked readable (crossOrigin: i.ytimg.com and yt3.googleusercontent.com answer any
// origin, the app's file:// one too) and small, so reading it decodes next to nothing on the page's thread: for the
// player its storyboard's coarse sheets (the video itself cannot be read on the TV: it plays on a layer of its own),
// each read whole as it arrives, every frame's reading kept and the picture let go, so a key only looks one up; for a
// channel a 128 px copy of its cover, once per cover.

import { Storyboard, storyboardFrame } from '../api/streams.js';

/** Light: a part's mean brightness (0-1) at least this, or this share of its pixels at least BRIGHT */
var LIGHT = 0.5;
var BRIGHT = 0.75;
var BRIGHT_SHARE = 0.35;
/** A picture or a frame is read this many pixels wide (its height as its shape) */
var READ_WIDTH = 24;
/** The info bar covers the picture from here down (a share of its height) */
var BAR_TOP = 0.55;

var canvas: HTMLCanvasElement | null = null;
/** The canvas is read again and again: kept in memory, not on the GPU (newer Chromes warn otherwise; Chrome 38 ignores
 * it) */
var READ_OFTEN = { willReadFrequently: true };

/** The pixels of the part sx, sy, sw, sh (the picture's own pixels) of img, loaded and readable, drawn w x h (null: it
 * cannot be read: its server did not allow it) */
function pixels(img: HTMLImageElement, sx: number, sy: number, sw: number, sh: number, w: number, h: number): Uint8ClampedArray | null {
    try {
        var c = canvas || (canvas = document.createElement('canvas'));
        if (c.width !== w || c.height !== h) {
            c.width = w;
            c.height = h;
        }
        var ctx = c.getContext('2d', READ_OFTEN) as CanvasRenderingContext2D;
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
        return ctx.getImageData(0, 0, w, h).data;
    } catch (e) {
        return null;
    }
}

/** Whether the rows y0 to y1 and columns x0 to x1 of pixels d (width wide) are light */
function lightAt(d: Uint8ClampedArray, width: number, x0: number, y0: number, x1: number, y1: number): boolean {
    var sum = 0;
    var bright = 0;
    for (var y = y0; y < y1; y++) {
        for (var x = x0; x < x1; x++) {
            var i = (y * width + x) * 4;
            var l = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
            sum += l;
            if (l >= BRIGHT) {
                bright++;
            }
        }
    }
    var n = Math.max(1, (x1 - x0) * (y1 - y0));
    return sum / n >= LIGHT || bright / n >= BRIGHT_SHARE;
}

/** A cover's box (object-fit: cover, centred) and the part of it read (where the text is), in layout units */
export interface CoverBox {
    w: number;
    h: number;
    x: number;
    y: number;
    readW: number;
    readH: number;
}

/** Each banner's reading, by its address */
var covers: { [url: string]: boolean | null } = {};

/** Whether the banner at url, drawn to cover box, is light in its part read: done(true / false), or done(null) where it
 * cannot be told. Read from a small copy of it (YouTube's picture server makes one 128 px wide, a few KB: the shown
 * one, 1280 px, would be decoded anew on the page's thread to be read), once per banner; at once when known */
export function bannerLight(url: string, box: CoverBox, done: (light: boolean | null) => void): void {
    if (url in covers) {
        done(covers[url]);
        return;
    }
    var small = /=w\d+/.test(url) ? url.replace(/=w\d+/, '=w128') : '';
    if (!small) {
        covers[url] = null;
        done(null);
        return;
    }
    var img = new Image();
    img.onload = img.onerror = function () {
        var nw = img.naturalWidth;
        var nh = img.naturalHeight;
        var light: boolean | null = null;
        if (nw && nh) {
            var scale = Math.max(box.w / nw, box.h / nh);
            var h = Math.max(1, Math.round(READ_WIDTH * box.readH / box.readW));
            var d = pixels(img, (box.x - (box.w - nw * scale) / 2) / scale, (box.y - (box.h - nh * scale) / 2) / scale, box.readW / scale,
                box.readH / scale, READ_WIDTH, h);
            light = d ? lightAt(d, READ_WIDTH, 0, 0, READ_WIDTH, h) : null;
        }
        covers[url] = light;
        done(light);
    };
    img.crossOrigin = 'anonymous';
    img.src = small;
}

/** Each frame's reading (by sheet and place) for the storyboard read; the sheet being read, and who waits for it */
var known: { [frame: string]: boolean | null } = {};
var knownOf = '';
var reading = '';
var waiting: (() => void)[] = [];
/** The sheet's picture while it loads (one no longer wanted is stopped: the seek's own media comes first) */
var loadingImg: HTMLImageElement | null = null;

/** Whether the video sb is the storyboard of is light at t (s) where the info bar covers it: done(true / false), or
 * done(null) where it cannot be told (no storyboard: a live stream; a sheet that did not come). At once when known */
export function frameLight(sb: Storyboard | null, t: number, done: (light: boolean | null) => void): void {
    var level = sb ? sb.coarse || sb : null;
    if (!level) {
        done(null);
        return;
    }
    if (knownOf !== level.base + level.name) {
        known = {};
        knownOf = level.base + level.name;
    }
    var f = storyboardFrame(level, t);
    var key = f.col + ',' + f.row + ' ' + f.url;
    if (key in known) {
        done(known[key]);
        return;
    }
    if (reading !== f.url) {
        reading = f.url;
        waiting = [];
        readSheet(level, f.url);
    }
    waiting.push(function () { done(key in known ? known[key] : null); });
}

/** Every frame of level's sheet at url read at once (one drawing of the whole sheet, small): the readings kept, the
 * picture let go, those waiting told */
function readSheet(level: Storyboard, url: string): void {
    if (loadingImg) {
        loadingImg.onload = loadingImg.onerror = null;
        loadingImg.removeAttribute('src');
    }
    var img = loadingImg = new Image();
    img.onload = img.onerror = function () {
        img.onload = img.onerror = null;
        loadingImg = null;
        var fh = Math.max(2, Math.round(READ_WIDTH * level.h / level.w));
        var width = level.cols * READ_WIDTH;
        var d = img.naturalWidth ? pixels(img, 0, 0, level.cols * level.w, level.rows * level.h, width, level.rows * fh) : null;
        var top = Math.round(fh * BAR_TOP);
        for (var row = 0; row < level.rows; row++) {
            for (var col = 0; col < level.cols; col++) {
                known[col + ',' + row + ' ' + url] = d ? lightAt(d, width, col * READ_WIDTH, row * fh + top, (col + 1) * READ_WIDTH, (row + 1) * fh) : null;
            }
        }
        reading = '';
        var told = waiting;
        waiting = [];
        for (var i = 0; i < told.length; i++) {
            told[i]();
        }
    };
    img.crossOrigin = 'anonymous';
    img.src = url;
}
