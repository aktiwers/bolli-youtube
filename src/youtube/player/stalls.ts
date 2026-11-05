// A playback that keeps stalling, as SmartTube's buffering detector tells it: the picture standing while it should
// play for STALL_TOTAL_MS in all within the last STALL_WINDOW_MS calls for a reload at the same spot. Short stalls a
// network shrugs off do not.

var STALL_WINDOW_MS = 60000;
var STALL_TOTAL_MS = 20000;

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
