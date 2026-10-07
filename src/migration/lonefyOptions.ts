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
import {
  LONEFY_KEYS,
  coerceValue,
  isMappedKey,
  type CoerceContext
} from './lonefyKeys';
import type { LonefyMappingResult } from './types';

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
 * Mutable accumulator used while mapping. Encapsulated so the per-key handler stays
 * small and the public result is assembled once, immutably, at the end.
 */
interface Accumulator {
  settings: Record<string, unknown>;
  unmapped: string[];
  warnings: string[];
}

/** Map a single recognised key into the accumulator (validating its value). */
function mapKnownKey(
  key: string,
  value: unknown,
  context: CoerceContext,
  acc: Accumulator
): void {
  const spec = LONEFY_KEYS[key];
  const coerced = coerceValue(spec.domain, value, context);
  switch (coerced.kind) {
    case 'value':
      acc.settings[spec.tidyKey] = coerced.value;
      return;
    case 'no-equivalent':
      // A legitimate incumbent value Tidy cannot express: reported, never guessed.
      acc.unmapped.push(key);
      return;
    case 'invalid':
      acc.warnings.push(
        `${key}: ignored value ${describeValue(value)} (expected ${coerced.expected}).`
      );
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

/** Options of {@link mapLonefyOptions}. */
export interface MapOptions {
  /**
   * Whether the strings "true" / "false" are read as booleans. Default true (a
   * `.jsbeautifyrc` may carry them). The migration passes false for a section of
   * the incumbent's own file, where `"false"` is truthy (see CoerceContext).
   */
  readonly stringBooleans?: boolean;
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
export function mapLonefyOptions(
  raw: unknown,
  options: MapOptions = {}
): LonefyMappingResult {
  if (!isPlainObject(raw)) {
    return {
      settings: {},
      unmapped: [],
      warnings: [
        `Expected a JSON object of js-beautify options but received ${describeValue(raw)}; nothing was mapped.`
      ]
    };
  }

  const context: CoerceContext = { stringBooleans: options.stringBooleans ?? true };
  const acc: Accumulator = { settings: {}, unmapped: [], warnings: [] };

  for (const key of Object.keys(raw)) {
    if (isMappedKey(key)) {
      mapKnownKey(key, raw[key], context, acc);
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
