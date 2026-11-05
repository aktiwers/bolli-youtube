// Search screen, modelled on YouTube's TV app. No rail: a round back arrow at the left (Left
// goes to it; OK on it, or Back, returns to the previous screen). The typed text sits in a
// fixed field at the top, above the on-screen keyboard (src/ui/keyboard.ts) in YouTube's
// layout (the remote's number keys type digits); left of it are YouTube's suggestions for the
// text (api/suggest.ts), or the recent searches while nothing is typed. OK on a suggestion, or
// Search, shows YouTube's result rows under the keyboard and focuses them: the keyboard
// scrolls away under the field. Back returns to the keyboard; typing again replaces the
// results with suggestions. Results for the focused suggestion (or the text, on Search) are
// prefetched; more tiles and shelves load as the focus nears the end. With nothing typed,
// YouTube's "From recommended searches" row shows under the keyboard.

import { h, setClass, setShown, setText, toggleClass, translate } from '../../core/dom.js';
import { KEY } from '../../core/keys.js';
import { listen } from '../../core/platform.js';
import { View } from '../../core/view.js';
import { Keyboard } from '../../ui/keyboard.js';
import { RowStack } from '../../ui/row-stack.js';
import { search, Video } from '../api/feed.js';
import { keepSearch, recentSearches, Suggestion, suggestions } from '../api/suggest.js';
import { icon, setIcon } from '../ui/icons.js';
import { youtubeKeyboard } from '../ui/youtube-keyboard.js';
import { metrics } from '../ui/theme.js';
import { brandedRows, Paging, rowH, VideoTiles } from './tiles.js';

/** Suggestions are requested once typing pauses this long (YouTube's app requests on every key) */
var SUGGEST_MS = 80;
/** Focus resting this long on a suggestion (or on Search) prefetches its results */
var REST_MS = 400;
var SUGGESTIONS_MAX = 10;
/** YouTube's keyboard's letters after a to g (æ, ø and å where YouTube has other keys), and its Search key */
var LETTERS = ['hijklmnæ', 'opqrstuø', "vwxyz-'å"];
var ENTER = 'Search';

/** Where the focus is: the back arrow, the suggestions, the keyboard or the results */
type Place = 'back' | 'list' | 'keys' | 'rows';

/** A suggestion's row, built once (its parts rewritten as the suggestions change) */
interface Item {
    el: HTMLElement;
    icon: HTMLElement;
    picture: HTMLImageElement;
    typed: HTMLElement;
    rest: HTMLElement;
    line: HTMLElement;
}

export class SearchView implements View {
    el: HTMLElement;
    private content: HTMLElement;
    private query: HTMLElement;
    private back: HTMLElement;
    private list: HTMLElement;
    private status: HTMLElement;
    private keyboard: Keyboard;
    private stack = new RowStack('bd-search-rows', rowH(), metrics().searchRowsTop);
    private tiles = new VideoTiles();
    private paging = new Paging(this.tiles, 'search');
    private at: Place = 'keys';
    private focused = true;
    /** The suggestions shown (or the recent searches), their rows, and the focused one */
    private suggested: Suggestion[] = [];
    private items: Item[] = [];
    private pick = 0;
    /** The term whose results show ('' none) */
    private searched = '';
    /** The rows under the keyboard are YouTube's recommended searches (nothing typed) */
    private recommended = false;
    private suggestTimer = 0;
    private restTimer = 0;
    /** Incremented per request, so a late answer for older text is dropped */
    private suggestAsked = 0;
    private searchAsked = 0;
    /** Where the rows start in the content (measured once) */
    private rowsTop = 0;

