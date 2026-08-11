// Perf results + regression baseline persistence (ADD-09).
//
// Two files, one schema owner:
//   - test/perf/results.json  : GENERATED (gitignored, uploaded as CI artifact).
//     Written by every perf harness through mergeScenario(), each harness owning
//     ONE scenario section ('format' for perf.ts, 'startup' for startup.ts).
//     Unknown sections survive the read-merge-write round trip, so future
//     harnesses (memory, config, pathological guard cases) each add a section
//     without touching this file or coordinating with existing writers.
//   - test/perf/baseline.json : VERSIONED. Regenerated ONLY by a deliberate
//     `npm run perf:baseline` on the reference machine (refused on CI) and
//     reviewed in diff. Carries only p50Ms/p95Ms/guardShare per case so diffs
//     stay readable (no volatile timestamps).
//
// Everything except the fs calls is pure and unit-tested
// (test/unit/tooling/resultsFile.test.ts), including the immutability of
// mergeScenario: the previous results object is never mutated.

import * as fs from 'node:fs';
import * as path from 'node:path';

export const RESULTS_SCHEMA_VERSION = 1;

export const RESULTS_PATH = path.join(__dirname, 'results.json');
export const BASELINE_PATH = path.join(__dirname, 'baseline.json');

export interface PerfEnvironment {
  readonly node: string;
  readonly platform: string;
  readonly arch: string;
  readonly ci: boolean;
}

export interface FormatCaseMetrics {
  readonly lines: number;
  readonly bytes: number;
  readonly samples: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
  readonly meanFormatMs: number;
  readonly meanGuardMs: number;
  readonly guardShare: number;
  readonly allApplied: boolean;
}

export interface FormatScenario {
  readonly cases: Readonly<Record<string, FormatCaseMetrics>>;
  readonly eventLoop: {
    readonly residualMaxMs: number;
    readonly rawMaxMs: number;
  };
}

export interface StartupScenario {
  readonly samples: number;
  readonly requireMsMedian: number;
  readonly requireMsMax: number;
  readonly heapUsedDeltaBytesMedian: number;
  readonly moduleCount: number;
  readonly chunkModulesLoaded: readonly string[];
}

export interface PerfResults {
  readonly schemaVersion: number;
  readonly generatedAt: string;
  readonly environment: PerfEnvironment;
  readonly scenarios: {
    readonly format?: FormatScenario;
    readonly startup?: StartupScenario;
    readonly [name: string]: unknown;
  };
}

export interface BaselineFormatCase {
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly guardShare: number;
}

export interface PerfBaseline {
  readonly schemaVersion: number;
  readonly note: string;
  readonly environment: Omit<PerfEnvironment, 'ci'>;
  readonly scenarios: {
    readonly format: {
      readonly cases: Readonly<Record<string, BaselineFormatCase>>;
    };
  };
}

export function currentEnvironment(): PerfEnvironment {
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    ci: Boolean(process.env.CI)
  };
}

/** Round to one decimal so results/baseline diffs stay readable. */
export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Round a ratio (guardShare) to three decimals. */
export function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Return a NEW results object where scenario `name` is replaced by `scenario`,
 * every other scenario of `previous` is preserved, and the envelope
 * (schemaVersion, generatedAt, environment) is restamped. `previous` is never
 * mutated (project immutability rule; asserted by unit test on a frozen input).
 */
export function mergeScenario(
  previous: PerfResults | undefined,
  name: string,
  scenario: unknown
): PerfResults {
  return {
    schemaVersion: RESULTS_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    environment: currentEnvironment(),
    scenarios: {
      ...(previous?.scenarios ?? {}),
      [name]: scenario
    }
  };
}

/**
 * Read a results file. `undefined` when absent (first run). Throws with an
 * actionable message when present but unusable: silently discarding a corrupt
 * file would hide that a previous harness crashed mid-write.
 */
export function readResults(filePath: string = RESULTS_PATH): PerfResults | undefined {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw) as PerfResults;
  if (parsed.schemaVersion !== RESULTS_SCHEMA_VERSION) {
    throw new Error(
      `unsupported results schemaVersion ${String(parsed.schemaVersion)} ` +
        `(expected ${RESULTS_SCHEMA_VERSION}); delete ${filePath} and re-run`
    );
  }
  return parsed;
}

export function writeResults(results: PerfResults, filePath: string = RESULTS_PATH): void {
  fs.writeFileSync(filePath, `${JSON.stringify(results, null, 2)}\n`, 'utf8');
}

export function writeBaseline(
  baseline: PerfBaseline,
  filePath: string = BASELINE_PATH
): void {
  fs.writeFileSync(filePath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
}
