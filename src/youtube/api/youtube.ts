// YouTube's InnerTube API (the JSON its TV app uses), requested from a hidden
// youtube.com page: YouTube refuses requests from the app's own origin as
// automated, but answers its own origin, with the cookies the TV shares
// between apps. Client details (TV client, version, visitor id, OAuth clients)
// come from YouTube's /tv page and are cached. The sign-in and account list are
// the YouTube TV app's (in youtube.com's localStorage); expired tokens are
// renewed and stored the way that app does. A brand account is named in each
// request (X-Goog-PageId, onBehalfOfUser), else YouTube answers as its owner.

import { HttpError, parse, postJson, postText } from '../core/http.js';
import { language } from '../core/i18n.js';
import { mark } from '../core/perf.js';
import { oldEngine } from '../core/platform.js';
import { load, save } from '../core/store.js';

/** A small youtube.com page that may be framed (/tv may not) */
export var PAGE = 'https://www.youtube.com/robots.txt';
/** Id of the iframe in which index.html starts loading PAGE */
var STARTED_ID = 'youtube';
/** The TV client's number (X-YouTube-Client-Name) */
var TVHTML5 = '7';
var TIMEOUT_MS = 15000;
/** A request from the page not settled TIMEOUT_MS plus this long after it went fails as unanswered (its page gone) */
var GUARD_MS = 2000;
/** A token this close to expiry is not used (TOKEN_MARGIN_MS); tokens are renewed this early (RENEW_EARLY_MS) */
var TOKEN_MARGIN_MS = 60 * 1000;
var RENEW_EARLY_MS = 5 * 60 * 1000;
var IDENTITY_KEY = 'yt.leanback.default::last-identity-used';
var TOKENS_KEY = 'yt.leanback.default::cached-access-tokens';
var AVAILABLE_KEY = 'yt.leanback.default::available-identities';
var ACTIVITY_KEY = 'yt.leanback.default::identity-activity';
/** Cached client details (localStorage bolli.v1.youtube.client): used for up to CLIENT_KEEP_MS, refreshed in the
 * background after CLIENT_FRESH_MS */
var CLIENT_KEY = 'youtube.client';
var CLIENT_KEEP_MS = 7 * 24 * 3600 * 1000;
var CLIENT_FRESH_MS = 24 * 3600 * 1000;

/** An account as YouTube's TV app stores it: a Google account, or a brand account run by one (effective id: the
 * brand's; credentials: the Google account's) */
export interface Identity {
    identityType: string;
    identityCredentials: { [field: string]: unknown };
    effectiveObfuscatedGaiaId: string;
    ownerObfuscatedGaiaId: string;
    gaiaDelegationType: number;
}

/** What requests need from YouTube's /tv page: the client context, the API key and the OAuth clients (indexed by an
 * account's clientIdName, 0 or 1; null: not found) */
export interface Client {
    context: { client: TvClient };
    apiKey: string;
    oauth: ({ id: string; secret: string } | null)[];
}

/** YouTube's /tv page: its HTML (for player/tv-app.ts and the player script's path) and the client details */
export interface TvPage extends Client {
    html: string;
}

/** The client context from YouTube's /tv page (the fields used here) */
export interface TvClient {
    visitorData?: string;
    clientVersion?: string;
    hl?: string;
    gl?: string;
    deviceMake?: string;
    deviceModel?: string;
    osName?: string;
    osVersion?: string;
    browserName?: string;
    browserVersion?: string;
}

var page: Promise<Window> | null = null;
/** The window page gave (null: none yet) */
var pageWindow: Window | null = null;
var tv: Promise<TvPage> | null = null;
/** When the /tv page (and so the client details in use) was fetched (a run of days asks again after CLIENT_FRESH_MS:
 * the player version and client version move on) */
var tvAt = 0;
var client: Promise<Client> | null = null;
/** client came from the cache */
var clientKept = false;

/** The hidden youtube.com page: the frame index.html started, else a new one (made again after a failure, and when
 * the page it gave is gone: its requests would all go unanswered). Once it is loaded, the token's early renewal is
 * scheduled. */
export function youtubePage(): Promise<Window> {
    if (page && pageWindow && !alive(pageWindow)) {
        dropPage();
    }
    if (!page) {
        var started = document.getElementById(STARTED_ID) as HTMLIFrameElement | null;
        if (started) {
            started.removeAttribute('id');
            page = loaded(started).then(null, function () { return loaded(newFrame()); });
        } else {
            page = loaded(newFrame());
        }
        var made = page;
        made.then(function (w) {
            pageWindow = w;
            renewAhead(w);
        }, function () {
            if (page === made) {
                page = null;
            }
        });
    }
    return page;
}

/** The hidden page's frame removed (the next use makes a new one) */
function dropPage(): void {
    var gone = pageWindow;
    [].forEach.call(document.getElementsByTagName('iframe'), function (f: HTMLIFrameElement) {
        if (gone && f.contentWindow === gone && f.parentNode) {
            f.parentNode.removeChild(f);
        }
    });
    page = null;
    pageWindow = null;
}

/** YouTube asked its TV app to restart (a reply's "The YouTube app needs to restart", whose button reloads the page):
 * as that app reloads, the /tv page and its client details are asked again and the hidden youtube.com page made anew
 * for the next request */
export function restartPage(): void {
    tv = null;
    client = null;
    tvAt = 0;
    save(CLIENT_KEY, null);
    dropPage();
}

/** A frame for youtube.com's page, loading it */
function newFrame(): HTMLIFrameElement {
    var frame = document.createElement('iframe');
    // Scripts run and it keeps its origin, but it cannot navigate the app
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    frame.className = 'by-hidden';
    frame.src = PAGE;
    document.body.appendChild(frame);
    return frame;
}

