// Settings › Theme › Icons: one page at the right over the app, as Colours (views/colour-page.ts), with two tabs, System
// first (the base, the whole app's: the sidebar is as it unless it says otherwise, as Colours' Background then Sidebar). System:
// how every icon in the app is drawn (ui/icons.ts ICON_STYLES), a window over the app showing all of them in the set
// the focus is on (the app behind shows few of them). Sidebar: the menu at the left as the rest of the app, or in a set
// of drawings of its own (ui/rail-icons.ts RAIL_SETS), the sidebar behind showing it. Each set a row, five of its icons
// beside its name; each tab's rows made the first time it shows while the page is open, kept until it opens again (in
// the language then), a tab shown or hidden. The set the focus is on shown on the app (ui/theme.ts tryLook) as soon as
// a key comes on its own, once the keys rest when they come one after another; on the tabs, the one set again; OK sets
// it. The page opens on the tabs, where the arrows go from tab to tab (ui/tab-lines.ts, as Colours' and Text size's);
// OK, or Down below them, goes to the tab's sets (on the one chosen), Up from the first and Back back
// to the tab; Back on the tabs closes the page (what was tried let go).
// The rows scroll where they are more than the page holds (seen on the TV, 2026-11-17: System's last set below the
// screen): each tab's track of rows slides by a transform to keep the focused row in the middle, worked out from the rows'
// fixed height (no layout read at a key; the list's height read once as the page opens); the tabs and the focused set's
// line stay in place.
// Styled by themes/<id>.css (by-icons, kept dark on a light page: tools/light_theme.mjs OVER).

import { h, setShown, setText, standsBy, toggleClass, translate } from '../core/dom.js';
import { tr } from '../core/i18n.js';
import { KEY } from '../core/keys.js';
import { holding, takesPointer } from '../core/pointer.js';
import { holdRest } from '../ui/colours.js';
import { drawIcon, drawRail, iconNames } from '../ui/icons.js';
import { BELOW, TabLines } from '../ui/tab-lines.js';
import { LookPart, lookPart, setLookPart, tryLook } from '../ui/theme.js';

/** A set: its value ('' the first: filled, or the sidebar as the rest), its name, what it is */
export interface IconSet {
    value: string;
    name: string;
    note: string;
}

/** A tab: the part it sets, its sets, the icons shown beside each set's name */
export interface Tab {
    part: LookPart;
    name: string;
    sets: IconSet[];
    samples: string[];
}

/** The tabs, in the app's language now */
export function tabs(): Tab[] {
    return [
        { part: 'icons', name: tr('System'), samples: ['play', 'like', 'comments', 'search', 'settings'], sets: [
            { value: '', name: tr('Filled'), note: tr('solid shapes, as YouTube\'s TV app') },
            { value: 'outline', name: tr('Outline'), note: tr('a thin line round each shape') },
            { value: 'bubble', name: tr('Bubble'), note: tr('each icon inside a soft round badge') },
            { value: 'tiles', name: tr('App tiles'), note: tr('each icon white on a coloured tile, a colour for each kind') },
            { value: 'pixel', name: tr('Pixel'), note: tr('pixel art, as an old game') },
            { value: 'iso', name: '3D', note: tr('each shape with depth: shaded copies behind it') },
            { value: 'glass', name: tr('Glass'), note: tr('each icon on a frosted glass disc') },
            { value: 'soft', name: 'Fruit soft', note: tr('drawings of the app\'s own: rounded lines of one weight, soft corners') },
            { value: 'solid', name: 'Fruit solid', note: tr('the same drawings, filled') },
            { value: 'vhs', name: 'VHS', note: tr('an old video tape\'s picture: scanlines, its colours bleeding apart') }
        ] },
        { part: 'railIcons', name: tr('Sidebar'), samples: ['home', 'subscriptions', 'library', 'music', 'settings'], sets: [
            { value: '', name: tr('Same as System'), note: tr('the sidebar drawn as the rest of the app') },
            { value: 'elements', name: tr('Elements'), note: tr('two letters of each name on a tile, as the periodic table') },
            { value: 'tiles', name: tr('App tiles'), note: tr('a white symbol on each one\'s own colour') },
            { value: 'iso', name: '3D', note: tr('small objects with shaded sides') },
            { value: 'pixel', name: tr('Pixel'), note: tr('pixel art, as an old game\'s menu') },
            { value: 'glass', name: tr('Glass'), note: tr('each icon on a frosted glass disc') },
            { value: 'soft', name: 'Fruit soft', note: tr('drawings of the app\'s own: rounded lines of one weight, soft corners') },
            { value: 'solid', name: 'Fruit solid', note: tr('the same drawings, filled') },
            { value: 'vhs', name: 'VHS', note: tr('an old video tape\'s picture: scanlines, its colours bleeding apart') }
        ] }
    ];
}

