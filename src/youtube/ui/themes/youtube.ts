// "YouTube" theme: YouTube's own dark TV look, with sizes measured from its TV
// app at 1920x1080 and scaled to two thirds (the 1280x720 layout): a 104 px
// rail, Home's first row of 480 px tiles and other rows of 352 px, 24 px apart;
// page grids and the watch page's related videos three to a line; a search bar
// over Home's first row; Settings at the rail's foot.
// Stylesheet: themes/youtube.css.

import { registerTheme } from '../theme.js';

registerTheme({
    id: 'youtube',
    name: 'YouTube',
    metrics: {
        rail: { width: 104, top: 130, step: 52, bottom: 630 },
        big: { w: 480, h: 270 },
        tile: { w: 352, h: 198 },
        grid: { w: 352, h: 198 },
        gridHead: 72,
        // As on YouTube's History, Playlists and Music library
        gridPitch: 359,
        square: { w: 198, h: 198 },
        game: { w: 141, h: 198 },
        // Movies posters, and the focused one wide (843x474 at 1920)
        poster: { w: 221, h: 316 },
        posterWide: { w: 562, h: 316 },
        // As YouTube's Gaming shelves: tiles 58 under a row's top, 68 with a line under the title, such a row 14 taller
        lineRows: { plainUp: 10, taller: 14 },
        // YouTube's Library at 1920: rows 654 apart, tiles 81 under a row's top, a row with a line 24 taller; in the
        // rows the focused one at 72, the cards gone up
        library: { pitch: 436, plainHead: 54, taller: 16, rowsTop: 48 },
        // YouTube's Watch later at 1920: pictures 294x165 at 942, 202 px apart, the first at 136; its title at 150
        list: { tile: { w: 196, h: 110 }, left: 628, top: 96, pitch: 135, title: 96 },
        rows: { pad: 104, gap: 24, under: 128, head: 68, rowGap: 21 },
        rowsTop: 96,
        searchBarSpace: 12,
        bigUp: 20,
        // Matched to YouTube's screens for rows without a line under the title
        searchRowsTop: 131,
        subscriptionsTop: 268,
        subscriptionsStep: 112,
        libraryTop: 226,
        libraryStep: 218,
        whoStep: 240,
        watch: {
            tile: { w: 368, h: 207 },
            rows: { pad: 64, gap: 24, under: 124, head: 0, rowGap: 24 },
            top: 598,
            // The focused line mid-screen, as YouTube's (480 of 1080)
            focusTop: 320
        },
        channel: { rowsTop: 580, rowsTopDown: 120, pad: 64 },
        page: { top: 44, gridTop: 123, right: 48 },
        // Ages as YouTube's watch page writes them: 9 hr, 1 day, 3 wk, 3 mo, 2 yr
        ways: { homeBig: true, pagesOverAll: true, lowerCounts: true, words: { 'CC': 'Subtitles', 'Watch later': 'Watch Later' },
            ages: { s: ['sec', 'sec'], m: ['min', 'min'], h: ['hr', 'hr'], d: ['day', 'days'], w: ['wk', 'wk'], mo: ['mo', 'mo'], y: ['yr', 'yr'] } }
    }
});
