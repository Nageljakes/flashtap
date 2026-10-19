#!/usr/bin/env node
/**
 * Generates build/icon.png (512x512) and build/icon.ico (16-256px, PNG
 * entries) for the Windows installer — a yellow lightning bolt on a deep
 * purple rounded square. Pure Node (zlib), no image tooling required.
 *
 *   npm run icon
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'build');
mkdirSync(OUT, { recursive: true });

const SS = 4;               // supersampling factor
const SIZE = 512;
const W = SIZE * SS;

// ---------------------------------------------------------------- tiny PNG writer
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function pngEncode(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- drawing
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => Math.max(0, Math.min(1, v));

// rounded-square mask (full 512 coord space)
function insideRoundedSquare(x, y, size, radius) {
  const r = radius;
  const cx = Math.min(Math.max(x, r), size - r);
  const cy = Math.min(Math.max(y, r), size - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

// lightning bolt polygon in 0..1 coordinates
const BOLT = [
  [0.58, 0.055],
  [0.29, 0.555],
  [0.455, 0.555],
  [0.395, 0.955],
  [0.725, 0.425],
  [0.55, 0.425],
  [0.665, 0.055],
];
function insideBolt(x, y) {
  let inside = false;
  for (let i = 0, j = BOLT.length - 1; i < BOLT.length; j = i++) {
    const [xi, yi] = BOLT[i];
    const [xj, yj] = BOLT[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const px = new Float64Array(W * W * 4); // premultiplied-ish accumulation (0..1)
for (let y = 0; y < W; y++) {
  for (let x = 0; x < W; x++) {
    const u = (x + 0.5) / W;
    const v = (y + 0.5) / W;
    const i = (y * W + x) * 4;
    const sx = u * SIZE;
    const sy = v * SIZE;

    if (!insideRoundedSquare(sx, sy, SIZE, SIZE * 0.21)) continue;

    // purple gradient background
    const t = clamp01((v - 0.06) / 0.9);
    let r = lerp(0.28, 0.09, t);
    let g = lerp(0.17, 0.055, t);
    let b = lerp(0.62, 0.24, t);

    // subtle radial highlight top-left
    const hx = u - 0.32;
    const hy = v - 0.24;
    const glow = Math.max(0, 1 - Math.sqrt(hx * hx + hy * hy) * 2.1);
    r += glow * 0.16;
    g += glow * 0.08;
    b += glow * 0.2;

    // bolt with soft glow ring
    const dbx = (u - 0.5) / 0.42;
    const dby = (v - 0.5) / 0.46;
    const dist = Math.sqrt(dbx * dbx + dby * dby);

    if (insideBolt(u, v)) {
      // warm yellow with a hint of orange at the tip
      const warm = clamp01((v - 0.35) / 0.6);
      r = lerp(1.0, 1.0, warm);
      g = lerp(0.88, 0.72, warm);
      b = lerp(0.12, 0.05, warm);
    } else if (dist < 1.02) {
      const glowAmt = Math.max(0, 1 - dist / 1.02) * 0.25;
      r += glowAmt * 1.0;
      g += glowAmt * 0.8;
      b += glowAmt * 0.1;
    }

    px[i] = clamp01(r);
    px[i + 1] = clamp01(g);
    px[i + 2] = clamp01(b);
    px[i + 3] = 1;
  }
}

// downsample to 512
function downsample(src, srcW, targetW) {
  const f = srcW / targetW;
  const out = Buffer.alloc(targetW * targetW * 4);
  for (let y = 0; y < targetW; y++) {
    for (let x = 0; x < targetW; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < f; dy++) {
        for (let dx = 0; dx < f; dx++) {
          const i = (((y * f + dy) | 0) * srcW + ((x * f + dx) | 0)) * 4;
          r += src[i];
          g += src[i + 1];
          b += src[i + 2];
          a += src[i + 3];
        }
      }
      const n = f * f;
      const o = (y * targetW + x) * 4;
      out[o] = Math.round((r / n) * 255);
      out[o + 1] = Math.round((g / n) * 255);
      out[o + 2] = Math.round((b / n) * 255);
      out[o + 3] = Math.round((a / n) * 255);
    }
  }
  return out;
}

const big = downsample(px, W, SIZE);
const png512 = pngEncode(SIZE, SIZE, big);
writeFileSync(path.join(OUT, 'icon.png'), png512);

// downscale further for the .ico sizes
function resizeRGBA(src, srcSize, size) {
  const out = Buffer.alloc(size * size * 4);
  const f = srcSize / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      let count = 0;
      for (let dy = 0; dy < f; dy++) {
        for (let dx = 0; dx < f; dx++) {
          const i = (((y * f + dy) | 0) * srcSize + ((x * f + dx) | 0)) * 4;
          r += src[i];
          g += src[i + 1];
          b += src[i + 2];
          a += src[i + 3];
          count++;
        }
      }
      const o = (y * size + x) * 4;
      out[o] = Math.round(r / count);
      out[o + 1] = Math.round(g / count);
      out[o + 2] = Math.round(b / count);
      out[o + 3] = Math.round(a / count);
    }
  }
  return out;
}

const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = sizes.map((s) => ({
  size: s,
  png: pngEncode(s, s, s === SIZE ? big : resizeRGBA(big, SIZE, s)),
}));
const count = images.length;
const dir = Buffer.alloc(6 + count * 16);
dir.writeUInt16LE(0, 0);
dir.writeUInt16LE(1, 2);   // type: icon
dir.writeUInt16LE(count, 4);
let offset = dir.length;
images.forEach((img, idx) => {
  const e = 6 + idx * 16;
  dir[e] = img.size >= 256 ? 0 : img.size;
  dir[e + 1] = img.size >= 256 ? 0 : img.size;
  dir[e + 2] = 0;          // palette
  dir[e + 3] = 0;          // reserved
  dir.writeUInt16LE(1, e + 4);   // planes
  dir.writeUInt16LE(32, e + 6);  // bpp
  dir.writeUInt32LE(img.png.length, e + 8);
  dir.writeUInt32LE(offset, e + 12);
  offset += img.png.length;
});
const ico = Buffer.concat([dir, ...images.map((i) => i.png)]);
writeFileSync(path.join(OUT, 'icon.ico'), ico);

console.log(`✔ build/icon.png (${(png512.length / 1024).toFixed(1)} KB)`);
console.log(`✔ build/icon.ico (${(ico.length / 1024).toFixed(1)} KB, ${sizes.join('/')} px)`);
