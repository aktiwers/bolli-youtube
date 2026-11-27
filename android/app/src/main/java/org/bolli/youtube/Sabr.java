package org.bolli.youtube;

import android.os.SystemClock;
import android.util.Base64;

import androidx.media3.extractor.ChunkIndex;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InterruptedIOException;
import java.net.SocketTimeoutException;
import java.util.HashMap;
import java.util.Map;
import java.util.TreeMap;
import java.util.TreeSet;

/** A video's streams by SABR (the account's: YouTube's server decides what each answer holds), asked for the player
 * as the page's own engine asks (src/youtube/player/sabr-engine.ts, whose rules these are: pump, ask, answered). The
 * player plays a SABR video as it plays a guest's: by the formats' own index, a segment at a time (SabrSource); a
 * segment SABR sends is the file's bytes of that index entry, and a format's init segment the file's head up to its
 * index's end. Each kind (Lane) asks on its own, one request at a time: a request names both formats, the playhead,
 * the segments the player holds of each and the last answer's cookie; the answer brings the format's init segment
 * where the request did not list it, then whole segments on from the playhead or from what is held. An answer is
 * read as the player asks for its segments and is left open between them. What a video answer brings of the
 * sound (the server sends some with it, asked or not) is kept for the audio lane, which gives those segments from
 * memory before it asks (as the page's engine takes a segment from whichever answer brought it); anything else of
 * another format is read past. Nothing is asked while the player wants no more (Loading: READAHEAD_US ahead), nor by a lane that has that
 * much ahead itself (the player asks for the kind that ends first, whose end may be further on: that lane waits for
 * the playhead, without a request), so none while it rests.
 * A lane is its loader thread's; the session's own state (cookie, contexts, heads, the runs held, the playhead) is
 * guarded by the session, never during a request. A jump lets a lane go from the app's thread (abort) only where the
 * player lets that lane's load go too: not one whose segment on its way holds the jump's place, nor one reading a
 * format's head (the player keeps those loads).
 * A lane follows the format the player asks for: another quality or sound (the page's switch in place, Auto) is asked
 * of the server by its own id from then on, the segments held told under it (a video's formats share their segments'
 * numbers and times), the answer of the format before let go. */
final class Sabr {
    /** More is asked for while less than this is loaded ahead of the picture (us; the page's READAHEAD_S): the server
     * answers a request for more than it means to send ahead with nothing */
    static final long READAHEAD_US = 10000000;
    /** Answers in a row that bring a lane nothing new before it gives up, and those in a row that only name another
     * address followed at once (the page's) */
    private static final int EMPTY_ANSWERS = 5;
    private static final int REDIRECTS = 3;
    /** An answer bringing another segment than the one asked for is asked anew this many times in a row */
    private static final int MISSES = 2;
    /** A part that is not media is no larger than this (a larger one is read past) */
    private static final int PART_MOST = 1024 * 1024;
    /** The sound's segments a video answer brought, kept for the audio lane: at most this many (about a minute of
     * sound, some 1 MB, where the audio lane asks for 10 s ahead) */
    private static final int SPARES_MOST = 6;
    /** The server's own no, or an answer that cannot be played: the page's name for it ('expired', 'protection',
     * 'sabr ...', 'stream', 'player'). Not tried again */
    static final class Refused extends IOException {
        final String why;

        Refused(String why, String text) {
            super(text);
            this.why = why;
        }
    }

    /** A format's index: each segment's place in the file and its time */
    private static final class Index {
        final long[] offsets;
        final int[] sizes;
        final long[] timesUs;
        final long[] durationsUs;

        Index(ChunkIndex index) {
            offsets = index.offsets;
            sizes = index.sizes;
            timesUs = index.timesUs;
            durationsUs = index.durationsUs;
        }

        /** The segment holding the file's byte at position (-1: none) */
        int at(long position) {
            int low = 0;
            int high = offsets.length - 1;
            while (low <= high) {
                int mid = (low + high) >>> 1;
                if (position < offsets[mid]) {
                    high = mid - 1;
                } else if (position >= offsets[mid] + sizes[mid]) {
                    low = mid + 1;
                } else {
                    return mid;
                }
            }
            return -1;
        }

        long endUs(int k) {
            return timesUs[k] + durationsUs[k];
        }
    }

    /** An answer on its way */
    private static final class Answer {
        final Net.Http http;
        final InputStream in;
        /** The address it was asked at (its network passed over where it stalls: Net) */
        final String url;
        /** Cut short from another thread (a jump, the video's end): its lane lets it go at its next look */
        volatile boolean dropped;
        /** The header that came last */
        Wire.Header header;
        /** A sound segment it brings to a video lane, kept for the audio lane: its header, its bytes and how many came
         * (null: none coming) */
        Wire.Header soundHeader;
        byte[] sound;
        int soundAt;
        /** The media part being read: its header's id and its bytes not yet read */
        int of = -1;
        long left;
        /** A media header of the lane's format read, its media not yet given */
        Wire.Header next;
        /** The lane's segments it brought so far, and when the last of them was all in (elapsed ms) */
        int taken;
        long takenAt;
        long backoffMs;
        int protection;
        boolean redirected;
        String error = "";
        boolean reload;
        String reloadToken = "";

        /** When it was asked (elapsed ms), and the audio format its request named (a sound it brings is that one's) */
        long askedAt;
        Sent soundFormat;

        Answer(Net.Http http, InputStream in, String url) {
            this.http = http;
            this.in = in;
            this.url = url;
        }
    }

    private final String agent;
    private volatile String url;
    private final byte[] config;
    private final JSONObject client;
    private byte[] cookie;
    /** The contexts the server gave to keep, by type, and the types it wants sent back */
    private final TreeMap<Integer, byte[]> contexts = new TreeMap<>();
    private final TreeSet<Integer> active = new TreeSet<>();
    private int rn;
    /** The formats' init segments that came (a request lists these formats as known) */
    private final Map<Sent, byte[]> heads = new HashMap<>();
    /** Each format's index as the player read it from its head. Guarded by the session */
    private final Map<Sent, Index> indexes = new HashMap<>();
    /** Who hears of a video segment's download (bytes, ms: Auto quality's speeds) */
    private final Ranged.Table table;
    /** The sound's segments a video answer brought (by SABR's number), for the audio lane */
    private final TreeMap<Integer, byte[]> spares = new TreeMap<>();
    /** The two kinds' lanes (new ones as the player takes the video up again after a failure: revive) */
    private volatile Lane video;
    private volatile Lane audio;
    /** The playhead as the app's thread last told it (ms), when (elapsed ms), and how fast it runs on (0: it stands).
     * Guarded by the session */
    private long posMs;
    private long atMs;
    private float speed;
    /** A video loaded ahead of its start: an answer is let go once it gave a segment (the viewer may never start it) */
    volatile boolean holding;
    private volatile boolean closed;
    /** The loads on their way (a SabrSource open), and those of them waiting for the playhead. Guarded by the session */
    private int loads;
    private int waiting;
    /** For the page, each told once (report): the token a server's reload request came with, the address it moved
     * to, and a line for the play log (a segment that is not the size its index tells: said once a video). Guarded by
     * the session */
    private String token;
    private String moved;
    private String said;
    private boolean saidOnce;

    Sabr(String agent, JSONObject sabr, Sent video, Sent audio, long startMs, Ranged.Table table) throws JSONException {
        this.agent = agent;
        this.table = table;
        url = sabr.getString("url");
        // (base64 or its URL form, padded or not, as the page takes it)
        config = Base64.decode(sabr.getString("config").replace('-', '+').replace('_', '/'), Base64.DEFAULT);
        client = sabr.getJSONObject("client");
        this.video = new Lane(true, video);
        this.audio = new Lane(false, audio);
        told(startMs);
    }

    private synchronized void told(long ms) {
        posMs = ms;
        atMs = SystemClock.elapsedRealtime();
    }

    Lane lane(boolean video) {
        return video ? this.video : audio;
    }

    /** A format's index as the player read it from the head */
    synchronized void index(Sent f, ChunkIndex index) {
        Index x = new Index(index);
        indexes.put(f, x);
        Lane lane = lane(f.video);
        if (lane.format == f) {
            lane.index = x;
        }
    }

    /** The playhead now, each second while it plays or loads: what the player let go behind it is no longer held.
     * speed: 0 where it stands */
    synchronized void at(long ms, float speed, long behindUs) {
        told(ms);
        this.speed = speed;
        video.trim(ms * 1000 - behindUs);
        audio.trim(ms * 1000 - behindUs);
        notifyAll();
    }

    /** The session's part of the player's report (native.ts: Report), each thing once */
    synchronized void report(StringBuilder s) {
        if (token != null) {
            s.append(",token:").append(JSONObject.quote(token));
            token = null;
        }
        if (moved != null) {
            s.append(",url:").append(JSONObject.quote(moved));
            moved = null;
        }
        if (said != null) {
            s.append(",say:").append(JSONObject.quote(said));
            said = null;
        }
    }

