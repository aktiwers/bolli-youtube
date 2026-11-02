// The data for the app's watch page (player/watch-page.ts), from YouTube's /next
// as its TV app requests it (signed in): title, channel (name, picture, page,
// subscribers), views, age, likes, related videos (untitled shelves merged into
// one list), the next video, the comments token, and the account's buttons (like
// and dislike, subscribe with the bell's choices). Comments come 20 at a time;
// the save-to-playlist list says whether the video is in each. The buttons send
// the commands YouTube's reply gives for them (run()), as its TV app does.

import { knownAvatar, noteAvatar } from './avatars.js';
import { all, commandsOf, first, get, nextOf, Page, pageOf, picture, rowsOf, text, Video } from './feed.js';
import { forgetKept, Keeper } from './kept-pages.js';
import { forgetPages } from './page-store.js';
import { innertube, innertubeText, objectAt } from './youtube.js';

export interface WatchInfo {
    title: string;
    channel: string;
    /** The channel's page (null: unknown), its picture, "1.25M subscribers" */
    channelPage: Page | null;
    avatar: string;
    subscribers: string;
    /** "23M views", "11y ago", "Published on Nov 10, 2014", "110K" */
    views: string;
    age: string;
    published: string;
    likes: string;
    related: Video[];
    /** The video YouTube plays next ('' none) */
    next: string;
    /** Token for the comments ('' none) */
    comments: string;
    /** Like and dislike (null: not allowed): LIKE, DISLIKE or INDIFFERENT, and YouTube's command for each */
    like: { status: string; commands: { [status: string]: any } } | null;
    /** The channel's subscribe button (null: none) */
    subscribe: Subscribe | null;
    /** Its chapters, in order (empty: none) */
    chapters: Chapter[];
}

/** A chapter of a video: its name, where it begins (s) */
export interface Chapter {
    title: string;
    start: number;
}

export interface Subscribe {
    subscribed: boolean;
    /** YouTube's commands */
    on: any;
    off: any;
    /** The bell's choices while subscribed (All, Personalized, None), and the one chosen (-1: not known) */
    bell: { name: string; command: any }[];
    bellAt: number;
}

/** A playlist the video can be saved to (Watch later first), whether it is in it, and YouTube's commands */
export interface SaveOption {
    /** The playlist's id ("WL": Watch later) */
    id: string;
    title: string;
    saved: boolean;
    add: any;
    remove: any;
}

/** InnerTube endpoints for the commands the app sends, with the command's fields as body; likes by status (LIKES) */
var ENDPOINTS: { [command: string]: string } = {
    subscribeEndpoint: 'subscription/subscribe',
    unsubscribeEndpoint: 'subscription/unsubscribe',
    modifyChannelNotificationPreferenceEndpoint: 'notification/modify_channel_preference',
    playlistEditEndpoint: 'browse/edit_playlist',
    clearWatchHistoryEndpoint: 'history/clear_watch_history',
    clearSearchHistoryEndpoint: 'history/clear_search_history',
    // History's Pause watch history (its page's button; Settings' is a setting)
    pauseWatchHistoryEndpoint: 'history/pause_watch_history',
    resumeWatchHistoryEndpoint: 'history/resume_watch_history'
};
var LIKES: { [status: string]: string } = { LIKE: 'like/like', DISLIKE: 'like/dislike', INDIFFERENT: 'like/removelike' };

export interface Comment {
    author: string;
    /** "7 years ago" */
    age: string;
    text: string;
    /** "2.7K" ('' none) */
    likes: string;
    replies: number;
}

export interface Comments {
    list: Comment[];
    /** Token for the next part ('' none) */
    next: string;
}

/** Cached video details (api/kept-pages.ts), parsed and as reply text (only a few: hundreds of KB each) */
var infos = new Keeper<WatchInfo>(5 * 60 * 1000, 3, true, true);
var nextTexts = new Keeper<string>(5 * 60 * 1000, 3, false, true);

/** A video's watch page details; notes its channel's picture. The reply is usually fetched earlier (for the channel
 * picture, on tile focus or a start) and parsed only once playback runs, since parsing delays a start ~0.35 s */
export function watchInfo(id: string): Promise<WatchInfo> {
    return infos.get(id, function () {
        return nextText(id).then(function (reply) {
            var info = watchInfoOf(JSON.parse(reply));
            noteAvatar(info.channel, info.avatar);
            return info;
        });
    });
}

/** A video's channel picture ('' none; noted in the size the loading indicator uses), read from the /next reply
 * without parsing it all (cheap during a start) */
export function channelPicture(id: string): Promise<string> {
    return nextText(id).then(function (reply) {
        var owner = objectAt(reply, '"videoOwnerRenderer":') || {};
        var channel = text(owner.title);
        var avatar = picture(owner.thumbnail);
        noteAvatar(channel, avatar);
        return knownAvatar(channel) || avatar;
    });
}

/** A video's /next reply as its text */
function nextText(id: string): Promise<string> {
    return nextTexts.get(id, function () { return innertubeText('next', { videoId: id }); });
}

export function comments(token: string): Promise<Comments> {
    return innertube('next', { continuation: token }).then(commentsOf);
}

/** Recent saves made here (key "video playlist": saved or not, and when), applied over YouTube's list for a while,
 * since YouTube returns the old state for some seconds after a change */
var recent: { [key: string]: { saved: boolean; at: number } } = {};
var RECENT_MS = 60000;
/** The last fetched playlist list (reused for a while when Save to opens again for the same video) */
var lastSaves: { id: string; options: SaveOption[]; at: number } | null = null;
var SAVES_KEPT_MS = 10 * 60000;

/** The playlists the video can be saved to, with recent saves applied */
export function saveOptions(id: string): Promise<SaveOption[]> {
    var kept = lastSaves && lastSaves.id === id && Date.now() - lastSaves.at < SAVES_KEPT_MS ? lastSaves.options : null;
    var asked = kept ? Promise.resolve(kept) : innertube('playlist/get_add_to_playlist', { videoIds: [id], excludeWatchLater: false }).then(saveOptionsOf);
    return asked.then(function (options) {
        lastSaves = { id: id, options: options, at: kept ? (lastSaves as { at: number }).at : Date.now() };
        options.forEach(function (o) {
            var made = recent[id + ' ' + o.id];
            if (made && Date.now() - made.at < RECENT_MS) {
                o.saved = made.saved;
            }
        });
        return options;
    });
}

/** Records an accepted playlist edit (added or removed) as a recent save, also in the cached list */
function noteEdit(edit: any): void {
    (edit.actions || []).forEach(function (a: any) {
        var id = a.addedVideoId || a.removedVideoId;
        if (id) {
            recent[id + ' ' + edit.playlistId] = { saved: !!a.addedVideoId, at: Date.now() };
            (lastSaves && lastSaves.id === id ? lastSaves.options : []).forEach(function (o) {
                if (o.id === edit.playlistId) {
                    o.saved = !!a.addedVideoId;
                }
            });
        }
    });
}

/** Clears the saves state (on an account change) */
export function forgetSaves(): void {
    lastSaves = null;
    recent = {};
}

/** Sends one of YouTube's commands (a like, a subscription, the bell, a playlist edit, feedback such as "Not
 * interested", an account setting, clearing a history) as its TV app does. Clears cached replies before and after
 * (they may show the old state), and stored channel pages when a subscription changes. */
export function run(command: any): Promise<unknown> {
    forgetKept();
    var subscription = commandsOf(command).some(function (c: any) {
        return !!(c.subscribeEndpoint || c.unsubscribeEndpoint || c.modifyChannelNotificationPreferenceEndpoint);
    });
    return send(command).then(function (r) {
        // Again when done: replies fetched meanwhile may show the old state
        forgetKept();
        if (subscription) {
            forgetPages();
        }
        return r;
    });
}

function send(command: any): Promise<unknown> {
    // A command may hold several (a confirmation's yes, a nudge's button): the supported ones are sent in order
    // (signals and UI updates are left to the app)
    var requests = commandsOf(command).map(requestOf).filter(function (r) { return !!r; }) as (() => Promise<unknown>)[];
    if (!requests.length) {
        return Promise.reject(new Error('not a command the watch page sends'));
    }
    return requests.reduce(function (done: Promise<unknown>, request) { return done.then(request); }, Promise.resolve(undefined));
}

/** The request that sends command (null: unsupported) */
function requestOf(command: any): (() => Promise<unknown>) | null {
    var feedback = command.feedbackEndpoint;
    if (feedback) {
        return function () {
            return innertube('feedback', { feedbackTokens: [feedback.feedbackToken], isFeedbackTokenUnencrypted: false, shouldMerge: false });
        };
    }
    // One of the account's on/off settings (Settings' History & data)
    var setting = command.setSettingEndpoint;
    if (setting) {
        return function () {
            return innertube('account/set_setting', { settingItemId: setting.settingItemId, newValue: { boolValue: !!setting.boolValue } });
        };
    }
    var like = command.likeEndpoint;
    if (like) {
        return function () {
            return innertube(LIKES[like.status] || LIKES.INDIFFERENT, { target: like.target, params: like.likeParams || like.dislikeParams || like.removeLikeParams });
        };
    }
    for (var name in ENDPOINTS) {
        if (command[name]) {
            return endpointRequest(name, command);
        }
    }
    return null;
}

/** command sent to ENDPOINTS[name] with its fields */
function endpointRequest(name: string, command: any): () => Promise<unknown> {
    return function () {
        var e = command[name];
        var body: { [key: string]: unknown } = {};
        for (var key in e) {
            body[key] = e[key];
        }
        return innertube(ENDPOINTS[name], body).then(function (r) {
            if (command.playlistEditEndpoint) {
                noteEdit(command.playlistEditEndpoint);
            }
            return r;
        });
    };
}

/** Parses a /next reply */
export function watchInfoOf(reply: any): WatchInfo {
    var results = get(reply, 'contents', 'singleColumnWatchNextResults');
    var meta = first(get(results, 'results'), 'videoMetadataRenderer') || {};
    var owner = get(meta, 'owner', 'videoOwnerRenderer') || {};
    var panels: any[] = (reply && reply.engagementPanels || []).map(function (p: any) { return p.engagementPanelSectionListRenderer || {}; });
    var panel = function (id: string): any { return panels.filter(function (p) { return p.panelIdentifier === id; })[0]; };
    var likes = '';
    all(panel('video-description-ep-identifier'), 'factoidRenderer').forEach(function (f) {
        if (/like/i.test(text(f.label))) {
            likes = text(f.value);
        }
    });
    var sets = get(results, 'autoplay', 'autoplay', 'sets') || [];
    var buttons = get(reply, 'transportControls', 'transportControlsRenderer', 'buttons');
    var likeButton = first(buttons, 'likeButtonRenderer');
    var subscribeButton = first(buttons, 'subscribeButtonRenderer') || first(owner, 'subscribeButtonRenderer');
    var related: Video[] = [];
    rowsOf(get(results, 'pivot')).shelves.forEach(function (s) {
        related = related.concat(s.videos.filter(function (v) { return !v.page; }));
    });
    return {
        title: text(meta.title),
        channel: text(owner.title),
        channelPage: pageOf(owner.navigationEndpoint),
        avatar: picture(owner.thumbnail),
        subscribers: text(owner.subscriberCountText),
        views: text(get(meta, 'viewCount', 'videoViewCountRenderer', 'shortViewCount')) || text(get(meta, 'viewCount', 'videoViewCountRenderer', 'viewCount')),
        age: text(meta.dateText),
        published: text(meta.publishedTimeText),
        likes: likes,
        related: related,
        next: get(sets[0], 'nextVideoRenderer', 'maybeHistoryEndpointRenderer', 'endpoint', 'watchEndpoint', 'videoId') ||
            get(sets[0], 'autoplayVideoRenderer', 'autonavEndpointRenderer', 'endpoint', 'watchEndpoint', 'videoId') || '',
        comments: get(panel('comment-item-section'), 'content', 'sectionListRenderer', 'contents', 0, 'itemSectionRenderer', 'continuations', 0,
            'reloadContinuationData', 'continuation') || '',
        like: likeOf(likeButton),
        subscribe: subscribeOf(subscribeButton),
        chapters: chaptersOf(reply)
    };
}

/** A /next reply's chapters (chapter-type macro markers in its entity updates) */
function chaptersOf(reply: any): Chapter[] {
    var list = (get(reply, 'frameworkUpdates', 'entityBatchUpdate', 'mutations') || []).map(function (m: any) {
        return get(m, 'payload', 'macroMarkersListEntity', 'markersList');
    }).filter(function (l: any) { return l && l.markerType === 'MARKER_TYPE_CHAPTERS'; })[0];
    return (list && list.markers || []).map(function (m: any) {
        return { title: text(m.title), start: +m.startMillis / 1000 };
    }).filter(function (c: Chapter) { return c.title && c.start >= 0; });
}

function likeOf(button: any): WatchInfo['like'] {
    if (!button || button.likesAllowed === false) {
        return null;
    }
    var commands: { [status: string]: any } = {};
    (button.serviceEndpoints || []).forEach(function (e: any) {
        if (e.likeEndpoint) {
            commands[e.likeEndpoint.status] = e;
        }
    });
    return { status: button.likeStatus || 'INDIFFERENT', commands: commands };
}

export function subscribeOf(button: any): Subscribe | null {
    var on = first(button, 'subscribeEndpoint');
    var off = first(button, 'unsubscribeEndpoint');
    if (!button || button.enabled === false || !on || !off) {
        return null;
    }
    var toggle = first(button, 'subscriptionNotificationToggleButtonRenderer') || {};
    var states = (toggle.states || []).filter(function (s: any) { return s.notificationState; });
    return {
        subscribed: !!button.subscribed,
        on: { subscribeEndpoint: on },
        off: { unsubscribeEndpoint: off },
        bell: states.map(function (s: any) {
            var choice = get(s, 'inlineMenuButton', 'buttonRenderer');
            return { name: text(get(choice, 'text')), command: get(choice, 'serviceEndpoint') };
        }),
        bellAt: states.map(function (s: any) { return s.stateId; }).indexOf(toggle.currentStateId)
    };
}

/** Parses a playlist/get_add_to_playlist reply */
export function saveOptionsOf(reply: any): SaveOption[] {
    return all(reply, 'playlistAddToOptionRenderer').map(function (o: any) {
        return { id: o.playlistId || '', title: text(o.title), saved: o.containsSelectedVideos === 'ALL', add: o.addToPlaylistServiceEndpoint, remove: o.removeFromPlaylistServiceEndpoint };
    });
}

/** Parses a reply to a comments token */
export function commentsOf(reply: any): Comments {
    var part = get(reply, 'continuationContents', 'itemSectionContinuation') || {};
    return {
        list: (part.contents || []).map(function (c: any) {
            return get(c, 'commentThreadRenderer', 'comment', 'commentRenderer');
        }).filter(function (c: any) { return c; }).map(function (c: any) {
            return {
                author: text(c.authorText),
                age: text(c.publishedTimeText),
                text: text(c.contentText),
                likes: text(c.voteCount),
                replies: +c.replyCount || 0
            };
        }),
        next: nextOf(part)
    };
}
