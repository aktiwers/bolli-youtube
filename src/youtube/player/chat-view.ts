// A live stream's chat beside the picture, as YouTube's TV app shows it: the latest messages at the right, the newest
// at the bottom (KEPT of them; older ones go), Super Chats with their amount. Asked for while it shows (api/live-chat.ts:
// as often as YouTube says, no more often than every 8 s), an answer's new messages shown one by one until the next is
// due; not while held (the watch page covers it, the video is paused); after failures, or an answer without a next
// token, less and less often. The player stops it when the video closes or the app hides. Where it shows, its size
// and background are Settings' (Live chat settings: player/chat-settings.ts), as are old messages fading out: at the
// right or left (full, tall or half height), at the bottom (a ticker, a band of three, or one at a time), or in a box of
// the viewer's own; or beside the picture (a column of its own at the right or left, the picture narrower beside it; a
// strip at the bottom or top: the picture whole beside it, the two in the middle with an even border, or (one line)
// zoomed to the screen's width, what it covers under a black band beside it);
// the subtitles keep out of its way, and while the player's controls show it keeps above them. Each message's time and
// its author's picture show when Settings say (a picture is loaded only then). Only whole messages show: the oldest
// goes when a new one does not fit, so the top is a clean edge (a panel's too); those kept come back when it has room.

import { h, LAYOUT_HEIGHT, LAYOUT_WIDTH, setClass, toggleClass, translate } from '../core/dom.js';
import { localClock } from '../core/time.js';
import { ChatMessage, liveChat } from '../api/live-chat.js';
import { ChatBox, prefs } from '../api/prefs.js';

/** Messages kept (a band along the bottom shows BAND of them) */
var KEPT = 30;
var BAND = 3;
/** After a failure, asked again this long later, doubled per failure in a row up to FAILED_MAX_MS */
var FAILED_MS = 10000;
var FAILED_MAX_MS = 5 * 60000;
/** A message fading out takes this long, then goes (themes: .by-chat-line--gone) */
var FADE_MS = 600;
/** One at a time: each message shows at least this long (ms; meanwhile the newest waits) */
var ONE_MS = 3000;
/** Where a box of its own starts when there is none yet and the chat does not show: where the theme puts the chat by
 * default (youtube.css .by-chat: 40 from the right, from 120 below the top to 170 above the bottom, 420 wide) */
export var FIRST_BOX: ChatBox = { x: 820, y: 120, w: 420, h: 430 };
/** Kept this far above the player's controls while they show, and moved up no nearer the screen's top than this
 * (layout units; nearer: shorter instead) */
var ABOVE_CONTROLS = 16;
var SCREEN_TOP = 20;
/** The subtitles (layout units): where they start from the top (base.css .vod-subtitles), the gap they keep from the
 * chat beside it and above it along the bottom, and the least width they need beside it (less: they stay where they
 * are) */
var SUBTITLES_TOP = 560;
var SUBTITLES_GAP = 60;
var SUBTITLES_ABOVE = 16;
var SUBTITLES_MIN = 300;
/** Beside the picture: the gap between the chat and the picture, and the border around the two (layout units) */
var BESIDE_GAP = 20;
var BESIDE_BORDER = 20;
/** The bottom styles, the first by default */
var BOTTOM_STYLES = ['ticker', 'band', 'one'];

/** A message kept, and when it was shown */
interface Kept {
    m: ChatMessage;
    at: number;
}

export class ChatView {
    private el: HTMLElement;
    private list: HTMLElement;
    private ticker: ChatTicker;
    private one: HTMLElement;
    /** The token for the next messages ('' stopped) */
    private token = '';
    private timer = 0;
    /** Incremented per start, stop and hold, so a late answer is dropped */
    private gen = 0;
    /** Failures in a row; when the next ask is due; held (covered or paused) */
    private failures = 0;
    private dueAt = 0;
    private held = false;
    /** The ids of the messages shown, in order (an answer can repeat one) */
    private ids: string[] = [];
    /** The last answer's messages not shown yet, and the timer showing the next */
    private queue: ChatMessage[] = [];
    private showTimer = 0;
    /** The last KEPT messages shown (the lines are the last of them, as many as fit), and the timer fading the next */
    private recent: Kept[] = [];
    private fadeTimer = 0;
    /** One at a time: when the one showing came, the newest waiting and its timer */
    private oneAt = 0;
    private oneNext: ChatMessage | null = null;
    private oneTimer = 0;
    /** Where it is ('side', 'strip' (over the picture at the bottom, or beside it at the bottom or top), 'beside' (a column)
     * or 'own'), whether the picture makes room for it (beside it) and whether it is at the top (a strip beside it),
     * how the messages show ('list': lines, the newest at the bottom; 'ticker' or 'one': along the bottom), the most
     * lines, what the shown ones were made with (size, times, pictures), the ticker's width (0: not adding to it) */
    private kind = 'side';
    private beside = false;
    private atTop = false;
    /** Beside the picture as a strip, the picture zoomed to fill (fill), and the black band beside it (made when first
     * needed) */
    private fill = false;
    private matte: HTMLElement | null = null;
    /** The pictures are placed beside it (makeRoom); else they are left as they are (a preview's box is the player's) */
    private placed = false;
    private mode = 'list';
    private most = KEPT;
    private made = '';
    private strip = 0;
    /** Its place as laid out (layout units, without the move above the controls), its own height ('' the theme's), and
     * how far it is kept above the controls now (-1: to be worked out) */
    private top = 0;
    private height = 0;
    private ownHeight = '';
    private lifted = -1;
    /** Showing: a stream's chat started, or the example over Settings */
    private on = false;
    /** Being moved or resized (Live chat settings: outlined) */
    private arranging = false;

    /** In the player's element, shown while it is marked by-player--chat; the subtitles keep out of its way, beside the
     * picture the pictures (the player's video, the cover over it) narrow beside it, and while controls() says where the
     * player's controls start (0: hidden) it keeps above them */
    constructor(private player: HTMLElement, private subtitles?: HTMLElement, private pictures?: HTMLElement[], private controls?: () => number) {
        this.el = player.appendChild(h('div', 'by-chat')) as HTMLElement;
        this.list = this.el.appendChild(h('div', 'by-chat-list')) as HTMLElement;
        this.ticker = new ChatTicker(this.el);
        this.one = this.el.appendChild(h('div', 'by-chat-one')) as HTMLElement;
        this.layout();
    }

    /** Whether it shows (a stream's chat, or the example) */
    get shown(): boolean {
        return this.on;
    }

    /** Placed and styled as Settings say (box: a box of its own being moved, in place of Settings'); the messages made
     * again when how they show changed; the subtitles and the pictures out of its way, above the controls if they show;
     * old messages fade from now on if set */
    layout(box?: ChatBox): void {
        var p = prefs();
        // (beside the picture at the bottom or top: a strip as over it at the bottom, the picture shorter beside it)
        this.beside = p.chatMode === 'beside';
        var at = this.beside ? p.chatSide : p.chatPosition;
        var own = box || (!this.beside && at === 'custom' ? p.chatBox : null);
        this.atTop = this.beside && at === 'top';
        var strip = at === 'bottom' || this.atTop;
        var kind = this.kind = own ? 'own' : strip ? 'strip' : this.beside ? 'beside' : 'side';
        var style = BOTTOM_STYLES.indexOf(p.chatBottom) >= 0 ? p.chatBottom : BOTTOM_STYLES[0];
        setClass(this.el, 'by-chat' + (at === 'left' ? ' by-chat--left' : '') +
            (kind === 'beside' ? ' by-chat--beside' : '') + (kind === 'side' && (p.chatHeight === 'full' || p.chatHeight === 'half') ? ' by-chat--' + p.chatHeight : '') +
            (strip ? ' by-chat--bottom by-chat--' + style + (this.atTop ? ' by-chat--top' : '') : '') + (own ? ' by-chat--custom' : '') +
            (p.chatSize !== 'normal' ? ' by-chat--' + p.chatSize : '') + (p.chatBackground !== 'bubbles' ? ' by-chat--' + p.chatBackground : '') +
            (this.arranging ? ' by-chat--arranging' : ''));
        var s = this.el.style;
        s.left = own ? own.x + 'px' : '';
        s.top = own ? own.y + 'px' : '';
        s.width = own ? own.w + 'px' : '';
        s.height = this.ownHeight = own ? own.h + 'px' : '';
        s.webkitTransform = '';
        // Beside the picture as a strip, the picture whole: as wide as the picture, the two in the middle of the screen
        // with an even border (its height the theme's)
        // (a band would cut too much of it: whole)
        this.fill = strip && this.beside && p.chatPicture === 'fill' && style !== 'band';
        if (strip && this.beside && !this.fill) {
            var tall = LAYOUT_HEIGHT - this.el.offsetHeight - BESIDE_GAP - 2 * BESIDE_BORDER;
            var wide = Math.round(tall * 16 / 9);
            s.left = Math.round((LAYOUT_WIDTH - wide) / 2) + 'px';
            s.width = wide + 'px';
            s.top = (this.atTop ? BESIDE_BORDER : BESIDE_BORDER + tall + BESIDE_GAP) + 'px';
        }
        var mode = strip && style !== 'band' ? style : 'list';
        var made = p.chatSize + (p.chatTimes ? ' times' : '') + (p.chatAvatars ? ' pictures' : '');
        this.most = strip ? BAND : KEPT;
        if (mode !== this.mode || made !== this.made) {
            this.mode = mode;
            this.made = made;
            this.remake();
        }
        // (held: covered or paused, nothing joins the ticker)
        this.strip = mode === 'ticker' && !this.held ? this.el.clientWidth : 0;
        this.top = this.el.offsetTop;
        this.height = this.el.offsetHeight;
        this.makeRoom();
        this.lifted = -1;
        this.lift();
    }

    /** Where it is now, in layout units, as laid out (its box; null: it does not show) */
    rect(): ChatBox | null {
        var w = this.el.offsetWidth;
        return this.on && w && this.height ? { x: this.el.offsetLeft, y: this.top, w: w, h: this.height } : null;
    }

    /** Outlined while it is moved or resized */
    arrange(on: boolean): void {
        this.arranging = on;
        toggleClass(this.el, 'by-chat--arranging', on);
    }

    /** Kept above the player's controls while they show (where controls() says they start; 0: hidden): moved up as much
     * as it needs, or, where that would take its top off the screen (a column the whole height), shorter instead; the
     * subtitles above a strip moved with it; then whole lines again */
    lift(): void {
        var top = this.on && this.height && this.controls ? this.controls() : 0;
        var by = top ? Math.max(0, this.top + this.height + ABOVE_CONTROLS - top) : 0;
        if (by === this.lifted) {
            return;
        }
        this.lifted = by;
        var shorter = by > this.top - SCREEN_TOP;
        var s = this.el.style;
        s.height = by && shorter ? this.height - by + 'px' : this.ownHeight;
        if (by && !shorter) {
            translate(this.el, 0, -by);
        } else {
            s.webkitTransform = '';
        }
        if (this.subtitles) {
            if (by && this.kind === 'strip') {
                translate(this.subtitles, 0, -by);
            } else {
                this.subtitles.style.webkitTransform = '';
            }
        }
        this.refill();
        this.fit();
        this.fade();
    }

    /** Shows the chat from token, its first messages (not if it shows already) */
    start(token: string): void {
        if (this.token || !token) {
            return;
        }
        this.token = token;
        this.showing(true);
        this.ask();
    }

    /** Shows or hides it as the example over Settings (Live chat settings: no chat to ask; messages come by show) */
    showExample(on: boolean): void {
        if (on !== this.on) {
            this.showing(on);
        }
    }

    /** Stops asking and empties it */
    stop(): void {
        this.pause();
        clearTimeout(this.showTimer);
        clearTimeout(this.fadeTimer);
        this.fadeTimer = 0;
        this.queue = [];
        this.token = '';
        this.failures = 0;
        this.ids = [];
        this.recent = [];
        this.remake();
        this.showing(false);
    }

