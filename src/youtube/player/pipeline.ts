// The video pipeline (a Media Source on the player's video, with one buffer for video and one
// for audio), kept from one video to the next: tearing one down blocks the app ~950 ms on the
// TV (VP9; ~270 ms for H.264). A stopping engine leaves its pipeline here (paused, emptied); the
// next engine takes it if its formats are of the same kinds (api/streams.ts kindOf), else a
// fresh one opens and replaces it. A pipeline that has played cannot take another video codec
// (the TV's Media Source allows one video buffer: "reached the limit of SourceBuffer objects"),
// so the player prefers the kept codec (api/streams.ts pickFormat). Not kept after a decoder
// failure; released when another player needs the TV's decoder or the app goes to the
// background (releasePipeline). One player video, so one pipeline.

import { unloadVideo } from '../../player/video.js';
import { kindOf } from '../api/streams.js';
import { note, ranges } from './play-log.js';

/** Fallback wait for a kept pipeline's seek to 0 to fire 'seeking' (it normally fires at once) */
var SEEK_SAID_MS = 500;
/** Poll interval for an updating buffer (one removed from its source mid-update fires no event) */
var SETTLED_POLL_MS = 250;
/** Where a kept pipeline's video already at 0 is moved (s; within its first frame): a seek to the current position
 * does not reach the TV's media pipeline, which then plays its stale data (e.g. a stopped preview's picture) at the
 * next video's start; a seek elsewhere flushes it */
export var OFF_START_S = 0.01;

export class Pipeline {
    buffers: SourceBuffer[] = [];
    /** Number of videos it has played */
    uses = 1;
    /** Tells the engine using it when buffer i (0 video, 1 audio) finishes updating */
    onUpdate: ((i: number) => void) | null = null;
    /** The duration the engine set (s; 0 none): the TV's media pipeline restores a stale duration of its own when the
     * first data goes into a kept pipeline, so it is set again (keepLength) */
    length = 0;

    constructor(public video: HTMLVideoElement, public source: MediaSource, public kinds: string[], public url: string) {}
}

/** The pipeline on the player's video (an engine's, or kept); a kept one is emptied first (if that fails it is dropped
 * and a fresh one opens) */
var current: Pipeline | null = null;
var kept = false;
var emptied: Promise<void> = Promise.resolve();
/** A kept one is being emptied, and Play was requested meanwhile (deferred until empty, else old data plays briefly) */
var emptying = false;
var playAsked = false;
/** Counters: emptyings (also bumped by a fresh pipeline or a release, which make an emptying moot) and pipeline
 * requests (also bumped by a release); the latest wins, earlier ones get nothing */
var emptyings = 0;
var asks = 0;

/** For inspection in DevTools (__bolli.pipes): pipelines opened, reused, spoilt (videos played, error), and the
 * current one */
export var pipelineStats = { fresh: 0, reused: 0, spoilt: [] as string[], now: function (): unknown {
    return current && { kept: kept, emptying: emptying, source: current.source.readyState, uses: current.uses, usable: usable(current),
        updating: current.buffers.map(function (b) { return b.updating; }) };
} };

/** The pipeline is still the video's own (nothing took its source away) and did not fail (also while kept) */
function usable(p: Pipeline): boolean {
    return p.source.readyState !== 'closed' && p.video.getAttribute('src') === p.url && !p.video.error;
}

/** The kept pipeline takes formats of these kinds */
function fits(kinds: string[]): boolean {
    return !!current && kept && usable(current) && kinds.join() === current.kinds.join();
}

/** The video kind the current pipeline takes ('' none: any kind starts equally fast) */
export function pictureKind(): string {
    return current && usable(current) ? current.kinds[0] : '';
}

/** A pipeline for mimes ([video, audio]) on video, at time 0 like a new one: the kept one if its buffers fit (emptied;
 * announced as a load, its metadata already in), else a fresh one once its Media Source opens; rejects if Media Source
 * refuses the mimes */
