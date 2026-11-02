// The players' info bar along the bottom (the theme draws it on a dark
// gradient): a logo with a small label (channel or series), the title, the time
// beside a progress bar (on demand also a marker for a pending seek), the
// description when the user opened the bar (not when it appears by itself on a
// channel change or seek), a line for what comes next or the keys (led by the
// playing quality, e.g. "1080p · 50 fps"), and a message line for problems. It
// hides after a few seconds unless the player wants it to stay.

import { h, setSrc, setText } from '../core/dom.js';

var SHOW_MS = 5000;

export class PlayerOsd {
    private el: HTMLElement;
    private logo: HTMLImageElement;
    private label: HTMLElement;
    private title: HTMLElement;
    private time: HTMLElement;
    private fill: HTMLElement;
    private marker: HTMLElement;
    private text: HTMLElement;
    private quality: HTMLElement;
    private lineText: HTMLElement;
    private message: HTMLElement;
    private timer = 0;
    /** The fill's scale as last written */
    private filled = '';
    /** The description was requested for this showing of the bar */
    private withText = false;
    /** Whether the description element is shown (as last set) */
    private textShown = true;

    /** stay: asked when the time is up (true keeps the bar); onHide: called when it hides */
    constructor(root: HTMLElement, private stay: () => boolean, private onHide?: () => void) {
        this.el = h('div', 'osd');
        var head = h('div', 'osd-head');
        this.logo = h('img', 'osd-logo') as HTMLImageElement;
        this.label = h('div', 'osd-channel');
        head.appendChild(this.logo);
        head.appendChild(this.label);
        this.title = h('div', 'osd-now');
        var timeLine = h('div', 'osd-time-line');
        this.time = h('span', 'osd-time');
        var bar = h('span', 'osd-bar');
        this.fill = h('span', 'osd-fill');
        this.marker = h('span', 'osd-marker');
        bar.appendChild(this.fill);
        bar.appendChild(this.marker);
        timeLine.appendChild(this.time);
        timeLine.appendChild(bar);
        this.text = h('div', 'osd-text');
        var line = h('div', 'osd-next');
        this.quality = h('span', 'osd-quality');
        this.lineText = h('span');
        line.appendChild(this.quality);
        line.appendChild(this.lineText);
        this.message = h('div', 'osd-message');
        this.el.appendChild(head);
        this.el.appendChild(this.title);
        this.el.appendChild(timeLine);
        this.el.appendChild(this.text);
        this.el.appendChild(line);
        this.el.appendChild(this.message);
        root.appendChild(this.el);
    }

    get shown(): boolean {
        return this.el.style.display === 'block';
    }

    /** Shown at the user's request (with the description); Up again then opens the menu */
    get asked(): boolean {
        return this.withText && this.shown;
    }

    /** withText: also show the description (the user asked for the bar); it
     * stays until the bar hides, whatever shows the bar meanwhile */
    show(withText?: boolean): void {
        this.withText = this.withText || !!withText;
        this.showText();
        if (!this.shown) {
            this.el.style.display = 'block';
        }
        clearTimeout(this.timer);
        var self = this;
        var later = function () {
            if (self.stay()) {
                self.timer = setTimeout(later, SHOW_MS) as unknown as number;
            } else {
                self.hide();
            }
        };
        this.timer = setTimeout(later, SHOW_MS) as unknown as number;
    }

    hide(): void {
        clearTimeout(this.timer);
        this.withText = false;
        if (this.shown) {
            this.el.style.display = 'none';
            if (this.onHide) {
                this.onHide();
            }
        }
    }

    /** logo '' hides the logo */
    setHead(logo: string, label: string): void {
        setSrc(this.logo, logo);
        this.logo.style.display = logo ? '' : 'none';
        setText(this.label, label);
    }

    setTitle(text: string): void {
        setText(this.title, text);
    }

    /** share: filled part of the bar, 0..1 (a scale transform, so no relayout) */
    setTime(text: string, share: number): void {
        setText(this.time, text);
        var filled = Math.max(0, Math.min(1, share)).toFixed(3);
        if (filled !== this.filled) {
            this.filled = filled;
            this.fill.style.webkitTransform = 'scaleX(' + filled + ')';
        }
    }

    /** Where a pending seek lands (0..1), or -1 for none */
    setMarker(share: number): void {
        this.marker.style.display = share >= 0 ? 'block' : 'none';
        this.marker.style.left = (Math.max(0, share) * 100).toFixed(2) + '%';
    }

    /** Sets the description (e.g. on a programme change while the bar shows); shown only if requested */
    setDescription(text: string): void {
        setText(this.text, text);
        this.showText();
    }

    private showText(): void {
        var text = this.withText && !!this.text.textContent;
        if (text !== this.textShown) {
            this.textShown = text;
            // '' keeps the theme's own display (a box clipped after four lines)
            this.text.style.display = text ? '' : 'none';
        }
    }

    setLine(text: string): void {
        setText(this.lineText, text);
    }

    /** The playing picture's height ("1080p") and frame rate when known;
     * empty while nothing is decoded */
    setQuality(height: number, frameRate: number): void {
        // When empty the tag hides itself (the theme's :empty rule)
        setText(this.quality, height ? height + 'p' + (frameRate ? '  ·  ' + frameRate + ' fps' : '') : '');
    }

    setMessage(text: string): void {
        setText(this.message, text);
    }
}
