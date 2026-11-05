// Watch page over the player (own-player.ts), modelled on YouTube's TV watch page: title and metadata at the top;
// at the bottom the time, the progress bar (with SponsorBlock segments and chapters) and a row of buttons
// (channel, description, subscribe, previous / play-pause / next, like, dislike, comments, save, subtitles,
// settings); below them the related videos (api/watch.ts), three per row, entered with Down. Related tiles are
// built as soon as the details arrive and kept while hidden, so Down shows them at once. Lists open in the side
// panel (ui/side-panel.ts), the comments over the video as YouTube's (comments-view.ts). Up from the buttons
// focuses the bar (Left/Right jump); the page hides after HIDE_MS
// without a key while the video plays. It also holds the video's details (e.g. the video YouTube plays next). Its
// likes and dislikes show beside the views once the dislikes are known, as Return YouTube Dislike estimates them (asked
// when it shows a video: api/dislikes.ts; Settings: Dislike counts).
// Related layout sizes come from the theme (metrics.watch), the rest from themes/<id>.css.

import { h, setShown, setSrc, setText, toggleClass, translate } from '../../core/dom.js';
import { KEY } from '../../core/keys.js';
import { clock } from '../../core/time.js';
import { RowStack } from '../../ui/row-stack.js';
import { rowHeight, TileRow } from '../../ui/tile-row.js';
import { dearrowTitle } from '../api/dearrow.js';
import { dislikes, shortCount } from '../api/dislikes.js';
import { dots, Page, Video, videoOf } from '../api/feed.js';
import { prefs } from '../api/prefs.js';
import { Segment } from '../api/sponsorblock.js';
import { Comments, comments, WatchInfo } from '../api/watch.js';
import { apply, openSaveTo, pressSubscribe, subscribed } from '../ui/account.js';
import { icon, setIcon } from '../ui/icons.js';
import { Pills } from '../ui/pills.js';
import { PanelLine, paragraphs, SidePanel } from '../ui/side-panel.js';
import { metrics, themed } from '../ui/theme.js';
import { gridLines, VideoTiles } from '../views/tiles.js';
import { bufferedEnd } from './engine.js';
import { liveShare, LiveSpan, liveTime } from './live-engine.js';
import { BarMarks } from './bar-marks.js';
import { CommentsView } from './comments-view.js';
import { SeekPreview } from './seek-preview.js';

var HIDE_MS = 8000;
/** Focus resting this long on a video prefetches it (as on the browse screens); on the channel button or Comments
 * after CHANNEL_REST_MS, since the channel page takes ~0.9 s to load and Comments fetch their first part */
var REST_MS = 1500;
var CHANNEL_REST_MS = 500;
var JUMP_S = 10;

/** What the page's buttons do in the player */
export interface WatchActions {
    toggle(): void;
    jump(seconds: number): void;
    previous(): void;
    next(): void;
    /** The video Next plays (the queue's next, else YouTube's; null: none) */
    nextVideo(): Video | null;
    play(video: Video): void;
    channel(page: Page): void;
    subtitles(): void;
    settings(): void;
    /** Focus rested on a video that may be played (a related one, or Next's): prefetch it */
    rest(video: Video): void;
    /** Focus rested on a page that may be opened (the channel, a related playlist): prefetch it */
    restPage(page: Page): void;
    /** A live stream's window (null: a video) */
    live(): LiveSpan | null;
    /** The video's length (s; 0 unknown) */
    length(): number;
    /** The comments of video id opened (null: closed): offered to the phone meanwhile, as YouTube's TV app does */
    comments(id: string | null): void;
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
    /** Return YouTube Dislike's count for the video (null: none known), and whether it was asked for */
    private dislikeCount: number | null = null;
    private dislikesAsked = false;
    /** The comments over the video, as YouTube's player shows them */
    private comments: CommentsView;
    /** Incremented per video, so late replies for the previous one are dropped */
    private gen = 0;
    private hideTimer = 0;
    private restTimer = 0;
    /** YouTube's "Includes paid promotion" under the title (hidden: none) */
    private paid: HTMLElement;

    /** before: its place in parent (else last) */
    constructor(parent: HTMLElement, private video: HTMLVideoElement, private actions: WatchActions, before?: Node) {
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
        add(center, icon('next', 'by-watch-button by-watch-icon'), function () { self.actions.next(); }, function () { return !!self.actions.nextVideo(); });
        add(group, this.likeButton, function () { self.like('LIKE'); }, has('like'));
        add(group, this.dislikeButton, function () { self.like('DISLIKE'); }, has('like'));
        this.commentsAt = this.buttons.count;
        add(group, icon('comments', 'by-watch-button by-watch-icon'), function () { self.openComments(); }, has('comments'));
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
        this.comments = new CommentsView(this.el);
        this.comments.onClose = function () {
            toggleClass(self.el, 'by-watch--comments', false);
            self.actions.comments(null);
            self.arm();
        };
        setShown(this.el, false);
        parent.insertBefore(this.el, before || null);
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
        this.dislikeCount = null;
        this.dislikesAsked = false;
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

    /** The video's title (DeArrow's where it has one) */
    setTitle(title: string): void {
        setText(this.title, dearrowTitle(this.id, title));
        this.drawMeta();
    }

    /** The video's description (from its streams) */
    setDescription(text: string): void {
        this.description = text;
    }

    /** Draws SponsorBlock segments and the chapters (from the details) on the bar, for a video of duration s */
    setMarks(segments: Segment[], duration: number): void {
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
            setText(this.title, dearrowTitle(this.id, info.title));
        }
        this.channel = info.channel || this.channel;
        this.drawMeta();
        this.askDislikes();
        setSrc(this.avatar, info.avatar);
        var m = metrics().watch;
        this.tiles = new VideoTiles();
        var self = this;
        this.tiles.shown = function () { return self.stack.rows; };
        // Three a line (they arrive during a start, the page hidden: tiles built once drawn)
        var lines = gridLines(this.tiles.items(info.related), 3, m.tile, m.rows);
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
        // The subscription may have changed on the channel page meanwhile, Dislike counts in Settings
        this.drawAccount();
        this.drawMeta();
        this.askDislikes();
        this.arm();
        this.onShown(true);
    }

