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
// installed : it writes nothing on its own. VS Code core owns the save /
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
  OPEN_PLAYGROUND_COMMAND_ID,
  openPlayground
} from './commands/openPlayground';
import {
  REPORT_ISSUE_COMMAND_ID,
  reportIssue
} from './commands/reportIssue';
import {
  EXPLAIN_LAST_FORMAT_COMMAND_ID,
  explainLastFormat
} from './commands/explainLastFormat';
import {
  SHOW_FORMAT_HISTORY_COMMAND_ID,
  showFormatHistory
} from './commands/showFormatHistory';
import {
  STATUS_BAR_MENU_COMMAND_ID,
  showStatusBarMenu
} from './commands/statusBarMenu';
import {
  WHO_FORMATS_COMMAND_ID,
  whoFormats
} from './commands/whoFormats';
import { createTidyStatusBar } from './diagnostics/statusBarHost';
import { getTidyOutputChannel } from './diagnostics/outputChannel';
import { sanitizeDetail } from './diagnostics/lastFormat';
import { detectCompetingFormatters } from './deference/detect';
import {
  decide,
  normalizeSetting,
  DEFERENCE_SETTING_KEY,
  DEFERENCE_PROMPTED_KEY
} from './deference/decide';
import {
  scheduleChunkPreload,
  type ChunkPreloadSchedule,
  type PreloadReport
} from './chunks/loader';
import { SUPPORTED_LANG_IDS } from './types';

/**
 * Context key published via `setContext` at activation (ADD-10). The manifest's
 * command `enablement` and the "Tidy" editor context submenu `when` clauses read
 * it as `editorLangId in tidy.supportedLanguages`, so palette entries and menus
 * only light up on languages Tidy actually handles. Volatile UI state only : it
 * is NOT a user setting, it writes no file, and it is reset on every window
 * reload.
 */
export const SUPPORTED_LANGUAGES_CONTEXT_KEY = 'tidy.supportedLanguages';

export function activate(context: vscode.ExtensionContext): void {
  // Publish the supported-language list as volatile UI state so the manifest's
  // `enablement` clauses and the "Tidy" editor context submenu can gate
  // themselves on it. setContext writes NO user setting and NO file (anti-hijack
  // safe, ARCH-02 untouched). Fire-and-forget : a failure would only hide UI
  // entries, never break activation or formatting. The shared constant is copied
  // by spread so it is never handed to a host API by reference.
  void vscode.commands.executeCommand(
    'setContext',
    SUPPORTED_LANGUAGES_CONTEXT_KEY,
    [...SUPPORTED_LANG_IDS]
  );

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

  // Open Playground (ADD-03): opens two UNTITLED sample documents (messy CSS +
  // messy TSX) so the walkthrough's "Try it now" step runs on scratch buffers.
  // ZERO disk writes, ZERO hooks: the command only opens editors; formatting
  // still happens exclusively through the explicit preview/format commands.
  context.subscriptions.push(
    vscode.commands.registerCommand(OPEN_PLAYGROUND_COMMAND_ID, openPlayground)
  );

  // Report an Issue: opens a prefilled GitHub issue with environment details.
  // Read-only : it opens an external URL and writes nothing (no setting, no file).
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

  // Show Format History (ADD-14): chronological QuickPick over the session's
  // bounded format history; picking an entry writes the full explanation to the
  // shared output channel. Read-only: no hook, no listener, no setting written;
  // session RAM only, nothing persisted, nothing sent.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      SHOW_FORMAT_HISTORY_COMMAND_ID,
      showFormatHistory
    )
  );

  // Who Formats This File? (v0.5.0): names the formatter, the settings scopes and the
  // incumbent behind a file that gets reformatted. Strictly read-only: it writes no
  // setting and no file, opens no connection and hooks no event; its only output is
  // text for the Tidy output channel and a toast whose buttons OPEN Settings or the
  // Extensions view. Registering it does nothing on its own.
  context.subscriptions.push(
    vscode.commands.registerCommand(WHO_FORMATS_COMMAND_ID, whoFormats)
  );

  // Status bar (ADD-05, v0.3.0): a single, purely OBSERVATIONAL StatusBarItem.
  // Passive state of the active file + a short transient result after each
  // attempt. Read-only by construction: its only listeners repaint the item,
  // it never formats, never edits, never writes a setting, and its click opens
  // a QuickPick over three existing commands. Everything (item, listeners,
  // timer, observer slot) is owned by the single returned Disposable.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      STATUS_BAR_MENU_COMMAND_ID,
      showStatusBarMenu
    )
  );
  context.subscriptions.push(createTidyStatusBar());

  // One-shot, deduplicated migration prompt (1.T4). Fire-and-forget so it never
  // blocks activation; it writes nothing before the user confirms inside the
  // migration command. Shown at most once per machine+profile via globalState.
  void maybePromptMigration(context);

  // One-shot, deduplicated deference notification (Axe 4.T5). Fire-and-forget so
  // it never blocks activation. It only ever SURFACES that another formatter is
  // configured : it never disables Tidy, never touches editor.defaultFormatter,
  // and writes no setting on its own (anti-hijack). Uses a globalState key
  // DISTINCT from the migration prompt so the two never collide.
  void maybeSurfaceDeference(context);

  // Idle chunk preload (ADD-11). Five seconds after activation, warm ONLY the
  // lazy engine/guard chunks the languages currently on screen can actually
  // reach, so their first format skips the load cost. This is a plain timer, NOT
  // an event hook: it observes nothing, writes no setting, never touches
  // editor.defaultFormatter, and disposing the subscription (deactivate)
  // cancels it. A preload failure only logs to the Tidy output channel; the
  // chunk falls back to normal lazy loading on first use.
  context.subscriptions.push(scheduleIdleChunkPreload());
}

