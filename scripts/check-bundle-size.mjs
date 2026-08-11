#!/usr/bin/env node
// check-bundle-size.mjs - bundle size gate (ADD-09).
//
// Fails (exit 1) when:
//   - any shipped executable (.js/.wasm) in dist/ exceeds its FROZEN budget in
//     scripts/bundle-baseline.json (budgets are on the on-disk size: that is
//     what ships in the VSIX);
//   - a budgeted file is missing from dist/ (renamed or dropped silently, e.g.
//     losing one_ini_bg.wasm would break editorconfig at runtime);
//   - an executable with NO budget entry appears in dist/ (a chunk cannot land
//     without receiving its own budget, see ADD-11);
//   - dist/meta.json is missing or invalid (proof the production metafile
//     pipeline still works; scripts/analyze-bundle.mjs depends on it).
//
// The decision logic is the exported pure function collectBundleViolations,
// unit-tested in test/unit/tooling/checkBundleSize.test.ts; main() only does
// I/O. Pure Node, ESM, zero dependencies; every path resolves relative to THIS
// file, never process.cwd() (same discipline as check-changelog.mjs).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = dirname(scriptDir);
const distDir = join(rootDir, "dist");
const baselinePath = join(scriptDir, "bundle-baseline.json");
const metaPath = join(distDir, "meta.json");

/** dist/ files subject to a budget: everything executable that ships. */
const BUDGETED_EXTENSIONS = [".js", ".wasm"];

/**
 * Pure gate. `actualFiles` is [{ name, bytes }] for every budgeted-extension
 * file found in dist/; `baseline` is the parsed bundle-baseline.json.
 * Returns violations as [{ budget, detail }], empty when everything holds.
 */
export function collectBundleViolations(actualFiles, baseline) {
  const violations = [];
  const entries = baseline?.files;
  if (
    entries === null ||
    typeof entries !== "object" ||
    entries === undefined ||
    Object.keys(entries).length === 0
  ) {
    violations.push({
      budget: "baseline shape",
      detail: 'bundle-baseline.json has no "files" entries',
    });
    return violations;
  }

  const actualByName = new Map(actualFiles.map((file) => [file.name, file]));

  for (const [name, entry] of Object.entries(entries)) {
    const maxBytes = entry?.maxBytes;
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
      violations.push({
        budget: "baseline shape",
        detail: `${name}: maxBytes must be a positive number`,
      });
      continue;
    }
    const actual = actualByName.get(name);
    if (actual === undefined) {
      violations.push({
        budget: "budgeted file present in dist/",
        detail: `${name}: listed in bundle-baseline.json but missing from dist/ (renamed or dropped silently?)`,
      });
      continue;
    }
    if (actual.bytes > maxBytes) {
      violations.push({
        budget: `${name} <= ${maxBytes} bytes`,
        detail:
          `${name}: ${actual.bytes} bytes (${actual.bytes - maxBytes} over). ` +
          `Shrink it, or raise the frozen budget in scripts/bundle-baseline.json in a REVIEWED diff.`,
      });
    }
  }

  for (const file of actualFiles) {
    if (!Object.prototype.hasOwnProperty.call(entries, file.name)) {
      violations.push({
        budget: "every dist/ executable is budgeted",
        detail: `${file.name}: present in dist/ with no entry in scripts/bundle-baseline.json (add a budget for it)`,
      });
    }
  }

  return violations;
}

function fail(message) {
  console.error(`check:bundle FAILED - ${message}`);
  process.exit(1);
}

function main() {
  if (!existsSync(distDir)) {
    fail(`dist/ not found at ${distDir}. Run \`npm run compile\` first.`);
  }
  if (!existsSync(metaPath)) {
    fail(
      "dist/meta.json missing. Run `npm run compile` (the production build " +
        "writes the esbuild metafile; see esbuild.js).",
    );
  }
  try {
    JSON.parse(readFileSync(metaPath, "utf8"));
  } catch (err) {
    fail(`dist/meta.json is not valid JSON: ${err.message}`);
  }

  let baseline;
  try {
    baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  } catch (err) {
    fail(`could not read/parse ${baselinePath}: ${err.message}`);
  }

  const actualFiles = readdirSync(distDir)
    .filter((name) => BUDGETED_EXTENSIONS.some((ext) => name.endsWith(ext)))
    .map((name) => ({ name, bytes: statSync(join(distDir, name)).size }));

  console.log("dist/ size budgets (frozen in scripts/bundle-baseline.json):");
  for (const file of actualFiles) {
    const budget = baseline?.files?.[file.name]?.maxBytes;
    const budgetLabel = Number.isFinite(budget) ? String(budget) : "UNBUDGETED";
    console.log(
      `  ${file.name.padEnd(24)} ${String(file.bytes).padStart(10)} / ${budgetLabel} bytes`,
    );
  }

  const violations = collectBundleViolations(actualFiles, baseline);
  if (violations.length === 0) {
    console.log(
      "check:bundle OK - every dist/ executable is within its frozen budget.",
    );
    return;
  }
  console.error(`check:bundle FAILED - ${violations.length} violation(s):`);
  for (const violation of violations) {
    console.error(`  - [${violation.budget}] ${violation.detail}`);
  }
  process.exit(1);
}

// Run main() only when executed directly; stay importable for unit tests.
const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main();
}
