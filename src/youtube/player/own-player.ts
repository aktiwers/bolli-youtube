// The own player (Settings: Player): plays a video full screen in the app's
// own <video> through Media Source (dash.ts), from guest streams
// (api/streams.ts) or, when YouTube requires the account, via SABR
// (sabr-engine.ts). It starts far sooner than YouTube's TV app and answers
// keys at once. Playback is reported to History (api/stats.ts). Down opens
// the watch page (watch-page.ts): quality, subtitles, audio track, repeat,
// autoplay, stats; no speed control, as the TV's Media Source plays only at
// 1x. Videos it cannot play go to YouTube's player (onFallback). A casting
// phone (cast.ts) drives it through its public methods and onChange.

import { h, setShown, toggleClass } from '../../core/dom.js';
import { KEY } from '../../core/keys.js';
import { noteZap } from '../../core/perf.js';
import { load, save } from '../../core/store.js';
import { clock } from '../../core/time.js';
import { PlayerOsd } from '../../player/osd.js';
import { SubtitleView } from '../../player/subtitles.js';
import { PROBLEM, skipEdge, toast } from '../ui/toast.js';
import { knownAvatar } from '../api/avatars.js';
import { dots, Page, thumbnail, thumbnailFallback, Video, videoOf } from '../api/feed.js';
import { prefs, setPref } from '../api/prefs.js';
import { Segment, segmentAt, segments, skippedText } from '../api/sponsorblock.js';
import { WatchReport } from '../api/stats.js';
import { noAnswer } from '../api/youtube.js';
import { AudioTrack, base, Caption, captionList, forgetStreams, Format, kindOf, NoStreams, pickFormat, playableStreams, sabrStreams, streams, Streams } from '../api/streams.js';
import { channelPicture, watchInfo, WatchInfo } from '../api/watch.js';
import { FillLoader } from '../ui/fill-loader.js';
import { PanelLine } from '../ui/side-panel.js';
import { CAPTION_STYLES, Captions, loadCaptions, translationsRefused } from './captions.js';
import { bufferedEnd, DashEngine, dropAhead, Engine, lengthOf } from './dash.js';
import { OFF_START_S, pauseVideo, pictureKind, playVideo, releasePipeline } from './pipeline.js';
import { note, ranges } from './play-log.js';
import { BarMarks, chapterJump, nameAt } from './bar-marks.js';
import { SeekPreview } from './seek-preview.js';
import { SabrEngine } from './sabr-engine.js';
import { StatsBox } from './stats-box.js';
import { UpNext } from './up-next.js';
import { paidChip, setPaid, WatchPage } from './watch-page.js';

var JUMP_S = 10;
/** Presses of Left/Right this close together add up to one jump */
var JUMP_REST_MS = 700;
/** Holding Left/Right (the remote repeats every ~120 ms after ~560 ms; gaps up to HOLD_GAP_MS still count as one
 * hold): as in YouTube's player, the jump doubles every HOLD_DOUBLE_MS once held HOLD_GROW_MS, up to HOLD_MOST of
 * the video. Single presses stay 10 s. */
var HOLD_GAP_MS = 350;
/** Presses closer than this are the remote's key repeats */
var REPEAT_MS = 200;
/** A second press this soon after a first one jumps to the next or previous chapter instead (and each further press
 * as quick, another chapter) */
var DOUBLE_MS = 350;
/** A press is a first one only this long after the press before: a held key starts repeating after ~0.5 s */
var FRESH_MS = 700;
var HOLD_GROW_MS = 1000;
var HOLD_DOUBLE_MS = 1500;
var HOLD_MOST = 0.04;
/** A video not playing this long after OK goes to YouTube's player */
var START_GIVE_UP_MS = 15000;
/** The most the TV shows and decodes (4K): the Auto and "Highest available" cap */
var MAX_HEIGHT = 2160;
/** A quality switch takes effect this far ahead (s), beyond what the TV's decoder already holds (removing buffer
 * under the decoder fails) */
var QUALITY_SWITCH_S = 10;
/** A video the viewer closed (Back, its channel page) is kept this long to resume as it was */
var LEFT_MS = 60000;
/** An audio track switch takes effect this far ahead (s; the audio decoder holds less than the video decoder) */
var AUDIO_SWITCH_S = 2;
/** A skip segment ending this close to the video's end (s) counts as reaching the end */
var END_SKIP_S = 1;
/** The next video is preloaded this long before the end (s) */
var NEXT_AHEAD_S = 30;
/** Previous this far into a video restarts it instead */
var RESTART_AFTER_S = 5;
/** Recent videos handed to YouTube's player, with the reason (localStorage bolli.v1.youtube.fallbacks) */
var FALLBACKS = 'youtube.fallbacks';
var FALLBACKS_KEPT = 10;
/** How many videos Previous can go back through */
var BEFORE_MAX = 20;
/** Loading sign fill at each start step (hidden once the picture plays) */
var FILLS: { [step: string]: number } = { start: 0.2, streams: 0.45, loadedmetadata: 0.7 };
/** The TV shows the first picture only after decoding this much video (s). The loading sign fills with those frames
 * and is full FULL_S before they are all in (fill pace: themes, .by-loader--round). */
var WARM_S = 3;
var FULL_S = 0.4;
var KEYS_LINE = 'OK pause  ·  Left / Right jump 10 s (twice: chapter)  ·  Up the description  ·  Down related videos, subtitles and more';

/** A video handed to the player while it plays (nothing reloaded): its streams, the format playing, the target format
 * (switched to in place), the audio and the engine */
interface Taken {
    id: string;
    streams: Streams;
    video: Format;
    target: Format;
    audio: AudioTrack;
    engine: Engine;
}

interface Want {
    id: string;
    title: string;
    channel: string;
    /** Where to start (s) */
    t: number;
    /** Watch page details once fetched (not fetched again when returning to the video) */
    info?: WatchInfo | null;
    /** Choices to restore (e.g. back from the background): format, audio track, subtitles (by name), repeat */
    itag?: number;
    audioId?: string;
    caption?: string;
    loop?: boolean;
    /** YouTube's paid promotion notice was shown (only on the first start) */
    paidShown?: boolean;
}

export class OwnPlayer {
    shown = false;
    onShown: (shown: boolean) => void = function () { return undefined; };
    /** Closed (Back, the end) */
    onClosed: () => void = function () { return undefined; };
    /** A video reported to History stopped (closed or replaced): progress (0-1) and position (s) */
    onWatched: (id: string, progress: number, t: number) => void = function () { return undefined; };
    /** YouTube's player takes over the video, from t (s) */
    onFallback: (id: string, t: number) => void = function () { return undefined; };
    /** Open a page over the app (the channel's) after closing the player */
    onPage: (page: Page) => void = function () { return undefined; };
    /** The video that may play next, to preload: NEXT_AHEAD_S before the end (kept: not cancelled by keys), or when
     * the watch page's focus rests on it */
    onAhead: (video: Video, kept: boolean) => void = function () { return undefined; };
    /** A page the watch page's focus rests on (channel, related playlist), to preload */
    onPageAhead: (page: Page) => void = function () { return undefined; };
    /** Playback state changed (another video, play, pause, waiting, seek, end, duration, closed) */
    onChange: () => void = function () { return undefined; };
    /** Videos queued with a start (a mix, a phone's list: cast.ts); Next, Previous and the end use them first */
    queue: ListQueue | null = null;
    private el: HTMLElement;
    private video: HTMLVideoElement;
    /** The ended video's thumbnail, shown while Up next's video loads hidden (showPoster) */
    private poster: HTMLImageElement;
    private osd: PlayerOsd;
    private watch: WatchPage;
    private upNext: UpNext;
    /** SponsorBlock segments on the info bar's progress bar */
    private osdMarks: BarMarks;
    /** The seek preview over the info bar (the watch page has its own) */
    private osdSeek: SeekPreview;
    /** YouTube's "Includes paid promotion" chip, top left for the first seconds (Streams.paid) */
    private paidChip: HTMLElement;
    private paidTimer = 0;
    private stats: StatsBox;
    private loader: FillLoader;
    private subtitleBox: HTMLElement;
    private subtitleView: SubtitleView;
    private engine: Engine | null = null;
    private want: Want | null = null;
    /** The video's streams, and the format playing */
    private streams: Streams | null = null;
    private format: Format | null = null;
    /** The audio track playing (the original unless a dub was chosen) */
    private audioTrack: AudioTrack | null = null;
    /** Repeat: the video plays again at its end */
    private loop = false;
    /** The watch page details were requested */
    private infoAsked = false;
    /** Videos played before this one since the player opened (Previous) */
    private before: Want[] = [];
    /** History report for this playback (Settings: History; starts when the picture moves) */
    private report: WatchReport | null = null;
    /** The reported video's duration (s; for the progress) */
    private watchLength = 0;
    /** The subtitles shown (null: none) and their cues */
    private caption: Caption | null = null;
    private track: Captions | null = null;
    /** Incremented per start, so late replies for an earlier start are dropped */
    private gen = 0;
    /** Expired URLs were renewed once; inPlaceTried: in-place renewal was tried; renewing: new URLs on the way */
    private renewed = false;
    private inPlaceTried = false;
    private renewing = false;
    /** Streams were fetched the other way (SABR or guest) after the engine failed */
    private switched = false;
    private askedAt = 0;
    private moving = false;
    private segments: Segment[] = [];
    private skipped: { [index: number]: boolean } = {};
    /** Stopped when the app went to the background; resumed when it returns */
    private away: Want | null = null;
    /** Recently closed by the viewer (Back, channel page), to resume as it was (comeBack) */
    private left: { want: Want; at: number } | null = null;
    private leftTimer = 0;
    /** Paused by the viewer or a phone (also during a start, which then stays paused) */
    private held = false;
    /** Target of the accumulated jump (-1: none) and its timer */
    private target = -1;
    private jumpTimer = 0;
    /** The last Left/Right press (time, direction, gap to the previous one) and when the hold began */
    private pressedAt = 0;
    private pressedBy = 0;
    private pressGap = 0;
    private heldSince = 0;
    /** A jump's seek is pending (OK then plays rather than pauses) */
    private jumping = false;
    /** Presses are jumping chapter by chapter (a double press began it); where the first press of a run jumped from */
    private chapterRun = false;
    private firstFrom = 0;
    private startTimer = 0;
    /** Tracks the frames decoded before the first picture (loading sign fill) */
    private warmTimer = 0;
    /** Loading sign fill so far, and whether it is finished (a late update does not show it again) */
    private fillAt = 0;
    private loaderDone = false;
    /** Cues were requested for this caption */
    private captionAsked = false;
    /** A tile preview playing in this player's video (small, at the tile; the app keeps the keys). OK on the tile
     * takes it over as it plays, then switches to the target format. */
    private peek: Taken | null = null;
    /** Called when the preview stops by itself (failed or ended) */
    private peekEnded: () => void = function () { return undefined; };
    /** A ring over the preview's corners to round them like the tile's (the TV's video layer draws square) */
    private ring: HTMLElement;
    /** A video loaded paused in the <video>: the one Up next counts down to (Play now just plays it), or the one the
     * viewer closed (comeBack resumes it). Released when the decoder is needed. */
    private primed: (Taken & { kind: 'next' | 'left' }) | null = null;
    /** onAhead was called for this video */
    private aheadTold = false;

    constructor(parent: HTMLElement) {
        this.el = h('div', 'by-player');
        this.video = h('video') as HTMLVideoElement;
        this.el.appendChild(this.video);
        this.poster = h('img', 'by-player-poster') as HTMLImageElement;
        setShown(this.poster, false);
        this.el.appendChild(this.poster);
        this.ring = h('div', 'by-peek-ring');
        this.subtitleBox = h('div', 'vod-subtitles');
        this.el.appendChild(this.subtitleBox);
        this.subtitleView = new SubtitleView(this.subtitleBox);
        this.loader = new FillLoader(this.el, true);
        var self = this;
        this.osd = new PlayerOsd(this.el, function () { return self.video.paused || !self.moving; }, function () {
            toggleClass(self.subtitleBox, 'vod-subtitles--up', false);
        });
        this.watch = new WatchPage(this.el, this.video, {
            toggle: function () { self.toggle(); },
            jump: function (seconds) { self.jump(seconds); },
            previous: function () { self.previous(); },
            next: function () { self.next(); },
            play: function (video: Video) { self.switchTo(video, true); },
            channel: function (page: Page) {
                self.leave();
                self.onPage(page);
            },
            subtitles: function () { self.watch.panel.open('Subtitles', function () { return self.subtitleLines(); }); },
            settings: function () { self.settingsPanel(); },
            rest: function (video: Video) { self.onAhead(video, false); },
            restPage: function (page: Page) { self.onPageAhead(page); }
        });
        // The subtitles go under the watch page (themes: .by-player--watch)
        this.watch.onShown = function (shown) { toggleClass(self.el, 'by-player--watch', shown); };
        this.upNext = new UpNext(this.el, {
            play: function (video: Video) { self.switchTo(video, true); },
            cancel: function () {
                self.dropPrimed();
                // The ended video was released for the next one: reload it paused at its start (Play replays it)
                if (!self.engine && self.want && self.format) {
                    self.held = true;
                    self.playFormat(self.format, 0);
                }
                self.watch.show(true);
            },
            close: function () { self.stop(); }
        });
        var bar = this.el.querySelector('.osd-bar') as HTMLElement;
        this.osdMarks = new BarMarks(bar, bar.querySelector('.osd-marker'));
        this.osdSeek = new SeekPreview(bar);
        this.paidChip = this.el.appendChild(paidChip()) as HTMLElement;
        toggleClass(this.paidChip, 'by-paid--start', true);
        this.stats = new StatsBox(this.el, this.video, function () {
            var audio = self.audioFormat();
            return {
                id: self.want ? self.want.id : '',
                video: self.format,
                audio: audio,
                best: self.streams && self.streams.videos[0] || null,
                audioName: self.audioTrack ? self.audioTrack.name : '-',
                stable: !!audio && !!self.audioTrack && audio === self.audioTrack.stable
            };
        });
        setShown(this.el, false);
        parent.appendChild(this.el);
        // Over the player, not inside it: a preview's player is clipped to its tile and the ring surrounds it
        parent.appendChild(this.ring);
        ['loadstart', 'loadedmetadata', 'playing'].forEach(function (type) {
            self.video.addEventListener(type, function () { self.step(type); });
        });
        this.video.addEventListener('loadstart', function () { self.stats.loaded(); });
        // A preview or start is displayed only once it plays (display: none, not just hidden: on a reused pipeline the
        // TV's video plane keeps showing the previous video's last frame)
        this.video.addEventListener('playing', function () {
            self.video.style.display = '';
            setShown(self.poster, false);
        });
        this.video.addEventListener('timeupdate', function () { self.tick(); });
        this.video.addEventListener('pause', function () {
            if (self.report) {
                self.report.pause(self.video.currentTime);
            }
        });
        this.video.addEventListener('seeking', function () {
            if (self.report) {
                self.report.seek();
            }
        });
        this.video.addEventListener('seeked', function () { self.jumping = false; });
        this.video.addEventListener('ended', function () {
            // A preview ended: remove it (the tile's picture returns); not the player's end
            if (!self.want) {
                if (self.peek) {
                    self.peekStop();
                    self.peekEnded();
                }
                return;
            }
            self.ended();
        });
        this.video.addEventListener('durationchange', function () { self.drawParts(); });
        ['playing', 'pause', 'waiting', 'seeking', 'seeked', 'ended', 'durationchange'].forEach(function (type) {
            self.video.addEventListener(type, function () { self.onChange(); });
        });
        document.addEventListener('visibilitychange', function () { self.visibility(); });
    }

    /** A video is active (shown, or its streams are loading) */
    get busy(): boolean {
        return !!this.want;
    }

    /** Play a video (t: start position, s; queue: videos to play in order, e.g. a mix or a phone's list) */
    play(id: string, title: string, channel: string, t?: number, queue?: ListQueue | null): void {
        this.before = [];
        this.queue = queue || null;
        var want = { id: id, title: title, channel: channel, t: t || 0 };
        // In the background (cast from a phone): start when the app returns
        if (document.hidden) {
            this.away = want;
            return;
        }
        this.start(want);
    }

