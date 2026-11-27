// A video's dislikes as Return YouTube Dislike (returnyoutubedislike.com) estimates them: YouTube no longer shows the
// count, so the extension's users and the counts archived before then stand in for it. Asked for when the watch page
// shows a video (the API asks clients for no more than 100 requests a minute), kept a while; a failed request is noted
// (api/failures.ts). Its reply also has the likes (a playlist's frame shows them from it: views/list-stage.ts).

import { getJson, HttpError } from '../core/http.js';
import { language } from '../core/i18n.js';
import { noteFailed } from './failures.js';
import { Keeper } from './kept-pages.js';

var VOTES = 'https://returnyoutubedislikeapi.com/votes?videoId=';

/** A video's likes and dislikes (null: not known) */
export interface Votes {
    likes: number | null;
    dislikes: number | null;
}

var kept = new Keeper<Votes>(30 * 60 * 1000, 20, false, false);

/** A count from the reply (null: none) */
function count(n: number | undefined): number | null {
    return typeof n === 'number' && n >= 0 ? n : null;
}

/** The video's likes and dislikes */
export function votes(id: string): Promise<Votes> {
    return kept.get(id, function () {
        return getJson<{ likes?: number; dislikes?: number }>(VOTES + encodeURIComponent(id)).then(function (r) {
            return { likes: count(r && r.likes), dislikes: count(r && r.dislikes) };
        }, function (e: HttpError) {
            noteFailed('dislikes', e);
            throw e;
        });
    });
}

/** The video's dislikes (null: none known) */
export function dislikes(id: string): Promise<number | null> {
    return votes(id).then(function (v) { return v.dislikes; });
}

/** How YouTube writes a short count (a like count, a view count) in each of the app's languages, as it answers when
 * asked in them: its steps from the largest (size, what follows the number), its decimal mark, and below the smallest
 * step the whole number, grouped by group (Danish and German: 19.038, not 19 t.; elsewhere it is under 1000).
 * Spanish counts billions in millions (9166 M), Japanese in 10 000s and 100 000 000s (1.9万), Korean in those and in
 * 1000s (1.2천, 1.9만). A step may put its word before the number (Swahili: elfu 1.2) and count in another size than
 * the one it starts at (Kazakh: 19 мың, but 117 м.); the whole number below the steps may be grouped only from
 * `from` up (Basque and Galician: 1930, but 19.038). The languages added on 2026-11-26 as Unicode's CLDR has them,
 * checked against YouTube's answers in each (where YouTube writes it otherwise: Afrikaans, Swahili, Kazakh, Basque,
 * Galician, Swedish, Catalan) */
