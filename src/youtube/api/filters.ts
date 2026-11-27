// The viewer's filters (Settings › Filters): kinds of tiles hidden per screen
// (live, upcoming, watched, mixes, playlists, members only), videos shorter
// or longer than a length hidden everywhere, on Home rows of a kind or by
// name, channels hidden (by their names: a tile carries no channel id, only
// its name), and keywords in titles, channel names and Home rows' names
// (lower-cased once per pass, each tile's text once). Applied where rows are
// drawn (views/videos.ts, views/tiles.ts Paging, views/search.ts, the watch
// page's related videos), so kept rows are filtered too and a changed setting
// needs nothing asked of YouTube. One pass
// over the tiles; with nothing set, the rows given come back as they are. The
// Filters on/off shortcut turns them all off for the run (not stored). Rows of
// Shorts (api/feed.ts Shelf.shorts) show only where Settings › Filters › Shorts
// says (by default nowhere: the rows as without them), whatever that shortcut
// does: they have a setting and a shortcut of their own.

import { Shelf, Video } from './feed.js';
import { dearrowTitle } from './dearrow.js';
import { Prefs, prefs, setPref } from './prefs.js';

/** The screens filtered, each with its own list of kinds hidden (subsChannel: one channel's list in Subscriptions,
 * Subscriptions' kinds; as on a channel's page, neither its channel hidden there nor keywords matched in its name) */
export type FilterScreen = 'home' | 'subs' | 'subsChannel' | 'search' | 'channel' | 'later' | 'related';

/** The pref of each screen's kinds hidden */
var KINDS_OF: { [screen: string]: keyof Prefs } = { home: 'hideHome', subs: 'hideSubs', subsChannel: 'hideSubs', search: 'hideSearch',
    channel: 'hideChannel', later: 'hideLater', related: 'hideRelated' };

/** Screens whose tiles are one channel's (the viewer went there): neither channels hidden nor keywords in channel names
 * apply there */
var ONE_CHANNEL: { [screen: string]: boolean } = { channel: true, subsChannel: true };

/** The screens Settings › Filters › Shorts can show Shorts on by themselves (By screen) */
export var SHORTS_SCREENS: FilterScreen[] = ['home', 'subs', 'search', 'channel', 'related'];

/** Whether Shorts show on screen ('' a page of none of the screens filtered, and Watch later: only where they show
 * everywhere; one channel's list in Subscriptions as Subscriptions) */
export function shortsShown(screen: FilterScreen | '' | undefined): boolean {
    var p = prefs();
    return p.shorts === 'shown' || p.shorts === 'screens' && !!screen && p.shortsOn.indexOf(screen === 'subsChannel' ? 'subs' : screen) >= 0;
}

/** Of a channel's sub pages, those its page offers: its Shorts tab only where Shorts show on channel pages (turned off
 * everywhere, no button leads to them) */
export function channelPages<T extends { shorts?: boolean }>(pages: T[]): T[] {
    return shortsShown('channel') ? pages : pages.filter(function (p) { return !p.shorts; });
}

/** Shorts shown again where they were last (the Shorts on/off shortcut: Shown, or By screen if that was chosen last),
 * or hidden everywhere; true: shown now */
export function toggleShorts(): boolean {
    var p = prefs();
    var on = p.shorts === 'hidden';
    setPref('shorts', on ? p.shortsLast : 'hidden');
    return on;
}

/** Whether screen shows many channels' tiles taking channel filters: all but one channel's and Watch later (the
 * viewer's own list); a tile's menu offers Hide videos from on these */
export function manyChannels(screen: FilterScreen | '' | undefined): boolean {
    return !!screen && screen !== 'later' && !ONE_CHANNEL[screen];
}

/** Whether channels hidden apply on screen (Subscriptions by its own setting) */
export function hidesChannels(screen: FilterScreen | '' | undefined): boolean {
    return manyChannels(screen) && (screen !== 'subs' || prefs().hiddenChannelsInSubs);
}

