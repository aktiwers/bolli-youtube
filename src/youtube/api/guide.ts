// The names of the TV app's rail entries as YouTube's guide gives them, in
// the account's language (Films, Sport where YouTube says so), by browse
// page. Kept a week, so the rail starts with them; asked again after that.

import { load, save } from '../../core/store.js';
import { all, get, text } from './feed.js';
import { innertube } from './youtube.js';

var KEY = 'youtube.guide';
var KEEP_MS = 7 * 24 * 3600 * 1000;

interface Kept {
    at: number;
    names: { [browseId: string]: string };
}

/** The kept names by browse page ({}: none yet) */
export function guideNames(): { [browseId: string]: string } {
    var kept = load<Kept>(KEY);
    return kept && kept.names || {};
}

/** The names, asked of YouTube again when the kept ones are a week old or missing */
export function freshGuideNames(): Promise<{ [browseId: string]: string }> {
    var kept = load<Kept>(KEY);
    if (kept && Date.now() - kept.at < KEEP_MS) {
        return Promise.resolve(kept.names);
    }
    return innertube('guide', {}).then(function (reply) {
        var names = guideNamesOf(reply);
        save(KEY, { at: Date.now(), names: names });
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
