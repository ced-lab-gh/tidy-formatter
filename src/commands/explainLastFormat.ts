// Command: "Tidy: Explain last format".
// The antidote to "I installed Tidy and Format Document does nothing". For the
// active file it reports what the most recent Tidy format attempt did, or WHY it did
// nothing (guard rejection, .soukformatignore, size limit, an ignore marker, a
// disabled language) and, when Tidy has not run on this file at all, whether another
// formatter owns the language and how to switch to Tidy.
//
// Split of concerns (mirrors commands/showConfig.ts): the pure builder
// (`buildExplanation`) imports NO 'vscode' and is unit-tested; the thin handler
// gathers host state (active editor, default formatter) and the shared output
// channel lazily inside itself.
import { getLastFormat, type LastFormatRecord } from '../diagnostics/lastFormat';
import { SUPPORTED_LANG_IDS } from '../types';

export const EXPLAIN_LAST_FORMAT_COMMAND_ID = 'tidy.explainLastFormat';

const TIDY_EXTENSION_ID = 'ced-lab.tidy-formatter';

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

export interface Explanation {
  readonly headline: string;
  readonly lines: readonly string[];
}

function isSupported(languageId: string | undefined): boolean {
  return languageId !== undefined && SUPPORTED_LANGUAGES.has(languageId);
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
        ]
      };
    case 'engine-error':
      return {
        headline:
          'Tidy could not format this file: the formatter or its safety check reported an error, so nothing was applied.',
        lines: [
          record.detail ? `Detail: ${record.detail}.` : 'No further detail available.',
          'Your file is intact. Please run "Tidy: Report an Issue" with a snippet if this persists.'
        ]
      };
    case 'restore-failed':
      return {
        headline:
          'Tidy aborted to stay safe: an in-source ignore region could not be restored exactly, so no edit was applied.',
        lines: ['Your file is intact.']
      };
    case 'config-error':
      return {
        headline:
          'Tidy could not resolve its settings for this file, so it did nothing.',
        lines: [
          record.detail ? `Detail: ${record.detail}.` : 'No further detail available.',
          'Check your .editorconfig / .soukformatrc for invalid values.'
        ]
      };
    case 'too-large':
      return {
        headline: 'Tidy skipped this file because it exceeds the size limit.',
        lines: [
          record.detail
            ? `Limit: tidy.maxFileSizeKB is ${record.detail} KB.`
            : 'See tidy.maxFileSizeKB.',
          'Raise the limit, or set tidy.maxFileSizeKB to 0 to disable it.'
        ]
      };
    case 'ignored-file':
      return {
        headline: 'Tidy skipped this file: a .soukformatignore rule excludes it.',
        lines: [
          'Remove the matching rule, or set tidy.respectSoukformatignore to false to format it anyway.'
        ]
      };
    case 'ignored-marker':
      return {
        headline:
          'Tidy skipped this file: it has a top-of-file "tidy-ignore" / "prettier-ignore" marker.',
        lines: ['Remove the marker to let Tidy format this file.']
      };
    case 'disabled':
      return {
        headline: `Tidy is turned off for ${lang}.`,
        lines: [`Set "tidy.${lang}.enable" to true to re-enable it for this language.`]
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
      ]
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

/**
 * Command handler. Gathers active-editor + default-formatter context, builds the
 * explanation, writes it to the shared "Tidy Formatter" output channel, reveals the
 * channel, and shows the headline as a non-blocking information message. Read-only:
 * it changes no file and no setting.
 */
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */
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

  const explanation = buildExplanation(getLastFormat(), ctx);

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
  channel.show(true);

  void vscode.window.showInformationMessage(explanation.headline);
}
