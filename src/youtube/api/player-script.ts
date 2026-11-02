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
// last use. If anything fails, SABR is unavailable and the player carries on.

import { answer, tvPage, youtubePage } from './youtube.js';

export interface PlayerScript {
    /** Transform a stream URL's n parameter */
    n: (v: string) => Promise<string>;
    /** signatureTimestamp for /player: the script version the URLs are made for */
    sts: number;
}

/** The transform's location: the function name and its two arguments */
export interface NTransform {
    fn: string;
    a: number;
    b: number;
}

/** The worker is dropped this long after its last use */
var IDLE_MS = 60000;
/** Give up if the script has not run by then */
var RUN_MS = 20000;
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

/** The TV player script's n transform, loaded on demand (again after a failure or after being dropped IDLE_MS after
 * its last use) */
export function playerScript(): Promise<PlayerScript> {
    clearTimeout(idleTimer);
    if (!script) {
        script = Promise.all<any>([tvPage(), youtubePage()]).then(function (got) {
            var path = /\/s\/player\/[\w-]+\/tv-player[\w-]*\.vflset\/[\w-]+\.js/.exec(got[0].html);
            if (!path) {
                throw new Error('No TV player script');
            }
            var w = got[1] as Window;
            return answer(w, 'GET', path[0], null, {}).then(function (r) {
                if (r.status !== 200) {
                    throw new Error('The TV player script: ' + r.status);
                }
                return run(r.text);
            });
        });
        var made = script;
        made.then(null, function () {
            if (script === made) {
                script = null;
            }
        });
    }
    var asked = script;
    asked.then(function () {
        if (script === asked) {
            clearTimeout(idleTimer);
            idleTimer = setTimeout(drop, IDLE_MS) as unknown as number;
        }
    }, function () { return undefined; });
    return script;
}

/** Run the script in a worker and call the transform by message (checked to actually change an n) */
function run(js: string): Promise<PlayerScript> {
    var found = findNTransform(js);
    var patched = found && withExport(js, found);
    var sts = +(/signatureTimestamp:(\d+)/.exec(js) || [])[1];
    if (!patched || !sts) {
        return Promise.reject(new Error('The n transform was not found'));
    }
    removeWorker();
    var url = URL.createObjectURL(new Blob([STUB, patched, TAIL], { type: 'text/javascript' }));
    var w = worker = new Worker(url);
    var asked: { [id: number]: (reply: { v?: string; error?: string }) => void } = {};
    var asks = 0;
    var n = function (v: string): Promise<string> {
        return new Promise<string>(function (resolve, reject) {
            var id = ++asks;
            asked[id] = function (reply) {
                if (reply.error) {
                    reject(new Error(reply.error));
                } else {
                    resolve(String(reply.v));
                }
            };
            w.postMessage({ id: id, v: v });
        });
    };
    var ran = new Promise<PlayerScript>(function (resolve, reject) {
        var timer = setTimeout(function () { reject(new Error('The TV player script did not run')); }, RUN_MS);
        w.onerror = function (e) {
            clearTimeout(timer);
            reject(new Error('The TV player script failed: ' + e.message));
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
            clearTimeout(timer);
            URL.revokeObjectURL(url);
            if (d.ready !== 'function') {
                reject(new Error('The n transform did not run'));
                return;
            }
            n('abcdefghijklmnop').then(function (v) {
                if (v === 'abcdefghijklmnop') {
                    reject(new Error('The n transform did not run'));
                } else {
                    resolve({ n: n, sts: sts });
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

/** The script with the transform exposed at the end of its closure (null: unexpected ending) */
export function withExport(js: string, t: NTransform): string | null {
    var end = js.lastIndexOf('}).call(this);');
    if (end < 0) {
        return null;
    }
    return js.slice(0, end) + ';window.__bolliN=function(v){return ' + t.fn + '(' + t.a + ',' + t.b + ',v)};' + js.slice(end);
}

function esc(name: string): string {
    return name.replace(/\$/g, '\\$');
}
