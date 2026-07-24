// Formatting providers: the ONLY integration surface with VS Code's format
// lifecycle. We never hook save/focus/change and never set a defaultFormatter.
//
// Each provider follows the same safe pipeline:
//   1. respect `tidy.<lang>.enable` (disabled -> [] so VS Code does nothing);
//   2. respect `tidy.maxFileSizeKB` (oversized -> [] + non-blocking notice);
//   3. consult the IGNORE layer (Axe 4): if .soukformatignore matches the file OR
//      an in-source FILE-ignore marker is present -> [] (Tidy does nothing here);
//   4. read the resolved options via vscodeConfig (precedence layers);
//   5. dispatch the format off the UI thread — for the js-beautify path, in-source
//      ignore REGIONS are protected with mask/restore (the protected bytes are put
//      back VERBATIM); for the Prettier path, Prettier honours `// prettier-ignore`
//      natively, so no masking is needed;
//   6. run the safety Guard (semantic equivalence modulo whitespace) on the
//      ORIGINAL input vs the (restored) output — so a region splice can never
//      slip a non-equivalent or non-parsable result through;
//   7. ONLY if equivalent, return a single TextEdit replacing the formatted span;
//      otherwise return [] (file stays intact) + a non-blocking warning and a
//      detailed entry in the Tidy output channel.
//
// This is the only file in providers/* that owns VS Code integration; all the
// engine/safety/config/ignore logic lives behind 'vscode'-free modules (the
// .soukformatignore lookup is gated by a tiny Workspace-Trust seam, ignoreGate).
import * as vscode from 'vscode';
import type { FormatOutcome, FormatRequest, LangId, ResolvedOptions } from '../types';
import { SUPPORTED_LANG_IDS } from '../types';
import { dispatchFormat, pickEngine } from '../engine/dispatcher';
import { guard } from '../safety/guard';
import { readResolvedOptions } from '../config/vscodeConfig';
import { scanMarkers } from '../ignore/markers';
import { applyMask, restoreMask } from '../ignore/mask';
import { resolveDocumentIgnore } from '../ignore/ignoreGate';
import { getTidyOutputChannel } from '../diagnostics/outputChannel';
import {
  recordLastFormat,
  formatChannelLine,
  sanitizeDetail,
  type FormatStatus,
  type FormatScope,
  type LastFormatRecord
} from '../diagnostics/lastFormat';

/**
 * Supported document selectors (one languageId each) for registration.
 */
export const SUPPORTED_LANGUAGES: readonly LangId[] = SUPPORTED_LANG_IDS;

const SUPPORTED_LANGUAGE_SET: ReadonlySet<string> = new Set(SUPPORTED_LANGUAGES);

/**
 * Languages whose engine does NOT natively honour in-source ignore directives, so
 * Tidy protects `tidy-ignore-start`/`-end` regions itself via mask/restore. These
 * are the js-beautify languages. The Prettier path (typescript / typescriptreact
 * / javascriptreact, and plain javascript that gets re-routed to Prettier for JSX)
 * honours `// prettier-ignore` natively at the NODE level, so we never mask there
 * — masking would be redundant and Prettier's own directive support is richer.
 * Region masking for the Prettier path is a documented v1 limitation (no
 * corruption either way: the guard validates whatever the engine produced).
 */
const REGION_MASKING_LANGUAGES: ReadonlySet<LangId> = new Set<LangId>([
  'css',
  'scss',
  'less',
  'html',
  'json',
  'jsonc',
  'javascript'
]);

/**
 * Exact, user-facing message shown when the guard rejects a format. Kept as a
 * constant so the wording stays consistent (and matches the product spec).
 */
const ABORT_WARNING_MESSAGE =
  'Formatage annule: la sortie aurait casse la syntaxe, fichier intact';

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

