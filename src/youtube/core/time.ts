// Time helpers. No toLocale*String: on Chrome 38 every such call builds a new
// formatter (~10 ms).

/** n as two digits */
export function pad2(n: number): string {
    return n < 10 ? '0' + n : String(n);
}

/** The device's own wall-clock "hh:mm" for an instant */
export function localClock(ms: number): string {
    var d = new Date(ms);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

/** A duration as 1:05:09 or 5:09 */
export function clock(seconds: number): string {
    var s = Math.max(0, Math.floor(seconds || 0));
    var hours = Math.floor(s / 3600);
    var min = Math.floor(s / 60) % 60;
    return (hours ? hours + ':' + pad2(min) : String(min)) + ':' + pad2(s % 60);
}

/** "21:55" from "2026-10-21T21:55:00+02:00" (the time as written, no conversion) */
export function clockFromLocalIso(iso: string | undefined): string {
    return iso && iso.length >= 16 ? iso.substr(11, 5) : '';
}

/** 0..1 of how far now is between start and end */
export function progress(startMs: number, endMs: number, nowMs: number): number {
    if (!(endMs > startMs)) {
        return 0;
    }
    var p = (nowMs - startMs) / (endMs - startMs);
    return p < 0 ? 0 : p > 1 ? 1 : p;
}

/** YYYY-MM-DD of an instant in UTC */
export function utcDate(ms: number): string {
    var d = new Date(ms);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
}

/** Tries made by itself after a failure, with an end: the first firstMs after it began, each next one twice as long
 * after the one before (maxMs at most), and no more than `most` of them until it begins anew */
export class Retries {
    private made = 0;
    private next = 0;

    constructor(private firstMs: number, private maxMs: number, private most: number) {}

    /** Whether a try is due now (not counted: tried) */
    due(now: number): boolean {
        if (!this.next) {
            this.next = now + this.firstMs;
        }
        return this.made < this.most && now >= this.next;
    }

    /** A try was made now */
    tried(now: number): void {
        this.made++;
        this.next = now + Math.min(this.maxMs, this.firstMs * Math.pow(2, this.made));
    }

    /** Begins anew (it worked, the viewer acted, the network came back, another thing is tried) */
    anew(): void {
        this.made = 0;
        this.next = 0;
    }

    /** How many tries were made since it began */
    get count(): number {
        return this.made;
    }
}

/** A cap on how often something is done: at most max times within any ms */
export class Rate {
    private times: number[] = [];

    constructor(private max: number, private ms: number) {}

    /** Whether one more may be done now (counted if so) */
    take(): boolean {
        var now = Date.now();
        var ms = this.ms;
        this.times = this.times.filter(function (at) { return now - at < ms; });
        if (this.times.length >= this.max) {
            return false;
        }
        this.times.push(now);
        return true;
    }

    /** How many are counted (within ms of the last take) */
    get count(): number {
        return this.times.length;
    }

    /** Counts none any more */
    clear(): void {
        this.times = [];
    }
}
