// The rules a RANGE (selection) format must respect AT THE EDGES of the slice,
// in ONE place. There are two, and they are different questions:
//
//   1. WHOSE BYTES ARE THE EDGE WHITESPACE? (splitSliceEdges / withSliceEdges)
//   2. IS THIS SLICE A FORMATTABLE UNIT AT ALL? (cutsThroughMarkup)
//
// ---------------------------------------------------------------------------
// 1. The edge-whitespace rule
//
// A printer trims the edges of whatever slice it is handed. At document scope
// that is harmless: the slice IS the file, and its edges are the file's edges.
// At SELECTION scope it is not, because the bytes on either side of the slice
// stay in the buffer and the trim silently joins the slice to them:
//
//   DOC  "<p>hello <b>x</b> \n<i>y</i></p>"   selection [0,19)
//   the engine is handed "<p>hello <b>x</b> \n" and prints "<p>hello <b>x</b>"
//   the splice writes    "<p>hello <b>x</b><i>y</i></p>"
//   which RENDERS        "hello x y"  ->  "hello xy"
//
// The safety guard cannot see it: in HTML a whitespace-only text node between
// two inline elements is exactly what it normalises away, so the verdict is
// "equivalent" and the edit is applied (defect G3-4). The same trim is what made
// a selection whose last character is a line break drift without bound: the
// splice glued the next line on, so the next pass had a DIFFERENT slice to
// format and format(format(x)) never reached a fixed point (defect M3-3).
//
// The rule is therefore: a range format may reprint the slice's CONTENT, never
// the slice's own leading and trailing whitespace runs. Those come back from the
// slice, not from the printer.
//
// WHICH LINE ENDINGS THOSE RESTORED RUNS CARRY IS A SECOND QUESTION, and the
// first version of this module got it wrong. It claimed that putting the bytes
// back "can never introduce a foreign EOL (defect C-04's class)". That is true
// byte-locally and false at document level: with an EXPLICIT `files.eol`, the
// engine converts the slice's INTERIOR to the requested ending while a verbatim
// edge keeps the old one, so a full-span Format Selection wrote a slice that was
// itself MIXED. Whitespace-only, therefore "equivalent" to the guard, therefore
// written: C-04's exact shape. So:
//
//   - an EXPLICIT endOfLine is the user saying what they want, and a restored
//     edge is normalised to it like every other line ending in the span;
//   - with NO explicit setting, "keep the bytes that were there" is right, and
//     the runs go back byte for byte, line endings included.
//
// One byte is never rewritten either way: a line ending that STRADDLES the
// selection boundary (the slice starts with the LF of a CRLF, or ends with the
// CR of one). Rewriting half a pair would not change a line ending, it would
// ADD a line break to the document. VS Code cannot place a Position inside a
// CRLF pair, so no real request reaches that state; `EdgeRule.before` /
// `EdgeRule.after` make it impossible rather than merely unlikely.
//
// AND ONE CLASS OF BYTES IS NEVER REWRITTEN EITHER: the bytes of a PROTECTED
// SPAN. When a slice's edge whitespace run reaches into an ignore region, a head
// front matter block or a template island, those bytes were handed back VERBATIM
// by the mask layer moments earlier, and README and CHANGELOG both promise that
// a protected span comes back byte for byte. Normalising them anyway is a
// whitespace-only change, so it is not a corruption and the guard rightly
// accepts it, which is exactly why it has to be refused HERE: a documented
// guarantee that is quietly false is worse than no guarantee. So the rule reads
// in full:
//
//   an explicit `endOfLine` owns the slice's OWN whitespace, and never a byte
//   inside a span the user asked to be left alone.
//
// `EdgeRule.protectedSpans` carries those spans, in the slice's own coordinates;
// a line ending that TOUCHES one goes back untouched, a CRLF pair counting as
// one token so a pair straddling the edge of a protected span cannot be split in
// half either. The test is per line ending and not per run, so a run that is
// only partly protected still gets the user's setting on the part that is the
// slice's own: skipping the whole run would be safe but would silently drop the
// setting on bytes nobody protected.
//
// ---------------------------------------------------------------------------
// 2. The well-formed-edge rule
//
// A selection whose boundary lands INSIDE A TAG is not a formattable unit. It
// used to be refused by luck: the slice handed to the engine started mid-tag,
// the printer's repair changed the tree, and the guard rejected it. Restoring
// the leading whitespace run (rule 1) repairs that tag split before the guard
// ever sees it, and what is left is a break the engine inserted between two
// ADJACENT INLINE-LEVEL elements, which the guard normalises away. An accidental
// rejection became a bad write. `cutsThroughMarkup` makes the refusal explicit
// and deliberate, so it no longer depends on a guard verdict it never owned.
//
// PURE: this module MUST NOT import 'vscode' (testable under mocha + tsx).

/** Stateless (no /g): safe to share across calls. */
const WHITESPACE = /\s/;

/**
 * A slice split into its own leading whitespace run, its content, and its own
 * trailing whitespace run. `core` is empty exactly when the slice is nothing but
 * whitespace, in which case `leading` holds the whole slice.
 */
export interface SliceEdges {
  readonly leading: string;
  readonly core: string;
  readonly trailing: string;
}

/**
 * A span of the SLICE whose bytes the mask layer put back VERBATIM: an ignore
 * region, a head front matter block or a template island, CLIPPED to the slice
 * and expressed in the slice's own coordinates. Half-open, like every other
 * range in this codebase: [start, end).
 */
export interface ProtectedSpan {
  readonly start: number;
  readonly end: number;
}

/**
 * What the caller knows about the edges it is asking to restore.
 *
 *  - `endOfLine` : the RESOLVED line-ending setting. Defined means the user said
 *    what they want, so a restored run is normalised to it; undefined means the
 *    run goes back byte for byte.
 *  - `before` / `after` : the document text on either side of the slice. Only
 *    the adjacent character is read, and only to spot a CRLF pair cut in half by
 *    the selection boundary (see the header). Omitting them is safe: it just
 *    forgoes that protection.
 *  - `protectedSpans` : the spans of the slice the mask restored byte for byte.
 *    A line ending that touches one of them is left exactly as it was, whatever
 *    `endOfLine` says: those bytes are the user's, not the printer's. Sorted and
 *    disjoint is what the mask plan produces, but nothing here requires it.
 *    Omitting them is safe only when the format protected nothing.
 */
export interface EdgeRule {
  readonly endOfLine?: 'lf' | 'crlf';
  readonly before?: string;
  readonly after?: string;
  readonly protectedSpans?: readonly ProtectedSpan[];
}

/** Shared empty list, so the ordinary "nothing protected" call allocates none. */
const NO_PROTECTED_SPANS: readonly ProtectedSpan[] = [];

/**
 * Length of the leading whitespace run. A linear scan rather than an anchored
 * greedy-whitespace regex match, so a slice that is one long run of blanks
 * stays O(n) instead of degrading to a quadratic scan.
 */
function leadingRunLength(text: string): number {
  let index = 0;
  while (index < text.length && WHITESPACE.test(text[index])) {
    index += 1;
  }
  return index;
}

/**
 * Index at which the trailing whitespace run starts, never scanning below
 * `floor` (the end of the leading run), so the two runs can never overlap.
 */
function trailingRunStart(text: string, floor: number): number {
  let index = text.length;
  while (index > floor && WHITESPACE.test(text[index - 1])) {
    index -= 1;
  }
  return index;
}

/** Split a slice into leading run / content / trailing run. Never mutates. */
export function splitSliceEdges(slice: string): SliceEdges {
  const leadingEnd = leadingRunLength(slice);
  if (leadingEnd === slice.length) {
    // Nothing but whitespace: there is no content, and the whole run is the
    // leading one. Callers use `core === ''` to mean "hand this back verbatim".
    return { leading: slice, core: '', trailing: '' };
  }
  const trailingStart = trailingRunStart(slice, leadingEnd);
  return {
    leading: slice.slice(0, leadingEnd),
    core: slice.slice(leadingEnd, trailingStart),
    trailing: slice.slice(trailingStart)
  };
}

/** The two bytes of a CRLF, as the concrete string an explicit setting means. */
function eolBytes(endOfLine: 'lf' | 'crlf'): string {
  return endOfLine === 'crlf' ? '\r\n' : '\n';
}

/**
 * Width of the line ending starting at `index`, or 0 when that character is not
 * one. A CRLF is ONE token on purpose: every decision below is taken per token,
 * so a pair can never be half rewritten (see the header).
 */
function eolWidthAt(run: string, index: number): number {
  const character = run[index];
  if (character === '\r') {
    return run[index + 1] === '\n' ? 2 : 1;
  }
  return character === '\n' ? 1 : 0;
}

/** Does the half-open range [start, end) share a byte with a protected span? */
function touchesProtected(
  spans: readonly ProtectedSpan[],
  start: number,
  end: number
): boolean {
  return spans.some((span) => span.start < end && start < span.end);
}

