// Google account sign-in as YouTube's TV app does it (OAuth device flow with
// YouTube's TV client). It requests a code (o/oauth2/device/code with the TV
// app's scopes, a device id and model), the user enters it at yt.be/activate,
// and the TV polls o/oauth2/token until it is accepted. The account is then
// named via accounts_list (its id and brand accounts: api/accounts.ts) and
// stored where YouTube's TV app keeps its accounts (api/youtube.ts
// addIdentity), so YouTube AdFree has it too.

import { load, save } from '../../core/store.js';
import { accountsOf, noteAccounts, READ_MASK } from './accounts.js';
import { addIdentity, googleIdentity, Identity, innertubeToken, oauth, uuid } from './youtube.js';

/** A sign-in code: the code shown, Google's device code for polling, the poll interval (ms) and expiry time */
export interface DeviceCode {
    user: string;
    device: string;
    every: number;
    ends: number;
}

/** Tokens from a completed sign-in */
export interface Tokens {
    access: string;
    refresh: string;
    /** ms */
    life: number;
}

/** The scopes YouTube's TV app signs in with */
export var SCOPES = ['http://gdata.youtube.com', 'https://www.googleapis.com/auth/youtube-paid-content'];
/** Where the code is entered, as YouTube's screen names it */
export var ACTIVATE = 'yt.be/activate';
var DEVICE_KEY = 'youtube.deviceId';

/** This device's id for Google's sign-in (created once, then stored) */
function deviceId(): string {
    var id = load<string>(DEVICE_KEY);
    if (!id) {
        id = uuid();
        save(DEVICE_KEY, id);
    }
    return id;
}

/** Request a new sign-in code */
export function deviceCode(): Promise<DeviceCode> {
    return oauth('/o/oauth2/device/code', { scope: SCOPES.join(' '), device_id: deviceId(), device_model: 'ytlr::' }, false).then(function (r) {
        var code = deviceCodeOf(r.reply, Date.now());
        if (!code) {
            throw new Error('Google gave no code (' + r.status + ')');
        }
        return code;
    });
}

export function deviceCodeOf(reply: any, now: number): DeviceCode | null {
    return reply && reply.user_code && reply.device_code ? {
        user: String(reply.user_code), device: String(reply.device_code),
        every: Math.max(5, +reply.interval || 5) * 1000, ends: now + (+reply.expires_in || 1800) * 1000
    } : null;
}

/** Poll the code: the tokens once entered; 'waiting': not yet (or no clear answer); 'slower': not yet, poll less
 * often; null: never (expired or refused) */
export function signedIn(code: DeviceCode): Promise<Tokens | 'waiting' | 'slower' | null> {
    return oauth('/o/oauth2/token', { code: code.device, grant_type: 'http://oauth.net/grant_type/device/1.0' }, true).then(function (r) {
        return tokensOf(r.reply);
    });
}

export function tokensOf(reply: any): Tokens | 'waiting' | 'slower' | null {
    if (reply && reply.access_token && reply.refresh_token) {
        return { access: reply.access_token, refresh: reply.refresh_token, life: (+reply.expires_in || 3600) * 1000 };
    }
    var error = reply && reply.error;
    // Only these end the flow; other errors are polled again, as the code may still be valid
    return error === 'access_denied' || error === 'expired_token' || error === 'invalid_grant' ? null : error === 'slow_down' ? 'slower' : 'waiting';
}

/** Name the signed-in Google account (its non-brand entry) and store it, with its brand accounts */
export function keepAccount(tokens: Tokens): Promise<Identity> {
    return innertubeToken(tokens.access, 'account/accounts_list', { accountReadMask: READ_MASK }).then(function (reply) {
        var named = accountsOf(reply);
        var own = named.filter(function (a) { return !a.brand; });
        var it = own.filter(function (a) { return a.selected; })[0] || own[0];
        if (!it || !it.id) {
            throw new Error('YouTube did not name the account');
        }
        var identity = googleIdentity(it.id, { refreshToken: tokens.refresh, clientIdName: 0, scopes: SCOPES, lateDelegationEnabled: true });
        return addIdentity(identity, own.length, tokens.access, tokens.life).then(function () {
            noteAccounts(it.id, named);
            return identity;
        });
    });
}
