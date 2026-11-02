// The account's screens as last fetched (Home, Subscriptions, Library), kept across starts: a
// screen shows them at once while it fetches fresh rows (views/videos.ts), so the first screen
// waits neither for YouTube's reply (~1.2 s) nor for youtube.com's frame (~0.26 s; the account
// is known from there, so the rows show first and are dropped if they were another account's).
// Stored with a hash of their account in localStorage (bolli.v1.youtube.rows.<screen>).

import { load, save } from '../../core/store.js';
import { Rows } from './feed.js';

var KEY = 'youtube.rows.';
/** Bumped when Rows change shape, so rows kept by an older build are not drawn; kept channel pages use it too
 * (api/channel.ts) */
export var VERSION = 2;

export interface Kept {
    rows: Rows;
    /** The account's hash */
    account: string;
    v?: number;
}

/** The rows kept for screen (null: none) */
export function keptRows(screen: string): Kept | null {
    var kept = load<Kept>(KEY + screen);
    return kept && kept.v === VERSION && kept.rows && kept.rows.shelves ? kept : null;
}

/** kept was fetched for account */
export function keptFor(kept: Kept, account: string): boolean {
    return kept.account === hash(account);
}

/** Only the first rows are kept (the rest come with the fresh ones), so a start reads and parses little */
var SHELVES_KEPT = 4;
var VIDEOS_KEPT = 16;

/** Keeps screen's rows fetched for account */
export function keepRows(screen: string, account: string, rows: Rows): void {
    var kept: Rows = {
        title: rows.title,
        next: rows.next,
        tabs: rows.tabs,
        channels: rows.channels,
        nudge: rows.nudge,
        // Shape, subtitle and icon too: else square rows and games' boxes draw as plain ones until the fresh rows arrive
        shelves: rows.shelves.slice(0, SHELVES_KEPT).map(function (s) {
            return { title: s.title, videos: s.videos.slice(0, VIDEOS_KEPT), grid: s.grid, next: s.next, style: s.style, subtitle: s.subtitle, icon: s.icon };
        })
    };
    save(KEY + screen, { v: VERSION, account: hash(account), rows: kept });
}

/** A short hash of text (djb2) */
export function hash(text: string): string {
    var h = 5381;
    for (var i = 0; i < text.length; i++) {
        h = (h * 33 + text.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(36);
}
