// Detect the abandoned incumbent (lonefy.vscode-JS-CSS-HTML-formatter) and
// decide whether to surface the one-shot migration notification (Axe 1 / 1.T4).
//
// ANTI-HIJACK (ARCH-01/02, SPEC §5/§10/§12) — NON-NEGOTIABLE:
//   - This module only DECIDES whether to *offer* a migration. It writes no
//     setting, reads no `.jsbeautifyrc`, and triggers no formatting.
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
 * Whether the abandoned incumbent is installed in the current VS Code instance.
 * Thin host-only wrapper around `vscode.extensions.getExtension` so the pure
 * predicate above stays free of 'vscode'. Returns false if the API is somehow
 * unavailable rather than throwing (defensive: detection must never break boot).
 */
export function isLonefyInstalled(): boolean {
  try {
    const vscode = require('vscode');
    return vscode.extensions.getExtension(LONEFY_EXTENSION_ID) !== undefined;
  } catch {
    return false;
  }
}
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */
