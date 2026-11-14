// The app's entry on the TV's home screen (webOS): its logo, its name and its tile's colour, as set in Settings ›
// Look (prefs homeIcon, homeName, homeColor). webOS can point an app's entry at another picture file, name and colour
// (updateLaunchPoint), keeps that over restarts, and puts the package's back at an update: so the app asks when a
// choice is made, and again once the first rows are drawn at a start unless the package's own were never left.
//
// Two ways lead to that call (found on the webOS 4.0 and 5.0 emulators, 2026-11-13; their READMEs' "Home screen
// entry: routes"). The app's own call: webOS 3 takes it, webOS 4 and 5 refuse it ("Denied method call"). As root,
// where the TV is rooted and the Homebrew Channel has root (ui/app-files.ts asRoot): luna-send run by its service.
// The own call goes first, as it costs next to nothing and its refusal is told at once; the way that worked is kept
// with what was given, and goes first from then on. A root command starts a process on the TV: at a start it is only
// run after an update (the app's version is another than the one the entry was given at), since nothing else puts
// the package's entry back. The entry reaches the root shell as base64 alone (the name is the viewer's own text).
// After a choice, root's way reads the entry back (listLaunchPoints); the own call's yes is the TV's word.
//
// A choice the TV did not take is put back to what it shows, and whoever listens (onHomeRefused: Settings) is told
// why (NO_CHANNEL: the own call is refused and the TV has no Homebrew Channel; NO_ROOT: it has one without root;
// NO_ENTRY: anything else), to say so. The choice itself is made at once (its tick does not wait for the TV); the
// refusal comes after. At a start nothing is said; choices no TV ever took (made in a version that did not tell) are put
// back then, so that Settings shows what the home screen does and later starts ask nothing.
//
// Only a file works as the picture: an address draws an empty tile, and a data URL takes the TV's home screen
// process down (every app closes), so the TV is never handed one. Each built-in logo has its icon files in the app's
// folder (ui/logo.ts iconBase). A custom logo (ui/custom-logos.ts: one set with the app's own logo) is made into two
// files there when it is chosen: drawn into 130 and 80 px squares (ui/pictures.ts) and written by ui/app-files.ts,
// one writing at a time, each under new file names (the home screen keeps a picture it has shown under its path).
// The entry is pointed at them once they are written; the files it showed before are emptied only after the TV took
// the new ones. A TV that cannot write files keeps a built-in logo.
//
// Android takes an app's picture and name on the home screen from its package alone. The Android app has one entry
// there for each built-in logo (android/: the YouTube flavour's manifest) and shows one of them: so Settings offers
// the logo there, among the built-in ones the shell names, and neither a custom one, the name nor the colour. The
// shell is told the choice when it is made and once at each start, and switches its entry once the app is off the
// screen (switched while it shows, Android would close the app).

import { lunaAsk } from '../core/luna.js';
import { android } from '../core/platform.js';
import { load, save } from '../core/store.js';
import { Choice, prefs, setPref } from '../api/prefs.js';
import { tr } from '../core/i18n.js';
import { appId, asRoot, blank, folder, NO_CHANNEL, NO_FILE, NO_ROOT, sized, writePngs } from './app-files.js';
import { addChoice, addCustomLogo, customChoice, CustomLogo, customLogos, customOf, customValue, isCustom, onCustomRemoved, removeCustomLogo } from './custom-logos.js';
import { iconBase, logoFile, LOGOS } from './logo.js';
import { loaded, squares } from './pictures.js';

/** The package's own name and tile colour (appinfo.json's title and iconColor) */
export var APP_NAME = 'Bolli YouTube';
export var APP_COLOR = '#0d0d12';
/** The longest name taken */
export var NAME_MAX = 30;

var MANAGER = 'luna://com.webos.applicationManager/';
var ENTRY = MANAGER + 'updateLaunchPoint';
/** A call of the application manager's as a root command, its one reply printed */
var SEND = 'luna-send -n 1 ' + MANAGER;
/** Why the TV's entry was not changed, when root's way says no more (NO_CHANNEL, NO_ROOT) */
export var NO_ENTRY = 'no entry';
/** The ways to the entry: the app's own call, and root's */
var OWN = 'own';
var ROOT = 'root';
/** The app's version (written in by the build) */
var VERSION = '__BOLLI_VERSION__';
/** What the TV's entry was last given, kept (null: the package's own, never changed): the choice it stood for, its
 * icon files' name without size and ending, the way it was given by and the app's version then. A start then asks
 * again. */
