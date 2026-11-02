// The accounts signed in on the TV, as YouTube's TV app lists them in "Who's watching?". YouTube's TV app keeps
// them in youtube.com's storage, which this app shares (api/youtube.ts identities): Google accounts and the brand
// accounts it has a sign-in for. Each Google account is asked (account/accounts_list with YouTube's read mask)
// for its name, picture and handle and those of its brand accounts (each with its pageIdToken), which are listed
// too, so a brand account stays reachable while its Google account is signed in. These are cached per account
// (localStorage bolli.v1.youtube.accounts; no credentials) for instant display and refreshed at most every few
// minutes. Signing out removes a Google account with its brand accounts, as on YouTube; YouTube AdFree shares
// the storage, so it is signed out there too.

import { load, save } from '../../core/store.js';
import { all, Page, picture, text } from './feed.js';
import { accountKey, brandIdentity, forgetAccount, identities, Identity, identityKey, innertube, innertubeAs, isBrand } from './youtube.js';

export interface Profile {
    key: string;
    identity: Identity;
    /** As YouTube shows it ('' not known yet) */
    name: string;
    picture: string;
    /** "@handle" ('' none: a channel without a handle, or not known yet) */
    handle: string;
    current: boolean;
}

/** An account listed in an accounts_list reply: its id, its brand id ('' the Google account itself), and whether it
 * is the account the request was made as */
export interface Named {
    id: string;
    brand: string;
    name: string;
    picture: string;
    handle: string;
    selected: boolean;
}

var KEY = 'youtube.accounts';
/** Picture size: as in "Who's watching?" on the TV's 1.5x-scaled screen */
var PICTURE_PX = 300;
/** The Google accounts are refreshed at most this often */
var ASK_AGAIN_MS = 5 * 60000;
/** The read mask YouTube's TV app sends to accounts_list (includes the Google account's brand accounts) */
export var READ_MASK = { returnOwner: true, returnBrandAccounts: true, returnPersonaAccounts: true, returnFamilyChildAccounts: true, returnFamilyMembersAccounts: false };
/** Cached name, picture and handle of each account, by key */
var known: { [key: string]: { name: string; picture: string; handle: string } } | null = null;
/** The last refresh of the Google accounts, and when it began */
var asked: Promise<void> | null = null;
var askedAt = 0;

function seen(): { [key: string]: { name: string; picture: string; handle: string } } {
    if (!known) {
        var kept = load<{ [key: string]: { name: string; picture: string; handle: string } }>(KEY);
        known = kept && typeof kept === 'object' ? kept : {};
    }
    return known;
}

/** The accounts on the TV with their cached details (including cached brand accounts of its Google accounts): the
 * current one first, then by last use */
export function keptProfiles(): Promise<Profile[]> {
    return identities().then(function (got) {
        var names = seen();
        var now = got.current ? identityKey(got.current) : '';
        var list = got.list.slice();
        var have: { [key: string]: boolean } = {};
        list.forEach(function (i) { have[identityKey(i)] = true; });
        for (var key in names) {
            var ids = key.split('||');
            var google = list.filter(function (i) { return !isBrand(i) && i.ownerObfuscatedGaiaId === ids[1]; })[0];
            if (google && ids[0] !== ids[1] && !have[key]) {
                have[key] = true;
                list.push(brandIdentity(google, ids[0]));
            }
        }
        return list.map(function (i) {
            var k = identityKey(i);
            var s = names[k] || { name: '', picture: '', handle: '' };
            return { key: k, identity: i, name: s.name, picture: s.picture, handle: s.handle, current: k === now };
        }).sort(function (a, b) {
            return (b.current ? 1 : 0) - (a.current ? 1 : 0) || (got.used[b.identity.effectiveObfuscatedGaiaId] || 0) - (got.used[a.identity.effectiveObfuscatedGaiaId] || 0);
        });
    });
}

