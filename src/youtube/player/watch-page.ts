// Watch page over the player (own-player.ts), modelled on YouTube's TV watch page: title and metadata at the top;
// at the bottom the time, the progress bar (with SponsorBlock segments and chapters) and a row of buttons
// (channel, description, subscribe, previous / play-pause / next, like, dislike, comments, save, subtitles,
// settings); below them the related videos (api/watch.ts), three per row, entered with Down. Related tiles are
// built as soon as the details arrive and kept while hidden, so Down shows them at once. Lists open in the side
// panel (ui/side-panel.ts). Up from the buttons focuses the bar (Left/Right jump); the page hides after HIDE_MS
// without a key while the video plays. It also holds the video's details (e.g. the video YouTube plays next).
// Related layout sizes come from the theme (metrics.watch), the rest from themes/<id>.css.

import { h, setShown, setSrc, setText, toggleClass, translate } from '../../core/dom.js';
import { KEY } from '../../core/keys.js';
import { clock } from '../../core/time.js';
import { RowStack } from '../../ui/row-stack.js';
import { rowHeight, TileRow } from '../../ui/tile-row.js';
import { dots, Page, Video, videoOf } from '../api/feed.js';
import { Segment } from '../api/sponsorblock.js';
import { Comments, comments, WatchInfo } from '../api/watch.js';
import { apply, drawSubscribe, openSaveTo, pressSubscribe } from '../ui/account.js';
import { icon, setIcon } from '../ui/icons.js';
import { Pills } from '../ui/pills.js';
import { PanelLine, paragraphs, SidePanel } from '../ui/side-panel.js';
import { metrics, themed } from '../ui/theme.js';
import { VideoTiles } from '../views/videos.js';
import { bufferedEnd, lengthOf } from './dash.js';
import { BarMarks, nameAt } from './bar-marks.js';
import { SeekPreview } from './seek-preview.js';

var HIDE_MS = 8000;
/** Focus resting this long on a video prefetches it (as on the browse screens); on the channel button or Comments
 * after CHANNEL_REST_MS, since the channel page takes ~0.9 s to load and Comments fetch their first part */
var REST_MS = 1500;
var CHANNEL_REST_MS = 500;
var JUMP_S = 10;
/** More comments are requested once the focus is this near their end */
var COMMENTS_AHEAD = 4;

/** What the page's buttons do in the player */
export interface WatchActions {
    toggle(): void;
    jump(seconds: number): void;
    previous(): void;
    next(): void;
    play(video: Video): void;
    channel(page: Page): void;
    subtitles(): void;
    settings(): void;
    /** Focus rested on a video that may be played (a related one, or Next's): prefetch it */
    rest(video: Video): void;
    /** Focus rested on a page that may be opened (the channel, a related playlist): prefetch it */
    restPage(page: Page): void;
}

type Zone = 'bar' | 'buttons' | 'related';

export class WatchPage {
    shown = false;
    /** Called when shown or hidden (also when it hides itself) */
    onShown: (shown: boolean) => void = function () { return undefined; };
    /** Side panel for lists over the page (the zone is kept) */
    panel: SidePanel;
    private el: HTMLElement;
    private body: HTMLElement;
    private title: HTMLElement;
    private meta: HTMLElement;
    private time: HTMLElement;
    private length: HTMLElement;
    private loaded: HTMLElement;
    private played: HTMLElement;
    private knob: HTMLElement;
    private marker: HTMLElement;
    /** The bar's fills and the knob as last written */
    private bar = { played: '', loaded: '', knob: '' };
    private marks: BarMarks;
    /** The seek preview over this page's bar */
    seek: SeekPreview;
    /** The SponsorBlock segments on the bar, for the name after the time */
    private segments: Segment[] = [];
    private avatar: HTMLImageElement;
    private subscribeButton: HTMLElement;
    private playButton: HTMLElement;
    private subtitlesButton: HTMLElement;
    private likeButton: HTMLElement;
    private dislikeButton: HTMLElement;
    private saveButton: HTMLElement;
    private buttons = new Pills('by-watch-button--focused');
    /** Index of play-pause among the buttons */
    private playAt = 0;
    /** Index of the channel button among the buttons */
    private channelAt = 0;
    private commentsAt = 0;
    /** The first comments part, prefetched while the focus rested on Comments (by token) */
    private commentsAhead: { token: string; part: Promise<Comments> } | null = null;
    private status: HTMLElement;
    private stack: RowStack;
    private tiles = new VideoTiles();
    private zone: Zone = 'buttons';
    /** Column kept by Up/Down in the related videos */
    private col = 0;
    private id = '';
    private info: WatchInfo | null = null;
    /** The description (from the video's streams) */
    private description = '';
    private channel = '';
    /** The video is in a playlist (as far as known) */
    private saved = false;
    /** The comments shown, the token of the next part, and the token of the part in flight ('' none) */
    private commentLines: PanelLine[] = [];
    private commentsNext = '';
    private fetching = '';
    /** Incremented per video, so late replies for the previous one are dropped */
    private gen = 0;
    private hideTimer = 0;
    private restTimer = 0;
    /** YouTube's "Includes paid promotion" under the title (hidden: none) */
    private paid: HTMLElement;

    constructor(parent: HTMLElement, private video: HTMLVideoElement, private actions: WatchActions) {
        var self = this;
        this.el = h('div', 'by-watch');
        this.el.appendChild(h('div', 'by-watch-shade'));
        this.el.appendChild(h('div', 'by-watch-dim'));
        this.body = h('div', 'by-watch-body');
        this.el.appendChild(this.body);
        var top = h('div', 'by-watch-top');
        this.title = h('div', 'by-watch-title');
        this.meta = h('div', 'by-watch-meta');
        top.appendChild(this.title);
        top.appendChild(this.meta);
        this.paid = top.appendChild(paidChip()) as HTMLElement;
        this.body.appendChild(top);
        var controls = h('div', 'by-watch-controls');
        var times = h('div', 'by-watch-times');
        this.time = h('div', 'by-watch-time');
        this.length = h('div', 'by-watch-length');
        times.appendChild(this.time);
        times.appendChild(this.length);
        controls.appendChild(times);
        var bar = h('div', 'by-watch-bar');
        this.loaded = h('div', 'by-watch-loaded');
        this.played = h('div', 'by-watch-played');
        this.knob = h('div', 'by-watch-knob');
        this.marker = h('div', 'by-watch-marker');
        bar.appendChild(this.loaded);
        bar.appendChild(this.played);
        this.marks = new BarMarks(bar, null);
        bar.appendChild(this.knob);
        bar.appendChild(this.marker);
        this.seek = new SeekPreview(bar);
        controls.appendChild(bar);
        var row = h('div', 'by-watch-buttons');
        var left = h('div', 'by-watch-left');
        var center = h('div', 'by-watch-center');
        var right = h('div', 'by-watch-right');
        var group = h('div', 'by-watch-group');
        row.appendChild(left);
        row.appendChild(center);
        row.appendChild(right);
        controls.appendChild(row);
        this.body.appendChild(controls);
        var channelButton = h('div', 'by-watch-button by-watch-avatar');
        this.avatar = h('img', 'by-watch-avatar-img') as HTMLImageElement;
        channelButton.appendChild(this.avatar);
        this.subscribeButton = h('div', 'by-watch-button by-watch-pill');
        this.playButton = icon('play', 'by-watch-button by-watch-play');
        this.subtitlesButton = icon('subtitles', 'by-watch-button by-watch-icon');
        this.likeButton = icon('like', 'by-watch-button by-watch-icon');
        this.dislikeButton = icon('dislike', 'by-watch-button by-watch-icon');
        this.saveButton = icon('save', 'by-watch-button by-watch-icon');
        /** Usable test for a button that needs this field of the details */
        var has = function (key: keyof WatchInfo): () => boolean {
            return function () { return !!(self.info && self.info[key]); };
        };
        var add = function (box: HTMLElement, el: HTMLElement, press: () => void, usable?: () => boolean): void {
            box.appendChild(self.buttons.add(el, press, usable));
        };
        this.channelAt = this.buttons.count;
        add(left, channelButton, function () { self.actions.channel((self.info as WatchInfo).channelPage as Page); }, has('channelPage'));
        add(left, h('div', 'by-watch-button by-watch-pill', 'Description'), function () { self.descriptionPanel(); });
        add(left, this.subscribeButton, function () { self.subscribe(); }, has('subscribe'));
        add(center, icon('previous', 'by-watch-button by-watch-icon'), function () { self.actions.previous(); });
        this.playAt = this.buttons.count;
        add(center, this.playButton, function () { self.actions.toggle(); });
        add(center, icon('next', 'by-watch-button by-watch-icon'), function () { self.actions.next(); }, function () { return !!self.upcoming(); });
        add(group, this.likeButton, function () { self.like('LIKE'); }, has('like'));
        add(group, this.dislikeButton, function () { self.like('DISLIKE'); }, has('like'));
        this.commentsAt = this.buttons.count;
        add(group, icon('comments', 'by-watch-button by-watch-icon'), function () { self.commentsPanel(); }, has('comments'));
        add(group, this.saveButton, function () { self.savePanel(); }, function () { return !!self.info; });
        // Last in the group, as on YouTube
        add(group, this.subtitlesButton, function () { self.actions.subtitles(); });
        right.appendChild(group);
        add(right, icon('settings', 'by-watch-button by-watch-icon'), function () { self.actions.settings(); });
        var m = metrics().watch;
        this.stack = new RowStack('by-watch-related', rowHeight(m.tile, true, m.rows), m.focusTop);
        this.stack.el.style.top = m.top + 'px';
        this.stack.setFocused(false);
        this.body.appendChild(this.stack.el);
        this.status = h('div', 'by-watch-status');
        this.status.style.top = m.top + 'px';
        this.body.appendChild(this.status);
        this.panel = new SidePanel(this.el);
        setShown(this.el, false);
        parent.appendChild(this.el);
        ['play', 'pause', 'timeupdate', 'progress'].forEach(function (type) {
            video.addEventListener(type, function () {
                if (self.shown) {
                    self.update();
                }
            });
        });
        video.addEventListener('play', function () { self.arm(); });
    }

    /** Sets a new video: title and channel until its details arrive; the page's lists are cleared */
    setVideo(id: string, title: string, channel: string): void {
        this.clear();
        this.id = id;
        this.channel = channel;
        this.setTitle(title);
        this.setStatus('Loading related videos …');
        this.buttons.draw();
        this.place();
    }

    /** The player released the video: drops its details, the related tiles and the pictures */
    clear(): void {
        this.hide();
        this.gen++;
        this.commentsAhead = null;
        this.info = null;
        this.saved = false;
        this.description = '';
        this.stack.setRows([]);
        this.marks.draw([], [], 0);
        this.setPaid('');
        setSrc(this.avatar, '');
    }

    /** YouTube's notice that the video includes paid promotion ('' none) */
    setPaid(text: string): void {
        setPaid(this.paid, text);
    }

    setTitle(title: string): void {
        setText(this.title, title);
        this.drawMeta();
    }

    /** The video's description (from its streams) */
    setDescription(text: string): void {
        this.description = text;
    }

    /** Draws SponsorBlock segments and the chapters (from the details) on the bar, for a video of duration s */
    setMarks(segments: Segment[], duration: number): void {
        this.segments = segments;
        this.marks.draw(segments, this.info ? this.info.chapters : [], duration);
    }

    /** The video's details (null: none, or they failed to load) */
    get details(): WatchInfo | null {
        return this.info;
    }

    /** The video's details arrived (null: failed): builds the related tiles and fetches their pictures, even while
     * the page is hidden */
    setInfo(info: WatchInfo | null): void {
        this.info = info;
        if (!info) {
            this.setStatus('Could not load the related videos.');
            return;
        }
        if (info.title) {
            setText(this.title, info.title);
        }
        this.channel = info.channel || this.channel;
        this.drawMeta();
        setSrc(this.avatar, info.avatar);
        var m = metrics().watch;
        this.tiles = new VideoTiles();
        var items = this.tiles.items(info.related);
        var lines: TileRow[] = [];
        for (var i = 0; i < items.length; i += 3) {
            lines.push(new TileRow({ title: '', shape: m.tile, layout: m.rows, items: items.slice(i, i + 3), noTitle: true, noWrap: true }));
        }
        this.stack.setRows(lines);
        this.stack.setFocused(this.zone === 'related');
        this.setStatus(lines.length ? '' : 'No related videos.');
        this.buttons.draw();
        this.drawAccount();
    }

    /** The video YouTube would play next: its related tile, else the first related (null: unknown) */
    upcoming(): Video | null {
        var info = this.info;
        if (!info) {
            return null;
        }
        var related = info.related.filter(function (v) { return v.id === info!.next; })[0] || info.related[0];
        return related || (info.next ? videoOf(info.next) : null);
    }

    /** Marks the subtitles button on or off */
    setSubtitles(on: boolean): void {
        toggleClass(this.subtitlesButton, 'by-watch-button--on', on);
    }

