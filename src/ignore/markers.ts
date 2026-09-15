// In-source ignore markers (Axe 4.T1): a PURE scanner that finds the directives
// a user writes inside the code itself. Three kinds, all expressed as comments
// using the host language's comment syntax:
//
//   (a) FILE ignore   : the first significant comment at the very top contains
//                       "tidy-ignore-file" / "tidy-ignore", OR a leading
//                       "prettier-ignore". The whole document is left verbatim.
//   (b) REGION ignore : a "tidy-ignore-start" comment opens a protected span that
//                       a "tidy-ignore-end" comment closes; the byte range
//                       in-between (markers included) is preserved verbatim.
//   (c) NODE ignore   : a "tidy-ignore" / "prettier-ignore" comment immediately
//                       preceding a node protects that node (best-effort,
//                       conservative line heuristic).
//
// PURE: this module imports neither 'vscode' nor any parser/engine. It works on
// the raw text + the languageId only, so it is exhaustively unit-testable. The
// caller (the provider, behind the safety guard) is responsible for splicing the
// protected ranges back VERBATIM so the final output stays equivalent to the
// input : meaning the guard always accepts and the file can never be corrupted.
import type { LangId } from '../types';

/** Directive keyword recognised to ignore a whole FILE (anywhere in the head). */
const FILE_IGNORE_KEYWORDS = ['tidy-ignore-file', 'tidy-ignore', 'prettier-ignore'] as const;

/** Directive keyword recognised to ignore the NEXT node (best-effort). */
const NODE_IGNORE_KEYWORDS = ['tidy-ignore', 'prettier-ignore'] as const;

/** Region open / close keywords (must appear inside a comment). */
const REGION_START_KEYWORD = 'tidy-ignore-start';
const REGION_END_KEYWORD = 'tidy-ignore-end';

/**
 * A half-open byte range [start, end) of the document that must be preserved
 * VERBATIM. Offsets index into the original text the scanner was given.
 */
export interface ProtectedRange {
  readonly start: number;
  readonly end: number;
  /** Why it is protected, for diagnostics / Show Config (never user content). */
  readonly kind: 'region' | 'node';
}

/** The full result of scanning a document for ignore markers. */
export interface MarkerScan {
  /** True when the ENTIRE document must be left untouched (file-level ignore). */
  readonly ignoreFile: boolean;
  /**
   * Non-overlapping protected ranges (region + node), sorted by start offset.
   * Empty when the file is wholly ignored (the caller short-circuits on that) or
   * when there are no markers.
   */
  readonly protectedRanges: ProtectedRange[];
}

/**
 * Quote characters that open a string literal, per language family.
 *
 * HTML IS NOT IN THIS LIST ON PURPOSE (v0.4.1, M3-4). In HTML *character data*
 * an apostrophe is a letter, not a delimiter: `<p>don't</p>` is ordinary text.
 * Treating it as a string opener made the scanner swallow everything from that
 * apostrophe to the next one (or to end-of-file on an odd count), so a
 * `<!-- tidy-ignore-start -->` after it was never seen, `protectedRanges` came
 * back EMPTY, and Tidy reformatted bytes the user had explicitly protected
 * WITHOUT even raising the "markers not applied" notice. Quotes still bind where
 * HTML really does quote : inside a tag (attribute values) and inside the raw
 * text of <script> / <style>, which `scanComments` tracks below.
 */
const JS_QUOTES: ReadonlySet<string> = new Set(['"', "'", '`']);
const CSS_QUOTES: ReadonlySet<string> = new Set(['"', "'"]);
/** JSON strings are double-quoted only: `'` and `` ` `` are not delimiters. */
const JSON_QUOTES: ReadonlySet<string> = new Set(['"']);
/** HTML attribute values may be single- or double-quoted (never backticked). */
const HTML_ATTRIBUTE_QUOTES: ReadonlySet<string> = new Set(['"', "'"]);
/** Nothing is a string delimiter in HTML character data. */
const NO_QUOTES: ReadonlySet<string> = new Set();

/** Which comment delimiters a language uses, for region/node detection. */
interface CommentSyntax {
  /** Line-comment opener, e.g. "//" : undefined when the language has none. */
  readonly line?: string;
  /** Block-comment delimiters, e.g. ["/*", "*\/"] or ["<!--", "-->"]. */
  readonly block?: readonly [string, string];
  /**
   * Quote characters that open a string literal in this language's ordinary
   * code. EMPTY for markup languages, where quoting is positional (see
   * `markup` and the note on JS_QUOTES above).
   */
  readonly quotes: ReadonlySet<string>;
  /**
   * The language is MARKUP (html): `<tag …>` regions and <script>/<style> raw
   * text have their own quoting rules, and character data has none at all.
   */
  readonly markup?: boolean;
}

