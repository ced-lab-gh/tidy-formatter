// Unit tests for the Prettier engine adapter's stylistic options (Axe 3.T4).
//
// Each AST-invariant stylistic option the engine CONSUMES (printWidth, semi,
// singleQuote, jsxSingleQuote, trailingComma, bracketSpacing, bracketSameLine,
// arrowParens) is exercised twice:
//   (1) EFFECT: toggling it changes Prettier's printed output;
//   (2) SAFETY: guard.check(lang, input, output).equivalent === true for BOTH
//       toggle states : the on-the-spot PROOF that the equivalence guard
//       (semantic-equivalence-modulo-whitespace/style) accepts every stylistic
//       change because none of them alter the babel AST (semicolons, quote style,
//       trailing commas, and sole-arrow-param parens all canonicalise away).
// `quoteProps` is the deliberate EXCLUSION: it would flip an object key's AST node
// (Identifier ⇔ StringLiteral), which the guard rejects, so the engine must NOT
// consume it. A negative test below locks that exclusion in.
// Layout knobs (tabWidth/useTabs/endOfLine) are covered by existing tests.
import assert from 'node:assert/strict';
import { PrettierEngine } from '../../../src/engine/prettier';
import { guard } from '../../../src/safety/guard';
import { guardCheckNoFastPath } from '../../helpers/guardCheck';
import { resolved } from '../../helpers/options';
import type { LangId } from '../../../src/types';

const engine = new PrettierEngine();

function withPrettier(bag: Record<string, unknown>) {
  return resolved({ engineOptions: { prettier: bag } });
}

async function fmt(code: string, bag: Record<string, unknown>, lang: LangId = 'typescript') {
  return engine.format({ languageId: lang, code, options: withPrettier(bag) });
}

/**
 * Assert the guard accepts a formatted output as equivalent to its input, with a
 * readable failure message that surfaces the rejection reason. This is the SAFETY
 * half of every effect test: proof that exposing the option can never let Tidy
 * corrupt a file nor become a silent no-op (the guard would otherwise reject the
 * write, leaving the file untouched).
 */
function assertGuardEquivalent(lang: LangId, input: string, output: string, label: string): void {
  // guardCheckNoFastPath: for an input already written in one of the two
  // styles, that style's output equals the input and guard.check would answer
  // without parsing anything.
  const verdict = guardCheckNoFastPath(lang, input, output);
  assert.equal(
    verdict.equivalent,
    true,
    `${label}: guard rejected the stylistic output (${verdict.reason ?? 'no reason'})`
  );
}

describe('engine/prettier : supported languages', () => {
  it('supports ts/tsx/jsx and js (JSX fallback)', () => {
    for (const lang of ['typescript', 'typescriptreact', 'javascriptreact', 'javascript'] as const) {
      assert.ok(engine.supports(lang));
    }
  });
});

