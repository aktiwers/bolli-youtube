// The app's entry on the TV's home screen (webOS): its logo, its name and its tile's colour, as set in Settings ›
// Look (prefs homeIcon, homeName, homeColor). webOS lets an app point its own entry at another picture file, name and
// colour (updateLaunchPoint), keeps that over restarts, and puts the package's back at an update: so the app asks
// when a choice is made, and again once the first rows are drawn at a start unless the package's own were never left.
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
import { appId, blank, folder, NO_FILE, sized, writePngs } from './app-files.js';
import { addChoice, addCustomLogo, customChoice, CustomLogo, customLogos, customOf, customValue, isCustom, onCustomRemoved, removeCustomLogo } from './custom-logos.js';
import { iconBase, logoFile, LOGOS } from './logo.js';
import { loaded, squares } from './pictures.js';

/** The package's own name and tile colour (appinfo.json's title and iconColor) */
export var APP_NAME = 'Bolli YouTube';
export var APP_COLOR = '#0d0d12';
/** The longest name taken */
export var NAME_MAX = 30;

var ENTRY = 'luna://com.webos.applicationManager/updateLaunchPoint';
/** What the TV's entry was last given, kept (null: the package's own, never changed): the choice it stood for and
 * its icon files' name without size and ending. A start then asks again. */
var GIVEN_KEY = 'youtube.home';
/** The custom icon files: the number in the newest ones' names (never given again), which custom logo they hold (0:
 * none any more), and the numbers of earlier ones not emptied yet */
var FILES_KEY = 'youtube.home.files';
/** An icon's sizes, each with the box its picture is fitted into (the built-in icons' own margins) */
var SIZES = [{ px: 130, inner: 112 }, { px: 80, inner: 70 }];

interface Given {
    key: string;
    files: string;
}

interface Files {
    n: number;
    custom: number;
    old: number[];
}

/** What was asked of the TV this run ('' nothing yet); that nothing needs asking (the package's own, never left: no
 * storage read at each screen drawn); the latest choice of a logo (an earlier one's late files are dropped); and the
 * writing in turn */
var asked = '';
var settled = false;
var choosing = 0;
var writing: Promise<unknown> = Promise.resolve();

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
    var c = chosenCustom();
    var one = c ? LOGOS[0] : chosenLogo();
    var name = (prefs().homeName || '').slice(0, NAME_MAX);
    var color = homeColor();
    var key = (c ? customValue(c) : one.id) + '|' + name + '|' + color;
    var own = !c && one === LOGOS[0] && !name && !color;
    if (key === asked) {
        return;
    }
    // (the package's own: asked for only if another was given before, kept or asked this run)
    if (own && !asked && !load<Given>(GIVEN_KEY)) {
        settled = true;
        return;
    }
    asked = key;
    var dir = folder();
    var give = function (base: string): void {
        // (a choice made since: its own asking is on its way)
        if (asked !== key) {
            return;
        }
        lunaAsk(ENTRY, { launchPointId: app + '_default', icon: dir + base + '-80.png', largeIcon: dir + base + '-130.png', title: name || APP_NAME,
            iconColor: color || APP_COLOR }).then(function () {
            save(GIVEN_KEY, own ? null : { key: key, files: base });
            emptyOld(base);
        }, function () {
            // (refused: the TV shows what it showed)
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

/** Empties the custom icon files of earlier writings, now that the TV shows those named shown */
function emptyOld(shown: string): void {
    var kept = files();
    var gone = kept.old.filter(function (n) { return named(n) !== shown; });
    if (gone.length) {
        kept.old = kept.old.filter(function (n) { return named(n) === shown; });
        save(FILES_KEY, kept);
        gone.forEach(function (n) { blank(SIZES.map(function (size) { return named(n) + '-' + size.px + '.png'; })); });
    }
}

/** A choice of the home screen's logo, name or colour was made: asked of the TV now */
function chosen(): void {
    settled = false;
    homeScreen();
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
        chosen();
    } else {
        var given = load<Given>(GIVEN_KEY);
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
        return writePngs(names, squares(img, SIZES), SIZES.map(function (size) { return size.px; }));
    }).then(function () {
        save(FILES_KEY, { n: n, custom: c.id, old: kept.n > 0 ? kept.old.concat([kept.n]) : kept.old });
        return named(n);
    }, function () {
        throw new Error(NO_FILE);
    });
}

export { NO_FILE };
