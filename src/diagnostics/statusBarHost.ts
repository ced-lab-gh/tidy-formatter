// Host wrapper for the Tidy status bar (ADD-05, v0.3.0).
//
// Owns the SINGLE StatusBarItem and the read-only refresh triggers. This file
// is the only place the status bar touches 'vscode', mirroring the
// outputChannel.ts pattern; every decision and every string lives in the pure
// ./statusBar module.
//
// ANTI-HIJACK (ARCH-01/02, NON-NEGOTIABLE): everything here is READ-ONLY.
//   - The only listeners are onDidChangeActiveTextEditor and
//     onDidChangeConfiguration, and their callbacks ONLY repaint the item.
//   - No document save/change hook, no document edit, no setting write, no
//     command invocation, no formatting call. A static test
//     (test/unit/manifest/statusBarArch.test.ts) asserts these API names never
//     appear in this file.
//   - The transient update is driven by recordLastFormat, which only ever runs
//     inside a provider call: this module adds NO new trigger to the pipeline.
// Never throws: any repaint failure hides the item and is swallowed; the
// status bar can never break the host or a format attempt.
import * as vscode from 'vscode';
import {
  computePassiveKind,
  renderPassive,
  renderTransient,
  STATUS_BAR_ENABLE_KEY,
  TRANSIENT_DISPLAY_MS,
  type PassiveFileState,
  type StatusBarView
} from './statusBar';
// ONE STORE, ONE ANSWER (ADD-14): the bar reads the record of the ACTIVE file
// through the same per-uri lookup "Tidy: Explain Last Format" uses, so the
// tooltip and the command can never disagree about the same document.
import {
  getLastFormatFor,
  setLastFormatListener,
  type LastFormatRecord
} from './lastFormat';
import { resolveDocumentIgnore } from '../ignore/ignoreGate';
import { SUPPORTED_LANG_IDS, type LangId } from '../types';
// Same per-family cap resolution the provider uses (ADD-08), so the bar can
// never announce "too large" for a document the provider would format.
import { readSizeLimit } from '../config/vscodeConfig';
// Command id the item triggers on click; the command itself is registered by
// extension.ts. This module is vscode-free at its top level, so the import is
// safe here.
import { STATUS_BAR_MENU_COMMAND_ID } from '../commands/statusBarMenu';

const SUPPORTED: ReadonlySet<string> = new Set(SUPPORTED_LANG_IDS);

/** `tidy.statusBar.enable`, default true (absent setting behaves as enabled). */
function isStatusBarEnabled(): boolean {
  const config = vscode.workspace.getConfiguration('tidy');
  return config.get<boolean>(STATUS_BAR_ENABLE_KEY, true) !== false;
}

/**
 * Gather the passive state of a document from the EXISTING sources only:
 * tidy.<lang>.enable, the ignore gate, the per-family size cap and
 * editor.defaultFormatter. Reads only; the decision itself is pure.
 */
function gatherPassiveState(document: vscode.TextDocument): PassiveFileState {
  const languageId = document.languageId;
  if (!SUPPORTED.has(languageId)) {
    return { kind: 'unsupported', languageId };
  }

  const tidyConfig = vscode.workspace.getConfiguration('tidy', document.uri);
  const enabled = tidyConfig.get<boolean>(`${languageId}.enable`, true);
  // Same resolver as the provider (ADD-08): json/jsonc are governed by
  // tidy.json.maxFileSizeKB, every other language by tidy.maxFileSizeKB.
  const sizeLimit = readSizeLimit(document, languageId as LangId);

  // Same gate order and same byte measure as the provider, so the bar can never
  // contradict what a format would do. The getText() read happens at most once
  // per active-editor switch, the same order of cost as one format request.
  const ignoredByFile = enabled
    ? resolveDocumentIgnore(document).ignored
    : false;
  const tooLarge =
    enabled && !ignoredByFile && sizeLimit.limitBytes !== undefined
      ? Buffer.byteLength(document.getText(), 'utf8') > sizeLimit.limitBytes
      : false;

  const editorConfig = vscode.workspace.getConfiguration('editor', {
    uri: document.uri,
    languageId
  });
  const defaultFormatter =
    editorConfig.get<string>('defaultFormatter') ?? undefined;

  const kind = computePassiveKind({
    supported: true,
    enabled,
    ignoredByFile,
    tooLarge,
    defaultFormatter
  });

  // Per-uri lookup, NOT "the newest record anywhere then filter": formatting a
  // second file must never blank out the first file's tooltip verdict.
  const lastRecord = getLastFormatFor(document.uri.toString());
  return {
    kind,
    languageId,
    maxFileSizeKB: sizeLimit.limitKB,
    sizeLimitSettingKey: sizeLimit.settingKey,
    otherFormatterId: kind === 'other-default' ? defaultFormatter : undefined,
    lastRecord
  };
}

/**
 * Create the single Tidy status bar item plus its read-only refresh triggers.
 * Returns one Disposable owning everything (item, listeners, timer, the
 * lastFormat observer slot); push it into context.subscriptions once.
 */
export function createTidyStatusBar(): vscode.Disposable {
  const item = vscode.window.createStatusBarItem(
    'tidy.statusBar',
    vscode.StatusBarAlignment.Right,
    100
  );
  item.name = 'Tidy Formatter';
  item.command = STATUS_BAR_MENU_COMMAND_ID;

  let transientTimer: NodeJS.Timeout | undefined;

  function clearTransientTimer(): void {
    if (transientTimer !== undefined) {
      clearTimeout(transientTimer);
      transientTimer = undefined;
    }
  }

  function applyView(view: StatusBarView): void {
    if (!view.visible) {
      item.hide();
      return;
    }
    item.text = view.text;
    const tooltip = new vscode.MarkdownString(view.tooltipMarkdown);
    tooltip.isTrusted = false; // never a command link from a tooltip
    item.tooltip = tooltip;
    item.backgroundColor =
      view.severity === 'warning'
        ? new vscode.ThemeColor('statusBarItem.warningBackground')
        : view.severity === 'error'
          ? new vscode.ThemeColor('statusBarItem.errorBackground')
          : undefined;
    item.show();
  }

  function repaintPassive(): void {
    try {
      clearTransientTimer();
      if (!isStatusBarEnabled()) {
        item.hide();
        return;
      }
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        item.hide();
        return;
      }
      applyView(renderPassive(gatherPassiveState(editor.document)));
    } catch {
      // Display must never break the host: fail to a hidden item.
      item.hide();
    }
  }

  function onRecord(record: LastFormatRecord): void {
    try {
      if (!isStatusBarEnabled()) {
        return;
      }
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.uri.toString() !== record.uri) {
        return; // a background format never repaints the active file's state
      }
      clearTransientTimer();
      applyView(renderTransient(record));
      transientTimer = setTimeout(() => {
        transientTimer = undefined;
        repaintPassive();
      }, TRANSIENT_DISPLAY_MS);
    } catch {
      // An observer failure must never break the format pipeline.
    }
  }

  const editorListener = vscode.window.onDidChangeActiveTextEditor(() => {
    repaintPassive();
  });
  const configListener = vscode.workspace.onDidChangeConfiguration((event) => {
    if (
      event.affectsConfiguration('tidy') ||
      event.affectsConfiguration('editor.defaultFormatter')
    ) {
      repaintPassive();
    }
  });

  setLastFormatListener(onRecord);
  repaintPassive();

  return vscode.Disposable.from(
    item,
    editorListener,
    configListener,
    new vscode.Disposable(() => {
      clearTransientTimer();
      setLastFormatListener(undefined);
    })
  );
}
