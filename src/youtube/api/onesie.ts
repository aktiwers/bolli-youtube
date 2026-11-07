// YouTube's Onesie, as its TV player starts a signed-in video (its player script, read 2026-11-07; LuanRT's googlevideo
// onesie example): the player request goes encrypted inside one POST to a video server's /initplayback, which answers
// (UMP) with the player response; asked with no media here (the engine fetches that). A way innertube sends a request
// (onesie: youtube.ts Via), so its renewal of a refused token and its retry with fresh client details apply. The key
// and the request's address come from YouTube's TV config (onesieHotConfig: a client key, its copy encrypted for the
// server, renewed within 6 hours), the server from Google's redirector (kept SERVER_MS); both are dropped when a request
// through them fails. The inner request carries the sign-in as its Authorization header and a user agent of its own
// (api/streams.ts: a request from the page cannot set one). AES-128-CTR in plain JS (api/aes.ts: this TV's Web Crypto
// has none), HMAC-SHA256 by Web Crypto.

import { aesCtr } from './aes.js';
import { base64Bytes, bytes, fields, num, umpParts, Writer } from './sabr.js';
import { answer, Via, youtubePage } from './youtube.js';

/** YouTube's TV config (its app asks it at each start), whose living-room player config holds the hot config */
var CONFIG_PATH = '/tv_config?action_get_config=true&client=lb4&theme=cl';
/** The inner request's address, as YouTube's TV player names it */
var PLAYER_URL = 'https://youtubei.googleapis.com/youtubei/v1/player';
/** The key is taken anew this long before it expires (ms; at most half its life) */
var KEY_MARGIN_MS = 30 * 60 * 1000;
/** A config without a key is asked again only after this (ms; its shape changed: not on every start) */
var NO_KEY_MS = 10 * 60 * 1000;
/** The redirector's server is kept this long (ms; YouTube's player keeps its last one 10 days) */
var SERVER_MS = 6 * 3600 * 1000;
/** UMP parts and the Onesie header's type for the player response */
var ONESIE_HEADER = 10;
var ONESIE_DATA = 11;
var PLAYER_RESPONSE = 0;

interface HotConfig {
    aesKey: Uint8Array;
    /** The HMAC key, imported once */
    hmacKey: Promise<CryptoKey>;
    encryptedKey: Uint8Array;
    ustreamer: Uint8Array;
    baseUrl: string;
}

var hot: Promise<HotConfig> | null = null;
var hotUntil = 0;
var server: { base: string; url: Promise<string>; at: number } | null = null;

/** Drops the kept hot config and server (a restart of YouTube's page, as its app's restart asks them again) */
export function forgetOnesie(): void {
    hot = null;
    hotUntil = 0;
    server = null;
}

/** The hot config and the server ready (asked beside what else a start needs) */
export function prepareOnesie(): Promise<void> {
    return hotConfig().then(function (h) { return serverFor(h.baseUrl); }).then(function () { return undefined; });
}

/** Onesie as a way to send the player request (youtube.ts Via), as client as: its fields, and its user agent inside */
export function onesie(as: { [field: string]: string }): Via {
    return { as: as, send: function (w, path, json, headers) { return ask(w, json, headers, as); } };
}

/** The hot config (kept until shortly before its key expires; a failed ask again next time, one without a key after
 * NO_KEY_MS) */
function hotConfig(): Promise<HotConfig> {
    if (!hot || Date.now() > hotUntil) {
        hotUntil = Infinity;
        var asked = hot = youtubePage().then(function (w) {
            return answer(w, 'GET', CONFIG_PATH, null, {});
        }).then(function (r) {
            if (r.status !== 200) {
                throw new Error('TV config: HTTP ' + r.status);
            }
            var config = JSON.parse(r.text.replace(/^\)\]\}'\s*/, ''));
            var watch = config.webPlayerContextConfig && config.webPlayerContextConfig.WEB_PLAYER_CONTEXT_CONFIG_ID_LIVING_ROOM_WATCH;
            var h = watch && watch.onesieHotConfig;
            var key = h && h.clientKey ? base64Bytes(h.clientKey) : null;
            if (!key || key.length !== 32 || !h.encryptedClientKey || !h.baseUrl) {
                hotUntil = Date.now() + NO_KEY_MS;
                throw new Error('no Onesie key');
            }
            var life = (+h.keyExpiresInSeconds || 21600) * 1000;
            hotUntil = Date.now() + life - Math.min(KEY_MARGIN_MS, life / 2);
            var subtle = crypto.subtle || (crypto as unknown as { webkitSubtle: SubtleCrypto }).webkitSubtle;
            return {
                aesKey: key.subarray(0, 16),
                hmacKey: Promise.resolve(subtle.importKey('raw', key.subarray(16, 32), { name: 'HMAC', hash: { name: 'SHA-256' } } as any, false, ['sign'])),
                encryptedKey: base64Bytes(h.encryptedClientKey),
                ustreamer: base64Bytes(h.onesieUstreamerConfig || ''),
                baseUrl: h.baseUrl
            };
        });
        asked.then(null, function () {
            // (a config without a key stays refused until hotUntil)
            if (hot === asked && hotUntil === Infinity) {
                hot = null;
                hotUntil = 0;
            }
        });
    }
    return hot;
}

/** The video server for this TV's network, kept (SERVER_MS) or as Google's redirector names it (YouTube's player
 * asks it when it has none kept): its address with the redirector's ms and mm */
