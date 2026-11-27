// Bolli YouTube's own video layer on Android: a video on the watch screen plays in Android's own player (Media3, in the
// app around the page: android/app/src/youtubeDebug/java/org/bolli/youtube) on a layer of its own under the
// see-through page, as the official app's does, instead of in the web view's <video> (drawn by the GPU into the
// page's picture: 4K and 60 fps stutter on most TVs). This script is in the APK alone (tools/build_app.mjs builds it
// away from the app's folder, tools/android.mjs loads it after app.js); webOS has none. Where the shell has the
// player (BolliVideo) it names itself on the page as BolliNative, which the player asks for a video's engine
// (player/engine.ts NativeHook, own-player.ts nativeEngine).
//
// The player keeps its <video> element as its handle. While a video plays here the element's time, state and sizes
// answer from Android's player and its events are fired from that player's reports (BolliNative.take: at every
// change, and each second while it plays or loads; between them the time runs on by the clock), so the player reads
// it as it reads a video of its own. The element holds no video then and draws nothing: while the picture is to show
// the page is see-through where it is (cut, native.css), its box told to the shell at every change. Leaving (stop)
// gives the element back as it was.
//
// What it borrows from the app's modules is bundled into it a second time, so only what holds no state of its own:
// tests/youtube-android-native.test.mjs lists the modules it may take from.

import { LAYOUT_HEIGHT, LAYOUT_WIDTH, toggleClass } from '../core/dom.js';
import { Format, kindOf, Live, Streams } from '../api/streams.js';
import { jumpTarget, LivePlays, NativeHook } from '../player/engine.js';
import { note } from '../player/play-log.js';

/** The shell's player (NativeVideo.java: its Bridge). Every frame of the web view can call it, youtube.com's too, so
 * what takes an address to fetch takes the key with it that the shell hands the app's own page alone (hello) */
export interface VideoShell {
    /** Asks for the key: the shell answers by BolliNative.unlock, which it runs in the app's own page only */
    hello(): void;
    /** Loads a video, paused: JSON with key, g (the load's number, in every report of it), at (s), length (s), rate,
     * volume, video and audio (the formats it may play: Sent), v and a (which of them first), and for the account's
     * streams sabr (their address, config and client: the shell asks YouTube's server for them as the page's own
     * engine does, player/sabr-engine.ts); for a live stream live (its segments' length, its window and whether it
     * has ended: the shell plays it from behind its head as player/live-engine.ts does) */
    load(json: string): void;
    /** Plays, pauses, goes to t (s; in a live stream to the start of the segment t lies in, within its window and up
     * to its head). n: the count of these asked so far, told back in the reports made after it ran */
    play(n: number): void;
    pause(n: number): void;
    seek(t: number, n: number): void;
    speed(rate: number): void;
    volume(v: number): void;
    /** Format i of its kind ('v', 'a'), at this address now, plays on from about ahead s past the picture (0: from
     * where what is loaded ends) */
    pick(kind: string, i: number, ahead: number, url: string, key: string): void;
    /** New addresses for the playing formats (video v, audio a): on from where it stopped for the old ones */
    renew(v: number, video: string, a: number, audio: string, key: string): void;
    /** The picture's box (the page's 1280 by 720 units; it may reach past the screen), and whether it shows (else
     * dark) */
    box(left: number, top: number, width: number, height: number, shown: boolean): void;
    /** At most s loaded ahead of the picture (0: as usual): a video loaded before its start */
    hold(s: number): void;
    /** The live stream playing has ended (the player asked YouTube): it plays out what it has and ends */
    over(): void;
    /** The video let go (its decoders kept for the next one) */
    stop(): void;
    /** The video and the decoders let go: the web view's own player is to play */
    free(): void;
}

/** A format as the shell takes it: by its address, or, by SABR, as that names it (itag, lmt, xtags; an audio one's
 * track and whether it has stable volume) */
interface Sent {
    url: string;
    mime: string;
    width: number;
    height: number;
    fps: number;
    bitrate: number;
    length: number;
    init: number[];
    index: number[];
    itag?: number;
    lmt?: string;
    xtags?: string;
    track?: string;
    drc?: boolean;
}

/** The shell's report of its player */
export interface Report {
    /** The load it is of, and the last of play, pause and seek that had run when it was made */
    g: number;
    n: number;
    /** 1 idle, 2 loading, 3 ready, 4 ended */
    st: number;
    /** It is to play (not paused, by the page or by itself: the sound taken by another app), and the picture moves */
    pw: number;
    pl: number;
    /** The position (s), the device's clock when it was read (ms), where what is loaded from it ends (s) and how
     * much is kept behind it (s) */
    pos: number;
    t: number;
    buf: number;
    back: number;
    /** The video's length (s; 0: not known) and its picture's size */
    dur: number;
    w: number;
    h: number;
    /** Frames dropped, and all that came out of the decoder */
    dr: number;
    fr: number;
    /** Video downloads done since the last report: each its bytes and ms */
    dl?: number[][];
    /** The video format's segment starts (its keyframes, s), as its index is read */
    starts?: number[];
    /** The video decoder the shell's player holds, as the device names it (once a load, and as one is made) */
    dec?: string;
    /** It failed and stands: 'expired', 'network', 'media', 'stream', or 'player' (the shell's player itself), and
     * what the player said */
    err?: string;
    text?: string;
    /** A request was refused for its address while it plays on what is loaded: new addresses are wanted (once) */
    stale?: number;
    /** By SABR: the token its server's request for new streams came with (the page's request for them names it),
     * the address the server moved the video to, and a line for the play log */
    token?: string;
    url?: string;
    say?: string;
    /** A live stream: its window's start and its head on the position's scale (s; 0: not known yet), whether all
     * there is has been asked for (1), and whether it has ended (1) */
    live?: number[];
    /** A live stream's segment to come has not come for a good while (once, and again after as long): it may have
     * ended */
    stands?: number;
    /** A start's steps in the shell up to its first picture, each with its ms since the load reached it (once) */
    steps?: string;
}

var IDLE = 1;
var READY = 3;
var ENDED = 4;
/** The element's time event while the picture moves (ms: as a browser's), and its first after the picture came (the
 * player takes a start as moving once its time has: no quarter second later than it does) */
var TIME_MS = 250;
var FIRST_MS = 30;
/** The time runs on by the clock at most this long past a report (ms: they come a second apart; a page that stood
 * longer does not run the time on over what may have stopped) */
var RUN_ON_MS = 1500;
/** A report's time this little behind the time last given does not step it back (s: a report on its way while the
 * clock ran) */
var BACK_S = 0.1;
/** How far past the picture a format switch takes effect where the player asks for it soon, or names no distance (s) */
var SWITCH_S = 3;
/** A live stream, as the page's own engine plays one (player/live-engine.ts, whose values these are: the tests hold
 * them together): a start plays START_BEHIND segments behind the head; within LIVE_NEAR_S of it the viewer follows
 * it live, and one following it who fell CATCH_UP_S further behind than a start (a stall) is moved back there */
var START_BEHIND = 3;
/** The account's streams are loaded at most this far ahead (s): YouTube's server answers a request for more than it
 * means to send ahead with nothing (player/sabr-engine.ts, whose value this is; NativeVideo's Sabr.READAHEAD_US) */
var READAHEAD_S = 10;
var LIVE_NEAR_S = 25;
var CATCH_UP_S = 15;
/** A start that was asked to play and has shown no picture this long when it is given up (ms) counts against the
 * shell's player (one the viewer leaves sooner does not, nor a video loaded ahead of its start or paused: those
 * stand as they are meant to), and after MISSES of them in a row the web view's plays the videos */
var MISS_MS = 8000;
var MISSES = 2;

/** The engine playing here (the element answers for it, the shell's reports are its), and the count of loads */
var active: NativeEngine | null = null;
var loads = 0;
/** The shell's player failed a video by itself, or showed no picture MISSES starts in a row (missed: how many so
 * far): the videos after it play in the web view's as before */
var broken = false;
var missed = 0;
/** The shell's player could not play the account's streams as it reads them (by SABR: an init segment that is not
 * the file's head): the web view's plays those from here on, a guest's still play here */
var plain = false;
/** The shell's stop on its way (0: none): a load that comes first takes the shell's player as it is, its decoder
 * and its layer kept for the next video */
var leaving = 0;
/** The shell's player has had a video since its decoders were last let go (it keeps them between videos) */
var holding = false;
/** The shell's key ('' until it has answered hello: no video is its player's before) */
var key = '';

/** The page see-through where the shell's picture shows. The player full screen: all of it (by-native: native.css
 * leaves the screens and the page's colour undrawn). The player in a box of its own (a tile's preview): in that box
 * alone (by-native-box), where what lies under the player is not drawn: the page's colour (a sheet of it laid under
 * everything, with the box cut out; the look's own canvas cut the same) and what the screens draw in the box under
 * the player (the tile's picture, a playlist's frame: hidden until the picture goes). What the page draws over the
 * player stays, and so does what lies over it: the screens' layer over a player put under the page (main.ts underPage:
 * a channel's header over its header video, a playlist's page over its Backdrop), or a z-index above the player's. */
var cutNow = '';
var sheet: HTMLElement | null = null;
var hidden: HTMLElement[] = [];

/** Cuts the page for the picture: box null: not at all (the page as it is); empty: wholly; else in that box (left,
 * top, width, height) of the player */
