// DeArrow (dearrow.ajay.app): the titles and thumbnails its users submit for videos, in place of YouTube's (often
// clickbait), in its classic mode, or its casual one (YouTube's titles stay where its users voted them fine); with
// Settings' options: its thumbnails, a random frame where none was submitted, and every title tidied (title-format.ts).
// Each video's branding comes from DeArrow's server, a few at a time in the order asked, and is kept: the latest on the
// device for a few days, so pages drawn from the device at start (Home) draw with it at once.
// A thumbnail is a frame from DeArrow's thumbnail server, which sends the picture on to YouTube's thumbnail when it
// has no frame ready. Whatever DeArrow lacks or fails at keeps YouTube's own.

import { errorBody, getJson, HttpError } from '../../core/http.js';
import { load, save } from '../../core/store.js';
import { prefs } from './prefs.js';
import { tidyTitle, unmark } from './title-format.js';

var BRANDING = 'https://sponsor.ajay.app/api/branding?videoID=';
var FRAMES = 'https://dearrow-thumb.ajay.app/api/v1/getThumbnail?videoID=';
var TIMEOUT_MS = 5000;
/** A video DeArrow failed for is asked again after this (ms) */
var RETRY_MS = 10 * 60 * 1000;
/** Requests at once (the TV's browser opens up to six connections to a server) */
var PARALLEL = 6;
/** Videos whose branding is kept, and of those on the device (for how many days, written how long after the last
 * arrival) */
var KEPT = 3000;
var STORE_KEY = 'youtube.dearrow2';
var STORED = 1000;
var STORED_DAYS = 3;
/** Written this long after the last arrival (and when the app hides or exits: saveDearrow) */
var STORE_MS = 30000;

/** A video's branding, whatever Settings turn on */
export interface Branding {
    /** The submitted title ('' none) */
    title: string;
    /** The submitted frame's time (s; -1 none, or YouTube's thumbnail was voted best) */
    frame: number;
    /** The random frame's time where no thumbnail was submitted (s; -1 none) */
    random: number;
    /** The titles its users voted fine as they are, lowercase ('' any title) */
    casual: string[];
    /** The day it came (kept ones) */
    day?: number;
}

interface Submission {
    votes: number;
    locked: boolean;
    original: boolean;
}

export interface BrandingReply {
    titles?: (Submission & { title: string })[];
    thumbnails?: (Submission & { timestamp: number | null })[];
    randomTime?: number;
    videoDuration?: number | null;
    casualVotes?: { id: string; count: number; title?: string }[];
}

/** Known branding by video id, oldest first in order (stored ones are read once, when first needed), when DeArrow
 * failed for a video (not kept: asked again after RETRY_MS), and when those were last swept */
var known: { [id: string]: Branding } | null = null;
var order: string[] = [];
var failed: { [id: string]: number } = {};
var swept = 0;
var storeTimer = 0;
/** The titles shown, by video id, with what they were made from (cleared when the settings change) */
var shown: { [id: string]: { own: boolean; chosen: string; title: string } } = {};
var shownCount = 0;
var shownAs = '';
/** Waiting to be asked (with the video's length, for a random frame), and how many are being asked */
var queue: { id: string; length: number }[] = [];
var queued: { [id: string]: boolean } = {};
var asking = 0;
/** Told of each video whose branding arrives */
var listeners: ((id: string) => void)[] = [];

/** DeArrow is on (its classic or casual mode) */
export function dearrowOn(): boolean {
    return prefs().dearrow !== '';
}

/** dearrowSettings' text, and the mode and options list it was made from (Settings sets a new list on a change) */
var settings = { mode: '', options: [] as string[], text: '' };

/** DeArrow's settings as one text (tiles made with other ones are made again) */
export function dearrowSettings(): string {
    var p = prefs();
    if (settings.mode !== p.dearrow || settings.options !== p.dearrowOptions) {
        settings = { mode: p.dearrow, options: p.dearrowOptions, text: p.dearrow + ' ' + p.dearrowOptions.join() };
    }
    return settings.text;
}

/** One of DeArrow's options is on: 'thumbnails', 'frames', 'tidy' */
function option(name: string): boolean {
    return prefs().dearrowOptions.indexOf(name) >= 0;
}

/** A video whose branding is asked for: its id, its length if known (for a random frame) and, for a page, its page
 * (pages have none) */
