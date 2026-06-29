// Generates the 4 walkthrough step placeholder images as VALID PNG files
// (not SVG renamed to .png — the Marketplace rejects those).
//
// These are intentionally plain placeholders for AXE 1; the final art lands in
// AXE 2. Each is a solid-background 600x300 PNG with a thin accent band and a
// 5x7 bitmap-font caption, kept well under 30 KB.
//
// ZERO new dependencies: the PNG is hand-encoded with Node's built-in `zlib`
// (IHDR + IDAT + IEND, RGB truecolour, filter type 0 per scanline) and the
// CRC-32 / Adler are computed inline. Reproducible: re-running overwrites the
// four PNGs byte-for-byte.
//
// Usage (from the extension root):  node media/walkthrough/build-placeholders.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const WIDTH = 600;
const HEIGHT = 300;
const OUT_DIR = dirname(fileURLToPath(import.meta.url));

// --- CRC-32 (PNG chunk checksum) -------------------------------------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

// --- 5x7 bitmap font (uppercase A-Z, digits, space, dash) ------------------
// Each glyph is 7 rows of a 5-bit mask. Enough for the short captions below.
const FONT = {
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  D: [0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f],
  H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11],
  N: [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d],
  R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e],
  T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x1b, 0x11],
  X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  Y: [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04],
  Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
  '0': [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  '1': [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  '2': [0x0e, 0x11, 0x01, 0x06, 0x08, 0x10, 0x1f],
  '3': [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  '4': [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  '-': [0x00, 0x00, 0x00, 0x1f, 0x00, 0x00, 0x00],
  ' ': [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
};

// --- raster helpers ---------------------------------------------------------
function makeCanvas(bg) {
  const px = Buffer.alloc(WIDTH * HEIGHT * 3);
  for (let i = 0; i < WIDTH * HEIGHT; i += 1) {
    px[i * 3] = bg[0];
    px[i * 3 + 1] = bg[1];
    px[i * 3 + 2] = bg[2];
  }
  return px;
}

function setPixel(px, x, y, color) {
  if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) return;
  const o = (y * WIDTH + x) * 3;
  px[o] = color[0];
  px[o + 1] = color[1];
  px[o + 2] = color[2];
}

function fillRect(px, x0, y0, w, h, color) {
  for (let y = y0; y < y0 + h; y += 1) {
    for (let x = x0; x < x0 + w; x += 1) {
      setPixel(px, x, y, color);
    }
  }
}

function drawText(px, text, x0, y0, scale, color) {
  let cx = x0;
  for (const rawCh of text.toUpperCase()) {
    const glyph = FONT[rawCh] ?? FONT[' '];
    for (let row = 0; row < 7; row += 1) {
      const bits = glyph[row];
      for (let col = 0; col < 5; col += 1) {
        if (bits & (1 << (4 - col))) {
          fillRect(px, cx + col * scale, y0 + row * scale, scale, scale, color);
        }
      }
    }
    cx += 6 * scale; // 5px glyph + 1px gap
  }
}

function encodePng(px) {
  // Prepend the per-scanline filter byte (0 = none) required by the PNG spec.
  const stride = WIDTH * 3;
  const raw = Buffer.alloc((stride + 1) * HEIGHT);
  for (let y = 0; y < HEIGHT; y += 1) {
    raw[y * (stride + 1)] = 0;
    px.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(WIDTH, 0);
  ihdr.writeUInt32BE(HEIGHT, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type 2 = truecolour RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// --- the four step placeholders --------------------------------------------
const ACCENT = [38, 139, 210]; // single brand-ish blue accent
const INK = [222, 230, 238];
const MUTED = [140, 158, 176];

const STEPS = [
  { file: 'safety.png', bg: [16, 24, 34], title: 'SAFETY', sub: 'AST GUARD NEVER CORRUPTS' },
  { file: 'choose.png', bg: [20, 28, 38], title: 'CHOOSE TIDY', sub: 'USE AS MY FORMATTER' },
  { file: 'formatonsave.png', bg: [18, 26, 36], title: 'FORMAT ON SAVE', sub: 'YOU TURN IT ON NOT TIDY' },
  { file: 'migration.png', bg: [22, 30, 40], title: 'MIGRATION', sub: 'FROM JS CSS HTML FORMATTER' }
];

for (const step of STEPS) {
  const px = makeCanvas(step.bg);
  // top accent band
  fillRect(px, 0, 0, WIDTH, 8, ACCENT);
  // accent tick next to the title
  fillRect(px, 40, 92, 10, 56, ACCENT);
  drawText(px, step.title, 66, 96, 6, INK);
  drawText(px, step.sub, 66, 168, 3, MUTED);
  drawText(px, 'TIDY FORMATTER  PLACEHOLDER', 66, 250, 2, MUTED);
  const png = encodePng(px);
  const outPath = join(OUT_DIR, step.file);
  writeFileSync(outPath, png);
  // eslint-disable-next-line no-console
  console.log(`${step.file}: ${png.length} bytes`);
}
