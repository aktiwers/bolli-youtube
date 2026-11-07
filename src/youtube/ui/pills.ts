// A row of buttons navigated with Left/Right (watch page, channel page, "Up next", page tabs;
// the caller places their elements): OK presses the focused one; one that cannot act now is
// hidden and skipped. The focused one gets the given class while the row has the focus. A click (the Magic Remote's
// pointer) focuses the button under it, then presses it as OK.

import { LAYOUT_WIDTH, toggleClass, translate } from '../core/dom.js';
import { KEY } from '../core/keys.js';
import { takesPointer } from '../core/pointer.js';
import { metrics } from './theme.js';

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
        var self = this;
        var index = this.pills.push({ el: el, press: press, usable: usable }) - 1;
        takesPointer(el, function () {
            if (!self.usable(index)) {
                return null;
            }
            self.focus(index);
            return {};
        });
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

    /** Keys on the row: Left/Right move along it (then on.moved), Left past the first is not taken (the rail gets it);
     * OK presses the focused one; on.up and on.down take Up and Down (true: taken; none: taken, nothing done) */
    key(code: number, on?: { up?: () => boolean; down?: () => boolean; moved?: () => void }): boolean {
        var o = on || {};
        switch (code) {
            case KEY.LEFT:
            case KEY.RIGHT:
                if (this.move(code === KEY.LEFT ? -1 : 1)) {
                    if (o.moved) {
                        o.moved();
                    }
                    return true;
                }
                return code === KEY.RIGHT;
            case KEY.OK:
                this.press();
                return true;
            case KEY.UP:
                return o.up ? o.up() : true;
            case KEY.DOWN:
                return o.down ? o.down() : true;
        }
        return false;
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

    /** Slides strip (the pills, step px apart from the rows' left edge) so the focused one stays in view */
    slide(strip: HTMLElement, step: number): void {
        var inView = Math.floor((LAYOUT_WIDTH - metrics().rows.pad) / step);
        translate(strip, -Math.max(0, this.at - inView + 1) * step, 0);
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
