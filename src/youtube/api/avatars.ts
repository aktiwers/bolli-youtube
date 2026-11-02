// Known channel avatars by channel name, for the loading sign shown while a
// video starts (player/own-player.ts). The sign appears before the watch
// page is fetched, so avatars are collected from earlier replies: the
// Subscriptions list, channel pages and /next. Persisted in localStorage
// (bolli.v1.youtube.avatars), newest last.

import { load, save } from '../../core/store.js';

var KEY = 'youtube.avatars';
/** Most avatars kept; the oldest are dropped first */
var KEPT = 1000;
/** Requested size in the image URL: the loading sign's 128 px at a 1.5x device pixel ratio */
var PX = 192;

var avatars: { [channel: string]: string } | null = null;
/** Delay before saving new avatars, so the screen they came with draws first */
var SAVE_MS = 3000;
var saveTimer = 0;

function known(): { [channel: string]: string } {
    if (!avatars) {
        var kept = load<{ [channel: string]: string }>(KEY);
        avatars = kept && typeof kept === 'object' && !Array.isArray(kept) ? kept : {};
    }
    return avatars;
}

/** A channel's avatar URL, or '' when not seen yet */
export function knownAvatar(channel: string): string {
    var all = known();
    return channel && Object.prototype.hasOwnProperty.call(all, channel) ? all[channel] : '';
}

/** Records avatars (name: URL) and schedules a save when any is new */
export function noteAvatars(seen: { [channel: string]: string }): void {
    var all = known();
    var changed = false;
    for (var channel in seen) {
        var url = String(seen[channel] || '').replace(/=s\d+/, '=s' + PX);
        if (channel && url && all[channel] !== url) {
            delete all[channel];
            all[channel] = url;
            changed = true;
        }
    }
    if (!changed) {
        return;
    }
    var names = Object.keys(all);
    for (var i = 0; i < names.length - KEPT; i++) {
        delete all[names[i]];
    }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveAvatars, SAVE_MS) as unknown as number;
}

/** Saves pending avatars now, for when the app is left or reloaded before SAVE_MS */
export function saveAvatars(): void {
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = 0;
        save(KEY, known());
    }
}

/** Records one channel's avatar */
export function noteAvatar(channel: string, url: string): void {
    var seen: { [channel: string]: string } = {};
    seen[channel] = url;
    noteAvatars(seen);
}