    /** Target of a pending jump (fraction of the length; -1 none) */
    setMarker(share: number): void {
        setShown(this.marker, share >= 0);
        if (share >= 0) {
            this.marker.style.left = (share * 100).toFixed(2) + '%';
        }
    }

    /** Shows the page with the focus on play-pause (related: on the related videos, as at the end of a video) */
    show(related?: boolean): void {
        this.zone = 'buttons';
        this.buttons.focus(this.playAt);
        this.shown = true;
        setShown(this.el, true);
        if (related && this.stack.rows.length) {
            this.enterRelated();
        }
        this.place();
        this.update();
        // The subscription may have changed on the channel page meanwhile
        this.drawAccount();
        this.arm();
        this.onShown(true);
    }

    /** Hides the page (related tiles and pictures are kept for next time) */
    hide(): void {
        if (!this.shown) {
            return;
        }
        clearTimeout(this.hideTimer);
        this.panel.close();
        this.zone = 'buttons';
        this.place();
        this.shown = false;
        setShown(this.el, false);
        this.onShown(false);
    }

    /** Handles a key while shown */
    onKey(code: number): void {
        if (this.panel.shown) {
            this.panel.onKey(code);
        } else if (this.zone === 'related') {
            this.relatedKey(code);
        } else if (this.zone === 'bar') {
            this.barKey(code);
        } else {
            this.buttonKey(code);
        }
        this.arm();
        this.restSoon();
    }

    /** After the focus rests on a related video or Next, reports that video for prefetching; on the channel button
     * or a related page, that page; on Comments, prefetches their first part */
    private restSoon(): void {
        clearTimeout(this.restTimer);
        var self = this;
        this.restTimer = setTimeout(function () {
            if (!self.shown || self.panel.shown) {
                return;
            }
            var row = self.stack.row;
            var buttons = self.zone === 'buttons';
            var video = self.zone === 'related' && row ? self.tiles.video(row.focused) :
                buttons && self.buttons.at === self.playAt + 1 ? self.upcoming() : null;
            var page = video ? video.page : buttons && self.buttons.at === self.channelAt && self.info ? self.info.channelPage : null;
            var token = buttons && self.buttons.at === self.commentsAt && self.info ? self.info.comments : '';
            if (page) {
                self.actions.restPage(page);
            } else if (video) {
                self.actions.rest(video);
            } else if (token && !(self.commentsAhead && self.commentsAhead.token === token)) {
                var ahead = self.commentsAhead = { token: token, part: comments(token) };
                ahead.part.then(null, function () {
                    if (self.commentsAhead === ahead) {
                        self.commentsAhead = null;
                    }
                });
            }
        }, this.zone === 'buttons' && (this.buttons.at === this.channelAt || this.buttons.at === this.commentsAt) ? CHANNEL_REST_MS :
            REST_MS) as unknown as number;
    }

    // ---- keys

    private buttonKey(code: number): void {
        switch (code) {
            case KEY.LEFT:
            case KEY.RIGHT:
                this.buttons.move(code === KEY.LEFT ? -1 : 1);
                break;
            case KEY.UP:
                this.zone = 'bar';
                this.drawZone();
                this.update();
                break;
            case KEY.DOWN:
                if (this.stack.rows.length) {
                    this.enterRelated();
                    this.place();
                }
                break;
            case KEY.OK:
                this.buttons.press();
                break;
            case KEY.BACK:
                this.hide();
                break;
        }
    }

    private barKey(code: number): void {
        switch (code) {
            case KEY.LEFT:
            case KEY.RIGHT:
                this.actions.jump(code === KEY.LEFT ? -JUMP_S : JUMP_S);
                break;
            case KEY.OK:
                this.actions.toggle();
                break;
            case KEY.DOWN:
                this.zone = 'buttons';
                this.drawZone();
                break;
            case KEY.UP:
            case KEY.BACK:
                this.hide();
                break;
        }
    }

    private enterRelated(): void {
        this.zone = 'related';
        this.stack.focusRow(0);
        (this.stack.row as TileRow).focusAt(this.col = 0);
    }

