// Live chat settings: the chat's settings on one page (Settings › Live chat, and the player's settings while a live
// stream plays), see-through and on the side away from the chat, so each change shows behind it at once. Up/Down pick
// a setting (those for where the chat is: over the picture or beside it, its position for that, its height at a side,
// its style as a strip, Move and resize for a box of its own), Left/Right change it in place (OK: the next value, round), Back
// closes. Choosing Custom takes the focus to Move and resize, which OK starts: the arrows move the chat, OK turns them
// to resizing it (Left/Right its width, Up/Down its height, the bottom staying), OK again keeps it; Back puts it back.
// Over a stream it is the stream's chat that changes; over Settings an example: a picture (narrower beside the chat, as
// the video) and example messages made here, their authors' pictures drawn here too (nothing asked of YouTube). Styled
// by themes/<id>.css (by-chatset).

import { h, LAYOUT_HEIGHT, LAYOUT_WIDTH, setShown, setText, toggleClass } from '../core/dom.js';
import { tr } from '../core/i18n.js';
import { KEY, KEYS_GAP } from '../core/keys.js';
import { holding, takesPointer } from '../core/pointer.js';
import { ChatMessage } from '../api/live-chat.js';
import { ChatBox, Prefs, prefs, setPref } from '../api/prefs.js';
import { ChatView, FIRST_BOX } from './chat-view.js';

/** A setting on the page: its pref and its values in order, each with its name (none: Move and resize); shown: whether
 * it applies to the chat as set (none: always); extra: an on/off one Settings' note names only when on */
interface ChatSetting {
    label: string;
    name: 'liveChat' | 'chatMode' | 'chatPosition' | 'chatHeight' | 'chatBottom' | 'chatSide' | 'chatPicture' | 'chatSize' | 'chatBackground' | 'chatTimes' |
        'chatAvatars' | 'chatFade' | '';
    values: { value: boolean | string | number; name: string }[];
    shown?: (p: Prefs) => boolean;
    extra?: boolean;
}

/** An example message comes this often (ms; the first ones at once) */
var EXAMPLE_MS = 2500;
var EXAMPLES_FIRST = 4;
/** Move and resize: a press moves or resizes by this much (layout units); the box stays this far inside the screen,
 * and at least, at most this big */
var STEP = 20;
/** Move and resize shines this long as Custom is chosen (two sweeps: themes, by-chatset-row--shine) */
var SHINE_MS = 2400;
var EDGE = 20;
var LEAST = { w: 240, h: 100 };
var MOST = { w: LAYOUT_WIDTH - 2 * EDGE, h: LAYOUT_HEIGHT - 2 * EDGE };

/** Over the picture or beside it; over it at a side (a height), in a box of its own (Move and resize); a strip, over
 * the picture at the bottom or beside it at the bottom or top (the bottom styles) */
var beside = function (p: Prefs): boolean { return p.chatMode === 'beside'; };
var over = function (p: Prefs): boolean { return !beside(p); };
var atSide = function (p: Prefs): boolean { return over(p) && ['bottom', 'custom'].indexOf(p.chatPosition) < 0; };
var ownBox = function (p: Prefs): boolean { return over(p) && p.chatPosition === 'custom'; };
var asStrip = function (p: Prefs): boolean { return beside(p) ? p.chatSide === 'bottom' || p.chatSide === 'top' : p.chatPosition === 'bottom'; };
/** The example authors' pictures: a circle of this colour each, with the name's first letter */
var EXAMPLE_COLOURS = ['#5e35b1', '#00897b', '#e65100', '#3949ab', '#c2185b'];