    /** Preview id in this player's video at rect (the tile's picture box) from (s), with or without sound. target: the
     * player's format (same codec, so a take-over switches in place); stopped: called on failure. Ignored while a
     * video is active. */
    peekStart(id: string, s: Streams, video: Format, target: Format, audio: AudioTrack, from: number, rect: ClientRect, sound: boolean, stopped: () => void): void {
        if (this.want) {
            return;
        }
        this.peekStop();
        this.letGo();
        var self = this;
        this.peekEnded = stopped;
        var engine: DashEngine = new DashEngine(this.video, function (why) {
            if (engine === self.engine) {
                self.failed(why);
            } else if (self.peek && self.peek.engine === engine) {
                self.peekStop();
                stopped();
            }
        });
        this.peek = { id: id, streams: s, video: video, target: target, audio: audio, engine: engine };
        note('preview', id);
        // Fill the tile like its picture: a video wider or taller than 16:9 is cropped (no black bars) by clipping the
        // player's box to the tile (the TV's video layer ignores the <video> element's own clipping)
        var scale = video.width && video.height ? Math.max(rect.width / video.width, rect.height / video.height) : 0;
        var w = scale ? video.width * scale : rect.width;
        var hh = scale ? video.height * scale : rect.height;
        box(this.el, rect.left, rect.top, rect.width, rect.height);
        box(this.video, (rect.width - w) / 2, (rect.height - hh) / 2, w, hh);
        box(this.ring, rect.left, rect.top, rect.width, rect.height);
        // Hidden until it plays (the tile's picture shows meanwhile)
        this.video.style.display = 'none';
        this.video.muted = !sound;
        toggleClass(this.el, 'by-player--peek', true);
        toggleClass(this.ring, 'by-peek-ring--on', true);
        setShown(this.el, true);
        engine.load(video, audioOf(audio), from, true);
        playVideo(this.video);
    }

    /** Stop the preview (pipeline kept for the next video, tile picture back); returns its position (s; 0: none) */
    peekStop(): number {
        var peek = this.peek;
        if (!peek) {
            return 0;
        }
        // Not shown yet: the time may still be the previous video's
        var t = this.video.style.display === 'none' ? 0 : this.video.currentTime;
        note('preview stop', peek.id + ' at ' + t.toFixed(1));
        this.peek = null;
        pauseVideo(this.video);
        this.unpeek();
        setShown(this.el, this.shown);
        peek.engine.stop();
        return t;
    }

    /** Release the TV's decoder for YouTube's player (tears down the kept pipeline, ~1 s on the TV), unless a video or
     * preview is using it */
    release(): void {
        this.letGo();
        if (!this.want && !this.peek) {
            releasePipeline(this.video);
        }
    }

    /** Whether a preview of id is playing (OK on its tile takes it over) */
    peeking(id: string): boolean {
        return !!this.peek && this.peek.id === id && this.video.style.display !== 'none' && !this.video.ended;
    }

    /** Back to full screen, with the player's controls and sound */
    private unpeek(): void {
        var reset = function (el: HTMLElement): void {
            el.style.left = el.style.top = el.style.width = el.style.height = '';
        };
        reset(this.el);
        reset(this.video);
        reset(this.ring);
        this.video.style.display = '';
        this.video.muted = false;
        toggleClass(this.el, 'by-player--peek', false);
        toggleClass(this.ring, 'by-peek-ring--on', false);
    }

    /** Close (Back, the end) and return to the app (the pipeline is kept for the next video) */
    stop(): void {
        if (this.close()) {
            this.onClosed();
        }
    }

    /** Resume the video the viewer closed within LEFT_MS as it was: at once if still loaded paused, else from its
     * position with its quality, audio and subtitles. id: only that video; queue: play it as the list's first (Play
     * mix, Repeat, Shuffle), then the list. Returns true when it plays. */
    comeBack(id?: string, queue?: ListQueue): boolean {
        var leftId = this.leftId;
        if (!leftId || id && leftId !== id) {
            return false;
        }
        if (queue) {
            this.queue = queue;
        }
        this.start(this.left!.want);
        return true;
    }

    /** The video the viewer recently closed ('' none) */
    get leftId(): string {
        return this.left && Date.now() - this.left.at <= LEFT_MS ? this.left.want.id : '';
    }

    /** Release the closed video kept paused: the TV's only video decoder is needed (another video, a preview,
     * YouTube's player, the background) */
    private letGo(): void {
        if (this.primed && this.primed.kind === 'left') {
            this.dropPrimed();
        }
    }

    /** Closed by the viewer: remember it to resume (unless it ended). A playing video stays loaded paused (engine,
     * buffer, decoder) until LEFT_MS or the decoder is needed (letGo). */
    private leave(): void {
        var ended = this.video.ended;
        var want = this.want;
        var engine = want && this.moving && !ended && this.streams && this.format && this.audioTrack ? this.engine : null;
        var kept = engine ? { id: want!.id, streams: this.streams!, video: this.format!, target: this.format!, audio: this.audioTrack!, engine: engine, kind: 'left' as 'left' } : null;
        if (kept) {
            this.engine = null;
            pauseVideo(this.video);
        }
        var was = this.close(!!kept);
        if (was) {
            note('closed', was.id + (kept ? ' (kept paused)' : ''));
            this.left = ended ? null : { want: was, at: Date.now() };
            if (kept) {
                this.primed = kept;
                var self = this;
                clearTimeout(this.leftTimer);
                this.leftTimer = setTimeout(function () {
                    if (self.primed === kept) {
                        self.dropPrimed();
                    }
                }, LEFT_MS) as unknown as number;
            }
            this.onClosed();
        }
    }

    /** The current playback (null: none): id, position, duration and buffered end (s), and whether it ended, is waiting
     * (starting, seeking, buffering) or paused */
    get now(): Playing | null {
        var v = this.video;
        var want = this.want;
        if (!want) {
            return null;
        }
        var t = this.position();
        return {
            id: want.id,
            t: t,
            duration: lengthOf(v),
            loaded: bufferedEnd(v.buffered, t),
            ended: v.ended,
            waiting: !this.held && (!this.moving || v.seeking || v.readyState < 3 && !v.paused),
            paused: this.held || v.paused
        };
    }

    pause(): void {
        this.held = true;
        pauseVideo(this.video);
    }

    resume(): void {
        // Closed (a phone's Play after Back): resume the closed video on screen rather than play it unseen
        if (!this.want) {
            this.comeBack();
            return;
        }
        // Up next counting down (a phone's Play): play the next video now, not the ended one
        if (this.upNext.shown) {
            this.upNext.playNow();
            return;
        }
        this.held = false;
        playVideo(this.video);
        // Still starting (not Up next's video waiting)
        if (!this.moving && this.engine) {
            this.giveUpLater();
        }
    }

    seekTo(t: number): void {
        t = Math.max(0, t);
        this.showPaid(false);
        if (this.engine && this.moving) {
            this.engine.seek(t);
        } else if (this.want) {
            // Still starting: restart from t (the engine started from the old position)
            this.want.t = t;
            if (this.engine && this.format) {
                this.playFormat(this.format, t);
            }
        }
    }

    /** Volume (0-100) and mute of this player (not the TV's) */
    setVolume(level: number, muted: boolean): void {
        this.video.volume = Math.max(0, Math.min(1, level / 100));
        this.video.muted = muted;
    }

    /** The subtitle language ('' off) */
    get captionLanguage(): string {
        return this.caption ? this.caption.language : '';
    }

    /** Show subtitles in a language ('' off; uploaded tracks first) */
    chooseCaption(language: string): void {
        this.setCaption(this.streams ? captionIn(captionList(this.streams), language) : null);
    }

    onKey(code: number): boolean {
        // Channel up/down zap like TV channels: the next video (the queue's, else YouTube's next) or the previous one
        if (code === KEY.CH_UP || code === KEY.CH_DOWN) {
            this.upNext.hide();
            if (code === KEY.CH_UP) {
                this.next();
            } else {
                this.previous(true);
            }
            return true;
        }
        if (this.upNext.shown) {
            this.upNext.onKey(code);
            return true;
        }
        if (this.watch.shown) {
            this.watch.onKey(code);
            return true;
        }
        switch (code) {
            case KEY.BACK:
                this.leave();
                return true;
            case KEY.OK:
                this.toggle();
                this.showOsd(false);
                return true;
            case KEY.LEFT:
            case KEY.RIGHT:
                this.jump(code === KEY.LEFT ? -JUMP_S : JUMP_S);
                return true;
            case KEY.UP:
                // The description, and Up again closes it (back to the picture alone)
                if (this.osd.asked) {
                    this.osd.hide();
                } else {
                    this.showOsd(true);
                }
                return true;
            case KEY.DOWN:
                this.openWatch();
                return true;
        }
        // The app behind gets no keys while the player shows
        return true;
    }

