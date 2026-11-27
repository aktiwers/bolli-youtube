package org.bolli.youtube;

import android.os.SystemClock;

import androidx.media3.common.C;
import androidx.media3.common.Format;
import androidx.media3.exoplayer.dash.DashSegmentIndex;
import androidx.media3.exoplayer.dash.manifest.BaseUrl;
import androidx.media3.exoplayer.dash.manifest.RangedUri;
import androidx.media3.exoplayer.dash.manifest.Representation;
import androidx.media3.exoplayer.dash.manifest.SegmentBase;
import androidx.media3.exoplayer.dash.manifest.UrlTemplate;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/** A live stream's segments as the player's index of them (the page's own engine: src/youtube/player/live-engine.ts,
 * whose rules these are). YouTube serves a live stream as numbered segments of about the same length, each a file of
 * its own with its head; one not made yet is answered when it is, and every answer names the latest (the head). So
 * the index moves with the head: the player is told the segments up to the one to come (its request waits at
 * YouTube, which paces the loading). A stream that has ended is told up to its head, where the player's loading
 * ends; one that ends while it plays keeps the one to come in the index, and the request for it is answered as a
 * last segment that is missing, which ends the loading there (the player then loads up to the head again after a
 * jump back).
 * The player counts the segments from its own start: the one a start plays (START_BEHIND behind the head) is its
 * number `base`, and lies at that many segment lengths of its own time, past the stream's window, so the oldest
 * segment still lies after 0 (the segments' own times run from the stream's start: days). A segment's time is its
 * video's first sample's as it came (they run a few ms long), else reckoned from the nearest that came.
 * The player is told a day's length (it takes a stream with no length as over at once) and so ends none by itself:
 * a stream that has ended is played out once the picture is at its last sample (playedUs).
 * One for a load, shared by both kinds and read on their loading threads, the player's and the app's: its state is
 * its own lock's. */
final class Numbered {
    /** A start plays this many segments behind the head (YouTube's own players stay about there) */
    private static final int START_BEHIND = 3;
    /** Loaded up to this far ahead of the picture (us; the page's AHEAD_S) */
    static final long AHEAD_US = 15000000;
    private static final long DAY_MS = 86400000;
    /** A segment to come that has not come after this many segments' time, and at least this long (s): the stream may
     * have ended (told to the page, which asks YouTube) */
    private static final int STANDS_SEGMENTS = 3;
    private static final int STANDS_MIN_S = 12;
    /** A stream that has ended is played out this long after its last sample's time (us: that sample's own length) */
    private static final long LAST_US = 100000;

    private final long lengthUs;
    private final long dvrUs;
    /** The stream had ended when it was loaded; it has ended (then, or while it played); the video is let go */
    private final boolean wasOver;
    private boolean over;
    private boolean closed;
    /** The player's number of the segment a start plays */
    private final int base;
    /** The stream's number of that segment (-1: the head is not heard yet), and the head's */
    private int first = -1;
    private int head = -1;
    /** The video segments that came: the player's number of each and its start on the player's scale (us) */
    private final TreeMap<Integer, Long> starts = new TreeMap<>();
    /** What a segment's own times are ahead of the player's (us), once a first sample has come */
    private long shiftUs;
    private boolean shifted;
    /** Each kind's (audio, video) segment asked for or to ask for next, by the stream's number, the player's number
     * of the one it reads, and how far its samples that came reach (us, the player's scale) */
    private final int[] next = { -1, -1 };
    private final int[] reading = { -1, -1 };
    private final long[] reached = { 0, 0 };
    /** Since when a segment to come is waited for with none come meanwhile (elapsed ms; 0: none is) */
    private long waitingSince;
    /** The requests on their way (each: how to cut it from another thread) and the stream's number each asks for */
    private final Map<Runnable, Integer> asking = new HashMap<>();
    /** One at a time asks for the head */
    final Object probing = new Object();

    Numbered(double segmentS, double dvrS, boolean over) {
        lengthUs = Math.max(1, Math.round(segmentS * 1000000));
        dvrUs = Math.round(dvrS * 1000000);
        wasOver = this.over = over;
        // (past the stream's window, as the page's base)
        base = (int) ((Math.max(dvrUs, 3600000000L) + 60000000 + lengthUs - 1) / lengthUs);
    }

    /** Where a start plays (us) */
    long startUs() {
        return base * lengthUs;
    }

    /** The length the player is told (ms): a day of playing on past the start */
    long lengthMs() {
        return startUs() / 1000 + DAY_MS;
    }

    synchronized boolean probed() {
        return first >= 0;
    }

    /** The head as an answer names it (-1: it names none). The first sets where the start plays */
    synchronized void heard(int latest) {
        if (latest < 0) {
            return;
        }
        if (first < 0) {
            first = over ? firstPlayed(latest) : Math.max(0, latest - START_BEHIND);
            head = latest;
        } else if (latest > head && !over) {
            head = latest;
            // (it moved: the stream goes on)
            waitingSince = 0;
        }
    }

    /** The window's first segment that is played (not the oldest itself: it may be gone by the time it is asked
     * for), never before the stream's first */
    private int firstPlayed(int head) {
        return Math.max(0, head - (int) (dvrUs / lengthUs) + 2);
    }

    /** The stream's number of the player's segment m */
    synchronized int sq(long m) {
        return first + (int) (m - base);
    }

    private int headM() {
        // (until the head is heard: as a start will have it)
        return first < 0 ? base + START_BEHIND : base + head - first;
    }

    /** How many segments the player is told: up to the one to come; of a stream that had ended at its load up to
     * its head */
    private synchronized long count() {
        return headM() + (wasOver ? 1 : 2);
    }

    /** The start of the player's segment m (us): as it came, else reckoned from the nearest that came: on from one
     * before it by the segments' nominal length (as the page's engine reckons the head), back from the earliest by
     * their real one (the mean of those that came: the nominal one, a few ms short, would land a far jump back
     * seconds into its segment or past it) */
    private synchronized long timeUs(long m) {
        Map.Entry<Integer, Long> near = starts.floorEntry((int) m);
        if (near != null) {
            return near.getValue() + (m - near.getKey()) * lengthUs;
        }
        if (starts.isEmpty()) {
            return m * lengthUs;
        }
        Map.Entry<Integer, Long> earliest = starts.firstEntry();
        Map.Entry<Integer, Long> latest = starts.lastEntry();
        long step = latest.getKey() > earliest.getKey() ? (latest.getValue() - earliest.getValue()) / (latest.getKey() - earliest.getKey()) : lengthUs;
        return Math.max(0, earliest.getValue() - (earliest.getKey() - m) * step);
    }

    /** The player's segment the time us lies in */
    private synchronized long numAt(long us) {
        long m = Math.max(0, us / lengthUs);
        while (timeUs(m + 1) <= us) {
            m++;
        }
        while (m > 0 && timeUs(m) > us) {
            m--;
        }
        return m;
    }

    /** Where a jump to us lands: the start of the segment it lies in, within the window and up to the head */
    synchronized long landUs(long us) {
        long m = Math.min(headM(), Math.max(numAt(us), first < 0 ? 0 : base + firstPlayed(head) - first));
        return timeUs(m);
    }

    /** A kind reads the player's segment m from here on (on its loading thread) */
    synchronized void opens(boolean video, long m) {
        reading[video ? 1 : 0] = (int) m;
        int sq = sq(m);
        next[video ? 1 : 0] = sq;
        if (sq > head && !over && waitingSince == 0) {
            waitingSince = SystemClock.elapsedRealtime();
        }
    }

    /** The segment a kind read is all in */
    synchronized void came(boolean video, long m) {
        int sq = sq(m);
        next[video ? 1 : 0] = sq + 1;
        if (sq > head) {
            waitingSince = 0;
        }
    }

    /** What the samples' own times are ahead of the player's (us), asked with the first sample (its own time) of
     * the segment a kind reads. The first of all sets it (the two kinds' times stay as they are to each other); a
     * video segment's first sample is that segment's start */
    synchronized long shift(long ownUs, boolean video) {
        int m = reading[video ? 1 : 0];
        if (!shifted) {
            shifted = true;
            shiftUs = ownUs - timeUs(m);
        }
        if (video) {
            starts.put(m, ownUs - shiftUs);
            // (out of the window: forgotten)
            starts.headMap(m - (int) (dvrUs / lengthUs) - 2).clear();
        }
        return shiftUs;
    }

    /** A kind's samples that came reach to us (the player's scale): told as a segment of it is all read */
    synchronized void reaches(boolean video, long us) {
        reached[video ? 1 : 0] = Math.max(reached[video ? 1 : 0], us);
    }

    /** The head's time on the player's scale (us; 0: not known yet) */
    synchronized long edgeUs() {
        return starts.isEmpty() ? 0 : starts.lastEntry().getValue() + (headM() - starts.lastKey() + 1) * lengthUs;
    }

    /** Whether both kinds have asked for all there is, up to the head: what fails then is a segment to come
     * (the lock held) */
    private boolean atHead() {
        return head >= 0 && next[0] > head && next[1] > head;
    }

    /** Where a stream that has ended is played out (us, the player's scale; -1: it has not ended, or not all of it
     * is in): a little past its last sample */
    synchronized long playedUs() {
        return over && atHead() ? Math.max(reached[0], reached[1]) + LAST_US : -1;
    }

