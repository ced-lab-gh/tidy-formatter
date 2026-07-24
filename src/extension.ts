// Extension entry point.
// Registers the document + range formatting providers, the Show Effective
// Configuration command, the onboarding/migration commands (Axe 1), pushing
// every disposable into context.subscriptions.
//
// NON-NEGOTIABLE (ARCH-01/02, SPEC §5/§10/§12): we NEVER hook save/focus/change
// and NEVER contribute or auto-set a defaultFormatter or formatOnSave. The only
// settings Tidy ever writes happen inside the onboarding/migration commands and
// ONLY after explicit user confirmation. At activation we may show a single,
// non-modal, deduplicated migration notification when the abandoned incumbent is
// installed — it writes nothing on its own. VS Code core owns the save /
// format-on-save / cursor lifecycle.
import * as vscode from 'vscode';
import {
  SUPPORTED_LANGUAGES,
  TidyDocumentFormattingProvider,
  TidyRangeFormattingProvider
} from './providers/formattingProvider';
import {
  SHOW_CONFIG_COMMAND_ID,
  showEffectiveConfiguration
} from './commands/showConfig';
import {
  USE_AS_FORMATTER_COMMAND_ID,
  useAsFormatter
} from './commands/useAsFormatter';
import {
  RUN_MIGRATION_COMMAND_ID,
  runMigration,
  showMigrationNotification
} from './migration/runMigration';
import {
  isLonefyInstalled,
  shouldPromptMigration,
  MIGRATION_PROMPTED_KEY
} from './migration/detectLonefy';
import {
  PREVIEW_FORMAT_COMMAND_ID,
  previewFormat
} from './commands/previewFormat';
import {
  REPORT_ISSUE_COMMAND_ID,
  reportIssue
} from './commands/reportIssue';
import {
  EXPLAIN_LAST_FORMAT_COMMAND_ID,
  explainLastFormat
} from './commands/explainLastFormat';
import { getTidyOutputChannel } from './diagnostics/outputChannel';
import { detectCompetingFormatters } from './deference/detect';
import {
  decide,
  normalizeSetting,
  DEFERENCE_SETTING_KEY,
  DEFERENCE_PROMPTED_KEY
} from './deference/decide';

export function activate(context: vscode.ExtensionContext): void {
  const documentProvider = new TidyDocumentFormattingProvider();
  const rangeProvider = new TidyRangeFormattingProvider();

  for (const languageId of SUPPORTED_LANGUAGES) {
    const selector: vscode.DocumentSelector = { language: languageId, scheme: '*' };

    context.subscriptions.push(
      vscode.languages.registerDocumentFormattingEditProvider(
        selector,
        documentProvider
      )
    );
    context.subscriptions.push(
      vscode.languages.registerDocumentRangeFormattingEditProvider(
        selector,
        rangeProvider
      )
    );
  }

  context.subscriptions.push(
    vscode.commands.registerCommand(
      SHOW_CONFIG_COMMAND_ID,
      showEffectiveConfiguration
    )
  );

  // Onboarding (1.T2) + migration (1.T4) commands. Both write settings ONLY in
  // response to explicit user confirmation inside the handler; registering them
  // does nothing on its own.
  context.subscriptions.push(
    vscode.commands.registerCommand(USE_AS_FORMATTER_COMMAND_ID, useAsFormatter)
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(RUN_MIGRATION_COMMAND_ID, runMigration)
  );

  // Preview format (Axe 4.T6): a read-only diff of what Tidy WOULD do, with an
  // explicit single-undo "Apply". Registering it writes nothing; it acts only on
  // an explicit command invocation + explicit "Apply" click.
  context.subscriptions.push(
    vscode.commands.registerCommand(PREVIEW_FORMAT_COMMAND_ID, previewFormat)
  );

  // Report an Issue: opens a prefilled GitHub issue with environment details.
  // Read-only — it opens an external URL and writes nothing (no setting, no file).
  context.subscriptions.push(
    vscode.commands.registerCommand(REPORT_ISSUE_COMMAND_ID, reportIssue)
  );

  // Explain last format (v0.2.0): reports what the most recent format attempt did,
  // or why it did nothing (guard, ignore, size, another default formatter...).
  // Read-only. Owns disposal of the shared "Tidy Formatter" output channel.
  context.subscriptions.push(getTidyOutputChannel());
  context.subscriptions.push(
    vscode.commands.registerCommand(
      EXPLAIN_LAST_FORMAT_COMMAND_ID,
      explainLastFormat
    )
  );

  // One-shot, deduplicated migration prompt (1.T4). Fire-and-forget so it never
  // blocks activation; it writes nothing before the user confirms inside the
  // migration command. Shown at most once per machine+profile via globalState.
  void maybePromptMigration(context);

  // One-shot, deduplicated deference notification (Axe 4.T5). Fire-and-forget so
  // it never blocks activation. It only ever SURFACES that another formatter is
  // configured — it never disables Tidy, never touches editor.defaultFormatter,
  // and writes no setting on its own (anti-hijack). Uses a globalState key
  // DISTINCT from the migration prompt so the two never collide.
  void maybeSurfaceDeference(context);
}

