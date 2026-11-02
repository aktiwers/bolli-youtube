// A channel's page, laid out like YouTube's TV app: full screen (no rail),
// banner and search bar on top, avatar beside name, handle and subscribers,
// three description lines with "...more" (opens About in a side panel).
// Buttons: Play mix, Subscribe, then sub pages (Videos, Live, Playlists),
// each opening as its own page over this one. Below, the shelves as rows
// (FeedView). Down enters the rows and slides the header away; Up walks back
// to the buttons, "...more" and the search bar. Positions come from
// metrics.channel, the look from themes/<id>.css. Resting focus on a sub
// page button prefetches that page; images are released while hidden.

import { h, releaseImages, restoreImages, setShown, setSrc, setText, toggleClass, translate } from '../../core/dom.js';
import { KEY } from '../../core/keys.js';
import { View } from '../../core/view.js';
import { Channel, keptChannel } from '../api/channel.js';
import { Page, Rows, Video } from '../api/feed.js';
import { drawSubscribe, pressSubscribe } from '../ui/account.js';
import { icon } from '../ui/icons.js';
import { Pills } from '../ui/pills.js';
import { PanelLine, paragraphs, SidePanel } from '../ui/side-panel.js';
import { metrics, themed } from '../ui/theme.js';
import { fadeIn, FeedTexts, FeedView, SearchBar } from './videos.js';

/** Focus resting this long on a sub page button prefetches that page (as on a tile) */
var REST_MS = 1500;
/** A stored page this old is shown, then refreshed in the background */
var RENEW_MS = 30 * 60 * 1000;
/** Placeholder for the channel's rows once the feed owns them */
var NO_ROWS: Rows = { title: '', shelves: [], next: '' };
/** The description: about this many characters (the rest is in About), then trimmed to fit three drawn lines */
var DESCRIPTION_CHARS = 180;
var DESCRIPTION_LINES = 3;

/** Focus location: search bar, "...more", buttons, or rows */
type Place = 'bar' | 'more' | 'buttons' | 'rows';

/** What the circle or tile the channel was opened from showed, so the page can show it at once; fresh: YouTube's blue
 * dot (new videos, so fetch the page anew instead of using the stored one) */
export interface KnownChannel {
    title: string;
    picture: string;
    fresh?: boolean;
}

export class ChannelView implements View {
    el: HTMLElement;
    private head: HTMLElement;
    private banner: HTMLImageElement;
    private avatar: HTMLImageElement;
    private name: HTMLElement;
    private subtitle: HTMLElement;
    private description: HTMLElement;
    private descriptionText: HTMLElement;
    private more: HTMLElement;
    private bar: SearchBar;
    private buttonRow: HTMLElement;
    private buttons = new Pills('by-pill--focused');
    private subscribeButton: HTMLElement | null = null;
    private rowsBox: HTMLElement;
    private feed: FeedView;
    private panel: SidePanel;
    private channel: Channel | null = null;
    private at: Place = 'buttons';
    private focused = true;
    /** Sub pages by button index */
    private pageAt: { [at: number]: Page } = {};
    private restTimer = 0;
    /** The description shown (fitted: trimmed to three lines after layout) */
    private said = '';
    private fitted = false;
    /** Name and avatar shown from `known` before YouTube's reply */
    private early = false;

    /** open: OK on a tile; openPage: opens a sub page over this one; ahead: prefetches a sub page; search: OK on the
     * search bar; known: name and avatar to show at once */
    constructor(page: Page, texts: FeedTexts, private open: (video: Video) => void, private openPage: (page: Page) => void,
        private ahead: (page: Page) => void, search: (voice: boolean) => void, known?: KnownChannel) {
        var self = this;
        this.el = h('div', 'by-channel');
        this.banner = h('img', 'by-channel-banner bd-fade') as HTMLImageElement;
        this.el.appendChild(this.banner);
        this.el.appendChild(h('div', 'by-channel-shade'));
        this.rowsBox = h('div', 'by-channel-rows');
        this.el.appendChild(this.rowsBox);
        this.head = h('div', 'by-channel-head');
        var named = h('div', 'by-channel-named');
        this.avatar = h('img', 'by-channel-avatar bd-fade') as HTMLImageElement;
        var lines = h('div', 'by-channel-lines');
        this.name = h('div', 'by-channel-name');
        this.subtitle = h('div', 'by-channel-subtitle');
        lines.appendChild(this.name);
        lines.appendChild(this.subtitle);
        named.appendChild(this.avatar);
        named.appendChild(lines);
        this.description = h('div', 'by-channel-description');
        this.descriptionText = h('span', '');
        this.description.appendChild(this.descriptionText);
        this.more = this.description.appendChild(h('span', 'by-channel-more', ' ...more')) as HTMLElement;
        // Shown with the description, not alone while loading
        setShown(this.more, false);
        this.buttonRow = h('div', 'by-channel-buttons');
        this.head.appendChild(named);
        this.head.appendChild(this.description);
        this.head.appendChild(this.buttonRow);
        this.el.appendChild(this.head);
        // YouTube's reply takes ~0.7 s; show the known name and avatar meanwhile
        // (the circle's picture is already loaded and big enough)
        if (known && known.picture) {
            setText(this.name, known.title);
            setSrc(this.avatar, known.picture);
            this.early = true;
        }
        // Search bar on top of everything, as in YouTube's app
        this.el.appendChild(h('div', 'by-channel-top'));
        this.bar = new SearchBar(this.el, 'by-channel', search);
        this.feed = new FeedView(function (renew) {
            // Rows from the cache or storage, else from YouTube; a renew fetches fresh rows behind the shown ones
            return keptChannel(page, renew ? 'renew' : known && known.fresh ? 'new' : 'kept').then(function (c) {
                // The feed owns the rows; do not hold them here too
                var rows = c.rows;
                c.rows = NO_ROWS;
                // Build the header once; a later renew only updates it (buttons and focus stay)
                if (!self.channel) {
                    self.setChannel(c);
                } else {
                    self.renewHead(c);
                }
                return rows;
            });
        }, texts, open, { pad: metrics().channel.pad, refreshMs: RENEW_MS });
        this.rowsBox.appendChild(this.feed.el);
        this.panel = new SidePanel(this.el);
        setShown(this.el, false);
        this.place();
    }

    /** The rows (or a message instead) have arrived */
    get settled(): boolean {
        return this.feed.settled;
    }

    show(): void {
        restoreImages(this.el);
        setShown(this.el, true);
        this.feed.show();
        if (this.channel && !this.fitted) {
            this.fitDescription();
        }
    }

    hide(): void {
        clearTimeout(this.restTimer);
        this.panel.close();
        setShown(this.el, false);
        this.feed.hide();
        releaseImages(this.el);
    }

    /** A video covers it (or not): fresh rows are swapped in out of sight */
    cover(covered: boolean): void {
        this.feed.cover(covered);
    }

    renewIfOld(): void {
        this.feed.renewIfOld();
    }

    putFresh(): void {
        this.feed.putFresh();
    }

    setProgress(id: string, progress: number): void {
        this.feed.setProgress(id, progress);
    }

    removeVideo(id: string): void {
        this.feed.removeVideo(id);
    }

    reload(): void {
        this.feed.reload();
    }

    setFocused(focused: boolean): void {
        this.focused = focused;
        this.feed.setFocused(focused && this.at === 'rows');
        this.buttons.setFocused(focused && this.at === 'buttons');
        toggleClass(this.description, 'by-channel-description--focused', focused && this.at === 'more');
        this.bar.setFocused(focused && this.at === 'bar');
    }

    retry(quiet?: boolean): boolean {
        return this.feed.retry(quiet);
    }

    /** The focused tile's video (null while focus is in the header) */
    focusedVideo(): Video | null {
        return this.at === 'rows' ? this.feed.focusedVideo() : null;
    }

    onKey(code: number): boolean {
        if (this.panel.shown) {
            this.panel.onKey(code);
            return true;
        }
        if (this.at === 'rows') {
            if (this.feed.onKey(code)) {
                return true;
            }
            if (code === KEY.UP) {
                this.go('buttons');
                return true;
            }
            return false;
        }
        if (this.at === 'bar' && this.bar.onKey(code)) {
            return true;
        }
        if (this.at === 'bar' || this.at === 'more') {
            switch (code) {
                case KEY.OK:
                    this.aboutPanel();
                    return true;
                case KEY.DOWN:
                    this.go(this.at === 'bar' && this.hasMore() ? 'more' : 'buttons');
                    return true;
                case KEY.UP:
                    this.go('bar');
                    return true;
            }
            return code !== KEY.BACK;
        }
        switch (code) {
            case KEY.LEFT:
            case KEY.RIGHT:
                if (this.buttons.move(code === KEY.LEFT ? -1 : 1)) {
                    this.restSoon();
                }
                return true;
            case KEY.DOWN:
                if (this.feed.hasRows) {
                    this.go('rows');
                }
                return true;
            case KEY.OK:
                this.buttons.press();
                return true;
            case KEY.UP:
                this.go(this.hasMore() ? 'more' : 'bar');
                return true;
        }
        return false;
    }

    /** There is an About to open (description, more text, facts) */
    private hasMore(): boolean {
        var c = this.channel;
        return !!c && !!(c.description || c.about || c.facts.length);
    }

    /** Builds the header and buttons from the channel (Play mix first, as YouTube does) */
    private setChannel(c: Channel): void {
        var self = this;
        this.channel = c;
        setSrc(this.banner, c.banner);
        if (!this.early) {
            setSrc(this.avatar, c.avatar);
        }
        setText(this.name, c.title);
        setText(this.subtitle, counts(c.subtitle));
        var said = short(c.description);
        setText(this.descriptionText, said);
        // As YouTube: "...more" whenever there is an About to open
        setShown(this.more, this.hasMore());
        this.said = said;
        this.fitDescription();
        this.buttonRow.innerHTML = '';
        this.buttons.clear();
        this.pageAt = {};
        this.subscribeButton = null;
        var add = function (label: string, press: () => void): HTMLElement {
            return self.buttonRow.appendChild(self.buttons.add(h('div', 'by-pill', label), press)) as HTMLElement;
        };
        if (c.mix) {
            add('Play mix', function () { self.open(c.mix as Video); });
        }
        var sub = c.subscribe;
        if (sub) {
            this.subscribeButton = add('', function () {
                // Uses the current subscription (renewHead may replace it)
                pressSubscribe(self.channel!.subscribe!, c.title, self.panel, function () {
                    self.drawSubscribe();
                    self.panel.refresh();
                });
            });
        }
        c.pages.forEach(function (p) {
            self.pageAt[self.buttons.count] = p.page;
            add(p.title, function () { self.openPage(p.page); });
        });
        this.buttons.focus(0);
        this.drawSubscribe();
        this.setFocused(this.focused);
        this.place();
        // Fade in what is new (only the rest if name and avatar were shown early), with the rows
        if (this.early) {
            fadeIn(this.subtitle);
            fadeIn(this.description);
            fadeIn(this.buttonRow);
        } else {
            fadeIn(this.head);
        }
        fadeIn(this.rowsBox);
    }

    /** Trims the description at a word until it fits three lines with "...more" (wide letters wrap sooner; a fourth
     * line would push the buttons into the rows) */
    private fitDescription(): void {
        var said = this.said;
        var line = parseFloat(window.getComputedStyle(this.description).lineHeight);
        // Not laid out while a video covers the app; fitted on show
        this.fitted = this.description.offsetHeight > 0;
        for (var i = 0; this.fitted && line && i < 8 && this.description.offsetHeight > DESCRIPTION_LINES * line + 1; i++) {
            var cut = said.lastIndexOf(' ', Math.floor(said.length * 0.85));
            said = said.slice(0, cut > 0 ? cut : Math.floor(said.length * 0.85));
            setText(this.descriptionText, said);
        }
    }

    /** Prefetches a sub page once focus has rested REST_MS on its button */
    private restSoon(): void {
        clearTimeout(this.restTimer);
        var self = this;
        this.restTimer = setTimeout(function () {
            var p = self.at === 'buttons' && self.focused && !self.panel.shown ? self.pageAt[self.buttons.at] : null;
            if (p) {
                self.ahead(p);
            }
        }, REST_MS) as unknown as number;
    }

    /** About panel: name and subscribers, full description by paragraph, facts */
    private aboutPanel(): void {
        var c = this.channel as Channel;
        var lines: PanelLine[] = [{ label: c.title, under: counts(c.subtitle) }];
        lines = lines.concat(paragraphs(c.about || c.description));
        c.facts.forEach(function (fact) {
            lines.push({ label: fact, plain: true });
        });
        this.panel.open('About', lines);
    }

    private go(at: Place): void {
        this.at = at;
        this.setFocused(this.focused);
        this.place();
    }

    /** Updates the changing header parts from a refreshed channel: counts and subscription state */
    private renewHead(c: Channel): void {
        setText(this.subtitle, counts(c.subtitle));
        if (this.channel && this.channel.subscribe && c.subscribe) {
            this.channel.subscribe = c.subscribe;
            this.drawSubscribe();
        }
    }

    /** Draws Subscribe, or Subscribed with a bell icon */
    private drawSubscribe(): void {
        var el = this.subscribeButton;
        if (el) {
            var sub = this.channel && this.channel.subscribe;
            drawSubscribe(el, sub, 'by-pill--on');
            if (sub && sub.subscribed) {
                el.insertBefore(icon('bell', 'by-pill-icon'), el.firstChild);
            }
        }
    }

    /** Focus in the header: rows start below it. Focus in the rows: the header slides away and the rows move up
     * under the search bar */
    private place(): void {
        var m = metrics();
        var inRows = this.at === 'rows';
        var down = (inRows || !this.channel ? m.channel.rowsTopDown : m.channel.rowsTop) - m.rowsTop;
        translate(this.rowsBox, 0, down);
        translate(this.head, 0, inRows ? m.channel.rowsTopDown - m.channel.rowsTop : 0);
        toggleClass(this.el, 'by-channel--rows', inRows);
    }
}

/** About three lines of a description, cut at a word end */
function short(description: string): string {
    var flat = description.replace(/\s+/g, ' ');
    if (flat.length <= DESCRIPTION_CHARS) {
        return flat;
    }
    var cut = flat.lastIndexOf(' ', DESCRIPTION_CHARS);
    return flat.slice(0, cut > 0 ? cut : DESCRIPTION_CHARS);
}

/** A channel line ("@handle • 2.68M subscribers • 1.2K videos") with counts in the theme's style, handle unchanged */
function counts(line: string): string {
    return line.split(' \u2022 ').map(function (part) { return part.charAt(0) === '@' ? part : themed(part); }).join(' \u2022 ');
}
