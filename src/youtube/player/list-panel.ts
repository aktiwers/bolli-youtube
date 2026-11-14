// The playlist a video plays from (player/list-queue.ts), over the player, as Settings › Playlist in the player says:
// a strip across the bottom of the picture (Left/Right through it, OK plays one, Down: the watch page, Up or Back
// closes it), or a list at the side, over the picture or beside it (the player makes the picture narrower). Down shows
// the side list without the focus (Right goes into it, Down again opens the watch page, Up or Back closes it, the other
// keys are the player's); in it Up and Down move, OK plays one, Left, Right or Back closes it. From the watch page's
// Playlist button it opens with the focus in it and closes back to the watch page; from a shortcut (api/shortcuts.ts)
// with the focus in it too. Keys it has no use for are the
// player's. Its videos are the rows' tiles' (their pictures, titles and labels: views/tiles.ts), only those near the
// focus drawn (one comes and one goes as it moves); it hides after HIDE_MS without a key while the video plays. A video
// the focus rests on for REST_MS is loaded ahead, as the watch page's related videos are. A list whose videos come
// without titles (a phone's queue) gets those of the lines drawn once the focus rests TITLES_MS, and draws them as
// they come.

import { h, setPicture, setShown, setText, toggleClass, translate } from '../core/dom.js';
import { tr } from '../core/i18n.js';
import { KEY, KEYS_GAP } from '../core/keys.js';
import { nearestUntitled } from '../api/cast-list.js';
import { placeIn, PlaylistInfo, Video } from '../api/feed.js';
import { prefs } from '../api/prefs.js';
import { TileItem } from '../ui/tile-row.js';
import { VideoTiles } from '../views/tiles.js';

/** The strip's tiles and the side list's lines: their pitch (layout units: the theme's sizes), and how many are drawn
 * before and after the focused one */
var STRIP_PITCH = 256;
var SIDE_PITCH = 92;
var BEFORE = 2;
var AFTER = 6;
/** The side list's width (the theme's: beside it the picture is narrower by as much) */
var SIDE_WIDTH = 420;
var HIDE_MS = 10000;
var REST_MS = 1500;
/** The focus at rest this long: the titles of the lines drawn are asked for (not at each key of a held one) */
var TITLES_MS = 250;

/** What the panel does in the player */
interface PanelActions {
    /** Plays video, one of the playlist's */
    play(video: Video): void;
    /** Opens the watch page */
    watch(): void;
    /** The video plays (not paused): the panel may hide by itself */
    playing(): boolean;
    /** The focus rested on video: it may be played next, load it ahead */
    rest(video: Video): void;
    /** The picture narrower beside the side list by width (0: as before) */
    room(width: number): void;
}

export class ListPanel {
    private el: HTMLElement;
    private name: HTMLElement;
    private place: HTMLElement;
    private hint: HTMLElement;
    private itemsEl: HTMLElement;
    /** '' hidden, 'strip' or 'side' (beside the picture) */
    private mode = '';
    private beside = false;
    /** The side list has the focus (the strip always has it) */
    private inside = false;
    /** Closing goes back to the watch page (opened from its Playlist button) */
    private toWatch = false;
    /** The playlist's videos as tiles (and back to their videos), the one playing and where it is (-1: not in it) */
    private tiles = new VideoTiles();
    private items: TileItem[] = [];
    private playing = '';
    private at = -1;
    private focus = 0;
    /** The items drawn, by their place */
    private drawn: { [i: number]: HTMLElement } = {};
    private hideTimer = 0;
    private restTimer = 0;
    /** The list shown, and the timer that asks for its missing titles */
    private list: PlaylistInfo | null = null;
    private titlesTimer = 0;
    /** Stops being told of titles that came into the list */
    private unlisten = function (): void { return undefined; };

    constructor(parent: HTMLElement, before: Node, private act: PanelActions) {
        this.el = h('div', 'by-list-panel');
        var head = this.el.appendChild(h('div', 'by-list-panel-head')) as HTMLElement;
        this.name = head.appendChild(h('span', 'by-list-panel-name')) as HTMLElement;
        this.place = head.appendChild(h('span', 'by-list-panel-place')) as HTMLElement;
        this.hint = head.appendChild(h('span', 'by-list-panel-hint')) as HTMLElement;
        this.itemsEl = this.el.appendChild(h('div', 'by-list-panel-items')) as HTMLElement;
        setShown(this.el, false);
        parent.insertBefore(this.el, before);
    }

