// The seek preview: while a jump is pending, the frame where it lands, in a
// box above that place on the bar, with its time under it. The frames come
// from YouTube's storyboard (sheets of small frames: api/streams.ts). A new
// frame shows once its sheet has loaded (until then the one before stays), so
// the box never shows a wrong frame. The previews of both bars share one set
// of sheets: the last few are kept, one loads at a time (while a key is held,
// the latest one asked for loads next, not every one passed), and the ones
// around the playhead are fetched ahead, so the box shows at once.

import { h, setText, toggleClass, translate } from '../../core/dom.js';
import { clock } from '../../core/time.js';
import { Storyboard, storyboardFrame } from '../api/streams.js';

/** The frame's height in the box (layout px), about the size YouTube's TV app draws its frames; its width follows their shape */
var HEIGHT = 104;
/** Sheets kept loaded: a 5x5 sheet of 179x90 frames is ~1.6 MB decoded */
var KEPT = 4;

interface Sheet {
    url: string;
    /** null: asked for, not loading yet */
    img: HTMLImageElement | null;
    ready: boolean;
}

/** The storyboard whose sheets are kept, its sheets (the latest last), the one loading and the one to load next */
var board: Storyboard | null = null;
var sheets: Sheet[] = [];
var loading = '';
var next = '';
/** The previews told when a sheet arrives */
var previews: SeekPreview[] = [];

function sameBoard(a: Storyboard | null, b: Storyboard | null): boolean {
    return !!a && !!b && a.base === b.base && a.level === b.level && a.name === b.name && a.sigh === b.sigh;
}

/** url's sheet: kept, else asked for (at once when none loads, else next) */
function sheetFor(url: string): Sheet {
    var had = sheets.filter(function (s) { return s.url === url; })[0];
    if (had) {
        sheets.splice(sheets.indexOf(had), 1);
        sheets.push(had);
        if (!had.img) {
            next = url;
        }
        return had;
    }
    var sheet: Sheet = { url: url, img: null, ready: false };
    sheets.push(sheet);
    while (sheets.length > KEPT) {
        sheets.shift();
    }
    if (loading) {
        next = url;
    } else {
        load(sheet);
    }
    return sheet;
}

function load(sheet: Sheet): void {
    loading = sheet.url;
    var img = new Image();
    sheet.img = img;
    img.onload = function () {
        sheet.ready = true;
        for (var i = 0; i < previews.length; i++) {
            previews[i].loaded(sheet.url);
        }
        loaded();
    };
    img.onerror = function () {
        var at = sheets.indexOf(sheet);
        if (at >= 0) {
            sheets.splice(at, 1);
        }
        loaded();
    };
    img.src = sheet.url;
}

/** A load ended: the sheet asked for meanwhile loads next (if it is still kept) */
function loaded(): void {
    loading = '';
    var url = next;
    next = '';
    var waiting = sheets.filter(function (s) { return s.url === url && !s.img; })[0];
    if (waiting) {
        load(waiting);
    }
}

export class SeekPreview {
    private el: HTMLElement;
    private glow: HTMLElement;
    private frame: HTMLElement;
    private time: HTMLElement;
    /** The frame asked for (null: none) and the sheet the frame's picture is now */
    private wanted: { url: string; col: number; row: number } | null = null;
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
            board = sb;
            sheets = [];
            next = '';
        }
        this.painted = '';
        this.width = sb ? Math.round(sb.w * HEIGHT / sb.h) : 0;
        var style = this.frame.style;
        style.backgroundImage = '';
        style.width = this.glow.style.width = this.width + 'px';
        style.height = this.glow.style.height = HEIGHT + 'px';
        this.hide();
    }

    /** The frame at t (s) of a video duration s long, above that place on the bar */
    show(t: number, duration: number): void {
        if (!board || !(duration > 0)) {
            this.hide();
            return;
        }
        this.wanted = storyboardFrame(board, t);
        if (sheetFor(this.wanted.url).ready) {
            this.paint();
        }
        setText(this.time, clock(t));
        this.room = this.room || this.bar.offsetWidth;
        translate(this.el, Math.max(0, Math.min(this.room - this.width, Math.round(t / duration * this.room - this.width / 2))), 0);
        toggleClass(this.el, 'by-seek-preview--on', true);
    }

    hide(): void {
        this.wanted = null;
        toggleClass(this.el, 'by-seek-preview--on', false);
    }

    /** The sheets with the frame at t (s) and the frames after it, fetched ahead */
    prefetch(t: number): void {
        if (board) {
            sheetFor(storyboardFrame(board, t).url);
            sheetFor(storyboardFrame(board, t + board.cols * board.rows * board.interval / 1000).url);
        }
    }

    /** url's sheet arrived: shown if it is the one wanted */
    loaded(url: string): void {
        if (this.wanted && this.wanted.url === url) {
            this.paint();
        }
    }

    /** The wanted frame drawn (the sheet's picture set only when it changes) */
    private paint(): void {
        var f = this.wanted;
        var sb = board;
        if (!f || !sb) {
            return;
        }
        var scale = HEIGHT / sb.h;
        var style = this.frame.style;
        if (this.painted !== f.url) {
            this.painted = f.url;
            style.backgroundImage = 'url("' + f.url + '")';
            style.backgroundSize = Math.round(sb.cols * sb.w * scale) + 'px ' + Math.round(sb.rows * sb.h * scale) + 'px';
        }
        style.backgroundPosition = -Math.round(f.col * sb.w * scale) + 'px ' + -Math.round(f.row * sb.h * scale) + 'px';
    }
}
