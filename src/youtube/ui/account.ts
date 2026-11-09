// Account actions on the watch page and channel page. Each sends YouTube's
// own command (api/watch.ts run), shows the change at once and reverts it,
// with a message, if YouTube refuses. Subscribe; when subscribed, the bell
// options and Unsubscribe open in the side panel. Save to lists the
// playlists (Watch later first) in the side panel.

import { setText, toggleClass } from '../core/dom.js';
import { tr } from '../core/i18n.js';
import { PROBLEM, toast } from './toast.js';
import { clear } from '../api/account-settings.js';
import { Ask } from '../api/feed.js';
import { run, SaveOption, saveOptions, Subscribe } from '../api/watch.js';
import { Question } from './question.js';
import { SidePanel } from './side-panel.js';

/** Sets model[key] to value, draws, and sends YouTube's command. On refusal, restores the old value (unless a later
 * change replaced it), redraws and shows failed; done is shown on success */
export function apply<T, K extends keyof T>(model: T, key: K, value: T[K], command: any, draw: () => void, failed: string, done?: string): void {
    var was = model[key];
    model[key] = value;
    draw();
    run(command).then(function () {
        if (done) {
            toast(done, 'check');
        }
    }, function () {
        if (model[key] === value) {
            model[key] = was;
            draw();
        }
        toast(failed, undefined, PROBLEM);
    });
}

/** Subscription state changed in this session, by channel id, so a Subscribe button on another screen for the same
 * channel (e.g. the watch page after the channel page) matches */
var subscribedNow: { [channel: string]: boolean } = {};

function channelOf(sub: Subscribe): string {
    var ids = sub.on && sub.on.subscribeEndpoint && sub.on.subscribeEndpoint.channelIds;
    return (ids && ids[0]) || '';
}

/** OK on Subscribe subscribes; on Subscribed, opens the bell options and Unsubscribe in the panel (draw redraws the
 * button and the panel) */
export function pressSubscribe(sub: Subscribe, channel: string, panel: SidePanel, draw: () => void): void {
    var id = channelOf(sub);
    var drawn = function (): void {
        if (id) {
            subscribedNow[id] = sub.subscribed;
        }
        draw();
    };
    if (!sub.subscribed) {
        apply(sub, 'subscribed', true, sub.on, drawn, tr('Could not subscribe.'), tr('Subscribed to {1}', channel));
        return;
    }
    panel.open(channel, function () {
        var lines = sub.bell.map(function (b, i) {
            return { label: tr('Notifications: {1}', b.name), chosen: i === sub.bellAt, action: function () {
                apply(sub, 'bellAt', i, b.command, draw, tr('Could not change the notifications.'));
            } };
        });
        return lines.concat([{ label: tr('Unsubscribe'), chosen: false, action: function () {
            apply(sub, 'subscribed', false, sub.off, drawn, tr('Could not unsubscribe.'), tr('Unsubscribed from {1}', channel));
        } }]);
    });
}

/** A shortcut's Subscribe (views/shortcuts.ts): subscribes to channel at once; subscribed, a first press asks for a
 * second within UNSUBSCRIBE_MS, which unsubscribes (a stray press in the dark keeps the channel) */
var UNSUBSCRIBE_MS = 4000;
var unsubscribing = { channel: '', at: 0 };
export function flipSubscription(sub: Subscribe, channel: string): void {
    var id = channelOf(sub);
    var drawn = function (): void {
        if (id) {
            subscribedNow[id] = sub.subscribed;
        }
    };
    if (!subscribed(sub)) {
        apply(sub, 'subscribed', true, sub.on, drawn, tr('Could not subscribe.'), tr('Subscribed to {1}', channel));
    } else if (unsubscribing.channel === channel && Date.now() - unsubscribing.at < UNSUBSCRIBE_MS) {
        unsubscribing.channel = '';
        apply(sub, 'subscribed', false, sub.off, drawn, tr('Could not unsubscribe.'), tr('Unsubscribed from {1}', channel));
    } else {
        unsubscribing = { channel: channel, at: Date.now() };
        toast(tr('Press again to unsubscribe from {1}', channel), 'info');
    }
}

/** Lists the playlists to save a video to (Watch later first), ticked when it is in them; OK adds or removes it.
 * Opens as the panel's list, or over the current one (push); saved is told whether the video is in any */
export function openSaveTo(panel: SidePanel, videoId: string, push: boolean, saved?: (any: boolean) => void): void {
    // Reports whether the video is in any playlist: on YouTube's reply and after each change
    var tell = function (options: SaveOption[]): void {
        if (saved) {
            saved(options.some(function (o) { return o.saved; }));
        }
    };
    var asked = saveOptions(videoId).then(function (options) {
        tell(options);
        return options;
    });
    panel.openAsked(tr('Save to'), asked, function (options) {
        return !options.length ? [{ label: tr('No playlists.'), plain: true }] : options.map(function (o) {
            return { label: o.title, chosen: o.saved, stay: true, action: function () {
                apply(o, 'saved', !o.saved, o.saved ? o.remove : o.add, function () {
                    tell(options);
                    panel.refresh();
                }, tr('Could not save.'));
            } };
        });
    }, tr('your playlists'), push);
}

/** Whether sub's channel is subscribed, as changed here lately (YouTube's replies lag): sub is updated to that */
export function subscribed(sub: Subscribe | null): boolean {
    var id = sub ? channelOf(sub) : '';
    if (sub && id && subscribedNow.hasOwnProperty(id)) {
        sub.subscribed = subscribedNow[id];
    }
    return !!(sub && sub.subscribed);
}

/** Draws a Subscribe button as YouTube does: Subscribe, or Subscribed (with class on) */
export function drawSubscribe(el: HTMLElement, sub: Subscribe | null, on: string): void {
    var yes = subscribed(sub);
    setText(el, yes ? tr('Subscribed') : tr('Subscribe'));
    toggleClass(el, on, yes);
}

/** Shows YouTube's confirmation dialog (Settings' History & data, History's Clear all). On yes, runs the action, shows
 * YouTube's message, then calls done; closed is called when the dialog closes either way */
export function askToClear(question: Question, ask: Ask, done?: () => void, closed?: () => void): void {
    question.open(ask, function () {
        clear(ask).then(function () {
            if (ask.done) {
                toast(ask.done, 'check');
            }
            if (done) {
                done();
            }
        }, function () {
            toast(tr('YouTube could not do it. Try again.'), undefined, PROBLEM);
        });
    }, closed);
}
