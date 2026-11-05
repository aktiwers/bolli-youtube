// The videos the player plays in order (a mix, a phone's list): Next, Previous and what comes at the end.

import { Video, videoOf } from '../api/feed.js';

/** Videos played in order (a mix, a phone's list) for Next, Previous and the end; at: the index playing (-1: before
 * the first) */
export class ListQueue {
    at: number;

    /** ids in order, starting at id (if absent: before the first); wrap: back to the first after the last */
    constructor(public ids: string[], id: string, private wrap?: boolean) {
        this.at = ids.indexOf(id);
    }

    next(): Video | null {
        return this.to(this.after());
    }

    /** The next video (null: none), without moving */
    peek(): Video | null {
        var i = this.after();
        return i < this.ids.length ? videoOf(this.ids[i]) : null;
    }

    /** The index after the current one (0 after the last when wrapping) */
    private after(): number {
        return this.wrap && this.at + 1 >= this.ids.length ? 0 : this.at + 1;
    }

    previous(): Video | null {
        return this.to(this.at - 1);
    }

    /** Move to index i and return its video (null: out of range) */
    private to(i: number): Video | null {
        if (i < 0 || i >= this.ids.length) {
            return null;
        }
        this.at = i;
        return videoOf(this.ids[i]);
    }
}
