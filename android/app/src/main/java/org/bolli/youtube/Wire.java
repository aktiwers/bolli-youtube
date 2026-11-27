package org.bolli.youtube;

import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/** YouTube's SABR protocol as bytes, as the page's own codec has it (src/youtube/api/sabr.ts, which this follows field
 * for field: tests/youtube-android-native.test.mjs holds the two together): the request (protocol buffers), and the
 * answer's parts (UMP: each a type and a size in UMP's numbers, then its bytes). Plain Java, nothing of Android's or
 * the player's: a test compiles it alone. */
final class Wire {
    /** Part types (the page's names) */
    static final int MEDIA_HEADER = 20;
    static final int MEDIA = 21;
    static final int MEDIA_END = 22;
    static final int NEXT_REQUEST_POLICY = 35;
    static final int FORMAT_INITIALIZATION_METADATA = 42;
    static final int SABR_REDIRECT = 43;
    static final int SABR_ERROR = 44;
    static final int RELOAD_PLAYER_RESPONSE = 46;
    static final int SABR_CONTEXT_UPDATE = 57;
    static final int STREAM_PROTECTION_STATUS = 58;
    static final int SABR_CONTEXT_SENDING_POLICY = 59;

    private Wire() {
    }

    /** A format as SABR names it */
    static final class Id {
        final int itag;
        final long lmt;
        final String xtags;

        Id(int itag, long lmt, String xtags) {
            this.itag = itag;
            this.lmt = lmt;
            this.xtags = xtags == null ? "" : xtags;
        }
    }

    /** A run of a format's segments the player holds: the first and last (SABR's numbers) and their time span */
    static final class Run {
        final Id format;
        final long startMs;
        final long durationMs;
        final int first;
        final int last;

        Run(Id format, long startMs, long durationMs, int first, int last) {
            this.format = format;
            this.startMs = startMs;
            this.durationMs = durationMs;
            this.first = first;
            this.last = last;
        }
    }

    /** What a request says (the page's SabrAsk) */
    static final class Ask {
        long playerMs;
        /** 1 audio only, 2 video only */
        int tracks;
        Id video;
        Id audio;
        int height;
        String audioTrack = "";
        boolean drc;
        final List<Id> initialized = new ArrayList<>();
        final List<Run> buffered = new ArrayList<>();
        byte[] config;
        String hl = "";
        String make = "";
        String model = "";
        String version = "";
        String osName = "";
        String osVersion = "";
        /** The last answer's (null: none yet) */
        byte[] cookie;
        /** The contexts sent back, in the order of their types, and the types known and not sent */
        final List<Integer> contextTypes = new ArrayList<>();
        final List<byte[]> contextValues = new ArrayList<>();
        final List<Integer> unsent = new ArrayList<>();
    }

    /** Protocol buffers written */
    static final class Writer {
        private final ByteArrayOutputStream out = new ByteArrayOutputStream();

        Writer varint(int field, long n) {
            number(field * 8L);
            number(n);
            return this;
        }

        Writer data(int field, byte[] data) {
            number(field * 8L + 2);
            number(data.length);
            out.write(data, 0, data.length);
            return this;
        }

        Writer string(int field, String s) {
            return data(field, s.getBytes(StandardCharsets.UTF_8));
        }

        Writer message(int field, Writer m) {
            return data(field, m.bytes());
        }

        byte[] bytes() {
            return out.toByteArray();
        }

        private void number(long n) {
            while (n >= 128) {
                out.write((int) (n % 128 + 128));
                n /= 128;
            }
            out.write((int) n);
        }
    }

    private static Writer formatId(Id id) {
        Writer w = new Writer().varint(1, id.itag).varint(2, id.lmt);
        return id.xtags.isEmpty() ? w : w.string(3, id.xtags);
    }

    /** The request's body */
    static byte[] request(Ask ask) {
        Writer abr = new Writer().varint(16, ask.height).varint(21, ask.height).varint(28, Math.max(0, ask.playerMs)).varint(29, 0)
                .varint(34, 2).varint(36, 0).varint(39, 0).varint(40, ask.tracks).varint(46, ask.drc ? 1 : 0).varint(71, 1).varint(85, 0);
        if (!ask.audioTrack.isEmpty()) {
            abr.string(69, ask.audioTrack);
        }
        Writer info = new Writer().string(1, ask.hl).string(12, ask.make).string(13, ask.model).varint(16, 7).string(17, ask.version)
                .string(18, ask.osName).string(19, ask.osVersion);
        Writer streamer = new Writer().message(1, info);
        if (ask.cookie != null) {
            streamer.data(3, ask.cookie);
        }
        for (int i = 0; i < ask.contextTypes.size(); i++) {
            streamer.message(5, new Writer().varint(1, ask.contextTypes.get(i)).data(2, ask.contextValues.get(i)));
        }
        for (int type : ask.unsent) {
            streamer.varint(6, type);
        }
        Writer req = new Writer().message(1, abr);
        for (Id id : ask.initialized) {
            req.message(2, formatId(id));
        }
        for (Run b : ask.buffered) {
            req.message(3, new Writer().message(1, formatId(b.format)).varint(2, b.startMs).varint(3, b.durationMs).varint(4, b.first)
                    .varint(5, b.last).message(6, new Writer().varint(1, b.startMs).varint(2, b.durationMs).varint(3, 1000)));
        }
        return req.data(5, ask.config).message(16, formatId(ask.audio)).message(17, formatId(ask.video)).message(19, streamer).bytes();
    }

    /** A message's fields read: each value a number, or bytes at their place in the message */
    static final class Fields {
        private final byte[] p;
        /** Each value: its field, 0 for a number (then the number) or 1 for bytes (then where they begin and end) */
        private final List<long[]> values = new ArrayList<>();

        Fields(byte[] message) {
            p = message == null ? new byte[0] : message;
            int[] at = { 0 };
            while (at[0] < p.length) {
                long key = varint(at);
                int field = (int) (key / 8);
                int type = (int) (key % 8);
                if (type == 0) {
                    values.add(new long[] { field, 0, varint(at), 0 });
                } else if (type == 2) {
                    int length = (int) Math.min(varint(at), p.length - at[0]);
                    values.add(new long[] { field, 1, at[0], at[0] + length });
                    at[0] += length;
                } else if (type == 1) {
                    at[0] += 8;
                } else if (type == 5) {
                    at[0] += 4;
                } else {
                    break;
                }
            }
        }

        private long varint(int[] at) {
            long n = 0;
            long scale = 1;
            int c;
            if (at[0] >= p.length) {
                return 0;
            }
            do {
                c = p[at[0]++] & 0xff;
                n += (c & 127) * scale;
                scale *= 128;
            } while ((c & 128) != 0 && at[0] < p.length);
            return n;
        }

        private long[] first(int field) {
            for (long[] v : values) {
                if (v[0] == field) {
                    return v;
                }
            }
            return null;
        }

        /** The field's first value where it is a number (0: none) */
        long num(int field) {
            long[] v = first(field);
            return v != null && v[1] == 0 ? v[2] : 0;
        }

        /** The field's first value where it is bytes (null: none) */
        byte[] bytes(int field) {
            long[] v = first(field);
            if (v == null || v[1] == 0) {
                return null;
            }
            byte[] out = new byte[(int) (v[3] - v[2])];
            System.arraycopy(p, (int) v[2], out, 0, out.length);
            return out;
        }

        String text(int field) {
            byte[] b = bytes(field);
            return b == null ? "" : new String(b, StandardCharsets.UTF_8);
        }

        /** Every number of a repeated field, packed or not */
        List<Integer> ints(int field) {
            List<Integer> out = new ArrayList<>();
            for (long[] v : values) {
                if (v[0] != field) {
                    continue;
                }
                if (v[1] == 0) {
                    out.add((int) v[2]);
                    continue;
                }
                int[] at = { (int) v[2] };
                while (at[0] < v[3]) {
                    out.add((int) varint(at));
                }
            }
            return out;
        }
    }

    /** A segment's header in an answer: the id its media parts carry, its format's itag, whether it is the format's
     * init segment, else its number and times, and its media's length (0: not told) */
    static final class Header {
        final int id;
        final int itag;
        final boolean init;
        final int number;
        final long startMs;
        final long durationMs;
        final long length;

        Header(byte[] part) {
            Fields f = new Fields(part);
            id = (int) f.num(1);
            itag = (int) f.num(3);
            init = f.num(8) != 0;
            number = (int) f.num(9);
            startMs = f.num(11);
            durationMs = f.num(12);
            length = f.num(14);
        }
    }

    /** The next request's policy: how long to wait before it (ms), and the cookie to send back (null: the last one
     * still) */
    static final class Policy {
        final long backoffMs;
        final byte[] cookie;

        Policy(byte[] part) {
            Fields f = new Fields(part);
            backoffMs = f.num(4);
            cookie = f.bytes(7);
        }
    }

    /** A context the server gives to keep: its type, its value, and whether it is sent back from now on */
    static final class Context {
        final int type;
        final byte[] value;
        final boolean byDefault;

        Context(byte[] part) {
            Fields f = new Fields(part);
            type = (int) f.num(1);
            byte[] given = f.bytes(3);
            value = given == null ? new byte[0] : given;
            byDefault = f.num(4) != 0;
        }
    }

    /** Which contexts (by type) to start sending back, stop sending, and forget */
    static final class Sending {
        final List<Integer> start;
        final List<Integer> stop;
        final List<Integer> discard;

        Sending(byte[] part) {
            Fields f = new Fields(part);
            start = f.ints(1);
            stop = f.ints(2);
            discard = f.ints(3);
        }
    }

    /** The stream protection status (0 not given, 1 ok, 2 pending, 3 refused) */
    static int protection(byte[] part) {
        return (int) new Fields(part).num(1);
    }

    /** The address to ask at from now on ('': none named) */
    static String redirect(byte[] part) {
        return new Fields(part).text(1);
    }

    /** The server's error, as the page words it */
    static String error(byte[] part) {
        Fields f = new Fields(part);
        String text = f.text(1);
        return (text.isEmpty() ? "error" : text) + ' ' + f.num(2);
    }

    /** The token a request for the streams anew comes with ('': none) */
    static String reloadToken(byte[] part) {
        return new Fields(new Fields(part).bytes(1)).text(1);
    }

    /** The answer's body ended in the middle of a part: the server ended it so (its stream said so), which is no
     * line failing */
    static final class Ended extends EOFException {
        Ended(String what) {
            super(what);
        }
    }

    /** The UMP number at in (-1: the answer ended before it) */
    static long number(InputStream in) throws IOException {
        int first = in.read();
        if (first < 0) {
            return -1;
        }
        int n = first < 128 ? 1 : first < 192 ? 2 : first < 224 ? 3 : first < 240 ? 4 : 5;
        long b1 = n > 1 ? more(in) : 0;
        long b2 = n > 2 ? more(in) : 0;
        long b3 = n > 3 ? more(in) : 0;
        long b4 = n > 4 ? more(in) : 0;
        return n == 1 ? first : n == 2 ? (first & 0x3f) + b1 * 64 : n == 3 ? (first & 0x1f) + b1 * 32 + b2 * 8192
                : n == 4 ? (first & 0x0f) + b1 * 16 + b2 * 4096 + b3 * 1048576 : b1 + b2 * 256 + b3 * 65536 + b4 * 16777216;
    }

    private static int more(InputStream in) throws IOException {
        int b = in.read();
        if (b < 0) {
            throw new Ended("answer cut in a number");
        }
        return b;
    }

    /** The next n bytes of in */
    static byte[] bytes(InputStream in, int n) throws IOException {
        byte[] out = new byte[n];
        int at = 0;
        while (at < n) {
            int read = in.read(out, at, n - at);
            if (read < 0) {
                throw new Ended("answer cut in a part");
            }
            at += read;
        }
        return out;
    }

    /** Reads past the next n bytes of in */
    static void skip(InputStream in, long n, byte[] scratch) throws IOException {
        while (n > 0) {
            int read = in.read(scratch, 0, (int) Math.min(n, scratch.length));
            if (read < 0) {
                throw new Ended("answer cut in a part");
            }
            n -= read;
        }
    }
}