    /** Whether the stream's segment sq is past the head of a stream that has ended: none comes */
    synchronized boolean past(int sq) {
        return over && first >= 0 && sq > head;
    }

    /** Whether the stream's segment sq is made already (one to come waits at YouTube until it is) */
    synchronized boolean made(int sq) {
        return sq <= head;
    }

    /** The stream's part of the player's report (native.ts: Report): its window's start and its head on the player's
     * scale (s), whether all there is has been asked for and whether it has ended; and, once and again after as
     * long, that a segment to come has not come for several segments' time (asked each second while the player
     * loads) */
    synchronized void report(StringBuilder s) {
        long edge = edgeUs();
        long from = Math.max(0, edge - dvrUs);
        // (of a stream that has ended: not before its first segment)
        long oldest = over && first >= 0 ? Math.max(from, edge - (head - firstPlayed(head) + 1) * lengthUs) : from;
        s.append(",live:[").append(oldest / 1000000.0).append(',').append(edge / 1000000.0).append(',').append(atHead() ? 1 : 0).append(',')
                .append(over ? 1 : 0).append(']');
        long now = SystemClock.elapsedRealtime();
        if (!over && waitingSince != 0 && now - waitingSince >= Math.max(STANDS_SEGMENTS * lengthUs / 1000, STANDS_MIN_S * 1000L)) {
            waitingSince = now;
            s.append(",stands:1");
        }
    }

    /** A request for the stream's segment sq is on its way (cut: ends it from another thread), or is over (sq -1).
     * False: the video is let go, nothing is asked any more */
    synchronized boolean asks(Runnable cut, int sq) {
        if (sq >= 0 && !closed) {
            asking.put(cut, sq);
        } else {
            asking.remove(cut);
        }
        return !closed;
    }

    synchronized boolean gone() {
        return closed;
    }

    /** The requests for a segment to come are cut: a jump out of what is loaded (the player has let their loads go,
     * and would else wait for YouTube's answer before it asks at the new place), or the stream's end */
    void cut() {
        List<Runnable> waiting = new ArrayList<>();
        synchronized (this) {
            waitingSince = 0;
            for (Map.Entry<Runnable, Integer> request : asking.entrySet()) {
                if (closed || request.getValue() > head) {
                    waiting.add(request.getKey());
                }
            }
        }
        for (Runnable request : waiting) {
            request.run();
        }
    }

    /** The stream has ended while it played (the page asked YouTube): none comes past its head, and the player
     * plays out what it has. Or the video is let go (ended false): every request is cut, none made any more */
    void end(boolean ended) {
        synchronized (this) {
            over = over || ended;
            closed = closed || !ended;
        }
        cut();
    }

    /** A format as the player takes it: its segments are this index's, each asked for by the format's own name and
     * the player's number (Segments) */
    Representation representation(Format format, Sent sent) {
        return new Moving(format, sent);
    }

    private final class Moving extends Representation.MultiSegmentRepresentation {
        private final Sent sent;

        Moving(Format format, Sent sent) {
            // (a segment base it never asks: every answer is this index's)
            super(0, format, Collections.singletonList(new BaseUrl(sent.address())), new SegmentBase.SegmentTemplate(null, 1, 0, 0, C.INDEX_UNSET, 1,
                    null, 0, null, UrlTemplate.compile("x"), 0, 0), null, Collections.emptyList(), Collections.emptyList());
            this.sent = sent;
        }

        @Override
        public RangedUri getIndexUri() {
            return null;
        }

        @Override
        public DashSegmentIndex getIndex() {
            return this;
        }

        @Override
        public String getCacheKey() {
            return null;
        }

        @Override
        public RangedUri getSegmentUrl(long m) {
            return new RangedUri(sent.address(m), 0, C.LENGTH_UNSET);
        }

        @Override
        public long getSegmentNum(long timeUs, long periodUs) {
            return Math.min(numAt(timeUs), count() - 1);
        }

        @Override
        public long getTimeUs(long m) {
            return timeUs(m);
        }

        @Override
        public long getDurationUs(long m, long periodUs) {
            return timeUs(m + 1) - timeUs(m);
        }

        @Override
        public long getFirstSegmentNum() {
            return 0;
        }

        @Override
        public long getFirstAvailableSegmentNum(long periodUs, long nowUs) {
            return 0;
        }

        @Override
        public long getSegmentCount(long periodUs) {
            return count();
        }

        @Override
        public long getAvailableSegmentCount(long periodUs, long nowUs) {
            return count();
        }

        @Override
        public long getNextSegmentAvailableTimeUs(long periodUs, long nowUs) {
            return C.TIME_UNSET;
        }

        @Override
        public boolean isExplicit() {
            return true;
        }
    }
}