    /** OK: pause or play. During a jump (pending, or its seek) it jumps now and plays rather than pausing. */
    private toggle(): void {
        if (this.target >= 0 || this.jumping && this.video.seeking) {
            this.jumpNow();
            if (this.held) {
                this.resume();
            }
        } else if (this.video.paused) {
            this.resume();
        } else {
            this.pause();
        }
    }

    /** Jump by seconds, added to a pending jump; it runs to the nearest keyframe once presses stop (the marker shows
     * on the watch page's bar while shown, else on the info bar) */
    private jump(seconds: number): void {
        var v = this.video;
        // Not while starting: in a reused pipeline the time and duration are still the previous video's
        if (!(v.duration > 0) || !this.engine || !this.moving) {
            return;
        }
        var now = Date.now();
        var gap = now - this.pressedAt;
        var info = this.watch.details;
        var to = seconds * this.pressedBy > 0 && gap < DOUBLE_MS && (this.chapterRun || this.pressGap >= FRESH_MS) && info ?
            chapterJump(info.chapters, this.chapterRun ? this.target : this.firstFrom, seconds) : -1;
        if (to >= 0) {
            this.chapterRun = true;
            this.pressedAt = now;
            this.pressGap = gap;
            this.aim(Math.min(v.duration - 1, to));
            return;
        }
        this.chapterRun = false;
        if (seconds * this.pressedBy <= 0 || !(gap < REPEAT_MS || gap < HOLD_GAP_MS && this.pressGap < REPEAT_MS)) {
            this.heldSince = now;
        }
        this.pressedAt = now;
        this.pressedBy = seconds;
        this.pressGap = gap;
        var grow = Math.pow(2, Math.max(0, now - this.heldSince - HOLD_GROW_MS) / HOLD_DOUBLE_MS);
        var step = Math.round(Math.min(Math.abs(seconds) * grow, Math.max(Math.abs(seconds), v.duration * HOLD_MOST)));
        var from = this.target >= 0 ? this.target : v.currentTime;
        this.firstFrom = from;
        this.aim(Math.max(0, Math.min(v.duration - 1, from + (seconds < 0 ? -step : step))));
    }

    /** The pending jump set to t (s), run once presses stop */
    private aim(t: number): void {
        this.target = t;
        this.setMarker(t / this.video.duration);
        if (!this.watch.shown) {
            this.showOsd(false);
        }
        clearTimeout(this.jumpTimer);
        var self = this;
        this.jumpTimer = setTimeout(function () { self.jumpNow(); }, JUMP_REST_MS) as unknown as number;
    }

    /** Run the pending jump now (if any) */
    private jumpNow(): void {
        var to = this.target;
        if (to < 0) {
            return;
        }
        clearTimeout(this.jumpTimer);
        this.target = -1;
        this.setMarker(-1);
        this.showPaid(false);
        if (this.engine) {
            this.jumping = true;
            this.engine.jump(to, this.video.currentTime);
        }
        if (!this.watch.shown) {
            this.showOsd(false);
        }
    }

    private setMarker(share: number): void {
        this.osd.setMarker(share);
        this.watch.setMarker(share);
        // The frame where a pending jump lands, over the bar that shows; the info bar's title and description hidden
        // meanwhile (the box stands where they are)
        var on = this.watch.shown ? this.watch.seek : this.osdSeek;
        (on === this.osdSeek ? this.watch.seek : this.osdSeek).hide();
        if (share >= 0) {
            on.show(this.target, lengthOf(this.video));
        } else {
            on.hide();
        }
        toggleClass(this.el, 'by-player--seeking', share >= 0 && on === this.osdSeek && on.ready);
    }

    /** Open the watch page over the video (requesting its details if needed) */
    private openWatch(): void {
        this.osd.hide();
        // The watch page shows its own under the title
        this.showPaid(false);
        this.askInfo();
        this.watch.show();
    }

    /** Previous (remote or phone): restart this video if it has played a while, else the previous one in the queue,
     * else the one played before. zap (channel down): always the previous video, if any. */
    previous(zap?: boolean): void {
        var late = !zap && this.video.currentTime > RESTART_AFTER_S;
        // Back through the queue only while the queue's current video plays
        var q = this.queue;
        var queued = late || !q || !this.want || q.ids[q.at] !== this.want.id ? null : q.previous();
        var was = queued || late ? null : this.before.pop();
        if (queued) {
            this.switchTo(queued, false);
        } else if (was) {
            this.start(was);
        } else if (!zap) {
            this.restart();
        }
    }

    /** Restart this video (SponsorBlock segments are skipped again) */
    private restart(): void {
        this.skipped = {};
        if (this.engine) {
            this.engine.seek(0);
        }
    }

    /** Next (remote or phone): the next in the queue, else YouTube's next video */
    next(): void {
        var queued = this.queue && this.queue.next();
        var video = queued || this.watch.upcoming();
        if (video) {
            this.switchTo(video, !queued);
        }
    }

    /** At the end: replay (repeat), the next in the queue, the next video after "Up next" (autoplay), else close */
    private ended(): void {
        var next = this.watch.upcoming();
        var queued = this.loop ? null : this.queue && this.queue.next();
        if (this.loop && this.format) {
            // Repeat: seek to the start in place (the buffer refills from there); SABR restarts
            this.skipped = {};
            if (this.engine instanceof DashEngine) {
                this.engine.seek(this.pastSkipped(0));
                playVideo(this.video);
            } else {
                this.playFormat(this.format, this.pastSkipped(0));
            }
        } else if (queued) {
            this.switchTo(queued, false);
        } else if (prefs().autoplay && next && !prefs().autoplayWait) {
            // Autoplay without a wait (Settings): no "Up next"
            this.switchTo(next, true);
        } else if (prefs().autoplay && next) {
            this.watch.hide();
            this.osd.hide();
            this.upNext.show(next, prefs().autoplayWait);
            this.prime(next);
        } else {
            this.stop();
        }
    }

    /** Play another video in place of this one, from YouTube's resume point. remember: Previous returns here with its
     * details kept (not for queue moves, which Previous walks itself). Hides the watch page. */
    private switchTo(video: Video, remember: boolean): void {
        var was = this.want;
        if (was && remember) {
            this.before.push({ id: was.id, title: (this.streams && this.streams.title) || was.title, channel: was.channel, t: 0, info: this.watch.details });
            this.before = this.before.slice(-BEFORE_MAX);
        }
        this.watch.hide();
        this.start({ id: video.id, title: video.title, channel: video.channel, t: video.start || 0 });
    }

    /** Start want from want.t: release the previous video, fetch the streams, then play */
    private start(want: Want): void {
        // Take over a playing preview of it, or Up next's or a closed video loaded paused
        var peek = this.peeking(want.id) ? this.peek : null;
        var primed = this.primed && this.primed.id === want.id ? this.primed : null;
        var taken = peek || primed;
        note('start', want.id + (peek ? ' (its preview taken over)' : primed ? ' (its ' + primed.kind + ' video taken)' : '') +
            (this.peek && !peek ? '; preview of ' + this.peek.id + ' on' : '') + (this.primed && !primed ? '; ' + this.primed.kind + ' ' + this.primed.id + ' kept' : ''));
        if (peek) {
            this.peek = null;
            this.unpeek();
        } else {
            this.peekStop();
        }
        if (primed) {
            this.primed = null;
        }
        this.reset(!!taken);
        this.aheadTold = false;
        this.want = want;
        this.away = null;
        this.left = null;
        this.held = false;
        this.renewed = false;
        this.inPlaceTried = false;
        this.switched = false;
        this.loop = !!want.loop;
        this.upNext.hide();
        (window as any).__bolli.steps = {};
        var self = this;
        segments(want.id, prefs().skip).then(function (list) {
            if (self.want === want) {
                self.segments = list;
                self.drawParts();
                // Arrived during the start: skip a segment it starts in right away, before any of it is decoded
                var t = self.position();
                if (!self.moving && !taken && self.engine) {
                    var past = self.pastSkipped(t);
                    if (past !== t) {
                        want.t = past;
                        self.engine.seek(past);
                    }
                }
            }
        });
        this.osd.setHead('', want.channel);
        this.osd.setTitle(want.title);
        this.osd.setDescription('');
        this.osd.setQuality(0, 0);
        this.osd.setLine(KEYS_LINE);
        this.osd.setTime('', 0);
        this.osd.setMessage('');
        this.watch.setVideo(want.id, want.title, want.channel);
        // A returning video keeps its details (else they are requested once the picture moves)
        if (want.info) {
            this.infoAsked = true;
            this.watch.setInfo(want.info);
            this.drawParts();
        }
        // Hide the previous video's loading sign (its channel picture is not this one's)
        this.loader.hide();
        this.fillAt = FILLS.start;
        this.loaderDone = !prefs().startSign || !!taken;
        if (!this.loaderDone) {
            var avatar = want.info && want.info.avatar || knownAvatar(want.channel);
            if (avatar) {
                this.loader.show(avatar, FILLS.start);
            } else {
                this.channelLoader(want);
            }
        }
        this.view(true);
        this.showOsd(false);
        if (taken) {
            this.adopt(taken);
            if (primed && !this.held) {
                playVideo(this.video);
            }
        } else {
            // Hidden while the streams load, so the previous video's last frame does not show
            this.video.style.display = 'none';
            this.load();
        }
        this.onChange();
    }

