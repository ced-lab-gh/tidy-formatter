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
//   1. PLACEHOLDER COLLISION : if a chosen token already occurs in the input, we
//      refuse to mask (return undefined) and the caller formats normally (or, for
//      the ignore path, returns no edits). We never silently mangle.
//   2. RESTORE FAILURE : if, after formatting, a placeholder is missing or appears
//      more than once (the engine duplicated/dropped it), restore returns
//      undefined and the caller falls back to leaving the file intact. Even when
//      restore SUCCEEDS, the caller re-runs `guard.check(input, restored)`; if the
//      splice produced non-equivalent or non-parsable output the guard rejects and
//      the file stays intact. So this module can only ever PRESERVE meaning.
//
// IDEMPOTENCE (SPEC SAFE-03, README "format(format(x)) === format(x)"): a
// placeholder is an INLINE token to the engine, but the span it stands for is a
// set of WHOLE LINES (`scanMarkers` opens a region at the START OF THE LINE the
// marker sits on, so the marker's own indentation is inside the protected bytes,
// and closes it at the END of the end marker's line, so the line break after it
// is outside). Left to itself, the engine breaks that structure two ways, and
// each way turned into permanent drift once the verbatim bytes were spliced back:
//   1. it INDENTS the placeholder. The protected bytes already carry their own
//      indentation, so the two stacked on EVERY run: an HTML
//      `<!-- tidy-ignore-start -->` gained two spaces per format, without bound
//      (2, 4, 6, 8 ...). A file formatted daily crept right for ever.
//   2. it EATS THE LINE BREAK after the placeholder. `__TOKEN__\n.b {` reads as
//      one CSS descendant selector, so the engine printed `__TOKEN__ .b {` and
//      the restore glued the next rule onto the `/* tidy-ignore-end */` line;
//      the pass after that formatted the glued line differently again.
// So each restoration also records the LINE STRUCTURE the span had in the INPUT
// (`startedLine`, `lineBreakAfter`) and `restoreMask` re-establishes exactly
// that: engine-added indentation in front of the token is dropped (the original
// bytes bring their own), and a line break the engine swallowed is put back in
// place of the horizontal whitespace it used instead. Both moves only ever pull
// the output BACK TOWARDS the input bytes, so neither can lose protected content,
// and the guard upstream still judges the result.
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
  /**
   * The span began at the start of a line in the input, so the ORIGINAL
   * indentation of that line is part of `original`. Any horizontal whitespace the
   * engine then puts in front of the token is engine-added indentation stacked on
   * top of the real one, and restore drops it (see the header note).
   */
  readonly startedLine: boolean;
  /**
   * The line terminator that immediately followed the span in the input (`\n` or
   * `\r\n`), or undefined when the span ran to end-of-input or was followed by
   * something that is not a line break. When the engine swallows that break,
   * joining the next construct onto the marker's line, restore puts it back.
   */
  readonly lineBreakAfter?: string;
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

/** A space or a tab: the whitespace an engine uses to indent or to glue. */
function isHorizontalWhitespace(char: string | undefined): boolean {
  return char === ' ' || char === '\t';
}

/**
 * Whether the span starting at `start` began a line in `input` (nothing but the
 * line break itself before it). True at offset 0, so a span at the very head of
 * the text owns its line as well.
 */
function startsLine(input: string, start: number): boolean {
  return start === 0 || input[start - 1] === '\n';
}

/**
 * The line terminator immediately after the span ending at `end` in `input`, or
 * undefined when the span ends the text or is followed by something else.
 *
 * A CRLF document is scanned by `scanMarkers` with `indexOf('\n')`, so the '\r'
 * of the closing line is INSIDE the protected span and only the '\n' is left
 * here: reporting '\n' is what makes the restored region keep its exact CRLF
 * break. The '\r\n' branch covers spans that end before a full CRLF pair (a
 * clipped selection range, a front matter block), where the whole pair must be
 * put back.
 */
function lineBreakAfter(input: string, end: number): string | undefined {
  if (input.startsWith('\r\n', end)) {
    return '\r\n';
  }
  if (input[end] === '\n') {
    return '\n';
  }
  return undefined;
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
    const { start, end } = ranges[i];
    restorations.push({
      token,
      original: input.slice(start, end),
      startedLine: startsLine(input, start),
      lineBreakAfter: lineBreakAfter(input, end)
    });
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
 * The offset the splice must START at, so the restored bytes land where the
 * original line began instead of behind indentation the engine invented.
 *
 * Only ever moves LEFT, and only across spaces/tabs that make up the WHOLE
 * prefix of the token's line: with anything else on that line (the engine joined
 * the marker to a preceding construct) the whitespace is a separator, not
 * indentation, and is left exactly where it is. When the span did not start a
 * line in the input, its own leading bytes are not indentation at all and this
 * returns the token offset unchanged.
 */
function spliceStartFor(
  formatted: string,
  tokenAt: number,
  restoration: Restoration
): number {
  if (!restoration.startedLine) {
    return tokenAt;
  }
  let cursor = tokenAt;
  while (cursor > 0 && isHorizontalWhitespace(formatted[cursor - 1])) {
    cursor -= 1;
  }
  return cursor === 0 || formatted[cursor - 1] === '\n' ? cursor : tokenAt;
}

/**
 * How the splice must END: the offset just past what it consumes, plus the text
 * to append after the original bytes.
 *
 * When the input had a line break right after the span and the engine did NOT
 * emit one, it glued the next construct onto the marker's line (the CSS
 * `/* tidy-ignore-end *\/ .b {` defect). The horizontal whitespace it used as a
 * joiner is consumed and the ORIGINAL line break is put back in its place. When
 * a break is already there, or the token ends the text, nothing is touched: the
 * engine's own blank-line choices after the region are its business.
 */
function spliceEndFor(
  formatted: string,
  tokenEnd: number,
  restoration: Restoration
): { readonly end: number; readonly append: string } {
  const untouched = { end: tokenEnd, append: '' };
  if (restoration.lineBreakAfter === undefined) {
    return untouched;
  }
  // CRLF documents: `scanMarkers` closes a region at the '\n', so the '\r' of
  // that break is INSIDE the protected bytes while the '\n' is not. When the
  // engine then prints its own CRLF after the token, the two CRs stack, and the
  // region grew one '\r' per format exactly as HTML grew two spaces. The
  // original brings the CR, so the engine's duplicate is consumed.
  if (restoration.original.endsWith('\r') && formatted[tokenEnd] === '\r') {
    return { end: tokenEnd + 1, append: '' };
  }
  let cursor = tokenEnd;
  while (cursor < formatted.length && isHorizontalWhitespace(formatted[cursor])) {
    cursor += 1;
  }
  if (cursor >= formatted.length) {
    return untouched; // token ends the output: no next construct to separate.
  }
  if (formatted[cursor] === '\n' || formatted[cursor] === '\r') {
    return untouched; // the engine kept a line break: leave its layout alone.
  }
  return { end: cursor, append: restoration.lineBreakAfter };
}

/**
 * Restore the verbatim originals into `formatted`, replacing each placeholder
 * token with its original bytes AND with the line structure the span had in the
 * input (see the header note on idempotence). Returns the restored text, or
 * `undefined` when the splice cannot be trusted:
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
  for (const restoration of restorations) {
    const { token, original } = restoration;
    const first = result.indexOf(token);
    if (first === -1) {
      return undefined; // engine dropped the placeholder.
    }
    if (result.indexOf(token, first + token.length) !== -1) {
      return undefined; // engine duplicated the placeholder.
    }
    const start = spliceStartFor(result, first, restoration);
    const { end, append } = spliceEndFor(result, first + token.length, restoration);
    result = result.slice(0, start) + original + append + result.slice(end);
  }

  return result;
}
