// Themes. Views build neutral markup (bd-* and by-* class names); a theme is
//  - a stylesheet (colours, fonts, focus look) in
//    apps/bolli-youtube/themes/<id>.css, on top of the base themes/base.css,
//  - metrics: the sizes views lay out, scroll and request thumbnails with, and
//  - layouts: which of the layouts the app has built its screens use (the viewer's own choice in Settings goes
//    before the theme's).
// Chrome 38 has no CSS variables, so a theme is a whole stylesheet, and its light look a sheet of colours over it
// (showLight); the colours chosen in Settings are rules made here (applyLook). Sizes are in 1280x720 layout units
// (index.html zooms to the screen).

import { h } from '../core/dom.js';
import { tr } from '../core/i18n.js';
import { Prefs, prefs, setPref, setPrefs } from '../api/prefs.js';
import { contrast, fromLinear, hsl, luminance, mix, rgb, toHsl, toLinear } from './colours.js';
import { HIGHLIGHT_RULES, RAIL_TEXT_RULES, TEXT_RULES } from './highlight.gen.js';
import { ICON_STYLES, setIconStyle, setRailSet } from './icons.js';
import { logoValue, showLogo } from './logo.js';
import { RAIL_SETS } from './rail-icons.js';
import { LOADING_SIGNS } from './signs.js';
import { TileLayout, TileShape } from './tile-row.js';

export interface Metrics {
    /** Left rail: width (where screens start), first entry's top, entry spacing, bottom entry's top */
    rail: { width: number; top: number; step: number; bottom: number };
    /** Where Search's focused results row lands (under the field) */
    searchRowsTop: number;
    /** Subscriptions: first row's top under the channels and pills; channel spacing */
    subscriptionsTop: number;
    subscriptionsStep: number;
    /** Subscriptions' videos, as YouTube's TV app lays them out: the grid's lines `pitch` apart, the row above them
     * (YouTube's first shelf) with its tiles `head` under its name. With the channels at the side: a focused line's
     * tiles land at `top` (a channel's list, under its taller heading: `channelTop`), the row's name `nameUp` above
     * that; the videos stand `shift` further right while the column shows; the column's items are `item` high, its
     * "A-Z" label `label`, and `view` of it is in sight */
    subs: { pitch: number; head: number; top: number; channelTop: number; nameUp: number; shift: number; item: number; label: number; view: number };
    /** Library: first row's top under the cards; card spacing */
    libraryTop: number;
    libraryStep: number;
    /** "Who's watching?": account spacing */
    whoStep: number;
    /** Tiles: Home's big first row, other rows */
    big: TileShape;
    /** With a big focused row (Home), rows start this much higher (heading closer to its tiles) */
    bigUp: number;
    tile: TileShape;
    /** A page grid (History, a playlist): as many per line as fit between the margins */
    grid: TileShape;
    /** Distance from a grid's heading (name and tabs) to its first line */
    gridHead: number;
    /** Distance between grid lines */
    gridPitch: number;
    /** Square tiles (podcasts, releases) and game boxes, as tall as other tiles */
    square: TileShape;
    game: TileShape;
    /** Poster tiles (Movies) and the wide focused poster */
    poster: TileShape;
    posterWide: TileShape;
    /** Playlist page (two columns): one video per line (thumbnail size, left, first line's top, line pitch) and the
     * title's position in the left column */
    list: { tile: TileShape; left: number; top: number; pitch: number; title: number };
    /** Rows outside Home: a row without a subtitle line sits plainUp higher; one with it is taller by `taller` */
    lineRows: { plainUp: number; taller: number };
    /** Library rows: their spacing, and the focused row's top once the cards have scrolled away */
    library: RowSpacing & { rowsTop: number };
    /** The rows' spacing (tile-row.ts) */
    rows: TileLayout;
    /** Where the focused row's heading lands when the screen scrolls */
    rowsTop: number;
    /** How much lower Home's first row sits while the search bar shows above it */
    searchBarSpace: number;
    /** Watch page (player/watch-page.ts): related-video tiles and spacing, first line's top (under the buttons),
     * where a focused line lands */
    watch: { tile: TileShape; rows: TileLayout; top: number; focusTop: number };
    /** Channel page: first row heading's top with the header shown and with focus in the rows; left margin (no rail) */
    channel: { rowsTop: number; rowsTopDown: number; pad: number };
    /** Full-screen page (History, a playlist): title top, grid top, right margin of the grid */
    page: { top: number; gridTop: number; right: number };
    /** Behaviour beyond looks (e.g. the YouTube TV app's, for the clone theme) */
    ways: ThemeWays;
}

/** Row spacing: pitch between row tops, tile offset for a row without a subtitle line (plainHead), extra height of a
 * row with one (taller) */
export interface RowSpacing {
    pitch: number;
    plainHead: number;
    taller: number;
}

/** homeBig: Home's focused row uses big tiles; pagesOverAll: pages hide the rail (back arrow, Left does not open it);
 * lowerCounts: "14k views" as the TV app writes it; words: replacements for YouTube's labels ("CC": "Subtitles");
 * ages: unit words for short ages ("2y ago": "2 yr ago"), singular and plural (absent: as YouTube has them) */
export interface ThemeWays {
    homeBig: boolean;
    pagesOverAll: boolean;
    lowerCounts: boolean;
    words: { [youtube: string]: string };
    ages?: { [unit: string]: string[] };
}

/** Rewrites counts and ages in the theme's style ("14k views", "2 yr ago") */
export function themed(s: string): string {
    var ways = metrics().ways;
    var ages = ways.ages;
    if (ways.lowerCounts) {
        s = s.replace(/(\d)([KMB])\b/g, function (all: string, digit: string, unit: string) {
            return digit + unit.toLowerCase();
        });
    }
    return ages ? s.replace(/\b(\d+)(mo|[smhdwy]) ago\b/g, function (all: string, n: string, unit: string) {
        var said = ages![unit];
        return said ? n + ' ' + said[n === '1' ? 0 : 1] + ' ago' : all;
    }) : s;
}

/** A label in the theme's wording ("CC": "Subtitles", in the app's language; else unchanged) */
export function word(s: string): string {
    var mine = metrics().ways.words[s];
    return mine !== undefined ? tr(mine) : s;
}

