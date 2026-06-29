// Property / light-fuzz harness (SPEC QA-01, QA-06, SAFE-01/02/03).
//
// For EACH valid snippet in the corpus (test/fixtures/corpus.ts), across a set
// of DETERMINISTIC index-seeded perturbations (no Math.random), we assert three
// invariants that together encode the safety core of the product:
//
//   I1  (the load-bearing one): the safety guard must accept the engine's output.
//       out = dispatchFormat(req); guard.check(lang, input, out).equivalent === true
//       A failure means EITHER a guard false-positive (it rejects a correct
//       output, the "safe but does nothing" frustration) OR a real engine
//       corruption (it changed meaning) — both are reportable bugs. This is the
//       invariant that would have caught the `< Foo bar = {x} />` JSX class.
//
//   I2  Idempotence (SAFE-03): dispatchFormat(out) === out, byte-for-byte. Catches
//       the "code creeps right / re-formats differently on every save" drift.
//
//   I3  Re-parse: the formatted OUTPUT parses cleanly under the SAME strict
//       parsers the guard uses (not just under js-beautify's lenient pass). Proves
//       the formatter never emits syntactically broken text.
//
// Conventions: mocha BDD + node:assert/strict, pure modules (no 'vscode' import),
// run with:  npx mocha --require tsx 'test/unit/property/**/*.test.ts'
import assert from 'node:assert/strict';
import { parse as babelParse } from '@babel/parser';
import { parse as parseCss } from 'postcss';
import { parse as parseScss } from 'postcss-scss';
import { parse as parseLess } from 'postcss-less';
import { parse as parseHtml, parseFragment as parseHtmlFragment } from 'parse5';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { dispatchFormat } from '../../../src/engine/dispatcher';
import { guard } from '../../../src/safety/guard';
import type { LangId, ResolvedOptions } from '../../../src/types';
import { corpus, perturb, ALL_LANGS, type CorpusSnippet } from '../../fixtures/corpus';

// Simple, fixed options shared by every property case.
const OPTS: ResolvedOptions = {
  tabSize: 2,
  insertSpaces: true,
  engineOptions: {},
  sources: {}
};

// Number of deterministic perturbations per snippet (see corpus.perturb).
const VARIANTS = 4;

/**
 * Independent re-parse of formatted output using the guard's reference parsers.
 * Throws if the output does not parse — this is the substance of I3 and is fully
 * independent of the (lenient) js-beautify pass that produced the output.
 */
function reparse(lang: LangId, code: string): void {
  switch (lang) {
    case 'javascript':
    case 'javascriptreact':
    case 'typescript':
    case 'typescriptreact':
      babelParse(code, {
        sourceType: 'unambiguous',
        allowReturnOutsideFunction: true,
        allowImportExportEverywhere: true,
        errorRecovery: false,
        plugins: ['typescript', 'jsx', 'decorators-legacy']
      });
      return;
    case 'css':
      parseCss(code);
      return;
    case 'scss':
      (parseScss as unknown as (c: string) => unknown)(code);
      return;
    case 'less':
      (parseLess as unknown as (c: string) => unknown)(code);
      return;
    case 'html':
      if (/<(!doctype|html)\b/i.test(code)) {
        parseHtml(code);
      } else {
        parseHtmlFragment(code);
      }
      return;
    case 'json':
    case 'jsonc': {
      const errors: ParseError[] = [];
      parseJsonc(code, errors, { allowTrailingComma: true, disallowComments: false });
      if (errors.length > 0) {
        throw new Error(`jsonc reported ${errors.length} parse error(s)`);
      }
      return;
    }
    default: {
      const exhaustive: never = lang;
      throw new Error(`no reparse strategy for '${String(exhaustive)}'`);
    }
  }
}

describe('property — corpus coverage', () => {
  it('covers every one of the 10 supported languageIds', () => {
    const present = new Set(corpus.map((s) => s.lang));
    for (const lang of ALL_LANGS) {
      assert.ok(present.has(lang), `corpus is missing any snippet for '${lang}'`);
    }
  });

  it('has at least 40 snippets', () => {
    assert.ok(corpus.length >= 40, `expected >= 40 snippets, got ${corpus.length}`);
  });

  it('uses unique snippet ids', () => {
    const ids = corpus.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length, 'duplicate snippet id detected');
  });
});

