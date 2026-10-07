// BEHAVIOURAL proof that every language-scoped write the migration can propose does
// something in Tidy (v0.5.0, MIGRATION): "map a key only for the languages where the
// setting really applies".
//
// The catalogue says where a setting applies; a catalogue can over-declare (it did
// for the blank-line options on JSON, defect C-14, and still does for
// wrap_line_length on JSON). So the claim is checked against the REAL engines, the
// way test/unit/config/optionHonoured.test.ts does for the catalogue itself: for
// every (setting, language) pair the mapper emits for a maximal input, format a
// sample twice, changing only that setting, and require the output to differ.
//
// If the mapper ever emits a pair that does nothing (the catalogue over-declares, or
// an engine stops reading an option), this fails naming the pair. If a new key is
// mapped without a probe here, the "every pair has a probe" test fails first.
//
// The line-ending setting is proved through the resolver, which is where
// `tidy.end_of_line` becomes the engine's `endOfLine` (catalogue engineKey
// `end_of_line`, resolver alias `end_of_line` -> `endOfLine`).
import assert from 'node:assert/strict';
import { findBySettingKey } from '../../../src/config/optionCatalog';
import { resolveOptions } from '../../../src/config/resolver';
import { dispatchFormat } from '../../../src/engine/dispatcher';
import { LONEFY_KEYS } from '../../../src/migration/lonefyKeys';
import { mapLonefyConfig } from '../../../src/migration/lonefyConfig';
import { LONEFY_SECTIONS } from '../../../src/migration/lonefySections';
import type { LangId, ResolvedOptions } from '../../../src/types';

const LOREM =
  'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore';

/** Format one sample, changing only the engine options / resolved fields given. */
function format(
  language: LangId,
  code: string,
  engineOptions: Record<string, unknown>,
  resolved: Partial<ResolvedOptions> = {}
): Promise<string> {
  return dispatchFormat({
    languageId: language,
    code,
    options: {
      tabSize: 4,
      insertSpaces: true,
      engineOptions,
      sources: {},
      ...resolved
    }
  });
}

type Samples = Partial<Record<LangId, string>>;

/** A probe: per language, the sample and the two values (`a` vs `b`) of one setting. */
interface Probe {
  readonly engineKey: string;
  readonly a: unknown;
  readonly b: unknown;
  /** Options held fixed on both sides (some settings only act next to another one). */
  readonly fixed?: Record<string, unknown>;
  readonly samples: Samples;
}

const JS_BLANKS =
  'function f(){\n\n  var x = compute(alpha, beta);\n\n\n\n  return x;\n}\nconst y = 1;\n\n\n\nconst z = 2;\n';
const CSS_BLANKS = '.a{color:red;\n\n\n\nbackground:blue}\n\n\n\n.b{color:blue}\n';
const HTML_BLANKS = `<div>\n\n\n\n<p>${LOREM}</p>\n\n\n\n<p>y</p>\n</div>\n`;
const JS_LONG =
  'const y = compute(alphaValue, betaValue, gammaValue, deltaValue, epsilonValue, zetaValue, etaValue);\n';
// operator_position acts on an operator that sits at a line break in the SOURCE.
const JS_SUM = 'var x = aaaaaaaaaaaa\n    + bbbbbbbbbbbb\n    + cccccccccccc;\n';
const HTML_ATTRS =
  '<div a="1" b="2" c="3" d="4" e="5" f="6" g="7" h="8" i="9" j="10" k="11" l="12"></div>\n';

