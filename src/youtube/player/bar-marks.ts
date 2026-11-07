// Marks on a progress bar, as in YouTube's player: SponsorBlock segments (a stripe each in its category's colour,
// as in the SponsorBlock extension: themes/<id>.css .by-sb--sponsor …) and chapter breaks (a gap where each chapter
// after the first begins: .by-chapter-gap), and the name of the part at a time (nameAt). Chapters come with the
// watch page details (api/watch.ts).

import { h } from '../core/dom.js';
import { Segment, segmentAt, segmentName } from '../api/sponsorblock.js';
import { Chapter } from '../api/watch.js';

export class BarMarks {
    private el: HTMLElement;
    /** What is drawn, so an unchanged redraw is skipped (emptying and refilling the bar flickers on the TV) */
    private drawn = '';
    private segments: Segment[] = [];
    private chapters: Chapter[] = [];

    /** Inserted into bar before the given element (null: last) */
    constructor(bar: HTMLElement, before: Node | null) {
        this.el = h('div', 'by-bar-marks');
        bar.insertBefore(this.el, before);
    }

    /** Draws the segments and chapters of a video of duration s (nothing when the duration is unknown) */
    draw(segments: Segment[], chapters: Chapter[], duration: number): void {
        this.segments = segments;
        this.chapters = chapters;
        var key = duration > 0 ? duration.toFixed(1) + '|' + segments.map(function (s) { return s.category + s.start + '-' + s.end; }).join() +
            '|' + chapters.map(function (c) { return c.start; }).join() : '';
        if (key === this.drawn) {
            return;
        }
        this.drawn = key;
        this.el.innerHTML = '';
        if (!key) {
            return;
        }
        for (var i = 0; i < segments.length; i++) {
            var s = segments[i];
            this.mark('by-sb by-sb--' + s.category, s.start, duration).style.width = ((Math.min(s.end, duration) - s.start) / duration * 100).toFixed(3) + '%';
        }
        for (var k = 1; k < chapters.length; k++) {
            if (chapters[k].start < duration) {
                this.mark('by-chapter-gap', chapters[k].start, duration);
            }
        }
    }

    /** The name shown after the time at t: the SponsorBlock segment's there, else the chapter's ('' none) */
    nameAt(t: number): string {
        var at = segmentAt(this.segments, t, {});
        var chapter = chapterIndex(this.chapters, t);
        return at >= 0 ? segmentName(this.segments[at]) : chapter >= 0 ? this.chapters[chapter].title : '';
    }

    /** Adds a mark at start (s) in a video of duration */
    private mark(className: string, start: number, duration: number): HTMLElement {
        var el = h('div', className);
        el.style.left = (start / duration * 100).toFixed(3) + '%';
        return this.el.appendChild(el) as HTMLElement;
    }
}

/** The chapter playing at t: the last one begun by then (-1: none yet) */
export function chapterIndex(chapters: Chapter[], t: number): number {
    var at = -1;
    for (var i = 0; i < chapters.length && chapters[i].start <= t; i++) {
        at = i;
    }
    return at;
}

/** Where a chapter jump from t lands: the next chapter's start (way 1), or (way -1) the start of the chapter t is in,
 * or of the one before when t is within 3 s of its start; -1: none that way */
export function chapterJump(chapters: Chapter[], t: number, way: number): number {
    if (way > 0) {
        for (var i = 0; i < chapters.length; i++) {
            if (chapters[i].start > t + 1) {
                return chapters[i].start;
            }
        }
        return -1;
    }
    for (var k = chapters.length - 1; k >= 0; k--) {
        if (chapters[k].start < t - 3) {
            return chapters[k].start;
        }
    }
    return -1;
}
