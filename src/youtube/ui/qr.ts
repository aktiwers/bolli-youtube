// QR codes with qrcode-generator (Kazuhiko Arase, MIT; vendor/qrcode.js).
// The library is loaded only when the first QR code is needed (the sign-in
// screen), so the rest of the app never pays for it.

import { uiScale } from '../core/dom.js';

interface QrCode {
    addData(data: string): void;
    make(): void;
    getModuleCount(): number;
    isDark(row: number, col: number): boolean;
}

type QrFactory = (typeNumber: number, level: string) => QrCode;

/** White modules around the code, as the QR standard asks */
var QUIET = 4;

var loading: Promise<QrFactory> | null = null;

function library(): Promise<QrFactory> {
    if (!loading) {
        loading = new Promise<QrFactory>(function (resolve, reject) {
            var script = document.createElement('script');
            script.src = 'vendor/qrcode.js';
            script.onload = function () {
                resolve((window as unknown as { qrcode: QrFactory }).qrcode);
            };
            script.onerror = function () {
                loading = null;
                reject();
            };
            document.head.appendChild(script);
        });
    }
    return loading;
}

/** Draw text as a QR code filling at most size x size layout units. Every
 * module is a whole number of screen pixels, so phones read it easily. */
export function drawQr(canvas: HTMLCanvasElement, text: string, size: number): Promise<void> {
    return library().then(function (qrcode) {
        var qr = qrcode(0, 'M');
        qr.addData(text);
        qr.make();
        var n = qr.getModuleCount();
        var scale = uiScale();
        var cell = Math.max(1, Math.floor(size * scale / (n + 2 * QUIET)));
        var pixels = cell * (n + 2 * QUIET);
        canvas.width = canvas.height = pixels;
        canvas.style.width = canvas.style.height = pixels / scale + 'px';
        var ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, pixels, pixels);
        ctx.fillStyle = '#000';
        for (var row = 0; row < n; row++) {
            for (var col = 0; col < n; col++) {
                if (qr.isDark(row, col)) {
                    ctx.fillRect((col + QUIET) * cell, (row + QUIET) * cell, cell, cell);
                }
            }
        }
    });
}
