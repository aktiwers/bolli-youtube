// webOS TV 1.x (2014) runs apps in a WebKit whose Media Source is the early draft: WebKitMediaSource with
// 'webkitsourceopen', and source buffers that only append (at once) and abort, with no appendBuffer, updating, events,
// remove or append window. The player is written for the standard one, so its `new MediaSource()` failed there and no
// video started. index.html loads this only where there is no MediaSource and there is a WebKitMediaSource; it gives
// the draft the standard's shape as the player uses it:
// - MediaSource: a draft one (so the video takes its address), its events by the standard names, and its source
//   buffers given the parts below; isTypeSupported says yes to H.264 and AAC in MP4 (what these TVs play; the draft's
//   own answer is no even to those) and asks the draft for anything else.
// - A source buffer: appendBuffer appends at once and is `updating` until its updateend, in a timer as the standard's
//   is; remove removes nothing (the draft cannot: the TV frees what it needs) and ends the same way; abort stops one
//   under way; the append window is kept but not applied.
(function (g) {
    var Draft = g.WebKitMediaSource;
    if (g.MediaSource || !Draft) {
        return;
    }
    var NAMES = { sourceopen: 'webkitsourceopen', sourceended: 'webkitsourceended', sourceclose: 'webkitsourceclose' };
    var PLAYED = /^(video|audio)\/mp4\s*;\s*codecs="(avc1|mp4a)[.\w]*"/;

    function invalid() {
        var e = new Error('The source buffer is busy');
        e.name = 'InvalidStateError';
        return e;
    }

    // The standard's parts on a draft source buffer (on the object itself: the draft's prototype is not reachable)
    function buffer(sb) {
        var append = sb.append;
        var abort = sb.abort;
        var listeners = {};
        var timer = 0;
        var fire = function (type) {
            var all = (listeners[type] || []).slice();
            var e = { type: type, target: sb };
            for (var i = 0; i < all.length; i++) {
                all[i].call(sb, e);
            }
        };
        // The end of an update, after the caller's turn, as the standard's comes
        var update = function () {
            sb.updating = true;
            timer = setTimeout(function () {
                timer = 0;
                sb.updating = false;
                fire('update');
                fire('updateend');
            }, 0);
        };
        sb.updating = false;
        sb.appendWindowStart = 0;
        sb.appendWindowEnd = Infinity;
        sb.addEventListener = function (type, f) {
            var all = listeners[type] || (listeners[type] = []);
            if (all.indexOf(f) < 0) {
                all.push(f);
            }
        };
        sb.removeEventListener = function (type, f) {
            var all = listeners[type];
            var i = all ? all.indexOf(f) : -1;
            if (i >= 0) {
                all.splice(i, 1);
            }
        };
        sb.appendBuffer = function (data) {
            if (sb.updating) {
                throw invalid();
            }
            // (a full buffer throws here, as the standard's appendBuffer does)
            append.call(sb, data instanceof Uint8Array ? data : data.buffer ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data));
            update();
        };
        sb.remove = function () {
            if (sb.updating) {
                throw invalid();
            }
            update();
        };
        sb.abort = function () {
            var was = sb.updating;
            clearTimeout(timer);
            timer = 0;
            sb.updating = false;
            abort.call(sb);
            if (was) {
                fire('abort');
                fire('updateend');
            }
        };
        return sb;
    }

    // A draft Media Source with the standard's names (the object itself: the video takes only a draft one's address)
    function MediaSource() {
        var ms = new Draft();
        var add = ms.addEventListener;
        var drop = ms.removeEventListener;
        var addBuffer = ms.addSourceBuffer;
        ms.addEventListener = function (type, f, capture) {
            add.call(ms, NAMES[type] || type, f, capture);
        };
        ms.removeEventListener = function (type, f, capture) {
            drop.call(ms, NAMES[type] || type, f, capture);
        };
        ms.addSourceBuffer = function (type) {
            return buffer(addBuffer.call(ms, type));
        };
        return ms;
    }
    MediaSource.isTypeSupported = function (type) {
        return PLAYED.test(type) || !!Draft.isTypeSupported && Draft.isTypeSupported(type);
    };
    g.MediaSource = MediaSource;
})(window);
