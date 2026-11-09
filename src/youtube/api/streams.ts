// A video's streams for the own player (player/own-player.ts), fetched with
// YouTube's VISIONOS client (as yt-dlp and NewPipe use it): every format has
// a plain URL, with no SABR and no player script needed. Requests carry no
// youtube.com cookies, so they are made as a guest and add nothing to the
// account's history. A guest needs a visitor id (else "Sign in to confirm
// you're not a bot"), taken from youtube.com's sw.js_data and kept a week; a
// bot check is retried once with a new one. Formats kept: H.264/MP4 up to
// 1080p60, VP9/WebM up to 2160p60 (4K60 plays without dropped frames on the
// TV) and AAC per audio track (original, dubs, stable volume), each with its
// init and index byte ranges. Captions are YouTube's timed text as WebVTT,
// with YouTube translations for the Settings languages. Videos a guest may
// not watch (age check, members only) are fetched as the account
// (sabrStreams: the signed-in TV client, formats via SABR only:
// player/sabr-engine.ts); playableStreams tries that first if Settings say so.

import { getText, HttpError } from '../core/http.js';
import { language, tr } from '../core/i18n.js';
import { android } from '../core/platform.js';
import { load, save } from '../core/store.js';
import { Ended, paramBytes, text } from './feed.js';
import { languageOrder, subtitleLanguages, trackName } from './languages.js';
import { forgetScript, playerScript } from './player-script.js';
import { SabrClient } from './sabr.js';
import { forgetOnesie, onesie, prepareOnesie } from './onesie.js';
import { freshSignIn, innertubeVia, lastAccount, newCpn, noAnswer, postYouTubeJson, restartPage, tvClient, youtubeLanguage } from './youtube.js';

var PLAYER = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
var VISITOR = 'https://www.youtube.com/sw.js_data';
var VISITOR_KEY = 'youtube.visitor';
var VISITOR_DAYS = 7;
var CLIENT = {
    clientName: 'VISIONOS',
    clientVersion: '1.02',
    deviceMake: 'Apple',
    deviceModel: 'RealityDevice17,1',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
    osName: 'visionOS',
    osVersion: '26.5.23O471',
    hl: 'en',
    timeZone: 'UTC',
    utcOffsetMinutes: 0
};
/** VISIONOS's number (X-YouTube-Client-Name) */
var CLIENT_NAME = '101';
/** Order of subtitle kinds within a language */
var KINDS = ['own', 'asr', 'translated'];

export interface Range {
    start: number;
    end: number;
}

export interface Format {
    itag: number;
    url: string;
    /** For Media Source: 'video/mp4; codecs="avc1.64002A"' */
    mime: string;
    width: number;
    height: number;
    fps: number;
    /** Average bits per second */
    bitrate: number;
    /** File size (bytes) and duration (s) */
    length: number;
    duration: number;
    init: Range;
    index: Range;
    /** Last-modified version and tags (dub language, stable volume): SABR identifies a format by them */
    lmt: string;
    xtags: string;
    /** Audio: the dub's id ('' the original) and whether it has stable volume */
    track?: string;
    drc?: boolean;
}

export interface Caption {
    url: string;
    language: string;
    /** Display name: "English (auto-generated)", "Danish (auto-translated)" */
    name: string;
    /** Uploaded, speech recognition, or translated by YouTube from another track */
    kind: 'own' | 'asr' | 'translated';
    /** A translation's source track (shown instead while YouTube refuses translations) */
    source?: Caption;
}

/** A video's audio in one language (the original or a dub) */
export interface AudioTrack {
    /** YouTube's id ("en.4"; '' when there is only the original) */
    id: string;
    /** Display name ("French", "English (original)") */
    name: string;
    /** The original audio (not a dub) */
    original: boolean;
    format: Format;
    /** The stable-volume version (null: none) */
    stable: Format | null;
    /** With Dolby as format: the track's best stereo AAC (audioOf takes it once Dolby failed here; null: none) */
    stereo?: Format | null;
}

export interface Streams {
    title: string;
    channel: string;
    description: string;
    /** Highest first */
    videos: Format[];
    /** Original audio first */
    audios: AudioTrack[];
    /** Uploaded and auto-generated subtitles as YouTube lists them (captionList adds translations) */
    captions: Caption[];
    /** Translation source and target languages (null: none) */
    translations: Translations | null;
    /** SABR source of the formats (null: each format has its own URL) */
    sabr: Sabr | null;
    /** The other method failed for this video (playableStreams): no point retrying it */
    only?: boolean;
    /** YouTube's paid promotion notice and how long to show it at the start (ms) */
    paid?: { text: string; ms: number };
    /** The seek preview's frames (null: none, as for a live stream) */
    storyboard: Storyboard | null;
    /** A live stream (null: a video): its formats come as numbered segments (player/live-engine.ts) */
    live: Live | null;
}

/** A live stream's segments: about this long each (s), and how far back they reach (s) */
export interface Live {
    segment: number;
    dvr: number;
}

/** A storyboard level: sheets of w x h frames, cols x rows a sheet, one frame every interval ms */
export interface Storyboard {
    /** A sheet's address, with $L for the level and $N for the sheet's name */
    base: string;
    level: number;
    w: number;
    h: number;
    count: number;
    cols: number;
    rows: number;
    interval: number;
    /** The sheet's name, $M for its number ("M$M") */
    name: string;
    /** A blurrier level whose sheets each cover much more of the video (one comes quickly for a far jump: its frame
     * shows while the sharp sheet loads); only on the sharpest level */
    coarse?: Storyboard;
    sigh: string;
}

/** Translatable subtitles: from (source track URL), to (target languages), and heard (the language of the default
 * audio's auto-generated track, '' none) */
export interface Translations {
    from: string;
    to: { code: string; name: string }[];
    heard: string;
}

