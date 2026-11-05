// A video's dislikes as Return YouTube Dislike (returnyoutubedislike.com) estimates them: YouTube no longer shows the
// count, so the extension's users and the counts archived before then stand in for it. Asked for when the watch page
// shows a video (the API asks clients for no more than 100 requests a minute), kept a while; a failed request is noted
// (api/failures.ts).

import { getJson, HttpError } from '../../core/http.js';
import { noteFailed } from './failures.js';
import { Keeper } from './kept-pages.js';

var VOTES = 'https://returnyoutubedislikeapi.com/votes?videoId=';

var kept = new Keeper<number | null>(30 * 60 * 1000, 20, false, false);

/** The video's dislikes (null: none known) */
export function dislikes(id: string): Promise<number | null> {
    return kept.get(id, function () {
        return getJson<{ dislikes?: number }>(VOTES + encodeURIComponent(id)).then(function (r) {
            return r && typeof r.dislikes === 'number' && r.dislikes >= 0 ? r.dislikes : null;
        }, function (e: HttpError) {
            noteFailed('dislikes', e);
            throw e;
        });
    });
}

/** A count as YouTube writes one: 999, 1.2K, 12K, 1.2M, 1.2B (rounded down) */
export function shortCount(n: number): string {
    var units = [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']] as [number, string][];
    for (var i = 0; i < units.length; i++) {
        var size = units[i][0];
        if (n >= size) {
            var x = n / size;
            return (x < 10 ? Math.floor(x * 10) / 10 : Math.floor(x)) + units[i][1];
        }
    }
    return String(Math.floor(n));
}
