package org.bolli.youtube;

import android.net.Uri;
import android.os.SystemClock;

import androidx.media3.datasource.HttpDataSource;


import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InterruptedIOException;
import java.net.InetAddress;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import okhttp3.Call;
import okhttp3.Dns;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Protocol;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

/** What the shell's requests share: a request as the page's name the app, letting one go from any thread, and
 * YouTube's media networks as the page uses them (src/youtube/player/networks.ts, whose rules these are): a googlevideo
 * address names the networks that hold the video (mn=, the one in its host first), and the host is not part of the
 * address's signature, so the same address works on another network's host. A request that gets no data for
 * STALL_MS passes its network over for STALLED_MS (a cache node of the viewer's provider can hang), one that gets no
 * answer at all for UNANSWERED_MS only (the line itself may have dropped): the requests after it go to another (on),
 * the next video's too. When all have failed, the one that failed longest ago is tried again. */
final class Net {
    private static final String GOOGLEVIDEO = ".googlevideo.com";
    /** A request that gets no data this long (ms) is stalled */
    static final int STALL_MS = 4000;
    private static final long STALLED_MS = 30 * 60 * 1000;
    private static final long UNANSWERED_MS = 2 * 60 * 1000;
    private static final Pattern HOST = Pattern.compile("^(https?://)([a-z0-9]+)---([a-z0-9-]+)\\.googlevideo\\.com(/.*)$", Pattern.CASE_INSENSITIVE);
    private static final Pattern MN = Pattern.compile("[?&]mn=([^&]*)");
    private static final Pattern NAME = Pattern.compile("^[a-z0-9-]+$", Pattern.CASE_INSENSITIVE);
    /** Networks that failed lately: when (elapsed ms), and until when they are passed over */
    private static final Map<String, long[]> FAILURES = new HashMap<>();

    /** A request to a network failed in a way another may not: it goes there at once, without the wait a failure
     * is tried again after */
    static final class Moved extends IOException {
        Moved(IOException cause) {
            super("network: the next one", cause);
        }
    }

    /** A request for what is not made yet (a live stream's segment to come) waits this long for data (ms), as the
     * page's does: YouTube answers once it is made */
    static final int WAIT_MS = 30000;

    /** Every request of the layer's goes by this client (OkHttp): a host's addresses tried at almost the same time, the
     * next 250 ms after the one before if that has not answered (fast fallback), where Android's own connections try
     * each in turn and wait STALL_MS for it (a line whose IPv6 leads nowhere: STALL_MS more for every connection made);
     * HTTP/1.1, a connection for each request on its way, as Android's own made them; its connections kept for the next
     * request; no answer or no data for STALL_MS a stall. No cookies: OkHttp's list of public suffixes, which they
     * need, is not set up (its startup provider is left out of the app, AndroidManifest.xml) */
    private static final OkHttpClient CLIENT = new OkHttpClient.Builder()
            .connectTimeout(STALL_MS, TimeUnit.MILLISECONDS)
            .readTimeout(STALL_MS, TimeUnit.MILLISECONDS)
            .fastFallback(true)
            .protocols(Collections.singletonList(Protocol.HTTP_1_1))
            .dns(BuildConfig.DEBUG ? Net::deadFirstThen : Dns.SYSTEM)
            .build();

    private static final MediaType PROTOBUF = MediaType.get("application/x-protobuf");

    /** Answers no thread reads any more are closed here (cut): closing one may read the rest of it, which is never done
     * on the app's thread */
    private static final ExecutorService CLOSER = Executors.newCachedThreadPool();

    /** CLIENT waiting WAIT_MS for data, sharing its connections (made at its first use) */
    private static final class Waiting {
        static final OkHttpClient CLIENT = Net.CLIENT.newBuilder().readTimeout(WAIT_MS, TimeUnit.MILLISECONDS).build();
    }

    private Net() {
    }

    /** The client the player's own source asks by (NativeVideo) */
    static OkHttpClient client() {
        return CLIENT;
    }

