// A live stream's chat as YouTube's TV app reads it: /next names it (WatchInfo.chat), and live_chat/get_live_chat
// gives the messages since the last answer, the token for the next ones and how long YouTube wants the app to wait
// first (at least ASK_MIN_MS here: requests stay few, and each costs the TV a round of garbage collection when webOS
// reports low memory, as it does every 5 s while a video plays). Messages are the chat's text messages and Super Chats
// (with their amount), without the authors' pictures (a request each); emoji come as pictures, as YouTube's custom
// ones have no character. A failed request is noted (api/failures.ts).

import { HttpError } from '../../core/http.js';
import { noteFailed } from './failures.js';
import { get, picture, text } from './feed.js';
import { innertube } from './youtube.js';

/** Messages are asked for again no sooner than this (ms) */
var ASK_MIN_MS = 8000;
/** An emoji's picture: the smallest this wide (px) */
var EMOJI_PX = 24;

/** A message: its author, its parts (text, or an emoji: its picture, and its name as the text), and a Super Chat's
 * amount ('' none) */
export interface ChatMessage {
    id: string;
    author: string;
    parts: { text: string; emoji: string }[];
    amount: string;
}

export interface ChatAnswer {
    messages: ChatMessage[];
    /** The token for the next messages ('' none: the chat ended) and how long to wait before asking (ms) */
    next: string;
    waitMs: number;
}

/** The messages after token */
export function liveChat(token: string): Promise<ChatAnswer> {
    return innertube('live_chat/get_live_chat', { continuation: token }).then(chatOf, function (e: HttpError) {
        noteFailed('liveChat', e);
        throw e;
    });
}

/** The messages and the next token in a get_live_chat reply */
export function chatOf(reply: any): ChatAnswer {
    var chat = get(reply, 'continuationContents', 'liveChatContinuation') || {};
    var c = get(chat, 'continuations', 0) || {};
    var next = c.timedContinuationData || c.invalidationContinuationData || c.reloadContinuationData || {};
    var messages: ChatMessage[] = [];
    (chat.actions || []).forEach(function (a: any) {
        var item = get(a, 'addChatItemAction', 'item') || {};
        var m = item.liveChatTextMessageRenderer || item.liveChatPaidMessageRenderer;
        if (m && m.id) {
            messages.push({ id: m.id, author: text(m.authorName), parts: partsOf(m.message), amount: text(m.purchaseAmountText) });
        }
    });
    return { messages: messages, next: next.continuation || '', waitMs: Math.max(ASK_MIN_MS, +next.timeoutMs || 0) };
}

/** A message's text and emoji in order */
function partsOf(message: any): { text: string; emoji: string }[] {
    return ((message && message.runs) || []).map(function (run: any) {
        var e = run.emoji;
        return e ? { text: (e.shortcuts && e.shortcuts[0]) || e.emojiId || '', emoji: picture(e.image, 0, EMOJI_PX) } :
            { text: run.text || '', emoji: '' };
    });
}
