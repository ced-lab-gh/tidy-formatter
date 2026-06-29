// Shared contracts for the lonefy -> Tidy migration layer (ROADMAP Axe 1, 1.T1).
//
// PURE: this file MUST NOT import 'vscode'. It only describes the data shapes the
// pure mapper (src/migration/lonefyOptions.ts) produces and consumes, so it stays
// unit-testable under mocha + tsx outside the Electron host.
//
// The mapper turns a parsed `.jsbeautifyrc` (the legacy js-beautify config the
// abandoned incumbent read) into the subset of Tidy `tidy.*` settings that have a
// faithful, in-domain equivalent. Anything unknown or out of range is surfaced —
// never written — so an opt-in migration can preview exactly what it will apply
// before the user confirms (anti-hijack: no setting is ever derived silently).

/**
 * Result of mapping a raw lonefy/`.jsbeautifyrc` options object to Tidy.
 *
 * - `settings`: the canonical `tidy.*` settings to offer for writing. Every key
 *   is a real `tidy.*` configuration id from package.json and every value has
 *   already been validated against that setting's domain (enum / range / type).
 *   The map is a fresh object; the input is never mutated.
 * - `unmapped`: source keys with no Tidy counterpart, surfaced verbatim so the
 *   migration UI can report "we couldn't carry these over".
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
