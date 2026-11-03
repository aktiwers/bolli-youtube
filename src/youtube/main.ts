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
// rail goes to the start page, then exits. Debug hooks live in window.__bolli.

import { fadeInImages, h, toggleClass } from '../core/dom.js';
import { initKeys, KEY, setActive, setHoldOk } from '../core/keys.js';
import { initPerf, mark } from '../core/perf.js';
import { exitApp, ignorePointer } from '../core/platform.js';
import { initScreenSaver } from '../core/screensaver.js';
import { localClock } from '../core/time.js';
import { View } from '../core/view.js';
import { PROBLEM, toast } from './ui/toast.js';
import { googleOf, keptProfiles, ownChannel, Profile, profiles, signOut } from './api/accounts.js';
import { saveAvatars } from './api/avatars.js';
import { channelAhead, isChannel } from './api/channel.js';
import { dearrowFetch, dearrowOn, saveDearrow, Wanted } from './api/dearrow.js';
import { first, get, home, keptPage, page, Page, PageButton, pageAhead as fetchPageAhead, Rows, searchAhead as fetchSearchAhead, sized, SubChannel, subscriptions, tapAhead, text, Video } from './api/feed.js';
import { freshGuideNames, guideNames } from './api/guide.js';
import { forgetKept } from './api/kept-pages.js';
import { prefs, reloadPrefs, setPref } from './api/prefs.js';
import { forgetStreams, streams } from './api/streams.js';
import { forgetSaves, run } from './api/watch.js';
import { toastOf } from './api/menu.js';
import { keepRows, keptFor, keptRows } from './api/kept-rows.js';
import { account, identities, Identity, innertube, innertubeAs, isBrand, lastAccount, NO_TOKEN, onAccountChange, useIdentity } from './api/youtube.js';
import { forgetHistorySettings } from './api/account-settings.js';
import { ListQueue, OwnPlayer, startFormats } from './player/own-player.js';
import { pipelineStats } from './player/pipeline.js';
import { offThreadStats } from './api/off-thread.js';
import { forgetPages, openPages } from './api/page-store.js';
import { cancelPreload, preloadVideo } from './player/preload.js';
import { TilePreview } from './player/preview.js';
import { TvApp } from './player/tv-app.js';
import { apply, askToClear } from './ui/account.js';
import { Question } from './ui/question.js';
import { SidePanel } from './ui/side-panel.js';
import { applyTheme, metrics } from './ui/theme.js';
import { openTileMenu } from './ui/tile-menu.js';
import './ui/themes/youtube.js';
import { AccountsView } from './views/accounts.js';
import { SignInView } from './views/signin.js';
import { Rail, RailEntry, RailItem } from './views/rail.js';
import { Cast, launchParams } from './cast.js';
import { SearchView } from './views/search.js';
import { ChannelView, KnownChannel } from './views/channel.js';
import { SettingsView } from './views/settings.js';
import { FeedOptions, FeedTexts, FeedView, KeptFeed, noteWatched, watchedAt } from './views/videos.js';
import { SubscriptionsView } from './views/subscriptions.js';
import { LibraryView } from './views/library.js';

// The build version (filled in by tools/build_app.mjs), exposed on the page
document.documentElement.setAttribute('data-version', '__BOLLI_VERSION__');

initPerf();
mark('start');
var root = document.getElementById('app') as HTMLElement;
var stage = h('div', 'bd-stage');
// Theme first: screens are laid out with its sizes
applyTheme(prefs().theme);
/** Screens that are one YouTube browse page: Library and the topic pages from the TV app's rail (/guide). Films are
 * left out: mostly paid films, which the app's player cannot play */