function cut(box: number[] | null, player: HTMLElement): void {
    var now = box ? box.join(' ') || 'whole' : '';
    if (now === cutNow) {
        return;
    }
    cutNow = now;
    var root = document.documentElement;
    var canvas = document.querySelector('.by-canvas') as HTMLElement | null;
    for (var i = 0; i < hidden.length; i++) {
        hidden[i].style.visibility = '';
    }
    hidden = [];
    var boxed = !!box && box.length > 0;
    // (the page's colour as the look gives it, read before the page is marked: marked, it is see-through)
    var colour = boxed ? getComputedStyle(document.body).backgroundColor : '';
    toggleClass(root, 'by-native', now === 'whole');
    toggleClass(root, 'by-native-box', boxed);
    var hole = '';
    if (box && boxed) {
        var right = box[0] + box[2];
        var bottom = box[1] + box[3];
        hole = 'polygon(evenodd, 0 0, ' + LAYOUT_WIDTH + 'px 0, ' + LAYOUT_WIDTH + 'px ' + LAYOUT_HEIGHT + 'px, 0 ' + LAYOUT_HEIGHT + 'px, 0 0, ' +
            box[0] + 'px ' + box[1] + 'px, ' + box[0] + 'px ' + bottom + 'px, ' + right + 'px ' + bottom + 'px, ' + right + 'px ' + box[1] + 'px, ' +
            box[0] + 'px ' + box[1] + 'px)';
        if (!sheet) {
            sheet = document.createElement('div');
            sheet.className = 'by-native-sheet';
            document.body.insertBefore(sheet, document.body.firstChild);
        }
        sheet.style.backgroundColor = colour;
        sheet.style.clipPath = hole;
        // What the screens draw in the box under the player: of the elements at its middle (topmost first: those
        // after the player's), each that lies within the box, draws something itself (a picture, a background) and
        // is not meant over the player. One that only holds others is left: hidden, it would take them with it.
        // (one the pointer does not reach is not among them: native.css hides those, a channel's banner)
        var at = document.elementsFromPoint(box[0] + box[2] / 2, box[1] + box[3] / 2) as HTMLElement[];
        var over = parseInt(getComputedStyle(player).zIndex, 10) || 0;
        var under = false;
        for (var k = 0; k < at.length; k++) {
            var el = at[k];
            if (el === player || player.contains(el)) {
                under = true;
            } else if (under && el !== sheet && el !== canvas && el !== document.body && el !== root && el.id !== 'app') {
                var r = el.getBoundingClientRect();
                var look = getComputedStyle(el);
                var draws = el.tagName === 'IMG' || el.tagName === 'CANVAS' || look.backgroundImage !== 'none' ||
                    !/^(transparent|rgba\(\d+, \d+, \d+, 0\))$/.test(look.backgroundColor);
                if (draws && !(parseInt(look.zIndex, 10) > over) && r.left >= box[0] - 1 && r.top >= box[1] - 1 && r.right <= right + 1 && r.bottom <= bottom + 1) {
                    el.style.visibility = 'hidden';
                    hidden.push(el);
                }
            }
        }
    }
    if (canvas) {
        canvas.style.clipPath = hole;
    }
}

/** A format as sent */
function sent(f: Format): Sent {
    return { url: f.url, mime: f.mime, width: f.width, height: f.height, fps: f.fps, bitrate: f.bitrate, length: f.length,
        init: [f.init.start, f.init.end], index: [f.index.start, f.index.end] };
}

/** A format that comes by SABR as sent: no address, its names there */
function sentBySabr(f: Format): Sent {
    var out = sent(f);
    out.url = '';
    out.itag = f.itag;
    out.lmt = f.lmt;
    out.xtags = f.xtags;
    out.track = f.track || '';
    out.drc = !!f.drc;
    return out;
}

/** Whether a and b are the same format (a track's copies share an itag: their tags tell them apart) */
function same(a: Format, b: Format): boolean {
    return a === b || a.itag === b.itag && a.lmt === b.lmt && a.xtags === b.xtags;
}

/** Where f is in list (-1: not) */
function indexOf(list: Format[], f: Format): number {
    for (var i = 0; i < list.length; i++) {
        if (same(list[i], f)) {
            return i;
        }
    }
    return -1;
}

/** list with f in it (first, where it was not) */
function having(list: Format[], f: Format): Format[] {
    return indexOf(list, f) < 0 ? [f].concat(list) : list;
}

/** Every audio format of s in mime, each once: the tracks' own, their stable-volume and stereo copies, and each
 * sound's */
function audiosOf(s: Streams, mime: string): Format[] {
    var out: Format[] = [];
    var add = function (f: Format | null | undefined): void {
        if (f && f.mime === mime && indexOf(out, f) < 0) {
            out.push(f);
        }
    };
    s.audios.forEach(function (t) {
        add(t.format);
        add(t.stable);
        add(t.stereo);
        for (var sound in t.sounds) {
            add(t.sounds[sound].format);
            add(t.sounds[sound].stable);
            add(t.sounds[sound].boost);
        }
    });
    return out;
}

/** A length of an element's style in px (none set: the whole) */
function px(value: string, whole: number): number {
    var n = parseFloat(value);
    return isNaN(n) ? whole : n;
}