describe('engine/prettier : stylistic option effects (each changes output)', () => {
  it('semi=false drops trailing semicolons', async () => {
    const input = 'const a = 1';
    const withSemi = await fmt(input, { semi: true });
    const noSemi = await fmt(input, { semi: false });
    assert.ok(withSemi.includes(';'), `expected semi, got ${JSON.stringify(withSemi)}`);
    assert.ok(!noSemi.trim().endsWith(';'), `expected no semi, got ${JSON.stringify(noSemi)}`);
    assert.notEqual(withSemi, noSemi);
    // SAFETY: dropping/adding semicolons is AST-invariant under the guard.
    assertGuardEquivalent('typescript', input, withSemi, 'semi=true');
    assertGuardEquivalent('typescript', input, noSemi, 'semi=false');
  });

  it('singleQuote=true uses single quotes', async () => {
    const input = 'const a = "x";';
    const dbl = await fmt(input, { singleQuote: false });
    const sgl = await fmt(input, { singleQuote: true });
    assert.ok(dbl.includes('"x"'));
    assert.ok(sgl.includes("'x'"));
    assert.notEqual(dbl, sgl);
    // SAFETY: quote style lives in `extra.raw`, stripped by the guard.
    assertGuardEquivalent('typescript', input, dbl, 'singleQuote=false');
    assertGuardEquivalent('typescript', input, sgl, 'singleQuote=true');
  });

  it('jsxSingleQuote=true uses single quotes in JSX attributes', async () => {
    const code = 'const a = <div className="x" />;';
    const dbl = await fmt(code, { jsxSingleQuote: false }, 'typescriptreact');
    const sgl = await fmt(code, { jsxSingleQuote: true }, 'typescriptreact');
    assert.ok(dbl.includes('className="x"'));
    assert.ok(sgl.includes("className='x'"));
    assert.notEqual(dbl, sgl);
    // SAFETY: JSX attribute quote style is AST-invariant AND must keep tag
    // boundaries intact (jsxBoundaryFingerprint) : the guard checks both.
    assertGuardEquivalent('typescriptreact', code, dbl, 'jsxSingleQuote=false');
    assertGuardEquivalent('typescriptreact', code, sgl, 'jsxSingleQuote=true');
  });

  it('trailingComma=none vs all changes multi-line trailing commas', async () => {
    const code = 'const o = {\n  a: 1,\n  b: 2\n};';
    const none = await fmt(code, { trailingComma: 'none' });
    const all = await fmt(code, { trailingComma: 'all' });
    assert.notEqual(none, all);
    assert.ok(!/2,\n\}/.test(none), 'none: no trailing comma');
    assert.ok(/2,\n\}/.test(all), 'all: trailing comma present');
    // SAFETY: a trailing comma is punctuation only : same object AST.
    assertGuardEquivalent('typescript', code, none, 'trailingComma=none');
    assertGuardEquivalent('typescript', code, all, 'trailingComma=all');
  });

  it('bracketSpacing=false removes spaces inside object braces', async () => {
    const input = 'const o = {a: 1};';
    const on = await fmt(input, { bracketSpacing: true });
    const off = await fmt(input, { bracketSpacing: false });
    assert.ok(on.includes('{ a: 1 }'));
    assert.ok(off.includes('{a: 1}'));
    assert.notEqual(on, off);
    // SAFETY: interior brace spacing is pure whitespace.
    assertGuardEquivalent('typescript', input, on, 'bracketSpacing=true');
    assertGuardEquivalent('typescript', input, off, 'bracketSpacing=false');
  });

  it('arrowParens=avoid drops parens around a single param', async () => {
    const input = 'const f = x => x;';
    const always = await fmt(input, { arrowParens: 'always' });
    const avoid = await fmt(input, { arrowParens: 'avoid' });
    assert.ok(always.includes('(x)'));
    assert.ok(!avoid.includes('(x)'));
    assert.notEqual(always, avoid);
    // SAFETY: the parens are syntactic grouping only : same arrow-function AST.
    assertGuardEquivalent('typescript', input, always, 'arrowParens=always');
    assertGuardEquivalent('typescript', input, avoid, 'arrowParens=avoid');
  });

  it('printWidth controls wrapping', async () => {
    const code = 'const result = aaaaa + bbbbb + ccccc + ddddd + eeeee + fffff + ggggg;';
    const wide = await fmt(code, { printWidth: 200 });
    const narrow = await fmt(code, { printWidth: 20 });
    assert.ok(!wide.includes('\n  '), 'wide stays on one line');
    assert.ok(narrow.includes('\n'), 'narrow wraps');
    assert.notEqual(wide, narrow);
    // SAFETY: wrapping only inserts whitespace/newlines : same expression AST.
    assertGuardEquivalent('typescript', code, wide, 'printWidth=200');
    assertGuardEquivalent('typescript', code, narrow, 'printWidth=20');
  });

  it('bracketSameLine affects JSX closing > placement (non-self-closing element)', async () => {
    // bracketSameLine only moves the `>` of an element with children onto the
    // last attribute line; a self-closing `/>` has no `>` to move.
    const code =
      'const a = <div className="a-very-long-class" dataX="another-long-attribute-value-here" id="z">child</div>;';
    const off = await fmt(code, { bracketSameLine: false, printWidth: 40 }, 'typescriptreact');
    const on = await fmt(code, { bracketSameLine: true, printWidth: 40 }, 'typescriptreact');
    assert.notEqual(off, on);
    // SAFETY: moving the closing `>` is whitespace reflow; the guard's JSX
    // boundary check tolerates a split closing `>` (only a detached OPEN `<` is
    // corruption), so both variants stay equivalent.
    assertGuardEquivalent('typescriptreact', code, off, 'bracketSameLine=false');
    assertGuardEquivalent('typescriptreact', code, on, 'bracketSameLine=true');
  });
});