    get shown(): boolean {
        return !!this.mode;
    }

    /** Shows list (playing: the video playing) as a strip or at the side, the focus in it (focused; the strip always
     * has it), closing back to the watch page (fromWatch: opened from its Playlist button) */
    open(mode: string, list: PlaylistInfo, playing: string, focused: boolean, fromWatch?: boolean): void {
        this.close();
        this.mode = mode;
        this.playing = playing;
        this.inside = focused;
        this.toWatch = !!fromWatch;
        this.list = list;
        var self = this;
        this.unlisten = list.listen ? list.listen(function () { self.redraw(); }) : function (): void { return undefined; };
        this.tiles = new VideoTiles();
        this.items = this.tiles.items(list.videos);
        this.at = this.items.map(function (item) { return item.id; }).indexOf(playing);
        this.focus = Math.max(0, this.at);
        this.beside = mode === 'side' && prefs().listSide === 'beside';
        this.el.className = 'by-list-panel by-list-panel--' + mode + (this.beside ? ' by-list-panel--beside' : '');
        setText(this.name, list.title);
        setText(this.place, placeIn(list, playing));
        setShown(this.el, true);
        if (this.beside) {
            this.act.room(SIDE_WIDTH);
        }
        this.draw();
        this.arm();
    }

    /** Hides it (back: to the watch page, if it opened from there) */
    close(back?: boolean): void {
        if (!this.mode) {
            return;
        }
        clearTimeout(this.hideTimer);
        clearTimeout(this.restTimer);
        clearTimeout(this.titlesTimer);
        this.unlisten();
        this.list = null;
        if (this.beside) {
            this.act.room(0);
        }
        this.mode = '';
        this.itemsEl.innerHTML = '';
        this.drawn = {};
        setShown(this.el, false);
        if (back && this.toWatch) {
            this.act.watch();
        }
    }

    /** Handles a key while shown; false: the player's (the side list without the focus leaves it all but Right, Down,
     * Up and Back; a key it has no use for) */
    onKey(code: number): boolean {
        this.arm();
        var strip = this.mode === 'strip';
        if (!this.inside) {
            if (code === KEY.RIGHT) {
                this.inside = true;
                this.draw();
            } else if (code === KEY.DOWN || code === KEY.UP || code === KEY.BACK) {
                this.close();
                if (code === KEY.DOWN) {
                    this.act.watch();
                }
            } else {
                return false;
            }
            return true;
        }
        if (code === (strip ? KEY.LEFT : KEY.UP) || code === (strip ? KEY.RIGHT : KEY.DOWN)) {
            var step = code === KEY.LEFT || code === KEY.UP ? -1 : 1;
            this.focus = Math.max(0, Math.min(this.items.length - 1, this.focus + step));
            this.draw();
        } else if (code === KEY.OK) {
            var video = this.tiles.video(this.items[this.focus] || null);
            this.close();
            if (video && video.id !== this.playing) {
                this.act.play(video);
            }
        } else if (strip && code === KEY.DOWN) {
            this.close();
            this.act.watch();
        } else if (code === KEY.BACK || (strip ? code === KEY.UP : code === KEY.LEFT || code === KEY.RIGHT)) {
            this.close(true);
        } else {
            return false;
        }
        return true;
    }

    /** Hides it after HIDE_MS without a key while the video plays */
    private arm(): void {
        clearTimeout(this.hideTimer);
        var self = this;
        this.hideTimer = setTimeout(function () {
            if (self.act.playing()) {
                self.close();
            } else {
                self.arm();
            }
        }, HIDE_MS) as unknown as number;
    }

    /** The hint and the videos near the focus: those gone out of reach removed, those come into it added */
    private draw(): void {
        var strip = this.mode === 'strip';
        setText(this.hint, strip ? tr('Down: more') : this.inside ? [tr('OK plays'), tr('Back closes')].join(KEYS_GAP) :
            [tr('Right: the playlist'), tr('Down: more')].join(KEYS_GAP));
        var first = Math.max(0, this.focus - BEFORE);
        var last = Math.min(this.items.length - 1, this.focus + AFTER);
        for (var key in this.drawn) {
            var at = +key;
            if (at < first || at > last) {
                this.itemsEl.removeChild(this.drawn[at]);
                delete this.drawn[at];
            }
        }
        for (var i = first; i <= last; i++) {
            var el = this.drawn[i] || (this.drawn[i] = this.itemsEl.appendChild(this.line(i, strip)) as HTMLElement);
            toggleClass(el, 'by-list-item--focused', this.inside && i === this.focus);
        }
        var shift = Math.max(0, this.focus - (strip ? 1 : 2)) * (strip ? STRIP_PITCH : SIDE_PITCH);
        translate(this.itemsEl, strip ? -shift : 0, strip ? 0 : -shift);
        this.restSoon();
        this.titlesSoon(first, last);
    }

