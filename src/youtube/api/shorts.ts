// The Shorts screen's data (player/shorts.ts), as YouTube's TV app asks for it: reel/reel_item_watch for a Short's
// overlay (title, channel, Subscribe, Like with its count, Comments with theirs, Remix, More's Not interested, the
// description panel, how it loops) and the token of the Shorts that follow it; reel/reel_watch_sequence for those
// Shorts, a dozen a time with a token for more. The sidebar's Shorts entry starts with no Short (seedless, as the TV
// client's guide gives it): the reply's own Short is the first. Ads in a sequence are left out. Replies are parsed off
// the main thread (api/off-thread.ts: the parsers touch nothing of the page); each Short's overlay is kept a while, so
// Up to one seen and a Short asked ahead cost nothing again.

import { get, pageOf, Page, picture, text, Video } from './feed.js';
import { Keeper } from './kept-pages.js';
import { offThread } from './off-thread.js';
import { Subscribe, subscribeOf } from './watch.js';
import { innertubeText } from './youtube.js';

/** A Short's overlay, as reel_item_watch gives it */
export interface Reel {
    id: string;
    title: string;
    /** "2 days ago" */
    age: string;
    /** "@IsmoComedian", its page and picture (null, '': none) */
    handle: string;
    channelPage: Page | null;
    avatar: string;
    subscribe: Subscribe | null;
    /** Like (null: not allowed): LIKE or INDIFFERENT, YouTube's command for each, and the count shown in each state */
    like: { status: string; commands: { [status: string]: any }; counts: { [status: string]: string } } | null;
    /** The comments' token ('' none), their count as YouTube shows it, and the endpoint their parts are asked of */
    comments: string;
    commentCount: string;
    commentsVia: string;
    /** Remix as YouTube words it (null: no Remix): its button's name, and its panel's lines ("Remix on your phone", "Scan
     * the QR code or go to"; '' not given) */
    remix: { title: string; lines: string[] } | null;
    /** More's Not interested: its name and YouTube's command (null: none) */
    notInterested: { title: string; command: any } | null;
    /** The full video it is from (null: none named) */
    link: { id: string; title: string } | null;
    /** The description panel: its three figures (value over label: likes, views, the date) and the text */
    facts: { value: string; label: string }[];
    description: string;
    /** It plays again at its end (else the next Short follows) */
    loop: boolean;
    /** The token of the Shorts that follow it ('' none) */
    next: string;
}

/** A part of a sequence: its Shorts and the token for more */
export interface Sequence {
    shorts: Video[];
    next: string;
}

/** A Short as the screen lists it: its id (its title and channel where known) */
function shortOf(id: string, title: string, channel: string): Video {
    return { short: true, id: id, title: title, channel: channel, length: '', info: '', style: 'short' };
}

/** The Short a Reel is of, for the screen's list */
export function shortOfReel(reel: Reel): Video {
    return shortOf(reel.id, reel.title, reel.handle);
}

/** The sidebar's entry, as the TV client's guide gives its Shorts entry (a reelWatchEndpoint with no videoId) */
var SEEDLESS = { params: 'CA8%3D', inputType: 'REEL_WATCH_INPUT_TYPE_SEEDLESS', playerRequest: { params: '8AEBuAQPkAcC' }, disablePlayerResponse: true };
/** The Shorts' overlays kept: those around the one shown */
var reels = new Keeper<Reel>(10 * 60 * 1000, 6, false, true);

/** A Short's overlay (id '': the sidebar's first Short, YouTube's pick: Reel.id names it). Only the overlay: the player
 * asks for the streams itself */
export function reelItem(id: string): Promise<Reel> {
    var body = id ? { playerRequest: { videoId: id }, disablePlayerResponse: true } : SEEDLESS;
    var ask = function (): Promise<Reel> { return offThread(innertubeText('reel/reel_item_watch', body), 'reel', reelOf, id); };
    // (the first Short of the sidebar's is YouTube's pick of the moment: never kept)
    return id ? reels.get(id, ask) : ask();
}

/** The Shorts after a Short (its Reel.next token), or more of them (a Sequence's next) */
export function reelSequence(token: string): Promise<Sequence> {
    return offThread(innertubeText('reel/reel_watch_sequence', { sequenceParams: token }), 'reelSequence', sequenceOf);
}

/** Parses a reel_item_watch reply (id: the Short asked for, '' none) */
export function reelOf(reply: any, id: string): Reel {
    var o = get(reply, 'overlay', 'reelPlayerOverlayRenderer') || {};
    var header = get(o, 'reelPlayerHeaderSupportedRenderers', 'reelPlayerHeaderRenderer') || {};
    var replacement = get(reply, 'replacementEndpoint', 'reelWatchEndpoint') || {};
    // (the Short asked for, else the one YouTube picked)
    var own = id || replacement.videoId || '';
    var panels: any[] = (reply && reply.engagementPanels || []).map(function (p: any) { return p.engagementPanelSectionListRenderer || {}; });
    var panel = function (tag: string): any { return panels.filter(function (p) { return get(p, 'identifier', 'tag') === tag; })[0]; };
    var reel: Reel = { id: own, title: text(header.reelTitleText), age: text(header.timestampText), handle: text(header.channelTitleText),
        channelPage: pageOf(header.channelNavigationEndpoint) || pageOf(get(header, 'channelTitleText', 'runs', 0, 'navigationEndpoint')),
        avatar: picture(header.channelThumbnail, 0, 48), subscribe: subscribeOf(get(o, 'subscribeButtonRenderer', 'subscribeButtonRenderer')),
        like: null, comments: '', commentCount: '', commentsVia: 'next', remix: null, notInterested: null, link: linkOf(o, own),
        facts: [], description: '', loop: reply && reply.loopBehavior !== 'REEL_LOOP_BEHAVIOR_SINGLE_PLAY',
        next: reply && reply.sequenceContinuation || '' };
    (get(o, 'buttonBar', 'reelActionBarViewModel', 'buttonViewModels') || []).forEach(function (b: any) {
        var model = get(b, 'reelActionBarButtonViewModel', 'buttonViewModel') || {};
        var button = model.buttonViewModel || {};
        if (model.likeButtonViewModel) {
            reel.like = likeOf(model.likeButtonViewModel);
        } else if (/^COMMENT/.test(button.iconName || '')) {
            reel.commentCount = button.title || '';
        } else if (/^REMIX/.test(button.iconName || '')) {
            reel.remix = { title: button.title || '', lines: [] };
        }
    });
    var section = get(panel('shorts-comments-panel'), 'content', 'sectionListRenderer', 'contents', 0, 'itemSectionRenderer') || {};
    reel.comments = get(section, 'continuations', 0, 'reloadContinuationData', 'continuation') || '';
    reel.commentsVia = /BROWSE/.test(section.continuationService || '') ? 'browse' : 'next';
    reel.commentCount = reel.commentCount || text(get(panel('shorts-comments-panel'), 'header', 'engagementPanelTitleHeaderRenderer', 'contextualInfo'));
    if (reel.remix) {
        var labels = get(panel('engagement-panel-shorts-remix-handoff'), 'content', 'sectionListRenderer', 'contents', 0, 'itemSectionRenderer', 'contents', 0,
            'qrCodeRenderer', 'labels') || [];
        reel.remix.lines = [text(labels[0]), text(labels[1])];
    }
    (get(panel('video-description-ep-identifier'), 'content', 'structuredDescriptionContentRenderer', 'items') || []).forEach(function (item: any) {
        var head = item.videoDescriptionHeaderRenderer;
        var body = item.expandableVideoDescriptionBodyRenderer;
        if (head) {
            reel.title = reel.title || text(head.title);
            reel.facts = (head.factoid || []).map(function (f: any) {
                return { value: text(get(f, 'factoidRenderer', 'value')), label: text(get(f, 'factoidRenderer', 'label')) };
            }).filter(function (f: { value: string }) { return f.value; });
        } else if (body) {
            reel.description = text(body.descriptionBodyText) || text(body.attributedDescriptionBodyText);
        }
    });
    var more = get(o, 'moreButton', 'reelMoreButtonRenderer', 'onClickCommand', 'openPopupAction', 'popup', 'overlaySectionRenderer', 'overlay',
        'overlayTwoPanelRenderer', 'actionPanel', 'overlayPanelRenderer', 'content', 'overlayPanelItemListRenderer', 'items') || [];
    more.forEach(function (item: any) {
        var link = item.compactLinkRenderer || {};
        if (get(link, 'icon', 'iconType') === 'NOT_INTERESTED' && link.serviceEndpoint) {
            reel.notInterested = { title: text(link.title), command: link.serviceEndpoint };
        }
    });
    return reel;
}

/** Like's states from its view model: the status (the like status entity's, else the toggle's), each state's command
 * (by the status it sets) and count (null: liking is off) */
function likeOf(model: any): Reel['like'] {
    var toggle = get(model, 'toggleButtonViewModel', 'toggleButtonViewModel') || {};
    var off = get(toggle, 'defaultButtonViewModel', 'buttonViewModel') || {};
    var on = get(toggle, 'toggledButtonViewModel', 'buttonViewModel') || {};
    if (toggle.isTogglingDisabled) {
        return null;
    }
    var like: Reel['like'] = { status: get(model, 'likeStatusEntity', 'likeStatus') || (toggle.isToggled ? 'LIKE' : 'INDIFFERENT'), commands: {},
        counts: { INDIFFERENT: off.title || '', LIKE: on.title || off.title || '' } };
    [off, on].forEach(function (b) {
        var command = get(b, 'onTap', 'innertubeCommand');
        var status = get(command, 'likeEndpoint', 'status');
        if (status) {
            like!.commands[status] = command;
        }
    });
    return like.commands.LIKE ? like : null;
}

/** The full video a Short names (a watchEndpoint to another video in its overlay, with the words of what holds it; null:
 * none). The menus are left out: their commands are no link */
function linkOf(overlay: any, id: string): Reel['link'] {
    var found: Reel['link'] = null;
    var walk = function (v: any, words: string): void {
        if (found || !v || typeof v !== 'object') {
            return;
        }
        var own = text(v.title) || text(v.text) || text(v.displayText) || words;
        var watch = v.watchEndpoint;
        if (watch && watch.videoId && watch.videoId !== id && own) {
            found = { id: watch.videoId, title: own };
            return;
        }
        for (var key in v) {
            if (key !== 'videoReporting' && key !== 'moreButton' && key !== 'subscribeButtonRenderer' && key !== 'accessibility') {
                walk(v[key], own);
            }
        }
    };
    walk(overlay, '');
    return found;
}

/** Parses a reel_watch_sequence reply: its Shorts in order, ads left out, and the token for more */
export function sequenceOf(reply: any): Sequence {
    var shorts: Video[] = [];
    (reply && reply.entries || []).forEach(function (e: any) {
        var w = get(e, 'command', 'reelWatchEndpoint') || {};
        if (!w.videoId || get(w, 'adClientParams', 'isAd') || w.videoType === 'REEL_VIDEO_TYPE_AD') {
            return;
        }
        // (no picture: its 1080x1920 first frame given here is not shown, the video's own first frame is)
        shorts.push(shortOf(w.videoId, '', ''));
    });
    return { shorts: shorts, next: reply && reply.continuation || '' };
}
