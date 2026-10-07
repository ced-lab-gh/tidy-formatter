// Shared contracts for the lonefy -> Tidy migration layer (ROADMAP Axe 1, 1.T1;
// reshaped in v0.5.0 to read the files the incumbent REALLY reads).
//
// PURE: this file may import TYPES only, never 'vscode'. It describes the data
// shapes the pure mappers (src/migration/lonefyOptions.ts, lonefyConfig.ts)
// produce and consume, so it stays unit-testable under mocha + tsx outside the
// Electron host.
//
// WHAT THE INCUMBENT REALLY READS (probe P3(a), _internal/audit-v050/09-sondes-
// hote.md section 1): a workspace-local `.vscode/formatter.json` in the FIRST
// workspace folder, and a global `formatter.json` inside its OWN extension
// install folder. It never reads `.jsbeautifyrc`. Both files carry an `onSave`
// key plus per-language sections `javascript`, `css`, `html`.
import type { LangId } from '../types';

/**
 * Result of mapping a raw FLAT js-beautify options object (the shape of a
 * `.jsbeautifyrc`, and of ONE section of a lonefy `formatter.json`) to Tidy.
 *
 * - `settings`: the canonical `tidy.*` settings to offer for writing. Every key
 *   is a real `tidy.*` configuration id from package.json and every value has
 *   already been validated against that setting's domain (enum / range / type).
 *   The map is a fresh object; the input is never mutated.
 * - `unmapped`: source keys this import does not carry over, surfaced verbatim so
 *   the migration UI can report "we did not carry these over".
 * - `warnings`: human-readable notes about recognised keys whose value was out of
 *   domain (and therefore dropped) or about a malformed input as a whole.
 *
 * Invariant: a key never appears in both `settings` and `warnings` as "applied";
 * an out-of-domain recognised key contributes a warning and is NOT written.
 */
export interface LonefyMappingResult {
  settings: Record<string, unknown>;
  unmapped: string[];
  warnings: string[];
}

/** Which file the migrated settings were read from (first found wins). */
export type MigrationSourceKind =
  /** `<first workspace folder>/.vscode/formatter.json`: the incumbent's local config. */
  | 'workspace-formatter-json'
  /** `formatter.json` in the incumbent's install folder: its global config. */
  | 'global-formatter-json'
  /** `<workspace folder>/.jsbeautifyrc`: read by OTHER beautify extensions, not by the incumbent. */
  | 'jsbeautifyrc';

/**
 * One `tidy.*` setting the migration would write. With `language` set the write
 * is the language-scoped form (`"[css]": { "tidy.indent": 2 }`, i.e.
 * overrideInLanguage); without it, a plain `tidy.*` setting.
 */
export interface MigrationWrite {
  /** Full setting id, always `tidy.*` (e.g. 'tidy.indent'). */
  readonly key: string;
  /** The language whose `[language]` block receives the value, if scoped. */
  readonly language?: LangId;
  /** The validated value (already in the setting's domain). */
  readonly value: unknown;
}

/**
 * Result of mapping a whole lonefy-style config file (flat keys, per-language
 * sections and `onSave`) to Tidy writes. Pure data, never contains a thrown error.
 */
export interface LonefyConfigMapping {
  /** Settings that would be written, in a stable order. */
  readonly writes: readonly MigrationWrite[];
  /** Keys this import did not carry over (section keys are `section.key`). */
  readonly unmapped: readonly string[];
  /** Notes about dropped values or an unusable file. */
  readonly warnings: readonly string[];
  /**
   * `onSave` was present. It is RECOGNISED and REPORTED but never mapped and never
   * proposed: `true` is the incumbent's own default, so its presence says nothing
   * about what the user chose (product owner's decision, v0.5.0).
   */
  readonly onSaveSeen: boolean;
  /**
   * The file as a whole could not be used (not parseable, or not a JSON object).
   * Nothing is written from it, and the recap says so instead of claiming that
   * "no option maps".
   */
  readonly unusable: boolean;
}
