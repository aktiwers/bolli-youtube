// YouTube's Lounge, the TV side of "Play on TV": phones and the TV talk through
// YouTube, the TV being a "screen" the phones join. Follows open-source
// receivers (yt-cast-receiver, SmartTube, vibecast, plaincast). The screen keeps
// a lasting id (a new one each time would fill the phone's cast list) and a
// lounge token (14 days, renewed after 13). It binds a channel (Google's
// BrowserChannel) whose back channel streams the phones' commands; its own
// messages go one numbered request at a time. A phone's pairing code (from its
// cast, via LG's DIAL server) is registered as soon as the channel opens, before
// the phone gives up. Requests go from the hidden youtube.com page; no sign-in.

import { load, save } from '../../core/store.js';
import { answer, jsonEnd, randomText, uuid, youtubePage } from './youtube.js';

var PAIRING = '/api/lounge/pairing/';
var BIND = '/api/lounge/bc/bind';
var KEY = 'youtube.lounge';
/** As YouTube's TV app: its app id and capabilities (without them no commands come) */
var APP = 'lb-v4';
var CAPABILITIES = 'dsp,mic,dpa';
var NAME = 'Bolli YouTube';
/** Token renewal interval when YouTube does not give one */
var TOKEN_REFRESH_MS = 13 * 24 * 3600 * 1000;
/** The back channel is reopened after this long without data */
var WATCHDOG_MS = 60000;
/** Failures in a row before binding a new channel, and the retry wait (doubled per failure, up to RETRY_MAX_MS) */
var RETRIES = 3;
var RETRY_MS = 5000;
/** A back channel that ends sooner than this is reopened only after a wait */
var BRIEF_MS = 1000;
/** A channel YouTube refuses this soon after it was bound is not bound again at once (it waits as any failure) */
var REBIND_MS = 30000;
var RETRY_MAX_MS = 5 * 60000;

/** The screen's stored state */
interface Kept {
    deviceId: string;
    screenId: string;
    token: string;
    refreshAt: number;
}

interface Message {
    sc: string;
    fields: { [name: string]: string };
}

interface Reply {
    status: number;
    text: string;
}

export class Lounge {
    /** Called with a phone's command (its name and fields) */
    onCommand: (name: string, fields: { [name: string]: string }) => void = function () { return undefined; };
    private kept: Kept;
    /** The start (screen registered, channel opening; null: not started, or it failed) */
    private starting: Promise<void> | null = null;
    /** When the back channel was last opened (one that ends at once is not reopened at once) */
    private listenedAt = 0;
    /** Channel state: session ids, the last array id seen, the next request number, the next message offset */
    private sid = '';
    private gsid = '';
    private aid = -1;
    private rid = 0;
    private ofs = 0;
    /** Queued messages, and those in flight (resent on failure) */
    private queue: Message[] = [];
    private sending: Message[] | null = null;
    private back: XMLHttpRequest | null = null;
    /** How far the back channel's text is read */
    private read = 0;
    private watchdog = 0;
    private failures = 0;
    private retryTimer = 0;
    /** When the channel was last bound */
    private boundAt = 0;
    private flushTimer = 0;
    /** Incremented per channel, so late answers for an old one are dropped */
    private gen = 0;
    /** A pairing code to register once the channel is open */
    private pairing = '';

    constructor() {
        this.kept = load<Kept>(KEY) || { deviceId: uuid(), screenId: '', token: '', refreshAt: 0 };
        save(KEY, this.kept);
    }

    /** The screen's id and its device id ('' screen before the first start) */
    get screen(): { screenId: string; deviceId: string } {
        return { screenId: this.kept.screenId, deviceId: this.kept.deviceId };
    }

    /** The data LG's DIAL server gives phones (they can join the screen with it directly) */
    get dialData(): string {
        var k = this.kept;
        return k.screenId && k.token ? form({ screenId: k.screenId, theme: 'cl', deviceId: k.deviceId, loungeToken: k.token,
            loungeTokenRefreshIntervalMs: String(TOKEN_REFRESH_MS) }) : '';
    }

    /** Registers the screen and opens its channel (once; concurrent callers share the same start; if it fails, it is
     * tried again as any failure) */
    start(): Promise<void> {
        if (!this.starting) {
            var self = this;
            this.starting = this.reopen();
            // Back in front (e.g. the TV woke up): no wait for a retry
            document.addEventListener('visibilitychange', function () {
                if (!document.hidden) {
                    self.wake();
                }
            });
        }
        return this.starting;
    }

    /** Registers a phone's pairing code (from its cast) once the channel is open; if waiting to retry after failures,
     * opens it now, as the phone gives up soon */
    pair(code: string): void {
        this.pairing = code;
        if (this.retryTimer) {
            this.wake();
        } else if (this.sid) {
            this.register();
        }
    }

    /** A code to enter in a phone's YouTube app (Settings › Watch on TV › Enter TV code), for phones on another
     * network: 12 digits, valid for about 5 minutes */
    linkCode(): Promise<string> {
        var k = this.kept;
        // Waiting to retry (e.g. the start failed): now, as someone waits for the code
        return (this.retryTimer ? this.wake() : this.start()).then(function () {
            if (!k.token) {
                throw new Error('no screen');
            }
            return request('POST', PAIRING + 'get_pairing_code?ctx=pair', form({
                access_type: 'permanent', app: APP, lounge_token: k.token, screen_id: k.screenId, screen_name: NAME, device_id: k.deviceId
            }));
        }).then(function (r) {
            var code = r.text.replace(/\D/g, '');
            if (r.status !== 200 || code.length !== 12) {
                throw new Error('no code');
            }
            return code;
        });
    }

    /** Queues a message to the phones (sent in one request with others queued in the same tick) */
    send(sc: string, fields?: { [name: string]: string }): void {
        this.queue.push({ sc: sc, fields: fields || {} });
        var self = this;
        if (!this.flushTimer) {
            this.flushTimer = setTimeout(function () {
                self.flushTimer = 0;
                self.flush();
            }, 0) as unknown as number;
        }
    }

    // ---- the screen

    /** Ensures the screen id (made once) and its lounge token (renewed when due; a new id if YouTube no longer knows
     * the old one) */
    private identity(fresh?: boolean): Promise<void> {
        var k = this.kept;
        var self = this;
        var id: Promise<string> = k.screenId && !fresh ? Promise.resolve(k.screenId) : request('GET', PAIRING + 'generate_screen_id', null).then(function (r) {
            var made = r.text.trim();
            if (r.status !== 200 || !/^[a-z0-9]+$/i.test(made)) {
                throw new Error('no screen id');
            }
            k.screenId = made;
            k.token = '';
            save(KEY, k);
            return made;
        });
        return id.then(function (screenId) {
            if (k.token && Date.now() < k.refreshAt) {
                return undefined;
            }
            return request('POST', PAIRING + 'get_lounge_token_batch', form({ screen_ids: screenId })).then(function (r) {
                var screen = r.status === 200 ? (JSON.parse(r.text).screens || [])[0] : null;
                if (!screen || !screen.loungeToken) {
                    // Unknown screen: make a new id. Not on a transient error (429, 5xx): phones paired by code keep
                    // using this id, and retry() handles the wait
                    if (!fresh && (r.status === 200 || r.status === 400 || r.status === 404)) {
                        return self.identity(true);
                    }
                    throw new Error('no lounge token');
                }
                k.token = screen.loungeToken;
                k.refreshAt = Date.now() + (+screen.refreshIntervalMs || TOKEN_REFRESH_MS);
                save(KEY, k);
                return undefined;
            });
        });
    }

    /** Registers the pending pairing code with this screen (the phone then joins the lounge) */
    private register(): void {
        var code = this.pairing;
        var k = this.kept;
        this.pairing = '';
        request('POST', PAIRING + 'register_pairing_code', form({
            access_type: 'permanent', app: APP, pairing_code: code, screen_id: k.screenId, screen_name: NAME, device_id: k.deviceId
        })).then(null, function () { return undefined; });
    }

    // ---- the channel

    /** The bind URL with the parameters every channel request carries, plus extra */
    private params(extra: { [name: string]: string }): string {
        var p: { [name: string]: string } = {
            device: 'LOUNGE_SCREEN', id: this.kept.deviceId, name: NAME, app: APP, theme: 'cl', capabilities: CAPABILITIES,
            mdxVersion: '2', loungeIdToken: this.kept.token, VER: '8', v: '2', t: '1', zx: randomText(12, 'abcdefghijklmnopqrstuvwxyz0123456789')
        };
        for (var name in extra) {
            p[name] = extra[name];
        }
        return BIND + '?' + form(p);
    }

    /** Binds a new channel: reads its ids (and any commands with them), then opens the back channel and sends the
     * queue */
    private bind(): void {
        var gen = ++this.gen;
        var self = this;
        this.boundAt = Date.now();
        this.close();
        this.sid = this.gsid = '';
        this.aid = -1;
        this.ofs = 0;
        this.rid = Math.floor(Math.random() * 90000) + 10000;
        // Requeue messages in flight; they are renumbered
        if (this.sending) {
            this.queue = this.sending.concat(this.queue);
            this.sending = null;
        }
        request('POST', this.params({ RID: String(this.rid++), CVER: '1' }), form({ count: '0' })).then(function (r) {
            if (gen !== self.gen) {
                return;
            }
            if (r.status === 401) {
                self.renew();
                return;
            }
            if (r.status !== 200) {
                self.retry(true);
                return;
            }
            self.read = 0;
            self.frames(r.text);
            if (gen !== self.gen) {
                return;
            }
            if (!self.sid) {
                self.retry(true);
                return;
            }
            if (self.pairing) {
                self.register();
            }
            self.listen();
            self.flush();
        }, function () {
            if (gen === self.gen) {
                self.retry(true);
            }
        });
    }

    /** Renews the token, then binds a new channel (at once the first time, after a wait if that failed too) */
    private renew(): void {
        this.kept.refreshAt = 0;
        if (this.failures) {
            this.retry(true);
        } else {
            this.failures++;
            this.reopen();
        }
    }

    /** Renews the token if due, then binds a new channel */
    private reopen(): Promise<void> {
        var self = this;
        return this.identity().then(function () { self.bind(); }, function () { self.retry(true); });
    }

    /** Waiting to retry after failures: a new channel now (also when the old one may still be known: messages in flight
     * go with the new one) */
    private wake(): Promise<void> {
        if (!this.retryTimer) {
            return Promise.resolve();
        }
        clearTimeout(this.retryTimer);
        this.retryTimer = 0;
        this.failures = 0;
        return this.reopen();
    }

    /** Opens the back channel: the phones' commands, read as the response grows */
    private listen(): void {
        var gen = this.gen;
        var self = this;
        youtubePage().then(function (w) {
            if (gen !== self.gen) {
                return;
            }
            var xhr = self.back = new (w as unknown as { XMLHttpRequest: typeof XMLHttpRequest }).XMLHttpRequest();
            xhr.open('GET', self.params({ RID: 'rpc', SID: self.sid, gsessionid: self.gsid, CI: '0', AID: String(self.aid), TYPE: 'xmlhttp' }));
            xhr.overrideMimeType('text/plain; charset=utf-8');
            self.read = 0;
            self.listenedAt = Date.now();
            // Each chunk as it arrives (Chrome tells every one this way)
            xhr.onreadystatechange = function () {
                // (not an old channel's, e.g. on its abort)
                if (gen !== self.gen || self.back !== xhr) {
                    return;
                }
                self.arm();
                if (xhr.readyState >= 3) {
                    // Data arrives: reset the failure count (not for a refusal's text)
                    if (xhr.responseText && xhr.status === 200) {
                        self.failures = 0;
                    }
                    self.frames(xhr.responseText);
                }
                // (frames may have bound a new channel meanwhile)
                if (xhr.readyState === 4 && gen === self.gen && self.back === xhr) {
                    self.back = null;
                    self.ended(xhr.status, xhr.responseText);
                }
            };
            xhr.send();
            self.arm();
        });
    }

    /** The back channel ended: reopen it at once (it ends now and then), bind a new channel, or wait */
    private ended(status: number, text: string): void {
        var next = afterEnd(status, text, Date.now() - this.listenedAt < BRIEF_MS);
        if (next === 'listen') {
            this.listen();
        } else if (next === 'renew') {
            this.renew();
        } else if (next === 'gone') {
            this.gone();
        } else {
            this.retry(status !== 200);
        }
    }

    /** YouTube no longer knows the channel: a new one at once, unless it refuses one just bound (then after a wait) */
    private gone(): void {
        if (Date.now() - this.boundAt >= REBIND_MS) {
            this.bind();
        } else {
            this.retry(true);
        }
    }

    /** After a failure: reopens the back channel after a wait, or binds a new channel after RETRIES failures (fresh: at
     * once; the old back channel goes now, else its end would count as another failure) */
    private retry(fresh: boolean): void {
        var self = this;
        if (fresh) {
            this.dropBack();
        }
        this.failures++;
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(function () {
            self.retryTimer = 0;
            if (fresh || self.failures >= RETRIES || !self.sid) {
                self.reopen();
            } else {
                self.listen();
            }
        }, Math.min(RETRY_MS * Math.pow(2, this.failures - 1), RETRY_MAX_MS) + Math.random() * RETRY_MS) as unknown as number;
    }

    /** Restarts the watchdog: no data for WATCHDOG_MS reopens the back channel */
    private arm(): void {
        var self = this;
        clearTimeout(this.watchdog);
        this.watchdog = setTimeout(function () {
            if (self.dropBack()) {
                self.retry(false);
            }
        }, WATCHDOG_MS) as unknown as number;
    }

    /** Ends the channel's timers (a resend's too: the new channel sends the queue) and its back channel */
    private close(): void {
        clearTimeout(this.watchdog);
        clearTimeout(this.retryTimer);
        clearTimeout(this.flushTimer);
        this.retryTimer = this.flushTimer = 0;
        this.dropBack();
    }

    /** Aborts the back channel (false: there was none) */
    private dropBack(): boolean {
        var old = this.back;
        this.back = null;
        if (old) {
            old.abort();
        }
        return !!old;
    }

