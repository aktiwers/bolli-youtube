// Settings › Theme › Text size: one page at the right over the app, as Colours (views/colour-page.ts) and Icons
// (views/icon-page.ts), a tab for each kind of text (ui/text-sizes.ts TEXT_KINDS), All first and Subtitles last, the
// kind's size under them (the keys: below). The page shows the size and the default at once; what
// is behind it shows it after a key of its own, or once the keys rest after several (ui/colours.ts holdRest): Home for
// the tiles' titles and details, the rows' names and All; Settings itself for Settings & menus; the sidebar itself, open
// (its own look and colours: main.ts onRailOpen); for the others a model of the screen in a window over the app, as Icons
// shows all icons (the player's info bar, a channel's header, the watch page and a comment, a subtitle over a picture),
// drawn by the kind's own rules (by-sizes-<kind>-..., in tools/text_sizes.mjs's table), so it changes as the app does.
// The keys: on the tabs the arrows go from kind to kind
// (ui/tab-lines.ts, as Colours' and Icons' tabs); OK, or Down past the last line, takes the focus to the size, where
// Left and Right make it a px smaller or larger (12 to 48 px; All: every kind but the subtitles a px; Subtitles: a step
// of Subtitle size's, in %), OK, Back or Up go back to the tab, Down to Reset under it (the kind to its default, reached
// without passing another kind). At the foot Save and Reset all to defaults (every kind)
// beside it; Up from them to Reset, from Reset to the size; Back on a button back to the tab; a reset leaves the focus
// where it is. Save sets the sizes (each account's own: prefs textSizes, captionSize) and closes the page; Back on the
// tabs (or Settings closing) closes it without them, for a try that is not wanted: the app as it was.
// Speed: built once (the tabs' texts once per opening; a model in the frame after the key that first shows it, while
// the page is open; the tabs' places read once: ui/tab-lines.ts); a key changes the
// value's line and the default's (two texts), or the focus (two classes) and the hint; the sizes go to the app
// (ui/theme.ts tryTextSizes: the kind's rules written anew in its own style element, Home behind spaced anew in place,
// main.ts) in the frame after the next.
// Models are put away by standsBy, as the Icons page's window: a layer moved, nothing drawn anew.
// Styled by themes/<id>.css (by-colours, by-sizes: kept dark on a light page, tools/light_theme.mjs OVER).

import { afterFrame, h, setShown, setText, standsBy, toggleClass } from '../core/dom.js';
import { tr } from '../core/i18n.js';
import { KEY } from '../core/keys.js';
import { holding, takesPointer } from '../core/pointer.js';
import { CAPTION_SIZES, prefs, setPrefs } from '../api/prefs.js';
import { holdRest } from '../ui/colours.js';
import { BELOW, TabLines } from '../ui/tab-lines.js';
import { defaultSize, keptSizes, LARGEST, sameSizes, sizeIn, SMALLEST, TEXT_KINDS, TextSizes } from '../ui/text-sizes.js';
import { applyLookSoon, tryTextSizes } from '../ui/theme.js';

/** The page's tabs: All, each kind of text, Subtitles */
export var TABS = ['all'].concat(TEXT_KINDS).concat(['subtitles']);

/** What shows behind the page for a tab: Home, Settings, the sidebar open, or a model of the screen (its id:
 * by-sizes-<id>) */
function viewOf(tab: string): string {
    return tab === 'all' || tab === 'titles' || tab === 'details' || tab === 'rows' ? 'home' : tab === 'menus' ? 'settings' :
        tab === 'subtitles' ? 'subs' : tab;
}

/** Where the focus is: the tabs, the size (− and +), the buttons */
var ON_TABS = 0;
var ON_SIZE = 1;
var ON_BUTTONS = 2;
/** The buttons, in their order: Reset (under the size), Save and Reset all to defaults (at the foot) */
var RESET = 0;
var SAVE = 1;
var RESET_ALL = 2;

/** The views that are the app itself, no model */
var APP_VIEWS: { [view: string]: boolean } = { home: true, settings: true, sidebar: true };

