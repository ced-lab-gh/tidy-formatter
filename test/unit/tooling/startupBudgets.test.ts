// PURE tests for the ADD-09 startup budget logic. No child process, no dist/:
// the fs-facing orchestrator (test/perf/startup.ts) runs in CI after compile;
// everything decidable is decided here.
import assert from 'node:assert/strict';
import {
  STARTUP_BUDGET,
  collectStartupViolations,
  median,
  summarize,
  type StartupSample
} from '../../perf/startupBudgets';

function sample(overrides: Partial<StartupSample> = {}): StartupSample {
  return {
    requireMs: 200,
    heapUsedDeltaBytes: 10 * 1024 * 1024,
    moduleCount: 3,
    chunkModules: [],
    exportsActivate: 'function',
    exportsDeactivate: 'function',
    gcExposed: true,
    vscodeRequests: 1,
    ...overrides
  };
}

describe('startupBudgets : median', () => {
  it('returns the middle element for odd counts', () => {
    assert.equal(median([3, 1, 2]), 2);
  });

  it('returns the mean of the two middle elements for even counts', () => {
    assert.equal(median([4, 1, 3, 2]), 2.5);
  });

  it('returns 0 for an empty list', () => {
    assert.equal(median([]), 0);
  });

  it('does not mutate its input', () => {
    const values = [3, 1, 2];
    median(values);
    assert.deepEqual(values, [3, 1, 2]);
  });
});

describe('startupBudgets : summarize', () => {
  it('computes medians, max and a sorted union of loaded chunks', () => {
    const summary = summarize([
      sample({ requireMs: 300, chunkModules: ['dist/chunk-b.js'] }),
      sample({ requireMs: 100, chunkModules: ['dist/chunk-a.js', 'dist/chunk-b.js'] }),
      sample({ requireMs: 200 })
    ]);
    assert.equal(summary.samples, 3);
    assert.equal(summary.requireMsMedian, 200);
    assert.equal(summary.requireMsMax, 300);
    assert.deepEqual(summary.chunkModulesLoaded, ['dist/chunk-a.js', 'dist/chunk-b.js']);
  });

  it('summarizes an empty sample list without throwing', () => {
    const summary = summarize([]);
    assert.equal(summary.samples, 0);
    assert.equal(summary.requireMsMedian, 0);
    assert.equal(summary.requireMsMax, 0);
    assert.deepEqual(summary.chunkModulesLoaded, []);
  });
});

describe('startupBudgets : collectStartupViolations', () => {
  const okSamples = [sample(), sample(), sample()];

  it('passes when everything is under budget', () => {
    const violations = collectStartupViolations(
      okSamples,
      summarize(okSamples),
      STARTUP_BUDGET,
      1,
      false
    );
    assert.deepEqual(violations, []);
  });

  it('flags a median require time AT the budget (>= semantics, like perf.ts)', () => {
    const slow = [sample({ requireMs: STARTUP_BUDGET.requireMs })];
    const violations = collectStartupViolations(
      slow,
      summarize(slow),
      STARTUP_BUDGET,
      1,
      false
    );
    assert.equal(violations.length, 1);
    assert.match(violations[0].budget, /cold require median/);
  });

  it('scales the require budget by the CI multiplier', () => {
    const slow = [sample({ requireMs: STARTUP_BUDGET.requireMs + 100 })];
    const violations = collectStartupViolations(
      slow,
      summarize(slow),
      STARTUP_BUDGET,
      3,
      false
    );
    // Over the local budget, still well under the CI-scaled one.
    assert.deepEqual(violations, []);
  });

  it('does NOT scale the heap budget by the CI multiplier', () => {
    const fat = [sample({ heapUsedDeltaBytes: STARTUP_BUDGET.heapUsedDeltaBytes + 1 })];
    const violations = collectStartupViolations(
      fat,
      summarize(fat),
      STARTUP_BUDGET,
      3,
      false
    );
    assert.equal(violations.length, 1);
    assert.match(violations[0].budget, /retained heap median/);
  });

  it('flags a loaded chunk only once dist/ actually has chunks', () => {
    const chunky = [sample({ chunkModules: ['dist/chunk-prettier.js'] })];
    const summary = summarize(chunky);
    assert.deepEqual(
      collectStartupViolations(chunky, summary, STARTUP_BUDGET, 1, false),
      []
    );
    const violations = collectStartupViolations(chunky, summary, STARTUP_BUDGET, 1, true);
    assert.equal(violations.length, 1);
    assert.match(violations[0].budget, /zero lazy chunks/);
  });

  it('flags a bundle without activate/deactivate exports (wrong artifact measured)', () => {
    const broken = [sample({ exportsActivate: 'undefined' })];
    const violations = collectStartupViolations(
      broken,
      summarize(broken),
      STARTUP_BUDGET,
      1,
      false
    );
    assert.equal(violations.length, 1);
    assert.match(violations[0].budget, /activate\/deactivate/);
  });

  it('flags a child that ran without --expose-gc (heap delta meaningless)', () => {
    const noGc = [sample({ gcExposed: false })];
    const violations = collectStartupViolations(
      noGc,
      summarize(noGc),
      STARTUP_BUDGET,
      1,
      false
    );
    assert.equal(violations.length, 1);
    assert.match(violations[0].budget, /--expose-gc/);
  });

  it('flags a run where the vscode stub was never hit (dead path measured)', () => {
    const dead = [sample({ vscodeRequests: 0 })];
    const violations = collectStartupViolations(
      dead,
      summarize(dead),
      STARTUP_BUDGET,
      1,
      false
    );
    assert.equal(violations.length, 1);
    assert.match(violations[0].budget, /requires 'vscode'/);
  });

  it('flags an empty sample list', () => {
    const violations = collectStartupViolations([], summarize([]), STARTUP_BUDGET, 1, false);
    assert.equal(violations.length, 1);
    assert.match(violations[0].budget, /produced samples/);
  });

  it('keeps the frozen budget calibrated above the measured reference median', () => {
    // Reference measurement: median 256.5 ms cold require. A budget at or below
    // that would gate red on a healthy machine; ADD-11 tightens it deliberately.
    assert.ok(STARTUP_BUDGET.requireMs > 256.5);
    assert.equal(STARTUP_BUDGET.heapUsedDeltaBytes, 40 * 1024 * 1024);
  });
});
