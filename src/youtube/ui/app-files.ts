// Picture files written into the app's own folder on a webOS TV, for the home screen's entry (ui/home-screen.ts),
// which takes only files. An app has no file access of its own; two ways lead there:
//
// byStore, open to any app on a TV that has it: the PNGs are stored as blobs in a database of the browser made for
// the one time (the TV keeps each blob as a plain file, where the page itself may not read it), the TV's image
// service is asked where those files are (the database's number is not told: the numbers after the last one found
// are asked, a file of the right size answers) and copies each into the folder under its name; the database goes
// again.
//
// byChannel, on a rooted TV with the Homebrew Channel: its service writes each PNG under its name.
//
// A writing is checked by loading each file at its size. An app cannot remove a file: one no longer wanted is
// overwritten with a one-pixel picture (blank). One writing at a time (found looks for the newest database).

import { lunaAsk } from '../core/luna.js';
import { android } from '../core/platform.js';
import { load, save } from '../core/store.js';
import { base64Bytes } from '../api/sabr.js';
import { loaded } from './pictures.js';

/** Why files were not written: the TV gives the app no way to */
export var NO_FILE = 'no file';

var EXEC = 'luna://org.webosbrew.hbchannel.service/exec';
var IMAGE = 'luna://com.palm.image/';
/** Where the TV's browser keeps an app's stored blobs as files: this, the app's id, STORE_TAIL, the database's number,
 * the blob's key in a folder of its high byte (webOS 3's place; elsewhere the files are not found and the other way
 * is tried) */
var STORE = '/var/lib/wam/IndexedDB/file_';
var STORE_TAIL = '_0.indexeddb.blob/';
/** The databases the pictures pass through are named this and the time; their one store; a new database's first
 * blob's key */
var DB = 'bolli-home';
var KEPT = 'icons';
var BLOB_FIRST = 2;
/** How many database numbers past the last one found are asked for the stored files, and that number, kept */
var DATABASES = 8;
var FOUND_KEY = 'youtube.home.found';
/** How long the way through the browser's database may take before the other way is tried */
var STORE_MS = 8000;
/** A one-pixel picture in the app's folder */
var DOT = 'dot.png';

/** The app's id on a webOS TV ('' elsewhere) */
export function appId(): string {
    var palm = (window as unknown as { PalmSystem?: { identifier?: string } }).PalmSystem;
    return !android() && palm && palm.identifier ? palm.identifier.split(' ')[0] : '';
}

/** The app's folder on the TV, with its last slash */
export function folder(): string {
    var path = decodeURI(location.pathname);
    return path.slice(0, path.lastIndexOf('/') + 1);
}

/** Resolves when the picture at src (a file in the app's folder) loads as a square of px, rejects otherwise */
export function sized(src: string, px: number): Promise<void> {
    return loaded(src).then(function (img) {
        if (img.naturalWidth !== px || img.naturalHeight !== px) {
            throw new Error(NO_FILE);
        }
    });
}

/** Writes the PNGs (base64; squares of sizes px) into the app's folder under names, by the first way that works, and
 * checks that each loads at its size. Rejects (NO_FILE) if they could not be written. */
export function writePngs(names: string[], pngs: string[], sizes: number[]): Promise<void> {
    var dir = folder();
    // (the folder goes into paths and a command: only a plain path)
    if (!/^\/[\w\/.-]+\/$/.test(dir)) {
        return Promise.reject(new Error(NO_FILE));
    }
    return within(byStore(dir, names, pngs, sizes), STORE_MS).then(null, function () { return byChannel(dir, names, pngs); }).then(function () {
        return Promise.all(names.map(function (name, i) { return sized(name, sizes[i]); }));
    }).then(function () { return undefined; }, function () {
        throw new Error(NO_FILE);
    });
}

/** Copies the one-pixel picture over the files named (they are no longer wanted) */
export function blank(names: string[]): void {
    var dir = folder();
    names.forEach(function (name) {
        lunaAsk(IMAGE + 'convert', { src: dir + DOT, dest: dir + name, destType: 'png' }).then(null, function () { return undefined; });
    });
}