/** A row's height and the gap under it (themes/youtube.css by-icons-set), and the room round the rows in their track
 * (by-icons-track: the focus ring's) */
var ROW_STEP = 64;
var ROOM = 6;

/** Where tab t's set chosen is among its sets (one not offered: the first) */
function chosenAt(t: Tab): number {
    var chosen = lookPart(t.part);
    for (var n = 0; n < t.sets.length; n++) {
        if (t.sets[n].value === chosen) {
            return n;
        }
    }
    return 0;
}

/** A tab's rows as drawn while the page is open: their box (shown while the tab is), the track in it that scrolls and
 * how far it is scrolled (px), the rows; the sidebar's "Same as System" samples and the system's style they are drawn
 * in */
interface TabView {
    box: HTMLElement;
    track: HTMLElement;
    scrolled: number;
    rows: HTMLElement[];
    same: HTMLElement[];
    sameIn: string;
}

export class IconPage {
    el: HTMLElement;
    shown = false;
    private tabs: Tab[] = [];
    private tab = 0;
    private tabEls: HTMLElement[] = [];
    private tabLines = new TabLines();
    private tabBox: HTMLElement;
    private list: HTMLElement;
    /** The list's height (px; 0: not read yet since the page opened) */
    private view = 0;
    /** The focused set's line, under the list */
    private note: HTMLElement;
    /** Each tab's rows as drawn (null: not yet since the page opened); the shown tab's rows */
    private views: (TabView | null)[] = [];
    private rows: HTMLElement[] = [];
    /** The window over the app with all the icons (System), its title and its boxes, the icons' names in their order,
     * the set it shows (null: none since the page opened) */
    private all: HTMLElement;
    private allTitle: HTMLElement;
    private cells: HTMLElement[] = [];
    private names: string[];
    private allSet: string | null = null;
    /** The focus: -1 the tabs, else a set's row; the element drawn focused */
    private at = 0;
    private focused: HTMLElement | null = null;
    private lastAt = 0;
    private restTimer = 0;
    private frame = 0;
    private done: () => void = function () { return undefined; };

    constructor(parent: HTMLElement) {
        var self = this;
        this.el = h('div', 'by-colours by-icons');
        setShown(this.el, false);
        var head = this.el.appendChild(h('div', 'by-colours-head')) as HTMLElement;
        head.appendChild(h('div', 'by-colours-title', tr('Icons')));
        this.tabBox = head.appendChild(h('div', 'by-colours-tabs')) as HTMLElement;
        this.list = this.el.appendChild(h('div', 'by-icons-list')) as HTMLElement;
        this.note = this.el.appendChild(h('div', 'by-icons-note')) as HTMLElement;
        this.all = h('div', 'by-icons-all');
        // (the window and each tab's rows put away by standsBy, as the app's screens: a layer moved, nothing drawn anew;
        // hidden, the TV drew each anew whole at every Left/Right, its shadow too. Hidden only while the page is closed,
        // so its layers are let go meanwhile; the window's place set as a tab shows: toTab)
        setShown(this.all, false);
        this.allTitle = this.all.appendChild(h('div', 'by-icons-all-title')) as HTMLElement;
        var grid = this.all.appendChild(h('div', 'by-icons-grid')) as HTMLElement;
        this.names = iconNames();
        for (var n = 0; n < this.names.length; n++) {
            this.cells.push(grid.appendChild(h('div', 'by-icons-cell')) as HTMLElement);
        }
        parent.appendChild(this.all);
        parent.appendChild(this.el);
        // A click: a tab shows its sets; a set: the focus on it, then OK
        takesPointer(this.el, function (target) {
            var t = holding(self.tabEls.map(function (e) { return { el: e }; }), target);
            var r = holding(self.rows.map(function (e) { return { el: e }; }), target);
            if (t >= 0) {
                self.toTab(t);
                self.at = -1;
                self.drawFocus();
                self.later(0);
                return { key: 0 };
            }
            if (r < 0) {
                return null;
            }
            self.at = r;
            self.drawFocus();
            return {};
        });
    }

