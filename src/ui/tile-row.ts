// A horizontal row of tiles (bd-row, bd-tile: lift and ring on focus, title
// under the image). The app passes the tiles (TileItem) or a loader, called
// on load(). All tiles in a row share one size, so each has a fixed offset
// and nothing is measured; a tile is built when it first nears the view.
// Only tiles in view are drawn, plus two on each side on the focused row for
// its slide: the TV updates every drawn tile's layers in each animation
// frame, so 100 drawn tiles would slow the whole screen. The containing
// screen sets how many screens of images to keep (setImages; a decoded
// poster is ~0.6 MB); images more than a screen behind or two ahead are
// released. Moving focus changes two class names and one transform.

import { h, LAYOUT_WIDTH, setText, toggleClass, translate } from '../core/dom.js';

export interface TileItem {
    id: string;
    title: string;
    /** The image URL (empty: no image) */
    image: string;
    /** Shown when the image fails to load (e.g. the series' picture for an episode without a still) */
    fallback?: string;
    /** A short label on the image ("Out 29 Oct", "No sources") */
    label?: string;
    /** Makes a "See all" tile: the title over the dimmed image, this line under it */
    more?: string;
    /** Watched fraction, 0..1 (0: no bar) */
    progress?: number;
    /** Lines under the title ("Channel", "9.6k views • 1 day ago"; the theme sets their space) */
    lines?: string[];
    /** A round image (a person or channel): square, centred (the theme rounds it: bd-tile--round) */
    round?: boolean;
    /** Chips at the start of the last line ("4K", "New") */
    chips?: string[];
    /** The chip that marks an offer, e.g. "Buy or rent" (bd-tile-chip--offer, coloured by the theme) */
    offerChip?: string;
    /** Draws a stack (a playlist, a mix): edges above the image in these colours, nearest first (bd-tile-stack) */
    stack?: string[];
    /** The image used while the tile is the wide one (a row with a wideShape) */
    wideImage?: string;
    /** An icon before the label, e.g. live, playlist, mix (drawn by the theme: bd-tile-label--<icon>) */
    labelIcon?: string;
}

export interface TileShape {
    w: number;
    h: number;
}

/** A row's spacing, in the 1280x720 layout units */
export interface TileLayout {
    /** Left/right margin */
    pad: number;
    /** Between two tiles */
    gap: number;
    /** The text area under a tile's image (title and lines) */
    under: number;
    /** A row's heading */
    head: number;
    /** Between rows */
    rowGap: number;
}

export interface TileRowOptions {
    title: string;
    shape: TileShape;
    /** The items, when already known */
    items?: TileItem[];
    /** Or a loader for them (called by load()) */
    load?: () => Promise<TileItem[]>;
    /** Called after loading (empty items: nothing found; failed: retried when
     * drawn, not before RETRY_MS) */
    loaded?: (row: TileRow, failed: boolean) => void;
    /** No heading (a grid line) */
    noTitle?: boolean;
    /** Left/Right stop at the ends instead of wrapping (a grid line) */
    noWrap?: boolean;
    /** Spacing (default: LAYOUT) */
    layout?: TileLayout;
    /** A line under the heading, and a round icon before it (sized by the theme: bd-row-subtitle, bd-row-icon) */
    subtitle?: string;
    icon?: string;
    /** Tile shape while this is the stack's focused row (setBig); omitted: always shape */
    bigShape?: TileShape;
    /** Shape of the focused tile while the row is active: it shows its wideImage at the margin and the tiles after
     * it shift right (bd-row--wide; the theme lays its text over it); omitted: all tiles share one shape */
    wideShape?: TileShape;
    /** Extra height over the stack's row height (e.g. a line under the heading); omitted: 0 */
    extraHeight?: number;
    /** Build tiles only once the row is drawn (setImages, setActive, focusAt), not on creation: a page of 18 rows
     * with 3 in view took ~100 ms to build all tiles */
    lazy?: boolean;
}

/** Default spacing (1280x720 units) */
var LAYOUT: TileLayout = { pad: 56, gap: 24, under: 40, head: 40, rowGap: 26 };
/** Tiles drawn on each side of the visible ones on the focused row (so its slide shows no gap) */
var DRAWN_AROUND = 2;
/** A failed load is not retried before this */
var RETRY_MS = 20000;

