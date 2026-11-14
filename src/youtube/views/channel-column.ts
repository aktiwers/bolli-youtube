// Subscriptions' channels in a column at the side, as YouTube's TV app lists them: "All", YouTube's first-listed
// channels, its "A-Z" label, then every channel A to Z; each a round picture and its name, a blue dot on the picture
// of one with new videos. A heavy user has over 300 channels, so it works as a tile row does (ui/tile-row.ts): an
// item is built when it first nears the view and stays; only the items near the view are drawn, and only those
// have their pictures; every item stands at a place worked out from its index (nothing is measured) in a list as
// tall as all of them (a layer whose outline never changes), which moves by its transform: the focused item stays
// in the middle once the list scrolls. A step changes two class names, one transform and, at the view's edges, one
// item each. The screen moves the focus and says what a move means (views/subscriptions.ts).

import { h, setSrc, setText, toggleClass, translate } from '../core/dom.js';
import { tr } from '../core/i18n.js';
import { SubChannel } from '../api/feed.js';
import { channelKey } from '../api/looked.js';
import { icon } from '../ui/icons.js';
import { metrics } from '../ui/theme.js';

/** Items drawn beyond those in sight, above and below (the list slides an item a step; a held key several) */
var AROUND = 3;

/** An item as built: its element, its picture and dot (null: "All" has none), whether its picture is asked for */
interface Item {
    el: HTMLElement;
    picture: HTMLImageElement | null;
    dot: HTMLElement | null;
    pictured: boolean;
}

export class ChannelColumn {
    el: HTMLElement;
    private list: HTMLElement;
    private label: HTMLElement;
    /** The channels in YouTube's order, its first-listed ones before the rest; item i is channels[i - 1] (item 0: "All") */
    private channels: SubChannel[] = [];
    /** How many of them are the first-listed ones, and whether the label stands after them */
    private first = 0;
    private labelled = false;
    /** The focused item */
    at = 0;
    /** The items built so far, by index, and the range drawn: from, up to not including to */
    private items: (Item | undefined)[] = [];
    private from = 0;
    private to = 0;
    /** The item marked as focused or chosen (-1: none), and whether the column has the keys' focus (else the item is
     * only chosen, grey) */
    private marked = -1;
    private focused = false;
    /** The channels shown with a dot, by their key (api/looked.ts channelKey) */
    private dotted: { [key: string]: boolean } = {};
    /** In sight: the items drawn have their pictures (else none has: they come when it shows) */
    private shown = false;

    constructor() {
        this.el = h('div', 'by-subs-column');
        this.list = h('div', 'by-subs-items');
        this.label = h('div', 'by-subs-label');
        this.list.appendChild(this.label);
        this.el.appendChild(this.list);
        this.set([]);
    }

    /** How many items it has ("All" and the channels) */
    get count(): number {
        return this.channels.length + 1;
    }

    /** The focused item's channel (null: "All") */
    get channel(): SubChannel | null {
        return this.channels[this.at - 1] || null;
    }

    /** Lists channels (in YouTube's order: its first-listed ones, then all of them A-Z under the label). The focus
     * follows the channel it is on: to where the list has it in the same part (among the first ones, or in A-Z), else
     * to its other place (one no longer among the first is still in A-Z); to "All" only if the list has it nowhere */
    set(channels: SubChannel[]): void {
        var m = metrics().subs;
        var was = this.channel;
        var first = channels.filter(function (c) { return c.recent; }).length;
        var at = 0;
        var other = 0;
        for (var n = 0; was && n < channels.length && !at; n++) {
            if (channelKey(channels[n]) === channelKey(was)) {
                at = channels[n].recent === was.recent ? n + 1 : 0;
                other = other || n + 1;
            }
        }
        at = at || other;
        for (var i = 0; i < this.items.length; i++) {
            var had = this.items[i];
            if (had) {
                this.list.removeChild(had.el);
            }
        }
        this.items = [];
        this.from = this.to = 0;
        this.marked = -1;
        this.channels = channels;
        this.first = first;
        this.labelled = first < channels.length;
        this.at = at;
        this.label.style.display = this.labelled ? '' : 'none';
        this.label.style.top = (first + 1) * m.item + 'px';
        this.list.style.height = this.top(this.count) + 'px';
        this.draw();
    }

    /** The words of the label before the A-Z list (YouTube's own) */
    setLabel(label: string): void {
        setText(this.label, label);
    }

    /** Up or Down by delta; false past an end */
    move(delta: number): boolean {
        var to = this.at + delta;
        if (to < 0 || to >= this.count) {
            return false;
        }
        this.focus(to);
        return true;
    }

