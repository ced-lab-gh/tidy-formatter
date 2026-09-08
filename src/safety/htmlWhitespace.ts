// HTML whitespace significance: ONE concept, THREE sources.
//
// "Is this run of spaces drawn, or is it layout the formatter may reflow?" is a
// single question about an element, and HTML answers it from three independent
// mechanisms. The guard used to know only the first two, and each gap was a
// proven accept-when-not-equivalent:
//
//   1. THE PREFORMATTED TAG. pre/xmp/plaintext/listing/textarea are rendered
//      `white-space: pre` (or pre-wrap) by the HTML Rendering spec's default
//      style sheet. Held in src/safety/htmlPreformatted.ts because the PRINTER
//      needs the same list.
//   2. xml:space="preserve". SVG 1.1 (5.9) draws every space inside the
//      declaring subtree. No tag list can express it: the tag is an ordinary
//      <text>.
//   3. CSS white-space. The property the other two are DEFINED in terms of, and
//      the one the guard could not see at all. Proven, applied=true, at document
//      and selection scope:
//        <span style="white-space:pre">NAME      QTY\nfoo         1</span>
//          was written as <span style="white-space:pre">NAME QTY\n  foo 1</span>
//        <div style="white-space:pre-wrap">Hello\n\n    Bob,   how are you?</div>
//          lost its indentation
//        <div style="white-space:pre">def f():\n    return 1</div>
//          had its 4-space Python indent rewritten to 2
//
// THE LATTICE. The three sources do not all say the same thing, so a boolean
// "verbatim" cannot hold the answer. CSS Text distinguishes:
//
//   value                        spaces/tabs      segment breaks
//   normal, nowrap               collapsed        collapsed
//   pre-line                     COLLAPSED        PRESERVED
//   pre, pre-wrap, break-spaces  preserved        preserved
//
// so significance is a three-point lattice `collapse < breaks < verbatim`, and
// pre-line gets its own normalizer instead of being lumped in with pre. Lumping
// it in would be sound but would reject the reflow pre-line genuinely permits;
// modelling it accurately keeps the guard both sound and useful.
//
// INHERITANCE AND SWITCHING OFF. All three mechanisms are inherited by the whole
// subtree, and each is carried down as its OWN field for one reason: a mechanism
// may only switch off what its own kind turned on. `xml:space="default"` cannot
// cancel a <pre> (its `white-space: pre` is CSS and knows nothing about XML),
// and, in the same way, `style="white-space:normal"` on a child of <pre> or of
// an xml:space="preserve" subtree cannot cancel those either. A real cascade
// would let the author sheet beat the UA sheet there; the guard deliberately
// does not, because being STRICTER can only cost a correct rejection, while
// being more permissive is how a silent rewrite gets written to disk.
//
// PURE: imports only the sibling tag list, so the guard and the printer can both
// hold it without pulling anything into either bundle.
import { HTML_PREFORMATTED_TAG_SET } from './htmlPreformatted';

/**
 * How much of a text run is drawn, in increasing strictness.
 *  - `collapse`: runs of ASCII whitespace are layout (the HTML default).
 *  - `breaks`:   segment breaks are drawn, spaces and tabs still collapse
 *                (`white-space: pre-line`, `white-space-collapse:
 *                preserve-breaks`).
 *  - `verbatim`: every byte is drawn (`pre`, `pre-wrap`, `break-spaces`, a
 *                preformatted tag, an xml:space="preserve" subtree).
 */
export type WhitespaceSignificance = 'collapse' | 'breaks' | 'verbatim';

/** Rank in the lattice, so two sources can be combined by taking the maximum. */
const SIGNIFICANCE_RANK: Readonly<Record<WhitespaceSignificance, number>> = {
  collapse: 0,
  breaks: 1,
  verbatim: 2
};

/** The stronger of two significances. */
export function maxSignificance(
  a: WhitespaceSignificance,
  b: WhitespaceSignificance
): WhitespaceSignificance {
  return SIGNIFICANCE_RANK[a] >= SIGNIFICANCE_RANK[b] ? a : b;
}

/** parse5 attribute shape. `prefix` appears on adjusted foreign-content names. */
export interface HtmlAttr {
  name: string;
  value: string;
  prefix?: string;
}

