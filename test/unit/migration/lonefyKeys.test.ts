// Unit tests for the WIDENED key vocabulary and for the language targets of the
// incumbent's sections (src/migration/lonefyKeys.ts, lonefySections.ts,
// tidyApplicability.ts; v0.5.0). PURE (no 'vscode').
//
// The conductor's rule: a key is mapped IF AND ONLY IF a `tidy.*` setting has the
// SAME semantics and the SAME value domain, and only for the languages where that
// setting really applies. A key with no exact equivalent stays in "not carried
// over". These tests assert each side of that rule with the incumbent's REAL values
// (its default formatter.json, _internal/audit-v050/09-sondes-hote.md section 1.5).
//
//   - every newly mapped key, with its real value, in the section it lives in;
//   - every key that stays unmapped, one by one, with the reason it stays;
//   - `eol`, which touches line endings: only the two real endings map;
//   - the languages each section feeds: css also SCSS, javascript also JSON, never
//     LESS or JSONC (extension.ts L41-58 and L79);
//   - the value domains are the ones package.json declares.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { LONEFY_KEYS } from '../../../src/migration/lonefyKeys';
import { mapLonefyConfig } from '../../../src/migration/lonefyConfig';
import { LONEFY_SECTIONS } from '../../../src/migration/lonefySections';
import { tidySettingAppliesTo } from '../../../src/migration/tidyApplicability';
import type { MigrationWrite } from '../../../src/migration/types';

const LOCAL = { label: '.vscode/formatter.json', allowFlatKeys: false } as const;
const RC = { label: '.jsbeautifyrc', allowFlatKeys: true } as const;

/** `[lang] key = value` lines, for readable assertions. */
function lines(writes: readonly MigrationWrite[]): string[] {
  return writes.map(
    (w) =>
      `${w.language === undefined ? '' : `[${w.language}] `}${w.key} = ${JSON.stringify(w.value)}`
  );
}

/** Map one key of one section. */
function mapOne(section: string, key: string, value: unknown) {
  return mapLonefyConfig({ [section]: { [key]: value } }, LOCAL);
}

interface PackageProperty {
  type?: string;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  scope?: string;
}

const pkg = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8')
) as {
  contributes: {
    configuration: { properties?: Record<string, PackageProperty> } | Array<{ properties?: Record<string, PackageProperty> }>;
  };
};
const configuration = pkg.contributes.configuration;
const properties: Record<string, PackageProperty> = Array.isArray(configuration)
  ? Object.assign({}, ...configuration.map((c) => c.properties ?? {}))
  : (configuration.properties ?? {});

describe('migration/lonefyKeys : the value domains ARE the ones package.json declares', () => {
  for (const [key, spec] of Object.entries(LONEFY_KEYS)) {
    it(`${key} -> ${spec.tidyKey}`, () => {
      const property = properties[spec.tidyKey];
      assert.ok(property, `${spec.tidyKey} must exist in package.json`);
      const domain = spec.domain;
      switch (domain.type) {
        case 'boolean':
          assert.equal(property.type, 'boolean');
          break;
        case 'integer':
          assert.equal(property.type, 'integer');
          assert.equal(property.minimum, domain.min, 'same minimum');
          assert.equal(property.maximum, domain.max, 'same maximum (or none)');
          break;
        case 'enum':
          assert.equal(property.type, 'string');
          assert.deepEqual([...domain.values].sort(), [...(property.enum ?? [])].sort(), 'same enum');
          break;
        case 'eol':
          // The two values the mapper can produce are exactly the setting's enum.
          assert.deepEqual([...(property.enum ?? [])].sort(), ['crlf', 'lf']);
          break;
      }
    });
  }

  it('no two incumbent keys import into the same setting', () => {
    const targets = Object.values(LONEFY_KEYS).map((spec) => spec.tidyKey);
    assert.equal(new Set(targets).size, targets.length);
  });
});

