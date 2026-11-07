// "Stats for nerds" over the player (toggled in its settings), as on YouTube: video, formats and buffer details
// in a box at the top left, rewritten at most once a second during playback. Styled by themes/<id>.css (by-stats).

import { h } from '../core/dom.js';
import { Format } from '../api/streams.js';
import { bufferedEnd } from './engine.js';

/** A video element with the TV browser's frame counts */
export type CountedVideo = HTMLVideoElement & { webkitDroppedFrameCount?: number; webkitDecodedFrameCount?: number };

var EVERY_MS = 1000;

/** What the box shows about the playing video */
export interface StatsOf {
    id: string;
    video: Format | null;
    audio: Format | null;
    /** The video's best available format */
    best: Format | null;
    audioName: string;
    stable: boolean;
}

export class StatsBox {
    private el: HTMLElement | null = null;
    private writtenAt = 0;
    /** The element's frame counts when the video loaded */
    private dropped = 0;
    private decoded = 0;

    constructor(private parent: HTMLElement, private v: HTMLVideoElement, private of: () => StatsOf) {}

    get shown(): boolean {
        return !!this.el;
    }

    show(on: boolean): void {
        if (on && !this.el) {
            this.el = h('div', 'by-stats');
            this.parent.appendChild(this.el);
            this.write();
        } else if (!on && this.el) {
            this.parent.removeChild(this.el);
            this.el = null;
        }
    }

    /** A video loaded: frame counts continue across videos on a kept pipeline, so count from here */
    loaded(): void {
        var v = this.v as CountedVideo;
        this.dropped = v.webkitDroppedFrameCount || 0;
        this.decoded = v.webkitDecodedFrameCount || 0;
    }

    /** Called as the video plays */
    tick(): void {
        if (this.el && Date.now() - this.writtenAt >= EVERY_MS) {
            this.write();
        }
    }

    private write(): void {
        var v = this.v as CountedVideo;
        var s = this.of();
        var codec = function (f: Format | null): string { return f ? (/codecs="([^"]+)"/.exec(f.mime) || ['', '?'])[1] + ' (' + f.itag + ')' : '-'; };
        var res = function (f: Format | null): string { return f ? f.height + 'p' + (f.fps || '') : '-'; };
        var kbps = function (f: Format | null): number { return f ? Math.round(f.bitrate / 1000) : 0; };
        this.writtenAt = Date.now();
        (this.el as HTMLElement).textContent = [
            'Video ID: ' + s.id,
            'Viewport / Frames: ' + window.innerWidth + 'x' + window.innerHeight + ' / ' + ((v.webkitDroppedFrameCount || 0) - this.dropped) + ' dropped of ' + ((v.webkitDecodedFrameCount || 0) - this.decoded),
            'Current / Optimal Res: ' + v.videoWidth + 'x' + v.videoHeight + ' (' + res(s.video) + ') / ' + res(s.best),
            'Codecs: ' + codec(s.video) + ' / ' + codec(s.audio),
            'Bitrate: ' + kbps(s.video) + ' kbps / ' + kbps(s.audio) + ' kbps',
            'Buffer Health: ' + (bufferedEnd(v.buffered, v.currentTime) - v.currentTime).toFixed(2) + ' s',
            'Audio: ' + s.audioName + (s.stable ? ', stable volume' : '')
        ].join('\n');
    }
}