/** Where and how to request a video's SABR streams */
export interface Sabr {
    /** The streaming URL (with its n parameter transformed) */
    url: string;
    /** /player's videoPlaybackUstreamerConfig */
    config: string;
    client: SabrClient;
    /** The token SABR's server gave with a reload request: the renewal's /player request sends it, else the server goes
     * on asking for a reload and sends no media */
    reloadToken?: string;
}

/** Why there are no streams: YouTube's reason, or what failed */
export interface NoStreams {
    status: string;
    reason: string;
    /** The video's length (s) when YouTube tells it anyway (an age check) */
    length?: number;
    /** The TV client, asked as YouTube's player asks (signed in, or as a guest where there is no account), got only an
     * error message (no offer, no way on, not a bot check) */
    asYouTube?: boolean;
    /** Both ways failed alike and the TV client's answer was asYouTube: YouTube's player gets the same */
    refused?: boolean;
    /** A live stream that has ended, as YouTube still describes it */
    ended?: Ended;
}

/** The visitor id: the stored one while recent (unless fresh), else a new one */
function visitor(fresh: boolean): Promise<string> {
    var stored = load<{ id: string; at: number }>(VISITOR_KEY);
    if (!fresh && stored && stored.id && Date.now() - stored.at < VISITOR_DAYS * 24 * 3600 * 1000) {
        return Promise.resolve(stored.id);
    }
    // (asked once for starts and preloads at the same time)
    if (!visiting) {
        var asked = visiting = getText(VISITOR).then(function (text) {
            var id = (/"(Cg[A-Za-z0-9_%-]{20,})"/.exec(text) || [])[1];
            if (!id) {
                throw { status: 'NO_VISITOR', reason: 'YouTube gave no visitor id' } as NoStreams;
            }
            save(VISITOR_KEY, { id: id, at: Date.now() });
            return id;
        });
        var done = function (): void {
            if (visiting === asked) {
                visiting = null;
            }
        };
        asked.then(done, done);
    }
    return visiting;
}
var visiting: Promise<string> | null = null;

/** Recently fetched streams (preloaded, or reopened), cached for KEEP_MS. Their URLs last ~6 h; expired ones are
 * fetched again (own-player.ts failed). */
var KEEP_MS = 60 * 60 * 1000;
var KEEP_COUNT = 12;
/** Streams come well within a second (a cold SABR start, its player script first: ~4 s). A request still on its way
 * after this long has likely hung (a connection gone dead lets it wait out its time limits, a minute and more along
 * both methods): it is shared with later callers only this long, and patient asks again then, then after twice as
 * long each time, AGAIN times (asks at 0, 3, 9 and 21 s; counted, not timed: the TV's clock can jump) */
var STUCK_MS = 3000;
var AGAIN = 3;
/** A SABR start from cold first fetches and runs YouTube's player script (~4 s): its requests count as hung only after
 * this long */
var SABR_STUCK_MS = 8000;
/** How long a /player reply's tracking URLs stay usable */
var TRACKING_MS = 10 * 60 * 1000;
/** at: when it was asked, or answered once done */
var kept: { id: string; sabr: boolean; at: number; done: boolean; streams: Promise<Streams> }[] = [];

/** A video's streams as a guest (cached for KEEP_MS; fresh: asked anew, past the cache); rejects with NoStreams */
export function streams(id: string, fresh?: boolean): Promise<Streams> {
    return keep(id, false, function () { return ask(id, false); }, fresh);
}

/** A video's streams as the account (askSigned; cached like streams; reloadToken: a reload's); rejects with NoStreams */
export function sabrStreams(id: string, reloadToken?: string, fresh?: boolean): Promise<Streams> {
    return keep(id, true, function () { return askSigned(id, reloadToken || ''); }, fresh);
}

/** The method that worked lately where the other failed for reasons not the video's own (SABR or as a guest): it goes
 * first until LEARNED_MS later, then the Settings choice again */
var learned: { sabr: boolean; at: number } | null = null;
var LEARNED_MS = 30 * 60 * 1000;

/** Videos the guest path refused for a reason of their own (an age check, members only) and SABR played, and when:
 * SABR goes first for them for LEARNED_MS (each of their starts and preloads paid the refusal first) */
var signedInOnly: { [id: string]: number } = {};

/** Whether SABR goes first now (for video id, if given): for a video only SABR played lately, else the method that
 * worked lately, else sabrFirst (Settings) */
export function sabrFirstNow(sabrFirst: boolean, id?: string): boolean {
    if (id && signedInOnlyNow(id)) {
        return true;
    }
    return learned && Date.now() - learned.at < LEARNED_MS ? learned.sabr : sabrFirst;
}

/** Whether only SABR played video id lately (the guest path refused it for a reason of its own) */
function signedInOnlyNow(id: string): boolean {
    return Date.now() - (signedInOnly[id] || 0) < LEARNED_MS;
}

/** The method (sabr or as a guest) played where the other failed (why: the other's reason, if known); unless that was
 * about the video itself, it goes first for a while; if it was and SABR played, SABR goes first for that video (id) */
export function learnMethod(sabr: boolean, why?: NoStreams, id?: string): void {
    var now = Date.now();
    if (!why || !aboutTheVideo(why)) {
        learned = { sabr: sabr, at: now };
    } else if (sabr && id) {
        for (var other in signedInOnly) {
            if (now - signedInOnly[other] >= LEARNED_MS) {
                delete signedInOnly[other];
            }
        }
        signedInOnly[id] = now;
    }
}

/** A failure that is about the video, not the method: an age check, members only, private, paid, region, no SABR
 * stream (a live stream), removed (not the player script failing for SABR: SABR_SCRIPT) */
export function aboutTheVideo(e: NoStreams): boolean {
    return e.status === 'NO_SABR' || noneCanPlay(e) || /\b(age|members?|private|premium|purchase|rent(al|ed)?|country)\b/i.test(e.reason || '');
}

