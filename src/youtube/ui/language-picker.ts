// "More languages" in Settings › Subtitles: a searchable list of every
// language YouTube translates subtitles to (api/languages.ts), shown over
// Settings. Typed text at the top, matches left of the on-screen keyboard
// (src/ui/keyboard.ts): names (or a word of them) starting with the text
// first, then names containing it; with no text, all by name. Left at the
// keyboard's left edge moves to the list, Right back; OK picks a language;
// Back closes. Styled by themes/<id>.css (by-langs).

import { h, setShown, setText, toggleClass } from '../../core/dom.js';
import { KEY } from '../../core/keys.js';
import { Keyboard } from '../../ui/keyboard.js';
import { Language, languages } from '../api/languages.js';
import { icon } from './icons.js';
import { youtubeKeyboard } from './youtube-keyboard.js';

/** Visible list rows */
var ROWS = 9;

export class LanguagePicker {
    el: HTMLElement;
    shown = false;
    private field: HTMLElement;
    private keyboard: Keyboard;
    private rows: { el: HTMLElement; name: HTMLElement; check: HTMLElement }[] = [];
    private none: HTMLElement;
    /** Matching languages, first visible index, focused index, and focus area */
    private found: Language[] = [];
    private top = 0;
    private pick = 0;
    private at: 'keys' | 'list' = 'keys';
    /** The current language ('' none) and the callback for a picked one */
    private set = '';
    private chosen: (code: string) => void = function () { return undefined; };

    constructor(parent: HTMLElement) {
        var self = this;
        this.el = h('div', 'by-langs');
        this.el.appendChild(h('div', 'by-langs-title', 'Subtitles: more languages'));
        this.field = this.el.appendChild(h('div', 'by-langs-field')) as HTMLElement;
        var list = this.el.appendChild(h('div', 'by-langs-list')) as HTMLElement;
        for (var i = 0; i < ROWS; i++) {
            var el = list.appendChild(h('div', 'by-langs-item')) as HTMLElement;
            this.rows.push({ el: el, name: el.appendChild(h('span', 'by-langs-name')) as HTMLElement,
                check: el.appendChild(icon('check', 'by-check')) as HTMLElement });
        }
        this.none = list.appendChild(h('div', 'by-langs-none', 'No language has that name')) as HTMLElement;
        this.keyboard = youtubeKeyboard(['hijklmn', 'opqrstu', 'vwxyz-'], function (text) { self.find(text); });
        var keys = this.el.appendChild(h('div', 'by-langs-keys')) as HTMLElement;
        keys.appendChild(this.keyboard.el);
        setShown(this.el, false);
        parent.appendChild(this.el);
    }

    /** Show over Settings with empty text (set: the current language); chosen: called with the picked code */
    open(set: string, chosen: (code: string) => void): void {
        this.set = set;
        this.chosen = chosen;
        this.shown = true;
        this.at = 'keys';
        this.keyboard.setValue('');
        this.find('');
        setShown(this.el, true);
    }

    close(): void {
        if (this.shown) {
            this.shown = false;
            setShown(this.el, false);
        }
    }

    onKey(code: number): boolean {
        if (code === KEY.BACK) {
            this.close();
            return true;
        }
        if (this.at === 'keys') {
            if (code === KEY.LEFT && this.keyboard.atLeftEdge && this.found.length) {
                this.at = 'list';
            } else if (!this.keyboard.onKey(code) && !this.keyboard.typeDigit(code)) {
                return true;
            }
        } else {
            switch (code) {
                case KEY.UP:
                case KEY.DOWN:
                    this.pick = Math.max(0, Math.min(this.found.length - 1, this.pick + (code === KEY.UP ? -1 : 1)));
                    this.top = Math.max(Math.min(this.top, this.pick), this.pick - ROWS + 1);
                    break;
                case KEY.RIGHT:
                    this.at = 'keys';
                    break;
                case KEY.OK:
                    var picked = this.found[this.pick].code;
                    this.close();
                    this.chosen(picked);
                    return true;
            }
        }
        this.draw();
        return true;
    }

    /** Filter the languages by text and focus the first */
    private find(text: string): void {
        var typed = words(text);
        var first: Language[] = [];
        var then: Language[] = [];
        var all = languages();
        // (the names as matched, made once)
        names = names || all.map(function (l) { return words(l.name); });
        all.forEach(function (l, i) {
            var name = names![i];
            if (!typed || name.indexOf(typed) === 0 || name.indexOf(' ' + typed) >= 0 || l.code.toLowerCase() === typed) {
                first.push(l);
            } else if (name.indexOf(typed) > 0) {
                then.push(l);
            }
        });
        this.found = first.concat(then);
        this.top = this.pick = 0;
        if (!this.found.length) {
            this.at = 'keys';
        }
        this.draw();
    }

    private draw(): void {
        var text = this.keyboard.text;
        setText(this.field, text || 'Type a language');
        toggleClass(this.field, 'by-langs-field--empty', !text);
        this.keyboard.setFocused(this.at === 'keys');
        for (var i = 0; i < ROWS; i++) {
            var l = this.found[this.top + i];
            var row = this.rows[i];
            setShown(row.el, !!l);
            if (l) {
                setText(row.name, l.name);
                setShown(row.check, l.code === this.set);
                toggleClass(row.el, 'by-langs-item--focused', this.at === 'list' && this.top + i === this.pick);
            }
        }
        setShown(this.none, !this.found.length);
    }
}

/** The languages' names as find() matches them (words), in languages() order */
var names: string[] | null = null;

/** Normalise for matching: lower case, single spaces, no brackets or dashes, accents of YouTube's names removed
 * ("Chinese (Traditional)": "chinese traditional"; "Māori": "maori") */
function words(s: string): string {
    return s.toLowerCase().replace(/ā/g, 'a').replace(/[()\-\s]+/g, ' ').replace(/^ | $/g, '');
}
