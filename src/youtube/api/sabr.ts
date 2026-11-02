// The subset of YouTube's SABR (server ABR) protocol used by player/sabr-engine.ts. A request is a
// VideoPlaybackAbrRequest (protocol buffers) POSTed to the streaming URL from the signed-in TV client's /player
// reply. The reply is UMP: a sequence of parts (type and size in UMP's variable-length numbers), among them the
// requested formats' segments (header, media pieces, end), the next request's policy (backoff, playback cookie),
// the stream protection status, a redirect or an error. Field numbers follow LuanRT's googlevideo library
// (protos/video_streaming). No PO token is sent; the signed-in TV client plays without one.

/** A format id as SABR uses it: itag, last modified time (lmt) and xtags (dub language, stable volume) */
export interface FormatId {
    itag: number;
    lmt: string;
    xtags?: string;
}

/** A format's buffered range: first and last segment, and their time span (ms) */
export interface BufferedRange {
    format: FormatId;
    startMs: number;
    durationMs: number;
    firstSegment: number;
    lastSegment: number;
}

/** The TV client info sent in requests */
export interface SabrClient {
    version: string;
    osName: string;
    osVersion: string;
    make: string;
    model: string;
    hl: string;
}

export interface SabrAsk {
    /** Playhead position (or seek target) */
    playerMs: number;
    /** Which tracks the reply carries: 0 both, 1 audio only, 2 video only */
    tracks: number;
    video: FormatId;
    audio: FormatId;
    /** The video height (keeps the resolution) */
    height: number;
    /** Dub id ('' the original audio), and stable volume */
    audioTrack: string;
    drc: boolean;
    /** Formats whose init segment has already arrived */
    initialized: FormatId[];
    buffered: BufferedRange[];
    /** videoPlaybackUstreamerConfig of the /player reply */
    config: Uint8Array;
    client: SabrClient;
    /** The last reply's cookie (null: none yet) */
    cookie: Uint8Array | null;
    /** Contexts the server asked to be sent back (type, value), and known context types not sent */
    contexts: { type: number; value: Uint8Array }[];
    unsent: number[];
}

/** A segment of a format: the init segment, or media segment num from startMs */
export interface SabrSegment {
    itag: number;
    init: boolean;
    num: number;
    startMs: number;
    durationMs: number;
    data: Uint8Array;
}

export interface SabrAnswer {
    segments: SabrSegment[];
    /** The last segment of each format (by itag), and its end (ms) */
    ends: { [itag: number]: { segment: number; endMs: number } };
    /** Wait this long before the next request; the cookie to send back (null: keep the last) */
    backoffMs: number;
    cookie: Uint8Array | null;
    /** Stream protection status (0 not given, 1 ok, 2 pending, 3 refused) and its retries */
    protection: number;
    retries: number;
    /** URL to use from now on ('' no change) */
    redirect: string;
    /** YouTube's error ('' none) */
    error: string;
    /** The /player reply must be fetched again */
    reload: boolean;
    /** Contexts to keep (and send when asked), and which types to start sending, stop sending, or discard */
    contexts: { type: number; value: Uint8Array; byDefault: boolean }[];
    start: number[];
    stop: number[];
    discard: number[];
}

/** Protocol buffers writer: appends fields to a byte list */
export class Writer {
    bytes: number[] = [];

    varint(field: number, n: number): Writer {
        this.number(field * 8);
        this.number(n);
        return this;
    }

    data(field: number, data: number[] | Uint8Array): Writer {
        this.number(field * 8 + 2);
        this.number(data.length);
        for (var i = 0; i < data.length; i++) {
            this.bytes.push(data[i]);
        }
        return this;
    }

    string(field: number, s: string): Writer {
        var utf8 = unescape(encodeURIComponent(s));
        var data: number[] = [];
        for (var i = 0; i < utf8.length; i++) {
            data.push(utf8.charCodeAt(i));
        }
        return this.data(field, data);
    }

    message(field: number, m: Writer): Writer {
        return this.data(field, m.bytes);
    }

    /** A varint (integers up to 2^53: an lmt is ~2^51, beyond bitwise ops) */
    private number(n: number): void {
        while (n >= 128) {
            this.bytes.push(n % 128 + 128);
            n = Math.floor(n / 128);
        }
        this.bytes.push(n);
    }
}