    /** open: OK on a tile; onBack: the back arrow (or Back); ahead: prefetches a term's results */
    constructor(private open: (video: Video) => void, private onBack: () => void, private ahead: (term: string) => void) {
        var self = this;
        this.tiles.shown = function () { return self.stack.rows; };
        this.el = h('div', 'bd-search');
        setShown(this.el, false);
        this.content = h('div', 'bd-search-content');
        this.query = h('div', 'bd-search-query');
        this.back = icon('back', 'by-search-back');
        this.list = h('div', 'by-suggestions');
        this.keyboard = youtubeKeyboard(LETTERS, function (text) {
            self.changed(text);
        }, ENTER);
        this.keyboard.onEnter = function () {
            self.submit(self.keyboard.text);
        };
        for (var i = 0; i < SUGGESTIONS_MAX; i++) {
            this.items.push(this.newItem());
        }
        this.status = h('div', 'bd-search-status');
        this.content.appendChild(this.list);
        this.content.appendChild(this.keyboard.el);
        this.content.appendChild(this.status);
        this.content.appendChild(this.stack.el);
        this.el.appendChild(this.content);
        // The field and the arrow stay where they are, the rest scrolls under them
        this.el.appendChild(h('div', 'by-search-top'));
        this.el.appendChild(this.query);
        this.el.appendChild(this.back);
        this.renderQuery();
        this.mark();
    }

    /** Entering from another screen: focus starts on the keyboard (as in YouTube's app) */
    enter(): void {
        this.at = 'keys';
    }

    /** Voice search (the remote's voice key: Android's speech input over the app): searches what was said at once, as
     * YouTube does; false: no speech input here */
    voice(): boolean {
        var self = this;
        return listen(function (said: string) { self.submit(said); });
    }

    show(): void {
        this.tiles.rebrand();
        setShown(this.el, true);
        this.stack.setShown(true);
        this.mark();
        // Nothing typed: the recent searches, and YouTube's recommended searches under the keyboard
        if (!this.keyboard.text) {
            this.showSuggestions(this.recent());
            this.showRecommended();
        }
    }

    /** YouTube's "From recommended searches" under the keyboard (its answer to an empty search; loaded once) */
    private showRecommended(): void {
        if (this.recommended || this.searched) {
            return;
        }
        var asked = ++this.searchAsked;
        var self = this;
        search('').then(brandedRows).then(function (rows) {
            if (asked === self.searchAsked && !self.keyboard.text) {
                self.recommended = true;
                self.paging.set(rows.shelves, rows.next);
                self.stack.setRows(self.tiles.rows(rows.shelves, true));
                self.mark();
            }
        }, function () { return undefined; });
    }

    hide(): void {
        clearTimeout(this.restTimer);
        setShown(this.el, false);
        this.stack.setShown(false);
    }

    /** Updates a just-played video's tiles with its progress */
    setProgress(id: string, progress: number): void {
        this.tiles.setProgress(this.stack, id, progress);
    }

    /** Removes a video's tiles at once (YouTube dropped it: Not interested) */
    removeVideo(id: string): void {
        this.paging.drop(this.stack, id);
        this.place();
    }

    setFocused(focused: boolean): void {
        if (focused !== this.focused) {
            this.focused = focused;
            if (!focused) {
                clearTimeout(this.restTimer);
            }
            this.mark();
        }
    }

    onKey(code: number): boolean {
        if (this.at !== 'rows' && this.keyboard.typeDigit(code)) {
            return true;
        }
        switch (this.at) {
            case 'back':
                return this.backKey(code);
            case 'list':
                return this.listKey(code);
            case 'keys':
                return this.keysKey(code);
        }
        return this.rowsKey(code);
    }

    /** The video (or page) whose tile has the focus (none in the keyboard or the suggestions) */
    focusedVideo(): Video | null {
        var row = this.stack.row;
        return this.focused && this.at === 'rows' && row ? this.tiles.video(row.focused) : null;
    }

    private go(at: Place): void {
        this.at = at;
        this.mark();
        this.restSoon();
    }

    /** Keys on the back arrow: OK goes back, Right to the suggestions (or the keyboard) */
    private backKey(code: number): boolean {
        switch (code) {
            case KEY.OK:
                this.onBack();
                return true;
            case KEY.RIGHT:
                this.go(this.suggested.length ? 'list' : 'keys');
                return true;
        }
        // Back is left to the app (it returns to where Search was opened from)
        return code !== KEY.BACK;
    }

    /** Keys on the suggestions: Up/Down go through them, OK searches one, Right to the keyboard, Left to the arrow */
    private listKey(code: number): boolean {
        switch (code) {
            case KEY.UP:
            case KEY.DOWN:
                var to = this.pick + (code === KEY.UP ? -1 : 1);
                if (to >= 0 && to < this.suggested.length) {
                    this.pick = to;
                    this.go('list');
                }
                return true;
            case KEY.RIGHT:
                this.go('keys');
                return true;
            case KEY.LEFT:
                this.go('back');
                return true;
            case KEY.OK:
                this.submit(this.suggested[this.pick].text);
                return true;
        }
        return false;
    }

    /** Keys on the keyboard: Left at its left edge to the suggestions (or the arrow), Down at its end to the results */
    private keysKey(code: number): boolean {
        if (code === KEY.LEFT && this.keyboard.atLeftEdge) {
            this.go(this.suggested.length ? 'list' : 'back');
            return true;
        }
        if (this.keyboard.onKey(code)) {
            this.restSoon();
            return true;
        }
        if (code === KEY.DOWN && this.stack.rows.length) {
            this.stack.focusRow(0);
            this.go('rows');
            return true;
        }
        return false;
    }

    /** Keys in the results: Up from the first row and Back go back to the keyboard */
    private rowsKey(code: number): boolean {
        var row = this.stack.row;
        if (!row) {
            this.go('keys');
            return true;
        }
        switch (code) {
            case KEY.LEFT:
            case KEY.RIGHT:
                if (!row.move(code === KEY.LEFT ? -1 : 1)) {
                    // Left at the first tile: the arrow
                    if (code === KEY.LEFT) {
                        this.go('back');
                    }
                    return true;
                }
                this.paging.ahead(this.stack, true);
                return true;
            case KEY.UP:
                if (!this.stack.move(-1)) {
                    this.go('keys');
                }
                this.mark();
                return true;
            case KEY.DOWN:
                if (this.stack.move(1)) {
                    this.mark();
                }
                this.paging.ahead(this.stack, false);
                return true;
            case KEY.BACK:
                this.go('keys');
                return true;
            case KEY.OK:
                var video = this.tiles.video(row.focused);
                if (video) {
                    this.open(video);
                }
                return true;
        }
        return false;
    }

    private changed(text: string): void {
        this.renderQuery();
        // Typing again: the results (or recommended searches) give way to suggestions; with the text cleared, the
        // recommended searches return
        if (this.searched && text !== this.searched || this.recommended && text) {
            this.clearResults();
        }
        if (!text) {
            this.showRecommended();
        }
        this.suggest(text.trim(), SUGGEST_MS);
    }

    /** Shows term's suggestions after wait ms (empty term: the recent searches) */
    private suggest(term: string, wait: number): void {
        clearTimeout(this.suggestTimer);
        var asked = ++this.suggestAsked;
        if (!term) {
            this.showSuggestions(this.recent());
            return;
        }
        var self = this;
        this.suggestTimer = setTimeout(function () {
            suggestions(term).then(function (list) {
                if (asked === self.suggestAsked) {
                    self.showSuggestions(list.slice(0, SUGGESTIONS_MAX));
                }
            }, function () { return undefined; });
        }, wait) as unknown as number;
    }

    /** Shows term's results (kept among the recent searches) and focuses them once loaded */
    private submit(text: string): void {
        var term = text.trim();
        if (!term) {
            return;
        }
        clearTimeout(this.restTimer);
        keepSearch(term);
        this.keyboard.setValue(term);
        this.renderQuery();
        // Back from the results: the keyboard with the term's suggestions beside it (as YouTube's)
        this.suggest(term, 0);
        this.searched = term;
        this.recommended = false;
        this.paging.stop();
        var asked = ++this.searchAsked;
        // No status text while loading
        setText(this.status, '');
        var self = this;
        search(term).then(brandedRows).then(function (rows) {
            if (asked !== self.searchAsked) {
                return;
            }
            // All of YouTube's rows, as its app shows them
            self.paging.set(rows.shelves, rows.next);
            self.stack.setRows(self.tiles.rows(rows.shelves, true));
            setText(self.status, rows.shelves.length ? '' : 'Nothing found for "' + term + '"');
            if (rows.shelves.length) {
                self.stack.focusRow(0);
                self.at = 'rows';
            }
            self.mark();
        }, function () {
            if (asked === self.searchAsked) {
                setText(self.status, 'YouTube did not answer. Try again in a moment.');
            }
        });
    }

