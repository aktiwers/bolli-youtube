// The media containers the engines read: an MP4's segment index (sidx) and
// boxes, a WebM's cues and start (EBML), and a live segment's start time.
// Pure functions of the bytes (tested in tests/youtube-streams and -live).

/** A segment: its times (s) and its bytes (inclusive) */
export interface Segment {
    start: number;
    end: number;
    from: number;
    to: number;
}

/** The segments of an MP4 file, from its first bytes (up to the end of its sidx box); [] without one */
export function parseSidx(data: ArrayBuffer): Segment[] {
    var view = new DataView(data);
    var box = findBox(view, 0, data.byteLength, 'sidx');
    return box ? sidxSegments(view, box.at, box.size) : [];
}

/** The MP4 box of this type among the boxes from from to to: its offset and size (null: none) */
function findBox(view: DataView, from: number, to: number, type: string): { at: number; size: number } | null {
    var at = from;
    while (at + 8 <= to) {
        var size = view.getUint32(at);
        if (size === 1 && at + 16 <= to) {
            size = u64(view, at + 8);
        }
        if (size < 8) {
            return null;
        }
        if (boxType(view, at) === type) {
            return { at: at, size: size };
        }
        at += size;
    }
    return null;
}

function u64(view: DataView, at: number): number {
    return view.getUint32(at) * 4294967296 + view.getUint32(at + 4);
}

function sidxSegments(view: DataView, box: number, size: number): Segment[] {
    var p = box + 8;
    var version = view.getUint8(p);
    p += 8;
    var timescale = view.getUint32(p);
    p += 4;
    var time = version ? u64(view, p) : view.getUint32(p);
    var first = version ? u64(view, p + 8) : view.getUint32(p + 4);
    p += version ? 16 : 8;
    var count = view.getUint16(p + 2);
    p += 4;
    // Offsets count from the first byte after the box
    var offset = box + size + first;
    var segments: Segment[] = [];
    for (var i = 0; i < count && p + 12 <= view.byteLength; i++, p += 12) {
        var bytes = view.getUint32(p) & 0x7fffffff;
        var duration = view.getUint32(p + 4);
        segments.push({ start: time / timescale, end: (time + duration) / timescale, from: offset, to: offset + bytes - 1 });
        offset += bytes;
        time += duration;
    }
    return segments;
}

/** An EBML number at at: its value and its length; an id keeps its marker bit. Null past the data. */
function vint(view: DataView, at: number, id: boolean): { value: number; length: number } | null {
    if (at >= view.byteLength) {
        return null;
    }
    var first = view.getUint8(at);
    var length = 1;
    var mask = 0x80;
    while (length <= 8 && !(first & mask)) {
        length++;
        mask >>= 1;
    }
    if (length > 8 || at + length > view.byteLength) {
        return null;
    }
    var value = id ? first : first & (mask - 1);
    var all = value === mask - 1;
    for (var i = 1; i < length; i++) {
        var b = view.getUint8(at + i);
        all = all && b === 0xff;
        value = value * 256 + b;
    }
    // All ones: unknown size (a Segment written while streaming)
    return { value: !id && all ? Infinity : value, length: length };
}

function uint(view: DataView, at: number, size: number): number {
    var value = 0;
    for (var i = 0; i < size; i++) {
        value = value * 256 + view.getUint8(at + i);
    }
    return value;
}

/** A WebM file's start (s): its first Cluster's Timecode by the TimecodeScale of its Info (a live segment, which
 * carries its own header); NaN if not found */
function webmStart(data: ArrayBuffer): number {
    var view = new DataView(data);
    var SEGMENT = 0x18538067, INFO = 0x1549A966, SCALE = 0x2AD7B1, CLUSTER = 0x1F43B675, TIMECODE = 0xE7;
    var scale = 1000000;
    var at = 0;
    while (at < data.byteLength) {
        var id = vint(view, at, true);
        var size = id ? vint(view, at + id.length, false) : null;
        if (!id || !size) {
            return NaN;
        }
        var start = at + id.length + size.length;
        // Into these: their children follow
        if (id.value === SEGMENT || id.value === INFO || id.value === CLUSTER) {
            at = start;
            continue;
        }
        if (id.value === SCALE) {
            scale = uint(view, start, size.value);
        } else if (id.value === TIMECODE) {
            return uint(view, start, size.value) * scale / 1e9;
        }
        if (size.value === Infinity) {
            return NaN;
        }
        at = start + size.value;
    }
    return NaN;
}

/** The segments (clusters, from the Cues) of a WebM file, from its first bytes up to the end of the Cues;
 * length: the file size (end of the last cluster), duration (s): end time of the last one */
export function parseCues(data: ArrayBuffer, length: number, duration: number): Segment[] {
    var view = new DataView(data);
    var SEGMENT = 0x18538067, INFO = 0x1549A966, SCALE = 0x2AD7B1, CUES = 0x1C53BB6B, POINT = 0xBB, TIME = 0xB3,
        POSITIONS = 0xB7, CLUSTER = 0xF1;
    var scale = 1000000;
    var segmentStart = -1;
    var cues: { time: number; pos: number }[] = [];
    var at = 0;
    var end = data.byteLength;
    while (at < end) {
        var id = vint(view, at, true);
        var size = id ? vint(view, at + id.length, false) : null;
        if (!id || !size) {
            break;
        }
        var start = at + id.length + size.length;
        if (id.value === SEGMENT) {
            // Descend into the Segment: its children follow
            segmentStart = start;
            at = start;
            continue;
        }
        if (id.value === INFO || id.value === CUES || id.value === POINT || id.value === POSITIONS) {
            // Descend into these too; their children are read in turn
            if (id.value === POINT) {
                cues.push({ time: 0, pos: -1 });
            }
            at = start;
            continue;
        }
        if (start + size.value > end && id.value !== CLUSTER) {
            break;
        }
        if (id.value === SCALE) {
            scale = uint(view, start, size.value);
        } else if (id.value === TIME && cues.length) {
            cues[cues.length - 1].time = uint(view, start, size.value);
        } else if (id.value === CLUSTER && cues.length && cues[cues.length - 1].pos < 0) {
            cues[cues.length - 1].pos = uint(view, start, size.value);
        }
        at = start + size.value;
    }
    var segments: Segment[] = [];
    if (segmentStart < 0) {
        return segments;
    }
    for (var i = 0; i < cues.length; i++) {
        var next = cues[i + 1];
        segments.push({
            start: cues[i].time * scale / 1e9,
            end: next ? next.time * scale / 1e9 : duration,
            from: segmentStart + cues[i].pos,
            to: (next ? segmentStart + next.pos : length) - 1
        });
    }
    return segments;
}

/** A segment's start (s): a WebM's (webmStart), an MP4's fragment decode time (moof > traf > tfdt) by its track's
 * timescale (moov > trak > mdia > mdhd); NaN if not found */
export function segmentStart(data: ArrayBuffer): number {
    var view = new DataView(data);
    if (data.byteLength >= 4 && view.getUint32(0) === 0x1A45DFA3) {
        return webmStart(data);
    }
    var mdhd = boxPath(view, ['moov', 'trak', 'mdia', 'mdhd']);
    var tfdt = boxPath(view, ['moof', 'traf', 'tfdt']);
    if (mdhd < 0 || tfdt < 0) {
        return NaN;
    }
    // Full boxes: version, then (mdhd) creation and modification times before the timescale
    var scale = view.getUint8(mdhd + 8) === 1 ? view.getUint32(mdhd + 28) : view.getUint32(mdhd + 20);
    var time = view.getUint8(tfdt + 8) === 1 ? u64(view, tfdt + 12) : view.getUint32(tfdt + 12);
    return scale ? time / scale : NaN;
}

/** The offset of the box at the end of path, each one inside the one before (-1: none) */
function boxPath(view: DataView, path: string[]): number {
    var from = 0;
    var to = view.byteLength;
    var box: { at: number; size: number } | null = null;
    for (var i = 0; i < path.length; i++) {
        box = findBox(view, from, to, path[i]);
        if (!box) {
            return -1;
        }
        from = box.at + 8;
        to = Math.min(to, box.at + box.size);
    }
    return box ? box.at : -1;
}

/** One fragment's samples (oneFragment): its sequence number and track, its tfdt box and decode time, each sample's
 * duration, size, flags and time offset, where their data starts, and their total duration and size */