/** Protocol buffers reader: each field's values (varints as numbers, length-delimited as bytes) */
export function fields(p: Uint8Array): { [field: number]: (number | Uint8Array)[] } {
    var out: { [field: number]: (number | Uint8Array)[] } = {};
    var i = 0;
    var varint = function (): number {
        var n = 0;
        var scale = 1;
        var c: number;
        do {
            c = p[i++];
            n += (c & 127) * scale;
            scale *= 128;
        } while (c & 128 && i < p.length);
        return n;
    };
    while (i < p.length) {
        var key = varint();
        var field = Math.floor(key / 8);
        var type = key % 8;
        var value: number | Uint8Array;
        if (type === 0) {
            value = varint();
        } else if (type === 2) {
            var length = varint();
            value = p.subarray(i, i + length);
            i += length;
        } else if (type === 1) {
            i += 8;
            continue;
        } else if (type === 5) {
            i += 4;
            continue;
        } else {
            break;
        }
        (out[field] = out[field] || []).push(value);
    }
    return out;
}

function num(f: { [field: number]: (number | Uint8Array)[] }, field: number): number {
    var v = f[field];
    return v && typeof v[0] === 'number' ? v[0] as number : 0;
}

function bytes(f: { [field: number]: (number | Uint8Array)[] }, field: number): Uint8Array | null {
    var v = f[field];
    return v && typeof v[0] !== 'number' ? v[0] as Uint8Array : null;
}

/** A copy of bytes kept beyond the reply (a view would retain the whole reply) */
function copy(data: Uint8Array | null): Uint8Array | null {
    return data ? new Uint8Array(data) : null;
}

/** A repeated number field, packed or not */
function ints(f: { [field: number]: (number | Uint8Array)[] }, field: number): number[] {
    var out: number[] = [];
    (f[field] || []).forEach(function (v) {
        if (typeof v === 'number') {
            out.push(v);
            return;
        }
        var i = 0;
        while (i < v.length) {
            var n = 0;
            var scale = 1;
            var c: number;
            do {
                c = v[i++];
                n += (c & 127) * scale;
                scale *= 128;
            } while (c & 128 && i < v.length);
            out.push(n);
        }
    });
    return out;
}

function text(data: Uint8Array | null): string {
    var s = '';
    for (var i = 0; data && i < data.length; i++) {
        s += String.fromCharCode(data[i]);
    }
    try {
        return decodeURIComponent(escape(s));
    } catch (e) {
        return s;
    }
}

/** Decodes base64 (or base64url) to bytes */
export function base64Bytes(s: string): Uint8Array {
    s = s.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
    while (s.length % 4) {
        s += '=';
    }
    var bin = atob(s);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) {
        out[i] = bin.charCodeAt(i);
    }
    return out;
}

function formatId(id: FormatId): Writer {
    var w = new Writer().varint(1, id.itag).varint(2, +id.lmt || 0);
    return id.xtags ? w.string(3, id.xtags) : w;
}

/** Encodes the request */
export function sabrRequest(ask: SabrAsk): Uint8Array {
    var abr = new Writer()
        .varint(16, ask.height)
        .varint(21, ask.height)
        .varint(28, Math.max(0, Math.round(ask.playerMs)))
        .varint(29, 0)
        .varint(34, 2)
        .varint(36, 0)
        .varint(39, 0)
        .varint(40, ask.tracks)
        .varint(46, ask.drc ? 1 : 0)
        .varint(71, 1)
        .varint(85, 0);
    if (ask.audioTrack) {
        abr.string(69, ask.audioTrack);
    }
    var c = ask.client;
    var info = new Writer().string(1, c.hl).string(12, c.make).string(13, c.model).varint(16, 7).string(17, c.version)
        .string(18, c.osName).string(19, c.osVersion);
    var streamer = new Writer().message(1, info);
    if (ask.cookie) {
        streamer.data(3, ask.cookie);
    }
    ask.contexts.forEach(function (ctx) {
        streamer.message(5, new Writer().varint(1, ctx.type).data(2, ctx.value));
    });
    ask.unsent.forEach(function (type) {
        streamer.varint(6, type);
    });
    var req = new Writer().message(1, abr);
    ask.initialized.forEach(function (id) {
        req.message(2, formatId(id));
    });
    ask.buffered.forEach(function (b) {
        req.message(3, new Writer().message(1, formatId(b.format)).varint(2, b.startMs).varint(3, b.durationMs)
            .varint(4, b.firstSegment).varint(5, b.lastSegment)
            .message(6, new Writer().varint(1, b.startMs).varint(2, b.durationMs).varint(3, 1000)));
    });
    req.data(5, ask.config).message(16, formatId(ask.audio)).message(17, formatId(ask.video)).message(19, streamer);
    return new Uint8Array(req.bytes);
}

