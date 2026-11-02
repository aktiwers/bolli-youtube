// A row of buttons navigated with Left/Right (watch page, channel page, "Up next", page tabs;
// the caller places their elements): OK presses the focused one; one that cannot act now is
// hidden and skipped. The focused one gets the given class while the row has the focus.

import { toggleClass } from '../../core/dom.js';

interface Pill {
    el: HTMLElement;
    press: () => void;
    usable?: () => boolean;
}

export class Pills {
    /** The focused button */
    at = 0;
    private pills: Pill[] = [];
    private focused = false;

    constructor(private focusClass: string) {}

    get count(): number {
        return this.pills.length;
    }

    add(el: HTMLElement, press: () => void, usable?: () => boolean): HTMLElement {
        this.pills.push({ el: el, press: press, usable: usable });
        return el;
    }

    clear(): void {
        this.pills = [];
        this.at = 0;
    }

    /** Moves to the next usable one in step's direction; false at an end */
    move(step: number): boolean {
        for (var i = this.at + step; i >= 0 && i < this.pills.length; i += step) {
            if (this.usable(i)) {
                this.focus(i);
                return true;
            }
        }
        return false;
    }

    focus(index: number): void {
        this.mark(false);
        this.at = index;
        this.mark(true);
    }

    press(): void {
        if (this.pills[this.at]) {
            this.pills[this.at].press();
        }
    }

    setFocused(focused: boolean): void {
        this.focused = focused;
        this.mark(true);
    }

    /** Hides those that cannot act now, shows the others */
    draw(): void {
        for (var i = 0; i < this.pills.length; i++) {
            this.pills[i].el.style.display = this.usable(i) ? '' : 'none';
        }
    }

    private usable(i: number): boolean {
        var u = this.pills[i].usable;
        return !u || u();
    }

    /** Sets the focused one's class (on: only while the row has the focus) */
    private mark(on: boolean): void {
        if (this.pills[this.at]) {
            toggleClass(this.pills[this.at].el, this.focusClass, on && this.focused);
        }
    }
}
