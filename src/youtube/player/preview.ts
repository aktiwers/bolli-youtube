// Previews in the focused tile (Settings: Previews), as in YouTube's TV app: the
// video plays at 480p in the tile's picture, with or without sound, from its
// start (past a SponsorBlock segment at the start). It plays in the player's own
// video (own-player.ts peekStart: small at the tile, the app keeping the keys),
// so OK takes it over full screen without reloading, then switches quality in
// place; hence the preview uses the codec the player would pick (VP9 or H.264).
// The TV draws video on its own layer (a video inside the rounded, clipped tile
// played but never showed), so the player's video lies over the tile with a ring
// over its corners. It stops on any other key, after PREVIEW_MS (or at the
// video's end), its sound fading out over the last FADE_MS to silence as it
// stops, or when a player shows; its position is kept a while so the opened
// video resumes there. Fails quietly (the picture stays).

import { prefs } from '../api/prefs.js';
import { segments } from '../api/sponsorblock.js';
import { kindOf, pickFormat, Streams, streams } from '../api/streams.js';
import { OwnPlayer, pastParts, startFormats } from './own-player.js';

var HEIGHT = 480;
/** How long a preview plays at most, and how long its sound fades out before it stops */
var PREVIEW_MS = 90000;
var FADE_MS = 8000;
/** The opened video resumes at the preview's position if the preview played at least GO_ON_S and stopped within
 * GO_ON_MS */
var GO_ON_S = 2;
var GO_ON_MS = 60000;

export class TilePreview {
    private id = '';
    private timer = 0;
    private fadeTimer = 0;
    /** Incremented per preview, so late answers for an old one are dropped */
    private gen = 0;
    /** Where the last preview stopped */
    private left: { id: string; t: number; at: number } | null = null;
    /** Called once the current preview stops */
    private done: (() => void) | null = null;

    constructor(private player: OwnPlayer) {}

    /** Previews video id in frame (a tile's picture box), with sound if sound; square: no rounded corners (a channel's
     * banner); done: called once it stops */
    show(id: string, frame: HTMLElement, sound: boolean, square?: boolean, done?: () => void): void {
        this.stop();
        this.done = done || null;
        var gen = this.gen;
        var self = this;
        Promise.all<any>([streams(id), segments(id, prefs().skip)]).then(function (got) {
            var s = got[0] as Streams;
            var chosen = startFormats(s);
            // The codec the player would play (VP9 or H.264), so a take-over switches to its format in place
            var kind = chosen ? kindOf(chosen.video.mime) : '';
            var format = chosen && pickFormat(s.videos.filter(function (f) { return kindOf(f.mime) === kind; }), HEIGHT);
            // Only if the tile is still in the page (its row may have been rebuilt meanwhile)
            var at = frame.getBoundingClientRect();
            if (gen !== self.gen || !chosen || !format || !document.body.contains(frame) || !at.width || !at.height) {
                return;
            }
            self.id = id;
            self.player.peekStart(id, s, format, chosen.video, s.audios[0], pastParts(got[1], 0), at, sound, function () {
                if (gen === self.gen) {
                    self.stop();
                }
            }, square);
            // Until PREVIEW_MS, or the video's end if that comes first, the sound fading out over the last FADE_MS
            var left = format.duration > 0 ? (format.duration - pastParts(got[1], 0)) * 1000 : 0;
            var length = left > 0 ? Math.min(PREVIEW_MS, left) : PREVIEW_MS;
            self.fadeTimer = setTimeout(function () { self.player.peekFade(Math.min(FADE_MS, length)); }, Math.max(0, length - FADE_MS)) as unknown as number;
            self.timer = setTimeout(function () { self.stop(); }, length) as unknown as number;
        }, function () { return undefined; });
    }

    /** Whether a preview of id is playing (OK on its tile takes it over) */
    playing(id: string): boolean {
        return this.player.peeking(id);
    }

    /** Where the last preview of id stopped (s), if it played long enough and stopped recently (0: none) */
    from(id: string): number {
        var left = this.left;
        return left && left.id === id && Date.now() - left.at < GO_ON_MS && left.t >= GO_ON_S ? left.t : 0;
    }

    /** Stops the preview and shows the tile's picture again (keeps its position, and the pipeline for the next
     * video) */
    stop(): void {
        this.gen++;
        var done = this.done;
        this.done = null;
        if (done) {
            done();
        }
        clearTimeout(this.timer);
        clearTimeout(this.fadeTimer);
        var t = this.player.peekStop();
        if (t > 0) {
            this.left = { id: this.id, t: t, at: Date.now() };
        }
    }
}