/**
 * Comment syntax per language family. CSS has no line comments (only block);
 * HTML uses SGML comments; the JS family and JSON-with-comments use // and /* *\/.
 * Plain JSON technically has no comments, but Tidy treats JSONC-style comments
 * leniently here (the guard remains the source of truth on validity).
 *
 * The `quotes` field is what stops a stray quote from eating the scan; every
 * language the scanner serves declares its own set explicitly, so widening the
 * LangId union forces a decision here instead of silently inheriting the JS one.
 */
function commentSyntaxFor(lang: LangId): CommentSyntax {
  switch (lang) {
    case 'html':
      return { block: ['<!--', '-->'], quotes: NO_QUOTES, markup: true };
    case 'css':
    case 'scss':
    case 'less':
      // SCSS/LESS also allow //, but block comments are universal across CSS.
      return {
        line: lang === 'css' ? undefined : '//',
        block: ['/*', '*/'],
        quotes: CSS_QUOTES
      };
    case 'json':
    case 'jsonc':
      return { line: '//', block: ['/*', '*/'], quotes: JSON_QUOTES };
    case 'javascript':
    case 'javascriptreact':
    case 'typescript':
    case 'typescriptreact':
    default:
      return { line: '//', block: ['/*', '*/'], quotes: JS_QUOTES };
  }
}

/** True when `haystack` contains any of the keywords (case-sensitive). */
function containsAny(haystack: string, keywords: readonly string[]): boolean {
  return keywords.some((keyword) => haystack.includes(keyword));
}

/**
 * Read the FIRST significant comment block/line at the very top of the file
 * (skipping leading blank lines, a shebang, and a UTF-8 BOM) and return its
 * inner text, or undefined when the file does not start with a comment.
 *
 * "Significant" = the first non-blank, non-shebang content. If that content is
 * not a comment, there is no head comment to inspect (so no file-level ignore).
 */
function readHeadComment(text: string, syntax: CommentSyntax): string | undefined {
  let i = 0;
  // Skip a UTF-8 BOM.
  if (text.charCodeAt(0) === 0xfeff) {
    i = 1;
  }
  // Skip leading whitespace / blank lines.
  while (i < text.length && /\s/.test(text[i])) {
    i += 1;
  }
  // Skip a shebang line (only meaningful at the very top of a script).
  if (text.startsWith('#!', i)) {
    const nl = text.indexOf('\n', i);
    i = nl === -1 ? text.length : nl + 1;
    while (i < text.length && /\s/.test(text[i])) {
      i += 1;
    }
  }
  if (i >= text.length) {
    return undefined;
  }

  const rest = text.slice(i);

  if (syntax.block && rest.startsWith(syntax.block[0])) {
    const closeAt = rest.indexOf(syntax.block[1], syntax.block[0].length);
    const inner = closeAt === -1 ? rest.slice(syntax.block[0].length) : rest.slice(syntax.block[0].length, closeAt);
    return inner;
  }
  if (syntax.line && rest.startsWith(syntax.line)) {
    const nl = rest.indexOf('\n');
    return nl === -1 ? rest.slice(syntax.line.length) : rest.slice(syntax.line.length, nl);
  }
  return undefined;
}

/**
 * Whether the WHOLE file must be ignored: the first significant comment at the
 * top contains a file-ignore keyword. "prettier-ignore" at the head is honoured
 * for parity with Prettier (a head "// prettier-ignore" disables formatting of
 * the file). Conservative: only the genuine head comment is inspected, never a
 * keyword buried deep in the file.
 */
export function detectFileIgnore(text: string, lang: LangId): boolean {
  if (typeof text !== 'string' || text === '') {
    return false;
  }
  const head = readHeadComment(text, commentSyntaxFor(lang));
  if (head === undefined) {
    return false;
  }
  // A head region marker ("tidy-ignore-start"/"-end") contains "tidy-ignore" as a
  // substring but means "protect a region", NOT "ignore the whole file". Treat it
  // as a region, never a file-ignore, so the region scanner can handle it.
  if (head.includes(REGION_START_KEYWORD) || head.includes(REGION_END_KEYWORD)) {
    return false;
  }
  return containsAny(head, FILE_IGNORE_KEYWORDS);
}

/** A single comment occurrence located in the text, with its byte span + body. */
interface CommentHit {
  /** Offset of the comment opener. */
  readonly start: number;
  /** Offset just past the comment (exclusive). */
  readonly end: number;
  /** The comment's inner text (between the delimiters), for keyword scanning. */
  readonly body: string;
  /** Offset of the start of the line the comment opener sits on. */
  readonly lineStart: number;
}

