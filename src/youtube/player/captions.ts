// YouTube subtitles shown as YouTube's players show them. Auto-generated
// cues (and their translations) hold two lines, the previous one above the
// current one, with a time before each word (<00:00:03.151>). Shown whole at
// the cue start, a line would appear up to 3 s before it is spoken, so words
// appear at their times. Uploaded subtitles have no word times and are shown
// as they are. Settings › Subtitle style: word by word, or two lines at a time.
//
// Parsing runs on the main thread after playback starts. An hour of words
// (~8,000 cues, 370 KB) takes ~335 ms on the TV even in one pass, so it is
// read in slices with a pause between them, leaving room for appends and frames.

import { getText } from '../core/http.js';
import { tr } from '../core/i18n.js';
import { cleanText, Cue, parseVtt, pieceAt, SubtitleTrack } from './subtitles.js';
import { prefs } from '../api/prefs.js';
import { note } from './play-log.js';

/** A word time in a cue's text (captured, so split keeps it) */
var WORD_TIME = /<((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})>/;
var TIMING = /^\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})/;
var TAGS = /<[^>]*>/g;
/** Delay before retrying subtitles that failed to load (once) */
var AGAIN_MS = 2000;
/** After YouTube refuses a translation (429, "automated queries"), translations are not requested for this long:
 * the block covers all of them for hours, and each request prolongs it */
var REFUSED_MS = 60 * 60 * 1000;
var refusedAt = 0;
/** Gaps between cues shorter than this keep the previous cue shown (YouTube's 10 ms cues between lines) */
var GAP_S = 0.1;
/** Lines parsed per slice (~25 ms on the TV) */
var SLICE_LINES = 600;
/** Two lines with a pause this long between them are not paired (the second would show long before it is said) */
var PAIR_GAP_S = 1;

/** Subtitle style options (Settings and player): value, name and description */
export var CAPTION_STYLES = [
    { value: 'words', name: tr('Word by word'), note: tr('Each word comes as it is said, as on YouTube') },
    { value: 'lines', name: tr('Two lines at a time'), note: tr('Two lines show, then the next two take their place, as normal subtitles') }
];

/** The text shown at a time (null: none); styled: auto-generated, in a Subtitle style; stop: stop parsing */
export interface Captions {
    textAt(t: number): string | null;
    styled?: boolean;
    stop?(): void;
}

/** Turns cues with word times into display cues: called per cue (times and raw text), then at the end */
interface Reader {
    cue(start: number, end: number, text: string, cues: Cue[]): void;
    end(cues: Cue[]): void;
}

/** Whether YouTube refused translations recently (the player then shows the source track instead) */
export function translationsRefused(): boolean {
    return Date.now() - refusedAt < REFUSED_MS;
}

/** Load the subtitles at url in the set style, if still() says they are still wanted (else null). Retries once on
 * failure; a translation (translated) is not asked for while YouTube refuses them, and a refusal rejects at once. */
export function loadCaptions(url: string, still: () => boolean, translated: boolean): Promise<Captions | null> {
    if (translated && translationsRefused()) {
        return Promise.reject({ status: 429 });
    }
    return getText(url).then(null, function (e) {
        // Retry once: translated subtitles sometimes fail once and then load (the reason goes to the play log)
        note('subtitles failed', String(e && (e.message || e.status) || e));
        if (refusal(e, translated)) {
            throw e;
        }
        return new Promise<string>(function (resolve, reject) {
            setTimeout(function () {
                if (still()) {
                    getText(url).then(resolve, function (again) {
                        refusal(again, translated);
                        reject(again);
                    });
                } else {
                    resolve('');
                }
            }, AGAIN_MS);
        });
    }).then(function (vtt) { return still() ? captionsOf(vtt, prefs().captionStyle) : null; });
}

/** Whether e is YouTube refusing a translation (429); if so, none is asked for REFUSED_MS (also after a retry) */
function refusal(e: any, translated: boolean): boolean {
    var refused = !!e && e.status === 429 && translated;
    if (refused) {
        refusedAt = Date.now();
    }
    return refused;
}

/** YouTube's WebVTT as a track: with word times, word by word ('words') or two lines at a time ('lines'); without
 * word times, as it is */
export function captionsOf(vtt: string, style: string): Captions {
    if (!WORD_TIME.test(vtt)) {
        return new SubtitleTrack(parseVtt(vtt));
    }
    return new SpeechTrack(vtt.split(/\r\n|\r|\n/), style === 'lines' ? new TwoLines() : new WordByWord());
}

/** Pass the cue whose timing line is lines[i] (if it is one) to reader; returns the index of the next line */
function readCue(lines: string[], i: number, reader: Reader, cues: Cue[]): number {
    var m = lines[i].indexOf('-->') >= 0 ? TIMING.exec(lines[i]) : null;
    i++;
    if (!m) {
        return i;
    }
    // Up to an empty line (a line of spaces is a blank "previous line", as in YouTube's first cue)
    var text: string[] = [];
    while (i < lines.length && lines[i] !== '' && lines[i].indexOf('-->') < 0) {
        text.push(lines[i++]);
    }
    reader.cue(seconds(m[1]), seconds(m[2]), text.join('\n'), cues);
    return i;
}

/** Entities or line breaks: a line that needs the full cleaning (one RegExp for all words: in ES5 a literal is a new
 * one each time) */
var NEEDS_CLEANING = /[&\n]/;

/** Word by word: one cue per word time with the words so far (the line above is cleaned once, the current line's
 * words as they come) */
