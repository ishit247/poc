// Builds a valid solid-colour PNG, for seed data and tests. Node only (uses zlib); not part of the app bundle.
import { crc32, deflateSync } from 'node:zlib';

const chunk = (type: string, data: Buffer): Buffer => {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
};

export function solidPng(r: number, g: number, b: number, size = 32): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

type Rgb = readonly [number, number, number];

// Letter shapes, 5 wide by 7 tall, for the dev logos below.
const GLYPHS: Record<string, string[]> = {
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  J: ['00111', '00010', '00010', '00010', '10010', '10010', '01100'],
};

/**
 * A dev restaurant logo: a round badge in `bg`, one big white letter, and either a veg mark (square outline, dot) or a ring.
 * Edges are smoothed by sampling 3x3 points per pixel. PNG with a transparent corner, `size` pixels square.
 */
export function logoPng(bg: Rgb, letter: 'T' | 'J', mark: 'veg' | 'ring', size = 256): Buffer {
  const glyph = GLYPHS[letter]!;
  const cell = size / 16; // glyph is 5x7 cells, drawn a little above centre
  const gx = (size - 5 * cell) / 2, gy = size * 0.16;
  const c = size / 2, r = size / 2 - 2;
  const m = size * 0.075; // veg mark half-size, below the letter
  const my = size * 0.8;
  const inside = (x: number, y: number): 'out' | 'bg' | 'fg' => {
    const d = Math.hypot(x - c, y - c);
    if (d > r) return 'out';
    const gi = Math.floor((x - gx) / cell), gj = Math.floor((y - gy) / cell);
    if (gi >= 0 && gi < 5 && gj >= 0 && gj < 7 && glyph[gj]![gi] === '1') return 'fg';
    if (mark === 'ring') return d > r - size * 0.07 && d < r - size * 0.04 ? 'fg' : 'bg';
    const ax = Math.abs(x - c), ay = Math.abs(y - my);
    const box = Math.max(ax, ay);
    if ((box <= m && box >= m - size * 0.025) || Math.hypot(x - c, y - my) <= m * 0.5) return 'fg';
    return 'bg';
  };
  const rows: Buffer[] = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4); // filter byte 0, then RGBA
    for (let x = 0; x < size; x++) {
      let a = 0, f = 0;
      for (let sy = 0; sy < 3; sy++) for (let sx = 0; sx < 3; sx++) {
        const k = inside(x + (sx + 0.5) / 3, y + (sy + 0.5) / 3);
        if (k !== 'out') a++;
        if (k === 'fg') f++;
      }
      const o = 1 + x * 4;
      // Colour is the mix of white (fg samples) and bg over the covered samples; alpha is the covered share.
      const w = a ? f / a : 0;
      row[o] = Math.round(bg[0] * (1 - w) + 255 * w);
      row[o + 1] = Math.round(bg[1] * (1 - w) + 255 * w);
      row[o + 2] = Math.round(bg[2] * (1 - w) + 255 * w);
      row[o + 3] = Math.round((a / 9) * 255);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