/**
 * Where the markup scanner currently is. Non-markup languages never leave
 * 'code'.
 *   - 'code'    : ordinary source, or HTML character data (no quoting there);
 *   - 'tag'     : between `<` and the `>` that closes it, where an attribute
 *                 value IS quoted;
 *   - 'rawtext' : inside <script> / <style>, where the embedded language's own
 *                 quoting rules apply again.
 */
type ScanMode = 'code' | 'tag' | 'rawtext';

/**
 * The HTML elements whose content is raw text with its own quoting rules. A Map
 * (not an object literal) so a tag literally named `constructor` or `toString`
 * cannot be answered by Object.prototype.
 */
const RAW_TEXT_QUOTES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['script', JS_QUOTES],
  ['style', CSS_QUOTES]
]);

/**
 * The last line start at or before `to`, given that `from` was reached with
 * `current` as the line start. Used after jumping over a span (a comment, a
 * multi-line string) so a later hit still reports the line IT sits on.
 */
function trackLineStarts(
  text: string,
  from: number,
  to: number,
  current: number
): number {
  let lineStart = current;
  for (let k = from; k < to; k += 1) {
    if (text[k] === '\n') {
      lineStart = k + 1;
    }
  }
  return lineStart;
}

/** Character-class helpers on code points: this scanner runs per character. */
function isAsciiLetter(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}
function isAsciiAlphanumeric(code: number): boolean {
  return isAsciiLetter(code) || (code >= 0x30 && code <= 0x39);
}

/**
 * The lowercase tag name of the element opening at `open` (which must be the
 * `<`), or undefined when `<` does not start a tag. Only an ASCII-letter start
 * opens an element, so `a < b` in text stays text.
 *
 * The EMPTY STRING means "a `>`-terminated region whose name does not matter":
 * a markup declaration or processing instruction (`<!DOCTYPE`, `<?xml`), and
 * any element whose name cannot be `style` (5 letters) or `script` (6). The
 * name is only materialised for those two lengths, so a page with 100 000 tags
 * does not allocate 100 000 lowercase copies to learn nothing; the empty string
 * is in neither RAW_TEXT_QUOTES nor `rawTextTag`, so it can only ever read as
 * "an ordinary tag".
 */
function tagNameAt(text: string, open: number): string | undefined {
  let i = open + 1;
  const next = text.charCodeAt(i);
  if (next === 0x2f /* / */) {
    i += 1;
  } else if (next === 0x21 /* ! */ || next === 0x3f /* ? */) {
    return '';
  }
  const nameStart = i;
  if (!isAsciiLetter(text.charCodeAt(i))) {
    return undefined;
  }
  i += 1;
  while (i < text.length && isAsciiAlphanumeric(text.charCodeAt(i))) {
    i += 1;
  }
  const length = i - nameStart;
  if (length !== 5 && length !== 6) {
    return ''; // cannot be 'style' (5) or 'script' (6): name not needed.
  }
  return text.slice(nameStart, i).toLowerCase();
}

/**
 * Enumerate every comment in the document, in order. A best-effort lexical scan:
 * it understands the language's line/block delimiters and skips over string
 * literals so a "// ..." inside a JS string is not mistaken for a comment.
 * Conservative by design : it never claims a comment it is unsure about, so a
 * marker in odd contexts simply protects nothing (never over-deletes).
 *
 * QUOTING IS POSITIONAL IN MARKUP (v0.4.1, M3-4). For html the scanner walks a
 * three-state machine so that an apostrophe in `<p>don't</p>` is a letter, while
 * the quotes of `<a href='x'>` and of `var s = 'y';` inside a <script> still
 * delimit. Before this, ONE apostrophe anywhere in HTML text opened a pseudo
 * string that ran to the next apostrophe (or to end-of-file), hiding every
 * marker behind it.
 */
