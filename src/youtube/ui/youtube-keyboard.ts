// YouTube's on-screen keyboards: the plain one (More languages: a to g with Delete as YouTube's backspace icon, then
// the caller's letters, then Space, as wide as the keys beside it, and Clear), and
// Search's (SearchKeyboard): a language's letters (ui/keyboard-languages.ts) with Delete, &123 (YouTube's numbers and
// symbols, ABC back) and the language key at the ends of the first three rows, Space, Clear and Search in its words.

import { setText } from '../../core/dom.js';
import { Keyboard, KeyboardLabels } from '../../ui/keyboard.js';
import { icon } from './icons.js';
import { composed, erased, GAP, KeyboardLanguage, keyboardLanguage, SYMBOLS } from './keyboard-languages.js';

var DELETE = 'Delete';
var NUMBERS = '&123';
var LETTERS = 'ABC';
var LANGUAGE = 'Language';

/** A keyboard with lines of keys (each a string) after a to g */
export function youtubeKeyboard(lines: string[], onChange: (text: string) => void): Keyboard {
    var labels = { space: 'Space', del: DELETE, clear: 'Clear', spaceUnits: 2 };
    var rows = ['abcdefg'.split('').concat([labels.del])].concat(lines.map(function (line) { return line.split(''); }), [[labels.space, labels.clear]]);
    var keyboard = new Keyboard(labels, onChange, rows);
    sideKey(keyboard, DELETE, 'backspace');
    return keyboard;
}

/** A side key: its icon instead of its label (none: the label stays), styled as a side key */
function sideKey(keyboard: Keyboard, label: string, name?: string): void {
    var el = keyboard.keyEl(label);
    if (el) {
        el.setAttribute('data-side', '');
        if (name) {
            setText(el, '');
            el.appendChild(icon(name, 'bd-key-icon'));
        }
    }
}

export class SearchKeyboard {
    keyboard: Keyboard;
    language: KeyboardLanguage;
    /** The numbers and symbols show (&123) */
    private symbols = false;
    /** The language key was pressed; the keys changed (another language, or &123 and ABC: its height may differ) */
    onLanguage: () => void = function () { return undefined; };
    onLayout: () => void = function () { return undefined; };

    /** id: the language (keyboardLanguage); onChange: gets the text after each key */
    constructor(id: string, onChange: (text: string) => void) {
        var self = this;
        this.language = keyboardLanguage(id);
        this.keyboard = new Keyboard(this.labels(), onChange, this.lines());
        this.keyboard.actions[NUMBERS] = function () { self.showSymbols(true); };
        this.keyboard.actions[LETTERS] = function () { self.showSymbols(false); };
        this.keyboard.actions[LANGUAGE] = function () { self.onLanguage(); };
        this.keyboard.typer = function (text, key) { return composed(text, key, self.language.compose); };
        this.keyboard.eraser = function (text) { return erased(text, self.language.compose); };
        this.dress();
    }

    /** The submitting key's label (the language's Search) */
    get enter(): string {
        return this.language.words[2];
    }

    /** The field's hint while nothing is typed */
    get hint(): string {
        return this.language.words[3] || this.language.words[2];
    }

    setLanguage(id: string): void {
        this.language = keyboardLanguage(id);
        this.symbols = false;
        this.draw();
    }

    /** (the focus on the key that swaps back) */
    private showSymbols(on: boolean): void {
        this.symbols = on;
        this.draw(on ? LETTERS : NUMBERS);
    }

    private labels(): KeyboardLabels {
        var words = this.language.words;
        return { space: words[0], del: DELETE, clear: words[1], enter: words[2], spaceUnits: 2 };
    }

    private draw(focus?: string): void {
        this.keyboard.setLayout(this.labels(), this.lines(), focus);
        this.dress();
        this.onLayout();
    }

    /** The rows (the letters, or the numbers and symbols) with the side keys, then Space, Clear and Search */
    private lines(): string[][] {
        var side = this.symbols ? [DELETE, LETTERS] : [DELETE, NUMBERS, LANGUAGE];
        var lines = (this.symbols ? SYMBOLS : this.language.rows).map(function (row, i) {
            var keys = row.split('').map(function (c) { return c === GAP ? '' : c; });
            return side[i] ? keys.concat([side[i]]) : keys;
        });
        lines.push(this.language.words.slice(0, 3));
        return lines;
    }

    /** The side keys' looks */
    private dress(): void {
        sideKey(this.keyboard, DELETE, 'backspace');
        sideKey(this.keyboard, NUMBERS);
        sideKey(this.keyboard, LETTERS);
        sideKey(this.keyboard, LANGUAGE, 'language');
    }
}
