// Fruit soft and Fruit solid (Settings › Theme › Icons, both tabs): a set of icons of the app's own, drawn for it, every
// one of the app's icons: one even rounded stroke, soft corners, built of circles and rounded rectangles, all of one
// weight; solid: their shapes filled. Active states (liked, disliked, saved) filled in both. The meanings are YouTube's
// (a thumb for like), the shapes new. Each part: 's' a shape (outlined, or filled when solid), 'l' a line, 'f' always
// filled; inside a shape: 'c' a line, 'x' a mark (a dot, a sign), each cut out of the filled shape when solid (an SVG
// mask, each copy of the icon given its own id by ui/icons.ts copyKept); an optional transform.

import { svg } from './icon-svg.js';

function gear(): string {
  var d = '', teeth = 8, outer = 8.6, inner = 6.6;
  for (var i = 0; i < teeth * 2; i++) {
    var r = i % 2 ? inner : outer, a0 = (i / (teeth * 2)) * Math.PI * 2 - Math.PI / teeth / 2, a1 = ((i + 1) / (teeth * 2)) * Math.PI * 2 - Math.PI / teeth / 2;
    var p0 = [12 + r * Math.cos(a0 + 0.08), 12 + r * Math.sin(a0 + 0.08)], p1 = [12 + r * Math.cos(a1 - 0.08), 12 + r * Math.sin(a1 - 0.08)];
    d += (i ? ' L' : 'M') + p0[0].toFixed(2) + ' ' + p0[1].toFixed(2) + ' L' + p1[0].toFixed(2) + ' ' + p1[1].toFixed(2);
  }
  return d + ' Z';
}
var circle = function (cx: number, cy: number, r: number): string { return 'M' + (cx - r) + ' ' + cy + ' a' + r + ' ' + r + ' 0 1 0 ' + (2 * r) + ' 0 a' + r + ' ' + r + ' 0 1 0 ' + (-2 * r) + ' 0 Z'; };
var rrect = function (x: number, y: number, w: number, h: number, r: number): string { return 'M' + (x + r) + ' ' + y + ' H' + (x + w - r) + ' a' + r + ' ' + r + ' 0 0 1 ' + r + ' ' + r + ' V' + (y + h - r) + ' a' + r + ' ' + r + ' 0 0 1 ' + (-r) + ' ' + r + ' H' + (x + r) + ' a' + r + ' ' + r + ' 0 0 1 ' + (-r) + ' ' + (-r) + ' V' + (y + r) + ' a' + r + ' ' + r + ' 0 0 1 ' + r + ' ' + (-r) + ' Z'; };
var thumb = 'M8 10.5 L11.6 4.6 a1.8 1.8 0 0 1 3.3 1.2 L14.3 9.5 H18.8 a1.9 1.9 0 0 1 1.9 2.3 L19.3 18 A2 2 0 0 1 17.3 19.5 H8 Z';
var SOFT: { [name: string]: string[][] } = {
  search: [['s', circle(10.5, 10.5, 6)], ['l', 'M15 15 L20.5 20.5']],
  home: [['s', 'M4 10.5 L12 4 L20 10.5 V19 a1.5 1.5 0 0 1 -1.5 1.5 H5.5 A1.5 1.5 0 0 1 4 19 Z'], ['c', 'M10 20.5 V15.5 H14 V20.5']],
  subscriptions: [['s', rrect(4, 8.5, 16, 12, 2.5)], ['l', 'M6.5 5.5 H17.5'], ['x', 'M10.5 11.8 L14.6 14.5 L10.5 17.2 Z']],
  library: [['s', rrect(4, 4, 4.6, 16.5, 1.4)], ['s', rrect(10, 4, 4.6, 16.5, 1.4)], ['s', rrect(16, 5, 4, 15.2, 1.4), 'rotate(-12 18 12.5)']],
  gaming: [['s', 'M7 8 H17 a4.5 4.5 0 0 1 4.3 5.8 L20.3 17.1 a2.6 2.6 0 0 1 -4.4 1 L14.5 16.5 H9.5 L8.1 18.1 a2.6 2.6 0 0 1 -4.4 -1 L2.7 13.8 A4.5 4.5 0 0 1 7 8 Z'],
    ['c', 'M8 10.8 V14.2 M6.3 12.5 H9.7'], ['x', circle(15.4, 11.6, 0.95)], ['x', circle(17.3, 13.6, 0.95)]],
  podcasts: [['s', circle(12, 9.5, 2.2)], ['l', 'M8.3 13 a5 5 0 1 1 7.4 0'], ['l', 'M5.9 15.6 a8.6 8.6 0 1 1 12.2 0'], ['l', 'M12 12.6 V20.5']],
  music: [['l', 'M9.2 17.5 V6.3 L19 4.3 V15.5'], ['s', circle(7, 17.5, 2.3)], ['s', circle(16.8, 15.5, 2.3)]],
  movies: [['s', rrect(4, 9.5, 16, 11, 2)], ['l', 'M4.4 9.5 L4.1 7.2 a1.5 1.5 0 0 1 1.3 -1.7 L18.3 3.9 a1.5 1.5 0 0 1 1.7 1.3 L20.2 7.3 Z'], ['l', 'M8.3 5.1 L9.7 8.3 M13 4.5 L14.4 7.7']],
  sports: [['s', 'M7 4.5 H17 V10 a5 5 0 0 1 -10 0 Z'], ['l', 'M7 6.5 H4.6 V8 a3 3 0 0 0 3 3 M17 6.5 H19.4 V8 a3 3 0 0 1 -3 3 M12 15 V18.6 M8.5 20.2 H15.5']],
  settings: [['s', gear()], ['c', circle(12, 12, 2.8)]],
  play: [['s', 'M8 5.5 L18.5 12 L8 18.5 Z']],
  pause: [['s', rrect(6.5, 5, 3.8, 14, 1.2)], ['s', rrect(13.7, 5, 3.8, 14, 1.2)]],
  previous: [['s', 'M17.5 6 L9.5 12 L17.5 18 Z'], ['l', 'M6.5 6 V18']],
  next: [['s', 'M6.5 6 L14.5 12 L6.5 18 Z'], ['l', 'M17.5 6 V18']],
  like: [['s', thumb], ['s', rrect(3.5, 10.5, 3, 9, 1)]],
  liked: [['f', thumb], ['f', rrect(3.5, 10.5, 3, 9, 1)]],
  dislike: [['s', thumb, 'rotate(180 12 12)'], ['s', rrect(3.5, 10.5, 3, 9, 1), 'rotate(180 12 12)']],
  disliked: [['f', thumb, 'rotate(180 12 12)'], ['f', rrect(3.5, 10.5, 3, 9, 1), 'rotate(180 12 12)']],
  save: [['s', 'M6.5 4.5 H17.5 V20 L12 16.2 L6.5 20 Z']],
  saved: [['f', 'M6.5 4.5 H17.5 V20 L12 16.2 L6.5 20 Z']],
  bookmark: [['s', 'M6.5 4.5 H17.5 V20 L12 16.2 L6.5 20 Z']],
  comments: [['s', 'M6.5 4.5 H17.5 A2 2 0 0 1 19.5 6.5 V14.5 A2 2 0 0 1 17.5 16.5 H11 L7 20 V16.5 H6.5 A2 2 0 0 1 4.5 14.5 V6.5 A2 2 0 0 1 6.5 4.5 Z']],
  subtitles: [['s', rrect(3.5, 5.5, 17, 13, 2.5)], ['c', 'M7 14.5 H11 M13.5 14.5 H17 M7 11 H9 M11.5 11 H17']],
  volume: [['s', 'M4.5 9.5 H7.5 L12 5.5 V18.5 L7.5 14.5 H4.5 Z'], ['l', 'M15 9 a4 4 0 0 1 0 6 M17.5 6.5 a7.5 7.5 0 0 1 0 11']],
  volumeoff: [['s', 'M4.5 9.5 H7.5 L12 5.5 V18.5 L7.5 14.5 H4.5 Z'], ['l', 'M15.5 9.5 L20.5 14.5 M20.5 9.5 L15.5 14.5']],
  bell: [['s', 'M6.5 16.5 V11 a5.5 5.5 0 0 1 11 0 V16.5 L19 18 H5 Z'], ['l', 'M10 20.5 H14']],
  playlist: [['l', 'M4.5 7 H15.5 M4.5 11.5 H15.5 M4.5 16 H10.5'], ['s', 'M14.5 14 L19.5 17 L14.5 20 Z']],
  list: [['f', circle(5.5, 7, 1)], ['f', circle(5.5, 12, 1)], ['f', circle(5.5, 17, 1)], ['l', 'M9 7 H19 M9 12 H19 M9 17 H19']],
  shuffle: [['l', 'M4 7.5 H7 C11 7.5 13 16.5 17 16.5 H20 M4 16.5 H7 C11 16.5 13 7.5 17 7.5 H20 M17.5 5 L20 7.5 L17.5 10 M17.5 14 L20 16.5 L17.5 19']],
  loop: [['l', 'M5 11 V9.5 a3 3 0 0 1 3 -3 H19 M16.5 4 L19 6.5 L16.5 9 M19 13 V14.5 a3 3 0 0 1 -3 3 H5 M7.5 20 L5 17.5 L7.5 15']],
  back: [['l', 'M19.5 12 H5 M11 6 L5 12 L11 18']],
  mic: [['s', rrect(9, 3.5, 6, 11, 3)], ['l', 'M6 11.5 a6 6 0 0 0 12 0 M12 17.5 V20.5']],
  history: [['l', 'M4.6 12 a7.5 7.5 0 1 0 2.2 -5.3 M4 5.5 V9.5 H8 M12 8 V12.3 L15 14.3']],
  check: [['l', 'M5 12.5 L9.5 17 L19 7']],
  add: [['l', 'M12 5 V19 M5 12 H19']],
  person: [['s', circle(12, 8.5, 3.5)], ['s', 'M5 19.5 C5 15.9 8.1 13.5 12 13.5 S19 15.9 19 19.5 Z']],
  info: [['s', circle(12, 12, 8.5)], ['c', 'M12 11 V16.5'], ['x', circle(12, 7.9, 1.05)]],
  lock: [['s', rrect(5.5, 10.5, 13, 10, 2.5)], ['l', 'M8.5 10.5 V8 a3.5 3.5 0 0 1 7 0 V10.5']],
  keyboard: [['s', rrect(3, 6.5, 18, 11, 2.5)], ['x', circle(7, 10, 0.85)], ['x', circle(10, 10, 0.85)], ['x', circle(13, 10, 0.85)], ['x', circle(16.5, 10, 0.85)], ['c', 'M9 14.2 H15']],
  backspace: [['s', 'M9 5.5 H19 a1.5 1.5 0 0 1 1.5 1.5 V17 a1.5 1.5 0 0 1 -1.5 1.5 H9 L3.5 12 Z'], ['c', 'M12 9.5 L17 14.5 M17 9.5 L12 14.5']],
  language: [['s', circle(12, 12, 8.5)], ['c', 'M3.5 12 H20.5 M12 3.5 C8 7 8 17 12 20.5 M12 3.5 C16 7 16 17 12 20.5']],
  delete: [['s', 'M6.5 7.5 H17.5 L16.6 19.6 a1.5 1.5 0 0 1 -1.5 1.4 H8.9 a1.5 1.5 0 0 1 -1.5 -1.4 Z'], ['l', 'M4.5 7.5 H19.5 M9.5 7.5 V5.5 H14.5 V7.5']],
  pin: [['s', 'M9 4 H15 L14 10 L17 13 V14.5 H7 V13 L10 10 Z'], ['l', 'M12 14.5 V20.5']],
  flag: [['l', 'M6 21 V4'], ['s', 'M6 4.5 H16.5 L14.5 8.5 L16.5 12.5 H6 Z']],
  filter: [['l', 'M4.5 7 H19.5 M7 12 H17 M9.5 17 H14.5']],
  paid: [['s', circle(12, 12, 8.5)], ['c', 'M14.6 9.2 a2.6 2 0 0 0 -2.6 -1.6 H11.6 a2 2 0 0 0 0 4 H12.4 a2 2 0 0 1 0 4 H12 a2.6 2 0 0 1 -2.6 -1.6 M12 6 V7.6 M12 15.4 V17']],
  playcircle: [['s', circle(12, 12, 8.5)], ['x', 'M10.3 8.8 L15 12 L10.3 15.2 Z']],
  pausecircle: [['s', circle(12, 12, 8.5)], ['c', 'M10 9 V15 M14 9 V15']],
  album: [['s', circle(12, 12, 8.5)], ['c', circle(12, 12, 2.5)]],
  remote: [['s', rrect(8, 3, 8, 18, 3)], ['c', circle(12, 8, 1.9)], ['x', circle(12, 13, 0.9)], ['x', circle(12, 16.2, 0.9)]]
};

