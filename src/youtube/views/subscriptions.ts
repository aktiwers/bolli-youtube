// Subscriptions screen, laid out like YouTube's phone app: a row of round channel pictures at the top (YouTube's
// first-listed channels, then others with new videos, marked by a dot; "All" at the end lists every channel A-Z),
// filter pills below (All, Today, Videos, Live: filtered locally, no new request), then the videos
// (views/videos.ts FeedView; a filtered pill shows a grid). OK on a channel opens its page (main.ts
// openSubChannel). Up from the first row focuses the pills, then the channels; further down the header slides
// away. The rows' top comes from the theme (metrics.subscriptionsTop), the look from themes/<id>.css (by-subs).

import { h, setShown, setSrc, setText, toggleClass, translate } from '../../core/dom.js';
import { KEY } from '../../core/keys.js';
import { View } from '../../core/view.js';
import { Rows, SubChannel, Video } from '../api/feed.js';
import { Pills } from '../ui/pills.js';
import { metrics } from '../ui/theme.js';
import { FeedOptions, FeedTexts, FeedView } from './videos.js';

/** Focus resting this long on a channel prefetches its page. YouTube's reply takes 0.7-1 s, so a longer delay leaves
 * a quick OK waiting; the reply is parsed off the main thread (api/off-thread.ts) */
var REST_MS = 300;
/** Most channels in the row (YouTube's first-listed ones, then others with new videos) */
var ROW_MAX = 30;
/** The pills and the filter each applies to the rows */
var PILLS: { label: string; keep: ((v: Video) => boolean) | null }[] = [
    { label: 'All', keep: null },
    { label: 'Today', keep: function (v) { return !!v.live || /(second|minute|hour)s? ago/.test(v.info); } },
    { label: 'Videos', keep: function (v) { return !v.live; } },
    { label: 'Live', keep: function (v) { return !!v.live; } }
];

/** Where the focus is: the channels, the pills or the rows */
type Place = 'channels' | 'pills' | 'rows';

export class SubscriptionsView implements View {
    el: HTMLElement;
    private head: HTMLElement;
    private strip: HTMLElement;
    private rowsBox: HTMLElement;
    private feed: FeedView;
    private channelPills = new Pills('by-subs-channel--focused');
    private pills = new Pills('by-subs-pill--focused');
    private pillEls: HTMLElement[] = [];
    /** The chosen pill */
    private pill = 0;
    /** The channels in the row, in order, and the rest timer for prefetching the focused one */
    private rowChannels: SubChannel[] = [];
    private restTimer = 0;
    private at: Place = 'rows';
    private focused = true;
    /** The rows as YouTube returned them (the pills filter these) */
    private all: Rows | null = null;
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
            self.take(k.rows);
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
            return load().then(function (rows) {
                if (rows && gen === self.gen) {
                    self.take(rows);
                }
                return rows && self.filtered(rows);
            });
        }, texts, open, opts);
        this.rowsBox.appendChild(this.feed.el);
        setShown(this.el, false);
        this.markPills();
        this.place();
    }

    get settled(): boolean {
        return this.feed.settled;
    }

    show(rest?: boolean): void {
        this.shown = true;
        setShown(this.el, true);
        this.feed.show(rest);
    }

    hide(): void {
        this.shown = false;
        setShown(this.el, false);
        this.feed.hide();
        this.putChannels();
    }

    cover(covered: boolean): void {
        this.feed.cover(covered);
        if (covered) {
            this.putChannels();
        }
    }

    renewIfOld(): void {
        this.feed.renewIfOld();
    }

    prepare(): void {
        this.feed.prepare();
    }

    putFresh(): void {
        this.feed.putFresh();
        this.putChannels();
    }

    setProgress(id: string, progress: number): void {
        this.feed.setProgress(id, progress);
    }

    removeVideo(id: string): void {
        this.feed.removeVideo(id);
    }

    retry(quiet?: boolean): boolean {
        return this.feed.retry(quiet);
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
        var row = this.at === 'channels' ? this.channelPills : this.pills;
        switch (code) {
            case KEY.LEFT:
            case KEY.RIGHT:
                // Left past the first goes to the rail
                if (row.move(code === KEY.LEFT ? -1 : 1)) {
                    this.scroll();
                    this.restSoon();
                    return true;
                }
                return code === KEY.RIGHT;
            case KEY.OK:
                row.press();
                return true;
            case KEY.DOWN:
                if (this.at === 'channels') {
                    this.go('pills');
                } else if (this.feed.hasRows) {
                    this.go('rows');
                }
                return true;
            case KEY.UP:
                if (this.at === 'pills' && this.channelPills.count) {
                    this.go('channels');
                    this.restSoon();
                }
                return true;
        }
        return false;
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

    /** The channels from YouTube: drawn now if none are shown, else once the screen is out of sight */
    private channels(list: SubChannel[]): void {
        this.waiting = list;
        if (!this.shownChannels || !this.shown) {
            this.putChannels();
        }
    }

    private putChannels(): void {
        var list = this.waiting as SubChannel[];
        this.waiting = null;
        if (!list) {
            return;
        }
        var row = list.filter(function (c) { return c.recent; }).concat(list.filter(function (c) { return !c.recent && c.fresh; })).slice(0, ROW_MAX);
        var key = row.map(function (c) { return c.title + (c.fresh ? '*' : '') + (c.channel ? c.channel.browseId : ''); }).join('|');
        if (key === this.shownChannels) {
            return;
        }
        this.shownChannels = key;
        this.rowChannels = row;
        var self = this;
        var at = this.channelPills.at;
        this.strip.innerHTML = '';
        this.channelPills.clear();
        row.forEach(function (c) {
            var el = h('div', 'by-subs-channel');
            var picture = h('img', 'by-subs-picture') as HTMLImageElement;
            setSrc(picture, c.picture);
            el.appendChild(picture);
            if (c.fresh) {
                el.appendChild(h('div', 'by-subs-dot'));
            }
            el.appendChild(h('div', 'by-subs-name', c.title));
            self.strip.appendChild(self.channelPills.add(el, function () { self.openChannel(c); }));
        });
        var all = h('div', 'by-subs-channel by-subs-all');
        setText(all, 'All');
        this.strip.appendChild(this.channelPills.add(all, function () { self.openAll(list); }));
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
                self.ahead(c);
            }
        }, REST_MS) as unknown as number;
    }

    /** Scrolls the channel row so the focused one is in view */
    private scroll(): void {
        var step = metrics().subscriptionsStep;
        var inView = Math.floor((1280 - metrics().rows.pad) / step);
        translate(this.strip, -Math.max(0, this.channelPills.at - inView + 1) * step, 0);
    }

    /** Fetches the rows anew, replacing these (account change) */
    reload(): void {
        this.gen++;
        this.forget();
        this.feed.reload();
    }

    /** Takes rows from YouTube (or the cache): the pills filter them, their channels fill the row */
    private take(rows: Rows): void {
        this.all = rows;
        this.fromKept = false;
        this.channels(rows.channels || []);
    }

    /** Drops rows and channels (they belonged to another account) */
    private forget(): void {
        this.all = this.waiting = null;
        this.fromKept = false;
        this.shownChannels = '';
        this.rowChannels = [];
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
