// Safety guard: semantic-equivalence-modulo-whitespace check applied after every
// format. If the output is NOT equivalent (or not parsable), nothing is applied
// and VS Code never touches the file.
//
// Acceptance test (mandatory): JSX input '<Foo bar={x} />' formatted to
// '< Foo bar = {x} />' (which still re-parses as valid TSX) MUST be rejected by
// the guard. See `astEqualJs` for why a pure structural AST diff is insufficient
// here and how the JSX tag-boundary integrity check closes the gap.
//
// MUST NOT import 'vscode' (testable under mocha + tsx).
import { parse as babelParse, type ParserOptions } from '@babel/parser';
import { parse as parseCss, type Node as PostcssNode } from 'postcss';
import { parse as parseScss } from 'postcss-scss';
import { parse as parseLess } from 'postcss-less';
import { parse as parseHtml, parseFragment as parseHtmlFragment } from 'parse5';
import { parse as parseJsonc, ParseError, printParseErrorCode } from 'jsonc-parser';
import type { Guard, GuardVerdict, LangId } from '../types';

// --- shared verdicts -------------------------------------------------------

const EQUIVALENT: GuardVerdict = { equivalent: true };

function rejected(reason: string): GuardVerdict {
  return { equivalent: false, reason };
}

/**
 * Normalize an error of unknown shape into a short, code-free message.
 * The OutputChannel must never receive user source code, only a summary.
 */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    // Parser errors often embed a code frame after the first line — drop it.
    return error.message.split('\n')[0];
  }
  return 'unexpected error';
}

// --- JS / TS / JSX / TSX ---------------------------------------------------

// Base plugins shared by every JS-family language. `decoratorAutoAccessors`
// covers the TC39 stage-3 `accessor` class field (which prettier formats), so a
// valid file using it is not falsely rejected at the INPUT parse step.
// Non-nullable plugin-list type so callers can iterate without a null-check.
type BabelPlugins = NonNullable<ParserOptions['plugins']>;

const BASE_BABEL_PLUGINS: BabelPlugins = [
  'typescript',
  'decorators-legacy',
  'decoratorAutoAccessors'
];

// Plugins for languages where JSX is part of the grammar (jsx / tsx, and plain
// .js/.ts where the dispatcher detected JSX). Adding `jsx` here is REQUIRED for
// those, but it must NOT be enabled for plain `typescript`: in jsx mode a legacy
// angle-bracket cast `<T>expr` is mis-read as a JSX element and fails to parse,
// which would no-op a valid `.ts` file (SPEC §12 "faux positif de la garde").
const BABEL_PLUGINS_JSX: BabelPlugins = [...BASE_BABEL_PLUGINS, 'jsx'];

// Plain TypeScript / JavaScript: no `jsx`, so `<T>expr` casts and other
// JSX-ambiguous TS syntax parse correctly.
const BABEL_PLUGINS_NO_JSX: BabelPlugins = [...BASE_BABEL_PLUGINS];

// Only plain `typescript` parses WITHOUT the jsx plugin. In a `.ts` file the
// angle-bracket cast `<T>expr` is valid TS but, with jsx enabled, is mis-read as
// a JSX element and fails to parse. Every other JS-family languageId may legally
// contain JSX (a React `.js`/`.jsx`, or `.tsx`), so jsx stays enabled there —
// `.tsx` cannot use angle casts anyway, so there is no ambiguity to resolve.
const NO_JSX_LANGS: ReadonlySet<LangId> = new Set<LangId>(['typescript']);

/**
 * Choose the babel plugin set for a given language. JSX is enabled everywhere in
 * the JS family except plain `typescript` (to keep angle-bracket casts valid).
 * When no language is supplied, default to the full superset so the exported
 * `astEqualJs` keeps accepting JSX/TSX directly.
 */
function babelPluginsFor(lang: LangId | undefined): BabelPlugins {
  if (lang !== undefined && NO_JSX_LANGS.has(lang)) {
    return BABEL_PLUGINS_NO_JSX;
  }
  return BABEL_PLUGINS_JSX;
}

// AST keys that carry source positions, comments, or raw text rather than
// structure. Stripping them yields a "semantic AST modulo whitespace/style".
const STRUCTURAL_IGNORE_KEYS = new Set<string>([
  'start',
  'end',
  'loc',
  'range',
  'leadingComments',
  'trailingComments',
  'innerComments',
  'comments',
  'extra',
  'tokens',
  'errors',
  'parenStart'
]);

function parseJsAst(code: string, plugins: BabelPlugins): unknown {
  return babelParse(code, {
    sourceType: 'unambiguous',
    allowReturnOutsideFunction: true,
    allowImportExportEverywhere: true,
    errorRecovery: false,
    plugins
  }).program;
}

