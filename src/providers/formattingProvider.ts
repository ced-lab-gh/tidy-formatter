// Formatting providers: the ONLY integration surface with VS Code's format
// lifecycle. We never hook save/focus/change and never set a defaultFormatter.
//
// Each provider follows the same safe pipeline:
//   1. respect `tidy.<lang>.enable` (disabled -> [] so VS Code does nothing);
//   2. respect `tidy.maxFileSizeKB` (oversized -> [] + non-blocking notice);
//   3. read the resolved options via vscodeConfig (precedence layers);
//   4. dispatch the format off the UI thread;
//   5. run the safety Guard (semantic equivalence modulo whitespace);
//   6. ONLY if equivalent, return a single TextEdit replacing the formatted span;
//      otherwise return [] (file stays intact) + a non-blocking warning and a
//      detailed entry in the Tidy output channel.
//
// This is the only file in providers/* that owns VS Code integration; all the
// engine/safety/config logic lives behind 'vscode'-free modules.
import * as vscode from 'vscode';
import type { FormatOutcome, FormatRequest, LangId, ResolvedOptions } from '../types';
import { dispatchFormat, pickEngine } from '../engine/dispatcher';
import { guard } from '../safety/guard';
import { readResolvedOptions } from '../config/vscodeConfig';

/**
 * Supported document selectors (one languageId each) for registration.
 */
export const SUPPORTED_LANGUAGES: readonly LangId[] = [
  'css',
  'scss',
  'less',
  'html',
  'json',
  'jsonc',
  'javascript',
  'typescript',
  'typescriptreact',
  'javascriptreact'
];

const SUPPORTED_LANGUAGE_SET: ReadonlySet<string> = new Set(SUPPORTED_LANGUAGES);

/**
 * Exact, user-facing message shown when the guard rejects a format. Kept as a
 * constant so the wording stays consistent (and matches the product spec).
 */
const ABORT_WARNING_MESSAGE =
  'Formatage annule: la sortie aurait casse la syntaxe — fichier intact';

const OUTPUT_CHANNEL_NAME = 'Tidy Formatter';

/**
 * Lazily-created, reused output channel for diagnostic detail. We never log the
 * document content itself — only language, engine, and an error/abort summary.
 */
let outputChannel: vscode.OutputChannel | undefined;

function getOutputChannel(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  }
  return outputChannel;
}

/**
 * Narrow a raw VS Code languageId to a supported LangId, or return undefined if
 * Tidy does not handle it. Never trust the document's languageId blindly.
 */
function toSupportedLangId(languageId: string): LangId | undefined {
  return SUPPORTED_LANGUAGE_SET.has(languageId)
    ? (languageId as LangId)
    : undefined;
}

/**
 * Read `tidy.<lang>.enable` (default true) for the given document/language. The
 * config is read scoped to the document so workspace/folder overrides apply.
 */
function isLanguageEnabled(
  document: vscode.TextDocument,
  languageId: LangId
): boolean {
  const config = vscode.workspace.getConfiguration('tidy', document.uri);
  return config.get<boolean>(`${languageId}.enable`, true);
}

/**
 * Read `tidy.maxFileSizeKB` (default 5120, 0 disables). Returns the size guard
 * limit in bytes, or undefined when the guard is disabled.
 */
function getMaxFileSizeBytes(document: vscode.TextDocument): number | undefined {
  const config = vscode.workspace.getConfiguration('tidy', document.uri);
  const maxKb = config.get<number>('maxFileSizeKB', 5120);
  if (!Number.isFinite(maxKb) || maxKb <= 0) {
    return undefined;
  }
  return maxKb * 1024;
}

/**
 * Best-effort byte size of the text using UTF-8 (matches on-disk encoding for
 * the common case and keeps the guard cheap — no document re-read).
 */
function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * Build the TextEdit that replaces a span [startOffset, endOffset) with `output`.
 */
function buildReplaceEdit(
  document: vscode.TextDocument,
  startOffset: number,
  endOffset: number,
  output: string
): vscode.TextEdit {
  const range = new vscode.Range(
    document.positionAt(startOffset),
    document.positionAt(endOffset)
  );
  return vscode.TextEdit.replace(range, output);
}

/**
 * Log a one-shot diagnostic line. Never includes document content.
 */
function logDiagnostic(
  languageId: LangId,
  engineId: string,
  summary: string
): void {
  const channel = getOutputChannel();
  const timestamp = new Date().toISOString();
  channel.appendLine(`[${timestamp}] [${languageId}] [${engineId}] ${summary}`);
}

/**
 * Run the full safe format pipeline for a given input span and return a
 * FormatOutcome. Pure orchestration over the 'vscode'-free modules; the caller
 * translates the outcome into VS Code edits / notifications.
 *
 * Never throws: any engine/guard failure is captured and reported as a
 * non-applied outcome so VS Code leaves the file untouched.
 */