/** The complete UMP parts in b: type and data (a view into b); ended receives the end of the last complete part */
export function umpParts(b: Uint8Array, ended?: (end: number) => void): { type: number; data: Uint8Array }[] {
    var parts: { type: number; data: Uint8Array }[] = [];
    var o = 0;
    var whole = 0;
    var number = function (): number {
        var first = b[o];
        var n = first < 128 ? 1 : first < 192 ? 2 : first < 224 ? 3 : first < 240 ? 4 : 5;
        var v: number;
        if (n === 1) {
            v = first;
        } else if (n === 2) {
            v = (first & 0x3f) + b[o + 1] * 64;
        } else if (n === 3) {
            v = (first & 0x1f) + b[o + 1] * 32 + b[o + 2] * 8192;
        } else if (n === 4) {
            v = (first & 0x0f) + b[o + 1] * 16 + b[o + 2] * 4096 + b[o + 3] * 1048576;
        } else {
            v = b[o + 1] + b[o + 2] * 256 + b[o + 3] * 65536 + b[o + 4] * 16777216;
        }
        o += n;
        return v;
    };
    while (o < b.length) {
        var first = b[o];
        // The part's type and size are not complete yet
        if (o + numberLength(first) > b.length) {
            break;
        }
        var type = number();
        if (o >= b.length || o + numberLength(b[o]) > b.length) {
            break;
        }
        var size = number();
        if (o + size > b.length) {
            break;
        }
        parts.push({ type: type, data: b.subarray(o, o + size) });
        o += size;
        whole = o;
    }
    if (ended) {
        ended(whole);
    }
    return parts;
}

function numberLength(first: number): number {
    return first < 128 ? 1 : first < 192 ? 2 : first < 224 ? 3 : first < 240 ? 4 : 5;
}

/** Part types (googlevideo's UMPPartId) */
var MEDIA_HEADER = 20;
var MEDIA = 21;
var MEDIA_END = 22;
var NEXT_REQUEST_POLICY = 35;
var FORMAT_INITIALIZATION_METADATA = 42;
var SABR_REDIRECT = 43;
var SABR_ERROR = 44;
var RELOAD_PLAYER_RESPONSE = 46;
var SABR_CONTEXT_UPDATE = 57;
var STREAM_PROTECTION_STATUS = 58;
var SABR_CONTEXT_SENDING_POLICY = 59;

/** Reads a reply as it streams in (pieces pushed in order): reports each segment's header on arrival (onHeader, no
 * data yet) and the segment once complete (onSegment); everything else is collected in answer */
export class SabrReader {
    answer: SabrAnswer = {
        segments: [], ends: {}, backoffMs: 0, cookie: null, protection: 0, retries: 0, redirect: '', error: '', reload: false,
        contexts: [], start: [], stop: [], discard: []
    };
    /** Bytes received but not yet read (an incomplete part), and their count */
    private chunks: Uint8Array[] = [];
    private size = 0;
    private open: { [id: number]: { segment: SabrSegment; pieces: Uint8Array[]; size: number } } = {};

    constructor(private onSegment?: (s: SabrSegment) => void, private onHeader?: (s: SabrSegment) => void) {}

    /** Adds more of the reply; each part is read once complete (its bytes copied once, into their own array) */
    push(b: Uint8Array): void {
        if (b.length) {
            this.chunks.push(b);
            this.size += b.length;
        }
        for (;;) {
            var head = this.peek(10);
            var at = 0;
            var read = function (): number {
                var first = head[at];
                var n = numberLength(first);
                var v = n === 1 ? first : n === 2 ? (first & 0x3f) + head[at + 1] * 64 : n === 3 ? (first & 0x1f) + head[at + 1] * 32 + head[at + 2] * 8192 :
                    n === 4 ? (first & 0x0f) + head[at + 1] * 16 + head[at + 2] * 4096 + head[at + 3] * 1048576 :
                    head[at + 1] + head[at + 2] * 256 + head[at + 3] * 65536 + head[at + 4] * 16777216;
                at += n;
                return v;
            };
            if (!head.length || numberLength(head[0]) >= head.length) {
                return;
            }
            var type = read();
            if (at >= head.length || at + numberLength(head[at]) > head.length) {
                return;
            }
            var length = read();
            if (this.size < at + length) {
                return;
            }
            this.take(at);
            this.part(type, this.take(length));
        }
    }

