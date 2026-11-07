// Quality on Auto following the connection while a video plays: two stalls within STALLS_MS, or downloads slower than
// the playing format needs while the buffer runs low, step one quality down; CALM_MS without a stall and downloads fast
// enough for the next quality up with room to spare step one up again (the player keeps to Auto's ceiling, 4K). A
// quality the viewer chose, Highest available too, is never changed (the player does not ask then).

var STALLS_MS = 60000;
var STALLS = 2;
/** After a stall or a step, this long (ms) before a step up (and before another step down for slow downloads) */
var CALM_MS = 10000;
/** The recent video downloads read for the speed (their median), those of at least SPEED_BYTES (a smaller one, as the
 * first after a jump, is mostly the round trip) */
var SPEEDS = 3;
var SPEED_BYTES = 512 * 1024;
/** Slow: downloads under this share of the playing format's bitrate, with under LOW_S buffered ahead */
var SLOW = 1;
var LOW_S = 10;
/** Fast enough for the next quality up: this many times its bitrate, with at least HIGH_S buffered ahead */
var UP = 1.5;
var HIGH_S = 15;

export class AutoQuality {
    private stalls: number[] = [];
    private speeds: number[] = [];
    /** The last stall or step (0: none yet) */
    private calmFrom = 0;

    /** A stall at now (the buffer ran dry while playing) */
    stalled(now: number): void {
        this.stalls.push(now);
        this.calmFrom = now;
    }

    /** A video download done: bytes in ms */
    loaded(bytes: number, ms: number): void {
        if (ms > 0 && bytes >= SPEED_BYTES) {
            this.speeds.push(bytes * 8000 / ms);
            if (this.speeds.length > SPEEDS) {
                this.speeds.shift();
            }
        }
    }

    /** The step to take at now: -1 down, 1 up, 0 none. ahead: s buffered ahead of the playhead; bitrate: the playing
     * format's; up: the next quality up's (0: none) */
    step(now: number, ahead: number, bitrate: number, up: number): number {
        var from = now - STALLS_MS;
        this.stalls = this.stalls.filter(function (t) { return t > from; });
        var calm = now - this.calmFrom >= CALM_MS;
        var speed = this.speed();
        if (this.stalls.length >= STALLS || calm && speed > 0 && speed < bitrate * SLOW && ahead < LOW_S) {
            return -1;
        }
        return calm && up > 0 && speed >= up * UP && ahead >= HIGH_S ? 1 : 0;
    }

    /** A step was taken at now: the stalls and speeds before it no longer count */
    stepped(now: number): void {
        this.stalls = [];
        this.speeds = [];
        this.calmFrom = now;
    }

    /** A new video or a jump: nothing before counts, and no step for CALM_MS */
    reset(now: number): void {
        this.stalls = [];
        this.speeds = [];
        this.calmFrom = now;
    }

    /** The median of the recent downloads' speeds (bit/s; 0: none yet) */
    private speed(): number {
        if (!this.speeds.length) {
            return 0;
        }
        var sorted = this.speeds.slice().sort(function (a, b) { return a - b; });
        return sorted[sorted.length >> 1];
    }
}
