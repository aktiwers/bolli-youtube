// Casting from the YouTube phone app to the app's own player. LG's DIAL
// server launches this app for "Play on TV" (appinfo dialAppName "youtube")
// and passes the phone's pairing code in contentTarget, also to a running
// app. The app acts as a YouTube lounge screen (api/lounge.ts): the phone's
// list becomes the player's queue, and the phone controls play, pause,
// seek, volume, subtitles, autoplay and arrow keys. The phone is told when
// the video or its state changes (it counts the time itself). The screen
// is registered with the DIAL server (additional data), so phones can join
// while the app runs without a new cast. The lounge opens once the first
// screen shows, or at once for a cast. A cast from YouTube Music's phone app
// (topic "music" in its launch) plays as any: YouTube's own app on the TV gets
// none while Bolli is the TV's YouTube (passing them on to it was tried on
// 2026-11-14: the phone, paired with Bolli, comes back to it first).

import { KEY } from './core/keys.js';
import { tr } from './core/i18n.js';
import { android, foundOnNetwork } from './core/platform.js';
import { toast } from './ui/toast.js';
import { prefs, setPref } from './api/prefs.js';
import { offerComments, withdrawComments } from './api/handoff.js';
import { Lounge } from './api/lounge.js';
import { aloneOf, Around, fillAll, listed } from './api/cast-list.js';
import { queueAround, videoAlone, watchFrom, watchInfo, WatchInfo } from './api/watch.js';
import { newCpn } from './api/youtube.js';
import { PlaylistInfo } from './api/feed.js';
import { ListQueue } from './player/list-queue.js';
import { OwnPlayer, Playing } from './player/own-player.js';

/** LG's DIAL server endpoint for the YouTube app's additional data (also given at launch) */
var DIAL_URL = 'http://localhost:18181/apps/YouTube/dial_data';
var KEYS: { [name: string]: number } = { UP: KEY.UP, DOWN: KEY.DOWN, LEFT: KEY.LEFT, RIGHT: KEY.RIGHT, ENTER: KEY.OK, BACK: KEY.BACK };
/** The watch page's volume button resting this long tells the phone its volume */
var VOLUME_REST_MS = 300;
/** When the phone's time differs from the player's by more than this, the player seeks there */
var JUMP_S = 3;
/** A queue the phone does not name: all its titles asked for at the cast only up to this many videos (one request each,
 * a video's whole details, ~150-200 KB; typically a few videos added on the phone); a longer one's as the list at the
 * side shows its lines, once the focus rests */
var ALONE_FILLED = 10;

type Fields = { [name: string]: string };

export class Cast {
    private lounge = new Lounge();
    /** The comments offered to the phone (YouTube's hand-off): the offer's id once given (null: none) */
    private offer: Promise<string> | null = null;
    /** Where the lounge's DIAL data is posted (LG's endpoint, else the one given at launch) */
    private dialUrl = DIAL_URL;
    /** A phone is in the lounge (state is sent only then) */
    private remotes = false;
    /** The phones in the lounge, by id (remotes: one at least, or one that cast), and whether one cast that the list
     * does not name (then a known one leaving leaves remotes on) */
    private phones: { [id: string]: boolean } = {};
    private castUnlisted = false;
    /** The phone's list (the player's queue while it plays from it), and the extra fields YouTube sent with it */
    private queue: ListQueue | null = null;
    private extra = extraOf({});
    /** What the phone was told last: video (and its cpn), state, duration */
    private told = nothingTold();
    /** The phone is told the volume once the watch page's button rests (a held key: one message) */
    private volumeTimer = 0;
    /** The phone's last commands (names, with their volume fields), for diagnosis on the TV */
    heard: string[] = [];