describe('migration/lonefyKeys : newly mapped keys, with the incumbent REAL default values', () => {
  // [section, key, the value the incumbent ships, the languages it lands in].
  // The languages are the section's, minus those where the option catalogue does not
  // declare the setting (blank-line options are not declared for JSON, C-14).
  const REAL: ReadonlyArray<readonly [string, string, unknown, readonly string[], string]> = [
    ['javascript', 'preserve_newlines', true, ['javascript'], 'tidy.preserve_newlines'],
    ['javascript', 'break_chained_methods', false, ['javascript'], 'tidy.break_chained_methods'],
    ['javascript', 'max_preserve_newlines', 0, ['javascript'], 'tidy.max_preserve_newlines'],
    ['javascript', 'space_in_paren', false, ['javascript'], 'tidy.space_in_paren'],
    ['javascript', 'space_in_empty_paren', false, ['javascript'], 'tidy.space_in_empty_paren'],
    ['javascript', 'jslint_happy', false, ['javascript'], 'tidy.jslint_happy'],
    ['javascript', 'space_before_conditional', true, ['javascript'], 'tidy.space_before_conditional'],
    ['javascript', 'keep_array_indentation', false, ['javascript'], 'tidy.keep_array_indentation'],
    ['javascript', 'comma_first', false, ['javascript'], 'tidy.comma_first'],
    ['css', 'newline_between_rules', true, ['css', 'scss'], 'tidy.newline_between_rules'],
    ['html', 'indent_inner_html', false, ['html'], 'tidy.indent_inner_html']
  ];

  for (const [section, key, value, languages, tidyKey] of REAL) {
    it(`${section}.${key} = ${JSON.stringify(value)} -> ${tidyKey} in [${languages.join('], [')}]`, () => {
      const result = mapOne(section, key, value);
      assert.deepEqual(result.warnings, []);
      assert.deepEqual(result.unmapped, []);
      assert.deepEqual(
        lines(result.writes),
        languages.map((language) => `[${language}] ${tidyKey} = ${JSON.stringify(value)}`)
      );
    });
  }

  it('max_preserve_newlines 0 is imported as 0 (unlimited in JavaScript, in js-beautify 1.6.12 and 1.15.4 alike)', () => {
    assert.deepEqual(lines(mapOne('javascript', 'max_preserve_newlines', 0).writes), [
      '[javascript] tidy.max_preserve_newlines = 0'
    ]);
  });

  it('non-default values come through unchanged (the mapping is not vacuous)', () => {
    const result = mapLonefyConfig(
      {
        javascript: {
          preserve_newlines: false,
          max_preserve_newlines: 2,
          space_in_paren: true,
          space_in_empty_paren: true,
          break_chained_methods: true,
          keep_array_indentation: true,
          comma_first: true,
          operator_position: 'after-newline',
          jslint_happy: true,
          space_before_conditional: false
        }
      },
      LOCAL
    );
    assert.deepEqual(
      lines(result.writes.filter((w) => w.language === 'javascript')),
      [
        '[javascript] tidy.preserve_newlines = false',
        '[javascript] tidy.max_preserve_newlines = 2',
        '[javascript] tidy.space_in_paren = true',
        '[javascript] tidy.space_in_empty_paren = true',
        '[javascript] tidy.break_chained_methods = true',
        '[javascript] tidy.keep_array_indentation = true',
        '[javascript] tidy.comma_first = true',
        '[javascript] tidy.operator_position = "after-newline"',
        '[javascript] tidy.jslint_happy = true',
        '[javascript] tidy.space_before_conditional = false'
      ]
    );
  });

  it('the CSS family keys reach CSS and SCSS, with the real selector_separator_newline spelling', () => {
    const result = mapLonefyConfig(
      { css: { selector_separator_newline: false, space_around_combinator: true } },
      LOCAL
    );
    assert.deepEqual(lines(result.writes), [
      '[css] tidy.selector_separator_newline = false',
      '[css] tidy.space_around_combinator = true',
      '[scss] tidy.selector_separator_newline = false',
      '[scss] tidy.space_around_combinator = true'
    ]);
  });

  it('the HTML keys reach HTML', () => {
    const result = mapLonefyConfig(
      { html: { indent_scripts: 'separate', wrap_attributes_indent_size: 8, wrap_attributes: 'force' } },
      LOCAL
    );
    assert.deepEqual(lines(result.writes), [
      '[html] tidy.indent_scripts = "separate"',
      '[html] tidy.wrap_attributes_indent_size = 8',
      '[html] tidy.wrap_attributes = "force"'
    ]);
  });

  it('an out-of-domain value for a newly mapped key is reported, never written', () => {
    const result = mapLonefyConfig(
      { javascript: { max_preserve_newlines: -1, operator_position: 'sideways' }, html: { indent_scripts: 'all' } },
      LOCAL
    );
    assert.deepEqual(result.writes, []);
    assert.equal(result.warnings.length, 3);
  });
});