/**
 * Decide and (at most once) show the migration notification. Pure decision via
 * `shouldPromptMigration`; the persisted flag lives in globalState so the nag is
 * never repeated. Never throws — any failure must not break activation.
 */
async function maybePromptMigration(
  context: vscode.ExtensionContext
): Promise<void> {
  try {
    const alreadyPrompted = context.globalState.get<boolean>(
      MIGRATION_PROMPTED_KEY,
      false
    );
    if (!shouldPromptMigration(isLonefyInstalled(), alreadyPrompted)) {
      return;
    }
    await showMigrationNotification(() =>
      context.globalState.update(MIGRATION_PROMPTED_KEY, true)
    );
  } catch {
    // A failure here must never break activation; the command remains available
    // from the palette regardless.
  }
}

/**
 * Decide and (at most once) surface the deference notification (Axe 4.T5).
 *
 * Pure decision via `decide` over the detected competing formatters, the user's
 * `tidy.deferToOtherFormatters` preference (default 'notify'), and a one-shot
 * dedup flag in globalState. The host ONLY shows a non-modal, informational
 * notification — it NEVER disables Tidy, NEVER writes any setting, and NEVER
 * touches editor.defaultFormatter (ARCH-02). Detection is Workspace-Trust gated
 * inside detectCompetingFormatters (Restricted Mode => no reads => nothing shown).
 *
 * Never throws: any failure must not break activation.
 */
async function maybeSurfaceDeference(
  context: vscode.ExtensionContext
): Promise<void> {
  try {
    const setting = normalizeSetting(
      vscode.workspace
        .getConfiguration()
        .get<string>(DEFERENCE_SETTING_KEY)
    );
    // Cheap exits before any workspace read: 'off' ignores detection entirely and
    // an already-shown one-shot must never nag again.
    const alreadyPrompted = context.globalState.get<boolean>(
      DEFERENCE_PROMPTED_KEY,
      false
    );
    if (setting === 'off' || (setting === 'notify' && alreadyPrompted)) {
      return;
    }

    const detected = await detectCompetingFormatters();
    const decision = decide(detected, setting, alreadyPrompted);
    if (decision.action !== 'notify' || decision.message === undefined) {
      // 'defer' (silent-defer) and 'none' both surface nothing and write nothing.
      return;
    }

    // Mark the one-shot BEFORE awaiting the toast so a slow dismissal can never
    // re-trigger the prompt on a quick re-activation.
    await context.globalState.update(DEFERENCE_PROMPTED_KEY, true);
    void vscode.window.showInformationMessage(decision.message);
  } catch {
    // A failure here must never break activation; the setting still governs and
    // the user keeps full control.
  }
}

export function deactivate(): void {
  // No-op: all disposables are owned by context.subscriptions.
}
