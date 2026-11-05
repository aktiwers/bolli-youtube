// A live stream's chat beside the picture, as YouTube's TV app shows it: the latest messages at the right, the newest
// at the bottom (KEPT of them; older ones go), Super Chats with their amount. Asked for while it shows (api/live-chat.ts:
// as often as YouTube says, no more often than every 8 s), an answer's new messages shown one by one until the next is
// due; not while held (the watch page covers it, the video is paused); after failures, or an answer without a next
// token, less and less often. The player stops it when the video closes or the app hides.

import { h, toggleClass } from '../../core/dom.js';
import { ChatMessage, liveChat } from '../api/live-chat.js';

/** Messages kept on screen */
var KEPT = 30;
/** After a failure, asked again this long later, doubled per failure in a row up to FAILED_MAX_MS */
var FAILED_MS = 10000;
var FAILED_MAX_MS = 5 * 60000;

export class ChatView {
    private list: HTMLElement;
    /** The token for the next messages ('' stopped) */
    private token = '';
    private timer = 0;
    /** Incremented per start, stop and hold, so a late answer is dropped */
    private gen = 0;
    /** Failures in a row; when the next ask is due; held (covered or paused) */
    private failures = 0;
    private dueAt = 0;
    private held = false;
    /** The ids of the messages shown, in order (an answer can repeat one) */
    private ids: string[] = [];
    /** The last answer's messages not shown yet, and the timer showing the next */
    private queue: ChatMessage[] = [];
    private showTimer = 0;

    /** In the player's element, shown while it is marked by-player--chat (the subtitles make room) */
    constructor(private player: HTMLElement) {
        var el = player.appendChild(h('div', 'by-chat')) as HTMLElement;
        this.list = el.appendChild(h('div', 'by-chat-list')) as HTMLElement;
    }

    /** Shows the chat from token, its first messages (not if it shows already) */
    start(token: string): void {
        if (this.token || !token) {
            return;
        }
        this.token = token;
        toggleClass(this.player, 'by-player--chat', true);
        this.ask();
    }

    /** Stops asking and empties it */
    stop(): void {
        this.pause();
        clearTimeout(this.showTimer);
        this.queue = [];
        this.token = '';
        this.failures = 0;
        this.ids = [];
        this.list.innerHTML = '';
        toggleClass(this.player, 'by-player--chat', false);
    }

    /** Held (the watch page covers it, the video is paused): nothing asked meanwhile; released: asked when due */
    hold(held: boolean): void {
        if (held !== this.held) {
            this.held = held;
            this.pause();
            this.flush();
            if (!held && this.token) {
                this.again(this.dueAt - Date.now());
            }
        }
    }

    private pause(): void {
        clearTimeout(this.timer);
        this.gen++;
    }

    private ask(): void {
        if (this.held) {
            return;
        }
        var self = this;
        var gen = this.gen;
        var failed = function (): void {
            self.again(Math.min(FAILED_MAX_MS, FAILED_MS * Math.pow(2, self.failures++)));
        };
        liveChat(this.token).then(function (a) {
            if (gen !== self.gen) {
                return;
            }
            // (the first answer's, the chat so far, at once)
            self.add(a.messages, self.ids.length ? a.waitMs : 0);
            // No next token (an odd answer, or the chat ended): the same one again, less and less often
            if (!a.next) {
                failed();
                return;
            }
            self.failures = 0;
            self.token = a.next;
            self.again(a.waitMs);
        }, function () {
            if (gen === self.gen) {
                failed();
            }
        });
    }

    /** Asks in ms (at once if due already) */
    private again(ms: number): void {
        var self = this;
        this.dueAt = Date.now() + Math.max(0, ms);
        this.timer = setTimeout(function () { self.ask(); }, Math.max(0, ms)) as unknown as number;
    }

    /** Shows the messages not shown yet (only the last KEPT of them) one by one over spread ms (0: at once), the rest
     * of the last answer's at once first */
    private add(messages: ChatMessage[], spread: number): void {
        var self = this;
        var known = this.ids.concat(this.queue.map(function (m) { return m.id; }));
        this.flush();
        this.queue = messages.filter(function (m) { return known.indexOf(m.id) < 0; }).slice(-KEPT);
        var every = spread / Math.max(1, this.queue.length);
        var next = function (): void {
            self.showTimer = 0;
            self.show(self.queue.shift() as ChatMessage);
            if (self.queue.length) {
                self.showTimer = setTimeout(next, every) as unknown as number;
            }
        };
        if (!spread) {
            this.flush();
        } else if (this.queue.length) {
            next();
        }
    }

    /** Shows the messages waiting at once */
    private flush(): void {
        clearTimeout(this.showTimer);
        this.showTimer = 0;
        while (this.queue.length) {
            this.show(this.queue.shift() as ChatMessage);
        }
    }

    /** A message's line at the bottom, keeping the last KEPT */
    private show(m: ChatMessage): void {
        this.ids.push(m.id);
        this.list.appendChild(lineOf(m));
        if (this.ids.length > KEPT) {
            this.ids.shift();
            this.list.removeChild(this.list.firstChild as Node);
        }
    }
}

/** A message's line: its author, a Super Chat's amount, then its text and emoji (an emoji without a picture by name) */
function lineOf(m: ChatMessage): HTMLElement {
    var line = h('div', 'by-chat-line' + (m.amount ? ' by-chat-line--paid' : ''));
    line.appendChild(h('span', 'by-chat-author', m.author));
    if (m.amount) {
        line.appendChild(h('span', 'by-chat-amount', m.amount));
    }
    m.parts.forEach(function (p) {
        if (p.emoji) {
            var img = line.appendChild(h('img', 'by-chat-emoji')) as HTMLImageElement;
            img.alt = p.text;
            img.src = p.emoji;
        } else {
            line.appendChild(document.createTextNode(p.text));
        }
    });
    return line;
}