describe('property — invariants over corpus x deterministic perturbations', () => {
  corpus.forEach((snippet: CorpusSnippet, snippetIndex: number) => {
    for (let v = 0; v < VARIANTS; v += 1) {
      // The variant index folds in the snippet index so the perturbation stream
      // differs across snippets while remaining fully deterministic.
      const variantSeed = snippetIndex + v;
      const input = perturb(snippet.code, variantSeed);
      const label = `${snippet.id} v${v} [${snippet.lang}] — ${snippet.note}`;

      describe(label, () => {
        let output: string;
        let secondPass: string;

        before(async () => {
          output = await dispatchFormat({
            languageId: snippet.lang,
            code: input,
            options: OPTS
          });
          secondPass = await dispatchFormat({
            languageId: snippet.lang,
            code: output,
            options: OPTS
          });
        });

        // I1 — the safety guard must accept the formatter's own output.
        it('I1: guard.check(lang, input, output).equivalent === true', () => {
          const verdict = guard.check(snippet.lang, input, output);
          assert.equal(
            verdict.equivalent,
            true,
            `guard rejected a valid format (false-positive OR corruption): ${verdict.reason}`
          );
        });

        // I2 — idempotence: the second pass is a byte-for-byte no-op.
        it('I2: dispatchFormat(output) === output (idempotent)', () => {
          assert.equal(secondPass, output, 'second pass drifted (non-idempotent)');
        });

        // I3 — the output re-parses under the strict reference parsers.
        it('I3: formatted output re-parses without error', () => {
          assert.doesNotThrow(
            () => reparse(snippet.lang, output),
            'formatted output failed to re-parse'
          );
        });
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Real bugs discovered by this harness, now FIXED in the Fix phase. Each is a
// TIGHT reproduction that is asserted to pass after the corresponding src/ fix.
// ---------------------------------------------------------------------------
describe('property — previously-quarantined bugs (now fixed)', () => {
  // FIXED (guard false-positive I1): postcss-less parses a COMPACT LESS variable
  // declaration `@c:red` as an atrule named "c:red" with no params, but the
  // SPACED form `@c: red` (which js-beautify emits) as a variable atrule named
  // "c" with params "red". src/safety/guard.ts now canonicalises the LESS
  // variable at-rule (normalizeLessVariableAtRule) so both forms converge and a
  // common `@var:value` style is no longer no-op'd. A real value/name change is
  // still rejected (covered in css.complex.test.ts).
  it('BUG-LESS-VAR: compact `@c:red` LESS variable is accepted by guard', async () => {
    const input = '@c:red;.a{color:@c}';
    const output = await dispatchFormat({ languageId: 'less', code: input, options: OPTS });
    const verdict = guard.check('less', input, output);
    assert.equal(verdict.equivalent, true, verdict.reason);
  });

  // FIXED (guard false-positive I1): the JS-family guard used to enable the babel
  // `jsx` plugin for ALL ts-family files. In `jsx` mode, a legacy TypeScript
  // angle-bracket cast `<T>expr` is ambiguous with a JSX element and fails to
  // parse, no-op'ing a valid `.ts` file. src/safety/guard.ts now parses plain
  // `typescript` WITHOUT the `jsx` plugin (babelPluginsFor), so the cast parses.
  it('BUG-TS-ANGLE-CAST: legacy `<T>expr` cast in .ts is accepted by guard', async () => {
    const input = 'const c = <readonly number[]>[1, 2];';
    const output = await dispatchFormat({ languageId: 'typescript', code: input, options: OPTS });
    const verdict = guard.check('typescript', input, output);
    assert.equal(verdict.equivalent, true, verdict.reason);
  });

  // FIXED (non-idempotence I2, SAFE-03): js-beautify is NOT idempotent for JSONC
  // when a block comment shares a line with the following key (`/* c */ "key"`):
  // pass 1 keeps it inline, pass 2 moves it to its own line. The jsbeautify
  // adapter now runs JSON/JSONC to a FIXED POINT (beautifyToFixedPoint), so the
  // first format already emits the stable form and there is no save-to-save drift.
  it('BUG-JSONC-INLINE-COMMENT: inline block comment before key is now idempotent', async () => {
    const input = `{"compilerOptions":{"strict":true,/* c */ "target":"ES2022"},"include":["src",]}`;
    const first = await dispatchFormat({ languageId: 'jsonc', code: input, options: OPTS });
    const second = await dispatchFormat({ languageId: 'jsonc', code: first, options: OPTS });
    assert.equal(second, first, 'JSONC formatting drifted on the second pass');
  });
});
