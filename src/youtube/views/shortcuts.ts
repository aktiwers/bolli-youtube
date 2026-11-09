// Settings › Shortcuts: the remote's spare buttons (api/shortcuts.ts) on a page in Settings' look. On the left what a
// shortcut can do, grouped (the rail's screens and your things, your channels and playlists, more, the player's
// actions), each with its button; on the right the focused one: what it does, its button and where it works, and its
// buttons (set or change the button, where it works, remove it; a channel's or a playlist's: delete it). "A channel…"
// picks one of your subscriptions and what its button opens (its page, its videos, its newest video), "A playlist…"
// one of your Library's playlists and what its button does (open it, play it, play it shuffled), in the side panel.
// The last rows: every button's two places, and Reset to defaults. Up/Down move, Right or OK go to the buttons, Left
// or Back return, Back again closes the page.
// ShortcutPrompt (over the whole screen, as the app's questions) sets one: "Press the button for …" (any button that
// reaches the app; arrows, OK and Back move around it), then for a go-to shortcut where it works, each choice saying
// what it would replace on that button (Everywhere chosen first, else the first that replaces nothing), and for a
// player one a question first when its button already does something in the player. Channel and playlist pages set
// one for themselves with it (main.ts). Styled by themes/<id>.css (by-shortcuts, by-shortcut-prompt).

import { h, keepCentred, setShown, setSrc, setText, toggleClass } from '../core/dom.js';
import { tr } from '../core/i18n.js';
import { digit, KEY } from '../core/keys.js';
import { holding, takesPointer } from '../core/pointer.js';
import { Page, SubChannel, Video } from '../api/feed.js';
import { Shortcut, ShortcutTarget } from '../api/prefs.js';
import { clashes, EVERYWHERE, isJump, jumping, keyName, PLAYER, removeShortcut, resetShortcuts, SCREENS, setJumping,
    setShortcut, shortcutAt, shortcutKeys, shortcutOf, shortcuts, targetAction } from '../api/shortcuts.js';
import { Pills } from '../ui/pills.js';
import { Question } from '../ui/question.js';
import { PanelLine, SidePanel } from '../ui/side-panel.js';
import { toast } from '../ui/toast.js';

/** What a shortcut can do: its action, name, what it does; a channel's or a playlist's target; kind: 'go' (where it
 * works is chosen), 'player', 'jump' (the numbers), 'channel' or 'playlist' (pick one), 'overview', 'reset', 'head' (a
 * heading) */
export interface Entry {
    action: string;
    name: string;
    about: string;
    kind: string;
    target?: ShortcutTarget;
}

/** A screen of the rail (the screens a shortcut goes to) */
export interface Section {
    id: string;
    label: string;
}

/** What the page needs of the app: the prompt (made on first use), the panel for its pickers, your subscriptions and
 * your Library's playlists */
export interface ShortcutHost {
    prompt: () => ShortcutPrompt;
    panel: SidePanel;
    channels: () => Promise<SubChannel[]>;
    playlists: () => Promise<Video[]>;
}

/** The three places a go-to shortcut can work: by name, and within a sentence */
var WHERE = [
    { id: EVERYWHERE, name: tr('Everywhere'), phrase: tr('everywhere') },
    { id: SCREENS, name: tr('Not in the player'), phrase: tr('not in the player') },
    { id: PLAYER, name: tr('Only in the player'), phrase: tr('in the player') }
];
function where(id: string): { id: string; name: string; phrase: string } {
    return WHERE.filter(function (w) { return w.id === id; })[0];
}

/** The colour buttons' colours (a dot before their names) */
var COLOURS: { [key: number]: string } = {};
COLOURS[KEY.RED] = '#e53935';
COLOURS[KEY.GREEN] = '#43a047';
COLOURS[KEY.YELLOW] = '#fdd835';
COLOURS[KEY.BLUE] = '#1e88e5';