    /** A request to url, not yet sent: named as the web view names the app, its answer asked as it is; no data for
     * STALL_MS a stall, or WAIT_MS for what is not made yet (waits) */
    static Http to(String url, String agent, boolean waits) {
        return new Http(waits ? Waiting.CLIENT : CLIENT, url, agent);
    }

    /** A debug build's host addresses: DeadFirst's before the host's own */
    private static List<InetAddress> deadFirstThen(String hostname) throws UnknownHostException {
        List<InetAddress> own = Dns.SYSTEM.lookup(hostname);
        InetAddress dead = DeadFirst.address;
        if (dead == null) {
            return own;
        }
        List<InetAddress> all = new ArrayList<>(own.size() + 1);
        all.add(dead);
        all.addAll(own);
        return all;
    }

    /** An address tried before each host's own in a debug build (null: none): a stand-in for an address of the host's
     * that leads nowhere, as a line whose IPv6 is broken has. A class of its own: read in at the player's start, it
     * loads nothing of OkHttp's on the app's thread (Net's client is made at Net's first use) */
    static final class DeadFirst {
        static volatile InetAddress address;

        private DeadFirst() {
        }

        /** address read from file (an address on its first line, written by adb's run-as; none, or empty: none), off
         * the caller's thread */
        static void from(File file) {
            new Thread(() -> {
                InetAddress found = null;
                try (BufferedReader in = new BufferedReader(new FileReader(file))) {
                    String line = in.readLine();
                    if (line != null && !line.trim().isEmpty()) {
                        found = InetAddress.getByName(line.trim());
                    }
                } catch (IOException e) {
                    // (no file: no address before the hosts' own)
                }
                address = found;
            }, "dead-first").start();
        }
    }

    /** A request of the layer's: its headers and a POST's body set before it is sent; sent by the first look at its
     * answer (status), on the thread that asks, which reads its answer; cut from any thread (cancel) */
    static final class Http {
        private final OkHttpClient client;
        private final Request.Builder request;
        private volatile Call call;
        private volatile boolean cancelled;
        private volatile Response response;

        Http(OkHttpClient client, String url, String agent) {
            this.client = client;
            request = new Request.Builder().url(url).header("User-Agent", agent).header("Accept-Encoding", "identity");
        }

        void header(String name, String value) {
            request.header(name, value);
        }

        /** A POST of body, a protobuf message (the layer's only one: Sabr's) */
        void post(byte[] body) {
            request.post(RequestBody.create(body, PROTOBUF));
        }

        /** Sends it (the first time) and waits for its answer's head: its status */
        int status() throws IOException {
            if (response == null) {
                Call c = client.newCall(request.build());
                call = c;
                // (cut while it was made: as cut once sent)
                if (cancelled) {
                    c.cancel();
                }
                response = c.execute();
            }
            return response.code();
        }

        String message() {
            return response.message();
        }

        Map<String, List<String>> headers() {
            return response.headers().toMultimap();
        }

        /** A header of the answer's as a number (otherwise: none, or not a number) */
        int headerInt(String name, int otherwise) {
            String value = response.header(name);
            try {
                return value != null ? Integer.parseInt(value.trim()) : otherwise;
            } catch (NumberFormatException e) {
                return otherwise;
            }
        }

        InputStream body() {
            return response.body().byteStream();
        }

        /** The answer's length (-1: not told) */
        long length() {
            return response.body().contentLength();
        }

        /** Cut where it waits or reads, from any thread: the thread that reads it fails there */
        void cancel() {
            cancelled = true;
            Call c = call;
            if (c != null) {
                c.cancel();
            }
        }

        /** Let go on its own thread, or on CLOSER where no thread reads it (cut): cut, its answer closed (its connection
         * kept where the answer was read out) */
        void close() {
            cancel();
            Response r = response;
            if (r != null) {
                r.close();
            }
        }
    }

    /** Lets a request go from another thread than its own (null: none), the app's too: cut where it waits or reads (at
     * once: its connection's socket closed). Its answer is closed by the thread that reads it (end); here only one that
     * no thread reads any more (idle), on CLOSER */
    static void cut(Http http, boolean idle) {
        if (http != null) {
            http.cancel();
            if (idle) {
                CLOSER.execute(http::close);
            }
        }
    }