/** True when e (an Error, or a NoStreams with the message as reason) means no answer came at all: the network is
 * down or youtube.com did not load, rather than YouTube refusing a request */
export function noAnswer(e: unknown): boolean {
    var failed = e as { message?: string; reason?: string } | null;
    return /did not (answer|load)/.test(failed ? String(failed.message || failed.reason || '') : '');
}

/** frame's window once loaded: at once if it already holds youtube.com (index.html's frame fires load only after the
 * app's script has run, ~150 ms late), else on load. Rejects and removes the frame if it is not youtube.com (a
 * failed load also fires load, with an error page). */
function loaded(frame: HTMLIFrameElement): Promise<Window> {
    return new Promise<Window>(function (resolve, reject) {
        var fail = function (): void {
            if (frame.parentNode) {
                frame.parentNode.removeChild(frame);
            }
            reject(new Error('youtube.com did not load'));
        };
        var timer = setTimeout(fail, TIMEOUT_MS);
        var done = function (): void {
            clearTimeout(timer);
            var w = usable(frame);
            if (w) {
                resolve(w);
            } else {
                fail();
            }
        };
        if (frame.getAttribute('data-loaded') || usable(frame)) {
            done();
        } else {
            frame.onload = done;
        }
    });
}

/** frame's window when it holds youtube.com's robots.txt with storage (null: not, or not yet) */
export function usable(frame: HTMLIFrameElement): Window | null {
    var w = frame.contentWindow as Window;
    if (w && alive(w)) {
        mark('frame');
        return w;
    }
    return null;
}

/** Whether w still holds youtube.com's robots.txt with storage (not if its frame was removed or went elsewhere) */
function alive(w: Window): boolean {
    try {
        return !w.closed && w.location.pathname === '/robots.txt' && !!w.localStorage;
    } catch (e) {
        // Cross-origin: not youtube.com
        return false;
    }
}

/** YouTube's /tv page dropped, so the next use fetches it again (one without what was looked for in it) */
export function forgetTvPage(): void {
    tv = null;
}

/** YouTube's /tv page, fetched once (again after a failure, or once a day old); its client details are cached */
export function tvPage(): Promise<TvPage> {
    if (tv && Date.now() - tvAt > CLIENT_FRESH_MS) {
        tv = null;
    }
    if (!tv) {
        tvAt = Date.now();
        tv = youtubePage().then(function (w) {
            return send(w, 'GET', '/tv', null, {});
        }).then(function (html) {
            var context = objectAt(html, '"INNERTUBE_CONTEXT":');
            var key = /"INNERTUBE_API_KEY":"([^"]+)"/.exec(html);
            if (!context || !context.client || !key) {
                throw new Error('YouTube\'s TV page has changed');
            }
            context.client.hl = english();
            mark('tvPage');
            var before = load<Partial<Client>>(CLIENT_KEY);
            var details: Client = { context: context, apiKey: key[1], oauth: oauthClients(html, before && before.oauth) };
            save(CLIENT_KEY, { context: details.context, apiKey: details.apiKey, oauth: details.oauth, at: Date.now() });
            // Later requests use these, so a long-running app does not keep a cached client for days (not the page's
            // HTML: kept only while the page is)
            client = Promise.resolve(details);
            clientKept = false;
            return { html: html, context: details.context, apiKey: details.apiKey, oauth: details.oauth };
        });
        tv.then(null, function () {
            tv = null;
        });
    }
    return tv;
}

/** The client details: the cached ones (refreshed in the background when a day old), else from the /tv page */
export function tvClient(): Promise<Client> {
    if (!client) {
        var kept = load<Client & { at: number }>(CLIENT_KEY);
        var age = kept && kept.context && kept.context.client && kept.apiKey && kept.oauth ? Date.now() - kept.at : Infinity;
        clientKept = age < CLIENT_KEEP_MS;
        if (clientKept) {
            kept!.context.client.hl = english();
            client = Promise.resolve(kept as Client);
            if (!tv) {
                tvAt = kept!.at;
            }
        } else {
            client = tvPage();
            client.then(null, function () {
                client = null;
            });
        }
    }
    // A day old (kept, or this run's): the /tv page again in the background, which updates it (tvPage starts the day
    // anew, also if that fails)
    if (tvAt && Date.now() - tvAt > CLIENT_FRESH_MS) {
        tvPage().then(null, function () { return undefined; });
    }
    return client;
}

/** The language YouTube is asked in for the requests not in SHOWN (the player, accounts, writes): English (the TV's own,
 * e.g. en-GB, when it is English), as the player's refusal reasons are read as English ones (api/streams.ts) */
function english(): string {
    var tvs = navigator.language || '';
    return /^en(-|$)/.test(tvs) ? tvs : 'en';
}

/** Requests whose texts the screens show (pages, search, a video's details and comments, the guide, panels, the
 * account's settings and playlists, live chat): asked in the app's language (youtubeLanguage) */
var SHOWN: { [endpoint: string]: boolean } = { browse: true, search: true, next: true, guide: true, get_panel: true, 'account/get_setting': true,
    'playlist/get_add_to_playlist': true, 'live_chat/get_live_chat': true };

/** The language YouTube is asked in for what the screens show: the app's (core/i18n.ts; its codes are YouTube's), the
 * TV's English when that is English */
export function youtubeLanguage(): string {
    return language() === 'en' ? english() : language();
}

/** Drops cached client details YouTube refused; the next request fetches the /tv page (the OAuth clients stay for
 * it: tvClient takes no record without the rest) */
function forgetClient(): void {
    client = null;
    // (and the page they came from: else the same details come back)
    tv = null;
    var kept = load<Partial<Client>>(CLIENT_KEY);
    save(CLIENT_KEY, kept && kept.oauth ? { oauth: kept.oauth } : null);
}

/** POST youtubei/v1/<endpoint> as the TV client, signed in when the YouTube TV app is */
export function innertube(endpoint: string, body: { [key: string]: unknown }): Promise<unknown> {
    return innertubeText(endpoint, body).then(JSON.parse);
}

/** innertube's reply as text, so parts can be read without parsing it all (objectAt) */
export function innertubeText(endpoint: string, body: { [key: string]: unknown }): Promise<string> {
    return ask(endpoint, body, freshSignIn);
}

/** How a request goes another way than the page's POST: as another TV client (its client fields in place of this TV's,
 * keeping its visitor id and languages), and/or sent by send (path, JSON body and headers as the page's POST has them;
 * resolves the reply text, rejects as the page's: non-2xx an Error with the status, no answer "YouTube did not answer"),
 * still with innertube's renewal of a refused token and its retry with fresh client details */
export interface Via {
    as?: { [field: string]: string };
    send?: (w: Window, path: string, json: string, headers: { [name: string]: string }) => Promise<string>;
}

/** innertube by another way (Via) */
export function innertubeVia(endpoint: string, body: { [key: string]: unknown }, via: Via): Promise<unknown> {
    return ask(endpoint, body, freshSignIn, false, via).then(JSON.parse);
}

/** innertube with a given token (an account just signed in, before it is stored) */
export function innertubeToken(token: string, endpoint: string, body: { [key: string]: unknown }): Promise<unknown> {
    return ask(endpoint, body, function () { return Promise.resolve({ token: token, channel: '' }); }).then(JSON.parse);
}

/** POST to Google's OAuth service from youtube.com, as YouTube's TV app sends it: with one of its OAuth clients (an
 * account's clientIdName: 0, used by new sign-ins, or 1; from the /tv page if the cache lacks it), plus its secret
 * when secret. Resolves to the status and the JSON reply (null: not JSON). */
export function oauth(path: string, fields: { [key: string]: string }, secret: boolean, which?: number): Promise<{ status: number; reply: any }> {
    var n = which === 1 ? 1 : 0;
    return Promise.all<any>([youtubePage(), tvClient().then(function (t) { return t.oauth[n] ? t : tvPage(); })]).then(function (got) {
        var client = (got[1] as Client).oauth[n];
        if (!client) {
            throw new Error('no TV client');
        }
        var body: { [key: string]: string } = { client_id: client.id };
        if (secret) {
            body.client_secret = client.secret;
        }
        for (var key in fields) {
            body[key] = fields[key];
        }
        return answer(got[0], 'POST', path, JSON.stringify(body), { 'Content-Type': 'application/json' }).then(function (r) {
            var reply = null;
            try {
                reply = JSON.parse(r.text);
            } catch (e) {
                // Not JSON: reply stays null
            }
            return { status: r.status, reply: reply };
        });
    });
}

/** innertube as another signed-in account (its token renewed first if expired; rejects without a sign-in) */
export function innertubeAs(identity: Identity, endpoint: string, body: { [key: string]: unknown }): Promise<unknown> {
    return ask(endpoint, body, function () {
        return youtubePage().then(function (w) {
            var last = identity as unknown as { [field: string]: unknown };
            return signInFor(w, last) || renew(w, identity);
        }).then(function (sign) {
            if (!sign) {
                throw new Error('no sign-in');
            }
            return sign;
        });
    }).then(JSON.parse);
}

/** An InnerTube request signed in as signedIn gives; renewed: asked again already after a refused token */
function ask(endpoint: string, body: { [key: string]: unknown }, signedIn: () => Promise<{ token: string; channel: string } | null>,
    renewed?: boolean, via?: Via): Promise<string> {
    var asked = tvClient();
    var kept = clientKept;
    return asked.then(function (t) {
        return Promise.all<any>([youtubePage(), signedIn()]).then(function (got) {
            var w = got[0] as Window;
            var sign = got[1] as { token: string; channel: string } | null;
            var headers = authHeaders(t, sign);
            headers['Content-Type'] = 'application/json';
            headers['X-YouTube-Client-Name'] = TVHTML5;
            headers['X-YouTube-Client-Version'] = t.context.client.clientVersion || '';
            var context = JSON.parse(JSON.stringify(t.context));
            if (SHOWN[endpoint]) {
                context.client.hl = youtubeLanguage();
            }
            var as = via && via.as;
            if (as) {
                var own = context.client;
                context.client = { clientName: own.clientName, visitorData: own.visitorData, hl: own.hl, gl: own.gl };
                for (var field in as) {
                    context.client[field] = as[field];
                }
                headers['X-YouTube-Client-Version'] = as.clientVersion || headers['X-YouTube-Client-Version'];
            }
            if (sign && sign.channel) {
                context.user = context.user || {};
                context.user.onBehalfOfUser = sign.channel;
            }
            body.context = context;
            var path = '/youtubei/v1/' + endpoint + '?key=' + t.apiKey + '&prettyPrint=false';
            var sent = via && via.send ? via.send(w, path, JSON.stringify(body), headers) : send(w, 'POST', path, JSON.stringify(body), headers);
            return sent.then(null, function (e) {
                // A cached client refused (YouTube changed it): retry with fresh details from the /tv page. Every
                // refused request retries; the first also drops the cache.
                if (kept && answeredWith(e, 400)) {
                    if (client === asked) {
                        forgetClient();
                    }
                    return ask(endpoint, body, signedIn, renewed, via);
                }
                // A token refused before its time: renewed (or the token a renewal since brought), then asked again, once
                if (sign && refusedToken(sign, e) && !renewed) {
                    var token = sign.token;
                    return signedIn().then(function (fresh) {
                        if (!fresh || fresh.token === token) {
                            throw e;
                        }
                        return ask(endpoint, body, signedIn, true, via);
                    }, function () {
                        // (no sign-in: the refusal is the reason)
                        throw e;
                    });
                }
                throw e;
            });
        });
    });
}

