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
}

/** Why there are no streams: YouTube's reason, or what failed */
export interface NoStreams {
    status: string;
    reason: string;
}

/** The visitor id: the stored one while recent (unless fresh), else a new one */
function visitor(fresh: boolean): Promise<string> {
    var kept = load<{ id: string; at: number }>(VISITOR_KEY);
    if (!fresh && kept && kept.id && Date.now() - kept.at < VISITOR_DAYS * 24 * 3600 * 1000) {
        return Promise.resolve(kept.id);
    }
    return getText(VISITOR).then(function (text) {
        var id = (/"(Cg[A-Za-z0-9_%-]{20,})"/.exec(text) || [])[1];
        if (!id) {
            throw { status: 'NO_VISITOR', reason: 'YouTube gave no visitor id' } as NoStreams;
        }
        save(VISITOR_KEY, { id: id, at: Date.now() });
        return id;
    });
}

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

/** A video's streams as the account, via SABR (cached like streams); rejects with NoStreams */
export function sabrStreams(id: string): Promise<Streams> {
    return keep(id, true, function () { return askSabr(id); });
}

/** A video's streams for the own player: as a guest, else via SABR (age check, members only); sabrFirst reverses
 * the order. If both fail, rejects with the first reason (and the other's). */
export function playableStreams(id: string, sabrFirst: boolean): Promise<Streams> {
    var first = sabrFirst ? sabrStreams(id) : streams(id);
    return first.then(null, function (e: NoStreams) {
        // Removed, an upcoming live stream, or no network: the other method cannot play it either
        if (e.status === 'ERROR' || e.status === 'LIVE_STREAM_OFFLINE' || noAnswer(e)) {
            throw e;
        }
        return (sabrFirst ? streams(id) : sabrStreams(id)).then(function (s) {
            s.only = true;
            return s;
        }, function (other: NoStreams) {
            throw { status: e.status, reason: e.reason + (other.reason ? ' (' + (sabrFirst ? 'as a guest' : 'SABR') + ': ' + other.reason + ')' : '') } as NoStreams;
        });
    });
}

function keep(id: string, sabr: boolean, asking: () => Promise<Streams>): Promise<Streams> {
    var now = Date.now();
    var had = kept.filter(function (k) { return k.id === id && k.sabr === sabr && now - k.at < KEEP_MS; })[0];
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

/** /player as the signed-in TV client, with the player script's signature timestamp: the formats, the SABR URL
 * (n transformed by that script) and the client details SABR requests send */
function askSabr(id: string): Promise<Streams> {
    return playerScript().then(function (script) {
        return Promise.all<any>([tvClient(), freshSignIn(), innertube('player', {
            videoId: id,
            contentCheckOk: true,
            racyCheckOk: true,
            playbackContext: { contentPlaybackContext: { html5Preference: 'HTML5_PREF_WANTS', signatureTimestamp: script.sts } }
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
            });
        });
    }, function (e: Error) {
        throw { status: 'NO_SABR', reason: e.message } as NoStreams;
    }).then(null, function (e: NoStreams | Error) {
        throw (e as NoStreams).reason !== undefined ? e : { status: 'HTTP', reason: (e as Error).message } as NoStreams;
    });
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
        throw { status: playable.status || 'NO_REPLY', reason: playable.reason || '' } as NoStreams;
    }, function (e: HttpError | NoStreams) {
        throw (e as NoStreams).reason !== undefined ? e : { status: 'HTTP', reason: (e as HttpError).message } as NoStreams;
    });
}

