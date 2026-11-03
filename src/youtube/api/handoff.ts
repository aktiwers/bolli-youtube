// YouTube's hand-off from the TV to a phone, as its TV app does it: while a
// video's comments show, YouTube is told that this screen offers them
// (/mdx/handoff, a comments action for the video, naming the screen by its
// Lounge ids), so the YouTube app on a phone signed in to the same account
// offers the comment box for that video; withdrawn when the comments close.

import { get } from './feed.js';
import { innertube } from './youtube.js';

var COMMENTS = 'HANDOFF_FEATURE_TYPE_LR_COMMENTS';

/** Offers commenting on videoId from the phone; resolves with the offer's id ('' none given) */
export function offerComments(videoId: string, screenId: string, deviceId: string, brand: string): Promise<string> {
    return innertube('mdx/handoff', { handoffParams: offerParams(videoId, screenId, deviceId, brand) }).then(function (reply) {
        return get(reply, 'actionStatePair', 'actionLookupKey', 'actionId') || '';
    });
}

/** Withdraws an offer (its id) */
export function withdrawComments(actionId: string): Promise<unknown> {
    return innertube('mdx/handoff', { handoffParams: { actionId: actionId, callType: 'HANDOFF_CALL_TYPE_MARK_ACTION_STATE', actionType: COMMENTS,
        actionState: 'HANDOFF_ACTION_STATE_CANCELED' } });
}

/** The offer as YouTube's TV app sends it */
export function offerParams(videoId: string, screenId: string, deviceId: string, brand: string): { [key: string]: unknown } {
    return {
        callType: 'HANDOFF_CALL_TYPE_INITIATE_ACTION',
        actionType: COMMENTS,
        featureData: { lrCommentsData: {
            lrDevice: { discoveryDeviceId: deviceId, screenId: screenId, deviceBrand: brand },
            lrDeviceState: { isPauseCommentsEnabled: false, canCreateComments: true },
            videoId: videoId
        } }
    };
}