/** An icon in Fruit soft or (solid) Fruit solid ('' none drawn: the app's own) */
export function softMarkup(name: string, solid: boolean): string {
    var parts = SOFT[name];
    if (!parts) {
        return '';
    }
    var line = ' stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
    var cuts = solid ? parts.filter(function (p) { return p[0] === 'c' || p[0] === 'x'; }) : [];
    var id = 'bolli-solid-' + name;
    var mask = cuts.length ? '<mask id="' + id + '" maskUnits="userSpaceOnUse" x="-4" y="-4" width="32" height="32"><rect x="-4" y="-4" width="32" height="32" fill="#ffffff"/>' +
        cuts.map(function (p) {
            var t = p[2] ? ' transform="' + p[2] + '"' : '';
            return p[0] === 'x' ? '<path d="' + p[1] + '"' + t + ' fill="#000000"/>' : '<path d="' + p[1] + '"' + t + ' fill="none" stroke="#000000"' + line + '/>';
        }).join('') + '</mask>' : '';
    return svg(mask + parts.map(function (p) {
        var t = p[2] ? ' transform="' + p[2] + '"' : '';
        if (solid && (p[0] === 'c' || p[0] === 'x')) {
            return '';
        }
        if (p[0] === 'f' || p[0] === 'x') {
            return '<path d="' + p[1] + '"' + t + ' fill="currentColor"/>';
        }
        if (p[0] === 's' && solid) {
            return '<path d="' + p[1] + '"' + t + ' fill="currentColor" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"' +
                (cuts.length ? ' mask="url(#' + id + ')"' : '') + '/>';
        }
        return '<path d="' + p[1] + '"' + t + ' fill="none" stroke="currentColor"' + line + '/>';
    }).join(''));
}
