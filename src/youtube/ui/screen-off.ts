// Screen off: the screen goes black while the sound plays on (music with the picture off), as Settings › Screen off
// says it goes: Old TV (the picture closes into a bright line, the line pulls in to a glowing dot that flares and is gone),
// Film iris (a soft-edged circle closes on the middle), Camera shutter (six blades close, turning), Theatre curtain
// (red curtains meet in the middle), Blinds (strips close from the top down), Sweep (black sweeps across with a soft
// edge), Slow fade, at once, or a different one each time (Random). The effects are drawn over everything: the video
// is the TV's own layer under the page, so it is never squeezed; black bars, curtains, a line and a dot move over it
// by the compositor, the iris and the shutter are drawn on a canvas made for them (at half the screen's size). Then
// the LG's panel goes off as LG's own Screen off does (the sound plays on): LG lets no app do that, but a rooted TV's
// Homebrew Channel runs it for the app; its state is asked while off, as the TV lights it again at a button press.
// Elsewhere (Android, a TV without it) the black page stays: on an OLED black is off anyway. A key wakes it and does
// nothing else (main.ts gives it every key first): any, or only the Screen off shortcut's button as Settings › Waking
// the screen says (others do nothing; the panel lit by the TV at one goes dark again); waking plays the style
// backwards, quicker, from the key on (the panel lit alongside). Both start fast,
// easing out. Leaving the app wakes it at once. Choosing a style in Settings shows it (black for a moment, the panel left
// on). Styled by app.css (by-screen-off: its layers' places and looks).

import { h, LAYOUT_HEIGHT, LAYOUT_WIDTH } from '../core/dom.js';
import { Bridge, lunaCall, LunaReply } from '../core/luna.js';
import { takesPointer } from '../core/pointer.js';
import { prefs } from '../api/prefs.js';
import { wakeKey } from '../api/shortcuts.js';

/** Settings' preview: black this long, then it wakes */
var PREVIEW_MS = 1200;
/** The Homebrew Channel's service: runs a command as root for an app (the TV's power service denies apps the panel) */
var EXEC = 'luna://org.webosbrew.hbchannel.service/exec';
var POWER = 'luna://com.webos.service.tvpower/power/';
/** While the panel is off, its state is asked this often (a button lights it: the TV's own doing) */
var PANEL_POLL_MS = 1500;
/** The panel lit by the TV at a button goes dark again after this long with Settings › Waking the screen at Screen
 * off's button, unless that button came meanwhile (keys arrive at once: it was another) */
var DARK_AGAIN_MS = 800;
var OUT = 'cubic-bezier(.16,1,.3,1)';
/** Blinds: so many strips, each starting this much after the one above */
var BLINDS = 9;
var BLIND_STEP_MS = 50;
/** The styles Random picks from */
var STYLES = ['crt', 'iris', 'shutter', 'curtain', 'blinds', 'sweep', 'fade'];

/** 'on', 'going' (its animation), 'off', 'waking' (its animation) */
var state = 'on';
/** The LG's panel is off by the app; the bridges asking (kept until they answer: a dropped one loses its reply), the
 * timer asking its state */
var panelOff = false;
var asking: Bridge[] = [];
var pollTimer = 0;
/** The style going off (Random's pick), which waking plays backwards */
var style = '';
/** Told when the screen goes off (its animation starts) and when it is on again (the player's live chat waits) */
var listeners: (() => void)[] = [];
var root: HTMLElement | null = null;
var parts: Parts | null = null;
var canvas: HTMLCanvasElement | null = null;
var timers: number[] = [];
var frame = 0;

interface Parts {
    wash: HTMLElement;
    top: HTMLElement;
    bottom: HTMLElement;
    line: HTMLElement;
    dot: HTMLElement;
    left: HTMLElement;
    right: HTMLElement;
    sweep: HTMLElement;
    blinds: HTMLElement[];
    black: HTMLElement;
}

