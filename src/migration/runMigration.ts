// Migration flow: import the incumbent's REAL settings into Tidy, and optionally
// make Tidy the default formatter : ONLY after explicit confirmation (Axe 1 /
// 1.T4; rebuilt in v0.5.0 to read the files the incumbent really reads).
//
// WHAT IS IMPORTED FROM (first found wins; the recap names the one used):
//   (a) `.vscode/formatter.json` in the first workspace folder,
//   (b) the global `formatter.json` in the incumbent's install folder (only while
//       it is installed and enabled),
//   (c) `.jsbeautifyrc` at a workspace root (other beautify extensions read it; the
//       incumbent never did).
// Per-language sections (`javascript`, `css`, `html`) become language-scoped
// overrides of the matching `tidy.*` settings ("[css]": { "tidy.indent": 2 }).
// See lonefySources.ts for the reads and lonefyConfig.ts for the mapping.
//
// ANTI-HIJACK (ARCH-01/02, SPEC §5/§10/§12) : NON-NEGOTIABLE:
//   - NOTHING is written before the user confirms a recap of exactly what will
//     change (every key and value, and the scope). Cancelling writes zero settings.
//   - The confirmed batch is all or nothing: a failure part-way through restores
//     what was already written (applyWrites.ts, the shared rollback mechanism) and
//     names any key it could not restore.
//   - We write the mapped `tidy.*` settings and (if the user opts in) Tidy's
//     per-language `editor.defaultFormatter` via the shared core : and NOTHING
//     ELSE. This import NEVER writes `editor.formatOnSave`. The incumbent's `onSave`
//     key is recognised and reported as "not migrated", and is never proposed by
//     this flow (true is the incumbent's own default, so it says nothing about what
//     the user chose).
//   - Every file is read ONLY when the workspace is trusted (Workspace Trust gate,
//     mirroring vscodeConfig.shouldReadEditorConfig), locally, read-only, and
//     parsed as DATA: never `require`d, never evaluated.
//   - We cannot disable the incumbent via any API; we only GUIDE the user to the
//     Extensions view (a button that reveals it), and only when it is installed
//     and enabled. We never claim to have disabled it.
//
// SPLIT OF CONCERNS: the recap text and the "what would be written" plan are PURE
// (recap.ts, no 'vscode'). This module is the host flow: it takes `vscode` as a
// parameter (`runMigrationWith`), so it is exercised by mock-driven unit tests as
// well as by the integration suite; `runMigration` is the thin command handler
// that loads 'vscode' lazily.
import { sanitizeDetail } from '../diagnostics/lastFormat';
import { applyMigrationWrites } from './applyWrites';
import { isLonefyPresentIn, LONEFY_EXTENSION_ID } from './detectLonefy';
import { readMigrationSource } from './lonefySources';
import {
  buildMigrationRecap,
  formatRecapMessage,
  hasSettingsToWrite,
  sourceFileNameOf,
  type MigrationRecap
} from './recap';
import { scopeLabelOf } from '../commands/formatOnSaveOptIn';

// Kept importable from here: the recap builders and the legacy filename moved to
// their own small modules, and existing importers keep this path.
export {
  buildMigrationRecap,
  formatRecapMessage,
  hasSettingsToWrite,
  type MigrationRecap
} from './recap';
export { JSBEAUTIFYRC_FILENAME } from './lonefySources';

/** Command id (registered by extension.ts; this module owns only the constant). */
export const RUN_MIGRATION_COMMAND_ID = 'tidy.runMigration';

/* -------------------------------------------------------------------------- */
/* VS Code flow (takes 'vscode' as a parameter; runs only in the extension host)  */
/* -------------------------------------------------------------------------- */
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */

/** Action labels (kept as constants so the comparisons can't drift). */
const ACTION_CONFIRM_IMPORT = 'Import settings';
const ACTION_SKIP_IMPORT = 'Skip import';
const ACTION_OPEN_EXTENSIONS = 'Open Extensions view';
const ACTION_CANCEL = 'Cancel';

/** Title of the modal confirmation, naming the file the settings come from. */
function confirmTitleOf(recap: MigrationRecap): string {
  return recap.source === 'jsbeautifyrc'
    ? 'Import your .jsbeautifyrc settings into Tidy?'
    : 'Import your JS-CSS-HTML Formatter settings into Tidy?';
}

/** The non-modal report shown after a confirmed write that fully succeeded. */
function importedMessageOf(recap: MigrationRecap, written: number): string {
  const noun = written === 1 ? 'setting' : 'settings';
  const from =
    recap.source === undefined ? '' : ` from ${sourceFileNameOf(recap.source)}`;
  return `Tidy imported ${written} ${noun}${from} at the ${scopeLabelOf(recap.target)} scope.`;
}

/**
 * Reveal the abandoned incumbent in the Extensions view so the user can disable
 * or uninstall it themselves. We GUIDE only : VS Code has no API to disable
 * another extension and Tidy never pretends it did.
 */
function openLonefyInExtensionsView(vscode: any): void {
  void vscode.commands.executeCommand(
    'workbench.extensions.search',
    `@id:${LONEFY_EXTENSION_ID}`
  );
}

/**
 * Offer to make Tidy the default formatter as part of migration, reusing the
 * SAME command the standalone "Use Tidy as my formatter" runs : so there is one
 * confirmed, anti-hijack-safe code path for that write. Returns nothing; the
 * command itself drives its own QuickPick + confirmation.
 *
 * The offer says that command asks about Format On Save on its own, so nothing in
 * this flow lets the user believe the two steps are one consent.
 */
async function offerUseAsFormatter(vscode: any): Promise<void> {
  const useAsFormatter = 'Set Tidy as my formatter…';
  const notNow = 'Not now';
  const choice = await vscode.window.showInformationMessage(
    'Do you also want to make Tidy your default formatter for some languages? ' +
      'You can pick which ones next. That step has its own confirmation, ' +
      'including a separate question about Format On Save, and nothing changes ' +
      'until you confirm there.',
    useAsFormatter,
    notNow
  );
  if (choice === useAsFormatter) {
    // Defer entirely to the existing command (its own QuickPick + confirmation).
    await vscode.commands.executeCommand('tidy.useAsFormatter');
  }
}

/**
 * Offer the "disable it in the Extensions view" guide. ONLY when the incumbent is
 * installed and enabled: otherwise there is nothing to disable and saying "it may
 * keep formatting on save" would be false (probe P3: it used to be shown even when
 * the incumbent was absent).
 */
async function offerDisableGuide(vscode: any): Promise<void> {
  if (!isLonefyPresentIn(vscode)) {
    return;
  }
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
 * The migration flow, with `vscode` injected.
 *
 * Flow (every write user-confirmed; any cancel = zero writes):
 *   1. read the first config file found, Workspace Trust gated (lonefySources.ts);
 *   2. map it as data and build the recap (recap.ts);
 *   3. show the recap as a MODAL with an explicit confirm/cancel : NOTHING written yet;
 *   4. on confirm: write the mapped `tidy.*` settings at the recap's scope, all or
 *      nothing (applyWrites.ts); a failure restores what was written and says so;
 *   5. offer (separately, opt-in) to set Tidy as the default formatter, which
 *      delegates to the existing confirmed command;
 *   6. offer a button to open the Extensions view on the incumbent, ONLY if it is
 *      installed and enabled (guide only).
 */
export async function runMigrationWith(vscode: any): Promise<void> {
  const read = await readMigrationSource(vscode);
  const recap = buildMigrationRecap(read);
  const recapMessage = formatRecapMessage(recap);

  if (hasSettingsToWrite(recap)) {
    // There is something concrete to import: ask for explicit confirmation,
    // showing the full recap as the modal detail. Cancel => write nothing.
    const choice = await vscode.window.showInformationMessage(
      confirmTitleOf(recap),
      { modal: true, detail: recapMessage },
      ACTION_CONFIRM_IMPORT,
      ACTION_SKIP_IMPORT
    );

    if (choice === ACTION_CONFIRM_IMPORT) {
      const result = await applyMigrationWrites(
        vscode,
        recap.writes,
        recap.target
      );
      if (!result.ok) {
        void vscode.window.showErrorMessage(
          `Tidy: could not import all settings (${result.detail}).`
        );
        return;
      }
      void vscode.window.showInformationMessage(
        importedMessageOf(recap, result.written)
      );
    } else if (choice !== ACTION_SKIP_IMPORT) {
      return; // dismissed/cancelled the modal : write nothing, stop.
    }
  } else {
    // Nothing to import (no file, or no mappable options): tell the user, no
    // confirmation needed because there is no write. Offer the guide actions.
    void vscode.window.showInformationMessage(recapMessage);
  }

  // Whether or not settings were imported, offer the (separately confirmed)
  // default-formatter setup and, when it applies, the guide to disable the incumbent.
  await offerUseAsFormatter(vscode);
  await offerDisableGuide(vscode);
}

/**
 * Handler for "Tidy: Migrate from JS-CSS-HTML Formatter". Loads 'vscode' lazily and
 * runs {@link runMigrationWith}. Never throws: an unexpected failure is surfaced as
 * a non-blocking error message.
 */
export async function runMigration(): Promise<void> {
  const vscode = require('vscode');
  try {
    await runMigrationWith(vscode);
  } catch (error: unknown) {
    const cause = error instanceof Error ? sanitizeDetail(error.message) : 'unknown error';
    void vscode.window.showErrorMessage(
      `Tidy: the migration stopped unexpectedly (${cause}).`
    );
  }
}

/**
 * One-shot migration notification shown at activation when lonefy is installed
 * and we have not prompted before. NON-MODAL, deduplicated by the caller via
 * globalState. Offers: run the migration now, do it later (the command stays in
 * the palette), or "Don't ask again" (records the dedup flag so it never repeats).
 *
 * Writes NOTHING itself : the actual migration writes happen only inside
 * runMigration after its own confirmation. The dedup flag is set the moment the
 * prompt is shown, so the nag is one-shot regardless of the answer.
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
      'replacement : migrate your settings and switch over?',
    runNow,
    dontAsk
  );

  if (choice === runNow) {
    await vscode.commands.executeCommand(RUN_MIGRATION_COMMAND_ID);
  }
  // "Don't ask again" (and dismissal) need no extra work: the flag is already set.
}
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */
