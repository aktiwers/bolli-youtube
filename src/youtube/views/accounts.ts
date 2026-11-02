// "Who's watching?" screen, modelled on YouTube's TV app: the accounts on this TV as round
// pictures in a row with their names (the focused one's handle under its name), "Add account"
// at the end. Left/Right move along it (the row scrolls to keep the focus in view, as
// Subscriptions' channels do); OK on an account switches to it (on the current one: back), on
// Add account opens the app's sign-in. Accounts show from storage at once, then as YouTube
// names them now (api/accounts.ts; redrawn only on change). Styled by the theme (by-who).

import { h, setShown, setSrc, setText, translate } from '../../core/dom.js';
import { KEY } from '../../core/keys.js';
import { View } from '../../core/view.js';
import { keptProfiles, Profile, profiles } from '../api/accounts.js';
import { icon } from '../ui/icons.js';
import { Pills } from '../ui/pills.js';
import { metrics } from '../ui/theme.js';

export class AccountsView implements View {
    el: HTMLElement;
    private row: HTMLElement;
    private pills = new Pills('by-who-item--focused');
    /** The accounts in the row (Add account follows), the key of what was drawn (null: not drawn; '' no accounts), the
     * focused account ('' Add account; null: not set, so the current one) */
    private list: Profile[] = [];
    private drawn: string | null = null;
    private focusKey: string | null = null;

    /** pick: an account chosen; add: Add account */
    constructor(private pick: (p: Profile) => void, private add: () => void) {
        this.el = h('div', 'by-who');
        setShown(this.el, false);
        this.el.appendChild(h('div', 'by-who-title', 'Who\'s watching?'));
        this.row = h('div', 'by-who-row');
        this.el.appendChild(this.row);
    }

    show(): void {
        var self = this;
        setShown(this.el, true);
        keptProfiles().then(function (list) {
            self.draw(list);
            return profiles();
        }).then(function (list) { self.draw(list); }, function () { return undefined; });
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
        switch (code) {
            case KEY.LEFT:
            case KEY.RIGHT:
                // Left of the first goes to the rail
                if (this.pills.move(code === KEY.LEFT ? -1 : 1)) {
                    var p = this.list[this.pills.at];
                    this.focusKey = p ? p.key : '';
                    this.scroll();
                    return true;
                }
                return code === KEY.RIGHT;
            case KEY.OK:
                this.pills.press();
                return true;
            case KEY.UP:
            case KEY.DOWN:
                return true;
        }
        return false;
    }

    /** Draws the row: the accounts, then Add account, focus on its account (initially the current one) */
    private draw(list: Profile[]): void {
        var self = this;
        var drawn = list.map(function (p) { return [p.key, p.name, p.picture, p.handle].join('|'); }).join(';');
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
        var add = h('div', 'by-who-item by-who-add');
        add.appendChild(h('div', 'by-who-picture')).appendChild(icon('add', 'by-who-plus'));
        add.appendChild(h('div', 'by-who-name', 'Add account'));
        this.row.appendChild(this.pills.add(add, function () { self.add(); }));
        var keys = list.map(function (p) { return p.key; });
        var at = this.focusKey === null ? keys.indexOf((list.filter(function (p) { return p.current; })[0] || { key: '' }).key) :
            this.focusKey === '' ? list.length : keys.indexOf(this.focusKey);
        this.pills.focus(Math.max(0, at));
        this.scroll();
    }

    /** Scrolls the row so the focused item is in view */
    private scroll(): void {
        var step = metrics().whoStep;
        var inView = Math.floor((1280 - metrics().rows.pad) / step);
        translate(this.row, -Math.max(0, this.pills.at - inView + 1) * step, 0);
    }
}