    focus(index: number): void {
        this.at = Math.max(0, Math.min(index, this.count - 1));
        this.draw();
    }

    /** The column has the keys' focus (its item white), or not (grey: the rail has them) */
    setFocused(focused: boolean): void {
        if (focused !== this.focused) {
            this.focused = focused;
            var el = (this.items[this.at] as Item).el;
            toggleClass(el, 'by-subs-item--focused', focused);
            toggleClass(el, 'by-subs-item--at', !focused);
        }
    }

    /** The channels to show a dot on, by their key (an item not drawn gets its dot as it is drawn) */
    setDots(dotted: { [key: string]: boolean }): void {
        this.dotted = dotted;
        for (var i = this.from; i < this.to; i++) {
            this.dot(i);
        }
    }

    /** In sight or not: out of sight the pictures are let go, in sight those of the items drawn are asked for */
    setShown(shown: boolean): void {
        if (shown !== this.shown) {
            this.shown = shown;
            for (var i = this.from; i < this.to; i++) {
                this.picture(i, shown);
            }
        }
    }

    /** The item that holds target (a click's; -1: none) */
    holding(target: HTMLElement): number {
        for (var i = this.from; i < this.to; i++) {
            if ((this.items[i] as Item).el.contains(target)) {
                return i;
            }
        }
        return -1;
    }

    /** Item i's place in the list: the items one under the other, the label between the first-listed channels and
     * the rest */
    private top(i: number): number {
        var m = metrics().subs;
        return i * m.item + (this.labelled && i > this.first ? m.label : 0);
    }

    /** Moves the list for the focused item, draws the items that came near the view (built on their first time), lets
     * go of those that left it, and marks the focused one: only what changed is touched */
    private draw(): void {
        var m = metrics().subs;
        var count = this.count;
        var offset = Math.max(0, Math.min(this.top(count) - m.view, this.top(this.at) + m.item / 2 - m.view / 2));
        translate(this.list, 0, -offset);
        // (the label shifts the items after it by less than an item: one more above covers it)
        var from = Math.max(0, Math.floor(offset / m.item) - 1 - AROUND);
        var to = Math.min(count, Math.ceil((offset + m.view) / m.item) + AROUND);
        for (var i = Math.min(from, this.from); i < Math.max(to, this.to); i++) {
            var drawn = i >= from && i < to;
            if (drawn === (i >= this.from && i < this.to)) {
                continue;
            }
            var item = this.items[i] || this.build(i);
            item.el.style.display = drawn ? '' : 'none';
            this.picture(i, drawn && this.shown);
            if (drawn) {
                this.dot(i);
            }
        }
        this.from = from;
        this.to = to;
        if (this.marked !== this.at) {
            var had = this.items[this.marked];
            if (had) {
                toggleClass(had.el, 'by-subs-item--focused', false);
                toggleClass(had.el, 'by-subs-item--at', false);
            }
            toggleClass((this.items[this.at] as Item).el, this.focused ? 'by-subs-item--focused' : 'by-subs-item--at', true);
            this.marked = this.at;
        }
    }

    /** Builds item i in its place, not drawn yet: "All" with its list icon, or a channel's picture, dot and name */
    private build(i: number): Item {
        var c = this.channels[i - 1];
        var el = h('div', 'by-subs-item');
        var picture: HTMLImageElement | null = null;
        var dot: HTMLElement | null = null;
        el.style.top = this.top(i) + 'px';
        el.style.display = 'none';
        if (!c) {
            el.appendChild(icon('list', 'by-subs-item-icon'));
        } else {
            picture = el.appendChild(h('img', 'by-subs-item-picture')) as HTMLImageElement;
            dot = el.appendChild(h('div', 'by-subs-item-dot')) as HTMLElement;
        }
        el.appendChild(h('div', 'by-subs-item-name', c ? c.title : tr('All')));
        this.list.appendChild(el);
        return this.items[i] = { el: el, picture: picture, dot: dot, pictured: false };
    }

    /** Asks for item i's picture, or lets it go */
    private picture(i: number, on: boolean): void {
        var item = this.items[i] as Item;
        if (!item.picture || item.pictured === on) {
            return;
        }
        item.pictured = on;
        if (on) {
            setSrc(item.picture, this.channels[i - 1].picture);
        } else {
            item.picture.removeAttribute('src');
        }
    }

    /** Shows or hides item i's dot as its channel has one */
    private dot(i: number): void {
        var dot = (this.items[i] as Item).dot;
        if (dot) {
            dot.style.display = this.dotted[channelKey(this.channels[i - 1])] ? '' : 'none';
        }
    }
}
