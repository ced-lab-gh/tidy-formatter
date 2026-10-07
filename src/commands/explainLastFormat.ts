// Command: "Tidy: Explain last format".
// The antidote to "I installed Tidy and Format Document does nothing". For the
// active file it reports what Tidy's most recent format attempt ON THAT FILE did
// (per-file lookup via getLastFormatFor, ADD-14: exact however many files are
// open), or WHY it did nothing (guard rejection, .soukformatignore, size limit,
// an ignore marker, a disabled language) and, when Tidy has not run on this file
// at all, whether another formatter owns the language and how to switch to Tidy.
//
// v0.3.0 (ADD-06): every explanation can carry one-click ACTIONS rendered as toast
// buttons, mapping each status to its remedy (Report an Issue, Open Settings, open
// the matching .soukformatignore, or the Use Tidy onboarding command). The mapping
// lives in the PURE builder below: single source of truth, unit-tested without
// 'vscode'. Every action only ever runs an existing read-only or consent-gated
// command, so the anti-hijack contract is untouched, and no NEW notification is
// ever shown: the existing toasts simply gain buttons.
//
// Split of concerns (mirrors commands/showConfig.ts): the pure builder
// (`buildExplanation`) imports NO 'vscode' and is unit-tested; the thin handler
// gathers host state (active editor, default formatter) and the shared output
// channel lazily inside itself.
import {
  getLastFormatFor,
  sanitizeDetail,
  type LastFormatRecord
} from '../diagnostics/lastFormat';
import { SUPPORTED_LANG_IDS } from '../types';
// Pure module (no 'vscode'): lets the too-large explanation name the cap that
// actually applied instead of always pointing at the generic setting.
import { settingKeyFromDescription } from '../config/sizeLimit';
// Pure module (no 'vscode'): tells a recorded fail-closed REASON from an ignore
// file PATH, both of which land in the "ignored-file" record's detail.
import { isFailClosedDetail } from '../ignore/soukformatignore';
import { REPORT_ISSUE_COMMAND_ID } from './reportIssue';
import { USE_AS_FORMATTER_COMMAND_ID } from './useAsFormatter';

export const EXPLAIN_LAST_FORMAT_COMMAND_ID = 'tidy.explainLastFormat';

const TIDY_EXTENSION_ID = 'ced-lab.tidy-formatter';

// VS Code built-in command ids used by actions. 'workbench.action.openSettings'
// takes a plain search-query string. 'vscode.open' takes a Uri, which the HOST
// executor builds from the plain path stored in `args`: the pure builder can only
// carry strings, never a vscode.Uri.
export const OPEN_SETTINGS_COMMAND_ID = 'workbench.action.openSettings';
export const OPEN_FILE_COMMAND_ID = 'vscode.open';

// Button captions, exported so the provider toasts and the tests reuse the EXACT
// same labels (single source of truth, no drift).
export const ACTION_REPORT_ISSUE_LABEL = 'Report an Issue';
export const ACTION_OPEN_SETTINGS_LABEL = 'Open Settings';
export const ACTION_OPEN_IGNORE_FILE_LABEL = 'Open .soukformatignore';
export const ACTION_USE_TIDY_LABEL = 'Use Tidy as my Formatter';

// Single source of truth lives in ../types so this can never drift from the provider.
const SUPPORTED_LANGUAGES: ReadonlySet<string> = new Set(SUPPORTED_LANG_IDS);

const SUPPORTED_LANGUAGES_SENTENCE =
  'Tidy formats HTML, CSS, SCSS, LESS, JavaScript, TypeScript, JSX/TSX, JSON and JSONC.';

/** vscode-free view of the active editor + config the builder needs. */
export interface ExplainContext {
  readonly activeUri?: string;
  readonly activeLanguageId?: string;
  readonly defaultFormatter?: string; // editor.defaultFormatter for the active language
}

/**
 * A one-click remedy attached to an Explanation, rendered as a button on the
 * information toast. PURE data: `args` may only carry plain strings; the host
 * executor translates them (a filesystem path becomes a file Uri for
 * OPEN_FILE_COMMAND_ID). Labels are the button captions: short, English, stable.
 */
export interface ExplanationAction {
  readonly label: string;
  readonly commandId: string;
  readonly args?: readonly string[];
}

export interface Explanation {
  readonly headline: string;
  readonly lines: readonly string[];
  /**
   * Zero-or-more one-click remedies for this outcome, in display order. Absent
   * when the status has no actionable remedy (applied, already-tidy,
   * ignored-marker, config-error, cancelled, unsupported, no active editor).
   */
  readonly actions?: readonly ExplanationAction[];
}

function isSupported(languageId: string | undefined): boolean {
  return languageId !== undefined && SUPPORTED_LANGUAGES.has(languageId);
}

/** The "this is a bug worth telling us about" remedy (guard/engine/restore). */
function reportIssueAction(): ExplanationAction {
  return { label: ACTION_REPORT_ISSUE_LABEL, commandId: REPORT_ISSUE_COMMAND_ID };
}

/** Open the Settings UI filtered down to a single setting key. Never edits it. */
function openSettingsAction(settingKey: string): ExplanationAction {
  return {
    label: ACTION_OPEN_SETTINGS_LABEL,
    commandId: OPEN_SETTINGS_COMMAND_ID,
    args: [settingKey]
  };
}

/**
 * Open the .soukformatignore that excluded the file, when a usable path was
 * recorded. The provider stores the ignore file's ABSOLUTE path in
 * `record.detail`; sanitizeDetail truncates over-long details with a trailing
 * "...", in which case the path is not openable and NO action is offered (the
 * textual explanation still stands on its own). When the exclusion is a
 * fail-closed one the detail is the REASON (which line could not be evaluated, or
 * that the file is too large), not a path: nothing is offered then either, or the
 * button would ask the editor to open a sentence as a file. Returns undefined
 * otherwise.
 */
function openIgnoreFileActions(
  record: LastFormatRecord
): readonly ExplanationAction[] | undefined {
  const ignorePath = record.detail;
  if (ignorePath === undefined || ignorePath === '' || ignorePath.endsWith('...')) {
    return undefined;
  }
  if (isFailClosedDetail(ignorePath)) {
    return undefined;
  }
  return [
    {
      label: ACTION_OPEN_IGNORE_FILE_LABEL,
      commandId: OPEN_FILE_COMMAND_ID,
      args: [ignorePath]
    }
  ];
}

