// YouTube's media networks for a video, as SmartTube uses them: a googlevideo URL names the networks that hold the
// video (mn=, the one in its host first), and the host is not part of the URL's signature, so the same URL works on
// another network's host. A request that gets no data for STALL_MS (stallWatch) passes its network over for
// STALLED_MS (a cache node of the viewer's provider can hang), one that gets no answer at all for UNANSWERED_MS only
// (the TV's own connection may have dropped): the video's requests go to another (onNetwork), the next video's too.
// When all have failed, the one that failed longest ago is tried again. A media request without an answer from the
// last network left to ask, or the window's 'offline', marks the TV's line as lost (lineLost); the next answer, or
// 'online', as back (the fallback ladder renews again after a loss; a picture standing while the line is down is no
// stall). Where a picture stands and no media request tells whether the line answers, a probe is asked (probe); while
// one stands for the line with nothing asked that would tell, the probe is asked again and again (awaitLine), so its
// first answer tells the line is back.

import { fakedProbe } from '../core/fake-net.js';
import { getText, HttpError } from '../core/http.js';
import { note } from './play-log.js';

var GOOGLEVIDEO = '.googlevideo.com';
/** A request that gets no data this long (ms; from its start or its last data) is stalled */
var STALL_MS = 4000;
var STALLED_MS = 30 * 60 * 1000;
var UNANSWERED_MS = 2 * 60 * 1000;
/** Networks that failed lately: when, and when they may be used again */
var failures: { [network: string]: { at: number; until: number } } = {};
/** When the line was last lost and when something last answered (0: never), whether it is down now, and who hears
 * that it answered again */
var lostAt = 0;
var answeredAt = 0;
var down = false;
var backs: (() => void)[] = [];
/** Google's addresses for a connection check (an empty 204, nothing of the viewer's sent), taken in turn by the probe:
 * none is one the app waits on otherwise (the TV's browser opens at most 6 connections to a host, and during a drop
 * www.youtube.com's fill with requests that hang: a probe there waited behind them, on the TV 2026-11-15); and the
 * browser keeps trying to connect for a probe that timed out, on a growing wait (1, 2, 4, 8 s…), so 6 probes to one
 * host during a drop leave the next one after the line's return waiting for one of those: one probe on its way at a
 * time (due), spread over eight, leave each host fewer than 6 through a drop of minutes */
var PROBES = ['https://www.gstatic.com/generate_204', 'https://connectivitycheck.gstatic.com/generate_204',
    'https://clients3.google.com/generate_204', 'https://www.google.com/generate_204', 'https://play.googleapis.com/generate_204',
    'https://clients1.google.com/generate_204', 'https://connectivitycheck.android.com/generate_204', 'https://google.com/generate_204'];
var probeTurn = 0;
/** A probe still on its way when the next is due is looked at again this often (ms) */
var PROBE_POLL_MS = 100;
/** A probe is asked at most this often (ms: until then the last one's answer stands), and waits this long for its
 * answer */
var PROBE_GAP_MS = 10000;
var PROBE_WAIT_MS = 5000;
/** A probe for a picture that stands (awaitLine, a stall's look) waits this long: a line that holds answers within a
 * second; the viewer is told sooner, and fewer probes hang at once (at most three, PROBE_STANDING_MS apart) */
var PROBE_STANDING_WAIT_MS = 3000;
/** While a picture stands for the line (awaitLine) the probe is asked this often (ms), and only then: the line coming
 * back is seen at most this much later, and the video starts anew at once (a viewer waiting: an empty answer of
 * YouTube's each time). One still on its way then (it hangs on a connection from before the loss) is not waited for:
 * the next is a request of its own */
var PROBE_STANDING_MS = 1000;
/** How often a picture that stands asks the probe after it has stood so long (ms; before the first: PROBE_STANDING_MS):
 * fewer probes waiting to connect per host through a long drop (above), and few through a TV left standing offline */
var PROBE_BACKOFF: number[][] = [[60000, 5000], [300000, 30000]];

/** The last probe: when it was asked, its answer once in (null: on its way), and the ask itself */
var probing: { at: number; answered: boolean | null; asked: Promise<boolean> } | null = null;
/** Whether a picture stands for the line (awaitLine), the timer of its next probe, and whether one of its probes
 * without an answer was noted yet (the first is, not each one all through a loss) */
var awaited = false;
var awaitTimer = 0;
var awaitSince = 0;
var awaitNoted = false;

/** The line is lost now: a media request got no answer, or the window went offline */
export function lineLost(): void {
    lostAt = Date.now();
    down = true;
}

/** The line is up (after a loss, or awaited: onLineBack's listeners are told). said: by the TV, which is no answer
 * yet: a picture that waits for the line is watched on until one comes (the listeners are then told again) */