describe('migration/lonefyKeys : keys that STAY unmapped, each with its reason', () => {
  // [section, key, value, why it stays in "Not carried over"].
  const UNMAPPED: ReadonlyArray<readonly [string, string, unknown, string]> = [
    ['javascript', 'indent_char', ' ', 'no tidy.* setting: the indent character comes from the editor'],
    ['javascript', 'eol', 'auto', 'tidy.end_of_line has no "auto" value'],
    ['javascript', 'unescape_strings', false, 'no tidy.* setting'],
    ['javascript', 'e4x', false, 'no tidy.* setting'],
    ['javascript', 'end_with_newline', false, 'final newline is files.insertFinalNewline, an editor key the migration may not write'],
    ['css', 'indentCharacter', ' ', 'not a js-beautify option name: the incumbent ignored it'],
    ['css', 'indent_char', ' ', 'no tidy.* setting: the indent character comes from the editor'],
    ['css', 'selectorSeparatorNewLine', true, 'not a js-beautify option name: the incumbent ignored it'],
    ['css', 'end_with_newline', false, 'final newline is files.insertFinalNewline, an editor key the migration may not write'],
    ['html', 'indent_char', ' ', 'no tidy.* setting: the indent character comes from the editor'],
    ['html', 'indent_character', ' ', 'not a js-beautify option name: the incumbent ignored it']
  ];

  for (const [section, key, value, why] of UNMAPPED) {
    it(`${section}.${key} stays unmapped (${why})`, () => {
      const result = mapOne(section, key, value);
      assert.deepEqual(result.writes, [], 'nothing is written for it');
      assert.deepEqual([...result.unmapped], [`${section}.${key}`], 'and it is reported');
      assert.deepEqual(result.warnings, []);
    });
  }

  it('content_unformatted and void_elements are NOT mapped: Tidy\'s lists are additive, js-beautify\'s replaces', () => {
    // tidy.content_unformatted / tidy.void_elements ADD tags to a fixed list; the
    // incumbent's content_unformatted REPLACES js-beautify's default list (and
    // void_elements does not exist in js-beautify 1.6.12). Not the same meaning.
    const result = mapLonefyConfig(
      { html: { content_unformatted: ['pre', 'textarea'], void_elements: ['br'] } },
      LOCAL
    );
    assert.deepEqual(result.writes, []);
    assert.deepEqual([...result.unmapped], ['html.content_unformatted', 'html.void_elements']);
  });

  it('no tidy.* setting exists for the keys said to have none (the catalogue is the judge)', () => {
    // If one of these settings is ever added, this fails and the key must be reviewed.
    for (const name of [
      'indent_char',
      'unescape_strings',
      'e4x',
      'end_with_newline'
    ]) {
      assert.equal(
        properties[`tidy.${name}`],
        undefined,
        `tidy.${name} now exists: map ${name} (same semantics, same domain) or say why not`
      );
    }
  });
});