export function openPipeline(video: HTMLVideoElement, mimes: string[]): Promise<Pipeline> {
    var ask = ++asks;
    if (!fits(mimes.map(kindOf))) {
        return fresh(video, mimes);
    }
    // Stays kept until handed over: if the engine stops and asks again meanwhile, the later request gets it
    var pipe = current as Pipeline;
    return emptied.then(function () {
        if (ask !== asks) {
            return Promise.reject('stale');
        }
        if (current !== pipe || !kept || !usable(pipe)) {
            return fresh(video, mimes);
        }
        kept = false;
        pipe.uses++;
        pipelineStats.reused++;
        note('pipeline reused', held(pipe) + ' at ' + video.currentTime.toFixed(2));
        // The events a new pipeline's load fires: the player's loading sign continues from there
        video.dispatchEvent(new Event('loadstart'));
        video.dispatchEvent(new Event('loadedmetadata'));
        return pipe;
    });
}

/** A new pipeline on video, once its Media Source opens */
function fresh(video: HTMLVideoElement, mimes: string[]): Promise<Pipeline> {
    var source = new MediaSource();
    var url = URL.createObjectURL(source);
    var pipe = current = new Pipeline(video, source, mimes.map(kindOf), url);
    kept = false;
    // An emptying under way is moot: its source is replaced now
    emptyings++;
    emptying = playAsked = false;
    pipelineStats.fresh++;
    note('pipeline fresh');
    return new Promise<Pipeline>(function (resolve, reject) {
        var opened = function (): void {
            // Once: an append or a remove after the end opens it again
            source.removeEventListener('sourceopen', opened);
            URL.revokeObjectURL(url);
            try {
                pipe.buffers = mimes.map(function (m) { return source.addSourceBuffer(m); });
            } catch (e) {
                reject('media');
                return;
            }
            // Its own listeners (the buffers outlive the engines): passed on to the engine using it
            pipe.buffers.forEach(function (sb, i) {
                sb.addEventListener('updateend', function () {
                    keepLength(pipe);
                    if (pipe.onUpdate) {
                        pipe.onUpdate(i);
                    }
                });
            });
            resolve(pipe);
        };
        source.addEventListener('sourceopen', opened);
        // The previous pipeline goes as its source is replaced
        video.src = url;
    });
}

/** Sets the video's duration (s) for the engine playing on pipe, and keeps it (throws as MediaSource.duration does) */
export function setLength(pipe: Pipeline, length: number): void {
    pipe.length = length;
    pipe.source.duration = length;
}

/** Restores the set duration if the TV changed it (not while a buffer updates: on the next updateend) */
function keepLength(pipe: Pipeline): void {
    var source = pipe.source;
    if (!pipe.length || source.readyState !== 'open' || Math.abs(source.duration - pipe.length) < 0.5 ||
        pipe.buffers.some(function (sb) { return sb.updating; })) {
        return;
    }
    try {
        source.duration = pipe.length;
    } catch (e) {
        // Retried on the next updateend
    }
}

/** Keeps a stopped engine's pipeline for the next one: paused, buffers emptied (none yet: only pauses the video; an
 * engine stopped while its pipeline opens keeps it once open) */
export function keepPipeline(video: HTMLVideoElement, pipe: Pipeline | null): void {
    // None yet, or it failed: nothing else plays on the video
    if (!pipe || !current) {
        playAsked = false;
        video.pause();
        return;
    }
    // Not one replaced since, or no longer usable
    if (pipe !== current || !usable(pipe)) {
        return;
    }
    video.pause();
    note('pipeline kept', held(pipe) + ' at ' + video.currentTime.toFixed(2));
    pipe.onUpdate = null;
    pipe.length = 0;
    kept = true;
    emptying = true;
    playAsked = false;
    var mine = ++emptyings;
    emptied = Promise.all(pipe.buffers.map(function (sb) { return empty(pipe, sb); })).then(function () {
        return mine === emptyings && current === pipe ? toStart(video) : undefined;
    }, function () {
        if (current === pipe) {
            current = null;
        }
    }).then(function () {
        if (mine === emptyings) {
            note('pipeline emptied', current === pipe ? held(pipe) : 'let go');
            emptying = false;
            if (playAsked) {
                playAsked = false;
                video.play();
            }
        }
    });
}

