// The loading signs' ids (Settings › Theme › Loading spinner), apart from their drawing (ui/spinner.ts) so that the
// settings (api/prefs.ts, read by the parse worker too) name them without taking the drawing code along.

/** The spinners' ids, in Settings' order; each drawn by ui/spinner.ts PARTS (a test holds the two to the same ids) */
export var SPINNERS = ['youtube', 'midnight', 'arcade', 'vhs', 'mission', 'paper', 'cinema'];

/** Settings › Theme › Loading spinner's choices (prefs startSign, the account's own, and lookSign, a theme's on top: the sign
 * while a video starts in the app's player, not a screen's), in Settings' order: none ('off': the screen stays dark
 * until the video plays), the channel's picture filling up ('channel', ui/fill-loader.ts; the default), the app's logo
 * filling up ('logo': the one chosen, as the app's screens show it while they load; whatever logo
 * is chosen, filling up as the channel's picture does; no logo chosen: the channel's picture), then
 * the spinners, each a theme's. The one list of the signs' ids (api/prefs.ts reads the stored ones by it; views/settings.ts
 * signSetting gives each its name and note). A new sign: its id here (a spinner: also its parts in ui/spinner.ts PARTS,
 * their look in themes/youtube.css, its own colours one may change in tools/light_theme.mjs SIGN_COLOURS: the build
 * fails without them), its choice in views/settings.ts and views/sign-preview.ts signSays, its drawing in the player
 * (player/own-player.ts, where the sign starts) */
export var LOADING_SIGNS = ['off', 'channel', 'logo'].concat(SPINNERS);
