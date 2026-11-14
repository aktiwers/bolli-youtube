// Asks the version check service (cloud/version-check) whether a newer version of the app is out: at most once a
// day of UTC's calendar (the service's days: by the device's own, two of its checks could land on one of them), some
// time after the app has started and never under a video. The request names the app's version, webOS or Android and
// its version where known (osVersion), how many days ago this device last got an answer (0: never) and whether its
// notice is on; from that number the service counts the devices in use over any span of days, and nothing in it
// tells one device from another. The date of the last answered check stays here, in the app's storage, with the
// version that asked: an app updated later that day asks once more and names that version, so that the service
// counts the device on its new version, and once. A newer version shows in Settings › About (newerVersion) and is
// told at most once a week, for as long as it is out. The setting (Check for new versions) has three choices:
// 'notify' is all of that, 'quiet' asks and shows but tells nothing, 'off' asks nothing and knows of nothing newer.
// While CHECK_URL is empty all of this does nothing. A check that fails says nothing and is made again after the
// next start, or when the app comes back on screen (checkAgain): an app left running for days is so counted on each
// of its days, and told of a newer version. webOS TV 1.x-2.x asks over plain http (checkAddress): its engine does
// not know who issued the service's certificate, so https fails there. So it does on a later TV whose software was
// never renewed (LG's webOS 4.0 emulator, its certificates of May 2018: "ERR_INSECURE_RESPONSE" at every start): a
// check over https that gets nowhere, at once, on a device that says it is online is asked once more over plain http,
// once a run; when that is answered, the device asks over http from then on (kept with the app's version: an update
// tries https again), one request a day as everywhere.

import { getJson } from '../core/http.js';
import { lunaAsk } from '../core/luna.js';
import { android, oldEngine } from '../core/platform.js';
import { load, save } from '../core/store.js';
import { pad2 } from '../core/time.js';
import { prefs } from './prefs.js';

/** The service's address, without a path or a slash at its end (cloud/version-check/README.md); '': the app asks
 * nothing, knows of no newer version and Settings has no setting for it */
var CHECK_URL = 'https://check.bolli-version.workers.dev';
/** The address in use: CHECK_URL, or the one a test gave (checkAt) */
var address = CHECK_URL;
var KEY = 'youtube.versionCheck';
/** A check waits this long after the app has started, and this long again while something is in its way */
var START_MS = 30000;
var AGAIN_MS = 5 * 60000;
/** The service answers at once: a request still open after this long is given up */
var TIMEOUT_MS = 5000;
var VERSION = /^\d+\.\d+\.\d+$/;
var DAY = /^(\d{4})-(\d\d)-(\d\d)$/;
/** The longest time since the last check a request names, in days (a little over three years): longer ago is said
 * as this */
var GAP_MAX = 1100;
/** A notice of a newer version comes no sooner than this many days after the one before it */
var NOTICE_DAYS = 7;
/** A system's version as a check names it: one to four numbers, no longer than this */
var OS_VERSION = /^[0-9]+(\.[0-9]+){0,3}$/;
var OS_VERSION_LENGTH = 15;
/** webOS's own word on its version (sdkVersion: "3.9.0"), and how long a check waits for it */
var SYSTEM_INFO = 'luna://com.webos.service.tv.systemproperty/getSystemInfo';
var SYSTEM_MS = 2000;

/** What is kept: the date of the last answered check (UTC's, YYYY-MM-DD; '' none yet), the latest version
 * it named ('' none), the newer version the viewer was last told of ('' none), the date of that notice ('' none) and
 * the app's version that check was sent with ('' unknown: a build from before it kept none) */
interface Kept {
    day: string;
    latest: string;
    told: string;
    toldDay: string;
    sentWith: string;
    /** The app's version whose check was answered over plain http after https got nowhere (not kept where none) */
    plain?: string;
}

/** The latest version as the service named it in this run ('' none; null: not asked yet): known also where the
 * storage did not take it */
var named: string | null = null;
/** A request is on its way: none beside it (its date is kept only once it is answered) */
var asking = false;
/** Looks again half a minute from now (set by checkVersion; null before it, and in a build without an address) */
var again: (() => void) | null = null;
/** The system's version as this run's first check learned it (osVersion); null: not asked yet */
var system: Promise<string> | null = null;
/** Plain http was tried this run after https got nowhere (once a run: a service that is down is not asked twice at
 * every look) */
var triedPlain = false;

function kept(): Kept {
    var k = load<Kept>(KEY);
    var all: Kept = { day: String(k && k.day || ''), latest: String(k && k.latest || ''), told: String(k && k.told || ''),
        toldDay: String(k && k.toldDay || ''), sentWith: String(k && k.sentWith || '') };
    if (k && k.plain) {
        all.plain = String(k.plain);
    }
    return all;
}

/** The running app's version, as main.ts wrote it on the page */
function running(): string {
    return document.documentElement.getAttribute('data-version') || '';
}

/** Whether this build checks for new versions at all */
export function hasVersionCheck(): boolean {
    return !!address;
}

/** Tests: the service is at url, in place of CHECK_URL */
export function checkAt(url: string): void {
    address = url;
}

/** Where a check is asked: the address without a slash at its end, over plain http on webOS TV 1.x-2.x's engine and
 * where plain says so (the request names nothing of the viewer, and the answer is a version number alone) */
function checkAddress(plain?: boolean): string {
    var at = address.replace(/\/+$/, '');
    return oldEngine() || plain ? at.replace(/^https:/, 'http:') : at;
}

/** said if it is a system's version as a check may name it, else '' */
function systemVersion(said: unknown): string {
    return typeof said === 'string' && said.length <= OS_VERSION_LENGTH && OS_VERSION.test(said) ? said : '';
}

/** The version of webOS or Android for a check to name ('': unknown, the check names none). Android: its release, as
 * the shell says it (a shell from before that says none). webOS: the platform's own word, waited for no longer than
 * SYSTEM_MS; without one, and on webOS TV 1.x-2.x, which is not asked, what the browser's name carries after webOS/
 * (mostly nothing). Asked once a run, when its first check goes out. Never fails. */
function osVersion(): Promise<string> {
    system = system || new Promise<unknown>(function (resolve) {
        var shell = android();
        if (shell || oldEngine()) {
            resolve(shell && shell.osVersion ? shell.osVersion() : '');
            return;
        }
        var known = function (reply?: { [key: string]: unknown }): void {
            clearTimeout(late);
            resolve(reply && reply.sdkVersion);
        };
        var late = setTimeout(known, SYSTEM_MS);
        lunaAsk(SYSTEM_INFO, { keys: ['sdkVersion'] }).then(known, function () { known(); });
    }).then(function (said) {
        // (the Android app's browser names an LG TV: nothing to read there)
        var named = android() ? null : /web[o0]s\/([0-9.]+)/i.exec(navigator.userAgent);
        return systemVersion(said) || systemVersion(named && named[1]);
    }, function () {
        return '';
    });
    return system;
}

/** UTC's date of an instant, as the service counts its days: YYYY-MM-DD */
export function dayOf(now: Date): string {
    return now.getUTCFullYear() + '-' + pad2(now.getUTCMonth() + 1) + '-' + pad2(now.getUTCDate());
}

/** A date (YYYY-MM-DD) as a count of days, from its year, month and day alone: a day of 23 or 25 hours is one day
 * as any other. NaN for what is no date */
function dayNumber(day: string): number {
    var m = DAY.exec(day);
    return m ? Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000) : NaN;
}

/** The whole calendar days from the date last to the date today: at least 1 (also where the device's clock was set
 * back in between), at most GAP_MAX. 0: last is '' or no date, so there was nothing before today */
export function gapOf(last: string, today: string): number {
    var from = dayNumber(last);
    if (isNaN(from)) {
        return 0;
    }
    var days = dayNumber(today) - from;
    return days > 1 ? Math.min(days, GAP_MAX) : 1;
}

/** Whether the version latest is newer than the version current: their three numbers compared as numbers, the first
 * that differs deciding (0.1.10 is newer than 0.1.9). Anything that is not such a version: false. */
export function isNewer(latest: string, current: string): boolean {
    if (!VERSION.test(latest) || !VERSION.test(current)) {
        return false;
    }
    var a = latest.split('.');
    var b = current.split('.');
    for (var i = 0; i < 3; i++) {
        if (+a[i] !== +b[i]) {
            return +a[i] > +b[i];
        }
    }
    return false;
}

/** The version that is out and newer than the running one ('' none known, or checking is off) */
export function newerVersion(): string {
    if (!address || prefs().versionCheck === 'off') {
        return '';
    }
    var latest = named !== null ? named : kept().latest;
    return isNewer(latest, running()) ? latest : '';
}

/** Asks the service if a check is due: there is an address, checking is not off, version (the running app's) is one
 * of three numbers, none is on its way, and no check was answered yet on now's date, or one was, by another version
 * of the app: updated since, the app asks once more and names that version (from), which tells the service that this
 * is the device it counted before. A check kept without its version is of a build from before that: nothing more is
 * asked that day. True once the service has answered (the date, the asking version and its latest version kept);
 * false when nothing was asked or no proper answer came (nothing kept, so the next start asks again). An update's
 * check is kept as sent the moment it goes, and stays so where it may have arrived (no answer in time, the app
 * closed meanwhile): the service takes each one it gets as a move from that version, so one it counted must not come
 * twice. One that plainly did not arrive (no line, or the service answering that it failed) is asked again. Never
 * fails. */
export function checkNow(version: string, now: Date): Promise<boolean> {
    var today = dayOf(now);
    var last = kept();
    var from = last.day === today ? last.sentWith : '';
    if (!address || prefs().versionCheck === 'off' || !VERSION.test(version) || asking ||
        last.day === today && (!VERSION.test(from) || from === version)) {
        return Promise.resolve(false);
    }
    asking = true;
    var check = '/v1/check?app=youtube&v=' + version + '&os=' + (android() ? 'android' : 'webos');
    var rest = '&g=' + gapOf(last.day, today) + '&n=' + (prefs().versionCheck === 'notify' ? 1 : 0) + (from ? '&from=' + from : '');
    // (https got nowhere for this version of the app before, and http was answered: http at once)
    var plain = last.plain === version;
    return osVersion().then(function (os) {
        if (from) {
            var sent = kept();
            sent.sentWith = version;
            save(KEY, sent);
        }
        var ask = function (byHttp: boolean): Promise<{ latest?: unknown }> {
            return getJson<{ latest?: unknown }>(checkAddress(byHttp) + check + (os ? '&ov=' + os : '') + rest, TIMEOUT_MS);
        };
        return ask(plain).then(null, function (e: { status?: number; message?: string }) {
            // Nothing reached the service (no answer at all, and not for want of time) though the device says it is
            // online: most likely its certificates are too old to know the service's. Once more over plain http
            if (plain || triedPlain || oldEngine() || !/^https:/.test(address) || !e || e.status || e.message !== 'network error' || navigator.onLine === false) {
                throw e;
            }
            triedPlain = true;
            return ask(true).then(function (reply) {
                plain = true;
                return reply;
            });
        });
    }).then(function (reply) {
        asking = false;
        if (!reply || typeof reply.latest !== 'string') {
            return false;
        }
        named = VERSION.test(reply.latest) ? reply.latest : '';
        var was = kept();
        was.day = today;
        was.latest = named;
        was.sentWith = version;
        if (plain) {
            was.plain = version;
        } else {
            delete was.plain;
        }
        save(KEY, was);
        return true;
    }, function (e: { status?: number; message?: string }) {
        asking = false;
        // (the service said it failed, or the request got nowhere: nothing was counted, the update's check is due
        // again. One that got no answer in time may have been)
        if (from && e && (e.status || e.message !== 'timeout')) {
            var was = kept();
            was.sentWith = from;
            save(KEY, was);
        }
        return false;
    });
}

/** Starts the day's check a while from now (main.ts, once the app has started). busy: a video plays or starts, or
 * nobody sees the screen: the check waits and looks again later. tell: says that a newer version is out, only where
 * the setting is 'notify', only while not busy (else when a later look finds the screen free, or after the next
 * start) and at most once in NOTICE_DAYS days: a version that stays out is told again a week on, and a still newer
 * one waits for that week to pass too. Every look weighs the notice, also on a day whose check was answered before.
 * One look waits at a time: a later call for one takes the place of the one waiting. */
export function checkVersion(busy: () => boolean, tell: (version: string) => void): void {
    if (!address) {
        return;
    }
    var timer = 0;
    var soon = function (ms: number): void {
        clearTimeout(timer);
        timer = setTimeout(look, ms);
    };
    var look = function (): void {
        if (prefs().versionCheck === 'off') {
            return;
        }
        if (busy()) {
            soon(AGAIN_MS);
            return;
        }
        checkNow(running(), new Date()).then(function () {
            var version = newerVersion();
            var was = kept();
            var today = dayOf(new Date());
            // (0: nothing was told yet)
            var since = gapOf(was.toldDay, today);
            if (!version || prefs().versionCheck !== 'notify' || since > 0 && since < NOTICE_DAYS) {
                return;
            }
            if (busy()) {
                // A video started meanwhile: told once it is over
                soon(AGAIN_MS);
                return;
            }
            was.told = version;
            was.toldDay = today;
            save(KEY, was);
            tell(version);
        });
    };
    again = function (): void {
        soon(START_MS);
    };
    soon(START_MS);
}

/** The app is back on screen (main.ts): the day's check is looked at again half a minute from now. On a day already
 * answered nothing is asked. */
export function checkAgain(): void {
    if (again) {
        again();
    }
}