    /** Handles the unread arrays in a channel's text (length-prefixed JSON chunks, delimited by their brackets) */
    private frames(text: string): void {
        // A "stop" binds a new channel; the rest of this text belongs to the old one
        var gen = this.gen;
        while (gen === this.gen) {
            var at = this.read;
            while (at < text.length && ' \r\n\t'.indexOf(text.charAt(at)) >= 0) {
                at++;
            }
            var line = text.indexOf('\n', at);
            if (line < 0 || !/^\d+$/.test(text.substring(at, line))) {
                return;
            }
            var end = jsonEnd(text, line + 1);
            if (end < 0) {
                return;
            }
            this.read = end;
            var arrays: any[];
            try {
                arrays = JSON.parse(text.substring(line + 1, end));
            } catch (e) {
                // One that is not JSON is skipped; the channel reads on
                continue;
            }
            for (var i = 0; i < arrays.length && gen === this.gen; i++) {
                if (arrays[i] instanceof Array) {
                    this.array(arrays[i][0], arrays[i][1]);
                }
            }
        }
    }

    /** Handles one channel array (once each: ids at or below the last seen are old) */
    private array(id: number, m: any[]): void {
        if (typeof id !== 'number' || id <= this.aid || !m) {
            return;
        }
        this.aid = id;
        var name = m[0];
        if (name === 'c') {
            this.sid = m[1];
        } else if (name === 'S') {
            this.gsid = m[1];
        } else if (name === 'stop') {
            this.bind();
        } else if (name !== 'noop') {
            // One the app fails on is skipped: the channel goes on (it ended casting for the session)
            try {
                this.onCommand(name, m[1] || {});
            } catch (e) {
                // (cast.ts lists the commands heard)
            }
        }
    }

    /** Sends the queue, one request at a time (on failure: retried twice, then dropped if refused, or a new channel if
     * unanswered) */
    private flush(tries?: number): void {
        if (this.sending || !this.queue.length || !this.sid) {
            return;
        }
        var batch = this.sending = this.queue;
        this.queue = [];
        var body: { [name: string]: string } = { count: String(batch.length), ofs: String(this.ofs) };
        batch.forEach(function (m, i) {
            body['req' + i + '__sc'] = m.sc;
            for (var name in m.fields) {
                body['req' + i + '_' + name] = m.fields[name];
            }
        });
        var gen = this.gen;
        var rid = String(this.rid++);
        var self = this;
        var url = this.params({ SID: this.sid, gsessionid: this.gsid, RID: rid, AID: String(this.aid) });
        var tried = tries || 0;
        // Requeue and resend after a wait (with any messages queued meanwhile)
        var again = function (): void {
            self.sending = null;
            self.queue = batch.concat(self.queue);
            clearTimeout(self.flushTimer);
            self.flushTimer = setTimeout(function () {
                self.flushTimer = 0;
                self.flush(tried + 1);
            }, RETRY_MS * (tried + 1)) as unknown as number;
        };
        request('POST', url, form(body)).then(function (r) {
            if (gen !== self.gen) {
                return;
            }
            if (r.status === 200) {
                self.ofs += batch.length;
                self.sending = null;
                self.flush();
            } else if (r.status === 400 && /Unknown SID/i.test(r.text)) {
                self.gone();
            } else if (tried >= 2) {
                // YouTube does not accept them: drop them
                self.sending = null;
                self.flush();
            } else {
                self.rid--;
                again();
            }
        }, function () {
            if (gen !== self.gen) {
                return;
            }
            if (tried >= 2) {
                self.retry(true);
            } else {
                again();
            }
        });
    }
}

/** A request from the youtube.com page (path from /api/), form-encoded when it has a body */
function request(method: string, path: string, body: string | null): Promise<Reply> {
    return youtubePage().then(function (w) {
        return answer(w, method, path, body, body !== null ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {});
    });
}

export function form(fields: { [name: string]: string }): string {
    var out: string[] = [];
    for (var name in fields) {
        out.push(encodeURIComponent(name) + '=' + encodeURIComponent(fields[name]));
    }
    return out.join('&');
}

/** What the back channel's end calls for: reopen it ('listen'; one that ended within a second, or was refused, waits
 * first, to avoid a storm of reconnects), renew the token, a new channel (YouTube no longer knows it: 'gone'), or a
 * wait */
export function afterEnd(status: number, text: string, brief: boolean): 'listen' | 'renew' | 'gone' | 'wait' {
    if (status === 200 && !brief) {
        return 'listen';
    }
    if (status === 401) {
        return 'renew';
    }
    return status === 400 && /Unknown SID/i.test(text) || status === 404 || status === 410 ? 'gone' : 'wait';
}
