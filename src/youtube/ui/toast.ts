// A short message styled like YouTube's TV app toasts: a dark rounded box at
// the top right, an optional icon before the text, fading in (0.4 s),
// staying about three seconds, fading out (0.5 s); shown over the player
// too. A new toast replaces the one showing. An optional coloured left edge
// tells its kind: a problem, or the SponsorBlock category skipped. The look
// comes from the theme (by-toast).

import { h, setText } from '../../core/dom.js';
import { icon, setIcon } from './icons.js';

/** Time from start until the fade-out begins (fade-in included, as YouTube's) */
var SHOWN_MS = 3500;

var box: HTMLElement | null = null;
var mark: HTMLElement;
var label: HTMLElement;
var timer = 0;

/** Shows text. iconName: an icon from ui/icons.ts (e.g. 'check'); edge: the left-edge kind, PROBLEM or skipEdge() */
export function toast(text: string, iconName?: string, edge?: string): void {
    if (!box) {
        box = h('div', 'by-toast');
        mark = box.appendChild(icon('check', 'by-toast-icon')) as HTMLElement;
        label = box.appendChild(h('div', 'by-toast-text')) as HTMLElement;
        document.body.appendChild(box);
    }
    var el = box;
    if (iconName) {
        setIcon(mark, iconName);
    }
    mark.style.display = iconName ? '' : 'none';
    setText(label, text);
    // Restart the fade-in; the edge class stays while it fades out
    var base = edge ? 'by-toast by-toast--edge by-toast--' + edge : 'by-toast';
    el.className = base;
    void el.offsetWidth;
    el.className = base + ' by-toast--shown';
    clearTimeout(timer);
    timer = setTimeout(function () { el.className = base; }, SHOWN_MS) as unknown as number;
}

/** Edge for a toast saying something went wrong */
export var PROBLEM = 'problem';

/** Edge for a toast saying a SponsorBlock segment of this category was skipped */
export function skipEdge(category: string): string {
    return 'sb-' + category;
}
