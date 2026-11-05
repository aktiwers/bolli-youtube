// Parses large YouTube replies off the main thread. A channel page is
// 0.5-1.4 MB; parsing it and building its rows blocks the page 0.3-0.5 s on
// the TV, which also delays key presses while a prefetched page arrives.
// A worker (parse.js, from src/youtube/parse-worker.ts) parses the text and
// builds the rows; they come back as JSON, which is quicker to read than a
// structured-cloned object (~160 ms). The worker starts when a request is
// made, so it is ready for the reply, and is terminated after idling to free
// its memory. Without a worker, the work runs on the main thread.

/** The worker's script, beside index.html */
var SCRIPT = 'parse.js';
/** The worker is terminated after idling this long */
var IDLE_MS = 60000;
/** A reply not back by then (app visible) marks the worker as stuck; pending work then runs here */
var ANSWER_MS = 10000;

/** For DevTools (__bolli.offThread): recent replies' kind, size (KB), parse and build time in the worker, and round
 * trip (ms) */
export var offThreadStats = { answers: [] as (string | number)[][] };
var STATS_KEPT = 20;

interface Asked {
    kind: string;
    kb: number;
    at: number;
    ok: (json: string) => void;
    fail: (error: unknown) => void;
    /** Builds the result on the main thread instead */
    here: () => string;
    timer: number;
}

var worker: Worker | null = null;
/** The worker failed: all work runs on the main thread from then on */
var failed = false;
var asked: { [id: number]: Asked } = {};
var count = 0;
var idleTimer = 0;

/** The JSON of data handed over, without YouTube's tracking fields (nothing reads them; a quarter of a channel page's
 * rows). They are deleted from the data first: a JSON.stringify replacer takes the TV's browser off its fast path
 * (4x slower) */
export function dataJson(data: unknown): string {
    if (data && typeof data === 'object') {
        dropTracking(data);
    }
    return JSON.stringify(data);
}

function dropTracking(o: any): void {
    if (o.clickTrackingParams !== undefined) {
        delete o.clickTrackingParams;
    }
    if (o.trackingParams !== undefined) {
        delete o.trackingParams;
    }
    if (o.loggingDirectives !== undefined) {
        delete o.loggingDirectives;
    }
    for (var k in o) {
        if (o[k] && typeof o[k] === 'object') {
            dropTracking(o[k]);
        }
    }
}

/** Turns asked (a reply's JSON text) into the app's data with the worker's maker named kind, given arg (or with make,
 * the same function, when there is no worker). Returns JSON, which callers store as is (kept-pages.ts getJson,
 * page-store.ts) */
export function offThreadJson(asked: Promise<string>, kind: string, make: (reply: any, arg: string) => unknown, arg?: string): Promise<string> {
    // Start now so the worker is ready when the reply arrives
    started();
    clearTimeout(idleTimer);
    return asked.then(function (text) {
        var here = function (): string {
            return dataJson(make(JSON.parse(text), arg || ''));
        };
        var w = started();
        return w ? ask(w, text, kind, arg || '', here) : here();
    }, function (e) {
        // Request failed: start the idle timer as after a reply
        idle();
        throw e;
    });
}

/** As offThreadJson, parsed into the app's object */
export function offThread<T>(asked: Promise<string>, kind: string, make: (reply: any, arg: string) => T, arg?: string): Promise<T> {
    return offThreadJson(asked, kind, make, arg).then(function (json) { return JSON.parse(json) as T; });
}

/** Sends text to worker w; resolves with its result */
function ask(w: Worker, text: string, kind: string, arg: string, here: () => string): Promise<string> {
    clearTimeout(idleTimer);
    var id = ++count;
    return new Promise<string>(function (ok, fail) {
        asked[id] = { kind: kind, kb: Math.round(text.length / 1024), at: Date.now(), ok: ok, fail: fail, here: here, timer: overdue(id) };
        w.postMessage({ id: id, kind: kind, text: text, arg: arg });
    });
}

/** Timer for request id: no reply within ANSWER_MS means the worker is stuck. While the app is hidden the TV may
 * pause the worker, so the timer restarts instead */
function overdue(id: number): number {
    return setTimeout(function () {
        var a = asked[id];
        if (a && document.hidden) {
            a.timer = overdue(id);
        } else if (a) {
            broke();
        }
    }, ANSWER_MS) as unknown as number;
}

/** The worker, started if needed (null: unavailable) */
function started(): Worker | null {
    if (!worker && !failed) {
        try {
            worker = new Worker(SCRIPT);
            worker.onmessage = answered;
            worker.onerror = broke;
        } catch (e) {
            failed = true;
        }
    }
    return worker;
}

function answered(e: MessageEvent): void {
    var m = e.data;
    var a = asked[m.id];
    if (!a) {
        return;
    }
    delete asked[m.id];
    clearTimeout(a.timer);
    if (m.error !== undefined) {
        a.fail(new Error(m.error));
    } else {
        a.ok(m.json);
    }
    var list = offThreadStats.answers;
    list.push([a.kind, a.kb].concat(m.took || []).concat([Date.now() - a.at]));
    if (list.length > STATS_KEPT) {
        list.shift();
    }
    idle();
}

/** With nothing pending, terminates the worker after IDLE_MS */
function idle(): void {
    // No worker (none started, or none on this platform): nothing to end
    if (!worker || Object.keys(asked).length) {
        return;
    }
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () {
        if (worker) {
            worker.terminate();
            worker = null;
        }
    }, IDLE_MS) as unknown as number;
}

/** The worker failed (script did not load, threw, or a reply timed out): its pending work runs here */
function broke(): void {
    failed = true;
    if (worker) {
        worker.terminate();
        worker = null;
    }
    var left = asked;
    asked = {};
    for (var id in left) {
        var a = left[id];
        clearTimeout(a.timer);
        try {
            a.ok(a.here());
        } catch (e) {
            a.fail(e);
        }
    }
}