    /** press: a key from the phone's arrows, handled as a remote key; play: starts a video from the phone (main.ts
     * prepares the screen for the player first) */
    constructor(private player: OwnPlayer, private press: (code: number) => void, private play: (id: string, t: number, queue: ListQueue) => void,
        private info: (id: string) => Promise<WatchInfo> = watchInfo, private around: (id: string) => Promise<WatchInfo> = queueAround,
        private alone: (id: string) => Promise<WatchInfo> = videoAlone) {
        var self = this;
        this.lounge.onCommand = function (name, fields) { self.command(name, fields); };
        player.onChange = function () { self.changed(); };
        player.onVolume = function () {
            clearTimeout(self.volumeTimer);
            if (self.remotes) {
                self.volumeTimer = setTimeout(function () { self.tellVolume(); }, VOLUME_REST_MS) as unknown as number;
            }
        };
    }

    /** While video id's comments show, offers commenting on it from the phone (YouTube's hand-off, as its TV app does
     * it: the YouTube app on a phone signed in to the same account offers the comment box); null: the comments closed,
     * the offer is withdrawn */
    commentsHandoff(id: string | null): void {
        var was = this.offer;
        this.offer = null;
        if (was) {
            was.then(function (actionId) {
                if (actionId) {
                    withdrawComments(actionId).then(null, function () { return undefined; });
                }
            }, function () { return undefined; });
        }
        var screen = this.lounge.screen;
        if (id && screen.screenId) {
            this.offer = offerComments(id, screen.screenId, screen.deviceId, android() ? '' : 'LG');
            this.offer.then(null, function () { return undefined; });
        }
    }

    /** Opens the lounge (once) and registers the screen with LG's DIAL server */
    start(): void {
        var self = this;
        this.lounge.start().then(function () { self.announce(); });
    }

    /** A link code for a phone on another network ("XXX XXX XXX XXX") */
    linkCode(): Promise<string> {
        var self = this;
        return this.lounge.linkCode().then(function (code) {
            self.announce();
            return code.replace(/(\d{3})(?=\d)/g, '$1 ');
        });
    }

    /** The app was launched or relaunched with params: a cast's pairing code joins the phone */
    launched(params: { contentTarget?: unknown; target?: unknown } | null): void {
        var target = String(params && (params.contentTarget || params.target) || '');
        var q = query(target.slice(target.indexOf('?') + 1));
        // Accept only a local DIAL address: the lounge token is posted there
        if (q.additionalDataUrl && /^http:\/\/(localhost|127\.0\.0\.1)[:\/]/.test(q.additionalDataUrl)) {
            this.dialUrl = q.additionalDataUrl.replace(/\?$/, '');
        }
        if (q.pairingCode) {
            this.lounge.pair(q.pairingCode);
            this.start();
        }
    }

    /** Posts the screen's id and token to LG's DIAL server, which includes them in its answer to phones */
    private announce(): void {
        var body = this.lounge.dialData;
        if (body && foundOnNetwork()) {
            var xhr = new XMLHttpRequest();
            xhr.open('POST', this.dialUrl);
            xhr.setRequestHeader('Content-Type', 'text/plain');
            xhr.send(body);
        }
    }

    // ---- from the phone

    private command(name: string, f: Fields): void {
        var volume = f.volume !== undefined || f.delta !== undefined || f.muted !== undefined;
        this.heard = this.heard.slice(-29).concat([new Date().toTimeString().slice(0, 8) + ' ' + name +
            (volume ? ' volume ' + f.volume + ' delta ' + f.delta + ' muted ' + f.muted : '') +
            (name === 'setPlaylist' ? ' videos ' + ids(f.videoIds).length + ' list ' + (f.listId ? 'named' : 'none') : '')]);
        var p = this.player;
        var now = p.now;
        switch (name) {
            case 'loungeStatus':
                // YouTube's list of who is in the lounge (not a list: as before, by its text)
                var known = phonesOf(f.devices);
                this.phones = known || {};
                this.castUnlisted = false;
                this.remotes = known ? Object.keys(known).length > 0 : /REMOTE_CONTROL/.test(f.devices || '');
                this.tellAll();
                break;
            case 'remoteDisconnected':
                // The last one gone: nothing more is told (it was, for the rest of the session); one not known changes
                // nothing
                if (this.phones[f.id]) {
                    delete this.phones[f.id];
                    this.remotes = Object.keys(this.phones).length > 0 || this.castUnlisted;
                }
                break;
            case 'remoteConnected':
                if (f.id) {
                    this.phones[f.id] = true;
                }
                this.remotes = true;
                toast(f.name ? tr('{1} is connected to Bolli YouTube', f.name) : tr('A phone is connected to Bolli YouTube'), 'check');
                this.tellAll();
                break;
            case 'getNowPlaying':
                this.nowPlaying();
                break;
            case 'setPlaylist':
            case 'setVideo':
                this.castUnlisted = this.castUnlisted || !Object.keys(this.phones).length;
                this.remotes = true;
                this.setPlaylist(f);
                break;
            case 'updatePlaylist':
                // The phone's list changed: it becomes the queue if it contains the playing video (the playlist the
                // player shows stays the one it was, when the list is still that one)
                var list = ids(f.videoIds);
                if (now && list.indexOf(now.id) >= 0) {
                    var next = new ListQueue(list, now.id);
                    this.name(next, f.listId || this.extra.listId, this.queue && this.queue.playlist);
                    this.install(next);
                    this.fill(now.id);
                }
                this.tellList();
                break;
            case 'addVideo':
                // (the phone's list grown, or one begun with the video playing: shown as the player's playlist, the
                // watch page's row too, from now on)
                var q = this.phoneQueue();
                if (q && f.videoId) {
                    q.ids.push(f.videoId);
                    this.name(q, f.listId || this.extra.listId, q.playlist);
                    this.player.queueChanged();
                } else if (now && f.videoId) {
                    q = new ListQueue([now.id, f.videoId], now.id);
                    this.name(q, f.listId || this.extra.listId, null);
                    this.install(q);
                }
                if (now && q) {
                    this.fill(now.id);
                }
                this.tellList();
                break;
            case 'play':
                p.resume();
                break;
            case 'pause':
                p.pause();
                break;
            case 'seekTo':
                p.seekTo(parseFloat(f.currentTime || f.newTime) || 0);
                break;
            case 'stopVideo':
                p.stop();
                break;
            case 'next':
                if (now) {
                    p.next();
                }
                break;
            case 'previous':
                if (now) {
                    p.previous();
                }
                break;
            case 'setVolume':
                // The phone names the volume it wants and its change since the volume it last heard of (delta), and
                // sends some twice: the volume named is taken (a delta added per command counted its steps several
                // times: the level ran ahead of the phone's and moved in jumps); a delta alone is added
                p.setVolume(f.volume !== undefined ? +f.volume || 0 : p.volumeLevel + (+f.delta || 0),
                    f.muted !== undefined ? f.muted === 'true' : p.volumeMuted, true);
                this.tellVolume();
                break;
            case 'mute':
            case 'unMute':
                p.setVolume(p.volumeLevel, name === 'mute', true);
                this.tellVolume();
                break;
            case 'getVolume':
                this.tellVolume();
                break;
            case 'setAutoplayMode':
                setPref('autoplay', f.autoplayMode === 'ENABLED');
                this.tellAutoplay();
                break;
            case 'setSubtitlesTrack':
                // No languageCode: the phone only asks (the current choice stays); '' turns subtitles off
                if (f.languageCode !== undefined) {
                    p.chooseCaption(f.languageCode);
                }
                this.tellSubtitles();
                break;
            case 'getSubtitlesTrack':
                this.tellSubtitles();
                break;
            case 'setPlaybackRate':
            case 'setPlaybackSpeed':
                // Where the TV plays only at normal speed, the player stays at 1 (told below)
                if (+(f.playbackSpeed || f.playbackRate) > 0) {
                    p.setSpeed(+(f.playbackSpeed || f.playbackRate));
                }
                this.tellSpeed();
                break;
            case 'getPlaybackSpeed':
                this.tellSpeed();
                break;
            case 'dpadCommand':
                if (KEYS[f.key]) {
                    this.press(KEYS[f.key]);
                }
                break;
            case 'getDiscoveryDeviceId':
                this.lounge.send('setDiscoveryDeviceId', { discoveryDeviceId: this.lounge.screen.deviceId, loungeDeviceId: '' });
                break;
            case 'getPartyGamesMode':
                this.lounge.send('onPartyGamesModeChanged', { isActive: 'false' });
                break;
        }
    }

    /** Plays the phone's list from its current video (if already playing, keeps it and seeks when far off) */
    private setPlaylist(f: Fields): void {
        var list = ids(f.videoIds);
        var at = Math.max(0, Math.min(list.length - 1, parseInt(f.currentIndex, 10) || 0));
        var id = list[at] || f.videoId;
        if (!id) {
            return;
        }
        var t = parseFloat(f.currentTime) || 0;
        var now = this.player.now;
        // (the list shown before: the phone sending its queue again, another video tapped in it, keeps its titles)
        var had = this.queue && this.queue.playlist;
        var queue = this.queue = new ListQueue(list.length ? list : [id], id);
        queue.at = list.length ? at : 0;
        this.extra = extraOf(f);
        // (before the video is asked for: its request names the queue)
        this.name(queue, f.listId, had);
        if (now && now.id === id) {
            this.install(queue);
            if (Math.abs(now.t - t) > JUMP_S) {
                this.player.seekTo(t);
            }
            this.tellList();
            this.nowPlaying();
        } else {
            // The phone is told when it starts (changed)
            this.play(id, t, queue);
        }
        this.fill(id);
    }

    /** The phone's list as the player's playlist (its videos at the side, the watch page's row), where the phone sends
     * more than one video; had: the playlist of the list before this one (what is known of its videos stays). Where the
     * phone names its queue, its videos are asked for with the queue named from now on (api/watch.ts), and the titles
     * come some twenty at a time; else each video's from its own details (its id ''). */
    private name(queue: ListQueue, listId: string | undefined, had: PlaylistInfo | null): void {
        var many = queue.ids.length > 1;
        var id = many && listId || '';
        watchFrom(id ? queue.ids : [], id);
        // The same queue changed (the phone's list re-sent, grown or reordered): the same list, its videos made the new
        // ones (those known keep their titles), its views told, its titles' asking going on
        if (many && had && had.id === id && had.relist) {
            queue.playlist = had;
            had.relist(queue.ids);
            return;
        }
        var self = this;
        var ask: (one: string) => Promise<Around> = id ? this.around : function (one) {
            return self.alone(one).then(function (info) { return aloneOf(one, info); });
        };
        var list = queue.playlist = many ? listed(queue.ids, id, tr('Queue'), had, ask) : null;
        if (list && list.listen) {
            // (videos YouTube no longer has, left out of the list: out of the queue playing from it too, Next goes past
            // them)
            list.listen(function () {
                var now = self.queue;
                if (now && now.playlist === list && list!.videos.length !== now.ids.length) {
                    var kept: { [id: string]: boolean } = {};
                    list!.videos.forEach(function (v) { kept[v.id] = true; });
                    now.keep(kept);
                    self.tellList();
                }
            });
        }
        this.stopFilling();
    }

    /** The list whose titles are being asked for (once each) */
    private filling: PlaylistInfo | null = null;
    /** What stops the titles of the phone's list from being asked for */
    private stopFilling = function (): void { return undefined; };

    /** The titles of the queue's videos around video id, which YouTube sends with the video's own details (the
     * request the player makes for it: none is added), put into the playlist the player shows */
    private fill(id: string): void {
        var self = this;
        var queue = this.queue;
        var list = queue && queue.playlist;
        if (!queue || !list || !list.titles) {
            return;
        }
        // (asked a moment on: after the player's own asking for the video, which this shares; then the rest of the
        // list's, from it outward, once for the list)
        var titles = list.titles;
        var filling = this.filling !== list;
        var q = queue;
        var named = list;
        this.filling = list;
        // (a queue the phone does not name: the video's details as its answer, the rest of a short one's asked for alone)
        var byQueue = !!list.id;
        Promise.resolve().then(function () {
            return titles(id, function () {
                var info = self.info(id);
                return byQueue ? info : info.then(function (got) { return aloneOf(id, got); });
            });
        }).then(null, function () { return false; }).then(function () {
            if (filling && self.queue === q && q.playlist === named && (named.id || q.ids.length <= ALONE_FILLED)) {
                self.stopFilling = fillAll(named, Math.max(0, q.ids.indexOf(id)));
            }
        });
    }

    /** Makes the phone's list the player's queue (the video playing's playlist follows it: the watch page's row) */
    private install(queue: ListQueue): void {
        this.queue = this.player.queue = queue;
        this.player.queueChanged();
    }

    /** The phone's list while the player plays from it (null: another video was picked on the TV since) */
    private phoneQueue(): ListQueue | null {
        return this.queue && this.player.queue === this.queue ? this.queue : null;
    }

    // ---- to the phone

    /** Playback changed: tells the phone (new video: nowPlaying and list ends; duration known: nowPlaying; else the
     * state) */
    private changed(): void {
        // A video picked on the TV (with its own queue or none) drops the phone's list
        if (this.queue && !this.phoneQueue()) {
            this.queue = null;
            this.extra = extraOf({});
            watchFrom([], '');
            this.stopFilling();
        }
        var now = this.player.now;
        if (!now) {
            if (this.told.id) {
                this.told = nothingTold();
                if (this.remotes) {
                    this.lounge.send('nowPlaying');
                }
            }
            return;
        }
        if (!this.remotes) {
            return;
        }
        if (now.id !== this.told.id) {
            this.nowPlaying();
            this.tellList();
            this.fill(now.id);
        } else if (now.duration && !this.told.duration) {
            this.nowPlaying();
        } else if (stateOf(now) !== this.told.state) {
            this.stateChange();
        }
        this.tellAutoplayNext();
        if (this.player.playbackSpeed !== this.told.speed) {
            this.tellSpeed();
        }
    }

    private tellSpeed(): void {
        this.told.speed = this.player.playbackSpeed;
        this.lounge.send('onPlaybackSpeedChanged', { playbackSpeed: String(this.told.speed) });
    }

    /** What Autoplay plays next, and its countdown starting or dismissed (as YouTube's TV app tells the phone) */
    private tellAutoplayNext(): void {
        var p = this.player;
        var next = p.autoplayNext;
        var id = next ? next.id : '';
        if (id !== this.told.next) {
            this.told.next = id;
            this.lounge.send('autoplayUpNext', id ? { videoId: id } : {});
        }
        var counting = p.upNextVideo;
        var countingId = counting ? counting.id : '';
        if (countingId !== this.told.counting) {
            if (countingId) {
                this.lounge.send('nowAutoplaying', { videoId: countingId, timeout: String(prefs().autoplayWait) });
            } else if (!p.now || p.now.id !== this.told.counting) {
                // Cancelled, not played
                this.lounge.send('autoplayDismissed', {});
            }
            this.told.counting = countingId;
        }
    }

    /** The playing video's fields in the lounge's format */
    private fields(): Fields {
        var now = this.player.now;
        if (!now) {
            return {};
        }
        if (now.id !== this.told.id) {
            this.told.cpn = newCpn();
        }
        this.told.id = now.id;
        this.told.state = stateOf(now);
        this.told.duration = now.duration;
        return {
            videoId: now.id, currentTime: now.t.toFixed(3), duration: now.duration.toFixed(3), state: String(this.told.state),
            cpn: this.told.cpn, loadedTime: now.loaded.toFixed(3), seekableStartTime: '0', seekableEndTime: now.duration.toFixed(3)
        };
    }

