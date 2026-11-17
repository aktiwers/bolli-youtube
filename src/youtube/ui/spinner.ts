// Spinners: the loading signs that turn while a video starts in Bolli's player (Settings › Theme › Loading spinner:
// LOADING_SIGNS past 'off' and 'channel', the channel's picture filling up, which is ui/fill-loader.ts). Each is a theme's
// own art in its own colours, as a logo is (YouTube's white as YouTube's), drawn by the stylesheet (themes/youtube.css
// by-loader-spin-<id>) where the channel's picture would be, in the middle of the screen over the start's picture.
// While a video starts the TV's browser draws next to no frame of the page (ui/fill-loader.ts), so a spinner moves by
// the compositor alone: its moving parts only turn, slide or fade, each a layer of its own painted once; its still
// parts a layer of their own too, so nothing is painted again as the others move; no timer or frame loop of the
// code's. Its animations are named under by-loader-spin--on alone, the class it has while it shows, and it is
// display: none without it: hidden, nothing ticks. A spinner's elements are made the first time it shows, then kept
// (nothing at the app's start, nothing per start). VHS's PLAY is VT323's letters as SVG paths: no font loaded for it.
// Measured on the TV, 2026-11-17: 14 starts each against the channel's picture, none slower; to a moving picture 404 ms
// on average with a spinner, 437 with the channel's picture.

import { h, toggleClass } from '../core/dom.js';
import { SPINNERS } from './signs.js';

/** The spinners, in Settings' order (LOADING_SIGNS), each its parts: an element each, classed
 * by-loader-spin-<id>-<part>, the still ones first (under the moving ones, so none is made a layer by overlapping
 * them). Moving: YouTube's ring turns; Midnight's two rings grow and fade; Arcade's lit block jumps round the square;
 * VHS's triangle blinks and its bar rolls down the screen; Mission Control's moon turns round the planet; Paper's dots
 * rise and settle; Cinema's lit bulbs turn round the ring a bulb at a time */
var PARTS: { [id: string]: string[] } = {
    youtube: ['ring'],
    midnight: ['glow', 'ring', 'ring2'],
    arcade: ['blocks', 'lit'],
    vhs: ['word', 'play', 'bar'],
    mission: ['orbit', 'planet', 'moon'],
    paper: ['dot', 'dot2', 'dot3'],
    cinema: ['bulbs', 'lit']
};

/** The spinners' ids (ui/signs.ts), each with its parts above */
export { SPINNERS };

/** VHS's PLAY: VT323's letters (fonts/vt323-latin-400-normal.woff: its outlines on their pixel grid, in its units, 560
 * high, 50 apart as the sketch's letter-spacing), and its triangle in the same pixels */
var PLAY = 'M360 240H320V320H120V560H40V0H320V80H360ZM280 80H120V240H280ZM810 560H530V0H610V480H810ZM1260 560H1180V400H1020V560H940V400' +
    'H970V240H990V160H1020V80H1040V0H1160V80H1180V160H1210V240H1230V400H1260ZM1150 240H1130V160H1070V240H1050V320H1150ZM1710 160H1670V240' +
    'H1630V320H1590V560H1510V320H1470V240H1430V160H1390V0H1470V160H1510V240H1590V160H1630V0H1710Z';
var TRIANGLE = 'M0 0H60V40H120V80H180V120H240V160H300V200H360V240H420V320H360V360H300V400H240V440H180V480H120V520H60V560H0Z';

/** Whether id is one of the spinners */
export function isSpinner(id: string): boolean {
    return PARTS.hasOwnProperty(id);
}

/** A part's inside: VHS's word and triangle in the recorder's green, over a red and a blue copy either side (the
 * sketch's text shadow), drawn once */
function inside(id: string, part: string): string {
    var d = id === 'vhs' ? part === 'word' ? PLAY : part === 'play' ? TRIANGLE : '' : '';
    if (!d) {
        return '';
    }
    var copy = function (tone: string, dx: number): string {
        return '<path class="by-loader-spin-vhs-' + tone + '"' + (dx ? ' transform="translate(' + dx + ' 0)"' : '') + ' d="' + d + '"/>';
    };
    return '<svg class="by-loader-spin-vhs-pixels" viewBox="-50 0 ' + (part === 'word' ? 1850 : 520) + ' 560">' + copy('blue', -50) +
        copy('red', 50) + copy('green', 0) + '</svg>';
}

export class Spinner {
    private parent: Node;
    /** Where the spinners go among parent's children (a comment: nothing drawn until one is made) */
    private at: Node;
    /** The spinners made so far, by id */
    private made: { [id: string]: HTMLElement } = {};
    /** The one showing (null: none) */
    private now: HTMLElement | null = null;
    /** The hide once the picture comes (finish) */
    private hiding = 0;

    /** The spinners' place: the end of parent's children now */
    constructor(parent: Node) {
        this.parent = parent;
        this.at = parent.appendChild(document.createComment('spinner'));
    }

    get shown(): boolean {
        return !!this.now;
    }

    /** Shows spinner id (made now if it never showed), turning from this frame on; one showing already turns on */
    show(id: string): void {
        clearTimeout(this.hiding);
        var el = this.made[id] || (this.made[id] = this.make(id));
        if (el !== this.now) {
            this.hide();
            toggleClass(el, 'by-loader-spin--on', true);
            this.now = el;
        }
    }

    /** Hides it in ms (as the picture comes), at once for 0; nothing if it is not showing */
    finish(ms: number): void {
        clearTimeout(this.hiding);
        if (!ms) {
            this.hide();
        } else if (this.now) {
            var self = this;
            this.hiding = setTimeout(function () { self.hide(); }, ms) as unknown as number;
        }
    }

    /** Hides it at once: its animations end with the class */
    hide(): void {
        clearTimeout(this.hiding);
        if (this.now) {
            toggleClass(this.now, 'by-loader-spin--on', false);
            this.now = null;
        }
    }

    private make(id: string): HTMLElement {
        var el = h('div', 'by-loader-spin');
        el.innerHTML = PARTS[id].map(function (part) {
            return '<div class="by-loader-spin-' + id + '-' + part + '">' + inside(id, part) + '</div>';
        }).join('');
        this.parent.insertBefore(el, this.at);
        return el;
    }
}
