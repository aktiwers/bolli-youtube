// Side panel on the right of the watch and channel pages, where YouTube's TV app opens its
// lists (settings, description, comments, About): a title over a column of lines navigated with
// Up/Down (the list scrolls to keep the focused line in view; a list opens on its chosen line).
// A line is a choice (OK picks it; the chosen one has a checkmark; the panel closes unless the
// line stays, then the list is redrawn to show the change) or text to read. A list pushed over
// another returns to it on Back (or Left); otherwise Back closes the panel. Styled by
// themes/<id>.css (by-panel, by-line).

import { h, setShown, setText, toggleClass, translate } from '../../core/dom.js';
import { KEY } from '../../core/keys.js';
import { icon } from './icons.js';

/** The focused line is kept this far below the list's top (so the line above it shows) */
var ROOM = 120;

/** A line of the panel: a choice, or text to read */
export interface PanelLine {
    label: string;
    /** Small lines over and under it (a comment's author and its likes) */
    over?: string;
    under?: string;
    /** Body text, not a choice's weight */
    plain?: boolean;
    /** A choice: the one chosen has the checkmark */
    chosen?: boolean;
    action?: () => void;
    /** The panel stays open after the action (it opened another, or shows the change) */
    stay?: boolean;
}

/** A list in the panel: its title, a line builder (rerun when it changes or is returned to), its focus (-1: its
 * chosen line) */
interface List {
    title: string;
    lines: () => PanelLine[];
    focused: number;
    /** Called after Up/Down in it (comments load more near their end) */
    more?: () => void;
}

/** Lines of a text by paragraph (blank lines between them), as text to read */
export function paragraphs(text: string): PanelLine[] {
    var lines: PanelLine[] = [];
    text.split(/\n\s*\n/).forEach(function (part) {
        if (part.trim()) {
            lines.push({ label: part.trim(), plain: true });
        }
    });
    return lines;
}

export class SidePanel {
    shown = false;
    private el: HTMLElement;
    private title: HTMLElement;
    private list: HTMLElement;
    private lines: { line: PanelLine; el: HTMLElement }[] = [];
    private focused = 0;
    /** Open lists; the last one is shown */
    private stack: List[] = [];

    constructor(parent: HTMLElement) {
        this.el = h('div', 'by-panel');
        this.title = h('div', 'by-panel-title');
        var view = h('div', 'by-panel-view');
        this.list = h('div', 'by-panel-list');
        view.appendChild(this.list);
        this.el.appendChild(this.title);
        this.el.appendChild(view);
        setShown(this.el, false);
        parent.appendChild(this.el);
    }

    /** The focused line, and how many there are */
    get at(): number {
        return this.focused;
    }

    get count(): number {
        return this.lines.length;
    }

    /** Opens a list on its own (closing any open ones); focus: the focused line (none: its chosen one); more: called
     * after each move in it */
    open(title: string, lines: PanelLine[] | (() => PanelLine[]), focus?: number, more?: () => void): void {
        this.stack = [];
        this.push(title, lines, focus, more);
    }

    /** A list loaded from YouTube: "Loading <what>" until asked resolves, then lines(got), or a failure line; pushed
     * over the shown list (push), else opened on its own */
    openAsked<T>(title: string, asked: Promise<T>, lines: (got: T) => PanelLine[], what: string, push?: boolean): void {
        var got: T | null = null;
        var failed = false;
        var self = this;
        var made = function (): PanelLine[] {
            return got !== null ? lines(got) : [{ label: failed ? 'Could not load ' + what + '.' : 'Loading ' + what + ' …', plain: true }];
        };
        if (push) {
            this.push(title, made, 0);
        } else {
            this.open(title, made, 0);
        }
        asked.then(function (g) {
            got = g;
            self.refresh();
        }, function () {
            failed = true;
            self.refresh();
        });
    }

    /** Pushes a list over the shown one: Back returns to it, focus kept */
    push(title: string, lines: PanelLine[] | (() => PanelLine[]), focus?: number, more?: () => void): void {
        var top = this.stack[this.stack.length - 1];
        if (top) {
            top.focused = this.focused;
        }
        var made = typeof lines === 'function' ? lines : function () { return lines; };
        this.stack.push({ title: title, lines: made, focused: focus === undefined ? -1 : focus, more: more });
        this.draw();
    }

    /** Rebuilds the shown list (something in it changed), keeping the focus */
    refresh(): void {
        if (this.shown) {
            this.stack[this.stack.length - 1].focused = this.focused;
            this.draw();
        }
    }

    /** Appends lines at the end */
    add(lines: PanelLine[]): void {
        var self = this;
        lines.forEach(function (line) {
            var el = h('div', 'by-line' + (line.plain ? ' by-line--plain' : '') + (line.action ? ' by-line--choice' : ''));
            if (line.over) {
                el.appendChild(h('div', 'by-line-over', line.over));
            }
            el.appendChild(h('div', 'by-line-label', line.label));
            if (line.under) {
                el.appendChild(h('div', 'by-line-under', line.under));
            }
            if (line.chosen) {
                el.appendChild(icon('check', 'by-check'));
            }
            self.list.appendChild(el);
            self.lines.push({ line: line, el: el });
        });
    }

    close(): void {
        if (this.shown) {
            this.shown = false;
            this.stack = [];
            setShown(this.el, false);
        }
    }

    onKey(code: number): void {
        switch (code) {
            case KEY.UP:
            case KEY.DOWN:
                this.focus(this.focused + (code === KEY.UP ? -1 : 1));
                var top = this.stack[this.stack.length - 1];
                if (top.more) {
                    top.more();
                }
                break;
            case KEY.OK:
                var line = this.lines[this.focused] ? this.lines[this.focused].line : null;
                var depth = this.stack.length;
                if (line && line.action) {
                    line.action();
                    if (!line.stay) {
                        this.close();
                    } else if (this.stack.length === depth) {
                        // It changed something here (no other list opened): redraw
                        this.refresh();
                    }
                }
                break;
            case KEY.LEFT:
            case KEY.BACK:
                if (this.stack.length > 1) {
                    this.stack.pop();
                    this.draw();
                } else {
                    this.close();
                }
                break;
        }
    }

    /** Draws the top list: title, lines, focus (-1: the chosen line, else the first) */
    private draw(): void {
        var top = this.stack[this.stack.length - 1];
        var lines = top.lines();
        setText(this.title, top.title);
        this.list.innerHTML = '';
        this.lines = [];
        this.add(lines);
        this.shown = true;
        setShown(this.el, true);
        var at = top.focused;
        for (var i = 0; at < 0 && i < lines.length; i++) {
            if (lines[i].chosen) {
                at = i;
            }
        }
        this.focus(Math.max(0, at));
    }

    /** Focuses a line, scrolling the list to keep it in view */
    private focus(index: number): void {
        var to = Math.max(0, Math.min(this.lines.length - 1, index));
        if (this.lines[this.focused]) {
            toggleClass(this.lines[this.focused].el, 'by-line--focused', false);
        }
        this.focused = to;
        var line = this.lines[to];
        if (line) {
            toggleClass(line.el, 'by-line--focused', true);
            translate(this.list, 0, -Math.max(0, line.el.offsetTop - ROOM));
        }
    }
}