/** Plays a video's formats in the shell's player, the element answering for it (Engine: player/engine.ts): a guest's
 * by their addresses, the account's by SABR (asked for by the shell, which follows a format switched in place, as the
 * page's own SABR engine does), and a live stream's, for which it answers the player as its own live engine does
 * (LivePlays) */
export class NativeEngine implements LivePlays {
    loaded: (bytes: number, ms: number) => void = function () { return undefined; };
    /** It plays a live stream (how the player knows this engine for one: own-player.ts liveOf); the stream's head
     * and its window's start on the element's time scale (s; 0: not known yet), and whether it has ended */
    live: boolean;
    edge = 0;
    oldest = 0;
    over = false;
    /** All there is of the stream has been asked for; the viewer follows it live (from the start, again once near
     * its head; not after their own jump or pause) */
    private head = false;
    private following = true;
    /** When the head last moved on (ms, the device's clock as the shell read it) */
    private edgeAt = 0;
    /** It plays the account's streams (SABR): said in the quality tag and Stats for nerds (own-player.ts bySabr); the
     * shell loads those only as far ahead as YouTube's server sends (READAHEAD_S), which Auto quality judges by */
    bySabr: boolean;
    readahead: number | undefined;

    /** The formats the shell has, in the order sent (the video ones in the playing codec, the audio ones of the
     * playing type: what a switch in place may name), and which of them play */
    private videos: Format[] = [];
    private audios: Format[] = [];
    private v = 0;
    private a = 0;
    /** The video's keyframes (s), once its index is read */
    private starts: number[] = [];
    /** The last report's position (s) and when it was read (ms), whether the picture moves, the player's state */
    private pos = 0;
    private at = 0;
    private playing = false;
    private state = IDLE;
    /** The time last given while the picture moved (s; -1: none since it stood) */
    private given = -1;
    /** What is loaded around the position (s) */
    private from = 0;
    private to = 0;
    private ranges: { length: number; start(i: number): number; end(i: number): number };
    private length = 0;
    private width = 0;
    private height = 0;
    /** The element's own state */
    private paused = true;
    private seeking = false;
    private meta = false;
    private rate = 1;
    private defaultRate = 1;
    private muted = false;
    private sound = 1;
    /** The count of play, pause and seek asked of the shell: a report made before the last ran tells an older state */
    private asked = 0;
    private dropped = 0;
    private frames = 0;
    /** When the shell counted them (ms, its clock) */
    private countedAt = 0;
    /** The shell's video decoder as the device names it ('' not told yet: Stats for nerds) */
    decoder = '';
    private timer = 0;
    /** When it was last paused or asked to play (ms; read while it plays alone: a video loaded ahead of its start
     * waits paused, of no account), whether its picture has moved, and whether it has waited MISS_MS for one while
     * asked to play (late) */
    private playAt = 0;
    private moved = false;
    private late = false;
    private watcher: MutationObserver | null = null;
    /** The box and whether it shows, as last told; the element's members set over its own (shadow) */
    private placed = '';
    private shadowed: string[] = [];

    constructor(private el: HTMLVideoElement, private shell: VideoShell, private s: Streams, private onFail: (why: string) => void) {
        var self = this;
        this.ranges = {
            length: 0,
            start: function () { return self.from; },
            end: function () { return self.to; }
        };
        this.live = !!s.live;
        this.bySabr = !!s.sabr && !s.live;
        this.readahead = this.bySabr ? READAHEAD_S : undefined;
        this.over = !!(s.live && s.live.over);
    }

    load(video: Format, audio: Format, startAt: number): void {
        var el = this.el;
        var kind = kindOf(video.mime);
        var sabr = this.s.sabr;
        this.videos = having(this.s.videos.filter(function (f) { return kindOf(f.mime) === kind; }), video);
        this.audios = having(audiosOf(this.s, audio.mime), audio);
        this.v = indexOf(this.videos, video);
        this.a = indexOf(this.audios, audio);
        // (what the element was set to: the sound, the speed)
        this.muted = el.muted;
        this.sound = el.volume;
        this.rate = el.playbackRate || 1;
        this.defaultRate = el.defaultPlaybackRate || 1;
        // (a live stream has no length, and starts where the shell puts it behind the head)
        this.length = this.live ? 0 : video.duration || toldLength(this.s);
        this.pos = this.from = this.to = startAt;
        // (one engine has the element and the shell's player at a time)
        if (active) {
            active.stop();
        }
        active = this;
        holding = true;
        clearTimeout(leaving);
        leaving = 0;
        this.shadow();
        var as = sabr ? sentBySabr : sent;
        this.shell.load(JSON.stringify({ key: key, g: ++loads, at: startAt, length: this.length, rate: this.rate, volume: this.muted ? 0 : this.sound,
            video: this.videos.map(as), audio: this.audios.map(as), v: this.v, a: this.a,
            sabr: sabr ? { url: sabr.url, config: sabr.config, client: sabr.client } : undefined,
            live: this.s.live ? { segment: this.s.live.segment, dvr: this.s.live.dvr, over: this.over } : undefined }));
        // The picture's place follows the element's style, and its player's (hidden with it, or put in a box)
        var self = this;
        this.watcher = new MutationObserver(function () { self.place(); });
        this.watcher.observe(el, { attributes: true, attributeFilter: ['style'] });
        this.watcher.observe(el.parentNode as Node, { attributes: true, attributeFilter: ['style'] });
        this.place();
        this.later('loadstart');
        if (this.length) {
            this.later('durationchange');
        }
    }

