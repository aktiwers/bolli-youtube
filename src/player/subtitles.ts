// WebVTT subtitles drawn by the app. Streams may come with one .vtt file per
// language next to the HLS stream, and the TV's native HLS player (webOS 3.x)
// cannot show separate subtitle tracks, so the app fetches the file, parses it
// here and draws the text itself in an overlay above the video.

import { h } from '../core/dom.js';
import { getText } from '../core/http.js';

export interface Cue {
    /** Seconds */
    start: number;
    end: number;
    /** Lines joined with '\n', tags removed, entities decoded */
    text: string;
}

var ENTITIES: { [name: string]: string } = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
    nbsp: ' ', lrm: '‎', rlm: '‏'
};

/**
 * Cues of a WebVTT file, sorted by start. Lenient like a browser: any line
 * with "-->" starts a cue, and everything outside cues (header, identifiers,
 * NOTE, STYLE and REGION blocks, junk) is skipped. Bad cues are dropped.
 */
export function parseVtt(text: string): Cue[] {
    var lines = (text || '').replace(/^﻿/, '').split(/\r\n|\r|\n/);
    var cues: Cue[] = [];
    // The "WEBVTT" line may carry text of its own, even an arrow
    var i = lines.length && lines[0].indexOf('WEBVTT') === 0 ? 1 : 0;
    while (i < lines.length) {
        var line = lines[i++];
        if (line.indexOf('-->') < 0) {
            continue;
        }
        var cue = parseTiming(line);
        // Cue text runs to a blank line, or to the next timing line when a blank one is missing
        var textLines: string[] = [];
        while (i < lines.length && !isBlank(lines[i]) && lines[i].indexOf('-->') < 0) {
            var clean = cleanLine(lines[i++]);
            if (clean) {
                textLines.push(clean);
            }
        }
        if (cue && textLines.length) {
            cue.text = textLines.join('\n');
            cues.push(cue);
        }
    }
    return sortByStart(cues);
}

/** Fetch and parse a .vtt file */
export function loadVtt(url: string): Promise<Cue[]> {
    return getText(url).then(parseVtt);
}

/**
 * The text to show at any playback time. The timeline is cut at every cue
 * start and end into pieces with one fixed text each, so overlapping cues
 * cost nothing while playing, and a piece's text is the same string for as
 * long as it lasts.
 */
export class SubtitleTrack {
    /** Piece k shows texts[k] from starts[k] until starts[k + 1]; the last piece is null and open-ended */
    private starts: number[] = [];
    private texts: (string | null)[] = [];
    /** Piece of the previous lookup: playback asks for nearby times */
    private last = 0;

    constructor(cues: Cue[]) {
        var list: Cue[] = [];
        var times: number[] = [];
        for (var i = 0; i < cues.length; i++) {
            var c = cues[i];
            // Same rule as parseVtt, for cues from elsewhere
            if (c.end > c.start) {
                list.push(c);
                times.push(c.start, c.end);
            }
        }
        list = sortByStart(list);
        times.sort(function (a, b) { return a - b; });
        var active: Cue[] = [];
        var next = 0;
        for (var k = 0; k < times.length; k++) {
            var t = times[k];
            if (k > 0 && t === times[k - 1]) {
                continue;
            }
            var still: Cue[] = [];
            for (var a = 0; a < active.length; a++) {
                if (active[a].end > t) {
                    still.push(active[a]);
                }
            }
            active = still;
            while (next < list.length && list[next].start <= t) {
                active.push(list[next++]);
            }
            var text = joinTexts(active);
            // Back-to-back cues with the same text stay one piece: no redraw between them
            if (this.texts.length && this.texts[this.texts.length - 1] === text) {
                continue;
            }
            this.starts.push(t);
            this.texts.push(text);
        }
    }

    /** Text of the cue(s) visible at time t (seconds), or null */
    textAt(t: number): string | null {
        var starts = this.starts;
        var n = starts.length;
        // Also catches NaN, which a video element reports before metadata
        if (!n || !(t >= starts[0])) {
            return null;
        }
        var k = this.last;
        if (!inPiece(starts, k, t)) {
            // Normal playback has moved on by at most one piece: try that before searching
            k = inPiece(starts, k + 1, t) ? k + 1 : findPiece(starts, t);
            this.last = k;
        }
        return this.texts[k];
    }
}

/**
 * Draws subtitle text into the overlay the app provides (an absolutely
 * positioned element above the video; its CSS places and styles the text).
 * Writes to the DOM only when the text changes.
 */
export class SubtitleView {
    private text: HTMLElement;
    /** Text on screen now, null while hidden */
    private shown: string | null = null;
    /** Text in the element, which keeps the last text while hidden */
    private written = '';

    constructor(private container: HTMLElement) {
        // Inline, so a background is drawn per line; pre-line breaks at '\n' and still wraps long lines
        this.text = h('span', 'subtitle-text');
        this.text.style.whiteSpace = 'pre-line';
        container.appendChild(this.text);
        container.style.visibility = 'hidden';
    }