/** A channel's and a playlist's ways: their names and what they do */
var WAYS: { [way: string]: { name: string; about: string } } = {
    page: { name: tr('Its page'), about: tr('Opens the channel\'s page.') },
    videos: { name: tr('Its videos'), about: tr('Opens the channel\'s videos, newest first.') },
    newest: { name: tr('Play its newest video'), about: tr('Plays the channel\'s newest video.') },
    open: { name: tr('Open it'), about: tr('Opens the playlist\'s page.') },
    play: { name: tr('Play it'), about: tr('Plays the playlist from its first video.') },
    shuffle: { name: tr('Play it shuffled'), about: tr('Plays the playlist in a random order.') }
};
var WAYS_OF: { [kind: string]: string[] } = { channel: ['page', 'videos', 'newest'], playlist: ['open', 'play', 'shuffle'] };

function noop(): void {
    return undefined;
}

/** A channel's or a playlist's shortcut (api/shortcuts.ts targetAction), named after it and the way */
export function targetEntry(action: string, target: ShortcutTarget): Entry {
    var way = WAYS[action.split(':')[1]];
    return { action: action, name: target.title + ' · ' + way.name, about: way.about, kind: 'go', target: target };
}

/** The ways of a channel or a playlist (kind) as the side panel's lines, each with its button under it if it has one;
 * OK asks for the button (done: once set) */
export function wayLines(kind: string, id: string, target: ShortcutTarget, prompt: ShortcutPrompt, done?: (action: string) => void): PanelLine[] {
    return WAYS_OF[kind].map(function (way) {
        var action = targetAction(kind, way, id);
        var set = shortcutOf(action);
        return { label: WAYS[way].name, under: set ? keyName(set.key) : '', action: function () {
            prompt.set(targetEntry(action, target), done ? function () { done(action); } : undefined);
        } };
    });
}

/** The numbers that jump: "0–9", else which */
function digitsText(keys: number[]): string {
    return keys.length === 10 ? '0–9' : keys.map(digit).sort().join(' ');
}

/** What a shortcut can do, under headings: the screens of the rail (sections) and Settings, your things, your channels
 * and playlists with those set, more, the player's actions, then the overview and Reset */
function catalog(sections: Section[]): Entry[] {
    var entry = function (kind: string, action: string, name: string, about: string): Entry {
        return { action: action, name: name, about: about, kind: kind };
    };
    var go = function (action: string, name: string, about: string): Entry { return entry('go', action, name, about); };
    var player = function (action: string, name: string, about: string): Entry { return entry('player', action, name, about); };
    var list: Entry[] = [entry('head', '', tr('Go to'), '')];
    sections.forEach(function (s) {
        list.push(go('section:' + s.id, s.label, s.id === 'search' ? tr('The search keyboard, ready to type.') : tr('Goes to {1}, as from the rail.', s.label)));
    });
    list.push(go('section:settings', tr('Settings'), tr('All of Bolli\'s settings.')),
        go('history', tr('History'), tr('What you watched, newest first.')),
        go('watchLater', tr('Watch later'), tr('Your Watch later list.')),
        go('liked', tr('Liked videos'), tr('The videos you liked.')),
        entry('head', '', tr('Your channels'), ''),
        entry('channel', '', tr('A channel…'), tr('Pick one of your subscriptions, then what its button opens: its page, its videos or its newest video.')));
    var custom = function (kind: string): void {
        shortcuts().forEach(function (s) {
            if (s.target && s.action.indexOf(kind + ':') === 0) {
                list.push(targetEntry(s.action, s.target));
            }
        });
    };
    custom('channel');
    list.push(entry('head', '', tr('Your playlists'), ''),
        entry('playlist', '', tr('A playlist…'), tr('Pick one of your playlists, then what its button does: open it, play it or play it shuffled.')));
    custom('playlist');
    list.push(entry('head', '', tr('More'), ''),
        go('screenOff', tr('Screen off'), tr('The screen goes black while the sound plays on, as Settings › Screen off shows it; Waking the screen there says which buttons wake it.')),
        go('subscribe', tr('Subscribe / unsubscribe'), tr('In a video, its channel; on the screens, the channel of the video or channel you are on. Unsubscribing asks for a second press.')),
        go('resume', tr('Continue the last video'), tr('The video you closed last, from where you stopped.')),
        go('accounts', tr('Switch account'), tr('"Who\'s watching?": your accounts.')),
        entry('head', '', tr('In the player'), ''),
        player('chat', tr('Live chat on/off'), tr('Shows or hides a live stream\'s chat.')),
        player('chatSettings', tr('Live chat settings'), tr('The live chat settings over the stream.')),
        player('subtitles', tr('Subtitles on/off'), tr('Subtitles in the language you chose last, or off.')),
        player('subtitleNext', tr('Next subtitle language'), tr('Steps through the video\'s subtitles, then off.')),
        player('audio', tr('Next audio track'), tr('Steps through the dubbed languages, where a video has them.')),
        player('faster', tr('Faster'), tr('Speeds up a step (1.25, 1.5, 2…).')),
        player('slower', tr('Slower'), tr('Slows down a step.')),
        player('normal', tr('Normal speed'), tr('Back to normal speed.')),
        player('back30', tr('Back 30 seconds'), tr('Jumps 30 seconds back.')),
        player('forward30', tr('Forward 30 seconds'), tr('Jumps 30 seconds forward.')),
        player('chapterBack', tr('Previous chapter'), tr('The start of the chapter, or in its first seconds the chapter before.')),
        player('chapterNext', tr('Next chapter'), tr('The next chapter, in one press.')),
        player('restart', tr('Restart the video'), tr('From the beginning.')),
        player('unskip', tr('Undo the last SponsorBlock skip'), tr('Back to where SponsorBlock skipped from, for when it skipped something you wanted.')),
        player('like', tr('Like'), tr('Likes the video (again: no longer).')),
        player('saveLater', tr('Save to Watch later'), tr('Adds the video to Watch later.')),
        player('comments', tr('Comments'), tr('Opens the comments over the video.')),
        player('playlist', tr('Show the playlist'), tr('The playlist the video plays from, as Settings › Playlist in the player shows it.')),
        player('repeat', tr('Repeat on/off'), tr('Plays the video again and again.')),
        player('stats', tr('Stats for nerds'), tr('The playback details over the video.')),
        player('next', tr('Next video'), tr('The next in the queue, else YouTube\'s next.')),
        player('previous', tr('Previous video'), tr('The video before.')),
        entry('jump', 'jump', tr('Numbers jump in the video'), tr('In a video 0 is the start, 5 the middle, 9 is 90%; on the screens a number keeps what it does. One given something only in the player does not jump.')),
        entry('head', '', '', ''),
        entry('overview', '', tr('Every button'), tr('What each button does on the screens and in the player.')),
        entry('reset', '', tr('Reset to defaults'), tr('Back to the default buttons: the numbers for the screens and Settings, the colours, P+ / P− for the next and previous video, Guide to like, the button next to 0 to subscribe.')));
    return list;
}

/** A button's name with its colour's dot before it (into el) */
function putKey(el: HTMLElement, key: number, text: string): void {
    el.innerHTML = '';
    if (COLOURS[key]) {
        var dot = el.appendChild(h('span', 'by-shortcut-dot')) as HTMLElement;
        dot.style.backgroundColor = COLOURS[key];
    }
    el.appendChild(document.createTextNode(text));
}

/** The keys of a column of buttons (the prompt's, the page's): Up/Down move (then moved), OK presses, Left or Back go
 * back; true: one of those */
function columnKey(pills: Pills, code: number, moved: () => void, back: () => void): boolean {
    switch (code) {
        case KEY.UP:
        case KEY.DOWN:
            pills.move(code === KEY.UP ? -1 : 1);
            moved();
            return true;
        case KEY.OK:
            pills.press();
            return true;
        case KEY.LEFT:
        case KEY.BACK:
            back();
            return true;
    }
    return false;
}

/** Sets shortcuts: the button first, then where it works (go-to ones) or, if its button already does something in the
 * player, whether to replace that (player ones) */
export class ShortcutPrompt {
    el: HTMLElement;
    private picture: HTMLImageElement;
    private heading: HTMLElement;
    private summary: HTMLElement;
    private box: HTMLElement;
    private note: HTMLElement;
    private pills = new Pills('by-settings-button--focused');
    /** The step: '' closed, 'key', 'where' or 'confirm'; the entry, its button, the notes of the where-choices */
    private step = '';
    private entry: Entry | null = null;
    private key = 0;
    private notes: { text: string; clash: boolean }[] = [];
    private done: () => void = noop;
    /** The catalog's names by action (made on first use; a channel's or playlist's and the jumps are named apart) */
    private names: { [action: string]: string } | null = null;

    constructor(parent: HTMLElement, private sections: Section[]) {
        this.el = h('div', 'by-question by-shortcut-prompt');
        this.picture = this.el.appendChild(h('img', 'by-settings-picture')) as HTMLImageElement;
        this.heading = this.el.appendChild(h('div', 'by-settings-heading')) as HTMLElement;
        this.summary = this.el.appendChild(h('div', 'by-settings-summary')) as HTMLElement;
        this.box = this.el.appendChild(h('div', 'by-settings-buttons')) as HTMLElement;
        this.note = this.el.appendChild(h('div', 'by-settings-note')) as HTMLElement;
        setShown(this.el, false);
        parent.appendChild(this.el);
    }

    get shown(): boolean {
        return !!this.step;
    }

    /** What can be set, under headings (Settings › Shortcuts' list) */
    entries(): Entry[] {
        return catalog(this.sections);
    }

    /** A shortcut's name: its entry's, a number's jump */
    nameOf(s: Shortcut): string {
        if (isJump(s.action)) {
            return tr('Jump to {1}%', +s.action.slice(5) * 10);
        }
        if (s.target) {
            return targetEntry(s.action, s.target).name;
        }
        if (!this.names) {
            var names: { [action: string]: string } = this.names = {};
            this.entries().forEach(function (e) {
                if (e.action) {
                    names[e.action] = e.name;
                }
            });
        }
        return this.names[s.action] || s.action;
    }

    /** Asks for entry's button, then where (done: once set) */
    set(entry: Entry, done?: () => void): void {
        this.entry = entry;
        this.done = done || noop;
        this.askKey('');
    }

    /** Asks where entry's shortcut works now (done: once changed) */
    moveTo(entry: Entry, done?: () => void): void {
        var s = shortcutOf(entry.action) as Shortcut;
        this.entry = entry;
        this.key = s.key;
        this.done = done || noop;
        this.askWhere(WHERE.indexOf(where(s.where)));
    }

    close(): void {
        this.step = '';
        setShown(this.el, false);
    }

    /** Takes every key while shown */
    onKey(code: number): boolean {
        var self = this;
        if (!this.step) {
            return false;
        }
        if (this.step === 'key') {
            this.pressed(code);
        } else {
            // (OK held is OK here)
            columnKey(this.pills, code === KEY.HOLD ? KEY.OK : code, function () { self.drawNote(); }, function () { self.close(); });
        }
        return true;
    }

    /** "Press the button for …" (warn: why the last press was not taken) */
    private askKey(warn: string): void {
        var e = this.entry as Entry;
        this.show('key', tr('Press the button for {1}', e.name),
            tr('A colour button, a number, P+ or P−, or another spare button of the remote. Back cancels.'));
        this.setNote(warn, !!warn);
    }

    /** A press while asking for the button: arrows and OK move around the app, Back cancels, a key that cannot be a
     * shortcut is refused */
    private pressed(code: number): void {
        if (code === KEY.BACK) {
            this.close();
            return;
        }
        if (!keyName(code)) {
            this.askKey(code >= KEY.LEFT && code <= KEY.DOWN || code === KEY.OK || code === KEY.HOLD ?
                tr('The arrows and OK move around the app. Press another button.') : tr('That button cannot be a shortcut. Press another one.'));
            return;
        }
        this.key = code;
        var e = this.entry as Entry;
        if (e.kind !== 'player') {
            this.askWhere(-1);
            return;
        }
        var was = shortcutAt(code, PLAYER);
        if (was && was.action !== e.action && !isJump(was.action)) {
            this.confirm(was);
        } else {
            this.bind(PLAYER);
        }
    }

