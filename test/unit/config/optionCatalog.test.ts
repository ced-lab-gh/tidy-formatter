// Unit tests for the pure option catalogue (Axe 3.T1) — the SINGLE SOURCE OF
// TRUTH for every configurable Tidy formatting option.
//
// Covers: structural invariants (unique keys, tidy.* prefix, valid scope/type,
// enum default consistency), validateValue type/enum coercion, language
// applicability, and the anti-drift cross-check that every catalogue js-beautify/
// core engineKey is actually consumed by the engine adapter (no dead option).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  OPTION_CATALOG,
  appliesToLanguage,
  findBySettingKey,
  validateValue,
  type OptionEntry
} from '../../../src/config/optionCatalog';

const SCOPES = new Set(['window', 'resource', 'language-overridable']);
const TYPES = new Set(['boolean', 'integer', 'string']);

describe('config/optionCatalog — structural invariants', () => {
  it('is non-empty and curated (>= 25 entries)', () => {
    assert.ok(OPTION_CATALOG.length >= 25, `expected a full set, got ${OPTION_CATALOG.length}`);
  });

  it('every settingKey is unique and starts with "tidy."', () => {
    const seen = new Set<string>();
    for (const entry of OPTION_CATALOG) {
      assert.ok(entry.settingKey.startsWith('tidy.'), `bad prefix: ${entry.settingKey}`);
      assert.ok(!seen.has(entry.settingKey), `duplicate settingKey: ${entry.settingKey}`);
      seen.add(entry.settingKey);
    }
  });

  it('every entry has a valid type and scope', () => {
    for (const entry of OPTION_CATALOG) {
      assert.ok(TYPES.has(entry.type), `bad type for ${entry.settingKey}`);
      assert.ok(SCOPES.has(entry.scope), `bad scope for ${entry.settingKey}`);
    }
  });

  it('does NOT redeclare indentation (tabSize/insertSpaces come from FormattingOptions)', () => {
    for (const entry of OPTION_CATALOG) {
      assert.notEqual(entry.engineKey, 'tabSize', `${entry.settingKey} must not own tabSize`);
      assert.notEqual(entry.engineKey, 'insertSpaces', `${entry.settingKey} must not own insertSpaces`);
      assert.notEqual(entry.settingKey, 'tidy.tabSize');
    }
  });

  it('an enum default is always one of the enum values', () => {
    for (const entry of OPTION_CATALOG) {
      if (entry.enum) {
        assert.equal(entry.type, 'string', `${entry.settingKey} enum must be string-typed`);
        assert.ok(
          entry.enum.includes(entry.default as string),
          `${entry.settingKey} default ${String(entry.default)} not in enum`
        );
      }
    }
  });

  it('a boolean entry has a boolean default; an integer entry a number default', () => {
    for (const entry of OPTION_CATALOG) {
      if (entry.type === 'boolean') {
        assert.equal(typeof entry.default, 'boolean', entry.settingKey);
      }
      if (entry.type === 'integer') {
        assert.equal(typeof entry.default, 'number', entry.settingKey);
        assert.ok(Number.isInteger(entry.default as number), entry.settingKey);
      }
    }
  });

  it('every language-overridable entry has a non-empty description', () => {
    for (const entry of OPTION_CATALOG) {
      assert.ok(entry.description && entry.description.length > 0, entry.settingKey);
    }
  });

  it('exposes both js-beautify AND prettier families', () => {
    assert.ok(OPTION_CATALOG.some((e) => e.engine === 'jsbeautify'), 'has js-beautify options');
    assert.ok(OPTION_CATALOG.some((e) => e.engine === 'prettier'), 'has prettier options');
    assert.ok(OPTION_CATALOG.some((e) => e.engine === 'core'), 'has core options');
  });

  it('covers the 5 originally-shipped settings', () => {
    for (const key of [
      'tidy.indent',
      'tidy.brace_style',
      'tidy.wrap_line_length',
      'tidy.wrap_attributes',
      'tidy.space_after_anon_function'
    ]) {
      assert.ok(findBySettingKey(key), `missing originally-shipped ${key}`);
    }
  });

  it('covers the 8 curated AST-invariant prettier stylistic options', () => {
    for (const key of [
      'tidy.prettier.printWidth',
      'tidy.prettier.semi',
      'tidy.prettier.singleQuote',
      'tidy.prettier.jsxSingleQuote',
      'tidy.prettier.trailingComma',
      'tidy.prettier.bracketSpacing',
      'tidy.prettier.bracketSameLine',
      'tidy.prettier.arrowParens'
    ]) {
      const entry = findBySettingKey(key);
      assert.ok(entry, `missing prettier option ${key}`);
      assert.equal(entry!.engine, 'prettier');
    }
  });

  it('does NOT expose quoteProps (not AST-invariant under the guard)', () => {
    assert.equal(findBySettingKey('tidy.prettier.quoteProps'), undefined);
  });
});