    /** The first n bytes (fewer if fewer arrived), without consuming them */
    private peek(n: number): Uint8Array {
        var out = new Uint8Array(Math.min(n, this.size));
        var at = 0;
        for (var i = 0; i < this.chunks.length && at < out.length; i++) {
            var c = this.chunks[i].subarray(0, out.length - at);
            out.set(c, at);
            at += c.length;
        }
        return out;
    }

    /** Consumes the first n bytes (into their own array) */
    private take(n: number): Uint8Array {
        var out = new Uint8Array(n);
        var at = 0;
        while (at < n) {
            var c = this.chunks[0];
            var used = Math.min(c.length, n - at);
            out.set(c.subarray(0, used), at);
            at += used;
            if (used === c.length) {
                this.chunks.shift();
            } else {
                this.chunks[0] = c.subarray(used);
            }
        }
        this.size -= n;
        return out;
    }

    private part(type: number, data: Uint8Array): void {
        var a = this.answer;
        var f: { [field: number]: (number | Uint8Array)[] };
        switch (type) {
            case MEDIA_HEADER:
                f = fields(data);
                var header = { itag: num(f, 3), init: !!num(f, 8), num: num(f, 9), startMs: num(f, 11), durationMs: num(f, 12), data: new Uint8Array(0) };
                this.open[num(f, 1)] = { segment: header, pieces: [], size: 0 };
                if (this.onHeader) {
                    this.onHeader(header);
                }
                break;
            case MEDIA:
                var open = this.open[data[0]];
                if (open) {
                    // A view into the part's own copy (take), so the reply's chunks can be released
                    open.pieces.push(data.subarray(1));
                    open.size += data.length - 1;
                }
                break;
            case MEDIA_END:
                var done = this.open[data[0]];
                if (done) {
                    var whole = new Uint8Array(done.size);
                    var at = 0;
                    done.pieces.forEach(function (p) {
                        whole.set(p, at);
                        at += p.length;
                    });
                    done.segment.data = whole;
                    delete this.open[data[0]];
                    a.segments.push(done.segment);
                    if (this.onSegment) {
                        this.onSegment(done.segment);
                    }
                }
                break;
            case FORMAT_INITIALIZATION_METADATA:
                f = fields(data);
                var format = fields(bytes(f, 2) || new Uint8Array(0));
                a.ends[num(format, 1)] = { segment: num(f, 4), endMs: num(f, 3) };
                break;
            case NEXT_REQUEST_POLICY:
                f = fields(data);
                a.backoffMs = num(f, 4);
                a.cookie = copy(bytes(f, 7));
                break;
            case STREAM_PROTECTION_STATUS:
                f = fields(data);
                a.protection = num(f, 1);
                a.retries = num(f, 2);
                break;
            case SABR_REDIRECT:
                a.redirect = text(bytes(fields(data), 1));
                break;
            case SABR_ERROR:
                f = fields(data);
                a.error = (text(bytes(f, 1)) || 'error') + ' ' + num(f, 2);
                break;
            case RELOAD_PLAYER_RESPONSE:
                a.reload = true;
                break;
            case SABR_CONTEXT_UPDATE:
                f = fields(data);
                a.contexts.push({ type: num(f, 1), value: copy(bytes(f, 3)) || new Uint8Array(0), byDefault: !!num(f, 4) });
                break;
            case SABR_CONTEXT_SENDING_POLICY:
                f = fields(data);
                a.start = ints(f, 1);
                a.stop = ints(f, 2);
                a.discard = ints(f, 3);
                break;
        }
    }
}

/** Reads a complete reply */
export function sabrAnswer(b: Uint8Array): SabrAnswer {
    var reader = new SabrReader();
    reader.push(b);
    return reader.answer;
}
