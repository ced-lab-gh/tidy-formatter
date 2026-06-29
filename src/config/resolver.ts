// Pure config resolution: maps a structured input (already gathered from the
// various precedence layers) to ResolvedOptions, recording the source of each
// effective key. This is the deep-merge / option-mapping logic only.
// MUST NOT import 'vscode' (testable under mocha + tsx).
//
// Covers CFG-01 (respect FormattingOptions tabSize/insertSpaces + [lang]
// settings by default) and the deep-merge backbone of CFG-02 (5-layer
// precedence): the caller passes layers ordered general -> specific; later
// layers win, merged deeply by key, and every winning key records its origin in
// ResolvedOptions.sources so the "Show Effective Configuration" command can
// explain exactly where each value came from.
import type { LangId, ResolvedOptions } from '../types';

/**
 * One precedence layer of raw settings, tagged with where it came from.
 * Layers are ordered general -> specific by the caller; later layers win,
 * merged deeply by key.
 */
export interface ConfigLayer {
  /** Human-readable origin used to populate ResolvedOptions.sources. */
  source: string;
  /** Raw key/value options contributed by this layer. */
  values: Record<string, unknown>;
}

export interface ResolveInput {
  languageId: LangId;
  /** Ordered general -> specific; later overrides earlier (deep merge by key). */
  layers: ConfigLayer[];
}

/**
 * Canonical keys that map to typed top-level fields of ResolvedOptions rather
 * than to the engineOptions bag. Any other key flows through to engineOptions.
 */
const TAB_SIZE_KEY = 'tabSize';
const INSERT_SPACES_KEY = 'insertSpaces';
const END_OF_LINE_KEY = 'endOfLine';
const TRIM_TRAILING_KEY = 'trimTrailingWhitespace';
const INSERT_FINAL_NEWLINE_KEY = 'insertFinalNewline';

/**
 * Built-in defaults. They are the lowest-priority layer and guarantee that a
 * fully-resolved ResolvedOptions always has the mandatory fields populated even
 * when no caller-provided layer sets them (CFG-01 fallback).
 */
const BUILTIN_TAB_SIZE = 4;
const BUILTIN_INSERT_SPACES = true;
const BUILTIN_SOURCE = 'builtin defaults';

/**
 * Alias normalization. Layer providers may speak their native vocabulary
 * (EditorConfig uses snake_case, VS Code uses camelCase). We normalise every
 * incoming key to the canonical ResolvedOptions vocabulary so the deep merge
 * compares like with like. Unknown keys are passed through unchanged into the
 * engineOptions bag.
 */
const KEY_ALIASES: Readonly<Record<string, string>> = {
  // EditorConfig -> canonical
  indent_size: TAB_SIZE_KEY,
  tab_width: TAB_SIZE_KEY,
  indent_style: INSERT_SPACES_KEY,
  end_of_line: END_OF_LINE_KEY,
  insert_final_newline: INSERT_FINAL_NEWLINE_KEY,
  trim_trailing_whitespace: TRIM_TRAILING_KEY,
  // js-beautify alias kept readable for migrants
  indent_with_tabs: INSERT_SPACES_KEY
};

/**
 * Keys whose semantics are inverted relative to the canonical boolean.
 * EditorConfig `indent_style = tab` and js-beautify `indent_with_tabs = true`
 * both mean "do NOT insert spaces", so when these aliases feed insertSpaces the
 * incoming value must be inverted.
 */
const INVERTED_BOOLEAN_KEYS: ReadonlySet<string> = new Set([
  'indent_style',
  'indent_with_tabs'
]);

function canonicalKey(rawKey: string): string {
  return KEY_ALIASES[rawKey] ?? rawKey;
}

/**
 * Coerce a raw indentation value to a positive integer, or undefined when it
 * cannot be interpreted. We never trust external layer data blindly.
 */
function coerceTabSize(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return undefined;
}

/**
 * Coerce a raw value to a boolean. Accepts native booleans and the common
 * string spellings used by config files ('true'/'false', 'tab'/'space').
 * Returns undefined when the value is not a recognisable boolean.
 */
function coerceBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === 'tab') {
      return true;
    }
    if (normalized === 'false' || normalized === 'space') {
      return false;
    }
  }
  return undefined;
}

/**
 * Coerce a raw end-of-line value to the canonical 'lf' | 'crlf'. EditorConfig
 * spells these 'lf'/'crlf'/'cr'; 'cr' is unsupported and treated as unknown.
 */
function coerceEndOfLine(value: unknown): 'lf' | 'crlf' | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'lf' || normalized === 'crlf') {
    return normalized;
  }
  return undefined;
}

/**
 * Accumulator shape used while folding layers. Each typed field is paired with
 * the source that last set it, so the final sources map is exact.
 */
interface Accumulator {
  tabSize?: { value: number; source: string };
  insertSpaces?: { value: boolean; source: string };
  endOfLine?: { value: 'lf' | 'crlf'; source: string };
  trimTrailingWhitespace?: { value: boolean; source: string };
  insertFinalNewline?: { value: boolean; source: string };
  engineOptions: Map<string, { value: unknown; source: string }>;
}

/**
 * Apply a single raw key/value pair from a layer onto the accumulator,
 * normalising aliases and routing canonical keys to typed fields while
 * everything else lands in engineOptions. A key that fails coercion is ignored
 * (kept at the prior layer's value) rather than silently corrupting the typed
 * field — fail-safe, never fail-destructive.
 */
function applyEntry(
  acc: Accumulator,
  rawKey: string,
  rawValue: unknown,
  source: string
): void {
  const key = canonicalKey(rawKey);

  switch (key) {
    case TAB_SIZE_KEY: {
      const value = coerceTabSize(rawValue);
      if (value !== undefined) {
        acc.tabSize = { value, source };
      }
      return;
    }
    case INSERT_SPACES_KEY: {
      let value = coerceBoolean(rawValue);
      if (value !== undefined) {
        if (INVERTED_BOOLEAN_KEYS.has(rawKey)) {
          value = !value;
        }
        acc.insertSpaces = { value, source };
      }
      return;
    }
    case END_OF_LINE_KEY: {
      const value = coerceEndOfLine(rawValue);
      if (value !== undefined) {
        acc.endOfLine = { value, source };
      }
      return;
    }
    case TRIM_TRAILING_KEY: {
      const value = coerceBoolean(rawValue);
      if (value !== undefined) {
        acc.trimTrailingWhitespace = { value, source };
      }
      return;
    }
    case INSERT_FINAL_NEWLINE_KEY: {
      const value = coerceBoolean(rawValue);
      if (value !== undefined) {
        acc.insertFinalNewline = { value, source };
      }
      return;
    }
    default: {
      // Pass-through engine option. undefined values are treated as "not set"
      // so a layer cannot blank out a lower layer by accident.
      if (rawValue !== undefined) {
        acc.engineOptions.set(key, { value: rawValue, source });
      }
      return;
    }
  }
}

/**
 * Resolve the effective options by deep-merging the ordered layers and mapping
 * to ResolvedOptions, tracking the winning source per key.
 *
 * Deep merge semantics: each layer contributes a flat record of options; later
 * layers override earlier ones key by key. A key absent from a higher layer
 * never erases the value from a lower layer (no whole-layer replacement). This
 * is exactly the "deep merge by key" precedence required by CFG-02.
 */
export function resolveOptions(input: ResolveInput): ResolvedOptions {
  const acc: Accumulator = {
    engineOptions: new Map<string, { value: unknown; source: string }>()
  };

  // Seed with built-in defaults so mandatory typed fields are always present.
  acc.tabSize = { value: BUILTIN_TAB_SIZE, source: BUILTIN_SOURCE };
  acc.insertSpaces = { value: BUILTIN_INSERT_SPACES, source: BUILTIN_SOURCE };

  for (const layer of input.layers) {
    if (!layer || typeof layer.values !== 'object' || layer.values === null) {
      // Defensive: a malformed layer must not abort resolution; skip it so the
      // remaining (and lower) layers still govern. CFG-06 fallback principle.
      continue;
    }
    for (const [rawKey, rawValue] of Object.entries(layer.values)) {
      applyEntry(acc, rawKey, rawValue, layer.source);
    }
  }

  const sources: Record<string, string> = {};
  const engineOptions: Record<string, unknown> = {};

  // tabSize / insertSpaces are always defined (seeded above).
  const resolvedTabSize = acc.tabSize as { value: number; source: string };
  const resolvedInsertSpaces = acc.insertSpaces as {
    value: boolean;
    source: string;
  };

  sources[TAB_SIZE_KEY] = resolvedTabSize.source;
  sources[INSERT_SPACES_KEY] = resolvedInsertSpaces.source;

  const result: ResolvedOptions = {
    tabSize: resolvedTabSize.value,
    insertSpaces: resolvedInsertSpaces.value,
    engineOptions,
    sources
  };

  if (acc.endOfLine !== undefined) {
    result.endOfLine = acc.endOfLine.value;
    sources[END_OF_LINE_KEY] = acc.endOfLine.source;
  }
  if (acc.trimTrailingWhitespace !== undefined) {
    result.trimTrailingWhitespace = acc.trimTrailingWhitespace.value;
    sources[TRIM_TRAILING_KEY] = acc.trimTrailingWhitespace.source;
  }
  if (acc.insertFinalNewline !== undefined) {
    result.insertFinalNewline = acc.insertFinalNewline.value;
    sources[INSERT_FINAL_NEWLINE_KEY] = acc.insertFinalNewline.source;
  }

  for (const [key, entry] of acc.engineOptions) {
    engineOptions[key] = entry.value;
    sources[key] = entry.source;
  }

  nestPrettierOptions(engineOptions);

  return result;
}

/**
 * Prefix used for Prettier stylistic options carried as flat engineOptions keys.
 * Every layer (VS Code and .soukformatrc) emits Prettier options as
 * `prettier.<engineKey>` so the pure resolver can deep-merge them by key like any
 * other option; this final pass lifts the flat `prettier.*` keys into a single
 * nested `engineOptions.prettier` object that the prettier engine consumes.
 */
const PRETTIER_KEY_PREFIX = 'prettier.';

/**
 * Lift flat `prettier.<key>` engineOptions entries into a nested
 * `engineOptions.prettier` object (creating it once), removing the flat keys.
 * The per-key source attribution recorded under `prettier.<key>` in `sources` is
 * left untouched so "Show Effective Configuration" can still report the origin of
 * each stylistic option. Pure: mutates only the freshly-built local engineOptions.
 */
function nestPrettierOptions(engineOptions: Record<string, unknown>): void {
  let bag: Record<string, unknown> | undefined;
  for (const key of Object.keys(engineOptions)) {
    if (!key.startsWith(PRETTIER_KEY_PREFIX)) {
      continue;
    }
    const bareKey = key.slice(PRETTIER_KEY_PREFIX.length);
    if (bareKey === '') {
      continue;
    }
    if (bag === undefined) {
      bag = {};
    }
    bag[bareKey] = engineOptions[key];
    delete engineOptions[key];
    // Keep the flat source key so showConfig can attribute each prettier option.
  }
  if (bag !== undefined) {
    engineOptions.prettier = bag;
  }
}