function scanComments(text: string, syntax: CommentSyntax): CommentHit[] {
  const hits: CommentHit[] = [];
  const len = text.length;
  let lineStart = 0;
  let i = 0;

  const blockOpen = syntax.block?.[0];
  const blockClose = syntax.block?.[1];
  const lineOpen = syntax.line;

  let mode: ScanMode = 'code';
  /** Quotes in force where the scanner stands: only changes with `mode`. */
  let activeQuotes: ReadonlySet<string> = syntax.quotes;
  /** Name of the raw-text element currently open, e.g. 'script'. */
  let rawTextTag: string | undefined;
  /** Raw-text element whose opening tag is being scanned right now. */
  let pendingRawText: string | undefined;

  while (i < len) {
    const ch = text[i];

    if (ch === '\n') {
      lineStart = i + 1;
      i += 1;
      continue;
    }

    // Inside `<… >`: quotes delimit attribute values (which may span lines),
    // and nothing else is a comment or a string there.
    if (mode === 'tag') {
      if (HTML_ATTRIBUTE_QUOTES.has(ch)) {
        const end = stringEnd(text, i, ch, true);
        if (end !== undefined) {
          lineStart = trackLineStarts(text, i, end, lineStart);
          i = end;
          continue;
        }
      } else if (ch === '>') {
        mode = pendingRawText === undefined ? 'code' : 'rawtext';
        rawTextTag = pendingRawText;
        activeQuotes =
          pendingRawText === undefined
            ? syntax.quotes
            : (RAW_TEXT_QUOTES.get(pendingRawText) ?? NO_QUOTES);
        pendingRawText = undefined;
      }
      i += 1;
      continue;
    }

    if (blockOpen && text.startsWith(blockOpen, i)) {
      const closeAt = text.indexOf(blockClose as string, i + blockOpen.length);
      const end = closeAt === -1 ? len : closeAt + (blockClose as string).length;
      const body = text.slice(i + blockOpen.length, closeAt === -1 ? len : closeAt);
      hits.push({ start: i, end, body, lineStart });
      // Advance line tracking across any newlines inside the block comment.
      lineStart = trackLineStarts(text, i, end, lineStart);
      i = end;
      continue;
    }

    if (lineOpen && text.startsWith(lineOpen, i)) {
      const nl = text.indexOf('\n', i);
      const end = nl === -1 ? len : nl;
      const body = text.slice(i + lineOpen.length, end);
      hits.push({ start: i, end, body, lineStart });
      i = end;
      continue;
    }

    // Skip string / template literals so their contents are never mis-scanned
    // as comments. In markup this set is empty in character data and carries
    // the embedded language's quotes inside <script>/<style>.
    if (activeQuotes.has(ch)) {
      const end = stringEnd(text, i, ch, ch === '`');
      if (end !== undefined) {
        lineStart = trackLineStarts(text, i, end, lineStart);
        i = end;
        continue;
      }
      // No closing quote: it was not a string literal after all. Fall through
      // and keep scanning from the next character, so the rest of the document
      // still yields its markers.
    }

    if (syntax.markup && ch === '<') {
      const name = tagNameAt(text, i);
      if (name !== undefined) {
        if (mode === 'rawtext') {
          // Only the matching end tag closes a raw-text element.
          if (text[i + 1] === '/' && name === rawTextTag) {
            mode = 'tag';
            rawTextTag = undefined;
            i += 2 + name.length;
            continue;
          }
        } else {
          mode = 'tag';
          pendingRawText =
            text[i + 1] !== '/' && RAW_TEXT_QUOTES.has(name) ? name : undefined;
          i += 1;
          continue;
        }
      }
    }

    i += 1;
  }

  return hits;
}

/**
 * The offset just past the string literal opened at `open`, or undefined when
 * there is no closing quote, in which case the caller treats the quote as an
 * ordinary character.
 *
 * Honours backslash escapes. `multiline` is false for `'`/`"` literals, which
 * cannot contain a raw line break in any language here (a backslash-escaped one
 * is consumed by the escape branch), and true for template literals and HTML
 * attribute values, which can. Refusing to run past the end of the line is what
 * keeps ONE stray quote from hiding every marker below it: the scan resumes
 * instead of treating the remainder of the file as string content.
 */
function stringEnd(
  text: string,
  open: number,
  quote: string,
  multiline: boolean
): number | undefined {
  let i = open + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === quote) {
      return i + 1;
    }
    if (ch === '\n' && !multiline) {
      return undefined;
    }
    i += 1;
  }
  return undefined;
}

/** Offset of the end of the line containing `offset` (the next "\n" or EOF). */
function endOfLine(text: string, offset: number): number {
  const nl = text.indexOf('\n', offset);
  return nl === -1 ? text.length : nl;
}

/** Offset of the start of the next line after `offset`, or EOF. */
function startOfNextLine(text: string, offset: number): number {
  const nl = text.indexOf('\n', offset);
  return nl === -1 ? text.length : nl + 1;
}

/**
 * Build the protected REGION ranges between matched start/end markers. Regions
 * do not nest: the first start opens, the next end closes; an unterminated start
 * protects to end-of-file (conservative : protect MORE, never less). The whole
 * span from the start marker's line through the end marker's line is preserved.
 */
function collectRegions(text: string, comments: readonly CommentHit[]): ProtectedRange[] {
  const ranges: ProtectedRange[] = [];
  let openAt: number | undefined;

  for (const comment of comments) {
    if (openAt === undefined) {
      if (comment.body.includes(REGION_START_KEYWORD)) {
        // Protect from the start of the marker's line so its own indentation is
        // kept verbatim too.
        openAt = comment.lineStart;
      }
      continue;
    }
    if (comment.body.includes(REGION_END_KEYWORD)) {
      ranges.push({ start: openAt, end: endOfLine(text, comment.end), kind: 'region' });
      openAt = undefined;
    }
  }

  if (openAt !== undefined) {
    // Unterminated region: protect to EOF.
    ranges.push({ start: openAt, end: text.length, kind: 'region' });
  }
  return ranges;
}

/**
 * Build the best-effort protected NODE ranges: a lone "tidy-ignore" /
 * "prettier-ignore" comment (NOT a region start/end) protects the line(s) of the
 * node that immediately follows. The heuristic is deliberately coarse and
 * conservative: it protects from the marker comment's line through the end of the
 * NEXT non-blank line. The downstream guard makes this safe : if the coarse span
 * ever produced a non-equivalent splice, the guard rejects and the file is left
 * intact, so erring toward protecting more can never corrupt.
 */
function collectNodeMarkers(
  text: string,
  comments: readonly CommentHit[]
): ProtectedRange[] {
  const ranges: ProtectedRange[] = [];

  for (const comment of comments) {
    // Region markers are handled separately; never treat them as node markers.
    if (comment.body.includes(REGION_START_KEYWORD) || comment.body.includes(REGION_END_KEYWORD)) {
      continue;
    }
    if (!containsAny(comment.body, NODE_IGNORE_KEYWORDS)) {
      continue;
    }

    const nodeLineEnd = firstNonBlankLineEnd(text, startOfNextLine(text, comment.end));
    // No following node (marker is at/near EOF with only blanks after it):
    // protect just the marker's own line, conservatively.
    const end = nodeLineEnd ?? endOfLine(text, comment.end);
    ranges.push({ start: comment.lineStart, end, kind: 'node' });
  }

  return ranges;
}

/**
 * Starting at `from`, return the end-offset of the first non-blank line, or
 * undefined when only blank lines (or nothing) remain to end-of-text.
 */
function firstNonBlankLineEnd(text: string, from: number): number | undefined {
  let cursor = from;
  while (cursor < text.length) {
    const lineEnd = endOfLine(text, cursor);
    if (text.slice(cursor, lineEnd).trim() !== '') {
      return lineEnd;
    }
    if (lineEnd >= text.length) {
      return undefined;
    }
    cursor = lineEnd + 1;
  }
  return undefined;
}

/**
 * Merge overlapping/adjacent ranges and sort by start so the caller can splice
 * cleanly with no double-counted bytes. Region and node protections combine into
 * a single non-overlapping partition of protected spans.
 */
function mergeRanges(ranges: ProtectedRange[]): ProtectedRange[] {
  if (ranges.length <= 1) {
    return [...ranges];
  }
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: ProtectedRange[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i += 1) {
    const current = sorted[i];
    const last = merged[merged.length - 1];
    if (current.start <= last.end) {
      // Overlap/adjacent: extend the last range; a region label dominates a node.
      merged[merged.length - 1] = {
        start: last.start,
        end: Math.max(last.end, current.end),
        kind: last.kind === 'region' || current.kind === 'region' ? 'region' : 'node'
      };
    } else {
      merged.push(current);
    }
  }
  return merged;
}

/**
 * Scan a document for ALL ignore markers and return the file-level verdict plus
 * the merged, sorted protected ranges. PURE. When `ignoreFile` is true the
 * caller protects everything and `protectedRanges` is left empty (the whole file
 * is the protected span, signalled by the boolean).
 */
export function scanMarkers(text: string, lang: LangId): MarkerScan {
  if (typeof text !== 'string' || text === '') {
    return { ignoreFile: false, protectedRanges: [] };
  }

  if (detectFileIgnore(text, lang)) {
    return { ignoreFile: true, protectedRanges: [] };
  }

  const syntax = commentSyntaxFor(lang);
  const comments = scanComments(text, syntax);
  if (comments.length === 0) {
    return { ignoreFile: false, protectedRanges: [] };
  }

  const regions = collectRegions(text, comments);
  const nodes = collectNodeMarkers(text, comments);
  const protectedRanges = mergeRanges([...regions, ...nodes]);
  return { ignoreFile: false, protectedRanges };
}