/**
 * Decide and (at most once) show the migration notification. Pure decision via
 * `shouldPromptMigration`; the persisted flag lives in globalState so the nag is
 * never repeated. Never throws : any failure must not break activation.
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
 * notification : it NEVER disables Tidy, NEVER writes any setting, and NEVER
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

/** Delay before the idle preload fires. Not configurable on purpose. */
const IDLE_PRELOAD_DELAY_MS = 5000;

/**
 * Schedule the one-shot, LANGUAGE-AWARE idle preload of the engine/guard chunks
 * (ADD-11) and return the Disposable that cancels it.
 *
 * ANTI-HIJACK: this is a bare `setTimeout` (see scheduleChunkPreload), not a
 * listener. It subscribes to no document/save/focus/change event, reads no user
 * file, writes no setting, and shows no toast. Disposing before the timer fires
 * (deactivate, or a reload inside five seconds) leaves ZERO work behind, and the
 * timer can never fire twice.
 *
 * HONESTY: the preload warms only what the languages currently on screen can
 * reach. A session with nothing but stylesheets open therefore never evaluates
 * the TypeScript printer, which is exactly what the README promises; everything
 * else keeps loading on demand at first use.
 *
 * The preload never rejects: failures are reported per chunk and logged to the
 * Tidy output channel only (no telemetry, nothing leaves the machine); the
 * affected chunk simply loads lazily on first use.
 */
function scheduleIdleChunkPreload(): vscode.Disposable {
  const schedule: ChunkPreloadSchedule = scheduleChunkPreload(
    IDLE_PRELOAD_DELAY_MS,
    readOpenLanguageIds,
    reportPreload
  );
  return new vscode.Disposable(() => {
    schedule.dispose();
  });
}

/**
 * The languages the user currently has on screen, read ONCE when the preload
 * timer fires.
 *
 * This is a single synchronous property read, NOT a subscription: no
 * onDidChangeVisibleTextEditors, no watcher, nothing registered and nothing
 * that can fire later. Documents opened after this instant are not preloaded;
 * they simply load their chunk on first use, which is the normal lazy path.
 */
function readOpenLanguageIds(): readonly string[] {
  return vscode.window.visibleTextEditors.map(
    (editor) => editor.document.languageId
  );
}

/** Log the preload outcome to the local output channel. Nothing leaves the machine. */
function reportPreload(report: PreloadReport): void {
  const channel = getTidyOutputChannel();
  const total = report.loaded.length + report.failed.length;
  if (total === 0) {
    channel.appendLine(
      '[preload] nothing to warm: no open editor needs a lazy engine chunk'
    );
    return;
  }
  const ready = report.loaded.length > 0 ? ` (${report.loaded.join(', ')})` : '';
  channel.appendLine(
    `[preload] ${report.loaded.length}/${total} engine chunks ready in ${report.elapsedMs} ms${ready}`
  );
  for (const failure of report.failed) {
    channel.appendLine(
      `[preload] ${failure.chunk} failed to preload ` +
        `(${sanitizeDetail(failure.message)}); it will load on first use`
    );
  }
}

export function deactivate(): void {
  // No-op: all disposables are owned by context.subscriptions, including the
  // idle preload schedule, which VS Code disposes here (cancelling the timer if
  // it has not fired yet).
}
