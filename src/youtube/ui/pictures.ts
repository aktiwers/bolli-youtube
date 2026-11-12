// Pictures from web addresses for the logos (ui/logo.ts: the account's; ui/custom-logos.ts: the viewer's own):
// downloaded in the background within a time and a size, checked to be a PNG, JPEG or WebP the engine shows, and
// handed on as a data URL with the decoded picture, so nothing is asked of the address again and it is decoded once.
// A picture bigger than it is drawn is redrawn smaller on a canvas (in halves, so it stays smooth) before it is
// kept; the home screen's icons are drawn here too (squares).

import { getBytes } from '../core/http.js';
import { oldEngine } from '../core/platform.js';

/** The download's limits: its time (the decode's check included) and its size */
export var TIME_MS = 10000;
export var MAX_BYTES = 2 * 1024 * 1024;
/** Why a picture was not taken (the rejection's message): its address holds no PNG, JPEG or WebP picture the engine
 * shows (a page, another file); it is over MAX_BYTES; anything else (no answer, slow) has another text */
export var NOT_PICTURE = 'not a picture';
export var TOO_BIG = 'too big';

/** A picture as downloaded: its data URL ('': only its address is known to load) and the decoded picture */
export interface Fetched {
    data: string;
    img: HTMLImageElement;
}

/** Resolves with the picture at src once the engine has decoded it, rejects if it cannot */
export function loaded(src: string): Promise<HTMLImageElement> {
    return new Promise<HTMLImageElement>(function (resolve, reject) {
        var img = new Image();
        img.onload = function () {
            if (img.naturalWidth > 0) {
                resolve(img);
            } else {
                reject(new Error('empty'));
            }
        };
        img.onerror = function () { reject(new Error('no picture')); };
        img.src = src;
    });
}

/** The bytes as a data URL if they are a PNG, JPEG or WebP (WebP not on the old engine), else '' */
export function dataUrl(b: Uint8Array): string {
    var type = b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 ? 'png' :
        b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff ? 'jpeg' :
        !oldEngine() && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP' ? 'webp' : '';
    if (!type) {
        return '';
    }
    // (in parts: one call with every byte overflows the stack)
    var binary = '';
    for (var i = 0; i < b.length; i += 8192) {
        binary += String.fromCharCode.apply(null, Array.prototype.slice.call(b, i, i + 8192) as number[]);
    }
    return 'data:image/' + type + ';base64,' + btoa(binary);
}

function ascii(b: Uint8Array, from: number, to: number): string {
    var s = '';
    for (var i = from; i < to && i < b.length; i++) {
        s += String.fromCharCode(b[i]);
    }
    return s;
}

/** Downloads the picture at url (in the background: at most TIME_MS and MAX_BYTES) and checks that the engine shows
 * it; resolves with it as a data URL, or with data '' when orAddress and the host refuses the app a read of the bytes
 * but the picture loads by its address. Rejects with NOT_PICTURE when the address holds no picture the engine shows
 * (a page, another kind of file), TOO_BIG over the size, another message when slow or failed. */
export function fetchPicture(url: string, orAddress: boolean): Promise<Fetched> {
    return new Promise<Fetched>(function (resolve, reject) {
        var done = false;
        var end = function (got: Fetched | null, why?: string) {
            if (done) {
                return;
            }
            done = true;
            clearTimeout(timer);
            if (got) {
                resolve(got);
            } else {
                reject(new Error(why || 'no picture'));
            }
        };
        var timer = setTimeout(function () { end(null); }, TIME_MS);
        var fail = function () { end(null); };
        var notPicture = function () { end(null, NOT_PICTURE); };
        getBytes(url, TIME_MS, MAX_BYTES).then(function (bytes) {
            var data = dataUrl(new Uint8Array(bytes));
            if (!data) {
                notPicture();
                return;
            }
            loaded(data).then(function (img) { end({ data: data, img: img }); }, notPicture);
        }, function (e: { status: number; message: string }) {
            // No answer at all, as when the host refuses the app a read (or is down): by its address if it loads there
            if (orAddress && e && e.status === 0 && e.message === 'network error') {
                loaded(url).then(function (img) { end({ data: '', img: img }); }, fail);
            } else {
                end(null, e && e.message === 'too big' ? TOO_BIG : undefined);
            }
        });
    });
}

/** The picture drawn w x h on a new canvas: through halves while it is more than twice that size (one step from big
 * to small is rough) */
export function drawn(img: HTMLImageElement, w: number, h: number): HTMLCanvasElement {
    var source: HTMLImageElement | HTMLCanvasElement = img;
    var sw = img.naturalWidth;
    var sh = img.naturalHeight;
    while (sw > w * 2 && sh > h * 2) {
        sw = Math.ceil(sw / 2);
        sh = Math.ceil(sh / 2);
        source = onCanvas(source, sw, sh);
    }
    return onCanvas(source, w, h);
}

function onCanvas(source: HTMLImageElement | HTMLCanvasElement, w: number, h: number): HTMLCanvasElement {
    var canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    (canvas.getContext('2d') as CanvasRenderingContext2D).drawImage(source, 0, 0, w, h);
    return canvas;
}

/** The picture made to fit a box of w x h, never enlarged, as a data URL: its own (data) when it fits, else redrawn
 * smaller (a JPEG as a JPEG, any other as a PNG, which keeps what is clear); its own where the engine cannot redraw
 * it */
export function fitted(got: Fetched, w: number, h: number): string {
    var img = got.img;
    var k = Math.min(w / img.naturalWidth, h / img.naturalHeight);
    if (k >= 1) {
        return got.data;
    }
    try {
        var canvas = drawn(img, Math.max(1, Math.round(img.naturalWidth * k)), Math.max(1, Math.round(img.naturalHeight * k)));
        var out = got.data.indexOf('data:image/jpeg') === 0 ? canvas.toDataURL('image/jpeg', 0.9) : canvas.toDataURL('image/png');
        return out.indexOf('data:image/') === 0 ? out : got.data;
    } catch (e) {
        return got.data;
    }
}

/** The picture drawn into a square of each size (px), fitted into the square's inner box and centred on a clear
 * ground: the PNGs as base64, in the sizes' order. Throws where the engine cannot draw or export it. */
export function squares(img: HTMLImageElement, sizes: { px: number; inner: number }[]): string[] {
    return sizes.map(function (size) {
        var canvas = document.createElement('canvas');
        canvas.width = canvas.height = size.px;
        var k = Math.min(size.inner / img.naturalWidth, size.inner / img.naturalHeight);
        var w = Math.max(1, Math.round(img.naturalWidth * k));
        var h = Math.max(1, Math.round(img.naturalHeight * k));
        (canvas.getContext('2d') as CanvasRenderingContext2D).drawImage(drawn(img, w, h), Math.round((size.px - w) / 2), Math.round((size.px - h) / 2));
        return canvas.toDataURL('image/png').split(',')[1];
    });
}
