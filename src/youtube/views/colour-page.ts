// Settings › Theme › Colours (and Branding › Tile colour): one panel at the right over the app, the colour the focus is
// on shown on the app behind it (ui/theme.ts tryLook), OK sets it. Its tabs Background, Sidebar, Highlight, Text (Tile
// colour: none; the logo on the colour at the top instead). Its rows, top to bottom: the named colours and the logo's
// main colours (ui/colours.ts mainColours, measured once per logo after the page shows); the background's or the
// sidebar's style (solid, or a still picture made from the colour: ui/theme.ts styleCss), in the text's place its
// switch "Sidebar too" (the sidebar's names and icons in the text chosen: OK switches it); the colours set lately; the
// colour slider (one degree a press; held, faster and faster, as the progress bar: ui/colours.ts holdStep); the
// slider's colour in 54 shades, a grey column then muted to vivid across, light to dark down; the button that types a
// colour's code. Up to the slider and back keeps the shade, so only the colour shifts.
// Speed: built once; a key moves the focus (two class changes) or the slider's mark (a transform); the shades are
// recoloured in the frame after a press of its own, and only once a held key stops; the app shows the colour in the
// frame after (a press of its own) or once the keys rest (one after another: ui/colours.ts holdRest).
// Styled by themes/<id>.css (by-colours, kept dark on a light page: tools/light_theme.mjs OVER).

import { h, setShown, setText, toggleClass, translate } from '../core/dom.js';
import { tr } from '../core/i18n.js';
import { KEY } from '../core/keys.js';
import { holding, takesPointer } from '../core/pointer.js';
import { autoTextNow, background, inputGrey, isLight, LookPart, lookPart, ownText, setLookPart, SIDEBAR_STYLES, STYLES, styleCss, textOn, tryLook, YOUTUBE_DARK,
    YOUTUBE_LIGHT } from '../ui/theme.js';
import { prefs, setPref } from '../api/prefs.js';
import { holdRest, holdStep, isColour, mainColours, shade, SHADE_L, SHADE_S, shadeOf, typedColour } from '../ui/colours.js';
import { APP_COLOR, homeColor, homeLogoPicture, setHomeColor } from '../ui/home-screen.js';
import { logo } from '../ui/logo.js';
import { TextPage } from '../ui/text-page.js';
import { PROBLEM, toast } from '../ui/toast.js';

/** What the page sets: the look's colours, or the home screen tile's */
export type ColourMode = 'look' | 'tile';

/** A named colour: its value ('' its part's own), its name; same: drawn as "the same as the background" (striped) */
interface Named {
    value: string;
    name: string;
    same?: boolean;
}

/** A colour the page sets: its tab's name; its named colours; the value set; the colour a value shows ('' its own's);
 * setting one; showing one on the app without setting it (null: the one set again) */
interface Part {
    name: string;
    named: () => Named[];
    get: () => string;
    shown: (value: string) => string;
    set: (value: string) => void;
    tryOn: (value: string | null) => void;
    /** Its styles ('' solid first), the one set, setting one, showing one on the app (null: the one set again) */
    styles?: Styles;
    /** A switch in the styles' place (the text's "Sidebar too") */
    toggle?: Toggle;
}

/** A part's switch: its name, whether it is on, switching it (set at once: the app shows it in the frame after the next) */
interface Toggle {
    name: string;
    get: () => boolean;
    set: (on: boolean) => void;
}

interface Styles {
    list: string[];
    get: () => string;
    set: (style: string) => void;
    tryOn: (style: string | null) => void;
}

/** A look part's style (ui/theme.ts STYLES), as set ('' solid) */
function stylesOf(part: LookPart, list: string[]): Styles {
    return {
        list: [''].concat(list),
        get: function () { return lookPart(part); },
        set: function (style) { setLookPart(part, style); },
        tryOn: function (style) { tryLook(part, style); }
    };
}

/** The styles' names */
function styleName(style: string): string {
    return style === 'fade' ? tr('Fade') : style === 'glow' ? tr('Glow') : style === 'blend' ? tr('Blend') : style === 'lines' ? tr('Lines') :
        style === 'dots' ? tr('Dots') : tr('Solid');
}

/** A look part's colour as set ('' its own), and setting it */
function lookPartOf(part: LookPart, name: string, named: () => Named[], own: () => string, styles?: Styles, toggle?: Toggle): Part {
    return {
        name: name,
        named: named,
        styles: styles,
        toggle: toggle,
        get: function () { return part === 'background' ? background() : lookPart(part); },
        shown: function (value) { return value || own(); },
        set: function (value) { setLookPart(part, value); },
        tryOn: function (value) { tryLook(part, value); }
    };
}

/** The inputs' and buttons' own colour: YouTube's grey on its page (dark or light) */
function ownGrey(): string {
    return inputGrey(isLight(background()));
}

/** The look's colours: the background's, the sidebar's, the highlight's, the text's, the inputs', the buttons' */
function colourParts(): Part[] {
    var mine: Named[] = [{ value: YOUTUBE_DARK, name: tr('YouTube dark') }, { value: YOUTUBE_LIGHT, name: tr('YouTube light') }, { value: '#000000', name: tr('Pure black') }];
    // (the text's and the inputs': automatic unless one is chosen)
    var automatic = function (): Named[] {
        return [{ value: '', name: tr('Automatic') }, { value: '#ffffff', name: tr('White') }, { value: '#000000', name: tr('Black') }];
    };
    return [
        lookPartOf('background', tr('Background'), function () { return mine; }, background, stylesOf('backgroundStyle', STYLES)),
        lookPartOf('sidebar', tr('Sidebar'), function () { return [{ value: '', name: tr('Same as background'), same: true } as Named].concat(mine); }, background,
            stylesOf('sidebarStyle', SIDEBAR_STYLES)),
        lookPartOf('highlight', tr('Highlight'), function () {
            return [{ value: '', name: tr('YouTube\'s') }, { value: '#ffffff', name: tr('White') }, { value: '#000000', name: tr('Pure black') }];
        }, function () { return ownText(isLight(background())); }),
        // (the text: automatic unless one is chosen, in case the automatic one is not what one wants; the sidebar's names
        // and icons in it too, if one says so)
        lookPartOf('text', tr('Text'), automatic, autoTextNow, undefined, {
            name: tr('Sidebar too'),
            get: function () { return lookPart('sidebarText') === 'on'; },
            set: function (on) { setLookPart('sidebarText', on ? 'on' : ''); }
        }),
        // (the inputs and the buttons: YouTube's greys unless one is chosen; the buttons as the inputs unless they have
        // their own)
        lookPartOf('inputs', tr('Inputs'), automatic, ownGrey, stylesOf('inputsStyle', SIDEBAR_STYLES)),
        lookPartOf('buttons', tr('Buttons'), function () {
            return [{ value: '', name: tr('Same as inputs'), same: true } as Named, { value: '#ffffff', name: tr('White') }, { value: '#000000', name: tr('Black') }];
        }, function () { return lookPart('inputs') || ownGrey(); }, stylesOf('buttonsStyle', SIDEBAR_STYLES))
    ];
}

function tilePart(preview: (color: string) => void): Part {
    return {
        name: tr('Tile colour'),
        named: function () {
            return [{ value: '', name: tr('The app\'s own') }, { value: '#000000', name: tr('Pure black') }, { value: '#ffffff', name: tr('White') }];
        },
        get: homeColor,
        shown: function (value) { return value || APP_COLOR; },
        set: function (value) { setHomeColor(value); },
        tryOn: function (value) { preview(value === null ? homeColor() || APP_COLOR : value || APP_COLOR); }
    };
}

/** The rows, top to bottom */
var TABS = 0;
var QUICK = 1;
var STYLE = 2;
var RECENT = 3;
var SLIDER = 4;
var SHADES = 5;
var CODE = 6;

/** The colours set lately that are kept */
var RECENT_MAX = 5;
/** The slider's track (layout px): its mark moves along it */
var TRACK_PX = 460;

/** A swatch: its element, the value it sets, its name ('' none: a colour said by its code) */
interface Swatch {
    el: HTMLElement;
    value: string;
    name: string;
}

