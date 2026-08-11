#!/usr/bin/env node
// check-perf-regression.mjs - perf drift gate (ADD-09).
//
// Compares test/perf/results.json (written by `npm run perf`) against the
// VERSIONED test/perf/baseline.json. A case regresses when its measured p95
// exceeds baseline p95 x REGRESSION_FACTOR, times CI_BUDGET_MULTIPLIER on CI
// (mirroring test/perf/perf.ts: shared runners are slower and noisier, and the
// baseline is generated on the reference dev machine). Consequence, stated
// plainly: the x1.35 local gate is the primary drift instrument; the CI gate
// (x1.35 x3) only catches gross regressions. Same trade-off perf.ts makes.
//
// Hard failures (exit 1): missing/corrupt results or baseline, baseline case
// absent from the results (a case was silently dropped), measured p95 over
// threshold. Soft (report only): a measured case absent from the baseline
// (adding a language must not chicken-and-egg the gate; adopt it via
// `npm run perf:baseline`), and guardShare drifting more than +0.15 absolute
// (guard share is a soft budget in perf.ts too).
//
// Decision logic = exported pure collectRegressionViolations, unit-tested in
// test/unit/tooling/checkPerfRegression.test.ts; main() only does I/O.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = dirname(scriptDir);
const resultsPath = join(rootDir, "test", "perf", "results.json");
const baselinePath = join(rootDir, "test", "perf", "baseline.json");

export const REGRESSION_FACTOR = 1.35;
// Keep in sync with CI_BUDGET_MULTIPLIER in test/perf/perf.ts.
export const CI_BUDGET_MULTIPLIER = 3;
/** Soft guardShare drift tolerance (absolute), report-only. */
export const GUARD_SHARE_DRIFT = 0.15;
const RESULTS_SCHEMA_VERSION = 1;

/**
 * Pure gate. Returns { violations, warnings }: violations is
 * [{ budget, detail }] (each fails the run), warnings is a string list
 * (report-only, never fails).
 */
export function collectRegressionViolations(results, baseline, timeMultiplier) {
  const violations = [];
  const warnings = [];

  const measuredCases = results?.scenarios?.format?.cases;
  if (
    measuredCases === null ||
    measuredCases === undefined ||
    typeof measuredCases !== "object"
  ) {
    violations.push({
      budget: "results shape",
      detail:
        "results.json has no scenarios.format.cases; run `npm run perf` first",
    });
    return { violations, warnings };
  }
  const baselineCases = baseline?.scenarios?.format?.cases;
  if (
    baselineCases === null ||
    baselineCases === undefined ||
    typeof baselineCases !== "object" ||
    Object.keys(baselineCases).length === 0
  ) {
    violations.push({
      budget: "baseline shape",
      detail:
        "baseline.json has no scenarios.format.cases; run `npm run perf:baseline` on the reference machine and commit it",
    });
    return { violations, warnings };
  }

  const ciSuffix = timeMultiplier !== 1 ? ` x${timeMultiplier} (CI)` : "";

  for (const [name, base] of Object.entries(baselineCases)) {
    const measured = measuredCases[name];
    if (measured === undefined) {
      violations.push({
        budget: "baseline case still measured",
        detail: `${name}: present in baseline.json but absent from results.json (case dropped silently?)`,
      });
      continue;
    }
    if (!Number.isFinite(base?.p95Ms) || base.p95Ms <= 0) {
      violations.push({
        budget: "baseline shape",
        detail: `${name}: baseline p95Ms must be a positive number`,
      });
      continue;
    }
    if (!Number.isFinite(measured?.p95Ms)) {
      violations.push({
        budget: "results shape",
        detail: `${name}: measured p95Ms is not a number`,
      });
      continue;
    }

    const threshold = base.p95Ms * REGRESSION_FACTOR * timeMultiplier;
    if (measured.p95Ms > threshold) {
      violations.push({
        budget: `p95 <= baseline x${REGRESSION_FACTOR}${ciSuffix}`,
        detail:
          `${name}: p95 ${measured.p95Ms} ms > ${threshold.toFixed(1)} ms ` +
          `(baseline ${base.p95Ms} ms)`,
      });
    }
    if (
      Number.isFinite(base?.guardShare) &&
      Number.isFinite(measured?.guardShare) &&
      measured.guardShare > base.guardShare + GUARD_SHARE_DRIFT
    ) {
      warnings.push(
        `${name}: guardShare ${measured.guardShare} vs baseline ${base.guardShare} (soft, report only)`,
      );
    }
  }

  for (const name of Object.keys(measuredCases)) {
    if (!Object.prototype.hasOwnProperty.call(baselineCases, name)) {
      warnings.push(
        `${name}: measured but not in baseline.json; adopt it via npm run perf:baseline`,
      );
    }
  }

  return { violations, warnings };
}

function fail(message) {
  console.error(`perf:check FAILED - ${message}`);
  process.exit(1);
}

function readJsonOrFail(path, label, hint) {
  if (!existsSync(path)) {
    fail(`${label} not found at ${path}. ${hint}`);
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    fail(`${label} is not valid JSON: ${err.message}`);
  }
}

function main() {
  const results = readJsonOrFail(
    resultsPath,
    "results.json",
    "Run `npm run perf` first (it writes test/perf/results.json).",
  );
  if (results.schemaVersion !== RESULTS_SCHEMA_VERSION) {
    fail(
      `unsupported results schemaVersion ${results.schemaVersion} ` +
        `(expected ${RESULTS_SCHEMA_VERSION}); delete test/perf/results.json and re-run \`npm run perf\`.`,
    );
  }
  const baseline = readJsonOrFail(
    baselinePath,
    "baseline.json",
    "Run `npm run perf:baseline` on the reference machine and commit it.",
  );

  const timeMultiplier = process.env.CI ? CI_BUDGET_MULTIPLIER : 1;
  const { violations, warnings } = collectRegressionViolations(
    results,
    baseline,
    timeMultiplier,
  );

  const measured = results?.scenarios?.format?.cases ?? {};
  const baselineCases = baseline?.scenarios?.format?.cases ?? {};
  console.log(
    `perf regression vs baseline (factor x${REGRESSION_FACTOR}` +
      `${timeMultiplier !== 1 ? `, CI x${timeMultiplier}` : ""}):`,
  );
  for (const [name, base] of Object.entries(baselineCases)) {
    const m = measured[name];
    const threshold = (base?.p95Ms ?? 0) * REGRESSION_FACTOR * timeMultiplier;
    console.log(
      `  ${name.padEnd(18)} baseline p95 ${String(base?.p95Ms ?? "?").padStart(7)} ms` +
        `  measured ${String(m?.p95Ms ?? "MISSING").padStart(7)} ms` +
        `  threshold ${threshold.toFixed(1).padStart(8)} ms`,
    );
  }
  for (const warning of warnings) {
    console.log(`  note: ${warning}`);
  }

  if (violations.length === 0) {
    console.log("perf:check OK - no p95 drift beyond the frozen baseline.");
    return;
  }
  console.error(`perf:check FAILED - ${violations.length} violation(s):`);
  for (const violation of violations) {
    console.error(`  - [${violation.budget}] ${violation.detail}`);
  }
  process.exit(1);
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main();
}