    /** The player takes the video up again after it failed (its loads were let go without waiting for their threads,
     * which may sit in a request still): new lanes, so one of those threads cannot use a lane with its successor;
     * what the player held is asked anew */
    synchronized void anew() {
        anew(true);
        anew(false);
    }

    /** As anew, one kind's lane: the player loads that kind with a new loader (a format picked that it has to make
     * its track anew for) */
    synchronized void anew(boolean video) {
        Lane old = lane(video);
        Lane made = new Lane(video, old.format);
        if (video) {
            this.video = made;
        } else {
            audio = made;
        }
        old.abort(true);
        notifyAll();
    }

    /** A load begins (SabrSource.open) and is over (its close) */
    synchronized void loading(boolean on) {
        loads += on ? 1 : -1;
    }

    /** Nothing comes in though the player is loading: every load on its way waits for the playhead (the player's
     * state need not be told meanwhile: it changes when the picture moves on, which is told) */
    synchronized boolean resting() {
        return waiting > 0 && waiting >= loads;
    }

    /** A jump to ms: a lane that does not hold it lets its answer go (the player asks anew from there, and would
     * else wait for a read of the old answer to return) */
    void seek(long ms) {
        told(ms);
        for (Lane lane : new Lane[] { video, audio }) {
            if (!lane.holds(ms * 1000)) {
                lane.abort(false);
            }
        }
        synchronized (this) {
            notifyAll();
        }
    }

    /** The video is let go */
    void close() {
        closed = true;
        video.abort(true);
        audio.abort(true);
        synchronized (this) {
            notifyAll();
        }
    }

    /** (the session's lock held) */
    private long playhead() {
        return posMs + (long) ((SystemClock.elapsedRealtime() - atMs) * speed);
    }

    /** Whether the audio lane still wants the sound's segment `number` (it holds it not) */
    private synchronized boolean wanted(int number) {
        return number > audio.last + 1;
    }

    /** A sound segment a video answer brought, kept for the audio lane (one it holds by now, not); full, the one it
     * wants last goes */
    private synchronized void keep(Sent sound, int number, byte[] bytes) {
        if (sound == audio.format && wanted(number)) {
            spares.put(number, bytes);
            spares.headMap(audio.last + 2).clear();
            while (spares.size() > SPARES_MOST) {
                spares.pollLastEntry();
            }
        }
    }

    /** The audio lane's segment `number` from what a video answer brought, if it came whole (size: the index's;
     * null: none); those before it are not wanted any more (the session's lock held) */
    private byte[] takeSpare(int number, int size) {
        if (spares.isEmpty()) {
            return null;
        }
        spares.headMap(number).clear();
        byte[] kept = spares.remove(number);
        return kept != null && kept.length == size ? kept : null;
    }

    private static Wire.Id id(Sent f) {
        return new Wire.Id(f.itag, f.lmt, f.xtags);
    }

    /** One kind's requests and what the player holds of it */
    final class Lane {
        private final boolean isVideo;
        private volatile Sent format;
        private volatile Index index;
        /** The run of segments the player holds as far as known (index entries; -1: none). Guarded by the session */
        private int first = -1;
        private int last = -1;
        /** The answer open, and a request whose answer has not begun */
        private volatile Answer answer;
        private volatile Net.Http opening;
        /** Let go from another thread (abort) since its load began: the load ends there, asking nothing more */
        private volatile boolean cut;
        /** It reads its format's head (a load the player keeps through a jump) */
        private volatile boolean heading;
        /** A load of the lane's is on its way (from its begin to its release): its thread may be reading the answer */
        private volatile boolean busy;
        /** The index entry of the segment a load is at (-1: none): the player keeps that load through a jump into
         * it. Guarded by the session */
        private int loading = -1;
        /** The segment (SABR's number) the open answer brings next of this format (0: not known) */
        private int expect;
        private int empty;
        private int redirects;
        private long waitUntil;
        /** The segment being given: its index entry, its header, the bytes still to give (-1: until its end is told)
         * and whether it is all given; or, one a video answer brought, its bytes and how far they are given */
        private int k;
        private Wire.Header giving;
        private long left;
        private boolean given;
        private byte[] memory;
        private int memoryAt;
        /** When the load being run began (elapsed ms) */
        private long openedAt;
        private final byte[] scratch = new byte[8192];

