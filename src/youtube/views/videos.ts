// Video rows right of the rail: YouTube's shelves (api/feed.ts) as tile rows
// in a row stack. FeedView is a screen fetched when first shown (Home,
// Subscriptions, Library, a page opened from a tile); a long list (History,
// a playlist) shows as a grid, a page's tabs as pills. More loads as focus
// nears an end. Cached rows (api/kept-rows.ts) show at once while fresh ones
// load; fresh rows replace them only while a video covers the screen or it
// is hidden, keeping focus on the same video. Rows older than REFRESH_MS are
// refreshed the same way.

import { h, LAYOUT_HEIGHT, LAYOUT_WIDTH, setShown, setText, toggleClass, translate } from '../../core/dom.js';
import { KEY } from '../../core/keys.js';
import { canListen } from '../../core/platform.js';
import { mark } from '../../core/perf.js';
import { View } from '../../core/view.js';
import { RowStack } from '../../ui/row-stack.js';
import { rowHeight, TileItem, TileLayout, TileRow } from '../../ui/tile-row.js';
import { dearrowFetch, dearrowListen, dearrowOn, dearrowPicture, dearrowSettings, dearrowTitle, dearrowWait } from '../api/dearrow.js';
import { more, Nudge, PageButton, Rows, Shelf, Tab, thumbnail, thumbnailFallback, Video } from '../api/feed.js';
import { Pills } from '../ui/pills.js';
import { FillLoader, LOGO } from '../ui/fill-loader.js';
import { icon } from '../ui/icons.js';
import { metrics, RowSpacing, themed, word } from '../ui/theme.js';

/** The loading sign fills at its theme pace (~1.2 s, about when Home's rows usually arrive) */
var LOADING_FILL = 1;
/** The app's icons for the iconTypes of YouTube's page buttons */
var BUTTON_ICONS: { [iconType: string]: string } = {
    MENU_FILTER: 'filter',
    ARROW_PAUSE: 'pausecircle',
    ARROW_PLAY: 'playcircle',
    CLEAR_WATCH_HISTORY: 'delete',
    LOOP: 'loop',
    SHUFFLE: 'shuffle'
};

/** More is fetched once focus is this near the end (a row's tiles; rows; grid lines of three tiles, passed
 * quickly), part after part until that much is ready. Subscriptions' parts are one row each (~92 KB, 0.2-0.4 s),
 * so fetching only at the end lets focus outrun the rows */
var TILES_AHEAD = 6;
var ROWS_AHEAD = 3;
var LINES_AHEAD = 4;
/** Consecutive empty parts before fetching stops (until focus moves) */
var EMPTY_PARTS = 3;
/** Rows this old are refreshed behind the ones shown (Subscriptions sooner: main.ts) */
var REFRESH_MS = 60 * 60 * 1000;

/** A screen passed through on the rail fetches its first rows only after showing this long */
var REST_MS = 300;
/** ui/icons.ts names for the iconTypes on a page's chips */
var TAB_ICONS: { [iconType: string]: string } = { SEARCH_HISTORY: 'history', PLAYLISTS: 'playlist', ALBUM: 'album', LIKE: 'liked', SUBSCRIPTIONS: 'subscriptions' };
/** Faint placeholder tiles under an empty page's message (a screen's worth, as YouTube shows) */
var EMPTY_TILES = 4;
/** Rows drawn off screen (a screen built ahead, fresh rows replacing hidden ones) keep their images this long, so
 * they are cached when shown, then release them like a hidden screen */
var HIDDEN_IMAGES_MS = 4000;

/** A copy of rows with video inserted in shelf s (or the last) at index i (for rows that lack it) */
function withVideo(rows: Rows, video: Video, s: number, i: number): Rows {
    if (!rows.shelves.length) {
        return rows;
    }
    var shelves = rows.shelves.slice();
    var at = Math.min(s, shelves.length - 1);
    var shelf = copied(shelves[at]);
    shelf.videos = shelf.videos.slice();
    shelf.videos.splice(Math.min(i, shelf.videos.length), 0, video);
    shelves[at] = shelf;
    // Everything else unchanged: a playlist's style, side and buttons
    var put = copied(rows);
    put.shelves = shelves;
    return put;
}

/** A shallow copy of o */
function copied<T>(o: T): T {
    var c: any = {};
    for (var k in o) {
        c[k] = (o as any)[k];
    }
    return c as T;
}

/** The shelves' video ids in order (equal ids: nothing to redraw) */
function idsOf(shelves: Shelf[]): string {
    return shelves.map(function (s) {
        return s.videos.map(function (v) { return v.id; }).join(',');
    }).join('|');
}

/** Progress and stop time of videos watched in the app's player (History on): shown on their tiles everywhere
 * (YouTube's rows only reflect it when refetched), and OK resumes from there */
var watched: { [id: string]: { progress: number; t: number } } = {};
/** Watched this far: restart from the beginning (as YouTube does) */
var WATCHED_ALL = 0.95;

export function noteWatched(id: string, progress: number, t: number): void {
    watched[id] = { progress: progress, t: t };
}

/** Where a video watched in the app stopped (-1: not watched here; 0: watched to the end) */
export function watchedAt(id: string): number {
    var w = watched[id];
    return !w ? -1 : w.progress >= WATCHED_ALL ? 0 : w.t;
}

/** Height of one row in the theme's sizes */
export function rowH(): number {
    var m = metrics();
    return rowHeight(m.tile, false, m.rows);
}

/** Grows rows as focus nears their end, one part at a time: a row's next tiles, the next shelves, or a grid's next
 * tiles */
export class Paging {
    /** The shelves shown, by row (a row's continuation token is its shelf's) */
    shelves: Shelf[] = [];
    /** Continuation token for more shelves (for a grid: its next tiles) */
    private next = '';
    /** Adds a grid's next tiles (null: rows of shelves) */
    private lines: ((videos: Video[]) => void) | null = null;
    private fetching = false;
    /** Incremented when the rows change, so late replies for old rows are dropped */
    private gen = 0;
    /** Consecutive parts that brought no rows */
    private empties = 0;

    /** from: the endpoint the tokens are sent to (api/feed.ts more) */
    constructor(private tiles: VideoTiles, private from?: string) {}

    /** Other rows are coming: drop replies for the current ones */
    stop(): void {
        this.gen++;
        this.fetching = false;
    }

    /** Sets the rows shown: their shelves and continuation token (lines: for a grid, adds its tiles) */
    set(shelves: Shelf[], next: string, lines?: (videos: Video[]) => void): void {
        this.stop();
        this.shelves = shelves;
        this.next = next;
        this.lines = lines || null;
    }

    /** Sets the continuation token for more shelves (or a grid's tiles) */
    setNext(next: string): void {
        // Drop a pending reply for the old token
        this.stop();
        this.next = next;
    }

