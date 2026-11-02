// The most replayed graph over a progress bar (api/replays.ts), drawn as YouTube draws it: each part's score as a
// point on a 1000 x 100 canvas spanning the bar, joined by a smooth curve (a cardinal spline, tension 0.2, so a sharp
// peak dips a little on either side as on YouTube) and filled down to the bar. The SVG stretches to the bar's width.

import { Replays } from '../api/replays.js';

var SVG = 'http://www.w3.org/2000/svg';
var TENSION = 0.2;

export class ReplayGraph {
    private el: Element;
    private path: Element;

    /** Over bar (a positioned element) */
    constructor(bar: HTMLElement) {
        this.el = document.createElementNS(SVG, 'svg');
        this.el.setAttribute('class', 'by-replays');
        this.el.setAttribute('viewBox', '0 0 1000 100');
        this.el.setAttribute('preserveAspectRatio', 'none');
        this.path = this.el.appendChild(document.createElementNS(SVG, 'path'));
        bar.appendChild(this.el);
    }

    /** The video's graph (null: none) */
    set(replays: Replays | null): void {
        this.path.setAttribute('d', replays ? replayPath(replays) : '');
    }
}

/** The graph's outline: from the bar's start along the scores' points (at each part's middle, a score of 0 at the
 * floor's height) to its end */
export function replayPath(replays: Replays): string {
    var scores = replays.scores;
    var step = 1000 / scores.length;
    var points: number[][] = [[0, 100]];
    for (var i = 0; i < scores.length; i++) {
        points.push([(i + 0.5) * step, 100 - (replays.floor + (1 - replays.floor) * scores[i]) * 100]);
    }
    points.push([1000, 100]);
    var d = 'M0,100';
    for (var k = 0; k + 1 < points.length; k++) {
        var before = points[Math.max(0, k - 1)];
        var from = points[k];
        var to = points[k + 1];
        var after = points[Math.min(points.length - 1, k + 2)];
        d += 'C' + xy(from[0] + (to[0] - before[0]) * TENSION, from[1] + (to[1] - before[1]) * TENSION) +
            ' ' + xy(to[0] - (after[0] - from[0]) * TENSION, to[1] - (after[1] - from[1]) * TENSION) + ' ' + xy(to[0], to[1]);
    }
    return d + 'Z';
}

function xy(x: number, y: number): string {
    return Math.round(x * 10) / 10 + ',' + Math.round(y * 10) / 10;
}