function lineUp(said?: boolean): void {
    if (!down && !awaited) {
        return;
    }
    down = false;
    if (!said) {
        awaitLine(false);
    }
    for (var i = 0; i < backs.length; i++) {
        backs[i]();
    }
}

/** on: a picture stands for the line, and nothing is asked that would tell when it answers again (no engine runs: a
 * try anew waits, or the video's streams are asked for). Until something answers the probe is asked every
 * PROBE_STANDING_MS; its answer is the line back (onLineBack's listeners are told, also where no media request had
 * marked it lost). Off: the picture no longer waits (the video closed) */
export function awaitLine(on: boolean): void {
    if (on === awaited) {
        return;
    }
    awaited = on;
    awaitNoted = false;
    clearTimeout(awaitTimer);
    awaitTimer = 0;
    if (on) {
        awaitSince = Date.now();
        awaitOn();
    }
}

/** The wait before a standing picture's next probe, after it has stood so long (ms) */
function standingGap(stood: number): number {
    var gap = PROBE_STANDING_MS;
    PROBE_BACKOFF.forEach(function (step) {
        if (stood >= step[0]) {
            gap = step[1];
        }
    });
    return gap;
}

function awaitOn(): void {
    awaitTimer = setTimeout(due, standingGap(Date.now() - awaitSince)) as unknown as number;
}

/** A standing picture's probe is due: asked, unless one is still on its way. One at a time: each that times out
 * leaves the browser trying to connect for ~2 min, and a pile of those on a host has the probe after the line's
 * return wait behind them (a flaky line's drops took 2-4 s to be seen, on the TV 2026-11-15); the one on its way is
 * waited for (its connect is retried 1 and 3 s after it went: the line's return is seen within ~2 s) */
function due(): void {
    if (probing && probing.answered === null) {
        awaitTimer = setTimeout(due, PROBE_POLL_MS) as unknown as number;
        return;
    }
    awaitOn();
    probe(true);
}

/** Something answered (a media request, whatever its status, or the probe): the line is up */
export function lineAnswered(): void {
    answeredAt = Date.now();
    lineUp();
}

/** When the line was last lost (0: never) */
export function lastLost(): number {
    return lostAt;
}

/** When something last answered (0: never) */
export function lastAnswered(): number {
    return answeredAt;
}

/** Whether the line answers, asked of an address that is not a video's host (so a failing video server is told from a
 * line that is down): true for any answer, an error's too (the line then counts as answered), false for none within
 * PROBE_WAIT_MS. Asked at most every PROBE_GAP_MS: until then the last probe's answer is given again. standing: for
 * a picture that stands (awaitLine, a stall's look), at most every PROBE_STANDING_MS, waiting PROBE_STANDING_WAIT_MS. Noted with how long it took (no
 * answer at once: the TV refuses the request itself; after PROBE_WAIT_MS: it hangs). An answer marks the line up; no
 * answer for a picture that stands (standing) marks it lost */
export function probe(standing?: boolean): Promise<boolean> {
    var now = Date.now();
    if (probing && now >= probing.at && now - probing.at < (standing ? PROBE_STANDING_MS : PROBE_GAP_MS)) {
        return probing.asked;
    }
    var one = probing = { at: now, answered: null as boolean | null, asked: null as unknown as Promise<boolean> };
    // (refused, as a host a filter on the network blocks is: the next host is asked once before it counts; one that
    // hangs or times out is a line that drops what it is sent)
    var ask = function (again: boolean): Promise<boolean> {
        var asking: Promise<unknown> = fakedProbe() || getText(PROBES[probeTurn++ % PROBES.length], standing ? PROBE_STANDING_WAIT_MS : PROBE_WAIT_MS);
        return asking.then(function () {
            return true;
        }, function (e: HttpError) {
            return !!e && e.status > 0 || (standing && !again && !!e && e.message === 'network error' ? ask(true) : false);
        });
    };
    one.asked = ask(false).then(function (answered) {
        one.answered = answered;
        if (answered || !standing || !awaitNoted) {
            note('probe', (answered ? 'the line answers' : 'no answer') + ' (' + (Date.now() - one.at) + ' ms)');
            awaitNoted = awaitNoted || !!standing;
        }
        // (no answer for a picture that stands, from hosts nothing else waits on: the line is lost, so what waits on it
        // holds its asks; a probe for a failure's cause alone tells nothing more)
        if (answered) {
            lineAnswered();
        } else if (standing) {
            lineLost();
        }
        return answered;
    });
    return one.asked;
}