    /** Show text, or hide the overlay for null */
    show(text: string | null): void {
        if (text === this.shown) {
            return;
        }
        if (!text) {
            if (this.shown !== null) {
                this.container.style.visibility = 'hidden';
                this.shown = null;
            }
            return;
        }
        if (text !== this.written) {
            this.text.textContent = text;
            this.written = text;
        }
        if (this.shown === null) {
            this.container.style.visibility = '';
        }
        this.shown = text;
    }
}

/** Cue times only, text still empty; null when the timing line is malformed */
function parseTiming(line: string): Cue | null {
    var arrow = line.indexOf('-->');
    // Cue settings ("line:85% align:center") follow the end time and are ignored
    var after = line.substr(arrow + 3).replace(/^\s+/, '').split(/\s/);
    var start = parseTime(line.substr(0, arrow).trim());
    var end = parseTime(after[0]);
    // A cue that ends before it starts would never be visible
    if (start < 0 || !(end > start)) {
        return null;
    }
    return { start: start, end: end, text: '' };
}

/** Seconds from "hh:mm:ss.mmm" or "mm:ss.mmm" (also "," and fewer digits), or -1 */
function parseTime(s: string): number {
    var m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(s);
    if (!m) {
        return -1;
    }
    var min = parseInt(m[2], 10);
    var sec = parseInt(m[3], 10);
    if (min > 59 || sec > 59) {
        return -1;
    }
    // ".5" is half a second, not 5 ms
    var ms = m[4] ? parseInt((m[4] + '00').substr(0, 3), 10) : 0;
    // Whole milliseconds first, then one division: the nearest double to the written time
    return ((m[1] ? parseInt(m[1], 10) : 0) * 3600000 + min * 60000 + sec * 1000 + ms) / 1000;
}

function isBlank(line: string): boolean {
    return !line || !/\S/.test(line);
}

/** Cue text from elsewhere (a video file's own subtitles) as parseVtt leaves it: each line cleaned, blank ones dropped */
export function cleanText(text: string): string {
    return text.split(/\r\n|\r|\n/).map(cleanLine).filter(function (line) { return !!line; }).join('\n');
}

/** One line of cue text without tags (<i>, <c.yellow>, <v Name>, <00:00:01.000>), entities decoded */
function cleanLine(line: string): string {
    // Trimmed before decoding, so a line of just &nbsp; stays as a (blank) line
    return decodeEntities(line.replace(/<[^>]*>/g, '').trim());
}

function decodeEntities(s: string): string {
    if (s.indexOf('&') < 0) {
        return s;
    }
    // One pass, so "&amp;lt;" becomes "&lt;" and not "<"
    return s.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, function (all: string, name: string) {
        if (name.charAt(0) === '#') {
            var hex = name.charAt(1) === 'x' || name.charAt(1) === 'X';
            return fromCodePoint(parseInt(name.substr(hex ? 2 : 1), hex ? 16 : 10)) || all;
        }
        return Object.prototype.hasOwnProperty.call(ENTITIES, name) ? ENTITIES[name] : all;
    });
}

/** String.fromCodePoint is ES2015; '' for invalid code points */
function fromCodePoint(cp: number): string {
    if (!(cp > 0 && cp <= 0x10ffff)) {
        return '';
    }
    if (cp < 0x10000) {
        return String.fromCharCode(cp);
    }
    cp -= 0x10000;
    return String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
}

/** Sorted by start, cues with equal starts in file order (Chrome 38's sort is not stable) */
function sortByStart(cues: Cue[]): Cue[] {
    var sorted = true;
    for (var i = 1; i < cues.length && sorted; i++) {
        sorted = cues[i].start >= cues[i - 1].start;
    }
    if (sorted) {
        return cues;
    }
    var order: number[] = [];
    for (var k = 0; k < cues.length; k++) {
        order.push(k);
    }
    order.sort(function (a, b) { return cues[a].start - cues[b].start || a - b; });
    return order.map(function (k) { return cues[k]; });
}

function joinTexts(active: Cue[]): string | null {
    if (!active.length) {
        return null;
    }
    if (active.length === 1) {
        return active[0].text;
    }
    var parts: string[] = [];
    for (var i = 0; i < active.length; i++) {
        parts.push(active[i].text);
    }
    return parts.join('\n');
}

/** The piece t falls in (starts[0] <= t), from the last one looked up: normal playback has moved on by at most one
 * piece, tried before searching (YouTube's captions) */
export function pieceAt(starts: number[], last: number, t: number): number {
    return inPiece(starts, last, t) ? last : inPiece(starts, last + 1, t) ? last + 1 : findPiece(starts, t);
}

/** Whether t falls in piece k */
function inPiece(starts: number[], k: number, t: number): boolean {
    return k < starts.length && starts[k] <= t && (k + 1 === starts.length || t < starts[k + 1]);
}

/** The last piece starting at or before t (starts[0] <= t) */
function findPiece(starts: number[], t: number): number {
    var lo = 0;
    var hi = starts.length - 1;
    while (lo < hi) {
        var mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= t) {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    return lo;
}
