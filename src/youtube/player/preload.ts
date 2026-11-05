// Preloading for faster starts (Settings: Videos start sooner). For the
// tile resting in focus it fetches the streams (cached by api/streams.ts),
// the heads of the start formats from the resume point (dash.ts keeps the
// last pair; for a live stream its first segments: live-engine.ts) and the
// channel picture the loading sign shows. Cost per focused tile: one
// YouTube request (two for an unknown channel) and two small video-server
// requests. With SABR on, it prepares the SABR streams and the player
// script instead; SABR replies carry the heads. OK going down on a tile asks
// its streams and skip segments as well (startSoon), for the start at the
// release.

import { knownAvatar } from '../api/avatars.js';
import { prefs } from '../api/prefs.js';
import { segments } from '../api/sponsorblock.js';
import { playableStreams, sabrFirstNow, Streams, streams, streamsKept } from '../api/streams.js';
import { channelPicture } from '../api/watch.js';
import { prefetchHeads } from './dash.js';
import { prefetchLive } from './live-engine.js';
import { startOf } from './own-player.js';

/** The video being preloaded (replies for another one, or after a key press, are dropped) */
var latest = '';

/** Loads the channel picture into the browser cache for the start */
var avatar = new Image();

/** Requests to YouTube a short rest may make per minute to load the tile's video ahead (more: the longer rest's
 * preload asks, as before); those of the last minute */
var READY_ASKS = 10;
var asks: number[] = [];

/** Preload video id (of channel) for a start at t (s). kept: not cancelled by a key press (the next video,
 * preloaded while one plays) */
export function preloadVideo(id: string, t: number, channel: string, kept?: boolean): void {
    var asked = latest = id + ' ' + t;
    var picture = knownAvatar(channel);
    if (picture) {
        fetchPicture(picture);
    } else {
        // Unknown channel: take its picture from the video's details (cached for the player)
        channelPicture(id).then(function (image) {
            if (image && asked === latest) {
                fetchPicture(image);
            }
        }, function () { return undefined; });
    }
    // With the SponsorBlock segments (kept for the start), so the heads are for where it starts (past an intro)
    startOf(firstStreams(id), id, t).then(function (start) {
        var s = start.streams;
        var f = start.formats;
        // SABR streams need no heads: the streams and the player script are ready; a live stream its first segments
        if (f && (kept || asked === latest) && s.live) {
            prefetchLive(f.video, f.audio);
        } else if (f && (kept || asked === latest) && !s.sabr) {
            prefetchHeads(f.video, f.audio, start.t);
        }
    }, function () { return undefined; });
}

/** OK going down on the video's tile (its release starts it): its streams and skip segments asked now, so the start
 * finds them on their way (both kept for it) */
export function startSoon(id: string): void {
    firstStreams(id).then(null, function () { return undefined; });
    segments(id, prefs().skip);
}

/** Whether a short rest may load video id ahead now: its streams kept (no request), or within READY_ASKS a minute */
export function mayAskAhead(id: string): boolean {
    var now = Date.now();
    asks = asks.filter(function (at) { return now - at < 60000; });
    if (streamsKept(id, sabrFirstNow(prefs().sabr))) {
        return true;
    }
    if (asks.length >= READY_ASKS) {
        return false;
    }
    asks.push(now);
    return true;
}

/** The streams asked ahead of a start: as a guest (age-restricted videos are not prepared: SABR needs YouTube's player
 * script), or SABR first if set */
export function firstStreams(id: string): Promise<Streams> {
    return sabrFirstNow(prefs().sabr) ? playableStreams(id, true) : streams(id);
}

/** Load a channel picture into the browser cache */
function fetchPicture(url: string): void {
    if (avatar.getAttribute('src') !== url) {
        avatar.src = url;
    }
}

/** A key was pressed: drop the pending preload (fetched streams stay cached) */
export function cancelPreload(): void {
    latest = '';
}
