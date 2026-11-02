// Loading sign: a dimmed picture (the app logo
// while a screen loads, the channel avatar while a video starts) with a
// bright copy over it that fills in from the left as steps complete. It
// hides at once when done (no fade). Chrome 38 has no clip-path, so the
// fill uses two opposite slides: the copy's box slides in from the left
// with overflow hidden while the copy inside slides back, keeping it in
// place. Look and pace: themes/<id>.css (by-loader, --round for a circle).

import { h, toggleClass } from '../../core/dom.js';

/** The app logo: shown while a screen loads or YouTube's player starts */
export var LOGO = 'logo.webp';

export class FillLoader {
    private el: HTMLElement;
    private dim: HTMLImageElement;
    private bright: HTMLImageElement;
    private parts: HTMLElement[];
    private fill = 0;

    /** Adds the sign to parent; round shows the picture as a circle */
    constructor(parent: HTMLElement, round: boolean) {
        this.el = h('div', 'by-loader' + (round ? ' by-loader--round' : ''));
        var pulse = h('div', 'by-loader-pulse');
        this.dim = h('img', 'by-loader-image') as HTMLImageElement;
        var box = h('div', 'by-loader-box');
        var inner = h('div', 'by-loader-inner');
        this.bright = h('img', 'by-loader-image') as HTMLImageElement;
        inner.appendChild(this.bright);
        box.appendChild(inner);
        pulse.appendChild(this.dim);
        pulse.appendChild(box);
        this.el.appendChild(pulse);
        this.parts = [box, inner];
        this.el.style.display = 'none';
        parent.appendChild(this.el);
    }

    get shown(): boolean {
        return this.el.style.display === 'block';
    }

    /** Shows the sign empty, then fills towards the first step */
    show(image: string, first: number): void {
        this.setImage(image);
        // Reset without a slide back: transitions off, force a style read, transitions on
        toggleClass(this.el, 'by-loader--snap', true);
        this.slide(0);
        this.el.style.display = 'block';
        void window.getComputedStyle(this.parts[0]).webkitTransform;
        toggleClass(this.el, 'by-loader--snap', false);
        this.fill = first;
        this.slide(first);
    }

    private setImage(image: string): void {
        if (this.dim.getAttribute('src') !== image) {
            this.dim.src = this.bright.src = image;
        }
    }

    /** Fills towards fill (0-1); never goes back */
    step(fill: number): void {
        if (fill > this.fill && this.shown) {
            this.fill = fill;
            this.slide(fill);
        }
    }

    /** Hides at once */
    hide(): void {
        this.el.style.display = 'none';
    }

    private slide(fill: number): void {
        var off = (1 - fill) * 100;
        for (var i = 0; i < this.parts.length; i++) {
            this.parts[i].style.webkitTransform = 'translate3d(' + (i ? off : -off) + '%,0,0)';
        }
    }
}