    /** Held (the watch page covers it, the video is paused): nothing asked meanwhile; released: asked when due; either
     * way the subtitles and the pictures as it is now (the watch page hides it) */
    hold(held: boolean): void {
        if (held !== this.held) {
            this.held = held;
            this.pause();
            if (held) {
                this.strip = 0;
            }
            this.flush();
            if (!held && this.on) {
                // (Settings may have changed meanwhile; messages came while it was covered)
                this.layout();
                if (this.token) {
                    this.again(this.dueAt - Date.now());
                }
                return;
            }
        }
        this.makeRoom();
    }

    /** Shows a message (the example's too) */
    show(m: ChatMessage): void {
        this.put(m);
        this.fit();
        this.fadeLater();
    }

    /** Shown or not: the player marked (the theme shows it then), laid out (the subtitles and the pictures as it is) */
    private showing(on: boolean): void {
        this.on = on;
        toggleClass(this.player, 'by-player--chat', on);
        this.layout();
    }

    private pause(): void {
        clearTimeout(this.timer);
        this.gen++;
    }

    private ask(): void {
        if (this.held) {
            return;
        }
        var self = this;
        var gen = this.gen;
        var failed = function (): void {
            self.again(Math.min(FAILED_MAX_MS, FAILED_MS * Math.pow(2, self.failures++)));
        };
        liveChat(this.token).then(function (a) {
            if (gen !== self.gen) {
                return;
            }
            // (the first answer's, the chat so far, at once)
            self.add(a.messages, self.ids.length ? a.waitMs : 0);
            // No next token (an odd answer, or the chat ended): the same one again, less and less often
            if (!a.next) {
                failed();
                return;
            }
            self.failures = 0;
            self.token = a.next;
            self.again(a.waitMs);
        }, function () {
            if (gen === self.gen) {
                failed();
            }
        });
    }

    /** Asks in ms (at once if due already) */
    private again(ms: number): void {
        var self = this;
        this.dueAt = Date.now() + Math.max(0, ms);
        this.timer = setTimeout(function () { self.ask(); }, Math.max(0, ms)) as unknown as number;
    }

    /** Shows the messages not shown yet (only the last KEPT of them) one by one over spread ms (0: at once), the rest
     * of the last answer's at once first */
    private add(messages: ChatMessage[], spread: number): void {
        var self = this;
        var known = this.ids.concat(this.queue.map(function (m) { return m.id; }));
        this.flush();
        this.queue = messages.filter(function (m) { return known.indexOf(m.id) < 0; }).slice(-KEPT);
        var every = spread / Math.max(1, this.queue.length);
        var next = function (): void {
            self.showTimer = 0;
            self.show(self.queue.shift() as ChatMessage);
            if (self.queue.length) {
                self.showTimer = setTimeout(next, every) as unknown as number;
            }
        };
        if (!spread) {
            this.flush();
        } else if (this.queue.length) {
            next();
        }
    }

    /** Shows the messages waiting at once (fitted once after) */
    private flush(): void {
        clearTimeout(this.showTimer);
        this.showTimer = 0;
        if (this.queue.length) {
            while (this.queue.length) {
                this.put(this.queue.shift() as ChatMessage);
            }
            this.fit();
            this.fadeLater();
        }
    }

    /** A message kept (the last KEPT) and shown as the chat shows them now: a line at the bottom, onto the ticker, or in
     * the last one's place */
    private put(m: ChatMessage): void {
        this.ids.push(m.id);
        if (this.ids.length > KEPT) {
            this.ids.shift();
        }
        this.recent.push({ m: m, at: Date.now() });
        if (this.recent.length > KEPT) {
            this.recent.shift();
        }
        if (this.mode === 'list') {
            this.list.appendChild(lineOf('div', 'by-chat-line', m));
            // (a line for each kept message at most)
            if (this.list.children.length > this.recent.length) {
                this.list.removeChild(this.list.firstChild as Node);
            }
        } else if (this.mode === 'ticker') {
            if (this.strip) {
                this.ticker.add(m, this.strip);
            }
        } else {
            this.showOne(m);
        }
    }

    /** The messages shown made again for how they show now: the lines (fitted after), the ticker empty (it fills with
     * the next), one at a time the newest */
    private remake(): void {
        clearTimeout(this.oneTimer);
        this.oneTimer = 0;
        this.oneNext = null;
        this.list.innerHTML = '';
        this.ticker.clear();
        this.one.innerHTML = '';
        this.refill();
        if (this.mode === 'one' && this.recent.length) {
            this.showOne(this.recent[this.recent.length - 1].m);
        }
    }

    /** The lines again from the messages kept, those fit dropped too (fitted after) */
    private refill(): void {
        if (this.mode === 'list') {
            for (var i = this.recent.length - this.list.children.length - 1; i >= 0; i--) {
                this.list.insertBefore(lineOf('div', 'by-chat-line', this.recent[i].m), this.list.firstChild);
            }
        }
    }

    /** One at a time: the message in the last one's place, which shows ONE_MS at least (meanwhile the newest waits) */
    private showOne(m: ChatMessage): void {
        var self = this;
        var wait = this.one.firstChild ? this.oneAt + ONE_MS - Date.now() : 0;
        this.oneNext = m;
        if (wait > 0) {
            if (!this.oneTimer) {
                this.oneTimer = setTimeout(function () {
                    self.oneTimer = 0;
                    if (self.oneNext) {
                        self.showOne(self.oneNext);
                    }
                }, wait) as unknown as number;
            }
            return;
        }
        this.oneNext = null;
        this.one.innerHTML = '';
        this.one.appendChild(lineOf('div', 'by-chat-one-line', m));
        this.oneAt = Date.now();
        toggleClass(this.el, 'by-chat--faded', false);
        this.fadeLater();
    }

    /** The oldest lines go while they do not all fit in the box (the newest stays; a band keeps BAND), measured once;
     * not while it is hidden (no height to fit: done when it shows again) */
    private fit(): void {
        var lines = this.list.children;
        var room = this.mode === 'list' && lines.length > 1 ? this.el.clientHeight : 0;
        if (!room) {
            return;
        }
        var over = this.list.offsetHeight - room;
        var drop = 0;
        // (a line takes up to where the next one starts)
        while (drop < lines.length - 1 && (drop < lines.length - this.most || over > 0)) {
            over -= (lines[drop + 1] as HTMLElement).offsetTop - (lines[drop] as HTMLElement).offsetTop;
            drop++;
        }
        while (drop--) {
            this.list.removeChild(this.list.firstChild as Node);
        }
    }

    /** While it shows, the subtitles out of its way (above a strip at the bottom, or the band beside it; else at the
     * other side of it, when it is at a side or low enough to be in their way and there is room) and, beside the
     * picture, the pictures beside it: narrower beside a column (a border at the far side as the gap), whole or zoomed
     * beside a strip; else as the theme has them (layout units, its place as laid out; hidden by the watch page: as the
     * theme has them) */
    private makeRoom(): void {
        var x = this.el.offsetLeft;
        var w = this.el.offsetWidth;
        var showing = this.on && w > 0;
        var atRight = x + w / 2 > LAYOUT_WIDTH / 2;
        // Beside a strip: the room left for the picture (from, to: layout units from the top)
        var strip = showing && this.beside && this.kind === 'strip';
        var from = this.atTop ? this.top + this.height + BESIDE_GAP : this.fill ? 0 : BESIDE_BORDER;
        var to = this.atTop ? LAYOUT_HEIGHT - (this.fill ? 0 : BESIDE_BORDER) : this.top - BESIDE_GAP;
        if (this.subtitles) {
            var sub = this.subtitles.style;
            var room = atRight ? x - SUBTITLES_GAP : LAYOUT_WIDTH - (x + w + SUBTITLES_GAP);
            var beside = showing && this.kind !== 'strip' && (this.kind !== 'own' || this.top + this.height > SUBTITLES_TOP) && room >= SUBTITLES_MIN;
            sub.bottom = showing && this.kind === 'strip' && !this.atTop ? LAYOUT_HEIGHT - (strip && this.fill ? to : this.top) + SUBTITLES_ABOVE + 'px' : '';
            sub.right = beside && atRight ? LAYOUT_WIDTH - x + SUBTITLES_GAP + 'px' : '';
            sub.left = beside && !atRight ? x + w + SUBTITLES_GAP + 'px' : '';
        }
        var narrow = showing && this.kind === 'beside';
        var fill = strip && this.fill;
        // (put back as the theme has them only once after being placed: a preview's box is left alone)
        var place = narrow || strip;
        (place || this.placed ? this.pictures || [] : []).forEach(function (picture) {
            var p = picture.style;
            p.left = narrow ? (atRight ? BESIDE_BORDER : x + w + BESIDE_GAP) + 'px' : strip && !fill ? x + 'px' : '';
            p.width = narrow ? (atRight ? x - BESIDE_GAP - BESIDE_BORDER : LAYOUT_WIDTH - BESIDE_BORDER - (x + w + BESIDE_GAP)) + 'px' : strip && !fill ? w + 'px' : '';
            // (zoomed: the whole screen's size, its middle in the middle of the room)
            p.top = fill ? Math.round((from + to - LAYOUT_HEIGHT) / 2) + 'px' : strip ? from + 'px' : '';
            p.height = strip && !fill ? to - from + 'px' : '';
        });
        this.placed = place;
        if (fill && !this.matte) {
            this.matte = this.player.insertBefore(h('div', 'by-chat-matte'), this.el) as HTMLElement;
        }
        if (this.matte) {
            var m = this.matte.style;
            m.display = fill ? 'block' : 'none';
            m.top = this.atTop ? '0' : to + 'px';
            m.height = (this.atTop ? from : LAYOUT_HEIGHT - to) + 'px';
        }
    }

    /** Places the pictures again as the chat has them (the playlist at the side put them back) */
    placePictures(): void {
        this.placed = true;
        this.makeRoom();
    }

    /** The timer fading the next, if old messages fade and none is set */
    private fadeLater(): void {
        if (!this.fadeTimer && prefs().chatFade) {
            this.fade();
        }
    }

    /** Fades out the messages shown longer than Settings' Old messages, then lets them go (one at a time: the strip
     * fades with the one showing); one timer, for the next one due (none while nothing is to fade) */
    private fade(): void {
        var after = prefs().chatFade * 1000;
        var now = Date.now();
        var next = Infinity;
        var lines = this.list.children;
        clearTimeout(this.fadeTimer);
        this.fadeTimer = 0;
        // (the oldest first, as shown; the lines are the last of those kept)
        while (after && this.recent.length && now - this.recent[0].at >= after + FADE_MS) {
            if (lines.length === this.recent.length) {
                this.list.removeChild(this.list.firstChild as Node);
            }
            this.recent.shift();
        }
        var first = this.recent.length - lines.length;
        for (var i = 0; i < lines.length; i++) {
            var age = now - this.recent[first + i].at;
            toggleClass(lines[i] as HTMLElement, 'by-chat-line--gone', !!after && age >= after);
            if (after) {
                next = Math.min(next, age >= after ? after + FADE_MS - age : after - age);
            }
        }
        var shown = this.one.firstChild ? now - this.oneAt : -1;
        toggleClass(this.el, 'by-chat--faded', !!after && shown >= after);
        if (after && shown >= 0 && shown < after) {
            next = Math.min(next, after - shown);
        }
        if (next < Infinity) {
            var self = this;
            this.fadeTimer = setTimeout(function () { self.fade(); }, next) as unknown as number;
        }
    }
}

/** A strip as a ticker: the messages run across it from right to left at an even pace (a CSS transition: the TV's
 * compositor moves it, no timer per frame), each new one joining the end and entering at the right edge when nothing
 * else is coming; a backlog speeds it up, one of more than two strips skips to the newest; gone past the left edge,
 * they are taken away */
export class ChatTicker {
    private track: HTMLElement;
    /** Its items' widths, a gap before one included, in order, and all of them */
    private widths: number[] = [];
    private length = 0;