        /** (the session's lock held) */
        Lane(boolean video, Sent format) {
            isVideo = video;
            this.format = format;
            index = indexes.get(format);
        }

        private boolean own(Wire.Header h) {
            return h.itag == format.itag;
        }

        /** (the session's lock held) */
        private void trim(long beforeUs) {
            Index x = index;
            while (x != null && first >= 0 && first < last && x.endUs(first) < beforeUs) {
                first++;
            }
        }

        /** Whether the player keeps this lane's load through a jump to us: within the run it holds and the segment
         * on its way, or while a head is read */
        private boolean holds(long us) {
            Index x = index;
            synchronized (Sabr.this) {
                int from = first >= 0 ? first : loading;
                int to = Math.max(last, loading);
                return heading || x != null && from >= 0 && us >= x.timesUs[from] && us < x.endUs(to);
            }
        }

        /** Let go from another thread: its load ends where it waits or reads. At a jump (all false) a head's read
         * is left to end: the player keeps that load, and the answer behind it goes at the next segment asked */
        private void abort(boolean all) {
            boolean now = all || !heading;
            cut = now;
            // (the request first: asked, it becomes the answer)
            Net.Http h = opening;
            Answer a = answer;
            if (a != null) {
                a.dropped = true;
            }
            if (now) {
                Net.cut(h, false);
                if (a != null) {
                    // (its stream is closed by the lane's own thread as it lets the answer go: drop. With no load
                    // on its way and none to come, the session let go or the lane replaced, nobody reads it: here)
                    Net.cut(a.http, all && !busy);
                }
            }
        }

        /** The open answer let go, unread (on the lane's own thread) */
        private void drop() {
            Answer a = answer;
            answer = null;
            expect = 0;
            if (a != null) {
                a.dropped = true;
                Net.end(a.http);
            }
        }

        /** The format the player asks for from here on (another quality or sound: switched in place): its index, the
         * answer of the one before let go, a sound kept from video answers no longer of use */
        private void follow(Sent f) {
            if (f == format) {
                return;
            }
            synchronized (Sabr.this) {
                format = f;
                // (until its own is read, the one before's: the formats share their segments' numbers and times, which
                // its head's request tells the server, so that it sends on from what is held, not from the playhead)
                Index known = indexes.get(f);
                if (known != null) {
                    index = known;
                }
                if (!isVideo) {
                    spares.clear();
                }
            }
            drop();
        }

        /** A load of the lane's begins: what cut the one before it is over. None once the session is let go (said
         * busy first: the session's close, which then finds the lane idle, closes its answer itself) */
        private void begin() throws IOException {
            cut = false;
            busy = true;
            openedAt = SystemClock.elapsedRealtime();
            if (closed) {
                throw new InterruptedIOException("sabr closed");
            }
        }

        /** The format's init segment: the file's head */
        byte[] head(Sent f) throws IOException {
            begin();
            follow(f);
            heading = true;
            try {
                return headed(f);
            } finally {
                heading = false;
                busy = false;
            }
        }

        private byte[] headed(Sent f) throws IOException {
            for (;;) {
                synchronized (Sabr.this) {
                    byte[] have = heads.get(f);
                    if (have != null) {
                        return have;
                    }
                }
                if (answer != null && answer.dropped) {
                    drop();
                }
                if (answer == null) {
                    ask(-1);
                }
                Answer a = answer;
                ByteArrayOutputStream got = null;
                int id = -1;
                int type;
                try {
                    while ((type = part(a)) >= 0) {
                        if (type == Wire.MEDIA_HEADER && own(a.header)) {
                            if (!a.header.init) {
                                // (media with no init before it: the server takes the format as known)
                                throw new Refused("stream", "segment " + a.header.number + " of " + format.itag + " with no init");
                            }
                            id = a.header.id;
                            got = new ByteArrayOutputStream((int) Math.max(a.header.length, 4096));
                        } else if (type == Wire.MEDIA && a.of == id && got != null) {
                            while (a.left > 0) {
                                int read = a.in.read(scratch, 0, (int) Math.min(a.left, scratch.length));
                                if (read < 0) {
                                    throw new Wire.Ended("sabr answer cut in the init");
                                }
                                got.write(scratch, 0, read);
                                a.left -= read;
                            }
                        } else if (type == Wire.MEDIA_END && a.of == id && got != null) {
                            a.taken++;
                            synchronized (Sabr.this) {
                                heads.put(f, got.toByteArray());
                            }
                            break;
                        }
                    }
                } catch (IOException e) {
                    // (an answer that failed is not read on)
                    drop();
                    throw stalled(a, e);
                }
                if (type < 0) {
                    finish(a);
                }
            }
        }

