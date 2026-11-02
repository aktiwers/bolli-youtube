// Device integration shared by the apps: webOS (LG TVs), or the Android app
// around the page (android/: Google TV, Android TV), which exposes its calls
// on the page as window.BolliAndroid.

/** The Android app's calls (MainActivity.java under android/) */
export interface AndroidShell {
    /** Leave the app: the launcher shows, the app stays ready behind it */
    exit(): void;
    /** Keep the screen on (no screensaver) while true */
    keepScreenOn(on: boolean): void;
    /** Starts Android's speech recognition; what was said goes to
     * window.bolliHeard. False: the device has none */
    listen(): boolean;
    canListen(): boolean;
    /** True when the TV runs at this refresh rate, or switches to it (only
     * when Google TV is set to always match the content's rate: the switch
     * blanks the screen a moment) */
    preferFrameRate(hz: number): boolean;
    /** The display's maximum height in lines (its largest mode: 1080 on an
     * HD Chromecast) */
    screenHeight(): number;
}

/** The Android app around the page, or null (webOS, a browser) */
export function android(): AndroidShell | null {
    return (window as unknown as { BolliAndroid?: AndroidShell }).BolliAndroid || null;
}

/** The device can turn speech into text (Android with speech recognition) */
export function canListen(): boolean {
    var shell = android();
    return !!shell && shell.canListen();
}

/** What the user says, as text (Android's speech recognition); false when
 * nothing can listen here */
export function listen(heard: (text: string) => void): boolean {
    var shell = android();
    if (!shell) {
        return false;
    }
    (window as unknown as { bolliHeard?: (text: string) => void }).bolliHeard = heard;
    return shell.listen();
}

/** Pictures at this refresh rate, where the TV lets the app ask (Android:
 * Google TV keeps its own rate unless the user lets apps switch it; webOS
 * follows the picture by itself) */
export function preferFrameRate(hz: number): void {
    var shell = android();
    if (shell) {
        shell.preferFrameRate(hz);
    }
}

/** Leave the app the way the remote's Back does: webOS shows what was before */
export function exitApp(): void {
    var shell = android();
    var ps = (window as unknown as { PalmSystem?: { platformBack?: () => void } }).PalmSystem;
    if (shell) {
        shell.exit();
    } else if (ps && ps.platformBack) {
        ps.platformBack();
    } else {
        window.close();
    }
}

/** The Magic Remote's pointer is never used: swallow its events in the app */
export function ignorePointer(): void {
    var events = ['mousemove', 'mousedown', 'mouseup', 'click', 'dblclick', 'mousewheel', 'wheel', 'contextmenu'];
    var swallow = function (e: Event) {
        e.stopPropagation();
        e.preventDefault();
    };
    for (var i = 0; i < events.length; i++) {
        document.addEventListener(events[i], swallow, true);
    }
}