function serverFor(baseUrl: string): Promise<string> {
    if (!server || server.base !== baseUrl || Date.now() - server.at > SERVER_MS) {
        var asked = youtubePage().then(function (w) {
            return answer(w, 'GET', 'https://redirector.googlevideo.com' + baseUrl + '&alr=yes&id=' + Math.floor(Math.random() * 100000), null, {});
        }).then(function (r) {
            var to = r.text.replace(/\s+/g, '');
            var host = (/^https?:\/\/([^\/?#]+)/.exec(to) || [])[1] || '';
            if (r.status !== 200 || !/(\.c\.youtube\.com|\.googlevideo\.com)$/.test(host)) {
                throw new Error('Onesie: no server (HTTP ' + r.status + ')');
            }
            var extra = '';
            ['ms', 'mm'].forEach(function (name) {
                var v = new RegExp('[?&]' + name + '=([^&]*)').exec(to);
                if (v) {
                    extra += '&' + name + '=' + v[1];
                }
            });
            return 'https://' + host + baseUrl.replace(/([?&])(oad|ovd|oaad|oavd)=[^&]*/g, '$1$2=0') + extra;
        });
        server = { base: baseUrl, url: asked, at: Date.now() };
        asked.then(null, function () { drop(asked); });
    }
    return server.url;
}

/** Forgets the server (and the hot config: its key may be the cause) a request through them failed with */
function drop(used: Promise<string>, config?: boolean): void {
    if (server && server.url === used) {
        server = null;
        if (config) {
            hot = null;
            hotUntil = 0;
        }
    }
}

/** The player request (json, with its headers) sent by Onesie as client as: the player response's text; rejects as the
 * page's requests do (youtube.ts Via) */
function ask(w: Window, json: string, headers: { [name: string]: string }, as: { [field: string]: string }): Promise<string> {
    return hotConfig().then(function (h) {
        var used = serverFor(h.baseUrl);
        return used.then(function (base) {
            var body = JSON.parse(json);
            var inner = new Writer().string(1, PLAYER_URL);
            // (as YouTube's TV player names them: no client name or version)
            var all: { [name: string]: string } = { 'User-Agent': as.userAgent || '' };
            for (var name in headers) {
                if (!/^X-YouTube-Client-/.test(name)) {
                    all[name] = headers[name];
                }
            }
            for (var n in all) {
                inner.message(2, new Writer().string(1, n).string(2, all[n]));
            }
            inner.string(3, json);
            var iv = new Uint8Array(16);
            crypto.getRandomValues(iv);
            var sealed = aesCtr(h.aesKey, iv, new Uint8Array(inner.bytes));
            var signed = new Uint8Array(sealed.length + 16);
            signed.set(sealed, 0);
            signed.set(iv, sealed.length);
            var subtle = crypto.subtle || (crypto as unknown as { webkitSubtle: SubtleCrypto }).webkitSubtle;
            return h.hmacKey.then(function (k) {
                return subtle.sign({ name: 'HMAC' } as any, k, signed);
            }).then(function (mac) {
                var info = new Writer().string(12, as.deviceMake || '').string(13, as.deviceModel || '').varint(16, 7).string(17, as.clientVersion || '')
                    .string(18, as.osName || '').string(19, as.osVersion || '');
                var innertube = new Writer().data(2, sealed).data(5, h.encryptedKey).data(6, iv).data(7, new Uint8Array(mac)).varint(10, 1).varint(13, 1).varint(17, 1);
                var request = new Writer().message(2, new Writer().varint(28, 0)).message(3, innertube).data(4, h.ustreamer)
                    .message(10, new Writer().message(1, info));
                var url = base + '&id=' + hex(base64Bytes(String(body.videoId)).subarray(0, 8)) + '&cpn=' + encodeURIComponent(String(body.cpn || '')) + '&opr=1&por=1&rn=1';
                return answer(w, 'POST', url, new Uint8Array(request.bytes), { 'Content-Type': 'text/plain' }, true);
            }).then(function (r) {
                if (r.status !== 200) {
                    // (a server error asked again: streams.ts unanswered)
                    throw new Error('HTTP ' + r.status);
                }
                var res = playerResponse(new Uint8Array(r.data as ArrayBuffer), h.aesKey);
                if (res.proxy !== 1) {
                    throw new Error('Onesie: proxy ' + res.proxy);
                }
                if (res.status !== 200) {
                    // (as the page's: innertube renews a refused token, or asks with fresh client details)
                    var refusal = new Error('YouTube answered ' + res.status) as Error & { status: number };
                    refusal.status = res.status;
                    throw refusal;
                }
                return textOf(res.body);
            }).then(null, function (e: Error & { status?: number }) {
                // (YouTube's own refusal through them is no reason to drop them)
                if (!e.status) {
                    drop(used, /proxy|player response/.test(e.message));
                }
                throw e;
            });
        });
    });
}

function hex(b: Uint8Array): string {
    var out = '';
    for (var i = 0; i < b.length; i++) {
        out += (b[i] < 16 ? '0' : '') + b[i].toString(16);
    }
    return out;
}

/** UTF-8 bytes as text, by the browser (a reply of hundreds of KB: decoding it in JS takes this TV ~0.2-0.4 s) */
function textOf(b: Uint8Array): Promise<string> {
    return new Promise<string>(function (resolve, reject) {
        var reader = new FileReader();
        reader.onload = function () { resolve(reader.result as string); };
        reader.onerror = function () { reject(new Error('Onesie: no player response text')); };
        reader.readAsText(new Blob([b]));
    });
}

/** The player response in an /initplayback reply: the data after the player response's header (its parts joined),
 * decrypted unless the header says it is not, an OnesieInnertubeResponse: its proxy status, HTTP status and body */
export function playerResponse(reply: Uint8Array, aesKey: Uint8Array): { proxy: number; status: number; body: Uint8Array } {
    var header: { [field: number]: (number | Uint8Array)[] } | null = null;
    var data: Uint8Array[] = [];
    var size = 0;
    var parts = umpParts(reply);
    for (var i = 0; i < parts.length; i++) {
        var p = parts[i];
        if (p.type === ONESIE_HEADER) {
            if (data.length) {
                break;
            }
            header = num(fields(p.data), 1) === PLAYER_RESPONSE ? fields(p.data) : null;
        } else if (p.type === ONESIE_DATA && header) {
            data.push(p.data);
            size += p.data.length;
        }
    }
    if (!header || !data.length) {
        throw new Error('Onesie: no player response (parts ' + parts.map(function (part) { return part.type; }).join(',') + ')');
    }
    var all = data.length === 1 ? data[0] : new Uint8Array(size);
    if (data.length > 1) {
        for (var at = 0, k = 0; k < data.length; k++) {
            all.set(data[k], at);
            at += data[k].length;
        }
    }
    var crypt = fields(bytes(header, 4) || new Uint8Array(0));
    var plain = num(crypt, 7) ? all : aesCtr(aesKey, bytes(crypt, 5) || new Uint8Array(16), all);
    var res = fields(plain);
    return { proxy: num(res, 1), status: num(res, 2), body: bytes(res, 4) || new Uint8Array(0) };
}