export interface Wanted {
    id: string;
    length?: string;
    page?: unknown;
}

/** Stored on the device: [id, title, frame, random, day, casual] each */
type Stored = [string, string, number, number, number, string[]];

/** The known branding, the stored part read on first use (days old ones dropped) */
function knownBranding(): { [id: string]: Branding } {
    if (!known) {
        known = {};
        var today = day();
        (load<Stored[]>(STORE_KEY) || []).forEach(function (s) {
            if (today - s[4] < STORED_DAYS) {
                known![s[0]] = { title: s[1], frame: s[2], random: s[3], casual: s[5] || [], day: s[4] };
                order.push(s[0]);
            }
        });
    }
    return known;
}

function day(): number {
    return Math.floor(Date.now() / 86400000);
}

/** The branding of a DeArrow reply (a video with nothing submitted comes with only the random frame's time); length: the
 * video's length (s) when DeArrow does not know it */
export function brandingOf(reply: BrandingReply, length: number): Branding {
    var title = trusted(reply.titles);
    var thumbnail = trusted(reply.thumbnails);
    var duration = reply.videoDuration || length;
    return {
        // DeArrow sends < as \u2039 (a word's > marks it to keep its case: kept for tidying)
        title: title && !title.original ? title.title.replace(/\u2039/g, '<') : '',
        frame: thumbnail && !thumbnail.original && thumbnail.timestamp !== null ? thumbnail.timestamp : -1,
        random: !thumbnail && reply.randomTime !== undefined && duration > 0 ? reply.randomTime * duration : -1,
        casual: (reply.casualVotes || []).filter(function (c) { return c.count >= 1; }).map(function (c) { return (c.title || '').toLowerCase(); })
    };
}

/** The best submission, if trusted: locked, or not voted down */
function trusted<T extends Submission>(list: T[] | undefined): T | null {
    var best = list && list[0];
    return best && (best.locked || best.votes >= 0) ? best : null;
}

/** A video's title (title: YouTube's) while DeArrow is on: its users' where they submitted one (not in casual mode
 * where they voted YouTube's fine), else YouTube's; tidied if chosen */
export function dearrowTitle(id: string, title: string): string {
    if (!dearrowOn()) {
        return title;
    }
    var b = knownBranding()[id];
    var own = !b || !b.title || prefs().dearrow === 'casual' && votedFine(b, title);
    var chosen = own ? title : b!.title;
    // Tidied once per title (the formatter is long for the TV)
    var now = dearrowSettings();
    if (now !== shownAs || shownCount > KEPT) {
        shown = {};
        shownCount = 0;
        shownAs = now;
    }
    var had = shown[id];
    if (had && had.own === own && had.chosen === chosen) {
        return had.title;
    }
    // (A submitted title's > marks only keep a word's case; YouTube's own > are its title's)
    var result = option('tidy') ? tidyTitle(chosen, !own) : own ? chosen : unmark(chosen);
    shown[id] = { own: own, chosen: chosen, title: result };
    shownCount++;
    return result;
}

/** Casual mode: DeArrow's users voted YouTube's title fine (a vote without a title fits any) */
function votedFine(b: Branding, title: string): boolean {
    var lower = title.trim().toLowerCase();
    return b.casual.some(function (t) { return !t || t === lower; });
}

/** A video's picture: DeArrow's frame where thumbnails (or random frames) are on and it has one, else youtube (also
 * where the frame is not ready: the thumbnail server redirects to it) */
