// Subscriptions screen. Its videos are YouTube's list as its TV app shows it (views/videos.ts FeedView, Shelf.feed):
// YouTube's first shelf ("Most relevant") a row, everything after it one grid in YouTube's order. Its channels show
// where the theme has them or Settings › Look says (ui/theme.ts subsLayout; another choice takes effect when the
// screen shows next, with the rows and channels it has: nothing is asked for):
//  - at the side, as YouTube's TV app: a column (views/channel-column.ts) of "All", YouTube's first-listed channels
//    and every channel A-Z, the focused item's videos beside it: "All" the list above, a channel its newest videos
//    as a grid. A channel's are asked for as the focus comes to rest on it (right after a press of its own, never
//    for a held key's repeats), which is also what takes YouTube's mark of new videos from it (api/looked.ts), and
//    are kept a while where the app keeps its pages (api/feed.ts keptPage).
//    Right or OK goes into the videos: the column goes, a heading says whose they are, over a channel's "Visit
//    channel" (its page: main.ts openSubChannel; Up from the first line). Left or Back returns to the column.
//  - at the top, as YouTube's phone app: a row of round channel pictures (YouTube's first-listed channels, then others
//    with new videos; "All" at the end lists every channel A-Z), filter pills below (All, Today, Videos, Live:
//    filtered locally, no new request; a filtered pill shows a grid in the list's order). OK on a channel opens its
//    page. Up from the first row focuses the pills, then the channels; further down the header slides away.
// A channel with new videos has a dot until it is looked at: its list asked for, its page opened or its newest video
// started (api/looked.ts). The places come from the theme (metrics.subs, subscriptionsTop), the look from
// themes/<id>.css (by-subs).

import { h, releaseImages, restoreImages, setShown, setSrc, setText, standsBy, toggleClass, translate } from '../core/dom.js';
import { tr } from '../core/i18n.js';
import { KEY, ownPress } from '../core/keys.js';
import { takesPointer, toPart } from '../core/pointer.js';
import { View } from '../core/view.js';
import { allVideos, keptPage, listNext, pageKept, Rows, Shelf, SubChannel, Video, withinADay } from '../api/feed.js';
import { channelKey, forgetLooks, looked, settle } from '../api/looked.js';
import { prefs } from '../api/prefs.js';
import { Pills } from '../ui/pills.js';
import { metrics, subsLayout } from '../ui/theme.js';
import { ROOM_ABOVE } from '../ui/tile-row.js';
import { ChannelColumn } from './channel-column.js';
import { copied, watchedAt } from './tiles.js';
import { FeedHost, FeedLines, FeedOptions, FeedTexts, FeedView } from './videos.js';

/** Focus resting this long on a channel of the row at the top prefetches its page. YouTube's reply takes 0.7-1 s, so a
 * longer delay leaves a quick OK waiting; the reply is parsed off the main thread (api/off-thread.ts) */
var REST_MS = 300;
/** The column's focus moved to "All": its videos, which stood by, come back right after the frame that moves the
 * highlight (in that frame, the highlight would wait for their tiles to be drawn) */
var READY_MS = 40;
/** To a channel: its videos show after this rest (its list kept from before, on its way, or asked for then), longer
 * than a held key's repeats are apart (~0.12 s), so a walk along the column with the key held draws none and asks
 * for none (drawing a grid takes the TV ~0.3 s) */
var LIST_REST_MS = 150;
/** A channel's list seen this long ago is asked for again behind the one shown, which is drawn anew only where
 * YouTube's differs from it */
var LIST_FRESH_MS = 5 * 60000;
/** The channels' lists kept as they were last seen, to be in sight at once when a channel is come back to */
var KNOWN = 80;
/** A step that is a press of its own (core/keys.ts ownPress: the key let go since, so not a held key's repeat, the first
 * of which comes well after the press) and this long after the step before: the channel's list is asked for right
 * after the frame that moves the highlight (READY_MS), so it is on its way while the focus rests */
var OWN_STEP_MS = 250;
/** The lists drawn stay drawn, out of sight without their pictures, to show again with nothing to build: the VIEWS
 * shown last */
var VIEWS = 5;
/** "All"'s videos stand by with their pictures this long under a channel's list (Up to "All" shows them at once),
 * then let them go */
var FEED_STAND_MS = 20000;
/** Most channels in the row (YouTube's first-listed ones, then others with new videos) */
var ROW_MAX = 30;
/** Rows older than this do not say which video is a channel's newest (a newer one may be missing from them) */
var NEWEST_MS = 60 * 60 * 1000;
/** The pills and the filter each applies to the rows */
var PILLS: { label: string; keep: ((v: Video) => boolean) | null }[] = [
    { label: tr('All'), keep: null },
    { label: tr('Today'), keep: function (v) { return !!v.live || !v.upcoming && withinADay(v.info); } },
    { label: tr('Videos'), keep: function (v) { return !v.live; } },
    { label: tr('Live'), keep: function (v) { return !!v.live; } }
];

/** Where the focus is: the channels (the row at the top, or the column), the pills, the rows, or "Visit channel" */
type Place = 'channels' | 'pills' | 'rows' | 'visit';

export class SubscriptionsView extends FeedHost implements View {
    el: HTMLElement;
    private head: HTMLElement;
    private strip: HTMLElement;
    private rowsBox: HTMLElement;
    private channelPills = new Pills('by-subs-channel--focused');
    private pills = new Pills('by-subs-pill--focused');
    private pillEls: HTMLElement[] = [];
    /** The chosen pill */
    private pill = 0;
    /** The channels in the row, in order, each one's dot (shown while it has new videos not looked at), and the rest
     * timer for prefetching the focused one */
    private rowChannels: SubChannel[] = [];
    private dots: HTMLElement[] = [];
    private restTimer = 0;
    private at: Place = 'rows';
    private focused = true;
    /** The rows as YouTube returned them (the pills filter these), and when it was asked for them (0: kept from an
     * earlier start) */
    private all: Rows | null = null;
    /** YouTube's own row over the list as the videos drawn have it (prefs subsRelevant) */
    private relevant = prefs().subsRelevant;
    private askedAt = 0;
    /** In those rows: each channel's newest video by the channel's name, and the one channel of each name (its key;
     * '' where two share it) */
    private newest: { [channel: string]: Video } = {};
    private named: { [title: string]: string } = {};
    /** Key of the channels shown; a newer list waits until the screen is out of sight */
    private shownChannels = '';
    private waiting: SubChannel[] | null = null;
    private shown = false;
    /** Rows and channels come from the cache and are not yet confirmed to be the current account's */
    private fromKept = false;
    /** Incremented when they are dropped (account change), so earlier replies are ignored */
    private gen = 0;
    /** The channels are at the side (else in the row at the top), as drawn: the layout in force (ui/theme.ts
     * subsLayout) is taken when the screen shows */
    private side = false;
    /** Where the videos' lines stand (the feed reads it as it places them: it differs by layout), and a channel's
     * list's */
    private lines: FeedLines;
    private listLines: FeedLines;
    /** A band in the screen's colour over what has scrolled up past the videos' top */
    private band: HTMLElement;
    /** At the side (built when the screen is first laid out so): the column, the screen's name over it, the line
     * beside it; in the videos the heading (a channel's with its picture and handle) and "Visit channel" */
    private column: ChannelColumn | null = null;
    private title!: HTMLElement;
    private rule!: HTMLElement;
    private heading!: HTMLElement;
    private headingPicture!: HTMLImageElement;
    private headingName!: HTMLElement;
    private headingHandle!: HTMLElement;
    private visit!: HTMLElement;
    /** The column's channel whose videos show beside it (null: "All", the feed), and whether "Visit channel" stands
     * over them (the channel's page is known) */
    private chosen: SubChannel | null = null;
    private visitable = false;
    /** The column is in sight (the focus is in it, or was when it left the screen), the videos beside it */
    private beside = true;
    /** The view whose videos are in sight: the feed or a channel's list (null: none, the column's focus has moved
     * and its item's videos come once it rests), and the view taken out of sight for that, still as it was */
    private inSight: FeedView | null = null;
    private left: FeedView | null = null;
    /** The channels' lists drawn (or the one in sight, on its way), the one shown last at the end: each its channel's
     * key, its view, and the channel's handle as its list gave it ('' until it came) */
    private views: { key: string; view: FeedView; handle: string }[] = [];
    /** The channels' lists as they were last seen since the app started, the one seen longest ago first */
    private known: { key: string; rows: Rows }[] = [];
    /** The list left last: it stands by with its pictures (the one left before it has let them go) */
    private standing: FeedView | null = null;
    /** What the column's focus moved away from is still in sight: the chosen item's videos, drawn already, take its
     * place right after the highlight's frame (no empty moment between them) */
    private leftShown = false;
    private listTimer = 0;
    private feedTimer = 0;
    /** What those timers run, made once (a step along the column makes no function of its own): the focus has rested
     * a little on the chosen item, long enough for a list to be asked for; a press of its own asks for the list right
     * after the frame; the feed has stood by long enough */
    private rested: () => void;
    private askAhead: () => void;
    private stoodBy: () => void;
    /** The timer that asks for the chosen channel's list ahead of the rest, and when the column's focus last moved */
    private askTimer = 0;
    private steppedAt = 0;
    /** Right or OK came before the chosen channel's list: the focus goes into it as it is drawn */
    private entering = false;

    /** load: YouTube's rows (with the channels); open: OK on a tile; openChannel: a channel's page; openAll:
     * every subscribed channel; ahead: the focus rests on a channel of the row at the top; listed: YouTube was asked
     * for a channel's list in Subscriptions (the column's) and gave it, which tells it the channel was looked at */
    constructor(load: () => Promise<Rows | null>, private texts: FeedTexts, private open: (video: Video) => void, opts: FeedOptions,
        private openChannel: (c: SubChannel) => void, private openAll: (channels: SubChannel[]) => void,
        private ahead: (c: SubChannel) => void, private listed: (c: SubChannel) => void) {
        super();
        var self = this;
        var m = metrics();
        this.el = h('div', 'by-subs');
        this.rowsBox = h('div', 'by-subs-rows');
        this.el.appendChild(this.rowsBox);
        this.band = h('div', 'by-subs-top');
        this.el.appendChild(this.band);
        this.head = h('div', 'by-subs-head');
        this.strip = h('div', 'by-subs-strip');
        this.head.appendChild(this.strip);
        var pillRow = h('div', 'by-subs-pills');
        PILLS.forEach(function (p, i) {
            var el = pillRow.appendChild(self.pills.add(h('div', 'by-subs-pill', p.label), function () { self.choose(i); })) as HTMLElement;
            self.pillEls.push(el);
        });
        this.head.appendChild(pillRow);
        this.el.appendChild(this.head);
        var kept = opts.kept;
        opts.kept = kept && function () {
            var k = kept!();
            if (!k) {
                return k;
            }
            self.take(k.rows, 0);
            self.fromKept = true;
            // Another account's: drop the channels along with the rows
            var other = function (): void {
                if (self.fromKept) {
                    self.forget();
                }
            };
            return { rows: self.filtered(k.rows), same: function () {
                return k!.same().then(function (same) {
                    if (!same) {
                        other();
                    }
                    return same;
                }, function (e) {
                    other();
                    throw e;
                });
            } };
        };
        this.lines = { pitch: m.subs.pitch, head: m.subs.head, top: 0, rowTop: 0 };
        this.listLines = { pitch: m.subs.pitch, head: m.subs.head, top: m.subs.channelTop, rowTop: m.subs.channelTop };
        opts.lines = this.lines;
        this.feed = new FeedView(function () {
            var gen = self.gen;
            var asked = Date.now();
            return load().then(function (rows) {
                if (rows && gen === self.gen) {
                    self.take(rows, asked);
                }
                return rows && self.filtered(rows);
            });
        }, texts, open, opts);
        this.rowsBox.appendChild(this.feed.el);
        this.inSight = this.feed;
        this.rested = function () { self.showChosen(); };
        this.askAhead = function () {
            var c = self.chosen;
            if (c && self.shown) {
                self.asked(c);
            }
        };
        this.stoodBy = function () {
            if (self.chosen) {
                self.feed.hide();
            }
        };
        setShown(this.el, false);
        this.markPills();
        this.arrange(subsLayout() === 'side');
        // A click moves the focus to the part it is in (a channel, a pill, the rows, "Visit channel"; back after a
        // tile's); one on a channel of the column focuses it, and is OK on it
        takesPointer(this.el, function (target, under) {
            var column = self.side ? self.column : null;
            var item = column ? column.holding(target) : -1;
            if (column && item >= 0) {
                if (item !== column.at) {
                    column.focus(item);
                    self.pick();
                }
                self.go('channels');
                return {};
            }
            var part: Place = self.strip.contains(target) ? 'channels' : self.head.contains(target) ? 'pills' :
                column && self.visit.contains(target) ? 'visit' : 'rows';
            return toPart(under, function (p: Place) { self.go(p); }, self.at, part, part === 'visit');
        });
    }

