// localStorage with versioned keys. Never throws: a full or unavailable
// storage only means the next start has no cache.
// In the Android app the settings and an account's own are also in a second copy of the app's own (the shell's keep
// and kept, COPIED): the web view's storage can lose what is written after a power cut broke a write (seen on Android
// 16's: the look chosen in Settings back to the one before at every start), the copy cannot. It is taken up as this
// module is first imported, before anything else is read: the web view's storage as the copy has it.

import { android, AndroidShell } from './platform.js';

var PREFIX = 'bolli.v1.';
/** In the copy, each key or one under it after a dot (an account's own: ownKey): the settings (each account's and the
 * TV's shared ones), an account's own (its recent searches, last video, channels looked at) and the cast pairing. Not
 * in it: what follows the account in use, which YouTube's own storage beside this one names (the account in use, the
 * language in use, the logo last seen, the accounts' list), so that both are as a power cut left them, together; and
 * what the app makes anew (caches, measurements, pictures) */
export var COPIED = ['youtube.prefs', 'youtube.recentSearches', 'youtube.lastVideo', 'youtube.looked', 'youtube.lounge',
    'youtube.deviceId'];
/** The copy's mark that it was made: from then on it is whole, a key it lacks one removed */
var MADE = 'bolli.copy';

type Copy = Required<Pick<AndroidShell, 'keep' | 'kept'>>;

/** The Android app's copy (null: none, on webOS, in a browser, in a shell built before it), and the key the app gave
 * this page in its address (#): the copy answers that alone, so no frame of another site in the page reads or
 * changes it */
var copy: Copy | null = null;
var token = '';

export function load<T>(key: string): T | null {
    try {
        var raw = window.localStorage.getItem(PREFIX + key);
        return raw ? (JSON.parse(raw) as T) : null;
    } catch (e) {
        return null;
    }
}

/** Keeps value under key; false when the storage did not take it (full or disabled) */
export function save(key: string, value: unknown): boolean {
    var raw = '';
    try {
        raw = JSON.stringify(value);
        window.localStorage.setItem(PREFIX + key, raw);
    } catch (e) {
        return false;
    }
    copied(PREFIX + key, raw);
    return true;
}

/** Removes key */
export function forget(key: string): void {
    try {
        window.localStorage.removeItem(PREFIX + key);
    } catch (e) {
        return;
    }
    copied(PREFIX + key, null);
}

/** Removes every key beginning with prefix */
export function forgetAll(prefix: string): void {
    try {
        var s = window.localStorage;
        for (var i = s.length - 1; i >= 0; i--) {
            var key = s.key(i);
            if (key && key.indexOf(PREFIX + prefix) === 0) {
                s.removeItem(key);
                copied(key, null);
            }
        }
    } catch (e) {
        // storage unavailable
    }
}

/** Whether stored (a key as stored, with PREFIX) is in the copy */
function inCopy(stored: string): boolean {
    if (stored.indexOf(PREFIX) !== 0) {
        return false;
    }
    var key = stored.slice(PREFIX.length);
    for (var i = 0; i < COPIED.length; i++) {
        if (key === COPIED[i] || key.indexOf(COPIED[i] + '.') === 0) {
            return true;
        }
    }
    return false;
}

/** stored as now stored (raw; null: removed) into the copy, where there is one and the key is in it (a copy that
 * cannot be written leaves what the web view took as it is) */
function copied(stored: string, raw: string | null): void {
    if (copy && inCopy(stored)) {
        try {
            copy.keep(stored, raw, token);
        } catch (e) {
            // (the shell's call failed: the web view's storage holds it)
        }
    }
}

/** The Android app's copy taken up (as this module is first imported; again by the tests): the web view's storage as
 * the copy has it, the keys it no longer has removed first (which makes room) and then the values it lacks or has
 * older (a power cut) put back; one that does not fit is dropped from the copy too, so that the two agree. On the
 * first start with a copy, the copy is made of what the web view has. An entry that is not one of the copy's is
 * dropped from it */
export function takeCopy(): void {
    // (the parse worker imports this module too, and has no page)
    var shell = typeof window === 'undefined' ? null : android();
    copy = shell && shell.keep && shell.kept ? shell as Copy : null;
    if (!copy) {
        return;
    }
    token = window.location.hash.slice(1);
    var has = Object.prototype.hasOwnProperty;
    var key: string | null;
    var i: number;
    try {
        var s = window.localStorage;
        var kept = JSON.parse(copy.kept(token) || '{}') as { [key: string]: string };
        if (!has.call(kept, MADE)) {
            for (i = 0; i < s.length; i++) {
                key = s.key(i);
                if (key && inCopy(key)) {
                    copy.keep(key, s.getItem(key), token);
                }
            }
            copy.keep(MADE, '1', token);
            return;
        }
        for (i = s.length - 1; i >= 0; i--) {
            key = s.key(i);
            if (key && !has.call(kept, key) && inCopy(key)) {
                s.removeItem(key);
            }
        }
        for (key in kept) {
            if (!has.call(kept, key) || key === MADE) {
                continue;
            }
            if (!inCopy(key)) {
                copy.keep(key, null, token);
            } else if (s.getItem(key) !== kept[key]) {
                try {
                    s.setItem(key, kept[key]);
                } catch (e) {
                    copy.keep(key, null, token);
                }
            }
        }
    } catch (e) {
        // (storage unavailable, or a copy that does not read: the web view's storage as it is)
    }
}

takeCopy();
