// "Who's watching?" screen, modelled on YouTube's TV app: the accounts on this TV as round
// pictures in a row with their names (the focused one's handle under its name), "Add account"
// and "Guest" at the end. Left/Right move along it (the row scrolls to keep the focus in view, as
// Subscriptions' channels do); OK on an account switches to it (on the current one: back), on
// Add account opens the app's sign-in, on Guest watches signed out (as YouTube's "Watch as guest"). Accounts show from storage at once, then as YouTube
// names them now (api/accounts.ts; redrawn only on change). Styled by the theme (by-who).

import { h, setShown, setSrc, setText } from '../core/dom.js';
import { tr } from '../core/i18n.js';
import { View } from '../core/view.js';
import { keptProfiles, Profile, profiles } from '../api/accounts.js';
import { guestChosen } from '../api/youtube.js';
import { icon } from '../ui/icons.js';
import { Pills } from '../ui/pills.js';
import { metrics } from '../ui/theme.js';

/** focusOn's key for the Guest item */
var GUEST_KEY = 'guest';

export class AccountsView implements View {
    el: HTMLElement;
    private row: HTMLElement;
    private pills = new Pills('by-who-item--focused');
    /** The accounts in the row (Add account and Guest follow), the key of what was drawn (null: not drawn; '' no
     * accounts), the focused account ('' Add account, GUEST_KEY Guest; null: not set, so the current one) */
    private list: Profile[] = [];
    private drawn: string | null = null;
    private focusKey: string | null = null;

    /** pick: an account chosen; add: Add account; guest: Guest (current: it is already) */
    constructor(private pick: (p: Profile) => void, private add: () => void, private guest: (current: boolean) => void) {
        this.el = h('div', 'by-who');
        setShown(this.el, false);
        this.el.appendChild(h('div', 'by-who-title', tr('Who\'s watching?')));
        this.row = h('div', 'by-who-row');
        this.el.appendChild(this.row);
    }

    show(): void {
        var self = this;
        setShown(this.el, true);
        Promise.all<any>([keptProfiles(), guestChosen()]).then(function (got) {
            var guest = got[1] as boolean;
            self.draw(got[0], guest);
            return profiles().then(function (list) { self.draw(list, guest); });
        }).then(null, function () { return undefined; });
    }

    hide(): void {
        setShown(this.el, false);
    }

    /** Focuses this account the next time it shows (e.g. one just signed in; '' Add account; null: the current one) */
    focusOn(key: string | null): void {
        this.focusKey = key;
        this.drawn = null;
    }

    setFocused(focused: boolean): void {
        this.pills.setFocused(focused);
    }

    onKey(code: number): boolean {
        var self = this;
        return this.pills.key(code, { moved: function () {
            var p = self.list[self.pills.at];
            self.focusKey = p ? p.key : self.pills.at === self.list.length ? '' : GUEST_KEY;
            self.scroll();
        } });
    }

    /** Draws the row: the accounts, then Add account and Guest, focus on its account (initially the current one, Guest
     * where it was chosen) */
    private draw(list: Profile[], guest: boolean): void {
        var self = this;
        var drawn = list.map(function (p) { return [p.key, p.name, p.picture, p.handle].join('|'); }).join(';') + (guest ? ';guest' : '');
        if (drawn === this.drawn) {
            return;
        }
        this.drawn = drawn;
        this.list = list;
        this.row.innerHTML = '';
        this.pills.clear();
        list.forEach(function (p) {
            var el = h('div', 'by-who-item');
            var picture = el.appendChild(h('div', 'by-who-picture')) as HTMLElement;
            if (p.picture) {
                setSrc(picture.appendChild(h('img', 'by-who-img')) as HTMLImageElement, p.picture);
            } else {
                setText(picture, (p.name || '?').charAt(0).toUpperCase());
            }
            el.appendChild(h('div', 'by-who-name', p.name));
            el.appendChild(h('div', 'by-who-handle', p.handle));
            self.row.appendChild(self.pills.add(el, function () { self.pick(p); }));
        });
        this.tile('add', tr('Add account'), function () { self.add(); });
        this.tile('person', tr('Guest'), function () { self.guest(guest); });
        var keys = list.map(function (p) { return p.key; });
        var current = list.filter(function (p) { return p.current; })[0];
        var at = this.focusKey === null ? (current ? keys.indexOf(current.key) : guest ? list.length + 1 : 0) :
            this.focusKey === '' ? list.length : this.focusKey === GUEST_KEY ? list.length + 1 : keys.indexOf(this.focusKey);
        this.pills.focus(Math.max(0, at));
        this.scroll();
    }

    /** An item after the accounts: an icon in a circle and a label */
    private tile(iconName: string, label: string, act: () => void): void {
        var el = h('div', 'by-who-item by-who-add');
        el.appendChild(h('div', 'by-who-picture')).appendChild(icon(iconName, 'by-who-plus'));
        el.appendChild(h('div', 'by-who-name', label));
        this.row.appendChild(this.pills.add(el, act));
    }

    /** Scrolls the row so the focused item is in view */
    private scroll(): void {
        this.pills.slide(this.row, metrics().whoStep);
    }
}
