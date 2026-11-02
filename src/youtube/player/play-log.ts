// A short log of recent player events, for diagnosing a start that went wrong
// (e.g. another video showing briefly before the chosen one): starts, previews,
// the pipeline handed over (what its buffers still held) and emptied, and the
// picture starting to move (what was buffered then). Read in DevTools as
// __bolli.playLog: entries [ms since the app started, what, details], the last
// LOG_MAX. A few entries per start.

var LOG_MAX = 150;

/** Adds an entry: what happened, and its details */
export function note(what: string, detail?: string): void {
    var b = (window as any).__bolli;
    if (!b) {
        return;
    }
    var log: (string | number)[][] = b.playLog || (b.playLog = []);
    log.push([Date.now() - b.start, what, detail || '']);
    if (log.length > LOG_MAX) {
        log.shift();
    }
}

/** A buffer's ranges, as "0.0-9.1 12.0-15.5" ('-' none) */
export function ranges(b: TimeRanges): string {
    var out: string[] = [];
    for (var i = 0; i < b.length; i++) {
        out.push(b.start(i).toFixed(1) + '-' + b.end(i).toFixed(1));
    }
    return out.join(' ') || '-';
}