    /** Builds what the channels at the side need: the screen's name, the column and the line beside it; the videos'
     * heading and "Visit channel" */
    private build(): ChannelColumn {
        this.title = this.el.appendChild(h('div', 'by-subs-title', tr('Subscriptions'))) as HTMLElement;
        var column = this.column = new ChannelColumn();
        this.el.appendChild(column.el);
        this.rule = this.el.appendChild(h('div', 'by-subs-rule')) as HTMLElement;
        this.heading = h('div', 'by-subs-heading');
        this.headingPicture = this.heading.appendChild(h('img', 'by-subs-heading-picture')) as HTMLImageElement;
        this.headingName = this.heading.appendChild(h('div', 'by-subs-heading-name')) as HTMLElement;
        this.headingHandle = this.heading.appendChild(h('div', 'by-subs-heading-handle')) as HTMLElement;
        this.el.appendChild(this.heading);
        this.visit = h('div', 'by-subs-visit', tr('Visit channel'));
        this.el.appendChild(this.visit);
        setShown(this.heading, false);
        setShown(this.visit, false);
        return column;
    }

    /** Lays the screen out with the channels at the side, or in the row at the top (as it is built, and when the
     * layout in force changed while it was out of sight). The rows and channels it has are drawn for it, and what
     * only the other layout had is let go; the focus starts in the column (as in YouTube's TV app), or in the rows */
    private arrange(side: boolean): void {
        var m = metrics();
        this.side = side;
        toggleClass(this.el, 'by-subs--side', side);
        toggleClass(this.el, 'by-subs--rows', false);
        this.lines.top = side ? m.subs.top : m.rowsTop + m.rows.head;
        this.lines.rowTop = side ? m.subs.top - m.subs.nameUp : m.rowsTop;
        // (down to where a row's box begins over its focused tiles: their ring stays clear)
        this.band.style.height = this.lines.top - ROOM_ABOVE + 'px';
        this.at = side ? 'channels' : 'rows';
        clearTimeout(this.restTimer);
        this.toAll();
        // (the videos from their first row: one further down, kept from the other layout, scrolls the row of channels
        // out of sight, and the screen looked empty above them)
        this.feed.toFirst();
        // The other layout's channels go: the row's pictures and the filter, or the column's items
        this.strip.innerHTML = '';
        this.channelPills.clear();
        this.rowChannels = [];
        this.dots = [];
        if (this.pill) {
            this.choose(0);
        }
        if (side && !this.column) {
            this.build();
        } else if (this.column) {
            this.column.set([]);
        }
        this.feed.laidOut();
        this.shownChannels = '';
        this.waiting = this.waiting || this.all && this.all.channels || null;
        this.putChannels();
        this.setFocused(this.focused);
        this.drawHeading();
        this.place();
    }

    show(rest?: boolean): void {
        this.shown = true;
        if (this.side !== (subsLayout() === 'side')) {
            this.arrange(!this.side);
        }
        // YouTube's own row turned on or off in Settings since the videos were drawn: drawn anew from the rows here
        if (this.relevant !== prefs().subsRelevant) {
            this.relevant = prefs().subsRelevant;
            if (this.all) {
                this.feed.showRows(this.filtered(this.all));
            }
        }
        standsBy(this.el, false);
        setShown(this.el, true);
        if (this.side) {
            (this.column as ChannelColumn).setShown(true);
        } else {
            restoreImages(this.strip);
        }
        if (this.inSight) {
            this.inSight.show(rest);
        } else {
            // (the column's focus moved, then the screen went out of sight before its item's videos came)
            this.showSoon();
        }
    }

    /** Hidden: the channels' pictures are let go too (the rows let go of theirs) */
    hide(): void {
        this.shown = false;
        clearTimeout(this.listTimer);
        clearTimeout(this.askTimer);
        clearTimeout(this.feedTimer);
        standsBy(this.el, false);
        setShown(this.el, false);
        this.feed.hide();
        if (this.inSight && this.inSight !== this.feed && !this.letGo(this.inSight)) {
            this.inSight = null;
        }
        if (this.left && this.left !== this.feed) {
            this.letGo(this.left);
        }
        this.left = null;
        this.leftShown = false;
        if (this.standing) {
            this.standing.hide();
            this.standing = null;
        }
        this.putChannels();
        releaseImages(this.strip);
        if (this.column) {
            this.column.setShown(false);
        }
    }

