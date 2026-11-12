// A choice in Settings' right side (views/settings.ts). In a list: a button with its name and a tick (shown on the
// set one). In a grid (the Branding settings): a tile with the picture alone (a logo), the colour itself (Tile
// colour) or a sign (a plus: the tile adds a choice; a struck circle: none), the tick in a corner; its name is said
// under the grid while it is focused. Built once when the choices are drawn: moving the focus changes only classes.
// Styled by themes/<id>.css (by-settings-button, by-settings-tile).

import { h } from '../core/dom.js';
import { Choice } from '../api/prefs.js';
import { icon } from './icons.js';

/** The button of choice c, and its tick */
export function choiceButton(c: Choice): { el: HTMLElement; check: HTMLElement } {
    var el = h('div', 'by-settings-button', c.name);
    return { el: el, check: el.appendChild(icon('check', 'by-check')) as HTMLElement };
}

/** The tile of choice c, and its tick */
export function choiceTile(c: Choice): { el: HTMLElement; check: HTMLElement } {
    var el = h('div', 'by-settings-tile' + (c.color ? ' by-settings-tile--color' : ''));
    if (c.color) {
        el.style.backgroundColor = c.color;
    } else if (c.picture) {
        var img = h('img', 'by-settings-tile-picture' + (c.round ? ' by-settings-tile-picture--round' : '')) as HTMLImageElement;
        img.src = c.picture;
        el.appendChild(img);
    } else if (c.tile === 'add') {
        el.appendChild(icon('add', 'by-settings-tile-sign'));
    } else if (c.tile === 'none') {
        el.appendChild(h('div', 'by-settings-tile-sign by-settings-tile-sign--none'));
    }
    return { el: el, check: el.appendChild(icon('check', 'by-check')) as HTMLElement };
}
