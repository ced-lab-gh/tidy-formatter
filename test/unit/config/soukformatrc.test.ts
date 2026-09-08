// Unit tests for the pure .soukformatrc reader (Axe 3.T5/T6/T7).
//
// Two tiers, both PURE (no 'vscode'):
//   1. parseSoukformatrc: raw JSONC text -> ordered ConfigLayers + warnings
//      (language section as layer 4, matching glob overrides as layer 5),
//      validating each option against the catalogue; fail-soft on malformed input.
//   2. readSoukformatrcLayers / findSoukformatrc: on-disk discovery up the tree
//      against real temporary files, with glob overrides keyed off the file path.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import {
  parseSoukformatrc,
  readSoukformatrcLayers,
  findSoukformatrc,
  SOUKFORMATRC_FILENAME
} from '../../../src/config/soukformatrc';
import { resolveOptions } from '../../../src/config/resolver';

describe('config/soukformatrc : parseSoukformatrc (pure text)', () => {
  it('maps a language section to a layer 4 ConfigLayer for that language', () => {
    const { layers, warnings } = parseSoukformatrc(
      '{ "css": { "indent": 4 } }',
      'css',
      '/p/.soukformatrc'
    );
    assert.equal(warnings.length, 0);
    assert.equal(layers.length, 1);
    assert.equal(layers[0].values.indent_size, 4);
    assert.match(layers[0].source, /\[css\]/);
  });

  it('only the matching language section governs (css:4 does not touch others)', () => {
    const text = '{ "css": { "indent": 4 }, "javascript": { "indent": 2 } }';
    const css = parseSoukformatrc(text, 'css', '/p/.soukformatrc');
    const js = parseSoukformatrc(text, 'javascript', '/p/.soukformatrc');
    assert.equal(css.layers[0].values.indent_size, 4);
    assert.equal(js.layers[0].values.indent_size, 2);
    // The html section is absent, so no layer is produced for it.
    const html = parseSoukformatrc(text, 'html', '/p/.soukformatrc');
    assert.equal(html.layers.length, 0);
  });

  it('supports JSONC comments and trailing commas', () => {
    const text = `{
      // project CSS indentation
      "css": { "indent": 8, },
    }`;
    const { layers, warnings } = parseSoukformatrc(text, 'css', '/p/.soukformatrc');
    assert.equal(warnings.length, 0);
    assert.equal(layers[0].values.indent_size, 8);
  });

  it('nests prettier options as flat prettier.<key> for the resolver', () => {
    const { layers } = parseSoukformatrc(
      '{ "typescript": { "singleQuote": true, "semi": false } }',
      'typescript',
      '/p/.soukformatrc'
    );
    assert.equal(layers[0].values['prettier.singleQuote'], true);
    assert.equal(layers[0].values['prettier.semi'], false);
  });

  it('warns and ignores an unknown option, never throwing', () => {
    const { layers, warnings } = parseSoukformatrc(
      '{ "css": { "indent": 4, "made_up_option": 9 } }',
      'css',
      '/p/.soukformatrc'
    );
    assert.equal(layers[0].values.indent_size, 4);
    assert.equal(layers[0].values.made_up_option, undefined);
    assert.ok(warnings.some((w) => /made_up_option/.test(w.message)));
  });

  it('warns and ignores an option that does not apply to the language', () => {
    const { layers, warnings } = parseSoukformatrc(
      '{ "css": { "singleQuote": true } }',
      'css',
      '/p/.soukformatrc'
    );
    assert.equal(layers.length, 0, 'no usable option => no layer');
    assert.ok(warnings.some((w) => /singleQuote/.test(w.message)));
  });

  it('warns and ignores an invalid value (bad enum)', () => {
    const { layers, warnings } = parseSoukformatrc(
      '{ "javascript": { "brace_style": "banana" } }',
      'javascript',
      '/p/.soukformatrc'
    );
    assert.equal(layers.length, 0);
    assert.ok(warnings.some((w) => /brace_style/.test(w.message)));
  });

  it('malformed JSONC yields a warning and no layer (fail-soft, no throw)', () => {
    const { layers, warnings } = parseSoukformatrc(
      '{ "css": { "indent": }',
      'css',
      '/p/.soukformatrc'
    );
    assert.equal(layers.length, 0);
    assert.ok(warnings.some((w) => /malformed/.test(w.message)));
  });

  it('non-object root yields a warning and no layer', () => {
    const { layers, warnings } = parseSoukformatrc('[1,2,3]', 'css', '/p/.soukformatrc');
    assert.equal(layers.length, 0);
    assert.ok(warnings.some((w) => /must be a JSON object/.test(w.message)));
  });
});