    /** Out of sight but kept drawn, the channels' pictures too (false: the feed has no rows yet, hidden). What is in
     * sight is kept: the feed, or a channel's list with its rows (one that is empty, failed or still on its way
     * stays as it is: the column is drawn all the same). What is not in sight is left as it is: the feed under a
     * channel's list (standing by, or hidden by then), and whatever the column's focus has just moved away from */
    standBy(): boolean {
        var view = this.inSight;
        if (view === this.feed ? !this.feed.keep() : !this.feed.hasRows) {
            this.hide();
            return false;
        }
        if (view && view !== this.feed && view.hasRows) {
            view.keep();
        }
        this.shown = false;
        clearTimeout(this.listTimer);
        clearTimeout(this.askTimer);
        setShown(this.el, true);
        if (this.side) {
            (this.column as ChannelColumn).setShown(true);
        } else {
            restoreImages(this.strip);
        }
        this.putChannels();
        standsBy(this.el, true);
        return true;
    }

    cover(covered: boolean): void {
        this.feed.cover(covered);
        if (covered) {
            this.putChannels();
        }
    }

    putFresh(): void {
        this.feed.putFresh();
        this.putChannels();
    }

    /** Also on the tiles of the channels' lists drawn */
    setProgress(id: string, progress: number): void {
        this.feed.setProgress(id, progress);
        for (var i = 0; i < this.views.length; i++) {
            this.views[i].view.setProgress(id, progress);
        }
    }

    removeVideo(id: string): void {
        this.feed.removeVideo(id);
        for (var i = 0; i < this.views.length; i++) {
            this.views[i].view.removeVideo(id);
        }
    }

    /** OK where the videos failed to load: the feed's, or the chosen channel's list (that one not by itself: quiet) */
    retry(quiet?: boolean): boolean {
        return !this.chosen ? this.feed.retry(quiet) : !quiet && !!this.inSight && this.inSight.retry();
    }

    setFocused(focused: boolean): void {
        this.focused = focused;
        this.feed.setFocused(focused && this.at === 'rows' && this.inSight === this.feed);
        if (!this.side) {
            this.channelPills.setFocused(focused && this.at === 'channels');
            this.pills.setFocused(focused && this.at === 'pills');
            return;
        }
        if (this.inSight && this.inSight !== this.feed) {
            this.inSight.setFocused(focused && this.at === 'rows');
        }
        (this.column as ChannelColumn).setFocused(focused && this.at === 'channels');
        toggleClass(this.visit, 'by-subs-visit--focused', focused && this.at === 'visit');
    }

    /** The video whose tile has the focus (none in the header or the column) */
    focusedVideo(): Video | null {
        return this.at === 'rows' && this.inSight ? this.inSight.focusedVideo() : null;
    }

    onKey(code: number): boolean {
        if (this.side) {
            return this.sideKey(code);
        }
        if (this.at === 'rows') {
            if (this.feed.onKey(code)) {
                this.place();
                return true;
            }
            if (code === KEY.UP) {
                this.go('pills');
                return true;
            }
            return false;
        }
        var self = this;
        return (this.at === 'channels' ? this.channelPills : this.pills).key(code, { up: function () {
            if (self.at === 'pills' && self.channelPills.count) {
                self.go('channels');
                self.restSoon();
            }
            return true;
        }, down: function () {
            if (self.at === 'channels') {
                self.go('pills');
            } else if (self.feed.focusable) {
                self.go('rows');
            }
            return true;
        }, moved: function () {
            self.scroll();
            self.restSoon();
        } });
    }

    /** Keys with the channels at the side. In the column: Up and Down move along it (the videos beside it follow
     * once the focus rests), Right or OK go into the videos, Left and Back are the rail's (not taken). In the videos:
     * Left at a line's start and Back return to the column, Up from a channel's first line goes to "Visit channel"
     * (OK: its page) */
    private sideKey(code: number): boolean {
        if (this.at === 'channels') {
            switch (code) {
                case KEY.UP:
                case KEY.DOWN:
                    if ((this.column as ChannelColumn).move(code === KEY.UP ? -1 : 1)) {
                        this.pick();
                    }
                    return true;
                case KEY.RIGHT:
                case KEY.OK:
                    this.enter();
                    return true;
            }
            return false;
        }
        if (this.at === 'visit') {
            switch (code) {
                case KEY.OK:
                    this.openChannel(this.current(this.chosen as SubChannel));
                    return true;
                case KEY.DOWN:
                    this.go('rows');
                    return true;
                case KEY.LEFT:
                case KEY.BACK:
                    this.go('channels');
                    return true;
                case KEY.UP:
                case KEY.RIGHT:
                    return true;
            }
            return false;
        }
        if (this.inSight && this.inSight.onKey(code)) {
            return true;
        }
        if (code === KEY.UP && this.visitable) {
            this.go('visit');
            return true;
        }
        if (code === KEY.LEFT || code === KEY.BACK) {
            this.go('channels');
            return true;
        }
        return false;
    }

    private go(at: Place): void {
        this.at = at;
        this.setFocused(this.focused);
        this.place();
    }

    /** Right or OK in the column: into the videos beside it. Those not in sight yet (the focus has not rested) come
     * now; a channel's list still on its way is entered as it is drawn */
    private enter(): void {
        if (!this.inSight) {
            clearTimeout(this.listTimer);
            clearTimeout(this.askTimer);
            this.showChosen();
        }
        if (this.inSight && this.inSight.focusable) {
            this.go('rows');
        } else {
            this.entering = !!this.chosen;
        }
    }

    /** The column's focus moved: the videos beside it are the focused item's. They come once the focus has rested
     * (showSoon), so a walk along the column with the key held draws nothing: what was in sight goes out of it with
     * the key, by one style. A press of its own onto videos drawn already swaps the two with nothing empty between */
    private pick(): void {
        var view = this.inSight;
        var now = Date.now();
        var own = ownPress() && now - this.steppedAt > OWN_STEP_MS;
        this.steppedAt = now;
        this.chosen = (this.column as ChannelColumn).channel;
        this.entering = false;
        // A press of its own onto videos that are drawn ("All", a channel's list of the last few): what is in sight
        // stays until they take its place, right after the highlight's frame. Any other step puts it out of sight
        var drawn = own && (!this.chosen || this.viewed(this.chosen) >= 0);
        if (view) {
            this.inSight = null;
            this.left = view;
            this.leftShown = true;
        }
        if (this.leftShown && !drawn) {
            this.leftShown = false;
            if (this.left === this.feed) {
                standsBy(this.feed.el, true);
            } else if (this.left) {
                setShown(this.left.el, false);
            }
        }
        this.showSoon(own, drawn);
    }

