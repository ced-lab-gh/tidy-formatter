// COMPLEX JS / TS / JSX / TSX acceptance suite.
//
// Adversarial counterpart to the guard's anti-corruption corpus: instead of
// proving the guard REJECTS mangled output, this proves the guard does NOT
// false-positive on the hard, real-world modern syntax the incumbent corrupted.
//
// For every fixture we drive the REAL dispatcher (prettier for ts/tsx/jsx,
// js-beautify for plain js) and assert four properties:
//   1. ACCEPT     — guard.check(lang, input, output).equivalent === true
//   2. PRESERVE   — the load-bearing tokens survive verbatim (e.g. `<T extends`,
//                   `?.`, `1_000`, `10n`, `#x`, `{...p}`)
//   3. RE-PARSE   — the formatted output parses again as the same language
//                   (guard.check(lang, output, output) is trivially equivalent,
//                   and a re-format does not throw)
//   4. IDEMPOTENT — format(format(x)) === format(x) (SPEC SAFE-03)
//
// SPEC refs: ENG-01/ENG-02 (modern syntax), SAFE-01/§12 (no guard false
// positive), SAFE-03 (idempotence).
import assert from 'node:assert/strict';
import { dispatchFormat } from '../../../src/engine/dispatcher';
import { guard } from '../../../src/safety/guard';
import {
  complexAcceptFixtures,
  complexKnownBugFixtures
} from '../../fixtures/complex/jsTsJsx';
import { resolved } from '../../helpers/options';
import type { LangId } from '../../../src/types';

const OPTS = resolved();

async function format(lang: LangId, code: string): Promise<string> {
  return dispatchFormat({ languageId: lang, code, options: OPTS });
}

describe('complex JS/TS/JSX/TSX — accept + preserve + re-parse + idempotence', () => {
  for (const f of complexAcceptFixtures) {
    describe(`${f.id}: ${f.desc} [${f.ref}]`, () => {
      it('formats, the guard accepts it, and the tokens survive', async () => {
        const out = await format(f.lang, f.input);

        // 2. PRESERVE — the exact tokens lonefy corrupted must survive verbatim.
        for (const needle of f.mustContain) {
          assert.ok(
            out.includes(needle),
            `expected output to preserve "${needle}", got:\n${out}`
          );
        }

        // 1. ACCEPT — a correct format must NOT be rejected by the guard.
        const verdict = guard.check(f.lang, f.input, out);
        assert.equal(
          verdict.equivalent,
          true,
          `guard false-positive rejected a correct format: ${verdict.reason ?? ''}`
        );
      });

      it('re-parses: re-formatting the output does not throw and stays equivalent', async () => {
        const out = await format(f.lang, f.input);
        // Output must be valid in its own right: re-running the engine on it must
        // not throw (a parse failure on the formatter's own output is a bug).
        const reformatted = await format(f.lang, out);
        // And the output compared against itself is trivially equivalent — this
        // exercises the guard parse path on the FORMATTED text (re-parse check).
        const selfVerdict = guard.check(f.lang, out, out);
        assert.equal(selfVerdict.equivalent, true, selfVerdict.reason ?? '');
        // The reformatted text must still satisfy the guard vs the original.
        const roundVerdict = guard.check(f.lang, f.input, reformatted);
        assert.equal(
          roundVerdict.equivalent,
          true,
          `re-formatted output diverged: ${roundVerdict.reason ?? ''}`
        );
      });

      it('is idempotent: format(format(x)) === format(x)', async () => {
        const first = await format(f.lang, f.input);
        const second = await format(f.lang, first);
        assert.equal(second, first, `second pass drifted for ${f.id}`);
      });
    });
  }
});

describe('complex JS/TS/JSX/TSX — load-bearing guard sanity', () => {
  it('the corpus is large (>=25 distinct accept fixtures)', () => {
    assert.ok(
      complexAcceptFixtures.length >= 25,
      `expected >=25 complex accept fixtures, got ${complexAcceptFixtures.length}`
    );
  });

  it('every fixture id is unique', () => {
    const ids = complexAcceptFixtures.map((f) => f.id);
    assert.equal(new Set(ids).size, ids.length, 'duplicate fixture id detected');
  });

  it('a deliberately mangled JSX tag is still rejected (guard not neutered)', () => {
    // Sanity that ACCEPT-ing the hard corpus did not require loosening the guard:
    // the SPEC's mandated lonefy corruption `< Foo bar = {x} />` (which still
    // re-parses as valid TSX) must still fail via the JSX boundary fingerprint.
    const verdict = guard.check(
      'typescriptreact',
      '<Foo bar={x} />;',
      '< Foo bar = {x} />;'
    );
    assert.equal(verdict.equivalent, false);
  });
});

// --- FIXED guard false positives (were it.skip) -----------------------------
// These are VALID modern syntax that the guard used to REJECT because its
// @babel/parser plugin set was incomplete. Fixed by adding 'decoratorAutoAccessors'
// to the guard's plugins (src/safety/guard.ts), so the auto-accessor input now
// parses and a correct format is accepted instead of being silently no-op'd.
describe('complex JS/TS/JSX/TSX — modern syntax the guard now accepts (was a false positive)', () => {
  for (const f of complexKnownBugFixtures) {
    it(`${f.id}: ${f.desc} [${f.ref}] — guard accepts valid syntax`, async () => {
      const out = await format(f.lang, f.input);
      for (const needle of f.mustContain) {
        assert.ok(out.includes(needle), `expected "${needle}" in:\n${out}`);
      }
      const verdict = guard.check(f.lang, f.input, out);
      assert.equal(
        verdict.equivalent,
        true,
        `guard rejected valid accessor syntax: ${verdict.reason ?? ''}`
      );
    });
  }
});
