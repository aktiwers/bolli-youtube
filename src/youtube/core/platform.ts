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
     * blanks the screen a moment); 0: the TV's own rate again (shells built
     * before it: false) */
    preferFrameRate(hz: number): boolean;
    /** The display's maximum height in lines (its largest mode: 1080 on an
     * HD Chromecast) */
    screenHeight(): number;
    /** Whether a decoder here plays this video codec (avc1, vp9, av01) at
     * this size and frame rate (0: any); AV1 only in hardware. Missing in
     * shells built before it */
    decodes?(codec: string, width: number, height: number, fps: number): boolean;
    /** The device's maker, model and Android version. Missing in shells
     * built before it */
    device?(): string;
    /** Android's release version alone: "14". Missing in shells built
     * before it */
    osVersion?(): string;
    /** The logos the app can show on the home screen, their ids (ui/logo.ts)
     * with commas between ('' none). Missing in shells built before it */
    homeLogos?(): string;
    /** Asks for the logo of this id on the home screen: it shows there once
     * the app is off the screen. False: the shell has none of that id.
     * Missing in shells built before it */
    setHomeLogo?(id: string): boolean;
    /** The display's mode as JSON: hz (now), width and height (the mode's), rates (the modes' at that size), match
     * (Android's match-content-frame-rate choice: never, seamless, always), asked (the rate the app's window asks
     * for, 0 none); a field the device does not tell is left out. Missing in shells built before it */
    display?(): string;
    /** Android's own keyboard for the text field that has the focus (shown), or put away. Missing in shells built
     * before it, which bring none */
    keyboard?(shown: boolean): void;
    /** A key the page keeps, as now stored (null: removed), into the page's second copy, which a power cut cannot
     * break (core/store.ts); kept: that copy as JSON, each key with its value. Each asks the key the shell gave the
     * page in its address (#), which no frame of another site can read: without it nothing is kept and the copy is
     * empty. Missing in shells built before it */
    keep?(key: string, value: string | null, token: string): void;
    kept?(token: string): string;
}

/** webOS TV 1.x-2.x's old engine: promise.js stood in for its Promise and marked it (never where the engine names its
 * Chrome: webOS 3 and later, Android; nor without a page: the tests) */
export function oldEngine(): boolean {
    return typeof window !== 'undefined' && !!(window as unknown as { bolliOldEngine?: boolean }).bolliOldEngine && !/Chrome\//.test(navigator.userAgent);
}

/** The Android app around the page, or null (webOS, a browser) */
export function android(): AndroidShell | null {
    return (window as unknown as { BolliAndroid?: AndroidShell }).BolliAndroid || null;
}

/** Phones find the app by casting on the same network: LG's DIAL server answers for it; the Android app has none */
export function foundOnNetwork(): boolean {
    return !android();
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

/** The pointer's events never reach the app's elements (no native focus, text selection, scrolling or dragging): on
 * Android it is unused; on webOS core/pointer.ts takes them (its own listeners on document still get them) */
export function ignorePointer(): void {
    var events = ['mousemove', 'mousedown', 'mouseup', 'click', 'dblclick', 'mousewheel', 'wheel', 'contextmenu', 'mouseover',
        'mouseout', 'selectstart', 'dragstart'];
    var swallow = function (e: Event) {
        e.stopPropagation();
        e.preventDefault();
    };
    for (var i = 0; i < events.length; i++) {
        document.addEventListener(events[i], swallow, true);
    }
}
