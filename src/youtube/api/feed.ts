// Parses YouTube's TV replies into rows of tiles. Each shelf (a row on YouTube's
// TV screens) holds tiles of either kind: tileRenderer (Home, Subscriptions,
// Library, pages) or lockupViewModel (Search). A tile is a video to play or a
// page to open (a playlist, a channel, History: its browseEndpoint). A page's
// single long list is a grid. Lists come in parts fetched by continuation token
// (more()). Consecutive untitled shelves merge into one row (Subscriptions comes
// as rows of three). Tabs (a channel's Latest, Popular, Oldest) keep their names
// and tokens. Shorts are marked (Video.short) and kept in rows of their own
// (Shelf.shorts: YouTube's Shorts shelves; those it mixes into another row are
// moved into the reply's Shorts row, or one after that row), which the filters
// show or hide (api/filters.ts); in a grid among other videos they are dropped.
// Unknown tiles and empty shelves are dropped.

import { noteAvatars } from './avatars.js';
import { Keeper } from './kept-pages.js';
import { prefs } from './prefs.js';
import { offThread, offThreadJson } from './off-thread.js';
import { innertubeText } from './youtube.js';

/** Pages and search results are cached this long: what is loaded stays loaded. A page's rows are
 * some 10-60 KB of text; the counts below hold a few MB at most, against the app's ~100 MB (mostly pictures, which
 * are not kept). Kept pages refresh behind themselves once old (pageAge, main.ts pageOptions) */
var KEEP_MS = 60 * 60 * 1000;
/** What was asked of YouTube this long ago is old: a channel's list in Subscriptions, search results and a tab's tiles
 * are kept only this long, and a kept page or a channel's list drawn again is asked for behind it once this old
 * (main.ts pageOptions, views/subscriptions.ts) */
export var OLD_MS = 5 * 60 * 1000;
/** The start of the ids of YouTube's chart playlists (its Charts channel's, in every language) */
var CHARTS = /^PL4fGSI1pDJn/;

export interface Video {
    /** The video id (watch?v=); for a page, its browseId plus params */
    id: string;
    title: string;
    channel: string;
    /** "10:35"; '' for live or unknown; for a page, its count ("274 videos") */
    length: string;
    /** Known by its id alone, its details to come with its title (a phone's queue: api/cast-list.ts): its length is not
     * looked up by its tiles (one request each, for a list of hundreds) */
    bare?: boolean;
    /** "23m views • 11 years ago" */
    info: string;
    /** A page to open instead of a video to play */
    page?: Page;
    /** A page's picture ('' none: the tile shows its name), or a mix's own; videos use their id's thumbnail */
    image?: string;
    /** A page's picture is a copy of this video's thumbnail narrower than a tile (its width): pagePicture may take a
     * bigger one */
    imageOf?: { id: string; width: number };
    /** Watched share (0..1), and YouTube's resume position (s) */
    progress?: number;
    start?: number;
    /** The tile's long-press menu (api/menu.ts): its items as parsed (menuOf), else YouTube's command for it (a menu
     * asked for as a panel; rows kept from before carry the whole command) */
    menu?: any;
    /** Round picture (a channel's) */
    round?: boolean;
    /** Drawn as a stack (a playlist, a mix): edge colours, nearest first */
    stack?: string[];
    /** YouTube's tile style ('square', 'game'; '' the usual); newStyle: one the app does not know yet (as YouTube
     * names it), noted so it can be drawn as YouTube does */
    style?: string;
    newStyle?: string;
    /** Music (YouTube shows a note by its length) */
    audio?: boolean;
    /** Live now */
    live?: boolean;
    /** Not out yet (a premiere or a scheduled live stream) */
    upcoming?: boolean;
    /** The icon before the label on its picture: live, playlist ("16 videos"), mix */
    labelIcon?: string;
    /** Badges before its views ("4K", "New", "Subtitles") */
    badges?: string[];
    /** For the channel's members only (YouTube's members badge: api/filters.ts) */
    members?: boolean;
    /** Videos to play in order, itself first (a mix's Play mix); repeat: start over at the end (a playlist's
     * Repeat) */
    list?: string[];
    repeat?: boolean;
    /** Played from a playlist's page: the playlist (the player shows it: player/list-panel.ts, the watch page's row) */
    playlist?: PlaylistInfo;
    /** A YouTube Movies film (to buy or rent, or bought): only YouTube's own player plays it */
    movie?: boolean;
    /** The paid-content badge's text (a film's "Buy or rent") */
    offer?: string;
    /** Poster tiles (style 'poster'): the poster, and the wide picture shown when focused */
    poster?: string;
    wide?: string;
    /** A Short (style 'short': an upright picture, image), shown only in a row of Shorts (Shelf.shorts) */
    short?: boolean;
    /** A Short's token for the Shorts YouTube plays after it (its tile's sequenceParams: api/shorts.ts reelSequence) */
    sequence?: string;
}

/** A playlist a video plays from: its name, how many videos it has (0: not said) and those loaded, in its order (more
 * are added as the queue nears its end) */
export interface PlaylistInfo {
    title: string;
    count: number;
    videos: Video[];
    /** Its id ('' not known) */
    id?: string;
    /** A list whose videos come without titles (a phone's queue: api/cast-list.ts): asks for the titles around video
     * id and puts them in (from: what asks instead, called only if they were not asked for yet); resolves true when
     * the videos changed (a new array) */
    titles?: (id: string, from?: () => Promise<{ queue?: { title: string; videos: Video[] } }>) => Promise<boolean>;
    /** Such a list: fn is called whenever titles came into it; returns what stops that (each view of the list: the side
     * list, the watch page's row) */
    listen?: (fn: () => void) => () => void;
    /** Such a list: its videos made these ids, in this order (the phone's list changed: those known keep their titles),
     * every view told */
    relist?: (ids: string[]) => void;
}

/** A live stream that has ended: its id, title, and its channel's name and id */
export interface Ended {
    id: string;
    title: string;
    channel: string;
    channelId: string;
}

/** A YouTube browse page: a playlist, a channel, History, … */
export interface Page {
    browseId: string;
    params?: string;
}

export interface Shelf {
    title: string;
    /** A line under its title ("Auto-generated by YouTube") and a round icon before it (a game's) */
    subtitle?: string;
    icon?: string;
    /** Tile shape: square (podcasts, releases), a game's box (tall) or a Short's (upright); else 16:9 */
    style?: string;
    /** A row (or grid) of Shorts only: shown where Settings › Filters › Shorts says (api/filters.ts) */
    shorts?: boolean;
    /** A topic's row on Home ("Science and more", or one a topic channel heads: api/filters.ts) */
    topic?: boolean;
    videos: Video[];
    /** A page's single long list (History, Watch later, a playlist), shown as a grid, not a row */
    grid?: boolean;
    /** Continuation token for more tiles (more()); none: it has them all */
    next?: string;
    /** A copy the filters made (api/filters.ts): the shelf as YouTube sent it, which a row's next tiles join too, so
     * the rows drawn again through the filters have them */
    of?: Shelf;
    /** A grid that is a screen's own videos (Subscriptions': views/subscriptions.ts): the shelf before it is a row above
     * its lines, each next part's shelves are more of its videos (next: the screen's token), and a video shows in it
     * once */
    feed?: boolean;
}

/** A screen: its title (a page's), its shelves, and the token for more shelves ('' none) */
export interface Rows {
    title: string;
    shelves: Shelf[];
    next: string;
    /** Its tabs, the shown one chosen */
    tabs?: Tab[];
    /** Subscriptions: the subscribed channels in list order (those with new videos marked) */
    channels?: SubChannel[];
    /** YouTube's message in place of rows */
    nudge?: Nudge;
    /** Buttons above the grid (History: All, Pause watch history, Clear all; a playlist: Repeat) */
    buttons?: PageButton[];
    /** A playlist page's left column: its byline ("Channel • 16 videos • No views"), whether it is private (lock icon),
     * and how many videos it has (0: not said) */
    side?: { byline: string; private: boolean; count?: number };
    /** A playlist that is one of YouTube's charts ("Top 100 Songs Global"): its order is the chart's */
    chart?: boolean;
    /** A playlist's page: its id (its Shortcut button: views/list-stage.ts) */
    playlistId?: string;
    /** When fetched, for rows served from storage (refreshed in the background once old) */
    at?: number;
    /** YouTube's text for a page with nothing on it yet (e.g. Library's Movies & TV) */
    empty?: string;
    /** A channel's list in Subscriptions: its handle ("@name"), from the list's header */
    handle?: string;
    /** Subscriptions: YouTube's heading before its list of every channel ("A-Z") */
    channelsLabel?: string;
}