    /** Where it works, each choice's note saying what it would replace; chosen first: at (-1: the first that replaces
     * nothing, Everywhere if it does not) */
    private askWhere(at: number): void {
        var self = this;
        var e = this.entry as Entry;
        var key = keyName(this.key);
        this.show('where', tr('Where should {1} do {2}?', key, e.name), tr('Each choice says what it would replace on {1}.', key));
        this.notes = WHERE.map(function (w) { return self.effect(w.id); });
        WHERE.forEach(function (w) {
            self.pills.add(self.box.appendChild(h('div', 'by-settings-button', w.name)) as HTMLElement, function () { self.bind(w.id); });
        });
        this.pills.focus(at >= 0 ? at : Math.max(0, this.notes.map(function (n) { return !n.clash; }).indexOf(true)));
        this.pills.setFocused(true);
        this.drawNote();
    }

    /** "In the player, Red is Subtitles": replace it, or pick another button */
    private confirm(was: Shortcut): void {
        var self = this;
        var e = this.entry as Entry;
        var name = this.nameOf(was);
        this.show('confirm', tr('In the player, {1} is {2}', keyName(this.key), name),
            tr('{1} takes its place in the player.', e.name) + ' ' + (was.where === EVERYWHERE ? tr('{1} stays on the screens.', name) : tr('{1} loses its button.', name)));
        this.pills.add(this.box.appendChild(h('div', 'by-settings-button', tr('Replace it'))) as HTMLElement, function () { self.bind(PLAYER); });
        this.pills.add(this.box.appendChild(h('div', 'by-settings-button', tr('Pick another button'))) as HTMLElement, function () { self.askKey(''); });
        this.pills.focus(0);
        this.pills.setFocused(true);
    }

    /** What the shortcut on its button at place would replace there, and what the other place keeps */
    private effect(place: string): { text: string; clash: boolean } {
        var self = this;
        var e = this.entry as Entry;
        var both = place === EVERYWHERE;
        var hits = clashes(this.key, place, e.action).map(function (c) {
            var name = self.nameOf(c.shortcut);
            return both ? (c.place === PLAYER ? tr('{1} in the player', name) : tr('{1} on the screens', name)) : name;
        });
        var text = hits.length ? tr('Replaces {1}.', hits.join(', ')) : tr('Nothing else is on {1} there.', keyName(this.key));
        var other = both ? null : shortcutAt(this.key, place === PLAYER ? SCREENS : PLAYER);
        if (other && other.action !== e.action) {
            text += ' ' + (place === PLAYER ? tr('On the screens it stays {1}.', this.nameOf(other)) : tr('In the player it stays {1}.', this.nameOf(other)));
        }
        return { text: text, clash: hits.length > 0 };
    }

    /** Sets it: its button at place, said in a toast with what lost its button */
    private bind(place: string): void {
        var self = this;
        var e = this.entry as Entry;
        var key = keyName(this.key);
        var gone = setShortcut({ key: this.key, where: place, action: e.action, target: e.target });
        var said = place === EVERYWHERE ? tr('{1}: {2} everywhere', key, e.name) : place === SCREENS ? tr('{1}: {2}, not in the player', key, e.name) :
            tr('{1}: {2} in the player', key, e.name);
        gone.forEach(function (s) {
            said += ' · ' + (isJump(s.action) ? tr('{1} no longer jumps', key) : tr('{1} has no button now', self.nameOf(s)));
        });
        this.close();
        toast(said, 'check');
        this.done();
    }

    /** Shows step with its heading and summary, its buttons cleared */
    private show(step: string, heading: string, summary: string): void {
        this.step = step;
        // (loaded once first shown)
        setSrc(this.picture, 'shortcuts.png');
        setText(this.heading, heading);
        setText(this.summary, summary);
        this.box.innerHTML = '';
        this.pills.clear();
        this.setNote('', false);
        setShown(this.el, true);
    }

    /** The focused where-choice's note */
    private drawNote(): void {
        var n = this.step === 'where' ? this.notes[this.pills.at] : null;
        this.setNote(n ? n.text : '', !!n && n.clash);
    }

    private setNote(text: string, warn: boolean): void {
        setText(this.note, text);
        toggleClass(this.note, 'by-shortcut-warn', warn);
    }
}

/** The page's buttons for an entry: label, a note on it when focused, the press */
interface Button {
    label: string;
    note: string;
    press: () => void;
}

