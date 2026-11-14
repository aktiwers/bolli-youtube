// Settings in three columns: the categories on the left; the focused one's
// settings in the middle, each with how it is set under its name (small
// headings among them); the focused setting on the right, in the look of
// YouTube's TV app's (picture, description, choices as buttons with the set
// one ticked, a note on the focused choice). A category of one setting (a
// page of its own, Live chat) shows it on the right at once, wide, without the
// middle. Right or OK go a column further (a page opens); OK sets a choice
// (or toggles it where several can be set); Left or Back go back a column,
// then to the rail. Each category keeps the setting it was on while the app
// runs; the lists keep the focused row centred once they scroll. The
// categories: the app's own settings (api/prefs.ts, saved at once), Account
// & phone (phone linking, and the account's History & data settings that
// have an effect here, fetched when Settings shows), then About (the version,
// a newer one that is out, the device; under it Check for new versions, in
// a build that checks). Clearing a history asks first, with YouTube's
// question.

import { h, keepCentred, setShown, setSrc, setText, toggleClass, translate } from '../core/dom.js';
import { language, LANGUAGES, setLanguage, tr } from '../core/i18n.js';
import { KEY } from '../core/keys.js';
import { holding, takesPointer } from '../core/pointer.js';
import { android, oldEngine } from '../core/platform.js';
import { View } from '../core/view.js';
import { AccountGroup, AccountSetting, historySettings } from '../api/account-settings.js';
import { Ask } from '../api/feed.js';
import { ALWAYS, languageName, offeredLanguages } from '../api/languages.js';
import { Choice, Choices, ChoiceSetting, HIGHEST, prefDefault, prefs, Prefs, setNames, setPref, Value } from '../api/prefs.js';
import { keyName, shortcutOf, shortcuts } from '../api/shortcuts.js';
import { PARTS } from '../api/sponsorblock.js';
import { codecPlays } from '../api/streams.js';
import { hasVersionCheck, newerVersion } from '../api/version-check.js';
import { apply, askToClear } from '../ui/account.js';
import { choiceButton, choiceTile } from '../ui/choice-button.js';
import { keyboardFor, recentWith } from '../ui/keyboard-languages.js';
import { LanguagePicker } from '../ui/language-picker.js';
import { ADD, customOf, FULL, NOT_KEPT, removeCustomLogo } from '../ui/custom-logos.js';
import { APP_NAME, COLOR_COLUMNS, hasHomeLogos, hasHomeScreen, homeColor, homeColorChoices, homeIconChoices, homeLogoPicture, homeName, NO_CHANNEL, NO_ENTRY, NO_FILE,
    NO_ROOT, onHomeRefused, setHomeColor, setHomeIcon, setHomeName, shownHomeIcon, takeCustomIcon } from '../ui/home-screen.js';
import { ACCOUNT, chooseLogo, drawLogo, logoChoices, logoFile, LOGOS, shownLogo, takeAccountLogo, takeCustomLogo } from '../ui/logo.js';
import { TextPage } from '../ui/text-page.js';
import { CAPTION_STYLES } from '../player/captions.js';
import { ChatSettings, chatSummary } from '../player/chat-settings.js';
import { Question } from '../ui/question.js';
import { NOT_PICTURE, TOO_BIG, TOO_LARGE } from '../ui/pictures.js';
import { PROBLEM, toast } from '../ui/toast.js';
import { screenOff } from '../ui/screen-off.js';
import { applyBlack, applyTheme, subsLayout, themes } from '../ui/theme.js';
import { ShortcutHost, ShortcutsPage } from './shortcuts.js';

/** A setting: name, description, picture ('' for none); its choices, or the steps to link a phone (code: shows a TV
 * code, for a phone on another network), or lines to read (info: asked each time it is drawn); open: Right or OK opens
 * its own page (its one choice too, its note always shown) */
interface Setting {
    label: string;
    summary: string;
    /** Its picture at the top of the right side ('' none; a function: asked each time it is drawn) */
    picture: string | (() => string);
    choices?: Choices;
    steps?: string[];
    code?: boolean;
    info?: () => string[];
    open?: () => void;
    /** Its choices are tiles in a grid of this many columns (the Branding settings: the arrows move in it, OK held
     * removes a removable one); its top is small and stays while only the tiles scroll */
    grid?: number;
}

/** A page of Settings' own over it: it takes every key while shown */
interface SubPage {
    shown: boolean;
    onKey(code: number): boolean;
    layer(): HTMLElement | null;
    close(): void;
}

/** A rail page the app can start on */
export interface StartPage {
    id: string;
    label: string;
}

/** Focus resting this long on "Link with TV code" requests a code from YouTube */
var CODE_REST_MS = 300;
/** How long YouTube's TV code stays valid */
var CODE_MS = 5 * 60000;
/** Margin keeping the focused choice inside the right side's view */
var ROOM = 24;

/** YouTube's settings picture by name (reused for the app's own settings) */
function pic(name: string): string {
    return 'https://www.gstatic.com/ytlr/img/' + name + '.png';
}

/** A setting with choices (a list, or made when shown): now() gives the set value, set() changes it */
function pick(label: string, summary: string, picture: string | (() => string), list: Choice[] | (() => Choice[]), now: () => Value,
    set: (value: Value) => void): Setting {
    return { label: label, summary: summary, picture: picture, choices: { list: typeof list === 'function' ? list : function () { return list as Choice[]; },
        isSet: function (value) { return value === now(); }, choose: set } };
}

/** An app pref with choices (then: called after a choice) */
function pref<K extends keyof Prefs>(label: string, summary: string, picture: string, name: K, list: Choice[] | (() => Choice[]),
    then?: (value: Value) => void): Setting {
    return pick(label, summary, picture, list, function () { return prefs()[name] as unknown as Value; }, function (value) {
        setPref(name, value as unknown as Prefs[K]);
        if (then) {
            then(value);
        }
    });
}

/** An on/off setting's choices, with notes for on and off */
function onOff(on: string, off: string): Choice[] {
    return [{ value: true, name: tr('On'), note: on }, { value: false, name: tr('Off'), note: off }];
}

/** What comes at a video's end: nothing (-1: the player closes), the next video at once (0), or after an "Up next"
 * countdown of so many seconds (Autoplay, Next in a playlist) */
function waits(): Choice[] {
    var after = function (s: number): Choice {
        return { value: s, name: tr('After {1} seconds', s), note: tr('"Up next" counts down, then the next video plays') };
    };
    return [
        { value: -1, name: tr('Off'), note: tr('the player closes at a video\'s end') },
        { value: 0, name: tr('Right away'), note: tr('the next video plays at once') },
        after(3), after(5), after(10)
    ];
}

/** Autoplay: off, or the next video after an "Up next" countdown of so many seconds (overrides the account's own
 * autoplay setting) */
function autoplay(): Setting {
    return pick(tr('Autoplay'), tr('When a video ends in Bolli\'s player, the next one plays. When on, this overrides your YouTube account\'s autoplay setting.'),
        pic('autoplay'), waits, function () {
            return prefs().autoplay ? prefs().autoplayWait : -1;
        }, function (value) {
            var seconds = value as number;
            setPref('autoplay', seconds >= 0);
            if (seconds >= 0) {
                setPref('autoplayWait', seconds);
            }
        });
}

/** Value of the "More languages" choice in Subtitles */
var MORE = '+';

/** Subtitles turned on automatically: a language (the app's, the default ones, those added via "More languages"); a
 * choice in the player sets it too. more: opens the search over all languages */
function subtitles(more: () => void): Setting {
    return pick(tr('Subtitles'), tr('Subtitles Bolli\'s player turns on by itself'), pic('language'), function () {
        var now = prefs().captions;
        var on = tr('on in every video with subtitles, translated by YouTube if needed');
        var list: Choice[] = [{ value: '', name: tr('Off'), note: tr('only when you turn them on in the player') }];
        offeredLanguages().forEach(function (code) {
            list.push({ value: code, name: languageName(code), note: on });
        });
        if (now && !list.some(function (c) { return c.value === now; })) {
            list.push({ value: now, name: languageName(now), note: tr('as chosen in the player') });
        }
        return list.concat([{ value: MORE, name: tr('More languages'), note: tr('find any language YouTube translates subtitles to; it joins this list') }]);
    }, function () {
        return prefs().captions;
    }, function (value) {
        if (value === MORE) {
            more();
        } else {
            setPref('captions', value as string);
        }
    });
}

/** The value of a list's Off (several: none of its choices set) */
var NONE = '';

/** An app pref listing several choices, each turned on and off by itself; offNote: an Off first (with that note) that sets
 * none of them (set while none is; chosen again then, the default ones are set again) */
function several(label: string, summary: string, picture: string, name: 'skip' | 'dearrowOptions' | 'listButtons', list: () => Choice[], offNote?: string): Setting {
    return {
        label: label,
        summary: summary,
        picture: picture,
        choices: {
            list: function () {
                var off: Choice[] = offNote ? [{ value: NONE, name: tr('Off'), note: offNote }] : [];
                return off.concat(list());
            },
            isSet: function (id) {
                return id === NONE ? !prefs()[name].length : prefs()[name].indexOf(id as string) >= 0;
            },
            choose: function (id) {
                var on = prefs()[name];
                setPref(name, id === NONE ? (on.length ? [] : prefDefault(name)) : on.indexOf(id as string) >= 0 ? on.filter(function (one) { return one !== id; }) : on.concat([id as string]));
            },
            many: true
        }
    };
}

