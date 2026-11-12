// localStorage with versioned keys. Never throws: a full or unavailable
// storage only means the next start has no cache.

var PREFIX = 'bolli.v1.';

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
    try {
        window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
        return true;
    } catch (e) {
        return false;
    }
}

/** Removes key */
export function forget(key: string): void {
    try {
        window.localStorage.removeItem(PREFIX + key);
    } catch (e) {
        // storage unavailable
    }
}

/** Removes every key beginning with prefix */
export function forgetAll(prefix: string): void {
    try {
        var s = window.localStorage;
        for (var i = s.length - 1; i >= 0; i--) {
            var key = s.key(i);
            if (key && key.indexOf(PREFIX + prefix) === 0) {
                s.removeItem(key);
            }
        }
    } catch (e) {
        // storage unavailable
    }
}