async function runFormat(
  languageId: LangId,
  input: string,
  options: ResolvedOptions,
  range: { startOffset: number; endOffset: number } | undefined,
  token: vscode.CancellationToken
): Promise<FormatOutcome> {
  const engineId = pickEngine(languageId).id;

  if (token.isCancellationRequested) {
    return { applied: false, aborted: true, reason: 'cancelled', engineId };
  }

  const request: FormatRequest = {
    languageId,
    code: input,
    options,
    range
  };

  let output: string;
  try {
    output = await dispatchFormat(request);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'unknown error';
    return {
      applied: false,
      aborted: true,
      reason: `engine error: ${message}`,
      engineId
    };
  }

  if (token.isCancellationRequested) {
    return { applied: false, aborted: true, reason: 'cancelled', engineId };
  }

  // No textual change: nothing to apply, but this is a success (not an abort).
  if (output === input) {
    return { applied: false, output, engineId };
  }

  // Safety guard: never apply output that is not semantically equivalent to the
  // input (modulo whitespace/style). This is the product's core promise.
  let verdict;
  try {
    verdict = guard.check(languageId, input, output);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'unknown error';
    return {
      applied: false,
      aborted: true,
      reason: `guard error: ${message}`,
      engineId
    };
  }

  if (!verdict.equivalent) {
    return {
      applied: false,
      aborted: true,
      reason: verdict.reason ?? 'output not semantically equivalent to input',
      engineId
    };
  }

  return { applied: true, output, engineId };
}

/**
 * Translate a FormatOutcome for a whole-span replacement into VS Code edits,
 * surfacing aborts as a non-blocking warning + an output-channel detail line.
 */
function outcomeToEdits(
  document: vscode.TextDocument,
  languageId: LangId,
  startOffset: number,
  endOffset: number,
  outcome: FormatOutcome
): vscode.TextEdit[] {
  if (outcome.applied && typeof outcome.output === 'string') {
    return [buildReplaceEdit(document, startOffset, endOffset, outcome.output)];
  }

  if (outcome.aborted) {
    const engineId = outcome.engineId ?? 'unknown';
    const reason = outcome.reason ?? 'aborted';
    // A user-initiated cancellation is not an error worth nagging about.
    if (reason !== 'cancelled') {
      logDiagnostic(languageId, engineId, `aborted — ${reason}`);
      // Non-blocking, non-modal: the file is intact, we just inform.
      void vscode.window.showWarningMessage(ABORT_WARNING_MESSAGE);
    }
  }

  // No-op (output === input) or aborted: apply nothing, file stays intact.
  return [];
}

/**
 * Common entry used by both providers. Performs the enable/size pre-checks,
 * resolves options, runs the pipeline and converts the outcome to edits.
 */
async function provideEdits(
  document: vscode.TextDocument,
  formattingOptions: vscode.FormattingOptions,
  token: vscode.CancellationToken,
  range: vscode.Range | undefined
): Promise<vscode.TextEdit[]> {
  const languageId = toSupportedLangId(document.languageId);
  if (!languageId) {
    return [];
  }

  // Respect per-language opt-out: if disabled, behave as if not registered.
  if (!isLanguageEnabled(document, languageId)) {
    return [];
  }

  if (token.isCancellationRequested) {
    return [];
  }

  // Size guard: never block the UI thread on a huge document.
  const fullText = document.getText();
  const maxBytes = getMaxFileSizeBytes(document);
  if (maxBytes !== undefined && byteLength(fullText) > maxBytes) {
    const config = vscode.workspace.getConfiguration('tidy', document.uri);
    const maxKb = config.get<number>('maxFileSizeKB', 5120);
    logDiagnostic(
      languageId,
      pickEngine(languageId).id,
      `skipped — document exceeds maxFileSizeKB (${maxKb} KB)`
    );
    void vscode.window.showInformationMessage(
      `Tidy: fichier ignore (au-dela de ${maxKb} KB). Ajustez tidy.maxFileSizeKB si besoin.`
    );
    return [];
  }

  let options: ResolvedOptions;
  try {
    options = readResolvedOptions(document, languageId, formattingOptions);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'unknown error';
    logDiagnostic(languageId, 'config', `config resolution failed — ${message}`);
    // Cannot safely format without resolved options: leave the file intact.
    return [];
  }

  // Determine the input span and offsets. For range formatting we feed only the
  // selection to the engine and replace exactly that span.
  const startOffset = range ? document.offsetAt(range.start) : 0;
  const endOffset = range ? document.offsetAt(range.end) : fullText.length;
  const input = range ? document.getText(range) : fullText;

  const requestRange = range
    ? { startOffset: 0, endOffset: input.length }
    : undefined;

  const outcome = await runFormat(
    languageId,
    input,
    options,
    requestRange,
    token
  );

  if (token.isCancellationRequested) {
    return [];
  }

  return outcomeToEdits(document, languageId, startOffset, endOffset, outcome);
}

/**
 * Provider for full-document formatting.
 */
export class TidyDocumentFormattingProvider
  implements vscode.DocumentFormattingEditProvider
{
  public async provideDocumentFormattingEdits(
    document: vscode.TextDocument,
    options: vscode.FormattingOptions,
    token: vscode.CancellationToken
  ): Promise<vscode.TextEdit[]> {
    return provideEdits(document, options, token, undefined);
  }
}

/**
 * Provider for range (selection) formatting.
 */
export class TidyRangeFormattingProvider
  implements vscode.DocumentRangeFormattingEditProvider
{
  public async provideDocumentRangeFormattingEdits(
    document: vscode.TextDocument,
    range: vscode.Range,
    options: vscode.FormattingOptions,
    token: vscode.CancellationToken
  ): Promise<vscode.TextEdit[]> {
    return provideEdits(document, options, token, range);
  }
}