/** Removed, or a live stream not live yet: no method plays it, nor YouTube's player */
export function noneCanPlay(e: NoStreams): boolean {
    return e.status === 'ERROR' || e.status === 'LIVE_STREAM_OFFLINE';
}

/** Why YouTube refused a video (e), as its player says it in the app's language: the requests ask in English (their
 * reasons are read here), so in another language the guest's is asked once more in it; '' where that one was not
 * refused alike or did not answer */
export function reasonInLanguage(id: string, e: NoStreams): Promise<string> {
    if (inEnglish()) {
        return Promise.resolve(e.reason || '');
    }
    return visitor(false).then(function (visitorId) {
        return askPlayer(id, visitorId, youtubeLanguage());
    }).then(function (reply) {
        var playable = reply && reply.playabilityStatus || {};
        return playable.status === e.status && playable.reason || '';
    }, function () {
        return '';
    });
}

/** A video's streams for the own player: as a guest, else via SABR (age check, members only); sabrFirst reverses
 * the order, as does the method that worked lately (sabrFirstNow). If both fail, rejects with the first reason (and the
 * other's), or the TV client's where both were refused alike (refused). With asking (a viewer waiting), each method's
 * request is asked again if it hangs (patient), and the other method asked only while asking says they are still
 * wanted (asking(sabr, again): the method about to be asked, and whether as a hanging request's ask again). */
export function playableStreams(id: string, sabrFirst: boolean, asking?: Asking): Promise<Streams> {
    var sabr = sabrFirstNow(sabrFirst, id);
    // (a video only SABR plays is marked so as when the guest path refused it: the player does not switch to that path)
    var signedIn = sabr && signedInOnlyNow(id);
    var by = function (viaSabr: boolean): Promise<Streams> {
        var ask = function (fresh: boolean): Promise<Streams> { return viaSabr ? sabrStreams(id, '', fresh) : streams(id, fresh); };
        return asking ? patient(ask, function () { return asking(viaSabr, true); }, stuckFor(viaSabr)) : ask(false);
    };
    return by(sabr).then(function (s) {
        return signedIn ? onlyBy(s) : s;
    }, function (e: NoStreams) {
        // Removed, an upcoming live stream, or no network: the other method cannot play it either; nor is it asked once
        // the viewer has gone
        if (noneCanPlay(e) || noAnswer(e) || asking && !asking(!sabr, false)) {
            throw e;
        }
        return by(!sabr).then(function (s) {
            learnMethod(!sabr, e, id);
            return onlyBy(s);
        }, function (other: NoStreams) {
            // Refused alike, as YouTube's player would be: the TV client's reason, as that player shows it (with the
            // guest's details of an ended live stream)
            var tv = sabr ? e : other;
            var guest = sabr ? other : e;
            if (tv.asYouTube && guest.status === tv.status) {
                throw { status: tv.status, reason: tv.reason, refused: true, ended: guest.ended } as NoStreams;
            }
            throw { status: e.status, reason: e.reason + (other.reason ? ' (' + (sabr ? 'as a guest' : 'SABR') + ': ' + other.reason + ')' : '') } as NoStreams;
        });
    });
}

/** A copy of s marked as playable by its method only (the kept one serves later plays, which try the first method
 * again) */
function onlyBy(s: Streams): Streams {
    var only = {} as Streams;
    for (var name in s) {
        (only as any)[name] = (s as any)[name];
    }
    only.only = true;
    return only;
}

/** Whether a video's streams are kept (by this method: asking for them makes no request to YouTube) */
export function streamsKept(id: string, sabr: boolean): boolean {
    return !!keptOf(id, sabr, Date.now());
}

/** A video's streams kept by this method at now: answered within KEEP_MS, or on their way for less than stuck */
function keptOf(id: string, sabr: boolean, now: number): typeof kept[0] | undefined {
    return kept.filter(function (k) { return k.id === id && k.sabr === sabr && now - k.at < (k.done ? KEEP_MS : stuckFor(sabr)); })[0];
}

/** How long a request by this method may be on its way before it counts as hung */
export function stuckFor(sabr: boolean): number {
    return sabr ? SABR_STUCK_MS : STUCK_MS;
}

function keep(id: string, sabr: boolean, asking: () => Promise<Streams>, fresh?: boolean): Promise<Streams> {
    var now = Date.now();
    var had = keptOf(id, sabr, now);
    // (fresh: past one on its way, not past streams that came)
    if (had && (had.done || !fresh)) {
        return had.streams;
    }
    var asked = asking();
    var entry = { id: id, sabr: sabr, at: now, done: false, streams: asked };
    kept = kept.filter(function (k) { return !(k.id === id && k.sabr === sabr); }).concat([entry]).slice(-KEEP_COUNT);
    asked.then(function () {
        entry.done = true;
        entry.at = Date.now();
    }, function () {
        kept = kept.filter(function (k) { return k !== entry; });
    });
    return asked;
}

/** A viewer waiting for streams, asked before a request beyond the first (sabr: its method; again: a hanging request
 * asked again, else the other method's first): false once they are no longer wanted */
export type Asking = (sabr: boolean, again: boolean) => boolean;

/** ask(false)'s streams, asked again while none have come (ask(true): a new request, past the cache): wait (by
 * default STUCK_MS) later, then after twice as long each time, AGAIN times, and at once when the network comes back; again() first, false once
 * they are no longer wanted. The first streams that come are taken. A failure with an answer from YouTube (about the
 * video, a refusal, an odd reply) is the answer at once; one with none waits for the requests still on their way and
 * those planned, and once none are left rejects with the last failure. */