/** Sends a YouTube stats report (a play, watch time) as its TV app does: POST to youtube.com (path from /api/),
 * signed in. False when no one is signed in (nothing is sent). */
export function report(path: string): Promise<boolean> {
    return tvClient().then(function (t) {
        return Promise.all<any>([youtubePage(), freshSignIn()]).then(function (got) {
            var w = got[0] as Window;
            var sign = got[1] as { token: string; channel: string } | null;
            return sign ? send(w, 'POST', path, null, authHeaders(t, sign)).then(function () { return true; }, function (e) {
                // (the next request renews it)
                refusedToken(sign as { token: string }, e);
                throw e;
            }) : false;
        });
    });
}

/** Tokens YouTube refused before their time (revoked, or the TV's clock off after power-on): taken as expired, so the
 * first request after renews them and the rest find the new one. Only one such renewal per REFUSED_AGAIN_MS: YouTube
 * refusing the new token too is not about the token's age, and renewing on each request would not help. */
var refused: { [token: string]: boolean } = {};
var refusedAt = 0;
var REFUSED_AGAIN_MS = 5 * 60 * 1000;

/** Whether e is YouTube refusing sign's token (401); if so, the token is not used again (unless one was refused
 * lately) */
function refusedToken(sign: { token: string }, e: unknown): boolean {
    var is = answeredWith(e, 401);
    if (is && !refused[sign.token] && Date.now() - refusedAt > REFUSED_AGAIN_MS) {
        refused[sign.token] = true;
        refusedAt = Date.now();
    }
    return is;
}

/** Whether e is YouTube answering a request with status (send) */
function answeredWith(e: unknown, status: number): boolean {
    return !!e && (e as { status?: unknown }).status === status;
}

/** Renewals in progress (by account), and failed ones (by refresh token) with the time they may be retried
 * (refused: never for that refresh token) */
var renewing: { [account: string]: Promise<{ token: string; channel: string } | null> } = {};
var failed: { [refresh: string]: number } = {};
var RENEW_AGAIN_MS = 5 * 60 * 1000;
var aheadTimer = 0;
/** The token expiry the early renewal was scheduled for */
var aheadFor = 0;
/** An early renewal that failed while the token is still valid is retried after this */
var RETRY_AHEAD_MS = 60 * 1000;
/** A renewal that got no answer at all (the network: a TV just switched on) is retried after this */
var NO_ANSWER_MS = 5000;

/** The last-used account seen (its key; '' a guest; null: none yet), and the callback for when another is used
 * (e.g. picked in YouTube AdFree, which shares the accounts, while this app was hidden) */
var seenAccount: string | null = null;
var accountTold: () => void = function () { return undefined; };

export function onAccountChange(told: () => void): void {
    accountTold = told;
}

/** The sign-in, renewed first if expired (null: a guest, or the renewal failed) */
export function freshSignIn(): Promise<{ token: string; channel: string } | null> {
    return youtubePage().then(function (w) {
        var last = stored(w, IDENTITY_KEY) as Identity | null;
        var key = last && last.ownerObfuscatedGaiaId ? identityKey(last) : '';
        if (seenAccount !== null && key !== seenAccount) {
            setTimeout(accountTold, 0);
        }
        seenAccount = key;
        // (the token's entry read once: its end too)
        var fields = last as { [field: string]: unknown } | null;
        var entry = tokenOf(w, fields);
        var sign = signInOf(fields, entry);
        // A token from elsewhere (an account picked in YouTube's app): schedule its early renewal too
        if (sign && entry!.ends !== aheadFor) {
            renewAhead(w);
        }
        return sign || renew(w);
    });
}

/** Renews an account's token (default: the last-used account) as YouTube's TV app does, and stores it where that app
 * does. One renewal per account at a time; after a failure not again for RENEW_AGAIN_MS, after a refusal never for
 * that refresh token. */
function renew(w: Window, identity?: Identity): Promise<{ token: string; channel: string } | null> {
    var current = stored(w, IDENTITY_KEY) as Identity | null;
    var last = (identity || current) as { [field: string]: any } | null;
    var credentials = last && last.identityCredentials;
    var refresh = credentials && credentials.refreshToken;
    if (!refresh || Date.now() < (failed[refresh] || 0)) {
        return Promise.resolve(null);
    }
    var account = identityKey(last as Identity);
    var isCurrent = !!current && identityKey(current) === account;
    var signedIn = function (): boolean { return !!ownersKept(w)[last!.ownerObfuscatedGaiaId]; };
    var wasSignedIn = signedIn();
    if (!renewing[account]) {
        var asked = renewing[account] = oauth('/o/oauth2/token', { refresh_token: refresh, grant_type: 'refresh_token' }, true, credentials.clientIdName).then(function (r) {
            // Signed out meanwhile: do not write the token back
            if (wasSignedIn && !signedIn()) {
                return null;
            }
            var got = r.status === 200 ? r.reply : null;
            if (!got || !got.access_token) {
                // Refused only on invalid_grant (the sign-in was revoked); a 401 more likely means a stale OAuth client
                renewFailed(w, refresh, r.status === 400 && !!r.reply && r.reply.error === 'invalid_grant', false);
                return null;
            }
            keepToken(w, last!, got.access_token, (+got.expires_in || 3600) * 1000);
            mark('renewed');
            if (isCurrent) {
                renewAhead(w);
            }
            return signInFor(w, last);
        });
        asked.then(null, function (e) {
            renewFailed(w, refresh, false, noAnswer(e));
        });
        var done = function (): void {
            if (renewing[account] === asked) {
                delete renewing[account];
            }
        };
        asked.then(done, done);
    }
    return renewing[account].then(null, function () { return null; });
}

