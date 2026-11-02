// Parse worker (built as apps/bolli-youtube/parse.js, started by
// api/off-thread.ts): parses a YouTube reply's text and turns it into the
// app's rows off the main thread. The result goes back as a JSON string:
// on the TV, reading a structured-cloned object of a channel's rows takes
// ~160 ms, parsing the JSON is quicker.
// The makers come from api/feed.ts and api/channel.ts, so nothing they use
// may touch the page (window, document, localStorage).

import { madeChannel } from './api/channel.js';
import { moreOf, rowsOf, subscriptionsOf } from './api/feed.js';

var MAKERS: { [kind: string]: (reply: any, arg: string) => unknown } = {
    rows: rowsOf,
    more: moreOf,
    subscriptions: subscriptionsOf,
    channel: madeChannel
};

var scope = self as any;
scope.onmessage = function (e: MessageEvent): void {
    var m = e.data;
    try {
        var t = Date.now();
        var reply = JSON.parse(m.text);
        var parsed = Date.now();
        var json = JSON.stringify(MAKERS[m.kind](reply, m.arg));
        // Timings (parse, make) are shown in __bolli.offThread
        scope.postMessage({ id: m.id, json: json, took: [parsed - t, Date.now() - parsed] });
    } catch (err) {
        scope.postMessage({ id: m.id, error: String(err && (err as Error).message || err) });
    }
};
