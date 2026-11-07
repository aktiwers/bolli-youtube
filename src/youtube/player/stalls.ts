// A playback that keeps stalling, as SmartTube's buffering detector tells it: the picture standing while it should
// play for STALL_TOTAL_MS in all within the last STALL_WINDOW_MS calls for a reload at the same spot. Short stalls a
// network shrugs off do not. A picture frozen with media buffered ahead of it (a decoder that hangs) is nudged on
// sooner, as Shaka's and hls.js's stall detectors do (Freezes).

var STALL_WINDOW_MS = 60000;
var STALL_TOTAL_MS = 20000;
/** Frozen this long (ms) calls for a nudge; NUDGES within STALL_WINDOW_MS, and the next one a reload (a nudge costs
 * this TV ~2 s of standing picture: a seek decodes from the keyframe before it) */
var FROZEN_MS = 3000;
var NUDGES = 3;

export class Stalls {
    /** Stalls that ended within the window ([start, end]), and when the current one began (0: playing) */
    private past: number[][] = [];
    private since = 0;

    /** The playback at now, stalled or playing; true when it has stalled STALL_TOTAL_MS within the window (then counted
     * anew) */
    note(stalled: boolean, now: number): boolean {
        if (stalled && !this.since) {
            this.since = now;
        } else if (!stalled && this.since) {
            this.past.push([this.since, now]);
            this.since = 0;
        }
        var from = now - STALL_WINDOW_MS;
        this.past = this.past.filter(function (p) { return p[1] > from; });
        var total = this.since ? now - Math.max(this.since, from) : 0;
        for (var i = 0; i < this.past.length; i++) {
            total += this.past[i][1] - Math.max(this.past[i][0], from);
        }
        if (total >= STALL_TOTAL_MS) {
            this.reset();
            return true;
        }
        return false;
    }

    reset(): void {
        this.past = [];
        this.since = 0;
    }
}

/** A picture frozen while it should play with media buffered ahead of it: FROZEN_MS of it calls for a nudge (the playhead
 * moved on a little), NUDGES of them within STALL_WINDOW_MS, then a reload */
export class Freezes {
    private since = 0;
    private nudged: number[] = [];

    /** The playback at now, frozen or not: 'nudge', 'reload' (then counted anew) or '' */
    note(frozen: boolean, now: number): string {
        if (!frozen) {
            this.since = 0;
            return '';
        }
        if (!this.since) {
            this.since = now;
        }
        if (now - this.since < FROZEN_MS) {
            return '';
        }
        this.since = 0;
        var from = now - STALL_WINDOW_MS;
        this.nudged = this.nudged.filter(function (t) { return t > from; });
        if (this.nudged.length >= NUDGES) {
            this.reset();
            return 'reload';
        }
        this.nudged.push(now);
        return 'nudge';
    }

    reset(): void {
        this.since = 0;
        this.nudged = [];
    }
}