/** What the own player can play from a /player reply (sabr: formats come via SABR, not URLs) */
export function streamsOf(reply: any, sabr?: boolean): Streams {
    var details = reply.videoDetails || {};
    var formats: any[] = reply.streamingData && reply.streamingData.adaptiveFormats || [];
    var playable = formats.filter(function (f) {
        return (f.url || sabr) && f.initRange && f.indexRange && /^((video|audio)\/mp4;|video\/webm; codecs="vp9")/.test(f.mimeType || '') && supported(f.mimeType) &&
            shown(f);
    });
    // VP9 before H.264 at the same height and frame rate: VP9 goes up to 4K, so most videos use one codec and the
    // TV's pipeline can be reused for the next video (a codec change tears it down: player/pipeline.ts)
    var videos = playable.filter(function (f) { return /^video\/(mp4; codecs="avc1|webm)/.test(f.mimeType); }).map(formatOf);
    var vp9 = function (f: Format): number { return /webm/.test(f.mime) ? 1 : 0; };
    videos.sort(function (a, b) { return b.height - a.height || b.fps - a.fps || vp9(b) - vp9(a) || b.bitrate - a.bitrate; });
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
        storyboard: storyboardOf(reply.storyboards)
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
        var had = f.isDrc ? track.stable : track.format;
        if (!had || format.bitrate > had.bitrate) {
            if (f.isDrc) {
                track.stable = format;
            } else {
                track.format = format;
            }
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

/** Media Source support per MIME type (checked once per type: a video with dubs has ~100 formats of a few types) */
var SUPPORTED: { [mime: string]: boolean } = {};
function supported(mime: string): boolean {
    if (typeof MediaSource === 'undefined') {
        return true;
    }
    if (SUPPORTED[mime] === undefined) {
        SUPPORTED[mime] = MediaSource.isTypeSupported(mime);
    }
    return SUPPORTED[mime];
}

/** The display's line count (0: not known yet; Infinity: no limit) */
var lines = 0;
/** Whether the device should get this format: on Android up to the display's lines (by the short side, so portrait
 * videos count by width; larger formats drop frames), on the TV any (4K: own-player.ts) */
function shown(f: any): boolean {
    if (!lines) {
        var shell = typeof window === 'undefined' ? null : android();
        lines = shell && shell.screenHeight && shell.screenHeight() || Infinity;
    }
    return !f.height || Math.min(f.width || f.height, f.height) <= lines;
}

/** The sharpest storyboard level of a /player reply's storyboards (spec: "base|w#h#count#cols#rows#interval#name#sigh|..."),
 * null when there is none with frames over time */
export function storyboardOf(boards: any): Storyboard | null {
    var spec: string = boards && boards.playerStoryboardSpecRenderer && boards.playerStoryboardSpecRenderer.spec || '';
    var parts = spec.split('|');
    var best: Storyboard | null = null;
    for (var i = 1; i < parts.length; i++) {
        var f = parts[i].split('#');
        var level: Storyboard = { base: parts[0], level: i - 1, w: +f[0], h: +f[1], count: +f[2], cols: +f[3], rows: +f[4], interval: +f[5], name: f[6] || '', sigh: f[7] || '' };
        if (level.interval > 0 && level.w > 0 && level.cols > 0 && level.rows > 0 && (!best || level.w > best.w)) {
            best = level;
        }
    }
    return best;
}

/** Where the frame at t (s) is: its sheet's address and its column and row there */
export function storyboardFrame(sb: Storyboard, t: number): { url: string; col: number; row: number } {
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
        t.to.forEach(function (l) {
            // Another dub's auto-generated track is timed to that dub, so it does not count
            var has = captions.some(function (c) { return c.kind === 'own' && sameLanguage(c.language, l.code); }) || !!t!.heard && sameLanguage(t!.heard, l.code);
            if (wanted.indexOf(l.code) >= 0 && !has) {
                captions.push({ url: t!.from + '&fmt=vtt&tlang=' + l.code, language: l.code, name: l.name + ' (auto-translated)', kind: 'translated' });
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
export function sameLanguage(language: string, code: string): boolean {
    return language === code || code.indexOf('-') < 0 && base(language) === code;
}

/** "en" of "en-GB" */
export function base(language: string): string {
    return language.split('-')[0];
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
        init: { start: +f.initRange.start, end: +f.initRange.end },
        index: { start: +f.indexRange.start, end: +f.indexRange.end },
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