var BROWSE: { [id: string]: { label: string; browseId: string } } = {
    library: { label: 'Library', browseId: 'FElibrary' },
    gaming: { label: 'Gaming', browseId: 'FEtopics_gaming' },
    podcasts: { label: 'Podcasts', browseId: 'FEtopics_podcasts' },
    music: { label: 'Music', browseId: 'FEtopics_music' },
    movies: { label: 'Movies', browseId: 'FEtopics_movies' },
    sports: { label: 'Sports', browseId: 'FEtopics_sports' }
};
// YouTube's own names for them, as its guide gave them last (Films, Sport where it says so)
var named = guideNames();
for (var browsed in BROWSE) {
    BROWSE[browsed].label = named[BROWSE[browsed].browseId] || BROWSE[browsed].label;
}
// As the TV app's rail: sections, a divider, topics, Settings at the bottom
var RAIL: RailItem[] = [
    { id: 'search', label: 'Search', icon: 'search' },
    { id: 'home', label: 'Home', icon: 'home' },
    { id: 'subscriptions', label: 'Subscriptions', icon: 'subscriptions' },
    { id: 'library', label: BROWSE.library.label, icon: 'library' },
    { id: 'gaming', label: BROWSE.gaming.label, icon: 'gaming', divider: true },
    { id: 'podcasts', label: BROWSE.podcasts.label, icon: 'podcasts' },
    { id: 'music', label: BROWSE.music.label, icon: 'music' },
    { id: 'movies', label: BROWSE.movies.label, icon: 'movies' },
    { id: 'sports', label: BROWSE.sports.label, icon: 'sports' },
    { id: 'settings', label: 'Settings', icon: 'settings', bottom: true }
];
var menu = new Rail(RAIL, function (id) { switchSection(id, true); }, leaveMenu, logoEntries);
/** The screen the app starts on; Back in the rail goes here, then exits */
var startPage = prefs().startPage;
root.appendChild(stage);
root.appendChild(menu.el);
var tv = new TvApp(document.body);
var own = new OwnPlayer(document.body);
/** A video tile's menu (OK held) */
var tileMenu = new SidePanel(document.body);
/** Confirmation dialog over the app (e.g. Sign out) */
var question = new Question(root);
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
var clockTimer = 0;
/** YouTube's TV app starts once the first screen has its pictures and no key was pressed for IDLE_START_MS
 * (START_LATEST_MS at most), or at once when a video is picked: its start blocks this app's thread for seconds,
 * stalling pictures and keys */
var IDLE_START_MS = 2000;
var START_LATEST_MS = 15000;
var lastKeyAt = 0;
/** A video tile focused this long is preloaded (Settings: Videos start sooner; each costs a request and a parse on
 * this app's thread) */
var PRELOAD_REST_MS = 1500;
var preloadTimer = 0;
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
var NO_ACCOUNT = 'No one is signed in. Choose who\'s watching, or add an account: the logo\'s Switch account.';
/** The section Search was opened from (Back returns there) */
var beforeSearch = '';

/** Optional screen hooks used here beyond View's */
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
}

/** A screen of the account's rows (load), stored across starts; name: used in the load-failure message */
function feedSection(id: string, load: () => Promise<Rows>, name: string, empty: string, opts?: FeedOptions): FeedView {
    return new FeedView(yourFeed(id, load), feedTexts(name, empty), openTile, feedOptions(id, opts));
}

function feedTexts(name: string, empty: string): FeedTexts {
    return { empty: empty, noAccount: NO_ACCOUNT, failed: 'Could not load ' + name + '. Press OK to try again.' };
}

/** Page options: full screen with a back arrow when the theme wants it, page buttons, fade-in as rows arrive */
function pageOptions(): FeedOptions {
    return { page: metrics().ways.pagesOverAll ? { back: closePage } : undefined, onButton: pressPageButton, fade: true };
}

/** Section options: rows stored across starts, logo on the start page only */
function feedOptions(id: string, opts?: FeedOptions): FeedOptions {
    var o: FeedOptions = opts || {};
    o.kept = keptFeed(id);
    o.logo = id === startPage;
    return o;
}

