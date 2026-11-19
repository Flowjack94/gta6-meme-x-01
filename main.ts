// gta6-meme-x-01 — "WASTED: 12 years waiting for GTA 6".
// A deterministic meme generator: Node 22 standard library only, no network,
// no wall clock, no randomness. It draws a Vice City sunset scene in code,
// composites the real make.fun ghost mark (assets/mark-on-dark-1024.png,
// used as it is), lettering it with a built-in bitmap font, and writes
// meme.png (1200 by 1200) plus a byte-for-byte copy of POST.json.
//
//   mkdir -p out && MAKEFUN_BOT_DIR=. MAKEFUN_OUTPUT_DIR=out node main.ts
//
// Outside the grader's container, MAKEFUN_BOT_DIR and MAKEFUN_OUTPUT_DIR
// stand in for /bot and /output. Running it twice writes byte-identical
// output: the encoder writes no timestamps and no ancillary chunks.

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';

const BOT_DIR = process.env.MAKEFUN_BOT_DIR ?? '/bot';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const W = 1200;
const H = 1200;

// ---------------------------------------------------------------------------
// PNG primitives: CRC32, chunk writing, encode, decode (stdlib only).
// ---------------------------------------------------------------------------

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

// Encode an RGBA buffer (width * height * 4 bytes) as a PNG. Filter 0 on
// every scanline, fixed deflate level: fully deterministic output.
function encodePng(rgba: Buffer, width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace: none
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0;
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// Paeth predictor, as the PNG spec defines it.
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// Decode a PNG file (bit depth 8, colour types 2 RGB and 6 RGBA,
// non-interlaced) into an RGBA buffer. Throws on anything else.
function decodePng(file: Buffer): { rgba: Buffer; width: number; height: number } {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!file.subarray(0, 8).equals(sig)) throw new Error('not a PNG file');
  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (off + 8 <= file.length) {
    const len = file.readUInt32BE(off);
    const type = file.toString('ascii', off + 4, off + 8);
    const data = file.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('interlaced PNG not supported');
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('only 8-bit PNG supported');
  if (colorType !== 2 && colorType !== 6) throw new Error('only RGB/RGBA PNG supported');
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  const rgba = Buffer.alloc(width * height * 4);
  let pos = 0;
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const row = Buffer.from(raw.subarray(pos, pos + stride));
    pos += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? row[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = row[x];
      if (filter === 1) v = (v + a) & 0xff;
      else if (filter === 2) v = (v + b) & 0xff;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) v = (v + paeth(a, b, c)) & 0xff;
      else if (filter !== 0) throw new Error('unknown PNG filter ' + filter);
      row[x] = v;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const s = x * channels;
      rgba[o] = row[s];
      rgba[o + 1] = row[s + 1];
      rgba[o + 2] = row[s + 2];
      rgba[o + 3] = channels === 4 ? row[s + 3] : 255;
    }
    prev = row;
  }
  return { rgba, width, height };
}

// ---------------------------------------------------------------------------
// Drawing helpers: pixels, fills, alpha compositing.
// ---------------------------------------------------------------------------

type RGB = [number, number, number];

function setPixel(buf: Buffer, x: number, y: number, r: number, g: number, b: number, a = 255): void {
  if (x < 0 || x >= W || y < 0 || y >= H) return;
  const o = (y * W + x) * 4;
  buf[o] = r;
  buf[o + 1] = g;
  buf[o + 2] = b;
  buf[o + 3] = a;
}

// Blend one source pixel over the canvas (source-over, premultiplied by sa).
function blendPixel(buf: Buffer, x: number, y: number, r: number, g: number, b: number, sa: number): void {
  if (x < 0 || x >= W || y < 0 || y >= H || sa <= 0) return;
  const o = (y * W + x) * 4;
  const da = buf[o + 3] / 255;
  const outA = sa + da * (1 - sa);
  if (outA <= 0) return;
  buf[o] = Math.round((r * sa + buf[o] * da * (1 - sa)) / outA);
  buf[o + 1] = Math.round((g * sa + buf[o + 1] * da * (1 - sa)) / outA);
  buf[o + 2] = Math.round((b * sa + buf[o + 2] * da * (1 - sa)) / outA);
  buf[o + 3] = Math.round(outA * 255);
}

