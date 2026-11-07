// The DevTools hooks on window.__bolli (the TV tests use them too): play a video, show a section or a page, the
// screen and its focused tile, the players, the settings and InnerTube requests. Async results go to __bolli.reply
// (null until they come; a failure as { error }).

import { Page, Video } from './api/feed.js';
import { offThreadStats } from './api/off-thread.js';
import { prefs, reloadPrefs, setPref } from './api/prefs.js';
import { forgetStreams, sabrStreams, streams } from './api/streams.js';
import { identities, innertube, innertubeAs } from './api/youtube.js';
import { Cast } from './cast.js';
import { OwnPlayer, startFormats } from './player/own-player.js';
import { pipelineStats } from './player/pipeline.js';
import { TvApp } from './player/tv-app.js';
import { toast } from './ui/toast.js';

/** What the hooks reach in the app (main.ts): playing a tile's video, a section shown as the rail does (focused), a
 * page opened as its tile does, the visible screen and its focused tile, and the players */
export interface DebugApp {
    play: (video: Video) => void;
    section: (id: string) => void;
    page: (p: Page) => void;
    screen: () => unknown;
    focused: () => Video | null;
    own: OwnPlayer;
    tv: TvApp;
    cast: Cast;
}

export function debugHooks(app: DebugApp): void {
    var debug = (window as unknown as { __bolli: { [name: string]: unknown } }).__bolli;
    /** Puts what asked brings in __bolli.reply */
    var toReply = function (asked: Promise<unknown>): void {
        debug.reply = null;
        asked.then(function (r) { debug.reply = r; }, function (e) { debug.reply = { error: String(e) }; });
    };
    // play(id, t?): plays a video as OK on its tile does (t: start in seconds)
    debug.play = function (id: string, t?: number): void {
        app.play({ id: id, title: id, channel: '', length: '', info: '', start: t });
    };
    // own: the app's player; tv: YouTube's TV app hidden in this one (player/tv-app.ts)
    debug.own = app.own;
    debug.tv = app.tv;
    debug.pipes = pipelineStats;
    debug.offThread = offThreadStats;
    debug.cast = app.cast;
    // streams(id): the formats the app's player gets for a video (no URLs)
    debug.streams = function (id: string): void {
        debug.reply = null;
        forgetStreams(id);
        streams(id).then(function (s) {
            debug.reply = { videos: s.videos.map(function (f) { return f.itag + ' ' + f.height + 'p ' + f.mime; }), audios: s.audios.length, start: !!startFormats(s), paid: s.paid || null };
        }, function (e) { debug.reply = { error: e }; });
    };
    // sabr(id): the formats the signed-in method (SABR) gets for a video and the time it took, or why it failed
    debug.sabr = function (id: string): void {
        debug.reply = null;
        var t0 = Date.now();
        forgetStreams(id);
        sabrStreams(id).then(function (s) {
            debug.reply = { ms: Date.now() - t0, videos: s.videos.map(function (f) { return f.itag; }), audios: s.audios.map(function (t) { return t.format.itag; }) };
        }, function (e) { debug.reply = { ms: Date.now() - t0, error: e }; });
    };
    // section(id): shows a section as the rail does, focused
    debug.section = app.section;
    // innertubeAs(n, endpoint, body): an InnerTube request as the n-th signed-in account
    debug.innertubeAs = function (n: number, endpoint: string, body: { [key: string]: unknown }): void {
        toReply(identities().then(function (got) { return innertubeAs(got.list[n], endpoint, body); }));
    };
    // prefs(), setPref(name, value), reloadPrefs(): read, change and reload the settings (used by tests)
    debug.prefs = prefs;
    debug.setPref = setPref;
    debug.reloadPrefs = reloadPrefs;
    // toast(text, icon): shows a toast
    debug.toast = toast;
    // innertube(endpoint, body): an InnerTube request as the app makes it (signed in)
    debug.innertube = function (endpoint: string, body: { [key: string]: unknown }): void {
        toReply(innertube(endpoint, body));
    };
    // page(browseId, params?): opens a page as OK on its tile does; screen(): the visible view; focused(): the focused
    // tile's video and page
    debug.page = function (browseId: string, params?: string): void {
        app.page(params ? { browseId: browseId, params: params } : { browseId: browseId });
    };
    debug.screen = app.screen;
    debug.focused = function (): unknown {
        var video = app.focused();
        return video ? { id: video.id, page: video.page || null } : null;
    };
}
