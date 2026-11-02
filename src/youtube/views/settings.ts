// Settings, laid out like YouTube's TV app: a grouped list on the left, the
// focused setting on the right (picture, description, choices as buttons
// with the set one ticked, a note on the focused choice). Right or OK enter
// the choices; OK sets one (or toggles it where several can be set); Left or
// Back return to the list, then to the rail. The list keeps the focused
// setting centred once it scrolls. Order: the app's own settings
// (api/prefs.ts, saved at once), phone linking, then the account's History &
// data settings that have an effect here (fetched when Settings shows).
// Clearing a history asks first, with YouTube's question.

import { h, setShown, setSrc, setText, toggleClass, translate } from '../../core/dom.js';
import { KEY } from '../../core/keys.js';
import { View } from '../../core/view.js';
import { AccountGroup, AccountSetting, historySettings } from '../api/account-settings.js';
import { Ask } from '../api/feed.js';
import { ALWAYS, languageName } from '../api/languages.js';
import { HIGHEST, prefs, Prefs, setPref } from '../api/prefs.js';
import { PARTS } from '../api/sponsorblock.js';
import { apply, askToClear } from '../ui/account.js';
import { icon } from '../ui/icons.js';
import { LanguagePicker } from '../ui/language-picker.js';
import { CAPTION_STYLES } from '../player/captions.js';
import { Question } from '../ui/question.js';
import { applyTheme, themes } from '../ui/theme.js';

/** A setting's choice: value, name, note ('' for none) */
interface Choice {
    value: string | number;
    name: string;
    note: string;
}

/** A setting's choices: list, isSet, choose; many: several can be set (OK toggles one) */
interface Choices {
    list: () => Choice[];
    isSet: (value: string | number) => boolean;
    choose: (value: string | number) => void;
    many?: boolean;
}

/** A setting: name, description, picture ('' for none); its choices, or the steps to link a phone (code: shows a TV
 * code, for a phone on another network) */
interface Setting {
    label: string;
    summary: string;
    picture: string;
    choices?: Choices;
    steps?: string[];
    code?: boolean;
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

/** A setting with choices: now() gives the set value, set() changes it */
function pick(label: string, summary: string, picture: string, list: () => Choice[], now: () => string | number,
    set: (value: string | number) => void): Setting {
    return { label: label, summary: summary, picture: picture, choices: { list: list, isSet: function (value) { return value === now(); }, choose: set } };
}

/** An app pref with choices (then: called after a choice) */
function pref<K extends keyof Prefs>(label: string, summary: string, picture: string, name: K, list: () => Choice[],
    then?: (value: string | number) => void): Setting {
    return pick(label, summary, picture, list, function () { return prefs()[name] as unknown as string | number; }, function (value) {
        setPref(name, value as unknown as Prefs[K]);
        if (then) {
            then(value);
        }
    });
}

/** An app on/off pref, with notes for on and off */
function flag(label: string, summary: string, picture: string, name: 'history' | 'preload' | 'startSign' | 'sabr', on: string, off: string): Setting {
    return pick(label, summary, picture, function () { return onOff(on, off); }, function () { return prefs()[name] ? 1 : 0; },
        function (value) { setPref(name, value === 1); });
}

function onOff(on: string, off: string): Choice[] {
    return [{ value: 1, name: 'On', note: on }, { value: 0, name: 'Off', note: off }];
}

/** Autoplay: off, or the next video after an "Up next" countdown of so many seconds (overrides the account's own
 * autoplay setting) */
function autoplay(): Setting {
    var after = function (s: number): Choice {
        return { value: s, name: 'After ' + s + ' seconds', note: '"Up next" counts down, then the next video plays' };
    };
    return pick('Autoplay', 'When a video ends in Bolli\'s player, the next one plays. When on, this overrides your YouTube account\'s autoplay setting.',
        pic('autoplay'), function () {
            return [
                { value: -1, name: 'Off', note: 'the player closes at a video\'s end' },
                { value: 0, name: 'Right away', note: 'the next video plays at once' },
                after(3), after(5), after(10)
            ];
        }, function () {
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

/** Subtitles turned on automatically: a language (the default ones plus those added via "More languages"); a choice
 * in the player sets it too. more: opens the search over all languages */
function subtitles(more: () => void): Setting {
    return pick('Subtitles', 'Subtitles Bolli\'s player turns on by itself', pic('language'), function () {
        var now = prefs().captions;
        var on = 'on in every video with subtitles, translated by YouTube if needed';
        var list: Choice[] = [{ value: '', name: 'Off', note: 'only when you turn them on in the player' }];
        ALWAYS.concat(prefs().captionLanguages).forEach(function (code) {
            list.push({ value: code, name: languageName(code), note: on });
        });
        if (now && !list.some(function (c) { return c.value === now; })) {
            list.push({ value: now, name: languageName(now), note: 'as chosen in the player' });
        }
        return list.concat([{ value: MORE, name: 'More languages', note: 'find any language YouTube translates subtitles to; it joins this list' }]);
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

function sponsorBlock(): Setting {
    return {
        label: 'SponsorBlock',
        summary: 'Skips the parts of videos that SponsorBlock\'s users marked. Choose the kinds to skip.',
        // SponsorBlock's logo (from github.com/ajayyy/SponsorBlock), bundled with the app
        picture: 'sponsorblock.png',
        choices: {
            list: function () {
                return PARTS.map(function (k) { return { value: k.id, name: k.name, note: k.note }; });
            },
            isSet: function (id) {
                return prefs().skip.indexOf(id as string) >= 0;
            },
            choose: function (id) {
                var skip = prefs().skip;
                setPref('skip', skip.indexOf(id as string) >= 0 ? skip.filter(function (one) { return one !== id; }) : skip.concat([id as string]));
            },
            many: true
        }
    };
}

/** The app's own settings (pages: possible start pages; more: Subtitles' "More languages") */
function bolli(pages: StartPage[], more: () => void): Setting[] {
    var settings = [
        pref('Player', 'The player the videos play in', pic('living_room_pre_app_user_setting'), 'player', function () {
            return [
                { value: 'bolli', name: 'Bolli\'s player', note: 'starts sooner, quick keys, up to 4K, its own watch page (Down)' },
                { value: 'youtube', name: 'YouTube\'s player', note: 'YouTube\'s own, with its own watch page' }
            ];
        }),
        autoplay(),
        pref('Video quality', 'The quality videos start at', pic('clear_search_history'), 'quality', function () {
            return [
                { value: 0, name: 'Auto', note: 'as good as the video and the connection allow, up to 4K' },
                { value: HIGHEST, name: 'Highest available', note: 'the best the video has, up to 4K' },
                { value: 2160, name: '4K (2160p)', note: 'or the closest below it' },
                { value: 1440, name: '1440p (2K)', note: 'or the closest below it' },
                { value: 1080, name: '1080p (HD)', note: 'or the closest below it' },
                { value: 720, name: '720p', note: 'or the closest below it' },
                { value: 480, name: '480p', note: 'or the closest below it' }
            ];
        }),
        subtitles(more),
        pref('Subtitle style', 'How YouTube\'s automatic subtitles appear', pic('language'), 'captionStyle', function () {
            return CAPTION_STYLES;
        }),
        pref('Previews', 'The video whose tile you rest on plays in the tile (in Bolli\'s player)', pic('clear_watch_history'), 'previews', function () {
            return [
                { value: 'sound', name: 'With sound', note: '' },
                { value: 'muted', name: 'Without sound', note: '' },
                { value: 'off', name: 'Off', note: '' }
            ];
        }),
        sponsorBlock(),
        flag('History', 'What you watch in Bolli\'s player, told to YouTube', pic('privacy_and_terms'),
            'history', 'it goes into your YouTube history, and YouTube remembers where you stopped', 'Bolli\'s player tells YouTube nothing of what you watch'),
        // Any page of the rail
        pref('Start page', 'The screen the app starts on', pic('location'), 'startPage', function () {
            return pages.map(function (p) { return { value: p.id, name: p.label, note: '' }; });
        }),
        pref('Tile pictures', 'How sharp the tiles\' pictures are', pic('linked_devices'), 'pictures', function () {
            return [
                { value: 'sharpest', name: 'Sharpest', note: 'the clearest pictures; they take the most memory (about 30 MB more while a video plays)' },
                { value: 'sharp', name: 'Sharp', note: 'clearer pictures, a little more memory' },
                { value: 'standard', name: 'Standard', note: 'YouTube\'s small pictures: softer on this screen, the least memory' }
            ];
        }),
        flag('Videos start sooner', 'The video or page whose tile you rest on gets ready', pic('send_feedback'), 'preload',
            'it opens about a second sooner', ''),
        flag('Loading sign', 'What shows while a video starts in Bolli\'s player', pic('reset_app'), 'startSign',
            'the channel\'s picture fills up', 'the screen stays dark until the video plays'),
        flag('Streams by SABR', 'How Bolli\'s player gets the videos', pic('parent_code'), 'sabr',
            'as YouTube\'s TV app does (signed in, by SABR), as a guest when that fails',
            'as a guest, signed in (by SABR) only when YouTube asks, as for an age check')
    ];
    // Only when there is more than one theme
    if (themes().length > 1) {
        settings.push(pref('Theme', 'How the app looks', '', 'theme', function () {
            return themes().map(function (t) { return { value: t.id, name: t.name, note: '' }; });
        }, function (id) { applyTheme(String(id)); }));
    }
    return settings;
}

/** Linking a phone: by casting on the same network, or with a TV code from another (YouTube's steps) */
var LINK: Setting[] = [
    { label: 'Link with Wi-Fi', summary: '', picture: '', steps: ['On your phone, connect to the same Wi-Fi network as this device.',
        'Open the YouTube app on your phone.', 'Tap the cast icon and select this device.'] },
    { label: 'Link with TV code', summary: '', picture: '', code: true, steps: ['On your phone, open the YouTube app.',
        'Tap the cast icon.', 'Tap \'Link with TV code\' and enter the code below.'] }
];

/** "a thing" as "A thing" */
function sentence(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
}

/** i moved one up or down, clamped to 0..count-1 */
function step(i: number, count: number, code: number): number {
    return Math.max(0, Math.min(count - 1, i + (code === KEY.UP ? -1 : 1)));
}

/** Focus location: the list or the focused setting's choices (a confirmation question may cover them) */
type Place = 'list' | 'choices';

export class SettingsView implements View {
    el: HTMLElement;
    private menu: HTMLElement;
    private list: HTMLElement;
    private body: HTMLElement;
    private picture: HTMLImageElement;
    private heading: HTMLElement;
    private summary: HTMLElement;
    private steps: HTMLElement;
    private code: HTMLElement;
    private phone: HTMLImageElement;
    private buttonsBox: HTMLElement;
    private note: HTMLElement;
    /** Settings in list order with their elements; ownCount: how many precede the account's */
    private items: { setting: Setting; el: HTMLElement }[] = [];
    private ownCount = 0;
    private at = 0;
    private place: Place = 'list';
    private focused = false;
    private shown = false;
    /** Scroll offsets of the list and the right side */
    private scrolled = 0;
    private panelScrolled = 0;
    /** The setting shown on the right, its choices, their buttons, the focused button */
    private drawn: Setting | null = null;
    private choices: Choice[] = [];
    private buttons: { el: HTMLElement; check: HTMLElement }[] = [];
    private button = 0;
    /** Subtitles' "More languages" picker; takes the keys while open */
    private languages: LanguagePicker;
    /** The account's History & data group as shown, and its elements */
    private history: AccountGroup | null = null;
    private historyEls: HTMLElement[] = [];
    /** The TV code ('' if none or expired), the text shown instead ('…' while requesting), the rest timer, the expiry
     * timer */
    private tvCode = '';
    private codeSaid = '';
    private codeTimer = 0;
    private codeEnd = 0;

    /** link: requests a TV code from YouTube; pages: possible start pages; question: the app's confirmation dialog
     * (gets keys first while shown) */
    constructor(private link: () => Promise<string>, pages: StartPage[], private question: Question) {
        this.el = h('div', 'by-settings');
        setShown(this.el, false);
        this.el.appendChild(h('div', 'by-settings-title', 'Settings'));
        this.menu = h('div', 'by-settings-menu');
        this.list = h('div', 'by-settings-list');
        this.menu.appendChild(this.list);
        this.el.appendChild(this.menu);
        this.el.appendChild(h('div', 'by-settings-line'));
        var panel = h('div', 'by-settings-panel');
        this.body = h('div', 'by-settings-body');
        this.picture = this.body.appendChild(h('img', 'by-settings-picture')) as HTMLImageElement;
        this.heading = this.body.appendChild(h('div', 'by-settings-heading')) as HTMLElement;
        this.summary = this.body.appendChild(h('div', 'by-settings-summary')) as HTMLElement;
        var linkBox = this.body.appendChild(h('div', 'by-settings-link')) as HTMLElement;
        this.steps = linkBox.appendChild(h('ol', 'by-settings-steps')) as HTMLElement;
        this.code = linkBox.appendChild(h('div', 'by-settings-code')) as HTMLElement;
        this.phone = this.body.appendChild(h('img', 'by-settings-phone')) as HTMLImageElement;
        this.buttonsBox = this.body.appendChild(h('div', 'by-settings-buttons')) as HTMLElement;
        this.note = this.body.appendChild(h('div', 'by-settings-note')) as HTMLElement;
        panel.appendChild(this.body);
        this.el.appendChild(panel);
        this.languages = new LanguagePicker(this.el);
        var self = this;
        this.addGroup('Bolli', bolli(pages, function () { self.moreLanguages(); }));
        this.addGroup('Link TV & phone', LINK);
        this.ownCount = this.items.length;
        this.drawFocus();
    }

    show(): void {
        var self = this;
        this.shown = true;
        setShown(this.el, true);
        this.drawFocus();
        // Returning to "Link with TV code": request a code if there is none, as when focus rests on it
        if (this.items[this.at].setting.code) {
            this.askCode(false);
        }
        // On failure show none, rather than a previous account's
        historySettings().then(function (group) { self.putHistory(group); }, function () { self.putHistory(null); });
    }

    hide(): void {
        this.shown = false;
        this.languages.close();
        this.closeOwn();
        this.place = 'list';
        setShown(this.el, false);
    }

    /** Called after every key */
    setFocused(focused: boolean): void {
        if (focused === this.focused) {
            return;
        }
        this.focused = focused;
        if (!focused) {
            this.languages.close();
            this.closeOwn();
            this.place = 'list';
        }
        this.drawFocus();
    }

    onKey(code: number): boolean {
        if (this.languages.shown) {
            return this.languages.onKey(code);
        }
        if (this.place === 'choices') {
            this.choicesKey(code);
            return true;
        }
        switch (code) {
            case KEY.UP:
            case KEY.DOWN:
                this.at = step(this.at, this.items.length, code);
                this.drawFocus();
                return true;
            case KEY.RIGHT:
            case KEY.OK:
                if (this.buttons.length) {
                    this.place = 'choices';
                    this.button = this.setButton();
                    this.drawFocus();
                } else if (code === KEY.OK && this.items[this.at].setting.code) {
                    this.askCode(true);
                }
                return true;
        }
        return false;
    }

    /** Keys in the choices: Up/Down move, OK sets, Left or Back return to the list */
    private choicesKey(code: number): void {
        switch (code) {
            case KEY.UP:
            case KEY.DOWN:
                this.button = step(this.button, this.buttons.length, code);
                this.drawButtons();
                break;
            case KEY.OK:
                this.items[this.at].setting.choices!.choose(this.choices[this.button].value);
                this.drawButtons();
                break;
            case KEY.LEFT:
            case KEY.BACK:
                this.place = 'list';
                this.drawFocus();
                break;
        }
    }

    /** Subtitles' "More languages": the chosen language is set and added to the list */
    private moreLanguages(): void {
        var self = this;
        this.languages.open(prefs().captions, function (code) {
            var added = prefs().captionLanguages;
            if (ALWAYS.indexOf(code) < 0 && added.indexOf(code) < 0) {
                setPref('captionLanguages', added.concat([code]));
            }
            setPref('captions', code);
            self.drawPanel();
        });
    }

    /** Appends a group heading and its settings to the list; returns their elements */
    private addGroup(title: string, settings: Setting[]): HTMLElement[] {
        var self = this;
        var els = [this.list.appendChild(h('div', 'by-settings-group', title)) as HTMLElement];
        settings.forEach(function (s) {
            var el = self.list.appendChild(h('div', 'by-settings-item', s.label)) as HTMLElement;
            self.items.push({ setting: s, el: el });
            els.push(el);
        });
        return els;
    }

    /** Puts the account's History & data group last, replacing the previous one (no-op for the same reply) */
    private putHistory(group: AccountGroup | null): void {
        var self = this;
        if (group === this.history) {
            return;
        }
        this.history = group;
        this.historyEls.forEach(function (el) { self.list.removeChild(el); });
        this.items.length = this.ownCount;
        this.historyEls = group ? this.addGroup(group.title, group.settings.map(function (a) { return self.accountSetting(a); })) : [];
        this.at = Math.min(this.at, this.items.length - 1);
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
        var setting = pick(a.title, a.summary, a.picture, function () { return onOff('', ''); }, function () { return a.on ? 1 : 0; }, function (value) {
            apply(a, 'on', value === 1, value === 1 ? a.enable : a.disable, function () {
                if (self.drawn === setting) {
                    self.drawButtons();
                }
            }, 'YouTube did not take the change. Try again.');
        });
        return setting;
    }

    /** Marks the focused setting, scrolls it into view and shows it on the right */
    private drawFocus(): void {
        for (var i = 0; i < this.items.length; i++) {
            toggleClass(this.items[i].el, 'by-settings-item--focused', i === this.at && this.focused && this.place === 'list');
            toggleClass(this.items[i].el, 'by-settings-item--at', i === this.at && (!this.focused || this.place !== 'list'));
        }
        if (this.items[this.at].setting !== this.drawn) {
            this.drawPanel();
        } else {
            this.drawButtons();
        }
        this.scrollList();
    }

    /** Index of the set choice's button (first if several can be set, or none is) */
    private setButton(): number {
        var c = this.items[this.at].setting.choices;
        return c && !c.many ? Math.max(0, this.choices.map(function (one) { return c!.isSet(one.value); }).indexOf(true)) : 0;
    }

    /** Draws the right side: picture, name, description, and choices (or steps, or code); the stylesheet shows the
     * parts for its kind (by-settings-body--*) */
    private drawPanel(): void {
        var self = this;
        var s = this.drawn = this.items[this.at].setting;
        this.body.className = 'by-settings-body' + (s.picture ? ' by-settings-body--picture' : '') +
            (s.code ? ' by-settings-body--code' : s.steps ? ' by-settings-body--steps' : '');
        if (s.picture) {
            setSrc(this.picture, s.picture);
        }
        setText(this.heading, s.label);
        setText(this.summary, s.summary);
        this.steps.innerHTML = '';
        (s.steps || []).forEach(function (one) {
            self.steps.appendChild(h('li', 'by-settings-step', one));
        });
        if (s.code) {
            setSrc(this.phone, pic('link_with_tv_code_static_v2'));
            this.drawCode();
            clearTimeout(this.codeTimer);
            this.codeTimer = setTimeout(function () { self.askCode(false); }, CODE_REST_MS) as unknown as number;
        }
        this.buttonsBox.innerHTML = '';
        this.choices = s.choices ? s.choices.list() : [];
        this.buttons = this.choices.map(function (c) {
            var el = self.buttonsBox.appendChild(h('div', 'by-settings-button', c.name)) as HTMLElement;
            return { el: el, check: el.appendChild(icon('check', 'by-check')) as HTMLElement };
        });
        this.button = this.setButton();
        this.drawButtons();
    }

    /** Ticks the set choices, marks the focused one, shows its note (else the set one's) */
    private drawButtons(): void {
        var c = this.items[this.at].setting.choices;
        var inChoices = this.place === 'choices';
        var noted = -1;
        for (var i = 0; i < this.buttons.length; i++) {
            var isSet = !!c && c.isSet(this.choices[i].value);
            setShown(this.buttons[i].check, isSet);
            toggleClass(this.buttons[i].el, 'by-settings-button--focused', inChoices && i === this.button);
            if (inChoices ? i === this.button : isSet && noted < 0) {
                noted = i;
            }
        }
        setText(this.note, noted >= 0 ? sentence(this.choices[noted].note) : '');
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
        if (!this.shown || !this.items[this.at].setting.code || this.tvCode || this.codeSaid === '…' || this.codeSaid && !again) {
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
            self.codeSaid = 'YouTube gave no code. Press OK to try again.';
            self.redrawCode();
        });
    }

    /** Redraws the code if showing (requests a new one when the old one expired) */
    private redrawCode(): void {
        if (this.items[this.at].setting.code) {
            this.drawCode();
            this.askCode(false);
        }
    }

    /** Closes the question if this screen opened it (from a setting's button; others stay) */
    private closeOwn(): void {
        if (this.place === 'choices') {
            this.question.close();
        }
    }

    /** Shows YouTube's question; yes runs the action (and shows YouTube's reply); focus returns to the button after */
    private openAsk(ask: Ask): void {
        var self = this;
        askToClear(this.question, ask, undefined, function () { self.drawButtons(); });
    }

    /** Scrolls the list to keep the focused setting centred (clamped at both ends) */
    private scrollList(): void {
        var view = this.menu.offsetHeight;
        if (!view) {
            return;
        }
        var el = this.items[this.at].el;
        var to = Math.max(0, Math.min(this.list.offsetHeight - view, el.offsetTop + el.offsetHeight / 2 - view / 2));
        if (to !== this.scrolled) {
            this.scrolled = to;
            translate(this.list, 0, -to);
        }
    }

    /** When the right side is taller than the screen, scrolls it to keep the focused choice and its note in view
     * (the choice first); unscrolled, it has no transform and so no layer of its own */
    private scrollPanel(): void {
        var b = this.buttons[this.button];
        var to = 0;
        if (this.place !== 'list' && b) {
            var view = (this.body.parentNode as HTMLElement).offsetHeight;
            if (this.body.offsetHeight > view) {
                var bottom = this.note.textContent ? this.note.offsetTop + this.note.offsetHeight : b.el.offsetTop + b.el.offsetHeight;
                to = Math.max(0, Math.min(this.body.offsetHeight - view, b.el.offsetTop - ROOM, bottom + ROOM - view));
            }
        }
        if (to !== this.panelScrolled) {
            this.panelScrolled = to;
            if (to) {
                translate(this.body, 0, -to);
            } else {
                this.body.style.webkitTransform = '';
            }
        }
    }
}
