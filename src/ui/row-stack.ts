// A vertical stack of tile rows (src/ui/tile-row.ts), navigated with
// Up/Down. Rows sit at fixed offsets (index x row height, no layout reads);
// the focused row is active and marks its tile while the screen has focus.
// Distance from the focused row decides which rows are drawn (the TV
// repaints every drawn tile in each frame of a slide), which load their
// tiles, and how many images each keeps (far rows release theirs; they
// reload from cache). Adding, replacing or removing a row keeps focus on
// the same row. The screen scrolls the container itself (see top).

import { h, LAYOUT_HEIGHT, releaseImages, restoreImages } from '../core/dom.js';
import { TileRow } from './tile-row.js';

/** Rows drawn above and below the focused one (one below is on screen, the next slides in) */
var DRAWN_ABOVE = 1;
var DRAWN_BELOW = 2;
/** Rows further away than this release their images */
var IMAGES_ABOVE = 2;
var IMAGES_BELOW = 3;
/** The slide (0.3 s in the theme) plus a margin: a row that becomes drawn
 * below the screen waits for the slide to end (painting it would stall
 * the slide) */
var SLIDE_MS = 350;

export class RowStack {
    el: HTMLElement;
    rows: TileRow[] = [];
    /** The focused row */
    index = 0;
    private active: TileRow | null = null;
    private focused = true;
    /** Focus is moving: rows that become drawn off screen wait */
    private sliding = false;
    private timer = 0;
    /** Extra height of the focused row when it can grow (setBig; 0: none); rows below shift down by it */
    private bigExtra = 0;
    /** Extra rows drawn (and keeping images) above and below beyond DRAWN_*, for short rows with several on screen
     * (setReach) */
    private more = 0;

    /** focusTop: where the screen places the focused row (rows below the
     * screen's bottom wait for the slide); omitted: no row waits */
    constructor(className: string, private rowH: number, private focusTop?: number) {
        this.el = h('div', className);
    }

    /** Draws `more` additional rows on each side of the focused one (for short rows, several on screen) */
    setReach(more: number): void {
        this.more = more;
        this.mark();
    }

    /** Shows the focused row in its bigShape, extra px taller; the rows below shift down by that much */
    setBig(extra: number): void {
        this.bigExtra = extra;
        this.layOut(0);
        this.mark();
    }

    get row(): TileRow | null {
        return this.rows[this.index] || null;
    }

    /** The focused row's offset in the container */
    get top(): number {
        return this.topOf(this.index);
    }

    /** Inserts row at index at (default: last) */
    add(row: TileRow, at?: number): void {
        var i = at === undefined ? this.rows.length : at;
        row.el.style.position = 'absolute';
        this.el.insertBefore(row.el, this.rows[i] ? this.rows[i].el : null);
        this.rows.splice(i, 0, row);
        if (i <= this.index && this.rows.length > 1) {
            this.index++;
        }
        this.layOut(i);
        this.mark();
    }

    /** Appends rows, laid out and marked once (e.g. a page of a grid) */
    addAll(rows: TileRow[]): void {
        var from = this.rows.length;
        for (var i = 0; i < rows.length; i++) {
            rows[i].el.style.position = 'absolute';
            this.el.appendChild(rows[i].el);
            this.rows.push(rows[i]);
        }
        this.layOut(from);
        this.mark();
    }

    /** Replaces the rows with these, in this order, laid out and marked once.
     * Rows already present stay as they are (tiles and images); focus stays
     * on its row if it is still there */
    setRows(rows: TileRow[]): void {
        var focused = this.row;
        for (var i = 0; i < this.rows.length; i++) {
            if (rows.indexOf(this.rows[i]) < 0) {
                this.el.removeChild(this.rows[i].el);
            }
        }
        for (var k = 0; k < rows.length; k++) {
            rows[k].el.style.position = 'absolute';
            // In order: appending a row already there moves it to the end
            this.el.appendChild(rows[k].el);
        }
        this.rows = rows.slice();
        if (this.active && rows.indexOf(this.active) < 0) {
            this.active = null;
        }
        var at = focused ? rows.indexOf(focused) : -1;
        this.index = Math.max(0, Math.min(at >= 0 ? at : this.index, rows.length - 1));
        this.layOut(0);
        this.mark();
    }