    /** Shows the chosen item's videos after a rest of the focus: right after the highlight's frame where they are
     * drawn ("All"'s; drawn: a channel's list drawn before, stepped onto by a press of its own), a channel's to be
     * drawn a little later (LIST_REST_MS). own: the step was a press of its own, so that channel's list is asked for
     * ahead of the rest, right after the highlight's frame */
    private showSoon(own?: boolean, drawn?: boolean): void {
        clearTimeout(this.listTimer);
        clearTimeout(this.askTimer);
        if (this.shown) {
            this.listTimer = setTimeout(this.rested, this.chosen && !drawn ? LIST_REST_MS : READY_MS) as unknown as number;
            // (videos drawn already ask for themselves once they have grown old: nothing ahead of them)
            if (own && this.chosen && !drawn) {
                this.askTimer = setTimeout(this.askAhead, READY_MS) as unknown as number;
            }
        }
    }

    /** Puts the chosen item's videos in sight: the feed back in its place, or the channel's list (drawn before: shown
     * as it is; else made, and asked for or drawn from the kept one). What was in sight before is let go only now:
     * a list hidden with its pictures released, the feed standing by under a list. The feed stands by FEED_STAND_MS
     * from then, whichever lists follow that one; only its own return ends the wait */
    private showChosen(): void {
        var c = this.chosen;
        var view = c ? this.viewOf(c) : this.feed;
        var left = this.left;
        this.left = null;
        this.leftShown = false;
        this.inSight = view;
        if (view === this.feed) {
            clearTimeout(this.feedTimer);
        } else if (left === this.feed) {
            left.standBy();
            clearTimeout(this.feedTimer);
            this.feedTimer = setTimeout(this.stoodBy, FEED_STAND_MS) as unknown as number;
        }
        if (left && left !== view && left !== this.feed) {
            this.letGo(left);
        }
        view.show();
        this.setFocused(this.focused);
        this.drawHeading();
    }

    /** Where the pool has c's list (-1: not drawn) */
    private viewed(c: SubChannel): number {
        var key = channelKey(c);
        for (var i = 0; i < this.views.length; i++) {
            if (this.views[i].key === key) {
                return i;
            }
        }
        return -1;
    }

    /** The view of c's list: the one drawn before while its list is still kept (an older one is closed: the list is
     * asked for anew), else a new one (a grid under the channel's heading, which asks for more only as the focus
     * moves in it); past VIEWS of them the one longest out of sight is closed */
    private viewOf(c: SubChannel): FeedView {
        var self = this;
        var at = this.viewed(c);
        var had = at >= 0 ? this.views.splice(at, 1)[0] : null;
        // (one drawn with its videos stays, however old: shown again it asks YouTube behind them, LIST_FRESH_MS on)
        if (had && (had.view.hasRows || pageKept(c.page))) {
            this.views.push(had);
            return had.view;
        }
        if (had) {
            this.close(had.view);
        }
        var name = c.title;
        var texts = { empty: tr('No videos from {1} yet.', name), noAccount: this.texts.noAccount, failed: tr('Could not load this page. Press OK to try again.') };
        var before = this.knownOf(c);
        var made = { key: channelKey(c), view: null as unknown as FeedView, handle: before && before.handle || '' };
        var view = made.view = new FeedView(function (renew) {
            return self.listOf(c, renew).then(function (rows) {
                made.handle = rows.handle || '';
                return rows;
            });
        }, texts, this.open, {
            lines: this.listLines, idle: true, oneChannel: true, onDrawn: function () { self.drawn(view); },
            onPart: function (videos) { ofChannel(videos, name); },
            // The channel's list as it was last seen, else its videos the list above has already: in sight at once,
            // YouTube's list of the channel laid against them when it comes
            early: true,
            refreshMs: LIST_FRESH_MS,
            kept: function () {
                var rows = before || self.earlyOf(c);
                return rows ? { rows: rows, same: function () { return Promise.resolve(true); } } : null;
            }
        });
        view.setFocused(false);
        this.rowsBox.appendChild(view.el);
        this.views.push(made);
        if (this.views.length > VIEWS) {
            this.close(this.views.shift()!.view);
        }
        return view;
    }

    /** A channel's list goes out of sight: hidden as it is drawn, its pictures let go, to show again with nothing to
     * build. One whose videos have not come yet is closed instead (false): they are kept when they come, and drawn
     * once the focus rests on the channel again, not out of sight under the keys */
    private letGo(view: FeedView): boolean {
        if (view.settled) {
            // (it stands by with its pictures, to be back as it was; the one that stood by before lets them go)
            if (this.standing && this.standing !== view) {
                this.standing.hide();
            }
            this.standing = view;
            if (view.keep()) {
                standsBy(view.el, true);
            }
            return true;
        }
        this.views = this.views.filter(function (v) { return v.view !== view; });
        this.close(view);
        return false;
    }

    /** Closes a channel's list for good */
    private close(view: FeedView): void {
        if (view === this.standing) {
            this.standing = null;
        }
        view.hide();
        view.destroy();
        if (view.el.parentNode === this.rowsBox) {
            this.rowsBox.removeChild(view.el);
        }
    }

