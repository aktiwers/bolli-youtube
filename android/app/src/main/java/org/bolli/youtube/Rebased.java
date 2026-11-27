package org.bolli.youtube;

import androidx.media3.common.C;
import androidx.media3.common.DataReader;
import androidx.media3.common.Format;
import androidx.media3.common.util.ParsableByteArray;
import androidx.media3.exoplayer.analytics.PlayerId;
import androidx.media3.exoplayer.source.chunk.BundledChunkExtractor;
import androidx.media3.exoplayer.source.chunk.ChunkExtractor;
import androidx.media3.extractor.ChunkIndex;
import androidx.media3.extractor.ExtractorInput;
import androidx.media3.extractor.TrackOutput;

import java.io.IOException;
import java.util.List;

/** The player's readers for a live stream's segments. Each segment is a file of its own, its head with it: read by a
 * reader of its own (one reader for them all would have to take a file's head again and again). And its samples'
 * times, which run from the stream's start, are put on the player's scale (Numbered.shift, asked once a segment),
 * as the page's engine shifts them for its buffers. */
final class Rebased implements ChunkExtractor.Factory {
    private final ChunkExtractor.Factory readers = new BundledChunkExtractor.Factory();
    private final Numbered index;

    Rebased(Numbered index) {
        this.index = index;
    }

    @Override
    public ChunkExtractor createProgressiveMediaExtractor(int type, Format format, boolean eventMessages, List<Format> captions,
            TrackOutput eventOutput, PlayerId player) {
        if (type != C.TRACK_TYPE_VIDEO && type != C.TRACK_TYPE_AUDIO) {
            return readers.createProgressiveMediaExtractor(type, format, eventMessages, captions, eventOutput, player);
        }
        final boolean video = type == C.TRACK_TYPE_VIDEO;
        return new ChunkExtractor() {
            /** The reader of the segment being read, and the formats the last one found */
            private ChunkExtractor reader;
            private Format[] formats;
            /** No sample of the segment being read has come yet; what its samples' times are shifted by (us), and
             * the last of them on the player's scale */
            private boolean first;
            private long shift;
            private long last;

            @Override
            public ChunkIndex getChunkIndex() {
                return null;
            }

            @Override
            public Format[] getSampleFormats() {
                return formats;
            }

            @Override
            public void init(TrackOutputProvider outputs, long startUs, long endUs) {
                release();
                reader = readers.createProgressiveMediaExtractor(type, format, eventMessages, captions, eventOutput, player);
                first = true;
                // (whole, from its first sample: the times it is asked to start at are the player's, not its own)
                reader.init(outputs == null ? null : (id, kind) -> shifted(outputs.track(id, kind)), C.TIME_UNSET, C.TIME_UNSET);
            }

            private TrackOutput shifted(TrackOutput output) {
                return new TrackOutput() {
                    @Override
                    public void durationUs(long durationUs) {
                        output.durationUs(durationUs);
                    }

                    @Override
                    public void format(Format found) {
                        output.format(found);
                    }

                    @Override
                    public int sampleData(DataReader input, int length, boolean allowEnd, int part) throws IOException {
                        return output.sampleData(input, length, allowEnd, part);
                    }

                    @Override
                    public void sampleData(ParsableByteArray data, int length, int part) {
                        output.sampleData(data, length, part);
                    }

                    @Override
                    public void sampleMetadata(long timeUs, int flags, int size, int offset, CryptoData crypto) {
                        if (first) {
                            first = false;
                            shift = index.shift(timeUs, video);
                        }
                        last = timeUs - shift;
                        output.sampleMetadata(last, flags, size, offset, crypto);
                    }
                };
            }

            @Override
            public void release() {
                if (reader != null) {
                    reader.release();
                    reader = null;
                }
            }

            @Override
            public boolean read(ExtractorInput input) throws IOException {
                boolean more = reader.read(input);
                Format[] found = reader.getSampleFormats();
                if (found != null) {
                    formats = found;
                }
                // (all read: how far the kind's samples reach now)
                if (!more && !first) {
                    index.reaches(video, last);
                }
                return more;
            }
        };
    }
}