/**
 * Apply JSX whitespace coalescing (the same algorithm Babel/React use for
 * JSXText children) so that the insignificant whitespace/newlines a formatter
 * freely adds or removes between JSX children do not register as a structural
 * change. Returns the "rendered" text; an all-whitespace JSXText collapses to ''.
 *
 * Without this, legitimate multi-line JSX reflow (e.g. Prettier turning
 * `<div><h1/><span/></div>` into an indented block) inserts whitespace-only
 * JSXText nodes the input did not have, and a raw structural diff would reject
 * the (correct) output — the "safe but does nothing" false positive on TSX.
 */
function cleanJsxText(value: string): string {
  const lines = value.split(/\r\n|\n|\r/);
  let lastNonEmptyLine = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/[^ \t]/.test(lines[i])) {
      lastNonEmptyLine = i;
    }
  }
  let str = '';
  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i].replace(/\t/g, ' ');
    if (i !== 0) {
      line = line.replace(/^ +/, '');
    }
    if (i !== lines.length - 1) {
      line = line.replace(/ +$/, '');
    }
    if (line) {
      if (i !== lastNonEmptyLine) {
        line += ' ';
      }
      str += line;
    }
  }
  return str;
}

// Sentinel for AST nodes that are semantically insignificant (e.g. a
// whitespace-only JSXText) and must be dropped from their parent array rather
// than compared.
const DROP_NODE = Symbol('drop-node');

/**
 * Recursively serialize an AST into a canonical string that ignores positions,
 * comments, and raw text, so two structurally identical trees compare equal
 * regardless of whitespace/style. JSXText is normalized via `cleanJsxText` and
 * dropped when it renders to nothing.
 */
function canonicalizeAst(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(canonicalizeAst).filter((item) => item !== DROP_NODE);
  }
  if (node !== null && typeof node === 'object') {
    const source = node as Record<string, unknown>;
    // JSXText carries formatter-insignificant whitespace. Normalize it the way
    // JSX itself renders text; if it collapses to nothing, drop the node.
    if (source.type === 'JSXText' && typeof source.value === 'string') {
      const cleaned = cleanJsxText(source.value);
      return cleaned === '' ? DROP_NODE : { type: 'JSXText', value: cleaned };
    }
    const result: Record<string, unknown> = {};
    // Sort keys so object property order from the parser never affects equality.
    for (const key of Object.keys(source).sort()) {
      if (STRUCTURAL_IGNORE_KEYS.has(key)) {
        continue;
      }
      const value = canonicalizeAst(source[key]);
      // A dropped child reached via a non-array field carries no structure.
      if (value === DROP_NODE) {
        continue;
      }
      result[key] = value;
    }
    return result;
  }
  return node;
}

/**
 * Tokenise with @babel/parser and report, for every JSX tag, whether the
 * tag-OPENING punctuator `<` is immediately adjacent to whatever follows it
 * (the element name, a `/` of a closing tag, or the `/` of `< />`).
 *
 * Why this exists: in babel's JSX grammar, whitespace inside a tag is
 * insignificant, so `<Foo bar={x} />` and `< Foo bar = {x} />` produce IDENTICAL
 * ASTs and identical token-type streams. A pure structural AST diff would wrongly
 * accept the mangled form. Real JSX (and the source author's intent) requires the
 * tag-open `<` to be glued to its name (and the closing-tag `</` to stay intact);
 * a formatter that inserts `< Foo` or `< /Foo>` has corrupted the source even
 * though it still parses. Comparing the open-adjacency fingerprint of input vs
 * output catches exactly that class of corruption.
 *
 * Why ONLY the opening `<` and NOT the closing `>`:
 *   The tag-closing `>` of a non-self-closing element may legitimately land on
 *   its own line when a formatter explodes a long attribute list, e.g. Prettier
 *   turning `<div a={1} b={2}>` into
 *       <div
 *         a={1}
 *         b={2}
 *       >
 *   Here the bare `>` is correctly NOT adjacent to the preceding token, yet the
 *   element is 100% intact and semantically identical. An earlier version also
 *   fingerprinted the `>` adjacency (`close:glued|split`) and therefore
 *   FALSE-POSITIVE-REJECTED this routine multi-line reflow, turning Tidy into a
 *   silent no-op on any real-world .tsx component with wrapped attributes — the
 *   "safe but does nothing" failure the SPEC forbids (§12 "faux positif de la
 *   garde"). The closing `>` carries no boundary-integrity signal a formatter is
 *   not allowed to touch, so it is excluded. Every genuine boundary corruption
 *   (`< Foo`, `< Foo>`, `</Foo>` -> `< /Foo>`, `<Foo / >`) detaches an OPENING
 *   `<` and is still caught by the open-adjacency check; tag renames and dropped
 *   attributes are caught independently by the structural AST diff.
 */
