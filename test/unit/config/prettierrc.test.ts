// Unit tests for the pure .prettierrc reader (ADD-13).
//
// Three tiers, all PURE (no 'vscode'):
//   1. mapPrettierConfig: parsed object -> resolver-ready values + warnings
//      (allow-list of ten AST-safe keys; everything else ignored with a trace).
//   2. parsePrettierrcData: raw text -> object per data format (JSON / JSONC /
//      JSON5 / YAML / TOML), fail-soft on malformed input.
//   3. findPrettierConfig / readPrettierrcLayer: on-disk discovery BOUNDED to
//      the workspace root, against real temporary files, plus precedence
//      composition through the real pure resolver.
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  symlinkSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import {
  mapPrettierConfig,
  parsePrettierrcData,
  findPrettierConfig,
  readPrettierrcLayer,
  comparableDir,
  isWithinDir,
  staticPrintEngine,
  MAX_PRETTIERRC_BYTES,
  SOURCE_PRETTIERRC,
  type PrettierrcWarning,
  type PrintEngineId
} from '../../../src/config/prettierrc';
import { resolveEngineIdForSource } from '../../../src/engine/dispatcher';
import { resolveOptions, type ConfigLayer } from '../../../src/config/resolver';
import type { LangId } from '../../../src/types';

function mapFor(
  root: Record<string, unknown>,
  languageId: LangId = 'typescript',
  printEngine?: PrintEngineId
): { values: Record<string, unknown>; warnings: PrettierrcWarning[] } {
  const warnings: PrettierrcWarning[] = [];
  const values = mapPrettierConfig(
    root,
    languageId,
    `${SOURCE_PRETTIERRC} at /p/.prettierrc`,
    warnings,
    printEngine ?? staticPrintEngine(languageId)
  );
  return { values, warnings };
}

/** Uppercase the LAST path segment, keeping the parent intact. */
function upperLastSegment(dir: string): string {
  return join(dirname(dir), basename(dir).toUpperCase());
}