/** Turns the screen off as Settings say (show: Settings' preview, black for a moment) */
export function screenOff(show?: boolean): void {
    if (state !== 'on') {
        return;
    }
    build();
    stop();
    var chosen = prefs().screenOff;
    style = chosen === 'random' ? STYLES[Math.floor(Math.random() * STYLES.length)] : chosen;
    setState('going');
    var p = parts!;
    var done = function (): void {
        blackOut();
        if (show) {
            later(PREVIEW_MS, wake);
        } else {
            panelDark();
        }
    };
    prepare();
    (root as HTMLElement).style.display = '';
    var run = function (): void {
        if (style === 'crt') {
            move(p.top, { webkitTransform: 'translateY(0)' }, 280, OUT);
            move(p.bottom, { webkitTransform: 'translateY(0)' }, 280, OUT);
            move(p.wash, { opacity: '.55' }, 280, OUT);
            move(p.line, { opacity: '1' }, 220, 'ease-in');
            later(280, function () {
                move(p.line, { webkitTransform: 'scaleX(.004)' }, 200, 'cubic-bezier(.6,0,.9,.4)');
                move(p.wash, { opacity: '0' }, 120, 'linear');
                move(p.dot, { opacity: '1' }, 120, 'linear');
            });
            // The dot goes out with a bang: a last flare, then gone
            later(480, function () {
                move(p.line, { opacity: '0' }, 60, 'linear');
                move(p.dot, { webkitTransform: 'scale(1.6)' }, 70, OUT);
            });
            later(550, function () {
                move(p.dot, { opacity: '0', webkitTransform: 'scale(.1)' }, 130, 'ease-in');
            });
            later(700, done);
        } else if (style === 'iris' || style === 'shutter') {
            draw(style, 1, 0, style === 'iris' ? 900 : 850, function (k) { return 1 - Math.pow(1 - k, 3); }, done);
        } else if (style === 'curtain') {
            move(p.left, { webkitTransform: 'translateX(0)' }, 1000, OUT);
            move(p.right, { webkitTransform: 'translateX(0)' }, 1000, OUT);
            later(1000, function () { move(p.black, { opacity: '1' }, 300, 'ease-in'); });
            later(1320, done);
        } else if (style === 'blinds') {
            p.blinds.forEach(function (b, i) {
                later(i * BLIND_STEP_MS, function () { move(b, { webkitTransform: 'scaleY(1)' }, 350, 'ease-out'); });
            });
            later((BLINDS - 1) * BLIND_STEP_MS + 370, done);
        } else if (style === 'sweep') {
            move(p.sweep, { webkitTransform: 'translateX(-200px)' }, 900, OUT);
            later(920, done);
        } else if (style === 'fade') {
            move(p.black, { opacity: '1' }, 1500, 'ease-out');
            later(1520, done);
        } else {
            done();
        }
    };
    // A frame first: the layers drawn (the line's glow, the curtains) before anything moves (None: black at once)
    if (style === 'none') {
        run();
    } else {
        frame = requestAnimationFrame(run);
    }
}

/** The screen is off (or going off, or coming back): it takes every key */
export function screenIsOff(): boolean {
    return state !== 'on';
}

/** Calls then each time the screen goes off or is on again */
export function onScreen(then: () => void): void {
    listeners.push(then);
}

/** Black over everything while off (null: on; the pointer's layer, a click there wakes it: core/pointer.ts) */
export function screenLayer(): HTMLElement | null {
    return state !== 'on' ? root : null;
}

/** Wakes the screen (a video cast to it, as Settings say) */
export function screenWake(): void {
    if (state !== 'on') {
        wake();
    }
}

/** A key while off wakes the screen if it is one that does (wakeKey) and does nothing else; false: the screen is on, the
 * key is the app's */
export function screenKey(code: number): boolean {
    if (state === 'on') {
        return false;
    }
    var only = wakeKey();
    if (!only || code === only) {
        wake();
    }
    return true;
}

/** Wakes the screen at once: the style backwards from the key on, the panel lit alongside (the TV lights it at a button
 * too: the picture there as soon as it shows); going off, it turns back from black */
function wake(): void {
    if (state === 'going') {
        stop();
        blackOut();
    }
    if (state !== 'off') {
        return;
    }
    panelLit();
    unblack();
}

/** The style backwards: black gives way to the picture */
function unblack(): void {
    stop();
    state = 'waking';
    var p = parts!;
    // Under the black: the style closed, drawn in a frame of its own before black gives way to it opening
    prepare();
    if (style === 'crt') {
        set(p.top, { webkitTransform: 'translateY(0)' });
        set(p.bottom, { webkitTransform: 'translateY(0)' });
        set(p.dot, { opacity: '0', webkitTransform: 'scale(.25)' });
        set(p.line, { opacity: '0', webkitTransform: 'scaleX(.004)' });
    } else if (style === 'curtain') {
        set(p.left, { webkitTransform: 'translateX(0)' });
        set(p.right, { webkitTransform: 'translateX(0)' });
    } else if (style === 'blinds') {
        p.blinds.forEach(function (b) { set(b, { webkitTransform: 'scaleY(1)' }); });
    } else if (style === 'sweep') {
        set(p.sweep, { webkitTransform: 'translateX(-200px)' });
    }
    var open = function (): void {
        if (style === 'crt') {
            set(p.black, { opacity: '0' });
            move(p.dot, { opacity: '1', webkitTransform: 'scale(1)' }, 120, 'ease-out');
            later(120, function () {
                set(p.wash, { opacity: '.5' });
                move(p.line, { opacity: '1', webkitTransform: 'scaleX(1)' }, 180, OUT);
                move(p.dot, { opacity: '0' }, 160, 'linear');
            });
            later(300, function () {
                move(p.top, { webkitTransform: 'translateY(-101%)' }, 260, OUT);
                move(p.bottom, { webkitTransform: 'translateY(101%)' }, 260, OUT);
                move(p.wash, { opacity: '0' }, 300, 'ease-out');
                move(p.line, { opacity: '0' }, 200, 'linear');
            });
            later(600, hide);
        } else if (style === 'iris' || style === 'shutter') {
            draw(style, 0, 1, 500, function (k) { return 1 - Math.pow(1 - k, 3); }, hide);
            set(p.black, { opacity: '0' });
        } else if (style === 'curtain') {
            move(p.black, { opacity: '0' }, 200, 'ease-out');
            later(200, function () {
                move(p.left, { webkitTransform: 'translateX(-101%)' }, 800, OUT);
                move(p.right, { webkitTransform: 'translateX(101%)' }, 800, OUT);
            });
            later(1020, hide);
        } else if (style === 'blinds') {
            set(p.black, { opacity: '0' });
            p.blinds.forEach(function (b, i) {
                later((BLINDS - 1 - i) * 40, function () { move(b, { webkitTransform: 'scaleY(0)' }, 300, 'ease-out'); });
            });
            later((BLINDS - 1) * 40 + 320, hide);
        } else if (style === 'sweep') {
            set(p.black, { opacity: '0' });
            move(p.sweep, { webkitTransform: 'translateX(' + LAYOUT_WIDTH + 'px)' }, 600, OUT);
            later(620, hide);
        } else if (style === 'fade') {
            move(p.black, { opacity: '0' }, 400, 'ease-out');
            later(420, hide);
        } else {
            hide();
        }
    };
    if (style === 'none') {
        open();
    } else {
        frame = requestAnimationFrame(open);
    }
}

/** Leaving the app wakes it at once (the panel lit) */
function away(): void {
    if (document.hidden && state !== 'on') {
        stop();
        panelLit();
        hide();
    }
}

/** A luna call run by the Homebrew Channel (a rooted TV); then the call's reply (null: none, or no Homebrew Channel) */
function rooted(method: string, params: object, then: (reply: LunaReply) => void): void {
    var bridge = lunaCall(EXEC, { command: 'luna-send -n 1 ' + POWER + method + ' \'' + JSON.stringify(params) + '\'' }, function (message: string, reply: LunaReply) {
        asking = asking.filter(function (b) { return b !== bridge; });
        var out: LunaReply = null;
        try {
            out = reply && reply.returnValue ? JSON.parse(String(reply.stdoutString)) : null;
        } catch (e) {
            // not JSON: no reply
        }
        then(out);
    });
    if (bridge) {
        asking.push(bridge);
    } else {
        then(null);
    }
}

/** The panel off (LG's own Screen off: "active", the TV's buttons light it again), then its state asked until it is
 * lit; a key that woke it before the TV answered lights it again at once */
function panelDark(): void {
    rooted('turnOffScreen', { standbyMode: 'active' }, function (reply) {
        if (reply && reply.returnValue) {
            panelOff = true;
            if (state === 'off') {
                poll();
            } else {
                panelLit();
            }
        }
    });
}

/** Its state asked while it is off: Active again, a button lit it */
function poll(): void {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(function () {
        rooted('getPowerState', {}, function (reply) {
            if (!panelOff) {
                return;
            }
            if (reply && reply.state === 'Active') {
                panelOff = false;
                // Lit by the TV at a button: the picture back at once; with Settings › Waking the screen at Screen
                // off's button, dark again unless that button came meanwhile
                if (state !== 'off') {
                    return;
                }
                if (wakeKey()) {
                    later(DARK_AGAIN_MS, function () {
                        if (state === 'off') {
                            panelDark();
                        }
                    });
                } else {
                    unblack();
                }
            } else {
                poll();
            }
        });
    }, PANEL_POLL_MS) as unknown as number;
}