        /** The segment holding the file's byte at position, from there on: the answer put at its media. Returns
         * the bytes it will give (-1: until its end) */
        long open(Sent f, long position) throws IOException {
            begin();
            follow(f);
            // (the format's own index for its bytes: the lane's may still be the one before's, for the times)
            Index x;
            synchronized (Sabr.this) {
                x = indexes.get(f);
            }
            int entry = x == null ? -1 : x.at(position);
            if (entry < 0) {
                throw new Refused("stream", "no segment of " + f.itag + " at " + position);
            }
            k = entry;
            giving = null;
            given = false;
            memory = null;
            long skip = position - x.offsets[k];
            synchronized (Sabr.this) {
                loading = k;
                follows();
            }
            start();
            if (memory != null) {
                memoryAt = (int) Math.min(skip, memory.length);
                return memory.length - memoryAt;
            }
            Answer a = answer;
            giving = a.next;
            a.next = null;
            if (giving.length > 0 && giving.length != x.sizes[k]) {
                synchronized (Sabr.this) {
                    if (!saidOnce) {
                        saidOnce = true;
                        said = "sabr segment " + giving.number + " of " + format.itag + " is " + giving.length + " B, the index's " + x.sizes[k];
                    }
                }
            }
            left = giving.length > 0 ? giving.length : -1;
            // (a load taken up again after a failure: the segment comes whole again, what was given is read past)
            while (skip > 0) {
                int read = read(scratch, 0, (int) Math.min(skip, scratch.length));
                if (read < 0) {
                    throw new Wire.Ended("sabr segment shorter than what was given of it");
                }
                skip -= read;
            }
            return left;
        }

        /** The run held as segment k is wanted (the session's lock held): one it held, what followed was let go;
         * else a jump out of the run */
        private void follows() {
            if (last < 0 || k != last + 1) {
                if (first >= 0 && k > first && k <= last) {
                    last = k - 1;
                } else {
                    first = last = -1;
                }
                // (asked anew from another place: no wait left over from where it was, as the page's engine)
                waitUntil = 0;
                empty = 0;
            }
        }

        /** Puts the answer at the media header of segment k, asking where no answer open brings it */
        private void start() throws IOException {
            int want = k + 1;
            int misses = 0;
            for (;;) {
                Answer a = answer;
                if (a != null && (a.dropped || a.next == null && expect != 0 && expect != want || a.next != null && a.next.number > want)) {
                    drop();
                    a = null;
                }
                boolean fresh = a == null;
                if (fresh) {
                    // (the sound's segment a video answer brought while the lane waited: given from memory)
                    byte[] kept = waited();
                    if (kept != null) {
                        memory = kept;
                        return;
                    }
                    ask(k);
                    a = answer;
                }
                try {
                    if (a.next == null) {
                        int type;
                        while ((type = part(a)) >= 0) {
                            if (type == Wire.MEDIA_HEADER && own(a.header) && !a.header.init) {
                                a.next = a.header;
                                break;
                            }
                        }
                        if (type < 0) {
                            finish(a);
                            continue;
                        }
                    }
                } catch (IOException e) {
                    // (an answer that failed is not read on. One just asked for that stalls: its network passed
                    // over, asked at the next at once (stalled). One left open from a load before, which has died or
                    // gone quiet since (the server holds one open after a small segment): asked anew, no failure;
                    // not where the lane was let go, or its thread told to stop)
                    drop();
                    if (fresh || closed || cut || e instanceof Refused || e instanceof InterruptedIOException && !(e instanceof SocketTimeoutException)) {
                        throw stalled(a, e);
                    }
                    continue;
                }
                if (a.next.number == want) {
                    return;
                }
                if (a.next.number < want) {
                    // (one the player has: read past)
                    a.next = null;
                    continue;
                }
                if (++misses > MISSES) {
                    throw new Refused("stream", "sabr sent segment " + a.next.number + " of " + format.itag + " for " + want);
                }
            }
        }

