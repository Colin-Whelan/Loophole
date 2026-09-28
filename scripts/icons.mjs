// Rasterises the Workbench diamond mark (the #wbmark symbol in design/workbench-mockup.html) to
// src/icons/icon-{16,32,48,128}.png using only Node built-ins. Run once; the PNGs are committed.
//
// Mark, in a 32×32 viewBox:
//   rounded square  x=1 y=1 w=30 h=30 rx=7, fill #0d8a7e
//   diamond outline M16 6 L26 16 L16 26 L6 16 Z, white stroke 2.4, round joins
//   inner diamond   M16 11.5 L20.5 16 L16 20.5 L11.5 16 Z, white fill

import { deflateSync } from 'node:zlib';
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'icons');
const SIZES = [16, 32, 48, 128];
const SAMPLES = 16; // SAMPLES×SAMPLES supersampling per pixel
const TEAL = [0x0d, 0x8a, 0x7e];
const WHITE = [0xff, 0xff, 0xff];

// ── Geometry (viewBox units) ─────────────────────────────────────────────

function inRoundedRect(x, y) {
  const x0 = 1, y0 = 1, x1 = 31, y1 = 31, r = 7;
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

const OUTER = [[16, 6], [26, 16], [16, 26], [6, 16]];
// Round joins: the stroke is every point within half the stroke width of an edge.
function onOutline(x, y) {
  const half = 2.4 / 2;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = OUTER[i];
    const [bx, by] = OUTER[(i + 1) % 4];
    if (distToSegment(x, y, ax, ay, bx, by) <= half) return true;
  }
  return false;
}

function inInnerDiamond(x, y) {
  return Math.abs(x - 16) + Math.abs(y - 16) <= 4.5;
}

/** Colour at a viewBox point: null (transparent), TEAL or WHITE. Later layers paint over earlier. */
function sample(x, y) {
  let c = null;
  if (inRoundedRect(x, y)) c = TEAL;
  if (onOutline(x, y) || inInnerDiamond(x, y)) c = WHITE; // white is drawn on top of the teal
  return c;
}

function render(size) {
  const px = new Uint8Array(size * size * 4);
  const scale = 32 / size;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      // Accumulate premultiplied colour, then un-premultiply for straight-alpha PNG.
      let r = 0, g = 0, b = 0, a = 0;
      for (let sj = 0; sj < SAMPLES; sj++) {
        for (let si = 0; si < SAMPLES; si++) {
          const c = sample((i + (si + 0.5) / SAMPLES) * scale, (j + (sj + 0.5) / SAMPLES) * scale);
          if (!c) continue;
          r += c[0]; g += c[1]; b += c[2]; a += 1;
        }
      }
      const o = (j * size + i) * 4;
      const n = SAMPLES * SAMPLES;
      if (a) {
        px[o] = Math.round(r / a);
        px[o + 1] = Math.round(g / a);
        px[o + 2] = Math.round(b / a);
        px[o + 3] = Math.round((a / n) * 255);
      }
    }
  }
  return px;
}

// ── PNG encoder (RGBA8, no interlace, filter 0) ──────────────────────────

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
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

await mkdir(OUT, { recursive: true });
for (const size of SIZES) {
  const file = path.join(OUT, `icon-${size}.png`);
  await writeFile(file, encodePng(size, render(size)));
  console.log(`[icons] ${path.relative(process.cwd(), file)}`);
}
