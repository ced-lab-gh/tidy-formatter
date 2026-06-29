// Unit tests for the resolver's Prettier nesting + precedence (Axe 3.T4/T7).
// Flat `prettier.<key>` engineOptions keys from every layer are deep-merged by
// key and then lifted into a single engineOptions.prettier object, with per-key
// source attribution preserved under `prettier.<key>` in `sources`.
import assert from 'node:assert/strict';
import { resolveOptions } from '../../../src/config/resolver';

describe('config/resolver — prettier nesting', () => {
  it('lifts flat prettier.* keys into a nested engineOptions.prettier object', () => {
    const r = resolveOptions({
      languageId: 'typescript',
      layers: [
        {
          source: 'vscode',
          values: { 'prettier.singleQuote': true, 'prettier.semi': false }
        }
      ]
    });
    assert.deepEqual(r.engineOptions.prettier, { singleQuote: true, semi: false });
    // No flat keys leak into engineOptions.
    assert.equal(r.engineOptions['prettier.singleQuote'], undefined);
    assert.equal(r.engineOptions['prettier.semi'], undefined);
  });

  it('attributes each prettier option source under prettier.<key>', () => {
    const r = resolveOptions({
      languageId: 'typescript',
      layers: [{ source: 'my-source', values: { 'prettier.singleQuote': true } }]
    });
    assert.equal(r.sources['prettier.singleQuote'], 'my-source');
  });

  it('deep-merges prettier options across layers (later wins, no erase)', () => {
    const r = resolveOptions({
      languageId: 'typescript',
      layers: [
        { source: 'global', values: { 'prettier.singleQuote': false, 'prettier.semi': true } },
        { source: '.soukformatrc[typescript]', values: { 'prettier.singleQuote': true } }
      ]
    });
    // singleQuote overridden by the later layer, semi preserved from the earlier.
    assert.deepEqual(r.engineOptions.prettier, { singleQuote: true, semi: true });
    assert.equal(r.sources['prettier.singleQuote'], '.soukformatrc[typescript]');
    assert.equal(r.sources['prettier.semi'], 'global');
  });

  it('produces no prettier bag when no prettier option is set', () => {
    const r = resolveOptions({
      languageId: 'typescript',
      layers: [{ source: 'vscode', values: { tabSize: 2 } }]
    });
    assert.equal(r.engineOptions.prettier, undefined);
  });
});

describe('config/resolver — per-language vs project precedence (5 layers)', () => {
  it('global brace_style=collapse + [lang] expand => expand', () => {
    const r = resolveOptions({
      languageId: 'javascript',
      layers: [
        { source: 'VS Code settings (tidy.*)', values: { brace_style: 'collapse' } },
        { source: 'VS Code settings (tidy.* [javascript])', values: { brace_style: 'expand' } }
      ]
    });
    assert.equal(r.engineOptions.brace_style, 'expand');
    assert.match(r.sources.brace_style, /\[javascript\]/);
  });

  it('full chain: builtin < vscode < editorconfig < soukformatrc < override', () => {
    const r = resolveOptions({
      languageId: 'css',
      layers: [
        { source: 'VS Code settings (tidy.*)', values: { indent_size: 2 } },
        { source: '.editorconfig', values: { indent_size: 3 } },
        { source: '.soukformatrc[css]', values: { indent_size: 4 } },
        { source: '.soukformatrc overrides[0] (src/**)', values: { indent_size: 8 } }
      ]
    });
    assert.equal(r.tabSize, 8, 'most specific layer wins');
    assert.match(r.sources.tabSize, /overrides\[0\]/);
  });
});
