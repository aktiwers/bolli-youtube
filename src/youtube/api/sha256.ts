// SHA-256 and HMAC-SHA256: by the browser's Web Crypto, or in plain JS (FIPS 180-4, RFC 2104) on webOS TV 2.x's engine,
// which has none (crypto.subtle). For SponsorBlock's hashed video ids (api/sponsorblock.ts) and Onesie's signature
// (api/onesie.ts).

import { oldEngine } from '../core/platform.js';

/** The round constants: the first 32 bits of the fractional parts of the cube roots of the first 64 primes */
var K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];

function rotr(x: number, n: number): number {
    return x >>> n | x << 32 - n;
}

/** The SHA-256 digest of data (32 bytes) */
export function sha256(data: Uint8Array): Uint8Array {
    var hash = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    // Padded: a 1 bit, zeros, the length in bits (64 bits, big-endian) ending the last 64-byte block
    var length = data.length;
    var padded = new Uint8Array((length + 72 >> 6) << 6);
    padded.set(data);
    padded[length] = 0x80;
    var end = padded.length;
    var tail = new DataView(padded.buffer);
    tail.setUint32(end - 8, Math.floor(length / 0x20000000));
    tail.setUint32(end - 4, length << 3 >>> 0);
    var w = new Int32Array(64);
    for (var at = 0; at < end; at += 64) {
        for (var t = 0; t < 16; t++) {
            var i = at + t * 4;
            w[t] = padded[i] << 24 | padded[i + 1] << 16 | padded[i + 2] << 8 | padded[i + 3];
        }
        for (t = 16; t < 64; t++) {
            var x = w[t - 15];
            var y = w[t - 2];
            w[t] = w[t - 16] + (rotr(x, 7) ^ rotr(x, 18) ^ x >>> 3) + w[t - 7] + (rotr(y, 17) ^ rotr(y, 19) ^ y >>> 10) | 0;
        }
        var a = hash[0], b = hash[1], c = hash[2], d = hash[3], e = hash[4], f = hash[5], g = hash[6], h = hash[7];
        for (t = 0; t < 64; t++) {
            var t1 = h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + (e & f ^ ~e & g) + K[t] + w[t] | 0;
            var t2 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + (a & b ^ a & c ^ b & c) | 0;
            h = g;
            g = f;
            f = e;
            e = d + t1 | 0;
            d = c;
            c = b;
            b = a;
            a = t1 + t2 | 0;
        }
        hash[0] = hash[0] + a | 0;
        hash[1] = hash[1] + b | 0;
        hash[2] = hash[2] + c | 0;
        hash[3] = hash[3] + d | 0;
        hash[4] = hash[4] + e | 0;
        hash[5] = hash[5] + f | 0;
        hash[6] = hash[6] + g | 0;
        hash[7] = hash[7] + h | 0;
    }
    var out = new Uint8Array(32);
    var words = new DataView(out.buffer);
    for (var k = 0; k < 8; k++) {
        words.setUint32(k * 4, hash[k] >>> 0);
    }
    return out;
}

/** HMAC-SHA256 of data with key (32 bytes) */
export function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
    var block = key.length > 64 ? sha256(key) : key;
    var inner = new Uint8Array(64 + data.length);
    var outer = new Uint8Array(64 + 32);
    for (var i = 0; i < 64; i++) {
        var k = i < block.length ? block[i] : 0;
        inner[i] = k ^ 0x36;
        outer[i] = k ^ 0x5c;
    }
    inner.set(data, 64);
    outer.set(sha256(inner), 64);
    return sha256(outer);
}

/** The SHA-256 digest of data (Web Crypto's; plain JS on webOS TV 2.x's engine) */
export function digest(data: Uint8Array): Promise<Uint8Array> {
    if (oldEngine()) {
        return Promise.resolve(sha256(data));
    }
    // Chrome 38 takes the algorithm only as an object
    return Promise.resolve(crypto.subtle.digest({ name: 'SHA-256' }, data)).then(function (d) {
        return new Uint8Array(d as ArrayBuffer);
    });
}

/** Signs with HMAC-SHA256 under key (Web Crypto's, the key imported once; plain JS on webOS TV 2.x's engine) */
export function hmacSigner(key: Uint8Array): (data: Uint8Array) => Promise<Uint8Array> {
    if (oldEngine()) {
        return function (data) { return Promise.resolve(hmacSha256(key, data)); };
    }
    var subtle = crypto.subtle || (crypto as unknown as { webkitSubtle: SubtleCrypto }).webkitSubtle;
    var imported = Promise.resolve(subtle.importKey('raw', key, { name: 'HMAC', hash: { name: 'SHA-256' } } as any, false, ['sign']));
    return function (data) {
        return imported.then(function (k) {
            return subtle.sign({ name: 'HMAC' } as any, k, data);
        }).then(function (mac) {
            return new Uint8Array(mac as ArrayBuffer);
        });
    };
}
