// Bolli YouTube: a YouTube client for LG webOS TVs (webOS 3.x, Chrome 38).
// Lightweight screens (rail, tile rows) show YouTube's data, requested from a
// hidden youtube.com page with the TV's YouTube sign-in (api/youtube.ts).
// Videos play in the app's own player (player/own-player.ts) or in YouTube's
// TV app, hidden inside this one with YouTube AdFree's ad hooks
// (player/tv-app.ts); that app warms up when idle so a picked video opens at
// once. The account is shared with YouTube's app and switched via
// "Who's watching?". Page tiles (playlist, channel, History) open over the
// section and are prefetched when focus rests on them; each section keeps its
// open pages. Back from a video returns to where it was picked; Back in the
// rail goes to the start page, then exits. Debug hooks live in window.__bolli (debug.ts).

import { fadeInImages, h, isStandingBy, LAYOUT_HEIGHT, LAYOUT_WIDTH, toggleClass } from './core/dom.js';
import { tr } from './core/i18n.js';
import { initKeys, isTyping, KEY, keyCame, lastKeyAt, setActive, setHoldOk } from './core/keys.js';
import { initPerf, mark, noteKey } from './core/perf.js';
import { android, exitApp, ignorePointer } from './core/platform.js';
import { initPointer, Layer, takesPointer } from './core/pointer.js';
import { initScreenSaver } from './core/screensaver.js';
import { load, save } from './core/store.js';
import { localClock } from './core/time.js';
import { View } from './core/view.js';
import { PROBLEM, toast } from './ui/toast.js';
import { screenIsOff, screenKey, screenLayer, screenOff, screenWake } from './ui/screen-off.js';
import { googleOf, keptProfiles, ownChannel, Profile, profiles, signOut } from './api/accounts.js';
import { saveAvatars } from './api/avatars.js';
import { Channel, channelAhead, channelKept, isChannel, keptChannel } from './api/channel.js';
import { dearrowFetch, dearrowOn, saveDearrow, Wanted } from './api/dearrow.js';
import { first, get, home, keepable, keptPage, mayAskPageAhead, page, Page, pageAhead as fetchPageAhead, pageKept, PageButton, PlaylistInfo, Rows, searchAhead as fetchSearchAhead, sized, SubChannel, subscriptions, tabAhead, tapAhead, text, toastOf, Video } from './api/feed.js';
import { freshGuideNames, guideNames } from './api/guide.js';
import { forgetKept, pruneKept } from './api/kept-pages.js';
import { prepareNames } from './api/languages.js';
import { prefs, Shortcut, ShortcutTarget } from './api/prefs.js';
import { checkAgain, checkVersion } from './api/version-check.js';
import { keyName, PLAYER, SCREENS, shortcutAt } from './api/shortcuts.js';
import { forgetSaves, run, Subscribe, watchInfo } from './api/watch.js';
import { forgetRows, keepRows, keptFor, keptRows } from './api/kept-rows.js';
import { account, guestChosen, Identity, isBrand, lastAccount, NO_TOKEN, onAccountChange, useGuest, useIdentity } from './api/youtube.js';
import { forgetHistorySettings } from './api/account-settings.js';
import { ListQueue } from './player/list-queue.js';
import { OwnPlayer } from './player/own-player.js';
import { forgetPages, openPages } from './api/page-store.js';
import { cancelPreload, firstStreams, mayAskAhead, preloadVideo, startSoon } from './player/preload.js';
import { TilePreview } from './player/preview.js';
import { TvApp } from './player/tv-app.js';
import { apply, askToClear, flipSubscription } from './ui/account.js';
import { Question } from './ui/question.js';
import { SidePanel } from './ui/side-panel.js';
import { applyBlack, applyTheme, metrics } from './ui/theme.js';
import { openTileMenu } from './ui/tile-menu.js';
import { ACCOUNT_PICTURE_PX, setLogoAccount } from './ui/logo.js';
import './ui/themes/youtube.js';
import { AccountsView } from './views/accounts.js';
import { SignInView } from './views/signin.js';
import { Rail, RailEntry, RailItem } from './views/rail.js';
import { Cast, launchParams } from './cast.js';
import { SearchView } from './views/search.js';
import { debugHooks } from './debug.js';
import { ChannelView, KnownChannel } from './views/channel.js';
import { playerPlaylists, SettingsView } from './views/settings.js';
import { FeedOptions, FeedTexts, FeedView, KeptFeed } from './views/videos.js';
import { shuffle } from './views/list-stage.js';
import { noteWatched, startPicture, watchedAt } from './views/tiles.js';
import { SubscriptionsView } from './views/subscriptions.js';
import { ShortcutPrompt, wayLines } from './views/shortcuts.js';
import { LibraryView } from './views/library.js';

// The build version (filled in by tools/build_app.mjs), exposed on the page
document.documentElement.setAttribute('data-version', '__BOLLI_VERSION__');

initPerf();
mark('start');
var root = document.getElementById('app') as HTMLElement;
var stage = h('div', 'bd-stage');
// Theme first: screens are laid out with its sizes
applyTheme(prefs().theme);
applyBlack(prefs().pureBlack);
/** Screens that are one YouTube browse page: Library and the topic pages from the TV app's rail (/guide). Films are
 * left out: mostly paid films, which the app's player cannot play */
var BROWSE: { [id: string]: { label: string; browseId: string } } = {
    library: { label: tr('Library'), browseId: 'FElibrary' },
    gaming: { label: tr('Gaming'), browseId: 'FEtopics_gaming' },
    podcasts: { label: tr('Podcasts'), browseId: 'FEtopics_podcasts' },
    music: { label: tr('Music'), browseId: 'FEtopics_music' },
    movies: { label: tr('Movies'), browseId: 'FEtopics_movies' },
    sports: { label: tr('Sports'), browseId: 'FEtopics_sports' }
};
// YouTube's own names for them, as its guide gave them last (Films, Sport where it says so)
var named = guideNames();
for (var browsed in BROWSE) {
    BROWSE[browsed].label = named[BROWSE[browsed].browseId] || BROWSE[browsed].label;
}
// As the TV app's rail: sections, a divider, topics, Settings at the bottom
var RAIL: RailItem[] = [
    { id: 'search', label: tr('Search'), icon: 'search' },
    { id: 'home', label: tr('Home'), icon: 'home' },
    { id: 'subscriptions', label: tr('Subscriptions'), icon: 'subscriptions' },
    { id: 'library', label: BROWSE.library.label, icon: 'library' },
    { id: 'gaming', label: BROWSE.gaming.label, icon: 'gaming', divider: true },
    { id: 'podcasts', label: BROWSE.podcasts.label, icon: 'podcasts' },
    { id: 'music', label: BROWSE.music.label, icon: 'music' },
    { id: 'movies', label: BROWSE.movies.label, icon: 'movies' },
    { id: 'sports', label: BROWSE.sports.label, icon: 'sports' },
    { id: 'settings', label: tr('Settings'), icon: 'settings', bottom: true }
];
// A section shown by resting on its entry waits a moment before asking YouTube (the focus may move on); Right or OK: at once
var menu = new Rail(RAIL, switchSection, leaveMenu, logoEntries, standsReady);
root.appendChild(stage);
root.appendChild(menu.el);
// A click on the rail's items moves the keys there (what it is on takes the focus inside: core/pointer.ts); the open
// rail takes the clicks beside it (pointerLayer)
takesPointer(menu.el, function (target, under) {
    if (under) {
        menuFocused = true;
        menu.pointed();
    }
    return null;
});
var tv = new TvApp(document.body);
mark('tv app');
var own = new OwnPlayer(document.body);
mark('player');
/** A video tile's menu (OK held) */
var tileMenu = new SidePanel(document.body);
/** Confirmation dialog over the app (e.g. Sign out) */
var question = new Question(root);
/** The rail's screens but Settings: the screens the app can start on, and that shortcuts go to */
var SCREENS_RAIL = RAIL.filter(function (r) { return !r.bottom; });
/** Sets a shortcut (Settings › Shortcuts, a channel's or a playlist's Shortcut button), made on first use: it gets keys
 * first while shown */
var promptMade: ShortcutPrompt | null = null;
function shortcutPrompt(): ShortcutPrompt {
    return promptMade || (promptMade = new ShortcutPrompt(root, SCREENS_RAIL));
}
/** Video preview in the focused tile */
var preview = new TilePreview(own);

var sections: { [id: string]: Screen } = {};
var current = '';
/** Pages open over the current section, last on top */
var pages: Screen[] = [];
/** Each section's open pages, kept while another section shows */
var pagesOf: { [id: string]: Screen[] } = {};
/** Focus is in the rail (else on the screen) */
var menuFocused = false;
/** Screens standing by (View.standBy: out of sight but kept drawn, back on screen with nothing to draw), the newest
 * last: the section the rail just left and the ones beside its focus, the screen a page opened over. Each holds
 * memory (its layers and decoded pictures) and costs every frame a little, so at most STANDING_MAX, let go STAND_MS
 * after the rail lost the focus (PAGE_STAND_MS after a page opened), and at once under a video. */
var standing: Screen[] = [];
var STANDING_MAX = 2;
var STAND_MS = 4000;
var PAGE_STAND_MS = 20000;
var standTimer = 0;
/** The sections beside the rail's focus are drawn out of sight once it has rested this long (the highlight first);
 * one not built yet is built from its stored rows after BUILD_REST_MS (building one takes the TV ~0.2 s: not between
 * quick steps) */
var NEIGHBOURS_MS = 80;
var BUILD_REST_MS = 300;
var neighboursTimer = 0;
var buildTimer = 0;
var clockTimer = 0;
/** YouTube's TV app starts once the first screen has its pictures and no key was pressed for IDLE_START_MS
 * (START_LATEST_MS at most), or at once when a video is picked: its start blocks this app's thread for seconds,
 * stalling pictures and keys */
var IDLE_START_MS = 2000;
var START_LATEST_MS = 15000;
/** A video tile focused this long is preloaded (Settings: Videos start sooner; each costs a request and a parse on
 * this app's thread) */
var PRELOAD_REST_MS = 1500;
var preloadTimer = 0;
/** A focused video tile resting this long has its video loaded ahead, paused and hidden (readyFocused) */
var READY_REST_MS = 400;
var readyTimer = 0;
/** A page tile's page, the page of a channel's button (Videos, Live, ...) or a tab's tiles (Latest, Popular, Oldest)
 * are asked for ahead (a page also built) once the focus has rested there this long, within api/feed.ts
 * mayAskPageAhead's requests a minute */
var PAGE_REST_MS = 500;
var pageTimer = 0;
/** A channel page's Play mix preview waits out YouTube's own delay (from the focus's rest) */
var headerTimer = 0;
/** With the app's player, YouTube's TV app (kept for films) is released once focus has been off films this long (not
 * while it starts: an aborted start costs the whole page load again) */
