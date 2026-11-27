// "Stats for nerds" over the player (toggled in its settings), as on YouTube: video, formats and buffer details
// in a box at the top left, rewritten at most once a second during playback. Styled by themes/<id>.css (by-stats).
// On Android also the display's mode and the frames the player showed each second, to tell a TV that plays a 60 fps
// video unevenly why, and which player plays: Android's own (the app's video layer) or the web view's.

import { h } from '../core/dom.js';
import { Bridge, lunaCall } from '../core/luna.js';
import { Format, hdrOf } from '../api/streams.js';
import { bufferedEnd } from './engine.js';
import { android } from '../core/platform.js';

/** A video element with the TV browser's frame counts */
export type CountedVideo = HTMLVideoElement & { webkitDroppedFrameCount?: number; webkitDecodedFrameCount?: number };

var EVERY_MS = 1000;
/** The frames per second are counted over at least this long (ms) */
var SPAN_MS = 500;

/** The video's frames so far, dropped and in all, and when they were counted where the player tells (ms; 0: as they
 * are read): on Android the standard counts (a modern web view's old ones may stay 0), which Android's own player
 * counts in the shell and tells the page each second or so (the counts are that old); on webOS its engine's own */
function frameCounts(v: CountedVideo): number[] {
    var q = android() && v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
    return q ? [q.droppedVideoFrames || 0, q.totalVideoFrames || 0, q.creationTime || 0] : [v.webkitDroppedFrameCount || 0, v.webkitDecodedFrameCount || 0, 0];
}

/** A refresh or frame rate as read: 59.94, 60 */
function rate(hz: number): string {
    return String(Math.round(hz * 100) / 100);
}

/** The Android line: the display's mode (the shell's display(), JSON, any field missing), the video's own frame rate
 * and the frames the element took of late (shown: per second; -1 not known yet) */
export function displayLine(json: string, fps: number, shown: number): string {
    var d: { hz?: number; width?: number; height?: number; rates?: number[]; match?: string; asked?: number } = {};
    try {
        d = JSON.parse(json) || {};
    } catch (e) {
        d = {};
    }
    var rates = d.rates && d.rates.length ? d.rates.map(rate).join(', ') + ' Hz' : '';
    var more = [rates ? 'has ' + rates : '', d.match ? 'match rate: ' + d.match : '', d.asked ? 'asked ' + rate(d.asked) + ' Hz' : '']
        .filter(function (s) { return !!s; });
    return 'Display: ' + (d.width && d.height ? d.width + 'x' + d.height + ' ' : '') + (d.hz ? rate(d.hz) + ' Hz' : '?') +
        (more.length ? ' (' + more.join('; ') + ')' : '') +
        ' / Video: ' + (fps ? fps + ' fps' : '-') + (shown >= 0 ? ', ' + rate(shown) + ' frames/s' : '');
}

/** A video format's range as viewers name it: "HDR10 (PQ)", "HLG", else "SDR" */
export function rangeName(f: Format | null): string {
    var eotf = f ? hdrOf(f.mime) : '';
    return eotf === 'smpte2084' ? 'HDR10 (PQ)' : eotf === 'arib-std-b67' ? 'HLG' : f ? 'SDR' : '-';
}

/** The LG TV's settings service: asked for its picture mode it tells the picture's range with it (dynamicRange: sdr,
 * hdr; seen 2026-11-25: any app may ask, and be told of changes) */
var TV_SETTINGS = 'luna://com.webos.settingsservice/getSystemSettings';

/** The range line: the playing format's range and, where the TV tells it (tv: its range and picture mode, '' not
 * told), what the TV's picture is in: "Range: HDR10 (PQ) / TV: HDR (hdrStandard)" */
function rangeLine(f: Format | null, tv: string): string {
    return 'Range: ' + rangeName(f) + (tv ? ' / TV: ' + tv : '');
}

/** The Android line that names the player: Android's own with its video decoder as the device names it ('' none made
 * yet), or the web view's (null) */
export function playerLine(decoder: string | null): string {
    return 'Player: ' + (decoder === null ? 'web view' : 'Android' + (decoder ? ' (' + decoder + ')' : ''));
}

/** What the box shows about the playing video */
export interface StatsOf {
    id: string;
    video: Format | null;
    audio: Format | null;
    /** The video's best available format */
    best: Format | null;
    audioName: string;
    /** The audio's kind as viewers name it ("AAC", "Dolby Digital 5.1"; '' not known) */
    sound: string;
    stable: boolean;
    /** YouTube's Voice boost copy plays */
    boost: boolean;
    /** The streams are the signed-in ones (SABR), else a guest's */
    sabr: boolean;
    /** Android's own player plays it: its video decoder ('' none made yet); null: the page's player does */
    decoder: string | null;
}

export class StatsBox {
    private el: HTMLElement | null = null;
    private writtenAt = 0;
    /** The element's frame counts when the video loaded */
    private dropped = 0;
    private decoded = 0;
    /** Android: the frame count the frames per second are counted from and when it was counted (-1: none), and the
     * frames per second shown (-1: not known) */
    private countAt = -1;
    private countWas = 0;
    private perSecond = -1;
    /** What the TV says its picture is in ("HDR (hdrStandard)"; '' not told), and the call that tells of its changes:
     * listened to only while the box shows (tvSays) */
    private tv = '';
    private tvCall: Bridge | null = null;
    /** Whether the TV was asked to tell (also where no answer can come: not a webOS TV) */
    private listening = false;

    constructor(private parent: HTMLElement, private v: HTMLVideoElement, private of: () => StatsOf) {}

    get shown(): boolean {
        return !!this.el;
    }

    show(on: boolean): void {
        if (on && !this.el) {
            this.el = h('div', 'by-stats');
            this.parent.appendChild(this.el);
            this.tvSays(true);
            this.write();
        } else if (!on && this.el) {
            this.parent.removeChild(this.el);
            this.el = null;
            this.tvSays(false);
        }
    }

    /** Listens to the TV's picture mode and range while the box shows (on), and no longer after (a call of the TV's
     * own service, no request; nothing outside an LG TV). A change is in the box at its next write */
    private tvSays(on: boolean): void {
        var self = this;
        if (this.tvCall && this.tvCall.cancel) {
            try {
                this.tvCall.cancel();
            } catch (e) {
                // (a bridge already gone: nothing to cancel)
            }
        }
        this.tvCall = null;
        this.tv = '';
        this.listening = on;
        if (on) {
            this.tvCall = lunaCall(TV_SETTINGS, { category: 'picture', keys: ['pictureMode'], subscribe: true }, function (message, data) {
                var settings = data && data.settings as { pictureMode?: string } | undefined;
                var dimension = data && data.dimension as { dynamicRange?: string } | undefined;
                var range = dimension && dimension.dynamicRange || '';
                if (self.el && range) {
                    self.tv = range.toUpperCase() + (settings && settings.pictureMode ? ' (' + settings.pictureMode + ')' : '');
                }
            });
        }
    }

    /** A video loaded: frame counts continue across videos on a kept pipeline, so count from here */
    loaded(): void {
        var n = frameCounts(this.v as CountedVideo);
        this.dropped = n[0];
        this.decoded = n[1];
        this.countAt = this.perSecond = -1;
    }

    /** The player closed with the box left on: the TV is not listened to while no video plays (again at the next
     * one's first write: tick) */
    idle(): void {
        this.tvSays(false);
    }

    /** Called as the video plays */
    tick(): void {
        if (this.el && Date.now() - this.writtenAt >= EVERY_MS) {
            if (!this.listening) {
                this.tvSays(true);
            }
            this.write();
        }
    }

    private write(): void {
        var v = this.v as CountedVideo;
        var s = this.of();
        var codec = function (f: Format | null): string { return f ? (/codecs="([^"]+)"/.exec(f.mime) || ['', '?'])[1] + ' (' + f.itag + ')' : '-'; };
        // (with what YouTube names the format besides: its upscaled copy, its Premium one)
        var res = function (f: Format | null): string {
            return f ? f.height + 'p' + (f.fps || '') + (f.upscaled ? ', Super resolution' : '') + (f.premium ? ', Premium' : '') : '-';
        };
        var kbps = function (f: Format | null): number { return f ? Math.round(f.bitrate / 1000) : 0; };
        var now = Date.now();
        // (not written for a while: a pause, during which nothing writes it, or the box was closed)
        var rested = now - this.writtenAt > 2 * EVERY_MS;
        this.writtenAt = now;
        var n = frameCounts(v);
        var shell = android();
        // (Android: counts that started over with the element's new player, from 0)
        if (shell && (n[1] < this.decoded || n[0] < this.dropped)) {
            this.dropped = this.decoded = 0;
        }
        var lines = [
            'Video ID: ' + s.id + ' (' + (s.sabr ? 'signed in, SABR' : 'as a guest') + ')',
            'App UI / Frames: ' + window.innerWidth + 'x' + window.innerHeight + ' / ' + (n[0] - this.dropped) + ' dropped of ' + (n[1] - this.decoded),
            'Current / Optimal Res: ' + v.videoWidth + 'x' + v.videoHeight + ' (' + res(s.video) + ') / ' + res(s.best),
            'Codecs: ' + codec(s.video) + ' / ' + codec(s.audio),
            rangeLine(s.video, this.tv),
            'Bitrate: ' + kbps(s.video) + ' kbps / ' + kbps(s.audio) + ' kbps',
            'Buffer Health: ' + (bufferedEnd(v.buffered, v.currentTime) - v.currentTime).toFixed(2) + ' s',
            'Audio: ' + (s.sound ? s.sound + ', ' : '') + s.audioName + (s.stable ? ', stable volume' : '') + (s.boost ? ', voice boost' : '')
        ];
        if (shell) {
            // The frames per second over the counts' own time (over the box's seconds, counts that come each second
            // or so would read slow and fast by turns), not over less than SPAN_MS (counts told at a change, soon
            // after the last), and counted anew after a time the box was not written in or the counts started over
            var at = n[2] || now;
            var anew = this.countAt < 0 || rested || n[1] < this.countWas || at < this.countAt;
            if (anew || at - this.countAt >= SPAN_MS) {
                this.perSecond = anew ? -1 : (n[1] - this.countWas) * 1000 / (at - this.countAt);
                this.countAt = at;
                this.countWas = n[1];
            }
            lines.splice(2, 0, displayLine(shell.display ? shell.display() : '', s.video ? s.video.fps || 0 : 0, this.perSecond), playerLine(s.decoder));
        }
        (this.el as HTMLElement).textContent = lines.join('\n');
    }
}
