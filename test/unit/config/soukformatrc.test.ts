// Unit tests for the pure .soukformatrc reader (Axe 3.T5/T6/T7).
//
// Two tiers, both PURE (no 'vscode'):
//   1. parseSoukformatrc: raw JSONC text -> ordered ConfigLayers + warnings
//      (language section as layer 4, matching glob overrides as layer 5),
//      validating each option against the catalogue; fail-soft on malformed input.
//   2. readSoukformatrcLayers / findSoukformatrc: on-disk discovery up the tree
//      against real temporary files, with glob overrides keyed off the file path.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseSoukformatrc,
  readSoukformatrcLayers,
  findSoukformatrc,
  SOUKFORMATRC_FILENAME
} from '../../../src/config/soukformatrc';
import { resolveOptions } from '../../../src/config/resolver';

describe('config/soukformatrc — parseSoukformatrc (pure text)', () => {
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

describe('config/soukformatrc — glob overrides (layer 5)', () => {
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

describe('config/soukformatrc — on-disk discovery (fail-soft)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'souk-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('finds the nearest .soukformatrc walking up the tree', () => {
    writeFileSync(join(root, SOUKFORMATRC_FILENAME), '{ "css": { "indent": 6 } }');
    const deep = join(root, 'a', 'b');
    mkdirSync(deep, { recursive: true });
    const file = join(deep, 'style.css');
    writeFileSync(file, '.x{}');

    const found = findSoukformatrc(file);
    assert.equal(found, join(root, SOUKFORMATRC_FILENAME));

    const result = readSoukformatrcLayers(file, 'css');
    assert.equal(result.path, join(root, SOUKFORMATRC_FILENAME));
    assert.equal(result.layers[0].values.indent_size, 6);
  });

  it('returns no layer (and no throw) when no file exists', () => {
    const file = join(root, 'orphan.css');
    writeFileSync(file, '.x{}');
    const result = readSoukformatrcLayers(file, 'css');
    assert.equal(result.path, undefined);
    assert.equal(result.layers.length, 0);
    assert.equal(result.warnings.length, 0);
  });

  it('an empty / whitespace fsPath yields no layer', () => {
    assert.equal(readSoukformatrcLayers('', 'css').layers.length, 0);
    assert.equal(readSoukformatrcLayers('   ', 'css').layers.length, 0);
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

    const result = readSoukformatrcLayers(file, 'css');
    const r = resolveOptions({ languageId: 'css', layers: result.layers });
    assert.equal(r.tabSize, 8);
  });
});
