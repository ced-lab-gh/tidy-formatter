// Migration flow: import a legacy lonefy `.jsbeautifyrc` into Tidy settings, and
// optionally make Tidy the default formatter — ONLY after explicit confirmation
// (Axe 1 / 1.T4).
//
// ANTI-HIJACK (ARCH-01/02, SPEC §5/§10/§12) — NON-NEGOTIABLE:
//   - NOTHING is written before the user confirms a recap of exactly what will
//     change. Cancelling at any step writes zero settings.
//   - We write the mapped `tidy.*` settings and (if the user opts in) Tidy's
//     per-language `editor.defaultFormatter` via the shared core — and NOTHING
//     ELSE. We NEVER write `editor.formatOnSave`.
//   - `.jsbeautifyrc` is read best-effort and ONLY when the workspace is trusted
//     (Workspace Trust gate, mirroring vscodeConfig.shouldReadEditorConfig). In
//     Restricted Mode the file is not read.
//   - We cannot disable lonefy via any API; we only GUIDE the user to the
//     Extensions view (a button that reveals it). We never claim to have
//     disabled it.
//
// SPLIT OF CONCERNS: the recap text and the "what would be written" plan are
// PURE (no 'vscode'), so they are unit-testable. The host flow (reading files,
// QuickPick/dialog, writing config) loads 'vscode' lazily and is exercised by
// the integration suite.
import type { LonefyMappingResult } from './types';
import { mapLonefyRcText } from './lonefyOptions';
import { LONEFY_EXTENSION_ID } from './detectLonefy';

/** Command id (registered by extension.ts; this module owns only the constant). */
export const RUN_MIGRATION_COMMAND_ID = 'tidy.runMigration';

/** Conventional filename of the legacy js-beautify config the incumbent read. */
export const JSBEAUTIFYRC_FILENAME = '.jsbeautifyrc';

/**
 * A pure description of what a migration WOULD write, assembled from the mapper
 * result. No 'vscode' types leak here so it can be built and asserted in a unit
 * test. The host turns this into a recap string and, on confirmation, the writes.
 */
export interface MigrationRecap {
  /** Whether a `.jsbeautifyrc` was found and parsed (false => settings empty). */
  rcFound: boolean;
  /** The validated `tidy.*` settings that would be written (may be empty). */
  settings: Record<string, unknown>;
  /** Legacy keys with no Tidy counterpart, surfaced verbatim. */
  unmapped: string[];
  /** Notes about out-of-domain values that were dropped. */
  warnings: string[];
}

/**
 * Build a {@link MigrationRecap} from a mapper result. PURE.
 *
 * @param rcFound whether a `.jsbeautifyrc` was actually located + parsed.
 * @param mapping the result of mapLonefyRcText / mapLonefyOptions.
 */
export function buildMigrationRecap(
  rcFound: boolean,
  mapping: LonefyMappingResult
): MigrationRecap {
  return {
    rcFound,
    settings: { ...mapping.settings },
    unmapped: [...mapping.unmapped],
    warnings: [...mapping.warnings]
  };
}

/**
 * Whether a recap has any concrete setting to write. PURE. Used by the host to
 * decide whether the "import settings" branch is even worth confirming.
 */
export function hasSettingsToWrite(recap: MigrationRecap): boolean {
  return Object.keys(recap.settings).length > 0;
}

/**
 * Render a human-readable, non-technical recap of what the migration will do.
 * PURE (returns a plain string), so the exact wording is unit-testable and can
 * be shown in a modal/detail dialog by the host.
 *
 * The text is explicit that NOTHING is written yet and that lonefy must be
 * disabled by the user (we only guide).
 */
export function formatRecapMessage(recap: MigrationRecap): string {
  const lines: string[] = [];

  if (!recap.rcFound) {
    lines.push(
      'No .jsbeautifyrc was found in this workspace, so there are no legacy ' +
        'options to import. You can still make Tidy your default formatter.'
    );
  } else if (hasSettingsToWrite(recap)) {
    lines.push('Tidy would import these settings from your .jsbeautifyrc:');
    for (const key of Object.keys(recap.settings)) {
      lines.push(`  • ${key} = ${JSON.stringify(recap.settings[key])}`);
    }
  } else {
    lines.push(
      'A .jsbeautifyrc was found but none of its options map to a Tidy ' +
        'setting, so nothing would be imported.'
    );
  }

  if (recap.unmapped.length > 0) {
    lines.push(
      `Not carried over (no Tidy equivalent): ${recap.unmapped.join(', ')}.`
    );
  }
  if (recap.warnings.length > 0) {
    lines.push('Notes:');
    for (const w of recap.warnings) {
      lines.push(`  • ${w}`);
    }
  }

  lines.push('');
  lines.push(
    'Nothing has been changed yet. Tidy will only write these settings if you ' +
      'confirm, and it will never enable Format On Save or disable any other ' +
      'extension for you.'
  );

  return lines.join('\n');
}

/* -------------------------------------------------------------------------- */
/* VS Code flow (loads 'vscode' lazily; runs only in the extension host)         */
/* -------------------------------------------------------------------------- */
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */

/** Action labels (kept as constants so the .then() comparisons can't drift). */
const ACTION_CONFIRM_IMPORT = 'Import settings';
const ACTION_SKIP_IMPORT = 'Skip import';
const ACTION_OPEN_EXTENSIONS = 'Open Extensions view';
const ACTION_CANCEL = 'Cancel';

/**
 * Whether the workspace is trusted enough to read a workspace-authored
 * `.jsbeautifyrc`. Mirrors vscodeConfig.shouldReadEditorConfig: in Restricted
 * Mode we do NOT read workspace content.
 */
function isWorkspaceTrusted(vscode: any): boolean {
  return vscode.workspace.isTrusted !== false;
}

/**
 * Best-effort read of the first `.jsbeautifyrc` found at a workspace folder root.
 * Returns the file text, or undefined if none was found / unreadable / gated off
 * by Workspace Trust. Never throws: a read failure becomes "no file".
 */
async function readJsbeautifyrc(vscode: any): Promise<string | undefined> {
  if (!isWorkspaceTrusted(vscode)) {
    return undefined; // Restricted Mode: do not read workspace content.
  }
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }
  for (const folder of folders) {
    const uri = vscode.Uri.joinPath(folder.uri, JSBEAUTIFYRC_FILENAME);
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      return Buffer.from(bytes).toString('utf8');
    } catch {
      // Not present in this folder (or unreadable) — try the next one.
      continue;
    }
  }
  return undefined;
}

/**
 * Reveal the abandoned incumbent in the Extensions view so the user can disable
 * or uninstall it themselves. We GUIDE only — VS Code has no API to disable
 * another extension and Tidy never pretends it did.
 */
function openLonefyInExtensionsView(vscode: any): void {
  void vscode.commands.executeCommand(
    'workbench.extensions.search',
    `@id:${LONEFY_EXTENSION_ID}`
  );
}

/**
 * Write the mapped `tidy.*` settings at the chosen scope. Each key is a real
 * `tidy.*` id and each value has already been validated by the pure mapper. We
 * write under the 'tidy' section (stripping the 'tidy.' prefix, the form
 * getConfiguration expects). Never writes anything outside the recap.
 */
async function writeMappedSettings(
  vscode: any,
  settings: Record<string, unknown>,
  configurationTarget: unknown
): Promise<void> {
  const config = vscode.workspace.getConfiguration('tidy');
  for (const fullKey of Object.keys(settings)) {
    const suffix = fullKey.startsWith('tidy.')
      ? fullKey.slice('tidy.'.length)
      : fullKey;
    await config.update(suffix, settings[fullKey], configurationTarget);
  }
}

/**
 * Offer to make Tidy the default formatter as part of migration, reusing the
 * SAME command the standalone "Use Tidy as my formatter" runs — so there is one
 * confirmed, anti-hijack-safe code path for that write. Returns nothing; the
 * command itself drives its own QuickPick + confirmation.
 */
async function offerUseAsFormatter(vscode: any): Promise<void> {
  const useAsFormatter = 'Set Tidy as my formatter…';
  const notNow = 'Not now';
  const choice = await vscode.window.showInformationMessage(
    'Do you also want to make Tidy your default formatter for some languages? ' +
      'You can pick which ones next; nothing changes until you confirm there.',
    useAsFormatter,
    notNow
  );
  if (choice === useAsFormatter) {
    // Defer entirely to the existing command (its own QuickPick + confirmation).
    await vscode.commands.executeCommand('tidy.useAsFormatter');
  }
}

/**
 * Handler for "Tidy: Migrate from JS-CSS-HTML Formatter".
 *
 * Flow (every write user-confirmed; any cancel = zero writes):
 *   1. best-effort read `.jsbeautifyrc` (Workspace Trust gated);
 *   2. map it via the pure mapper and build a recap;
 *   3. show the recap with an explicit confirm/cancel — NOTHING written yet;
 *   4. on confirm: write the mapped `tidy.*` settings at Workspace scope;
 *   5. offer (separately, opt-in) to set Tidy as the default formatter, which
 *      delegates to the existing confirmed command;
 *   6. always offer a button to open the Extensions view on lonefy (guide only).
 *
 * Never throws: any failure is surfaced as a non-blocking error.
 */
export async function runMigration(): Promise<void> {
  const vscode = require('vscode');

  let rcText: string | undefined;
  try {
    rcText = await readJsbeautifyrc(vscode);
  } catch {
    rcText = undefined; // belt-and-braces: reading must never break the flow.
  }

  const rcFound = rcText !== undefined;
  const mapping = rcFound
    ? mapLonefyRcText(rcText)
    : { settings: {}, unmapped: [], warnings: [] };
  const recap = buildMigrationRecap(rcFound, mapping);
  const recapMessage = formatRecapMessage(recap);

  if (hasSettingsToWrite(recap)) {
    // There is something concrete to import: ask for explicit confirmation,
    // showing the full recap as the modal detail. Cancel => write nothing.
    const choice = await vscode.window.showInformationMessage(
      'Import your JS-CSS-HTML Formatter settings into Tidy?',
      { modal: true, detail: recapMessage },
      ACTION_CONFIRM_IMPORT,
      ACTION_SKIP_IMPORT
    );

    if (choice === ACTION_CONFIRM_IMPORT) {
      try {
        await writeMappedSettings(
          vscode,
          recap.settings,
          vscode.ConfigurationTarget.Workspace
        );
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'unknown error';
        void vscode.window.showErrorMessage(
          `Tidy: could not import settings (${message}).`
        );
        return;
      }
      void vscode.window.showInformationMessage(
        'Tidy imported your legacy settings at workspace scope.'
      );
    } else if (choice !== ACTION_SKIP_IMPORT) {
      return; // dismissed/cancelled the modal — write nothing, stop.
    }
  } else {
    // Nothing to import (no file, or no mappable options): tell the user, no
    // confirmation needed because there is no write. Offer the guide actions.
    void vscode.window.showInformationMessage(recapMessage);
  }

  // Whether or not settings were imported, offer the (separately confirmed)
  // default-formatter setup and the guide to disable lonefy.
  await offerUseAsFormatter(vscode);

  const choice = await vscode.window.showInformationMessage(
    'Tidy cannot disable JS-CSS-HTML Formatter for you, but you can do it in ' +
      'the Extensions view. While it stays enabled it may keep formatting on save.',
    ACTION_OPEN_EXTENSIONS,
    ACTION_CANCEL
  );
  if (choice === ACTION_OPEN_EXTENSIONS) {
    openLonefyInExtensionsView(vscode);
  }
}

/**
 * One-shot migration notification shown at activation when lonefy is installed
 * and we have not prompted before. NON-MODAL, deduplicated by the caller via
 * globalState. Offers: run the migration now, do it later (the command stays in
 * the palette), or "Don't ask again" (records the dedup flag so it never repeats).
 *
 * Writes NOTHING itself — the actual migration writes happen only inside
 * runMigration after its own confirmation. Returns true when the caller should
 * persist the "prompted" flag (i.e. the prompt was shown and the user engaged,
 * or chose "Don't ask again"): we always set it after showing, so the nag is
 * one-shot regardless of the answer.
 *
 * @param markPrompted callback the caller wires to globalState.update(key,true).
 */
export async function showMigrationNotification(
  markPrompted: () => Thenable<void> | void
): Promise<void> {
  const vscode = require('vscode');

  const runNow = 'Migrate now';
  const dontAsk = "Don't ask again";

  // Record the dedup flag immediately so the notification is one-shot even if
  // the user ignores it (closes it without choosing). This is the anti-nag
  // contract: shown at most once, ever.
  await markPrompted();

  const choice = await vscode.window.showInformationMessage(
    'JS-CSS-HTML Formatter is installed. Tidy is a safer, maintained ' +
      'replacement — migrate your settings and switch over?',
    runNow,
    dontAsk
  );

  if (choice === runNow) {
    await vscode.commands.executeCommand(RUN_MIGRATION_COMMAND_ID);
  }
  // "Don't ask again" (and dismissal) need no extra work: the flag is already set.
}
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */
