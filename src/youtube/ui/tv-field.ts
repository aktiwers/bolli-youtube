// The TV's own keyboard for a text typed on one of the app's keyboards (Settings' text page: ui/text-page.ts; Search:
// views/search.ts), behind a key on it (a keyboard drawn as its icon): the text goes into a real text field over the
// field shown, which gets the focus; the TV then shows its own keyboard, and a phone's app or a plugged-in keyboard
// types (and pastes) into it too. The keys are the field's meanwhile (core/keys.ts setTyping). Enter there hands the
// text over (onDone); Back (Esc on a keyboard), or the TV's keyboard going away, or the field losing the focus, comes
// back to the app's keyboard with the text as typed (onLeave). Nothing is made per key: the field is made once, shown
// only while it has the focus.

import { h, setShown } from '../core/dom.js';
import { KEY, setTyping } from '../core/keys.js';
import { android } from '../core/platform.js';
import { Keyboard } from './keyboard.js';

var ENTER = 13;
var ESCAPE = 27;
/** Android's keyboard is given this long to come before the remote's keys that reach the page say anything of it
 * (ms; on the emulators it showed within 0.3 s of the field's focus) */
var OPENING_MS = 500;

/** Whether the device brings a keyboard of its own to a text field that takes the focus: the TV's does by itself,
 * Android's where the shell can be asked for it (a focus a script gives brings none: a shell without the call left
 * the field standing with no keyboard and no key answering, so the app's keyboards leave the key out there) */
export function ownKeyboard(): boolean {
    var shell = android();
    return !shell || !!shell.keyboard;
}

/** Android's own keyboard for the field that has the focus, or put away (the TV shows and hides its own) */
function androidKeyboard(shown: boolean): void {
    var shell = android();
    if (shell && shell.keyboard) {
        shell.keyboard(shown);
    }
}

export class TvField {
    /** The real text field */
    input: HTMLInputElement;
    /** It has the focus and the keys now, since enteredAt (ms) */
    active = false;
    private enteredAt = 0;
    /** The text in the field changed (typed on the TV's keyboard, a phone, a plugged-in keyboard) */
    onText: (text: string) => void = function () { return undefined; };
    /** Enter in the field: the text handed over (the field left first) */
    onDone: () => void = function () { return undefined; };
    /** The field left (Enter, Back, the TV's keyboard gone, the focus taken): the app's keyboard again */
    onLeave: () => void = function () { return undefined; };

    /** The field into parent, over shown (the field the app's keyboard shows its text in), classed besides as place (the
     * shown field's own classes: its place and look) */
    constructor(parent: HTMLElement, place: string, private shown: HTMLElement) {
        var self = this;
        // (by-langs-input: the field's own look, the page's font among it: themes/youtube.css)
        var input = this.input = parent.appendChild(h('input', 'by-langs-input')) as HTMLInputElement;
        input.className = place + ' by-langs-input';
        input.type = 'text';
        ['autocomplete', 'autocorrect', 'autocapitalize'].forEach(function (name) { input.setAttribute(name, 'off'); });
        input.setAttribute('spellcheck', 'false');
        setShown(input, false);
        input.addEventListener('input', function () {
            if (self.active) {
                self.onText(input.value);
            }
        });
        // (the focus taken from it, or the TV's keyboard put away by its own Back: the app's keyboard again)
        input.addEventListener('blur', function () { self.leave(); });
        document.addEventListener('keyboardStateChange', function (e: Event) {
            var detail = (e as CustomEvent).detail as { visibility?: boolean } | undefined;
            if (detail && detail.visibility === false) {
                self.leave();
            }
        });
    }

    /** text into the field, which shows over the shown one and gets the focus and the keys: the TV shows its keyboard */
    enter(text: string): void {
        var self = this;
        var input = this.input;
        this.active = true;
        this.enteredAt = Date.now();
        input.value = text;
        setShown(this.shown, false);
        setShown(input, true);
        setTyping(function (code) { return self.key(code); });
        input.focus();
        androidKeyboard(true);
        try {
            input.setSelectionRange(input.value.length, input.value.length);
        } catch (e) {
            // (the caret stays where the engine put it)
        }
    }

    /** Back to the app's keyboard, the text as the field has it (nothing if the field has not the keys) */
    leave(): void {
        if (!this.active) {
            return;
        }
        this.active = false;
        setTyping(null);
        this.onText(this.input.value);
        androidKeyboard(false);
        this.input.blur();
        setShown(this.input, false);
        setShown(this.shown, true);
        this.onLeave();
    }

    /** A key the app hands its owner, taken only while the field is active (the Android app hands the remote's keys
     * to the page also while the field has the focus; on a TV a pointer's wheel or a casting phone's arrows come so):
     * Enter and Back as on a TV (key), a number key typed on keyboard and into the field (it never reaches the field
     * there); taken (true). The remote's OK or an arrow in the Android app is one its keyboard did not take, so that is
     * away (its own Back put it away, which nothing tells): the field is left and the key is the app's keyboard's
     * (false), an OK on its TV keyboard key bringing Android's keyboard back (a keyboard's Enter is typed into the
     * field by the shell). Not while Android's keyboard is still coming (OPENING_MS from the field's focus): an OK or
     * an arrow then is no word on it, a second OK least */
    onKey(code: number, keyboard: Keyboard): boolean {
        if (!this.active) {
            return false;
        }
        var remote = code === KEY.OK || code === KEY.LEFT || code === KEY.RIGHT || code === KEY.UP || code === KEY.DOWN;
        if (remote && android()) {
            if (Date.now() - this.enteredAt < OPENING_MS) {
                return true;
            }
            this.leave();
            return false;
        }
        if (!this.key(code) && keyboard.typeDigit(code)) {
            this.input.value = keyboard.text;
        }
        return true;
    }

    /** A key while the field has them: Enter hands the text over, Back (Esc) comes back to the app's keyboard; any other
     * is the field's (false) */
    key(code: number): boolean {
        if (code === ENTER) {
            this.leave();
            this.onDone();
        } else if (code === KEY.BACK || code === ESCAPE) {
            this.leave();
        } else {
            return false;
        }
        return true;
    }
}