    /** A list whose videos come without titles: once the focus rests, the titles around the drawn line nearest the
     * focus that has none are asked for; the lines drawn are made again as they come */
    private titlesSoon(first: number, last: number): void {
        clearTimeout(this.titlesTimer);
        var list = this.list;
        if (!list || !list.titles) {
            return;
        }
        var want = nearestUntitled(this.items, this.focus, first, last);
        if (want < 0) {
            return;
        }
        var id = this.items[want].id;
        var titles = list.titles;
        this.titlesTimer = setTimeout(function () {
            // (what came is drawn by the list's own telling: listen)
            titles(id).then(null, function () { return false; });
        }, TITLES_MS) as unknown as number;
    }

    /** The list's videos changed (titles came): only the lines drawn whose title changed made again, the focus where it
     * was (the asking goes on for any drawn line still without one) */
    private redraw(): void {
        if (!this.list) {
            return;
        }
        var was = this.items;
        this.tiles = new VideoTiles();
        this.items = this.tiles.items(this.list.videos);
        var strip = this.mode === 'strip';
        setText(this.name, this.list.title);
        if (was.length !== this.items.length) {
            // (videos left out: every line moves; the focus and the one playing stay on their videos)
            var focused = was[this.focus] ? was[this.focus].id : '';
            var ids = this.items.map(function (item) { return item.id; });
            this.at = ids.indexOf(this.playing);
            this.focus = Math.max(0, Math.min(this.items.length - 1, ids.indexOf(focused) >= 0 ? ids.indexOf(focused) : this.focus));
            for (var gone in this.drawn) {
                this.itemsEl.removeChild(this.drawn[+gone]);
            }
            this.drawn = {};
            setText(this.place, placeIn(this.list, this.playing));
            this.draw();
            return;
        }
        for (var key in this.drawn) {
            var i = +key;
            if (!was[i] || !this.items[i] || was[i].title !== this.items[i].title) {
                var line = this.line(i, strip);
                toggleClass(line, 'by-list-item--focused', this.inside && i === this.focus);
                this.itemsEl.replaceChild(line, this.drawn[i]);
                this.drawn[i] = line;
            }
        }
    }

    /** The focused video (not the one playing) loaded ahead once the focus rests on it */
    private restSoon(): void {
        clearTimeout(this.restTimer);
        var video = this.inside ? this.tiles.video(this.items[this.focus] || null) : null;
        var self = this;
        if (video && video.id !== this.playing) {
            this.restTimer = setTimeout(function () {
                if (self.mode && self.inside) {
                    self.act.rest(video as Video);
                }
            }, REST_MS) as unknown as number;
        }
    }

    /** The video at place i as a tile (the strip) or a line (the side list): its picture with its label (Playing on the
     * one playing), its number, title and (the side list) channel */
    private line(i: number, strip: boolean): HTMLElement {
        var item = this.items[i];
        var el = h('div', 'by-list-item' + (i === this.at ? ' by-list-item--playing' : ''));
        el.style[strip ? 'left' : 'top'] = i * (strip ? STRIP_PITCH : SIDE_PITCH) + 'px';
        el.appendChild(h('div', 'by-list-item-number', String(i + 1)));
        var pic = el.appendChild(h('div', 'by-list-item-pic')) as HTMLElement;
        setPicture(pic.appendChild(h('img', 'by-list-item-img')) as HTMLImageElement, item.image, item.fallback);
        var label = i === this.at ? tr('Playing') : item.label || '';
        if (label) {
            pic.appendChild(h('span', 'by-list-item-label', label));
        }
        var text = el.appendChild(h('div', 'by-list-item-text')) as HTMLElement;
        text.appendChild(h('div', 'by-list-item-title', item.title));
        if (!strip) {
            text.appendChild(h('div', 'by-list-item-line', (item.lines || [])[0] || ''));
        }
        return el;
    }
}
