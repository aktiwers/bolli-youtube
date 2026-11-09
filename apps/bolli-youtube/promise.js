// webOS TV 2.x (2015) runs apps in an old WebKit whose own Promise is an early one: no Promise.all or race, and
// Promise.resolve() wants an argument, so the app stopped at its first line (a black screen). index.html (and the
// parse worker's parse-old.js) load this only there, and it does nothing where the engine names its Chrome (webOS 3
// and later, Android) or a Promise has all and race; it marks the old engine (bolliOldEngine: api/streams.ts asks for
// a video's streams through youtube.com's page there). Promises/A+ as the app uses them:
// then, catch, resolve, reject, all, race; its callbacks run in a microtask (a MutationObserver), else in a timer.
(function install(g) {
    var P0 = g.Promise;
    if (/Chrome\//.test(navigator.userAgent) || typeof P0 === 'function' && P0.all && P0.race) {
        return;
    }
    g.bolliOldEngine = true;
    // Its own source, for a worker made from a Blob (api/player-script.ts: YouTube's player code there)
    g.bolliPromise = '(' + install + ')(self);';
    // (WebP it does not decode either: app.css has PNG copies under this class)
    if (g.document) {
        document.documentElement.className += ' by-old-engine';
    }
    var later = function (f) { setTimeout(f, 0); };
    if (g.MutationObserver && g.document) {
        var queue = [];
        var node = document.createTextNode('');
        var tick = 0;
        new MutationObserver(function () {
            var run = queue;
            queue = [];
            for (var i = 0; i < run.length; i++) {
                run[i]();
            }
        }).observe(node, { characterData: true });
        later = function (f) {
            queue.push(f);
            if (queue.length === 1) {
                node.data = String(++tick);
            }
        };
    }
    function P(fn) {
        var self = this;
        var once = false;
        this._s = 0;
        this._v = undefined;
        this._h = [];
        try {
            fn(function (v) { if (!once) { once = true; resolve(self, v); } }, function (e) { if (!once) { once = true; settle(self, 2, e); } });
        } catch (e) {
            if (!once) {
                once = true;
                settle(self, 2, e);
            }
        }
    }
    function settle(p, s, v) {
        if (p._s) {
            return;
        }
        p._s = s;
        p._v = v;
        var h = p._h;
        p._h = null;
        for (var i = 0; i < h.length; i++) {
            run(p, h[i]);
        }
    }
    function resolve(p, v) {
        if (v === p) {
            return settle(p, 2, new TypeError('A promise resolved with itself'));
        }
        if (v && (typeof v === 'object' || typeof v === 'function')) {
            var then;
            try {
                then = v.then;
            } catch (e) {
                return settle(p, 2, e);
            }
            if (typeof then === 'function') {
                var done = false;
                try {
                    then.call(v, function (x) { if (!done) { done = true; resolve(p, x); } }, function (e) { if (!done) { done = true; settle(p, 2, e); } });
                } catch (e) {
                    if (!done) {
                        done = true;
                        settle(p, 2, e);
                    }
                }
                return;
            }
        }
        settle(p, 1, v);
    }
    function run(p, h) {
        later(function () {
            var cb = p._s === 1 ? h.f : h.r;
            // (no handler: passed on as it settled, a value already unwrapped by resolve)
            if (typeof cb !== 'function') {
                return settle(h.p, p._s, p._v);
            }
            var x;
            try {
                x = cb(p._v);
            } catch (e) {
                return settle(h.p, 2, e);
            }
            resolve(h.p, x);
        });
    }
    P.prototype.then = function (f, r) {
        var next = new P(function () { return undefined; });
        var h = { f: f, r: r, p: next };
        if (this._s) {
            run(this, h);
        } else {
            this._h.push(h);
        }
        return next;
    };
    P.prototype['catch'] = function (r) {
        return this.then(null, r);
    };
    P.resolve = function (v) {
        return v instanceof P ? v : new P(function (ok) { ok(v); });
    };
    P.reject = function (e) {
        return new P(function (ok, no) { no(e); });
    };
    P.all = function (list) {
        return new P(function (ok, no) {
            var out = [];
            var left = list.length;
            if (!left) {
                return ok(out);
            }
            list.forEach(function (one, i) {
                P.resolve(one).then(function (v) {
                    out[i] = v;
                    if (--left === 0) {
                        ok(out);
                    }
                }, no);
            });
        });
    };
    P.race = function (list) {
        return new P(function (ok, no) {
            list.forEach(function (one) { P.resolve(one).then(ok, no); });
        });
    };
    g.Promise = P;
})(typeof self !== 'undefined' ? self : this);
