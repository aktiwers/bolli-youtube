// The seek preview: while a jump is pending, the frame where it lands, in a
// box above that place on the bar, with its time under it. The frames come
// from YouTube's storyboard (sheets of small frames: api/streams.ts). A new
// frame shows once its sheet has loaded (until then the one before stays), so
// the box never shows a wrong frame. Only the last few sheets are kept; the
// ones around the playhead are fetched ahead, so the box shows at once.

import { h, setText, toggleClass } from '../../core/dom.js';
import { clock } from '../../core/time.js';
import { Storyboard, storyboardFrame } from '../api/streams.js';

/** The frame's height in the box (layout px), about the size YouTube's TV app draws its frames; its width follows their shape */
var HEIGHT = 104;
/** Sheets kept loaded: a 5x5 sheet of 179x90 frames is ~1.6 MB decoded */
var KEPT = 4;

interface Sheet {
    url: string;
    img: HTMLImageElement;
    ready: boolean;
}

export class SeekPreview {
    private el: HTMLElement;
    private frame: HTMLElement;
    private time: HTMLElement;
    private sb: Storyboard | null = null;
    /** Loaded or loading, the latest last */
    private sheets: Sheet[] = [];
    /** The frame asked for last ('' none): a sheet that loads later paints only if it is still this one */
    private wanted = '';

    /** Above bar (a positioned element) */
    constructor(private bar: HTMLElement) {
        this.el = h('div', 'by-seek-preview');
        this.frame = this.el.appendChild(h('div', 'by-seek-preview-frame')) as HTMLElement;
        this.time = this.el.appendChild(h('div', 'by-seek-preview-time')) as HTMLElement;
        bar.appendChild(this.el);
    }

    /** The video has frames to show */
    get ready(): boolean {
        return !!this.sb;
    }

    /** The video's storyboard (null: none, so no box) */
    set(sb: Storyboard | null): void {
        this.sb = sb;
        this.sheets = [];
        this.hide();
    }

    /** The frame at t (s) of a video duration s long, above that place on the bar */
    show(t: number, duration: number): void {
        var sb = this.sb;
        if (!sb || !(duration > 0)) {
            this.hide();
            return;
        }
        var f = storyboardFrame(sb, t);
        var scale = HEIGHT / sb.h;
        var w = Math.round(sb.w * scale);
        var key = f.url + '#' + f.col + ',' + f.row;
        this.wanted = key;
        var frame = this.frame.style;
        var self = this;
        var paint = function (): void {
            if (self.wanted !== key) {
                return;
            }
            frame.backgroundImage = 'url("' + f.url + '")';
            frame.backgroundSize = Math.round(sb!.cols * sb!.w * scale) + 'px ' + Math.round(sb!.rows * sb!.h * scale) + 'px';
            frame.backgroundPosition = -Math.round(f.col * sb!.w * scale) + 'px ' + -Math.round(f.row * sb!.h * scale) + 'px';
        };
        var sheet = this.sheet(f.url);
        if (sheet.ready) {
            paint();
        } else {
            sheet.img.addEventListener('load', paint);
        }
        frame.width = w + 'px';
        frame.height = HEIGHT + 'px';
        setText(this.time, clock(t));
        var room = this.bar.offsetWidth;
        this.el.style.left = Math.max(0, Math.min(room - w, Math.round(t / duration * room - w / 2))) + 'px';
        toggleClass(this.el, 'by-seek-preview--on', true);
    }

    hide(): void {
        this.wanted = '';
        toggleClass(this.el, 'by-seek-preview--on', false);
    }

    /** The sheets with the frame at t (s) and the frames after it, fetched ahead */
    prefetch(t: number): void {
        var sb = this.sb;
        if (sb) {
            this.sheet(storyboardFrame(sb, t).url);
            this.sheet(storyboardFrame(sb, t + sb.cols * sb.rows * sb.interval / 1000).url);
        }
    }

    /** url's sheet, fetched now if need be; the oldest beyond KEPT let go */
    private sheet(url: string): Sheet {
        var had = this.sheets.filter(function (s) { return s.url === url; })[0];
        if (had) {
            this.sheets.splice(this.sheets.indexOf(had), 1);
            this.sheets.push(had);
            return had;
        }
        var img = new Image();
        var sheet: Sheet = { url: url, img: img, ready: false };
        img.onload = function () { sheet.ready = true; };
        img.src = url;
        this.sheets.push(sheet);
        while (this.sheets.length > KEPT) {
            this.sheets.shift();
        }
        return sheet;
    }
}
