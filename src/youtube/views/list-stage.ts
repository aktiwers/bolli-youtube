// A playlist's page around its list (views/videos.ts, bd-page--list), as YouTube's
// TV app: the video the focus is on shows in a frame beside the list
// (Settings › Playlist page: Stage) or fills the screen behind the page
// (Backdrop), its picture until main.ts plays its preview there in the
// player's own video (player/preview.ts); under it the video's title, channel
// and views, and once the focus rests on it its likes, dislikes (Settings ›
// Dislike counts) and the start of its description. The page's
// buttons (listButtons): Play all, Shuffle, a Repeat switch, YouTube's Save
// to library and Shortcut, as Settings › Playlist buttons chooses.

import { h, setPicture, setShown, setText, toggleClass } from '../core/dom.js';
import { tr } from '../core/i18n.js';
import { shortCount, votes } from '../api/dislikes.js';
import { dots, largestThumbnail, PageButton, thumbnail } from '../api/feed.js';
import { prefs } from '../api/prefs.js';
import { likesOf } from '../api/watch.js';
import { firstStreams } from '../player/preload.js';
import { icon } from '../ui/icons.js';
import { TileItem } from '../ui/tile-row.js';

/** How the preview plays in the frame (main.ts preloadFocused): the picture it plays over, whether it fills the screen
 * (square, no ring), and with sound */
export interface StagePreview {
    frame: HTMLImageElement;
    backdrop: boolean;
    sound: boolean;
}

/** list in a random order (a copy) */
export function shuffle<T>(list: T[]): T[] {
    var out = list.slice();
    for (var i = out.length - 1; i > 0; i--) {
        var k = Math.floor(Math.random() * (i + 1));
        var swap = out[i];
        out[i] = out[k];
        out[k] = swap;
    }
    return out;
}

/** A playlist's buttons, in this order, as Settings › Playlist buttons chooses: Play all, the Shuffle and Repeat
 * switches, YouTube's Save to library and Shortcut (a button of the remote for the playlist id, when known); YouTube's
 * own Repeat and Shuffle give way to them, its other buttons follow */
export function listButtons(theirs: PageButton[], id?: string): PageButton[] {
    var chosen = prefs().listButtons;
    var save = theirs.filter(function (b) { return !!b.toggle && /BOOKMARK/.test(b.toggle.icons[0]); })[0];
    var out: PageButton[] = [];
    if (chosen.indexOf('play') >= 0) {
        out.push({ text: tr('Play all'), icon: 'PLAY_ALL', play: { loop: false, shuffle: false } });
    }
    if (chosen.indexOf('shuffle') >= 0) {
        out.push({ text: tr('Shuffle'), icon: 'SHUFFLE', turn: 'shuffle' });
    }
    if (chosen.indexOf('repeat') >= 0) {
        out.push({ text: tr('Repeat'), icon: 'LOOP', turn: 'repeat' });
    }
    if (save && chosen.indexOf('save') >= 0) {
        out.push(save);
    }
    if (id && chosen.indexOf('shortcut') >= 0) {
        out.push({ text: tr('Shortcut'), icon: 'SHORTCUT', shortcut: id });
    }
    return out.concat(theirs.filter(function (b) { return !b.play && b !== save; }));
}

/** A video's likes, dislikes and description, as the frame shows them ('' not known) */
interface Details {
    likes: string;
    dislikes: string;
    about: string;
}

/** The details kept, the latest videos' (going back to a video shows its own at once) */
var KEPT = 40;

export class ListStage {
    /** Under the list: the frame with the picture, and over it (Backdrop) the shade and the dark band behind the list */
    back: HTMLElement;
    private picture: HTMLImageElement;
    /** Over the list's level: the title and line */
    private info: HTMLElement;
    private title: HTMLElement;
    private line: HTMLElement;
    /** Its likes and dislikes (each with its icon, hidden until known) and its description */
    private likes: HTMLElement;
    private dislikes: HTMLElement;
    private about: HTMLElement;
    /** The video shown (its tile's item; null: none) */
    private item: TileItem | null = null;
    /** The details asked for, by video id, and those ids in the order asked */
    private known: { [id: string]: Details } = {};
    private asked: string[] = [];

