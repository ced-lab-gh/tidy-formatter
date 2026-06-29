// Generates the Tidy Formatter extension ICON as a VALID PNG file.
//
// VS Code requires a real PNG (never an SVG renamed to .png) of at least
// 128x128. We render at 256x256 for crispness when the Marketplace downsamples
// it to the ~32px list size.
//
// Design (a PRO, swappable placeholder — final art can land later):
//   - A rounded-corner square filled with the brand teal #168F7D. Teal connotes
//     "clean / orderly" — the opposite of "breaks / destroys".
//   - A simple, high-contrast white glyph: three left-aligned horizontal bars
//     with rounded ends, decreasing in width top-to-bottom. It reads as
//     "neatly arranged text / tidy lines" and stays legible at 32px far better
//     than a thin letterform or a detailed broom would.
//   - Transparent pixels outside the rounded square so the mark sits cleanly on
//     both light and dark Marketplace themes (galleryBanner.theme = 'dark').
//   - Basic anti-aliasing (4x supersampling) keeps every edge smooth.
//
// ZERO new dependencies: the PNG is hand-encoded with Node's built-in `zlib`
// (IHDR + IDAT + IEND, RGBA truecolour+alpha, filter type 0 per scanline) with
// CRC-32 computed inline — same approach as media/walkthrough/build-placeholders.mjs.
// Reproducible: re-running overwrites media/icon.png deterministically.
//
// Usage (from the extension root):  node media/build-icon.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SIZE = 256; // final icon edge length in px (>=128 required; 256 = sharp at 32px)
const SS = 4; // supersampling factor for anti-aliasing
const W = SIZE * SS;
const H = SIZE * SS;

const OUT_PATH = join(dirname(fileURLToPath(import.meta.url)), 'icon.png');

// --- Brand palette ----------------------------------------------------------
const TEAL = [0x16, 0x8f, 0x7d]; // #168F7D — clean / orderly
const INK = [0xff, 0xff, 0xff]; // crisp white glyph on the teal field

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

// --- Coverage helpers (computed on the supersampled grid) -------------------
// Each shape returns 1 (inside) / 0 (outside) for a hi-res pixel; the 4x grid
// is then box-downsampled to the final size, which yields the anti-aliasing.

// Signed-distance-style test for a rounded rectangle. Returns true if (x,y) is
// inside a rect [x0,y0,x1,y1] whose corners are rounded with radius r.
function insideRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || y < y0 || x > x1 || y > y1) return false;
  // Distance from the inner core; only the four corner quadrants are clipped.
  const cx = x < x0 + r ? x0 + r : x > x1 - r ? x1 - r : x;
  const cy = y < y0 + r ? y0 + r : y > y1 - r ? y1 - r : y;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

// --- Geometry (in final-icon px, scaled up by SS) ---------------------------
const TILE_MARGIN = 14; // breathing room around the rounded tile
const TILE_RADIUS = 52; // generous corner radius -> friendly, "app icon" feel

const tile = {
  x0: TILE_MARGIN,
  y0: TILE_MARGIN,
  x1: SIZE - TILE_MARGIN,
  y1: SIZE - TILE_MARGIN,
  r: TILE_RADIUS
};

// Three "tidy lines": left-aligned bars, rounded ends, decreasing width.
const BAR_H = 26; // bar thickness
const BAR_RADIUS = BAR_H / 2; // fully rounded (pill) ends
const BAR_X0 = 74; // common left edge (alignment = "orderly")
const BAR_GAP = 30; // vertical gap between bars
const BAR_WIDTHS = [108, 80, 56]; // long, medium, short
const BARS_TOP = 92; // y of the first bar

const bars = BAR_WIDTHS.map((width, i) => {
  const y0 = BARS_TOP + i * (BAR_H + BAR_GAP);
  return { x0: BAR_X0, y0, x1: BAR_X0 + width, y1: y0 + BAR_H, r: BAR_RADIUS };
});

// --- Raster (RGBA) ----------------------------------------------------------
function blend(dst, o, color, a) {
  // src-over compositing of an opaque `color` at coverage `a` (0..1).
  const inv = 1 - a;
  dst[o] = Math.round(color[0] * a + dst[o] * inv);
  dst[o + 1] = Math.round(color[1] * a + dst[o + 1] * inv);
  dst[o + 2] = Math.round(color[2] * a + dst[o + 2] * inv);
  dst[o + 3] = Math.round(255 * a + dst[o + 3] * inv);
}

function render() {
  // Hi-res coverage masks (1 byte/px each): tile and glyph.
  const tileMask = new Uint8Array(W * H);
  const inkMask = new Uint8Array(W * H);

  for (let y = 0; y < H; y += 1) {
    const fy = y / SS;
    for (let x = 0; x < W; x += 1) {
      const fx = x / SS;
      const idx = y * W + x;
      if (insideRoundedRect(fx, fy, tile.x0, tile.y0, tile.x1, tile.y1, tile.r)) {
        tileMask[idx] = 1;
      }
      for (const b of bars) {
        if (insideRoundedRect(fx, fy, b.x0, b.y0, b.x1, b.y1, b.r)) {
          inkMask[idx] = 1;
          break;
        }
      }
    }
  }

  // Downsample (box filter) to final size with straight-alpha compositing.
  const out = Buffer.alloc(SIZE * SIZE * 4); // RGBA, starts fully transparent
  const cells = SS * SS;
  for (let oy = 0; oy < SIZE; oy += 1) {
    for (let ox = 0; ox < SIZE; ox += 1) {
      let tileCov = 0;
      let inkCov = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        const row = (oy * SS + sy) * W + ox * SS;
        for (let sx = 0; sx < SS; sx += 1) {
          const i = row + sx;
          tileCov += tileMask[i];
          inkCov += inkMask[i];
        }
      }
      const o = (oy * SIZE + ox) * 4;
      // Lay the teal tile first, then the white glyph on top.
      blend(out, o, TEAL, tileCov / cells);
      blend(out, o, INK, inkCov / cells);
    }
  }
  return out;
}

function encodePng(rgba) {
  // Prepend the per-scanline filter byte (0 = none) required by the PNG spec.
  const stride = SIZE * 4;
  const raw = Buffer.alloc((stride + 1) * SIZE);
  for (let y = 0; y < SIZE; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type 6 = truecolour with alpha (RGBA)
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

const png = encodePng(render());
writeFileSync(OUT_PATH, png);
// eslint-disable-next-line no-console
console.log(`icon.png: ${SIZE}x${SIZE} RGBA, ${png.length} bytes`);
