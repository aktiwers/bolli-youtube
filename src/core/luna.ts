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
