// Comments over the video, as YouTube's TV player shows them: a floating panel
// at the right with "Comments" and their count, "Comment as …" (YouTube takes
// comments on the phone, not on the TV), then each comment as a card
// (picture, author and age, a pin on the pinned one, the text cut after five
// lines, likes and replies). OK on a comment opens its Replies over the dimmed
// video: the comment in full with Like, Dislike and Report, "Reply as …",
// then the replies as cards (each opening its own). Back goes back a view,
// then closes. Parts are fetched as the focus nears a list's end. A click (the
// Magic Remote's pointer) is OK on the card or button under it; beside the
// panel it is Back.

import { h, setShown, setSrc, setText, toggleClass, translate } from '../core/dom.js';
import { tr } from '../core/i18n.js';
import { KEY } from '../core/keys.js';
import { holding, takesPointer } from '../core/pointer.js';
import { dots } from '../api/feed.js';
import { Comment, Comments, comments, run, Toggle } from '../api/watch.js';
import { icon, setIcon } from '../ui/icons.js';
import { PROBLEM, toast } from '../ui/toast.js';

/** More are fetched once the focus is this near a list's end */
var AHEAD = 4;
/** Space kept above and below the focused card as the list scrolls (px) */
var MARGIN = 12;
/** YouTube's steps for commenting from the phone (its TV app shows them on "Use your phone") */
var STEPS = ['1   ' + tr('Open the YouTube app on a mobile device'), '2   ' + tr('Connect to the same account as this TV'),
    tr('Need any help? Make sure that both devices are signed in to the same account, then restart the YouTube mobile app.')];

interface Item {
    el: HTMLElement;
    kind: 'handoff' | 'comment' | 'focal' | 'note';
    comment?: Comment;
    /** The focal comment's buttons (Like, Dislike, Report) and the focused one */
    buttons?: HTMLElement[];
    button?: number;
}

/** One view: the comments of a video, or a comment's Replies */
interface Level {
    title: string;
    count: string;
    list: HTMLElement;
    items: Item[];
    at: number;
    /** The card marked focused (null: none) */
    marked: Item | null;
    scroll: number;
    next: string;
    fetching: boolean;
}

export class CommentsView {
    el: HTMLElement;
    private panel: HTMLElement;
    private title: HTMLElement;
    private count: HTMLElement;
    private body: HTMLElement;
    private levels: Level[] = [];
    /** Incremented on each open and close, so late parts for another video are dropped */
    private gen = 0;
    /** Called once closed (Back from the comments) */
    onClose: () => void = function () { return undefined; };

    constructor(parent: HTMLElement) {
        this.el = h('div', 'by-comments');
        this.el.appendChild(h('div', 'by-comments-dim'));
        this.panel = h('div', 'by-comments-panel');
        var head = h('div', 'by-comments-head');
        this.title = h('span', 'by-comments-title');
        this.count = h('span', 'by-comments-count');
        head.appendChild(this.title);
        head.appendChild(this.count);
        this.panel.appendChild(head);
        this.body = h('div', 'by-comments-body');
        this.panel.appendChild(this.body);
        this.el.appendChild(this.panel);
        setShown(this.el, false);
        parent.appendChild(this.el);
        var self = this;
        takesPointer(this.panel, function (target) {
            var level = self.levels[self.levels.length - 1];
            var i = level ? holding(level.items, target) : -1;
            var item = i >= 0 ? level.items[i] : null;
            // (the comment replied to: only its buttons, not its text: OK there would vote)
            var button = item && item.buttons ? holding(item.buttons.map(function (b) { return { el: b }; }), target) : -1;
            if (!item || item.buttons && button < 0) {
                return null;
            }
            if (item.buttons) {
                item.button = button;
            }
            self.focus(level, i);
            return {};
        });
    }

    get shown(): boolean {
        return this.levels.length > 0;
    }

    /** The panel while open (null: closed): the pointer's layer, a click beside it is Back (core/pointer.ts) */
    layer(): HTMLElement | null {
        return this.shown ? this.panel : null;
    }

    /** Opens a video's comments (count: as YouTube shows it); first: their first part, if already fetched */
    open(token: string, count: string, first?: Promise<Comments>): void {
        this.clear();
        setShown(this.el, true);
        this.push(tr('Comments'), count, token, first);
    }

    close(): void {
        var was = this.shown;
        this.clear();
        setShown(this.el, false);
        if (was) {
            this.onClose();
        }
    }

