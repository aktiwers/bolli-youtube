// The tabs at the top of a page over the app (Settings › Theme › Colours, Icons, Text size: by-colours-tab), wrapped on
// lines as their names need. Left and Right go from tab to tab in their order (on to the next line's first); Up and Down
// to the nearest tab across on the line above or below, measured from where a run of Up and Down began, so Down and Up
// again come back to the same tab; Down below the last line is the page's way into what is under the tabs, as OK on a
// tab is: the tabs a place of their own, and what they choose another under them.
// Speed: the tabs' places are read once, in the frame after the page opens (laid out then anyway), never at a key; a
// key before that frame reads them then, once.

import { afterFrame } from '../core/dom.js';
import { KEY } from '../core/keys.js';

/** move's answer for Down below the last line: into what is under the tabs */
export var BELOW = -1;

export class TabLines {
    private els: HTMLElement[] = [];
    /** Each tab's line (0 the first) and the middle of it across (null: not read since the tabs were made) */
    private lines: number[] | null = null;
    private mids: number[] = [];
    /** Where across a run of Up and Down began (-1: none) */
    private across = -1;

    /** The page opened with these tabs (made anew): their places read in the frame after */
    open(els: HTMLElement[]): void {
        var self = this;
        this.els = els;
        this.lines = null;
        this.across = -1;
        afterFrame(function () {
            if (self.els === els && !self.lines) {
                self.measure();
            }
        });
    }

    /** Where an arrow (code) goes from tab at: a tab (at itself where none is that way: Left on the first, Right on the
     * last, Up on the first line), or BELOW (Down on the last line) */
    move(at: number, code: number): number {
        if (code === KEY.LEFT || code === KEY.RIGHT) {
            this.across = -1;
            return Math.max(0, Math.min(this.els.length - 1, at + (code === KEY.RIGHT ? 1 : -1)));
        }
        var way = code === KEY.DOWN ? 1 : code === KEY.UP ? -1 : 0;
        if (!way) {
            return at;
        }
        if (!this.lines) {
            this.measure();
        }
        var lines = this.lines as number[];
        var mid = this.across >= 0 ? this.across : this.mids[at];
        var best = -1;
        for (var i = 0; i < lines.length; i++) {
            if (lines[i] === lines[at] + way && (best < 0 || Math.abs(this.mids[i] - mid) < Math.abs(this.mids[best] - mid))) {
                best = i;
            }
        }
        if (best >= 0) {
            this.across = mid;
            return best;
        }
        this.across = -1;
        return way > 0 ? BELOW : at;
    }

    /** Each tab's line and middle across, as laid out (a page's own text: no text size changes them while it is open) */
    private measure(): void {
        var lines: number[] = [];
        var mids: number[] = [];
        var line = 0;
        for (var i = 0; i < this.els.length; i++) {
            var el = this.els[i];
            if (i && el.offsetTop > this.els[i - 1].offsetTop) {
                line++;
            }
            lines.push(line);
            mids.push(el.offsetLeft + el.offsetWidth / 2);
        }
        this.lines = lines;
        this.mids = mids;
    }
}