/** A watched share from which a video counts as watched */
var WATCHED = 0.9;

/** Turned off for the run by the Filters on/off shortcut */
var off = false;

/** Whether the filters are in force (the shortcut has not turned them off) */
export function filtersOn(): boolean {
    return !off;
}

/** The Filters on/off shortcut: all of them off for the run, or on again; true: on now */
export function toggleFilters(): boolean {
    off = !off;
    return !off;
}

/** The filters rows were drawn through (filterStamp), to tell whether they changed since (stampHolds) */
export interface FilterStamp {
    off: boolean;
    kinds: unknown;
    /** The values of the screen's stamped settings (stampedOn) */
    values: unknown[];
}

/** Each screen's filter settings besides its kinds: those that can change its rows (made once each; '' a page of none
 * of the screens filtered: only where Shorts show) */
var STAMPED: { [screen: string]: (keyof Prefs)[] } = {};

function stampedOn(screen: FilterScreen | ''): (keyof Prefs)[] {
    var names = STAMPED[screen];
    if (!names) {
        names = STAMPED[screen] = ['shorts', 'shortsOn'];
        if (!screen) {
            return names;
        }
        names.push('filterShorter', 'filterLonger');
        if (screen === 'home') {
            names.push('homeRows', 'hiddenRows');
        }
        if (manyChannels(screen)) {
            names.push('hiddenChannels');
        }
        if (screen === 'subs') {
            names.push('hiddenChannelsInSubs');
        }
        if (screen !== 'later') {
            names.push('keywords', 'keywordsIn');
        }
    }
    return names;
}

/** screen's filters as they are now (made at a draw) */
export function filterStamp(screen: FilterScreen | ''): FilterStamp {
    var p = prefs();
    return { off: off, kinds: p[KINDS_OF[screen]], values: stampedOn(screen).map(function (n) { return p[n]; }) };
}

/** Whether screen's filters are still those of stamp (asked as a screen shows, at every key in the sidebar: nothing
 * made. A setting changed is a new list: prefs.ts setPref) */
export function stampHolds(screen: FilterScreen | '', stamp: FilterStamp | null): boolean {
    var p = prefs();
    if (!stamp || stamp.off !== off || stamp.kinds !== p[KINDS_OF[screen]]) {
        return false;
    }
    var names = stampedOn(screen);
    for (var i = 0; i < names.length; i++) {
        if (stamp.values[i] !== p[names[i]]) {
            return false;
        }
    }
    return true;
}

/** A length ("1:02:03", "10:35", "4.05") in seconds; 0: none known (live, a page's count, a word) */
export function seconds(length: string): number {
    if (!length || !/^\d+([:.]\d\d){1,2}$/.test(length)) {
        return 0;
    }
    var parts = length.split(/[:.]/);
    var s = 0;
    for (var i = 0; i < parts.length; i++) {
        s = s * 60 + +parts[i];
    }
    return s;
}

/** Whether video is of kind (the ids of Settings › Filters' tick lists) */
export function isKind(v: Video, kind: string): boolean {
    switch (kind) {
        case 'live': return !!v.live;
        case 'upcoming': return !!v.upcoming;
        case 'watched': return (v.progress || 0) >= WATCHED;
        case 'mixes': return v.labelIcon === 'mix';
        // (a playlist's page opens by its VL… id)
        case 'playlists': return v.labelIcon === 'playlist' || !!v.page && /^VL/.test(v.page.browseId);
        case 'members': return !!v.members;
    }
    return false;
}

/** What hides a tile on a screen, read once per pass (null: nothing): channels by their exact names, keywords
 * lower-cased, matched in titles and channel names as ticked */
interface Rule {
    kinds: string[];
    shorter: number;
    longer: number;
    channels: string[];
    /** The keywords matched in titles, in channel names ([] none) */
    titleWords: string[];
    channelWords: string[];
}

/** No keywords, no channels */
var NO_WORDS: string[] = [];

/** The keywords lower-cased, made again only when they changed (a setting changed is a new list) */
var lowFrom: string[] | null = null;
var low: string[] = [];

function lowered(words: string[]): string[] {
    if (words !== lowFrom) {
        lowFrom = words;
        low = words.map(function (w) { return w.toLowerCase(); });
    }
    return low;
}

/** The keywords screen matches in tiles' text where ('titles', 'channels', 'rows'), lower-cased ([]: none; none in
 * Watch later) */
function wordsOf(p: Prefs, screen: FilterScreen, where: string): string[] {
    return screen !== 'later' && p.keywords.length && p.keywordsIn.indexOf(where) >= 0 ? lowered(p.keywords) : NO_WORDS;
}

function ruleOf(screen: FilterScreen | '' | undefined): Rule | null {
    if (!screen || off) {
        return null;
    }
    var p = prefs();
    var kinds = p[KINDS_OF[screen]] as string[];
    var channels = hidesChannels(screen) ? p.hiddenChannels : NO_WORDS;
    var titleWords = wordsOf(p, screen, 'titles');
    var channelWords = manyChannels(screen) ? wordsOf(p, screen, 'channels') : NO_WORDS;
    return kinds.length || p.filterShorter || p.filterLonger || channels.length || titleWords.length || channelWords.length ? { kinds: kinds,
        shorter: p.filterShorter, longer: p.filterLonger, channels: channels, titleWords: titleWords, channelWords: channelWords } : null;
}

/** Whether text (lower-cased) has one of words in it */
function hasWord(words: string[], text: string): boolean {
    for (var i = 0; i < words.length; i++) {
        if (text.indexOf(words[i]) >= 0) {
            return true;
        }
    }
    return false;
}

/** The name of video's channel as a channel is hidden by ('' none known): a channel's own tile's title (its byline is
 * a handle or a count), not a show's or a playlist's (their lines are an episode's title), a search's top tile's byline
 * without the views after it */
export function channelOf(v: Video): string {
    if (v.round) {
        return v.title;
    }
    if (v.page || !v.channel) {
        return '';
    }
    var cut = v.channel.indexOf(' • ');
    return cut > 0 ? v.channel.slice(0, cut) : v.channel;
}

/** Whether rule hides video. Lengths only where one is known (live and upcoming tiles have none, a page's is a count) */
function hides(rule: Rule, v: Video): boolean {
    for (var i = 0; i < rule.kinds.length; i++) {
        if (isKind(v, rule.kinds[i])) {
            return true;
        }
    }
    var channel = rule.channels.length || rule.channelWords.length ? channelOf(v) : '';
    if (channel && (rule.channels.length && rule.channels.indexOf(channel) >= 0 || rule.channelWords.length && hasWord(rule.channelWords,
        channel.toLowerCase()))) {
        return true;
    }
    // (YouTube's title, and DeArrow's where the tile shows that one)
    if (rule.titleWords.length && !v.round && v.title) {
        var shown = dearrowTitle(v.id, v.title);
        if (hasWord(rule.titleWords, v.title.toLowerCase()) || shown !== v.title && hasWord(rule.titleWords, shown.toLowerCase())) {
            return true;
        }
    }
    if ((rule.shorter || rule.longer) && !v.page && !v.live && !v.upcoming) {
        var s = seconds(v.length);
        return s > 0 && (s < rule.shorter || !!rule.longer && s > rule.longer);
    }
    return false;
}

/** videos without those rule hides: the same array where none is */
function kept(rule: Rule, videos: Video[]): Video[] {
    var out: Video[] | null = null;
    for (var i = 0; i < videos.length; i++) {
        var gone = hides(rule, videos[i]);
        if (gone && !out) {
            out = videos.slice(0, i);
        } else if (!gone && out) {
            out.push(videos[i]);
        }
    }
    return out || videos;
}

/** The videos screen shows of videos (the same array where it hides none) */
export function filterVideos(screen: FilterScreen | '' | undefined, videos: Video[]): Video[] {
    var rule = ruleOf(screen);
    return rule ? kept(rule, videos) : videos;
}