    /** Load Up next's video paused during the countdown (the decoder is free once the video ended), as a start would:
     * past a skip segment at its start */
    private prime(video: Video): void {
        var self = this;
        var gen = this.gen;
        Promise.all<any>([playableStreams(video.id, prefs().sabr), segments(video.id, prefs().skip)]).then(function (got) {
            var s = got[0] as Streams;
            var f = startFormats(s);
            if (gen !== self.gen || !f || !self.upNext.shown || self.primed) {
                return;
            }
            // Release the ended video and show its thumbnail (the next video stays hidden until it plays). Keep its
            // position: currentTime becomes the next video's, but the background and a phone need this one's
            if (self.want) {
                self.want.t = self.video.currentTime;
                self.showPoster(self.want.id);
            }
            self.video.style.display = 'none';
            self.subtitleView.show(null);
            self.moving = false;
            if (self.engine) {
                self.engine.stop();
                self.engine = null;
            }
            var failed = function (why: string): void {
                if (self.primed && self.primed.engine === engine) {
                    self.dropPrimed();
                } else if (engine === self.engine) {
                    self.failed(why);
                }
            };
            var engine: Engine = s.sabr ? new SabrEngine(self.video, s.sabr, failed) : new DashEngine(self.video, failed);
            self.primed = { id: video.id, streams: s, video: f.video, target: f.video, audio: s.audios[0], engine: engine, kind: 'next' };
            engine.load(f.video, f.audio, pastParts(got[1], video.start || 0));
        }, function () { return undefined; });
    }

    /** Show the video's thumbnail full screen until a video plays or the player closes (not its last frame: the TV's
     * video plane cannot be copied, a canvas gets black) */
    private showPoster(id: string): void {
        var poster = this.poster;
        var fallback = thumbnailFallback(id);
        poster.onerror = function () {
            if (fallback && poster.getAttribute('src') !== fallback) {
                poster.src = fallback;
            }
        };
        poster.src = thumbnail(id);
        setShown(poster, true);
    }

    /** Release the primed video (Cancel, another start, close) */
    private dropPrimed(): void {
        var primed = this.primed;
        if (primed) {
            note('dropped', primed.kind + ' ' + primed.id);
            this.primed = null;
            primed.engine.stop();
        }
    }

    /** Take over a playing video: its streams, format, audio and engine become the player's, then it switches in place
     * to the target format (same codec) */
    private adopt(taken: Taken): void {
        var want = this.want as Want;
        var s = taken.streams;
        this.gen++;
        this.askedAt = Date.now();
        this.moving = false;
        clearTimeout(this.startTimer);
        this.step('streams');
        this.streams = s;
        this.audioTrack = taken.audio;
        this.engine = taken.engine;
        this.format = taken.video;
        this.showDetails(s, want);
        if (taken.target.itag !== taken.video.itag && taken.engine instanceof DashEngine) {
            taken.engine.switchVideo(taken.target);
            this.format = taken.target;
        }
        this.osd.setQuality(this.format.height, this.format.fps);
        dropAhead();
        var c = captionFor(s, want);
        if (c) {
            this.setCaption(c);
        }
    }

    /** Show the title, channel and description from the streams */
    private showDetails(s: Streams, want: Want): void {
        this.osdSeek.set(s.storyboard);
        this.watch.seek.set(s.storyboard);
        this.watch.setPaid(s.paid ? s.paid.text : '');
        this.osd.setHead('', s.channel || want.channel);
        this.osd.setTitle(s.title || want.title);
        this.osd.setDescription(s.description);
        this.watch.setTitle(s.title || want.title);
        this.watch.setDescription(s.description);
    }

    /** Fetch want's streams (or use asked: the other method's, after the engine failed for why), then play from
     * want.t */
    private load(asked?: Promise<Streams>, why?: string): void {
        var want = this.want as Want;
        var gen = ++this.gen;
        this.askedAt = Date.now();
        this.moving = false;
        var self = this;
        this.giveUpLater();
        (asked || playableStreams(want.id, prefs().sabr)).then(function (s) {
            if (gen !== self.gen) {
                return;
            }
            self.step('streams');
            // Keep the chosen format and track (renewed streams, or back from the background), else the Settings
            // quality and the original audio
            var itag = self.format ? self.format.itag : want.itag;
            var audioId = self.audioTrack ? self.audioTrack.id : want.audioId;
            var fresh = startFormats(s);
            var video = s.videos.filter(function (f) { return f.itag === itag; })[0] || fresh && fresh.video;
            if (!video || !s.audios.length) {
                self.fallback('no stream for this TV');
                return;
            }
            self.streams = s;
            self.audioTrack = s.audios.filter(function (t) { return t.id === audioId; })[0] || s.audios[0];
            self.showDetails(s, want);
            self.playFormat(video, self.pastSkipped(want.t));
            var c = captionFor(s, want);
            if (!self.caption && c) {
                self.setCaption(c);
            }
        }, function (e: NoStreams) {
            if (gen !== self.gen) {
                return;
            }
            // No answer (network down): YouTube's player could not play it either
            if (noAnswer(e)) {
                self.offline();
                return;
            }
            // Removed or not live yet: YouTube's player could not play it either (after a switch it did play)
            if (!why && (e.status === 'ERROR' || e.status === 'LIVE_STREAM_OFFLINE')) {
                self.stop();
                toast('This video cannot be played' + (e.reason ? ': ' + e.reason : '.'), undefined, PROBLEM);
            } else {
                self.fallback((why ? why + '; then ' : '') + (e.reason || e.status));
            }
        });
    }

    /** Hand over to YouTube's player if not playing START_GIVE_UP_MS after the start (if paused, after play) */
    private giveUpLater(): void {
        var self = this;
        var gen = this.gen;
        clearTimeout(this.startTimer);
        this.startTimer = setTimeout(function () {
            // Paused: the picture does not move until play
            if (gen !== self.gen || self.moving || self.held) {
                return;
            }
            // No streams yet: YouTube has not answered (network down), so its player could not play it either
            if (!self.streams) {
                self.offline();
            } else {
                self.fallback('it did not start');
            }
        }, START_GIVE_UP_MS) as unknown as number;
    }

    /** YouTube does not answer (network down): close and say so */
    private offline(): void {
        this.stop();
        toast('No internet connection.', undefined, PROBLEM);
    }

    /** Play the format from t (stops the previous engine; the position is want.t until the picture moves) */
    private playFormat(video: Format, t: number): void {
        var self = this;
        if (this.engine) {
            this.engine.stop();
        }
        if (this.want) {
            this.want.t = t;
        }
        this.moving = false;
        this.format = video;
        var failed = function (why: string): void {
            if (engine === self.engine) {
                self.failed(why);
            }
        };
        // Via SABR (the account's streams), else each format from its URL; displayed once it plays
        var sabr = this.streams && this.streams.sabr;
        this.video.style.display = 'none';
        var engine: Engine = this.engine = sabr ? new SabrEngine(this.video, sabr, failed) : new DashEngine(this.video, failed);
        engine.load(video, this.audioFormat() as Format, t);
        // A new start: fall back to YouTube's player if it does not play
        this.giveUpLater();
        // Drop data preloaded for another video
        dropAhead();
        this.osd.setQuality(video.height, video.fps);
        if (!this.held) {
            playVideo(this.video);
        }
    }