export class ShortcutsPage {
    el: HTMLElement;
    private menu: HTMLElement;
    private list: HTMLElement;
    private heading: HTMLElement;
    private summary: HTMLElement;
    private now: HTMLElement;
    private overview: HTMLElement;
    private box: HTMLElement;
    private note: HTMLElement;
    private entries: Entry[] = [];
    private rows: ({ el: HTMLElement } | null)[] = [];
    private at = 0;
    /** The row marked focused (or at) last */
    private marked = -1;
    private inButtons = false;
    private buttons: Button[] = [];
    private pills = new Pills('by-settings-button--focused');
    private scrolled = 0;
    shown = false;

    constructor(parent: HTMLElement, private host: ShortcutHost, private question: Question) {
        var self = this;
        this.el = h('div', 'by-settings by-shortcuts');
        this.el.appendChild(h('div', 'by-settings-title', tr('Shortcuts')));
        this.menu = this.el.appendChild(h('div', 'by-settings-menu')) as HTMLElement;
        this.list = this.menu.appendChild(h('div', 'by-settings-list')) as HTMLElement;
        this.el.appendChild(h('div', 'by-settings-line'));
        var panel = this.el.appendChild(h('div', 'by-settings-panel')) as HTMLElement;
        var body = panel.appendChild(h('div', 'by-settings-body')) as HTMLElement;
        this.heading = body.appendChild(h('div', 'by-settings-heading')) as HTMLElement;
        this.summary = body.appendChild(h('div', 'by-settings-summary')) as HTMLElement;
        this.now = body.appendChild(h('div', 'by-shortcut-now')) as HTMLElement;
        this.overview = body.appendChild(h('div', 'by-shortcut-overview')) as HTMLElement;
        this.box = body.appendChild(h('div', 'by-settings-buttons')) as HTMLElement;
        this.note = body.appendChild(h('div', 'by-settings-note')) as HTMLElement;
        setShown(this.el, false);
        parent.appendChild(this.el);
        // A click on an entry focuses it; on a button (its pill focused it) presses it
        takesPointer(this.el, function (target, under) {
            var i = holding(self.rows, target);
            if (i >= 0) {
                self.inButtons = false;
                self.focusRow(i);
                return { key: 0 };
            }
            if (under) {
                self.inButtons = true;
                self.drawFocus();
            }
            return under;
        });
    }

    /** Opens the page at its first entry */
    open(): void {
        this.shown = true;
        this.inButtons = false;
        this.build(0);
        setShown(this.el, true);
    }

    close(): void {
        this.shown = false;
        setShown(this.el, false);
    }

    /** The page while open (null: closed; the pointer's layer: core/pointer.ts) */
    layer(): HTMLElement | null {
        return this.shown ? this.el : null;
    }

    onKey(code: number): boolean {
        var self = this;
        if (this.inButtons) {
            columnKey(this.pills, code, function () { self.drawNote(); }, function () {
                self.inButtons = false;
                self.drawFocus();
            });
            return true;
        }
        switch (code) {
            case KEY.UP:
            case KEY.DOWN:
                var step = code === KEY.UP ? -1 : 1;
                for (var i = this.at + step; i >= 0 && i < this.entries.length; i += step) {
                    if (this.rows[i]) {
                        this.focusRow(i);
                        break;
                    }
                }
                break;
            case KEY.RIGHT:
            case KEY.OK:
                if (this.buttons.length) {
                    this.inButtons = true;
                    this.pills.focus(0);
                    this.drawFocus();
                }
                break;
            case KEY.BACK:
                this.close();
                break;
        }
        return true;
    }

    /** The list built anew with each entry's button (after every change), the focus on action's entry if given, else
     * at the place it had (at the first entry at or after it), the buttons left */
    private build(at: number, action?: string): void {
        var self = this;
        this.inButtons = false;
        this.entries = this.host.prompt().entries();
        this.list.innerHTML = '';
        this.marked = -1;
        this.rows = this.entries.map(function (e) {
            if (e.kind === 'head') {
                if (e.name) {
                    self.list.appendChild(h('div', 'by-settings-group', e.name));
                }
                return null;
            }
            var el = self.list.appendChild(h('div', 'by-settings-item by-shortcut')) as HTMLElement;
            self.drawKey(el.appendChild(h('span', 'by-shortcut-key')) as HTMLElement, e);
            el.appendChild(h('span', 'by-shortcut-name', e.name));
            return { el: el };
        });
        var found = action ? this.entries.map(function (e) { return e.action; }).indexOf(action) : -1;
        var to = found >= 0 ? found : Math.min(at, this.entries.length - 1);
        while (!this.rows[to] && to < this.entries.length - 1) {
            to++;
        }
        this.focusRow(to);
    }

    /** Built anew after a change, the focus on action's entry (else where it was) */
    private rebuild(action?: string): void {
        this.build(this.at, action);
    }

    /** Focuses entry i: it shows on the right */
    private focusRow(i: number): void {
        this.at = i;
        this.drawPanel();
        this.drawFocus();
    }

    /** The focused row marked (focused, or at while the buttons have the focus), the buttons' focus and note, the list
     * scrolled to it */
    private drawFocus(): void {
        var self = this;
        [this.marked, this.at].forEach(function (i) {
            var row = self.rows[i];
            if (row) {
                toggleClass(row.el, 'by-settings-item--focused', i === self.at && !self.inButtons);
                toggleClass(row.el, 'by-settings-item--at', i === self.at && self.inButtons);
            }
        });
        this.marked = this.at;
        this.pills.setFocused(this.inButtons);
        this.drawNote();
        var row = this.rows[this.at];
        if (row) {
            this.scrolled = keepCentred(this.list, this.menu.offsetHeight, row.el, this.scrolled);
        }
    }

    /** An entry's button in the list: its name (the numbers that jump: 0–9 or which), '' none */
    private drawKey(el: HTMLElement, e: Entry): void {
        if (e.kind === 'jump') {
            putKey(el, 0, digitsText(jumping()));
            return;
        }
        var s = e.action ? shortcutOf(e.action) : null;
        putKey(el, s ? s.key : 0, s ? keyName(s.key) : '');
    }

    /** The focused entry: what it does, its button and where it works, its buttons (or every button's two places) */
    private drawPanel(): void {
        var self = this;
        var e = this.entries[this.at];
        var s = e.action && e.kind !== 'jump' ? shortcutOf(e.action) : null;
        setText(this.heading, e.name);
        setText(this.summary, e.about);
        if (s) {
            putKey(this.now, s.key, tr('Now: {1}, {2}', keyName(s.key), where(s.where).phrase));
        } else {
            setText(this.now, e.kind === 'go' || e.kind === 'player' ? tr('No button yet') : '');
        }
        setShown(this.now, !!this.now.textContent);
        this.overview.innerHTML = '';
        if (e.kind === 'overview') {
            this.overviewLines().forEach(function (line) {
                putKey(self.overview.appendChild(h('div', 'by-shortcut-line')) as HTMLElement, line.key, line.text);
            });
        }
        this.buttons = this.buttonsFor(e, s);
        this.box.innerHTML = '';
        this.pills.clear();
        this.buttons.forEach(function (b) {
            self.pills.add(self.box.appendChild(h('div', 'by-settings-button', b.label)) as HTMLElement, b.press);
        });
        this.pills.focus(0);
    }

    private drawNote(): void {
        var b = this.inButtons ? this.buttons[this.pills.at] : null;
        setText(this.note, b ? b.note : '');
    }

    /** The buttons for e (s: its shortcut, null: none) */
    private buttonsFor(e: Entry, s: Shortcut | null): Button[] {
        var self = this;
        var prompt = this.host.prompt;
        var redraw = function (): void { self.rebuild(e.action); };
        if (e.kind === 'jump') {
            var on = jumping().length > 0;
            return [{ label: on ? tr('Turn off') : tr('Turn on'), note: on ? tr('the numbers then do nothing in the player, unless you give them shortcuts') :
                tr('the numbers jump in a video, those not given other shortcuts in the player'), press: function () {
                setJumping(!on);
                toast(on ? tr('The numbers no longer jump in a video') : tr('The numbers jump in a video'), 'check');
                redraw();
            } }];
        }
        if (e.kind === 'channel' || e.kind === 'playlist') {
            return [{ label: e.kind === 'channel' ? tr('Pick a channel') : tr('Pick a playlist'), note: '', press: function () { self.pick(e.kind); } }];
        }
        if (e.kind === 'reset') {
            return [{ label: tr('Reset to defaults'), note: tr('your channels\' and playlists\' shortcuts go too'), press: function () {
                self.question.open({ title: tr('Reset the shortcuts?'), subtitle: e.about, picture: 'shortcuts.png', yes: tr('Reset'), no: tr('Cancel') }, function () {
                    resetShortcuts();
                    toast(tr('The shortcuts are back to the defaults'), 'check');
                    self.build(0);
                });
            } }];
        }
        if (e.kind === 'overview') {
            return [];
        }
        var list: Button[] = [{ label: s ? tr('Change the button') : tr('Set a button'), note: tr('then press the button on the remote'), press: function () {
            prompt().set(e, redraw);
        } }];
        if (s && e.kind === 'go') {
            list.push({ label: tr('Works: {1}', where(s.where).name), note: tr('everywhere, not in the player, or only in the player'), press: function () {
                prompt().moveTo(e, redraw);
            } });
        }
        if (s && !e.target) {
            list.push({ label: tr('Remove'), note: tr('the button then does nothing there'), press: function () {
                removeShortcut(e.action);
                toast(tr('{1}: {2} removed', keyName(s!.key), e.name), 'check');
                redraw();
            } });
        }
        if (e.target) {
            list.push({ label: tr('Delete this shortcut'), note: '', press: function () {
                removeShortcut(e.action);
                toast(tr('Shortcut deleted'), 'check');
                self.rebuild();
            } });
        }
        return list;
    }

    /** Every button that does something: its two places (the numbers that only jump in one line) */
    private overviewLines(): { key: number; text: string }[] {
        var prompt = this.host.prompt();
        var out: { key: number; text: string }[] = [];
        var jumps: number[] = [];
        shortcutKeys().forEach(function (key) {
            var screens = shortcutAt(key, SCREENS);
            var player = shortcutAt(key, PLAYER);
            if (!screens && player && isJump(player.action)) {
                jumps.push(key);
                return;
            }
            var parts: string[] = [];
            if (screens && screens === player) {
                parts.push(tr('{1} everywhere', prompt.nameOf(screens)));
            } else {
                if (screens) {
                    parts.push(tr('{1} on the screens', prompt.nameOf(screens)));
                }
                if (player) {
                    parts.push(tr('{1} in the player', prompt.nameOf(player)));
                }
            }
            if (parts.length) {
                out.push({ key: key, text: keyName(key) + ': ' + parts.join(' · ') });
            }
        });
        if (jumps.length) {
            out.push({ key: 0, text: tr('{1}: jump in the video (5: its middle)', digitsText(jumps)) });
        }
        return out.length ? out : [{ key: 0, text: tr('No button has a shortcut') }];
    }

    /** "A channel…" or "A playlist…": your subscriptions or your Library's playlists in the side panel ("Loading …"
     * meanwhile), then what its button does; the button is asked for next */
    private pick(kind: string): void {
        var self = this;
        var panel = this.host.panel;
        var ways = function (name: string, id: string, target: ShortcutTarget): void {
            panel.push(name, wayLines(kind, id, target, self.host.prompt(), function (action) { self.rebuild(action); }));
        };
        if (kind === 'channel') {
            panel.openAsked(tr('Your subscriptions'), this.host.channels(), function (list) {
                return list.length ? list.map(function (c) {
                    var page: Page | null = c.channel;
                    return { label: c.title, stay: true, action: function () {
                        ways(c.title, page ? page.browseId : c.page.browseId + (c.page.params || ''), { title: c.title, channel: page, videos: c.page });
                    } };
                }) : [{ label: tr('No subscriptions yet.'), plain: true }];
            }, tr('your subscriptions'));
        } else {
            panel.openAsked(tr('Your playlists'), this.host.playlists(), function (list) {
                return list.length ? list.map(function (v) {
                    return { label: v.title, under: v.info, stay: true, action: function () {
                        ways(v.title, (v.page as Page).browseId.replace(/^VL/, ''), { title: v.title });
                    } };
                }) : [{ label: tr('No playlists yet.'), plain: true }];
            }, tr('your library'));
        }
    }
}
