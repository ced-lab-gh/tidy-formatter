// .soukformatignore reader (Axe 4.T3): a project-level file, in .gitignore
// syntax, listing paths Tidy must NOT reformat. When a document's path matches
// the (last winning) pattern the provider returns no edits and the file is left
// byte-identical — never a corruption risk, simply "do nothing here".
//
// PURE matcher: the pattern parsing and `isIgnoredFile` matcher import neither
// 'vscode' nor 'node:fs' and operate on already-normalised POSIX relative paths,
// so they are fully unit-testable. (The thin on-disk discovery helper below uses
// only node:fs — no workspace APIs — and is the one impure seam, kept tiny.)
//
// Glob handling reuses/extends the minimal dependency-free matcher in ./glob
// (which itself extends config/soukformatrc.ts's `globToRegExp`); NO new npm
// dependency is added this pass.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { compileIgnorePattern, patternMatches, type IgnorePattern } from './glob';

/** The on-disk filename Tidy looks for, walking from a file up to the FS root. */
export const SOUKFORMATIGNORE_FILENAME = '.soukformatignore';

/** Origin label surfaced verbatim in "Show Effective Configuration". */
export const SOURCE_SOUKFORMATIGNORE = '.soukformatignore';

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
 * file an earlier "*.css" excluded — and vice-versa), matching git's semantics.
 */
export function parseIgnorePatterns(text: string): IgnorePattern[] {
  if (typeof text !== 'string' || text === '') {
    return [];
  }

  const patterns: IgnorePattern[] = [];
  for (const rawLine of text.split(/\r\n|\n|\r/)) {
    const line = stripTrailingUnescapedSpaces(rawLine);

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
    }
  }
  return patterns;
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

/**
 * Decide whether `relPath` (a relative path; POSIX or OS-native separators are
 * both accepted and normalised to "/") is ignored by the ordered patterns.
 *
 * gitignore precedence: the LAST matching pattern wins. A path is ignored when
 * the last pattern that matches it is a normal (non-negated) pattern; a trailing
 * "!negation" can re-include it. With no matching pattern, the path is NOT
 * ignored (so formatting proceeds — the safe default). PURE: no I/O.
 */
export function isIgnoredFile(relPath: string, patterns: readonly IgnorePattern[]): boolean {
  if (typeof relPath !== 'string' || relPath === '' || patterns.length === 0) {
    return false;
  }
  const posixPath = toPosix(relPath);

  let ignored = false;
  for (const pattern of patterns) {
    if (patternMatches(pattern, posixPath)) {
      // A later match overrides an earlier one (last-wins).
      ignored = !pattern.negated;
    }
  }
  return ignored;
}

/** Normalise OS-native separators and a leading "./" to a clean POSIX path. */
function toPosix(p: string): string {
  return p.split(/[\\/]/).filter((seg) => seg !== '' && seg !== '.').join('/');
}

/**
 * Walk up from a file's directory to the nearest .soukformatignore.
 * Returns its absolute path, or undefined if none exists up to the FS root.
 * Bounded against symlink loops. Uses only node:fs (no workspace APIs).
 */
export function findSoukformatignore(startFsPath: string): string | undefined {
  if (typeof startFsPath !== 'string' || startFsPath.trim() === '') {
    return undefined;
  }
  let dir = dirname(startFsPath);
  for (let depth = 0; depth < 64; depth += 1) {
    const candidate = join(dir, SOUKFORMATIGNORE_FILENAME);
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        return candidate;
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

/** The outcome of resolving the nearest .soukformatignore for a file. */
export interface IgnoreLookup {
  /** Absolute path of the .soukformatignore consulted, or undefined if none. */
  readonly path?: string;
  /** True when the formatted file is excluded by that ignore file. */
  readonly ignored: boolean;
}

/**
 * Resolve whether an on-disk file is excluded by the nearest .soukformatignore.
 * Never throws: any I/O failure is fail-SAFE here — we treat an unreadable
 * ignore file as "no ignore" so formatting still proceeds (CFG-06 / Axe 4.T3:
 * "lecture echoue -> fail-safe (on formate)").
 *
 * `fsPath` MUST be a real absolute filesystem path (e.g. document.uri.fsPath).
 * This is the single impure seam; the matching itself is the pure isIgnoredFile.
 */
export function resolveIgnore(fsPath: string): IgnoreLookup {
  const ignorePath = findSoukformatignore(fsPath);
  if (ignorePath === undefined) {
    return { ignored: false };
  }

  let text: string;
  try {
    text = readFileSync(ignorePath, 'utf8');
  } catch {
    // Unreadable ignore file => fail-safe: format anyway.
    return { path: ignorePath, ignored: false };
  }

  const patterns = parseIgnorePatterns(text);
  const ignoreDir = dirname(ignorePath);
  const rel = relative(ignoreDir, fsPath).split(sep).join('/');
  return { path: ignorePath, ignored: isIgnoredFile(rel, patterns) };
}