var FILMS_LEFT_MS = 30000;
var filmTimer = 0;
/** While a video shows, the app's pictures are released after this, leaving memory to the player */
var RELEASE_MS = 10000;
var releaseTimer = 0;
/** Pictures released while a player covers the app (restored when it closes) */
var released: HTMLImageElement[] = [];
/** While the app is in the background, the screen's rows are renewed (if old) this often */
var HIDDEN_RENEW_MS = 30 * 60 * 1000;
var hiddenTimer = 0;
/** Subscriptions refresh sooner than other screens (an hour), for new uploads */
var SUBSCRIPTIONS_REFRESH_MS = 20 * 60 * 1000;
/** The account each feed was fetched for (refetched when it changes) */
var feedAccounts: { [id: string]: string } = {};
var NO_ACCOUNT = tr('No one is signed in. Choose who\'s watching, or add an account: the logo\'s Switch account.');
/** The section Search was opened from (Back returns there) */
var beforeSearch = '';

/** Optional screen hooks used here beyond View's. In the background (the visibility handler below) the screen gets
 * putFresh as the app hides and renewIfOld as it returns; a screen with timers of its own (sign-in, the TV code) asks
 * nothing while document.hidden and catches up once back. */
interface Screen extends View {
    show(rest?: boolean): void;
    renewIfOld?: () => void;
    putFresh?: () => void;
    cover?: (covered: boolean) => void;
    setProgress?: (id: string, progress: number) => void;
    removeVideo?: (id: string) => void;
    reload?: () => void;
    focusedVideo?: () => Video | null;
    settled?: boolean;
    retry?(quiet?: boolean): boolean;
    /** The panel or picker open over it (null: none; core/pointer.ts) */
    layer?: () => HTMLElement | null;
    /** It keeps code before any shortcut (Search's keyboard the numbers; what is open over it keeps every key: layer) */
    ownKeys?: (code: number) => boolean;
    /** OK on its page tiles opens something else than the tile's page (no page is built ahead for them) */
    opensOwn?: boolean;
}

/** A screen of the account's rows (load), stored across starts; name: used in the load-failure message */
function feedSection(id: string, load: () => Promise<Rows>, name: string, empty: string, opts?: FeedOptions): FeedView {
    return new FeedView(yourFeed(id, load, true), feedTexts(name, empty), openTile, feedOptions(id, opts));
}

function feedTexts(name: string, empty: string): FeedTexts {
    return { empty: empty, noAccount: NO_ACCOUNT, failed: tr('Could not load {1}. Press OK to try again.', name) };
}

/** Page options: full screen with a back arrow when the theme wants it, page buttons, fade-in as rows arrive */
function pageOptions(): FeedOptions {
    return { page: metrics().ways.pagesOverAll ? { back: closePage } : undefined, onButton: pressPageButton, fade: true, onList: preloadFocused };
}

/** The screen the app starts on (Settings: Start page, read at each use: it may change meanwhile); Back in the rail
 * goes here, then exits */
function startPage(): string {
    return prefs().startPage;
}

/** Section options: rows stored across starts, logo on the start page only */
function feedOptions(id: string, opts?: FeedOptions): FeedOptions {
    var o: FeedOptions = opts || {};
    o.kept = keptFeed(id);
    o.logo = id === startPage();
    return o;
}

/** OK on a channel in Subscriptions opens its channel page; without one, its latest videos as a grid */
function openSubChannel(c: SubChannel): void {
    if (c.channel) {
        openPage(c.channel, { title: c.title, picture: c.picture, fresh: c.fresh });
        return;
    }
    openVideos(c.title, c.page);
}

/** A channel's latest videos (its page in Subscriptions, or its Videos page) as a grid */
function openVideos(title: string, p: Page): void {
    pushPage(new FeedView(function () {
        return keptPage(p).then(function (rows) {
            var next = rows.shelves.length ? rows.shelves[rows.shelves.length - 1].next : '';
            return { title: title, next: '', shelves: [{ title: '', videos: allVideos(rows), grid: true, next: next }] };
        });
    }, feedTexts(title, tr('No videos from {1} yet.', title)), openTile, pageOptions()));
}

/** Every video of rows, shelf after shelf */
function allVideos(rows: Rows): Video[] {
    var videos: Video[] = [];
    rows.shelves.forEach(function (s) { videos = videos.concat(s.videos); });
    return videos;
}

/** Your subscriptions, A-Z (Settings › Shortcuts' "A channel…") */
function subscribedChannels(): Promise<SubChannel[]> {
    return subscriptions().then(function (rows) {
        return (rows.channels || []).filter(function (c) { return !c.recent; });
    });
}

/** Your Library's playlists, Watch later and Liked videos among them (Settings › Shortcuts' "A playlist…") */
function libraryPlaylists(): Promise<Video[]> {
    return keptPage({ browseId: BROWSE.library.browseId }).then(function (rows) {
        var seen: { [id: string]: boolean } = {};
        return allVideos(rows).filter(function (v) {
            var id = v.page && /^VL/.test(v.page.browseId) ? v.page.browseId : '';
            var first = !!id && !seen[id];
            seen[id] = true;
            return first;
        });
    });
}

/** All subscribed channels, A-Z, as round tiles (Subscriptions' All); OK opens one */
function openChannels(list: SubChannel[]): void {
    var byId: { [id: string]: SubChannel } = {};
    var videos: Video[] = list.filter(function (c) { return !c.recent; }).map(function (c) {
        var id = c.page.browseId + (c.page.params || '');
        byId[id] = c;
        return { id: id, title: c.title, channel: '', length: '', info: '', page: c.page, image: c.picture, round: true };
    });
    var rows: Rows = { title: tr('All subscriptions'), next: '', shelves: [{ title: '', videos: videos, grid: true }] };
    var grid: Screen = new FeedView(function () { return Promise.resolve(rows); }, feedTexts(tr('your subscriptions'), tr('No subscriptions yet.')),
        function (v) { openSubChannel(byId[v.id]); }, pageOptions());
    // (OK on a tile here opens the channel's page, not the tile's own: none is built ahead for it)
    grid.opensOwn = true;
    pushPage(grid);
}

/** Section id, built on first use */
function section(id: string): Screen {
    if (!sections[id]) {
        var browse = BROWSE[id];
        sections[id] = id === 'search' ? new SearchView(openTile, leaveSearch, searchAhead) :
            id === 'settings' ? new SettingsView(function () { return cast.linkCode(); }, SCREENS_RAIL, question, restartApp,
                { prompt: shortcutPrompt, panel: tileMenu, channels: subscribedChannels, playlists: libraryPlaylists }) :
            id === 'home' ? feedSection(id, home, tr('Home'), tr('Nothing on Home yet.'), {
                // As YouTube: a search bar (OK goes to Search) and big tiles in the focused row
                onSearch: openSearch,
                onNudge: pressNudge,
                big: metrics().ways.homeBig
            }) :
            id === 'subscriptions' ? new SubscriptionsView(yourFeed(id, subscriptions),
                feedTexts(tr('your subscriptions'), tr('No videos from your subscriptions.')), openTile,
                feedOptions(id, { refreshMs: SUBSCRIPTIONS_REFRESH_MS }), openSubChannel, openChannels, function (c) {
                    // Focus rested on a channel: its page fetched ahead, and built once it has rested a little longer
                    // (building one holds the keys ~0.1 s: not while moving along the channels), so OK shows it at once
                    if (c.channel && prefs().preload) {
                        var page = c.channel;
                        channelAhead(page, c.fresh);
                        clearTimeout(builtTimer);
                        builtTimer = setTimeout(function () {
                            buildAhead(page, { title: c.title, picture: c.picture, fresh: c.fresh });
                        }, BUILD_AHEAD_MS) as unknown as number;
                    }
                }) :
            id === 'library' ? new LibraryView(yourFeed(id, function () { return page({ browseId: browse.browseId }); }),
                feedTexts(tr('your library'), tr('Nothing in your library yet.')), openTile, feedOptions(id)) :
            feedSection(id, function () { return page({ browseId: browse.browseId }); }, browse.label,
                tr('Nothing in {1} yet.', browse.label), {
                    // Topic pages have Home's search bar, as in YouTube (Library has none)
                    onSearch: openSearch
                });
        // (its rows are cut off at the rail's edge: themes/youtube.css)
        if (id !== 'search') {
            toggleClass(sections[id].el, 'by-section', true);
        }
        stage.appendChild(sections[id].el);
    }
    return sections[id];
}

/** The visible screen: the top page, else the section */
function screen(): Screen {
    return pages.length ? pages[pages.length - 1] : sections[current];
}

/** Shows section id with its open pages; selecting the current section again (Back in the rail) closes its pages;
 * rest: shown in passing while the rail moves through it */
function switchSection(id: string, rest?: boolean): void {
    // Leaving these pages: Back no longer returns to the video they came from; stop the tile preview
    fromPlayer = null;
    preview.stop();
    if (id === current) {
        if (pages.length) {
            screen().hide();
            dropPages(id);
            bring(screen());
            updateMenu();
        }
        return;
    }
    if (current) {
        // (the rail moving on: the section left stands by, to be back at once if the focus returns; the one coming
        // is taken off the list first, so making room for the one left cannot hide it)
        var coming = screenOf(id);
        if (coming) {
            unstand(coming);
        }
        if (menuFocused) {
            setBy(screen());
        } else {
            screen().hide();
        }
    }
    if (id === 'search') {
        beforeSearch = current;
    }
    current = id;
    pages = pagesOf[id] = pagesOf[id] || [];
    menu.select(id);
    section(id);
    // Entering Search focuses its keyboard, as YouTube (not when a page over it closes)
    if (id === 'search') {
        (sections[id] as SearchView).enter();
    }
    bring(screen(), rest);
    // Its focus as the rail's: none while the rail has it (a section shown by resting on its entry)
    updateMenu();
}

/** Opens Search from a search bar; voice: from its microphone, listening at once */
function openSearch(voice: boolean): void {
    if (voice) {
        voiceSearch();
    } else {
        switchSection('search');
    }
}

/** Opens Search and listens (Android's speech recognition over the app); what is said is searched */
function voiceSearch(): void {
    switchSection('search');
    leaveMenu();
    if (!(sections.search as SearchView).voice()) {
        toast(tr('Voice search does not work on this device.'), undefined, PROBLEM);
    }
}

/** Back from Search returns to the section it was opened from */
function leaveSearch(): void {
    var to = beforeSearch && beforeSearch !== 'search' ? beforeSearch : startPage();
    // If Search is the start page, go to the rail as from other screens
    if (to === 'search') {
        menuFocused = true;
        return;
    }
    switchSection(to);
}

/** Drops section id's pages (emptied in place: the current section's list is `pages`) */
function dropPages(id: string): void {
    var list = pagesOf[id] || [];
    list.forEach(discard);
    list.length = 0;
}

/** The screen section id shows: its top page, else the section itself (undefined: not built yet) */
function screenOf(id: string): Screen | undefined {
    var list = pagesOf[id];
    return list && list.length ? list[list.length - 1] : sections[id];
}

/** Section id stands by (and was not hidden since): the rail shows it with the step, it has nothing to draw */
function standsReady(id: string): boolean {
    var view = screenOf(id);
    return !!view && standing.indexOf(view) >= 0 && isStandingBy(view.el);
}

