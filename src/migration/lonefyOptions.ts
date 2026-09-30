// Pure lonefy -> Tidy KEY mapper (ROADMAP Axe 1, task 1.T1; SPEC §6 "Compat
// .jsbeautifyrc" + §13.14, Non-goal §11 ".jsbeautifyrc best-effort").
//
// This is the FLAT key vocabulary: one js-beautify options object (a
// `.jsbeautifyrc`, or ONE section of the incumbent's `formatter.json`) turned
// into the subset of Tidy `tidy.*` settings that have a faithful, in-domain
// equivalent, so an OPT-IN migration can PREVIEW exactly what it would write
// before the user confirms. The incumbent's real file shape (sections plus
// `onSave`) is handled one level up, in lonefyConfig.ts, which REUSES this mapper
// once per section.
//
// PURE: this module MUST NOT import 'vscode' (modelled on src/config/editorconfig.ts).
// It performs no I/O and never throws : every external value is validated and any
// failure becomes data in the returned result (warnings / unmapped), never an
// exception. Immutable: the input is treated as read-only and a fresh result is
// produced. This is the contract the anti-hijack rule depends on: nothing is ever
// derived or written silently; out-of-domain values are reported, not applied.
import { parse as parseJsonc, type ParseError, printParseErrorCode } from 'jsonc-parser';
import type { LonefyMappingResult } from './types';

/** Canonical Tidy setting ids this mapper can produce (all real package.json keys). */
const TIDY_INDENT = 'tidy.indent';
const TIDY_BRACE_STYLE = 'tidy.brace_style';
const TIDY_WRAP_LINE_LENGTH = 'tidy.wrap_line_length';
const TIDY_WRAP_ATTRIBUTES = 'tidy.wrap_attributes';
const TIDY_SPACE_AFTER_ANON_FUNCTION = 'tidy.space_after_anon_function';

/**
 * `tidy.indent` (js-beautify indent_size) accepts an integer in [1, 16] in
 * package.json. Values outside this range are dropped (warned), never written.
 */
const INDENT_MIN = 1;
const INDENT_MAX = 16;

/**
 * Allowed `tidy.brace_style` values, copied verbatim from package.json's enum so
 * the mapper can never propose a value VS Code would reject.
 */
const BRACE_STYLE_ENUM: ReadonlySet<string> = new Set([
  'collapse',
  'expand',
  'end-expand',
  'none',
  'collapse-preserve-inline'
]);

/**
 * Allowed `tidy.wrap_attributes` values, copied verbatim from package.json's enum.
 */
const WRAP_ATTRIBUTES_ENUM: ReadonlySet<string> = new Set([
  'auto',
  'force',
  'force-aligned',
  'force-expand-multiline',
  'aligned-multiple',
  'preserve',
  'preserve-aligned'
]);

/**
 * Legacy js-beautify keys this mapper understands. Any source key NOT in this set
 * is reported in `unmapped` (never written). Kept as a set so the "is this key
 * recognised at all?" check is O(1) and stays in sync with the switch below.
 */
const KNOWN_LONEFY_KEYS: ReadonlySet<string> = new Set([
  'indent_size',
  'brace_style',
  'wrap_line_length',
  'wrap_attributes',
  'space_after_anon_function'
]);

/**
 * Coerce a js-beautify numeric option to a non-negative integer. js-beautify (and
 * `.jsbeautifyrc`) values may be a real number or a numeric string; only genuine
 * integers are accepted. Returns undefined for anything else so a malformed value
 * is reported rather than silently written.
 */
function coerceInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim());
    if (Number.isInteger(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

/**
 * Coerce a js-beautify boolean option. Accepts a real boolean or the strings
 * "true"/"false" (case-insensitive), which `.jsbeautifyrc` files sometimes carry.
 * Returns undefined for anything else so it is reported, not written.
 */
function coerceBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase();
    if (lower === 'true') {
      return true;
    }
    if (lower === 'false') {
      return false;
    }
  }
  return undefined;
}

/** Type guard: a non-null, non-array plain object usable as a key/value bag. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether a parsed object had its prototype REPLACED, which is what a JSON key
 * literally named `__proto__` does to the parser's plain object: the key then
 * vanishes from `Object.keys`. A formatter config has no business carrying one,
 * so callers report it as a key that was not carried over rather than losing it.
 */
export function hasForeignPrototype(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype !== null && prototype !== Object.prototype;
}

/**
 * Mutable accumulator used while mapping. Encapsulated so the per-key handlers
 * stay small and the public result is assembled once, immutably, at the end.
 */
interface Accumulator {
  settings: Record<string, unknown>;
  unmapped: string[];
  warnings: string[];
}

