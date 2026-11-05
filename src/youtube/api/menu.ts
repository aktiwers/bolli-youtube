// A tile's menu, as YouTube's TV app shows it on a long OK (Play, Save to
// Watch later, Go to channel, Not interested, ...), with YouTube's command
// for each item. Channel and search tiles carry their menu
// (showMenuCommand); Home tiles fetch it as a "context menu" panel
// (get_panel with the tile's params). A tile without one gets Play and the
// saves. One item's command may hold several (commandExecutorCommand).

import { first, get, itemsOf, MenuItem, menuOf, Video } from './feed.js';
import { Keeper } from './kept-pages.js';
import { innertube } from './youtube.js';

/** Fetched menus, cached for a while */
var menus = new Keeper<MenuItem[]>(5 * 60 * 1000, 8, true, true);

/** A video tile's menu (from its long-press command; without one: Play and the saves) */
export function tileMenu(video: Video): Promise<MenuItem[]> {
    // Its items as parsed (feed.ts menuOf; rows kept from before carry YouTube's whole command)
    var press = video.menu && video.menu.items ? video.menu : menuOf(video.menu);
    if (press && press.items) {
        return Promise.resolve(press.items);
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
