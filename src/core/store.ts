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