    /** As the page's own engines: a jump onto the keyframe nearest `to` on that side of from, a part skipped up to
     * `to` left there (Android's player shows a picture between keyframes soon enough: no quick jumps here) */
    jump(to: number, from: number, past?: boolean): void {
        var live = this.s.live;
        // (a live stream: by whole segments from where it plays, as the page's own engine; the shell lands it on the
        // segment's start, within the stream's window. The viewer's own: no longer following it live)
        this.following = false;
        this.seek(live ? from + Math.round((to - from) / live.segment) * live.segment : past ? to : jumpTarget(this.starts, to, from));
    }

    atHead(): boolean {
        return this.head;
    }

    /** The stream ended while it played: the shell plays out what it has, and its end is the element's */
    finish(): void {
        if (active === this && this.live && !this.over) {
            this.over = true;
            this.shell.over();
        }
    }

    /** The line back after a drop that stood the picture (own-player.ts goOnForLine): on from where it stood, or
     * START_BEHIND segments behind the head if that is further on (the head has moved on with the clock meanwhile):
     * nothing played twice, and as live as a start; the shell's player, stopped by the failed requests, goes on with
     * its picture standing until the next one plays. False: nothing to go on with (not playing here, ended, nothing
     * played yet) */
    resume(): boolean {
        var live = this.s.live;
        if (active !== this || !live || this.over || !this.moved || !this.edge) {
            return false;
        }
        this.following = true;
        this.seek(Math.max(this.pos, this.startBehind(this.headNow())));
        return true;
    }

    /** The head now: as last told, moved on by the clock since it last moved (the reports may come with it standing
     * while the line is down) */
    private headNow(): number {
        return this.edge + Math.max(0, Date.now() - this.edgeAt) / 1000;
    }

    /** As far behind the head as a start plays */
    private startBehind(edge: number): number {
        return edge - START_BEHIND * (this.s.live as Live).segment;
    }

    /** The picture moves again: a viewer near the head follows it live; one following it who fell behind (a stall) is
     * moved back to as far behind as a start plays, once the lag is CATCH_UP_S more than that (as the page's engine:
     * keepUp) */
    private keepUp(): void {
        var live = this.s.live;
        if (!live || this.over || !this.edge) {
            return;
        }
        var edge = this.headNow();
        var behind = edge - this.pos;
        if (behind < LIVE_NEAR_S) {
            this.following = true;
        } else if (this.following && this.startBehind(edge) - this.pos >= CATCH_UP_S) {
            note('live', 'caught up from ' + Math.round(behind / live.segment) + ' segments behind the head');
            this.seek(this.startBehind(edge));
        }
    }

    stop(): void {
        if (active !== this) {
            return;
        }
        active = null;
        clearInterval(this.timer);
        if (this.watcher) {
            this.watcher.disconnect();
        }
        if (this.moved) {
            missed = 0;
        } else if ((this.late || this.overdue()) && ++missed >= MISSES) {
            note('native off', missed + ' starts in a row showed no picture: the web view\'s player from here on');
            broken = true;
        }
        var shell = this.shell;
        leaving = setTimeout(function () {
            leaving = 0;
            shell.stop();
        }, 0) as unknown as number;
        cut(null, this.el.parentNode as HTMLElement);
        this.unshadow();
    }

    renew(video: Format, audio: Format): boolean {
        // (a live stream's formats are known by their itag alone, as the page's own live engine knows them)
        var live = this.live;
        var alike = function (a: Format, b: Format): boolean { return live ? a.itag === b.itag : same(a, b); };
        if (active !== this || this.s.sabr || !alike(this.videos[this.v], video) || !alike(this.audios[this.a], audio)) {
            return false;
        }
        this.videos[this.v] = video;
        this.audios[this.a] = audio;
        this.shell.renew(this.v, video.url, this.a, audio.url, key);
        return true;
    }

    switches(f: Format): boolean {
        return indexOf(this.videos, f) >= 0;
    }

    switchVideo(f: Format, ahead?: number, soon?: boolean, after?: boolean): void {
        var i = indexOf(this.videos, f);
        if (active === this && i >= 0) {
            // (as the player has it now: its address may be a newer one than the load sent)
            this.videos[this.v = i] = f;
            this.shell.pick('v', i, after ? 0 : soon ? SWITCH_S : ahead || SWITCH_S, this.addressOf(f), key);
        }
    }