/** More than half of a row's tiles are so */
function most(videos: Video[], is: (v: Video) => boolean): boolean {
    var n = 0;
    for (var i = 0; i < videos.length; i++) {
        if (is(videos[i])) {
            n++;
        }
    }
    return n * 2 > videos.length;
}

function resumable(v: Video): boolean {
    return (v.progress || 0) > 0;
}

function live(v: Video): boolean {
    return !!v.live;
}

function round(v: Video): boolean {
    return !!v.round;
}

/** A show's or a playlist's tile: a page that is not a channel */
function show(v: Video): boolean {
    return !!v.page && !v.round;
}

/** Whether a Home row is of kind (Settings › Filters › Home rows; YouTube names its rows only: told by their tiles) */
export function isRowKind(shelf: Shelf, kind: string): boolean {
    var videos = shelf.videos;
    switch (kind) {
        case 'continue': return most(videos, resumable);
        case 'topics': return !!shelf.topic;
        case 'channels': return most(videos, round);
        case 'shows': return videos.length > 0 && videos.every(show);
        case 'live': return most(videos, live);
    }
    return false;
}

/** Whether Home hides shelf as a row (its name hidden or with a keyword in it, or its kind) */
function rowHidden(shelf: Shelf, rows: string[], names: string[], words: string[]): boolean {
    if (shelf.grid) {
        return false;
    }
    if (shelf.title && (names.indexOf(shelf.title) >= 0 || words.length && hasWord(words, shelf.title.toLowerCase()))) {
        return true;
    }
    for (var i = 0; i < rows.length; i++) {
        if (isRowKind(shelf, rows[i])) {
            return true;
        }
    }
    return false;
}

/** The shelves screen shows of shelves: each without the tiles it hides (a copy: the rows given are kept rows, not to
 * change), a row left empty dropped (a grid stays, empty: its token brings more), on Home rows hidden by kind or
 * name dropped, rows of Shorts where they do not show (a grid of them: emptied, but on a channel's Shorts tab where
 * they show). The same array where nothing is hidden */
export function filterShelves(screen: FilterScreen | '' | undefined, shelves: Shelf[]): Shelf[] {
    var rule = ruleOf(screen);
    var p = prefs();
    var words = screen === 'home' ? wordsOf(p, 'home', 'rows') : NO_WORDS;
    var home = screen === 'home' && !off && (p.homeRows.length > 0 || p.hiddenRows.length > 0 || words.length > 0);
    var shorts = shortsShown(screen);
    // (a grid of Shorts is a channel's Shorts tab; elsewhere a list that began with Shorts only, History's)
    var shortsGrid = shorts && screen === 'channel';
    if (!rule && !home && shortsGrid) {
        return shelves;
    }
    var out: Shelf[] | null = null;
    for (var i = 0; i < shelves.length; i++) {
        var shelf = shelves[i];
        var put: Shelf | null = shelf;
        if (shelf.shorts && !(shelf.grid ? shortsGrid : shorts)) {
            // (a grid stays, empty and of other videos: its token brings the rest of its list)
            put = shelf.grid ? withVideos(shelf, []) : null;
            if (put) {
                put.shorts = undefined;
            }
        } else if (home && rowHidden(shelf, p.homeRows, p.hiddenRows, words)) {
            put = null;
        } else if (rule) {
            var videos = kept(rule, shelf.videos);
            if (videos !== shelf.videos) {
                put = !videos.length && !shelf.grid ? null : withVideos(shelf, videos);
            }
        }
        if (put !== shelf && !out) {
            out = shelves.slice(0, i);
        }
        if (out && put) {
            out.push(put);
        }
    }
    return out || shelves;
}

/** A copy of shelf with other videos */
function withVideos(shelf: Shelf, videos: Video[]): Shelf {
    var c: any = {};
    for (var k in shelf) {
        c[k] = (shelf as any)[k];
    }
    c.videos = videos;
    c.of = shelf.of || shelf;
    return c as Shelf;
}