function jsxBoundaryFingerprint(code: string, plugins: BabelPlugins): string {
  const ast = babelParse(code, {
    sourceType: 'unambiguous',
    allowReturnOutsideFunction: true,
    allowImportExportEverywhere: true,
    errorRecovery: false,
    tokens: true,
    plugins
  });
  const tokens = (ast.tokens ?? []) as Array<{
    start: number;
    end: number;
    type: unknown;
  }>;
  const labelOf = (token: { type: unknown }): string => {
    const type = token.type as { label?: string } | string | undefined;
    if (type && typeof type === 'object' && typeof type.label === 'string') {
      return type.label;
    }
    return String(type);
  };

  const marks: string[] = [];
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const current = tokens[i];
    const next = tokens[i + 1];
    const currentLabel = labelOf(current);
    // `<` opening a JSX tag (open OR close tag) must be glued to whatever follows
    // it (name, or the `/` of `</tag>` / `< />`). A detached `<` is corruption.
    if (currentLabel === 'jsxTagStart') {
      marks.push(`open:${next.start === current.end ? 'glued' : 'split'}`);
    }
  }
  return marks.join('|');
}

/**
 * Structural AST equality for JS/TS/JSX/TSX using @babel/parser, ignoring source
 * positions and comments (semantic equivalence modulo whitespace/style), plus a
 * JSX tag-boundary integrity check (see `jsxBoundaryFingerprint`).
 */
export function astEqualJs(input: string, output: string, lang?: LangId): GuardVerdict {
  const plugins = babelPluginsFor(lang);
  const jsxEnabled = plugins.some((plugin) => plugin === 'jsx');

  let inputAst: unknown;
  try {
    inputAst = parseJsAst(input, plugins);
  } catch (error: unknown) {
    // The original source did not parse. We cannot prove equivalence, so we are
    // conservative and refuse to apply (the file is left untouched upstream).
    return rejected(`input did not parse: ${describeError(error)}`);
  }

  let outputAst: unknown;
  try {
    outputAst = parseJsAst(output, plugins);
  } catch (error: unknown) {
    return rejected(`formatted output did not parse: ${describeError(error)}`);
  }

  const inputCanonical = JSON.stringify(canonicalizeAst(inputAst));
  const outputCanonical = JSON.stringify(canonicalizeAst(outputAst));
  if (inputCanonical !== outputCanonical) {
    return rejected('AST structure changed after formatting');
  }

  // ASTs match — now defend against the whitespace-insignificant JSX corruption
  // class that a structural diff alone cannot see. Only meaningful when the
  // grammar actually contains JSX; for plain TS/JS there are no JSX tags.
  if (jsxEnabled) {
    try {
      const inputJsx = jsxBoundaryFingerprint(input, plugins);
      const outputJsx = jsxBoundaryFingerprint(output, plugins);
      if (inputJsx !== outputJsx) {
        return rejected('JSX tag boundaries were altered by formatting');
      }
    } catch (error: unknown) {
      // Tokenisation should not fail when parsing already succeeded; if it does,
      // stay conservative rather than silently accepting.
      return rejected(`could not verify JSX integrity: ${describeError(error)}`);
    }
  }

  return EQUIVALENT;
}

// --- CSS / SCSS / LESS -----------------------------------------------------

type CssParser = (css: string) => PostcssNode;

function cssParserFor(lang: LangId): CssParser {
  switch (lang) {
    case 'scss':
      return parseScss as unknown as CssParser;
    case 'less':
      return parseLess as unknown as CssParser;
    case 'css':
    default:
      return parseCss as unknown as CssParser;
  }
}

/**
 * Split a CSS token string into alternating spans, tagging each as a quoted
 * string literal (`"..."` / `'...'`, honouring `\` escapes) or unquoted text.
 * Quoted spans must be preserved VERBATIM: whitespace inside a CSS string is
 * literal and meaning-bearing (content rendering, `[attr="..."]` matching, a
 * quoted font-family name), so collapsing it would change the file's meaning —
 * the guard false-negative this guards against (SPEC §12 "faux négatif").
 * An unterminated quote (malformed input) keeps the rest as a quoted span so we
 * never accidentally normalise inside it.
 */
interface CssSpan {
  text: string;
  quoted: boolean;
}

function splitCssQuotedSpans(value: string): CssSpan[] {
  const spans: CssSpan[] = [];
  let buffer = '';
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (quote === null) {
      if (ch === '"' || ch === "'") {
        if (buffer !== '') {
          spans.push({ text: buffer, quoted: false });
          buffer = '';
        }
        quote = ch;
        buffer = ch;
      } else {
        buffer += ch;
      }
    } else {
      buffer += ch;
      if (ch === '\\' && i + 1 < value.length) {
        // Escaped char inside the string — consume the next char verbatim.
        buffer += value[i + 1];
        i += 1;
      } else if (ch === quote) {
        spans.push({ text: buffer, quoted: true });
        buffer = '';
        quote = null;
      }
    }
  }
  if (buffer !== '') {
    spans.push({ text: buffer, quoted: quote !== null });
  }
  return spans;
}

/**
 * Apply a normalisation function only to the UNQUOTED spans of a CSS token
 * string, leaving quoted string literals byte-identical.
 */
function normalizeOutsideStrings(value: string, normalizeSpan: (s: string) => string): string {
  return splitCssQuotedSpans(value)
    .map((span) => (span.quoted ? span.text : normalizeSpan(span.text)))
    .join('');
}

/**
 * Normalize whitespace in a CSS token string the way CSS itself treats it as
 * insignificant, WITHOUT erasing whitespace that carries meaning:
 *  - runs of whitespace collapse to a single space (`a  ,  b` -> `a , b`),
 *  - whitespace immediately inside/around the structural delimiters `( ) ,` is
 *    removed (so `calc( 1px + 2px )` === `calc(1px + 2px)` and
 *    `Arial , sans-serif` === `Arial,sans-serif`),
 *  - whitespace around a combinator at the SELECTOR level (`>`, `~` and the
 *    adjacent-sibling `+`) is removed, because `#a > #b` and `#a>#b` are the
 *    SAME selector — CSS treats that whitespace as insignificant. Without this
 *    the guard false-positive-rejects js-beautify's own valid output (it emits
 *    `#a>#b`), turning the formatter into a no-op on nearly every real
 *    stylesheet (SPEC §12 "faux positif de la garde", issue #67).
 *
 * Whitespace INSIDE a quoted string literal is never touched (see
 * `splitCssQuotedSpans`): `content:"a  b"` must NOT be equated with
 * `content:"a b"` — that is a real meaning change the guard must catch.
 *
 * Crucially, whitespace BETWEEN two value tokens with NO combinator is
 * preserved, so:
 *  - a corruption such as `:nth-child(2n)` -> `:nth-child(2 n)` (#77/#78) still
 *    registers as a change and is rejected,
 *  - the descendant combinator `.a .b` stays distinct from the child combinator
 *    `.a>.b` (a meaningful space must remain meaningful).
 *
 * The combinator normalization is only applied to `selector` text (see
 * `cssShape`), never to declaration values, so it cannot mask a real value
 * change such as `+`/`-` arithmetic inside `calc()`.
 */
function normalizeCssTextSpan(span: string): string {
  return span.replace(/\s+/g, ' ').replace(/\s*([(),])\s*/g, '$1');
}

function normalizeCssText(value: string | undefined): string {
  if (value === undefined || value === null) {
    return '';
  }
  return normalizeOutsideStrings(value, normalizeCssTextSpan).trim();
}

/**
 * Selector-specific normalization: in addition to the generic whitespace rules,
 * collapse whitespace around the CSS combinators `>`, `~`, and the
 * adjacent-sibling `+` so `#a > #b` === `#a>#b`. The `+` in a selector is
 * unambiguously a combinator (CSS has no `+` operator between simple selectors),
 * so collapsing its surrounding whitespace is safe at the selector level.
 *
 * Quoted spans (e.g. an attribute-selector value `[title="a  b"]`) are preserved
 * verbatim, so interior whitespace inside a matched-value string stays
 * significant.
 */
function normalizeCssSelectorSpan(span: string): string {
  return normalizeCssTextSpan(span).replace(/\s*([>~+])\s*/g, '$1');
}

function normalizeCssSelector(value: string | undefined): string {
  if (value === undefined || value === null) {
    return '';
  }
  return normalizeOutsideStrings(value, normalizeCssSelectorSpan).trim();
}

interface CssShape {
  type: string;
  selector?: string;
  prop?: string;
  value?: string;
  important?: boolean;
  name?: string;
  params?: string;
  text?: string;
  nodes?: CssShape[];
}

