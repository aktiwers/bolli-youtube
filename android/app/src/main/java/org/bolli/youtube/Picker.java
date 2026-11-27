package org.bolli.youtube;

import android.util.Pair;

import androidx.media3.common.C;
import androidx.media3.common.Format;
import androidx.media3.common.Timeline;
import androidx.media3.common.TrackGroup;
import androidx.media3.exoplayer.RendererCapabilities;
import androidx.media3.exoplayer.RendererConfiguration;
import androidx.media3.exoplayer.source.MediaSource.MediaPeriodId;
import androidx.media3.exoplayer.source.TrackGroupArray;
import androidx.media3.exoplayer.source.chunk.MediaChunk;
import androidx.media3.exoplayer.source.chunk.MediaChunkIterator;
import androidx.media3.exoplayer.trackselection.BaseTrackSelection;
import androidx.media3.exoplayer.trackselection.ExoTrackSelection;
import androidx.media3.exoplayer.trackselection.MappingTrackSelector;

import java.util.Arrays;
import java.util.List;

/** The page picks what plays: of a video's formats (each a track: Sent.id) the one it names, a switch taken in place.
 * The player loads on in the format wanted when it next asks, so a switch shows where what is loaded ends; one asked
 * nearer has what is loaded past that point let go and loaded again in the new format (as the player's own adaptive
 * choice replaces what it loaded: no stop, the decoder kept). */
final class Picker extends MappingTrackSelector {
    /** A kind's wish: the format wanted, and how far past the picture what is loaded in another is let go (us; -1:
     * nothing let go). Set by the app's thread, read by the player's */
    static final class Wish {
        volatile String id = "";
        volatile long aheadUs = -1;
        /** The formats the player chooses among now (those the device plays, and the one wanted when it chose) */
        volatile List<String> among = Arrays.asList();
    }

    final Wish video = new Wish();
    final Wish audio = new Wish();

    /** A wish's format was set: one the player does not choose among (the device is not known to play it) has it
     * choose anew, with that one in (its stream of that kind made again: a stand, where a format among them is taken
     * with none) */
    void taken(Wish wish) {
        if (!wish.among.contains(wish.id)) {
            invalidate();
        }
    }

    @Override
    protected Pair<RendererConfiguration[], ExoTrackSelection[]> selectTracks(MappedTrackInfo info, int[][][] supports, int[] mixed,
            MediaPeriodId period, Timeline timeline) {
        int count = info.getRendererCount();
        RendererConfiguration[] configurations = new RendererConfiguration[count];
        ExoTrackSelection[] selections = new ExoTrackSelection[count];
        for (int i = 0; i < count; i++) {
            int type = info.getRendererType(i);
            TrackGroupArray groups = info.getTrackGroups(i);
            // (a video has one group of each kind, which one renderer gets)
            if (groups.length == 0 || type != C.TRACK_TYPE_VIDEO && type != C.TRACK_TYPE_AUDIO) {
                continue;
            }
            Wish wish = type == C.TRACK_TYPE_VIDEO ? video : audio;
            TrackGroup group = groups.get(0);
            int[] tracks = playable(group, supports[i][0], wish.id);
            String[] ids = new String[tracks.length];
            for (int t = 0; t < tracks.length; t++) {
                ids[t] = group.getFormat(tracks[t]).id;
            }
            wish.among = Arrays.asList(ids);
            selections[i] = new Chosen(group, tracks, wish);
            configurations[i] = RendererConfiguration.DEFAULT;
        }
        return Pair.create(configurations, selections);
    }

    /** The group's tracks the device plays (the decoder is set up for the largest of them), and the wanted one in any
     * case */
    private static int[] playable(TrackGroup group, int[] supports, String wanted) {
        int[] tracks = new int[group.length];
        int count = 0;
        for (int i = 0; i < group.length; i++) {
            if (RendererCapabilities.getFormatSupport(supports[i]) == C.FORMAT_HANDLED || wanted.equals(group.getFormat(i).id)) {
                tracks[count++] = i;
            }
        }
        // (none: the first, which fails as a format the device does not play)
        if (count == 0) {
            tracks[count++] = 0;
        }
        return Arrays.copyOf(tracks, count);
    }

    /** A kind's tracks with the wanted one selected */
    private static final class Chosen extends BaseTrackSelection {
        private final Wish wish;
        private int selected;

        Chosen(TrackGroup group, int[] tracks, Wish wish) {
            super(group, tracks);
            this.wish = wish;
            selected = wanted();
        }

        /** The wanted track's place among these (the one selected, where it is none of them) */
        private int wanted() {
            String id = wish.id;
            for (int i = 0; i < length; i++) {
                if (id.equals(getFormat(i).id)) {
                    return i;
                }
            }
            return selected;
        }

        @Override
        public void updateSelectedTrack(long positionUs, long bufferedUs, long availableUs, List<? extends MediaChunk> queue,
                MediaChunkIterator[] iterators) {
            selected = wanted();
        }

        /** What is loaded from the switch's point on in another format than the wanted one is let go (once) */
        @Override
        public int evaluateQueueSize(long positionUs, List<? extends MediaChunk> queue) {
            long ahead = wish.aheadUs;
            if (ahead < 0) {
                return queue.size();
            }
            wish.aheadUs = -1;
            Format format = getFormat(wanted());
            for (int i = 0; i < queue.size(); i++) {
                MediaChunk chunk = queue.get(i);
                if (chunk.startTimeUs >= positionUs + ahead && !format.equals(chunk.trackFormat)) {
                    return i;
                }
            }
            return queue.size();
        }

        @Override
        public int getSelectedIndex() {
            return selected;
        }

        @Override
        public int getSelectionReason() {
            return C.SELECTION_REASON_MANUAL;
        }

        @Override
        public Object getSelectionData() {
            return null;
        }
    }
}
