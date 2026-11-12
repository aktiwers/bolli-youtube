// The viewer's own logos: pictures from web addresses typed in Settings › Look, each a tile there named Custom 1,
// Custom 2 ... in the order they were added, offered for the logo in the app and for the home screen's alike (one
// set). A picture is downloaded once when its address is typed (ui/pictures.ts: in the background, within a time
// and a size, only a picture the engine shows), made no bigger than a logo is drawn, and kept in the app's storage
// as a data URL: every start draws it from there with no request. A host that refuses the app a read of the bytes:
// kept by its address alone (data ''), shown by it where a picture can be (the logo in the app). At most
// CUSTOMS_MAX: they share the storage with the app's caches.
//
// Kept as a short list (ids and addresses) and each picture under a key of its own, read when it is first drawn: a
// start reads only the one it draws, not all of them.

import { tr } from '../core/i18n.js';
import { forget, load, save } from '../core/store.js';
import { Choice } from '../api/prefs.js';
import { fetchPicture, fitted } from './pictures.js';

/** A custom logo: its number for good (never given again), the address it came from, the picture as a data URL ('':
 * shown by its address) */
export interface CustomLogo {
    id: number;
    url: string;
    data: string;
}

export var CUSTOMS_MAX = 8;
/** Why one was not added: there are CUSTOMS_MAX already; the storage did not take it */
export var FULL = 'full';
export var NOT_KEPT = 'not kept';
/** In Settings' choices: the tile that adds a custom logo (never a pref's value) */
export var ADD = 'add';
/** A custom logo's value in prefs logo and homeIcon: this and its id */
var PREFIX = 'custom:';
/** The box a custom logo is kept in: the built-in logos' size */
var WIDTH = 216;
var HEIGHT = 181;
/** The list as kept (each one's id, address and whether its picture is kept), a picture's key (its id after it), and
 * the last id given */
var KEY = 'youtube.logo.customs';
var DATA_KEY = 'youtube.logo.custom.';
var LAST_KEY = 'youtube.logo.customs.last';

interface Entry {
    id: number;
    url: string;
    kept: boolean;
}

/** The list (undefined: not read yet), whether each one's picture is kept (by id: known without reading it), and
 * those told when one is removed */
var list: CustomLogo[] | undefined;
var kept: { [id: number]: boolean } = {};
var removed: { [who: string]: (c: CustomLogo) => void } = {};

/** A custom logo whose picture is read from the storage when first asked for (data: known already) */
function custom(entry: Entry, data?: string): CustomLogo {
    var c = { id: entry.id, url: entry.url } as CustomLogo;
    var got = data;
    kept[entry.id] = entry.kept;
    Object.defineProperty(c, 'data', { enumerable: true, get: function () {
        if (got === undefined) {
            var read = entry.kept ? load<string>(DATA_KEY + entry.id) : '';
            got = typeof read === 'string' && read.indexOf('data:image/') === 0 ? read : '';
        }
        return got;
    } });
    return c;
}

/** The list as it is kept */
function entries(logos: CustomLogo[]): Entry[] {
    return logos.map(function (c) { return { id: c.id, url: c.url, kept: !!kept[c.id] }; });
}

/** The custom logos, in the order they were added (unreadable entries left out) */
export function customLogos(): CustomLogo[] {
    if (!list) {
        var got = load<Entry[]>(KEY);
        list = (got instanceof Array ? got : []).filter(function (e) {
            return !!e && typeof e.id === 'number' && typeof e.url === 'string' && (e.kept || !!e.url);
        }).map(function (e) { return custom(e); });
    }
    return list;
}

/** Reads the list anew from the storage when it is next asked for (the storage changed under it: a test's) */
export function reloadCustomLogos(): void {
    list = undefined;
}

/** A custom logo's value in prefs */
export function customValue(c: CustomLogo): string {
    return PREFIX + c.id;
}

/** Whether a prefs value names a custom logo (one that may be gone) */
export function isCustom(value: string): boolean {
    return value.indexOf(PREFIX) === 0;
}

/** The custom logo a prefs value names (null: none, or gone) */
export function customOf(value: string): CustomLogo | null {
    var id = isCustom(value) ? +value.slice(PREFIX.length) : NaN;
    return customLogos().filter(function (c) { return c.id === id; })[0] || null;
}

/** A custom logo as a choice: named by its number among them (Custom 1, Custom 2 ...), its picture (by its address
 * where only that is kept), removable (Settings: OK held) */
export function customChoice(c: CustomLogo): Choice {
    return { value: customValue(c), name: tr('Custom {1}', String(customLogos().indexOf(c) + 1)), note: tr('hold OK to remove it'), picture: c.data || c.url,
        removable: true };
}

/** The tile that adds a custom logo, while there is room for one */
export function addChoice(): Choice[] {
    return customLogos().length < CUSTOMS_MAX ? [{ value: ADD, name: tr('Add a picture'), note: tr('from a web address you type: downloaded once and kept on the TV'),
        picture: '', tile: 'add' }] : [];
}

/** Adds the picture at url as a custom logo: downloaded in the background, made to fit a logo's box and kept. Rejects
 * (the list as it was) with ui/pictures.ts's reasons when the address holds no picture, it is too big, slow or
 * failed; with FULL at CUSTOMS_MAX; with NOT_KEPT when the storage did not take it. */
export function addCustomLogo(url: string): Promise<CustomLogo> {
    if (customLogos().length >= CUSTOMS_MAX) {
        return Promise.reject(new Error(FULL));
    }
    return fetchPicture(url, true).then(function (got) {
        var before = customLogos();
        if (before.length >= CUSTOMS_MAX) {
            throw new Error(FULL);
        }
        var data = got.data && fitted(got, WIDTH, HEIGHT);
        var id = (load<number>(LAST_KEY) || 0) + 1;
        var c = custom({ id: id, url: url, kept: !!data }, data);
        var next = before.concat([c]);
        if (data && !save(DATA_KEY + id, data) || !save(KEY, entries(next))) {
            forget(DATA_KEY + id);
            throw new Error(NOT_KEPT);
        }
        save(LAST_KEY, id);
        list = next;
        return c;
    });
}

/** Removes a custom logo (its number is not given again) and tells those who asked to hear of it */
export function removeCustomLogo(c: CustomLogo): void {
    list = customLogos().filter(function (one) { return one !== c; });
    save(KEY, entries(list));
    forget(DATA_KEY + c.id);
    Object.keys(removed).forEach(function (who) { removed[who](c); });
}

/** Calls heard with each custom logo removed from now on (after it is gone from the list); who: the listener's name
 * (one under the same name takes its place) */
export function onCustomRemoved(who: string, heard: (c: CustomLogo) => void): void {
    removed[who] = heard;
}
