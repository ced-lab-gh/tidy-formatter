// Pure startup-budget logic for the ADD-09 harness (test/perf/startup.ts).
//
// PURE on purpose: no 'vscode', no fs, no child_process. Everything here runs
// under mocha without a built dist/, so the budget arithmetic, the median, and
// every violation rule are unit-tested even though the harness itself can only
// run after `npm run compile` (CI wires it after the compile step).
//
// Budget calibration (empirical, measured on the reference machine, win32 x64,
// Node 24, on the v0.3.0 bundle of 2 818 641 bytes). Two campaigns:
//   - busy machine, 7 runs: 243.9 / 252.7 / 254.4 / 256.5 / 268.9 / 277.7 /
//     301.8 ms, median 256.5 ms, retained heap 11.2 MB;
//   - idle machine, 5 runs through this harness: median 207.7 ms, max 223.3 ms,
//     retained heap 10.7 MB.
// The requireMs budget is set from the WORSE median (~1.55x of 256.5): enough
// headroom that a busy machine or a slower disk does not red the gate, tight
// enough that a doubling of the require cost is caught. The product spec's
// original "150 ms" figure (and its later "350 ms" revision, calibrated on the
// smaller v0.2.1 bundle) both predate this measurement. ADD-11 (lazy chunks) is
// expected to bring the cold require under 80 ms and MUST tighten `requireMs`
// in the same change.
//
// The heap budget is deliberately loose (40 MB against a measured 11.2 MB): it
// is a structural tripwire for "the bundle now retains an order of magnitude
// more memory at load", not a precision instrument, and it is NOT CI-scaled
// because memory does not vary with runner speed.

export interface StartupSample {
  readonly requireMs: number;
  readonly heapUsedDeltaBytes: number;
  readonly moduleCount: number;
  readonly chunkModules: readonly string[];
  readonly exportsActivate: string;
  readonly exportsDeactivate: string;
  readonly gcExposed: boolean;
  readonly vscodeRequests: number;
}

export interface StartupBudget {
  /** Median cold require of dist/extension.js (wall-clock, CI-scaled). */
  readonly requireMs: number;
  /** Median retained heap after require + forced GC (structural, NOT scaled). */
  readonly heapUsedDeltaBytes: number;
}

export interface Violation {
  budget: string;
  detail: string;
}

export const STARTUP_BUDGET: StartupBudget = {
  requireMs: 400,
  heapUsedDeltaBytes: 40 * 1024 * 1024
} as const;

/** Child runs per harness invocation; median absorbs cold-cache outliers. */
export const STARTUP_SAMPLES = 5;

export function median(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid];
  }
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

export interface StartupSummary {
  readonly samples: number;
  readonly requireMsMedian: number;
  readonly requireMsMax: number;
  readonly heapUsedDeltaBytesMedian: number;
  readonly moduleCount: number;
  readonly chunkModulesLoaded: readonly string[];
}

export function summarize(samples: readonly StartupSample[]): StartupSummary {
  const chunkSet = new Set<string>();
  for (const sample of samples) {
    for (const chunk of sample.chunkModules) {
      chunkSet.add(chunk);
    }
  }
  return {
    samples: samples.length,
    requireMsMedian: median(samples.map((s) => s.requireMs)),
    requireMsMax: samples.length === 0 ? 0 : Math.max(...samples.map((s) => s.requireMs)),
    heapUsedDeltaBytesMedian: median(samples.map((s) => s.heapUsedDeltaBytes)),
    moduleCount: samples.length === 0 ? 0 : Math.max(...samples.map((s) => s.moduleCount)),
    chunkModulesLoaded: [...chunkSet].sort()
  };
}

/**
 * Evaluate every startup budget. Mirrors perf.ts semantics: wall-clock budgets
 * are scaled by `timeMultiplier` (x3 under CI), structural budgets are not;
 * a measurement AT the budget (>=) is already a violation.
 *
 * `distHasChunks` reports whether dist/ contains chunk-*.js files. Until
 * ADD-11 splits the bundle it is false and the zero-chunks gate is vacuous;
 * the day chunks exist, any chunk loaded by the bare require becomes a
 * violation with NO harness change.
 */
export function collectStartupViolations(
  samples: readonly StartupSample[],
  summary: StartupSummary,
  budget: StartupBudget,
  timeMultiplier: number,
  distHasChunks: boolean
): Violation[] {
  const violations: Violation[] = [];

  if (samples.length === 0) {
    violations.push({
      budget: 'harness produced samples',
      detail: 'no startup sample was collected'
    });
    return violations;
  }

  const requireBudgetMs = budget.requireMs * timeMultiplier;
  if (summary.requireMsMedian >= requireBudgetMs) {
    violations.push({
      budget: `cold require median < ${requireBudgetMs} ms`,
      detail: `median = ${summary.requireMsMedian.toFixed(1)} ms over ${summary.samples} run(s)`
    });
  }

  if (summary.heapUsedDeltaBytesMedian >= budget.heapUsedDeltaBytes) {
    violations.push({
      budget: `retained heap median < ${Math.round(budget.heapUsedDeltaBytes / (1024 * 1024))} MB`,
      detail: `median = ${(summary.heapUsedDeltaBytesMedian / (1024 * 1024)).toFixed(1)} MB`
    });
  }

  for (const [index, sample] of samples.entries()) {
    if (sample.exportsActivate !== 'function' || sample.exportsDeactivate !== 'function') {
      violations.push({
        budget: 'bundle exports activate/deactivate',
        detail:
          `sample ${index}: activate=${sample.exportsActivate}, ` +
          `deactivate=${sample.exportsDeactivate} (wrong or broken bundle measured)`
      });
    }
    if (!sample.gcExposed) {
      violations.push({
        budget: 'child ran with --expose-gc',
        detail: `sample ${index}: gc unavailable, heap delta is allocation noise`
      });
    }
    if (sample.vscodeRequests < 1) {
      violations.push({
        budget: "bundle requires 'vscode' at least once",
        detail: `sample ${index}: the vscode stub was never hit (dead path measured?)`
      });
    }
  }

  if (distHasChunks && summary.chunkModulesLoaded.length > 0) {
    violations.push({
      budget: 'zero lazy chunks loaded at require time',
      detail: `loaded: ${summary.chunkModulesLoaded.join(', ')}`
    });
  }

  return violations;
}