    /** Opens it on the System tab, the focus on the tabs; done: closed. The rows made anew (in the language now), each
     * tab's the first time it shows */
    open(done: () => void): void {
        var self = this;
        this.done = done;
        this.shown = true;
        this.tabs = tabs();
        this.tabBox.innerHTML = '';
        this.tabEls = this.tabs.map(function (t) { return self.tabBox.appendChild(h('div', 'by-colours-tab', t.name)) as HTMLElement; });
        this.tabLines.open(this.tabEls);
        this.list.innerHTML = '';
        this.views = this.tabs.map(function () { return null; });
        this.focused = null;
        this.allSet = null;
        this.view = 0;
        this.toTab(0);
        this.at = -1;
        this.drawFocus();
        this.drawAll();
        setShown(this.all, true);
        setShown(this.el, true);
        // (the list's height, once: laid out now as the page is anyway, before its first frame; the focused row then
        // brought into sight)
        this.view = this.list.offsetHeight;
        this.scroll();
    }

    close(): void {
        if (!this.shown) {
            return;
        }
        this.shown = false;
        clearTimeout(this.restTimer);
        cancelAnimationFrame(this.frame);
        this.frame = 0;
        this.tabs.forEach(function (t) { tryLook(t.part, null); });
        setShown(this.el, false);
        setShown(this.all, false);
        this.done();
    }

    layer(): HTMLElement | null {
        return this.shown ? this.el : null;
    }

    onKey(code: number): boolean {
        var t = this.tabs[this.tab];
        if (code === KEY.BACK) {
            // (from the sets back to the tab: the one set again on the app; on the tabs, closed)
            if (this.at < 0) {
                this.close();
            } else {
                this.at = -1;
                this.drawFocus();
                this.later(0);
            }
            return true;
        }
        var to = this.at >= 0 ? -2 : code === KEY.OK ? BELOW : this.tabLines.move(this.tab, code);
        if (to === BELOW) {
            // (down to the tab's sets, on the one chosen)
            this.at = chosenAt(t);
            this.drawFocus();
            this.later(0);
            return true;
        }
        if (code === KEY.OK) {
            setLookPart(t.part, t.sets[this.at].value);
            this.drawSet();
            return true;
        }
        if (to >= 0) {
            if (to !== this.tab) {
                this.toTab(to);
                this.at = -1;
                this.drawFocus();
                this.allSoon();
            }
            return true;
        }
        var now = Date.now();
        var rest = holdRest(now - this.lastAt);
        this.lastAt = now;
        if (code === KEY.UP || code === KEY.DOWN) {
            var next = Math.max(-1, Math.min(t.sets.length - 1, this.at + (code === KEY.DOWN ? 1 : -1)));
            if (next !== this.at) {
                this.at = next;
                this.drawFocus();
                this.later(rest);
            }
        }
        return true;
    }

    /** Tab i shown: its rows (made the first time), the focus on the set chosen, the other tab's tried set let go;
     * System's window over the app shown (drawn by the caller) */
    private toTab(i: number): void {
        var was = this.tabs[this.tab];
        var old = this.views[this.tab];
        if (i !== this.tab) {
            if (was) {
                tryLook(was.part, null);
            }
            if (old) {
                standsBy(old.box, true);
            }
        }
        clearTimeout(this.restTimer);
        this.tab = i;
        var t = this.tabs[i];
        this.tabEls.forEach(function (el, n) { toggleClass(el, 'by-colours-tab--on', n === i); });
        var view = this.views[i] || (this.views[i] = this.build(t));
        standsBy(view.box, false);
        // (the sidebar's "Same as System": in the system's style chosen, which may have been set since it was drawn)
        var system = lookPart('icons');
        if (t.part === 'railIcons' && view.sameIn !== system) {
            view.sameIn = system;
            for (var n = 0; n < view.same.length; n++) {
                drawIcon(view.same[n], t.samples[n], system);
            }
        }
        this.rows = view.rows;
        this.at = chosenAt(t);
        this.drawSet();
        this.drawFocus();
        standsBy(this.all, t.part !== 'icons');
    }

