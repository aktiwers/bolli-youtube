// YouTube's TV player script (named by its /tv page, 2.5 MB), for what SABR
// streams need: the n transform (the stream URL's n parameter must be
// transformed, else the video servers answer 403) and the signature
// timestamp. The script is obfuscated (names, numbers and string order
// change per version; functions branch on XORed numbers), so the transform
// is found by stable patterns: the string table containing "n", the place n
// is read from a URL and passed to a function with two XORed numbers, and in
// that function the call that computes the new n. The script runs in a
// worker (window stubbed) with one line appended that exposes that call via
// messages. In a page frame it blocks the app ~1.8 s on the TV; in a worker
// only ~0.2 s. The worker holds ~45 MB, so it is dropped IDLE_MS after the
// last use. In a script without that shape the line appended uses the
// script's stream URL builder, found and called as yt-dlp's solver does it
// (urlBuilders). If both fail, it is the code yt-dlp's solver makes to
// compute n in that script: a job keeps it, made ES5 for old TVs, for each
// new TV player script (github.com/aktiwers/bolli-solver), so no app update
// is needed; the app keeps it too. If all fail, SABR is unavailable and the
// player carries on. The signature timestamp is handed out as soon as the
// script is read, so /player is asked while the script still starts in its
// worker.

import { getText } from '../../core/http.js';
import { load, save } from '../../core/store.js';
import { answer, forgetTvPage, tvPage, youtubePage } from './youtube.js';

export interface PlayerScript {
    /** Transform a stream URL's n parameter */
    n: (v: string) => Promise<string>;
    /** signatureTimestamp for /player: the script version the URLs are made for */
    sts: number;
}

/** The transform's location: the function name and its two arguments */
interface NTransform {
    fn: string;
    a: number;
    b: number;
}

/** The worker is dropped this long after its last use */
var IDLE_MS = 60000;
/** Give up if the script has not run by then */
var RUN_MS = 20000;
/** An n asked of the worker gives up after this (also the self-test: a worker that hangs or died answers nothing) */
var ASK_MS = 5000;
/** A script it cannot use (another shape, or it does not run) is not tried again for this long: each use would fetch
 * and search its 2.5 MB again, and a run costs ~1.8 s and ~45 MB on the TV */
var FAILED_MS = 5 * 60000;
/** Where the solver job keeps its code for each script (players/<id>/<name>.js), tried in turn: GitHub itself
 * (fresh within minutes), then a CDN (it may lag hours behind a new version, but answers when GitHub does not) */
var SOLVED = ['https://raw.githubusercontent.com/aktiwers/bolli-solver/main/players/',
    'https://cdn.jsdelivr.net/gh/aktiwers/bolli-solver@main/players/'];
var SOLVED_MS = 20000;
/** The solver job's code for the scripts that last needed it (YouTube serves a few versions at once), kept across
 * starts so those skip the search and the download */
var KEPT_KEY = 'youtube.solved';
var KEPT_COUNT = 3;
/** The TV player script its /tv page names: /s/player/<id>/tv-player….vflset/<name>.js */
var PLAYER_PATH = /\/s\/player\/([\w-]+)\/tv-player[\w-]*\.vflset\/([\w-]+)\.js/;
/** Stream URL builders tried at most, and how far back a block's start is looked for */
var BUILDERS_MAX = 8;
var BLOCK_SCAN = 20000;
/** The script's closure ends here: code added before it reaches the script's own names */
var END = '}).call(this);';
/** Window stubs for what the script reads while it runs in the worker (the transform needs none of them) */
var STUB = 'var window=self,top=self,parent=self;self.document={createElement:function(){return{style:{},setAttribute:function(){},' +
    'appendChild:function(){},getContext:function(){return null}}},documentElement:{style:{}},addEventListener:function(){},' +
    'getElementsByTagName:function(){return[]},querySelector:function(){return null},cookie:"",location:self.location,body:null,head:null};' +
    'var document=self.document;\n';
/** Appended: answers transform requests by message and reports once the script has run */
var TAIL = '\n;self.onmessage=function(e){var r;try{r={id:e.data.id,v:self.__bolliN(e.data.v)}}catch(x){r={id:e.data.id,error:String(x)}}' +
    'postMessage(r)};postMessage({ready:typeof self.__bolliN});';

var script: Promise<PlayerScript> | null = null;
var worker: Worker | null = null;
var idleTimer = 0;
var kept: { file: string; code: string }[] = load<{ file: string; code: string }[]>(KEPT_KEY) || [];