/** OK on a channel in Subscriptions opens its channel page; without one, its latest videos as a grid */
function openSubChannel(c: SubChannel): void {
    if (c.channel) {
        openPage(c.channel, { title: c.title, picture: c.picture, fresh: c.fresh });
        return;
    }
    pushPage(new FeedView(function () {
        return keptPage(c.page).then(function (rows) {
            var videos: Video[] = [];
            rows.shelves.forEach(function (s) { videos = videos.concat(s.videos); });
            var next = rows.shelves.length ? rows.shelves[rows.shelves.length - 1].next : '';
            return { title: c.title, next: '', shelves: [{ title: '', videos: videos, grid: true, next: next }] };
        });
    }, feedTexts(c.title, 'No videos from ' + c.title + ' yet.'), openTile, pageOptions()));
}

/** All subscribed channels, A-Z, as round tiles (Subscriptions' All); OK opens one */
function openChannels(list: SubChannel[]): void {
    var byId: { [id: string]: SubChannel } = {};
    var videos: Video[] = list.filter(function (c) { return !c.recent; }).map(function (c) {
        var id = c.page.browseId + (c.page.params || '');
        byId[id] = c;
        return { id: id, title: c.title, channel: '', length: '', info: '', page: c.page, image: c.picture, round: true };
    });
    var rows: Rows = { title: 'All subscriptions', next: '', shelves: [{ title: '', videos: videos, grid: true }] };
    pushPage(new FeedView(function () { return Promise.resolve(rows); }, feedTexts('your subscriptions', 'No subscriptions yet.'),
        function (v) { openSubChannel(byId[v.id]); }, pageOptions()));
}

/** Section id, built on first use */
function section(id: string): Screen {
    if (!sections[id]) {
        var browse = BROWSE[id];
        sections[id] = id === 'search' ? new SearchView(openTile, leaveSearch, searchAhead) :
            id === 'settings' ? new SettingsView(function () { return cast.linkCode(); }, RAIL.filter(function (r) { return !r.bottom; }), question) :
            id === 'home' ? feedSection(id, home, 'Home', 'Nothing on Home yet.', {
                // As YouTube: a search bar (OK goes to Search) and big tiles in the focused row
                onSearch: openSearch,
                onNudge: pressNudge,
                big: metrics().ways.homeBig
            }) :
            id === 'subscriptions' ? new SubscriptionsView(yourFeed(id, subscriptions),
                feedTexts('your subscriptions', 'No videos from your subscriptions.'), openTile,
                feedOptions(id, { refreshMs: SUBSCRIPTIONS_REFRESH_MS }), openSubChannel, openChannels, function (c) {
                    // Focus rested on a channel: prefetch its page so OK opens it at once
                    if (c.channel && prefs().preload) {
                        channelAhead(c.channel, c.fresh);
                    }
                }) :
            id === 'library' ? new LibraryView(yourFeed(id, function () { return page({ browseId: browse.browseId }); }),
                feedTexts('your library', 'Nothing in your library yet.'), openTile, feedOptions(id)) :
            feedSection(id, function () { return page({ browseId: browse.browseId }); }, browse.label,
                'Nothing in ' + browse.label + ' yet.', {
                    // Topic pages have Home's search bar, as in YouTube (Library has none)
                    onSearch: openSearch
                });
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
            screen().show();
        }
        return;
    }
    if (current) {
        screen().hide();
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
    screen().show(rest);
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
        toast('Voice search does not work on this device.', undefined, PROBLEM);
    }
}

/** Back from Search returns to the section it was opened from */
function leaveSearch(): void {
    var to = beforeSearch && beforeSearch !== 'search' ? beforeSearch : startPage;
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
    list.forEach(unstage);
    list.length = 0;
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
            list.splice(at).forEach(unstage);
        }
    }
}

/** Opens a page over the current screen (Back closes it): a channel page (UC…, not a sub page; known: name and avatar
 * to show at once) or any other */
function openPage(p: Page, known?: KnownChannel): void {
    var texts = {
        empty: 'Nothing here yet.',
        noAccount: NO_ACCOUNT,
        failed: 'Could not load this page. Press OK to try again.'
    };
    pushPage(isChannel(p) ? new ChannelView(p, texts, openTile, openPage, pageAhead, openSearch, known) :
        new FeedView(function () { return keptPage(p); }, texts, openTile, pageOptions()));
}

