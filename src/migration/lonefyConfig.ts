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
//     `"[css]": { "tidy.indent": 2 }` form (overrideInLanguage), for the languages
//     the incumbent applied that section to (lonefySections.ts: `css` also formats
//     SCSS, `javascript` also formats JSON) and only where the setting really
//     applies in Tidy (tidyApplicability.ts);
//   - a key the incumbent's own js-beautify ignores in that section is REPORTED,
//     not imported: importing it would add a behaviour the user never had;
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
import type { LonefyConfigMapping, MigrationWrite } from './types';
import { isMappedKey, lonefyKeyOfTidy } from './lonefyKeys';
import {
  describeValue,
  hasForeignPrototype,
  mapLonefyOptions,
  parseConfigText
} from './lonefyOptions';
import { LONEFY_SECTIONS, isLonefySection } from './lonefySections';
import { tidySettingAppliesTo } from './tidyApplicability';

/** The key the incumbent reads for "format on save". Recognised, never mapped. */
export const LONEFY_ON_SAVE_KEY = 'onSave';

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

/** A copy of a section without some keys, on a null-prototype bag. */
function withoutKeys(
  source: Record<string, unknown>,
  dropped: ReadonlySet<string>
): Record<string, unknown> {
  const copy: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(source)) {
    if (!dropped.has(key)) {
      copy[key] = source[key];
    }
  }
  return copy;
}

/**
 * Map ONE per-language section through the existing flat key mapper and re-key the
 * result as language-scoped writes.
 *
 * Three filters stand between a key and a write, each one reported, none silent:
 *   1. the key must be one the incumbent's js-beautify READS in this section
 *      (lonefySections.ts), or it did nothing there;
 *   2. the mapper must accept its value (same domain as the `tidy.*` setting);
 *   3. per target language, the setting must really apply there (tidyApplicability.ts).
 *      A key that applies to NONE of the section's languages is reported; one that
 *      applies to some is written for those and is not a "loss" for the others.
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

  const { languages, honoured } = LONEFY_SECTIONS[section];
  const ignoredByIncumbent = new Set(
    Object.keys(value).filter((key) => isMappedKey(key) && !honoured.has(key))
  );
  const mapped = mapLonefyOptions(withoutKeys(value, ignoredByIncumbent), {
    stringBooleans: false
  });

  const writes: MigrationWrite[] = [];
  for (const language of languages) {
    for (const key of Object.keys(mapped.settings)) {
      if (tidySettingAppliesTo(key, language)) {
        writes.push({ key, language, value: mapped.settings[key] });
      }
    }
  }
  const appliesSomewhere = (key: string) =>
    languages.some((language) => tidySettingAppliesTo(key, language));
  const appliesNowhere = new Set(
    Object.keys(mapped.settings)
      .filter((key) => !appliesSomewhere(key))
      .map((key) => lonefyKeyOfTidy(key))
  );

  // Not carried over, in FILE order: keys nobody maps, keys the incumbent ignored
  // here, and keys Tidy has no language to apply to.
  const reported = new Set<string>([...mapped.unmapped, ...ignoredByIncumbent]);
  const unmapped = [
    ...Object.keys(value).filter(
      (key) => reported.has(key) || appliesNowhere.has(key)
    ),
    ...(hasForeignPrototype(value) ? ['__proto__'] : [])
  ].map((key) => `${section}.${key}`);

  return {
    writes,
    unmapped,
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
    if (key === LONEFY_ON_SAVE_KEY || isLonefySection(key)) {
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
  for (const section of Object.keys(LONEFY_SECTIONS)) {
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
