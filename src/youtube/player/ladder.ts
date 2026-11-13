// The player's fallback ladder: what a failed engine leads to (nextStep), from what the start has tried so far (Tries)
// and what the failure is of (cause): new URLs (in place first) for expired ones, a reload for a playback that keeps
// stalling, another codec where a decoder or format failed, then the other way of getting the streams, and only then
// YouTube's player. That takes over only where the TV is online and YouTube refuses this player, or the format does
// not play here: never for the connection. A failure of the TV's line keeps the video, started anew where it was
// again and again (retryWait); so does YouTube failing on a line that answers, until that has lasted
// YOUTUBE_GIVE_UP_MS (it then counts as a refusal).

/** A start's ways tried after its engine failed: when its streams were last fetched anew (expired URLs, a playback that
 * keeps stalling; 0: not yet; again only own-player.ts's RENEW_AGAIN_MS later, or after the line was lost: renewal),
 * when new URLs in place were tried since it (0: not since), how many tries a lost line alone bought and when one last
 * did (0: never), how many tries anew it has had since its picture last played on a good while (retryWait; the player
 * counts anew then) and since when YouTube alone has been failing it on a line that answers (noted; 0: it is not),
 * whether new URLs are on the way, whether the streams were fetched the other way (SABR or guest), and the codecs
 * tried by the method playing */
export interface Tries {
    renewedAt: number;
    inPlaceAt: number;
    lostRenewals: number;
    lostTriedAt: number;
    retries: number;
    youtubeAt: number;
    renewing: boolean;
    switched: boolean;
    kinds: { [kind: string]: boolean };
}

export function noTries(): Tries {
    return { renewedAt: 0, inPlaceAt: 0, lostRenewals: 0, lostTriedAt: 0, retries: 0, youtubeAt: 0, renewing: false, switched: false, kinds: {} };
}

/** Tries a start may take for a lost line alone (within againMs of the last renewal): beyond them a line that keeps
 * dropping gets its tries anew (retryWait) */
export var LOST_RENEWALS = 3;

/** What a failure may do about its streams (renewal) */
export interface Renewal {
    /** New streams are due: againMs after the last renewal, or for a lost line (forLoss) */
    due: boolean;
    /** The line was lost since the last renewal, with a try for losses left, or this loss's try already taken and its
     * renewal not through yet */
    forLoss: boolean;
    /** New URLs in place may be tried (where the engine takes them): not tried since the last renewal, or the line was
     * lost since the last try, with one left */
    inPlace: boolean;
    /** A try taken now is one a lost line alone buys (took counts it) */
    lost: boolean;
}

/** What a start's failure at now may do about its streams: a renewal is due againMs after the last one, or when the
 * line was lost (lostAt; 0: never) since it. After a reconnect the TV may have another address its URLs are refused
 * for, so a renewal right after one is not given up on. Each loss buys one try, LOST_RENEWALS a start at most; a try
 * in place that did not get through goes on to a renewal for the same loss. */
export function renewal(t: Tries, now: number, lostAt: number, againMs: number): Renewal {
    var timely = now - t.renewedAt > againMs;
    // (a loss no try was taken for yet)
    var fresh = lostAt > t.lostTriedAt;
    var left = t.lostRenewals < LOST_RENEWALS;
    var forLoss = lostAt > t.renewedAt && (left || !fresh);
    return { due: timely || forLoss, forLoss: forLoss, inPlace: !t.inPlaceAt || fresh && left, lost: fresh && left && (!timely || !!t.inPlaceAt) };
}

/** A step taken at now: a renewal (in place or not) is the try the line's last loss gets, counted when the loss alone
 * bought it (r.lost); new URLs in place are noted as tried, a renewal as made, a try anew as one more */
export function took(t: Tries, step: Step, r: Renewal, now: number): void {
    if (step === 'retry') {
        t.retries++;
    }
    if (step !== 'renewInPlace' && step !== 'renew') {
        return;
    }
    if (r.lost) {
        t.lostRenewals++;
    }
    t.lostTriedAt = now;
    if (step === 'renewInPlace') {
        t.inPlaceAt = now;
    } else {
        t.renewedAt = now;
    }
}

/** What stops a video: the TV's line (its requests get no answer, or it was just lost), YouTube (the line answers, but
 * YouTube's answers are errors or do not come), or the video itself in this player (its format, the decoder, YouTube
 * refusing it to this player) */