describe('migration/lonefyKeys : eol touches line endings, so only the two real endings map', () => {
  const eol = (value: unknown) => mapOne('css', 'eol', value);

  it('"\\n" is lf and "\\r\\n" is crlf, for CSS and SCSS', () => {
    assert.deepEqual(lines(eol('\n').writes), [
      '[css] tidy.end_of_line = "lf"',
      '[scss] tidy.end_of_line = "lf"'
    ]);
    assert.deepEqual(lines(eol('\r\n').writes), [
      '[css] tidy.end_of_line = "crlf"',
      '[scss] tidy.end_of_line = "crlf"'
    ]);
  });

  it('the JavaScript section also feeds JSON, whose engine honours the line ending', () => {
    assert.deepEqual(lines(mapOne('javascript', 'eol', '\r\n').writes), [
      '[javascript] tidy.end_of_line = "crlf"',
      '[json] tidy.end_of_line = "crlf"'
    ]);
  });

  it('the two-character escaped spellings (which js-beautify converts itself) map the same', () => {
    assert.deepEqual(lines(eol('\\n').writes), [
      '[css] tidy.end_of_line = "lf"',
      '[scss] tidy.end_of_line = "lf"'
    ]);
    assert.deepEqual(lines(eol('\\r\\n').writes), [
      '[css] tidy.end_of_line = "crlf"',
      '[scss] tidy.end_of_line = "crlf"'
    ]);
  });

  it('"auto" is NOT mapped and NOT a warning: a valid value with no Tidy equivalent', () => {
    const result = eol('auto');
    assert.deepEqual(result.writes, []);
    assert.deepEqual([...result.unmapped], ['css.eol']);
    assert.deepEqual(result.warnings, []);
  });

  for (const value of ['\r', 'lf', 'crlf', 'LF', '', 'unix', 10, true, null, ['\n']]) {
    it(`${JSON.stringify(value)} is out of domain: reported, never written`, () => {
      const result = eol(value);
      assert.deepEqual(result.writes, []);
      assert.equal(result.warnings.length, 1);
      assert.ok(result.warnings[0].startsWith('css.eol:'), result.warnings[0]);
    });
  }

  it('in a .jsbeautifyrc it maps to the plain setting', () => {
    assert.deepEqual(lines(mapLonefyConfig({ eol: '\n' }, RC).writes), [
      'tidy.end_of_line = "lf"'
    ]);
  });
});

describe('migration/lonefySections : which languages the incumbent applied each section to', () => {
  it('css also formats SCSS and javascript also formats JSON (extension.ts L41-58)', () => {
    assert.deepEqual([...LONEFY_SECTIONS.css.languages], ['css', 'scss']);
    assert.deepEqual([...LONEFY_SECTIONS.javascript.languages], ['javascript', 'json']);
    assert.deepEqual([...LONEFY_SECTIONS.html.languages], ['html']);
  });

  it('never LESS, JSONC, TypeScript or JSX: docType (L79) has five languages and they are not among them', () => {
    const all = Object.values(LONEFY_SECTIONS).flatMap((section) => [...section.languages]);
    assert.deepEqual([...new Set(all)].sort(), ['css', 'html', 'javascript', 'json', 'scss']);
    for (const language of ['less', 'jsonc', 'typescript', 'typescriptreact', 'javascriptreact']) {
      assert.ok(!all.includes(language as never), `${language} must not be a target`);
    }
  });

  it('the section names are exactly javascript, css and html', () => {
    assert.deepEqual(Object.keys(LONEFY_SECTIONS).sort(), ['css', 'html', 'javascript']);
  });

  it('every resulting key appears as a write the recap can list (one write per language and key)', () => {
    const result = mapLonefyConfig(
      { css: { indent_size: 2, newline_between_rules: false }, javascript: { indent_size: 2 } },
      LOCAL
    );
    assert.deepEqual(lines(result.writes), [
      '[javascript] tidy.indent = 2',
      '[json] tidy.indent = 2',
      '[css] tidy.indent = 2',
      '[css] tidy.newline_between_rules = false',
      '[scss] tidy.indent = 2',
      '[scss] tidy.newline_between_rules = false'
    ]);
  });
});

