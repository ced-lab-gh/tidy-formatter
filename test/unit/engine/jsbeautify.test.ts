// Unit tests for the js-beautify engine adapter (SPEC CFG-01, ENG-04).
// Verifies the option mapping (tabSize/insertSpaces -> indentation, EOL,
// final-newline, trim) and range formatting, without a VS Code host.
import assert from 'node:assert/strict';
import {
  JsBeautifyEngine,
  JS_BEAUTIFY_ENGINE_ID,
  JSON_ENGINE_ID,
  reportedEngineIdFor
} from '../../../src/engine/jsbeautify';
import { guard } from '../../../src/safety/guard';
import { HTML_PREFORMATTED_TAGS } from '../../../src/safety/htmlPreformatted';
import { splitSliceEdges } from '../../../src/engine/sliceEdges';
import { resolved } from '../../helpers/options';
import type { LangId } from '../../../src/types';

const engine = new JsBeautifyEngine();

describe('engine/jsbeautify : supported languages', () => {
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

describe('engine/jsbeautify : indentation mapping (CFG-01)', () => {
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

describe('engine/jsbeautify : final newline & EOL policy (CFG-03, #62/#82/#88)', () => {
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

describe('engine/jsbeautify : range formatting splices back the surroundings', () => {
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

// --- engineOptions effect proof (Axe 3.T2 : "not enough options") -----------
//
// For EVERY new js-beautify key threaded through engineOptions we PROVE two
// things at once, mirroring the Prettier stylistic-guard contract:
//   1. EFFECT  : formatting with the option set produces a DIFFERENT result from
//      the engine default (the option is really consumed, not silently dropped),
//   2. SAFETY  : guard.check(input, tuned) stays equivalent:true, i.e. the option
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

describe('engine/jsbeautify : engineOptions effect + guard equivalence (Axe 3.T2)', () => {
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

describe('engine/jsbeautify : the REPORTED engine id names the printer that ran', () => {
  it('json/jsonc report jsonc-parser, the printer that actually runs', () => {
    // json/jsonc are routed to src/engine/jsonFormatter.ts (jsonc-parser), never
    // to js-beautify. Naming js-beautify in the status bar, the output channel
    // and "Explain Last Format" named a library that never ran.
    assert.equal(JSON_ENGINE_ID, 'jsonc-parser');
    assert.equal(reportedEngineIdFor('json'), JSON_ENGINE_ID);
    assert.equal(reportedEngineIdFor('jsonc'), JSON_ENGINE_ID);
  });

  it('every other family this adapter prints still reports js-beautify', () => {
    for (const lang of ['css', 'scss', 'less', 'html', 'javascript'] as const) {
      assert.equal(reportedEngineIdFor(lang), JS_BEAUTIFY_ENGINE_ID);
    }
  });

  it('the adapter\'s own Engine.id is unchanged (routing and config key off it)', () => {
    // src/config/prettierrc.ts and src/engine/dispatcher.ts compare this exact
    // string, so the reporting fix must not move it.
    assert.equal(engine.id, 'js-beautify');
    assert.equal(JS_BEAUTIFY_ENGINE_ID, 'js-beautify');
  });
});

describe('engine/jsbeautify : preformatted HTML is never reflowed', () => {
  // js-beautify's own default for content_unformatted is ['pre', 'textarea'],
  // so it reflowed <xmp>, <listing> and <plaintext>, which the HTML Rendering
  // spec renders with the same `white-space: pre`. The adapter now hands it the
  // safety layer's list (src/safety/htmlPreformatted.ts), which is the same list
  // the guard compares verbatim: neither side can be widened alone.
  const BODY = 'alpha\n\tTABBED\n    spaced';

  for (const tag of HTML_PREFORMATTED_TAGS) {
    it(`keeps every byte inside <${tag}>`, async () => {
      // <plaintext> consumes the rest of the file, so it takes no closing tag.
      const code =
        tag === 'plaintext'
          ? `<div>\n<plaintext>${BODY}`
          : `<div>\n<${tag}>${BODY}</${tag}>\n</div>`;
      const out = await engine.format({
        languageId: 'html',
        code,
        options: resolved({ tabSize: 2, insertSpaces: true })
      });
      assert.ok(
        out.includes(BODY),
        `js-beautify reflowed inside <${tag}>: ${JSON.stringify(out)}`
      );
      assert.equal(guard.check('html', code, out).equivalent, true);
    });
  }

  it('a user engineOptions blob cannot shrink the protection', async () => {
    // content_unformatted is deliberately NOT in the option catalogue: it is a
    // safety alignment with the guard, not a style choice. A layer that tries to
    // set it anyway must be ignored, or the false accept comes straight back.
    const code = '<div>\n<xmp>alpha\n\tTABBED</xmp>\n</div>';
    const out = await engine.format({
      languageId: 'html',
      code,
      options: resolved({
        engineOptions: { content_unformatted: ['pre'] }
      })
    });
    assert.ok(out.includes('alpha\n\tTABBED'), `got ${JSON.stringify(out)}`);
    assert.equal(guard.check('html', code, out).equivalent, true);
  });
});

/* -------------------------------------------------------------------------- */
/* C-04 : ONE whitespace policy, so no bare LF lands in a CRLF document         */
/* -------------------------------------------------------------------------- */
//
// This adapter used to carry its OWN copy of the post-processing pass, and the
// copy drifted from src/engine/postProcess.ts: its final-newline branch appended
// a hard-coded LF instead of the DOCUMENT's line ending. At the DEFAULT
// configuration (files.eol "auto", i.e. endOfLine undetermined, plus
// insertFinalNewline true) a CRLF document therefore came back with one lone LF
// glued to its last line. A whitespace-only difference is equivalent to the
// guard, so that mixed-EOL result was WRITTEN. The whole js-beautify family was
// affected. These tests lock the reuse, not the copy.

/** Count CRLF pairs, and the LFs that are NOT part of a CRLF pair. */
function eolCounts(text: string): { crlf: number; bareLf: number } {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const bareLf = (text.replace(/\r\n/g, '').match(/\n/g) ?? []).length;
  return { crlf, bareLf };
}

describe('engine/jsbeautify : one final-newline policy, never a bare LF (C-04)', () => {
  const CRLF_SOURCES: ReadonlyArray<{ lang: LangId; code: string }> = [
    { lang: 'css', code: '.a{color:red}\r\n.b{color:blue}\r\n' },
    { lang: 'scss', code: '.a{color:red}\r\n.b{color:blue}\r\n' },
    { lang: 'less', code: '.a{color:red}\r\n.b{color:blue}\r\n' },
    { lang: 'html', code: '<div><p>a</p></div>\r\n<span>b</span>\r\n' },
    { lang: 'javascript', code: 'const a={x:1};\r\nconst b=2;\r\n' },
    { lang: 'json', code: '{"a":1,\r\n"b":2}\r\n' },
    { lang: 'jsonc', code: '{"a":1,\r\n"b":2}\r\n' }
  ];

  for (const source of CRLF_SOURCES) {
    it(`${source.lang}: a CRLF document keeps CRLF at the DEFAULT eol (auto)`, async () => {
      // endOfLine is deliberately left undetermined: that is files.eol "auto",
      // the shipped default, and the exact configuration the defect needed.
      const out = await engine.format({
        languageId: source.lang,
        code: source.code,
        options: resolved({ insertFinalNewline: true })
      });
      const counts = eolCounts(out);
      assert.equal(
        counts.bareLf,
        0,
        `a lone LF reached a CRLF document: ${JSON.stringify(out)}`
      );
      assert.ok(counts.crlf > 0, 'the document is still CRLF');
      assert.ok(out.endsWith('\r\n'), `got ${JSON.stringify(out)}`);
      assert.equal(guard.check(source.lang, source.code, out).equivalent, true);
    });
  }

  it('an LF document keeps LF at the default eol', async () => {
    const code = '.a{color:red}\n.b{color:blue}\n';
    const out = await engine.format({
      languageId: 'css',
      code,
      options: resolved({ insertFinalNewline: true })
    });
    assert.equal(eolCounts(out).crlf, 0, `got ${JSON.stringify(out)}`);
    assert.ok(out.endsWith('\n'));
  });

  it('a MIXED-EOL document comes out consistent, never more mixed', async () => {
    const code = '.a{color:red}\r\n.b{color:blue}\n';
    const out = await engine.format({
      languageId: 'css',
      code,
      options: resolved({ insertFinalNewline: true })
    });
    const counts = eolCounts(out);
    assert.ok(
      counts.crlf === 0 || counts.bareLf === 0,
      `still mixed: ${JSON.stringify(out)}`
    );
  });

  it('an explicit endOfLine still wins over the document', async () => {
    const out = await engine.format({
      languageId: 'css',
      code: '.a{color:red}\n.b{color:blue}\n',
      options: resolved({ insertFinalNewline: true, endOfLine: 'crlf' })
    });
    assert.equal(eolCounts(out).bareLf, 0, `got ${JSON.stringify(out)}`);
    assert.ok(out.endsWith('\r\n'));
  });

  it('no opinion adds no final newline to a document that had none', async () => {
    // insertFinalNewline undefined must mean NO EDIT, in both directions.
    for (const code of [
      '.a{color:red}\r\n.b{color:blue}',
      '.a{color:red}\n.b{color:blue}'
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const out = await engine.format({
        languageId: 'css',
        code,
        options: resolved()
      });
      assert.ok(
        !/[\r\n]$/.test(out),
        `no opinion invented a final newline: ${JSON.stringify(out)}`
      );
      const counts = eolCounts(out);
      assert.ok(
        counts.crlf === 0 || counts.bareLf === 0,
        `mixed EOL: ${JSON.stringify(out)}`
      );
    }
  });

  it('insertFinalNewline false still strips it, CRLF document included', async () => {
    const out = await engine.format({
      languageId: 'css',
      code: '.a{color:red}\r\n',
      options: resolved({ insertFinalNewline: false })
    });
    assert.ok(!/[\r\n]$/.test(out), `got ${JSON.stringify(out)}`);
  });
});

/* -------------------------------------------------------------------------- */
/* M3-3 / G3-4 : a range never rewrites the slice's own edge whitespace         */
/* -------------------------------------------------------------------------- */
//
// js-beautify trims the edges of whatever slice it is handed. At selection scope
// the bytes on either side stay in the buffer, so the trim JOINS the slice to
// its neighbour: a selection whose last character is a line break came back one
// line shorter, the splice glued the next line on, and the following pass had a
// DIFFERENT slice to format. Measured before the fix: edits 1,1,1,1,1,1 with
// pass3 == pass5 and pass4 == pass6, in javascript, html, json AND css. The
// guard accepts every step because the change is whitespace-only, so this drifts
// WITHOUT BOUND against a README that promises format(format(x)) == format(x).

/** The bytes a range format actually wrote in place of [start, end). */
function writtenSpan(
  code: string,
  out: string,
  start: number,
  end: number
): string {
  const before = code.slice(0, start);
  const after = code.slice(end);
  assert.ok(out.startsWith(before), 'prefix must be preserved byte for byte');
  assert.ok(out.endsWith(after), 'suffix must be preserved byte for byte');
  return out.slice(before.length, out.length - after.length);
}

/** Offsets of whole lines [firstLine, lastLine], including the final EOL. */
function lineSpan(
  text: string,
  firstLine: number,
  lastLine: number
): { start: number; end: number } {
  const starts: number[] = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') {
      starts.push(i + 1);
    }
  }
  const start = starts[Math.min(firstLine, starts.length - 1)];
  const end = lastLine + 1 < starts.length ? starts[lastLine + 1] : text.length;
  return { start, end };
}

describe('engine/jsbeautify : a range keeps its own edge whitespace (M3-3, G3-4)', () => {
  const EDGE_CASES: ReadonlyArray<{
    lang: LangId;
    id: string;
    code: string;
    start: number;
    end: number;
  }> = [
    {
      lang: 'css',
      id: 'trailing line break',
      code: '.a{color:red}\n.b{color:blue}\n',
      start: 0,
      end: 14
    },
    {
      lang: 'javascript',
      id: 'trailing line break',
      code: 'const a={x:1};\nconst b=2;\n',
      start: 0,
      end: 15
    },
    {
      lang: 'html',
      id: 'trailing line break',
      code: '<div><p>a</p></div>\n<span>b</span>\n',
      start: 0,
      end: 20
    },
    {
      lang: 'json',
      id: 'trailing line break',
      code: '{"a":1,\n"b":2}\n',
      start: 0,
      end: 8
    },
    {
      lang: 'html',
      id: 'leading AND trailing space',
      code: '<p>hello <b>x</b> world</p>',
      start: 8,
      end: 18
    },
    {
      lang: 'css',
      id: 'leading indent and a trailing blank line',
      code: 'body{margin:0}\n  .a{color:red}\n\n.b{color:blue}\n',
      start: 15,
      end: 32
    },
    {
      lang: 'css',
      id: 'CRLF edges',
      code: '.a{color:red}\r\n.b{color:blue}\r\n',
      start: 0,
      end: 15
    }
  ];

  for (const edge of EDGE_CASES) {
    it(`${edge.lang} (${edge.id}): both runs come back byte for byte`, async () => {
      const slice = edge.code.slice(edge.start, edge.end);
      const wanted = splitSliceEdges(slice);
      const out = await engine.format({
        languageId: edge.lang,
        code: edge.code,
        options: resolved(),
        range: { startOffset: edge.start, endOffset: edge.end }
      });
      const written = writtenSpan(edge.code, out, edge.start, edge.end);
      const got = splitSliceEdges(written);
      assert.equal(
        got.leading,
        wanted.leading,
        `leading run changed: ${JSON.stringify(written)}`
      );
      assert.equal(
        got.trailing,
        wanted.trailing,
        `trailing run changed: ${JSON.stringify(written)}`
      );
    });
  }

  it('a slice that is nothing but whitespace is never touched', async () => {
    // In HTML that run IS a rendered space, so collapsing it changes what the
    // reader sees while the guard calls it equivalent.
    const code = '<p>hello <b>x</b> \n <i>y</i></p>';
    const start = code.indexOf('</b>') + '</b>'.length;
    const end = code.indexOf('<i>');
    assert.equal(code.slice(start, end).trim(), '', 'the fixture must be blank');
    const out = await engine.format({
      languageId: 'html',
      code,
      options: resolved(),
      range: { startOffset: start, endOffset: end }
    });
    assert.equal(out, code, `a blank slice was rewritten: ${JSON.stringify(out)}`);
  });

  it('the CONTENT of the slice is still really formatted', async () => {
    // The edge rule must never turn a range format into a silent no-op.
    const code = '.a{color:red}\n.b{color:blue}\n';
    const out = await engine.format({
      languageId: 'css',
      code,
      options: resolved({ tabSize: 2 }),
      range: { startOffset: 0, endOffset: 14 }
    });
    const written = writtenSpan(code, out, 0, 14);
    assert.ok(
      written.includes('color: red'),
      `not formatted: ${JSON.stringify(written)}`
    );
    assert.ok(written.endsWith('\n'), 'and the trailing break is still there');
  });
});

describe('engine/jsbeautify : a line-anchored range converges on pass 2 (M3-3)', () => {
  const FRAMINGS: ReadonlyArray<{
    lang: LangId;
    id: string;
    code: string;
    firstLine: number;
    lastLine: number;
  }> = [
    {
      lang: 'javascript',
      id: 'first line',
      code: 'const a={x:1};\nconst b=2;\n',
      firstLine: 0,
      lastLine: 0
    },
    {
      lang: 'javascript',
      id: 'inner line, framed both sides',
      code: 'let z=0;\nfunction f(){return 1;}\nlet w=1;\n',
      firstLine: 1,
      lastLine: 1
    },
    {
      lang: 'html',
      id: 'first line',
      code: '<div><p>a</p></div>\n<span>b</span>\n',
      firstLine: 0,
      lastLine: 0
    },
    {
      lang: 'html',
      id: 'inner line',
      code: '<header>h</header>\n<div><p>a</p></div>\n<footer>f</footer>\n',
      firstLine: 1,
      lastLine: 1
    },
    {
      lang: 'json',
      id: 'first line',
      code: '{"a":1,\n"b":2}\n',
      firstLine: 0,
      lastLine: 0
    },
    {
      lang: 'jsonc',
      id: 'first line with a comment below',
      code: '{"a":1,\n// keep\n"b":2}\n',
      firstLine: 0,
      lastLine: 0
    },
    {
      lang: 'css',
      id: 'first line',
      code: '.a{color:red}\n.b{color:blue}\n',
      firstLine: 0,
      lastLine: 0
    },
    {
      lang: 'css',
      id: 'inner line, framed both sides',
      code: 'body{margin:0}\n.a{color:red}\n.b{color:blue}\n',
      firstLine: 1,
      lastLine: 1
    },
    {
      lang: 'css',
      id: 'two lines at once',
      code: 'body{margin:0}\n.a{color:red}\n.b{color:blue}\n',
      firstLine: 0,
      lastLine: 1
    }
  ];

  for (const framing of FRAMINGS) {
    it(`${framing.lang} (${framing.id}): pass 2 onwards is a byte no-op`, async () => {
      let text = framing.code;
      const states: string[] = [];
      for (let pass = 0; pass < 6; pass += 1) {
        const span = lineSpan(text, framing.firstLine, framing.lastLine);
        // eslint-disable-next-line no-await-in-loop
        text = await engine.format({
          languageId: framing.lang,
          code: text,
          options: resolved(),
          range: { startOffset: span.start, endOffset: span.end }
        });
        states.push(text);
      }
      for (let pass = 1; pass < states.length; pass += 1) {
        assert.equal(
          states[pass],
          states[0],
          `pass ${pass + 1} drifted from the pass-1 fixed point: ` +
            `${JSON.stringify(states[0])} -> ${JSON.stringify(states[pass])}`
        );
      }
    });
  }
});