/**
 * Canonicalise a LESS variable at-rule so the compact form `@c:red` and the
 * spaced form `@c: red` (which js-beautify emits) reduce to the SAME shape.
 *
 * postcss-less parses `@c:red` as an atrule with name `"c:red"` and empty
 * params, but `@c: red` as name `"c"`, params `"red"` (plus a `value`/`variable`
 * field). Left as-is, the two shapes differ and cssTreeEqual rejects the
 * semantically-identical formatted output, no-op'ing every `@var:value` written
 * without a space — a very common LESS style (SPEC §12 "faux positif de la
 * garde"). This splits a `name` that still contains the `name:value` artifact
 * into a separate name + params so both forms converge.
 *
 * Returns the [name, params] to use, leaving non-LESS / non-variable at-rules
 * untouched.
 */
function normalizeLessVariableAtRule(
  rawName: string,
  rawParams: string | undefined
): { name: string; params: string | undefined } {
  // Only the compact form leaves a ":" embedded in the at-rule NAME with no
  // separate params. A real at-rule (@media, @supports, ...) keeps its ":" in
  // the params, never the name.
  const colon = rawName.indexOf(':');
  if (colon === -1 || (rawParams !== undefined && rawParams.trim() !== '')) {
    return { name: rawName, params: rawParams };
  }
  return {
    name: rawName.slice(0, colon),
    params: rawName.slice(colon + 1)
  };
}

/**
 * Reduce a PostCSS node to a whitespace-insensitive structural shape. `raws`
 * (which hold all the formatter-controlled whitespace) are dropped entirely;
 * only meaningful tokens survive. `lang` is threaded so LESS-specific parse
 * artifacts (compact variable at-rules) can be canonicalised.
 */
function cssShape(node: PostcssNode, lang: LangId): CssShape {
  const anyNode = node as PostcssNode & {
    selector?: string;
    prop?: string;
    value?: string;
    important?: boolean;
    name?: string;
    params?: string;
    text?: string;
    nodes?: PostcssNode[];
  };

  const shape: CssShape = { type: anyNode.type };

  if (anyNode.selector !== undefined) {
    shape.selector = normalizeCssSelector(anyNode.selector);
  }
  if (anyNode.prop !== undefined) {
    shape.prop = normalizeCssText(anyNode.prop);
  }
  if (anyNode.important !== undefined) {
    shape.important = Boolean(anyNode.important);
  }

  if (anyNode.type === 'atrule' && anyNode.name !== undefined) {
    // For an at-rule, postcss-less duplicates a variable's value onto a `value`
    // field; we canonicalise on name+params only (dropping `value`) so the
    // compact and spaced LESS forms converge.
    const normalized =
      lang === 'less'
        ? normalizeLessVariableAtRule(anyNode.name, anyNode.params)
        : { name: anyNode.name, params: anyNode.params };
    shape.name = normalizeCssText(normalized.name);
    if (normalized.params !== undefined) {
      shape.params = normalizeCssText(normalized.params);
    }
  } else {
    if (anyNode.value !== undefined) {
      shape.value = normalizeCssText(anyNode.value);
    }
    if (anyNode.name !== undefined) {
      shape.name = normalizeCssText(anyNode.name);
    }
    if (anyNode.params !== undefined) {
      shape.params = normalizeCssText(anyNode.params);
    }
  }

  if (anyNode.text !== undefined) {
    // Comment text. Whitespace inside comments is style, not structure.
    shape.text = normalizeCssText(anyNode.text);
  }
  if (Array.isArray(anyNode.nodes)) {
    shape.nodes = anyNode.nodes.map((child) => cssShape(child, lang));
  }

  return shape;
}

/**
 * Re-tokenise + tree comparison for CSS/SCSS/LESS using PostCSS (+ syntaxes).
 */
export function cssTreeEqual(lang: LangId, input: string, output: string): GuardVerdict {
  const parser = cssParserFor(lang);

  let inputShape: CssShape;
  try {
    inputShape = cssShape(parser(input), lang);
  } catch (error: unknown) {
    return rejected(`input did not parse: ${describeError(error)}`);
  }

  let outputShape: CssShape;
  try {
    outputShape = cssShape(parser(output), lang);
  } catch (error: unknown) {
    return rejected(`formatted output did not parse: ${describeError(error)}`);
  }

  if (JSON.stringify(inputShape) !== JSON.stringify(outputShape)) {
    return rejected('CSS tree changed after formatting');
  }
  return EQUIVALENT;
}

// --- HTML ------------------------------------------------------------------

// parse5 node bookkeeping keys we never want to influence comparison.
interface Parse5Node {
  nodeName: string;
  tagName?: string;
  value?: string;
  data?: string;
  publicId?: string;
  systemId?: string;
  name?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: Parse5Node[];
  content?: Parse5Node; // <template> fragment
}

