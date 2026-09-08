// Command: "Tidy: Show Format History".
// The chronological companion to "Tidy: Explain Last Format": a QuickPick over
// every format attempt retained this session (bounded ring buffer, newest
// first), one line per attempt: [status icon] file name, language, status,
// relative age. Picking an entry writes the FULL explanation for that attempt
// to the shared "Tidy Formatter" output channel and reveals it.
//
// Read-only by construction: it changes no file, writes no setting, registers
// no listener and no hook. Content-free by contract: it renders only what the
// store retains (file name, language, status, sanitized one-line detail), never
// any document source. In-memory only: nothing is persisted, nothing is sent.
//
// Split of concerns (mirrors commands/explainLastFormat.ts): the pure builders
// (statusIcon, relativeAge, neutralizeIconSyntax, buildHistoryItems) import NO
// 'vscode' and are unit-tested under plain mocha+tsx; the thin handler
// requires 'vscode' and the shared output channel lazily inside itself.
import {
  getHistory,
  type FormatStatus,
  type LastFormatRecord
} from '../diagnostics/lastFormat';
import { buildExplanation } from './explainLastFormat';

/** Command id (registered by extension.ts; this module owns only the constant). */
export const SHOW_FORMAT_HISTORY_COMMAND_ID = 'tidy.showFormatHistory';

/** Shown (non-blocking) when the session has no retained attempt yet. */
export const EMPTY_HISTORY_MESSAGE =
  'Tidy has not formatted any file yet in this session. ' +
  'Run Format Document (Shift+Alt+F) on a supported file, then try again.';

/** The only codicons the history ever renders, per the product spec. */
export type HistoryIcon = 'check' | 'shield' | 'circle-slash';

/**
 * Bucket a FormatStatus into one of the three history codicons:
 *   - check        : the engine ran and the file is in the wanted state
 *                    (changes applied, or already tidy);
 *   - shield       : the safety layer abstained ON PURPOSE and the file is
 *                    intact (guard rejection, failed verbatim restore);
 *   - circle-slash : Tidy produced no result here (errors, skips, ignores,
 *                    disabled, unsupported, cancelled).
 * Exhaustive over FormatStatus: adding a status without deciding its icon is a
 * compile error.
 */
export function statusIcon(status: FormatStatus): HistoryIcon {
  switch (status) {
    case 'applied':
    case 'already-tidy':
      return 'check';
    case 'guard-rejected':
    case 'restore-failed':
      return 'shield';
    case 'engine-error':
    case 'config-error':
    case 'too-large':
    case 'ignored-file':
    case 'ignored-marker':
    case 'disabled':
    case 'unsupported':
    case 'cancelled':
      return 'circle-slash';
    default: {
      // Exhaustiveness guard: a new FormatStatus must be handled above.
      const _never: never = status;
      return _never;
    }
  }
}

// Millisecond ladder for the relative-age label. Plain constants: no locale,
// no Intl dependency, deterministic under test.
const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Compact English relative age of an ISO timestamp: "just now", "12s ago",
 * "3m ago", "2h ago", "5d ago". Pure: `nowMs` is injected so tests are exact.
 * A future or unparsable timestamp can only come from a corrupted record, so
 * we degrade honestly instead of throwing: a future stamp clamps to
 * "just now", an unparsable one renders "unknown time".
 */
export function relativeAge(atIso: string, nowMs: number): string {
  const atMs = Date.parse(atIso);
  if (Number.isNaN(atMs)) {
    return 'unknown time';
  }
  const elapsed = Math.max(0, nowMs - atMs);
  if (elapsed < SECOND_MS) {
    return 'just now';
  }
  if (elapsed < MINUTE_MS) {
    return `${Math.floor(elapsed / SECOND_MS)}s ago`;
  }
  if (elapsed < HOUR_MS) {
    return `${Math.floor(elapsed / MINUTE_MS)}m ago`;
  }
  if (elapsed < DAY_MS) {
    return `${Math.floor(elapsed / HOUR_MS)}h ago`;
  }
  return `${Math.floor(elapsed / DAY_MS)}d ago`;
}

/**
 * Neutralize codicon syntax in UNTRUSTED display text (file names, engine
 * details). QuickPick labels render "$(icon)" sequences as icons, so a file
 * literally named "$(check) pwned.css" could otherwise spoof a status icon.
 * Breaking the "$(" pair with a space keeps the text readable and kills the
 * rendering. Pure.
 */
export function neutralizeIconSyntax(text: string): string {
  return text.replace(/\$\(/g, '$ (');
}

/**
 * A pure, vscode-free QuickPick item (structurally a vscode.QuickPickItem).
 * `index` points back into the SAME newest-first array the items were built
 * from, so the handler resolves the picked record without string round-trips.
 */
export interface HistoryItem {
  readonly label: string;
  readonly description: string;
  readonly detail?: string;
  readonly index: number;
}

/**
 * Build the QuickPick items for a newest-first history (as returned by
 * getHistory()). Pure and content-free: only file name, language, status,
 * relative age and the already-sanitized one-line detail are rendered; the
 * `detail` key is OMITTED (not set to undefined) when the record has none.
 */
export function buildHistoryItems(
  history: readonly LastFormatRecord[],
  nowMs: number
): HistoryItem[] {
  return history.map((record, index) => {
    const scope = record.scope === 'selection' ? ' (selection)' : '';
    const age = relativeAge(record.at, nowMs);
    const base: HistoryItem = {
      label: `$(${statusIcon(record.status)}) ${neutralizeIconSyntax(
        record.fileName
      )}`,
      description: `${record.languageId}, ${record.status}${scope}, ${age}`,
      index
    };
    return record.detail !== undefined
      ? { ...base, detail: neutralizeIconSyntax(record.detail) }
      : base;
  });
}

/* -------------------------------------------------------------------------- */
/* VS Code handler (loads 'vscode' lazily; runs only in the extension host)    */
/* -------------------------------------------------------------------------- */
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */

/**
 * Handler for "Tidy: Show Format History". Read-only:
 *   1. empty history -> one non-blocking information message, nothing else;
 *   2. otherwise a QuickPick of the retained attempts, newest first, built
 *      from ONE immutable snapshot (a format landing while the picker is open
 *      can never skew the selection);
 *   3. cancelling (Escape / focus loss) shows and writes NOTHING;
 *   4. picking an entry appends the full explanation for THAT record to the
 *      shared "Tidy Formatter" output channel and reveals it. The explanation
 *      is built by buildExplanation with a synthetic context matching the
 *      record's uri, so the per-status wording has a single source of truth.
 */
export async function showFormatHistory(): Promise<void> {
  const vscode = require('vscode');
  const { getTidyOutputChannel } = require('../diagnostics/outputChannel');

  const history = getHistory();
  if (history.length === 0) {
    void vscode.window.showInformationMessage(EMPTY_HISTORY_MESSAGE);
    return;
  }

  const items = buildHistoryItems(history, Date.now());
  const picked = (await vscode.window.showQuickPick(items, {
    title: 'Tidy: Format history (this session)',
    placeHolder: 'Newest first. Select an attempt to see the full explanation.',
    matchOnDescription: true,
    matchOnDetail: true
  })) as HistoryItem | undefined;
  if (!picked) {
    return; // cancelled: nothing shown, nothing written
  }

  const record = history[picked.index];
  const explanation = buildExplanation(record, {
    activeUri: record.uri,
    activeLanguageId: record.languageId
  });

  const channel = getTidyOutputChannel();
  channel.appendLine('');
  channel.appendLine(`=== Format history entry (${record.at}) ===`);
  channel.appendLine(`File: ${record.fileName} (${record.languageId})`);
  channel.appendLine(explanation.headline);
  for (const line of explanation.lines) {
    channel.appendLine(`  - ${line}`);
  }
  channel.show(true);
}
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */
