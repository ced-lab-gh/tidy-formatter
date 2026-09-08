// Manifest-level lock of the ADD-11 chunk layout, mirroring perfTooling.test.ts:
// PURE (no 'vscode'), reads repo files from disk, needs no built dist/.
//
// Locks:
//   - the check:chunks script exists and is wired into vscode:prepublish and CI,
//     so a VSIX can never be produced without proving the split;
//   - the per-chunk metafiles are VSIX-excluded like dist/meta.json;
//   - every chunk carries a frozen size budget, and the two frozen tables
//     (scripts/check-chunks.mjs, scripts/bundle-baseline.json) agree;
//   - esbuild.js still enforces the split at BUILD time (chunk registry + the
//     chunk-only import filter);
//   - ANTI-HIJACK: the idle preload is a one-shot timer owned by
//     context.subscriptions, not a hook; activation events are untouched.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../../..');

// Never the raw character in sources: the repo forbids U+2014 in shipped text.
const EM_DASH = String.fromCharCode(0x2014);

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const CHUNK_FILES = [
  'chunk-prettier.js',
  'chunk-guard-js.js',
  'chunk-guard-css.js',
  'chunk-guard-html.js'
];

describe('manifest : chunk tooling is wired (ADD-11)', () => {
  const scripts = (
    JSON.parse(read('package.json')) as { scripts: Record<string, string> }
  ).scripts;

  it('exposes check:chunks with its exact command', () => {
    assert.equal(scripts['check:chunks'], 'node scripts/check-chunks.mjs');
  });

  it('runs check:chunks before publishing so an incomplete VSIX is impossible', () => {
    assert.equal(
      scripts['vscode:prepublish'],
      'npm run compile && npm run check:chunks'
    );
  });

  it('CI runs check:chunks after the compile step', () => {
    const ci = read('.github/workflows/ci.yml');
    assert.ok(ci.includes('npm run check:chunks'));
    assert.ok(
      ci.indexOf('npm run compile') < ci.indexOf('npm run check:chunks'),
      'check:chunks needs dist/, so it must come after compile'
    );
  });

  it('.vscodeignore excludes every generated metafile from the VSIX', () => {
    const lines = read('.vscodeignore').split(/\r?\n/);
    assert.ok(lines.includes('dist/meta.json'));
    for (const chunk of CHUNK_FILES) {
      const metafile = `dist/meta.${chunk.replace(/\.js$/, '')}.json`;
      assert.ok(lines.includes(metafile), `${metafile} must be VSIX-excluded`);
    }
  });

  it('.vscodeignore still ships dist/ itself (the chunks must be packaged)', () => {
    const lines = read('.vscodeignore')
      .split(/\r?\n/)
      .map((line) => line.trim());
    assert.ok(
      !lines.includes('dist/**') && !lines.includes('dist/'),
      'excluding dist/ would ship an extension with no chunks at all'
    );
  });
});

describe('manifest : frozen chunk budgets (ADD-11)', () => {
  const baseline = JSON.parse(read('scripts/bundle-baseline.json')) as {
    schemaVersion: number;
    files: Record<string, { maxBytes: number }>;
  };
  const gate = read('scripts/check-chunks.mjs');

  it('every chunk has a positive frozen budget in bundle-baseline.json', () => {
    for (const chunk of CHUNK_FILES) {
      const entry = baseline.files[chunk];
      assert.ok(entry, `${chunk} must be budgeted`);
      assert.ok(entry.maxBytes > 0, `${chunk}: maxBytes must be positive`);
    }
  });

  it('the host bundle budget stays under the 700 KiB ADD-11 design ceiling', () => {
    const host = baseline.files['extension.js'];
    assert.ok(host, 'extension.js must be budgeted');
    assert.ok(
      host.maxBytes <= 700 * 1024,
      'the whole point of the split is a host bundle under 700 KiB; ' +
        'raising this budget past it means the split regressed'
    );
  });

  it('check-chunks.mjs mirrors the same ceilings (drift would disarm one gate)', () => {
    for (const chunk of CHUNK_FILES) {
      const expected = baseline.files[chunk].maxBytes;
      assert.ok(
        gate.includes(String(expected)),
        `scripts/check-chunks.mjs must carry the same ${chunk} ceiling (${expected})`
      );
    }
  });

  it('check-chunks.mjs refuses every chunk-only package in the host metafile', () => {
    for (const fragment of [
      'node_modules/prettier/',
      'node_modules/@babel/parser/',
      'node_modules/@babel/types/',
      'node_modules/postcss/',
      'node_modules/postcss-scss/',
      'node_modules/postcss-less/',
      'node_modules/parse5/'
    ]) {
      assert.ok(gate.includes(fragment), `${fragment} must be gated`);
    }
  });
});

describe('manifest : the build enforces the split (ADD-11)', () => {
  const esbuildConfig = read('esbuild.js');

  it('declares one build per chunk', () => {
    for (const chunk of CHUNK_FILES) {
      const name = chunk.replace(/\.js$/, '');
      assert.ok(esbuildConfig.includes(`'${name}'`), `${name} must be in the registry`);
    }
  });

  it('fails the build when a host module imports a chunk-only package', () => {
    assert.ok(esbuildConfig.includes('CHUNK_ONLY_FILTER'));
    assert.ok(esbuildConfig.includes('is chunk-only and must not be imported'));
  });

  it('keeps emitting the host metafile the ADD-09 gates read', () => {
    assert.ok(esbuildConfig.includes('metafile: production'));
    assert.ok(esbuildConfig.includes("'meta.json'"));
    assert.ok(esbuildConfig.includes('result.metafile'));
  });

  it('copies the editorconfig wasm the bundler cannot see', () => {
    assert.ok(esbuildConfig.includes('@one-ini/wasm/one_ini_bg.wasm'));
  });
});

describe('manifest : the idle preload is not a hook (ADD-11, ARCH-01/02)', () => {
  const extension = read('src/extension.ts');
  const loader = read('src/chunks/loader.ts');
  const manifest = JSON.parse(read('package.json')) as {
    activationEvents: string[];
  };

  it('adds NO save / focus / change hook anywhere in the entry point', () => {
    for (const forbidden of [
      'onDidSaveTextDocument',
      'onWillSaveTextDocument',
      'onDidChangeTextDocument',
      'onDidOpenTextDocument',
      'onDidChangeWindowState',
      'registerOnTypeFormattingEditProvider'
    ]) {
      assert.ok(
        !extension.includes(forbidden),
        `${forbidden} would make Tidy act without being asked`
      );
    }
  });

  it('schedules the preload as a one-shot timer owned by context.subscriptions', () => {
    assert.ok(extension.includes('scheduleIdleChunkPreload'));
    assert.ok(extension.includes('context.subscriptions.push(scheduleIdleChunkPreload())'));
    assert.ok(extension.includes('schedule.dispose()'), 'disposal must cancel it');
    assert.ok(extension.includes('IDLE_PRELOAD_DELAY_MS = 5000'));
    // The timer itself lives in the vscode-free loader so its one-shot and
    // cancellation contract is unit-testable; it is still a bare setTimeout.
    assert.ok(loader.includes('setTimeout('));
    assert.ok(loader.includes('clearTimeout(timer)'), 'disposal must cancel it');
    assert.ok(!loader.includes("from 'vscode'"));
  });

  it('reads the open languages ONCE and subscribes to nothing (ADD-11 honesty fix)', () => {
    // Language-aware preload: warming a chunk no open language can reach would
    // undo the lazy split five seconds after activation, for every user.
    assert.ok(extension.includes('vscode.window.visibleTextEditors'));
    // Comment lines are dropped first: the doctrine comment above the read names
    // the very listener it promises never to register.
    const code = extension
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      .join('\n');
    assert.ok(
      !code.includes('onDidChangeVisibleTextEditors'),
      'a single read, never a listener'
    );
    assert.ok(loader.includes('chunksForLanguages'));
    // json/jsonc keep needing no chunk at all, and the CSS family must never
    // pull the chunk that carries the TypeScript printer.
    assert.match(loader, /\n {2}json: \[\],/);
    assert.match(loader, /\n {2}css: \['chunk-guard-css'\],/);
  });

  it('the preload writes no setting and never touches editor.defaultFormatter', () => {
    const preload = extension.slice(extension.indexOf('function scheduleIdleChunkPreload'));
    assert.ok(!preload.includes('defaultFormatter'));
    assert.ok(!preload.includes('.update('), 'the preload must not write any setting');
    assert.ok(
      !preload.includes('showInformationMessage') &&
        !preload.includes('showWarningMessage'),
      'a background preload must not surface a toast'
    );
  });

  it('reports preload results only to the local output channel (zero telemetry)', () => {
    assert.ok(extension.includes('getTidyOutputChannel()'));
    for (const forbidden of ['fetch(', 'https://', 'http://', 'XMLHttpRequest']) {
      const preload = extension.slice(
        extension.indexOf('function scheduleIdleChunkPreload')
      );
      assert.ok(!preload.includes(forbidden), `${forbidden} must not appear`);
    }
  });

  it('adds NO activation event: every event is still onLanguage:*', () => {
    for (const event of manifest.activationEvents) {
      assert.match(event, /^onLanguage:/, `unexpected activation event ${event}`);
    }
  });

  it('ships no em dash and no French in the preload strings', () => {
    const preload = extension.slice(extension.indexOf('function scheduleIdleChunkPreload'));
    assert.ok(!preload.includes(EM_DASH), 'no em dash');
    assert.ok(preload.includes('engine chunks ready in'));
    assert.ok(preload.includes('it will load on first use'));
  });
});
