// The playlist a phone casts from (cast.ts), for the player to show (its list at the side, the watch page's row). The
// phone sends every video's id and names its own queue ("RQ…", not the playlist: YouTube refuses that id as a
// playlist's page, seen on the TV 2026-11-14), so the list is made of the phone's ids, each video known only by its id
// until its title comes. The titles come with the videos' own requests: a video asked for with the queue named
// (api/watch.ts watchFrom) is answered with some twenty of the queue's videos around it, which are put in their places
// here. All the titles are asked for at the cast, one request at a time, from the video playing outward (fillAll: one
// video's details bring some twenty, so about one request for each twenty videos, up to MAX_FILLED of them); the
// player's list also asks for those of the lines it shows that have none, where the viewer stops (titles). Each video
// is asked for once, and every view of the list is told when titles came (listen), so none of them asks again.
// YouTube leaves out of its answer the videos it no longer has (deleted, made private: seen on the TV 2026-11-14, two
// such places skipped in a stretch of twenty), as the phone's app hides them: a video of the list between the first
// and last of an answer that is not in it is dropped from the list (the cast drops it from the queue too).

import { PlaylistInfo, thumbnail, Video, videoOf } from './feed.js';

/** The videos around the one playing whose titles are asked for at the cast (half before, half after it) */
export var MAX_FILLED = 500;
/** Failures in a row that end the asking at the cast (a list whose videos YouTube does not answer for) */
var FAILS_MAX = 3;
/** How far on from the first video without a title the one asked for is: YouTube sends some nine to each side of it
 * (16 to 19 in all, seen on the TV 2026-11-14), so each answer is all new titles */
var REACH = 9;

/** What YouTube sent of the queue around a video */
type Around = { queue?: { title: string; videos: Video[] } };

/** The videos of ids, those in known as they are, the others by their id alone, each with its picture from its id (the
 * side list shows it at once) */
function videosOf(ids: string[], known: { [id: string]: Video }): Video[] {
    return ids.map(function (id) {
        if (known[id]) {
            return known[id];
        }
        var v = videoOf(id);
        v.image = thumbnail(id);
        v.bare = true;
        return v;
    });
}

/** The phone's list as a playlist: ids in order, named title until YouTube's own name for it is in; the videos known
 * from the list before it (had: a list of the same queue that changed) keep what is known of them. around: asks
 * YouTube for the queue around a video (titles) */
export function listed(ids: string[], listId: string, title: string, had?: PlaylistInfo | null, around?: (id: string) => Promise<Around>): PlaylistInfo {
    var known: { [id: string]: Video } = {};
    if (had && had.id === listId) {
        had.videos.forEach(function (v) { known[v.id] = v; });
    }
    var list: PlaylistInfo = { title: had && had.id === listId ? had.title : title, count: ids.length, videos: videosOf(ids, known), id: listId };
    if (around) {
        var info = around;
        // (each video asked for once: one that failed may be asked again; a failure is a rejection, for fillAll)
        var asked: { [id: string]: boolean } = {};
        var listeners: (() => void)[] = [];
        var tell = function (): void {
            listeners.slice().forEach(function (fn) { fn(); });
        };
        // from: the video's details asked for already (the one playing: the player's own request), else asked here
        list.titles = function (id: string, from?: Promise<Around>): Promise<boolean> {
            if (asked[id]) {
                return Promise.resolve(false);
            }
            asked[id] = true;
            return (from || info(id)).then(function (got) {
                var changed = got.queue ? titled(list, got.queue) : false;
                if (changed) {
                    tell();
                }
                return changed;
            }, function (e) {
                delete asked[id];
                throw e;
            });
        };
        list.relist = function (now: string[]): void {
            var have: { [id: string]: Video } = {};
            list.videos.forEach(function (v) { have[v.id] = v; });
            list.videos = videosOf(now, have);
            list.count = now.length;
            tell();
        };
        list.listen = function (fn: () => void): () => void {
            listeners.push(fn);
            return function () {
                listeners = listeners.filter(function (one) { return one !== fn; });
            };
        };
    }
    return list;
}

/** The place of the video without a title nearest to place at, within from..to (asked: those not to be taken), or -1:
 * outward from at, after before before */
export function nearestUntitled(videos: { id: string; title: string }[], at: number, from: number, to: number, asked?: { [id: string]: boolean }): number {
    for (var d = 0; at - d >= from || at + d <= to; d++) {
        var after = at + d;
        if (after <= to && !videos[after].title && !(asked && asked[videos[after].id])) {
            return after;
        }
        var before = at - d;
        if (d && before >= from && !videos[before].title && !(asked && asked[videos[before].id])) {
            return before;
        }
    }
    return -1;
}

/** Asks for all the titles of list (one made with a way to ask) from the video at place `at` outward, one request at a
 * time: each time for the video REACH on from the nearest without a title (away from `at`), within MAX_FILLED around
 * it. Ends when all of those have titles, after FAILS_MAX failures in a row, or when stopped (the function returned: the
 * phone sent another list) */
export function fillAll(list: PlaylistInfo, at: number): () => void {
    var stopped = false;
    var tried: { [id: string]: boolean } = {};
    var fails = 0;
    // (MAX_FILLED videos around the one playing, the stretch moved to fit within the list: near its end, more before)
    var from = Math.max(0, Math.min(at - MAX_FILLED / 2, list.videos.length - MAX_FILLED));
    var to = Math.min(list.videos.length - 1, from + MAX_FILLED - 1);
    var next = function (): void {
        if (stopped || !list.titles) {
            return;
        }
        var videos = list.videos;
        var i = nearestUntitled(videos, at, from, Math.min(to, videos.length - 1), tried);
        if (i < 0) {
            return;
        }
        // (REACH on, where that one is in the list, without a title and not asked yet)
        var on = i === at ? i : i > at ? Math.min(to, videos.length - 1, i + REACH) : Math.max(from, i - REACH);
        var far = videos[on];
        var id = far && !far.title && !tried[far.id] ? far.id : videos[i].id;
        tried[id] = true;
        // (an answer that brought nothing, YouTube's queue not in it, counts as a failure: else every video would be
        // asked for in turn)
        list.titles(id).then(function (changed) {
            fails = changed ? 0 : fails + 1;
            if (fails < FAILS_MAX) {
                next();
            }
        }, function () {
            if (++fails < FAILS_MAX) {
                next();
            }
        });
    };
    next();
    return function () { stopped = true; };
}

/** Puts what YouTube sent of the queue (its name, and videos with their titles) into list: each video in its place,
 * one of the list's own that is not known yet only, and those of the list YouTube skipped between the first and last it
 * sent left out (true: something changed). The list's videos are a new array then (a panel drawn from the old one
 * keeps it), its count the videos left. */
export function titled(list: PlaylistInfo, queue: { title: string; videos: Video[] }): boolean {
    var sent: { [id: string]: Video } = {};
    queue.videos.forEach(function (v) { sent[v.id] = v; });
    // Where the answer lies in the list: each sent video's place, a video the list has more than once at its place
    // nearest the others (the middle of the places of those it has once)
    var places: { [id: string]: number[] } = {};
    list.videos.forEach(function (v, i) { (places[v.id] = places[v.id] || []).push(i); });
    var once: number[] = [];
    queue.videos.forEach(function (v) {
        if (places[v.id] && places[v.id].length === 1) {
            once.push(places[v.id][0]);
        }
    });
    once.sort(function (a, b) { return a - b; });
    var middle = once.length ? once[Math.floor(once.length / 2)] : -1;
    var first = -1;
    var last = -1;
    queue.videos.forEach(function (v) {
        var at = (places[v.id] || []).reduce(function (best, i) { return best < 0 || Math.abs(i - middle) < Math.abs(best - middle) ? i : best; }, -1);
        if (at >= 0) {
            first = first < 0 ? at : Math.min(first, at);
            last = Math.max(last, at);
        }
    });
    // (videos are left out only within a stretch no longer than the answer and as many again: anything wider is a
    // misreading, and nothing is dropped)
    var drop = first >= 0 && last - first + 1 <= queue.videos.length * 2;
    var changed = false;
    var videos: Video[] = [];
    list.videos.forEach(function (v, i) {
        var now = sent[v.id];
        if (!now && drop && i > first && i < last) {
            changed = true;
        } else if (now && now.title && !v.title) {
            changed = true;
            videos.push(now);
        } else {
            videos.push(v);
        }
    });
    if (changed) {
        list.videos = videos;
        list.count = videos.length;
    }
    if (queue.title && queue.title !== list.title) {
        list.title = queue.title;
        changed = true;
    }
    return changed;
}
