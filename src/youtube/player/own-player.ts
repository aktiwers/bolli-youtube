// The own player (Settings: Player): plays a video full screen in the app's
// own <video> through Media Source (dash.ts), from guest streams
// (api/streams.ts) or, when YouTube requires the account, via SABR
// (sabr-engine.ts). It starts far sooner than YouTube's TV app and answers
// keys at once. Playback is reported to History (api/stats.ts). Down opens
// the watch page (watch-page.ts): quality, subtitles, audio track, repeat,
// autoplay, stats, speed (checked once to really change the pace, else not
// offered on that TV; a live stream plays at 1x). A video that does not play
// tries its other codecs, then the other way
// of getting its streams (as a guest or by SABR), and only then YouTube's
// player (onFallback). A casting phone (cast.ts) drives it through its
// public methods and onChange.

import { h, LAYOUT_HEIGHT, LAYOUT_WIDTH, setPicture, setShown, setText, toggleClass } from '../../core/dom.js';
import { KEY } from '../../core/keys.js';
import { noteZap } from '../../core/perf.js';
import { preferFrameRate } from '../../core/platform.js';
import { load, save } from '../../core/store.js';
import { clock } from '../../core/time.js';
import { PlayerOsd } from '../../player/osd.js';
import { SubtitleView } from '../../player/subtitles.js';
import { PROBLEM, skipEdge, toast } from '../ui/toast.js';
import { knownAvatar } from '../api/avatars.js';
import { liveNow } from '../api/channel.js';
import { dearrowOn, dearrowPicture, dearrowTitle, dearrowWait } from '../api/dearrow.js';
import { dots, Ended, Page, thumbnail, thumbnailFallback, Video } from '../api/feed.js';
import { prefs, setPref } from '../api/prefs.js';
import { Replays, replays } from '../api/replays.js';
import { Segment, segmentAt, segments, skippedText } from '../api/sponsorblock.js';
import { WatchReport } from '../api/stats.js';
import { noAnswer } from '../api/youtube.js';
import { AudioTrack, AUTO_LINES, base, Caption, captionIn, captionList, learnMethod, forgetStreams, Format, kindOf, noneCanPlay, NoStreams, pickFormat, playableStreams, sabrStreams, Storyboard, storyboardFrame, streams, Streams } from '../api/streams.js';
import { channelPicture, watchInfo, WatchInfo } from '../api/watch.js';
import { FillLoader } from '../ui/fill-loader.js';
import { icon, setIcon } from '../ui/icons.js';
import { PanelLine } from '../ui/side-panel.js';
import { startPicture } from '../views/tiles.js';
import { CAPTION_STYLES, Captions, loadCaptions, translationsRefused } from './captions.js';
import { DashEngine, dropAhead, SKIP_CHAIN_S } from './dash.js';
import { bufferedEnd, Engine, lengthOf } from './engine.js';
import { LiveEngine, liveShare, LiveSpan, liveTime } from './live-engine.js';
import { OFF_START_S, pauseVideo, pictureKind, playVideo, releasePipeline, replacesPipeline } from './pipeline.js';
import { note, ranges } from './play-log.js';
import { BarMarks } from './bar-marks.js';
import { ChatView } from './chat-view.js';
import { ChapterRow } from './chapter-row.js';
import { HOLD_REST_MS, noPresses, pressAim } from './jump-keys.js';
import { nextStep, noTries } from './ladder.js';
import { Stalls } from './stalls.js';
import { ListQueue } from './list-queue.js';
import { ReplayGraph } from './replay-graph.js';
import { paintFrame, SeekPreview } from './seek-preview.js';
import { SabrEngine } from './sabr-engine.js';
import { CountedVideo, StatsBox } from './stats-box.js';
import { UpNext } from './up-next.js';
import { paidChip, setPaid, WatchPage } from './watch-page.js';

/** How long a prepared start (startOf) waits for SponsorBlock's segments */
var SEGMENTS_WAIT_MS = 1000;
var JUMP_S = 10;
/** A jump's frame and marker stay until the picture moves there, at most this long (ms) */
var LAND_MAX_MS = 5000;
/** A video loaded ahead (ready) buffers this much until it is taken (s): what the TV decodes before its first picture
 * (~3 s), not the AHEAD a playing video keeps */
var READY_AHEAD_S = 4;
/** The picture over a starting video (its poster, a start's frame, a preview's tile picture) fades out once the time
 * has moved this far past where it began to play (s; its first frame stands still a moment, which would flash between
 * the two), over COVER_FADE_MS */
var COVER_MOVE_S = 0.15;
var COVER_FADE_MS = 300;
/** The seek frames at the playhead are fetched this long after the picture moves (ms: after the start's own
 * downloads), so a first jump shows its frame at once */
var FRAMES_AHEAD_MS = 4000;
/** A video not playing this long after OK goes to YouTube's player */
var START_GIVE_UP_MS = 15000;
/** A quality switch takes effect this far ahead (s), beyond what the TV's decoder already holds (removing buffer
 * under the decoder fails) */
var QUALITY_SWITCH_S = 10;
/** A video the viewer closed (Back, its channel page) is kept this long to resume as it was */
var LEFT_MS = 60000;
/** An audio track switch takes effect this far ahead (s; the audio decoder holds less than the video decoder) */
var AUDIO_SWITCH_S = 2;
/** A skip segment ending this close to the video's end (s) counts as reaching the end */
var END_SKIP_S = 1;
/** The TV's pipeline may stop at a video's very end without ending it (seen where the picture track ends a little
 * before the sound): the time standing this near the end this long ends it here */
var END_STUCK_S = 0.5;
var END_STUCK_MS = 1500;
/** How often a moving video is checked for a picture that stands while it should play (Stalls) */
var STALL_CHECK_MS = 1000;
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
/** The loading sign fills up this fast once the picture plays, then goes (ms: its pace, themes: .by-loader--round) */
var FILL_MS = 200;
function keysLine(chapters: boolean): string {
    return 'OK pause  ·  Left / Right jump 10 s (twice: chapter)  ·  ' + (chapters ? 'Up chapters  ·  ' : '') +
        'Down the description, related videos, subtitles and more';
}
/** How often a preview's fading sound steps down (ms) */
var FADE_STEP_MS = 100;
/** Playback speeds, as YouTube's player offers them (and 3x); a new speed is checked to really play this long after
 * it is set (the TV's Media Source may ignore it), and whether the TV plays other speeds is kept */
var SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3];
var SPEED_CHECK_MS = 1500;
var SPEED_KEY = 'youtube.speed';
/** A speed check not measurable (paused, live, ...) is tried this many times, every SPEED_CHECK_MS */
var SPEED_TRIES = 40;
/** Streams are fetched anew (expired URLs, a playback that keeps stalling) again only this long after the last time
 * (sooner, that is not what helps) */