describe('config/soukformatrc : glob overrides (layer 5)', () => {
  it('a matching override is appended AFTER the language section (wins)', () => {
    const text = `{
      "css": { "indent": 4 },
      "overrides": [ { "files": "src/**/*.css", "options": { "indent": 8 } } ]
    }`;
    const { layers } = parseSoukformatrc(text, 'css', '/p/.soukformatrc', 'src/a/b.css');
    assert.equal(layers.length, 2);
    assert.equal(layers[0].values.indent_size, 4, 'section first');
    assert.equal(layers[1].values.indent_size, 8, 'override last (wins on merge)');
    // Deep-merging through the resolver yields the override value.
    const r = resolveOptions({ languageId: 'css', layers });
    assert.equal(r.tabSize, 8);
    assert.match(r.sources.tabSize, /overrides\[0\]/);
  });

  it('a non-matching override is skipped (only the section applies)', () => {
    const text = `{
      "css": { "indent": 4 },
      "overrides": [ { "files": "src/**/*.css", "options": { "indent": 8 } } ]
    }`;
    const { layers } = parseSoukformatrc(text, 'css', '/p/.soukformatrc', 'lib/x.css');
    assert.equal(layers.length, 1);
    const r = resolveOptions({ languageId: 'css', layers });
    assert.equal(r.tabSize, 4);
  });

  it('the §6 matrix: editorconfig=2 + soukformatrc{css:4} + override src=8', () => {
    const text = `{
      "css": { "indent": 4 },
      "overrides": [ { "files": "src/**/*.css", "options": { "indent": 8 } } ]
    }`;
    const baseEditorconfig = { source: '.editorconfig', values: { indent_size: 2 } };

    // .css under src => 8
    const underSrc = parseSoukformatrc(text, 'css', '/p/.soukformatrc', 'src/components/a.css');
    const rUnder = resolveOptions({
      languageId: 'css',
      layers: [baseEditorconfig, ...underSrc.layers]
    });
    assert.equal(rUnder.tabSize, 8, '.css under src => 8');

    // .css outside src => 4 (section)
    const outside = parseSoukformatrc(text, 'css', '/p/.soukformatrc', 'public/b.css');
    const rOutside = resolveOptions({
      languageId: 'css',
      layers: [baseEditorconfig, ...outside.layers]
    });
    assert.equal(rOutside.tabSize, 4, '.css outside src => 4');

    // other language (js) => only editorconfig 2
    const js = parseSoukformatrc(text, 'javascript', '/p/.soukformatrc', 'src/x.js');
    const rJs = resolveOptions({
      languageId: 'javascript',
      layers: [baseEditorconfig, ...js.layers]
    });
    assert.equal(rJs.tabSize, 2, 'other language => editorconfig 2');
  });

  it('a non-array overrides field warns and is ignored', () => {
    const { warnings } = parseSoukformatrc(
      '{ "css": { "indent": 4 }, "overrides": {} }',
      'css',
      '/p/.soukformatrc',
      'a.css'
    );
    assert.ok(warnings.some((w) => /"overrides" must be an array/.test(w.message)));
  });

  it('a malformed override entry warns and is skipped', () => {
    const text = `{ "overrides": [ { "files": "", "options": { "indent": 8 } } ] }`;
    const { layers, warnings } = parseSoukformatrc(text, 'css', '/p/.soukformatrc', 'a.css');
    assert.equal(layers.length, 0);
    assert.ok(warnings.some((w) => /files must be a non-empty glob/.test(w.message)));
  });
});

// The upward walk is BOUNDED to the workspace folder. An unbounded walk reads a
// .soukformatrc the user never opened (a parent checkout, a shared drive root,
// the home directory) and lets it silently change how their code is formatted:
// the same defect the .prettierrc layer was built not to reproduce. These tests
// pin the bound and, above all, the ESCAPE cases, because a bound that fails
// open is worse than none: it looks correct until the day it matters.
describe('config/soukformatrc : on-disk discovery is bounded to the workspace', () => {
  let tmp: string;
  let ws: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'souk-'));
    ws = join(tmp, 'ws');
    mkdirSync(ws, { recursive: true });
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  /** Create a file (and its parents) and return its path. */
  function write(path: string, content: string): string {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    return path;
  }

  const CONFIG = '{ "css": { "indent": 6 } }';
  const OUTSIDE_CONFIG = '{ "css": { "indent": 3 } }';

  it('finds the nearest .soukformatrc walking up, inside the workspace', () => {
    write(join(ws, SOUKFORMATRC_FILENAME), CONFIG);
    const file = write(join(ws, 'a', 'b', 'style.css'), '.x{}');

    assert.equal(
      findSoukformatrc(file, ws),
      join(ws, SOUKFORMATRC_FILENAME)
    );

    const result = readSoukformatrcLayers(file, 'css', ws);
    assert.equal(result.path, join(ws, SOUKFORMATRC_FILENAME));
    assert.equal(result.layers[0].values.indent_size, 6);
  });

  it('the workspace root itself IS searched (the bound is inclusive)', () => {
    write(join(ws, SOUKFORMATRC_FILENAME), CONFIG);
    const file = write(join(ws, 'style.css'), '.x{}');
    assert.equal(findSoukformatrc(file, ws), join(ws, SOUKFORMATRC_FILENAME));
  });

  it('the nearest config wins over one higher in the SAME workspace', () => {
    write(join(ws, SOUKFORMATRC_FILENAME), CONFIG);
    write(join(ws, 'src', SOUKFORMATRC_FILENAME), '{ "css": { "indent": 8 } }');
    const file = write(join(ws, 'src', 'a.css'), '.x{}');

    const result = readSoukformatrcLayers(file, 'css', ws);
    assert.equal(result.path, join(ws, 'src', SOUKFORMATRC_FILENAME));
    assert.equal(result.layers[0].values.indent_size, 8);
  });

  // THE defect: a .soukformatrc one level ABOVE the opened folder used to be
  // found and applied, all the way up to the filesystem root.
  it('a .soukformatrc ABOVE the workspace folder is never read', () => {
    write(join(tmp, SOUKFORMATRC_FILENAME), OUTSIDE_CONFIG);
    const file = write(join(ws, 'a', 'style.css'), '.x{}');

    assert.equal(findSoukformatrc(file, ws), undefined);

    const result = readSoukformatrcLayers(file, 'css', ws);
    assert.equal(result.path, undefined);
    assert.deepEqual(result.layers, []);
    assert.deepEqual(result.warnings, []);
  });

  it('a config INSIDE the workspace still wins while one above is ignored', () => {
    write(join(tmp, SOUKFORMATRC_FILENAME), OUTSIDE_CONFIG);
    write(join(ws, SOUKFORMATRC_FILENAME), CONFIG);
    const file = write(join(ws, 'a', 'style.css'), '.x{}');

    const result = readSoukformatrcLayers(file, 'css', ws);
    assert.equal(result.path, join(ws, SOUKFORMATRC_FILENAME));
    assert.equal(result.layers[0].values.indent_size, 6);
  });

  it('a document OUTSIDE the workspace reads nothing at all', () => {
    write(join(tmp, SOUKFORMATRC_FILENAME), OUTSIDE_CONFIG);
    const file = write(join(tmp, 'elsewhere', 'style.css'), '.x{}');
    assert.equal(findSoukformatrc(file, ws), undefined);
    assert.deepEqual(readSoukformatrcLayers(file, 'css', ws).layers, []);
  });

  // Containment, not string equality: every one of these used to be a way for a
  // string-equality bound to MISS the workspace root and keep walking.
  it('a trailing separator on the workspace path still bounds the walk', () => {
    write(join(tmp, SOUKFORMATRC_FILENAME), OUTSIDE_CONFIG);
    write(join(ws, SOUKFORMATRC_FILENAME), CONFIG);
    const file = write(join(ws, 'a', 'style.css'), '.x{}');

    assert.equal(
      findSoukformatrc(file, `${ws}${sep}`),
      join(ws, SOUKFORMATRC_FILENAME)
    );
    // And it does not let the walk escape either.
    const above = write(join(tmp, 'outside', 'style.css'), '.x{}');
    assert.equal(findSoukformatrc(above, `${ws}${sep}`), undefined);
  });

  it('a "." / ".." dressed-up workspace path still bounds the walk', () => {
    write(join(tmp, SOUKFORMATRC_FILENAME), OUTSIDE_CONFIG);
    write(join(ws, SOUKFORMATRC_FILENAME), CONFIG);
    const file = write(join(ws, 'a', 'style.css'), '.x{}');
    const dressed = join(ws, 'a', '..', '.', '');

    assert.equal(findSoukformatrc(file, dressed), join(ws, SOUKFORMATRC_FILENAME));
    const above = write(join(tmp, 'style.css'), '.x{}');
    assert.equal(findSoukformatrc(above, dressed), undefined);
  });

  it('a sibling folder whose name merely STARTS with the workspace name is outside', () => {
    // 'ws-extra' string-prefixes 'ws': a prefix test would wrongly call it inside.
    const sibling = join(tmp, 'ws-extra');
    write(join(sibling, SOUKFORMATRC_FILENAME), OUTSIDE_CONFIG);
    const file = write(join(sibling, 'style.css'), '.x{}');
    assert.equal(findSoukformatrc(file, ws), undefined);
  });

  it('on win32 a case-mismatched workspace path is still the same workspace', function () {
    if (process.platform !== 'win32') {
      this.skip();
      return;
    }
    write(join(ws, SOUKFORMATRC_FILENAME), CONFIG);
    const file = write(join(ws, 'a', 'style.css'), '.x{}');
    assert.equal(
      findSoukformatrc(file, ws.toUpperCase()),
      join(ws, SOUKFORMATRC_FILENAME)
    );
  });

  it('on win32 a workspace path with FORWARD slashes still bounds the walk', function () {
    // The module claims a mixed separator cannot let the walk escape. A host
    // that hands back 'C:/proj' rather than 'C:\\proj' is exactly the
    // normalisation mismatch a string-equality bound fails open on.
    if (process.platform !== 'win32') {
      this.skip();
      return;
    }
    write(join(tmp, SOUKFORMATRC_FILENAME), OUTSIDE_CONFIG);
    write(join(ws, SOUKFORMATRC_FILENAME), CONFIG);
    const file = write(join(ws, 'a', 'style.css'), '.x{}');
    const posixStyle = ws.split(sep).join('/');

    assert.equal(
      findSoukformatrc(file, posixStyle),
      join(ws, SOUKFORMATRC_FILENAME)
    );
    // And a document above it is still outside.
    const above = write(join(tmp, 'style.css'), '.x{}');
    assert.equal(findSoukformatrc(above, posixStyle), undefined);
  });

  it('an absent or blank workspace bound searches NOTHING (fail-closed)', () => {
    write(join(ws, SOUKFORMATRC_FILENAME), CONFIG);
    const file = write(join(ws, 'style.css'), '.x{}');
    assert.equal(findSoukformatrc(file, ''), undefined);
    assert.equal(findSoukformatrc(file, '   '), undefined);
    assert.deepEqual(readSoukformatrcLayers(file, 'css', '').layers, []);
    assert.deepEqual(
      readSoukformatrcLayers(file, 'css', undefined as unknown as string).layers,
      []
    );
  });
});