/** Shows view (rest: in passing, as switchSection), no longer standing by */
function bring(view: Screen, rest?: boolean): void {
    unstand(view);
    view.show(rest);
}

function unstand(view: Screen): void {
    var at = standing.indexOf(view);
    if (at >= 0) {
        standing.splice(at, 1);
    }
}

/** Takes view out of sight: standing by if it can (the one longest so is let go past STANDING_MAX), else hidden */
function setBy(view: Screen): void {
    unstand(view);
    if (!view.standBy) {
        view.hide();
    } else if (view.standBy()) {
        standing.push(view);
        while (standing.length > STANDING_MAX) {
            (standing.shift() as Screen).hide();
        }
    }
}

/** Hides every screen standing by: now, or (ms) once that time has passed with no other call */
function letGo(ms?: number): void {
    clearTimeout(standTimer);
    if (ms) {
        standTimer = setTimeout(letGo, ms) as unknown as number;
        return;
    }
    standing.splice(0).forEach(function (view) { view.hide(); });
}

/** Section id is a screen of rows (they can be drawn ahead from the stored ones: not Search's keyboard or Settings) */
function hasRows(id: string): boolean {
    return id !== 'search' && id !== 'settings';
}

/** The rail's items beside its focus, the one below first (none while a video shows or the app is out of sight:
 * nothing is drawn then) */
function neighbours(): RailItem[] {
    var at = RAIL.map(function (r) { return r.id; }).indexOf(menu.focusedId);
    return at < 0 || own.busy || tv.busy || document.hidden ? [] : [RAIL[at + 1], RAIL[at - 1]].filter(function (r) { return !!r; });
}

/** The sections beside the rail's focus stand by (drawing one is no request), so a step to either shows it at once:
 * one of them now, the other after another NEIGHBOURS_MS (drawing a screen holds the keys ~0.1 s); one not built
 * yet gets its turn once the focus has rested (buildNeighbour) */
function neighboursBy(): void {
    clearTimeout(buildTimer);
    var drew = false;
    neighbours().forEach(function (r) {
        var view = screenOf(r.id);
        if (view && view !== screen() && view.standBy && standing.indexOf(view) < 0) {
            if (drew) {
                clearTimeout(neighboursTimer);
                neighboursTimer = setTimeout(neighboursBy, NEIGHBOURS_MS) as unknown as number;
            } else {
                drew = true;
                setBy(view);
            }
        } else if (!view && hasRows(r.id)) {
            // (one timer, whichever of the two is not built: buildNeighbour builds one and comes back here)
            clearTimeout(buildTimer);
            buildTimer = setTimeout(buildNeighbour, BUILD_REST_MS - NEIGHBOURS_MS) as unknown as number;
        }
    });
}

/** Builds one section beside the rail's focus that was not shown in this run, from its stored rows (YouTube is asked
 * when it shows), and has it stand by; the other one's turn comes after another rest */
function buildNeighbour(): void {
    var next = neighbours().filter(function (r) { return !sections[r.id] && hasRows(r.id); })[0];
    if (next) {
        prepared[next.id] = true;
        (section(next.id) as FeedView).prepare();
        neighboursBy();
    }
}

/** Closes a page for good: off the stage, its work ended (late replies, paging, timers) */
function discard(view: Screen): void {
    unstand(view);
    unstage(view);
    if (view.destroy) {
        view.destroy();
    }
}

/** Removes a page's element from the stage (if there) */
function unstage(view: Screen): void {
    if (view.el.parentNode === stage) {
        stage.removeChild(view.el);
    }
}

/** Removes a reused page (Who's watching?, sign-in) and those above it from every section's pages */
function takeOut(view: Screen): void {
    for (var id in pagesOf) {
        var list = pagesOf[id];
        var at = list.indexOf(view);
        if (at >= 0) {
            // Those above it are closed for good; it is shown again
            list.splice(at + 1).forEach(discard);
            unstage(list.pop() as Screen);
        }
    }
}

/** Opens a page over the current screen (Back closes it): a channel page (UC…, not a sub page; known: name and avatar
 * to show at once) or any other. The one built ahead (buildAhead) shows at once. */
function openPage(p: Page, known?: KnownChannel): void {
    var ready = built && built.key === builtKey(p) ? built.view : null;
    if (ready) {
        built = null;
    } else {
        dropBuilt();
    }
    pushPage(ready || pageView(p, known));
    // (built ahead but its request failed meanwhile: asked again now, as an OK on a page not built is)
    if (ready && ready.retry) {
        ready.retry(true);
    }
}

/** The screen of page p (not yet on the stage) */
function pageView(p: Page, known?: KnownChannel): Screen {
    var texts = {
        empty: tr('Nothing here yet.'),
        noAccount: NO_ACCOUNT,
        failed: tr('Could not load this page. Press OK to try again.')
    };
    return isChannel(p) ? new ChannelView(p, texts, openTile, openPage, openSearch, known, function (c: Channel) {
        // Its videos: its uploads, newest first (YouTube's playlist UU… of channel UC…), whatever its tabs are
        askShortcut('channel', p.browseId, { title: c.title, channel: p, videos: { browseId: 'VLUU' + p.browseId.slice(2) } });
    }) : new FeedView(function () { return keptPage(p); }, texts, openTile, pageOptions());
}

/** The page built ahead of OK on its tile (one at a time): fetched as pageAhead does once the focus has rested there,
 * and drawn out of sight as it arrives, so OK has nothing to build or draw (building a channel page takes the TV
 * ~0.13 s, drawing one 0.3-0.6 s). Dropped when the focus goes to another tile, a video starts or another page opens. */
var built: { key: string; view: Screen } | null = null;
/** A channel of Subscriptions' strip (fetched ahead after 0.3 s there) is built this much later: 0.5 s in all, as a
 * page tile's page */
var BUILD_AHEAD_MS = 200;
var builtTimer = 0;

function builtKey(p: Page): string {
    return p.browseId + ' ' + (p.params || '');
}

/** What a channel's round tile knows of its channel (shown while its page loads; undefined: nothing) */
function knownOf(tile: Video): KnownChannel | undefined {
    return tile.round && tile.image ? { title: tile.title, picture: tile.image } : undefined;
}

/** Page p fetched ahead and, with Videos start sooner, built ahead (known: as openPage) */
function pageReady(p: Page, known?: KnownChannel): void {
    pageAhead(p);
    if (prefs().preload) {
        buildAhead(p, known);
    }
}

/** Builds page p ahead (known: as openPage), unless it is the one built; only a page that is fetched ahead (not
 * History: each showing of it asks YouTube) and that OK on the focused tile opens */
function buildAhead(p: Page, known?: KnownChannel): void {
    var key = builtKey(p);
    if (built && built.key === key) {
        return;
    }
    dropBuilt();
    if (!isChannel(p) && !keepable(p) || screen().opensOwn) {
        return;
    }
    var view = pageView(p, known);
    if (view.drawAhead) {
        stage.appendChild(view.el);
        view.drawAhead();
        built = { key: key, view: view };
    }
}

/** Lets go of the page built ahead (closed for good), and of one about to be built */
function dropBuilt(): void {
    clearTimeout(builtTimer);
    if (built) {
        built.view.hide();
        discard(built.view);
        built = null;
    }
}

/** A page button (e.g. History's): a filter's choices in the panel (a choice reloads the page filtered), an on/off
 * toggle applied at once (reverted if YouTube rejects it), YouTube's question first (yes: done, page reloaded), a
 * playlist's Play all, Shuffle or Repeat, its Repeat switch, or its Shortcut */
function pressPageButton(b: PageButton, view: FeedView): void {
    var choices = b.choices;
    var toggle = b.toggle;
    var ask = b.ask;
    if (choices) {
        tileMenu.open(choices.title, choices.items.map(function (c) {
            // The filtered page brings its own buttons, this one named after the choice
            return { label: c.text, chosen: c.chosen, action: function () {
                view.reloadAs(function () { return keptPage(c.page); });
            } };
        }), -1);
    } else if (toggle) {
        // (done: YouTube's own message with it, e.g. Saved to library)
        var command = toggle.commands[toggle.on ? 1 : 0];
        apply(toggle, 'on', !toggle.on, command, function () { view.drawButtons(); }, tr('YouTube did not take the change. Try again.'), toastOf(command) || undefined);
    } else if (ask) {
        askToClear(question, ask, function () { view.reload(); });
    } else if (b.shortcut) {
        // (its preview stops: the panel and the prompt show under the player's layer)
        preview.stop();
        askShortcut('playlist', b.shortcut, { title: view.playlistInfo().title });
    } else if (b.turn) {
        var on = view.turn(b.turn);
        toast(b.turn === 'repeat' ? (on ? tr('Repeat on') : tr('Repeat off')) : on ? tr('Shuffle on') : tr('Shuffle off'), b.turn === 'repeat' ? 'loop' : 'shuffle');
    } else if (b.play) {
        // A playlist's Play all: its videos in its order or Shuffle's (Repeat on: they loop at the end); YouTube's own
        // Repeat or Shuffle elsewhere: the page's videos from the first, looping or shuffled
        var playlist = !!view.frame;
        var videos = view.playable();
        var ids = playlist ? view.order(undefined, videos) : (b.play.shuffle ? shuffle(videos) : videos).map(function (v) { return v.id; });
        playList(videos, ids, b.play.loop || playlist && view.repeating, playlist ? view.playlistInfo(videos) : undefined);
    }
}

/** Plays the first of ids (one of videos) with the rest after it (repeat: again from the first at the end), the
 * playlist they are from (if one) shown in the player */
function playList(videos: Video[], ids: string[], repeat: boolean, playlist?: PlaylistInfo): void {
    var start = videos.filter(function (v) { return v.id === ids[0]; })[0];
    if (start) {
        play({ id: start.id, title: start.title, channel: start.channel, length: '', info: '', start: 0, repeat: repeat, list: ids, playlist: playlist });
    }
}

/** Shows view over the current screen (Back closes it) */
function pushPage(view: Screen): void {
    // A tile's preview belongs to its screen
    preview.stop();
    // (a page built ahead that is not the one opening: no longer wanted)
    if (built && built.view !== view) {
        dropBuilt();
    }
    // (the screen under it stands by for a while: Back shows it at once)
    setBy(screen());
    letGo(PAGE_STAND_MS);
    pages.push(view);
    // (a page built ahead is on the stage already: put there again, the TV would lay it out and draw it anew)
    if (view.el.parentNode !== stage) {
        stage.appendChild(view.el);
    }
    view.show();
    updateMenu();
}

/** Closes the top page and shows what is under it; for a channel page opened from a video, that video resumes (the
 * app's player keeps it for a minute) */
function closePage(): void {
    preview.stop();
    var view = pages.pop() as Screen;
    view.hide();
    discard(view);
    bring(screen());
    if (fromPlayer && fromPlayer.view === view) {
        var id = fromPlayer.id;
        fromPlayer = null;
        own.comeBack(id);
    }
}

/** OK on a tile: opens a page or plays a video */
function openTile(video: Video): void {
    if (video.page) {
        openPage(video.page, knownOf(video));
    } else {
        play(video);
    }
}