/**
 * Everything one restored edge run needs to decide, per line ending, whether
 * that line ending is the slice's own.
 *
 *  - `eol`            : the concrete bytes the explicit setting means;
 *  - `offset`         : where the run starts INSIDE THE SLICE, so a protected
 *    span (also in slice coordinates) can be tested against it;
 *  - `protectedSpans` : the spans restored verbatim by the mask;
 *  - `keepHeadLf`     : the document byte just BEFORE the slice is a CR, so a
 *    run that starts with LF is the tail of a pair the selection cut in two;
 *  - `keepTailCr`     : the document byte just AFTER the slice is an LF, so a
 *    run that ends with CR is the head of one.
 */
interface RunRule {
  readonly eol: string;
  readonly offset: number;
  readonly protectedSpans: readonly ProtectedSpan[];
  readonly keepHeadLf: boolean;
  readonly keepTailCr: boolean;
}

/**
 * Rewrite the line endings of one restored edge run to `rule.eol`, leaving
 * untouched the two kinds that are not the printer's to change: half a CRLF the
 * selection boundary cut in two (at either end), and any line ending that
 * touches a protected span (see the header). Spaces and tabs are never rewritten
 * at all, so a run with no line ending in it comes back identical.
 *
 * Returns a NEW string; `run` is not mutated. Pure and O(run.length).
 */
function normaliseEdgeRun(run: string, rule: RunRule): string {
  let out = '';
  let plainFrom = 0;
  let index = 0;
  while (index < run.length) {
    const width = eolWidthAt(run, index);
    if (width === 0) {
      index += 1;
      continue;
    }
    const token = run.slice(index, index + width);
    const keep =
      (index === 0 && token === '\n' && rule.keepHeadLf) ||
      (index + width === run.length && token === '\r' && rule.keepTailCr) ||
      touchesProtected(
        rule.protectedSpans,
        rule.offset + index,
        rule.offset + index + width
      );
    out += run.slice(plainFrom, index) + (keep ? token : rule.eol);
    index += width;
    plainFrom = index;
  }
  return out + run.slice(plainFrom);
}

/**
 * Put `slice`'s own edge whitespace runs back around `printed`.
 *
 * Returns a NEW string; neither argument is mutated.
 *
 *  - a slice made of nothing but whitespace comes back verbatim: there is no
 *    content to print, in HTML that run IS a rendered space, and with no content
 *    to convert there is no mixed span to prevent either;
 *  - a printed result made of nothing but whitespace is handed back untouched,
 *    so the guard judges what the engine really produced rather than a result
 *    this function manufactured;
 *  - otherwise the printed content keeps its own interior, and only the two edge
 *    runs are replaced by the slice's, normalised to `rule.endOfLine` when the
 *    user set one (see the header) and byte for byte when they did not. A line
 *    ending of those runs that touches one of `rule.protectedSpans` is left
 *    exactly as it was even then: the mask promised those bytes back verbatim.
 *
 * Idempotent: applying it to its own output changes nothing, which is what lets
 * the provider re-apply it after an engine that already obeys the rule.
 */
export function withSliceEdges(
  slice: string,
  printed: string,
  rule: EdgeRule = {}
): string {
  const wanted = splitSliceEdges(slice);
  if (wanted.core === '') {
    return slice;
  }
  const got = splitSliceEdges(printed);
  if (got.core === '') {
    return printed;
  }
  if (rule.endOfLine === undefined) {
    return wanted.leading + got.core + wanted.trailing;
  }
  const eol = eolBytes(rule.endOfLine);
  const protectedSpans = rule.protectedSpans ?? NO_PROTECTED_SPANS;
  const leading = normaliseEdgeRun(wanted.leading, {
    eol,
    // The leading run starts where the slice starts.
    offset: 0,
    protectedSpans,
    keepHeadLf: rule.before !== undefined && rule.before.endsWith('\r'),
    keepTailCr: false
  });
  const trailing = normaliseEdgeRun(wanted.trailing, {
    eol,
    // The trailing run ends where the slice ends (splitSliceEdges never lets
    // the two runs overlap, so this offset is always past the leading one).
    offset: slice.length - wanted.trailing.length,
    protectedSpans,
    keepHeadLf: false,
    keepTailCr: rule.after !== undefined && rule.after.startsWith('\n')
  });
  return leading + got.core + trailing;
}

/* -------------------------------------------------------------------------- */
/* 2. The well-formed-edge rule                                               */
/* -------------------------------------------------------------------------- */

/**
 * Elements whose content is TEXT to the HTML tokenizer, not markup. A '<' inside
 * them opens nothing, so scanning their interior as markup would refuse honest
 * selections (`a <b` inside a <script> is a comparison, not a tag).
 */
