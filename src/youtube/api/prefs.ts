// The app's settings, stored on the device (core/store).
// skip: SponsorBlock categories to skip (api/sponsorblock.ts PARTS; empty: off).
// quality: start height (0: Auto, HIGHEST: the most a video has).
// codec: the video codec a start prefers (api/streams.ts preferred): 'auto', 'vp9', 'av1' or 'h264'.
// preload: prepare the focused tile's video (player/preload.ts).
// history: report watched videos to YouTube (api/stats.ts).
// captions: subtitle language turned on by default ('' none).
// startSign: show the loading sign on start.
// startPicture: what shows under it until the video moves: 'tile' (its tile's picture), 'frame' (its frame where it
// starts, from the storyboard) or 'none'.
// videoClock: the time of day over a video in the app's player: 'off', 'left' or 'right' (the top corner).
// chaptersPause: the video pauses while its chapters are picked from (Up in the app's player).
// quickJumps: a jump in a video lands in a window of its own, as a start does (player/dash.ts narrow).
// pureBlack: the screens' background pure black instead of the theme's dark grey (ui/theme.ts applyBlack).
// subsLayout: where Subscriptions shows its channels: 'side' (a column at the left, as YouTube's TV app), 'top' (round
// pictures in a row over the videos, as YouTube's phone app; views/subscriptions.ts), or '' (as the theme has it:
// ui/theme.ts subsLayout gives the one in force).
// subsRelevant: Subscriptions shows YouTube's own pick of the list ("Most relevant") in a row over it; false: the
// list alone (views/subscriptions.ts).
// homeBig: Home's focused row has bigger tiles, as YouTube's TV app (where the theme has them); off by default: each
// Up or Down then lays two whole rows anew, which halves Home's frames on the TV (2026-11-14: 1.04-1.17 s lost in a
// walk of 16 keys against 0.47-0.79 s without).
// logo: the logo the app draws, by its id (ui/logo.ts LOGOS; 'none': no logo).
// homeIcon, homeName, homeColor: the app's logo, name and tile colour on the TV's home screen (ui/home-screen.ts; webOS).
// chatMode, chatPosition, chatHeight, chatBottom, chatSide, chatPicture, chatBox, chatSize, chatBackground, chatTimes, chatAvatars, chatFade: where a
// live stream's chat shows and how it looks (player/chat-settings.ts).
// channelVideo: a channel's video plays in its banner while the focus rests on Play mix (main.ts preloadFocused).
// listLayout, listPreview, listAutoplay, listNumbers, listDetails, listButtons, listCarryOn, listKeep: a playlist's page
// (views/list-stage.ts); listNext, listDown, listSide: the playlist in the player (player/list-panel.ts).
// shortcuts: the remote's spare buttons (api/shortcuts.ts, Settings › Shortcuts: views/shortcuts.ts).
// screenOff: how the screen goes black while the sound plays on (ui/screen-off.ts).
// versionCheck: whether the app asks once a day if a newer version is out, and tells it (api/version-check.ts).
// fallbackPlayer: a video the app's player cannot play at all goes to YouTube's player (player/own-player.ts fallback).

import { KEY as BUTTON } from '../core/keys.js';
import { load, save } from '../core/store.js';

