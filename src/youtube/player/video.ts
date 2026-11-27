// The app's one <video> element, shared by the live and the on-demand player.
// A player sets its whole state when it starts (placeVideo) and frees the
// TV's hardware decoder when it stops (releaseVideo), so neither depends on
// what the other left behind.

/** A box for the video (e.g. a preview), in layout units */
export interface Rect {
    left: number;
    top: number;
    width: number;
    height: number;
}

/** An element's box in layout units (a forced layout: measure once and keep it) */
export function boxRect(el: HTMLElement): Rect {
    var left = 0;
    var top = 0;
    for (var e = el as HTMLElement | null; e; e = e.offsetParent as HTMLElement | null) {
        left += e.offsetLeft;
        top += e.offsetTop;
    }
    return { left: left, top: top, width: el.offsetWidth, height: el.offsetHeight };
}

/** Shows the video full screen (null) or at rect */
export function placeVideo(video: HTMLVideoElement, rect: Rect | null): void {
    var s = video.style;
    s.left = rect ? rect.left + 'px' : '';
    s.top = rect ? rect.top + 'px' : '';
    s.width = rect ? rect.width + 'px' : '';
    s.height = rect ? rect.height + 'px' : '';
    s.display = 'block';
}

/** Stop; removing the source frees the hardware decoder (placement kept). playing: not paused first, where the video
 * plays (the load ends it all the same): the 2017 LG TV lets a playing pipeline go in ~0.3 s, 12 times of 14, but
 * takes a full second for one that was paused (half the time when paused in the same turn, every time once it has
 * rested paused 0.25 s; that second holds the page's thread). Measured 2026-11-25, tools/tv-bench/lab/
 * teardown_phase.mjs */
export function unloadVideo(video: HTMLVideoElement, playing?: boolean): void {
    if (!playing) {
        video.pause();
    }
    video.removeAttribute('src');
    video.load();
}

/** Stop and hide */
export function releaseVideo(video: HTMLVideoElement): void {
    unloadVideo(video);
    placeVideo(video, null);
    video.style.display = '';
}

/** A picture standing still again this soon after the last time is "again" */
var STILL_AGAIN_MS = 60 * 1000;

/** Detects a stalled picture: calls onStill once it has not moved for seconds
 * (the TV's player does not always resume after a gap in a stream, and the
 * sound stops too); again: it also stalled within the last minute (a reload did
 * not help). Counts only from 'playing' to the next pause or load, so loading
 * and pauses are not stalls, and its timer runs only then. Returns a function
 * that stops watching. */
export function watchStill(video: HTMLVideoElement, seconds: number, onStill: (again: boolean) => void): () => void {
    var last = -1;
    var still = 0;
    var timer = 0;
    var firedAt = 0;
    var disarm = function () {
        clearInterval(timer);
        timer = 0;
    };
    var arm = function () {
        disarm();
        still = 0;
        last = -1;
        timer = setInterval(function () {
            var t = video.currentTime;
            if (t !== last) {
                last = t;
                still = 0;
                return;
            }
            if (++still >= seconds) {
                disarm();
                var now = Date.now();
                var again = now - firedAt < STILL_AGAIN_MS;
                firedAt = now;
                onStill(again);
            }
        }, 1000) as unknown as number;
    };
    var events = ['pause', 'ended', 'loadstart'];
    video.addEventListener('playing', arm);
    for (var i = 0; i < events.length; i++) {
        video.addEventListener(events[i], disarm);
    }
    return function () {
        disarm();
        video.removeEventListener('playing', arm);
        for (var k = 0; k < events.length; k++) {
            video.removeEventListener(events[k], disarm);
        }
    };
}
