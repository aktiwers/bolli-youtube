// The player's fallback ladder: what a failed engine leads to (nextStep), from what the start has tried so far (Tries):
// new URLs (in place first) for expired ones, a reload for a playback that keeps stalling, another codec where a
// decoder or format failed, then the other way of getting the streams, and only then YouTube's player.

/** A start's ways tried after its engine failed: when its streams were last fetched anew (expired URLs, a playback that
 * keeps stalling; 0: not yet; again only own-player.ts's RENEW_AGAIN_MS later), whether new URLs in place were tried
 * since, whether new URLs are on the way, whether the streams were fetched the other way (SABR or guest), and the
 * codecs tried by the method playing */
export interface Tries {
    renewedAt: number;
    inPlaceTried: boolean;
    renewing: boolean;
    switched: boolean;
    kinds: { [kind: string]: boolean };
}

export function noTries(): Tries {
    return { renewedAt: 0, inPlaceTried: false, renewing: false, switched: false, kinds: {} };
}

/** A failed engine's next step: wait (the other track expired too, new URLs on the way), new URLs in place, another
 * codec, new URLs or the other method from the same position, or YouTube's player */
export type Step = 'wait' | 'renewInPlace' | 'codec' | 'renew' | 'switch' | 'fallback';

/** The player when its engine fails, for nextStep */
export interface Failing {
    /** New URLs are on the way */
    renewing: boolean;
    /** The last renewal was more than RENEW_AGAIN_MS ago (or none in this playback) */
    renewDue: boolean;
    /** The engine takes new URLs in place (not SABR), not tried since the last renewal */
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
 * RENEW_AGAIN_MS after the last; a decoder or format failure tries another codec of the same streams (not the
 * network, expired URLs, stalls or nothing come at all: no codec helps there); then the other method, once; YouTube's
 * player after all */
export function nextStep(why: string, f: Failing): Step {
    var expired = why === 'expired';
    var stalled = why === 'stalled';
    if (expired && f.renewing) {
        return 'wait';
    }
    if (!f.playing) {
        return 'fallback';
    }
    var renew = (expired || stalled) && f.renewDue;
    if (renew && expired && f.inPlace) {
        return 'renewInPlace';
    }
    if (NO_CODEC.indexOf(why) < 0 && f.codec) {
        return 'codec';
    }
    return renew ? 'renew' : f.switchable ? 'switch' : 'fallback';
}