    switchAudio(f: Format, ahead?: number): void {
        var i = indexOf(this.audios, f);
        if (active === this && i >= 0) {
            this.audios[this.a = i] = f;
            this.shell.pick('a', i, ahead || SWITCH_S, this.addressOf(f), key);
        }
    }

    /** What the shell fetches f by: its address (none by SABR: the shell's session asks for it by its id) */
    private addressOf(f: Format): string {
        return this.s.sabr ? '' : f.url;
    }

    hold(s: number): void {
        // (a live stream is not loaded ahead, as the page's own engine holds none)
        if (active === this && !this.live) {
            this.shell.hold(s);
        }
    }

    /** The shell's report of this load: the element's state from it, and the events its changes are */
    take(r: Report): void {
        if (r.dur > 0 && Math.abs(r.dur - this.length) > 0.01) {
            this.length = r.dur;
            this.fire('durationchange');
        }
        this.width = r.w;
        this.height = r.h;
        if (!this.meta && r.st !== IDLE) {
            this.meta = true;
            this.fire('loadedmetadata');
        }
        this.dropped = r.dr;
        this.frames = r.fr;
        this.countedAt = r.t;
        if (r.starts) {
            this.starts = r.starts;
        }
        if (r.dec) {
            this.decoder = r.dec;
        }
        if (r.steps) {
            note('native start', r.steps);
        }
        if (r.dl) {
            for (var i = 0; i < r.dl.length; i++) {
                this.loaded(r.dl[i][0], r.dl[i][1]);
            }
        }
        if (r.stale) {
            this.onFail('expired');
        }
        // (SABR's server: for the video's next start, as the page's own engine keeps them)
        var sabr = this.s.sabr;
        if (sabr && r.url) {
            sabr.url = r.url;
        }
        if (sabr && r.token) {
            sabr.reloadToken = r.token;
        }
        if (r.say) {
            note('native', r.say);
        }
        if (r.live) {
            this.oldest = r.live[0];
            if (r.live[1] !== this.edge) {
                this.edgeAt = r.t;
            }
            this.edge = r.live[1];
            this.head = !!r.live[2];
            this.over = this.over || !!r.live[3];
        }
        // (no failure yet: the player asks YouTube whether the stream has ended)
        if (r.stands) {
            this.onFail('stands');
        }
        if (r.err) {
            this.failed(r.err, r.text || '');
            return;
        }
        // (made before the last thing asked ran: it tells where the picture was)
        if (r.n < this.asked) {
            return;
        }
        var over = this.state === ENDED && !this.seeking;
        this.state = r.st;
        // (the time not stepped back by a report that was on its way while the clock ran)
        if (this.given - r.pos - (Date.now() - r.t) / 1000 * this.rate > BACK_S) {
            this.given = -1;
        }
        this.pos = r.pos;
        this.at = r.t;
        this.from = Math.max(Math.min(this.from, r.pos), r.pos - r.back, 0);
        var to = Math.max(r.buf, r.pos);
        var more = to !== this.to;
        this.to = to;
        this.ranges.length = to > this.from ? 1 : 0;
        var done = r.st === READY || r.st === ENDED;
        var moved = false;
        // The shell's player paused or went on by itself (the sound taken by another app, and given back)
        if (!r.pw !== this.paused) {
            this.setPaused(!r.pw);
            this.fire(this.paused ? 'pause' : 'play');
        }
        if (this.seeking && done) {
            this.seeking = false;
            this.fire('seeked');
            moved = true;
        }
        if (r.pl && !this.playing) {
            this.playing = this.moved = true;
            var self = this;
            this.timer = setInterval(function () { self.fire('timeupdate'); }, TIME_MS) as unknown as number;
            setTimeout(function () {
                if (self.playing) {
                    self.fire('timeupdate');
                }
            }, FIRST_MS);
            this.fire('playing');
            // (the player displays the element as it plays: the picture shown now, not a task later)
            this.place();
            moved = true;
            this.keepUp();
        } else if (!r.pl && this.playing) {
            this.stand();
            // (its media ran out where it plays: not a pause, a seek or the end)
            if (!this.paused && !this.seeking && !done) {
                this.fire('waiting');
            }
        }
        var ends = r.st === ENDED && !over;
        if (moved || ends) {
            this.fire('timeupdate');
        }
        if (ends) {
            this.fire('ended');
        }
        if (more) {
            this.fire('progress');
        }
    }

    /** The picture stands: the time no longer runs on, nor its event */
    private stand(): void {
        this.playing = false;
        this.given = -1;
        clearInterval(this.timer);
    }

    private failed(why: string, text: string): void {
        note('native failed', why + (text ? ': ' + text : ''));
        this.stand();
        // The shell's player itself (not the line, an address, a file or a decoder, which the page's ladder answers as
        // its own engines'): the web view's plays the videos from here on, this one started anew where it stood
        // (the account's streams alone where it was those it could not read)
        if (why === 'player') {
            if (this.s.sabr) {
                plain = true;
            } else {
                broken = true;
            }
            why = 'stalled';
        }
        this.onFail(why);
    }