    /** Its back part goes first in parent (under the list, which goes after it), its details at the end */
    constructor(private parent: HTMLElement) {
        this.back = h('div', 'by-list-back');
        var frame = this.back.appendChild(h('div', 'by-list-frame')) as HTMLElement;
        this.picture = frame.appendChild(h('img', 'by-list-picture')) as HTMLImageElement;
        this.back.appendChild(h('div', 'by-list-shade'));
        this.back.appendChild(h('div', 'by-list-band'));
        parent.insertBefore(this.back, parent.firstChild);
        this.info = h('div', 'by-list-info');
        this.title = this.info.appendChild(h('div', 'by-list-title')) as HTMLElement;
        this.line = this.info.appendChild(h('div', 'by-list-line')) as HTMLElement;
        var votes = this.info.appendChild(h('div', 'by-list-votes')) as HTMLElement;
        this.likes = votes.appendChild(h('span', 'by-list-vote')) as HTMLElement;
        this.likes.appendChild(icon('like', 'by-list-vote-icon'));
        this.likes.appendChild(h('span'));
        this.dislikes = votes.appendChild(h('span', 'by-list-vote')) as HTMLElement;
        this.dislikes.appendChild(icon('dislike', 'by-list-vote-icon'));
        this.dislikes.appendChild(h('span'));
        this.about = this.info.appendChild(h('div', 'by-list-about')) as HTMLElement;
        parent.appendChild(this.info);
    }

    /** The page as Settings › Playlist page has it now (read as the page draws) */
    private get backdrop(): boolean {
        return prefs().listLayout === 'backdrop';
    }

    /** Lays the page out as its settings are now (the parent's bd-page--stage or bd-page--backdrop), or not at all (list:
     * the page shows no playlist now) */
    arrange(list: boolean): void {
        var backdrop = this.backdrop;
        toggleClass(this.parent, 'bd-page--stage', list && !backdrop);
        toggleClass(this.parent, 'bd-page--backdrop', list && backdrop);
    }

    /** Shows a video by its tile's item (the picture, title and line it has; null: nothing) */
    show(item: TileItem | null): void {
        setShown(this.info, !!item && prefs().listDetails);
        if (!item) {
            this.item = null;
            setShown(this.picture, false);
            return;
        }
        setText(this.title, item.title);
        setText(this.line, dots(item.lines || []));
        var same = !!this.item && this.item.id === item.id;
        this.item = item;
        if (same) {
            return;
        }
        this.fill();
        // The tile's picture, in the cache already (Backdrop's biggest once the focus rests: details)
        setShown(this.picture, true);
        setPicture(this.picture, item.image, item.fallback);
    }

    /** The video shown ('' none) */
    get shown(): string {
        return this.item ? this.item.id : '';
    }

    /** Once the focus rests on it (main.ts, as its preview): Backdrop's picture at its biggest (where the tile has
     * YouTube's), and its likes, dislikes and description, asked for once a video: with Settings › Dislike counts the
     * likes come with the dislikes from Return YouTube Dislike, else from YouTube's /next (which a start then has at
     * hand); the description from the streams a start asks for */
    details(): void {
        var item = this.item;
        if (!item) {
            return;
        }
        var id = item.id;
        if (this.backdrop && item.image === thumbnail(id)) {
            setPicture(this.picture, largestThumbnail(id), item.image);
        }
        if (!prefs().listDetails || this.known[id]) {
            return;
        }
        var d: Details = this.known[id] = { likes: '', dislikes: '', about: '' };
        if (this.asked.push(id) > KEPT) {
            delete this.known[this.asked.shift() as string];
        }
        var self = this;
        var got = function (): void {
            if (self.item && self.item.id === id) {
                self.fill();
            }
        };
        var none = function (): void { return undefined; };
        if (prefs().dislikes) {
            votes(id).then(function (v) {
                d.likes = v.likes !== null ? shortCount(v.likes) : '';
                d.dislikes = v.dislikes !== null ? shortCount(v.dislikes) : '';
                got();
            }, none);
        } else {
            likesOf(id).then(function (likes) {
                d.likes = likes;
                got();
            }, none);
        }
        firstStreams(id).then(function (s) {
            d.about = s.description.replace(/\s+/g, ' ').trim();
            got();
        }, none);
    }

    /** The shown video's details as known ('' hides each) */
    private fill(): void {
        var d = this.item && this.known[this.item.id] || { likes: '', dislikes: '', about: '' };
        this.put(this.likes, d.likes);
        this.put(this.dislikes, d.dislikes);
        setText(this.about, d.about);
    }

    /** A count with its icon ('' hides both) */
    private put(vote: HTMLElement, count: string): void {
        setText(vote.lastChild as HTMLElement, count);
        vote.style.display = count ? '' : 'none';
    }

    /** How the preview plays here as Settings › Playlist preview says (null: only the picture) */
    preview(): StagePreview | null {
        var p = prefs();
        var how = p.listPreview === 'previews' ? (p.previews === 'off' ? 'still' : p.previews) : p.listPreview;
        return this.item && how !== 'still' ? { frame: this.picture, backdrop: this.backdrop, sound: how === 'sound' } : null;
    }
}