export function dearrowPicture(id: string, youtube: string): string {
    var b = dearrowOn() ? knownBranding()[id] : null;
    var time = !b ? -1 : b.frame >= 0 && option('thumbnails') ? b.frame : b.frame < 0 && option('frames') ? b.random : -1;
    return time < 0 ? youtube : FRAMES + encodeURIComponent(id) + '&time=' + time +
        (/^https:\/\/i\.ytimg\.com\//.test(youtube) ? '&redirectUrl=' + encodeURIComponent(youtube) : '');
}

/** The videos' branding asked for where not known yet (pages are skipped), ahead of those asked for before if first
 * (a screen waiting for it); the ids still to come */
export function dearrowFetch(videos: Wanted[], first?: boolean): string[] {
    var missing: string[] = [];
    var seen: { [id: string]: boolean } = {};
    var jobs: { id: string; length: number }[] = [];
    var all = knownBranding();
    var now = Date.now();
    videos.forEach(function (v) {
        if (v.page || v.id in all || seen[v.id] || now - (failed[v.id] || 0) < RETRY_MS) {
            return;
        }
        seen[v.id] = true;
        missing.push(v.id);
        if (!queued[v.id]) {
            queued[v.id] = true;
            jobs.push({ id: v.id, length: seconds(v.length || '') });
        }
    });
    // First: the new ones, and those already waiting, before the rest (one being asked stays as it is)
    queue = first ? jobs.concat(queue.filter(function (j) { return seen[j.id]; }), queue.filter(function (j) { return !seen[j.id]; })) :
        queue.concat(jobs);
    askNext();
    return missing;
}

/** dearrowFetch first, resolving once all of it is known, or after ms at most */
export function dearrowWait(videos: Wanted[], ms: number): Promise<void> {
    var missing: { [id: string]: boolean } = {};
    var left = 0;
    dearrowFetch(videos, true).forEach(function (id) {
        missing[id] = true;
        left++;
    });
    if (!left) {
        return Promise.resolve();
    }
    return new Promise<void>(function (resolve) {
        var stop = function (): void {
            clearTimeout(timer);
            unlisten();
            resolve();
        };
        var timer = setTimeout(stop, ms);
        var unlisten = dearrowListen(function (id) {
            if (missing[id]) {
                delete missing[id];
                if (!--left) {
                    stop();
                }
            }
        });
    });
}

/** Calls fn with each video whose branding arrives; returns the function that stops it */
export function dearrowListen(fn: (id: string) => void): () => void {
    listeners.push(fn);
    return function () {
        var at = listeners.indexOf(fn);
        if (at >= 0) {
            listeners.splice(at, 1);
        }
    };
}

function askNext(): void {
    while (asking < PARALLEL && queue.length) {
        ask(queue.shift()!);
    }
}

function ask(job: { id: string; length: number }): void {
    asking++;
    getJson<BrandingReply>(BRANDING + encodeURIComponent(job.id), TIMEOUT_MS).then(null, function (e: HttpError) {
        // Nothing submitted: 404, with the random frame's time; anything else keeps YouTube's
        return e.status === 404 ? errorBody<BrandingReply>(e) : null;
    }).then(function (reply) {
        var b: Branding | null = null;
        try {
            b = reply ? brandingOf(reply, job.length) : null;
        } catch (e) {
            // A reply of another shape: as a failure
        }
        if (b) {
            keep(job.id, b);
        } else {
            // (only failures within RETRY_MS are kept, swept once per RETRY_MS: DeArrow down a while fails every tile)
            var now = Date.now();
            if (now - swept >= RETRY_MS) {
                swept = now;
                for (var id in failed) {
                    if (now - failed[id] >= RETRY_MS) {
                        delete failed[id];
                    }
                }
            }
            failed[job.id] = now;
        }
        asking--;
        delete queued[job.id];
        listeners.slice().forEach(function (fn) { fn(job.id); });
        askNext();
    });
}

/** Keeps a video's branding, the latest stored a moment after the last arrival */
function keep(id: string, b: Branding): void {
    var all = knownBranding();
    b.day = day();
    all[id] = b;
    delete failed[id];
    order.push(id);
    while (order.length > KEPT) {
        delete all[order.shift()!];
    }
    clearTimeout(storeTimer);
    storeTimer = setTimeout(saveDearrow, STORE_MS) as unknown as number;
}

/** Writes the latest answered branding to the device (also when the app hides or exits) */
export function saveDearrow(): void {
    if (!storeTimer) {
        return;
    }
    clearTimeout(storeTimer);
    storeTimer = 0;
    var all = knownBranding();
    var list: Stored[] = [];
    for (var i = order.length - 1; i >= 0 && list.length < STORED; i--) {
        var b = all[order[i]];
        if (b) {
            list.push([order[i], b.title, b.frame, b.random, b.day || day(), b.casual]);
        }
    }
    save(STORE_KEY, list.reverse());
}

/** A length as "1:02:03" in seconds (0: none) */
function seconds(length: string): number {
    return /^\d+(:\d\d)+$/.test(length) ? length.split(':').reduce(function (s, part) { return s * 60 + +part; }, 0) : 0;
}
