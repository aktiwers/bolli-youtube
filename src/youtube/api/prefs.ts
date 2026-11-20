// The app's settings, stored on the device (core/store).
// skip: SponsorBlock categories to skip (api/sponsorblock.ts PARTS; empty: off).
// quality: start height (0: Auto, HIGHEST: the most a video has).
// codec: the video codec a start prefers (api/streams.ts preferred): 'auto', 'vp9', 'av1' or 'h264'.
// sound: the audio codec videos play with where they have it (api/streams.ts audioOf): 'auto' or one of its SOUNDS.
// voiceBoost: YouTube's Voice boost copy of a video's sound where it has one (signed-in streams), before stable volume.
// preload: prepare the focused tile's video (player/preload.ts).
// history: report watched videos to YouTube (api/stats.ts).
// captions: subtitle language turned on by default ('' none).
// audioLanguage: the audio a start plays where a video has dubs: '' its own, else its dub in that language (a code)
// where it has one (api/streams.ts startTrack).
// startSign: the sign while a video starts in the app's player: 'off' none, 'channel' its channel's picture filling up,
// or a spinner's id (one of ui/spinner.ts LOADING_SIGNS; once on/off: true and false read as 'channel' and 'off'); the
// account's own, as logo (a theme's shows on top of it: lookSign).
// startPicture: what shows under it until the video moves: 'tile' (its tile's picture), 'frame' (its frame where it
// starts, from the storyboard) or 'none'.
// videoClock: the time of day over a video in the app's player: 'off', 'left' or 'right' (the top corner).
// chaptersPause: the video pauses while its chapters are picked from (Up in the app's player); off by default (it plays on).
// quickJumps: a jump in a video lands in a window of its own, as a start does (player/dash.ts narrow).
// background: the screens' colour, #rrggbb ('' YouTube's dark; a light one takes the light stylesheet: ui/theme.ts
// applyLook). The old pureBlack (on: pure black) is read as '#000000'. sidebar: the rail's colour ('' as the background);
// highlight: the focus's colour ('' YouTube's: white on a dark page, black on a light one); text: the main text's colour
// ('' automatic: YouTube's, or pure white or black where that reads too little); sidebarText: 'on', the sidebar's names and
// icons in that text too ('' the sidebar's own); inputs: the colour of the places one types in ('' YouTube's greys); buttons: the buttons' ('' as the inputs); inputsStyle, buttonsStyle: '' solid, or 'fade', 'glow', 'blend'; font: '' Roboto, else one
// of ui/theme.ts FONTS. icons: how the icons are drawn ('' filled, else one of ui/icons.ts ICON_STYLES); railIcons: the sidebar's
// ('' as the others, else one of ui/rail-icons.ts RAIL_SETS). backgroundStyle, sidebarStyle: '' solid, or a still picture made from the colour ('fade', 'glow', 'blend';
// the background also 'lines', 'dots': ui/theme.ts styleCss). colourRecent: the colours set lately in Settings › Theme › Colours, the last first (views/colour-page.ts).
// subsLayout: where Subscriptions shows its channels: 'side' (a column at the left, as YouTube's TV app), 'top' (round
// pictures in a row over the videos, as YouTube's phone app; views/subscriptions.ts), or '' (as the theme has it:
// ui/theme.ts subsLayout gives the one in force).
// subsRelevant: Subscriptions shows YouTube's own pick of the list ("Most relevant") in a row over it; false: the
// list alone (views/subscriptions.ts).
// homeBig: Home's focused row has bigger tiles, as YouTube's TV app (where the theme has them); off by default: each
// Up or Down then lays two whole rows anew, which halves Home's frames on the TV (2026-11-14: 1.04-1.17 s lost in a
// walk of 16 keys against 0.47-0.79 s without).
// logo: the account's own logo, by its id (ui/logo.ts LOGOS; 'none': no logo), chosen in Settings › Theme › Logo.
// lookLogo, lookSign: the logo and the loading sign of the look chosen in Settings › Theme › Theme, shown on top of the
// account's own and never written over them ('' the look names none: the account's own shows; ui/theme.ts setLook).
// homeIcon, homeName, homeColor: the app's logo, name and tile colour on the TV's home screen (ui/home-screen.ts; webOS).
// chatMode, chatPosition, chatHeight, chatBottom, chatSide, chatPicture, chatBox, chatSize, chatBackground, chatTimes, chatAvatars, chatFade: where a
// live stream's chat shows and how it looks (player/chat-settings.ts).
// channelVideo: a channel's video plays in its banner while the focus rests on Play mix (main.ts preloadFocused).
// listLayout, listPreview, listAutoplay, listNumbers, listDetails, listButtons, listCarryOn, listKeep: a playlist's page
// (views/list-stage.ts); listNext, listDown, listSide: the playlist in the player (player/list-panel.ts).
// shortcuts: the remote's spare buttons (api/shortcuts.ts, Settings › Shortcuts: views/shortcuts.ts).
// screenOff: how the screen goes black while the sound plays on (ui/screen-off.ts).
// versionCheck: whether the app asks once a day if a newer version is out, and tells it (api/version-check.ts).

import { KEY as BUTTON } from '../core/keys.js';
import { forget, load, save } from '../core/store.js';
import { LOADING_SIGNS } from '../ui/signs.js';

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
    sound: 'auto' | 'aac' | 'opus' | 'aac51' | 'ac3' | 'eac3' | 'iamf';
    preload: boolean;
    history: boolean;
    autoplay: boolean;
    /** Seconds "Up next" counts down before autoplay (0: at once) */
    autoplayWait: number;
    stableVolume: boolean;
    voiceBoost: boolean;
    /** Preview of the focused tile: 'off', 'muted' or 'sound' */
    previews: string;
    /** A channel's video plays in its banner while the focus rests on Play mix (as Previews says: with sound or without) */
    channelVideo: boolean;
    captions: string;
    /** The audio a start plays where a video has dubs: '' its own (the original), else its dub in the language of that
     * code; the original where it has none such (api/streams.ts startTrack) */
    audioLanguage: string;
    /** Auto-generated subtitles: 'words' (word by word, as YouTube shows them) or 'lines' (two lines at a time) */
    captionStyle: string;
    /** Subtitles' size, a percentage of the stylesheet's (one of CAPTION_SIZES; Settings › Subtitle size, the player's
     * Subtitles › Size) */
    captionSize: number;
    /** Languages added under Settings › Subtitles › More languages (Danish and English are always listed) */
    captionLanguages: string[];
    /** The sign while a video starts in the app's player: one of ui/spinner.ts LOADING_SIGNS ('off': none) */
    startSign: string;
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
    /** The screens' colour, #rrggbb ('' YouTube's dark; ui/theme.ts background) */
    background: string;
    /** The sidebar's colour, #rrggbb ('' as the background) */
    sidebar: string;
    /** The focus's colour, #rrggbb ('' YouTube's) */
    highlight: string;
    /** The app's font: '' YouTube's Roboto, else one of ui/theme.ts FONTS ('system': the TV's own) */
    font: string;
    /** The page's main text, #rrggbb ('' automatic: ui/theme.ts autoText) */
    text: string;
    /** The sidebar's names and icons take the text chosen too: 'on', or '' (the sidebar's own; Settings › Theme › Colours ›
     * Text's "Sidebar too") */
    sidebarText: string;
    /** The colour of the places one types in (the search bars, the text fields), #rrggbb ('' YouTube's greys:
     * ui/theme.ts inputRules) */
    inputs: string;
    /** The buttons' colour, #rrggbb ('' as the inputs) */
    buttons: string;
    /** How the icons are drawn: '' filled (as YouTube's TV app), or one of ui/icons.ts ICON_STYLES */
    icons: string;
    /** The sidebar's icons: '' as the others (icons), or a set of its own (ui/rail-icons.ts RAIL_SETS) */
    railIcons: string;
    /** The look as last made one's own (Settings › Theme › Theme's Custom, kept when another look is chosen: ui/theme.ts
     * keepCustom), its parts by name; null: none yet */
    customLook: { [part: string]: string } | null;
    /** The looks saved under a name (Settings › Theme › Theme's "Save as a theme…"): offered beside the built-in ones */
    savedLooks: { id: string; name: string; parts: { [part: string]: string } }[];
    /** The background's and the sidebar's style: '' solid, or one of ui/theme.ts STYLES (SIDEBAR_STYLES) */
    backgroundStyle: string;
    sidebarStyle: string;
    /** The inputs' and the buttons' style: '' solid, or one of ui/theme.ts SIDEBAR_STYLES */
    inputsStyle: string;
    buttonsStyle: string;
    /** "Who's watching?" (and the sign-in from it): in one of the looks of Settings › Theme › Theme (ui/theme.ts LOOKS,
     * by id), the same for everyone, or 'mine', this account's own (ui/theme.ts plainLook) */
    whoLook: string;
    /** Subscriptions' channels: in a column at the 'side' (YouTube's TV app's layout) or in a row at the 'top' (its phone
     * app's; views/subscriptions.ts); '': where the theme has them (ui/theme.ts subsLayout) */
    subsLayout: string;
    /** Subscriptions shows YouTube's own pick of the list ("Most relevant") in a row over it; false: the list alone
     * (views/subscriptions.ts) */
    subsRelevant: boolean;
    /** Home's focused row has bigger tiles (main.ts homeBig) */
    homeBig: boolean;
    /** The account's own logo: a logo's id in ui/logo.ts LOGOS (one no longer listed: the first), the account's
     * picture, a custom one, or none (drawn where the look chosen names none: lookLogo) */
    logo: string;
    /** The logo of the look chosen in Settings › Theme › Theme, drawn on top of the account's own (ui/logo.ts
     * logoValue's; '' none: the account's own) */
    lookLogo: string;
    /** The loading sign of the look chosen, shown on top of the account's own startSign (one of ui/spinner.ts
     * LOADING_SIGNS; '' none: the account's own) */
    lookSign: string;
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
    /** The colours set lately in Settings › Theme › Colours, the last first, five at most (#rrggbb; views/colour-page.ts) */
    colourRecent: string[];
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
 * picture: the tile shows it (a logo); round: drawn as a circle (the account's);
 * tile: it shows a sign instead ('add': a plus, the tile adds a choice; 'none': a struck circle, it stands for
 * nothing); removable: OK held on it asks to remove it */
export interface Choice {
    value: Value;
    name: string;
    note: string;
    picture?: string;
    round?: boolean;
    tile?: 'add' | 'none';
    removable?: boolean;
    /** Shown but not to be chosen (greyed, OK does nothing): its note says why */
    off?: boolean;
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

/** A setting offered by name and choices (the player's settings list: Settings › Playback › Playlists in the player) */
export interface ChoiceSetting {
    label: string;
    choices: Choices;
}

/** The quality "Highest available": 8K's height, so a player picks the most the video and the device allow */
export var HIGHEST = 4320;

/** The settings of the TV, shared by everyone on it: the app's entry on the TV's home screen (one there is) and the
 * version check (the app on this TV, not a person). Every other setting is each account's own (and the guest's): the
 * look, the player, the language, the shortcuts... (settings made by one user stay that user's: someone else who signs
 * in has their own) */
var SHARED: { [name: string]: boolean } = { homeIcon: true, homeName: true, homeColor: true, versionCheck: true };

/** The TV's store: the shared settings, and every setting from before they were each account's, until an account
 * takes them (ownerIs) */
var KEY = 'youtube.prefs';
/** An account's own settings: OWN_KEY + its key (accountOwner) */
var OWN_KEY = 'youtube.prefs.';
/** The account whose settings are in use (none yet: the TV store's), kept so a start has them at once, before
 * youtube.com's page tells who is signed in */
var OWNER_KEY = 'youtube.prefsOwner';
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
/** The subtitle sizes offered (Settings › Subtitle size, the player's Subtitles › Size): percentages of the stylesheet's
 * size, 20 to 150 in steps of 5, then 175 and 200 (as small as 20 %, no larger than 200) */
export var CAPTION_SIZES = (function (): number[] {
    var sizes: number[] = [];
    for (var size = 20; size <= 150; size += 5) {
        sizes.push(size);
    }
    return sizes.concat([175, 200]);
})();

var DEFAULTS: Prefs = { skip: ['sponsor', 'selfpromo', 'interaction', 'intro', 'outro', 'music_offtopic'], theme: 'youtube', startPage: 'home', quality: 0, codec: 'auto', sound: 'auto', preload: true, history: true, autoplay: true, autoplayWait: 10, stableVolume: false, voiceBoost: false, previews: 'sound', channelVideo: true, captions: '', audioLanguage: '', captionStyle: 'words', captionSize: 100, captionLanguages: [], startSign: 'channel', startPicture: 'tile', sabr: false, pictures: 'sharpest', replays: true, dislikes: true, liveChat: true, chatMode: 'over', chatPosition: 'right', chatHeight: 'tall', chatBottom: 'ticker', chatSide: 'right', chatPicture: 'fit', chatBox: null, chatSize: 'normal', chatBackground: 'bubbles', chatTimes: false, chatAvatars: false, chatFade: 0,
    listLayout: 'stage', listPreview: 'sound', listAutoplay: true, listNumbers: 'charts', listDetails: true, listButtons: ['play', 'shuffle', 'repeat', 'save', 'shortcut'],
    listCarryOn: true, listKeep: true, listNext: 0, listDown: 'row', listSide: 'over', videoClock: 'off', chaptersPause: false, quickJumps: true, background: '', sidebar: '', highlight: '', text: '', sidebarText: '', inputs: '', buttons: '', icons: '', railIcons: '', customLook: null, savedLooks: [], font: '', backgroundStyle: '', sidebarStyle: '', inputsStyle: '', buttonsStyle: '', whoLook: 'dark', subsLayout: '', homeBig: false, subsRelevant: true, logo: 'red', lookLogo: '', lookSign: '', homeIcon: 'red', homeName: '', homeColor: '', dearrow: '',
    dearrowOptions: ['thumbnails', 'frames', 'tidy'], keyboardRecent: [], colourRecent: [], shortcuts: SHORTCUTS,
    screenOff: 'iris', castWakes: false, screenWake: 'any', versionCheck: 'notify' };

/** Read once (they are read on every key) and updated by setPref. Only changed settings are stored, so a new
 * default still applies to the rest: the TV's (shared) and the account's own, or the TV store's whole while no account
 * has taken them */
var kept: Prefs | null = null;
var stored: { [name: string]: unknown } = {};
var device: { [name: string]: unknown } = {};
var own: { [name: string]: unknown } | null = null;
var owner = '';

export function prefs(): Prefs {
    if (kept) {
        return kept;
    }
    device = load<{ [name: string]: unknown }>(KEY) || {};
    owner = load<string>(OWNER_KEY) || '';
    own = owner ? load<{ [name: string]: unknown }>(OWN_KEY + owner) || {} : null;
    // (one of OWN_KEYS made an account's own after an account took the settings: the account in use takes it too)
    if (owner) {
        takeOwn(owner);
    }
    stored = {};
    var name: string;
    for (name in device) {
        if (!own || SHARED[name]) {
            stored[name] = device[name];
        }
    }
    for (name in own || {}) {
        if (!SHARED[name]) {
            stored[name] = own![name];
        }
    }
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
    // The fallback to YouTube's player is gone: only offered, for what only it plays (player/own-player.ts giveUp)
    delete stored.fallbackPlayer;
    // Pure black on is now the black background
    if (stored.pureBlack === true && !stored.background) {
        stored.background = '#000000';
    }
    delete stored.pureBlack;
    // The version check's setting is one of three: anything else stored (a plain on or off) gives way to the default
    if (stored.versionCheck !== 'notify' && stored.versionCheck !== 'quiet' && stored.versionCheck !== 'off') {
        delete stored.versionCheck;
    }
    // The loading sign is one of several now: on was the channel's picture filling up, off none; anything else that is
    // not a sign's id (one taken out, a typo) gives way to the default: the account's own the channel's picture, a
    // look's none on top (the account's own shows)
    if (typeof stored.startSign === 'boolean') {
        stored.startSign = stored.startSign ? 'channel' : 'off';
    }
    if (LOADING_SIGNS.indexOf(stored.startSign as string) < 0) {
        delete stored.startSign;
    }
    if (LOADING_SIGNS.indexOf(stored.lookSign as string) < 0) {
        delete stored.lookSign;
    }
    // (a subtitle size not offered: the stylesheet's own)
    if (CAPTION_SIZES.indexOf(stored.captionSize as number) < 0) {
        delete stored.captionSize;
    }
    var read: { [name: string]: unknown } = {};
    for (name in DEFAULTS) {
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
    var changes: { [name: string]: unknown } = {};
    changes[name as string] = value;
    setPrefs(changes as Partial<Prefs>);
}

/** Several settings at once, each store written once (Settings › Theme's look: four of them) */
export function setPrefs(changes: Partial<Prefs>): void {
    var all = prefs() as unknown as { [name: string]: unknown };
    var mine = false;
    var tv = false;
    for (var name in changes) {
        var value = (changes as { [name: string]: unknown })[name];
        all[name] = stored[name] = value;
        if (own && !SHARED[name]) {
            own[name] = value;
            mine = true;
        } else {
            device[name] = value;
            tv = true;
        }
    }
    if (mine) {
        save(OWN_KEY + owner, own);
    }
    if (tv) {
        save(KEY, device);
    }
}

/** A store key of the account whose settings are in use (base itself while none has taken them): what else is each
 * account's own (api/suggest.ts recent searches) */
export function ownKey(base: string): string {
    prefs();
    return owner ? base + '.' + owner : base;
}

/** The account signed in now (account: its key, '' a guest) takes the settings in use: the first one to come (this
 * version's first start) takes the TV store's, which become its own (nothing changes then); another account's own
 * come in place of those in use (one never seen: the defaults, in the language in use). language: the app's language
 * now. Returns null where nothing changed, else what the new account's settings need: its language (the caller
 * restarts the app where it differs) */
export function ownerIs(account: string, language: string): { language: string } | null {
    var key = account || 'guest';
    prefs();
    if (owner === key) {
        return null;
    }
    if (!owner) {
        // The settings from before become this account's own, as its recent searches; the TV store keeps the shared.
        // Each step only once the one before it is kept: a full storage leaves them as they were, taken at a later
        // start (a copy kept from a try before is added to, not lost)
        var mine = load<{ [name: string]: unknown }>(OWN_KEY + key) || {};
        mine.language = language;
        var name: string;
        for (name in device) {
            if (!SHARED[name]) {
                mine[name] = device[name];
            }
        }
        if (!save(OWN_KEY + key, mine) || !save(OWNER_KEY, key)) {
            return null;
        }
        for (name in mine) {
            delete device[name];
        }
        save(KEY, device);
        takeOwn(key);
        kept = null;
        return null;
    }
    // The one leaving keeps its language; the one coming has its own (or, never seen, the one in use)
    if (own) {
        own.language = language;
        save(OWN_KEY + owner, own);
    }
    var theirs = load<{ [name: string]: unknown }>(OWN_KEY + key) || {};
    save(OWNER_KEY, key);
    kept = null;
    return { language: typeof theirs.language === 'string' && theirs.language ? theirs.language as string : language };
}

/** What else each account has of its own besides its settings, kept under ownKey: its recent searches
 * (api/suggest.ts), the video it closed last (main.ts playLast), the channels it looked at (api/looked.ts). The
 * first account takes the TV's from before (ownerIs). tests/youtube-own-tripwire checks that every key the app stores
 * is here or reviewed as the TV's */
export var OWN_KEYS = ['youtube.recentSearches', 'youtube.lastVideo', 'youtube.looked'];

/** The TV's OWN_KEYS from before become account's own (where it has none of its own yet) */
function takeOwn(account: string): void {
    OWN_KEYS.forEach(function (base) {
        var value = load<unknown>(base);
        if (value !== null) {
            // (kept until the account's copy is: a full storage leaves it for a later start)
            if (load<unknown>(base + '.' + account) !== null || save(base + '.' + account, value)) {
                forget(base);
            }
        }
    });
}

/** The settings that are the TV's (SHARED), for tests/youtube-own-tripwire */
export function sharedSettings(): string[] {
    return Object.keys(SHARED).sort();
}
