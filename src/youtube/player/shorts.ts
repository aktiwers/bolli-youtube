// The Shorts screen, as YouTube's TV app has it: the upright video in the middle left on the look's background (the
// player see-through over the page's own: themes/youtube.css), rounded, a ring round it while it has the focus (the
// highlight), nothing over it until its own first frame (every Short from its start, as YouTube's), a thin line
// along its foot showing how far it has played; at the right "Press down for next video" until Down was pressed once,
// then lower down the title (how old it is under it, where YouTube says), the full video it is from (where YouTube names one), the channel, Subscribe and a row of
// round buttons (ui/pills.ts): Like (its count under it while focused), Comments, Remix, More. Up/Down go to the
// previous or next Short: the video is replaced in place by the next Short as soon as can be (started right after the
// key's frame), while the column's texts slide out (a CSS animation of a layer of its own, nothing laid out), are drawn
// anew while out of sight and slide back in (a held key's repeats slide nothing: the column drawn and the Short started
// once they stop). Down runs through the Shorts it was opened with (a row's), then YouTube's sequence for the first (its
// tile's token, else its overlay's; api/shorts.ts), asked as the end nears (held keys too); where none is given or one
// ends, YouTube's own sequence of the sidebar's Shorts goes on, so they never end. Down on the last Short waits for
// more (the player's loading sign in the box) and goes on by itself; a part that fails or brings nothing new is asked
// again a few times, then only at the next Down there (a Short ending there plays again, asking nothing). As a Short
// moves, the next one the way of travel is loaded ahead (the player's preload: streams, first media) with its overlay.
// OK on the video pauses or plays and shows the player's own bar in the box (times, the seek bar with its frames); with
// it shown Left/Right seek as in the player, Back hides it. Right goes to the buttons (Up/Down in the column, Left back
// to the video); Left from the video goes to the sidebar, Back closes (from the column: back to the video). Comments
// open in the column's place (player/comments-view.ts), as do the description (the title) and Remix's QR code; More
// opens the side panel: Save to playlist, Subtitles, Not interested (YouTube's command, where it gives one), Stats for
// nerds. YouTube's Report and Feedback are not offered (the app sends no report; feedback is YouTube's own form). A
// step to another Short closes what is open first; a Short ending while something is open plays again. A click (the
// Magic Remote's pointer) is OK on the row, button or video under it. The video is the player's own (own-player.ts): it
// plays, reports to History and takes the remote's media keys and shortcuts as any video.

import { h, setClass, setShown, setSrc, setText, toggleClass } from '../core/dom.js';
import { tr } from '../core/i18n.js';
import { KEY, ownPress } from '../core/keys.js';
import { takesPointer } from '../core/pointer.js';
import { Page, toastOf, Video } from '../api/feed.js';
import { Reel, reelItem, reelSequence, Sequence, shortOfReel } from '../api/shorts.js';
import { run } from '../api/watch.js';
import { apply, drawSubscribe, openSaveTo, pressSubscribe, subscribed } from '../ui/account.js';
import { icon, setIcon } from '../ui/icons.js';
import { Pills } from '../ui/pills.js';
import { drawQr } from '../ui/qr.js';
import { PanelLine, paragraphs, SidePanel } from '../ui/side-panel.js';
import { PROBLEM, toast } from '../ui/toast.js';
import { CommentsView } from './comments-view.js';

/** Where the upright video lies (layout px): a 9:16 box, top to bottom with small margins, its middle left of the
 * screen's, as YouTube's TV app has it */
export var SHORTS_BOX = { left: 397, top: 6, width: 398, height: 708 };
/** The column's slide between two Shorts (app.css by-shorts-column--out, --in), ms: out over the first half, back in over
 * the second; a held key's Short starts once the keys rest this long */
var SLIDE_MS = 150;
var COLUMN_MS = SLIDE_MS / 2;
/** The sequence's next part is asked once this few Shorts are left after the one shown (a fast scroll, a held key,
 * rarely reaches the end before it comes) */
var AHEAD = 5;
/** Overlays kept here by id (those around the one shown; the rest are let go past this many) */
var KEPT = 12;
/** The QR code's side (layout px) */
var QR_SIZE = 300;
/** The progress line's steps (a write only when it moves on by one: 200 along the box, ~2 px each) */
var PROGRESS_STEPS = 200;
/** A part that brought nothing new (failed, empty, only Shorts listed already) is asked again (with the next token, or
 * the same one after a failure) after each of these pauses in turn, near the end only; then no more until Down on the
 * last Short */
var RETRY_MS = [0, 500, 1000, 2000];
/** The rows of the column, top to bottom, and the round buttons, left to right */
var ROWS = ['title', 'link', 'channel', 'subscribe'];
/** The column's classes: still, and sliding out or in, up (as Down) or down */
var COLUMN_CLASSES: { [motion: string]: string } = { '': 'by-shorts-column', 'out-up': 'by-shorts-column by-shorts-column--out-up',
    'in-up': 'by-shorts-column by-shorts-column--in-up', 'out-down': 'by-shorts-column by-shorts-column--out-down',
    'in-down': 'by-shorts-column by-shorts-column--in-down' };
var BUTTONS = ['like', 'comments', 'remix', 'more'];

/** The box for a Short's video w by h: the largest of its shape inside SHORTS_BOX, in its middle */
export function shortsBox(w: number, h: number): { left: number; top: number; width: number; height: number } {
    var b = SHORTS_BOX;
    var shape = w && h ? w / h : b.width / b.height;
    var width = Math.min(b.width, Math.round(b.height * shape));
    var height = Math.min(b.height, Math.round(b.width / shape));
    return { left: b.left + Math.round((b.width - width) / 2), top: b.top + Math.round((b.height - height) / 2), width: width, height: height };
}

/** What the screen asks of the player (own-player.ts) */
export interface ShortsHost {
    /** Plays short from its start in place of what plays; loop: it plays again at its end */
    play(short: Video, loop: boolean): void;
    /** Short id loops at its end (its overlay came after it started) */
    setLoop(id: string, loop: boolean): void;
    /** Pause or play, the player's bar shown (OK; nothing while no Short plays) */
    toggle(): void;
    /** Whether the player's bar shows over the box, and hides it (Back) */
    controlsShown(): boolean;
    hideControls(): void;
    /** A seek back (-1) or on (1) as the player's Left/Right */
    jump(by: number): void;
    /** The player's loading sign in the box (on: Down waits on the last Short for more) */
    waiting(on: boolean): void;
    /** Stats for nerds over the video: on or off, and whether shown */
    stats(): void;
    statsShown(): boolean;
    /** The subtitles' choices pushed over the panel's list, and the name of those shown (Off: none) */
    captions(panel: SidePanel): void;
    captionName(): string;
    /** Loads short ahead (the player's preload: its streams and first media) */
    ahead(short: Video): void;
    /** Opens a channel's page (the player closes; Back from it comes back here) */
    channel(page: Page): void;
    /** Plays a video in the player as any video (the Shorts screen left) */
    watch(video: Video): void;
    /** The comments of video id opened (null: closed): offered to a phone */
    comments(id: string | null): void;
    /** Closes the screen: Back (back to the video the Shorts were opened from, if one), or Left (sidebar: the sidebar to
     * have the focus) */
    leave(sidebar: boolean): void;
    /** Previous at the first Short: the video they were opened from (false: none) */
    back(): boolean;
}

/** Where the screen's data comes from (api/shorts.ts: YouTube's reel endpoints) */
export interface ShortsAsk {
    item(id: string): Promise<Reel>;
    sequence(token: string): Promise<Sequence>;
}

export class ShortsView {
    shown = false;
    el: HTMLElement;
    /** The ring round the video while it has the focus */
    private ring: HTMLElement;
    /** The progress line's fill and its step as last written (-1: none) */
    private progressFill: HTMLElement;
    private progressAt = -1;
    private hint: HTMLElement;
    private rowEls: { [row: string]: HTMLElement } = {};
    private buttonEls: { [button: string]: HTMLElement } = {};
    private pills = new Pills('by-shorts-item--focused');
    private title: HTMLElement;
    private age: HTMLElement;
    private linkText: HTMLElement;
    private avatar: HTMLImageElement;
    private handle: HTMLElement;
    private subIcon: HTMLElement;
    private subLabel: HTMLElement;
    private likeIcon: HTMLElement;
    private likeCount: HTMLElement;
    private commentCount: HTMLElement;
    private remixCount: HTMLElement;
    /** The description (the title's OK) and Remix's QR code, in the column's place; built on first use */
    private about: { el: HTMLElement; title: HTMLElement; facts: HTMLElement; box: HTMLElement; text: HTMLElement } | null = null;
    private remix: { el: HTMLElement; qr: HTMLCanvasElement; title: HTMLElement; under: HTMLElement; link: HTMLElement } | null = null;
    private commentsMade: CommentsView | null = null;
    private panelMade: SidePanel | null = null;
    /** What shows in the column's place ('' the column) */
    private opened = '';
    /** The Shorts in order, the one shown, and the way the viewer goes (1 down, -1 up: what is loaded ahead) */
    private list: Video[] = [];
    private at = 0;
    private way = 1;
    /** Their overlays as they came, by id */
    private reels: { [id: string]: Reel } = {};
    /** The first Short's overlay on its way (the sequence waits for it: its token, the sidebar's first Short) */
    private first = false;
    /** The sequence's token for more ('' none), a part on its way, and Down waiting for it at the end */
    private token = '';
    private asking = false;
    private waiting = false;
    /** Parts asked again in a row (RETRY_MS), the timer of the next, and the series given up (none asked until Down on
     * the last Short) */
    private tries = 0;
    private retryTimer = 0;
    private spent = false;
    /** The focus: on the video, else on the column's rows (rows: those the Short has, row: the focused one) or its buttons */
    private onColumn = false;
    private onButtons = false;
    private rows: string[] = [];
    private row = 0;
    private marked: HTMLElement | null = null;
    /** Down was pressed in this showing (the hint goes) */
    private hinted = false;
    /** Incremented per opening, so late answers are dropped */
    private gen = 0;
    /** A Short to start (playSoon: after the key's frame, or once a held key's repeats rest), its timer, and the two
     * steps made once (no function made per key) */
    private playWanted = false;
    private playTimer = 0;
    private go: () => void;
    private afterFrame: () => void;
    /** The column, its swap on its way (drawn anew out of sight, then in: 0 none), the way it slides ('up', 'down'), and
     * the swap made once */
    private column: HTMLElement;
    private columnTimer = 0;
    private columnWay = 'up';
    private swap: () => void;