        /** The segment's next bytes (-1: it is all given) */
        int read(byte[] buffer, int offset, int length) throws IOException {
            if (given) {
                return -1;
            }
            byte[] kept = memory;
            if (kept != null) {
                int read = Math.min(length, kept.length - memoryAt);
                System.arraycopy(kept, memoryAt, buffer, offset, read);
                memoryAt += read;
                if (memoryAt == kept.length) {
                    done(null);
                }
                return read;
            }
            Answer a = answer;
            if (a == null || giving == null) {
                throw new IOException("sabr answer let go");
            }
            try {
                for (;;) {
                    if (a.left > 0 && a.of == giving.id) {
                        int read = a.in.read(buffer, offset, (int) Math.min(length, a.left));
                        if (read < 0) {
                            throw new Wire.Ended("sabr answer cut in a segment");
                        }
                        a.left -= read;
                        if (left > 0) {
                            left -= read;
                            if (left == 0) {
                                done(a);
                            }
                        }
                        return read;
                    }
                    int type = part(a);
                    if (type < 0) {
                        throw new Wire.Ended("sabr answer over in a segment");
                    }
                    if (type == Wire.MEDIA_END && a.of == giving.id) {
                        done(a);
                        return -1;
                    }
                }
            } catch (IOException e) {
                throw stalled(a, e);
            }
        }

        /** A failure in reading answer a as it is told on: a stall in it (no data for Net.STALL_MS) or its line cut
         * passes its network over, the next request asked at another at once (Net.failed); as they are: one let go
         * from this side, the server's own no or end, and one in an answer that lay open, unread, longer than a stall
         * before this load (its line may have gone quiet meanwhile, over a viewer's pause or at a router, which is no
         * network's failing) */
        private IOException stalled(Answer a, IOException e) {
            boolean rested = openedAt - Math.max(a.askedAt, a.takenAt) > Net.STALL_MS;
            return closed || cut || rested || e instanceof Refused || e instanceof Wire.Ended ? e : Net.failed(a.url, e, true);
        }

        /** The segment is all given (a: the answer it came in; null: from memory) */
        private void done(Answer a) {
            given = true;
            if (a != null) {
                a.taken++;
                a.takenAt = SystemClock.elapsedRealtime();
                expect = giving.number + 1;
                // (the download as Auto quality judges the line by: the segment a request was made for, from when it
                // was sent, as the page's engines time theirs; one an answer brought before it was wanted tells nothing)
                if (isVideo && a.taken == 1 && a.askedAt >= openedAt) {
                    table.loaded(giving.length, a.takenAt - a.askedAt);
                }
            } else if (expect == k + 1) {
                // (given from memory: an answer still open brings it too, and is read past it)
                expect = k + 2;
            }
            synchronized (Sabr.this) {
                if (first < 0) {
                    first = k;
                }
                last = k;
                loading = -1;
            }
            if (holding) {
                drop();
            }
        }

        /** The player is done with the segment, or gave it up: one half given cannot be gone on with */
        void release() {
            if (giving != null && !given) {
                drop();
            }
            giving = null;
            memory = null;
            synchronized (Sabr.this) {
                loading = -1;
            }
            busy = false;
        }

