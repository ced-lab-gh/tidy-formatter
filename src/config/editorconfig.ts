// .editorconfig layer: reads the on-disk EditorConfig cascade for a file and
// maps the resolved EditorConfig properties to a ConfigLayer the pure resolver
// understands. This is precedence layer (3) per SPEC §6:
//
//   (1) builtin < (2) VS Code + FormattingOptions < (3) .editorconfig
//     < (4) .soukformatrc < (5) globs
//
// PURE: this module MUST NOT import 'vscode'. The cascade is resolved by the
// `editorconfig` package (which honours `root = true` and merges from the file's
// directory up to the cascade root). The mapping from EditorConfig vocabulary to
// the canonical ResolvedOptions vocabulary lives in `mapEditorConfigLayer`, kept
// free of any I/O so it is unit-testable with synthetic property objects.
//
// Covers CFG-03 (#31,#34,#62,#88): indent_style / indent_size / tab_width /
// end_of_line / charset / insert_final_newline / trim_trailing_whitespace /
// max_line_length.
import { parseSync, type KnownProps, type Props } from 'editorconfig';
import type { ConfigLayer } from './resolver';

/** Origin label surfaced verbatim in "Show Effective Configuration". */
export const SOURCE_EDITORCONFIG = '.editorconfig';

/**
 * Canonical engine-option keys produced by the mapper for properties that have
 * no typed ResolvedOptions field. They flow through the resolver unchanged into
 * engineOptions (so they remain inspectable) and, where an engine consumes them
 * (e.g. wrap_line_length), drive the beautifier.
 */
const ENGINE_KEY_WRAP_LINE_LENGTH = 'wrap_line_length';
const ENGINE_KEY_CHARSET = 'charset';

/**
 * EditorConfig spells "this key is explicitly cleared" as the literal string
 * 'unset'. Such a value must never be forwarded — it means "fall back to the
 * lower precedence layer", which the resolver already does when a key is absent.
 */
function isUnset(value: unknown): boolean {
  return value === 'unset';
}

/**
 * Coerce an EditorConfig indent value (`indent_size` / `tab_width`) to a
 * positive integer. EditorConfig may yield a number, a numeric string, or the
 * sentinel 'tab' (when `indent_size = tab`); only real positive integers are
 * accepted, everything else returns undefined so a malformed value never
 * corrupts tabSize (the resolver would also reject it — this is belt-and-braces).
 */
function coerceIndentNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '' && value !== 'tab') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return undefined;
}

/**
 * Map a resolved set of EditorConfig properties (already cascaded for one file)
 * onto a single ConfigLayer in the canonical vocabulary expected by
 * resolveOptions. PURE: no I/O, no 'vscode'. Returns undefined when nothing
 * usable was found, so the caller can skip adding an empty layer.
 *
 * Mapping (EditorConfig -> canonical):
 *   indent_style            -> insertSpaces (inverted: 'tab' => false)
 *   indent_size / tab_width -> tabSize  (indent_size wins; tab_width is the
 *                              fallback, notably when indent_size = 'tab')
 *   end_of_line             -> endOfLine ('lf' | 'crlf'; 'cr' dropped)
 *   insert_final_newline    -> insertFinalNewline
 *   trim_trailing_whitespace-> trimTrailingWhitespace
 *   max_line_length         -> engineOptions.wrap_line_length
 *   charset                 -> engineOptions.charset (inspectable only)
 *
 * The resolver applies the alias/inversion/coercion for the typed keys, so we
 * forward EditorConfig's own key names for those; only the engine-bound keys are
 * renamed here to the engine's vocabulary.
 */
export function mapEditorConfigLayer(
  props: Readonly<Props | KnownProps>
): ConfigLayer | undefined {
  const values: Record<string, unknown> = {};

  // indent_style -> insertSpaces (resolver inverts: 'tab' => insertSpaces=false).
  if (props.indent_style !== undefined && !isUnset(props.indent_style)) {
    values.indent_style = props.indent_style;
  }

  // tabSize: prefer indent_size; if it is missing or the sentinel 'tab', fall
  // back to tab_width. We forward a single canonical-numeric `indent_size` so the
  // resolver's coercion sees a clean value.
  const indentSize = coerceIndentNumber(props.indent_size);
  const tabWidth = coerceIndentNumber(props.tab_width);
  const resolvedTabSize = indentSize ?? tabWidth;
  if (resolvedTabSize !== undefined) {
    values.indent_size = resolvedTabSize;
  }

  if (props.end_of_line !== undefined && !isUnset(props.end_of_line)) {
    values.end_of_line = props.end_of_line;
  }

  if (
    props.insert_final_newline !== undefined &&
    !isUnset(props.insert_final_newline)
  ) {
    values.insert_final_newline = props.insert_final_newline;
  }

  if (
    props.trim_trailing_whitespace !== undefined &&
    !isUnset(props.trim_trailing_whitespace)
  ) {
    values.trim_trailing_whitespace = props.trim_trailing_whitespace;
  }

  // max_line_length -> engine wrap_line_length. EditorConfig allows the literal
  // 'off' to disable; only forward a real positive integer (the engine reads a
  // number) so 'off' / garbage never reaches the beautifier as a bad value.
  const maxLineLength = coerceIndentNumber(
    (props as Props).max_line_length as unknown
  );
  if (maxLineLength !== undefined) {
    values[ENGINE_KEY_WRAP_LINE_LENGTH] = maxLineLength;
  }

  // charset is not consumed by the engine (it would risk re-encoding the file),
  // but we surface it for "Show Effective Configuration" traceability.
  if (props.charset !== undefined && !isUnset(props.charset)) {
    values[ENGINE_KEY_CHARSET] = props.charset;
  }

  if (Object.keys(values).length === 0) {
    return undefined;
  }
  return { source: SOURCE_EDITORCONFIG, values };
}

/**
 * Read the EditorConfig cascade for an on-disk file path and map it to a
 * ConfigLayer. Synchronous so it can slot into the existing synchronous
 * readResolvedOptions without changing the provider call sites; the parse is a
 * cheap, bounded directory walk (root -> file) and never executes workspace code.
 *
 * `fsPath` MUST be a real absolute filesystem path (e.g. document.uri.fsPath);
 * a virtual/untitled document has none and must not reach this function.
 *
 * Never throws: any parse/IO failure yields undefined so formatting falls back
 * to the lower precedence layers rather than aborting (fail-safe, CFG-06).
 */
export function readEditorConfigLayer(fsPath: string): ConfigLayer | undefined {
  if (typeof fsPath !== 'string' || fsPath.trim() === '') {
    return undefined;
  }
  let props: Props;
  try {
    props = parseSync(fsPath);
  } catch {
    // A broken or unreadable .editorconfig must not break formatting; ignore it
    // and let the lower layers govern.
    return undefined;
  }
  return mapEditorConfigLayer(props);
}