export function patient(ask: (fresh: boolean) => Promise<Streams>, again: () => boolean, first?: number): Promise<Streams> {
    return new Promise<Streams>(function (resolve, reject) {
        var open = 0;
        var done = false;
        var timer = 0;
        var wait = first || STUCK_MS;
        var left = AGAIN;
        var last: NoStreams | null = null;
        // (not in the tests' fake window)
        var hears = typeof window.addEventListener === 'function';
        var noMore = function (): void {
            clearTimeout(timer);
            timer = 0;
            if (hears) {
                window.removeEventListener('online', anew);
            }
        };
        var settle = function (): void {
            done = true;
            noMore();
        };
        // The next ask after wait (then twice as long), AGAIN of them
        var plan = function (): void {
            clearTimeout(timer);
            timer = left-- > 0 ? setTimeout(anew, wait) as unknown as number : 0;
            wait *= 2;
        };
        var anew = function (): void {
            if (done) {
                return;
            }
            if (!again()) {
                // No longer wanted: settled by the requests on their way, at once if none
                noMore();
                if (!open) {
                    settle();
                    reject(last || { status: 'NO_REPLY', reason: 'no longer wanted' } as NoStreams);
                }
                return;
            }
            take(ask(true));
            plan();
        };
        var take = function (asked: Promise<Streams>): void {
            open++;
            asked.then(function (s) {
                if (!done) {
                    settle();
                    resolve(s);
                }
            }, function (e: NoStreams) {
                open--;
                last = e;
                if (!done && (!unanswered(e) || !open && !timer)) {
                    settle();
                    reject(e);
                }
            });
        };
        if (hears) {
            window.addEventListener('online', anew);
        }
        take(ask(false));
        plan();
    });
}

/** A failure with no answer from YouTube at all (the network down, a request timed out, a server error): worth asking
 * again; any other is YouTube's answer (about the video, a refusal, an odd reply) */
export function unanswered(e: NoStreams): boolean {
    return noAnswer(e) || e.status === 'HTTP' && /^(timeout|network error|HTTP 5\d\d)$/.test(e.reason || '');
}

/** A SABR /player request's playback context: the player script's signature timestamp, the device's playback (as
 * YouTube's TV player sends it), and a reload's token if any */
export function sabrPlayback(sts: number, reloadToken: string): { [name: string]: unknown } {
    var playback: { [name: string]: unknown } = { contentPlaybackContext: { html5Preference: 'HTML5_PREF_WANTS', signatureTimestamp: sts },
        devicePlaybackCapabilities: { supportsVp9Encoding: true, supportXhr: true } };
    if (reloadToken) {
        playback.reloadPlaybackContext = { reloadPlaybackParams: { token: reloadToken } };
    }
    return playback;
}

/** Drop cached streams so they are fetched again (their URLs expired) */
export function forgetStreams(id: string): void {
    kept = kept.filter(function (k) { return k.id !== id; });
}

/** Tracking URLs of the signed-in TV client's last /player reply and its token, so History reporting (api/stats.ts)
 * needs no second request */
var tracking: { id: string; at: number; token: string; tracking: any } | null = null;

/** The playbackTracking of a recent SABR /player reply for id with this token, usable once (null: none) */
export function takeTracking(id: string, token: string): any {
    var t = tracking;
    tracking = null;
    return t && t.id === id && t.token === token && Date.now() - t.at < TRACKING_MS ? t.tracking : null;
}

/** When the page may be restarted again for YouTube asking (0: now): RESTART_AGAIN_MS after a restart, RESTART_IDLE_MS
 * after one that did not help (asked again at once: YouTube's answer stands for this TV a while). Meanwhile the
 * guest path plays. */
var restartAfter = 0;
var RESTART_AGAIN_MS = 30 * 60 * 1000;
var RESTART_IDLE_MS = 6 * 3600 * 1000;

/** Whether a refusal is YouTube asking its TV app to restart ("The YouTube app needs to restart"; its button reloads
 * the page) */
function asksRestart(playable: { errorScreen?: unknown }): boolean {
    return !!playable.errorScreen && /RELOAD_PAGE/.test(JSON.stringify(playable.errorScreen));
}

/** The signed-in player request as YouTube's TV app asks it on a Samsung TV (the device as yt-dlp's tv_samsung, the TV
 * app's version this TV's /tv page gives), inside an Onesie request (api/onesie.ts), whose inner headers carry that
 * TV's user agent. Since 2026-11-06 YouTube gives an LG TV's client (this app's user agent, which a request from the
 * page cannot change) another variant of its player script (tv-player-ias-tcl), whose signature timestamp it then
 * wants and whose n transform no solver finds yet (yt-dlp/ejs issue 77); a Samsung TV's is the classic one
 * (playerScript) */
var SIGNED_IN_AS: { [field: string]: string } = { deviceMake: 'Samsung', deviceModel: 'UKS9800', osName: 'Tizen', osVersion: '2.4.0',
    userAgent: 'Mozilla/5.0 (SMART-TV; Linux; Tizen 2.4.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/2.4.0 TV Safari/538.1' };

/** The player request as the signed-in TV client (SIGNED_IN_AS, by Onesie), with the player script's signature
 * timestamp (and a reload's token, '' none): the formats, the SABR URL (n transformed by that script) and the client
 * details SABR requests send. Asked to restart, the page, its client details and the script are made anew and it is
 * asked once more (restartAfter; restarted: this is that ask) */
