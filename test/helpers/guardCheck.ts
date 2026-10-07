// Test helper: a guard verdict that can never be answered by the identity fast
// path.
//
// WHY THIS EXISTS (I-L23). `guard.check` opens with
//
//     if (input === output) return EQUIVALENT;
//
// so a test that hands it the same string on both sides never reaches a parser
// or a comparator: it would still pass if every comparator in the guard were
// broken. That happens in two ways, and both are easy to write by accident:
//   - literally, `guard.check(lang, out, out)` ("the output re-parses");
//   - by data, `guard.check(lang, input, out)` where the formatter left an
//     already-tidy `input` untouched, so `out === input` and the "guard accepts
//     the formatter's output" assertion is vacuous for that row.
//
// `guardCheckNoFastPath` closes both. Different strings go straight to
// `guard.check`, unchanged. Identical strings are compared against themselves
// plus one trailing line feed, so the real comparator for the language runs on
// both texts: the text must parse, and its shape must match the shape of its
// own re-spelling. Text that does not parse is rejected, exactly as it would be
// if the two sides had ever differed.
//
// WHERE THE TRAILING LINE FEED IS NOT NEUTRAL. For JS, TS, CSS and JSON it
// never changes meaning. For HTML it DOES when the document ENDS INSIDE a
// context that draws its whitespace: an unclosed <pre>, <textarea>, <xmp>,
// <listing> or <plaintext> (which has no end tag at all), an element whose
// white-space preserves (inline style or an embedded <style> rule), an SVG
// <text xml:space="preserve">, or a script of a non-executable type such as
// text/plain. There the line feed is real drawn text and the guard is RIGHT to
// reject. Measured when this helper was introduced: none of the 127 identical
// texts it received ended in such a context. If one ever does, the assertion
// fails loudly rather than passing for the wrong reason; the fix is then to
// compare against a re-spelling that stays outside that context, not to weaken
// the guard.
//
// What this helper does NOT prove: that the comparator can REJECT. A comparator
// that accepted everything would still satisfy it. Rejection is proven by the
// must-reject pairs of test/fixtures/corruptionFixtures.ts.
//
// Use it wherever a test asserts "the guard accepts X" and X may equal the
// input. Do NOT use it to test the fast path itself: that one explicit test
// lives in test/unit/safety/guard.test.ts and calls `guard.check` directly.
import { guard } from '../../src/safety/guard';
import type { GuardVerdict, LangId } from '../../src/types';

export function guardCheckNoFastPath(lang: LangId, input: string, output: string): GuardVerdict {
  if (input !== output) {
    return guard.check(lang, input, output);
  }
  return guard.check(lang, input, `${output}\n`);
}
