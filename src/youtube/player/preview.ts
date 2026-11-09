// Previews in the focused tile (Settings: Previews), as in YouTube's TV app: the
// video plays at 480p in the tile's picture, with or without sound, from its
// start (past a SponsorBlock segment at the start; a video the rest loaded
// ahead from where OK would start it, switched down to 480p in place). It plays in the player's own
// video (own-player.ts peekStart: small at the tile, the app keeping the keys),
// so OK takes it over full screen without reloading, then switches quality in
// place; hence the preview uses the codec the player would pick (VP9 or H.264).
// The TV draws video on its own layer (a video inside the rounded, clipped tile
// played but never showed), so the player's video lies over the tile with a ring
// over its corners. It stops on any other key, after PREVIEW_MS (or at the
// video's end), its sound fading out over the last FADE_MS to silence as it
// stops, or when a player shows; its position is kept a while so the opened
// video resumes there. Fails quietly (the picture stays). A playlist's frame
// may play the whole video (Settings › Autoplay on the playlist page), and is
// told when it ends, so the next one plays there.

/** How a preview shows: its look (own-player.ts PeekLook); whole (the whole video, its sound kept); resume (the video
 * the player closed, kept loaded, plays on where it was, at once: a playlist's frame after Back); done (called once it
 * stops), ended (called when the video reached its end, after done) */
export interface PreviewWay extends PeekLook {
    whole?: boolean;
    resume?: boolean;
    done?: () => void;
    ended?: () => void;
}

import { kindOf, pickFormat, streams } from '../api/streams.js';
import { OwnPlayer, PeekLook, startOf } from './own-player.js';

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

    /** Previews video id in frame (a tile's picture box), with sound if sound, as way says */
    show(id: string, frame: HTMLElement, sound: boolean, way?: PreviewWay): void {
        this.stop();
        var how = way || {};
        this.done = how.done || null;
        var gen = this.gen;
        var self = this;
        // Stopped by itself (at its end: how.ended told, after done)
        var stopped = function (ended: boolean): void {
            if (gen === self.gen) {
                self.stop();
                if (ended && how.ended) {
                    how.ended();
                }
            }
        };
        if (how.resume) {
            var rect = frame.getBoundingClientRect();
            if (rect.width && rect.height && this.player.peekKept(id, rect, sound, stopped, how)) {
                this.id = id;
                if (!how.whole) {
                    this.limit(PREVIEW_MS);
                }
            }
            return;
        }
        startOf(streams(id), id, 0).then(function (start) {
            var s = start.streams;
            var chosen = start.formats;
            // The codec the player would play (VP9 or H.264), so a take-over switches to its format in place
            var kind = chosen ? kindOf(chosen.video.mime) : '';
            var format = chosen && pickFormat(s.videos.filter(function (f) { return kindOf(f.mime) === kind; }), HEIGHT);
            // Only if the tile is still in the page (its row may have been rebuilt meanwhile)
            if (gen !== self.gen || !chosen || !format || !document.body.contains(frame)) {
                return;
            }
            var at = frame.getBoundingClientRect();
            if (!at.width || !at.height) {
                return;
            }
            self.id = id;
            // (the tile's picture, laid over the video until it moves)
            var picture = (frame.tagName === 'IMG' ? frame : frame.querySelector('.bd-tile-img')) as HTMLImageElement | null;
            self.player.peekStart(id, s, format, chosen.video, s.audios[0], start.t, at, sound, stopped, how, picture && picture.getAttribute('src') || '');
            // The whole video (its end tells), else until PREVIEW_MS or the video's end if that comes first
            if (!how.whole) {
                var left = format.duration > 0 ? (format.duration - start.t) * 1000 : 0;
                self.limit(left > 0 ? Math.min(PREVIEW_MS, left) : PREVIEW_MS);
            }
        }, function () { return undefined; });
    }

    /** The preview stops after length (ms), its sound fading out over the last FADE_MS */
    private limit(length: number): void {
        var self = this;
        this.fadeTimer = setTimeout(function () { self.player.peekFade(Math.min(FADE_MS, length)); }, Math.max(0, length - FADE_MS)) as unknown as number;
        this.timer = setTimeout(function () { self.stop(); }, length) as unknown as number;
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