var RENEW_AGAIN_MS = 10 * 60 * 1000;
/** How long the volume shows after the phone changes it */
var VOLUME_SHOWN_MS = 1500;
/** How long a start waits for DeArrow's title of a video no tile asked it for (ms) */
var DEARROW_START_MS = 5000;
/** The keys line while the chapter row is open */
var KEYS_LINE_ROW = 'Left / Right chapter  ·  OK play from there  ·  Up, Down or Back close';

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
    /** Its tile's own picture (its start picture: startPicture), else its thumbnail */
    picture?: string;
    /** Played in place of an ended live stream (if it has ended too, it is not followed again) */
    standIn?: boolean;
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
    /** A video's picture started moving */
    onStarted: () => void = function () { return undefined; };
    /** A video reported to History stopped (closed or replaced): progress (0-1) and position (s) */
    onWatched: (id: string, progress: number, t: number) => void = function () { return undefined; };
    /** YouTube's player takes over the video, from t (s) */
    onFallback: (id: string, t: number) => void = function () { return undefined; };
    /** Open a page over the app (the channel's) after closing the player */
    onPage: (page: Page) => void = function () { return undefined; };
    /** The comments of video id opened (null: closed), to offer them to a phone (cast.ts) */
    onComments: (id: string | null) => void = function () { return undefined; };
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
    /** A video's thumbnail over the video until it moves: the ended one's while Up next's video loads hidden, a
     * start's (Settings › Start picture), a preview's tile picture (showPoster, peekStart) */
    private poster: HTMLImageElement;
    /** A start's frame where it starts, from the storyboard (Settings › Start picture) */
    private frame: HTMLElement;
    /** The poster or the frame fading out over the video, and the timer that waits for that (uncoverOnMove); the
     * start (gen) a frame's sheet is still wanted for (-1: none), and that sheet */
    private coverOut = false;
    private coverTimer = 0;
    private frameFor = -1;
    private sheet = new Image();
    private osd: PlayerOsd;
    private watchPage: WatchPage | null = null;
    private watchAt: Node;
    private upNext: UpNext;
    /** SponsorBlock segments on the info bar's progress bar */
    private osdMarks: BarMarks;
    /** The seek preview over the info bar (the watch page has its own) */
    private osdSeek: SeekPreview;
    /** The chapters to pick from over the info bar's time line (Up), and whether opening it paused the video (it plays
     * again when the row closes without a pick) */
    private chapterRow: ChapterRow;
    private chapterPaused = false;
    /** YouTube's most replayed graph over the info bar's progress bar, and the video's (null: none) */
    private osdReplays: ReplayGraph;
    private replays: Replays | null = null;
    /** YouTube's "Includes paid promotion" chip, top left for the first seconds (Streams.paid) */
    private paidChip: HTMLElement;
    private paidTimer = 0;
    private stats: StatsBox;
    private loader: FillLoader;
    private subtitleBox: HTMLElement;
    private subtitleView: SubtitleView;
    /** A live stream's chat beside the picture */
    private chat: ChatView;
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
    /** The ended video's length (s), told while Up next's video is loaded in its place; the stuck-end check */
    private endLength = 0;
    private endTimer = 0;
    /** The subtitles shown (null: none) and their cues */
    private caption: Caption | null = null;
    private track: Captions | null = null;
    /** Incremented per start, so late replies for an earlier start are dropped */
    private gen = 0;
    /** This start's ways tried after its engine failed (failed, nextStep) */
    private tries = noTries();
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
    private presses = noPresses();
    /** A jump's seek is pending (OK then plays rather than pauses) */
    private jumping = false;
    /** A jump made whose frame and marker stay up until the picture moves on from landFrom, where its seek put it; where
     * it goes (the next press counts from there); and the timer that lands it anyway */
    private landing = false;
    private jumpedTo = -1;
    private landFrom = 0;
    private landTimer = 0;
    private startTimer = 0;
    /** Checks every STALL_CHECK_MS, once the picture moves, whether it stands while it should play (counted anew after
     * a jump) */
    private stalls = new Stalls();
    private stallTimer = 0;
    /** Tracks the frames decoded before the first picture (loading sign fill) */
    private warmTimer = 0;
    /** Loading sign fill so far, and whether it is finished (a late update does not show it again) */
    private fillAt = 0;
    private loaderDone = false;
    /** Cues were requested for this caption */
    private captionAsked = false;
    /** The playback speed (kept for the next videos while the player is open); whether the TV plays other speeds
     * (null: not known yet) */
    private speed = 1;
    private speedWorks: boolean | null = load<boolean>(SPEED_KEY);
    private speedTimer = 0;
    /** The player's volume (0-1: setVolume), and the preview's fade out (0: none) */
    private volume = 1;
    private fadeTimer = 0;
    /** The volume as the phone set it, shown for a moment as Apple TV shows it: a speaker and a level bar (null: not
     * shown yet) */
    private volumeShown: { el: HTMLElement; icon: HTMLElement; fill: HTMLElement } | null = null;
    private volumeTimer = 0;
    /** A tile preview playing in this player's video (small, at the tile; the app keeps the keys). OK on the tile
     * takes it over as it plays, then switches to the target format. */
    private peek: Taken | null = null;
    /** Called when the preview stops by itself (failed or ended) */
    private peekEnded: () => void = function () { return undefined; };
    /** A ring over the preview's corners to round them like the tile's (the TV's video layer draws square) */
    private ring: HTMLElement;
    /** The time of day over the video, at the top left or right as Settings › Clock in videos says (main.ts sets it
     * each minute) */
    private clock: HTMLElement;
    /** A video loaded paused in the <video>: the one Up next counts down to (Play now just plays it), or the one the
     * viewer closed (comeBack resumes it). Released when the decoder is needed. */
    /** A video loaded paused: Up next's, the closed one kept, or a rested tile's (ahead: from at, as asked) */
    private primed: (Taken & ({ kind: 'next' | 'left' } | { kind: 'ahead'; at: number })) | null = null;
    /** The video whose load ahead is on its way (ready; '' none), and a count that drops a load given up meanwhile */
    private readyId = '';
    private readyGen = 0;
    /** onAhead was called for this video */
    private aheadTold = false;

    constructor(parent: HTMLElement) {
        this.el = h('div', 'by-player');
        this.video = h('video') as HTMLVideoElement;
        this.el.appendChild(this.video);
        this.poster = h('img', 'by-player-poster') as HTMLImageElement;
        setShown(this.poster, false);
        this.el.appendChild(this.poster);
        this.frame = h('div', 'by-player-frame');
        setShown(this.frame, false);
        this.el.appendChild(this.frame);
        this.ring = h('div', 'by-peek-ring');
        this.subtitleBox = h('div', 'vod-subtitles');
        this.el.appendChild(this.subtitleBox);
        this.subtitleView = new SubtitleView(this.subtitleBox);
        this.chat = new ChatView(this.el);
        this.loader = new FillLoader(this.el, true);
        var self = this;
        this.osd = new PlayerOsd(this.el, function () { return self.video.paused || !self.moving; }, function () {
            toggleClass(self.subtitleBox, 'vod-subtitles--up', false);
            self.closeChapters(false);
        });
        // The watch page's place among the layers (built on first use, or ahead: prepare)
        this.watchAt = this.el.appendChild(document.createComment('watch page'));
        this.upNext = new UpNext(this.el, {
            play: function (video: Video) { self.playNext(video); },
            cancel: function () {
                self.onChange();
                self.dropPrimed();
                // The ended video was released for the next one: reload it paused at its start (Play replays it)
                if (!self.engine && self.want && self.format) {
                    self.held = true;
                    // As a repeat: the segments are skipped again, one at the start too
                    self.skipped = {};
                    self.playFormat(self.format, self.pastSkipped(0));
                }
                self.watch.show(true);
            },
            close: function () { self.stop(); }
        });
        var bar = this.el.querySelector('.osd-bar') as HTMLElement;
        this.osdMarks = new BarMarks(bar, bar.querySelector('.osd-marker'));
        this.osdSeek = new SeekPreview(bar);
        this.osdReplays = new ReplayGraph(bar);
        this.chapterRow = new ChapterRow(bar.parentNode as Node);
        this.paidChip = this.el.appendChild(paidChip()) as HTMLElement;
        toggleClass(this.paidChip, 'by-paid--start', true);
        this.clock = this.el.appendChild(h('div', 'by-video-clock')) as HTMLElement;
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
            self.uncoverOnMove();
        });
        this.video.addEventListener('timeupdate', function () { self.tick(); });
        this.video.addEventListener('pause', function () {
            if (self.report) {
                self.report.pause(self.video.currentTime);
            }
            // (paused where a jump's seek put it: its picture is there)
            if (self.landing && !self.jumping && !self.seekPending()) {
                self.land();
            }
        });
        this.video.addEventListener('seeking', function () {
            if (self.report) {
                self.report.seek(self.position());
            }
        });
        this.video.addEventListener('seeked', function () {
            self.jumping = false;
            // (the jump's: not a seek of the engine's own while it is still on its way)
            if (self.landing && !self.seekPending()) {
                self.landFrom = self.video.currentTime;
                // (paused: the frame there shows now)
                if (self.video.paused) {
                    self.land();
                }
            }
        });
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
        ['playing', 'pause'].forEach(function (type) {
            self.video.addEventListener(type, function () { self.holdChat(); });
        });
        document.addEventListener('visibilitychange', function () { self.visibility(); });
    }

    /** The watch page (built on first use: its 14 ms are not spent before the app's first screen) */
    private get watch(): WatchPage {
        return this.watchPage || this.buildWatch();
    }

    /** Builds what waits for first use (called once the app's first screen rests, so a start does not build it) */
    prepare(): void {
        void this.watch;
    }

    private buildWatch(): WatchPage {
        var self = this;
        var made = this.watchPage = new WatchPage(this.el, this.video, {
            toggle: function () { self.toggle(); },
            jump: function (seconds) { self.jump(seconds); },
            previous: function () { self.previous(); },
            next: function () { self.next(); },
            nextVideo: function () { return self.following(true); },
            play: function (video: Video) { self.switchTo(video, true); },
            channel: function (page: Page) {
                self.leave();
                self.onPage(page);
            },
            subtitles: function () { self.watch.panel.open('Subtitles', function () { return self.subtitleLines(); }); },
            settings: function () { self.settingsPanel(); },
            rest: function (video: Video) { self.onAhead(video, false); },
            restPage: function (page: Page) { self.onPageAhead(page); },
            live: function () { return self.liveSpan(); },
            length: function () { return self.length(); },
            comments: function (id: string | null) { self.onComments(id); }
        }, this.watchAt);
        // The subtitles go under the watch page (themes: .by-player--watch)
        made.onShown = function (shown) {
            toggleClass(self.el, 'by-player--watch', shown);
            self.holdChat();
        };
        return made;
    }

    /** A video is active (shown, or its streams are loading) */
    get busy(): boolean {
        return !!this.want;
    }

    /** The clock's time of day ("hh:mm") */
    setClock(text: string): void {
        setText(this.clock, text);
    }

    /** Play a video (t: start position, s; queue: videos to play in order, e.g. a mix or a phone's list; picture: its
     * tile's) */
    play(id: string, title: string, channel: string, t?: number, queue?: ListQueue | null, picture?: string): void {
        this.before = [];
        this.queue = queue || null;
        var want = { id: id, title: title, channel: channel, t: t || 0, picture: picture };
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
    peekStart(id: string, s: Streams, video: Format, target: Format, audio: AudioTrack, from: number, rect: ClientRect, sound: boolean, stopped: () => void,
        square?: boolean, picture?: string): void {
        if (this.want) {
            return;
        }
        this.peekStop();
        // Its video loaded ahead (ready) plays here as it is; another one loaded ahead, or the closed one kept, goes
        var ahead = this.primed && this.primed.kind === 'ahead' && this.primed.id === id ? this.primed : null;
        if (ahead) {
            this.primed = null;
            ahead.engine.hold(0);
        } else {
            this.unready();
            this.letGo();
        }
        var self = this;
        this.peekEnded = stopped;
        var engine: Engine = ahead ? ahead.engine : engineFor(this.video, s, function (why) { self.engineFailed(engine, why); });
        this.peek = ahead ? { id: id, streams: ahead.streams, video: ahead.video, target: ahead.target, audio: ahead.audio, engine: engine } :
            { id: id, streams: s, video: video, target: target, audio: audio, engine: engine };
        // Loaded ahead at the start's quality: on to the preview's in place (OK switches up again)
        if (ahead && ahead.video.itag !== video.itag && kindOf(ahead.video.mime) === kindOf(video.mime) && engine.switchVideo) {
            engine.switchVideo(video);
            this.peek.video = video;
        }
        note('preview', id + (ahead ? ' (loaded ahead)' : ''));
        // Fill the tile like its picture: a video wider or taller than 16:9 is cropped (no black bars) by clipping the
        // player's box to the tile (the TV's video layer ignores the <video> element's own clipping)
        var shape = this.peek.video;
        var scale = shape.width && shape.height ? Math.max(rect.width / shape.width, rect.height / shape.height) : 0;
        var w = scale ? shape.width * scale : rect.width;
        var hh = scale ? shape.height * scale : rect.height;
        box(this.el, rect.left, rect.top, rect.width, rect.height);
        box(this.video, (rect.width - w) / 2, (rect.height - hh) / 2, w, hh);
        box(this.ring, rect.left, rect.top, rect.width, rect.height);
        // Hidden until it plays, then the tile's picture (picture: loaded now, shown with the video) over it until it
        // moves (uncoverOnMove)
        this.video.style.display = 'none';
        this.hidePoster();
        if (picture) {
            setPicture(this.poster, picture);
            toggleClass(this.poster, 'by-player-poster--round', !square);
        }
        this.video.muted = !sound;
        toggleClass(this.el, 'by-player--peek', true);
        toggleClass(this.ring, 'by-peek-ring--on', !square);
        setShown(this.el, true);
        if (!ahead) {
            engine.load(video, audioOf(audio), from, true);
        }
        playVideo(this.video);
    }

    /** Loads video id paused and hidden from t (ask: its streams, asked only if it goes ahead), so its start (OK on its
     * tile) or its preview takes it over at once instead of waiting for the TV's ~1.5-2.5 s start; not while a video
     * or preview plays, nor a live stream, nor where another kind of pipeline would be torn down (~1 s frozen while
     * browsing), nor once still() says its tile has lost the focus. The closed video kept, or another loaded ahead,
     * goes for it */
    ready(id: string, t: number, ask: () => Promise<Streams>, still: () => boolean): void {
        if (this.want || this.peek || this.readyId === id || this.primed && this.primed.id === id) {
            return;
        }
        var gen = ++this.readyGen;
        this.readyId = id;
        var self = this;
        var gone = function (): void {
            if (gen === self.readyGen) {
                self.readyId = '';
            }
        };
        startOf(ask(), id, t).then(function (start) {
            var s = start.streams;
            var f = start.formats;
            if (gen !== self.readyGen || self.want || self.peek || !f || s.live || !still() || replacesPipeline([f.video.mime, f.audio.mime])) {
                gone();
                return;
            }
            gone();
            self.dropPrimed();
            var engine: Engine = engineFor(self.video, s, function (why) { self.engineFailed(engine, why); });
            self.video.style.display = 'none';
            self.primed = { id: id, streams: s, video: f.video, target: f.video, audio: s.audios[0], engine: engine, kind: 'ahead', at: t };
            note('ready', id + ' from ' + start.t.toFixed(1));
            engine.load(f.video, f.audio, start.t);
            engine.hold(READY_AHEAD_S);
        }, gone);
    }

    /** Drops the video loaded ahead, or its load on the way (the focus moved on, the app went away) */
    unready(): void {
        this.readyGen++;
        this.readyId = '';
        if (this.primed && this.primed.kind === 'ahead') {
            this.dropPrimed();
        }
    }

    /** Whether video id is loaded ahead, or on its way (ready) */
    readyFor(id: string): boolean {
        return this.readyId === id || !!this.primed && this.primed.kind === 'ahead' && this.primed.id === id;
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
        this.unready();
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
        this.hidePoster();
        this.video.style.display = '';
        this.video.muted = false;
        // Full sound again (a preview taken over while its sound faded)
        clearInterval(this.fadeTimer);
        this.video.volume = this.volume;
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
            this.hidePoster();
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
        // Ended, Up next's video loaded in its place: this one's end
        if (this.upNext.counting) {
            var end = this.endLength;
            return { id: want.id, t: end, duration: end, loaded: end, ended: true, waiting: false, paused: false };
        }
        var t = this.position();
        // A live stream: within its window
        var w = this.window();
        return {
            id: want.id,
            t: t - w.from,
            duration: w.to - w.from,
            loaded: bufferedEnd(v.buffered, t) - w.from,
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
        if (this.upNext.counting) {
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

    /** Plays from t (s; a live stream: from its window's start) */
    seekTo(t: number): void {
        t = Math.max(0, t) + this.window().from;
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

    /** Volume (0-100) and mute of this player (not the TV's), the level cubed as an audio control's curve (a linear
     * one changes little near the top: each of the phone's steps of 3 is heard alike); shown: the level shows for a
     * moment */
    setVolume(level: number, muted: boolean, shown?: boolean): void {
        var l = Math.max(0, Math.min(100, level)) / 100;
        this.volume = l * l * l;
        this.video.volume = this.volume;
        this.video.muted = muted;
        if (shown) {
            this.showVolume(Math.round(level), muted);
        }
    }

    /** The volume's speaker and level bar, for VOLUME_SHOWN_MS (fading in and out) */
    private showVolume(level: number, muted: boolean): void {
        var shown = this.volumeShown;
        if (!shown) {
            var el = h('div', 'by-volume');
            var track = h('div', 'by-volume-track');
            shown = this.volumeShown = { el: el, icon: icon('volume', 'by-volume-icon'), fill: h('div', 'by-volume-fill') };
            track.appendChild(shown.fill);
            el.appendChild(shown.icon);
            el.appendChild(track);
            this.el.appendChild(el);
        }
        setIcon(shown.icon, muted || !level ? 'volumeoff' : 'volume');
        shown.fill.style.width = (muted ? 0 : level) + '%';
        toggleClass(shown.el, 'by-volume--shown', true);
        clearTimeout(this.volumeTimer);
        var box = shown.el;
        this.volumeTimer = setTimeout(function () { toggleClass(box, 'by-volume--shown', false); }, VOLUME_SHOWN_MS) as unknown as number;
    }

    /** Fades the preview's sound out over ms, reaching silence as it ends (down a curve: steeper at the end, as the
     * ear hears it) */
    peekFade(ms: number): void {
        var self = this;
        var from = Date.now();
        clearInterval(this.fadeTimer);
        this.fadeTimer = setInterval(function () {
            var left = Math.max(0, 1 - (Date.now() - from) / ms);
            self.video.volume = self.volume * left * left;
            if (!left) {
                clearInterval(self.fadeTimer);
            }
        }, FADE_STEP_MS) as unknown as number;
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
        // (a start hides Up next; with none to go to, Up next counts on)
        if (code === KEY.CH_UP || code === KEY.CH_DOWN) {
            if (code === KEY.CH_UP) {
                this.next();
            } else {
                this.previous(true);
            }
            return true;
        }
        if (this.upNext.counting) {
            this.upNext.onKey(code);
            return true;
        }
        if (this.watch.shown) {
            this.watch.onKey(code);
            return true;
        }
        if (this.chapterRow.open) {
            this.chapterKey(code);
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
                // The bar, with the chapters to pick from; Up again closes it (back to the picture alone)
                if (this.osd.asked) {
                    this.osd.hide();
                } else {
                    this.showOsd(true);
                    this.openChapters();
                }
                return true;
            case KEY.DOWN:
                this.openWatch();
                return true;
        }
        // The app behind gets no keys while the player shows
        return true;
    }

    /** The chapter row's keys: Left/Right the chapter before or after, OK plays from the selected one; Up, Down and Back
     * close the row and the bar (the next Down opens the watch page) */
    private chapterKey(code: number): void {
        switch (code) {
            case KEY.LEFT:
            case KEY.RIGHT:
                this.chapterRow.move(code === KEY.LEFT ? -1 : 1);
                this.showChapter();
                break;
            case KEY.OK:
                // A jump there that plays (hiding the info bar closes the row)
                var to = this.chapterRow.selected!.start;
                this.osd.hide();
                this.target = to;
                this.toggle();
                break;
            case KEY.UP:
            case KEY.DOWN:
            case KEY.BACK:
                this.closeChapters(true);
                this.osd.hide();
                break;
        }
    }

    /** The chapter row opened at the chapter playing, the video paused meanwhile (not while starting or jumping) */
    private openChapters(): void {
        if (!this.chapterRow.has || !this.moving || this.target >= 0 || this.landing) {
            return;
        }
        this.chapterPaused = !this.held && !this.video.paused;
        if (this.chapterPaused) {
            this.pause();
        }
        this.chapterRow.openAt(this.video.currentTime);
        this.showKeys();
        this.showChapter();
    }

    /** The selected chapter's start marked on the bar, its time and name on the time line */
    private showChapter(): void {
        var length = this.length();
        this.osd.setMarker(length ? this.chapterRow.selected!.start / length : -1);
        this.tick();
    }

    /** The chapter row closed; resume: play on if opening it paused the video */
    private closeChapters(resume: boolean): void {
        if (!this.chapterRow.open) {
            return;
        }
        this.chapterRow.close();
        this.osd.setMarker(-1);
        this.showKeys();
        if (resume && this.chapterPaused) {
            this.resume();
        }
        this.chapterPaused = false;
        this.tick();
    }

    /** The keys line: the chapter row's while it is open, else the player's (Up names the chapters if there are some) */
    private showKeys(): void {
        this.osd.setLine(this.chapterRow.open ? KEYS_LINE_ROW : keysLine(this.chapterRow.has));
    }

    /** OK: pause or play. During a jump (pending, or its seek) it jumps now and plays rather than pausing. */
    private toggle(): void {
        if (this.target >= 0 || this.landing) {
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

    /** Jump by seconds, added to a pending jump (or as held, or to a chapter: pressAim); it runs to the nearest keyframe
     * at once (the TV decodes ~1.3 s after any jump: waiting for more presses only added to it), a held key's once its
     * repeats stop (the marker shows on the watch page's bar while shown, else on the info bar) */
    private jump(seconds: number): void {
        var w = this.window();
        // Not while starting: in a reused pipeline the time and duration are still the previous video's
        if (!(w.to > w.from) || !this.engine || !this.moving) {
            return;
        }
        var chapters = this.watch.details ? this.watch.details.chapters : null;
        // (from a jump still on its way: where it goes)
        var t = pressAim(this.presses, seconds, Date.now(), this.position(), this.target >= 0 ? this.target : this.landing ? this.jumpedTo : -1,
            w, chapters);
        // At once; a held key's repeats once they stop, and with chapters once a quick second press (to a chapter
        // instead) can no longer come (not a jump there and back)
        this.aim(t, !this.presses.held && !(chapters && chapters.length && !this.presses.chapterRun));
    }

    /** The pending jump set to t (s), run now, else (a held key) once presses stop */
    private aim(t: number, now: boolean): void {
        this.target = t;
        // (The info bar first: the preview over it measures the bar once it shows)
        if (!this.watch.shown) {
            this.showOsd(false);
        }
        var span = this.liveSpan();
        this.setMarker(span ? liveShare(t, span) : t / this.video.duration);
        clearTimeout(this.jumpTimer);
        if (now) {
            this.jumpNow();
            return;
        }
        var self = this;
        this.jumpTimer = setTimeout(function () { self.jumpNow(); }, HOLD_REST_MS) as unknown as number;
    }

    /** Run the pending jump now (if any) */
    private jumpNow(): void {
        var to = this.target;
        if (to < 0) {
            return;
        }
        clearTimeout(this.jumpTimer);
        this.target = -1;
        this.stalls.reset();
        // Its frame and marker stay until the picture moves there (the TV takes ~1.5 s), not the old frame frozen alone
        this.landing = true;
        this.jumpedTo = to;
        clearTimeout(this.landTimer);
        var self = this;
        this.landTimer = setTimeout(function () { self.land(); }, LAND_MAX_MS) as unknown as number;
        this.showPaid(false);
        if (this.engine) {
            this.jumping = true;
            this.engine.jump(to, this.video.currentTime);
        }
        // No seek made (already there, or at the live head): nothing to wait for
        if (!this.video.seeking && !this.seekPending()) {
            this.jumping = false;
            this.land();
        }
        if (!this.watch.shown) {
            this.showOsd(false);
        }
    }

    /** A jump landed (or waited LAND_MAX_MS): its frame and marker go, unless a press aims anew meanwhile */
    private land(): void {
        clearTimeout(this.landTimer);
        this.landing = false;
        if (this.target < 0) {
            this.setMarker(-1);
        }
    }

    /** The engine's seek is still on its way (SABR waits for the media there before it moves the playhead) */
    private seekPending(): boolean {
        var e = this.engine;
        return !!e && !!e.seekTarget && e.seekTarget() >= 0;
    }

    private setMarker(share: number): void {
        this.osd.setMarker(share);
        this.watch.setMarker(share);
        // The frame where a pending jump lands, over the bar that shows; the info bar's channel and title hidden
        // meanwhile (the box stands where they are)
        this.osdSeek.hide();
        this.watch.seek.hide();
        if (share >= 0) {
            // YouTube's "Most replayed" label where it shows it
            var label = this.replays && this.replays.label;
            var named = label && this.target >= label.from && this.target <= label.to ? label.text : '';
            (this.watch.shown ? this.watch.seek : this.osdSeek).show(this.target, this.length(), named);
        }
        toggleClass(this.el, 'by-player--seeking', share >= 0 && !this.watch.shown && this.osdSeek.ready);
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
        var video = this.following(true);
        if (video) {
            this.playNext(video);
        }
    }

    /** What Autoplay plays after this video (null: the queue goes on, repeat, Autoplay off, or none known) */
    get autoplayNext(): Video | null {
        return this.loop || this.queue && this.queue.peek() ? null : this.following(false);
    }

    /** What plays after this video: the queue's next (always: it was asked for), else YouTube's (asked: Next or its
     * button; at the end only with Autoplay on); null: none */
    private following(asked: boolean): Video | null {
        return this.queue && this.queue.peek() || (asked || prefs().autoplay ? this.watch.upcoming() : null);
    }

    /** Up next's video while it counts down (null: none) */
    get upNextVideo(): Video | null {
        return this.upNext.counting;
    }

    /** At the end: replay (repeat), else the queue's next, else YouTube's with Autoplay on (at once, or after "Up
     * next"; none: close) */
    private ended(): void {
        clearTimeout(this.endTimer);
        // Counting down already (an end found by the stuck-end check, then the pipeline's own)
        if (this.upNext.counting) {
            return;
        }
        this.endLength = lengthOf(this.video);
        var next = this.following(false);
        if (this.loop && this.format) {
            // Repeat: seek to the start in place (the buffer refills from there); SABR restarts
            this.skipped = {};
            if (this.engine instanceof DashEngine) {
                this.engine.seek(this.pastSkipped(0));
                playVideo(this.video);
            } else {
                this.playFormat(this.format, this.pastSkipped(0));
            }
        } else if (next && !prefs().autoplayWait) {
            // No wait (Settings): no "Up next"
            this.playNext(next);
        } else if (next) {
            this.watch.hide();
            this.osd.hide();
            this.upNext.show(next, prefs().autoplayWait);
            this.prime(next);
            this.onChange();
        } else {
            this.stop();
        }
    }

    /** Play the next video: the queue's moves the queue on (Previous walks it back), YouTube's is remembered for
     * Previous */
    private playNext(video: Video): void {
        var q = this.queue;
        var queued = q && q.peek();
        if (q && queued && queued.id === video.id) {
            q.next();
            this.switchTo(video, false);
        } else {
            this.switchTo(video, true);
        }
    }

    /** Play another video in place of this one, from YouTube's resume point. remember: Previous returns here with its
     * details kept (not for queue moves, which Previous walks itself); standIn: in place of an ended live stream. Hides
     * the watch page. */
    private switchTo(video: Video, remember: boolean, standIn?: boolean): void {
        var was = this.want;
        if (was && remember) {
            this.before.push({ id: was.id, title: (this.streams && this.streams.title) || was.title, channel: was.channel, t: 0, picture: was.picture, info: this.watch.details });
            this.before = this.before.slice(-BEFORE_MAX);
        }
        this.watch.hide();
        this.start({ id: video.id, title: video.title, channel: video.channel, t: video.start || 0, picture: startPicture(video), standIn: standIn });
    }

    /** Start want from want.t: release the previous video, fetch the streams, then play */
    private start(want: Want): void {
        // Take over a playing preview of it, or Up next's or a closed video loaded paused
        var peek = this.peeking(want.id) ? this.peek : null;
        var primed = this.primed && this.primed.id === want.id ? this.primed : null;
        // A video loaded ahead only where this start wants it: from the same place, in its own formats (else dropped)
        var ahead = primed && primed.kind === 'ahead' ? primed : null;
        if (ahead && (Math.abs(want.t - ahead.at) > 1 || want.itag || want.audioId)) {
            primed = ahead = null;
        }
        var taken = peek || primed;
        // (not all decoded yet: as a start, with its loading sign and its give-up)
        var waiting = !!primed && this.video.readyState < 3;
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
        // (a renewal for the previous video may still be on its way: it is not this start's)
        this.tries = noTries();
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
        this.osd.setTitle(dearrowTitle(want.id, want.title));
        this.osd.setDescription('');
        this.osd.setQuality(0, 0);
        this.closeChapters(false);
        this.chapterRow.set([]);
        this.showKeys();
        this.osd.setTime('', 0);
        this.osd.setMessage('');
        this.watch.setVideo(want.id, want.title, want.channel);
        // A returning video keeps its details; else they are asked for now, beside the streams
        if (want.info) {
            this.infoAsked = true;
            this.watch.setInfo(want.info);
            this.drawParts();
        }
        this.askInfo();
        // DeArrow's title for a video no tile asked it for (started from a phone, or the queue's next)
        if (dearrowOn()) {
            dearrowWait([want], DEARROW_START_MS).then(function () {
                if (self.want === want) {
                    var title = (self.streams && self.streams.title) || want.title;
                    self.osd.setTitle(dearrowTitle(want.id, title));
                    self.watch.setTitle(title);
                }
            });
        }
        // Hide the previous video's loading sign (its channel picture is not this one's)
        this.loader.hide();
        this.fillAt = FILLS.start;
        this.loaderDone = !prefs().startSign || !!taken && !waiting;
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
            // Loaded ahead: hidden until it plays (in ~0.25 s once decoded), its start picture meanwhile; Android's
            // screen at its rate
            if (ahead) {
                if (prefs().startPicture === 'tile') {
                    this.showPoster(want);
                }
                preferFrameRate(displayRate(ahead.video.fps));
                ahead.engine.hold(0);
            }
            this.adopt(taken);
            if (ahead || waiting) {
                // As a start: YouTube's player if it does not play; its frame there (decoded, it plays first); the
                // loading sign paced by the frames
                this.giveUpLater();
                if (ahead && waiting && prefs().startPicture === 'frame') {
                    this.showFrame(ahead.streams.storyboard, ahead.at);
                }
                if (!this.loaderDone && this.video.readyState >= 1) {
                    this.watchWarmUp();
                }
            }
            if (primed && !this.held) {
                playVideo(this.video);
            }
        } else {
            // Hidden while the streams load, so the previous video's last frame does not show; meanwhile its tile's
            // picture (or its frame there once the streams are in: load)
            this.video.style.display = 'none';
            if (prefs().startPicture === 'tile') {
                this.showPoster(want);
            }
            this.load();
        }
        this.onChange();
    }

    /** Load Up next's video paused during the countdown (the decoder is free once the video ended), as a start would:
     * past a skip segment at its start */
    private prime(video: Video): void {
        var self = this;
        var gen = this.gen;
        startOf(playableStreams(video.id, prefs().sabr), video.id, video.start || 0).then(function (start) {
            var s = start.streams;
            var f = start.formats;
            if (gen !== self.gen || !f || !self.upNext.counting || self.primed) {
                return;
            }
            // Release the ended video and show its thumbnail (the next video stays hidden until it plays). Keep its
            // position: currentTime becomes the next video's, but the background and a phone need this one's
            if (self.want) {
                self.want.t = self.video.currentTime;
                self.showPoster(self.want);
            }
            self.video.style.display = 'none';
            self.subtitleView.show(null);
            self.moving = false;
            if (self.engine) {
                self.engine.stop();
                self.engine = null;
            }
            var engine: Engine = engineFor(self.video, s, function (why) { self.engineFailed(engine, why); });
            self.primed = { id: video.id, streams: s, video: f.video, target: f.video, audio: s.audios[0], engine: engine, kind: 'next' };
            engine.load(f.video, f.audio, start.t);
        }, function () { return undefined; });
    }

    /** Show the video's tile picture (in the browser's cache), else its thumbnail, full screen until a video moves or
     * the player closes (not its last frame: the TV's video plane cannot be copied, a canvas gets black). Painted during
     * a start, it makes the TV's first frame ~0.1 s later */
    private showPoster(want: Want): void {
        this.hidePoster();
        setPicture(this.poster, want.picture || dearrowPicture(want.id, thumbnail(want.id)), want.picture ? thumbnail(want.id) : thumbnailFallback(want.id));
        setShown(this.poster, true);
    }

    /** A start's frame where it starts (Settings › Start picture), from the storyboard's sharpest level (blurry: it is
     * small), fitted to the screen as the video will be; shown once its sheet is in, if the start has not played yet */
    private showFrame(sb: Storyboard | null, t: number): void {
        if (!sb) {
            return;
        }
        var f = storyboardFrame(sb, t);
        var gen = this.frameFor = this.gen;
        var self = this;
        // (one sheet at a time: a later start's cancels an earlier one's)
        this.sheet.onload = function () {
            if (gen !== self.frameFor || gen !== self.gen || self.video.style.display !== 'none') {
                return;
            }
            paintFrame(self.frame.style, sb, f, LAYOUT_WIDTH, LAYOUT_HEIGHT, Math.min(LAYOUT_WIDTH / sb.w, LAYOUT_HEIGHT / sb.h), true);
            setShown(self.frame, true);
        };
        this.sheet.src = f.url;
    }

    /** The video shows: the picture over it (a preview's shown now) fades out once its time moves COVER_MOVE_S, counted
     * from the last jump (a skip, a seek), so only playing on moves it; a fade under way goes on */
    private uncoverOnMove(): void {
        this.frameFor = -1;
        var poster = !!this.poster.getAttribute('src');
        if (!poster && !this.frame.style.backgroundImage || this.coverOut) {
            return;
        }
        clearInterval(this.coverTimer);
        if (poster) {
            setShown(this.poster, true);
        }
        var v = this.video;
        var from = v.currentTime;
        var last = from;
        var self = this;
        this.coverTimer = setInterval(function () {
            var t = v.currentTime;
            if (v.seeking || t < last || t > last + 1) {
                from = t;
            }
            last = t;
            if (t > from + COVER_MOVE_S) {
                clearInterval(self.coverTimer);
                self.fadeCover(true);
                self.coverTimer = setTimeout(function () { self.hidePoster(); }, COVER_FADE_MS) as unknown as number;
            }
        }, 50) as unknown as number;
    }

    /** The pictures over the video gone, and let go too (a decoded picture kept through the video costs the TV's short
     * memory) */
    private hidePoster(): void {
        // (an interval or a timeout: one list of timers)
        clearInterval(this.coverTimer);
        this.fadeCover(false);
        this.frameFor = -1;
        setShown(this.poster, false);
        setShown(this.frame, false);
        toggleClass(this.poster, 'by-player-poster--round', false);
        this.poster.onerror = this.poster.onload = null;
        this.poster.removeAttribute('src');
        this.frame.style.backgroundImage = '';
        this.sheet.onload = null;
        this.sheet.removeAttribute('src');
    }

    /** The picture over the video fading out, or back */
    private fadeCover(out: boolean): void {
        this.coverOut = out;
        toggleClass(this.poster, 'by-player-cover--out', out);
        toggleClass(this.frame, 'by-player-cover--out', out);
    }

    /** An engine failed, routed by whose it is (an engine moves between them: a preview taken over, a video kept after
     * Back): the playing one's tries the next way; a preview stops; a kept or primed one is let go (not taken over dead) */
    private engineFailed(engine: Engine, why: string): void {
        if (engine === this.engine) {
            this.failed(why);
        } else if (this.peek && this.peek.engine === engine) {
            this.peekStop();
            this.peekEnded();
        } else if (this.primed && this.primed.engine === engine) {
            this.dropPrimed();
        }
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
        this.skipsFor(taken.engine);
        this.format = taken.video;
        this.showDetails(s, want);
        if (taken.target.itag !== taken.video.itag && taken.engine.switchVideo) {
            taken.engine.switchVideo(taken.target);
            this.format = taken.target;
        }
        this.osd.setQuality(this.format.height, this.format.fps);
        dropAhead(true);
        var c = captionFor(s, want);
        if (c) {
            this.setCaption(c);
        }
    }

    /** Show the title and channel from the streams; the description only on the watch page (Down), as in YouTube's
     * player */
    private showDetails(s: Streams, want: Want): void {
        // The speed it plays at (a live stream's normal: the speed chosen comes back for a video after it)
        this.video.defaultPlaybackRate = this.video.playbackRate = this.playbackSpeed;
        // The most replayed graph (a live stream has none)
        var self = this;
        if (prefs().replays && !s.live && !this.replays) {
            replays(want.id).then(function (r) {
                if (self.want === want) {
                    self.setReplays(r);
                }
            }, function () { return undefined; });
        }
        this.osdSeek.set(s.storyboard);
        this.watch.seek.set(s.storyboard);
        this.chapterRow.setFrames(s.storyboard);
        this.watch.setPaid(s.paid ? s.paid.text : '');
        this.osd.setHead('', s.channel || want.channel);
        this.osd.setTitle(dearrowTitle(want.id, s.title || want.title));
        this.watch.setTitle(s.title || want.title);
        this.watch.setDescription(s.description);
        this.showChat();
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
            var from = self.pastSkipped(want.t);
            if (prefs().startPicture === 'frame' && self.video.style.display === 'none') {
                self.showFrame(s.storyboard, from);
            }
            self.playFormat(video, from);
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
            // Removed, not live yet, or refused to the TV client: YouTube's player could not play it either (after a
            // switch it did play)
            if (!why && e.refused && e.ended && !want.standIn) {
                self.followStream(e.ended, e.reason);
            } else if (!why && (noneCanPlay(e) || e.refused)) {
                self.cannotPlay(e.reason);
            } else {
                self.fallback((why ? why + '; then ' : '') + (e.reason || e.status));
            }
        });
    }

    /** Close and say why the video cannot be played (YouTube's reason) */
    private cannotPlay(reason: string): void {
        this.stop();
        toast('This video cannot be played' + (reason ? ': ' + reason : '.'), undefined, PROBLEM);
    }

    /** An ended live stream (its address kept, e.g. in History) plays on as its channel's stream of the same name live
     * now (a stream running all day, started anew), found on the channel's page (not by a search: that would go into
     * the account's search history); else the reason */
    private followStream(ended: Ended, reason: string): void {
        var gen = this.gen;
        var self = this;
        // A wait of its own for the channel's page (a big reply)
        this.giveUpLater();
        liveNow(ended).then(function (found) {
            if (gen !== self.gen) {
                return;
            }
            if (found) {
                toast('This live stream has ended, so its new stream from ' + ended.channel + ' plays.', 'info');
                self.switchTo(found, false, true);
            } else {
                self.cannotPlay(reason);
            }
        }, function () {
            if (gen === self.gen) {
                self.cannotPlay(reason);
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
            // No streams yet: YouTube has not answered (network down), so its player could not play it either; else the
            // other codecs and the other method before YouTube's player
            if (!self.streams) {
                self.offline();
            } else {
                // Nothing came at all: the downloads, not the codec (another codec would wait as long again)
                self.failed(self.video.buffered.length ? 'it did not start' : 'nothing came');
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
        // Displayed once it plays (a cover fading meanwhile stays for it)
        this.video.style.display = 'none';
        if (this.coverOut) {
            clearTimeout(this.coverTimer);
            this.fadeCover(false);
        }
        var engine: Engine = this.engine = engineFor(this.video, this.streams, function (why) { self.engineFailed(engine, why); });
        this.skipsFor(engine);
        engine.load(video, this.audioFormat() as Format, t);
        // A new start: fall back to YouTube's player if it does not play
        this.giveUpLater();
        // Drop data preloaded for another video
        dropAhead();
        this.osd.setQuality(video.height, video.fps);
        // Android: the screen at a rate that shows each frame evenly, where the user lets apps switch it (before the
        // picture, as the switch blanks the screen a moment)
        preferFrameRate(displayRate(video.fps));
        if (!this.held) {
            playVideo(this.video);
        }
    }

    /** The engine failed for why: the next step of the ladder (nextStep) */
    private failed(why: string): void {
        var want = this.want as Want;
        var s = this.streams as Streams;
        var tries = this.tries;
        var other = s && this.format ? this.otherCodec(s) : null;
        var step = nextStep(why, {
            renewing: tries.renewing,
            renewDue: Date.now() - tries.renewedAt > RENEW_AGAIN_MS,
            inPlace: !tries.inPlaceTried && !!s && !s.sabr && !!this.engine && !!this.engine.renew,
            codec: !!other,
            switchable: !tries.switched && !!s && !s.only,
            playing: !!want && !!s
        });
        if (step === 'renewInPlace') {
            tries.inPlaceTried = true;
            this.renewInPlace(want);
        } else if (step === 'codec') {
            var was = kindOf((this.format as Format).mime);
            tries.kinds[was] = true;
            note('codec', why + ': ' + was + ' -> ' + kindOf((other as Format).mime));
            want.t = this.position();
            this.playFormat(other as Format, want.t);
        } else if (step === 'fallback') {
            this.fallback(why);
        } else if (step !== 'wait') {
            want.t = this.position();
            // Stop the old engine so its failures and buffer do not affect the new start; no picks meanwhile
            var old = this.engine;
            this.engine = null;
            this.streams = null;
            if (old) {
                // A failed decoder leaves its pipeline broken: the next start opens a fresh one
                old.stop();
            }
            if (step === 'renew') {
                // Renew via the method that played (SABR: with the token of a reload its server asked for)
                tries.renewedAt = Date.now();
                forgetStreams(want.id);
                this.load(s.sabr ? sabrStreams(want.id, s.sabr.reloadToken) : streams(want.id));
            } else {
                tries.switched = true;
                tries.kinds = {};
                this.load(s.sabr ? streams(want.id) : sabrStreams(want.id), why);
            }
        }
    }

    /** A video format of a codec neither playing nor tried yet for this video (null: none left) */
    private otherCodec(s: Streams): Format | null {
        var tried = this.tries.kinds;
        var playing = kindOf((this.format as Format).mime);
        return pickFormat(s.videos.filter(function (f) {
            var kind = kindOf(f.mime);
            return kind !== playing && !tried[kind];
        }), prefs().quality || AUTO_LINES);
    }

    /** New URLs for the formats playing (both tracks may fail, so requested once). If the formats differ or are
     * missing, restart from the current position (failed again, past the in-place try). */
    private renewInPlace(want: Want): void {
        // (this start's: a renewal outdated by another start sets only its own)
        var tries = this.tries;
        if (tries.renewing) {
            return;
        }
        tries.renewing = true;
        var self = this;
        var engine = this.engine as Engine;
        var itag = this.format ? this.format.itag : -1;
        var lmt = this.format ? this.format.lmt : '';
        var trackId = this.audioTrack ? this.audioTrack.id : null;
        var heard = this.audioFormat();
        var restart = function (): void {
            tries.renewing = false;
            if (self.engine === engine) {
                self.failed('expired');
            }
        };
        forgetStreams(want.id);
        streams(want.id).then(function (fresh) {
            if (self.want !== want) {
                return;
            }
            if (self.engine !== engine) {
                tries.renewing = false;
                return;
            }
            var video = fresh.videos.filter(function (f) { return f.itag === itag && f.lmt === lmt; })[0];
            var dub = fresh.audios.filter(function (t) { return t.id === trackId; })[0];
            var audio = dub ? audioOf(dub) : null;
            if (!video || !audio || !heard || audio.itag !== heard.itag || !(engine.renew as (v: Format, a: Format) => boolean)(video, audio)) {
                restart();
                return;
            }
            tries.renewing = false;
            tries.renewedAt = Date.now();
            tries.inPlaceTried = false;
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
        clearTimeout(this.endTimer);
        var was = this.want;
        // Drop the primed video and the poster over it, unless it is being taken over
        if (!keep) {
            this.dropPrimed();
            this.hidePoster();
        }
        if (was) {
            was.info = this.watch.details;
            was.t = this.position();
            was.itag = this.format ? this.format.itag : was.itag;
            was.audioId = this.audioTrack ? this.audioTrack.id : was.audioId;
            // (none chosen: Off when it returns, not the language chosen since)
            was.caption = this.caption ? this.caption.name : '';
            was.loop = this.loop;
        }
        if (this.report) {
            // The report's last time, as YouTube stores it (the element may hold Up next's video by now)
            if (was && this.watchLength > 0) {
                this.onWatched(was.id, Math.min(1, this.report.time / this.watchLength), this.report.time);
            }
            // At the player's position (the element may hold Up next's video by now)
            this.report.stop(was ? was.t : this.video.currentTime);
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
        this.setReplays(null);
        this.osdSeek.set(null);
        this.chapterRow.setFrames(null);
        this.watch.seek.set(null);
        this.skipped = {};
        this.setCaption(null);
        clearTimeout(this.jumpTimer);
        clearTimeout(this.startTimer);
        clearInterval(this.stallTimer);
        this.chat.stop();
        this.target = -1;
        this.jumping = false;
        this.land();
        if (this.engine) {
            this.engine.stop();
            this.engine = null;
        }
        return was;
    }

    /** Release and hide (Back, the end, fallback, the background); returns the video it played, or null */
    private close(keep?: boolean): Want | null {
        var was = this.reset(keep);
        // Previews play in the same video, at normal speed
        this.setSpeed(1);
        this.loader.hide();
        this.upNext.hide();
        this.watch.clear();
        this.osd.hide();
        this.view(false);
        // Android: the TV's own rate again for the screens
        preferFrameRate(0);
        if (was) {
            this.onChange();
        }
        return was;
    }

    private view(shown: boolean): void {
        if (shown !== this.shown) {
            this.shown = shown;
            // The clock in its corner, if on (none while hidden, so a preview in a tile has none)
            var corner = shown ? prefs().videoClock : 'off';
            toggleClass(this.el, 'by-player--clock-left', corner === 'left');
            toggleClass(this.el, 'by-player--clock-right', corner === 'right');
            setShown(this.el, shown);
            this.onShown(shown);
        }
    }

    /** The current position, or where a seek waiting for its media goes (so a reload or a switch lands where the viewer
     * jumped); before the picture moves, the start position (so a switch keeps it) */
    private position(): number {
        if (!this.moving && this.want) {
            return this.want.t;
        }
        var to = this.engine && this.engine.seekTarget ? this.engine.seekTarget() : -1;
        return to >= 0 ? to : this.video.currentTime;
    }

    private showOsd(withText: boolean): void {
        this.tick();
        this.osd.show(withText);
        // A jump's frames and the chapter row's pictures ready before they show (the pictures not while a jump starts:
        // its video comes first)
        this.osdSeek.prefetch(this.video.currentTime);
        if (this.target < 0 && !this.jumping) {
            this.chapterRow.prefetch(this.video.currentTime);
        }
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
                self.showChat();
                // A casting phone is told what Autoplay plays next
                self.onChange();
            }
        }, function () {
            if (self.want === want) {
                // Requested again the next time the page opens
                self.infoAsked = false;
                self.watch.setInfo(null);
            }
        });
    }

    /** A live stream's chat beside the picture, once its streams and details are known (Settings: Live chat) */
    private showChat(): void {
        var info = this.watch.details;
        var s = this.streams;
        if (prefs().liveChat && s && s.live && info && info.chat) {
            this.chat.start(info.chat);
        }
    }

    /** The chat waits while the watch page covers it or the video is paused */
    private holdChat(): void {
        this.chat.hold(!!this.watchPage && this.watchPage.shown || this.video.paused);
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
            if (self.speedWorks !== false && !(s && s.live)) {
                opens('Speed', speedName(self.speed), function () { return self.speedLines(); });
            }
            if (s && s.live) {
                flips('Live chat', prefs().liveChat, function () {
                    setPref('liveChat', !prefs().liveChat);
                    if (prefs().liveChat) {
                        self.showChat();
                    } else {
                        self.chat.stop();
                    }
                });
            }
            flips('Repeat', self.loop, function () { self.loop = !self.loop; });
            flips('Autoplay', prefs().autoplay, function () { setPref('autoplay', !prefs().autoplay); });
            flips('Stats for nerds', self.stats.shown, function () { self.stats.show(!self.stats.shown); });
            return lines;
        }, 0);
    }

    /** The playback speeds, Normal among them */
    private speedLines(): PanelLine[] {
        var self = this;
        return SPEEDS.map(function (rate) {
            return { label: speedName(rate), chosen: self.speed === rate, action: function () { self.setSpeed(rate); } };
        });
    }

    /** The playback speed it plays at (1: normal; a live stream's) */
    get playbackSpeed(): number {
        return this.streams && this.streams.live ? 1 : this.speed;
    }

    /** Sets the playback speed (a live stream keeps playing at normal speed; the speed is for the videos after it); a
     * first speed other than 1 is checked to really change the pace, else it goes back to normal and is not offered
     * again on this TV */
    setSpeed(rate: number): void {
        var v = this.video;
        clearTimeout(this.speedTimer);
        if (this.speedWorks === false) {
            rate = 1;
        }
        this.speed = rate;
        v.defaultPlaybackRate = v.playbackRate = this.playbackSpeed;
        if (rate !== 1 && this.speedWorks === null) {
            this.checkSpeed(rate, SPEED_TRIES);
        }
    }

    /** Measures whether rate changes the pace, over SPEED_CHECK_MS of one video playing steadily at it (again later
     * while paused, seeking, starting or live, up to tries times; then on the next speed chosen) */
    private checkSpeed(rate: number, tries: number): void {
        var v = this.video;
        var from = v.currentTime;
        var at = Date.now();
        var gen = this.gen;
        var self = this;
        this.speedTimer = setTimeout(function () {
            if (self.speed !== rate) {
                return;
            }
            if (v.paused || v.seeking || !self.moving || self.gen !== gen || self.playbackSpeed !== rate) {
                if (tries > 1) {
                    self.checkSpeed(rate, tries - 1);
                }
                return;
            }
            var pace = (v.currentTime - from) / ((Date.now() - at) / 1000);
            self.speedWorks = Math.abs(pace - rate) < Math.abs(pace - 1);
            save(SPEED_KEY, self.speedWorks);
            if (!self.speedWorks) {
                self.setSpeed(1);
                toast('This TV plays videos only at normal speed', 'info');
            }
            self.onChange();
        }, SPEED_CHECK_MS) as unknown as number;
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
        if (same && this.moving && this.engine && this.engine.switchVideo) {
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
        if (was && f.mime === was.mime && this.moving && this.engine && this.engine.switchAudio) {
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
        return this.skipFrom(at);
    }

    /** Marks segment at skipped (with its notice) and returns where playing goes on: its end, past segments that follow
     * at once too (one jump, not one after the other) */
    private skipFrom(at: number): number {
        var list = this.segments;
        var end = list[at].end;
        toast(skippedText(list[at]), undefined, skipEdge(list[at].category));
        this.skipped[at] = true;
        for (var i = 0; i < list.length; i++) {
            if (!this.skipped[i] && list[i].start <= end + SKIP_CHAIN_S && list[i].end > end) {
                this.skipped[i] = true;
                end = list[i].end;
                i = -1;
            }
        }
        return end;
    }

    /** engine loads past the segments still to skip (their media would be skipped), on from where they end */
    private skipsFor(engine: Engine): void {
        var self = this;
        engine.skips = function () {
            return self.engine === engine ? self.segments.filter(function (s, i) { return !self.skipped[i]; }) : [];
        };
    }

    /** Draw SponsorBlock segments and chapters on both bars once the duration is known. The length is the format's:
     * a kept pipeline reports the previous video's until the new one sets its own, which drew the marks out of place */
    private drawParts(): void {
        var d = this.length();
        var chapters = this.watch.details ? this.watch.details.chapters : [];
        this.osdMarks.draw(this.segments, chapters, d);
        this.watch.setMarks(this.segments, d);
        this.chapterRow.set(chapters);
        this.showKeys();
    }

    /** The video's most replayed graph (null: none), over the info bar's progress bar */
    private setReplays(r: Replays | null): void {
        this.replays = r;
        this.osdReplays.set(r);
        toggleClass(this.el, 'by-player--replays', !!r);
    }

    /** What can be played: a live stream's window, else the video from 0 to its length (s) */
    private window(): { from: number; to: number } {
        var span = this.liveSpan();
        return span ? { from: span.from, to: span.edge } : { from: 0, to: this.length() };
    }

    /** A live stream's window (null: a video, or not known yet) */
    private liveSpan(): LiveSpan | null {
        var e = this.engine;
        return e instanceof LiveEngine && e.edge > 0 ? { from: e.oldest, edge: e.edge } : null;
    }

    /** The video's length (s; 0 unknown): its format's, as a kept pipeline reports the previous video's until the new
     * one sets its own, and a start's window a shorter one until it plays */
    private length(): number {
        return this.format ? this.format.duration || lengthOf(this.video) : 0;
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
        this.captionAsked = true;
        var self = this;
        loadCaptions(c.url, function () { return self.caption === c; }, c.kind === 'translated').then(function (track) {
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
        var from = c.source || null;
        toast('YouTube is not translating subtitles right now.' + (from ? ' ' + from.name + ' shown.' : ''), undefined, PROBLEM);
        this.setCaption(from);
    }

    // ---- playback

    /** Fill the loading sign with the frames the TV decodes before showing the first picture (WARM_S worth), full
     * FULL_S before they are all in (at the rate so far); it hides when the picture plays */
    private watchWarmUp(): void {
        var self = this;
        var v = this.video as CountedVideo;
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
            this.loader.finish(FILL_MS);
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
        // A jump's picture moving there
        if (this.landing && !this.jumping && !v.seeking && !this.seekPending() && v.currentTime > this.landFrom + 0.05) {
            this.land();
        }
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
            this.watchStalls();
            // Moving after the ladder switched methods: the one playing goes first for the next videos a while
            if (this.tries.switched && this.streams) {
                learnMethod(!!this.streams.sabr);
            }
            noteZap(want.id, this.step('moving'));
            this.onStarted();
            var gen = this.gen;
            setTimeout(function () {
                if (gen === self.gen && self.moving) {
                    self.osdSeek.prefetch(self.video.currentTime, true);
                }
            }, FRAMES_AHEAD_MS);
            if (!want.paidShown) {
                want.paidShown = true;
                this.showPaid(!this.watch.shown);
            }
            // Watch page details (asked at the start; again if that failed)
            this.askInfo();
            this.loadCaption();
            // Playing now (no longer loading)
            this.onChange();
            // One report per playback (renewed URLs restart the picture, not the playback)
            if (prefs().history && !this.report && !(this.streams && this.streams.live)) {
                this.report = new WatchReport(want.id, v.currentTime, function () {
                    var audio = self.audioFormat();
                    return { video: self.format ? self.format.itag : 0, audio: audio ? audio.itag : 0 };
                });
            }
        } else if (this.report && !v.paused) {
            this.report.at(v.currentTime);
        }
        // Preload the next video near the end with Autoplay on (the queue's next, else YouTube's; none with repeat)
        var length = lengthOf(v);
        if (this.report && length > 0) {
            this.watchLength = length;
        }
        // Stuck at the very end (the time stands): ended here
        if (this.moving && length > 0 && length - v.currentTime < END_STUCK_S && !v.paused) {
            clearTimeout(this.endTimer);
            var stood = v.currentTime;
            this.endTimer = setTimeout(function () {
                if (self.want === want && !v.ended && !v.paused && Math.abs(v.currentTime - stood) < 0.05) {
                    note('end', 'stood at ' + stood.toFixed(2) + ' of ' + length.toFixed(2));
                    self.ended();
                }
            }, END_STUCK_MS) as unknown as number;
        }
        // (a live stream has no end; a video's own length: a start's window may still be told)
        var whole = this.liveSpan() ? 0 : this.length();
        if (this.moving && !this.aheadTold && whole > 0 && whole - v.currentTime < NEXT_AHEAD_S) {
            this.aheadTold = true;
            var coming = this.loop ? null : this.following(false);
            if (coming) {
                this.onAhead(coming, true);
            }
        }
        var span = this.liveSpan();
        if (this.osd.shown && span) {
            // Live: LIVE, or how far behind the head (a pending jump's), on a bar over the stream's window
            this.osd.setTime(liveTime(this.target >= 0 ? this.target : v.currentTime, span), liveShare(v.currentTime, span));
        } else if (this.osd.shown) {
            // The time and the name of the chapter row's selected chapter, else where a pending jump lands, else where it
            // plays (still starting: where it starts, of its format's length; the element may hold the previous video)
            var chosen = this.chapterRow.selected;
            var now = this.position();
            var whole = this.moving ? length : this.format ? this.format.duration : 0;
            var at = chosen ? chosen.start : this.target >= 0 ? this.target : now;
            this.osd.setTime(dots([clock(at) + (whole ? ' / ' + clock(whole) : ''), chosen ? chosen.title : this.osdMarks.nameAt(at)]),
                whole ? now / whole : 0);
        }
        this.subtitleView.show(this.track ? this.track.textAt(v.currentTime) : null);
        this.stats.tick();
        // Only once the picture moves: a start skips segments itself, and before that the time may be stale
        var at = this.moving ? segmentAt(this.segments, v.currentTime, this.skipped) : -1;
        if (at >= 0 && this.engine) {
            var end = this.skipFrom(at);
            // A segment to the very end (an outro): end the video now rather than seek to its last frame
            if (length > 0 && end >= length - END_SKIP_S) {
                v.pause();
                if (this.report) {
                    this.report.at(length);
                }
                this.ended();
            } else {
                this.engine.seek(end);
            }
        }
    }

    /** From the picture's start: a picture that keeps standing while it should play, its buffer at the playhead not
     * growing (a server or network that hangs, answers without the media it needs, a decoder that hangs with the buffer
     * full; not a link merely too slow for the quality, whose buffer grows; not paused, not ended, not live) reloads the
     * video at the same spot, as the fallback ladder says */
    private watchStalls(): void {
        var self = this;
        var v = this.video;
        var last = -1;
        var loaded = -1;
        this.stalls.reset();
        clearInterval(this.stallTimer);
        // Not a live stream: at its head, it waits for the broadcaster's next part
        if (this.streams && this.streams.live) {
            return;
        }
        this.stallTimer = setInterval(function () {
            var t = v.currentTime;
            var end = bufferedEnd(v.buffered, t);
            var stood = !self.held && !v.paused && !v.ended && (v.seeking || v.readyState < 3 || t === last) && end <= loaded;
            last = t;
            loaded = end;
            // (restarting: the start's give-up timer watches it)
            if (self.moving && self.stalls.note(stood, Date.now())) {
                note('stalled', 'at ' + t.toFixed(1));
                self.failed('stalled');
            }
        }, STALL_CHECK_MS) as unknown as number;
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

/** The engine for a video's streams: a live stream's segments, SABR (the account's streams), else each format's own
 * URL */
function engineFor(video: HTMLVideoElement, s: Streams | null, failed: (why: string) => void): Engine {
    return s && s.live ? new LiveEngine(video, s.live, failed) : s && s.sabr ? new SabrEngine(video, s.sabr, failed) : new DashEngine(video, failed);
}

/** Position and size el (px), rounded to whole pixels */
function box(el: HTMLElement, x: number, y: number, w: number, h: number): void {
    el.style.left = Math.round(x) + 'px';
    el.style.top = Math.round(y) + 'px';
    el.style.width = Math.round(w) + 'px';
    el.style.height = Math.round(h) + 'px';
}

/** A start of video id at t as the player makes it, so preload, previews and Up next prepare what it takes: the streams
 * asked, its formats (null: none playable) and where it starts (past a skip segment containing t; SponsorBlock waited
 * for SEGMENTS_WAIT_MS at most: a start then goes on without its segments too) */
export function startOf(asked: Promise<Streams>, id: string, t: number): Promise<{ streams: Streams; formats: { video: Format; audio: Format } | null; t: number }> {
    var parts = Promise.race([segments(id, prefs().skip), new Promise<Segment[]>(function (ok) { setTimeout(function () { ok([]); }, SEGMENTS_WAIT_MS); })]);
    return Promise.all<any>([asked, parts]).then(function (got) {
        var parts = got[1] as Segment[];
        var at = segmentAt(parts, t, {});
        return { streams: got[0] as Streams, formats: startFormats(got[0]), t: at < 0 ? t : parts[at].end };
    });
}

/** Subtitles for want: those chosen for it (a returning video), else the last chosen language if the video has it */
function captionFor(s: Streams, want: Want): Caption | null {
    var all = captionList(s);
    return want.caption !== undefined ? all.filter(function (one) { return one.name === want.caption; })[0] || null :
        captionIn(all, prefs().captions);
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

/** The formats a start plays (preloaded ahead): the Settings quality (Auto and Highest: the TV's max, 4K) and the
 * original audio (stable volume if on); null: none playable */
export function startFormats(s: Streams): { video: Format; audio: Format } | null {
    // At equal height and frame rate, the kept pipeline's codec, so it is reused (player/pipeline.ts)
    var video = pickFormat(s.videos, prefs().quality || AUTO_LINES, pictureKind());
    var track = s.audios[0];
    return video && track ? { video: video, audio: audioOf(track) } : null;
}

/** A track's format to play: the stable-volume version if on and available */
function audioOf(track: AudioTrack): Format {
    return prefs().stableVolume && track.stable ? track.stable : track.format;
}

/** The screen rate (Hz) for a video's frame rate: one each frame shows evenly at (25 and 30 fps at 50 and 60 Hz, as a
 * TV's 25 or 30 Hz modes are rare) */
export function displayRate(fps: number): number {
    return fps === 25 || fps === 30 ? fps * 2 : fps;
}

/** A speed as YouTube's player names it: Normal, else the factor */
function speedName(rate: number): string {
    return rate === 1 ? 'Normal' : String(rate);
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
