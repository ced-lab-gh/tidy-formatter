// Pure, dependency-free gitignore glob matcher, LINEAR and BUDGETED, modelled on
// git's own dir.c / wildmatch.c and checked against `git check-ignore`.
//
// ONE implementation serves both consumers: the .soukformatignore matcher
// (compileIgnorePattern + evaluatePatterns) and the `overrides[].files` globs of
// .soukformatrc (compileFilesGlob + patternMatches). There is no RegExp here at
// all. The previous translators compiled a glob to a RegExp character by
// character and backtracked exponentially (a 31-character pattern froze the
// extension host for over 50 seconds). Here:
//
//   - a path segment is matched with the classic greedy two-pointer wildcard
//     algorithm (one remembered star, never a stack of them);
//   - `**` segments are matched by a reachable-position sweep over the path
//     segments (a bitmap of "how many segments are consumed so far");
//   - every step of both is charged to a MatchBudget shared by ALL the patterns
//     of one lookup, so neither a long pattern, nor many patterns, nor a very deep
//     path can cost more than MAX_MATCH_STEPS in total. When the budget runs out
//     the lookup FAILS CLOSED (see below).
//
// PURE: this module MUST NOT import 'vscode' and performs no I/O. It operates on
// already-normalised POSIX relative paths so it is fully unit-testable.
//
// SEMANTICS: git's, byte for byte, because the README promises "gitignore syntax":
//   - patterns and paths are matched as UTF-8 BYTES, like git (so `?` is one byte);
//   - `*` and `?` match within ONE path segment; `[abc]`, ranges `[a-z]`, negation
//     `[!abc]` / `[^abc]` and POSIX classes `[[:alpha:]]` match exactly one
//     character and never a "/". `]` first in a class is a member;
//   - a segment made only of two or more stars (`**`, `***`) is a globstar: zero
//     or more whole segments, and a TRAILING one needs at least one segment;
//     anywhere else a run of stars is a plain `*` (I-L10);
//   - a backslash escapes the next character: `foo\*bar` is the literal `foo*bar`;
//   - a pattern with no "/" (one trailing slash aside) matches a NAME at any
//     depth; a "/" anywhere else, inside a class included, anchors it to the base
//     directory, and one leading "/" is dropped;
//   - a trailing "/" makes the pattern match directories only (I-L08);
//   - a path is excluded when ONE OF ITS PARENT DIRECTORIES is excluded (a parent
//     excluded by the last pattern that matches it is final: nothing beneath it
//     can be re-included), otherwise when the last pattern that matches the path
//     itself is not a negation (git's rule, `!dir/` included);
//   - case: a pattern is compiled case-sensitive or case-insensitive (git's
//     core.ignorecase) as asked, with git's own ASCII-only folding and its quirk
//     that only the TEXT is folded inside a class (`[D]` never matches under
//     core.ignorecase). Nothing depends on the platform; a .soukformatignore line
//     is compiled both ways and merged on the safe side (see evaluatePatterns).
//
// KNOWN DEVIATIONS, all in the SAFE direction (this matcher excludes MORE than
// git, never less): a globstar followed by an escaped slash (`a/**\/b`) also
// matches `a/b`, where git needs at least one directory there; a pattern ending
// in an escaped slash (`foo\/`) fails closed where git matches nothing; a line
// ending in a lone backslash fails closed where git matches nothing.
//
// FAIL CLOSED: a pattern that cannot be evaluated (over the length cap, or a lone
// trailing backslash), and a lookup that exhausts its MatchBudget, is NEVER
// dropped. The pattern compiles with an `unevaluable` reason and covers every path;
// the exhausted lookup reports `budgetExceeded` and excludes the path. A NEGATED
// unevaluable pattern never re-includes anything. describeUnevaluable() and
// describeBudgetExceeded() word the reasons for the places that report ignore
// information.

/**
 * Longest pattern, in characters, this module agrees to evaluate. A real ignore
 * line is a few dozen characters; the cap only exists to keep the work per
 * pattern bounded whatever a file contains.
 */
export const MAX_GLOB_LENGTH = 1024;

/**
 * Hard ceiling on the matching work of ONE lookup (all the patterns of an ignore
 * file against one path, or all the overrides of a .soukformatrc against one
 * document): one step is one character or segment comparison. A benign file of
 * 26 000 ordinary patterns costs a fifth to two thirds of it (measured: 0.4 to 1.3
 * million, from a 6-segment to a 26-segment path); an
 * adversarial file cannot cost more, whatever its patterns and however deep the
 * path (about 15 ms of CPU at the ceiling, measured on a 1 MiB file of 1000
 * patterns against a 4095-character path).
 */
export const MAX_MATCH_STEPS = 2_000_000;

/** Longest raw pattern echoed back in a report, so a huge line cannot flood it. */
const MAX_ECHO_LENGTH = 80;

/** Options of the compile functions. */
export interface GlobOptions {
  /** Match case-insensitively, like git with core.ignorecase. Default: false (exact case). */
  readonly ignoreCase?: boolean;
}

/** Wildcard codes inside a compiled segment; 0..255 are literal bytes. */
const STAR = -1;
const ANY_ONE = -2;
/** A class reference is CLASS_BASE - index (so every class code is <= CLASS_BASE). */
const CLASS_BASE = -3;

const SLASH = 0x2f;
const BACKSLASH = 0x5c;
const STAR_BYTE = 0x2a;
const QUESTION = 0x3f;
const LBRACKET = 0x5b;
const RBRACKET = 0x5d;
const DASH = 0x2d;
const COLON = 0x3a;
const BANG = 0x21;
const CARET = 0x5e;

/** The POSIX classes git's wildmatch knows. */
type PosixClass =
  | 'alnum'
  | 'alpha'
  | 'blank'
  | 'cntrl'
  | 'digit'
  | 'graph'
  | 'lower'
  | 'print'
  | 'punct'
  | 'space'
  | 'upper'
  | 'xdigit';

const POSIX_CLASSES: ReadonlySet<string> = new Set([
  'alnum',
  'alpha',
  'blank',
  'cntrl',
  'digit',
  'graph',
  'lower',
  'print',
  'punct',
  'space',
  'upper',
  'xdigit'
]);

type ClassMember =
  | { readonly kind: 'one'; readonly ch: number }
  | { readonly kind: 'range'; readonly lo: number; readonly hi: number }
  | { readonly kind: 'posix'; readonly name: PosixClass };

/** A compiled bracket expression. */
interface ClassDef {
  readonly negated: boolean;
  readonly members: readonly ClassMember[];
}

/** A segment that is a globstar: zero or more whole path segments. */
interface GlobstarSegment {
  readonly globstar: true;
}

/** A segment of literal bytes, `*`, `?` and classes. */
interface WildSegment {
  readonly globstar: false;
  readonly items: Int16Array;
}

type GlobSegment = GlobstarSegment | WildSegment;

const GLOBSTAR: GlobstarSegment = { globstar: true };

/** The segment that matches any name: a single star. */
const ANY_NAME: WildSegment = { globstar: false, items: Int16Array.of(STAR) };

// ---------------------------------------------------------------------------
// Work budget
// ---------------------------------------------------------------------------

/** Thrown (the one shared instance) when a MatchBudget is exhausted; never escapes this module. */
class BudgetExceededSignal extends Error {
  constructor() {
    super('glob matching budget exceeded');
    this.name = 'BudgetExceededSignal';
  }
}

const BUDGET_EXCEEDED = new BudgetExceededSignal();

/**
 * The matching work still allowed for one lookup. Share ONE instance across every
 * pattern of the lookup (that is what bounds the total), and check `exhausted`
 * afterwards: once it is set every later call answers fail-closed without working.
 */
export class MatchBudget {
  private left: number;
  private spent = false;

  constructor(limit: number = MAX_MATCH_STEPS) {
    this.left = limit;
  }

  /** True once the allowance ran out: any verdict given since is the fail-closed one. */
  get exhausted(): boolean {
    return this.spent;
  }

  /** Steps still available (for tests and diagnostics). */
  get remaining(): number {
    return this.left;
  }

  /** @internal Spend steps; throws the shared signal when the allowance is gone. */
  charge(steps: number): void {
    this.left -= steps;
    if (this.left < 0) {
      this.spent = true;
      throw BUDGET_EXCEEDED;
    }
  }
}

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

/** UTF-8 bytes of a string. */
function toBytes(text: string): Uint8Array {
  return Buffer.from(text, 'utf8');
}

function isUpperAscii(b: number): boolean {
  return b >= 65 && b <= 90;
}

function isLowerAscii(b: number): boolean {
  return b >= 97 && b <= 122;
}

/** git folds ASCII only. */
function lowerAscii(b: number): number {
  return isUpperAscii(b) ? b + 32 : b;
}

/**
 * Parse the bracket expression that opens at `open` exactly as git's wildmatch
 * does. Returns the class and the index of its closing "]", or undefined when git
 * aborts (unterminated, a dangling escape, an unknown [:name:]): such a pattern
 * can never match anything.
 */
function parseClass(
  bytes: Uint8Array,
  open: number
): { readonly def: ClassDef; readonly end: number } | undefined {
  // Reads past the end give 0, like the NUL terminator of a C string.
  const at = (index: number): number => (index < bytes.length ? bytes[index] : 0);
  const members: ClassMember[] = [];

  let p = open + 1;
  let pCh = at(p);
  if (pCh === CARET) {
    pCh = BANG;
  }
  const negated = pCh === BANG;
  if (negated) {
    p += 1;
    pCh = at(p);
  }

  let prevCh = 0;
  do {
    if (pCh === 0) {
      return undefined;
    }
    if (pCh === BACKSLASH) {
      p += 1;
      pCh = at(p);
      if (pCh === 0) {
        return undefined;
      }
      members.push({ kind: 'one', ch: pCh });
    } else if (pCh === DASH && prevCh !== 0 && at(p + 1) !== 0 && at(p + 1) !== RBRACKET) {
      p += 1;
      pCh = at(p);
      if (pCh === BACKSLASH) {
        p += 1;
        pCh = at(p);
        if (pCh === 0) {
          return undefined;
        }
      }
      members.push({ kind: 'range', lo: prevCh, hi: pCh });
      pCh = 0; // so that prevCh is reset below
    } else if (pCh === LBRACKET && at(p + 1) === COLON) {
      const nameStart = p + 2;
      p = nameStart;
      for (pCh = at(p); pCh !== 0 && pCh !== RBRACKET; pCh = at(p)) {
        p += 1;
      }
      if (pCh === 0) {
        return undefined;
      }
      const nameLength = p - nameStart - 1;
      if (nameLength < 0 || at(p - 1) !== COLON) {
        // No ":]": "[" is an ordinary member and scanning resumes after it.
        p = nameStart - 2;
        pCh = LBRACKET;
        members.push({ kind: 'one', ch: LBRACKET });
      } else {
        const name = Buffer.from(bytes.subarray(nameStart, nameStart + nameLength)).toString('latin1');
        if (!POSIX_CLASSES.has(name)) {
          return undefined;
        }
        members.push({ kind: 'posix', name: name as PosixClass });
        pCh = 0;
      }
    } else {
      members.push({ kind: 'one', ch: pCh });
    }
    prevCh = pCh;
    p += 1;
    pCh = at(p);
  } while (pCh !== RBRACKET);

  return { def: { negated, members }, end: p };
}

/** The tokenizer's answer for a pattern git can never match. */
const NEVER: Tokenized = { segments: [], classes: [], never: true };

/** What the tokenizer produced for a pattern body. */
interface Tokenized {
  readonly segments: readonly GlobSegment[];
  readonly classes: readonly ClassDef[];
  /** Git aborts on this pattern (bad bracket expression): it matches nothing. */
  readonly never: boolean;
  /** Reason the pattern cannot be evaluated (fail closed), when it cannot. */
  readonly unevaluable?: string;
}

/**
 * Split a pattern body (negation, trailing slash and leading slash already
 * removed) into segments. In name mode (no "/") the whole body is one wildcard
 * segment; in path mode "/" separates segments and `**` segments are globstars.
 * Linear: one pass, no backtracking.
 */
function tokenize(bytes: Uint8Array, pathMode: boolean, ignoreCase: boolean): Tokenized {
  // A path pattern that still ends in "/" (it had two trailing slashes) ends in an
  // empty segment: git matches the literal text and a path never ends in a slash.
  if (pathMode && bytes[bytes.length - 1] === SLASH) {
    return NEVER;
  }

  const segments: GlobSegment[] = [];
  const classes: ClassDef[] = [];
  // Items of every segment are written into ONE preallocated buffer (this loop
  // runs once per character of every pattern line, so it has no closures and no
  // growing arrays); a finished segment is a copy of its slice of the buffer.
  const buffer = new Int16Array(bytes.length);
  let count = 0;
  let start = 0;

  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i];
    if (byte === BACKSLASH) {
      if (i === bytes.length - 1) {
        return { segments: [], classes: [], never: false, unevaluable: 'it ends with a lone backslash' };
      }
      i += 1;
      const escaped = bytes[i];
      if (escaped === SLASH && pathMode) {
        if (count === start) {
          return NEVER;
        }
        segments.push({ globstar: false, items: buffer.slice(start, count) });
        start = count;
      } else {
        buffer[count] = escaped; // like git: the character after "\\" is never case-folded
        count += 1;
      }
    } else if (byte === SLASH && pathMode) {
      if (count === start) {
        // An empty segment ("a//b", "//a"): git reads the doubled slash literally
        // and a path never contains one, so the pattern can never match.
        return NEVER;
      }
      segments.push({ globstar: false, items: buffer.slice(start, count) });
      start = count;
    } else if (byte === LBRACKET) {
      const parsed = parseClass(bytes, i);
      if (parsed === undefined) {
        return NEVER;
      }
      classes.push(parsed.def);
      buffer[count] = CLASS_BASE - (classes.length - 1);
      count += 1;
      i = parsed.end;
    } else if (byte === STAR_BYTE) {
      let end = i;
      while (end + 1 < bytes.length && bytes[end + 1] === STAR_BYTE) {
        end += 1;
      }
      const next = end + 1 < bytes.length ? bytes[end + 1] : -1;
      const nextIsSeparator =
        next === -1 ||
        next === SLASH ||
        (next === BACKSLASH && end + 2 < bytes.length && bytes[end + 2] === SLASH);
      if (pathMode && end > i && count === start && nextIsSeparator) {
        // A segment made only of stars (two or more): a globstar. The separator
        // that follows (if any) is consumed here. Consecutive globstars mean one.
        const previous = segments[segments.length - 1];
        if (!(previous !== undefined && previous.globstar)) {
          segments.push(GLOBSTAR);
        }
        if (next === SLASH) {
          end += 1;
        } else if (next === BACKSLASH) {
          end += 2;
        }
      } else if (!(count > start && buffer[count - 1] === STAR)) {
        buffer[count] = STAR;
        count += 1;
      }
      i = end;
    } else if (byte === QUESTION) {
      buffer[count] = ANY_ONE;
      count += 1;
    } else {
      buffer[count] = ignoreCase ? lowerAscii(byte) : byte;
      count += 1;
    }
  }
  if (count > start) {
    segments.push({ globstar: false, items: buffer.slice(start, count) });
  }
  return { segments, classes, never: false };
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
   * True when the pattern is tied to the base directory (it has a "/" other than
   * a trailing one); false when it matches a name at any depth.
   */
  readonly anchored: boolean;
  /** Match case-insensitively (git's core.ignorecase). */
  readonly ignoreCase: boolean;
  /** Compiled path segments (empty when the pattern is unevaluable or matches nothing). */
  readonly segments: readonly GlobSegment[];
  /** The bracket expressions the segments refer to. */
  readonly classes: readonly ClassDef[];
  /**
   * True when the pattern is well formed yet can never match (git aborts on an
   * unterminated bracket expression or an unknown [:class:]).
   */
  readonly neverMatches?: boolean;
  /**
   * Set when the pattern could not be evaluated, with the reason. Such a pattern
   * FAILS CLOSED: it covers every path (see the header).
   */
  readonly unevaluable?: string;
  /**
   * The same line compiled case-insensitively, when the pattern is matched in both
   * case modes (see {@link withFoldedTwin} and evaluatePatterns).
   */
  readonly foldedTwin?: IgnorePattern;
}

/**
 * A compiled pattern whose expensive part (tokenizing the body into segments) is
 * done the first time it is MATCHED, not when it is read. A lookup that runs out of
 * budget after a few patterns then never pays to compile the rest of a huge file.
 * Everything a caller needs BEFORE matching (negation, directory-only, anchoring,
 * the fail-closed reason) is computed eagerly and cheaply.
 */
class LazyPattern implements IgnorePattern {
  private tokens: Tokenized | undefined;

  constructor(
    readonly raw: string,
    readonly negated: boolean,
    readonly directoryOnly: boolean,
    readonly anchored: boolean,
    readonly ignoreCase: boolean,
    private readonly body: Uint8Array
  ) {}

  private resolve(): Tokenized {
    if (this.tokens === undefined) {
      this.tokens = tokenize(this.body, this.anchored, this.ignoreCase);
    }
    return this.tokens;
  }

  get segments(): readonly GlobSegment[] {
    return this.resolve().segments;
  }

  get classes(): readonly ClassDef[] {
    return this.resolve().classes;
  }

  get neverMatches(): boolean {
    const tokens = this.resolve();
    return tokens.never || tokens.segments.length === 0;
  }
}

/** Whether the bytes end in an UNPAIRED backslash (an odd run of trailing backslashes). */
function endsWithLoneBackslash(bytes: Uint8Array): boolean {
  let run = 0;
  for (let i = bytes.length - 1; i >= 0 && bytes[i] === BACKSLASH; i -= 1) {
    run += 1;
  }
  return run % 2 === 1;
}

/** A pattern that fails closed: it covers every path (see the header). */
function unevaluablePattern(
  raw: string,
  negated: boolean,
  ignoreCase: boolean,
  reason: string
): IgnorePattern {
  return {
    raw,
    negated,
    ignoreCase,
    directoryOnly: false,
    anchored: false,
    segments: [],
    classes: [],
    unevaluable: reason
  };
}

function compilePattern(
  line: string,
  allowNegation: boolean,
  options: GlobOptions | undefined
): IgnorePattern | undefined {
  const ignoreCase = options?.ignoreCase ?? false;
  let body = line;
  let negated = false;
  if (allowNegation && body.startsWith('!')) {
    negated = true;
    body = body.slice(1);
  }

  if (body.length > MAX_GLOB_LENGTH) {
    return unevaluablePattern(
      line,
      negated,
      ignoreCase,
      `${body.length} characters is over the ${MAX_GLOB_LENGTH}-character limit`
    );
  }

  let bytes = toBytes(body);
  const directoryOnly = bytes.length > 0 && bytes[bytes.length - 1] === SLASH;
  if (directoryOnly) {
    bytes = bytes.subarray(0, bytes.length - 1);
  }
  if (bytes.length === 0) {
    return undefined;
  }

  // Like git: a "/" ANYWHERE in the remaining text (an escaped one, or one
  // inside a bracket expression, included) makes it a path pattern.
  const anchored = bytes.includes(SLASH);
  if (anchored && bytes[0] === SLASH) {
    bytes = bytes.subarray(1);
  }
  if (bytes.length === 0) {
    return undefined;
  }
  if (endsWithLoneBackslash(bytes)) {
    return unevaluablePattern(line, negated, ignoreCase, 'it ends with a lone backslash');
  }

  return new LazyPattern(line, negated, directoryOnly, anchored, ignoreCase, bytes);
}

/**
 * Compile one .gitignore line (already stripped of trailing spaces, not a comment)
 * into an IgnorePattern. Returns undefined ONLY when there is nothing to match (an
 * empty body after the markers, e.g. "!" or "/"). A line that cannot be evaluated
 * is NOT dropped: it is returned with `unevaluable` set so it fails closed.
 */
export function compileIgnorePattern(line: string, options?: GlobOptions): IgnorePattern | undefined {
  return compilePattern(line, true, options);
}

/**
 * `exact` (compiled case-sensitive) carrying `folded`, the same line compiled
 * case-insensitively: evaluatePatterns then matches it in both modes. A pattern
 * that cannot be evaluated is the same in both modes and needs no twin. Without a
 * bracket expression or a backslash, folding only WIDENS a match (exact implies folded), so the
 * merge is `folded` for an exclusion and `exact` for a "!": one evaluation, not two.
 */
export function withFoldedTwin(exact: IgnorePattern, folded: IgnorePattern): IgnorePattern {
  if (exact.unevaluable !== undefined) {
    return exact;
  }
  if (!exact.raw.includes('[') && !exact.raw.includes('\\')) {
    return exact.negated ? exact : folded;
  }
  return Object.create(exact, { foldedTwin: { value: folded } }) as IgnorePattern;
}

/**
 * Compile an `overrides[].files` glob of .soukformatrc with the SAME matcher and
 * the same anchoring rules as a .soukformatignore line, so `*.css` matches
 * `sub/a.css` (LOW-04). The only difference: a leading "!" is a literal
 * character here (an override has no re-include), never a negation.
 */
export function compileFilesGlob(glob: string, options?: GlobOptions): IgnorePattern | undefined {
  return compilePattern(glob, false, options);
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** Whether a class member list matches `t` (already folded when `fold`), like git. */
function classMatches(def: ClassDef, t: number, fold: boolean, budget: MatchBudget): boolean {
  budget.charge(def.members.length);
  let matched = false;
  for (const member of def.members) {
    if (member.kind === 'one') {
      if (t === member.ch) {
        matched = true;
      }
    } else if (member.kind === 'range') {
      if (t <= member.hi && t >= member.lo) {
        matched = true;
      } else if (fold && isLowerAscii(t)) {
        const upper = t - 32;
        if (upper <= member.hi && upper >= member.lo) {
          matched = true;
        }
      }
    } else if (posixMatches(member.name, t, fold)) {
      matched = true;
    }
  }
  return matched !== def.negated;
}

function posixMatches(name: PosixClass, t: number, fold: boolean): boolean {
  switch (name) {
    case 'alnum':
      return (t >= 48 && t <= 57) || isUpperAscii(t) || isLowerAscii(t);
    case 'alpha':
      return isUpperAscii(t) || isLowerAscii(t);
    case 'blank':
      return t === 32 || t === 9;
    case 'cntrl':
      return t < 32 || t === 127;
    case 'digit':
      return t >= 48 && t <= 57;
    case 'graph':
      return t > 32 && t < 127;
    case 'lower':
      return isLowerAscii(t);
    case 'print':
      return t >= 32 && t < 127;
    case 'punct':
      return t > 32 && t < 127 && !((t >= 48 && t <= 57) || isUpperAscii(t) || isLowerAscii(t));
    case 'space':
      return t === 32 || (t >= 9 && t <= 13);
    case 'upper':
      return isUpperAscii(t) || (fold && isLowerAscii(t));
    case 'xdigit':
      return (t >= 48 && t <= 57) || (t >= 65 && t <= 70) || (t >= 97 && t <= 102);
  }
}

/**
 * Match one path segment against a wildcard segment. Greedy two-pointer: on a
 * mismatch it falls back to the LAST star only and never stacks backtrack points,
 * so the worst case is O(pattern length x text length), not exponential. Every
 * iteration is charged to the budget.
 */
function matchWild(
  items: Int16Array,
  classes: readonly ClassDef[],
  text: Uint8Array,
  fold: boolean,
  budget: MatchBudget
): boolean {
  const itemCount = items.length;
  const textLength = text.length;
  let p = 0;
  let t = 0;
  let starP = -1;
  let starT = 0;
  while (t < textLength) {
    budget.charge(1);
    if (p < itemCount) {
      const item = items[p];
      if (item === STAR) {
        starP = p;
        starT = t;
        p += 1;
        continue;
      }
      const byte = fold ? lowerAscii(text[t]) : text[t];
      if (
        item === ANY_ONE ||
        item === byte ||
        (item <= CLASS_BASE && classMatches(classes[CLASS_BASE - item], byte, fold, budget))
      ) {
        p += 1;
        t += 1;
        continue;
      }
    }
    if (starP >= 0) {
      starT += 1;
      t = starT;
      p = starP + 1;
      continue;
    }
    return false;
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
 * A path split into segments and encoded as UTF-8 bytes, ready to be matched by any
 * number of patterns. Encoding a long path costs as much as a few comparisons, so a
 * lookup against many patterns prepares it ONCE (see {@link preparePath}).
 */
export class PreparedPath {
  constructor(readonly parts: readonly Uint8Array[]) {}
}

/** Split and encode a relative POSIX path once, for repeated {@link patternMatches} calls. */
export function preparePath(relativePosixPath: string): PreparedPath {
  return new PreparedPath(splitPath(relativePosixPath).map(toBytes));
}

/**
 * Path-mode match: which prefixes of the path the segments match EXACTLY. Sweeps
 * the set of reachable "segments consumed" counts once per pattern segment (a
 * bitmap), so the cost is O(pattern segments x path segments) whatever the number
 * of `**`. Fills `out[j]` (1 <= j <= count) with 1 when the pattern matches the
 * first j segments of the path.
 */
function matchAnchored(
  pattern: IgnorePattern,
  parts: readonly Uint8Array[],
  budget: MatchBudget,
  out: Uint8Array
): void {
  const { segments, classes, ignoreCase } = pattern;
  const count = parts.length;
  let reachable = new Uint8Array(count + 1);
  let next = new Uint8Array(count + 1);
  reachable[0] = 1;

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    budget.charge(count + 1);
    next.fill(0);
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
        if (reachable[j] === 1 && matchWild(segment.items, classes, parts[j], ignoreCase, budget)) {
          next[j + 1] = 1;
          any = true;
        }
      }
    }

    if (!any) {
      return;
    }
    const swap = reachable;
    reachable = next;
    next = swap;
  }

  for (let j = 1; j <= count; j += 1) {
    out[j] = reachable[j];
  }
}

/**
 * Which prefixes of the path (1..count segments) the pattern matches exactly. A
 * prefix shorter than the path is a DIRECTORY; the whole path is a directory only
 * when `isDirectory`, which is what "directory only" patterns test.
 */
function matchedPrefixes(
  pattern: IgnorePattern,
  parts: readonly Uint8Array[],
  isDirectory: boolean,
  budget: MatchBudget
): Uint8Array {
  const count = parts.length;
  // Even a pattern that fails on its first character costs an allocation and a
  // sweep proportional to the path: charge it, or 20 000 short patterns against a
  // very long path would add up to a freeze without spending a single step.
  budget.charge(count + 1);
  const out = new Uint8Array(count + 1);
  if (pattern.neverMatches === true) {
    return out;
  }
  if (pattern.unevaluable !== undefined) {
    out.fill(1, 1);
    return out;
  }

  if (pattern.anchored) {
    matchAnchored(pattern, parts, budget, out);
  } else {
    const only = pattern.segments[0];
    const segment = only !== undefined && !only.globstar ? only : ANY_NAME;
    for (let j = 1; j <= count; j += 1) {
      if (matchWild(segment.items, pattern.classes, parts[j - 1], pattern.ignoreCase, budget)) {
        out[j] = 1;
      }
    }
  }
  if (pattern.directoryOnly && !isDirectory) {
    out[count] = 0;
  }
  return out;
}

/**
 * Test whether a relative POSIX path is COVERED by one compiled pattern: the path
 * itself matches, or one of its parent directories does (so `node_modules` covers
 * `node_modules/x.js`). Directory-only patterns ("foo/") cover what is under the
 * directory, and the directory itself only when `isDirectory` is true; a FILE that
 * merely shares the name is not covered.
 *
 * For a list of patterns with negations use {@link evaluatePatterns}, which
 * applies git's precedence; this function answers for ONE pattern.
 *
 * FAIL CLOSED: an unevaluable pattern covers every path, unless it is negated,
 * in which case it covers none. The same answer is given when the work budget
 * runs out (`budget.exhausted` is then set, and the caller can report it). Pass
 * ONE budget across the patterns of a lookup to bound their total cost, and a
 * {@link PreparedPath} to encode the path only once.
 */
export function patternMatches(
  pattern: IgnorePattern,
  relativePosixPath: string | PreparedPath,
  isDirectory = false,
  budget: MatchBudget = new MatchBudget()
): boolean {
  if (pattern.unevaluable !== undefined || budget.exhausted) {
    return !pattern.negated;
  }
  const parts =
    typeof relativePosixPath === 'string' ? preparePath(relativePosixPath).parts : relativePosixPath.parts;
  if (parts.length === 0) {
    return false;
  }
  try {
    const matched = matchedPrefixes(pattern, parts, isDirectory, budget);
    return matched.some((bit) => bit === 1);
  } catch (error) {
    if (error === BUDGET_EXCEEDED) {
      return !pattern.negated;
    }
    throw error;
  }
}

/** The verdict of an ordered pattern list for one path. */
export interface IgnoreVerdict {
  readonly ignored: boolean;
  /** Index of the pattern that settled the path; undefined when none matched. */
  readonly decidedBy?: number;
  /**
   * True when the lookup ran out of MatchBudget and the path is excluded BECAUSE
   * of it (fail closed), not because of a rule the user wrote.
   */
  readonly budgetExceeded?: boolean;
}

/**
 * Decide whether a path is ignored by an ordered pattern list, the way git does:
 * each parent directory of the path is judged first, top down, by the LAST pattern
 * that matches it; a parent excluded that way is final (nothing beneath it can be
 * re-included, even by a later `!pattern`), and a parent whose last match is a
 * negation is simply not excluded. Then the path itself: ignored when the last
 * pattern that matches it is not a negation. With no match the path is NOT
 * ignored (formatting proceeds).
 *
 * `isDirectory` says whether the path itself is a directory (a formatted document
 * is a file, so it defaults to false). The work of the whole lookup is bounded by
 * one MatchBudget: when it runs out the path is excluded (fail closed) and
 * `budgetExceeded` is set.
 *
 * CASE, SAFETY: a pattern with a `foldedTwin` is matched in both case modes and the
 * bitmaps are merged: OR for an exclusion, AND for a "!" re-include. Proof: for either
 * core.ignorecase value c, the merge is a superset of git's bitmap under c for every
 * exclusion and a subset for every "!". If git's last match of a prefix is an exclusion
 * e, ours is e or a later exclusion (a later merged "!" would also match under c, after
 * e). So what git excludes under EITHER value is excluded here; more may be, never less.
 */
export function evaluatePatterns(
  patterns: readonly IgnorePattern[],
  relativePosixPath: string,
  isDirectory = false
): IgnoreVerdict {
  const parts = splitPath(relativePosixPath);
  if (parts.length === 0 || patterns.length === 0) {
    return { ignored: false };
  }

  const budget = new MatchBudget();
  try {
    const bytes = parts.map(toBytes);
    const count = bytes.length;
    // decidedBy[j]: index of the LAST pattern matching the first j segments.
    const decidedBy = new Int32Array(count + 1).fill(-1);
    let undecided = count;

    for (let index = patterns.length - 1; index >= 0 && undecided > 0; index -= 1) {
      const pattern = patterns[index];
      if (pattern.unevaluable !== undefined && pattern.negated) {
        continue; // an unevaluable re-include never re-includes.
      }
      const matched = matchedPrefixes(pattern, bytes, isDirectory, budget);
      if (pattern.foldedTwin !== undefined) {
        const folded = matchedPrefixes(pattern.foldedTwin, bytes, isDirectory, budget);
        for (let j = 1; j <= count; j += 1) {
          matched[j] = pattern.negated ? matched[j] & folded[j] : matched[j] | folded[j];
        }
      }
      for (let j = 1; j <= count; j += 1) {
        if (matched[j] === 1 && decidedBy[j] < 0) {
          decidedBy[j] = index;
          undecided -= 1;
        }
      }
    }

    for (let j = 1; j < count; j += 1) {
      const by = decidedBy[j];
      if (by >= 0 && !patterns[by].negated) {
        return { ignored: true, decidedBy: by };
      }
    }
    const last = decidedBy[count];
    return last >= 0
      ? { ignored: !patterns[last].negated, decidedBy: last }
      : { ignored: false };
  } catch (error) {
    if (error === BUDGET_EXCEEDED) {
      return { ignored: true, budgetExceeded: true };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

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

/**
 * One-sentence report for a lookup that exhausted its matching budget: how many
 * patterns were involved, the limit, and the consequence the caller states.
 */
export function describeBudgetExceeded(patternCount: number, consequence: string): string {
  return (
    `matching ${patternCount} pattern${patternCount === 1 ? '' : 's'} against this path needs more ` +
    `than ${MAX_MATCH_STEPS} steps; ${consequence}.`
  );
}
