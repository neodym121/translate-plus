// Renders extension/icons/icon{16,32,48,128}.png from the geometry of
// 01-bilingual-lines.svg. Chrome does not accept SVG in manifest icons, and this
// keeps the build free of dependencies: a small anti-aliased rasteriser + PNG writer.
//
//   node tools/make-icons.mjs
import { deflateSync, crc32 } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'icons');

// Same shapes as the SVG (256 x 256 viewBox): [x0, y0, x1, y1, radius, colour]
const SHAPES = [
  [16, 16, 240, 240, 56, [0x0b, 0x0b, 0x0b]],
  [67, 49, 189, 75, 13, [0xff, 0xff, 0xff]],
  [67, 93, 133, 119, 13, [0xe3, 0x12, 0x0b]],
  [67, 137, 189, 163, 13, [0xff, 0xff, 0xff]],
  [67, 181, 133, 207, 13, [0xe3, 0x12, 0x0b]],
];

function inside(px, py, [x0, y0, x1, y1, r]) {
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const qx = Math.abs(px - cx) - ((x1 - x0) / 2 - r);
  const qy = Math.abs(py - cy) - ((y1 - y0) / 2 - r);
  const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
  return d <= 0;
}

function render(size, ss = 6) {
  const px = Buffer.alloc(size * size * 4);
  const scale = 256 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const fx = (x + (sx + 0.5) / ss) * scale;
          const fy = (y + (sy + 0.5) / ss) * scale;
          let hit = null;
          for (const s of SHAPES) if (inside(fx, fy, s)) hit = s[5];
          if (hit) { r += hit[0]; g += hit[1]; b += hit[2]; a += 1; }
        }
      }
      const o = (y * size + x) * 4;
      if (a > 0) {
        px[o] = Math.round(r / a);
        px[o + 1] = Math.round(g / a);
        px[o + 2] = Math.round(b / a);
        px[o + 3] = Math.round((a / (ss * ss)) * 255);
      }
    }
  }
  return px;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    rows[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(ROOT, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const file = join(ROOT, `icon${size}.png`);
  writeFileSync(file, png(size, render(size)));
  console.log('wrote', file);
}
