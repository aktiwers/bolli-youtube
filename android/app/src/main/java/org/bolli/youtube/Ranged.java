package org.bolli.youtube;

import android.net.Uri;
import android.os.SystemClock;

import androidx.media3.common.C;
import androidx.media3.datasource.BaseDataSource;
import androidx.media3.datasource.DataSpec;
import androidx.media3.datasource.HttpDataSource;

import java.io.IOException;

/** Reads a part of a format's file as YouTube's own players ask for it: in requests of a second or so of the format
 * each (Sent.piece: one long request is slowed down), the range as a parameter of the address. The player asks by the
 * format's own name (Sent.address); the address it has now is looked up at each request. A request that gets no data
 * for a while, or no answer, goes to another of the video's networks at once (Net). */
final class Ranged extends BaseDataSource {
    /** The formats loaded, and who hears of a video request done */
    interface Table {
        /** The format of this name (null: none loaded) */
        Sent of(Uri address);

        void loaded(long bytes, long ms);
    }

    private final HttpDataSource http;
    private final Table table;
    private Uri address;
    private Sent format;
    /** The address the request on its way went to */
    private String asked;
    /** The next byte to give, and where the part asked for ends */
    private long position;
    private long end;
    /** The request on its way: its bytes, those it has still to give (0: none open) and since when */
    private long size;
    private long left;
    private long since;
    private boolean started;

    Ranged(HttpDataSource http, Table table) {
        super(true);
        this.http = http;
        this.table = table;
    }

    @Override
    public long open(DataSpec spec) throws IOException {
        address = spec.uri;
        format = table.of(spec.uri);
        if (format == null) {
            throw new IOException("no format " + spec.uri);
        }
        position = spec.position;
        long length = spec.length != C.LENGTH_UNSET ? spec.length : format.length - spec.position;
        end = position + length;
        transferInitializing(spec);
        if (length > 0) {
            ask();
        }
        started = true;
        transferStarted(spec);
        return length;
    }

    /** The next request: from the position on, a piece at most, on a network of the video's that has not failed
     * lately (Net.on) */
    private void ask() throws IOException {
        size = Math.min(end - position, format.piece());
        // (timed from when it is sent, its answer's wait included: as the page's engines time theirs)
        since = SystemClock.elapsedRealtime();
        for (;;) {
            asked = Net.on(format.url);
            try {
                http.open(new DataSpec.Builder().setUri(asked + "&range=" + position + '-' + (position + size - 1)).build());
                break;
            } catch (IOException e) {
                // (its network passed over: asked of the next at once, here, which is no failure of the load's)
                IOException told = Net.failed(asked, e, true);
                if (!(told instanceof Net.Moved)) {
                    throw told;
                }
            }
        }
        left = size;
    }

    @Override
    public int read(byte[] buffer, int offset, int length) throws IOException {
        if (length == 0) {
            return 0;
        }
        if (position >= end) {
            return C.RESULT_END_OF_INPUT;
        }
        if (left == 0) {
            ask();
        }
        int read;
        try {
            read = http.read(buffer, offset, (int) Math.min(length, left));
        } catch (IOException e) {
            IOException told = Net.failed(asked, e, true);
            if (!(told instanceof Net.Moved)) {
                throw told;
            }
            // (a stall: the rest of the piece asked of the next network at once)
            http.close();
            left = 0;
            ask();
            return read(buffer, offset, length);
        }
        if (read == C.RESULT_END_OF_INPUT) {
            throw new IOException("answer " + left + " bytes short");
        }
        position += read;
        left -= read;
        bytesTransferred(read);
        // (read to its end: the connection is kept for the next request)
        if (left == 0) {
            http.close();
            if (format.video) {
                table.loaded(size, SystemClock.elapsedRealtime() - since);
            }
        }
        return read;
    }

    @Override
    public Uri getUri() {
        return address;
    }

    @Override
    public void close() throws IOException {
        try {
            if (left > 0) {
                left = 0;
                http.close();
            }
        } finally {
            if (started) {
                started = false;
                transferEnded();
            }
        }
    }
}