/** How long a failed renewal waits before another is tried: refused (the sign-in revoked), for ever; no answer at all,
 * NO_ANSWER_MS (the network: else a token run out overnight left every screen a guest's for minutes); otherwise
 * RETRY_AHEAD_MS while the token still holds (holding), RENEW_AGAIN_MS once it has run out */
export function renewWait(refused: boolean, unanswered: boolean, holding: boolean): number {
    if (refused) {
        return Infinity;
    }
    if (unanswered) {
        return NO_ANSWER_MS;
    }
    return holding ? RETRY_AHEAD_MS : RENEW_AGAIN_MS;
}

/** Records a failed renewal (see renewWait); while the token still holds, an early renewal is scheduled again */
function renewFailed(w: Window, refresh: string, refused: boolean, unanswered: boolean): void {
    var now = Date.now();
    // The token still holds for a while: an early renewal is tried again meanwhile
    var holding = signInEnds(w) - TOKEN_MARGIN_MS - now > RETRY_AHEAD_MS;
    failed[refresh] = now + renewWait(refused, unanswered, holding);
    if (!refused && holding) {
        clearTimeout(aheadTimer);
        aheadTimer = setTimeout(function () { renewAhead(w); }, RETRY_AHEAD_MS) as unknown as number;
    }
}

/** Schedules a renewal RENEW_EARLY_MS before the token expires, so no request waits for one; if the app is hidden
 * then, it waits until the app shows again (no sign-in: nothing) */
function renewAhead(w: Window): void {
    clearTimeout(aheadTimer);
    var ends = aheadFor = signInEnds(w);
    if (!ends) {
        return;
    }
    aheadTimer = setTimeout(function () {
        if (!document.hidden) {
            renew(w);
            return;
        }
        var shown = function (): void {
            if (!document.hidden) {
                document.removeEventListener('visibilitychange', shown);
                renewAhead(w);
            }
        };
        document.addEventListener('visibilitychange', shown);
    }, Math.max(0, ends - RENEW_EARLY_MS - Date.now())) as unknown as number;
}

/** Stores a renewed token where YouTube's TV app keeps it, changing only that account's entry */
function keepToken(w: Window, last: { [field: string]: any }, token: string, life: number): void {
    var now = Date.now();
    var raw = JSON.parse(w.localStorage.getItem(TOKENS_KEY) || 'null');
    var kept = raw && typeof raw === 'object' ? raw : {};
    kept.data = kept.data || {};
    var key = identityKey(last as Identity);
    var entry = kept.data[key] || { identity: last };
    entry.accessToken = token;
    entry.accessTokenDiscountedExpiration = now + life - RENEW_EARLY_MS;
    entry.accessTokenServerExpiration = now + life;
    kept.data[key] = entry;
    w.localStorage.setItem(TOKENS_KEY, JSON.stringify(kept));
}

/** The TV app's OAuth clients from the /tv page; one its script no longer shows as expected stays as found before
 * (they practically never change, and without them no account's sign-in can be renewed) */
export function oauthClients(html: string, before: Client['oauth'] | null | undefined): Client['oauth'] {
    return [0, 1].map(function (n) {
        return oauthClient(html, n) || (before && before[n]) || null;
    });
}

/** The TV app's OAuth client for an account's clientIdName, found in the /tv page's script (null: not found), which
 * reads like h=sa;c.clientIdName===1&&(h=ta) and sa={clientId:"…",A:"…"} */
export function oauthClient(html: string, clientIdName: number): { id: string; secret: string } | null {
    var pick = /([\w$]+)=([\w$]+);[\w$]+\.clientIdName===1&&\(\1=([\w$]+)\)/.exec(html);
    if (!pick) {
        return null;
    }
    var name = (clientIdName === 1 ? pick[3] : pick[2]).replace(/\$/g, '\\$');
    var found = new RegExp('[,;\\s]' + name + '=\\{clientId:"([^"]+)",[\\w$]+:"([^"]+)"\\}').exec(html);
    return found ? { id: found[1], secret: found[2] } : null;
}

/** Headers for the visitor id and the sign-in (none: a guest; a brand account also by its own id) */
function authHeaders(t: Client, sign: { token: string; channel: string } | null): { [name: string]: string } {
    var headers: { [name: string]: string } = {};
    if (t.context.client.visitorData) {
        headers['X-Goog-Visitor-Id'] = t.context.client.visitorData;
    }
    if (sign) {
        headers.Authorization = 'Bearer ' + sign.token;
        if (sign.channel) {
            headers['X-Goog-PageId'] = sign.channel;
        }
    }
    return headers;
}

/** A key for the YouTube app's last-used account, to detect changes: its plain
 * fields plus whether its token is usable (an expired one is renewed first);
 * '' for a guest */
export function account(): Promise<string> {
    return Promise.all<any>([lastAccount(), freshSignIn()]).then(function (got) {
        return got[0] && got[0] + (got[1] ? '' : NO_TOKEN);
    });
}

/** Suffix account() adds when the token cannot be used */
export var NO_TOKEN = '&noToken';

/** The last-used account's plain fields as a key ('' a guest), without checking its token */
export function lastAccount(): Promise<string> {
    return youtubePage().then(function (w) {
        var last = stored(w, IDENTITY_KEY) as { [field: string]: unknown } | null;
        if (!last || !last.ownerObfuscatedGaiaId) {
            return '';
        }
        return Object.keys(last).filter(function (field) { return typeof last![field] !== 'object'; }).sort().map(function (field) {
            return field + '=' + String(last![field]);
        }).join('&');
    });
}

