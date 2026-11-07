// YouTube's search suggestions, fetched as its TV app does (suggestion
// service, client youtube-lr, ~50 ms): searches for the typed text, some
// naming a known person or thing (name, a line about it, picture).
// Requested from youtube.com's origin and cached per text, so deleting back
// to an earlier text is instant. Recent searches are stored locally; the
// Search screen shows them before anything is typed.

import { load, save } from '../core/store.js';
import { Keeper } from './kept-pages.js';
import { get, tvClient, youtubePage } from './youtube.js';

export interface Suggestion {
    text: string;
    /** A known person or thing it names: name, a line about it, picture */
    name?: string;
    line?: string;
    image?: string;
}

var KEEP_MS = 10 * 60 * 1000;
var kept = new Keeper<Suggestion[]>(KEEP_MS, 30, false, false);
var RECENT_KEY = 'youtube.recentSearches';
var RECENT_MAX = 10;

/** YouTube's suggestions for text */
export function suggestions(text: string, hl?: string): Promise<Suggestion[]> {
    return kept.get((hl || '') + ' ' + text, function () {
        return Promise.all<any>([youtubePage(), tvClient()]).then(function (got) {
            var client = got[1].context.client;
            return get(got[0], '/complete/search?client=youtube-lr&ds=yt&xhr=t&oe=utf-8&xssi=t&hl=' +
                encodeURIComponent(hl || client.hl || 'en') + '&gl=' + encodeURIComponent(client.gl || '') + '&q=' +
                encodeURIComponent(text));
        }).then(suggestionsOf);
    });
}

/** Parses the service's reply: ")]}'", then [text, [[search, 0, [kinds], {person or thing}], …], …] */
function suggestionsOf(text: string): Suggestion[] {
    var data = JSON.parse(text.replace(/^\)\]\}'\s*/, ''));
    var list: any[] = data && data[1] || [];
    return list.filter(function (s) {
        return s && typeof s[0] === 'string' && s[0];
    }).map(function (s) {
        var thing = s[3] || {};
        var found: Suggestion = { text: s[0] };
        if (thing.zao) {
            found.name = thing.zao;
            found.line = thing.zaf || '';
            found.image = thing.zai || '';
        }
        return found;
    });
}

/** Recent searches, newest first (loaded once) */
var recent: string[] | null = null;

export function recentSearches(): string[] {
    recent = recent || load<string[]>(RECENT_KEY) || [];
    return recent;
}

/** Moves a search to the front of the recent list (deduplicated, case-insensitive) */
export function keepSearch(term: string): void {
    var lower = term.toLowerCase();
    recent = recentSearches().filter(function (t) { return t.toLowerCase() !== lower; });
    recent.unshift(term);
    recent.length = Math.min(recent.length, RECENT_MAX);
    save(RECENT_KEY, recent);
}

/** Clears the recent searches (when YouTube's search history is cleared) */
export function clearRecentSearches(): void {
    recent = [];
    save(RECENT_KEY, recent);
}