    /** Removes video id's tiles from stack's rows at once (removed from History, Not interested): each affected row
     * is rebuilt without it (an emptied row is removed), with focus on the tile now in its place */
    drop(stack: RowStack, id: string): void {
        // A pending fetch for the old row is dropped; it is retried as focus moves
        this.stop();
        // From the end, so removing a row leaves the earlier indexes valid
        for (var r = stack.rows.length - 1; r >= 0; r--) {
            var row = stack.rows[r];
            var gone = row.items.map(function (item) { return item.id; }).indexOf(id);
            var shelf = this.shelves[r];
            if (gone < 0 || !shelf) {
                continue;
            }
            var self = this;
            shelf.videos = row.items.filter(function (item) { return item.id !== id; })
                .map(function (item) { return self.tiles.video(item) as Video; }).filter(function (v) { return !!v; });
            if (!shelf.videos.length) {
                stack.remove(row);
                this.shelves.splice(r, 1);
                continue;
            }
            var fresh = this.tiles.rows([shelf], false)[0];
            stack.replace(row, fresh);
            fresh.focusAt(Math.min(row.index > gone ? row.index - 1 : row.index, fresh.count - 1));
        }
        stack.focusRow(stack.index);
    }

    /** Focus moved in stack (across: within a row): near an end with more available, fetches the next part */
    ahead(stack: RowStack, across: boolean): void {
        var row = stack.row;
        var shelf = across && !this.lines ? this.shelves[stack.index] : null;
        var token = shelf ? (row && row.index >= row.count - 1 - TILES_AHEAD && shelf.next) || '' :
            stack.index >= stack.rows.length - 1 - (this.lines ? LINES_AHEAD : ROWS_AHEAD) ? this.next : '';
        if (!token || this.fetching) {
            return;
        }
        this.fetching = true;
        var gen = this.gen;
        var self = this;
        more(token, this.from).then(function (rows) {
            if (gen !== self.gen) {
                return;
            }
            self.fetching = false;
            var first = rows.shelves[0];
            if (self.lines) {
                self.next = first && first.next || rows.next || '';
                self.lines(first ? first.videos : []);
            } else if (shelf) {
                // The row's next tiles (a search row comes back as a section, whose token may be the section's)
                shelf.next = first && first.next || rows.next || '';
                (row as TileRow).append(self.tiles.items(first ? first.videos : []));
            } else {
                self.next = rows.next;
                self.shelves = self.shelves.concat(rows.shelves);
                stack.addAll(self.tiles.rows(rows.shelves, false));
            }
            // Fetch the next part at once until enough are ready below focus (not within a row: its tiles load as
            // focus moves along)
            self.empties = rows.shelves.length ? 0 : self.empties + 1;
            if (!shelf && self.empties < EMPTY_PARTS) {
                self.ahead(stack, false);
            }
        }, function () {
            // Retried when focus moves next
            if (gen === self.gen) {
                self.fetching = false;
            }
        });
    }
}

/** The longest a page waits for DeArrow's branding of its first screen before it draws (the rest come into their tiles
 * as they arrive) */
var DEARROW_WAIT_MS = 500;

/** Rows, once DeArrow's branding of their first screen (the first two rows' first six tiles) is in or
 * DEARROW_WAIT_MS passed (at once with DeArrow off) */
export function brandedRows(rows: Rows): Promise<Rows> {
    if (!dearrowOn()) {
        return Promise.resolve(rows);
    }
    var videos: Video[] = [];
    rows.shelves.slice(0, 2).forEach(function (shelf) {
        videos = videos.concat(shelf.videos.slice(0, 6));
    });
    return dearrowWait(videos, DEARROW_WAIT_MS).then(function () { return rows; });
}

/** A video's own picture: its poster, the picture YouTube gave it, else its thumbnail */
function ownImage(v: Video): string {
    return v.poster || v.image || thumbnail(v.id);
}

/** Builds tile rows for shelves and maps tiles back to their videos */
export class VideoTiles {
    /** Left margin of the rows (0: the theme's; a channel page has no rail and uses YouTube's 64) */
    pad = 0;
    /** Enlarge the focused row's tiles (Home) */
    big = false;
    /** Row spacing (null: the theme's lineRows off Home; Home's own) */
    spacing: RowSpacing | null = null;
    /** The rows the tiles show in now (the view's: its stack's), which DeArrow's branding goes into as it arrives */
    shown: () => TileRow[] = function () { return []; };
    private videos: { [id: string]: Video } = {};
    /** The videos whose DeArrow branding is still to come, how many, and the listener for it */
    private branding: { [id: string]: boolean } = {};
    private pending = 0;
    private unlisten: (() => void) | null = null;
    /** The DeArrow settings the tiles were made with */
    private brandedAs = '';

    /** fresh: forget the videos of the previous rows */
    rows(shelves: Shelf[], fresh: boolean): TileRow[] {
        var self = this;
        var m = metrics();
        if (fresh) {
            this.reset();
        }
        // The theme's layout at the requested margin; off Home, a row without a subtitle sits higher and one with it is
        // taller (as YouTube's: metrics.lineRows)
        var layout = this.pad ? layoutWith(m.rows, { pad: this.pad }) : m.rows;
        var lines = this.spacing || (this.big ? null : { pitch: rowH(), plainHead: m.rows.head - m.lineRows.plainUp, taller: m.lineRows.taller });
        var plain = layout;
        if (lines) {
            // Each row spans the pitch: a plain row's tiles at plainHead, a subtitled row's at head and taller
            plain = layoutWith(layout, { head: lines.plainHead, rowGap: lines.pitch - lines.plainHead - m.tile.h - layout.under });
            layout = layoutWith(layout, { rowGap: lines.pitch - layout.head - m.tile.h - layout.under });
        }
        return shelves.map(function (shelf) {
            // Square tiles (podcasts, releases) or game boxes, as tall as the others (rows keep one height); posters
            // (Movies) with the focused one wide
            var shape = shelf.style === 'square' || shelf.style === 'round' ? m.square : shelf.style === 'game' ? m.game : shelf.style === 'poster' ? m.poster : m.tile;
            return new TileRow({ title: word(shelf.title), subtitle: shelf.subtitle, icon: shelf.icon, shape: shape, layout: shelf.subtitle ? layout : plain,
                extraHeight: shelf.subtitle && lines ? lines.taller : 0,
                items: self.items(shelf.videos), noWrap: true, bigShape: self.big && shape === m.tile ? m.big : undefined,
                wideShape: shape === m.poster ? m.posterWide : undefined, lazy: true });
        });
    }

    /** Forgets the videos of the previous tiles (all are made anew) */
    reset(): void {
        this.videos = {};
        this.brandedAs = dearrowSettings();
    }

