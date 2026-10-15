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
//
// ADD-11: the heavy verifier parsers live in lazily loaded chunks (see
// src/chunks/loader.ts). The type-only imports below are erased at compile time
// and cost nothing at activation; every VALUE acquisition goes through a
// require*Chunk() call.
//
// A chunk that fails to LOAD is a failure of the VERIFIER, never a statement
// about the user's file, so it must never be dressed up as "your input did not
// parse". Two rules keep that literally true on EVERY path:
//   1. each require*Chunk() sits OUTSIDE the try/catch that maps parse errors to
//      rejected(...), so the load failure escapes on its own;
//   2. where a chunk can only be reached from INSIDE such a try (the embedded
//      <style>/<script> analysis under htmlTreeEqual), the catch RETHROWS a
//      ChunkLoadError instead of converting it, via isChunkLoadError.
// The failure therefore leaves guard.check as a THROW on the JS, CSS and HTML
// paths alike (provider: 'guard error: ...' -> 'engine-error' abort, file
// byte-identical, ZERO edits), and is reported as a verifier/engine failure
// rather than as a rejection of the user's code.
//
// jsonc-parser deliberately stays a static value import: the JSON/JSONC guard
// ships inside the host bundle and needs no chunk at all.
import type { ParserOptions } from '@babel/parser';
import type { Node as PostcssNode } from 'postcss';
import {
  visit as visitJsonc,
  type ParseErrorCode,
  printParseErrorCode
} from 'jsonc-parser';
import {
  isChunkLoadError,
  requireGuardJsChunk,
  requireGuardCssChunk,
  requireGuardHtmlChunk
} from '../chunks/loader';
import type { Guard, GuardVerdict, LangId } from '../types';
import {
  childWhitespaceContext,
  cssTextPreservesWhitespace,
  EMBEDDED_CSS_WHITESPACE_REASON,
  mayDeclareWhiteSpace,
  normalizeHtmlText,
  normalizeTextFor,
  ROOT_WHITESPACE_CONTEXT,
  significanceOf,
  type WhitespaceContext
} from './htmlWhitespace';

// --- shared verdicts -------------------------------------------------------

const EQUIVALENT: GuardVerdict = { equivalent: true };

function rejected(reason: string): GuardVerdict {
  return { equivalent: false, reason };
}

/**
 * Normalize an error of unknown shape into a short, one-line message.
 *
 * It drops the parser's CODE FRAME, which is the bulk of the source a parser
 * error carries, and keeps its FIRST LINE. That first line is not code-free:
 * parsers name the offending token in it, so a message can read "Identifier
 * 'CLIENT_SECRET_abc123' has already been declared". README documents this
 * honestly; three comments elsewhere used to deny it and were corrected in
 * v0.4.1. Do not restore the "code-free" claim here without also making it
 * true, which means redacting the token, not just the frame.
 */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    // Parser errors often embed a code frame after the first line : drop it.
    return error.message.split('\n')[0];
  }
  return 'unexpected error';
}

/**
 * Rethrow a chunk LOAD failure so it can never be reported as a parse failure.
 *
 * Called first in EVERY catch of this module that would otherwise answer
 * rejected('input did not parse: ...'). A verifier that never ran proves nothing
 * about the user's file: saying "your file could not be proven equivalent" there
 * would be a false accusation about their code. Rethrowing keeps the outcome a
 * verifier/engine failure ('guard error: ...' upstream), and it is exactly as
 * fail-safe: no GuardVerdict is produced, so no caller can read a pass out of it
 * and ZERO edits are applied either way.
 */
function rethrowIfChunkLoadFailure(error: unknown): void {
  if (isChunkLoadError(error)) {
    throw error;
  }
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
// contain JSX (a React `.js`/`.jsx`, or `.tsx`), so jsx stays enabled there , 
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

interface ParsedJs {
  program: unknown;
  comments: string[];
}

/**
 * Parse JS/TS and return both the program AST and the multiset of comment texts.
 *
 * Comments are stripped from the structural comparison (they carry positions and
 * would reject any legitimate reflow), but their DISAPPEARANCE is a real content
 * loss the guard must catch: `/* eslint-disable *\/` changes lint behaviour, a
 * `/* webpackChunkName *\/` magic comment changes the emitted bundle, and a
 * licence header carries a legal obligation. Comparing the sorted, whitespace-
 * normalized comment texts tolerates reindentation and movement (both style)
 * while catching removal or alteration (both content).
 */
function parseJs(code: string, plugins: BabelPlugins): ParsedJs {
  const { parse: babelParse } = requireGuardJsChunk();
  const file = babelParse(code, {
    sourceType: 'unambiguous',
    allowReturnOutsideFunction: true,
    allowImportExportEverywhere: true,
    errorRecovery: false,
    plugins
  });
  return {
    program: file.program,
    comments: (file.comments ?? [])
      .map((comment) => comment.value.replace(/\s+/g, ' ').trim())
      .sort()
  };
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
 * the (correct) output : the "safe but does nothing" false positive on TSX.
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
 *
 * BEYOND `cleanJsxText`, JSX TEXT IS COMPARED BYTE FOR BYTE, and that is the
 * point rather than an oversight. Babel keeps an interior run of spaces on a
 * single line exactly as written (`<p>hello  there</p>` parses to the JSXText
 * "hello  there", TWO spaces), so the run is part of the string the file
 * COMPILES to. Prettier prints it as `<p>hello there</p>`, betting that a
 * browser will collapse the run on display. That bet is wrong wherever the
 * string is not HTML flow text:
 *   - an i18n message id (`<Trans>Hello  world</Trans>`) silently becomes a
 *     different lookup key and the translation stops resolving;
 *   - React Native `<Text>` renders every space it is given;
 *   - any subtree that ends up inside a preformatted context is drawn verbatim,
 *     and whether it does cannot be decided from the expression the text sits
 *     in: `const label = <span>col1  col2</span>` may be rendered by a
 *     `<pre>{label}</pre>` in another file entirely.
 * A verifier that reasoned about "what a browser would render" therefore had to
 * decide preformattedness lexically, and every subtree reached through a
 * REFERENCE escaped it: a proven accept-when-not-equivalent. Tidy is stricter
 * than Prettier's own assumption here on purpose. When that strictness blocks a
 * format, `jsxTextWhitespaceOnly` (label only, below) makes the rejection say
 * precisely why.
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
 * LABEL ONLY, NEVER A VERDICT. Blur every run of ASCII spaces inside JSX text.
 *
 * It runs on the OUTPUT of `canonicalizeAst`, never inside it, and only after a
 * difference has already been found, so it cannot widen (or narrow) what the
 * guard accepts: by the time it is called the rejection is decided and the only
 * open question is which sentence the user reads. Blurring here is therefore
 * free of the soundness burden that makes the same blurring unacceptable in the
 * comparison itself.
 *
 * Only the ASCII space is blurred: `cleanJsxText` has already folded tabs and
 * line breaks, and U+00A0 and its family are rendered characters that no amount
 * of whitespace reflow can explain.
 */
function blurJsxTextWhitespace(value: unknown): unknown {
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      const blurred = blurJsxTextWhitespace(item);
      if (blurred !== DROP_NODE) {
        out.push(blurred);
      }
    }
    return out;
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    if (source.type === 'JSXText' && typeof source.value === 'string') {
      const blurred = source.value.replace(/ +/g, ' ').trim();
      return blurred === '' ? DROP_NODE : { type: 'JSXText', value: blurred };
    }
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source)) {
      const blurred = blurJsxTextWhitespace(source[key]);
      if (blurred === DROP_NODE) {
        continue;
      }
      result[key] = blurred;
    }
    return result;
  }
  return value;
}

