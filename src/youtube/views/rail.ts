// The left rail, as in YouTube's TV app: the logo at the top (OK opens its menu, including Settings), section
// icons below it, the clock at the top right. When focused it expands to show the section names. Up/Down move
// the focus at once but switch the section only once the focus rests (REST_MS), since drawing a screen takes the
// TV a few hundred ms and would stutter on every section passed; Right or OK enter it at once. Icons: ui/icons.ts.

import { h, setClass, setShown, setSrc, setText } from '../../core/dom.js';
import { KEY, KeyHandler } from '../../core/keys.js';
import { icon } from '../ui/icons.js';
import { metrics } from '../ui/theme.js';

/** The focused section shows after the focus rests this long (drawing one takes the TV ~300 ms, which delays the
 * next key step) */
var REST_MS = 500;

export interface RailItem {
    id: string;
    label: string;
    /** An icon of ui/icons.ts */
    icon: string;
    /** A divider line above it (shown with the names) */
    divider?: boolean;
    /** At the bottom of the rail (Settings, as on YouTube) */
    bottom?: boolean;
}

/** An entry in the logo's menu: an action returning true keeps the menu open; picture: a round image before the
 * label (the account's); entries: a submenu shown in its place on OK (Back returns) */
export interface RailEntry {
    label: string;
    action?: () => boolean | void;
    picture?: string;
    entries?: RailEntry[];
}

export class Rail implements KeyHandler {
    el: HTMLElement;
    private logo: HTMLElement;
    private drop: HTMLElement;
    private dropEls: HTMLElement[] = [];
    private entries: RailEntry[] = [];
    /** A submenu is shown (Back returns to the menu) */
    private inner = false;
    private clock: HTMLElement;
    private els: HTMLElement[] = [];
    /** Items above the divider (they move up as the names show) */
    private tops: boolean[] = [];
    /** The section shown */
    private selected = 0;
    /** Focus position: -1 the logo, else an item index */
    private at = 0;
    private focused = false;
    /** The logo's menu is open with this entry focused (-1: closed) */
    private dropIndex = -1;
    /** Shows the focused section once the focus rests there */
    private restTimer = 0;

    /** logoEntries: builds the logo's menu in its current state */
    constructor(private items: RailItem[], private onSelect: (id: string) => void, private onLeave: () => void,
                private logoEntries: () => RailEntry[]) {
        this.el = h('div', 'by-rail');
        this.el.appendChild(h('div', 'by-rail-shade'));
        this.logo = h('div', 'by-rail-logo');
        this.el.appendChild(this.logo);
        var m = metrics().rail;
        // Items above the divider move up a little as the names show, to make room for it (as on YouTube)
        var top = true;
        for (var i = 0; i < items.length; i++) {
            var y = items[i].bottom ? m.bottom : m.top + i * m.step;
            if (items[i].divider) {
                top = false;
                var line = h('div', 'by-rail-divider');
                line.style.top = y - m.step / 4 + 'px';
                this.el.appendChild(line);
            }
            var item = h('div', 'by-rail-item');
            this.tops.push(top);
            item.style.top = y + 'px';
            item.appendChild(icon(items[i].icon, 'by-rail-icon'));
            item.appendChild(h('div', 'by-rail-label', items[i].label));
            this.els.push(this.el.appendChild(item) as HTMLElement);
        }
        this.drop = h('div', 'bd-menu-drop by-rail-drop');
        setShown(this.drop, false);
        this.el.appendChild(this.drop);
        this.clock = h('div', 'by-clock');
        this.el.appendChild(this.clock);
        this.mark();
    }

    /** Marks the section shown when switched from elsewhere (Back to Subscriptions; Settings: no rail item) */
    select(id: string): void {
        clearTimeout(this.restTimer);
        this.selected = -1;
        for (var i = 0; i < this.items.length; i++) {
            if (this.items[i].id === id) {
                this.selected = i;
            }
        }
        this.at = Math.max(0, this.selected);
        this.mark();
    }

    setFocused(focused: boolean): void {
        if (focused !== this.focused) {
            this.focused = focused;
            this.at = Math.max(0, this.selected);
            this.dropIndex = -1;
            this.mark();
        }
    }

    setClock(text: string): void {
        setText(this.clock, text);
    }