/** A tab's name and what it covers, in the app's language now */
function says(tab: string): string[] {
    switch (tab) {
        case 'all': return [tr('All'), tr('Every kind of text but the subtitles, a px a press')];
        case 'titles': return [tr('Tile titles'), tr('The titles of the videos on the tiles')];
        case 'details': return [tr('Tile details'), tr('The channel, views and age under a tile')];
        case 'rows': return [tr('Row names'), tr('The names over the rows of tiles')];
        case 'sidebar': return [tr('Sidebar'), tr('The names in the sidebar as it opens')];
        case 'menus': return [tr('Settings & menus'), tr('Settings, the player\'s settings and the side panels')];
        case 'headers': return [tr('Page headers'), tr('A channel\'s name and description, a playlist\'s title')];
        case 'player': return [tr('Player'), tr('The info bar over a video: its title, channel and times')];
        case 'watch': return [tr('Watch page & comments'), tr('Under a video: its title, details, buttons and comments')];
        default: return [tr('Subtitles'), tr('How big subtitles are in Bolli\'s player')];
    }
}

export class TextSizePage {
    el: HTMLElement;
    shown = false;
    private tabEls: HTMLElement[] = [];
    /** Each tab's name and what it covers (says), made as the page opens, in the language then */
    private texts: string[][] = [];
    private tabBox: HTMLElement;
    private covers: HTMLElement;
    private value: HTMLElement;
    private fallback: HTMLElement;
    private sizeRow: HTMLElement;
    private hint: HTMLElement;
    private buttons: HTMLElement[];
    /** The sizes as the page has them (each kind's px: ui/text-sizes.ts keptSizes) and the subtitles' (%), and the
     * ones set when it opened */
    private sizes: TextSizes = {};
    private caption = 100;
    private setSizes: TextSizes = {};
    /** The focus: where (ON_TABS, ON_SIZE, ON_BUTTONS), the tab (TABS' index: the kind shown wherever the focus is),
     * the button */
    private on = ON_TABS;
    private tab = 1;
    private button = 0;
    private focused: HTMLElement | null = null;
    private tabLines = new TabLines();
    /** The models made while the page is open, by view, and the one shown ('' none: Home or Settings behind) */
    private models: { [view: string]: HTMLElement } = {};
    private modelShown = '';
    private subtitle: HTMLElement | null = null;
    private lastAt = 0;
    private restTimer = 0;
    private done: () => void = function () { return undefined; };

    /** railOpen: the sidebar shown open behind the page, or no longer (main.ts onRailOpen) */
    constructor(private parent: HTMLElement, private railOpen: (on: boolean) => void) {
        var self = this;
        this.el = h('div', 'by-colours by-sizes');
        setShown(this.el, false);
        var head = this.el.appendChild(h('div', 'by-colours-head')) as HTMLElement;
        head.appendChild(h('div', 'by-colours-title', tr('Text size')));
        this.tabBox = head.appendChild(h('div', 'by-colours-tabs')) as HTMLElement;
        this.covers = this.el.appendChild(h('div', 'by-sizes-covers')) as HTMLElement;
        this.sizeRow = this.el.appendChild(h('div', 'by-sizes-row')) as HTMLElement;
        var less = this.sizeRow.appendChild(h('div', 'by-sizes-step', '−')) as HTMLElement;
        this.value = this.sizeRow.appendChild(h('div', 'by-sizes-value')) as HTMLElement;
        var more = this.sizeRow.appendChild(h('div', 'by-sizes-step', '+')) as HTMLElement;
        this.fallback = this.el.appendChild(h('div', 'by-sizes-default')) as HTMLElement;
        var reset = this.el.appendChild(h('div', 'by-sizes-buttons')) as HTMLElement;
        var foot = this.el.appendChild(h('div', 'by-sizes-foot')) as HTMLElement;
        this.buttons = [reset.appendChild(h('div', 'by-colours-code', tr('Reset'))) as HTMLElement].concat([tr('Save'), tr('Reset all to defaults')].map(function (name) {
            return foot.appendChild(h('div', 'by-colours-code', name)) as HTMLElement;
        }));
        this.hint = this.el.appendChild(h('div', 'by-sizes-hint')) as HTMLElement;
        parent.appendChild(this.el);
        // A click: a tab shows its kind, − and + change its size (the focus there), a button the focus on it, then OK
        takesPointer(this.el, function (target) {
            var t = holding(self.tabEls.map(function (e) { return { el: e }; }), target);
            var b = holding(self.buttons.map(function (e) { return { el: e }; }), target);
            var by = holding([{ el: less }, { el: more }], target);
            if (t >= 0) {
                self.on = ON_TABS;
                self.toTab(t);
                return { key: 0 };
            }
            if (by >= 0) {
                self.on = ON_SIZE;
                self.change(by ? 1 : -1, 0);
                self.draw();
                return { key: 0 };
            }
            if (b < 0) {
                return null;
            }
            self.on = ON_BUTTONS;
            self.button = b;
            self.draw();
            return {};
        });
    }

    /** Opens it on Tile titles with the sizes as set; done: closed. The tabs' names and the models made anew (in the
     * language now), each model the first time it shows */
    open(done: () => void): void {
        var self = this;
        this.done = done;
        this.shown = true;
        this.setSizes = keptSizes(prefs().textSizes);
        this.sizes = this.setSizes;
        this.caption = prefs().captionSize;
        this.tabBox.innerHTML = '';
        this.texts = TABS.map(says);
        this.tabEls = this.texts.map(function (text) { return self.tabBox.appendChild(h('div', 'by-colours-tab', text[0])) as HTMLElement; });
        this.focused = null;
        this.on = ON_TABS;
        this.tabLines.open(this.tabEls);
        this.toTab(1);
        setShown(this.el, true);
    }

    /** Closed; save: the sizes as the page has them set (one store write, where they changed), else the ones set
     * before stay; the app shows the ones set */
    close(save?: boolean): void {
        if (!this.shown) {
            return;
        }
        this.shown = false;
        clearTimeout(this.restTimer);
        var changes: { [name: string]: unknown } = {};
        if (save && !sameSizes(this.sizes, this.setSizes)) {
            changes.textSizes = this.sizes;
        }
        if (save && this.caption !== prefs().captionSize) {
            changes.captionSize = this.caption;
        }
        if (changes.textSizes || changes.captionSize) {
            setPrefs(changes);
        }
        tryTextSizes(null);
        // (sizes set that were never tried on the app, a Back before the keys rested: drawn now as the ones set)
        if (changes.textSizes) {
            applyLookSoon();
        }
        // (the models let go: made anew in the language then as they show again)
        this.show('home');
        for (var view in this.models) {
            this.parent.removeChild(this.models[view]);
        }
        this.models = {};
        this.subtitle = null;
        setShown(this.el, false);
        this.done();
    }

    layer(): HTMLElement | null {
        return this.shown ? this.el : null;
    }

    onKey(code: number): boolean {
        if (this.on === ON_BUTTONS) {
            this.buttonsKey(code);
            return true;
        }
        if (this.on === ON_SIZE) {
            this.sizeKey(code);
            return true;
        }
        if (code === KEY.BACK) {
            this.close();
        } else if (code === KEY.OK) {
            this.on = ON_SIZE;
            this.draw();
        } else {
            var to = this.tabLines.move(this.tab, code);
            if (to === BELOW) {
                this.on = ON_SIZE;
                this.draw();
            } else if (to !== this.tab) {
                this.toTab(to);
            }
        }
        return true;
    }

    /** A key on the size: Left a step smaller, Right larger; Down to Reset; OK, Back and Up back to the tab */
    private sizeKey(code: number): void {
        if (code === KEY.LEFT || code === KEY.RIGHT) {
            var now = Date.now();
            var rest = holdRest(now - this.lastAt);
            this.lastAt = now;
            this.change(code === KEY.RIGHT ? 1 : -1, rest);
            return;
        }
        if (code === KEY.DOWN) {
            this.on = ON_BUTTONS;
            this.button = RESET;
        } else if (code === KEY.OK || code === KEY.BACK || code === KEY.UP) {
            this.on = ON_TABS;
        } else {
            return;
        }
        this.draw();
    }

