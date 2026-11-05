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

import { getText, HttpError, postJson } from '../../core/http.js';
import { android } from '../../core/platform.js';
import { load, save } from '../../core/store.js';
import { text } from './feed.js';
import { subtitleLanguages } from './languages.js';
import { playerScript } from './player-script.js';
import { SabrClient } from './sabr.js';
import { freshSignIn, innertube, noAnswer, tvClient } from './youtube.js';

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
/** How long a /player reply's tracking URLs stay usable */
var TRACKING_MS = 10 * 60 * 1000;
var kept: { id: string; sabr: boolean; at: number; streams: Promise<Streams> }[] = [];

/** A video's streams as a guest (cached for KEEP_MS); rejects with NoStreams */
export function streams(id: string): Promise<Streams> {
    return keep(id, false, function () { return ask(id, false); });
}

/** A video's streams as the account, via SABR (cached like streams; reloadToken: a reload's, Sabr.reloadToken); rejects
 * with NoStreams */
export function sabrStreams(id: string, reloadToken?: string): Promise<Streams> {
    return keep(id, true, function () { return askSabr(id, reloadToken || ''); });
}

/** The method that worked lately where the other failed for reasons not the video's own (SABR or as a guest): it goes
 * first until LEARNED_MS later, then the Settings choice again */
var learned: { sabr: boolean; at: number } | null = null;
var LEARNED_MS = 30 * 60 * 1000;

/** Whether SABR goes first now: the method that worked lately, else sabrFirst (Settings) */
export function sabrFirstNow(sabrFirst: boolean): boolean {
    return learned && Date.now() - learned.at < LEARNED_MS ? learned.sabr : sabrFirst;
}

/** The method (sabr or as a guest) played where the other failed (why: the other's reason, if known); unless that was
 * about the video itself, it goes first for a while */