describe('engine/prettier : quoteProps is deliberately NOT consumed (AST-changing)', () => {
  // quoteProps is the one Prettier "quote" option that is NOT AST-invariant:
  // quoting an object key turns its babel node from Identifier into StringLiteral,
  // a STRUCTURAL change the equivalence guard rejects. The engine must therefore
  // never pass it to Prettier (optionCatalog.ts / package.json also omit it).
  it('ignores a requested quoteProps value (key stays Prettier-default unquoted)', async () => {
    const code = 'const o = { a: 1, "b-c": 2 };';
    // Even when the user forces quoteProps:"consistent" (which, if applied, would
    // quote `a` to match `"b-c"`), the engine drops it and Prettier keeps its
    // default as-needed behaviour, leaving `a` unquoted.
    const out = await fmt(code, { quoteProps: 'consistent' });
    assert.ok(!/"a"\s*:/.test(out), `quoteProps must not be applied, got ${JSON.stringify(out)}`);
    assert.ok(/\ba\s*:/.test(out), 'identifier key must remain unquoted');
    // And the engine's output is itself guard-equivalent to the input (no-op safe).
    assertGuardEquivalent('typescript', code, out, 'quoteProps ignored');
  });

  it('the guard WOULD reject key-quoting : proving why quoteProps is excluded', () => {
    // This is the contrapositive: a hypothetical formatter that quoted keys
    // (what quoteProps:"consistent"/"as-needed"→all could do) produces a
    // non-equivalent AST, so exposing quoteProps could silently no-op the engine.
    const unquoted = 'const o = { a: 1 };';
    const quoted = 'const o = { "a": 1 };';
    const verdict = guard.check('typescript', unquoted, quoted);
    assert.equal(verdict.equivalent, false, 'quoting an identifier key must be rejected');
  });
});

describe('engine/prettier : invalid stylistic values are ignored (not propagated)', () => {
  it('ignores a non-boolean semi and an out-of-enum trailingComma', async () => {
    const out = await fmt('const a = 1', {
      semi: 'yes',
      trailingComma: 'banana',
      arrowParens: 42
    });
    // Falls back to Prettier defaults (semi on), proving the bad values were dropped.
    assert.ok(out.includes(';'));
  });

  it('ignores a non-object prettier bag without throwing', async () => {
    const out = await engine.format({
      languageId: 'typescript',
      code: 'const a=1;',
      options: resolved({ engineOptions: { prettier: 'not-an-object' } })
    });
    assert.ok(out.includes('const a = 1;'));
  });
});