    private clearResults(): void {
        this.searched = '';
        this.recommended = false;
        this.searchAsked++;
        this.paging.stop();
        this.stack.clear();
        setText(this.status, '');
    }

    /** The recent searches, as suggestions */
    private recent(): Suggestion[] {
        return recentSearches().map(function (text) {
            return { text: text };
        });
    }

    private newItem(): Item {
        var el = h('div', 'by-suggestion');
        var item: Item = {
            el: el,
            icon: icon('search', 'by-suggestion-icon'),
            picture: h('img', 'by-suggestion-picture') as HTMLImageElement,
            typed: h('span', 'by-suggestion-typed'),
            rest: h('span', 'by-suggestion-rest'),
            line: h('span', 'by-suggestion-line')
        };
        el.appendChild(item.icon);
        el.appendChild(item.picture);
        el.appendChild(item.typed);
        el.appendChild(item.rest);
        el.appendChild(item.line);
        setShown(el, false);
        this.list.appendChild(el);
        return item;
    }

    /** Replaces the shown suggestions with list (rows are reused; only their parts are rewritten) */
    private showSuggestions(list: Suggestion[]): void {
        var typed = this.keyboard.text.trim().toLowerCase();
        this.suggested = list;
        for (var i = 0; i < this.items.length; i++) {
            var s = list[i];
            var item = this.items[i];
            setShown(item.el, !!s);
            if (!s) {
                continue;
            }
            // A person's or thing's picture, else the search icon (a clock for recent searches)
            setShown(item.picture, !!s.image);
            setShown(item.icon, !s.image);
            if (s.image && item.picture.getAttribute('src') !== s.image) {
                item.picture.src = s.image;
            }
            setIcon(item.icon, typed ? 'search' : 'history');
            // As YouTube: the typed part plain, the rest bold
            var shown = s.name || s.text;
            var cut = typed && shown.toLowerCase().indexOf(typed) === 0 ? typed.length : 0;
            setText(item.typed, shown.slice(0, cut));
            setText(item.rest, shown.slice(cut));
            setText(item.line, s.line || '');
        }
        this.pick = Math.min(this.pick, Math.max(0, list.length - 1));
        if (this.at === 'list' && !list.length) {
            this.at = 'keys';
        }
        this.mark();
    }

    /** Prefetches the results of the suggestion (or Search) the focus rests on */
    private restSoon(): void {
        clearTimeout(this.restTimer);
        var self = this;
        this.restTimer = setTimeout(function () {
            var term = (self.at === 'list' ? (self.suggested[self.pick] || { text: '' }).text :
                self.at === 'keys' && self.keyboard.focusedLabel === ENTER ? self.keyboard.text : '').trim();
            if (term && term !== self.searched) {
                self.ahead(term);
            }
        }, REST_MS) as unknown as number;
    }

    private renderQuery(): void {
        var text = this.keyboard.text;
        setText(this.query, text || 'Search');
        setClass(this.query, text ? 'bd-search-query' : 'bd-search-query bd-search-query--empty');
    }

    private mark(): void {
        var f = this.focused;
        this.keyboard.setFocused(f && this.at === 'keys');
        this.stack.setFocused(f && this.at === 'rows');
        toggleClass(this.back, 'by-search-back--focused', f && this.at === 'back');
        for (var i = 0; i < this.items.length; i++) {
            toggleClass(this.items[i].el, 'by-suggestion--focused', f && this.at === 'list' && i === this.pick);
        }
        this.place();
    }

    /** In the results the keyboard scrolls away under the field and the focused row lands under it */
    private place(): void {
        var inRows = this.at === 'rows';
        // (Else the keyboard's last line shows between the field and the rows)
        toggleClass(this.content, 'by-search--rows', inRows);
        if (!inRows) {
            translate(this.content, 0, 0);
            return;
        }
        if (!this.rowsTop) {
            this.rowsTop = this.stack.el.offsetTop;
        }
        translate(this.content, 0, metrics().searchRowsTop - this.rowsTop - this.stack.top);
    }
}