    /** "All"'s videos in sight again and every channel's list closed (another layout, another account), at once */
    private toAll(): void {
        var self = this;
        clearTimeout(this.listTimer);
        clearTimeout(this.askTimer);
        clearTimeout(this.feedTimer);
        this.views.splice(0).forEach(function (v) { self.close(v.view); });
        this.chosen = this.left = null;
        this.entering = false;
        if (this.inSight !== this.feed) {
            this.inSight = this.feed;
            if (this.shown) {
                this.feed.show();
            }
        }
    }

    /** A channel's list was drawn: if it is the one in sight, its heading has its handle now, and Right or OK that
     * came before it goes in */
    private drawn(view: FeedView): void {
        if (view !== this.inSight) {
            return;
        }
        var enter = this.entering && this.focused && this.at === 'channels' && view.focusable;
        this.entering = false;
        this.drawHeading();
        if (enter) {
            this.go('rows');
        }
    }

    /** c's videos that YouTube's list above has (newest first, as its own list of the channel begins), as a channel's
     * list shows them: there with no request, in sight while the channel's list is on its way. Null: none of c's,
     * or another channel shares its name */
    private earlyOf(c: SubChannel): Rows | null {
        var all = this.all;
        if (!all || this.named[c.title] !== channelKey(c)) {
            return null;
        }
        var name = c.title;
        var videos = allVideos(all.shelves.slice(leadOf(all) ? 1 : 0)).filter(function (v) { return !v.page && v.channel === name; });
        return videos.length ? { title: '', next: '', shelves: [{ title: '', videos: videos, grid: true, feed: true, next: '' }] } : null;
    }

    /** c's newest videos as a grid's rows, from YouTube's list of them in Subscriptions (api/feed.ts keptPage: kept a
     * few minutes there and dropped with the account, one request at a time, read off the main thread). Asked of
     * YouTube, not taken from what is kept, the list tells YouTube the channel was looked at: `listed` hears of it
     * once the reply is in */
    private listOf(c: SubChannel, renew?: boolean): Promise<Rows> {
        var self = this;
        return this.asked(c, renew).then(function (rows) {
            var list = asList(rows, c.title);
            self.know(c, list);
            return list;
        });
    }

    /** Keeps c's list as it is now (its videos; not its token for more, which grows old), the KNOWN seen last */
    private know(c: SubChannel, list: Rows): void {
        var key = channelKey(c);
        this.known = this.known.filter(function (k) { return k.key !== key; });
        if (list.shelves.length) {
            this.known.push({ key: key, rows: { title: '', next: '', handle: list.handle, shelves: [{ title: '', videos: list.shelves[0].videos.slice(), grid: true, feed: true, next: '' }] } });
            if (this.known.length > KNOWN) {
                this.known.shift();
            }
        }
    }

    /** c's list as it was last seen (a copy to draw; null: not seen since the app started) */
    private knownOf(c: SubChannel): Rows | null {
        var key = channelKey(c);
        for (var i = 0; i < this.known.length; i++) {
            if (this.known[i].key === key) {
                var rows = this.known[i].rows;
                return { title: '', next: '', handle: rows.handle, shelves: [{ title: '', videos: rows.shelves[0].videos.slice(), grid: true, feed: true, next: '' }] };
            }
        }
        return null;
    }

    /** c's list in Subscriptions as YouTube has it, kept or on its way or asked for now (the first to ask tells
     * `listed` once the reply is in) */
    private asked(c: SubChannel, renew?: boolean): Promise<Rows> {
        var self = this;
        var first = renew || !pageKept(c.page);
        var rows = keptPage(c.page, renew);
        if (first) {
            rows.then(function () { self.listed(c); }, function () { return undefined; });
        }
        return rows;
    }

    /** The heading over the videos while the focus is in them: "All subscriptions", or the chosen channel's picture,
     * name and handle (known once its list came) with "Visit channel" */
    private drawHeading(): void {
        if (!this.side) {
            return;
        }
        var c = this.chosen;
        var at = c ? this.viewed(c) : -1;
        setText(this.headingName, c ? c.title : tr('All subscriptions'));
        setText(this.headingHandle, at >= 0 ? this.views[at].handle : '');
        toggleClass(this.heading, 'by-subs-heading--channel', !!c);
        if (c) {
            setSrc(this.headingPicture, c.picture);
        }
        this.visitable = !!c && !!this.current(c).channel;
        this.visit.style.display = this.visitable ? '' : 'none';
    }

    /** Chooses a pill and filters the rows by it at once */
    private choose(i: number): void {
        this.pill = i;
        this.markPills();
        if (this.all) {
            this.feed.showRows(this.filtered(this.all));
        }
    }

    private markPills(): void {
        for (var i = 0; i < this.pillEls.length; i++) {
            toggleClass(this.pillEls[i], 'by-subs-pill--chosen', i === this.pill);
        }
    }

    /** rows as the chosen pill shows them: All as YouTube's TV app does (its first shelf a row, the rest one grid),
     * the others as a grid of the matching videos in the list's order */
    private filtered(rows: Rows): Rows {
        var keep = PILLS[this.pill].keep;
        if (!keep) {
            return asFeed(rows);
        }
        var videos = inOrder(rows).filter(function (v) { return !v.page && keep!(v); });
        return { title: '', next: '', shelves: [{ title: '', videos: videos, grid: true }] };
    }

    /** The channels from YouTube: drawn now if none are shown, else once the screen is out of sight (they do not
     * change under the viewer); the dots of the ones shown follow the new list at once */
    private channels(list: SubChannel[]): void {
        this.waiting = list;
        if (!this.shownChannels || !this.shown) {
            this.putChannels();
        } else {
            this.drawDots();
        }
    }

    /** A channel's page was opened, or its list asked for (api/looked.ts visited): its dot goes, here at once and at
     * YouTube */
    looks(): void {
        if (this.all) {
            settle(this.all.channels || [], this.askedAt);
            this.drawDots();
        }
    }

    /** A video started playing: the newest of its channel (the first of that channel's in the list, which is newest
     * first) counts as the channel looked at. By the channel's name, the rows not having its id: not where two
     * subscribed channels share it; and only by rows YouTube sent of late (in older ones, or those kept from an
     * earlier start, a newer video may be missing: its dot would go unseen) */
    sawVideo(id: string, channel: string): void {
        var list = this.all && this.all.channels || [];
        var key = this.named[channel];
        var newest = this.newest[channel];
        if (!key || !newest || newest.id !== id || !this.askedAt || Date.now() - this.askedAt > NEWEST_MS) {
            return;
        }
        // (a channel is in the list twice, among the first ones and in A-Z: looked tells YouTube once, settle takes
        // the dot from both)
        list.filter(function (c) { return channelKey(c) === key; }).forEach(looked);
        settle(list, this.askedAt);
        this.drawDots();
    }

    /** c as the newest list has it: the channels drawn may be of the list before, whose channels do not say whether a
     * page is to be fetched anew */
    private current(c: SubChannel): SubChannel {
        var key = channelKey(c);
        var list = this.all && this.all.channels || [];
        for (var i = 0; i < list.length; i++) {
            if (channelKey(list[i]) === key) {
                return list[i];
            }
        }
        return c;
    }

    /** Shows each drawn channel's dot as the newest list has it */
    private drawDots(): void {
        var dotted: { [key: string]: boolean } = {};
        (this.waiting || this.all && this.all.channels || []).forEach(function (c) {
            if (c.fresh && !c.seen) {
                dotted[channelKey(c)] = true;
            }
        });
        if (this.side) {
            (this.column as ChannelColumn).setDots(dotted);
            return;
        }
        for (var i = 0; i < this.dots.length; i++) {
            this.dots[i].style.display = dotted[channelKey(this.rowChannels[i])] ? '' : 'none';
        }
    }

    private putChannels(): void {
        var list = this.waiting as SubChannel[];
        this.waiting = null;
        if (!list) {
            return;
        }
        if (this.side) {
            this.putColumn(list);
            return;
        }
        // (YouTube lists its first channels again in A-Z: once each here)
        var first: { [key: string]: boolean } = {};
        var row = list.filter(function (c) { return c.recent; });
        row.forEach(function (c) { first[channelKey(c)] = true; });
        row = row.concat(list.filter(function (c) { return !c.recent && c.fresh && !first[channelKey(c)]; })).slice(0, ROW_MAX);
        var key = row.map(function (c) { return c.title + (c.channel ? c.channel.browseId : ''); }).join('|');
        if (key === this.shownChannels) {
            // The same channels in the same order: only their dots may differ
            this.rowChannels = row;
            this.drawDots();
            return;
        }
        this.shownChannels = key;
        this.rowChannels = row;
        var self = this;
        var at = this.channelPills.at;
        this.strip.innerHTML = '';
        this.channelPills.clear();
        this.dots = [];
        row.forEach(function (c) {
            var el = h('div', 'by-subs-channel');
            var picture = h('img', 'by-subs-picture') as HTMLImageElement;
            if (self.shown || !c.picture) {
                setSrc(picture, c.picture);
            } else {
                // Hidden: loaded once shown (restoreImages)
                picture.setAttribute('data-src', c.picture);
            }
            el.appendChild(picture);
            // (always there, shown by drawDots: a channel looked at loses it without the row being drawn anew)
            self.dots.push(el.appendChild(h('div', 'by-subs-dot')) as HTMLElement);
            el.appendChild(h('div', 'by-subs-name', c.title));
            self.strip.appendChild(self.channelPills.add(el, function () { self.openChannel(self.current(c)); }));
        });
        var all = h('div', 'by-subs-channel by-subs-all');
        setText(all, tr('All'));
        // (the newest list: the row may be of the one before)
        this.strip.appendChild(this.channelPills.add(all, function () { self.openAll(self.all && self.all.channels || list); }));
        this.drawDots();
        this.channelPills.focus(Math.min(at, this.channelPills.count - 1));
        this.channelPills.setFocused(this.focused && this.at === 'channels');
        this.scroll();
    }

    /** The column takes list (every channel as YouTube lists them, under YouTube's label for the A-Z ones), unless
     * it shows those channels in that order already: then only their dots may differ. Its focus follows its channel
     * to where the list has it. A list without the chosen channel would take its videos away and put the focus in
     * the column on "All": that one waits while the screen shows, also under a video (the viewer comes back to the
     * tile played), until the screen is out of sight */
    private putColumn(list: SubChannel[]): void {
        var column = this.column as ChannelColumn;
        var key = list.map(function (c) { return (c.recent ? '+' : '') + c.title + (c.channel ? c.channel.browseId : ''); }).join('|');
        if (key !== this.shownChannels) {
            var chosen = this.chosen ? channelKey(this.chosen) : '';
            if (chosen && this.shown && !list.some(function (c) { return channelKey(c) === chosen; })) {
                this.waiting = list;
                this.drawDots();
                return;
            }
            this.shownChannels = key;
            column.set(list);
            var c = column.channel;
            if (!c && this.chosen) {
                this.pick();
                if (this.at !== 'channels') {
                    this.go('channels');
                }
            } else {
                this.chosen = c;
            }
        }
        column.setLabel(this.all && this.all.channelsLabel || 'A-Z');
        this.drawDots();
    }

    /** Prefetches the focused channel's page once the focus rests on it (as for tiles) */
    private restSoon(): void {
        clearTimeout(this.restTimer);
        var self = this;
        this.restTimer = setTimeout(function () {
            var c = self.at === 'channels' && self.focused ? self.rowChannels[self.channelPills.at] : null;
            if (c) {
                self.ahead(self.current(c));
            }
        }, REST_MS) as unknown as number;
    }

    /** Scrolls the channel row so the focused one is in view */
    private scroll(): void {
        this.channelPills.slide(this.strip, metrics().subscriptionsStep);
    }

    /** Fetches the rows anew, replacing these (account change) */
    reload(): void {
        this.gen++;
        this.forget();
        this.feed.reload();
    }