/** The last-used account's token and, for a brand account, its own id
 * (channel; '' for a Google account); null: none or expired */
export function signIn(w: Window): { token: string; channel: string } | null {
    return signInFor(w, stored(w, IDENTITY_KEY) as { [field: string]: unknown } | null);
}

/** An account's token and channel (null: none or expired) */
function signInFor(w: Window, last: { [field: string]: unknown } | null): { token: string; channel: string } | null {
    return signInOf(last, tokenOf(w, last));
}

/** An account's token and channel, from its token entry (null: none or expired) */
function signInOf(last: { [field: string]: unknown } | null, entry: { token: string; ends: number } | null): { token: string; channel: string } | null {
    if (!entry || entry.ends <= Date.now() + TOKEN_MARGIN_MS || refused[entry.token]) {
        return null;
    }
    var effective = String(last!.effectiveObfuscatedGaiaId || '');
    return { token: entry.token, channel: effective && effective !== last!.ownerObfuscatedGaiaId ? effective : '' };
}

/** When the last-used account's token expires (0: none) */
function signInEnds(w: Window): number {
    var entry = tokenOf(w, stored(w, IDENTITY_KEY) as { [field: string]: unknown } | null);
    return entry ? entry.ends : 0;
}

/** The token YouTube's TV app stores for account last, and its expiry (null: none) */
function tokenOf(w: Window, last: { [field: string]: unknown } | null): { token: string; ends: number } | null {
    var tokens = stored(w, TOKENS_KEY) as { [id: string]: { accessToken?: string; accessTokenServerExpiration?: number; identity?: { [field: string]: unknown } } } | null;
    if (!last || !tokens) {
        return null;
    }
    var found: { token: string; ends: number } | null = null;
    for (var id in tokens) {
        var entry = tokens[id];
        var ends = entry && entry.accessTokenServerExpiration || 0;
        if (entry && entry.accessToken && entry.identity && sameIdentity(entry.identity, last) && (!found || ends > found.ends)) {
            found = { token: entry.accessToken, ends: ends };
        }
    }
    return found;
}

/** Same account: every plain field of b matches (credentials ignored) */
function sameIdentity(a: { [field: string]: unknown }, b: { [field: string]: unknown }): boolean {
    for (var field in b) {
        if (typeof b[field] !== 'object' && a[field] !== b[field]) {
            return false;
        }
    }
    return true;
}

/** An account's key in YouTube's TV app storage: its own id and its Google account's id */
export function identityKey(identity: Identity): string {
    return accountKey(identity.effectiveObfuscatedGaiaId, identity.ownerObfuscatedGaiaId);
}

export function accountKey(own: string, google: string): string {
    return own + '||' + google;
}

/** A brand account (a channel run by a Google account), not the Google account itself */
export function isBrand(identity: Identity): boolean {
    return identity.effectiveObfuscatedGaiaId !== identity.ownerObfuscatedGaiaId;
}

/** A Google account in the form YouTube's TV app stores it */
export function googleIdentity(id: string, credentials: { [field: string]: unknown }): Identity {
    return { identityType: 'CORE_ID', identityCredentials: credentials, effectiveObfuscatedGaiaId: id, ownerObfuscatedGaiaId: id, gaiaDelegationType: 1 };
}

/** One of a Google account's brand accounts (with the Google account's credentials) */
export function brandIdentity(google: Identity, brand: string): Identity {
    var i = identityOf(google);
    i.effectiveObfuscatedGaiaId = brand;
    i.gaiaDelegationType = 3;
    return i;
}

/** Only the fields YouTube's TV app stores for the last-used account */
function identityOf(i: Identity): Identity {
    return {
        identityType: i.identityType, identityCredentials: i.identityCredentials, effectiveObfuscatedGaiaId: i.effectiveObfuscatedGaiaId,
        ownerObfuscatedGaiaId: i.ownerObfuscatedGaiaId, gaiaDelegationType: i.gaiaDelegationType
    };
}

/** The accounts YouTube's TV app stores: Google accounts (by id), tokens (by account key), last activity (by own id),
 * and the last-used account (null: none) */
export interface Identities {
    owners: { [id: string]: Identity };
    tokens: { [key: string]: { identity?: Identity } };
    activity: { [id: string]: { lastActivityTimestamp?: number } };
    last: Identity | null;
}

/** The Google accounts on the TV, by id (YouTube's store; {} none) */
function ownersKept(w: Window): Identities['owners'] {
    return (stored(w, AVAILABLE_KEY) || {}) as Identities['owners'];
}

function identitiesKept(w: Window): Identities {
    var last = stored(w, IDENTITY_KEY) as Identity | null;
    return {
        owners: ownersKept(w),
        tokens: (stored(w, TOKENS_KEY) || {}) as Identities['tokens'],
        activity: (stored(w, ACTIVITY_KEY) || {}) as Identities['activity'],
        last: last && last.ownerObfuscatedGaiaId ? last : null
    };
}

/** The accounts on the TV (Google accounts, and brand accounts that have a token entry) and the current one (null: a
 * guest) */
export function accountsIn(kept: Identities): { list: Identity[]; current: Identity | null } {
    var list: Identity[] = [];
    var seen: { [key: string]: boolean } = {};
    var add = function (i: Identity | undefined): void {
        var google = i && kept.owners[i.ownerObfuscatedGaiaId];
        if (google && !seen[identityKey(i!)]) {
            seen[identityKey(i!)] = true;
            // Use the Google account's current credentials: a brand account's token entry keeps old ones after a new
            // sign-in
            var one = identityOf(i!);
            one.identityCredentials = google.identityCredentials;
            list.push(one);
        }
    };
    for (var id in kept.owners) {
        add(kept.owners[id]);
    }
    for (var key in kept.tokens) {
        add(kept.tokens[key] && kept.tokens[key].identity);
    }
    return { list: list, current: kept.last };
}