/**
 * The three inherited sources, kept apart so none can switch another off.
 * `tag` and `xmlSpace` are booleans because both are all-or-nothing verbatim;
 * `css` carries the full lattice because pre-line is a middle point.
 */
export interface WhitespaceContext {
  /** An ancestor (or the parent) is a preformatted TAG. */
  readonly tag: boolean;
  /** An ancestor declared xml:space="preserve" and no descendant undid it. */
  readonly xmlSpace: boolean;
  /** The inherited CSS `white-space` significance. */
  readonly css: WhitespaceSignificance;
}

/** A document root: nothing preserves anything yet. */
export const ROOT_WHITESPACE_CONTEXT: WhitespaceContext = Object.freeze({
  tag: false,
  xmlSpace: false,
  css: 'collapse' as WhitespaceSignificance
});

/** Collapse the three sources into the one question the comparison asks. */
export function significanceOf(context: WhitespaceContext): WhitespaceSignificance {
  if (context.tag || context.xmlSpace) {
    return 'verbatim';
  }
  return context.css;
}

// --- normalization ---------------------------------------------------------

/** Runs of the ASCII whitespace the HTML spec treats as collapsible. */
const HTML_SPACE_RUN = /[ \t\n\r\f]+/g;
const HTML_SPACE_EDGES = /^[ \t\n\r\f]+|[ \t\n\r\f]+$/g;
/** Horizontal collapsible whitespace only: a segment break is not one. */
const HTML_HORIZONTAL_RUN = /[ \t\f]+/g;
const HTML_HORIZONTAL_EDGES = /^[ \t\f]+|[ \t\f]+$/g;

/**
 * Collapse only the ASCII whitespace the HTML spec treats as insignificant
 * (space, tab, LF, CR, FF). NOT `\s`, which also matches U+00A0 (`&nbsp;`),
 * U+202F and the U+2000..U+200A family: those are RENDERED characters, so
 * degrading `10&nbsp;km` into `10 km` is a content change the guard must catch.
 *
 * This also fixes the whitespace-only text-node filter in the guard, which uses
 * this function: a node made only of `&nbsp;` is no longer considered blank, so
 * it is no longer silently dropped from the comparison.
 */
export function normalizeHtmlText(text: string): string {
  return text.replace(HTML_SPACE_RUN, ' ').replace(HTML_SPACE_EDGES, '');
}

/**
 * The `white-space: pre-line` normalizer: segment breaks survive, spaces and
 * tabs around and between them collapse.
 *
 * This is the CSS Text collapsing algorithm for `white-space-collapse:
 * preserve-breaks`, which removes collapsible spaces adjacent to a preserved
 * segment break, so each line is collapsed and trimmed independently and the
 * lines are rejoined with the breaks intact. CRLF and CR are folded to LF first
 * because the HTML parser has already done that to the document.
 *
 * It is a strict REFINEMENT of {@link normalizeHtmlText}: any two texts this
 * maps to the same string are also mapped to the same string by the collapsing
 * normalizer, and it additionally separates texts whose line structure differs.
 * So switching a subtree from `collapse` to `breaks` can only ever reject more,
 * never accept more.
 */
export function normalizeHtmlTextPreservingBreaks(text: string): string {
  return text
    .split(/\r\n|\n|\r/)
    .map((line) =>
      line.replace(HTML_HORIZONTAL_RUN, ' ').replace(HTML_HORIZONTAL_EDGES, '')
    )
    .join('\n');
}

/** Normalize a text node for the significance its context gives it. */
export function normalizeTextFor(
  significance: WhitespaceSignificance,
  raw: string
): string {
  if (significance === 'verbatim') {
    return raw;
  }
  if (significance === 'breaks') {
    return normalizeHtmlTextPreservingBreaks(raw);
  }
  return normalizeHtmlText(raw);
}

// --- source 2: xml:space ---------------------------------------------------

