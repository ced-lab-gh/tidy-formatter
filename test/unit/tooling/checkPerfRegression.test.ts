// PURE tests for the ADD-09 perf drift gate (same dynamic-import pattern as
// checkBundleSize.test.ts).
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

interface Violation {
  budget: string;
  detail: string;
}

interface RegressionModule {
  REGRESSION_FACTOR: number;
  CI_BUDGET_MULTIPLIER: number;
  GUARD_SHARE_DRIFT: number;
  collectRegressionViolations(
    results: unknown,
    baseline: unknown,
    timeMultiplier: number
  ): { violations: Violation[]; warnings: string[] };
}

const SCRIPT = path.resolve(__dirname, '../../../scripts/check-perf-regression.mjs');

function results(cases: Record<string, { p95Ms: number; guardShare?: number }>): unknown {
  return { schemaVersion: 1, scenarios: { format: { cases } } };
}

function baseline(
  cases: Record<string, { p50Ms?: number; p95Ms: number; guardShare?: number }>
): unknown {
  return { schemaVersion: 1, scenarios: { format: { cases } } };
}

describe('check-perf-regression : collectRegressionViolations', () => {
  let mod: RegressionModule;

  before(async () => {
    mod = (await import(pathToFileURL(SCRIPT).href)) as unknown as RegressionModule;
  });

  it('exposes the frozen constants', () => {
    assert.equal(mod.REGRESSION_FACTOR, 1.35);
    assert.equal(mod.CI_BUDGET_MULTIPLIER, 3);
    assert.equal(mod.GUARD_SHARE_DRIFT, 0.15);
  });

  it('passes when measured p95 equals the threshold exactly (strictly-over fails)', () => {
    const { violations } = mod.collectRegressionViolations(
      results({ css: { p95Ms: 135 } }),
      baseline({ css: { p95Ms: 100 } }),
      1
    );
    assert.deepEqual(violations, []);
  });

  it('fails when measured p95 exceeds baseline x1.35', () => {
    const { violations } = mod.collectRegressionViolations(
      results({ css: { p95Ms: 136 } }),
      baseline({ css: { p95Ms: 100 } }),
      1
    );
    assert.equal(violations.length, 1);
    assert.match(violations[0].detail, /css/);
    assert.match(violations[0].detail, /baseline 100/);
  });

  it('multiplies the threshold on CI (x3): 405 passes, 406 fails', () => {
    const pass = mod.collectRegressionViolations(
      results({ css: { p95Ms: 405 } }),
      baseline({ css: { p95Ms: 100 } }),
      3
    );
    assert.deepEqual(pass.violations, []);
    const fail = mod.collectRegressionViolations(
      results({ css: { p95Ms: 406 } }),
      baseline({ css: { p95Ms: 100 } }),
      3
    );
    assert.equal(fail.violations.length, 1);
  });

  it('fails when a baseline case is absent from the results (case dropped)', () => {
    const { violations } = mod.collectRegressionViolations(
      results({}),
      baseline({ css: { p95Ms: 100 } }),
      1
    );
    assert.equal(violations.length, 1);
    assert.match(violations[0].budget, /baseline case still measured/);
  });

  it('only WARNS for a measured case absent from the baseline (no chicken-and-egg)', () => {
    const { violations, warnings } = mod.collectRegressionViolations(
      results({ css: { p95Ms: 50 }, vue: { p95Ms: 80 } }),
      baseline({ css: { p95Ms: 100 } }),
      1
    );
    assert.deepEqual(violations, []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /vue/);
  });

  it('only WARNS on guardShare drift beyond +0.15 absolute', () => {
    const { violations, warnings } = mod.collectRegressionViolations(
      results({ css: { p95Ms: 50, guardShare: 1.7 } }),
      baseline({ css: { p95Ms: 100, guardShare: 1.5 } }),
      1
    );
    assert.deepEqual(violations, []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /guardShare/);
  });

  it('fails on a malformed baseline (no cases) with an actionable message', () => {
    const { violations } = mod.collectRegressionViolations(
      results({ css: { p95Ms: 50 } }),
      { schemaVersion: 1, scenarios: {} },
      1
    );
    assert.equal(violations.length, 1);
    assert.match(violations[0].detail, /perf:baseline/);
  });

  it('fails on missing results with an actionable message', () => {
    const { violations } = mod.collectRegressionViolations(
      { schemaVersion: 1, scenarios: {} },
      baseline({ css: { p95Ms: 50 } }),
      1
    );
    assert.equal(violations.length, 1);
    assert.match(violations[0].budget, /results shape/);
    assert.match(violations[0].detail, /npm run perf/);
  });

  it('fails on a non-positive baseline p95', () => {
    const { violations } = mod.collectRegressionViolations(
      results({ css: { p95Ms: 50 } }),
      baseline({ css: { p95Ms: 0 } }),
      1
    );
    assert.equal(violations.length, 1);
    assert.match(violations[0].budget, /baseline shape/);
  });
});
