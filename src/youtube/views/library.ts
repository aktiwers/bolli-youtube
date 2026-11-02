// Library, laid out like YouTube's TV app: a row of coloured cards at the top
// (History, Watch Later, Playlists, …: the pages YouTube lists first, without a
// picture) above its rows (views/videos.ts FeedView). OK on a card opens its
// page. Up from the first row moves to the cards; in the rows they slide away.
// The theme sets where the rows start (metrics.libraryTop) and the look
// (by-library in themes/<id>.css).

import { h, setShown, setText, toggleClass, translate } from '../../core/dom.js';
import { KEY } from '../../core/keys.js';
import { View } from '../../core/view.js';
import { Rows, Video } from '../api/feed.js';
import { Pills } from '../ui/pills.js';
import { metrics, word } from '../ui/theme.js';
import { FeedOptions, FeedTexts, FeedView } from './videos.js';

export class LibraryView implements View {
    el: HTMLElement;
    private head: HTMLElement;
    private strip: HTMLElement;
    private rowsBox: HTMLElement;
    private feed: FeedView;
    private cards = new Pills('by-library-card--focused');
    private inHead = false;
    private focused = true;
    /** Key of the cards shown (by their pages; redrawn only when it changes) */
    private shownCards = '';

    /** load: YouTube's rows (a first row of pages without pictures becomes the cards); open: OK on a tile or card */
    constructor(load: () => Promise<Rows | null>, texts: FeedTexts, private open: (video: Video) => void, opts: FeedOptions) {
        var self = this;
        this.el = h('div', 'by-library');
        this.rowsBox = h('div', 'by-library-rows');
        this.el.appendChild(this.rowsBox);
        this.head = h('div', 'by-library-head');
        this.strip = h('div', 'by-library-strip');
        this.head.appendChild(this.strip);
        this.el.appendChild(this.head);
        var kept = opts.kept;
        opts.kept = kept && function () {
            var k = kept!();
            return k && { rows: self.split(k.rows), same: k.same };
        };
        // Row spacing as in YouTube's Library
        opts.spacing = metrics().library;
        this.feed = new FeedView(function () {
            return load().then(function (rows) { return rows && self.split(rows); });
        }, texts, open, opts);
        this.rowsBox.appendChild(this.feed.el);
        setShown(this.el, false);
        this.place();
    }

    get settled(): boolean {
        return this.feed.settled;
    }

    show(rest?: boolean): void {
        setShown(this.el, true);
        this.feed.show(rest);
    }

    hide(): void {
        setShown(this.el, false);
        this.feed.hide();
    }

    cover(covered: boolean): void {
        this.feed.cover(covered);
    }

    renewIfOld(): void {
        this.feed.renewIfOld();
    }

    prepare(): void {
        this.feed.prepare();
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

    retry(quiet?: boolean): boolean {
        return this.feed.retry(quiet);
    }

    reload(): void {
        this.feed.reload();
    }

    setFocused(focused: boolean): void {
        this.focused = focused;
        this.feed.setFocused(focused && !this.inHead);
        this.cards.setFocused(focused && this.inHead);
    }

    focusedVideo(): Video | null {
        return this.inHead ? null : this.feed.focusedVideo();
    }

    onKey(code: number): boolean {
        if (!this.inHead) {
            if (this.feed.onKey(code)) {
                this.place();
                return true;
            }
            if (code === KEY.UP && this.cards.count) {
                this.go(true);
                return true;
            }
            return false;
        }
        switch (code) {
            case KEY.LEFT:
            case KEY.RIGHT:
                // Left past the first card goes to the rail
                if (this.cards.move(code === KEY.LEFT ? -1 : 1)) {
                    this.scroll();
                    return true;
                }
                return code === KEY.RIGHT;
            case KEY.OK:
                this.cards.press();
                return true;
            case KEY.DOWN:
                if (this.feed.hasRows) {
                    this.go(false);
                }
                return true;
            case KEY.UP:
                return true;
        }
        return false;
    }

    private go(inHead: boolean): void {
        this.inHead = inHead;
        this.setFocused(this.focused);
        this.place();
    }

    /** rows without the first row when it is the cards (which are drawn, if changed) */
    private split(rows: Rows): Rows {
        var first = rows.shelves[0];
        var cards = first && !first.title && first.videos.every(function (v) { return !!v.page && !v.image; }) ? first.videos : null;
        if (!cards) {
            return rows;
        }
        this.drawCards(cards);
        var rest: Rows = { title: rows.title, shelves: [], next: '' };
        for (var key in rows) {
            (rest as any)[key] = (rows as any)[key];
        }
        rest.shelves = rows.shelves.slice(1);
        return rest;
    }

    private drawCards(list: Video[]): void {
        var key = list.map(function (v) { return v.id; }).join('|');
        if (key === this.shownCards) {
            return;
        }
        // First cards drawn: focus them, as YouTube does (on the first, History)
        if (!this.shownCards) {
            this.go(true);
        }
        this.shownCards = key;
        var self = this;
        var at = this.cards.at;
        this.strip.innerHTML = '';
        this.cards.clear();
        list.forEach(function (v, i) {
            var card = h('div', 'by-library-card by-library-card--' + i % 6);
            setText(card, word(v.title));
            self.strip.appendChild(self.cards.add(card, function () { self.open(v); }));
        });
        this.cards.focus(Math.min(at, list.length - 1));
        this.cards.setFocused(this.focused && this.inHead);
        this.scroll();
        this.place();
    }

    /** Scrolls the cards so the focused one is in view */
    private scroll(): void {
        var step = metrics().libraryStep;
        var inView = Math.floor((1280 - metrics().rows.pad) / step);
        translate(this.strip, -Math.max(0, this.cards.at - inView + 1) * step, 0);
    }

    /** Positions the cards and rows for where the focus is */
    private place(): void {
        var m = metrics();
        var cards = this.cards.count > 0;
        // Cards shown while focused, the rows under them; in the rows (the first too, as in YouTube's) the cards slide
        // up out of sight and the focused row sits at library.rowsTop
        var shown = this.inHead || !cards;
        var under = cards ? m.libraryTop - m.rowsTop : 0;
        translate(this.rowsBox, 0, shown ? under : m.library.rowsTop - m.rowsTop);
        translate(this.head, 0, shown ? 0 : m.library.rowsTop - m.libraryTop);
        toggleClass(this.el, 'by-library--rows', !shown);
    }
}
