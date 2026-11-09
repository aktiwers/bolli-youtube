// Reports watched videos to YouTube (Settings: History) the way YouTube's TV app does. The
// report URLs come with the signed-in /player reply for the video: the one that played it
// (SABR), else one asked the same way a few seconds after playback starts, so its reading stays
// out of the start, or at once if it stops sooner (api/streams.ts takeTracking, signedTracking).
// "playback" is sent once it plays (the video goes into History), then "watchtime" with the
// parts played since the last report (so YouTube knows the progress: the red bars on tiles, and
// where apps resume) when the reply's schedule says (10, 20 and 30 s, then every 40 s; each
// video's a few seconds earlier, as YouTube's TV player jitters them), on pause and on stop (the
// last one final). As that player sends them: parts of at most 5 s (a seek ends one), each with
// its volume, and the playback id the /player request named. Reports go to www.youtube.com with
// the account's sign-in (api/youtube.ts report), as YouTube's app posts them (the URLs name
// s.youtube.com). Nothing is requested or sent without a sign-in.

import { lastKeyAt } from '../core/keys.js';
import { signedTracking, takeTracking, Tracking } from './streams.js';
import { freshSignIn, report, TvClient, tvClient } from './youtube.js';

/** When reports are due (s after playback starts) until the /player reply says (its
 * videostatsScheduledFlushWalltimeSeconds, then every videostatsDefaultFlushIntervalSeconds after the last of them);
 * the first ones up to 9 s earlier per video (idpj) and the others up to 39 s (ldpj), as YouTube's TV player sends
 * them */
var SCHEDULED_S = [10, 20, 30];
var EVERY_S = 40;
/** The played time is reported in parts of at most this long (s) */
var PART_S = 5;
/** Delay after playback starts before the report URLs are requested, and before they are asked once more if the
 * request failed (e.g. Onesie's config or the player script not there just then) */
var ASK_AFTER_MS = 4000;
var ASK_AGAIN_MS = 30000;

export class WatchReport {
    /** The report URLs ('' until known) */
    private playback = '';
    private watchtime = '';
    private client: TvClient = {};
    /** This playback's id in the reports: the one its /player request named */
    private cpn = '';
    private startedAt = 0;
    private played = false;
    /** The reply's schedule (SCHEDULED_S and EVERY_S until it is in) */
    private scheduled = SCHEDULED_S;
    private every = EVERY_S;
    /** The next report due (0: the first), and this video's jitter of the schedule (s, 0 or less) */
    private due = 0;
    private idpj = -Math.floor(Math.random() * 10);
    private ldpj = -Math.floor(Math.random() * 40);
    /** Parts played since the last report ([from, to] s), and where the current one began (-1: none) */
    private parts: number[][] = [];
    private from = -1;
    private last = 0;
    /** Moved without playing since the last report (a seek while paused): the next one is sent all the same */
    private moved = false;
    /** Stopped: no report but the last (final), sent now or once the URLs are in */
    private stopped = false;
    /** No URLs came (no sign-in, or no answer twice): nothing is kept to report, only the time */
    private none = false;
    private askTimer = 0;
    private asks = 0;
    /** The formats last seen playing (kept for a report sent after the video stopped) */
    private playing: { video: number; audio: number };

    /** Video id started playing at t (s); formats: the playing video and audio itags */
    constructor(private id: string, t: number, private formats: () => { video: number; audio: number }) {
        this.startedAt = Date.now();
        this.from = this.last = t;
        this.playing = formats();
        var self = this;
        this.askTimer = setTimeout(function () { self.ask(); }, ASK_AFTER_MS) as unknown as number;
    }

    /** Fetches the report URLs (none for a guest; a failed request is asked once more ASK_AGAIN_MS later, or at the
     * stop) */
    private ask(): void {
        var self = this;
        var id = this.id;
        this.askTimer = 0;
        this.asks++;
        var none = function (): void {
            self.none = true;
            self.parts = [];
        };
        var failed = function (): void {
            if (self.asks > 1) {
                none();
            } else if (!self.stopped) {
                self.askTimer = setTimeout(function () { self.ask(); }, ASK_AGAIN_MS) as unknown as number;
            } else {
                self.ask();
            }
        };
        freshSignIn().then(function (sign) {
            // A video streamed by SABR with this sign-in already has its /player reply; else it is asked the same way
            return sign ? Promise.all<any>([tvClient(), takeTracking(id, sign.token) || signedTracking(id)]) : null;
        }).then(function (got) {
            var t: Tracking | null = got && got[1];
            var tracking = t && t.tracking;
            var playback = statsPath(tracking && tracking.videostatsPlaybackUrl);
            var watchtime = statsPath(tracking && tracking.videostatsWatchtimeUrl);
            if (!got) {
                none();
                return;
            }
            if (!playback || !watchtime) {
                failed();
                return;
            }
            self.playback = playback;
            self.watchtime = watchtime;
            self.cpn = (t as Tracking).cpn;
            self.client = got![0].context.client;
            var scheduled = tracking.videostatsScheduledFlushWalltimeSeconds;
            self.scheduled = scheduled && scheduled.length ? scheduled : SCHEDULED_S;
            self.every = +tracking.videostatsDefaultFlushIntervalSeconds || EVERY_S;
            // What played before they arrived (all of it, if it was short), in the formats playing now, a part still
            // open playing; the schedule goes on from the slots passed meanwhile
            self.seen();
            self.skipDue();
            self.send(self.from >= 0 ? 'playing' : 'paused');
        }, failed);
    }