/** Removes a Google account, its brand accounts and their tokens from kept (in place); clears the last-used account
 * if it was one of them */
export function withoutAccount(kept: Identities, google: string): Identities {
    var gone = function (i: Identity | null | undefined): boolean {
        return !!i && i.ownerObfuscatedGaiaId === google;
    };
    delete kept.owners[google];
    for (var key in kept.tokens) {
        var i = kept.tokens[key] && kept.tokens[key].identity;
        if (gone(i)) {
            delete kept.tokens[key];
            delete kept.activity[i!.effectiveObfuscatedGaiaId];
        }
    }
    if (gone(kept.last)) {
        kept.last = null;
    }
    return kept;
}

/** The accounts on the TV, the current one, and when each was last used (by own id) */
export function identities(): Promise<{ list: Identity[]; current: Identity | null; used: { [id: string]: number } }> {
    return youtubePage().then(function (w) {
        var kept = identitiesKept(w);
        var got = accountsIn(kept);
        var used: { [id: string]: number } = {};
        for (var a in kept.activity) {
            used[a] = kept.activity[a] && kept.activity[a].lastActivityTimestamp || 0;
        }
        return { list: got.list, current: got.current, used: used };
    });
}

/** Stores a newly signed-in Google account where YouTube's TV app keeps accounts (with its non-brand account count,
 * as YouTube does), and its token */
export function addIdentity(identity: Identity, nonBrand: number, token: string, life: number): Promise<void> {
    return youtubePage().then(function (w) {
        var kept = identitiesKept(w);
        var owner = identity.ownerObfuscatedGaiaId;
        var entry: any = identityOf(identity);
        entry.numberOfNonBrandAccounts = nonBrand;
        (kept.owners as { [id: string]: any })[owner] = entry;
        keep(w, AVAILABLE_KEY, kept.owners);
        // Signed in again: its brand accounts' entries and the last-used account (if one of them) get the new
        // credentials (the old ones may be revoked)
        for (var key in kept.tokens) {
            var i = kept.tokens[key] && kept.tokens[key].identity;
            if (i && i.ownerObfuscatedGaiaId === owner) {
                i.identityCredentials = identity.identityCredentials;
            }
        }
        keep(w, TOKENS_KEY, kept.tokens);
        if (kept.last && kept.last.ownerObfuscatedGaiaId === owner) {
            kept.last.identityCredentials = identity.identityCredentials;
            keep(w, IDENTITY_KEY, identityOf(kept.last));
        }
        keepToken(w, identity as unknown as { [field: string]: any }, token, life);
    });
}

/** Switches to an account as YouTube's TV app does: stores it as last used and updates its activity time */
export function useIdentity(identity: Identity): Promise<void> {
    return youtubePage().then(function (w) {
        keep(w, IDENTITY_KEY, identityOf(identity));
        // The app's own change: not told back as one from elsewhere (a second reset of everything)
        seenAccount = identityKey(identity);
        var activity = identitiesKept(w).activity;
        activity[identity.effectiveObfuscatedGaiaId] = { lastActivityTimestamp: Date.now() };
        keep(w, ACTIVITY_KEY, activity);
    });
}

/** YouTube's TV app's guest as it stores it as the last-used identity ("Watch as guest") */
var GUEST = { identityType: 'UNAUTHENTICATED_IDENTITY_TYPE_GUEST' };

/** Watches as a guest, as YouTube's TV app does: its guest stored as the last-used identity (the accounts stay signed
 * in on the TV) */
export function useGuest(): Promise<void> {
    return youtubePage().then(function (w) {
        keep(w, IDENTITY_KEY, GUEST);
        // The app's own change: not told back as one from elsewhere
        seenAccount = '';
    });
}

/** Whether the guest was chosen (YouTube's guest stored as last used), not merely no account yet */
export function guestChosen(): Promise<boolean> {
    return youtubePage().then(function (w) {
        var last = stored(w, IDENTITY_KEY) as { identityType?: string } | null;
        return !!last && last.identityType === GUEST.identityType;
    });
}

/** Signs a Google account out by removing it from YouTube's TV app storage (withoutAccount); if it was current, the
 * app is a guest until another is picked */
export function forgetAccount(google: string): Promise<void> {
    return youtubePage().then(function (w) {
        var kept = withoutAccount(identitiesKept(w), google);
        keep(w, AVAILABLE_KEY, kept.owners);
        keep(w, TOKENS_KEY, kept.tokens);
        keep(w, ACTIVITY_KEY, kept.activity);
        if (!kept.last) {
            w.localStorage.removeItem(IDENTITY_KEY);
            seenAccount = '';
        }
    });
}

/** Writes a value to youtube.com's storage, wrapped in {data: …} as YouTube does */
function keep(w: Window, key: string, value: unknown): void {
    w.localStorage.setItem(key, JSON.stringify({ data: value }));
}

/** Reads a value from youtube.com's storage, unwrapping {data: …} */
function stored(w: Window, key: string): unknown {
    try {
        var v = JSON.parse(w.localStorage.getItem(key) || 'null');
        return v && v.data !== undefined ? v.data : v;
    } catch (e) {
        return null;
    }
}

/** A request from the youtube.com page (its own XMLHttpRequest, so its origin and cookies); resolves with any
 * status (binary: the reply as bytes, with credentials) */