describe('config/prettierrc : mapPrettierConfig (pure allow-list)', () => {
  it('maps printWidth and the seven stylistic keys to flat prettier.* entries', () => {
    const { values, warnings } = mapFor({
      printWidth: 90,
      semi: false,
      singleQuote: true,
      jsxSingleQuote: true,
      trailingComma: 'es5',
      bracketSpacing: false,
      bracketSameLine: true,
      arrowParens: 'avoid'
    });
    assert.equal(warnings.length, 0);
    assert.deepEqual(values, {
      'prettier.printWidth': 90,
      'prettier.semi': false,
      'prettier.singleQuote': true,
      'prettier.jsxSingleQuote': true,
      'prettier.trailingComma': 'es5',
      'prettier.bracketSpacing': false,
      'prettier.bracketSameLine': true,
      'prettier.arrowParens': 'avoid'
    });
  });

  it('maps tabWidth to the typed tabSize for typescript', () => {
    const { values, warnings } = mapFor({ tabWidth: 2 });
    assert.equal(warnings.length, 0);
    assert.deepEqual(values, { tabSize: 2 });
  });

  it('maps useTabs to insertSpaces, inverted', () => {
    assert.deepEqual(mapFor({ useTabs: true }).values, { insertSpaces: false });
    assert.deepEqual(mapFor({ useTabs: false }).values, { insertSpaces: true });
  });

  it('skips tabWidth/useTabs for a js-beautify-printed javascript file (with warnings), keeps stylistic keys', () => {
    const { values, warnings } = mapFor(
      { tabWidth: 2, useTabs: true, singleQuote: true },
      'javascript',
      'js-beautify'
    );
    assert.deepEqual(values, { 'prettier.singleQuote': true });
    assert.ok(warnings.some((w) => /tabWidth/.test(w.message)));
    assert.ok(warnings.some((w) => /useTabs/.test(w.message)));
  });

  it('maps the indentation keys for a javascript file Prettier really prints (JSX re-route)', () => {
    const { values, warnings } = mapFor(
      { tabWidth: 2, useTabs: true, singleQuote: true },
      'javascript',
      'prettier'
    );
    assert.deepEqual(values, {
      tabSize: 2,
      insertSpaces: false,
      'prettier.singleQuote': true
    });
    assert.equal(
      warnings.length,
      0,
      'nothing is dropped when Prettier is the printer'
    );
  });

  it('HONESTY: no warning ever blames js-beautify for a file Prettier prints', () => {
    for (const lang of [
      'typescript',
      'typescriptreact',
      'javascriptreact',
      'javascript'
    ] as LangId[]) {
      const { warnings } = mapFor({ tabWidth: 2, useTabs: true }, lang, 'prettier');
      assert.deepEqual(
        warnings.map((w) => w.message).filter((m) => /js-beautify/.test(m)),
        [],
        lang
      );
    }
  });

  it('the dropped-key warning names the engine that really ran, not a language', () => {
    const { warnings } = mapFor(
      { tabWidth: 2, useTabs: true },
      'javascript',
      'js-beautify'
    );
    assert.equal(warnings.length, 2);
    for (const warning of warnings) {
      assert.match(warning.message, /printed by js-beautify, not by Prettier/);
    }
  });

  it('the gate is the ENGINE, not the languageId (typescript printed by js-beautify keeps its indentation out)', () => {
    // Defensive, not a routing Tidy performs today: if a Prettier-native
    // language ever stopped being printed by Prettier, its indentation keys
    // must stop being applied on the same day.
    const { values, warnings } = mapFor(
      { tabWidth: 2, useTabs: true, semi: false },
      'typescript',
      'js-beautify'
    );
    assert.deepEqual(values, { 'prettier.semi': false });
    assert.equal(warnings.length, 2);
  });

  it('staticPrintEngine is Prettier for the three native languages and js-beautify for plain javascript', () => {
    assert.equal(staticPrintEngine('typescript'), 'prettier');
    assert.equal(staticPrintEngine('typescriptreact'), 'prettier');
    assert.equal(staticPrintEngine('javascriptreact'), 'prettier');
    assert.equal(
      staticPrintEngine('javascript'),
      'js-beautify',
      'the content-dependent language must default to the conservative answer'
    );
    assert.equal(staticPrintEngine('css' as LangId), 'js-beautify');
  });

  it('maps the indentation keys for tsx and jsx too', () => {
    for (const lang of ['typescriptreact', 'javascriptreact'] as LangId[]) {
      assert.deepEqual(
        mapFor({ tabWidth: 8, useTabs: false }, lang).values,
        { tabSize: 8, insertSpaces: true },
        lang
      );
    }
  });

  it('ignores an unknown key with a warning', () => {
    const { values, warnings } = mapFor({ proseWrap: 'always' });
    assert.deepEqual(values, {});
    assert.ok(warnings.some((w) => /proseWrap/.test(w.message)));
  });

  it('ADVERSARIAL: parser/plugins/quoteProps/endOfLine/filepath/rangeStart are never honoured', () => {
    const { values, warnings } = mapFor({
      parser: 'flow',
      plugins: ['evil-plugin'],
      quoteProps: 'consistent',
      endOfLine: 'crlf',
      filepath: '/etc/passwd',
      rangeStart: 0,
      semi: false
    });
    assert.deepEqual(Object.keys(values), ['prettier.semi']);
    for (const denied of [
      'parser',
      'plugins',
      'quoteProps',
      'endOfLine',
      'filepath',
      'rangeStart'
    ]) {
      assert.ok(
        warnings.some((w) => w.message.includes(`"${denied}"`)),
        `expected a warning naming ${denied}`
      );
    }
  });

  it('"overrides" gets a dedicated warning and is not applied', () => {
    const { values, warnings } = mapFor({
      overrides: [{ files: '*.ts', options: { semi: false } }]
    });
    assert.deepEqual(values, {});
    assert.ok(warnings.some((w) => /overrides.*not applied/.test(w.message)));
  });

  it('drops invalid values with one warning each', () => {
    const { values, warnings } = mapFor({
      printWidth: '80',
      tabWidth: 2.5,
      semi: 'false',
      trailingComma: 'everywhere',
      arrowParens: 'sometimes'
    });
    assert.deepEqual(values, {});
    assert.equal(warnings.length, 5);
  });

  it('truncates an oversized rejected value inside the warning message', () => {
    const { warnings } = mapFor({ semi: 'x'.repeat(500) });
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].message.length < 300);
    assert.ok(warnings[0].message.includes('...'));
  });

  it('ADVERSARIAL: a __proto__ payload smuggles nothing and pollutes nothing', () => {
    const root = JSON.parse('{"__proto__": {"semi": false}}') as Record<
      string,
      unknown
    >;
    const { values } = mapFor(root);
    assert.equal(values['prettier.semi'], undefined);
    assert.equal(
      ({} as { semi?: unknown }).semi,
      undefined,
      'no prototype pollution'
    );
  });
});

describe('config/prettierrc : parsePrettierrcData (pure text, per format)', () => {
  it('parses a bare .prettierrc holding JSON', () => {
    const { root, error } = parsePrettierrcData('{"semi": false}', '.prettierrc');
    assert.equal(error, undefined);
    assert.equal(root?.semi, false);
  });

  it('parses a bare .prettierrc holding YAML', () => {
    const { root, error } = parsePrettierrcData(
      'semi: false\nsingleQuote: true\n',
      '.prettierrc'
    );
    assert.equal(error, undefined);
    assert.equal(root?.semi, false);
    assert.equal(root?.singleQuote, true);
  });

  it('parses .prettierrc.json, tolerating comments and trailing commas (JSONC superset)', () => {
    const text = '{\n  // team style\n  "semi": false,\n}';
    const { root, error } = parsePrettierrcData(text, '.prettierrc.json');
    assert.equal(error, undefined);
    assert.equal(root?.semi, false);
  });

  it('parses .prettierrc.json5 (unquoted keys, single quotes)', () => {
    const { root, error } = parsePrettierrcData(
      "{ semi: false, arrowParens: 'avoid' }",
      '.prettierrc.json5'
    );
    assert.equal(error, undefined);
    assert.equal(root?.arrowParens, 'avoid');
  });

  it('parses .prettierrc.yaml and .prettierrc.yml', () => {
    for (const name of ['.prettierrc.yaml', '.prettierrc.yml']) {
      const { root, error } = parsePrettierrcData('singleQuote: true\n', name);
      assert.equal(error, undefined, name);
      assert.equal(root?.singleQuote, true, name);
    }
  });

  it('parses .prettierrc.toml', () => {
    const { root, error } = parsePrettierrcData(
      'singleQuote = true\ntrailingComma = "es5"\n',
      '.prettierrc.toml'
    );
    assert.equal(error, undefined);
    assert.equal(root?.singleQuote, true);
    assert.equal(root?.trailingComma, 'es5');
  });

  it('malformed JSON / YAML / TOML each fail soft with a single-line error', () => {
    const cases: Array<[string, string]> = [
      ['{ "semi": ', '.prettierrc.json'],
      ['semi: [unclosed', '.prettierrc.yaml'],
      ['singleQuote =', '.prettierrc.toml']
    ];
    for (const [text, name] of cases) {
      const { root, error } = parsePrettierrcData(text, name);
      assert.equal(root, undefined, name);
      assert.ok(error, `${name} must yield an error`);
      assert.ok(!error.includes('\n'), `${name} error must be single-line`);
    }
  });

  it('ADVERSARIAL: a YAML function tag is rejected, never constructed', () => {
    const payload =
      'semi: !!js/function >\n\n  function () { return 1; }\n';
    const { root, error } = parsePrettierrcData(payload, '.prettierrc.yaml');
    assert.equal(root, undefined);
    assert.ok(error, 'an unknown or unsafe tag must fail soft');
    assert.ok(
      !error.includes('\n'),
      'the error must stay single-line'
    );
  });

  it('a non-object root fails soft (array, scalar)', () => {
    assert.ok(parsePrettierrcData('- a\n- b\n', '.prettierrc').error);
    assert.ok(parsePrettierrcData('"just a string"', '.prettierrc').error);
  });

  it('an unsupported filename fails soft rather than guessing a parser', () => {
    const { root, error } = parsePrettierrcData('semi = false', '.prettierrc.ini');
    assert.equal(root, undefined);
    assert.match(String(error), /unsupported config filename/);
  });
});

