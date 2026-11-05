// The seek preview: while a jump is pending, the frame where it lands, in a
// box above that place on the bar, with its time under it. The frames come
// from YouTube's storyboard (sheets of small frames: api/streams.ts). A new
// frame shows once its sheet has loaded (until then the coarse level's frame
// there, whose sheets cover far more and come first, else the one before
// stays), so the box never shows a frame of another place. The previews of
// both bars share one set of sheets: the last few are kept, one loads at a
// time (while a key is held, those of the latest frame asked for load next,
// not every one passed), and the ones around the playhead are fetched ahead,
// so the box shows at once.

import { h, setText, toggleClass, translate } from '../../core/dom.js';
import { clock } from '../../core/time.js';
import { dots } from '../api/feed.js';
import { sheetSeconds, Storyboard, StoryboardFrame, storyboardFrame } from '../api/streams.js';

/** The frame's height in the box (layout px), about the size YouTube's TV app draws its frames; its width follows their shape */
var HEIGHT = 104;
/** Sheets kept loaded: a 5x5 sheet of 179x90 frames is ~1.6 MB decoded (a coarse 10x10 one of 80x45 ~1.4 MB) */
var KEPT = 5;
/** A sheet not come in this long (its request hangs) is given up as one that failed, so the next ones load */
var SHEET_MS = 10000;

interface Sheet {
    url: string;
    /** null: asked for, not loading yet */
    img: HTMLImageElement | null;
    ready: boolean;
}

/** The storyboard whose sheets are kept, its sheets (the latest last), the one loading, those the latest frame shown
 * waits for (loaded next) and those fetched ahead (then) */
var board: Storyboard | null = null;
var sheets: Sheet[] = [];
var loading: Sheet | null = null;
var next: string[] = [];
var ahead: string[] = [];
/** The previews told when a sheet arrives */
var previews: SeekPreview[] = [];

function sameBoard(a: Storyboard | null, b: Storyboard | null): boolean {
    return !!a && !!b && a.base === b.base && a.level === b.level && a.name === b.name && a.sigh === b.sigh;
}

/** url's sheet, kept as the latest */
function sheetFor(url: string): Sheet {
    var had = sheets.filter(function (s) { return s.url === url; })[0];
    if (had) {
        sheets.splice(sheets.indexOf(had), 1);
        sheets.push(had);
        return had;
    }
    var sheet: Sheet = { url: url, img: null, ready: false };
    sheets.push(sheet);
    while (sheets.length > KEPT) {
        sheets.shift();
    }
    return sheet;
}

/** The sheets at urls asked for, in that order: for the frame shown now (in place of those asked for before), or
 * later: fetched ahead (loading once the key that asks has shown its frame, which goes first) */
function ask(urls: string[], later?: boolean): void {
    var missing = urls.filter(function (url) { return !sheetFor(url).img; });
    if (later) {
        ahead = ahead.concat(missing.filter(function (url) { return ahead.indexOf(url) < 0; }));
        setTimeout(loadNext, 0);
    } else {
        next = missing;
        loadNext();
    }
}

/** Unless one is loading, the next sheet asked for (and still kept) loads */
function loadNext(): void {
    while (!loading && (next.length || ahead.length)) {
        var url = next.length ? next.shift() : ahead.shift();
        var waiting = sheets.filter(function (s) { return s.url === url && !s.img; })[0];
        if (waiting) {
            load(waiting);
        }
    }
}

function load(sheet: Sheet): void {
    loading = sheet;
    var img = new Image();
    sheet.img = img;
    var failed = function (): void {
        clearTimeout(timer);
        stop(sheet);
        var at = sheets.indexOf(sheet);
        if (at >= 0) {
            sheets.splice(at, 1);
        }
        loaded(sheet);
    };
    var timer = setTimeout(failed, SHEET_MS);
    img.onload = function () {
        clearTimeout(timer);
        sheet.ready = true;
        for (var i = 0; i < previews.length; i++) {
            previews[i].loaded(sheet.url);
        }
        loaded(sheet);
    };
    img.onerror = failed;
    img.src = sheet.url;
}

/** Stops sheet's download, if any (it tells nothing more) */
function stop(sheet: Sheet): void {
    var img = sheet.img;
    if (img) {
        img.onload = img.onerror = null;
        img.removeAttribute('src');
    }
}

/** sheet's load ended: those asked for meanwhile load next (if still kept). Not for a sheet of a storyboard left
 * meanwhile (it is no longer waited for) */
function loaded(sheet: Sheet): void {
    if (loading !== sheet) {
        return;
    }
    loading = null;
    loadNext();
}

