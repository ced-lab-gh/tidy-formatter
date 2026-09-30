// Pure, dependency-free gitignore-style glob matcher, LINEAR in its input.
//
// ONE implementation serves both consumers: the .soukformatignore matcher
// (compileIgnorePattern) and the `overrides[].files` globs of .soukformatrc
// (compileFilesGlob, used by config/soukformatrc.ts). Both used to translate a
// glob into a RegExp character by character and test it synchronously: a run of
// `*` compiled to `[^/]*[^/]*...` and a run of `**\/` to `(?:.*\/)?...`, which
// backtrack exponentially. A 31-character pattern in a versioned file froze the
// whole extension host for over 50 seconds. There is no RegExp here at all:
//
//   - a path segment is matched with the classic greedy two-pointer wildcard
//     algorithm (one remembered star, never a stack of them), O(pattern x text)
//     and never exponential;
//   - `**` segments are matched by a reachable-position sweep over the path
//     segments (a bitmap of "how many segments are consumed so far"), O(pattern
//     segments x path segments), never a recursion;
//   - a pattern longer than MAX_GLOB_LENGTH is refused, see FAIL CLOSED below.
//
// PURE: this module MUST NOT import 'vscode' and performs no I/O. It operates on
// already-normalised POSIX relative paths so it is fully unit-testable.
//
// Path convention: callers pass forward-slash relative paths (e.g. "src/a.css"),
// never absolute paths and never backslashes : normalisation is the I/O layer's
// job, kept out of this pure core.
//
// SEMANTICS (gitignore):
//   - `*` matches any run of characters within ONE path segment, `?` exactly one
//     character of a segment;
//   - a segment that is exactly `**` matches zero or more whole segments, and a
//     TRAILING `/**` matches everything beneath (at least one segment);
//   - `**` anywhere else (`src**min`, `a**`) is NOT special: it behaves as a
//     plain `*` and never crosses a "/" (I-L10);
//   - a backslash escapes the next character: `foo\*bar` matches the literal
//     text `foo*bar` (I-L09); `\/` is a separator;
//   - a pattern with no "/" except a trailing one matches a name at ANY depth;
//     a "/" anywhere else (or a leading one) anchors it to the base directory;
//   - a match on a directory covers everything beneath it;
//   - a trailing "/" makes the pattern directory-only: it matches the directory
//     itself and what is under it, never a FILE of that name (I-L08).
//
// FAIL CLOSED: a pattern that cannot be evaluated (over the length cap, or a
// lone trailing backslash) is NEVER dropped. It compiles to a pattern carrying an
// `unevaluable` reason, and patternMatches then treats it as covering every path:
// a file the user may have excluded is not formatted. A NEGATED unevaluable
// pattern never re-includes anything. describeUnevaluable() words the reason for
// the places that report ignore information.

/**
 * Longest pattern, in characters, this module agrees to evaluate. A real ignore
 * line is a few dozen characters; the cap only exists to keep the worst case
 * (pattern x path work) bounded whatever a file contains.
 */
export const MAX_GLOB_LENGTH = 1024;

/** Longest raw pattern echoed back in a report, so a huge line cannot flood it. */
const MAX_ECHO_LENGTH = 80;

/** Wildcard codes inside a compiled segment; every other entry is a char code. */
const STAR = -1;
const ANY_ONE = -2;

/** The segment that matches any name: a single star. */
const ANY_NAME: readonly number[] = [STAR];

/** A segment that is exactly `**`: zero or more whole path segments. */
interface GlobstarSegment {
  readonly globstar: true;
}

/** A segment of literal characters and `*` / `?` wildcards. */
interface WildSegment {
  readonly globstar: false;
  readonly items: readonly number[];
}

type GlobSegment = GlobstarSegment | WildSegment;

const GLOBSTAR: GlobstarSegment = { globstar: true };

/** A parsed glob body, before the gitignore anchoring rules are applied. */
interface ParsedGlob {
  readonly segments: readonly GlobSegment[];
  readonly leadingSlash: boolean;
  readonly trailingSlash: boolean;
}

/** Collapse runs of `*` inside one segment, and recognise a lone `**`. */
function finishSegment(items: readonly number[]): GlobSegment {
  if (items.length === 2 && items[0] === STAR && items[1] === STAR) {
    return GLOBSTAR;
  }
  const collapsed: number[] = [];
  for (const item of items) {
    if (item === STAR && collapsed[collapsed.length - 1] === STAR) {
      continue;
    }
    collapsed.push(item);
  }
  return { globstar: false, items: collapsed };
}

/**
 * Split a glob into segments. Returns a string (the reason) when the text cannot
 * be evaluated. Linear: one pass, no backtracking.
 */