export type Cause = 'line' | 'youtube' | 'cannot play';

/** The TV's line as a failure finds it (lineAt) */
export interface Line {
    /** Down: lost with nothing answered since, or the TV says it is offline */
    down: boolean;
    /** Lost within JUST_LOST_MS: it may be back at another address, or dropping again */
    justLost: boolean;
    /** Whether it answers: true (a request or the probe was answered within ANSWERED_MS, since the last loss), false
     * (the probe just got no answer), null: not known */
    answers: boolean | null;
}

export var JUST_LOST_MS = 60000;
export var ANSWERED_MS = 10000;

/** The line at now: down or not (networks.ts lineDown, or the TV offline), when it was last lost and when something
 * last answered (ms; 0: never), and whether the probe just got no answer (silent) */
export function lineAt(now: number, down: boolean, lostAt: number, answeredAt: number, silent: boolean): Line {
    var answered = !down && answeredAt > 0 && answeredAt >= lostAt && now - answeredAt <= ANSWERED_MS;
    return { down: down, justLost: lostAt > 0 && now - lostAt <= JUST_LOST_MS, answers: answered ? true : silent ? false : null };
}

/** Failures that come without an answer, or tell nothing of who failed: requests that fail or hang ('network'), a
 * start nothing or too little came for, a playback that keeps stalling with nothing buffered ahead, a streams request
 * without an answer */
var UNANSWERED = ['network', 'nothing came', 'stalled', 'no answer'];
/** Failures that are YouTube's answer and its refusal of this player where the line holds: a video's URLs answered
 * with HTTP 403 ('expired': new ones, the other method, then YouTube's player), a streams request so ('refused') */
var REFUSED = ['expired', 'refused'];
/** Failures that are YouTube's answer and its own trouble: a streams request answered with another HTTP error; and
 * SABR's server answering with an error or with nothing new (ofSabr) */
var ANSWERED = ['http'];

function ofSabr(why: string): boolean {
    return why.indexOf('sabr') === 0;
}

/** What a failure (why: an engine's, or one of the above) is of, on the line as it is. Of those the connection may be
 * behind: the line's where it is down, was just lost, or the probe got no answer; else YouTube's refusal of this
 * player for an HTTP 403 (the video's in this player), YouTube's trouble for its other answers and where the line is
 * seen to answer; one without an answer on a line nothing is known of counts as the line's (unsure: a probe tells).
 * Any other failure (the decoder, a format, a picture frozen with media buffered, a refusal) is the video's in this
 * player */
export function cause(why: string, line: Line): Cause {
    var refused = REFUSED.indexOf(why) >= 0;
    var answered = refused || ANSWERED.indexOf(why) >= 0 || ofSabr(why);
    if (!answered && UNANSWERED.indexOf(why) < 0) {
        return 'cannot play';
    }
    if (line.down || line.justLost || line.answers === false) {
        return 'line';
    }
    if (refused) {
        return 'cannot play';
    }
    return answered || line.answers ? 'youtube' : 'line';
}

/** Whether only a probe tells what a failure is of: one without an answer, on a line neither down, just lost nor seen
 * to answer */
export function unsure(why: string, line: Line): boolean {
    return UNANSWERED.indexOf(why) >= 0 && !line.down && !line.justLost && line.answers === null;
}

/** YouTube failing a video on a line that answers (server errors, SABR's empty answers, requests that hang) for this
 * long without the picture playing on, and the other method tried: it counts as YouTube refusing this player (one
 * hand-over, not tries without end) */
export var YOUTUBE_GIVE_UP_MS = 120000;

/** A failure known to be of's (not one a probe has yet to tell), noted at now: YouTube's begins the time YouTube alone
 * has been failing the video, or leaves it running; the line's ends it */
export function noted(t: Tries, of: Cause, now: number): void {
    if (of === 'youtube') {
        t.youtubeAt = t.youtubeAt || now;
    } else if (of === 'line') {
        t.youtubeAt = 0;
    }
}

/** A video stopped by the line or by YouTube's trouble starts anew this long after its failure (ms): the first try,
 * the second, then each further one; from the RETRY_SLOW-th on RETRY_SLOW_MS apart (each asks YouTube for the streams:
 * not at full pace for hours). The line answering again brings the next try at once (own-player.ts) */
export var RETRY_MS = [3000, 5000, 10000];
export var RETRY_SLOW = 10;
export var RETRY_SLOW_MS = 30000;

/** How long the try anew after tries of them waits (ms) */
export function retryWait(tries: number): number {
    return tries >= RETRY_SLOW ? RETRY_SLOW_MS : RETRY_MS[Math.max(0, Math.min(tries, RETRY_MS.length - 1))];
}

/** A failed engine's next step: wait (the other track expired too, new URLs on the way), new URLs in place, another
 * codec, new URLs or the other method from the same position, a try anew after a wait (retryWait), or YouTube's
 * player */
export type Step = 'wait' | 'renewInPlace' | 'codec' | 'renew' | 'switch' | 'retry' | 'fallback';

/** The player when its engine fails, for nextStep */
export interface Failing {
    /** New URLs are on the way */
    renewing: boolean;
    /** New streams are due (renewal: the last was more than RENEW_AGAIN_MS ago, none in this playback, or the line was
     * lost since) */
    renewDue: boolean;
    /** New streams are due for a lost line (renewal's forLoss): the network giving no answer renews then too */
    lostDue: boolean;
    /** The engine takes new URLs in place (not SABR), not tried since the last renewal or the line was lost since
     * (renewal) */
    inPlace: boolean;
    /** A codec neither playing nor tried yet for this video is playable */
    codec: boolean;
    /** The other method (SABR or not) is not tried yet for this video and the streams allow it */
    switchable: boolean;
    /** A video with streams (else a try anew, or for a video that cannot be played only YouTube's player, is left) */
    playing: boolean;
    /** The line as the failure finds it */
    line: Line;
    /** A try anew was made since the picture last played on a good while (Tries.retries) */
    retried: boolean;
    /** How long YouTube alone has been failing the video on a line that answers (ms, this failure noted; 0: it is
     * not: Tries.youtubeAt) */
    youtubeFor: number;
}

/** The fallback ladder for a failure (why): expired URLs are renewed in place, once, else from the same position via
 * the method that played, as is a playback that keeps stalling ('stalled': new streams, a new engine) and a picture
 * frozen with media buffered ('frozen'), again only RENEW_AGAIN_MS after the last or after a lost line (renewal); the
 * network giving no answer after a lost line is renewed the same way (the other method has no line either; the new
 * start waits for it).
 * A failure of the video's in this player (cause: the decoder, a format, a frozen picture, YouTube's refusal, its
 * HTTP 403 on a line that holds) tries another codec of the same streams (not for a 403: no codec helps), then the
 * other method, once; YouTube's player after all.
 * A failure of the line's is tried anew by the method that played ('retry'), without end.
 * YouTube's trouble on a line that answers is tried anew too: SABR's server failing after another codec (it may be
 * the format's) and the other method, any other after one try anew and then the other method, once. Lasting
 * YOUTUBE_GIVE_UP_MS with the other method tried, it ends as a refusal: YouTube's player */
export function nextStep(why: string, f: Failing): Step {
    var expired = why === 'expired';
    if (expired && f.renewing) {
        return 'wait';
    }
    var of = cause(why, f.line);
    // (nothing known of the line right now, but YouTube alone has been failing: the probe found the line to answer,
    // and no loss since)
    if (f.youtubeFor > 0 && unsure(why, f.line)) {
        of = 'youtube';
    }
    if (!f.playing) {
        return of === 'cannot play' ? 'fallback' : 'retry';
    }
    var renew = (expired || why === 'stalled' || why === 'frozen') && f.renewDue || why === 'network' && f.lostDue;
    if (renew) {
        return expired && f.inPlace ? 'renewInPlace' : 'renew';
    }
    if (of === 'cannot play') {
        return REFUSED.indexOf(why) < 0 && f.codec ? 'codec' : f.switchable ? 'switch' : 'fallback';
    }
    if (of === 'line') {
        return 'retry';
    }
    var server = ofSabr(why);
    if (server && f.codec) {
        return 'codec';
    }
    var over = f.youtubeFor >= YOUTUBE_GIVE_UP_MS;
    if (f.switchable && (server || f.retried || over)) {
        return 'switch';
    }
    return over ? 'fallback' : 'retry';
}
