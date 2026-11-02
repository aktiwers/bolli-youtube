// A tile's menu, as YouTube's TV app shows it on a long OK (Play, Save to
// Watch later, Go to channel, Not interested, ...), with YouTube's command
// for each item. Channel and search tiles carry their menu
// (showMenuCommand); Home tiles fetch it as a "context menu" panel
// (get_panel with the tile's params). A tile without one gets Play and the
// saves. One item's command may hold several (commandExecutorCommand).

import { commandsOf, first, get, text, toastOf, Video } from './feed.js';

// Re-exported for menu users
export { commandsOf, toastOf };
import { Keeper } from './kept-pages.js';
import { innertube } from './youtube.js';

export interface MenuItem {
    title: string;
    command: any;
}

/** Fetched menus, cached for a while */
var menus = new Keeper<MenuItem[]>(5 * 60 * 1000, 8, true, true);

/** A video tile's menu (from its long-press command; without one: Play and the saves) */
export function tileMenu(video: Video): Promise<MenuItem[]> {
    var press = video.menu;
    var own = first(press, 'menuRenderer');
    if (own) {
        return Promise.resolve(itemsOf(own));
    }
    var panel = first(press, 'showEngagementPanelEndpoint');
    var tag = get(panel, 'identifier', 'tag');
    if (tag) {
        // Cached, so reopening the same menu is instant
        var params = decodeURIComponent(get(panel, 'globalConfiguration', 'params') || '');
        return menus.get(tag + '|' + params, function () {
            return innertube('get_panel', { panelId: tag, params: params }).then(itemsOf);
        });
    }
    return Promise.resolve([
        { title: 'Play', command: { watchEndpoint: { videoId: video.id } } },
        { title: 'Save to Watch later', command: { playlistEditEndpoint: { playlistId: 'WL', actions: [{ addedVideoId: video.id, action: 'ACTION_ADD_VIDEO' }] } } },
        { title: 'Save to playlist', command: { addToPlaylistEndpoint: { videoId: video.id } } }
    ]);
}

/** A menu's items in order (old and new renderer formats alike) */
export function itemsOf(menu: any): MenuItem[] {
    var items: MenuItem[] = [];
    (function walk(v: any): void {
        if (!v || typeof v !== 'object') {
            return;
        }
        for (var key in v) {
            var x = v[key];
            if (key === 'menuServiceItemRenderer' || key === 'menuNavigationItemRenderer') {
                items.push({ title: text(x.text), command: x.serviceEndpoint || x.navigationEndpoint || x.command });
            } else if (key === 'listItemViewModel') {
                items.push({ title: text(x.title), command: get(x, 'rendererContext', 'commandContext', 'onTap', 'innertubeCommand') });
            } else {
                walk(x);
            }
        }
    })(menu);
    return items.filter(function (i) { return i.title && i.command; });
}