/**
 * True when whitespace inside JSX text is the ONLY thing that differs between
 * two canonical forms already known to differ. Any other change (a dropped
 * `{" "}` container, a changed word, a moved child, an altered attribute)
 * survives the blur, the two forms stay different, and the caller falls back to
 * the generic sentence.
 */
function jsxTextWhitespaceOnly(inputCanonical: unknown, outputCanonical: unknown): boolean {
  return (
    JSON.stringify(blurJsxTextWhitespace(inputCanonical)) ===
    JSON.stringify(blurJsxTextWhitespace(outputCanonical))
  );
}

/**
 * The sentence shown when a rejection is entirely about JSX text whitespace.
 * Single line and well under the 200-character clamp `sanitizeDetail` applies,
 * so it reaches the output channel, the status bar tooltip and "Explain last
 * format" whole. English, content-free: it names no user code.
 */
export const JSX_TEXT_WHITESPACE_REASON =
  'Prettier reflowed whitespace inside JSX text; that run of spaces is part of the string this code compiles to, so Tidy did not write it';

/**
 * Report, for every JSX tag, whether the tag-OPENING punctuator `<` is
 * immediately adjacent to whatever follows it (the element name, the `/` of a
 * closing tag, the `>` of `<>`, or a comment), read from the AST `parseJs`
 * already produced. No second parse, and no token array (see the last
 * paragraph for why).
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
 *   silent no-op on any real-world .tsx component with wrapped attributes : the
 *   "safe but does nothing" failure the SPEC forbids (§12 "faux positif de la
 *   garde"). The closing `>` carries no boundary-integrity signal a formatter is
 *   not allowed to touch, so it is excluded. What the open-adjacency check
 *   catches is a detached OPENING `<`: `< Foo`, `< Foo>` and `</Foo>` -> `< /Foo>`.
 *   It looks at nothing else in a tag's punctuation. In particular `<Foo / >`
 *   keeps its `<` glued to `Foo`, so this check does NOT flag it, and it does not
 *   need to: `<Foo / >` is valid JSX, @babel/parser and esbuild both accept it
 *   with the same AST as `<Foo />`, so the guard treats the two as equivalent.
 *   Tag renames and dropped attributes are caught independently by the
 *   structural AST diff.
 *
 * Two call sites, one rule: `astEqualJs` (a .js/.jsx/.tsx file) and
 * `canonicalizeEmbeddedCode` (the body of an EXECUTABLE `<script>` in an HTML
 * document, ADD-12b), so a detached opening `<` is refused wherever the JSX lives.
 *
 * WHY THE AST AND NOT THE TOKENS. The first version parsed a second time with
 * `tokens: true` and looked at the token after every `jsxTagStart`. In
 * @babel/parser 7.29 that option routes the tokens through `babel7CompatTokens`,
 * which splices the WHOLE token array once per template literal and once per
 * `#private` name: quadratic. A 1 MiB script dense in template literals took
 * 4.6 s to verify in an HTML document without it and 70 s with it, on the
 * extension host's own thread (a .js file paid the same cost through
 * `astEqualJs`). The answer needs none of that. Every `jsxTagStart` token is the
 * `<` that opens one of four JSX node types (plus one artifact, see
 * `genericArrowOpenAdjacency`), and each such node STARTS at that `<`, so "does
 * the next token begin right after it" is read straight off `node.start`:
 *   - an opening element: its name starts at `start + 1`;
 *   - an opening fragment: the next character is the `>` of `<>`;
 *   - a closing element or fragment: the next character is the `/` of `</`;
 *   - a comment, whatever it stands before, is a token of its own and starts
 *     with `/`, so a `/` right after the `<` is adjacency too. That is also why
 *     a block comment glued to the `<` (the `<` then `/`, `*`, a name and so on)
 *     counts as glued, exactly as it did when tokens were read.
 * Anything else after the `<` is whitespace the tokenizer skipped: split.
 *
 * NOT A NEW RULE. The returned string is the one the token version returned
 * (same marks, same order) on every input compared so far, with ONE known
 * difference, in the strict direction: after `if (...)`, `while (...)`,
 * `for (...)`, `with (...)`, a block or `yield`, and after `async` (D3), the
 * tokenizer reads the `<` of a generic arrow as a plain `<` and the token version
 * marked nothing, while the AST still holds the arrow and this walk marks it. A
 * detached `< T,>` there is now refused; nothing the token version refused is
 * accepted.
 * test/unit/safety/jsxFingerprintDifferential.test.ts keeps the token version as
 * a reference, compares the two over every JSX-bearing fixture of the repo, the
 * edge cases of the review and generated input, and pins that one difference by
 * name. Two things keep the walk
 * from UNDER-reporting, the direction that would let the guard accept more: it
 * visits every object-valued key `canonicalizeAst` visits (a superset of what a
 * visitor-key traversal reaches), and a tag node whose `<` cannot be located
 * exactly throws instead of being skipped, which every caller turns into a
 * refusal (a file) or a verbatim comparison (a script).
 */
const JSX_TAG_NODE_TYPES: ReadonlySet<string> = new Set([
  'JSXOpeningElement',
  'JSXClosingElement',
  'JSXOpeningFragment',
  'JSXClosingFragment'
]);

const CHAR_LT = 0x3c; // <
const CHAR_GT = 0x3e; // >
const CHAR_SLASH = 0x2f; // /

/** Where this tag node's `<` is and whether it is glued to what follows. Throws if it cannot tell. */
function tagOpenAdjacency(
  node: Record<string, unknown>,
  code: string
): { at: number; glued: boolean } {
  const at = node.start;
  if (typeof at !== 'number' || code.charCodeAt(at) !== CHAR_LT) {
    throw new Error('JSX tag node does not start at a "<"');
  }
  const next = code.charCodeAt(at + 1);
  if (next === CHAR_SLASH) {
    // The `/` of `</`, or the first character of a comment between `<` and the name.
    return { at, glued: true };
  }
  if (node.type === 'JSXOpeningFragment') {
    return { at, glued: next === CHAR_GT };
  }
  if (node.type === 'JSXOpeningElement') {
    const nameStart = (node.name as { start?: unknown } | null | undefined)?.start;
    if (typeof nameStart !== 'number') {
      throw new Error('JSX opening element without a name position');
    }
    return { at, glued: nameStart === at + 1 };
  }
  // A closing element or fragment whose `<` is not followed by `/`: detached.
  return { at, glued: false };
}

/**
 * The one `jsxTagStart` token that is NOT a JSX tag. With the `jsx` and
 * `typescript` plugins both on, @babel/parser lexes the `<` that opens the type
 * parameters of a non-async arrow function (`<T,>(x: T) => x`) as `jsxTagStart`,
 * tries it as JSX, backs out, and leaves that token in the token array. The
 * token version of this fingerprint therefore marked it, and so must this one:
 * without the mark, a formatter that detached it (`< T,>(x: T) => x`, same AST)
 * would be accepted where the token version refused it, which is a relaxation.
 * `async <T,>(...)` is lexed as a plain `<` and leaves no such token, but it is
 * marked all the same (D3): the arrow starts at `async`, so there the `<` is where
 * the type parameters start. Any other arrow must START at its `<`.
 * The differential test is what says this list is complete: it fails if a
 * @babel/parser upgrade ever changes which `<` is left behind.
 */