/** The TV player script's signature timestamp, and its n transform (which waits for the script to run in its worker,
 * so /player can be asked meanwhile). Loaded on demand: again after a failed fetch, FAILED_MS after a script it cannot
 * use (another shape, or it does not run), or after being dropped IDLE_MS after its last use. */
export function playerScript(): Promise<PlayerScript> {
    clearTimeout(idleTimer);
    if (!script) {
        var made: Promise<PlayerScript> = script = Promise.all<any>([tvPage(), youtubePage()]).then(function (got) {
            var found = PLAYER_PATH.exec(got[0].html);
            if (!found) {
                // (a page without it, e.g. an interstitial: the next try asks for the page again)
                forgetTvPage();
                throw lasting('No TV player script');
            }
            var file = found[1] + '/' + found[2] + '.js';
            var w = got[1] as Window;
            return answer(w, 'GET', found[0], null, {}).then(function (r) {
                if (r.status !== 200) {
                    throw new Error('The TV player script: ' + r.status);
                }
                var js = r.text;
                // (as yt-dlp finds it: a space or the short name would not lose it; a whole name, not the end of another)
                var sts = +(/\b(?:signatureTimestamp|sts)\s*:\s*(\d{5})/.exec(js) || [])[1];
                if (!sts || js.lastIndexOf(END) < 0) {
                    throw lasting('The TV player script has an unexpected shape');
                }
                var ran = runSoon(js, file);
                ran.then(null, function (e: Error) {
                    if (script === made) {
                        keepFailed(e);
                    }
                });
                return { sts: sts, n: function (v: string) { return ran.then(function (n) { return n(v); }); } };
            });
        });
        made.then(null, function (e: Error) {
            // A script of another shape waits as one that failed to run; one not fetched (the network) is asked again
            if (script === made) {
                if ((e as Error & { lasting?: boolean }).lasting) {
                    keepFailed(e);
                } else {
                    script = null;
                }
            }
        });
    }
    var asked = script;
    asked.then(function () {
        if (script === asked) {
            clearTimeout(idleTimer);
            // (only this script: one that failed meanwhile keeps its FAILED_MS)
            idleTimer = setTimeout(function () {
                if (script === asked) {
                    drop();
                }
            }, IDLE_MS) as unknown as number;
        }
    }, function () { return undefined; });
    return script;
}

/** A failure that stays as long as YouTube's script does (not the network's) */
function lasting(message: string): Error {
    var e = new Error(message) as Error & { lasting?: boolean };
    e.lasting = true;
    return e;
}

/** The script failed with e: kept for FAILED_MS */
function keepFailed(e: Error): void {
    var failed = script = Promise.reject(e);
    failed.then(null, function () { return undefined; });
    setTimeout(function () {
        if (script === failed) {
            script = null;
        }
    }, FAILED_MS);
}

/** run() a tick later, so /player is asked first (the search and the worker's start block a while). A function of its
 * own: inside playerScript the waiting closure would share n()'s scope, keeping the script's text (2.5 MB) alive as
 * long as the script is cached */
function runSoon(js: string, file: string): Promise<(v: string) => Promise<string>> {
    return new Promise<void>(function (ok) { setTimeout(ok, 0); }).then(function () { return run(js, file); });
}

/** The script running in its worker with its transform. The solver job's code kept for this script comes first: it
 * is kept only where the other ways failed for it, each a whole run in a worker (~1.8 s on the TV) */
function run(js: string, file: string): Promise<(v: string) => Promise<string>> {
    return keptFor(file) ? fromJob(js, file).then(null, function () { return search(js, file); }) : search(js, file);
}

/** The solver job's code kept for a script (undefined: none) */
function keptFor(file: string): { file: string; code: string } | undefined {
    return kept.filter(function (k) { return k.file === file; })[0];
}

/** The transform found by its old shape, else through its stream URL builder as yt-dlp's solver finds it
 * (urlBuilders), else by the solver job's code for the script (file: <id>/<name>.js; kept from an earlier run: no
 * download) */
function search(js: string, file: string): Promise<(v: string) => Promise<string>> {
    var found = findNTransform(js);
    var own = found ? startTransform(atEnd(js, exportOf(found))) : Promise.reject(new Error('The n transform was not found'));
    return own.then(null, function (e: Error) {
        var builders = urlBuilders(js);
        return builders.length ? startTransform(atEnd(js, builderExport(builders))) : Promise.reject(e);
    }).then(null, function (e: Error) {
        return fromJob(js, file).then(null, function (other: Error) {
            throw new Error(e.message + ' (solved: ' + other.message + ')');
        });
    });
}

