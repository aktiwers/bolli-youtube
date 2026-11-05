// A channel page as YouTube's TV app shows it (browse by channel id, TV
// client): the header (banner, avatar, name, handle and subscribers,
// description start; About with the full description and facts; Play mix
// with its video list; Subscribe), the shelves (api/feed.ts), and the sub
// pages (Videos, Live, Podcasts, Playlists). Sub pages arrive as tiles that
// open the channel with params; they are moved out of the rows here, and
// Shorts is dropped as everywhere in the app. A sub page is a page with tabs
// (e.g. Videos: Latest, Popular, Oldest).

import { noteAvatar } from './avatars.js';
import { all, browseText, first, get, lineText, Page, pageKey, picture, rowsOf, Rows, text, Video } from './feed.js';
import { Keeper } from './kept-pages.js';
import { hash, VERSION } from './kept-rows.js';
import { offThreadJson } from './off-thread.js';
import { pagesForgotten, storedPage, storePage } from './page-store.js';
import { Subscribe, subscribeOf } from './watch.js';
import { account, NO_TOKEN } from './youtube.js';

/** Avatar size requested in the image URL */
var AVATAR_PX = 240;
/** The banner used is the smallest at least this wide */
var BANNER_W = 1280;

export interface Channel {
    title: string;
    /** "@BlenderOfficial • 1.25M subscribers" */
    subtitle: string;
    avatar: string;
    banner: string;
    /** The description's start */
    description: string;
    /** About: the full description and its facts ("Joined May 29, 2008", "1,594 videos") */
    about: string;
    facts: string[];
    /** Play mix: its first video (null: none), and the preview YouTube plays in the banner while the focus rests on it
     * (after delay ms; sound: not muted) */
    mix: Video | null;
    mixPreview?: { id: string; delay: number; sound: boolean } | null;
    subscribe: Subscribe | null;
    pages: { title: string; page: Page }[];
    rows: Rows;
}

/** How a page is wanted: kept (in memory, else the persistent copy: page-store.ts), new (not the persistent copy:
 * YouTube says the channel has new videos), renew (fetch now: the one shown is old) */
export type Wanted = 'kept' | 'new' | 'renew';

/** Whether p is a channel's main page (UC…, no params; sub pages are pages with tabs) */
export function isChannel(p: Page): boolean {
    return /^UC/.test(p.browseId) && !p.params;
}

/** Channel pages cached in memory for a while (api/kept-pages.ts; a reply is ~1 MB) */
var channels = new Keeper<Channel>(5 * 60 * 1000, 4, true, true);
/** Cached pages that came from the persistent store, not from YouTube in this session */
var fromTV: { [key: string]: boolean } = {};
/** Prefetched pages, stored persistently only once opened (pages merely passed by do not push out opened ones) */
var unopened: { key: string; keep: () => void }[] = [];
var UNOPENED_MAX = 4;
/** Per page, the count of its fetches from YouTube, and the one stored last: an older one is not stored over it */
var fetches: { [key: string]: number } = {};
var storedSeq: { [key: string]: number } = {};

/** A channel page from the memory cache, a prefetch, or the persistent store, as how asks */
export function keptChannel(p: Page, how?: Wanted): Promise<Channel> {
    var key = pageKey(p);
    if (how === 'renew' || how === 'new' && fromTV[key]) {
        channels.drop(key);
    }
    return channels.getJson(key, function () { return asked(p, how === 'renew' || how === 'new', true); }).then(function (c) {
        opened(key);
        noteAvatar(c.title, c.avatar);
        return c;
    });
}

/** Loads a prefetched channel's banner into the browser's cache (made on first use) */
var bannerAhead: HTMLImageElement | null = null;

/** Prefetches a channel page (its avatar is focused; fresh: YouTube marks new videos, so skip the persistent copy),
 * so keptChannel has it at once, with its banner (one picture, no request to YouTube's API) */
export function channelAhead(p: Page, fresh?: boolean): void {
    var key = pageKey(p);
    if (fresh && fromTV[key]) {
        channels.drop(key);
    }
    channels.aheadJson(key, function () {
        return asked(p, !!fresh, false).then(function (json) {
            var url = bannerIn(json);
            if (url) {
                bannerAhead = bannerAhead || new Image();
                bannerAhead.src = url;
            }
            return json;
        });
    });
}

/** The banner of a channel page as JSON ('' none), read without parsing all of it (it is one of the first fields) */
export function bannerIn(json: string): string {
    var m = /"banner":"((?:[^"\\]|\\.)*)"/.exec(json);
    return m ? JSON.parse('"' + m[1] + '"') : '';
}

/** p's page as JSON: from YouTube when fresh, else the account's persistent copy if any (old rows are refreshed
 * behind it). A page from YouTube is stored at once when opened now (open), else when it is opened later */
