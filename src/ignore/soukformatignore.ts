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
// UNBOUNDED WALK, like git: the upward search goes from the file's folder to the
// root of the disk and the nearest .soukformatignore wins. Reading an exclusion
// file can only make Tidy format LESS, so a file above the opened folder is safe
// to read; Workspace Trust, the opt-out setting and the size cap still apply.
//
// CASE: each line is compiled twice, case-sensitive and case-insensitive, and the
// two verdicts are merged on the safe side (see ./glob, evaluatePatterns): what git
// excludes under either core.ignorecase value is excluded here, on every OS.
//
// FAIL CLOSED, AND SAY WHY: a line that ./glob cannot evaluate (over its length
// cap, or ending in a lone backslash) and an ignore file over
// MAX_SOUKFORMATIGNORE_BYTES both exclude every file the ignore file governs. A
// user's exclusions are never silently dropped. The lookup carries the reason
// (`failClosed`: which line, and why) so "Show Effective Configuration" and the
// output channel can tell the user, instead of leaving them with a bare "ignored
// by .soukformatignore" on every file.
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
// One stat per level hands the file's identity on to the memo below; the rule that
// says when an unchanged identity can be trusted is the one .soukformatrc uses.
import {
  canProveFreshness,
  sameIdentity,
  statFileIdentity,
  type FileIdentity
} from '../config/fileIdentity';
import {
  compileIgnorePattern,
  describeBudgetExceeded,
  describeUnevaluable,
  evaluatePatterns,
  withFoldedTwin,
  type IgnorePattern
} from './glob';

/** The on-disk filename Tidy looks for, walking from a file up to the root of the disk. */
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

function parseLines(text: string): { patterns: IgnorePattern[]; lines: number[] } {
  const patterns: IgnorePattern[] = [];
  const lines: number[] = [];
  if (typeof text !== 'string' || text === '') {
    return { patterns, lines };
  }

  // Windows editors routinely save UTF-8 with a BOM. Like git, drop it: left in,
  // it becomes the first character of the first pattern, which then matches nothing.
  const body = text.startsWith(BYTE_ORDER_MARK) ? text.slice(BYTE_ORDER_MARK.length) : text;
  // Like git: split on "\n" only, then drop ONE final "\r" (CRLF). A lone "\r" is
  // an ordinary character of the pattern, not a line break.
  const rawLines = body.split('\n');
  for (let index = 0; index < rawLines.length; index += 1) {
    const withCr = rawLines[index];
    const rawLine = withCr.endsWith('\r') ? withCr.slice(0, -1) : withCr;

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

    const exact = compileIgnorePattern(line, { ignoreCase: false });
    const folded = compileIgnorePattern(line, { ignoreCase: true });
    if (exact !== undefined && folded !== undefined) {
      patterns.push(withFoldedTwin(exact, folded));
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
 *   - lines end at "\n" (the "\r" of CRLF is dropped); a lone "\r" is part of the pattern,
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
export function parseIgnorePatterns(text: string): IgnorePattern[] {
  return parseLines(text).patterns;
}

/**
 * Like {@link parseIgnorePatterns}, and also records the 1-based source line of
 * each pattern so a report can name the line that could not be evaluated. PURE.
 */
export function parseIgnoreFile(text: string): ParsedIgnoreFile {
  return parseLines(text);
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
  return evaluatePatterns(patterns, toPosixRelative(relPath));
}

/**
 * Whether `relPath` is ignored by the ordered patterns (see {@link decideIgnore}
 * for the precedence rules). PURE: no I/O.
 */
export function isIgnoredFile(relPath: string, patterns: readonly IgnorePattern[]): boolean {
  return decideIgnore(relPath, patterns).ignored;
}

/**
 * Normalise a relative path to POSIX, dropping "." and empty segments. On
 * Windows "\" is a separator too; elsewhere it is an ordinary file-name
 * character, as git treats it, so it stays inside its segment.
 */
export function toPosixRelative(p: string, platform: string = process.platform): string {
  const separators = platform === 'win32' ? /[\\/]/ : /\//;
  return p.split(separators).filter((seg) => seg !== '' && seg !== '.').join('/');
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
export function evaluateIgnore(text: string, relPath: string): IgnoreEvaluation {
  return evaluateParsed(parseLines(text), relPath);
}

/** {@link evaluateIgnore} on an already parsed file (the memoised patterns, never a verdict). */
function evaluateParsed(parsed: ParsedIgnoreFile, relPath: string): IgnoreEvaluation {
  const { patterns, lines } = parsed;
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
interface LocatedIgnoreFile extends FileIdentity {
  readonly path: string;
}

/**
 * Walk up from a file's directory to the nearest .soukformatignore and return it
 * with the identity the stat that found it reported: one stat per level, and the
 * identity feeds the cap and the memo without a second syscall. Goes up to the
 * root of the disk, like git (see the header). The walk is lexical (no symlink is
 * followed), so it always ends at the root; a stat error (permission, not a
 * directory) is fail-soft and the walk keeps going.
 */
function locateSoukformatignore(startFsPath: string): LocatedIgnoreFile | undefined {
  if (typeof startFsPath !== 'string' || startFsPath.trim() === '') {
    return undefined;
  }

  let dir = dirname(resolve(startFsPath));
  for (;;) {
    const candidate = join(dir, SOUKFORMATIGNORE_FILENAME);
    // A stat error is swallowed by statFileIdentity: fail-soft, keep walking up.
    const found = statFileIdentity(candidate);
    if (found !== undefined) {
      return { path: candidate, ...found };
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

/**
 * Walk up from a file's directory to the nearest .soukformatignore, up to the
 * root of the disk. Returns its absolute path, or undefined if none exists.
 * The walk is lexical, so it always ends. Uses only node:fs (no workspace APIs).
 */
export function findSoukformatignore(startFsPath: string): string | undefined {
  return locateSoukformatignore(startFsPath)?.path;
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

/**
 * Starts every fail-closed detail the .soukformatrc reader builds (its overrides
 * could not be fully evaluated). It is recorded like a .soukformatignore one, so
 * the status surfaces tell it from a file path with the same test.
 */
export const SOUKFORMATRC_FAIL_CLOSED_DETAIL_PREFIX = '.soukformatrc ';

/** Whether a recorded detail is a .soukformatrc fail-closed reason (see SoukReadResult.failClosed). */
export function isSoukformatrcFailClosedDetail(detail: string | undefined): boolean {
  return detail !== undefined && detail.startsWith(SOUKFORMATRC_FAIL_CLOSED_DETAIL_PREFIX);
}

/**
 * Whether a recorded ignore detail is a fail-closed reason (true) or a file path
 * (false). A .soukformatrc whose overrides could not be fully evaluated is
 * recorded the same way.
 */
export function isFailClosedDetail(detail: string | undefined): boolean {
  return (
    (detail !== undefined && detail.startsWith(FAIL_CLOSED_DETAIL_PREFIX)) ||
    isSoukformatrcFailClosedDetail(detail)
  );
}

/** Most parsed ignore files kept in memory at once (one per distinct file path). */
const MAX_CACHED_IGNORE_FILES = 32;

/**
 * Most SOURCE bytes kept parsed at once, summed over the entries. Parsed patterns
 * weigh tens of times their source, so this, not the file count, bounds memory:
 * one ignore file at its 1 MiB cap still fits, thirty-two of them do not.
 */
const MAX_CACHED_IGNORE_BYTES = MAX_SOUKFORMATIGNORE_BYTES;

/** Sum of the source sizes of the cached entries. */
function cachedIgnoreBytes(): number {
  let total = 0;
  for (const entry of ignoreCache.values()) {
    total += entry.identity.size;
  }
  return total;
}

/** A parsed ignore file kept in memory, valid while its identity is unchanged. */
interface CachedIgnoreFile {
  readonly identity: FileIdentity;
  readonly parsed: ParsedIgnoreFile;
}

/** Insertion-ordered, so the oldest entry is the first key (evicted first). */
const ignoreCache = new Map<string, CachedIgnoreFile>();

/** Forget every memoised ignore file. Tests use it; a normal session never needs it. */
export function clearSoukformatignoreCache(): void {
  ignoreCache.clear();
}

/** The clock the freshness window reads. */
let clock: () => number = Date.now;

/**
 * Replace the clock the freshness window reads (a test moves it forward to make a
 * file "settled" without waiting); call with no argument to restore the real one.
 */
export function setSoukformatignoreClock(now?: () => number): void {
  clock = now ?? Date.now;
}

/**
 * The parsed patterns of a located ignore file: from the memo when its identity is
 * exactly the one memoised, otherwise read and parsed once. Only the patterns are
 * kept, never a verdict. Same rule as .soukformatrc (see ../config/fileIdentity): a
 * file whose freshness cannot be proved (coarse timestamps, no inode, touched less
 * than 2 s ago) is never memoised, so it is read every time. Returns undefined
 * when the file cannot be read.
 */
function loadParsedIgnore(located: LocatedIgnoreFile): ParsedIgnoreFile | undefined {
  const cached = ignoreCache.get(located.path);
  if (cached !== undefined && sameIdentity(cached.identity, located)) {
    return cached.parsed;
  }

  let text: string;
  try {
    text = readFileSync(located.path, 'utf8');
  } catch {
    ignoreCache.delete(located.path);
    return undefined;
  }

  const parsed = parseLines(text);
  ignoreCache.delete(located.path);
  if (canProveFreshness(located, clock())) {
    // Evict the oldest entries until both the count and the byte bound hold.
    while (
      ignoreCache.size >= MAX_CACHED_IGNORE_FILES ||
      (ignoreCache.size > 0 && cachedIgnoreBytes() + located.size > MAX_CACHED_IGNORE_BYTES)
    ) {
      const oldest = ignoreCache.keys().next();
      if (oldest.done === true) {
        break;
      }
      ignoreCache.delete(oldest.value);
    }
    const { size, mtimeNs, ctimeNs, ino, dev } = located;
    ignoreCache.set(located.path, { identity: { size, mtimeNs, ctimeNs, ino, dev }, parsed });
  }
  return parsed;
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
 * The lookup goes up to the root of the disk (see locateSoukformatignore).
 * This is the single impure seam; the matching itself is the pure evaluateIgnore.
 */
export function resolveIgnore(fsPath: string): IgnoreLookup {
  const located = locateSoukformatignore(fsPath);
  if (located === undefined) {
    return { ignored: false };
  }

  // The cap uses the size the walk's own stat reported: no extra syscall, and an
  // oversized file is never read.
  if (located.size > MAX_SOUKFORMATIGNORE_BYTES) {
    return { path: located.path, ignored: true, failClosed: failClosedForSize(located.size) };
  }

  const parsed = loadParsedIgnore(located);
  if (parsed === undefined) {
    // Unreadable ignore file => fail-safe: format anyway.
    return { path: located.path, ignored: false };
  }

  const ignoreDir = dirname(located.path);
  const rel = relative(ignoreDir, fsPath).split(sep).join('/');
  return { path: located.path, ...evaluateParsed(parsed, rel) };
}
