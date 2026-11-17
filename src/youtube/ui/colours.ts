// The colour picker's arithmetic (views/colour-page.ts): any colour by a hue (0..359) and one of 54 shades of it, a grey
// column then muted to vivid across, light to dark down (the pure, loud colour among them); where a colour lies among
// them; a held arrow's step on the colour slider, growing as the progress bar's jump does (player/jump-keys.ts); a
// picture's main colours (the logo's); two colours mixed, their contrast, a channel in linear light and back (ui/theme.ts:
// the text's grey steps).

/** #rrggbb of a hue (degrees), saturation and lightness (0..1) */
export function hsl(h: number, s: number, l: number): string {
    var part = function (n: number): string {
        var k = (n + h / 30) % 12;
        var v = Math.round(255 * (l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
        return (v < 16 ? '0' : '') + v.toString(16);
    };
    return '#' + part(0) + part(8) + part(4);
}

/** A colour's hue (degrees), saturation and lightness (0..1), from #rrggbb */
export function toHsl(color: string): { h: number; s: number; l: number } {
    var n = parseInt(color.slice(1), 16);
    return hslOf(n >> 16 & 255, n >> 8 & 255, n & 255);
}

/** The same from its red, green and blue (0..255) */
function hslOf(red: number, green: number, blue: number): { h: number; s: number; l: number } {
    var r = red / 255;
    var g = green / 255;
    var b = blue / 255;
    var max = Math.max(r, g, b);
    var min = Math.min(r, g, b);
    var d = max - min;
    var l = (max + min) / 2;
    var h = !d ? 0 : max === r ? (g - b) / d : max === g ? 2 + (b - r) / d : 4 + (r - g) / d;
    return { h: (h * 60 + 360) % 360, s: d ? d / (1 - Math.abs(2 * l - 1)) : 0, l: l };
}

/** Relative luminance of #rrggbb (0 black to 1 white) */
export function luminance(color: string): number {
    var n = parseInt(color.slice(1), 16);
    return 0.2126 * toLinear(n >> 16 & 255) + 0.7152 * toLinear(n >> 8 & 255) + 0.0722 * toLinear(n & 255);
}

/** A channel (0..255, as the screen's values) in linear light (0..1), where brightness adds up */
export function toLinear(v: number): number {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** A channel in linear light (0..1) as the screen's value (0..255, not rounded: rgb rounds it) */
export function fromLinear(m: number): number {
    return 255 * (m <= 0.0031308 ? 12.92 * m : 1.055 * Math.pow(m, 1 / 2.4) - 0.055);
}

/** How two colours (#rrggbb) contrast (1 to 21; text reads from 4.5) */
export function contrast(a: string, b: string): number {
    var x = luminance(a);
    var y = luminance(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** Whether a value is a colour as the settings keep one (#rrggbb, lower case) */
export function isColour(value: string): boolean {
    return /^#[0-9a-f]{6}$/.test(value);
}

/** A colour typed (#rgb or #rrggbb, the # optional, any case) as #rrggbb in lower case; '' when it is none */
export function typedColour(text: string): string {
    var t = text.replace(/\s+/g, '').replace(/^#/, '').toLowerCase();
    if (/^[0-9a-f]{3}$/.test(t)) {
        t = t.charAt(0) + t.charAt(0) + t.charAt(1) + t.charAt(1) + t.charAt(2) + t.charAt(2);
    }
    return /^[0-9a-f]{6}$/.test(t) ? '#' + t : '';
}

/** The shades' columns (saturation: grey, then muted to vivid) and rows (lightness: light to dark; the pure colour at
 * 0.5, its fourth row) */
export var SHADE_S = [0, 0.15, 0.3, 0.45, 0.6, 0.72, 0.84, 0.93, 1];
export var SHADE_L = [0.9, 0.78, 0.64, 0.5, 0.36, 0.22];

/** The shade in column c and row r of hue h */
export function shade(h: number, c: number, r: number): string {
    return hsl(h, SHADE_S[c], SHADE_L[r]);
}

/** Where a colour lies among the shades: its hue (kept: keep, for a grey, which has none of its own), its nearest column
 * and row */
export function shadeOf(color: string, keep: number): { h: number; c: number; r: number } {
    var x = toHsl(color);
    var grey = x.s < 0.04;
    return { h: grey ? keep : Math.round(x.h) % 360, c: grey ? 0 : nearest(SHADE_S, x.s), r: nearest(SHADE_L, x.l) };
}

function nearest(list: number[], x: number): number {
    var best = 0;
    for (var i = 1; i < list.length; i++) {
        if (Math.abs(list[i] - x) < Math.abs(list[best] - x)) {
            best = i;
        }
    }
    return best;
}

/** A held arrow on the colour slider: one degree a press; held, the step doubles every HOLD_DOUBLE_MS once it has been
 * held HOLD_GROW_MS, up to HOLD_MOST, as the progress bar's jump grows (player/jump-keys.ts, there over seconds): with
 * the remote's repeats (the first ~560 ms after the press, then every ~120 ms) the whole way round takes about 3.3 s.
 * A press the same way within HOLD_GAP_MS of the one before continues the hold (longer than the wait for the first
 * repeat); the colour goes to the app once the keys have rested HOLD_REST_MS (longer than a busy TV's gap between two
 * repeats) */
export var HOLD_GAP_MS = 650;
export var HOLD_REST_MS = 300;
var HOLD_GROW_MS = 500;
var HOLD_DOUBLE_MS = 400;
var HOLD_MOST = 30;

/** The step of a press held for this long (ms; 0: a press of its own) */
export function holdStep(held: number): number {
    return Math.min(HOLD_MOST, Math.round(Math.pow(2, Math.max(0, held - HOLD_GROW_MS) / HOLD_DOUBLE_MS)));
}

/** How long the app waits to take what a key picked, the key gap ms after the one before (ms): a press of its own at
 * once (0), one soon after another (a held key's repeats) once the keys rest (HOLD_REST_MS): Settings › Theme's pages
 * over the app (views/colour-page.ts, views/icon-page.ts) and Loading spinner's preview (views/sign-preview.ts) */
export function holdRest(gap: number, within?: number): number {
    return gap < (within || HOLD_GAP_MS) ? HOLD_REST_MS : 0;
}

/** A hold as the remote's repeats alone make it (ms): keys closer than this (its repeats come ~120 ms apart on the TV)
 * are a held key; one a little slower is a press of its own. For a preview that costs next to nothing to show (the
 * loading sign's: one element), so quick single presses show it at once; the Colours and Icons pages keep HOLD_GAP_MS
 * (their try restyles the page, and must not at a held key's first repeat, ~560 ms after the press) */
export var REPEAT_GAP_MS = 250;

/** A picture's main colours, from its pixels (RGBA, as a canvas gives them; a small copy: 32 x 32): the clear ones
 * grouped by hue (24) and lightness (6), grey, near-black and near-white left out unless the picture is mostly those;
 * each group's colour its most vivid quarter (an average dulls it: its edges mix with what is beside them); the biggest
 * groups (3% of the picture at least), none alike, up to four, light to dark */
export function mainColours(data: ArrayLike<number>): string[] {
    var groups: { [key: string]: { px: number[][]; flat: boolean } } = {};
    var plain = 0;
    var all = 0;
    for (var i = 0; i + 3 < data.length; i += 4) {
        if (data[i + 3] < 200) {
            continue;
        }
        all++;
        var x = hslOf(data[i], data[i + 1], data[i + 2]);
        var flat = x.s < 0.18 || x.l < 0.07 || x.l > 0.94;
        if (flat) {
            plain++;
        }
        var key = flat ? 'g' + Math.round(x.l * 4) : Math.round(x.h / 15) % 24 + ':' + Math.min(5, Math.floor(x.l * 6));
        var g = groups[key] || (groups[key] = { px: [], flat: flat });
        g.px.push([data[i], data[i + 1], data[i + 2], x.s]);
    }
    var list: { px: number[][]; flat: boolean }[] = [];
    for (var k in groups) {
        if ((!groups[k].flat || plain > all * 0.6) && groups[k].px.length >= all * 0.03) {
            list.push(groups[k]);
        }
    }
    list.sort(function (a, b) { return b.px.length - a.px.length; });
    var out: string[] = [];
    for (var n = 0; n < list.length && out.length < 4; n++) {
        var top = list[n].px.sort(function (p, q) { return q[3] - p[3]; }).slice(0, Math.max(1, Math.floor(list[n].px.length / 4)));
        var sum = [0, 0, 0];
        top.forEach(function (p) { sum[0] += p[0]; sum[1] += p[1]; sum[2] += p[2]; });
        var color = rgb(sum[0] / top.length, sum[1] / top.length, sum[2] / top.length);
        if (out.every(function (o) { return apart(o, color) > 40; })) {
            out.push(color);
        }
    }
    return out.sort(function (a, b) { return toHsl(b).l - toHsl(a).l; });
}

/** Colour a (#rrggbb) mixed towards b by t (0: a, 1: b), channel by channel */
export function mix(a: string, b: string, t: number): string {
    var x = parseInt(a.slice(1), 16);
    var y = parseInt(b.slice(1), 16);
    var part = function (shift: number): number {
        return (x >> shift & 255) * (1 - t) + (y >> shift & 255) * t;
    };
    return rgb(part(16), part(8), part(0));
}

/** #rrggbb of a red, green and blue (0..255, rounded and kept within) */
export function rgb(r: number, g: number, b: number): string {
    var part = function (v: number): string {
        var n = Math.round(Math.max(0, Math.min(255, v)));
        return (n < 16 ? '0' : '') + n.toString(16);
    };
    return '#' + part(r) + part(g) + part(b);
}

/** How far apart two colours are (by channel, 0..441) */
function apart(a: string, b: string): number {
    var x = parseInt(a.slice(1), 16);
    var y = parseInt(b.slice(1), 16);
    var d = 0;
    for (var shift = 0; shift <= 16; shift += 8) {
        var e = (x >> shift & 255) - (y >> shift & 255);
        d += e * e;
    }
    return Math.sqrt(d);
}