    /** The engine failed: renew expired URLs (once), else try the other method (SABR or guest, once) from the same
     * position, else hand over to YouTube's player */
    private failed(why: string): void {
        var want = this.want;
        var s = this.streams;
        var renew = why === 'expired' && !this.renewed;
        // The other track expired too while new URLs are on the way
        if (why === 'expired' && this.renewing) {
            return;
        }
        // Expired (e.g. paused for hours): the same formats from new URLs, in place, keeping the buffer
        if (renew && !this.inPlaceTried && want && s && !s.sabr && this.engine && this.engine.renew) {
            this.inPlaceTried = true;
            this.renewInPlace(want);
            return;
        }
        // The other method: once, and not if it already failed for this video
        if (!want || !s || !renew && (this.switched || s.only)) {
            this.fallback(why);
            return;
        }
        want.t = this.position();
        // Stop the old engine so its failures and buffer do not affect the new start; no picks meanwhile
        var old = this.engine;
        this.engine = null;
        this.streams = null;
        if (old) {
            // A failed decoder leaves its pipeline broken: the next start opens a fresh one
            old.stop();
        }
        if (renew) {
            // Renew via the method that played
            this.renewed = true;
            forgetStreams(want.id);
            this.load(s.sabr ? sabrStreams(want.id) : streams(want.id));
        } else {
            this.switched = true;
            this.load(s.sabr ? streams(want.id) : sabrStreams(want.id), why);
        }
    }

    /** New URLs for the formats playing (both tracks may fail, so requested once). If the formats differ or are
     * missing, restart from the current position (failed again, past the in-place try). */
    private renewInPlace(want: Want): void {
        if (this.renewing) {
            return;
        }
        this.renewing = true;
        var self = this;
        var engine = this.engine as Engine;
        var itag = this.format ? this.format.itag : -1;
        var lmt = this.format ? this.format.lmt : '';
        var trackId = this.audioTrack ? this.audioTrack.id : null;
        var heard = this.audioFormat();
        var restart = function (): void {
            self.renewing = false;
            if (self.engine === engine) {
                self.failed('expired');
            }
        };
        forgetStreams(want.id);
        streams(want.id).then(function (fresh) {
            if (self.engine !== engine || self.want !== want) {
                self.renewing = false;
                return;
            }
            var video = fresh.videos.filter(function (f) { return f.itag === itag && f.lmt === lmt; })[0];
            var dub = fresh.audios.filter(function (t) { return t.id === trackId; })[0];
            var audio = dub ? audioOf(dub) : null;
            if (!video || !audio || !heard || audio.itag !== heard.itag || !(engine.renew as (v: Format, a: Format) => boolean)(video, audio)) {
                restart();
                return;
            }
            self.renewing = false;
            self.renewed = true;
            self.streams = fresh;
            self.format = video;
            self.audioTrack = dub;
        }, restart);
    }

    /** Hand over to YouTube's player from the current position */
    private fallback(why: string): void {
        var want = this.close();
        // Free the TV's decoder for YouTube's player
        releasePipeline(this.video);
        if (want) {
            noteFallback(want.id, want.title, why);
            toast('Bolli\'s player cannot play this (' + why + '): YouTube\'s player takes over.', undefined, PROBLEM);
            this.onFallback(want.id, want.t);
        }
    }

    /** Release the video: stop the engine (its pipeline kept for the next), clear data and timers. Returns the video
     * it played (with position and details), or null. */
    private reset(keep?: boolean): Want | null {
        this.showPaid(false);
        var was = this.want;
        // Drop the primed video and the poster over it, unless it is being taken over
        if (!keep) {
            this.dropPrimed();
            setShown(this.poster, false);
        }
        if (was) {
            was.info = this.watch.details;
            was.t = this.position();
            was.itag = this.format ? this.format.itag : was.itag;
            was.audioId = this.audioTrack ? this.audioTrack.id : was.audioId;
            was.caption = this.caption ? this.caption.name : '';
            was.loop = this.loop;
        }
        if (this.report) {
            // The report's last time, as YouTube stores it (the element may hold Up next's video by now)
            if (was && this.watchLength > 0) {
                this.onWatched(was.id, Math.min(1, this.report.time / this.watchLength), this.report.time);
            }
            this.report.stop(this.video.currentTime);
            this.report = null;
            this.watchLength = 0;
        }
        this.want = null;
        this.gen++;
        this.streams = null;
        this.format = null;
        this.audioTrack = null;
        this.infoAsked = false;
        this.segments = [];
        this.osdSeek.set(null);
        this.watch.seek.set(null);
        this.skipped = {};
        this.setCaption(null);
        clearTimeout(this.jumpTimer);
        clearTimeout(this.startTimer);
        this.target = -1;
        this.jumping = false;
        this.setMarker(-1);
        if (this.engine) {
            this.engine.stop();
            this.engine = null;
        }
        return was;
    }

    /** Release and hide (Back, the end, fallback, the background); returns the video it played, or null */
    private close(keep?: boolean): Want | null {
        var was = this.reset(keep);
        this.loader.hide();
        this.upNext.hide();
        this.watch.clear();
        this.osd.hide();
        this.view(false);
        if (was) {
            this.onChange();
        }
        return was;
    }

    private view(shown: boolean): void {
        if (shown !== this.shown) {
            this.shown = shown;
            setShown(this.el, shown);
            this.onShown(shown);
        }
    }

    /** The current position; before the picture moves, the start position (so a switch keeps it) */
    private position(): number {
        return this.moving || !this.want ? this.video.currentTime : this.want.t;
    }

    private showOsd(withText: boolean): void {
        this.tick();
        this.osd.show(withText);
        // A jump's frames ready before it starts
        this.osdSeek.prefetch(this.video.currentTime);
        toggleClass(this.subtitleBox, 'vod-subtitles--up', true);
    }

    // ---- the watch page

    /** Request the watch page details once */
    private askInfo(): void {
        var want = this.want;
        if (!want || this.infoAsked) {
            return;
        }
        this.infoAsked = true;
        var self = this;
        watchInfo(want.id).then(function (info) {
            if (self.want === want) {
                self.watch.setInfo(info);
                // Chapters on the bar
                self.drawParts();
            }
        }, function () {
            if (self.want === want) {
                // Requested again the next time the page opens
                self.infoAsked = false;
                self.watch.setInfo(null);
            }
        });
    }

    /** The player's settings, as in YouTube's player: lists open on top (Back returns), switches toggle in place */
    private settingsPanel(): void {
        var self = this;
        var panel = this.watch.panel;
        panel.open('Settings', function () {
            var s = self.streams;
            var track = self.audioTrack;
            var lines: PanelLine[] = [];
            var opens = function (label: string, value: string, list: () => PanelLine[]): void {
                lines.push({ label: label, under: value, stay: true, action: function () { panel.push(label, list); } });
            };
            var flips = function (label: string, on: boolean, flip: () => void): void {
                lines.push({ label: label, under: on ? 'On' : 'Off', stay: true, action: flip });
            };
            opens('Quality', self.format ? qualityName(self.format) : '', function () { return self.qualityLines(); });
            opens('Subtitles', self.caption ? self.caption.name : 'Off', function () { return self.subtitleLines(); });
            if (s && s.audios.length > 1) {
                opens('Audio track', track ? track.name : '', function () { return self.audioLines(); });
            }
            if (track && track.stable) {
                flips('Stable volume', prefs().stableVolume, function () {
                    setPref('stableVolume', !prefs().stableVolume);
                    self.pickAudio(track as AudioTrack);
                });
            }
            flips('Repeat', self.loop, function () { self.loop = !self.loop; });
            flips('Autoplay', prefs().autoplay, function () { setPref('autoplay', !prefs().autoplay); });
            flips('Stats for nerds', self.stats.shown, function () { self.stats.show(!self.stats.shown); });
            return lines;
        }, 0);
    }

    /** The subtitle tracks, Off first; the chosen language turns on automatically in the next videos */
    private subtitleLines(): PanelLine[] {
        var self = this;
        var all = this.streams ? captionList(this.streams) : [];
        // Style first (a video can have twenty languages)
        var style = CAPTION_STYLES.filter(function (one) { return one.value === prefs().captionStyle; })[0];
        var lines: PanelLine[] = [{ label: 'Style', under: style ? style.name : '', stay: true, action: function () {
            self.watch.panel.push('Subtitle style', function () { return self.styleLines(); });
        } }, { label: 'Off', chosen: !this.caption, action: function () {
            self.setCaption(null);
            setPref('captions', '');
        } }];
        all.forEach(function (c) {
            lines.push({ label: c.name, chosen: self.caption === c, action: function () {
                self.setCaption(c);
                setPref('captions', captionCode(c));
            } });
        });
        if (!all.length) {
            lines.push({ label: 'This video has none', plain: true });
        }
        return lines;
    }

