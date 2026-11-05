// Plays videos in YouTube's own TV app (youtube.com/tv, as YouTube AdFree does), hidden in
// this app and shown over it while a video plays. /tv cannot be framed, so its HTML
// (api/youtube.ts tvPage) is written by a second youtube.com page (robots.txt) into an empty
// frame of its own: that frame takes youtube.com's address and origin and parses HTML
// (robots.txt itself keeps its text parser: quirks mode). The app sends the YouTube app's
// user agent (appinfo.json, as YouTube AdFree does); with webOS's own, YouTube serves a
// build without its icon font.
//
// pageHooks (player/tv-page.ts) runs in the page before YouTube's code: ad hooks, a quiet mode (no playback, no
// playback reports), and commands run by the page's own timer; events come back by
// postMessage. Phases: off, loading, warming (started on a video, or idle not hooked yet;
// quiet, until it loads and the command handler is hooked), idle (player emptied: a paused video left in it froze the
// app ~1 s every 5 s, garbage collection), opening, playing (shown, keys go to YouTube).
// Each waiting phase has a deadline. Videos open with _yttv's resolveCommand (as YouTube
// AdFree and TizenTube do); "Who's watching?" is skipped as YouTube AdFree's auto account
// select does; SponsorBlock segments (api/sponsorblock.ts) are skipped with a toast.

import { h, setShown } from '../../core/dom.js';
import { mark, noteZap } from '../../core/perf.js';
import { FillLoader, LOGO } from '../ui/fill-loader.js';
import { note } from './play-log.js';
import { PROBLEM, skipEdge, toast } from '../ui/toast.js';
import { prefs } from '../api/prefs.js';
import { Segment, segmentAt, segments, skippedText } from '../api/sponsorblock.js';
import { PAGE, TvPage, tvPage, usable } from '../api/youtube.js';
import { MediaState, pageHooks } from './tv-page.js';

/** Warm-up video the player starts on: "Me at the zoo", YouTube's first upload (19 s) */
var WARM_UP = 'jNQXAC9IVRw';
/** Deadlines: page loaded and written; warmed up; video loading (else asked again); video playing (else given up) */
var LOADING_MS = 20000;
var WARMING_MS = 25000;
/** After a start failed, a start only to have it ready (a film tile rested on) waits this long: if YouTube broke the
 * hook, each one costs up to three loads of its app (~60 MB, the TV's one core busy) while browsing */
var FAILED_REST_MS = 10 * 60 * 1000;
var OPEN_RETRY_MS = 8000;
var OPEN_GIVE_UP_MS = 30000;
/** Typical cold start (OK to picture, ~13 s): the loading sign fills over it up to WAIT_MOST, then to WAIT_ASKED once
 * the video's first data is requested */
var COLD_MS = 13000;
var WAIT_MOST = 0.8;
var WAIT_ASKED = 0.9;
/** Poll interval for a film's watch page while YouTube's page starts on it */
var FILM_POLL_MS = 500;
/** Max restarts within RESTARTS_MS (then it gives up; the next video tries again) */
var MAX_RESTARTS = 3;
var RESTARTS_MS = 2 * 60 * 1000;
/** A YouTube video id (watch?v=); nothing else is passed into its commands */
var VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

type Phase = 'off' | 'loading' | 'warming' | 'idle' | 'opening' | 'playing';

interface Want {
    id: string;
    /** Start time (s; 0: YouTube's default) */
    t: number;
    /** Called when it stops (Back pressed in it, or the wait for it ended) */
    back: () => void;
    /** A film: YouTube's screen for it counts as shown (one without a trailer shows only Buy or rent, no video, so it
     * never fails as "did not start") */
    film?: boolean;
}

