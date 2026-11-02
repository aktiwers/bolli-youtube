// An on-screen keyboard for the remote's arrows and OK: a default layout
// (a-å, digits, a wide space key) or lines of keys the app supplies (e.g. an
// address keyboard). The app labels the special keys (space, delete, clear,
// and optionally enter: onEnter). Left/Right wrap within a line; Up/Down go
// to the key under the same spot. Up on the first line and Down on the last
// are not handled, so the surrounding screen can move focus. Only the keys
// losing and gaining focus are restyled.

import { h, setClass } from '../core/dom.js';
import { digit, KEY } from '../core/keys.js';

export interface KeyboardLabels {
    space: string;
    del: string;
    clear: string;
    /** Label of a key that calls onEnter (absent: no such key) */
    enter?: string;
    /** Key widths Space spans (default 3) */
    spaceUnits?: number;
}

interface Key {
    label: string;
    el: HTMLElement;
    /** Unit position, for Up/Down between lines */
    start: number;
    units: number;
}

export class Keyboard {
    el: HTMLElement;
    text = '';
    private keys: Key[][] = [];
    private line = 0;
    private col = 0;
    private focused = false;
    private marked: Key | null = null;
    /** Called when the enter key is pressed */
    onEnter: () => void = function () { return undefined; };

    /** onChange: gets the text after each key; lines: custom keys, line by line (special keys by their labels),
     * instead of the default layout */
    constructor(private labels: KeyboardLabels, private onChange: (text: string) => void, lines?: string[][]) {
        lines = lines || [
            'abcdefghijklmno'.split(''),
            'pqrstuvwxyzæøå'.split('').concat([labels.del]),
            '1234567890'.split('').concat([labels.space, labels.clear])
        ];
        var wide: { [label: string]: number } = {};
        wide[labels.space] = labels.spaceUnits || 3;
        wide[labels.clear] = 2;
        if (labels.enter) {
            wide[labels.enter] = 2;
        }
        this.el = h('div', 'bd-keyboard');
        for (var l = 0; l < lines.length; l++) {
            var lineEl = h('div', 'bd-keyboard-line');
            var keys: Key[] = [];
            var start = 0;
            for (var k = 0; k < lines[l].length; k++) {
                var label = lines[l][k];
                var units = wide[label] || 1;
                var el = h('div', keyClass(units, false), label);
                lineEl.appendChild(el);
                keys.push({ label: label, el: el, start: start, units: units });
                start += units;
            }
            this.el.appendChild(lineEl);
            this.keys.push(keys);
        }
    }

    get onFirstLine(): boolean {
        return this.line === 0;
    }

    /** The focused key's label */
    get focusedLabel(): string {
        return this.keys[this.line][this.col].label;
    }

    /** The key element with this label, or null */
    keyEl(label: string): HTMLElement | null {
        for (var l = 0; l < this.keys.length; l++) {
            for (var k = 0; k < this.keys[l].length; k++) {
                if (this.keys[l][k].label === label) {
                    return this.keys[l][k].el;
                }
            }
        }
        return null;
    }

    /** Focus is on the leftmost key (Left would wrap to the right) */
    get atLeftEdge(): boolean {
        return this.col === 0;
    }

    setFocused(focused: boolean): void {
        this.focused = focused;
        this.mark();
    }

    onKey(code: number): boolean {
        var keys = this.keys[this.line];
        switch (code) {
            case KEY.LEFT:
                this.col = (this.col + keys.length - 1) % keys.length;
                break;
            case KEY.RIGHT:
                this.col = (this.col + 1) % keys.length;
                break;
            case KEY.UP:
                if (this.line === 0) {
                    return false;
                }
                this.toLine(this.line - 1);
                break;
            case KEY.DOWN:
                if (this.line === this.keys.length - 1) {
                    return false;
                }
                this.toLine(this.line + 1);
                break;
            case KEY.OK:
                this.press(keys[this.col].label);
                break;
            default:
                return false;
        }
        this.mark();
        return true;
    }

    /** Types the digit of a remote number key; returns whether it was one */
    typeDigit(code: number): boolean {
        var n = digit(code);
        if (n >= 0) {
            this.type(String(n));
        }
        return n >= 0;
    }

    type(chars: string): void {
        this.setText(this.text + chars);
    }

    /** Sets the starting text (e.g. a saved address) without calling onChange */
    setValue(text: string): void {
        this.text = text;
    }

    private press(label: string): void {
        if (label === this.labels.enter) {
            this.onEnter();
        } else if (label === this.labels.del) {
            this.setText(this.text.slice(0, -1));
        } else if (label === this.labels.clear) {
            this.setText('');
        } else {
            this.type(label === this.labels.space ? ' ' : label);
        }
    }

    private setText(text: string): void {
        this.text = text;
        this.onChange(text);
    }

    /** Moves to the key under the same spot on another line */
    private toLine(line: number): void {
        var key = this.keys[this.line][this.col];
        var middle = key.start + key.units / 2;
        var keys = this.keys[line];
        this.col = keys.length - 1;
        for (var i = 0; i < keys.length; i++) {
            if (middle < keys[i].start + keys[i].units) {
                this.col = i;
                break;
            }
        }
        this.line = line;
    }

    private mark(): void {
        var want = this.focused ? this.keys[this.line][this.col] : null;
        if (want !== this.marked) {
            if (this.marked) {
                setClass(this.marked.el, keyClass(this.marked.units, false));
            }
            if (want) {
                setClass(want.el, keyClass(want.units, true));
            }
            this.marked = want;
        }
    }
}

function keyClass(units: number, focused: boolean): string {
    return (units > 1 ? 'bd-key bd-key--wide' + units : 'bd-key') + (focused ? ' bd-key--focused' : '');
}
