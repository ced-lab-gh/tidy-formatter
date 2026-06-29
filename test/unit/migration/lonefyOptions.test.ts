// Unit tests for the pure lonefy -> Tidy option mapper (ROADMAP Axe 1, 1.T1).
//
// PURE (no 'vscode'). Verifies:
//   - the ROADMAP acceptance corpus (migrationFixtures): recognised keys map to
//     real tidy.* settings, unknown keys land in `unmapped`, out-of-domain values
//     become `warnings` and are NEVER written;
//   - non-object input yields {settings:{}, unmapped:[]} + a warning, never throws;
//   - immutability: the input object is not mutated;
//   - the JSONC text entry point (mapLonefyRcText) tolerates comments/commas and
//     fails soft on malformed input.
import assert from 'node:assert/strict';
import {
  mapLonefyOptions,
  mapLonefyRcText
} from '../../../src/migration/lonefyOptions';
import {
  migrationFixtures,
  nonObjectInputs
} from '../../fixtures/migrationFixtures';

describe('migration/lonefyOptions — mapLonefyOptions corpus', () => {
  for (const f of migrationFixtures) {
    it(`${f.id}: ${f.desc} [${f.ref}]`, () => {
      const result = mapLonefyOptions(f.raw);

      assert.deepEqual(result.settings, f.expect.settings, 'settings');
      assert.deepEqual(
        [...result.unmapped].sort(),
        [...f.expect.unmapped].sort(),
        'unmapped'
      );
      assert.equal(
        result.warnings.length,
        f.expect.warningCount,
        `warning count (got: ${JSON.stringify(result.warnings)})`
      );
      for (const needle of f.expect.warningIncludes ?? []) {
        assert.ok(
          result.warnings.some((w) => w.includes(needle)),
          `a warning should mention "${needle}" (got: ${JSON.stringify(result.warnings)})`
        );
      }
    });
  }
});

describe('migration/lonefyOptions — non-object input is fail-soft', () => {
  for (const { id, raw } of nonObjectInputs) {
    it(`${id}: yields an empty mapping + one warning, never throws`, () => {
      let result;
      assert.doesNotThrow(() => {
        result = mapLonefyOptions(raw);
      });
      assert.deepEqual(result!.settings, {});
      assert.deepEqual(result!.unmapped, []);
      assert.equal(result!.warnings.length, 1, 'exactly one warning');
    });
  }
});

describe('migration/lonefyOptions — only real tidy.* keys are ever produced', () => {
  const ALLOWED = new Set([
    'tidy.indent',
    'tidy.brace_style',
    'tidy.wrap_line_length',
    'tidy.wrap_attributes',
    'tidy.space_after_anon_function'
  ]);

  it('every produced settings key is a known tidy.* id across the whole corpus', () => {
    for (const f of migrationFixtures) {
      const result = mapLonefyOptions(f.raw);
      for (const key of Object.keys(result.settings)) {
        assert.ok(ALLOWED.has(key), `unexpected produced key "${key}" in ${f.id}`);
      }
    }
  });
});

describe('migration/lonefyOptions — immutability & isolation', () => {
  it('does not mutate the input object', () => {
    const raw = { indent_size: 2, brace_style: 'expand', foo: 1 };
    const snapshot = JSON.parse(JSON.stringify(raw));
    mapLonefyOptions(raw);
    assert.deepEqual(raw, snapshot, 'input untouched');
  });

  it('returns a fresh settings object distinct from any input value', () => {
    const raw = { indent_size: 2 };
    const a = mapLonefyOptions(raw);
    const b = mapLonefyOptions(raw);
    assert.notEqual(a.settings, b.settings, 'distinct objects per call');
    a.settings['tidy.indent'] = 999;
    assert.equal(b.settings['tidy.indent'], 2, 'mutating one result never affects another');
  });
});

describe('migration/lonefyOptions — out-of-domain values are reported, not written', () => {
  it('a recognised key with a bad value never reaches settings', () => {
    const result = mapLonefyOptions({
      indent_size: -1,
      brace_style: 'nope',
      wrap_line_length: 'wide',
      wrap_attributes: 12,
      space_after_anon_function: 'maybe'
    });
    assert.deepEqual(result.settings, {}, 'nothing written');
    assert.equal(result.unmapped.length, 0, 'all keys are recognised, just invalid');
    assert.equal(result.warnings.length, 5, 'one warning per invalid recognised key');
  });
});

describe('migration/lonefyOptions — mapLonefyRcText (JSONC entry point)', () => {
  it('parses plain JSON and maps it', () => {
    const result = mapLonefyRcText('{ "indent_size": 2, "brace_style": "expand" }');
    assert.deepEqual(result.settings, {
      'tidy.indent': 2,
      'tidy.brace_style': 'expand'
    });
    assert.equal(result.warnings.length, 0);
  });

  it('tolerates comments and trailing commas (JSONC)', () => {
    const text = [
      '{',
      '  // legacy lonefy config',
      '  "indent_size": 4,',
      '  "wrap_attributes": "force", /* inline */',
      '}'
    ].join('\n');
    const result = mapLonefyRcText(text);
    assert.deepEqual(result.settings, {
      'tidy.indent': 4,
      'tidy.wrap_attributes': 'force'
    });
    assert.equal(result.warnings.length, 0);
  });

  it('fails soft on malformed text: empty mapping + one warning, no throw', () => {
    let result;
    assert.doesNotThrow(() => {
      result = mapLonefyRcText('{ this is not json ]');
    });
    assert.deepEqual(result!.settings, {});
    assert.deepEqual(result!.unmapped, []);
    assert.equal(result!.warnings.length, 1);
    assert.ok(result!.warnings[0].includes('.jsbeautifyrc'));
  });

  it('fails soft when a parsed JSONC value is not an object (e.g. a bare array)', () => {
    const result = mapLonefyRcText('[1, 2, 3]');
    assert.deepEqual(result.settings, {});
    assert.deepEqual(result.unmapped, []);
    assert.equal(result.warnings.length, 1);
  });

  it('fails soft when given a non-string input', () => {
    let result;
    assert.doesNotThrow(() => {
      result = mapLonefyRcText(42 as unknown);
    });
    assert.deepEqual(result!.settings, {});
    assert.equal(result!.warnings.length, 1);
  });
});