export class TvApp {
    /** Shown over the app (a video) */
    shown = false;
    /** Called when it shows or hides */
    onShown: (shown: boolean) => void = function () { return undefined; };
    /** Called when the account it plays as may have changed (on its start) */
    onAccount: () => void = function () { return undefined; };
    /** Called when it starts (its warm-up video takes the TV's video decoder) */
    onStart: () => void = function () { return undefined; };
    private el: HTMLIFrameElement;
    private phase: Phase = 'off';
    /** The video wanted (shown, or waiting for the player to be ready) */
    private want: Want | null = null;
    /** A video stopped by the app going to the background, played again when it comes back */
    private resume: Want | null = null;
    private page: TvPage | null = null;
    /** Warming: command handler hooked; warm-up video loaded (home: loaded on YouTube's Home instead, where its newer
     * app starts whatever the address asks) */
    private hooked = false;
    private warm = false;
    private home = false;
    /** When OK was pressed; whether the video began loading; its first deadline passed */
    private askedAt = 0;
    private loading = false;
    private checked = false;
    /** The playing video's last position (to resume it) */
    private at = 0;
    private segments: Segment[] = [];
    private skipped: { [index: number]: boolean } = {};
    /** The last preloaded video (one requested before the player is ready is preloaded once it is) */
    private preloaded = '';
    /** The video the page started on (warm-up or wanted; its loadedmetadata means warm), and the wanted video it
     * started for, while still wanted ('' otherwise) */
    private startedOn = WARM_UP;
    private startedFor = '';
    /** Times of recent restarts, and when a start last failed */
    private restarts: number[] = [];
    private failedAt = 0;
    /** Warming only to wait for the command handler (it was idle): stopped, it is idle again */
    private hookWait = false;
    /** Start counter (a late answer for an earlier start, shut down since, is ignored) */
    private starts = 0;

    private timer = 0;
    /** While it starts for a video: a black screen with the app's filling loading sign (created on first use) */
    private wait: HTMLElement | null = null;
    private loader: FillLoader | null = null;
    private waitTimer = 0;

    /** parent: where its frame is added on first start (adding it up front cost ~34 ms of app start) */
    constructor(private parent: HTMLElement) {
        this.el = document.createElement('iframe');
        // Scripts run with youtube.com's origin; it cannot navigate the app's window
        this.el.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
        this.el.className = 'by-tv';
        setShown(this.el, false);
        var self = this;
        window.addEventListener('message', function (e: MessageEvent) {
            if (e.source === self.tvWindow() && e.data && e.data.bolli) {
                self.event(e.data.bolli, e.data.value);
            }
        });
        this.el.onload = function () {
            self.loaded();
        };
        // The app's window loses the focus when the frame takes it
        window.addEventListener('blur', function () {
            setTimeout(function () { self.keys(); }, 0);
        });
        document.addEventListener('visibilitychange', function () {
            self.visibility();
        });
    }

    /** A video is wanted (keys wait while it starts, Back cancels it; shown, they go to its page) */
    get busy(): boolean {
        return !!this.want;
    }

    /** The video it plays or opens ('' none) */
    get video(): string {
        return this.want ? this.want.id : '';
    }

    /** It is starting (its warm-up video may hold the TV's decoder) */
    get warming(): boolean {
        return this.phase === 'loading' || this.phase === 'warming';
    }

    /** Its player is ready: a video opens at once */
    get ready(): boolean {
        return this.phase === 'idle' || this.phase === 'opening' || this.phase === 'playing';
    }

    /** Starts YouTube's TV app (once; again after a failure; ahead: only to have it ready, not within FAILED_REST_MS of
     * a failure) */
    start(ahead?: boolean): void {
        if (this.phase !== 'off' || ahead && Date.now() - this.failedAt < FAILED_REST_MS) {
            return;
        }
        this.phase = 'loading';
        // Only restarts after this start count toward MAX_RESTARTS
        this.restarts = [];
        var self = this;
        var start = ++this.starts;
        tvPage().then(function (page) {
            // Shut down or started again meanwhile: ignore
            if (self.phase !== 'loading' || start !== self.starts) {
                return;
            }
            self.page = page;
            self.restart();
        }, function () {
            if (self.phase === 'loading') {
                self.fail('YouTube did not answer. Try again in a moment.');
            }
        });
    }

    /** Plays the video full screen once the player is ready (t: start, s; film: Want.film); false: not a video id */
    play(id: string, back: () => void, t?: number, film?: boolean): boolean {
        if (!VIDEO_ID.test(id)) {
            return false;
        }
        this.want = { id: id, t: t || 0, back: back, film: film };
        note('YouTube\'s player', id + ' (' + this.phase + ')');
        this.resume = null;
        this.track(id, film);
        this.at = t || 0;
        this.askedAt = Date.now();
        (window as any).__bolli.steps = {};
        if (this.phase === 'idle' && this.hooked) {
            this.open();
        } else if (this.phase === 'idle') {
            // Ready without the command handler (it started on a video, shown as it loaded): an open would go unheard;
            // it opens once the handler is hooked (warmedUp), else the app starts afresh
            this.phase = 'warming';
            this.hookWait = true;
            this.deadline(WARMING_MS, 'warming');
            this.view();
        } else {
            this.start();
            // Already starting: show the loading sign now
            this.view();
        }
        return true;
    }

    /** A remote key for YouTube's player while it shows (one that came through the app: Android's remote, a phone's
     * d-pad; webOS's remote goes to its frame itself) */
    key(code: number): void {
        this.call('key', code);
    }

    /** Preloads a video for a faster start (one at a time; while the player starts, once it is ready) */
    preload(id: string): void {
        if (!VIDEO_ID.test(id) || id === this.preloaded || this.want) {
            return;
        }
        this.preloaded = id;
        if (this.phase === 'idle') {
            this.call('preload', id);
        }
    }

    /** Shuts down (not while shown or a video is wanted), releasing its page's memory and CPU (even idle, it froze
     * the app for up to 1.4 s every few seconds); start() starts it afresh */
    shutDown(): void {
        if (this.want || this.phase === 'off') {
            return;
        }
        clearTimeout(this.timer);
        this.phase = 'off';
        this.preloaded = '';
        this.release();
    }

    /** Lets its page go: the frame is taken out with no address (restart adds it again, as on the first start). Not
     * sent to about:blank: a frame loading while the app is in the background makes the TV report the app as shown
     * again, and it would then miss its own return */
    private release(): void {
        if (this.el.parentNode) {
            this.el.parentNode.removeChild(this.el);
        }
        this.el.removeAttribute('src');
    }

    /** Stops the video (player emptied) or the wait for it; the keys return to the app */
    stop(): void {
        var was = this.want;
        this.want = null;
        this.resume = null;
        // Started on it and still starting: quiet and pause it now, else it plays on unseen (it is emptied once warm,
        // i.e. on loadedmetadata)
        if (this.phase === 'warming' && this.hookWait) {
            this.idle();
        }
        if (this.phase === 'warming' && this.startedFor) {
            this.startedFor = '';
            this.setFlag('__bolliQuiet', true);
            this.call('pause');
            // Page not written yet: it starts quiet
            var host = this.el.contentWindow as any;
            if (host) {
                host.__bolliNoStart = true;
            }
        }
        if (this.phase === 'opening' || this.phase === 'playing') {
            this.idle();
        }
        this.view();
        if (was) {
            was.back();
        }
    }

    // ---- the page and its events

    private event(type: string, value: unknown): void {
        var m = value as MediaState;
        switch (type) {
            case 'hooked':
                this.hooked = true;
                this.warmedUp();
                return;
            case 'back':
                if (this.want) {
                    this.stop();
                }
                return;
        }
        if (this.phase === 'warming' && type === 'loadstart' && this.loader && this.want && m.route.indexOf('v=' + this.want.id) >= 0) {
            this.loader.step(WAIT_ASKED);
        }
        if (this.phase === 'warming' && type === 'loadedmetadata') {
            this.warm = true;
            this.home = m.route.indexOf('v=' + this.startedOn) < 0;
            this.warmedUp();
        } else if (this.phase === 'idle' && type === 'loadstart') {
            // Something loads with no video wanted (a late start after Back): empty it
            this.call('empty');
        } else if ((this.phase === 'opening' || this.phase === 'playing') && this.want && m.route.indexOf('v=' + this.want.id) >= 0) {
            this.media(type, m);
        } else if (this.phase === 'playing' && this.want) {
            // Another video in YouTube's app (its Up next, or a related one picked there): follow it, fetch its segments
            var other = /[?&]v=([\w-]{11})/.exec(m.route);
            if (other) {
                this.follow(other[1]);
                this.media(type, m);
            }
        }
    }

    /** YouTube's app moved on to another video: follow that one */
    private follow(id: string): void {
        (this.want as Want).id = id;
        this.track(id);
    }

    /** Follows video id from its start, with its SponsorBlock segments (a film has none) */
    private track(id: string, film?: boolean): void {
        var self = this;
        this.at = 0;
        this.segments = [];
        this.skipped = {};
        if (!film) {
            segments(id, prefs().skip).then(function (list) {
                if (self.want && self.want.id === id) {
                    self.segments = list;
                }
            });
        }
    }

