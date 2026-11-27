// The left rail, as in YouTube's TV app: the logo at the top (OK opens its menu, including Settings), section
// icons below it, the clock at the top right. When focused it expands to show the section names. Up/Down move
// the focus at once but switch the section only once the focus rests (REST_MS), since drawing a screen takes the
// TV a few hundred ms and would stutter on every section passed; a section that stands ready (drawn out of sight:
// the app says so) has nothing to draw and shows with the step. Right or OK enter a section at once. A click (the Magic
// Remote's pointer) is OK on the item, the logo or a menu entry under it. Icons: ui/icons.ts. With no logo chosen
// (Settings › Theme › Logo) the logo's place is empty but still takes the focus (an empty square then) and opens the
// menu as ever.
// The entries are in the viewer's order, some hidden (arrange: Settings › Screens › Edit sidebar, each account's own),
// the line between YouTube's and one's own an entry of its own there. Edit mode (edit) arranges them in place: every
// entry listed, the hidden ones dimmed, an eye at the right of each; OK picks the focused one up and Up/Down carry it,
// OK puts it down (Back: where it was), Left/Right show or hide it; Settings stays at the bottom (hidden: main.ts
// offers it in the logo's menu); Reset to defaults asks first; Back saves. Its parts are made on its first use; a key
// there moves entries by their top, nothing else. An entry may start hidden (shown once the viewer shows it there, so it
// comes in hidden also into an order stored before it), and may open something of its own instead of a section (the
// Shorts screen): Right or OK opens it, a rest on it shows nothing.

import { h, setClass, setShown, setSrc, setText } from '../core/dom.js';
import { tr } from '../core/i18n.js';
import { KEY, KeyHandler, KEYS_GAP } from '../core/keys.js';
import { takesPointer } from '../core/pointer.js';
import { icon, railIcon, setIcon } from '../ui/icons.js';
import { drawLogo } from '../ui/logo.js';
import { lookTried, metrics, onRailLook, setRailWidth } from '../ui/theme.js';

/** The focused section shows after the focus rests this long (drawing one takes the TV ~300 ms, which delays the
 * next key step) */
var REST_MS = 500;
/** After a name or the look changed, the open width is fitted again once things rest this long (a layout read, never at a
 * key) */
var FIT_MS = 400;

/** One that stands ready: right after the highlight's frame (in the same frame the highlight would wait ~0.1 s for
 * the section's tiles) */
var READY_MS = 40;

/** The line between YouTube's entries and one's own, in an order; Reset to defaults, in edit mode's rows */
var DIVIDER = -2;
var RESET = -3;

/** Edit mode's hints: with an entry focused, and with one carried */
var HINT_FOCUS = [tr('OK: pick up'), tr('Left/Right: show or hide'), tr('Back: done')].join(KEYS_GAP);
var HINT_CARRY = [tr('Up/Down: move'), tr('OK: put down'), tr('Back: put back')].join(KEYS_GAP);

export interface RailItem {
    id: string;
    label: string;
    /** An icon of ui/icons.ts */
    icon: string;
    /** The line between YouTube's entries and one's own goes above it (where the viewer has not moved it) */
    divider?: boolean;
    /** At the bottom of the rail (Settings, as on YouTube): never moved, but may be hidden */
    bottom?: boolean;
    /** Hidden until the viewer shows it in edit mode (it is in their stored order then, not among the hidden) */
    later?: boolean;
    /** Opens something of its own, not a section (called on Right or OK only, never at a rest; the section shown kept) */
    opens?: () => void;
}

/** An entry in the logo's menu: its action (the menu closes); picture: a round image before the label (the account's);
 * entries: a submenu shown in its place on OK (Back returns) */
export interface RailEntry {
    label: string;
    action?: () => void;
    picture?: string;
    entries?: RailEntry[];
}

/** Edit mode's state: the row focused, the order before the entry carried was picked up (null: none carried), what to
 * call once Back leaves it, and what asks before Reset to defaults */
interface Editing {
    at: number;
    before: number[] | null;
    done: (order: string[], hidden: string[]) => void;
    confirm: (reset: () => void) => void;
}

