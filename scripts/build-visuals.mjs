// Generates the README "before / after" marketing visuals for the Marketplace
// listing as REAL PNG files (the Marketplace rewrites relative README image
// paths to raw.githubusercontent.com and reliably renders PNG — not always SVG,
// so PNG is what we ship).
//
// What it makes (into media/before-after/):
//   - css.png / css.svg  — messy.css  → Format Document → out/messy.css
//   - tsx.png / tsx.svg  — messy.tsx  → Format Document → out/messy.tsx
// Each is a 920px-wide, two-panel "Before" | "After — Tidy" card on a dark
// (#0d1117) field, monospace code, syntax highlighting, a brand-teal (#168F7D)
// accent on the Tidy side, and a caption. The TSX card additionally annotates
// that the JSX stayed valid and the `?.` / `??` operators were preserved.
//
// The content is REAL: it is read verbatim from this repo's samples/ folder
// (before) and samples/out/ folder (after) — the same inputs shown in README's
// "Before / after" section. Nothing is faked.
//
// Method: we build a self-contained SVG and rasterise it to PNG with
// @resvg/resvg-js (a devDependency — NOT a runtime dependency of the extension;
// it never ships in the VSIX). If the native rasteriser is unavailable, the
// script still writes the .svg files and prints a clear notice that the PNG
// rasterisation step remains to be run.
//
// Usage (from the extension root):  node scripts/build-visuals.mjs
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLES = join(ROOT, 'samples');
const OUT_DIR = join(ROOT, 'media', 'before-after');

// --- Layout constants (logical px; rasterised at 2x for crisp text) ----------
const W = 920;
const PAD = 22;
const GAP = 20;
const PANEL_W = (W - 2 * PAD - GAP) / 2;
const PANEL_LX = PAD;
const PANEL_RX = PAD + PANEL_W + GAP;
const PANELS_TOP = 66;
const HEADER = 40;
const CODE_TOP_PAD = 12;
const CODE_BOTTOM_PAD = 14;
const LINE_H = 21;
const FONT_SIZE = 13.5;
const CW = FONT_SIZE * 0.5498; // Consolas advance width (1126/2048 em) — monospace
const FIRST_BASELINE_OFFSET = 15;
const LEFT_PAD = 14;
const GUTTER_W = 20;
const CODE_TEXT_DX = LEFT_PAD + GUTTER_W + 16; // panelX -> first code glyph
const CAPTION_H = 34;
const RENDER_SCALE = 2;

// --- Palette (GitHub-dark-ish, brand teal for the Tidy side) -----------------
const C = {
  page: '#0d1117',
  panel: '#161b22',
  border: '#30363d',
  gutterDiv: '#21262d',
  teal: '#168F7D',
  tealLt: '#43c9b0',
  amber: '#f0883e',
  muted: '#8b949e',
  ink: '#c9d1d9',
  lineNo: '#484f58',
  kw: '#ff7b72',
  str: '#a5d6ff',
  fn: '#d2a8ff',
  num: '#79c0ff',
  attr: '#79c0ff',
  tag: '#7ee787',
  sel: '#d2a8ff',
  prop: '#79c0ff',
  punct: '#8b949e',
  op: '#43c9b0',
  comment: '#8b949e'
};

const MONO = "Consolas, 'Courier New', monospace";
const SANS = "'Segoe UI', 'Helvetica Neue', Arial, sans-serif";

