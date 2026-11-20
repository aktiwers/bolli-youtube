// The app's icons: Material Design icons (Apache 2.0) as 24x24 SVG paths, drawn in the text
// colour set by the theme, in the style chosen (Settings › Theme › Icons › System: setIconStyle): the same shapes
// filled (as YouTube's TV app), outlined, in a bubble, on a coloured tile, as pixel art (made at build time:
// ui/pixels.gen.ts), in 3D (a block of shaded copies behind) or as an old video tape's picture (its scanlines, made at
// build time: ui/vhs.gen.ts). What one looks at is as big as the filled shape in each
// (a badge or a tile round it reaching past the box). No picture files: a style is how a shape is drawn. The
// sidebar's may be a set of drawings of their own instead (Settings › Theme › Icons › Sidebar: ui/rail-icons.ts).

import { h } from '../core/dom.js';
import { pixelRects, svg } from './icon-svg.js';
import { elementLetters, OWN_RAIL_SETS, railMarkup } from './rail-icons.js';
import { softMarkup } from './soft-icons.js';
import { PIXEL_GRID, PIXELS } from './pixels.gen.js';
import { VHS, VHS_PITCH } from './vhs.gen.js';

var ICONS: { [name: string]: string } = {
    language: 'M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zm6.93 6h-2.95c-.32-1.25-.78-2.45-1.38-3.56 1.84.63 3.37 1.91 4.33 3.56zM12 4.04c.83 1.2 1.48 2.53 1.91 3.96h-3.82c.43-1.43 1.08-2.76 1.91-3.96zM4.26 14C4.1 13.36 4 12.69 4 12s.1-1.36.26-2h3.38c-.08.66-.14 1.32-.14 2 0 .68.06 1.34.14 2H4.26zm.82 2h2.95c.32 1.25.78 2.45 1.38 3.56-1.84-.63-3.37-1.9-4.33-3.56zm2.95-8H5.08c.96-1.66 2.49-2.93 4.33-3.56C8.81 5.55 8.35 6.75 8.03 8zM12 19.96c-.83-1.2-1.48-2.53-1.91-3.96h3.82c-.43 1.43-1.08 2.76-1.91 3.96zM14.34 14H9.66c-.09-.66-.16-1.32-.16-2 0-.68.07-1.35.16-2h4.68c.09.65.16 1.32.16 2 0 .68-.07 1.34-.16 2zm.25 5.56c.6-1.11 1.06-2.31 1.38-3.56h2.95c-.96 1.65-2.49 2.93-4.33 3.56zM16.36 14c.08-.66.14-1.32.14-2 0-.68-.06-1.34-.14-2h3.38c.16.64.26 1.31.26 2s-.1 1.36-.26 2h-3.38z',
    keyboard: 'M20 5H4c-1.1 0-1.99.9-1.99 2L2 17c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm-9 3h2v2h-2V8zm0 3h2v2h-2v-2zM8 8h2v2H8V8zm0 3h2v2H8v-2zm-1 2H5v-2h2v2zm0-3H5V8h2v2zm9 7H8v-2h8v2zm0-4h-2v-2h2v2zm0-3h-2V8h2v2zm3 3h-2v-2h2v2zm0-3h-2V8h2v2z',
    backspace: 'M22 3H7c-.69 0-1.23.35-1.59.88L0 12l5.41 8.11c.36.53.9.89 1.59.89h15c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-3 12.59L17.59 17 14 13.41 10.41 17 9 15.59 12.59 12 9 8.41 10.41 7 14 10.59 17.59 7 19 8.41 15.41 12 19 15.59z',
    history: 'M13 3a9 9 0 0 0-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42A8.954 8.954 0 0 0 13 21a9 9 0 0 0 0-18zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z',
    search: 'M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z',
    home: 'M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z',
    subscriptions: 'M20 8H4V6h16v2zm-2-6H6v2h12V2zm4 10v8c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2v-8c0-1.1.9-2 2-2h16c1.1 0 2 .9 2 2zm-6 4l-6-3.27v6.53L16 16z',
    library: 'M17 3H7c-1.1 0-1.99.9-1.99 2L5 21l7-3 7 3V5c0-1.1-.9-2-2-2z',
    // Its outline (a playlist not saved to the library)
    bookmark: 'M17 3H7c-1.1 0-1.99.9-1.99 2L5 21l7-3 7 3V5c0-1.1-.9-2-2-2zm0 15l-5-2.18L7 18V5h10v13z',
    back: 'M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z',
    // YouTube Music's (rings, a play triangle in them), as YouTube's rail draws it
    music: 'M12 2a10 10 0 1 1 0 20a10 10 0 1 1 0-20zM12 3.8a8.2 8.2 0 1 0 0 16.4a8.2 8.2 0 1 0 0-16.4zM12 6.5a5.5 5.5 0 1 1 0 11a5.5 5.5 0 1 1 0-11zM12 8.1a3.9 3.9 0 1 0 0 7.8a3.9 3.9 0 1 0 0-7.8zM10.6 9.8v4.4l3.7-2.2z',
    movies: 'M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z',
    gaming: 'M21.58 16.09l-1.09-7.66C20.21 6.46 18.52 5 16.53 5H7.47C5.48 5 3.79 6.46 3.51 8.43l-1.09 7.66C2.2 17.63 3.39 19 4.94 19c.68 0 1.32-.27 1.8-.75L9 16h6l2.25 2.25c.48.48 1.13.75 1.8.75 1.56 0 2.75-1.37 2.53-2.91zM11 11H9v2H8v-2H6v-1h2V8h1v2h2v1zm4-1c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1zm2 3c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1z',
    sports: 'M19 5h-2V3H7v2H5c-1.1 0-2 .9-2 2v1c0 2.55 1.92 4.63 4.39 4.94.63 1.5 1.98 2.63 3.61 2.96V19H7v2h10v-2h-4v-3.1c1.63-.33 2.98-1.46 3.61-2.96C19.08 12.63 21 10.55 21 8V7c0-1.1-.9-2-2-2zM5 8V7h2v3.82C5.84 10.4 5 9.3 5 8zm14 0c0 1.3-.84 2.4-2 2.82V7h2v1z',
    podcasts: 'M14 12c0 .74-.4 1.38-1 1.72V22h-2v-8.28c-.6-.35-1-.98-1-1.72 0-1.1.9-2 2-2s2 .9 2 2zm-2-6c-3.31 0-6 2.69-6 6 0 1.74.75 3.31 1.94 4.4l1.42-1.42C8.53 14.25 8 13.19 8 12c0-2.21 1.79-4 4-4s4 1.79 4 4c0 1.19-.53 2.25-1.36 2.98l1.42 1.42C17.25 15.31 18 13.74 18 12c0-3.31-2.69-6-6-6zm0-4C6.48 2 2 6.48 2 12c0 2.85 1.2 5.41 3.11 7.24l1.42-1.42C4.98 16.36 4 14.29 4 12c0-4.41 3.59-8 8-8s8 3.59 8 8c0 2.29-.98 4.36-2.53 5.82l1.42 1.42C20.8 17.41 22 14.85 22 12c0-5.52-4.48-10-10-10z',
    play: 'M8 5v14l11-7z',
    pin: 'M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z',
    flag: 'M14.4 6L14 4H5v17h2v-7h5.6l.4 2h7V6z',
    volume: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z',
    volumeoff: 'M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z',
    // A bulleted list (Subscriptions' "All")
    list: 'M4 10.5c-.83 0-1.5.67-1.5 1.5s.67 1.5 1.5 1.5 1.5-.67 1.5-1.5-.67-1.5-1.5-1.5zm0-6c-.83 0-1.5.67-1.5 1.5S3.17 7.5 4 7.5 5.5 6.83 5.5 6 4.83 4.5 4 4.5zm0 12c-.83 0-1.5.68-1.5 1.5s.68 1.5 1.5 1.5 1.5-.68 1.5-1.5-.67-1.5-1.5-1.5zM7 19h14v-2H7v2zm0-6h14v-2H7v2zm0-8v2h14V5H7z',
    playlist: 'M3 10h11v2H3zm0-4h11v2H3zm0 8h7v2H3zm13-1v8l6-4z',
    album: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 14.5c-2.49 0-4.5-2.01-4.5-4.5S9.51 7.5 12 7.5s4.5 2.01 4.5 4.5-2.01 4.5-4.5 4.5zm0-5.5c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1z',
    check: 'M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
    // A lock (a private playlist), Repeat and Shuffle (a playlist's buttons)
    lock: 'M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z',
    loop: 'M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z',
    // A remote with its signal (Settings › Shortcuts, a playlist's or a channel's Shortcut)
    remote: 'M15 9H9c-.55 0-1 .45-1 1v12c0 .55.45 1 1 1h6c.55 0 1-.45 1-1V10c0-.55-.45-1-1-1zm-3 6c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zM7.05 6.05l1.41 1.41C9.37 6.56 10.62 6 12 6s2.63.56 3.54 1.46l1.41-1.41C15.68 4.78 13.93 4 12 4s-3.68.78-4.95 2.05zM12 0C8.96 0 6.21 1.23 4.22 3.22l1.41 1.41C7.26 3.01 9.51 2 12 2s4.74 1.01 6.36 2.64l1.41-1.41C17.79 1.23 15.04 0 12 0z',
    shuffle: 'M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z',
    // A coin with a dollar sign (YouTube's paid promotion notice)
    paid: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1.41 16.09V20h-2.67v-1.93c-1.71-.36-3.16-1.46-3.27-3.4h1.96c.1 1.05.82 1.87 2.65 1.87 1.96 0 2.4-.98 2.4-1.59 0-.83-.44-1.61-2.67-2.14-2.48-.6-4.18-1.62-4.18-3.67 0-1.72 1.39-2.84 3.11-3.21V4h2.67v1.95c1.86.45 2.79 1.86 2.85 3.39H14.3c-.05-1.11-.64-1.87-2.22-1.87-1.5 0-2.4.68-2.4 1.64 0 .84.65 1.39 2.67 1.91s4.18 1.39 4.18 3.91c-.01 1.83-1.38 2.83-3.12 3.16z',
    // An outlined i in a circle (a notice: why something happens)
    info: 'M11 7h2v2h-2zm0 4h2v6h-2zm1-9C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z',
    add: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z',
    person: 'M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z',
    like: 'M21 8h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2c0-1.1-.9-2-2-2zm0 4l-3 7H9V9l4.34-4.34L12.23 10H21v2zM1 9h4v12H1z',
    liked: 'M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z',
    dislike: 'M15 3H6c-.83 0-1.54.5-1.84 1.22l-3.02 7.05c-.09.23-.14.47-.14.73v2c0 1.1.9 2 2 2h6.31l-.95 4.57-.03.32c0 .41.17.79.44 1.06L9.83 23l6.59-6.59c.36-.36.58-.86.58-1.41V5c0-1.1-.9-2-2-2zm0 12l-4.34 4.34L11.77 14H3v-2l3-7h9v10zm4-12h4v12h-4z',
    disliked: 'M15 3H6c-.83 0-1.54.5-1.84 1.22l-3.02 7.05c-.09.23-.14.47-.14.73v2c0 1.1.9 2 2 2h6.31l-.95 4.57-.03.32c0 .41.17.79.44 1.06L9.83 23l6.59-6.59c.36-.36.58-.86.58-1.41V5c0-1.1-.9-2-2-2zm4 0v12h4V3h-4z',
    save: 'M17 3H7c-1.1 0-1.99.9-1.99 2L5 21l7-3 7 3V5c0-1.1-.9-2-2-2zm0 15l-5-2.18L7 18V5h10v13z',
    saved: 'M17 3H7c-1.1 0-1.99.9-1.99 2L5 21l7-3 7 3V5c0-1.1-.9-2-2-2z',
    pause: 'M6 19h4V5H6v14zm8-14v14h4V5h-4z',
    bell: 'M12 22c1.1 0 2-.9 2-2h-4c0 1.1.89 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z',
    mic: 'M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z',
    // Page buttons (YouTube's MENU_FILTER, ARROW_PAUSE, ARROW_PLAY, CLEAR_WATCH_HISTORY)
    filter: 'M10 18h4v-2h-4v2zM3 6v2h18V6H3zm3 7h12v-2H6v2z',
    pausecircle: 'M9 16h2V8H9v8zm3-14C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm1-4h2V8h-2v8z',
    playcircle: 'M10 16.5l6-4.5-6-4.5v9zM12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z',
    delete: 'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z',
    previous: 'M6 6h2v12H6zm3.5 6l8.5 6V6z',
    next: 'M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z',
    subtitles: 'M19 4H5c-1.11 0-2 .9-2 2v12c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm-8 7H9.5v-.5h-2v3h2V13H11v1c0 .55-.45 1-1 1H7c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1zm7 0h-1.5v-.5h-2v3h2V13H18v1c0 .55-.45 1-1 1h-3c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1z',
    comments: 'M21.99 4c0-1.1-.89-2-1.99-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h14l4 4-.01-18zM18 14H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z',
    settings: 'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z'
};

