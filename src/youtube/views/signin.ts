// The sign-in screen, laid out like YouTube's TV app: over YouTube's background,
// its wordmark, the title and explanation, and the phone sign-in on the left; on
// the right a QR code to yt.be/activate, the address, and the code to enter there
// (api/signin.ts). While shown, Google is polled until the code is entered; then
// the account is stored and done is called. An expired code is replaced; if
// Google gives none, OK asks again. YouTube's other ways (with the remote, a
// child account) are not offered. The look is the theme's (by-signin).

import { h, setShown, setSrc, setText } from '../../core/dom.js';
import { KEY } from '../../core/keys.js';
import { View } from '../../core/view.js';
import { ACTIVATE, DeviceCode, deviceCode, keepAccount, signedIn } from '../api/signin.js';
import { Identity } from '../api/youtube.js';
import { drawQr } from '../../ui/qr.js';

var PICTURES = 'https://www.gstatic.com/';
/** The QR code's maximum side (layout px; ui/qr.ts) */
var QR_SIZE = 330;

export class SignInView implements View {
    el: HTMLElement;
    private qr: HTMLCanvasElement;
    private code: HTMLElement;
    private said: HTMLElement;
    private current: DeviceCode | null = null;
    private timer = 0;
    private shown = false;
    /** A code request is in flight */
    private asking = false;

    /** done: called with the signed-in account (stored where YouTube's TV app keeps accounts) */
    constructor(private done: (identity: Identity) => void) {
        this.el = h('div', 'by-signin');
        setShown(this.el, false);
        var bg = this.el.appendChild(h('img', 'by-signin-bg')) as HTMLImageElement;
        setSrc(bg, PICTURES + 'ytlr/img/uni_tube_gradient_1280x720.jpg');
        var left = this.el.appendChild(h('div', 'by-signin-left')) as HTMLElement;
        var mark = left.appendChild(h('img', 'by-signin-wordmark')) as HTMLImageElement;
        setSrc(mark, PICTURES + 'youtube/img/branding/livingroom/youtube/wordmark/fullcolor_white_42_v3_2x.png');
        left.appendChild(h('div', 'by-signin-title', 'Add your Google Account'));
        left.appendChild(h('div', 'by-signin-text', 'With your own account, you can find all the videos and channels that you love, and no one else\'s'));
        left.appendChild(h('div', 'by-signin-way', 'Sign in with your phone'));
        var right = this.el.appendChild(h('div', 'by-signin-right')) as HTMLElement;
        this.qr = right.appendChild(h('canvas', 'by-signin-qr')) as HTMLCanvasElement;
        // If the QR library fails to load, the address and code still show
        drawQr(this.qr, 'https://' + ACTIVATE, QR_SIZE).then(null, function () { return undefined; });
        right.appendChild(h('div', 'by-signin-small', 'Scan QR code or go to'));
        right.appendChild(h('div', 'by-signin-big', ACTIVATE));
        right.appendChild(h('div', 'by-signin-small', 'Enter the code'));
        this.code = right.appendChild(h('div', 'by-signin-code')) as HTMLElement;
        this.said = right.appendChild(h('div', 'by-signin-small')) as HTMLElement;
    }

    show(): void {
        this.shown = true;
        setShown(this.el, true);
        // A code is on its way: polling starts when it arrives
        if (this.asking) {
            return;
        }
        if (this.current && Date.now() < this.current.ends) {
            setText(this.code, this.current.user);
            this.wait();
        } else {
            this.newCode();
        }
    }

    hide(): void {
        this.shown = false;
        clearTimeout(this.timer);
        setShown(this.el, false);
    }

    setFocused(): void {
        // The single sign-in option is always focused
    }

    onKey(code: number): boolean {
        if (code === KEY.OK && !this.current && !this.asking) {
            this.newCode();
        }
        return code !== KEY.BACK && code !== KEY.LEFT;
    }

    /** Gets a new code from Google, shows it, then polls */
    private newCode(): void {
        var self = this;
        clearTimeout(this.timer);
        this.current = null;
        this.asking = true;
        setText(this.code, '');
        setText(this.said, '');
        deviceCode().then(function (c) {
            self.asking = false;
            self.current = c;
            setText(self.code, c.user);
            if (self.shown) {
                self.wait();
            }
        }, function () {
            self.asking = false;
            setText(self.said, 'Google gave no code. Press OK to try again.');
        });
    }

    /** Polls Google after its interval for whether the code was entered (expired: gets a new one) */
    private wait(): void {
        var self = this;
        var c = this.current as DeviceCode;
        clearTimeout(this.timer);
        this.timer = setTimeout(function () {
            if (!self.shown || self.current !== c) {
                return;
            }
            if (Date.now() >= c.ends) {
                self.newCode();
                return;
            }
            signedIn(c).then(function (got) {
                if (self.current !== c) {
                    return;
                }
                if (got === 'waiting' || got === 'slower') {
                    // Google asked to slow down: five seconds more between polls
                    c.every += got === 'slower' ? 5000 : 0;
                    if (self.shown) {
                        self.wait();
                    }
                } else if (got) {
                    // Stored even if Back was pressed meanwhile (Google returns a code's sign-in only once)
                    self.current = null;
                    setText(self.said, 'Signing in …');
                    keepAccount(got).then(self.done, function () {
                        setText(self.said, 'YouTube did not take the sign-in. Press OK to try again.');
                    });
                } else if (self.shown) {
                    self.newCode();
                }
            }, function () {
                // No answer: poll again
                if (self.shown && self.current === c) {
                    self.wait();
                }
            });
        }, c.every) as unknown as number;
    }
}
