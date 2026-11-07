// The names of the TV app's rail entries as YouTube's guide gives them, in
// the language the app asks YouTube in (Films, Sport where YouTube says so),
// by browse page. Kept a week with that language, so the rail starts with them;
// asked again after that, or in another language.

import { load, save } from '../core/store.js';
import { all, get, text } from './feed.js';
import { language } from '../core/i18n.js';
import { inLanguage } from './kept-rows.js';
import { innertube } from './youtube.js';

var KEY = 'youtube.guide';
var KEEP_MS = 7 * 24 * 3600 * 1000;

interface Kept {
    at: number;
    /** The app's language they came in (none: English, kept before languages) */
    lang?: string;
    names: { [browseId: string]: string };
}

/** The names kept in the app's language (null: none) */
function kept(): Kept | null {
    var k = load<Kept>(KEY);
    return k && inLanguage(k.lang) ? k : null;
}

/** The kept names by browse page ({}: none yet) */
export function guideNames(): { [browseId: string]: string } {
    var k = kept();
    return k && k.names || {};
}

/** The names, asked of YouTube again when the kept ones are a week old, in another language or missing */
export function freshGuideNames(): Promise<{ [browseId: string]: string }> {
    var k = kept();
    if (k && Date.now() - k.at < KEEP_MS) {
        return Promise.resolve(k.names);
    }
    return innertube('guide', {}).then(function (reply) {
        var names = guideNamesOf(reply);
        save(KEY, { at: Date.now(), lang: language(), names: names });
        return names;
    });
}

/** A guide reply's entries: browse page to name */
export function guideNamesOf(reply: unknown): { [browseId: string]: string } {
    var names: { [browseId: string]: string } = {};
    var entries = all(reply, 'guideEntryRenderer');
    // (and entries inside an entry: found as the list grows)
    for (var i = 0; i < entries.length; i++) {
        all(entries[i], 'guideEntryRenderer', entries);
    }
    entries.forEach(function (entry: any) {
        var id = get(entry, 'navigationEndpoint', 'browseEndpoint', 'browseId');
        var name = text(entry.formattedTitle || entry.title);
        if (id && name) {
            names[id] = name;
        }
    });
    return names;
}