    /** Lets a request go on its own thread (null: none): cut, its answer closed (a cut one is not read out first) */
    static void end(Http http) {
        if (http != null) {
            http.close();
        }
    }

    /** A network u names in mn: its name and its place there (the host's number, from 1) */
    private static final class Network {
        final String name;
        final int place;

        Network(String name, int place) {
            this.name = name;
            this.place = place;
        }
    }

    /** The networks u names in mn (only well-formed names, each with its place), and u's own among them (-1: u names
     * none, or is not on one of them). host: u's host matched */
    private static int networks(Matcher host, String u, List<Network> all) {
        Matcher mn = MN.matcher(u);
        if (!host.matches() || !mn.find()) {
            return -1;
        }
        int own = -1;
        String[] names = Uri.decode(mn.group(1)).split(",");
        for (int i = 0; i < names.length; i++) {
            if (NAME.matcher(names[i]).matches()) {
                if (names[i].equals(host.group(3))) {
                    own = all.size();
                }
                all.add(new Network(names[i], i + 1));
            }
        }
        return own;
    }

    private static boolean passedOver(String name, long now) {
        long[] f = FAILURES.get(name);
        if (f != null && f[1] <= now) {
            FAILURES.remove(name);
            return false;
        }
        return f != null;
    }

    /** u on the first of the video's networks, from its own on, that has not failed lately (all have: the one that
     * failed longest ago). Nothing to look at while none failed */
    static synchronized String on(String u) {
        if (FAILURES.isEmpty()) {
            return u;
        }
        Matcher host = HOST.matcher(u);
        List<Network> all = new ArrayList<>();
        int own = networks(host, u, all);
        if (own < 0) {
            return u;
        }
        long now = SystemClock.elapsedRealtime();
        int at = own;
        for (int i = 0; i < all.size(); i++) {
            int j = (own + i) % all.size();
            if (!passedOver(all.get(j).name, now)) {
                at = j;
                break;
            }
            long[] best = FAILURES.get(all.get(at).name);
            if (best != null && FAILURES.get(all.get(j).name)[0] < best[0]) {
                at = j;
            }
        }
        Network to = all.get(at);
        return at == own ? u : host.group(1) + "rr" + to.place + "---" + to.name + GOOGLEVIDEO + host.group(4);
    }

    /** A request to u got no data for STALL_MS (stalled) or no answer: its network is passed over for a while, and
     * the failure comes back as Moved where another of the video's networks has not failed lately (the request goes
     * there at once); else as it was */
    private static synchronized IOException lost(String u, boolean stalled, IOException e) {
        List<Network> all = new ArrayList<>();
        int own = networks(HOST.matcher(u), u, all);
        if (own < 0) {
            return e;
        }
        long now = SystemClock.elapsedRealtime();
        FAILURES.put(all.get(own).name, new long[] { now, now + (stalled ? STALLED_MS : UNANSWERED_MS) });
        for (Network n : all) {
            if (!passedOver(n.name, now)) {
                return new Moved(e);
            }
        }
        return e;
    }

    /** A failure of a request to u as it is told on (as the page's onLost): no answer passes the network over, and
     * no data for a while too where the request is watched for that (watched: one that is no wait for something to
     * come). A refusal and a request let go from this side are no network's failing: the caller tells those as they
     * are */
    static IOException failed(String u, IOException e, boolean watched) {
        if (e instanceof Moved || cause(e, HttpDataSource.InvalidResponseCodeException.class) != null) {
            return e;
        }
        SocketTimeoutException timeout = cause(e, SocketTimeoutException.class);
        if (timeout == null && cause(e, InterruptedIOException.class) != null || timeout != null && !watched) {
            return e;
        }
        return lost(u, timeout != null, e);
    }

    /** The first of kind among e and its causes (null: none) */
    static <T extends Throwable> T cause(Throwable e, Class<T> kind) {
        for (Throwable t = e; t != null; t = t.getCause()) {
            if (kind.isInstance(t)) {
                return kind.cast(t);
            }
        }
        return null;
    }
}