export class SeekPreview {
    private el: HTMLElement;
    private glow: HTMLElement;
    private frame: HTMLElement;
    private time: HTMLElement;
    /** The frame asked for (null: none), the coarse level's frame there while its sheet loads, and the sheet the
     * frame's picture is now */
    private wanted: StoryboardFrame | null = null;
    private stand: StoryboardFrame | null = null;
    private painted = '';
    /** The bar's width (0: not measured yet: it is measured once, while it shows) and the frame's */
    private room = 0;
    private width = 0;

    /** Above bar (a positioned element) */
    constructor(private bar: HTMLElement) {
        this.el = h('div', 'by-seek-preview');
        // (The glow apart from the frame: a new frame repaints only the frame, not the blur)
        this.glow = this.el.appendChild(h('div', 'by-seek-preview-glow')) as HTMLElement;
        this.frame = this.el.appendChild(h('div', 'by-seek-preview-frame')) as HTMLElement;
        this.time = this.el.appendChild(h('div', 'by-seek-preview-time')) as HTMLElement;
        bar.appendChild(this.el);
        previews.push(this);
    }

    /** The video has frames to show */
    get ready(): boolean {
        return !!board;
    }

    /** The video's storyboard (null: none, so no box); the sheets are kept when it is the same */
    set(sb: Storyboard | null): void {
        if (!sameBoard(sb, board)) {
            // The old one's sheet still loading goes (if it never ended, no frame would show again)
            if (loading) {
                stop(loading);
            }
            board = sb;
            sheets = [];
            loading = null;
            next = [];
            ahead = [];
        }
        this.painted = '';
        this.width = sb ? Math.round(sb.w * HEIGHT / sb.h) : 0;
        var style = this.frame.style;
        style.backgroundImage = '';
        style.width = this.glow.style.width = this.width + 'px';
        style.height = this.glow.style.height = HEIGHT + 'px';
        this.hide();
    }

    /** The frame at t (s) of a video duration s long, above that place on the bar; label: after its time ('' none) */
    show(t: number, duration: number, label: string): void {
        if (!board || !(duration > 0)) {
            this.hide();
            return;
        }
        var f = this.wanted = storyboardFrame(board, t);
        var sharp = sheetFor(f.url);
        var c = board.coarse;
        var s = this.stand = c && !sharp.ready ? storyboardFrame(c, t) : null;
        var stand = s && sheetFor(s.url);
        ask(s ? [s.url, f.url] : [f.url]);
        if (sharp.ready) {
            this.paint(f, board);
        } else if (s && c && stand && stand.ready) {
            this.paint(s, c);
        }
        setText(this.time, dots([clock(t), label]));
        this.room = this.room || this.bar.offsetWidth;
        translate(this.el, Math.max(0, Math.min(this.room - this.width, Math.round(t / duration * this.room - this.width / 2))), 0);
        toggleClass(this.el, 'by-seek-preview--on', true);
    }

    hide(): void {
        this.wanted = this.stand = null;
        toggleClass(this.el, 'by-seek-preview--on', false);
    }

    /** The sheets with the frame at t (s) and the frames after it, and the coarse one there, fetched ahead; first: only
     * the one at t (before any key: most first jumps land on it) */
    prefetch(t: number, first?: boolean): void {
        if (board) {
            var urls = [storyboardFrame(board, t).url];
            if (!first) {
                urls.push(storyboardFrame(board, t + sheetSeconds(board)).url);
                if (board.coarse) {
                    urls.push(storyboardFrame(board.coarse, t).url);
                }
            }
            ask(urls, true);
        }
    }

    /** url's sheet arrived: shown if it is the one wanted, or the coarse one while that has not come */
    loaded(url: string): void {
        var f = this.wanted;
        if (f && f.url === url && board) {
            this.stand = null;
            this.paint(f, board);
        } else if (this.stand && this.stand.url === url && board && board.coarse) {
            this.paint(this.stand, board.coarse);
        }
    }

    /** Frame f of level sb drawn (the sheet's picture set only when it changes) */
    private paint(f: StoryboardFrame, sb: Storyboard): void {
        var scale = HEIGHT / sb.h;
        paintFrame(this.frame.style, sb, f, sb.w * scale, HEIGHT, scale, this.painted !== f.url);
        this.painted = f.url;
    }
}

/** Frame f of sb as the background of style: at scale, centred in a box of w x h px (whole: its sheet and size too,
 * else only where it sits) */
export function paintFrame(style: CSSStyleDeclaration, sb: Storyboard, f: StoryboardFrame, w: number, h: number, scale: number, whole: boolean): void {
    if (whole) {
        style.backgroundImage = 'url("' + f.url + '")';
        style.backgroundSize = Math.round(sb.cols * sb.w * scale) + 'px ' + Math.round(sb.rows * sb.h * scale) + 'px';
    }
    style.backgroundPosition = Math.round((w - sb.w * scale) / 2 - f.col * sb.w * scale) + 'px ' +
        Math.round((h - sb.h * scale) / 2 - f.row * sb.h * scale) + 'px';
}
