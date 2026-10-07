// .soukformatignore reader (Axe 4.T3): a project-level file, in .gitignore
// syntax, listing paths Tidy must NOT reformat. When a document's path matches
// the (last winning) pattern the provider returns no edits and the file is left
// byte-identical : never a corruption risk, simply "do nothing here".
//
// PURE matcher: the pattern parsing and the `isIgnoredFile` / `evaluateIgnore`
// matchers touch neither 'vscode' nor the disk and operate on already-normalised
// POSIX relative paths, so they are fully unit-testable. The on-disk discovery
// helper below uses only node:fs (no workspace APIs) and is the one impure seam,
// kept tiny.
//
// Glob handling is delegated to ./glob: the ONE linear, RegExp-free gitignore
// matcher, shared with the `overrides[].files` globs of .soukformatrc. No npm
// dependency is involved.
//
// BOUNDED WALK: the upward search stops at the workspace folder (stopDir,
// inclusive), like .soukformatrc and .prettierrc. A .soukformatignore ABOVE the
// workspace is a file the user never opened and must not silently change what
// Tidy does. The bound is real path containment, shared with those two walks.
//
// FAIL CLOSED, AND SAY WHY: a line that ./glob cannot evaluate (over its length
// cap, or ending in a lone backslash) and an ignore file over
// MAX_SOUKFORMATIGNORE_BYTES both exclude every file the ignore file governs. A
// user's exclusions are never silently dropped. The lookup carries the reason
// (`failClosed`: which line, and why) so "Show Effective Configuration" and the
// output channel can tell the user, instead of leaving them with a bare "ignored
// by .soukformatignore" on every file.
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
// Path containment, REUSED from the .prettierrc layer (the same helpers the
// .soukformatrc walk uses) rather than reinvented: one implementation of the
// workspace bound means one place where drive-letter case, trailing and mixed
// separators, '..' segments and UNC shares have to be proven right.
import { comparableDir, isWithinDir } from '../config/prettierrc';
import {
  compileIgnorePattern,
  describeBudgetExceeded,
  describeUnevaluable,
  evaluatePatterns,
  type GlobOptions,
  type IgnorePattern
} from './glob';

/** The on-disk filename Tidy looks for, walking from a file up to its workspace folder. */
export const SOUKFORMATIGNORE_FILENAME = '.soukformatignore';

/** Origin label surfaced verbatim in "Show Effective Configuration". */
export const SOURCE_SOUKFORMATIGNORE = '.soukformatignore';

/**
 * Largest .soukformatignore that is read at all (1 MiB, the bound
 * MAX_SOUKFORMATRC_BYTES applies to .soukformatrc). A real ignore file is a few
 * hundred bytes; a larger one is not read and parsed synchronously on the
 * extension host's thread on every format. It FAILS CLOSED instead (see the
 * header), with the reason surfaced.
 */
export const MAX_SOUKFORMATIGNORE_BYTES = 1_048_576;

/** An ignore file parsed line by line: the patterns and where each one came from. */
export interface ParsedIgnoreFile {
  readonly patterns: readonly IgnorePattern[];
  /** 1-based source line of each pattern, index-aligned with `patterns`. */
  readonly lines: readonly number[];
}

/** The UTF-8 byte order mark, as it reads back from a file decoded as UTF-8. */
const BYTE_ORDER_MARK = '\uFEFF';

function parseLines(
  text: string,
  options?: GlobOptions
): { patterns: IgnorePattern[]; lines: number[] } {
  const patterns: IgnorePattern[] = [];
  const lines: number[] = [];
  if (typeof text !== 'string' || text === '') {
    return { patterns, lines };
  }

  // Windows editors routinely save UTF-8 with a BOM. Like git, drop it: left in,
  // it becomes the first character of the first pattern, which then matches nothing.
  const body = text.startsWith(BYTE_ORDER_MARK) ? text.slice(BYTE_ORDER_MARK.length) : text;
  const rawLines = body.split(/\r\n|\n|\r/);
  for (let index = 0; index < rawLines.length; index += 1) {
    const rawLine = rawLines[index];

    // Blank line: nothing to compile.
    if (rawLine === '') {
      continue;
    }
    // A comment line: "#" is the FIRST character of the line (git does not skip
    // leading blanks; "\#" escapes it).
    if (rawLine.startsWith('#')) {
      continue;
    }
    const line = trimTrailingSpaces(rawLine);
    if (line === '') {
      continue;
    }

    const pattern = compileIgnorePattern(line, options);
    if (pattern !== undefined) {
      patterns.push(pattern);
      lines.push(index + 1);
    }
  }
  return { patterns, lines };
}