describe('config/soukformatrc : on-disk discovery (fail-soft)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'souk-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns no layer (and no throw) when no file exists', () => {
    const file = join(root, 'orphan.css');
    writeFileSync(file, '.x{}');
    const result = readSoukformatrcLayers(file, 'css', root);
    assert.equal(result.path, undefined);
    assert.equal(result.layers.length, 0);
    assert.equal(result.warnings.length, 0);
  });

  it('an empty / whitespace fsPath yields no layer', () => {
    assert.equal(readSoukformatrcLayers('', 'css', root).layers.length, 0);
    assert.equal(readSoukformatrcLayers('   ', 'css', root).layers.length, 0);
  });

  it('a directory named .soukformatrc is not a config file', () => {
    mkdirSync(join(root, SOUKFORMATRC_FILENAME), { recursive: true });
    const file = join(root, 'style.css');
    writeFileSync(file, '.x{}');
    assert.equal(findSoukformatrc(file, root), undefined);
  });

  it('resolves glob overrides relative to the config file directory', () => {
    writeFileSync(
      join(root, SOUKFORMATRC_FILENAME),
      `{ "css": { "indent": 4 }, "overrides": [ { "files": "src/**/*.css", "options": { "indent": 8 } } ] }`
    );
    const src = join(root, 'src');
    mkdirSync(src, { recursive: true });
    const file = join(src, 'a.css');
    writeFileSync(file, '.x{}');

    const result = readSoukformatrcLayers(file, 'css', root);
    const r = resolveOptions({ languageId: 'css', layers: result.layers });
    assert.equal(r.tabSize, 8);
  });
});

