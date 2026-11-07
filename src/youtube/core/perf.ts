// Built-in measurement, read through remote DevTools (window.__bolli):
//   marks:  named moments in ms since the app started
//   lags:   [time, ms] when the main thread was blocked for > 100 ms
//   keys:   [time, keyCode, ms until the next frame was drawn]
//   zaps:   [channel, ms from request to first video frame]
//   saver:  [time, message] the TV's screensaver requests and the app's answers
//   stalls: [time, channel, what was done] a live picture that stood still
//   net:    [time, what the TV's connection manager said, and when it was asked]
// Costs one 100 ms timer (while the app shows) and one animation frame per key press.

export interface Perf {
    start: number;
    marks: { [name: string]: number };
    lags: number[][];
    keys: number[][];
    zaps: (string | number)[][];
    saver: (string | number)[][];
    stalls: (string | number)[][];
    net: (string | number)[][];
}

var MAX = 300;

var perf: Perf = {
    start: Date.now(),
    marks: {},
    lags: [],
    keys: [],
    zaps: [],
    saver: [],
    stalls: [],
    net: []
};

function push<T>(list: T[], item: T): void {
    list.push(item);
    if (list.length > MAX) {
        list.shift();
    }
}

export function initPerf(): void {
    (window as unknown as { __bolli: Perf }).__bolli = perf;
    var last = 0;
    var timer = 0;
    var watch = function () {
        last = Date.now();
        timer = setInterval(function () {
            var now = Date.now();
            var lag = now - last - 100;
            if (lag > 100) {
                push(perf.lags, [now - lag, lag]);
            }
            last = now;
        }, 100) as unknown as number;
    };
    // Paused in the background (preloaded, or another app in front): nothing
    // to measure, and it would wake the TV ten times a second
    document.addEventListener('visibilitychange', function () {
        clearInterval(timer);
        if (!document.hidden) {
            watch();
        }
    });
    if (!document.hidden) {
        watch();
    }
}

export function mark(name: string): void {
    if (perf.marks[name] === undefined) {
        perf.marks[name] = Date.now() - perf.start;
    }
}

export function noteKey(code: number, at: number): void {
    window.requestAnimationFrame(function () {
        push(perf.keys, [at, code, Date.now() - at]);
    });
}

export function noteZap(channel: string, ms: number): void {
    push(perf.zaps, [channel, ms]);
}

export function noteStall(channel: string, action: string): void {
    push(perf.stalls, [Date.now(), channel, action]);
}

export function noteSaver(message: string): void {
    push(perf.saver, [Date.now(), message]);
}

export function noteNet(message: string): void {
    push(perf.net, [Date.now(), message]);
}
