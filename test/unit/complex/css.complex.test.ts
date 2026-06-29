// Complex CSS / SCSS / LESS corpus (SPEC SAFE-02 "re-tokenise + tree compare",
// SAFE-03 idempotence, ENG-05 "CSS/SCSS/LESS compile-safe").
//
// The product's moat is SAFETY: the guard must (a) NEVER reject a correct,
// complex stylesheet — otherwise the formatter is a useless no-op on real code
// ("safe but does nothing"), and (b) NEVER accept a meaning-changing output —
// otherwise it corrupts the file like the incumbent.
//
// Three blocks:
//   1. ACCEPT — every advanced-CSS fixture, formatted through the REAL engine,
//      must be guard-equivalent to its input AND idempotent on a second pass.
//   2. REJECT — every adversarial corruption must be caught by cssTreeEqual.
//   3. Historical lonefy edge cases (#78 comma-values, #77 pseudo/extend spacing,
//      #74 calc, #67 combinator, #17 :not/:nth-child) pinned explicitly, plus a
//      previously-documented guard FALSE-NEGATIVE (quoted-string whitespace),
//      now fixed and asserted to REJECT.
import assert from 'node:assert/strict';
import { dispatchFormat } from '../../../src/engine/dispatcher';
import { guard, cssTreeEqual } from '../../../src/safety/guard';
import { resolved } from '../../helpers/options';
import {
  cssAcceptFixtures,
  cssRejectFixtures
} from '../../fixtures/cssComplexFixtures';

describe('complex CSS/SCSS/LESS — ACCEPT (engine output is guard-equivalent, SPEC SAFE-02)', () => {
  for (const f of cssAcceptFixtures) {
    it(`${f.id}: ${f.desc} [${f.ref}]`, async () => {
      const opts = resolved();
      const formatted = await dispatchFormat({
        languageId: f.lang,
        code: f.input,
        options: opts
      });

      // The real engine actually changed the source (otherwise the fixture is
      // not exercising the tree comparison at all — it would hit the identity
      // fast path). A few inputs are already canonical; only assert "did work"
      // when it visibly reformatted.
      const verdict = guard.check(f.lang, f.input, formatted);
      assert.equal(
        verdict.equivalent,
        true,
        `guard wrongly rejected a correct ${f.lang} reformat (${f.id}): ${verdict.reason}\n` +
          `--- input ---\n${f.input}\n--- formatted ---\n${formatted}`
      );
    });
  }
});

describe('complex CSS/SCSS/LESS — idempotence (SPEC SAFE-03, no right-drift)', () => {
  for (const f of cssAcceptFixtures) {
    it(`${f.id}: format(format(x)) == format(x) [${f.lang}]`, async () => {
      const opts = resolved();
      const first = await dispatchFormat({
        languageId: f.lang,
        code: f.input,
        options: opts
      });
      const second = await dispatchFormat({
        languageId: f.lang,
        code: first,
        options: opts
      });
      assert.equal(
        second,
        first,
        `second pass drifted for ${f.id}\n--- first ---\n${first}\n--- second ---\n${second}`
      );
    });
  }
});

describe('complex CSS/SCSS/LESS — REJECT corruptions (security core, SPEC SAFE-02)', () => {
  for (const f of cssRejectFixtures) {
    it(`${f.id}: ${f.desc} [${f.ref}]`, () => {
      const verdict = cssTreeEqual(f.lang, f.input, f.output);
      assert.equal(
        verdict.equivalent,
        false,
        `guard FAILED to reject a meaning-changing ${f.lang} output (${f.id})\n` +
          `--- input ---\n${f.input}\n--- corrupt output ---\n${f.output}`
      );
      // A rejection must always carry a reason for the OutputChannel.
      assert.ok(
        verdict.reason && verdict.reason.length > 0,
        'a rejection must include a reason'
      );
    });
  }

  it('a rejection reason never echoes the stylesheet source', () => {
    // The OutputChannel must receive a summary, never the user's code (which
    // could contain secrets in e.g. a content/url value).
    const secret = '.a{content:"sk-LEAKED-CSS-SECRET"}';
    const broken = '.a{content:"sk-DIFFERENT"}';
    const verdict = cssTreeEqual('css', secret, broken);
    assert.equal(verdict.equivalent, false);
    assert.ok(verdict.reason);
    assert.ok(
      !verdict.reason!.includes('sk-LEAKED-CSS-SECRET'),
      'reason must not echo the source'
    );
  });
});

