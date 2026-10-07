// Unit tests for the pure mapper of the incumbent's REAL config file
// (src/migration/lonefyConfig.ts, v0.5.0).
//
// PURE (no 'vscode'). The defect these lock: until v0.4.2 the mapper only knew
// FLAT keys, so `{"onSave":true,"javascript":{...},"css":{...}}` (the real shape)
// mapped to `settings: {}` and the migration imported nothing. Verified by
// execution against the v0.4.2 mapper before the fix.
//
// What is asserted:
//   - the REAL default shape maps to language-scoped writes, per section;
//   - sections reuse the flat key mapper (same validation, same domains);
//   - unknown keys are REPORTED (top level and per section), never dropped;
//   - `onSave` is recognised and NEVER mapped, whatever its value;
//   - top-level flat keys are mapped only for a `.jsbeautifyrc`;
//   - a malformed file is reported and yields no write at all;
//   - the text is parsed as DATA (no code path evaluates it);
//   - every key produced is a real, language-overridable `tidy.*` setting.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import {
  LONEFY_ON_SAVE_KEY,
  mapLonefyConfig,
  mapLonefyConfigText
} from '../../../src/migration/lonefyConfig';
import { LONEFY_KEYS, isMappedKey } from '../../../src/migration/lonefyKeys';
import { LONEFY_SECTIONS } from '../../../src/migration/lonefySections';
import {
  appliesToLanguage,
  findBySettingKey,
  type CatalogLang
} from '../../../src/config/optionCatalog';
import type { MigrationWrite } from '../../../src/migration/types';
import {
  LONEFY_CONTRIBUTOR_FORMATTER_JSON,
  LONEFY_DEFAULT_FORMATTER_JSON,
  LONEFY_DEFAULT_UNMAPPED,
  LONEFY_DEFAULT_WRITES
} from './lonefyFixtures';

const LOCAL = { label: '.vscode/formatter.json', allowFlatKeys: false } as const;
const RC = { label: '.jsbeautifyrc', allowFlatKeys: true } as const;

/** `[lang] key = value` lines, for readable assertions. */
function lines(writes: readonly MigrationWrite[]): string[] {
  return writes.map(
    (w) =>
      `${w.language === undefined ? '' : `[${w.language}] `}${w.key} = ${JSON.stringify(w.value)}`
  );
}

describe('migration/lonefyConfig : the REAL default formatter.json shape', () => {
  const result = mapLonefyConfigText(LONEFY_DEFAULT_FORMATTER_JSON, LOCAL);

  it('is no longer empty: every mappable key becomes a language-scoped write', () => {
    assert.deepEqual(lines(result.writes), [...LONEFY_DEFAULT_WRITES]);
    assert.equal(result.unusable, false);
    assert.deepEqual(result.warnings, []);
  });

  it('every write is language-scoped: nothing lands in the plain tidy.* settings', () => {
    assert.ok(result.writes.every((w) => w.language !== undefined));
  });

  it('reports EVERY key it does not carry over, prefixed by its section', () => {
    assert.deepEqual([...result.unmapped], [...LONEFY_DEFAULT_UNMAPPED]);
  });

  it('recognises onSave without mapping it', () => {
    assert.equal(result.onSaveSeen, true);
    assert.ok(
      !result.unmapped.includes(LONEFY_ON_SAVE_KEY),
      'onSave is recognised, so it is not listed as an unknown key'
    );
    assert.ok(
      result.writes.every((w) => !/onSave|formatOnSave/i.test(w.key)),
      'no write may ever carry onSave or editor.formatOnSave'
    );
  });
});

describe('migration/lonefyConfig : the contributor shape (indent 2, brace_style, "html": false)', () => {
  const result = mapLonefyConfigText(LONEFY_CONTRIBUTOR_FORMATTER_JSON, LOCAL);

  it('maps indent_size 2 and brace_style per language (brace_style is JavaScript only)', () => {
    assert.deepEqual(lines(result.writes), [
      '[javascript] tidy.indent = 2',
      '[javascript] tidy.brace_style = "collapse-preserve-inline"',
      '[json] tidy.indent = 2',
      '[css] tidy.indent = 2',
      '[scss] tidy.indent = 2'
    ]);
  });

  it('reports a non-object section instead of dropping it silently', () => {
    assert.equal(result.warnings.length, 1);
    assert.ok(result.warnings[0].startsWith('html:'), result.warnings[0]);
    assert.ok(result.warnings[0].includes('false'), result.warnings[0]);
    assert.equal(result.unusable, false, 'one bad section does not void the file');
  });
});

