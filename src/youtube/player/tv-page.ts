// The page's half of player/tv-app.ts: runs inside YouTube's TV page (written
// into its frame as a script before YouTube's code, from pageHooks's text), so
// it lives by that page's rules: ES5, no imports, no closures over this app's
// names; it talks to the app by postMessage and the page's __bolliPage.

/** YouTube's answer on whether a video plays, as its app read it and pageHooks sends it: the video's id ('' not
 * said), its status (OK, UNPLAYABLE, ERROR, LOGIN_REQUIRED, …) and reason in the app's language ('' none) */
export interface Playability {
    id: string;
    status: string;
    reason: string;
}

/** A media event's video state, as pageHooks sends it */
export interface MediaState {
    t: number;
    paused: boolean;
    route: string;
}

/** The page's half: runs in YouTube's TV page before YouTube's code (so ES5, self-contained).
 * Holds YouTube AdFree's ad hooks (its src/adblock.js and hooks/json-stringify.ts): ads are removed from every
 * reply YouTube's code reads (video ad slots, Home's banner and ad tiles), and every play is requested as ad-free
 * (YouTube otherwise delays an ad-blocked play about as long as the ad). Also: a postMessage fix, the quiet mode,
 * Back while shown, media events, the hooked command handler ("Who's watching?" answered) and the commands
 * (__bolliPage). opening: started on the wanted video (not quiet: it plays). */
export function pageHooks(opening: boolean): void {
    var w = window as any;
    var send = function (type: string, value?: unknown): void {
        w.top.postMessage({ bolli: type, value: value }, '*');
    };
    // In a frame, YouTube's page reports its start with parent.postMessage(message, {targetOrigin}). Chrome 38 only
    // knows postMessage(message, targetOrigin, transfer) and throws, which stops YouTube's start before its overlays
    // (Description, Buy or rent, channel panel, settings). The options are passed as those arguments instead, on the
    // windows YouTube's code can reach
    var oldForm = function (win: any): void {
        var postMessage = win.postMessage;
        win.postMessage = function (message: unknown, target: any, transfer?: unknown): void {
            if (target && typeof target === 'object') {
                transfer = target.transfer;
                // Default targetOrigin: same origin
                target = target.targetOrigin || '/';
            }
            return transfer ? postMessage.call(win, message, target, transfer) : postMessage.call(win, message, target);
        };
    };
    oldForm(w);
    oldForm(w.parent);
    // Quiet unless started for a video, and that start was not cancelled before this page loaded
    w.__bolliQuiet = !opening || !!w.parent.__bolliNoStart;
    w.__bolliShown = false;
    w.__adsRemoved = 0;
    w.__noAds = 0;
    var parse = JSON.parse;
    JSON.parse = function (this: any): any {
        var r = parse.apply(this, arguments as any);
        // YouTube's answer for a video (its player's request) when it is not a yes: told to the app (a refusal ends the
        // wait at once: tv-app.ts)
        var playable = r && typeof r === 'object' ? r.playabilityStatus : null;
        if (playable && typeof playable.status === 'string' && playable.status !== 'OK') {
            var screen = playable.errorScreen || {};
            var offer = screen.playerLegacyDesktopYpcOfferRenderer || {};
            var said = screen.playerErrorMessageRenderer && screen.playerErrorMessageRenderer.reason;
            var text = playable.reason || offer.offerDescription || (said && (said.simpleText || (said.runs || []).map(function (run: any) { return run.text; }).join(''))) || '';
            send('playability', { id: r.videoDetails && r.videoDetails.videoId || '', status: playable.status, reason: typeof text === 'string' ? text : '' });
        }
        if (r && typeof r === 'object') {
            if (r.adPlacements) {
                delete r.adPlacements;
                w.__adsRemoved++;
            }
            if (r.adSlots instanceof Array) {
                delete r.adSlots;
                w.__adsRemoved++;
            }
            if (r.playerAds) {
                delete r.playerAds;
                w.__adsRemoved++;
            }
            var c = r.contents;
            if (c) {
                var surface = c.tvBrowseRenderer && c.tvBrowseRenderer.content && c.tvBrowseRenderer.content.tvSurfaceContentRenderer;
                var lists = [surface && surface.content && surface.content.sectionListRenderer, c.sectionListRenderer];
                for (var i = 0; i < lists.length; i++) {
                    var list = lists[i];
                    if (!list || !(list.contents instanceof Array)) {
                        continue;
                    }
                    var before = list.contents.length;
                    list.contents = list.contents.filter(function (e: any) { return !e.tvMastheadRenderer && !e.adSlotRenderer; });
                    w.__adsRemoved += before - list.contents.length;
                    list.contents.forEach(function (e: any) {
                        var row = e.shelfRenderer && e.shelfRenderer.content && e.shelfRenderer.content.horizontalListRenderer;
                        if (row && row.items instanceof Array) {
                            var n = row.items.length;
                            row.items = row.items.filter(function (item: any) { return !item.adSlotRenderer; });
                            w.__adsRemoved += n - row.items.length;
                        }
                    });
                }
            }
        }
        return r;
    };
    var stringify = JSON.stringify;
    JSON.stringify = function (this: any, value: any): string {
        var play = value && typeof value === 'object' && value.playbackContext && value.playbackContext.contentPlaybackContext;
        if (play && typeof play === 'object') {
            play.isInlinePlaybackNoAd = true;
            w.__noAds++;
        }
        return stringify.apply(this, arguments as any);
    };
    var mediaPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement): any {
        if (w.__bolliQuiet) {
            return undefined;
        }
        return mediaPlay.apply(this, arguments as any);
    };
    var open = XMLHttpRequest.prototype.open;
    var xhrSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (this: any, method: string, url: string): void {
        this.__bolliDrop = w.__bolliQuiet && /\/api\/stats\/|\/ptracking|\/youtubei\/v1\/log_event/.test(String(url));
        return open.apply(this, arguments as any);
    };
    XMLHttpRequest.prototype.send = function (this: any): void {
        if (!this.__bolliDrop) {
            return xhrSend.apply(this, arguments as any);
        }
    };
    // Back while shown goes to the app (ahead of YouTube's keys), unless one of YouTube's panels has the focus (its
    // overlay stage: Description, Buy or rent, settings): then YouTube closes the panel
    w.addEventListener('keydown', function (e: KeyboardEvent) {
        if (e.keyCode !== 461 || !w.__bolliShown) {
            return;
        }
        var stage = document.querySelector('yt-unified-overlay-stage');
        if (!(stage && stage.contains(document.activeElement))) {
            e.preventDefault();
            e.stopPropagation();
            send('back');
        }
    }, true);
    // Media events (they do not bubble: caught in the capture phase)
    ['loadstart', 'loadedmetadata', 'playing', 'timeupdate'].forEach(function (type) {
        document.addEventListener(type, function (e: Event) {
            var v = e.target as HTMLVideoElement;
            if (v && v.tagName === 'VIDEO') {
                send(type, { t: v.currentTime, paused: v.paused, route: location.hash });
            }
        }, true);
    });
    var resolve: ((command: unknown) => unknown) | null = null;
    var tries = 0;
    var hook = function (): void {
        var yt = w._yttv;
        for (var key in yt || {}) {
            var target = yt[key];
            if (target && typeof target === 'function' && target.instance && typeof target.instance.resolveCommand === 'function') {
                var own = target.instance.resolveCommand.bind(target.instance);
                resolve = own;
                target.instance.resolveCommand = function (command: any, extra: any): any {
                    // Skip "Who's watching?": keep the current account (a guest too; the app has its own picker)
                    if (command && command.startAccountSelectorCommand) {
                        return own({
                            onIdentityChanged: {
                                identityActionContext: {
                                    nextEndpoint: command.startAccountSelectorCommand.nextEndpoint,
                                    eventTrigger: 'ACCOUNT_EVENT_TRIGGER_WHOS_WATCHING',
                                    reloadRequired: undefined
                                },
                                isSameIdentity: true
                            },
                            commandMetadata: { webCommandMetadata: { clientAction: true } }
                        });
                    }
                    return own(command, extra);
                };
                send('hooked');
                return;
            }
        }
        // YouTube creates it during its start; give up after a minute
        if (++tries < 1200) {
            setTimeout(hook, 50);
        }
    };
    hook();
    // YouTube AdFree's fixes for this engine (its yt-fixes.css): the watch page's shade over the
    // video (missing otherwise), Shorts' tiles and picture
    var fixes = document.createElement('style');
    fixes.textContent = '.ytLrWatchDefaultShadow{background-image:linear-gradient(to bottom,rgba(0,0,0,0) 0,rgba(0,0,0,.8) 90%)!important;' +
        'background-color:rgba(0,0,0,.3)!important;display:block!important;height:100%!important;pointer-events:none!important;' +
        'position:absolute!important;width:100%!important}' +
        '.ytLrWatchDefault2025Shadow{background-color:rgba(11,11,11,.5)!important}' +
        '.ytLrTileHeaderRendererShorts{z-index:-1}' +
        '.WEB_PAGE_TYPE_SHORTS video{border:1px solid #000;' +
        'border-image:url(data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7) 30%}';
    (document.head || document.documentElement).appendChild(fixes);
    // <body>'s classes, fixed each time YouTube resets them: its reduced look removed, as YouTube AdFree
    // does (app-quality-root: text on opaque black boxes, over the video too), and yt-icon-font-loaded
    // added. YouTube draws its icons (a font) once <body> has that class, set as the font loads, but in
    // this written page the font's load never starts: it is started here
    var iconsLoaded = false;
    var bodyClasses = function (): void {
        var body = document.body;
        var cls = body.className.replace(/(^| )app-quality-root(?= |$)/g, '');
        if (iconsLoaded && !/(^| )yt-icon-font-loaded( |$)/.test(cls)) {
            cls += ' yt-icon-font-loaded';
        }
        if (cls !== body.className) {
            body.className = cls;
        }
    };
    var watchBody = function (): void {
        if (!document.body) {
            setTimeout(watchBody, 50);
            return;
        }
        bodyClasses();
        new MutationObserver(bodyClasses).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    };
    watchBody();
    var fontTries = 0;
    var iconFont = function (): void {
        var faces: Promise<unknown>[] = [];
        if (document.body && (document as any).fonts) {
            (document as any).fonts.forEach(function (f: any) {
                if (f.family === 'YouTube') {
                    faces.push(f.load());
                }
            });
        }
        if (!faces.length) {
            if (++fontTries < 300) {
                setTimeout(iconFont, 200);
            }
            return;
        }
        Promise.all(faces).then(function () {
            iconsLoaded = true;
            bodyClasses();
        }, function () { return undefined; });
    };
    iconFont();
    var video = function (): HTMLVideoElement | null {
        return document.querySelector('video');
    };
    // YouTube's player service and its blank watch descriptor, for preload (found by shape: the
    // names are minified)
    var service: any = null;
    var blank: any = null;
    var findPreload = function (): boolean {
        var yt = w._yttv || {};
        for (var key in yt) {
            if (service && blank) {
                break;
            }
            var o = yt[key];
            if (!service && o && typeof o.get === 'function' && o.mappings) {
                for (var m in o.mappings) {
                    // Only an already created one (requested before its module loads, a stub would be kept)
                    var entry = o.mappings[m] && typeof o.mappings[m] === 'object' ? o.mappings[m].PlayerService : null;
                    if (entry && entry.type === 'mapping' && entry.value && typeof entry.value.preloadVideo === 'function') {
                        service = entry.value;
                    }
                }
            }
            // The cheap tests first: isFrozen lists an object's properties
            if (!blank && o && typeof o === 'object' && 'watchEndpoint' in o && 'reelWatchEndpoint' in o &&
                'prefetchWatchCommand' in o && 'startTime' in o && Object.isFrozen(o)) {
                blank = o;
            }
        }
        return !!(service && blank);
    };
    w.__bolliPage = {
        open: function (want: { id: string; t: number }): void {
            w.__bolliQuiet = false;
            if (resolve) {
                resolve({ watchEndpoint: want.t ? { videoId: want.id, startTimeSeconds: Math.floor(want.t) } : { videoId: want.id } });
            }
        },
        empty: function (): void {
            // Quiet again (an open queued before this one turned it off)
            w.__bolliQuiet = true;
            var v = video();
            if (v) {
                v.pause();
                v.removeAttribute('src');
                v.load();
            }
        },
        seek: function (t: number): void {
            var v = video();
            if (v) {
                v.currentTime = t;
            }
        },
        pause: function (): void {
            var v = video();
            if (v) {
                v.pause();
            }
        },
        // A remote key that came through the app (Android's remote, a phone's d-pad), pressed here on the focus
        key: function (code: number): void {
            var names: { [code: number]: string } = { 13: 'Enter', 37: 'ArrowLeft', 38: 'ArrowUp', 39: 'ArrowRight', 40: 'ArrowDown' };
            var target = document.activeElement || document.body;
            ['keydown', 'keyup'].forEach(function (type) {
                var e: any;
                try {
                    e = new KeyboardEvent(type, { bubbles: true, cancelable: true, key: names[code] || '' } as KeyboardEventInit);
                } catch (x) {
                    e = document.createEvent('Event');
                    e.initEvent(type, true, true);
                }
                Object.defineProperty(e, 'keyCode', { get: function () { return code; } });
                Object.defineProperty(e, 'which', { get: function () { return code; } });
                target.dispatchEvent(e);
            });
        },

        preload: function (id: string): void {
            if (!findPreload()) {
                return;
            }
            var wanted: any = {};
            for (var f in blank) {
                wanted[f] = blank[f];
            }
            wanted.watchEndpoint = { videoId: id };
            try {
                var done = service.preloadVideo(wanted, undefined, 'playback_preview_preload');
                if (done && done.then) {
                    done.then(null, function () { return undefined; });
                }
            } catch (e) {
                // Failed: the video opens without preload
            }
        }
    };
}