    constructor(parent: HTMLElement, private host: ShortsHost, private asks: ShortsAsk = { item: reelItem, sequence: reelSequence }) {
        var self = this;
        this.go = function (): void {
            var short = self.current;
            if (!self.playWanted || !short) {
                return;
            }
            self.playWanted = false;
            var reel = self.reels[short.id];
            self.host.play(short, reel ? reel.loop : true);
            // (the column's swap draws it, where it slides)
            if (!self.columnTimer) {
                self.draw();
            }
            self.ask(short);
        };
        this.afterFrame = function (): void {
            clearTimeout(self.playTimer);
            self.playTimer = setTimeout(self.go, 0) as unknown as number;
        };
        this.swap = function (): void {
            self.columnTimer = 0;
            self.draw();
            setClass(self.column, COLUMN_CLASSES['in-' + self.columnWay]);
        };
        this.el = h('div', 'by-shorts');
        // (the video's corners rounded in the look's background, themes/youtube.css: a piece at each corner; the video
        // dimmed while the column has the focus: by the screen's classes)
        ['tl', 'tr', 'bl', 'br'].forEach(function (corner) {
            self.el.appendChild(h('div', 'by-shorts-corner by-shorts-corner--' + corner));
        });
        this.el.appendChild(h('div', 'by-shorts-dim'));
        this.ring = this.el.appendChild(h('div', 'by-shorts-ring')) as HTMLElement;
        var line = this.el.appendChild(h('div', 'by-shorts-progress')) as HTMLElement;
        this.progressFill = line.appendChild(h('div', 'by-shorts-progress-fill')) as HTMLElement;
        // (the bar's play or pause sign: the player's classes show one, app.css)
        this.el.appendChild(icon('play', 'by-shorts-state by-shorts-state--play'));
        this.el.appendChild(icon('pause', 'by-shorts-state by-shorts-state--pause'));
        this.hint = this.el.appendChild(h('div', 'by-shorts-hint')) as HTMLElement;
        this.hint.appendChild(icon('expand', 'by-shorts-hint-icon'));
        this.hint.appendChild(h('span', '', tr('Press down for next video')));
        var column = this.column = this.el.appendChild(h('div', 'by-shorts-column')) as HTMLElement;
        ROWS.forEach(function (id) {
            var el = self.rowEls[id] = column.appendChild(h('div', 'by-shorts-item by-shorts-' + id)) as HTMLElement;
            // (a click: OK on the row)
            takesPointer(el, function () {
                var at = self.rows.indexOf(id);
                if (at < 0 || !self.shown) {
                    return null;
                }
                self.onColumn = true;
                self.onButtons = false;
                self.row = at;
                self.mark();
                return {};
            });
        });
        // (the title's text and its age under it in the title's row: one box, one focus)
        this.title = this.rowEls.title.appendChild(h('div', 'by-shorts-title-text')) as HTMLElement;
        this.age = this.rowEls.title.appendChild(h('div', 'by-shorts-age')) as HTMLElement;
        this.rowEls.link.appendChild(icon('play', 'by-shorts-item-icon'));
        this.linkText = this.rowEls.link.appendChild(h('span', 'by-shorts-item-text')) as HTMLElement;
        this.avatar = this.rowEls.channel.appendChild(h('img', 'by-shorts-avatar')) as HTMLImageElement;
        this.handle = this.rowEls.channel.appendChild(h('span', 'by-shorts-item-text')) as HTMLElement;
        this.subIcon = this.rowEls.subscribe.appendChild(icon('add', 'by-shorts-item-icon')) as HTMLElement;
        this.subLabel = this.rowEls.subscribe.appendChild(h('span', 'by-shorts-item-text')) as HTMLElement;
        var bar = column.appendChild(h('div', 'by-shorts-buttons')) as HTMLElement;
        var counts: { [id: string]: HTMLElement } = {};
        BUTTONS.forEach(function (id, i) {
            var el = self.buttonEls[id] = bar.appendChild(h('div', 'by-shorts-button')) as HTMLElement;
            el.appendChild(icon(id === 'like' ? 'heart' : id, 'by-shorts-button-icon'));
            counts[id] = el.appendChild(h('div', 'by-shorts-count')) as HTMLElement;
            self.pills.add(el, function () { self.press(id); }, function () { return self.has(id); });
            // (a click: the row's focus there, then OK on it)
            takesPointer(el, function () {
                if (!self.shown || !self.has(id)) {
                    return null;
                }
                self.onColumn = self.onButtons = true;
                self.pills.focus(i);
                self.mark();
                return {};
            });
        });
        this.likeIcon = this.buttonEls.like.firstChild as HTMLElement;
        this.likeCount = counts.like;
        this.commentCount = counts.comments;
        this.remixCount = counts.remix;
        setShown(this.el, false);
        parent.appendChild(this.el);
    }

    // ---- opening and closing

    /** Opens the screen at video, one of list (not in it: it alone); none: YouTube's first Short, asked for now */
    open(list: Video[], video: Video | null): void {
        this.gen++;
        var at = video ? list.map(function (s) { return s.id; }).indexOf(video.id) : -1;
        this.list = !video ? [] : at >= 0 ? list.slice() : [video];
        this.at = Math.max(0, at);
        this.way = 1;
        this.reels = {};
        // (a tile's token for the Shorts after it; none: its overlay's, else YouTube's own sequence)
        this.token = video && video.sequence || '';
        this.asking = false;
        this.wait(false);
        this.tries = 0;
        this.spent = false;
        clearTimeout(this.retryTimer);
        this.hinted = false;
        this.progressTo(0);
        this.show();
        this.draw();
        var short = this.current;
        if (short) {
            this.host.play(short, true);
        }
        this.first = true;
        var gen = this.gen;
        var self = this;
        // The first Short's overlay, whose token starts the sequence after it (the sidebar's: it names the Short)
        this.asks.item(short ? short.id : '').then(function (reel) {
            if (gen !== self.gen) {
                return;
            }
            self.first = false;
            self.token = self.token || reel.next;
            if (!short) {
                // (not after Back, nor behind the app: asked again as it comes back, resume; none named: none to play)
                if (!self.shown || document.hidden) {
                    return;
                }
                if (!reel.id) {
                    self.failed();
                    return;
                }
                self.list = [shortOfReel(reel)];
                self.at = 0;
                self.host.play(self.list[0], reel.loop);
            }
            self.got(reel);
            self.more();
        }, function () {
            if (gen === self.gen) {
                self.first = false;
                // (a tile's: the sequence goes on without its token, by the tile's or YouTube's own)
                if (!short) {
                    self.failed();
                } else {
                    self.more();
                }
            }
        });
        // (a tile's token: the sequence asked at once, the overlay not waited for)
        this.more();
    }

    /** The app back in front: the sidebar's first Short, dropped while it was away, asked for again */
    resume(): void {
        if (this.shown && !this.current && !this.first) {
            this.open([], null);
        }
    }

    /** The sidebar's first Short did not come: said, and the screen closed (if it still shows) */
    private failed(): void {
        if (this.shown) {
            toast(tr('Could not load the Shorts.'), undefined, PROBLEM);
            this.host.leave(false);
        }
    }

    /** Shown again as it was left (Back from a channel page opened here, the app back from the background) */
    show(): void {
        this.shown = true;
        this.onColumn = this.onButtons = false;
        this.opened = '';
        setShown(this.el, true);
        setShown(this.hint, !this.hinted);
        this.mark();
    }

    /** Hidden (the player closed or plays another video); what it holds kept for show */
    hide(): void {
        this.shown = false;
        this.playWanted = false;
        clearTimeout(this.playTimer);
        clearTimeout(this.columnTimer);
        this.columnTimer = 0;
        setClass(this.column, COLUMN_CLASSES['']);
        clearTimeout(this.retryTimer);
        this.wait(false);
        this.closeAll();
        setShown(this.el, false);
    }

    /** The Short shown (null: none yet) */
    get current(): Video | null {
        return this.list[this.at] || null;
    }

    /** The panel or the comments while open (null: none; the pointer's layer) */
    layer(): HTMLElement | null {
        return this.panelMade && this.panelMade.shown ? this.panelMade.layer() : this.commentsMade ? this.commentsMade.layer() : null;
    }

    /** The comments are open */
    get commentsOpen(): boolean {
        return !!this.commentsMade && this.commentsMade.shown;
    }

    /** How far Short id has played (0..1): the line along the box's foot, written when it moves on a step (not the
     * Short being left: its ticks come until the next starts) */
    progress(id: string, share: number): void {
        var short = this.current;
        if (short && short.id === id) {
            this.progressTo(share);
        }
    }

    private progressTo(share: number): void {
        var at = Math.max(0, Math.min(PROGRESS_STEPS, Math.round(share * PROGRESS_STEPS)));
        if (at !== this.progressAt) {
            this.progressAt = at;
            this.progressFill.style.webkitTransform = 'scaleX(' + at / PROGRESS_STEPS + ')';
        }
    }

    /** A click on the video: the focus there (the click is then OK on it) */
    pointVideo(): void {
        this.onColumn = false;
        this.mark();
    }

    // ---- keys

    onKey(code: number): boolean {
        var panel = this.panelMade;
        if (panel && panel.shown) {
            panel.onKey(code);
            if (!panel.shown) {
                this.mark();
            }
            return true;
        }
        if (this.commentsMade && this.commentsMade.shown) {
            this.commentsMade.onKey(code);
            return true;
        }
        if (this.opened) {
            this.openedKey(code);
        } else if (!this.onColumn) {
            this.videoKey(code);
        } else if (this.onButtons) {
            this.buttonsKey(code);
        } else {
            this.columnKey(code);
        }
        return true;
    }

    private videoKey(code: number): void {
        switch (code) {
            case KEY.UP:
            case KEY.DOWN:
                this.step(code === KEY.UP ? -1 : 1, true);
                break;
            case KEY.OK:
                this.host.toggle();
                break;
            case KEY.LEFT:
            case KEY.RIGHT:
                if (this.host.controlsShown()) {
                    this.host.jump(code === KEY.LEFT ? -1 : 1);
                } else if (code === KEY.RIGHT) {
                    // (onto the buttons, as YouTube's: Like first)
                    this.onColumn = this.onButtons = true;
                    this.pills.focus(0);
                    if (!this.has('like')) {
                        this.pills.move(1);
                    }
                    this.mark();
                } else {
                    this.host.leave(true);
                }
                break;
            case KEY.BACK:
                if (this.host.controlsShown()) {
                    this.host.hideControls();
                } else {
                    this.host.leave(false);
                }
                break;
        }
    }

    private buttonsKey(code: number): void {
        var self = this;
        var taken = this.pills.key(code, {
            up: function () {
                self.onButtons = false;
                self.row = self.rows.length - 1;
                return true;
            }
        });
        if (!taken || code === KEY.BACK) {
            // (Left past the first, Back: the video)
            this.onColumn = false;
        }
        this.mark();
    }

    private columnKey(code: number): void {
        switch (code) {
            case KEY.UP:
                this.row = Math.max(0, this.row - 1);
                break;
            case KEY.DOWN:
                if (this.row < this.rows.length - 1) {
                    this.row++;
                } else {
                    this.onButtons = true;
                }
                break;
            case KEY.OK:
                this.press(this.rows[this.row]);
                return;
            case KEY.LEFT:
            case KEY.BACK:
                this.onColumn = false;
                break;
        }
        this.mark();
    }

    /** A key while the description or Remix shows: Back (or Left) closes it; OK on the description reads it all */
    private openedKey(code: number): void {
        var reel = this.reel();
        if (code === KEY.OK && this.opened === 'about' && reel && reel.description) {
            this.panel().open(reel.title, paragraphs(reel.description));
            this.mark();
        } else if (code === KEY.BACK || code === KEY.LEFT) {
            this.closeAll();
            this.mark();
        }
    }

    /** The remote's or a phone's commands the screen takes (Next, Previous, Like, Comments); false: the player's */
    act(action: string): boolean {
        if (action === 'next' || action === 'previous') {
            this.step(action === 'next' ? 1 : -1, false);
        } else if (action === 'like') {
            var reel = this.reel();
            if (!reel || !reel.like) {
                return false;
            }
            this.press('like');
        } else if (action === 'comments') {
            if (this.commentsOpen) {
                (this.commentsMade as CommentsView).close();
            } else {
                this.press('comments');
            }
        } else {
            return false;
        }
        return true;
    }

    /** The previous (by -1) or next Short: what is open closed, the column slides; it is drawn and the Short started
     * after the frame (a held key's repeats, key and not a press of its own: once they stop, the column not sliding); at
     * the end, the sequence's next part is waited for (asked anew); before the first, the video the Shorts came from (a
     * press of its own only: a held Up stays); stay: the focus kept where it is (a Short that ended: no key moved it) */
    step(by: number, key: boolean, stay?: boolean): void {
        var press = !key || ownPress();
        var to = this.at + by;
        if (to < 0) {
            if (press) {
                this.host.back();
            }
            return;
        }
        if (to >= this.list.length) {
            // (Down on the last: the part waited for, a loading sign meanwhile, then on by itself; a series given up asked
            // anew)
            if (by > 0) {
                this.tries = 0;
                this.spent = false;
                this.wait(true);
                this.more();
            }
            return;
        }
        this.closeAll();
        if (!stay) {
            this.onColumn = false;
        }
        this.wait(false);
        if (this.host.controlsShown()) {
            this.host.hideControls();
        }
        this.at = to;
        this.way = by;
        this.progressTo(0);
        if (by > 0 && !this.hinted) {
            this.hinted = true;
            setShown(this.hint, false);
        }
        if (press) {
            this.slideColumn(by > 0 ? 'up' : 'down');
        }
        this.mark();
        this.playSoon(press);
        // (also from a held key's repeats, which start nothing: near the end, more on its way)
        this.more();
    }

    /** The Short id began to move: the next one the way of travel loaded ahead with its overlay, the sequence asked if
     * near its end */
    moved(id: string): void {
        var short = this.current;
        if (!short || short.id !== id) {
            return;
        }
        var next = this.list[this.at + this.way];
        if (next) {
            this.host.ahead(next);
            this.ask(next);
        }
        this.more();
    }

