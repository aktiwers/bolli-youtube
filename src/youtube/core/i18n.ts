// The app's own texts in the language chosen in Settings (English: as they are written): tr('…'). A text is looked
// up by its English ({1}, {2}, {3} in it filled in after); one the language's table lacks stays English. The table
// (lang/<code>.json beside index.html: English text -> translation) is read once, synchronously, when this module
// first runs: before any screen is made, so texts made when a module starts are translated too. YouTube's own texts
// (titles, its shelves) are not these.

import { load, save } from './store.js';

/** The languages the app's texts come in, each by its own name */
export var LANGUAGES: { code: string; name: string }[] = [
    { code: 'en', name: 'English' },
    { code: 'da', name: 'Dansk' },
    { code: 'de', name: 'Deutsch' },
    { code: 'es', name: 'Español' },
    { code: 'fr', name: 'Français' },
    { code: 'it', name: 'Italiano' },
    { code: 'nl', name: 'Nederlands' },
    { code: 'pl', name: 'Polski' },
    { code: 'pt', name: 'Português' },
    { code: 'ru', name: 'Русский' },
    { code: 'ja', name: '日本語' }
];

var LANGUAGE_KEY = 'youtube.language';

var code = known(load<string>(LANGUAGE_KEY) || 'en');
var table: { [english: string]: string } = code === 'en' ? {} : readJson('lang/' + code + '.json') || {};

/** code if the app has it, else English */
function known(c: string): string {
    return LANGUAGES.some(function (l) { return l.code === c; }) ? c : 'en';
}

/** A JSON object beside index.html, read at once (synchronously; null if it cannot be read) */
export function readJson(path: string): any {
    try {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', path, false);
        xhr.send();
        var parsed = JSON.parse(xhr.responseText);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (e) {
        return null;
    }
}

/** text in the chosen language, {1}, {2}, {3} replaced by a, b, c */
export function tr(text: string, a?: string | number, b?: string | number, c?: string | number): string {
    var out = table[text] || text;
    if (a !== undefined) {
        var values = [a, b, c];
        out = out.replace(/\{([123])\}/g, function (all, n) {
            var v = values[+n - 1];
            return v === undefined ? all : String(v);
        });
    }
    return out;
}

/** The chosen language's code ('en' by default) */
export function language(): string {
    return code;
}

/** Chooses the app's language; it applies from the next start (the caller restarts the app) */
export function setLanguage(c: string): void {
    save(LANGUAGE_KEY, c);
}
