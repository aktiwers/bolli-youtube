// A video's dislikes as Return YouTube Dislike (returnyoutubedislike.com) estimates them: YouTube no longer shows the
// count, so the extension's users and the counts archived before then stand in for it. Asked for when the watch page
// shows a video (the API asks clients for no more than 100 requests a minute), kept a while; a failed request is noted
// (api/failures.ts).

import { getJson, HttpError } from '../core/http.js';
import { language } from '../core/i18n.js';
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

/** How YouTube writes a short count (a like count, a view count) in each of the app's languages, as it answers when
 * asked in them: its steps from the largest (size, what follows the number), its decimal mark, and below the smallest
 * step the whole number, grouped by group (Danish and German: 19.038, not 19 t.; elsewhere it is under 1000).
 * Spanish counts billions in millions (9166 M), Japanese in 10 000s and 100 000 000s (1.9万). */
var COUNTS: { [code: string]: { steps: [number, string][]; mark: string; group?: string } } = {
    en: { steps: [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']], mark: '.' },
    da: { steps: [[1e9, '\u00a0mia.'], [1e6, '\u00a0mio.']], mark: ',', group: '.' },
    de: { steps: [[1e9, '\u00a0Mrd.'], [1e6, '\u00a0Mio.']], mark: ',', group: '.' },
    es: { steps: [[1e6, '\u00a0M'], [1e3, '\u00a0K']], mark: ',' },
    fr: { steps: [[1e9, '\u00a0Md'], [1e6, '\u00a0M'], [1e3, '\u00a0k']], mark: ',' },
    it: { steps: [[1e9, '\u00a0Mld'], [1e6, '\u00a0Mln'], [1e3, 'K']], mark: ',' },
    nl: { steps: [[1e9, '\u00a0mld.'], [1e6, '\u00a0mln.'], [1e3, 'K']], mark: ',' },
    pl: { steps: [[1e9, '\u00a0mld'], [1e6, '\u00a0mln'], [1e3, '\u00a0tys.']], mark: ',' },
    pt: { steps: [[1e9, '\u00a0bi'], [1e6, '\u00a0mi'], [1e3, '\u00a0mil']], mark: ',' },
    ru: { steps: [[1e9, '\u00a0млрд'], [1e6, '\u00a0млн'], [1e3, '\u00a0тыс.']], mark: ',' },
    ja: { steps: [[1e8, '億'], [1e4, '万']], mark: '.' }
};

/** A count as YouTube writes one in the app's language (or code's): 999, 1.2K, 12K, 1.2M, 1.2B in English (one
 * decimal below 10, rounded down) */
export function shortCount(n: number, code?: string): string {
    var form = COUNTS[code || language()] || COUNTS.en;
    for (var i = 0; i < form.steps.length; i++) {
        var size = form.steps[i][0];
        if (n >= size) {
            var x = n / size;
            return String(x < 10 ? Math.floor(x * 10) / 10 : Math.floor(x)).replace('.', form.mark) + form.steps[i][1];
        }
    }
    var whole = String(Math.floor(n));
    return form.group ? whole.replace(/\B(?=(\d{3})+$)/g, form.group) : whole;
}