interface Fragment {
    seq: number;
    track: number;
    tfdt: number;
    tfdtSize: number;
    start: number;
    signed: boolean;
    offsets: boolean;
    samples: number[][];
    data: number;
    time: number;
    bytes: number;
}

/** A live MP4 segment cut into many fragments (YouTube's low-latency streams: one per frame, each sample's size and
 * flags only as its fragment's defaults), as one fragment: one trun listing each sample's duration, size, flags and time
 * offset, one mdat with their data, as the other streams come (this TV's browser fails to decode the first frame of the
 * per-frame form). Anything else (one fragment, a WebM, a layout not known here) as it is. */
export function oneFragment(data: ArrayBuffer): ArrayBuffer {
    // (a box cut short at the end throws: as it is)
    try {
        return joined(data);
    } catch (e) {
        return data;
    }
}

function joined(data: ArrayBuffer): ArrayBuffer {
    var view = new DataView(data);
    // One fragment (the usual) before any sample is read
    var moofs = 0;
    for (var at = 0; at + 8 <= data.byteLength && view.getUint32(at) >= 8; at += view.getUint32(at)) {
        moofs += boxType(view, at) === 'moof' ? 1 : 0;
    }
    if (moofs < 2) {
        return data;
    }
    var fragments: Fragment[] = [];
    var first = -1;
    var open: Fragment | null = null;
    at = 0;
    while (at + 8 <= data.byteLength) {
        var size = view.getUint32(at);
        var type = boxType(view, at);
        if (size < 8 || at + size > data.byteLength) {
            return data;
        }
        if (type === 'moof') {
            open = open ? null : fragmentOf(view, at, size);
            if (!open) {
                return data;
            }
            first = first < 0 ? at : first;
        } else if (type === 'mdat' && open) {
            // Its samples within this mdat
            if (open.data < at + 8 || open.data + open.bytes > at + size) {
                return data;
            }
            fragments.push(open);
            open = null;
        } else if (first >= 0) {
            // Another box among the fragments
            return data;
        }
        at += size;
    }
    if (fragments.length < 2 || open || fragments.some(function (f) { return f.track !== fragments[0].track; })) {
        return data;
    }
    // Each fragment's samples from its own decode time on: the sample before it lasts up to there (a frame left out)
    for (var i = 1; i < fragments.length; i++) {
        var before = fragments[i - 1];
        var last = before.samples[before.samples.length - 1];
        var lasts = fragments[i].start - (before.start + before.time - last[0]);
        if (lasts < 0) {
            return data;
        }
        last[0] = lasts;
    }
    var head = fragments[0];
    var offsets = fragments.some(function (f) { return f.offsets; });
    var signed = fragments.some(function (f) { return f.signed; });
    var count = 0;
    var bytes = 0;
    fragments.forEach(function (f) {
        count += f.samples.length;
        bytes += f.bytes;
    });
    var entry = offsets ? 16 : 12;
    var trun = 20 + count * entry;
    var traf = 8 + 16 + head.tfdtSize + trun;
    var moof = 8 + 16 + traf;
    var out = new ArrayBuffer(first + moof + 8 + bytes);
    var w = new DataView(out);
    var b = new Uint8Array(out);
    var src = new Uint8Array(data);
    b.set(src.subarray(0, first));
    var p = first;
    var box = function (length: number, name: string, versionFlags?: number): void {
        w.setUint32(p, length);
        for (var i = 0; i < 4; i++) {
            w.setUint8(p + 4 + i, name.charCodeAt(i));
        }
        p += 8;
        if (versionFlags !== undefined) {
            w.setUint32(p, versionFlags);
            p += 4;
        }
    };
    box(moof, 'moof');
    box(16, 'mfhd', 0);
    w.setUint32(p, head.seq);
    p += 4;
    box(traf, 'traf');
    // (default-base-is-moof: the data offset counts from the moof)
    box(16, 'tfhd', 0x020000);
    w.setUint32(p, head.track);
    p += 4;
    b.set(src.subarray(head.tfdt, head.tfdt + head.tfdtSize), p);
    p += head.tfdtSize;
    box(trun, 'trun', (signed ? 0x01000000 : 0) | 0x701 | (offsets ? 0x800 : 0));
    w.setUint32(p, count);
    w.setUint32(p + 4, moof + 8);
    p += 8;
    fragments.forEach(function (f) {
        f.samples.forEach(function (s) {
            w.setUint32(p, s[0]);
            w.setUint32(p + 4, s[1]);
            w.setUint32(p + 8, s[2]);
            if (offsets) {
                w.setInt32(p + 12, s[3]);
            }
            p += entry;
        });
    });
    box(8 + bytes, 'mdat');
    fragments.forEach(function (f) {
        b.set(src.subarray(f.data, f.data + f.bytes), p);
        p += f.bytes;
    });
    return out;
}

