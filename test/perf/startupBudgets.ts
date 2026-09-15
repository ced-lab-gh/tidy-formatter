// Pure startup-budget logic for the ADD-09 harness (test/perf/startup.ts).
//
// PURE on purpose: no 'vscode', no fs, no child_process. Everything here runs
// under mocha without a built dist/, so the budget arithmetic, the median, and
// every violation rule are unit-tested even though the harness itself can only
// run after `npm run compile` (CI wires it after the compile step).
//
// Budget calibration (empirical, measured on the reference machine, win32 x64,
// Node 24).
//
// ADD-09 campaign, v0.3.0 single bundle of 2 818 641 bytes:
//   - busy machine, 7 runs: 243.9 / 252.7 / 254.4 / 256.5 / 268.9 / 277.7 /
//     301.8 ms, median 256.5 ms, retained heap 11.2 MB;
//   - idle machine, 5 runs through this harness: median 207.7 ms, max 223.3 ms,
//     retained heap 10.7 MB.
// That put `requireMs` at 400 (~1.55x the worse median).
//
// ADD-11 campaign, host bundle of 381 694 bytes plus four lazy chunks:
//   - 5 runs through this harness: median 43.8 ms, max 45.6 ms, retained heap
//     1.6 MB, require.cache 3 modules, ZERO chunks loaded.
// ADD-11 therefore tightens `requireMs` to the 80 ms the split was designed to
// buy: ~1.8x the measured median, the same headroom ratio ADD-09 used, and low
// enough that quietly re-absorbing any engine into the host bundle reds the
// gate immediately rather than hiding inside a 400 ms allowance.
//
// The heap budget stays deliberately loose (40 MB against a measured 1.6 MB):
// it is a structural tripwire for "the bundle now retains an order of magnitude
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
  requireMs: 80,
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

// --- ADD-11: activation + first-format scenario ----------------------------
//
// The cold-require scenario above deliberately never calls activate(). ADD-11
// needs the other half of the story, because the lazy chunk boundary can only
// break in the PACKAGED bundle: under mocha + tsx the loader resolves a source
// module and always succeeds, so a mis-emitted runtime require would reach a
// user as "Tidy refuses to format anything" with a fully green test suite.
//
// test/perf/activationChild.cjs therefore requires the real dist/extension.js
// behind a FUNCTIONAL vscode stub, calls activate(), and drives four real
// formats through the registered document provider - one per chunk family
// (ts, css, html) plus json, which must cost no chunk at all. The rules below
// are pure so every one of them is unit-tested without a built dist/.

export interface FormatProbe {
  readonly elapsedMs: number;
  readonly editCount: number;
  readonly editText: string;
}

export interface ActivationSample {
  readonly requireMs: number;
  readonly activateMs: number;
  readonly exportsActivate: string;
  readonly exportsDeactivate: string;
  readonly providerCount: number;
  readonly chunksAfterRequire: readonly string[];
  readonly chunksAfterActivate: readonly string[];
  readonly chunksAfterTypescript: readonly string[];
  readonly chunksAfterJson: readonly string[];
  readonly chunksAfterCss: readonly string[];
  readonly chunksAfterHtml: readonly string[];
  readonly typescript: FormatProbe;
  readonly json: FormatProbe;
  readonly css: FormatProbe;
  readonly html: FormatProbe;
  readonly warnings: readonly string[];
}

export interface ActivationBudget {
  /** activate() itself, excluding the require (wall-clock, CI-scaled). */
  readonly activateMs: number;
  /** First typescript format, WITHOUT the idle preload (wall-clock, CI-scaled). */
  readonly firstTsFormatMs: number;
}

// Measured on the reference machine: activate() 0.7 ms, first ts format 149 ms
// (both chunks loaded inside that number). The budgets keep the ADD-11 spec
// figures, which are far looser than the measurement on purpose: they exist to
// catch "the first format now pays a pathological cost", not to police jitter.
export const ACTIVATION_BUDGET: ActivationBudget = {
  activateMs: 50,
  firstTsFormatMs: 1000
} as const;

/** Chunks a first TypeScript format must load, and no others. */
export const TS_FORMAT_CHUNKS: readonly string[] = [
  'chunk-guard-js.js',
  'chunk-prettier.js'
];

/** The one chunk a CSS format adds on top of whatever is already loaded. */
export const CSS_FORMAT_CHUNK = 'chunk-guard-css.js';

/**
 * The one chunk an HTML format adds on top of whatever is already loaded.
 *
 * This rule closes a real blind spot. Until it existed, NOTHING asserted that
 * formatting HTML reaches chunk-guard-html: the integration tier
 * (test/integration/lazy-chunks.test.ts) only asserts that the text changed,
 * which a parse5-less path could satisfy, and this harness asserted chunk sets
 * for ts, json and css while never naming html at all. That is precisely how
 * the lazy/first.html fixture was able to drift to the formatter's own fixed
 * point and stop loading the chunk without a single gate turning red. Naming
 * the chunk here makes the same silent drift impossible: the delta is measured
 * against the PACKAGED bundle, where a mis-emitted runtime require is the only
 * place this boundary can actually break.
 */
export const HTML_FORMAT_CHUNK = 'chunk-guard-html.js';

function sameSet(actual: readonly string[], expected: readonly string[]): boolean {
  if (actual.length !== expected.length) {
    return false;
  }
  const sortedActual = [...actual].sort();
  const sortedExpected = [...expected].sort();
  return sortedActual.every((value, index) => value === sortedExpected[index]);
}