/** A page header button (tvSurfaceHeaderRenderer): its text, icon (iconType) and action: choices (a filter, each
 * opening the filtered page), a toggle (texts, icons and commands, off first), or a confirmation first (ask) */
export interface PageButton {
    text: string;
    icon: string;
    choices?: { title: string; items: { text: string; chosen: boolean; page: Page }[] };
    toggle?: { on: boolean; texts: string[]; icons: string[]; commands: any[] };
    ask?: Ask;
    /** Plays the playlist (Repeat: loops at the end; Shuffle: shuffled) */
    play?: { loop: boolean; shuffle: boolean };
    /** A playlist page's Repeat or Shuffle switch (views/list-stage.ts): what is played from the page starts over after its
     * last video, or comes in a random order */
    turn?: 'repeat' | 'shuffle';
    /** A playlist page's Shortcut: puts the playlist (this id) on a button of the remote (views/shortcuts.ts) */
    shortcut?: string;
}

/** YouTube's confirmation before clearing: title, subtitle, picture, button texts, the command, and the toast when
 * done ('' none) */
export interface Ask {
    title: string;
    subtitle: string;
    picture: string;
    yes: string;
    no: string;
    command: any;
    done: string;
}

/** Clear commands YouTube confirms first (Settings' History & data, History's Clear all) */
export var CLEARS = ['clearWatchHistoryEndpoint', 'clearSearchHistoryEndpoint'];

/** YouTube's message in place of rows (e.g. Home with watch history off): its text, its buttons with their commands,
 * and the word between them ("or") */
export interface Nudge {
    title: string;
    subtitle: string;
    buttons: { text: string; command: any }[];
    or: string;
}

/** A subscribed channel in Subscriptions' list */
export interface SubChannel {
    title: string;
    picture: string;
    /** It has new videos (YouTube's blue dot), until it is looked at (api/looked.ts) */
    fresh: boolean;
    /** Its newest video in Subscriptions' rows was started, here or elsewhere: no dot is shown, though YouTube marks
     * it still (its page is fetched anew all the same) */
    seen?: boolean;
    /** In the group listed first (recent uploads), not only in the A-Z list */
    recent: boolean;
    /** Its latest videos (Subscriptions' page for it), and its channel page (null: unknown) */
    page: Page;
    channel: Page | null;
}

export interface Tab {
    title: string;
    chosen: boolean;
    /** YouTube's iconType for it (Library's Music, "SEARCH_HISTORY", …) */
    icon?: string;
    /** Token that fetches its tiles (more()) */
    token: string;
}

/** A page's rows (YouTube's own screens are pages too: Home is FEwhat_to_watch) */
export function page(p: Page): Promise<Rows> {
    return offThread(browseText(p), 'rows', rowsOf);
}

/** page(p) as JSON text (for the cache), with when it was fetched (rows.at: a kept page opened later refreshes behind
 * itself once old) */
function pageJson(p: Page): Promise<string> {
    return offThreadJson(browseText(p), 'rows', rowsOf).then(function (text) {
        return text.charAt(0) === '{' && text.length > 2 ? '{"at":' + Date.now() + ',' + text.slice(1) : text;
    });
}

/** Recently opened pages and search results, cached a while (api/kept-pages.ts); a channel's list in Subscriptions
 * among more of its kind (a few KB each: a viewer goes through many, and back to one is then no request) */
var pages = new Keeper<Rows>(KEEP_MS, 24, true, true);
// (Subscriptions keeps the channels' lists itself, for the session, refreshed behind after five minutes: views/
// subscriptions.ts known; here only for a few minutes, as before)
var lists = new Keeper<Rows>(OLD_MS, 40, true, true);
// (search results and tabs are not refreshed behind themselves: kept a few minutes, as before, more of them)
var searches = new Keeper<Rows>(OLD_MS, 16, true, true);

function keeperOf(p: Page): Keeper<Rows> {
    return p.browseId === 'FEsubscriptions' && p.params ? lists : pages;
}

/** A page, from the cache when fetched recently or ahead; History is always fetched (each watched video changes it,
 * and it loads in ~0.2 s). renew: the screen showing it refreshes it behind its rows: asked of YouTube, the kept one
 * replaced */
export function keptPage(p: Page, renew?: boolean): Promise<Rows> {
    if (!keepable(p)) {
        return page(p);
    }
    var keeper = keeperOf(p);
    if (renew) {
        keeper.drop(pageKey(p));
    }
    return keeper.getJson(pageKey(p), function () { return pageJson(p); });
}

/** Whether page p's reply is kept or on its way (asking for it now is no request) */
export function pageKept(p: Page): boolean {
    return keepable(p) && keeperOf(p).has(pageKey(p));
}

/** A tab's tiles (more), kept a while: at hand again for a tab seen before, and asked ahead while the focus rests on
 * its chip (tabAhead); not History's (keptTabs), which each watched video changes, as History's page is not kept */
var tabs = new Keeper<Rows>(OLD_MS, 16, true, true);

/** Whether tab's tiles are kept and asked ahead */
export function keptTabs(tab: Tab): boolean {
    return !!tab.token && tab.icon !== 'SEARCH_HISTORY';
}

/** A tab's reply as the rows' text (parsed off the main thread, as a page's) */
function tabJson(token: string): Promise<string> {
    return offThreadJson(innertubeText('browse', { continuation: token }), 'more', moreOf);
}

export function keptTab(token: string): Promise<Rows> {
    return tabs.getJson(token, function () { return tabJson(token); });
}

/** Keeps a tab's tiles as its page brought them (a page's first tab comes with the page, not by its token), so going
 * back to it from another tab asks nothing. anew (the page was just fetched): in place of what was kept, the newer
 * tiles; else only where none are kept (a kept page drawn again would keep its old tiles young for good) */
export function keepTab(token: string, rows: Rows, anew: boolean): void {
    if (anew) {
        tabs.drop(token);
    }
    if (!tabs.has(token)) {
        var text = JSON.stringify(rows);
        tabs.aheadJson(token, function () { return Promise.resolve(text); });
    }
}

/** Asks for a tab's tiles ahead, so keptTab has them at once */
export function tabAhead(token: string): void {
    tabs.aheadJson(token, function () { return tabJson(token); });
}

/** Prefetches a page (the focus rests on its tile), so keptPage has it at once */
export function pageAhead(p: Page): void {
    if (keepable(p)) {
        keeperOf(p).aheadJson(pageKey(p), function () { return pageJson(p).then(tapped); });
    }
}

/** Told the rows (as JSON text) of each page and search fetched ahead, so what they show is prepared too (main.ts) */
var aheadTap: ((json: string) => void) | null = null;
export function tapAhead(fn: (json: string) => void): void {
    aheadTap = fn;
}

function tapped(json: string): string {
    if (aheadTap) {
        aheadTap(json);
    }
    return json;
}

/** A page worth caching (or prefetching) */
export function keepable(p: Page): boolean {
    return p.browseId !== 'FEhistory';
}

/** A page's cache key */
export function pageKey(p: Page): string {
    return p.browseId + '|' + (p.params || '');
}

/** A page's browse reply as text (parsed into rows off the main thread: offThread) */
export function browseText(p: Page): Promise<string> {
    var body: { [key: string]: unknown } = { browseId: p.browseId };
    if (p.params) {
        body.params = p.params;
    }
    return innertubeText('browse', body);
}

/** YouTube's Home for the account (Recommended, Recently uploaded, …) */
export function home(): Promise<Rows> {
    return page({ browseId: 'FEwhat_to_watch' });
}

/** The latest videos of subscribed channels (signed in); notes the channels' pictures from the side list (for the
 * loading indicator) */
export function subscriptions(): Promise<Rows> {
    return offThread(browseText({ browseId: 'FEsubscriptions' }), 'subscriptions', subscriptionsOf).then(function (rows) {
        var seen: { [channel: string]: string } = {};
        (rows.channels || []).forEach(function (c) { seen[c.title] = c.picture; });
        noteAvatars(seen);
        return rows;
    });
}

/** Parses Subscriptions' reply: its rows and its channel list */
export function subscriptionsOf(reply: any): Rows {
    var channels: SubChannel[] = [];
    var label = '';
    try {
        // All, the channels with recent uploads, an "A-Z" heading (no page), then every channel
        var recent = true;
        (get(reply, 'contents', 'tvBrowseRenderer', 'content', 'tvSecondaryNavRenderer', 'sections') || []).forEach(function (s: any) {
            (get(s, 'tvSecondaryNavSectionRenderer', 'tabs') || []).forEach(function (t: any) {
                var tab = t && t.tabRenderer;
                var opens = tab && pageOf(tab.endpoint);
                if (tab && !opens) {
                    recent = false;
                    label = label || text(tab.title);
                }
                if (tab && tab.thumbnail && opens) {
                    channels.push({ title: text(tab.title), picture: picture(tab.thumbnail), fresh: get(tab, 'presentationStyle', 'style') === 'NEW_CONTENT',
                        recent: recent, page: opens, channel: channelOf(tab, opens) });
                }
            });
        });
    } catch (e) {
        // Unexpected shape: return the feed anyway
    }
    var rows = rowsOf(reply);
    rows.channels = channels;
    if (label) {
        rows.channelsLabel = label;
    }
    // Its tabs are the channels again (334 here), never shown: drawn per channel as chips, stored and parsed each start
    delete rows.tabs;
    return rows;
}