export class ColourPage {
    el: HTMLElement;
    shown = false;
    private parts: Part[] = [];
    private part = 0;
    private tabs: HTMLElement;
    private tabEls: HTMLElement[] = [];
    private title: HTMLElement;
    private tile: HTMLElement;
    private tileLogo: HTMLImageElement;
    private quickBox: HTMLElement;
    private logoGroup: HTMLElement;
    private logoBox: HTMLElement;
    private recentGroup: HTMLElement;
    private recentBox: HTMLElement;
    private quick: Swatch[] = [];
    private recent: Swatch[] = [];
    private styleGroup: HTMLElement;
    private styleLabel: HTMLElement;
    private styleBox: HTMLElement;
    private styles: Swatch[] = [];
    private track: HTMLElement;
    private mark: HTMLElement;
    private degrees: HTMLElement;
    private boxes: HTMLElement[] = [];
    private code: HTMLElement;
    private nowSwatch: HTMLElement;
    private nowText: HTMLElement;
    /** The element drawn focused */
    private focused: HTMLElement | null = null;
    /** The focus: its row, its place in a row of swatches or tabs, and the shade's column and row (kept while away) */
    private row = SHADES;
    private at = 0;
    private hue = 0;
    private c = 8;
    private r = 3;
    /** The hue the shades are coloured in now (-1: not yet) and the colour ticked among them */
    private drawnHue = -1;
    private drawnSet = '';
    /** The logo's main colours, and the picture they are of */
    private logoColours: string[] = [];
    private logoOf = '';
    /** The last arrow (its time and way) and when a hold of it began: the slider's step, and whether to wait for rest */
    private lastAt = 0;
    private lastWay = 0;
    private heldSince = 0;
    private restTimer = 0;
    private frame = 0;
    /** A tab's colours to draw, in the frame after the tab was chosen (drawn at once if a key comes first) */
    private filling = 0;
    private done: () => void = function () { return undefined; };

    /** parent: Settings' element; typing: its page for typed text (made on first use) */
    constructor(parent: HTMLElement, private typing: () => TextPage) {
        var self = this;
        var el = this.el = h('div', 'by-colours');
        setShown(el, false);
        var head = el.appendChild(h('div', 'by-colours-head')) as HTMLElement;
        this.title = head.appendChild(h('div', 'by-colours-title')) as HTMLElement;
        // (Tile colour: the logo on the colour beside the name; the look's tabs on the line under it)
        this.tile = head.appendChild(h('div', 'by-colours-tile')) as HTMLElement;
        this.tileLogo = this.tile.appendChild(h('img', 'by-colours-tile-logo')) as HTMLImageElement;
        this.tabs = head.appendChild(h('div', 'by-colours-tabs')) as HTMLElement;
        var groups = el.appendChild(h('div', 'by-colours-groups')) as HTMLElement;
        var named = groups.appendChild(h('div', 'by-colours-group')) as HTMLElement;
        named.appendChild(h('div', 'by-colours-label', tr('Colours')));
        this.quickBox = named.appendChild(h('div', 'by-colours-swatches')) as HTMLElement;
        this.logoGroup = groups.appendChild(h('div', 'by-colours-group')) as HTMLElement;
        this.logoGroup.appendChild(h('div', 'by-colours-label', tr('From your logo')));
        this.logoBox = this.logoGroup.appendChild(h('div', 'by-colours-swatches')) as HTMLElement;
        this.styleGroup = el.appendChild(h('div', 'by-colours-group')) as HTMLElement;
        this.styleLabel = this.styleGroup.appendChild(h('div', 'by-colours-label', tr('Style'))) as HTMLElement;
        this.styleBox = this.styleGroup.appendChild(h('div', 'by-colours-styles')) as HTMLElement;
        this.recentGroup = el.appendChild(h('div', 'by-colours-group')) as HTMLElement;
        this.recentGroup.appendChild(h('div', 'by-colours-label', tr('Recent')));
        this.recentBox = this.recentGroup.appendChild(h('div', 'by-colours-swatches')) as HTMLElement;
        var name = el.appendChild(h('div', 'by-colours-slider-name')) as HTMLElement;
        name.appendChild(h('span', '', tr('Colour: hold Left or Right to go faster')));
        this.degrees = name.appendChild(h('span', 'by-colours-degrees')) as HTMLElement;
        this.track = el.appendChild(h('div', 'by-colours-track')) as HTMLElement;
        this.mark = this.track.appendChild(h('div', 'by-colours-mark')) as HTMLElement;
        var grid = el.appendChild(h('div', 'by-colours-shades')) as HTMLElement;
        for (var i = 0; i < SHADE_S.length * SHADE_L.length; i++) {
            this.boxes.push(grid.appendChild(h('div', 'by-colours-shade')) as HTMLElement);
        }
        var foot = el.appendChild(h('div', 'by-colours-foot')) as HTMLElement;
        this.code = foot.appendChild(h('div', 'by-colours-code', tr('Type a colour code'))) as HTMLElement;
        this.nowSwatch = foot.appendChild(h('div', 'by-colours-now')) as HTMLElement;
        this.nowText = foot.appendChild(h('div', 'by-colours-now-text')) as HTMLElement;
        parent.appendChild(el);
        // A click: the focus to what is under the pointer, then OK there (a tab: only the focus)
        takesPointer(el, function (target) {
            var t = holding(self.tabEls.map(function (e) { return { el: e }; }), target);
            var q = holding(self.quick, target);
            var r = holding(self.recent, target);
            var st = holding(self.styles, target);
            var b = holding(self.boxes.map(function (e) { return { el: e }; }), target);
            if (t >= 0) {
                self.row = TABS;
                self.toTab(t);
            } else if (q >= 0) {
                self.row = QUICK;
                self.at = q;
            } else if (r >= 0) {
                self.row = RECENT;
                self.at = r;
            } else if (st >= 0) {
                self.row = STYLE;
                self.at = st;
            } else if (b >= 0) {
                self.row = SHADES;
                self.c = b % SHADE_S.length;
                self.r = Math.floor(b / SHADE_S.length);
            } else if (self.code.contains(target)) {
                self.row = CODE;
            } else {
                return null;
            }
            self.drawFocus();
            return t >= 0 ? { key: 0 } : {};
        });
    }

    /** Opens it on the colours of mode, the focus on the first tab (Background; the tile's colour: on the colour set);
     * done: closed */
    open(mode: ColourMode, done: () => void): void {
        var self = this;
        this.done = done;
        this.shown = true;
        this.parts = mode === 'tile' ? [tilePart(function (color) { self.tile.style.backgroundColor = color; })] : colourParts();
        toggleClass(this.el, 'by-colours--tile', mode === 'tile');
        setText(this.title, mode === 'tile' ? tr('Tile colour') : tr('Colours'));
        this.tabs.innerHTML = '';
        this.tabEls = mode === 'tile' ? [] : this.parts.map(function (p) {
            return self.tabs.appendChild(h('div', 'by-colours-tab', p.name)) as HTMLElement;
        });
        if (mode === 'tile') {
            this.tileLogo.src = homeLogoPicture();
            this.tile.style.backgroundColor = homeColor() || APP_COLOR;
        }
        // (the logo's colours: another picture's are let go before anything is drawn; the new ones read after the first
        // frame, its picture decoded then)
        var picture = mode === 'tile' ? homeLogoPicture() : logo();
        var read = picture !== this.logoOf;
        if (read) {
            this.logoColours = [];
            this.logoOf = picture;
        }
        this.row = SHADES;
        this.toPart(0);
        // (the focus on the first tab, Background: what to colour is chosen first; the tile's one colour: on it)
        if (mode === 'tile') {
            this.toSet();
        } else {
            this.row = TABS;
            this.drawFocus();
        }
        setShown(this.el, true);
        if (read) {
            requestAnimationFrame(function () { self.readLogo(picture); });
        }
    }

    close(): void {
        if (!this.shown) {
            return;
        }
        this.shown = false;
        clearTimeout(this.restTimer);
        cancelAnimationFrame(this.frame);
        cancelAnimationFrame(this.filling);
        this.frame = 0;
        this.filling = 0;
        this.parts.forEach(function (p) {
            p.tryOn(null);
            if (p.styles) {
                p.styles.tryOn(null);
            }
        });
        setShown(this.el, false);
        this.done();
    }

    layer(): HTMLElement | null {
        return this.shown ? this.el : null;
    }

    onKey(code: number): boolean {
        if (code === KEY.BACK) {
            this.close();
            return true;
        }
        var way = code === KEY.LEFT ? -1 : code === KEY.RIGHT ? 1 : code === KEY.UP ? -2 : code === KEY.DOWN ? 2 : 0;
        var now = Date.now();
        // (a key soon after the one before, a held key's repeats from its first on: the app takes the colour once the
        // keys rest, not at each; the same way: the hold goes on)
        var rest = holdRest(now - this.lastAt);
        var fresh = way !== this.lastWay || !rest;
        // (a tab's colours still to draw: drawn now, before the key works on them)
        if (this.filling && !(this.row === TABS && (way === -1 || way === 1))) {
            cancelAnimationFrame(this.filling);
            this.fill();
        }
        if (fresh) {
            this.heldSince = now;
        }
        this.lastAt = now;
        this.lastWay = way;
        if (code === KEY.OK) {
            this.ok();
            return true;
        }
        if (way === -1 || way === 1) {
            if (this.row === SLIDER) {
                this.hue = (this.hue + way * holdStep(fresh ? 0 : now - this.heldSince) + 360) % 360;
                this.drawMark();
                this.later(rest);
                return true;
            }
            if (this.row === TABS) {
                this.toTab(Math.max(0, Math.min(this.parts.length - 1, this.part + way)));
                return true;
            }
            if (this.row === SHADES) {
                this.c = Math.max(0, Math.min(SHADE_S.length - 1, this.c + way));
            } else if (this.row === QUICK || this.row === RECENT || this.row === STYLE) {
                this.at = Math.max(0, Math.min(this.list().length - 1, this.at + way));
            }
        } else if (way) {
            var down = way > 0;
            if (this.row === SHADES && (down ? this.r < SHADE_L.length - 1 : this.r > 0)) {
                this.r += down ? 1 : -1;
            } else {
                var next = this.nextRow(down);
                if (next < 0) {
                    return true;
                }
                this.row = next;
                if (next === QUICK || next === RECENT || next === STYLE) {
                    var p = this.parts[this.part];
                    var i = next === STYLE && !p.styles ? 0 : this.values(next).indexOf(next === STYLE ? p.styles!.get() : p.get());
                    this.at = i >= 0 ? i : 0;
                }
            }
        } else {
            return true;
        }
        this.drawFocus();
        this.later(rest);
        return true;
    }

    /** The row after (down) or before this one that has something in it (-1: none) */
    private nextRow(down: boolean): number {
        var p = this.parts[this.part];
        for (var row = this.row + (down ? 1 : -1); row >= TABS && row <= CODE; row += down ? 1 : -1) {
            if (row === TABS ? this.tabEls.length > 0 : row === RECENT ? this.recent.length > 0 : row === STYLE ? !!(p.styles || p.toggle) : true) {
                return row;
            }
        }
        return -1;
    }

    /** The swatches of the focused row of swatches (the styles' squares too) */
    private list(): Swatch[] {
        return this.row === RECENT ? this.recent : this.row === STYLE ? this.styles : this.quick;
    }

    private values(row: number): string[] {
        return (row === RECENT ? this.recent : row === STYLE ? this.styles : this.quick).map(function (s) { return s.value; });
    }

    /** The focused element */
    private focusEl(): HTMLElement {
        switch (this.row) {
            case TABS: return this.tabEls[this.part];
            case QUICK: return this.quick[this.at] ? this.quick[this.at].el : this.quickBox;
            case RECENT: return this.recent[this.at] ? this.recent[this.at].el : this.recentBox;
            case STYLE: return this.styles[this.at] ? this.styles[this.at].el : this.styleBox;
            case SLIDER: return this.track;
            case SHADES: return this.boxes[this.r * SHADE_S.length + this.c];
            default: return this.code;
        }
    }

