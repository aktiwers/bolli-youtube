// Settings › Theme › Colours' models (views/colour-page.ts): on the tabs whose colour the app behind does not show, a
// window over the app at the left, as the Icons page's (views/icon-page.ts): Progress bar the player with its bar and
// the other bars the colour reaches (under a tile, Shorts', the watch page's); Loading spinner the sign in force on the
// start's black plate, its name under it; Player panels the watch page with its buttons and comments. Each drawn by the
// stylesheet's classes in YouTube's own colours, which the look's rules colour as they colour the app's (ui/theme.ts
// progressRules, panelRules, signRules, made from youtube.css: tools/light_theme.mjs), so a colour tried on the app
// (ui/theme.ts tryLook) shows on them in the same frame, with nothing of their own to do per key.
// Speed: each model made the first time its tab shows while the page is open (in the language then; the loading sign's
// anew where another is in force), in the frame the tab's colours are drawn in (colour-page.ts fill); the window and the
// models put away by standsBy (a transform: nothing drawn anew, as the Icons page's window); a spinner moves on the
// compositor alone (ui/spinner.ts) and is paused SHOW_MS after the colour last tried and while away: nothing ticks
// while nothing happens. No picture asked for but the logo's the loading sign's preview shows (views/sign-preview.ts).
// Styled by themes/<id>.css (by-colours-model, kept dark on a light page: tools/light_theme.mjs OVER).

import { h, setShown, setText, standsBy, toggleClass } from '../core/dom.js';
import { tr } from '../core/i18n.js';
import { FillLoader, GLIDE_EASE } from '../ui/fill-loader.js';
import { icon } from '../ui/icons.js';
import { logo, logoFile, LOGOS } from '../ui/logo.js';
import { isSpinner, Spinner } from '../ui/spinner.js';
import { lookPart } from '../ui/theme.js';
import { SHOW_MS, signSays } from './sign-preview.js';

/** What a tab shows over the app: '' nothing (the app behind shows its colour), the player's bars, the loading sign, the
 * player's panels */
export type ModelKind = '' | 'progress' | 'sign' | 'panels';

/** The loading sign's model: its box, the plate, the sign's name and the note under it, the sign it shows, a spinner
 * and the channel's picture filling up (made as needed) */
interface SignModel {
    box: HTMLElement;
    plate: HTMLElement;
    name: HTMLElement;
    note: HTMLElement;
    shows: string;
    spinner: Spinner | null;
    loader: FillLoader | null;
}

export class ColourModels {
    private win: HTMLElement;
    /** The models made since the page opened, by kind; the one shown */
    private boxes: { [kind: string]: HTMLElement } = {};
    private kind: ModelKind = '';
    private sign: SignModel | null = null;
    /** The pause of the sign's moving parts (SHOW_MS after a colour tried) */
    private stillTimer = 0;

    /** The window goes into parent (before the page, which stays over it) */
    constructor(parent: HTMLElement) {
        this.win = parent.appendChild(h('div', 'by-colours-model')) as HTMLElement;
        setShown(this.win, false);
    }

    /** The page opens: the models made anew as their tabs show (in the language now), the window put away until one does */
    open(): void {
        this.win.innerHTML = '';
        this.boxes = {};
        this.sign = null;
        this.kind = '';
        standsBy(this.win, true);
        setShown(this.win, true);
    }

    /** The page closes: the window hidden, the sign stopped */
    close(): void {
        clearTimeout(this.stillTimer);
        this.stop();
        setShown(this.win, false);
    }

    /** kind's model shown over the app (made now if it has not been since the page opened), the others put away; ''
     * none: the window put away */
    show(kind: ModelKind): void {
        if (kind === this.kind && (kind !== 'sign' || !this.sign || this.sign.shows === lookPart('startSign'))) {
            return;
        }
        var was = this.boxes[this.kind];
        if (was && kind !== this.kind) {
            standsBy(was, true);
        }
        if (this.kind === 'sign') {
            this.still(true);
        }
        this.kind = kind;
        standsBy(this.win, !kind);
        if (!kind) {
            return;
        }
        var box = this.boxes[kind] || (this.boxes[kind] = this.build(kind));
        standsBy(box, false);
        if (kind === 'sign') {
            this.drawSign();
            this.turn();
        }
    }

    /** A colour tried on the loading sign: its moving parts move for SHOW_MS, then pause */
    turn(): void {
        var self = this;
        clearTimeout(this.stillTimer);
        if (this.kind !== 'sign') {
            return;
        }
        this.still(false);
        this.stillTimer = setTimeout(function () { self.still(true); }, SHOW_MS) as unknown as number;
    }

    /** The sign's moving parts paused (still) or moving */
    private still(on: boolean): void {
        if (this.sign) {
            toggleClass(this.sign.box, 'by-colours-model--still', on);
        }
    }

