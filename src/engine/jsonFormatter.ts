// Fast JSON / JSONC pretty-printer (SPEC QA-03 / §9 "format plus rapide").
//
// Why this exists: js-beautify pretty-printed a 5 MB JSON document in ~1.9–5.6 s
// (machine-dependent), blowing the hard "JSON 5 MB < 2 s" budget. jsonc-parser's
// `format()` computes the same kind of whitespace edits in ~150 ms because it is a
// scanner-based, edit-producing formatter rather than a full re-print, AND it
// PRESERVES COMMENTS (so JSONC keeps its `//` and block comments) and trailing
// commas — exactly what the SPEC requires for the json/jsonc cluster (#134).
//
// jsonc-parser ships `applyEdits`, but it splices edits one at a time with string
// slicing, which is O(n²) and itself hangs on a 5 MB document. We instead apply
// all edits in a single left-to-right pass with one array join — O(n) — which is
// what makes the whole format step fast.
//
// IMPORTANT — safety is unaffected: this module only changes WHITESPACE/indent and
// re-uses jsonc-parser's own scanner, so the produced text always parses back to
// the same JSON value. The semantic guard (src/safety/guard.ts `jsonEqual`) still
// runs on the output afterwards and is the authority on equivalence; this module
// never gets a vote on correctness.
//
// PURE: MUST NOT import 'vscode'.
import { format as computeJsonFormatEdits, type Edit, type FormattingOptions } from 'jsonc-parser';
import type { ResolvedOptions } from '../types';

/**
 * Apply a set of jsonc-parser edits to `text` in a single O(n) pass.
 *
 * jsonc-parser guarantees its edits are non-overlapping; we sort them ascending
 * by offset and walk the source once, copying the gaps between edits and
 * inserting each edit's replacement content. This avoids the quadratic repeated
 * `slice + concat` of the library's own `applyEdits`, which is the difference
 * between ~0.2 s and "never finishes" on a multi-megabyte document.
 */
function applyEditsLinear(text: string, edits: readonly Edit[]): string {
  if (edits.length === 0) {
    return text;
  }
  const sorted = [...edits].sort((a, b) => a.offset - b.offset);
  const parts: string[] = [];
  let cursor = 0;
  for (const edit of sorted) {
    // Copy the untouched span before this edit, then the edit's replacement.
    if (edit.offset > cursor) {
      parts.push(text.slice(cursor, edit.offset));
    }
    parts.push(edit.content);
    cursor = edit.offset + edit.length;
  }
  if (cursor < text.length) {
    parts.push(text.slice(cursor));
  }
  return parts.join('');
}

/**
 * Map our ResolvedOptions onto jsonc-parser's FormattingOptions.
 *
 * - insertSpaces=false => indent with a single tab per level (tabSize ignored,
 *   matching js-beautify's tab behaviour).
 * - tabSize is clamped to a safe minimum the same way the js-beautify adapter
 *   does, so a malformed (0/NaN) layer never produces zero-width indentation.
 * - `eol` is left UNSET so jsonc-parser preserves the document's existing line
 *   ending. The deterministic EOL policy is applied afterwards by the engine's
 *   shared post-processing pass (only when `endOfLine` is explicitly requested),
 *   keeping a single source of truth for EOL/final-newline/trim across languages.
 */
function mapJsonFormattingOptions(resolved: ResolvedOptions): FormattingOptions {
  const useTabs = resolved.insertSpaces === false;
  const tabSize =
    Number.isFinite(resolved.tabSize) && resolved.tabSize > 0 ? Math.floor(resolved.tabSize) : 4;
  return {
    tabSize: useTabs ? 1 : tabSize,
    insertSpaces: !useTabs,
    // keepLines:false (default) is what makes the output idempotent — a stable
    // canonical layout that a second pass reproduces byte-for-byte (SAFE-03).
    keepLines: false
  };
}

/**
 * Pretty-print a JSON / JSONC document, preserving comments and trailing commas.
 *
 * Returns the formatted text WITHOUT applying EOL / final-newline / trim policy —
 * that is the caller's shared post-processing responsibility, identical to the
 * js-beautify path, so the two engines stay behaviourally aligned on those knobs.
 *
 * jsonc-parser's `format()` is idempotent for these inputs (including the
 * inline-block-comment-before-a-key case that made js-beautify drift, captured as
 * BUG-JSONC-INLINE-COMMENT), so no fixed-point loop is needed here.
 */
export function formatJson(source: string, resolved: ResolvedOptions): string {
  const options = mapJsonFormattingOptions(resolved);
  // `range: undefined` => format the whole document.
  const edits = computeJsonFormatEdits(source, undefined, options);
  return applyEditsLinear(source, edits);
}