/** The last probe's answer while it stands (PROBE_GAP_MS): true or false; null: none, or still on its way */
export function probed(): boolean | null {
    var now = Date.now();
    return probing && now >= probing.at && now - probing.at < PROBE_GAP_MS ? probing.answered : null;
}

/** Whether the line is down: lost within UNANSWERED_MS, and nothing answered since (requests that hang without an
 * error tell nothing of the line: after that long they count as on a line that is up) */
export function lineDown(): boolean {
    return down && Date.now() - lostAt < UNANSWERED_MS;
}

/** f is called each time the line answers again after a loss */
export function onLineBack(f: () => void): void {
    backs.push(f);
}

// (a short cable drop may not fire these on a TV: the requests' own answers tell it too)
if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('offline', lineLost);
    window.addEventListener('online', function () { lineUp(true); });
}

/** u on the first of its networks that has not failed lately (its own, then the others in mn's order); if all have,
 * the one that failed longest ago */
export function onNetwork(u: string): string {
    var n = networksOf(u);
    if (n.own < 0) {
        return u;
    }
    var list = n.all.slice(n.own).concat(n.all.slice(0, n.own));
    var at = 0;
    for (var i = 0; i < list.length; i++) {
        if (!failed(list[i].name)) {
            at = i;
            break;
        }
        if (failures[list[i].name].at < failures[list[at].name].at) {
            at = i;
        }
    }
    return at ? u.replace(/^(https?:\/\/)[^/]+/, '$1rr' + list[at].n + '---' + list[at].name + GOOGLEVIDEO) : u;
}

/** A request to u got no data (stalled) or no answer: its network is passed over for a while, and true when another
 * of the video's networks has not failed lately (the request goes there at once; noted). No answer with no other
 * network left to ask (or none named) counts as the line lost (lineLost): one server failing alone is not the line. */
export function networkFailed(u: string, stalled: boolean): boolean {
    var n = networksOf(u);
    var other = false;
    if (n.own >= 0) {
        var own = n.all[n.own].name;
        failures[own] = { at: Date.now(), until: Date.now() + (stalled ? STALLED_MS : UNANSWERED_MS) };
        other = n.all.some(function (x) { return x.name !== own && !failed(x.name); });
    }
    if (other) {
        note('network', (stalled ? 'no data' : 'no answer') + ': the next one');
    } else if (!stalled) {
        lineLost();
    }
    return other;
}

function failed(network: string): boolean {
    var f = failures[network];
    return !!f && f.until > Date.now();
}

/** The networks u names in mn, with their place there (the host's number), and which is u's own (-1: u names none, or
 * is not on one of them) */
function networksOf(u: string): { all: { name: string; n: number }[]; own: number } {
    var host = /^https?:\/\/([^/]+)/.exec(u);
    var own = host && /^[a-z0-9]+---([a-z0-9-]+)\.googlevideo\.com$/i.exec(host[1]);
    var mn = own && /[?&]mn=([^&]*)/.exec(u);
    var names = mn ? decodeURIComponent(mn[1]).split(',') : [];
    var all: { name: string; n: number }[] = [];
    var at = -1;
    for (var i = 0; i < names.length; i++) {
        if (/^[a-z0-9-]+$/i.test(names[i])) {
            if (own && names[i] === own[1]) {
                at = all.length;
            }
            all.push({ name: names[i], n: i + 1 });
        }
    }
    return { all: all, own: at };
}

/** xhr to u gets no answer (an error) or, when watched, no data (stallWatch): moved() when another of the video's
 * networks is there to ask at once (networkFailed), else failed(). Its answer, whatever its status, tells the line is
 * up (lineAnswered). */
export function onLost(xhr: XMLHttpRequest, u: string, moved: () => void, failed: () => void, watched: boolean): void {
    var lost = function (stalled: boolean): void {
        if (networkFailed(u, stalled)) {
            moved();
        } else {
            failed();
        }
    };
    xhr.onerror = function () {
        lost(false);
    };
    xhr.addEventListener('load', lineAnswered);
    if (watched) {
        stallWatch(xhr, function () { lost(true); });
    }
}

/** Aborts xhr (once sent) when no data comes for STALL_MS, from now or from its last data; stalled is called first */
export function stallWatch(xhr: XMLHttpRequest, stalled: () => void): void {
    var last = Date.now();
    var timer = 0;
    var check = function (): void {
        var idle = Date.now() - last;
        if (idle < STALL_MS) {
            timer = setTimeout(check, STALL_MS - idle) as unknown as number;
            return;
        }
        stalled();
        xhr.abort();
    };
    xhr.addEventListener('progress', function () { last = Date.now(); });
    xhr.addEventListener('loadend', function () { clearTimeout(timer); });
    timer = setTimeout(check, STALL_MS) as unknown as number;
}