/** Seeks the video back to 0 like a new pipeline (already at 0: to OFF_START_S) and resolves once 'seeking' fires, so
 * the next engine does not take that seek for its own */
function toStart(video: HTMLVideoElement): Promise<void> {
    return new Promise<void>(function (resolve) {
        if (video.readyState < 1) {
            resolve(undefined);
            return;
        }
        var timer = 0;
        var done = function (): void {
            video.removeEventListener('seeking', done);
            clearTimeout(timer);
            resolve(undefined);
        };
        video.addEventListener('seeking', done);
        timer = setTimeout(done, SEEK_SAID_MS) as unknown as number;
        video.currentTime = video.currentTime === 0 ? OFF_START_S : 0;
    });
}

/** Empties a buffer: aborts an append in progress (a remove cannot be aborted), removes everything (an ended source
 * reopens), resets its parser, append window and offset */
function empty(pipe: Pipeline, sb: SourceBuffer): Promise<void> {
    if (sb.updating && pipe.source.readyState === 'open') {
        try {
            sb.abort();
        } catch (e) {
            // A remove: waited for
        }
    }
    return settled(sb).then(function () {
        var b = sb.buffered;
        if (b.length) {
            sb.remove(0, b.end(b.length - 1) + 1);
        }
        return settled(sb);
    }).then(function () {
        if (pipe.source.readyState === 'open') {
            sb.abort();
        }
        sb.appendWindowStart = 0;
        sb.timestampOffset = 0;
    });
}

/** Resolves once sb is not updating (ignores a late updateend from an abort during a remove; polls for a buffer removed
 * from its source mid-update, which fires nothing) */
function settled(sb: SourceBuffer): Promise<void> {
    return new Promise<void>(function (resolve) {
        if (!sb.updating) {
            resolve(undefined);
            return;
        }
        var poll = 0;
        var done = function (): void {
            if (sb.updating) {
                return;
            }
            sb.removeEventListener('updateend', done);
            clearInterval(poll);
            resolve(undefined);
        };
        sb.addEventListener('updateend', done);
        poll = setInterval(done, SETTLED_POLL_MS) as unknown as number;
    });
}

/** What pipe's buffers hold (video / audio), for the log */
function held(pipe: Pipeline): string {
    try {
        return pipe.buffers.map(function (sb) { return ranges(sb.buffered); }).join(' / ');
    } catch (e) {
        // A buffer removed from its source
        return '?';
    }
}

/** Plays the player's video now, or once the kept pipeline is emptied (else the previous video plays briefly) */
export function playVideo(video: HTMLVideoElement): void {
    if (emptying) {
        playAsked = true;
    } else {
        video.play();
    }
}

/** Pauses the player's video (and cancels a Play waiting for the emptying) */
export function pauseVideo(video: HTMLVideoElement): void {
    playAsked = false;
    video.pause();
}

/** Wraps an engine's onFail: after a decoder failure ('media') the pipeline is not kept (the next video gets a fresh one) */
export function spoilingFail(onFail: (why: string) => void): (why: string) => void {
    return function (why) {
        if (why === 'media' && current) {
            pipelineStats.spoilt.push(current.uses + ' videos, error ' + (current.video.error ? current.video.error.code : '-'));
            current.onUpdate = null;
            current = null;
        }
        onFail(why);
    };
}

/** Tears down the pipeline on video now: YouTube's player needs the TV's decoder, or the app goes to the background */
export function releasePipeline(video: HTMLVideoElement): void {
    asks++;
    emptyings++;
    emptying = playAsked = false;
    if (current) {
        current.onUpdate = null;
        current = null;
    } else if (!video.getAttribute('src')) {
        return;
    }
    unloadVideo(video);
}