/** The fragment of the moof at at (one traf of tfhd, tfdt and trun, its data from the moof); null if laid out otherwise */
function fragmentOf(view: DataView, at: number, size: number): Fragment | null {
    var mfhd = findBox(view, at + 8, at + size, 'mfhd');
    var traf = findBox(view, at + 8, at + size, 'traf');
    if (!mfhd || !traf || at + 8 + mfhd.size + traf.size !== at + size) {
        return null;
    }
    var f: Fragment = { seq: view.getUint32(mfhd.at + 12), track: 0, tfdt: -1, tfdtSize: 0, start: 0, signed: false, offsets: false, samples: [], data: -1,
        time: 0, bytes: 0 };
    var defaults: number[] = [];
    var p = traf.at + 8;
    var end = traf.at + traf.size;
    var seen = '';
    while (p + 8 <= end) {
        var length = view.getUint32(p);
        var type = boxType(view, p);
        if (length < 8 || p + length > end) {
            return null;
        }
        seen += type + ' ';
        var flags = view.getUint32(p + 8) & 0xffffff;
        if (type === 'tfhd') {
            // Not a base data offset of its own (0x1), the moof as the base (0x20000)
            if (flags & 1 || !(flags & 0x20000)) {
                return null;
            }
            f.track = view.getUint32(p + 12);
            var q = p + 16 + (flags & 2 ? 4 : 0);
            defaults = [flags & 8 ? view.getUint32(q) : -1, -1, -1];
            q += flags & 8 ? 4 : 0;
            defaults[1] = flags & 16 ? view.getUint32(q) : -1;
            q += flags & 16 ? 4 : 0;
            defaults[2] = flags & 32 ? view.getUint32(q) : -1;
        } else if (type === 'tfdt') {
            f.tfdt = p;
            f.tfdtSize = length;
            f.start = view.getUint8(p + 8) === 1 ? u64(view, p + 12) : view.getUint32(p + 12);
        } else if (type === 'trun') {
            if (!(flags & 1) || !defaults.length) {
                return null;
            }
            f.signed = view.getUint8(p + 8) === 1;
            f.offsets = !!(flags & 0x800);
            var samples = view.getUint32(p + 12);
            f.data = at + view.getInt32(p + 16);
            var r = p + 20;
            var firstFlags = flags & 4 ? view.getUint32(r) : -1;
            r += flags & 4 ? 4 : 0;
            for (var i = 0; i < samples; i++) {
                var s = [flags & 0x100 ? view.getUint32(r) : defaults[0], -1, -1, 0];
                r += flags & 0x100 ? 4 : 0;
                s[1] = flags & 0x200 ? view.getUint32(r) : defaults[1];
                r += flags & 0x200 ? 4 : 0;
                s[2] = flags & 0x400 ? view.getUint32(r) : i === 0 && firstFlags >= 0 ? firstFlags : defaults[2];
                r += flags & 0x400 ? 4 : 0;
                s[3] = flags & 0x800 ? (f.signed ? view.getInt32(r) : view.getUint32(r)) : 0;
                r += flags & 0x800 ? 4 : 0;
                // (a default only the moov's trex holds: not known here)
                if (s[0] < 0 || s[1] < 0 || s[2] < 0 || r > p + length) {
                    return null;
                }
                f.samples.push(s);
                f.time += s[0];
                f.bytes += s[1];
            }
        }
        p += length;
    }
    return seen === 'tfhd tfdt trun ' && f.samples.length ? f : null;
}

function boxType(view: DataView, at: number): string {
    return String.fromCharCode(view.getUint8(at + 4), view.getUint8(at + 5), view.getUint8(at + 6), view.getUint8(at + 7));
}
