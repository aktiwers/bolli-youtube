// The app's logo, as chosen in Settings › Look › Logo (prefs logo): drawn at the rail's top, on a screen's loading
// sign and while YouTube's player starts. Each built-in logo is two files in the app's folder, the same size as the
// first's (216x181, so the layout stays): <file>.webp, and <file>.png for webOS TV 2.x's engine, which decodes no
// WebP (promise.js marked it). Another logo: one entry in LOGOS, its two files and its two icons. About always shows
// the first logo, the app's own.
//
// No logo: nothing is drawn in those places (the rail's top stays as an empty place that still takes the focus and
// opens the menu); the screens load without a sign.
//
// The TV's home screen has its own logo setting (ui/home-screen.ts), with an icon file for each built-in logo in the
// app's folder (iconBase: 130 and 80 px, the logo fitted as in the first's).
//
// The viewer's own pictures (ui/custom-logos.ts: Custom 1, Custom 2 ...): drawn from their kept copies with no
// request. One kept by its address alone (its host refuses the app a read of the bytes) is loaded once the first
// screen's rows are drawn and swapped in once loaded, the first logo meanwhile. One that is gone: the first logo, and
// the choice back to it.
//
// Your YouTube avatar: the signed-in account's picture (its address from main.ts setLogoAccount: the accounts' cached
// details, no request of its own), drawn round. Downloaded as a custom one is (ui/pictures.ts) and kept under its own
// key, naming its account, so another account's is never drawn: fetched when chosen, and in the background once the
// first screen's rows are drawn when the account's picture address differs from the kept one (a new picture, another
// account). Until it is in: the old copy for the same account, else the first logo. Signed out, or no copy: the first
// logo, the choice kept (the picture comes back with the account).

import { tr } from '../core/i18n.js';
import { oldEngine } from '../core/platform.js';
import { load, save } from '../core/store.js';
import { Choice, prefs, setPref } from '../api/prefs.js';
import { addChoice, addCustomLogo, customChoice, CustomLogo, customLogos, customOf, customValue, isCustom, onCustomRemoved } from './custom-logos.js';
import { fetchPicture, loaded } from './pictures.js';

/** A logo: its id (stored), the name Settings shows, its files' base name */
export interface Logo {
    id: string;
    name: string;
    file: string;
}

/** The built-in logos, the first the default */
export var LOGOS: Logo[] = [
    { id: 'red', name: tr('Red'), file: 'logo-3' },
    { id: 'shield', name: tr('Shield'), file: 'logo-2' },
    { id: 'framed', name: tr('Framed'), file: 'logo-4' },
    { id: 'badge', name: tr('Badge'), file: 'logo-5' },
    { id: 'steel', name: tr('Steel'), file: 'logo-6' },
    { id: 'rust', name: tr('Rust'), file: 'logo-7' },
    { id: 'glass', name: tr('Dark glass'), file: 'logo-8' },
    { id: 'fire', name: tr('Fire'), file: 'logo-9' },
    { id: 'galaxy', name: tr('Galaxy'), file: 'logo-10' }
];

/** In prefs logo: the account's picture, and no logo */
export var ACCOUNT = 'account';
export var NONE = 'none';

/** The account's picture as kept: the address it came from, the picture as a data URL, the account (its key in
 * api/accounts.ts) */
interface KeptLogo {
    url: string;
    data: string;
    account: string;
}

var ACCOUNT_KEY = 'youtube.logo.account';
/** The account last known as signed in ('' none): a start draws its kept picture before the account is known */
var SEEN_KEY = 'youtube.logo.seen';
/** The account picture's size asked of YouTube: the loading sign's 181 px on the TV's 1.5x-scaled screen */
export var ACCOUNT_PICTURE_PX = 272;

/** Custom logos kept by their address alone: those whose picture has loaded there, and those asked for this run */
var byAddress: { [id: number]: boolean } = {};
var addressAsked: { [id: number]: boolean } = {};
/** The latest download of the account's picture (an earlier one's result is dropped) */
var asking = 0;
/** The account signed in with its picture's address ('' not known; undefined: not known yet this run, the one last
 * seen counts; null: none), the one last seen (null: not read yet), the account picture kept (undefined: not read
 * yet), the addresses asked this run, and whether the first screen's rows are drawn */