    /** The colour the focus is on (null: none: a tab, the code's button) */
    private focusValue(): string | null {
        switch (this.row) {
            case QUICK:
            case RECENT:
                var s = this.list()[this.at];
                return s ? s.value : null;
            case SLIDER:
            case SHADES:
                return shade(this.hue, this.c, this.r);
            default:
                return null;
        }
    }

    /** The focus drawn where it is now (its ring moved from the one drawn before), and what it is on said at the foot */
    private drawFocus(): void {
        var to = this.focusEl();
        if (to !== this.focused) {
            if (this.focused) {
                toggleClass(this.focused, 'by-colours--focused', false);
            }
            toggleClass(to, 'by-colours--focused', true);
            this.focused = to;
        }
        this.drawNow();
    }

    /** The focus on the colour set: its swatch (a named, the logo's or a recent one), else its shade */
    private toSet(): void {
        var set = this.parts[this.part].get();
        var q = this.values(QUICK).indexOf(set);
        var r = this.values(RECENT).indexOf(set);
        this.row = q >= 0 ? QUICK : r >= 0 ? RECENT : SHADES;
        this.at = q >= 0 ? q : r >= 0 ? r : 0;
        this.drawFocus();
    }

    /** The foot: the colour the focus is on (else the one set), its name or code */
    private drawNow(): void {
        var p = this.parts[this.part];
        if (this.row === STYLE && p.styles) {
            var style = this.styles[this.at] ? this.styles[this.at].value : '';
            this.nowSwatch.style.background = styleCss(style, p.shown(p.get()), 0.3);
            setText(this.nowText, styleName(style) + (style === p.styles.get() ? '  ✓' : ''));
            return;
        }
        var value = this.focusValue();
        var set = p.get();
        var shownValue = value === null ? set : value;
        this.nowSwatch.style.background = p.shown(shownValue);
        var name = '';
        for (var i = 0; i < this.quick.length && !name; i++) {
            if (this.quick[i].value === shownValue) {
                name = this.quick[i].name;
            }
        }
        setText(this.nowText, (name || shownValue.toUpperCase()) + (shownValue === set ? '  ✓' : ''));
    }

    /** The shades recoloured and the app given the focused colour: after a key of its own the app at once (ui/theme.ts
     * draws it in the frame after the next) and the shades in the next frame; after keys soon after one another, both
     * once the keys rest (rest ms: ui/colours.ts holdRest) */
    private later(rest: number): void {
        var self = this;
        clearTimeout(this.restTimer);
        cancelAnimationFrame(this.frame);
        this.frame = 0;
        if (rest) {
            this.restTimer = setTimeout(function () {
                if (self.shown) {
                    self.drawShades();
                    self.tryFocused();
                }
            }, rest) as unknown as number;
            return;
        }
        this.tryFocused();
        this.frame = requestAnimationFrame(function () {
            self.frame = 0;
            if (self.shown) {
                self.drawShades();
            }
        });
    }

    /** The app shown in the colour the focus is on (on the styles: the colour set, in the style the focus is on;
     * elsewhere the style set) */
    private tryFocused(): void {
        var p = this.parts[this.part];
        p.tryOn(this.focusValue());
        if (p.styles) {
            p.styles.tryOn(this.row === STYLE && this.styles[this.at] ? this.styles[this.at].value : null);
        }
    }

    /** OK: a tab's colours; a colour set (and kept among the recent ones); the slider: down to its shades; the code's
     * button: its page */
    private ok(): void {
        var self = this;
        if (this.row === SLIDER) {
            this.row = SHADES;
            this.drawFocus();
            return;
        }
        if (this.row === CODE) {
            this.typing().open(tr('Colour code'), '#', false, function (text) {
                var color = typedColour(text);
                if (!color) {
                    toast(tr('That is no colour code: # and six letters or digits, like #e62117'), undefined, PROBLEM);
                    return;
                }
                // (the slider and the shades at it, and the focus on it among the recent colours, ticked)
                var at = shadeOf(color, self.hue);
                self.hue = at.h;
                self.c = at.c;
                self.r = at.r;
                self.choose(color);
                self.drawMark();
                self.toSet();
            });
            return;
        }
        var p = this.parts[this.part];
        if (this.row === STYLE && p.toggle) {
            p.toggle.set(!p.toggle.get());
            this.drawStyles();
            return;
        }
        if (this.row === STYLE && p.styles && this.styles[this.at]) {
            p.styles.set(this.styles[this.at].value);
            this.drawStyles();
            return;
        }
        var value = this.focusValue();
        if (value !== null) {
            this.choose(value);
            this.drawFocus();
        }
    }