    /** Return YouTube Dislike's count, once the page shows the video with its details (only then: each video asked for
     * goes to its server) */
    private askDislikes(): void {
        if (this.dislikesAsked || !this.shown || !this.info || !prefs().dislikes) {
            return;
        }
        this.dislikesAsked = true;
        var self = this;
        var gen = this.gen;
        dislikes(this.id).then(function (n) {
            if (gen === self.gen) {
                self.dislikeCount = n;
                self.drawMeta();
            }
        }, function () {
            // Asked again the next time the page shows the video
            if (gen === self.gen) {
                self.dislikesAsked = false;
            }
        });
    }

    /** Hides the page (related tiles and pictures are kept for next time) */
    hide(): void {
        if (!this.shown) {
            return;
        }
        clearTimeout(this.hideTimer);
        this.panel.close();
        this.comments.close();
        this.zone = 'buttons';
        this.place();
        this.shown = false;
        setShown(this.el, false);
        this.onShown(false);
    }

    /** Handles a key while shown */
    onKey(code: number): void {
        if (this.comments.shown) {
            this.comments.onKey(code);
        } else if (this.panel.shown) {
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
            if (!self.shown || self.panel.shown || self.comments.shown) {
                return;
            }
            var row = self.stack.row;
            var buttons = self.zone === 'buttons';
            var video = self.zone === 'related' && row ? self.tiles.video(row.focused) :
                buttons && self.buttons.at === self.playAt + 1 ? self.actions.nextVideo() : null;
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
            under: info ? dots([info.views, info.published].concat(this.votes())) : ''
        }];
        if (this.channel) {
            lines.push({ label: this.channel, under: info ? info.subscribers : '' });
        }
        this.panel.open('Description', lines.concat(paragraphs(this.description)));
    }

    /** Opens the comments over the video (the watch page's own content hidden, as YouTube's), with the first part if
     * prefetched */
    private openComments(): void {
        var info = this.info as WatchInfo;
        var ahead = this.commentsAhead && this.commentsAhead.token === info.comments ? this.commentsAhead.part : undefined;
        this.commentsAhead = null;
        clearTimeout(this.hideTimer);
        toggleClass(this.el, 'by-watch--comments', true);
        this.comments.open(info.comments, info.commentCount, ahead);
        this.actions.comments(this.id);
    }

    // ---- drawing

    private setStatus(text: string): void {
        setText(this.status, text);
        setShown(this.status, !!text);
    }

    /** "Channel • 23M views • 11y ago" */
    private drawMeta(): void {
        var info = this.info;
        // Channel name left as is: themed() would rewrite "NBA 2K" as a count; likes and dislikes once the dislikes
        // are known
        var votes = this.dislikeCount !== null && prefs().dislikes ? this.votes() : [];
        setText(this.meta, dots([this.channel, info ? themed(info.views) : '', info ? themed(info.age) : ''].concat(votes.map(themed))));
    }

    /** "12K likes", "345 dislikes" (those known) */
    private votes(): string[] {
        var likes = this.info && this.info.likes;
        return [likes ? likes + ' likes' : '', this.dislikeCount !== null && prefs().dislikes ? shortCount(this.dislikeCount) + ' dislikes' : ''];
    }

    /** Draws the subscribed, liked, disliked and saved states as YouTube does */
    private drawAccount(): void {
        var info = this.info;
        // Subscribed: a round bell button (OK: bell options, Unsubscribe), else the Subscribe pill (each drawn only
        // when it changes: every show draws them)
        var el = this.subscribeButton;
        var bell = subscribed(info && info.subscribe);
        if (bell) {
            setIcon(el, 'bell');
        } else {
            el.removeAttribute('data-icon');
            setText(el, 'Subscribe');
        }
        toggleClass(el, 'by-watch-pill', !bell);
        toggleClass(el, 'by-watch-icon', bell);
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
        var d = this.actions.length();
        var t = v.currentTime;
        var span = this.actions.live();
        // The segment's or chapter's name after the time, as on YouTube; live: LIVE or how far behind, over the
        // stream's window
        setText(this.time, span ? liveTime(t, span) : dots([clock(t), this.marks.nameAt(t)]));
        setText(this.length, d && !span ? clock(d) : '');
        var share = function (at: number): string {
            return (span ? liveShare(at, span) : d ? Math.min(1, at / d) : 0).toFixed(3);
        };
        var played = share(t);
        var loaded = share(bufferedEnd(v.buffered, t, 1));
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
        if (this.shown && !this.panel.shown && !this.comments.shown && this.zone !== 'related' && !this.video.paused) {
            this.hideTimer = setTimeout(function () {
                if (!self.panel.shown && !self.comments.shown && self.zone !== 'related' && !self.video.paused) {
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