var COUNTS: { [code: string]: { steps: [number, string, string?, number?][]; mark: string; group?: string; from?: number } } = {
    en: { steps: [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']], mark: '.' },
    da: { steps: [[1e9, '\u00a0mia.'], [1e6, '\u00a0mio.']], mark: ',', group: '.' },
    de: { steps: [[1e9, '\u00a0Mrd.'], [1e6, '\u00a0Mio.']], mark: ',', group: '.' },
    es: { steps: [[1e6, '\u00a0M'], [1e3, '\u00a0K']], mark: ',' },
    fr: { steps: [[1e9, '\u00a0Md'], [1e6, '\u00a0M'], [1e3, '\u00a0k']], mark: ',' },
    it: { steps: [[1e9, '\u00a0Mld'], [1e6, '\u00a0Mln'], [1e3, 'K']], mark: ',' },
    hu: { steps: [[1e9, '\u00a0Mrd'], [1e6, '\u00a0M'], [1e3, '\u00a0E']], mark: ',' },
    nl: { steps: [[1e9, '\u00a0mld.'], [1e6, '\u00a0mln.'], [1e3, 'K']], mark: ',' },
    pl: { steps: [[1e9, '\u00a0mld'], [1e6, '\u00a0mln'], [1e3, '\u00a0tys.']], mark: ',' },
    pt: { steps: [[1e9, '\u00a0bi'], [1e6, '\u00a0mi'], [1e3, '\u00a0mil']], mark: ',' },
    ru: { steps: [[1e9, '\u00a0млрд'], [1e6, '\u00a0млн'], [1e3, '\u00a0тыс.']], mark: ',' },
    ja: { steps: [[1e8, '億'], [1e4, '万']], mark: '.' },
    ko: { steps: [[1e8, '억'], [1e4, '만'], [1e3, '천']], mark: '.' },
    ro: { steps: [[1e9, '\u00a0mld.'], [1e6, '\u00a0mil.'], [1e3, '\u00a0K']], mark: ',' },
    af: { steps: [[1e9, '\u00a0mjd'], [1e6, '\u00a0m.'], [1e3, '\u00a0k']], mark: ',' },
    az: { steps: [[1e9, '\u00a0mlrd'], [1e6, '\u00a0mln'], [1e3, 'K']], mark: ',' },
    id: { steps: [[1e9, '\u00a0M'], [1e6, '\u00a0jt'], [1e3, '\u00a0rb']], mark: ',' },
    ms: { steps: [[1e9, 'B'], [1e6, 'J'], [1e3, 'K']], mark: '.' },
    bs: { steps: [[1e9, '\u00a0mlrd.'], [1e6, '\u00a0mil.'], [1e3, '\u00a0hilj.']], mark: ',' },
    ca: { steps: [[1e6, '\u00a0M'], [1e3, '\u00a0k']], mark: ',' },
    cs: { steps: [[1e9, '\u00a0mld.'], [1e6, '\u00a0mil.'], [1e3, '\u00a0tis.']], mark: ',' },
    et: { steps: [[1e9, '\u00a0mld'], [1e6, '\u00a0mln'], [1e3, '\u00a0tuh']], mark: ',' },
    eu: { steps: [[1e6, '\u00a0M']], mark: ',', group: '.', from: 10000 },
    fil: { steps: [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']], mark: '.' },
    gl: { steps: [[1e6, '\u00a0M']], mark: ',', group: '\u00a0', from: 10000 },
    hr: { steps: [[1e9, '\u00a0mlr.'], [1e6, '\u00a0mil.'], [1e3, '\u00a0tis.']], mark: ',' },
    zu: { steps: [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']], mark: '.' },
    is: { steps: [[1e9, '\u00a0ma.'], [1e6, '\u00a0m.'], [1e3, '\u00a0þ.']], mark: ',' },
    sw: { steps: [[1e9, 'B'], [1e6, 'M'], [1e3, '', 'elfu\u00a0']], mark: '.' },
    lv: { steps: [[1e9, '\u00a0mljrd.'], [1e6, '\u00a0milj.'], [1e3, '\u00a0tūkst.']], mark: ',' },
    lt: { steps: [[1e9, '\u00a0mlrd.'], [1e6, '\u00a0mln.'], [1e3, '\u00a0tūkst.']], mark: ',' },
    no: { steps: [[1e9, '\u00a0mrd.'], [1e6, '\u00a0mill.'], [1e3, 'k']], mark: ',' },
    uz: { steps: [[1e9, '\u00a0mlrd'], [1e6, '\u00a0mln'], [1e3, '\u00a0ming']], mark: ',' },
    'pt-PT': { steps: [[1e9, '\u00a0mM'], [1e6, '\u00a0M'], [1e3, '\u00a0mil']], mark: ',' },
    sq: { steps: [[1e9, '\u00a0mld'], [1e6, '\u00a0mln'], [1e3, '\u00a0mijë']], mark: ',' },
    sk: { steps: [[1e9, '\u00a0mld.'], [1e6, '\u00a0mil.'], [1e3, '\u00a0tis.']], mark: ',' },
    sl: { steps: [[1e9, '\u00a0mrd.'], [1e6, '\u00a0mio.'], [1e3, '\u00a0tis.']], mark: ',' },
    'sr-Latn': { steps: [[1e9, '\u00a0mlrd.'], [1e6, '\u00a0mil.'], [1e3, '\u00a0hilj.']], mark: ',' },
    fi: { steps: [[1e9, '\u00a0mrd.'], [1e6, '\u00a0milj.'], [1e3, '\u00a0t.']], mark: ',' },
    sv: { steps: [[1e9, '\u00a0md'], [1e6, '\u00a0mn']], mark: ',', group: '\u00a0' },
    vi: { steps: [[1e9, '\u00a0T'], [1e6, '\u00a0Tr'], [1e3, '\u00a0N']], mark: ',' },
    tr: { steps: [[1e9, '\u00a0Mr'], [1e6, '\u00a0Mn'], [1e3, '\u00a0B']], mark: ',' },
    be: { steps: [[1e9, '\u00a0млрд'], [1e6, '\u00a0млн'], [1e3, '\u00a0тыс.']], mark: ',' },
    bg: { steps: [[1e9, '\u00a0млрд.'], [1e6, '\u00a0млн.'], [1e3, '\u00a0хил.']], mark: ',' },
    ky: { steps: [[1e9, '\u00a0млд'], [1e6, '\u00a0млн'], [1e3, '\u00a0миң']], mark: ',' },
    kk: { steps: [[1e9, '\u00a0млрд'], [1e6, '\u00a0млн'], [1e5, '\u00a0м.', '', 1e3], [1e3, '\u00a0мың']], mark: ',' },
    mk: { steps: [[1e9, '\u00a0милј.'], [1e6, '\u00a0мил.'], [1e3, '\u00a0илј.']], mark: ',' },
    mn: { steps: [[1e9, '\u00a0тэрбум'], [1e6, '\u00a0сая'], [1e3, '\u00a0мян']], mark: '.' },
    sr: { steps: [[1e9, '\u00a0млрд.'], [1e6, '\u00a0мил.'], [1e3, '\u00a0хиљ.']], mark: ',' },
    uk: { steps: [[1e9, '\u00a0млрд'], [1e6, '\u00a0млн'], [1e3, '\u00a0тис.']], mark: ',' },
    el: { steps: [[1e9, '\u00a0δισ.'], [1e6, '\u00a0εκ.'], [1e3, '\u00a0χιλ.']], mark: ',' }
};

/** A count as YouTube writes one in the app's language (or code's): 999, 1.2K, 12K, 1.2M, 1.2B in English (one
 * decimal below 10, rounded down) */
export function shortCount(n: number, code?: string): string {
    var form = COUNTS[code || language()] || COUNTS.en;
    for (var i = 0; i < form.steps.length; i++) {
        var step = form.steps[i];
        if (n >= step[0]) {
            var x = n / (step[3] || step[0]);
            return (step[2] || '') + String(x < 10 ? Math.floor(x * 10) / 10 : Math.floor(x)).replace('.', form.mark) + step[1];
        }
    }
    var whole = String(Math.floor(n));
    return form.group && n >= (form.from || 1000) ? whole.replace(/\B(?=(\d{3})+$)/g, form.group) : whole;
}
