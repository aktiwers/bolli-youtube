// A SABR answer read as it comes, off the page's thread. Chrome 38's XMLHttpRequest has no streamed binary: an answer
// is read while it comes only as text (x-user-defined keeps each byte), and turning that text into bytes on the page
// held its thread for 2-3 s of a 4K start (each read costs as much as all the text so far, ~15 ms a megabyte on the
// TV, and ~33 ms a megabyte read for the first time), the appends and the picture with it. Here a worker does the
// request and the reading and hands the bytes over as they come (transferred, not copied). The workers are made in
// youtube.com's page (a worker of the app's own page is refused by the video servers: no cross-origin right, as the
// page has; seen on the TV), from a script of ours as a blob there. One request at a time each, and two of them kept
// at hand (POOL): a request cut short (a jump, the next video) may leave its worker turning megabytes of text into
// bytes, and the next request must not wait behind that (seen on the TV with one worker for all: its first bytes
// 2.5 s late), nor for a new worker to start (a jump's second request, 0.1-0.25 s). A worker is used again once its
// request is over: at its end, or when it has said it let a cut one go (within FREE_MS, else it is ended).
// What the engine gets is shaped as the XMLHttpRequest it would use (the events and fields it reads), with take() for
// the bytes that came since the last one.

import { oldEngine } from '../core/platform.js';

/** How the worker reads: whatever comes until `early` bytes are in (a resume start waits for a segment's header
 * there), then once a quarter, a half and all of `first` are in (a start's first piece: turned into bytes while the
 * rest of it comes), then each time as much again, `most` at most */
export interface StreamReads {
    early: number;
    first: number;
    most: number;
}

/** The request as the engine uses it: an XMLHttpRequest's events and fields, and take() */
export interface StreamRequest {
    status: number;
    timeout: number;
    reads: StreamReads;
    onprogress: ((e: { loaded: number }) => void) | null;
    onload: (() => void) | null;
    onerror: (() => void) | null;
    ontimeout: (() => void) | null;
    open(method: string, url: string): void;
    overrideMimeType(type: string): void;
    send(body: ArrayBuffer): void;
    abort(): void;
    addEventListener(type: string, listener: () => void): void;
    /** The bytes that came since the last take, in order */
    take(): Uint8Array[];
    /** The answer is to be read once this many bytes of it are in (where a start's first piece or the segment coming
     * in is whole), whatever the worker's own steps */
    readAt(bytes: number): void;
    /** How long after the worker sent the request its first bytes came (ms; -1: none yet), for the play log */
    first: number;
}

/** Workers kept at hand: one for a request, one for the request that takes its place before it has let go */
var POOL = 2;

/** A worker missing from those at hand is made this long after one was taken (ms): off that request's own moment */
var SPARE_MS = 1500;

/** A worker whose request was cut short is used again if it says within this long that it let it go (ms); else it is
 * busy with what it read, and ended */
var FREE_MS = 200;

/** A lull this long in an answer's coming has the worker hand over what it has (ms): an answer the server holds open
 * after a small segment would else wait for bytes that do not come */
var LULL_MS = 250;

/** The worker looks at what has come this often while its request runs (ms): the browser tells of an answer's
 * progress only every 50 ms, and its first telling comes before any text is there (the headers then came a tenth of a
 * second late) */
var LOOK_MS = 10;

/** Once the first piece is read, the answer is looked at this often (ms): its next reads are megabytes apart, and the
 * page says at once where a segment is whole (readAt) */
var CALM_MS = 50;

/** A progress with no bytes is told to the page at most this often (ms): the page watches it for a stall, over
 * seconds; the bytes' own messages tell of progress too */
var PROGRESS_MS = 250;

/** The worker's script: one request at a time (n: its number, told back with all that is said of it), its text
 * looked at every LOOK_MS and read when due (its own steps, or where the page says a piece is whole: readAt; or after
 * a lull), the new bytes posted (transferred); every progress told (the page watches for a stall), the end with the
 * status, a failure as 'error' or 'timeout'; a request cut short (abort) is let go and said free. The text's chars
 * become bytes in a function of its own, four at a time: a loop inside the handler ran six times slower on the TV
 * (the browser compiles only plain functions for speed); run a few times at the worker's start, so that it is
 * compiled before the first answer. */
var SCRIPT = [
    'function bytes(s, from, to) {',
    '  var n = to - from, b = new Uint8Array(n), i = 0, m = n - 3;',
    '  for (; i < m; i += 4) { b[i] = s.charCodeAt(from + i); b[i + 1] = s.charCodeAt(from + i + 1); b[i + 2] = s.charCodeAt(from + i + 2); b[i + 3] = s.charCodeAt(from + i + 3); }',
    '  for (; i < n; i++) { b[i] = s.charCodeAt(from + i); }',
    '  return b;',
    '}',
    '(function () { var w = "", i; for (i = 0; i < 16384; i++) { w += String.fromCharCode(0xf700 + (i & 255)); } for (i = 0; i < 6; i++) { bytes(w, 0, w.length); } })();',
    'var s = null;',
    'function over() { clearInterval(s.timer); s = null; }',
    'function drop() { var x = s.x; over(); x.onprogress = x.onload = x.onerror = x.ontimeout = null; try { x.abort(); } catch (e) {} }',
    'onmessage = function (e) {',
    '  var m = e.data;',
    '  if (m.readAt !== undefined) {',
    '    if (s && s.n === m.n) { s.hint = m.readAt; s.look(false); }',
    '    return;',
    '  }',
    '  if (m.abort !== undefined) {',
    '    if (s && s.n === m.abort) { drop(); }',
    '    postMessage({ n: m.abort, free: true });',
    '    return;',
    '  }',
    '  if (s) { drop(); }',
    '  var x = new XMLHttpRequest();',
    '  var n = m.n;',
    '  var mine = s = { n: n, x: x, read: 0, due: 0, hint: 0, seen: 0, grew: 0, timer: 0, look: null, sent: Date.now(), told: 0, calm: false };',
    '  var ok = function () { return x.status >= 200 && x.status < 300; };',
    '  mine.look = function (all) {',
    '    var got = x.responseText, to = got.length, now = Date.now();',
    '    if (to !== mine.seen) { mine.seen = to; mine.grew = now; }',
    '    if (to > mine.read && (all || to >= mine.due || mine.hint > mine.read && to >= mine.hint || now - mine.grew >= ' + LULL_MS + ')) {',
    '      var b = bytes(got, mine.read, to);',
    '      mine.read = to;',
    '      mine.due = to < m.early ? 0 : to < m.first ? Math.min(m.first, Math.max(2 * to, m.first >> 2)) : to + Math.min(m.most, to);',
    '      mine.told = now;',
    '      postMessage({ n: n, status: x.status, bytes: b.buffer, loaded: to, after: now - mine.sent }, [b.buffer]);',
    '    }',
    '  };',
    '  x.open("POST", m.url, true);',
    '  x.overrideMimeType("text/plain; charset=x-user-defined");',
    '  x.timeout = m.timeout;',
    '  x.onprogress = function (p) { var now = Date.now(); if (s === mine && now - mine.told >= ' + PROGRESS_MS + ') { mine.told = now; postMessage({ n: n, status: x.status, loaded: p.loaded }); } };',
    '  x.onload = function () {',
    '    if (s !== mine) { return; }',
    '    if (ok()) { mine.look(true); }',
    '    over();',
    '    postMessage({ n: n, status: x.status, done: true });',
    '  };',
    '  x.onerror = function () { if (s === mine) { over(); postMessage({ n: n, failed: "error" }); } };',
    '  x.ontimeout = function () { if (s === mine) { over(); postMessage({ n: n, failed: "timeout" }); } };',
    '  var tick = function () { if (s === mine && x.readyState >= 3 && ok()) { mine.look(false); if (!mine.calm && mine.read >= m.first) { mine.calm = true; clearInterval(mine.timer); mine.timer = setInterval(tick, ' + CALM_MS + '); } } };',
    '  mine.timer = setInterval(tick, ' + LOOK_MS + ');',
    '  x.send(m.body);',
    '};'
].join('\n');

interface Reply {
    n: number;
    status?: number;
    bytes?: ArrayBuffer;
    loaded?: number;
    /** (with bytes) ms since the worker sent the request */
    after?: number;
    done?: boolean;
    failed?: string;
    free?: boolean;
}

/** The workers of a page: how one is made there, those at hand, and how many are out with a request (or with a cut
 * one they have not let go yet) */
interface Workers {
    page: Window;
    idle: Worker[];
    out: number;
    make(): Worker;
}

var made: Workers | null = null;
/** take() with nothing new (not changed by its callers) */
var NONE: Uint8Array[] = [];
/** Making one failed (the page refused the blob, or has no workers): not tried again in this run. Never on webOS TV
 * 1.x-2.x's old engine: a worker made there from a blob asks with the app's own origin (file://), not the page's, and
 * the video servers refuse it */
var none = oldEngine();
var requests = 0;

/** A worker's end */
function end(worker: Worker): void {
    worker.onmessage = null;
    worker.onerror = null;
    try {
        worker.terminate();
    } catch (e) {
        // (its page gone with it)
    }
}

class Request implements StreamRequest {
    status = 0;
    timeout = 0;
    reads: StreamReads = { early: 0, first: 0, most: 0 };
    onprogress: ((e: { loaded: number }) => void) | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    ontimeout: (() => void) | null = null;
    first = -1;
    private n = ++requests;
    private url = '';
    private chunks: Uint8Array[] = [];
    private listeners: { [type: string]: (() => void)[] } = {};
    private over = false;
    private hint = -1;
    /** Cut short, its worker not yet heard to have let it go: the timer that ends that worker */
    private freeing = 0;

    constructor(private worker: Worker, private from: Workers) {
        var self = this;
        worker.onmessage = function (e: MessageEvent) { self.told(e.data as Reply); };
        worker.onerror = function () { self.lost(); };
    }

    open(_method: string, url: string): void {
        this.url = url;
    }

    overrideMimeType(): void {
        return undefined;
    }

    send(body: ArrayBuffer): void {
        // (the body is the worker's from here: a request is built anew for each ask)
        this.worker.postMessage({ n: this.n, url: this.url, body: body, timeout: this.timeout, early: this.reads.early, first: this.reads.first, most: this.reads.most }, [body]);
    }

    abort(): void {
        if (this.over) {
            return;
        }
        this.over = true;
        this.tell('loadend');
        // Its worker again once it says it let the request go; one busy with megabytes of it is ended instead
        var self = this;
        this.freeing = setTimeout(function () {
            self.freeing = 0;
            self.gone();
        }, FREE_MS) as unknown as number;
        this.worker.postMessage({ abort: this.n });
    }

    addEventListener(type: string, listener: () => void): void {
        (this.listeners[type] = this.listeners[type] || []).push(listener);
    }

    take(): Uint8Array[] {
        var chunks = this.chunks;
        if (!chunks.length) {
            return NONE;
        }
        this.chunks = [];
        return chunks;
    }

    readAt(bytes: number): void {
        if (!this.over && bytes !== this.hint) {
            this.hint = bytes;
            this.worker.postMessage({ n: this.n, readAt: bytes });
        }
    }

    /** A message of the worker's about this request */
    told(m: Reply): void {
        if (m.n !== this.n) {
            return;
        }
        if (m.free) {
            if (this.freeing) {
                clearTimeout(this.freeing);
                this.freeing = 0;
                this.back();
            }
            return;
        }
        if (this.over) {
            return;
        }
        this.status = m.status || this.status;
        if (m.bytes) {
            this.chunks.push(new Uint8Array(m.bytes));
            if (this.first < 0) {
                this.first = m.after || 0;
            }
        }
        if (m.failed) {
            this.done();
            var failed = m.failed === 'timeout' ? this.ontimeout : this.onerror;
            if (failed) {
                failed();
            }
            return;
        }
        this.tell('progress');
        if (this.onprogress && !m.done) {
            this.onprogress({ loaded: m.loaded || 0 });
        }
        if (m.done) {
            this.done();
            this.tell('load');
            if (this.onload) {
                this.onload();
            }
        }
    }

    /** The worker is gone: as a request that failed */
    lost(): void {
        clearTimeout(this.freeing);
        this.freeing = 0;
        var was = this.over;
        this.over = true;
        this.gone();
        if (!was) {
            this.tell('loadend');
            if (this.onerror) {
                this.onerror();
            }
        }
    }

    /** Over at the worker's own word (its end, a failure): the worker is free for the next request */
    private done(): void {
        this.over = true;
        this.back();
        this.tell('loadend');
    }

    /** Its worker back among those at hand (one more than are kept: ended) */
    private back(): void {
        var from = this.from;
        from.out--;
        if (made === from && from.idle.length < POOL) {
            this.worker.onmessage = null;
            this.worker.onerror = null;
            from.idle.push(this.worker);
        } else {
            end(this.worker);
        }
    }

    /** Its worker ended (busy with a cut request, or failed) */
    private gone(): void {
        this.from.out--;
        end(this.worker);
    }

    private tell(type: string): void {
        var all = this.listeners[type];
        for (var i = 0; all && i < all.length; i++) {
            all[i]();
        }
    }
}

/** A request whose answer a worker of page (youtube.com's) reads as it comes; null: no worker to be had there (the
 * page sends and reads it itself then) */
export function streamRequest(page: Window): StreamRequest | null {
    if (none) {
        return null;
    }
    if (made && made.page !== page) {
        // (another page: its workers and its blob went with the old one)
        made = null;
    }
    try {
        if (!made) {
            var w = page as unknown as { Worker: typeof Worker; Blob: typeof Blob; URL: typeof URL };
            var script = w.URL.createObjectURL(new w.Blob([SCRIPT], { type: 'text/javascript' }));
            made = { page: page, idle: [], out: 0, make: function () { return new w.Worker(script); } };
        }
        var mine = made;
        var worker = mine.idle.pop() || mine.make();
        mine.out++;
        // Those missing made ahead, off this request's own moment (also one this request's worker leaves missing, if
        // it is ended as busy with a cut request)
        setTimeout(function () {
            try {
                while (made === mine && mine.idle.length + mine.out < POOL) {
                    mine.idle.push(mine.make());
                }
            } catch (e) {
                // (made when asked for, or not at all: the page reads then)
            }
        }, SPARE_MS);
        return new Request(worker, mine);
    } catch (e) {
        none = true;
        return null;
    }
}
