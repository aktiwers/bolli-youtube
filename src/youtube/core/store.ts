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

export function save(key: string, value: unknown): void {
    try {
        window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch (e) {
        // storage full or disabled
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
