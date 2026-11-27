// Settings › Theme › Loading spinner's preview (choosing a spinner gives a few seconds of a preview of it): the sign the focus is on in its choices, shown where a video's start shows it, the middle of the
// screen (Settings narrows to its choices over the app meanwhile: Setting.preview), for SHOW_MS, then gone. A spinner
// as it turns at a start (ui/spinner.ts), the channel's picture filling up (ui/fill-loader.ts, round as at a start) with
// the app's logo as the picture, Off nothing; on a black plate, as on the player's black screen at a start (YouTube's
// white arc did not show on a light look). Each made the first time it is previewed, then kept.
// Speed: a key in the choices hides the one shown (a class, or the loader's display) and asks for one frame or one
// timer: the focused sign shows in the frame after the key's own (two frames, as ui/theme.ts applyLookSoon), or, after
// keys soon after one another (a held arrow), once they rest (ui/colours.ts holdRest, as views/colour-page.ts); a timer
// then hides it. Nothing made per key: the sign's id in a field, the frames' and the timers' functions bound once. A
// spinner moves on the compositor alone and stops with its class (ui/spinner.ts). Leaving the choices, or Settings,
// hides it at once.

import { h, toggleClass } from '../core/dom.js';
import { tr } from '../core/i18n.js';
import { holdRest, REPEAT_GAP_MS } from '../ui/colours.js';
import { FillLoader, GLIDE_EASE } from '../ui/fill-loader.js';
import { logo, logoFile, logoRound, LOGOS } from '../ui/logo.js';
import { isSpinner, Spinner } from '../ui/spinner.js';

/** How long a sign shows */
export var SHOW_MS = 3000;

/** Each sign's name and note by its id (ui/signs.ts LOADING_SIGNS: Settings › Theme › Loading spinner's choices; the
 * Colours page's model of the one in force), in the app's language now; the spinners by the names of the themes they
 * are of */
export function signSays(): { [id: string]: string[] } {
    return {
        off: [tr('Off'), tr('the screen stays dark until the video plays')],
        channel: [tr('Channel picture'), tr('the channel\'s picture fills up')],
        logo: [tr('Your logo'), tr('the logo you chose fills up')],
        youtube: ['YouTube', tr('a white arc turning, as YouTube\'s own')],
        midnight: ['Midnight', tr('soft rings breathing out of a glowing dot')],
        arcade: ['Arcade', tr('pixel blocks chasing round a square')],
        vhs: ['VHS', tr('PLAY with its triangle blinking, a tracking bar rolling past')],
        mission: ['Mission Control', tr('a moon orbiting a planet')],
        paper: ['Paper', tr('three ink dots rising and settling in turn')],
        cinema: ['Cinema', tr('marquee bulbs chasing round a ring')]
    };
}
/** The channel's picture fills up over the time shown but this, eased as at a start: full a moment before it goes */
var FILL_LEFT_MS = 400;

export class SignPreview {
    private parent: HTMLElement;
    private spinner: Spinner | null = null;
    private loader: FillLoader | null = null;
    /** Your logo's: the logo in its own shape (the channel's picture's is round) */
    private logoLoader: FillLoader | null = null;
    /** The black under the sign shown */
    private plate: HTMLElement | null = null;
    /** The sign the focus is on (one of ui/spinner.ts LOADING_SIGNS) */
    private id = '';
    /** The frame waited for before it shows (0: none) */
    private frame = 0;
    /** The one timer: the show once the keys rest, then the hide */
    private timer = 0;
    /** When the focus last moved (ms) */
    private movedAt = 0;
    /** Bound once: the frame of the key, which asks for the next; the show (that next frame, or the keys' rest); the
     * hide */
    private keyFrame: () => void;
    private showNow: () => void;
    private hideNow: () => void;

    /** Its signs go into parent (made there on their first preview) */
    constructor(parent: HTMLElement) {
        this.parent = parent;
        var self = this;
        this.keyFrame = function (): void {
            self.frame = requestAnimationFrame(self.showNow);
        };
        this.showNow = function (): void {
            self.frame = 0;
            self.show();
        };
        this.hideNow = function (): void {
            self.hide();
        };
    }

    /** The focus on sign id: the one shown goes at once; id shows in the frame after the key's, or, when the focus moved
     * a moment ago too, once it rests */
    focus(id: string): void {
        var now = Date.now();
        // (a held key's repeats alone wait: showing a sign is cheap, so presses of their own show it at once, quick ones too)
        var rest = holdRest(now - this.movedAt, REPEAT_GAP_MS);
        this.movedAt = now;
        this.hide();
        this.id = id;
        if (rest) {
            this.timer = setTimeout(this.showNow, rest) as unknown as number;
        } else {
            this.frame = requestAnimationFrame(this.keyFrame);
        }
    }

    /** Hides the sign shown, and one waiting to show */
    hide(): void {
        clearTimeout(this.timer);
        if (this.frame) {
            cancelAnimationFrame(this.frame);
            this.frame = 0;
        }
        if (this.spinner) {
            this.spinner.hide();
        }
        if (this.loader && this.loader.shown) {
            this.loader.hide();
        }
        if (this.logoLoader && this.logoLoader.shown) {
            this.logoLoader.hide();
        }
        if (this.plate) {
            toggleClass(this.plate, 'by-loader-plate--on', false);
        }
    }

    /** Shows the sign the focus is on for SHOW_MS (Off, or one not known: nothing). A spinner on the plate, inside it:
     * what of it reaches further (VHS's tracking bar, which rolls down the whole screen at a start) is cut off at the
     * plate's edge, as the screen's at a start; the channel's picture over it */
    private show(): void {
        var id = this.id;
        var spinner = isSpinner(id);
        // (Your logo with no logo chosen: the channel's picture, as at a start)
        var mine = id === 'logo' && logo();
        if (!spinner && id !== 'channel' && id !== 'logo') {
            return;
        }
        var plate = this.plate = this.plate || this.parent.appendChild(h('div', 'by-loader-plate')) as HTMLElement;
        if (spinner) {
            (this.spinner = this.spinner || new Spinner(plate)).show(id);
        } else {
            var loader = mine ? this.logoLoader = this.logoLoader || new FillLoader(this.parent, false, true) :
                this.loader = this.loader || new FillLoader(this.parent, true);
            loader.show(mine || logo() || logoFile(LOGOS[0]), 0, !!mine && logoRound());
            loader.step(1, SHOW_MS - FILL_LEFT_MS, GLIDE_EASE);
        }
        toggleClass(plate, 'by-loader-plate--on', true);
        this.timer = setTimeout(this.hideNow, SHOW_MS) as unknown as number;
    }
}