/**
 * Parse the raw text of a .soukformatignore (gitignore syntax) into an ordered
 * list of compiled patterns. PURE: no I/O.
 *
 * Follows git's own syntax:
 *   - a leading UTF-8 byte order mark is dropped,
 *   - blank lines and lines whose FIRST character is "#" are comments (leading
 *     blanks are not skipped: "  #x" is a pattern; "\#x" escapes the "#"),
 *   - a leading "!" re-includes a path excluded by an earlier pattern,
 *   - a leading "/" anchors to the ignore file's directory,
 *   - a trailing "/" matches directories (and everything beneath them),
 *   - "*", "?", "[...]" classes and "**" wildcards (see ./glob),
 *   - trailing SPACES (not tabs) are trimmed unless escaped with "\ "; leading
 *     blanks are part of the pattern.
 *
 * Order is preserved: later patterns win (a later "!keep.css" can re-include a
 * file an earlier "*.css" excluded : and vice-versa), matching git's semantics,
 * including "a file under an excluded directory cannot be re-included" (see
 * ./glob, evaluatePatterns). A line that cannot be evaluated is kept (see ./glob,
 * FAIL CLOSED), never dropped.
 */
export function parseIgnorePatterns(text: string, options?: GlobOptions): IgnorePattern[] {
  return parseLines(text, options).patterns;
}

/**
 * Like {@link parseIgnorePatterns}, and also records the 1-based source line of
 * each pattern so a report can name the line that could not be evaluated. PURE.
 */
export function parseIgnoreFile(text: string, options?: GlobOptions): ParsedIgnoreFile {
  return parseLines(text, options);
}

/**
 * Trim trailing spaces exactly as git's trim_trailing_spaces does: only the
 * space character (not a tab), and a backslash protects the character after it
 * ("foo\ " keeps its space, which ./glob then reads as a literal space). A line
 * that ends in a lone backslash is returned unchanged. Leading blanks are NOT
 * touched: they are part of the pattern.
 */
function trimTrailingSpaces(line: string): string {
  if (!line.includes(' ')) {
    return line; // nothing to trim: the common case, answered natively.
  }
  let lastSpace = -1;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === ' ') {
      if (lastSpace < 0) {
        lastSpace = i;
      }
    } else if (ch === '\\') {
      i += 1;
      if (i >= line.length) {
        return line;
      }
      lastSpace = -1;
    } else {
      lastSpace = -1;
    }
  }
  return lastSpace < 0 ? line : line.slice(0, lastSpace);
}

/** Which pattern settled a path, and whether the path ends up ignored. */
export interface IgnoreDecision {
  readonly ignored: boolean;
  /** Index (into the patterns) of the LAST pattern that matched; undefined when none did. */
  readonly decidedBy?: number;
  /**
   * True when the path is excluded only because matching it ran out of its work
   * budget (fail closed), not because of a rule the user wrote.
   */
  readonly budgetExceeded?: boolean;
}

/**
 * Decide whether `relPath` (a relative path; POSIX or OS-native separators are
 * both accepted and normalised to "/") is ignored by the ordered patterns, and
 * which pattern settled it.
 *
 * git's precedence (see ./glob, evaluatePatterns): each parent directory is
 * judged first by the LAST pattern that matches it, and a parent excluded that way
 * is final (a later "!negation" cannot re-include a file beneath it); then the
 * path itself: ignored when the last pattern that matches it is not a negation.
 * With no matching pattern, the path is NOT ignored (so formatting proceeds : the
 * safe default). The whole lookup is bounded by one work budget; when it runs out
 * the path is excluded (fail closed) and `budgetExceeded` is set. PURE: no I/O.
 */
