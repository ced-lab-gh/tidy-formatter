// Adversarial CORRUPTION suite — the product's core safety promise, attacked.
//
// For EVERY language in the matrix (JS, JSX, TS, TSX, CSS, SCSS, LESS, HTML,
// JSON, JSONC) we feed the guard a clean input and a semantically CORRUPTED
// output that a broken formatter might produce, and assert the guard REJECTS it
// (equivalent === false) with a non-empty reason for the OutputChannel.
//
// The bar is intentionally high: many corrupted outputs are themselves valid
// syntax (marked `stillParses: true` in the fixtures), so a "re-parse only"
// guard would wrongly accept them. This suite is the empirical proof that the
// guard compares structure/values, not mere parseability (SPEC §5, §12).
//
// Conventions: mocha BDD + node:assert/strict. Fixtures live in
// test/fixtures/corruptionFixtures.ts so the data set is reusable and auditable.
import assert from 'node:assert/strict';
import { parse as babelParse } from '@babel/parser';
import { parse as parseCss } from 'postcss';
import { parse as parseScss } from 'postcss-scss';
import { parse as parseLess } from 'postcss-less';
import { parse as parseHtml } from 'parse5';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { guard } from '../../../src/safety/guard';
import type { LangId } from '../../../src/types';
import { corruptionFixtures, type CorruptionFixture } from '../../fixtures/corruptionFixtures';

// ---------------------------------------------------------------------------
// Independent "does this still parse?" oracle, so the `stillParses` flag in the
// fixtures is verified against the real parser rather than trusted blindly. This
// is what makes the must-reject assertions meaningful: when stillParses===true,
// a parse-only guard would accept the corruption.
// ---------------------------------------------------------------------------
function corruptedOutputParses(f: CorruptionFixture): boolean {
  try {
    switch (f.category) {
      case 'js':
      case 'jsx':
      case 'ts':
      case 'tsx':
        babelParse(f.output, {
          sourceType: 'unambiguous',
          allowReturnOutsideFunction: true,
          allowImportExportEverywhere: true,
          plugins: ['typescript', 'jsx', 'decorators-legacy']
        });
        return true;
      case 'css':
        parseCss(f.output);
        return true;
      case 'scss':
        parseScss(f.output);
        return true;
      case 'less':
        parseLess(f.output);
        return true;
      case 'html':
        parseHtml(f.output);
        return true; // parse5 is error-tolerant; only a thrown error counts as "no parse"
      case 'json':
      case 'jsonc': {
        const errors: ParseError[] = [];
        parseJsonc(f.output, errors, { allowTrailingComma: true });
        return errors.length === 0;
      }
      default:
        return false;
    }
  } catch {
    return false;
  }
}

describe('adversarial corruption — every corrupted output MUST be rejected', () => {
  it(`covers >= 24 corruption cases (actual: ${corruptionFixtures.length})`, () => {
    assert.ok(
      corruptionFixtures.length >= 24,
      `expected at least 24 corruption fixtures, found ${corruptionFixtures.length}`
    );
  });

  it('every fixture id is unique (no accidental duplicate)', () => {
    const ids = corruptionFixtures.map((f) => f.id);
    assert.equal(new Set(ids).size, ids.length, 'duplicate fixture ids found');
  });

  it('covers all nine matrix languages', () => {
    const langs = new Set<LangId>(corruptionFixtures.map((f) => f.lang));
    for (const lang of [
      'javascript',
      'javascriptreact',
      'typescript',
      'typescriptreact',
      'css',
      'scss',
      'less',
      'html',
      'json',
      'jsonc'
    ] as LangId[]) {
      assert.ok(langs.has(lang), `no corruption fixture for language '${lang}'`);
    }
  });

  for (const f of corruptionFixtures) {
    it(`${f.id} [${f.category}]: ${f.desc}`, () => {
      const verdict = guard.check(f.lang, f.input, f.output);

      // 1) The corruption MUST be rejected.
      assert.equal(
        verdict.equivalent,
        false,
        `guard ACCEPTED a corruption (${f.id}); this is a false negative — the file's ` +
          `meaning would change silently`
      );

      // 2) A rejection MUST carry a non-empty reason for the OutputChannel.
      assert.ok(
        typeof verdict.reason === 'string' && verdict.reason.length > 0,
        `rejection must include a non-empty reason (${f.id})`
      );

      // 3) The reason must never leak the source code (SPEC §9: "jamais le contenu").
      //    We spot-check a couple of identifier/value tokens unlikely to be parser
      //    boilerplate.
      const reason = verdict.reason as string;
      assert.ok(!reason.includes('evil.html'), `reason leaked source (${f.id})`);
      assert.ok(!reason.includes('secondary'), `reason leaked source (${f.id})`);

      // 4) Consistency check: the fixture's `stillParses` claim matches reality.
      //    When true, this case proves a parse-only guard would have accepted it.
      const actuallyParses = corruptedOutputParses(f);
      assert.equal(
        actuallyParses,
        f.stillParses,
        `fixture ${f.id} declares stillParses=${f.stillParses} but the corrupted ` +
          `output actually ${actuallyParses ? 'parses' : 'does NOT parse'}`
      );
    });
  }
});