/** An account feed loader (for a guest YouTube's signed-out rows where guestRows, else null); records the account and
 * stores the rows for the next start */
function yourFeed(name: string, load: () => Promise<Rows>, guestRows?: boolean): () => Promise<Rows | null> {
    return function () {
        return account().then(function (id) {
            feedAccounts[name] = id;
            // A guest: YouTube's signed-out rows where it has some (guestRows: Home, the topic pages), not stored; none
            // of an account's own lists (Subscriptions, Library)
            if (!id) {
                return guestRows ? load() : null;
            }
            return load().then(function (rows) {
                // Stored after they are drawn, so storing does not delay drawing
                if (id.indexOf(NO_TOKEN) < 0) {
                    setTimeout(function () { keepRows(name, id, rows); }, 0);
                }
                return rows;
            });
        });
    };
}

/** A feed's stored rows (null: none), and whether they belong to the account YouTube's app used last */
function keptFeed(name: string): () => KeptFeed | null {
    return function () {
        var kept = keptRows(name);
        return kept && {
            rows: kept.rows,
            same: function () {
                return lastAccount().then(function (id) { return !!id && keptFor(kept!, id); });
            }
        };
    };
}

/** Prefetches search results (focus rests on a suggestion or Search) so they show at once */
function searchAhead(term: string): void {
    if (prefs().preload) {
        fetchSearchAhead(term);
    }
}

/** The first videos of a page or search fetched ahead get DeArrow's branding too, so it opens with it at once */
var DEARROW_AHEAD = 12;
tapAhead(function (json) {
    if (dearrowOn()) {
        var ids: Wanted[] = [];
        var found = /"id":"([\w-]{11})"/g;
        var m: RegExpExecArray | null;
        while ((m = found.exec(json)) && ids.length < DEARROW_AHEAD) {
            ids.push({ id: m[1] });
        }
        dearrowFetch(ids);
    }
});

/** Prefetches a page (focus rests on its tile or the watch page's channel avatar) so it opens at once */
function pageAhead(p: Page): void {
    if (prefs().preload) {
        if (isChannel(p)) {
            channelAhead(p);
        } else {
            fetchPageAhead(p);
        }
    }
}

/** The YouTube account may have changed: reload feeds fetched for another account */
function accountChanged(): void {
    dropBuilt();
    forgetSaves();
    forgetKept();
    forgetPages();
    forgetHistorySettings();
    // (until the account is known again, no account's picture as the logo)
    setLogoAccount(null);
    knowAccount();
    account().then(function (id) {
        var changed = false;
        for (var name in sections) {
            // A section prepared but not shown yet drew stored rows without checking the account
            if (name in feedAccounts ? feedAccounts[name] !== id : prepared[name]) {
                changed = true;
                (sections[name] as FeedView | SubscriptionsView | LibraryView).reload();
            }
        }
        // Other sections' open pages belong to the previous account
        for (var s in pagesOf) {
            if (changed && s !== current) {
                dropPages(s);
            }
        }
    }, function () { return undefined; });
}

/** Patient waits for the screen to rest, parked while a video plays */
var parked: (() => void)[] = [];

/** Runs then once the current screen has its rows and visible pictures and no key was pressed for IDLE_START_MS;
 * after START_LATEST_MS at most (patient: no limit, and none of it while a video plays) */
function whenScreenRests(then: () => void, patient?: boolean): void {
    var since = Date.now();
    /** When the screen was first seen fully drawn (0: not yet) */
    var drawnAt = 0;
    (function look(): void {
        if (patient && own.busy) {
            // Not looked for under a video: on once the player closes (shownOver), the screen drawn anew
            drawnAt = 0;
            parked.push(look);
            return;
        }
        var now = Date.now();
        var view = sections[current];
        if (!drawnAt && view.settled !== false && !picturesWaiting()) {
            drawnAt = now;
        }
        var restsAt = drawnAt ? Math.max(drawnAt, lastKeyAt()) + IDLE_START_MS : 0;
        if (drawnAt && now >= restsAt || !patient && now - since > START_LATEST_MS) {
            then();
        } else {
            setTimeout(look, drawnAt ? Math.max(100, restsAt - now) : 100);
        }
    })();
}

/** Number of visible tile pictures not loaded yet (including ones without a src yet) */
function picturesWaiting(): number {
    // In sight: within the layout's screen (its units, as the tiles': index.html zooms it, so not the window's size)
    return [].filter.call(stage.querySelectorAll('.bd-tile img'), function (img: HTMLImageElement) {
        var at = img.getBoundingClientRect();
        return at.width > 0 && at.right > 0 && at.bottom > 0 && at.top < LAYOUT_HEIGHT && at.left < LAYOUT_WIDTH &&
            !(img.getAttribute('src') && img.complete);
    }).length;
}

function leaveMenu(): void {
    menuFocused = false;
}

/** The current account as the logo's list shows it (null: a guest or not known yet), and the accounts whose names
 * were requested in this run */
var me: Profile | null = null;
var namesAsked: { [key: string]: boolean } = {};
/** Requested size of the account picture in the logo's list (shown at 28 px on a 1.5x screen) */
var RAIL_PICTURE_PX = 64;

/** Looks up the current account (stored name and picture; if unknown, requested once per run), and tells the logo
 * (its picture may be the logo); with none, opens "Who's watching?" (not where Guest was chosen there) */
function knowAccount(): void {
    keptProfiles().then(function (list) {
        me = list[0] && list[0].current ? list[0] : null;
        logoAccount();
        if (!me) {
            guestChosen().then(function (guest) {
                if (!guest) {
                    askAccount();
                }
            }, function () { return undefined; });
        } else if (!me.name && !namesAsked[me.key]) {
            namesAsked[me.key] = true;
            profiles().then(function (fresh) {
                me = fresh[0] && fresh[0].current ? fresh[0] : null;
                logoAccount();
            }, function () { return undefined; });
        }
    }, function () { return undefined; });
}

/** Tells the logo the current account and its picture's address (ui/logo.ts: Settings' "Your YouTube avatar") */
function logoAccount(): void {
    setLogoAccount(me ? { key: me.key, url: me.picture ? sized(me.picture, ACCOUNT_PICTURE_PX) : '' } : null);
}

/** Starts the app again (what it keeps across starts saved first) */
function restartApp(): void {
    saveAvatars();
    saveDearrow();
    window.location.reload();
}

/** The logo's list: the account ("Your channel", Sign out), Switch account, Restart app (Settings is at the rail's
 * bottom, as in YouTube) */
function logoEntries(): RailEntry[] {
    var p = me;
    var list: RailEntry[] = [];
    if (p) {
        list.push({ label: p.name || tr('Your account'), picture: sized(p.picture, RAIL_PICTURE_PX), entries: [
            { label: tr('Your channel'), action: function () { openOwnChannel(p!); } },
            { label: tr('Sign out'), action: function () { askSignOut(p!); } }
        ] });
    }
    list.push({ label: tr('Switch account'), action: openAccounts });
    list.push({ label: tr('Restart app'), action: restartApp });
    return list;
}

/** "Who's watching?" and the sign-in screen (created on first use) */
var accountsView: AccountsView | null = null;
var signInView: SignInView | null = null;

/** Opens "Who's watching?" (or brings it back on top): OK on an account uses it, Add account signs one in */
function openAccounts(): void {
    leaveMenu();
    if (accountsView && pages.indexOf(accountsView) >= 0) {
        while (screen() !== accountsView) {
            closePage();
        }
        return;
    }
    accountsView = accountsView || new AccountsView(function (p) {
        if (p.current) {
            closePage();
        } else {
            useAccount(p.identity);
        }
    }, function () {
        signInView = signInView || new SignInView(signedIn);
        takeOut(signInView);
        pushPage(signInView);
    }, function (current) {
        if (current) {
            closePage();
            return;
        }
        useGuest().then(function () {
            forgetRows();
            switched();
        }, function () {
            toast(tr('Could not switch the account. Try again.'), undefined, PROBLEM);
        });
    });
    // If open in another section, move it here; focus starts on the current account, as in YouTube
    takeOut(accountsView);
    accountsView.focusOn(null);
    pushPage(accountsView);
}

/** After a sign-in: with brand accounts, reopen "Who's watching?" with a brand account focused to pick one (as
 * YouTube's app does; a plain Google account may have an empty Home); otherwise use the account at once */
function signedIn(identity: Identity): void {
    toast(tr('Signed in'), 'check');
    keptProfiles().then(function (list) {
        var its = list.filter(function (p) { return p.identity.ownerObfuscatedGaiaId === identity.ownerObfuscatedGaiaId; });
        if (its.length < 2) {
            useAccount(identity);
            return;
        }
        var brand = its.filter(function (p) { return isBrand(p.identity); })[0];
        var key = (brand || its[0]).key;
        // If the user left the sign-in meanwhile, reopen Who's watching?
        if (screen() === signInView) {
            (accountsView as AccountsView).focusOn(key);
            closePage();
        } else {
            // Already on top (left with Back during the last poll), it is not shown anew: drawn again here
            var onTop = screen() === accountsView;
            openAccounts();
            (accountsView as AccountsView).focusOn(key);
            if (onTop) {
                (accountsView as AccountsView).show();
            }
        }
    }, function () {
        useAccount(identity);
    });
}

/** Uses identity's account (the app starts over on it); if youtube.com's page fails, says so (orElse: then runs it) */
function useAccount(identity: Identity, orElse?: () => void): void {
    useIdentity(identity).then(switched, function () {
        toast(tr('Could not switch the account. Try again.'), undefined, PROBLEM);
        if (orElse) {
            orElse();
        }
    });
}

/** For a guest, "Who's watching?" opens once until an account is used */
var askedAccount = false;

function askAccount(): void {
    if (!askedAccount) {
        askedAccount = true;
        openAccounts();
        updateMenu();
    }
}

/** After switching account (or to a guest): restarts YouTube's app, closes open pages, shows the start page and
 * reloads the screens (accountChanged) */
function switched(): void {
    tv.shutDown();
    askedAccount = false;
    screen().hide();
    for (var id in pagesOf) {
        dropPages(id);
    }
    if (current === startPage()) {
        bring(screen());
    } else {
        switchSection(startPage());
    }
    accountChanged();
    updateMenu();
}

/** Opens the account's own channel */
function openOwnChannel(p: Profile): void {
    ownChannel(p).then(function (page) {
        if (page) {
            openPage(page);
            leaveMenu();
            updateMenu();
        } else {
            toast(tr('This account has no channel.'));
        }
    }, function () {
        toast(tr('YouTube did not answer. Try again.'), undefined, PROBLEM);
    });
}

/** Signs out after YouTube's question: the Google account with its brand accounts (also in YouTube's own app, which
 * shares them); then uses the most recent remaining account, or a guest */