function genericArrowOpenAdjacency(
  node: Record<string, unknown>,
  code: string
): { at: number; glued: boolean } | undefined {
  const typeParameters = node.typeParameters as
    | { start?: unknown; params?: unknown }
    | null
    | undefined;
  if (typeParameters === null || typeof typeParameters !== 'object') {
    return undefined;
  }
  // D3: an ASYNC arrow starts at `async`, its type parameters at the `<` after it.
  // That `<` is a plain token (no `jsxTagStart`), so the token version marked
  // nothing there and `async < T,>(x: T) => x` was accepted. Marking it is
  // stricter, never looser. Any other arrow must still start at its `<`.
  const at = node.async === true ? typeParameters.start : node.start;
  if (typeParameters.start !== at) {
    return undefined;
  }
  if (typeof at !== 'number' || code.charCodeAt(at) !== CHAR_LT) {
    throw new Error('generic arrow type parameters do not start at a "<"');
  }
  if (code.charCodeAt(at + 1) === CHAR_SLASH) {
    // Only a comment can open there: type parameters never start with `/`.
    return { at, glued: true };
  }
  const first = Array.isArray(typeParameters.params)
    ? (typeParameters.params[0] as { start?: unknown } | undefined)
    : undefined;
  if (typeof first?.start !== 'number') {
    throw new Error('generic arrow without a first type parameter position');
  }
  return { at, glued: first.start === at + 1 };
}

function jsxBoundaryFingerprint(program: unknown, code: string): string {
  // Exact short cut: a JSX tag is opened by a `<`, so none can exist without one.
  if (!code.includes('<')) {
    return '';
  }
  const gluedAt = new Map<number, boolean>();
  const pending: unknown[] = [program];
  while (pending.length > 0) {
    const node = pending.pop();
    if (Array.isArray(node)) {
      for (const item of node) {
        pending.push(item);
      }
      continue;
    }
    if (node === null || typeof node !== 'object') {
      continue;
    }
    const record = node as Record<string, unknown>;
    if (typeof record.type === 'string') {
      if (JSX_TAG_NODE_TYPES.has(record.type)) {
        const { at, glued } = tagOpenAdjacency(record, code);
        gluedAt.set(at, glued);
      } else if (record.type === 'ArrowFunctionExpression') {
        const found = genericArrowOpenAdjacency(record, code);
        if (found !== undefined) {
          gluedAt.set(found.at, found.glued);
        }
      }
    }
    for (const key of Object.keys(record)) {
      if (STRUCTURAL_IGNORE_KEYS.has(key)) {
        continue;
      }
      const child = record[key];
      if (child !== null && typeof child === 'object') {
        pending.push(child);
      }
    }
  }
  return [...gluedAt.keys()]
    .sort((a, b) => a - b)
    .map((at) => `open:${gluedAt.get(at) ? 'glued' : 'split'}`)
    .join('|');
}

/**
 * The fingerprint of a source text, exported ONLY so the differential test can
 * compare it with the token-based reference. The guard itself never calls it.
 */
export function jsxBoundaryFingerprintOfSource(code: string, lang?: LangId): string {
  return jsxBoundaryFingerprint(parseJs(code, babelPluginsFor(lang)).program, code);
}

/**
 * Structural AST equality for JS/TS/JSX/TSX using @babel/parser, ignoring source
 * positions and comments (semantic equivalence modulo whitespace/style), plus a
 * JSX tag-boundary integrity check (see `jsxBoundaryFingerprint`).
 */
export function astEqualJs(input: string, output: string, lang?: LangId): GuardVerdict {
  // ADD-11: acquire the verifier BEFORE any try/catch that maps parse errors to
  // rejected(...), and rethrow a ChunkLoadError from those catches anyway (see
  // rethrowIfChunkLoadFailure). A chunk LOAD failure must escape guard.check as
  // a thrown error (provider: 'guard error: ...' -> 'engine-error' abort, file
  // intact), never be disguised as 'input did not parse'. The same two rules
  // hold in cssTreeEqual and htmlTreeEqual, embedded bodies included, so the
  // classification is the same on every path.
  requireGuardJsChunk();

  const plugins = babelPluginsFor(lang);
  const jsxEnabled = plugins.some((plugin) => plugin === 'jsx');

  let inputParsed: ParsedJs;
  try {
    inputParsed = parseJs(input, plugins);
  } catch (error: unknown) {
    rethrowIfChunkLoadFailure(error);
    // The original source did not parse. We cannot prove equivalence, so we are
    // conservative and refuse to apply (the file is left untouched upstream).
    return rejected(`input did not parse: ${describeError(error)}`);
  }

  let outputParsed: ParsedJs;
  try {
    outputParsed = parseJs(output, plugins);
  } catch (error: unknown) {
    rethrowIfChunkLoadFailure(error);
    return rejected(`formatted output did not parse: ${describeError(error)}`);
  }

  const inputShape = canonicalizeAst(inputParsed.program);
  const outputShape = canonicalizeAst(outputParsed.program);
  if (JSON.stringify(inputShape) !== JSON.stringify(outputShape)) {
    // The verdict is already settled here: this only chooses the WORDING. The
    // generic "AST structure changed" reads like a crash on the single most
    // common legitimate rejection in a React file, where the formatter merely
    // reflowed whitespace inside JSX text. Naming that case exactly is the
    // difference between "Tidy is broken" and "Tidy refused, and here is why".
    return rejected(
      jsxTextWhitespaceOnly(inputShape, outputShape)
        ? JSX_TEXT_WHITESPACE_REASON
        : 'AST structure changed after formatting'
    );
  }

  // Comments are excluded from the structural diff (they carry positions), so a
  // formatter that DROPS one would otherwise pass unnoticed. Compare the sorted
  // comment texts: tolerant to reindentation and movement, strict on removal.
  if (JSON.stringify(inputParsed.comments) !== JSON.stringify(outputParsed.comments)) {
    return rejected('comments were lost or altered by formatting');
  }

  // ASTs match : now defend against the whitespace-insignificant JSX corruption
  // class that a structural diff alone cannot see. Only meaningful when the
  // grammar actually contains JSX; for plain TS/JS there are no JSX tags.
  if (jsxEnabled) {
    try {
      const inputJsx = jsxBoundaryFingerprint(inputParsed.program, input);
      const outputJsx = jsxBoundaryFingerprint(outputParsed.program, output);
      if (inputJsx !== outputJsx) {
        return rejected('JSX tag boundaries were altered by formatting');
      }
    } catch (error: unknown) {
      // E1: a chunk LOAD failure is an engine failure, never a statement about
      // the user's code (the rule every other catch in this file applies). The
      // fingerprint no longer touches a chunk, so this cannot fire today; the
      // rethrow keeps the rule true if that ever changes.
      rethrowIfChunkLoadFailure(error);
      // Reading the tags should not fail when parsing already succeeded; if it
      // does, stay conservative rather than silently accepting.
      return rejected(`could not verify JSX integrity: ${describeError(error)}`);
    }
  }

  return EQUIVALENT;
}

// --- CSS / SCSS / LESS -----------------------------------------------------

type CssParser = (css: string) => PostcssNode;

function cssParserFor(lang: LangId): CssParser {
  // ADD-11: lazily loaded chunk. Callers MUST invoke this outside any try/catch
  // that converts errors into a rejected verdict (see cssTreeEqual).
  const chunk = requireGuardCssChunk();
  switch (lang) {
    case 'scss':
      return chunk.parseScss as unknown as CssParser;
    case 'less':
      return chunk.parseLess as unknown as CssParser;
    case 'css':
    default:
      return chunk.parseCss as unknown as CssParser;
  }
}

/**
 * Split a CSS token string into alternating spans, tagging each as a quoted
 * string literal (`"..."` / `'...'`, honouring `\` escapes) or unquoted text.
 * Quoted spans must be preserved VERBATIM: whitespace inside a CSS string is
 * literal and meaning-bearing (content rendering, `[attr="..."]` matching, a
 * quoted font-family name), so collapsing it would change the file's meaning , 
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
        // Escaped char inside the string : consume the next char verbatim.
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
 * Trim the code points CSS itself counts as whitespace, and NOTHING else.
 *
 * NOT `String.prototype.trim`, whose set is ECMAScript's (WhiteSpace +
 * LineTerminator: U+00A0, U+FEFF, U+2028, U+2029 and every Zs included). See
 * `normalizeCssTextSpan` for the whole argument and for the proven false accept
 * the wider set caused.
 */
