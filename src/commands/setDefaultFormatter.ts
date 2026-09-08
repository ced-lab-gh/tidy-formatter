// Shared core: write Tidy as the per-language `editor.defaultFormatter`.
//
// Factored out of commands/useAsFormatter.ts (Axe 1 / 1.T2) so the migration
// flow (Axe 1 / 1.T4, src/migration/runMigration.ts) can perform the EXACT same
// write through one code path : no duplicated `update('defaultFormatter', …)`.
//
// ANTI-HIJACK (ARCH-02, SPEC §5/§12) : NON-NEGOTIABLE:
//   - This helper writes ONLY `editor.defaultFormatter` (overrideInLanguage) for
//     the explicit languages a caller passes. It NEVER writes
//     `editor.formatOnSave` and NEVER writes anything for a language the caller
//     did not list. Callers MUST only call it in response to an explicit user
//     action, never at boot. Since v0.4.0 the ONE product caller
//     (commands/useAsFormatter.ts) additionally shows a modal recap listing the
//     exact keys, values and scope, and calls this helper ONLY after the user
//     confirms it : cancelling that recap calls nothing here at all.
//
// HOST-ONLY: the value-producing surface ('vscode', the provider's language
// list) is required lazily INSIDE the functions so the PURE planner in
// useAsFormatter.ts can still be imported by a mocha+tsx unit test without
// pulling in 'vscode'. This module is exercised by the integration suite.
import type { LangId } from '../types';

/**
 * Marketplace identifier (publisher.name) written into `editor.defaultFormatter`.
 * Single source of truth, re-exported by callers that need the same constant.
 */
export const EXTENSION_ID = 'ced-lab.tidy-formatter';

/** Where the per-language `editor.defaultFormatter` override is written. */
export type WriteTarget = 'workspace' | 'global';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */

/**
 * Resolve the VS Code ConfigurationTarget enum value for a WriteTarget, reading
 * it from the lazily-required 'vscode' module so this file never imports it at
 * top level.
 */
export function toConfigurationTarget(vscode: any, target: WriteTarget): unknown {
  return target === 'workspace'
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
}

/**
 * Read the CURRENT language-scoped `editor.defaultFormatter` value at the given
 * scope for each language: the EXACT form our overrideInLanguage write targets.
 *
 * Deliberately mirrors `readCurrentFormatOnSaveValues` in formatOnSaveOptIn.ts,
 * so the two consent paths inspect prior state through the same shape. The
 * caller uses it to build the pre-write recap ("this replaces X"), which is why
 * it does NOT swallow errors: a recap built on unreadable state would be a
 * guess, and this flow must fail closed (no read, no confirmation, no write).
 *
 * A non-string value (a corrupted settings entry) is normalised to undefined:
 * the recap then simply reports no current value rather than rendering junk.
 */
export function readCurrentDefaultFormatterValues(
  vscode: any,
  langs: readonly LangId[],
  target: WriteTarget
): Map<LangId, string | undefined> {
  const values = new Map<LangId, string | undefined>();
  for (const lang of langs) {
    const info = vscode.workspace
      .getConfiguration('editor', { languageId: lang })
      .inspect('defaultFormatter');
    const raw =
      target === 'workspace'
        ? info?.workspaceLanguageValue
        : info?.globalLanguageValue;
    values.set(lang, typeof raw === 'string' ? raw : undefined);
  }
  return values;
}

/**
 * Write Tidy as the per-language `editor.defaultFormatter` for each given
 * language at the resolved scope, using overrideInLanguage (the language-scoped
 * form). Sets ONLY defaultFormatter : never formatOnSave.
 *
 * The caller is responsible for having obtained explicit user consent and for
 * passing a validated, de-duplicated language list. An empty list is a no-op.
 *
 * @param vscode the lazily-required 'vscode' module.
 * @param langs  the languages to override (already validated by the caller).
 * @param target the scope to write at.
 */
export async function setDefaultFormatterForLangs(
  vscode: any,
  langs: readonly LangId[],
  target: WriteTarget
): Promise<void> {
  const configurationTarget = toConfigurationTarget(vscode, target);
  for (const lang of langs) {
    await vscode.workspace
      .getConfiguration('editor', { languageId: lang })
      .update('defaultFormatter', EXTENSION_ID, configurationTarget, true);
  }
}
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */
