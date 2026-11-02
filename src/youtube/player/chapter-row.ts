// The chapter row, as in YouTube's TV player: a video's chapters as cards in a row over the info bar's time line
// (YouTube's picture of each with its start time over it, its name under it), the selected one ringed. The row
// scrolls to keep the selected card in the middle; pictures load only for the cards in view and one on either side.

import { h, toggleClass, translate } from '../../core/dom.js';
import { clock } from '../../core/time.js';
import { Chapter } from '../api/watch.js';

/** A card's width and the gap after it (layout px, as app.css .by-chapter), and how many show at once: seven fill the
 * info bar's 1168 px exactly */
var CARD = 154;
var GAP = 15;
var SHOWN = 7;

export class ChapterRow {
    private el: HTMLElement;
    private strip: HTMLElement;
    private chapters: Chapter[] = [];
    /** The cards and their pictures (made once per video, when first needed) */
    private cards: HTMLElement[] = [];
    private pictures: HTMLImageElement[] = [];
    /** The selected chapter (-1: closed) */
    private at = -1;

    /** In parent, before before */
    constructor(parent: HTMLElement, before: Node | null) {
        this.el = h('div', 'by-chapters');
        this.strip = this.el.appendChild(h('div', 'by-chapters-strip')) as HTMLElement;
        parent.insertBefore(this.el, before);
    }

    /** The video has chapters */
    get has(): boolean {
        return this.chapters.length > 0;
    }

    get open(): boolean {
        return this.at >= 0;
    }

    /** The selected chapter (null: closed) */
    get selected(): Chapter | null {
        return this.at >= 0 ? this.chapters[this.at] : null;
    }

    /** The video's chapters (other ones close the row) */
    set(chapters: Chapter[]): void {
        if (chapters !== this.chapters) {
            this.close();
            this.chapters = chapters;
            this.cards = [];
            this.pictures = [];
            this.strip.innerHTML = '';
        }
    }

    /** Opens with the chapter playing at t (s) selected */
    openAt(t: number): void {
        this.make();
        toggleClass(this.el, 'by-chapters--open', true);
        this.select(indexAt(this.chapters, t));
    }

    /** Selects the chapter before (way -1) or after (1), if any */
    move(way: number): void {
        this.select(Math.max(0, Math.min(this.chapters.length - 1, this.at + way)));
    }

    close(): void {
        if (this.at >= 0) {
            toggleClass(this.cards[this.at], 'by-chapter--selected', false);
        }
        this.at = -1;
        toggleClass(this.el, 'by-chapters--open', false);
    }

    /** The pictures around the chapter playing at t (s) fetched ahead, so the row opens with them */
    prefetch(t: number): void {
        if (this.has) {
            this.make();
            this.load(first(indexAt(this.chapters, t), this.chapters.length));
        }
    }

    private select(at: number): void {
        if (this.at >= 0) {
            toggleClass(this.cards[this.at], 'by-chapter--selected', false);
        }
        this.at = at;
        toggleClass(this.cards[at], 'by-chapter--selected', true);
        var from = first(at, this.chapters.length);
        translate(this.strip, -from * (CARD + GAP), 0);
        this.load(from);
    }

    /** The pictures of the cards shown from card from on, and of one on either side */
    private load(from: number): void {
        for (var i = Math.max(0, from - 1); i < Math.min(this.chapters.length, from + SHOWN + 1); i++) {
            if (this.chapters[i].picture && !this.pictures[i].getAttribute('src')) {
                this.pictures[i].src = this.chapters[i].picture;
            }
        }
    }

    /** The cards, without their pictures (once per video) */
    private make(): void {
        if (this.cards.length) {
            return;
        }
        for (var i = 0; i < this.chapters.length; i++) {
            var card = h('div', 'by-chapter');
            var frame = card.appendChild(h('div', 'by-chapter-frame'));
            this.pictures.push(frame.appendChild(h('img', 'by-chapter-img')) as HTMLImageElement);
            frame.appendChild(h('div', 'by-chapter-time', clock(this.chapters[i].start)));
            card.appendChild(h('div', 'by-chapter-title', this.chapters[i].title));
            this.cards.push(this.strip.appendChild(card) as HTMLElement);
        }
    }
}

/** The first card shown while card at is selected: at in the middle, else as near it as the row's ends allow */
function first(at: number, count: number): number {
    return Math.max(0, Math.min(at - (SHOWN - 1) / 2, count - SHOWN));
}

/** The chapter playing at t (s): the last one begun by then (the first before it begins) */
function indexAt(chapters: Chapter[], t: number): number {
    var at = 0;
    for (var i = 1; i < chapters.length && chapters[i].start <= t; i++) {
        at = i;
    }
    return at;
}
