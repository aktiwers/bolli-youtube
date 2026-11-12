// A screen. Section screens stay alive while hidden, so going back to one
// shows it as it was, without rebuilding. Views hide with setShown
// (visibility), which keeps their layout; the app shell adds pushed screens
// to the stage and removes them again.

import { KeyHandler } from './keys.js';

export interface View extends KeyHandler {
    el: HTMLElement;
    show(): void;
    hide(): void;
    /** Out of sight for a moment but kept drawn (core/dom.ts standsBy), for a screen that may show again right away
     * (a neighbour while the rail moves, the one a page opened over): show() then brings it back with nothing to
     * draw. It holds memory and costs every frame a little, so hide() follows once that moment has passed. False:
     * it has nothing drawn worth keeping and is hidden as by hide(). */
    standBy?(): boolean;
    /** Loads and draws itself out of sight, standing by from the start (a page built ahead of OK on its tile):
     * show() then finds it drawn, or on its way */
    drawAhead?(): void;
    /** Pushed screens: called when Back leaves it (stop timers, ignore late replies) */
    destroy?(): void;
    /** True when focus is on the top element, so Up moves to the menu */
    atTop?(): boolean;
    /** True while the user is down in the content: the menu slides away */
    menuHidden?(): boolean;
    /** False while the menu has focus: the view then shows no focus of its own */
    setFocused?(focused: boolean): void;
    /** OK on a screen whose content failed to load: try again (false if it had not failed) */
    retry?(): boolean;
    /** Whether OK held on what the screen has focused means something (onHold): OK then acts on its release, not as
     * it goes down */
    holds?(): boolean;
    /** OK held on what the screen has focused: true when the screen used it (else it acts as OK) */
    onHold?(): boolean;
}