    constructor(parent: HTMLElement) {
        this.track = parent.appendChild(h('div', 'by-chat-ticker')) as HTMLElement;
    }

    /** m joins the end (strip: the ticker's width, layout units) */
    add(m: ChatMessage, strip: number): void {
        var self = this;
        var x = this.position();
        // Gone past the left edge: taken away, the track's place moving by as much
        while (this.widths.length && x + this.widths[0] < 0) {
            var gone = this.widths.shift() as number;
            x += gone;
            this.length -= gone;
            this.track.removeChild(this.track.firstChild as Node);
        }
        if (!this.widths.length) {
            x = strip;
        }
        // Nothing still coming: it enters at the right edge
        var gap = Math.max(0, strip - (x + this.length));
        var item = lineOf('span', 'by-chat-tick', m);
        item.style.marginLeft = gap + 'px';
        // At x at once (no transition), with the item in: one layout, reading its width, for both
        var s = this.track.style;
        s.webkitTransition = 'none';
        translate(this.track, x, 0);
        this.track.appendChild(item);
        this.widths.push(item.offsetWidth + gap);
        this.length += this.widths[this.widths.length - 1];
        // More than two strips waiting beyond the right edge: the newest of them only
        if (x + this.length - strip > 2 * strip) {
            var start = x;
            var waiting: number[] = [];
            this.widths.forEach(function (w, i) {
                if (start >= strip) {
                    waiting.push(i);
                }
                start += w;
            });
            waiting.slice(0, -1).reverse().forEach(function (i) {
                self.length -= self.widths[i];
                self.widths.splice(i, 1);
                self.track.removeChild(self.track.children[i]);
            });
        }
        // Then on until all of it is past the left edge
        var pace = Math.min(TICKER_FASTEST, TICKER_PACE + Math.max(0, x + this.length - strip) * TICKER_CATCH_UP);
        s.webkitTransition = '-webkit-transform ' + ((x + this.length) / pace).toFixed(2) + 's linear';
        translate(this.track, -this.length, 0);
    }

    clear(): void {
        if (this.widths.length) {
            this.widths = [];
            this.length = 0;
            this.track.innerHTML = '';
            this.track.style.webkitTransition = 'none';
            this.track.style.webkitTransform = '';
        }
    }

    /** Where the track is now, its transition running (layout units) */
    private position(): number {
        if (!this.widths.length) {
            return 0;
        }
        var m = /matrix(3d)?\(([^)]*)\)/.exec(getComputedStyle(this.track).webkitTransform || '');
        return m ? +m[2].split(',')[m[1] ? 12 : 4] || 0 : 0;
    }
}

/** The ticker's pace (layout units a second), faster by TICKER_CATCH_UP a second per unit waiting, up to TICKER_FASTEST */
var TICKER_PACE = 110;
var TICKER_CATCH_UP = 0.05;
var TICKER_FASTEST = 240;

/** A message's element (tag; its class base, a Super Chat's base--paid too): its time and its author's picture when
 * Settings show them (made only then: a picture is a request), its author, a Super Chat's amount, then its text and
 * emoji (an emoji without a picture by name) */
function lineOf(tag: string, base: string, m: ChatMessage): HTMLElement {
    var p = prefs();
    var el = h(tag, base + (m.amount ? ' ' + base + '--paid' : ''));
    if (m.at && p.chatTimes) {
        el.appendChild(h('span', 'by-chat-time', localClock(m.at)));
    }
    if (m.avatar && p.chatAvatars) {
        (el.appendChild(h('img', 'by-chat-avatar')) as HTMLImageElement).src = m.avatar;
    }
    el.appendChild(h('span', 'by-chat-author', m.author));
    if (m.amount) {
        el.appendChild(h('span', 'by-chat-amount', m.amount));
    }
    m.parts.forEach(function (part) {
        if (part.emoji) {
            var img = el.appendChild(h('img', 'by-chat-emoji')) as HTMLImageElement;
            img.alt = part.text;
            img.src = part.emoji;
        } else {
            el.appendChild(document.createTextNode(part.text));
        }
    });
    return el;
}