/** Map a single recognised key into the accumulator (validating its value). */
function mapKnownKey(key: string, value: unknown, acc: Accumulator): void {
  switch (key) {
    case 'indent_size': {
      const n = coerceInteger(value);
      if (n !== undefined && n >= INDENT_MIN && n <= INDENT_MAX) {
        acc.settings[TIDY_INDENT] = n;
      } else {
        acc.warnings.push(
          `indent_size: ignored value ${describeValue(value)} (expected an integer in [${INDENT_MIN}, ${INDENT_MAX}]).`
        );
      }
      return;
    }
    case 'brace_style': {
      if (typeof value === 'string' && BRACE_STYLE_ENUM.has(value)) {
        acc.settings[TIDY_BRACE_STYLE] = value;
      } else {
        acc.warnings.push(
          `brace_style: ignored value ${describeValue(value)} (expected one of ${listEnum(BRACE_STYLE_ENUM)}).`
        );
      }
      return;
    }
    case 'wrap_line_length': {
      const n = coerceInteger(value);
      if (n !== undefined && n >= 0) {
        acc.settings[TIDY_WRAP_LINE_LENGTH] = n;
      } else {
        acc.warnings.push(
          `wrap_line_length: ignored value ${describeValue(value)} (expected a non-negative integer).`
        );
      }
      return;
    }
    case 'wrap_attributes': {
      if (typeof value === 'string' && WRAP_ATTRIBUTES_ENUM.has(value)) {
        acc.settings[TIDY_WRAP_ATTRIBUTES] = value;
      } else {
        acc.warnings.push(
          `wrap_attributes: ignored value ${describeValue(value)} (expected one of ${listEnum(WRAP_ATTRIBUTES_ENUM)}).`
        );
      }
      return;
    }
    case 'space_after_anon_function': {
      const b = coerceBoolean(value);
      if (b !== undefined) {
        acc.settings[TIDY_SPACE_AFTER_ANON_FUNCTION] = b;
      } else {
        acc.warnings.push(
          `space_after_anon_function: ignored value ${describeValue(value)} (expected a boolean).`
        );
      }
      return;
    }
    default:
      // Unreachable: callers gate on KNOWN_LONEFY_KEYS. Defensive only.
      acc.unmapped.push(key);
  }
}

/** Compact, safe rendering of an arbitrary value for a warning message. */
export function describeValue(value: unknown): string {
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null
  ) {
    return String(value);
  }
  if (Array.isArray(value)) {
    return 'an array';
  }
  if (typeof value === 'object') {
    return 'an object';
  }
  return typeof value;
}

/** Render an enum set as a stable, quoted, comma-separated list for messages. */
function listEnum(set: ReadonlySet<string>): string {
  return [...set].map((v) => `'${v}'`).join(', ');
}

/**
 * Map a raw lonefy/`.jsbeautifyrc` options object to Tidy settings.
 *
 * Accepts ANYTHING (unknown) and validates it as a system boundary:
 *   - non-object input (string / number / array / null / undefined) yields an
 *     empty result plus a single warning, never a throw;
 *   - a recognised key with an out-of-domain value is dropped and warned;
 *   - an unrecognised key is reported in `unmapped`, never written.
 *
 * The input is never mutated; a fresh result object is returned.
 */
export function mapLonefyOptions(raw: unknown): LonefyMappingResult {
  if (!isPlainObject(raw)) {
    return {
      settings: {},
      unmapped: [],
      warnings: [
        `Expected a JSON object of js-beautify options but received ${describeValue(raw)}; nothing was mapped.`
      ]
    };
  }

  const acc: Accumulator = { settings: {}, unmapped: [], warnings: [] };

  for (const key of Object.keys(raw)) {
    if (KNOWN_LONEFY_KEYS.has(key)) {
      mapKnownKey(key, raw[key], acc);
    } else {
      acc.unmapped.push(key);
    }
  }
  if (hasForeignPrototype(raw)) {
    acc.unmapped.push('__proto__');
  }

  return {
    settings: acc.settings,
    unmapped: acc.unmapped,
    warnings: acc.warnings
  };
}

/** Outcome of {@link parseConfigText}: the parsed value, or why there is none. */
export type ParsedConfigText =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly warning: string };

/**
 * Parse a config file's TEXT as DATA and never as code. Tolerates comments and
 * trailing commas (the guard's lenient JSONC parsing; these files are JSONC in
 * practice), which is a superset of the strict JSON the incumbent loads with
 * `require`. Tidy must NEVER `require()` or evaluate the file: this parser only
 * builds plain values.
 *
 * Never throws: a non-string input or a parse failure becomes a `warning` that
 * names the file by `label`, so a broken config can never abort an opt-in
 * migration and the user is told which file was the problem.
 */
export function parseConfigText(text: unknown, label: string): ParsedConfigText {
  if (typeof text !== 'string') {
    return {
      ok: false,
      warning: `Expected ${label} contents as a string but received ${describeValue(text)}; nothing was mapped.`
    };
  }

  const errors: ParseError[] = [];
  const value = parseJsonc(text, errors, {
    allowTrailingComma: true,
    disallowComments: false
  });

  if (errors.length > 0) {
    const first = errors[0];
    return {
      ok: false,
      warning: `Could not parse ${label}: ${printParseErrorCode(first.error)} at offset ${first.offset}; nothing was mapped.`
    };
  }
  return { ok: true, value };
}

/**
 * Parse `.jsbeautifyrc` text and map it, FLAT keys only, to Tidy settings in one
 * step. Never throws: a parse failure becomes a warning and yields an empty
 * mapping. On success the parsed value is handed to `mapLonefyOptions`, which
 * itself validates that the value is actually an object.
 *
 * (The migration flow itself goes through lonefyConfig.ts, which also understands
 * sections and `onSave`; this entry point is the flat-only vocabulary.)
 */
export function mapLonefyRcText(text: unknown): LonefyMappingResult {
  const parsed = parseConfigText(text, '.jsbeautifyrc');
  if (!parsed.ok) {
    return { settings: {}, unmapped: [], warnings: [parsed.warning] };
  }
  return mapLonefyOptions(parsed.value);
}