/** An ICONS icon in a box with the given class (the theme sizes it) */
export function icon(name: string, className: string): HTMLElement {
    var el = h('div', className);
    setIcon(el, name);
    return el;
}

/** The icon styles besides filled ('') */
export var ICON_STYLES = ['outline', 'bubble', 'tiles', 'pixel', 'iso', 'glass', 'soft', 'solid', 'vhs'];

/** The style the icons are drawn in now ('' filled) */
var style = '';

/** An icon's markup in a style: filled; outline (a thin line round each shape);
 * bubble (as filled, inside a faint round badge reaching a little past its box); tiles (white on a rounded square in
 * its group's colour, past its box); pixel (its pixel art); iso (the shape in front, five faint copies stepping down to
 * the right behind it: together a solid block, its depth); glass (on a frosted disc: glass); vhs (its scanlines, its
 * colours bleeding apart: vhs) */
export function markup(name: string, how: string): string {
    var d = ICONS[name] || '';
    if (how === 'glass') {
        return glass(d);
    }
    // (its own box: not one svg inside another)
    if (how === 'pixel' && PIXELS[name]) {
        return pixelRects(PIXELS[name], PIXEL_GRID);
    }
    if (how === 'vhs' && VHS[name]) {
        return vhs(VHS[name]);
    }
    // (Fruit soft and solid: drawings of their own: ui/soft-icons.ts)
    if (how === 'soft' || how === 'solid') {
        var own = softMarkup(name, how === 'solid');
        if (own) {
            return own;
        }
    }
    var path = function (attrs: string): string { return '<path d="' + d + '" ' + attrs + '/>'; };
    var line = 'stroke="currentColor" stroke-linejoin="round"';
    var inner = how === 'outline' ? path('fill="none" ' + line + ' stroke-width="1.3"') :
        how === 'bubble' ? '<circle cx="12" cy="12" r="14.5" fill="currentColor" fill-opacity=".16"/>' + path('fill="currentColor"') :
        how === 'tiles' ? '<rect x="-3.5" y="-3.5" width="31" height="31" rx="8" fill="' + tileColour(name) + '"/>' + path('fill="#ffffff"') :
        how === 'iso' ? DEPTH.map(function (at) { return path('transform="translate(' + at + ' ' + at + ')" fill="currentColor" fill-opacity=".3"'); }).join('') +
            path('fill="currentColor"') :
        path('fill="currentColor"');
    return svg(inner);
}

/** 3D's copies behind the shape: how far each steps down and to the right (layout units of the 24 box) */
var DEPTH = [2.5, 2, 1.5, 1, 0.5];

/** VHS's copies, back to front: a red one a little to the left and a blue one to the right (a tape's colours bleeding
 * apart, as the VHS logo's and loading sign's: their red and blue), the shape in front in the text's colour. Each its
 * paint, its shift right (layout units) and its shift on the tracking line (TRACKING: the shape a little, its colours
 * further apart) */
var VHS_COPIES = [
    { paint: 'fill="#ff0050" fill-opacity=".6"', dx: -0.8, track: -1.1 },
    { paint: 'fill="#00c8ff" fill-opacity=".6"', dx: 0.8, track: 2.5 },
    { paint: 'fill="currentColor"', dx: 0, track: 0.7 }
];
/** The tracking line: the scanline (from the top, from 0) shifted as a tape's tracking out of true, at the same height
 * in every icon, so that a row of them shares it */
var TRACKING = 9;
/** A scanline's height: 4/3 of the 2 between them (at the TV's zoom of 1.5: 2 pixels lit, 1 dark, on whole pixels) */
var SCANLINE = 1.333;

/** VHS: an icon's scanlines (rows: ui/vhs.gen.ts, from tools/vhs_icons.mjs), each piece a bar, in the three copies of
 * VHS_COPIES: three paths, no mask, filter or id */
