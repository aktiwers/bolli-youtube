// SponsorBlock: segments viewers have marked in a video (sponsor, intro,
// subscribe reminder, ...), skipped as YouTube AdFree (webosbrew/youtube-webos)
// does. Segments are requested by the first 4 hex digits of the video id's
// SHA-256, so the service never learns which video plays; the reply lists
// every video with that prefix. Only the categories enabled in Settings are
// asked for (PARTS). Without segments or a reply, the video plays as is.

import { getJson } from '../core/http.js';
import { tr } from '../core/i18n.js';
import { oldEngine } from '../core/platform.js';
import { Keeper } from './kept-pages.js';
import { digest } from './sha256.js';

var API = 'https://sponsorblock.inf.re/api/skipSegments/';
/** SponsorBlock's own server, for webOS TV 2.x's engine: the one above has a certificate from a root that TV does not
 * know (the handshake fails) */
var OWN_API = 'https://sponsor.ajay.app/api/skipSegments/';
var TIMEOUT_MS = 8000;
/** No skip in the last part of a segment (a seek to its very end may land back inside it) */
var END_MARGIN_S = 0.5;

/** A skippable category: service id, setting name, description, toast wording when skipped */
export interface PartKind {
    id: string;
    name: string;
    note: string;
    skipped: string;
    /** Shown after the time while the playhead is in one */
    label: string;
}

/** Skippable categories, in Settings order */
export var PARTS: PartKind[] = [
    { id: 'sponsor', name: tr('Sponsors'), note: tr('paid promotions'), skipped: tr('Skipped the sponsor'), label: tr('Sponsor') },
    { id: 'selfpromo', name: tr('Self-promotion'), note: tr('the channel\'s own merchandise, memberships and other channels'), skipped: tr('Skipped self-promotion'), label: tr('Self-promotion') },
    { id: 'interaction', name: tr('Reminders to subscribe'), note: tr('asking you to like, subscribe or follow'), skipped: tr('Skipped a reminder to subscribe'), label: tr('Reminder to subscribe') },
    { id: 'intro', name: tr('Intros'), note: tr('intro animations and pauses'), skipped: tr('Skipped the intro'), label: tr('Intro') },
    { id: 'outro', name: tr('End cards'), note: tr('credits and end screens'), skipped: tr('Skipped the end cards'), label: tr('End cards') },
    { id: 'preview', name: tr('Previews and recaps'), note: tr('what comes later, or what came before'), skipped: tr('Skipped the preview'), label: tr('Preview') },
    { id: 'hook', name: tr('Hooks and greetings'), note: tr('teasers of what comes later in the video, greetings and goodbyes'), skipped: tr('Skipped a hook or greeting'), label: tr('Hook') },
    { id: 'filler', name: tr('Tangents'), note: tr('filler and jokes off the topic'), skipped: tr('Skipped a tangent'), label: tr('Tangent') },
    { id: 'music_offtopic', name: tr('Parts without music'), note: tr('in music videos'), skipped: tr('Skipped a part without music'), label: tr('No music') }
];

export interface Segment {
    category: string;
    start: number;
    end: number;
}

interface Reply {
    videoID?: string;
    segments?: { category?: string; actionType?: string; segment?: number[] }[];
}

/** Segments of video id in the given categories, in order ([] if none or no reply) */
export function segments(id: string, kinds: string[]): Promise<Segment[]> {
    if (!kinds.length) {
        return Promise.resolve([]);
    }
    // Cached (prefetched for a focused tile or the next video); a failure gives [] and is retried next time
    return asked.get(id + ' ' + kinds.join(','), function () { return ask(id, kinds); }).then(null, function () {
        return [] as Segment[];
    });
}

/** Recently fetched segments (shared, never mutated) */
var asked = new Keeper<Segment[]>(10 * 60 * 1000, 6, false, false);

function ask(id: string, kinds: string[]): Promise<Segment[]> {
    // Hash inside the chain: if WebCrypto throws, it counts as no reply instead of breaking playback start
    return Promise.resolve(id).then(sha256Hex).then(function (hex) {
        return getJson<Reply[]>((oldEngine() ? OWN_API : API) + hex.slice(0, 4) + '?categories=' + encodeURIComponent(JSON.stringify(kinds)), TIMEOUT_MS);
    }).then(function (videos) {
        return segmentsOf(videos, id);
    });
}

/** The skip segments of video id in the service's reply, in order */
function segmentsOf(videos: Reply[] | null, id: string): Segment[] {
    var video = (videos || []).filter(function (v) { return !!v && v.videoID === id; })[0];
    var out: Segment[] = [];
    ((video && video.segments) || []).forEach(function (s) {
        var at = s.segment || [];
        if ((s.actionType || 'skip') === 'skip' && s.category && at.length === 2 && at[1] > at[0]) {
            out.push({ category: s.category, start: at[0], end: at[1] });
        }
    });
    out.sort(function (a, b) { return a.start - b.start; });
    return out;
}

/** Index of the not yet skipped segment containing time t, or -1 */
export function segmentAt(list: Segment[], t: number, skipped: { [index: number]: boolean }): number {
    for (var i = 0; i < list.length; i++) {
        if (!skipped[i] && t >= list[i].start && t < list[i].end - END_MARGIN_S) {
            return i;
        }
    }
    return -1;
}

/** A segment's category as Settings lists it (undefined: one not listed) */
function kindOf(s: Segment): PartKind | undefined {
    return PARTS.filter(function (k) { return k.id === s.category; })[0];
}

/** A segment's name as shown after the time ("Sponsor") */
export function segmentName(s: Segment): string {
    var kind = kindOf(s);
    return kind ? kind.label : s.category;
}

/** "Skipped the sponsor" */
export function skippedText(s: Segment): string {
    var kind = kindOf(s);
    return kind ? kind.skipped : tr('Skipped {1}', s.category);
}

/** SHA-256 of ASCII text (a video id), in hex */
function sha256Hex(text: string): Promise<string> {
    var bytes = new Uint8Array(text.length);
    for (var i = 0; i < text.length; i++) {
        bytes[i] = text.charCodeAt(i) & 0xff;
    }
    return digest(bytes).then(function (b) {
        var hex = '';
        for (var k = 0; k < b.length; k++) {
            hex += (b[k] < 16 ? '0' : '') + b[k].toString(16);
        }
        return hex;
    });
}