describe('migration/lonefyConfig : sections reuse the flat key mapper', () => {
  it('each section feeds ONLY the languages the incumbent applied it to', () => {
    const result = mapLonefyConfig(
      { css: { indent_size: 2 }, html: { indent_size: 3 }, javascript: { indent_size: 5 } },
      LOCAL
    );
    assert.deepEqual(lines(result.writes), [
      '[javascript] tidy.indent = 5',
      '[json] tidy.indent = 5',
      '[css] tidy.indent = 2',
      '[scss] tidy.indent = 2',
      '[html] tidy.indent = 3'
    ]);
  });

  it('applies the SAME domains as the flat mapper: an out-of-range value warns, never writes', () => {
    const result = mapLonefyConfig(
      { javascript: { indent_size: 999, brace_style: 'banana' } },
      LOCAL
    );
    assert.deepEqual(result.writes, []);
    assert.equal(result.warnings.length, 2);
    assert.ok(result.warnings[0].startsWith('javascript.indent_size:'));
    assert.ok(result.warnings[1].startsWith('javascript.brace_style:'));
  });

  it('coerces numeric strings like the flat mapper (js-beautify parses them with parseInt)', () => {
    const result = mapLonefyConfig({ javascript: { indent_size: '2' } }, LOCAL);
    assert.deepEqual(lines(result.writes), [
      '[javascript] tidy.indent = 2',
      '[json] tidy.indent = 2'
    ]);
  });

  it('does NOT read the strings "true" / "false" as booleans in the incumbent file', () => {
    // js-beautify treats any non-empty string as truthy, so "false" means TRUE there:
    // importing it as false would invert the behaviour the user actually had.
    const result = mapLonefyConfig(
      { javascript: { space_after_anon_function: 'false', comma_first: 'true' } },
      LOCAL
    );
    assert.deepEqual(result.writes, []);
    assert.equal(result.warnings.length, 2);
    assert.ok(result.warnings[0].startsWith('javascript.space_after_anon_function:'));
    assert.ok(result.warnings[0].includes('expected a boolean'));
  });

  it('but a .jsbeautifyrc keeps reading them (kept behaviour, several tools read that file)', () => {
    const result = mapLonefyConfig({ space_after_anon_function: 'false' }, RC);
    assert.deepEqual(lines(result.writes), ['tidy.space_after_anon_function = false']);
  });

  it('writes come out in a canonical section order, not file order', () => {
    const result = mapLonefyConfig(
      { html: { indent_size: 1 }, css: { indent_size: 2 }, javascript: { indent_size: 3 } },
      LOCAL
    );
    assert.deepEqual(
      result.writes.map((w) => w.language),
      ['javascript', 'json', 'css', 'scss', 'html']
    );
  });

  it('a section present but empty writes nothing and reports nothing', () => {
    const result = mapLonefyConfig({ css: {} }, LOCAL);
    assert.deepEqual(result.writes, []);
    assert.deepEqual(result.unmapped, []);
    assert.deepEqual(result.warnings, []);
  });

  for (const [name, value] of [
    ['null', null],
    ['an array', [1]],
    ['a number', 4],
    ['a string', 'x']
  ] as const) {
    it(`a section that is ${name} is reported and writes nothing`, () => {
      const result = mapLonefyConfig({ css: value }, LOCAL);
      assert.deepEqual(result.writes, []);
      assert.equal(result.warnings.length, 1);
      assert.ok(result.warnings[0].startsWith('css:'), result.warnings[0]);
    });
  }
});

describe('migration/lonefyConfig : unknown keys are reported, never dropped silently', () => {
  it('reports a top-level unknown key and a per-section unknown key', () => {
    const result = mapLonefyConfig(
      { mystery: 1, css: { indent_size: 2, sparkle: true } },
      LOCAL
    );
    assert.deepEqual([...result.unmapped], ['mystery', 'css.sparkle']);
    assert.deepEqual(lines(result.writes), ['[css] tidy.indent = 2', '[scss] tidy.indent = 2']);
  });

  it('an unknown SECTION name is an unknown top-level key', () => {
    const result = mapLonefyConfig({ typescript: { indent_size: 2 } }, LOCAL);
    assert.deepEqual([...result.unmapped], ['typescript']);
    assert.deepEqual(result.writes, []);
  });

  it('a hostile __proto__ key is reported as an ordinary key, not swallowed', () => {
    const result = mapLonefyConfigText('{"__proto__": {"indent_size": 9}}', RC);
    assert.deepEqual([...result.unmapped], ['__proto__']);
    assert.deepEqual(result.writes, []);
    assert.equal(
      ({} as Record<string, unknown>).indent_size,
      undefined,
      'the global Object prototype must stay untouched'
    );
  });
});

