package org.bolli.youtube;

import androidx.media3.common.C;
import androidx.media3.exoplayer.DefaultLoadControl;
import androidx.media3.exoplayer.analytics.PlayerId;
import androidx.media3.exoplayer.upstream.DefaultAllocator;

/** How much the player loads, as the page's own engines do (player/engine.ts, dash.ts): up to AHEAD_MS ahead of the
 * picture while it holds no more than MOST_BYTES in all, and in any case ALWAYS_MS ahead, so a dense part of a video
 * plays on; behind the picture BEHIND_MS for a jump back, but no more than BEHIND_BYTES of it (the media is held in
 * the app's own memory: a 4K video's 20 s would be most of it; MOST_BYTES is at most a third of what the device lets
 * the app have, and what is behind the picture at most a quarter of that: KEPT_BEHIND). The picture starts with
 * START_MS of media in, and RESTART_MS after it ran dry. */
final class Loading extends DefaultLoadControl {
    private static final int AHEAD_MS = 30000;
    private static final int ALWAYS_MS = 6000;
    private static final int BEHIND_MS = 20000;
    private static final long BEHIND_BYTES = 16 * 1024 * 1024;
    private static final int MOST_BYTES = (int) Math.min(64 * 1024 * 1024, Runtime.getRuntime().maxMemory() / 3);
    private static final long KEPT_BEHIND = Math.min(BEHIND_BYTES, MOST_BYTES / 4);
    private static final int START_MS = 250;
    private static final int RESTART_MS = 1000;

    /** The playing formats' bits a second (0: not known) */
    volatile int bitrate;
    /** At most this far ahead (us; 0: AHEAD_MS): a video loaded before its start, which needs only what plays first */
    volatile long holdUs;
    /** Nothing more is asked for a moment: a start is being put on its keyframe (NativeVideo), and what would be
     * asked meanwhile would be asked again from there. Set by the thread that read the index, let go by the
     * player's own once the seek has run there */
    volatile boolean held;
    /** At most this far ahead where the memory allows (us; 0: AHEAD_MS): a video by SABR, whose server answers a
     * request for more than it means to send ahead with nothing (Sabr.READAHEAD_US) */
    volatile long mostUs;

    Loading() {
        super(new DefaultAllocator(true, C.DEFAULT_BUFFER_SEGMENT_SIZE), AHEAD_MS, AHEAD_MS, START_MS, RESTART_MS, MOST_BYTES, false,
                BEHIND_MS, true);
    }

    /** How much is kept behind the picture (us) */
    long behindUs() {
        int rate = bitrate;
        return rate > 0 ? Math.min(BEHIND_MS * 1000L, KEPT_BEHIND * 8 * 1000000 / rate) : BEHIND_MS * 1000L;
    }

    @Override
    public long getBackBufferDurationUs(PlayerId player) {
        return behindUs();
    }

    @Override
    public boolean shouldContinueLoading(Parameters parameters) {
        long ahead = parameters.bufferedDurationUs;
        long hold = holdUs;
        long most = mostUs > 0 ? mostUs : AHEAD_MS * 1000L;
        return !held && (hold <= 0 || ahead < hold) && (ahead < ALWAYS_MS * 1000L || ahead < most && getAllocator().getTotalBytesAllocated() < MOST_BYTES);
    }
}
