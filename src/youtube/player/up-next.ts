// "Up next" at a video's end in the player (Settings: Autoplay, and the countdown length), as in
// YouTube's TV player: the next video's picture, title and channel with a countdown; it plays
// when the countdown ends, or on Play now; Cancel shows the watch page's related videos
// instead; Back closes the player. Styled by themes/<id>.css (by-upnext).

import { h, setPicture, setShown, setText } from '../core/dom.js';
import { tr } from '../core/i18n.js';
import { KEY } from '../core/keys.js';
import { dearrowPicture, dearrowTitle } from '../api/dearrow.js';
import { thumbnail, thumbnailFallback, Video } from '../api/feed.js';
import { Pills } from '../ui/pills.js';

export interface UpNextActions {
    play(video: Video): void;
    cancel(): void;
    close(): void;
}

export class UpNext {
    private el: HTMLElement;
    private img: HTMLImageElement;
    private title: HTMLElement;
    private channel: HTMLElement;
    private count: HTMLElement;
    private buttons = new Pills('by-pill--focused');
    /** The video counted down to (null: hidden) */
    private video: Video | null = null;
    private left = 0;
    private timer = 0;

    constructor(parent: HTMLElement, private actions: UpNextActions) {
        this.el = h('div', 'by-upnext');
        this.el.appendChild(h('div', 'by-upnext-label', tr('Up next')));
        this.img = h('img', 'by-upnext-img') as HTMLImageElement;
        this.title = h('div', 'by-upnext-title');
        this.channel = h('div', 'by-upnext-channel');
        this.count = h('div', 'by-upnext-count');
        this.el.appendChild(this.img);
        this.el.appendChild(this.title);
        this.el.appendChild(this.channel);
        this.el.appendChild(this.count);
        var row = h('div', 'by-upnext-buttons');
        var self = this;
        row.appendChild(this.buttons.add(h('div', 'by-pill', tr('Play now')), function () { self.playNow(); }));
        row.appendChild(this.buttons.add(h('div', 'by-pill', tr('Cancel')), function () {
            self.hide();
            self.actions.cancel();
        }));
        this.buttons.setFocused(true);
        this.el.appendChild(row);
        setShown(this.el, false);
        parent.appendChild(this.el);
    }

    /** The video counted down to (null: hidden) */
    get counting(): Video | null {
        return this.video;
    }

    /** Starts the countdown to video (seconds), focus on Play now */
    show(video: Video, seconds: number): void {
        this.video = video;
        setPicture(this.img, dearrowPicture(video.id, thumbnail(video.id)), thumbnailFallback(video.id));
        setText(this.title, dearrowTitle(video.id, video.title));
        setText(this.channel, video.channel);
        this.buttons.focus(0);
        this.left = seconds;
        this.tick();
        setShown(this.el, true);
    }

    /** Plays its video now (Play now, or Play from a phone) */
    playNow(): void {
        this.actions.play(this.hide());
    }

    onKey(code: number): void {
        switch (code) {
            case KEY.LEFT:
            case KEY.RIGHT:
                this.buttons.move(code === KEY.LEFT ? -1 : 1);
                break;
            case KEY.OK:
                this.buttons.press();
                break;
            case KEY.BACK:
                this.hide();
                this.actions.close();
                break;
        }
    }

    /** Hides it and stops the countdown; returns its video */
    hide(): Video {
        var video = this.video as Video;
        clearTimeout(this.timer);
        this.video = null;
        setShown(this.el, false);
        // Its picture let go (a decoded picture kept through the next video costs the TV's short memory)
        this.img.onload = this.img.onerror = null;
        this.img.removeAttribute('src');
        return video;
    }

    /** Counts down a second; at 0 the video plays */
    private tick(): void {
        if (this.left <= 0) {
            this.playNow();
            return;
        }
        setText(this.count, tr('Plays in {1} s', this.left));
        this.left--;
        var self = this;
        this.timer = setTimeout(function () { self.tick(); }, 1000) as unknown as number;
    }
}
