// Persistent cache of the last channel pages opened, as JSON with the time
// YouTube sent them, keyed per account (a page shows the account's
// subscription state). Uses IndexedDB: a page is 280-410 KB, too much for
// localStorage, whose quota the settings share. Keeps at most PAGES_KEPT,
// none older than KEPT_MS; cleared when the account or its subscriptions
// change (forgetPages). On the TV: first open ~125 ms, read ~12 ms, write
// ~40 ms off the main thread. Without IndexedDB nothing is kept.

var DB = 'bolli-youtube';
var STORE = 'pages';
var PAGES_KEPT = 12;
var KEPT_MS = 24 * 60 * 60 * 1000;

export interface StoredPage {
    /** When YouTube sent it */
    at: number;
    json: string;
}

var opened: Promise<IDBDatabase | null> | null = null;
/** Incremented on every forgetPages */
var forgets = 0;

/** The database, or null when unavailable */
function db(): Promise<IDBDatabase | null> {
    if (!opened) {
        opened = new Promise<IDBDatabase | null>(function (resolve) {
            try {
                var rq = indexedDB.open(DB, 1);
                rq.onupgradeneeded = function () {
                    // Index by time, so the oldest are found without reading the pages
                    rq.result.createObjectStore(STORE).createIndex('at', 'at');
                };
                rq.onsuccess = function () { resolve(rq.result); };
                rq.onerror = function () { resolve(null); };
            } catch (e) {
                resolve(null);
            }
        });
    }
    return opened;
}

/** How many times the cache was cleared (a page fetched before a clear must not be stored after it) */
export function pagesForgotten(): number {
    return forgets;
}

/** Opens the store ahead of use (the first open takes ~125 ms) */
export function openPages(): void {
    db();
}

/** The stored page for key (null: none, a day old, or no store) */
export function storedPage(key: string): Promise<StoredPage | null> {
    return db().then(function (d) {
        return new Promise<StoredPage | null>(function (resolve) {
            try {
                var rq = d!.transaction(STORE, 'readonly').objectStore(STORE).get(key);
                rq.onsuccess = function () {
                    var page = rq.result as StoredPage | undefined;
                    resolve(page && Date.now() - page.at < KEPT_MS ? page : null);
                };
                rq.onerror = function () { resolve(null); };
            } catch (e) {
                resolve(null);
            }
        });
    });
}

/** Stores key's page (json, received at time at); drops the oldest beyond PAGES_KEPT and any a day old */
export function storePage(key: string, json: string, at: number): void {
    db().then(function (d) {
        try {
            var store = d!.transaction(STORE, 'readwrite').objectStore(STORE);
            store.put({ at: at, json: json }, key);
            var count = store.count();
            count.onsuccess = function () {
                var over = count.result - PAGES_KEPT;
                var cursor = store.index('at').openKeyCursor();
                cursor.onsuccess = function () {
                    var c = cursor.result;
                    if (c && (over > 0 || Date.now() - (c.key as number) >= KEPT_MS)) {
                        store.delete(c.primaryKey);
                        over--;
                        c.continue();
                    }
                };
            };
        } catch (e) {
            // Not stored
        }
    });
}

/** Clears every page (the account or its subscriptions changed) */
export function forgetPages(): void {
    forgets++;
    db().then(function (d) {
        try {
            d!.transaction(STORE, 'readwrite').objectStore(STORE).clear();
        } catch (e) {
            // No store
        }
    });
}