/** A page button (e.g. History's): a filter's choices in the panel (a choice reloads the page filtered), an on/off
 * toggle applied at once (reverted if YouTube rejects it), YouTube's question first (yes: done, page reloaded), or
 * a playlist's Repeat/Shuffle */
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
        apply(toggle, 'on', !toggle.on, toggle.commands[toggle.on ? 1 : 0], function () { view.drawButtons(); }, 'YouTube did not take the change. Try again.');
    } else if (ask) {
        askToClear(question, ask, function () { view.reload(); });
    } else if (b.play) {
        // Repeat or Shuffle: play the page's videos from the first (Repeat loops at the end)
        var videos = view.videos().filter(function (v) { return !v.movie; });
        if (b.play.shuffle) {
            for (var i = videos.length - 1; i > 0; i--) {
                var k = Math.floor(Math.random() * (i + 1));
                var swap = videos[i];
                videos[i] = videos[k];
                videos[k] = swap;
            }
        }
        var first = videos[0];
        if (first) {
            play({ id: first.id, title: first.title, channel: first.channel, length: '', info: '', start: 0, repeat: b.play.loop,
                list: videos.map(function (v) { return v.id; }) });
        }
    }
}

/** Shows view over the current screen (Back closes it) */
function pushPage(view: Screen): void {
    // A tile's preview belongs to its screen
    preview.stop();
    screen().hide();
    pages.push(view);
    stage.appendChild(view.el);
    view.show();
    updateMenu();
}

/** Closes the top page and shows what is under it; for a channel page opened from a video, that video resumes (the
 * app's player keeps it for a minute) */
function closePage(): void {
    preview.stop();
    var view = pages.pop() as Screen;
    view.hide();
    unstage(view);
    screen().show();
    if (fromPlayer && fromPlayer.view === view) {
        var id = fromPlayer.id;
        fromPlayer = null;
        own.comeBack(id);
    }
}

/** OK on a tile: opens a page or plays a video */
function openTile(video: Video): void {
    if (video.page) {
        openPage(video.page, video.round && video.image ? { title: video.title, picture: video.image } : undefined);
    } else {
        play(video);
    }
}

