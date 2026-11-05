// A short-lived cache of replies, so asking again soon is instant: pages
// opened over a screen (channel, playlist, Watch later: main.ts openPage),
// whether fetched on demand or ahead (a channel reply is ~1 MB and takes
// over a second), search results, tile menus, video details, SponsorBlock
// segments. Each kind has its own Keeper with its own age and size limits.
// Replies a caller may mutate are stored as JSON and each caller gets a
// fresh copy; failed replies are not kept. A full keeper drops the least
// recently used reply; expired ones are dropped each minute (pruneKept), so
// an idle keeper holds nothing through a long video. Account replies are
// dropped by forgetKept() when the account writes or changes.

/** All keepers, and those holding account replies */
var keepers: Keeper<unknown>[] = [];
var ofAccount: Keeper<unknown>[] = [];

export class Keeper<T> {
    /** Least recently used first */
    private kept: { key: string; at: number; value: Promise<unknown> }[] = [];

    /** Keeps up to count replies for ms. copies: each caller gets its own copy (else the shared value);
     * account: cleared by forgetKept() */
    constructor(private ms: number, private count: number, private copies: boolean, account: boolean) {
        keepers.push(this as Keeper<unknown>);
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

    /** Prefetches key's reply, ask() returning JSON text, for a later get (nothing copied now) */
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
        this.prune();
        var had = this.kept.filter(function (e) { return e.key === key; })[0];
        if (had) {
            this.kept.splice(this.kept.indexOf(had), 1);
            this.kept.push(had);
            return had.value;
        }
        var made = { key: key, at: Date.now(), value: ask() };
        this.kept.push(made);
        if (this.kept.length > this.count) {
            this.kept.shift();
        }
        made.value.then(null, function () {
            self.kept = self.kept.filter(function (e) { return e !== made; });
        });
        return made.value;
    }

    /** Drops expired replies */
    prune(): void {
        var self = this;
        var now = Date.now();
        this.kept = this.kept.filter(function (e) { return now - e.at < self.ms; });
    }
}

/** Drops expired replies from every keeper (called each minute: idle keepers let theirs go) */
export function pruneKept(): void {
    keepers.forEach(function (k) { k.prune(); });
}

/** Clears all account replies (after an account write or account change) */
export function forgetKept(): void {
    ofAccount.forEach(function (k) { k.forget(); });
}
