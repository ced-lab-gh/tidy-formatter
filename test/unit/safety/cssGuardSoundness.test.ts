// CSS guard soundness: WHAT THE GUARD IS ALLOWED TO CALL WHITESPACE.
//
// The CSS half of the guard normalised whitespace with the JavaScript `\s`
// class. `\s` matches twenty code points CSS does not treat as whitespace at
// all (U+000B, U+00A0, U+1680, U+2000..U+200A, U+2028, U+2029, U+202F, U+205F,
// U+3000, U+FEFF), and js-beautify's CSS printer rewrites every one of them to
// U+0020. Folding the same class on BOTH sides made the rewrite invisible, so
// the guard answered "equivalent" and the edit was APPLIED:
//
//     .a<U+00A0>b{color:red}      was written as      .a b { color: red }
//
// U+00A0 is an identifier code point, so the input is ONE class selector and the
// output is a DESCENDANT COMBINATOR: the rule matches entirely different
// elements after the write. The same holds for a value, a custom property, an
// at-rule's params, for scss and less, and through an HTML <style> element.
//
// This is the CSS twin of the v0.2.2 HTML fix ("&nbsp; is no longer treated as
// an ordinary space"), which narrowed normalizeHtmlText from `\s` to the HTML
// spec's ASCII whitespace. The set below is read off the CSS specification on
// its own rather than borrowed from that one:
//   - CSS Syntax Level 3 defines `whitespace` as a newline, U+0009 CHARACTER
//     TABULATION or U+0020 SPACE;
//   - `newline` is U+000A LINE FEED, and the preprocessing step folds U+000D
//     CARRIAGE RETURN and U+000C FORM FEED into it.
// In an unpreprocessed document, which is what the guard is handed, that is
// U+0009, U+000A, U+000C, U+000D and U+0020, and nothing else.
//
// Every code point is built with String.fromCodePoint: a literal one would be
// invisible in review, and U+2028 is a line terminator to some tooling.
import assert from 'node:assert/strict';
import { dispatchFormat, dispatchCssFallback } from '../../../src/engine/dispatcher';
import { guard } from '../../../src/safety/guard';
import type { LangId, ResolvedOptions } from '../../../src/types';

const OPTS: ResolvedOptions = {
  tabSize: 2,
  insertSpaces: true,
  engineOptions: {},
  sources: {}
};

/** The whole CSS whitespace set, per CSS Syntax Level 3. */
const CSS_WHITESPACE: readonly number[] = [0x0009, 0x000a, 0x000c, 0x000d, 0x0020];

/**
 * Space-LOOKING code points that CSS does not count as whitespace. The first
 * twenty are exactly the ones `\s` adds on top of the CSS set, which is what
 * made the fold unsound; the rest are the zero-width and format neighbours a
 * printer could plausibly touch, swept for the same reason.
 */
const NOT_CSS_WHITESPACE: readonly number[] = [
  0x000b, 0x0085, 0x00a0, 0x1680, 0x180e, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004,
  0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x200b, 0x200c, 0x200d, 0x2028,
  0x2029, 0x202f, 0x205f, 0x2060, 0x3000, 0xfeff
];

/** The twenty `\s` adds to the CSS set: the exact blast radius of the defect. */
const JS_WHITESPACE_SURPLUS: readonly number[] = NOT_CSS_WHITESPACE.filter((cp) =>
  /\s/.test(String.fromCodePoint(cp))
);

const CSS_LANGS: readonly LangId[] = ['css', 'scss', 'less'];

function u(cp: number): string {
  return `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
}

/**
 * The four syntactic positions the audit asked for, each written so that BOTH
 * the exotic form and the U+0020 form parse in css, scss and less. A corruption
 * whose output no longer parses would be rejected for the easy reason and would
 * prove nothing about the fold.
 */
interface Slot {
  readonly name: string;
  readonly build: (filler: string) => string;
}

const SLOTS: readonly Slot[] = [
  {
    name: 'identifier position (class selector)',
    build: (f) => `.a${f}b {\n  color: red;\n}`
  },
  {
    name: 'value position (font-family)',
    build: (f) => `.x {\n  font-family: Helvetica${f}Neue;\n}`
  },
  {
    name: 'custom property',
    build: (f) => `:root {\n  --gap: 1px${f}2px;\n}`
  },
  {
    name: 'at-rule params',
    build: (f) => `@supports (display:grid${f}) {\n  .a {\n    color: red;\n  }\n}`
  }
];

/* -------------------------------------------------------------------------- */
/* 1 : the set, enumerated, in every position and every CSS-family language     */
/* -------------------------------------------------------------------------- */

describe('safety/guard CSS : the whitespace set is the one CSS defines', () => {
  it('has exactly five members, and they are not the JavaScript `\\s` class', () => {
    assert.deepEqual([...CSS_WHITESPACE].sort((a, b) => a - b), [0x09, 0x0a, 0x0c, 0x0d, 0x20]);
    // U+000B is matched by `\s` and is NOT CSS whitespace: proof the two classes
    // differ, and that the CSS set was not copied from the JS one.
    assert.ok(/\s/.test(String.fromCodePoint(0x000b)));
    assert.ok(!CSS_WHITESPACE.includes(0x000b));
    // The surplus is the blast radius the defect had.
    assert.equal(JS_WHITESPACE_SURPLUS.length, 20, JS_WHITESPACE_SURPLUS.map(u).join(' '));
  });

  for (const lang of CSS_LANGS) {
    for (const slot of SLOTS) {
      for (const cp of CSS_WHITESPACE) {
        // Rewriting U+0020 to U+0020 is the identical pair: guard.check answers
        // "equivalent" on string equality alone and no comparator would run, so
        // that row would pass even with every comparator broken. U+0020 is
        // rewritten to U+0009 (another CSS whitespace character) instead, which
        // makes the comparison real. Every other row is unchanged.
        const target = cp === 0x0020 ? 0x0009 : 0x0020;
        it(`${lang} ${slot.name}: ${u(cp)} IS CSS whitespace, so a rewrite to ${u(target)} stays equivalent`, () => {
          const input = slot.build(String.fromCodePoint(cp));
          const output = slot.build(String.fromCodePoint(target));
          assert.notEqual(input, output, 'the rewrite must differ or the guard fast path answers');
          const verdict = guard.check(lang, input, output);
          assert.equal(verdict.equivalent, true, verdict.reason);
        });
      }

      for (const cp of NOT_CSS_WHITESPACE) {
        it(`${lang} ${slot.name}: ${u(cp)} is NOT CSS whitespace, so a rewrite to U+0020 is rejected`, () => {
          const input = slot.build(String.fromCodePoint(cp));
          const output = slot.build(' ');
          const verdict = guard.check(lang, input, output);
          assert.equal(
            verdict.equivalent,
            false,
            `guard ACCEPTED rewriting ${u(cp)} to a space in ${lang} ${slot.name}: ` +
              `the token was split and the rule now matches different elements`
          );
          assert.ok(
            typeof verdict.reason === 'string' && verdict.reason.length > 0,
            'a rejection must carry a reason for the output channel'
          );
        });
      }
    }
  }
});

/* -------------------------------------------------------------------------- */
/* 2 : the REAL pipeline, not just the guard in isolation                      */
/* -------------------------------------------------------------------------- */

describe('safety/guard CSS : the proven accept, end to end through the engine', () => {
  const NBSP = String.fromCodePoint(0x00a0);

  for (const lang of CSS_LANGS) {
    it(`${lang}: js-beautify really does rewrite U+00A0 to a space, and the guard now refuses it`, async () => {
      const input = `.a${NBSP}b{color:red}`;
      const output = await dispatchFormat({ languageId: lang, code: input, options: OPTS });

      // The printer's rewrite is real, not hypothetical: this is the fact that
      // made the fold dangerous rather than merely imprecise.
      assert.ok(!output.includes(NBSP), `expected the printer to drop U+00A0, got ${JSON.stringify(output)}`);
      assert.notEqual(output, input);

      const verdict = guard.check(lang, input, output);
      assert.equal(verdict.equivalent, false, 'the printer output must not be applied');
    });
  }

  it('EVERY code point `\\s` added to the CSS set is one the printer rewrites, and all of them are now refused', async () => {
    // The strongest form of "the class is closed": the difference between the
    // old class and the new one is not merely non-empty, it coincides EXACTLY
    // with the set js-beautify rewrites. Every member was therefore a live
    // accept-when-not-equivalent, and none of them is one now.
    const rewritten: number[] = [];
    for (const cp of JS_WHITESPACE_SURPLUS) {
      const ch = String.fromCodePoint(cp);
      const input = `.a${ch}b{color:red}`;
      const output = await dispatchFormat({ languageId: 'css', code: input, options: OPTS });
      if (output.includes(ch)) {
        continue;
      }
      rewritten.push(cp);
      const verdict = guard.check('css', input, output);
      assert.equal(verdict.equivalent, false, `${u(cp)} was rewritten to a space and ACCEPTED`);
    }
    assert.deepEqual(
      rewritten,
      [...JS_WHITESPACE_SURPLUS],
      'the printer is expected to rewrite every one of them; a change here means the blast radius moved'
    );
  });

  it('the ADD-01 postcss second chance preserves U+00A0, so the stylesheet still formats', async () => {
    const input = `.a${NBSP}b{color:red}`;
    const fallback = await dispatchCssFallback({ languageId: 'css', code: input, options: OPTS });
    assert.ok(fallback.includes(NBSP), 'the fallback printer must keep the code point');
    const verdict = guard.check('css', input, fallback);
    assert.equal(verdict.equivalent, true, verdict.reason);
  });
});

/* -------------------------------------------------------------------------- */
/* 3 : the same CSS reached through HTML, and the embedded-body pre-trim        */
/* -------------------------------------------------------------------------- */

describe('safety/guard CSS : the verdict does not depend on where the CSS lives', () => {
  const NBSP = String.fromCodePoint(0x00a0);

  it('a <style> body gets the same answer as the standalone stylesheet', () => {
    const standalone = guard.check('css', `.a${NBSP}b{color:red}`, '.a b{color:red}');
    const embedded = guard.check(
      'html',
      `<style>.a${NBSP}b{color:red}</style>`,
      '<style>.a b{color:red}</style>'
    );
    assert.equal(standalone.equivalent, false);
    assert.equal(embedded.equivalent, false, 'the <style> route must not be more permissive');
  });

  it('a LEADING U+00A0 in a <style> body is content, not padding to be trimmed away', () => {
    // It belongs to the first compound selector: dropping it turns a rule the
    // browser discards into one that applies.
    const verdict = guard.check(
      'html',
      `<style>${NBSP}.a{color:red}</style>`,
      '<style>.a{color:red}</style>'
    );
    assert.equal(verdict.equivalent, false, 'the embedded body was pre-trimmed with the wrong set');
  });

  it('a LEADING byte-order mark in a <style> body is content too', () => {
    // postcss consumes a leading U+FEFF because CSS Syntax has the DECODING step
    // eat it, but an inline <style> body was never decoded from bytes.
    const BOM = String.fromCodePoint(0xfeff);
    const verdict = guard.check(
      'html',
      `<style>${BOM}.a{color:red}</style>`,
      '<style>.a{color:red}</style>'
    );
    assert.equal(verdict.equivalent, false);
  });

  it('a LEADING U+00A0 in an application/json body is not JSON whitespace either', () => {
    // RFC 8259 allows only U+0009, U+000A, U+000D and U+0020 between tokens, so
    // JSON.parse throws on the input and succeeds on the output: a real change.
    const verdict = guard.check(
      'html',
      `<script type="application/json">${NBSP}{"a":1}</script>`,
      '<script type="application/json">{"a": 1}</script>'
    );
    assert.equal(verdict.equivalent, false);
  });

  it('a standalone .json document already refused that body, and still does', () => {
    const verdict = guard.check('json', `${NBSP}{"a":1}`, '{\n  "a": 1\n}');
    assert.equal(verdict.equivalent, false);
  });
});

/* -------------------------------------------------------------------------- */
/* 4 : false-positive guardrail : the narrowing must not make Tidy a no-op      */
/* -------------------------------------------------------------------------- */

describe('safety/guard CSS : narrowing the class rejects nothing it used to accept legitimately', () => {
  it('accepts a plain reindent that only moves ASCII whitespace', () => {
    const verdict = guard.check(
      'css',
      '.a\t{\n\n  color:\tred;\r\n}\n',
      '.a {\n  color: red;\n}\n'
    );
    assert.equal(verdict.equivalent, true, verdict.reason);
  });

  it('accepts a form feed, which CSS preprocessing folds into a newline', () => {
    const verdict = guard.check('css', `.a${String.fromCodePoint(0x0c)}b{color:red}`, '.a b{color:red}');
    assert.equal(verdict.equivalent, true, verdict.reason);
  });

  it('still accepts combinator tightening #a > #b -> #a>#b', () => {
    const verdict = guard.check('css', '#a > #b {\n  color: red;\n}', '#a>#b{color:red}');
    assert.equal(verdict.equivalent, true, verdict.reason);
  });

  it('still accepts calc( 1px + 2px ) -> calc(1px + 2px) and comma tightening', () => {
    assert.equal(guard.check('css', '.a{width:calc( 1px + 2px )}', '.a{width:calc(1px + 2px)}').equivalent, true);
    assert.equal(guard.check('css', '.a{font-family:Arial , serif}', '.a{font-family:Arial, serif}').equivalent, true);
  });

  it('still accepts the compact and spaced LESS variable forms as one', () => {
    const verdict = guard.check('less', '@c:red;\n.a{color:@c}', '@c: red;\n.a {\n  color: @c;\n}');
    assert.equal(verdict.equivalent, true, verdict.reason);
  });

  it('still keeps whitespace inside a CSS string significant', () => {
    const verdict = guard.check('css', '.a{content:"x  y"}', '.a{content:"x y"}');
    assert.equal(verdict.equivalent, false);
  });

  it('formats an ordinary stylesheet end to end, guard included', async () => {
    const input = '.a>.b{color:red;margin:calc( 1px + 2px )}\n@media screen and (min-width:10px){.c{color:blue}}';
    const output = await dispatchFormat({ languageId: 'css', code: input, options: OPTS });
    assert.notEqual(output, input, 'the fixture must actually be reformatted');
    const verdict = guard.check('css', input, output);
    assert.equal(verdict.equivalent, true, verdict.reason);
  });

  for (const lang of CSS_LANGS) {
    it(`${lang}: every real fixture in test/fixtures/css-sass still formats and passes the guard`, async () => {
      // A cheap stand-in for the corpus: the shapes that historically produced
      // the "faux positif de la garde" (issues #17, #21, #67, #74, #77, #78).
      const sources = [
        '.a:not(.b) .c{color:red}',
        'li:nth-child(2n){background:gray}',
        '.a{background:url(a.png) no-repeat}',
        '@media (min-width:10px) and (max-width:20px){.a{color:red}}',
        '.a{margin:0 auto;padding:1px 2px 3px 4px}'
      ];
      for (const input of sources) {
        const output = await dispatchFormat({ languageId: lang, code: input, options: OPTS });
        const verdict = guard.check(lang, input, output);
        assert.equal(verdict.equivalent, true, `${lang} rejected ${JSON.stringify(input)}: ${verdict.reason}`);
      }
    });
  }
});