    private relatedKey(code: number): void {
        var row = this.stack.row as TileRow;
        switch (code) {
            case KEY.LEFT:
            case KEY.RIGHT:
                if (row.move(code === KEY.LEFT ? -1 : 1)) {
                    this.col = row.index;
                }
                break;
            case KEY.UP:
            case KEY.DOWN:
                if (code === KEY.UP && this.stack.index === 0) {
                    this.zone = 'buttons';
                } else if (this.stack.move(code === KEY.UP ? -1 : 1)) {
                    (this.stack.row as TileRow).focusAt(this.col);
                }
                this.place();
                break;
            case KEY.OK:
                var video = this.tiles.video(row.focused);
                if (video) {
                    this.actions.play(video);
                }
                break;
            case KEY.BACK:
                this.zone = 'buttons';
                this.place();
                break;
        }
    }

    // ---- account buttons

    /** Subscribes; when subscribed, opens the bell options and Unsubscribe */
    private subscribe(): void {
        var self = this;
        var sub = (this.info as WatchInfo).subscribe;
        if (sub) {
            pressSubscribe(sub, this.channel, this.panel, function () {
                self.drawAccount();
                self.panel.refresh();
            });
        }
    }

    /** Likes or dislikes; pressing the active one again clears it */
    private like(status: string): void {
        var self = this;
        var like = (this.info as WatchInfo).like;
        if (like) {
            var to = like.status === status ? 'INDIFFERENT' : status;
            apply(like, 'status', to, like.commands[to], function () { self.drawAccount(); }, 'YouTube did not take that.');
        }
    }

    /** Playlists to save to (Watch later first), ticked when the video is in them; OK adds or removes */
    private savePanel(): void {
        var gen = this.gen;
        var self = this;
        openSaveTo(this.panel, this.id, false, function (any) {
            if (gen === self.gen) {
                self.saved = any;
                self.drawAccount();
            }
        });
    }

    // ---- panel lists

    /** Title with views, date and likes, the channel, then the description by paragraph */
    private descriptionPanel(): void {
        var info = this.info;
        var lines: PanelLine[] = [{
            label: this.title.textContent || '',
            under: info ? dots([info.views, info.published, info.likes ? info.likes + ' likes' : '']) : ''
        }];
        if (this.channel) {
            lines.push({ label: this.channel, under: info ? info.subscribers : '' });
        }
        this.panel.open('Description', lines.concat(paragraphs(this.description)));
    }

    /** Opens the comments and requests the first part */
    private commentsPanel(): void {
        var self = this;
        this.commentLines = [{ label: 'Loading comments …', plain: true }];
        this.panel.open('Comments', function () { return self.commentLines; }, 0, function () { self.moreComments(); });
        this.commentsNext = (this.info as WatchInfo).comments;
        this.moreComments(true);
    }

    /** Loads the next comments part when the focus nears the end (first: the first part, replacing "Loading";
     * a part still in flight for previously opened comments is ignored) */
    private moreComments(first?: boolean): void {
        var token = this.commentsNext;
        if (!token || this.fetching && !first || !first && this.panel.at < this.panel.count - 1 - COMMENTS_AHEAD) {
            return;
        }
        this.fetching = token;
        var gen = this.gen;
        var self = this;
        // The first part may already be prefetched (focus rested on Comments)
        var ahead = first && this.commentsAhead && this.commentsAhead.token === token ? this.commentsAhead.part : null;
        this.commentsAhead = null;
        (ahead || comments(token)).then(function (part) {
            if (self.fetching === token) {
                self.fetching = '';
            }
            if (gen !== self.gen || self.commentsNext !== token) {
                return;
            }
            var lines: PanelLine[] = part.list.map(function (c) {
                return {
                    over: dots([c.author, c.age]),
                    label: c.text,
                    plain: true,
                    under: dots([c.likes ? c.likes + ' likes' : '', c.replies ? c.replies + (c.replies === 1 ? ' reply' : ' replies') : ''])
                };
            });
            self.commentsNext = part.next;
            if (first) {
                self.commentLines = lines.length ? lines : [{ label: 'No comments yet.', plain: true }];
                self.panel.refresh();
            } else {
                self.commentLines = self.commentLines.concat(lines);
                self.panel.add(lines);
            }
        }, function () {
            if (self.fetching === token) {
                self.fetching = '';
            }
            if (first && gen === self.gen && self.commentsNext === token) {
                self.commentLines = [{ label: 'Could not load the comments.', plain: true }];
                self.panel.refresh();
            }
        });
    }

    // ---- drawing

    private setStatus(text: string): void {
        setText(this.status, text);
        setShown(this.status, !!text);
    }

    /** "Channel • 23M views • 11y ago" */
    private drawMeta(): void {
        var info = this.info;
        // Channel name left as is: themed() would rewrite "NBA 2K" as a count
        setText(this.meta, dots([this.channel, info ? themed(info.views) : '', info ? themed(info.age) : '']));
    }