function askSignOut(p: Profile): void {
    keptProfiles().then(function (list) {
        var google = googleOf(p, list);
        question.open({
            title: tr('Sign out?'),
            subtitle: google.name ? tr('{1} and its channels will be signed out on this TV, in YouTube\'s own app too.', google.name) :
                tr('This account and its channels will be signed out on this TV, in YouTube\'s own app too.'),
            picture: google.picture, round: true, yes: tr('Sign out'), no: tr('Cancel')
        }, function () {
            signOut(google).then(function () {
                toast(google.name ? tr('Signed out of {1}', google.name) : tr('Signed out'), 'check');
                // Signed out either way: the app starts over (as a guest if no other account can be used)
                keptProfiles().then(function (left) {
                    if (left.length) {
                        useAccount(left[0].identity, switched);
                    } else {
                        switched();
                    }
                }, switched);
            }, cannotSignOut);
        });
    }, cannotSignOut);
}

function cannotSignOut(): void {
    toast(tr('Could not sign out. Try again.'), undefined, PROBLEM);
}

/** A button of YouTube's nudge shown instead of Home's rows (watch history off: "Turn on history"; a guest: "Sign in"):
 * sends its command, after YouTube's question if any, and toasts YouTube's reply; reloads Home on a change, or hides
 * the nudge when told */
function pressNudge(command: any, view: FeedView): void {
    // A guest's Home ("Make YouTube your own"): Sign in is "Who's watching?", where an account is picked or added
    if (first(command, 'signInEndpoint')) {
        openAccounts();
        return;
    }
    var ask = first(command, 'confirmDialogRenderer');
    var send = function (c: any, done: () => void): void {
        run(c).then(function () {
            var said = text(get(first(c, 'overlayMessageRenderer'), 'title')) || toastOf(c);
            if (said) {
                toast(said, 'check');
            }
            done();
        }, function () {
            toast(tr('YouTube did not take that. Try again.'), undefined, PROBLEM);
        });
    };
    if (!ask) {
        send(command, function () {
            if (first(command, 'hideEnclosingAction')) {
                view.hideNudge();
            }
        });
        return;
    }
    question.open({
        title: text(ask.title), subtitle: (ask.dialogMessages || []).map(text).join('\n\n'), picture: '',
        yes: text(get(ask, 'confirmButton', 'buttonRenderer', 'text')), no: text(get(ask, 'cancelButton', 'buttonRenderer', 'text')) || tr('Cancel')
    }, function () {
        send(get(ask, 'confirmButton', 'buttonRenderer', 'serviceEndpoint'), function () { view.reload(); });
    });
}

/** Plays video in Bolli's player (a film in YouTube's), over the app; Back returns here. Starts where startTime says */
function play(video: Video): void {
    // Films play only in YouTube's player (a toast says so)
    var bolli = !video.movie;
    // Release YouTube's app kept for films (ready or starting): the app's player needs the decoder and memory
    if (bolli) {
        tv.shutDown();
    }
    // The player takes over this video's playing preview (not from a playlist with Settings › Starting from a playlist:
    // From the start); any other preview stops (its position is kept)
    var fromStart = !!video.playlist && !prefs().listCarryOn;
    // (nor a preview playing in the kept pipeline's codec where the video starts in another: stopped, started where it was)
    if (!bolli || !preview.takes(video.id) || fromStart) {
        preview.stop();
    }
    var t = startTime(video);
    if (bolli) {
        // A video closed a moment ago (e.g. Back by mistake) resumes as it was, with its play list if any (not from the
        // start)
        var queue = video.list ? new ListQueue(video.list, video.id, video.repeat) : null;
        if (queue && video.playlist) {
            followList(queue, video.playlist);
        }
        if (fromStart || !own.comeBack(video.id, queue || undefined)) {
            own.play(video.id, video.title, video.channel, t, queue, startPicture(video));
        }
        // A taken-over preview now belongs to the player
        preview.stop();
        return;
    }
    // (webOS TV 2.x's engine: YouTube's player does not run there)
    if (!tv.runs) {
        toast(tr('Movies play only in YouTube\'s player, which does not run on this TV.'), undefined, PROBLEM);
        return;
    }
    var ready = tv.ready;
    // Free the TV's decoder held by the app's player
    own.release();
    if (!tv.play(video.id, updateMenu, t, video.movie)) {
        return;
    }
    toast(ready ? tr('Movies can only play in YouTube\'s player, so it opens there') : tr('Movies can only play in YouTube\'s player, so it opens there (starting it)'), 'info');
}

/** Where OK on the video's tile starts it: where it stopped here, else YouTube's resume point (or the preview's
 * position). From a playlist's page: at its start (Settings › Starting from a playlist), or on from its preview
 * playing in the frame (0: the preview taken over where it plays) */
function startTime(video: Video): number {
    if (video.playlist && (!prefs().listCarryOn || preview.playing(video.id))) {
        return 0;
    }
    var here = watchedAt(video.id);
    return Math.max(here >= 0 ? here : video.start || 0, preview.from(video.id));
}

/** The screen when it is a playlist's page (with its frame: views/list-stage.ts), else null */
function listScreen(): FeedView | null {
    var view = screen();
    return view instanceof FeedView && view.frame ? view : null;
}

/** Where the focused video would start, for loading it ahead: on a playlist's page with Settings › Starting from a
 * playlist: From the start, at its start */
function aheadAt(video: Video): number {
    return !prefs().listCarryOn && listScreen() ? 0 : startTime(video);
}

/** A playlist's queue (the screen is its page) knows the playlist and grows with it: as it nears its end the page,
 * while it still shows under the player, fetches its next part, which joins the queue in the order it plays and the
 * playlist the player shows (the page is not kept by the queue: it may close) */
function followList(queue: ListQueue, playlist: PlaylistInfo): void {
    queue.playlist = playlist;
    var list = listScreen();
    // (only its own page: a playlist played by a shortcut over another one's does not grow with that one)
    if (!list || list.playlistInfo([]).id !== playlist.id) {
        return;
    }
    var added = list.added = function (ids: string[], videos: Video[]): void {
        queue.add(ids);
        var have: { [id: string]: boolean } = {};
        playlist.videos.forEach(function (v) { have[v.id] = true; });
        playlist.videos = playlist.videos.concat(videos.filter(function (v) { return !have[v.id]; }));
    };
    queue.onNear = function () {
        var now = listScreen();
        if (now && now.added === added) {
            now.loadMore();
        }
    };
    queue.ask();
}

/** Plays video id in a playlist's frame as its settings say (nothing with Playlist preview: Its picture only): the
 * whole video with Autoplay on the playlist page (the next one after it), the closed video kept going on where it was
 * (resume); filling the screen (Backdrop), the page and the rail's clock over it while it plays */
function showOnStage(list: FeedView, id: string, resume?: boolean): void {
    var frame = list.frame;
    var stage = frame && frame.shown === id ? frame.preview() : null;
    if (!frame || !stage) {
        return;
    }
    frame.details();
    var behind = function (on: boolean): void {
        list.previewing(on);
        toggleClass(root, 'by-app--behind', on);
    };
    // Release YouTube's app kept for films: the preview needs the decoder
    tv.shutDown();
    preview.show(id, stage.frame, stage.sound, { square: stage.backdrop, stage: !stage.backdrop, whole: prefs().listAutoplay, resume: resume,
        done: function () { behind(false); }, ended: function () { stageEnded(list, id); } });
    // (after show: it stops the preview before, whose done takes the classes off)
    behind(stage.backdrop);
}

/** A playlist's frame played video id to its end: with Settings › Autoplay on the playlist page the next one (in its
 * order or Shuffle's, again from the first with Repeat on) plays there, the list's focus moving to it (not from the
 * buttons) */
function stageEnded(list: FeedView, id: string): void {
    var next = prefs().listAutoplay && listScreen() === list && !own.busy && !tv.busy ? list.nextAfter(id) : '';
    if (next) {
        list.focusOn(next, true);
        showOnStage(list, next);
    }
}

/** Preloads the focused tile's video for a faster start, and shows its preview */
function preloadFocused(): void {
    clearTimeout(preloadTimer);
    clearTimeout(headerTimer);
    clearTimeout(readyTimer);
    clearTimeout(pageTimer);
    readyTimer = setTimeout(function () { readyFocused(false); }, READY_REST_MS) as unknown as number;
    pageTimer = setTimeout(pageFocused, PAGE_REST_MS) as unknown as number;
    preloadTimer = setTimeout(function () {
        var p = prefs();
        if (own.busy || tv.busy || document.hidden) {
            return;
        }
        // A channel's Play mix: its preview in the banner after YouTube's delay, the header over it, as YouTube's
        var view = screen();
        var header = view instanceof ChannelView ? view.headerPreview() : null;
        if (header) {
            var channel = view as ChannelView;
            var wanted = header;
            if (p.previews !== 'off' && p.channelVideo && !tv.warming) {
                headerTimer = setTimeout(function () {
                    if (own.busy || tv.busy || document.hidden || screen() !== channel || !channel.headerPreview()) {
                        return;
                    }
                    tv.shutDown();
                    channel.previewing(true);
                    preview.show(wanted.id, wanted.frame, p.previews === 'sound' && wanted.sound, { square: true, done: function () { channel.previewing(false); } });
                }, Math.max(0, wanted.delay - PRELOAD_REST_MS)) as unknown as number;
            }
            return;
        }
        var tile = focusedTile();
        readyForFilms(tile);
        // A channel's sub page button (Videos, Shorts, ...): that page, as a page tile's
        var sub = view instanceof ChannelView ? view.focusedPage() : null;
        if (sub) {
            pageReady(sub);
            return;
        }
        // A playlist's preview plays in its frame as its own setting says (not in the tile), its details asked for (not
        // while the screen's pictures are still loading)
        var list = listScreen();
        var frame = list && list.frame;
        var previews = frame ? !!frame.preview() : p.previews !== 'off';
        var waiting = tv.warming || picturesWaiting();
        if (frame && !waiting) {
            frame.details();
        }
        var video = waiting || !p.preload && !previews ? null : tile;
        if (!video || video.page || video.movie) {
            if (video && video.page) {
                pageReady(video.page, knownOf(video));
            }
            return;
        }
        if (p.preload) {
            readyFocused(true);
            if (!own.readyFor(video.id)) {
                preloadVideo(video.id, aheadAt(video), video.channel);
            }
        }
        // A preview, not of the video just closed (OK resumes it), nor of the one a playlist's frame plays on
        var box = focusedFrame();
        if (list && own.leftId !== video.id && !preview.playing(video.id)) {
            showOnStage(list, video.id);
        } else if (!list && previews && box && own.leftId !== video.id) {
            // Release YouTube's app kept for films: the preview needs the decoder
            tv.shutDown();
            preview.show(video.id, box, p.previews === 'sound');
        }
    }, PRELOAD_REST_MS) as unknown as number;
}

/** The focus has rested PAGE_REST_MS: the focused page tile's page, or the page of the channel button in focus (Videos,
 * Live, ...), is fetched and built ahead, or the tiles of the tab in focus fetched, so an OK soon after finds them on
 * their way or ready. Past the requests a minute allowed (what is kept is none) a page waits for the longer rest
 * (preloadFocused), a tab for its OK */
