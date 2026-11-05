// Video tiles for the screens that show YouTube's rows (views/videos.ts,
// Search, the watch page): tile rows built for shelves and mapped back to
// their videos (VideoTiles, with DeArrow's titles and pictures and lengths
// looked up), rows grown as focus nears their end (Paging), grid lines, and
// the progress of videos watched in the app's player.

import { load, save } from '../../core/store.js';
import { clock } from '../../core/time.js';
import { RowStack } from '../../ui/row-stack.js';
import { rowHeight, TileItem, TileLayout, TileRow, TileShape } from '../../ui/tile-row.js';
import { dearrowFetch, dearrowListen, dearrowOn, dearrowPicture, dearrowSettings, dearrowTitle, dearrowWait } from '../api/dearrow.js';
import { more, Rows, Shelf, thumbnail, thumbnailFallback, Video } from '../api/feed.js';
import { NoStreams, streams } from '../api/streams.js';
import { metrics, RowSpacing, themed, word } from '../ui/theme.js';

/** More is fetched once focus is this near the end (a row's tiles; rows; grid lines of three tiles, passed
 * quickly), part after part until that much is ready. Subscriptions' parts are one row each (~92 KB, 0.2-0.4 s),
 * so fetching only at the end lets focus outrun the rows */
var TILES_AHEAD = 6;
var ROWS_AHEAD = 3;
var LINES_AHEAD = 4;
/** Length lookups at once (videos YouTube lists without a length, as in its preview carousel) */
var LOOKUPS = 2;
/** Consecutive empty parts before fetching stops (until focus moves) */
var EMPTY_PARTS = 3;

/** A shallow copy of o, with changes over it */
export function copied<T>(o: T, changes?: { [key: string]: unknown }): T {
    var c: any = {};
    for (var k in o) {
        c[k] = (o as any)[k];
    }
    for (var key in changes) {
        c[key] = changes[key];
    }
    return c as T;
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

/** Untitled lines of perLine tiles (a grid), their tiles built as they come into view (325 subscribed channels built
 * all at once took the TV ~175 ms) */
export function gridLines(items: TileItem[], perLine: number, shape: TileShape, layout: TileLayout): TileRow[] {
    var lines: TileRow[] = [];
    for (var i = 0; i < items.length; i += perLine) {
        lines.push(new TileRow({ title: '', shape: shape, layout: layout, items: items.slice(i, i + perLine), noTitle: true, noWrap: true, lazy: true }));
    }
    return lines;
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
    /** Told of more shelves added below, and the token after them */
    added: (shelves: Shelf[], next: string) => void = function () { return undefined; };

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
        this.empties = 0;
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
                self.added(rows.shelves, rows.next);
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

/** Lengths looked up from videos' streams (also the previews' start), for the session: 'LIVE', '' (none known) */
var lengths: { [id: string]: Promise<string> } = {};
var looking = 0;
var waiting: (() => void)[] = [];

function lengthOf(id: string): Promise<string> {
    if (!lengths[id]) {
        lengths[id] = new Promise<string>(function (resolve) {
            var ask = function (): void {
                looking++;
                streams(id).then(function (s) {
                    var longest = 0;
                    s.videos.forEach(function (f) { longest = Math.max(longest, f.duration); });
                    resolve(s.live ? 'LIVE' : longest ? clock(longest) : '');
                }, function (e: NoStreams) {
                    resolve(e.length ? clock(e.length) : '');
                }).then(function () {
                    looking--;
                    var next = waiting.shift();
                    if (next) {
                        next();
                    }
                });
            };
            if (looking < LOOKUPS) {
                ask();
            } else {
                waiting.push(ask);
            }
        });
    }
    return lengths[id];
}

/** Tile styles the app does not draw yet, each kept with a shelf that had it (to draw them as YouTube does) */
var NEW_STYLES_KEY = 'youtube.newStyles';
/** Those noted (read from storage once) */
var newStyles: { [style: string]: string } | null = null;

function noteNewStyles(shelf: Shelf): void {
    for (var i = 0; i < shelf.videos.length; i++) {
        var v = shelf.videos[i];
        if (v.newStyle) {
            newStyles = newStyles || load<{ [style: string]: string }>(NEW_STYLES_KEY) || {};
            if (!newStyles[v.newStyle]) {
                newStyles[v.newStyle] = shelf.title + ': ' + v.title;
                save(NEW_STYLES_KEY, newStyles);
            }
            return;
        }
    }
}

/** A tile's label: LIVE, else the length (with a note for audio) */
function labelOf(v: Video): string {
    return v.live ? 'LIVE' : v.audio && v.length ? '\u266a ' + v.length : v.length;
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
        var layout = this.pad ? copied(m.rows, { pad: this.pad }) : m.rows;
        var lines = this.spacing || (this.big ? null : { pitch: rowH(), plainHead: m.rows.head - m.lineRows.plainUp, taller: m.lineRows.taller });
        var plain = layout;
        if (lines) {
            // Each row spans the pitch: a plain row's tiles at plainHead, a subtitled row's at head and taller
            plain = copied(layout, { head: lines.plainHead, rowGap: lines.pitch - lines.plainHead - m.tile.h - layout.under });
            layout = copied(layout, { rowGap: lines.pitch - layout.head - m.tile.h - layout.under });
        }
        return shelves.map(function (shelf) {
            noteNewStyles(shelf);
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
                    label: labelOf(v), labelIcon: v.labelIcon, stack: v.stack,
                    lines: [v.channel, themed(v.info)], progress: watched[v.id] ? watched[v.id].progress : v.progress, round: v.round,
                    // In the theme's wording (e.g. "CC" as YouTube's TV app writes it)
                    chips: v.badges && v.badges.map(word), offerChip: v.offer && word(v.offer)
                });
                if (!v.page && !v.poster && !v.live && !v.length) {
                    self.measure(v);
                }
            }
        });
        if (dearrowOn()) {
            this.brand(videos);
        }
        return items;
    }

    /** A video YouTube lists without a length: its tiles get it once looked up */
    private measure(v: Video): void {
        var self = this;
        lengthOf(v.id).then(function (length) {
            if (length && self.videos[v.id] === v) {
                if (length === 'LIVE') {
                    v.live = true;
                } else {
                    v.length = length;
                }
                self.shown().forEach(function (row) {
                    row.setLabel(v.id, labelOf(v));
                });
            }
        });
    }

    /** The screen is gone: no more DeArrow branding for its tiles */
    stop(): void {
        if (this.unlisten) {
            this.unlisten();
            this.unlisten = null;
        }
        this.branding = {};
        this.pending = 0;
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
        if (!this.pending) {
            this.stop();
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