    /** The element's time: the last report's (after a seek, where that went), run on by the clock while the picture
     * moves */
    private time(): number {
        if (!this.playing) {
            return this.pos;
        }
        var t = this.pos + Math.min(RUN_ON_MS, Math.max(0, Date.now() - this.at)) / 1000 * this.rate;
        if (this.length > 0) {
            t = Math.min(t, this.length);
        }
        return this.given = Math.max(t, this.given);
    }

    private seek(t: number): void {
        if (active !== this) {
            return;
        }
        t = Math.max(0, this.length > 0 ? Math.min(t, this.length) : t);
        this.stand();
        // (what is loaded there is told by the report made after it)
        this.pos = this.from = this.to = t;
        this.ranges.length = 0;
        this.seeking = true;
        this.shell.seek(t, ++this.asked);
        this.later('seeking');
    }

    /** Asked to play for MISS_MS and no picture yet */
    private overdue(): boolean {
        return !this.moved && !this.paused && Date.now() - this.playAt >= MISS_MS;
    }

    /** Paused (on) or asked to play from now; a wait for a picture already MISS_MS long while asked to play is kept
     * (late: a preview is paused as it is stopped, its wait counted as it stood then) */
    private setPaused(on: boolean): void {
        this.late = this.late || this.overdue();
        this.paused = on;
        this.playAt = Date.now();
    }

    private play(): void {
        if (this.paused && active === this) {
            this.setPaused(false);
            // (played after a pause, or a start: a live stream followed again once near its head)
            this.following = false;
            this.shell.play(++this.asked);
            this.later('play');
        }
    }

    private pause(): void {
        if (!this.paused && active === this) {
            // (the time stands where it is now; the shell's report follows)
            this.pos = this.time();
            this.stand();
            this.setPaused(true);
            this.shell.pause(++this.asked);
            this.later('pause');
            this.later('timeupdate');
        }
    }

    private setRate(rate: number): void {
        if (rate > 0 && rate !== this.rate) {
            // (the time so far ran at the old one)
            if (this.playing) {
                this.pos = this.time();
                this.at = Date.now();
            }
            this.rate = rate;
            this.shell.speed(rate);
            this.later('ratechange');
        }
    }

    private setSound(muted: boolean, sound: number): void {
        var was = this.muted ? 0 : this.sound;
        this.muted = muted;
        this.sound = sound;
        if ((muted ? 0 : sound) !== was) {
            this.shell.volume(muted ? 0 : sound);
        }
    }

    /** An event of the element's, now */
    private fire(type: string): void {
        if (active === this) {
            this.el.dispatchEvent(new Event(type));
        }
    }

    /** An event of the element's in a task of its own, as a browser fires those a call brings (play, pause, a seek) */
    private later(type: string): void {
        var self = this;
        setTimeout(function () { self.fire(type); }, 0);
    }

    /** The picture's box and whether it shows (the element displayed, in a player that shows), told to the shell, the
     * page cut for it (cut), when either changed. The player in a box of its own (a tile's preview: its video laid
     * larger than the box, which crops it): the picture's place is the element's within that box, and the page is
     * cut in the box alone, so the page itself crops the picture as the box does. On the Shorts screen (the player
     * see-through over the look's background, the Short in its upright box) the page is cut in the element's box */
    private place(): void {
        if (active !== this) {
            return;
        }
        var s = this.el.style;
        var player = this.el.parentNode as HTMLElement;
        var p = player.style;
        var box = p.width ? [px(p.left, 0), px(p.top, 0), px(p.width, 0), px(p.height, 0)] : [];
        var left = px(s.left, 0) + (box[0] || 0);
        var top = px(s.top, 0) + (box[1] || 0);
        var width = px(s.width, box.length ? box[2] : LAYOUT_WIDTH);
        var height = px(s.height, box.length ? box[3] : LAYOUT_HEIGHT);
        if (!box.length && s.width && (' ' + player.className + ' ').indexOf(' by-player--shorts ') >= 0) {
            box = [left, top, width, height];
        }
        var shown = s.display !== 'none' && p.visibility !== 'hidden';
        var now = left + ' ' + top + ' ' + width + ' ' + height + ' ' + shown + ' ' + box.join(' ');
        if (now !== this.placed) {
            this.placed = now;
            cut(shown ? box : null, player);
            this.shell.box(left, top, width, height, shown);
        }
    }