export class Rail implements KeyHandler {
    el: HTMLElement;
    private logo: HTMLElement;
    /** The logo is the account's picture, drawn round */
    private logoRound = false;
    /** No logo is drawn (Settings › Theme › Logo): its place is empty, an empty square while focused */
    private noLogo = false;
    private drop: HTMLElement;
    private dropEls: HTMLElement[] = [];
    private entries: RailEntry[] = [];
    /** A submenu is shown (Back returns to the menu) */
    private inner = false;
    private clock: HTMLElement;
    /** The line between YouTube's entries and one's own, and whether it shows (entries shown on both sides of it) */
    private line: HTMLElement;
    private lineShown = false;
    private els: HTMLElement[] = [];
    /** Items above the line (they move up as the names show, to make room for it) */
    private tops: boolean[] = [];
    /** The entries in the viewer's order (items' indices, DIVIDER for the line; the bottom ones not in it), the bottom
     * ones, and those hidden (by index, DIVIDER the line) */
    private order: number[] = [];
    private bottoms: number[] = [];
    private hidden: { [n: number]: boolean } = {};
    /** Out of sight under a page over the whole screen (cover) */
    private covered = false;
    /** The items shown, top to bottom (the bottom ones last), as last placed; in edit mode its rows */
    private shown: number[] = [];
    private rows: number[] = [];
    /** The section shown */
    private selected = 0;
    /** Focus position: -1 the logo, else an item index */
    private at = 0;
    private focused = false;
    /** Shown open without the focus (Settings › Theme › Text size's Sidebar tab: its names at the size tried) */
    private shownOpen = false;
    /** The logo's menu is open with this entry focused (-1: closed) */
    private dropIndex = -1;
    /** Shows the focused section once the focus rests there */
    private restTimer = 0;
    /** The open width fitted again soon (fitSoon) */
    private fitTimer = 0;
    /** A fit was put off while a look was tried (fit) */
    private fitOwed = false;
    /** Edit mode (null: not in it), and its parts (made on its first use) */
    private editing: Editing | null = null;
    private editParts: { dim: HTMLElement; title: HTMLElement; hint: HTMLElement; line: HTMLElement; reset: HTMLElement; marks: HTMLElement[] } | null = null;

    /** onSelect: a section is shown (rested: the focus rested on its entry or passes it; else Right or OK entered it);
     * logoEntries: builds the logo's menu in its current state; ready: section id shows with nothing to draw (no rest
     * needed before it) */
    constructor(private items: RailItem[], private onSelect: (id: string, rested: boolean) => void, private onLeave: () => void,
                private logoEntries: () => RailEntry[], private ready: (id: string) => boolean) {
        this.el = h('div', 'by-rail');
        this.el.appendChild(h('div', 'by-rail-shade'));
        this.logo = h('div', 'by-rail-logo');
        this.el.appendChild(this.logo);
        this.line = this.el.appendChild(h('div', 'by-rail-divider')) as HTMLElement;
        for (var i = 0; i < items.length; i++) {
            var item = h('div', 'by-rail-item');
            this.tops.push(false);
            if (items[i].bottom) {
                this.bottoms.push(i);
            }
            item.appendChild(railIcon(items[i].icon, items[i].label, i + 1, 'by-rail-icon'));
            item.appendChild(h('div', 'by-rail-label', items[i].label));
            this.els.push(this.el.appendChild(item) as HTMLElement);
            this.pointTo(item, i);
        }
        this.order = this.defaultOrder();
        this.hideLater([]);
        this.place();
        this.pointTo(this.logo, -1);
        this.drop = h('div', 'bd-menu-drop by-rail-drop');
        setShown(this.drop, false);
        this.el.appendChild(this.drop);
        this.clock = h('div', 'by-clock');
        this.el.appendChild(this.clock);
        // The chosen logo (Settings › Theme › Logo), drawn anew when another is chosen (the account's picture round),
        // marked with the rest
        var self = this;
        drawLogo(function (file, round) {
            self.logo.style.backgroundImage = file ? 'url(' + file + ')' : '';
            self.logoRound = round;
            self.noLogo = !file;
            self.mark();
        });
        // (fitted again when the font or the sidebar's colour changes, and once a font's letters have come; a fit
        // put off while a look was tried, at its end)
        onRailLook(function (changed) {
            if (changed || self.fitOwed) {
                self.fitSoon();
            }
        });
        var fonts = (document as unknown as { fonts?: { addEventListener?: (type: string, fn: () => void) => void } }).fonts;
        if (fonts && fonts.addEventListener) {
            fonts.addEventListener('loadingdone', function () { self.fitSoon(); });
        }
    }

    /** The entries in the viewer's order (ids, 'divider' the line; empty: the app's; one no longer known left out, one
     * missing put back after the entry it follows in the app's order) with those hidden (all of the order's hidden:
     * all shown) */
    arrange(order: string[], hidden: string[]): void {
        // (another account's: edit mode left, its changes dropped)
        this.editing = null;
        var all = this.defaultOrder();
        var list: number[] = [];
        for (var i = 0; i < order.length; i++) {
            var n = this.indexOf(order[i]);
            if (all.indexOf(n) >= 0 && list.indexOf(n) < 0) {
                list.push(n);
            }
        }
        for (var j = 0; j < all.length; j++) {
            if (list.indexOf(all[j]) < 0) {
                list.splice(j ? list.indexOf(all[j - 1]) + 1 : 0, 0, all[j]);
            }
        }
        this.order = list;
        this.hidden = {};
        for (var k = 0; k < hidden.length; k++) {
            this.hidden[this.indexOf(hidden[k])] = true;
        }
        this.hideLater(order);
        if (!this.someShown(-1)) {
            this.hidden = {};
        }
        this.place();
        if (this.at >= 0 && this.shown.indexOf(this.at) < 0) {
            this.at = this.shown[0];
        }
        this.mark();
        this.fitSoon();
    }

    /** The entries that start hidden (RailItem.later) hidden, but those in order (the viewer's: shown there once) */
    private hideLater(order: string[]): void {
        for (var i = 0; i < this.items.length; i++) {
            if (this.items[i].later && order.indexOf(this.items[i].id) < 0) {
                this.hidden[i] = true;
            }
        }
    }

    /** Whether the entry id is in the rail and shown */
    shows(id: string): boolean {
        var n = this.indexOf(id);
        return n >= 0 && !this.hidden[n];
    }

    /** The first section shown (not an entry that opens something of its own) */
    get firstShown(): string {
        var self = this;
        var first = this.shown.filter(function (n) { return !self.items[n].opens; })[0];
        return this.items[first === undefined ? this.shown[0] : first].id;
    }

    /** In edit mode */
    get editingNow(): boolean {
        return !!this.editing;
    }

    /** The open sidebar as narrow as its names allow, none cut, the same room on both sides: its entries as wide as the widest name, after as much room as their icon has
     * before it; the shade with the same room after them as before them (ui/theme.ts setRailWidth). Read from the layout
     * (the names', the icon's and the entries' places), so it holds for any language, font and stylesheet. Nothing where
     * the entries are not laid out (a screen without the sidebar, edit mode): the stylesheet's width stays until the
     * next fit */
    fit(): void {
        clearTimeout(this.fitTimer);
        if (this.editing) {
            return;
        }
        // (a look tried: the sidebar is closed, and a fit restyles the whole page; owed to the try's end: ui/theme.ts)
        if (lookTried()) {
            this.fitOwed = true;
            return;
        }
        this.fitOwed = false;
        var widest = 0;
        var label: HTMLElement | null = null;
        for (var i = 0; i < this.shown.length; i++) {
            var one = this.els[this.shown[i]].querySelector('.by-rail-label') as HTMLElement;
            if (one && one.offsetWidth > widest) {
                widest = one.offsetWidth;
                label = one;
            }
        }
        var first = this.els[this.shown[0]];
        var icon = first ? first.querySelector('.by-rail-icon') as HTMLElement : null;
        if (!label || !icon) {
            return;
        }
        setRailWidth(label.offsetLeft + widest + icon.offsetLeft, first.offsetLeft);
    }

    /** fit once things rest (FIT_MS) */
    fitSoon(): void {
        var self = this;
        clearTimeout(this.fitTimer);
        this.fitTimer = setTimeout(function () { self.fit(); }, FIT_MS) as unknown as number;
    }

    /** Renames item id (YouTube's guide names) */
    setLabel(id: string, label: string): void {
        for (var i = 0; i < this.items.length; i++) {
            if (this.items[i].id === id) {
                this.items[i].label = label;
                setText(this.els[i].querySelector('.by-rail-label') as HTMLElement, label);
                this.fitSoon();
            }
        }
    }

    /** Marks the section shown when switched from elsewhere (Back to Subscriptions; Settings: no rail item) */
    select(id: string): void {
        clearTimeout(this.restTimer);
        this.selected = this.indexOf(id);
        this.at = this.home();
        this.mark();
    }