describe('config/prettierrc : findPrettierConfig (bounded walk)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'tidy-prettierrc-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('finds the nearest data config from a nested directory', () => {
    const ws = join(tmp, 'ws');
    mkdirSync(join(ws, 'src', 'deep'), { recursive: true });
    writeFileSync(join(ws, '.prettierrc.json'), '{"semi": false}');
    const warnings: PrettierrcWarning[] = [];
    const hit = findPrettierConfig(join(ws, 'src', 'deep', 'a.ts'), ws, warnings);
    assert.equal(hit?.kind, 'data');
    assert.equal(hit?.path, join(ws, '.prettierrc.json'));
  });

  it('BOUNDARY: stops at the workspace root; a config above it is invisible', () => {
    const outer = join(tmp, 'outer');
    const ws = join(outer, 'ws');
    mkdirSync(join(ws, 'src'), { recursive: true });
    writeFileSync(join(outer, '.prettierrc.json'), '{"semi": false}');
    const file = join(ws, 'src', 'a.ts');
    assert.equal(findPrettierConfig(file, ws, []), undefined);
    // Control: widening the boundary makes the same config visible.
    assert.equal(
      findPrettierConfig(file, outer, [])?.path,
      join(outer, '.prettierrc.json')
    );
  });

  // --- FINDING B: the bound is path CONTAINMENT, not string equality --------
  //
  // Every case below used to make the equality test miss, after which the walk
  // ran on to the filesystem root and honoured a config from OUTSIDE the
  // trusted workspace. The invariant asserted throughout: the config above the
  // workspace is NEVER returned, whatever shape stopDir arrives in.

  /** ws/.prettierrc.json inside, outer/.prettierrc.json above it. */
  function twoLevelFixture(): { outer: string; ws: string; file: string } {
    const outer = join(tmp, 'outer');
    const ws = join(outer, 'ws');
    mkdirSync(join(ws, 'src'), { recursive: true });
    writeFileSync(join(outer, '.prettierrc.json'), '{"semi": false}');
    writeFileSync(join(ws, '.prettierrc.json'), '{"semi": true}');
    return { outer, ws, file: join(ws, 'src', 'a.ts') };
  }

  it('BOUNDARY: a trailing separator on stopDir does not unbound the walk', () => {
    const { outer, ws, file } = twoLevelFixture();
    const hit = findPrettierConfig(file, `${ws}${sep}`, []);
    assert.notEqual(hit?.path, join(outer, '.prettierrc.json'));
    assert.equal(hit?.path, join(ws, '.prettierrc.json'));
  });

  it('BOUNDARY: a case-mismatched stopDir never lets a config above the workspace through', () => {
    const { outer, ws, file } = twoLevelFixture();
    const hit = findPrettierConfig(file, upperLastSegment(ws), []);
    assert.notEqual(
      hit?.path,
      join(outer, '.prettierrc.json'),
      'a config outside the workspace must stay invisible'
    );
    if (process.platform === 'win32') {
      // The filesystem itself is case-insensitive here, so the walk still works.
      assert.equal(hit?.path, join(ws, '.prettierrc.json'));
    } else {
      // Case-sensitive filesystem: the mismatch is a real "outside" answer and
      // the bound fails CLOSED (no layer) rather than open (walk to the root).
      assert.equal(hit, undefined);
    }
  });

  it('BOUNDARY: mixed separators in stopDir do not unbound the walk', () => {
    const { outer, ws, file } = twoLevelFixture();
    const hit = findPrettierConfig(file, ws.split(sep).join('/'), []);
    assert.notEqual(hit?.path, join(outer, '.prettierrc.json'));
    if (process.platform === 'win32') {
      assert.equal(hit?.path, join(ws, '.prettierrc.json'));
    }
  });

  it('BOUNDARY: redundant "." and ".." segments in stopDir are normalised, not escaped', () => {
    const { outer, ws, file } = twoLevelFixture();
    const noisy = join(ws, '.', 'src', '..');
    const hit = findPrettierConfig(file, noisy, []);
    assert.notEqual(hit?.path, join(outer, '.prettierrc.json'));
    assert.equal(hit?.path, join(ws, '.prettierrc.json'));
  });

  it('BOUNDARY (regression): an unrelated stopDir reads NOTHING, it does not walk to the root', () => {
    // The escape the equality check allowed: stopDir is a sibling directory the
    // walk can never reach, so it matched nothing and the walk climbed past the
    // workspace into tmp, honouring a config planted there.
    const ws = join(tmp, 'ws');
    mkdirSync(join(ws, 'src'), { recursive: true });
    writeFileSync(join(tmp, '.prettierrc.json'), '{"semi": false}');
    const sibling = join(tmp, 'ws-other');
    mkdirSync(sibling, { recursive: true });
    assert.equal(
      findPrettierConfig(join(ws, 'src', 'a.ts'), sibling, []),
      undefined
    );
  });

  it('BOUNDARY: a stopDir that is only a NAME PREFIX of the file path is not containment', () => {
    const ws = join(tmp, 'ws');
    mkdirSync(ws, { recursive: true });
    const prefixed = join(tmp, 'ws-extra');
    mkdirSync(prefixed, { recursive: true });
    writeFileSync(join(ws, '.prettierrc.json'), '{"semi": false}');
    assert.equal(findPrettierConfig(join(ws, 'a.ts'), prefixed, []), undefined);
  });

  it('isWithinDir: containment, not string prefixing', () => {
    const root = join(tmp, 'ws');
    assert.ok(isWithinDir(root, root), 'a directory contains itself');
    assert.ok(isWithinDir(`${root}${sep}`, root), 'trailing separator');
    assert.ok(isWithinDir(join(root, 'src', 'deep'), root));
    assert.ok(
      isWithinDir(join(root, '..cache', 'x'), root),
      'a directory merely NAMED "..cache" is inside'
    );
    assert.ok(!isWithinDir(dirname(root), root), 'the parent is not inside');
    assert.ok(
      !isWithinDir(join(tmp, 'ws-extra'), root),
      'a name prefix is not containment'
    );
    assert.ok(!isWithinDir(join(root, '..', 'other'), root));
    if (process.platform === 'win32') {
      assert.ok(isWithinDir('C:\\Ws\\src', 'c:\\ws'), 'case folds on win32');
      assert.ok(
        !isWithinDir('D:\\ws\\src', 'C:\\ws'),
        'another drive is never inside'
      );
      assert.ok(
        !isWithinDir('\\\\server\\share\\ws\\src', 'C:\\ws'),
        'a UNC share is never inside a local path'
      );
    }
  });

  it('searches the workspace root directory itself (stopDir inclusive)', () => {
    const ws = join(tmp, 'ws');
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, '.prettierrc'), 'semi: false\n');
    const hit = findPrettierConfig(join(ws, 'a.ts'), ws, []);
    assert.equal(hit?.path, join(ws, '.prettierrc'));
  });

  it('an empty startFsPath or stopDir yields no hit and no I/O', () => {
    assert.equal(findPrettierConfig('', tmp, []), undefined);
    assert.equal(findPrettierConfig(join(tmp, 'a.ts'), '   ', []), undefined);
  });

  it('a nearer code config shadows a farther data config (no fall-through)', () => {
    const ws = join(tmp, 'ws');
    mkdirSync(join(ws, 'pkg'), { recursive: true });
    writeFileSync(join(ws, '.prettierrc.json'), '{"semi": false}');
    writeFileSync(join(ws, 'pkg', '.prettierrc.cjs'), 'module.exports = {};');
    const hit = findPrettierConfig(join(ws, 'pkg', 'a.ts'), ws, []);
    assert.equal(hit?.kind, 'code');
    assert.equal(hit?.path, join(ws, 'pkg', '.prettierrc.cjs'));
  });

  it('package.json with an OWN "prettier" key wins over a sibling .prettierrc', () => {
    const ws = join(tmp, 'ws');
    mkdirSync(ws, { recursive: true });
    writeFileSync(
      join(ws, 'package.json'),
      '{"name": "x", "prettier": {"semi": false}}'
    );
    writeFileSync(join(ws, '.prettierrc.json'), '{"semi": true}');
    const hit = findPrettierConfig(join(ws, 'a.ts'), ws, []);
    assert.equal(hit?.kind, 'package-json');
    assert.deepEqual(hit?.packagePrettier, { semi: false });
  });

  it('package.json without the key does not stop the walk', () => {
    const ws = join(tmp, 'ws');
    mkdirSync(join(ws, 'pkg'), { recursive: true });
    writeFileSync(join(ws, 'pkg', 'package.json'), '{"name": "x"}');
    writeFileSync(join(ws, '.prettierrc.json'), '{"semi": false}');
    const hit = findPrettierConfig(join(ws, 'pkg', 'a.ts'), ws, []);
    assert.equal(hit?.path, join(ws, '.prettierrc.json'));
  });

  it('a malformed package.json warns and the walk continues', () => {
    const ws = join(tmp, 'ws');
    mkdirSync(join(ws, 'pkg'), { recursive: true });
    writeFileSync(join(ws, 'pkg', 'package.json'), 'not json at all');
    writeFileSync(join(ws, '.prettierrc.json'), '{"semi": false}');
    const warnings: PrettierrcWarning[] = [];
    const hit = findPrettierConfig(join(ws, 'pkg', 'a.ts'), ws, warnings);
    assert.equal(hit?.path, join(ws, '.prettierrc.json'));
    assert.ok(warnings.some((w) => /could not be parsed/.test(w.message)));
  });

  it('an oversized package.json is skipped with a warning and the walk continues', () => {
    const ws = join(tmp, 'ws');
    mkdirSync(join(ws, 'pkg'), { recursive: true });
    writeFileSync(
      join(ws, 'pkg', 'package.json'),
      `{"prettier": {"semi": false}, "pad": "${'a'.repeat(MAX_PRETTIERRC_BYTES)}"}`
    );
    writeFileSync(join(ws, '.prettierrc.json'), '{"semi": true}');
    const warnings: PrettierrcWarning[] = [];
    const hit = findPrettierConfig(join(ws, 'pkg', 'a.ts'), ws, warnings);
    assert.equal(hit?.path, join(ws, '.prettierrc.json'));
    assert.ok(warnings.some((w) => /too large/.test(w.message)));
  });

  it('comparableDir is case-insensitive exactly on win32', () => {
    if (process.platform === 'win32') {
      assert.equal(comparableDir('C:\\Ws'), comparableDir('c:\\ws'));
    } else {
      assert.notEqual(comparableDir('/A'), comparableDir('/a'));
    }
  });
});

// FINDING C: the per-directory probing is one LISTING instead of one stat per
// search place. These lock in the behaviours that switch could have silently
// changed, and the absence of any cache.
describe('config/prettierrc : directory probing (one listing per level)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'tidy-prettierrc-probe-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('a DIRECTORY named .prettierrc is not a config; the walk continues past it', () => {
    const ws = join(tmp, 'ws');
    mkdirSync(join(ws, 'pkg', '.prettierrc'), { recursive: true });
    writeFileSync(join(ws, '.prettierrc.json'), '{"semi": false}');
    const hit = findPrettierConfig(join(ws, 'pkg', 'a.ts'), ws, []);
    assert.equal(hit?.path, join(ws, '.prettierrc.json'));
  });

  it('a SYMLINKED config is still honoured (shared config in a monorepo)', function () {
    const ws = join(tmp, 'ws');
    mkdirSync(join(ws, 'pkg'), { recursive: true });
    const shared = join(ws, 'shared-prettier.json');
    writeFileSync(shared, '{"semi": false}');
    try {
      symlinkSync(shared, join(ws, 'pkg', '.prettierrc.json'), 'file');
    } catch {
      // Windows without Developer Mode cannot create symlinks unprivileged.
      this.skip();
      return;
    }
    const hit = findPrettierConfig(join(ws, 'pkg', 'a.ts'), ws, []);
    assert.equal(hit?.path, join(ws, 'pkg', '.prettierrc.json'));
    assert.equal(hit?.kind, 'data');
    const layer = readPrettierrcLayer(join(ws, 'pkg', 'a.ts'), 'typescript', ws);
    assert.deepEqual(layer.layer?.values, { 'prettier.semi': false });
  });

  it('a DANGLING symlink is not a config; the walk continues past it', function () {
    const ws = join(tmp, 'ws');
    mkdirSync(join(ws, 'pkg'), { recursive: true });
    writeFileSync(join(ws, '.prettierrc.json'), '{"semi": false}');
    try {
      symlinkSync(join(ws, 'nowhere.json'), join(ws, 'pkg', '.prettierrc.json'), 'file');
    } catch {
      this.skip();
      return;
    }
    const hit = findPrettierConfig(join(ws, 'pkg', 'a.ts'), ws, []);
    assert.equal(hit?.path, join(ws, '.prettierrc.json'));
  });

  it('a link POINTING AT A DIRECTORY is not a config; the walk continues past it', () => {
    // Runs everywhere: a junction is creatable unprivileged on Windows (where a
    // file symlink is not), and readdir reports both as symlink dirents, so
    // this is the case where the dirent type alone would answer wrongly.
    const ws = join(tmp, 'ws');
    mkdirSync(join(ws, 'pkg', 'target'), { recursive: true });
    writeFileSync(join(ws, '.prettierrc.json'), '{"semi": false}');
    symlinkSync(
      join(ws, 'pkg', 'target'),
      join(ws, 'pkg', '.prettierrc.json'),
      'junction'
    );
    const hit = findPrettierConfig(join(ws, 'pkg', 'a.ts'), ws, []);
    assert.equal(hit?.path, join(ws, '.prettierrc.json'));
  });

  it('matches config filenames the way the filesystem itself does', () => {
    const ws = join(tmp, 'ws');
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, '.PRETTIERRC.JSON'), '{"semi": false}');
    const hit = findPrettierConfig(join(ws, 'a.ts'), ws, []);
    if (process.platform === 'win32') {
      // The filesystem is case-insensitive, so Prettier reads this file and so
      // must Tidy: probing by stat used to inherit that for free.
      assert.ok(hit, 'a case-variant name must still be found on win32');
      assert.equal(hit?.kind, 'data');
    } else {
      assert.equal(hit, undefined, 'exact names only on a case-sensitive FS');
    }
  });

  it('NO CACHE: an edited config is honoured on the very next call', () => {
    const ws = join(tmp, 'ws');
    mkdirSync(join(ws, 'src'), { recursive: true });
    const file = join(ws, 'src', 'a.ts');
    writeFileSync(join(ws, '.prettierrc.json'), '{"tabWidth": 2}');
    assert.deepEqual(readPrettierrcLayer(file, 'typescript', ws).layer?.values, {
      tabSize: 2
    });
    writeFileSync(join(ws, '.prettierrc.json'), '{"tabWidth": 8}');
    assert.deepEqual(readPrettierrcLayer(file, 'typescript', ws).layer?.values, {
      tabSize: 8
    });
  });

  it('NO CACHE: a config CREATED nearer the file wins on the very next call', () => {
    const ws = join(tmp, 'ws');
    mkdirSync(join(ws, 'src'), { recursive: true });
    const file = join(ws, 'src', 'a.ts');
    writeFileSync(join(ws, '.prettierrc.json'), '{"tabWidth": 2}');
    assert.equal(
      readPrettierrcLayer(file, 'typescript', ws).path,
      join(ws, '.prettierrc.json')
    );
    writeFileSync(join(ws, 'src', '.prettierrc.json'), '{"tabWidth": 8}');
    assert.equal(
      readPrettierrcLayer(file, 'typescript', ws).path,
      join(ws, 'src', '.prettierrc.json')
    );
  });

  it('NO CACHE: a "prettier" key ADDED to an existing package.json is seen at once', () => {
    const ws = join(tmp, 'ws');
    mkdirSync(join(ws, 'src'), { recursive: true });
    const file = join(ws, 'src', 'a.ts');
    writeFileSync(join(ws, 'package.json'), '{"name": "x"}');
    assert.equal(readPrettierrcLayer(file, 'typescript', ws).path, undefined);
    writeFileSync(
      join(ws, 'package.json'),
      '{"name": "x", "prettier": {"semi": false}}'
    );
    assert.equal(
      readPrettierrcLayer(file, 'typescript', ws).path,
      join(ws, 'package.json')
    );
  });
});

// FINDING A, end to end: the engine the DISPATCHER really resolves feeds the
// layer, so a .js file Prettier prints gets the project's indentation and a
// plain .js file does not (and is told so truthfully).
describe('config/prettierrc : indentation follows the engine that really prints', () => {
  let ws: string;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), 'tidy-prettierrc-engine-'));
    mkdirSync(join(ws, 'src'), { recursive: true });
    writeFileSync(join(ws, '.prettierrc.json'), '{"tabWidth": 2, "useTabs": true, "semi": false}');
  });
  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  const JSX_SOURCE = 'const App = () => <div className="a">hi</div>;\n';
  const PLAIN_SOURCE = 'const a = 1;\nif (a < 2) { console.info(a); }\n';

  function layerFor(source: string): ReturnType<typeof readPrettierrcLayer> {
    const engineId = resolveEngineIdForSource('javascript', source);
    const printEngine: PrintEngineId =
      engineId === 'prettier' ? 'prettier' : 'js-beautify';
    return readPrettierrcLayer(
      join(ws, 'src', 'a.js'),
      'javascript',
      ws,
      printEngine
    );
  }

  it('the dispatcher really routes these two sources to different engines', () => {
    assert.equal(resolveEngineIdForSource('javascript', JSX_SOURCE), 'prettier');
    assert.equal(
      resolveEngineIdForSource('javascript', PLAIN_SOURCE),
      'js-beautify'
    );
  });

  it('a JSX .js file (printed by Prettier) gets the project tabWidth/useTabs', () => {
    const result = layerFor(JSX_SOURCE);
    assert.deepEqual(result.layer?.values, {
      tabSize: 2,
      insertSpaces: false,
      'prettier.semi': false
    });
    assert.deepEqual(
      result.warnings.filter((w) => /js-beautify/.test(w.message)),
      [],
      'Prettier printed it: nothing may blame js-beautify'
    );
  });

  it('a plain .js file (printed by js-beautify) keeps the indentation keys out, truthfully', () => {
    const result = layerFor(PLAIN_SOURCE);
    assert.deepEqual(result.layer?.values, { 'prettier.semi': false });
    assert.equal(result.warnings.length, 2);
    for (const warning of result.warnings) {
      assert.match(warning.message, /printed by js-beautify, not by Prettier/);
    }
  });

  it('the resolved tabSize really changes with the engine, through the pure resolver', () => {
    const live: ConfigLayer = {
      source: 'FormattingOptions (live, per call)',
      values: { tabSize: 4, insertSpaces: true }
    };
    const jsx = layerFor(JSX_SOURCE);
    const jsxResolved = resolveOptions({
      languageId: 'javascript',
      layers: [live, jsx.layer as ConfigLayer]
    });
    assert.equal(jsxResolved.tabSize, 2);
    assert.equal(jsxResolved.insertSpaces, false);
    assert.equal(jsxResolved.sources.tabSize, SOURCE_PRETTIERRC);

    const plain = layerFor(PLAIN_SOURCE);
    const plainResolved = resolveOptions({
      languageId: 'javascript',
      layers: [live, plain.layer as ConfigLayer]
    });
    assert.equal(plainResolved.tabSize, 4, 'js-beautify keeps the editor value');
    assert.equal(plainResolved.insertSpaces, true);
  });

  it('the default (no engine passed) stays the conservative js-beautify answer', () => {
    const result = readPrettierrcLayer(join(ws, 'src', 'a.js'), 'javascript', ws);
    assert.deepEqual(result.layer?.values, { 'prettier.semi': false });
  });
});