interface HtmlShape {
  node: string;
  tag?: string;
  attrs?: Array<[string, string]>;
  text?: string;
  doctype?: { name?: string; publicId?: string; systemId?: string };
  children?: HtmlShape[];
}

/**
 * Tags whose text content is truly byte-significant: inside <pre> and <textarea>
 * every space/tab/newline is rendered, so their text is compared VERBATIM.
 */
const VERBATIM_TEXT_TAGS = new Set(['pre', 'textarea']);

/**
 * Tags that hold EMBEDDED CODE rather than HTML text. js-beautify legitimately
 * re-indents the JS in <script> and the CSS in <style>; that reindentation is
 * NOT a semantic change for the embedded language, so comparing the bodies
 * verbatim would false-positive-reject the formatter's own valid output and turn
 * HTML formatting into a permanent no-op on any real page (SPEC §3, §12). Their
 * bodies are instead canonicalised modulo the embedded language's insignificant
 * whitespace (see `canonicalizeEmbeddedCode`).
 */
const EMBEDDED_CODE_TAGS = new Set(['script', 'style']);

function normalizeHtmlText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Read a <script>'s `type` attribute (lower-cased) so we can tell executable JS
 * (`text/javascript`, `module`, absent) from data blocks (`application/json`,
 * `importmap`, ...). parse5 lower-cases attribute names already.
 */
function scriptType(attrs: Array<{ name: string; value: string }> | undefined): string {
  if (!Array.isArray(attrs)) {
    return '';
  }
  const typeAttr = attrs.find((attr) => attr.name === 'type');
  return typeAttr ? typeAttr.value.trim().toLowerCase() : '';
}

// <script> types that carry JS to execute. Anything else (application/json,
// importmap, application/ld+json, a template type, ...) is opaque data and is
// compared as canonical JSON when it parses, else verbatim.
const JS_SCRIPT_TYPES = new Set([
  '',
  'text/javascript',
  'application/javascript',
  'text/ecmascript',
  'application/ecmascript',
  'module'
]);

/**
 * Canonicalise the body of an embedded <script>/<style> so that a pure reindent
 * compares equal but any real code/value change does not.
 *  - <style>            -> PostCSS shape (whitespace-insensitive),
 *  - <script> (JS)      -> babel AST canonical form,
 *  - <script> data/json -> canonical JSON value when it parses.
 * On any parse failure we fall back to the VERBATIM text: we cannot prove the
 * reindent is semantics-preserving, so we stay conservative and only accept a
 * byte-identical body (never wrongly accept a change we could not analyse).
 */
function canonicalizeEmbeddedCode(
  parentTag: string,
  parentAttrs: Array<{ name: string; value: string }> | undefined,
  raw: string
): string {
  const body = raw.trim();
  if (body === '') {
    return '';
  }
  try {
    if (parentTag === 'style') {
      return `css:${JSON.stringify(cssShape((parseCss as unknown as CssParser)(body), 'css'))}`;
    }
    // parentTag === 'script'
    const type = scriptType(parentAttrs);
    if (JS_SCRIPT_TYPES.has(type)) {
      return `js:${JSON.stringify(canonicalizeAst(parseJsAst(body, BABEL_PLUGINS_JSX)))}`;
    }
    if (type.includes('json')) {
      return `json:${JSON.stringify(canonicalizeJsonForEmbed(body))}`;
    }
    // Unknown/opaque script type (e.g. an x-template): treat the body verbatim.
    return `verbatim:${raw}`;
  } catch {
    // Could not parse the embedded body as its declared language. Be conservative
    // and require a byte-identical body rather than guessing equivalence.
    return `verbatim:${raw}`;
  }
}

function htmlShape(
  node: Parse5Node,
  parentTag: string | undefined,
  parentAttrs: Array<{ name: string; value: string }> | undefined
): HtmlShape {
  const shape: HtmlShape = { node: node.nodeName };

  if (node.nodeName === '#text') {
    const raw = node.value ?? '';
    if (parentTag !== undefined && EMBEDDED_CODE_TAGS.has(parentTag)) {
      shape.text = canonicalizeEmbeddedCode(parentTag, parentAttrs, raw);
      return shape;
    }
    const verbatim = parentTag !== undefined && VERBATIM_TEXT_TAGS.has(parentTag);
    shape.text = verbatim ? raw : normalizeHtmlText(raw);
    return shape;
  }

  if (node.nodeName === '#comment') {
    shape.text = normalizeHtmlText(node.data ?? '');
    return shape;
  }

  if (node.nodeName === '#documentType') {
    shape.doctype = {
      name: node.name,
      publicId: node.publicId,
      systemId: node.systemId
    };
    return shape;
  }

  if (node.tagName !== undefined) {
    shape.tag = node.tagName;
  }

  if (Array.isArray(node.attrs)) {
    // Attribute order is not semantically meaningful in HTML — sort by name so a
    // reorder does not register as a change.
    shape.attrs = node.attrs
      .map((attr): [string, string] => [attr.name, attr.value])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }

  const ownTag = node.tagName;
  const ownAttrs = node.attrs;
  const children: HtmlShape[] = [];

  // <template> content lives under `.content`, a document fragment.
  if (node.content && Array.isArray(node.content.childNodes)) {
    for (const child of node.content.childNodes) {
      children.push(htmlShape(child, ownTag, ownAttrs));
    }
  }
  if (Array.isArray(node.childNodes)) {
    for (const child of node.childNodes) {
      // Drop whitespace-only text nodes except inside <pre>/<textarea> (where
      // whitespace is rendered): a formatter freely inserts/removes them and they
      // carry no meaning. Inside <script>/<style> an all-whitespace body is empty
      // embedded code and is likewise insignificant.
      if (
        child.nodeName === '#text' &&
        !(ownTag !== undefined && VERBATIM_TEXT_TAGS.has(ownTag)) &&
        normalizeHtmlText(child.value ?? '') === ''
      ) {
        continue;
      }
      children.push(htmlShape(child, ownTag, ownAttrs));
    }
  }
  if (children.length > 0) {
    shape.children = children;
  }

  return shape;
}

/**
 * Tree comparison for HTML using parse5. A full document and a fragment are both
 * accepted: we try the full-document parse and fall back to a fragment parse so
 * that partial snippets (e.g. range formatting) still compare correctly.
 */
export function htmlTreeEqual(input: string, output: string): GuardVerdict {
  const buildShape = (html: string): HtmlShape => {
    const looksLikeDocument = /<(!doctype|html)\b/i.test(html);
    const root = (looksLikeDocument ? parseHtml(html) : parseHtmlFragment(html)) as unknown as Parse5Node;
    return htmlShape(root, undefined, undefined);
  };

  let inputShape: HtmlShape;
  try {
    inputShape = buildShape(input);
  } catch (error: unknown) {
    return rejected(`input did not parse: ${describeError(error)}`);
  }

  let outputShape: HtmlShape;
  try {
    outputShape = buildShape(output);
  } catch (error: unknown) {
    return rejected(`formatted output did not parse: ${describeError(error)}`);
  }

  if (JSON.stringify(inputShape) !== JSON.stringify(outputShape)) {
    return rejected('HTML tree changed after formatting');
  }
  return EQUIVALENT;
}

// --- JSON / JSONC ----------------------------------------------------------

/**
 * Parse with the lenient jsonc-parser (handles comments + trailing commas).
 * Throws on any parse error so the guard rejects non-parsable output. This is the
 * authoritative parser for the JSON family; the native fast path below only
 * SHORT-CIRCUITS the common comment-free case and never changes the verdict.
 */
function parseJsoncValue(code: string): unknown {
  const errors: ParseError[] = [];
  // allowTrailingComma covers JSONC; comments are stripped by the parser, which
  // is correct: comment movement is whitespace/style, not value structure.
  const value = parseJsonc(code, errors, {
    allowTrailingComma: true,
    disallowComments: false
  });
  if (errors.length > 0) {
    const first = errors[0];
    throw new Error(`JSON parse error: ${printParseErrorCode(first.error)} at offset ${first.offset}`);
  }
  return value;
}

// Above this size the token-level lightweight guard path is worth attempting:
// native JSON.parse is ~2x faster than the lenient jsonc-parser, which matters on
// multi-megabyte documents (SPEC §9 "garde token-level allégée pour très gros
// fichiers"). The fast path is value-IDENTICAL — native JSON.parse yields exactly
// the same JS value as jsonc-parser for any strict-JSON document — so it can NEVER
// accept a value change the full path would reject (verified by the corrupted-5MB
// test). On any native-parse failure (comments / trailing commas / genuinely
// invalid input) we fall back to the authoritative jsonc-parser, so JSONC and
// invalid-output rejection are completely unaffected.
const JSON_FAST_PATH_MIN_BYTES = 256 * 1024;

/**
 * Parse a JSON/JSONC document to its value, preferring a fast native JSON.parse on
 * large strict-JSON documents and falling back to the lenient jsonc-parser
 * otherwise. The returned value is identical regardless of which parser ran, so
 * downstream equality is unchanged — only the cost differs.
 *
 * Throws (via jsonc-parser) when the text is not valid JSON/JSONC, exactly as
 * before, so the guard still rejects unparsable output.
 */