export function answer(w: Window, method: string, url: string, body: string | Uint8Array | null, headers: { [name: string]: string },
    binary?: boolean): Promise<{ status: number; text: string; data?: ArrayBuffer }> {
    return new Promise<{ status: number; text: string; data?: ArrayBuffer }>(function (resolve, reject) {
        var unanswered = function (): void {
            clearTimeout(guard);
            reject(new Error('YouTube did not answer'));
        };
        // Also this app's own timer: the page's (xhr.timeout) goes with the page, which would leave the request, and
        // whatever waits on it (a token renewal, the player script), unsettled for good
        var guard = setTimeout(function () {
            try {
                xhr.abort();
            } catch (e) {
                // (the page gone)
            }
            unanswered();
        }, TIMEOUT_MS + GUARD_MS);
        try {
            var xhr = new (w as unknown as { XMLHttpRequest: typeof XMLHttpRequest }).XMLHttpRequest();
            xhr.open(method, url);
            for (var name in headers) {
                xhr.setRequestHeader(name, headers[name]);
            }
            xhr.timeout = TIMEOUT_MS;
            if (binary) {
                // (as YouTube's player sends its video servers' requests)
                xhr.responseType = 'arraybuffer';
                xhr.withCredentials = true;
            }
            xhr.onload = function () {
                clearTimeout(guard);
                resolve(binary ? { status: xhr.status, text: '', data: xhr.response as ArrayBuffer } : { status: xhr.status, text: xhr.responseText });
            };
            xhr.onerror = xhr.ontimeout = xhr.onabort = unanswered;
            xhr.send(body);
        } catch (e) {
            // The page gone before the request went
            unanswered();
        }
    });
}

/** A GET from the youtube.com page: the reply text (non-2xx: rejects) */
export function get(w: Window, url: string): Promise<string> {
    return send(w, 'GET', url, null, {});
}

/** A JSON POST to YouTube's API, its reply's text: core/http.ts's postText, but on webOS TV 2.x's engine from the
 * youtube.com page (fromPage) */
export function postYouTubeText(url: string, body: unknown, headers: { [name: string]: string }): Promise<string> {
    return oldEngine() ? fromPage(url, body, headers, false) : postText(url, body, headers);
}

/** A JSON POST to YouTube's API, its reply read: core/http.ts's postJson, but on webOS TV 2.x's engine from the
 * youtube.com page (fromPage) */
export function postYouTubeJson<T>(url: string, body: unknown, headers: { [name: string]: string }): Promise<T> {
    return oldEngine() ? fromPage(url, body, headers, true).then(function (text) { return parse<T>(text, url); }) : postJson<T>(url, body, headers);
}

/** A JSON POST as core/http.ts makes it (json: a JSON reply asked), but from the youtube.com page: webOS TV 2.x's
 * engine names the app's origin file:// (Chrome's: null), which YouTube refuses (the page: its origin, its cookies with
 * it). Its failures as http.ts's (HttpErrors; no answer: a network error) */
function fromPage(url: string, body: unknown, headers: { [name: string]: string }, json: boolean): Promise<string> {
    var all: { [name: string]: string } = json ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { 'Content-Type': 'application/json' };
    for (var name in headers) {
        all[name] = headers[name];
    }
    return youtubePage().then(function (w) {
        return answer(w, 'POST', url, JSON.stringify(body), all);
    }).then(function (r) {
        if (r.status < 200 || r.status >= 300) {
            throw { status: r.status, url: url, message: 'HTTP ' + r.status, body: r.text } as HttpError;
        }
        return r.text;
    }, function () {
        throw { status: 0, url: url, message: 'network error', body: '' } as HttpError;
    });
}

/** A request from the youtube.com page: the reply text (non-2xx: rejects with an Error that has the status) */
function send(w: Window, method: string, url: string, body: string | null, headers: { [name: string]: string }): Promise<string> {
    return answer(w, method, url, body, headers).then(function (r) {
        if (r.status < 200 || r.status >= 300) {
            var refusal = new Error('YouTube answered ' + r.status) as Error & { status: number };
            refusal.status = r.status;
            throw refusal;
        }
        return r.text;
    });
}

/** The JSON object right after key in text (e.g. config set in a page
 * script), found by matching braces outside strings; null when missing or
 * not JSON */
export function objectAt(text: string, key: string): any {
    var at = text.indexOf(key);
    var from = at < 0 ? -1 : text.indexOf('{', at + key.length);
    var end = from < 0 ? -1 : jsonEnd(text, from);
    try {
        return end < 0 ? null : JSON.parse(text.slice(from, end));
    } catch (e) {
        return null;
    }
}

/** The index just past the JSON array or object starting at i (-1: incomplete), by matching brackets outside
 * strings */
export function jsonEnd(text: string, i: number): number {
    var depth = 0;
    var inString = false;
    var escaped = false;
    for (; i < text.length; i++) {
        var c = text.charAt(i);
        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (c === '\\') {
                escaped = true;
            } else if (c === '"') {
                inString = false;
            }
        } else if (c === '"') {
            inString = true;
        } else if (c === '[' || c === '{') {
            depth++;
        } else if ((c === ']' || c === '}') && --depth === 0) {
            return i + 1;
        }
    }
    return -1;
}

/** n characters picked at random from chars */
export function randomText(n: number, chars: string): string {
    var s = '';
    for (var i = 0; i < n; i++) {
        s += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return s;
}

/** A random UUID (version 4) */
export function uuid(): string {
    var hex = randomText(32, '0123456789abcdef');
    return hex.substr(0, 8) + '-' + hex.substr(8, 4) + '-4' + hex.substr(13, 3) + '-' + '89ab'.charAt(Math.floor(Math.random() * 4)) +
        hex.substr(17, 3) + '-' + hex.substr(20, 12);
}

/** A playback id (cpn) for YouTube's reports and the lounge, made as its players make one */
export function newCpn(): string {
    return randomText(16, 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_');
}