    /** A key on the buttons: Down from Reset to Save, Up from the foot to Reset and from Reset to the size, Left and Right
     * between Save and Reset all to defaults; OK presses one (Save: set, closed; a reset: the focus stays); Back back to
     * the tab */
    private buttonsKey(code: number): void {
        var foot = this.button !== RESET;
        if (code === KEY.LEFT || code === KEY.RIGHT) {
            if (foot) {
                this.button = code === KEY.RIGHT ? RESET_ALL : SAVE;
            }
        } else if (code === KEY.DOWN) {
            if (!foot) {
                this.button = SAVE;
            }
        } else if (code === KEY.UP) {
            if (foot) {
                this.button = RESET;
            } else {
                this.on = ON_SIZE;
            }
        } else if (code === KEY.OK && this.button === SAVE) {
            this.close(true);
            return;
        } else if (code === KEY.OK) {
            // (Reset: the kind shown, All's every kind but the subtitles; Reset all to defaults: every kind and the subtitles)
            var tab = TABS[this.tab];
            var all = this.button === RESET_ALL;
            var sizes = keptSizes(this.sizes);
            if (all || tab === 'subtitles') {
                this.caption = 100;
                this.zoom();
            }
            if (all || tab === 'all') {
                sizes = {};
            } else {
                delete sizes[tab];
            }
            this.sizes = sizes;
            this.later(0);
        } else if (code === KEY.BACK) {
            this.on = ON_TABS;
        }
        this.draw();
    }

    /** Tab i shown: its line, its size, what is behind it (a size still to go to the app goes as it would) */
    private toTab(i: number): void {
        this.tab = i;
        this.tabEls.forEach(function (el, n) { toggleClass(el, 'by-colours-tab--on', n === i); });
        this.show(viewOf(TABS[i]));
        this.draw();
    }

    /** The kind shown a step (by: -1 or 1) smaller or larger, on the page at once; on the app after a key of its own,
     * once the keys rest (rest ms) after several */
    private change(by: number, rest: number): void {
        var tab = TABS[this.tab];
        if (tab === 'subtitles') {
            var at = CAPTION_SIZES.indexOf(this.caption);
            this.caption = CAPTION_SIZES[Math.max(0, Math.min(CAPTION_SIZES.length - 1, (at < 0 ? CAPTION_SIZES.indexOf(100) : at) + by))];
            this.zoom();
            this.draw();
            return;
        }
        // (the sizes as kept, made in one pass: one object a press, no copy)
        var sizes: TextSizes = {};
        var moved = false;
        for (var i = 0; i < TEXT_KINDS.length; i++) {
            var kind = TEXT_KINDS[i];
            var px = sizeIn(this.sizes, kind);
            var to = tab === 'all' || tab === kind ? Math.max(SMALLEST, Math.min(LARGEST, px + by)) : px;
            moved = moved || to !== px;
            if (to !== defaultSize(kind)) {
                sizes[kind] = to;
            }
        }
        if (!moved) {
            return;
        }
        this.sizes = sizes;
        this.draw();
        this.later(rest);
    }

    /** The sizes as the page has them shown on the app (those set: none tried), after rest ms */
    private later(rest: number): void {
        var self = this;
        clearTimeout(this.restTimer);
        var go = function (): void {
            if (self.shown) {
                tryTextSizes(sameSizes(self.sizes, self.setSizes) ? null : self.sizes);
            }
        };
        if (rest) {
            this.restTimer = setTimeout(go, rest) as unknown as number;
        } else {
            go();
        }
    }