const RAW_TEXT_ELEMENTS: ReadonlySet<string> = new Set([
  'script',
  'style',
  'textarea',
  'title'
]);

/** ASCII letter test: a '<' only opens a tag when a letter (or '/') follows. */
function isAsciiLetter(character: string): boolean {
  return (
    (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z')
  );
}

/**
 * The lower-cased tag name at `open` (which must index a '<'), or undefined when
 * this '<' opens no tag at all and is literal text.
 */
function tagNameAt(html: string, open: number): string | undefined {
  let index = open + 1;
  if (html[index] === '/') {
    index += 1;
  }
  const first = html[index];
  if (first === undefined || !isAsciiLetter(first)) {
    return undefined;
  }
  let end = index;
  while (end < html.length) {
    const character = html[end];
    if (character === '>' || character === '/' || WHITESPACE.test(character)) {
      break;
    }
    end += 1;
  }
  return html.slice(index, end).toLowerCase();
}

/**
 * Offset just past the '>' that closes the tag opened at `open`, quoted
 * attribute values respected, or the end of the text for an unterminated tag
 * (which is markup the selection can only cut through).
 */
function endOfTag(html: string, open: number): number {
  let index = open + 1;
  let quote = '';
  while (index < html.length) {
    const character = html[index];
    if (quote !== '') {
      if (character === quote) {
        quote = '';
      }
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return index + 1;
    }
    index += 1;
  }
  return html.length;
}

/** Case-insensitive literal match of `literal` at `at`. */
function matchesAt(html: string, at: number, literal: string): boolean {
  return html.slice(at, at + literal.length).toLowerCase() === literal;
}

/** Offset of the closing tag of a raw-text element, or the end of the text. */
function endOfRawText(html: string, name: string, from: number): number {
  const closer = `</${name}`;
  let index = from;
  while (index < html.length) {
    const open = html.indexOf('<', index);
    if (open < 0) {
      return html.length;
    }
    if (matchesAt(html, open, closer)) {
      return open;
    }
    index = open + 1;
  }
  return html.length;
}

/**
 * Does the selection [start, end) have a boundary that falls INSIDE a piece of
 * markup: a start or end tag, an HTML comment, a doctype or another `<!` / `<?`
 * declaration?
 *
 * Such a slice is not a well-formed fragment at its edges, and it is not a
 * formattable unit: the engine has to repair the half tag it was handed, and
 * once the provider restores the slice's own edge whitespace the repair no
 * longer shows up as a tree change for the guard to reject. The provider refuses
 * the request outright instead (see the header).
 *
 * A boundary AT a '<' or just past a '>' is outside the construct and fine, as
 * is any boundary inside ordinary character data, inside the text content of a
 * <script>/<style>/<textarea>/<title>, or inside a `<%` ... `%>` template island
 * (a '<' that opens no tag is literal text to the tokenizer, and those islands
 * are protected verbatim elsewhere).
 *
 * Pure and O(n) in the document up to the later boundary.
 */
export function cutsThroughMarkup(
  html: string,
  start: number,
  end: number
): boolean {
  const first = Math.min(start, end);
  const last = Math.max(start, end);
  let index = 0;
  while (index < html.length) {
    const open = html.indexOf('<', index);
    // A construct that starts at or after the later boundary cannot contain
    // either boundary strictly inside it, and neither can any construct after
    // it. Nothing left to find.
    if (open < 0 || open >= last) {
      return false;
    }
    let close: number;
    let name: string | undefined;
    if (matchesAt(html, open, '<!--')) {
      const terminator = html.indexOf('-->', open + 4);
      close = terminator < 0 ? html.length : terminator + 3;
    } else if (matchesAt(html, open, '<!') || matchesAt(html, open, '<?')) {
      const terminator = html.indexOf('>', open);
      close = terminator < 0 ? html.length : terminator + 1;
    } else {
      name = tagNameAt(html, open);
      if (name === undefined) {
        // Not a tag: a literal '<' in text (a comparison, a template island).
        index = open + 1;
        continue;
      }
      close = endOfTag(html, open);
    }
    if ((first > open && first < close) || (last > open && last < close)) {
      return true;
    }
    index = close;
    if (
      name !== undefined &&
      html[open + 1] !== '/' &&
      RAW_TEXT_ELEMENTS.has(name)
    ) {
      // The content is text, not markup: resume scanning at the closing tag.
      index = endOfRawText(html, name, close);
    }
  }
  return false;
}