var who: { key: string; url: string } | null | undefined;
var seen: string | null = null;
var accountKept: KeptLogo | null | undefined;
var accountAsked: { [key: string]: boolean } = {};
var rowsIn = false;

/** Drawers of the logo, called again when it changes (round: the account's picture, drawn as a circle) */
var drawers: ((file: string, round: boolean) => void)[] = [];

/** A built-in logo's picture: its WebP, or its PNG on the old engine */
export function logoFile(one: Logo): string {
    return one.file + (oldEngine() ? '.png' : '.webp');
}

/** A built-in logo's home screen icons in the app's folder, their name without size and ending: icon-<n> for
 * logo-<n> (each a 130 and an 80 px PNG: <name>-<px>.png). The first logo's are the package's own (appinfo.json names
 * them; ui/home-screen.ts points the TV at the others). */
export function iconBase(one: Logo): string {
    return one.file.replace('logo', 'icon');
}

/** The built-in logo with this id (undefined: none is listed under it) */
function listed(id: string): Logo | undefined {
    return LOGOS.filter(function (one) { return one.id === id; })[0];
}

/** Settings › Look › Logo's choices, each a tile with its picture: the built-in logos by file, the account's picture
 * while an account is signed in (round; its kept copy, by its address before one is kept), the custom ones, the tile
 * that adds one, and none */
export function logoChoices(): Choice[] {
    var list = LOGOS.map(function (one) { return { value: one.id, name: one.name, note: '', picture: logoFile(one) } as Choice; });
    if (signedIn()) {
        list.push({ value: ACCOUNT, name: tr('Your YouTube avatar'), note: tr('the picture of the YouTube account in use'),
            picture: accountPicture() || who && who.url || '', round: true });
    }
    return list.concat(customLogos().map(customChoice), addChoice(), [
        { value: NONE, name: tr('No logo'), note: tr('nothing is drawn; its place at the top of the menu still opens the menu'), picture: '', tile: 'none' }
    ]);
}

/** The signed-in account's key ('' none; before it is known this run: the one last seen) */
function accountNow(): string {
    if (who !== undefined) {
        return who ? who.key : '';
    }
    if (seen === null) {
        seen = load<string>(SEEN_KEY) || '';
    }
    return seen;
}

/** The signed-in account's kept picture ('' none: signed out, none kept, or another account's) */
export function accountPicture(): string {
    if (accountKept === undefined) {
        var got = load<KeptLogo>(ACCOUNT_KEY);
        accountKept = got && typeof got.url === 'string' && typeof got.data === 'string' && got.data.indexOf('data:image/') === 0 &&
            typeof got.account === 'string' ? got : null;
    }
    var now = accountNow();
    return accountKept && now && accountKept.account === now ? accountKept.data : '';
}

/** Whether an account is signed in (Settings offers its picture only then; before it is known this run: whether one
 * was when last seen) */
export function signedIn(): boolean {
    return !!accountNow();
}

/** The logo Settings shows as chosen: no logo; the account's picture only while an account is signed in; a custom one
 * only while it is there; a built-in one only while it is listed; else the first */
export function shownLogo(): string {
    var id = prefs().logo;
    return id === NONE || id === ACCOUNT && signedIn() || isCustom(id) && customOf(id) || listed(id) ? id : LOGOS[0].id;
}

/** Whether the logo drawn is the account's picture (drawn round) */
export function logoRound(): boolean {
    return prefs().logo === ACCOUNT && !!accountPicture();
}

/** The chosen logo's picture ('': no logo); a custom one that is gone: the first, and the choice back to it; one kept
 * by its address: the first until it has loaded there; the account's picture without a copy (or signed out): the
 * first, the choice kept */
export function logo(): string {
    var id = prefs().logo;
    if (id === NONE) {
        return '';
    }
    if (isCustom(id)) {
        var c = customOf(id);
        if (c) {
            return c.data || byAddress[c.id] && c.url || logoFile(LOGOS[0]);
        }
        setPref('logo', LOGOS[0].id);
    } else if (id === ACCOUNT) {
        return accountPicture() || logoFile(LOGOS[0]);
    }
    return logoFile(listed(id) || LOGOS[0]);
}

