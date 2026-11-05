// YouTube account settings, fetched as YouTube's TV app does
// (account/get_setting returns its whole Settings page). Only the History
// & data category is shown: pausing and clearing the watch and search
// history. The other settings belong to the TV app itself or have an app
// setting of their own (autoplay). Commands are sent like the watch page's
// (api/watch.ts run). The reply is cached for a minute.

import { Ask, askOf, CLEARS, first, get, picture, text } from './feed.js';
import { Keeper } from './kept-pages.js';
import { clearRecentSearches } from './suggest.js';
import { run } from './watch.js';
import { innertube } from './youtube.js';

/** An on/off setting (state, plus YouTube's commands to turn it on and off) or an action behind a confirmation */
export interface AccountSetting {
    title: string;
    summary: string;
    picture: string;
    on?: boolean;
    enable?: any;
    disable?: any;
    ask?: Ask;
}

export interface AccountGroup {
    title: string;
    settings: AccountSetting[];
}

/** The category shown */
var HISTORY = 'SETTING_CAT_TVHTML5_HISTORY';
/** Not cleared on every write like other account caches: on/off changes are applied to it, as YouTube's reads lag.
 * Cleared on an account change (forgetHistorySettings). */
var kept = new Keeper<AccountGroup | null>(60000, 1, false, false);

export function forgetHistorySettings(): void {
    kept.forget();
}

/** The History & data settings (null: none), cached for a minute */
export function historySettings(): Promise<AccountGroup | null> {
    return kept.get('history', function () {
        return innertube('account/get_setting', {}).then(historyOf);
    });
}

export function historyOf(reply: unknown): AccountGroup | null {
    var cat = (get(reply, 'items') || []).map(function (i: any) { return i.settingCategoryCollectionRenderer; })
        .filter(function (c: any) { return c && c.categoryId === HISTORY; })[0];
    var settings: AccountSetting[] = [];
    (cat && cat.items || []).forEach(function (item: any) {
        var b = item.settingBooleanRenderer;
        // On/off settings of the account (not the TV app's own, like the microphone)
        if (b && get(b, 'enableServiceEndpoint', 'setSettingEndpoint')) {
            settings.push({ title: text(b.title), summary: text(b.summary), picture: picture(b.thumbnail), on: !!b.enabled,
                enable: b.enableServiceEndpoint, disable: b.disableServiceEndpoint });
            return;
        }
        var a = item.settingActionRenderer;
        var ask = a && askOf(first(a.serviceEndpoint, 'overlayPanelRenderer'), CLEARS);
        if (ask) {
            settings.push({ title: text(a.title), summary: text(a.summary), picture: picture(a.thumbnail), ask: ask });
        }
    });
    return settings.length ? { title: text(cat.title), settings: settings } : null;
}

/** Run a confirmed action (clearing the search history also clears the local recent searches) */
export function clear(ask: Ask): Promise<unknown> {
    return run(ask.command).then(function (r) {
        if (ask.command.clearSearchHistoryEndpoint) {
            clearRecentSearches();
        }
        return r;
    });
}