    /** Draws the subscribed, liked, disliked and saved states as YouTube does */
    private drawAccount(): void {
        var info = this.info;
        // Subscribed: a round bell button (OK: bell options, Unsubscribe), else the Subscribe pill
        var sub = info && info.subscribe;
        var el = this.subscribeButton;
        el.removeAttribute('data-icon');
        drawSubscribe(el, sub, 'by-watch-subscribe--on');
        var bell = !!(sub && sub.subscribed);
        toggleClass(el, 'by-watch-pill', !bell);
        toggleClass(el, 'by-watch-icon', bell);
        if (bell) {
            setIcon(el, 'bell');
        }
        var status = info && info.like ? info.like.status : '';
        setIcon(this.likeButton, status === 'LIKE' ? 'liked' : 'like');
        setIcon(this.dislikeButton, status === 'DISLIKE' ? 'disliked' : 'dislike');
        setIcon(this.saveButton, this.saved ? 'saved' : 'save');
    }

    /** Draws the focused zone: the bar's knob, the buttons' focus, or the related videos (page slid up) */
    private drawZone(): void {
        toggleClass(this.el, 'by-watch--bar', this.zone === 'bar');
        toggleClass(this.el, 'by-watch--related', this.zone === 'related');
        this.buttons.setFocused(this.zone === 'buttons');
        this.stack.setFocused(this.zone === 'related');
    }

    /** Slides the page so the focused row of related videos sits at the theme's position (else unshifted) */
    private place(): void {
        this.drawZone();
        var m = metrics().watch;
        translate(this.body, 0, this.zone === 'related' ? m.focusTop - m.top - this.stack.top : 0);
        // Related rows above the focused one are hidden, as on YouTube: only the video shows above it
        var at = this.zone === 'related' ? this.stack.index : 0;
        this.stack.rows.forEach(function (row, i) {
            toggleClass(row.el, 'by-watch-above', i < at);
        });
    }

    /** Updates the time, the bar (fills scaled, written only on change) and the play-pause icon */
    private update(): void {
        var v = this.video;
        var d = lengthOf(v);
        var t = v.currentTime;
        // The segment's or chapter's name after the time, as on YouTube
        setText(this.time, dots([clock(t), nameAt(this.segments, this.info ? this.info.chapters : [], t)]));
        setText(this.length, d ? clock(d) : '');
        var played = d ? Math.min(1, t / d).toFixed(3) : '0';
        var loaded = d ? Math.min(1, bufferedEnd(v.buffered, t, 1) / d).toFixed(3) : '0';
        if (played !== this.bar.played) {
            this.bar.played = played;
            this.played.style.webkitTransform = 'scaleX(' + played + ')';
        }
        if (loaded !== this.bar.loaded) {
            this.bar.loaded = loaded;
            this.loaded.style.webkitTransform = 'scaleX(' + loaded + ')';
        }
        // The knob is drawn only while the bar has the focus
        var knob = this.zone === 'bar' ? (+played * 100).toFixed(1) + '%' : this.bar.knob;
        if (knob !== this.bar.knob) {
            this.bar.knob = knob;
            this.knob.style.left = knob;
        }
        setIcon(this.playButton, v.paused ? 'play' : 'pause');
    }

    /** Hides the page after HIDE_MS without a key while the focus is on the bar or buttons and the video plays
     * (re-armed by a key or by playback resuming) */
    private arm(): void {
        clearTimeout(this.hideTimer);
        var self = this;
        if (this.shown && !this.panel.shown && this.zone !== 'related' && !this.video.paused) {
            this.hideTimer = setTimeout(function () {
                if (!self.panel.shown && self.zone !== 'related' && !self.video.paused) {
                    self.hide();
                }
            }, HIDE_MS) as unknown as number;
        }
    }
}

/** YouTube's "Includes paid promotion" chip (icon, text via setPaid), hidden until it has text */
export function paidChip(): HTMLElement {
    var el = h('div', 'by-paid');
    el.appendChild(icon('paid', 'by-paid-icon'));
    el.appendChild(h('span', ''));
    setShown(el, false);
    return el;
}

/** Sets a paid chip's text and shows it ('' hides it) */
export function setPaid(chip: HTMLElement, text: string): void {
    setText(chip.lastChild as HTMLElement, text);
    setShown(chip, !!text);
}