/** Where Subscriptions shows its channels: a column at the side (YouTube's TV app) or a row at the top (its phone
 * app; views/subscriptions.ts) */
export type SubsLayout = 'side' | 'top';

/** The layouts a theme has its screens in, of those the app has built */
export interface Layouts {
    subscriptions: SubsLayout;
}

export interface Theme {
    id: string;
    name: string;
    metrics: Metrics;
    layouts: Layouts;
}

var registry: { [id: string]: Theme } = {};
var current: Theme | null = null;

export function registerTheme(theme: Theme): void {
    registry[theme.id] = theme;
}

export function themes(): Theme[] {
    var out: Theme[] = [];
    for (var id in registry) {
        out.push(registry[id]);
    }
    return out;
}

/** Applies a theme by id (else the first registered) and loads its stylesheet (its light one under a light
 * background) */
export function applyTheme(id: string): Theme {
    current = registry[id] || themes()[0];
    applyLook();
    return current;
}

/** Settings › Theme › Colours › Background's own two: YouTube's dark page (the theme's stylesheet as it is) and its light one (the
 * theme's light stylesheet, made by tools/light_theme.mjs) */
export var YOUTUBE_DARK = '#0f0f0f';
export var YOUTUBE_LIGHT = '#ffffff';

/** Settings › Theme's parts a look is made of, each a colour ('' its own: the background YouTube's dark, the sidebar as
 * the background, the highlight YouTube's: white on a dark page, black on a light one), its font ('' YouTube's
 * Roboto, or one of FONTS), its icons' style ('' filled, or one of ui/icons.ts ICON_STYLES), the sidebar's icons ('' as
 * the others, or one of ui/rail-icons.ts RAIL_SETS), and the background's and
 * the sidebar's style ('' solid, or one of STYLES). The text's colour: '' automatic (autoText); whether the sidebar's
 * names and icons take it too (sidebarText: 'on', or '' the sidebar's own). Settings › Theme's Logo (ui/logo.ts
 * logoValue: a built-in one's id, the account's picture, a custom one, none) and Loading spinner (one of ui/spinner.ts
 * LOADING_SIGNS): a look shows these on top of the account's own where it names them, never setting them (ON_TOP) */
export type LookPart = 'background' | 'sidebar' | 'highlight' | 'text' | 'font' | 'icons' | 'railIcons' | 'backgroundStyle' | 'sidebarStyle' |
    'sidebarText' | 'logo' | 'startSign';

/** The styles a background can have besides solid (Settings › Theme › Colours), each a still picture made from its
 * colour (styleCss); the sidebar's: those that stay right when its strip is stretched open (no pattern) */
export var STYLES = ['fade', 'glow', 'blend', 'lines', 'dots'];
export var SIDEBAR_STYLES = ['fade', 'glow', 'blend'];

/** The fonts of the app's own besides Roboto and Inter (SIL Open Font License 1.1: fonts/LICENSE-<family>.txt, from
 * Fontsource 5.3.0): each its family, its files' name (fonts/<file>-<subset>-<weight>-normal.woff: WOFF, as the TV's
 * browser reads no WOFF2), its weights, and whether it has Cyrillic letters. Their faces are not in a stylesheet: each
 * face declared costs every start ~1 ms on the TV (63 of them: ~60 ms, 2026-11-16), so only the chosen font's are
 * written, when it is chosen (fontFaces) */
var OWN_FONTS: { [id: string]: { family: string; file: string; weights: number[]; cyrillic: boolean } } = {
    google: { family: 'Google Sans Flex', file: 'google-sans-flex', weights: [400, 500, 700], cyrillic: false },
    geist: { family: 'Geist', file: 'geist', weights: [400, 500, 700], cyrillic: true },
    bricolage: { family: 'Bricolage Grotesque', file: 'bricolage-grotesque', weights: [400, 500, 700], cyrillic: false },
    nunito: { family: 'Nunito', file: 'nunito', weights: [400, 500, 700], cyrillic: true },
    atkinson: { family: 'Atkinson Hyperlegible', file: 'atkinson-hyperlegible', weights: [400, 700], cyrillic: false },
    space: { family: 'Space Grotesk', file: 'space-grotesk', weights: [400, 500, 700], cyrillic: false },
    plex: { family: 'IBM Plex Mono', file: 'ibm-plex-mono', weights: [400, 500, 700], cyrillic: true },
    exo: { family: 'Exo 2', file: 'exo-2', weights: [400, 500, 700], cyrillic: true },
    oswald: { family: 'Oswald', file: 'oswald', weights: [400, 500, 700], cyrillic: true },
    barlow: { family: 'Barlow Condensed', file: 'barlow-condensed', weights: [400, 500, 700], cyrillic: false },
    pixel: { family: 'Pixelify Sans', file: 'pixelify-sans', weights: [400, 500, 700], cyrillic: true },
    vcr: { family: 'VT323', file: 'vt323', weights: [400], cyrillic: false }
};

/** The letters each subset's file has (Google's subsets, as Roboto's in themes/base.css): a file is loaded only when a
 * text needs one of them */
var SUBSETS: { [subset: string]: string } = {
    'latin': 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD',
    'latin-ext': 'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF',
    'cyrillic': 'U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116'
};

/** Settings › Theme › Font's others than YouTube's Roboto: the CSS each is (Inter: Bolli Twitch's, its faces in
 * themes/base.css; the TV's own: no font file loaded at all). A font loads only once text uses it */
export var FONTS: { [id: string]: string } = { inter: "'Inter', sans-serif", system: 'sans-serif' };
Object.keys(OWN_FONTS).forEach(function (id) { FONTS[id] = "'" + OWN_FONTS[id].family + "', sans-serif"; });

/** The faces of font id (one of OWN_FONTS), as CSS; '' for any other */
export function fontFaces(id: string): string {
    var f = OWN_FONTS.hasOwnProperty(id) ? OWN_FONTS[id] : null;
    if (!f) {
        return '';
    }
    var css = '';
    f.weights.forEach(function (w) {
        (f!.cyrillic ? ['latin', 'latin-ext', 'cyrillic'] : ['latin', 'latin-ext']).forEach(function (sub) {
            css += "@font-face { font-family: '" + f!.family + "'; font-weight: " + w + '; src: url(fonts/' + f!.file + '-' + sub + '-' + w +
                "-normal.woff) format('woff'); unicode-range: " + SUBSETS[sub] + '; }\n';
        });
    });
    return css;
}

