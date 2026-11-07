// Keeps the screensaver away while a video plays. LG's screensaver comes after a few minutes
// without a key press and blacks out everything but a playing video (OLED care). The TV first
// asks the apps registered with its power service, and one "no" keeps it away: the app says no
// while a picture runs; paused, or without video, it comes as usual. The TV keeps a
// registration after its app has gone (a second one under the same name is refused), so each
// start registers under a unique name and cancels it when the app closes. On Android nobody
// asks: the app keeps the screen on while a picture runs, checked every CHECK_MS while the app
// is visible (Google TV's screensaver waits minutes; hidden, the app's window has no say).

import { Bridge, lunaCall, LunaReply } from './luna.js';
import { noteSaver } from './perf.js';
import { android, AndroidShell } from './platform.js';

var POWER = 'luna://com.webos.service.tvpower/power/';
/** A unique name per start: the app's id (its folder, .../applications/<id>/index.html) and the time */
var CLIENT = ((/\/applications\/([^/]+)\//.exec(window.location.pathname) || [])[1] || 'bolli') + '.' + Date.now().toString(36);
var CHECK_MS = 5000;
/** Kept referenced: a bridge dropped too early is garbage-collected, and its replies with it */
var subscription: Bridge | null = null;
var answer: Bridge | null = null;

function call(method: string, params: object, reply: (message: string, data: LunaReply) => void): Bridge | null {
    return lunaCall(POWER + method, params, reply);
}

/** watching: true while a picture runs (called each time the TV wants to start the screensaver) */
export function initScreenSaver(watching: () => boolean): void {
    var shell = android();
    if (shell) {
        keepOnWhile(shell, watching);
        return;
    }
    subscription = call('registerScreenSaverRequest', { subscribe: true, clientName: CLIENT }, function (message: string, request: LunaReply) {
        noteSaver(message);
        if (request && request.timestamp !== undefined) {
            var ack = !watching();
            answer = call('responseScreenSaverRequest', { clientName: CLIENT, ack: ack, timestamp: request.timestamp }, function (reply: string) {
                noteSaver('ack ' + ack + ': ' + reply);
            });
        }
    });
    if (!subscription) {
        noteSaver('no PalmServiceBridge');
        return;
    }
    window.addEventListener('unload', function () {
        var open = [subscription, answer];
        for (var i = 0; i < open.length; i++) {
            var bridge = open[i];
            if (bridge && bridge.cancel) {
                bridge.cancel();
            }
        }
    });
}

function keepOnWhile(shell: AndroidShell, watching: () => boolean): void {
    var on = false;
    var timer = 0;
    var check = function () {
        var now = watching();
        if (now !== on) {
            on = now;
            shell.keepScreenOn(on);
            noteSaver('keep screen on: ' + on);
        }
    };
    var follow = function () {
        clearInterval(timer);
        timer = document.hidden ? 0 : setInterval(check, CHECK_MS) as unknown as number;
    };
    document.addEventListener('visibilitychange', follow);
    follow();
}
