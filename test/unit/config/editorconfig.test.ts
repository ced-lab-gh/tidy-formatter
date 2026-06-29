// Unit tests for the pure .editorconfig layer (SPEC CFG-03, #31,#34,#62,#88).
//
// Two tiers, both PURE (no 'vscode'):
//   1. mapEditorConfigLayer: synthetic resolved EditorConfig props -> canonical
//      ResolvedOptions (via the resolver) with correct `sources` attribution.
//   2. readEditorConfigLayer: on-disk cascade resolution against real temporary
//      .editorconfig files (root=true honoured, nearer file overrides farther).
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mapEditorConfigLayer,
  readEditorConfigLayer,
  SOURCE_EDITORCONFIG
} from '../../../src/config/editorconfig';
import { resolveOptions } from '../../../src/config/resolver';
import { editorConfigFixtures } from '../../fixtures/editorconfigFixtures';

/**
 * Resolve a mapped .editorconfig layer alone (over builtin defaults) so we can
 * assert the mapping in canonical ResolvedOptions terms, including sources.
 */
function resolveFromProps(props: Parameters<typeof mapEditorConfigLayer>[0]) {
  const layer = mapEditorConfigLayer(props);
  const layers = layer ? [layer] : [];
  return resolveOptions({ languageId: 'css', layers });
}

describe('config/editorconfig — mapEditorConfigLayer corpus', () => {
  for (const f of editorConfigFixtures) {
    it(`${f.id}: ${f.desc} [${f.ref}]`, () => {
      const result = resolveFromProps(f.props);

      if (f.expect.tabSize !== undefined) {
        assert.equal(result.tabSize, f.expect.tabSize, 'tabSize');
      }
      if (f.expect.insertSpaces !== undefined) {
        assert.equal(result.insertSpaces, f.expect.insertSpaces, 'insertSpaces');
      }
      if (f.expect.endOfLine !== undefined) {
        assert.equal(result.endOfLine, f.expect.endOfLine, 'endOfLine');
      }
      if (f.expect.insertFinalNewline !== undefined) {
        assert.equal(
          result.insertFinalNewline,
          f.expect.insertFinalNewline,
          'insertFinalNewline'
        );
      }
      if (f.expect.trimTrailingWhitespace !== undefined) {
        assert.equal(
          result.trimTrailingWhitespace,
          f.expect.trimTrailingWhitespace,
          'trimTrailingWhitespace'
        );
      }
      if (f.expect.engineOptions) {
        for (const [k, v] of Object.entries(f.expect.engineOptions)) {
          assert.deepEqual(result.engineOptions[k], v, `engineOptions.${k}`);
        }
      }
      if (f.expect.sources) {
        for (const [k, v] of Object.entries(f.expect.sources)) {
          assert.equal(result.sources[k], v, `sources.${k}`);
        }
      }
      if (f.expect.absentEngineOptions) {
        for (const k of f.expect.absentEngineOptions) {
          assert.equal(
            result.engineOptions[k],
            undefined,
            `engineOptions.${k} must be absent`
          );
        }
      }
    });
  }
});

describe('config/editorconfig — mapEditorConfigLayer shape', () => {
  it('returns undefined for empty props (no empty layer is contributed)', () => {
    assert.equal(mapEditorConfigLayer({}), undefined);
  });

  it('returns undefined when every value is the EditorConfig "unset" sentinel', () => {
    const layer = mapEditorConfigLayer({
      indent_style: 'unset',
      indent_size: 'unset',
      end_of_line: 'unset',
      insert_final_newline: 'unset',
      trim_trailing_whitespace: 'unset',
      charset: 'unset'
    });
    assert.equal(layer, undefined);
  });

  it('tags the produced layer with the .editorconfig source label', () => {
    const layer = mapEditorConfigLayer({ indent_size: 2 });
    assert.ok(layer, 'a layer is produced');
    assert.equal(layer.source, SOURCE_EDITORCONFIG);
  });

  it('a positive integer max_line_length is forwarded; tab_width is not leaked as an engine option', () => {
    const layer = mapEditorConfigLayer({
      indent_size: 2,
      tab_width: 8,
      max_line_length: 120
    } as unknown as Parameters<typeof mapEditorConfigLayer>[0]);
    assert.ok(layer);
    assert.equal(layer.values.wrap_line_length, 120);
    assert.equal(layer.values.tab_width, undefined, 'tab_width consumed, not leaked');
  });
});