/** A subscription tab's channel page: the channel id from the tab identifier, else from its params (base64
 * protobuf with the id as text); null: neither */
function channelOf(tab: any, opens: Page): Page | null {
    var found = /^UC[\w-]{20,}$/.test(tab.tabIdentifier || '') ? tab.tabIdentifier : '';
    if (!found && opens.params) {
        var m = /UC[\w-]{22}/.exec(paramBytes(opens.params));
        found = m ? m[0] : '';
    }
    return found ? { browseId: found } : null;
}

/** A command's params (URL-encoded base64url protobuf) as bytes, one character each ('' if they cannot be read) */
export function paramBytes(params: string | undefined): string {
    try {
        return atob(decodeURIComponent(params || '').replace(/-/g, '+').replace(/_/g, '/'));
    } catch (e) {
        return '';
    }
}

/** YouTube's results for query (cached, so a term typed again, e.g. after Delete, shows them at once) */
export function search(query: string): Promise<Rows> {
    return searches.getJson(query, function () { return askSearch(query); });
}

/** The first video in rows live now from the ended stream's channel with its title (spaces, punctuation and emoji
 * aside: a stream started anew may change them), not the ended one itself (still marked live a while) */
export function liveNamed(rows: Rows, ended: Ended): Video | undefined {
    var squeeze = function (t: string): string {
        return t.toLowerCase().replace(/[\s!-\/:-@\[-`{-~\u2000-\u2bff\ufe0f\ud800-\udfff]+/g, '');
    };
    var wanted = squeeze(ended.title);
    var others: Video[] = [];
    rows.shelves.forEach(function (s) {
        others = others.concat(s.videos.filter(function (v) { return !!v.live && v.id !== ended.id; }));
    });
    // By its title (the channel's page: its other live streams); else its only one, as the ended stream's title and
    // channel come from the player, asked in English, and the page in the app's language (YouTube may translate them)
    return others.filter(function (v) { return v.channel === ended.channel && squeeze(v.title) === wanted; })[0] ||
        (others.length === 1 ? others[0] : undefined);
}

/** Prefetches query's results (the focus rests on a suggestion or on Search) */
export function searchAhead(query: string): void {
    searches.aheadJson(query, function () { return askSearch(query).then(tapped); });
}

/** query's results as JSON text (for the cache) */
function askSearch(query: string): Promise<string> {
    return offThreadJson(innertubeText('search', { query: query }), 'rows', rowsOf);
}

/** The next part for a continuation token: a list's next tiles (one shelf) or a screen's next shelves. from: the
 * endpoint the token came from (search tokens go to search) */
export function more(token: string, from?: string): Promise<Rows> {
    return offThread(innertubeText(from || 'browse', { continuation: token }), 'more', moreOf);
}

/** Parses a continuation reply (more) */
export function moreOf(reply: any): Rows {
    return rowsOf(reply && reply.continuationContents);
}

/** Every video of shelves, shelf after shelf (not those of the Shorts rows: a list made of them is of other videos) */
export function allVideos(shelves: Shelf[]): Video[] {
    var videos: Video[] = [];
    shelves.forEach(function (s) {
        if (!s.shorts) {
            videos = videos.concat(s.videos);
        }
    });
    return videos;
}

/** The token for more of rows that are one list in parts (Subscriptions' own, a channel's list there, a channel's
 * Videos page): the page's own, else the one its last shelf has (a grid's is on the grid; a Shorts row is none of the
 * list) */
export function listNext(rows: Rows): string {
    var last: Shelf | undefined;
    for (var i = rows.shelves.length - 1; i >= 0 && !last; i--) {
        last = rows.shelves[i].shorts ? undefined : rows.shelves[i];
    }
    return rows.next || last && last.next || '';
}

/** A video known only by its id (its details come when it plays) */
export function videoOf(id: string): Video {
    return { id: id, title: '', channel: '', length: '', info: '' };
}

/** A video's thumbnail at the size set in Settings: 640x480, 480x360 (both 4:3, the 16:9 picture cropped from the
 * middle) or 320x180, which looks blurry on the 528 px tiles of a 1920 px screen. JPEG rather than WebP: twice the
 * bytes, but the TV decodes it faster (26 vs 38 ms), and each screen decodes its pictures again. Memory with Home
 * browsed: ~88 / 91 / 105 MB (320 / 480 / 640). */
export function thumbnail(id: string): string {
    return 'https://i.ytimg.com/vi/' + id + '/' + thumbnailSize().file + '.jpg';
}

/** A video's thumbnail at each size Settings offer: its file, the width of its 16:9 part */
var THUMBNAILS: { [size: string]: { file: string; width: number } } = {
    sharpest: { file: 'sddefault', width: 640 }, sharp: { file: 'hqdefault', width: 480 }, standard: { file: 'mqdefault', width: 320 }
};

/** The size set in Settings, at most what fills a tile: Sharpest on an HD or Full HD TV's 1280 px window (352 px tiles)
 * is the 480 px picture, which fills them already (44% fewer pixels to decode and keep) */
function thumbnailSize(): { file: string; width: number } {
    var size = THUMBNAILS[prefs().pictures] || THUMBNAILS.standard;
    return size === THUMBNAILS.sharpest && tilePx() <= THUMBNAILS.sharp.width ? THUMBNAILS.sharp : size;
}

/** A page tile's picture and its fallback: YouTube's, or where that is a video's thumbnail narrower than the size set
 * in Settings (imageOf: a show's on Home, 320x180 on a 720 px wide tile, blurry), that video's at the size set,
 * YouTube's the fallback. Picked here, as the tiles are drawn: rows are parsed off the page too, where Settings are not
 * read */
export function pagePicture(v: Video): { image: string; fallback: string } {
    var of = v.imageOf;
    return of && thumbnailSize().width > of.width ? { image: thumbnail(of.id), fallback: v.image || '' } : { image: v.image || '', fallback: '' };
}

/** A video's biggest thumbnail (1280x720; some videos lack it: thumbnail(id) as the fallback) */
export function largestThumbnail(id: string): string {
    return 'https://i.ytimg.com/vi/' + id + '/maxresdefault.jpg';
}

/** Where video id is in a playlist, as "3 / 100" (its place alone when the count is not said; '' not in it) */
export function placeIn(list: PlaylistInfo, id: string): string {
    var at = -1;
    for (var i = 0; i < list.videos.length && at < 0; i++) {
        if (list.videos[i].id === id) {
            at = i;
        }
    }
    return at < 0 ? '' : list.count ? at + 1 + ' / ' + list.count : String(at + 1);
}

/** The picture to use when thumbnail(id) is missing (some videos lack the 640 px one; '' none) */
export function thumbnailFallback(id: string): string {
    return prefs().pictures === 'sharpest' ? 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg' : '';
}

/** The rows of a reply: its shelves in order, with their tiles */
export function rowsOf(reply: unknown): Rows {
    var rows: Rows = { title: '', shelves: [], next: '' };
    var loose: Shelf = { title: '', videos: [] };
    walk(reply, loose, rows);
    if (loose.videos.length) {
        rows.shelves.unshift(loose);
    }
    var out: Shelf[] = [];
    /** Token of a shelf dropped for having no tiles, or of one of Shorts only */
    var dropped = '';
    var others = false;
    for (var i = 0; i < rows.shelves.length; i++) {
        var s = rows.shelves[i];
        var before = out[out.length - 1];
        if (!s.videos.length || s.shorts) {
            dropped = dropped || s.next || '';
        }
        if (!s.videos.length) {
            continue;
        }
        others = others || !s.shorts;
        if (!s.title && !s.grid && !s.shorts && before && !before.title && !before.grid && !before.shorts) {
            before.videos = before.videos.concat(s.videos);
            // The merged row continues with the last shelf's token, if it has one
            before.next = s.next || before.next;
        } else {
            // Row shape from its first tile's style (YouTube styles a row's tiles alike)
            s.style = s.style || s.videos[0].style;
            out.push(s);
        }
    }
    rows.shelves = apartShorts(out);
    // Every tile dropped (or of Shorts, which the filters may hide): keep a token so more can still be fetched
    if (!others) {
        rows.next = rows.next || dropped;
    }
    return rows;
}

/** shelves with each Short in a row of Shorts: a shelf of Shorts alone marked as one (Shelf.shorts); those mixed into a
 * row moved to the front of the reply's first Shorts row (in their order: they were ranked among the other videos; once
 * each), else into one of their own right after that row; those in a grid among other videos dropped (a grid is one
 * list, of one shape) */
function apartShorts(shelves: Shelf[]): Shelf[] {
    var target: Shelf | null = null;
    var mixed = false;
    for (var i = 0; i < shelves.length; i++) {
        var s = shelves[i];
        var n = 0;
        for (var j = 0; j < s.videos.length; j++) {
            n += s.videos[j].short ? 1 : 0;
        }
        if (n && n === s.videos.length) {
            s.shorts = true;
            s.style = 'short';
        }
        if (s.shorts) {
            target = target || s;
        } else if (n) {
            mixed = true;
        }
    }
    if (!mixed) {
        return shelves;
    }
    var out: Shelf[] = [];
    var moved: Video[] = [];
    shelves.forEach(function (s) {
        out.push(s);
        if (s.shorts || !s.videos.some(isShort)) {
            return;
        }
        var shorts = s.videos.filter(isShort);
        s.videos = s.videos.filter(function (v) { return !v.short; });
        // (a row's shape is its first tile's: one of the others now)
        if (s.style === 'short') {
            s.style = s.videos[0].style;
        }
        if (s.grid) {
            return;
        }
        if (target) {
            moved = moved.concat(shorts);
        } else {
            out.push({ title: '', videos: shorts, shorts: true, style: 'short' });
        }
    });
    if (target && moved.length) {
        var seen: { [id: string]: boolean } = {};
        target.videos = moved.concat(target.videos).filter(function (v) {
            var fresh = !seen[v.id];
            seen[v.id] = true;
            return fresh;
        });
    }
    return out;
}

function isShort(v: Video): boolean {
    return !!v.short;
}

function walk(v: any, shelf: Shelf, rows: Rows): void {
    if (!v || typeof v !== 'object') {
        return;
    }
    if (v instanceof Array) {
        for (var i = 0; i < v.length; i++) {
            walk(v[i], shelf, rows);
        }
        return;
    }
    for (var key in v) {
        var x = v[key];
        if (key === 'shelfRenderer') {
            var own: Shelf = { title: shelfTitle(x), videos: [] };
            if (x.tvhtml5ShelfRendererType === 'TVHTML5_SHELF_RENDERER_TYPE_SHORTS') {
                own.shorts = true;
                own.style = 'short';
            }
            var lockup = get(x, 'headerRenderer', 'shelfHeaderRenderer', 'avatarLockup', 'avatarLockupRenderer');
            var line = text(get(lockup, 'subtitle')) || text(get(x, 'headerRenderer', 'shelfHeaderRenderer', 'subtitle'));
            if (line) {
                own.subtitle = line;
            }
            if (get(lockup, 'thumbnail')) {
                own.icon = picture(get(lockup, 'thumbnail'));
            }
            // A topic's row: its name a topic and a word after it ("Science", " and more": two runs in every language),
            // or headed by a topic channel (its picture before the name, the shelf opening the channel)
            if ((get(lockup, 'title', 'runs') || []).length >= 2 || own.icon && /^UC/.test(get(x, 'endpoint', 'browseEndpoint', 'browseId') || '')) {
                own.topic = true;
            }
            rows.shelves.push(own);
            // Only its content: the header was read above (a carousel's holds the focused tile's text)
            walk(x.content, own, rows);
        } else if (key === 'gridRenderer' || key === 'gridContinuation' || key === 'playlistVideoListRenderer' || key === 'playlistVideoListContinuation') {
            var grid: Shelf = { title: '', videos: [], grid: true, next: nextOf(x) };
            rows.shelves.push(grid);
            if (key === 'playlistVideoListRenderer' && x.playlistId) {
                rows.playlistId = x.playlistId;
                rows.chart = CHARTS.test(x.playlistId) || undefined;
            }
            walk(x, grid, rows);
        } else if (key === 'horizontalListRenderer' || key === 'horizontalListContinuation') {
            shelf.next = nextOf(x);
            walk(x, shelf, rows);
        } else if (key === 'sectionListRenderer' || key === 'sectionListContinuation') {
            // (one inside another without a token keeps the screen's)
            rows.next = nextOf(x) || rows.next;
            walk(x, shelf, rows);
        } else if (key === 'tvSecondaryNavRenderer') {
            // Tabs: names and tokens; the tab that carries tiles is the one shown (chosen)
            rows.title = rows.title || text(x.title);
            var tabs: Tab[] = rows.tabs = [];
            var shown: Tab | null = null;
            (x.sections || []).forEach(function (section: any) {
                (get(section, 'tvSecondaryNavSectionRenderer', 'tabs') || []).forEach(function (t: any) {
                    var tab = t.tabRenderer || {};
                    var surface = get(tab, 'content', 'tvSurfaceContentRenderer');
                    var own: Tab = { title: text(tab.title), chosen: !!tab.selected, token: get(surface, 'continuation', 'reloadContinuationData', 'continuation') || '' };
                    if (get(tab, 'icon', 'iconType')) {
                        own.icon = tab.icon.iconType;
                    }
                    tabs.push(own);
                    if (surface && surface.content) {
                        shown = shown || own;
                        // (a channel's list in Subscriptions: its handle, under its name in the list's header)
                        var handle = text(get(surface, 'header', 'tvSurfaceHeaderRenderer', 'avatar', 'avatarLockupRenderer', 'subtitle'));
                        if (handle) {
                            rows.handle = handle;
                        }
                        walk(surface.content, shelf, rows);
                    }
                });
            });
            if (shown && !tabs.some(function (t) { return t.chosen; })) {
                (shown as Tab).chosen = true;
            }
        } else if (key === 'tvSurfaceHeaderRenderer' || key === 'entityMetadataRenderer' || key === 'channelHeaderRenderer') {
            // A page header: title and buttons (not walked: its buttons and menus hold no tiles of the page)
            rows.title = rows.title || text(x.title);
            var buttons = key !== 'channelHeaderRenderer' && !rows.buttons ? (x.buttons || []).map(pageButton).filter(function (b: PageButton | null) { return !!b; }) : [];
            if (buttons.length) {
                rows.buttons = buttons;
            }
            // A playlist's left column: byline and privacy lock
            if (key === 'entityMetadataRenderer' && x.bylines) {
                rows.side = { byline: lineText(x.bylines[0]), private: all(x.bylines[0], 'iconType').indexOf('PRIVACY_PRIVATE') >= 0, count: countOf(x.bylines[0]) };
            }
        } else if (key === 'genericPromoRenderer') {
            rows.empty = rows.empty || text(x.bodyText);
        } else if (key === 'feedNudgeRenderer') {
            rows.nudge = rows.nudge || nudgeOf(x);
        } else if (key === 'tileRenderer' || key === 'lockupViewModel') {
            var video = tileVideo(key, x);
            if (video) {
                shelf.videos.push(video);
            }
        } else if (key !== 'continuations') {
            walk(x, shelf, rows);
        }
    }
}

/** Parses a feedNudgeRenderer: its text and buttons */
function nudgeOf(nudge: any): Nudge {
    var buttons = [nudge.primaryButton, nudge.secondaryButton].map(function (b: any) { return b && b.buttonRenderer; })
        .filter(function (b: any) { return b && b.command; });
    return {
        title: text(nudge.title), subtitle: text(nudge.subtitle), or: text(get(nudge, 'neutralButton', 'buttonRenderer', 'text')),
        buttons: buttons.map(function (b: any) { return { text: text(b.text), command: b.command }; })
    };
}

/** A list's token for its next part ('' none) */
export function nextOf(list: any): string {
    return get((list.continuations || [])[0], 'nextContinuationData', 'continuation') || '';
}

function shelfTitle(shelf: any): string {
    var header = get(shelf, 'headerRenderer', 'shelfHeaderRenderer') || get(shelf, 'headerRenderer', 'heroCarouselHeaderRenderer', 'header', 'shelfHeaderRenderer');
    return (text(get(header, 'title')) || text(get(header, 'avatarLockup', 'avatarLockupRenderer', 'title'))).trim();
}

/** A page a command opens (null: it opens none) */
export function pageOf(command: any): Page | null {
    var browse = get(command, 'browseEndpoint');
    return browse && browse.browseId ? (browse.params ? { browseId: browse.browseId, params: browse.params } : { browseId: browse.browseId }) : null;
}

/** A menu's item: its title, and YouTube's command for it (one may hold several: commandsOf) */
export interface MenuItem {
    title: string;
    command: any;
}

/** A menu's items in order (old and new renderer formats alike) */
export function itemsOf(menu: any): MenuItem[] {
    var items: MenuItem[] = [];
    (function walk(v: any): void {
        if (!v || typeof v !== 'object') {
            return;
        }
        for (var key in v) {
            var x = v[key];
            if (key === 'menuServiceItemRenderer' || key === 'menuNavigationItemRenderer') {
                items.push({ title: text(x.text), command: x.serviceEndpoint || x.navigationEndpoint || x.command });
            } else if (key === 'listItemViewModel') {
                items.push({ title: text(x.title), command: get(x, 'rendererContext', 'commandContext', 'onTap', 'innertubeCommand') });
            } else {
                walk(x);
            }
        }
    })(menu);
    return items.filter(function (i) { return i.title && i.command; });
}

/** A tile's long-press command as kept: the items of the menu it carries (titles and commands), else as it is (a
 * panel asked for on opening). The rest of YouTube's menu was nine tenths of a channel page's rows */
export function menuOf(press: any): any {
    var own = first(press, 'menuRenderer');
    return own ? { items: itemsOf(own) } : press;
}

/** The window's width (px): the page's, or in the parse worker (which has none) the one its messages say */
var windowWidth = 1920;

/** The parse worker is told the page's window width (api/off-thread.ts sends it with each reply) */
export function setWindowWidth(width: number): void {
    windowWidth = width;
}

/** A tile's width on the screen (px): 352 layout units at the window's scale, 528 on a 1920 px window and 352 on an HD
 * or Full HD TV's 1280 (a smaller picture to decode there) */
function tilePx(): number {
    return Math.round(352 * Math.max(1, screenWidth() / 1280));
}

function screenWidth(): number {
    return typeof window !== 'undefined' ? window.innerWidth : windowWidth;
}

/** A picture URL from YouTube's list of sizes: the smallest at least a tile (or fill px) wide, else the largest; '//'
 * URLs get https; px: request a round picture at that size */
export function picture(thumbs: any, px?: number, fill?: number): string {
    var list = sizesOf(thumbs);
    var pick: any = null;
    var largest: any = null;
    // The smallest that fills a tile, or fill px (a 1200 px mix picture takes the TV ~200 ms to decode), in whatever
    // order
    for (var i = 0; i < list.length; i++) {
        var w = +list[i].width || 0;
        if (w >= (fill || tilePx()) && (!pick || w < pick.width)) {
            pick = list[i];
        }
        if (w && (!largest || w > largest.width)) {
            largest = list[i];
        }
    }
    // None that big: the biggest; none with sizes: the last (YouTube lists them smallest first)
    pick = pick || largest || list[list.length - 1];
    var url = pick ? String(pick.url || '') : '';
    url = url.indexOf('//') === 0 ? 'https:' + url : url;
    return px ? sized(url, px) : url;
}

/** YouTube's list of a picture's sizes */
function sizesOf(thumbs: any): any[] {
    return (thumbs && (thumbs.thumbnails || thumbs.sources)) || [];
}

/** A page tile with its picture as YouTube lists it, and where that is a video's own thumbnail and none listed fills a
 * tile, that video and the width listed (imageOf: a bigger copy for pagePicture; a playlist's own picture, signed for
 * its size, has none) */
function withPicture(video: Video, thumbs: any): Video {
    video.image = picture(thumbs);
    var widest = 0;
    sizesOf(thumbs).forEach(function (one) { widest = Math.max(widest, +one.width || 0); });
    var of = widest && widest < tilePx() ? /^https:\/\/i\.ytimg\.com\/vi\/([\w-]{11})\/(?:mq|hq)default\.jpg/.exec(video.image) : null;
    if (of) {
        video.imageOf = { id: of[1], width: widest };
    }
    return video;
}

/** A round picture's URL (a channel's, an account's) at another size */
export function sized(url: string, px: number): string {
    return url.replace(/=s\d+/, '=s' + px);
}

/** A stack's edges when YouTube gives no colours: drawn in the stylesheet's (themes/youtube.css bd-tile-stack, which
 * the light look turns), none set on them */
var STACK = ['', ''];

/** YouTube's colour number (ARGB) as CSS */
function argb(n: number): string {
    var c = n >>> 0;
    return 'rgba(' + (c >>> 16 & 255) + ', ' + (c >>> 8 & 255) + ', ' + (c & 255) + ', ' + ((c >>> 24 & 255) / 255).toFixed(2) + ')';
}

/** Overlay iconTypes mapped to the label icons the theme draws on a tile's picture */
var LABEL_ICONS: { [iconType: string]: string } = { LIVE: 'live', PLAYLISTS: 'playlist', MIX: 'mix' };

/** YouTube's tile styles drawn as the usual tile */
var PLAIN_STYLES: { [style: string]: boolean } = { TILE_STYLE_YTLR_DEFAULT: true, TILE_STYLE_YTLR_CAROUSEL: true };
/** YouTube's tile styles that change a tile's shape */
var TILE_STYLES: { [style: string]: string } = { TILE_STYLE_YTLR_SQUARE: 'square', TILE_STYLE_YTLR_GAME: 'game', TILE_STYLE_YTLR_VERTICAL_LIST: 'list',
    TILE_STYLE_YTLR_ROUND: 'round', TILE_STYLE_YTLR_SHORTS: 'short' };

/** A Short's tile width in layout units (ui/themes/youtube.ts metrics.short): its picture is the smallest of YouTube's
 * at least that wide on the screen */
var SHORT_W = 180;

/** A Short: its id, title, channel (YouTube's Shorts tiles may name none but in their menu), views line, the first of
 * pictures that is upright (YouTube's own for the tile; a Short among other videos has a 16:9 one, and its start's
 * frame upright), its long-press command, and the token of the
 * Shorts YouTube plays after it (its tile's sequenceParams) */
function shortOf(id: string, title: string, channel: string, info: string, pictures: any[], press: any, sequence?: string): Video | null {
    if (!id) {
        return null;
    }
    // (its mark first: the rows' text is read for the videos to brand ahead, Shorts left out: main.ts tapAhead)
    var video: Video = { short: true, id: id, title: title, channel: channel, length: '', info: info, style: 'short' };
    for (var i = 0; i < pictures.length && !video.image; i++) {
        var size = sizesOf(pictures[i])[0];
        if (size && +size.height > +size.width) {
            video.image = picture(pictures[i], 0, Math.round(SHORT_W * Math.max(1, screenWidth() / 1280)));
        }
    }
    if (press) {
        video.menu = menuOf(press);
    }
    if (sequence) {
        video.sequence = String(sequence);
    }
    return video;
}

/** The channel a Short's menu names ("The Daily Show • @TheDailyShow": its name before the handle) */
function pressChannel(press: any): string {
    var line = text(get(first(press, 'showMenuCommand'), 'subtitle'));
    var cut = line.indexOf(' • ');
    return cut > 0 ? line.slice(0, cut) : line;
}

/** A tile's video (null: not a video, or a tile the parser fails on: left out, the screen shows the rest). Apart from
 * walk: try/catch keeps old V8 from optimising the function it is in */
function tileVideo(key: string, x: any): Video | null {
    try {
        var v = key === 'tileRenderer' ? fromTile(x) : fromLockup(x);
        // A video YouTube no longer shows (made private, deleted): its tile has no title and one line only, "No views"
        // (read as its channel), no line of views and age, and a picture that is not there (seen 2026-11-14 in a
        // playlist and a phone's queue): left out, as YouTube's phone app does, in every row, page and list alike. A
        // video tile merely without a title (YouTube moving it) keeps its views line, and stays
        return v && !v.page && !v.title && !v.info ? null : v;
    } catch (e) {
        return null;
    }
}

/** Parses a tileRenderer (Subscriptions, Home, Library, pages) */
function fromTile(tile: any): Video | null {
    var header = get(tile, 'header', 'tileHeaderRenderer');
    var overlays = get(header, 'thumbnailOverlays') || [];
    // A movie's metadata is in an overlay over its picture, shown when focused
    var meta = get(tile, 'metadata', 'tileMetadataRenderer') || spotlight(tile) || overlays.map(function (o: any) { return o.tileMetadataRenderer; })
        .filter(function (m: any) { return !!m; })[0];
    var lines = (get(meta, 'lines') || get(meta, 'bylines') || []).map(lineText);
    var badge = '';
    var watched = 0;
    var live = false;
    var upcoming = false;
    var audio = false;
    var labelIcon = '';
    var stacked = false;
    overlays.forEach(function (o: any) {
        badge = badge || text(get(o, 'thumbnailOverlayTimeStatusRenderer', 'text'));
        live = live || get(o, 'thumbnailOverlayTimeStatusRenderer', 'style') === 'LIVE';
        upcoming = upcoming || get(o, 'thumbnailOverlayTimeStatusRenderer', 'style') === 'UPCOMING';
        var icon = get(o, 'thumbnailOverlayTimeStatusRenderer', 'icon', 'iconType');
        audio = audio || icon === 'AUDIO';
        labelIcon = labelIcon || LABEL_ICONS[icon] || '';
        stacked = stacked || !!o.thumbnailOverlayStackingEffectRenderer;
        watched = watched || +get(o, 'thumbnailOverlayResumePlaybackRenderer', 'percentDurationWatched') || 0;
    });
    // A Short: plays as a video, shown in a row of Shorts
    var reel = get(tile, 'onSelectCommand', 'reelWatchEndpoint');
    if (tile.contentType === 'TILE_CONTENT_TYPE_SHORTS' || reel) {
        var short = shortOf(get(reel, 'videoId') || tile.contentId, text(get(meta, 'title')), lines.length > 1 ? lines[0] : pressChannel(tile.onLongPressCommand),
            lines.length > 1 ? lines[1] : lines[0] || '', [get(header, 'thumbnail'), get(reel, 'thumbnail')], tile.onLongPressCommand, get(reel, 'sequenceParams'));
        if (short && watched) {
            short.progress = watched / 100;
        }
        return short;
    }
    var style = TILE_STYLES[tile.style] || '';
    // A video tile may open a page instead: a film's (MV…, played by YouTube's player), or a show's (a podcast's
    // playlist, with no length: opened as a page, as YouTube's app does); one with a length plays as a video
    var browse = get(tile, 'onSelectCommand', 'browseEndpoint');
    var film = !!browse && /^MV/.test(browse.browseId || '');
    if (tile.contentType !== 'TILE_CONTENT_TYPE_VIDEO' || browse && !film && !duration(badge)) {
        var opens = pageOf(tile.onSelectCommand);
        // Library's own tiles have their name over the picture, not under it
        var name = get(meta, 'title') || get(overlays[0], 'tileMetadataRenderer', 'title');
        var found: Video | null = opens ? withPicture({ id: opens.browseId + (opens.params || ''), title: text(name), channel: lines[0] || '', length: badge,
            info: lines[1] || '', page: opens }, get(header, 'thumbnail')) : null;
        if (found && style) {
            found.style = style;
            // Round tiles (e.g. Music's favourite artists)
            found.round = style === 'round' || undefined;
        }
        if (found && labelIcon) {
            found.labelIcon = labelIcon;
        }
        // A playlist or mix is drawn as a stack where YouTube has a stacking overlay (not on podcast or album
        // squares); its edges in YouTube's colours, else grey
        if (found && stacked) {
            found.stack = STACK;
            overlays.forEach(function (o: any) {
                for (var key in o) {
                    if (o[key] && o[key].lowerStackColor) {
                        found!.stack = [argb(o[key].lowerStackColor), argb(o[key].upperStackColor)];
                    }
                }
            });
        }
        return found;
    }
    var id = tile.contentId || get(tile, 'onSelectCommand', 'watchEndpoint', 'videoId');
    if (!id) {
        return null;
    }
    var video: Video = { id: id, title: text(get(meta, 'title')), channel: lines[0] || '', length: duration(badge), info: lines[1] || '' };
    var chipLine = (get(meta, 'lines') || [])[1];
    var chips = lineBadges(chipLine);
    if (chips.length) {
        video.badges = chips;
    }
    if (membersOnly(get(meta, 'lines'))) {
        video.members = true;
    }
    var offer = (get(chipLine, 'lineRenderer', 'items') || []).map(function (item: any) {
        return get(item, 'lineItemRenderer', 'badge', 'metadataBadgeRenderer');
    }).filter(function (b: any) { return b && b.style === 'BADGE_STYLE_TYPE_YPC'; })[0];
    if (offer) {
        video.offer = text(offer.label);
    }
    if (upcoming) {
        video.upcoming = true;
    }
    if (live) {
        video.live = true;
        video.labelIcon = 'live';
    }
    if (audio) {
        video.audio = true;
    }
    if (style) {
        video.style = style;
    } else if (tile.style && !PLAIN_STYLES[tile.style]) {
        video.newStyle = tile.style;
    }
    if (film) {
        video.movie = true;
    }
    // A poster tile (YouTube Movies), with a wide picture for when it is focused
    if (get(tile, 'styling', 'headerAspectRatio') === 'TILE_HEADER_ASPECT_RATIO_POSTER') {
        video.style = 'poster';
        video.poster = picture(get(header, 'thumbnail'));
        video.wide = picture(get(header, 'onFocusThumbnail'));
    }
    if (tile.onLongPressCommand) {
        video.menu = menuOf(tile.onLongPressCommand);
    }
    if (watched) {
        video.progress = watched / 100;
    }
    var start = +get(tile, 'onSelectCommand', 'watchEndpoint', 'startTimeSeconds');
    if (start > 0) {
        video.start = start;
    }
    return video;
}

/** A carousel tile's metadata: what the carousel shows above the row while the tile is focused (its title, and the
 * channel as a byline). Carousel tiles have no text of their own. */
function spotlight(tile: any): any {
    var commands = get(tile, 'onFocusCommand', 'commandExecutorCommand', 'commands') || [];
    for (var i = 0; i < commands.length; i++) {
        var shown = get(commands[i], 'updateCarouselHeaderCommand', 'spotlight', 'entityMetadataRenderer');
        if (shown) {
            return shown;
        }
    }
    return null;
}

/** Parses a lockupViewModel (Search) */
function fromLockup(lockup: any): Video | null {
    var meta = get(lockup, 'metadata', 'lockupMetadataViewModel');
    var rows = (get(meta, 'metadata', 'contentMetadataViewModel', 'metadataRows') || []).map(function (row: any) {
        return (row.metadataParts || []).map(function (part: any) {
            return text(part.text);
        }).join(' • ');
    });
    // Videos, music and mixes (starting with their first video) play; the rest open a page
    var tap = get(lockup, 'rendererContext', 'commandContext', 'onTap', 'innertubeCommand');
    var watch = get(tap, 'watchEndpoint');
    var thumb = get(lockup, 'contentImage', 'thumbnailViewModel') || get(lockup, 'contentImage', 'collectionThumbnailViewModel', 'primaryThumbnail', 'thumbnailViewModel');
    var reel = get(tap, 'reelWatchEndpoint');
    var press = get(lockup, 'rendererContext', 'commandContext', 'onLongPress');
    if (lockup.contentType === 'LOCKUP_CONTENT_TYPE_SHORT' || reel) {
        return shortOf(lockup.contentId || get(reel, 'videoId'), text(get(meta, 'title')), rows[0] || pressChannel(press), rows[1] || '',
            [get(thumb, 'image'), get(reel, 'thumbnail')], press, get(reel, 'sequenceParams'));
    }
    var mix = lockup.contentType === 'LOCKUP_CONTENT_TYPE_PLAYLIST' && watch && watch.videoId ? watch.videoId as string : '';
    var plays = (lockup.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO' || lockup.contentType === 'LOCKUP_CONTENT_TYPE_MUSIC') && lockup.contentId;
    if (!plays && !mix) {
        var opens = pageOf(tap);
        var page: Video | null = opens ? withPicture({ id: opens.browseId + (opens.params || ''), title: text(get(meta, 'title')), channel: '', length: '',
            info: '', page: opens }, get(thumb, 'image')) : null;
        // A playlist or show: a stack, with its count ("76 episodes")
        var collection = get(lockup, 'contentImage', 'collectionThumbnailViewModel');
        if (page && collection) {
            page.stack = STACK;
            (get(collection, 'primaryThumbnail', 'thumbnailViewModel', 'overlays') || []).forEach(function (o: any) {
                (get(o, 'thumbnailOverlayBadgeViewModel', 'thumbnailBadges') || []).forEach(function (b: any) {
                    page!.length = page!.length || text(get(b, 'thumbnailBadgeViewModel', 'text'));
                });
            });
        }
        // A channel: round picture, with its handle and subscribers under its name
        if (page && get(lockup, 'contentImage', 'thumbnailViewModel', 'styling', 'isCircular')) {
            page.round = true;
            page.channel = rows[0] || '';
            page.info = rows[1] || '';
        }
        return page;
    }
    var length = '';
    var live = false;
    var upcoming = false;
    var audio = false;
    (get(thumb, 'overlays') || []).forEach(function (o: any) {
        var badges = get(o, 'thumbnailBottomOverlayViewModel', 'badges') || get(o, 'thumbnailOverlayBadgeViewModel', 'thumbnailBadges') || [];
        badges.forEach(function (b: any) {
            var badge = get(b, 'thumbnailBadgeViewModel');
            length = length || text(get(badge, 'text'));
            live = live || get(badge, 'badgeStyle') === 'THUMBNAIL_OVERLAY_BADGE_STYLE_LIVE';
            upcoming = upcoming || /UPCOMING/.test(get(badge, 'badgeStyle') || '');
            audio = audio || get(badge, 'icon', 'sources', 0, 'clientResource', 'imageName') === 'AUDIO';
        });
    });
    var found: Video = { id: mix || lockup.contentId, title: text(get(meta, 'title')), channel: rows[0] || '', length: duration(length), info: rows[1] || '' };
    (get(meta, 'metadata', 'contentMetadataViewModel', 'metadataRows') || []).forEach(function (row: any) {
        (row.badges || []).forEach(function (b: any) {
            if (/MEMBERS/.test(get(b, 'badgeViewModel', 'badgeStyle') || '')) {
                found.members = true;
            }
        });
    });
    if (upcoming) {
        found.upcoming = true;
    }
    if (live) {
        found.live = true;
        found.labelIcon = 'live';
    }
    if (audio) {
        found.audio = true;
    }
    if (mix) {
        found.length = 'Mix';
        found.labelIcon = 'mix';
        found.stack = STACK;
        // The mix's own picture, not its first video's
        found.image = picture(get(thumb, 'image'));
    }
    if (press) {
        found.menu = menuOf(press);
    }
    return found;
}

/** A video's age within a day, as YouTube writes it in the app's languages (it gives no date, only the words): seconds,
 * minutes or hours ago (3 hours ago, vor 3 Stunden, for 3 timer siden, hace 3 horas, il y a 3 heures, 3 ore fa, 3 uur
 * geleden, 3 órával ezelőtt, 3 godziny temu, há 3 horas, 3 часа назад, 3 時間前, 3시간 전) */
var WITHIN_A_DAY = /\d\s*(second|segund|sekund|minut|minuu|hour|hora|heure|stund|\btimer?\b|\bor[ae]\b|\buur\b|órá|perc|másodperc|godzin|час|секунд|минут|時間前|分前|秒前|시간 전|분 전|초 전)/i;

/** The same for the languages added on 2026-11-26, each its own: Unicode CLDR's long relative times (every plural
 * form; the number \d+), checked against the ages in YouTube's answers in each language (Azerbaijani: YouTube's
 * "əvvəl" besides CLDR's "öncə"), their common parts grouped where that keeps them exact. One language's alone is made
 * into a regular expression, once it is asked for */
var AGES: { [code: string]: string } = {
    ro: 'acum\\s*\\d+\\s*(?:secundă|secunde|de\\s+secunde|minut|minute|de\\s+minute|oră|ore|de\\s+ore)',
    af: '\\d+\\s*(?:sekonde\\s+gelede|sekondes\\s+gelede|minuut\\s+gelede|minute\\s+gelede|uur\\s+gelede)',
    az: '\\d+\\s*(?:saniyə\\s+öncə|dəqiqə\\s+öncə|saat\\s+öncə|saniyə\\s+əvvəl|dəqiqə\\s+əvvəl|saat\\s+əvvəl)',
    id: '\\d+\\s*(?:detik\\s+yang\\s+lalu|menit\\s+yang\\s+lalu|jam\\s+yang\\s+lalu)',
    ms: '\\d+\\s*(?:saat\\s+lalu|minit\\s+lalu|jam\\s+lalu)',
    bs: 'prije\\s*\\d+\\s*(?:sekundu|sekunde|sekundi|minutu|minute|minuta|sat|sata|sati)',
    ca: 'fa\\s*\\d+\\s*(?:segon|segons|minut|minuts|hora|hores)',
    cs: 'před\\s*\\d+\\s*(?:sekundou|sekundami|minutou|minutami|hodinou|hodinami)',
    et: '\\d+\\s*(?:sekundi\\s+eest|minuti\\s+eest|tunni\\s+eest)',
    eu: 'duela\\s*\\d+\\s*(?:segundo|minutu|ordu)',
    fil: '\\d+\\s*(?:segundo\\s+ang\\s+nakalipas|minuto\\s+ang\\s+nakalipas|oras\\s+ang\\s+nakalipas)',
    gl: 'hai\\s*\\d+\\s*(?:segundo|segundos|minuto|minutos|hora|horas)',
    hr: 'prije\\s*\\d+\\s*(?:sekundu|sekunde|sekundi|minutu|minute|minuta|sat|sata|sati)',
    zu: '\\d+\\s*isekhondi\\s+eledlule|\\d+\\s*amasekhondi\\s+edlule|\\d+\\s*iminithi\\s+eledlule|\\d+\\s*amaminithi\\s+edlule|\\d+\\s*ihora\\s+eledlule|emahoreni\\s+angu-\\s*\\d+\\s*edlule',
    is: 'fyrir\\s*\\d+\\s*(?:sekúndu|sekúndum|mínútu|mínútum|klukkustund|klukkustundum)',
    sw: '(?:Sekunde|dakika|saa)\\s*\\d+\\s*(?:iliyopita|zilizopita)',
    lv: 'pirms\\s*\\d+\\s*(?:sekundes|sekundēm|minūtes|minūtēm|stundas|stundām)',
    lt: 'prieš\\s*\\d+\\s*(?:sekundę|sekundes|sekundžių|minutę|minutes|minučių|valandą|valandas|valandų)',
    no: 'for\\s*\\d+\\s*(?:sekund\\s+siden|sekunder\\s+siden|minutt\\s+siden|minutter\\s+siden|time\\s+siden|timer\\s+siden)',
    uz: '\\d+\\s*(?:soniya\\s+oldin|daqiqa\\s+oldin|soat\\s+oldin)',
    'pt-PT': 'há\\s*\\d+\\s*(?:segundo|segundos|minuto|minutos|hora|horas)',
    sq: '\\d+\\s*(?:sekondë\\s+më\\s+parë|sekonda\\s+më\\s+parë|minutë\\s+më\\s+parë|minuta\\s+më\\s+parë|orë\\s+më\\s+parë)',
    sk: 'pred\\s*\\d+\\s*(?:sekundou|sekundami|minútou|minútami|hodinou|hodinami)',
    sl: 'pred\\s*\\d+\\s*(?:sekundo|sekundama|sekundami|minuto|minutama|minutami|uro|urama|urami)',
    'sr-Latn': 'pre\\s*\\d+\\s*(?:sekunde|sekundi|minuta|sata|sati)',
    fi: '\\d+\\s*(?:sekunti\\s+sitten|sekuntia\\s+sitten|minuutti\\s+sitten|minuuttia\\s+sitten|tunti\\s+sitten|tuntia\\s+sitten)',
    sv: 'för\\s*\\d+\\s*(?:sekund\\s+sedan|sekunder\\s+sedan|minut\\s+sedan|minuter\\s+sedan|timme\\s+sedan|timmar\\s+sedan)',
    vi: '\\d+\\s*(?:giây\\s+trước|phút\\s+trước|giờ\\s+trước)',
    tr: '\\d+\\s*(?:saniye\\s+önce|dakika\\s+önce|saat\\s+önce)',
    be: '\\d+\\s*(?:секунду\\s+таму|секунды\\s+таму|секунд\\s+таму|хвіліну\\s+таму|хвіліны\\s+таму|хвілін\\s+таму|гадзіну\\s+таму|гадзіны\\s+таму|гадзін\\s+таму)',
    bg: 'преди\\s*\\d+\\s*(?:секунда|секунди|минута|минути|час|часа)',
    ky: '\\d+\\s*(?:секунд\\s+мурун|мүнөт\\s+мурун|саат\\s+мурун)',
    kk: '\\d+\\s*(?:секунд\\s+бұрын|минут\\s+бұрын|сағат\\s+бұрын)',
    mk: 'пред\\s*\\d+\\s*(?:секунда|секунди|минута|минути|час|часа)',
    mn: '\\d+\\s*(?:секундын\\s+өмнө|минутын\\s+өмнө|цагийн\\s+өмнө)',
    sr: 'пре\\s*\\d+\\s*(?:секунде|секунди|минута|сата|сати)',
    uk: '\\d+\\s*(?:секунду\\s+тому|секунди\\s+тому|секунд\\s+тому|хвилину\\s+тому|хвилини\\s+тому|хвилин\\s+тому|годину\\s+тому|години\\s+тому|годин\\s+тому)',
    el: 'πριν\\s+από\\s*\\d+\\s*(?:δευτερόλεπτο|δευτερόλεπτα|λεπτό|λεπτά|ώρα|ώρες)'
};
var ages: { [code: string]: RegExp } = {};

/** Whether a video's info line (its views and age) says it came within a day, in language code (the app's: this module
 * is also the parsing worker's, which has no language of its own) */
export function withinADay(info: string, code: string): boolean {
    if (!AGES[code]) {
        return WITHIN_A_DAY.test(info);
    }
    var own = ages[code] || (ages[code] = new RegExp(AGES[code], 'i'));
    return own.test(info);
}

/** A length as "1:02:03" or "10:35" (written with dots in some languages: 1.02.03); anything else (LIVE, a word) is not
 * one */
function duration(s: string): string {
    return /^\d+([:.]\d\d)+$/.test(s) ? s.replace(/\./g, ':') : '';
}

/** Parses a page header button (null: unsupported) */
function pageButton(b: any): PageButton | null {
    var t = b.toggleButtonRenderer;
    if (t && t.defaultServiceEndpoint && t.toggledServiceEndpoint) {
        var off = text(t.defaultText);
        return { text: off, icon: iconOf(t.defaultIcon), toggle: { on: !!t.isToggled, texts: [off, text(t.toggledText) || off],
            icons: [iconOf(t.defaultIcon), iconOf(t.toggledIcon) || iconOf(t.defaultIcon)], commands: [t.defaultServiceEndpoint, t.toggledServiceEndpoint] } };
    }
    var r = b.buttonRenderer;
    // Plays the playlist (Repeat, Shuffle): from its start, as the page lists it
    if (get(r, 'navigationEndpoint', 'watchEndpoint')) {
        var kind = iconOf(r.icon);
        return { text: text(r.text), icon: kind, play: { loop: kind === 'LOOP', shuffle: kind === 'SHUFFLE' } };
    }
    var overlay = get(r, 'command', 'openPopupAction', 'popup', 'overlaySectionRenderer', 'overlay');
    if (!overlay) {
        return null;
    }
    // A choice list (the action panel of a two-panel overlay), or a confirmation (one panel: yes and Cancel)
    var listed = get(overlay, 'overlayTwoPanelRenderer', 'actionPanel', 'overlayPanelRenderer');
    var panel = listed || overlay.overlayPanelRenderer;
    var head = get(panel, 'header', 'overlayPanelHeaderRenderer');
    var list = get(panel, 'content', 'overlayPanelItemListRenderer') || {};
    var items = (list.items || []).map(function (i: any) { return i.buttonRenderer; }).filter(function (i: any) { return !!i; });
    var button: PageButton = { text: text(r.text), icon: iconOf(r.icon) };
    if (listed) {
        var choices: { text: string; chosen: boolean; page: Page }[] = [];
        // The chosen item: the one with a check icon, else selectedIndex among all items
        var ticked = items.some(function (i: any) { return get(i, 'secondaryIcon', 'iconType') === 'CHECK'; });
        (list.items || []).forEach(function (entry: any, n: number) {
            var i = entry.buttonRenderer;
            var browse = i && commandsOf(i.command).filter(function (c) { return !!c.browseEndpoint; })[0];
            if (browse) {
                var chosen = ticked ? get(i, 'secondaryIcon', 'iconType') === 'CHECK' : n === (list.selectedIndex || 0);
                choices.push({ text: text(i.text), chosen: chosen, page: pageOf(browse) as Page });
            }
        });
        button.choices = { title: text(head && head.title), items: choices };
        return choices.length ? button : null;
    }
    button.ask = askOf(panel, CLEARS) || undefined;
    return button.ask ? button : null;
}

function iconOf(icon: any): string {
    return get(icon, 'iconType') || '';
}

/** A command's commands (a commandExecutorCommand's in their order, nested ones too; an authDeterminedCommand's for a
 * signed-in account, as the app sends them: e.g. a playlist's Save to library; else itself) */
export function commandsOf(command: any): any[] {
    var signedIn = get(command, 'authDeterminedCommand', 'authenticatedCommand');
    if (signedIn) {
        return commandsOf(signedIn);
    }
    var inner = get(command, 'commandExecutorCommand', 'commands');
    return inner ? inner.reduce(function (all: any[], c: any) { return all.concat(commandsOf(c)); }, []) : command ? [command] : [];
}

/** The message YouTube gives with a command (its toast, or an overlay message shown as one, e.g. Saved to library; ''
 * none) */
export function toastOf(command: any): string {
    var message = first(command, 'overlayMessageRenderer');
    return text(get(first(command, 'overlayToastRenderer'), 'title')) || (message && /TOAST/.test(message.style) ? text(message.title) : '');
}

/** A confirmation in an overlay panel: its header and yes/no buttons, where yes runs a command named in names (null:
 * not one) */
export function askOf(panel: any, names: string[]): Ask | null {
    var head = get(panel, 'header', 'overlayPanelHeaderRenderer');
    var buttons = all(panel, 'buttonRenderer');
    var command = buttons.length === 2 && commandsOf(buttons[0].command).filter(function (c) {
        return names.some(function (name) { return !!c[name]; });
    })[0];
    return head && command ? { title: text(head.title), subtitle: text(head.subtitle), picture: picture(head.image),
        yes: text(buttons[0].text), no: text(buttons[1].text), command: command, done: toastOf(buttons[0].command) } : null;
}

/** A lineRenderer's item texts, joined (pictures skipped) */
export function lineText(line: any): string {
    return (get(line, 'lineRenderer', 'items') || []).map(function (item: any) {
        return text(get(item, 'lineItemRenderer', 'text'));
    }).filter(function (t: string) { return t; }).join(' ');
}

/** How many videos a playlist's byline says it has: its first part after its owner (the first "•") that starts with a
 * number ("101 videos", "99 songs"; the views come after it; an owner's name may start with a number: "88rising"), 0
 * when none does */
function countOf(line: any): number {
    var items = get(line, 'lineRenderer', 'items') || [];
    var owned = false;
    for (var i = 0; i < items.length; i++) {
        var part = text(get(items[i], 'lineItemRenderer', 'text'));
        var number = owned && /^\d[\d.,\s]*/.exec(part);
        if (number) {
            return +number[0].replace(/\D/g, '');
        }
        owned = owned || part === '•';
    }
    return 0;
}

/** Whether a tile's lines have YouTube's members badge (its style: the label is in the viewer's language) */
function membersOnly(lines: any[] | undefined): boolean {
    for (var i = 0; lines && i < lines.length; i++) {
        var items = get(lines[i], 'lineRenderer', 'items') || [];
        for (var j = 0; j < items.length; j++) {
            if (/MEMBERS/.test(get(items[j], 'lineItemRenderer', 'badge', 'metadataBadgeRenderer', 'style') || '')) {
                return true;
            }
        }
    }
    return false;
}

/** A line's chips ("4K", "New": its badges' labels) */
function lineBadges(line: any): string[] {
    return (get(line, 'lineRenderer', 'items') || []).map(function (item: any) {
        return text(get(item, 'lineItemRenderer', 'badge', 'metadataBadgeRenderer', 'label'));
    }).filter(function (t: string) { return t; });
}

/** "Blender • 23M views • 11y ago" of the parts there are */
export function dots(parts: string[]): string {
    return parts.filter(function (p) { return p; }).join(' • ');
}

/** YouTube's text in any of its forms */
export function text(t: any): string {
    if (!t) {
        return '';
    }
    if (typeof t === 'string') {
        return t;
    }
    if (t.simpleText !== undefined) {
        return t.simpleText;
    }
    if (t.content !== undefined) {
        return t.content;
    }
    return (t.runs || []).map(function (r: any) { return r.text || ''; }).join('');
}

/** v[a][b]…, or undefined where a step is missing (the steps are read from arguments: a rest parameter would be
 * copied into an array on every call, ~25 per tile) */
export function get(v: any, ...path: (string | number)[]): any;
export function get(v: any): any {
    for (var i = 1; i < arguments.length && v; i++) {
        v = v[arguments[i]];
    }
    return v;
}

/** The first value under key anywhere in v (undefined: none) */
export function first(v: any, key: string): any {
    if (v && typeof v === 'object') {
        for (var k in v) {
            var found = k === key ? v[k] : first(v[k], key);
            if (found !== undefined) {
                return found;
            }
        }
    }
    return undefined;
}

/** Every value under key anywhere in v (not inside one found) */
export function all(v: any, key: string, out?: any[]): any[] {
    var found = out || [];
    if (v && typeof v === 'object') {
        for (var k in v) {
            if (k === key) {
                found.push(v[k]);
            } else {
                all(v[k], key, found);
            }
        }
    }
    return found;
}
