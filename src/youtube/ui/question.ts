// Full-screen confirmation before an action that cannot be undone, as in YouTube's TV app (e.g. "Clear watch
// history?"): covers the rail too and shows a picture, the question, a subtitle and two buttons (the action, then
// Cancel, which is focused). Up/Down move between them, OK presses, Left or Back close. Styled by the theme
// (by-question, reusing Settings' texts and buttons).

import { h, setShown, setSrc } from '../../core/dom.js';
import { KEY } from '../../core/keys.js';
import { Pills } from './pills.js';

export interface Asking {
    title: string;
    subtitle: string;
    /** '' none; round: an account picture */
    picture: string;
    round?: boolean;
    yes: string;
    no: string;
}

export class Question {
    el: HTMLElement;
    private pills = new Pills('by-settings-button--focused');
    private closed: () => void = function () { return undefined; };

    constructor(parent: HTMLElement) {
        this.el = h('div', 'by-question');
        setShown(this.el, false);
        parent.appendChild(this.el);
    }

    get shown(): boolean {
        return this.el.style.visibility !== 'hidden';
    }

    /** Asks the question (yes: the first button was pressed; closed: called once it closes, also after yes) */
    open(ask: Asking, yes: () => void, closed?: () => void): void {
        var self = this;
        this.el.innerHTML = '';
        if (ask.picture) {
            var picture = h('img', 'by-settings-picture' + (ask.round ? ' by-question-round' : '')) as HTMLImageElement;
            setSrc(picture, ask.picture);
            this.el.appendChild(picture);
        }
        this.el.appendChild(h('div', 'by-settings-heading', ask.title));
        this.el.appendChild(h('div', 'by-settings-summary', ask.subtitle));
        var box = this.el.appendChild(h('div', 'by-settings-buttons')) as HTMLElement;
        this.pills.clear();
        this.pills.add(box.appendChild(h('div', 'by-settings-button', ask.yes)) as HTMLElement, function () {
            self.close();
            yes();
        });
        this.pills.add(box.appendChild(h('div', 'by-settings-button', ask.no)) as HTMLElement, function () { self.close(); });
        this.pills.focus(1);
        this.pills.setFocused(true);
        this.closed = closed || function () { return undefined; };
        setShown(this.el, true);
    }

    /** Handles keys (takes all of them while shown) */
    onKey(code: number): boolean {
        if (!this.shown) {
            return false;
        }
        switch (code) {
            case KEY.UP:
            case KEY.DOWN:
                this.pills.move(code === KEY.UP ? -1 : 1);
                break;
            case KEY.OK:
                this.pills.press();
                break;
            case KEY.LEFT:
            case KEY.BACK:
                this.close();
                break;
        }
        return true;
    }

    close(): void {
        if (this.shown) {
            setShown(this.el, false);
            this.el.innerHTML = '';
            this.closed();
        }
    }
}