var GIVEN_KEY = 'youtube.home';
/** The custom icon files: the number in the newest ones' names (never given again), which custom logo they hold (0:
 * none any more), and the numbers of earlier ones not emptied yet */
var FILES_KEY = 'youtube.home.files';
/** An icon's sizes, each with the box its picture is fitted into (the built-in icons' own margins) */
var SIZES = [{ px: 130, inner: 112 }, { px: 80, inner: 70 }];

interface Given {
    key: string;
    files: string;
    way?: string;
    at?: string;
}

/** A home screen entry as the application manager takes it */
interface Entry {
    launchPointId: string;
    icon: string;
    largeIcon: string;
    title: string;
    iconColor: string;
}

interface Files {
    n: number;
    custom: number;
    old: number[];
}

/** What was asked of the TV this run ('' nothing yet); that nothing needs asking (asked already, or the package's
 * own, never left: nothing computed and no storage read at each screen drawn); the latest choice of a logo (an
 * earlier one's late files are dropped); the writing in turn; and that root's way is this TV's (it gave the entry
 * last, or the own call was refused this run): it goes first, for the icon files too */
var asked = '';
var settled = false;
var choosing = 0;
var writing: Promise<unknown> = Promise.resolve();
var rooted = false;
/** Who is told that the TV did not take a choice just made (Settings) */
var refusedTo: ((e: Error) => void) | null = null;

/** tell is called when the TV did not take a choice just made of the home screen's logo, name or colour (e.message:
 * NO_CHANNEL, NO_ROOT or NO_ENTRY), the choices already back to what the TV shows */
export function onHomeRefused(tell: (e: Error) => void): void {
    refusedTo = tell;
}

/** Whether the TV has a home screen entry the app can change (Settings offers its logo, name and colour only then) */
export function hasHomeScreen(): boolean {
    return !!appId();
}

/** The built-in logos the Android app can show on the home screen, by id (none on webOS, or in a shell built before
 * it had an entry for each). Asked of the shell once: they are the manifest's entries, the same for the whole run,
 * and Settings asks for them at every key */
var logos: string[] | null = null;
function androidLogos(): string[] {
    if (!logos) {
        var shell = android();
        var ids = shell && shell.homeLogos ? shell.homeLogos() : '';
        logos = ids ? ids.split(',') : [];
    }
    return logos;
}

/** Whether the Android app can change its logo on the home screen (Settings then offers that logo alone) */
export function hasHomeLogos(): boolean {
    return androidLogos().length > 0;
}

function files(): Files {
    var kept = load<Files>(FILES_KEY);
    return kept && kept.n > 0 ? { n: kept.n, custom: kept.custom || 0, old: kept.old instanceof Array ? kept.old : [] } : { n: 0, custom: 0, old: [] };
}

function named(n: number): string {
    return 'icon-custom-' + n;
}

/** The files written for custom logo c, their name without size and ending ('' none: never written, or the newest
 * files hold another one) */
function customFiles(c: CustomLogo): string {
    var kept = files();
    return kept.custom === c.id ? named(kept.n) : '';
}

/** The custom logo chosen for the home screen (null: a built-in one, or one that is gone or has no picture kept) */
function chosenCustom(): CustomLogo | null {
    var c = customOf(prefs().homeIcon);
    return c && c.data ? c : null;
}

/** The built-in logo chosen for the home screen (the first for none, or one not listed) */
function chosenLogo(): typeof LOGOS[0] {
    var id = prefs().homeIcon;
    return LOGOS.filter(function (one) { return one.id === id; })[0] || LOGOS[0];
}

/** Home screen logo's choices in Settings, each a tile with its picture: the built-in logos, the custom ones that
 * have a picture kept, and the tile that adds one; on Android the built-in logos its shell has an entry for */
export function homeIconChoices(): Choice[] {
    var shells = androidLogos();
    var builtIn = LOGOS.filter(function (one) { return !shells.length || shells.indexOf(one.id) >= 0; }).map(function (one) {
        return { value: one.id, name: one.name, note: '', picture: logoFile(one) } as Choice;
    });
    return shells.length ? builtIn : builtIn.concat(customLogos().filter(function (c) { return !!c.data; }).map(customChoice), addChoice());
}