describe('config/optionCatalog — validateValue (never propagate invalid)', () => {
  const boolEntry = findBySettingKey('tidy.prettier.semi') as OptionEntry;
  const intEntry = findBySettingKey('tidy.indent') as OptionEntry;
  const enumEntry = findBySettingKey('tidy.brace_style') as OptionEntry;

  it('accepts a valid boolean and rejects non-booleans', () => {
    assert.equal(validateValue(boolEntry, true), true);
    assert.equal(validateValue(boolEntry, false), false);
    assert.equal(validateValue(boolEntry, 'true'), undefined);
    assert.equal(validateValue(boolEntry, 1), undefined);
  });

  it('accepts an integer and rejects floats/NaN/strings', () => {
    assert.equal(validateValue(intEntry, 2), 2);
    assert.equal(validateValue(intEntry, 2.5), undefined);
    assert.equal(validateValue(intEntry, Number.NaN), undefined);
    assert.equal(validateValue(intEntry, '4'), undefined);
  });

  it('accepts an in-enum string and rejects out-of-enum / wrong type', () => {
    assert.equal(validateValue(enumEntry, 'expand'), 'expand');
    assert.equal(validateValue(enumEntry, 'banana'), undefined);
    assert.equal(validateValue(enumEntry, 42), undefined);
  });

  it('treats null/undefined as "not set"', () => {
    assert.equal(validateValue(boolEntry, undefined), undefined);
    assert.equal(validateValue(boolEntry, null), undefined);
  });
});

describe('config/optionCatalog — language applicability', () => {
  it('an "all" option applies to every supported language', () => {
    const indent = findBySettingKey('tidy.indent') as OptionEntry;
    assert.ok(appliesToLanguage(indent, 'css'));
    assert.ok(appliesToLanguage(indent, 'typescript'));
    assert.ok(appliesToLanguage(indent, 'html'));
  });

  it('an HTML-only option does not apply to CSS or TS', () => {
    const wrapAttrs = findBySettingKey('tidy.wrap_attributes') as OptionEntry;
    assert.ok(appliesToLanguage(wrapAttrs, 'html'));
    assert.ok(!appliesToLanguage(wrapAttrs, 'css'));
    assert.ok(!appliesToLanguage(wrapAttrs, 'typescript'));
  });

  it('a prettier option does not apply to CSS/HTML/JSON', () => {
    const semi = findBySettingKey('tidy.prettier.semi') as OptionEntry;
    assert.ok(appliesToLanguage(semi, 'typescript'));
    assert.ok(appliesToLanguage(semi, 'typescriptreact'));
    assert.ok(!appliesToLanguage(semi, 'css'));
    assert.ok(!appliesToLanguage(semi, 'json'));
  });
});

describe('config/optionCatalog — anti-drift: no dead catalogue option', () => {
  it('every js-beautify/core engineKey is consumed by the engine adapter', () => {
    const adapterSrc = readFileSync(
      join(__dirname, '..', '..', '..', 'src', 'engine', 'jsbeautify.ts'),
      'utf8'
    );
    for (const entry of OPTION_CATALOG) {
      if (entry.engine === 'prettier') {
        continue;
      }
      // Some engineKeys are routed through the resolver's typed fields by alias
      // rather than read by name in jsbeautify.ts:
      //  - `end_of_line` aliases the canonical endOfLine field (post-processing);
      //  - `indent_size` aliases tabSize (mapped from FormattingOptions/indent).
      // Both are applied without a literal engineOptions lookup, so skip them.
      if (entry.engineKey === 'end_of_line' || entry.engineKey === 'indent_size') {
        continue;
      }
      assert.ok(
        adapterSrc.includes(`'${entry.engineKey}'`),
        `catalogue engineKey "${entry.engineKey}" (${entry.settingKey}) is never read by jsbeautify.ts`
      );
    }
  });

  it('every prettier engineKey is consumed by the prettier adapter', () => {
    const adapterSrc = readFileSync(
      join(__dirname, '..', '..', '..', 'src', 'engine', 'prettier.ts'),
      'utf8'
    );
    // The prettier adapter consumes options through whitelists keyed by the
    // engineKey (PRETTIER_BOOLEAN_KEYS string literals, PRETTIER_STRING_ENUMS
    // object keys, and a direct bag.printWidth read). Match the bare identifier
    // boundary so both `'semi'` and `trailingComma:` and `bag.printWidth` count.
    for (const entry of OPTION_CATALOG) {
      if (entry.engine !== 'prettier') {
        continue;
      }
      const re = new RegExp(`\\b${entry.engineKey}\\b`);
      assert.ok(
        re.test(adapterSrc),
        `prettier engineKey "${entry.engineKey}" (${entry.settingKey}) is never read by prettier.ts`
      );
    }
  });
});