function vhs(rows: string): string {
    var lines = rows.split('/');
    var d = ['', '', ''];
    for (var n = 0; n < lines.length; n++) {
        var x = lines[n] ? lines[n].split(' ') : [];
        for (var i = 0; i + 1 < x.length; i += 2) {
            var w = Math.round((+x[i + 1] - +x[i]) * 100) / 100;
            var bar = ' ' + n * VHS_PITCH + 'h' + w + 'v' + SCANLINE + 'h-' + w + 'z';
            for (var c = 0; c < 3; c++) {
                var dx = n === TRACKING ? VHS_COPIES[c].track : VHS_COPIES[c].dx;
                d[c] += 'M' + (dx ? Math.round((+x[i] + dx) * 100) / 100 : x[i]) + bar;
            }
        }
    }
    return svg(d.map(function (one, c) { return '<path d="' + one + '" ' + VHS_COPIES[c].paint + '/>'; }).join(''));
}

/** Glass: the symbol (as big as the filled one) on a frosted disc round it: a faint tint of the text's colour, a soft
 * light over its upper half, a thin bright rim, a soft shadow under it (the sidebar's Glass too: the same style) */
function glass(path: string): string {
    return svg('<ellipse cx="12" cy="28" rx="10" ry="2" fill="#000000" fill-opacity=".28"/>' +
        '<circle cx="12" cy="12" r="15" fill="currentColor" fill-opacity=".13"/>' +
        '<ellipse cx="12" cy="4.6" rx="10.5" ry="6" fill="#ffffff" fill-opacity=".13"/>' +
        '<circle cx="12" cy="12" r="15" fill="none" stroke="#ffffff" stroke-opacity=".38" stroke-width=".8"/>' +
        '<path d="' + path + '" fill="currentColor"/>');
}