export function decideIgnore(relPath: string, patterns: readonly IgnorePattern[]): IgnoreDecision {
  if (typeof relPath !== 'string' || relPath === '' || patterns.length === 0) {
    return { ignored: false };
  }
  return evaluatePatterns(patterns, toPosix(relPath));
}

/**
 * Whether `relPath` is ignored by the ordered patterns (see {@link decideIgnore}
 * for the precedence rules). PURE: no I/O.
 */
export function isIgnoredFile(relPath: string, patterns: readonly IgnorePattern[]): boolean {
  return decideIgnore(relPath, patterns).ignored;
}

/** Normalise OS-native separators and a leading "./" to a clean POSIX path. */
function toPosix(p: string): string {
  return p.split(/[\\/]/).filter((seg) => seg !== '' && seg !== '.').join('/');
}

/**
 * Why a file is excluded although Tidy could not evaluate the ignore file (or one
 * of its lines): the fail-closed reason, worded for the two places that report it.
 */
export interface IgnoreFailClosed {
  /** 1-based line that could not be evaluated; absent when the WHOLE file was refused (too large). */
  readonly line?: number;
  /**
   * The full sentence for "Show Effective Configuration": names the line and the
   * (bounded) pattern, the reason, and the consequence. One line, no newline.
   */
  readonly explanation: string;
  /**
   * The short form for the output channel and the last-format record: names the
   * line (not the pattern), the reason and the consequence. One line, well under
   * the 200 characters sanitizeDetail keeps, always starting with
   * `.soukformatignore ` (see {@link isFailClosedDetail}), and with no final full
   * stop so a caller can append its own punctuation.
   */
  readonly detail: string;
}

/** Every detail built by this module starts with this, so it can be told from a path. */
const FAIL_CLOSED_DETAIL_PREFIX = `${SOURCE_SOUKFORMATIGNORE} `;

/** What the exclusion covers, for the sentence that names the consequence. */
const GOVERNED_SCOPE = "every file under this ignore file's folder is excluded";

/** The fail-closed reason for one line ./glob could not evaluate; undefined for a normal line. */
function failClosedForPattern(pattern: IgnorePattern, line: number): IgnoreFailClosed | undefined {
  const reason = pattern.unevaluable;
  if (reason === undefined) {
    return undefined;
  }
  const sentence = describeUnevaluable(
    pattern,
    `${GOVERNED_SCOPE} until the line is fixed or removed`
  );
  return {
    line,
    explanation: `line ${line}: ${sentence ?? `it cannot be evaluated (${reason}).`}`,
    detail:
      `${FAIL_CLOSED_DETAIL_PREFIX}line ${line} cannot be evaluated (${reason}); ` +
      'every file it governs is excluded'
  };
}

/** The fail-closed reason for an ignore file over {@link MAX_SOUKFORMATIGNORE_BYTES}. */
function failClosedForSize(size: number): IgnoreFailClosed {
  const tooLarge = `is too large to read (${size} bytes; the limit is ${MAX_SOUKFORMATIGNORE_BYTES})`;
  return {
    explanation:
      `the file ${tooLarge}; ${GOVERNED_SCOPE} until it is shortened or removed.`,
    detail: `${FAIL_CLOSED_DETAIL_PREFIX}${tooLarge}; every file it governs is excluded`
  };
}

/** The fail-closed reason for a path whose matching ran out of its work budget. */
function failClosedForBudget(patternCount: number): IgnoreFailClosed {
  const sentence = describeBudgetExceeded(
    patternCount,
    `${GOVERNED_SCOPE} until the file is shortened`
  );
  return {
    explanation: `the file has too much to match: ${sentence}`,
    detail:
      `${FAIL_CLOSED_DETAIL_PREFIX}has too many patterns to match this path within its work ` +
      'budget; every file it governs is excluded'
  };
}