    /** Subtitle style (shared with Settings): redraws the current subtitles in the chosen style */
    private styleLines(): PanelLine[] {
        var self = this;
        return CAPTION_STYLES.map(function (one) {
            return { label: one.name, under: one.note, chosen: prefs().captionStyle === one.value, action: function () {
                var changed = prefs().captionStyle !== one.value;
                setPref('captionStyle', one.value);
                // Reload only when the style affects them (auto-generated subtitles)
                if (changed && self.caption && self.track && self.track.styled) {
                    self.setCaption(self.caption);
                }
            } };
        });
    }

    /** One line per height and frame rate (the first format of each) */
    private qualityLines(): PanelLine[] {
        var self = this;
        var lines: PanelLine[] = [];
        var seen: { [name: string]: boolean } = {};
        (this.streams ? this.streams.videos : []).forEach(function (f) {
            var name = qualityName(f);
            if (!seen[name]) {
                seen[name] = true;
                lines.push({ label: name, chosen: !!self.format && qualityName(self.format) === name, action: function () { self.pickQuality(name); } });
            }
        });
        return lines.length ? lines : [{ label: 'Not known yet', plain: true }];
    }

    /** Switch quality: in the playing codec, switch in place (no stop; visible QUALITY_SWITCH_S later), else (another
     * codec, SABR) restart at the current position in the new format */
    private pickQuality(name: string): void {
        var playing = this.format;
        var list = this.streams ? this.streams.videos.filter(function (f) { return qualityName(f) === name; }) : [];
        var same = playing ? list.filter(function (f) { return kindOf(f.mime) === kindOf(playing!.mime); })[0] : null;
        var f = same || list[0];
        if (!f || f === playing) {
            return;
        }
        if (same && this.moving && this.engine instanceof DashEngine) {
            this.engine.switchVideo(f, QUALITY_SWITCH_S);
            this.format = f;
            this.osd.setQuality(f.height, f.fps);
        } else {
            this.playFormat(f, this.position());
        }
    }

    /** The original audio and the dubs */
    private audioLines(): PanelLine[] {
        var self = this;
        return (this.streams ? this.streams.audios : []).map(function (t) {
            return { label: t.name, chosen: t === self.audioTrack, action: function () {
                if (t !== self.audioTrack) {
                    self.pickAudio(t);
                }
            } };
        });
    }

    /** Switch the audio track (or stable volume): in place if the MIME type matches (no stop; audible AUDIO_SWITCH_S
     * later), else restart at the current position */
    private pickAudio(t: AudioTrack): void {
        var was = this.audioFormat();
        this.audioTrack = t;
        var f = audioOf(t);
        if (was && f.mime === was.mime && this.moving && this.engine instanceof DashEngine) {
            this.engine.switchAudio(f, AUDIO_SWITCH_S);
        } else {
            this.playFormat(this.format as Format, this.position());
        }
    }

    /** The audio format playing: the track's, the stable-volume version if on and available */
    private audioFormat(): Format | null {
        return this.audioTrack ? audioOf(this.audioTrack) : null;
    }

    /** Start position for t: past a skip segment containing t (e.g. an intro at 0), if the segments are known by then
     * (preloaded with the streams) */
    private pastSkipped(t: number): number {
        var at = segmentAt(this.segments, t, this.skipped);
        if (at < 0) {
            return t;
        }
        this.skipped[at] = true;
        toast(skippedText(this.segments[at]), undefined, skipEdge(this.segments[at].category));
        return this.segments[at].end;
    }

    /** Draw SponsorBlock segments and chapters on both bars once the duration is known. The length is the format's:
     * a kept pipeline reports the previous video's until the new one sets its own, which drew the marks out of place */
    private drawParts(): void {
        var d = this.format ? this.format.duration || lengthOf(this.video) : 0;
        var info = this.watch.details;
        this.osdMarks.draw(this.segments, info ? info.chapters : [], d);
        this.watch.setMarks(this.segments, d);
    }

    /** Show YouTube's paid promotion notice at the start for as long as YouTube's player does (hidden by the watch
     * page, a jump or another video) */
    private showPaid(show: boolean): void {
        var paid = show && this.streams ? this.streams.paid : undefined;
        clearTimeout(this.paidTimer);
        setPaid(this.paidChip, paid ? paid.text : '');
        if (paid) {
            var chip = this.paidChip;
            this.paidTimer = setTimeout(function () { setShown(chip, false); }, paid.ms) as unknown as number;
        }
    }

    /** Set the subtitles (null: none); fetched once the picture moves, then drawn during playback */
    private setCaption(c: Caption | null): void {
        this.caption = c;
        if (this.want) {
            this.want.caption = c ? c.name : '';
        }
        if (this.track && this.track.stop) {
            this.track.stop();
        }
        this.track = null;
        this.captionAsked = false;
        this.subtitleView.show(null);
        this.watch.setSubtitles(!!c);
        this.loadCaption();
    }

    private loadCaption(): void {
        var c = this.caption;
        if (!c || this.captionAsked || !this.moving) {
            return;
        }
        if (c.kind === 'translated' && translationsRefused()) {
            this.untranslated(c);
            return;
        }
        this.captionAsked = true;
        var self = this;
        loadCaptions(c.url, function () { return self.caption === c; }).then(function (track) {
            if (track && self.caption === c) {
                self.track = track;
            }
        }, function () {
            if (self.caption !== c) {
                return;
            }
            if (c!.kind === 'translated' && translationsRefused()) {
                self.untranslated(c!);
                return;
            }
            toast('The subtitles did not load.', undefined, PROBLEM);
            self.setCaption(null);
        });
    }

    /** While YouTube refuses translations, show the source of translation c instead, with a notice (the chosen
     * language stays, so the translation returns later) */
    private untranslated(c: Caption): void {
        var url = c.url.replace(/&tlang=[^&]*/, '');
        var from = (this.streams ? captionList(this.streams) : []).filter(function (one) { return one.url === url; })[0] || null;
        toast('YouTube is not translating subtitles right now.' + (from ? ' ' + from.name + ' shown.' : ''), undefined, PROBLEM);
        this.setCaption(from);
    }

    // ---- playback

    /** Fill the loading sign with the frames the TV decodes before showing the first picture (WARM_S worth), full
     * FULL_S before they are all in (at the rate so far); it hides when the picture plays */
    private watchWarmUp(): void {
        var self = this;
        var v = this.video as HTMLVideoElement & { webkitDecodedFrameCount?: number };
        var gen = this.gen;
        var first: { at: number; n: number } | null = null;
        // The count accumulates across a reused pipeline's videos: count from here
        var base = v.webkitDecodedFrameCount || 0;
        clearInterval(this.warmTimer);
        this.warmTimer = setInterval(function () {
            var f = self.format;
            if (gen !== self.gen || self.loaderDone || !f) {
                clearInterval(self.warmTimer);
                return;
            }
            var n = (v.webkitDecodedFrameCount || 0) - base;
            var now = Date.now();
            if (!first) {
                first = n ? { at: now, n: n } : null;
                return;
            }
            var rate = (n - first.n) / (now - first.at) * 1000;
            var need = WARM_S * (f.fps || 30);
            var fullAt = need - FULL_S * rate;
            if (rate <= 0) {
                return;
            }
            self.fillAt = Math.min(1, FILLS.loadedmetadata + (1 - FILLS.loadedmetadata) * n / fullAt);
            self.loader.step(self.fillAt);
            if (n >= fullAt) {
                clearInterval(self.warmTimer);
            }
        }, 100) as unknown as number;
    }

    /** Loading sign for an unknown channel: shown once its picture arrives from the video's details, filled as far as
     * the start has got (not shown if the start finishes first) */
    private channelLoader(want: Want): void {
        var self = this;
        channelPicture(want.id).then(function (image) {
            if (self.want === want && !self.loaderDone && image) {
                self.loader.show(image, self.fillAt);
            }
        }, function () { return undefined; });
    }

