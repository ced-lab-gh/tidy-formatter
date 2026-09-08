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
//
// FAIL-SAFE LOADING: the `editorconfig` package pulls in @one-ini/wasm, whose
// CommonJS entry does a bare readFileSync of a SIBLING `one_ini_bg.wasm` at
// MODULE INITIALISATION time. A static `import` of 'editorconfig' would make
// that read part of THIS module's own initialisation, which the bundler hoists
// ABOVE any try/catch written inside a function: a quarantined or partially
// installed asset would then throw while the extension bundle is merely being
// loaded, killing activation and every format, even in a workspace with no
// .editorconfig at all. The package is therefore loaded LAZILY and GUARDED (see
// loadBundledParseSync) so an unavailable or corrupt asset degrades to "no
// .editorconfig layer" instead of breaking the extension.
import type { KnownProps, Props } from 'editorconfig';
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
 * 'unset'. Such a value must never be forwarded : it means "fall back to the
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
 * corrupts tabSize (the resolver would also reject it : this is belt-and-braces).
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

/* -------------------------------------------------------------------------- */
/* Fail-safe loading of the `editorconfig` package                              */
/* -------------------------------------------------------------------------- */

/** The single entry point this module needs from the `editorconfig` package. */
export type ParseSyncFn = (fsPath: string) => Props;

/**
 * Resolves {@link ParseSyncFn}, or returns undefined when the parser cannot be
 * used at all (asset missing, wasm refused to instantiate, package shape
 * changed). A loader is allowed to throw: callers must treat a throw exactly
 * like an undefined result.
 */
export type ParseSyncLoader = () => ParseSyncFn | undefined;

/**
 * Wrap a loader so it runs AT MOST ONCE. Two reasons, both load-bearing:
 *   - a working parser is resolved once instead of on every format;
 *   - a BROKEN one is not retried on every format either. Node evicts a module
 *     that threw during load from its cache, so an unguarded retry would redo
 *     the failing filesystem read (and rebuild the wasm module) once per
 *     formatted document.
 *
 * A loader that throws is remembered as "permanently unavailable"; the wrapper
 * itself never throws. PURE: no I/O of its own, so the memo semantics are
 * unit-testable with a synthetic loader.
 */
export function memoizeParseSyncLoader(load: ParseSyncLoader): ParseSyncLoader {
  // `undefined` = not attempted yet; `null` = attempted and unusable.
  let cached: ParseSyncFn | null | undefined;
  return (): ParseSyncFn | undefined => {
    if (cached === undefined) {
      try {
        const resolved = load();
        cached = typeof resolved === 'function' ? resolved : null;
      } catch {
        cached = null;
      }
    }
    return cached ?? undefined;
  };
}

/**
 * Load `editorconfig`'s parseSync. The require lives INSIDE a function so the
 * @one-ini/wasm asset read happens on the first .editorconfig lookup rather
 * than while the extension bundle is initialising: a failure is then a caught
 * exception on one code path instead of an unhandled error that breaks
 * activation and every format.
 */
const requireParseSync: ParseSyncLoader = (): ParseSyncFn | undefined => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const mod = require('editorconfig') as { parseSync?: unknown } | undefined;
  return typeof mod?.parseSync === 'function'
    ? (mod.parseSync as ParseSyncFn)
    : undefined;
};

/** The production loader: the bundled package, loaded lazily, resolved once. */
export const loadBundledParseSync: ParseSyncLoader =
  memoizeParseSyncLoader(requireParseSync);

/**
 * Read the EditorConfig cascade for an on-disk file path and map it to a
 * ConfigLayer. Synchronous so it can slot into the existing synchronous
 * readResolvedOptions without changing the provider call sites; the parse is a
 * cheap, bounded directory walk (root -> file) and never executes workspace code.
 *
 * `fsPath` MUST be a real absolute filesystem path (e.g. document.uri.fsPath);
 * a virtual/untitled document has none and must not reach this function.
 *
 * Never throws, and that claim now covers the WHOLE dependency: loading the
 * parser, parsing and mapping all sit inside one try/catch, so a missing or
 * corrupt @one-ini/wasm asset, a broken .editorconfig or an unreadable
 * directory all yield undefined and formatting simply falls back to the lower
 * precedence layers (fail-safe, CFG-06).
 *
 * @param fsPath        absolute path of the document being formatted.
 * @param loadParseSync seam for tests; defaults to the bundled package.
 */
export function readEditorConfigLayer(
  fsPath: string,
  loadParseSync: ParseSyncLoader = loadBundledParseSync
): ConfigLayer | undefined {
  if (typeof fsPath !== 'string' || fsPath.trim() === '') {
    return undefined;
  }
  try {
    const parseSync = loadParseSync();
    if (typeof parseSync !== 'function') {
      // The .editorconfig layer is simply unavailable: skip it silently and let
      // the lower layers govern. Refusing to format would be far worse than
      // ignoring a config layer the user may not even have.
      return undefined;
    }
    const props = parseSync(fsPath);
    if (props === null || typeof props !== 'object') {
      return undefined;
    }
    return mapEditorConfigLayer(props);
  } catch {
    // A broken or unreadable .editorconfig, or an unusable parser, must not
    // break formatting; ignore it and let the lower layers govern.
    return undefined;
  }
}