describe('adversarial corruption — the parse-only-guard trap (SPEC §5)', () => {
  // The whole reason the guard is structural: a meaningful subset of corruptions
  // re-parse cleanly. If a guard only re-parsed, it would ship them. Prove that
  // this trap class is non-empty and large, and that the guard still rejects all.
  const stillParsingCorruptions = corruptionFixtures.filter((f) => f.stillParses);

  it('has many corruptions that re-parse yet must be rejected (defeats parse-only guards)', () => {
    assert.ok(
      stillParsingCorruptions.length >= 20,
      `expected >= 20 still-parsing corruptions, found ${stillParsingCorruptions.length}`
    );
  });

  for (const f of stillParsingCorruptions) {
    it(`${f.id}: re-parses but is rejected on structure/value, not parseability`, () => {
      assert.equal(corruptedOutputParses(f), true, `${f.id} should still parse`);
      const verdict = guard.check(f.lang, f.input, f.output);
      assert.equal(verdict.equivalent, false, `${f.id} must be rejected despite parsing`);
    });
  }
});

describe('adversarial corruption — the mandatory acceptance test (SPEC §5, verbatim)', () => {
  it('rejects < Foo bar = {x} /> even though it re-parses as valid TSX', () => {
    const input = 'const el = <Foo bar={x} />;';
    const mangled = 'const el = < Foo bar = {x} />;';

    // Prove the mangled form really does re-parse (otherwise the test is trivial).
    assert.doesNotThrow(() =>
      babelParse(mangled, {
        sourceType: 'unambiguous',
        plugins: ['typescript', 'jsx', 'decorators-legacy']
      })
    );

    const verdict = guard.check('typescriptreact', input, mangled);
    assert.equal(verdict.equivalent, false, verdict.reason);
    assert.match(verdict.reason ?? '', /JSX tag boundaries/);
  });
});

describe('adversarial corruption — false-positive guardrail (do NOT over-reject)', () => {
  // The corruption guard must stay sharp without becoming paranoid: a pure
  // whitespace reformat that preserves meaning must be ACCEPTED. If these start
  // failing, the guard has been tightened into a "safe but does nothing" no-op
  // (the SPEC §12 false-positive failure mode) and is no longer trustworthy.
  it('accepts a pure-whitespace JS reformat (no corruption present)', () => {
    const v = guard.check('javascript', 'const r=total/count;', 'const r = total / count;\n');
    assert.equal(v.equivalent, true, v.reason);
  });

  it('accepts a legitimate multi-line JSX reflow (tag boundaries intact)', () => {
    const input = 'const el = <Foo a={1} b={2} c={3} />;';
    const output = 'const el = (\n  <Foo\n    a={1}\n    b={2}\n    c={3}\n  />\n);';
    const v = guard.check('typescriptreact', input, output);
    assert.equal(v.equivalent, true, v.reason);
  });

  it('accepts CSS combinator tightening #a > #b -> #a>#b (same selector)', () => {
    const v = guard.check('css', '#a > #b {\n  color: red;\n}', '#a>#b{color:red}');
    assert.equal(v.equivalent, true, v.reason);
  });
});