    /** Sets value, kept among the recent colours (a named one that is its part's own is not) */
    private choose(value: string): void {
        var p = this.parts[this.part];
        p.set(value);
        if (isColour(value)) {
            var list = [value].concat(prefs().colourRecent.filter(function (one) { return one !== value && isColour(one); })).slice(0, RECENT_MAX);
            setPref('colourRecent', list);
        }
        // (on a recent one: the focus on it where it is now, first)
        if (this.row === RECENT) {
            this.at = 0;
        }
        this.drawSwatches();
        this.drawStyles();
        this.drawShades();
    }

    /** Tab i chosen (by a key or a click): the tab and the focus at once, its colours in the frame after (fill), the
     * app back to what is set */
    private toTab(i: number): void {
        var self = this;
        if (i !== this.part) {
            this.markTab(i);
            this.drawFocus();
            cancelAnimationFrame(this.filling);
            this.filling = requestAnimationFrame(function () { self.fill(); });
        }
        this.later(0);
    }

    /** Part i's tab marked as the one shown */
    private markTab(i: number): void {
        this.part = i;
        this.tabEls.forEach(function (el, n) {
            toggleClass(el, 'by-colours-tab--on', n === i);
        });
    }

    /** Shows part i's colours at once (the page opening) */
    private toPart(i: number): void {
        this.markTab(i);
        this.fill();
    }

    /** The shown part's colours: its named ones, the set one ticked, the slider and the shades at the colour set; the
     * other parts' tried colours let go */
    private fill(): void {
        this.filling = 0;
        var i = this.part;
        var self = this;
        var set = this.parts[i].get();
        var at = shadeOf(this.parts[i].shown(set), this.hue);
        this.hue = at.h;
        this.c = at.c;
        this.r = at.r;
        this.drawSwatches();
        this.drawStyles();
        this.drawMark();
        this.drawShades();
        // (the foot anew: drawn with the focus, before this part's named colours were here to name the one set)
        this.drawNow();
        // (another tab: the app shows what is set)
        this.parts.forEach(function (p, n) {
            if (n !== self.part) {
                p.tryOn(null);
                if (p.styles) {
                    p.styles.tryOn(null);
                }
            }
        });
    }

    /** The rows of swatches anew: the named colours with the logo's, the recent ones; each ticked when set */
    private drawSwatches(): void {
        var p = this.parts[this.part];
        var set = p.get();
        var self = this;
        var swatch = function (box: HTMLElement, value: string, same: boolean, name: string): Swatch {
            var el = box.appendChild(h('div', 'by-colours-swatch' + (same ? ' by-colours-swatch--same' : '') + (value === set ? ' by-colours--set' : ''))) as HTMLElement;
            var color = p.shown(value);
            el.style.backgroundColor = color;
            el.style.color = textOn(color);
            return { el: el, value: value, name: name };
        };
        this.quickBox.innerHTML = '';
        this.logoBox.innerHTML = '';
        this.recentBox.innerHTML = '';
        this.quick = p.named().map(function (n) {
            // (the sidebar's "Same as background": its own look, striped)
            return swatch(self.quickBox, n.value, !!n.same, n.name);
        }).concat(this.logoColours.map(function (color) { return swatch(self.logoBox, color, false, ''); }));
        setShown(this.logoGroup, this.logoColours.length > 0);
        this.recent = prefs().colourRecent.filter(isColour).slice(0, RECENT_MAX).map(function (color) { return swatch(self.recentBox, color, false, ''); });
        setShown(this.recentGroup, this.recent.length > 0);
        if (this.row === RECENT && !this.recent.length) {
            this.row = QUICK;
        }
        if (this.row === QUICK || this.row === RECENT) {
            this.at = Math.max(0, Math.min(this.at, this.list().length - 1));
            // (its swatches made anew: the focus drawn on the new one)
            this.focused = null;
            this.drawFocus();
        }
    }

