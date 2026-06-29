// CSS-in-JS / embedded-foreign-language template-literal suite.
//
// Files written in TS/TSX that embed a FOREIGN language inside a tagged (or
// member-call) template literal: styled-components (styled.div``, styled(Base)``,
// styled.button.attrs(...)``), css``, createGlobalStyle``, lit-html (html``),
// GraphQL (gql``), SQL (sql``).
//
// The point of this suite is the SECURITY of the guard on polyglot files, where a
// single document mixes two grammars. Prettier (no CSS-in-JS plugin) reformats
// the JS/TS wrapper but leaves the embedded template body byte-identical, and to
// the JS AST a template quasi is an opaque string. So:
//
//   ACCEPT half — for every fixture we drive the REAL dispatcher and assert:
//     1. ACCEPT      — guard.check(lang, input, output).equivalent === true
//     2. PRESERVE    — the embedded template body survives VERBATIM (byte-for-byte
//                      substrings pinned per fixture), proving the foreign code is
//                      not reflowed
//     3. REFORMATTED — the surrounding JS/TS WAS reformatted (so the test is not a
//                      vacuous no-op pass)
//     4. RE-PARSE    — re-formatting the output does not throw and stays equivalent
//     5. IDEMPOTENT  — format(format(x)) === format(x) (SPEC SAFE-03)
//
//   CORRUPTION half — if a (hypothetical broken) engine changes the JS around the
//   template OR alters the embedded template body (even whitespace-only), the
//   guard MUST reject it. Proves the guard does not blindly trust template text.
//
// SPEC refs: SAFE-01 (AST equivalence, §12 "faux positif"/"faux négatif"),
// SAFE-03 (idempotence), ENG-02 (template literals not corrupted).
import assert from 'node:assert/strict';
import { dispatchFormat } from '../../../src/engine/dispatcher';
import { guard } from '../../../src/safety/guard';
import {
  cssInJsAcceptFixtures,
  cssInJsCorruptionFixtures
} from '../../fixtures/polyglot/cssInJs';
import { resolved } from '../../helpers/options';
import type { LangId } from '../../../src/types';

const OPTS = resolved();

async function format(lang: LangId, code: string): Promise<string> {
  return dispatchFormat({ languageId: lang, code, options: OPTS });
}

describe('polyglot CSS-in-JS — embedded foreign template literals preserved + guarded', () => {
  for (const f of cssInJsAcceptFixtures) {
    describe(`${f.id}: ${f.desc} [${f.ref}]`, () => {
      it('formats it, the guard accepts, and the embedded template body is verbatim', async () => {
        const out = await format(f.lang, f.input);

        // 2. PRESERVE — the embedded foreign-language body must survive verbatim.
        // Prettier (no CSS-in-JS plugin) never reflows the template content.
        for (const span of f.verbatim) {
          assert.ok(
            out.includes(span),
            `expected embedded template body preserved verbatim ${JSON.stringify(span)}, got:\n${out}`
          );
        }

        // 3. REFORMATTED — the JS/TS wrapper WAS reformatted (non-vacuous).
        for (const needle of f.jsReformatted) {
          assert.ok(
            out.includes(needle),
            `expected reformatted wrapper to contain ${JSON.stringify(needle)}, got:\n${out}`
          );
        }

        // 1. ACCEPT — a correct format must NOT be rejected by the guard.
        const verdict = guard.check(f.lang, f.input, out);
        assert.equal(
          verdict.equivalent,
          true,
          `guard false-positive rejected a correct CSS-in-JS format: ${verdict.reason ?? ''}`
        );
      });

      it('re-parses: re-formatting the output does not throw and stays equivalent', async () => {
        const out = await format(f.lang, f.input);
        const reformatted = await format(f.lang, out);

        const selfVerdict = guard.check(f.lang, out, out);
        assert.equal(selfVerdict.equivalent, true, selfVerdict.reason ?? '');

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

describe('polyglot CSS-in-JS — corruption is rejected by the guard', () => {
  for (const f of cssInJsCorruptionFixtures) {
    it(`${f.id}: ${f.desc} [${f.ref}] — guard rejects the corrupted output`, () => {
      const verdict = guard.check(f.lang, f.input, f.corrupted);
      assert.equal(
        verdict.equivalent,
        false,
        `guard ACCEPTED a meaning-changing CSS-in-JS output (${f.id}) — false negative`
      );
      assert.ok(
        typeof verdict.reason === 'string' && verdict.reason.length > 0,
        'a rejection must carry a reason for the OutputChannel'
      );
    });
  }
});

describe('polyglot CSS-in-JS — corpus sanity', () => {
  it('has >=15 accept fixtures', () => {
    assert.ok(
      cssInJsAcceptFixtures.length >= 15,
      `expected >=15 accept fixtures, got ${cssInJsAcceptFixtures.length}`
    );
  });

  it('has a corruption corpus', () => {
    assert.ok(
      cssInJsCorruptionFixtures.length >= 8,
      `expected >=8 corruption fixtures, got ${cssInJsCorruptionFixtures.length}`
    );
  });

  it('all fixture ids (accept + corruption) are unique', () => {
    const ids = [
      ...cssInJsAcceptFixtures.map((f) => f.id),
      ...cssInJsCorruptionFixtures.map((f) => f.id)
    ];
    assert.equal(new Set(ids).size, ids.length, 'duplicate fixture id detected');
  });

  it('covers every targeted embedded language tag', () => {
    const all = cssInJsAcceptFixtures.map((f) => f.input).join('\n');
    for (const tag of ['styled.', 'styled(', 'css`', 'createGlobalStyle`', 'html`', 'gql`', 'sql`']) {
      assert.ok(all.includes(tag), `expected the accept corpus to cover ${tag}`);
    }
  });
});
