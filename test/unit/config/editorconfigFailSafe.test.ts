// Fail-safe suite for the .editorconfig layer: it must NEVER be able to break
// formatting. PURE (no 'vscode'): plain mocha + tsx.
//
// REGRESSION THIS LOCKS IN (a missing asset killed ALL formatting):
// the `editorconfig` package pulls in @one-ini/wasm, whose CommonJS entry does a
// bare readFileSync of a SIBLING `one_ini_bg.wasm` at MODULE INITIALISATION.
// While that package was imported STATICALLY by src/config/editorconfig.ts,
// esbuild hoisted that read into the module's own initialisation, ABOVE the
// try/catch written inside readEditorConfigLayer. Deleting dist/one_ini_bg.wasm
// from an installed extension (antivirus quarantine, partial install) therefore
// made require('dist/extension.js') itself throw ENOENT: activation died and
// EVERY format failed, even in a workspace with no .editorconfig at all, while
// the doc comment claimed "Never throws ... any parse/IO failure yields
// undefined".
//
// Two kinds of lock below:
//   1. STATIC : no value-level import of 'editorconfig' survives in the module
//      (a value import is exactly what the bundler hoists), and the single
//      require is nested inside a function body.
//   2. BEHAVIOURAL : every way the parser can be unusable (cannot load, loads
//      but is not a function, throws while parsing, returns junk) degrades to
//      "no .editorconfig layer" and never propagates an exception.
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadBundledParseSync,
  memoizeParseSyncLoader,
  readEditorConfigLayer,
  SOURCE_EDITORCONFIG,
  type ParseSyncFn,
  type ParseSyncLoader
} from '../../../src/config/editorconfig';
import { resolveOptions } from '../../../src/config/resolver';

const SOURCE_PATH = join(__dirname, '../../../src/config/editorconfig.ts');

