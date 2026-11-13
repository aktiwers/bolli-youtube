// Tests on a TV (window.__bolli.fakeNet, debug.ts): the player's requests answered as a line that is down, or a YouTube
// that fails or refuses, would answer them. Nothing is replaced or wrapped: each request asks here as it is made, and
// is a real one unless a mode is set, so fakeNet('') is all it takes to have every request real again. A video's
// media requests (dash.ts, live-engine.ts, sabr-engine.ts: fakedRequest), its streams requests by both methods
// (api/streams.ts: fakedStreams) and the line's probe (player/networks.ts: fakedProbe) ask; the app's other requests
// (its screens, the sign-in) never do.

/** What is faked: '' nothing; 'offline': no request gets an answer; 'youtube': the line answers (the probe is asked
 * for real), media and streams requests with HTTP 503 (YouTube's trouble); '403': the same with HTTP 403 (YouTube
 * refusing this player); 'refuse': YouTube refuses the video's streams to this player, by both methods, as it does
 * for a video only its own player plays */
export type FakeMode = '' | 'offline' | 'youtube' | '403' | 'refuse';

var MODES = ['offline', 'youtube', '403', 'refuse'];
/** A faked request is answered this long after it is sent (ms), as one that fails fast is */
var FAKE_MS = 300;
var mode: FakeMode = '';

/** Sets what is faked from now on ('' or a mode not known: nothing); returns the mode set */
export function fakeNet(to?: string): FakeMode {
    mode = (MODES.indexOf(to || '') >= 0 ? to : '') as FakeMode;
    return mode;
}

export function fakedNet(): FakeMode {
    return mode;
}

/** A media request in place of a real one (null: none faked, the caller makes its own): it goes nowhere, and FAKE_MS
 * after it is sent gets no answer ('offline': its error) or HTTP 503 or 403 ('youtube', '403': its load), told to its
 * handlers and listeners as an XMLHttpRequest tells them; aborted before, its abort */
export function fakedRequest(): XMLHttpRequest | null {
    if (mode !== 'offline' && mode !== 'youtube' && mode !== '403') {
        return null;
    }
    var status = mode === 'youtube' ? 503 : mode === '403' ? 403 : 0;
    var heard: { [type: string]: ((e: unknown) => void)[] } = {};
    var timer = 0;
    var none = function (): void { return undefined; };
    var tell = function (type: string): void {
        var e = { type: type, target: xhr, loaded: 0, total: 0, lengthComputable: false };
        var own = xhr['on' + type];
        if (typeof own === 'function') {
            own.call(xhr, e);
        }
        (heard[type] || []).slice().forEach(function (f) { f.call(xhr, e); });
    };
    var xhr: any = {
        status: 0,
        readyState: 0,
        response: null,
        responseText: '',
        responseType: '',
        timeout: 0,
        open: function (): void { xhr.readyState = 1; },
        setRequestHeader: none,
        overrideMimeType: none,
        getResponseHeader: function (): null { return null; },
        addEventListener: function (type: string, f: (e: unknown) => void): void {
            (heard[type] = heard[type] || []).push(f);
        },
        removeEventListener: function (type: string, f: (e: unknown) => void): void {
            heard[type] = (heard[type] || []).filter(function (one) { return one !== f; });
        },
        send: function (): void {
            timer = setTimeout(function () {
                timer = 0;
                xhr.readyState = 4;
                xhr.status = status;
                tell(status ? 'load' : 'error');
                tell('loadend');
            }, FAKE_MS) as unknown as number;
        },
        abort: function (): void {
            if (timer) {
                clearTimeout(timer);
                timer = 0;
                xhr.readyState = 4;
                tell('abort');
                tell('loadend');
            }
        }
    };
    return xhr as XMLHttpRequest;
}

/** What a failure a moment from now rejects with */
function failing<T>(e: T): Promise<never> {
    return new Promise<never>(function (_ok, fail) {
        setTimeout(function () { fail(e); }, FAKE_MS);
    });
}

/** A video's streams request in place of a real one (null: none faked): rejected as api/streams.ts rejects one that
 * got no answer ('offline'), an HTTP 503 ('youtube') or 403 ('403'), or YouTube's refusal of the video to this player
 * ('refuse') */
export function fakedStreams(): Promise<never> | null {
    return mode === 'offline' ? failing({ status: 'HTTP', reason: 'network error' }) :
        mode === 'youtube' ? failing({ status: 'HTTP', reason: 'HTTP 503' }) :
        mode === '403' ? failing({ status: 'HTTP', reason: 'HTTP 403' }) :
        mode === 'refuse' ? failing({ status: 'UNPLAYABLE', reason: 'refused for a test' }) : null;
}

/** The line's probe in place of a real one (null: none faked, also where the line is faked to answer): rejected as
 * core/http.ts rejects a request that got no answer ('offline') */
export function fakedProbe(): Promise<never> | null {
    return mode === 'offline' ? failing({ status: 0, url: '', message: 'network error', body: '' }) : null;
}