    onKey(code: number): boolean {
        if (this.dropIndex >= 0) {
            return this.dropKey(code);
        }
        switch (code) {
            case KEY.UP:
                if (this.at > -1) {
                    this.go(this.at - 1);
                }
                return true;
            case KEY.DOWN:
                if (this.at < this.items.length - 1) {
                    this.go(this.at + 1);
                }
                return true;
            case KEY.OK:
                if (this.at < 0) {
                    this.openDrop();
                } else {
                    this.showNow();
                    this.onLeave();
                }
                return true;
            case KEY.RIGHT:
                if (this.at >= 0) {
                    this.showNow();
                    this.onLeave();
                }
                return true;
        }
        return false;
    }

    /** Focuses an item (its section shows once the focus rests there) or the logo (-1) */
    private go(at: number): void {
        this.at = at;
        clearTimeout(this.restTimer);
        if (at >= 0 && at !== this.selected) {
            var self = this;
            this.restTimer = setTimeout(function () { self.showNow(); }, REST_MS) as unknown as number;
        }
        this.mark();
    }

    /** Shows the focused item's section now (the focus rested, or entered the section) */
    private showNow(): void {
        clearTimeout(this.restTimer);
        if (this.at >= 0 && this.at !== this.selected) {
            this.selected = this.at;
            this.onSelect(this.items[this.at].id);
            this.mark();
        }
    }

    private dropKey(code: number): boolean {
        switch (code) {
            case KEY.UP:
                this.dropIndex = Math.max(0, this.dropIndex - 1);
                break;
            case KEY.DOWN:
                this.dropIndex = Math.min(this.entries.length - 1, this.dropIndex + 1);
                break;
            case KEY.OK:
                var entry = this.entries[this.dropIndex];
                var keep = this.dropIndex;
                if (entry.entries) {
                    this.showEntries(entry.entries, true);
                } else if (entry.action && entry.action()) {
                    this.showEntries(this.inner ? this.entries : this.logoEntries(), this.inner);
                    this.dropIndex = Math.min(keep, this.entries.length - 1);
                } else {
                    this.dropIndex = -1;
                }
                break;
            case KEY.BACK:
            case KEY.LEFT:
                if (this.inner) {
                    this.openDrop();
                } else {
                    this.dropIndex = -1;
                }
                break;
        }
        this.mark();
        return true;
    }

    private openDrop(): void {
        this.showEntries(this.logoEntries(), false);
    }

    /** Shows these entries in the menu, the first focused (inner: a submenu) */
    private showEntries(entries: RailEntry[], inner: boolean): void {
        this.entries = entries;
        this.inner = inner;
        this.drop.innerHTML = '';
        this.dropEls = [];
        for (var i = 0; i < entries.length; i++) {
            var el = this.drop.appendChild(h('div', 'bd-menu-drop-item')) as HTMLElement;
            if (entries[i].picture) {
                setSrc(el.appendChild(h('img', 'by-rail-drop-picture')) as HTMLImageElement, entries[i].picture as string);
            }
            el.appendChild(document.createTextNode(entries[i].label));
            this.dropEls.push(el);
        }
        this.dropIndex = 0;
        this.mark();
    }

    private mark(): void {
        setClass(this.el, this.focused ? 'by-rail by-rail--open' : 'by-rail');
        setClass(this.logo, this.focused && this.at < 0 ? 'by-rail-logo by-rail-logo--focused' : 'by-rail-logo');
        for (var i = 0; i < this.els.length; i++) {
            var cls = this.tops[i] ? 'by-rail-item by-rail-item--top' : 'by-rail-item';
            if (i === this.selected) {
                cls += ' by-rail-item--selected';
            }
            if (this.focused && i === this.at) {
                cls += ' by-rail-item--focused';
            }
            setClass(this.els[i], cls);
        }
        var open = this.dropIndex >= 0;
        setClass(this.drop, open ? 'bd-menu-drop bd-menu-drop--open by-rail-drop' : 'bd-menu-drop by-rail-drop');
        setShown(this.drop, open);
        for (var j = 0; j < this.dropEls.length; j++) {
            setClass(this.dropEls[j], j === this.dropIndex ? 'bd-menu-drop-item bd-menu-drop-item--focused' : 'bd-menu-drop-item');
        }
    }
}