export function learnMethod(sabr: boolean, why?: NoStreams): void {
    if (!why || !aboutTheVideo(why)) {
        learned = { sabr: sabr, at: Date.now() };
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

/** A video's streams for the own player: as a guest, else via SABR (age check, members only); sabrFirst reverses
 * the order, as does the method that worked lately (sabrFirstNow). If both fail, rejects with the first reason (and the
 * other's). */
export function playableStreams(id: string, sabrFirst: boolean): Promise<Streams> {
    var sabr = sabrFirstNow(sabrFirst);
    var first = sabr ? sabrStreams(id) : streams(id);
    return first.then(null, function (e: NoStreams) {
        // Removed, an upcoming live stream, or no network: the other method cannot play it either
        if (noneCanPlay(e) || noAnswer(e)) {
            throw e;
        }
        return (sabr ? streams(id) : sabrStreams(id)).then(function (s) {
            learnMethod(!sabr, e);
            // A copy is marked: the kept one serves later plays, which try the first method again
            var only = {} as Streams;
            for (var name in s) {
                (only as any)[name] = (s as any)[name];
            }
            only.only = true;
            return only;
        }, function (other: NoStreams) {
            throw { status: e.status, reason: e.reason + (other.reason ? ' (' + (sabr ? 'as a guest' : 'SABR') + ': ' + other.reason + ')' : '') } as NoStreams;
        });
    });
}

/** Whether a video's streams are kept (by this method: asking for them makes no request to YouTube) */
export function streamsKept(id: string, sabr: boolean): boolean {
    return !!keptOf(id, sabr, Date.now());
}

/** A video's streams kept by this method, still fresh at now */
function keptOf(id: string, sabr: boolean, now: number): typeof kept[0] | undefined {
    return kept.filter(function (k) { return k.id === id && k.sabr === sabr && now - k.at < KEEP_MS; })[0];
}

function keep(id: string, sabr: boolean, asking: () => Promise<Streams>): Promise<Streams> {
    var now = Date.now();
    var had = keptOf(id, sabr, now);
    if (had) {
        return had.streams;
    }
    var asked = asking();
    kept = kept.filter(function (k) { return !(k.id === id && k.sabr === sabr); }).concat([{ id: id, sabr: sabr, at: now, streams: asked }]).slice(-KEEP_COUNT);
    asked.then(null, function () {
        kept = kept.filter(function (k) { return k.streams !== asked; });
    });
    return asked;
}

/** A SABR /player request's playback context: the player script's signature timestamp, and a reload's token if any */
export function sabrPlayback(sts: number, reloadToken: string): { [name: string]: unknown } {
    var playback: { [name: string]: unknown } = { contentPlaybackContext: { html5Preference: 'HTML5_PREF_WANTS', signatureTimestamp: sts } };
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

/** /player as the signed-in TV client, with the player script's signature timestamp (and a reload's token, '' none):
 * the formats, the SABR URL (n transformed by that script) and the client details SABR requests send */
function askSabr(id: string, reloadToken: string): Promise<Streams> {
    return playerScript().then(function (script) {
        return Promise.all<any>([tvClient(), freshSignIn(), innertube('player', {
            videoId: id,
            contentCheckOk: true,
            racyCheckOk: true,
            playbackContext: sabrPlayback(script.sts, reloadToken)
        })]).then(function (got) {
            var reply = got[2] || {};
            var playable = reply.playabilityStatus || {};
            if (playable.status !== 'OK') {
                throw { status: playable.status || 'NO_REPLY', reason: playable.reason || '' } as NoStreams;
            }
            var url = reply.streamingData && reply.streamingData.serverAbrStreamingUrl;
            var config = reply.playerConfig && reply.playerConfig.mediaCommonConfig && reply.playerConfig.mediaCommonConfig.mediaUstreamerRequestConfig &&
                reply.playerConfig.mediaCommonConfig.mediaUstreamerRequestConfig.videoPlaybackUstreamerConfig;
            if (!url || !config || reply.videoDetails && reply.videoDetails.isLive) {
                throw { status: 'NO_SABR', reason: 'no SABR stream' } as NoStreams;
            }
            var n = (/[?&]n=([^&]*)/.exec(url) || [])[1];
            return (n ? script.n(decodeURIComponent(n)) : Promise.resolve('')).then(function (changed) {
                if (n) {
                    url = url.replace(/([?&]n=)[^&]*/, '$1' + encodeURIComponent(changed));
                }
                var c = got[0].context.client;
                tracking = got[1] ? { id: id, at: Date.now(), token: got[1].token, tracking: reply.playbackTracking || null } : null;
                var s = streamsOf(reply, true);
                s.sabr = {
                    url: url,
                    config: config,
                    client: { version: c.clientVersion || '', osName: c.osName || '', osVersion: c.osVersion || '', make: c.deviceMake || '', model: c.deviceModel || '', hl: c.hl || 'en' }
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

/** A failure as NoStreams: an HTTP or other error gets status HTTP and its message */
function noStreams(e: NoStreams | { message: string }): NoStreams {
    return (e as NoStreams).reason !== undefined ? e as NoStreams : { status: 'HTTP', reason: (e as { message: string }).message };
}

/** Fetch a video's streams (again: retry with a new visitor id after a bot check) */
function ask(id: string, again: boolean): Promise<Streams> {
    return visitor(again).then(function (visitorId) {
        var client: { [name: string]: unknown } = { visitorData: visitorId };
        for (var name in CLIENT) {
            client[name] = (CLIENT as { [name: string]: unknown })[name];
        }
        return postJson<any>(PLAYER, {
            context: { client: client },
            videoId: id,
            playbackContext: { contentPlaybackContext: { html5Preference: 'HTML5_PREF_WANTS' } },
            contentCheckOk: true,
            racyCheckOk: true
        }, { 'X-YouTube-Client-Name': CLIENT_NAME, 'X-YouTube-Client-Version': CLIENT.clientVersion, 'X-Goog-Visitor-Id': visitorId });
    }).then(function (reply) {
        var playable = reply && reply.playabilityStatus || {};
        if (playable.status === 'OK') {
            return streamsOf(reply);
        }
        // A bot check (not an age check, private video etc.): retry with a new visitor id
        if (!again && playable.status === 'LOGIN_REQUIRED' && /bot/i.test(playable.reason || '')) {
            return ask(id, true);
        }
        throw { status: playable.status || 'NO_REPLY', reason: playable.reason || '', length: +(reply && reply.videoDetails && reply.videoDetails.lengthSeconds) || undefined } as NoStreams;
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
    var audios = audioTracks(playable.filter(function (f) { return /^audio\/mp4/.test(f.mimeType); }));
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
    var said = paid && text(paid.text);
    if (said) {
        s.paid = { text: said, ms: +paid.durationMs || 10000 };
    }
    return s;
}

/** AAC per audio track: the best bitrate (itag 140 over 139) and the best stable-volume one (isDrc); the original
 * first, then dubs by name */
function audioTracks(formats: any[]): AudioTrack[] {
    var tracks: { [id: string]: AudioTrack } = {};
    var ids: string[] = [];
    formats.forEach(function (f) {
        var about = f.audioTrack || {};
        var id = about.id || '';
        var track = tracks[id];
        if (!track) {
            ids.push(id);
            track = tracks[id] = { id: id, name: about.displayName || 'Original', original: !f.audioTrack || !!about.audioIsDefault, format: null as unknown as Format, stable: null };
        }
        var format = formatOf(f);
        var slot: 'stable' | 'format' = f.isDrc ? 'stable' : 'format';
        var had = track[slot];
        if (!had || format.bitrate > had.bitrate) {
            track[slot] = format;
        }
    });
    var list = ids.map(function (id) { return tracks[id]; }).filter(function (t) { return t.format; });
    list.sort(function (a, b) { return (b.original ? 1 : 0) - (a.original ? 1 : 0) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0); });
    // With dubs, mark the original
    list.forEach(function (t) {
        if (t.original && list.length > 1 && !/original/i.test(t.name)) {
            t.name += ' (original)';
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
        var name = text(t.name) || t.languageCode || '';
        var asr = t.kind === 'asr';
        return { url: t.baseUrl + '&fmt=vtt', language: t.languageCode || '', name: asr && !/auto/i.test(name) ? name + ' (auto-generated)' : name, kind: asr ? 'asr' : 'own' } as Caption;
    });
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
    var to = (list.translationLanguages || []).map(function (l: any) { return { code: l.languageCode, name: text(l.languageName) }; });
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
                captions.push({ url: t!.from + '&fmt=vtt&tlang=' + l.code, language: l.code, name: l.name + ' (auto-translated)', kind: 'translated',
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
    // By rank, else YouTube's order (sort is not stable here)
    var order = captions.map(function (c, i) { return { c: c, rank: rank(c), i: i }; });
    order.sort(function (a, b) { return a.rank - b.rank || a.i - b.i; });
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