describe('migration/lonefyConfig : onSave is recognised and NEVER mapped', () => {
  for (const value of [true, false, 'yes', 1, null, { a: 1 }]) {
    it(`onSave: ${JSON.stringify(value)} maps to nothing and is flagged as seen`, () => {
      const result = mapLonefyConfig({ onSave: value }, LOCAL);
      assert.equal(result.onSaveSeen, true);
      assert.deepEqual(result.writes, []);
      assert.deepEqual(result.unmapped, []);
      assert.deepEqual(result.warnings, []);
    });
  }

  it('is reported even when it is the only key of a `.jsbeautifyrc`', () => {
    const result = mapLonefyConfig({ onSave: true }, RC);
    assert.equal(result.onSaveSeen, true);
    assert.deepEqual(result.writes, []);
  });

  it('an absent onSave is not flagged', () => {
    assert.equal(mapLonefyConfig({ css: { indent_size: 2 } }, LOCAL).onSaveSeen, false);
  });

  it('no output shape can carry a format-on-save write', () => {
    const result = mapLonefyConfigText(LONEFY_DEFAULT_FORMATTER_JSON, LOCAL);
    const serialised = JSON.stringify(result.writes);
    assert.ok(!/formatOnSave|onSave|editor\./.test(serialised), serialised);
  });
});

describe('migration/lonefyConfig : top-level flat keys depend on the file', () => {
  const flat = { indent_size: 2, brace_style: 'expand', foo: 1 };

  it('in a `.jsbeautifyrc` they map to plain tidy.* settings (kept behaviour)', () => {
    const result = mapLonefyConfig(flat, RC);
    assert.deepEqual(lines(result.writes), [
      'tidy.indent = 2',
      'tidy.brace_style = "expand"'
    ]);
    assert.deepEqual([...result.unmapped], ['foo']);
  });

  it('in a formatter.json they are ignored by the incumbent, so they are NOT imported', () => {
    const result = mapLonefyConfig(flat, LOCAL);
    assert.deepEqual(result.writes, []);
    assert.deepEqual([...result.unmapped], ['indent_size', 'brace_style', 'foo']);
  });

  it('a `.jsbeautifyrc` may also carry sections, mapped the same way', () => {
    const result = mapLonefyConfig({ indent_size: 4, css: { indent_size: 2 } }, RC);
    assert.deepEqual(lines(result.writes), [
      'tidy.indent = 4',
      '[css] tidy.indent = 2',
      '[scss] tidy.indent = 2'
    ]);
  });
});

describe('migration/lonefyConfig : a malformed file is reported and writes nothing', () => {
  it('unparseable text: unusable, no write, one warning naming the file', () => {
    const result = mapLonefyConfigText('{ "onSave": true, ', LOCAL);
    assert.equal(result.unusable, true);
    assert.deepEqual(result.writes, []);
    assert.equal(result.warnings.length, 1);
    assert.ok(result.warnings[0].includes('.vscode/formatter.json'), result.warnings[0]);
    assert.ok(result.warnings[0].includes('nothing was mapped'));
  });

  it('empty text is unusable too (there is no value to map)', () => {
    const result = mapLonefyConfigText('', LOCAL);
    assert.equal(result.unusable, true);
    assert.deepEqual(result.writes, []);
  });

  for (const [name, text] of [
    ['a bare array', '[1, 2]'],
    ['a number', '42'],
    ['null', 'null'],
    ['a string', '"x"']
  ] as const) {
    it(`${name} at the top level is unusable, not an empty success`, () => {
      const result = mapLonefyConfigText(text, LOCAL);
      assert.equal(result.unusable, true);
      assert.deepEqual(result.writes, []);
      assert.equal(result.warnings.length, 1);
    });
  }

  it('a non-string input never throws', () => {
    assert.doesNotThrow(() => mapLonefyConfigText(undefined, LOCAL));
    assert.equal(mapLonefyConfigText(undefined, LOCAL).unusable, true);
  });

  it('tolerates comments and trailing commas (JSONC), a superset of strict JSON', () => {
    const result = mapLonefyConfigText(
      '{ // local\n "css": { "indent_size": 2, }, /* end */ }',
      LOCAL
    );
    assert.equal(result.unusable, false);
    assert.deepEqual(lines(result.writes), ['[css] tidy.indent = 2', '[scss] tidy.indent = 2']);
  });
});