// LOW-03 and C-15 at the engine seam. The LAYER-ORDER half of the width fix lives
// in the resolver (test/unit/config/resolverWidth.test.ts); this block locks what
// the adapter does with the ONE width it is handed.
describe('engine/prettier : the print width (LOW-03, C-15)', () => {
  // 96 characters on one line: over Prettier's default of 80, under 120.
  const LONG =
    'const aVeryLongVariableName = someFunctionCall(argumentOne, argumentTwo, argumentThree, argFour);\n';
  const lines = (text: string): number => text.split('\n').filter((l) => l !== '').length;

  async function withEngineOptions(
    engineOptions: Record<string, unknown>,
    lang: LangId = 'typescript',
    code: string = LONG
  ): Promise<string> {
    return engine.format({ languageId: lang, code, options: resolved({ engineOptions }) });
  }

  it('an UNSET width keeps Prettier default of 80 (no opinion is not a choice)', async () => {
    assert.ok(lines(await withEngineOptions({})) > 1, 'a 96-character line wraps at 80');
  });

  it('an explicit wrap_line_length of 0 means "do not wrap", as the setting says', async () => {
    const out = await withEngineOptions({ wrap_line_length: 0 });
    assert.equal(lines(out), 1, 'the line stays whole: 0 disables wrapping');
    assertGuardEquivalent('typescript', LONG, out, 'wrap_line_length=0');
  });

  it('the same holds for TSX and JSX', async () => {
    const tsx = `${LONG}export const A = () => <div>{aVeryLongVariableName}</div>;\n`;
    for (const lang of ['typescriptreact', 'javascriptreact'] as const) {
      const out = await withEngineOptions({ wrap_line_length: 0 }, lang, tsx);
      assert.ok(
        out.split('\n').every((l) => l.length <= 100),
        `${lang}: no line was cut`
      );
      assert.ok(out.includes('someFunctionCall(argumentOne, argumentTwo, argumentThree, argFour)'));
    }
  });

  it('a positive wrap_line_length still maps to printWidth', async () => {
    assert.equal(lines(await withEngineOptions({ wrap_line_length: 120 })), 1);
    assert.ok(lines(await withEngineOptions({ wrap_line_length: 40 })) > 1);
  });

  it('the unified width the resolver produces is applied verbatim, unbounded included', async () => {
    const unbounded = await withEngineOptions({ prettier: { printWidth: Number.POSITIVE_INFINITY } });
    assert.equal(lines(unbounded), 1);
    assert.equal(lines(await withEngineOptions({ prettier: { printWidth: 120 } })), 1);
    assert.ok(lines(await withEngineOptions({ prettier: { printWidth: 40 } })) > 1);
  });

  it('an option bag that skipped the resolver still lets prettier.printWidth beat the shared key', async () => {
    // Direct callers (this suite, the CSS fallback) hand over one flat bag with
    // both keys and no layer information; the Prettier key is the more specific.
    const out = await withEngineOptions({ wrap_line_length: 40, prettier: { printWidth: 200 } });
    assert.equal(lines(out), 1);
  });

  it('a prettier.printWidth of 0 or below is not a width and is dropped', async () => {
    for (const bad of [0, -3, 2.5, '80']) {
      const out = await withEngineOptions({ prettier: { printWidth: bad } });
      assert.ok(lines(out) > 1, `printWidth ${String(bad)} falls back to Prettier default of 80`);
    }
  });

  it('the CSS fallback honours wrap_line_length 0 the same way', async () => {
    const css = '.sel{transition:opacity 0.3s ease-in-out,transform 0.3s ease-in-out;grid-template-columns:[full-start] minmax(1em,1fr) [main-start] minmax(0,40em) [main-end] minmax(1em,1fr) [full-end]}';
    const unset = await withEngineOptions({}, 'css', css);
    const unbounded = await withEngineOptions({ wrap_line_length: 0 }, 'css', css);
    assert.notEqual(unset, unbounded, '0 must no longer fall through to the default of 80');
    assert.ok(
      unbounded.split('\n').every((l) => !/\[full-start\].*\[full-end\]/.test(l) || l.length > 80),
      'the grid line is allowed past 80 columns'
    );
    assert.equal(guard.check('css', css, unbounded).equivalent, true);
  });
});
