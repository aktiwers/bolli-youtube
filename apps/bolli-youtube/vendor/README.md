# Third-party code in the app

| File | What | Version | Licence | Source |
|---|---|---|---|---|
| `qrcode.js` | QR Code Generator for JavaScript, by Kazuhiko Arase | 1.4.4 (npm `qrcode-generator`, sha1 63f771224854759329a99048806a53ed278740e7) | MIT, see `qrcode-LICENSE.txt` | https://github.com/kazuhikoarase/qrcode-generator |

`qrcode.js` is unchanged. It is plain ES5 (checked with acorn) and makes no network calls. The app loads it only when the login screen needs a QR code (`src/ui/qr.ts`).