    setFocused(focused: boolean): void {
        if (focused !== this.focused) {
            this.focused = focused;
            // (edit mode left another way than Back, the voice key, a video: as Back, its changes kept)
            if (!focused && this.editing) {
                this.finish();
            }
            this.at = this.home();
            this.dropIndex = -1;
            this.mark();
        }
    }

    /** The logo's menu, while open (null: closed): a click beside it is Back */
    get openMenu(): HTMLElement | null {
        return this.dropIndex >= 0 ? this.drop : null;
    }

    /** Focused by a click on it: the item it took kept (setFocused would go back to the section shown) */
    pointed(): void {
        this.focused = true;
        this.mark();
    }

    setClock(text: string): void {
        setText(this.clock, text);
    }

    onKey(code: number): boolean {
        if (this.editing) {
            return this.editKey(code);
        }
        if (this.dropIndex >= 0) {
            return this.dropKey(code);
        }
        var shown = this.shown;
        var at = shown.indexOf(this.at);
        switch (code) {
            case KEY.UP:
                if (this.at > -1) {
                    this.go(at > 0 ? shown[at - 1] : -1);
                }
                return true;
            case KEY.DOWN:
                if (at < shown.length - 1) {
                    this.go(shown[at + 1]);
                }
                return true;
            case KEY.OK:
                if (this.at < 0) {
                    this.openDrop();
                } else {
                    this.leave();
                }
                return true;
            case KEY.RIGHT:
                if (this.at >= 0) {
                    this.leave();
                }
                return true;
        }
        return false;
    }

    /** Into the screen, the section pointed at shown at once (also a click on the screen beside the open rail; not in
     * edit mode, which Back leaves) */
    leave(): void {
        if (this.editing) {
            return;
        }
        if (this.at >= 0) {
            this.showNow(false);
        }
        this.onLeave();
    }

    /** Edit mode, the first entry focused; done(order, hidden) once Back leaves it, with the entries' ids in their order
     * ('divider' the line; empty: the app's order) and those hidden; confirm(reset) asks before Reset to defaults */
    edit(done: (order: string[], hidden: string[]) => void, confirm: (reset: () => void) => void): void {
        clearTimeout(this.restTimer);
        this.dropIndex = -1;
        // (its widths are written with the open rail's: ui/theme.ts setRailWidth; one layout read, as it opens)
        this.fit();
        this.editing = { at: 0, before: null, done: done, confirm: confirm };
        this.makeEditParts();
        this.place();
        this.mark();
    }

    /** A click on el is OK on item at (-1: the logo), the logo's menu closed; in edit mode on its row (an entry
     * carried: taken there first, then put down) */
    private pointTo(el: HTMLElement, at: number): void {
        var self = this;
        takesPointer(el, function () {
            var e = self.editing;
            if (e) {
                var to = self.rows.indexOf(at);
                if (!e.before) {
                    e.at = to;
                } else if (to >= 0 && to < self.order.length) {
                    self.moveTo(to);
                }
                return {};
            }
            self.dropIndex = -1;
            self.at = at;
            return {};
        });
    }

    /** A click on el is OK on entry index of the open menu */
    private pointToEntry(el: HTMLElement, index: number): void {
        var self = this;
        takesPointer(el, function () {
            self.dropIndex = index;
            return {};
        });
    }

    /** Focuses an item (its section shows once the focus rests there; at once if it stands ready) or the logo (-1) */
    private go(at: number): void {
        this.at = at;
        clearTimeout(this.restTimer);
        if (at >= 0 && at !== this.selected && !this.items[at].opens) {
            var self = this;
            this.restTimer = setTimeout(function () { self.showNow(true); }, this.ready(this.items[at].id) ? READY_MS : REST_MS) as unknown as number;
        }
        this.mark();
    }

    /** The item with the focus ('': the logo, or the rail has none) */
    get focusedId(): string {
        return this.focused && this.at >= 0 ? this.items[this.at].id : '';
    }