describe('config/prettierrc : readPrettierrcLayer (end to end on disk)', () => {
  let ws: string;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), 'tidy-prettierrc-ws-'));
    mkdirSync(join(ws, 'src'), { recursive: true });
  });
  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  const file = (): string => join(ws, 'src', 'a.ts');

  it('builds a layer from .prettierrc.json for typescript (values + source label)', () => {
    writeFileSync(
      join(ws, '.prettierrc.json'),
      '{"singleQuote": true, "tabWidth": 2, "semi": false}'
    );
    const result = readPrettierrcLayer(file(), 'typescript', ws);
    assert.ok(result.path?.endsWith('.prettierrc.json'));
    assert.equal(result.layer?.source, SOURCE_PRETTIERRC);
    assert.deepEqual(result.layer?.values, {
      'prettier.singleQuote': true,
      tabSize: 2,
      'prettier.semi': false
    });
  });

  it('yields nothing for a non-Prettier language even when a config exists', () => {
    writeFileSync(join(ws, '.prettierrc.json'), '{"semi": false}');
    const result = readPrettierrcLayer(file(), 'css' as LangId, ws);
    assert.equal(result.layer, undefined);
    assert.equal(result.path, undefined);
    assert.equal(result.warnings.length, 0);
  });

  it('MOAT: a code-based config is never executed; layer skipped with a warning', () => {
    writeFileSync(join(ws, '.prettierrc.js'), 'module.exports = { semi: false };');
    const result = readPrettierrcLayer(file(), 'typescript', ws);
    assert.equal(result.layer, undefined);
    assert.ok(result.path?.endsWith('.prettierrc.js'));
    assert.ok(result.warnings.some((w) => /never executed/.test(w.message)));
  });

  it('MOAT: every code-based variant is recognised and skipped, never required', () => {
    const codeNames = [
      '.prettierrc.js',
      'prettier.config.js',
      '.prettierrc.mjs',
      'prettier.config.mjs',
      '.prettierrc.cjs',
      'prettier.config.cjs',
      '.prettierrc.ts',
      'prettier.config.ts',
      '.prettierrc.mts',
      'prettier.config.mts',
      '.prettierrc.cts',
      'prettier.config.cts'
    ];
    for (const name of codeNames) {
      const target = join(ws, name);
      // A payload that would be catastrophic if it were ever executed.
      writeFileSync(target, 'process.exit(7);');
      const result = readPrettierrcLayer(file(), 'typescript', ws);
      assert.equal(result.layer, undefined, name);
      assert.equal(result.path, target, name);
      assert.ok(
        result.warnings.some((w) => /never executed/.test(w.message)),
        name
      );
      rmSync(target);
    }
  });

  it('package.json "prettier" object builds the layer', () => {
    writeFileSync(
      join(ws, 'package.json'),
      '{"name": "x", "prettier": {"semi": false}}'
    );
    const result = readPrettierrcLayer(file(), 'typescript', ws);
    assert.deepEqual(result.layer?.values, { 'prettier.semi': false });
  });

  it('package.json "prettier" string (shareable config) is skipped with a warning', () => {
    writeFileSync(
      join(ws, 'package.json'),
      '{"name": "x", "prettier": "@acme/prettier-config"}'
    );
    const result = readPrettierrcLayer(file(), 'typescript', ws);
    assert.equal(result.layer, undefined);
    assert.ok(result.warnings.some((w) => /never resolved/.test(w.message)));
  });

  it('an oversized config yields no layer plus a "too large" warning', () => {
    writeFileSync(
      join(ws, '.prettierrc.json'),
      'a'.repeat(MAX_PRETTIERRC_BYTES + 1)
    );
    const result = readPrettierrcLayer(file(), 'typescript', ws);
    assert.equal(result.layer, undefined);
    assert.ok(result.warnings.some((w) => /too large/.test(w.message)));
  });

  it('a malformed config yields no layer plus a warning, never a throw', () => {
    writeFileSync(join(ws, '.prettierrc.json'), '{ "semi": ');
    const result = readPrettierrcLayer(file(), 'typescript', ws);
    assert.equal(result.layer, undefined);
    assert.ok(result.warnings.some((w) => /malformed/.test(w.message)));
  });

  it('YAML and TOML variants map to the same values', () => {
    writeFileSync(join(ws, '.prettierrc.yaml'), 'singleQuote: true\n');
    const yaml = readPrettierrcLayer(file(), 'typescript', ws);
    assert.deepEqual(yaml.layer?.values, { 'prettier.singleQuote': true });
    rmSync(join(ws, '.prettierrc.yaml'));
    writeFileSync(join(ws, '.prettierrc.toml'), 'singleQuote = true\n');
    const toml = readPrettierrcLayer(file(), 'typescript', ws);
    assert.deepEqual(toml.layer?.values, { 'prettier.singleQuote': true });
  });

  it('ADVERSARIAL: a __proto__ config file smuggles nothing', () => {
    writeFileSync(join(ws, '.prettierrc.json'), '{"__proto__": {"semi": false}}');
    const result = readPrettierrcLayer(file(), 'typescript', ws);
    assert.equal(result.layer, undefined);
    assert.equal(({} as { semi?: unknown }).semi, undefined);
  });

  it('ADVERSARIAL: a YAML alias bomb is bounded and never blocks formatting', () => {
    const bomb = [
      'a: &a ["x","x","x","x","x","x","x","x","x"]',
      'b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]',
      'c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]',
      'semi: *c',
      ''
    ].join('\n');
    writeFileSync(join(ws, '.prettierrc.yaml'), bomb);
    const result = readPrettierrcLayer(file(), 'typescript', ws);
    assert.equal(result.layer, undefined);
    // The rejected value is echoed truncated, never in full.
    const semiWarning = result.warnings.find((w) => /"semi"/.test(w.message));
    assert.ok(semiWarning, 'the invalid semi value must be reported');
    assert.ok(semiWarning.message.length < 300);
  });

  it('a config with only unknown keys yields path + warnings but no layer', () => {
    writeFileSync(join(ws, '.prettierrc.json'), '{"proseWrap": "always"}');
    const result = readPrettierrcLayer(file(), 'typescript', ws);
    assert.ok(result.path);
    assert.equal(result.layer, undefined);
    assert.ok(result.warnings.length > 0);
  });

  it('an empty config yields the path, no layer and no warning', () => {
    writeFileSync(join(ws, '.prettierrc.json'), '{}');
    const result = readPrettierrcLayer(file(), 'typescript', ws);
    assert.ok(result.path);
    assert.equal(result.layer, undefined);
    assert.equal(result.warnings.length, 0);
  });

  it('no config anywhere in the workspace yields no path, no layer, no warning', () => {
    const result = readPrettierrcLayer(file(), 'typescript', ws);
    assert.equal(result.path, undefined);
    assert.equal(result.layer, undefined);
    assert.equal(result.warnings.length, 0);
  });
});