function fillRect(buf: Buffer, x0: number, y0: number, x1: number, y1: number, c: RGB): void {
  for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) setPixel(buf, x, y, c[0], c[1], c[2]);
  }
}

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

function mix(c1: RGB, c2: RGB, t: number): RGB {
  return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
}

// ---------------------------------------------------------------------------
// Bitmap font: 5x7 glyphs, each row a 5-bit number, top row first.
// ---------------------------------------------------------------------------

const FONT: Record<string, number[]> = {
  A: [0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  B: [0b11110, 0b10001, 0b10001, 0b11110, 0b10001, 0b10001, 0b11110],
  C: [0b01110, 0b10001, 0b10000, 0b10000, 0b10000, 0b10001, 0b01110],
  D: [0b11110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b11110],
  E: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111],
  F: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b10000],
  G: [0b01110, 0b10001, 0b10000, 0b10111, 0b10001, 0b10001, 0b01111],
  H: [0b10001, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  I: [0b01110, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  J: [0b00111, 0b00010, 0b00010, 0b00010, 0b00010, 0b10010, 0b01100],
  K: [0b10001, 0b10010, 0b10100, 0b11000, 0b10100, 0b10010, 0b10001],
  L: [0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b11111],
  M: [0b10001, 0b11011, 0b10101, 0b10101, 0b10001, 0b10001, 0b10001],
  N: [0b10001, 0b11001, 0b10101, 0b10011, 0b10001, 0b10001, 0b10001],
  O: [0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  P: [0b11110, 0b10001, 0b10001, 0b11110, 0b10000, 0b10000, 0b10000],
  Q: [0b01110, 0b10001, 0b10001, 0b10001, 0b10101, 0b10010, 0b01101],
  R: [0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001],
  S: [0b01111, 0b10000, 0b10000, 0b01110, 0b00001, 0b00001, 0b11110],
  T: [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100],
  U: [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  V: [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01010, 0b00100],
  W: [0b10001, 0b10001, 0b10001, 0b10101, 0b10101, 0b11011, 0b10001],
  X: [0b10001, 0b10001, 0b01010, 0b00100, 0b01010, 0b10001, 0b10001],
  Y: [0b10001, 0b10001, 0b01010, 0b00100, 0b00100, 0b00100, 0b00100],
  Z: [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b10000, 0b11111],
  a: [0b00000, 0b00000, 0b01110, 0b00001, 0b01111, 0b10001, 0b01111],
  b: [0b10000, 0b10000, 0b11110, 0b10001, 0b10001, 0b10001, 0b11110],
  c: [0b00000, 0b00000, 0b01110, 0b10000, 0b10000, 0b10001, 0b01110],
  d: [0b00001, 0b00001, 0b01111, 0b10001, 0b10001, 0b10001, 0b01111],
  e: [0b00000, 0b00000, 0b01110, 0b10001, 0b11111, 0b10000, 0b01110],
  f: [0b00110, 0b01000, 0b01000, 0b11110, 0b01000, 0b01000, 0b01000],
  g: [0b00000, 0b01111, 0b10001, 0b10001, 0b01111, 0b00001, 0b01110],
  h: [0b10000, 0b10000, 0b11110, 0b10001, 0b10001, 0b10001, 0b10001],
  i: [0b00100, 0b00000, 0b01100, 0b00100, 0b00100, 0b00100, 0b01110],
  j: [0b00010, 0b00000, 0b00110, 0b00010, 0b00010, 0b10010, 0b01100],
  k: [0b10000, 0b10000, 0b10010, 0b10100, 0b11000, 0b10100, 0b10010],
  l: [0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  m: [0b00000, 0b00000, 0b11010, 0b10101, 0b10101, 0b10101, 0b10101],
  n: [0b00000, 0b00000, 0b11110, 0b10001, 0b10001, 0b10001, 0b10001],
  o: [0b00000, 0b00000, 0b01110, 0b10001, 0b10001, 0b10001, 0b01110],
  p: [0b00000, 0b11110, 0b10001, 0b10001, 0b11110, 0b10000, 0b10000],
  q: [0b00000, 0b01111, 0b10001, 0b10001, 0b01111, 0b00001, 0b00001],
  r: [0b00000, 0b00000, 0b10110, 0b11001, 0b10000, 0b10000, 0b10000],
  s: [0b00000, 0b00000, 0b01111, 0b10000, 0b01110, 0b00001, 0b11110],
  t: [0b01000, 0b01000, 0b11100, 0b01000, 0b01000, 0b01000, 0b00110],
  u: [0b00000, 0b00000, 0b10001, 0b10001, 0b10001, 0b10011, 0b01101],
  v: [0b00000, 0b00000, 0b10001, 0b10001, 0b10001, 0b01010, 0b00100],
  w: [0b00000, 0b00000, 0b10001, 0b10101, 0b10101, 0b10101, 0b01010],
  x: [0b00000, 0b00000, 0b10001, 0b01010, 0b00100, 0b01010, 0b10001],
  y: [0b00000, 0b00000, 0b10001, 0b10001, 0b01111, 0b00001, 0b01110],
  z: [0b00000, 0b00000, 0b11111, 0b00010, 0b00100, 0b01000, 0b11111],
  '0': [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110],
  '1': [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  '2': [0b01110, 0b10001, 0b00001, 0b00110, 0b01000, 0b10000, 0b11111],
  '3': [0b11110, 0b00001, 0b00001, 0b01110, 0b00001, 0b00001, 0b11110],
  '4': [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
  '5': [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110],
  '6': [0b01110, 0b10000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],
  '7': [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
  '8': [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
  '9': [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00001, 0b01110],
  ' ': [0b00000, 0b00000, 0b00000, 0b00000, 0b00000, 0b00000, 0b00000],
  '.': [0b00000, 0b00000, 0b00000, 0b00000, 0b00000, 0b01100, 0b01100],
  ',': [0b00000, 0b00000, 0b00000, 0b00000, 0b01100, 0b00100, 0b01000],
  '!': [0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00000, 0b00100],
  '?': [0b01110, 0b10001, 0b00001, 0b00110, 0b00100, 0b00000, 0b00100],
  "'": [0b00100, 0b00100, 0b01000, 0b00000, 0b00000, 0b00000, 0b00000],
  '-': [0b00000, 0b00000, 0b00000, 0b01110, 0b00000, 0b00000, 0b00000],
  ':': [0b00000, 0b01100, 0b01100, 0b00000, 0b01100, 0b01100, 0b00000],
  ';': [0b00000, 0b01100, 0b01100, 0b00000, 0b01100, 0b00100, 0b01000],
  '(': [0b00010, 0b00100, 0b01000, 0b01000, 0b01000, 0b00100, 0b00010],
  ')': [0b01000, 0b00100, 0b00010, 0b00010, 0b00010, 0b00100, 0b01000],
  '%': [0b11001, 0b11010, 0b00010, 0b00100, 0b01000, 0b01011, 0b10011],
  '/': [0b00001, 0b00010, 0b00010, 0b00100, 0b01000, 0b01000, 0b10000],
  $: [0b00100, 0b01111, 0b10100, 0b01110, 0b00101, 0b11110, 0b00100],
};

function textWidth(text: string, scale: number): number {
  return text.length * 6 * scale - scale;
}

function drawGlyph(buf: Buffer, ch: string, x: number, y: number, scale: number, c: RGB): void {
  const glyph = FONT[ch] ?? FONT['?'];
  for (let row = 0; row < 7; row++) {
    for (let col = 0; col < 5; col++) {
      if ((glyph[row] >> (4 - col)) & 1) {
        fillRect(buf, x + col * scale, y + row * scale, x + (col + 1) * scale, y + (row + 1) * scale, c);
      }
    }
  }
}

// Draw text with a solid outline: the outline pass stamps the glyph in the
// outline colour at eight offsets, then the fill pass on top.
function drawText(buf: Buffer, text: string, x: number, y: number, scale: number, fill: RGB, outline: RGB): void {
  const o = Math.max(1, Math.round(scale / 3));
  for (const [dx, dy] of [[-o, 0], [o, 0], [0, -o], [0, o], [-o, -o], [o, -o], [-o, o], [o, o]] as const) {
    let cx = x + dx;
    for (const ch of text) {
      drawGlyph(buf, ch, cx, y + dy, scale, outline);
      cx += 6 * scale;
    }
  }
  let cx = x;
  for (const ch of text) {
    drawGlyph(buf, ch, cx, y, scale, fill);
    cx += 6 * scale;
  }
}

function drawTextCentered(buf: Buffer, text: string, cx: number, y: number, scale: number, fill: RGB, outline: RGB): void {
  drawText(buf, text, cx - Math.floor(textWidth(text, scale) / 2), y, scale, fill, outline);
}

// ---------------------------------------------------------------------------
// The scene: Vice City sunset, drawn in code. Layout (1200x1200):
//   sky 0-700, ocean 700-830, road 830-1080, bottom strip 1080-1200.
//   top caption y 60, WASTED y 140-294, sun centre (600, 480) r 140,
//   ghost 500x500 centred at y 560-1060, in front of the sun.
// ---------------------------------------------------------------------------

const SKY_STOPS: Array<[number, RGB]> = [
  [0.0, [27, 16, 53]],
  [0.35, [123, 30, 107]],
  [0.6, [196, 28, 131]],
  [0.8, [255, 107, 53]],
  [1.0, [255, 196, 107]],
];

function skyColor(y: number): RGB {
  const t = y / 700;
  for (let i = 0; i < SKY_STOPS.length - 1; i++) {
    const [t0, c0] = SKY_STOPS[i];
    const [t1, c1] = SKY_STOPS[i + 1];
    if (t <= t1) return mix(c0, c1, (t - t0) / (t1 - t0));
  }
  return SKY_STOPS[SKY_STOPS.length - 1][1];
}

function drawSun(buf: Buffer): void {
  const cx = 600;
  const cy = 480;
  const r = 140;
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy > r * r) continue;
      // Synthwave scanlines: widening gaps toward the bottom of the disc.
      const below = y - cy;
      if (below > 0) {
        const gap = 4 + Math.floor(below / 22) * 3;
        const band = 14 + Math.floor(below / 22) * 3;
        if (below % band < gap && below > 18) continue;
      }
      const edge = Math.sqrt(dx * dx + dy * dy) / r;
      const c = mix([255, 233, 168], [255, 140, 80], edge);
      setPixel(buf, x, y, c[0], c[1], c[2]);
    }
  }
}

// Deterministic pseudo-random from an integer seed (no Math.random).
function hashNoise(n: number): number {
  let h = (n * 2654435761) >>> 0;
  h ^= h >>> 13;
  h = (h * 1274126177) >>> 0;
  h ^= h >>> 16;
  return h / 4294967295;
}

function drawSkyline(buf: Buffer): void {
  let x = 0;
  let i = 0;
  while (x < W) {
    const bw = 46 + Math.floor(hashNoise(i * 7 + 1) * 70);
    const bh = 40 + Math.floor(hashNoise(i * 7 + 2) * 110);
    const top = 700 - bh;
    fillRect(buf, x, top, Math.min(W, x + bw), 700, [24, 12, 34]);
    // A few lit windows, warm magenta and orange.
    for (let wy = top + 10; wy < 690; wy += 18) {
      for (let wx = x + 8; wx < Math.min(W, x + bw) - 8; wx += 16) {
        const n = hashNoise(i * 131 + wx * 3 + wy * 7);
        if (n > 0.72) setPixel(buf, wx, wy, n > 0.88 ? 255 : 196, n > 0.88 ? 196 : 28, n > 0.88 ? 107 : 131);
      }
    }
    // Rooftop antenna on some towers.
    if (hashNoise(i * 7 + 3) > 0.6) fillRect(buf, x + Math.floor(bw / 2) - 1, top - 22, x + Math.floor(bw / 2) + 1, top, [24, 12, 34]);
    x += bw + 6;
    i++;
  }
}

function drawOcean(buf: Buffer): void {
  for (let y = 700; y < 830; y++) {
    const c = mix([14, 124, 123], [8, 59, 74], (y - 700) / 130);
    for (let x = 0; x < W; x++) setPixel(buf, x, y, c[0], c[1], c[2]);
  }
  // Sun reflection: short warm dashes widening toward the viewer.
  for (let row = 0; row < 9; row++) {
    const y = 712 + row * 13;
    const half = 60 + row * 26;
    for (let x = 600 - half; x < 600 + half; x += 2) {
      const n = hashNoise(x * 5 + row * 91);
      if (n > 0.45) setPixel(buf, x, y, 255, 150 + Math.floor(n * 60), 90);
    }
  }
}

function drawRoad(buf: Buffer): void {
  fillRect(buf, 0, 830, W, 1080, [20, 16, 28]);
  // Kerb glow lines, magenta on the left, teal on the right.
  fillRect(buf, 0, 830, W, 834, [196, 28, 131]);
  fillRect(buf, 0, 1076, W, 1080, [14, 124, 123]);
  // Centre dashes, perspective: wider and taller toward the bottom.
  for (let row = 0; row < 6; row++) {
    const y = 856 + row * 38;
    const half = 14 + row * 8;
    fillRect(buf, 600 - half, y, 600 + half, y + 16 + row * 2, [232, 222, 190]);
  }
}

function drawDisc(buf: Buffer, cx: number, cy: number, r: number, c: RGB): void {
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy <= r * r) setPixel(buf, cx + dx, cy + dy, c[0], c[1], c[2]);
    }
  }
}

function drawPalm(buf: Buffer, baseX: number, baseY: number, h: number, lean: number): void {
  // Curved trunk: overlapping discs sampled every pixel, so it reads as one
  // continuous trunk instead of a dotted line.
  const steps = h;
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const x = Math.round(baseX + lean * t * t * 90 - 4 * Math.sin(t * 3));
    const y = Math.round(baseY - t * h);
    drawDisc(buf, x, y, Math.max(2, Math.round(9 - 6 * t)), [18, 10, 30]);
  }
  // Fronds: seven arcs fanning over the crown, each drawn as a continuous
  // drooping curve three pixels thick.
  const crownX = Math.round(baseX + lean * 90);
  const crownY = baseY - h;
  for (let f = 0; f < 7; f++) {
    const ang = (-160 + f * 23) * (Math.PI / 180);
    const len = 95 + (f % 3) * 12;
    let prevX = crownX;
    let prevY = crownY;
    for (let s = 1; s <= 48; s++) {
      const t = s / 48;
      const px = Math.round(crownX + Math.cos(ang) * len * t);
      const py = Math.round(crownY + Math.sin(ang) * len * t + 42 * t * t);
      // Fill the gap from the previous sample so the arc is unbroken.
      const dx = px - prevX;
      const dy = py - prevY;
      const n = Math.max(Math.abs(dx), Math.abs(dy), 1);
      for (let k = 0; k <= n; k++) {
        const ix = Math.round(prevX + (dx * k) / n);
        const iy = Math.round(prevY + (dy * k) / n);
        drawDisc(buf, ix, iy, 2, [18, 10, 30]);
      }
      prevX = px;
      prevY = py;
    }
  }
}

function drawVignette(buf: Buffer): void {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = (x - 600) / 600;
      const dy = (y - 600) / 600;
      const d = dx * dx + dy * dy;
      if (d > 0.72) {
        const a = Math.min(0.42, (d - 0.72) * 0.85);
        blendPixel(buf, x, y, 8, 4, 18, a);
      }
    }
  }
}

function drawScene(buf: Buffer): Buffer {
  for (let y = 0; y < 700; y++) {
    const c = skyColor(y);
    for (let x = 0; x < W; x++) setPixel(buf, x, y, c[0], c[1], c[2]);
  }
  drawSun(buf);
  drawSkyline(buf);
  drawOcean(buf);
  drawRoad(buf);
  // Palms framing the scene, left leaning right, right leaning left.
  drawPalm(buf, 96, 860, 470, 1);
  drawPalm(buf, 1104, 860, 430, -1);
  drawPalm(buf, 210, 850, 330, 1);
  drawPalm(buf, 990, 850, 300, -1);
  return buf;
}

// Composite an RGBA image onto the canvas with nearest-neighbour scaling
// (uniform scale only: the mark is never stretched or recoloured).
function compositeImage(buf: Buffer, img: { rgba: Buffer; width: number; height: number }, dx: number, dy: number, dw: number, dh: number): void {
  for (let y = 0; y < dh; y++) {
    const sy = Math.floor((y * img.height) / dh);
    for (let x = 0; x < dw; x++) {
      const sx = Math.floor((x * img.width) / dw);
      const so = (sy * img.width + sx) * 4;
      const sa = img.rgba[so + 3] / 255;
      if (sa <= 0) continue;
      blendPixel(buf, dx + x, dy + y, img.rgba[so], img.rgba[so + 1], img.rgba[so + 2], sa);
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

function main(): void {
  mkdirSync(OUTPUT_DIR, { recursive: true });

  // The meme itself.
  const canvas = Buffer.alloc(W * H * 4);
  for (let i = 3; i < canvas.length; i += 4) canvas[i] = 255;
  drawScene(canvas);

  // The make.fun ghost, large and centred below WASTED, in front of the sun.
  const ghost = decodePng(readFileSync(join(BOT_DIR, 'assets', 'mark-on-dark-1024.png')));
  const ghostSize = 500;
  compositeImage(canvas, ghost, Math.floor((W - ghostSize) / 2), 560, ghostSize, ghostSize);

  // Captions. White fill, black outline, GTA-style heavy lettering.
  const white: RGB = [245, 245, 240];
  const black: RGB = [10, 8, 12];
  drawTextCentered(canvas, '12 YEARS WAITING FOR GTA 6', 600, 60, 6, white, black);
  drawTextCentered(canvas, 'WASTED', 600, 140, 22, [228, 228, 220], black);

  // Bottom strip with the pitch.
  fillRect(canvas, 0, 1080, W, 1200, [13, 10, 20]);
  fillRect(canvas, 0, 1080, W, 1084, [196, 28, 131]);
  drawTextCentered(canvas, 'MY AGENT ALREADY EARNS ON make.fun', 600, 1118, 5, white, black);

  drawVignette(canvas);

  const png = encodePng(canvas, W, H);
  writeFileSync(join(OUTPUT_DIR, 'meme.png'), png);

  // POST.json is copied byte for byte; the program judges nothing about it.
  try {
    copyFileSync(join(BOT_DIR, 'POST.json'), join(OUTPUT_DIR, 'POST.json'));
  } catch (err) {
    console.error(`POST.json could not be copied from ${BOT_DIR}: ${(err as Error).message}`);
    process.exit(1);
  }

  const hash = createHash('sha256').update(png).digest('hex');
  console.log(`meme.png ${W}x${H} ${png.length} bytes sha256 ${hash}`);
}

main();