function sponsorBlock(): Setting {
    // SponsorBlock's logo (from github.com/ajayyy/SponsorBlock), bundled with the app
    return several('SponsorBlock', tr('Skips the parts of videos that SponsorBlock\'s users marked. Choose the kinds to skip.'), 'sponsorblock.png', 'skip',
        function () { return PARTS.map(function (k) { return { value: k.id, name: k.name, note: k.note }; }); }, tr('nothing is skipped'));
}

/** DeArrow's options (used while it is on) */
function dearrowOptions(): Setting {
    var options: Choice[] = [
        { value: 'thumbnails', name: tr('Thumbnails'), note: tr('the frames DeArrow\'s users chose from the video') },
        { value: 'frames', name: tr('Random frames'), note: tr('where no frame was chosen, one from the video (YouTube\'s thumbnail until DeArrow has it ready)') },
        { value: 'tidy', name: tr('Tidy titles'), note: tr('every title in Title Case, without shouting capitals, emoji or extra exclamation marks') }
    ];
    return several(tr('DeArrow options'), tr('What DeArrow changes besides the titles its users wrote.'), 'dearrow.png', 'dearrowOptions', function () { return options; });
}

/** What wakes the screen while it is off: any button, or only the Screen off shortcut's, named as it is set now (none
 * has it: any) */
function screenWaking(): Setting {
    return pref(tr('Waking the screen'), tr('Which buttons wake the screen while it is off'), 'screenoff.png', 'screenWake', function () {
        var button = shortcutOf('screenOff');
        return [
            { value: 'any', name: tr('Any button'), note: tr('any button on the remote wakes it, and does nothing else') },
            { value: 'button', name: button ? tr('Only {1}', keyName(button.key)) : tr('Only the Screen off button'),
                note: button ? tr('the button with the Screen off shortcut; the others do nothing while it is off') :
                    tr('no button has the Screen off shortcut yet (Settings › Remote): until one has, any button wakes it') }
        ];
    });
}

/** Check for new versions (api/version-check.ts), under About: asked and told, asked only, or neither; its notes say
 * all a check sends. The app's own logo, as About's */
function versionCheck(): Setting {
    return pref(tr('Check for new versions'), tr('Once a day the app asks whether a newer version is out'), logoFile(LOGOS[0]), 'versionCheck', [
        { value: 'notify', name: tr('Notify me'), note: tr('a notice at most once a week while a newer version is out. The app sends its version, the webOS or Android version, and how many days ago it last asked: nothing about you or your TV') },
        { value: 'quiet', name: tr('No notice'), note: tr('the app still asks once a day, and says that the notice is off. A newer version shows only in Settings › About') },
        { value: 'off', name: tr('Off'), note: tr('the app asks nothing') }
    ]);
}

/** A setting that opens a page of its own (open): its one choice the page's name, note() saying how it is set */
function pageSetting(label: string, summary: string, picture: string, open: () => void, name: string, note: () => string): Setting {
    return { label: label, summary: summary, picture: picture, open: open, choices: { list: function () { return [{ value: 0, name: name, note: note() }]; },
        isSet: function () { return false; }, choose: open } };
}

/** Live chat: its settings on their own page over an example (open: player/chat-settings.ts); the note says how they
 * are set. Its picture drawn for the app, as Most replayed's */
function liveChat(open: () => void): Setting {
    return pageSetting(tr('Live chat'), tr('A live stream\'s chat in Bolli\'s player: whether it shows, where, how big and how it looks (also in the player\'s settings)'),
        'chat.png', open, tr('Live chat settings'), chatSummary);
}

/** Shortcuts: the remote's spare buttons, on their own page (open: views/shortcuts.ts); the note says how many have
 * one */
function shortcutsSetting(open: () => void): Setting {
    return pageSetting(tr('Shortcuts'), tr('Your remote\'s spare buttons for the things you do most: a screen, a channel, a playlist, or something in the player'),
        'shortcuts.png', open, tr('Shortcuts'), function () {
            var keys: { [key: number]: boolean } = {};
            shortcuts().forEach(function (one) { keys[one.key] = true; });
            return tr('{1} buttons have shortcuts', Object.keys(keys).length);
        });
}

/** The pictures of Settings › Playlists */
var PLAYLIST_PICTURE = 'playlist.png';

/** A playlist's page (views/list-stage.ts): its look, its frame's preview and autoplay, numbers, details and buttons,
 * where OK starts a video, the preview on the buttons. Its picture drawn for the app, as Most replayed's */
function listPage(): Setting[] {
    var picture = PLAYLIST_PICTURE;
    var buttons: Choice[] = [
        { value: 'play', name: tr('Play all'), note: tr('plays the playlist from its first video') },
        { value: 'shuffle', name: tr('Shuffle'), note: tr('plays the playlist in a random order') },
        { value: 'repeat', name: tr('Repeat'), note: tr('a switch: what you play from the playlist starts over after its last video') },
        { value: 'save', name: tr('Save to library'), note: tr('YouTube\'s button, on playlists that are not your own') },
        { value: 'shortcut', name: tr('Shortcut'), note: tr('puts the playlist on a button of the remote (Settings › Shortcuts)') }
    ];
    return [
        pref(tr('Playlist page'), tr('How a playlist\'s page shows the video you are on'), picture, 'listLayout', [
            { value: 'stage', name: tr('Stage'), note: tr('it plays in a frame beside the list, its title and views under it') },
            { value: 'backdrop', name: tr('Backdrop'), note: tr('it fills the screen behind the page, dimmed') }
        ]),
        pref(tr('Playlist preview'), tr('What a playlist\'s page shows of the video you are on'), picture, 'listPreview', [
            { value: 'sound', name: tr('With sound'), note: tr('it plays once you rest on it') },
            { value: 'muted', name: tr('Without sound'), note: tr('it plays once you rest on it') },
            { value: 'still', name: tr('Its picture only'), note: tr('nothing plays until you press OK') },
            { value: 'previews', name: tr('As Previews'), note: tr('with sound, without or off, as Settings › Previews') }
        ]),
        pref(tr('Autoplay on the playlist page'), tr('When the video playing in a playlist\'s frame ends'), picture, 'listAutoplay', [
            { value: true, name: tr('The next one plays'), note: tr('in the playlist\'s order, or shuffled, as its switches say') },
            { value: false, name: tr('It stops'), note: tr('a preview of 90 seconds at most') }
        ]),
        pref(tr('Rank numbers'), tr('A number before each video in a playlist: its place in the list'), picture, 'listNumbers', [
            { value: 'charts', name: tr('On charts'), note: tr('on YouTube\'s charts, where it is the chart position') },
            { value: 'all', name: tr('On every playlist'), note: '' },
            { value: 'off', name: tr('Off'), note: '' }
        ]),
        pref(tr('Video details'), tr('The title, channel and views of the video you are on, on a playlist\'s page'), picture, 'listDetails', onOff('', '')),
        several(tr('Playlist buttons'), tr('The buttons on a playlist\'s page'), picture, 'listButtons', function () { return buttons; }),
        pref(tr('Starting from a playlist'), tr('Where a video starts when you press OK on it in a playlist'), picture, 'listCarryOn', [
            { value: true, name: tr('Where the preview is'), note: tr('it carries on, so a song does not start over') },
            { value: false, name: tr('From the start'), note: '' }
        ]),
        pref(tr('Preview on the buttons'), tr('When you go to a playlist\'s buttons'), picture, 'listKeep', [
            { value: true, name: tr('Keeps playing'), note: tr('the video you were on plays on') },
            { value: false, name: tr('Stops'), note: tr('its picture shows instead') }
        ])
    ];
}

/** Video codec's choices: Auto, then every codec YouTube has; one this device does not play (api/streams.ts
 * codecPlays) says so in its note (chosen, its videos play as with Auto: none of its formats is offered here) */
export function codecChoices(): Choice[] {
    var without = tr('a video without it plays as with Auto');
    return ([{ value: 'auto', name: tr('Auto'), note: tr('VP9 where the video has it at the chosen quality, else another codec') }] as Choice[]).concat([
        { value: 'vp9', name: 'VP9', note: without },
        { value: 'av1', name: 'AV1', note: without },
        { value: 'h264', name: 'H.264', note: tr('up to 1080p only, also when the video has more; a video without it plays as with Auto') }
    ].map(function (c) {
        return codecPlays(c.value) ? c : { value: c.value, name: c.name, note: tr('this TV does not play it: videos play as with Auto') };
    }));
}

/** The playlist in the player (player/list-panel.ts): its next at a video's end, what Down shows, the list at the side
 * over or beside the picture (also in the player's settings while a playlist's video plays: main.ts) */