/** The verdict of an ignore file's text for one path, with the fail-closed reason if any. */
export interface IgnoreEvaluation {
  readonly ignored: boolean;
  /**
   * Set only when the path is excluded BECAUSE a line could not be evaluated, or
   * because matching it ran out of its work budget.
   */
  readonly failClosed?: IgnoreFailClosed;
}

/**
 * Evaluate the text of a .soukformatignore for one relative path. PURE: no I/O.
 *
 * `failClosed` is set exactly when the pattern that settled the path is one that
 * could not be evaluated (it excluded the path only because it fails closed). A
 * later, evaluable "!negation" that matches still re-includes the path, as it
 * would after any other pattern; an unevaluable negation never re-includes.
 */
export function evaluateIgnore(
  text: string,
  relPath: string,
  options?: GlobOptions
): IgnoreEvaluation {
  const { patterns, lines } = parseLines(text, options);
  const decision = decideIgnore(relPath, patterns);
  if (decision.budgetExceeded === true) {
    return { ignored: true, failClosed: failClosedForBudget(patterns.length) };
  }
  if (!decision.ignored || decision.decidedBy === undefined) {
    return { ignored: decision.ignored };
  }
  const failClosed = failClosedForPattern(patterns[decision.decidedBy], lines[decision.decidedBy]);
  return failClosed === undefined ? { ignored: true } : { ignored: true, failClosed };
}

/** A .soukformatignore found by the walk, with the stat that found it. */
interface LocatedIgnoreFile {
  readonly path: string;
  readonly size: number;
}

/**
 * Walk up from a file's directory to the nearest .soukformatignore and return it
 * with the size the stat that found it reported: one stat per level, and the
 * size feeds the cap without a second syscall. Bounded to 64 levels (a stop
 * against a symlink loop or a pathological path); a stat error (permission, not
 * a directory) is fail-soft and the walk keeps going.
 *
 * WORKSPACE BOUND. With `stopDir` (the workspace folder) the walk NEVER leaves
 * it, exactly like the .soukformatrc and .prettierrc walks, and with the same
 * three fail-closed checks of the shared isWithinDir containment: the starting
 * directory must lie inside `stopDir` (else nothing is searched at all, not even
 * one stat); the walk stops after searching `stopDir` itself (inclusive); and
 * every step upward must stay inside it. An ignore file ABOVE the workspace is a
 * file the user never opened, and letting it decide what Tidy skips would change
 * their formatting on the strength of content they never chose to trust.
 * A `stopDir` that is not a usable path (empty, blank) is "no trusted boundary":
 * nothing is searched. Only an OMITTED `stopDir` leaves the walk unbounded
 * (filesystem root), which production callers must not rely on: the VS Code gate
 * passes the workspace folder of the document.
 */
function locateSoukformatignore(
  startFsPath: string,
  stopDir?: string
): LocatedIgnoreFile | undefined {
  if (typeof startFsPath !== 'string' || startFsPath.trim() === '') {
    return undefined;
  }
  if (stopDir !== undefined && (typeof stopDir !== 'string' || stopDir.trim() === '')) {
    return undefined; // no trusted boundary to walk within.
  }

  let dir = dirname(resolve(startFsPath));
  if (stopDir !== undefined && !isWithinDir(dir, stopDir)) {
    return undefined; // the document is not inside the workspace folder.
  }
  for (let depth = 0; depth < 64; depth += 1) {
    const candidate = join(dir, SOUKFORMATIGNORE_FILENAME);
    try {
      const stats = statSync(candidate, { throwIfNoEntry: false });
      if (stats?.isFile() === true) {
        return { path: candidate, size: stats.size };
      }
    } catch {
      // Ignore stat/permission errors and keep walking up (fail-soft). The empty
      // block is intentional; ESLint's no-empty requires a statement here.
      void 0;
    }
    if (stopDir !== undefined && comparableDir(dir) === comparableDir(stopDir)) {
      return undefined; // workspace folder reached (and searched): stop.
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    if (stopDir !== undefined && !isWithinDir(parent, stopDir)) {
      return undefined; // one step further would leave the workspace folder.
    }
    dir = parent;
  }
  return undefined;
}

/**
 * Walk up from a file's directory to the nearest .soukformatignore, never past
 * `stopDir` (the workspace folder, inclusive; see locateSoukformatignore).
 * Returns its absolute path, or undefined if none exists inside the bound.
 * Bounded against symlink loops. Uses only node:fs (no workspace APIs).
 */
export function findSoukformatignore(startFsPath: string, stopDir?: string): string | undefined {
  return locateSoukformatignore(startFsPath, stopDir)?.path;
}

/** The outcome of resolving the nearest .soukformatignore for a file. */
export interface IgnoreLookup {
  /** Absolute path of the .soukformatignore consulted, or undefined if none. */
  readonly path?: string;
  /** True when the formatted file is excluded by that ignore file. */
  readonly ignored: boolean;
  /**
   * Set only when `ignored` is true BECAUSE the ignore file (or one of its
   * lines) could not be evaluated: the file was excluded by failing closed, not
   * by a rule the user wrote. Which line, and why.
   */
  readonly failClosed?: IgnoreFailClosed;
}

/**
 * The text to record as the detail of an "ignored by .soukformatignore" format
 * attempt, so the output channel line and "Explain Last Format" carry it through
 * the existing one-line, bounded detail mechanism (sanitizeDetail).
 *
 * A normal exclusion records the ignore file's path (which the "Open
 * .soukformatignore" action opens). A fail-closed exclusion records the reason
 * instead: a path would use most of the 200 characters the record keeps, and the
 * reason is what the user is missing. {@link isFailClosedDetail} tells the two
 * apart, so nothing tries to open a reason as if it were a path.
 */
export function ignoreRecordDetail(lookup: IgnoreLookup): string | undefined {
  return lookup.failClosed?.detail ?? lookup.path;
}

/** Whether a recorded ignore detail is a fail-closed reason (true) or a file path (false). */
export function isFailClosedDetail(detail: string | undefined): boolean {
  return detail !== undefined && detail.startsWith(FAIL_CLOSED_DETAIL_PREFIX);
}

/**
 * Resolve whether an on-disk file is excluded by the nearest .soukformatignore.
 * Never throws: any I/O failure is fail-SAFE here : we treat an unreadable
 * ignore file as "no ignore" so formatting still proceeds (CFG-06 / Axe 4.T3:
 * "lecture echoue -> fail-safe (on formate)"). The one exception is an ignore
 * file that IS there but too large to read: it fails CLOSED (every file it
 * governs is excluded), with the reason in `failClosed`, because dropping a
 * user's exclusions without a word is the worse mistake.
 *
 * `fsPath` MUST be a real absolute filesystem path (e.g. document.uri.fsPath).
 * `stopDir` is the document's workspace folder (its fsPath): the lookup never
 * goes above it, so an ignore file outside the workspace does not apply (see
 * locateSoukformatignore). A caller that omits it gets the unbounded walk.
 * This is the single impure seam; the matching itself is the pure evaluateIgnore.
 */
export function resolveIgnore(fsPath: string, stopDir?: string): IgnoreLookup {
  const located = locateSoukformatignore(fsPath, stopDir);
  if (located === undefined) {
    return { ignored: false };
  }

  // The cap uses the size the walk's own stat reported: no extra syscall, and an
  // oversized file is never read.
  if (located.size > MAX_SOUKFORMATIGNORE_BYTES) {
    return { path: located.path, ignored: true, failClosed: failClosedForSize(located.size) };
  }

  let text: string;
  try {
    text = readFileSync(located.path, 'utf8');
  } catch {
    // Unreadable ignore file => fail-safe: format anyway.
    return { path: located.path, ignored: false };
  }

  const ignoreDir = dirname(located.path);
  const rel = relative(ignoreDir, fsPath).split(sep).join('/');
  return { path: located.path, ...evaluateIgnore(text, rel) };
}