function asked(p: Page, fresh: boolean, open: boolean): Promise<string> {
    var key = pageKey(p);
    // Fetched for this account: store it only if the cache was not cleared meanwhile
    var forgets = pagesForgotten();
    return account().then(function (id) {
        var store = id && id.indexOf(NO_TOKEN) < 0 ? VERSION + '|' + hash(id) + '|' + key : '';
        return (!fresh && store ? storedPage(store) : Promise.resolve(null)).then(function (page) {
            if (page) {
                fromTV[key] = true;
                return page.json;
            }
            delete fromTV[key];
            var seq = fetches[key] = (fetches[key] || 0) + 1;
            return offThreadJson(browseText(p), 'channel', madeChannel, p.browseId).then(function (json) {
                var at = Date.now();
                var keep = function (): void {
                    if (store && pagesForgotten() === forgets && seq > (storedSeq[key] || 0)) {
                        storedSeq[key] = seq;
                        storePage(store, json, at);
                    }
                };
                // This fetch replaces one prefetched before (stored after it, the older one would overwrite it)
                unopened = unopened.filter(function (u) { return u.key !== key; });
                if (open) {
                    // After it is drawn, to stay out of its way
                    setTimeout(keep, 0);
                } else {
                    unopened.push({ key: key, keep: keep });
                    if (unopened.length > UNOPENED_MAX) {
                        unopened.shift();
                    }
                }
                return json;
            });
        });
    });
}

/** key's page was opened: store it persistently if it was prefetched */
function opened(key: string): void {
    var was = unopened.filter(function (u) { return u.key === key; })[0];
    if (was) {
        unopened.splice(unopened.indexOf(was), 1);
        setTimeout(was.keep, 0);
    }
}

/** A channel reply made into the app's Channel, rows stamped with the time (the worker's maker: parse-worker.ts) */
export function madeChannel(reply: any, id: string): Channel {
    var c = channelOf(reply, id);
    c.rows.at = Date.now();
    return c;
}

/** The Channel in a channel reply (id: the channel's id) */
export function channelOf(reply: any, id: string): Channel {
    // Known path first; search only if it moved (the reply is about a megabyte)
    var header = get(reply, 'contents', 'tvBrowseRenderer', 'content', 'tvSurfaceContentRenderer', 'header', 'channelHeaderRenderer') ||
        first(reply, 'channelHeaderRenderer') || {};
    var description = get(header, 'selectableDescription', 'selectableTextRenderer');
    var about = first(description, 'aboutChannelViewModel') || {};
    var rows = rowsOf(reply);
    var pages: { title: string; page: Page }[] = [];
    // Sub pages: tiles that open this channel with params, in any shelf (shelves left empty are dropped)
    rows.shelves = rows.shelves.filter(function (s) {
        s.videos = s.videos.filter(function (v) {
            var sub = !!v.page && v.page.browseId === id && !!v.page.params;
            if (sub && !/^shorts$/i.test(v.title)) {
                pages.push({ title: v.title, page: v.page as Page });
            }
            return !sub;
        });
        return s.videos.length > 0;
    });
    var mix = (header.buttons || []).map(function (b: any) { return b.buttonRenderer; }).filter(function (b: any) {
        return b && get(b, 'navigationEndpoint', 'watchEndpoint', 'videoId');
    })[0];
    var title = text(header.title);
    var inline = get(mix, 'onFocusCommand', 'startInlinePlaybackCommand');
    var inlineId = get(inline, 'playbackEndpoint', 'watchEndpoint', 'videoId');
    return {
        title: title,
        subtitle: lineText(header.subtitle),
        avatar: picture(header.avatar, AVATAR_PX),
        banner: banner(header.backgroundImage),
        description: text(get(description, 'compactDescription')).replace(/\s*\.\.\.more$/, ''),
        about: about.description || '',
        facts: (about.infoRows || []).map(function (r: any) { return text(r.label); }).filter(function (t: string) { return t; }),
        mix: mix ? { id: get(mix, 'navigationEndpoint', 'watchEndpoint', 'videoId'), title: text(mix.text) + ': ' + title, channel: title, length: '', info: '',
            list: idsOf(get(mix, 'navigationEndpoint', 'watchEndpoint', 'params')) } : null,
        mixPreview: inlineId ? { id: inlineId, delay: +inline.delayMs || 0, sound: !inline.muted } : null,
        subscribe: subscribeOf(all(header.buttons, 'subscribeButtonRenderer')[0]),
        pages: pages,
        rows: rows
    };
}

/** The video ids listed in a watch command's params (a mix's: protobuf field 5, 11 characters each) */
export function idsOf(params: string | undefined): string[] {
    var ids: string[] = [];
    var bytes = '';
    try {
        bytes = atob(decodeURIComponent(params || '').replace(/-/g, '+').replace(/_/g, '/'));
    } catch (e) {
        return ids;
    }
    for (var i = 0; i + 12 < bytes.length; i++) {
        var id = bytes.substr(i + 2, 11);
        if (bytes.charCodeAt(i) === 0x2a && bytes.charCodeAt(i + 1) === 11 && /^[\w-]{11}$/.test(id)) {
            ids.push(id);
            i += 12;
        }
    }
    return ids;
}

/** The banner URL: the smallest at least BANNER_W wide, else the largest ('' none) */
function banner(thumbs: any): string {
    return picture(thumbs, undefined, BANNER_W);
}
