// A short-lived cache of replies, so asking again soon is instant: pages
// opened over a screen (channel, playlist, Watch later: main.ts openPage),
// whether fetched on demand or ahead (a channel reply is ~1 MB and takes
// over a second), search results, tile menus, video details, SponsorBlock
// segments. Each kind has its own Keeper with its own age and size limits.
// Replies a caller may mutate are stored as JSON and each caller gets a
// fresh copy; failed replies are not kept. Account replies are dropped by
// forgetKept() when the account writes or changes.

/** Keepers holding account replies */
var ofAccount: Keeper<unknown>[] = [];

export class Keeper<T> {
    private kept: { key: string; at: number; value: Promise<unknown> }[] = [];

    /** Keeps up to count replies for ms. copies: each caller gets its own copy (else the shared value);
     * account: cleared by forgetKept() */
    constructor(private ms: number, private count: number, private copies: boolean, account: boolean) {
        if (account) {
            ofAccount.push(this as Keeper<unknown>);
        }
    }

    /** The cached reply for key while fresh, else ask() and cache it */
    get(key: string, ask: () => Promise<T>): Promise<T> {
        return this.taken(this.entry(key, this.kind(ask)));
    }

    /** As get, with ask() returning JSON text (for a copies keeper, e.g. from the worker; no re-stringify) */
    getJson(key: string, ask: () => Promise<string>): Promise<T> {
        return this.taken(this.entry(key, ask));
    }

    /** Prefetches key's reply for a later get (nothing copied now) */
    ahead(key: string, ask: () => Promise<T>): void {
        this.entry(key, this.kind(ask)).then(null, function () { return undefined; });
    }

    /** As ahead, with ask() returning JSON text */
    aheadJson(key: string, ask: () => Promise<string>): void {
        this.entry(key, ask).then(null, function () { return undefined; });
    }

    forget(): void {
        this.kept = [];
    }

    /** Drops key's reply so the next get fetches it again */
    drop(key: string): void {
        this.kept = this.kept.filter(function (e) { return e.key !== key; });
    }

    /** Wraps ask() to store JSON text when this keeper hands out copies */
    private kind(ask: () => Promise<T>): () => Promise<unknown> {
        return this.copies ? function () { return ask().then(function (v) { return JSON.stringify(v); }); } : ask;
    }

    /** The caller's value: a fresh copy (copies), else the stored one */
    private taken(value: Promise<unknown>): Promise<T> {
        return this.copies ? value.then(function (text) { return JSON.parse(text as string) as T; }) : value as Promise<T>;
    }

    private entry(key: string, ask: () => Promise<unknown>): Promise<unknown> {
        var self = this;
        var now = Date.now();
        this.kept = this.kept.filter(function (e) { return now - e.at < self.ms; });
        var had = this.kept.filter(function (e) { return e.key === key; })[0];
        if (had) {
            return had.value;
        }
        var made = { key: key, at: now, value: ask() };
        this.kept.push(made);
        if (this.kept.length > this.count) {
            this.kept.shift();
        }
        made.value.then(null, function () {
            self.kept = self.kept.filter(function (e) { return e !== made; });
        });
        return made.value;
    }
}

/** Clears all account replies (after an account write or account change) */
export function forgetKept(): void {
    ofAccount.forEach(function (k) { k.forget(); });
}
