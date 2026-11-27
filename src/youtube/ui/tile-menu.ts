// A video tile's menu (api/menu.ts) in the side panel, opened by holding OK
// on the tile, as in YouTube's TV app. Items are shown as YouTube sends them;
// OK runs an item's commands: play, open a page (Go to channel), save to
// Watch later, open Save to (playlists, over the menu), or send feedback
// (Not interested, Don't recommend channel, Remove from watch history),
// then shows YouTube's message (or a short fallback). A removed video's
// tile disappears at once.

import { PROBLEM, toast } from './toast.js';
import { tr } from '../core/i18n.js';
import { dearrowTitle } from '../api/dearrow.js';
import { commandsOf, MenuItem, Page, pageOf, toastOf, Video } from '../api/feed.js';
import { tileMenu } from '../api/menu.js';
import { run } from '../api/watch.js';
import { openSaveTo } from './account.js';
import { PanelLine, SidePanel } from './side-panel.js';

export interface TileMenuActions {
    play(video: Video): void;
    open(page: Page): void;
    /** The video was removed (from History, recommendations or a playlist): drop its tile now */
    removed(video: Video): void;
    /** YouTube refused the removal: restore the tile (refetch the screen) */
    kept(video: Video): void;
    /** The tile is in a named row on Home (its name): its menu ends with Hide rows named so (api/filters.ts) */
    hideRow?: { name: string; hide: () => void };
    /** The tile's channel (its name) on a filtered screen but its own page: its menu ends with Hide videos from it */
    hideChannel?: { name: string; hide: () => void };
}

/** Opens the video's menu in the panel ("Loading" until YouTube replies) */
export function openTileMenu(panel: SidePanel, video: Video, actions: TileMenuActions): void {
    var hide = actions.hideRow;
    var channel = actions.hideChannel;
    panel.openAsked(dearrowTitle(video.id, video.title) || tr('Video'), tileMenu(video), function (items) {
        var lines: PanelLine[] = items.map(function (item) {
            return { label: item.title, stay: saves(item), action: function () { act(panel, video, item, actions); } };
        });
        if (hide) {
            lines.push({ label: tr('Hide rows named "{1}"', hide.name), action: hide.hide });
        }
        if (channel) {
            lines.push({ label: tr('Hide videos from {1}', channel.name), action: channel.hide });
        }
        return lines;
    }, tr('the menu'));
}

/** The video id a command opens Save to for, or '': a tile menu's addToPlaylistEndpoint, or the context
 * menu's add-to-playlist overlay */
function savesFor(c: any): string {
    var overlay = c.openClientOverlayAction;
    return c.addToPlaylistEndpoint ? c.addToPlaylistEndpoint.videoId || '' :
        overlay && overlay.type === 'CLIENT_OVERLAY_TYPE_ADD_TO_PLAYLIST' ? overlay.context || '' : '';
}

/** Whether an item opens Save to (the panel stays, the playlists open over it) */
function saves(item: MenuItem): boolean {
    return commandsOf(item.command).some(function (c) { return !!savesFor(c); });
}

/** Runs an item's commands in order */
function act(panel: SidePanel, video: Video, item: MenuItem, actions: TileMenuActions): void {
    var said = toastOf(item.command);
    commandsOf(item.command).forEach(function (c) {
        var saveId = savesFor(c);
        if (c.watchEndpoint) {
            var id = c.watchEndpoint.videoId || video.id;
            // Keep the movie flag for the same video: movies play only in YouTube's player
            actions.play({ id: id, title: video.title, channel: video.channel, length: '', info: '', start: video.start, movie: id === video.id && video.movie });
        } else if (c.browseEndpoint) {
            actions.open(pageOf(c) as Page);
        } else if (saveId) {
            openSaveTo(panel, saveId, true);
        } else if (c.playlistEditEndpoint || c.feedbackEndpoint) {
            var out = !!c.feedbackEndpoint || /ACTION_REMOVE/.test(JSON.stringify(c.playlistEditEndpoint));
            if (out) {
                actions.removed(video);
            }
            run(c).then(function () {
                toast(said || (c.feedbackEndpoint ? tr('Done: YouTube will show fewer like this') : tr('Saved')), 'check');
            }, function () {
                toast(tr('YouTube did not take that.'), undefined, PROBLEM);
                if (out) {
                    actions.kept(video);
                }
            });
        }
    });
}
