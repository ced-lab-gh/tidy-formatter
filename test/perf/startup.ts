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
  STARTUP_BUDGET,
  STARTUP_SAMPLES,
  collectStartupViolations,
  summarize,
  type StartupSample,
  type StartupSummary
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

  const violations = collectStartupViolations(
    samples,
    summary,
    STARTUP_BUDGET,
    TIME_MULTIPLIER,
    distHasChunks()
  );

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
