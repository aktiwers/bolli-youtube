// YouTube's on-screen keyboard (Search, More languages): a to g with Delete
// as YouTube's backspace icon, then the caller's letters, then Space (as wide
// as the keys beside it), Clear and, if given, a key that submits.

import { setText } from '../../core/dom.js';
import { Keyboard } from '../../ui/keyboard.js';
import { icon } from './icons.js';

/** A keyboard with lines of keys (each a string) after a to g; enter: the label of a key that submits (onEnter) */
export function youtubeKeyboard(lines: string[], onChange: (text: string) => void, enter?: string): Keyboard {
    var labels = { space: 'Space', del: 'Delete', clear: 'Clear', enter: enter, spaceUnits: 2 };
    var bottom = [labels.space, labels.clear];
    if (enter) {
        bottom.push(enter);
    }
    var rows = ['abcdefg'.split('').concat([labels.del])].concat(lines.map(function (line) { return line.split(''); }), [bottom]);
    var keyboard = new Keyboard(labels, onChange, rows);
    var del = keyboard.keyEl(labels.del) as HTMLElement;
    setText(del, '');
    del.appendChild(icon('backspace', 'bd-key-icon'));
    return keyboard;
}