    /** Shows the focused item's section now (the focus rested, or entered the section) */
    private showNow(rested: boolean): void {
        clearTimeout(this.restTimer);
        var item = this.at >= 0 ? this.items[this.at] : null;
        if (item && item.opens) {
            if (!rested) {
                item.opens();
            }
            return;
        }
        if (this.at >= 0 && this.at !== this.selected) {
            this.selected = this.at;
            this.onSelect(this.items[this.at].id, rested);
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
                if (entry.entries) {
                    this.showEntries(entry.entries, true);
                } else {
                    this.dropIndex = -1;
                    if (entry.action) {
                        entry.action();
                    }
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
            this.pointToEntry(el, i);
        }
        this.dropIndex = 0;
        this.mark();
    }

    /** item id's index (-1: none; DIVIDER: the line) */
    private indexOf(id: string): number {
        if (id === 'divider') {
            return DIVIDER;
        }
        for (var i = 0; i < this.items.length; i++) {
            if (this.items[i].id === id) {
                return i;
            }
        }
        return -1;
    }

    /** Entry n's id ('divider': the line) */
    private idOf(n: number): string {
        return n === DIVIDER ? 'divider' : this.items[n].id;
    }

    /** The app's order: the items but the bottom ones, the line above the one marked */
    private defaultOrder(): number[] {
        var list: number[] = [];
        for (var i = 0; i < this.items.length; i++) {
            if (this.items[i].divider) {
                list.push(DIVIDER);
            }
            if (!this.items[i].bottom) {
                list.push(i);
            }
        }
        return list;
    }

    /** Whether an entry of the order besides n (-1: none left out) is shown */
    private someShown(n: number): boolean {
        for (var i = 0; i < this.order.length; i++) {
            var o = this.order[i];
            if (o >= 0 && o !== n && !this.hidden[o]) {
                return true;
            }
        }
        return false;
    }

    /** Where the focus goes in the rail: the section shown, else the first entry shown */
    private home(): number {
        return this.shown.indexOf(this.selected) >= 0 ? this.selected : this.shown[0];
    }

    /** Edit mode's row for entry n (DIVIDER: the line's, RESET: Reset to defaults') */
    private rowEl(n: number): HTMLElement {
        var p = this.editParts!;
        return n === DIVIDER ? p.line : n === RESET ? p.reset : this.els[n];
    }

    /** Every entry's place, once the order or the hidden ones change: shown ones one under another, the line above
     * the first after it (where shown entries are on both sides of it, those above it then moving up as the names
     * show), the bottom ones at the bottom; in edit mode every row (the order, the bottom ones, Reset), closer
     * together, over the screen dimmed */
    private place(): void {
        var m = metrics().rail;
        var p = this.editParts;
        if (p) {
            setShown(p.dim, !!this.editing);
            setShown(p.title, !!this.editing);
            setShown(p.hint, !!this.editing);
            setShown(p.line, !!this.editing);
            setShown(p.reset, !!this.editing);
        }
        if (this.editing) {
            this.rows = this.order.concat(this.bottoms, [RESET]);
            for (var r = 0; r < this.rows.length; r++) {
                var row = this.rowEl(this.rows[r]);
                row.style.top = m.editTop + r * m.editStep + 'px';
                setShown(row, true);
            }
            setShown(this.line, false);
            return;
        }
        // More entries shown than fit above the bottom ones: closer together, the last one an entry's height above them
        var count = 0;
        for (var c = 0; c < this.order.length; c++) {
            if (this.order[c] !== DIVIDER && !this.hidden[this.order[c]]) {
                count++;
            }
        }
        var step = m.top + count * m.step <= m.bottom ? m.step : Math.floor((m.bottom - m.top - m.step) / (count - 1));
        var shown: number[] = [];
        var pastLine = false;
        var lineAt = -1;
        for (var i = 0; i < this.order.length; i++) {
            var n = this.order[i];
            if (n === DIVIDER) {
                pastLine = true;
                lineAt = this.hidden[DIVIDER] ? -1 : shown.length;
                continue;
            }
            this.tops[n] = !pastLine;
            setShown(this.els[n], !this.hidden[n]);
            if (!this.hidden[n]) {
                this.els[n].style.top = m.top + shown.length * step + 'px';
                shown.push(n);
            }
        }
        // (no line with nothing shown on one side of it)
        this.lineShown = lineAt > 0 && lineAt < shown.length;
        if (this.lineShown) {
            this.line.style.top = m.top + lineAt * step - step / 4 + 'px';
        }
        setShown(this.line, this.lineShown);
        for (var b = 0; b < this.bottoms.length; b++) {
            var at = this.bottoms[b];
            this.els[at].style.top = m.bottom + 'px';
            setShown(this.els[at], !this.hidden[at]);
            if (!this.hidden[at]) {
                shown.push(at);
            }
        }
        this.shown = shown;
    }

    /** Edit mode's parts: the screen dimmed behind it, its title, the keys' hints, the line's row, Reset's row and an
     * eye on every entry */
    private makeEditParts(): void {
        if (this.editParts) {
            return;
        }
        var self = this;
        var dim = h('div', 'by-rail-dim');
        this.el.insertBefore(dim, this.el.firstChild);
        var title = this.el.appendChild(h('div', 'by-rail-title', tr('Edit sidebar'))) as HTMLElement;
        var hint = this.el.appendChild(h('div', 'by-rail-hint')) as HTMLElement;
        var line = this.el.appendChild(h('div', 'by-rail-item by-rail-item--line')) as HTMLElement;
        line.appendChild(h('div', 'by-rail-rule'));
        line.appendChild(h('div', 'by-rail-label', tr('Divider')));
        var reset = this.el.appendChild(h('div', 'by-rail-item by-rail-item--reset')) as HTMLElement;
        reset.appendChild(icon('history', 'by-rail-icon'));
        reset.appendChild(h('div', 'by-rail-label', tr('Reset to defaults')));
        this.pointTo(line, DIVIDER);
        this.pointTo(reset, RESET);
        var marks: HTMLElement[] = [];
        var mark = function (row: HTMLElement, at: number): HTMLElement {
            var one = row.appendChild(h('div', 'by-rail-mark')) as HTMLElement;
            // (a click on the eye shows or hides its entry)
            takesPointer(one, function () {
                var e = self.editing;
                if (!e || e.before) {
                    return null;
                }
                e.at = self.rows.indexOf(at);
                return { key: KEY.RIGHT };
            });
            return one;
        };
        for (var i = 0; i < this.els.length; i++) {
            marks.push(mark(this.els[i], i));
        }
        marks.push(mark(line, DIVIDER));
        this.editParts = { dim: dim, title: title, hint: hint, line: line, reset: reset, marks: marks };
    }

    /** A key in edit mode (every key is its: Back leaves it) */
    private editKey(code: number): boolean {
        var e = this.editing!;
        var row = this.rows[e.at];
        if (e.before) {
            if (code === KEY.UP && e.at > 0 || code === KEY.DOWN && e.at < this.order.length - 1) {
                this.moveTo(code === KEY.UP ? e.at - 1 : e.at + 1);
            } else if (code === KEY.OK) {
                e.before = null;
            } else if (code === KEY.BACK) {
                var carried = this.order[e.at];
                this.order = e.before;
                e.at = e.before.indexOf(carried);
                e.before = null;
                this.place();
            }
        } else if (code === KEY.UP) {
            e.at = Math.max(0, e.at - 1);
        } else if (code === KEY.DOWN) {
            e.at = Math.min(this.rows.length - 1, e.at + 1);
        } else if (code === KEY.OK) {
            if (row === RESET) {
                var self = this;
                e.confirm(function () { self.reset(); });
            } else if (this.bottoms.indexOf(row) < 0) {
                e.before = this.order.slice();
            }
        } else if ((code === KEY.LEFT || code === KEY.RIGHT) && row !== RESET) {
            // (one entry of the order stays shown; the line and the bottom ones may be hidden whatever else is)
            if (this.hidden[row] || row < 0 || this.bottoms.indexOf(row) >= 0 || this.someShown(row)) {
                this.hidden[row] = !this.hidden[row];
            }
        } else if (code === KEY.BACK) {
            this.finish();
            return true;
        }
        this.mark();
        return true;
    }

    /** The entry carried taken to row to (a step: its row and the one it passes moved, the others left as they are) */
    private moveTo(to: number): void {
        var e = this.editing!;
        var from = e.at;
        this.order.splice(to, 0, this.order.splice(from, 1)[0]);
        e.at = to;
        if (Math.abs(to - from) !== 1) {
            this.place();
            return;
        }
        this.rows.splice(to, 0, this.rows.splice(from, 1)[0]);
        var m = metrics().rail;
        this.rowEl(this.rows[to]).style.top = m.editTop + to * m.editStep + 'px';
        this.rowEl(this.rows[from]).style.top = m.editTop + from * m.editStep + 'px';
    }

    /** Reset to defaults (asked first): the app's order, every entry shown but those that start hidden */
    private reset(): void {
        this.order = this.defaultOrder();
        this.hidden = {};
        this.hideLater([]);
        this.place();
        this.mark();
    }

    /** Back in edit mode: the rail as arranged, the focus on the section shown (else the first entry), done told */
    private finish(): void {
        var e = this.editing!;
        var self = this;
        this.editing = null;
        // (an entry that starts hidden and is still hidden is written in neither: it stays as it comes, hidden; shown, it
        // is in the order stored, which says so)
        var written = function (n: number): boolean { return n < 0 || !self.items[n].later || !self.hidden[n]; };
        var kept = this.order.filter(written);
        var plain = kept.join() === this.defaultOrder().filter(written).join() && this.items.every(function (item, i) { return !item.later || !!self.hidden[i]; });
        var order = plain ? [] : kept.map(function (n) { return self.idOf(n); });
        var hidden = kept.concat(this.bottoms).filter(function (n) { return self.hidden[n]; }).map(function (n) { return self.idOf(n); });
        this.place();
        this.at = this.home();
        this.mark();
        this.fitSoon();
        e.done(order, hidden);
    }

    /** An edit mode row's classes: base, focused (and carried), hidden */
    private rowClass(base: string, n: number): string {
        var e = this.editing!;
        var cls = base;
        if (this.rows[e.at] === n) {
            cls += e.before ? ' by-rail-item--focused by-rail-item--carried' : ' by-rail-item--focused';
        }
        return this.hidden[n] ? cls + ' by-rail-item--hidden' : cls;
    }

    /** Open as if it had the focus (on), or as the focus has it (off): its names in view, nothing focused */
    showOpen(on: boolean): void {
        if (on !== this.shownOpen) {
            this.shownOpen = on;
            this.mark();
        }
    }

    /** Out of sight (on) under a page over the whole screen that lies in the screens' layer, which the rail is above
     * whatever the page's z-index (the screens a layer of their own: app.css .bd-stage), or back: Settings' Live chat
     * settings (main.ts). Its own class alone changes: the rail restyled, not the page */
    cover(on: boolean): void {
        if (on !== this.covered) {
            this.covered = on;
            this.mark();
        }
    }

    private mark(): void {
        var e = this.editing;
        // (covered: its own class, the open or closed one's untouched; no string made at a key otherwise)
        setClass(this.el, this.covered ? 'by-rail by-rail--covered' : this.focused ? (e ? 'by-rail by-rail--open by-rail--edit' : 'by-rail by-rail--open') :
            this.shownOpen ? 'by-rail by-rail--open' : 'by-rail');
        setClass(this.logo, 'by-rail-logo' + (this.logoRound ? ' by-rail-logo--round' : '') + (this.noLogo ? ' by-rail-logo--none' : '') +
            (this.focused && this.at < 0 && !e ? ' by-rail-logo--focused' : ''));
        for (var i = 0; i < this.els.length; i++) {
            setClass(this.els[i], e ? this.rowClass('by-rail-item', i) : 'by-rail-item' + (this.lineShown && this.tops[i] ? ' by-rail-item--top' : '') +
                (i === this.selected ? ' by-rail-item--selected' : '') + (this.focused && i === this.at ? ' by-rail-item--focused' : ''));
        }
        var p = this.editParts;
        if (e && p) {
            setClass(p.line, this.rowClass('by-rail-item by-rail-item--line', DIVIDER));
            setClass(p.reset, this.rowClass('by-rail-item by-rail-item--reset', RESET));
            var carried = e.before ? this.rows[e.at] : RESET;
            for (var j = 0; j < p.marks.length; j++) {
                var n = j < this.els.length ? j : DIVIDER;
                setIcon(p.marks[j], n === carried ? 'reorder' : this.hidden[n] ? 'eyeoff' : 'eye');
            }
            setText(p.hint, e.before ? HINT_CARRY : HINT_FOCUS);
        }
        var open = this.dropIndex >= 0;
        setClass(this.drop, open ? 'bd-menu-drop bd-menu-drop--open by-rail-drop' : 'bd-menu-drop by-rail-drop');
        setShown(this.drop, open);
        for (var k = 0; k < this.dropEls.length; k++) {
            setClass(this.dropEls[k], k === this.dropIndex ? 'bd-menu-drop-item bd-menu-drop-item--focused' : 'bd-menu-drop-item');
        }
    }
}