    private nowPlaying(): void {
        var f = this.fields();
        // The index in the phone's list, while one of its videos plays
        var q = this.phoneQueue();
        if (f.videoId && q && q.ids[q.at] === f.videoId) {
            f.currentIndex = String(q.at);
            for (var name in this.extra) {
                f[name] = this.extra[name];
            }
        }
        this.lounge.send('nowPlaying', f);
    }

    private stateChange(): void {
        var f = this.fields();
        if (f.videoId) {
            delete f.videoId;
            f.playabilityStatus = 'OK';
            this.lounge.send('onStateChange', f);
        }
    }

    /** Everything the phone needs on joining */
    private tellAll(): void {
        this.tellList();
        this.nowPlaying();
        this.stateChange();
        this.tellAutoplay();
        this.tellVolume();
    }

    /** Whether the player's queue (the phone's list, a mix) has a previous and next video */
    private tellList(): void {
        var q = this.player.queue;
        this.lounge.send('onHasPreviousNextChanged', { hasPrevious: String(!!q && q.at > 0), hasNext: String(!!q && q.at < q.ids.length - 1) });
    }

    private tellAutoplay(): void {
        this.lounge.send('onAutoplayModeChanged', { autoplayMode: prefs().autoplay ? 'ENABLED' : 'DISABLED' });
    }

    private tellVolume(): void {
        this.lounge.send('onVolumeChanged', { volume: String(this.player.volumeLevel), muted: String(this.player.volumeMuted) });
    }

    private tellSubtitles(): void {
        var now = this.player.now;
        this.lounge.send('onSubtitlesTrackChanged', { videoId: now ? now.id : '', languageCode: this.player.captionLanguage });
    }
}

/** The launch parameters: a relaunch's (given), else the initial launch's (webOS keeps them as JSON) */
export function launchParams(given: unknown): { contentTarget?: unknown; target?: unknown } | null {
    if (given && typeof given === 'object') {
        return given as { contentTarget?: unknown };
    }
    var w = window as unknown as { PalmSystem?: { launchParams?: string }; launchParams?: string };
    try {
        return JSON.parse((w.PalmSystem && w.PalmSystem.launchParams) || w.launchParams || 'null');
    } catch (e) {
        return null;
    }
}

/** A query string's decoded fields */
function query(text: string): Fields {
    var out: Fields = {};
    text.split('&').forEach(function (part) {
        var at = part.indexOf('=');
        if (at > 0) {
            try {
                out[decodeURIComponent(part.slice(0, at))] = decodeURIComponent(part.slice(at + 1).replace(/\+/g, ' '));
            } catch (e) {
                // Malformed: skipped
            }
        }
    });
    return out;
}

/** The lounge's state code: 0 ended, 1 playing, 2 paused, 3 loading or buffering */
function stateOf(now: Playing): number {
    return now.ended ? 0 : now.waiting ? 3 : now.paused ? 2 : 1;
}

/** Nothing told yet: no video, no state, no Autoplay video or countdown, normal speed */
function nothingTold(): { id: string; cpn: string; state: number; duration: number; next: string; counting: string; speed: number } {
    return { id: '', cpn: '', state: -2, duration: 0, next: '', counting: '', speed: 1 };
}

/** The extra fields YouTube sent with the phone's list (echoed back in nowPlaying) */
function extraOf(f: Fields): Fields {
    return { listId: f.listId || '', ctt: f.ctt || '', params: f.params || '', playerParams: f.playerParams || '' };
}

/** Video ids from "a,b,c" */
function ids(text: string | undefined): string[] {
    return (text || '').split(',').filter(function (id) { return /^[\w-]{11}$/.test(id); });
}

/** The phones (remote controls) in a lounge's device list (JSON), by id */
function phonesOf(devices: string | undefined): { [id: string]: boolean } | null {
    var phones: { [id: string]: boolean } = {};
    try {
        (JSON.parse(devices || '[]') as { type?: string; id?: string }[]).forEach(function (d) {
            if (d && d.type === 'REMOTE_CONTROL' && d.id) {
                phones[d.id] = true;
            }
        });
    } catch (e) {
        // Not a list
        return null;
    }
    return phones;
}
