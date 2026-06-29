// Unit tests for the config resolver (SPEC CFG-01/CFG-02/CFG-03).
// resolveOptions must: honour tabSize/insertSpaces, deep-merge layers
// general->specific (later wins, absent key never erases lower layer), map
// EditorConfig aliases (with inverted indent_style), and expose `sources` so the
// "Show effective configuration" command can explain each value's origin.
import assert from 'node:assert/strict';
import { resolveOptions } from '../../../src/config/resolver';
import { configFixtures } from '../../fixtures/configFixtures';

describe('config/resolver — resolveOptions corpus', () => {
  for (const f of configFixtures) {
    it(`${f.id}: ${f.desc} [${f.ref}]`, () => {
      const result = resolveOptions({ languageId: f.languageId, layers: f.layers });

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
        assert.equal(result.insertFinalNewline, f.expect.insertFinalNewline, 'insertFinalNewline');
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
    });
  }
});

describe('config/resolver — sources map invariants', () => {
  it('every resolved typed key has a source entry', () => {
    const r = resolveOptions({
      languageId: 'css',
      layers: [
        { source: 'vscode', values: { tabSize: 2, insertSpaces: true } },
        { source: '.editorconfig', values: { end_of_line: 'lf', insert_final_newline: true } }
      ]
    });
    assert.ok(r.sources.tabSize, 'tabSize sourced');
    assert.ok(r.sources.insertSpaces, 'insertSpaces sourced');
    assert.ok(r.sources.endOfLine, 'endOfLine sourced');
    assert.ok(r.sources.insertFinalNewline, 'insertFinalNewline sourced');
  });

  it('every engineOption key has a matching source entry', () => {
    const r = resolveOptions({
      languageId: 'javascript',
      layers: [{ source: 'vscode', values: { brace_style: 'expand', wrap_line_length: 120 } }]
    });
    for (const key of Object.keys(r.engineOptions)) {
      assert.ok(r.sources[key], `engineOption ${key} must have a source`);
    }
  });

  it('does not leak typed keys into engineOptions', () => {
    const r = resolveOptions({
      languageId: 'css',
      layers: [{ source: 'vscode', values: { tabSize: 2, insertSpaces: true, indent_size: 3 } }]
    });
    assert.equal(r.engineOptions.tabSize, undefined);
    assert.equal(r.engineOptions.insertSpaces, undefined);
    assert.equal(r.engineOptions.indent_size, undefined, 'indent_size is an alias of tabSize');
    // indent_size aliases tabSize and, being last, wins.
    assert.equal(r.tabSize, 3);
  });
});
