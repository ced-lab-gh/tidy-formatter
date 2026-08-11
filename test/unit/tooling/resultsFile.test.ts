// PURE tests for the ADD-09 results/baseline persistence module.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  RESULTS_SCHEMA_VERSION,
  mergeScenario,
  readResults,
  round1,
  round3,
  writeResults
} from '../../perf/resultsFile';

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

describe('resultsFile : mergeScenario', () => {
  it('stamps the schema version and the environment', () => {
    const merged = mergeScenario(undefined, 'format', { cases: {} });
    assert.equal(merged.schemaVersion, RESULTS_SCHEMA_VERSION);
    assert.equal(merged.environment.node, process.version);
    assert.equal(typeof merged.generatedAt, 'string');
    assert.deepEqual(merged.scenarios.format, { cases: {} });
  });

  it('never mutates the previous results (frozen input round trip)', () => {
    const previous = deepFreeze(
      mergeScenario(undefined, 'format', { cases: { css: { p95Ms: 69 } } })
    );
    // Would throw in strict mode if mergeScenario wrote into `previous`.
    const merged = mergeScenario(previous, 'startup', { requireMsMedian: 229 });
    assert.notEqual(merged, previous);
    assert.deepEqual(previous.scenarios.format, { cases: { css: { p95Ms: 69 } } });
  });

  it('preserves unknown scenario sections (future harnesses)', () => {
    const previous = mergeScenario(undefined, 'memory', { rssMb: 120 });
    const merged = mergeScenario(previous, 'format', { cases: {} });
    assert.deepEqual(merged.scenarios.memory, { rssMb: 120 });
    assert.deepEqual(merged.scenarios.format, { cases: {} });
  });

  it('replaces an existing section of the same name', () => {
    const previous = mergeScenario(undefined, 'format', { cases: { css: { p95Ms: 1 } } });
    const merged = mergeScenario(previous, 'format', { cases: { css: { p95Ms: 2 } } });
    assert.deepEqual(merged.scenarios.format, { cases: { css: { p95Ms: 2 } } });
  });
});

describe('resultsFile : read/write round trip', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tidy-resultsfile-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns undefined when the file does not exist', () => {
    assert.equal(readResults(path.join(dir, 'absent.json')), undefined);
  });

  it('round-trips a results object through disk', () => {
    const file = path.join(dir, 'results.json');
    const results = mergeScenario(undefined, 'format', { cases: {} });
    writeResults(results, file);
    assert.deepEqual(readResults(file), results);
  });

  it('throws an actionable error on an unsupported schemaVersion', () => {
    const file = path.join(dir, 'results.json');
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 999, scenarios: {} }), 'utf8');
    assert.throws(() => readResults(file), /unsupported results schemaVersion 999/);
  });

  it('throws on unparseable JSON instead of silently discarding it', () => {
    const file = path.join(dir, 'results.json');
    fs.writeFileSync(file, '{ not json', 'utf8');
    assert.throws(() => readResults(file));
  });
});

describe('resultsFile : rounding', () => {
  it('round1 keeps one decimal', () => {
    assert.equal(round1(69.04), 69.0);
    assert.equal(round1(69.05), 69.1);
  });

  it('round3 keeps three decimals (guardShare)', () => {
    assert.equal(round3(1.5115), 1.512);
  });
});