function trimCssWhitespace(value: string): string {
  return value.replace(/^[ \t\n\r\f]+|[ \t\n\r\f]+$/g, '');
}

/**
 * Normalize whitespace in a CSS token string the way CSS itself treats it as
 * insignificant, WITHOUT erasing whitespace that carries meaning.
 *
 * WHAT COUNTS AS CSS WHITESPACE, AND WHY IT IS NOT `\s`. Every pattern below
 * spells the class out as `[ \t\n\r\f]` rather than using the JavaScript `\s`
 * class, and that literal set is derived from the CSS grammar, not borrowed
 * from another language's:
 *   - CSS Syntax Level 3 defines `whitespace` as a newline, U+0009 CHARACTER
 *     TABULATION or U+0020 SPACE;
 *   - it defines `newline` as U+000A LINE FEED, noting that U+000D CARRIAGE
 *     RETURN and U+000C FORM FEED are absent from that definition only because
 *     the preprocessing step has already folded them into U+000A.
 * In an UNPREPROCESSED source document, which is exactly what the guard is
 * handed, the whitespace code points are therefore U+0009, U+000A, U+000C,
 * U+000D and U+0020, and no others. U+000B LINE TABULATION is NOT among them:
 * CSS never mentions it, so it is an ordinary code point.
 *
 * `\s` matches twenty code points beyond that set: U+000B, U+00A0, U+1680,
 * U+2000..U+200A, U+2028, U+2029, U+202F, U+205F, U+3000 and U+FEFF. To CSS
 * every one of them is an ordinary character that belongs to the token it sits
 * in, and js-beautify's CSS printer rewrites all of them to U+0020. A guard
 * that folded `\s` on BOTH sides could not see that rewrite and returned
 * `equivalent`, so the edit was applied:
 *
 *     .a<U+00A0>b{color:red}      was written as      .a b { color: red }
 *
 * U+00A0 is an identifier code point, so the input is ONE class selector and
 * the output is a DESCENDANT COMBINATOR: after the write the rule matches
 * entirely different elements. The same rewrite silently retargets a value
 * (`font-family:Helvetica<U+00A0>Neue` -> `Helvetica Neue`, two font names
 * where there was one), a custom property, and an at-rule's params, in css,
 * scss and less alike, and through an HTML `<style>` element.
 *
 * This is the CSS twin of the HTML `&nbsp;` false accept fixed in v0.2.2, where
 * `normalizeHtmlText` was narrowed from `\s` to the HTML spec's ASCII
 * whitespace for the same reason. The two sets coincide, but that is a FACT
 * about the two specifications rather than an assumption: this one is read off
 * CSS Syntax §3.3 + §4.2 on its own, and `test/unit/safety/cssGuardSoundness
 * .test.ts` pins the enumerated set so a future divergence cannot pass
 * unnoticed.
 *
 * The direction of the change is the safe one: the guard now folds strictly
 * LESS than it used to, so it can only reject where it used to accept, never
 * the reverse. A stylesheet that genuinely contains one of these code points
 * where the printer rewrites it is refused with the file left byte-identical,
 * which is the correct outcome for a verifier that cannot prove equivalence
 * (the CSS family also gets the ADD-01 postcss second chance, which preserves
 * them and formats the file cleanly).
 *
 * The rules themselves, unchanged:
 *  - runs of whitespace collapse to a single space (`a  ,  b` -> `a , b`),
 *  - whitespace immediately inside/around the structural delimiters `( ) ,` is
 *  - runs of whitespace collapse to a single space (`a  ,  b` -> `a , b`),
 *  - whitespace immediately inside/around the structural delimiters `( ) ,` is
 *    removed (so `calc( 1px + 2px )` === `calc(1px + 2px)` and
 *    `Arial , sans-serif` === `Arial,sans-serif`),
 *  - whitespace around a combinator at the SELECTOR level (`>`, `~` and the
 *    adjacent-sibling `+`) is removed, because `#a > #b` and `#a>#b` are the
 *    SAME selector : CSS treats that whitespace as insignificant. Without this
 *    the guard false-positive-rejects js-beautify's own valid output (it emits
 *    `#a>#b`), turning the formatter into a no-op on nearly every real
 *    stylesheet (SPEC §12 "faux positif de la garde", issue #67).
 *
 * Whitespace INSIDE a quoted string literal is never touched (see
 * `splitCssQuotedSpans`): `content:"a  b"` must NOT be equated with
 * `content:"a b"` : that is a real meaning change the guard must catch.
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
  // Whitespace INSIDE parentheses is insignificant : js-beautify legitimately
  // strips it (`calc( 1px + 2px )` -> `calc(1px + 2px)`), so collapsing it is
  // required to avoid rejecting the formatter's own valid output.
  //
  // Whitespace ADJACENT to a parenthesis (before `(`, after `)`) is significant
  // and must NOT be collapsed:
  //  - `calc(x)` vs `calc (x)` : an ident must touch `(` to form a function
  //    token, so `calc (` is an invalid declaration the browser drops,
  //  - `:nth-child(2n)` vs `:nth-child (2n)` : same, the whole rule is dropped,
  //  - `@media (a) and (b)` vs `(a)and(b)` : `and(` lexes as a function token,
  //    producing a malformed media query,
  //  - `:not(.a) .b` vs `:not(.a).b` : descendant combinator vs compound
  //    selector, two different selectors.
  // Verified empirically: js-beautify never inserts or removes whitespace on
  // either outer side of a parenthesis, so keeping it significant introduces no
  // false rejection.
  //
  // Whitespace around a comma stays insignificant : js-beautify normalizes
  // `Arial , sans-serif` -> `Arial, sans-serif` and the comma is a pure
  // separator in both selectors and values.
  return span
    .replace(/[ \t\n\r\f]+/g, ' ')
    .replace(/[ \t\n\r\f]*,[ \t\n\r\f]*/g, ',')
    .replace(/\([ \t\n\r\f]+/g, '(')
    .replace(/[ \t\n\r\f]+\)/g, ')');
}