    /** The Short played to its end without looping: the next one, if one is listed (true); false: it plays again (the
     * last, asking nothing: the next part is asked as Down is pressed there; also while something is open in the
     * column's place: what it shows stays the Short's) */
    ended(): boolean {
        if (this.anyOpen() || this.at + 1 >= this.list.length) {
            return false;
        }
        this.step(1, false, true);
        return true;
    }

    // ---- what shows

    /** The column's texts slide out (dir: 'up', as Down; 'down'), are drawn anew once out of sight (COLUMN_MS) and slide
     * back in: each half its layer moved whole, its texts drawn once between them */
    private slideColumn(dir: string): void {
        this.columnWay = dir;
        setClass(this.column, COLUMN_CLASSES['out-' + dir]);
        clearTimeout(this.columnTimer);
        this.columnTimer = setTimeout(this.swap, COLUMN_MS) as unknown as number;
    }

    /** The Short shown drawn (where its column does not slide) and started: after the key's frame for a press of its own
     * (press), once the keys rest for a held key's repeats (each would draw and start one) */
    private playSoon(press: boolean): void {
        clearTimeout(this.playTimer);
        this.playWanted = true;
        if (press) {
            requestAnimationFrame(this.afterFrame);
        } else {
            this.playTimer = setTimeout(this.go, SLIDE_MS) as unknown as number;
        }
    }

    /** Short's overlay asked for (kept: at once), and drawn if it is the one shown */
    private ask(short: Video): void {
        if (this.reels[short.id]) {
            return;
        }
        var gen = this.gen;
        var self = this;
        this.asks.item(short.id).then(function (reel) {
            if (gen === self.gen) {
                self.got(reel);
            }
        }, function () { return undefined; });
    }

    /** An overlay came: kept, its loop told and drawn if its Short shows (where its column slides, the swap draws it) */
    private got(reel: Reel): void {
        this.reels[reel.id] = reel;
        this.prune();
        var short = this.current;
        if (short && short.id === reel.id) {
            this.host.setLoop(reel.id, reel.loop);
            if (!this.columnTimer) {
                this.draw();
            }
        }
    }

    /** Lets go of overlays far from the one shown */
    private prune(): void {
        var ids = Object.keys(this.reels);
        if (ids.length <= KEPT) {
            return;
        }
        var near: { [id: string]: boolean } = {};
        for (var i = Math.max(0, this.at - 2); i < Math.min(this.list.length, this.at + 3); i++) {
            near[this.list[i].id] = true;
        }
        for (var j = 0; j < ids.length; j++) {
            if (!near[ids[j]]) {
                delete this.reels[ids[j]];
            }
        }
    }

    /** The sequence's next part, once few Shorts are left after the one shown (one part at a time, after the first
     * Short's overlay where there is no token to ask with yet; one coming while the screen is hidden is dropped; none once
     * the tries of this end are spent, until Down there asks anew). With no token (none given, or a sequence that ended), YouTube's own sequence (the sidebar's:
     * its pick, then the Shorts after it). One that brings nothing new is asked again (retry) */
    private more(): void {
        if (this.asking || this.first && !this.token || this.spent || this.list.length - 1 - this.at > AHEAD) {
            return;
        }
        clearTimeout(this.retryTimer);
        this.asking = true;
        var gen = this.gen;
        var self = this;
        var asked = this.token ? this.asks.sequence(this.token) : this.asks.item('').then(function (reel): Sequence {
            if (gen === self.gen && reel.id) {
                self.reels[reel.id] = reel;
            }
            return { shorts: reel.id ? [shortOfReel(reel)] : [], next: reel.next };
        });
        asked.then(function (part) {
            if (gen !== self.gen) {
                return;
            }
            self.asking = false;
            if (!self.shown) {
                return;
            }
            self.token = part.next;
            var have: { [id: string]: boolean } = {};
            self.list.forEach(function (s) { have[s.id] = true; });
            var added = part.shorts.filter(function (s) { return !have[s.id]; });
            self.list = self.list.concat(added);
            if (!added.length) {
                self.retry();
                return;
            }
            self.tries = 0;
            self.spent = false;
            if (self.waiting) {
                self.wait(false);
                self.step(1, false);
            } else {
                // (still near the end: the next part, one at a time)
                self.more();
            }
        }, function () {
            if (gen === self.gen) {
                // (the same token asked again)
                self.asking = false;
                self.retry();
            }
        });
    }

    /** A part brought nothing new: asked again after the next of RETRY_MS, while the end is near and the screen shows; past
     * the last pause, given up (spent; the loading sign goes) until Down on the last Short asks anew */
    private retry(): void {
        var self = this;
        if (!this.shown || this.list.length - 1 - this.at > AHEAD || this.tries >= RETRY_MS.length) {
            this.spent = this.tries >= RETRY_MS.length;
            this.wait(false);
            return;
        }
        this.retryTimer = setTimeout(function () { self.more(); }, RETRY_MS[this.tries++]) as unknown as number;
    }

    /** Down waits on the last Short for more (on), the player's loading sign in the box meanwhile, or no longer */
    private wait(on: boolean): void {
        if (on !== this.waiting) {
            this.waiting = on;
            this.host.waiting(on);
        }
    }

    /** The Short shown's overlay (null: not come yet) */
    private reel(): Reel | null {
        var short = this.current;
        return short && this.reels[short.id] || null;
    }

    /** Whether the Short shown has button or row id */
    private has(id: string): boolean {
        var reel = this.reel();
        switch (id) {
            case 'link': return !!reel && !!reel.link;
            case 'subscribe': return !!reel && !!reel.subscribe;
            case 'like': return !!reel && !!reel.like;
            case 'comments': return !!reel && !!reel.comments;
            case 'remix': return !!reel && !!reel.remix;
        }
        return true;
    }

    /** The column as the Short shown has it: what its overlay says (until it comes, what its tile said) */
    private draw(): void {
        var short = this.current;
        var reel = this.reel();
        var was = this.focusedName();
        setText(this.title, reel && reel.title || short && short.title || '');
        var age = reel ? reel.age : '';
        setText(this.age, age);
        display(this.age, !!age);
        setText(this.linkText, reel && reel.link ? reel.link.title : '');
        setSrc(this.avatar, reel ? reel.avatar : '');
        setText(this.handle, reel && reel.handle || short && short.channel || '');
        var sub = reel && reel.subscribe;
        if (sub) {
            drawSubscribe(this.rowEls.subscribe, this.subLabel, sub, 'by-shorts-subscribe--on');
            setIcon(this.subIcon, subscribed(sub) ? 'bell' : 'add');
        }
        var like = reel && reel.like;
        if (like) {
            setIcon(this.likeIcon, like.status === 'LIKE' ? 'hearted' : 'heart');
            setText(this.likeCount, like.counts[like.status] || '');
        }
        setText(this.commentCount, reel ? reel.commentCount : '');
        setText(this.remixCount, reel && reel.remix ? reel.remix.title : '');
        // (the rows the Short has, in the list kept: no new one per draw)
        this.rows.length = 0;
        for (var i = 0; i < ROWS.length; i++) {
            var has = this.has(ROWS[i]);
            display(this.rowEls[ROWS[i]], has);
            if (has) {
                this.rows.push(ROWS[i]);
            }
        }
        this.pills.draw();
        // (the focus kept on what it was on, where the Short has it)
        if (was && !this.onButtons) {
            var row = this.rows.indexOf(was);
            this.row = row >= 0 ? row : Math.min(this.row, this.rows.length - 1);
        } else if (was && !this.has(BUTTONS[this.pills.at]) && !this.pills.move(1)) {
            this.pills.move(-1);
        }
        this.mark();
    }

    /** What has the focus in the column ('' the video, or something open in its place) */
    private focusedName(): string {
        return !this.onColumn || this.anyOpen() ? '' : this.onButtons ? BUTTONS[this.pills.at] : this.rows[this.row] || '';
    }

    /** Something shows in the column's place (the description, Remix, the comments, the panel) */
    private anyOpen(): boolean {
        return !!this.opened || this.commentsOpen || !!this.panelMade && this.panelMade.shown;
    }

    /** The focus drawn: the focused row marked (only it and the one before) or the buttons' row's focus, the column's
     * boxes or the video's ring */
    private mark(): void {
        var open = this.anyOpen();
        var name = this.focusedName();
        var focused = name && !this.onButtons ? this.rowEls[name] : null;
        if (focused !== this.marked) {
            if (this.marked) {
                toggleClass(this.marked, 'by-shorts-item--focused', false);
            }
            if (focused) {
                toggleClass(focused, 'by-shorts-item--focused', true);
            }
            this.marked = focused;
        }
        this.pills.setFocused(!!name && this.onButtons);
        // (the highlight's ring round the video while it has the focus)
        toggleClass(this.ring, 'by-shorts-ring--focused', !this.onColumn && !open);
        toggleClass(this.el, 'by-shorts--column', this.onColumn || open);
        toggleClass(this.el, 'by-shorts--opened', open);
    }

    // ---- the column's actions

    private press(what: string): void {
        var reel = this.reel();
        var short = this.current;
        var self = this;
        if (!short) {
            return;
        }
        if (what === 'more') {
            this.openMore(short, reel);
        } else if (!reel) {
            return;
        } else if (what === 'title') {
            this.openAbout(reel);
        } else if (what === 'link' && reel.link) {
            this.host.watch({ id: reel.link.id, title: reel.link.title, channel: reel.handle, length: '', info: '' });
        } else if (what === 'channel' && reel.channelPage) {
            this.host.channel(reel.channelPage);
        } else if (what === 'subscribe' && reel.subscribe) {
            pressSubscribe(reel.subscribe, reel.handle, this.panel(), function () { self.draw(); });
            this.mark();
        } else if (what === 'like' && reel.like) {
            var like = reel.like;
            var to = like.status === 'LIKE' ? 'INDIFFERENT' : 'LIKE';
            if (like.commands[to]) {
                apply(like, 'status', to, like.commands[to], function () { self.draw(); }, tr('YouTube did not take that.'));
            }
        } else if (what === 'comments' && reel.comments) {
            this.openComments(short, reel);
        } else if (what === 'remix' && reel.remix) {
            this.openRemix(short, reel);
        }
    }