/** Height of one row, heading included (noTitle: a grid line, without) */
export function rowHeight(shape: TileShape, noTitle?: boolean, layout?: TileLayout): number {
    var l = layout || LAYOUT;
    return (noTitle ? 0 : l.head) + shape.h + l.under + l.rowGap;
}

interface Tile {
    el: HTMLElement;
    under: HTMLElement;
    frame: HTMLElement;
    img: HTMLImageElement;
    /** The image is requested (src set) */
    hasImage: boolean;
    label: HTMLElement | null;
    /** The progress bar's fill (null: none yet) */
    bar: HTMLElement | null;
}

export class TileRow {
    el: HTMLElement;
    items: TileItem[] = [];
    private strip: HTMLElement;
    /** Tile width and gap */
    private step: number;
    /** Tiles in view from the margin */
    private screen: number;
    /** Tiles built so far, by index */
    private tiles: (Tile | undefined)[] = [];
    /** The items are present or loading */
    private asked = false;
    /** Failed loads, and when the last one failed */
    failures = 0;
    private failedAt = 0;
    private focusIndex = 0;
    private marked = -1;
    private active = false;
    /** The tile at the left margin */
    private first = 0;
    /** Drawn tiles: from drawnFrom up to, not including, drawnTo */
    private drawnFrom = 0;
    private drawnTo = 0;
    /** Screens of images kept from the margin (0: none), and whether they fade in (row on screen) */
    private imageScreens = 0;
    private fadeIn = false;
    private layout: TileLayout;
    /** Current tile shape (options.shape, or bigShape while big) */
    private shape: TileShape;
    /** The tile in wideShape (-1: none) */
    private wideAt = -1;

    constructor(private options: TileRowOptions) {
        this.layout = options.layout || LAYOUT;
        this.shape = options.shape;
        this.step = options.shape.w + this.layout.gap;
        this.screen = Math.ceil(LAYOUT_WIDTH / this.step);
        // Without a heading the row starts higher (bd-row--bare), so it does
        // not clip the top of a focused tile's enlarged frame
        this.el = h('div', (options.noTitle ? 'bd-row bd-row--bare' : 'bd-row') + (options.wideShape ? ' bd-row--wide' : ''));
        if (!options.noTitle) {
            var title = h('div', options.subtitle ? 'bd-row-title bd-row-title--sub' : 'bd-row-title', options.title);
            title.style.height = this.layout.head + 'px';
            if (options.icon) {
                var icon = h('img', 'bd-row-icon') as HTMLImageElement;
                icon.src = options.icon;
                title.insertBefore(icon, title.firstChild);
            }
            if (options.subtitle) {
                title.appendChild(h('div', 'bd-row-subtitle', options.subtitle));
            }
            this.el.appendChild(title);
        }
        this.strip = h('div', 'bd-row-strip');
        this.strip.style.position = 'relative';
        this.strip.style.height = Math.max(options.shape.h, options.wideShape ? options.wideShape.h : 0) + this.layout.under + 'px';
        this.el.appendChild(this.strip);
        if (options.items) {
            this.items = options.items;
            this.asked = true;
            if (!options.lazy) {
                this.update();
            }
        }
    }

    get focused(): TileItem | null {
        return this.items[this.focusIndex] || null;
    }

    get count(): number {
        return this.items.length;
    }

    /** The focused index (a grid uses it to keep the column) */
    get index(): number {
        return this.focusIndex;
    }

    /** Appends items (a list's next page) */
    append(items: TileItem[]): void {
        this.items = this.items.concat(items);
        this.update();
    }

    /** Loads the items (once; again after a failure) */
    load(): void {
        if (this.asked || !this.options.load || Date.now() - this.failedAt < RETRY_MS) {
            return;
        }
        this.asked = true;
        var self = this;
        this.options.load().then(function (items) {
            self.items = items;
            self.update();
            self.markFocus();
            if (self.options.loaded) {
                self.options.loaded(self, false);
            }
        }, function () {
            self.asked = false;
            self.failures++;
            self.failedAt = Date.now();
            if (self.options.loaded) {
                self.options.loaded(self, true);
            }
        });
    }

    setActive(active: boolean): void {
        if (active === this.active) {
            return;
        }
        this.active = active;
        toggleClass(this.el, 'bd-row--active', active);
        this.update();
        this.markFocus();
    }

    /** Extra height over the stack's row height (TileRowOptions.extraHeight) */
    get extraHeight(): number {
        return this.options.extraHeight || 0;
    }

    /** The row has a bigShape (setBig enlarges it) */
    get canBig(): boolean {
        return !!this.options.bigShape;
    }

    /** Switches tiles to bigShape (big) or back, redoing offsets, sizes and scroll (no-op without bigShape);
     * bd-row--big while big */
    setBig(big: boolean): void {
        var shape = big && this.options.bigShape ? this.options.bigShape : this.options.shape;
        if (shape === this.shape) {
            return;
        }
        this.shape = shape;
        toggleClass(this.el, 'bd-row--big', shape !== this.options.shape);
        this.step = shape.w + this.layout.gap;
        this.screen = Math.ceil(LAYOUT_WIDTH / this.step);
        this.strip.style.height = shape.h + this.layout.under + 'px';
        for (var i = 0; i < this.tiles.length; i++) {
            var tile = this.tiles[i];
            if (tile) {
                sizeTile(tile, shape, !!this.items[i].round);
                tile.el.style.left = this.layout.pad + i * this.step + 'px';
            }
        }
        this.scroll();
        this.update();
    }

    /** screens: screens of images kept from the margin (0: none, the row is
     * far away); fadeIn: the row is on screen, so new images fade in */
    setImages(screens: number, fadeIn: boolean): void {
        if (screens !== this.imageScreens || fadeIn !== this.fadeIn) {
            this.imageScreens = screens;
            this.fadeIn = fadeIn;
            this.update();
        }
    }

    /** Moves focus by delta, wrapping at the ends like a carousel
     * (noWrap: returns false at the ends) */
    move(delta: number): boolean {
        var n = this.items.length;
        var to = this.focusIndex + delta;
        if (n < 2 || (this.options.noWrap && (to < 0 || to >= n))) {
            return false;
        }
        this.focusAt((to + n) % n);
        return true;
    }

    /** Focuses tile index and scrolls it into view */
    focusAt(index: number): void {
        this.focusIndex = Math.max(0, Math.min(index, this.items.length - 1));
        this.scroll();
        this.update();
        this.markFocus();
    }

    /** Sets a tile's label ('' removes it); an unbuilt tile gets it when built */
    setLabel(id: string, text: string): void {
        this.eachTile(id, function (item, tile) {
            item.label = text;
            if (tile) {
                labelTile(tile, text);
            }
        });
    }

    /** Sets a tile's watched fraction (0-1; 0 removes the bar); an unbuilt tile gets it when built */
    setProgress(id: string, progress: number): void {
        this.eachTile(id, function (item, tile) {
            item.progress = progress;
            if (tile) {
                progressTile(tile, progress);
            }
        });
    }

    /** Calls fn for each item with this id, with its tile (undefined: not built yet) */
    private eachTile(id: string, fn: (item: TileItem, tile: Tile | undefined) => void): void {
        for (var i = 0; i < this.items.length; i++) {
            if (this.items[i].id === id) {
                fn(this.items[i], this.tiles[i]);
            }
        }
    }

    /** Focuses the tile with this id (or the first) */
    focusId(id: string): void {
        this.focusAt(Math.max(0, this.items.map(function (it) { return it.id; }).indexOf(id)));
    }

    /** Builds and draws tiles near the view, requests their images and releases far ones */
    private update(): void {
        var n = this.items.length;
        var first = this.first;
        var around = this.active ? DRAWN_AROUND : 0;
        var from = Math.max(0, first - around);
        var to = Math.min(n, first + this.screen + around);
        var imagesFrom = Math.max(0, first - 1);
        var imagesTo = this.imageScreens ? Math.min(n, first + this.imageScreens * this.screen + 1) : imagesFrom;
        for (var b = Math.min(from, imagesFrom); b < Math.max(to, imagesTo); b++) {
            this.tile(b);
        }
        for (var i = Math.min(from, this.drawnFrom); i < Math.max(to, this.drawnTo); i++) {
            var drawn = i >= from && i < to;
            var tile = this.tiles[i];
            if (tile && drawn !== (i >= this.drawnFrom && i < this.drawnTo)) {
                tile.el.style.display = drawn ? '' : 'none';
            }
        }
        this.drawnFrom = from;
        this.drawnTo = to;
        // Keep images from a screen behind to two ahead (none when the row is far away)
        var keepFrom = this.imageScreens ? first - this.screen : n;
        var keepTo = this.imageScreens ? first + 2 * this.screen + 1 : n;
        for (var j = 0; j < this.tiles.length; j++) {
            var t = this.tiles[j];
            if (!t) {
                continue;
            }
            if (j >= imagesFrom && j < imagesTo && !t.hasImage && this.items[j].image) {
                if (!this.fadeIn) {
                    toggleClass(t.img, 'bd-fade--in', true);
                }
                t.img.src = this.picture(j);
                t.hasImage = true;
            } else if ((j < keepFrom || j >= keepTo) && t.hasImage) {
                t.img.removeAttribute('src');
                t.hasImage = false;
            }
        }
    }

    /** Tile index, built in place (hidden) on first use */
    private tile(index: number): Tile {
        var tile = this.tiles[index];
        if (!tile) {
            var item = this.items[index];
            tile = buildTile(item, this.shape, this.layout.under);
            if (item.fallback) {
                tile.img.onerror = fallBack(tile.img, item.fallback);
            }
            tile.el.style.position = 'absolute';
            tile.el.style.left = this.left(index) + 'px';
            tile.el.style.top = '0';
            tile.el.style.display = 'none';
            if (index < this.first) {
                toggleClass(tile.el, 'bd-tile--gone', true);
            }
            this.strip.appendChild(tile.el);
            this.tiles[index] = tile;
        }
        return tile;
    }

    /** Only the tiles gaining and losing the mark change; a row activated
     * before its tiles exist is marked once they do */
    private markFocus(): void {
        var want = this.active && this.tiles[this.focusIndex] ? this.focusIndex : -1;
        if (want !== this.marked) {
            var had = this.tiles[this.marked];
            if (had) {
                toggleClass(had.el, 'bd-tile--focused', false);
            }
            if (want >= 0) {
                toggleClass((this.tiles[want] as Tile).el, 'bd-tile--focused', true);
            }
            this.marked = want;
        }
        if (this.options.wideShape) {
            this.widen(want);
        }
    }

    /** Tile index's offset in the strip (tiles after the wide one shift by its extra width) */
    private left(index: number): number {
        var wide = this.options.wideShape;
        var extra = wide && this.wideAt >= 0 && index > this.wideAt ? wide.w - this.shape.w : 0;
        return this.layout.pad + index * this.step + extra;
    }

    /** Tile index's image URL (its wideImage while wide) */
    private picture(index: number): string {
        var item = this.items[index];
        return index === this.wideAt && item.wideImage ? item.wideImage : item.image;
    }

    /** Makes tile at wide with its wideImage (-1: none), restores the previous one, and shifts the tiles after them */
    private widen(at: number): void {
        var was = this.wideAt;
        if (at === was) {
            return;
        }
        this.wideAt = at;
        var self = this;
        [was, at].forEach(function (i) {
            var tile = i >= 0 ? self.tiles[i] : undefined;
            if (tile) {
                sizeTile(tile, i === at ? self.options.wideShape as TileShape : self.shape, !!self.items[i].round);
                if (tile.hasImage) {
                    tile.img.src = self.picture(i);
                }
            }
        });
        var from = Math.max(0, Math.min(was < 0 ? at : was, at < 0 ? was : at));
        for (var i = from; i < this.tiles.length; i++) {
            var tile = this.tiles[i];
            if (tile) {
                tile.el.style.left = this.left(i) + 'px';
            }
        }
    }

    /** Keeps the focused tile in view with the one before it. A tile always
     * starts at the margin; at the end the row stops once the last tile fits.
     * Tiles past the margin fade out instead of hanging off the screen edge
     * (only those crossing it change). */
    private scroll(): void {
        var room = LAYOUT_WIDTH - 2 * this.layout.pad;
        var wide = this.options.wideShape;
        var max = Math.max(0, this.items.length * this.step - this.layout.gap - room + (wide ? wide.w - this.shape.w : 0));
        // A wide row puts the focused tile at the margin
        var first = Math.max(0, this.focusIndex - (wide ? 0 : 1));
        while (first > 0 && (first - 1) * this.step >= max) {
            first--;
        }
        translate(this.strip, -first * this.step, 0);
        for (var i = Math.min(first, this.first); i < Math.max(first, this.first); i++) {
            var tile = this.tiles[i];
            if (tile) {
                toggleClass(tile.el, 'bd-tile--gone', i < first);
            }
        }
        this.first = first;
    }
}