    /** The last time reported as played (s) */
    get time(): number {
        return this.last;
    }

    /** As it plays (each time update): a part ends every PART_S; sends a report when one is due */
    at(t: number): void {
        if (this.stopped) {
            return;
        }
        if (this.from < 0) {
            this.from = t;
        }
        this.last = t;
        if (this.none) {
            return;
        }
        if (t - this.from >= PART_S) {
            this.cut();
        }
        // (no slot is used up before the URLs are in)
        if (this.watchtime && (Date.now() - this.startedAt) / 1000 >= this.dueAt(this.due)) {
            this.seen();
            this.skipDue();
            this.send('playing');
        }
    }

    /** Moves the schedule past the slots passed by now (one missed, e.g. while paused, is not sent late): the report
     * sent now is the last one due (rti), the next comes at rtn */
    private skipDue(): void {
        var s = (Date.now() - this.startedAt) / 1000;
        while (this.dueAt(this.due) <= s) {
            this.due++;
        }
    }

    /** When report n (0: the first) is due (s after playback started) */
    private dueAt(n: number): number {
        var last = this.scheduled.length - 1;
        return n <= last ? this.scheduled[n] + this.idpj : this.scheduled[last] + this.every * (n - last) + this.ldpj;
    }

    /** A seek to t ends the current part (the next starts there); t is the time now, also if nothing plays from there
     * (moved while paused, then closed: YouTube resumes there) */
    seek(t: number): void {
        this.end();
        if (!this.stopped && t !== this.last) {
            this.last = t;
            this.moved = true;
        }
    }

    /** Paused at t: ends the current part and reports it */
    pause(t: number): void {
        if (!this.stopped) {
            this.reportAt(t);
        }
    }

    /** Stopped at t (closed, another video, background): the last report (the URLs are requested now if not yet) */
    stop(t: number): void {
        if (this.stopped) {
            return;
        }
        this.stopped = true;
        this.reportAt(t);
        if (this.askTimer) {
            clearTimeout(this.askTimer);
            this.ask();
        }
    }

    /** Ends the current part at t and reports it, paused (stopped: the last report) */
    private reportAt(t: number): void {
        this.seen();
        // Ignore an earlier time (the engine restarting at 0 pauses there): the part ends where it was
        if (this.from >= 0 && t >= this.last) {
            this.last = t;
        }
        this.end();
        this.send('paused');
    }

    /** Notes the formats playing now (the last ones are kept once none plays: the video stopped) */
    private seen(): void {
        var now = this.formats();
        if (now.video) {
            this.playing = now;
        }
    }

    /** Ends the current part at the last time (kept unless no URLs came) */
    private end(): void {
        if (this.from >= 0 && this.last > this.from && !this.none) {
            this.parts.push([this.from, this.last]);
        }
        this.from = -1;
    }

    /** Ends the current part at the last time; the next continues from there, if one was open */
    private cut(): void {
        var open = this.from >= 0;
        this.end();
        if (open) {
            this.from = this.last;
        }
    }

    /** Sends "playback" the first time, then "watchtime" with the parts played since the last (none: nothing) */
    private send(state: string): void {
        if (!this.watchtime || !this.playback) {
            // Kept until the URLs arrive (both: without "playback" the video is not in History)
            return;
        }
        if (!this.played) {
            this.played = true;
            report(this.playback + '&' + this.query({ mos: '0' })).then(null, function () { return undefined; });
        }
        // The current part is reported too, and continues from here
        this.cut();
        var parts = this.parts;
        this.parts = [];
        // Moved without playing, or the last report: a part of none, so YouTube takes the time
        if (!parts.length && (this.moved || this.stopped)) {
            parts = [[this.last, this.last]];
        }
        this.moved = false;
        if (!parts.length) {
            return;
        }
        var each = function (value: string): string { return parts.map(function () { return value; }).join(','); };
        report(this.watchtime + '&' + this.query({
            state: state,
            idpj: String(this.idpj),
            ldpj: String(this.ldpj),
            st: parts.map(function (p) { return p[0].toFixed(3); }).join(','),
            et: parts.map(function (p) { return p[1].toFixed(3); }).join(','),
            volume: each('100'),
            muted: each('0'),
            final: this.stopped ? '1' : undefined
        })).then(null, function () { return undefined; });
    }

    /** The query fields YouTube's TV app adds to a report URL (device, player, times: rti the time the last report was
     * due, rtn the next one's, lact the milliseconds since a key) */
    private query(extra: { [name: string]: string | undefined }): string {
        var c = this.client;
        var f = this.playing;
        var rt = (Date.now() - this.startedAt) / 1000;
        var fields: { [name: string]: string | undefined } = {
            ver: '2', cpn: this.cpn, cmt: this.last.toFixed(3), fmt: String(f.video), afmt: String(f.audio), fs: '0',
            rt: rt.toFixed(3), rtn: String(this.dueAt(this.due)), rti: String(this.due > 0 ? this.dueAt(this.due - 1) : 0),
            lact: String(Date.now() - lastKeyAt()), volume: '100', muted: '0',
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
