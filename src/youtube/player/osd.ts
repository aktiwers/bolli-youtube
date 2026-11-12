// The players' info bar along the bottom (the theme draws it on a dark
// gradient): a logo with a small label (channel or series), the title, the time
// beside a progress bar (on demand also a marker for a pending seek), the
// description and a line under the title (in place of the label: the channel,
// views, age...) when the user opened the bar (not when it appears by itself on a
// channel change or seek), a line for what comes next or the keys (led by the
// playing quality, e.g. "1080p · 50 fps"), and a message line for problems. It
// hides after a few seconds unless the player wants it to stay.

import { h, setSrc, setText } from '../core/dom.js';

var SHOW_MS = 5000;

export class PlayerOsd {
    private el: HTMLElement;
    private head: HTMLElement;
    private logo: HTMLImageElement;
    private label: HTMLElement;
    private title: HTMLElement;
    private meta: HTMLElement;
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
    /** Where its content starts while shown (top(); 0: to be measured again, as what it shows changed) */
    private topAt = 0;
    /** Whether the description element is shown (as last set) */
    private textShown = true;
    /** Whether the line under the title is shown (as last set) */
    private metaShown = true;

    /** stay: asked when the time is up (true keeps the bar); onHide: called when it hides */
    constructor(root: HTMLElement, private stay: () => boolean, private onHide?: () => void) {
        this.el = h('div', 'osd');
        var head = this.head = h('div', 'osd-head');
        this.logo = h('img', 'osd-logo') as HTMLImageElement;
        this.label = h('div', 'osd-channel');
        head.appendChild(this.logo);
        head.appendChild(this.label);
        this.title = h('div', 'osd-now');
        this.meta = h('div', 'osd-meta');
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
        this.el.appendChild(this.meta);
        this.el.appendChild(timeLine);
        this.el.appendChild(this.text);
        this.el.appendChild(line);
        this.el.appendChild(this.message);
        root.appendChild(this.el);
    }

    get shown(): boolean {
        return this.el.style.display === 'block';
    }

    /** Shown at the user's request (with the description) */
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

    /** Where its content starts while shown, under the shade above it (layout units from the top; 0: hidden): what
     * shows over the picture keeps above it (the live chat); measured once while it shows the same lines */
    top(): number {
        if (this.shown && !this.topAt) {
            this.topAt = this.el.getBoundingClientRect().top + (parseFloat(getComputedStyle(this.el).paddingTop) || 0);
        }
        return this.shown ? this.topAt : 0;
    }

    /** Shown: stays SHOW_MS more (the pointer moved, as YouTube's controls stay while it does) */
    keep(): void {
        if (this.shown) {
            this.show();
        }
    }

    hide(): void {
        clearTimeout(this.timer);
        this.withText = false;
        this.topAt = 0;
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

    /** Sets the line under the title (it begins with the label's channel); shown in the label's place if requested */
    setMeta(text: string): void {
        setText(this.meta, text);
        this.showText();
    }

    private showText(): void {
        var text = this.withText && !!this.text.textContent;
        if (text !== this.textShown) {
            this.textShown = text;
            this.topAt = 0;
            // '' keeps the theme's own display (a box clipped after four lines)
            this.text.style.display = text ? '' : 'none';
        }
        var meta = this.withText && !!this.meta.textContent;
        if (meta !== this.metaShown) {
            this.metaShown = meta;
            this.topAt = 0;
            this.meta.style.display = meta ? '' : 'none';
            this.head.style.display = meta ? 'none' : '';
        }
    }

    setLine(text: string): void {
        setText(this.lineText, text);
    }

    /** The playing picture's codec ("VP9"), height ("1080p") and frame rate, each when known; empty while nothing is
     * decoded */
    setQuality(height: number, frameRate: number, codec?: string): void {
        // When empty the tag hides itself (the theme's :empty rule)
        setText(this.quality, height ? (codec ? codec + '  ·  ' : '') + height + 'p' + (frameRate ? '  ·  ' + frameRate + ' fps' : '') : '');
    }

    setMessage(text: string): void {
        setText(this.message, text);
        this.topAt = 0;
    }
}
