// Requests whose failure the app passes over (a feature just goes missing, as the most replayed graph would if YouTube
// refused the client it is asked as): the last failure of each, for diagnosis (localStorage bolli.v1.youtube.failures:
// { what: { at, status, body } }).

import { HttpError } from '../core/http.js';
import { load, save } from '../core/store.js';

var KEY = 'youtube.failures';

/** Notes what's request failing with e: when, its status and the start of the reply (not for no answer at all: the
 * network, which would replace a refusal noted before) */
export function noteFailed(what: string, e: HttpError): void {
    if (!e || !e.status) {
        return;
    }
    var kept = load<{ [what: string]: unknown }>(KEY) || {};
    kept[what] = { at: new Date().toISOString(), status: e.status, body: String(e.body || e.message).slice(0, 150) };
    save(KEY, kept);
}
