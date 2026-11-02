// Reports watched videos to YouTube (Settings: History) the way YouTube's TV app does. The
// report URLs come with the TV client's signed-in /player reply for the video (one extra
// request per video, sent a few seconds after playback starts so its parsing stays out of the
// start, or at once if it stops sooner; its streams are unused). "playback" is sent once it
// plays (the video goes into History), then "watchtime" with the ranges played since the last
// report (so YouTube knows the progress: the red bars on tiles, and where apps resume) at 10,
// 20 and 30 s, then every 40 s, on pause and on stop. A seek ends the current range. Reports go
// to www.youtube.com with the account's sign-in (api/youtube.ts report), as YouTube's app posts
// them (the URLs name s.youtube.com). Nothing is requested or sent without a sign-in.

import { takeTracking } from './streams.js';
import { freshSignIn, innertube, newCpn, report, TvClient, tvClient } from './youtube.js';

/** The first FIRST_COUNT reports come this far apart (s), then every EVERY_S */
var FIRST_EVERY_S = 10;
var FIRST_COUNT = 3;
var EVERY_S = 40;
/** Delay after playback starts before the report URLs are requested */
var ASK_AFTER_MS = 4000;

export class WatchReport {
    /** The report URLs ('' until known) */
    private playback = '';
    private watchtime = '';
    private client: TvClient = {};
    /** This playback's id in the reports (made as YouTube's player makes it) */
    private cpn = newCpn();
    private startedAt = 0;
    private played = false;
    private reports = 0;
    private nextAt = 0;
    /** Ranges played since the last report ([from, to] s), and where the current one began (-1: none) */
    private parts: number[][] = [];
    private from = -1;
    private last = 0;
    private stopped = false;
    private askTimer = 0;
    /** The formats last seen playing (kept for a report sent after the video stopped) */
    private playing: { video: number; audio: number };

    /** Video id started playing at t (s); formats: the playing video and audio itags */
    constructor(private id: string, t: number, private formats: () => { video: number; audio: number }) {
        this.startedAt = Date.now();
        this.nextAt = this.startedAt + FIRST_EVERY_S * 1000;
        this.from = this.last = t;
        this.playing = formats();
        var self = this;
        this.askTimer = setTimeout(function () { self.ask(); }, ASK_AFTER_MS) as unknown as number;
    }

    /** Fetches the report URLs (none for a guest) */
    private ask(): void {
        var self = this;
        var id = this.id;
        this.askTimer = 0;
        freshSignIn().then(function (sign) {
            // A video streamed by SABR with this sign-in already has its /player reply
            var kept = sign && takeTracking(id, sign.token);
            return sign ? Promise.all<any>([tvClient(), kept ? { playbackTracking: kept } : innertube('player', { videoId: id, contentCheckOk: true, racyCheckOk: true })]) : null;
        }).then(function (got) {
            var tracking = got && got[1] && got[1].playbackTracking;
            if (!tracking) {
                return;
            }
            self.client = got![0].context.client;
            self.playback = statsPath(tracking.videostatsPlaybackUrl);
            self.watchtime = statsPath(tracking.videostatsWatchtimeUrl);
            // What played before they arrived (all of it, if it was short)
            self.send(self.stopped ? 'paused' : 'playing');
        }, function () { return undefined; });
    }

    /** The last time reported as played (s) */
    get time(): number {
        return this.last;
    }

    /** As it plays (each time update): sends a report when one is due */
    at(t: number): void {
        if (this.stopped) {
            return;
        }
        if (this.from < 0) {
            this.from = t;
        }
        this.last = t;
        var now = this.formats();
        if (now.video) {
            this.playing = now;
        }
        if (Date.now() >= this.nextAt) {
            this.reports++;
            this.nextAt = Date.now() + (this.reports < FIRST_COUNT ? FIRST_EVERY_S : EVERY_S) * 1000;
            this.send('playing');
        }
    }

    /** A seek ends the current range (the next starts where the seek lands) */
    seek(): void {
        this.end();
    }

    /** Paused at t: ends the current range and reports it */
    pause(t: number): void {
        if (this.stopped) {
            return;
        }
        // Ignore an earlier time (the engine restarting at 0 pauses there): the range ends where it was
        if (this.from >= 0 && t >= this.last) {
            this.last = t;
        }
        this.end();
        this.send('paused');
    }

    /** Stopped at t (closed, another video, background): the last report (the URLs are requested now if not yet) */
    stop(t: number): void {
        this.pause(t);
        this.stopped = true;
        if (this.askTimer) {
            clearTimeout(this.askTimer);
            this.ask();
        }
    }

    /** Ends the current range at the last time */
    private end(): void {
        if (this.from >= 0 && this.last > this.from) {
            this.parts.push([this.from, this.last]);
        }
        this.from = -1;
    }

    /** Sends "playback" the first time, then "watchtime" with the ranges played since the last (none: nothing) */
    private send(state: string): void {
        if (!this.watchtime) {
            // Kept until the URLs arrive
            return;
        }
        if (!this.played) {
            this.played = true;
            report(this.playback + '&' + this.query({})).then(null, function () { return undefined; });
        }
        // The current range is reported too, and continues from here
        var playing = this.from >= 0;
        this.end();
        if (playing) {
            this.from = this.last;
        }
        var parts = this.parts;
        this.parts = [];
        if (!parts.length) {
            return;
        }
        report(this.watchtime + '&' + this.query({
            state: state,
            st: parts.map(function (p) { return p[0].toFixed(3); }).join(','),
            et: parts.map(function (p) { return p[1].toFixed(3); }).join(',')
        })).then(null, function () { return undefined; });
    }

    /** The query fields YouTube's TV app adds to a report URL (device, player, times) */
    private query(extra: { [name: string]: string }): string {
        var c = this.client;
        var f = this.playing;
        var rt = (Date.now() - this.startedAt) / 1000;
        var fields: { [name: string]: string | undefined } = {
            ver: '2', cpn: this.cpn, cmt: this.last.toFixed(3), fmt: String(f.video), afmt: String(f.audio), fs: '0',
            rt: rt.toFixed(3), rtn: String(Math.round(rt)), rti: String(Math.floor(rt)), volume: '100', muted: '0',
            c: 'TVHTML5', cver: c.clientVersion, cplayer: 'UNIPLAYER', cbrand: c.deviceMake, cmodel: c.deviceModel,
            cos: c.osName, cosver: c.osVersion, cbr: c.browserName, cbrver: c.browserVersion, cplatform: 'TV',
            hl: c.hl ? c.hl.replace('-', '_') : undefined, cr: c.gl
        };
        for (var name in extra) {
            fields[name] = extra[name];
        }
        var out: string[] = [];
        for (var key in fields) {
            if (fields[key] !== undefined) {
                out.push(key + '=' + encodeURIComponent(fields[key] as string));
            }
        }
        return out.join('&');
    }
}

/** A report URL as a path on www.youtube.com ('' if missing or not a stats URL) */
export function statsPath(address: { baseUrl?: string } | undefined): string {
    var path = String(address && address.baseUrl || '').replace(/^https?:\/\/[^\/]+/, '');
    return /^\/api\/stats\/[a-z]+\?/.test(path) ? path : '';
}