describe('migration/lonefyConfig : the text is data, never code', () => {
  it('a payload that a `require` would execute is inert here', () => {
    // The incumbent loads its file with `require`; a `.js`-flavoured payload would
    // run there. Here it is just a parse error, and nothing is evaluated.
    const probe = '__tidy_migration_probe__';
    (globalThis as Record<string, unknown>)[probe] = 0;
    const result = mapLonefyConfigText(
      `globalThis.${probe} = 1; module.exports = { css: { indent_size: 9 } }`,
      LOCAL
    );
    assert.equal((globalThis as Record<string, unknown>)[probe], 0, 'nothing ran');
    assert.equal(result.unusable, true);
    assert.deepEqual(result.writes, []);
    delete (globalThis as Record<string, unknown>)[probe];
  });

  it('the module source never require()s, evals, or builds a Function', () => {
    for (const file of ['lonefyConfig.ts', 'lonefyOptions.ts', 'lonefySources.ts']) {
      const source = readFileSync(
        path.resolve(__dirname, '../../../src/migration', file),
        'utf8'
      );
      const code = source
        .split(/\r?\n/)
        .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
        .join('\n');
      assert.ok(!/\beval\s*\(/.test(code), `${file}: no eval`);
      assert.ok(!/new\s+Function\b/.test(code), `${file}: no Function constructor`);
      assert.ok(!/\brequire\s*\(/.test(code), `${file}: no require()`);
      assert.ok(!/child_process|\bvm\b/.test(code), `${file}: no code-execution module`);
    }
  });
});

describe('migration/lonefyConfig : immutability', () => {
  it('does not mutate the input and returns fresh objects per call', () => {
    const raw = { onSave: true, css: { indent_size: 2, foo: 1 } };
    const snapshot = JSON.parse(JSON.stringify(raw));
    const a = mapLonefyConfig(raw, LOCAL);
    const b = mapLonefyConfig(raw, LOCAL);
    assert.deepEqual(raw, snapshot, 'input untouched');
    assert.notEqual(a.writes, b.writes);
    assert.notEqual(a.writes[0], b.writes[0]);
  });
});

describe('migration/lonefyConfig : only real, language-overridable tidy.* settings are ever produced', () => {
  const pkg = JSON.parse(
    readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8')
  ) as {
    contributes: {
      configuration: { properties?: Record<string, { scope?: string }> } | Array<{ properties?: Record<string, { scope?: string }> }>;
    };
  };
  const configuration = pkg.contributes.configuration;
  const properties: Record<string, { scope?: string }> = Array.isArray(configuration)
    ? Object.assign({}, ...configuration.map((c) => c.properties ?? {}))
    : (configuration.properties ?? {});

  /** A valid sample value for every key the incumbent honours, per section. */
  function sampleOf(key: string): unknown {
    const domain = LONEFY_KEYS[key].domain;
    switch (domain.type) {
      case 'boolean':
        return true;
      case 'integer':
        return Math.max(domain.min, 2);
      case 'enum':
        return domain.values[0];
      case 'eol':
        return '\n';
    }
  }
  const maximal = Object.fromEntries(
    Object.entries(LONEFY_SECTIONS).map(([name, section]) => [
      name,
      Object.fromEntries([...section.honoured].map((key) => [key, sampleOf(key)]))
    ])
  );
  const result = mapLonefyConfig(maximal, LOCAL);

  it('the maximal input really produces writes for every section and language', () => {
    const languages = new Set(result.writes.map((w) => w.language));
    assert.deepEqual([...languages].sort(), ['css', 'html', 'javascript', 'json', 'scss']);
    assert.deepEqual(result.warnings, [], 'every sample value is in its domain');
  });

  it('every written key exists in package.json, and a language write is language-overridable', () => {
    for (const write of result.writes) {
      const property = properties[write.key];
      assert.ok(property, `${write.key} must be a real setting in package.json`);
      assert.equal(
        property.scope,
        'language-overridable',
        `${write.key} is written per language, so VS Code must allow a [language] override`
      );
    }
  });

  it('every (key, language) pair written is one the option catalogue declares for that language', () => {
    for (const write of result.writes) {
      const entry = findBySettingKey(write.key);
      assert.ok(entry, `${write.key} must be in the catalogue`);
      assert.ok(
        appliesToLanguage(entry, write.language as CatalogLang),
        `${write.key} is not declared for ${write.language}: the migration must not write it there`
      );
    }
  });

  it('never writes a language the incumbent did not format (no less, no jsonc, no TypeScript)', () => {
    const written = new Set(result.writes.map((w) => w.language));
    for (const language of ['less', 'jsonc', 'typescript', 'typescriptreact', 'javascriptreact']) {
      assert.ok(!written.has(language as never), `[${language}] must never be written`);
    }
  });

  it('every key a section honours is in the mapped vocabulary, and the reverse', () => {
    const honoured = new Set(Object.values(LONEFY_SECTIONS).flatMap((s) => [...s.honoured]));
    for (const key of honoured) {
      assert.ok(isMappedKey(key), `${key} is honoured by a section but has no mapping`);
    }
    for (const key of Object.keys(LONEFY_KEYS)) {
      assert.ok(honoured.has(key), `${key} is mapped but no section of the incumbent honours it`);
    }
  });
});
