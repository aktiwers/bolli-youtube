// Preloading for faster starts (Settings: Videos start sooner). For the
// tile resting in focus it fetches the streams (cached by api/streams.ts),
// the heads of the start formats from the resume point (dash.ts keeps the
// last pair; for a live stream its first segments: live-engine.ts) and the
// channel picture the loading sign shows. Cost per focused tile: one
// YouTube request (two for an unknown channel) and two small video-server
// requests. With SABR on, it prepares the SABR streams and the player
// script instead; SABR replies carry the heads.

import { knownAvatar } from '../api/avatars.js';
import { prefs } from '../api/prefs.js';
import { segments } from '../api/sponsorblock.js';
import { playableStreams, streams } from '../api/streams.js';
import { channelPicture } from '../api/watch.js';
import { prefetchHeads } from './dash.js';
import { prefetchLive } from './live-engine.js';
import { startFormats } from './own-player.js';

/** The video being preloaded (replies for another one, or after a key press, are dropped) */
var latest = '';

/** Loads the channel picture into the browser cache for the start */
var avatar = new Image();

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
    // SponsorBlock segments too, so a start can skip an intro at once
    segments(id, prefs().skip);
    // As a guest (age-restricted videos are not prepared: SABR needs YouTube's player script), or SABR first if set
    (prefs().sabr ? playableStreams(id, true) : streams(id)).then(function (s) {
        var f = startFormats(s);
        // SABR streams need no heads: the streams and the player script are ready; a live stream its first segments
        if (f && (kept || asked === latest) && s.live) {
            prefetchLive(f.video, f.audio);
        } else if (f && (kept || asked === latest) && !s.sabr) {
            prefetchHeads(f.video, f.audio, t);
        }
    }, function () { return undefined; });
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