class WordByWord implements Reader {
    cue(start: number, end: number, text: string, cues: Cue[]): void {
        // [text, time, text, time, text …]
        var parts = text.split(WORD_TIME);
        var head = parts[0];
        var nl = head.lastIndexOf('\n');
        var above = nl >= 0 ? cleanText(head.slice(0, nl)) : '';
        var line = head.slice(nl + 1).replace(TAGS, '');
        var from = start;
        for (var k = 1; k < parts.length; k += 2) {
            var at = Math.min(end, seconds(parts[k]));
            if (at > from) {
                add(cues, from, at, above, line);
                from = at;
            }
            line += parts[k + 1].replace(TAGS, '');
        }
        add(cues, from, end, above, line);
    }

    end(): void {
        return undefined;
    }
}

function add(cues: Cue[], start: number, end: number, above: string, line: string): void {
    // Entities or multiple lines need the full cleaning
    var said = NEEDS_CLEANING.test(line) ? cleanText(line) : line.trim();
    var text = above && said ? above + '\n' + said : above || said;
    if (end > start && text) {
        cues.push({ start: start, end: end, text: text });
    }
}

/** Two lines at a time: each cue's current line, whole, paired with the next one (from the first's start to the
 * second's end) unless a pause separates them */
class TwoLines implements Reader {
    /** A line waiting for its pair */
    private first: Cue | null = null;
    /** The last line taken and its end time */
    private said = '';
    private saidEnd = -1;

    cue(start: number, end: number, text: string, cues: Cue[]): void {
        var said = cleanText(text.slice(text.lastIndexOf('\n') + 1)) || cleanText(text).split('\n').pop() || '';
        // YouTube's short cue between two lines repeats the previous line: skip it (a later repeat is a new line)
        if (!said || said === this.said && start - this.saidEnd < GAP_S) {
            return;
        }
        this.said = said;
        this.saidEnd = end;
        var first = this.first;
        if (first && start - first.end < PAIR_GAP_S) {
            cues.push({ start: first.start, end: end, text: first.text + '\n' + said });
            this.first = null;
        } else {
            this.end(cues);
            this.first = { start: start, end: end, text: said };
        }
    }

    /** Flush an unpaired line (followed by a pause, or the last) */
    end(cues: Cue[]): void {
        if (this.first) {
            cues.push(this.first);
            this.first = null;
        }
    }
}

/** Auto-generated cues, built by reader as they are parsed (SLICE_LINES at a time) into pieces: piece k shows
 * texts[k] from starts[k] until starts[k + 1], nothing from end on (cues are in order, so one pass) */
class SpeechTrack implements Captions {
    styled = true;
    private starts: number[] = [];
    private texts: (string | null)[] = [];
    /** Piece of the previous lookup: playback asks for nearby times */
    private last = 0;
    /** End of the last cue added (-1: none yet); nothing shows after it (not parsed yet, or the end) */
    private end = -1;
    private stopped = false;

    constructor(lines: string[], private reader: Reader) {
        this.read(lines, 0);
    }

    textAt(t: number): string | null {
        var starts = this.starts;
        // (NaN before metadata)
        if (!starts.length || !(t >= starts[0]) || t >= this.end) {
            return null;
        }
        this.last = pieceAt(starts, this.last, t);
        return this.texts[this.last];
    }

    /** Stop parsing (other subtitles, another style, or the player closed) */
    stop(): void {
        this.stopped = true;
    }

    /** Parse SLICE_LINES lines from at, the rest after a timeout */
    private read(lines: string[], at: number): void {
        if (this.stopped) {
            return;
        }
        var cues: Cue[] = [];
        var stop = Math.min(lines.length, at + SLICE_LINES);
        while (at < stop) {
            at = readCue(lines, at, this.reader, cues);
        }
        if (at >= lines.length) {
            this.reader.end(cues);
        }
        for (var i = 0; i < cues.length; i++) {
            this.add(cues[i]);
        }
        if (at < lines.length) {
            var self = this;
            setTimeout(function () { self.read(lines, at); }, 0);
        }
    }

    private add(c: Cue): void {
        // A cue overlapping the previous one starts at its end (YouTube's never overlap)
        var start = Math.max(c.start, this.end);
        if (c.end <= start) {
            return;
        }
        // Nothing shows in a gap
        if (this.end >= 0 && start > this.end + GAP_S) {
            this.lay(this.end, null);
        }
        this.lay(start, c.text);
        this.end = c.end;
    }

    /** Add a piece from start (the same text as the previous piece extends it) */
    private lay(start: number, text: string | null): void {
        var n = this.texts.length;
        if (n && this.texts[n - 1] === text) {
            return;
        }
        this.starts.push(start);
        this.texts.push(text);
    }
}

/** Seconds of "hh:mm:ss.mmm" or "mm:ss.mmm" (minutes from the digits and one parseFloat, as splitting each time
 * would dominate the parsing cost) */
function seconds(time: string): number {
    var at = time.lastIndexOf(':');
    var whole = 0;
    var n = 0;
    for (var i = 0; i < at; i++) {
        var c = time.charCodeAt(i);
        if (c === 58) {
            whole = (whole + n) * 60;
            n = 0;
        } else {
            n = n * 10 + c - 48;
        }
    }
    var sec = time.slice(at + 1);
    return (whole + n) * 60 + parseFloat(time.indexOf(',') < 0 ? sec : sec.replace(',', '.'));
}
