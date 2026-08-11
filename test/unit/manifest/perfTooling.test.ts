// Manifest-level lock of the ADD-09 tooling contract, mirroring
// walkthroughs.test.ts: PURE (no 'vscode'), reads repo files from disk.
//
// Locks:
//   - the tooling npm scripts exist with their exact commands;
//   - dist/meta.json can never ship in the VSIX and results.json can never be
//     committed (ignore files);
//   - test/** and scripts/** stay VSIX-excluded (the vscode stub and the gate
//     scripts must never ship: anti-hijack hygiene);
//   - both frozen baselines exist, parse, and are internally sane;
//   - the extension.js budget stays under a 3 MB hard ceiling: raising it
//     beyond that requires touching THIS test too (deliberate double consent);
//   - ci.yml actually wires the three gates.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../../..');

function read(relPath: string): string {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

describe('manifest : perf tooling scripts (ADD-09)', () => {
  const scripts = (
    JSON.parse(read('package.json')) as {
      scripts: Record<string, string>;
    }
  ).scripts;

  it('wires the tooling scripts with their exact commands', () => {
    assert.equal(scripts['perf'], 'tsx test/perf/perf.ts');
    assert.equal(scripts['perf:baseline'], 'tsx test/perf/perf.ts --write-baseline');
    assert.equal(scripts['perf:check'], 'node scripts/check-perf-regression.mjs');
    assert.equal(scripts['perf:startup'], 'tsx test/perf/startup.ts');
    assert.equal(scripts['check:bundle'], 'node scripts/check-bundle-size.mjs');
    assert.equal(scripts['analyze'], 'node scripts/analyze-bundle.mjs');
  });
});

describe('manifest : perf tooling never ships and never gets committed (ADD-09)', () => {
  it('.vscodeignore excludes dist/meta.json from the VSIX', () => {
    const lines = read('.vscodeignore').split(/\r?\n/);
    assert.ok(lines.includes('dist/meta.json'), 'dist/meta.json must be VSIX-excluded');
  });

  it('.vscodeignore still excludes test/** and scripts/** (stub + gates never ship)', () => {
    const lines = read('.vscodeignore').split(/\r?\n/);
    assert.ok(lines.includes('test/**'));
    assert.ok(lines.includes('scripts/**'));
  });

  it('.gitignore ignores the generated test/perf/results.json', () => {
    const lines = read('.gitignore').split(/\r?\n/);
    assert.ok(lines.includes('test/perf/results.json'));
  });
});

describe('manifest : the production build emits the metafile (ADD-09)', () => {
  const esbuildConfig = read('esbuild.js');

  it('enables metafile in production only', () => {
    assert.ok(esbuildConfig.includes('metafile: production'));
  });

  it('writes dist/meta.json after a production build', () => {
    assert.ok(esbuildConfig.includes("'meta.json'"));
    assert.ok(esbuildConfig.includes('result.metafile'));
  });
});

describe('manifest : frozen baselines are sane (ADD-09)', () => {
  it('test/perf/baseline.json covers every perf case with positive budgets', () => {
    const baseline = JSON.parse(read('test/perf/baseline.json')) as {
      schemaVersion: number;
      scenarios: {
        format: {
          cases: Record<string, { p50Ms: number; p95Ms: number; guardShare: number }>;
        };
      };
    };
    assert.equal(baseline.schemaVersion, 1);
    const cases = baseline.scenarios.format.cases;
    const expected = [
      'css',
      'scss',
      'less',
      'html',
      'json',
      'jsonc',
      'javascript',
      'typescript',
      'typescriptreact',
      'javascriptreact',
      'json_5mb',
      'json_10mb'
    ];
    for (const name of expected) {
      const entry = cases[name];
      assert.ok(entry, `baseline case '${name}' must exist`);
      assert.ok(entry.p95Ms > 0, `${name}: p95Ms must be positive`);
      assert.ok(entry.p95Ms >= entry.p50Ms, `${name}: p95 must be >= p50`);
      assert.ok(entry.guardShare >= 0, `${name}: guardShare must be >= 0`);
    }
  });

  it('every baseline case key is a stable identifier (no spaces or parentheses)', () => {
    const baseline = JSON.parse(read('test/perf/baseline.json')) as {
      scenarios: { format: { cases: Record<string, unknown> } };
    };
    for (const name of Object.keys(baseline.scenarios.format.cases)) {
      assert.match(name, /^[a-z0-9_]+$/i, `baseline case key '${name}' is not stable`);
    }
  });

  it('scripts/bundle-baseline.json budgets extension.js under the 3 MB hard ceiling', () => {
    const baseline = JSON.parse(read('scripts/bundle-baseline.json')) as {
      schemaVersion: number;
      files: Record<string, { maxBytes: number }>;
    };
    assert.equal(baseline.schemaVersion, 1);
    const extension = baseline.files['extension.js'];
    assert.ok(extension, 'extension.js must be budgeted');
    assert.ok(extension.maxBytes > 0);
    assert.ok(
      extension.maxBytes <= 3000000,
      'raising the extension.js budget beyond 3 MB requires updating this test too'
    );
    assert.ok(baseline.files['one_ini_bg.wasm'], 'the editorconfig wasm must be budgeted');
  });
});

describe('manifest : CI wires the three perf gates (ADD-09)', () => {
  const ci = read('.github/workflows/ci.yml');

  it('runs the regression gate after perf', () => {
    assert.ok(ci.includes('npm run perf:check'));
    assert.ok(
      ci.indexOf('npm run perf\n') < ci.indexOf('npm run perf:check'),
      'perf must write results.json before perf:check reads it'
    );
  });

  it('runs the startup and bundle gates after compile', () => {
    assert.ok(ci.includes('npm run perf:startup'));
    assert.ok(ci.includes('npm run check:bundle'));
    assert.ok(
      ci.indexOf('npm run compile') < ci.indexOf('npm run perf:startup'),
      'perf:startup needs dist/, so it must come after compile'
    );
    assert.ok(
      ci.indexOf('npm run compile') < ci.indexOf('npm run check:bundle'),
      'check:bundle needs dist/, so it must come after compile'
    );
  });

  it('uploads the perf results artifact', () => {
    assert.ok(ci.includes('test/perf/results.json'));
  });
});