/** The script running with the solver job's code for it: kept, else downloaded (and kept once it runs) */
function fromJob(js: string, file: string): Promise<(v: string) => Promise<string>> {
    var known = keptFor(file);
    if (known) {
        return startTransform(atEnd(js, known.code)).then(null, function (e: Error) {
            // Downloaded again next time
            kept = kept.filter(function (k) { return k !== known; });
            save(KEPT_KEY, kept);
            throw e;
        });
    }
    return solved(file).then(function (code) {
        return startTransform(atEnd(js, code)).then(function (n) {
            kept = [{ file: file, code: code }].concat(kept.filter(function (k) { return k.file !== file; })).slice(0, KEPT_COUNT);
            save(KEPT_KEY, kept);
            return n;
        });
    });
}

/** The solver job's code for a script, from GitHub, else from the CDN */
function solved(file: string): Promise<string> {
    return getText(SOLVED[0] + file, SOLVED_MS).then(null, function () {
        return getText(SOLVED[1] + file, SOLVED_MS);
    }).then(null, function (e) {
        throw new Error('not found: ' + e.message);
    });
}

/** Run a script (in parts) that sets self.__bolliN in a worker and call the transform by message (checked to actually
 * change an n) */
export function startTransform(parts: string[]): Promise<(v: string) => Promise<string>> {
    removeWorker();
    var url = URL.createObjectURL(new Blob([STUB].concat(parts, [TAIL]), { type: 'text/javascript' }));
    var w = worker = new Worker(url);
    var asked: { [id: number]: (reply: { v?: string; error?: string }) => void } = {};
    var asks = 0;
    var started = false;
    // The worker failed (an ask got no reply, or it died): what waits is told; once started, it goes with its script
    // (the next use starts them again; kept, it would cost every video ASK_MS)
    var fail = function (message: string): void {
        for (var id in asked) {
            var told = asked[id];
            delete asked[id];
            told({ error: message });
        }
        if (started && worker === w) {
            drop();
        }
    };
    var n = function (v: string): Promise<string> {
        return new Promise<string>(function (resolve, reject) {
            var id = ++asks;
            var timer = setTimeout(function () {
                // (not "did not answer": that is the network's, api/youtube.ts noAnswer, and this is the worker's)
                fail('The n transform gave no reply');
            }, ASK_MS);
            asked[id] = function (reply) {
                clearTimeout(timer);
                if (reply.error) {
                    reject(new Error(reply.error));
                } else {
                    resolve(String(reply.v));
                }
            };
            w.postMessage({ id: id, v: v });
        });
    };
    var ran = new Promise<(v: string) => Promise<string>>(function (resolve, reject) {
        // Ran, failed or timed out: its script URL goes
        var settle = function (): void {
            clearTimeout(timer);
            URL.revokeObjectURL(url);
        };
        var timer = setTimeout(function () {
            settle();
            reject(new Error('The TV player script did not run'));
        }, RUN_MS);
        w.onerror = function (e) {
            settle();
            var message = 'The TV player script failed: ' + e.message;
            reject(new Error(message));
            fail(message);
        };
        w.onmessage = function (e) {
            var d = e.data;
            if (d.ready === undefined) {
                var told = asked[d.id];
                delete asked[d.id];
                if (told) {
                    told(d);
                }
                return;
            }
            settle();
            if (d.ready !== 'function') {
                reject(new Error('The n transform did not run'));
                return;
            }
            n('abcdefghijklmnop').then(function (v) {
                if (v === 'abcdefghijklmnop') {
                    reject(new Error('The n transform did not run'));
                } else {
                    started = true;
                    resolve(n);
                }
            }, reject);
        };
    });
    ran.then(null, function () {
        if (worker === w) {
            removeWorker();
        }
    });
    return ran;
}

/** Drop the script and free its worker's memory; the next use runs it again */
function drop(): void {
    removeWorker();
    script = null;
}

function removeWorker(): void {
    if (worker) {
        worker.terminate();
    }
    worker = null;
}

/** Locate the transform in the script (null: the script's structure has changed) */
export function findNTransform(js: string): NTransform | null {
    var table = /'use strict';var ([\w$]+)="((?:[^"\\]|\\.)*)"\.split\("(.)"\)/.exec(js);
    if (!table) {
        return null;
    }
    var h = esc(table[1]);
    var n = table[2].split(table[3]).indexOf('n');
    if (n < 0) {
        return null;
    }
    // n read from a URL and passed on: …[h[e^1315]][h[5]]||null)&&(f=sa(e^1310,e^7273,f,…
    var read = new RegExp('\\[' + h + '\\[(\\w)\\^\\d+\\]\\]\\[' + h + '\\[' + n + '\\]\\]\\|\\|null\\)&&\\((\\w)=([\\w$]+)\\(\\1\\^(\\d+),\\1\\^(\\d+),\\2,').exec(js);
    if (!read) {
        return null;
    }
    var outer = esc(read[3]);
    var key = (+read[4]) ^ (+read[5]);
    // In it: …=function(a,b,…){var k=b^a; … l=oa(k^6508,k^2395,c);d[h[k^6522]](h[5],l)
    var make = new RegExp('[,;\\s]' + outer + '=function\\((\\w),(\\w)[^)]*\\)\\{var (\\w)=(?:\\2\\^\\1|\\1\\^\\2);[\\s\\S]{0,600}?(\\w)=([\\w$]+)\\(\\3\\^(\\d+),\\3\\^(\\d+),\\w\\);\\w\\[' + h + '\\[\\3\\^\\d+\\]\\]\\(' + h + '\\[' + n + '\\],\\4\\)').exec(js);
    if (!make) {
        return null;
    }
    return { fn: make[5], a: key ^ (+make[6]), b: key ^ (+make[7]) };
}

/** The functions that make a stream URL object, by name, as yt-dlp's solver (github.com/yt-dlp/ejs) finds them: each
 * a function whose own body sets alr=yes on it, as a statement of its own ([]: none) */
export function urlBuilders(js: string): string[] {
    var out: string[] = [];
    var set = /[;{][\w$]+\.[\w$]+\("alr","yes"\)[;}]/g;
    var m: RegExpExecArray | null;
    while ((m = set.exec(js)) && out.length < BUILDERS_MAX) {
        var open = blockStart(js, m.index + 1);
        // The block must be the function's body: function name(…){ or name=function(…){
        var head = open < 0 ? null : /(?:function\s+([\w$]+)|([\w$][\w$.]*)\s*=\s*function)\s*\([^()]*\)\s*$/.exec(js.slice(Math.max(0, open - 200), open));
        var name = head && (head[1] || head[2]);
        if (name && out.indexOf(name) < 0) {
            out.push(name);
        }
    }
    return out;
}

/** Where the block holding position at opens (its unmatched "{" before it), within BLOCK_SCAN characters (-1: not
 * found); strings are stepped over */
function blockStart(js: string, at: number): number {
    var depth = 0;
    var stop = Math.max(0, at - BLOCK_SCAN);
    for (var i = at - 1; i >= stop; i--) {
        var c = js.charAt(i);
        if (c === '"' || c === '\'') {
            // Back to the string's opening quote (an escaped quote does not open it)
            for (i--; i >= stop && !(js.charAt(i) === c && !escaped(js, i)); i--) {
                // inside the string
            }
        } else if (c === '}') {
            depth++;
        } else if (c === '{') {
            if (!depth) {
                return i;
            }
            depth--;
        }
    }
    return -1;
}

/** Whether the character at i is escaped (an odd number of backslashes before it) */
function escaped(js: string, i: number): boolean {
    var n = 0;
    while (js.charAt(i - 1 - n) === '\\') {
        n++;
    }
    return n % 2 === 1;
}

/** Code that exposes the transform through the stream URL builders (tried in turn, as yt-dlp's solver does it): a URL
 * object made with n set, its first own method (not constructor, set, get or clone) run, its n read */
export function builderExport(names: string[]): string {
    return 'self.__bolliN=function(n){var made=[' + names.map(function (name) { return 'function(){return ' + name + '}'; }).join(',') +
        '],why=null;for(var i=0;i<made.length;i++){try{var u=made[i]()("https://youtube.com/watch?v=yt","s",undefined);u.set("n",n);' +
        'var p=Object.getPrototypeOf(u),k=Object.keys(p).concat(Object.getOwnPropertyNames(p));for(var j=0;j<k.length;j++){' +
        'if(k[j]!=="constructor"&&k[j]!=="set"&&k[j]!=="get"&&k[j]!=="clone"){u[k[j]]();break}}var r=u.get("n");' +
        'if(r&&r!==n){return r}}catch(x){why=x}}throw why||new Error("n unchanged")};';
}

/** Code that exposes the found transform as self.__bolliN */
export function exportOf(t: NTransform): string {
    return 'self.__bolliN=function(v){return ' + t.fn + '(' + t.a + ',' + t.b + ',v)};';
}

/** The script in parts with code added at the end of its closure (which run checks it has), where the script's own
 * names are in reach; parts, so the worker's Blob makes the one copy */
export function atEnd(js: string, code: string): string[] {
    var end = js.lastIndexOf(END);
    return [js.slice(0, end), ';', code, js.slice(end)];
}

function esc(name: string): string {
    return name.replace(/\$/g, '\\$');
}
