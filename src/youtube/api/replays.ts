// YouTube's most replayed graph of a video: how much each hundredth of it is watched again (0 the least replayed part,
// 1 the most), the heights YouTube draws it between, and its "Most replayed" label at the peak. YouTube's TV client is
// not sent it; the mobile site's watch reply carries it (heatmapRenderer), so that is asked for as a guest (no
// account), and only that part of the reply is read. Its scores are raw shares, spread from 0 to 1 here as the
// website's come. Videos with few views have none. A failed request is noted (api/failures.ts): YouTube refusing the
// mobile site's client, whose version is fixed here, would otherwise only show as graphs gone missing.

import { HttpError, postText } from '../core/http.js';
import { noteFailed } from './failures.js';
import { get, text } from './feed.js';
import { Keeper } from './kept-pages.js';
import { objectAt, youtubeLanguage } from './youtube.js';

var NEXT = 'https://www.youtube.com/youtubei/v1/next?prettyPrint=false';
/** The mobile site, as it names itself (its label is shown as it comes: asked in the app's language) */
var CLIENT = { clientName: 'MWEB', clientVersion: '2.20251031.01.00' };
var CLIENT_NAME = '2';

export interface Replays {
    /** Each part's score, in order (the parts are equally long) */
    scores: number[];
    /** The lowest height as a share of the highest (a score of 0 is drawn this high) */
    floor: number;
    /** YouTube's label at the peak (null: none): its text, the time it names (s), and from and to where it shows (s) */
    label: { text: string; at: number; from: number; to: number } | null;
}

var kept = new Keeper<Replays | null>(30 * 60 * 1000, 3, false, false);

/** A video's most replayed graph (null: it has none) */
export function replays(id: string): Promise<Replays | null> {
    return kept.get(id, function () {
        var client = { clientName: CLIENT.clientName, clientVersion: CLIENT.clientVersion, hl: youtubeLanguage() };
        return postText(NEXT, { context: { client: client }, videoId: id },
            { 'X-YouTube-Client-Name': CLIENT_NAME, 'X-YouTube-Client-Version': CLIENT.clientVersion }).then(replaysOf, function (e: HttpError) {
            noteFailed('replays', e);
            throw e;
        });
    });
}

/** The graph in a mobile site watch reply's text (null: none) */
export function replaysOf(reply: string): Replays | null {
    var heat = objectAt(reply, '"heatmapRenderer":');
    var markers: any[] = heat && heat.heatMarkers || [];
    if (!markers.length) {
        return null;
    }
    var label = get(heat, 'heatMarkersDecorations', 0, 'timedMarkerDecorationRenderer');
    var raw = markers.map(function (m) { return +get(m, 'heatMarkerRenderer', 'heatMarkerIntensityScoreNormalized') || 0; });
    var low = Math.min.apply(Math, raw);
    var range = Math.max.apply(Math, raw) - low;
    return {
        scores: raw.map(function (s) { return range > 0 ? (s - low) / range : 0; }),
        floor: heat.maxHeightDp > 0 ? (+heat.minHeightDp || 0) / heat.maxHeightDp : 0,
        label: label ? { text: text(label.label), at: +label.decorationTimeMillis / 1000, from: +label.visibleTimeRangeStartMillis / 1000,
            to: +label.visibleTimeRangeEndMillis / 1000 } : null
    };
}
