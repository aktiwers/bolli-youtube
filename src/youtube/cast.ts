// Casting from the YouTube phone app to the app's own player. LG's DIAL
// server launches this app for "Play on TV" (appinfo dialAppName "youtube")
// and passes the phone's pairing code in contentTarget, also to a running
// app. The app acts as a YouTube lounge screen (api/lounge.ts): the phone's
// list becomes the player's queue, and the phone controls play, pause,
// seek, volume, subtitles, autoplay and arrow keys. The phone is told when
// the video or its state changes (it counts the time itself). The screen
// is registered with the DIAL server (additional data), so phones can join
// while the app runs without a new cast. The lounge opens once the first
// screen shows, or at once for a cast.

import { KEY } from '../core/keys.js';
import { android } from '../core/platform.js';
import { toast } from './ui/toast.js';
import { prefs, setPref } from './api/prefs.js';
import { offerComments, withdrawComments } from './api/handoff.js';
import { Lounge } from './api/lounge.js';
import { newCpn } from './api/youtube.js';
import { ListQueue, OwnPlayer, Playing } from './player/own-player.js';

/** LG's DIAL server endpoint for the YouTube app's additional data (also given at launch) */
var DIAL_DATA = 'http://localhost:18181/apps/YouTube/dial_data';
var KEYS: { [name: string]: number } = { UP: KEY.UP, DOWN: KEY.DOWN, LEFT: KEY.LEFT, RIGHT: KEY.RIGHT, ENTER: KEY.OK, BACK: KEY.BACK };
/** When the phone's time differs from the player's by more than this, the player seeks there */
var JUMP_S = 3;

type Fields = { [name: string]: string };

export class Cast {
    private lounge = new Lounge();
    /** The comments offered to the phone (YouTube's hand-off): the offer's id once given (null: none) */
    private offer: Promise<string> | null = null;
    private dialData = DIAL_DATA;
    /** A phone is in the lounge (state is sent only then) */
    private remotes = false;
    /** The phone's list (the player's queue while it plays from it), and the extra fields YouTube sent with it */
    private queue: ListQueue | null = null;
    private extra = extraOf({});
    /** What the phone was told last: video (and its cpn), state, duration */
    private told = nothingTold();
    private volume = 100;
    private muted = false;
    /** The phone's last commands (names, with their volume fields), for diagnosis on the TV */
    heard: string[] = [];

    /** press: a key from the phone's arrows, handled as a remote key; play: starts a video from the phone (main.ts
     * prepares the screen for the player first) */
    constructor(private player: OwnPlayer, private press: (code: number) => void, private play: (id: string, t: number, queue: ListQueue) => void) {
        var self = this;
        this.lounge.onCommand = function (name, fields) { self.command(name, fields); };
        player.onChange = function () { self.changed(); };
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
            this.dialData = q.additionalDataUrl.replace(/\?$/, '');
        }
        if (q.pairingCode) {
            this.lounge.pair(q.pairingCode);
            this.start();
        }
    }

    /** Posts the screen's id and token to LG's DIAL server, which includes them in its answer to phones */
    private announce(): void {
        var body = this.lounge.dialData;
        if (body) {
            var xhr = new XMLHttpRequest();
            xhr.open('POST', this.dialData);
            xhr.setRequestHeader('Content-Type', 'text/plain');
            xhr.send(body);
        }
    }

    // ---- from the phone

    private command(name: string, f: Fields): void {
        var volume = f.volume !== undefined || f.delta !== undefined || f.muted !== undefined;
        this.heard = this.heard.slice(-29).concat([new Date().toTimeString().slice(0, 8) + ' ' + name +
            (volume ? ' volume ' + f.volume + ' delta ' + f.delta + ' muted ' + f.muted : '')]);
        var p = this.player;
        var now = p.now;
        switch (name) {
            case 'loungeStatus':
                this.remotes = /REMOTE_CONTROL/.test(f.devices || '');
                this.tellAll();
                break;
            case 'remoteConnected':
                this.remotes = true;
                toast((f.name || 'A phone') + ' is connected to Bolli YouTube', 'check');
                this.tellAll();
                break;
            case 'getNowPlaying':
                this.nowPlaying();
                break;
            case 'setPlaylist':
            case 'setVideo':
                this.remotes = true;
                this.setPlaylist(f);
                break;
            case 'updatePlaylist':
                // The phone's list changed: it becomes the queue if it contains the playing video
                var list = ids(f.videoIds);
                if (now && list.indexOf(now.id) >= 0) {
                    this.install(new ListQueue(list, now.id));
                }
                this.tellList();
                break;
            case 'addVideo':
                var q = this.phoneQueue();
                if (q && f.videoId) {
                    q.ids.push(f.videoId);
                } else if (now && f.videoId) {
                    this.install(new ListQueue([now.id, f.videoId], now.id));
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
                this.volume = f.delta ? this.volume + (+f.delta || 0) : f.volume !== undefined ? +f.volume || 0 : this.volume;
                this.volume = Math.max(0, Math.min(100, this.volume));
                this.muted = f.muted !== undefined ? f.muted === 'true' : this.muted;
                p.setVolume(this.volume, this.muted, true);
                this.tellVolume();
                break;
            case 'mute':
            case 'unMute':
                this.muted = name === 'mute';
                p.setVolume(this.volume, this.muted, true);
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
        var queue = this.queue = new ListQueue(list.length ? list : [id], id);
        queue.at = list.length ? at : 0;
        this.extra = extraOf(f);
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
    }

    /** Makes the phone's list the player's queue */
    private install(queue: ListQueue): void {
        this.queue = this.player.queue = queue;
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
        this.lounge.send('onVolumeChanged', { volume: String(this.volume), muted: String(this.muted) });
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

