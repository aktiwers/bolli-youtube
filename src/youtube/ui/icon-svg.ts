// What every icon set draws with (ui/icons.ts the system's styles, ui/rail-icons.ts the sidebar's own sets,
// ui/soft-icons.ts Fruit): the 24 x 24 box an icon is drawn in, and pixel art from its squares. A module of its own so
// that the sets share it without importing each other.

/** An icon's drawing in the 24 x 24 box every icon has */
export function svg(inner: string): string {
    return '<svg viewBox="0 0 24 24" width="100%" height="100%">' + inner + '</svg>';
}

/** Pixel art from its squares (grid x grid, row after row, # drawn), each run of pixels in a row one rectangle (the
 * system's 16 x 16: ui/pixels.gen.ts; the sidebar's 12 x 12) */
export function pixelRects(squares: string, grid: number): string {
    var size = 24 / grid;
    var out = '';
    for (var y = 0; y < grid; y++) {
        var row = squares.slice(y * grid, y * grid + grid);
        var re = /#+/g;
        var m: RegExpExecArray | null;
        while ((m = re.exec(row))) {
            out += '<rect x="' + m.index * size + '" y="' + y * size + '" width="' + m[0].length * size + '" height="' + size + '"/>';
        }
    }
    return svg('<g fill="currentColor" shape-rendering="crispEdges">' + out + '</g>');
}