/**
 * The `xml:space` declaration an element carries, or undefined when it makes
 * none.
 *
 * SVG 1.1 (5.9 "White space handling") draws EVERY space character inside a
 * subtree declared `xml:space="preserve"`, exactly the way the HTML Rendering
 * spec draws whitespace inside `<pre>`. The preformatted TAG list could not see
 * it because it keys on the TAG, and the tag here is an ordinary `<text>` or
 * `<tspan>`: the collapsing normalizer then flattened the run, and
 * `<text xml:space="preserve">A  B</text>` was rewritten to `A B`, applied,
 * with two drawn spaces silently reduced to one.
 *
 * Two spellings must be recognised because parse5 adjusts foreign-content
 * attributes: in the SVG namespace the attribute arrives as
 * `{ prefix: 'xml', name: 'space' }`, on an ordinary HTML element as the single
 * name `'xml:space'`. An unrecognised value (anything but the two enumerated
 * keywords) is read as NO declaration, so the inherited context stands: the
 * conservative direction, since it can only keep preservation on.
 *
 * WHY THIS IS A CORRECT REJECTION AND NOT A CORRECT FORMAT. The preformatted
 * TAGS are also handed to js-beautify as `content_unformatted`, so the printer
 * never touches them and the file formats cleanly. `content_unformatted` takes
 * TAG NAMES only: js-beautify exposes no way to say "leave this element alone
 * because of an attribute it carries", and widening it to `text`/`tspan` would
 * freeze every SVG label whether or not it declares xml:space. So the printer
 * still collapses the run, the guard now sees it, and Tidy declines the edit
 * with the file intact. That is the fail-safe half of the promise; teaching the
 * printer would need the mask-and-restore machinery of src/engine/maskPlan.ts to
 * grow a fourth, element-scoped layer, which is a change of a different size.
 */
export function xmlSpaceDeclaration(
  attrs: HtmlAttr[] | undefined
): 'preserve' | 'default' | undefined {
  if (!Array.isArray(attrs)) {
    return undefined;
  }
  for (const attr of attrs) {
    const isXmlSpace =
      attr.name === 'xml:space' || (attr.prefix === 'xml' && attr.name === 'space');
    if (!isXmlSpace) {
      continue;
    }
    const value = attr.value.trim();
    if (value === 'preserve') {
      return 'preserve';
    }
    if (value === 'default') {
      return 'default';
    }
  }
  return undefined;
}

// --- source 3: CSS white-space ---------------------------------------------

/**
 * Collapse-component keywords that leave whitespace collapsible. `discard` is
 * one: it removes whitespace outright, which no reflow can make visible.
 */
const CSS_WS_COLLAPSE: ReadonlySet<string> = new Set(['collapse', 'discard']);

/**
 * `text-wrap-mode` keywords. They contribute NOTHING to significance on purpose:
 * `nowrap` forbids line BREAKING, it does not preserve a run of spaces, so
 * rejecting a reflow under `white-space: nowrap` would be a false reject (the
 * same reasoning keeps `nobr` out of the preformatted tag list). They are still
 * counted, because two of them in one value is not a value at all.
 */
const CSS_WS_WRAP_COMPONENT: ReadonlySet<string> = new Set(['wrap', 'nowrap']);

/**
 * The four shorthand keywords that stand ALONE. `white-space: pre nowrap` does
 * not parse, so a renderer drops it and the inherited value stands, which is
 * why combining one of these with anything answers `inherit`.
 */
const CSS_WS_SOLE_SHORTHAND_SIGNIFICANCE: Readonly<Record<string, WhitespaceSignificance>> = {
  normal: 'collapse',
  pre: 'verbatim',
  'pre-wrap': 'verbatim',
  'pre-line': 'breaks'
};
const CSS_WS_SOLE_SHORTHAND: ReadonlySet<string> = new Set(
  Object.keys(CSS_WS_SOLE_SHORTHAND_SIGNIFICANCE)
);

/**
 * `white-space-trim` keywords. They read as collapsing ONLY if the browser
 * accepts the declaration, and no shipping browser implements `white-space-trim`
 * today, so `white-space: none` is a value every current renderer DROPS. A
 * dropped declaration leaves the inherited value standing, which is why these
 * must answer `inherit` and not `collapse`: under a `<pre>` or a preserving
 * ancestor the two answers differ, and reading them as `collapse` cancelled a
 * preservation the renderer keeps, so a run of drawn spaces was rewritten.
 * `inherit` is also the right answer under the optimistic reading, because a
 * trim keyword alone leaves `white-space-collapse` at its initial value, which
 * is what the parent already contributes here.
 */