/** The page's settings in order */
function chatSettings(): ChatSetting[] {
    return [
        { label: tr('Live chat'), name: 'liveChat', values: [{ value: true, name: tr('On') }, { value: false, name: tr('Off') }] },
        { label: tr('Mode'), name: 'chatMode', values: [{ value: 'over', name: tr('Over the picture') }, { value: 'beside', name: tr('Beside the picture') }] },
        { label: tr('Position'), name: 'chatPosition', values: [{ value: 'right', name: tr('Right') }, { value: 'left', name: tr('Left') },
            { value: 'bottom', name: tr('Bottom') }, { value: 'custom', name: tr('Custom') }], shown: over },
        { label: tr('Position'), name: 'chatSide', values: [{ value: 'right', name: tr('Right') }, { value: 'left', name: tr('Left') },
            { value: 'bottom', name: tr('Bottom') }, { value: 'top', name: tr('Top') }], shown: beside },
        { label: tr('Height'), name: 'chatHeight', values: [{ value: 'full', name: tr('Full') }, { value: 'tall', name: tr('Tall') },
            { value: 'half', name: tr('Half') }], shown: atSide },
        { label: tr('Bottom style'), name: 'chatBottom', values: [{ value: 'ticker', name: tr('Ticker') }, { value: 'band', name: tr('Band') },
            { value: 'one', name: tr('One at a time') }], shown: asStrip },
        { label: tr('Picture'), name: 'chatPicture', values: [{ value: 'fit', name: tr('Fit') }, { value: 'fill', name: tr('Fill') }],
            shown: function (p) { return beside(p) && asStrip(p) && p.chatBottom !== 'band'; } },
        { label: tr('Move and resize'), name: '', values: [], shown: ownBox },
        { label: tr('Size'), name: 'chatSize', values: [{ value: 'tiny', name: tr('Very small') }, { value: 'small', name: tr('Small') },
            { value: 'normal', name: tr('Medium') }, { value: 'large', name: tr('Large') }] },
        { label: tr('Background'), name: 'chatBackground', values: [{ value: 'bubbles', name: tr('Bubbles') }, { value: 'panel', name: tr('One panel') },
            { value: 'none', name: tr('Text only') }] },
        { label: tr('Timestamps'), name: 'chatTimes', values: [{ value: false, name: tr('Off') }, { value: true, name: tr('On') }], extra: true },
        { label: tr('Avatars'), name: 'chatAvatars', values: [{ value: false, name: tr('Off') }, { value: true, name: tr('On') }], extra: true },
        { label: tr('Old messages'), name: 'chatFade', values: [{ value: 0, name: tr('Stay') }, { value: 15, name: tr('Fade after {1} s', 15) },
            { value: 30, name: tr('Fade after {1} s', 30) }, { value: 60, name: tr('Fade after {1} min', 1) }] }
    ];
}

/** Where a setting's value is among its values (one not among them: the first) */
function valueAt(s: ChatSetting): number {
    var now = s.name ? prefs()[s.name] as unknown : null;
    for (var i = 0; i < s.values.length; i++) {
        if (s.values[i].value === now) {
            return i;
        }
    }
    return 0;
}

/** Whether a setting applies to the chat as set */
function applies(s: ChatSetting): boolean {
    return !s.shown || s.shown(prefs());
}

/** The settings' values in a line ("On · Right · Tall · Medium · Bubbles · Timestamps · Stay": Settings' note under Live
 * chat; an on/off extra by its name when on) */
export function chatSummary(): string {
    return chatSettings().filter(function (s) { return s.values.length && applies(s) && (!s.extra || prefs()[s.name as 'chatTimes']); }).map(function (s) {
        return s.extra ? s.label : s.values[valueAt(s)].name;
    }).join(' · ');
}

/** The example messages (made up; their texts in the app's language; their authors' pictures drawn; the time they are
 * shown set then) */
function examples(): ChatMessage[] {
    var say = function (author: string, text: string, amount?: string): ChatMessage {
        return { id: '', author: author, parts: [{ text: text, emoji: '' }], amount: amount || '', at: 0, avatar: drawnAvatar(author) };
    };
    return [say('Mia', tr('Hello from the sofa!')), say('Jonas', tr('The picture is so clear tonight')), say('aurora_fan', tr('What time is it there?')),
        say('Lea', tr('First time catching this live')), say('Sam', tr('Thanks for streaming!'), '$5.00')];
}