    /** Tab t's rows, each with five of its icons in it, and its line under them, in a box of their own. The sidebar's
     * icons drawn from its entries (their place and name: data-rail), each looked up once */
    private build(t: Tab): TabView {
        var box = this.list.appendChild(h('div', 'by-icons-rows')) as HTMLElement;
        var track = box.appendChild(h('div', 'by-icons-track')) as HTMLElement;
        var rail = t.part === 'railIcons';
        var entries: { [name: string]: string } = {};
        if (rail) {
            var drawn = document.querySelectorAll('[data-rail]');
            for (var k = 0; k < drawn.length; k++) {
                entries[drawn[k].getAttribute('data-icon') || ''] = drawn[k].getAttribute('data-rail') || '';
            }
        }
        var system = lookPart('icons');
        var view: TabView = { box: box, track: track, scrolled: 0, rows: [], same: [], sameIn: system };
        view.rows = t.sets.map(function (set) {
            var row = track.appendChild(h('div', 'by-icons-set')) as HTMLElement;
            row.appendChild(h('div', 'by-icons-name', set.name));
            var samples = row.appendChild(h('div', 'by-icons-samples')) as HTMLElement;
            var boxes = t.samples.map(function (name) {
                var sample = samples.appendChild(h('div', 'by-icons-sample')) as HTMLElement;
                if (rail) {
                    drawRail(sample, name, set.value, entries[name] || '1 ' + name, system);
                } else {
                    drawIcon(sample, name, set.value);
                }
                return sample;
            });
            if (rail && !set.value) {
                view.same = boxes;
            }
            return row;
        });
        return view;
    }

    /** The set chosen ticked */
    private drawSet(): void {
        var t = this.tabs[this.tab];
        var chosen = lookPart(t.part);
        this.rows.forEach(function (row, n) { toggleClass(row, 'by-colours--set', t.sets[n].value === chosen); });
    }

    /** The focus drawn where it is, the focused set's line under the list */
    private drawFocus(): void {
        var to = this.at < 0 ? this.tabEls[this.tab] : this.rows[this.at];
        if (to !== this.focused) {
            if (this.focused) {
                toggleClass(this.focused, 'by-colours--focused', false);
            }
            toggleClass(to, 'by-colours--focused', true);
            this.focused = to;
        }
        var set = this.at < 0 ? null : this.tabs[this.tab].sets[this.at];
        setText(this.note, set ? set.note : '');
        this.scroll();
    }

    /** The shown tab's rows scrolled to keep the focused one in the middle of the list, as far as they go (all in sight:
     * none); on the tabs, as they were. A transform of the track alone, only when it changes */
    private scroll(): void {
        var view = this.views[this.tab];
        if (!view || this.at < 0 || !this.view) {
            return;
        }
        var to = Math.round(Math.max(0, Math.min(this.rows.length * ROW_STEP + 2 * ROOM - this.view, (this.at + 0.5) * ROW_STEP + ROOM - this.view / 2)));
        if (to !== view.scrolled) {
            view.scrolled = to;
            translate(view.track, 0, -to);
        }
    }

    /** The focused set shown on the app and in System's window (on the tabs: the one set again): at once after a key of
     * its own, once the keys rest (rest ms: ui/colours.ts holdRest) after one soon after another */
    private later(rest: number): void {
        var self = this;
        clearTimeout(this.restTimer);
        cancelAnimationFrame(this.frame);
        this.frame = 0;
        var go = function (): void {
            if (!self.shown) {
                return;
            }
            var t = self.tabs[self.tab];
            tryLook(t.part, self.at < 0 ? null : t.sets[self.at].value);
            self.allSoon();
        };
        if (rest) {
            this.restTimer = setTimeout(go, rest) as unknown as number;
        } else {
            go();
        }
    }

    /** System's window drawn in the frame after the key, when it is to show another set (drawAll) */
    private allSoon(): void {
        var self = this;
        cancelAnimationFrame(this.frame);
        this.frame = 0;
        var t = this.tabs[this.tab];
        if (t.part === 'icons' && t.sets[this.at >= 0 ? this.at : chosenAt(t)].value !== this.allSet) {
            this.frame = requestAnimationFrame(function () {
                self.frame = 0;
                self.drawAll();
            });
        }
    }

    /** System's window: every icon in the set the focus is on (the one chosen while the focus is on the tabs); nothing
     * done when it shows that one already */
    private drawAll(): void {
        var t = this.tabs[this.tab];
        if (t.part !== 'icons') {
            return;
        }
        var set = t.sets[this.at >= 0 ? this.at : chosenAt(t)];
        if (set.value === this.allSet) {
            return;
        }
        this.allSet = set.value;
        setText(this.allTitle, tr('All icons') + ': ' + set.name);
        for (var n = 0; n < this.cells.length; n++) {
            drawIcon(this.cells[n], this.names[n], set.value);
        }
    }
}