    /** Tiles for videos (duplicates skipped), with DeArrow's titles and pictures where it has them (YouTube's
     * thumbnail stays the fallback) */
    items(videos: Video[]): TileItem[] {
        var self = this;
        var seen: { [id: string]: boolean } = {};
        var items: TileItem[] = [];
        videos.forEach(function (v) {
            if (!seen[v.id]) {
                seen[v.id] = true;
                self.videos[v.id] = v;
                var image = v.page ? v.image || '' : ownImage(v);
                var branded = v.page || v.poster ? image : dearrowPicture(v.id, image);
                // A page without an image: its name on the tile, like a "See all" tile
                items.push(v.page && !v.image ? { id: v.id, title: v.title, image: '', more: '' } : {
                    id: v.id, title: v.page ? v.title : dearrowTitle(v.id, v.title), image: branded,
                    fallback: v.page ? '' : thumbnailFallback(v.id) || (branded !== image ? image : ''),
                    wideImage: v.poster ? v.wide || thumbnail(v.id) : undefined,
                    label: v.live ? 'LIVE' : v.audio && v.length ? '\u266a ' + v.length : v.length, labelIcon: v.labelIcon, stack: v.stack,
                    lines: [v.channel, themed(v.info)], progress: watched[v.id] ? watched[v.id].progress : v.progress, round: v.round,
                    // In the theme's wording (e.g. "CC" as YouTube's TV app writes it)
                    chips: v.badges && v.badges.map(word), offerChip: v.offer && word(v.offer)
                });
            }
        });
        if (dearrowOn()) {
            this.brand(videos);
        }
        return items;
    }

    /** DeArrow's branding asked for where not known yet; the tiles get it as it arrives */
    private brand(videos: Video[]): void {
        var self = this;
        dearrowFetch(videos).forEach(function (id) {
            if (!self.branding[id]) {
                self.branding[id] = true;
                self.pending++;
            }
        });
        if (!this.unlisten && this.pending) {
            this.unlisten = dearrowListen(function (id) { self.branded(id); });
        }
    }

    /** Video id's DeArrow branding arrived: its tiles take it (the listener stops once nothing more is to come) */
    private branded(id: string): void {
        if (!this.branding[id]) {
            return;
        }
        delete this.branding[id];
        this.pending--;
        this.apply(id);
        if (!this.pending && this.unlisten) {
            this.unlisten();
            this.unlisten = null;
        }
    }

    /** The tiles made again with DeArrow's settings if they changed since (a screen shown again after Settings) */
    rebrand(): void {
        if (this.brandedAs === dearrowSettings()) {
            return;
        }
        this.brandedAs = dearrowSettings();
        var self = this;
        var videos = Object.keys(this.videos).map(function (id) { return self.videos[id]; }).filter(function (v) { return !v.page; });
        videos.forEach(function (v) { self.apply(v.id); });
        if (dearrowOn()) {
            this.brand(videos);
        }
    }

    /** Video id's tiles with its title and picture as DeArrow's settings now give them */
    private apply(id: string): void {
        var v = this.videos[id];
        if (v && !v.page) {
            var title = dearrowTitle(id, v.title);
            var own = ownImage(v);
            var image = v.poster ? undefined : dearrowPicture(id, own);
            var fallback = thumbnailFallback(id) || (image !== own ? own : '');
            this.shown().forEach(function (row) {
                row.retitle(id, title, image, fallback);
            });
        }
    }

    video(item: TileItem | null): Video | null {
        return item ? this.videos[item.id] || null : null;
    }

    /** Sets video id's watched fraction (0-1), also on its tiles in stack */
    setProgress(stack: RowStack, id: string, progress: number): void {
        if (this.videos[id]) {
            this.videos[id].progress = progress;
        }
        stack.rows.forEach(function (row) {
            row.setProgress(id, progress);
        });
    }
}

/** YouTube's search bar (OK opens Search) with its microphone beside it. The microphone can be focused where the
 * device has speech recognition (Android): Left on the bar goes to it, OK there searches by voice. more: class
 * prefix for its placement */
export class SearchBar {
    private bar: HTMLElement;
    private mic: HTMLElement;
    private onMic = false;

    /** search: OK pressed (voice: on the microphone) */
    constructor(parent: HTMLElement, more: string, private search: (voice: boolean) => void) {
        this.mic = icon('mic', 'by-search-mic' + (more ? ' ' + more + '-mic' : ''));
        parent.appendChild(this.mic);
        this.bar = h('div', 'by-search-bar' + (more ? ' ' + more + '-bar' : ''));
        this.bar.appendChild(h('span', '', 'Search'));
        parent.appendChild(this.bar);
    }

    setFocused(focused: boolean): void {
        toggleClass(this.bar, 'by-search-bar--focused', focused && !this.onMic);
        toggleClass(this.mic, 'by-search-mic--focused', focused && this.onMic);
    }

    /** OK searches, Left and Right move between the microphone and the bar; false: not handled (Left from the
     * microphone, or from the bar when there is no microphone to go to; Down, after which the focus comes back to
     * the bar) */
    onKey(code: number): boolean {
        switch (code) {
            case KEY.OK:
                this.search(this.onMic);
                return true;
            case KEY.LEFT:
            case KEY.RIGHT:
                var mic = code === KEY.LEFT;
                if (mic === this.onMic || mic && !listens()) {
                    return !mic;
                }
                this.onMic = mic;
                this.setFocused(true);
                return true;
            case KEY.DOWN:
                this.onMic = false;
                return false;
        }
        return false;
    }
}

/** The device has speech recognition (asked once: on Android each ask is a call into the system) */
var listening: boolean | null = null;
function listens(): boolean {
    if (listening === null) {
        listening = canListen();
    }
    return listening;
}

/** A copy of layout with some values changed */
function layoutWith(layout: TileLayout, changes: { [key: string]: number }): TileLayout {
    var made = {} as TileLayout;
    for (var key in layout) {
        (made as any)[key] = (layout as any)[key];
    }
    for (var k in changes) {
        (made as any)[k] = changes[k];
    }
    return made;
}

/** Restarts el's quick fade-in (the theme's by-fade-in) */
export function fadeIn(el: HTMLElement): void {
    toggleClass(el, 'by-fade-in', false);
    void el.offsetWidth;
    toggleClass(el, 'by-fade-in', true);
}

/** A screen's cached rows, and a check (run once they show) whether they belong to the current account */
export interface KeptFeed {
    rows: Rows;
    same: () => Promise<boolean>;
}

export interface FeedOptions {
    /** The cached rows (null: none) */
    kept?: () => KeptFeed | null;
    /** Rows this old are refreshed behind the ones shown (default REFRESH_MS) */
    refreshMs?: number;
    /** Show the logo loader while the first rows load without a cache (the start screen only) */
    logo?: boolean;
    /** Fade the rows in as they arrive (a page: no loader while it loads) */
    fade?: boolean;
    /** A search bar above the first row, as on YouTube's Home: called on OK */
    onSearch?: (voice: boolean) => void;
    /** One of the buttons of YouTube's message shown instead of rows (Rows.nudge): called on OK */
    onNudge?: (command: any, view: FeedView) => void;
    /** A page over a section (History, a playlist, a channel's sub page), as in YouTube's TV app: no rail, a round back
     * arrow at the left (Left at the first tile; OK goes back), its title smaller at the top */
    page?: { back: () => void };
    /** One of the page's buttons (Rows.buttons: History's All, Pause watch history, Clear all): called on OK */
    onButton?: (button: PageButton, view: FeedView) => void;
    /** Left margin of the rows (default: the rail's width) */
    pad?: number;
    /** Enlarge the focused row's tiles (YouTube's Home: 480 px, the rows below shift down) */
    big?: boolean;
    /** Row spacing (Library's own; default: the theme's) */
    spacing?: RowSpacing;
}