function byStore(dir: string, names: string[], pngs: string[], sizes: number[]): Promise<void> {
    var name = DB + '-' + Date.now();
    var gone = function (): void {
        try {
            indexedDB.deleteDatabase(name);
        } catch (e) {
            // (no database to drop)
        }
    };
    return stored(name, pngs).then(function () { return found(sizes); }).then(function (paths) {
        return Promise.all(names.map(function (file, i) { return lunaAsk(IMAGE + 'convert', { src: paths[i], dest: dir + file, destType: 'png' }); }));
    }).then(gone, function (e) {
        gone();
        throw e;
    });
}

/** Stores the PNGs as blobs in a new database called name, in their order; resolves once they are written */
function stored(name: string, pngs: string[]): Promise<void> {
    return new Promise<void>(function (resolve, reject) {
        var open = indexedDB.open(name, 1);
        open.onerror = function () { reject(new Error(NO_FILE)); };
        open.onupgradeneeded = function () { open.result.createObjectStore(KEPT); };
        open.onsuccess = function () {
            var db = open.result;
            var end = function (ok: boolean): void {
                db.close();
                if (ok) {
                    resolve();
                } else {
                    reject(new Error(NO_FILE));
                }
            };
            try {
                var tx = db.transaction(KEPT, 'readwrite');
                tx.oncomplete = function () { end(true); };
                tx.onerror = tx.onabort = function () { end(false); };
                pngs.forEach(function (png, i) {
                    tx.objectStore(KEPT).put(new Blob([base64Bytes(png)], { type: 'image/png' }), String(i));
                });
            } catch (e) {
                end(false);
            }
        };
    });
}

/** Where the TV keeps the blobs just stored, as files, in sizes' order: the newest database (the highest number, past
 * the last one found; from the first when none of those answers) whose first blobs are square pictures of those
 * sizes. Rejects when none is found. */
function found(sizes: number[]): Promise<string[]> {
    var last = load<number>(FOUND_KEY) || 0;
    var store = STORE + appId() + STORE_TAIL;
    var range = function (from: number, to: number): Promise<string[]> {
        var numbers: number[] = [];
        for (var d = to; d >= from; d--) {
            numbers.push(d);
        }
        return Promise.all(numbers.map(function (d) { return blobsOf(store + d + '/00/', sizes); })).then(function (all) {
            for (var i = 0; i < all.length; i++) {
                if (all[i]) {
                    save(FOUND_KEY, numbers[i]);
                    return all[i] as string[];
                }
            }
            throw new Error(NO_FILE);
        });
    };
    return range(last + 1, last + DATABASES).then(null, function () { return range(1, Math.max(last, DATABASES * 4)); });
}

/** A database's first blobs as files under dir (a new database's blobs are numbered from BLOB_FIRST), in sizes' order;
 * null when they are not square pictures of those sizes */
function blobsOf(dir: string, sizes: number[]): Promise<string[] | null> {
    var keys = sizes.map(function (_px, i) { return dir + (BLOB_FIRST + i).toString(16); });
    return Promise.all(keys.map(function (path) {
        return lunaAsk(IMAGE + 'imageInfo', { src: path }).then(function (info) { return +(info.width as number) === +(info.height as number) ? +(info.width as number) : 0; },
            function () { return 0; });
    })).then(function (widths) {
        var paths = sizes.map(function (px) { return keys[widths.indexOf(px)] || ''; });
        return paths.every(function (path) { return !!path; }) ? paths : null;
    });
}

function byChannel(dir: string, names: string[], pngs: string[]): Promise<void> {
    var command = 'cd "' + dir + '"';
    names.forEach(function (name, i) {
        // (to a name beside it first, moved over once whole)
        command += ' && echo ' + pngs[i] + ' | base64 -d > ' + name + '.new && mv ' + name + '.new ' + name;
    });
    return lunaAsk(EXEC, { command: command }).then(function () { return undefined; });
}

/** p, or a rejection once ms have passed without it */
function within<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>(function (resolve, reject) {
        var timer = setTimeout(function () { reject(new Error(NO_FILE)); }, ms);
        p.then(function (value) {
            clearTimeout(timer);
            resolve(value);
        }, function (e) {
            clearTimeout(timer);
            reject(e);
        });
    });
}