    /** Hidden, no row is drawn (a screen over it would otherwise keep their layers) and images are released; shown,
     * they are restored */
    setShown(shown: boolean): void {
        this.el.style.display = shown ? '' : 'none';
        if (shown) {
            restoreImages(this.el);
        } else {
            releaseImages(this.el);
        }
    }

    /** Puts row in old's place (the caller sets its focus) */
    replace(old: TileRow, row: TileRow): void {
        var i = this.rows.indexOf(old);
        if (i < 0) {
            return;
        }
        row.el.style.position = 'absolute';
        this.el.replaceChild(row.el, old.el);
        this.rows[i] = row;
        // From this row on: it may have another height
        this.layOut(i);
        if (this.active === old) {
            this.active = null;
        }
        this.mark();
    }

    remove(row: TileRow): void {
        var i = this.rows.indexOf(row);
        if (i < 0) {
            return;
        }
        this.el.removeChild(row.el);
        this.rows.splice(i, 1);
        if (this.active === row) {
            this.active = null;
        }
        if (i < this.index) {
            this.index--;
        }
        this.index = Math.max(0, Math.min(this.index, this.rows.length - 1));
        this.layOut(i);
        this.mark();
    }

    clear(): void {
        this.el.innerHTML = '';
        this.rows = [];
        this.index = 0;
        this.active = null;
    }

    /** Up/Down: false past the first or last row */
    move(delta: number): boolean {
        var to = this.index + delta;
        if (to < 0 || to >= this.rows.length) {
            return false;
        }
        this.focusRow(to);
        return true;
    }

    /** Focuses row index (clamped) */
    focusRow(index: number): void {
        var was = this.index;
        this.index = Math.max(0, Math.min(index, this.rows.length - 1));
        // Rows between the previously and newly enlarged row move
        if (this.bigExtra && was !== this.index) {
            this.layOut(Math.min(was, this.index));
        }
        this.sliding = true;
        this.mark();
        this.sliding = false;
    }

    setFocused(focused: boolean): void {
        if (focused !== this.focused) {
            this.focused = focused;
            this.mark();
        }
    }

    /** Updates every row by its distance from the focused one: near rows are
     * drawn and load, the focused row keeps two screens of images and its
     * neighbours one (fading in on screen), far rows none. Only the rows
     * gaining and losing the focus mark change class. */
    private mark(): void {
        var held = false;
        for (var i = 0; i < this.rows.length; i++) {
            var row = this.rows[i];
            var d = i - this.index;
            var drawn = d >= -DRAWN_ABOVE - this.more && d <= DRAWN_BELOW + this.more;
            var hidden = row.el.style.display === 'none';
            // Off screen after the slide: drawn once it ends (it still loads now)
            var waits = drawn && hidden && this.sliding && this.focusTop !== undefined && this.focusTop + d * this.rowH >= LAYOUT_HEIGHT;
            held = held || waits;
            if (hidden === (drawn && !waits)) {
                row.el.style.display = drawn && !waits ? '' : 'none';
            }
            if (this.bigExtra) {
                row.setBig(d === 0);
            }
            if (drawn) {
                row.load();
                row.setImages(d === 0 ? 2 : 1, d === 0 || d === 1);
            } else if (d < -IMAGES_ABOVE - this.more || d > IMAGES_BELOW + this.more) {
                row.setImages(0, false);
            }
        }
        if (held) {
            clearTimeout(this.timer);
            var self = this;
            this.timer = setTimeout(function () {
                self.mark();
            }, SLIDE_MS) as unknown as number;
        }
        var want = this.focused ? this.row : null;
        if (want !== this.active) {
            if (this.active) {
                this.active.setActive(false);
            }
            if (want) {
                want.setActive(true);
            }
            this.active = want;
        }
    }

    /** How far rows below the focused one shift down (0 when the focused row has no bigShape, e.g. a square one) */
    private extra(): number {
        return this.row && this.row.canBig ? this.bigExtra : 0;
    }

    /** Row i's offset: i x row height plus the extraHeight of the rows before it */
    private topOf(i: number): number {
        var top = i * this.rowH;
        for (var k = 0; k < i && k < this.rows.length; k++) {
            top += this.rows[k].extraHeight;
        }
        return top;
    }

    private layOut(from: number): void {
        var extra = this.extra();
        for (var i = from; i < this.rows.length; i++) {
            this.rows[i].el.style.top = this.topOf(i) + (i > this.index ? extra : 0) + 'px';
        }
    }
}