describe('config/editorconfig — precedence (layer 3 over VS Code)', () => {
  it('.editorconfig wins over the VS Code+FormattingOptions layer (team config governs)', () => {
    const vscodeLayer = {
      source: 'VS Code settings (tidy.*)',
      values: { tabSize: 4, insertSpaces: true }
    };
    const ecLayer = mapEditorConfigLayer({ indent_style: 'tab', indent_size: 2 });
    assert.ok(ecLayer);
    const result = resolveOptions({
      languageId: 'css',
      // general -> specific: VS Code layer first, .editorconfig after.
      layers: [vscodeLayer, ecLayer]
    });
    assert.equal(result.tabSize, 2, 'editorconfig indent_size wins');
    assert.equal(result.insertSpaces, false, 'editorconfig indent_style=tab wins');
    assert.equal(result.sources.tabSize, SOURCE_EDITORCONFIG);
    assert.equal(result.sources.insertSpaces, SOURCE_EDITORCONFIG);
  });

  it('a key absent from .editorconfig does not erase the VS Code layer value', () => {
    const vscodeLayer = {
      source: 'VS Code settings (tidy.*)',
      values: { tabSize: 4, insertSpaces: false }
    };
    // .editorconfig sets only end_of_line; tabSize/insertSpaces stay from VS Code.
    const ecLayer = mapEditorConfigLayer({ end_of_line: 'lf' });
    assert.ok(ecLayer);
    const result = resolveOptions({
      languageId: 'css',
      layers: [vscodeLayer, ecLayer]
    });
    assert.equal(result.tabSize, 4, 'VS Code tabSize preserved');
    assert.equal(result.insertSpaces, false, 'VS Code insertSpaces preserved');
    assert.equal(result.endOfLine, 'lf');
    assert.equal(result.sources.tabSize, 'VS Code settings (tidy.*)');
    assert.equal(result.sources.endOfLine, SOURCE_EDITORCONFIG);
  });
});

describe('config/editorconfig — readEditorConfigLayer on-disk cascade', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tidy-ec-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reads a single .editorconfig and maps its keys', () => {
    writeFileSync(
      join(root, '.editorconfig'),
      ['root = true', '', '[*]', 'indent_style = space', 'indent_size = 2'].join('\n')
    );
    const layer = readEditorConfigLayer(join(root, 'a.css'));
    assert.ok(layer, 'a layer is produced');
    assert.equal(layer.source, SOURCE_EDITORCONFIG);
    const result = resolveOptions({ languageId: 'css', layers: [layer] });
    assert.equal(result.tabSize, 2);
    assert.equal(result.insertSpaces, true);
    assert.equal(result.sources.tabSize, SOURCE_EDITORCONFIG);
  });

  it('honours per-glob sections ([*.css] overrides [*])', () => {
    writeFileSync(
      join(root, '.editorconfig'),
      [
        'root = true',
        '',
        '[*]',
        'indent_style = space',
        'indent_size = 2',
        '',
        '[*.css]',
        'indent_style = tab',
        'indent_size = 4',
        'max_line_length = 100'
      ].join('\n')
    );
    const css = resolveOptions({
      languageId: 'css',
      layers: [readEditorConfigLayer(join(root, 'styles.css'))!]
    });
    assert.equal(css.insertSpaces, false, 'css uses tabs');
    assert.equal(css.tabSize, 4, 'css indent_size=4');
    assert.equal(css.engineOptions.wrap_line_length, 100);

    const js = resolveOptions({
      languageId: 'javascript',
      layers: [readEditorConfigLayer(join(root, 'app.js'))!]
    });
    assert.equal(js.insertSpaces, true, 'js uses the [*] spaces');
    assert.equal(js.tabSize, 2, 'js indent_size=2');
  });

  it('cascades root->file and respects root=true (a nearer file overrides the farther one)', () => {
    // Farther (cascade root) sets indent_size=2; nearer sub dir overrides to 8.
    writeFileSync(
      join(root, '.editorconfig'),
      ['root = true', '', '[*]', 'indent_style = space', 'indent_size = 2'].join('\n')
    );
    const sub = join(root, 'sub');
    mkdirSync(sub);
    writeFileSync(
      join(sub, '.editorconfig'),
      ['[*]', 'indent_size = 8'].join('\n')
    );
    const layer = readEditorConfigLayer(join(sub, 'deep.css'));
    assert.ok(layer);
    const result = resolveOptions({ languageId: 'css', layers: [layer] });
    assert.equal(result.tabSize, 8, 'nearer .editorconfig wins in the cascade');
    assert.equal(result.insertSpaces, true, 'inherited indent_style=space from root');
  });

  it('returns undefined when no .editorconfig exists anywhere up the tree', () => {
    const layer = readEditorConfigLayer(join(root, 'orphan.css'));
    assert.equal(layer, undefined);
  });

  it('returns undefined for an empty/blank path without throwing', () => {
    assert.equal(readEditorConfigLayer(''), undefined);
    assert.equal(readEditorConfigLayer('   '), undefined);
  });

  it('does not throw on a malformed .editorconfig (fail-soft)', () => {
    writeFileSync(
      join(root, '.editorconfig'),
      'this is not = a valid [ ini ][[ file'
    );
    // Must not throw; either yields a (possibly empty) result or undefined.
    assert.doesNotThrow(() => readEditorConfigLayer(join(root, 'x.css')));
  });
});
