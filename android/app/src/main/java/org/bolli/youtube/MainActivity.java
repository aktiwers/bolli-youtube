// The web app in a full-screen web view for Android TV and Google TV. The
// page is loaded from the APK's assets with access to every address, as webOS
// runs a packaged app. The page talks to the device through
// window.BolliAndroid (src/core/platform.ts); the remote's keys, which the web
// view never sees, are handed to it as the LG remote's codes
// (src/core/keys.ts). An app with an entry on the home screen for each of its
// logos (a flavour's manifest) shows the one the page asks for, switched once
// the app is off the screen.

package org.bolli.youtube;

import android.annotation.TargetApi;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.ComponentName;
import android.content.pm.ActivityInfo;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.Bitmap;
import android.graphics.Point;
import android.hardware.display.DisplayManager;
import android.media.MediaCodecInfo;
import android.media.MediaCodecList;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.speech.RecognizerIntent;
import android.util.TypedValue;
import android.view.Display;
import android.view.KeyEvent;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.view.inputmethod.InputMethodManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.UUID;

public class MainActivity extends Activity {
    /** startActivityForResult's code for Android's speech recognition */
    private static final int LISTEN = 1;
    /** Google TV's own voice input (else Android asks which app listens) */
    private static final String TV_VOICE = "com.google.android.katniss";
    /** The app's entries on the home screen, one for each logo, are named this and the logo's id (activity aliases
     * in a flavour's manifest; a flavour without them has the one entry of this activity) */
    private static final String LOGO = "org.bolli.logo.";
    private WebView web;
    /** Android's keyboard asked for the web view's text field, and put away (the page's calls, run on the app's own
     * thread) */
    private final Runnable showKeyboard = () -> ((InputMethodManager) getSystemService(INPUT_METHOD_SERVICE)).showSoftInput(web, 0);
    private final Runnable hideKeyboard = () -> ((InputMethodManager) getSystemService(INPUT_METHOD_SERVICE))
            .hideSoftInputFromWindow(web.getWindowToken(), 0);
    /** The page's text field has Android's keyboard (asked for, not put away since: the page's calls) */
    private volatile boolean typing;
    /** The logo the page asked for on the home screen (null: none asked) */
    private volatile String wantedLogo;
    /** Speech recognition is up over the app: the app is not left */
    private boolean listening;
    /** The viewer is leaving the app by their own doing (onUserLeaveHint), until it is back in front */
    private boolean leaving;
    /** The part only this app's build has (null: none) */
    private Extra extra;
    /** The key of the page's second copy of what it keeps (copy, keep, kept), given to the page in its address (#):
     * the bridge is in every frame of the web view, YouTube's own and other sites' too, and those cannot read the
     * page's address */
    private final String copyKey = UUID.randomUUID().toString();