function pageFocused(): void {
    var tile = focusedTile();
    var view = screen();
    if (!prefs().preload || own.busy || tv.busy || tv.warming || document.hidden) {
        return;
    }
    var tab = view instanceof FeedView ? view.focusedTab() : '';
    if (tab) {
        tabAhead(tab);
        return;
    }
    var page = tile && tile.page || (view instanceof ChannelView ? view.focusedPage() : null);
    // (checked here too, not only in pageAhead and buildAhead: no request is counted for what will not be asked)
    if (!page || !isChannel(page) && !keepable(page) || view.opensOwn || built && built.key === builtKey(page) ||
        !mayAskPageAhead(isChannel(page) ? channelKept(page) : pageKept(page))) {
        return;
    }
    pageReady(page, tile ? knownOf(tile) : undefined);
}

/** The focused video tile's video loaded paused and hidden (own.ready), so OK starts it at once: after READY_REST_MS of
 * rest within preload.ts's share of requests, else once the longer rest's preload comes (late). A closed video kept to
 * resume goes for it (not for its own tile: OK resumes it there). Not a live stream (its preload fetches its newest
 * segments), nor while YouTube's player holds the decoder for films */
function readyFocused(late: boolean): void {
    var video = focusedTile();
    // (the screen's pictures checked last: it measures them; the late call comes once preloadFocused found them in)
    if (!prefs().preload || !video || video.page || video.movie || video.live || own.busy || tv.busy || tv.warming || tv.ready ||
        document.hidden || own.readyFor(video.id) || own.leftId === video.id ||
        !late && (picturesWaiting() || !mayAskAhead(video.id))) {
        return;
    }
    var id = video.id;
    own.ready(id, aheadAt(video), function () { return firstStreams(id); }, function () {
        var now = focusedTile();
        return !!now && now.id === id;
    });
}

/** YouTube's app is started and the film preloaded while focus rests on a film tile (only it plays films; from cold,
 * playback takes ~13 s after OK). Released after FILMS_LEFT_MS off films (idle, it holds ~60 MB) or when the app's
 * player plays. Settings: Videos start sooner */
function readyForFilms(tile: Video | null, ahead?: boolean): void {
    var p = prefs();
    clearTimeout(filmTimer);
    if (tv.busy || own.busy || document.hidden) {
        return;
    }
    if (tile && tile.movie && p.preload) {
        tv.start(true);
        if (ahead !== false) {
            tv.preload(tile.id);
        }
    } else if (tv.warming || tv.ready) {
        filmTimer = setTimeout(function () {
            // Still starting: check again later; a film focused again: keep it
            var now = focusedTile();
            if (tv.warming) {
                readyForFilms(now);
            } else if (!(now && now.movie)) {
                tv.shutDown();
            }
        }, FILMS_LEFT_MS) as unknown as number;
    }
}

/** The focused tile's video or page (null: none, or the rail, tile menu or a player has the keys) */
function focusedTile(): Video | null {
    var view = screen();
    return !menuFocused && !tileMenu.shown && !own.busy && !tv.busy && view.focusedVideo ? view.focusedVideo() : null;
}

/** The video tile in focus where holding OK means something (its menu), or null */
function holdTile(): Video | null {
    if (question.shown || promptMade && promptMade.shown) {
        return null;
    }
    var video = focusedTile();
    return video && !video.page ? video : null;
}

/** Whether OK held means something to the screen for what it has focused (Settings: a custom logo's tile) */
function screenHolds(): boolean {
    var s = screen();
    return !question.shown && !(promptMade && promptMade.shown) && !menuFocused && !own.busy && !tv.busy && !tileMenu.shown && !!s.holds && s.holds();
}

/** After every key: only one of rail and screen shows focus */
function updateMenu(): void {
    var view = screen();
    menu.setFocused(menuFocused);
    // As YouTube: the open rail pushes the screen right; Search has a back arrow instead of the rail
    toggleClass(root, 'by-app--rail', menuFocused);
    toggleClass(root, 'by-app--search', current === 'search' && !menuFocused);
    // Pages over a section (History, a playlist, a channel) have no rail either
    toggleClass(root, 'by-app--page', pages.length > 0 && !menuFocused && metrics().ways.pagesOverAll);
    if (view.setFocused) {
        view.setFocused(!menuFocused);
    }
    // In the rail: its neighbours stand by once the focus has rested a moment. Out of it: those standing by for it
    // are let go soon (a page's covered screen keeps its own, longer time)
    clearTimeout(neighboursTimer);
    if (menuFocused) {
        clearTimeout(standTimer);
        neighboursTimer = setTimeout(neighboursBy, NEIGHBOURS_MS) as unknown as number;
    } else if (wasInRail) {
        letGo(STAND_MS);
    }
    wasInRail = menuFocused;
}
/** The rail had the focus at the last updateMenu */
var wasInRail = false;

/** Every screen and page (shown or not) */
function allScreens(): Screen[] {
    var views: Screen[] = [];
    for (var s in sections) {
        views = views.concat(sections[s], pagesOf[s] || []);
    }
    return views;
}

function route(code: number): boolean {
    // (OK held on a question's button presses it: the pointer's long press too)
    if (question.onKey(code === KEY.HOLD ? KEY.OK : code)) {
        return true;
    }
    // Setting a shortcut takes every key, the remote's spare ones too
    if (promptMade && promptMade.onKey(code)) {
        return true;
    }
    // OK held on a video tile opens its menu; elsewhere it acts as OK
    if (code === KEY.HOLD) {
        var video = holdTile();
        if (video) {
            // A video removed (from History, recommendations, a playlist) goes at once from the screen the menu was
            // opened on (others catch up on their next refresh); YouTube refusing it reloads that screen
            var opened = screen();
            openTileMenu(tileMenu, video, { play: play, open: openPage, removed: function (v) {
                if (opened.removeVideo) {
                    opened.removeVideo(v.id);
                }
            }, kept: function () {
                if (opened.reload) {
                    opened.reload();
                }
            } });
            return true;
        }
        // ... or on something of the screen's own (Settings: a custom logo's tile, to remove it)
        var held = screen();
        if (screenHolds() && held.onHold && held.onHold()) {
            return true;
        }
        code = KEY.OK;
    }
    if (tileMenu.shown) {
        tileMenu.onKey(code);
        return true;
    }
    // A shortcut where it works (Settings › Shortcuts): in the app's player, else on the screens (none in YouTube's)
    if (!tv.busy && runShortcut(code)) {
        return true;
    }
    // While a video shows, its player gets the keys; while YouTube's player is still starting, Back cancels it
    if (own.busy) {
        return own.onKey(code);
    }
    if (tv.busy) {
        // Shown: YouTube's player gets the key; Back closes it (as before: its page may not take a made-up Back)
        if (code === KEY.BACK) {
            tv.stop();
        } else if (tv.shown) {
            tv.key(code);
        }
        return true;
    }
    // The remote's voice key (Android TV)
    if (code === KEY.VOICE) {
        voiceSearch();
        return true;
    }
    if (menuFocused) {
        if (menu.onKey(code)) {
            return true;
        }
        // Back in the rail: to the start page, and from there out of the app
        if (code === KEY.BACK) {
            var start = startPage();
            if (current !== start || pages.length) {
                // Drop its pages too (switchSection drops them only for the current section)
                if (current !== start) {
                    dropPages(start);
                }
                switchSection(start);
            } else {
                saveAvatars();
                saveDearrow();
                exitApp();
            }
            return true;
        }
        return false;
    }
    var view = screen();
    if (code === KEY.OK && view.retry && view.retry()) {
        return true;
    }
    if (view.onKey(code)) {
        return true;
    }
    if (code === KEY.BACK && pages.length) {
        closePage();
        return true;
    }
    // Search has no rail (as in YouTube): Back returns to where it was opened from
    if (code === KEY.BACK && current === 'search') {
        leaveSearch();
        return true;
    }
    // In a theme where pages hide the rail, Left does not open it (Back closes the page)
    if (code === KEY.LEFT && pages.length && metrics().ways.pagesOverAll) {
        return true;
    }
    // Left at a screen's left edge, or Back, focuses the rail
    if (code === KEY.LEFT || code === KEY.BACK) {
        menuFocused = true;
        return true;
    }
    return false;
}

/** The shortcut on code where it works now (api/shortcuts.ts): in the app's player, else on the screens; none while
 * something is open over them (it keeps every key: a panel, Live chat settings, a page of Settings' own) or the screen
 * keeps the key (Search's keyboard its numbers), but the comments' own shortcut over the comments (it closes them);
 * false: none */
function runShortcut(code: number): boolean {
    var inPlayer = own.busy;
    var view = screen();
    var s = keyName(code) ? shortcutAt(code, inPlayer ? PLAYER : SCREENS) : null;
    var taken = inPlayer ? !!own.layer() && !(s && s.action === 'comments' && own.commentsOpen) :
        !!(view.layer && view.layer()) || !!view.ownKeys && view.ownKeys(code);
    if (!s || taken) {
        return false;
    }
    if (!inPlayer || !own.act(s.action)) {
        goTo(s);
    }
    return true;
}

/** History, Watch later and Liked videos: their pages */
var YOUR_PAGES: { [action: string]: string } = { history: 'FEhistory', watchLater: 'VLWL', liked: 'VLLL' };

/** A go-to shortcut: Screen off and Subscribe (in the player too, the video playing on), a video played (the last one,
 * a channel's newest, a playlist), or a screen of the rail, a page (History, Watch later, Liked videos, a channel's, a
 * playlist's, a channel's videos), "Who's watching?": from the player the video closes first, as with Back */
function goTo(s: Shortcut): void {
    var parts = s.action.split(':');
    var way = parts[1];
    var t = s.target;
    var page = YOUR_PAGES[s.action];
    var videos = t ? t.videos || t.channel : null;
    if (s.action === 'screenOff') {
        screenOff();
    } else if (s.action === 'subscribe') {
        subscribeShortcut();
    } else if (s.action === 'resume') {
        playLast();
    } else if (page) {
        leaveFor(function () { openPage({ browseId: page }); }, s.action);
    } else if (parts[0] === 'section') {
        leaveFor(function () { switchSection(way); }, '');
    } else if (s.action === 'accounts') {
        leaveFor(openAccounts, '');
    } else if (parts[0] === 'playlist') {
        if (way === 'open') {
            leaveFor(function () { openPage({ browseId: 'VL' + parts[2] }); }, s.action);
        } else {
            playPlaylist(parts[2], way === 'shuffle');
        }
    } else if (t && videos) {
        if (way === 'page' && t.channel) {
            leaveFor(function () { openPage(t!.channel as Page); }, s.action);
        } else if (way === 'newest') {
            playNewest(videos);
        } else {
            leaveFor(function () { openVideos(t!.title, videos as Page); }, s.action);
        }
    }
}

/** Closes the video playing as Back does (kept to resume; not handed to a playlist's frame, the page goes over it),
 * then open() a screen or page with the focus on it. A page (page: its key) opened from the video brings it back on
 * Back; one already on top is not opened again */
