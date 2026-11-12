// A page a short text is typed on with an on-screen keyboard: letters (ABC / abc swaps their case), digits and an
// address's signs, shown over Settings as "More languages" is (its look: by-langs, by-address keeps the keys' case).
// The tick key hands the text typed to the caller; Back closes without it. The field shows the text's end when it
// is longer than the field. Settings types a picture's address on it (a custom logo) and the home screen name (with
// a space key).
//
// The TV keyboard key puts the text in a real text field over the shown one and gives it the focus: the TV then
// shows its own keyboard, and a phone's app or a plugged-in keyboard types (and pastes) into it too. The keys are
// the field's meanwhile (core/keys.ts setTyping). Enter there hands the text over as the tick does; Back, or the
// TV's keyboard going away, comes back to this keyboard with the text as typed.

import { h, setShown, setText } from '../core/dom.js';
import { tr } from '../core/i18n.js';
import { KEY, setTyping } from '../core/keys.js';
import { Keyboard, KeyboardLabels } from './keyboard.js';
import { sideKey } from './youtube-keyboard.js';

var DELETE = 'Delete';
var DONE = 'Done';
var UPPER = 'ABC';
var LOWER = 'abc';
/** The key that brings the TV's own keyboard (shown as a keyboard: dress) */
var TV = 'TV keyboard';
var ENTER = 13;
var ESCAPE = 27;
/** Characters the field shows (the address's end) */
var SHOWN = 44;

export class TextPage {
    el: HTMLElement;
    shown = false;
    private field: HTMLElement;
    /** The real text field the TV's own keyboard types into, and whether it has the focus now */
    private input: HTMLInputElement;
    private inField = false;
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
        this.input = this.el.appendChild(h('input', 'by-langs-field by-langs-input')) as HTMLInputElement;
        this.input.type = 'text';
        ['autocomplete', 'autocorrect', 'autocapitalize'].forEach(function (name) { self.input.setAttribute(name, 'off'); });
        this.input.setAttribute('spellcheck', 'false');
        setShown(this.input, false);
        this.input.addEventListener('input', function () {
            if (self.inField) {
                self.keyboard.setValue(self.input.value);
            }
        });
        // (the focus taken from it, or the TV's keyboard put away by its own Back: this keyboard again)
        this.input.addEventListener('blur', function () { self.leaveField(); });
        document.addEventListener('keyboardStateChange', function (e: Event) {
            var detail = (e as CustomEvent).detail as { visibility?: boolean } | undefined;
            if (detail && detail.visibility === false) {
                self.leaveField();
            }
        });
        // (Space, Clear and the tick as Search's bottom row: each a pill)
        this.labels = { space: tr('Space'), del: DELETE, clear: tr('Clear'), enter: DONE, spaceUnits: 2 };
        this.keyboard = new Keyboard(this.labels, function () { self.draw(); }, this.lines());
        this.keyboard.actions[UPPER] = function () { self.setUpper(true); };
        this.keyboard.actions[LOWER] = function () { self.setUpper(false); };
        this.keyboard.actions[DONE] = function () { self.done(); };
        this.keyboard.actions[TV] = function () { self.enterField(); };
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
            this.leaveField();
            this.shown = false;
            setShown(this.el, false);
        }
    }

    /** The text into the real field, which gets the focus and the keys: the TV shows its own keyboard */
    private enterField(): void {
        var self = this;
        var input = this.input;
        this.inField = true;
        input.value = this.keyboard.text;
        setShown(this.field, false);
        setShown(input, true);
        this.keyboard.setFocused(false);
        setTyping(function (code) { return self.fieldKey(code); });
        input.focus();
        try {
            input.setSelectionRange(input.value.length, input.value.length);
        } catch (e) {
            // (the caret stays where the engine put it)
        }
    }

    /** Back to this keyboard, the text as the real field has it (nothing if the field has not the keys) */
    private leaveField(): void {
        if (!this.inField) {
            return;
        }
        this.inField = false;
        setTyping(null);
        this.keyboard.setValue(this.input.value);
        this.input.blur();
        setShown(this.input, false);
        setShown(this.field, true);
        if (this.shown) {
            this.keyboard.setFocused(true);
            this.draw();
        }
    }

    /** A key while the real field has them: Enter hands the text over, Back (Esc on a keyboard) comes back to this
     * keyboard; any other is the field's (false) */
    private fieldKey(code: number): boolean {
        if (code === ENTER) {
            this.leaveField();
            this.done();
        } else if (code === KEY.BACK || code === ESCAPE) {
            this.leaveField();
        } else {
            return false;
        }
        return true;
    }

    /** The page while open (null: closed): the pointer's layer, a click beside it is Back (core/pointer.ts) */
    layer(): HTMLElement | null {
        return this.shown ? this.el : null;
    }

    onKey(code: number): boolean {
        // (the Android app hands the remote's keys here also while the real field has the focus: Enter and Back as
        // on a TV, and its number keys, which never reach the field there, type into it)
        if (this.inField) {
            if (!this.fieldKey(code) && this.keyboard.typeDigit(code)) {
                this.input.value = this.keyboard.text;
            }
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
            '1234567890./:'.split('').concat([TV]),
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