/** A part's value as it may be: a colour as #rrggbb in lower case, a font one of FONTS, a logo as ui/logo.ts logoValue
 * has it, the loading sign one of ui/spinner.ts LOADING_SIGNS; '' for anything else (its own; the logo and the loading
 * sign: not named) */
function valueOf(part: string, value: string | undefined): string {
    if (part === 'logo') {
        return logoValue(value);
    }
    if (part === 'startSign') {
        return value && LOADING_SIGNS.indexOf(value) >= 0 ? value : '';
    }
    if (part === 'font') {
        return value && FONTS.hasOwnProperty(value) ? value : '';
    }
    if (part === 'icons' || part === 'railIcons') {
        return value && (part === 'icons' ? ICON_STYLES : RAIL_SETS).indexOf(value) >= 0 ? value : '';
    }
    if (part === 'backgroundStyle' || part === 'sidebarStyle') {
        return value && (part === 'backgroundStyle' ? STYLES : SIDEBAR_STYLES).indexOf(value) >= 0 ? value : '';
    }
    if (part === 'sidebarText') {
        return value === 'on' ? value : '';
    }
    return value && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : '';
}

/** The parts a look shows on top of the account's own instead of setting them, each by where the look chosen keeps it
 * (prefs lookLogo, lookSign; written over one's own, Midnight's logo stayed under YouTube dark):
 * one that names them shows them, one that does not shows the account's own again. One chosen by hand (Settings › Theme ›
 * Logo, Loading spinner) is the account's own and takes the look's place on top (setLookPart). One's own look (Custom) and
 * a saved one name the ones shown: they bring them back */
export var ON_TOP: { [part: string]: 'lookLogo' | 'lookSign' } = { logo: 'lookLogo', startSign: 'lookSign' };

/** A part as set ('' its own); the logo and the loading sign as in force: the look's on top, else the account's own
 * (the player's sign: player/own-player.ts) */
export function lookPart(part: LookPart): string {
    var top = ON_TOP[part];
    return top && valueOf(part, prefs()[top]) || valueOf(part, prefs()[part]);
}

/** The background chosen (#rrggbb; YouTube's dark when none or not a colour) */
export function background(): string {
    return lookPart('background') || YOUTUBE_DARK;
}

/** Whether a background takes the light stylesheet (dark text): where dark text contrasts more than light text (the
 * same cut as textOn; the grey text then gets steps that read on it: step). The sheets' main text (#f1f1f1,
 * #0f0f0f) reads at 4:1 at worst, on the mid colours next to the cut */
export function isLight(color: string): boolean {
    return luminance(color) > 0.179;
}

/** The text that reads best on color: black or white, whichever contrasts more (one of them reaches 4.5:1 on any
 * colour; YouTube's near-black #0f0f0f would not on the colours near the cut) */
export function textOn(color: string): string {
    return isLight(color) ? '#000000' : '#ffffff';
}

/** The stylesheets' own main text: YouTube's near-black on a light page, its near-white on a dark one */
export function ownText(light: boolean): string {
    return light ? '#0f0f0f' : '#f1f1f1';
}

/** The page's grey text of the stylesheet's grey level (0..255) in the text's colour on back (#rrggbb, the background's
 * part the text reads least on): YouTube's greys are its near-white mixed towards its dark page, each by its own share
 * (t: #d0d0d0 0.15, #aaa 0.31, #8a8a8a 0.46), and the step is text mixed towards back by the same share, so a chosen
 * colour keeps YouTube's steps (on a light page the same: YouTube light's #606060 is its near-black 0.34 towards white).
 * Where that reads too little (4.5:1; 3:1 for the dimmer hints, under #9a), nearer the text by hundredths (the same ones
 * for every level: those that fall short meet on one, so a dimmer step is never the brighter), as far as the text
 * itself. searched: the search's outcomes kept for the other levels of the same text and back (stepRules) */
export function step(text: string, back: string, level: number, searched?: Searched): string {
    var floor = level >= 0x9a ? 4.5 : 3;
    var want = (0xf1 - level) / (0xf1 - 0x0f);
    var color = mix(text, back, want);
    if (contrast(color, back) >= floor) {
        return color;
    }
    var found = nearer(text, back, floor, Math.ceil(want * 100) - 1, searched || {});
    if (found.t >= want - 0.005) {
        return found.color;
    }
    // (the floor held it near the text, as a strong mid red on black: what it could not take towards the background
    // it takes towards a grey as bright as itself, so the step still shows, in a softer tone of the colour, and reads
    // as well; a dimmer level, further from the text, the greyer)
    // (mixed in linear light, where brightness adds up: mixed as the screen's values, the two would come out darker)
    var y = luminance(found.color);
    var k = Math.min(1, (want - found.t) * 1.6);
    var c = parseInt(found.color.slice(1), 16);
    var greyer = function (v: number): number {
        var lin = toLinear(v);
        return fromLinear(lin + (y - lin) * k);
    };
    var softer = rgb(greyer(c >> 16 & 255), greyer(c >> 8 & 255), greyer(c & 255));
    return contrast(softer, back) >= floor ? softer : found.color;
}

/** step's search nearer the text, by floor and the hundredth (of the way to back) it starts from: where it lands (t)
 * and the colour there */
interface Found {
    t: number;
    color: string;
}
type Searched = { [floorAndHundredth: string]: Found };

/** The first hundredth from `from` down that reads at floor (0: the text itself, never asked), and its colour. The
 * outcome depends on the floor and the hundredth only, not on the level that asks: kept in searched for every hundredth
 * passed on the way, so for one text and back the levels that fall short share one search per floor */
function nearer(text: string, back: string, floor: number, from: number, searched: Searched): Found {
    var n = from;
    var found = searched[floor + ' ' + n];
    for (; !found; found = searched[floor + ' ' + --n]) {
        var color = n > 0 ? mix(text, back, n / 100) : text;
        if (n <= 0 || contrast(color, back) >= floor) {
            found = { t: n > 0 ? n / 100 : 0, color: color };
            break;
        }
    }
    for (; from >= n; from--) {
        searched[floor + ' ' + from] = found;
    }
    return found;
}

/** rules (made by tools/light_theme.mjs) with their grey steps in text's colour on back ($S and the grey's level:
 * step), each level's worked out once, the levels' searches shared */
function stepRules(rules: string, text: string, back: string): string {
    var made: { [level: string]: string } = {};
    var searched: Searched = {};
    return rules.replace(/\$S(\d+)/g, function (all: string, level: string) {
        return made[level] || (made[level] = step(text, back, +level, searched));
    });
}

/** Of a background in a style, the part the text reads least on (a dark page's lightest part, a light one's darkest) */
function weakest(style: string, color: string): string {
    var parts = styleCss(style, color, 1).match(/#[0-9a-f]{6}/g) || [color];
    var light = isLight(color);
    var worst = color;
    parts.forEach(function (part) {
        if (light ? luminance(part) < luminance(worst) : luminance(part) > luminance(worst)) {
            worst = part;
        }
    });
    return worst;
}

/** The page's main text on a background (in its weakest part): the stylesheet's own (YouTube's near-white or near-black)
 * where it reads (4.5:1), else pure white or black, which reach that on every colour (YouTube's fall short on the
 * colours near the cut: 454 of the picker's 9720, down to 4.06:1, measured 2026-11-16) */
export function autoText(back: string): string {
    var own = ownText(isLight(back));
    return contrast(back, own) >= 4.5 ? own : textOn(back);
}

/** The automatic text for the look shown now (Settings › Theme › Colours › Text's "Automatic") */
export function autoTextNow(): string {
    return autoText(weakest(shown('backgroundStyle'), shown('background') || YOUTUBE_DARK));
}

/** A colour moved by amount of lightness away from the text on it (lighter under light text, darker under dark), but
 * never so far that the other text would read better: a style's every part takes the same text as its colour */
function away(color: string, amount: number): string {
    var x = toHsl(color);
    var light = isLight(color);
    for (var a = amount; a > 0.005; a -= 0.01) {
        var moved = hsl(x.h, x.s, Math.max(0, Math.min(1, x.l + (light ? -a : a))));
        if (isLight(moved) === light) {
            return moved;
        }
    }
    return color;
}

/** A style as a CSS background made from its colour (size: a pattern's scale, 1 on the screen): fade lighter (or
 * darker) towards the bottom, glow a soft light from the top-left corner, blend into the neighbouring hue corner to
 * corner, lines fine diagonal pinstripes, dots a faint grid of dots; '' solid. Still pictures (nothing moves in them)
 * and gradients only: no picture file to load */
export function styleCss(style: string, color: string, size: number): string {
    var px = function (n: number): string { return Math.round(n * size * 10) / 10 + 'px'; };
    switch (style) {
        case 'fade': return 'linear-gradient(to bottom, ' + color + ', ' + away(color, 0.16) + ')';
        case 'glow': return 'radial-gradient(ellipse 80% 70% at 15% 0%, ' + away(color, 0.18) + ', ' + color + ')';
        case 'blend':
            var x = toHsl(color);
            var other = hsl((x.h + 40) % 360, x.s, x.l);
            return 'linear-gradient(135deg, ' + color + ', ' + (isLight(other) === isLight(color) ? other : color) + ')';
        case 'lines':
            var near = away(color, 0.05);
            return 'repeating-linear-gradient(135deg, ' + color + ' 0px, ' + color + ' ' + px(12) + ', ' + near + ' ' + px(12) + ', ' + near + ' ' + px(14) + ')';
        case 'dots': return 'radial-gradient(' + away(color, 0.1) + ' ' + px(1.6) + ', rgba(0, 0, 0, 0) ' + px(2.2) + ') 0 0 / ' + px(22) + ' ' + px(22) + ', ' + color;
        default: return color;
    }
}

/** The rules giving the screens a background of their own: where the stylesheet's own page colour shows besides the
 * page itself (pageLook): the open rail's shade, the bars at the screens' tops, the backdrop of Settings' panel over
 * the app; the rings that cut a gap to it around focused things (the page's grey text: step); Live chat settings' panel
 * and Move and resize's hint over Settings' example picture, see-through as the sheet's (its colour alone, a style's
 * picture not: the example shows through; over a stream they are the player's, dark). The playlist beside a video keeps
 * the dark one under a light background (the player's look is dark) */
function backgroundRules(color: string, light: boolean, style: string, picture: string): string {
    var n = parseInt(color.slice(1), 16);
    var channels = (n >> 16 & 255) + ', ' + (n >> 8 & 255) + ', ' + (n & 255);
    var ring = ownText(light);
    var bars = '.by-search-top, .by-langs, .by-feed-top, .by-question, .by-channel-top, .by-shortcuts, .by-subs-top, .by-page-top, ' +
        '.by-settings-backdrop';
    // (a style: the bars over the screens' tops and the pages over the app show the same picture as the page under
    // them, pinned to the screen, so no band shows where they are; measured on the TV, 2026-11-16: Home's walk no
    // slower. The open rail's shade is stretched open: its own colour, solid)
    return '.by-rail--open .by-rail-shade' + (style ? '' : ', ' + bars) +
        // (a channel's banner, until its picture is there: under the channel's white name and buttons, so a dark one)
        (light ? '' : ', .by-channel-banner') + ' { background-color: ' + color + '; }\n' +
        (style ? bars + ' { background: ' + picture + '; background-attachment: fixed; }\n' : '') +
        '.by-subs-dot { box-shadow: 0 0 0 3px ' + color + '; }\n' +
        '.by-subs-item-dot { box-shadow: 0 0 0 2px ' + color + '; }\n' +
        '.by-subs-pill--focused { box-shadow: 0 0 0 2px ' + color + ', 0 0 0 5px ' + ring + '; }\n' +
        '.by-library-card--focused { box-shadow: 0 0 0 4px ' + color + ', 0 0 0 7px ' + ring + '; }\n' +
        '.by-peek-ring.by-peek-ring--stage { box-shadow: 0 0 0 6px ' + color + '; }\n' +
        // (the see-through pair, shared: themes/youtube.css by-chatset-panel)
        '.by-settings .by-chatset-panel { background-color: rgba(' + channels + ', ' + (light ? '.85' : '.6') + '); }\n' +
        '.by-settings .by-chatset-hint-text { background-color: rgba(' + channels + ', .9); }\n' +
        (light ? '' : '.by-list-panel--beside { background: ' + color + '; }\n' +
            '.by-list-band { background: linear-gradient(to right, rgba(' + channels + ', 0), rgba(' + channels + ', .82) 64px, rgba(' + channels +
            ', .9)); }\n');
}

/** A sidebar of its own colour: its strip's width while closed (short of the 98 px where a focused first tile's ring
 * begins: themes/youtube.css by-section) */
var STRIP = 90;

/** The sidebar (the rail) in a colour of its own: its strip, open and closed, and its divider and focus dark or light
 * for that colour, whatever the page's (the highlight, if set, then draws its focus); its names and icons: sidebarText.
 * The strip is STRIP wide, and the logo and the icons stand in its middle */
function sidebarRules(color: string, style: string): string {
    var light = isLight(color);
    var focus = ownText(light);
    var onFocus = ownText(!light);
    var picture = styleCss(style, color, 1);
    var shift = (metrics().rail.width - STRIP) / 2;
    // (closed: the strip under the icons only, so a focused tile's ring beside it shows whole; open: all of it. A
    // style: its picture the strip's size, no repeat; open, the whole shade's)
    var strip = style ? picture + ' 0 0 / ' + STRIP + 'px 100% no-repeat' : 'linear-gradient(to right, ' + color + ' ' + STRIP + 'px, rgba(0, 0, 0, 0) ' +
        STRIP + 'px)';
    return '.by-rail-shade { background: ' + strip + '; }\n' +
        '.by-rail--open .by-rail-shade { background: ' + picture + '; }\n' +
        // (themes/youtube.css stands them in the middle of the rail (metrics rail.width, 104 px), where YouTube's TV app
        // has them, which has no strip: on this narrower one they stood 7 px right of its middle, Arcade's icons 60 of the
        // screen's pixels from its left edge and 39 from its right, seen on the TV, 2026-11-17; now 50 and 49. Moved by
        // a margin, the stylesheet's own `left` as it is (not a transform: the open rail's items move up by one), their
        // names and the line between them with them, the logo's menu as far from it as before)
        '.by-rail-item, .by-rail-divider, .by-rail-logo, .by-rail-drop { margin-left: ' + -shift + 'px; }\n' +
        '.by-rail-divider { background: ' + (light ? 'rgba(0, 0, 0, .1)' : '#3f3f3f') + '; }\n' +
        '.by-rail-logo--none.by-rail-logo--focused { background-color: ' + (light ? 'rgba(0, 0, 0, .06)' : 'rgba(255, 255, 255, .12)') + '; }\n' +
        '.by-rail-item--focused { background-color: ' + focus + '; color: ' + onFocus + '; }\n' +
        '.by-rail--open .by-rail-item--focused { color: ' + onFocus + '; }\n' +
        '.by-rail-logo--focused { box-shadow: 0 0 0 4px ' + focus + '; }\n';
}

/** The sidebar's names and icons in text (the automatic one for a sidebar of its own colour: autoText; Settings › Theme ›
 * Colours › Text's "Sidebar too": the text's), those the stylesheet draws grey (an entry not the current one) in their
 * step (step) on back, the sidebar's weakest part (its own colour's, else the page's); the focused entry the sidebar's
 * or the highlight's (made from the stylesheet: highlight.gen.ts RAIL_TEXT_RULES) */
function sidebarText(text: string, back: string): string {
    return stepRules(RAIL_TEXT_RULES.split('$X').join(text), text, back) + '\n';
}

/** The focus drawn in color (Settings › Theme › Colours › Highlight): every rule that draws it on the page (made from
 * the stylesheet: highlight.gen.ts), the text on it the one that reads best and its grey text that same text softened
 * (YouTube's grey on its white box would hardly show on a colour), the gap a ring cuts to the page in the page's colour
 * (page) */
function highlightRules(color: string, page: string): string {
    var text = textOn(color);
    var grey = text === '#000000' ? 'rgba(0, 0, 0, .68)' : 'rgba(255, 255, 255, .78)';
    return HIGHLIGHT_RULES.split('$H').join(color).split('$T').join(text).split('$G').join(grey).split('$B').join(page) + '\n';
}

/** The look's rules, a style element each for the background's, the page's text's (its main text and its grey steps:
 * one list in the stylesheet's order, so that they win and lose among themselves as there), the sidebar's and the
 * highlight's, in that order (the later ones win where they meet), made together once one is needed; each made
 * anew only when what it is made from changed (rulesOf: a key per part; a preview changes one part, applyLook runs at
 * every one). Each rule names a class and none a tag alone:
 * then a change to one element's rules has the browser restyle only the elements of their classes; a rule for html
 * or body had it restyle the whole page at every change (1153 elements, ~50 ms on the TV, 2026-11-16). The page's
 * own colour and the font: pageLook */
var partStyles: HTMLStyleElement[] = [];
var rulesOf = ['', '', '', ''];

/** The rules of part i (partStyles' order), made by make ('' none) when its key ('' none) is not the one they were
 * made from */
function setRules(i: number, key: string, make: () => string): void {
    if (key === rulesOf[i]) {
        return;
    }
    rulesOf[i] = key;
    if (!partStyles.length) {
        if (!key) {
            return;
        }
        for (var n = 0; n < rulesOf.length; n++) {
            partStyles.push(document.head.appendChild(h('style')) as HTMLStyleElement);
        }
    }
    partStyles[i].textContent = key ? make() : '';
}

/** The page's own colour: an empty element under the app the size of the screen (made once a colour is chosen), in
 * that colour ('' the stylesheet's). Not body: once the look's rules had changed, the TV took the next change to
 * body's style as one to its font, which every element inherits, and restyled, laid out and repainted the whole page
 * (~0.45 s, 2026-11-16); a change to this element restyles it alone. The font is on body: a change to it is one to
 * every text anyway. Each set only when it changes (the values the browser reads back are written otherwise) */
var canvas: HTMLElement | null = null;
var pageColor = '';
var pageFont = '';

/** color: the page's own colour, or a style's picture made from it (styleCss) */
function pageLook(color: string, font: string): void {
    if (color !== pageColor) {
        pageColor = color;
        if (!canvas) {
            canvas = h('div', 'by-canvas');
            document.body.insertBefore(canvas, document.body.firstChild);
        }
        canvas.style.background = color;
    }
    if (font !== pageFont) {
        pageFont = font;
        document.body.style.fontFamily = font;
    }
}

/** The chosen font's faces (fontFaces) in an element of their own, made the first time a font of OWN_FONTS is chosen
 * (never switched off with a theme's sheet: its fonts would go with it); written only when the font changes */
var facesEl: HTMLStyleElement | null = null;
var facesOf = '';
function useFaces(id: string): void {
    var css = fontFaces(id);
    if (id === facesOf || !css && !facesEl) {
        return;
    }
    facesOf = id;
    if (!facesEl) {
        facesEl = document.head.appendChild(h('style')) as HTMLStyleElement;
    }
    facesEl.textContent = css;
}

/** Gives the screens the chosen look: the theme's stylesheet or its light one (by the background), the page's colour or
 * style (pageLook), and the rules for a background, a sidebar, a text or a highlight that is not the stylesheet's own;
 * the page's text, its grey in steps from it (stepRules), whenever the text or the page is not YouTube's own (none for
 * YouTube's own dark or light look). At the start (applyTheme) the dark stylesheet
 * index.html names is swapped before anything shows: the TV's loading screen stays until the app has drawn (captured
 * 2026-11-15: light Home straight after it), and a script in index.html reading this before the app made every start
 * ~10-20 ms later */
export function applyLook(): void {
    if (!current) {
        return;
    }
    var color = shown('background') || YOUTUBE_DARK;
    var light = isLight(color);
    var style = shown('backgroundStyle');
    var own = color === (light ? YOUTUBE_LIGHT : YOUTUBE_DARK) && !style;
    var side = shown('sidebar');
    var sideStyle = shown('sidebarStyle');
    var focus = shown('highlight');
    var font = shown('font');
    var picture = styleCss(style, color, 1);
    // (the text: the one chosen, else the automatic one where the stylesheet's own reads too little; a style judged
    // by its weakest part)
    var weak = style ? weakest(style, color) : color;
    var text = shown('text') || autoText(weak);
    // (the sidebar: its own colour, else the page's. Its names and icons: with "Sidebar too", in the text chosen; else
    // (Sidebar too with the text automatic, or a colour of its own) in the automatic text for the sidebar's weakest part
    // (the stylesheet's own where it reads); their steps read on that part. None where that is the stylesheet's own
    // sidebar as it is)
    var sideOwn = !!(side && side !== color || sideStyle);
    var sideColor = side || color;
    var sideBack = sideOwn ? weakest(sideStyle, sideColor) : weak;
    var sideText = shown('sidebarText') && shown('text') || (sideOwn || shown('sidebarText') ? autoText(sideBack) : '');
    if (!sideOwn && own && sideText === ownText(light)) {
        sideText = '';
    }
    showLight(light);
    useFaces(font);
    pageLook(own ? '' : picture, font ? FONTS[font] : '');
    setIconStyle(shown('icons'));
    setRailSet(shown('railIcons'));
    setRules(0, own ? '' : color + ' ' + style, function () { return backgroundRules(color, light, style, picture); });
    setRules(1, own && text === ownText(light) ? '' : text + ' ' + weak, function () {
        return stepRules(TEXT_RULES.split('$X').join(text), text, weak) + '\n';
    });
    setRules(2, (sideOwn ? sideColor + ' ' + sideStyle : '') + (sideText ? ' text ' + sideText + ' ' + sideBack : ''), function () {
        return (sideOwn ? sidebarRules(sideColor, sideStyle) : '') + (sideText ? sidebarText(sideText, sideBack) : '');
    });
    setRules(3, focus ? focus + ' ' + color : '', function () { return highlightRules(focus, color); });
    // (the logo: drawn anew in its places alone, and only where the one set (the look's on top, else the account's own)
    // is not the one drawn (ui/logo.ts showLogo); at the start, before anything draws it, nothing. Who's watching
    // (plain) leaves it as the account has it)
    showLogo();
}

/** The look's parts shown now: a look's in place of the chosen ones while one is (plainLook); one being tried on the app
 * (tryLook) in place of the one set */
function shown(part: LookPart): string {
    return plain ? valueOf(part, plain.parts[part] || '') : trying.hasOwnProperty(part) ? valueOf(part, trying[part]) : lookPart(part);
}

/** Sets a part (Settings › Theme › Colours, Font, Icons, Loading spinner) and shows it: what was tried of it ends, the look
 * is kept as Custom if it is one's own (keepCustom), and it is drawn in the frame after the next (also when nothing was
 * being tried: a colour typed, a pointer's click; the loading sign shows only as a video starts: nothing to draw). One of
 * ON_TOP chosen by hand is the account's own, and takes the look's place where one is on top (the look then Custom
 * unless it names the same: matchingLook; the Logo setting's own way: ui/logo.ts chooseLogo). One store write */
export function setLookPart(part: LookPart, value: string): void {
    var changes: { [name: string]: string } = {};
    changes[part] = value;
    var top = ON_TOP[part];
    if (top && prefs()[top]) {
        changes[top] = value;
    }
    setPrefs(changes as Partial<Prefs>);
    delete trying[part];
    keepCustom();
    if (part !== 'startSign') {
        applyLookSoon();
    }
}

/** The parts tried on the app now (Settings › Theme › Colours, Icons: the focus on a colour, a style or a set of icons:
 * views/colour-page.ts, views/icon-page.ts), not set */
var trying: { [part: string]: string } = {};

/** Shows a part on the app as value without setting it ('' its own), or the one set again (null); drawn in the frame
 * after the next, several meanwhile once (applyLookSoon). Of the parts Colours and Icons pick on the app: the logo and
 * the loading sign are never tried (the sign's own preview: views/sign-preview.ts) */
export function tryLook(part: LookPart, value: string | null): void {
    var was = trying.hasOwnProperty(part) ? trying[part] : null;
    if (value === was) {
        return;
    }
    if (value === null) {
        delete trying[part];
    } else {
        trying[part] = value;
    }
    applyLookSoon();
}

/** The look shown in place of the chosen one ("Who's watching?": the TV's, not one account's: a look of Theme's, built-in
 * or saved, unless the account says its own: Settings › Theme › Who's watching); null: the chosen one. Its colours,
 * font and icons only: the logo and the loading sign stay the account's as set (none of them shows there: pages hide
 * the rail, and no video starts) */
var plain: Look | null = null;

/** Look id (one of allLooks; one no longer listed: the first) shown in place of the chosen one (null: the chosen one
 * again), at once */
export function plainLook(id: string | null): void {
    var look = id === null ? null : lookOf(id);
    if ((plain ? plain.id : null) !== (look ? look.id : null)) {
        plain = look;
        applyLook();
    }
}

/** A look: its id, name and line, and the parts it sets (every other part its own: '') */
export interface Look {
    id: string;
    name: string;
    note: string;
    parts: { [part: string]: string };
}

/** The looks (Settings › Theme › Theme sets one's parts in one go; Settings › Theme › Who's watching shows one there):
 * YouTube's dark and light. A look added here is offered in both. Each names its loading sign and, but YouTube's, its
 * logo (YouTube's logo is a trademark: the account's own shows under YouTube's looks), shown on top of the account's own
 * (ON_TOP) */
export var LOOKS: Look[] = [
    { id: 'dark', name: tr('YouTube dark'), note: tr('YouTube\'s own dark colours'), parts: { background: YOUTUBE_DARK, startSign: 'youtube' } },
    { id: 'light', name: tr('YouTube light'), note: tr('YouTube\'s own light colours'), parts: { background: YOUTUBE_LIGHT, startSign: 'youtube' } },
    // (the app's maker's own, 2026-11-16)
    { id: 'bolli', name: 'Bolli', note: tr('black, with the red of the Bolli logo'),
        parts: { background: '#000000', highlight: '#b10c0a', logo: 'red', startSign: 'channel' } },
    // (each a mix of the parts a look has, made with the customisation options all of them)
    { id: 'midnight', name: 'Midnight', note: tr('a deep blue night with a soft glow, Apple-style letters and Fruit icons'),
        parts: { background: '#0b1222', backgroundStyle: 'glow', sidebar: '#0e1830', sidebarStyle: 'glow', highlight: '#4f8cff', text: '#e8eeff',
            sidebarText: 'on', font: 'inter', icons: 'soft', railIcons: 'soft', logo: 'midnight', startSign: 'midnight' } },
    { id: 'arcade', name: 'Arcade', note: tr('an old game console: pixel letters and pixel icons on a dotted purple'),
        parts: { background: '#14002b', backgroundStyle: 'dots', sidebar: '#1c0040', sidebarStyle: 'blend', highlight: '#ff2e88', text: '#ffe066',
            sidebarText: 'on', font: 'pixel', icons: 'pixel', railIcons: 'pixel', logo: 'arcade', startSign: 'arcade' } },
    { id: 'vhs', name: 'VHS', note: tr('a video recorder\'s screen: its green letters on fine black lines'),
        parts: { background: '#0c0c0c', backgroundStyle: 'lines', sidebar: '#101010', sidebarStyle: 'fade', highlight: '#2fae5a', text: '#9cf2b0',
            sidebarText: 'on', font: 'vcr', icons: 'vhs', railIcons: 'vhs', logo: 'vhs', startSign: 'vhs' } },
    { id: 'mission', name: 'Mission Control', note: tr('a space centre\'s screens: clean letters, glass icons, the elements in the sidebar'),
        parts: { background: '#071318', backgroundStyle: 'fade', sidebar: '#0a1c24', sidebarStyle: 'fade', highlight: '#00d1ff', text: '#d9f6ff',
            font: 'space', icons: 'glass', railIcons: 'elements', logo: 'mission', startSign: 'mission' } },
    { id: 'paper', name: 'Paper', note: tr('warm paper and dark ink, in letters made to read easily'),
        parts: { background: '#f5efe4', sidebar: '#ece3d3', highlight: '#c2410c', text: '#2b2118', font: 'atkinson', icons: 'outline', railIcons: 'soft',
            logo: 'paper', startSign: 'paper' } }
];

/** Looks kept but off for now (not offered in Theme or Who's watching; one chosen falls back as an unknown look does):
 * Cinema; back on: its entry into LOOKS and its logo into
 * ui/logo.ts LOGOS */
export var OFF_LOOKS: Look[] = [
    { id: 'cinema', name: 'Cinema', note: tr('red velvet and gold lights, a film poster\'s letters, solid icons and 3D objects in the sidebar'),
        parts: { background: '#1a0507', backgroundStyle: 'blend', sidebar: '#120304', sidebarStyle: 'glow', highlight: '#e8b04b', text: '#f3e6d0',
            sidebarText: 'on', font: 'oswald', icons: 'solid', railIcons: 'iso', logo: 'cinema', startSign: 'cinema' } }
];

/** Settings › Theme › Who's watching: the account's own look there (not one of LOOKS) */
export var MINE = 'mine';

/** Every part a look sets (the ones it does not name to their own: '', but ON_TOP's) */
export var LOOK_PARTS: LookPart[] = ['background', 'sidebar', 'highlight', 'text', 'font', 'icons', 'railIcons', 'backgroundStyle', 'sidebarStyle',
    'sidebarText', 'logo', 'startSign'];

/** A saved look's id: this and when it was saved */
export var SAVED = 'saved:';

/** The account's saved looks as stored (prefs savedLooks), those that are one (an old or broken store: none of it) */
export function savedLooks(): { id: string; name: string; parts: { [part: string]: string } }[] {
    var saved = prefs().savedLooks;
    return (saved instanceof Array ? saved : []).filter(function (l) {
        return l && typeof l.id === 'string' && l.id.indexOf(SAVED) === 0 && typeof l.name === 'string' && l.parts && typeof l.parts === 'object';
    });
}

/** The looks to choose from: the built-in ones (LOOKS), then the account's saved ones */
export function allLooks(): Look[] {
    return LOOKS.concat(savedLooks().map(function (l) { return { id: l.id, name: l.name, note: '', parts: l.parts }; }));
}

/** The look with this id (one no longer listed: the first) */
export function lookOf(id: string): Look {
    return allLooks().filter(function (l) { return l.id === id; })[0] || LOOKS[0];
}

/** The parts as set now, each by name ('' its own; the background none: YouTube's dark; the logo and the loading sign
 * always named, as shown: the look's on top, else the account's own) */
export function lookParts(): { [part: string]: string } {
    var parts: { [part: string]: string } = {};
    LOOK_PARTS.forEach(function (part) { parts[part] = part === 'background' ? background() : lookPart(part); });
    return parts;
}

/** Sets every part of the look to parts' (Settings › Theme › Theme: a look chosen, Custom, a theme saved): those not
 * named to their own; ON_TOP's on top of the account's own (not named: none, the account's own shows), a logo no longer
 * there the first (ui/logo.ts logoValue). One store write, with also's settings in it (a theme saved: the list of saved
 * ones); drawn by applyLook (applyLookSoon), the logo in its places alone */
export function setLook(parts: { [part: string]: string }, also?: Partial<Prefs>): void {
    var all: { [name: string]: unknown } = {};
    for (var name in also || {}) {
        all[name] = (also as { [name: string]: unknown })[name];
    }
    LOOK_PARTS.forEach(function (part) {
        var top = ON_TOP[part];
        all[top || part] = top ? valueOf(part, parts[part]) : parts[part] || '';
    });
    setPrefs(all as Partial<Prefs>);
}

/** The look whose every part is as set now ('' none: the look is one's own). ON_TOP's by the look's on top: a look
 * is the one set where it names the one on top (one naming none: where none is); else only where nothing it would show
 * differs: none on top, whatever it names (one who never chose a look has YouTube dark, which names YouTube's spinner,
 * and the account's own sign), and, naming none, the one on top the account's own (Custom with the account's own logo,
 * and a theme saved before a look named one). One chosen by hand where a look's is on top takes its place there
 * (setLookPart), so a look naming another is no longer the one set. Of several, the one naming the most of those as they
 * are on top (YouTube dark chosen: it, not a saved theme of its colours naming one's own logo) */
export function matchingLook(): string {
    var now = lookParts();
    var on: { [part: string]: string } = {};
    var own: { [part: string]: string } = {};
    for (var part in ON_TOP) {
        on[part] = valueOf(part, prefs()[ON_TOP[part]]);
        own[part] = valueOf(part, prefs()[part as LookPart]);
    }
    var at = '';
    var most = -1;
    allLooks().forEach(function (look) {
        var named = 0;
        var same = LOOK_PARTS.every(function (part) {
            var value = valueOf(part, look.parts[part]);
            if (ON_TOP[part]) {
                if (value === on[part]) {
                    named++;
                    return true;
                }
                return !on[part] || !value && on[part] === own[part];
            }
            return now[part] === (value || (part === 'background' ? YOUTUBE_DARK : ''));
        });
        if (same && named > most) {
            at = look.id;
            most = named;
        }
    });
    return at;
}

/** After a part was set: a look that is none of the looks is kept as the account's Custom, to come back to after
 * trying another (Settings › Theme › Theme) */
export function keepCustom(): void {
    if (matchingLook()) {
        return;
    }
    var now = lookParts();
    if (JSON.stringify(now) !== JSON.stringify(prefs().customLook)) {
        setPref('customLook', now);
    }
}

/** Gives the screens the chosen look in the frame after the next (Settings › Theme's OK: the choice's checkmark is
 * drawn first, at once, and the look's redraw comes after it); several asked meanwhile apply once */
export function applyLookSoon(): void {
    if (lookFrame) {
        return;
    }
    lookFrame = requestAnimationFrame(function () {
        lookFrame = requestAnimationFrame(function () {
            lookFrame = 0;
            applyLook();
        });
    });
}

var lookFrame = 0;

/** The theme's light colours (themes/<id>-light.css, made by tools/light_theme.mjs: its colours alone) over its own
 * sheet, which stays: added once a light look is shown or Settings shows the looks (prepareSheets), then switched on
 * and off by its disabled. Not by media: a change to a link's media had the TV load the theme's sheets anew, the page
 * without them for ~0.6 s, everything out of place (2026-11-16); disabled loads nothing, and a swap changes colours
 * only */
var lightSheet: HTMLLinkElement | null = null;

/** The light colours on (the sheet added if not yet there) or off */
function showLight(on: boolean): void {
    if (!lightSheet) {
        if (!on) {
            return;
        }
        lightSheet = addLight();
    }
    lightOn = on;
    // (its sheet's own switch where it has loaded: the link's may say off while the sheet is on, below)
    var sheet = lightSheet.sheet;
    if (sheet && sheet.disabled === on) {
        sheet.disabled = !on;
    }
    if (lightSheet.disabled === on) {
        lightSheet.disabled = !on;
    }
}

/** Whether the light sheet is to be on: set again on its sheet once it has loaded (the TV's Chrome 38 lets a link
 * switched off before its file came apply it all the same, its disabled still saying true: seen 2026-11-16, a dark
 * colour of one's own drawn with the light sheet's dark text after Settings had loaded it) */
var lightOn = false;

/** The theme's light sheet, added right after its own (before the look's rules, which must come after both) */
function addLight(): HTMLLinkElement {
    var link = h('link') as HTMLLinkElement;
    link.rel = 'stylesheet';
    link.href = 'themes/' + current!.id + '-light.css';
    link.onload = function (): void {
        if (link.sheet) {
            link.sheet.disabled = !lightOn;
        }
    };
    var main = document.getElementById('theme-css');
    if (main && main.parentNode) {
        main.parentNode.insertBefore(link, main.nextSibling);
    } else {
        document.head.appendChild(link);
    }
    return link;
}

/** Settings shows the looks (its Theme settings): the light sheet loaded now, off while the look is dark, so that a
 * change to a light one only switches it on */
export function prepareSheets(): void {
    if (current && !lightSheet) {
        lightOn = isLight(lookPart('background') || YOUTUBE_DARK);
        lightSheet = addLight();
        lightSheet.disabled = !lightOn;
    }
}

/** The current theme's sizes */
export function metrics(): Metrics {
    if (!current) {
        throw new Error('no theme applied');
    }
    return current.metrics;
}

/** Where Subscriptions shows its channels: the viewer's choice (Settings › Screens; prefs.subsLayout), else the current
 * theme's */
export function subsLayout(): SubsLayout {
    if (!current) {
        throw new Error('no theme applied');
    }
    var own = prefs().subsLayout;
    return own === 'side' || own === 'top' ? own : current.layouts.subscriptions;
}
