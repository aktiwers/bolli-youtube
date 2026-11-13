// The blue dot on a channel in Subscriptions' list. YouTube marks a channel that has new videos (api/feed.ts
// SubChannel.fresh) until the channel's own list in Subscriptions is asked for, which YouTube's app does when the
// channel is chosen there. This app opens the channel's page instead and plays its videos from the rows, which tells
// YouTube nothing: the dots stayed for good. So a channel looked at here (its page opened, its newest video started)
// loses its dot at once, and YouTube is asked for its list in the background, the reply unused: one request per
// channel looked at, one at a time and SPACE_MS apart. Each is noted with its time (localStorage
// bolli.v1.youtube.looked): a list YouTube sent before it (the rows kept from the last start, a reply already on its
// way) still has the dot and is put right by the note; a list sent after it is YouTube's word again, so a video
// newer than the look brings the dot back. A channel's page opened while no list marks the channel (none yet, or
// one from before its new video) is remembered a while (visited), and counts when a list that marks it comes.

import { load, save } from '../core/store.js';
import { browseText, Page, pageKey, SubChannel } from './feed.js';

var KEY = 'youtube.looked';
/** Between two channels told to YouTube */
var SPACE_MS = 3000;
/** A list asked for this soon after YouTube was told may not have it yet: the note still counts for it */
var SETTLE_MS = 10000;
/** The most notes kept (the newest) */
var NOTES = 300;
/** A page opened counts for the lists that come this long after */
var VISIT_MS = 60 * 60 * 1000;

/** When YouTube had been told of each channel looked at, by the channel's key (null: not read yet) */
var notes: { [key: string]: number } | null = null;
/** The channels being told, or waiting for it */
var telling: { [key: string]: boolean } = {};
var waiting: SubChannel[] = [];
var busy = false;
/** Counts the accounts (forgetLooks): what an earlier one's request brings is not noted */
var account = 0;
/** The channels' pages opened of late (this run of the app), by page: when, and whether opening it told YouTube by
 * itself (the page being the channel's list in Subscriptions) */
var visits: { [page: string]: { at: number; told: boolean } } = {};

/** What a channel of the list is known by: its list's params (they hold its id), else its name */
export function channelKey(c: SubChannel): string {
    return c.page.params || c.title;
}

function noted(): { [key: string]: number } {
    notes = notes || load<{ [key: string]: number }>(KEY) || {};
    return notes;
}

/** A channel's page p was opened (its channel page, or its list in Subscriptions; told: that list was asked for,
 * which tells YouTube): the channel counts as looked at in the lists settled from now on */
export function visited(p: Page, told?: boolean): void {
    visits[pageKey(p)] = { at: Date.now(), told: !!told };
}

/** c, marked as having new videos, was looked at now: YouTube is told (settle then takes its dot from every list) */
export function looked(c: SubChannel): void {
    var key = channelKey(c);
    if (!c.fresh || telling[key]) {
        return;
    }
    telling[key] = true;
    waiting.push(c);
    tell();
}

/** Notes that YouTube was told of the channel known by key at the time at */
function note(key: string, at: number): void {
    var all = noted();
    all[key] = Math.max(all[key] || 0, at + SETTLE_MS);
    var keys = Object.keys(all);
    if (keys.length > NOTES) {
        keys.sort(function (a, b) { return all[a] - all[b]; }).slice(0, keys.length - NOTES).forEach(function (k) { delete all[k]; });
    }
    save(KEY, all);
}

function tell(): void {
    var c = waiting[0];
    if (busy || !c) {
        return;
    }
    busy = true;
    waiting.shift();
    var key = channelKey(c);
    var of = account;
    var done = function (told: boolean): void {
        // (another account since: its lists are not this one's)
        if (of === account) {
            delete telling[key];
            if (told) {
                note(key, Date.now());
            }
        }
        // (not told: the next list from YouTube has the dot again)
        setTimeout(function () {
            busy = false;
            tell();
        }, SPACE_MS);
    };
    browseText(c.page).then(function () { done(true); }, function () { done(false); });
}

/** Takes the dot from the channels of a list that were looked at since YouTube made it; asked: when YouTube was
 * asked for the list (0: kept from an earlier start). A list from YouTube replaces the kept one, so the notes older
 * than it have done their work and go, as do the pages opened before it */
export function settle(channels: SubChannel[], asked: number): void {
    var all = noted();
    var now = Date.now();
    var changed = false;
    channels.forEach(function (c) {
        var key = channelKey(c);
        // (a note from a clock that ran ahead would hide the dot for as long)
        if (all[key] > now + SETTLE_MS) {
            delete all[key];
            changed = true;
        }
        var own = pageKey(c.page);
        var page = c.channel ? pageKey(c.channel) : own;
        var visit = visits[own] || visits[page];
        if (c.fresh && visit && now - visit.at < VISIT_MS) {
            if (visit.told) {
                note(key, visit.at);
            } else {
                looked(c);
            }
            // (once: a dot in a later list is a video newer than the look)
            delete visits[own];
            delete visits[page];
        }
        if (c.fresh && (telling[key] || all[key] >= asked)) {
            c.fresh = false;
        }
    });
    Object.keys(visits).forEach(function (page) {
        if (visits[page].at < asked || now - visits[page].at >= VISIT_MS) {
            delete visits[page];
        }
    });
    if (asked) {
        Object.keys(all).forEach(function (key) {
            if (all[key] < asked) {
                delete all[key];
                changed = true;
            }
        });
    }
    if (changed) {
        save(KEY, all);
    }
}

/** Another account from now on: what was looked at was the one before's (its notes, its pages opened, the channels
 * still waiting to be told) */
export function forgetLooks(): void {
    account++;
    notes = {};
    save(KEY, notes);
    telling = {};
    waiting = [];
    visits = {};
}