    /** The element answers for the shell's player: these members set on the element itself, over its own */
    private shadow(): void {
        var self = this;
        var nothing = function () { return undefined; };
        var all: { [name: string]: PropertyDescriptor } = {
            currentTime: { get: function () { return self.time(); }, set: function (t: number) { self.seek(t); } },
            paused: { get: function () { return self.paused; } },
            seeking: { get: function () { return self.seeking; } },
            ended: { get: function () { return self.state === ENDED && !self.seeking; } },
            duration: { get: function () { return self.length || NaN; } },
            readyState: { get: function () { return self.state === READY || self.state === ENDED ? 4 : self.meta ? 1 : 0; } },
            buffered: { get: function () { return self.ranges; } },
            playbackRate: { get: function () { return self.rate; }, set: function (rate: number) { self.setRate(rate); } },
            defaultPlaybackRate: { get: function () { return self.defaultRate; }, set: function (rate: number) { self.defaultRate = rate; } },
            muted: { get: function () { return self.muted; }, set: function (on: boolean) { self.setSound(!!on, self.sound); } },
            volume: { get: function () { return self.sound; }, set: function (v: number) { self.setSound(self.muted, v); } },
            videoWidth: { get: function () { return self.width; } },
            videoHeight: { get: function () { return self.height; } },
            error: { get: function () { return null; } },
            play: { value: function () { self.play(); } },
            pause: { value: function () { self.pause(); } },
            // (it holds nothing of its own to load)
            load: { value: nothing },
            getVideoPlaybackQuality: { value: function () { return { droppedVideoFrames: self.dropped, totalVideoFrames: self.frames, creationTime: self.countedAt }; } }
        };
        this.shadowed = Object.keys(all);
        for (var i = 0; i < this.shadowed.length; i++) {
            var as = all[this.shadowed[i]];
            as.configurable = true;
            // (a member the element only tells: a write to it is dropped, as the element's own drops it)
            if (as.get && !as.set) {
                as.set = nothing;
            }
            Object.defineProperty(this.el, this.shadowed[i], as);
        }
    }

    /** The element its own again, with the sound and speed it was given meanwhile */
    private unshadow(): void {
        var el = this.el as unknown as { [name: string]: unknown };
        for (var i = 0; i < this.shadowed.length; i++) {
            delete el[this.shadowed[i]];
        }
        this.el.muted = this.muted;
        this.el.volume = this.sound;
        this.el.defaultPlaybackRate = this.defaultRate;
        this.el.playbackRate = this.rate;
    }
}

/** What the script names on the page: the player's hook, a switch for comparing the two players, and where the shell
 * sends its reports */
interface Hook extends NativeHook {
    /** Off: every video in the web view's own player */
    on: boolean;
    take(r: Report): void;
    /** The shell's answer to hello: its key */
    unlock(k: string): void;
}

/** A video's length as its formats tell it (s; 0: none does) */
function toldLength(s: Streams): number {
    for (var i = 0; i < s.videos.length; i++) {
        if (s.videos[i].duration > 0) {
            return s.videos[i].duration;
        }
    }
    return 0;
}

/** Names BolliNative on the page where the shell has the player */
export function install(): void {
    var w = window as unknown as { BolliVideo?: VideoShell; BolliNative?: Hook };
    var shell = w.BolliVideo as VideoShell;
    // (a web view before Chrome 55 cuts no shape out of an element by clip-path, asked in the form cut() writes;
    // -webkit-clip-path showed a boxed video as noise on Android 6.0's web view 44, and the shell gives Android before
    // 7.0 no player: NativeVideo.attach. A web view that cuts shapes also has a <video>'s members on its prototype,
    // where they can be shadowed and given back. The web view's own player plays every video there)
    var css = (window as unknown as { CSS?: { supports?: (property: string, value: string) => boolean } }).CSS;
    if (!shell || !css || !css.supports || !css.supports('clip-path', 'polygon(evenodd, 0 0, 1px 0, 1px 1px)')) {
        return;
    }
    // (a page that starts anew, the app's restart: what the page before it left in the shell's player is let go)
    shell.stop();
    var hook: Hook = w.BolliNative = {
        on: true,
        engine: function (video, s, failed) {
            if (s && hook.plays(s)) {
                return new NativeEngine(video, shell, s, failed);
            }
            // The web view's own player is to play
            hook.free();
            return null;
        },
        free: function () {
            if (holding) {
                holding = false;
                clearTimeout(leaving);
                leaving = 0;
                shell.free();
            }
        },
        // (a video's own formats, a guest's or the account's, and a live stream's, whatever they are played for; not
        // a video whose formats tell no length: the shell's player would end it at once)
        plays: function (s) {
            return hook.on && !!key && !broken && !(s.sabr && plain) && (!!s.live || toldLength(s) > 0);
        },
        take: function (r) {
            // (the engine playing is the last one loaded: a report of a load before it is dropped)
            if (active && r.g === loads) {
                active.take(r);
            }
        },
        unlock: function (k) {
            key = k;
        }
    };
    shell.hello();
}

/** For the tests: as at the page's start */
export function reset(): void {
    if (active) {
        active.stop();
    }
    clearTimeout(leaving);
    leaving = missed = 0;
    broken = holding = plain = false;
    key = '';
    cutNow = '';
    sheet = null;
    hidden = [];
}

if (typeof window !== 'undefined') {
    install();
}
