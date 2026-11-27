// Bolli YouTube's own video layer: a video the page hands over (src/youtube/android/native.ts) plays in Android's
// player (Media3) on a SurfaceView under the web view, which is see-through where the page leaves the picture open:
// a layer of its own that the TV's hardware puts on the screen, as the official app's, where a web view's <video>
// is drawn by the GPU into the page (no TV but a few gives a web view a video layer: 4K and 60 fps stutter there).
// The page keeps every screen, key and sign; it asks by window.BolliVideo (the Bridge below) and hears the player's
// state by BolliNative.take, at every change and each second while it plays or loads.
// A video's formats are described to the player as files with their index (Sent) and fetched as YouTube's players
// fetch them: a guest's by their addresses, in pieces (Ranged), the account's from its SABR session (Sabr, SabrSource).
// A live stream is described by an index that moves with its head (Numbered), its segments fetched one by one
// (Segments) and their times put on the player's scale (Rebased).
// With no video loaded the layer is gone and the web view opaque: the app's window is then as without it. The player
// is made a moment after the app's start, on a thread of its own (the first video does not wait for it), and keeps
// its decoders between videos while the app shows (the next one starts on them), letting them go as the app leaves
// the screen or the web view's own player is to play.

package org.bolli.youtube;

import android.app.Activity;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.SurfaceView;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.widget.FrameLayout;

import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.PlaybackParameters;
import androidx.media3.common.Player;
import androidx.media3.common.VideoSize;
import androidx.media3.datasource.DataSource;
import androidx.media3.datasource.HttpDataSource;
import androidx.media3.datasource.okhttp.OkHttpDataSource;
import androidx.media3.exoplayer.DecoderCounters;
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.analytics.AnalyticsListener;
import androidx.media3.exoplayer.dash.DashMediaSource;
import androidx.media3.exoplayer.dash.DefaultDashChunkSource;
import androidx.media3.exoplayer.mediacodec.MediaCodecUtil;
import androidx.media3.exoplayer.source.LoadEventInfo;
import androidx.media3.exoplayer.source.MediaLoadData;
import androidx.media3.exoplayer.source.chunk.ChunkExtractor;
import androidx.media3.exoplayer.upstream.LoadErrorHandlingPolicy;
import androidx.media3.extractor.ChunkIndex;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

public final class NativeVideo implements MainActivity.Extra, Ranged.Table {
    /** The page's layout is this wide (its box for the picture is in these units) */
    private static final float LAYOUT_WIDTH = 1280f;
    /** The player's state is told this often while it plays or loads (ms) */
    private static final long REPORT_MS = 1000;
    /** The player is made this long after the app's start (ms: past the first screen's own work), once the page has
     * said hello: where its script takes no video from the shell (a web view before Chrome 55), or the page is not
     * given the player (Android before 7.0), none is made */
    private static final long MAKE_MS = 2500;
    /** A request that fails is tried again, RETRY_MS later for each time it has failed (RETRY_MOST_MS at most), for
     * as long as the picture has media to play; with none left, its RETRIES-th failure on is the player's (as the
     * page's own engines: player/engine.ts RETRIES) */
    private static final int RETRIES = 3;
    private static final long RETRY_MS = 500;
    private static final long RETRY_MOST_MS = 3000;

    private WebView web;
    private final Handler main = new Handler(Looper.getMainLooper());
    /** What the app's own page gets as it says hello, and gives back with every call that names an address to
     * fetch: the web view gives the Bridge to every frame, youtube.com's too, which cannot read the page's */
    private final String key = Long.toHexString(new SecureRandom().nextLong()) + Long.toHexString(new SecureRandom().nextLong());
    /** Under the web view while a video is loaded: black (the bars beside a picture of another shape), the picture,
     * and black over it while it is not to show */
    private FrameLayout back;
    private SurfaceView surface;
    private View curtain;
    /** The player (built: on any thread, once; wired to the app's thread and its layers at the first video) */
    private volatile ExoPlayer player;
    private Picker picker;
    private Loading loading;
    private DataSource.Factory requests;
    private String agent;
    private boolean wired;
    /** The app's window is gone: no player is made any more */
    private boolean gone;
    /** The player keeps its decoders while it rests (not once the app is off the screen, nor while the web view's own
     * player or YouTube's own app has the videos) */
    private boolean keeping;

    /** The video loaded: the page's number for the load (0: none), its formats */
    private volatile int load;
    private volatile List<Sent> videos = Collections.emptyList();
    private volatile List<Sent> audios = Collections.emptyList();
    /** Its SABR session where its streams come that way (the account's; null: a guest's, by their addresses) */
    private Sabr session;
    /** A live stream's index (null: a video), and whether the player was stood at the end of one that has ended */
    private Numbered live;
    private boolean playedOut;
    /** The last of the page's play, pause and seek that ran (its count of them), and whether a seek was among them */
    private int done;
    private boolean sought;
    /** The picture's size, and its box and whether it shows as the page has it */
    private int width;
    private int height;
    private double boxLeft;
    private double boxTop;
    private double boxWidth = LAYOUT_WIDTH;
    private double boxHeight = 720;
    private boolean shown;
    /** What the next report tells once: a failure, the video's keyframes, the video requests done (bytes and ms) */
    private String failure;
    private String failureText;
    /** A request was refused for its address (told once for the addresses it has: the page renews them in place) */
    private boolean stale;
    private boolean staleTold;
    private long[] starts;
    /** The video decoder the player holds, by the device's name for it (null: none), and whether this load's reports
     * have told it (Stats for nerds: the next video plays on it too, with no new one made) */
    private String decoder;
    private boolean decoderTold;
    private final List<long[]> downloads = new ArrayList<>();
    /** A start's steps for the page's play log, each with its ms since the load was asked, until its first picture
     * (null: told, or none): where a slow start's time went */
    private StringBuilder steps;
    private long began;

    private final Runnable report = this::send;
    /** When the player is to be made (uptime ms; 0: asked for already) */
    private long makeAt;

    @Override
    public void attach(WebView web) {
        this.web = web;
        // As the page's own requests name the app (YouTube serves a client by it)
        agent = web.getSettings().getUserAgentString();
        // (Android before 7.0 is not given the player: on the emulator's Android 6.0, web view 44, a video in a box (a
        // tile's preview, a channel's header) came out as noise where a full-screen one played; whether Android's or
        // the web view's doing is not known, so the page's script leaves such a web view out too (native.ts install).
        // The web view's own player plays everything there, as in the builds without this layer)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            web.addJavascriptInterface(new Bridge(), "BolliVideo");
        }
        makeAt = SystemClock.uptimeMillis() + MAKE_MS;
        // (a debug build's test of a line whose IPv6 leads nowhere: an address in the app's file dead-first, tried
        // before every host's own, written by adb's run-as)
        if (BuildConfig.DEBUG) {
            Net.DeadFirst.from(new File(web.getContext().getFilesDir(), "dead-first"));
        }
    }

    /** The app is off the screen (the page stops its video too, and asks anew as it comes back): the video and the
     * decoders let go */
    @Override
    public void stop() {
        free();
    }

    /** The video let go (the page's stop): the layer gone, the web view opaque again; the decoders stay for the
     * next video */
    private void halt() {
        if (load == 0) {
            return;
        }
        load = 0;
        loading.held = false;
        main.removeCallbacks(report);
        player.stop();
        player.clearMediaItems();
        close();
        videos = audios = Collections.emptyList();
        back.setVisibility(View.GONE);
        MainActivity.opaque(web);
    }

    /** What the video before asked YouTube by is let go: its SABR session, a live stream's requests */
    private void close() {
        if (session != null) {
            session.close();
            session = null;
        }
        if (live != null) {
            live.end(false);
            live = null;
        }
    }

    /** The video and the decoders let go: the app is off the screen, or the web view's own player or YouTube's own
     * app is to play */
    private void free() {
        halt();
        if (keeping) {
            keeping = false;
            decoder = null;
            player.setForegroundMode(false);
        }
    }

    @Override
    public synchronized void destroy() {
        gone = true;
        main.removeCallbacksAndMessages(null);
        if (player != null) {
            player.release();
            player = null;
        }
    }

    /** The player itself, on whichever thread comes first (the one of its own a moment after the app's start, or the
     * app's at a video handed over before that), once. The decoders the device has are looked up with it, off the
     * first start's way */
    private synchronized void build() {
        if (player != null || gone) {
            return;
        }
        Activity activity = (Activity) web.getContext();
        picker = new Picker();
        loading = new Loading();
        // (by the layer's client: no data for Net.STALL_MS a stall, the next request to another of the video's
        // networks; a host's addresses tried at almost the same time)
        HttpDataSource.Factory http = new OkHttpDataSource.Factory(Net.client()).setUserAgent(agent);
        requests = () -> new Ranged(http.createDataSource(), this);
        ExoPlayer made = new ExoPlayer.Builder(activity, new DefaultRenderersFactory(activity).setEnableDecoderFallback(true))
                .setTrackSelector(picker).setLoadControl(loading).setLooper(Looper.getMainLooper()).setUsePlatformDiagnostics(false).build();
        for (String kind : new String[] { "video/x-vnd.on2.vp9", "video/avc", "video/av01", "audio/mp4a-latm", "audio/opus" }) {
            MediaCodecUtil.warmDecoderInfoCache(kind, false, false);
        }
        player = made;
    }

    /** The layers under the web view, and the player wired to them and to the reports, at the first video */
    private void make() {
        build();
        if (wired) {
            return;
        }
        wired = true;
        Activity activity = (Activity) web.getContext();
        back = new FrameLayout(activity);
        back.setBackgroundColor(Color.BLACK);
        surface = new SurfaceView(activity);
        curtain = new View(activity);
        curtain.setBackgroundColor(Color.BLACK);
        ViewGroup.LayoutParams whole = new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
        back.addView(surface, new FrameLayout.LayoutParams(whole));
        back.addView(curtain, new FrameLayout.LayoutParams(whole));
        ((ViewGroup) web.getParent()).addView(back, 0, whole);
        player.setAudioAttributes(new AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MOVIE).build(), true);
        player.setVideoSurfaceView(surface);
        player.addListener(new Player.Listener() {
            @Override
            public void onPlaybackStateChanged(int state) {
                tell();
            }

            @Override
            public void onIsPlayingChanged(boolean playing) {
                tell();
            }

            @Override
            public void onIsLoadingChanged(boolean isLoading) {
                tell();
            }

            @Override
            public void onPlayWhenReadyChanged(boolean play, int reason) {
                tell();
            }

            @Override
            public void onPlaybackSuppressionReasonChanged(int reason) {
                tell();
            }

            @Override
            public void onPositionDiscontinuity(Player.PositionInfo from, Player.PositionInfo to, int reason) {
                tell();
            }

            @Override
            public void onVideoSizeChanged(VideoSize size) {
                if (size.width > 0 && size.height > 0) {
                    width = Math.round(size.width * size.pixelWidthHeightRatio);
                    height = size.height;
                    place();
                    tell();
                }
            }

            @Override
            public void onPlayerError(PlaybackException error) {
                loading.held = false;
                failure = why(error);
                Throwable cause = error.getCause();
                failureText = error.getErrorCodeName() + (cause != null && cause.getMessage() != null ? ": " + cause.getMessage() : "");
                tell();
            }
        });
        player.addAnalyticsListener(new AnalyticsListener() {
            @Override
            public void onLoadCompleted(EventTime time, LoadEventInfo info, MediaLoadData data) {
                step((data.trackType == C.TRACK_TYPE_VIDEO ? "video" : "audio") + (data.dataType == C.DATA_TYPE_MEDIA ? " media " : " head ")
                        + info.bytesLoaded / 1024 + " KB in " + info.loadDurationMs + " ms");
            }

            @Override
            public void onAudioDecoderInitialized(EventTime time, String name, long at, long took) {
                step("audio decoder in " + took + " ms");
            }

            @Override
            public void onVideoDecoderInitialized(EventTime time, String name, long at, long took) {
                decoder = name;
                decoderTold = false;
                step(name + " in " + took + " ms");
            }

            @Override
            public void onRenderedFirstFrame(EventTime time, Object output, long renderTimeMs) {
                // (the start's last step: told with the report that follows)
                if (steps != null) {
                    step("picture");
                    tell();
                }
            }
        });
    }

    /** A step of the start on its way, with its time */
    private void step(String what) {
        if (steps != null && steps.indexOf("picture") < 0) {
            steps.append(steps.length() > 0 ? ", " : "").append(what).append(" at ").append(SystemClock.elapsedRealtime() - began);
        }
    }

    /** A request's failure: tried again while the picture plays on what is loaded (the player fails it only once that
     * has run out). One refused for its address is told to the page at once, which renews the addresses in place: the
     * next try takes the new one. No format is left out for a failure: the page picks them */
    private final LoadErrorHandlingPolicy onFailure = new LoadErrorHandlingPolicy() {
        @Override
        public FallbackSelection getFallbackSelectionFor(FallbackOptions options, LoadErrorInfo info) {
            return null;
        }

        /** (on a loading thread) */
        @Override
        public long getRetryDelayMsFor(LoadErrorInfo info) {
            // (the server's own no: no use in asking again)
            if (Net.cause(info.exception, Sabr.Refused.class) != null) {
                return C.TIME_UNSET;
            }
            // (one network failing: asked of the next at once. A SABR request's; a guest's and a live stream's are
            // asked of the next within the load)
            if (Net.cause(info.exception, Net.Moved.class) != null) {
                return 0;
            }
            if (refused(info.exception) == 403) {
                main.post(() -> {
                    if (load != 0 && !staleTold) {
                        stale = staleTold = true;
                        tell();
                    }
                });
            }
            return Math.min(RETRY_MOST_MS, RETRY_MS * info.errorCount);
        }

        @Override
        public int getMinimumLoadableRetryCount(int dataType) {
            return RETRIES;
        }
    };

    /** The status a server refused a request with, somewhere in e's causes (0: none did) */
    private static int refused(Throwable e) {
        HttpDataSource.InvalidResponseCodeException no = Net.cause(e, HttpDataSource.InvalidResponseCodeException.class);
        return no != null ? no.responseCode : 0;
    }

    /** A failure as the page's engines name theirs: 'expired' (the addresses: renewed), 'network', 'stream' (a file
     * it cannot read), 'media' (a decoder, the sound's output); what is none of these is the player's own ('player':
     * the page starts the video anew in the web view's) */
    private static String why(PlaybackException error) {
        Sabr.Refused no = Net.cause(error, Sabr.Refused.class);
        if (no != null) {
            return no.why;
        }
        if (refused(error) == 403) {
            return "expired";
        }
        int kind = error.errorCode / 1000;
        return kind == 2 ? "network" : kind == 3 ? "stream" : kind == 4 || kind == 5 ? "media" : "player";
    }

    /** (on a loading thread; the names are Sent.address's) */
    @Override
    public Sent of(Uri address) {
        List<Sent> formats = Sent.videoOf(address) ? videos : audios;
        int index = Sent.placeOf(address);
        return index < formats.size() ? formats.get(index) : null;
    }

    /** (on a loading thread) */
    @Override
    public void loaded(long bytes, long ms) {
        synchronized (downloads) {
            downloads.add(new long[] { bytes, ms });
        }
    }

    /** The picture in its box: whole and in its own shape in the middle of it, the box in the web view's own pixels */
    private void place() {
        if (web.getWidth() == 0) {
            return;
        }
        float scale = web.getWidth() / LAYOUT_WIDTH;
        int left = Math.round((float) boxLeft * scale);
        int top = Math.round((float) boxTop * scale);
        int w = Math.round((float) boxWidth * scale);
        int h = Math.round((float) boxHeight * scale);
        if (width > 0 && height > 0 && w > 0 && h > 0) {
            float shape = width / (float) height;
            if (w > h * shape) {
                int fitted = Math.round(h * shape);
                left += (w - fitted) / 2;
                w = fitted;
            } else {
                int fitted = Math.round(w / shape);
                top += (h - fitted) / 2;
                h = fitted;
            }
        }
        FrameLayout.LayoutParams at = (FrameLayout.LayoutParams) surface.getLayoutParams();
        if (at.width != w || at.height != h || at.leftMargin != left || at.topMargin != top) {
            at.width = w;
            at.height = h;
            at.leftMargin = left;
            at.topMargin = top;
            surface.setLayoutParams(at);
        }
        int dark = shown ? View.GONE : View.VISIBLE;
        if (curtain.getVisibility() != dark) {
            curtain.setVisibility(dark);
        }
    }

    /** The player's state told now-ish: once for all that changed in this turn of the player's */
    private void tell() {
        main.removeCallbacks(report);
        if (load != 0) {
            main.post(report);
        }
    }

    /** The report (native.ts: Report), and the next one REPORT_MS on while it plays or loads (the time and what is
     * loaded move then; never while it rests) */
    private void send() {
        long length = player.getDuration();
        long position = player.getCurrentPosition();
        if (session != null) {
            session.at(position, player.isPlaying() ? player.getPlaybackParameters().speed : 0, loading.behindUs());
        }
        // A live stream that has ended is over once the picture is at its last sample. The player, told a day's
        // length, would run its time on past that with nothing to show (it ends by the length alone): it is stood
        // there, and told to the page as ended and not paused, as a video's end is. (Ready: a jump back into it
        // that the player has still to run is not taken for the end again)
        long playedUs = live != null ? live.playedUs() : -1;
        long end = playedUs >= 0 ? playedUs / 1000 : -1;
        boolean out = end >= 0 && position >= end && player.getPlaybackState() == Player.STATE_READY;
        if (out && !playedOut) {
            playedOut = true;
            player.setPlayWhenReady(false);
        }
        long loaded = player.getBufferedPosition();
        if (live != null) {
            // (all of it in: the player says the day's end)
            loaded = Math.min(loaded, Math.max(live.edgeUs() / 1000, position));
        }
        StringBuilder s = new StringBuilder(256);
        s.append("window.BolliNative&&BolliNative.take({g:").append(load).append(",n:").append(done)
                .append(",st:").append(out ? Player.STATE_ENDED : player.getPlaybackState())
                .append(",pw:").append(playedOut || player.getPlayWhenReady() && player.getPlaybackSuppressionReason() == Player.PLAYBACK_SUPPRESSION_REASON_NONE ? 1 : 0)
                .append(",pl:").append(player.isPlaying() ? 1 : 0)
                .append(",pos:").append(position / 1000.0).append(",t:").append(System.currentTimeMillis())
                .append(",buf:").append(loaded / 1000.0).append(",back:").append(loading.behindUs() / 1000000.0)
                .append(",dur:").append(length == C.TIME_UNSET || live != null ? 0 : length / 1000.0)
                .append(",w:").append(width).append(",h:").append(height);
        DecoderCounters frames = player.getVideoDecoderCounters();
        if (frames != null) {
            frames.ensureUpdated();
            s.append(",dr:").append(frames.droppedBufferCount).append(",fr:")
                    .append(frames.renderedOutputBufferCount + frames.droppedBufferCount + frames.skippedOutputBufferCount);
        } else {
            s.append(",dr:0,fr:0");
        }
        synchronized (downloads) {
            if (!downloads.isEmpty()) {
                s.append(",dl:[");
                for (int i = 0; i < downloads.size(); i++) {
                    s.append(i > 0 ? "," : "").append('[').append(downloads.get(i)[0]).append(',').append(downloads.get(i)[1]).append(']');
                }
                s.append(']');
                downloads.clear();
            }
        }
        if (starts != null) {
            // (in step with the seeks' rounding: Sent.msAtOrAfter)
            s.append(",starts:[");
            for (int i = 0; i < starts.length; i++) {
                s.append(i > 0 ? "," : "").append(Sent.msAtOrAfter(starts[i]) / 1000.0);
            }
            s.append(']');
            starts = null;
        }
        if (failure != null) {
            s.append(",err:").append(JSONObject.quote(failure)).append(",text:").append(JSONObject.quote(failureText));
            failure = null;
        }
        if (stale) {
            s.append(",stale:1");
            stale = false;
        }
        // (the video decoder's name from this load's picture on: until then it may still be the last video's, which a
        // new codec replaces)
        if (decoder != null && !decoderTold && (steps == null || steps.indexOf("picture") >= 0)) {
            s.append(",dec:").append(JSONObject.quote(decoder));
            decoderTold = true;
        }
        if (live != null) {
            live.report(s);
        }
        if (session != null) {
            session.report(s);
        }
        if (steps != null && steps.indexOf("picture") >= 0) {
            s.append(",steps:").append(JSONObject.quote(steps.toString()));
            steps = null;
        }
        web.evaluateJavascript(s.append("})").toString(), null);
        // (not while all that is loading is a SABR lane waiting for the picture to move on; a stream that has
        // ended: at its end, where that is sooner)
        if (player.isPlaying() || player.isLoading() && !(session != null && session.resting())) {
            main.postDelayed(report, end >= 0 && !out ? Math.max(20, Math.min(REPORT_MS, end - position)) : REPORT_MS);
        }
    }

    /** The player goes on after a live stream's end stood it (a jump back into it) */
    private void on() {
        if (playedOut) {
            playedOut = false;
            player.setPlayWhenReady(true);
        }
    }

    /** A load of the page's (native.ts: VideoShell.load) */
    private void begin(String json) {
        JSONObject o;
        try {
            o = new JSONObject(json);
            // (not the app's own page: nothing of its is loaded)
            if (!key.equals(o.optString("key"))) {
                return;
            }
            load = o.getInt("g");
        } catch (JSONException e) {
            // (no load of the page's to tell a failure of)
            return;
        }
        began = SystemClock.elapsedRealtime();
        steps = new StringBuilder();
        main.removeCallbacks(report);
        make();
        step("player");
        if (!keeping) {
            keeping = true;
            player.setForegroundMode(true);
        }
        done = 0;
        sought = false;
        playedOut = false;
        close();
        loading.holdUs = 0;
        loading.held = false;
        loading.mostUs = 0;
        width = height = 0;
        failure = null;
        stale = staleTold = decoderTold = false;
        starts = null;
        synchronized (downloads) {
            downloads.clear();
        }
        back.setVisibility(View.VISIBLE);
        web.setBackgroundColor(Color.TRANSPARENT);
        try {
            List<Sent> v = Sent.list(o.getJSONArray("video"), true);
            List<Sent> a = Sent.list(o.getJSONArray("audio"), false);
            videos = v;
            audios = a;
            want(picker.video, v.get(o.getInt("v")), -1);
            want(picker.audio, a.get(o.getInt("a")), -1);
            player.setPlayWhenReady(false);
            player.setPlaybackParameters(new PlaybackParameters((float) o.optDouble("rate", 1)));
            player.setVolume((float) o.optDouble("volume", 1));
            int of = load;
            long startUs = Math.round(o.optDouble("at", 0) * 1000000);
            JSONObject stream = o.optJSONObject("live");
            JSONObject sabr = o.optJSONObject("sabr");
            DataSource.Factory from;
            ChunkExtractor.Factory readers;
            if (stream != null) {
                // A live stream: its segments by its own index (Numbered), from START_BEHIND behind its head
                Numbered numbered = new Numbered(stream.getDouble("segment"), stream.optDouble("dvr", 0), stream.optBoolean("over"));
                live = numbered;
                loading.mostUs = Numbered.AHEAD_US;
                from = () -> new Segments(agent, numbered, this);
                readers = new Rebased(numbered);
                startUs = numbered.startUs();
            } else {
                // A video: by its formats' addresses, or the account's streams (SABR) asked of their session (Sabr,
                // SabrSource), by the same description, readers and loading, only as far ahead as its server sends
                Sabr asked = sabr != null ? new Sabr(agent, sabr, v.get(o.getInt("v")), a.get(o.getInt("a")), startUs / 1000, this) : null;
                session = asked;
                loading.mostUs = asked != null ? Sabr.READAHEAD_US : 0;
                from = asked != null ? () -> new SabrSource(asked, this) : requests;
                readers = heads(of, startUs, asked);
            }
            player.setMediaSource(new DashMediaSource.Factory(new DefaultDashChunkSource.Factory(readers, from, 1), null)
                    .setLoadErrorHandlingPolicy(onFailure).createMediaSource(Sent.manifest(v, a, Math.round(o.optDouble("length", 0) * 1000), live)),
                    startUs / 1000);
            player.prepare();
            step("asked");
        } catch (JSONException | RuntimeException e) {
            // (what the page sent cannot be played: told as a file the player cannot read)
            failure = "stream";
            failureText = String.valueOf(e);
        }
        tell();
    }

    /** A video's readers of its formats' heads, for load `of` starting at startUs.
     * The video's index, read as the player takes it (on the thread that loads the head, before the player's own
     * hears of it and asks for the first media), is told to the page, for this load alone (one read late, for the
     * video before, is dropped), and each kind's to the SABR session where there is one.
     * A start within the video is put on the keyframe at or before it, as the page's own engine starts there
     * (dash.ts open): from the exact place the decoder would work through the frames between them before the first
     * shows (0.5 s and more). Nothing is asked for until it is there: the hold is let go on the player's own thread,
     * in turn after the seek. Let go here, a request for more that waits there ahead of the seek would ask for the
     * first media from the old start, and the player, which takes a first request within a segment as a start to
     * come back to, would go back there after the seek (the frames up to it worked through after all). The seek
     * goes to the first whole ms at or after the keyframe (an MP4's are not on whole ms): one before it is in the
     * segment before, all of which would be worked through.
     * The sound's head is usually in before the video's index: its first media, asked from the old start, would be
     * thrown away at the seek and asked again, so the hold begins with whichever head is in first */
    private Indexed heads(int of, long startUs, Sabr asked) {
        boolean[] indexed = { false };
        return new Indexed(new Indexed.Heard() {
            @Override
            public void index(boolean video, String id, ChunkIndex index) {
                if (asked != null && load == of) {
                    asked.index((video ? videos : audios).get(Integer.parseInt(id)), index);
                }
            }

            @Override
            public void sound() {
                synchronized (indexed) {
                    // (of this load still: a head of the video before, in late, holds nothing)
                    if (!indexed[0] && startUs > 0 && load == of) {
                        loading.held = true;
                    }
                }
            }

            @Override
            public void starts(long[] times) {
                if (load != of) {
                    return;
                }
                long key;
                synchronized (indexed) {
                    key = indexed[0] ? startUs : keyframe(times, startUs);
                    indexed[0] = true;
                    if (key < startUs) {
                        loading.held = true;
                    }
                }
                main.post(() -> {
                    if (load != of || player == null) {
                        return;
                    }
                    if (key < startUs && !sought) {
                        player.seekTo(Sent.msAtOrAfter(key));
                        step("on its keyframe " + key / 1000 / 1000.0 + " for " + startUs / 1000 / 1000.0);
                    }
                    starts = times;
                    tell();
                    player.createMessage((type, payload) -> loading.held = false).send();
                });
            }
        });
    }

    /** The player stopped at a failure (it is idle with its video still loaded) and the page goes on with it (new
     * addresses, a jump to where it stood as the line is back, Play): on from where it is. Its loads were let go
     * without waiting for their threads: a SABR session gets new lanes for the new ones */
    private void revive() {
        if (player.getPlaybackState() == Player.STATE_IDLE) {
            if (session != null) {
                session.anew();
            }
            player.prepare();
        }
    }

    /** The last of the segment starts (the video's keyframes, us, in order) at or before t; t where none is */
    private static long keyframe(long[] starts, long t) {
        long key = t;
        for (long start : starts) {
            if (start > t) {
                break;
            }
            key = start;
        }
        return key;
    }

    /** A kind's format wanted from here on, what is loaded in another let go from aheadUs past the picture (-1: none) */
    private void want(Picker.Wish wish, Sent format, long aheadUs) {
        wish.id = format.id();
        wish.aheadUs = aheadUs;
        loading.bitrate = bitrate(picker.video.id, videos) + bitrate(picker.audio.id, audios);
    }

    private static int bitrate(String id, List<Sent> formats) {
        for (Sent f : formats) {
            if (f.id().equals(id)) {
                return f.bitrate;
            }
        }
        return 0;
    }

    /** The page's calls (native.ts: VideoShell); they come on a thread of their own and are run on the app's, those
     * for the video loaded only while one is */
    private final class Bridge {
        private void whileLoaded(Runnable call) {
            main.post(() -> {
                if (load != 0) {
                    call.run();
                }
            });
        }

        /** (answered in the app's own page alone: a frame's script is not run by this) */
        @JavascriptInterface
        public void hello() {
            main.post(() -> {
                if (makeAt > 0) {
                    main.postAtTime(() -> new Thread(NativeVideo.this::build, "bolli-video").start(), makeAt);
                    makeAt = 0;
                }
                web.evaluateJavascript("window.BolliNative&&BolliNative.unlock('" + key + "')", null);
            });
        }

        @JavascriptInterface
        public void load(String json) {
            main.post(() -> begin(json));
        }

        @JavascriptInterface
        public void play(int n) {
            whileLoaded(() -> {
                done = n;
                playedOut = false;
                player.setPlayWhenReady(true);
                revive();
                tell();
            });
        }

        @JavascriptInterface
        public void pause(int n) {
            whileLoaded(() -> {
                done = n;
                playedOut = false;
                player.setPlayWhenReady(false);
                tell();
            });
        }

        @JavascriptInterface
        public void seek(double t, int n) {
            whileLoaded(() -> {
                done = n;
                sought = true;
                on();
                step("the page seeks to " + t);
                if (session != null) {
                    session.seek(Math.round(t * 1000));
                }
                // (a live stream: to the start of the segment it lies in, within what the stream has, as the
                // page's engine moves by whole segments)
                Numbered stream = live;
                long to = stream != null ? stream.landUs(Math.round(t * 1000000)) / 1000 + 1 : Math.round(t * 1000);
                long from = player.getCurrentPosition();
                boolean out = to < from - loading.behindUs() / 1000 || to > player.getBufferedPosition();
                player.seekTo(to);
                // Out of what is loaded, the player lets its loads go and asks at the new place once they have
                // returned: a live stream's request for the segment to come, which waits at YouTube, is cut (on the
                // player's own thread, in turn after the seek: its load is let go by then, the cut no failure)
                if (stream != null && out) {
                    player.createMessage((type, payload) -> stream.cut()).send();
                }
                revive();
                tell();
            });
        }

        @JavascriptInterface
        public void speed(double rate) {
            whileLoaded(() -> player.setPlaybackParameters(new PlaybackParameters((float) rate)));
        }

        @JavascriptInterface
        public void volume(double v) {
            whileLoaded(() -> player.setVolume((float) v));
        }

        @JavascriptInterface
        public void pick(String kind, int i, double ahead, String url, String k) {
            whileLoaded(() -> {
                if (!key.equals(k)) {
                    return;
                }
                boolean video = "v".equals(kind);
                Sent format = (video ? videos : audios).get(i);
                format.url = url;
                Picker.Wish wish = video ? picker.video : picker.audio;
                want(wish, format, ahead > 0 ? Math.round(ahead * 1000000) : -1);
                // (one the player makes its track anew for: a new loader, which takes a SABR lane of its own, the old
                // loader's let go)
                if (session != null && !wish.among.contains(wish.id)) {
                    session.anew(video);
                }
                picker.taken(wish);
            });
        }

        @JavascriptInterface
        public void renew(int v, String video, int a, String audio, String k) {
            whileLoaded(() -> {
                if (!key.equals(k)) {
                    return;
                }
                videos.get(v).url = video;
                audios.get(a).url = audio;
                staleTold = false;
                revive();
                tell();
            });
        }

        @JavascriptInterface
        public void box(double left, double top, double w, double h, boolean show) {
            whileLoaded(() -> {
                boxLeft = left;
                boxTop = top;
                boxWidth = w;
                boxHeight = h;
                shown = show;
                place();
            });
        }

        @JavascriptInterface
        public void hold(double s) {
            whileLoaded(() -> {
                loading.holdUs = Math.round(s * 1000000);
                if (session != null) {
                    session.holding = s > 0;
                }
            });
        }

        @JavascriptInterface
        public void over() {
            whileLoaded(() -> {
                if (live != null) {
                    live.end(true);
                    tell();
                }
            });
        }

        @JavascriptInterface
        public void stop() {
            main.post(NativeVideo.this::halt);
        }

        @JavascriptInterface
        public void free() {
            main.post(() -> {
                if (player != null) {
                    NativeVideo.this.free();
                }
            });
        }
    }
}
