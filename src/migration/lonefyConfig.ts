// Pure mapper for the incumbent's REAL config file (v0.5.0, MIGRATION).
//
// The incumbent (lonefy.vscode-JS-CSS-HTML-formatter) reads `formatter.json`:
//   { "onSave": true,
//     "javascript": { "indent_size": 4, ... },
//     "css":        { "indent_size": 4, ... },
//     "html":       { "indent_size": 4, ... } }
// (probe P3(a), _internal/audit-v050/09-sondes-hote.md section 1). Until v0.4.2
// Tidy only understood FLAT keys, so on this real shape it produced `settings: {}`
// and the migration imported nothing.
//
// This module maps the real shape:
//   - each per-language SECTION goes through the EXISTING flat key mapper
//     (mapLonefyOptions) and its results become LANGUAGE-SCOPED writes, the
//     `"[css]": { "tidy.indent": 2 }` form (overrideInLanguage);
//   - `onSave` is RECOGNISED and reported but NEVER MAPPED and NEVER PROPOSED:
//     `true` is the incumbent's own default, so its presence says nothing about
//     what the user chose (product owner's decision, v0.5.0);
//   - top-level FLAT keys are mapped only for a `.jsbeautifyrc` (other beautify
//     extensions read flat keys there); in a `formatter.json` the incumbent
//     ignores them, so they are reported as not carried over instead of being
//     turned into a preference the user never had;
//   - every key nobody maps is REPORTED, never dropped silently.
//
// PURE: no 'vscode', no I/O, never throws. Immutable: the parsed input is only
// read, and fresh result objects are returned. The text is parsed as DATA
// (jsonc-parser) and NEVER executed: the incumbent loads its file with
// `require`, Tidy must not.
import type { LangId } from '../types';
import type { LonefyConfigMapping, MigrationWrite } from './types';
import {
  describeValue,
  hasForeignPrototype,
  mapLonefyOptions,
  parseConfigText
} from './lonefyOptions';

/** The key the incumbent reads for "format on save". Recognised, never mapped. */
export const LONEFY_ON_SAVE_KEY = 'onSave';

/**
 * Per-language sections of the incumbent's file, and the Tidy language(s) whose
 * `[language]` block each one feeds. Data, not code: widening a section to more
 * languages is a one-line change here (the incumbent also applied `css` to scss
 * and `javascript` to json; v0.5.0 deliberately keeps the three named targets).
 */
export const LONEFY_SECTION_LANGUAGES: Readonly<
  Record<string, readonly LangId[]>
> = {
  javascript: ['javascript'],
  css: ['css'],
  html: ['html']
};

/** Options of {@link mapLonefyConfigText} / {@link mapLonefyConfig}. */
export interface LonefyConfigOptions {
  /**
   * Name of the file, used in messages (e.g. '.vscode/formatter.json'), so a
   * warning always says WHICH file was the problem.
   */
  readonly label: string;
  /**
   * Whether top-level FLAT js-beautify keys are mapped to plain `tidy.*` settings.
   * True only for a `.jsbeautifyrc`; false for the incumbent's `formatter.json`,
   * which ignores top-level flat keys.
   */
  readonly allowFlatKeys: boolean;
}

/** Own-property test that cannot be fooled by `__proto__` / inherited keys. */
function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** An empty, unusable mapping carrying one explanatory warning. */
function unusableMapping(warning: string): LonefyConfigMapping {
  return {
    writes: [],
    unmapped: [],
    warnings: [warning],
    onSaveSeen: false,
    unusable: true
  };
}

/**
 * Map ONE per-language section through the existing flat key mapper and re-key
 * the result as language-scoped writes for each target language of the section.
 * Unmapped keys and warnings come back prefixed with the section name.
 */
function mapSection(
  section: string,
  value: unknown
): {
  writes: MigrationWrite[];
  unmapped: string[];
  warnings: string[];
} {
  if (!isPlainObject(value)) {
    return {
      writes: [],
      unmapped: [],
      warnings: [
        `${section}: expected an object of options but received ${describeValue(value)}; nothing was mapped.`
      ]
    };
  }

  const mapped = mapLonefyOptions(value);
  const languages = LONEFY_SECTION_LANGUAGES[section] ?? [];
  const writes: MigrationWrite[] = [];
  for (const language of languages) {
    for (const key of Object.keys(mapped.settings)) {
      writes.push({ key, language, value: mapped.settings[key] });
    }
  }
  return {
    writes,
    unmapped: mapped.unmapped.map((key) => `${section}.${key}`),
    warnings: mapped.warnings.map((warning) => `${section}.${warning}`)
  };
}

/**
 * Map an already-parsed lonefy-style config value to Tidy writes.
 *
 * Accepts ANYTHING (unknown) and validates it as a system boundary: a non-object
 * yields an unusable, empty mapping plus one warning and never throws. The input
 * is never mutated.
 */
export function mapLonefyConfig(
  raw: unknown,
  options: LonefyConfigOptions
): LonefyConfigMapping {
  if (!isPlainObject(raw)) {
    return unusableMapping(
      `${options.label}: expected a JSON object at the top level but received ${describeValue(raw)}; nothing was mapped.`
    );
  }

  const onSaveSeen = hasOwn(raw, LONEFY_ON_SAVE_KEY);
  // A null-prototype bag: a hostile `__proto__` key becomes an ordinary own key
  // (and is reported as not carried over) instead of rewiring the bag's prototype.
  const flat: Record<string, unknown> = Object.create(null);
  const unmapped: string[] = [];
  for (const key of Object.keys(raw)) {
    if (key === LONEFY_ON_SAVE_KEY || hasOwn(LONEFY_SECTION_LANGUAGES, key)) {
      continue;
    }
    if (options.allowFlatKeys) {
      flat[key] = raw[key];
    } else {
      unmapped.push(key);
    }
  }

  if (hasForeignPrototype(raw)) {
    unmapped.push('__proto__'); // a key the parser turned into a prototype swap.
  }

  const writes: MigrationWrite[] = [];
  const warnings: string[] = [];

  if (options.allowFlatKeys) {
    const mapped = mapLonefyOptions(flat);
    for (const key of Object.keys(mapped.settings)) {
      writes.push({ key, value: mapped.settings[key] });
    }
    unmapped.push(...mapped.unmapped);
    warnings.push(...mapped.warnings);
  }

  // Sections in a CANONICAL order (not file order) so the recap is stable.
  for (const section of Object.keys(LONEFY_SECTION_LANGUAGES)) {
    if (!hasOwn(raw, section)) {
      continue;
    }
    const mapped = mapSection(section, raw[section]);
    writes.push(...mapped.writes);
    unmapped.push(...mapped.unmapped);
    warnings.push(...mapped.warnings);
  }

  return { writes, unmapped, warnings, onSaveSeen, unusable: false };
}

/**
 * Parse a config file's text (as DATA, comments and trailing commas tolerated)
 * and map it in one step. Never throws: a malformed file becomes an unusable,
 * empty mapping whose warning names the file, so NOTHING is ever written from it.
 */
export function mapLonefyConfigText(
  text: unknown,
  options: LonefyConfigOptions
): LonefyConfigMapping {
  const parsed = parseConfigText(text, options.label);
  if (!parsed.ok) {
    return unusableMapping(parsed.warning);
  }
  return mapLonefyConfig(parsed.value, options);
}