        /** The answer's next part: its type (-1: the answer is over). A media part's bytes are left to read (a.left of
         * them, of header a.of; what the caller leaves of them is read past here), any other part is taken whole */
        private int part(Answer a) throws IOException {
            if (a.left > 0 && a.sound != null && a.of == a.soundHeader.id && a.left <= a.sound.length - a.soundAt) {
                // (a sound segment a video answer brings: kept for the audio lane)
                while (a.left > 0) {
                    int read = a.in.read(a.sound, a.soundAt, (int) a.left);
                    if (read < 0) {
                        throw new Wire.Ended("sabr answer cut in a segment");
                    }
                    a.soundAt += read;
                    a.left -= read;
                }
            } else if (a.left > 0) {
                if (a.sound != null && a.of == a.soundHeader.id) {
                    // (longer than its header said: not kept)
                    a.sound = null;
                }
                Wire.skip(a.in, a.left, scratch);
                a.left = 0;
            }
            long type = Wire.number(a.in);
            if (type < 0) {
                return -1;
            }
            long size = Wire.number(a.in);
            if (size < 0) {
                throw new Wire.Ended("sabr answer cut in a part's size");
            }
            if (type == Wire.MEDIA) {
                a.of = a.in.read();
                if (a.of < 0) {
                    throw new Wire.Ended("sabr answer cut in a media part");
                }
                a.left = size - 1;
                return Wire.MEDIA;
            }
            if (size > PART_MOST) {
                Wire.skip(a.in, size, scratch);
                return (int) type;
            }
            byte[] p = Wire.bytes(a.in, (int) size);
            switch ((int) type) {
                case Wire.MEDIA_HEADER:
                    a.header = new Wire.Header(p);
                    if (isVideo && !a.header.init && a.soundFormat == audio.format && a.header.itag == a.soundFormat.itag && a.header.length > 0
                            && a.sound == null && wanted(a.header.number)) {
                        a.soundHeader = a.header;
                        a.sound = new byte[(int) a.header.length];
                        a.soundAt = 0;
                    }
                    break;
                case Wire.MEDIA_END:
                    a.of = p.length > 0 ? p[0] & 0xff : -1;
                    if (a.sound != null && a.of == a.soundHeader.id) {
                        if (a.soundAt == a.sound.length) {
                            keep(a.soundFormat, a.soundHeader.number, a.sound);
                        }
                        a.sound = null;
                    }
                    break;
                case Wire.NEXT_REQUEST_POLICY:
                    Wire.Policy policy = new Wire.Policy(p);
                    a.backoffMs = policy.backoffMs;
                    if (policy.cookie != null) {
                        synchronized (Sabr.this) {
                            cookie = policy.cookie;
                        }
                    }
                    break;
                case Wire.STREAM_PROTECTION_STATUS:
                    a.protection = Wire.protection(p);
                    break;
                case Wire.SABR_REDIRECT:
                    String to = Wire.redirect(p);
                    if (!to.isEmpty()) {
                        // (for this session and, told to the page, for the video's next start)
                        synchronized (Sabr.this) {
                            url = moved = to;
                        }
                        a.redirected = true;
                    }
                    break;
                case Wire.SABR_ERROR:
                    a.error = Wire.error(p);
                    break;
                case Wire.RELOAD_PLAYER_RESPONSE:
                    a.reload = true;
                    a.reloadToken = Wire.reloadToken(p);
                    break;
                case Wire.SABR_CONTEXT_UPDATE:
                    Wire.Context context = new Wire.Context(p);
                    synchronized (Sabr.this) {
                        contexts.put(context.type, context.value);
                        if (context.byDefault) {
                            active.add(context.type);
                        }
                    }
                    break;
                case Wire.SABR_CONTEXT_SENDING_POLICY:
                    Wire.Sending sending = new Wire.Sending(p);
                    synchronized (Sabr.this) {
                        active.addAll(sending.start);
                        active.removeAll(sending.stop);
                        for (int gone : sending.discard) {
                            contexts.remove(gone);
                        }
                    }
                    break;
                default:
                    break;
            }
            return (int) type;
        }

        /** The answer is over: what it said beside its media (the page's answered) */
        private void finish(Answer a) throws IOException {
            answer = null;
            expect = 0;
            try {
                a.in.close();
            } catch (IOException e) {
                // (read to its end: nothing to lose)
            }
            if (!a.error.isEmpty()) {
                throw new Refused("sabr " + a.error, "the server's error");
            }
            // New streams wanted: the page fetches them as for expired addresses, its request with the server's token
            if (a.reload) {
                synchronized (Sabr.this) {
                    token = a.reloadToken;
                }
                throw new Refused("expired", "the server asks for the streams anew");
            }
            if (a.protection == 3) {
                throw new Refused("protection", "the server wants the device attested");
            }
            // Another address alone: asked there at once, a few times in a row at most. Nothing new otherwise
            // (attestation pending, or nothing the lane lacks): after a growing wait, a few times
            boolean redirected = a.redirected && a.taken == 0 && ++redirects <= REDIRECTS;
            if (a.taken > 0) {
                redirects = 0;
            }
            empty = a.taken > 0 || redirected ? 0 : empty + 1;
            if (empty > EMPTY_ANSWERS) {
                throw new Refused("sabr nothing came", empty + " answers with nothing new");
            }
            // (the wait from when its last segment was in: the answer's end is read only as the next one is wanted)
            waitUntil = redirected ? 0 : (a.taken > 0 ? a.takenAt : SystemClock.elapsedRealtime()) + Math.max(a.backoffMs, 1000L * empty);
        }

        /** The wait before segment k is asked for, by the page's rule for a track (its pump): what follows the run
         * held is asked for only once less than READAHEAD_US of the run lies ahead of the playhead (the server
         * answers one asked sooner with nothing, and after a few of those the video would be given up). Woken as
         * the playhead is told. The audio lane's segment as a video answer brought it meanwhile (null: none) */
        private byte[] waited() throws IOException {
            synchronized (Sabr.this) {
                Index x = index;
                while (!closed && !cut && x != null && last >= 0 && k == last + 1 && x.endUs(last) - playhead() * 1000 >= READAHEAD_US) {
                    waiting++;
                    try {
                        Sabr.this.wait();
                    } catch (InterruptedException e) {
                        throw new InterruptedIOException("sabr wait cut");
                    } finally {
                        waiting--;
                    }
                }
                if (closed || cut) {
                    throw new InterruptedIOException("sabr let go");
                }
                return isVideo || x == null ? null : takeSpare(k + 1, x.sizes[k]);
            }
        }