// --- Tiny helpers ------------------------------------------------------------
function esc(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function round(n) {
  return Math.round(n * 100) / 100;
}
function readSample(rel) {
  // Normalise CRLF -> LF and drop a single trailing newline so line counts match.
  return readFileSync(join(SAMPLES, rel), 'utf8').replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
}

// --- Syntax tokenisers (return [{ t, c }] per line) --------------------------
// Layout is monospace + xml:space="preserve", so colouring can never shift a
// glyph: tspans simply flow left-to-right. Even an imperfect tokeniser is
// visually safe.

const CSS_KEYWORD_VALUES = new Set(['flex', 'block', 'inline', 'grid', 'none', 'auto', 'red', 'blue', 'green', 'underline']);

function tokenizeCss(lines) {
  let depth = 0; // 0 = selector context, >0 = declaration block
  let inValue = false;
  const out = [];
  for (const line of lines) {
    const toks = [];
    let i = 0;
    while (i < line.length) {
      const ch = line[i];
      if (ch === '/' && line[i + 1] === '*') {
        const end = line.indexOf('*/', i + 2);
        const j = end === -1 ? line.length : end + 2;
        toks.push({ t: line.slice(i, j), c: C.comment });
        i = j;
        continue;
      }
      if (/\s/.test(ch)) {
        let j = i;
        while (j < line.length && /\s/.test(line[j])) j += 1;
        toks.push({ t: line.slice(i, j), c: C.ink });
        i = j;
        continue;
      }
      if (ch === '{') {
        depth += 1;
        inValue = false;
        toks.push({ t: ch, c: C.punct });
        i += 1;
        continue;
      }
      if (ch === '}') {
        depth = Math.max(0, depth - 1);
        inValue = false;
        toks.push({ t: ch, c: C.punct });
        i += 1;
        continue;
      }
      if (ch === ';') {
        inValue = false;
        toks.push({ t: ch, c: C.punct });
        i += 1;
        continue;
      }
      if (ch === ':') {
        if (depth > 0) inValue = true;
        toks.push({ t: ch, c: C.punct });
        i += 1;
        continue;
      }
      if (ch === ',' || ch === '(' || ch === ')') {
        toks.push({ t: ch, c: C.punct });
        i += 1;
        continue;
      }
      // A run up to the next delimiter.
      let j = i;
      while (j < line.length && !'{};:,()/ \t'.includes(line[j])) j += 1;
      if (j === i) j = i + 1;
      const word = line.slice(i, j);
      let col;
      if (depth === 0) col = C.sel;
      else if (!inValue) col = C.prop;
      else if (/^-?[\d.]/.test(word)) col = C.num;
      else if (CSS_KEYWORD_VALUES.has(word)) col = C.num;
      else col = C.ink;
      toks.push({ t: word, c: col });
      i = j;
    }
    out.push(toks);
  }
  return out;
}

const TS_KEYWORDS = new Set([
  'import', 'from', 'export', 'default', 'function', 'return', 'const', 'let', 'var',
  'type', 'interface', 'new', 'extends', 'as', 'if', 'else', 'await', 'async'
]);

function tokenizeTsx(lines) {
  const out = [];
  for (const line of lines) {
    const toks = [];
    let i = 0;
    let prevSig = ''; // last non-space significant char emitted
    const pushSig = (t, c) => {
      toks.push({ t, c });
      const trimmed = t.trimEnd();
      if (trimmed) prevSig = trimmed[trimmed.length - 1];
    };
    while (i < line.length) {
      const ch = line[i];
      // whitespace
      if (/\s/.test(ch)) {
        let j = i;
        while (j < line.length && /\s/.test(line[j])) j += 1;
        toks.push({ t: line.slice(i, j), c: C.ink });
        i = j;
        continue;
      }
      // line comment
      if (ch === '/' && line[i + 1] === '/') {
        pushSig(line.slice(i), C.comment);
        i = line.length;
        continue;
      }
      // strings
      if (ch === '"' || ch === "'" || ch === '`') {
        const q = ch;
        let j = i + 1;
        while (j < line.length && line[j] !== q) j += 1;
        j = Math.min(j + 1, line.length);
        pushSig(line.slice(i, j), C.str);
        i = j;
        continue;
      }
      // preserved operators we want to spotlight
      if (ch === '?' && line[i + 1] === '.') {
        pushSig('?.', C.op);
        i += 2;
        continue;
      }
      if (ch === '?' && line[i + 1] === '?') {
        pushSig('??', C.op);
        i += 2;
        continue;
      }
      if (ch === '=' && line[i + 1] === '>') {
        pushSig('=>', C.kw);
        i += 2;
        continue;
      }
      // identifiers / numbers
      if (/[A-Za-z_$]/.test(ch)) {
        let j = i;
        while (j < line.length && /[\w$]/.test(line[j])) j += 1;
        const word = line.slice(i, j);
        // look ahead to next non-space char
        let k = j;
        while (k < line.length && /\s/.test(line[k])) k += 1;
        const next = line[k] || '';
        let col;
        if (TS_KEYWORDS.has(word)) col = C.kw;
        else if (prevSig === '<' || prevSig === '/') col = C.tag; // JSX tag name
        else if (next === '=' && line[k + 1] !== '=') col = C.attr; // JSX / obj attribute
        else if (next === '(') col = C.fn; // call
        else col = C.ink;
        pushSig(word, col);
        i = j;
        continue;
      }
      if (/[0-9]/.test(ch)) {
        let j = i;
        while (j < line.length && /[\w.]/.test(line[j])) j += 1;
        pushSig(line.slice(i, j), C.num);
        i = j;
        continue;
      }
      // punctuation (single char)
      pushSig(ch, C.punct);
      i += 1;
    }
    out.push(toks);
  }
  return out;
}

// --- SVG builders ------------------------------------------------------------
function codeLineSvg(x, y, toks) {
  const spans = toks.map((tk) => `<tspan fill="${tk.c}">${esc(tk.t)}</tspan>`).join('');
  return `<text x="${round(x)}" y="${round(y)}" font-family="${MONO}" font-size="${FONT_SIZE}" xml:space="preserve">${spans}</text>`;
}

function panelSvg({ x, tokenLines, nLinesMax, title, titleColor, dotColor, filename, teal, clipId, fadeId }) {
  const codeTop = PANELS_TOP + HEADER + CODE_TOP_PAD;
  const panelH = HEADER + CODE_TOP_PAD + nLinesMax * LINE_H + CODE_BOTTOM_PAD;
  const divY = PANELS_TOP + HEADER;
  const parts = [];
  // panel card
  parts.push(`<rect x="${x}" y="${PANELS_TOP}" width="${PANEL_W}" height="${round(panelH)}" rx="8" fill="${C.panel}" stroke="${C.border}"/>`);
  // header divider
  parts.push(`<line x1="${x}" y1="${divY}" x2="${x + PANEL_W}" y2="${divY}" stroke="${C.border}"/>`);
  // teal liseré down the Tidy side
  if (teal) {
    parts.push(`<rect x="${x + 0.5}" y="${PANELS_TOP + 1}" width="3" height="${round(panelH - 2)}" rx="1.5" fill="${C.teal}"/>`);
  }
  // header: status dot + label
  const hMid = PANELS_TOP + HEADER / 2;
  parts.push(`<circle cx="${x + 18}" cy="${round(hMid)}" r="5" fill="${dotColor}"/>`);
  parts.push(`<text x="${x + 32}" y="${round(hMid + 4.5)}" font-family="${SANS}" font-size="13" font-weight="600" fill="${titleColor}">${esc(title)}</text>`);
  // header: filename pill (right aligned)
  const pillW = 12 + filename.length * 7.2;
  const pillX = x + PANEL_W - pillW - 12;
  parts.push(`<rect x="${round(pillX)}" y="${round(hMid - 10)}" width="${round(pillW)}" height="20" rx="6" fill="${C.page}" stroke="${C.border}"/>`);
  parts.push(`<text x="${round(pillX + pillW / 2)}" y="${round(hMid + 4)}" text-anchor="middle" font-family="${MONO}" font-size="11.5" fill="${C.muted}">${esc(filename)}</text>`);
  // gutter divider
  const divX = x + LEFT_PAD + GUTTER_W + 8;
  parts.push(`<line x1="${round(divX)}" y1="${round(codeTop - 4)}" x2="${round(divX)}" y2="${round(PANELS_TOP + panelH - 8)}" stroke="${C.gutterDiv}"/>`);
  // code lines + line numbers, clipped to the panel interior so overlong
  // unformatted lines are cleanly truncated at the panel edge (not overpainted).
  const codeX = x + CODE_TEXT_DX;
  const lineNoX = x + LEFT_PAD + GUTTER_W;
  const code = [];
  tokenLines.forEach((toks, idx) => {
    const baseline = codeTop + FIRST_BASELINE_OFFSET + idx * LINE_H;
    code.push(`<text x="${round(lineNoX)}" y="${round(baseline)}" text-anchor="end" font-family="${MONO}" font-size="11.5" fill="${C.lineNo}">${idx + 1}</text>`);
    code.push(codeLineSvg(codeX, baseline, toks));
  });
  parts.push(`<g clip-path="url(#${clipId})">\n${code.join('\n')}\n</g>`);
  // right-edge fade signalling "long line continues off-screen" (Before side)
  if (fadeId) {
    parts.push(`<rect x="${round(x + PANEL_W - 48)}" y="${round(divY + 1)}" width="46" height="${round(panelH - HEADER - 2)}" fill="url(#${fadeId})"/>`);
  }
  return { svg: parts.join('\n'), panelH, codeTop, codeX, divY };
}

function titleBarSvg(filename) {
  const parts = [];
  // mini icon echo: teal tile + 3 white bars
  parts.push(`<rect x="${PAD}" y="22" width="26" height="26" rx="7" fill="${C.teal}"/>`);
  const barX = PAD + 6;
  [13, 9, 6].forEach((wd, i) => {
    parts.push(`<rect x="${barX}" y="${29 + i * 6}" width="${wd}" height="3.2" rx="1.6" fill="#ffffff"/>`);
  });
  parts.push(`<text x="${PAD + 38}" y="41" font-family="${SANS}" font-size="17" font-weight="700" fill="#e6edf3">Tidy Formatter</text>`);
  parts.push(`<text x="${W - PAD}" y="41" text-anchor="end" font-family="${SANS}" font-size="12.5" fill="${C.muted}">Format Document  ·  ${esc(filename)}</text>`);
  return parts.join('\n');
}

function checkMarkSvg(cx, cy) {
  return `<polyline points="${round(cx)},${round(cy + 0.5)} ${round(cx + 3)},${round(cy + 3.5)} ${round(cx + 8)},${round(cy - 2.5)}" fill="none" stroke="${C.teal}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`;
}

function captionSvg(y, text) {
  const parts = [];
  parts.push(`<rect x="${PAD}" y="${round(y)}" width="${W - 2 * PAD}" height="${CAPTION_H}" rx="8" fill="${C.panel}" stroke="${C.border}"/>`);
  parts.push(`<rect x="${PAD + 1}" y="${round(y + 1)}" width="3" height="${CAPTION_H - 2}" rx="1.5" fill="${C.teal}"/>`);
  const midY = y + CAPTION_H / 2;
  parts.push(checkMarkSvg(PAD + 16, midY));
  parts.push(`<text x="${PAD + 34}" y="${round(midY + 4.5)}" font-family="${SANS}" font-size="12.5" fill="#adbac7">${esc(text)}</text>`);
  return parts.join('\n');
}

// Underline the `?.` and `??` operators in the After-TSX panel (the annotation);
// the caption strip carries the wording, these draw the eye to the exact tokens.
function operatorUnderlinesSvg(afterLines, codeX, codeTop) {
  const parts = [];
  const idx = afterLines.findIndex((l) => l.includes('?.') && l.includes('??'));
  if (idx === -1) return '';
  const line = afterLines[idx];
  const baseline = codeTop + FIRST_BASELINE_OFFSET + idx * LINE_H;
  const uy = baseline + 3.5;
  const marks = [
    { col: line.indexOf('?.'), len: 2 },
    { col: line.indexOf('??'), len: 2 }
  ];
  for (const m of marks) {
    if (m.col < 0) continue;
    const x1 = codeX + m.col * CW;
    const x2 = x1 + m.len * CW;
    parts.push(`<line x1="${round(x1)}" y1="${round(uy)}" x2="${round(x2)}" y2="${round(uy)}" stroke="${C.tealLt}" stroke-width="1.8" stroke-linecap="round"/>`);
  }
  return parts.join('\n');
}

function buildSvg({ beforeRel, afterRel, filenameBefore, filenameAfter, tokenizer, caption, annotate }) {
  const beforeLines = readSample(beforeRel);
  const afterLines = readSample(afterRel);
  const beforeToks = tokenizer(beforeLines);
  const afterToks = tokenizer(afterLines);
  const nLinesMax = Math.max(beforeLines.length, afterLines.length);

  // Geometry needed for the clip rects (kept in sync with panelSvg).
  const divY = PANELS_TOP + HEADER;
  const panelH = HEADER + CODE_TOP_PAD + nLinesMax * LINE_H + CODE_BOTTOM_PAD;
  const clipY = divY + 1;
  const clipH = panelH - HEADER - 2;
  const clipW = PANEL_W - 2;
  const defs =
    `<defs>\n` +
    `<clipPath id="clipL"><rect x="${round(PANEL_LX + 1)}" y="${round(clipY)}" width="${round(clipW)}" height="${round(clipH)}"/></clipPath>\n` +
    `<clipPath id="clipR"><rect x="${round(PANEL_RX + 1)}" y="${round(clipY)}" width="${round(clipW)}" height="${round(clipH)}"/></clipPath>\n` +
    `<linearGradient id="fadeL" x1="0" y1="0" x2="1" y2="0">` +
    `<stop offset="0" stop-color="${C.panel}" stop-opacity="0"/>` +
    `<stop offset="1" stop-color="${C.panel}" stop-opacity="1"/></linearGradient>\n` +
    `</defs>`;

  const left = panelSvg({
    x: PANEL_LX,
    tokenLines: beforeToks,
    nLinesMax,
    title: 'Before',
    titleColor: C.muted,
    dotColor: C.amber,
    filename: filenameBefore,
    teal: false,
    clipId: 'clipL',
    fadeId: 'fadeL'
  });
  const right = panelSvg({
    x: PANEL_RX,
    tokenLines: afterToks,
    nLinesMax,
    title: 'After — Tidy',
    titleColor: C.tealLt,
    dotColor: C.teal,
    filename: filenameAfter,
    teal: true,
    clipId: 'clipR',
    fadeId: 'fadeL' // objectBoundingBox gradient — reused per-panel
  });

  const captionTop = PANELS_TOP + left.panelH + 16;
  const H = captionTop + CAPTION_H + 20;

  const body = [];
  body.push(`<rect x="0" y="0" width="${W}" height="${round(H)}" fill="${C.page}"/>`);
  body.push(defs);
  body.push(titleBarSvg(filenameBefore));
  body.push(left.svg);
  body.push(right.svg);
  if (annotate) {
    body.push(operatorUnderlinesSvg(afterLines, right.codeX, right.codeTop));
  }
  body.push(captionSvg(captionTop, caption));

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${round(H)}" viewBox="0 0 ${W} ${round(H)}">\n${body.join('\n')}\n</svg>\n`;
  return { svg, W, H };
}

// --- Image definitions -------------------------------------------------------
const IMAGES = [
  {
    name: 'css',
    beforeRel: 'messy.css',
    afterRel: join('out', 'messy.css'),
    filenameBefore: 'messy.css',
    filenameAfter: 'messy.css',
    tokenizer: tokenizeCss,
    caption: 'calc() and the >  combinator survive · rules become readable · verified against a PostCSS tree.',
    annotate: null
  },
  {
    name: 'tsx',
    beforeRel: 'messy.tsx',
    afterRel: join('out', 'messy.tsx'),
    filenameBefore: 'messy.tsx',
    filenameAfter: 'messy.tsx',
    tokenizer: tokenizeTsx,
    caption: 'JSX stays valid — <div /> never becomes < div / > · ?. and ?? preserved · AST-equivalence verified.',
    annotate: true
  }
];

// --- Run ---------------------------------------------------------------------
async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const built = [];
  for (const def of IMAGES) {
    const { svg, W: w, H: h } = buildSvg(def);
    const svgPath = join(OUT_DIR, `${def.name}.svg`);
    writeFileSync(svgPath, svg);
    built.push({ def, svg, w, h, svgPath });
    // eslint-disable-next-line no-console
    console.log(`${def.name}.svg: ${round(w)}x${round(h)} logical`);
  }

  // Rasterise to PNG with the @resvg/resvg-js devDependency, if present.
  let Resvg;
  try {
    ({ Resvg } = await import('@resvg/resvg-js'));
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      '\n[build-visuals] @resvg/resvg-js is not installed — wrote SVGs only.\n' +
        '                PNG rasterisation is STILL PENDING. Install the devDependency and re-run:\n' +
        '                  npm install -D @resvg/resvg-js && node scripts/build-visuals.mjs\n'
    );
    return;
  }

  const fontFiles = ['consola.ttf', 'consolab.ttf', 'segoeui.ttf', 'seguisb.ttf', 'segoeuib.ttf']
    .map((f) => `C:/Windows/Fonts/${f}`)
    .filter((p) => existsSync(p));

  for (const b of built) {
    const resvg = new Resvg(b.svg, {
      font: { loadSystemFonts: true, defaultFontFamily: 'Consolas', fontFiles },
      fitTo: { mode: 'width', value: Math.round(b.w * RENDER_SCALE) }
    });
    const png = resvg.render().asPng();
    const pngPath = join(OUT_DIR, `${b.def.name}.png`);
    writeFileSync(pngPath, png);
    // eslint-disable-next-line no-console
    console.log(`${b.def.name}.png: ${Math.round(b.w * RENDER_SCALE)}px wide, ${png.length} bytes`);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[build-visuals] failed:', err);
  process.exit(1);
});