    onKey(code: number): void {
        var level = this.levels[this.levels.length - 1];
        if (!level) {
            return;
        }
        var item = level.items[level.at];
        switch (code) {
            case KEY.UP:
            case KEY.DOWN:
                this.focus(level, level.at + (code === KEY.UP ? -1 : 1));
                break;
            case KEY.LEFT:
            case KEY.RIGHT:
                if (item && item.buttons) {
                    item.button = Math.max(0, Math.min(item.buttons.length - 1, (item.button || 0) + (code === KEY.LEFT ? -1 : 1)));
                    this.mark(level);
                }
                break;
            case KEY.OK:
                this.press(level, item);
                break;
            case KEY.BACK:
                this.back();
                break;
        }
    }

    // ---- views

    private clear(): void {
        this.gen++;
        this.levels = [];
        this.body.innerHTML = '';
        toggleClass(this.el, 'by-comments--replies', false);
    }

    /** Shows a new view on top (the one under it kept for Back), fetching its first part (or with items of its own) */
    private push(title: string, count: string, token: string, first?: Promise<Comments>, items?: Item[]): void {
        var under = this.levels[this.levels.length - 1];
        if (under) {
            setShown(under.list, false);
        }
        var level: Level = { title: title, count: count, list: h('div', 'by-comments-list'), items: [], at: 0, marked: null, scroll: 0, next: token, fetching: false };
        this.body.appendChild(level.list);
        this.levels.push(level);
        this.heading(level);
        toggleClass(this.el, 'by-comments--replies', this.levels.length > 1);
        if (items) {
            this.add(level, items);
            return;
        }
        this.add(level, [this.note(tr('Loading comments …'))]);
        this.more(level, first);
    }

    private back(): void {
        if (this.levels.length < 2) {
            this.close();
            return;
        }
        var level = this.levels.pop() as Level;
        this.body.removeChild(level.list);
        var under = this.levels[this.levels.length - 1];
        setShown(under.list, true);
        this.heading(under);
        toggleClass(this.el, 'by-comments--replies', this.levels.length > 1);
    }

    private heading(level: Level): void {
        setText(this.title, level.title);
        setText(this.count, level.count);
    }

    // ---- parts

    /** Fetches the view's next part when its focus nears the end (first: the first part, replacing "Loading") */
    private more(level: Level, first?: Promise<Comments>): void {
        var token = level.next;
        var starting = level.items.length === 1 && level.items[0].kind === 'note';
        if (!token || level.fetching || !starting && level.at < level.items.length - 1 - AHEAD) {
            return;
        }
        level.fetching = true;
        var gen = this.gen;
        var self = this;
        (first || comments(token)).then(function (part) {
            level.fetching = false;
            if (gen !== self.gen || self.levels.indexOf(level) < 0) {
                return;
            }
            level.next = part.next;
            var items: Item[] = [];
            if (part.focal) {
                items.push(self.focal(part.focal));
            }
            if (part.handoff) {
                items.push(self.handoff(part.handoff.text, part.handoff.avatar));
            }
            part.list.forEach(function (c) {
                items.push(self.card(c));
            });
            if (starting) {
                level.list.innerHTML = '';
                level.items = [];
                level.at = 0;
                if (!items.length) {
                    items.push(self.note(level === self.levels[0] ? tr('No comments yet.') : tr('No replies yet.')));
                }
            }
            self.add(level, items);
        }, function () {
            level.fetching = false;
            if (gen === self.gen && starting && self.levels.indexOf(level) >= 0) {
                level.list.innerHTML = '';
                level.items = [];
                self.add(level, [self.note(tr('Could not load the comments.'))]);
            }
        });
    }

    private add(level: Level, items: Item[]): void {
        items.forEach(function (item) {
            level.list.appendChild(item.el);
            level.items.push(item);
        });
        this.mark(level);
    }

    // ---- focus

    private focus(level: Level, at: number): void {
        level.at = Math.max(0, Math.min(level.items.length - 1, at));
        this.mark(level);
        this.more(level);
    }

    /** Marks the focused card (or the focal comment's button), only it and the one marked before, and scrolls the
     * list to keep it in view */
    private mark(level: Level): void {
        var was = level.marked;
        var focused = level.items[level.at];
        if (was && was !== focused) {
            markItem(was, false);
        }
        if (focused) {
            markItem(focused, true);
        }
        level.marked = focused || null;
        if (!focused || this.levels[this.levels.length - 1] !== level) {
            return;
        }
        var room = this.body.clientHeight;
        var top = focused.el.offsetTop;
        var bottom = top + focused.el.offsetHeight;
        if (top - MARGIN < level.scroll) {
            level.scroll = Math.max(0, top - MARGIN);
        } else if (bottom + MARGIN > level.scroll + room) {
            level.scroll = bottom + MARGIN - room;
        }
        translate(level.list, 0, -level.scroll);
    }

    // ---- actions

    private press(level: Level, item: Item | undefined): void {
        if (!item) {
            return;
        }
        if (item.kind === 'handoff') {
            var self = this;
            // The phone's YouTube app offers the comment box meanwhile (cast.ts: YouTube's hand-off)
            this.push(tr('To add comments and replies'), '', '', undefined, STEPS.map(function (step) { return self.note(step); }));
        } else if (item.kind === 'comment' && item.comment && item.comment.detail) {
            this.push(tr('Replies'), '', item.comment.detail);
        } else if (item.kind === 'focal' && item.comment && item.buttons) {
            var c = item.comment;
            if (item.button === 2 || !c.vote) {
                toast(tr('Report comments in YouTube\'s app on your phone'), 'info');
            } else {
                this.vote(item, c, item.button === 0 ? c.vote.like : c.vote.dislike, item.button === 0 ? c.vote.dislike : c.vote.like);
            }
        }
    }

    /** Turns a comment's Like or Dislike on or off as YouTube's TV app does (the other one goes off) */
    private vote(item: Item, c: Comment, toggle: Toggle, other: Toggle): void {
        var self = this;
        var otherWas = other.on;
        var on = !toggle.on;
        // Drawn at once, so a second press undoes it (it waited for YouTube, so two quick presses both turned it on);
        // as it was if YouTube refuses
        toggle.on = on;
        if (on) {
            other.on = false;
        }
        this.drawVote(item, c);
        run(on ? toggle.set : toggle.unset).then(null, function () {
            if (toggle.on === on) {
                toggle.on = !on;
                other.on = otherWas;
                self.drawVote(item, c);
            }
            toast(tr('YouTube did not take that. Try again.'), undefined, PROBLEM);
        });
    }

    private drawVote(item: Item, c: Comment): void {
        if (item.buttons && c.vote) {
            setIcon(item.buttons[0], c.vote.like.on ? 'liked' : 'like');
            setIcon(item.buttons[1], c.vote.dislike.on ? 'disliked' : 'dislike');
        }
    }

    // ---- cards

    private handoff(text: string, avatar: string): Item {
        var el = h('div', 'by-comment by-comment--handoff');
        var pic = h('img', 'by-comment-avatar') as HTMLImageElement;
        setSrc(pic, avatar);
        el.appendChild(pic);
        el.appendChild(h('div', 'by-comment-handoff', text));
        el.appendChild(icon('comments', 'by-comment-handoff-icon'));
        return { el: el, kind: 'handoff' };
    }

    private card(c: Comment): Item {
        var el = h('div', 'by-comment');
        this.head(el, c);
        el.appendChild(h('div', 'by-comment-text', c.text));
        var counts = h('div', 'by-comment-counts');
        if (c.likes) {
            counts.appendChild(icon('liked', 'by-comment-count-icon'));
            counts.appendChild(h('span', 'by-comment-count', c.likes));
        }
        if (c.replies) {
            counts.appendChild(icon('comments', 'by-comment-count-icon'));
            counts.appendChild(h('span', 'by-comment-count', String(c.replies)));
        }
        el.appendChild(counts);
        return { el: el, kind: 'comment', comment: c };
    }

    /** The comment replied to: in full, with its buttons (the focus on Like, as YouTube's) */
    private focal(c: Comment): Item {
        var el = h('div', 'by-comment by-comment--focal');
        this.head(el, c);
        el.appendChild(h('div', 'by-comment-text', c.text));
        var row = h('div', 'by-comment-buttons');
        var buttons = ['like', 'dislike', 'flag'].map(function (name) {
            return row.appendChild(icon(name, 'by-comment-button')) as HTMLElement;
        });
        el.appendChild(row);
        var item: Item = { el: el, kind: 'focal', comment: c, buttons: buttons, button: 0 };
        this.drawVote(item, c);
        return item;
    }

    private head(el: HTMLElement, c: Comment): void {
        var head = h('div', 'by-comment-head');
        var pic = h('img', 'by-comment-avatar') as HTMLImageElement;
        setSrc(pic, c.avatar);
        head.appendChild(pic);
        head.appendChild(h('div', 'by-comment-by', dots([c.author, c.age])));
        if (c.pinned) {
            head.appendChild(icon('pin', 'by-comment-pin'));
        }
        el.appendChild(head);
    }

    private note(text: string): Item {
        return { el: h('div', 'by-comments-note', text), kind: 'note' };
    }
}

/** A card marked focused or not (one with buttons: its chosen button) */
function markItem(item: Item, on: boolean): void {
    toggleClass(item.el, 'by-comment--focused', on && !item.buttons && item.kind !== 'note');
    (item.buttons || []).forEach(function (b, j) {
        toggleClass(b, 'by-comment-button--focused', on && j === item.button);
    });
}