var leaving = false;
var shortcutPage: { view: Screen; key: string } | null = null;
function leaveFor(open: () => void, page: string): void {
    var from = '';
    if (own.busy) {
        leaving = true;
        own.leave();
        leaving = false;
        from = own.leftId;
    }
    leaveMenu();
    var top = pages[pages.length - 1];
    if (!page || !shortcutPage || shortcutPage.view !== top || shortcutPage.key !== page) {
        open();
    }
    if (page) {
        shortcutPage = { view: pages[pages.length - 1], key: page };
        if (from) {
            fromPlayer = { view: shortcutPage.view, id: from };
        }
    }
    updateMenu();
}

/** A request for a page failed: said in a toast */
function loadFailed(): void {
    toast(tr('Could not load this page. Try again.'), undefined, PROBLEM);
}

/** The Subscribe shortcut: in the player the video's channel (its details, asked for if not known yet), on the screens
 * the focused video's channel (its details: one request, none if known) or the focused channel */
function subscribeShortcut(): void {
    var flip = function (info: { subscribe: Subscribe | null }, channel: string): void {
        if (info.subscribe) {
            flipSubscription(info.subscribe, channel);
        } else {
            toast(tr('Not possible on this video'), 'info');
        }
    };
    if (own.busy) {
        var details = own.details();
        if (details) {
            flip(details, details.channel);
        } else {
            toast(tr('One moment: the video\'s details are on their way'), 'info');
        }
        return;
    }
    var view = screen();
    var tile = !menuFocused && view.focusedVideo ? view.focusedVideo() : null;
    if (tile && tile.page && isChannel(tile.page)) {
        keptChannel(tile.page).then(function (c) { flip(c, c.title); }, loadFailed);
    } else if (tile && !tile.page) {
        watchInfo(tile.id).then(function (info) { flip(info, info.channel); }, loadFailed);
    } else {
        toast(tr('Rest on a video or a channel first'), 'info');
    }
}

/** The video closed last, where it stopped (kept across starts by own.onClosed; as it was if closed a moment ago) */
var LAST_KEY = 'youtube.lastVideo';
function playLast(): void {
    var video = load<Video>(LAST_KEY);
    var now = own.now;
    if (!video) {
        toast(tr('No video to continue yet'), 'info');
    } else if (!now || now.id !== video.id) {
        play(video);
    }
}

/** The newest video on a channel's page of videos (asked anew) */
function playNewest(p: Page): void {
    page(p).then(function (rows) {
        var video = allVideos(rows).filter(function (v) { return !v.page; })[0];
        if (video) {
            play(video);
        } else {
            toast(tr('No videos from {1} yet.', rows.title), 'info');
        }
    }, loadFailed);
}

/** Plays playlist id from its first video, or shuffled: its first part's videos, as its page's Play all would */
function playPlaylist(id: string, shuffled: boolean): void {
    keptPage({ browseId: 'VL' + id }).then(function (rows) {
        var videos = allVideos(rows).filter(function (v) { return !v.page && !v.movie; });
        if (!videos.length) {
            toast(tr('Nothing here yet.'), 'info');
            return;
        }
        playList(videos, (shuffled ? shuffle(videos) : videos).map(function (v) { return v.id; }), false,
            { title: rows.title, count: rows.side && rows.side.count || 0, videos: videos, id: rows.playlistId || id });
    }, loadFailed);
}

/** A channel's or a playlist's Shortcut button: what its button does (the button each has already under it), then
 * the button (views/shortcuts.ts) */
function askShortcut(kind: string, id: string, target: ShortcutTarget): void {
    tileMenu.open(tr('Shortcut'), wayLines(kind, id, target, shortcutPrompt()), -1);
}

/** A visible screen that failed to load retries by itself, as YouTube's app does: periodically (one request each
 * time), and at once when the network comes back */
var RETRY_MS = 20000;
function retryShown(): void {
    var view = screen();
    if (!document.hidden && view.retry) {
        view.retry(true);
    }
}
setInterval(retryShown, RETRY_MS);
window.addEventListener('online', retryShown);

function tickClock(): void {
    clearTimeout(clockTimer);
    if (document.hidden) {
        return;
    }
    var now = localClock(Date.now());
    menu.setClock(now);
    own.setClock(now);
    // Also each minute: expired replies are let go (no cache holds them through a long video)
    pruneKept();
    clockTimer = setTimeout(tickClock, 60000 - Date.now() % 60000 + 50) as unknown as number;
}

/** A video's picture moves over the screen (YouTube's player: shows over it), or the player closed: its old rows are
 * refetched now, not in the video's start (they swap in while it plays; closed: once out of sight) */
function renewRows(): void {
    var view = screen();
    if (view.cover && view.renewIfOld) {
        view.renewIfOld();
    }
}

/** Refreshes the screen's rows if old (swapped in once out of sight) */
function renewScreen(): void {
    var view = screen();
    if (view && view.renewIfOld) {
        view.renewIfOld();
    }
}

/** In the background (webOS may preload the app hidden at power-on), renews old rows every HIDDEN_RENEW_MS so they
 * are fresh when the app is opened hours later */
function renewWhileHidden(): void {
    clearInterval(hiddenTimer);
    if (document.hidden) {
        hiddenTimer = setInterval(renewScreen, HIDDEN_RENEW_MS) as unknown as number;
    }
}

renewWhileHidden();
document.addEventListener('visibilitychange', function () {
    tickClock();
    renewWhileHidden();
    if (document.hidden) {
        preview.stop();
        saveAvatars();
        saveDearrow();
        // Out of sight: swap in waiting fresh rows
        var view = screen();
        if (view.putFresh) {
            view.putFresh();
        }
        return;
    }
    // Back in front after a while (e.g. TV off overnight)
    renewScreen();
});
// The Magic Remote's pointer as YouTube's app takes it (core/pointer.ts); Android's mouse input is only swallowed
ignorePointer();
if (!android()) {
    initPointer(pressKey, pointerLayer, updateMenu);
}
fadeInImages();
// A failed image leaves its dark frame instead of the broken-image icon
document.addEventListener('error', function (e) {
    var el = e.target as HTMLElement;
    if (el.tagName === 'IMG') {
        toggleClass(el, 'bd-fade--in', false);
    }
}, true);
initKeys();
// OK acts on release; held down, it opens a video tile's menu (as YouTube's TV app)
setHoldOk(true);
/** The tile picture shown pressed while OK is down on it, and the focus ring's edge around it */
var pressedFrame: HTMLElement | null = null;
var pressedRing: HTMLElement | null = null;

/** OK going down on a video tile (its release starts it, a hold opens its menu): it looks pressed at once (not under its
 * preview), and with Videos start sooner its streams are asked now, so the start at the release finds them on their way */
function pressTile(video: Video): void {
    var frame = focusedFrame();
    if (frame && !preview.playing(video.id)) {
        pressedFrame = frame;
        toggleClass(frame, 'by-tile--pressed', true);
        // (the ring gives with it: the tile's row holds it, ui/tile-row.ts)
        var strip = frame.parentNode && frame.parentNode.parentNode as HTMLElement | null;
        pressedRing = strip ? strip.querySelector('.bd-ring-edge') as HTMLElement | null : null;
        if (pressedRing) {
            toggleClass(pressedRing, 'by-tile--pressed', true);
        }
    }
    if (prefs().preload && !video.movie) {
        startSoon(video.id);
    }
}

function unpressTile(): void {
    if (pressedFrame) {
        toggleClass(pressedFrame, 'by-tile--pressed', false);
        pressedFrame = null;
    }
    if (pressedRing) {
        toggleClass(pressedRing, 'by-tile--pressed', false);
        pressedRing = null;
    }
}

/** The video whose preview plays in a playlist's frame ('' none) */
function stagePlaying(): string {
    var list = own.busy ? null : listScreen();
    var id = list && list.frame ? list.frame.shown : '';
    return id && preview.playing(id) ? id : '';
}

/** The focused tile's picture box (null: none) */
function focusedFrame(): HTMLElement | null {
    return screen().el.querySelector('.bd-tile--focused .bd-tile-frame') as HTMLElement | null;
}

/** What is open on top, as the keys go (route): a question, a tile menu, the player's panel, the screen's, the logo's
 * menu, the open rail (a click on the screen beside it closes it, into the screen, as YouTube's guide); the pointer's
 * clicks go to it alone (null: nothing open) */
function pointerLayer(): Layer | null {
    var black = screenLayer();
    if (black) {
        return { el: black };
    }
    if (question.shown) {
        return { el: question.el };
    }
    if (promptMade && promptMade.shown) {
        return { el: promptMade.el };
    }
    var view = screen();
    var el = tileMenu.layer() || (own.busy ? own.layer() : view.layer && view.layer() || menu.openMenu);
    if (el) {
        return { el: el };
    }
    return menuFocused && !own.busy ? { el: menu.el, beside: function () { menu.leave(); } } : null;
}

/** Handles a key (remote, or a casting phone's arrows). Stops the preview; for OK only after it acted, so OK on the
 * previewed tile takes the preview over. A playlist's preview plays on while the arrows go to its buttons and back
 * (Settings › Preview on the buttons) */
function pressKey(code: number): boolean {
    keyCame();
    // The screen off: a key wakes it (any, or only Screen off's button) and does nothing else (a playlist's stage plays on)
    if (screenKey(code)) {
        return true;
    }
    // A shortcut acting where it is (Screen off, Subscribe): the screen left as it is, a tile's preview playing on (no
    // preview stopped, no video made ready: it took the preview's place, starting it over)
    if (staysPut(code)) {
        return route(code);
    }
    unpressTile();
    var kept = stagePlaying();
    if (code !== KEY.OK && !kept) {
        preview.stop();
    }
    cancelPreload();
    var was = focusedTile();
    var handled = route(code);
    // (a playlist's preview plays on for the arrows to its buttons and back, and OK on a button that played nothing:
    // Repeat, Shuffle, Save; Settings › Preview on the buttons)
    var keep = !!kept && (screenIsOff() || prefs().listKeep && stagePlaying() === kept && (code === KEY.OK || code >= KEY.LEFT && code <= KEY.DOWN));
    if (kept && code !== KEY.OK && !keep) {
        preview.stop();
    }
    // A video loaded ahead goes once its tile has lost the focus (a key that moved nothing keeps it, as does its tile
    // drawn again)
    var now = focusedTile();
    if (code !== KEY.OK && (now ? now.id : '') !== (was ? was.id : '')) {
        own.unready();
    }
    // (a page built ahead belongs to what had the focus: a tile, or with none focused a channel of Subscriptions' strip)
    if (code !== KEY.OK && (!now || !was || now.id !== was.id)) {
        dropBuilt();
    }
    if (code === KEY.OK && !keep) {
        preview.stop();
    }
    updateMenu();
    preloadFocused();
    return handled;
}
setActive({ onKey: pressKey });

/** The key is a shortcut that acts where it is (Screen off, Subscribe / unsubscribe) */
function staysPut(code: number): boolean {
    var s = shortcutAt(code, own.busy ? PLAYER : SCREENS);
    return !!s && (s.action === 'screenOff' || s.action === 'subscribe');
}

// OK where holding it means nothing (all but a video tile's menu and what a screen holds: screenHolds) acts as it
// goes down, not at its release: decided by what has the focus then (ahead of keys.ts, which keeps the hold's press),
// the press's repeats and release dropped
var okTaken = '';
var okAt = 0;
var okRepeated = false;
/** The remote's first repeat of a held key comes ~0.5 s after the press, the next every ~0.12 s: an OK later than
 * this (ms) after the one before is a new press (its release was lost: one press at most is taken for a repeat) */
