// In-source ignore markers (Axe 4.T1): a PURE scanner that finds the directives
// a user writes inside the code itself. Three kinds, all expressed as comments
// using the host language's comment syntax:
//
//   (a) FILE ignore   — the first significant comment at the very top contains
//                       "tidy-ignore-file" / "tidy-ignore", OR a leading
//                       "prettier-ignore". The whole document is left verbatim.
//   (b) REGION ignore — a "tidy-ignore-start" comment opens a protected span that
//                       a "tidy-ignore-end" comment closes; the byte range
//                       in-between (markers included) is preserved verbatim.
//   (c) NODE ignore   — a "tidy-ignore" / "prettier-ignore" comment immediately
//                       preceding a node protects that node (best-effort,
//                       conservative line heuristic).
//
// PURE: this module imports neither 'vscode' nor any parser/engine. It works on
// the raw text + the languageId only, so it is exhaustively unit-testable. The
// caller (the provider, behind the safety guard) is responsible for splicing the
// protected ranges back VERBATIM so the final output stays equivalent to the
// input — meaning the guard always accepts and the file can never be corrupted.
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

/** Which comment delimiters a language uses, for region/node detection. */
interface CommentSyntax {
  /** Line-comment opener, e.g. "//" — undefined when the language has none. */
  readonly line?: string;
  /** Block-comment delimiters, e.g. ["/*", "*\/"] or ["<!--", "-->"]. */
  readonly block?: readonly [string, string];
}

/**
 * Comment syntax per language family. CSS has no line comments (only block);
 * HTML uses SGML comments; the JS family and JSON-with-comments use // and /* *\/.
 * Plain JSON technically has no comments, but Tidy treats JSONC-style comments
 * leniently here (the guard remains the source of truth on validity).
 */
function commentSyntaxFor(lang: LangId): CommentSyntax {
  switch (lang) {
    case 'html':
      return { block: ['<!--', '-->'] };
    case 'css':
    case 'scss':
    case 'less':
      // SCSS/LESS also allow //, but block comments are universal across CSS.
      return { line: lang === 'css' ? undefined : '//', block: ['/*', '*/'] };
    case 'json':
    case 'jsonc':
    case 'javascript':
    case 'javascriptreact':
    case 'typescript':
    case 'typescriptreact':
    default:
      return { line: '//', block: ['/*', '*/'] };
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
 * Enumerate every comment in the document, in order. A best-effort lexical scan:
 * it understands the language's line/block delimiters and skips over string
 * literals so a "// ..." inside a JS string is not mistaken for a comment.
 * Conservative by design — it never claims a comment it is unsure about, so a
 * marker in odd contexts simply protects nothing (never over-deletes).
 */
function scanComments(text: string, syntax: CommentSyntax): CommentHit[] {
  const hits: CommentHit[] = [];
  const len = text.length;
  let lineStart = 0;
  let i = 0;

  const blockOpen = syntax.block?.[0];
  const blockClose = syntax.block?.[1];
  const lineOpen = syntax.line;

  while (i < len) {
    const ch = text[i];

    if (ch === '\n') {
      lineStart = i + 1;
      i += 1;
      continue;
    }

    // Skip string / template literals in JS-family + JSON so their contents are
    // never mis-scanned as comments. CSS/HTML use only " and ' (handled too).
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipString(text, i, ch);
      continue;
    }

    if (blockOpen && text.startsWith(blockOpen, i)) {
      const closeAt = text.indexOf(blockClose as string, i + blockOpen.length);
      const end = closeAt === -1 ? len : closeAt + (blockClose as string).length;
      const body = text.slice(i + blockOpen.length, closeAt === -1 ? len : closeAt);
      hits.push({ start: i, end, body, lineStart });
      // Advance line tracking across any newlines inside the block comment.
      for (let k = i; k < end; k += 1) {
        if (text[k] === '\n') {
          lineStart = k + 1;
        }
      }
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

    i += 1;
  }

  return hits;
}

/**
 * Advance past a string/template literal starting at `open` (the opening quote).
 * Honours backslash escapes; an unterminated string consumes to end-of-text so
 * the scanner stays conservative (treats the remainder as a string, not code).
 */
function skipString(text: string, open: number, quote: string): number {
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
    i += 1;
  }
  return text.length;
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
 * protects to end-of-file (conservative — protect MORE, never less). The whole
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
 * NEXT non-blank line. The downstream guard makes this safe — if the coarse span
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
