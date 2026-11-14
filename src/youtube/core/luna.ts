// Calls webOS system services (luna://…) through the page's PalmServiceBridge.
// Keep a reference to the returned bridge while replies are wanted: a bridge
// dropped early is garbage-collected along with its replies. Returns null
// outside the TV. Each reply is passed as text and as parsed JSON (null when
// it is not JSON).

export interface Bridge {
    onservicecallback: (message: string) => void;
    call(uri: string, params: string): void;
    cancel?(): void;
}

export type LunaReply = { [key: string]: unknown } | null;

export function lunaCall(uri: string, params: object, reply: (message: string, data: LunaReply) => void): Bridge | null {
    var Ctor = (window as unknown as { PalmServiceBridge?: { new (): Bridge } }).PalmServiceBridge;
    if (!Ctor) {
        return null;
    }
    var bridge = new Ctor();
    bridge.onservicecallback = function (message: string) {
        var data: LunaReply = null;
        try {
            data = JSON.parse(message);
        } catch (e) {
            // not JSON: data stays null
        }
        reply(message, data);
    };
    bridge.call(uri, JSON.stringify(params));
    return bridge;
}

/** Calls waiting for their one reply (held: a bridge let go is dropped with its reply) */
var waiting: Bridge[] = [];

/** What lunaAsk rejects with: said is the service's own reason (its errorText; '' when it gave none, 'no answer' when
 * the time given ran out) */
export interface Refusal extends Error {
    said?: string;
}

function refusal(said: string): Refusal {
    var e: Refusal = new Error('refused');
    e.said = said;
    return e;
}

/** A call whose one reply is wanted: resolves with it when it says returnValue true, rejects otherwise (a refusal, no
 * such service, or outside the TV). ms: how long the reply may take (none: as long as it does); past it the call is
 * let go and rejected. */
export function lunaAsk(uri: string, params: object, ms?: number): Promise<{ [key: string]: unknown }> {
    return new Promise<{ [key: string]: unknown }>(function (resolve, reject) {
        var timer = 0;
        var bridge = lunaCall(uri, params, function (_message, reply) {
            waiting = waiting.filter(function (b) { return b !== bridge; });
            if (timer) {
                clearTimeout(timer);
            }
            if (reply && reply.returnValue === true) {
                resolve(reply);
            } else {
                reject(refusal(reply && typeof reply.errorText === 'string' ? reply.errorText : ''));
            }
        });
        if (!bridge) {
            reject(new Error('no services'));
            return;
        }
        waiting.push(bridge);
        if (ms) {
            var held = bridge;
            timer = setTimeout(function () {
                waiting = waiting.filter(function (b) { return b !== held; });
                held.onservicecallback = function () { return undefined; };
                try {
                    if (held.cancel) {
                        held.cancel();
                    }
                } catch (e) {
                    // (nothing to let go)
                }
                reject(refusal('no answer'));
            }, ms) as unknown as number;
        }
    });
}