function askSigned(id: string, reloadToken: string, restarted?: boolean): Promise<Streams> {
    return Promise.all<any>([playerScript(), tvClient(), prepareOnesie()]).then(function (ready) {
        var script = ready[0];
        var own = ready[1].context.client;
        var as: { [field: string]: string } = { clientVersion: own.clientVersion || '' };
        for (var field in SIGNED_IN_AS) {
            as[field] = SIGNED_IN_AS[field];
        }
        return Promise.all<any>([freshSignIn(), innertubeVia('player', {
            videoId: id,
            cpn: newCpn(),
            contentCheckOk: true,
            racyCheckOk: true,
            playbackContext: sabrPlayback(script.sts, reloadToken)
        }, onesie(as))]).then(function (got) {
            var reply = got[1] || {};
            var playable = reply.playabilityStatus || {};
            if (playable.status !== 'OK' && asksRestart(playable)) {
                if (Date.now() >= restartAfter) {
                    restartAfter = Date.now() + RESTART_AGAIN_MS;
                    restartPage();
                    forgetScript();
                    forgetOnesie();
                    return askSigned(id, reloadToken, true);
                }
                if (restarted) {
                    restartAfter = Date.now() + RESTART_IDLE_MS;
                }
            }
            if (playable.status !== 'OK') {
                // (the line under the reason that YouTube's player shows too)
                var message = playable.errorScreen && playable.errorScreen.playerErrorMessageRenderer;
                var reason = playable.reason || '';
                var under = message ? text(message.subreason) : '';
                var failed = { status: playable.status || 'NO_REPLY', reason: under && under !== reason ? (reason ? reason + (/[.!?]$/.test(reason) ? ' ' : '. ') : '') + under : reason } as NoStreams;
                if (!message || message.proceedButton || botCheck(playable)) {
                    throw failed;
                }
                // Not signed in: as YouTube's player only if there is no account (else its token may just have failed)
                return (got[0] ? Promise.resolve('') : lastAccount()).then(function (key) {
                    failed.asYouTube = !key;
                    throw failed;
                });
            }
            var url = reply.streamingData && reply.streamingData.serverAbrStreamingUrl;
            var config = reply.playerConfig && reply.playerConfig.mediaCommonConfig && reply.playerConfig.mediaCommonConfig.mediaUstreamerRequestConfig &&
                reply.playerConfig.mediaCommonConfig.mediaUstreamerRequestConfig.videoPlaybackUstreamerConfig;
            if (!url || !config || reply.videoDetails && reply.videoDetails.isLive) {
                throw { status: 'NO_SABR', reason: 'no SABR stream' } as NoStreams;
            }
            var n = (/[?&]n=([^&]*)/.exec(url) || [])[1];
            return (n ? script.n(decodeURIComponent(n)) : Promise.resolve('')).then(function (changed: string) {
                if (n) {
                    url = url.replace(/([?&]n=)[^&]*/, '$1' + encodeURIComponent(changed));
                }
                tracking = got[0] ? { id: id, at: Date.now(), token: got[0].token, tracking: reply.playbackTracking || null } : null;
                var s = streamsOf(reply, true);
                s.sabr = {
                    url: url,
                    config: config,
                    client: { version: as.clientVersion, osName: as.osName, osVersion: as.osVersion, make: as.deviceMake, model: as.deviceModel, hl: own.hl || 'en' }
                };
                return s;
            }, function (e: Error) {
                // The transform may still be starting, or fail now: SABR is then unavailable
                throw { status: 'SABR_SCRIPT', reason: e.message } as NoStreams;
            });
        });
    }, function (e: Error) {
        throw { status: 'SABR_SCRIPT', reason: e.message } as NoStreams;
    }).then(null, function (e: NoStreams | Error) {
        throw noStreams(e);
    });
}

/** A playability status saying the client looks like a bot (not about the video) */
function botCheck(playable: any): boolean {
    return /bot/i.test(playable.reason || '');
}

/** A failure as NoStreams: an HTTP or other error gets status HTTP and its message */
function noStreams(e: NoStreams | { message: string }): NoStreams {
    return (e as NoStreams).reason !== undefined ? e as NoStreams : { status: 'HTTP', reason: (e as { message: string }).message };
}

/** The guest's /player request for a video, its texts in language hl (CLIENT's: English, as its reasons are read here) */
function askPlayer(id: string, visitorId: string, hl: string): Promise<any> {
    var client: { [name: string]: unknown } = { visitorData: visitorId };
    for (var name in CLIENT) {
        client[name] = (CLIENT as { [name: string]: unknown })[name];
    }
    client.hl = hl;
    return postYouTubeJson<any>(PLAYER, {
        context: { client: client },
        videoId: id,
        playbackContext: { contentPlaybackContext: { html5Preference: 'HTML5_PREF_WANTS' } },
        contentCheckOk: true,
        racyCheckOk: true
    }, { 'X-YouTube-Client-Name': CLIENT_NAME, 'X-YouTube-Client-Version': CLIENT.clientVersion, 'X-Goog-Visitor-Id': visitorId });
}

/** Fetch a video's streams (again: retry with a new visitor id after a bot check) */
function ask(id: string, again: boolean): Promise<Streams> {
    return visitor(again).then(function (visitorId) {
        return askPlayer(id, visitorId, CLIENT.hl);
    }).then(function (reply) {
        var playable = reply && reply.playabilityStatus || {};
        if (playable.status === 'OK') {
            return streamsOf(reply);
        }
        // A bot check (not an age check, private video etc.): retry with a new visitor id
        if (!again && playable.status === 'LOGIN_REQUIRED' && botCheck(playable)) {
            return ask(id, true);
        }
        var details = reply && reply.videoDetails || {};
        throw { status: playable.status || 'NO_REPLY', reason: playable.reason || '', length: +details.lengthSeconds || undefined,
            ended: details.isLiveContent && !details.isLive && details.title && details.channelId ? { id: id, title: details.title, channel: details.author || '', channelId: details.channelId } : undefined } as NoStreams;
    }, function (e: HttpError | NoStreams) {
        throw noStreams(e);
    });
}