describe('config/editorconfig : the package is never loaded at module top level', () => {
  const source = readFileSync(SOURCE_PATH, 'utf8');

  it("carries no VALUE import of 'editorconfig' (type-only imports are erased)", () => {
    // A value import is what esbuild hoists above the guard. `import type
    // { Props } from 'editorconfig'` is erased at compile time and stays legal.
    const valueImport =
      /^\s*import\s+(?!type[\s{])[^;]*?from\s+['"]editorconfig['"]/m;
    assert.equal(
      valueImport.test(source),
      false,
      "src/config/editorconfig.ts must not statically import 'editorconfig'"
    );
    const exportFrom =
      /^\s*export\s+(?!type[\s{])[^;]*?from\s+['"]editorconfig['"]/m;
    assert.equal(
      exportFrom.test(source),
      false,
      "src/config/editorconfig.ts must not re-export from 'editorconfig'"
    );
  });

  it("requires 'editorconfig' exactly once, from inside a function body", () => {
    const requires = [
      ...source.matchAll(/require\(\s*['"]editorconfig['"]\s*\)/g)
    ];
    assert.equal(requires.length, 1, 'exactly one lazy require is expected');
    // A top-level require would start its line at indent 0; ours is nested.
    const at = requires[0].index ?? 0;
    const lineStart = source.lastIndexOf('\n', at) + 1;
    const indent = /^\s*/.exec(source.slice(lineStart, at))?.[0] ?? '';
    assert.ok(
      indent.length > 0,
      'the require must live inside a function, not at module top level'
    );
  });

  it('exposes a lazy production loader rather than a resolved parser', () => {
    assert.equal(typeof loadBundledParseSync, 'function');
  });
});

describe('config/editorconfig : memoizeParseSyncLoader', () => {
  const fakeParse: ParseSyncFn = () => ({});

  it('resolves a working loader at most once', () => {
    let calls = 0;
    const loader = memoizeParseSyncLoader(() => {
      calls += 1;
      return fakeParse;
    });
    assert.equal(loader(), fakeParse);
    assert.equal(loader(), fakeParse);
    assert.equal(loader(), fakeParse);
    assert.equal(calls, 1, 'a working parser is resolved once');
  });

  it('never retries, and never rethrows, a loader that threw', () => {
    let calls = 0;
    const loader = memoizeParseSyncLoader(() => {
      calls += 1;
      throw new Error("ENOENT: no such file, open 'dist/one_ini_bg.wasm'");
    });
    assert.equal(loader(), undefined);
    assert.equal(loader(), undefined);
    assert.equal(calls, 1, 'a broken parser is not re-loaded on every format');
  });

  it('treats a non-function result as permanently unavailable', () => {
    let calls = 0;
    const loader = memoizeParseSyncLoader(() => {
      calls += 1;
      return undefined;
    });
    assert.equal(loader(), undefined);
    assert.equal(loader(), undefined);
    assert.equal(calls, 1);
  });
});

describe('config/editorconfig : readEditorConfigLayer degrades, never throws', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tidy-ec-failsafe-'));
    // A REAL .editorconfig exists in every case below, so a failure to degrade
    // would be visible: the call would throw, or the layer would be applied.
    writeFileSync(
      join(root, '.editorconfig'),
      ['root = true', '', '[*]', 'indent_style = space', 'indent_size = 2'].join(
        '\n'
      )
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** The exact failure a missing or quarantined wasm asset produces. */
  const throwingLoader: ParseSyncLoader = () => {
    throw Object.assign(
      new Error("ENOENT: no such file or directory, open 'one_ini_bg.wasm'"),
      { code: 'ENOENT' }
    );
  };

  it('yields undefined when the parser cannot be loaded at all (missing wasm)', () => {
    let layer: unknown = 'not-run';
    assert.doesNotThrow(() => {
      layer = readEditorConfigLayer(join(root, 'a.css'), throwingLoader);
    });
    assert.equal(layer, undefined, 'the .editorconfig layer is simply skipped');
  });

  it('yields undefined when the loader reports the parser is unavailable', () => {
    assert.equal(
      readEditorConfigLayer(join(root, 'a.css'), () => undefined),
      undefined
    );
  });

  it('yields undefined when the package shape changed (parser not a function)', () => {
    const bogus = 'not a function' as unknown as ParseSyncFn;
    assert.equal(
      readEditorConfigLayer(join(root, 'a.css'), () => bogus),
      undefined
    );
  });

  it('yields undefined when parseSync itself throws (corrupt wasm instance)', () => {
    const layer = readEditorConfigLayer(join(root, 'a.css'), () => () => {
      throw new TypeError("cannot read properties of undefined (reading 'x')");
    });
    assert.equal(layer, undefined);
  });

  it('yields undefined when parseSync returns a non-object', () => {
    for (const bad of [null, undefined, 'nope', 42]) {
      const layer = readEditorConfigLayer(
        join(root, 'a.css'),
        () => (() => bad) as unknown as ParseSyncFn
      );
      assert.equal(
        layer,
        undefined,
        'parseSync returning ' + JSON.stringify(bad) + ' must be ignored'
      );
    }
  });

  it('still maps normally when the injected parser works', () => {
    const layer = readEditorConfigLayer(
      join(root, 'a.css'),
      () => (() => ({ indent_style: 'space', indent_size: 2 })) as ParseSyncFn
    );
    assert.ok(layer, 'a healthy parser still produces the layer');
    const result = resolveOptions({ languageId: 'css', layers: [layer] });
    assert.equal(result.tabSize, 2);
    assert.equal(result.sources.tabSize, SOURCE_EDITORCONFIG);
  });

  it('the DEFAULT loader still reads the real on-disk cascade', () => {
    // Proves the injection seam did not quietly replace production behaviour.
    const layer = readEditorConfigLayer(join(root, 'a.css'));
    assert.ok(layer, 'the bundled parser produces the layer');
    assert.equal(
      resolveOptions({ languageId: 'css', layers: [layer] }).tabSize,
      2
    );
  });
});
