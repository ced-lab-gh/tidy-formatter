// Unit tests for the ONE print width (defect C-15): the two width keys,
// `wrap_line_length` (shared, also where .editorconfig max_line_length lands) and
// `prettier.printWidth`, are collapsed into a single value by LAYER ORDER before
// any engine sees the options. A value set in a higher documented layer must win
// over a lower one, whichever key spelled it.
//
// The layers below use the real source labels and the real order of
// vscodeConfig.ts buildLayers (VS Code settings, FormattingOptions,
// .editorconfig, .prettierrc, .soukformatrc), so the assertions read like the
// precedence chain the README documents.
import assert from 'node:assert/strict';
import { resolveOptions, type ConfigLayer } from '../../../src/config/resolver';
import type { LangId } from '../../../src/types';

const VSCODE = 'VS Code settings (tidy.*)';
const VSCODE_LANG = 'VS Code settings (tidy.* [typescript])';
const EDITORCONFIG = '.editorconfig';
const PRETTIERRC = '.prettierrc';
const SOUK = '.soukformatrc[typescript]';
const SOUK_OVERRIDE = '.soukformatrc overrides[0] (src/**)';

function width(
  layers: ConfigLayer[],
  languageId: LangId = 'typescript'
): { value: unknown; source: string | undefined } {
  const r = resolveOptions({ languageId, layers });
  const bag = r.engineOptions.prettier as Record<string, unknown> | undefined;
  return { value: bag?.printWidth, source: r.sources['prettier.printWidth'] };
}

describe('config/resolver : one print width, chosen by layer order (C-15)', () => {
  it('a higher-layer wrap_line_length beats a lower-layer prettier.printWidth', () => {
    const w = width([
      { source: VSCODE, values: { 'prettier.printWidth': 40 } },
      { source: EDITORCONFIG, values: { wrap_line_length: 120 } }
    ]);
    assert.equal(w.value, 120, '.editorconfig max_line_length is above VS Code settings');
    assert.equal(w.source, EDITORCONFIG);
  });

  it('a higher-layer prettier.printWidth beats a lower-layer wrap_line_length', () => {
    const w = width([
      { source: EDITORCONFIG, values: { wrap_line_length: 120 } },
      { source: SOUK, values: { 'prettier.printWidth': 40 } }
    ]);
    assert.equal(w.value, 40);
    assert.equal(w.source, SOUK);
  });

  it('.soukformatrc wrap_line_length has the last word over a VS Code printWidth', () => {
    const w = width([
      { source: VSCODE, values: { 'prettier.printWidth': 40 } },
      { source: SOUK, values: { wrap_line_length: 120 } }
    ]);
    assert.equal(w.value, 120);
    assert.equal(w.source, SOUK);
  });

  it('a glob override beats the .soukformatrc language section, in either vocabulary', () => {
    assert.equal(
      width([
        { source: SOUK, values: { 'prettier.printWidth': 40 } },
        { source: SOUK_OVERRIDE, values: { wrap_line_length: 100 } }
      ]).value,
      100
    );
    assert.equal(
      width([
        { source: SOUK, values: { wrap_line_length: 100 } },
        { source: SOUK_OVERRIDE, values: { 'prettier.printWidth': 60 } }
      ]).value,
      60
    );
  });

  it('a .prettierrc printWidth beats a VS Code wrap_line_length, and loses to .soukformatrc', () => {
    const rcOverVscode = width([
      { source: VSCODE, values: { wrap_line_length: 100 } },
      { source: PRETTIERRC, values: { 'prettier.printWidth': 90 } }
    ]);
    assert.equal(rcOverVscode.value, 90);
    assert.equal(rcOverVscode.source, PRETTIERRC);

    const soukOverRc = width([
      { source: PRETTIERRC, values: { 'prettier.printWidth': 90 } },
      { source: SOUK, values: { wrap_line_length: 120 } }
    ]);
    assert.equal(soukOverRc.value, 120);
    assert.equal(soukOverRc.source, SOUK);
  });

  it('the [lang] layer beats the global layer across the two keys', () => {
    assert.equal(
      width([
        { source: VSCODE, values: { 'prettier.printWidth': 40 } },
        { source: VSCODE_LANG, values: { wrap_line_length: 120 } }
      ]).value,
      120
    );
    assert.equal(
      width([
        { source: VSCODE, values: { wrap_line_length: 120 } },
        { source: VSCODE_LANG, values: { 'prettier.printWidth': 40 } }
      ]).value,
      40
    );
  });

  it('inside ONE layer the Prettier-specific key is the more specific statement and wins', () => {
    const w = width([
      { source: VSCODE, values: { wrap_line_length: 120, 'prettier.printWidth': 40 } }
    ]);
    assert.equal(w.value, 40);
    assert.equal(w.source, VSCODE);
  });

  it('the same key in a higher layer still wins (the former workaround keeps working)', () => {
    assert.equal(
      width([
        { source: VSCODE, values: { 'prettier.printWidth': 40 } },
        { source: SOUK, values: { 'prettier.printWidth': 120 } }
      ]).value,
      120
    );
    assert.equal(
      width([
        { source: VSCODE, values: { wrap_line_length: 40 } },
        { source: EDITORCONFIG, values: { wrap_line_length: 120 } }
      ]).value,
      120
    );
  });

  it('the shared key is left in the bag untouched, for the js-beautify engines', () => {
    const r = resolveOptions({
      languageId: 'javascript',
      layers: [
        { source: VSCODE, values: { 'prettier.printWidth': 40 } },
        { source: EDITORCONFIG, values: { wrap_line_length: 120 } }
      ]
    });
    assert.equal(r.engineOptions.wrap_line_length, 120);
    assert.equal(r.sources.wrap_line_length, EDITORCONFIG);
  });

  it('an unusable value takes no part: it neither wins nor blocks a lower valid one', () => {
    // A prettier.printWidth below 1 is not a width (package.json minimum is 1).
    const invalidHigh = width([
      { source: VSCODE, values: { wrap_line_length: 100 } },
      { source: SOUK, values: { 'prettier.printWidth': 0 } }
    ]);
    assert.equal(invalidHigh.value, 100, 'the lower valid width stands');
    assert.equal(invalidHigh.source, VSCODE);

    // A fractional or negative shared width is not a width either.
    const invalidShared = width([
      { source: VSCODE, values: { 'prettier.printWidth': 40 } },
      { source: EDITORCONFIG, values: { wrap_line_length: -5 } }
    ]);
    assert.equal(invalidShared.value, 40);
    assert.equal(invalidShared.source, VSCODE);
  });

  it('nothing is invented when no layer set a width', () => {
    const r = resolveOptions({
      languageId: 'typescript',
      layers: [{ source: VSCODE, values: { 'prettier.semi': false } }]
    });
    const bag = r.engineOptions.prettier as Record<string, unknown>;
    assert.equal('printWidth' in bag, false, 'an unset width stays unset');
    assert.equal(r.sources['prettier.printWidth'], undefined);
  });
});