/** What the own player can play from a /player reply (sabr: formats come via SABR, not URLs) */
export function streamsOf(reply: any, sabr?: boolean): Streams {
    var details = reply.videoDetails || {};
    var formats: any[] = reply.streamingData && reply.streamingData.adaptiveFormats || [];
    // A live stream's formats are numbered segments (no index)
    var live = !!details.isLive && !sabr ? formats.filter(function (f) { return f.targetDurationSec; })[0] : null;
    var playable = formats.filter(function (f) {
        // (a WebM video needs its length: its last segment ends there; a live stream's segments are numbered, SABR's
        // come whole)
        return (f.url || sabr) && (live ? f.targetDurationSec : f.initRange && f.indexRange && (sabr || !/webm/.test(f.mimeType || '') || +f.contentLength > 0)) &&
            /^((video|audio)\/mp4;|video\/webm; codecs="vp9")/.test(f.mimeType || '') && shown(f) && supported(f);
    });
    // VP9 before AV1 before H.264 at the same height and frame rate: VP9 goes up to 4K, so most videos use one codec
    // and the TV's pipeline can be reused for the next video (a codec change tears it down: player/pipeline.ts); AV1
    // (where the TV plays it) saves bandwidth over H.264, and may be all there is at 8K
    var videos = playable.filter(function (f) { return /^video\/(mp4; codecs="(avc1|av01)|webm)/.test(f.mimeType); }).map(formatOf);
    var rank = function (f: Format): number { return /webm/.test(f.mime) ? 2 : /av01/.test(f.mime) ? 1 : 0; };
    videos.sort(function (a, b) { return b.height - a.height || b.fps - a.fps || rank(b) - rank(a) || b.bitrate - a.bitrate; });
    // Stereo AAC, and with SABR Dolby Digital 5.1 (ac-3), which YouTube's TV app takes first where the TV plays it
    // (html5_enable_ac3; never Dolby Digital Plus here, nor 5.1 AAC); YouTube offers Dolby for some videos, to the
    // signed-in TV client only (its start's audio cut is handled in the SABR engine: containers.ts wholeFrames)
    var audios = audioTracks(playable.filter(function (f) {
        return sabr && /^audio\/mp4; codecs="ac-3"/.test(f.mimeType) || /^audio\/mp4; codecs="mp4a\./.test(f.mimeType) && !(+f.audioChannels > 2);
    }));
    var tracklist = reply.captions && reply.captions.playerCaptionsTracklistRenderer || {};
    var paid = reply.paidContentOverlay && reply.paidContentOverlay.paidContentOverlayRenderer;
    var s: Streams = {
        title: details.title || '',
        channel: details.author || '',
        description: details.shortDescription || '',
        videos: videos,
        audios: audios,
        captions: captionsOf(tracklist),
        translations: translationsOf(tracklist),
        sabr: null,
        storyboard: storyboardOf(reply.storyboards),
        live: live ? { segment: +live.targetDurationSec, dvr: +live.maxDvrDurationSec || 0 } : null
    };
    // (its words ours in another app language: the player is asked in English)
    var said = paid && text(paid.text);
    if (said) {
        s.paid = { text: inEnglish() ? said : tr('Includes paid promotion'), ms: +paid.durationMs || 10000 };
    }
    return s;
}

/** Per audio track the best bitrate (Dolby Digital over AAC, itag 140 over 139) and the best stable-volume one (isDrc;
 * none with Dolby: as YouTube's "Unavailable with surround sound"); the original first, then dubs by name */
function audioTracks(formats: any[]): AudioTrack[] {
    var tracks: { [id: string]: AudioTrack } = {};
    var ids: string[] = [];
    formats.forEach(function (f) {
        var about = f.audioTrack || {};
        var id = about.id || '';
        var track = tracks[id];
        if (!track) {
            ids.push(id);
            // (in another app language named by the language its id begins with: "fr.3"; its kind from its tags)
            var said = about.displayName || '';
            var name = said && ours(said, id.split('.')[0]);
            var kind = name !== said ? xtag(f.xtags, 'acont') : '';
            name = kind === 'dubbed-auto' ? tr('{1} (auto-dubbed)', name) : kind === 'descriptive' ? tr('{1} (audio description)', name) : name;
            track = tracks[id] = { id: id, name: name || tr('Original'), original: !f.audioTrack || !!about.audioIsDefault, format: null as unknown as Format, stable: null };
        }
        var format = formatOf(f);
        var slot: 'stable' | 'format' = f.isDrc ? 'stable' : 'format';
        var had = track[slot];
        if (!had || format.bitrate > had.bitrate) {
            track[slot] = format;
        }
        if (!f.isDrc && /mp4a/.test(format.mime) && (!track.stereo || format.bitrate > track.stereo.bitrate)) {
            track.stereo = format;
        }
    });
    var list = ids.map(function (id) { return tracks[id]; }).filter(function (t) { return t.format; });
    list.forEach(function (t) {
        if (/ac-3/.test(t.format.mime)) {
            t.stable = null;
        } else {
            t.stereo = null;
        }
    });
    list.sort(function (a, b) {
        return (b.original ? 1 : 0) - (a.original ? 1 : 0) || (inEnglish() ? 0 : languageOrder(a.id.split('.')[0]) - languageOrder(b.id.split('.')[0])) ||
            (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    });
    // With dubs, mark the original (YouTube's English name may say so already; ours, when it gave none, does)
    list.forEach(function (t) {
        if (t.original && list.length > 1 && t.name !== tr('Original') && !/original/i.test(t.name)) {
            t.name = tr('{1} (original)', t.name);
        }
    });
    return list;
}

/** Media Source's answers by codec, height and frame rate (asked once each: a video with dubs has ~100 formats of a
 * few kinds) */
var SUPPORTED: { [key: string]: boolean } = {};
/** Whether Media Source here checks a video's size and frame rate (webOS does; elsewhere they are ignored; null: not
 * asked yet) */
var sized: boolean | null = null;
/** Whether this device plays the format: its codec, and its size and frame rate where Media Source checks them (webOS)
 * or, on Android, as its decoders say; so 8K, 60 fps or AV1 formats are used only where the device plays them. AV1
 * not where nothing tells (a Media Source may say yes to AV1 it would decode in software) */
function supported(f: any): boolean {
    if (typeof MediaSource === 'undefined') {
        return true;
    }
    if (sized === null) {
        // A size every device plays and one none does: only a platform that checks sizes tells them apart
        sized = MediaSource.isTypeSupported('video/mp4; codecs="avc1.4d401e"; width=640; height=360; framerate=30') &&
            !MediaSource.isTypeSupported('video/mp4; codecs="avc1.4d401e"; width=30000; height=20000; framerate=30');
    }
    var key = f.mimeType + ' ' + (f.width || 0) + 'x' + (f.height || 0) + ' ' + (f.fps || 0);
    if (SUPPORTED[key] === undefined) {
        var asked = MediaSource.isTypeSupported(f.mimeType + (sized && f.width && f.height ? '; width=' + f.width + '; height=' + f.height +
            (f.fps ? '; framerate=' + f.fps : '') : ''));
        var shell = android();
        var codec = (/codecs="([^".]+)/.exec(f.mimeType) || [])[1] || '';
        var decoders = shell && shell.decodes && f.width && f.height ? shell.decodes(codec, f.width, f.height, f.fps || 0) : null;
        SUPPORTED[key] = asked && (decoders !== null ? decoders : sized || !/av01/.test(f.mimeType));
    }
    return SUPPORTED[key];
}

/** The most lines the player plays: 8K, where the device plays it (supported, shown) */
var MAX_LINES = 4320;
/** Auto's highest (the quality setting's default): 4K, as 8K takes ~80 Mbit/s */
export var AUTO_LINES = 2160;
/** The most lines this device shows (0: not known yet): MAX_LINES, on Android at most its display's */
var lines = 0;
/** Whether the device should get this format: up to its lines, by the short side so portrait videos count by width
 * (on Android, formats larger than the display drop frames) */
function shown(f: any): boolean {
    if (!lines) {
        var shell = typeof window === 'undefined' ? null : android();
        lines = Math.min(MAX_LINES, shell ? shell.screenHeight() : MAX_LINES);
    }
    return !f.height || Math.min(f.width || f.height, f.height) <= lines;
}

/** The sharpest storyboard level of a /player reply's storyboards (spec: "base|w#h#count#cols#rows#interval#name#sigh|..."),
 * with the one whose sheets cover the most time as its coarse level; null when there is none with frames over time */
function storyboardOf(boards: any): Storyboard | null {
    var spec: string = boards && boards.playerStoryboardSpecRenderer && boards.playerStoryboardSpecRenderer.spec || '';
    var parts = spec.split('|');
    var best: Storyboard | null = null;
    var widest: Storyboard | null = null;
    for (var i = 1; i < parts.length; i++) {
        var f = parts[i].split('#');
        var level: Storyboard = { base: parts[0], level: i - 1, w: +f[0], h: +f[1], count: +f[2], cols: +f[3], rows: +f[4], interval: +f[5], name: f[6] || '', sigh: f[7] || '' };
        if (level.interval > 0 && level.w > 0 && level.cols > 0 && level.rows > 0) {
            best = !best || level.w > best.w ? level : best;
            widest = !widest || sheetSeconds(level) > sheetSeconds(widest) ? level : widest;
        }
    }
    if (best && widest && sheetSeconds(widest) > sheetSeconds(best)) {
        best.coarse = widest;
    }
    return best;
}

/** How long one of sb's sheets covers (s) */
export function sheetSeconds(sb: Storyboard): number {
    return sb.cols * sb.rows * sb.interval / 1000;
}

/** A frame of a storyboard: its sheet's address and its column and row there */
export interface StoryboardFrame {
    url: string;
    col: number;
    row: number;
}

/** Where the frame at t (s) is */
export function storyboardFrame(sb: Storyboard, t: number): StoryboardFrame {
    var index = Math.max(0, Math.min(sb.count - 1, Math.floor(t * 1000 / sb.interval)));
    var per = sb.cols * sb.rows;
    var at = index % per;
    var url = sb.base.replace('$L', String(sb.level)).replace('$N', sb.name.replace('$M', String(Math.floor(index / per))));
    return { url: url + (sb.sigh ? '&sigh=' + sb.sigh : ''), col: at % sb.cols, row: Math.floor(at / sb.cols) };
}

/** The video's uploaded and auto-generated subtitles */
function captionsOf(list: any): Caption[] {
    return (list.captionTracks || []).filter(function (t: any) { return t.baseUrl; }).map(function (t: any) {
        var said = text(t.name) || t.languageCode || '';
        var asr = t.kind === 'asr';
        // In another app language its language's name there, a track's own name after YouTube's " - " kept
        var dash = said.indexOf(' - ');
        var name = ours(said, t.languageCode || '');
        if (name !== said && dash >= 0) {
            name += said.slice(dash);
        }
        return { url: t.baseUrl + '&fmt=vtt', language: t.languageCode || '', name: asr && !/auto/i.test(name) ? tr('{1} (auto-generated)', name) : name,
            kind: asr ? 'asr' : 'own' } as Caption;
    });
}

/** The app is in English, as the player request is asked (YouTube's names and notices from it shown as they come) */
function inEnglish(): boolean {
    return language() === 'en';
}

/** A track's name: YouTube's in English (the player request's language), else its language's in the app's language
 * (YouTube's for a language not known here) */
function ours(said: string, code: string): string {
    return inEnglish() || !code ? said : trackName(code) || said;
}

/** A format's tag (YouTube's xtags: a base64 list of key and value pairs, e.g. acont=dubbed-auto, drc=1; '' none) */
function xtag(xtags: string, key: string): string {
    var b = paramBytes(xtags);
    // Each pair: field 1 (0x0a), its length, then field 1 the key and field 2 (0x12) the value, each with its length
    for (var at = 0; at + 1 < b.length && b.charCodeAt(at) === 0x0a; at += 2 + b.charCodeAt(at + 1)) {
        var pair = b.substr(at + 2, b.charCodeAt(at + 1));
        var keyLength = pair.charCodeAt(1);
        if (pair.charCodeAt(0) === 0x0a && pair.substr(2, keyLength) === key && pair.charCodeAt(2 + keyLength) === 0x12) {
            return pair.substr(4 + keyLength, pair.charCodeAt(3 + keyLength));
        }
    }
    return '';
}

/** The translation source: uploaded English, else another uploaded track, else the auto-generated track of the
 * default audio (a dubbed video has one per dub, timed to that dub, so it is taken from the default audio's list) */
function translationsOf(list: any): Translations | null {
    var all: any[] = list.captionTracks || [];
    var usable = function (t: any): boolean { return !!t && !!t.baseUrl && !!t.isTranslatable; };
    var own = all.filter(function (t) { return usable(t) && t.kind !== 'asr'; });
    var sound = (list.audioTracks || [])[list.defaultAudioTrackIndex || 0];
    var heard = (sound && sound.captionTrackIndices || []).map(function (i: number) { return all[i]; }).filter(usable)[0] || null;
    var from = own.filter(function (t) { return base(t.languageCode || '') === 'en'; })[0] || own[0] || heard || all.filter(usable)[0];
    var to = (list.translationLanguages || []).filter(function (l: any) { return !!l.languageCode; }).map(function (l: any) {
        return { code: l.languageCode, name: text(l.languageName) };
    });
    return from && to.length ? { from: from.baseUrl, to: to, heard: heard && heard.kind === 'asr' ? heard.languageCode || '' : '' } : null;
}

/** A video's subtitles for the lists: uploaded, auto-generated, and YouTube translations for the Settings languages
 * it lacks. Settings languages first (each in KINDS order), the rest in YouTube's order. Built on each call, since
 * Settings can change while the streams are cached. */
export function captionList(s: Streams): Caption[] {
    var wanted = subtitleLanguages();
    var captions = s.captions.slice();
    var t = s.translations;
    if (t) {
        var source = captions.filter(function (c) { return c.url === t!.from + '&fmt=vtt'; })[0];
        t.to.forEach(function (l) {
            // Another dub's auto-generated track is timed to that dub, so it does not count
            var has = captions.some(function (c) { return c.kind === 'own' && sameLanguage(c.language, l.code); }) || !!t!.heard && sameLanguage(t!.heard, l.code);
            if (wanted.indexOf(l.code) >= 0 && !has) {
                captions.push({ url: t!.from + '&fmt=vtt&tlang=' + l.code, language: l.code, name: tr('{1} (auto-translated)', ours(l.name, l.code)), kind: 'translated',
                    source: source });
            }
        });
    }
    var rank = function (c: Caption): number {
        var at = wanted.indexOf(c.language);
        if (at < 0) {
            at = wanted.indexOf(base(c.language));
        }
        return (at < 0 ? wanted.length : at) * 3 + KINDS.indexOf(c.kind);
    };
    // By rank, else YouTube's order (by the English names), in another app language by the names there (sort is not
    // stable here)
    var named = !inEnglish();
    var order = captions.map(function (c, i) { return { c: c, rank: rank(c), i: i }; });
    order.sort(function (a, b) {
        return a.rank - b.rank || (named ? languageOrder(a.c.language) - languageOrder(b.c.language) || (a.c.name < b.c.name ? -1 : a.c.name > b.c.name ? 1 : 0) : 0) ||
            a.i - b.i;
    });
    return order.map(function (o) { return o.c; });
}

/** Whether language matches code: equal, or code has no region ("en") and language is a regional variant ("en-GB") */
function sameLanguage(language: string, code: string): boolean {
    return language === code || code.indexOf('-') < 0 && base(language) === code;
}

/** Subtitles in a language: exact match, else the same base language ("pt-PT": "pt"); uploaded first, as captionList
 * orders them ('' or none: null) */
export function captionIn(captions: Caption[], language: string): Caption | null {
    return language ? captions.filter(function (c) { return c.language === language; })[0] ||
        captions.filter(function (c) { return base(c.language) === base(language); })[0] || null : null;
}

/** "en" of "en-GB" */
export function base(language: string): string {
    return language.split('-')[0];
}


/** A format's byte range (none, as a live format's segments are numbered: 0 to -1) */
function rangeOf(r: any): Range {
    return r ? { start: +r.start, end: +r.end } : { start: 0, end: -1 };
}

function formatOf(f: any): Format {
    return {
        itag: f.itag,
        url: f.url,
        mime: f.mimeType,
        width: f.width || 0,
        height: f.height || 0,
        fps: f.fps || 0,
        bitrate: f.averageBitrate || f.bitrate || 0,
        length: +f.contentLength || 0,
        duration: (+f.approxDurationMs || 0) / 1000,
        init: rangeOf(f.initRange),
        index: rangeOf(f.indexRange),
        lmt: String(f.lastModified || ''),
        xtags: f.xtags || '',
        track: f.audioTrack && f.audioTrack.id || '',
        drc: !!f.isDrc
    };
}

/** The format to play: the highest up to maxHeight (0: any), else the lowest. At equal height and frame rate, prefer
 * kind (the codec of the current pipeline, so it can be reused: player/pipeline.ts) */
export function pickFormat(videos: Format[], maxHeight: number, kind?: string): Format | null {
    for (var i = 0; i < videos.length; i++) {
        if (!maxHeight || videos[i].height <= maxHeight) {
            var first = videos[i];
            var same = kind ? videos.filter(function (f) { return f.height === first.height && f.fps === first.fps && kindOf(f.mime) === kind; })[0] : null;
            return same || first;
        }
    }
    return videos.length ? videos[videos.length - 1] : null;
}

/** A format's container and codec, which decide the Media Source buffer it needs ('video/webm vp9', 'video/mp4 avc1',
 * 'audio/mp4 mp4a') */
export function kindOf(mime: string): string {
    var m = /^([^;]+);\s*codecs="([^.",]+)/.exec(mime);
    return m ? m[1] + ' ' + m[2] : mime;
}