describe('config/prettierrc : precedence through the pure resolver', () => {
  let ws: string;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), 'tidy-prettierrc-prec-'));
    mkdirSync(join(ws, 'src'), { recursive: true });
  });
  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  it('.prettierrc beats VS Code settings and .editorconfig; .soukformatrc beats .prettierrc', () => {
    writeFileSync(
      join(ws, '.prettierrc.json'),
      '{"tabWidth": 2, "singleQuote": true, "printWidth": 90}'
    );
    const rc = readPrettierrcLayer(join(ws, 'src', 'a.ts'), 'typescript', ws);
    assert.ok(rc.layer, 'the rc layer must exist');

    const lower: ConfigLayer[] = [
      {
        source: 'VS Code settings (tidy.*)',
        values: { 'prettier.singleQuote': false, 'prettier.printWidth': 120 }
      },
      // The .editorconfig layer may also emit prettier.printWidth.
      {
        source: '.editorconfig',
        values: { indent_size: 8, 'prettier.printWidth': 100 }
      }
    ];

    const resolved = resolveOptions({
      languageId: 'typescript',
      layers: [...lower, rc.layer]
    });
    assert.equal(resolved.tabSize, 2);
    assert.equal(resolved.sources.tabSize, SOURCE_PRETTIERRC);
    const bag = resolved.engineOptions.prettier as Record<string, unknown>;
    assert.equal(bag.singleQuote, true);
    assert.equal(bag.printWidth, 90);
    assert.equal(resolved.sources['prettier.singleQuote'], SOURCE_PRETTIERRC);
    assert.equal(resolved.sources['prettier.printWidth'], SOURCE_PRETTIERRC);

    const withSouk = resolveOptions({
      languageId: 'typescript',
      layers: [
        ...lower,
        rc.layer,
        {
          source: '.soukformatrc[typescript]',
          values: { 'prettier.singleQuote': false }
        }
      ]
    });
    const soukBag = withSouk.engineOptions.prettier as Record<string, unknown>;
    assert.equal(
      soukBag.singleQuote,
      false,
      '.soukformatrc must keep the last word'
    );
    assert.equal(
      withSouk.sources['prettier.singleQuote'],
      '.soukformatrc[typescript]'
    );
  });

  it('useTabs from .prettierrc overrides the live FormattingOptions', () => {
    writeFileSync(join(ws, '.prettierrc'), 'useTabs: true\n');
    const rc = readPrettierrcLayer(join(ws, 'src', 'a.ts'), 'typescript', ws);
    assert.ok(rc.layer);
    const resolved = resolveOptions({
      languageId: 'typescript',
      layers: [
        {
          source: 'FormattingOptions (live, per call)',
          values: { tabSize: 4, insertSpaces: true }
        },
        rc.layer
      ]
    });
    assert.equal(resolved.insertSpaces, false);
    assert.equal(resolved.sources.insertSpaces, SOURCE_PRETTIERRC);
  });
});