    /** Record a start step's time since OK (window.__bolli.steps, like YouTube's player's); returns the ms */
    private step(type: string): number {
        if (type === 'playing') {
            clearInterval(this.warmTimer);
            this.loaderDone = true;
            this.loader.hide();
        } else if (FILLS[type] && this.want) {
            this.fillAt = Math.max(this.fillAt, FILLS[type]);
            this.loader.step(FILLS[type]);
            if (type === 'loadedmetadata') {
                this.watchWarmUp();
            }
        }
        var steps = (window as any).__bolli.steps;
        if (this.want && steps && !steps[type]) {
            steps[type] = Date.now() - this.askedAt;
            if (type === 'playing' || type === 'moving') {
                note(type, this.want.id + ' at ' + this.video.currentTime.toFixed(2) + ', buffered ' + ranges(this.video.buffered));
            }
        }
        return steps ? steps[type] : 0;
    }

    /** Per time update: the bar, subtitles, report, stats, the start's last step (which starts subtitles and the
     * report) and SponsorBlock skips */
    private tick(): void {
        var v = this.video;
        var want = this.want;
        // Up next's video is loaded in its place: the time is not this video's
        if (!want || this.primed && this.primed.kind === 'next') {
            return;
        }
        var self = this;
        // Playing with data and not seeking (not a start's seek before the picture arrives),
        // past where a reused pipeline waits (OFF_START_S)
        if (!this.moving && v.currentTime > OFF_START_S && !v.paused && !v.seeking && v.readyState >= 3) {
            this.moving = true;
            // Cancel the give-up timer, else a video ending soon after (with Up next's loaded in its place) would count
            // as not started and fall back to YouTube's player
            clearTimeout(this.startTimer);
            noteZap(want.id, this.step('moving'));
            if (!want.paidShown) {
                want.paidShown = true;
                this.showPaid(!this.watch.shown);
            }
            // Watch page details, now that the start is done
            this.askInfo();
            this.loadCaption();
            // Playing now (no longer loading)
            this.onChange();
            // One report per playback (renewed URLs restart the picture, not the playback)
            if (prefs().history && !this.report) {
                this.report = new WatchReport(want.id, v.currentTime, function () {
                    var audio = self.audioFormat();
                    return { video: self.format ? self.format.itag : 0, audio: audio ? audio.itag : 0 };
                });
            }
        } else if (this.report && !v.paused) {
            this.report.at(v.currentTime);
        }
        // Preload the next video near the end (the queue's next, else YouTube's with Autoplay on; none with repeat)
        var length = lengthOf(v);
        if (this.report && length > 0) {
            this.watchLength = length;
        }
        if (this.moving && !this.aheadTold && length > 0 && length - v.currentTime < NEXT_AHEAD_S) {
            this.aheadTold = true;
            var coming = this.loop ? null : this.queue && this.queue.peek() || (prefs().autoplay ? this.watch.upcoming() : null);
            if (coming) {
                this.onAhead(coming, true);
            }
        }
        if (this.osd.shown) {
            // The time and the name where a pending jump lands, else where it plays
            var at = this.target >= 0 ? this.target : v.currentTime;
            var info = this.watch.details;
            this.osd.setTime(dots([clock(at) + (length ? ' / ' + clock(length) : ''), nameAt(this.segments, info ? info.chapters : [], at)]),
                length ? v.currentTime / length : 0);
        }
        this.subtitleView.show(this.track ? this.track.textAt(v.currentTime) : null);
        this.stats.tick();
        // Only once the picture moves: a start skips segments itself, and before that the time may be stale
        var at = this.moving ? segmentAt(this.segments, v.currentTime, this.skipped) : -1;
        if (at >= 0 && this.engine) {
            this.skipped[at] = true;
            toast(skippedText(this.segments[at]), undefined, skipEdge(this.segments[at].category));
            // A segment to the very end (an outro): end the video now rather than seek to its last frame
            if (length > 0 && this.segments[at].end >= length - END_SKIP_S) {
                v.pause();
                if (this.report) {
                    this.report.at(length);
                }
                this.ended();
            } else {
                this.engine.seek(this.segments[at].end);
            }
        }
    }

    /** To the background: stop the video; back: resume where it was */
    private visibility(): void {
        if (document.hidden) {
            this.peekStop();
            if (this.want) {
                this.away = this.close();
            }
            // Free the TV's decoder for the foreground app
            this.release();
        } else if (this.away) {
            this.start(this.away);
        }
    }
}

/** Position and size el (px), rounded to whole pixels */
function box(el: HTMLElement, x: number, y: number, w: number, h: number): void {
    el.style.left = Math.round(x) + 'px';
    el.style.top = Math.round(y) + 'px';
    el.style.width = Math.round(w) + 'px';
    el.style.height = Math.round(h) + 'px';
}

/** Start position for t: past the skip segment containing it, if any */
export function pastParts(parts: Segment[], t: number): number {
    var at = segmentAt(parts, t, {});
    return at < 0 ? t : parts[at].end;
}

/** Subtitles for want: those chosen for it (a returning video), else the last chosen language if the video has it */
function captionFor(s: Streams, want: Want): Caption | null {
    var all = captionList(s);
    return want.caption !== undefined ? all.filter(function (one) { return one.name === want.caption; })[0] || null :
        captionIn(all, prefs().captions);
}

/** Subtitles in a language: exact match, else the same base language ("pt-PT": "pt"); uploaded first, as ordered by
 * streams.ts ('' or none: null) */
function captionIn(captions: Caption[], language: string): Caption | null {
    return language ? captions.filter(function (c) { return c.language === language; })[0] ||
        captions.filter(function (c) { return base(c.language) === base(language); })[0] || null : null;
}

/** The language that choosing c sets for the next videos: a translation's code as YouTube names it ("zh-Hant",
 * "pt-PT"), else the base language ("en-GB" as "en") */
function captionCode(c: Caption): string {
    return c.kind === 'translated' ? c.language : base(c.language);
}

export interface Playing {
    id: string;
    t: number;
    duration: number;
    loaded: number;
    ended: boolean;
    waiting: boolean;
    paused: boolean;
}

/** Videos played in order (a mix, a phone's list) for Next, Previous and the end; at: the index playing (-1: before
 * the first) */
export class ListQueue {
    at: number;

    /** ids in order, starting at id (if absent: before the first); wrap: back to the first after the last */
    constructor(public ids: string[], id: string, private wrap?: boolean) {
        this.at = ids.indexOf(id);
    }

    next(): Video | null {
        return this.to(this.after());
    }

    /** The next video (null: none), without moving */
    peek(): Video | null {
        var i = this.after();
        return i < this.ids.length ? videoOf(this.ids[i]) : null;
    }

    /** The index after the current one (0 after the last when wrapping) */
    private after(): number {
        return this.wrap && this.at + 1 >= this.ids.length ? 0 : this.at + 1;
    }

    previous(): Video | null {
        return this.to(this.at - 1);
    }

    /** Move to index i and return its video (null: out of range) */
    private to(i: number): Video | null {
        if (i < 0 || i >= this.ids.length) {
            return null;
        }
        this.at = i;
        return videoOf(this.ids[i]);
    }
}

/** The formats a start plays (preloaded ahead): the Settings quality (Auto and Highest: the TV's max, 4K) and the
 * original audio (stable volume if on); null: none playable */
export function startFormats(s: Streams): { video: Format; audio: Format } | null {
    // At equal height and frame rate, the kept pipeline's codec, so it is reused (player/pipeline.ts)
    var video = pickFormat(s.videos, Math.min(prefs().quality || MAX_HEIGHT, MAX_HEIGHT), pictureKind());
    var track = s.audios[0];
    return video && track ? { video: video, audio: audioOf(track) } : null;
}

/** A track's format to play: the stable-volume version if on and available */
function audioOf(track: AudioTrack): Format {
    return prefs().stableVolume && track.stable ? track.stable : track.format;
}

/** "1080p60", "2160p", as YouTube names its qualities */
function qualityName(f: Format): string {
    return f.height + 'p' + (f.fps > 30 ? f.fps : '');
}

/** Record a video handed to YouTube's player, with the reason (for later diagnosis) */
function noteFallback(id: string, title: string, why: string): void {
    var kept = load<{ id: string; title: string; why: string; at: string }[]>(FALLBACKS);
    var list = Array.isArray(kept) ? kept : [];
    list.unshift({ id: id, title: title, why: why, at: new Date().toISOString() });
    save(FALLBACKS, list.slice(0, FALLBACKS_KEPT));
}
