// A screen. Section screens stay alive while hidden, so going back to one
// shows it as it was, without rebuilding. Views hide with setShown
// (visibility), which keeps their layout; the app shell adds pushed screens
// to the stage and removes them again.

import { KeyHandler } from './keys.js';

export interface View extends KeyHandler {
    el: HTMLElement;
    show(): void;
    hide(): void;
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
}
