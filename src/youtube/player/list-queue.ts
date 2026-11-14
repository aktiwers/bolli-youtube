// The videos the player plays in order (a mix, a phone's list, a playlist's page): Next, Previous and what comes at
// the end. A playlist's queue knows the playlist (its name and videos, for the player to show) and asks for more of it
// as it nears its end.

import { PlaylistInfo, Video, videoOf } from '../api/feed.js';

/** A playlist's queue asks for more this many videos before its end */
var NEAR = 3;

/** Videos played in order (a mix, a phone's list) for Next, Previous and the end; at: the index playing (-1: before
 * the first) */
export class ListQueue {
    at: number;
    /** The playlist it plays (null: a mix, a phone's list) */
    playlist: PlaylistInfo | null = null;
    /** Called as it nears its end (a playlist's page loads more: add) */
    onNear: (() => void) | null = null;

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

    /** Plays on from video id where it is in the queue (false: not in it) */
    goTo(id: string): boolean {
        return !!this.to(this.ids.indexOf(id));
    }

    /** Only the videos in kept stay (others gone from the list: deleted), the one playing in any case, still playing */
    keep(kept: { [id: string]: boolean }): void {
        var now = this.at >= 0 ? this.ids[this.at] : '';
        this.ids = this.ids.filter(function (id) { return kept[id] || id === now; });
        this.at = now ? this.ids.indexOf(now) : this.at;
    }

    /** More videos at the end (a playlist's next part; those queued already are left out) */
    add(ids: string[]): void {
        var have: { [id: string]: boolean } = {};
        this.ids.forEach(function (id) { have[id] = true; });
        this.ids = this.ids.concat(ids.filter(function (id) { return !have[id]; }));
    }

    /** Near its end: asks for more */
    ask(): void {
        if (this.onNear && this.ids.length - 1 - this.at < NEAR) {
            this.onNear();
        }
    }

    /** Move to index i and return its video (null: out of range) */
    private to(i: number): Video | null {
        if (i < 0 || i >= this.ids.length) {
            return null;
        }
        this.at = i;
        this.ask();
        return videoOf(this.ids[i]);
    }
}
