// PURE tests for the ADD-09 bundle-size gate. The .mjs script is loaded via
// dynamic import (pathToFileURL: required on Windows for absolute paths); its
// main() does not run on import (isMain guard), so only the exported pure
// function is exercised.
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

interface Violation {
  budget: string;
  detail: string;
}

interface BundleModule {
  collectBundleViolations(
    files: ReadonlyArray<{ name: string; bytes: number }>,
    baseline: unknown
  ): Violation[];
}

const SCRIPT = path.resolve(__dirname, '../../../scripts/check-bundle-size.mjs');

describe('check-bundle-size : collectBundleViolations', () => {
  let mod: BundleModule;

  before(async () => {
    mod = (await import(pathToFileURL(SCRIPT).href)) as unknown as BundleModule;
  });

  const baseline = {
    schemaVersion: 1,
    files: {
      'extension.js': { maxBytes: 2900000 },
      'one_ini_bg.wasm': { maxBytes: 120000 }
    }
  };

  it('passes when every file is within its frozen budget', () => {
    const violations = mod.collectBundleViolations(
      [
        { name: 'extension.js', bytes: 2818641 },
        { name: 'one_ini_bg.wasm', bytes: 89224 }
      ],
      baseline
    );
    assert.deepEqual(violations, []);
  });

  it('accepts a file exactly AT its budget (regression is strictly over)', () => {
    const violations = mod.collectBundleViolations(
      [
        { name: 'extension.js', bytes: 2900000 },
        { name: 'one_ini_bg.wasm', bytes: 89224 }
      ],
      baseline
    );
    assert.deepEqual(violations, []);
  });

  it('fails a file one byte over its budget, with an actionable detail', () => {
    const violations = mod.collectBundleViolations(
      [
        { name: 'extension.js', bytes: 2900001 },
        { name: 'one_ini_bg.wasm', bytes: 89224 }
      ],
      baseline
    );
    assert.equal(violations.length, 1);
    assert.match(violations[0].detail, /1 over/);
    assert.match(violations[0].detail, /REVIEWED diff/);
  });

  it('fails when a budgeted file is missing from dist/ (wasm dropped silently)', () => {
    const violations = mod.collectBundleViolations(
      [{ name: 'extension.js', bytes: 2818641 }],
      baseline
    );
    assert.equal(violations.length, 1);
    assert.match(violations[0].detail, /one_ini_bg\.wasm/);
    assert.match(violations[0].budget, /budgeted file present/);
  });

  it('fails when an UNBUDGETED executable appears in dist/ (chunk without budget)', () => {
    const violations = mod.collectBundleViolations(
      [
        { name: 'extension.js', bytes: 2818641 },
        { name: 'one_ini_bg.wasm', bytes: 89224 },
        { name: 'chunk-prettier.js', bytes: 900000 }
      ],
      baseline
    );
    assert.equal(violations.length, 1);
    assert.match(violations[0].detail, /chunk-prettier\.js/);
  });

  it('rejects a baseline with a non-positive or missing maxBytes', () => {
    const violations = mod.collectBundleViolations(
      [{ name: 'extension.js', bytes: 1 }],
      { files: { 'extension.js': { maxBytes: 0 } } }
    );
    assert.equal(violations.length, 1);
    assert.match(violations[0].budget, /baseline shape/);
  });

  it('rejects an empty or absent files map', () => {
    assert.equal(mod.collectBundleViolations([], { files: {} }).length, 1);
    assert.equal(mod.collectBundleViolations([], {}).length, 1);
  });
});
