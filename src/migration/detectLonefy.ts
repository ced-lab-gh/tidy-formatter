// Detect the abandoned incumbent (lonefy.vscode-JS-CSS-HTML-formatter) and
// decide whether to surface the one-shot migration notification (Axe 1 / 1.T4).
//
// ANTI-HIJACK (ARCH-01/02, SPEC §5/§10/§12) : NON-NEGOTIABLE:
//   - This module only DECIDES whether to *offer* a migration. It writes no
//     setting, reads no config file, and triggers no formatting.
//   - The notification is ONE-SHOT and deduplicated: once the user has been
//     prompted (or chose "Don't ask again"), `shouldPromptMigration` returns
//     false forever. The #1 complaint about the incumbent was intrusion, so the
//     nag must never repeat.
//
// SPLIT OF CONCERNS: `shouldPromptMigration` is a PURE boolean predicate with no
// 'vscode' import, so the dedup logic is unit-testable under mocha+tsx. The thin
// `isLonefyInstalled` wrapper loads 'vscode' lazily and runs only in the host.

/**
 * Marketplace identifier of the abandoned incumbent this extension replaces.
 * Used both to detect its presence and to deep-link the Extensions view.
 */
export const LONEFY_EXTENSION_ID = 'lonefy.vscode-JS-CSS-HTML-formatter';

/**
 * The `context.globalState` key under which we record that the migration prompt
 * has already been shown / dismissed. Stored once and never cleared, so the
 * notification appears at most once per machine+profile (ROADMAP 1.T4).
 */
export const MIGRATION_PROMPTED_KEY = 'tidy.migration.lonefyPrompted';

/**
 * PURE decision: should we show the one-shot migration prompt?
 *
 * True only when the incumbent IS installed AND we have NOT prompted before.
 * This is the single gate the host activation path consults; keeping it pure
 * (no 'vscode', no I/O, no throw) makes the dedup contract directly testable.
 *
 * @param extensionPresent whether lonefy is installed (from isLonefyInstalled).
 * @param alreadyPrompted  the persisted globalState flag (defaults to false when
 *                         the key was never written).
 */
export function shouldPromptMigration(
  extensionPresent: boolean,
  alreadyPrompted: boolean
): boolean {
  return extensionPresent && !alreadyPrompted;
}

/* -------------------------------------------------------------------------- */
/* VS Code wrapper (loads 'vscode' lazily; runs only in the extension host)      */
/* -------------------------------------------------------------------------- */
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */

/**
 * Whether the incumbent is present in the GIVEN `vscode` module's extension list.
 * `vscode` is a parameter (the idiom of setDefaultFormatter.ts) so the migration
 * flow can be driven by a mock in a unit test. Returns false if the API is
 * unavailable rather than throwing.
 *
 * KNOWN LIMIT (probe P4, LOW-13): `getExtension` cannot see a DISABLED extension,
 * so this is `false` for an incumbent that is installed but disabled. That is why
 * the MIGRATION reads the incumbent's CONFIG FILE (which outlives the extension)
 * instead of keying on this, and why the "disable it in the Extensions view"
 * advice is only shown when this is true: a disabled incumbent formats nothing.
 */
export function isLonefyPresentIn(vscode: any): boolean {
  try {
    return vscode.extensions.getExtension(LONEFY_EXTENSION_ID) !== undefined;
  } catch {
    return false;
  }
}

/**
 * Whether the abandoned incumbent is installed AND enabled in the current VS Code
 * instance. Thin host-only wrapper so the pure predicate above stays free of
 * 'vscode'. Returns false if the API is somehow unavailable rather than throwing
 * (defensive: detection must never break boot).
 */
export function isLonefyInstalled(): boolean {
  try {
    return isLonefyPresentIn(require('vscode'));
  } catch {
    return false;
  }
}
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */
