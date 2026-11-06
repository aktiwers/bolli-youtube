// The app's settings, stored on the device (core/store).
// skip: SponsorBlock categories to skip (api/sponsorblock.ts PARTS; empty: off).
// quality: start height (0: Auto, HIGHEST: the most a video has).
// preload: prepare the focused tile's video (player/preload.ts).
// history: report watched videos to YouTube (api/stats.ts).
// captions: subtitle language turned on by default ('' none).
// startSign: show the loading sign on start.
// startPicture: what shows under it until the video moves: 'tile' (its tile's picture), 'frame' (its frame where it
// starts, from the storyboard) or 'none'.

import { load, save } from '../../core/store.js';

export interface Prefs {
    skip: string[];
    theme: string;
    startPage: string;
    quality: number;
    preload: boolean;
    history: boolean;
    autoplay: boolean;
    /** Seconds "Up next" counts down before autoplay (0: at once) */
    autoplayWait: number;
    stableVolume: boolean;
    /** Preview of the focused tile: 'off', 'muted' or 'sound' */
    previews: string;
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
    /** DeArrow (api/dearrow.ts): '' off, 'classic' or 'casual' */
    dearrow: string;
    /** DeArrow's options: 'thumbnails', 'frames' (a random frame where none was chosen), 'tidy' (titles tidied) */
    dearrowOptions: string[];
    /** The Search keyboard's languages picked lately, the one in use first (ui/keyboard-languages.ts; none: the TV's) */
    keyboardRecent: string[];
}

/** The quality "Highest available": 8K's height, so a player picks the most the video and the device allow */
export var HIGHEST = 4320;

var KEY = 'youtube.prefs';
var DEFAULTS: Prefs = { skip: ['sponsor', 'selfpromo', 'interaction', 'intro', 'outro', 'music_offtopic'], theme: 'youtube', startPage: 'home', quality: 0, preload: true, history: true, autoplay: true, autoplayWait: 10, stableVolume: false, previews: 'sound', captions: '', captionStyle: 'words', captionLanguages: [], startSign: true, startPicture: 'tile', sabr: false, pictures: 'sharpest', replays: true, dislikes: true, liveChat: true, dearrow: '',
    dearrowOptions: ['thumbnails', 'frames', 'tidy'], keyboardRecent: [] };

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

export function setPref<K extends keyof Prefs>(name: K, value: Prefs[K]): void {
    prefs()[name] = value;
    stored[name] = value;
    save(KEY, stored);
}
