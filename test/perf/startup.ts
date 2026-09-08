// Startup harness (ADD-09): measures the COLD require cost of the production
// bundle exactly as the extension host pays it before activate() runs.
//
// Why a child process: the only honest cold measurement needs an empty module
// cache, V8 without the bundle JIT-warmed, and a `vscode` module that resolves.
// So each sample spawns `node --expose-gc --require vscodeStub.cjs
// startupChild.cjs <bundle>`; the child prints one JSON line (see
// startupChild.cjs) and this orchestrator aggregates STARTUP_SAMPLES of them,
// gates on the budgets in startupBudgets.ts, persists the summary as the
// 'startup' scenario of test/perf/results.json, and exits non-zero on any
// violation so CI can gate on it (same contract as perf.ts).
//
// Prerequisite: `npm run compile` (CI wires this step after the compile step).
// activate() is NEVER called here: harness scope is the require cost only; the
// activation behaviour itself belongs to the integration tier.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ACTIVATION_BUDGET,
  STARTUP_BUDGET,
  STARTUP_SAMPLES,
  collectActivationViolations,
  collectStartupViolations,
  summarize,
  type ActivationSample,
  type StartupSample,
  type StartupSummary,
  type Violation
} from './startupBudgets';
import {
  RESULTS_PATH,
  mergeScenario,
  readResults,
  round1,
  writeResults,
  type StartupScenario
} from './resultsFile';

// Wall-clock budgets relax x3 on shared CI runners; structural budgets do not.
// Keep in sync with CI_BUDGET_MULTIPLIER in test/perf/perf.ts.
const CI_BUDGET_MULTIPLIER = 3;
const TIME_MULTIPLIER = process.env.CI ? CI_BUDGET_MULTIPLIER : 1;

const ROOT = path.resolve(__dirname, '../..');
const DIST_DIR = path.join(ROOT, 'dist');
const BUNDLE_PATH = path.join(DIST_DIR, 'extension.js');
const STUB_PATH = path.join(__dirname, 'vscodeStub.cjs');
const CHILD_PATH = path.join(__dirname, 'startupChild.cjs');
// ADD-11: the second scenario needs a FUNCTIONAL vscode stub (activate() really
// runs and formats), so it uses its own preload and its own child.
const ACTIVATION_STUB_PATH = path.join(__dirname, 'vscodeActivationStub.cjs');
const ACTIVATION_CHILD_PATH = path.join(__dirname, 'activationChild.cjs');

function assertSampleShape(value: unknown, rawStdout: string): StartupSample {
  const sample = value as StartupSample;
  const numeric =
    typeof sample?.requireMs === 'number' &&
    typeof sample?.heapUsedDeltaBytes === 'number' &&
    typeof sample?.moduleCount === 'number' &&
    typeof sample?.vscodeRequests === 'number';
  const structural =
    Array.isArray(sample?.chunkModules) &&
    typeof sample?.exportsActivate === 'string' &&
    typeof sample?.exportsDeactivate === 'string' &&
    typeof sample?.gcExposed === 'boolean';
  if (!numeric || !structural) {
    throw new Error(`startup child printed an unexpected payload: ${rawStdout}`);
  }
  return sample;
}

function runChildOnce(): StartupSample {
  const stdout = execFileSync(
    process.execPath,
    ['--expose-gc', '--require', STUB_PATH, CHILD_PATH, BUNDLE_PATH],
    { encoding: 'utf8', timeout: 60_000 }
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`startup child printed non-JSON output: ${stdout}`);
  }
  return assertSampleShape(parsed, stdout);
}

function distHasChunks(): boolean {
  return fs.readdirSync(DIST_DIR).some((name) => /^chunk-.+\.js$/.test(name));
}

/**
 * ADD-11 scenario: require + activate + three real formats against the BUILT
 * bundle. One run, not STARTUP_SAMPLES: everything it asserts is structural
 * (which chunk loaded when, how many edits came back), and the two wall-clock
 * rules have order-of-magnitude headroom, so repeating it would only cost time.
 */
function runActivationChild(): ActivationSample {
  const stdout = execFileSync(
    process.execPath,
    ['--require', ACTIVATION_STUB_PATH, ACTIVATION_CHILD_PATH, BUNDLE_PATH],
    { encoding: 'utf8', timeout: 120_000 }
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`activation child printed non-JSON output: ${stdout}`);
  }
  const sample = parsed as ActivationSample;
  if (
    typeof sample?.activateMs !== 'number' ||
    !Array.isArray(sample?.chunksAfterActivate) ||
    typeof sample?.typescript?.editCount !== 'number'
  ) {
    throw new Error(`activation child printed an unexpected payload: ${stdout}`);
  }
  return sample;
}