export interface FeedTexts {
    /** Nothing to show (YouTube's current wording) */
    empty: string;
    /** No account to fetch for (the last YouTube session was a guest) */
    noAccount: string;
    failed: string;
}

export class FeedView implements View {
    el: HTMLElement;
    private status: HTMLElement;
    /** A grid's title above its first line, with its tabs beside it */
    private heading: HTMLElement;
    private headingText: HTMLElement;
    private tabsEl: HTMLElement;
    private tabs: Tab[] = [];
    private tabPills = new Pills('by-tab--focused');
    /** YouTube's message shown instead of rows (null: none) and its buttons (focused while it shows) */
    private nudge: Nudge | null = null;
    private nudgeEl: HTMLElement;
    /** YouTube's message for an empty page, over faint tiles (Rows.empty) */
    private emptyEl: HTMLElement;
    private nudgePills = new Pills('by-nudge-button--focused');
    /** The page's buttons (Rows.buttons), at the top right */
    private buttonsEl: HTMLElement;
    private buttons: PageButton[] = [];
    private buttonPills = new Pills('by-page-button--focused');
    /** A page's back arrow (null: not a page) */
    private back: HTMLElement | null = null;
    /** Focus target: the rows (or grid lines), the tabs or buttons above a grid, Home's search bar, or a page's back
     * arrow */
    private at: 'rows' | 'tabs' | 'buttons' | 'bar' | 'back' = 'rows';
    /** Home's search bar, fixed above the rows (null: none) */
    private bar: SearchBar | null = null;
    /** The video played from here: its tile stays when fresh rows replace the ones under it */
    private played = '';
    private restTimer = 0;
    private stack: RowStack;
    private tiles = new VideoTiles();
    private paging = new Paging(this.tiles);
    /** The shelf shown as a grid (one long list); list: a playlist, one video per line beside its side column, as on
     * YouTube */
    private grid: Shelf | null = null;
    private list = false;
    /** A playlist's line under its title (Rows.side) */
    private byline: HTMLElement;
    /** The column kept by Up/Down in a grid */
    private col = 0;
    /** Incremented on every fetch, so a late reply for an older one is dropped */
    private gen = 0;
    /** Fetched (or in flight), and whether that failed */
    private asked = false;
    private failed = false;
    private focused = true;
    private shown = false;
    /** Its rows (or the message shown instead) are in */
    settled = false;
    private loader: FillLoader;
    /** Showing older rows (cached or aged) while fresh ones load or wait to replace them */
    private stale = false;
    private fresh: { rows: Rows | null; at: number } | null = null;
    /** Cached rows shown before the account check has confirmed them */
    private unchecked: KeptFeed | null = null;
    /** A video covers the screen */
    private covered = false;
    /** A fetch is in flight; when the rows arrived (0: never, or cached ones) */
    private loading = false;
    private fetchedAt = 0;

    /** load: fetches the rows, or null when there is no account; open: called on OK on a tile */
    constructor(private load: (renew?: boolean) => Promise<Rows | null>, private texts: FeedTexts, private open: (video: Video) => void,
        private opts: FeedOptions = {}) {
        this.tiles.pad = opts.pad || 0;
        this.tiles.big = !!opts.big;
        this.tiles.spacing = opts.spacing || null;
        var self = this;
        this.tiles.shown = function () { return self.stack.rows; };
        this.el = h('div', 'bd-page');
        setShown(this.el, false);
        this.stack = this.newStack(false);
        this.heading = h('div', 'by-heading');
        this.headingText = h('span', 'by-heading-text');
        this.tabsEl = h('span', 'by-tabs');
        this.heading.appendChild(this.headingText);
        this.heading.appendChild(this.tabsEl);
        setShown(this.heading, false);
        this.el.appendChild(this.heading);
        this.byline = h('div', 'by-page-byline');
        this.el.appendChild(this.byline);
        this.buttonsEl = h('div', 'by-page-buttons');
        this.el.appendChild(this.buttonsEl);
        if (opts.big) {
            this.el.className += ' bd-page--big';
        }
        if (opts.page) {
            this.el.className += ' bd-page--page';
            this.back = icon('back', 'by-page-back');
            this.el.appendChild(this.back);
        }
        this.status = h('div', 'by-status');
        this.el.appendChild(this.status);
        this.nudgeEl = h('div', 'by-nudge');
        setShown(this.nudgeEl, false);
        this.el.appendChild(this.nudgeEl);
        this.emptyEl = h('div', 'by-empty');
        setShown(this.emptyEl, false);
        this.el.appendChild(this.emptyEl);
        this.loader = new FillLoader(this.el, false);
        if (opts.onSearch) {
            // Covers the rows scrolling up under the bar
            this.el.appendChild(h('div', 'by-feed-top'));
            this.bar = new SearchBar(this.el, '', opts.onSearch);
        }
    }

    /** rest: shown in passing (moving through the rail): fetch only after it has shown for REST_MS */
    show(rest?: boolean): void {
        this.shown = true;
        this.covered = false;
        this.tiles.rebrand();
        setShown(this.el, true);
        this.stack.setShown(true);
        if (!this.asked) {
            this.fetch(false, rest);
        } else {
            this.renewIfOld(rest);
        }
    }

    /** Refetches old rows behind the ones shown (swapped in once out of view) */
    renewIfOld(rest?: boolean): void {
        if (this.fetchedAt && !this.loading && !this.stale && Date.now() - this.fetchedAt >= (this.opts.refreshMs || REFRESH_MS)) {
            this.fetch(true, rest);
        }
    }

    /** A video covers the screen (or stops covering it): while covered, fresh rows are swapped in and old ones
     * refetched */
    cover(covered: boolean): void {
        this.covered = covered;
        if (covered) {
            this.renewIfOld();
            this.freshen();
        } else {
            this.aheadInSight();
        }
    }

    hide(): void {
        this.shown = false;
        setShown(this.el, false);
        this.stack.setShown(false);
        this.freshen();
    }

    /** Out of view for now (the app goes to the background): swap in waiting fresh rows */
    putFresh(): void {
        this.freshen();
    }

    /** A video was just played: its tiles show the progress before YouTube's rows reflect it */
    setProgress(id: string, progress: number): void {
        this.tiles.setProgress(this.stack, id, progress);
    }