/** Draws the chosen logo with draw now, and again whenever it changes (applyLogo) */
export function drawLogo(draw: (file: string, round: boolean) => void): void {
    drawers.push(draw);
    draw(logo(), logoRound());
}

/** Draws the chosen logo anew where drawLogo draws it (after the pref changed, or a custom one went); the others take
 * it when they next show */
export function applyLogo(): void {
    var file = logo();
    var round = logoRound();
    drawers.forEach(function (draw) { draw(file, round); });
}

/** The first screen's rows are drawn: a custom logo kept by its address loads now (once), swapped in once loaded; the
 * account's picture is fetched if it changed */
export function rowsDrawn(): void {
    rowsIn = true;
    refreshAccountLogo(false).then(null, function () { return undefined; });
    byItsAddress();
}

/** Loads the chosen custom logo by its address if only that is kept (once a run), then draws it */
function byItsAddress(): void {
    var c = customOf(prefs().logo);
    if (!c || c.data || addressAsked[c.id]) {
        return;
    }
    var id = c.id;
    addressAsked[id] = true;
    loaded(c.url).then(function () {
        byAddress[id] = true;
        applyLogo();
    }, function () {
        // (the first logo stays; the next start tries again)
    });
}

/** Adds the picture at url as a custom logo (ui/custom-logos.ts: downloaded in the background and kept) and chooses
 * it for the app; rejects (the choice as it was) with that module's and ui/pictures.ts's reasons */
export function takeCustomLogo(url: string): Promise<CustomLogo> {
    return addCustomLogo(url).then(function (c) {
        chooseLogo(customValue(c));
        return c;
    });
}

/** Chooses a logo for the app (a built-in one's id, a custom one's value, or NONE) and draws it */
export function chooseLogo(value: string): void {
    setPref('logo', value);
    var c = customOf(value);
    if (c && !c.data) {
        // (typed just now, so its picture is in the browser's cache: shown by its address at once)
        byAddress[c.id] = addressAsked[c.id] = true;
    }
    applyLogo();
}

/** The signed-in account (null: none; url: its picture's address, '' not known) from main.ts: the logo drawn anew
 * where it is the account's picture or the account changed (Settings offers the picture only while one is signed in);
 * once the first rows are drawn, its picture fetched if it changed */
export function setLogoAccount(account: { key: string; url: string } | null): void {
    var before = accountNow();
    who = account;
    var key = account ? account.key : '';
    if (seen !== key) {
        seen = key;
        save(SEEN_KEY, key);
    }
    if (prefs().logo === ACCOUNT || key !== before) {
        applyLogo();
    }
    if (rowsIn) {
        refreshAccountLogo(false).then(null, function () { return undefined; });
    }
}

/** Chooses the account's picture: the first logo until its kept copy is in (fetched now if missing or changed);
 * rejects if that fetch fails (the choice stays: the next start tries again) */
export function takeAccountLogo(): Promise<void> {
    setPref('logo', ACCOUNT);
    applyLogo();
    return refreshAccountLogo(true);
}

/** Fetches the signed-in account's picture if it is the logo and the kept copy is missing, another account's or from
 * another address (once per address and run, unless again), keeps it and draws it. Rejects when the download fails,
 * the storage does not take it, or a later download overtook this one. */
function refreshAccountLogo(again: boolean): Promise<void> {
    var account = who;
    if (prefs().logo !== ACCOUNT || !account || !account.url) {
        return Promise.resolve();
    }
    accountPicture();
    var asked = account.key + ' ' + account.url;
    if (accountKept && accountKept.account === account.key && accountKept.url === account.url || accountAsked[asked] && !again) {
        return Promise.resolve();
    }
    accountAsked[asked] = true;
    var mine = ++asking;
    var url = account.url;
    var key = account.key;
    return fetchPicture(url, false).then(function (fetched) {
        // (a later download, or another account signed in meanwhile: this one's picture is not kept over theirs)
        if (mine !== asking || !who || who.key !== key) {
            throw new Error('overtaken');
        }
        var got: KeptLogo = { url: url, data: fetched.data, account: key };
        if (!save(ACCOUNT_KEY, got)) {
            throw new Error('not kept');
        }
        accountKept = got;
        applyLogo();
    });
}

// A custom logo removed: if it was the logo, the first one is drawn (logo: the choice back to it)
onCustomRemoved('logo', function () { applyLogo(); });