function printActivationSummary(sample: ActivationSample): void {
  const list = (chunks: readonly string[]): string =>
    chunks.length === 0 ? 'none' : chunks.join(', ');
  // eslint-disable-next-line no-console
  console.log(
    '\nactivation + first formats against the built bundle:\n' +
      `  activate()       ${sample.activateMs.toFixed(1)} ms ` +
      `(budget < ${ACTIVATION_BUDGET.activateMs * TIME_MULTIPLIER} ms), ` +
      `${sample.providerCount} provider(s) registered\n` +
      `  chunks loaded    after activate: ${list(sample.chunksAfterActivate)}\n` +
      `  first ts format  ${sample.typescript.elapsedMs.toFixed(0)} ms ` +
      `(budget < ${ACTIVATION_BUDGET.firstTsFormatMs * TIME_MULTIPLIER} ms, no preload), ` +
      `${sample.typescript.editCount} edit(s); chunks: ${list(sample.chunksAfterTypescript)}\n` +
      `  json format      ${sample.json.editCount} edit(s); chunks: ${list(sample.chunksAfterJson)}\n` +
      `  css format       ${sample.css.editCount} edit(s); chunks: ${list(sample.chunksAfterCss)}`
  );
}

function printSummary(summary: StartupSummary): void {
  const heapMb = (summary.heapUsedDeltaBytesMedian / (1024 * 1024)).toFixed(1);
  const heapBudgetMb = Math.round(STARTUP_BUDGET.heapUsedDeltaBytes / (1024 * 1024));
  const chunks =
    summary.chunkModulesLoaded.length === 0
      ? 'none'
      : summary.chunkModulesLoaded.join(', ');
  // eslint-disable-next-line no-console
  console.log(
    `cold require of dist/extension.js over ${summary.samples} run(s):\n` +
      `  requireMs        median ${summary.requireMsMedian.toFixed(1)} ms ` +
      `(budget < ${STARTUP_BUDGET.requireMs * TIME_MULTIPLIER} ms), ` +
      `max ${summary.requireMsMax.toFixed(1)} ms\n` +
      `  retained heap    median ${heapMb} MB ` +
      `(budget < ${heapBudgetMb} MB, not CI-scaled)\n` +
      `  require.cache    ${summary.moduleCount} module(s); lazy chunks loaded: ${chunks}`
  );
}

function persistScenario(summary: StartupSummary): void {
  const scenario: StartupScenario = {
    samples: summary.samples,
    requireMsMedian: round1(summary.requireMsMedian),
    requireMsMax: round1(summary.requireMsMax),
    heapUsedDeltaBytesMedian: Math.round(summary.heapUsedDeltaBytesMedian),
    moduleCount: summary.moduleCount,
    chunkModulesLoaded: summary.chunkModulesLoaded
  };
  writeResults(mergeScenario(readResults(), 'startup', scenario));
  // eslint-disable-next-line no-console
  console.log(`\nResults written to ${RESULTS_PATH}`);
}

function main(): number {
  // eslint-disable-next-line no-console
  console.log('Tidy Formatter : startup budgets (cold require, stubbed vscode)\n');

  if (!fs.existsSync(BUNDLE_PATH)) {
    // eslint-disable-next-line no-console
    console.error(
      `startup harness FAILED - ${BUNDLE_PATH} not found.\n` +
        '  Run `npm run compile` first (CI runs perf:startup after the compile step).'
    );
    return 1;
  }
  if (TIME_MULTIPLIER !== 1) {
    // eslint-disable-next-line no-console
    console.log(
      `CI mode: wall-clock budgets relaxed x${TIME_MULTIPLIER} ` +
        '(shared CI runners; structural budgets stay strict).\n'
    );
  }

  const samples: StartupSample[] = [];
  for (let i = 0; i < STARTUP_SAMPLES; i += 1) {
    samples.push(runChildOnce());
  }

  const summary = summarize(samples);
  printSummary(summary);
  persistScenario(summary);

  const violations: Violation[] = collectStartupViolations(
    samples,
    summary,
    STARTUP_BUDGET,
    TIME_MULTIPLIER,
    distHasChunks()
  );

  // ADD-11: the activation + format scenario. Skipped only when dist/ has no
  // chunks at all (a pre-ADD-11 bundle); once the split exists this is the gate
  // that proves the packaged loader can actually reach its chunks, which no
  // unit test can prove.
  if (distHasChunks()) {
    const activation = runActivationChild();
    printActivationSummary(activation);
    writeResults(mergeScenario(readResults(), 'activation', activation));
    violations.push(
      ...collectActivationViolations(activation, ACTIVATION_BUDGET, TIME_MULTIPLIER)
    );
  }

  // eslint-disable-next-line no-console
  console.log('');
  if (violations.length === 0) {
    // eslint-disable-next-line no-console
    console.log('PASS : all startup budgets met.');
    return 0;
  }
  // eslint-disable-next-line no-console
  console.log(`FAIL : ${violations.length} startup budget(s) exceeded:`);
  for (const violation of violations) {
    // eslint-disable-next-line no-console
    console.log(`  - [${violation.budget}] ${violation.detail}`);
  }
  return 1;
}

try {
  process.exitCode = main();
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  // eslint-disable-next-line no-console
  console.error(`startup harness crashed: ${message}`);
  process.exitCode = 1;
}
