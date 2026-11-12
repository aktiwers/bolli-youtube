// The player's fallback ladder: what a failed engine leads to (nextStep), from what the start has tried so far (Tries):
// new URLs (in place first) for expired ones, a reload for a playback that keeps stalling, another codec where a
// decoder or format failed, then the other way of getting the streams, and only then YouTube's player.

/** A start's ways tried after its engine failed: when its streams were last fetched anew (expired URLs, a playback that
 * keeps stalling; 0: not yet; again only own-player.ts's RENEW_AGAIN_MS later, or after the line was lost: renewal),
 * when new URLs in place were tried since it (0: not since), how many tries a lost line alone bought and when one last
 * did (0: never), whether new URLs are on the way, whether the streams were fetched the other way (SABR or guest), and
 * the codecs tried by the method playing */
export interface Tries {
    renewedAt: number;
    inPlaceAt: number;
    lostRenewals: number;
    lostTriedAt: number;
    renewing: boolean;
    switched: boolean;
    kinds: { [kind: string]: boolean };
}

export function noTries(): Tries {
    return { renewedAt: 0, inPlaceAt: 0, lostRenewals: 0, lostTriedAt: 0, renewing: false, switched: false, kinds: {} };
}

/** Tries a start may take for a lost line alone (within againMs of the last renewal), so a flapping line never loops */
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
 * bought it (r.lost); new URLs in place are noted as tried, a renewal as made */
export function took(t: Tries, step: Step, r: Renewal, now: number): void {
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

/** A failed engine's next step: wait (the other track expired too, new URLs on the way), new URLs in place, another
 * codec, new URLs or the other method from the same position, or YouTube's player */
export type Step = 'wait' | 'renewInPlace' | 'codec' | 'renew' | 'switch' | 'fallback';

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
    /** A video with streams (else only YouTube's player is left) */
    playing: boolean;
}

/** Failures no other codec helps with */
var NO_CODEC = ['expired', 'stalled', 'network', 'nothing came'];

/** The fallback ladder for a failure (why): expired URLs are renewed in place, once, else from the same position via
 * the method that played, as is a playback that keeps stalling ('stalled': new streams, a new engine), again only
 * RENEW_AGAIN_MS after the last or after a lost line (renewal); the network giving no answer after a lost line is
 * renewed the same way (the other method has no line either; the new start waits for it); a decoder or format failure
 * tries another codec of the same streams (not the network, expired URLs, stalls or nothing come at all: no codec
 * helps there); then the other method, once; YouTube's player after all */
export function nextStep(why: string, f: Failing): Step {
    var expired = why === 'expired';
    var stalled = why === 'stalled';
    if (expired && f.renewing) {
        return 'wait';
    }
    if (!f.playing) {
        return 'fallback';
    }
    var renew = (expired || stalled) && f.renewDue || why === 'network' && f.lostDue;
    if (renew && expired && f.inPlace) {
        return 'renewInPlace';
    }
    if (NO_CODEC.indexOf(why) < 0 && f.codec) {
        return 'codec';
    }
    return renew ? 'renew' : f.switchable ? 'switch' : 'fallback';
}