/** App tiles' colours by the icon's group (the sidebar's App tiles too): the sidebar's sections each their own, playing
 * red, sound and words blue, what one does to a video orange, the rest grey */
var GROUPS: { [colour: string]: string[] } = {
    '#e53935': ['play', 'pause', 'previous', 'next', 'loop', 'shuffle', 'playlist', 'list', 'pausecircle', 'playcircle', 'home'],
    '#3949ab': ['volume', 'volumeoff', 'subtitles', 'comments', 'language', 'keyboard', 'mic', 'movies'],
    '#fb8c00': ['like', 'liked', 'dislike', 'disliked', 'save', 'saved', 'bell', 'pin', 'flag', 'subscriptions'],
    '#546e7a': ['search', 'history', 'back', 'backspace'],
    '#8e24aa': ['library', 'bookmark', 'album'],
    '#43a047': ['gaming'],
    '#00897b': ['podcasts'],
    '#d81b60': ['music'],
    '#f9a825': ['sports', 'paid']
};

function tileColour(name: string): string {
    for (var colour in GROUPS) {
        if (GROUPS[colour].indexOf(name) >= 0) {
            return colour;
        }
    }
    return '#6d6d6d';
}

/** Icons parsed once, by style and name (the filled ones by name alone): each box gets a copy (cloning took half the
 * time of parsing the markup again). No prototype: a key is never one of Object's own names */
var parsed: { [key: string]: Node } = Object.create(null);
/** Of the icons kept, those that cut a mask (Fruit solid's), each copy given its own mask id: maskCount */
var masked: { [key: string]: number } = Object.create(null);
var maskCount = 0;

/** Changes the box's icon (rewritten only if different) */
export function setIcon(el: HTMLElement, name: string): void {
    if (el.getAttribute('data-icon') !== name) {
        el.setAttribute('data-icon', name);
        draw(el, name);
    }
}

/** Icon name in box el in YouTube's own filled drawing whatever the style chosen, left alone by setIconStyle (fixed:
 * what shows in YouTube's dark look of its own, main.ts whoLook); not fixed: in the style chosen, as setIcon */
export function setIconIn(el: HTMLElement, name: string, fixed: boolean): void {
    if (!fixed) {
        if (el.getAttribute('data-fixed') !== null) {
            el.removeAttribute('data-fixed');
        }
        setIcon(el, name);
    } else if (el.getAttribute('data-fixed') !== name || el.getAttribute('data-icon') !== null) {
        el.removeAttribute('data-icon');
        el.setAttribute('data-fixed', name);
        drawIcon(el, name, '');
    }
}

/** The icons' names */
export function iconNames(): string[] {
    return Object.keys(ICONS);
}

