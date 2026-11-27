package org.bolli.youtube;

import android.net.Uri;

import androidx.media3.common.C;
import androidx.media3.datasource.BaseDataSource;
import androidx.media3.datasource.DataSpec;

import java.io.IOException;

/** Reads a part of a format's file from its SABR session (Sabr), where Ranged reads a guest's from its address. The
 * player asks for two things, each by the format's own name and the file's bytes: the head (its init part and index,
 * which is the format's init segment) and one index entry's bytes (that segment's media). */
final class SabrSource extends BaseDataSource {
    private final Sabr session;
    private final Ranged.Table table;
    private Uri address;
    private Sabr.Lane lane;
    /** The head, where that is asked for: from where it gives next, and where what was asked ends */
    private byte[] head;
    private int at;
    private int end;
    private boolean started;
    /** Its load is one of the session's on their way */
    private boolean counted;

    SabrSource(Sabr session, Ranged.Table table) {
        super(true);
        this.session = session;
        this.table = table;
    }

    @Override
    public long open(DataSpec spec) throws IOException {
        address = spec.uri;
        Sent format = table.of(spec.uri);
        if (format == null) {
            throw new IOException("no format " + spec.uri);
        }
        lane = session.lane(format.video);
        session.loading(true);
        counted = true;
        transferInitializing(spec);
        long length;
        if (spec.position <= format.indexEnd) {
            byte[] whole = lane.head(format);
            long to = spec.length != C.LENGTH_UNSET ? spec.position + spec.length : whole.length;
            if (to > whole.length) {
                // (not the file's head: the player's own, which reads the page's streams as files, cannot play it)
                throw new Sabr.Refused("player", "sabr init of " + format.itag + " is " + whole.length + " B, the head asked to " + to);
            }
            head = whole;
            at = (int) spec.position;
            end = (int) to;
            length = end - at;
        } else {
            head = null;
            long left = lane.open(format, spec.position);
            length = left >= 0 ? left : spec.length;
        }
        started = true;
        transferStarted(spec);
        return length;
    }

    @Override
    public int read(byte[] buffer, int offset, int length) throws IOException {
        if (length == 0) {
            return 0;
        }
        int read;
        if (head != null) {
            read = Math.min(length, end - at);
            if (read <= 0) {
                return C.RESULT_END_OF_INPUT;
            }
            System.arraycopy(head, at, buffer, offset, read);
            at += read;
        } else {
            read = lane.read(buffer, offset, length);
            if (read < 0) {
                return C.RESULT_END_OF_INPUT;
            }
        }
        bytesTransferred(read);
        return read;
    }

    @Override
    public Uri getUri() {
        return address;
    }

    @Override
    public void close() {
        if (lane != null && head == null) {
            lane.release();
        }
        head = null;
        if (counted) {
            counted = false;
            session.loading(false);
        }
        if (started) {
            started = false;
            transferEnded();
        }
    }
}