    /** Removes video id's tiles at once (YouTube removed it); a grid's lines are refilled after it */
    removeVideo(id: string): void {
        if (!this.grid) {
            this.paging.drop(this.stack, id);
            this.taken();
            return;
        }
        // Rebuild its line and the following ones, shifted one tile back (the full lines before it stay)
        var stack = this.stack;
        var line = -1;
        for (var r = 0; r < stack.rows.length && line < 0; r++) {
            if (stack.rows[r].items.some(function (item) { return item.id === id; })) {
                line = r;
            }
        }
        if (line < 0) {
            return;
        }
        var perLine = stack.rows[0].count;
        var before = line * perLine;
        var at = stack.index * perLine + (stack.row ? stack.row.index : 0);
        var items: TileItem[] = [];
        for (var k = line; k < stack.rows.length; k++) {
            items = items.concat(stack.rows[k].items);
        }
        var gone = before + items.map(function (item) { return item.id; }).indexOf(id);
        items = items.filter(function (item) { return item.id !== id; });
        this.grid.videos = this.grid.videos.filter(function (v) { return v.id !== id; });
        at = Math.min(gone < at ? at - 1 : at, before + items.length - 1);
        stack.setRows(stack.rows.slice(0, line));
        this.addLines(items);
        // Focus the tile now in the same position
        var focusLine = Math.floor(at / perLine);
        if (stack.rows[focusLine]) {
            stack.rows[focusLine].focusAt(at % perLine);
            this.col = at % perLine;
            stack.focusRow(focusLine);
        }
        this.taken();
    }

    /** After a tile is removed: scrolls to the focus; with no rows left, shows the empty message */
    private taken(): void {
        if (!this.hasRows) {
            setText(this.status, this.texts.empty);
        }
        this.place();
    }

    setFocused(focused: boolean): void {
        this.focused = focused;
        this.stack.setFocused(focused && this.at === 'rows');
        this.tabPills.setFocused(focused && this.at === 'tabs');
        this.buttonPills.setFocused(focused && this.at === 'buttons');
        if (this.back) {
            toggleClass(this.back, 'by-page-back--focused', focused && this.at === 'back');
        }
        this.nudgePills.setFocused(focused && this.at === 'rows' && !!this.nudge);
        if (this.bar) {
            this.bar.setFocused(focused && this.at === 'bar');
        }
    }

    /** quiet: an automatic periodic retry, so the current message stays until the reply */
    retry(quiet?: boolean): boolean {
        if (!this.failed) {
            return false;
        }
        this.fetch(false, false, quiet);
        return true;
    }

    onKey(code: number): boolean {
        if (this.at === 'tabs') {
            return this.tabKey(code);
        }
        if (this.at === 'buttons') {
            return this.buttonKey(code);
        }
        if (this.at === 'back') {
            return this.backKey(code);
        }
        if (this.at === 'bar') {
            return this.barKey(code);
        }
        if (this.nudge) {
            return this.nudgeKey(code);
        }
        var row = this.stack.row;
        switch (code) {
            case KEY.LEFT:
            case KEY.RIGHT:
                if (!row || !row.move(code === KEY.LEFT ? -1 : 1)) {
                    // Right at a grid line's end continues at the next line's start; Left at its start goes to the rail
                    if (code === KEY.RIGHT && this.grid && !this.list && this.stack.move(1)) {
                        this.col = 0;
                        (this.stack.row as TileRow).focusAt(0);
                        this.place();
                        this.paging.ahead(this.stack, false);
                        return true;
                    }
                    // Left in a playlist: the side column's buttons
                    if (code === KEY.LEFT && this.list && this.buttonPills.count) {
                        this.goTo('buttons');
                        return true;
                    }
                    // Left at the first tile: a page's back arrow (pages have no rail; playlists have no arrow)
                    if (code === KEY.LEFT && this.back && !this.list) {
                        this.goTo('back');
                        return true;
                    }
                    return false;
                }
                this.col = row.index;
                this.paging.ahead(this.stack, true);
                return true;
            case KEY.UP:
            case KEY.DOWN:
                if (!this.stack.move(code === KEY.UP ? -1 : 1)) {
                    // Up from a grid's first line: its tabs or buttons; from the first row: the search bar
                    if (code === KEY.UP && this.grid && this.tabPills.count) {
                        this.focusTabs(true);
                        return true;
                    }
                    if (code === KEY.UP && this.buttonPills.count && !this.list) {
                        this.goTo('buttons');
                        return true;
                    }
                    if (code === KEY.UP && this.bar && !this.grid) {
                        this.at = 'bar';
                        this.setFocused(this.focused);
                        return true;
                    }
                    // Down at the end retries a failed fetch for more
                    if (code === KEY.DOWN) {
                        this.paging.ahead(this.stack, false);
                    }
                    return false;
                }
                if (this.grid && this.stack.row) {
                    this.stack.row.focusAt(this.col);
                }
                this.place();
                this.paging.ahead(this.stack, false);
                return true;
            case KEY.OK:
                // Prefer the waiting fresh rows' copy (it has YouTube's current resume point)
                var video = this.freshVideo(row ? row.focused : null) || this.tiles.video(row ? row.focused : null);
                if (video) {
                    this.played = video.id;
                    this.open(video);
                }
                return true;
        }
        return false;
    }

    /** It has rows (or grid lines) to focus */
    get hasRows(): boolean {
        return this.stack.rows.length > 0;
    }

    /** The focused row (or grid line) index */
    get rowIndex(): number {
        return this.stack.index;
    }

    /** Shows rows at once in place of the current ones (a filter of its rows: Subscriptions' pills); waiting fresh
     * rows count as shown, and a fetch in flight still arrives */
    showRows(rows: Rows): void {
        if (this.fresh) {
            this.fetchedAt = this.fresh.at;
            this.fresh = null;
            this.stale = false;
        }
        this.draw(rows);
        this.stack.focusRow(0);
        this.place();
    }

    /** The video (or page) whose tile has the focus */
    focusedVideo(): Video | null {
        var row = this.stack.row;
        return this.focused && this.at === 'rows' && row ? this.tiles.video(row.focused) : null;
    }

    /** Keys on the tabs: Left/Right move along them, OK fetches one, Down returns to the grid */
    private tabKey(code: number): boolean {
        switch (code) {
            case KEY.LEFT:
            case KEY.RIGHT:
                // Left past the first goes to the rail
                return this.tabPills.move(code === KEY.LEFT ? -1 : 1) || code === KEY.RIGHT;
            case KEY.OK:
                this.tabPills.press();
                return true;
            case KEY.DOWN:
                this.focusTabs(false);
                return true;
            case KEY.UP:
                return true;
        }
        return false;
    }

    /** Keys on YouTube's message: Left/Right move along its buttons, OK presses one, Up goes to the search bar */
    private nudgeKey(code: number): boolean {
        switch (code) {
            case KEY.LEFT:
            case KEY.RIGHT:
                // Left past the first goes to the rail
                return this.nudgePills.move(code === KEY.LEFT ? -1 : 1) || code === KEY.RIGHT;
            case KEY.OK:
                this.nudgePills.press();
                return true;
            case KEY.UP:
                if (this.bar) {
                    this.at = 'bar';
                    this.setFocused(this.focused);
                }
                return true;
            case KEY.DOWN:
                return true;
        }
        return false;
    }

    /** Draws YouTube's message in place of rows (null: removes it) */
    private drawNudge(nudge: Nudge | null): void {
        var self = this;
        this.nudge = nudge;
        this.nudgeEl.innerHTML = '';
        this.nudgePills.clear();
        setShown(this.nudgeEl, !!nudge);
        if (!nudge) {
            return;
        }
        this.nudgeEl.appendChild(h('div', 'by-nudge-title', nudge.title));
        this.nudgeEl.appendChild(h('div', 'by-nudge-text', nudge.subtitle));
        var row = this.nudgeEl.appendChild(h('div', 'by-nudge-buttons')) as HTMLElement;
        nudge.buttons.forEach(function (b, i) {
            if (i > 0 && nudge.or) {
                row.appendChild(h('span', 'by-nudge-or', nudge.or));
            }
            row.appendChild(self.nudgePills.add(h('span', 'by-nudge-button', b.text), function () {
                if (self.opts.onNudge) {
                    self.opts.onNudge(b.command, self);
                }
            }));
        });
        this.nudgePills.focus(0);
        this.setFocused(this.focused);
    }

    /** Draws YouTube's empty-page message ('' none) over faint placeholder tiles, as YouTube does */
    private drawEmpty(text: string): void {
        this.emptyEl.innerHTML = '';
        setShown(this.emptyEl, !!text);
        if (!text) {
            return;
        }
        for (var i = 0; i < EMPTY_TILES; i++) {
            this.emptyEl.appendChild(h('div', 'by-empty-tile by-empty-tile--' + i));
        }
        this.emptyEl.appendChild(h('div', 'by-empty-text', text));
    }

    /** Dismisses YouTube's message (one of its buttons asked to) and shows the empty text instead */
    hideNudge(): void {
        this.drawNudge(null);
        setText(this.status, this.texts.empty);
    }

    /** Keys on the search bar: OK opens Search, Down returns to the first row, Left goes to the rail */
    private barKey(code: number): boolean {
        if (this.bar && this.bar.onKey(code)) {
            return true;
        }
        switch (code) {
            case KEY.DOWN:
                this.at = 'rows';
                this.setFocused(this.focused);
                return true;
            case KEY.UP:
                return true;
        }
        return false;
    }

    /** Keys on the page's buttons: Left/Right move along them, OK presses one, Down returns to the grid */
    private buttonKey(code: number): boolean {
        switch (code) {
            case KEY.LEFT:
            case KEY.RIGHT:
                // In a playlist's side column, Right past the buttons enters the list; Left at the first button stays
                // (as on YouTube, which has no back arrow there)
                if (!this.buttonPills.move(code === KEY.LEFT ? -1 : 1) && this.list && code === KEY.RIGHT) {
                    this.goTo('rows');
                }
                return true;
            case KEY.OK:
                this.buttonPills.press();
                return true;
            case KEY.DOWN:
                this.goTo('rows');
                return true;
            case KEY.UP:
                return true;
        }
        return false;
    }

    /** Keys on a page's back arrow: OK goes back, Right returns to the tiles */
    private backKey(code: number): boolean {
        switch (code) {
            case KEY.OK:
                (this.opts.page as { back: () => void }).back();
                return true;
            case KEY.RIGHT:
                this.goTo('rows');
                return true;
            case KEY.UP:
            case KEY.DOWN:
            case KEY.LEFT:
                return true;
        }
        return false;
    }

    private goTo(at: 'rows' | 'buttons' | 'back'): void {
        this.at = at;
        this.setFocused(this.focused);
    }

    /** Draws the page's buttons, each with icon and text (again when a button's state changes) */
    drawButtons(): void {
        var self = this;
        var at = this.buttonPills.at;
        this.buttonsEl.innerHTML = '';
        this.buttonPills.clear();
        this.buttons.forEach(function (b) {
            var on = b.toggle && b.toggle.on ? 1 : 0;
            var el = h('div', 'by-page-button');
            var name = BUTTON_ICONS[b.toggle ? b.toggle.icons[on] : b.icon];
            if (name) {
                el.appendChild(icon(name, 'by-page-button-icon'));
            }
            el.appendChild(h('span', '', b.toggle ? b.toggle.texts[on] : b.text));
            self.buttonsEl.appendChild(self.buttonPills.add(el, function () {
                if (self.opts.onButton) {
                    self.opts.onButton(b, self);
                }
            }));
        });
        this.buttonPills.focus(Math.max(0, Math.min(at, this.buttons.length - 1)));
        if (!this.buttons.length && this.at === 'buttons') {
            this.at = 'rows';
        }
        this.setFocused(this.focused);
    }

    /** Draws a playlist's byline (with a lock icon when private), or hides it */
    private drawSide(side: { byline: string; private: boolean } | null): void {
        this.byline.innerHTML = '';
        if (side && side.private) {
            this.byline.appendChild(icon('lock', 'by-page-byline-icon'));
        }
        this.byline.appendChild(document.createTextNode(side ? side.byline : ''));
        setShown(this.byline, !!side);
    }

    /** The videos currently shown, in order (a playlist's Repeat plays them) */
    videos(): Video[] {
        var self = this;
        var out: Video[] = [];
        this.stack.rows.forEach(function (row) {
            row.items.forEach(function (item) {
                var v = self.tiles.video(item);
                if (v && !v.page) {
                    out.push(v);
                }
            });
        });
        return out;
    }

    /** Refetches the rows from a new load (e.g. a filter was picked) */
    reloadAs(load: () => Promise<Rows | null>): void {
        this.load = load;
        this.at = 'rows';
        this.reload();
    }

    /** Moves focus to the tabs (the chosen one), or back to the grid */
    private focusTabs(on: boolean): void {
        this.at = on ? 'tabs' : 'rows';
        if (on) {
            for (var i = 0; i < this.tabs.length; i++) {
                if (this.tabs[i].chosen) {
                    this.tabPills.focus(i);
                }
            }
        }
        this.setFocused(this.focused);
    }

    /** Fetches another tab's tiles in place of these (tabs kept, that one chosen) */
    private openTab(tab: Tab): void {
        if (tab.chosen || !tab.token) {
            return;
        }
        var title = this.headingText.textContent || '';
        var tabs = this.tabs.map(function (t) { return { title: t.title, chosen: t === tab, token: t.token }; });
        this.reloadAs(function () {
            return more(tab.token).then(function (rows) {
                rows.title = title;
                rows.tabs = tabs;
                return rows;
            });
        });
    }

    /** Builds the tab chips (none for a single tab), once per fetch */
    private buildTabs(): void {
        var self = this;
        this.tabsEl.innerHTML = '';
        this.tabPills.clear();
        toggleClass(this.el, 'bd-page--tabs', this.tabs.length >= 2);
        if (this.tabs.length < 2) {
            return;
        }
        this.tabs.forEach(function (t) {
            var el = h('span', 'by-tab' + (t.chosen ? ' by-tab--chosen' : ''));
            // Icon before the title, as on YouTube's chips
            if (t.icon && TAB_ICONS[t.icon]) {
                el.appendChild(icon(TAB_ICONS[t.icon], 'by-tab-icon'));
            }
            el.appendChild(h('span', '', t.title));
            self.tabsEl.appendChild(self.tabPills.add(el, function () { self.openTab(t); }));
        });
    }

    /** Drops the rows and refetches them, now if shown, else when shown next (e.g. the account changed) */
    reload(): void {
        this.paging.set([], '');
        this.stack.setRows([]);
        // Clear the status of the old rows too
        setText(this.status, '');
        this.drawNudge(null);
        if (this.shown) {
            this.fetch();
        } else {
            this.gen++;
            this.asked = this.loading = this.stale = false;
            this.fresh = this.unchecked = null;
        }
    }

    /** Fetches the rows. behind: the rows shown stay until fresh ones replace them (as cached rows do); rest: fetch
     * only after showing for REST_MS (cached rows are drawn at once) */
    private fetch(behind?: boolean, rest?: boolean, quiet?: boolean): void {
        var gen = ++this.gen;
        var self = this;
        this.asked = true;
        this.failed = false;
        this.fresh = null;
        this.loading = true;
        // Rows already shown (e.g. cached ones from a skipped fetch) stay until out of view, like old ones
        this.stale = !!behind || this.hasRows;
        if (!behind) {
            this.paging.stop();
            if (!quiet) {
                setText(this.status, '');
            }
            // Cached rows at once while these load (without a cache: the loader, if enabled)
            if (!quiet && !this.drawKept() && this.opts.logo) {
                this.loader.show(LOGO, LOADING_FILL);
            }
        }
        clearTimeout(this.restTimer);
        if (rest) {
            this.restTimer = setTimeout(function () {
                if (gen !== self.gen) {
                    return;
                }
                if (self.shown) {
                    self.ask(gen, behind);
                    return;
                }
                // Passed by: fetch when shown next
                self.gen++;
                self.loading = false;
                if (behind) {
                    self.stale = false;
                } else {
                    self.asked = false;
                }
            }, REST_MS) as unknown as number;
        } else {
            this.ask(gen, behind);
        }
    }

    /** Draws the cached rows (opts.kept, when none are drawn yet) and checks they are the account's (if not, they are
     * removed); false: none */
    private drawKept(): boolean {
        var self = this;
        var kept = this.opts.kept && !this.hasRows ? this.opts.kept() : null;
        try {
            if (kept) {
                this.draw(kept.rows);
            }
        } catch (e) {
            // Cached rows that fail to draw must not block the fetch
            kept = null;
            this.paging.set([], '');
            this.stack.setRows([]);
        }
        if (!kept) {
            return false;
        }
        this.stale = true;
        this.unchecked = kept;
        mark('keptRows');
        // Check failed (youtube.com's page did not load): treat them as not the account's
        var other = function (): void {
            if (self.unchecked === kept) {
                self.unstale();
            }
        };
        kept.same().then(function (same) {
            if (!same) {
                other();
            } else if (self.unchecked === kept) {
                self.unchecked = null;
            }
        }, other);
        return true;
    }

    /** Builds the screen ahead, off screen (a section the rail may show next): draws cached rows and preloads their
     * images, then releases them (letGoLater); YouTube is not asked until it shows */
    prepare(): void {
        if (!this.asked && this.drawKept()) {
            this.letGoLater();
        }
    }

    /** Rows drawn off screen release their images after HIDDEN_IMAGES_MS if the screen is still hidden */
    private letGoLater(): void {
        var self = this;
        var stack = this.stack;
        setTimeout(function () {
            if (!self.shown && stack === self.stack) {
                stack.setShown(false);
            }
        }, HIDDEN_IMAGES_MS);
    }

    /** Requests the rows from YouTube (gen: the fetch's; renew: the rows shown are old and refetched behind them) */
    private ask(gen: number, renew?: boolean): void {
        var self = this;
        this.load(renew).then(function (rows) {
            // With DeArrow on, the first screen draws with its titles and pictures (waiting a little at most)
            return rows ? brandedRows(rows) : rows;
        }).then(function (rows) {
            if (gen !== self.gen) {
                return;
            }
            self.loading = false;
            // Refreshed while hidden and unchanged: nothing to draw
            if (self.stale && document.hidden && rows && !self.grid && idsOf(rows.shelves) === idsOf(self.paging.shelves)) {
                self.stale = false;
                self.fetchedAt = Date.now();
                return;
            }
            // Cached content without rows (only YouTube's message) is replaced at once
            if (self.stale && self.hasRows) {
                self.fresh = { rows: rows, at: Date.now() };
                // Until they are swapped in, more shelves come from the fresh rows' token
                if (!self.grid) {
                    self.paging.setNext(rows ? rows.next : '');
                }
                self.freshen();
            } else {
                self.stale = false;
                self.drawFresh(rows, rows ? rows.at : undefined);
                // Rows from the cache are refetched behind them when old
                if (self.shown) {
                    self.renewIfOld();
                }
            }
        }, function () {
            if (gen !== self.gen) {
                return;
            }
            self.loading = false;
            self.settled = true;
            self.loader.hide();
            if (self.stale) {
                // The rows shown stay (still playable) and are refetched when the screen shows next, like old ones
                self.stale = false;
                self.fetchedAt = 1;
            } else {
                self.failed = true;
                setText(self.status, self.texts.failed);
            }
        });
    }

    /** Draws fresh rows in place of the current ones */
    private drawFresh(rows: Rows | null, at?: number): void {
        this.unchecked = null;
        this.draw(rows);
        this.fetchedAt = at || Date.now();
        mark('rows');
        this.aheadInSight();
    }

    /** Prefetches rows ahead of the focus, only while the rows are fresh and visible (not cached rows, whose token is
     * old; not behind a video or with the app in the background) */
    private aheadInSight(): void {
        if (this.shown && !this.covered && !document.hidden && !this.stale) {
            this.paging.ahead(this.stack, false);
        }
    }

    /** The waiting fresh rows' copy of a tile's video (null: none waiting, or not in them) */
    private freshVideo(item: TileItem | null): Video | null {
        var fresh = this.fresh && this.fresh.rows;
        var found: Video | null = null;
        (fresh && item ? fresh.shelves : []).forEach(function (shelf) {
            shelf.videos.forEach(function (v) {
                if (!found && v.id === item!.id) {
                    found = v;
                }
            });
        });
        return found;
    }

    /** Swaps in the fresh rows once out of view (covered by a video, or hidden), keeping focus on the same video. The
     * video played from here keeps its tile in place even if the fresh rows lack it, so Back returns to it */
    private freshen(): void {
        var fresh = this.fresh;
        if (!fresh || this.shown && !this.covered && !document.hidden) {
            return;
        }
        var row = this.stack.row;
        var video = this.tiles.video(row ? row.focused : null);
        var id = video ? video.id : '';
        var put = fresh.rows;
        if (put && video && this.covered && id === this.played && !this.freshVideo(row!.focused)) {
            var place = row!.index;
            for (var k = 0; this.grid && k < this.stack.index; k++) {
                place += this.stack.rows[k].count;
            }
            put = withVideo(put, video, this.grid ? 0 : this.stack.index, place);
        }
        this.fresh = null;
        this.stale = false;
        this.drawFresh(put, fresh.at);
        var rows = this.stack.rows;
        var at = 0;
        for (var r = 0; r < rows.length && id; r++) {
            var i = rows[r].items.map(function (item) { return item.id; }).indexOf(id);
            if (i >= 0) {
                at = r;
                rows[r].focusAt(i);
                this.col = i;
                break;
            }
        }
        this.stack.focusRow(at);
        this.place();
        if (!this.shown) {
            this.letGoLater();
        }
    }