const CSS_WS_TRIM_ONLY: ReadonlySet<string> = new Set([
  'none',
  'discard-before',
  'discard-after',
  'discard-inner'
]);

/** Keywords that draw segment breaks but still collapse spaces and tabs. */
const CSS_WS_BREAKS: ReadonlySet<string> = new Set(['preserve-breaks']);

/**
 * Keywords that draw every space. `preserve-spaces` is here although it turns
 * segment breaks into spaces: treating it as fully verbatim is STRICTER than it
 * is, which is the safe direction for a verifier.
 */
const CSS_WS_VERBATIM: ReadonlySet<string> = new Set([
  'break-spaces',
  'preserve',
  'preserve-spaces'
]);

/**
 * CSS-wide keywords that resolve to the inherited value. `revert` and
 * `revert-layer` resolve to the UA sheet, whose preformatted elements are
 * already covered by the TAG source, so reading them as "inherited stands" is
 * never weaker than the truth.
 */
const CSS_WIDE_INHERIT: ReadonlySet<string> = new Set([
  'inherit',
  'unset',
  'revert',
  'revert-layer'
]);

/** The two properties that decide whether whitespace is drawn. */
const CSS_WHITE_SPACE_PROPERTIES: ReadonlySet<string> = new Set([
  'white-space',
  'white-space-collapse'
]);

/**
 * The ONLY two ways a `white-space` (or `white-space-collapse`) declaration can
 * be spelled: the property name written out, in any ASCII case, or a backslash
 * somewhere, which is the only mechanism CSS gives for spelling an ident any
 * other way.
 *
 * SOUNDNESS OF THE SHORTCUT. A property name is a single ident token; it cannot
 * be split by a comment or by whitespace, and property names are ASCII
 * case-insensitive. So a text containing neither the literal substring nor a
 * backslash contains no such declaration, and skipping the full read is not a
 * guess. The test can only ever run the full read MORE often than needed, which
 * costs time and never a verdict. Placed here, next to the two readers it
 * guards, so the two can never drift apart.
 *
 * No `g` flag: this is used with `.test`, where a `g` regex would carry
 * `lastIndex` between calls and start skipping matches.
 */
const MAY_DECLARE_WHITE_SPACE = /white-space|\\/i;

/**
 * True when `text` could possibly contain a `white-space` declaration. A false
 * answer is a proof of absence (see {@link MAY_DECLARE_WHITE_SPACE}); a true
 * answer only means "look properly".
 */
export function mayDeclareWhiteSpace(text: string): boolean {
  return MAY_DECLARE_WHITE_SPACE.test(text);
}

/**
 * What one `white-space` / `white-space-collapse` declaration asks for.
 * `'inherit'` means the declaration is valid and defers to the parent.
 */
type CssWhitespaceDeclaration = WhitespaceSignificance | 'inherit';

/**
 * U+FFFD, the character CSS substitutes for an out-of-range escape. Built from
 * its code point so no non-ASCII byte ships in a source file.
 */
const REPLACEMENT_CHAR = String.fromCodePoint(0xfffd);

/**
 * Decode the CSS escape sequences a property name may carry (`\77 hite-space`
 * is a legal spelling of `white-space`). Without this, an escaped property name
 * would read as an unknown property and the declaration would be MISSED, which
 * is the one direction that is not safe.
 *
 * Used on a declaration's property name, and on a whole stylesheet as the second
 * pass of {@link cssTextPreservesWhitespace}. On a whole sheet it also decodes
 * escapes inside strings, which is harmless here: this text is only ever
 * searched for a property name, never interpreted.
 */
function decodeCssEscapes(raw: string): string {
  if (!raw.includes('\\')) {
    return raw;
  }
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] !== '\\') {
      out += raw[i];
      continue;
    }
    const hex = /^([0-9a-fA-F]{1,6})[ \t\n\r\f]?/.exec(raw.slice(i + 1));
    if (hex) {
      const code = Number.parseInt(hex[1], 16);
      out += code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : REPLACEMENT_CHAR;
      i += hex[0].length;
      continue;
    }
    if (i + 1 < raw.length) {
      out += raw[i + 1];
      i += 1;
    }
  }
  return out;
}