    /** The sign shown hidden (nothing left ticking) */
    private stop(): void {
        if (this.sign) {
            if (this.sign.spinner) {
                this.sign.spinner.hide();
            }
            if (this.sign.loader) {
                this.sign.loader.hide();
            }
            this.sign.shows = '';
        }
    }

    private build(kind: ModelKind): HTMLElement {
        var box = this.win.appendChild(h('div', 'by-colours-model-box')) as HTMLElement;
        if (kind === 'progress') {
            this.buildBars(box);
        } else if (kind === 'panels') {
            this.buildPanels(box);
        } else {
            this.sign = {
                box: box,
                plate: box.appendChild(h('div', 'by-loader-plate by-loader-plate--on')) as HTMLElement,
                name: box.appendChild(h('div', 'by-colours-sign-name')) as HTMLElement,
                note: box.appendChild(h('div', 'by-colours-sign-note')) as HTMLElement,
                shows: '', spinner: null, loader: null
            };
        }
        return box;
    }

    /** The player: a video's picture, its time and bar with its marker; under it the watched part under a tile, Shorts'
     * bar, the watch page's bar and knob, each named */
    private buildBars(box: HTMLElement): void {
        var picture = box.appendChild(h('div', 'by-colours-picture')) as HTMLElement;
        picture.appendChild(h('div', 'by-colours-fade'));
        picture.appendChild(h('div', 'by-colours-time', '3:36 / 10:34'));
        var bar = picture.appendChild(h('div', 'by-colours-bar')) as HTMLElement;
        bar.appendChild(h('div', 'by-colours-bar-fill'));
        bar.appendChild(h('div', 'by-colours-bar-marker'));
        var uses = box.appendChild(h('div', 'by-colours-uses')) as HTMLElement;
        var use = function (cls: string, name: string, part: number): HTMLElement {
            var one = uses.appendChild(h('div', 'by-colours-use')) as HTMLElement;
            var track = one.appendChild(h('div', cls)).appendChild(h('div', 'by-colours-use-track')) as HTMLElement;
            (track.appendChild(h('div', 'by-colours-bar-line')) as HTMLElement).style.width = part + '%';
            one.appendChild(h('div', 'by-colours-use-name', name));
            return track;
        };
        use('by-colours-use-tile', tr('Home'), 62);
        use('by-colours-use-short', tr('Shorts'), 45);
        use('by-colours-use-watch', tr('Watch page'), 50).appendChild(h('div', 'by-colours-bar-knob'));
    }

    /** The watch page: the video, its round buttons, its comments at the right (each a card, lines for its words) */
    private buildPanels(box: HTMLElement): void {
        var picture = box.appendChild(h('div', 'by-colours-picture by-colours-picture--whole')) as HTMLElement;
        picture.appendChild(h('div', 'by-colours-fade'));
        var buttons = box.appendChild(h('div', 'by-colours-panels-buttons')) as HTMLElement;
        ['play', 'like', 'comments', 'settings'].forEach(function (name) {
            buttons.appendChild(h('div', 'by-colours-panels-button')).appendChild(icon(name, 'by-colours-panels-icon'));
        });
        var comments = box.appendChild(h('div', 'by-colours-comments')) as HTMLElement;
        comments.appendChild(h('div', 'by-colours-comments-head', tr('Comments')));
        for (var n = 0; n < 4; n++) {
            var card = comments.appendChild(h('div', 'by-colours-comment')) as HTMLElement;
            card.appendChild(h('div', 'by-colours-comment-avatar'));
            card.appendChild(h('div', 'by-colours-comment-by'));
            card.appendChild(h('div', 'by-colours-comment-line'));
            card.appendChild(h('div', 'by-colours-comment-line'));
        }
    }

    /** The loading sign in force on its plate, as at a start (a spinner turning, the channel's picture filling up with
     * the logo as its picture, as Loading spinner's preview), its name under it; one with no colour of its own (Off,
     * Your logo): YouTube's spinner, and a note that its colours are the spinners' */
    private drawSign(): void {
        var s = this.sign!;
        var id = lookPart('startSign');
        if (s.shows === id) {
            return;
        }
        this.stop();
        s.shows = id;
        var own = id === 'channel' || isSpinner(id);
        var shown = own ? id : 'youtube';
        setText(s.name, (signSays()[shown] || [''])[0]);
        setText(s.note, own ? '' : tr('Your loading sign has no colours of its own: shown here on YouTube\'s spinner'));
        if (shown === 'channel') {
            var loader = s.loader = s.loader || new FillLoader(s.box, true);
            loader.show(logo() || logoFile(LOGOS[0]), 0);
            loader.step(1, SHOW_MS, GLIDE_EASE);
        } else {
            (s.spinner = s.spinner || new Spinner(s.plate)).show(shown);
        }
    }
}