/** Explain a record that belongs to the active document. Exhaustive over FormatStatus. */
function explainRecord(record: LastFormatRecord): Explanation {
  const lang = record.languageId;
  switch (record.status) {
    case 'applied':
      return {
        headline: 'Tidy formatted this file.',
        lines: [
          `The last ${record.scope} format applied changes${
            record.engineId ? ` via ${record.engineId}` : ''
          }.`
        ]
      };
    case 'already-tidy':
      return {
        headline:
          'Tidy ran but made no changes: the file was already formatted to your settings.',
        lines: [
          `Nothing needed fixing${record.engineId ? ` (engine: ${record.engineId})` : ''}.`,
          'Run "Tidy: Show Effective Configuration" to see the settings in effect.'
        ]
      };
    case 'guard-rejected':
      return {
        headline:
          'Tidy did nothing on purpose: the formatted result was not provably equivalent to your original, so it was discarded and your file left intact.',
        lines: [
          record.detail
            ? `Reason: ${record.detail}.`
            : 'Reason: the formatted output would have changed the meaning of your code.',
          'This is the safety guard doing its job, not a bug.',
          'If you believe this input should format cleanly, run "Tidy: Report an Issue" with the smallest snippet that reproduces it.'
        ],
        actions: [reportIssueAction()]
      };
    case 'engine-error':
      return {
        headline:
          'Tidy could not format this file: the formatter or its safety check reported an error, so nothing was applied.',
        lines: [
          record.detail ? `Detail: ${record.detail}.` : 'No further detail available.',
          'Your file is intact. Please run "Tidy: Report an Issue" with a snippet if this persists.'
        ],
        actions: [reportIssueAction()]
      };
    case 'restore-failed':
      return {
        headline:
          'Tidy aborted to stay safe: an in-source ignore region could not be restored exactly, so no edit was applied.',
        lines: [
          'Your file is intact.',
          'This points at an engine bug worth reporting: run "Tidy: Report an Issue" with the smallest snippet that reproduces it.'
        ],
        actions: [reportIssueAction()]
      };
    case 'config-error':
      return {
        headline: 'Tidy could not resolve its settings for this file, so it did nothing.',
        lines: [
          record.detail ? `Detail: ${record.detail}.` : 'No further detail available.',
          'Check your .editorconfig / .soukformatrc for invalid values.'
        ]
      };
    case 'too-large': {
      // The provider stores describeSizeLimit(...) as the detail, so it already
      // names the cap, the exact setting key and where that value came from.
      // Point Open Settings at THAT key (json/jsonc get their own cap), falling
      // back to the generic one for an older or truncated record.
      const settingKey =
        settingKeyFromDescription(record.detail) ?? 'tidy.maxFileSizeKB';
      return {
        headline: 'Tidy skipped this file because it exceeds the size limit.',
        lines: [
          record.detail
            ? `Limit: ${record.detail}.`
            : 'See tidy.maxFileSizeKB (and tidy.json.maxFileSizeKB for JSON/JSONC).',
          `Raise ${settingKey}, or set it to 0, to disable the cap.`,
          'JSON and JSONC have their own, higher cap (tidy.json.maxFileSizeKB, default 10240 KB) because their formatter and safety check stay fast on large documents.'
        ],
        actions: [openSettingsAction(settingKey)]
      };
    }
    case 'ignored-file': {
      const pathLine = record.detail ? `Ignore file: ${record.detail}.` : undefined;
      // A fail-closed verdict (budget, unevaluable line, oversized file) is not a rule.
      const failClosed = isFailClosedDetail(record.detail);
      return {
        headline: failClosed
          ? 'Tidy skipped this file: its .soukformatignore could not be fully evaluated, so Tidy left the file alone.'
          : 'Tidy skipped this file: a .soukformatignore rule excludes it.',
        lines: [
          ...(pathLine ? [pathLine] : []),
          failClosed
            ? 'Fix or remove what is described above, or set tidy.respectSoukformatignore to false to format it anyway.'
            : 'Remove the matching rule, or set tidy.respectSoukformatignore to false to format it anyway.'
        ],
        actions: openIgnoreFileActions(record)
      };
    }
    case 'ignored-marker':
      return {
        headline:
          'Tidy skipped this file: it has a top-of-file "tidy-ignore" / "prettier-ignore" marker.',
        lines: ['Remove the marker to let Tidy format this file.']
      };
    case 'disabled':
      return {
        headline: `Tidy is turned off for ${lang}.`,
        lines: [`Set "tidy.${lang}.enable" to true to re-enable it for this language.`],
        actions: [openSettingsAction(`tidy.${lang}.enable`)]
      };
    case 'cancelled':
      return {
        headline: 'The last format was cancelled before it finished.',
        lines: ['Run Format Document again.']
      };
    case 'unsupported':
      return {
        headline: `Tidy does not handle ${lang}.`,
        lines: [SUPPORTED_LANGUAGES_SENTENCE]
      };
    default: {
      // Exhaustiveness guard: a new FormatStatus must be handled above.
      const _never: never = record.status;
      return { headline: `Tidy recorded an unrecognised outcome: ${_never}.`, lines: [] };
    }
  }
}

/**
 * Build the explanation for the "Explain last format" command. Pure.
 *  - no active editor -> tell the user to open a file and format first;
 *  - a record matching the active file -> explain that outcome;
 *  - no matching record -> explain why Tidy has not run here (another default
 *    formatter, an unsupported language, or simply not invoked yet) and how to fix it.
 */
export function buildExplanation(
  record: LastFormatRecord | undefined,
  ctx: ExplainContext
): Explanation {
  if (!ctx.activeUri || !ctx.activeLanguageId) {
    return {
      headline: 'Open a file first.',
      lines: [
        'Open a supported file, run Format Document (Shift+Alt+F), then run this command to see exactly what Tidy did.'
      ]
    };
  }

  if (record && record.uri === ctx.activeUri) {
    return explainRecord(record);
  }

  // No record for THIS file: the most common "it does nothing" situation.
  const lang = ctx.activeLanguageId;
  if (!isSupported(lang)) {
    return {
      headline: `Tidy does not handle ${lang}, so it will not run on this file.`,
      lines: [SUPPORTED_LANGUAGES_SENTENCE]
    };
  }
  if (ctx.defaultFormatter && ctx.defaultFormatter !== TIDY_EXTENSION_ID) {
    return {
      headline: `Tidy has not run on this file: another formatter owns ${lang}.`,
      lines: [
        `The default formatter for ${lang} is currently "${ctx.defaultFormatter}", not Tidy.`,
        'To use Tidy here, run "Tidy: Use Tidy as my Formatter", or pick it once via "Format Document With… → Tidy Formatter".'
      ],
      actions: [{ label: ACTION_USE_TIDY_LABEL, commandId: USE_AS_FORMATTER_COMMAND_ID }]
    };
  }
  return {
    headline: 'Tidy has not formatted this file yet in this session.',
    lines: [
      'Run Format Document (Shift+Alt+F) or Format Selection, then run this command again to see what happened.',
      `If nothing happens when you format, another formatter may own ${lang}, or check that "tidy.${lang}.enable" is true.`
    ]
  };
}

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

