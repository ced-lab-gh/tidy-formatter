// Pure, dependency-free gitignore-style glob matcher.
//
// This EXTENDS the minimal glob used by config/soukformatrc.ts (the
// `globToRegExp` it carries for its `overrides[].files`) with the extra
// semantics a .gitignore needs — anchoring with a leading "/", directory-only
// patterns with a trailing "/", a bare name that matches at any depth, and the
// "**" segment wildcard — WITHOUT adding any npm dependency (the `ignore`
// package is intentionally NOT pulled in this pass, per Axe 4 constraints).
//
// PURE: this module MUST NOT import 'vscode' and performs no I/O. It operates on
// already-normalised POSIX relative paths so it is fully unit-testable.
//
// Path convention: callers pass forward-slash relative paths (e.g. "src/a.css"),
// never absolute paths and never backslashes — normalisation is the I/O layer's
// job, kept out of this pure core.

/**
 * Translate a single gitignore glob token-stream (already stripped of the
 * leading "!", and of any anchoring/dir markers handled by the caller) into a
 * RegExp source fragment. Mirrors soukformatrc.ts's globToRegExp but adds the
 * "/**\/" "zero-or-more directories" form so `a/**\/b` matches `a/b` too.
 *
 * Wildcard semantics:
 *   - `**` between separators (`/**\/`) => zero or more whole path segments,
 *   - `**` elsewhere                    => any run of characters (incl. "/"),
 *   - `*`                               => any run within a single segment,
 *   - `?`                               => exactly one non-separator character.
 */
function globBodyToRegExpSource(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        // Collapse a `/**/` (or leading `**/`, or trailing `/**`) into a
        // "zero or more directories" matcher so `a/**/b` also matches `a/b`.
        const precededBySlash = i === 0 || glob[i - 1] === '/';
        const followedBySlash = glob[i + 2] === '/';
        if (precededBySlash && followedBySlash) {
          // Consume `**/`; allow it to match nothing (so a/**/b === a/b).
          out += '(?:.*/)?';
          i += 2;
        } else {
          // A `**` not framed by separators behaves like a path-crossing star.
          out += '.*';
          i += 1;
        }
      } else {
        // Single `*` => any chars except a path separator.
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return out;
}

/** A parsed .gitignore-style pattern, ready to test against a relative path. */
export interface IgnorePattern {
  /** The original line as authored (for diagnostics / source attribution). */
  readonly raw: string;
  /** True when prefixed with "!": a re-include that overrides earlier matches. */
  readonly negated: boolean;
  /** Compiled matcher for the (possibly anchored) pattern body. */
  readonly regExp: RegExp;
  /** True when the pattern ends with "/": it matches directories only. */
  readonly directoryOnly: boolean;
}

/**
 * Compile one already-trimmed, non-empty, non-comment .gitignore line into an
 * IgnorePattern. Returns undefined when the line cannot be compiled (kept
 * fail-soft so one bad line never aborts the whole file).
 *
 * Anchoring rules (gitignore semantics):
 *   - a pattern containing a "/" anywhere except a trailing one is anchored to
 *     the ignore file's directory (matched from the start of the relative path);
 *   - a pattern with no internal "/" matches a file/dir of that name at ANY
 *     depth (e.g. `*.min.css` or `node_modules`);
 *   - a leading "/" forces anchoring even for a name-only pattern.
 */
export function compileIgnorePattern(line: string): IgnorePattern | undefined {
  let body = line;
  let negated = false;

  if (body.startsWith('!')) {
    negated = true;
    body = body.slice(1);
  }

  // An escaped leading "#" or "!" (`\#`, `\!`) is a literal first character.
  if (body.startsWith('\\#') || body.startsWith('\\!')) {
    body = body.slice(1);
  }

  let directoryOnly = false;
  if (body.endsWith('/')) {
    directoryOnly = true;
    body = body.slice(0, -1);
  }

  let anchored = false;
  if (body.startsWith('/')) {
    anchored = true;
    body = body.slice(1);
  }
  // A "/" anywhere in the remaining body also anchors the pattern.
  if (body.includes('/')) {
    anchored = true;
  }

  if (body === '') {
    return undefined;
  }

  const source = globBodyToRegExpSource(body);
  // Anchored: match from the path root. Unanchored (name-only): match the final
  // segment at any depth, i.e. optionally preceded by "<dirs>/".
  const prefix = anchored ? '^' : '^(?:.*/)?';
  // A directory pattern (or any pattern) also matches everything BELOW it, so a
  // file "build/x.js" is ignored by "build/". Allow an optional "/<rest>" tail.
  const suffix = '(?:/.*)?$';

  try {
    return {
      raw: line,
      negated,
      directoryOnly,
      regExp: new RegExp(`${prefix}${source}${suffix}`)
    };
  } catch {
    // A pathological body that does not compile is skipped (fail-soft). The
    // empty block is intentional; ESLint's no-empty needs a statement here.
    return undefined;
  }
}

/**
 * Test whether a relative POSIX path matches one compiled pattern. Directory-only
 * patterns ("foo/") match the directory itself or anything beneath it; since we
 * test files, that means the path must have the directory as an ancestor segment,
 * which the compiled `(?:/.*)?$` tail already encodes.
 */
export function patternMatches(pattern: IgnorePattern, relativePosixPath: string): boolean {
  return pattern.regExp.test(relativePosixPath);
}