/** The accounts on the TV, each Google account refreshed (at most every ASK_AGAIN_MS; on failure the cached
 * details stay) */
export function profiles(): Promise<Profile[]> {
    if (!asked || Date.now() - askedAt >= ASK_AGAIN_MS) {
        askedAt = Date.now();
        var mine = asked = keptProfiles().then(function (list) {
            return Promise.all(list.filter(function (p) { return !isBrand(p.identity); }).map(function (g) {
                return innertubeAs(g.identity, 'account/accounts_list', { accountReadMask: READ_MASK }).then(function (reply) {
                    noteAccounts(g.identity.ownerObfuscatedGaiaId, accountsOf(reply));
                }, function () { return undefined; });
            })).then(function () { return undefined; });
        });
        mine.then(null, function () {
            if (asked === mine) {
                asked = null;
            }
        });
    }
    return asked.then(keptProfiles);
}

/** Caches what a Google account's accounts_list returned: the account and its brand accounts (others without a brand
 * id belong to a family, not this sign-in); brand accounts no longer listed are dropped */
export function noteAccounts(google: string, named: Named[]): void {
    var names = seen();
    for (var key in names) {
        var ids = key.split('||');
        if (ids[1] === google && ids[0] !== google && !named.some(function (a) { return a.brand === ids[0]; })) {
            delete names[key];
        }
    }
    named.forEach(function (a) {
        if (a.brand || a.selected) {
            names[accountKey(a.brand || google, google)] = { name: a.name, picture: a.picture, handle: a.handle };
        }
    });
    save(KEY, names);
}

/** The accounts in an accounts_list reply (disabled ones skipped) */
export function accountsOf(reply: unknown): Named[] {
    return all(reply, 'accountItem').filter(function (a: any) { return !a.isDisabled; }).map(function (a: any) {
        var state = tokenOf(a, 'accountStateToken');
        var page = tokenOf(a, 'pageIdToken');
        return {
            id: state && state.obfuscatedGaiaId ? String(state.obfuscatedGaiaId) : '', brand: page && page.pageId ? String(page.pageId) : '',
            name: text(a.accountName), picture: picture(a.accountPhoto, PICTURE_PX), handle: text(a.channelHandle), selected: !!a.isSelected
        };
    });
}

/** One of an account item's switch-command tokens (pageIdToken, accountStateToken …) */
function tokenOf(item: any, kind: string): any {
    var tokens = item && item.serviceEndpoint && item.serviceEndpoint.selectActiveIdentityEndpoint &&
        item.serviceEndpoint.selectActiveIdentityEndpoint.supportedTokens || [];
    for (var i = 0; i < tokens.length; i++) {
        if (tokens[i] && tokens[i][kind]) {
            return tokens[i][kind];
        }
    }
    return null;
}

/** The Google account of an account (itself, or the one running a brand account), as listed */
export function googleOf(p: Profile, list: Profile[]): Profile {
    var owner = p.identity.ownerObfuscatedGaiaId;
    return list.filter(function (q) { return q.key === accountKey(owner, owner); })[0] || p;
}

/** Signs a Google account out on the TV with its brand accounts and drops their cached details */
export function signOut(google: Profile): Promise<void> {
    var owner = google.identity.ownerObfuscatedGaiaId;
    return forgetAccount(owner).then(function () {
        var names = seen();
        for (var key in names) {
            if (key.split('||')[1] === owner) {
                delete names[key];
            }
        }
        save(KEY, names);
    });
}

/** The account's own channel (its handle's page; null: none) */
export function ownChannel(p: Profile): Promise<Page | null> {
    if (!p.handle) {
        return Promise.resolve(null);
    }
    return innertube('navigation/resolve_url', { url: 'https://www.youtube.com/' + p.handle }).then(function (reply: any) {
        var id = reply && reply.endpoint && reply.endpoint.browseEndpoint && reply.endpoint.browseEndpoint.browseId;
        return id ? { browseId: id } : null;
    });
}