var OK_FIRST_REPEAT_MS = 800;
var OK_REPEAT_MS = 400;
function okFirst(code: number, isUp: boolean): boolean {
    if (code !== KEY.OK) {
        return false;
    }
    var now = Date.now();
    if (isUp) {
        var mine = okTaken === 'now';
        okTaken = '';
        // (also where keys.ts drops the press: its release after a hold was lost)
        unpressTile();
        return mine;
    }
    // A repeat while held: whoever took the press keeps it (a tile menu opened by the hold must not get the repeats)
    if (okTaken && now - okAt < (okRepeated ? OK_REPEAT_MS : OK_FIRST_REPEAT_MS)) {
        okAt = now;
        okRepeated = true;
        return okTaken === 'now';
    }
    okAt = now;
    okRepeated = false;
    var tile = holdTile();
    if (tile || screenHolds()) {
        okTaken = 'hold';
        if (tile) {
            pressTile(tile);
        }
        return false;
    }
    okTaken = 'now';
    pressKey(KEY.OK);
    noteKey(KEY.OK, now);
    return true;
}
['keydown', 'keyup'].forEach(function (type) {
    window.addEventListener(type, function (e: Event) {
        // (a real text field has the keys: core/keys.ts setTyping)
        if (!isTyping() && okFirst((e as KeyboardEvent).keyCode, type === 'keyup')) {
            e.preventDefault();
            e.stopPropagation();
        }
    }, true);
});
// (Android's remote, through keys.ts's bolliKey: initKeys set it above)
var shell = window as unknown as { bolliKey: (code: number, isUp?: boolean) => void };
var shellKey = shell.bolliKey;
shell.bolliKey = function (code: number, isUp?: boolean) {
    if (!okFirst(code, !!isUp)) {
        shellKey(code, isUp);
    }
};
document.addEventListener('visibilitychange', function () {
    okTaken = '';
    unpressTile();
    if (document.hidden) {
        own.unready();
    }
});
// Casting from a phone plays in the app's player (cast.ts); the pairing code comes with a launch or relaunch
var cast = new Cast(own, pressKey, castPlay);

/** Plays a cast video in the app's player over whatever shows, bringing the app to the front. A video already handed
 * to YouTube's player stays there (the app's player could not play it, and the phone resends it when told nothing
 * plays) */
function castPlay(id: string, t: number, queue: ListQueue): void {
    var w = window as unknown as { PalmSystem?: { activate?: () => void } };
    if (document.hidden && w.PalmSystem && w.PalmSystem.activate) {
        w.PalmSystem.activate();
    }
    if (handedOver === id && tv.video === id) {
        return;
    }
    tileMenu.close();
    // An open question would take the player's keys unseen
    question.close();
    if (promptMade) {
        promptMade.close();
    }
    // The screen off: it stays so (music from a phone), or wakes for the video, as Settings › Casting with the screen
    // off says
    if (prefs().castWakes) {
        screenWake();
    }
    preview.stop();
    // Also when idle, so it forgets a video it would resume
    tv.stop();
    own.play(id, '', '', t, queue);
}
cast.launched(launchParams(null));
document.addEventListener('webOSRelaunch', function (e) {
    cast.launched(launchParams((e as CustomEvent).detail));
});
// Keep LG's screensaver away while a video plays, and while the screen is off (Screen off: the sound plays on, or the
// black is wanted as it is)
initScreenSaver(function () {
    return tv.busy || own.busy || screenIsOff();
});
// While a player covers the app, the app is hidden and its pictures released after a while.
// With the app's player, YouTube's app shuts down again after playing what the app's player
// could not (kept while focus is back on a film).
tv.onShown = function (shown) {
    shownOver(shown);
    if (shown) {
        renewRows();
    } else {
        // Do not preload the film just closed again
        readyForFilms(focusedTile(), false);
    }
};
// When the app's player shows, release YouTube's app kept for films (the TV has one video decoder, and memory)
own.onShown = function (shown) {
    shownOver(shown);
    if (shown) {
        tv.shutDown();
    }
};
own.playlistSettings = playerPlaylists;
own.onClosed = function () {
    // Kept for the shortcut that continues it (also after a restart; one that ended: none), stored once the screen is
    // back
    var last = own.lastLeft;
    setTimeout(function () { save(LAST_KEY, last); }, 0);
    // Back on a playlist's page: its focus on the video closed (the list may have played on), which plays on in the frame
    // at once from where it was (the closed video kept loaded)
    var list = listScreen();
    var left = own.leftId;
    if (list && left && !leaving) {
        list.focusOn(left);
        if (own.kept(left)) {
            showOnStage(list, left, true);
        }
    }
    updateMenu();
};
// Progress in the app's player shows on the video's tiles on every screen at once (YouTube's rows update only on
// refresh); only when YouTube records it (History on)
own.onWatched = function (id, progress, t) {
    noteWatched(id, progress, t);
    // Deferred until after the player's update; the tiles are hidden under it
    setTimeout(function () {
        allScreens().forEach(function (view) {
            if (view.setProgress) {
                view.setProgress(id, progress);
            }
        });
    }, 0);
};
/** The video the app's player handed to YouTube's player ('' if none, or once released) */
var handedOver = '';
// Near the end, prefetch the next video (Up next or queue): streams, headers and SponsorBlock segments
own.onAhead = function (video, kept) {
    preloadVideo(video.id, video.start || 0, video.channel, kept);
};
// YouTube's player takes the TV's video decoder, so the app's player releases what it holds
tv.onStart = function () {
    own.release();
};
// The app's player started a video: the covered screen's old rows are refetched (YouTube's player: when it shows)
own.onStarted = renewRows;
own.onPageAhead = pageAhead;
// A video's comments shown: offered to a phone signed in to the same account, as YouTube's TV app does
own.onComments = function (id) { cast.commentsHandoff(id); };
own.onFallback = function (id, t) {
    if (!tv.runs) {
        return false;
    }
    handedOver = id;
    tv.play(id, function () {
        handedOver = '';
        // Shut YouTube's app down again (also if it gave up before showing, without onShown)
        tv.shutDown();
        updateMenu();
    }, t);
    return true;
};
// A channel page opened from the watch page, over the screen the video was picked on (Back resumes the video)
var fromPlayer: { view: View; id: string } | null = null;
own.onPage = function (page) {
    leaveFor(function () { openPage(page); }, page.browseId + (page.params || ''));
};
function shownOver(shown: boolean): void {
    clearTimeout(releaseTimer);
    // The covered screen swaps in fresh rows out of sight (views/videos.ts)
    var view = screen();
    if (view.cover) {
        view.cover(shown);
    }
    if (shown) {
        preview.stop();
        // (nothing stands by under a video: its memory is the player's)
        clearTimeout(neighboursTimer);
        clearTimeout(buildTimer);
        letGo();
        dropBuilt();
        root.style.display = 'none';
        // Release covered pictures, except on the screen Back returns to (so they show at once)
        releaseTimer = setTimeout(function () {
            var keep = screen().el;
            [].forEach.call(root.getElementsByTagName('img'), function (img: HTMLImageElement) {
                var src = img.getAttribute('src');
                if (src && !keep.contains(img)) {
                    img.setAttribute('data-src', src);
                    img.removeAttribute('src');
                    released.push(img);
                }
            });
        }, RELEASE_MS) as unknown as number;
    } else {
        // Restore only those released here (a hidden section restores its own when shown)
        released.forEach(function (img) {
            var src = img.getAttribute('data-src');
            if (src && !img.getAttribute('src')) {
                img.setAttribute('src', src);
                img.removeAttribute('data-src');
            }
        });
        released = [];
        root.style.display = '';
        updateMenu();
        renewRows();
        var waits = parked;
        parked = [];
        waits.forEach(function (look) { look(); });
    }
}
// YouTube's player started (film preload, handed-over video): reset caches only if it runs as another account
// (it reports every start; resetting each time would refetch pages, saves and settings needlessly)
tv.onAccount = function () {
    account().then(function (id) {
        for (var name in feedAccounts) {
            if (feedAccounts[name] !== id) {
                accountChanged();
                return;
            }
        }
    }, function () { return undefined; });
};
// Account picked elsewhere (e.g. in YouTube AdFree, which shares the accounts)
onAccountChange(accountChanged);
debugHooks({
    play: play,
    section: function (id) {
        switchSection(id);
        menuFocused = false;
        updateMenu();
    },
    page: openPage,
    screen: screen,
    focused: function () {
        var view = screen();
        return !menuFocused && view.focusedVideo ? view.focusedVideo() : null;
    },
    own: own,
    tv: tv,
    cast: cast
});
tickClock();
switchSection(startPage());
// The logo's list names the account; a guest gets "Who's watching?"
knowAccount();
updateMenu();
// Once the first screen is drawn and keys rest: the cast receiver, the pages left open and the sections built ahead.
// YouTube's app starts only when needed (a film, or a video nothing else plays: readyForFilms, own.onFallback), since
// its warm-up video holds the TV's video decoder
whenScreenRests(function () {
    // Start the cast receiver once the first screen shows
    cast.start();
    // The player's parts built on first use (the watch page), ahead of the first video
    own.prepare();
    openPages();
    prepareSections(['subscriptions', 'library']);
    prepareNames();
    // The rail's names as YouTube's guide gives them now (asked once a week, and after a language change)
    freshGuideNames().then(function (names) {
        for (var id in BROWSE) {
            var name = names[BROWSE[id].browseId];
            if (name && name !== BROWSE[id].label) {
                BROWSE[id].label = name;
                menu.setLabel(id, name);
            }
        }
    }, function () { return undefined; });
    // Whether a newer version is out: asked once a day, half a minute from here, and told at most once a week by a
    // toast the viewer can see (not under a video, behind another app or on a screen that is off), which says where
    // to get it
    checkVersion(function () {
        return own.busy || tv.busy || document.hidden || screenIsOff();
    }, function (version) {
        toast(android() ? tr('Bolli YouTube {1} is out. Download it from GitHub.', version) :
            tr('Bolli YouTube {1} is out. Update it in the Homebrew Channel.', version), 'info');
    });
    // (and again each time the app comes back on screen: a TV that keeps the app for days starts it only once)
    document.addEventListener('visibilitychange', function () {
        if (!document.hidden) {
            checkAgain();
        }
    });
});

/** Sections built ahead (prepareSections); their account is not checked until they show */
var prepared: { [id: string]: boolean } = {};

/** Builds sections ahead from their stored rows (each takes ~190 ms on first show), one per screen rest; not while a
 * video plays, as it would slow its start */
function prepareSections(ids: string[]): void {
    var id = ids[0];
    if (!id) {
        return;
    }
    if (!own.busy) {
        ids.shift();
        if (!sections[id]) {
            prepared[id] = true;
            (section(id) as SubscriptionsView | LibraryView).prepare();
        }
    }
    whenScreenRests(function () { prepareSections(ids); }, true);
}