/** Icon name drawn into box el in style how ('' filled), kept by both: the filled one by its name alone, so that on the
 * default look (setIcon at a key: play and pause, like) no key is made and no function */
export function drawIcon(el: HTMLElement, name: string, how: string): void {
    var key = how ? how + ' ' + name : name;
    if (!parsed[key]) {
        keep(key, markup(name, how));
    }
    copyKept(el, key);
}

/** An icon's markup parsed and kept under key (each box gets a copy of it: copyKept) */
function keep(key: string, html: string): void {
    var box = document.createElement('div');
    box.innerHTML = html;
    parsed[key] = box.firstChild as Node;
    masked[key] = html.indexOf('<mask') >= 0 ? 1 : 0;
}

/** A copy of the icon kept under key in box el, in place of what was in it */
function copyKept(el: HTMLElement, key: string): void {
    el.textContent = '';
    var copy = el.appendChild(parsed[key].cloneNode(true)) as Element;
    if (masked[key]) {
        // (each copy its own mask id: the first of a shared id may be in a box hidden, where old Chrome draws no mask)
        // (the mask the svg's first child, the shapes it cuts after it: ui/soft-icons.ts)
        var mask = copy.firstChild as Element;
        var id = mask.getAttribute('id') + '-' + (++maskCount);
        mask.setAttribute('id', id);
        for (var n = mask.nextSibling as Element | null; n; n = n.nextSibling as Element | null) {
            if (n.getAttribute('mask')) {
                n.setAttribute('mask', 'url(#' + id + ')');
            }
        }
    }
}

/** Draws icon name in box el in the style now (a sidebar entry's in the sidebar's set, if one is chosen: railIcon) */
function draw(el: HTMLElement, name: string): void {
    var entry = railSet ? el.getAttribute('data-rail') : null;
    if (entry) {
        drawRail(el, name, railSet, entry, style);
    } else {
        drawIcon(el, name, style);
    }
}

/** Draws a sidebar entry's icon (its place and name: entry, "n name") in set ('' none: in style): a set of the
 * sidebar's own in its drawing, kept by entry; another (App tiles, Glass, Fruit, VHS) as the system's style of that name */
export function drawRail(el: HTMLElement, name: string, set: string, entry: string, how: string): void {
    if (set && OWN_RAIL_SETS.indexOf(set) >= 0) {
        var key = set + ' ' + entry;
        if (!parsed[key]) {
            var at = entry.indexOf(' ');
            keep(key, railMarkup(set, name, entry.slice(at + 1), +entry.slice(0, at)) || markup(name, how));
        }
        copyKept(el, key);
        return;
    }
    drawIcon(el, name, set || how);
}

/** A sidebar entry's icon: the icon name, the entry's name and place (n, from 1), drawn in the sidebar's set when one
 * is chosen (setRailSet), else as any icon */
export function railIcon(name: string, label: string, n: number, className: string): HTMLElement {
    var el = h('div', className);
    el.setAttribute('data-rail', n + ' ' + label);
    // (Elements' letters reserved in the rail's order, whichever entry is drawn first)
    elementLetters(label);
    setIcon(el, name);
    return el;
}

/** The sidebar's set ('' the app's icons) */
var railSet = '';

/** The sidebar's icons drawn in a set of their own ('' the app's icons in the style now; ui/rail-icons.ts RAIL_SETS),
 * once, when it changes */
export function setRailSet(set: string): void {
    if (set === railSet) {
        return;
    }
    railSet = set;
    var all = document.querySelectorAll('[data-rail]');
    for (var i = 0; i < all.length; i++) {
        draw(all[i] as HTMLElement, all[i].getAttribute('data-icon') || '');
    }
}

/** The icons' style ('' filled, or one of ICON_STYLES): every icon on the page drawn anew in it, once, when it
 * changes (a choice in Settings, a look shown in place of the chosen one) */
export function setIconStyle(how: string): void {
    if (how === style) {
        return;
    }
    style = how;
    var all = document.querySelectorAll('[data-icon]');
    for (var i = 0; i < all.length; i++) {
        // (the sidebar's in a set of their own do not change with the style)
        if (!railSet || !all[i].hasAttribute('data-rail')) {
            draw(all[i] as HTMLElement, all[i].getAttribute('data-icon') || '');
        }
    }
}
