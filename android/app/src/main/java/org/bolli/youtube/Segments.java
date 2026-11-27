package org.bolli.youtube;

import android.net.Uri;

import androidx.media3.common.C;
import androidx.media3.datasource.BaseDataSource;
import androidx.media3.datasource.DataSpec;
import androidx.media3.datasource.HttpDataSource;

import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.InterruptedIOException;
import java.util.Collections;

/** Reads a live stream's segment (Numbered), where Ranged reads a part of a video's file: the player asks by the
 * format's own name and its own number of the segment; the address the format has now is looked up at each request,
 * the segment asked whole by its number in the stream (sq). Every answer names the stream's head. The first request
 * of a load asks for the head first: the latest segment of the audio format, asked without a number (small; as the
 * page's engine does). A request for the segment to come waits at YouTube until it is made. An answer without
 * data is no segment (the page's rule), and a segment that came says the head is at least there. */
final class Segments extends BaseDataSource {
    private final String agent;
    private final Numbered index;
    private final Ranged.Table table;
    private Uri address;
    private boolean video;
    private long m;
    private int sq;
    private volatile Net.Http http;
    private InputStream in;
    /** Its segment is asked for and not all in, and whether any of it has come */
    private boolean asking;
    private boolean any;
    private boolean started;
    private final byte[] scratch = new byte[8192];
    /** Let go from another thread (a jump, the stream's end, the stop): its failure is no network's */
    private volatile boolean wasCut;
    private final Runnable cut = () -> {
        wasCut = true;
        Net.cut(http, false);
    };
    /** The address the request on its way went to, and whether what it asks was made already when it was asked
     * (else it waits at YouTube until it is: its silence no network's failing) */
    private String asked;
    private boolean exists;

    Segments(String agent, Numbered index, Ranged.Table table) {
        super(true);
        this.agent = agent;
        this.index = index;
        this.table = table;
    }

    @Override
    public long open(DataSpec spec) throws IOException {
        address = spec.uri;
        Sent format = table.of(spec.uri);
        if (format == null) {
            throw new IOException("no format " + spec.uri);
        }
        video = format.video;
        m = Sent.segmentOf(spec.uri);
        any = false;
        wasCut = false;
        transferInitializing(spec);
        // The head, once a load: where its start plays
        synchronized (index.probing) {
            if (!index.probed()) {
                Sent audio = table.of(Uri.parse(Sent.address(false, 0)));
                exists = true;
                Net.Http probe = ask((audio != null ? audio : format).url, spec);
                try {
                    int head = probe.headerInt("X-Head-Seqnum", -1);
                    // (read out: the connection is kept for the segments. The latest segment itself is not played:
                    // a start plays behind it)
                    InputStream body = probe.body();
                    try {
                        while (body.read(scratch) >= 0) {
                            any = true;
                        }
                    } catch (IOException e) {
                        throw lost(e);
                    }
                    body.close();
                    if (head < 0 || !any) {
                        throw new IOException("live: no head told");
                    }
                    index.heard(head);
                    any = false;
                } catch (IOException | RuntimeException e) {
                    probe.close();
                    throw e;
                }
            }
        }
        index.opens(video, m);
        sq = index.sq(m);
        // (of a stream that has ended, past its head: none comes; said as the player takes a last segment that is
        // missing, which ends the stream for it)
        if (index.past(sq)) {
            throw gone(spec);
        }
        asking = true;
        try {
            if (!index.asks(cut, sq)) {
                throw new InterruptedIOException("live: let go");
            }
            exists = index.made(sq);
            Net.Http made = ask(format.url + "&sq=" + sq, spec);
            index.heard(made.headerInt("X-Head-Seqnum", -1));
            in = made.body();
            // (a load taken up again after a failure: the segment comes whole again, what was read of it is read past)
            for (long skip = spec.position; skip > 0;) {
                int read;
                try {
                    read = in.read(scratch, 0, (int) Math.min(skip, scratch.length));
                } catch (IOException e) {
                    throw lost(e);
                }
                if (read < 0) {
                    throw new EOFException("live: segment shorter than what was read of it");
                }
                given();
                skip -= read;
            }
        } catch (IOException e) {
            close();
            throw index.past(sq) ? gone(spec) : e;
        }
        started = true;
        transferStarted(spec);
        long length = http.length();
        return length >= 0 ? length - spec.position : C.LENGTH_UNSET;
    }

    private static IOException gone(DataSpec spec) {
        return new HttpDataSource.InvalidResponseCodeException(404, "live: past the head of a stream that has ended", null, Collections.emptyMap(),
                spec, new byte[0]);
    }

    /** A request: its answer begun (a refusal as the player's own sources tell one), on a network of the stream's that
     * has not failed lately; where one fails to answer, asked of the next at once. Not made once the video is let go;
     * one cut from another thread (cut) fails here or at its next read */
    private Net.Http ask(String url, DataSpec spec) throws IOException {
        for (;;) {
            asked = Net.on(url);
            // (one for the segment to come waits until YouTube has made it: Net.WAIT_MS; one for a segment made that gets
            // no data for Net.STALL_MS is a stall, the next request to another of the stream's networks)
            Net.Http made = Net.to(asked, agent, !exists);
            http = made;
            try {
                // (let go, or the stream said over, since it was looked at: a cut made meanwhile found no request)
                if (index.gone() || asking && index.past(sq)) {
                    throw new InterruptedIOException("live: let go");
                }
                int status = made.status();
                if (status != 200) {
                    throw new HttpDataSource.InvalidResponseCodeException(status, made.message(), null, made.headers(), spec,
                            new byte[0]);
                }
                return made;
            } catch (IOException e) {
                made.close();
                IOException told = lost(e);
                if (!(told instanceof Net.Moved)) {
                    throw told;
                }
            } catch (RuntimeException e) {
                made.close();
                throw e;
            }
        }
    }

    /** A failure of the request on its way as it is told on (Net.failed): one let go from this side is no network's
     * failing; the wait for a segment to come is no stall */
    private IOException lost(IOException e) {
        return wasCut ? e : Net.failed(asked, e, exists);
    }

    /** Some of the segment has come: the head is at least there */
    private void given() {
        if (!any) {
            any = true;
            index.heard(sq);
        }
    }

    @Override
    public int read(byte[] buffer, int offset, int length) throws IOException {
        if (length == 0) {
            return 0;
        }
        int read;
        try {
            read = in.read(buffer, offset, length);
        } catch (IOException e) {
            throw lost(e);
        }
        if (read < 0) {
            if (!any) {
                throw new IOException("live: an answer without data");
            }
            // (all in: the connection is kept for the next one)
            if (asking) {
                asking = false;
                index.asks(cut, -1);
                index.came(video, m);
            }
            return C.RESULT_END_OF_INPUT;
        }
        given();
        bytesTransferred(read);
        return read;
    }

    @Override
    public Uri getUri() {
        return address;
    }

    @Override
    public void close() {
        if (asking) {
            // (left before its end: not kept)
            asking = false;
            index.asks(cut, -1);
            Net.end(http);
        } else if (in != null) {
            try {
                in.close();
            } catch (IOException e) {
                // (read to its end: nothing to lose)
            }
        }
        in = null;
        http = null;
        if (started) {
            started = false;
            transferEnded();
        }
    }
}