/**
 * Classify the value of a `white-space` / `white-space-collapse` declaration.
 *
 * FAIL CLOSED IS THE DEFAULT. Anything this function cannot read as a known
 * keyword becomes `'verbatim'`: a `var()`, an `env()`, a vendor value such as
 * `-moz-pre-wrap`, an escaped value, a keyword a future CSS level adds. A
 * browser may well be preserving whitespace there, and the guard must not assume
 * it is not. The cost of the conservative answer is a correct rejection with the
 * file untouched; the cost of the permissive answer is a rewrite of text a
 * reader can see.
 */
function classifyCssWhitespaceValue(rawValue: string): CssWhitespaceDeclaration {
  const value = rawValue
    .replace(/!\s*important\s*$/i, '')
    .trim()
    .toLowerCase();
  if (value === '') {
    // Not a declaration at all: nothing is asked for, the parent value stands.
    return 'inherit';
  }
  // A function, a string or an escape hides a value that cannot be resolved here.
  if (/[\\"'()]/.test(value)) {
    return 'verbatim';
  }
  const keywords = value.split(/[ \t\n\r\f]+/).filter((word) => word !== '');
  if (keywords.length === 1 && CSS_WIDE_INHERIT.has(keywords[0])) {
    return 'inherit';
  }
  if (keywords.length === 1 && keywords[0] === 'initial') {
    // The initial value of both properties collapses.
    return 'collapse';
  }
  // The shorthand is `<collapse mode> || <wrap mode> || <trim>`, so a VALID
  // value carries at most one keyword from each component. An invalid one is
  // dropped by the renderer, which leaves the inherited value standing: that is
  // why the answer for anything ill-formed is `inherit` and not `collapse`.
  // The difference only shows under a preserving ancestor, and there `collapse`
  // was cancelling a preservation the renderer keeps, rewriting drawn spaces.
  let significance: WhitespaceSignificance = 'collapse';
  let collapseComponents = 0;
  let wrapComponents = 0;
  for (const keyword of keywords) {
    if (CSS_WS_TRIM_ONLY.has(keyword)) {
      return 'inherit';
    }
    if (CSS_WS_SOLE_SHORTHAND.has(keyword)) {
      if (keywords.length > 1) {
        // `pre`, `pre-wrap`, `pre-line` and `normal` stand alone; combined with
        // anything they do not parse, so nothing is declared.
        return 'inherit';
      }
      return CSS_WS_SOLE_SHORTHAND_SIGNIFICANCE[keyword];
    }
    if (CSS_WS_WRAP_COMPONENT.has(keyword)) {
      wrapComponents += 1;
      continue;
    }
    if (CSS_WS_COLLAPSE.has(keyword)) {
      collapseComponents += 1;
      continue;
    }
    if (CSS_WS_BREAKS.has(keyword)) {
      collapseComponents += 1;
      significance = maxSignificance(significance, 'breaks');
      continue;
    }
    if (CSS_WS_VERBATIM.has(keyword)) {
      // Nothing further can raise it; `verbatim` is the top of the lattice, and
      // a duplicate collapse component below could only make it `inherit`, which
      // under a preserving ancestor resolves back to `verbatim` anyway.
      return 'verbatim';
    }
    // FAIL CLOSED. A keyword this module does not know may well preserve
    // whitespace in the browser that renders the file, and the two answers are
    // not symmetric: a wrong `verbatim` costs a correct rejection, a wrong
    // `collapse` costs a silent rewrite of text a reader can see.
    return 'verbatim';
  }
  if (collapseComponents > 1 || wrapComponents > 1) {
    // Two keywords from one component: not a value, so nothing is declared.
    return 'inherit';
  }
  return significance;
}

/**
 * Split a declaration list into `prop: value` pairs, respecting the three things
 * a naive `split(';')` gets wrong: quoted strings (`background:url("a;b")`),
 * parentheses (`grid-template:repeat(2, 1fr)`) and comments.
 *
 * Quotes are tracked BEFORE comments on purpose, so a comment opener sitting
 * inside a string cannot start a comment and swallow a real declaration behind
 * it.
 */
function splitCssDeclarations(text: string): Array<{ prop: string; value: string }> {
  const declarations: Array<{ prop: string; value: string }> = [];
  let current = '';
  let quote: string | undefined;
  let depth = 0;
  let inComment = false;

  const flush = (): void => {
    const separator = current.indexOf(':');
    if (separator > 0) {
      declarations.push({
        prop: decodeCssEscapes(current.slice(0, separator).trim()).toLowerCase(),
        value: current.slice(separator + 1)
      });
    }
    current = '';
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inComment) {
      if (char === '*' && text[i + 1] === '/') {
        inComment = false;
        i += 1;
        current += ' ';
      }
      continue;
    }
    if (quote !== undefined) {
      current += char;
      if (char === '\\') {
        if (i + 1 < text.length) {
          current += text[i + 1];
          i += 1;
        }
        continue;
      }
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '/' && text[i + 1] === '*') {
      inComment = true;
      i += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === '(') {
      depth += 1;
      current += char;
      continue;
    }
    if (char === ')') {
      depth = Math.max(0, depth - 1);
      current += char;
      continue;
    }
    if (char === ';' && depth === 0) {
      flush();
      continue;
    }
    current += char;
  }
  flush();
  return declarations;
}

/**
 * The CSS whitespace significance an element declares in its `style` attribute,
 * or undefined when it declares none (so the inherited value stands).
 *
 * Declarations are read IN ORDER and the last valid one wins, which is what the
 * cascade does inside a single declaration block. That is also why the shorthand
 * and the longhand need no special pairing: `white-space:pre;
 * white-space-collapse:collapse` ends collapsing, and
 * `white-space-collapse:preserve; white-space:normal` ends collapsing too,
 * because the shorthand resets the longhand.
 */
export function cssWhitespaceDeclaration(
  attrs: HtmlAttr[] | undefined
): WhitespaceSignificance | undefined {
  if (!Array.isArray(attrs)) {
    return undefined;
  }
  // Matched on the local name alone. parse5 lower-cases attribute names and
  // never splits a prefix off `style`, so the extra tolerance costs nothing and
  // removes the one direction that would be unsafe: MISSING a style attribute.
  const styleAttr = attrs.find((attr) => attr.name.toLowerCase() === 'style');
  if (styleAttr === undefined || !mayDeclareWhiteSpace(styleAttr.value)) {
    return undefined;
  }
  let declared: CssWhitespaceDeclaration | undefined;
  for (const declaration of splitCssDeclarations(styleAttr.value)) {
    if (CSS_WHITE_SPACE_PROPERTIES.has(declaration.prop)) {
      declared = classifyCssWhitespaceValue(declaration.value);
    }
  }
  if (declared === undefined || declared === 'inherit') {
    return undefined;
  }
  return declared;
}

// --- the embedded <style> route, and why it fails closed -------------------

/**
 * Every `white-space` / `white-space-collapse` declaration in a stylesheet, with
 * the value that follows it. Deliberately reads the RAW text rather than a
 * parsed AST: a stylesheet the CSS parser rejects must still be scanned, and a
 * regex that over-matches can only produce a rejection, never an acceptance.
 *
 * The leading boundary stops `-vendor-white-space` from matching; the value runs
 * to the first `;` or brace.
 */
