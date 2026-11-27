// Settings › Theme › Text size (views/text-size-page.ts): the app's text in kinds, each its own size in px (prefs
// textSizes, each account's own; a kind not named there at its default: the size the stylesheet draws it in). A kind at
// another size is its rules from the stylesheets (ui/sizes.gen.ts, made by tools/text_sizes.mjs) written again with
// each size scaled by the kind's size over its default: the font size, the line height where it is the text's own,
// a max height of whole lines (kept as many lines). ui/theme.ts writes them in a style element per kind, only for a
// kind whose size changed (no key writes any: a size tried shows once the keys rest). Boxes keep their size and the
// text grows inside them, but for the text under tiles and the rows' names over them, whose room the rows are spaced by
// (tileSpace: ui/theme.ts metrics, views/videos.ts respace), and a Movies row's focused poster, whose words stand from its
// foot up (posterRules). Subtitles keep their own size in % (prefs captionSize), shown on the same page.

import { POSTER, SIZE_DEFAULTS, SIZE_RULES } from './sizes.gen.js';

/** Each kind's size in px, by kind (one not named: its default) */
export type TextSizes = { [kind: string]: number };

/** The kinds, in the page's order (their rules: tools/text_sizes.mjs KINDS) */
export var TEXT_KINDS = ['titles', 'details', 'rows', 'sidebar', 'menus', 'headers', 'player', 'watch'];

/** The sizes a kind may have (px) */
export var SMALLEST = 12;
export var LARGEST = 48;

/** A kind's default size (px): what the stylesheet draws it in */
export function defaultSize(kind: string): number {
    return SIZE_DEFAULTS[kind];
}

/** kind's size in sizes: a whole px from SMALLEST to LARGEST, its default where sizes names none (or no number) */
export function sizeIn(sizes: TextSizes | null | undefined, kind: string): number {
    var v = sizes ? sizes[kind] : undefined;
    return typeof v === 'number' && v === v ? Math.max(SMALLEST, Math.min(LARGEST, Math.round(v))) : SIZE_DEFAULTS[kind];
}

/** sizes as kept: the kinds not at their default only, each as sizeIn reads it (a new object) */
export function keptSizes(sizes: TextSizes | null | undefined): TextSizes {
    var out: TextSizes = {};
    TEXT_KINDS.forEach(function (kind) {
        var px = sizeIn(sizes, kind);
        if (px !== SIZE_DEFAULTS[kind]) {
            out[kind] = px;
        }
    });
    return out;
}

/** Whether two sizes are the same for every kind */
export function sameSizes(a: TextSizes | null | undefined, b: TextSizes | null | undefined): boolean {
    return TEXT_KINDS.every(function (kind) { return sizeIn(a, kind) === sizeIn(b, kind); });
}

/** kind's rules at px, as CSS ('' at its default: the stylesheet's own). Each rule [selector, font size, its own line
 * height (0: none, or a box's), max height, a box's line height (tools/text_sizes.mjs: the box grows by what its text
 * grows, never below it), a height (the box's, or whole lines of the text's own)] */
export function kindRules(kind: string, px: number): string {
    var d = SIZE_DEFAULTS[kind];
    if (px === d) {
        return '';
    }
    var k = px / d;
    var css = '';
    SIZE_RULES[kind].forEach(function (r) {
        var lh = Math.round(r[2] * k);
        var box = r[4] && k > 1 ? r[4] + Math.round(r[1] * (k - 1)) : 0;
        var height = !r[5] ? 0 : r[2] ? Math.round(r[5] / r[2]) * lh : box;
        css += r[0] + ' { font-size: ' + Math.round(r[1] * k) + 'px' + (lh ? '; line-height: ' + lh + 'px' : box ? '; line-height: ' + box + 'px' : '') +
            (r[3] ? '; max-height: ' + Math.round(r[3] / r[2]) * lh + 'px' : '') + (height ? '; height: ' + height + 'px' : '') + '; }\n';
    });
    return css;
}

/** The line height of kind's rule for selector at sizes (px): the stylesheet's own scaled */
function lineOf(sizes: TextSizes, kind: string, selector: string): number {
    var rule = SIZE_RULES[kind].filter(function (r) { return r[0] === selector; })[0];
    return Math.round(rule[2] * sizeIn(sizes, kind) / SIZE_DEFAULTS[kind]);
}

/** How much more room than at the defaults the text by tiles takes at sizes (px; less: negative): under a tile (two
 * lines of title, two lines under it: the rows and grids that much further apart), beside a playlist page's pictures
 * (listTile: a picture's height; its lines further apart where the words grow past it, never closer), and a row's name
 * over its tiles (head: its line's growth, the row's head that much taller: a name of 48 px had run into the tiles) */
export function tileSpace(sizes: TextSizes, listTile: number): { under: number; beside: number; head: number } {
    var under = function (s: TextSizes): number {
        return 2 * lineOf(s, 'titles', '.bd-tile-title') + 2 * lineOf(s, 'details', '.bd-tile-line');
    };
    var beside = function (s: TextSizes): number {
        return Math.max(0, 2 * lineOf(s, 'titles', '.bd-page--list .bd-tile-title') + 2 * lineOf(s, 'details', '.bd-page--list .bd-tile-line') - listTile);
    };
    return { under: under(sizes) - under({}), beside: beside(sizes) - beside({}), head: lineOf(sizes, 'rows', '.bd-row-title') - lineOf({}, 'rows', '.bd-row-title') };
}

/** A Movies row's focused poster at sizes: its title and two lines over its picture's foot stand from its last line's
 * foot up, as the stylesheet has them (POSTER), each as tall as its line now ('' at the defaults) */
export function posterRules(sizes: TextSizes): string {
    var title = lineOf(sizes, 'titles', '.bd-tile-title');
    var line = lineOf(sizes, 'details', '.bd-tile-line');
    var was = { title: lineOf({}, 'titles', '.bd-tile-title'), line: lineOf({}, 'details', '.bd-tile-line') };
    if (title === was.title && line === was.line) {
        return '';
    }
    var foot = POSTER.next + was.line;
    var gap = POSTER.line - POSTER.title - was.title;
    var next = foot - line;
    var base = '.bd-row--wide .bd-tile--focused ';
    return base + '.bd-tile-title { top: ' + (next - line - gap - title) + 'px; }\n' +
        base + '.bd-tile-line { top: ' + (next - line) + 'px; }\n' +
        base + '.bd-tile-line--next { top: ' + next + 'px; }\n';
}
