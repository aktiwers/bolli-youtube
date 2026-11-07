// The chapter row, as in YouTube's TV player: a video's chapters as cards in a row over the info bar's time line
// (a picture of each with its start time over it, its name under it), the selected one ringed. The picture is the
// video's frame where the chapter begins, from its storyboard (YouTube's TV replies give every chapter the video's
// own thumbnail), or YouTube's picture of the chapter where those differ. The row scrolls to keep the selected card
// in the middle; pictures load only for the cards in view and one on either side (while the row is closed, through
// pictures of their own: a hidden card's background is not fetched). A click (the Magic Remote's pointer) on a card
// selects it, a second plays from it (own-player.ts), as YouTube's.

import { h, toggleClass, translate } from '../core/dom.js';
import { clock } from '../core/time.js';
import { Storyboard, StoryboardFrame, storyboardFrame } from '../api/streams.js';
import { Chapter } from '../api/watch.js';
import { chapterIndex } from './bar-marks.js';
import { paintFrame } from './seek-preview.js';

/** A card's width, the gap after it and its picture's height (layout px), and how many cards show at once: seven fill
 * the info bar's 1168 px exactly */
var CARD = 154;
var GAP = 15;
var PICTURE = 87;
var SHOWN = 7;

export class ChapterRow {
    private el: HTMLElement;
    private strip: HTMLElement;
    private chapters: Chapter[] = [];
    /** The cards and their pictures (made once per video, when first needed), and what each picture shows */
    private cards: HTMLElement[] = [];
    private pictures: HTMLElement[] = [];
    private painted: string[] = [];
    /** YouTube's pictures of the chapters differ (else the storyboard's frames show) */
    private own = false;
    /** The video's storyboard (null: none, as for a live stream) */
    private board: Storyboard | null = null;
    /** The sheets fetched ahead (prefetch) */
    private warm: HTMLImageElement[] = [];
    /** The selected chapter (-1: closed) */
    private at = -1;

    /** Before before (the info bar's time line) */
    constructor(before: Node) {
        this.el = h('div', 'by-chapters');
        this.strip = this.el.appendChild(h('div', 'by-chapters-strip')) as HTMLElement;
        before.parentNode!.insertBefore(this.el, before);
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
        if (chapters === this.chapters || !chapters.length && !this.chapters.length) {
            return;
        }
        this.close();
        this.chapters = chapters;
        this.own = chapters.some(function (c) { return c.picture !== chapters[0].picture; });
        this.cards = [];
        this.pictures = [];
        this.painted = [];
        // (the previous video's sheets let go)
        this.warm.forEach(function (picture) { picture.removeAttribute('src'); });
        this.warm = [];
        this.strip.innerHTML = '';
    }

    /** The video's storyboard, for the chapters' frames */
    setFrames(sb: Storyboard | null): void {
        if (sb !== this.board) {
            this.board = sb;
            this.painted = [];
        }
    }

    /** Opens with the chapter playing at t (s) selected */
    openAt(t: number): void {
        this.make();
        toggleClass(this.el, 'by-chapters--open', true);
        this.select(Math.max(0, chapterIndex(this.chapters, t)));
    }

    /** The card target is in (-1: none; the row closed) */
    cardAt(target: HTMLElement): number {
        for (var i = 0; this.open && i < this.cards.length; i++) {
            if (this.cards[i].contains(target)) {
                return i;
            }
        }
        return -1;
    }

    /** Selects chapter index (a click on its card); false: it was selected already */
    pick(index: number): boolean {
        if (index === this.at) {
            return false;
        }
        this.select(index);
        return true;
    }

    /** Selects the chapter before (way -1) or after (1), if any */
    move(way: number): void {
        this.select(Math.max(0, Math.min(this.chapters.length - 1, this.at + way)));
    }

    close(): void {
        this.mark(false);
        this.at = -1;
        toggleClass(this.el, 'by-chapters--open', false);
    }

    /** The pictures around the chapter playing at t (s) fetched ahead, so the row opens with them */
    prefetch(t: number): void {
        if (!this.has) {
            return;
        }
        this.make();
        var from = first(Math.max(0, chapterIndex(this.chapters, t)), this.chapters.length);
        this.load(from);
        var urls: string[] = [];
        for (var i = Math.max(0, from - 1); i < Math.min(this.chapters.length, from + SHOWN + 1); i++) {
            var url = this.pictureOf(this.chapters[i]);
            if (url && urls.indexOf(url) < 0) {
                urls.push(url);
            }
        }
        this.warm = urls.map(function (u) {
            var picture = new Image();
            picture.src = u;
            return picture;
        });
    }

    private select(at: number): void {
        this.mark(false);
        this.at = at;
        this.mark(true);
        var from = first(at, this.chapters.length);
        translate(this.strip, -from * (CARD + GAP), 0);
        this.load(from);
    }

    /** The selected card's ring on or off */
    private mark(on: boolean): void {
        if (this.at >= 0) {
            toggleClass(this.cards[this.at], 'by-chapter--selected', on);
        }
    }

    /** The pictures of the cards shown from card from on, and of one on either side (each drawn once) */
    private load(from: number): void {
        var sb = this.board;
        for (var i = Math.max(0, from - 1); i < Math.min(this.chapters.length, from + SHOWN + 1); i++) {
            var c = this.chapters[i];
            var f = this.frameOf(c);
            var shows = f ? f.url + ' ' + f.col + ' ' + f.row : c.picture || '';
            if (this.painted[i] === shows) {
                continue;
            }
            this.painted[i] = shows;
            var style = this.pictures[i].style;
            if (f && sb) {
                paintFrame(style, sb, f, CARD, PICTURE, Math.max(CARD / sb.w, PICTURE / sb.h), true);
            } else if (c.picture) {
                style.backgroundImage = 'url("' + c.picture + '")';
                style.backgroundSize = 'cover';
                style.backgroundPosition = '50% 50%';
            }
        }
    }

    /** The storyboard's frame where chapter c begins (its first a second or more into it: its very start is often a
     * cut or black; the middle of that frame's time, so rounding never gives the one before); null: YouTube's
     * pictures of the chapters differ, or no storyboard */
    private frameOf(c: Chapter): StoryboardFrame | null {
        var sb = this.board;
        return sb && !this.own ? storyboardFrame(sb, (Math.ceil((c.start + 1) * 1000 / sb.interval) + 0.5) * sb.interval / 1000) : null;
    }

    /** The picture chapter c's card shows: a storyboard sheet, or YouTube's picture of it ('' none) */
    private pictureOf(c: Chapter): string {
        var f = this.frameOf(c);
        return f ? f.url : c.picture || '';
    }

    /** The cards, without their pictures (once per video) */
    private make(): void {
        if (this.cards.length) {
            return;
        }
        for (var i = 0; i < this.chapters.length; i++) {
            var card = h('div', 'by-chapter');
            card.style.width = CARD + 'px';
            card.style.marginRight = GAP + 'px';
            var frame = card.appendChild(h('div', 'by-chapter-frame')) as HTMLElement;
            frame.style.height = PICTURE + 'px';
            this.pictures.push(frame.appendChild(h('div', 'by-chapter-img')) as HTMLElement);
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