    /** The wanted video's media events: times its start, keeps its position, skips SponsorBlock segments */
    private media(type: string, m: MediaState): void {
        var steps = (window as any).__bolli.steps;
        if (this.phase === 'opening') {
            steps[type] = steps[type] || Date.now() - this.askedAt;
            if (type === 'loadstart') {
                this.loading = true;
            }
            if (type === 'timeupdate' && m.t > 0 && !m.paused) {
                steps.moving = Date.now() - this.askedAt;
                noteZap((this.want as Want).id, steps.moving);
                this.phase = 'playing';
                clearTimeout(this.timer);
            }
            return;
        }
        if (type === 'timeupdate') {
            this.at = m.t;
            var at = segmentAt(this.segments, m.t, this.skipped);
            if (at >= 0) {
                this.skipped[at] = true;
                this.call('seek', this.segments[at].end);
                toast(skippedText(this.segments[at]), undefined, skipEdge(this.segments[at].category));
            }
        }
    }

    /** The frame loaded robots.txt (to write YouTube's page into), or YouTube's page loaded in it */
    private loaded(): void {
        var page = this.tvWindow();
        if (this.phase === 'loading') {
            // Not usable (not youtube.com's robots.txt: an error page): the loading deadline starts it afresh
            var w = usable(this.el);
            if (w) {
                this.write(w);
            }
        } else if (this.phase !== 'off' && !(page && page.__bolliPage)) {
            // YouTube's page without the hooks (it reloaded itself): restart
            this.restart();
        }
    }

    /** Writes YouTube's page, hooks first, into an empty frame in robots.txt, by robots.txt's own timer (the frame
     * takes its address, changed to YouTube's first) */
    private write(w: any): void {
        var tv = this.page as TvPage;
        // A video wanted at the first start: start on it, so it plays as the page starts (going through the warm-up
        // video first cost ~11 s before the video was even requested); a restart after a failure uses the warm-up video
        var want = this.restarts.length === 1 ? this.want : null;
        this.startedOn = want ? want.id : WARM_UP;
        this.startedFor = want ? want.id : '';
        if (want) {
            this.quality();
        }
        var hooks = '<script>(' + pageHooks.toString() + ')(' + !!want + ');<\/script>';
        // At the start of <head>; without a head (HTML5 allows it), at the start of the document
        var html = /<head[^>]*>/i.test(tv.html) ? tv.html.replace(/<head[^>]*>/i, function (head) { return head + hooks; }) : hooks + tv.html;
        var self = this;
        w.__bolliHtml = html;
        w.__bolliNoStart = false;
        w.__bolliLoaded = function () {
            self.loaded();
        };
        this.phase = 'warming';
        this.hooked = false;
        this.warm = false;
        this.home = false;
        this.deadline(WARMING_MS, 'warming');
        // Full animation, as YouTube AdFree starts it (YouTube reads env_forceFullAnimation from the URL)
        if (want && want.film) {
            this.watchForFilm();
        }
        this.inWindow(w, 'history.replaceState(null, "", ' + JSON.stringify('/tv?env_forceFullAnimation=1#/watch?v=' + this.startedOn) + ');' +
            'var f = document.createElement("iframe");' +
            'f.style.cssText = "position: fixed; left: 0; top: 0; width: 100%; height: 100%; border: 0; background: #000";' +
            'document.body.appendChild(f); window.__bolliFrame = f;' +
            'var html = window.__bolliHtml; window.__bolliHtml = null;' +
            'var d = f.contentWindow.document; d.open(); d.write(html); d.close();' +
            'f.onload = function () { window.__bolliLoaded(); };');
    }

    /** The window YouTube's page is written into (null until then) */
    private tvWindow(): any {
        var w = this.el.contentWindow as any;
        var f = w && w.__bolliFrame;
        return f ? f.contentWindow : null;
    }

    /** Warm once the command handler is hooked and the start video has loaded: the wanted video shows as it is;
     * otherwise idle, and a waiting video opens */
    private warmedUp(): void {
        if (this.home) {
            // Not on the start video: the wanted one is opened by command (so the handler must be hooked)
            this.startedFor = '';
        }
        var started = !!this.want && this.want.id === this.startedFor;
        // Started on the wanted video: shown once loaded, without waiting for the command handler (else it plays on
        // unseen until that is found)
        if (this.phase === 'warming' && (this.hooked || started) && this.warm) {
            mark('tvReady');
            this.startedFor = '';
            if (!started) {
                this.idle();
            }
            this.onAccount();
            if (this.want) {
                this.open(started);
            } else if (this.preloaded) {
                this.call('preload', this.preloaded);
            }
        }
    }