/** A box on the screen, in layout units (1280 x 720) */
export interface ChatBox {
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface Prefs {
    skip: string[];
    theme: string;
    startPage: string;
    quality: number;
    codec: 'auto' | 'vp9' | 'av1' | 'h264';
    preload: boolean;
    history: boolean;
    autoplay: boolean;
    /** Seconds "Up next" counts down before autoplay (0: at once) */
    autoplayWait: number;
    stableVolume: boolean;
    /** Preview of the focused tile: 'off', 'muted' or 'sound' */
    previews: string;
    /** A channel's video plays in its banner while the focus rests on Play mix (as Previews says: with sound or without) */
    channelVideo: boolean;
    captions: string;
    /** Auto-generated subtitles: 'words' (word by word, as YouTube shows them) or 'lines' (two lines at a time) */
    captionStyle: string;
    /** Languages added under Settings › Subtitles › More languages (Danish and English are always listed) */
    captionLanguages: string[];
    startSign: boolean;
    startPicture: string;
    /** Fetch streams by SABR first (api/streams.ts playableStreams) */
    sabr: boolean;
    /** Tile thumbnail size: 'standard' (320 px wide), 'sharp' (480) or 'sharpest' (640) */
    pictures: string;
    /** YouTube's most replayed graph over the player's progress bar (api/replays.ts) */
    replays: boolean;
    /** Dislike counts from Return YouTube Dislike on the watch page (api/dislikes.ts) */
    dislikes: boolean;
    /** A live stream's chat beside the picture (player/chat-view.ts) */
    liveChat: boolean;
    /** 'over' the picture, or 'beside' it (at chatSide) */
    chatMode: string;
    /** Over the picture: 'right', 'left', 'bottom' or 'custom' (chatBox) */
    chatPosition: string;
    /** At the right or left: 'full' (the whole height), 'tall' (between the top and the controls) or 'half' (the lower
     * half of that) */
    chatHeight: string;
    /** A strip (over the picture at the bottom, or beside it at the bottom or top): 'ticker' (running across), 'band'
     * (the last three lines) or 'one' (one at a time) */
    chatBottom: string;
    /** Beside the picture: at the 'right', 'left', 'bottom' or 'top' (a strip as along the bottom, chatBottom its style) */
    chatSide: string;
    /** Beside the picture as a one-line strip: the picture 'fit' (whole, an even border) or 'fill' (zoomed to the screen's
     * width; a band: always whole) */
    chatPicture: string;
    /** Custom: its box (null: none set yet) */
    chatBox: ChatBox | null;
    /** 'tiny', 'small', 'normal' or 'large' (its width and text together) */
    chatSize: string;
    /** Behind its messages: 'bubbles' (one each), 'panel' (one behind them all) or 'none' (outlined text) */
    chatBackground: string;
    /** Each message's time, and its author's picture (a picture each from YouTube) */
    chatTimes: boolean;
    chatAvatars: boolean;
    /** Messages fade out after this many seconds (0: they stay) */
    chatFade: number;
    /** A playlist's page: the video the focus is on in a frame beside the list ('stage') or filling the screen behind the
     * page ('backdrop') */
    listLayout: string;
    /** What the frame shows: the video playing with sound ('sound') or without ('muted'), its picture only ('still'), or
     * as Previews says ('previews') */
    listPreview: string;
    /** At a video's end the frame plays the next (in the playlist's order or Shuffle's); off: a preview of at most 90 s */
    listAutoplay: boolean;
    /** A number before each video: on YouTube's charts ('charts'), on every playlist ('all') or none ('off') */
    listNumbers: string;
    /** The video's title, channel, views, likes and description under the frame */
    listDetails: boolean;
    /** Its buttons: 'play' (Play all), 'shuffle', 'repeat' (a switch), 'save' (YouTube's Save to library), 'shortcut' (a
     * button of the remote for it: views/shortcuts.ts) */
    listButtons: string[];
    /** OK on one of its videos carries on from where the preview got to (else from the start) */
    listCarryOn: boolean;
    /** The preview keeps playing while the focus is on the buttons */
    listKeep: boolean;
    /** At the end of a video played from a playlist, its next: -1 off, else after Up next's count of so many seconds (0:
     * at once), whatever Autoplay says */
    listNext: number;
    /** Down in a video played from a playlist: the watch page with the playlist as its first row ('row'), the playlist as
     * a strip across the bottom first ('strip'), at the side first ('side'), or the watch page with a Playlist button
     * opening it at the side ('button') */
    listDown: string;
    /** The playlist at the side: over the picture ('over') or beside it ('beside', the picture narrower) */
    listSide: string;
    /** The clock over a video in the app's player: 'off', 'left' or 'right' (player/own-player.ts) */
    videoClock: string;
    /** The video pauses while its chapter row is open (player/own-player.ts openChapters) */
    chaptersPause: boolean;
    /** Jumps in a video show their picture at once (Engine.quick: what was loaded past the landing's next seconds is
     * loaded again) */
    quickJumps: boolean;
    /** The screens' background pure black (OLED: pixels off) instead of the theme's dark grey (ui/theme.ts) */
    pureBlack: boolean;
    /** Subscriptions' channels: in a column at the 'side' (YouTube's TV app's layout) or in a row at the 'top' (its phone
     * app's; views/subscriptions.ts); '': where the theme has them (ui/theme.ts subsLayout) */
    subsLayout: string;
    /** Subscriptions shows YouTube's own pick of the list ("Most relevant") in a row over it; false: the list alone
     * (views/subscriptions.ts) */
    subsRelevant: boolean;
    /** Home's focused row has bigger tiles (main.ts homeBig) */
    homeBig: boolean;
    /** The logo the app draws: a logo's id in ui/logo.ts LOGOS (one no longer listed: the first), the account's
     * picture, a custom one, or none */
    logo: string;
    /** The app's logo on the TV's home screen: a logo's id in ui/logo.ts LOGOS, or a custom one's value
     * (ui/custom-logos.ts) */
    homeIcon: string;
    /** The app's name on the TV's home screen ('': the package's own) */
    homeName: string;
    /** The colour of the app's tile on the TV's home screen, as #rrggbb ('': the package's own) */
    homeColor: string;
    /** DeArrow (api/dearrow.ts): '' off, 'classic' or 'casual' */
    dearrow: string;
    /** DeArrow's options: 'thumbnails', 'frames' (a random frame where none was chosen), 'tidy' (titles tidied) */
    dearrowOptions: string[];
    /** The Search keyboard's languages picked lately, the one in use first (ui/keyboard-languages.ts; none: the TV's) */
    keyboardRecent: string[];
    /** The remote's spare buttons (api/shortcuts.ts) */
    shortcuts: Shortcut[];
    /** How the screen goes off: 'iris' (Film iris), 'crt' (Old TV), 'shutter', 'curtain', 'blinds', 'sweep', 'fade'
     * (Slow fade), 'random' (one of those each time) or 'none' (ui/screen-off.ts) */
    screenOff: string;
    /** A video cast from a phone while the screen is off wakes it (else it plays on in the dark: main.ts castPlay) */
    castWakes: boolean;
    /** What wakes the screen while it is off: 'any' button, or only the Screen off shortcut's 'button' (none set: any;
     * ui/screen-off.ts) */
    screenWake: string;
    /** The version check (api/version-check.ts): 'notify' (once a day the app asks whether a newer version is out,
     * and tells of one), 'quiet' (it asks, and tells nothing) or 'off' (it asks nothing) */
    versionCheck: string;
    /** A video the app's player cannot play at all (its format, the decoder, a refusal: never the connection) is handed
     * to YouTube's player; off: it stays in the app's player, which says so (player/own-player.ts fallback) */
    fallbackPlayer: boolean;
}

/** A button's shortcut (api/shortcuts.ts): key (its key code), where it works ('everywhere', 'screens': not in the
 * player, 'player': only there) and what it does: an action's name, a channel's way with its id ('channel:videos:UC…')
 * or a playlist's ('playlist:shuffle:PL…'), those with what opens them (target) */
export interface Shortcut {
    key: number;
    where: string;
    action: string;
    target?: ShortcutTarget;
}

/** A channel's or a playlist's shortcut: its name; a channel's page (null: unknown) and its videos, newest first */
export interface ShortcutTarget {
    title: string;
    channel?: { browseId: string; params?: string } | null;
    videos?: { browseId: string; params?: string } | null;
}

/** A choice's value (an on/off pref's: true or false) */
export type Value = string | number | boolean;

/** A setting's choice: value, name, note ('' for none). In a grid of tiles (views/settings.ts; ui/choice-button.ts):
 * picture: the tile shows it (a logo); round: drawn as a circle (the account's); color: the tile is that colour;
 * tile: it shows a sign instead ('add': a plus, the tile adds a choice; 'none': a struck circle, it stands for
 * nothing); removable: OK held on it asks to remove it */
export interface Choice {
    value: Value;
    name: string;
    note: string;
    picture?: string;
    round?: boolean;
    color?: string;
    tile?: 'add' | 'none';
    removable?: boolean;
}

/** A setting's choices (views/settings.ts, also the player's settings list): list, isSet, choose; many: several can be
 * set (OK toggles one) */
export interface Choices {
    list: () => Choice[];
    isSet: (value: Value) => boolean;
    choose: (value: Value) => void;
    many?: boolean;
}

/** How a setting is set: its set choices' names ('' none) */
export function setNames(c: Choices): string {
    return c.list().filter(function (one) { return c.isSet(one.value); }).map(function (one) { return one.name; }).join(', ');
}

/** A setting offered by name and choices (the player's settings list: Settings › Playlists' player settings) */
export interface ChoiceSetting {
    label: string;
    choices: Choices;
}

/** The quality "Highest available": 8K's height, so a player picks the most the video and the device allow */
export var HIGHEST = 4320;

var KEY = 'youtube.prefs';
/** The default shortcuts: the numbers the rail's screens in its order from Home (9 Search, 0 Settings),
 * everywhere; the colours on the screens Screen off, Watch later, Continue the last video, History, in a video Screen
 * off, Subtitles, Save to Watch later, Live chat; in a video P+ / P− the next and previous video, List the playlist,
 * Guide Like; Screen remote (the other side of 0) Subscribe / unsubscribe everywhere */
var SHORTCUTS: Shortcut[] = [];
['settings', 'home', 'subscriptions', 'library', 'gaming', 'podcasts', 'music', 'movies', 'sports', 'search'].forEach(function (id, n) {
    SHORTCUTS.push({ key: BUTTON.NUM_0 + n, where: 'everywhere', action: 'section:' + id });
});
SHORTCUTS.push({ key: BUTTON.RED, where: 'everywhere', action: 'screenOff' },
    { key: BUTTON.GREEN, where: 'screens', action: 'watchLater' }, { key: BUTTON.GREEN, where: 'player', action: 'subtitles' },
    { key: BUTTON.YELLOW, where: 'screens', action: 'resume' }, { key: BUTTON.YELLOW, where: 'player', action: 'saveLater' },
    { key: BUTTON.BLUE, where: 'screens', action: 'history' }, { key: BUTTON.BLUE, where: 'player', action: 'chat' },
    { key: BUTTON.CH_UP, where: 'player', action: 'next' }, { key: BUTTON.CH_DOWN, where: 'player', action: 'previous' },
    { key: BUTTON.LIST, where: 'player', action: 'playlist' }, { key: BUTTON.GUIDE, where: 'player', action: 'like' },
    { key: BUTTON.SCREEN_REMOTE, where: 'everywhere', action: 'subscribe' });
var DEFAULTS: Prefs = { skip: ['sponsor', 'selfpromo', 'interaction', 'intro', 'outro', 'music_offtopic'], theme: 'youtube', startPage: 'home', quality: 0, codec: 'auto', preload: true, history: true, autoplay: true, autoplayWait: 10, stableVolume: false, previews: 'sound', channelVideo: true, captions: '', captionStyle: 'words', captionLanguages: [], startSign: true, startPicture: 'tile', sabr: false, pictures: 'sharpest', replays: true, dislikes: true, liveChat: true, chatMode: 'over', chatPosition: 'right', chatHeight: 'tall', chatBottom: 'ticker', chatSide: 'right', chatPicture: 'fit', chatBox: null, chatSize: 'normal', chatBackground: 'bubbles', chatTimes: false, chatAvatars: false, chatFade: 0,
    listLayout: 'stage', listPreview: 'sound', listAutoplay: true, listNumbers: 'charts', listDetails: true, listButtons: ['play', 'shuffle', 'repeat', 'save', 'shortcut'],
    listCarryOn: true, listKeep: true, listNext: 0, listDown: 'row', listSide: 'over', videoClock: 'off', chaptersPause: true, quickJumps: true, pureBlack: false, subsLayout: '', homeBig: false, subsRelevant: true, logo: 'red', homeIcon: 'red', homeName: '', homeColor: '', dearrow: '',
    dearrowOptions: ['thumbnails', 'frames', 'tidy'], keyboardRecent: [], shortcuts: SHORTCUTS,
    screenOff: 'iris', castWakes: false, screenWake: 'any', versionCheck: 'notify', fallbackPlayer: true };

/** Read once (they are read on every key) and updated by setPref. Only changed settings are stored, so a new
 * default still applies to the rest. */
var kept: Prefs | null = null;
var stored: { [name: string]: unknown } = {};

export function prefs(): Prefs {
    if (kept) {
        return kept;
    }
    stored = load<{ [name: string]: unknown }>(KEY) || {};
    // Migrate the old on/off SponsorBlock setting
    if (stored.sponsorBlock === false && !stored.skip) {
        stored.skip = [];
    }
    delete stored.sponsorBlock;
    // The choice of player is gone: the app's own plays all (YouTube's films, and what nothing else plays)
    delete stored.player;
    // Migrate DeArrow's list of parts to its mode and options
    if (stored.dearrow instanceof Array) {
        var parts = stored.dearrow as string[];
        stored.dearrow = parts.length ? 'classic' : '';
        if (parts.length) {
            stored.dearrowOptions = DEFAULTS.dearrowOptions.filter(function (o) { return o === 'tidy' || parts.indexOf(o) >= 0; });
        }
    }
    // The version check's setting is one of three: anything else stored (a plain on or off) gives way to the default
    if (stored.versionCheck !== 'notify' && stored.versionCheck !== 'quiet' && stored.versionCheck !== 'off') {
        delete stored.versionCheck;
    }
    var read: { [name: string]: unknown } = {};
    for (var name in DEFAULTS) {
        // The stored value, else the default (e.g. a setting added since)
        var value = stored[name];
        read[name] = value !== undefined && value !== null && value !== '' ? value : (DEFAULTS as unknown as { [name: string]: unknown })[name];
    }
    kept = read as unknown as Prefs;
    return kept;
}

/** Read again from storage on the next prefs() (after a test restores the stored settings, so stale values are not
 * written back by the next setPref) */
export function reloadPrefs(): void {
    kept = null;
}

/** A setting's default (a copy of a list) */
export function prefDefault<K extends keyof Prefs>(name: K): Prefs[K] {
    var value = DEFAULTS[name];
    return (value instanceof Array ? value.slice() : value) as Prefs[K];
}

export function setPref<K extends keyof Prefs>(name: K, value: Prefs[K]): void {
    prefs()[name] = value;
    stored[name] = value;
    save(KEY, stored);
}
