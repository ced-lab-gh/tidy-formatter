#!/usr/bin/env node
// check-chunks.mjs - structural gate for the ADD-11 chunk layout.
//
// Verifies, AFTER `npm run compile` (production build), that:
//   1. dist/extension.js and the four chunks exist;
//   2. every file respects its frozen size ceiling;
//   3. dist/extension.js references each chunk via a runtime require literal;
//   4. dist/meta.json (host metafile) lists no input from a chunk-only
//      package, proving the host bundle did not re-absorb an engine;
//   5. the ceilings below and the frozen budgets in bundle-baseline.json agree,
//      so the two gates can never drift into contradicting each other.
// Exits non-zero with an actionable message on the first violation.
//
// Why this exists on top of check-bundle-size.mjs: that gate answers "did a
// file grow", this one answers "is the extension still SPLIT". Losing the split
// is invisible to a size check on the day a new static import quietly pulls
// Prettier back into the host bundle while every file stays under budget.
//
// Pure Node, ESM, zero dependencies. Safe to run from any working directory:
// every path is resolved relative to THIS file (same idiom as
// check-changelog.mjs).

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = dirname(scriptDir);

// Frozen ceilings in bytes (production, minified).
//
// extension.js carries the ADD-11 architectural budget (700 KiB): it is a
// DESIGN limit, not a calibration, and it does not move when the bundle merely
// grows a little. The four chunk ceilings were frozen from the first green
// production build as "measured size + 15%, rounded up to 10 KiB":
//   chunk-prettier    1 672 763 B  ->  1 925 120
//   chunk-guard-js      579 169 B  ->    675 840
//   chunk-guard-css      98 561 B  ->    122 880
//   chunk-guard-html    178 755 B  ->    215 040
// Regenerate only deliberately, in a reviewed diff, and update
// scripts/bundle-baseline.json in the same commit (check 5 enforces this).
const BUDGETS = [
  { file: "dist/extension.js", maxBytes: 700 * 1024 },
  { file: "dist/chunk-prettier.js", maxBytes: 1925120 },
  { file: "dist/chunk-guard-js.js", maxBytes: 675840 },
  { file: "dist/chunk-guard-css.js", maxBytes: 122880 },
  { file: "dist/chunk-guard-html.js", maxBytes: 215040 }
];

// node_modules path fragments that must never appear among the host
// metafile's inputs (posix-normalized before matching).
const CHUNK_ONLY_INPUT_FRAGMENTS = [
  "node_modules/prettier/",
  "node_modules/@babel/parser/",
  "node_modules/@babel/types/",
  "node_modules/postcss/",
  "node_modules/postcss-scss/",
  "node_modules/postcss-less/",
  "node_modules/parse5/"
];

function fail(message) {
  console.error(`check:chunks FAILED - ${message}`);
  process.exit(1);
}

// 1 + 2: existence and ceilings.
for (const budget of BUDGETS) {
  const filePath = join(rootDir, budget.file);
  if (!existsSync(filePath)) {
    fail(`${budget.file} is missing; run 'npm run compile' first`);
  }
  const size = statSync(filePath).size;
  if (size > budget.maxBytes) {
    fail(
      `${budget.file} is ${size} bytes, over its ${budget.maxBytes}-byte ceiling; ` +
        `if this growth is intentional, refreeze the ceiling in scripts/check-chunks.mjs`
    );
  }
}

// 3: the host must reference every chunk through a runtime require literal
// (string literals survive minification). This is what proves the
// tidy-chunk-rewrite plugin ran: without it esbuild would have INLINED the
// chunk into the host bundle and no such literal would exist.
const hostSource = readFileSync(join(rootDir, "dist/extension.js"), "utf8");
for (const budget of BUDGETS.slice(1)) {
  const literal = `./${budget.file.slice("dist/".length)}`;
  if (!hostSource.includes(literal)) {
    fail(
      `dist/extension.js never references '${literal}': the tidy-chunk-rewrite ` +
        `plugin did not run or the loader no longer targets this chunk`
    );
  }
}

// 4: the host metafile must not list any chunk-only package input.
const metaPath = join(rootDir, "dist/meta.json");
if (!existsSync(metaPath)) {
  fail("dist/meta.json is missing; the production build must emit the host metafile");
}
let meta;
try {
  meta = JSON.parse(readFileSync(metaPath, "utf8"));
} catch (err) {
  fail(`dist/meta.json is not valid JSON: ${err.message}`);
}
const inputs = Object.keys(meta.inputs ?? {}).map((p) => p.replace(/\\/g, "/"));
if (inputs.length === 0) {
  fail("dist/meta.json lists no inputs; the metafile was not produced by a real build");
}
for (const fragment of CHUNK_ONLY_INPUT_FRAGMENTS) {
  const hit = inputs.find((input) => input.includes(fragment));
  if (hit) {
    fail(`host bundle absorbed a chunk-only package: ${hit}`);
  }
}

// 5: the two frozen budget tables must agree. Both gates run in CI; letting
// them disagree would mean one silently stops protecting anything.
const baselinePath = join(rootDir, "scripts/bundle-baseline.json");
let baseline;
try {
  baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
} catch (err) {
  fail(`could not read/parse ${baselinePath}: ${err.message}`);
}
for (const budget of BUDGETS.slice(1)) {
  const name = budget.file.slice("dist/".length);
  const entry = baseline?.files?.[name];
  if (entry === undefined) {
    fail(
      `${name} has no entry in scripts/bundle-baseline.json; every shipped chunk ` +
        `must carry a frozen size budget there too`
    );
  }
  if (entry.maxBytes !== budget.maxBytes) {
    fail(
      `${name}: ceiling drift - scripts/check-chunks.mjs says ${budget.maxBytes} bytes ` +
        `but scripts/bundle-baseline.json says ${entry.maxBytes}; refreeze both together`
    );
  }
}

console.log(
  "check:chunks OK - host + 4 chunks present, ceilings met, split enforced"
);