    /** Takes rows from YouTube (or the cache): the pills filter them, their channels fill the row or the column.
     * asked: when YouTube was asked for them (0: kept from an earlier start); a channel looked at since has no dot in
     * them (api/looked.ts), nor one whose newest video in them was started */
    private take(rows: Rows, asked: number): void {
        this.all = rows;
        this.askedAt = asked;
        this.fromKept = false;
        var list = rows.channels || [];
        settle(list, asked);
        var newest = this.newest = newestOf(rows);
        var named = this.named = oneNamed(list);
        list.forEach(function (c) {
            var v = named[c.title] === channelKey(c) ? newest[c.title] : null;
            // (YouTube's share of it watched, on any device; or started here with History off)
            c.seen = !!v && ((v.progress || 0) > 0 || watchedAt(v.id) >= 0);
        });
        this.channels(list);
    }

    /** Drops rows and channels (they belonged to another account), with what that account looked at and its
     * channels' lists */
    private forget(): void {
        this.all = this.waiting = null;
        this.known = [];
        this.newest = {};
        this.named = {};
        forgetLooks();
        this.fromKept = false;
        this.shownChannels = '';
        this.rowChannels = [];
        this.dots = [];
        this.strip.innerHTML = '';
        this.channelPills.clear();
        if (this.side) {
            (this.column as ChannelColumn).set([]);
            this.toAll();
            this.drawHeading();
            this.go('channels');
        } else if (this.at === 'channels') {
            this.go('pills');
        }
    }

    /** Puts the videos and what is over them where the focus is. The row at the top: with the focus in the header or
     * on the first row, the rows start below the header; further down it slides away. The column: the videos stand
     * beside it while it has the focus, and take its place (under their heading) once the focus is in them */
    private place(): void {
        var m = metrics();
        if (this.side) {
            var beside = this.at === 'channels';
            if (beside !== this.beside) {
                // (each by its own style: a class on the screen would have every tile's style looked at again)
                this.beside = beside;
                setShown(this.title, beside);
                setShown((this.column as ChannelColumn).el, beside);
                setShown(this.rule, beside);
                setShown(this.heading, !beside);
                setShown(this.visit, !beside);
            }
            translate(this.rowsBox, beside ? m.subs.shift : 0, 0);
            return;
        }
        var down = m.subscriptionsTop - m.rowsTop;
        var inHead = this.at !== 'rows' || this.feed.rowIndex === 0;
        translate(this.rowsBox, 0, inHead ? down : 0);
        translate(this.head, 0, inHead ? 0 : -down);
        toggleClass(this.el, 'by-subs--rows', !inHead);
    }
}

/** YouTube's first shelf where it is a row of its own over the list ("Most relevant": it has a name, the shelf after
 * it none), else null */
function leadOf(rows: Rows): Shelf | null {
    var first = rows.shelves[0];
    var next = rows.shelves[1];
    return first && first.title && !first.grid && !(next && next.title) ? first : null;
}

/** The videos of rows in the list's order: YouTube's list (every shelf but its first row's), then those only that
 * row has, unless the viewer has that row off */
function inOrder(rows: Rows): Video[] {
    var lead = leadOf(rows);
    var seen: { [id: string]: boolean } = {};
    var videos: Video[] = [];
    rows.shelves.slice(lead ? 1 : 0).concat(lead && prefs().subsRelevant ? [lead] : []).forEach(function (s) {
        s.videos.forEach(function (v) {
            if (!seen[v.id]) {
                seen[v.id] = true;
                videos.push(v);
            }
        });
    });
    return videos;
}

/** rows as the screen shows them (views/videos.ts, Shelf.feed): YouTube's first row, if it sent one, over one grid of
 * everything after it, which continues with the screen's token. Rows without videos (YouTube's message, none) as
 * they are */
function asFeed(rows: Rows): Rows {
    if (!rows.shelves.length) {
        return rows;
    }
    var lead = leadOf(rows);
    var grid: Shelf = { title: '', videos: allVideos(rows.shelves.slice(lead ? 1 : 0)), grid: true, feed: true, next: listNext(rows) };
    // (the viewer may have that row off: the list alone)
    return copied(rows, { title: '', next: '', shelves: lead && prefs().subsRelevant ? [lead, grid] : [grid] });
}

/** The named channel's list in Subscriptions (YouTube's reply as rows) as a grid of its videos, each put right
 * (ofChannel), which continues with the list's token; none: no rows (the view says so). With the handle its header
 * gave */
function asList(rows: Rows, name: string): Rows {
    var videos = allVideos(rows.shelves);
    ofChannel(videos, name);
    return { title: '', next: '', handle: rows.handle, shelves: videos.length ? [{ title: '', videos: videos, grid: true, feed: true, next: listNext(rows) }] : [] };
}

/** Puts the videos of the named channel's list right. Its tiles have one line, the views and age, where others name
 * the channel first, so the rows have that line as the channel's name: it is the video's info, the channel the
 * list's own */
function ofChannel(videos: Video[], name: string): void {
    videos.forEach(function (v) {
        if (!v.page && v.channel !== name) {
            v.info = v.info || v.channel;
            v.channel = name;
        }
    });
}

/** Each channel's newest video in rows, by the channel's name: its first in the list's order, which is newest first */
function newestOf(rows: Rows): { [channel: string]: Video } {
    var newest: { [channel: string]: Video } = Object.create(null);
    inOrder(rows).forEach(function (v) {
        if (v.channel && !v.page && !newest[v.channel]) {
            newest[v.channel] = v;
        }
    });
    return newest;
}

/** The key (api/looked.ts channelKey) of the one channel of each name in list; '' for a name two channels share */
function oneNamed(list: SubChannel[]): { [title: string]: string } {
    var named: { [title: string]: string } = Object.create(null);
    list.forEach(function (c) {
        var key = channelKey(c);
        named[c.title] = named[c.title] === undefined || named[c.title] === key ? key : '';
    });
    return named;
}
