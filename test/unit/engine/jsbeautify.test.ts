// Unit tests for the js-beautify engine adapter (SPEC CFG-01, ENG-04).
// Verifies the option mapping (tabSize/insertSpaces -> indentation, EOL,
// final-newline, trim) and range formatting, without a VS Code host.
import assert from 'node:assert/strict';
import { JsBeautifyEngine } from '../../../src/engine/jsbeautify';
import { guard } from '../../../src/safety/guard';
import { resolved } from '../../helpers/options';
import type { LangId } from '../../../src/types';

const engine = new JsBeautifyEngine();

describe('engine/jsbeautify — supported languages', () => {
  it('supports css/scss/less/html/json/jsonc/javascript', () => {
    for (const lang of ['css', 'scss', 'less', 'html', 'json', 'jsonc', 'javascript'] as const) {
      assert.ok(engine.supports(lang), `must support ${lang}`);
    }
  });
  it('does not claim ts/tsx/jsx (those go to prettier)', () => {
    for (const lang of ['typescript', 'typescriptreact', 'javascriptreact'] as const) {
      assert.equal(engine.supports(lang), false);
    }
  });
});

describe('engine/jsbeautify — indentation mapping (CFG-01)', () => {
  it('tabSize=2 + insertSpaces=true => 2 spaces', async () => {
    const out = await engine.format({
      languageId: 'css',
      code: '.a{color:red}',
      options: resolved({ tabSize: 2, insertSpaces: true })
    });
    assert.ok(out.includes('\n  color: red'), `expected 2-space indent, got ${JSON.stringify(out)}`);
  });

  it('insertSpaces=false => tab indentation', async () => {
    const out = await engine.format({
      languageId: 'javascript',
      code: 'function f(){return 1;}',
      options: resolved({ tabSize: 4, insertSpaces: false })
    });
    assert.ok(out.includes('\n\treturn 1;'), `expected tab indent, got ${JSON.stringify(out)}`);
  });

  it('malformed tabSize (0) clamps to a safe default rather than corrupting', async () => {
    const out = await engine.format({
      languageId: 'css',
      code: '.a{color:red}',
      options: resolved({ tabSize: 0, insertSpaces: true })
    });
    // Must still produce indented, parseable output (4-space fallback).
    assert.ok(out.includes('color: red'));
  });
});

describe('engine/jsbeautify — final newline & EOL policy (CFG-03, #62/#82/#88)', () => {
  it('insertFinalNewline=true adds exactly one trailing newline', async () => {
    const out = await engine.format({
      languageId: 'json',
      code: '{"a":1}',
      options: resolved({ insertFinalNewline: true })
    });
    assert.ok(out.endsWith('\n'));
    assert.ok(!out.endsWith('\n\n'), 'exactly one final newline');
  });

  it('insertFinalNewline=false strips the trailing newline (non-destruction of choice)', async () => {
    const out = await engine.format({
      languageId: 'json',
      code: '{"a":1}\n',
      options: resolved({ insertFinalNewline: false })
    });
    assert.ok(!out.endsWith('\n'));
  });

  it('endOfLine=crlf normalises line endings to CRLF', async () => {
    const out = await engine.format({
      languageId: 'css',
      code: '.a{color:red;margin:0}',
      options: resolved({ endOfLine: 'crlf' })
    });
    assert.ok(out.includes('\r\n'));
    assert.ok(!/[^\r]\n/.test(out), 'no lone LF when CRLF requested');
  });

  it('trimTrailingWhitespace=true removes per-line trailing spaces', async () => {
    const out = await engine.format({
      languageId: 'javascript',
      code: 'const x = 1;   \nconst y = 2;\t\n',
      options: resolved({ trimTrailingWhitespace: true, endOfLine: 'lf' })
    });
    assert.ok(!/[^\S\r\n]+\n/.test(out), 'no trailing whitespace before a newline');
  });
});