    /** The cached rows belonged to another account: shows the fresh rows if they arrived, else clears the rows and
     * shows the loader until they do (or the failure message if the fetch failed) */
    private unstale(): void {
        var fresh = this.fresh;
        this.stale = false;
        this.fresh = this.unchecked = null;
        if (fresh) {
            this.drawFresh(fresh.rows);
            return;
        }
        this.paging.set([], '');
        this.stack.setRows([]);
        if (this.loading) {
            this.settled = false;
            if (this.opts.logo) {
                this.loader.show(LOGO, LOADING_FILL);
            }
        } else if (this.asked) {
            // The fetch failed (if passed by, it is fetched when shown)
            this.failed = true;
            setText(this.status, this.texts.failed);
        }
    }

    /** Draws rows (null: no account) in place of the current ones */
    private draw(rows: Rows | null): void {
        var self = this;
        var shelves = rows ? rows.shelves : [];
        var empty = !self.hasRows;
        var grid = shelves.length === 1 && shelves[0].grid ? shelves[0] : null;
        var list = !!grid && grid.style === 'list';
        if (!grid !== !self.grid || list !== self.list || !self.paging.shelves.length) {
            // Switching between rows, grid and list: each has its own row height
            self.el.removeChild(self.stack.el);
            self.list = list;
            self.stack = self.newStack(!!grid);
        }
        self.grid = grid;
        toggleClass(self.el, 'bd-page--list', list);
        self.drawSide(rows && rows.side || null);
        self.col = 0;
        setText(self.headingText, rows ? word(rows.title) : '');
        self.tabs = rows && rows.tabs || [];
        self.buildTabs();
        self.buttons = rows && rows.buttons || [];
        self.drawButtons();
        // If focus moved to the tabs during the fetch, put it on the chosen one
        self.focusTabs(self.at === 'tabs' && self.tabPills.count > 0);
        // An empty page: its title and YouTube's message over faint tiles
        var nothing = rows && !shelves.length && !rows.nudge ? rows.empty || '' : '';
        setShown(self.heading, !!grid || !!nothing);
        self.drawEmpty(nothing);
        // Nothing else to focus: the back arrow, as on YouTube
        if (nothing && self.back && self.at === 'rows') {
            self.goTo('back');
        }
        if (grid) {
            self.paging.set([], grid.next || '', function (videos) { self.addLines(self.tiles.items(videos)); });
            self.stack.setRows([]);
            self.tiles.reset();
            self.addLines(self.tiles.items(grid.videos));
        } else {
            self.paging.set(shelves, rows ? rows.next : '');
            self.stack.setRows(self.tiles.rows(shelves, true));
        }
        var nudge = rows && !shelves.length && rows.nudge || null;
        self.drawNudge(nudge);
        setText(self.status, !rows ? self.texts.noAccount : shelves.length || nudge || nothing ? '' : self.texts.empty);
        self.place();
        self.settled = true;
        self.loader.hide();
        // A page fades in as its rows arrive, with nothing shown before
        if (self.opts.fade && empty && (self.hasRows || nudge)) {
            fadeIn(self.el);
        }
    }

    private newStack(grid: boolean): RowStack {
        var m = metrics();
        var stack = new RowStack('bd-page-content', this.list ? m.list.pitch : grid ? m.gridPitch :
            this.opts.spacing ? this.opts.spacing.pitch : rowH(), m.rowsTop);
        if (this.opts.big && !grid) {
            stack.setBig(m.big.h - m.tile.h);
        }
        // A playlist's lines are short: several on screen, so more are drawn around the focus
        if (this.list) {
            stack.setReach(Math.ceil((LAYOUT_HEIGHT - m.list.top) / m.list.pitch) - 1);
        }
        stack.setFocused(this.focused && this.at === 'rows');
        stack.setShown(this.shown);
        this.el.insertBefore(stack.el, this.el.firstChild);
        return stack;
    }

    /** Appends tiles to a grid: fills the last line, then adds new lines */
    private addLines(items: TileItem[]): void {
        var m = metrics();
        // A playlist: one per line right of its side column, text beside the image (the theme's bd-page--list)
        var shape = this.list ? m.list.tile : m.grid;
        var layout = this.list ? layoutWith(m.rows, { pad: m.list.left, under: 0, rowGap: m.list.pitch - m.list.tile.h }) : m.rows;
        var perLine = this.list ? 1 : Math.max(1, Math.floor((LAYOUT_WIDTH - m.rows.pad - m.page.right + m.rows.gap) / (m.grid.w + m.rows.gap)));
        var last = this.stack.rows[this.stack.rows.length - 1];
        var fill = last ? Math.min(perLine - last.count, items.length) : 0;
        if (fill > 0) {
            last.append(items.slice(0, fill));
        }
        var lines: TileRow[] = [];
        for (var i = fill; i < items.length; i += perLine) {
            lines.push(new TileRow({ title: '', shape: shape, layout: layout, items: items.slice(i, i + perLine), noTitle: true, noWrap: true }));
        }
        this.stack.addAll(lines);
    }


    /** Scrolls so the focused row's heading sits at the theme's rowsTop (for a grid: its title, first line below) */
    private place(): void {
        var m = metrics();
        // A page's grid: title at the top, grid below (as on YouTube)
        // A playlist: the side column stays; the list scrolls once focus is past its second line (as on YouTube)
        if (this.list) {
            translate(this.heading, 0, m.list.title);
            translate(this.buttonsEl, 0, 0);
            translate(this.stack.el, 0, m.list.top - Math.max(0, this.stack.top - m.list.pitch));
            return;
        }
        // Title and buttons scroll with the grid so they never overlap its tiles (also an empty page's title)
        if (this.opts.page && (this.grid || this.emptyEl.firstChild)) {
            translate(this.heading, 0, m.page.top - this.stack.top);
            translate(this.buttonsEl, 0, -this.stack.top);
            translate(this.stack.el, 0, m.page.gridTop - this.stack.top);
            return;
        }
        // Below the search bar, which stays above the rows (as on YouTube's Home); slightly higher with a big row
        var y = m.rowsTop + (this.bar ? m.searchBarSpace : 0) - (this.opts.big ? m.bigUp : 0) - this.stack.top;
        // A grid's first line below its heading (untitled: as close as a row's tiles to its title)
        var named = !!this.headingText.textContent || this.tabPills.count > 0;
        translate(this.stack.el, 0, this.grid ? y + (named ? m.gridHead : m.rows.head) : y);
        translate(this.heading, 0, y);
    }
}