    /** Built on first use: the side panel (More, Subscribed's bell, Save to, the full description) */
    private panel(): SidePanel {
        return this.panelMade || (this.panelMade = new SidePanel(this.el));
    }

    private openMore(short: Video, reel: Reel | null): void {
        var self = this;
        var panel = this.panel();
        var not = reel && reel.notInterested;
        panel.open(tr('More'), function (): PanelLine[] {
            var lines: PanelLine[] = [
                { label: tr('Save to playlist'), stay: true, action: function () { openSaveTo(panel, short.id, true); } },
                { label: tr('Subtitles'), under: self.host.captionName(), stay: true, action: function () { self.host.captions(panel); } }
            ];
            if (not) {
                var command = not.command;
                lines.push({ label: not.title, action: function () {
                    // (YouTube takes the Short away: the next one plays; YouTube's own words for it, as a tile's menu says)
                    var said = toastOf(command);
                    run(command).then(function () {
                        toast(said || tr('Done: YouTube will show fewer like this'), 'check');
                    }, function () { toast(tr('YouTube did not take that.'), undefined, PROBLEM); });
                    self.step(1, false);
                } });
            }
            lines.push({ label: tr('Stats for nerds'), chosen: self.host.statsShown(), stay: true, action: function () {
                self.host.stats();
                panel.refresh();
            } });
            return lines;
        });
        this.mark();
    }

    private openAbout(reel: Reel): void {
        var a = this.about;
        if (!a) {
            var el = this.el.appendChild(h('div', 'by-shorts-about')) as HTMLElement;
            var title = el.appendChild(h('div', 'by-shorts-about-title')) as HTMLElement;
            var facts = el.appendChild(h('div', 'by-shorts-facts')) as HTMLElement;
            var box = el.appendChild(h('div', 'by-shorts-about-box by-shorts-item--focused')) as HTMLElement;
            box.appendChild(h('div', 'by-shorts-about-label', tr('Description')));
            var text = box.appendChild(h('div', 'by-shorts-about-text')) as HTMLElement;
            a = this.about = { el: el, title: title, facts: facts, box: box, text: text };
        }
        setText(a.title, reel.title);
        a.facts.innerHTML = '';
        reel.facts.forEach(function (f) {
            var one = a!.facts.appendChild(h('div', 'by-shorts-fact')) as HTMLElement;
            one.appendChild(h('div', 'by-shorts-fact-value', f.value));
            one.appendChild(h('div', 'by-shorts-fact-label', f.label));
        });
        setText(a.text, reel.description);
        display(a.box, !!reel.description);
        this.showOpened('about', a.el);
    }

    private openRemix(short: Video, reel: Reel): void {
        var r = this.remix;
        if (!r) {
            var el = this.el.appendChild(h('div', 'by-shorts-remix')) as HTMLElement;
            var qr = el.appendChild(h('canvas', 'by-shorts-qr')) as HTMLCanvasElement;
            r = this.remix = { el: el, qr: qr, title: el.appendChild(h('div', 'by-shorts-remix-title')) as HTMLElement,
                under: el.appendChild(h('div', 'by-shorts-remix-under')) as HTMLElement, link: el.appendChild(h('div', 'by-shorts-remix-link')) as HTMLElement };
        }
        var lines = reel.remix ? reel.remix.lines : [];
        var link = 'youtube.com/shorts/' + short.id;
        setText(r.title, lines[0] || tr('Remix on your phone'));
        setText(r.under, lines[1] || tr('Scan QR code or go to'));
        setText(r.link, link);
        drawQr(r.qr, 'https://' + link, QR_SIZE).then(null, function () { return undefined; });
        this.showOpened('remix', r.el);
    }

    private openComments(short: Video, reel: Reel): void {
        var self = this;
        var view = this.commentsMade;
        if (!view) {
            view = this.commentsMade = new CommentsView(this.el);
            view.onClose = function () {
                self.host.comments(null);
                self.mark();
            };
        }
        view.open(reel.comments, reel.commentCount, undefined, reel.commentsVia);
        this.host.comments(short.id);
        this.mark();
    }

    /** el shows in the column's place (what: its name) */
    private showOpened(what: string, el: HTMLElement): void {
        this.closeAll();
        this.opened = what;
        display(el, true);
        this.mark();
    }

    /** What shows in the column's place closed (the description, Remix, the comments, the panel): the column again */
    private closeAll(): void {
        if (this.about) {
            display(this.about.el, false);
        }
        if (this.remix) {
            display(this.remix.el, false);
        }
        if (this.commentsMade && this.commentsMade.shown) {
            this.commentsMade.close();
        }
        if (this.panelMade) {
            this.panelMade.close();
        }
        this.opened = '';
    }
}

/** Takes el out of the layout (or puts it back): written only when it changes */
function display(el: HTMLElement, on: boolean): void {
    var to = on ? '' : 'none';
    if (el.style.display !== to) {
        el.style.display = to;
    }
}
