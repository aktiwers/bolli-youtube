// The sidebar's own icon sets (Settings › Theme › Sidebar icons): drawings for the rail's entries in place of the
// app's icons there. Of their own: Elements, a tile with two letters of the entry's name (in the app's language) and
// its number, as the periodic table; 3D, small objects of shaded boxes (their sides from the one colour of the text);
// Pixel, 12 x 12 pixel art. The others (App tiles, Glass, Fruit, VHS) the system's of the same name (ui/icons.ts markup).
// Each made once per entry as markup (ui/icons.ts draws and keeps it). What one looks at as big as the app's icons'
// shapes: Elements' letters as an icon is, its frame round it, past the icon's box (as Bubble's badge); the pixel art
// the whole box, the 3D objects (flat, wide) a little past it.

import { pixelRects, svg } from './icon-svg.js';

/** The sets, by value (Sidebar icons' choices; '' the app's icons, as Icons draws them) */
export var RAIL_SETS = ['elements', 'tiles', 'iso', 'pixel', 'glass', 'soft', 'solid', 'vhs'];

/** The sets drawn by the sidebar's own drawings (railMarkup); the others are the system's styles of the same name */
export var OWN_RAIL_SETS = ['elements', 'iso', 'pixel'];

/** An entry's drawing in a set of its own (OWN_RAIL_SETS): its markup ('' none: the app's icon); name: the icon's name
 * (the entry's), label and n: its name and place (Elements' letters and number) */
export function railMarkup(set: string, name: string, label: string, n: number): string {
    switch (set) {
        case 'elements': return element(label, n);
        case 'iso': return ISO[name] || name === 'search' ? iso3d(name) : '';
        case 'pixel': return PIX[name] ? pixel(PIX[name]) : '';
        default: return '';
    }
}

/** Elements: two letters (the name's first, then its next that makes them no other entry's: taken, each entry's
 * reserved in the rail's order when it is made: ui/icons.ts railIcon) and the number */
var taken: { [letters: string]: string } = {};

export function elementLetters(label: string): string {
    var first = label.charAt(0).toUpperCase();
    var rest = label.slice(1).replace(/[^A-Za-zÀ-ɏͰ-ϿЀ-ӿ]/g, '');
    for (var i = 0; i < rest.length; i++) {
        var two = first + rest.charAt(i).toLowerCase();
        if (!taken[two] || taken[two] === label) {
            taken[two] = label;
            return two;
        }
    }
    return label.slice(0, 2);
}

/** Text put in markup (a name may come from YouTube) */
function escaped(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

function element(label: string, n: number): string {
    return svg('<rect x="-3" y="-3" width="30" height="30" rx="5" fill="none" stroke="currentColor" stroke-width="1.4"/>' +
        '<text x="-0.4" y="3.4" font-size="4.6" font-weight="500" fill="currentColor">' + n + '</text>' +
        '<text x="12" y="17.6" font-size="14.5" font-weight="900" text-anchor="middle" fill="currentColor">' + escaped(elementLetters(label)) + '</text>');
}

/** 3D: an object's parts: a box (x, y, z, width, depth, height: its top, front and right sides shaded), a face of four or
 * three points (its shade, its order), or a disc on a front face (x, y, z, r) */
interface Part {
    box?: number[];
    face?: number[][];
    disc?: number[];
    shade?: number;
    order?: number;
}

var ISO: { [name: string]: Part[] } = {
    home: [{ box: [0, 0, 0, 8, 8, 5] }, { box: [5.5, 1, 6, 1.4, 1.4, 3.2] },
        { face: [[0, 8, 5], [8, 8, 5], [8, 4, 9], [0, 4, 9]], shade: 0.85, order: 30 }, { face: [[8, 0, 5], [8, 8, 5], [8, 4, 9]], shade: 0.45, order: 30 }],
    // (Shorts: a phone-like card standing on edge, its play triangle on the front)
    shorts: [{ box: [0, 0, 0, 6, 2, 10] }, { face: [[2, 2, 3.5], [2, 2, 6.5], [4.6, 2, 5]], shade: 0.2, order: 20 }],
    subscriptions: [{ box: [0, 0, 0, 10, 3, 7] }, { face: [[1, 3, 1], [9, 3, 1], [9, 3, 6], [1, 3, 6]], shade: 0.25, order: 20 },
        { face: [[4, 3, 2], [4, 3, 5], [6.6, 3, 3.5]], shade: 1, order: 21 }, { box: [3.5, 0.8, 7, 3, 1.4, 0.6] }],
    library: [{ box: [0, 0, 0, 9, 6, 1.7] }, { box: [0.8, 0.3, 1.7, 7.4, 5.4, 1.7] }, { box: [0.2, 0.6, 3.4, 8.2, 5, 1.7] }],
    gaming: [{ box: [0, 0, 0, 11, 6, 2.2] }, { box: [1.5, 2.6, 2.2, 3, 0.9, 0.7] }, { box: [2.55, 1.6, 2.2, 0.9, 2.9, 0.7] },
        { box: [7.6, 1.5, 2.2, 1.2, 1.2, 0.9] }, { box: [8.6, 3.1, 2.2, 1.2, 1.2, 0.9] }],
    podcasts: [{ box: [1.5, 1.5, 0, 5, 5, 1] }, { box: [3.6, 3.6, 1, 0.8, 0.8, 4] }, { box: [2.6, 2.6, 5, 2.8, 2.8, 5] }],
    music: [{ box: [0, 0, 0, 7, 6, 10] }, { disc: [3.5, 6, 6.6, 2.2], shade: 0.2, order: 20 }, { disc: [3.5, 6, 6.6, 0.8], shade: 1, order: 21 },
        { disc: [3.5, 6, 2.3, 1.1], shade: 0.2, order: 20 }],
    movies: [{ box: [0, 0, 0, 10, 2, 6] }, { box: [0, 0, 6.6, 10, 2, 1.6] },
        { face: [[1, 2, 6.6], [2.6, 2, 6.6], [3.6, 2, 8.2], [2, 2, 8.2]], shade: 1, order: 40 },
        { face: [[5, 2, 6.6], [6.6, 2, 6.6], [7.6, 2, 8.2], [6, 2, 8.2]], shade: 1, order: 40 },
        { face: [[1, 2, 1.5], [9, 2, 1.5], [9, 2, 4.5], [1, 2, 4.5]], shade: 0.25, order: 20 }],
    sports: [{ box: [3, 3, 0, 4, 4, 1.2] }, { box: [4.5, 4.5, 1.2, 1, 1, 2.6] }, { box: [1.8, 1.8, 3.8, 6.4, 6.4, 4.2] },
        { face: [[1.8, 8.2, 7.2], [-0.6, 8.2, 7.2], [-0.6, 8.2, 5], [1.8, 8.2, 5]], shade: 0.6, order: 30 }],
    settings: [{ box: [2, 2, 0, 6, 6, 2.6] }, { box: [4, -0.6, 0, 2, 2.6, 2.6] }, { box: [4, 7.4, 0, 2, 2.6, 2.6] }, { box: [-0.6, 4, 0, 2.6, 2, 2.6] },
        { box: [7.4, 4, 0, 2.6, 2, 2.6] }, { face: [[3.8, 3.8, 2.61], [6.2, 3.8, 2.61], [6.2, 6.2, 2.61], [3.8, 6.2, 2.61]], shade: 0.2, order: 50 }]
};

/** An object drawn from its parts: each point seen from the front-right above (isometric), the whole fitted to the
 * box, the parts drawn back to front */
function iso3d(name: string): string {
    if (name === 'search') {
        return svg('<circle cx="9.5" cy="9.5" r="7.6" fill="currentColor" fill-opacity=".18" stroke="currentColor" stroke-width="2.6"/>' +
            '<ellipse cx="7.4" cy="7" rx="2.6" ry="1.5" transform="rotate(-35 7.4 7)" fill="currentColor" fill-opacity=".55"/>' +
            '<polygon points="14.6,15.9 16.4,14.1 23,20.7 21.2,22.5" fill="currentColor"/>' +
            '<polygon points="14.6,15.9 21.2,22.5 20,23.2 13.6,16.8" fill="currentColor" fill-opacity=".55"/>');
    }
    var faces: { points: number[][]; shade: number; order: number }[] = [];
    var seen = function (p: number[]): number[] { return [(p[0] - p[1]) * 0.866, (p[0] + p[1]) * 0.5 - p[2]]; };
    ISO[name].forEach(function (part) {
        if (part.box) {
            var b = part.box;
            var x = b[0], y = b[1], z = b[2], w = b[3], d = b[4], hh = b[5], at = x + y + z;
            faces.push({ points: [[x, y + d, z], [x + w, y + d, z], [x + w, y + d, z + hh], [x, y + d, z + hh]], shade: 0.6, order: at });
            faces.push({ points: [[x + w, y, z], [x + w, y + d, z], [x + w, y + d, z + hh], [x + w, y, z + hh]], shade: 0.36, order: at });
            faces.push({ points: [[x, y, z + hh], [x + w, y, z + hh], [x + w, y + d, z + hh], [x, y + d, z + hh]], shade: 1, order: at + 0.01 });
        } else if (part.disc) {
            var c = part.disc;
            var ring: number[][] = [];
            for (var t = 0; t < 24; t++) {
                var a = t / 24 * Math.PI * 2;
                ring.push([c[0] + c[3] * Math.cos(a), c[1], c[2] + c[3] * Math.sin(a)]);
            }
            faces.push({ points: ring, shade: part.shade || 1, order: part.order || 0 });
        } else if (part.face) {
            faces.push({ points: part.face, shade: part.shade || 1, order: part.order || 0 });
        }
    });
    var flat = faces.map(function (f) { return f.points.map(seen); });
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    flat.forEach(function (f) {
        f.forEach(function (p) {
            minX = Math.min(minX, p[0]);
            minY = Math.min(minY, p[1]);
            maxX = Math.max(maxX, p[0]);
            maxY = Math.max(maxY, p[1]);
        });
    });
    // (flat and wide, they reach a little past the box to look as big as an icon's shape)
    var s = 28 / Math.max(maxX - minX, maxY - minY);
    var ox = 12 - (minX + maxX) / 2 * s;
    var oy = 12 - (minY + maxY) / 2 * s;
    var drawn = faces.map(function (f, i) { return { f: f, p: flat[i] }; });
    drawn.sort(function (a, b) { return a.f.order - b.f.order; });
    return svg(drawn.map(function (one) {
        return '<polygon points="' + one.p.map(function (q) { return (q[0] * s + ox).toFixed(2) + ',' + (q[1] * s + oy).toFixed(2); }).join(' ') +
            '" fill="currentColor" fill-opacity="' + one.f.shade + '" stroke="currentColor" stroke-opacity=".9" stroke-width=".25" stroke-linejoin="round"/>';
    }).join(''));
}

/** Pixel: 12 x 12, # a pixel */
var PIX: { [name: string]: string[] } = {
    search: ['..#####.....', '.##...##....', '##.....##...', '#.......#...', '#.......#...', '#.......#...', '##.....##...', '.##...##....', '..#######...',
        '.......###..', '........###.', '.........###'],
    home: ['.....##.....', '....####....', '...######...', '..########..', '.##########.', '############', '.##########.', '.####..####.', '.####..####.',
        '.####..####.', '.####..####.', '............'],
    shorts: ['.....####...', '....######..', '...#######..', '..########..', '..###.####..', '..###..###..', '..###...##..', '..###..###..',
        '..###.###...', '..#######...', '..######....', '...####.....'],
    subscriptions: ['..#......#..', '...#....#...', '....#..#....', '############', '#..........#', '#...##.....#', '#...###....#', '#...####...#',
        '#...###....#', '#...##.....#', '#..........#', '############'],
    library: ['............', '##.##.##....', '##.##.##..##', '##.##.##.###', '##.##.##.##.', '##.##.##.##.', '##.##.##.##.', '##.##.##.##.',
        '##.##.##.##.', '##.##.##.##.', '##.##.##.##.', '############'],
    gaming: ['............', '............', '.##########.', '############', '##.######.##', '#...####.#.#', '##.######.##', '############',
        '####....####', '.##......##.', '............', '............'],
    podcasts: ['....####....', '...######...', '...##..##...', '...######...', '...##..##...', '...######...', '.#.######.#.', '.#..####..#.',
        '..#......#..', '...######...', '.....##.....', '...######...'],
    music: ['....########', '....########', '....#......#', '....#......#', '....#......#', '....#......#', '....#......#', '.####...####',
        '#####..#####', '#####..#####', '.###....###.', '............'],
    movies: ['............', '############', '#..##..##..#', '############', '............', '############', '#..##..##..#', '############',
        '#..........#', '#..........#', '#..........#', '############'],
    sports: ['############', '#.########.#', '#.########.#', '.#.######.#.', '...######...', '....####....', '.....##.....', '.....##.....',
        '....####....', '...######...', '...######...', '............'],
    settings: ['.....##.....', '..#..##..#..', '.##########.', '..###..###..', '.###....###.', '####....####', '####....####', '.###....###.',
        '..###..###..', '.##########.', '..#..##..#..', '.....##.....']
};

/** Pixel art from its rows (12 x 12, the sidebar's: ui/icon-svg.ts) */
function pixel(rows: string[]): string {
    return pixelRects(rows.join(''), rows.length);
}