export function playerPlaylists(): (Setting & ChoiceSetting)[] {
    var picture = PLAYLIST_PICTURE;
    // (each made by pref: with its choices)
    return [
        pref(tr('Next in a playlist'), tr('When a video from a playlist ends in Bolli\'s player, the next one in it plays, whatever Autoplay says'), picture, 'listNext', waits),
        pref(tr('Playlist in the player'), tr('What Down shows while a video from a playlist plays'), picture, 'listDown', [
            { value: 'row', name: tr('Watch page, playlist first'), note: tr('the watch page as always, the playlist as its first row, as in YouTube\'s app') },
            { value: 'strip', name: tr('Strip first'), note: tr('the playlist across the bottom of the picture; Down again: the watch page') },
            { value: 'side', name: tr('List at the side'), note: tr('the playlist at the side; Right goes into it, Down again: the watch page') },
            { value: 'button', name: tr('Playlist button'), note: tr('a Playlist button on the watch page opens it at the side') }
        ]),
        pref(tr('Playlist at the side'), tr('Where the playlist at the side shows in the player'), picture, 'listSide', [
            { value: 'over', name: tr('Over the picture'), note: '' },
            { value: 'beside', name: tr('Beside the picture'), note: tr('the picture narrower beside it') }
        ])
    ] as (Setting & ChoiceSetting)[];
}

/** The app's language (core/i18n.ts); a new one also becomes Search's keyboard language, then the app starts again in
 * it (restart) */
function appLanguage(restart: () => void): Setting {
    return pick(tr('App language'), tr('The language of the app\'s menus, buttons and messages, and of YouTube\'s rows, counts and dates. Titles stay as their channels wrote them.'),
        pic('language'), LANGUAGES.map(function (l) { return { value: l.code, name: l.name, note: tr('the app starts again in it') }; }),
        language, function (value) {
            var code = String(value);
            if (code === language()) {
                return;
            }
            setLanguage(code);
            // (the keyboard in use stays among the recent ones, as when Search changes it)
            var recent = prefs().keyboardRecent;
            setPref('keyboardRecent', recentWith(recent, keyboardFor(code), recent[0] || keyboardFor(navigator.language)));
            restart();
        });
}

/** What the Branding settings need of the screen: the page a custom logo's address is typed on (take: what takes the
 * address typed), the page for the home screen name, and a way to draw the right side anew after a choice that took
 * a moment (e: why it was refused, if it was) */
interface Brand {
    address(take: (url: string) => Promise<unknown>): void;
    name(): void;
    chosen(e?: Error): void;
}

/** The columns of a grid of logo tiles */
var LOGO_COLUMNS = 4;


/** A setting whose choices are a grid of logo tiles; choose: what OK on a logo's tile does; add: what takes the
 * address typed after OK on the tile that adds one */
function logoGrid(label: string, summary: string, choices: () => Choice[], shown: () => Value, choose: (value: string) => void,
    brand: Brand, add: (url: string) => Promise<unknown>): Setting {
    var setting = pick(label, summary, '', choices, shown, function (value) {
        if (value === ADD) {
            brand.address(add);
        } else {
            choose(String(value));
        }
    });
    setting.grid = LOGO_COLUMNS;
    return setting;
}

/** The logo in the app: a built-in one, the account's picture (offered while an account is signed in; the first logo
 * until its copy is in), the viewer's own (Custom 1 ...; OK held removes one), the tile that adds one, or none. The
 * rail's changes at once. */
function logoSetting(brand: Brand): Setting {
    return logoGrid(tr('Logo'), tr('The logo at the top of the menu and while a screen loads'), logoChoices, shownLogo, function (value) {
        if (value === ACCOUNT) {
            // (no copy and no answer: the first logo, the choice kept; the next start tries again)
            takeAccountLogo().then(null, function () { return undefined; });
        } else {
            chooseLogo(value);
        }
    }, brand, takeCustomLogo);
}

/** The app's logo on the TV's home screen (ui/home-screen.ts). webOS: a built-in one, one of the viewer's own (chosen
 * once its files are written, which takes a moment), or the tile that adds one. Android: a built-in one, which the
 * home screen shows once the app is left (its description says so) */
function homeIconSetting(brand: Brand): Setting {
    var summary = hasHomeLogos() ? tr('The app\'s logo on the TV\'s home screen. It changes there once you leave the app') :
        tr('The app\'s logo on the TV\'s home screen');
    return logoGrid(tr('Home screen logo'), summary, homeIconChoices, shownHomeIcon, function (value) {
        setHomeIcon(value).then(function () { brand.chosen(); }, brand.chosen);
    }, brand, takeCustomIcon);
}

/** The app's name on the TV's home screen (webOS): one button showing it, OK types another (brand.name) */
function homeNameSetting(brand: Brand): Setting {
    return pick(tr('Home screen name'), tr('The app\'s name on the TV\'s home screen'), '', function () {
        return [{ value: 0, name: homeName(), note: tr('press OK to type another') }];
    }, function () { return 0; }, brand.name);
}

/** The colour of the app's tile on the TV's home screen (webOS), a grid of colours; the chosen logo at the top shows
 * on the colour focused */
function homeColorSetting(): Setting {
    var setting = pick(tr('Tile colour'), tr('The colour of the app\'s tile on the TV\'s home screen'), homeLogoPicture, homeColorChoices, homeColor, function (value) {
        setHomeColor(String(value));
    });
    setting.grid = COLOR_COLUMNS;
    return setting;
}