/** The panel lit by the app (a key it heard; already lit, it stays so) */
function panelLit(): void {
    if (panelOff) {
        panelOff = false;
        clearTimeout(pollTimer);
        rooted('turnOnScreen', { standbyMode: 'active' }, function () { return undefined; });
    }
}

/** Black over everything, the effects at rest: off */
function blackOut(): void {
    set(parts!.black, { opacity: '1' });
    rest();
    state = 'off';
}

/** The layers gone, the effects at rest: on */
function hide(): void {
    rest();
    set(parts!.black, { opacity: '0' });
    (root as HTMLElement).style.display = 'none';
    setState('on');
}

/** On, or going off: those listening are told (off-ness is all they hear) */
function setState(to: string): void {
    var was = state !== 'on';
    state = to;
    if (was !== (to !== 'on')) {
        listeners.forEach(function (then) { then(); });
    }
}

/** The layers, made on first use: over everything (the player, YouTube's, the toasts), hidden while the screen is on */
function build(): void {
    if (root) {
        return;
    }
    var el = root = h('div', 'by-screen-off');
    var part = function (name: string): HTMLElement { return el.appendChild(h('div', 'by-screen-off-' + name)) as HTMLElement; };
    var blinds: HTMLElement[] = [];
    for (var i = 0; i < BLINDS; i++) {
        var b = part('blind');
        b.style.top = i * LAYOUT_HEIGHT / BLINDS + 'px';
        b.style.height = LAYOUT_HEIGHT / BLINDS + 1 + 'px';
        blinds.push(b);
    }
    parts = { wash: part('wash'), top: part('top'), bottom: part('bottom'), line: part('line'), dot: part('dot'), left: part('curtain'),
        right: part('curtain by-screen-off-curtain--right'), sweep: part('sweep'), blinds: blinds, black: part('black') };
    rest();
    set(parts.black, { opacity: '0' });
    el.style.display = 'none';
    // A click (the Magic Remote) wakes it, as any key
    takesPointer(el, function () { return {}; });
    document.body.appendChild(el);
    document.addEventListener('visibilitychange', away);
}

/** Only the style's own layers shown (the others make no layers of their own) */
function prepare(): void {
    var p = parts!;
    var uses: { [style: string]: HTMLElement[] } = {
        crt: [p.wash, p.top, p.bottom, p.line, p.dot], curtain: [p.left, p.right], blinds: p.blinds, sweep: [p.sweep]
    };
    var shown = uses[style] || [];
    [p.wash, p.top, p.bottom, p.line, p.dot, p.left, p.right, p.sweep].concat(p.blinds).forEach(function (el) {
        el.style.display = shown.indexOf(el) >= 0 ? '' : 'none';
    });
    // (the iris's and the shutter's canvas made now, a frame before they move: made as they started, that frame took
    // the TV 70 ms)
    if (style === 'iris' || style === 'shutter') {
        makeCanvas();
    }
}

/** The effects at rest: the bars, curtains, blinds and sweep out of sight, the line, dot and brightening gone, the
 * canvas let go */
function rest(): void {
    var p = parts!;
    set(p.wash, { opacity: '0' });
    set(p.top, { webkitTransform: 'translateY(-101%)' });
    set(p.bottom, { webkitTransform: 'translateY(101%)' });
    // (all but invisible, not none: their glow is drawn at the first frame, before they move)
    set(p.line, { opacity: '.01', webkitTransform: 'scaleX(1)' });
    set(p.dot, { opacity: '.01', webkitTransform: 'scale(1)' });
    set(p.left, { webkitTransform: 'translateX(-101%)' });
    set(p.right, { webkitTransform: 'translateX(101%)' });
    set(p.sweep, { webkitTransform: 'translateX(' + LAYOUT_WIDTH + 'px)' });
    p.blinds.forEach(function (b) { set(b, { webkitTransform: 'scaleY(0)' }); });
    if (canvas) {
        // (its pixels are let go)
        canvas.width = 0;
        (root as HTMLElement).removeChild(canvas);
        canvas = null;
    }
}

function stop(): void {
    timers.forEach(clearTimeout);
    timers = [];
    cancelAnimationFrame(frame);
}