/** The probes for every key the mapper can emit, keyed by `tidy.*` setting. */
const PROBES: Readonly<Record<string, Probe>> = {
  'tidy.preserve_newlines': {
    engineKey: 'preserve_newlines',
    a: true,
    b: false,
    samples: { javascript: JS_BLANKS, css: CSS_BLANKS, scss: CSS_BLANKS, html: HTML_BLANKS }
  },
  'tidy.max_preserve_newlines': {
    engineKey: 'max_preserve_newlines',
    a: 10,
    b: 1,
    samples: { javascript: JS_BLANKS, html: HTML_BLANKS }
  },
  'tidy.brace_style': {
    engineKey: 'brace_style',
    a: 'collapse',
    b: 'expand',
    samples: { javascript: 'if (a) { b(); } else { c(); }\n' }
  },
  'tidy.wrap_line_length': {
    engineKey: 'wrap_line_length',
    a: 0,
    b: 40,
    samples: { javascript: JS_LONG, html: `<p>${LOREM} ${LOREM}</p>\n` }
  },
  'tidy.space_after_anon_function': {
    engineKey: 'space_after_anon_function',
    a: false,
    b: true,
    samples: { javascript: 'var f = function(){ return 1; };\n' }
  },
  'tidy.space_before_conditional': {
    engineKey: 'space_before_conditional',
    a: true,
    b: false,
    samples: { javascript: 'if (a) { b(); }\n' }
  },
  'tidy.jslint_happy': {
    engineKey: 'jslint_happy',
    a: false,
    b: true,
    // Both effects: a space after `function`, and case labels level with their switch.
    samples: { javascript: 'var f = function(){ return 1; };\nswitch (a) {\ncase 1:\nbreak;\n}\n' }
  },
  'tidy.space_in_paren': {
    engineKey: 'space_in_paren',
    a: false,
    b: true,
    samples: { javascript: 'f(a, b);\n' }
  },
  'tidy.space_in_empty_paren': {
    engineKey: 'space_in_empty_paren',
    a: false,
    b: true,
    // js-beautify only applies it next to space_in_paren, on both sides of the probe.
    fixed: { space_in_paren: true },
    samples: { javascript: 'f();\n' }
  },
  'tidy.break_chained_methods': {
    engineKey: 'break_chained_methods',
    a: false,
    b: true,
    samples: { javascript: 'a.b().c().d().e();\n' }
  },
  'tidy.keep_array_indentation': {
    engineKey: 'keep_array_indentation',
    a: false,
    b: true,
    samples: { javascript: 'var a = [\n        1,\n   2,\n 3\n];\n' }
  },
  'tidy.comma_first': {
    engineKey: 'comma_first',
    a: false,
    b: true,
    samples: { javascript: 'var a = 1,\n    b = 2;\n' }
  },
  'tidy.operator_position': {
    engineKey: 'operator_position',
    a: 'before-newline',
    b: 'after-newline',
    samples: { javascript: JS_SUM }
  },
  'tidy.selector_separator_newline': {
    engineKey: 'selector_separator_newline',
    a: true,
    b: false,
    samples: { css: '.a,.b{color:red}\n', scss: '.a,.b{color:red}\n' }
  },
  'tidy.newline_between_rules': {
    engineKey: 'newline_between_rules',
    a: true,
    b: false,
    samples: { css: '.a{color:red}\n.b{color:blue}\n', scss: '.a{color:red}\n.b{color:blue}\n' }
  },
  'tidy.space_around_combinator': {
    engineKey: 'space_around_combinator',
    a: false,
    b: true,
    samples: { css: '.a>.b{color:red}\n', scss: '.a>.b{color:red}\n' }
  },
  'tidy.indent_inner_html': {
    engineKey: 'indent_inner_html',
    a: false,
    b: true,
    samples: { html: '<html><head><title>t</title></head><body><p>x</p></body></html>\n' }
  },
  'tidy.indent_scripts': {
    engineKey: 'indent_scripts',
    a: 'normal',
    b: 'separate',
    samples: { html: '<div><script>var a=1;if(a){b()}</script></div>\n' }
  },
  'tidy.wrap_attributes': {
    engineKey: 'wrap_attributes',
    a: 'auto',
    b: 'force',
    samples: { html: HTML_ATTRS }
  },
  'tidy.wrap_attributes_indent_size': {
    engineKey: 'wrap_attributes_indent_size',
    a: 2,
    b: 8,
    fixed: { wrap_attributes: 'force' },
    samples: { html: HTML_ATTRS }
  }
};

/** Indentation and line ending are typed fields of ResolvedOptions, not engineOptions. */
const INDENT_SAMPLES: Samples = {
  javascript: 'function f(){if(a){b()}}\n',
  json: '{"a":{"b":1}}\n',
  css: '.a{color:red}\n',
  scss: '.a{color:red}\n',
  html: '<div><p>x</p></div>\n'
};
const EOL_SAMPLES: Samples = {
  javascript: 'var a = 1;\r\nvar b = 2;\r\n',
  json: '{\r\n"a": 1\r\n}\r\n',
  css: '.a {\r\ncolor: red\r\n}\r\n',
  scss: '.a {\r\ncolor: red\r\n}\r\n',
  html: '<div>\r\n<p>x</p>\r\n</div>\r\n'
};

/** A valid sample value for each key, to build the maximal input. */
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
const EMITTED = mapLonefyConfig(maximal, { label: 'maximal', allowFlatKeys: false }).writes.map(
  (write) => ({ key: write.key, language: write.language as LangId })
);

describe('migration : every language-scoped write really does something in Tidy', () => {
  it('the maximal input emits writes (the loop below is not vacuous)', () => {
    assert.ok(EMITTED.length >= 30, `only ${EMITTED.length} pairs emitted`);
  });

  it('every emitted (setting, language) pair has a probe', () => {
    for (const { key, language } of EMITTED) {
      if (key === 'tidy.indent' || key === 'tidy.end_of_line') {
        continue; // typed fields, probed below.
      }
      const probe = PROBES[key];
      assert.ok(probe, `${key} is emitted for [${language}] but has no behavioural probe`);
      assert.ok(
        probe.samples[language] !== undefined,
        `${key} is emitted for [${language}] but the probe has no sample for it`
      );
    }
  });

  for (const { key, language } of EMITTED) {
    const probe = PROBES[key];
    if (probe === undefined) {
      continue;
    }
    it(`${key} changes the output of [${language}]`, async () => {
      const entry = findBySettingKey(key);
      assert.equal(entry?.engineKey, probe.engineKey, 'the probe drives the option the catalogue names');
      const code = probe.samples[language] as string;
      const fixed = probe.fixed ?? {};
      const a = await format(language, code, { ...fixed, [probe.engineKey]: probe.a });
      const b = await format(language, code, { ...fixed, [probe.engineKey]: probe.b });
      assert.notEqual(
        a,
        b,
        `${key} = ${String(probe.a)} and ${String(probe.b)} format [${language}] identically: ` +
          'the migration would write a key that does nothing there'
      );
    });
  }

  describe('tidy.indent (reaches the engine as tabSize through the resolver)', () => {
    it('the catalogue key becomes tabSize', () => {
      assert.equal(findBySettingKey('tidy.indent')?.engineKey, 'indent_size');
      const resolved = resolveOptions({
        languageId: 'css',
        layers: [{ source: 'probe', values: { indent_size: 7 } }]
      });
      assert.equal(resolved.tabSize, 7);
    });

    for (const { key, language } of EMITTED.filter((pair) => pair.key === 'tidy.indent')) {
      it(`changes the output of [${language}]`, async () => {
        const code = INDENT_SAMPLES[language] as string;
        const two = await format(language, code, {}, { tabSize: 2 });
        const eight = await format(language, code, {}, { tabSize: 8 });
        assert.notEqual(two, eight);
      });
    }
  });

  describe('tidy.end_of_line (reaches the engine as endOfLine through the resolver)', () => {
    it('the catalogue key becomes endOfLine, for the two values the mapper can produce', () => {
      assert.equal(findBySettingKey('tidy.end_of_line')?.engineKey, 'end_of_line');
      for (const value of ['lf', 'crlf'] as const) {
        const resolved = resolveOptions({
          languageId: 'css',
          layers: [{ source: 'probe', values: { end_of_line: value } }]
        });
        assert.equal(resolved.endOfLine, value);
      }
    });

    for (const { key, language } of EMITTED.filter((pair) => pair.key === 'tidy.end_of_line')) {
      it(`turns a CRLF document into LF (and LF into CRLF) for [${language}]`, async () => {
        const code = EOL_SAMPLES[language] as string;
        const lf = await format(language, code, {}, { endOfLine: 'lf' });
        const crlf = await format(language, code, {}, { endOfLine: 'crlf' });
        assert.ok(!lf.includes('\r'), `lf output must hold no CR: ${JSON.stringify(lf)}`);
        assert.ok(/\r\n/.test(crlf) && !/[^\r]\n/.test(crlf), `crlf output must be all CRLF: ${JSON.stringify(crlf)}`);
        assert.ok(key === 'tidy.end_of_line');
      });
    }
  });

  it('the known-inert pair is real: wrap_line_length does nothing on JSON (and is excluded)', async () => {
    const sample = '{"a":[1,2,3],"b":"' + LOREM + ' ' + LOREM + '"}\n';
    const wide = await format('json', sample, { wrap_line_length: 0 });
    const narrow = await format('json', sample, { wrap_line_length: 40 });
    assert.equal(wide, narrow, 'if this starts to differ, tidyApplicability.ts can drop its exclusion');
    assert.ok(
      !EMITTED.some((pair) => pair.key === 'tidy.wrap_line_length' && pair.language === 'json'),
      'and the mapper never writes it for [json]'
    );
  });
});
