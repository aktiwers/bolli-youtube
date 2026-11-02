// Minimal JSON over XMLHttpRequest (Chrome 38 has no fetch). Parsed with the
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

/** POST JSON, JSON back */
export function postJson<T>(url: string, body: unknown, headers?: { [name: string]: string }): Promise<T> {
    var all: { [name: string]: string } = { 'Content-Type': 'application/json', Accept: 'application/json' };
    for (var name in headers) {
        all[name] = headers[name];
    }
    return send('POST', url, JSON.stringify(body), all).then(function (text) { return parse<T>(text, url); });
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

/** The JSON body of an error reply, or null */
export function errorBody<T>(e: HttpError): T | null {
    try {
        return e && e.body ? JSON.parse(e.body) as T : null;
    } catch (err) {
        return null;
    }
}

function parse<T>(text: string, url: string): T {
    if (!text) {
        return null as unknown as T;
    }
    try {
        return JSON.parse(text) as T;
    } catch (e) {
        throw { status: 200, url: url, message: 'invalid JSON', body: '' } as HttpError;
    }
}

function send(method: string, url: string, body: string | null, headers?: { [name: string]: string }, timeoutMs?: number): Promise<string> {
    return new Promise<string>(function (resolve, reject) {
        var xhr = new XMLHttpRequest();
        xhr.open(method, url, true);
        xhr.timeout = timeoutMs || 10000;
        for (var name in headers) {
            xhr.setRequestHeader(name, headers[name]);
        }
        xhr.onload = function () {
            if (xhr.status >= 200 && xhr.status < 300) {
                resolve(xhr.responseText);
            } else {
                reject({ status: xhr.status, url: url, message: 'HTTP ' + xhr.status, body: xhr.responseText } as HttpError);
            }
        };
        xhr.onerror = function () {
            reject({ status: 0, url: url, message: 'network error', body: '' } as HttpError);
        };
        xhr.ontimeout = function () {
            reject({ status: 0, url: url, message: 'timeout', body: '' } as HttpError);
        };
        xhr.send(body);
    });
}
