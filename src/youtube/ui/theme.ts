// Themes. Views build neutral markup (bd-* and by-* class names); a theme is
//  - a stylesheet (colours, fonts, focus look) in
//    apps/bolli-youtube/themes/<id>.css, on top of the base themes/base.css, and
//  - metrics: the sizes views lay out, scroll and request thumbnails with.
// Chrome 38 has no CSS variables, so a theme is a whole stylesheet,
// switched by replacing <link id="theme-css">. Sizes are in 1280x720
// layout units (index.html zooms to the screen).

import { toggleClass } from '../../core/dom.js';
import { TileLayout, TileShape } from '../../ui/tile-row.js';

export interface Metrics {
    /** Left rail: width (where screens start), first entry's top, entry spacing, bottom entry's top */
    rail: { width: number; top: number; step: number; bottom: number };
    /** Where Search's focused results row lands (under the field) */
    searchRowsTop: number;
    /** Subscriptions: first row's top under the channels and pills; channel spacing */
    subscriptionsTop: number;
    subscriptionsStep: number;
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

/** A label in the theme's wording ("CC": "Subtitles"; else unchanged) */
export function word(s: string): string {
    var mine = metrics().ways.words[s];
    return mine !== undefined ? mine : s;
}

export interface Theme {
    id: string;
    name: string;
    metrics: Metrics;
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

/** Applies a theme by id (else the first registered) and loads its stylesheet */
export function applyTheme(id: string): Theme {
    var theme = registry[id] || themes()[0];
    var link = document.getElementById('theme-css') as HTMLLinkElement | null;
    if (link && link.getAttribute('href') !== 'themes/' + theme.id + '.css') {
        link.setAttribute('href', 'themes/' + theme.id + '.css');
    }
    current = theme;
    return theme;
}

/** Settings › Background: pure black behind the screens instead of the theme's dark grey (themes: .by-black) */
export function applyBlack(on: boolean): void {
    toggleClass(document.documentElement, 'by-black', on);
}

/** The current theme's sizes */
export function metrics(): Metrics {
    if (!current) {
        throw new Error('no theme applied');
    }
    return current.metrics;
}