/** An example author's picture: a coloured circle with the name's first letter (an SVG in the page: nothing loaded) */
function drawnAvatar(author: string): string {
    var colour = EXAMPLE_COLOURS[author.length % EXAMPLE_COLOURS.length];
    return 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="32" fill="' +
        colour + '"/><text x="32" y="43" font-family="Roboto, Arial, sans-serif" font-size="30" font-weight="500" fill="#fff" text-anchor="middle">' +
        author.charAt(0).toUpperCase() + '</text></svg>');
}

export class ChatSettings {
    el: HTMLElement;
    shown = false;
    private panel: HTMLElement;
    /** Move and resize's keys line (in its box) */
    private hint: HTMLElement;
    private hintText: HTMLElement;
    private settings: ChatSetting[];
    private rows: { el: HTMLElement; name: HTMLElement; less: HTMLElement; more: HTMLElement }[] = [];
    private at = 0;
    /** The chat that shows the changes (over Settings: the example's, in its scene), the example messages, the next one
     * and its timer */
    private chat: ChatView;
    private scene: HTMLElement | null = null;
    private examples: ChatMessage[] = [];
    private sent = 0;
    private exampleTimer = 0;
    /** Move and resize: what the arrows do now ('' not moving it), and the box as moved so far (kept on OK; Back: as
     * Settings still have it) */
    private arranging: '' | 'move' | 'resize' = '';
    private box: ChatBox = FIRST_BOX;
    /** The row shining, and the timer ending it */
    private shining: HTMLElement | null = null;
    private shineTimer = 0;

    /** In parent: the player with its chat, or (no chat) Settings' page, with a picture and example messages behind it;
     * changed: called after each change, its pref set and the chat laid out anew */
    constructor(parent: HTMLElement, chat?: ChatView, private changed?: () => void) {
        var self = this;
        this.settings = chatSettings();
        this.el = h('div', 'by-chatset');
        if (chat) {
            this.chat = chat;
        } else {
            var scene = this.scene = this.el.appendChild(h('div', 'by-chatset-scene')) as HTMLElement;
            this.chat = new ChatView(scene, undefined, [scene.appendChild(h('div', 'by-chatset-picture')) as HTMLElement]);
            scene.appendChild(h('div', 'by-chatset-note', tr('Example messages')));
            this.examples = examples();
        }
        this.panel = this.el.appendChild(h('div', 'by-chatset-panel')) as HTMLElement;
        this.panel.appendChild(h('div', 'by-chatset-title', tr('Live chat settings')));
        this.settings.forEach(function (s) {
            var el = self.panel.appendChild(h('div', 'by-chatset-row')) as HTMLElement;
            el.appendChild(h('span', 'by-chatset-label', s.label));
            var value = el.appendChild(h('span', 'by-chatset-value')) as HTMLElement;
            var less = value.appendChild(h('span', 'by-chatset-arrow', '‹')) as HTMLElement;
            var name = value.appendChild(h('span', 'by-chatset-name')) as HTMLElement;
            var more = value.appendChild(h('span', 'by-chatset-arrow', '›')) as HTMLElement;
            self.rows.push({ el: el, name: name, less: less, more: more });
        });
        this.panel.appendChild(h('div', 'by-chatset-keys', [tr('Up / Down choose'), tr('Left / Right change'), tr('Back close')].join(KEYS_GAP)));
        this.hint = this.el.appendChild(h('div', 'by-chatset-hint')) as HTMLElement;
        this.hintText = this.hint.appendChild(h('span', 'by-chatset-hint-text')) as HTMLElement;
        setShown(this.el, false);
        parent.appendChild(this.el);
        // A click on an arrow steps that way; on a setting it is OK there (its next value; Move and resize starts)
        takesPointer(this.panel, function (target) {
            var r = holding(self.rows, target);
            if (r < 0) {
                return null;
            }
            var row = self.rows[r];
            self.at = r;
            if (row.less.contains(target) || row.more.contains(target)) {
                self.step(row.less.contains(target) ? -1 : 1, false);
                return { key: 0 };
            }
            self.draw();
            return {};
        });
    }

    /** Shows the page at its first setting (over Settings: the example messages start) */
    open(): void {
        this.shown = true;
        this.at = 0;
        this.arranging = '';
        this.draw();
        setShown(this.el, true);
        if (this.scene) {
            for (var i = 0; i < EXAMPLES_FIRST; i++) {
                this.sendExample();
            }
        }
    }

    close(): void {
        if (!this.shown) {
            return;
        }
        if (this.arranging) {
            this.endArrange(false);
        }
        this.shine(null);
        this.shown = false;
        setShown(this.el, false);
        if (this.scene) {
            clearTimeout(this.exampleTimer);
            this.chat.stop();
        }
    }

    /** The page while open (null: closed): the pointer's layer, a click beside it is Back (core/pointer.ts) */
    layer(): HTMLElement | null {
        return this.shown ? this.arranging ? this.hintText : this.panel : null;
    }

    onKey(code: number): boolean {
        if (this.arranging) {
            this.arrangeKey(code);
            return true;
        }
        switch (code) {
            case KEY.UP:
            case KEY.DOWN:
                this.at = this.next(code === KEY.UP ? -1 : 1);
                this.draw();
                break;
            case KEY.LEFT:
            case KEY.RIGHT:
                this.step(code === KEY.LEFT ? -1 : 1, false);
                break;
            case KEY.OK:
                this.step(1, true);
                break;
            case KEY.BACK:
                this.close();
                break;
        }
        return true;
    }

    /** The setting by from the focused one that applies (stopping at the ends) */
    private next(by: number): number {
        for (var i = this.at + by; i >= 0 && i < this.settings.length; i += by) {
            if (applies(this.settings[i])) {
                return i;
            }
        }
        return this.at;
    }

    /** The focused setting's value moved by one, stopping at its ends (round: after the last comes the first); Move and
     * resize: OK starts it (not Right, which may still be pressed from choosing Custom) */
    private step(by: number, round: boolean): void {
        var s = this.settings[this.at];
        if (!s.name) {
            if (round) {
                this.startArrange();
            }
            return;
        }
        var count = s.values.length;
        var to = valueAt(s) + by;
        to = round ? (to + count) % count : Math.max(0, Math.min(count - 1, to));
        var value = s.values[to].value;
        if (value !== prefs()[s.name]) {
            // A box of its own starts where the chat is now (along the bottom, or not showing: today's place)
            if (value === 'custom' && !prefs().chatBox) {
                setPref('chatBox', !asStrip(prefs()) && this.chat.rect() || FIRST_BOX);
            }
            setPref(s.name, value as never);
            this.apply();
            // Custom: on to Move and resize (the next setting), which shines a moment, so OK starts it
            if (value === 'custom') {
                this.at = this.next(1);
                this.shine(this.rows[this.at].el);
            }
        }
        this.draw();
    }

    /** The chat laid out as now set; changed told */
    private apply(): void {
        this.chat.layout();
        if (this.changed) {
            this.changed();
        }
    }

    /** The values, the settings that apply (the focused one; its arrows dimmed at an end), the page on the side away
     * from the chat; moving it: the hint instead; over Settings, the example shown as Live chat is set */
    private draw(): void {
        var self = this;
        var p = prefs();
        if (!applies(this.settings[this.at])) {
            this.at = this.next(-1);
        }
        this.settings.forEach(function (s, i) {
            var row = self.rows[i];
            var at = valueAt(s);
            toggleClass(row.el, 'by-chatset-row--hidden', !applies(s));
            toggleClass(row.el, 'by-chatset-row--action', !s.name);
            setText(row.name, s.name ? s.values[at].name : tr('Press OK'));
            toggleClass(row.el, 'by-chatset-row--focused', i === self.at);
            toggleClass(row.less, 'by-chatset-arrow--end', !s.name || at === 0);
            toggleClass(row.more, 'by-chatset-arrow--end', !!s.name && at === s.values.length - 1);
        });
        var box = this.arranging ? this.box : ownBox(p) ? p.chatBox : null;
        toggleClass(this.el, 'by-chatset--right', (beside(p) ? p.chatSide : p.chatPosition) === 'left' ||
            !!box && box.x + box.w / 2 < LAYOUT_WIDTH / 2);
        // (a strip at the top: the page at the bottom instead)
        toggleClass(this.el, 'by-chatset--low', beside(p) && p.chatSide === 'top');
        if (this.scene && this.shown) {
            this.chat.showExample(p.liveChat);
        }
        toggleClass(this.el, 'by-chatset--arranging', !!this.arranging);
        if (this.arranging && box) {
            setText(this.hintText, this.arranging === 'move' ? [tr('Move the chat'), tr('Arrows move'), tr('OK resize'), tr('Back cancel')].join(KEYS_GAP) :
                [tr('Resize the chat') + ' ' + box.w + ' × ' + box.h, tr('Left / Right width'), tr('Up / Down height'), tr('OK done'), tr('Back cancel')].join(KEYS_GAP));
        }
    }

    /** row shines for SHINE_MS (from the start again if it already does; null: none) */
    private shine(row: HTMLElement | null): void {
        var self = this;
        clearTimeout(this.shineTimer);
        if (this.shining) {
            toggleClass(this.shining, 'by-chatset-row--shine', false);
        }
        this.shining = row;
        if (row) {
            // (its animation from the start)
            void row.offsetWidth;
            toggleClass(row, 'by-chatset-row--shine', true);
            this.shineTimer = setTimeout(function () { self.shine(null); }, SHINE_MS) as unknown as number;
        }
    }

    /** Move and resize: the arrows move the chat (outlined), the page out of the way */
    private startArrange(): void {
        this.box = prefs().chatBox || FIRST_BOX;
        this.arranging = 'move';
        this.chat.arrange(true);
        this.draw();
    }

    /** Moving or resizing: the arrows by STEP (resizing: wider to the right, or to the left at the screen's edge; taller
     * upwards, its bottom staying, as the newest message is there), within the screen, shown as it goes (kept in
     * Settings on OK); OK from moving to resizing, then done; Back puts it back */
    private arrangeKey(code: number): void {
        var b = { x: this.box.x, y: this.box.y, w: this.box.w, h: this.box.h };
        var resize = this.arranging === 'resize';
        switch (code) {
            case KEY.OK:
                if (resize) {
                    this.endArrange(true);
                } else {
                    this.arranging = 'resize';
                    this.draw();
                }
                return;
            case KEY.BACK:
                this.endArrange(false);
                return;
            case KEY.LEFT:
            case KEY.RIGHT:
                var by = code === KEY.LEFT ? -STEP : STEP;
                if (resize) {
                    b.w = Math.max(LEAST.w, Math.min(MOST.w, b.w + by));
                } else {
                    b.x += by;
                }
                break;
            case KEY.UP:
            case KEY.DOWN:
                var down = code === KEY.DOWN ? STEP : -STEP;
                if (resize) {
                    var bottom = b.y + b.h;
                    b.h = Math.max(LEAST.h, Math.min(MOST.h, b.h - down));
                    b.y = bottom - b.h;
                } else {
                    b.y += down;
                }
                break;
            default:
                return;
        }
        b.x = Math.max(EDGE, Math.min(LAYOUT_WIDTH - EDGE - b.w, b.x));
        b.y = Math.max(EDGE, Math.min(LAYOUT_HEIGHT - EDGE - b.h, b.y));
        this.box = b;
        this.chat.layout(b);
        this.draw();
    }

    /** Done moving it (keep: the box into Settings; else they still have it as it was); the page again */
    private endArrange(keep: boolean): void {
        if (keep) {
            setPref('chatBox', this.box);
        }
        this.arranging = '';
        this.chat.arrange(false);
        this.apply();
        this.draw();
    }

    /** The next example message (none while hidden: a video started over Settings hides the app's screens); the one after
     * it in EXAMPLE_MS while open */
    private sendExample(): void {
        var self = this;
        if (this.el.offsetWidth) {
            var m = this.examples[this.sent++ % this.examples.length];
            this.chat.show({ id: m.id, author: m.author, parts: m.parts, amount: m.amount, at: Date.now(), avatar: m.avatar });
        }
        clearTimeout(this.exampleTimer);
        this.exampleTimer = setTimeout(function () {
            if (self.shown) {
                self.sendExample();
            }
        }, EXAMPLE_MS) as unknown as number;
    }
}
