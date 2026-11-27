// A page a short text is typed on with an on-screen keyboard: letters (ABC / abc swaps their case), digits and an
// address's signs, shown over Settings as "More languages" is (its look: by-langs, by-address keeps the keys' case).
// The tick key hands the text typed to the caller; Back closes without it. The field shows the text's end when it
// is longer than the field. Settings types a picture's address on it (a custom logo) and the home screen name (with
// a space key).
//
// The TV keyboard key brings the TV's own keyboard (ui/tv-field.ts): Enter there hands the text over as the tick does;
// Back, or the TV's keyboard going away, comes back to this keyboard with the text as typed.

import { h, setShown, setText } from '../core/dom.js';
import { tr } from '../core/i18n.js';
import { KEY } from '../core/keys.js';
import { Keyboard, KeyboardLabels } from './keyboard.js';
import { ownKeyboard, TvField } from './tv-field.js';
import { sideKey } from './youtube-keyboard.js';

var DELETE = 'Delete';
var DONE = 'Done';
var UPPER = 'ABC';
var LOWER = 'abc';
/** The key that brings the TV's own keyboard (shown as a keyboard: dress) */
var TV = 'TV keyboard';
/** Characters the field shows (the address's end) */
var SHOWN = 44;

export class TextPage {
    el: HTMLElement;
    shown = false;
    private field: HTMLElement;
    /** The TV's own keyboard's field */
    private tv: TvField;
    private keyboard: Keyboard;
    private labels: KeyboardLabels;
    private upper = false;
    /** The keyboard has a space key (this time's text may have spaces) */
    private spaces = false;
    private title: HTMLElement;
    private taken: (text: string) => void = function () { return undefined; };

    constructor(parent: HTMLElement) {
        var self = this;
        this.el = h('div', 'by-langs by-address');
        this.title = this.el.appendChild(h('div', 'by-langs-title')) as HTMLElement;
        this.field = this.el.appendChild(h('div', 'by-langs-field')) as HTMLElement;
        this.tv = new TvField(this.el, 'by-langs-field', this.field);
        this.tv.onText = function (text) { self.keyboard.setValue(text); };
        this.tv.onDone = function () { self.done(); };
        this.tv.onLeave = function () {
            if (self.shown) {
                self.keyboard.setFocused(true);
                self.draw();
            }
        };
        // (Space, Clear and the tick as Search's bottom row: each a pill)
        this.labels = { space: tr('Space'), del: DELETE, clear: tr('Clear'), enter: DONE, spaceUnits: 2 };
        this.keyboard = new Keyboard(this.labels, function () { self.draw(); }, this.lines());
        this.keyboard.actions[UPPER] = function () { self.setUpper(true); };
        this.keyboard.actions[LOWER] = function () { self.setUpper(false); };
        this.keyboard.actions[DONE] = function () { self.done(); };
        this.keyboard.actions[TV] = function () {
            self.keyboard.setFocused(false);
            self.tv.enter(self.keyboard.text);
        };
        this.dress();
        var keys = this.el.appendChild(h('div', 'by-langs-keys')) as HTMLElement;
        keys.appendChild(this.keyboard.el);
        setShown(this.el, false);
        parent.appendChild(this.el);
    }

    /** Shows over Settings under title with text in the field (spaces: with a space key); taken: called with the
     * text as typed, its outer spaces off, when the tick is pressed */
    open(title: string, text: string, spaces: boolean, taken: (text: string) => void): void {
        this.taken = taken;
        this.shown = true;
        setText(this.title, title);
        if (spaces !== this.spaces || this.upper) {
            this.spaces = spaces;
            this.upper = false;
            this.keyboard.setLayout(this.labels, this.lines());
            this.dress();
        }
        this.keyboard.setValue(text);
        this.keyboard.setFocused(true);
        this.draw();
        setShown(this.el, true);
    }

    close(): void {
        if (this.shown) {
            this.tv.leave();
            this.shown = false;
            setShown(this.el, false);
        }
    }

    /** The page while open (null: closed): the pointer's layer, a click beside it is Back (core/pointer.ts) */
    layer(): HTMLElement | null {
        return this.shown ? this.el : null;
    }

    onKey(code: number): boolean {
        if (this.tv.onKey(code, this.keyboard)) {
            return true;
        }
        if (code === KEY.BACK) {
            this.close();
        } else if (!this.keyboard.onKey(code)) {
            this.keyboard.typeDigit(code);
        }
        this.draw();
        return true;
    }

    /** The keys, laid out as Search's: letters in the case set, digits and an address's signs, with Delete, the case
     * key and the TV keyboard key at the first three rows' ends; then Space (where the text may have one), Clear
     * and the tick */
    private lines(): string[][] {
        var letters = this.upper ? 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' : 'abcdefghijklmnopqrstuvwxyz';
        return [
            letters.slice(0, 13).split('').concat([DELETE]),
            letters.slice(13).split('').concat([this.upper ? LOWER : UPPER]),
            '1234567890./:'.split('').concat(ownKeyboard() ? [TV] : []),
            '-_?=&%~+#@,!'.split(''),
            (this.spaces ? [this.labels.space] : []).concat([this.labels.clear, DONE])
        ];
    }

    private setUpper(on: boolean): void {
        this.upper = on;
        this.keyboard.setLayout(this.labels, this.lines(), on ? LOWER : UPPER);
        this.dress();
    }

    /** Delete as its icon, the tick as a check, the TV keyboard key as a keyboard, the case key as a side key */
    private dress(): void {
        sideKey(this.keyboard, DELETE, 'backspace');
        sideKey(this.keyboard, DONE, 'check');
        sideKey(this.keyboard, this.upper ? LOWER : UPPER);
        sideKey(this.keyboard, TV, 'keyboard');
    }

    private done(): void {
        var text = this.keyboard.text.replace(/^\s+|\s+$/g, '');
        this.close();
        this.taken(text);
    }

    private draw(): void {
        var text = this.keyboard.text;
        setText(this.field, text.length > SHOWN ? '…' + text.slice(1 - SHOWN) : text);
    }
}