describe('migration/lonefySections : a key is imported only where the incumbent really honoured it', () => {
  // js-beautify 1.6.12 beautify-css.js does not read these, so they did nothing in a
  // css section; importing them would add a behaviour the user never had.
  for (const key of ['max_preserve_newlines', 'wrap_line_length', 'brace_style', 'wrap_attributes', 'space_in_paren']) {
    it(`css.${key} is reported, not written (the incumbent's CSS beautifier ignores it)`, () => {
      const value = key === 'brace_style' ? 'expand' : key === 'wrap_attributes' ? 'force' : key === 'space_in_paren' ? true : 80;
      const result = mapOne('css', key, value);
      assert.deepEqual(result.writes, []);
      assert.deepEqual([...result.unmapped], [`css.${key}`]);
    });
  }

  it('javascript.indent_inner_html and selector_separator_newline are not JavaScript options', () => {
    const result = mapLonefyConfig(
      { javascript: { indent_inner_html: true, selector_separator_newline: false } },
      LOCAL
    );
    assert.deepEqual(result.writes, []);
    assert.deepEqual([...result.unmapped], ['javascript.indent_inner_html', 'javascript.selector_separator_newline']);
  });

  it('indent_empty_lines did not exist in the incumbent js-beautify, so it is not imported', () => {
    const result = mapOne('javascript', 'indent_empty_lines', true);
    assert.deepEqual(result.writes, []);
    assert.deepEqual([...result.unmapped], ['javascript.indent_empty_lines']);
  });

  it('the camelCase twin is reported while the real spelling is imported', () => {
    const camel = mapOne('css', 'selectorSeparatorNewLine', false);
    assert.deepEqual(camel.writes, []);
    assert.deepEqual([...camel.unmapped], ['css.selectorSeparatorNewLine']);
    const real = mapOne('css', 'selector_separator_newline', false);
    assert.deepEqual(lines(real.writes), [
      '[css] tidy.selector_separator_newline = false',
      '[scss] tidy.selector_separator_newline = false'
    ]);
  });
});

describe('migration/tidyApplicability : a setting is written only where it really applies', () => {
  it('html.brace_style is honoured by the incumbent but Tidy has no HTML brace_style: reported', () => {
    const result = mapOne('html', 'brace_style', 'expand');
    assert.deepEqual(result.writes, []);
    assert.deepEqual([...result.unmapped], ['html.brace_style']);
  });

  it('JSON receives the indentation and line ending, and nothing its engine ignores', () => {
    const result = mapLonefyConfig(
      {
        javascript: {
          indent_size: 2,
          wrap_line_length: 80,
          preserve_newlines: true,
          max_preserve_newlines: 3,
          brace_style: 'expand',
          space_in_paren: true,
          eol: '\n'
        }
      },
      LOCAL
    );
    assert.deepEqual(
      lines(result.writes.filter((w) => w.language === 'json')),
      ['[json] tidy.indent = 2', '[json] tidy.end_of_line = "lf"']
    );
  });

  it('wrap_line_length is still written for JavaScript (only JSON is excluded)', () => {
    const result = mapOne('javascript', 'wrap_line_length', 80);
    assert.deepEqual(lines(result.writes), ['[javascript] tidy.wrap_line_length = 80']);
  });

  it('the predicate: catalogue declaration AND not a known-inert pair', () => {
    assert.equal(tidySettingAppliesTo('tidy.indent', 'json'), true);
    assert.equal(tidySettingAppliesTo('tidy.wrap_line_length', 'json'), false, 'declared for all, inert on JSON');
    assert.equal(tidySettingAppliesTo('tidy.wrap_line_length', 'javascript'), true);
    assert.equal(tidySettingAppliesTo('tidy.brace_style', 'css'), false);
    assert.equal(tidySettingAppliesTo('tidy.brace_style', 'javascript'), true);
    assert.equal(tidySettingAppliesTo('tidy.newline_between_rules', 'scss'), true);
    assert.equal(tidySettingAppliesTo('tidy.newline_between_rules', 'html'), false);
    assert.equal(tidySettingAppliesTo('tidy.does_not_exist', 'css'), false, 'an unknown key is never written');
  });
});