const CSS_WHITE_SPACE_IN_SHEET = /(?:^|[\s;{}(])white-space(?:-collapse)?\s*:\s*([^;{}]*)/gi;

/**
 * True when a stylesheet contains ANY declaration that would make whitespace
 * drawn (`pre`, `pre-wrap`, `pre-line`, `break-spaces`, `white-space-collapse:
 * preserve`, or a value this module cannot read).
 *
 * WHY THIS IS A SCAN AND NOT A MATCH. The third source is also reachable without
 * a `style` attribute: `<style>.log{white-space:pre-wrap}</style>` plus
 * `class="log"` on the element. Answering "does this rule apply to that element"
 * is CSS selector matching against the tree, specificity and cascade order
 * included: a second parser, of exactly the kind whose absence is what this
 * guard is for. That is deliberately out of scope here, so the guard FAILS
 * CLOSED instead: a document whose embedded CSS sets a preserving white-space
 * value on anything is REJECTED rather than reflowed on the bet that the rule
 * matches nothing the formatter touched. The file is left byte-identical and the
 * user is told why; the alternative was a silent rewrite of drawn text.
 *
 * KNOWN BOUNDARY, stated rather than hidden: a stylesheet the document only
 * LINKS to (`<link rel="stylesheet">`) is not in the file, so no file-local
 * verifier can see it. Failing closed on the mere presence of a `<link>` would
 * reject essentially every real page, which is not a safety property but a
 * refusal to work. That case stays outside what this guard can decide.
 */
export function cssTextPreservesWhitespace(css: string): boolean {
  if (!mayDeclareWhiteSpace(css)) {
    return false;
  }
  if (scanSheetForPreservedWhitespace(css)) {
    return true;
  }
  // The scan needs a boundary character before the property name, and a comment
  // glued to it (`color:red;/*x*/white-space:pre-wrap`) supplies `/`, which is
  // not one. A browser's tokenizer drops the comment and sees the declaration,
  // so scan a copy with comments replaced by a space, which is exactly what the
  // tokenizer leaves behind. Both passes run and either match is enough to
  // refuse: removing a comment can also hide a `white-space` spelled INSIDE a
  // string that merely looks like one, and dropping the raw pass for the
  // stripped one would turn that into an acceptance.
  if (css.includes('/*')) {
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, ' ');
    if (withoutComments !== css && scanSheetForPreservedWhitespace(withoutComments)) {
      return true;
    }
  }
  // The scan above matches the property name LITERALLY, so an escaped spelling
  // (`\77 hite-space`) would slip past it. Rather than refuse every stylesheet
  // that contains a backslash (which would take out any sheet using
  // `content: "\f101"` for an icon font), decode the escapes and scan again.
  // Decoding is the CSS unescaping rule, so the second pass sees exactly what a
  // browser's tokenizer sees; both passes run because a decode can only add or
  // move text, and a match found in either one is enough to refuse.
  if (css.includes('\\')) {
    const decoded = decodeCssEscapes(css);
    if (scanSheetForPreservedWhitespace(decoded)) {
      return true;
    }
    // An escaped spelling can ALSO sit behind a comment, so the two evasions
    // compose; scan the variant that has both undone.
    if (decoded.includes('/*')) {
      return scanSheetForPreservedWhitespace(decoded.replace(/\/\*[\s\S]*?\*\//g, ' '));
    }
  }
  return false;
}

/** One pass of {@link CSS_WHITE_SPACE_IN_SHEET} over a stylesheet. */
function scanSheetForPreservedWhitespace(css: string): boolean {
  CSS_WHITE_SPACE_IN_SHEET.lastIndex = 0;
  let match = CSS_WHITE_SPACE_IN_SHEET.exec(css);
  while (match !== null) {
    const classified = classifyCssWhitespaceValue(match[1]);
    if (classified === 'breaks' || classified === 'verbatim') {
      return true;
    }
    match = CSS_WHITE_SPACE_IN_SHEET.exec(css);
  }
  return false;
}

/** The sentence the OutputChannel shows when the fail-closed rule fires. */
export const EMBEDDED_CSS_WHITESPACE_REASON =
  'embedded CSS sets a preserving white-space value; ' +
  'which elements it applies to cannot be decided without matching CSS selectors, ' +
  'so Tidy did not write this format';

// --- inheritance -----------------------------------------------------------

/**
 * The whitespace context an element gives its CHILDREN, from the context it was
 * given and what it declares itself.
 *
 * Each source is updated only by its own kind, which is what stops one mechanism
 * cancelling another: a `<pre>` turns `tag` on and nothing but leaving the
 * subtree turns it off; `xml:space="default"` clears only `xmlSpace`;
 * `style="white-space:normal"` lowers only `css`.
 */
export function childWhitespaceContext(
  context: WhitespaceContext,
  tagName: string | undefined,
  attrs: HtmlAttr[] | undefined
): WhitespaceContext {
  const tag =
    context.tag || (tagName !== undefined && HTML_PREFORMATTED_TAG_SET.has(tagName));
  const declaredXmlSpace = xmlSpaceDeclaration(attrs);
  const xmlSpace =
    declaredXmlSpace === undefined ? context.xmlSpace : declaredXmlSpace === 'preserve';
  const declaredCss = cssWhitespaceDeclaration(attrs);
  const css = declaredCss === undefined ? context.css : declaredCss;
  if (tag === context.tag && xmlSpace === context.xmlSpace && css === context.css) {
    return context;
  }
  return { tag, xmlSpace, css };
}