/** Sets a tile's label; icon: TileItem.labelIcon */
function labelTile(tile: Tile, text: string, icon?: string): void {
    if (text && !tile.label) {
        tile.label = tile.frame.appendChild(h('div', icon ? 'bd-tile-label bd-tile-label--' + icon : 'bd-tile-label')) as HTMLElement;
    }
    if (tile.label) {
        setText(tile.label, text);
        tile.label.style.display = text ? '' : 'none';
    }
}

/** Sets a tile's progress bar (created under its label; 0 hides it) */
function progressTile(tile: Tile, progress: number): void {
    if (progress && !tile.bar) {
        var bar = tile.frame.insertBefore(h('div', 'bd-tile-progress'), tile.label) as HTMLElement;
        tile.bar = bar.appendChild(h('div', 'bd-tile-progress-fill')) as HTMLElement;
    }
    if (tile.bar) {
        tile.bar.style.width = Math.round(Math.min(1, progress) * 100) + '%';
        (tile.bar.parentNode as HTMLElement).style.display = progress ? '' : 'none';
    }
}

/** Sizes a tile to shape (round: a centred square image as tall as the shape) */
function sizeTile(tile: Tile, shape: TileShape, round: boolean): void {
    tile.el.style.width = shape.w + 'px';
    tile.frame.style.width = tile.under.style.width = (round ? shape.h : shape.w) + 'px';
    tile.frame.style.height = tile.under.style.height = shape.h + 'px';
    if (round) {
        tile.frame.style.marginLeft = tile.under.style.marginLeft = (shape.w - shape.h) / 2 + 'px';
    }
}

/** img's error handler: tries the fallback once (not again if it fails too) */
function fallBack(img: HTMLImageElement, fallback: string): () => void {
    return function () {
        if (img.getAttribute('src') !== fallback) {
            img.src = fallback;
        }
    };
}

function buildTile(item: TileItem, shape: TileShape, textH: number): Tile {
    var el = h('div', item.round ? 'bd-tile bd-tile--round' : 'bd-tile');
    (item.stack || []).forEach(function (color, i) {
        var edge = el.appendChild(h('div', 'bd-tile-stack bd-tile-stack--' + i)) as HTMLElement;
        edge.style.backgroundColor = color;
    });
    // Empty element behind the image, same size: the theme draws the focus shadow on it
    var under = h('div', 'bd-tile-under');
    el.appendChild(under);
    var frame = h('div', 'bd-tile-frame');
    el.appendChild(frame);
    var img = h('img', 'bd-tile-img bd-fade') as HTMLImageElement;
    frame.appendChild(img);
    var seeAll = item.more !== undefined;
    if (seeAll) {
        // "See all": the image dimmed by the theme, the text over it
        var more = h('div', 'bd-tile-more');
        more.appendChild(h('div', 'bd-tile-more-title', item.title));
        more.appendChild(h('div', 'bd-tile-more-count', item.more));
        frame.appendChild(more);
    }
    var title = h('div', 'bd-tile-title', seeAll ? '' : item.title);
    if (item.lines) {
        // Title and lines: the theme lays them out in the space under the image
        el.appendChild(title);
        item.lines.forEach(function (line, i) {
            var chips = i === item.lines!.length - 1 ? item.chips : null;
            if (!chips) {
                el.appendChild(h('div', 'bd-tile-line', line));
                return;
            }
            var lineEl = el.appendChild(h('div', 'bd-tile-line')) as HTMLElement;
            chips.forEach(function (chip) {
                lineEl.appendChild(h('span', chip === item.offerChip ? 'bd-tile-chip bd-tile-chip--offer' : 'bd-tile-chip', chip));
            });
            lineEl.appendChild(document.createTextNode(line));
        });
    } else {
        title.style.height = title.style.lineHeight = textH + 'px';
        el.appendChild(title);
    }
    var tile: Tile = { el: el, under: under, frame: frame, img: img, hasImage: false, label: null, bar: null };
    sizeTile(tile, shape, !!item.round);
    if (item.progress) {
        progressTile(tile, item.progress);
    }
    if (item.label) {
        labelTile(tile, item.label, item.labelIcon);
    }
    return tile;
}