    /** No video: quiet, the player emptied, hidden */
    private idle(): void {
        clearTimeout(this.timer);
        this.phase = 'idle';
        this.hookWait = false;
        this.setFlag('__bolliQuiet', true);
        this.call('empty');
        this.view();
    }

    /** Opens the wanted video in YouTube's app and shows it (started: the page started on it and it is loading
     * already; only seek to the wanted time) */
    private open(started?: boolean): void {
        var want = this.want as Want;
        this.phase = 'opening';
        this.preloaded = '';
        this.loading = !!started;
        this.checked = false;
        (window as any).__bolli.steps.open = Date.now() - this.askedAt;
        if (!started) {
            this.quality();
            this.call('open', { id: want.id, t: want.t });
        } else if (want.t) {
            this.call('seek', want.t);
        }
        this.deadline(OPEN_RETRY_MS, 'opening');
        this.view();
    }

    /** Sets the quality YouTube's player starts at (Settings) through its own stored choice, as its player menu
     * writes it (yt-player-quality, honoured for 30 days after creation: written anew each time); Auto: left to
     * YouTube */
    private quality(): void {
        var q = prefs().quality;
        var w = this.el.contentWindow as any;
        if (!q) {
            return;
        }
        try {
            var now = Date.now();
            w.localStorage.setItem('yt-player-quality', JSON.stringify({
                data: JSON.stringify({ quality: q, previousQuality: q }),
                expiration: now + 360 * 24 * 3600 * 1000,
                creation: now
            }));
        } catch (e) {
            // Its storage not readable: YouTube picks
        }
    }

    /** Restarts: the frame loads youtube.com's page again (a wanted video waits for it) */
    private restart(): void {
        var now = Date.now();
        this.restarts = this.restarts.filter(function (at) { return now - at < RESTARTS_MS; });
        if (this.restarts.length >= MAX_RESTARTS) {
            this.fail('YouTube\'s player does not start. Try again in a moment.');
            return;
        }
        this.restarts.push(now);
        mark('tvRestart');
        // Quiet the old page now (else its video plays on while robots.txt loads)
        this.setFlag('__bolliQuiet', true);
        this.call('pause');
        this.phase = 'loading';
        this.deadline(LOADING_MS, 'loading');
        this.onStart();
        if (!this.el.parentNode) {
            this.parent.appendChild(this.el);
        }
        this.el.src = PAGE;
        this.view();
    }

    /** Start failed: off (the next video tries again); a waiting video is given up */
    private fail(text: string): void {
        clearTimeout(this.timer);
        this.phase = 'off';
        this.failedAt = Date.now();
        // Release its page (else YouTube's app runs on hidden without the hooks, and could play and report unseen)
        this.preloaded = '';
        this.restarts = [];
        this.release();
        if (this.want) {
            toast(text, undefined, PROBLEM);
            this.stop();
        }
        this.view();
    }

    /** A phase's deadline: loading and warming start afresh; an open is asked once more, then given up */
    private deadline(ms: number, phase: Phase): void {
        clearTimeout(this.timer);
        var self = this;
        this.timer = setTimeout(function () {
            if (self.phase !== phase) {
                return;
            }
            if (phase !== 'opening') {
                self.restart();
            } else if (self.want && self.want.film) {
                // A film: YouTube's screen for it shows (maybe only Buy or rent, no video): neither retried nor given up
                return;
            } else if (!self.checked) {
                // Not loading yet: ask once more; either way it gets until OPEN_GIVE_UP_MS
                self.checked = true;
                if (!self.loading) {
                    self.call('open', { id: (self.want as Want).id, t: (self.want as Want).t });
                }
                self.deadline(OPEN_GIVE_UP_MS - OPEN_RETRY_MS, 'opening');
            } else {
                toast('The video did not start.', undefined, PROBLEM);
                self.stop();
            }
        }, ms) as unknown as number;
    }

    // ---- what shows, and who gets the keys