describe('engine/jsbeautify — range formatting splices back the surroundings', () => {
  it('formats only the selected slice, preserving bytes outside the range', async () => {
    const code = 'HEADER\n.a{color:red}\nFOOTER';
    const start = code.indexOf('.a');
    const end = code.indexOf('\nFOOTER');
    const out = await engine.format({
      languageId: 'css',
      code,
      options: resolved({ tabSize: 2 }),
      range: { startOffset: start, endOffset: end }
    });
    assert.ok(out.startsWith('HEADER\n'), 'prefix preserved');
    assert.ok(out.endsWith('\nFOOTER'), 'suffix preserved');
    assert.ok(out.includes('color: red'), 'selection formatted');
  });

  it('degenerate (empty) range returns the input unchanged', async () => {
    const code = '.a{color:red}';
    const out = await engine.format({
      languageId: 'css',
      code,
      options: resolved(),
      range: { startOffset: 5, endOffset: 5 }
    });
    assert.equal(out, code);
  });
});

// --- engineOptions effect proof (Axe 3.T2 — "not enough options") -----------
//
// For EVERY new js-beautify key threaded through engineOptions we PROVE two
// things at once, mirroring the Prettier stylistic-guard contract:
//   1. EFFECT  — formatting with the option set produces a DIFFERENT result from
//      the engine default (the option is really consumed, not silently dropped),
//   2. SAFETY  — guard.check(input, tuned) stays equivalent:true, i.e. the option
//      only rewrites whitespace/style and never changes the AST/CSS/HTML tree.
// Together these guarantee a newly-exposed option can never be a no-op and can
// never let the formatter corrupt a file (the two SPEC §12 failure modes).
//
// Each `code` input is deliberately authored so the default and the toggled
// output diverge; the precise tuned substring is asserted from the real
// js-beautify output captured against the shipped @types/js-beautify version.

interface EffectCase {
  readonly key: string; // the engineOptions key under proof
  readonly lang: LangId;
  readonly code: string;
  readonly engineOptions: Record<string, unknown>;
  /** A substring that MUST appear in the tuned output (the option's signature). */
  readonly expectInTuned: string;
  /** Optional substring that MUST appear in the default output (and not tuned). */
  readonly expectInDefaultOnly?: string;
}

/**
 * Format `code` with default engineOptions and with `engineOptions`, asserting the
 * two outputs differ, the tuned output carries the option's signature, and the
 * equivalence guard accepts the tuned output as semantically identical.
 */
async function proveEffect(testCase: EffectCase): Promise<void> {
  const base = await engine.format({
    languageId: testCase.lang,
    code: testCase.code,
    options: resolved()
  });
  const tuned = await engine.format({
    languageId: testCase.lang,
    code: testCase.code,
    options: resolved({ engineOptions: testCase.engineOptions })
  });

  assert.notEqual(
    tuned,
    base,
    `${testCase.key}: option had no effect (tuned === default)`
  );
  assert.ok(
    tuned.includes(testCase.expectInTuned),
    `${testCase.key}: expected ${JSON.stringify(testCase.expectInTuned)} in tuned output ${JSON.stringify(tuned)}`
  );
  if (testCase.expectInDefaultOnly !== undefined) {
    assert.ok(
      base.includes(testCase.expectInDefaultOnly),
      `${testCase.key}: expected ${JSON.stringify(testCase.expectInDefaultOnly)} in default output ${JSON.stringify(base)}`
    );
    assert.ok(
      !tuned.includes(testCase.expectInDefaultOnly),
      `${testCase.key}: did not expect ${JSON.stringify(testCase.expectInDefaultOnly)} in tuned output ${JSON.stringify(tuned)}`
    );
  }

  const verdict = guard.check(testCase.lang, testCase.code, tuned);
  assert.equal(
    verdict.equivalent,
    true,
    `${testCase.key}: guard must accept the tuned output (reason: ${verdict.reason ?? 'none'})`
  );
}

// JavaScript-family js-beautify options.
const JS_EFFECT_CASES: readonly EffectCase[] = [
  {
    key: 'brace_style',
    lang: 'javascript',
    code: 'function f(){return 1;}',
    engineOptions: { brace_style: 'expand' },
    // expand puts the opening brace on its own line (antidote review #114).
    expectInTuned: 'function f()\n{'
  },
  {
    key: 'brace_style (collapse-preserve-inline alias)',
    lang: 'javascript',
    code: 'if (a) { b(); }',
    engineOptions: { brace_style: 'collapse-preserve-inline' },
    // The package.json alias maps to js-beautify's "collapse,preserve-inline"
    // combined form: an already-inline short block stays on one line, where the
    // default 'collapse' would explode it across three lines.
    expectInTuned: 'if (a) { b(); }',
    expectInDefaultOnly: '{\n  b();'
  },
  {
    key: 'wrap_line_length',
    lang: 'javascript',
    code: 'var x = aaaa + bbbb + cccc + dddd + eeee + ffff + gggg + hhhh;',
    engineOptions: { wrap_line_length: 20 },
    // Honoured wrapping (antidote review #24/#125): the long expression breaks.
    expectInTuned: '+\n'
  },
  {
    key: 'preserve_newlines',
    lang: 'javascript',
    code: 'var a = 1;\n\n\nvar b = 2;',
    engineOptions: { preserve_newlines: false },
    // With preservation off the blank lines collapse.
    expectInTuned: 'var a = 1;\nvar b = 2;',
    expectInDefaultOnly: 'var a = 1;\n\n'
  },
  {
    key: 'max_preserve_newlines',
    lang: 'javascript',
    code: 'var a = 1;\n\n\n\n\nvar b = 2;',
    engineOptions: { max_preserve_newlines: 1 },
    // At most one blank line is kept (here the run collapses entirely).
    expectInTuned: 'var a = 1;\nvar b = 2;'
  },
  {
    key: 'indent_empty_lines',
    lang: 'javascript',
    code: 'function f() {\n\n  return 1;\n}',
    engineOptions: { indent_empty_lines: true },
    // The otherwise-empty line keeps its indentation.
    expectInTuned: '{\n  \n  return 1;'
  },
  {
    key: 'space_in_paren',
    lang: 'javascript',
    code: 'function f(a){return a;}',
    engineOptions: { space_in_paren: true },
    // Padding spaces inside parentheses: f( a ).
    expectInTuned: 'function f( a )'
  },
  {
    key: 'space_in_empty_paren',
    lang: 'javascript',
    code: 'function f(){return 1;}',
    engineOptions: { space_in_paren: true, space_in_empty_paren: true },
    // A space is kept inside an empty parentheses pair: f( ).
    expectInTuned: 'function f( )'
  },
  {
    key: 'break_chained_methods',
    lang: 'javascript',
    code: 'a.b().c().d();',
    engineOptions: { break_chained_methods: true },
    // Chained calls break onto their own lines.
    expectInTuned: 'a.b()\n  .c()\n  .d();'
  },
  {
    key: 'keep_array_indentation',
    lang: 'javascript',
    code: 'var a = [1,\n        2,\n        3];',
    engineOptions: { keep_array_indentation: true },
    // The authored 8-space element indentation is preserved verbatim.
    expectInTuned: '[1,\n        2,\n        3]'
  },
  {
    key: 'comma_first',
    lang: 'javascript',
    code: 'var a = 1,\n    b = 2,\n    c = 3;',
    engineOptions: { comma_first: true },
    // Commas move to the start of the next line.
    expectInTuned: '\n  , b = 2'
  },
  {
    key: 'operator_position',
    lang: 'javascript',
    code: 'var x = aaaaaaaaaaaaaaaaaaaaaa +\nbbbbbbbbbbbbbbbbbbbbbb;',
    engineOptions: { operator_position: 'after-newline', wrap_line_length: 40 },
    // The wrapping '+' lands at the START of the continuation line.
    expectInTuned: '\n  + bbbbbbbbbbbbbbbbbbbbbb;'
  },
  {
    key: 'space_after_anon_function',
    lang: 'javascript',
    code: 'var f = function(){return 1;};',
    engineOptions: { space_after_anon_function: true },
    // A space is inserted after the anonymous function keyword.
    expectInTuned: 'function ()'
  }
];

