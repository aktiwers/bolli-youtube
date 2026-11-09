// The remote's spare buttons as shortcuts (Settings › Shortcuts: views/shortcuts.ts; main.ts runs them). Each button
// has two places, on the screens and in the player, and a shortcut fills one of them or both: a go-to one (a screen, a
// page, a channel, a playlist, Switch account) works everywhere, not in the player, or only there; a player one only
// in the player. A new shortcut takes its places on its button from the shortcuts there (one left with the other place
// keeps it, one left with none goes), and leaves the button it had. Any button that reaches the app can be one, but
// for the arrows, OK and Back (they move around the app) and the search key; the TV keeps some buttons to itself (Home,
// Settings, Input, the volume), which never arrive. The numbers' jumps in a video (Numbers jump in the video) lie over
// what the numbers do everywhere, there alone. Stored as Settings (prefs.ts shortcuts: its defaults there).

import { tr } from '../core/i18n.js';
import { KEY } from '../core/keys.js';
import { prefDefault, prefs, setPref, Shortcut } from './prefs.js';

/** The buttons known by name: the colours, P+ and P− (Android's channel and page keys), the numbers, and the media
 * and other keys of LG's remotes (Android passes the colours, channels, numbers and Guide); any other is named by its
 * code */
var KEYS: { [code: number]: string } = {};
KEYS[KEY.RED] = tr('Red');
KEYS[KEY.GREEN] = tr('Green');
KEYS[KEY.YELLOW] = tr('Yellow');
KEYS[KEY.BLUE] = tr('Blue');
KEYS[KEY.CH_UP] = 'P+';
KEYS[KEY.CH_DOWN] = 'P−';
KEYS[415] = tr('Play');
KEYS[19] = tr('Pause');
KEYS[413] = tr('Stop');
KEYS[412] = tr('Rewind');
KEYS[417] = tr('Fast-forward');
KEYS[457] = tr('Info');
KEYS[KEY.GUIDE] = tr('Guide');
KEYS[KEY.LIST] = tr('List');
KEYS[KEY.SCREEN_REMOTE] = tr('Screen remote');
for (var n = 0; n <= 9; n++) {
    KEYS[KEY.NUM_0 + n] = String(n);
}
/** The named buttons in the order Settings lists them: the colours, P+ and P−, the others, the numbers last (1 to 9,
 * then 0, as on the remote) */
var ORDER = [KEY.RED, KEY.GREEN, KEY.YELLOW, KEY.BLUE, KEY.CH_UP, KEY.CH_DOWN, 415, 19, 413, 412, 417, 457, KEY.GUIDE, KEY.LIST, KEY.SCREEN_REMOTE];
for (var d = 1; d <= 10; d++) {
    ORDER.push(KEY.NUM_0 + d % 10);
}
/** Never a shortcut: the arrows, OK (and OK held) and Back, the search key, the Magic Remote's pointer showing or
 * hiding */
var NEVER = [KEY.LEFT, KEY.UP, KEY.RIGHT, KEY.DOWN, KEY.OK, KEY.HOLD, KEY.BACK, KEY.VOICE, 1536, 1537, 0];

/** A shortcut's places */
export var SCREENS = 'screens';
export var PLAYER = 'player';
export var EVERYWHERE = 'everywhere';

/** The button's name ('' for one that cannot be a shortcut) */
export function keyName(code: number): string {
    return NEVER.indexOf(code) >= 0 ? '' : KEYS[code] || tr('Button {1}', code);
}

/** The buttons in the order Settings lists them: the named ones, then any other that has a shortcut */
export function shortcutKeys(): number[] {
    var others = shortcuts().map(function (s) { return s.key; }).filter(function (key, i, all) {
        return ORDER.indexOf(key) < 0 && all.indexOf(key) === i;
    });
    return ORDER.concat(others.sort(function (a, b) { return a - b; }));
}

/** The places where a shortcut works */
function placesOf(where: string): string[] {
    return where === EVERYWHERE ? [SCREENS, PLAYER] : [where];
}

/** The shortcuts as set */
export function shortcuts(): Shortcut[] {
    return prefs().shortcuts;
}

/** The button that wakes the screen while it is off: Screen off's, with Settings › Waking the screen at its button
 * (0: any button wakes it; so too when no button has Screen off, or none would) */
export function wakeKey(): number {
    var s = prefs().screenWake === 'button' ? shortcutOf('screenOff') : null;
    return s ? s.key : 0;
}

/** What key does in place (null: nothing): its shortcut for that place alone before one working everywhere (a number's
 * jump in a video over what the number does everywhere) */
export function shortcutAt(key: number, place: string): Shortcut | null {
    var list = shortcuts();
    var wide: Shortcut | null = null;
    for (var i = 0; i < list.length; i++) {
        if (list[i].key === key && list[i].where === place) {
            return list[i];
        }
        if (list[i].key === key && list[i].where === EVERYWHERE && !wide) {
            wide = list[i];
        }
    }
    return wide;
}

/** The shortcut doing action (null: it has no button) */
export function shortcutOf(action: string): Shortcut | null {
    return shortcuts().filter(function (s) { return s.action === action; })[0] || null;
}

/** What giving key to action where would replace: the shortcuts on key in those places, each with the place it would
 * lose */
export function clashes(key: number, where: string, action: string): { shortcut: Shortcut; place: string }[] {
    var out: { shortcut: Shortcut; place: string }[] = [];
    placesOf(where).forEach(function (place) {
        var s = shortcutAt(key, place);
        if (s && s.action !== action) {
            out.push({ shortcut: s, place: place });
        }
    });
    return out;
}

/** Gives s its button where it works (any button it had before goes): the shortcuts on that button keep the place left
 * to them (one working everywhere has none where one for that place alone lies over it: a number's jump), those left
 * with none go (returned) */
export function setShortcut(s: Shortcut): Shortcut[] {
    var mine = placesOf(s.where);
    var gone: Shortcut[] = [];
    var all = shortcuts();
    var over = function (one: Shortcut, place: string): boolean {
        return one.where === EVERYWHERE && all.some(function (o) { return o !== one && o.key === one.key && o.where === place && o.action !== s.action; });
    };
    var list = all.filter(function (one) { return one.action !== s.action; }).map(function (one) {
        if (one.key !== s.key) {
            return one;
        }
        var left = placesOf(one.where).filter(function (place) { return mine.indexOf(place) < 0 && !over(one, place); });
        if (!left.length) {
            gone.push(one);
            return null;
        }
        return left.length < placesOf(one.where).length ? { key: one.key, where: left[0], action: one.action, target: one.target } : one;
    }).filter(function (one) { return !!one; }) as Shortcut[];
    setPref('shortcuts', list.concat([s]));
    return gone;
}

/** Takes action's button away */
export function removeShortcut(action: string): void {
    setPref('shortcuts', shortcuts().filter(function (s) { return s.action !== action; }));
}

/** A number's jump in a video: 'jump:5' goes to its middle (n tenths: 0 the start) */
export function isJump(action: string): boolean {
    return action.indexOf('jump:') === 0;
}

/** A channel's or a playlist's shortcut (kind) doing way: 'channel:videos:UC…', 'playlist:shuffle:PL…' */
export function targetAction(kind: string, way: string, id: string): string {
    return kind + ':' + way + ':' + id;
}

/** The numbers that jump in a video (their keys) */
export function jumping(): number[] {
    return shortcuts().filter(function (s) { return isJump(s.action); }).map(function (s) { return s.key; });
}

/** The numbers jump in a video, or none does: over what one does everywhere (that stays: it does it again once they
 * stop), not over what one was given only in the player */
export function setJumping(on: boolean): void {
    var list = shortcuts().filter(function (s) { return !isJump(s.action); });
    if (on) {
        for (var n = 0; n <= 9; n++) {
            var key = KEY.NUM_0 + n;
            if (!list.some(function (s) { return s.key === key && s.where === PLAYER; })) {
                list.push({ key: key, where: PLAYER, action: 'jump:' + n });
            }
        }
    }
    setPref('shortcuts', list);
}

/** Back to the default buttons (prefs.ts) */
export function resetShortcuts(): void {
    setPref('shortcuts', prefDefault('shortcuts'));
}
