// YouTube's media networks for a video, as SmartTube uses them: a googlevideo URL names the networks that hold the
// video (mn=, the one in its host first), and the host is not part of the URL's signature, so the same URL works on
// another network's host. A request that gets no data for STALL_MS (stallWatch) passes its network over for
// STALLED_MS (a cache node of the viewer's provider can hang), one that gets no answer at all for UNANSWERED_MS only
// (the TV's own connection may have dropped): the video's requests go to another (onNetwork), the next video's too.
// When all have failed, the one that failed longest ago is tried again.

import { note } from './play-log.js';

var GOOGLEVIDEO = '.googlevideo.com';
/** A request that gets no data this long (ms; from its start or its last data) is stalled */
var STALL_MS = 4000;
var STALLED_MS = 30 * 60 * 1000;
var UNANSWERED_MS = 2 * 60 * 1000;
/** Networks that failed lately: when, and when they may be used again */
var failures: { [network: string]: { at: number; until: number } } = {};

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
 * of the video's networks has not failed lately (the request goes there at once; noted) */
export function networkFailed(u: string, stalled: boolean): boolean {
    var n = networksOf(u);
    if (n.own < 0) {
        return false;
    }
    var own = n.all[n.own].name;
    failures[own] = { at: Date.now(), until: Date.now() + (stalled ? STALLED_MS : UNANSWERED_MS) };
    var other = n.all.some(function (x) { return x.name !== own && !failed(x.name); });
    if (other) {
        note('network', (stalled ? 'no data' : 'no answer') + ': the next one');
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
 * networks is there to ask at once (networkFailed), else failed() */
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
