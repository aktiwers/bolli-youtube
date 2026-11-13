// Subscriptions screen, laid out like YouTube's phone app: a row of round channel pictures at the top (YouTube's
// first-listed channels, then others with new videos, marked by a dot until the channel is looked at: its page
// opened or its newest video started, api/looked.ts; "All" at the end lists every channel A-Z),
// filter pills below (All, Today, Videos, Live: filtered locally, no new request), then the videos
// (views/videos.ts FeedView; a filtered pill shows a grid). OK on a channel opens its page (main.ts
// openSubChannel). Up from the first row focuses the pills, then the channels; further down the header slides
// away. The rows' top comes from the theme (metrics.subscriptionsTop), the look from themes/<id>.css (by-subs).

import { h, releaseImages, restoreImages, setShown, setSrc, setText, standsBy, toggleClass, translate } from '../core/dom.js';
import { tr } from '../core/i18n.js';
import { KEY } from '../core/keys.js';
import { takesPointer, toPart } from '../core/pointer.js';
import { View } from '../core/view.js';
import { Rows, SubChannel, Video, withinADay } from '../api/feed.js';
import { channelKey, forgetLooks, looked, settle } from '../api/looked.js';
import { Pills } from '../ui/pills.js';
import { metrics } from '../ui/theme.js';
import { watchedAt } from './tiles.js';
import { FeedHost, FeedOptions, FeedTexts, FeedView } from './videos.js';

/** Focus resting this long on a channel prefetches its page. YouTube's reply takes 0.7-1 s, so a longer delay leaves
 * a quick OK waiting; the reply is parsed off the main thread (api/off-thread.ts) */
var REST_MS = 300;
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

/** Where the focus is: the channels, the pills or the rows */
type Place = 'channels' | 'pills' | 'rows';

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

    /** load: YouTube's rows (with the channels); open: OK on a tile; openChannel: a channel's page; openAll:
     * every subscribed channel */
    constructor(load: () => Promise<Rows | null>, texts: FeedTexts, open: (video: Video) => void, opts: FeedOptions,
        private openChannel: (c: SubChannel) => void, private openAll: (channels: SubChannel[]) => void,
        private ahead: (c: SubChannel) => void) {
        super();
        var self = this;
        this.el = h('div', 'by-subs');
        this.rowsBox = h('div', 'by-subs-rows');
        this.el.appendChild(this.rowsBox);
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
            return { rows: k.rows, same: function () {
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
        setShown(this.el, false);
        this.markPills();
        this.place();
        // A click moves the focus to the part it is in (a channel, a pill, the rows; back after a tile's)
        takesPointer(this.el, function (target, under) {
            var part: Place = self.strip.contains(target) ? 'channels' : self.head.contains(target) ? 'pills' : 'rows';
            return toPart(under, function (p: Place) { self.go(p); }, self.at, part);
        });
    }

    show(rest?: boolean): void {
        this.shown = true;
        standsBy(this.el, false);
        setShown(this.el, true);
        restoreImages(this.strip);
        this.feed.show(rest);
    }

    /** Hidden: the channels' pictures are let go too (the rows let go of theirs) */
    hide(): void {
        this.shown = false;
        standsBy(this.el, false);
        setShown(this.el, false);
        this.feed.hide();
        this.putChannels();
        releaseImages(this.strip);
    }

    /** Out of sight but kept drawn, the channels' pictures too (false: no rows yet, hidden) */
    standBy(): boolean {
        if (!this.feed.keep()) {
            this.hide();
            return false;
        }
        this.shown = false;
        setShown(this.el, true);
        restoreImages(this.strip);
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

    setFocused(focused: boolean): void {
        this.focused = focused;
        this.feed.setFocused(focused && this.at === 'rows');
        this.channelPills.setFocused(focused && this.at === 'channels');
        this.pills.setFocused(focused && this.at === 'pills');
    }

    /** The video whose tile has the focus (none in the header) */
    focusedVideo(): Video | null {
        return this.at === 'rows' ? this.feed.focusedVideo() : null;
    }

    onKey(code: number): boolean {
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

    private go(at: Place): void {
        this.at = at;
        this.setFocused(this.focused);
        this.place();
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

    /** rows filtered by the chosen pill: All as YouTube returns them, the others as a grid of matching videos */
    private filtered(rows: Rows): Rows {
        var keep = PILLS[this.pill].keep;
        if (!keep) {
            return rows;
        }
        var seen: { [id: string]: boolean } = {};
        var videos: Video[] = [];
        rows.shelves.forEach(function (s) {
            s.videos.forEach(function (v) {
                if (!seen[v.id] && !v.page && keep!(v)) {
                    seen[v.id] = true;
                    videos.push(v);
                }
            });
        });
        return { title: '', next: '', shelves: [{ title: '', videos: videos, grid: true }] };
    }

    /** The channels from YouTube: drawn now if none are shown, else once the screen is out of sight (the row does not
     * change under the viewer); the dots of the ones shown follow the new list at once */
    private channels(list: SubChannel[]): void {
        this.waiting = list;
        if (!this.shownChannels || !this.shown) {
            this.putChannels();
        } else {
            this.drawDots();
        }
    }

    /** A channel's page was opened (api/looked.ts visited): its dot goes, here at once and at YouTube */
    looks(): void {
        if (this.all) {
            settle(this.all.channels || [], this.askedAt);
            this.drawDots();
        }
    }

    /** A video started playing: the newest of its channel (the first of that channel's in the rows, which are newest
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

    /** c as the newest list has it: the row drawn may be of the list before, whose channels do not say whether a
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

    /** Takes rows from YouTube (or the cache): the pills filter them, their channels fill the row. asked: when
     * YouTube was asked for them (0: kept from an earlier start); a channel looked at since has no dot in them
     * (api/looked.ts), nor one whose newest video in them was started */
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

    /** Drops rows and channels (they belonged to another account), with what that account looked at */
    private forget(): void {
        this.all = this.waiting = null;
        this.newest = {};
        this.named = {};
        forgetLooks();
        this.fromKept = false;
        this.shownChannels = '';
        this.rowChannels = [];
        this.dots = [];
        this.strip.innerHTML = '';
        this.channelPills.clear();
        if (this.at === 'channels') {
            this.go('pills');
        }
    }

    /** With the focus in the header or on the first row, the rows start below the header; further down it slides away */
    private place(): void {
        var m = metrics();
        var down = m.subscriptionsTop - m.rowsTop;
        var inHead = this.at !== 'rows' || this.feed.rowIndex === 0;
        translate(this.rowsBox, 0, inHead ? down : 0);
        translate(this.head, 0, inHead ? 0 : -down);
        toggleClass(this.el, 'by-subs--rows', !inHead);
    }
}

/** Each channel's newest video in rows, by the channel's name: its first there, the rows being newest first */
function newestOf(rows: Rows): { [channel: string]: Video } {
    var newest: { [channel: string]: Video } = Object.create(null);
    rows.shelves.forEach(function (s) {
        s.videos.forEach(function (v) {
            if (v.channel && !v.page && !newest[v.channel]) {
                newest[v.channel] = v;
            }
        });
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