/** The logo chosen, as Settings shows it: a custom one only while it is there (never on Android), else the built-in
 * one by its id (the first for one not listed) */
export function shownHomeIcon(): string {
    var c = hasHomeLogos() ? null : chosenCustom();
    return c ? customValue(c) : chosenLogo().id;
}

/** The chosen logo's picture, as the tile colour's choices show it on each colour */
export function homeLogoPicture(): string {
    var c = chosenCustom();
    return c ? c.data : logoFile(chosenLogo());
}

/** The name chosen (the package's own for none) */
export function homeName(): string {
    return prefs().homeName || APP_NAME;
}

/** The tile colour chosen ('' the package's own; one that is no #rrggbb counts as none) */
export function homeColor(): string {
    var color = prefs().homeColor || '';
    return /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : '';
}

/** #rrggbb of a hue (degrees), saturation and lightness (0..1) */
function hsl(h: number, s: number, l: number): string {
    var part = function (n: number): string {
        var k = (n + h / 30) % 12;
        var v = Math.round(255 * (l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
        return (v < 16 ? '0' : '') + v.toString(16);
    };
    return '#' + part(0) + part(8) + part(4);
}

/** The columns of the tile colour's grid: its first row the package's own and greys from black to white, then twelve
 * hues across in four shades, light to deep */
export var COLOR_COLUMNS = 12;
var GREYS = ['#000000', '#1a1a1a', '#333333', '#4d4d4d', '#666666', '#808080', '#999999', '#b3b3b3', '#cccccc', '#e6e6e6', '#ffffff'];
var SHADES = [[0.85, 0.72], [0.85, 0.55], [0.8, 0.38], [0.75, 0.22]];

/** Tile colour's choices in Settings: tiles of the colours themselves */
export function homeColorChoices(): Choice[] {
    var list: Choice[] = [{ value: '', name: tr('The app\'s own'), note: '', color: APP_COLOR }];
    GREYS.forEach(function (grey) { list.push({ value: grey, name: '', note: '', color: grey }); });
    SHADES.forEach(function (shade) {
        for (var i = 0; i < COLOR_COLUMNS; i++) {
            var color = hsl(i * 30, shade[0], shade[1]);
            list.push({ value: color, name: '', note: '', color: color });
        }
    });
    return list;
}

/** Gives the TV's home screen the chosen logo, name and colour, once per run and choice: when one is chosen, and
 * once the first screen's rows are drawn (an update put the package's back) unless the package's own were never
 * left. A custom logo whose files are gone (the app removed and installed anew) is written again from its kept
 * picture; one that cannot be: the first logo's icon. A TV that refuses keeps what it shows. */
export function homeScreen(): void {
    ask(false);
}

/** homeScreen; told: a choice was just made (quiet: by the app itself). The TV not taking it then puts the choices
 * back to what it shows, and unless quiet says so (onHomeRefused). */
function ask(told: boolean, quiet?: boolean): void {
    var shell = android();
    if (shell) {
        // Android: the shell is told the chosen logo, once per run and choice (it shows it once the app is off the
        // screen, and does nothing where it shows it already)
        var id = chosenLogo().id;
        if (shell.setHomeLogo && id !== asked && androidLogos().indexOf(id) >= 0) {
            asked = id;
            shell.setHomeLogo(id);
        }
        return;
    }
    var app = settled ? '' : appId();
    if (!app) {
        return;
    }
    // (asked from here on, or nothing to ask: the next screens drawn come no further than the lines above)
    settled = true;
    var c = chosenCustom();
    var one = c ? LOGOS[0] : chosenLogo();
    var name = (prefs().homeName || '').slice(0, NAME_MAX);
    var color = homeColor();
    var key = (c ? customValue(c) : one.id) + '|' + name + '|' + color;
    var own = !c && one === LOGOS[0] && !name && !color;
    var given = key === asked ? null : load<Given>(GIVEN_KEY);
    // (asked this run already; or the package's own, asked for only if another was given before, kept or asked this
    // run)
    if (key === asked || (own && !asked && !given)) {
        return;
    }
    if (given && given.way === ROOT) {
        rooted = true;
        // (at a start: what root gave stands until an update)
        if (!told && !asked && given.key === key && given.at === VERSION) {
            asked = key;
            return;
        }
    }
    asked = key;
    var dir = folder();
    var give = function (base: string): void {
        // (a choice made since: its own asking is on its way)
        if (asked !== key) {
            return;
        }
        var entry: Entry = { launchPointId: app + '_default', icon: dir + base + '-80.png', largeIcon: dir + base + '-130.png', title: name || APP_NAME,
            iconColor: color || APP_COLOR };
        var took = function (way: string): void {
            save(GIVEN_KEY, own ? null : { key: key, files: base, way: way, at: VERSION });
            emptyOld(base);
        };
        var byOwn = function (): Promise<void> {
            return lunaAsk(ENTRY, entry).then(function () { took(OWN); }, function () {
                rooted = true;
                throw new Error(NO_ENTRY);
            });
        };
        var byRoot = function (): Promise<void> {
            return asRoot(SEND + 'updateLaunchPoint "$(echo ' + base64(JSON.stringify(entry)) + ' | base64 -d)"').then(function (out) {
                if (!saysYes(out)) {
                    throw new Error(NO_ENTRY);
                }
                // (after a choice: read back. Not readable: the TV's yes stands)
                return told ? asRoot(SEND + 'listLaunchPoints \'{}\'').then(function (list) {
                    if (differs(list, entry)) {
                        throw new Error(NO_ENTRY);
                    }
                }, function () { return undefined; }) : undefined;
            }).then(function () { took(ROOT); });
        };
        // (root's reason is the one to tell: the own call only ever says no)
        var why = '';
        var noRoot = function (e: Error): Promise<void> {
            why = e.message;
            return byOwn();
        };
        (rooted ? byRoot().then(null, noRoot) : byOwn().then(null, byRoot)).then(null, function (e: Error) {
            why = why || e.message;
            // (not taken: the TV shows what it showed. A choice made since has its own asking)
            if (asked !== key) {
                return;
            }
            if (told || !given) {
                back(given);
            }
            if (told && !quiet && refusedTo) {
                refusedTo(new Error(why === NO_CHANNEL || why === NO_ROOT ? why : NO_ENTRY));
            }
        });
    };
    // (a custom logo that cannot be shown: the first logo's icon)
    var builtIn = function (): void { give(iconBase(one)); };
    if (c) {
        written(c).then(give, builtIn);
    } else {
        builtIn();
    }
}

/** Text as base64 (its UTF-8 bytes) */
function base64(text: string): string {
    return btoa(unescape(encodeURIComponent(text)));
}

/** Whether a call run as root was answered with a yes (out: what luna-send printed, the reply on its first line) */
function saysYes(out: string): boolean {
    try {
        return JSON.parse(out.split('\n')[0]).returnValue === true;
    } catch (e) {
        return false;
    }
}

/** Whether the launch points listed (out: listLaunchPoints' reply as printed) show entry otherwise: its launch point
 * there without its name or both its pictures (a list that cannot be read, or lacks it: no) */
function differs(out: string, entry: Entry): boolean {
    try {
        var points = JSON.parse(out).launchPoints as Entry[];
        for (var i = 0; i < points.length; i++) {
            if (points[i].launchPointId === entry.launchPointId) {
                return points[i].title !== entry.title || points[i].largeIcon !== entry.largeIcon && points[i].icon !== entry.icon;
            }
        }
    } catch (e) {
        // (not a list)
    }
    return false;
}

/** Puts the choices back to what the TV shows: those it last took (given; null: the package's own). Nothing more is
 * asked for them. */
function back(given: Given | null): void {
    var key = given ? given.key : '';
    var first = key.indexOf('|');
    var last = key.lastIndexOf('|');
    var was = { homeIcon: given && first > 0 ? key.slice(0, first) : LOGOS[0].id, homeName: given ? key.slice(first + 1, last) : '', homeColor: given ? key.slice(last + 1) : '' };
    var now = prefs();
    (['homeIcon', 'homeName', 'homeColor'] as ('homeIcon' | 'homeName' | 'homeColor')[]).forEach(function (pref) {
        if ((now[pref] || '') !== was[pref]) {
            setPref(pref, was[pref]);
        }
    });
    asked = key;
    settled = true;
}

/** Empties the custom icon files of earlier writings, now that the TV shows those named shown (removes them, where
 * root's way is this TV's) */
function emptyOld(shown: string): void {
    var kept = files();
    var gone = kept.old.filter(function (n) { return named(n) !== shown; });
    if (gone.length) {
        kept.old = kept.old.filter(function (n) { return named(n) === shown; });
        save(FILES_KEY, kept);
        var names: string[] = [];
        gone.forEach(function (n) { SIZES.forEach(function (size) { names.push(named(n) + '-' + size.px + '.png'); }); });
        blank(names, rooted);
    }
}

/** A choice of the home screen's logo, name or colour was made: asked of the TV now (quiet: made by the app itself,
 * nothing said if the TV does not take it) */
function chosen(quiet?: boolean): void {
    settled = false;
    ask(true, quiet);
}

/** Chooses the home screen's logo: a built-in one's id at once; a custom one's value once its files are written
 * (rejects with NO_FILE, the choice as it was, where the TV gives the app no way to, or the logo has no picture
 * kept). A choice made meanwhile stands: this one's late files change nothing. */
export function setHomeIcon(value: string): Promise<void> {
    var mine = ++choosing;
    if (!isCustom(value)) {
        setPref('homeIcon', value);
        chosen();
        return Promise.resolve();
    }
    var c = customOf(value);
    if (!c || !c.data) {
        return Promise.reject(new Error(NO_FILE));
    }
    return written(c).then(function () {
        if (mine === choosing) {
            setPref('homeIcon', value);
            chosen();
        }
    });
}

/** Adds the picture at url as a custom logo (ui/custom-logos.ts) and chooses it for the home screen. Rejects, the
 * custom logos as they were, with that module's and ui/pictures.ts's reasons when it was not added or its bytes
 * could not be read (the home screen needs the picture itself), with NO_FILE when the TV cannot have its files. */
export function takeCustomIcon(url: string): Promise<void> {
    return addCustomLogo(url).then(function (c) {
        var undo = function (e: Error): never {
            removeCustomLogo(c);
            throw e;
        };
        return c.data ? setHomeIcon(customValue(c)).then(null, undo) : undo(new Error('no picture'));
    });
}

/** Chooses the name on the home screen ('' or the package's own: back to that) */
export function setHomeName(name: string): void {
    var text = name.replace(/\s+/g, ' ').replace(/^ | $/g, '').slice(0, NAME_MAX);
    setPref('homeName', text === APP_NAME ? '' : text);
    chosen();
}

/** Chooses the tile's colour on the home screen ('': the package's own) */
export function setHomeColor(color: string): void {
    setPref('homeColor', color);
    chosen();
}

// A custom logo removed: if the home screen shows it, the first logo's icon again; its files emptied once the TV
// shows others (at once if it already does)
onCustomRemoved('home', function (c) {
    var kept = files();
    if (kept.custom === c.id) {
        kept.custom = 0;
        kept.old.push(kept.n);
        save(FILES_KEY, kept);
    }
    if (prefs().homeIcon === customValue(c)) {
        choosing++;
        setPref('homeIcon', LOGOS[0].id);
        chosen(true);
    } else {
        var given = load<Given>(GIVEN_KEY);
        rooted = rooted || (!!given && given.way === ROOT);
        emptyOld(given ? given.files : iconBase(LOGOS[0]));
    }
});

/** The files of custom logo c, their name without size and ending: those written for it if they still load, else
 * written now, after any writing under way. Rejects (NO_FILE) if they cannot be. */
function written(c: CustomLogo): Promise<string> {
    var job = function (): Promise<string> {
        var base = customFiles(c);
        return base ? sized(base + '-130.png', 130).then(function () { return base; }, function () { return write(c); }) : write(c);
    };
    var next = writing.then(job, job);
    writing = next.then(null, function () { return undefined; });
    return next;
}

/** Writes custom logo c's picture as two icon files under a new name; the files before stay until the TV shows
 * others. Resolves with the files' name without size and ending, rejects (NO_FILE) if they could not be written. */
function write(c: CustomLogo): Promise<string> {
    var kept = files();
    var n = kept.n + 1;
    var names = SIZES.map(function (size) { return named(n) + '-' + size.px + '.png'; });
    return loaded(c.data).then(function (img) {
        return writePngs(names, squares(img, SIZES), SIZES.map(function (size) { return size.px; }), rooted);
    }).then(function () {
        save(FILES_KEY, { n: n, custom: c.id, old: kept.n > 0 ? kept.old.concat([kept.n]) : kept.old });
        return named(n);
    }, function () {
        throw new Error(NO_FILE);
    });
}

export { NO_CHANNEL, NO_FILE, NO_ROOT };
