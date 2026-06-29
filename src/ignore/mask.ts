// Protect-and-restore for in-source ignore REGIONS (Axe 4.T2).
//
// Given the original text and the protected byte ranges found by the pure
// `scanMarkers`, this module replaces every protected span with a unique,
// formatter-stable placeholder token BEFORE the engine runs, then restores the
// VERBATIM original bytes AFTER. The net effect is that a `tidy-ignore-start` …
// `tidy-ignore-end` region (and any node-marked span) is left byte-identical
// while the rest of the document is formatted.
//
// SAFETY (NON-NEGOTIABLE): this is best-effort and ALWAYS sits behind the safety
// guard. Two failure modes are handled explicitly so corruption is impossible:
//   1. PLACEHOLDER COLLISION — if a chosen token already occurs in the input, we
//      refuse to mask (return undefined) and the caller formats normally (or, for
//      the ignore path, returns no edits). We never silently mangle.
//   2. RESTORE FAILURE — if, after formatting, a placeholder is missing or appears
//      more than once (the engine duplicated/dropped it), restore returns
//      undefined and the caller falls back to leaving the file intact. Even when
//      restore SUCCEEDS, the caller re-runs `guard.check(input, restored)`; if the
//      splice produced non-equivalent or non-parsable output the guard rejects and
//      the file stays intact. So this module can only ever PRESERVE meaning.
//
// PURE: imports neither 'vscode' nor any engine/parser. Operates on raw strings +
// the ranges from `scanMarkers`, so it is fully unit-testable under mocha + tsx.
import type { ProtectedRange } from './markers';

/**
 * A single masked span: the placeholder that stands in for it during formatting,
 * and the verbatim original bytes to restore afterwards.
 */
export interface Restoration {
  /** The unique placeholder token inserted in place of the protected span. */
  readonly token: string;
  /** The exact original bytes that must be spliced back in, verbatim. */
  readonly original: string;
}

/** The result of masking: the text to format, plus the restoration table. */
export interface MaskResult {
  /** Input text with every protected span replaced by its placeholder token. */
  readonly masked: string;
  /** Restoration entries, in document order (first protected span first). */
  readonly restorations: Restoration[];
}

/**
 * Build a placeholder token for the i-th protected span. The token is:
 *   - a valid bare identifier in every language we format (letters + digits +
 *     underscore), so a masked JS/TS/CSS/HTML document still tends to parse,
 *     keeping the engine happy in the common case;
 *   - highly unlikely to appear in real source, lowering collision odds;
 *   - stable and unique per index so restore can map it back deterministically.
 */
function tokenFor(index: number): string {
  return `__TIDY_IGNORE_PLACEHOLDER_${index}__`;
}

/**
 * Mask every protected range in `input` with a unique placeholder token, ready to
 * be formatted. Returns the masked text + the restoration table, or `undefined`
 * when masking cannot be done safely:
 *   - no ranges                       -> undefined (nothing to protect; caller
 *                                        formats the document as-is);
 *   - a range is out of bounds / empty / overlapping -> undefined (defensive);
 *   - a chosen placeholder token already occurs in the input -> undefined
 *     (collision: refuse to mask rather than risk a wrong restore).
 *
 * Ranges are expected pre-merged, non-overlapping and sorted (as `scanMarkers`
 * returns them); we re-validate defensively so a malformed range can never
 * produce a corrupt mask.
 */
export function applyMask(
  input: string,
  ranges: readonly ProtectedRange[]
): MaskResult | undefined {
  if (typeof input !== 'string' || !Array.isArray(ranges) || ranges.length === 0) {
    return undefined;
  }

  // Validate ranges: in-bounds, non-empty, strictly increasing, non-overlapping.
  let previousEnd = 0;
  for (const range of ranges) {
    if (
      !Number.isInteger(range.start) ||
      !Number.isInteger(range.end) ||
      range.start < previousEnd ||
      range.end <= range.start ||
      range.end > input.length
    ) {
      return undefined;
    }
    previousEnd = range.end;
  }

  // Pre-flight collision check: none of the tokens we will use may already exist.
  const restorations: Restoration[] = [];
  for (let i = 0; i < ranges.length; i += 1) {
    const token = tokenFor(i);
    if (input.includes(token)) {
      return undefined; // collision -> refuse to mask (caller stays safe).
    }
    restorations.push({ token, original: input.slice(ranges[i].start, ranges[i].end) });
  }

  // Splice from the end so earlier offsets stay valid while we rebuild the text.
  let masked = input;
  for (let i = ranges.length - 1; i >= 0; i -= 1) {
    const { start, end } = ranges[i];
    masked = masked.slice(0, start) + restorations[i].token + masked.slice(end);
  }

  return { masked, restorations };
}

/**
 * Restore the verbatim originals into `formatted`, replacing each placeholder
 * token with its original bytes. Returns the restored text, or `undefined` when
 * the splice cannot be trusted:
 *   - a token is missing from the formatted text (the engine dropped it), or
 *   - a token appears more than once (the engine duplicated it).
 * In either case the caller leaves the file intact. A successful restore is still
 * re-validated by the guard upstream, so an equivalence break can never slip
 * through here either.
 */
export function restoreMask(
  formatted: string,
  restorations: readonly Restoration[]
): string | undefined {
  if (typeof formatted !== 'string' || !Array.isArray(restorations)) {
    return undefined;
  }

  let result = formatted;
  for (const { token, original } of restorations) {
    const first = result.indexOf(token);
    if (first === -1) {
      return undefined; // engine dropped the placeholder.
    }
    if (result.indexOf(token, first + token.length) !== -1) {
      return undefined; // engine duplicated the placeholder.
    }
    result = result.slice(0, first) + original + result.slice(first + token.length);
  }

  return result;
}