        /** A request for segment k on (-1: the format's init segment, then on from the playhead) */
        private void ask(int k) throws IOException {
            long wait = waitUntil - SystemClock.elapsedRealtime();
            if (wait > 0) {
                try {
                    Thread.sleep(wait);
                } catch (InterruptedException e) {
                    throw new InterruptedIOException("sabr wait cut");
                }
            }
            byte[] body;
            String to;
            Sent soundAsked;
            synchronized (Sabr.this) {
                soundAsked = audio.format;
                Wire.Ask ask = new Wire.Ask();
                ask.playerMs = playerMs(k);
                ask.tracks = isVideo ? 2 : 1;
                ask.video = id(video.format);
                ask.audio = id(audio.format);
                ask.height = video.format.height;
                ask.audioTrack = audio.format.track;
                ask.drc = audio.format.drc;
                for (Lane lane : new Lane[] { video, audio }) {
                    if (heads.containsKey(lane.format)) {
                        ask.initialized.add(id(lane.format));
                    }
                    Wire.Run run = lane.run();
                    if (run != null) {
                        ask.buffered.add(run);
                    }
                }
                ask.config = config;
                ask.hl = client.optString("hl");
                ask.make = client.optString("make");
                ask.model = client.optString("model");
                ask.version = client.optString("version");
                ask.osName = client.optString("osName");
                ask.osVersion = client.optString("osVersion");
                ask.cookie = cookie;
                for (Map.Entry<Integer, byte[]> context : contexts.entrySet()) {
                    if (active.contains(context.getKey())) {
                        ask.contextTypes.add(context.getKey());
                        ask.contextValues.add(context.getValue());
                    } else {
                        ask.unsent.add(context.getKey());
                    }
                }
                body = Wire.request(ask);
                // (on a network of the video's that has not failed lately)
                to = Net.on(url) + "&rn=" + (++rn);
            }
            long askedAt = SystemClock.elapsedRealtime();
            // (no answer, or no data, for Net.STALL_MS: a stall, as the page's own engine watches its requests)
            Net.Http http = Net.to(to, agent, false);
            opening = http;
            boolean answered = false;
            try {
                // (let go since it was looked at: an abort made meanwhile found no request)
                if (closed || cut) {
                    throw new InterruptedIOException("sabr let go");
                }
                // As the page's request from youtube.com's own page
                http.post(body);
                http.header("Origin", "https://www.youtube.com");
                http.header("Referer", "https://www.youtube.com/");
                int status = http.status();
                answered = true;
                if (status == 403) {
                    throw new Refused("expired", "sabr answer 403");
                }
                if (status < 200 || status >= 300) {
                    throw new IOException("sabr answer " + status);
                }
                Answer made = new Answer(http, new BufferedInputStream(http.body(), 16384), to);
                made.askedAt = askedAt;
                made.soundFormat = soundAsked;
                answer = made;
                expect = k < 0 ? 0 : k + 1;
            } catch (IOException e) {
                http.close();
                // (no answer: its network passed over, the request asked of the next at once where there is one)
                throw answered || closed || cut ? e : Net.failed(to, e, true);
            } catch (RuntimeException e) {
                http.close();
                throw e;
            } finally {
                opening = null;
            }
        }

        /** The time a request for segment k names (the session's lock held): the playhead where the lane goes on
         * from what the player holds (the server sends what follows the run told), else within that segment, so the
         * server begins with it */
        private long playerMs(int k) {
            long now = Math.max(0, playhead());
            Index x = index;
            if (k < 0 || x == null || last >= 0 && k == last + 1 && now * 1000 >= x.timesUs[first]) {
                return now;
            }
            long from = Sent.msAtOrAfter(x.timesUs[k]);
            return now >= from && now * 1000 < x.endUs(k) ? now : from;
        }

        /** What the player holds, as a request tells it (the session's lock held; null: nothing) */
        private Wire.Run run() {
            Index x = index;
            if (x == null || last < 0) {
                return null;
            }
            return new Wire.Run(id(format), x.timesUs[first] / 1000, (x.endUs(last) - x.timesUs[first]) / 1000, first + 1, last + 1);
        }
    }

}