// The bound is only real if the HOST passes it. src/config/vscodeConfig.ts is
// the single caller and it imports 'vscode', so mocha cannot load it: the walk
// could be handed dirname(file), or '', or nothing at all, and every test above
// would still pass while the shipped extension read configs from outside the
// workspace again. These checks read that source from disk (same idiom as
// lazyBoundary.test.ts) so the wiring cannot be dropped silently.
describe('config/soukformatrc : the host really passes the workspace bound', () => {
  const source = readFileSync(
    join(__dirname, '../../../src/config/vscodeConfig.ts'),
    'utf8'
  );

  it('passes the containing workspace folder as the stop directory', () => {
    assert.match(
      source,
      /readSoukformatrcLayers\(\s*document\.uri\.fsPath,[^)]*folder\.uri\.fsPath\s*\)/,
      'the walk bound must be the workspace folder, never a directory derived ' +
        'from the document itself'
    );
    assert.match(source, /getWorkspaceFolder\(document\.uri\)/);
  });

  it('reads NOTHING, and says so, for a document outside every folder', () => {
    // Fail-closed plus honesty: silence here would leave "no config found"
    // indistinguishable from "config deliberately not read".
    assert.match(
      source,
      /if\s*\(!folder[^)]*\)\s*\{\s*return\s*\{\s*layers:\s*\[\],\s*warnings:\s*\[\s*SOUKFORMATRC_NO_WORKSPACE_WARNING/,
      'a document with no workspace folder must get no layer and one warning'
    );
    assert.match(source, /const SOUKFORMATRC_NO_WORKSPACE_WARNING\s*=/);
    assert.match(source, /bounded to the/);
  });

  it('keeps the Workspace Trust gate on the layer', () => {
    // A .soukformatrc is workspace-authored content: Restricted Mode must not
    // honour it, bounded walk or not. Read the gate's OWN body: a match
    // anywhere in the file would be satisfied by another layer's trust check.
    const start = source.indexOf('function shouldReadSoukformatrc');
    assert.ok(start > 0, 'the .soukformatrc gate must exist');
    const end = source.indexOf('\n}', start);
    const body = source.slice(start, end);

    assert.match(
      body,
      /vscode\.workspace\.isTrusted === false/,
      'shouldReadSoukformatrc must still refuse an untrusted workspace'
    );
    assert.match(
      body,
      /document\.uri\.scheme !== 'file'/,
      'and still require a real on-disk document'
    );
  });
});
