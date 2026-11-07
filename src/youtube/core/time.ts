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
