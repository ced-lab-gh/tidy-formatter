// PURE tests for the ADD-09 startup budget logic. No child process, no dist/:
// the fs-facing orchestrator (test/perf/startup.ts) runs in CI after compile;
// everything decidable is decided here.
import assert from 'node:assert/strict';
import {
  ACTIVATION_BUDGET,
  CSS_FORMAT_CHUNK,
  STARTUP_BUDGET,
  TS_FORMAT_CHUNKS,
  collectActivationViolations,
  collectStartupViolations,
  median,
  summarize,
  type ActivationSample,
  type StartupSample
} from '../../perf/startupBudgets';

function sample(overrides: Partial<StartupSample> = {}): StartupSample {
  return {
    // Under the ADD-11 budget (80 ms): the measured post-split median is ~40 ms.
    requireMs: 40,
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
    // ADD-11 reference measurement on the split bundle: median 43.8 ms cold
    // require (max 45.6). A budget at or below that would gate red on a healthy
    // machine; the 80 ms ceiling keeps ~1.8x headroom, the same ratio ADD-09
    // used against its own (much larger) single-bundle measurement.
    assert.ok(STARTUP_BUDGET.requireMs > 45.6);
    assert.equal(STARTUP_BUDGET.requireMs, 80);
    assert.equal(STARTUP_BUDGET.heapUsedDeltaBytes, 40 * 1024 * 1024);
  });
});

// --- ADD-11 : activation + first-format budgets ----------------------------

function activationSample(
  overrides: Partial<ActivationSample> = {}
): ActivationSample {
  const afterTs = [...TS_FORMAT_CHUNKS];
  return {
    requireMs: 30,
    activateMs: 2,
    exportsActivate: 'function',
    exportsDeactivate: 'function',
    providerCount: 10,
    chunksAfterRequire: [],
    chunksAfterActivate: [],
    chunksAfterTypescript: afterTs,
    chunksAfterJson: afterTs,
    chunksAfterCss: [...afterTs, CSS_FORMAT_CHUNK],
    typescript: { elapsedMs: 160, editCount: 1, editText: 'const a: number = 1;\n' },
    json: { elapsedMs: 4, editCount: 1, editText: '{\n  "a": 1\n}' },
    css: { elapsedMs: 15, editCount: 1, editText: '.a {\n  color: red\n}' },
    warnings: [],
    ...overrides
  };
}

describe('startupBudgets : collectActivationViolations (ADD-11)', () => {
  it('passes on a healthy activation + three formats', () => {
    assert.deepEqual(
      collectActivationViolations(activationSample(), ACTIVATION_BUDGET, 1),
      []
    );
  });

  it('flags any chunk evaluated by activate() (THE ADD-11 invariant)', () => {
    const violations = collectActivationViolations(
      activationSample({ chunksAfterActivate: ['chunk-prettier.js'] }),
      ACTIVATION_BUDGET,
      1
    );
    assert.equal(violations.length, 1);
    assert.match(violations[0].budget, /zero lazy chunks loaded by activate/);
  });

  it('flags a chunk evaluated by the bare require', () => {
    const violations = collectActivationViolations(
      activationSample({ chunksAfterRequire: ['chunk-guard-js.js'] }),
      ACTIVATION_BUDGET,
      1
    );
    assert.equal(violations.length, 1);
    assert.match(violations[0].budget, /zero lazy chunks loaded at require time/);
  });

  it('flags a first format that produced NO edit (the chunk-unavailable shape)', () => {
    const violations = collectActivationViolations(
      activationSample({
        typescript: { elapsedMs: 12, editCount: 0, editText: '' }
      }),
      ACTIVATION_BUDGET,
      1
    );
    assert.equal(violations.length, 1);
    assert.match(violations[0].budget, /exactly one edit/);
  });

  it('flags a warning toast: any abort here means a chunk failed to load', () => {
    const violations = collectActivationViolations(
      activationSample({ warnings: ['Tidy left this file unchanged.'] }),
      ACTIVATION_BUDGET,
      1
    );
    assert.equal(violations.length, 1);
    assert.match(violations[0].budget, /no format aborted/);
  });

  it('flags a typescript format that loaded the wrong chunk set', () => {
    const violations = collectActivationViolations(
      activationSample({
        chunksAfterTypescript: ['chunk-prettier.js'],
        chunksAfterJson: ['chunk-prettier.js'],
        chunksAfterCss: ['chunk-prettier.js', CSS_FORMAT_CHUNK]
      }),
      ACTIVATION_BUDGET,
      1
    );
    assert.equal(violations.length, 1);
    assert.match(violations[0].budget, /typescript format loads exactly/);
  });

  it('flags a json format that pulled a chunk (jsonc-parser must stay in the host)', () => {
    const violations = collectActivationViolations(
      activationSample({
        chunksAfterJson: [...TS_FORMAT_CHUNKS, CSS_FORMAT_CHUNK],
        chunksAfterCss: [...TS_FORMAT_CHUNKS, CSS_FORMAT_CHUNK]
      }),
      ACTIVATION_BUDGET,
      1
    );
    assert.equal(violations.length, 2);
    assert.match(violations[0].budget, /json format loads no additional chunk/);
    assert.match(violations[1].budget, /css format adds exactly/);
  });

  it('flags a css format that did not pull the postcss guard chunk', () => {
    const violations = collectActivationViolations(
      activationSample({ chunksAfterCss: [...TS_FORMAT_CHUNKS] }),
      ACTIVATION_BUDGET,
      1
    );
    assert.equal(violations.length, 1);
    assert.match(violations[0].budget, /css format adds exactly/);
  });

  it('flags a first format AT the budget (>= semantics, like perf.ts)', () => {
    const violations = collectActivationViolations(
      activationSample({
        typescript: {
          elapsedMs: ACTIVATION_BUDGET.firstTsFormatMs,
          editCount: 1,
          editText: 'x'
        }
      }),
      ACTIVATION_BUDGET,
      1
    );
    assert.equal(violations.length, 1);
    assert.match(violations[0].budget, /first typescript format </);
  });

  it('scales the wall-clock budgets by the CI multiplier but not the structural ones', () => {
    const slowButCorrect = activationSample({
      activateMs: ACTIVATION_BUDGET.activateMs + 10,
      typescript: {
        elapsedMs: ACTIVATION_BUDGET.firstTsFormatMs + 200,
        editCount: 1,
        editText: 'x'
      }
    });
    assert.deepEqual(
      collectActivationViolations(slowButCorrect, ACTIVATION_BUDGET, 3),
      []
    );
    // The same sample with a structural fault stays a violation under CI too.
    const structural = collectActivationViolations(
      activationSample({ chunksAfterActivate: ['chunk-guard-css.js'] }),
      ACTIVATION_BUDGET,
      3
    );
    assert.equal(structural.length, 1);
  });

  it('flags a bundle that registered no formatting provider', () => {
    const violations = collectActivationViolations(
      activationSample({ providerCount: 0 }),
      ACTIVATION_BUDGET,
      1
    );
    assert.equal(violations.length, 1);
    assert.match(violations[0].budget, /registers formatting providers/);
  });
});