/** An account feed loader (null for a guest); records the account and stores the rows for the next start */
function yourFeed(name: string, load: () => Promise<Rows>): () => Promise<Rows | null> {
    return function () {
        return account().then(function (id) {
            feedAccounts[name] = id;
            // A guest ("Who's watching?" asks: knowAccount)
            if (!id) {
                return null;
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
    forgetSaves();
    forgetKept();
    forgetPages();
    forgetHistorySettings();
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

/** Runs then once the current screen has its rows and visible pictures and no key was pressed for IDLE_START_MS;
 * after START_LATEST_MS at most (patient: no limit) */
function whenScreenRests(then: () => void, patient?: boolean): void {
    var since = Date.now();
    /** When the screen was first seen fully drawn (0: not yet) */
    var drawnAt = 0;
    (function look(): void {
        var now = Date.now();
        var view = sections[current];
        if (!drawnAt && view.settled !== false && !picturesWaiting()) {
            drawnAt = now;
        }
        var restsAt = drawnAt ? Math.max(drawnAt, lastKeyAt) + IDLE_START_MS : 0;
        if (drawnAt && now >= restsAt || !patient && now - since > START_LATEST_MS) {
            then();
        } else {
            setTimeout(look, drawnAt ? Math.max(100, restsAt - now) : 100);
        }
    })();
}

/** Number of visible tile pictures not loaded yet (including ones without a src yet) */
function picturesWaiting(): number {
    return [].filter.call(stage.querySelectorAll('.bd-tile img'), function (img: HTMLImageElement) {
        var at = img.getBoundingClientRect();
        return at.width > 0 && at.top < window.innerHeight && at.left < window.innerWidth && !(img.getAttribute('src') && img.complete);
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

/** Looks up the current account (stored name and picture; if unknown, requested once per run); for a guest, opens
 * "Who's watching?" */
function knowAccount(): void {
    keptProfiles().then(function (list) {
        me = list[0] && list[0].current ? list[0] : null;
        if (!me) {
            askAccount();
        } else if (!me.name && !namesAsked[me.key]) {
            namesAsked[me.key] = true;
            profiles().then(function (fresh) { me = fresh[0] && fresh[0].current ? fresh[0] : null; }, function () { return undefined; });
        }
    }, function () { return undefined; });
}

/** The logo's list: the account ("Your channel", Sign out), Switch account, Restart app (Settings is at the rail's
 * bottom, as in YouTube) */
function logoEntries(): RailEntry[] {
    var p = me;
    var list: RailEntry[] = [];
    if (p) {
        list.push({ label: p.name || 'Your account', picture: sized(p.picture, RAIL_PICTURE_PX), entries: [
            { label: 'Your channel', action: function () { openOwnChannel(p!); } },
            { label: 'Sign out', action: function () { askSignOut(p!); } }
        ] });
    }
    list.push({ label: 'Switch account', action: openAccounts });
    list.push({ label: 'Restart app', action: function () { saveAvatars(); saveDearrow(); window.location.reload(); } });
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
            useIdentity(p.identity).then(switched);
        }
    }, function () {
        signInView = signInView || new SignInView(signedIn);
        takeOut(signInView);
        pushPage(signInView);
    });
    // If open in another section, move it here; focus starts on the current account, as in YouTube
    takeOut(accountsView);
    accountsView.focusOn(null);
    pushPage(accountsView);
}

/** After a sign-in: with brand accounts, reopen "Who's watching?" with a brand account focused to pick one (as
 * YouTube's app does; a plain Google account may have an empty Home); otherwise use the account at once */
function signedIn(identity: Identity): void {
    toast('Signed in', 'check');
    keptProfiles().then(function (list) {
        var its = list.filter(function (p) { return p.identity.ownerObfuscatedGaiaId === identity.ownerObfuscatedGaiaId; });
        if (its.length < 2) {
            useIdentity(identity).then(switched);
            return;
        }
        var brand = its.filter(function (p) { return isBrand(p.identity); })[0];
        var key = (brand || its[0]).key;
        // If the user left the sign-in meanwhile, reopen Who's watching?
        if (screen() === signInView) {
            (accountsView as AccountsView).focusOn(key);
            closePage();
        } else {
            openAccounts();
            (accountsView as AccountsView).focusOn(key);
        }
    }, function () {
        useIdentity(identity).then(switched);
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
    if (current === startPage) {
        screen().show();
    } else {
        switchSection(startPage);
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
            toast('This account has no channel.');
        }
    }, function () {
        toast('YouTube did not answer. Try again.', undefined, PROBLEM);
    });
}

/** Signs out after YouTube's question: the Google account with its brand accounts (also in YouTube's own app, which
 * shares them); then uses the most recent remaining account, or a guest */
function askSignOut(p: Profile): void {
    keptProfiles().then(function (list) {
        var google = googleOf(p, list);
        question.open({
            title: 'Sign out?',
            subtitle: (google.name || 'This account') + ' and its channels will be signed out on this TV, in YouTube\'s own app too.',
            picture: google.picture, round: true, yes: 'Sign out', no: 'Cancel'
        }, function () {
            signOut(google).then(keptProfiles).then(function (left) {
                toast('Signed out' + (google.name ? ' of ' + google.name : ''), 'check');
                return (left.length ? useIdentity(left[0].identity) : Promise.resolve()).then(switched);
            }, function () {
                toast('Could not sign out. Try again.', undefined, PROBLEM);
            });
        });
    });
}

/** A button of YouTube's nudge shown instead of Home's rows (watch history off: "Turn on history"): sends its command,
 * after YouTube's question if any, and toasts YouTube's reply; reloads Home on a change, or hides the nudge when told */
function pressNudge(command: any, view: FeedView): void {
    var ask = first(command, 'confirmDialogRenderer');
    var send = function (c: any, done: () => void): void {
        run(c).then(function () {
            var said = text(get(first(c, 'overlayMessageRenderer'), 'title')) || toastOf(c);
            if (said) {
                toast(said, 'check');
            }
            done();
        }, function () {
            toast('YouTube did not take that. Try again.', undefined, PROBLEM);
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
        yes: text(get(ask, 'confirmButton', 'buttonRenderer', 'text')), no: text(get(ask, 'cancelButton', 'buttonRenderer', 'text')) || 'Cancel'
    }, function () {
        send(get(ask, 'confirmButton', 'buttonRenderer', 'serviceEndpoint'), function () { view.reload(); });
    });
}

/** Plays video in the player chosen in Settings, over the app; Back returns here. Starts from the tile preview's
 * position when further than the tile's own start */
function play(video: Video): void {
    // Films play only in YouTube's player (a toast says so)
    var bolli = !video.movie;
    // Release YouTube's app kept for films (ready or starting): the app's player needs the decoder and memory
    if (bolli) {
        tv.shutDown();
    }
    // The player takes over this video's playing preview; any other preview stops (its position is kept)
    if (!bolli || !preview.playing(video.id)) {
        preview.stop();
    }
    // Resume where it stopped here, else YouTube's resume point (or the preview's position)
    var here = watchedAt(video.id);
    var t = Math.max(here >= 0 ? here : video.start || 0, preview.from(video.id));
    if (bolli) {
        // A video closed a moment ago (e.g. Back by mistake) resumes as it was, with its play list if any
        var queue = video.list ? new ListQueue(video.list, video.id, video.repeat) : null;
        if (!own.comeBack(video.id, queue || undefined)) {
            own.play(video.id, video.title, video.channel, t, queue);
        }
        // A taken-over preview now belongs to the player
        preview.stop();
        return;
    }
    var ready = tv.ready;
    // Free the TV's decoder held by the app's player
    own.release();
    if (!tv.play(video.id, updateMenu, t, video.movie)) {
        return;
    }
    toast('Movies can only play in YouTube\'s player, so it opens there' + (ready ? '' : ' (starting it)'), 'info');
}

/** Preloads the focused tile's video for a faster start, and shows its preview */
function preloadFocused(): void {
    clearTimeout(preloadTimer);
    clearTimeout(headerTimer);
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
            if (p.previews !== 'off' && !tv.warming) {
                headerTimer = setTimeout(function () {
                    if (own.busy || tv.busy || document.hidden || screen() !== channel || !channel.headerPreview()) {
                        return;
                    }
                    tv.shutDown();
                    channel.previewing(true);
                    preview.show(wanted.id, wanted.frame, p.previews === 'sound' && wanted.sound, true, function () { channel.previewing(false); });
                }, Math.max(0, wanted.delay - PRELOAD_REST_MS)) as unknown as number;
            }
            return;
        }
        var tile = focusedTile();
        readyForFilms(tile);
        // Not while the screen's pictures are still loading
        var video = tv.warming || !p.preload && p.previews === 'off' || picturesWaiting() ? null : tile;
        if (!video || video.page || video.movie) {
            if (video && video.page) {
                pageAhead(video.page);
            }
            return;
        }
        if (p.preload) {
            preloadVideo(video.id, video.start || 0, video.channel);
        }
        // A preview, not of the video just closed (OK resumes it)
        var frame = screen().el.querySelector('.bd-tile--focused .bd-tile-frame') as HTMLElement | null;
        if (p.previews !== 'off' && frame && own.leftId !== video.id) {
            // Release YouTube's app kept for films: the preview needs the decoder
            tv.shutDown();
            preview.show(video.id, frame, p.previews === 'sound');
        }
    }, PRELOAD_REST_MS) as unknown as number;
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
        tv.start();
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

/** The focused tile's video (null: none, a page tile, or the rail, tile menu or a player has the keys) */
function focusedVideo(): Video | null {
    var video = focusedTile();
    return video && !video.page ? video : null;
}

/** The focused tile's video or page (null: none, or the rail, tile menu or a player has the keys) */
function focusedTile(): Video | null {
    var view = screen();
    return !menuFocused && !tileMenu.shown && !own.busy && !tv.busy && view.focusedVideo ? view.focusedVideo() : null;
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
}

/** Every screen and page (shown or not) */
function allScreens(): Screen[] {
    var views: Screen[] = [];
    for (var s in sections) {
        views = views.concat(sections[s], pagesOf[s] || []);
    }
    return views;
}

/** A video removed via its tile menu (from History, recommendations, a playlist): its tiles go at once from the screen
 * the menu was opened on (other screens catch up on their next refresh) */
function removedVideo(video: Video, view: Screen): void {
    if (view.removeVideo) {
        view.removeVideo(video.id);
    }
}

/** YouTube rejected the removal: reload that screen to bring the tile back */
function keptVideo(view: Screen): void {
    if (view.reload) {
        view.reload();
    }
}

function route(code: number): boolean {
    if (question.onKey(code)) {
        return true;
    }
    // OK held on a video tile opens its menu; elsewhere it acts as OK
    if (code === KEY.HOLD) {
        var video = focusedVideo();
        if (video) {
            var opened = screen();
            openTileMenu(tileMenu, video, { play: play, open: openPage, removed: function (v) { removedVideo(v, opened); }, kept: function () { keptVideo(opened); } });
            return true;
        }
        code = KEY.OK;
    }
    if (tileMenu.shown) {
        tileMenu.onKey(code);
        return true;
    }
    // While a video shows, its player gets the keys; while YouTube's player is still starting, Back cancels it
    if (own.busy) {
        return own.onKey(code);
    }
    if (tv.busy) {
        if (code === KEY.BACK) {
            tv.stop();
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
            if (current !== startPage || pages.length) {
                // Drop its pages too (switchSection drops them only for the current section)
                if (current !== startPage) {
                    dropPages(startPage);
                }
                switchSection(startPage);
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
    menu.setClock(localClock(Date.now()));
    clockTimer = setTimeout(tickClock, 60000 - Date.now() % 60000 + 50) as unknown as number;
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

document.addEventListener('visibilitychange', tickClock);
renewWhileHidden();
document.addEventListener('visibilitychange', function () {
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
ignorePointer();
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
/** Handles a key (remote, or a casting phone's arrows). Stops the preview; for OK only after it acted, so OK on the
 * previewed tile takes the preview over */
function pressKey(code: number): boolean {
    lastKeyAt = Date.now();
    if (code !== KEY.OK) {
        preview.stop();
    }
    cancelPreload();
    var handled = route(code);
    if (code === KEY.OK) {
        preview.stop();
    }
    updateMenu();
    preloadFocused();
    return handled;
}
setActive({ onKey: pressKey });
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
    preview.stop();
    // Also when idle, so it forgets a video it would resume
    tv.stop();
    own.play(id, '', '', t, queue);
}
cast.launched(launchParams(null));
document.addEventListener('webOSRelaunch', function (e) {
    cast.launched(launchParams((e as CustomEvent).detail));
});
// Keep LG's screensaver away while a video plays
initScreenSaver(function () {
    return tv.busy || own.busy;
});
// While a player covers the app, the app is hidden and its pictures released after a while.
// With the app's player, YouTube's app shuts down again after playing what the app's player
// could not (kept while focus is back on a film).
tv.onShown = function (shown) {
    shownOver(shown);
    if (!shown) {
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
own.onClosed = updateMenu;
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
own.onPageAhead = pageAhead;
// A video's comments shown: offered to a phone signed in to the same account, as YouTube's TV app does
own.onComments = function (id) { cast.commentsHandoff(id); };
own.onFallback = function (id, t) {
    handedOver = id;
    tv.play(id, function () {
        handedOver = '';
        // Shut YouTube's app down again (also if it gave up before showing, without onShown)
        tv.shutDown();
        updateMenu();
    }, t);
};
// A channel page opened from the watch page, over the screen the video was picked on (Back resumes the video)
var fromPlayer: { view: View; id: string } | null = null;
own.onPage = function (page) {
    var id = own.leftId;
    openPage(page);
    fromPlayer = id ? { view: pages[pages.length - 1], id: id } : null;
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
// Debug hooks for DevTools on window.__bolli; async results go to __bolli.reply
var debug = (window as unknown as { __bolli: { [name: string]: unknown } }).__bolli;
// play(id, t?): plays a video as OK on its tile does (t: start in seconds)
debug.play = function (id: string, t?: number): void {
    play({ id: id, title: id, channel: '', length: '', info: '', start: t });
};
// own: the app's player
debug.own = own;
// tv: YouTube's TV app hidden in this one (player/tv-app.ts)
debug.tv = tv;
debug.pipes = pipelineStats;
debug.offThread = offThreadStats;
debug.cast = cast;
// streams(id): the formats the app's player gets for a video (no URLs)
debug.streams = function (id: string): void {
    debug.reply = null;
    forgetStreams(id);
    streams(id).then(function (s) {
        debug.reply = { videos: s.videos.map(function (f) { return f.itag + ' ' + f.height + 'p ' + f.mime; }), audios: s.audios.length, start: !!startFormats(s), paid: s.paid || null };
    }, function (e) { debug.reply = { error: e }; });
};
// section(id): shows a section as the rail does, focused
debug.section = function (id: string): void {
    switchSection(id);
    menuFocused = false;
    updateMenu();
};
// innertubeAs(n, endpoint, body): an InnerTube request as the n-th signed-in account
debug.innertubeAs = function (n: number, endpoint: string, body: { [key: string]: unknown }): void {
    debug.reply = null;
    identities().then(function (got) { return innertubeAs(got.list[n], endpoint, body); })
        .then(function (r) { debug.reply = r; }, function (e) { debug.reply = { error: String(e) }; });
};
// prefs(), setPref(name, value), reloadPrefs(): read, change and reload the settings (used by tests)
debug.prefs = prefs;
debug.setPref = setPref;
debug.reloadPrefs = reloadPrefs;
// toast(text, icon): shows a toast
debug.toast = toast;
// innertube(endpoint, body): an InnerTube request as the app makes it (signed in)
debug.innertube = function (endpoint: string, body: { [key: string]: unknown }): void {
    debug.reply = null;
    innertube(endpoint, body).then(function (r) { debug.reply = r; }, function (e) { debug.reply = { error: String(e) }; });
};
// page(browseId, params?): opens a page as OK on its tile does; screen(): the visible view; focused(): the focused tile
debug.page = function (browseId: string, params?: string): void {
    openPage(params ? { browseId: browseId, params: params } : { browseId: browseId });
};
debug.screen = screen;
debug.focused = function (): unknown {
    var view = screen();
    var video = !menuFocused && view.focusedVideo ? view.focusedVideo() : null;
    return video ? { id: video.id, page: video.page || null } : null;
};
// ask(endpoint, body): same as innertube
debug.ask = function (endpoint: string, body: { [key: string]: unknown }): void {
    debug.reply = null;
    innertube(endpoint, body).then(function (r) { debug.reply = r; }, function (e) { debug.reply = { error: String(e) }; });
};
tickClock();
switchSection(startPage);
// The logo's list names the account; a guest gets "Who's watching?"
knowAccount();
updateMenu();
// Once the first screen is drawn and keys rest: the cast receiver, the pages left open and the sections built ahead.
// YouTube's app starts only when needed (a film, or a video nothing else plays: readyForFilms, own.onFallback), since
// its warm-up video holds the TV's video decoder
whenScreenRests(function () {
    // Start the cast receiver once the first screen shows
    cast.start();
    openPages();
    prepareSections(['subscriptions', 'library']);
    // The rail's names as YouTube's guide gives them now (asked once a week)
    freshGuideNames().then(function (names) {
        for (var id in BROWSE) {
            var name = names[BROWSE[id].browseId];
            if (name && name !== BROWSE[id].label) {
                BROWSE[id].label = name;
                menu.setLabel(id, name);
            }
        }
    }, function () { return undefined; });
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
