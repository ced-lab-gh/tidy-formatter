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

  // One-shot, deduplicated migration prompt (1.T4). Fire-and-forget so it never
  // blocks activation; it writes nothing before the user confirms inside the
  // migration command. Shown at most once per machine+profile via globalState.
  void maybePromptMigration(context);
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

export function deactivate(): void {
  // No-op: all disposables are owned by context.subscriptions.
}
