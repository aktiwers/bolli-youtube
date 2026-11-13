// Minimal JSON (and bytes: getBytes) over XMLHttpRequest (Chrome 38 has no fetch). Parsed with the
// browser's own JSON.parse: this app loads no polyfills.

export interface HttpError {
    status: number;
    url: string;
    message: string;
    /** The response text of an error reply (OAuth errors come as JSON) */
    body: string;
}

/** An empty body gives null (some APIs answer "nothing" that way) */
export function getJson<T>(url: string, timeoutMs?: number, headers?: { [name: string]: string }): Promise<T> {
    return send('GET', url, null, headers, timeoutMs).then(function (text) {
        return parse<T>(text, url);
    });
}

export function getText(url: string, timeoutMs?: number): Promise<string> {
    return send('GET', url, null, undefined, timeoutMs);
}

/** POST a form (application/x-www-form-urlencoded), JSON back */
export function postForm<T>(url: string, fields: { [name: string]: string }): Promise<T> {
    var parts: string[] = [];
    for (var name in fields) {
        parts.push(encodeURIComponent(name) + '=' + encodeURIComponent(fields[name]));
    }
    return send('POST', url, parts.join('&'), { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' })
        .then(function (text) { return parse<T>(text, url); });
}

/** POST JSON, JSON back. as: a name the request can be aborted by while it is on its way (abortSent) */
export function postJson<T>(url: string, body: unknown, headers?: { [name: string]: string }, as?: string): Promise<T> {
    var all: { [name: string]: string } = { 'Content-Type': 'application/json', Accept: 'application/json' };
    for (var name in headers) {
        all[name] = headers[name];
    }
    return send('POST', url, JSON.stringify(body), all, undefined, as).then(function (text) { return parse<T>(text, url); });
}

/** The requests on their way that were sent under a name */
var named: { as: string; xhr: XMLHttpRequest }[] = [];
/** What an aborted request (abortSent) rejects with: an HttpError of this message */
export var ABORTED = 'aborted';

/** Aborts the requests on their way that were sent as name (postJson): each rejects with an HttpError ABORTED */
export function abortSent(name: string): void {
    var mine = named.filter(function (n) { return n.as === name; });
    named = named.filter(function (n) { return n.as !== name; });
    for (var i = 0; i < mine.length; i++) {
        mine[i].xhr.abort();
    }
}

/** POST JSON, the reply as text (for reading a part of a big reply without parsing it all) */
export function postText(url: string, body: unknown, headers?: { [name: string]: string }): Promise<string> {
    var all: { [name: string]: string } = { 'Content-Type': 'application/json' };
    for (var name in headers) {
        all[name] = headers[name];
    }
    return send('POST', url, JSON.stringify(body), all);
}

/** PUT or DELETE without a body; the reply body is ignored */
export function sendRequest(method: string, url: string, headers?: { [name: string]: string }): Promise<void> {
    return send(method, url, null, headers).then(function () {
        return undefined;
    });
}

/** A GET's reply as bytes, at most maxBytes (more: dropped as soon as the download passes it, an HttpError 'too big') */
export function getBytes(url: string, timeoutMs: number, maxBytes: number): Promise<ArrayBuffer> {
    return new Promise<ArrayBuffer>(function (resolve, reject) {
        var xhr = new XMLHttpRequest();
        var tooBig = function () {
            reject({ status: 0, url: url, message: 'too big', body: '' } as HttpError);
        };
        xhr.open('GET', url, true);
        xhr.timeout = timeoutMs;
        xhr.responseType = 'arraybuffer';
        xhr.onprogress = function (e) {
            if (e.loaded > maxBytes || e.lengthComputable && e.total > maxBytes) {
                xhr.abort();
                tooBig();
            }
        };
        xhr.onload = function () {
            var data = xhr.response as ArrayBuffer | null;
            if (xhr.status < 200 || xhr.status >= 300 || !data) {
                reject({ status: xhr.status, url: url, message: 'HTTP ' + xhr.status, body: '' } as HttpError);
            } else if (data.byteLength > maxBytes) {
                tooBig();
            } else {
                resolve(data);
            }
        };
        xhr.onerror = function () {
            reject({ status: 0, url: url, message: 'network error', body: '' } as HttpError);
        };
        xhr.ontimeout = function () {
            reject({ status: 0, url: url, message: 'timeout', body: '' } as HttpError);
        };
        xhr.send(null);
    });
}

/** The JSON body of an error reply, or null */
export function errorBody<T>(e: HttpError): T | null {
    try {
        return e && e.body ? JSON.parse(e.body) as T : null;
    } catch (err) {
        return null;
    }
}

/** A reply's JSON (empty: null; not JSON: an HttpError) */
export function parse<T>(text: string, url: string): T {
    if (!text) {
        return null as unknown as T;
    }
    try {
        return JSON.parse(text) as T;
    } catch (e) {
        throw { status: 200, url: url, message: 'invalid JSON', body: '' } as HttpError;
    }
}

function send(method: string, url: string, body: string | null, headers?: { [name: string]: string }, timeoutMs?: number, as?: string): Promise<string> {
    return new Promise<string>(function (resolve, reject) {
        var xhr = new XMLHttpRequest();
        // (no longer on its way: not one abortSent finds)
        var over = function (): void {
            if (as) {
                named = named.filter(function (n) { return n.xhr !== xhr; });
            }
        };
        var unanswered = function (message: string): void {
            over();
            reject({ status: 0, url: url, message: message, body: '' } as HttpError);
        };
        xhr.open(method, url, true);
        xhr.timeout = timeoutMs || 10000;
        for (var name in headers) {
            xhr.setRequestHeader(name, headers[name]);
        }
        xhr.onload = function () {
            over();
            if (xhr.status >= 200 && xhr.status < 300) {
                resolve(xhr.responseText);
            } else {
                reject({ status: xhr.status, url: url, message: 'HTTP ' + xhr.status, body: xhr.responseText } as HttpError);
            }
        };
        xhr.onerror = function () { unanswered('network error'); };
        xhr.ontimeout = function () { unanswered('timeout'); };
        xhr.onabort = function () { unanswered(ABORTED); };
        if (as) {
            named.push({ as: as, xhr: xhr });
        }
        xhr.send(body);
    });
}