    /** The styles' squares anew (none for a part without styles), each in the colour set, the set one ticked; in their
     * place a part's switch, ticked while on */
    private drawStyles(): void {
        var p = this.parts[this.part];
        var self = this;
        this.styleBox.innerHTML = '';
        setShown(this.styleGroup, !!(p.styles || p.toggle));
        // (the switch says what it is: its row's name blank, its line kept)
        setText(this.styleLabel, p.toggle ? '\u00a0' : tr('Style'));
        if (p.toggle) {
            var on = this.styleBox.appendChild(h('div', 'by-colours-code by-colours-toggle' + (p.toggle.get() ? ' by-colours-toggle--on' : ''),
                p.toggle.name)) as HTMLElement;
            this.styles = [{ el: on, value: '', name: p.toggle.name }];
        } else if (p.styles) {
            var color = p.shown(p.get());
            var set = p.styles.get();
            this.styles = p.styles.list.map(function (style) {
                var el = self.styleBox.appendChild(h('div', 'by-colours-style')) as HTMLElement;
                // (the set one ticked on its square, in the colour that reads on it)
                var square = el.appendChild(h('div', 'by-colours-style-square' + (style === set ? ' by-colours--set' : ''))) as HTMLElement;
                square.style.background = styleCss(style, color, 0.4);
                square.style.color = textOn(color);
                el.appendChild(h('div', 'by-colours-style-name', styleName(style)));
                return { el: el, value: style, name: styleName(style) };
            });
        } else {
            this.styles = [];
            if (this.row === STYLE) {
                this.row = QUICK;
            }
            return;
        }
        if (this.row === STYLE) {
            this.at = Math.max(0, Math.min(this.at, this.styles.length - 1));
            this.focused = null;
            this.drawFocus();
        }
    }

    /** The slider's mark at the hue (a transform), in its colour */
    private drawMark(): void {
        // (a layer of its own: the rainbow under it is not drawn again)
        translate(this.mark, Math.round(this.hue / 359 * TRACK_PX), 0);
        this.mark.style.backgroundColor = shade(this.hue, SHADE_S.length - 1, 3);
        setText(this.degrees, this.hue + '°');
        if (this.row === SLIDER) {
            this.drawNow();
        }
    }

    /** The shades in the slider's hue (only when it or the colour set changed), the set one ticked */
    private drawShades(): void {
        var set = this.parts[this.part].get();
        if (this.hue === this.drawnHue && set === this.drawnSet) {
            return;
        }
        this.drawnHue = this.hue;
        this.drawnSet = set;
        for (var r = 0; r < SHADE_L.length; r++) {
            for (var c = 0; c < SHADE_S.length; c++) {
                var el = this.boxes[r * SHADE_S.length + c];
                var color = shade(this.hue, c, r);
                el.style.backgroundColor = color;
                var isSet = color === set;
                toggleClass(el, 'by-colours--set', isSet);
                // (the tick in the colour that reads on it)
                if (isSet) {
                    el.style.color = textOn(color);
                }
            }
        }
    }

    /** The logo's main colours read from its picture (a 32 x 32 copy) and shown; a picture that cannot be read: none */
    private readLogo(picture: string): void {
        var self = this;
        if (!picture) {
            return;
        }
        var img = new Image();
        img.onload = function () {
            if (self.logoOf !== picture) {
                return;
            }
            try {
                var canvas = document.createElement('canvas');
                canvas.width = canvas.height = 32;
                var ctx = canvas.getContext('2d')!;
                ctx.drawImage(img, 0, 0, 32, 32);
                self.logoColours = mainColours(ctx.getImageData(0, 0, 32, 32).data);
            } catch (e) {
                self.logoColours = [];
            }
            if (self.shown && self.logoColours.length) {
                self.drawSwatches();
            }
        };
        img.src = picture;
    }
}
