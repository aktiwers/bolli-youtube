// Marks on a progress bar, as in YouTube's player: SponsorBlock segments (a stripe each in its category's colour,
// as in the SponsorBlock extension: themes/<id>.css .by-sb--sponsor …) and chapter breaks (a gap where each chapter
// after the first begins: .by-chapter-gap), plus the current chapter's name (chapterAt). Chapters come with the
// watch page details (api/watch.ts).

import { h } from '../../core/dom.js';
import { Segment } from '../api/sponsorblock.js';
import { Chapter } from '../api/watch.js';

export class BarMarks {
    private el: HTMLElement;

    /** Inserted into bar before the given element (null: last) */
    constructor(bar: HTMLElement, before: Node | null) {
        this.el = h('div', 'by-bar-marks');
        bar.insertBefore(this.el, before);
    }

    /** Draws the segments and chapters of a video of duration s (nothing when the duration is unknown) */
    draw(segments: Segment[], chapters: Chapter[], duration: number): void {
        this.el.innerHTML = '';
        if (!(duration > 0)) {
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

    /** Adds a mark at start (s) in a video of duration */
    private mark(className: string, start: number, duration: number): HTMLElement {
        var el = h('div', className);
        el.style.left = (start / duration * 100).toFixed(3) + '%';
        return this.el.appendChild(el) as HTMLElement;
    }
}

/** The name of the chapter playing at t ('' none) */
export function chapterAt(chapters: Chapter[], t: number): string {
    var name = '';
    for (var i = 0; i < chapters.length && chapters[i].start <= t; i++) {
        name = chapters[i].title;
    }
    return name;
}
