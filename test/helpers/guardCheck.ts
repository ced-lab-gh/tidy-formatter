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
// plus one trailing line feed, a whitespace-only difference that every JS, CSS,
// HTML and JSON formatter may legitimately introduce or remove, so the real
// comparator for the language runs on both texts: the text must parse, and its
// shape must match the shape of its own re-spelling. Text that does not parse
// is rejected, exactly as it would be if the two sides had ever differed.
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