    /** The tab's line, its size and default, the focus where it is and its hint */
    private draw(): void {
        var tab = TABS[this.tab];
        setText(this.covers, this.texts[this.tab][1]);
        var value: string;
        var fallback: string;
        if (tab === 'subtitles') {
            value = this.caption + ' %';
            fallback = '100 %';
        } else if (tab === 'all') {
            // (how far the kinds are from their defaults, on average: + a px for each press of Right)
            var off = 0;
            for (var i = 0; i < TEXT_KINDS.length; i++) {
                off += sizeIn(this.sizes, TEXT_KINDS[i]) - defaultSize(TEXT_KINDS[i]);
            }
            var mean = Math.round(off / TEXT_KINDS.length);
            value = (mean > 0 ? '+' : mean < 0 ? '−' : '±') + Math.abs(mean) + ' px';
            fallback = '±0 px';
        } else {
            value = sizeIn(this.sizes, tab) + ' px';
            fallback = defaultSize(tab) + ' px';
        }
        setText(this.value, value);
        setText(this.fallback, tr('Default: {1}', fallback));
        setText(this.hint, this.on === ON_SIZE ? tr('Left / Right: size · OK or Back: done') : tr('Arrows: kind of text · OK: size · Back: leave without saving'));
        var to = this.on === ON_BUTTONS ? this.buttons[this.button] : this.on === ON_SIZE ? this.sizeRow : this.tabEls[this.tab];
        if (to !== this.focused) {
            if (this.focused) {
                toggleClass(this.focused, 'by-colours--focused', false);
            }
            toggleClass(to, 'by-colours--focused', true);
            this.focused = to;
        }
    }

    /** What shows behind the page: Home (no model), Settings itself (its own parts in view: by-settings--sizes), the
     * sidebar open (railOpen), or a model, made in the frame after the key that first shows it */
    private show(view: string): void {
        var model = APP_VIEWS[view] ? '' : view;
        toggleClass(this.parent, 'by-settings--sizes', view === 'settings');
        this.railOpen(view === 'sidebar');
        if (model === this.modelShown) {
            return;
        }
        if (this.modelShown && this.models[this.modelShown]) {
            standsBy(this.models[this.modelShown], true);
        }
        this.modelShown = model;
        if (!model) {
            return;
        }
        if (this.models[model]) {
            standsBy(this.models[model], false);
            this.zoom();
            return;
        }
        var self = this;
        afterFrame(function () {
            if (self.shown && self.modelShown === model && !self.models[model]) {
                self.models[model] = self.parent.appendChild(self.model(model)) as HTMLElement;
                self.zoom();
            }
        });
    }

    /** The subtitles' model at the size the page has (as the player draws them: a zoom on their text), written only
     * where it changes */
    private zoom(): void {
        var to = this.caption === 100 ? '' : String(this.caption / 100);
        if (this.subtitle && this.subtitle.style.zoom !== to) {
            this.subtitle.style.zoom = to;
        }
    }

    /** A model of the screen (by-sizes-<view>), its text in its kind's classes (sized by their rules: the kind's, as
     * the app's), its words a video's and a channel's own (Blender's open film) where the app shows YouTube's */
    private model(view: string): HTMLElement {
        var box = h('div', 'by-sizes-model by-sizes-' + view);
        var add = function (parent: HTMLElement, part: string, text?: string): HTMLElement {
            return parent.appendChild(h('div', 'by-sizes-' + view + '-' + part, text)) as HTMLElement;
        };
        if (view === 'player') {
            add(box, 'channel', 'Blender');
            add(box, 'title', 'Big Buck Bunny');
            add(box, 'time', '0:34 / 10:34');
            add(add(box, 'bar'), 'fill');
        } else if (view === 'headers') {
            add(box, 'banner');
            add(box, 'name', 'Blender');
            add(box, 'line', '@BlenderOfficial');
            add(box, 'about', 'Blender is the free and open source 3D creation suite. Welcome to the official channel.');
        } else if (view === 'watch') {
            add(box, 'title', 'Big Buck Bunny');
            add(box, 'meta', 'Blender');
            var pills = add(box, 'pills');
            add(pills, 'pill', tr('Description'));
            add(pills, 'pill', tr('Subscribe'));
            var comments = add(box, 'comments');
            add(comments, 'head', tr('Comments'));
            var comment = add(comments, 'comment');
            add(comment, 'by', '@bunnyfan');
            add(comment, 'text', 'What a lovely film, the squirrels get me every time!');
        } else {
            var line = add(box, 'line');
            this.subtitle = line.appendChild(h('span', 'subtitle-text', 'The quick brown fox jumps over the lazy dog.')) as HTMLElement;
        }
        return box;
    }
}