/**
 * Evaluate the activation scenario. Wall-clock rules are scaled by
 * `timeMultiplier` (x3 under CI); every structural rule (which chunk loaded
 * when, how many edits came back, whether a warning toast fired) is NEVER
 * scaled: those are correctness statements, not timings.
 *
 * A measurement AT the budget (>=) is already a violation, matching perf.ts.
 */
export function collectActivationViolations(
  sample: ActivationSample,
  budget: ActivationBudget,
  timeMultiplier: number
): Violation[] {
  const violations: Violation[] = [];

  if (sample.exportsActivate !== 'function' || sample.exportsDeactivate !== 'function') {
    violations.push({
      budget: 'bundle exports activate/deactivate',
      detail:
        `activate=${sample.exportsActivate}, deactivate=${sample.exportsDeactivate} ` +
        '(wrong or broken bundle measured)'
    });
  }

  if (sample.providerCount < 1) {
    violations.push({
      budget: 'activate() registers formatting providers',
      detail: `${sample.providerCount} document formatting provider(s) registered`
    });
  }

  if (sample.chunksAfterRequire.length > 0) {
    violations.push({
      budget: 'zero lazy chunks loaded at require time',
      detail: `loaded: ${sample.chunksAfterRequire.join(', ')}`
    });
  }

  // THE structural gate of ADD-11: opening a supported file must not evaluate a
  // single byte of Prettier, babel, PostCSS or parse5.
  if (sample.chunksAfterActivate.length > 0) {
    violations.push({
      budget: 'zero lazy chunks loaded by activate()',
      detail: `loaded: ${sample.chunksAfterActivate.join(', ')}`
    });
  }

  const activateBudgetMs = budget.activateMs * timeMultiplier;
  if (sample.activateMs >= activateBudgetMs) {
    violations.push({
      budget: `activate() < ${activateBudgetMs} ms`,
      detail: `activate() took ${sample.activateMs.toFixed(1)} ms`
    });
  }

  // A first format must really apply: exactly one replace edit, non-empty text.
  // Zero edits would be the exact shape of the failure this whole harness
  // exists to catch (a chunk that cannot load makes the guard abort every run).
  if (sample.typescript.editCount !== 1 || sample.typescript.editText === '') {
    violations.push({
      budget: 'first typescript format produces exactly one edit',
      detail:
        `editCount=${sample.typescript.editCount}, ` +
        `editText length=${sample.typescript.editText.length}`
    });
  }

  const tsBudgetMs = budget.firstTsFormatMs * timeMultiplier;
  if (sample.typescript.elapsedMs >= tsBudgetMs) {
    violations.push({
      budget: `first typescript format < ${tsBudgetMs} ms`,
      detail: `took ${sample.typescript.elapsedMs.toFixed(0)} ms (no preload)`
    });
  }

  if (!sameSet(sample.chunksAfterTypescript, TS_FORMAT_CHUNKS)) {
    violations.push({
      budget: `typescript format loads exactly [${TS_FORMAT_CHUNKS.join(', ')}]`,
      detail: `loaded: ${sample.chunksAfterTypescript.join(', ') || 'none'}`
    });
  }

  if (sample.json.editCount !== 1) {
    violations.push({
      budget: 'json format produces exactly one edit',
      detail: `editCount=${sample.json.editCount}`
    });
  }

  // jsonc-parser and js-beautify ship inside the host bundle: the JSON family
  // must cost NO chunk at all.
  if (!sameSet(sample.chunksAfterJson, sample.chunksAfterTypescript)) {
    violations.push({
      budget: 'json format loads no additional chunk',
      detail:
        `before: ${sample.chunksAfterTypescript.join(', ') || 'none'}; ` +
        `after: ${sample.chunksAfterJson.join(', ') || 'none'}`
    });
  }

  if (sample.css.editCount !== 1) {
    violations.push({
      budget: 'css format produces exactly one edit',
      detail: `editCount=${sample.css.editCount}`
    });
  }

  if (!sameSet(sample.chunksAfterCss, [...sample.chunksAfterJson, CSS_FORMAT_CHUNK])) {
    violations.push({
      budget: `css format adds exactly ${CSS_FORMAT_CHUNK}`,
      detail:
        `before: ${sample.chunksAfterJson.join(', ') || 'none'}; ` +
        `after: ${sample.chunksAfterCss.join(', ') || 'none'}`
    });
  }

  if (sample.html.editCount !== 1 || sample.html.editText === '') {
    violations.push({
      budget: 'html format produces exactly one edit',
      detail:
        `editCount=${sample.html.editCount}, ` +
        `editText length=${sample.html.editText.length}`
    });
  }

  // The assertion the html family never had: the parse5 guard chunk must be
  // reached, and nothing else may come with it. An input that the formatter
  // leaves untouched short-circuits before the guard, loads no chunk, and now
  // fails here instead of passing silently.
  if (!sameSet(sample.chunksAfterHtml, [...sample.chunksAfterCss, HTML_FORMAT_CHUNK])) {
    violations.push({
      budget: `html format adds exactly ${HTML_FORMAT_CHUNK}`,
      detail:
        `before: ${sample.chunksAfterCss.join(', ') || 'none'}; ` +
        `after: ${sample.chunksAfterHtml.join(', ') || 'none'}`
    });
  }

  // The provider only shows a warning toast when it ABORTED (guard rejection,
  // engine error, failed restore). In this scenario every abort would be a
  // chunk-loading failure, so any warning at all is a hard failure.
  if (sample.warnings.length > 0) {
    violations.push({
      budget: 'no format aborted (no warning toast)',
      detail: sample.warnings.join(' | ')
    });
  }

  return violations;
}
