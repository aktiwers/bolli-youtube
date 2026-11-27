package org.bolli.youtube;

import androidx.media3.common.C;
import androidx.media3.common.Format;
import androidx.media3.exoplayer.analytics.PlayerId;
import androidx.media3.exoplayer.source.chunk.BundledChunkExtractor;
import androidx.media3.exoplayer.source.chunk.ChunkExtractor;
import androidx.media3.extractor.ChunkIndex;
import androidx.media3.extractor.ExtractorInput;
import androidx.media3.extractor.TrackOutput;

import java.io.IOException;
import java.util.List;

/** The player's own readers of a format's file, telling as the player takes a format's head: the video's index (its
 * segments start on keyframes, where the page lands its jumps: player/engine.ts jumpTarget), that the sound's
 * head is in, and each kind's index (a SABR session asks by it). */
final class Indexed implements ChunkExtractor.Factory {
    interface Heard {
        /** A format's index as its head is read (id: the format's, as Sent.id names it), before the two below */
        void index(boolean video, String id, ChunkIndex index);

        /** A video format's segment starts (us), on the thread that loaded the format's head */
        void starts(long[] timesUs);

        /** A sound format's head is in, on the thread that loaded it */
        void sound();
    }

    private final ChunkExtractor.Factory readers = new BundledChunkExtractor.Factory();
    private final Heard heard;

    Indexed(Heard heard) {
        this.heard = heard;
    }

    @Override
    public ChunkExtractor createProgressiveMediaExtractor(int type, Format format, boolean eventMessages, List<Format> captions,
            TrackOutput eventOutput, PlayerId player) {
        final ChunkExtractor reader = readers.createProgressiveMediaExtractor(type, format, eventMessages, captions, eventOutput, player);
        if (reader == null || type != C.TRACK_TYPE_VIDEO && type != C.TRACK_TYPE_AUDIO) {
            return reader;
        }
        return new ChunkExtractor() {
            private boolean told;

            @Override
            public ChunkIndex getChunkIndex() {
                ChunkIndex index = reader.getChunkIndex();
                if (index != null && !told) {
                    told = true;
                    heard.index(type == C.TRACK_TYPE_VIDEO, format.id, index);
                    if (type == C.TRACK_TYPE_VIDEO) {
                        heard.starts(index.timesUs);
                    } else {
                        heard.sound();
                    }
                }
                return index;
            }

            @Override
            public Format[] getSampleFormats() {
                return reader.getSampleFormats();
            }

            @Override
            public void init(TrackOutputProvider outputs, long startUs, long endUs) {
                reader.init(outputs, startUs, endUs);
            }

            @Override
            public void release() {
                reader.release();
            }

            @Override
            public boolean read(ExtractorInput input) throws IOException {
                return reader.read(input);
            }
        };
    }
}
