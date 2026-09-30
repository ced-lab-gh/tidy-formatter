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
// FAIL CLOSED, AND SAY WHY: a line that ./glob cannot evaluate (over its length
// cap, or ending in a lone backslash) and an ignore file over
// MAX_SOUKFORMATIGNORE_BYTES both exclude every file the ignore file governs. A
// user's exclusions are never silently dropped. The lookup carries the reason
// (`failClosed`: which line, and why) so "Show Effective Configuration" and the
// output channel can tell the user, instead of leaving them with a bare "ignored
// by .soukformatignore" on every file.
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import {
  compileIgnorePattern,
  describeUnevaluable,
  patternMatches,
  type IgnorePattern
} from './glob';

/** The on-disk filename Tidy looks for, walking from a file up to the FS root. */
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

function parseLines(text: string): { patterns: IgnorePattern[]; lines: number[] } {
  const patterns: IgnorePattern[] = [];
  const lines: number[] = [];
  if (typeof text !== 'string' || text === '') {
    return { patterns, lines };
  }

  const rawLines = text.split(/\r\n|\n|\r/);
  for (let index = 0; index < rawLines.length; index += 1) {
    const line = stripTrailingUnescapedSpaces(rawLines[index]);

    // Blank line: nothing to compile.
    if (line === '') {
      continue;
    }
    // A comment line (first char "#", unless escaped as "\#").
    if (line.startsWith('#')) {
      continue;
    }

    const pattern = compileIgnorePattern(line);
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
 * Recognised syntax (gitignore subset):
 *   - blank lines and lines whose first non-escaped char is "#" are comments,
 *   - a leading "!" re-includes a path excluded by an earlier pattern,
 *   - a leading "/" anchors to the ignore file's directory,
 *   - a trailing "/" matches directories (and everything beneath them),
 *   - "*", "?", and "**" wildcards (see ./glob),
 *   - trailing spaces are trimmed unless escaped with "\ ".
 *
 * Order is preserved: later patterns win (a later "!keep.css" can re-include a
 * file an earlier "*.css" excluded : and vice-versa), matching git's semantics.
 * A line that cannot be evaluated is kept (see ./glob, FAIL CLOSED), never
 * dropped.
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
 * Trim a line's leading whitespace-free of intent and its trailing spaces
 * (gitignore ignores trailing spaces unless the last one is escaped "\ ").
 * Leading whitespace is significant only in that gitignore does not special-case
 * it; we keep the body as authored after a single leading trim of surrounding
 * blanks, matching common tooling behaviour.
 */
function stripTrailingUnescapedSpaces(rawLine: string): string {
  let line = rawLine;
  // Drop a trailing carriage return survivor and ordinary trailing spaces, but
  // honour an escaped trailing space ("foo\ " keeps one space).
  let end = line.length;
  while (end > 0 && (line[end - 1] === ' ' || line[end - 1] === '\t')) {
    // Count preceding backslashes; an odd count escapes this space => keep it.
    let backslashes = 0;
    let j = end - 2;
    while (j >= 0 && line[j] === '\\') {
      backslashes += 1;
      j -= 1;
    }
    if (backslashes % 2 === 1) {
      break;
    }
    end -= 1;
  }
  line = line.slice(0, end);
  // Unescape a single escaped trailing space ("foo\ " => "foo ") now that the
  // unescaped trailing whitespace has been trimmed: the backslash was only there
  // to protect the space, and must not survive into the compiled pattern body.
  if (line.endsWith('\\ ')) {
    line = `${line.slice(0, -2)} `;
  }
  // Strip leading whitespace (not significant in gitignore patterns).
  return line.replace(/^[ \t]+/, '');
}

/** Which pattern settled a path, and whether the path ends up ignored. */
export interface IgnoreDecision {
  readonly ignored: boolean;
  /** Index (into the patterns) of the LAST pattern that matched; undefined when none did. */
  readonly decidedBy?: number;
}

/**
 * Decide whether `relPath` (a relative path; POSIX or OS-native separators are
 * both accepted and normalised to "/") is ignored by the ordered patterns, and
 * which pattern settled it.
 *
 * gitignore precedence: the LAST matching pattern wins. A path is ignored when
 * the last pattern that matches it is a normal (non-negated) pattern; a trailing
 * "!negation" can re-include it. With no matching pattern, the path is NOT
 * ignored (so formatting proceeds : the safe default). PURE: no I/O.
 */
export function decideIgnore(relPath: string, patterns: readonly IgnorePattern[]): IgnoreDecision {
  if (typeof relPath !== 'string' || relPath === '' || patterns.length === 0) {
    return { ignored: false };
  }
  const posixPath = toPosix(relPath);

  let decision: IgnoreDecision = { ignored: false };
  for (let index = 0; index < patterns.length; index += 1) {
    const pattern = patterns[index];
    if (patternMatches(pattern, posixPath)) {
      // A later match overrides an earlier one (last-wins).
      decision = { ignored: !pattern.negated, decidedBy: index };
    }
  }
  return decision;
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

/** The verdict of an ignore file's text for one path, with the fail-closed reason if any. */
export interface IgnoreEvaluation {
  readonly ignored: boolean;
  /** Set only when the path is excluded BECAUSE a line could not be evaluated. */
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
  const { patterns, lines } = parseLines(text);
  const decision = decideIgnore(relPath, patterns);
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
 */
function locateSoukformatignore(startFsPath: string): LocatedIgnoreFile | undefined {
  if (typeof startFsPath !== 'string' || startFsPath.trim() === '') {
    return undefined;
  }
  let dir = dirname(startFsPath);
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
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
  return undefined;
}

/**
 * Walk up from a file's directory to the nearest .soukformatignore.
 * Returns its absolute path, or undefined if none exists up to the FS root.
 * Bounded against symlink loops. Uses only node:fs (no workspace APIs).
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