    /** A part only one app's build has (BuildConfig.EXTRA names its class): given the web view before the page loads,
     * told when the app is off the screen and when it goes */
    public interface Extra {
        void attach(WebView web);
        void stop();
        void destroy();
    }

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            // DevTools over adb
            WebView.setWebContentsDebuggingEnabled(true);
        }
        web = new WebView(this);
        opaque(web);
        WebSettings s = web.getSettings();
        if (BuildConfig.USER_AGENT != null) {
            s.setUserAgentString(BuildConfig.USER_AGENT);
        }
        // Frames of other sites keep their cookies (a framed site stays signed in)
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(true);
        otherSitesFromFile(s);
        // The page is laid out at 1280 wide (its viewport) and drawn at the
        // screen's size
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(false);
        // The page's text at the page's own sizes: Android's text size
        // (Accessibility) would enlarge it inside boxes measured for it
        s.setTextZoom(100);
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public Bitmap getDefaultVideoPoster() {
                // Nothing until a stream's first picture (the web view's own
                // poster is a grey play icon; webOS draws none)
                return Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888);
            }

            @Override
            public void onPermissionRequest(PermissionRequest request) {
                // Protected media for YouTube's own pages alone (a film in
                // its player, framed in Bolli YouTube's page: asked of the
                // web view, which says no where nobody answers); all else
                // is refused
                Uri origin = request.getOrigin();
                String host = origin == null ? null : origin.getHost();
                boolean youtube = host != null && "https".equals(origin.getScheme())
                        && (host.equals("youtube.com") || host.endsWith(".youtube.com"));
                String media = PermissionRequest.RESOURCE_PROTECTED_MEDIA_ID;
                if (youtube && Arrays.asList(request.getResources()).contains(media)) {
                    request.grant(new String[] { media });
                } else {
                    request.deny();
                }
            }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                // The page's process was ended (memory, on a small device):
                // the app starts afresh instead of going with it
                recreate();
                return true;
            }
        });
        web.addJavascriptInterface(new Shell(), "BolliAndroid");
        setContentView(web);
        if (BuildConfig.EXTRA != null) {
            try {
                extra = (Extra) Class.forName(BuildConfig.EXTRA).getDeclaredConstructor().newInstance();
            } catch (ReflectiveOperationException e) {
                // (the build names its own class: one it has not is the build's fault, not to be run past)
                throw new IllegalStateException(e);
            }
            extra.attach(web);
        }
        web.loadUrl("file:///android_asset/index.html#" + copyKey);
    }

    @Override
    protected void onPause() {
        super.onPause();
        // The page hears visibilitychange (hidden) and stops what plays
        web.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        // (back from whatever was over the app, speech recognition too)
        listening = false;
        leaving = false;
        web.onResume();
    }

    @Override
    protected void onUserLeaveHint() {
        super.onUserLeaveHint();
        // (Home, or another app started from this one: the viewer's own doing)
        leaving = true;
    }

    @Override
    protected void onStop() {
        super.onStop();
        // Off the screen because the viewer left it (Home, out of the app, another app): the home screen's entry is
        // switched now. Switched while the app shows, Android would end the task started from the entry that goes
        // off, and close the app; so neither under the screen saver or in standby, where the app is still the one in
        // front and would be gone at the wake-up. The page asks for its logo at every start, so a switch not made now
        // is made when the viewer next leaves
        if (!listening && (leaving || isFinishing())) {
            showHomeLogo();
        }
        if (extra != null) {
            extra.stop();
        }
    }

    @Override
    protected void onDestroy() {
        if (extra != null) {
            extra.destroy();
        }
        // A web view is destroyed out of its window (also after recreate())
        ((ViewGroup) web.getParent()).removeView(web);
        web.destroy();
        super.onDestroy();
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == LISTEN) {
            listening = false;
        }
        if (request != LISTEN || result != RESULT_OK || data == null) {
            return;
        }
        ArrayList<String> said = data.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS);
        if (said != null && !said.isEmpty()) {
            web.evaluateJavascript("window.bolliHeard&&bolliHeard(" + JSONObject.quote(said.get(0)) + ")", null);
        }
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        int key = e.getKeyCode();
        // A keyboard's Enter while the page's text field has Android's
        // keyboard: the field's own, a key typed there (the page hands the
        // text over by it), where the remote's OK stays the app's (the
        // field left, it brings Android's keyboard back)
        if (typing && (key == KeyEvent.KEYCODE_ENTER || key == KeyEvent.KEYCODE_NUMPAD_ENTER)) {
            return super.dispatchKeyEvent(e);
        }
        int code = lgCode(key);
        if (code == 0) {
            // Home, volume, the Assistant: the system's
            return super.dispatchKeyEvent(e);
        }
        // Down, with whether it is a press and not a held key's repeat
        // (Android counts those); up only for OK, as holding OK is a key
        // of its own (the page has no use for the others)
        boolean up = e.getAction() == KeyEvent.ACTION_UP;
        if (!up || code == 13) {
            web.evaluateJavascript("window.bolliKey&&bolliKey(" + code + "," + up + "," + (e.getRepeatCount() == 0) + ")", null);
        }
        return true;
    }

    /** Android's speech recognition, in the app's language (BuildConfig; empty: the device's) */
    private static Intent speech() {
        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                .putExtra(RecognizerIntent.EXTRA_PROMPT, BuildConfig.SPEECH_PROMPT);
        if (!BuildConfig.SPEECH_LANGUAGE.isEmpty()) {
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, BuildConfig.SPEECH_LANGUAGE);
        }
        return intent;
    }

    /** The app's entries on the home screen that stand for a logo (none in a flavour without them) */
    private List<ActivityInfo> logoEntries() {
        List<ActivityInfo> entries = new ArrayList<>();
        try {
            ActivityInfo[] all = getPackageManager().getPackageInfo(getPackageName(),
                    PackageManager.GET_ACTIVITIES | PackageManager.MATCH_DISABLED_COMPONENTS).activities;
            if (all != null) {
                for (ActivityInfo a : all) {
                    if (a.name.startsWith(LOGO)) {
                        entries.add(a);
                    }
                }
            }
        } catch (PackageManager.NameNotFoundException e) {
            // (the app's own package: always there)
        }
        return entries;
    }

    /** Whether an entry is on: as it was switched, else as the manifest has it */
    private boolean isOn(ActivityInfo entry) {
        int state = getPackageManager().getComponentEnabledSetting(new ComponentName(this, entry.name));
        return state == PackageManager.COMPONENT_ENABLED_STATE_ENABLED
                || state == PackageManager.COMPONENT_ENABLED_STATE_DEFAULT && entry.enabled;
    }

    /** Shows the logo the page asked for on the home screen: its entry on, then the others off (so there is never
     * none); nothing where it is on already, or there is no entry of it. The app keeps running. */
    private void showHomeLogo() {
        String wanted = wantedLogo;
        if (wanted == null) {
            return;
        }
        wantedLogo = null;
        List<ActivityInfo> entries = logoEntries();
        ActivityInfo chosen = null;
        for (ActivityInfo a : entries) {
            if (a.name.equals(LOGO + wanted)) {
                chosen = a;
            }
        }
        if (chosen == null) {
            return;
        }
        PackageManager pm = getPackageManager();
        if (!isOn(chosen)) {
            pm.setComponentEnabledSetting(new ComponentName(this, chosen.name), PackageManager.COMPONENT_ENABLED_STATE_ENABLED,
                    PackageManager.DONT_KILL_APP);
        }
        for (ActivityInfo a : entries) {
            if (a != chosen && isOn(a)) {
                pm.setComponentEnabledSetting(new ComponentName(this, a.name), PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
                        PackageManager.DONT_KILL_APP);
            }
        }
    }

    /** The display's mode at its current resolution with this refresh rate, 0: none */
    @TargetApi(Build.VERSION_CODES.M)
    private static int modeAt(Display display, float hz) {
        Display.Mode now = display.getMode();
        for (Display.Mode m : display.getSupportedModes()) {
            if (m.getPhysicalWidth() == now.getPhysicalWidth() && m.getPhysicalHeight() == now.getPhysicalHeight()
                    && Math.abs(m.getRefreshRate() - hz) < 0.1f) {
                return m.getModeId();
            }
        }
        return 0;
    }

    /** The LG remote's code for an Android key (src/core/keys.ts), 0: not the app's */
    private static int lgCode(int key) {
        if (key >= KeyEvent.KEYCODE_0 && key <= KeyEvent.KEYCODE_9) {
            return 48 + key - KeyEvent.KEYCODE_0;
        }
        switch (key) {
            case KeyEvent.KEYCODE_DPAD_LEFT: return 37;
            case KeyEvent.KEYCODE_DPAD_UP: return 38;
            case KeyEvent.KEYCODE_DPAD_RIGHT: return 39;
            case KeyEvent.KEYCODE_DPAD_DOWN: return 40;
            case KeyEvent.KEYCODE_DPAD_CENTER:
            case KeyEvent.KEYCODE_ENTER:
            case KeyEvent.KEYCODE_NUMPAD_ENTER: return 13;
            // Esc: Back on the PC's keyboard in the emulator
            case KeyEvent.KEYCODE_BACK:
            case KeyEvent.KEYCODE_ESCAPE: return 461;
            case KeyEvent.KEYCODE_CHANNEL_UP:
            case KeyEvent.KEYCODE_PAGE_UP: return 33;
            case KeyEvent.KEYCODE_CHANNEL_DOWN:
            case KeyEvent.KEYCODE_PAGE_DOWN: return 34;
            case KeyEvent.KEYCODE_PROG_RED: return 403;
            case KeyEvent.KEYCODE_PROG_GREEN: return 404;
            case KeyEvent.KEYCODE_PROG_YELLOW: return 405;
            case KeyEvent.KEYCODE_PROG_BLUE: return 406;
            case KeyEvent.KEYCODE_GUIDE: return 458;
            // The media keys as LG's remote sends them; play/pause in one key as the browsers' code (Bolli Twitch
            // knew it from the web view before)
            case KeyEvent.KEYCODE_MEDIA_PLAY: return 415;
            case KeyEvent.KEYCODE_MEDIA_PAUSE: return 19;
            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE: return 179;
            case KeyEvent.KEYCODE_MEDIA_REWIND: return 412;
            case KeyEvent.KEYCODE_MEDIA_FAST_FORWARD: return 417;
            case KeyEvent.KEYCODE_MEDIA_STOP: return 413;
            case KeyEvent.KEYCODE_INFO: return 457;
            // A search key (the Assistant key never comes: the system keeps it)
            case KeyEvent.KEYCODE_SEARCH: return 10084;
            default: return 0;
        }
    }

    /** A decoder in hardware: Android 10 says so; before, Android's own software decoders are known by name */
    private static boolean inHardware(MediaCodecInfo info) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            return info.isHardwareAccelerated();
        }
        String name = info.getName().toLowerCase();
        return !name.startsWith("omx.google.") && !name.startsWith("c2.android.") && !name.contains(".sw.");
    }

    /** The TV's screen */
    private Display screen() {
        return ((DisplayManager) getSystemService(DISPLAY_SERVICE)).getDisplay(Display.DEFAULT_DISPLAY);
    }

    /** The web view opaque again, in the page's own colour (read as a
     * value: the calls that name a colour are out of use, or newer than
     * Android 5.1) */
    public static void opaque(WebView web) {
        TypedValue page = new TypedValue();
        web.getResources().getValue(R.color.background, page, true);
        web.setBackgroundColor(page.data);
    }

    /** The page is a file of the app's own and asks other sites (the
     * broadcaster's, YouTube's): allowed by a switch Android marks as
     * out of use, with nothing in its place short of serving the page
     * from an address */
    @SuppressWarnings("deprecation")
    private static void otherSitesFromFile(WebSettings s) {
        s.setAllowUniversalAccessFromFileURLs(true);
    }

    /** The screen's lines on Android 5.1, which names no modes: by the
     * call Android marks as out of use (the size the app is drawn at
     * lacks a navigation bar's lines where a device has one) */
    @SuppressWarnings("deprecation")
    private static int realLines(Display display) {
        Point size = new Point();
        display.getRealSize(size);
        return Math.min(size.x, size.y);
    }

    /** A decoder's word on a picture's size at a frame rate (0: any) */
    private static boolean sized(MediaCodecInfo.VideoCapabilities caps, int width, int height, double fps) {
        return fps > 0 ? caps.areSizeAndRateSupported(width, height, fps) : caps.isSizeSupported(width, height);
    }

    /** The page's calls (src/core/platform.ts: AndroidShell); they come on a thread of their own */
    /** The page's second copy (keep, kept): a power cut cannot break it, where the web view's own storage can lose
     * what was written after a write the cut broke (Android keeps the file before as a backup while it writes it anew
     * and syncs it to the disk, and goes back to the backup if a write did not end) */
    private SharedPreferences copy() {
        return getSharedPreferences("page-copy", MODE_PRIVATE);
    }

    private class Shell {
        @JavascriptInterface
        public void exit() {
            runOnUiThread(() -> moveTaskToBack(true));
        }

        @JavascriptInterface
        public boolean listen() {
            Intent intent = speech();
            List<ResolveInfo> listeners = getPackageManager().queryIntentActivities(intent, 0);
            if (listeners.isEmpty()) {
                return false;
            }
            ResolveInfo chosen = listeners.get(0);
            for (ResolveInfo r : listeners) {
                if (TV_VOICE.equals(r.activityInfo.packageName)) {
                    chosen = r;
                }
            }
            intent.setComponent(new ComponentName(chosen.activityInfo.packageName, chosen.activityInfo.name));
            runOnUiThread(() -> {
                listening = true;
                startActivityForResult(intent, LISTEN);
            });
            return true;
        }

        @JavascriptInterface
        public boolean preferFrameRate(float hz) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
                return false;
            }
            // 0: no wish, the TV's own rate again (after a video)
            if (hz <= 0) {
                runOnUiThread(() -> {
                    WindowManager.LayoutParams lp = getWindow().getAttributes();
                    if (lp.preferredDisplayModeId != 0) {
                        lp.preferredDisplayModeId = 0;
                        getWindow().setAttributes(lp);
                    }
                });
                return true;
            }
            Display display = screen();
            if (Math.abs(display.getMode().getRefreshRate() - hz) < 0.1f) {
                return true;
            }
            // A switch blacks the screen a moment (this HDMI has no seamless
            // one), and again on leaving: only when the user asked for it
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || getSystemService(DisplayManager.class)
                    .getMatchContentFrameRateUserPreference() != DisplayManager.MATCH_CONTENT_FRAMERATE_ALWAYS) {
                return false;
            }
            int mode = modeAt(display, hz);
            if (mode == 0) {
                return false;
            }
            // The window's wish holds while it shows; Google TV goes back to its own rate after
            runOnUiThread(() -> {
                WindowManager.LayoutParams lp = getWindow().getAttributes();
                lp.preferredDisplayModeId = mode;
                getWindow().setAttributes(lp);
            });
            return true;
        }

        /** Whether a decoder here plays this video codec (an MSE codec: avc1, vp9, av01) at this size and frame rate
         * (0: any); AV1 only in hardware (in software it is too slow for a TV box) */
        @JavascriptInterface
        public boolean decodes(String codec, int width, int height, double fps) {
            String mime = codec.startsWith("av01") ? "video/av01" : codec.startsWith("vp9") || codec.startsWith("vp09")
                    ? "video/x-vnd.on2.vp9" : "video/avc";
            boolean hardware = mime.equals("video/av01");
            for (MediaCodecInfo info : new MediaCodecList(MediaCodecList.REGULAR_CODECS).getCodecInfos()) {
                if (info.isEncoder() || hardware && !inHardware(info)) {
                    continue;
                }
                for (String type : info.getSupportedTypes()) {
                    if (!type.equalsIgnoreCase(mime)) {
                        continue;
                    }
                    MediaCodecInfo.VideoCapabilities caps = info.getCapabilitiesForType(type).getVideoCapabilities();
                    // (an upright picture also as the same one lying: decoders name their sizes lying, 1920x1088
                    // at most on many, and play 1080x1920 all the same; Android's own player asks them so too)
                    if (caps != null && (sized(caps, width, height, fps) || height > width && sized(caps, height, width, fps))) {
                        return true;
                    }
                }
            }
            return false;
        }

        @JavascriptInterface
        public void keepScreenOn(boolean on) {
            runOnUiThread(() -> web.setKeepScreenOn(on));
        }

        /** Android's own keyboard for the page's text field that has the
         * focus (the page asks: a focus a script gives brings none), or
         * put away; what was asked before and has not run yet is dropped
         * (a field left at once gets no keyboard after it). Its own Back
         * puts it away with nothing told: the page learns of that by the
         * next OK or arrow that reaches it, which the keyboard would have
         * taken */
        @JavascriptInterface
        public void keyboard(boolean shown) {
            typing = shown;
            web.removeCallbacks(showKeyboard);
            web.removeCallbacks(hideKeyboard);
            web.post(shown ? showKeyboard : hideKeyboard);
        }

        @JavascriptInterface
        public String device() {
            return Build.MANUFACTURER + " " + Build.MODEL + ", Android " + Build.VERSION.RELEASE;
        }

        /** Android's release version alone ("14"), as the version check names it */
        @JavascriptInterface
        public String osVersion() {
            return Build.VERSION.RELEASE;
        }

        /** The logos the home screen can show the app with: their ids, commas between ("": this app has one entry) */
        @JavascriptInterface
        public String homeLogos() {
            StringBuilder ids = new StringBuilder();
            for (ActivityInfo a : logoEntries()) {
                ids.append(ids.length() > 0 ? "," : "").append(a.name.substring(LOGO.length()));
            }
            return ids.toString();
        }

        /** The page asks for this logo on the home screen: shown once the app is off the screen (onStop). False:
         * there is no entry of it */
        @JavascriptInterface
        public boolean setHomeLogo(String id) {
            for (ActivityInfo a : logoEntries()) {
                if (a.name.equals(LOGO + id)) {
                    wantedLogo = id;
                    return true;
                }
            }
            return false;
        }

        @JavascriptInterface
        public boolean canListen() {
            return !getPackageManager().queryIntentActivities(speech(), 0).isEmpty();
        }

        /** The display's mode for Stats for nerds, as JSON (src/core/platform.ts display): hz, width, height, rates
         * (the modes' at this size), match (the user's match-content-frame-rate choice), asked (the rate this window
         * asks for, 0 none); what the API level does not tell is left out */
        @JavascriptInterface
        public String display() {
            JSONObject o = new JSONObject();
            try {
                Display display = screen();
                o.put("hz", display.getRefreshRate());
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    Display.Mode now = display.getMode();
                    o.put("width", now.getPhysicalWidth());
                    o.put("height", now.getPhysicalHeight());
                    int asked = getWindow().getAttributes().preferredDisplayModeId;
                    JSONArray rates = new JSONArray();
                    for (Display.Mode m : display.getSupportedModes()) {
                        if (m.getPhysicalWidth() == now.getPhysicalWidth() && m.getPhysicalHeight() == now.getPhysicalHeight()) {
                            rates.put((double) m.getRefreshRate());
                        }
                        if (asked != 0 && m.getModeId() == asked) {
                            o.put("asked", m.getRefreshRate());
                        }
                    }
                    o.put("rates", rates);
                }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    int match = getSystemService(DisplayManager.class).getMatchContentFrameRateUserPreference();
                    o.put("match", match == DisplayManager.MATCH_CONTENT_FRAMERATE_ALWAYS ? "always"
                            : match == DisplayManager.MATCH_CONTENT_FRAMERATE_SEAMLESSS_ONLY ? "seamless"
                            : match == DisplayManager.MATCH_CONTENT_FRAMERATE_NEVER ? "never" : "unknown");
                }
            } catch (JSONException e) {
                // (a rate that is not a number: what was put so far)
            }
            return o.toString();
        }

        /** A key the page keeps, as it is now stored there (null: removed), into its second copy (src/youtube/core/
         * store.ts), for the page that has the copy's key alone and for the page's own keys: written in the
         * background, at once */
        @JavascriptInterface
        public void keep(String key, String value, String token) {
            if (copyKey.equals(token) && key != null && key.startsWith("bolli.")) {
                copy().edit().putString(key, value).apply();
            }
        }

        /** The page's second copy, as JSON (each key with its value), for the page that has its key alone */
        @JavascriptInterface
        public String kept(String token) {
            return copyKey.equals(token) ? new JSONObject(copy().getAll()).toString() : "{}";
        }

        @JavascriptInterface
        public int screenHeight() {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
                return realLines(screen());
            }
            // (The largest mode: the UI often runs at 1080p on a 4K TV)
            int most = 0;
            for (Display.Mode m : screen().getSupportedModes()) {
                most = Math.max(most, Math.min(m.getPhysicalWidth(), m.getPhysicalHeight()));
            }
            return most;
        }
    }
}