function parseJsonValue(code: string): unknown {
  if (code.length >= JSON_FAST_PATH_MIN_BYTES) {
    try {
      // Strict JSON only — native parser rejects comments/trailing commas, in
      // which case we transparently fall through to the lenient path below.
      return JSON.parse(code);
    } catch {
      // Not strict JSON (likely JSONC): defer to the authoritative parser.
    }
  }
  return parseJsoncValue(code);
}

/**
 * Parse JSON/JSONC text and return a key-order-independent canonical value
 * (object keys sorted; array order preserved) suitable for a stable string
 * comparison of an embedded <script type="application/json"> body. Throws on
 * invalid JSON so the caller can fall back to a verbatim comparison.
 */
function canonicalizeJsonForEmbed(code: string): unknown {
  const sortValue = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(sortValue);
    }
    if (value !== null && typeof value === 'object') {
      const source = value as Record<string, unknown>;
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(source).sort()) {
        result[key] = sortValue(source[key]);
      }
      return result;
    }
    return value;
  };
  return sortValue(parseJsonValue(code));
}

/**
 * Deep structural equality of two already-parsed JSON values. Object key order
 * is irrelevant to JSON semantics, so keys are compared as a set, but array
 * order is meaningful and preserved.
 */
function jsonDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (a === null || b === null) {
    return a === b;
  }
  if (typeof a !== typeof b) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, index) => jsonDeepEqual(item, b[index]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const aKeys = Object.keys(aObj);
    const bKeys = Object.keys(bObj);
    if (aKeys.length !== bKeys.length) {
      return false;
    }
    return aKeys.every(
      (key) => Object.prototype.hasOwnProperty.call(bObj, key) && jsonDeepEqual(aObj[key], bObj[key])
    );
  }
  // Primitives that were not === (e.g. NaN) are not equal.
  return false;
}

/**
 * Value-level equality for JSON/JSONC. Parses both sides to a JS value (via the
 * size-aware `parseJsonValue`, which short-circuits large strict-JSON with native
 * JSON.parse) and deep-compares them. The comparison itself is unchanged, so the
 * safety guarantee is identical to the full path: any value change is rejected.
 */
export function jsonEqual(input: string, output: string): GuardVerdict {
  let inputValue: unknown;
  try {
    inputValue = parseJsonValue(input);
  } catch (error: unknown) {
    return rejected(`input did not parse: ${describeError(error)}`);
  }

  let outputValue: unknown;
  try {
    outputValue = parseJsonValue(output);
  } catch (error: unknown) {
    return rejected(`formatted output did not parse: ${describeError(error)}`);
  }

  if (!jsonDeepEqual(inputValue, outputValue)) {
    return rejected('JSON value changed after formatting');
  }
  return EQUIVALENT;
}

// --- idempotence -----------------------------------------------------------

/**
 * Idempotence check: format(format(x)) === format(x). Covers right-drift only,
 * NOT corruption (which is covered by the equivalence checks above).
 *
 * This is an exact byte comparison on purpose: a stable formatter must reach a
 * fixed point, so the second pass should change nothing at all. Drift (the
 * "code creeps right on every save" review cluster) shows up as any diff here.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function idempotence(lang: LangId, firstPass: string, secondPass: string): GuardVerdict {
  if (firstPass === secondPass) {
    return EQUIVALENT;
  }
  return rejected('formatting is not idempotent (output drifts on a second pass)');
}

// --- dispatch --------------------------------------------------------------

function checkByLang(lang: LangId, input: string, output: string): GuardVerdict {
  switch (lang) {
    case 'javascript':
    case 'javascriptreact':
    case 'typescript':
    case 'typescriptreact':
      return astEqualJs(input, output, lang);
    case 'css':
    case 'scss':
    case 'less':
      return cssTreeEqual(lang, input, output);
    case 'html':
      return htmlTreeEqual(input, output);
    case 'json':
    case 'jsonc':
      return jsonEqual(input, output);
    default: {
      // Exhaustiveness guard: a new LangId must get an explicit strategy rather
      // than silently passing through unchecked.
      const exhaustive: never = lang;
      return rejected(`no safety guard configured for language '${String(exhaustive)}'`);
    }
  }
}

export const guard: Guard = {
  // semantic-equivalence-modulo-whitespace
  check(lang: LangId, input: string, output: string): GuardVerdict {
    // Fast path: an identical output is trivially equivalent and needs no parse.
    if (input === output) {
      return EQUIVALENT;
    }
    return checkByLang(lang, input, output);
  }
};