function later(ms: number, then: () => void): void {
    timers.push(setTimeout(then, ms) as unknown as number);
}

/** Sets el's style at once */
function set(el: HTMLElement, style: { [name: string]: string }): void {
    el.style.webkitTransition = 'none';
    assign(el, style);
}

/** Moves el's style to these values over ms (from those set before: the style is read first, so it starts there) */
function move(el: HTMLElement, style: { [name: string]: string }, ms: number, ease: string): void {
    var names: string[] = [];
    for (var name in style) {
        names.push((name === 'webkitTransform' ? '-webkit-transform' : name) + ' ' + ms + 'ms ' + ease);
    }
    void el.offsetWidth;
    el.style.webkitTransition = names.join(', ');
    assign(el, style);
}

function assign(el: HTMLElement, style: { [name: string]: string }): void {
    for (var name in style) {
        (el.style as unknown as { [name: string]: string })[name] = style[name];
    }
}

/** The canvas the iris and the shutter are drawn on, at half the screen's size (scaled up by its CSS): made once per
 * showing, let go at rest */
function makeCanvas(): HTMLCanvasElement {
    if (!canvas) {
        canvas = h('canvas', 'by-screen-off-canvas') as HTMLCanvasElement;
        canvas.width = LAYOUT_WIDTH / 2;
        canvas.height = LAYOUT_HEIGHT / 2;
        (root as HTMLElement).insertBefore(canvas, parts!.black);
    }
    return canvas;
}

/** Film iris (a soft-edged circle) or Camera shutter (six blades round a turning hexagon) open in black, its size from
 * `from` to `to` (shares of the way to the corners) over ms; drawn at half the screen's size (scaled up by its CSS) */
function draw(kind: string, from: number, to: number, ms: number, ease: (k: number) => number, done: () => void): void {
    var w = LAYOUT_WIDTH / 2;
    var hgt = LAYOUT_HEIGHT / 2;
    var c = makeCanvas().getContext('2d') as CanvasRenderingContext2D;
    var far = Math.sqrt(w * w + hgt * hgt) / 2;
    var x = w / 2;
    var y = hgt / 2;
    var start = Date.now();
    var step = function (): void {
        var k = Math.min(1, (Date.now() - start) / ms);
        var share = from + (to - from) * ease(k);
        // (opaque: the frame before is painted over)
        c.globalCompositeOperation = 'source-over';
        c.fillStyle = '#000';
        c.fillRect(0, 0, w, hgt);
        if (share > 0) {
            c.globalCompositeOperation = 'destination-out';
            c.beginPath();
            if (kind === 'iris') {
                // Its edge soft over up to 20 pixels
                var r = far * share;
                var g = c.createRadialGradient(x, y, Math.max(0, r - Math.min(20, r / 2)), x, y, r);
                g.addColorStop(0, 'rgba(0,0,0,1)');
                g.addColorStop(1, 'rgba(0,0,0,0)');
                c.fillStyle = g;
                c.arc(x, y, r, 0, Math.PI * 2);
                c.fill();
            } else {
                shutter(c, x, y, far * 1.15 * share, (1 - share) * Math.PI / 3);
            }
        }
        if (k < 1) {
            frame = requestAnimationFrame(step);
        } else {
            done();
        }
    };
    step();
}

/** A camera shutter's opening: a hexagon of radius r turned by turn, and its six blades' edges running on from its
 * corners (drawn after the hole is cut) */
function shutter(c: CanvasRenderingContext2D, x: number, y: number, r: number, turn: number): void {
    var corner = function (i: number): number[] {
        var a = turn + i * Math.PI / 3;
        return [x + r * Math.cos(a), y + r * Math.sin(a)];
    };
    var first = corner(0);
    c.moveTo(first[0], first[1]);
    for (var i = 1; i < 6; i++) {
        var p = corner(i);
        c.lineTo(p[0], p[1]);
    }
    c.closePath();
    c.fill();
    // The blades: each edge carried on past its corner, faint against the black
    c.globalCompositeOperation = 'source-over';
    c.strokeStyle = 'rgba(70, 70, 70, .9)';
    c.lineWidth = 1.5;
    c.beginPath();
    for (var j = 0; j < 6; j++) {
        var a = corner(j);
        var b = corner(j + 1);
        c.moveTo(a[0], a[1]);
        c.lineTo(a[0] + (a[0] - b[0]) * 6, a[1] + (a[1] - b[1]) * 6);
    }
    c.stroke();
}