/** Basename of a URI path (no 'vscode' path util needed). */
function basenameFromPath(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

/**
 * First line of an error message only. Engine/parser errors (Prettier, babel, ...)
 * can embed a multi-line code frame containing the user's SOURCE after the first
 * line; we must never surface that in a stored/logged/displayed record. The detail
 * is sanitized again downstream (sanitizeDetail); we also strip at the source.
 */
function firstLineOf(error: unknown): string {
  const message = error instanceof Error ? error.message : 'unknown error';
  return message.split('\n', 1)[0].trim();
}

/**
 * Record the outcome of a format attempt (the single most-recent record) AND append
 * a concise, content-free line to the shared "Tidy Formatter" output channel. Every
 * exit point below calls this, so a no-op always has a stored, explainable reason:
 * that is what powers "Tidy: Explain last format".
 */
function recordOutcome(
  document: vscode.TextDocument,
  languageId: string,
  scope: FormatScope,
  status: FormatStatus,
  extra?: { engineId?: string; detail?: string }
): void {
  const record: LastFormatRecord = {
    uri: document.uri.toString(),
    fileName: basenameFromPath(document.uri.path),
    languageId,
    status,
    scope,
    engineId: extra?.engineId,
    detail: extra?.detail !== undefined ? sanitizeDetail(extra.detail) : undefined,
    at: new Date().toISOString()
  };
  recordLastFormat(record);
  getTidyOutputChannel().appendLine(formatChannelLine(record));
}

/**
 * Map an aborted FormatOutcome's reason (produced in runFormat, this file) to a
 * FormatStatus. Kept beside runFormat so the two never drift.
 */
function statusFromReason(reason: string): FormatStatus {
  if (reason.startsWith('engine error')) return 'engine-error';
  if (reason.startsWith('guard error')) return 'engine-error';
  if (reason.startsWith('ignore-region restore failed')) return 'restore-failed';
  return 'guard-rejected';
}

/**
 * How an in-source region mask should be applied around the engine call.
 *  - `engineInput`  : the (possibly masked) text actually sent to the engine;
 *  - `restore`      : maps the engine output back to the verbatim-restored text,
 *                     or undefined when the restore is unsafe (placeholder
 *                     missing/duplicated) — in which case we abort (file intact).
 * When absent, the engine input is the original input and no restore runs.
 */
interface RegionMask {
  readonly engineInput: string;
  readonly restore: (engineOutput: string) => string | undefined;
}

/**
 * Run the full safe format pipeline for a given input span and return a
 * FormatOutcome. Pure orchestration over the 'vscode'-free modules; the caller
 * translates the outcome into VS Code edits / notifications.
 *
 * `input` is the ORIGINAL span text and is always what the safety guard compares
 * the final output against. When `mask` is provided, the engine instead formats
 * `mask.engineInput` (with ignore regions replaced by placeholders) and the
 * output is restored verbatim via `mask.restore` BEFORE the guard runs — so a
 * region splice can never apply a non-equivalent or non-parsable result.
 *
 * Never throws: any engine/guard failure is captured and reported as a
 * non-applied outcome so VS Code leaves the file untouched.
 */
async function runFormat(
  languageId: LangId,
  input: string,
  options: ResolvedOptions,
  range: { startOffset: number; endOffset: number } | undefined,
  token: vscode.CancellationToken,
  mask?: RegionMask
): Promise<FormatOutcome> {
  const engineId = pickEngine(languageId).id;

  if (token.isCancellationRequested) {
    return { applied: false, aborted: true, reason: 'cancelled', engineId };
  }

  const request: FormatRequest = {
    languageId,
    code: mask ? mask.engineInput : input,
    options,
    range
  };

  let rawOutput: string;
  try {
    rawOutput = await dispatchFormat(request);
  } catch (error: unknown) {
    return {
      applied: false,
      aborted: true,
      reason: `engine error: ${firstLineOf(error)}`,
      engineId
    };
  }

  if (token.isCancellationRequested) {
    return { applied: false, aborted: true, reason: 'cancelled', engineId };
  }

  // Restore protected regions verbatim. A failed restore (placeholder dropped or
  // duplicated by the engine) is fail-safe: abort so the file is left intact.
  let output = rawOutput;
  if (mask) {
    const restored = mask.restore(rawOutput);
    if (restored === undefined) {
      return {
        applied: false,
        aborted: true,
        reason: 'ignore-region restore failed (placeholder altered by engine)',
        engineId
      };
    }
    output = restored;
  }

  // No textual change: nothing to apply, but this is a success (not an abort).
  if (output === input) {
    return { applied: false, output, engineId };
  }

  // Safety guard: never apply output that is not semantically equivalent to the
  // ORIGINAL input (modulo whitespace/style). This is the product's core promise,
  // and it validates the restored output — corruption is therefore impossible.
  let verdict;
  try {
    verdict = guard.check(languageId, input, output);
  } catch (error: unknown) {
    return {
      applied: false,
      aborted: true,
      reason: `guard error: ${firstLineOf(error)}`,
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
 * Build a RegionMask for the full-document js-beautify path from the in-source
 * ignore markers, or undefined when there is nothing to protect (no regions) or
 * masking is unsafe (placeholder collision). When undefined, the caller formats
 * the document normally (no masking). PURE orchestration over the mask module.
 */
function buildRegionMask(
  languageId: LangId,
  input: string
): RegionMask | undefined {
  if (!REGION_MASKING_LANGUAGES.has(languageId)) {
    return undefined; // Prettier path honours `// prettier-ignore` natively.
  }
  const scan = scanMarkers(input, languageId);
  if (scan.protectedRanges.length === 0) {
    return undefined;
  }
  const masked = applyMask(input, scan.protectedRanges);
  if (masked === undefined) {
    return undefined; // collision / malformed ranges -> format normally.
  }
  return {
    engineInput: masked.masked,
    restore: (engineOutput) => restoreMask(engineOutput, masked.restorations)
  };
}

/**
 * Translate a FormatOutcome for a whole-span replacement into VS Code edits,
 * recording the outcome (for "Explain last format") and surfacing aborts as a
 * non-blocking warning.
 */
function outcomeToEdits(
  document: vscode.TextDocument,
  languageId: LangId,
  scope: FormatScope,
  startOffset: number,
  endOffset: number,
  outcome: FormatOutcome
): vscode.TextEdit[] {
  if (outcome.applied && typeof outcome.output === 'string') {
    recordOutcome(document, languageId, scope, 'applied', {
      engineId: outcome.engineId
    });
    return [buildReplaceEdit(document, startOffset, endOffset, outcome.output)];
  }

  if (outcome.aborted) {
    const engineId = outcome.engineId ?? 'unknown';
    const reason = outcome.reason ?? 'aborted';
    // A user-initiated cancellation is not an error worth nagging about.
    if (reason === 'cancelled') {
      recordOutcome(document, languageId, scope, 'cancelled', { engineId });
    } else {
      recordOutcome(document, languageId, scope, statusFromReason(reason), {
        engineId,
        detail: reason
      });
      // Non-blocking, non-modal: the file is intact, we just inform.
      void vscode.window.showWarningMessage(ABORT_WARNING_MESSAGE);
    }
    return [];
  }

  // No-op: the engine produced output identical to the input.
  recordOutcome(document, languageId, scope, 'already-tidy', {
    engineId: outcome.engineId
  });
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
  const scope: FormatScope = range ? 'selection' : 'document';

  const languageId = toSupportedLangId(document.languageId);
  if (!languageId) {
    recordOutcome(document, document.languageId, scope, 'unsupported');
    return [];
  }

  // Respect per-language opt-out: if disabled, behave as if not registered.
  if (!isLanguageEnabled(document, languageId)) {
    recordOutcome(document, languageId, scope, 'disabled');
    return [];
  }

  if (token.isCancellationRequested) {
    recordOutcome(document, languageId, scope, 'cancelled');
    return [];
  }

  // Size guard: never block the UI thread on a huge document.
  const fullText = document.getText();

  // Ignore layer (Axe 4) — consulted BEFORE any formatting work:
  //   (a) .soukformatignore matches this file -> Tidy does nothing here;
  //   (b) an in-source FILE-ignore marker (tidy-ignore-file / a head
  //       tidy-ignore / prettier-ignore) is present -> leave the file verbatim.
  // Both return [] so VS Code applies no edit and the file is byte-identical.
  // (REGION-level ignore is handled later, around the engine call, via masking.)
  if (resolveDocumentIgnore(document).ignored) {
    recordOutcome(document, languageId, scope, 'ignored-file');
    return [];
  }
  if (scanMarkers(fullText, languageId).ignoreFile) {
    recordOutcome(document, languageId, scope, 'ignored-marker');
    return [];
  }
  const maxBytes = getMaxFileSizeBytes(document);
  if (maxBytes !== undefined && byteLength(fullText) > maxBytes) {
    const config = vscode.workspace.getConfiguration('tidy', document.uri);
    const maxKb = config.get<number>('maxFileSizeKB', 5120);
    recordOutcome(document, languageId, scope, 'too-large', {
      engineId: pickEngine(languageId).id,
      detail: String(maxKb)
    });
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
    recordOutcome(document, languageId, scope, 'config-error', {
      engineId: 'config',
      detail: message
    });
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

  // Protect in-source ignore REGIONS for the full-document js-beautify path only.
  // Range formatting is a user-selected span where region semantics are ambiguous,
  // so we keep it simple (no masking) — the guard still protects against any
  // corruption regardless.
  const mask = range ? undefined : buildRegionMask(languageId, input);

  const outcome = await runFormat(
    languageId,
    input,
    options,
    requestRange,
    token,
    mask
  );

  if (token.isCancellationRequested) {
    recordOutcome(document, languageId, scope, 'cancelled', {
      engineId: outcome.engineId
    });
    return [];
  }

  return outcomeToEdits(document, languageId, scope, startOffset, endOffset, outcome);
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