function parseGlob(text: string): ParsedGlob | string {
  if (text.length > MAX_GLOB_LENGTH) {
    return `${text.length} characters is over the ${MAX_GLOB_LENGTH}-character limit`;
  }

  const segments: GlobSegment[] = [];
  let current: number[] = [];
  let leadingSlash = false;
  let lastWasSeparator = false;

  const endSegment = (): void => {
    if (current.length > 0) {
      const segment = finishSegment(current);
      const previous = segments[segments.length - 1];
      // Consecutive `**` segments mean the same as one.
      if (!(segment.globstar && previous !== undefined && previous.globstar)) {
        segments.push(segment);
      }
      current = [];
    }
  };
  const separator = (index: number): void => {
    if (index === 0) {
      leadingSlash = true;
    }
    endSegment();
    lastWasSeparator = true;
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\\') {
      if (i === text.length - 1) {
        return 'it ends with a lone backslash';
      }
      i += 1;
      if (text[i] === '/') {
        separator(i - 1);
      } else {
        current.push(text.charCodeAt(i));
        lastWasSeparator = false;
      }
    } else if (ch === '/') {
      separator(i);
    } else {
      current.push(ch === '*' ? STAR : ch === '?' ? ANY_ONE : text.charCodeAt(i));
      lastWasSeparator = false;
    }
  }
  endSegment();

  return { segments, leadingSlash, trailingSlash: lastWasSeparator };
}

/**
 * Match one path segment against a wildcard segment. Greedy two-pointer: on a
 * mismatch it falls back to the LAST star only and never stacks backtrack points,
 * so the worst case is O(pattern length x text length), not exponential.
 */
function matchWild(items: readonly number[], text: string): boolean {
  const itemCount = items.length;
  const textLength = text.length;
  let p = 0;
  let t = 0;
  let starP = -1;
  let starT = 0;
  while (t < textLength) {
    if (p < itemCount && items[p] === STAR) {
      starP = p;
      starT = t;
      p += 1;
    } else if (p < itemCount && (items[p] === ANY_ONE || items[p] === text.charCodeAt(t))) {
      p += 1;
      t += 1;
    } else if (starP >= 0) {
      starT += 1;
      t = starT;
      p = starP + 1;
    } else {
      return false;
    }
  }
  while (p < itemCount && items[p] === STAR) {
    p += 1;
  }
  return p === itemCount;
}

/** Path segments of a POSIX relative path (empty segments are dropped). */
function splitPath(relativePosixPath: string): string[] {
  return relativePosixPath.split('/').filter((part) => part !== '');
}

/**
 * Anchored match: the pattern segments, in order, must cover a PREFIX of the path
 * segments. Sweeps the set of reachable "segments consumed" counts once per
 * pattern segment (a bitmap), so the cost is O(pattern segments x path segments)
 * whatever the number of `**`.
 */
function matchAnchored(
  segments: readonly GlobSegment[],
  parts: readonly string[],
  directoryOnly: boolean,
  isDirectory: boolean
): boolean {
  const count = parts.length;
  let reachable = new Uint8Array(count + 1);
  reachable[0] = 1;

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const next = new Uint8Array(count + 1);
    let any = false;

    if (segment.globstar) {
      let first = 0;
      while (first <= count && reachable[first] === 0) {
        first += 1;
      }
      // A trailing `**` must cover at least one segment ("a/**" is not "a").
      const from = index === segments.length - 1 ? first + 1 : first;
      for (let j = from; j <= count; j += 1) {
        next[j] = 1;
        any = true;
      }
    } else {
      for (let j = 0; j < count; j += 1) {
        if (reachable[j] === 1 && matchWild(segment.items, parts[j])) {
          next[j + 1] = 1;
          any = true;
        }
      }
    }

    if (!any) {
      return false;
    }
    reachable = next;
  }

  // A prefix shorter than the whole path names a DIRECTORY that contains the
  // file: it covers it. Consuming every segment names the path itself, which a
  // directory-only pattern accepts only when the path is a directory.
  for (let j = 1; j < count; j += 1) {
    if (reachable[j] === 1) {
      return true;
    }
  }
  return reachable[count] === 1 && (!directoryOnly || isDirectory);
}

/**
 * Unanchored match: the single pattern segment must match ANY one path segment.
 * A match on an ancestor covers the file; a match on the last segment is the path
 * itself, which a directory-only pattern accepts only when the path is a directory.
 */
function matchAnyDepth(
  items: readonly number[],
  parts: readonly string[],
  directoryOnly: boolean,
  isDirectory: boolean
): boolean {
  const last = parts.length - 1;
  for (let k = 0; k <= last; k += 1) {
    if (matchWild(items, parts[k]) && (k < last || !directoryOnly || isDirectory)) {
      return true;
    }
  }
  return false;
}

/** A parsed .gitignore-style pattern, ready to test against a relative path. */
export interface IgnorePattern {
  /** The original line as authored (for diagnostics / source attribution). */
  readonly raw: string;
  /** True when prefixed with "!": a re-include that overrides earlier matches. */
  readonly negated: boolean;
  /** True when the pattern ends with "/": it matches directories only. */
  readonly directoryOnly: boolean;
  /**
   * True when the pattern is tied to the base directory (a leading "/" or a "/"
   * inside it); false when it matches a name at any depth.
   */
  readonly anchored: boolean;
  /** Compiled path segments (empty when the pattern is unevaluable). */
  readonly segments: readonly GlobSegment[];
  /**
   * Set when the pattern could not be evaluated, with the reason. Such a pattern
   * FAILS CLOSED in patternMatches: it covers every path (see the header).
   */
  readonly unevaluable?: string;
}

function compilePattern(line: string, allowNegation: boolean): IgnorePattern | undefined {
  let body = line;
  let negated = false;
  if (allowNegation && body.startsWith('!')) {
    negated = true;
    body = body.slice(1);
  }

  const parsed = parseGlob(body);
  if (typeof parsed === 'string') {
    return {
      raw: line,
      negated,
      directoryOnly: false,
      anchored: false,
      segments: [],
      unevaluable: parsed
    };
  }
  if (parsed.segments.length === 0) {
    return undefined;
  }
  return {
    raw: line,
    negated,
    directoryOnly: parsed.trailingSlash,
    anchored: parsed.leadingSlash || parsed.segments.length > 1,
    segments: parsed.segments
  };
}

/**
 * Compile one already-trimmed, non-empty, non-comment .gitignore line into an
 * IgnorePattern. Returns undefined ONLY when there is nothing to match (an empty
 * body after the markers, e.g. "!" or "/"). A line that cannot be evaluated is
 * NOT dropped: it is returned with `unevaluable` set so it fails closed.
 *
 * Anchoring rules (gitignore semantics):
 *   - a pattern containing a "/" anywhere except a trailing one is anchored to
 *     the ignore file's directory (matched from the start of the relative path);
 *   - a pattern with no internal "/" matches a file/dir of that name at ANY
 *     depth (e.g. `*.min.css` or `node_modules`);
 *   - a leading "/" forces anchoring even for a name-only pattern.
 */
export function compileIgnorePattern(line: string): IgnorePattern | undefined {
  return compilePattern(line, true);
}

/**
 * Compile an `overrides[].files` glob of .soukformatrc with the SAME matcher and
 * the same anchoring rules as a .soukformatignore line, so `*.css` matches
 * `sub/a.css` (LOW-04). The only difference: a leading "!" is a literal
 * character here (an override has no re-include), never a negation.
 */
export function compileFilesGlob(glob: string): IgnorePattern | undefined {
  return compilePattern(glob, false);
}

/**
 * Test whether a relative POSIX path matches one compiled pattern. Directory-only
 * patterns ("foo/") match the directory itself (pass `isDirectory` true) and
 * anything beneath it; a FILE that merely shares the name does not match.
 *
 * FAIL CLOSED: an unevaluable pattern matches every path, unless it is negated,
 * in which case it matches none (it must never re-include a file).
 */
export function patternMatches(
  pattern: IgnorePattern,
  relativePosixPath: string,
  isDirectory = false
): boolean {
  if (pattern.unevaluable !== undefined) {
    return !pattern.negated;
  }
  const parts = splitPath(relativePosixPath);
  if (parts.length === 0) {
    return false;
  }
  if (!pattern.anchored) {
    // A name-only pattern has exactly one segment. A lone `**` is then just
    // "any name", so it reads as a single star.
    const only = pattern.segments[0];
    const items = only !== undefined && !only.globstar ? only.items : ANY_NAME;
    return matchAnyDepth(items, parts, pattern.directoryOnly, isDirectory);
  }
  return matchAnchored(pattern.segments, parts, pattern.directoryOnly, isDirectory);
}

/**
 * One-sentence report for a pattern that could not be evaluated, or undefined
 * when the pattern is fine. Worded for "Show Effective Configuration" and the
 * output channel: it names the pattern, the reason and the consequence. The
 * default consequence is the ignore one; a caller with a different fallback
 * (an override that is skipped) passes its own.
 */
export function describeUnevaluable(
  pattern: IgnorePattern,
  consequence?: string
): string | undefined {
  if (pattern.unevaluable === undefined) {
    return undefined;
  }
  const shown =
    pattern.raw.length > MAX_ECHO_LENGTH ? `${pattern.raw.slice(0, MAX_ECHO_LENGTH)}...` : pattern.raw;
  const effect =
    consequence ??
    (pattern.negated ? 'the re-include is not applied' : 'every file it might cover is excluded');
  return `pattern "${shown}" cannot be evaluated (${pattern.unevaluable}); ${effect}.`;
}