/** Why a picture was not taken, as one line for the viewer (url: the address typed) */
function refused(e: Error, url: string): string {
    var why = e && e.message;
    return why === NOT_PICTURE ? tr('That address is not a picture. Use the address of a PNG, JPEG or WebP picture.') :
        why === TOO_BIG ? tr('That picture is too big (2 MB at most).') :
        why === TOO_LARGE ? tr('That picture is too large (4096 × 4096 pixels at most).') :
        why === NO_FILE ? tr('This TV does not let the app save a logo for the home screen') :
        why === NO_CHANNEL ? tr('This TV does not let the app change its logo, name or colour on the home screen. A rooted TV with the Homebrew Channel does.') :
        why === NO_ROOT ? tr('This TV does not let the app change its logo, name or colour on the home screen. The Homebrew Channel on it has no root access.') :
        why === NO_ENTRY ? tr('The TV did not take the change to the home screen.') :
        why === NOT_KEPT || why === FULL ? tr('The app has no room left on the TV to keep the picture') :
        tr('Could not load {1}.', url.replace(/^https?:\/\//, '').split('/')[0]);
}

/** A picture's address as typed, made whole: '' for none (nothing typed after the scheme), https:// put before one
 * typed without a scheme. A whole address pasted after the https:// the page begins with has two schemes: the last
 * one is its own */
export function addressTyped(text: string): string {
    var typed = text.replace(/\s+/g, '');
    var schemes = /^(?:https?:\/\/)+/i.exec(typed);
    var rest = schemes ? typed.slice(schemes[0].length) : typed;
    return !rest ? '' : (schemes ? /https?:\/\/$/i.exec(schemes[0]) as string[] : ['https://'])[0] + rest;
}

/** What tells a tile's picture from another one's without holding all of it: an address whole, a picture's data by
 * its length, its end and letters all through it */
function markOf(picture: string): string {
    if (picture.length <= 300) {
        return picture;
    }
    var mark = picture.length + ' ' + picture.slice(-40) + ' ';
    for (var i = 0; i < 40; i++) {
        mark += picture.charAt(Math.floor(i * picture.length / 40));
    }
    return mark;
}

/** A category of settings; a text among them is a small heading over those after it */
interface Category {
    title: string;
    settings: (Setting | string)[];
}

/** The app's own settings, in categories (pages: possible start pages; more: Subtitles' "More languages"; chat: Live
 * chat settings; keys: Shortcuts; restart: starts the app again; brand: what the Branding settings need) */
function bolli(pages: StartPage[], more: () => void, chat: () => void, keys: () => void, restart: () => void, brand: Brand): Category[] {
    var browsing: (Setting | string)[] = [
        // Any page of the rail
        pref(tr('Start page'), tr('The screen the app starts on'), pic('location'), 'startPage', function () {
            return pages.map(function (p) { return { value: p.id, name: p.label, note: '' }; });
        }),
        pref(tr('Tile pictures'), tr('How sharp the tiles\' pictures are'), pic('linked_devices'), 'pictures', [
            { value: 'sharpest', name: tr('Sharpest'), note: tr('the clearest pictures; they take the most memory (about 30 MB more while a video plays)') },
            { value: 'sharp', name: tr('Sharp'), note: tr('clearer pictures, a little more memory') },
            { value: 'standard', name: tr('Standard'), note: tr('YouTube\'s small pictures: softer on this screen, the least memory') }
        ]),
        // Its picture drawn for the app, as Most replayed's
        pref(tr('Background'), tr('The colour behind the app\'s screens'), 'black.png', 'pureBlack', [
            { value: false, name: tr('Dark grey'), note: tr('as YouTube\'s TV app') },
            { value: true, name: tr('Pure black'), note: tr('completely black: on an OLED TV those pixels stay off') }
        ], function (on) { applyBlack(on === true); }),
        // The one in force is ticked: the viewer's choice, else the theme's (the screen takes it when it shows next).
        // Its picture drawn for the app, as Most replayed's
        pick(tr('Channels in Subscriptions'), tr('Where the Subscriptions screen lists your channels'), 'subscriptions.png', [
            { value: 'side', name: tr('On the side'), note: tr('a list of all your channels, each one\'s videos beside it, as YouTube\'s TV app') },
            { value: 'top', name: tr('Up top'), note: tr('round pictures in a row over the videos, with All, Today, Videos and Live under them') }
        ], subsLayout, function (value) { setPref('subsLayout', String(value)); }),
        // (the screen takes it when it shows next)
        pref(tr('Most relevant in Subscriptions'), tr('YouTube\'s own pick of videos, in a row over your subscriptions\' videos'), 'relevant.png', 'subsRelevant', [
            { value: true, name: tr('On'), note: tr('as YouTube\'s TV app') },
            { value: false, name: tr('Off'), note: tr('only your subscriptions\' videos, newest first') }
        ]),
        // (Home takes it when it shows next; this setting's picture and Most relevant's drawn for the app, as Most
        // replayed's)
        pref(tr('Bigger focused row on Home'), tr('The row with the focus has bigger tiles'), 'homebig.png', 'homeBig', [
            { value: false, name: tr('Off'), note: tr('every row the same size: faster on older TVs') },
            { value: true, name: tr('On'), note: tr('as YouTube\'s TV app') }
        ])
    ];
    // Only when there is more than one theme
    if (themes().length > 1) {
        browsing.push(pref(tr('Theme'), tr('How the app looks'), '', 'theme', function () {
            return themes().map(function (t) { return { value: t.id, name: t.name, note: '' }; });
        }, function (id) { applyTheme(String(id)); }));
    }
    // Branding, under its own small heading: the logo in the app, and where the TV has a home screen entry the app
    // can change (webOS) its logo, name and tile colour there; on Android its logo there alone
    browsing.push(tr('Branding'), logoSetting(brand));
    if (hasHomeScreen()) {
        browsing.push(homeIconSetting(brand), homeNameSetting(brand), homeColorSetting());
    } else if (hasHomeLogos()) {
        browsing.push(homeIconSetting(brand));
    }
    return [
        { title: tr('Playback'), settings: [
            autoplay(),
            pref(tr('Video quality'), tr('The quality videos start at'), pic('clear_search_history'), 'quality', [
                { value: 0, name: tr('Auto'), note: tr('as good as the video and the connection allow, up to 4K') },
                { value: HIGHEST, name: tr('Highest available'), note: tr('the best the video has, up to 8K where the TV plays it') },
                { value: 2160, name: '4K (2160p)', note: tr('or the closest below it') },
                { value: 1440, name: '1440p (2K)', note: tr('or the closest below it') },
                { value: 1080, name: '1080p (HD)', note: tr('or the closest below it') },
                { value: 720, name: '720p', note: tr('or the closest below it') },
                { value: 480, name: '480p', note: tr('or the closest below it') }
            ]),
            pref(tr('Video codec'), tr('The codec videos start in, chosen before the quality'), pic('clear_search_history'), 'codec', codecChoices),
            pref(tr('History'), tr('What you watch in Bolli\'s player, told to YouTube'), pic('privacy_and_terms'), 'history',
                onOff(tr('it goes into your YouTube history, and YouTube remembers where you stopped'), tr('Bolli\'s player tells YouTube nothing of what you watch'))),
            // Its picture drawn for the app in the style of YouTube's
            pref(tr('Most replayed'), tr('A graph over the progress bar in Bolli\'s player of the parts people watch again the most, from YouTube'),
                'replays.png', 'replays', onOff(tr('shown on videos YouTube has one for (popular ones)'), tr('no graph'))),
            // Its picture drawn for the app, as Most replayed's
            pref(tr('Pause on chapters'), tr('Up in a video shows its chapters to pick from'), pic('clear_search_history'), 'chaptersPause',
                onOff(tr('the video waits while you pick'), tr('the video plays on while you pick'))),
            pref(tr('Clock in videos'), tr('The time of day in a corner of the picture while a video plays in Bolli\'s player'), 'clock.png',
                'videoClock', [
                    { value: 'off', name: tr('Off'), note: tr('the clock shows only on the app\'s screens') },
                    { value: 'left', name: tr('Top left'), note: tr('always there, also when the controls are hidden') },
                    { value: 'right', name: tr('Top right'), note: tr('always there, also when the controls are hidden') }
                ]),
            pref(tr('Streams by SABR'), tr('How Bolli\'s player gets the videos'), pic('parent_code'), 'sabr',
                onOff(tr('as YouTube\'s TV app does (signed in, by SABR), as a guest when that fails'), tr('as a guest, signed in (by SABR) only when YouTube asks, as for an age check')))
        ].concat(oldEngine() ? [] : [
            // (not where YouTube's player does not run: webOS TV 2.x's engine)
            pref(tr('Fall back to YouTube\'s player'), tr('When Bolli\'s player cannot play a video at all, as with a format this TV cannot decode'), pic('parent_code'), 'fallbackPlayer',
                onOff(tr('YouTube\'s player plays it instead. A bad connection never hands over: Bolli waits for it'),
                    tr('Bolli\'s player says that the video needs YouTube\'s player and stays on it: OK tries again')))
        ]) },
        { title: tr('Language & subtitles'), settings: [
            appLanguage(restart),
            subtitles(more),
            pref(tr('Subtitle style'), tr('How YouTube\'s automatic subtitles appear'), pic('language'), 'captionStyle', CAPTION_STYLES)
        ] },
        { title: tr('Previews & starting'), settings: [
            pref(tr('Previews'), tr('The video whose tile you rest on plays in the tile (in Bolli\'s player)'), pic('clear_watch_history'), 'previews', [
                { value: 'sound', name: tr('With sound'), note: '' },
                { value: 'muted', name: tr('Without sound'), note: '' },
                { value: 'off', name: tr('Off'), note: '' }
            ]),
            pref(tr('Channel video'), tr('The video a channel plays behind its header while you rest on Play mix'), pic('clear_watch_history'), 'channelVideo',
                onOff(tr('it starts after a few seconds, with or without sound as Previews says'), tr('only the channel\'s picture shows'))),
            pref(tr('Videos start sooner'), tr('The video or page whose tile you rest on gets ready'), pic('send_feedback'), 'preload',
                onOff(tr('it opens about a second sooner'), ''))
        ].concat(android() ? [] : [
            // (LG TVs: their engine waits 3 s after every jump unless the video seems to end soon; Android has no such wait)
            pref(tr('Quick jumps'), tr('Jumping in a video in Bolli\'s player'), pic('send_feedback'), 'quickJumps',
                onOff(tr('the picture comes in about half a second (what was loaded further ahead is loaded again)'), tr('the picture comes after about two seconds')))
        ]).concat([
            pref(tr('Loading sign'), tr('What shows while a video starts in Bolli\'s player'), pic('reset_app'), 'startSign',
                onOff(tr('the channel\'s picture fills up'), tr('the screen stays dark until the video plays'))),
            pref(tr('Start picture'), tr('What shows behind the loading sign while a video starts in Bolli\'s player, until it moves'), pic('reset_app'), 'startPicture', [
                { value: 'tile', name: tr('The tile\'s picture'), note: tr('sharp, at once; it melts into the video once that moves') },
                { value: 'frame', name: tr('The frame it starts on'), note: tr('the very picture it opens with, blurry: from YouTube\'s seek previews') },
                { value: 'none', name: tr('None'), note: tr('dark until the video plays: its picture comes soonest') }
            ])
        ]) },
        { title: tr('Playlists'), settings: ([tr('On a playlist\'s page')] as (Setting | string)[]).concat(listPage(), [tr('In the player')], playerPlaylists()) },
        { title: tr('Live chat'), settings: [liveChat(chat)] },
        { title: tr('Remote'), settings: [shortcutsSetting(keys)] },
        { title: tr('Look'), settings: browsing },
        { title: tr('Add-ons'), settings: [
            sponsorBlock(),
            // DeArrow's logo (from github.com/ajayyy/DeArrow, based on Twemoji), bundled with the app
            pref('DeArrow', tr('Titles and thumbnails DeArrow\'s users submit, in place of clickbait'), 'dearrow.png', 'dearrow', [
                { value: '', name: tr('Off'), note: tr('YouTube\'s titles and thumbnails') },
                { value: 'classic', name: tr('Classic'), note: tr('DeArrow\'s titles and thumbnails wherever its users submitted them') },
                { value: 'casual', name: tr('Casual'), note: tr('YouTube\'s own titles where DeArrow\'s users voted them fine (funny, clever, descriptive), DeArrow\'s elsewhere') }
            ]),
            dearrowOptions(),
            // Its picture drawn for the app, as Most replayed's
            pref(tr('Dislike counts'), tr('How many dislike a video, on its watch page beside the likes, as Return YouTube Dislike estimates them'),
                'dislikes.png', 'dislikes', onOff(tr('asked of returnyoutubedislike.com for each video whose watch page you open'), tr('no count'))),
            tr('Screen off'),
            // Choosing one shows it; its picture drawn for the app, as Most replayed's
            pref(tr('Screen off'), tr('How the screen goes black while the sound plays on: the Screen off shortcut (Settings › Remote) or the player\'s settings.'),
                'screenoff.png', 'screenOff', [
                    { value: 'iris', name: tr('Film iris'), note: tr('a circle closes on the middle, like the end of an old film') },
                    { value: 'crt', name: tr('Old TV'), note: tr('the picture closes into a glowing line and a dot, like a tube TV switched off') },
                    { value: 'shutter', name: tr('Camera shutter'), note: tr('six blades close in, turning, like a camera\'s shutter') },
                    { value: 'curtain', name: tr('Theatre curtain'), note: tr('red curtains meet in the middle, then the stage goes dark') },
                    { value: 'blinds', name: tr('Blinds'), note: tr('strips close from the top down, like blinds') },
                    { value: 'sweep', name: tr('Sweep'), note: tr('black sweeps across from the right with a soft edge') },
                    { value: 'fade', name: tr('Slow fade'), note: tr('the picture fades to black in a second and a half') },
                    { value: 'random', name: tr('Random'), note: tr('a different one of these each time') },
                    { value: 'none', name: tr('None'), note: tr('black at once') }
                ], function () { screenOff(true); }),
            screenWaking(),
            pref(tr('Casting with the screen off'), tr('When a video is cast from a phone while the screen is off'), 'screenoff.png', 'castWakes', [
                { value: false, name: tr('The screen stays off'), note: tr('the video plays with the screen dark, as for music from your phone') },
                { value: true, name: tr('The screen wakes'), note: tr('the screen comes back for the new video') }
            ])
        ] }
    ];
}

/** Linking a phone: by casting on the same network, or with a TV code from another (YouTube's steps) */
var LINK: Setting[] = [
    { label: tr('Link with Wi-Fi'), summary: '', picture: '', steps: [tr('On your phone, connect to the same Wi-Fi network as this device.'),
        tr('Open the YouTube app on your phone.'), tr('Tap the cast icon and select this device.')] },
    { label: tr('Link with TV code'), summary: '', picture: '', code: true, steps: [tr('On your phone, open the YouTube app.'),
        tr('Tap the cast icon.'), tr('Tap \'Link with TV code\' and enter the code below.')] }
];

/** About: the app's version, a newer one that is out with where to get it (api/version-check.ts: known some time
 * after the start, so asked each time About is drawn), the device it runs on, where its code is, what it uses */
function about(): Setting {
    var where = device();
    // (the app's own logo, the first: not the one chosen)
    return { label: tr('About'), summary: tr('Bolli YouTube, a light YouTube app for TVs'), picture: logoFile(LOGOS[0]), info: function () {
        var newer = newerVersion();
        return [
            tr('Version {1}', document.documentElement.getAttribute('data-version') || ''),
            newer ? tr('Version {1} is out', newer) : '',
            !newer ? '' : android() ? tr('Download it from GitHub') : tr('Update it in the Homebrew Channel'),
            where ? tr('On {1}', where) : '',
            tr('Source code: {1}', 'github.com/aktiwers/bolli-youtube'),
            tr('With SponsorBlock, DeArrow, Return YouTube Dislike and the Roboto font (Apache License 2.0)'),
            tr('Not made by YouTube or Google')
        ].filter(function (line) { return line; });
    } };
}

/** The device: the Android app's model and version (its browser names an LG TV, as YouTube needs), else an LG TV's
 * model and firmware as webOS gives them (or as an older build's browser named them, with the webOS year; '' none) */
function device(): string {
    var shell = android();
    if (shell) {
        return shell.device ? shell.device() : 'Android';
    }
    // webOS's own word on it (a webOS app's: its model and firmware)
    var palm = (window as unknown as { PalmSystem?: { deviceInfo?: string } }).PalmSystem;
    try {
        var info = JSON.parse(palm && palm.deviceInfo || 'null');
        if (info && info.modelName) {
            return 'LG ' + info.modelName + (info.platformVersion ? ', firmware ' + info.platformVersion : '');
        }
    } catch (e) {
        // not JSON: from the browser's name below
    }
    var ua = navigator.userAgent;
    var model = /\(LG, ([^,)]+)/.exec(ua);
    if (!model) {
        return '';
    }
    var year = /webOS\.TV-(\d+)/.exec(ua);
    var firmware = /_TV_\w+\/([\d.]+)/.exec(ua);
    return 'LG ' + model[1] + (year ? ', webOS TV ' + year[1] : '') + (firmware ? ', firmware ' + firmware[1] : '');
}

/** "a thing" as "A thing" */
function sentence(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
}

/** A setting's picture as it is now ('' none) */
function pictureOf(s: Setting): string {
    return typeof s.picture === 'function' ? s.picture() : s.picture;
}

/** i moved by an arrow in a grid of count tiles in columns: a row up or down (down from the last full row: to the last
 * tile), or one right within its row; where there is none: i */
export function gridStep(i: number, count: number, columns: number, code: number): number {
    if (code === KEY.RIGHT) {
        return i % columns < columns - 1 && i + 1 < count ? i + 1 : i;
    }
    if (code === KEY.UP) {
        return i >= columns ? i - columns : i;
    }
    var rows = Math.ceil(count / columns);
    return i + columns < count ? i + columns : Math.floor(i / columns) < rows - 1 ? count - 1 : i;
}

/** i moved one up or down, clamped to 0..count-1 */
function step(i: number, count: number, code: number): number {
    return Math.max(0, Math.min(count - 1, i + (code === KEY.UP ? -1 : 1)));
}

/** How a setting is set, for the line under its name: its set choices' names (a page's: its note; '' none) */
function valueOf(s: Setting): string {
    var c = s.choices;
    return !c ? '' : s.open ? sentence(c.list()[0].note) : setNames(c);
}

/** Focus location: the categories, the focused category's settings, or the focused setting's choices (a confirmation
 * question may cover them) */
type Place = 'categories' | 'settings' | 'choices';

/** A category as shown: its row on the left (with how many settings it has), its settings' list in the middle (each
 * setting's row, with the line saying how it is set), the setting it is on (kept while the app runs), how far its list
 * scrolled and for which setting (-1: none yet), the lines' drawing (the view's changes then) */
interface Shown {
    el: HTMLElement;
    count: HTMLElement;
    list: HTMLElement;
    rows: { setting: Setting; el: HTMLElement; value: HTMLElement }[];
    at: number;
    scrolled: number;
    centredAt: number;
    drawnAt: number;
}

export class SettingsView implements View {
    el: HTMLElement;
    private menu: HTMLElement;
    private categoryList: HTMLElement;
    private middle: HTMLElement;
    private middleLine: HTMLElement;
    private panel: HTMLElement;
    private body: HTMLElement;
    private picture: HTMLImageElement;
    private heading: HTMLElement;
    private summary: HTMLElement;
    private steps: HTMLElement;
    private code: HTMLElement;
    private info: HTMLElement;
    private buttonsBox: HTMLElement;
    private note: HTMLElement;
    /** The choices and their note: their box (clips them where they scroll up under the picture and name), and what
     * scrolls in it */
    private choicesBox: HTMLElement;
    private scroller: HTMLElement;
    /** The categories in order, the focused one, the one whose list shows, Account & phone (the account's History & data
     * join it) */
    private categories: Shown[] = [];
    private category = 0;
    private showing: Shown | null = null;
    private account: Shown;
    private place: Place = 'categories';
    private focused = false;
    private shown = false;
    /** Scroll offsets of the categories (whether they scroll at all: measured when shown) and the right side */
    private scrolled = 0;
    private categoriesScroll = false;
    private panelScrolled = 0;
    /** What the right side's scroll moves: the whole body, or the choices only (Logo); null: nothing yet */
    private panelMoving: HTMLElement | null = null;
    /** Changes that may set something anew (a choice, a page closed, the account, Settings shown again): the lines under
     * the settings' names are drawn again once a category shows after one */
    private changes = 0;
    /** The setting shown on the right, its choices, their buttons, the focused button */
    private drawn: Setting | null = null;
    private choices: Choice[] = [];
    private buttons: { el: HTMLElement; check: HTMLElement }[] = [];
    private button = 0;
    /** The right side's drawing waiting for the next frame (a step through the categories: the left and the middle show
     * first; on the TV that halved a step's time) */
    private panelFrame = 0;
    /** Subtitles' "More languages" picker (built on first open); takes the keys while open */
    private languages: LanguagePicker | null = null;
    /** The page a custom logo's address or the home screen name is typed on (built on first open); takes the keys
     * while open */
    private typing: TextPage | null = null;
    /** The keys Settings itself took so far (its pages' not counted): a choice that took a moment tells by it whether
     * the viewer went on meanwhile */
    private pressed = 0;
    /** The tiles as last drawn and what they were drawn from (a grid's choices): kept while those are the same, so a
     * tick moving does not build and decode every picture again */
    private tilesOf = '';
    /** Live chat settings (built on first open); takes the keys while open */
    private chat: ChatSettings | null = null;
    /** Shortcuts (built on first open); takes the keys while open */
    private keys: ShortcutsPage | null = null;
    /** The account's History & data group as shown */
    private history: AccountGroup | null = null;
    /** The TV code ('' if none or expired), the text shown instead ('…' while requesting), the rest timer, the expiry
     * timer */
    private tvCode = '';
    private codeSaid = '';
    private codeTimer = 0;
    private codeEnd = 0;

    /** link: requests a TV code from YouTube; pages: possible start pages; question: the app's confirmation dialog
     * (gets keys first while shown); restart: starts the app again (a new language); host: what Shortcuts needs */
    constructor(private link: () => Promise<string>, pages: StartPage[], private question: Question, restart: () => void, private host: ShortcutHost) {
        this.el = h('div', 'by-settings by-settings--split');
        setShown(this.el, false);
        this.el.appendChild(h('div', 'by-settings-title', tr('Settings')));
        this.menu = h('div', 'by-settings-menu');
        this.categoryList = h('div', 'by-settings-list');
        this.menu.appendChild(this.categoryList);
        this.el.appendChild(this.menu);
        this.el.appendChild(h('div', 'by-settings-line'));
        this.middle = this.el.appendChild(h('div', 'by-settings-middle')) as HTMLElement;
        this.middleLine = this.el.appendChild(h('div', 'by-settings-line by-settings-line--middle')) as HTMLElement;
        var panel = this.panel = h('div', 'by-settings-panel');
        this.body = h('div', 'by-settings-body');
        this.picture = this.body.appendChild(h('img', 'by-settings-picture')) as HTMLImageElement;
        this.heading = this.body.appendChild(h('div', 'by-settings-heading')) as HTMLElement;
        this.summary = this.body.appendChild(h('div', 'by-settings-summary')) as HTMLElement;
        var linkBox = this.body.appendChild(h('div', 'by-settings-link')) as HTMLElement;
        this.steps = linkBox.appendChild(h('ol', 'by-settings-steps')) as HTMLElement;
        this.code = linkBox.appendChild(h('div', 'by-settings-code')) as HTMLElement;
        this.info = this.body.appendChild(h('div', 'by-settings-info')) as HTMLElement;
        this.choicesBox = this.body.appendChild(h('div', 'by-settings-choices')) as HTMLElement;
        this.scroller = this.choicesBox.appendChild(h('div', 'by-settings-scroll')) as HTMLElement;
        this.buttonsBox = this.scroller.appendChild(h('div', 'by-settings-buttons')) as HTMLElement;
        this.note = this.scroller.appendChild(h('div', 'by-settings-note')) as HTMLElement;
        panel.appendChild(this.body);
        this.el.appendChild(panel);
        var self = this;
        // (a home screen choice the TV did not take: said in one line, the right side anew with the choice put back)
        onHomeRefused(function (e) { self.brandChosen(e); });
        bolli(pages, function () { self.moreLanguages(); }, function () { self.openChat(); }, function () { self.openKeys(); }, restart,
            { address: function (take) { self.pictureAddress(take); }, name: function () { self.namePage(); },
                chosen: function (e) { self.brandChosen(e); } }).forEach(function (c) {
            self.addCategory(c);
        });
        this.account = this.addCategory({ title: tr('Account & phone'), settings: LINK });
        // About, and under it Check for new versions in a build that has the service's address (without it: About
        // alone, shown wide)
        this.addCategory({ title: tr('About'), settings: hasVersionCheck() ? [about(), versionCheck()] : [about()] });
        this.drawFocus();
        // A logo that changes while a grid of logos shows (one chosen or removed, the account's picture come in,
        // another account): its tiles and ticks anew, the focus where it was
        drawLogo(function () {
            if (self.shown && !self.openPage() && self.drawn && self.drawn.grid) {
                self.drawPanel(true);
            }
        });
        // A click on a category or a setting focuses it (its settings or choices show, as in YouTube's Settings; a
        // category of one page opens it, as OK); on a choice it sets it
        takesPointer(this.el, function (target) {
            var shown = self.categories[self.category];
            var c = holding(self.categories, target);
            var r = holding(shown.rows, target);
            var b = holding(self.buttons, target);
            if (c >= 0) {
                self.category = c;
                self.place = 'categories';
            } else if (r >= 0) {
                shown.at = r;
                self.place = 'settings';
            } else if (b >= 0) {
                self.place = 'choices';
                self.button = b;
            } else {
                return null;
            }
            self.drawFocus();
            return b >= 0 || c >= 0 && self.alone() && self.setting().open ? {} : { key: 0 };
        });
    }

    show(): void {
        var self = this;
        this.shown = true;
        setShown(this.el, true);
        // (measured here: a step reads no layout)
        this.categoriesScroll = this.categoryList.offsetHeight > this.menu.offsetHeight;
        // Set elsewhere meanwhile (the player's settings, a shortcut set from a page): the lines and the right side anew
        this.drawn = null;
        this.changes++;
        this.drawFocus();
        this.drawValues();
        // Returning to "Link with TV code": request a code if there is none, as when focus rests on it
        if (this.setting().code) {
            this.askCode(false);
        }
        // On failure show none, rather than a previous account's
        historySettings().then(function (group) { self.putHistory(group); }, function () { self.putHistory(null); });
    }

    hide(): void {
        this.shown = false;
        this.closeOwn();
        setShown(this.el, false);
    }

    /** Called after every key */
    setFocused(focused: boolean): void {
        if (focused === this.focused) {
            return;
        }
        this.focused = focused;
        if (!focused) {
            this.closeOwn();
        }
        this.drawFocus();
    }

    /** Its pages made so far: the language picker, Live chat settings, Shortcuts */
    private pages(): SubPage[] {
        return [this.languages, this.chat, this.keys, this.typing].filter(function (p) { return !!p; }) as SubPage[];
    }

    /** Its page shown over it (null: none) */
    private openPage(): SubPage | null {
        return this.languages && this.languages.shown ? this.languages : this.chat && this.chat.shown ? this.chat :
            this.keys && this.keys.shown ? this.keys : this.typing && this.typing.shown ? this.typing : null;
    }

    /** The page of its own while open (null: none; the pointer's layer: core/pointer.ts; it takes every key, the
     * shortcuts' too: main.ts) */
    layer(): HTMLElement | null {
        var open = this.openPage();
        return open ? open.layer() : null;
    }

    onKey(code: number): boolean {
        var page = this.openPage();
        if (page) {
            page.onKey(code);
            // Closed: the note and the line under its name say how it is set now. A grid's focus stays on the tile
            // the page was opened from (the one that adds a picture: its download moves it once it is in)
            if (!page.shown) {
                this.drawPanel(!!this.drawn && !!this.drawn.grid);
                this.changed();
            }
            return true;
        }
        this.pressed++;
        // (any key but a step works on the right side as it is now)
        if (code !== KEY.UP && code !== KEY.DOWN) {
            this.panelNow();
        }
        if (this.place === 'choices') {
            this.choicesKey(code);
            return true;
        }
        var shown = this.categories[this.category];
        var inCategories = this.place === 'categories';
        switch (code) {
            case KEY.UP:
            case KEY.DOWN:
                if (inCategories) {
                    this.category = step(this.category, this.categories.length, code);
                } else {
                    shown.at = step(shown.at, shown.rows.length, code);
                }
                this.drawFocus();
                return true;
            case KEY.RIGHT:
            case KEY.OK:
                if (inCategories && !this.alone()) {
                    this.place = 'settings';
                    this.drawFocus();
                } else {
                    this.enter(code);
                }
                return true;
            case KEY.LEFT:
            case KEY.BACK:
                if (inCategories) {
                    return false;
                }
                this.place = 'categories';
                this.drawFocus();
                return true;
        }
        return false;
    }

    /** The focused category's focused setting */
    private setting(): Setting {
        var shown = this.categories[this.category];
        return shown.rows[shown.at].setting;
    }

    /** Whether the focused category has one setting (shown on the right at once, without the middle) */
    private alone(): boolean {
        return this.categories[this.category].rows.length === 1;
    }

    /** Right or OK on a setting: its page opens, or its choices take the focus (Link with TV code: OK asks for a code
     * again after a failure) */
    private enter(code: number): void {
        var s = this.setting();
        if (s.open) {
            s.open();
        } else if (this.buttons.length) {
            this.place = 'choices';
            this.button = this.setButton();
            this.drawFocus();
        } else if (code === KEY.OK && s.code) {
            this.askCode(true);
        }
    }

    /** Keys in the choices: Up/Down move, OK sets, Left or Back return to the settings (to the categories for one
     * alone) */
    private choicesKey(code: number): void {
        var columns = this.setting().grid || 0;
        switch (code) {
            case KEY.UP:
            case KEY.DOWN:
                this.button = columns ? gridStep(this.button, this.buttons.length, columns, code) : step(this.button, this.buttons.length, code);
                this.drawButtons();
                break;
            case KEY.RIGHT:
                if (columns) {
                    this.button = gridStep(this.button, this.buttons.length, columns, code);
                    this.drawButtons();
                }
                break;
            case KEY.OK:
                this.setting().choices!.choose(this.choices[this.button].value);
                this.drawButtons();
                this.changed();
                break;
            case KEY.LEFT:
                // (in a grid: one tile left; from its first column out, as from a list)
                if (columns && this.button % columns > 0) {
                    this.button--;
                    this.drawButtons();
                    break;
                }
                this.place = this.alone() ? 'categories' : 'settings';
                this.drawFocus();
                break;
            case KEY.BACK:
                this.place = this.alone() ? 'categories' : 'settings';
                this.drawFocus();
                break;
        }
    }

    /** Live chat settings over an example (over the whole screen, the rail too; in this screen, so hidden with it when a
     * video starts over it) */
    private openChat(): void {
        this.chat = this.chat || new ChatSettings(this.el);
        this.chat.open();
    }

    /** Shortcuts over the whole screen (in this screen, so hidden with it when a video starts over it) */
    private openKeys(): void {
        this.keys = this.keys || new ShortcutsPage(this.el, this.host, this.question);
        this.keys.open();
    }

    /** Subtitles' "More languages": the chosen language is set and added to the list */
    private moreLanguages(): void {
        var self = this;
        this.languages = this.languages || new LanguagePicker(this.el);
        this.languages.open(prefs().captions, function (code) {
            var added = prefs().captionLanguages;
            if (ALWAYS.indexOf(code) < 0 && added.indexOf(code) < 0) {
                setPref('captionLanguages', added.concat([code]));
            }
            setPref('captions', code);
            self.drawPanel();
            self.changed();
        });
    }

    /** A custom logo's address typed (https:// to begin with): take downloads its picture in the background and
     * makes it a custom logo, the one chosen once it is in; else one line says why */
    private pictureAddress(take: (url: string) => Promise<unknown>): void {
        var self = this;
        this.typing = this.typing || new TextPage(this.el);
        this.typing.open(tr('Picture address'), 'https://', false, function (text) {
            var url = addressTyped(text);
            if (url) {
                var keys = self.pressed;
                take(url).then(function () { self.brandChosen(undefined, '', keys === self.pressed); }, function (e: Error) { self.brandChosen(e, url); });
            }
        });
    }

    /** A Branding choice that took a moment is in (e: or was refused, said in one line; url: the address typed): the
     * right side anew, with a custom logo's new tile and the tick where it is now. The focus stays where it is (on
     * the tile chosen, or wherever the viewer went meanwhile); toSet: it goes to the one now set (a custom logo just
     * added, no key pressed since). */
    private brandChosen(e?: Error, url?: string, toSet?: boolean): void {
        if (e) {
            toast(refused(e, url || ''), undefined, PROBLEM);
        }
        if (this.shown && !this.openPage()) {
            this.drawPanel(!toSet);
        }
        this.changed();
    }

    /** The focused choice if OK held on it removes it (a custom logo's tile), else null */
    private removable(): Choice | null {
        var choice = this.place === 'choices' && !this.openPage() ? this.choices[this.button] : null;
        return choice && choice.removable ? choice : null;
    }

    /** OK held means something on a custom logo's tile (main.ts: OK then acts on its release) */
    holds(): boolean {
        return !!this.removable();
    }

    /** OK held (main.ts): on a custom logo's tile it asks to remove that logo (true: the hold was used). Removed, the
     * app's logo and the home screen's go back to the first if they were it (ui/custom-logos.ts tells them). */
    onHold(): boolean {
        var self = this;
        var choice = this.removable();
        var custom = choice ? customOf(String(choice.value)) : null;
        if (!choice || !custom) {
            return false;
        }
        this.question.open({ title: tr('Remove {1}?', choice.name), subtitle: '', picture: choice.picture || '', yes: tr('Remove'), no: tr('Cancel') }, function () {
            removeCustomLogo(custom!);
            self.drawPanel();
            self.changed();
        });
        return true;
    }

    /** The home screen name typed (the one set, else the app's own): taken at the tick, none: the app's own again */
    private namePage(): void {
        var self = this;
        this.typing = this.typing || new TextPage(this.el);
        this.typing.open(tr('Home screen name'), prefs().homeName || APP_NAME, true, function (name) {
            setHomeName(name);
            if (self.shown && !self.openPage()) {
                self.drawPanel();
            }
            self.changed();
        });
    }

    /** Adds a category: its row on the left, its settings' list in the middle (hidden until it shows) */
    private addCategory(c: Category): Shown {
        var el = this.categoryList.appendChild(h('div', 'by-settings-item')) as HTMLElement;
        var count = el.appendChild(h('span', 'by-settings-count')) as HTMLElement;
        el.appendChild(document.createTextNode(c.title));
        var list = this.middle.appendChild(h('div', 'by-settings-list')) as HTMLElement;
        setShown(list, false);
        var shown: Shown = { el: el, count: count, list: list, rows: [], at: 0, scrolled: 0, centredAt: -1, drawnAt: -1 };
        this.categories.push(shown);
        this.fill(shown, c.settings);
        return shown;
    }

    /** Puts a category's settings in its list (a text: a small heading); its row on the left says how many it has (one
     * alone: a page's arrow, or nothing) */
    private fill(shown: Shown, settings: (Setting | string)[]): void {
        shown.list.innerHTML = '';
        shown.rows = [];
        shown.centredAt = shown.drawnAt = -1;
        settings.forEach(function (s) {
            if (typeof s === 'string') {
                shown.list.appendChild(h('div', 'by-settings-group', s));
                return;
            }
            var el = shown.list.appendChild(h('div', 'by-settings-item by-settings-item--two')) as HTMLElement;
            el.appendChild(h('div', 'by-settings-name', s.label));
            shown.rows.push({ setting: s, el: el, value: el.appendChild(h('div', 'by-settings-value')) as HTMLElement });
        });
        var one = shown.rows.length === 1 ? shown.rows[0].setting : null;
        setText(shown.count, one ? (one.open ? '›' : '') : String(shown.rows.length));
    }

    /** Puts the account's History & data settings in Account & phone after phone linking, under headings, replacing the
     * previous ones (no-op for the same reply); the focus stays on its setting */
    private putHistory(group: AccountGroup | null): void {
        var self = this;
        if (group === this.history) {
            return;
        }
        var shown = this.account;
        var focused = shown.rows[shown.at].setting;
        this.history = group;
        this.fill(shown, group ? ([tr('Link TV & phone')] as (Setting | string)[]).concat(LINK, [group.title],
            group.settings.map(function (a) { return self.accountSetting(a); })) : LINK);
        var still = shown.rows.map(function (row) { return row.setting; }).indexOf(focused);
        shown.at = still >= 0 ? still : Math.min(shown.at, shown.rows.length - 1);
        if (shown === this.showing) {
            this.drawValues();
        }
        if (!this.question.shown) {
            this.drawFocus();
        }
    }

    /** An account setting: on/off (shown at once, reverted if YouTube rejects it), or one button that asks YouTube's
     * question */
    private accountSetting(a: AccountSetting): Setting {
        var self = this;
        var ask = a.ask;
        if (ask) {
            return pick(a.title, a.summary, a.picture, function () { return [{ value: 0, name: a.title, note: '' }]; },
                function () { return -1; }, function () { self.openAsk(ask!); });
        }
        var setting = pick(a.title, a.summary, a.picture, onOff('', ''), function () { return !!a.on; }, function (value) {
            apply(a, 'on', value === true, value ? a.enable : a.disable, function () {
                if (self.drawn === setting) {
                    self.drawButtons();
                }
                self.changed();
            }, tr('YouTube did not take the change. Try again.'));
        });
        return setting;
    }

    /** Marks the focused category and setting (grey where the focus was: the keys in a column further, or the rail),
     * shows the category's settings in the middle (one alone: none, the right side wide), scrolls both lists, and
     * shows the setting on the right. The middle is hidden, not taken out (its lists stay laid out), and the right
     * side's width is its own class, not Settings': a class on Settings restyled every list, hidden ones too (up to
     * 15 ms a step on the TV) */
    private drawFocus(): void {
        var self = this;
        var shown = this.categories[this.category];
        var keys = this.focused;
        this.categories.forEach(function (c, i) {
            var on = i === self.category;
            toggleClass(c.el, 'by-settings-item--focused', on && keys && self.place === 'categories');
            toggleClass(c.el, 'by-settings-item--at', on && !(keys && self.place === 'categories'));
        });
        // (its values as it shows: a step in its list changes none)
        if (shown !== this.showing) {
            if (this.showing) {
                setShown(this.showing.list, false);
            }
            setShown(shown.list, true);
            this.showing = shown;
            this.drawValues();
        }
        var alone = this.alone();
        setShown(this.middle, !alone);
        setShown(this.middleLine, !alone);
        shown.rows.forEach(function (row, i) {
            var on = i === shown.at && self.place !== 'categories';
            toggleClass(row.el, 'by-settings-item--focused', on && keys && self.place === 'settings');
            toggleClass(row.el, 'by-settings-item--at', on && !(keys && self.place === 'settings'));
        });
        if (this.setting() === this.drawn) {
            this.drawButtons();
        } else if (this.place === 'categories') {
            this.panelSoon();
        } else {
            this.drawPanel();
        }
        // (a list scrolls only once its focus moved, or it was filled anew: a category step reads no layout)
        if (this.categoriesScroll) {
            this.scrolled = keepCentred(this.categoryList, this.menu.offsetHeight, shown.el, this.scrolled);
        }
        if (shown.centredAt !== shown.at) {
            var view = this.middle.offsetHeight;
            shown.scrolled = keepCentred(shown.list, view, shown.rows[shown.at].el, shown.scrolled);
            shown.centredAt = view ? shown.at : -1;
        }
    }

    /** Something may be set anew: the lines say how */
    private changed(): void {
        this.changes++;
        this.drawValues();
    }

    /** The line under each of the focused category's settings: how it is set (none: its name alone, in the middle of
     * its row; one setting alone: not shown); drawn again only after a change */
    private drawValues(): void {
        var shown = this.categories[this.category];
        if (!this.shown || this.alone() || shown.drawnAt === this.changes) {
            return;
        }
        shown.drawnAt = this.changes;
        shown.rows.forEach(function (row) {
            var value = valueOf(row.setting);
            setText(row.value, value);
            toggleClass(row.el, 'by-settings-item--one', !value);
        });
    }

    /** Draws the right side in the next frame, for the setting focused then */
    private panelSoon(): void {
        var self = this;
        if (!this.panelFrame) {
            this.panelFrame = requestAnimationFrame(function () {
                self.panelFrame = 0;
                if (self.setting() !== self.drawn) {
                    self.drawPanel();
                }
            });
        }
    }

    /** Draws the right side now if it waits for a frame */
    private panelNow(): void {
        if (this.panelFrame) {
            cancelAnimationFrame(this.panelFrame);
            this.panelFrame = 0;
            if (this.setting() !== this.drawn) {
                this.drawPanel();
            }
        }
    }

    /** Index of the set choice's button (first if several can be set, or none is) */
    private setButton(): number {
        var c = this.setting().choices;
        return c && !c.many ? Math.max(0, this.choices.map(function (one) { return c!.isSet(one.value); }).indexOf(true)) : 0;
    }

    /** Draws the right side: picture, name, description, and choices (or steps, or code); the stylesheet shows the
     * parts for its kind (by-settings-body--*); narrower beside the middle (its width set with its content: laid out
     * once). keep: the focus stays on the choice it was on (else it goes to the set one). */
    private drawPanel(keep?: boolean): void {
        var self = this;
        var at = this.button;
        var s = this.drawn = this.setting();
        var picture = pictureOf(s);
        toggleClass(this.panel, 'by-settings-panel--narrow', !this.alone());
        this.body.className = 'by-settings-body' + (picture ? ' by-settings-body--picture' : '') +
            (s.code ? ' by-settings-body--code' : s.steps ? ' by-settings-body--steps' : s.info ? ' by-settings-body--info' : '') +
            (s.grid ? ' by-settings-body--grid' : '');
        setSrc(this.picture, picture);
        setText(this.heading, s.label);
        setText(this.summary, s.summary);
        this.steps.innerHTML = '';
        (s.steps || []).forEach(function (one) {
            self.steps.appendChild(h('li', 'by-settings-step', one));
        });
        this.info.innerHTML = '';
        (s.info ? s.info() : []).forEach(function (line) {
            self.info.appendChild(h('div', 'by-settings-fact', line));
        });
        // (lines to read beside the middle column that still do not fit under their picture: without it)
        if (s.info && !this.alone() && this.body.offsetHeight > this.panel.offsetHeight) {
            this.body.className += ' by-settings-body--tight';
        }
        if (s.code) {
            this.drawCode();
            clearTimeout(this.codeTimer);
            this.codeTimer = setTimeout(function () { self.askCode(false); }, CODE_REST_MS) as unknown as number;
        }
        this.choices = s.choices ? s.choices.list() : [];
        // (a grid's tiles stay while its choices are the same: their pictures are not built and decoded again)
        var tiles = s.grid ? s.label + ' ' + this.choices.map(function (c) { return c.value + ' ' + markOf(c.picture || ''); }).join('|') : '';
        if (!tiles || tiles !== this.tilesOf) {
            this.tilesOf = tiles;
            this.buttonsBox.innerHTML = '';
            this.buttonsBox.className = 'by-settings-buttons' + (s.grid ? ' by-settings-buttons--grid by-settings-buttons--grid' + s.grid : '');
            this.buttons = this.choices.map(function (c) {
                var button = s.grid ? choiceTile(c) : choiceButton(c);
                self.buttonsBox.appendChild(button.el);
                return button;
            });
        }
        this.button = keep && this.place === 'choices' ? Math.min(at, this.buttons.length - 1) : this.setButton();
        this.drawButtons();
    }

    /** Ticks the set choices, marks the focused one, shows its note (else the set one's; a page's always) */
    private drawButtons(): void {
        var s = this.setting();
        var c = s.choices;
        var inChoices = this.place === 'choices';
        var noted = -1;
        for (var i = 0; i < this.buttons.length; i++) {
            var isSet = !!c && c.isSet(this.choices[i].value);
            setShown(this.buttons[i].check, isSet);
            toggleClass(this.buttons[i].el, 'by-settings-button--focused', inChoices && i === this.button);
            if (inChoices || s.open ? i === this.button : isSet && noted < 0) {
                noted = i;
            }
        }
        var choice = noted >= 0 ? this.choices[noted] : null;
        // (a tile has no name on it: said here, before its note)
        setText(this.note, !choice ? '' : s.grid ? choice.name + (choice.name && choice.note ? ': ' : '') + choice.note : sentence(choice.note));
        // (Tile colour: the logo at the top on the colour focused, as the home screen's tile would show it)
        this.picture.style.backgroundColor = choice && choice.color || '';
        this.scrollPanel();
    }

    /** Shows the TV code, or the text shown instead */
    private drawCode(): void {
        setText(this.code, this.tvCode || this.codeSaid);
        toggleClass(this.code, 'by-settings-code--said', !this.tvCode);
    }

    /** Requests a TV code if there is none (again: also after a failure); shown until it expires */
    private askCode(again: boolean): void {
        var self = this;
        // (in the background, none: renewIfOld asks once back)
        if (!this.shown || document.hidden || !this.setting().code || this.tvCode || this.codeSaid === '…' || this.codeSaid && !again) {
            return;
        }
        this.codeSaid = '…';
        this.drawCode();
        this.link().then(function (got) {
            self.tvCode = got;
            self.codeSaid = '';
            clearTimeout(self.codeEnd);
            // On expiry, a new one is requested if it is showing
            self.codeEnd = setTimeout(function () { self.tvCode = ''; self.redrawCode(); }, CODE_MS) as unknown as number;
            self.redrawCode();
        }, function () {
            self.codeSaid = tr('YouTube gave no code. Press OK to try again.');
            self.redrawCode();
        });
    }

    /** Back in front: a link code that expired in the background is asked for again */
    renewIfOld(): void {
        this.askCode(false);
    }

    /** Redraws the code if showing (requests a new one when the old one expired) */
    private redrawCode(): void {
        if (this.setting().code) {
            this.drawCode();
            this.askCode(false);
        }
    }

    /** Closes what this screen opened (the language picker; the question, if from a setting's button: others stay) and
     * returns to the categories */
    private closeOwn(): void {
        this.pages().forEach(function (p) { p.close(); });
        if (this.place === 'choices') {
            this.question.close();
        }
        this.place = 'categories';
    }

    /** Shows YouTube's question; yes runs the action (and shows YouTube's reply); focus returns to the button after */
    private openAsk(ask: Ask): void {
        var self = this;
        askToClear(this.question, ask, undefined, function () { self.drawButtons(); self.changed(); });
    }

    /** When the right side is taller than the screen, scrolls it to keep the focused choice and its note in view (the
     * choice first); for a grid of tiles only the tiles and their note scroll, under the setting's name and
     * description, which stay in place. Unscrolled, nothing has a transform and so no layer of its own */
    private scrollPanel(): void {
        var b = this.buttons[this.button];
        var to = 0;
        // A grid: only the tiles scroll, the setting's top stays; any other: the whole right side, as it always did
        var pinned = !!this.drawn && !!this.drawn.grid;
        var moving = pinned ? this.scroller : this.body;
        if (this.place === 'choices' && b) {
            // (the body sits at the panel's top; the choices start where their scrolling part does in their box)
            var top = this.choicesBox.offsetTop + this.scroller.offsetTop;
            var view = this.panel.offsetHeight - (pinned ? top : 0);
            var at = pinned ? 0 : top;
            var height = pinned ? this.scroller.offsetHeight + ROOM : this.body.offsetHeight;
            if (height > view) {
                var bottom = at + (this.note.textContent ? this.note.offsetTop + this.note.offsetHeight : b.el.offsetTop + b.el.offsetHeight);
                to = Math.max(0, Math.min(height - view, at + b.el.offsetTop - ROOM, bottom + ROOM - view));
            }
            // Logo: a choice cut by the box's top edge would show a sliver under the description: on to its end (the
            // edge is at the scrolled distance less where the scrolling part starts in the box)
            var edge = to - this.scroller.offsetTop;
            for (var i = 0; pinned && to && i < this.buttons.length; i++) {
                var el = this.buttons[i].el;
                if (el.offsetTop < edge && el.offsetTop + el.offsetHeight > edge) {
                    to = el.offsetTop + el.offsetHeight + this.scroller.offsetTop;
                    break;
                }
            }
        }
        if (to !== this.panelScrolled || moving !== this.panelMoving) {
            if (this.panelMoving && this.panelMoving !== moving) {
                this.panelMoving.style.webkitTransform = '';
            }
            this.panelScrolled = to;
            this.panelMoving = moving;
            if (to) {
                translate(moving, 0, -to);
            } else {
                moving.style.webkitTransform = '';
            }
        }
    }
}