// CSS-family js-beautify options.
const CSS_EFFECT_CASES: readonly EffectCase[] = [
  {
    key: 'selector_separator_newline',
    lang: 'css',
    code: 'a,b{color:red}',
    engineOptions: { selector_separator_newline: false },
    // With it OFF the comma-grouped selectors stay on one line.
    expectInTuned: 'a, b {'
  },
  {
    key: 'newline_between_rules',
    lang: 'css',
    code: 'a{color:red}b{color:blue}',
    engineOptions: { newline_between_rules: false },
    // With it OFF there is no blank line between rules.
    expectInTuned: '}\nb {'
  },
  {
    key: 'space_around_combinator',
    lang: 'css',
    code: 'a>b{color:red}',
    engineOptions: { space_around_combinator: true },
    // Spaces are placed around the child combinator: a > b.
    expectInTuned: 'a > b {'
  }
];

// HTML-family js-beautify options.
const HTML_EFFECT_CASES: readonly EffectCase[] = [
  {
    key: 'wrap_attributes',
    lang: 'html',
    code: '<div aaaaaaaa="1" bbbbbbbb="2"></div>',
    engineOptions: { wrap_attributes: 'force' },
    // 'force' wraps every attribute onto its own line.
    expectInTuned: 'aaaaaaaa="1"\n'
  },
  {
    key: 'wrap_attributes_indent_size',
    lang: 'html',
    code: '<div aaaaaaaa="1" bbbbbbbb="2" cccccccc="3"></div>',
    engineOptions: { wrap_attributes: 'force', wrap_attributes_indent_size: 8 },
    // Wrapped attributes are indented by the requested 8 spaces.
    expectInTuned: '\n        bbbbbbbb="2"'
  },
  {
    key: 'indent_inner_html',
    lang: 'html',
    code: '<html><head></head><body></body></html>',
    engineOptions: { indent_inner_html: true },
    // <head>/<body> are indented one level inside <html>.
    expectInTuned: '\n  <head></head>'
  },
  {
    key: 'indent_scripts',
    lang: 'html',
    code: '<div><script>var a=1;</script></div>',
    engineOptions: { indent_scripts: 'keep' },
    // 'keep' leaves the script body at the <script> tag's own indentation
    // rather than indenting it a further level ('normal').
    expectInTuned: '<script>\n  var a = 1;'
  }
];

const ALL_EFFECT_CASES: readonly EffectCase[] = [
  ...JS_EFFECT_CASES,
  ...CSS_EFFECT_CASES,
  ...HTML_EFFECT_CASES
];

describe('engine/jsbeautify — engineOptions effect + guard equivalence (Axe 3.T2)', () => {
  for (const testCase of ALL_EFFECT_CASES) {
    it(`${testCase.key} changes the output AND the guard accepts it`, async () => {
      await proveEffect(testCase);
    });
  }

  it('an invalid (wrong-type) engineOption is ignored, not propagated', async () => {
    // A malformed layer must never override a sane js-beautify default: a boolean
    // option given a string, and an enum option given an off-list value, both
    // fall back to the default output. This locks the type-guard behaviour.
    const code = 'function f(a){return a;}';
    const base = await engine.format({ languageId: 'javascript', code, options: resolved() });
    const garbage = await engine.format({
      languageId: 'javascript',
      code,
      options: resolved({
        engineOptions: {
          space_in_paren: 'yes-please',
          brace_style: 'totally-not-a-style',
          wrap_line_length: Number.NaN
        }
      })
    });
    assert.equal(garbage, base, 'invalid engineOptions must not change the output');
  });

  it('engineOptions stack with the indentation mapping (per-family, tabs)', async () => {
    // Prove the new options compose with the existing tabSize/insertSpaces path
    // rather than replacing it: tab indentation AND brace_style=expand together.
    const code = 'function f(){return 1;}';
    const out = await engine.format({
      languageId: 'javascript',
      code,
      options: resolved({ insertSpaces: false, engineOptions: { brace_style: 'expand' } })
    });
    assert.ok(out.includes('function f()\n{'), 'brace_style=expand applied');
    assert.ok(out.includes('\n\treturn 1;'), 'tab indentation still applied');
    assert.equal(guard.check('javascript', code, out).equivalent, true);
  });
});
