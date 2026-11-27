package org.bolli.youtube;

import android.net.Uri;

import androidx.media3.common.C;
import androidx.media3.common.Format;
import androidx.media3.common.MimeTypes;
import androidx.media3.exoplayer.dash.manifest.AdaptationSet;
import androidx.media3.exoplayer.dash.manifest.BaseUrl;
import androidx.media3.exoplayer.dash.manifest.DashManifest;
import androidx.media3.exoplayer.dash.manifest.Period;
import androidx.media3.exoplayer.dash.manifest.RangedUri;
import androidx.media3.exoplayer.dash.manifest.Representation;
import androidx.media3.exoplayer.dash.manifest.SegmentBase;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/** A format of a video as the page sent it (src/youtube/android/native.ts: Sent), and the DASH description the player
 * takes a video's formats as: each a file with its init part and its index at the ranges given, so nothing is asked
 * of YouTube to describe them. The page sends the formats a switch in place may name: the video ones of one codec,
 * the audio ones of one type. */
final class Sent {
    /** The addresses the description names: the format's kind and place in the page's list, the address itself
     * looked up as a request is made (Ranged), so a renewed one is taken from then on */
    static final String SCHEME = "bolli";
    /** A request fetches about this long of the format, within these sizes (as player/dash.ts: YouTube slows one
     * long request down) */
    private static final double PIECE_S = 1.2;
    private static final long PIECE_MIN = 1024 * 1024;
    private static final long PIECE_MAX = 4 * 1024 * 1024;

    final boolean video;
    /** Its place in the page's list of its kind */
    final int index;
    volatile String url;
    final String container;
    final String codecs;
    final int width;
    final int height;
    final float fps;
    final int bitrate;
    /** The file's size (bytes) */
    final long length;
    final long initStart;
    final long initEnd;
    final long indexStart;
    final long indexEnd;
    /** By SABR (Sabr): how the server names it, and for an audio one its track and whether it has stable volume */
    final int itag;
    final long lmt;
    final String xtags;
    final String track;
    final boolean drc;

    private Sent(boolean video, int index, JSONObject o) throws JSONException {
        this.video = video;
        this.index = index;
        // (none where the format comes by SABR)
        url = o.optString("url");
        // 'video/mp4; codecs="avc1.64002A"'
        String mime = o.getString("mime");
        int cut = mime.indexOf(';');
        container = (cut < 0 ? mime : mime.substring(0, cut)).trim();
        int from = mime.indexOf('"');
        int to = mime.lastIndexOf('"');
        codecs = from >= 0 && to > from ? mime.substring(from + 1, to) : "";
        width = o.optInt("width");
        height = o.optInt("height");
        fps = (float) o.optDouble("fps", 0);
        bitrate = o.optInt("bitrate");
        length = o.optLong("length");
        // (a live stream's formats have neither: each segment is a file of its own)
        JSONArray init = o.optJSONArray("init");
        JSONArray at = o.optJSONArray("index");
        initStart = init != null ? init.getLong(0) : 0;
        initEnd = init != null ? init.getLong(1) : 0;
        indexStart = at != null ? at.getLong(0) : 0;
        indexEnd = at != null ? at.getLong(1) : 0;
        itag = o.optInt("itag");
        long modified = 0;
        try {
            modified = Long.parseLong(o.optString("lmt", "0"));
        } catch (NumberFormatException e) {
            // (none told: 0, as the page sends it)
        }
        lmt = modified;
        xtags = o.optString("xtags");
        track = o.optString("track");
        drc = o.optBoolean("drc");
    }

    /** The page's list of one kind */
    static List<Sent> list(JSONArray formats, boolean video) throws JSONException {
        List<Sent> out = new ArrayList<>();
        for (int i = 0; i < formats.length(); i++) {
            out.add(new Sent(video, i, formats.getJSONObject(i)));
        }
        return out;
    }

    /** The name the player's tracks carry for it */
    String id() {
        return String.valueOf(index);
    }

    /** The first whole ms at or after us: where a seek to a keyframe goes (Media3 seeks by ms; a keyframe's time cut
     * down to a whole ms lies before it, in the segment before, all of which would be decoded first: an MP4's are not
     * on whole ms), and the keyframes' times as the page is told them, in step with that */
    static long msAtOrAfter(long us) {
        return (us + 999) / 1000;
    }

    /** The name of a format: its kind and its place in the page's list of that kind */
    static String address(boolean video, int index) {
        return SCHEME + "://" + (video ? 'v' : 'a') + '/' + index;
    }

    String address() {
        return address(video, index);
    }

    /** The name of a live stream's segment of it (the player's number of the segment: Numbered) */
    String address(long segment) {
        return address() + '/' + segment;
    }

    /** What a name says: the format's kind, its place in the list, and (a live stream's) the segment */
    static boolean videoOf(Uri address) {
        return "v".equals(address.getHost());
    }

    static int placeOf(Uri address) {
        return Integer.parseInt(address.getPathSegments().get(0));
    }

    static long segmentOf(Uri address) {
        return Long.parseLong(address.getLastPathSegment());
    }

    /** How much of it one request fetches (bytes) */
    long piece() {
        return Math.max(PIECE_MIN, Math.min(PIECE_MAX, (long) (bitrate / 8.0 * PIECE_S)));
    }

    private Representation representation(Numbered live) {
        Format.Builder format = new Format.Builder().setId(id()).setContainerMimeType(container)
                .setSampleMimeType(MimeTypes.getMediaMimeType(codecs)).setCodecs(codecs).setAverageBitrate(bitrate);
        if (video) {
            format.setWidth(width).setHeight(height);
            if (fps > 0) {
                format.setFrameRate(fps);
            }
        }
        if (live != null) {
            return live.representation(format.build(), this);
        }
        RangedUri init = new RangedUri("", initStart, initEnd - initStart + 1);
        return Representation.newInstance(0, format.build(), Collections.singletonList(new BaseUrl(address())),
                new SegmentBase.SingleSegmentBase(init, 1, 0, indexStart, indexEnd - indexStart + 1));
    }

    private static AdaptationSet set(long id, int type, List<Sent> formats, Numbered live) {
        List<Representation> representations = new ArrayList<>();
        for (Sent f : formats) {
            representations.add(f.representation(live));
        }
        return new AdaptationSet(id, type, representations, Collections.emptyList(), Collections.emptyList(), Collections.emptyList());
    }

    /** A video of lengthMs (0: not known) as one period with its video formats and its audio ones; a live stream's
     * (live: its index) with its segments by that index and the length that tells */
    static DashManifest manifest(List<Sent> videos, List<Sent> audios, long lengthMs, Numbered live) {
        if (live != null) {
            lengthMs = live.lengthMs();
        }
        List<AdaptationSet> sets = new ArrayList<>();
        sets.add(set(0, C.TRACK_TYPE_VIDEO, videos, live));
        sets.add(set(1, C.TRACK_TYPE_AUDIO, audios, live));
        return new DashManifest(C.TIME_UNSET, lengthMs > 0 ? lengthMs : C.TIME_UNSET, 0, false, C.TIME_UNSET, C.TIME_UNSET, C.TIME_UNSET,
                C.TIME_UNSET, null, null, null, null, Collections.singletonList(new Period(null, 0, sets)));
    }
}