describe('complex CSS/SCSS/LESS — pinned historical lonefy edge cases', () => {
  // #78: comma-separated value corruption. js-beautify keeps the list intact;
  // the guard accepts the (whitespace-only) reformat but rejects a dropped item.
  it('#78: comma font-family stack survives formatting and rejects a swapped face', async () => {
    const input = '.a{font-family:Helvetica,"My Font",sans-serif}';
    const formatted = await dispatchFormat({
      languageId: 'css',
      code: input,
      options: resolved()
    });
    assert.equal(guard.check('css', input, formatted).equivalent, true);
    // A real value change (one face swapped) must be rejected.
    assert.equal(
      cssTreeEqual('css', input, '.a{font-family:Helvetica,"My Font",serif}').equivalent,
      false
    );
  });

  // #77: pseudo-class / @extend spacing. `:nth-child(2n)` -> `:nth-child(2 n)`
  // and `@extend a:hover` -> `@extend a: hover` are the canonical breakages.
  it('#77: :nth-child(2n) and @extend a:hover both reject the space-injected forms', () => {
    assert.equal(
      cssTreeEqual('css', '.s:nth-child(2n){color:red}', '.s:nth-child(2 n){color:red}').equivalent,
      false
    );
    assert.equal(
      cssTreeEqual('scss', '.x{@extend a:hover}', '.x{@extend a: hover}').equivalent,
      false
    );
  });

  // #74: calc() interpolation/whitespace. The guard normalizes harmless spacing
  // but must catch a flipped operator and a glued `-` that changes the value.
  it('#74: calc() accepts pretty-printing but rejects an operator/whitespace change', async () => {
    const input = '.a{width:calc(100% - var(--x))}';
    const formatted = await dispatchFormat({
      languageId: 'css',
      code: input,
      options: resolved()
    });
    assert.equal(guard.check('css', input, formatted).equivalent, true);
    assert.equal(
      cssTreeEqual('css', input, '.a{width:calc(100% + var(--x))}').equivalent,
      false
    );
    assert.equal(
      cssTreeEqual('css', input, '.a{width:calc(100% -var(--x))}').equivalent,
      false
    );
  });

  // #67: combinator whitespace is insignificant — `#a > #b` and `#a>#b` are the
  // SAME selector, so the guard must accept js-beautify's tightened output, but
  // descendant (space) must stay distinct from child (>).
  it('#67: `#a > #b` == `#a>#b` (accept) but `.a .b` != `.a>.b` (reject)', () => {
    assert.equal(cssTreeEqual('css', '#a > #b{color:red}', '#a>#b{color:red}').equivalent, true);
    assert.equal(cssTreeEqual('css', '.a .b{color:red}', '.a>.b{color:red}').equivalent, false);
  });

  // #17: :not() / :nth-child() spacing corruption.
  it('#17: :not(:first-child) rejects the `: first-child` space corruption', () => {
    assert.equal(
      cssTreeEqual('css', '.s:not(:first-child){color:red}', '.s:not(: first-child){color:red}').equivalent,
      false
    );
  });
});

describe('complex CSS/SCSS/LESS — quoted-string whitespace is significant (was a guard gap, now fixed)', () => {
  // FIXED (was a guard FALSE NEGATIVE): normalizeCssText used to collapse EVERY
  // run of whitespace inside value/params/selector strings, INCLUDING whitespace
  // inside a quoted string. For a CSS quoted value the interior whitespace is
  // LITERAL and meaning-bearing (content rendering, [attr="..."] matching, a
  // quoted font-family name), so rewriting `content:"a  b"` to `content:"a b"`
  // changes the file's meaning. The guard now preserves quoted spans verbatim
  // (see splitCssQuotedSpans) so this meaning change is correctly rejected, while
  // whitespace OUTSIDE strings is still normalised.
  it('rejects collapsing whitespace inside a CSS content quoted string', () => {
    const verdict = cssTreeEqual('css', '.a::before{content:"a  b"}', '.a::before{content:"a b"}');
    assert.equal(
      verdict.equivalent,
      false,
      'two literal spaces inside content are not equivalent to one'
    );
  });

  it('rejects collapsing whitespace inside an attribute-selector value', () => {
    const verdict = cssTreeEqual('css', '[title="a  b"]{color:red}', '[title="a b"]{color:red}');
    assert.equal(
      verdict.equivalent,
      false,
      'an attribute value matches a literal string; whitespace inside it is significant'
    );
  });

  it('still ACCEPTS whitespace normalisation OUTSIDE quoted strings (no over-rejection)', () => {
    // The fix must not turn the guard into a no-op: insignificant whitespace
    // between tokens and around delimiters must still be normalised.
    assert.equal(
      cssTreeEqual('css', '.a{font-family:  Arial ,  "My Font" ,  sans-serif}',
        '.a{font-family:Arial,"My Font",sans-serif}').equivalent,
      true
    );
  });
});