function normalizeCssText(value: string | undefined): string {
  if (value === undefined || value === null) {
    return '';
  }
  return trimCssWhitespace(normalizeOutsideStrings(value, normalizeCssTextSpan));
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
 *
 * The whitespace class is CSS's own here too (see `normalizeCssTextSpan`): with
 * `\s`, `.a<U+00A0>>.b` and `.a>.b` reduced to the same selector, so a
 * combinator's neighbour could be silently rewritten as well.
 */
function normalizeCssSelectorSpan(span: string): string {
  return normalizeCssTextSpan(span).replace(/[ \t\n\r\f]*([>~+])[ \t\n\r\f]*/g, '$1');
}

function normalizeCssSelector(value: string | undefined): string {
  if (value === undefined || value === null) {
    return '';
  }
  return trimCssWhitespace(normalizeOutsideStrings(value, normalizeCssSelectorSpan));
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
 * without a space : a very common LESS style (SPEC §12 "faux positif de la
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
  //
  // "params are empty" is decided with CSS's whitespace set, not
  // `String.prototype.trim`'s: params consisting solely of, say, U+00A0 are NOT
  // empty to CSS, and reading them as empty would merge two at-rules that differ
  // by a real code point into one shape. Narrowing here can only DECLINE the
  // canonicalisation, i.e. keep more shapes distinct, which is the safe
  // direction for a verifier.
  const colon = rawName.indexOf(':');
  if (colon === -1 || (rawParams !== undefined && trimCssWhitespace(rawParams) !== '')) {
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
  // ADD-11: a load failure must escape as a thrown guard error (see astEqualJs).
  // cssParserFor already requires the chunk; the explicit call keeps that
  // guarantee true even if the parser lookup later moves inside a try/catch.
  requireGuardCssChunk();

  const parser = cssParserFor(lang);

  let inputShape: CssShape;
  try {
    inputShape = cssShape(parser(input), lang);
  } catch (error: unknown) {
    rethrowIfChunkLoadFailure(error);
    return rejected(`input did not parse: ${describeError(error)}`);
  }

  let outputShape: CssShape;
  try {
    outputShape = cssShape(parser(output), lang);
  } catch (error: unknown) {
    rethrowIfChunkLoadFailure(error);
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
  attrs?: Array<{ name: string; value: string; prefix?: string }>;
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

// WHERE "IS THIS WHITESPACE DRAWN?" IS ANSWERED. Not here. HTML decides it from
// three independent mechanisms (a preformatted TAG, `xml:space="preserve"`, the
// CSS property `white-space`), they are one concept, and they live together in
// src/safety/htmlWhitespace.ts. This walk only carries the answer down the tree.
// Deciding any part of it here is what let each of the three be forgotten in
// turn, every time with a file written whose rendered text had changed.

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

// The HTML standard's "ASCII whitespace": TAB, LF, FF, CR and SPACE, and nothing
// else. `String.prototype.trim` also removes U+000B, U+00A0, U+FEFF, U+2000-200A,
// U+2028/2029 and U+3000, which the standard leaves in the `type` it reads.
const HTML_ASCII_WHITESPACE_EDGES = /^[\t\n\f\r ]+|[\t\n\f\r ]+$/g;

/** Lower-case A-Z only (the standard's ASCII case-insensitivity); `toLowerCase` maps U+212A to `k`. */
function asciiLowerCase(value: string): string {
  return value.replace(/[A-Z]/g, (ch) => ch.toLowerCase());
}

/**
 * The script block's type string, as the HTML standard derives it ("prepare the
 * script element", C1). A non-empty `type` wins and loses only ASCII whitespace
 * at its edges. With no `type`, or an empty one, a non-empty `language` gives
 * `text/<language>` (whitespace kept: ` javascript` is not JavaScript), and with
 * neither the script is `text/javascript`. `fromLanguage` marks the last
 * derivation: such a block is never read as JSON data. A `type` of ASCII
 * whitespace only is a non-empty value that strips to the empty string, which no
 * JavaScript type matches, so it is not executable. parse5 lower-cases attribute
 * names already.
 */
function scriptType(attrs: Array<{ name: string; value: string }> | undefined): {
  type: string;
  fromLanguage: boolean;
} {
  const valueOf = (name: string): string | undefined =>
    Array.isArray(attrs) ? attrs.find((attr) => attr.name === name)?.value : undefined;
  const typeValue = valueOf('type');
  if (typeValue !== undefined && typeValue !== '') {
    return {
      type: asciiLowerCase(typeValue.replace(HTML_ASCII_WHITESPACE_EDGES, '')),
      fromLanguage: false
    };
  }
  const language = valueOf('language');
  if (language === undefined || language === '') {
    return { type: 'text/javascript', fromLanguage: false };
  }
  return { type: `text/${asciiLowerCase(language)}`, fromLanguage: true };
}

// <script> types that carry JS to execute. Anything else (application/json,
// importmap, application/ld+json, a template type, ...) is opaque data and is
// compared as canonical JSON when it parses, else verbatim.
const JS_SCRIPT_TYPES = new Set([
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
 *
 * NO SHARED PRE-TRIM. Each branch decides what surrounds its body using the
 * EMBEDDED language's own whitespace rules, because one `String.prototype.trim`
 * for all three was ECMAScript's answer applied to CSS and to JSON, and it was
 * wrong for both:
 *   - `<style><U+00A0>.a{color:red}</style>` was trimmed to `.a{color:red}`,
 *     which parses, so the printer dropping the U+00A0 compared equal and was
 *     applied. To CSS that leading code point is part of the first compound
 *     selector: before the write the browser drops the whole rule, after it the
 *     rule applies.
 *   - `<script type="application/json"><U+00A0>{"a":1}</script>` was trimmed to
 *     valid JSON. The body is NOT valid JSON (RFC 8259 allows only U+0009,
 *     U+000A, U+000D and U+0020 between tokens), so `JSON.parse` on that
 *     textContent threw before the format and succeeded after it, and the guard
 *     said equivalent. Worse, the SAME body in a standalone .json file was
 *     correctly rejected: the verdict depended on where the JSON lived.
 * The CSS and JSON branches now hand the RAW body to their parser, whose own
 * scanner is the authority on what whitespace is; the JS branch keeps `.trim()`
 * because ECMAScript's whitespace set is precisely what `trim` removes, so
 * there it is the language's own rule rather than a foreign one.
 */
function canonicalizeEmbeddedCode(
  parentTag: string,
  parentAttrs: Array<{ name: string; value: string }> | undefined,
  raw: string
): string {
  if (parentTag === 'style') {
    // ADD-11: chunk acquisition sits OUTSIDE the try so a LOAD failure
    // propagates, and the catch below rethrows one anyway. This function is the
    // ONE place a chunk is reached from inside htmlTreeEqual's try, so it is the
    // one place where a swallowed ChunkLoadError could be mislabeled as "your
    // HTML did not parse". A PARSE failure keeps the conservative verbatim
    // fallback below.
    const { parseCss } = requireGuardCssChunk();
    try {
      // RAW, not trimmed: postcss keeps leading/trailing CSS whitespace in
      // `raws`, which `cssShape` drops anyway, so a pure reindent still compares
      // equal while a leading code point CSS does NOT read as whitespace stays
      // part of the first selector where it belongs.
      //
      // The one thing postcss removes from the stream before the tree exists is
      // a LEADING byte-order mark (U+FEFF, and U+FFFE for a byte-swapped one),
      // because CSS Syntax §3.2 has the DECODING step consume it. That step
      // decodes a stylesheet resource from BYTES; an inline <style> body is
      // already characters, was never decoded, and its leading U+FEFF is
      // therefore ordinary content that makes the first compound selector
      // invalid. The printer drops it, postcss dropped it on both sides, and the
      // rewrite compared equal, so the mark is carried into the shape by hand.
      // (Standalone .css keeps postcss's spec-correct behaviour; VS Code strips
      // a file's BOM outside the document text anyway, so it never gets here.)
      const bom = raw.charCodeAt(0) === 0xfeff || raw.charCodeAt(0) === 0xfffe ? 'bom+' : '';
      return `css:${bom}${JSON.stringify(cssShape((parseCss as unknown as CssParser)(raw), 'css'))}`;
    } catch (error: unknown) {
      rethrowIfChunkLoadFailure(error);
      // Could not parse the embedded body as its declared language. Be
      // conservative and require a byte-identical body rather than guessing.
      return `verbatim:${raw}`;
    }
  }
  // parentTag === 'script'
  const { type, fromLanguage } = scriptType(parentAttrs);
  if (JS_SCRIPT_TYPES.has(type)) {
    // `String.prototype.trim` removes exactly ECMAScript's WhiteSpace +
    // LineTerminator, which IS this body's language, so here the wide set is the
    // right one rather than a borrowed one.
    const body = raw.trim();
    if (body === '') {
      return '';
    }
    // ADD-11: same rule as the <style> branch above.
    requireGuardJsChunk();
    try {
      // Include the comment multiset for the same reason as `astEqualJs`: an
      // embedded script losing an `eslint-disable` or a licence header is a
      // content loss, and the structural AST alone cannot see it.
      const parsed = parseJs(body, BABEL_PLUGINS_JSX);
      // ADD-12b: the same JSX tag-boundary fingerprint `astEqualJs` applies to a
      // .jsx/.tsx file, folded into the canonical form as a LAST field so it can
      // only ever make two bodies compare DIFFERENT, never equal. Without it a
      // detached opening `<` (`<App x={1} />` -> `< App x = {1} />`) has the same
      // AST and was accepted here while the identical text is refused in a .jsx
      // file. It reads the opening `<` only: `<Foo / >` and `</ Foo>` keep their
      // `<` glued, are valid JSX with the same AST, and stay accepted. A failure
      // to fingerprint lands in the catch below (verbatim), which is stricter.
      const boundaries = jsxBoundaryFingerprint(parsed.program, body);
      return `js:${JSON.stringify(canonicalizeAst(parsed.program))}|c:${JSON.stringify(parsed.comments)}|jsx:${boundaries}`;
    } catch (error: unknown) {
      rethrowIfChunkLoadFailure(error);
      return `verbatim:${raw}`;
    }
  }
  if (!fromLanguage && type.includes('json')) {
    try {
      // RAW, not trimmed: jsonc-parser's scanner skips exactly the four code
      // points RFC 8259 allows between tokens, so a reindent still compares
      // equal while anything else around the document keeps the body
      // unparsable and falls through to the verbatim comparison below.
      return `json:${JSON.stringify(canonicalizeJsonForEmbed(raw))}`;
    } catch {
      return `verbatim:${raw}`;
    }
  }
  // Unknown/opaque script type (e.g. an x-template): treat the body verbatim.
  // No emptiness short-circuit either: nothing here knows what language the
  // body is, so no code point in it can be proven insignificant. An all-ASCII-
  // whitespace body never reaches this function at all, because htmlShape's
  // child filter has already dropped it as a blank text node.
  return `verbatim:${raw}`;
}

/**
 * Reduce a parse5 node to a whitespace-aware structural shape.
 *
 * `whitespace` is the context THIS node was given by its parent, and it is the
 * whole answer to "is a run of spaces here drawn or is it layout". It carries
 * all three sources at once (preformatted TAG, `xml:space`, CSS `white-space`)
 * because they are one concept with three spellings; see
 * src/safety/htmlWhitespace.ts for the lattice, the inheritance rule and the
 * reason each source may only switch off what its own kind turned on.
 *
 * It is INHERITED down the recursion rather than recomputed from the immediate
 * parent, and that is load-bearing: `<pre><code>...</code></pre>` is the
 * standard code-block markup, so a parent-only test sees the text node's parent
 * as `code`, normalizes its indentation and line breaks away, and lets any
 * reflow of a code block pass unnoticed.
 */
function htmlShape(
  node: Parse5Node,
  parentTag: string | undefined,
  parentAttrs: Array<{ name: string; value: string }> | undefined,
  whitespace: WhitespaceContext = ROOT_WHITESPACE_CONTEXT
): HtmlShape {
  const shape: HtmlShape = { node: node.nodeName };

  if (node.nodeName === '#text') {
    const raw = node.value ?? '';
    if (parentTag !== undefined && EMBEDDED_CODE_TAGS.has(parentTag)) {
      shape.text = canonicalizeEmbeddedCode(parentTag, parentAttrs, raw);
      return shape;
    }
    shape.text = normalizeTextFor(significanceOf(whitespace), raw);
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
    // Attribute order is not semantically meaningful in HTML : sort by name so a
    // reorder does not register as a change.
    shape.attrs = node.attrs
      .map((attr): [string, string] => [attr.name, attr.value])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }

  const ownTag = node.tagName;
  const ownAttrs = node.attrs;
  const children: HtmlShape[] = [];

  // The context our own children inherit: whatever came in, updated by what
  // THIS element declares. One call, so no source can be forgotten on one of the
  // two child lists below and remembered on the other.
  const childWhitespace = childWhitespaceContext(whitespace, ownTag, ownAttrs);
  const childSignificance = significanceOf(childWhitespace);

  // ONE routine shapes EVERY child list, so no list can be given a different
  // whitespace rule from the others. The <template> fragment used to be walked
  // by a second, filter-less loop: a formatter that indents a <template>'s
  // children (which every formatter does) added whitespace-only #text nodes that
  // only the `.content` side counted, the child counts came out 1 vs 3, and the
  // guard rejected EVERY document containing a <template>. That is the false
  // reject a web-component / Vue / Alpine / htmx file hits on its first format,
  // and it made Tidy look broken on a whole class of ordinary pages.
  const appendChildren = (list: Parse5Node[]): void => {
    for (const child of list) {
      // Drop a text node only when its own context renders it to NOTHING: a
      // formatter freely inserts and removes those and they carry no meaning.
      // The test is the node's normalized form rather than "is it blank", which
      // is what makes it correct under `white-space: pre-line`, where a
      // whitespace-only node holding a newline IS a drawn line break and must
      // survive while a node of plain spaces beside it must not. Under a
      // verbatim context nothing is ever dropped. Inside <script>/<style> an
      // all-whitespace body is empty embedded code and is likewise
      // insignificant.
      if (
        child.nodeName === '#text' &&
        childSignificance !== 'verbatim' &&
        normalizeTextFor(childSignificance, child.value ?? '') === ''
      ) {
        continue;
      }
      children.push(htmlShape(child, ownTag, ownAttrs, childWhitespace));
    }
  };

  // <template> content lives under `.content`, a document fragment, and parse5
  // leaves the element's own `childNodes` empty; both lists are walked so a
  // future parse5 shape change cannot silently drop half the subtree.
  // The child whitespace context is carried in on purpose: a <template> inside a
  // <pre>, under an xml:space="preserve", or under a CSS white-space that
  // preserves, keeps the comparison its ancestors call for, which is the
  // conservative direction.
  if (node.content && Array.isArray(node.content.childNodes)) {
    appendChildren(node.content.childNodes);
  }
  if (Array.isArray(node.childNodes)) {
    appendChildren(node.childNodes);
  }
  if (children.length > 0) {
    shape.children = children;
  }

  return shape;
}

/**
 * True when an embedded `<style>` anywhere in this tree declares a preserving
 * `white-space` value.
 *
 * THE THIRD SOURCE'S SECOND ROUTE. `style="white-space:pre"` is read off the
 * element and answered exactly (see htmlWhitespace.ts). The same property set
 * from a `<style>` block through a class or any other selector is a different
 * question: it needs CSS selector matching against the tree, with specificity
 * and cascade order, which is a second parser and is out of this guard's scope.
 * So this returns the fact, and `htmlTreeEqual` FAILS CLOSED on it: a document
 * whose embedded CSS could make whitespace drawn is REJECTED with the file
 * untouched, rather than reflowed on the bet that the rule matches nothing.
 *
 * The `<style>` body is read RAW, never through the CSS parser: a stylesheet
 * that fails to parse must still be scanned, and this must not be able to throw
 * or to depend on a chunk load.
 */
function treeDeclaresPreservingCss(node: Parse5Node): boolean {
  if (node.tagName === 'style' && Array.isArray(node.childNodes)) {
    const body = node.childNodes
      .map((child) => (child.nodeName === '#text' ? (child.value ?? '') : ''))
      .join('');
    if (cssTextPreservesWhitespace(body)) {
      return true;
    }
  }
  // Both child lists, for the same reason htmlShape walks both: a <style> inside
  // a <template> lives under `.content` and would otherwise be invisible.
  if (node.content && Array.isArray(node.content.childNodes)) {
    for (const child of node.content.childNodes) {
      if (treeDeclaresPreservingCss(child)) {
        return true;
      }
    }
  }
  if (Array.isArray(node.childNodes)) {
    for (const child of node.childNodes) {
      if (treeDeclaresPreservingCss(child)) {
        return true;
      }
    }
  }
  return false;
}

/** What one side of the comparison contributes: its shape and its CSS risk. */
interface HtmlAnalysis {
  shape: HtmlShape;
  preservingCss: boolean;
}

/**
 * Tree comparison for HTML using parse5. A full document and a fragment are both
 * accepted: we try the full-document parse and fall back to a fragment parse so
 * that partial snippets (e.g. range formatting) still compare correctly.
 */
export function htmlTreeEqual(input: string, output: string): GuardVerdict {
  // ADD-11: a load failure must escape as a thrown guard error (see astEqualJs).
  const { parseHtml, parseHtmlFragment } = requireGuardHtmlChunk();

  const buildShape = (html: string): HtmlAnalysis => {
    const looksLikeDocument = /<(!doctype|html)\b/i.test(html);
    const root = (looksLikeDocument ? parseHtml(html) : parseHtmlFragment(html)) as unknown as Parse5Node;
    return {
      shape: htmlShape(root, undefined, undefined),
      // The pre-filter is a proof of absence, not a heuristic: <style> is a
      // RAW TEXT element, so its body is a byte-for-byte substring of the
      // document (parse5 decodes no character reference inside it), and a
      // document with no way to spell the property name has no such
      // declaration to find. It only ever saves the walk; it can never skip a
      // declaration that is there.
      preservingCss:
        mayDeclareWhiteSpace(html) && treeDeclaresPreservingCss(root)
    };
  };

  let inputShape: HtmlAnalysis;
  try {
    inputShape = buildShape(input);
  } catch (error: unknown) {
    // buildShape reaches the CSS and JS verifier chunks for embedded
    // <style>/<script> bodies, so this catch is the one place a LOAD failure
    // could be reported as a parse failure of the user's HTML. It is not one:
    // rethrow so the outcome stays an engine/load error (still ZERO edits).
    rethrowIfChunkLoadFailure(error);
    return rejected(`input did not parse: ${describeError(error)}`);
  }

  let outputShape: HtmlAnalysis;
  try {
    outputShape = buildShape(output);
  } catch (error: unknown) {
    rethrowIfChunkLoadFailure(error);
    return rejected(`formatted output did not parse: ${describeError(error)}`);
  }

  if (JSON.stringify(inputShape.shape) !== JSON.stringify(outputShape.shape)) {
    return rejected('HTML tree changed after formatting');
  }
  // Last, and only on the path that would otherwise ACCEPT: the shapes agree
  // under the whitespace rules this walk could prove, but an embedded stylesheet
  // may hand a preserving `white-space` to elements those rules treated as
  // reflowable. Which elements is a CSS selector-matching question the guard
  // does not answer, so it declines the format instead of guessing. Both sides
  // are consulted: a stylesheet the OUTPUT gained is exactly as unprovable as
  // one the input already had.
  if (inputShape.preservingCss || outputShape.preservingCss) {
    return rejected(EMBEDDED_CSS_WHITESPACE_REASON);
  }
  return EQUIVALENT;
}

// --- JSON / JSONC ----------------------------------------------------------

/**
 * Canonical form of a JSON/JSONC document: every OBJECT becomes a
 * `CanonicalObject` holding its `[key, value]` pairs sorted by key, every ARRAY
 * keeps its order as a plain array, and every literal keeps the JS value the
 * parser produced.
 *
 * Three properties of this shape are load-bearing for the guard, and each of
 * them was paid for by a real false accept:
 *
 *  1. `__proto__` is ordinary data. Assembling members with `obj[key] = value`
 *     hits the prototype setter and leaves NO own property, so a `"__proto__"`
 *     member vanished during parsing and its silent removal was accepted
 *     (v0.2.2). Pair arrays take prototype semantics out of the comparison.
 *  2. DUPLICATE members survive. `{"a":1,"a":2}` is a legal JSON text with two
 *     members; a canonical form built from an assembled JS object keeps only
 *     the last one, so deleting a duplicate member looked like a no-op (v0.4.0,
 *     see `parseJsonValue`).
 *  3. OBJECTS and ARRAYS stay distinguishable. Once objects are pair arrays, a
 *     BARE pair array gives `{"a":1}` and the JSON array `[["a",1]]` the SAME
 *     canonical value (likewise `{}` and `[]`), so rewriting an object into an
 *     array was accepted as equivalent (v0.4.0). `CanonicalObject` is a nominal
 *     wrapper, so the two shapes can never collide again.
 *
 * The sort is by KEY ONLY, and `Array.prototype.sort` is stable, so members
 * sharing a key keep their source order: rewriting `{"a":1,"a":2}` into
 * `{"a":2,"a":1}` changes which member wins and is rejected, while an ordinary
 * reorder of DISTINCT keys stays equivalent, as JSON semantics require.
 */
function compareCanonicalMembers(a: [string, unknown], b: [string, unknown]): number {
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
}

/**
 * The wrapper key `CanonicalObject.toJSON` emits. Only `canonicalizeJsonForEmbed`
 * stringifies a canonical value; the key exists so that serialisation stays
 * injective (a JSON object always serialises to a one-key JSON object, a JSON
 * array always to a JSON array), never as data any user can see or collide with.
 */
const CANONICAL_OBJECT_TAG = '#tidy-json-object';

/**
 * Canonical form of a JSON OBJECT: its members as `[key, value]` pairs sorted by
 * key, behind a NOMINAL wrapper.
 *
 * The wrapper is load-bearing, and it is the third false accept this canonical
 * form has had to pay for. Representing an object as the BARE pair array made it
 * indistinguishable from a JSON ARRAY of two-element arrays, so the guard
 * accepted `{"a":1}` -> `[["a",1]]` and `{}` -> `[]` as equivalent: an object
 * silently rewritten into an array would have been written to the user's file.
 * A class instance is not an Array, so `jsonDeepEqual` splits the two shapes on
 * a branch that cannot be crossed by accident.
 */
class CanonicalObject {
  public constructor(public readonly members: ReadonlyArray<readonly [string, unknown]>) {}

  /** Keeps `JSON.stringify` of a canonical value injective (see the tag above). */
  public toJSON(): Record<string, unknown> {
    return { [CANONICAL_OBJECT_TAG]: this.members };
  }
}

/**
 * One container still open while a document is streamed into canonical form.
 *
 * `key` is the property name the FINISHED container will be attached under in
 * its parent object (null inside an array, and at the document root). It is
 * captured when the container OPENS because nested properties overwrite the
 * pending key long before the container closes.
 */
type CanonicalFrame =
  | { readonly kind: 'object'; readonly key: string | null; readonly pairs: Array<[string, unknown]> }
  | { readonly kind: 'array'; readonly key: string | null; readonly items: unknown[] };

/**
 * Parse a JSON/JSONC document into the canonical form above.
 *
 * ONE parser, at EVERY document size. Until v0.4.0 a document of at least 256 KB
 * short-circuited to native `JSON.parse`, justified by a comment claiming the
 * two parsers were value-identical on strict JSON. They are not: native
 * `JSON.parse` keeps only the LAST member of a duplicated key, while the
 * jsonc-parser path keeps both. The guard's verdict therefore depended on the
 * LENGTH of the document, in both directions:
 *
 *   - false REJECT: a 166 KB minified document containing a duplicate key,
 *     pretty-printed to 305 KB with both members intact, was rejected as
 *     "JSON value changed after formatting" (input kept the duplicate, output
 *     collapsed it);
 *   - false ACCEPT: with both sides over 256 KB, an edit that DELETED one of
 *     two duplicate members was accepted as equivalent. Tidy's own engine
 *     preserves duplicates, so it does not produce that output today, but the
 *     guard is the last line of defence and has to be sound on its own terms:
 *     "our engine would never emit that" is not a proof of equivalence.
 *
 * Streaming with `visit` rather than building a `parseTree` is what pays for
 * that soundness, and it is cross-checked rather than asserted: an independent
 * reference that walks jsonc-parser's syntax TREE re-derives the verdict over a
 * seeded corpus of generated documents (duplicates, `__proto__`, arrays of
 * two-element arrays) and the two agree, at both document sizes. See the oracle
 * in test/unit/safety/guardJsonOracle.test.ts.
 *
 * Against that tree path, which every document under 256 KB already used, the
 * streaming pass is FASTER: 32-38 % less time, and 3.8x less peak heap (49.9 MB
 * retained vs 190.5 MB for tree + value on a 4.8 MB document), because no node
 * objects, offsets or parent pointers are allocated.
 *
 * Documents over 256 KB, which used to take the unsound native short-circuit,
 * genuinely pay, and the cost is bigger than a rounding error. Ratios first,
 * since they hold across machines (each was measured by alternating the
 * variants inside ONE process, so load hits them equally):
 *   - the JSON verdict costs 4.5-4.8x what `JSON.parse` plus the old key-set
 *     compare did, at every pair size measured, from 1 MB to 30 MB;
 *   - about two thirds of that is jsonc-parser's SCANNER, not this
 *     canonicalizer: the same `visit` with callbacks that build NOTHING already
 *     costs 3x `JSON.parse`, and our callbacks add ~34 % on top. Short of a
 *     hand-written scanner there is no cheap win left here.
 * In wall-clock terms, `npm run perf` on a 10 MB document (the ADD-08 default
 * cap for json/jsonc, so the worst case that can reach the guard at all)
 * measured 2116 ms of format+guard on an idle reference machine (Node 24,
 * win32 x64; guard 1104 ms of it) and 2820-2988 ms on the same machine under
 * heavy parallel load. The 4000 ms budget PASSES in both, as does the 5 MB
 * document against its 2000 ms budget (1012-1353 ms).
 *
 * The frozen regression baseline (test/perf/baseline.json, json_10mb p95
 * 1524 ms) was recorded against the UNSOUND fast path and no longer holds, so
 * `npm run perf:check` flags json_10mb until that baseline is deliberately
 * refreshed. The 4 s budget is the contract; the baseline is a tripwire, and it
 * is the tripwire that moved. Soundness first.
 *
 * Throws on any parse error, so the guard still rejects unparsable output.
 */
function parseJsonValue(code: string): unknown {
  const stack: CanonicalFrame[] = [];
  let pendingKey: string | null = null;
  let root: unknown;
  let rooted = false;
  // Held in an object, not a `let`: TypeScript keeps narrowing a `let` that is
  // only ever assigned inside a callback, and would type the post-visit read as
  // `never`.
  const failure: { first: { readonly error: ParseErrorCode; readonly offset: number } | null } = {
    first: null
  };

  const attach = (value: unknown, key: string | null): void => {
    const parent = stack[stack.length - 1];
    if (parent === undefined) {
      root = value;
      rooted = true;
      return;
    }
    if (parent.kind === 'array') {
      parent.items.push(value);
      return;
    }
    // A member with no name only occurs in malformed input, which the parse
    // error below rejects; '' just keeps the shape well formed until then.
    parent.pairs.push([key ?? '', value]);
  };

  const closeFrame = (): void => {
    const frame = stack.pop();
    if (frame === undefined) {
      // Unreachable: jsonc-parser emits Begin/End in matched pairs (parseObject
      // and parseArray each emit both around their body, error recovery
      // included). Throwing keeps a hypothetical verifier bug fail-safe (the
      // caller applies ZERO edits) instead of silently dropping a member.
      throw new Error('JSON guard internal error: unbalanced JSON container');
    }
    attach(
      frame.kind === 'object'
        ? new CanonicalObject(frame.pairs.sort(compareCanonicalMembers))
        : frame.items,
      frame.key
    );
  };

  // allowTrailingComma covers JSONC. Comments are not visited at all, which is
  // correct: comment movement is whitespace/style, not value structure.
  visitJsonc(
    code,
    {
      onObjectBegin(): void {
        stack.push({ kind: 'object', key: pendingKey, pairs: [] });
        pendingKey = null;
      },
      onObjectProperty(property: string): void {
        pendingKey = property;
      },
      onObjectEnd: closeFrame,
      onArrayBegin(): void {
        stack.push({ kind: 'array', key: pendingKey, items: [] });
        pendingKey = null;
      },
      onArrayEnd: closeFrame,
      onLiteralValue(value: unknown): void {
        attach(value ?? null, pendingKey);
        pendingKey = null;
      },
      onError(error: ParseErrorCode, offset: number): void {
        // Only the FIRST error is reported: jsonc-parser recovers and keeps
        // going, so later errors are usually cascades of the first one.
        if (failure.first === null) {
          failure.first = { error, offset };
        }
      }
    },
    { allowTrailingComma: true, disallowComments: false }
  );

  const parseFailure = failure.first;
  if (parseFailure !== null) {
    throw new Error(
      `JSON parse error: ${printParseErrorCode(parseFailure.error)} at offset ${parseFailure.offset}`
    );
  }
  if (!rooted) {
    throw new Error('JSON parse error: empty document');
  }
  return root;
}

/**
 * Parse JSON/JSONC text and return a key-order-independent canonical value
 * (object keys sorted; array order preserved) suitable for a stable string
 * comparison of an embedded <script type="application/json"> body. Throws on
 * invalid JSON so the caller can fall back to a verbatim comparison.
 */
function canonicalizeJsonForEmbed(code: string): unknown {
  // `parseJsonValue` already returns the canonical, key-sorted member form (see
  // `CanonicalObject`), which is exactly what a stable string comparison of an
  // embedded JSON body needs, duplicate members included. `CanonicalObject`
  // serialises through its `toJSON`, so an object and an array can never
  // stringify to the same text either.
  return parseJsonValue(code);
}

/**
 * Deep structural equality of two CANONICAL JSON values, i.e. of whatever
 * `parseJsonValue` returns: `CanonicalObject`, arrays, and JSON primitives.
 * Nothing else can appear, and every shape is handled below, so the function is
 * total: no fall-through can answer "equal" by omission.
 *
 * Objects and arrays match on SEPARATE branches and can never satisfy each
 * other, which is what stops `{"a":1}` from being accepted as `[["a",1]]`.
 * Members arrive already sorted by key, so source key ORDER is irrelevant (as
 * JSON semantics require) while duplicate members stay individually significant;
 * array order is meaningful and preserved.
 */
function jsonDeepEqual(a: unknown, b: unknown): boolean {
  if (a instanceof CanonicalObject || b instanceof CanonicalObject) {
    if (!(a instanceof CanonicalObject) || !(b instanceof CanonicalObject)) {
      // An object against an array or a primitive: different JSON values.
      return false;
    }
    if (a.members.length !== b.members.length) {
      return false;
    }
    // Positional, not set-based: the member lists are key-sorted, so equal
    // positions means equal keys AND the same number of duplicates per key.
    return a.members.every((member, index) => {
      const other = b.members[index];
      return member[0] === other[0] && jsonDeepEqual(member[1], other[1]);
    });
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, index) => jsonDeepEqual(item, b[index]));
  }
  // Only JSON primitives remain: string, number, boolean, null. `===` and NOT
  // `Object.is`, deliberately. The two differ on exactly one pair a JSON
  // document can produce, `0` and `-0`, and JSON numbers are decimal values
  // with no signed zero: `JSON.stringify(-0)` is `"0"`, so any formatter that
  // round-trips through a parser emits `0` for `-0` and `Object.is` would turn
  // that honest reformat into a false REJECT (test/unit/complex/json.complex
  // .test.ts pins it). `===` cannot merge anything else here: NaN and Infinity
  // have no JSON literal, and every non-primitive left the function above.
  return a === b;
}

/**
 * Value-level equality for JSON/JSONC. Parses both sides into the canonical
 * pair-array form with `parseJsonValue` and deep-compares them.
 *
 * The verdict depends ONLY on the two documents' values, never on how long they
 * are: `parseJsonValue` runs the same parser at every size (see its comment for
 * the size-dependent false accept that removing the native fast path closed).
 * Any value change, including adding, dropping or reordering a duplicate member,
 * is rejected.
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
