// Video rows right of the rail: YouTube's shelves (api/feed.ts) as tile rows
// in a row stack. FeedView is a screen fetched when first shown (Home,
// Subscriptions, Library, a page opened from a tile); a long list (History,
// a playlist) shows as a grid, a page's tabs as pills. More loads as focus
// nears an end. Cached rows (api/kept-rows.ts) show at once while fresh ones
// load; fresh rows replace them only while a video covers the screen or it
// is hidden, keeping focus on the same video. Rows older than REFRESH_MS are
// refreshed the same way.

import { h, LAYOUT_HEIGHT, LAYOUT_WIDTH, setShown, setText, toggleClass, translate } from '../core/dom.js';
import { tr } from '../core/i18n.js';
import { KEY } from '../core/keys.js';
import { canListen } from '../core/platform.js';
import { mark } from '../core/perf.js';
import { afterClick, takesPointer, toPart } from '../core/pointer.js';
import { View } from '../core/view.js';
import { RowStack } from '../ui/row-stack.js';
import { TileItem, TileRow } from '../ui/tile-row.js';
import { more, Nudge, PageButton, PlaylistInfo, Rows, Shelf, Tab, Video } from '../api/feed.js';
import { prefs } from '../api/prefs.js';
import { Pills } from '../ui/pills.js';
import { FillLoader, LOGO } from '../ui/fill-loader.js';
import { icon } from '../ui/icons.js';
import { metrics, RowSpacing, word } from '../ui/theme.js';
import { listButtons, ListStage, shuffle } from './list-stage.js';
import { brandedRows, copied, gridLines, Paging, rowH, VideoTiles } from './tiles.js';

/** The loading sign fills at its theme pace (~1.2 s, about when Home's rows usually arrive) */
var LOADING_FILL = 1;
/** The app's icons for the iconTypes of YouTube's page buttons */
var BUTTON_ICONS: { [iconType: string]: string } = {
    MENU_FILTER: 'filter',
    ARROW_PAUSE: 'pausecircle',
    ARROW_PLAY: 'playcircle',
    CLEAR_WATCH_HISTORY: 'delete',
    LOOP: 'loop',
    SHUFFLE: 'shuffle',
    // A playlist's Play all (views/list-stage.ts)
    PLAY_ALL: 'play',
    // A playlist's Save to library: saved (as Library's), or not
    BOOKMARK: 'library',
    BOOKMARK_BORDER: 'bookmark',
    // A playlist's Shortcut (views/shortcuts.ts)
    SHORTCUT: 'remote'
};

/** Rows this old are refreshed behind the ones shown (Subscriptions sooner: main.ts) */
var REFRESH_MS = 30 * 60 * 1000;

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

/** A copy of rows without video id (a shelf that had only it goes too) */
function withoutVideo(rows: Rows, id: string): Rows {
    var put = copied(rows);
    put.shelves = rows.shelves.map(function (s) {
        var shelf = copied(s);
        shelf.videos = s.videos.filter(function (v) { return v.id !== id; });
        return shelf;
    }).filter(function (s, i) { return s.videos.length > 0 || !rows.shelves[i].videos.length; });
    return put;
}

/** The shelves' video ids in order (equal ids: nothing to redraw) */
function idsOf(shelves: Shelf[]): string {
    return shelves.map(function (s) {
        return s.videos.map(function (v) { return v.id; }).join(',');
    }).join('|');
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
        this.bar.appendChild(h('span', '', tr('Search')));
        parent.appendChild(this.bar);
        // A click is OK on the bar or the microphone
        var self = this;
        takesPointer(this.bar, function () {
            self.onMic = false;
            return {};
        });
        takesPointer(this.mic, function () {
            if (!listens()) {
                return null;
            }
            self.onMic = true;
            return {};
        });
    }

    /** el is part of the bar (or its microphone) */
    holds(el: HTMLElement): boolean {
        return this.bar.contains(el) || this.mic.contains(el);
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

/** Restarts el's quick fade-in (the theme's by-fade-in) */
export function fadeIn(el: HTMLElement): void {
    // Fading in again: off, and a layout read, so the animation starts anew (a first time needs neither)
    if (/(^| )by-fade-in( |$)/.test(el.className)) {
        toggleClass(el, 'by-fade-in', false);
        void el.offsetWidth;
    }
    toggleClass(el, 'by-fade-in', true);
}

/** A screen built around rows (Subscriptions, Library, a channel page): main.ts's hooks for the rows go to its
 * FeedView (a screen with more to do overrides them) */
export class FeedHost {
    protected feed!: FeedView;

    /** The rows (or a message instead) have arrived */
    get settled(): boolean {
        return this.feed.settled;
    }

    /** A video covers it (or not): fresh rows are swapped in out of sight */
    cover(covered: boolean): void {
        this.feed.cover(covered);
    }

    renewIfOld(): void {
        this.feed.renewIfOld();
    }

    prepare(): void {
        this.feed.prepare();
    }

    putFresh(): void {
        this.feed.putFresh();
    }

    setProgress(id: string, progress: number): void {
        this.feed.setProgress(id, progress);
    }

    removeVideo(id: string): void {
        this.feed.removeVideo(id);
    }

    retry(quiet?: boolean): boolean {
        return this.feed.retry(quiet);
    }

    reload(): void {
        this.feed.reload();
    }
}

/** A screen's cached rows, and a check (run once they show) whether they belong to the current account */
/** Where the focus is on a feed screen (FeedView's at) */
type Part = 'rows' | 'tabs' | 'buttons' | 'bar' | 'back';

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
    /** A playlist's videos were drawn while it shows (its frame's preview starts after the rest, as after a key) */
    onList?: () => void;
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
    private at: Part = 'rows';
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
    /** A playlist's frame with the focused video and its details (made with the first list); its video count (0: not
     * said), and whether it is one of YouTube's charts */
    private stage: ListStage | null = null;
    private count = 0;
    private chart = false;
    /** A playlist's page: its id ('' not known) */
    private playlistId = '';
    /** A playlist's Repeat and Shuffle switches (main.ts pressPageButton): what is played from it starts over after its
     * last video, and comes in a random order (shuffled: that order of its videos' ids, following the list: order) */
    repeating = false;
    shuffling = false;
    private shuffled: string[] = [];
    /** Told of a playlist's videos added (its next part: their ids in the order they play, and the videos; main.ts adds
     * them to the queue played from it) */
    added: ((ids: string[], videos: Video[]) => void) | null = null;
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
    /** The logo loader (the start screen only: opts.logo) */
    private loader: FillLoader | null;
    /** Showing older rows (cached or aged) while fresh ones load or wait to replace them */
    private stale = false;
    private fresh: { rows: Rows | null; at: number } | null = null;
    /** Cached rows shown before the account check has confirmed them */
    private unchecked: KeptFeed | null = null;
    /** A video covers the screen */
    private covered = false;
    /** Closed for good (destroy): a swap of fresh rows still due is dropped */
    private dead = false;
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
        // Shelves added while fresh rows wait come from their token: they continue the fresh rows (kept when those
        // replace the ones shown)
        this.paging.added = function (shelves, next) {
            var fresh = self.fresh;
            if (fresh && fresh.rows) {
                var put = copied(fresh.rows);
                put.shelves = put.shelves.concat(shelves);
                put.next = next;
                fresh.rows = put;
            }
        };
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
        this.loader = opts.logo ? new FillLoader(this.el, false) : null;
        if (opts.onSearch) {
            // Covers the rows scrolling up under the bar
            this.el.appendChild(h('div', 'by-feed-top'));
            this.bar = new SearchBar(this.el, '', opts.onSearch);
        }
        // A click moves the focus to the part it is in (what it is on takes the focus there: a tile, a tab, a button),
        // and back after one on a tile (it acts in place); the back arrow is itself what is clicked
        takesPointer(this.el, function (target, under) {
            var part: Part | '' = self.bar && self.bar.holds(target) ? 'bar' :
                self.back && self.back.contains(target) ? 'back' : self.tabsEl.contains(target) ? 'tabs' :
                self.buttonsEl.contains(target) ? 'buttons' : self.nudgeEl.contains(target) || self.stack.el.contains(target) ? 'rows' : '';
            return part ? toPart(under, function (p: Part) { self.goTo(p); }, self.at, part, part === 'back') : null;
        });
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

    /** A video covers the screen (or stops covering it): while covered, fresh rows are swapped in (old ones are
     * refetched once its picture moves: main.ts renewRows, not during its start) */
    cover(covered: boolean): void {
        this.covered = covered;
        if (covered) {
            this.freshenAfterClick();
        } else {
            this.aheadInSight();
        }
    }

    hide(): void {
        this.shown = false;
        setShown(this.el, false);
        this.stack.setShown(false);
        this.freshenAfterClick();
    }

    /** Closed for good (a page left with Back): late replies are dropped, nothing more is fetched or branded for it */
    destroy(): void {
        this.gen++;
        this.dead = true;
        this.added = null;
        this.paging.stop();
        this.tiles.stop();
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
        // Also from the fresh rows waiting to be swapped in (else it comes back with them)
        if (this.fresh && this.fresh.rows) {
            this.fresh.rows = withoutVideo(this.fresh.rows, id);
        }
        if (!this.grid) {
            this.paging.drop(this.stack, id);
            this.taken();
            return;
        }
        // Rebuild its line and the following ones, shifted one tile back (the full lines before it stay)
        var stack = this.stack;
        var line = this.rowOf(id);
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
                        this.goTo('bar');
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
                    this.open(this.list && !video.page ? this.fromList(video) : video);
                }
                return true;
        }
        return false;
    }

    /** video played from a playlist: the rest of the list after it in its order or Shuffle's (all of it again after the
     * last with Repeat on) */
    private fromList(video: Video): Video {
        var played = copied(video);
        var videos = this.playable();
        played.list = this.order(video.id, videos);
        played.repeat = this.repeating;
        played.playlist = this.playlistInfo(videos);
        return played;
    }

    /** A playlist's videos that play here (not films) */
    playable(): Video[] {
        return this.videos().filter(function (v) { return !v.movie; });
    }

    /** A playlist's name, count and videos (those given, else those that play here), for the player to show */
    playlistInfo(videos?: Video[]): PlaylistInfo {
        return { title: this.headingText.textContent || '', count: this.count, videos: videos || this.playable(), id: this.playlistId };
    }

    /** A playlist's videos' ids (of those given, else those that play here) in the order they play: its own, or
     * Shuffle's with first first. Shuffle's order follows the list: videos gone are left out, new ones come after the
     * rest in a random order */
    order(first?: string, videos?: Video[]): string[] {
        var ids = (videos || this.playable()).map(function (v) { return v.id; });
        if (!this.shuffling) {
            return ids;
        }
        var have: { [id: string]: boolean } = {};
        ids.forEach(function (id) { have[id] = true; });
        var kept = this.shuffled.filter(function (id) { return have[id]; });
        kept.forEach(function (id) { have[id] = false; });
        this.shuffled = kept.concat(shuffle(ids.filter(function (id) { return have[id]; })));
        var rest = this.shuffled.filter(function (id) { return id !== first; });
        return first ? [first].concat(rest) : rest;
    }

    /** The video after id in a playlist's order (or Shuffle's), the first again after the last with Repeat on ('' none) */
    nextAfter(id: string): string {
        var ids = this.order();
        var i = ids.indexOf(id);
        if (i >= 0 && i + 1 < ids.length) {
            return ids[i + 1];
        }
        return this.repeating && ids.length && ids[0] !== id ? ids[0] : '';
    }

    /** Turns a playlist's Repeat or Shuffle switch (Shuffle on: a new random order); returns whether it is on now */
    turn(which: 'repeat' | 'shuffle'): boolean {
        var on: boolean;
        if (which === 'repeat') {
            on = this.repeating = !this.repeating;
        } else {
            // (a new random order: order makes it)
            on = this.shuffling = !this.shuffling;
            this.shuffled = [];
        }
        this.drawButtons();
        return on;
    }

    /** Fetches a playlist's next part now (the queue played from it nears its end): added hears of it */
    loadMore(): void {
        if (this.list && !this.dead) {
            this.paging.fetchNext(this.stack);
        }
    }

    /** A playlist's next part arrived: told to the queue played from it, in the order it plays */
    private more(videos: Video[]): void {
        if (!this.added) {
            return;
        }
        var fresh: { [id: string]: boolean } = {};
        videos.forEach(function (v) {
            if (!v.movie) {
                fresh[v.id] = true;
            }
        });
        var ids = this.order().filter(function (id) { return fresh[id]; });
        if (ids.length) {
            this.added(ids, videos.filter(function (v) { return fresh[v.id]; }));
        }
    }

    /** A playlist's frame: its focused video, preview and details (null: not a playlist) */
    get frame(): ListStage | null {
        return this.list ? this.stage : null;
    }

    /** The row (one video to a line in a playlist) that has video id (-1: none) */
    private rowOf(id: string): number {
        var rows = this.stack.rows;
        for (var r = 0; r < rows.length; r++) {
            if (rows[r].items.some(function (item) { return item.id === id; })) {
                return r;
            }
        }
        return -1;
    }

    /** A playlist's focus on video id where it lists it (one played from it: the list may have played on meanwhile; the
     * frame's next video); keep: the focus stays on the buttons if there */
    focusOn(id: string, keep?: boolean): void {
        var r = this.list ? this.rowOf(id) : -1;
        if (r < 0) {
            return;
        }
        this.stack.focusRow(r);
        if (!keep) {
            this.goTo('rows');
        }
        this.place();
        this.paging.ahead(this.stack, false);
    }

    /** The page over the player's preview filling the screen behind it (Settings › Playlist page: Backdrop) */
    previewing(on: boolean): void {
        toggleClass(this.el, 'bd-page--previewing', on);
    }

    /** It has rows (or grid lines) to focus */
    get hasRows(): boolean {
        return this.stack.rows.length > 0;
    }

    /** Something to focus: rows, or YouTube's message in their place (with a button) */
    get focusable(): boolean {
        return this.hasRows || !!this.nudge && this.nudge.buttons.length > 0;
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
        var self = this;
        return this.tabPills.key(code, { down: function () {
            self.focusTabs(false);
            return true;
        } });
    }

    /** Keys on YouTube's message: Left/Right move along its buttons, OK presses one, Up goes to the search bar */
    private nudgeKey(code: number): boolean {
        var self = this;
        return this.nudgePills.key(code, { up: function () {
            // No search bar: the screen above takes it (Subscriptions' pills, Library's cards)
            if (!self.bar) {
                return false;
            }
            self.goTo('bar');
            return true;
        } });
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
                this.goTo('rows');
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

    private goTo(at: Part): void {
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
            // A playlist's Play all with its name, its Repeat switch marked while on
            var lit = b.turn === 'repeat' ? self.repeating : b.turn === 'shuffle' && self.shuffling;
            var el = h('div', 'by-page-button' + (b.icon === 'PLAY_ALL' ? ' by-page-button--wide' : '') + (lit ? ' by-page-button--on' : ''));
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

    /** A playlist's frame and details show its focused video (the last one focused while on the buttons) */
    private showStage(): void {
        var row = this.stack.row;
        var item = row ? row.focused : null;
        if (this.stage) {
            this.stage.show(item);
        }
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
            if (!quiet && !this.drawKept() && this.loader) {
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
        }).then(null, function () {
            // (also a throw while drawing: it fails as a fetch would, so OK or the retry tries again; not one after the
            // rows were drawn)
            if (gen !== self.gen) {
                return;
            }
            self.loading = false;
            self.settled = true;
            if (self.loader) {
                self.loader.hide();
            }
            if (self.stale) {
                // The rows shown stay (still playable) and are refetched when the screen shows next, like old ones
                self.stale = false;
                self.fetchedAt = 1;
            } else if (!self.hasRows) {
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

    /** freshen, after a click that opened a tile in place has put the keys' focus back (core/pointer.ts afterClick) */
    private freshenAfterClick(): void {
        var self = this;
        afterClick(function () {
            if (!self.dead) {
                self.freshen();
            }
        });
    }

    /** Swaps in the fresh rows once out of view (covered by a video, or hidden), keeping focus on the same video. The
     * tile last opened from here (a video, or a page hiding the screen), or under the focus while a video covers the
     * screen (one opened by the pointer in place, or cast), keeps its place even if the fresh rows lack it, so Back
     * returns to it */
    private freshen(): void {
        var fresh = this.fresh;
        if (!fresh || this.shown && !this.covered && !document.hidden) {
            return;
        }
        var row = this.stack.row;
        var video = this.tiles.video(row ? row.focused : null);
        var id = video ? video.id : '';
        var put = fresh.rows;
        if (put && video && (id === this.played || this.covered) && !this.freshVideo(row!.focused)) {
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
            if (this.loader) {
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
        // A playlist's frame and details, under and over its list
        if (list && !self.stage) {
            self.stage = new ListStage(self.el);
        }
        if (!grid !== !self.grid || list !== self.list || !self.paging.shelves.length) {
            // Switching between rows, grid and list: each has its own row height
            self.el.removeChild(self.stack.el);
            self.list = list;
            self.stack = self.newStack(!!grid);
        }
        self.grid = grid;
        toggleClass(self.el, 'bd-page--list', list);
        self.chart = list && !!rows && !!rows.chart;
        self.playlistId = rows && rows.playlistId || '';
        toggleClass(self.el, 'bd-page--chart', self.chart);
        if (self.stage) {
            self.stage.arrange(list);
        }
        self.drawSide(rows && rows.side || null);
        self.count = rows && rows.side && rows.side.count || 0;
        self.col = 0;
        setText(self.headingText, rows ? word(rows.title) : '');
        self.tabs = rows && rows.tabs || [];
        self.buildTabs();
        self.buttons = list ? listButtons(rows && rows.buttons || [], rows && rows.playlistId || undefined) : rows && rows.buttons || [];
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
            self.paging.set([], grid.next || '', function (videos) {
                self.addLines(self.tiles.items(videos));
                self.more(videos);
            });
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
        if (self.loader) {
            self.loader.hide();
        }
        // A page fades in as its rows arrive, with nothing shown before
        if (self.opts.fade && empty && (self.hasRows || nudge)) {
            fadeIn(self.el);
        }
        if (list && self.shown && self.hasRows && self.opts.onList) {
            self.opts.onList();
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
        // (over a playlist's frame)
        this.el.insertBefore(stack.el, this.stage ? this.stage.back.nextSibling : this.el.firstChild);
        return stack;
    }

    /** Appends tiles to a grid: fills the last line, then adds new lines */
    private addLines(items: TileItem[]): void {
        var m = metrics();
        // A playlist: one per line right of its side column, text beside the image (the theme's bd-page--list)
        var shape = this.list ? m.list.tile : m.grid;
        var layout = this.list ? copied(m.rows, { pad: m.list.left, under: 0, rowGap: m.list.pitch - m.list.tile.h }) : m.rows;
        var perLine = this.list ? 1 : Math.max(1, Math.floor((LAYOUT_WIDTH - m.rows.pad - m.page.right + m.rows.gap) / (m.grid.w + m.rows.gap)));
        // A playlist's numbers before its videos (Settings › Rank numbers): their places, one video to a line
        var numbers = prefs().listNumbers;
        if (this.list && (numbers === 'all' || numbers === 'charts' && this.chart)) {
            var first = this.stack.rows.length;
            items.forEach(function (item, i) { item.rank = String(first + i + 1); });
        }
        var last = this.stack.rows[this.stack.rows.length - 1];
        var fill = last ? Math.min(perLine - last.count, items.length) : 0;
        if (fill > 0) {
            last.append(items.slice(0, fill));
        }
        this.stack.addAll(gridLines(items.slice(fill), perLine, shape, layout));
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
            this.showStage();
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
