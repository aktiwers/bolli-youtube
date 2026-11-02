// The web app in a full-screen web view for Android TV and Google TV. The
// page is loaded from the APK's assets with access to every address, as webOS
// runs a packaged app. The page talks to the device through
// window.BolliAndroid (src/core/platform.ts); the remote's keys, which the web
// view never sees, are handed to it as the LG remote's codes
// (src/core/keys.ts).

package org.bolli.youtube;

import android.annotation.TargetApi;
import android.app.Activity;
import android.content.Intent;
import android.content.ComponentName;
import android.content.pm.ApplicationInfo;
import android.content.pm.ResolveInfo;
import android.graphics.Bitmap;
import android.graphics.Point;
import android.hardware.display.DisplayManager;
import android.os.Build;
import android.os.Bundle;
import android.speech.RecognizerIntent;
import android.view.Display;
import android.view.KeyEvent;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

public class MainActivity extends Activity {
    /** startActivityForResult's code for Android's speech recognition */
    private static final int LISTEN = 1;
    /** Google TV's own voice input (else Android asks which app listens) */
    private static final String TV_VOICE = "com.google.android.katniss";
    private WebView web;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            // DevTools over adb
            WebView.setWebContentsDebuggingEnabled(true);
        }
        web = new WebView(this);
        web.setBackgroundColor(getResources().getColor(R.color.background));
        WebSettings s = web.getSettings();
        if (BuildConfig.USER_AGENT != null) {
            s.setUserAgentString(BuildConfig.USER_AGENT);
        }
        // Frames of other sites (youtube.com) keep their cookies
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(true);
        s.setAllowUniversalAccessFromFileURLs(true);
        // The page is laid out at 1280 wide (its viewport) and drawn at the
        // screen's size
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(false);
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public Bitmap getDefaultVideoPoster() {
                // Nothing until a stream's first picture (the web view's own
                // poster is a grey play icon; webOS draws none)
                return Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888);
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
        web.loadUrl("file:///android_asset/index.html");
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
        web.onResume();
    }

    @Override
    protected void onDestroy() {
        // A web view is destroyed out of its window (also after recreate())
        ((ViewGroup) web.getParent()).removeView(web);
        web.destroy();
        super.onDestroy();
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
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
        int code = lgCode(e.getKeyCode());
        if (code == 0) {
            // Home, volume, the Assistant: the system's
            return super.dispatchKeyEvent(e);
        }
        // Down (also its repeats while held); up only for OK, as holding OK
        // is a key of its own (the page has no use for the others)
        boolean up = e.getAction() == KeyEvent.ACTION_UP;
        if (!up || code == 13) {
            web.evaluateJavascript("window.bolliKey&&bolliKey(" + code + "," + up + ")", null);
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
            // A search key (the Assistant key never comes: the system keeps it)
            case KeyEvent.KEYCODE_SEARCH: return 10084;
            default: return 0;
        }
    }

    /** The page's calls (src/core/platform.ts: AndroidShell); they come on a thread of their own */
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
            runOnUiThread(() -> startActivityForResult(intent, LISTEN));
            return true;
        }

        @JavascriptInterface
        public boolean preferFrameRate(float hz) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
                return false;
            }
            Display display = getWindowManager().getDefaultDisplay();
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

        @JavascriptInterface
        public void keepScreenOn(boolean on) {
            runOnUiThread(() -> web.setKeepScreenOn(on));
        }

        @JavascriptInterface
        public boolean canListen() {
            return !getPackageManager().queryIntentActivities(speech(), 0).isEmpty();
        }

        @JavascriptInterface
        public int screenHeight() {
            Display display = getWindowManager().getDefaultDisplay();
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
                Point size = new Point();
                display.getRealSize(size);
                return Math.min(size.x, size.y);
            }
            // (The largest mode: the UI often runs at 1080p on a 4K TV)
            int most = 0;
            for (Display.Mode m : display.getSupportedModes()) {
                most = Math.max(most, Math.min(m.getPhysicalWidth(), m.getPhysicalHeight()));
            }
            return most;
        }
    }
}
