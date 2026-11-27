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
import { firstStreams } from '../api/streams.js';

export { firstStreams };
import { channelPicture } from '../api/watch.js';
import { prefetchHeads } from './dash.js';
import { prefetchLive } from './live-engine.js';
import { nativePlays, startOf } from './own-player.js';

/** The video being preloaded (replies for another one, or after a key press, are dropped) */
var latest = '';

/** Loads the channel picture into the browser cache for the start */
var avatar = new Image();

/** Preload video id (of channel) for a start at t (s). kept: not cancelled by a key press (the next video,
 * preloaded while one plays); signless: its start shows no loading sign (a Short's), so no channel picture is fetched */
export function preloadVideo(id: string, t: number, channel: string, kept?: boolean, signless?: boolean): void {
    var asked = latest = id + ' ' + t;
    var picture = signless ? '' : knownAvatar(channel);
    if (picture) {
        fetchPicture(picture);
    } else if (!signless) {
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
        // (none of a stream that has ended: it starts at its beginning, not behind its head). None where the Android
        // app's own video layer plays them: it fetches its own
        if (!f || !(kept || asked === latest) || nativePlays(s)) {
            return;
        }
        if (s.live) {
            if (!s.live.over) {
                prefetchLive(f.video, f.audio);
            }
        } else if (!s.sabr) {
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