    /** Shown while a video is opening or playing; the keys go with it. While a video waits for the start: the loading
     * sign over the app */
    private view(): void {
        var shown = (this.phase === 'opening' || this.phase === 'playing') && !!this.want;
        this.waiting(!!this.want && (this.phase === 'loading' || this.phase === 'warming'));
        this.setFlag('__bolliShown', shown);
        if (shown !== this.shown) {
            this.shown = shown;
            setShown(this.el, shown);
            this.onShown(shown);
        }
        this.keys();
    }

    /** Shows the loading sign (filling over a cold start's typical time) or hides it */
    private waiting(on: boolean): void {
        if (on === !!this.waitTimer) {
            return;
        }
        clearInterval(this.waitTimer);
        this.waitTimer = 0;
        if (!on) {
            if (this.wait) {
                setShown(this.wait, false);
                (this.loader as FillLoader).hide();
            }
            return;
        }
        if (!this.wait) {
            this.wait = h('div', 'by-tv-wait');
            this.loader = new FillLoader(this.wait, false);
            this.parent.appendChild(this.wait);
        }
        var loader = this.loader as FillLoader;
        var from = this.askedAt;
        setShown(this.wait, true);
        loader.show(LOGO, 0.05);
        var self = this;
        this.waitTimer = setInterval(function () {
            var fill = (Date.now() - from) / COLD_MS;
            loader.step(Math.min(WAIT_MOST, fill));
            // Time alone fills it to WAIT_MOST; the rest follows the video's data
            if (fill >= WAIT_MOST) {
                clearInterval(self.waitTimer);
            }
        }, 500) as unknown as number;
    }

    /** Keys go to YouTube while it shows, else to the app (YouTube focuses its own screen as it starts, so the remote would drive it unseen) */
    private keys(): void {
        if (this.shown) {
            if (document.activeElement !== this.el) {
                this.el.focus();
                var w = this.el.contentWindow as any;
                var page = this.tvWindow();
                if (page) {
                    w.__bolliFrame.focus();
                    page.focus();
                } else {
                    w.focus();
                }
            }
        } else if (document.activeElement === this.el) {
            this.el.blur();
            window.focus();
        }
    }

    /** Sent to the background, a video stops; back in front, it resumes where it was */
    private visibility(): void {
        if (document.hidden) {
            // Opening or waiting to open: stopped too, else it plays unseen; it resumes from its start time (as a film
            // if it is one)
            if (this.want) {
                var resume = this.want;
                if (this.phase === 'playing') {
                    resume.t = this.at;
                }
                this.stop();
                this.resume = resume;
            } else {
                // Only warm (a film tile rested on): its ~60 MB go; a film's tile warms it again
                this.shutDown();
            }
        } else if (this.resume) {
            var r = this.resume;
            this.resume = null;
            this.play(r.id, r.back, r.t, r.film);
        }
    }

    // ---- into the page

    /** A command of the page's (pageHooks __bolliPage), run by its own timer */
    private call(name: string, arg?: unknown): void {
        // Run by YouTube's page itself (a timer of its own), so YouTube's code there resolves its addresses against
        // youtube.com
        this.inWindow(this.tvWindow(), 'var p = window.__bolliPage; if (p) { p.' + name + '(' + (arg === undefined ? '' : JSON.stringify(arg)) + '); }');
    }

    /** Code run by a youtube.com page's own timer */
    private inWindow(w: any, code: string): void {
        if (w) {
            w.setTimeout(new w.Function(code), 0);
        }
    }

    /** Started on a film: warm once its video has loaded, or once YouTube's watch page for it has drawn (a film without
     * a trailer loads no video, only Buy or rent); polled every FILM_POLL_MS while it starts */
    private watchForFilm(): void {
        var self = this;
        var poll = setInterval(function () {
            var want = self.want;
            var w = self.tvWindow();
            if (self.phase !== 'warming' || !want || want.id !== self.startedFor) {
                clearInterval(poll);
                return;
            }
            var watch = w && w.location.hash.indexOf('v=' + want.id) >= 0 ? w.document.querySelector('ytlr-watch-page') : null;
            if (watch && String(watch.textContent).trim()) {
                clearInterval(poll);
                self.warm = true;
                self.warmedUp();
            }
        }, FILM_POLL_MS);
    }

    /** A flag the page reads (a plain value: set at once, no timer needed) */
    private setFlag(name: string, on: boolean): void {
        var w = this.tvWindow();
        if (w && w.__bolliPage) {
            w[name] = on;
        }
    }
}