describe('config/resolver : an explicit wrap_line_length of 0 means "do not wrap" (LOW-03)', () => {
  it('resolves to the unbounded width, attributed to the layer that said 0', () => {
    const w = width([{ source: VSCODE, values: { wrap_line_length: 0 } }]);
    assert.equal(w.value, Number.POSITIVE_INFINITY);
    assert.equal(w.source, VSCODE);
  });

  it('follows layer order like any other width', () => {
    assert.equal(
      width([
        { source: VSCODE, values: { 'prettier.printWidth': 40 } },
        { source: SOUK, values: { wrap_line_length: 0 } }
      ]).value,
      Number.POSITIVE_INFINITY,
      'a .soukformatrc that asks for no wrapping beats a VS Code width'
    );
    assert.equal(
      width([
        { source: VSCODE, values: { wrap_line_length: 0 } },
        { source: EDITORCONFIG, values: { wrap_line_length: 100 } }
      ]).value,
      100,
      'a positive width from a higher layer beats an earlier 0'
    );
  });

  it('a prettier.printWidth of 0 is NOT a request for no wrapping (it is invalid)', () => {
    const w = width([{ source: VSCODE, values: { 'prettier.printWidth': 0 } }]);
    assert.notEqual(w.value, Number.POSITIVE_INFINITY);
  });
});

describe('config/resolver : the width is only unified where Prettier prints', () => {
  for (const lang of ['css', 'scss', 'less', 'html', 'json', 'jsonc'] as const) {
    it(`${lang}: no prettier.printWidth is invented next to wrap_line_length`, () => {
      const r = resolveOptions({
        languageId: lang,
        layers: [{ source: EDITORCONFIG, values: { wrap_line_length: 120 } }]
      });
      assert.equal(r.engineOptions.prettier, undefined);
      assert.equal(r.sources['prettier.printWidth'], undefined);
      assert.equal(r.engineOptions.wrap_line_length, 120);
    });
  }

  for (const lang of [
    'typescript',
    'typescriptreact',
    'javascriptreact',
    'javascript'
  ] as const) {
    it(`${lang}: the unified width is produced`, () => {
      assert.equal(
        width([{ source: EDITORCONFIG, values: { wrap_line_length: 120 } }], lang).value,
        120
      );
    });
  }
});