/* -------------------------------------------------------------------------- */
/* VS Code handler (loads 'vscode' lazily; runs only in the extension host)     */
/* -------------------------------------------------------------------------- */
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */

/**
 * Execute one ExplanationAction on the host. The single translation seam between
 * the pure action data (plain strings) and VS Code:
 *  - OPEN_FILE_COMMAND_ID expects a Uri, built here from the stored path;
 *  - every other command receives its plain-string args untouched.
 * Never throws in a way that reaches the user: any failure surfaces as a
 * non-blocking English warning, whose detail goes through the shared
 * `sanitizeDetail` (an engine/host error can embed a multi-line code frame
 * carrying the user's SOURCE, which must never reach a notification).
 */
async function runExplanationAction(
  vscode: any,
  action: ExplanationAction
): Promise<void> {
  try {
    if (action.commandId === OPEN_FILE_COMMAND_ID) {
      const fsPath = action.args?.[0];
      if (typeof fsPath !== 'string' || fsPath.length === 0) {
        return;
      }
      await vscode.commands.executeCommand(OPEN_FILE_COMMAND_ID, vscode.Uri.file(fsPath));
      return;
    }
    await vscode.commands.executeCommand(action.commandId, ...(action.args ?? []));
  } catch (error: unknown) {
    const detail =
      error instanceof Error ? sanitizeDetail(error.message) : 'unknown error';
    void vscode.window.showWarningMessage(
      `Tidy: could not run "${action.label}" (${detail}).`
    );
  }
}

/**
 * Command handler. Gathers active-editor + default-formatter context, builds the
 * explanation, writes it to the shared "Tidy Formatter" output channel, reveals the
 * channel, and shows the headline as a non-blocking information message whose
 * buttons are the explanation's actions. Read-only by itself: it changes no file
 * and no setting; a clicked button runs an existing read-only or consent-gated
 * command (see runExplanationAction).
 */
export async function explainLastFormat(): Promise<void> {
  const vscode = require('vscode');
  const { getTidyOutputChannel } = require('../diagnostics/outputChannel');

  const doc = vscode.window.activeTextEditor?.document;
  let defaultFormatter: string | undefined;
  if (doc) {
    const cfg = vscode.workspace.getConfiguration('editor', {
      uri: doc.uri,
      languageId: doc.languageId
    });
    defaultFormatter = cfg.get('defaultFormatter') ?? undefined;
  }

  const ctx: ExplainContext = {
    activeUri: doc?.uri.toString(),
    activeLanguageId: doc?.languageId,
    defaultFormatter
  };

  // Per-file lookup (ADD-14): the record shown is the ACTIVE file's, never the
  // globally-last one, so formatting file B can no longer make Tidy claim it
  // "has not formatted" file A.
  const record =
    ctx.activeUri !== undefined ? getLastFormatFor(ctx.activeUri) : undefined;
  const explanation = buildExplanation(record, ctx);
  const actions = explanation.actions ?? [];

  const channel = getTidyOutputChannel();
  channel.appendLine('');
  channel.appendLine(`=== Explain last format @ ${new Date().toISOString()} ===`);
  if (doc) {
    channel.appendLine(`File: ${basename(doc.uri.path)} (${doc.languageId})`);
  }
  channel.appendLine(explanation.headline);
  for (const line of explanation.lines) {
    channel.appendLine(`  - ${line}`);
  }
  for (const action of actions) {
    channel.appendLine(`  > Suggested action: ${action.label}`);
  }
  channel.show(true);

  // Fire-and-forget (idiom of useAsFormatter's announceSuccess): the command must
  // resolve immediately so a headless host or an integration test never hangs on
  // an unclicked toast. A click runs the mapped remedy; dismissal does nothing.
  void vscode.window
    .showInformationMessage(explanation.headline, ...actions.map((a) => a.label))
    .then((picked: string | undefined) => {
      if (picked === undefined) {
        return;
      }
      const action = actions.find((a) => a.label === picked);
      if (action) {
        void runExplanationAction(vscode, action);
      }
    });
}
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */
