// Formatting providers: the ONLY integration surface with VS Code's format
// lifecycle. We never hook save/focus/change and never set a defaultFormatter.
//
// Each provider follows the same safe pipeline:
//   1. respect `tidy.<lang>.enable` (disabled -> [] so VS Code does nothing);
//   2. respect `tidy.maxFileSizeKB` (oversized -> [] + non-blocking notice);
//   3. consult the IGNORE layer (Axe 4): if .soukformatignore matches the file OR
//      an in-source FILE-ignore marker is present -> [] (Tidy does nothing here);
//   4. read the resolved options via vscodeConfig (precedence layers);
//   5. dispatch the format off the UI thread : for the js-beautify path, in-source
//      ignore REGIONS are protected with mask/restore, and for HTML, TEMPLATE
//      ISLANDS ({{ }}, {% %}, <% %>, head front matter '---') are masked too so
//      the engine can never reflow inside them (CFG-04); every protected byte is
//      put back VERBATIM, with a checked restore (a dropped or duplicated
//      placeholder aborts with zero edits); for the Prettier path, Prettier
//      honours `// prettier-ignore` natively, so no region masking is needed;
//   6. run the safety Guard (semantic equivalence modulo whitespace) on the
//      ORIGINAL input vs the (restored) output : so neither a region splice nor
//      an island restore can ever slip a non-equivalent result through;
//   6b. for css/scss/less ONLY, a guard REJECTION triggers one independent
//      second attempt through Prettier's postcss parser, whose output is put
//      through the same restore and the same fresh guard check (ADD-01). Any
//      failure of that second attempt keeps the original rejection verbatim;
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
import {
  dispatchFormat,
  pickEngine,
  dispatchCssFallback,
  CSS_FALLBACK_LANGS
} from '../engine/dispatcher';
import { guard } from '../safety/guard';
import { readResolvedOptions } from '../config/vscodeConfig';
import { scanMarkers } from '../ignore/markers';
import { buildMaskPlan, type EngineMask } from '../engine/maskPlan';
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
import {
  EXPLAIN_LAST_FORMAT_COMMAND_ID,
  OPEN_SETTINGS_COMMAND_ID,
  ACTION_OPEN_SETTINGS_LABEL
} from '../commands/explainLastFormat';
import { REPORT_ISSUE_COMMAND_ID } from '../commands/reportIssue';

/**
 * Supported document selectors (one languageId each) for registration.
 */
export const SUPPORTED_LANGUAGES: readonly LangId[] = SUPPORTED_LANG_IDS;

const SUPPORTED_LANGUAGE_SET: ReadonlySet<string> = new Set(SUPPORTED_LANGUAGES);

/**
 * Exact, user-facing message shown when a format is aborted (guard rejection,
 * engine error, or a failed ignore-region restore). Kept as a constant so the
 * wording stays consistent (and matches the product spec). English per the
 * v0.3.0 string migration (ADD-06); no em dash, ever.
 */
const ABORT_WARNING_MESSAGE =
  'Tidy did not apply the format: the result could not be proven equivalent to your original. Your file is intact.';

/** Button captions on the abort toast (exact labels from the ADD-06 spec). */
const ABORT_ACTION_EXPLAIN = 'Explain';
const ABORT_ACTION_REPORT_ISSUE = 'Report Issue';

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
 * the common case and keeps the guard cheap : no document re-read).
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
  // Template-island collision (pre-engine) and island restore failure (ADD-02):
  // both are "a protected span could not be guaranteed verbatim", the exact
  // meaning of the existing 'restore-failed' status. No new FormatStatus, so the
  // Explain command's exhaustive switch keeps compiling.
  if (reason.startsWith('template-island')) return 'restore-failed';
  return 'guard-rejected';
}

/**
 * Run the full safe format pipeline for a given input span and return a
 * FormatOutcome. Pure orchestration over the 'vscode'-free modules; the caller
 * translates the outcome into VS Code edits / notifications.
 *
 * `input` is the ORIGINAL span text and is always what the safety guard compares
 * the final output against. When `mask` is provided, the engine instead formats
 * `mask.engineInput` (with ignore regions replaced by placeholders) and the
 * output is restored verbatim via `mask.restore` BEFORE the guard runs : so a
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
  mask?: EngineMask
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

  // Restore protected spans verbatim (template islands first, then ignore
  // regions). A failed restore (placeholder dropped or duplicated by the engine)
  // is fail-safe: abort so the file is left intact.
  let output = rawOutput;
  if (mask) {
    const restored = mask.restore(rawOutput);
    if (!restored.ok) {
      return {
        applied: false,
        aborted: true,
        reason: restored.reason,
        engineId
      };
    }
    output = restored.text;
  }

  // No textual change: nothing to apply, but this is a success (not an abort).
  if (output === input) {
    return { applied: false, output, engineId };
  }

  // Safety guard: never apply output that is not semantically equivalent to the
  // ORIGINAL input (modulo whitespace/style). This is the product's core promise,
  // and it validates the restored output : corruption is therefore impossible.
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
    const primaryReason =
      verdict.reason ?? 'output not semantically equivalent to input';
    // ADD-01: ONE independent second chance for the CSS family, still fully
    // under the guard. Any fallback failure keeps the primary rejection
    // untouched, so today's behaviour is the worst case, never worse.
    const fallback = await tryCssFallback(
      languageId,
      input,
      options,
      range,
      token,
      mask
    );
    if (fallback) {
      return fallback;
    }
    return {
      applied: false,
      aborted: true,
      reason: primaryReason,
      engineId
    };
  }

  return { applied: true, output, engineId };
}

/**
 * Second-chance format for the CSS family (ADD-01): called ONLY after the guard
 * rejected the js-beautify candidate. Re-runs the SAME (possibly masked) input
 * through the Prettier postcss engine, restores protected spans verbatim, and
 * re-runs the guard on the result. The guard therefore stays the single final
 * judge on BOTH candidates.
 *
 * Return contract:
 *  - applied outcome (engineId 'prettier', detail 'fallback-postcss') when the
 *    guard accepted a CHANGED second candidate;
 *  - no-op success outcome when the second candidate is byte-identical to the
 *    input (the file already IS the fallback engine's canonical form; this keeps
 *    the pipeline idempotent: formatting a fallback-formatted file again is a
 *    clean 'already-tidy', not a warning toast);
 *  - cancelled outcome when the token fired around the second pass;
 *  - undefined for EVERY other failure (engine error, restore failure, guard
 *    rejection, guard exception): the caller keeps the primary guard-rejected
 *    outcome with its original reason.
 */
async function tryCssFallback(
  languageId: LangId,
  input: string,
  options: ResolvedOptions,
  range: { startOffset: number; endOffset: number } | undefined,
  token: vscode.CancellationToken,
  mask?: EngineMask
): Promise<FormatOutcome | undefined> {
  if (!CSS_FALLBACK_LANGS.has(languageId)) {
    return undefined;
  }
  if (token.isCancellationRequested) {
    return {
      applied: false,
      aborted: true,
      reason: 'cancelled',
      engineId: 'prettier'
    };
  }

  let rawOutput: string;
  try {
    rawOutput = await dispatchCssFallback({
      languageId,
      code: mask ? mask.engineInput : input,
      options,
      range
    });
  } catch {
    return undefined;
  }

  if (token.isCancellationRequested) {
    return {
      applied: false,
      aborted: true,
      reason: 'cancelled',
      engineId: 'prettier'
    };
  }

  let output = rawOutput;
  if (mask) {
    const restored = mask.restore(rawOutput);
    if (!restored.ok) {
      return undefined;
    }
    output = restored.text;
  }

  if (output === input) {
    return {
      applied: false,
      output,
      engineId: 'prettier',
      detail: 'fallback-postcss'
    };
  }

  let verdict;
  try {
    verdict = guard.check(languageId, input, output);
  } catch {
    return undefined;
  }
  if (!verdict.equivalent) {
    return undefined;
  }

  return {
    applied: true,
    output,
    engineId: 'prettier',
    detail: 'fallback-postcss'
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
      engineId: outcome.engineId,
      detail: outcome.detail
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
      // Non-blocking, non-modal: the file is intact, we just inform. Same toast
      // frequency as before (guard-rejected / engine-error / restore-failed);
      // ADD-06 only adds one-click remedies. recordOutcome ran just above, so
      // 'Explain' explains exactly THIS abort. Fire-and-forget: never blocks the
      // provider, never hangs a headless host.
      void vscode.window
        .showWarningMessage(
          ABORT_WARNING_MESSAGE,
          ABORT_ACTION_EXPLAIN,
          ABORT_ACTION_REPORT_ISSUE
        )
        .then((picked: string | undefined) => {
          if (picked === ABORT_ACTION_EXPLAIN) {
            void vscode.commands.executeCommand(EXPLAIN_LAST_FORMAT_COMMAND_ID);
          } else if (picked === ABORT_ACTION_REPORT_ISSUE) {
            void vscode.commands.executeCommand(REPORT_ISSUE_COMMAND_ID);
          }
        });
    }
    return [];
  }

  // No-op: the engine produced output identical to the input.
  recordOutcome(document, languageId, scope, 'already-tidy', {
    engineId: outcome.engineId,
    detail: outcome.detail
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

  // Ignore layer (Axe 4) : consulted BEFORE any formatting work:
  //   (a) .soukformatignore matches this file -> Tidy does nothing here;
  //   (b) an in-source FILE-ignore marker (tidy-ignore-file / a head
  //       tidy-ignore / prettier-ignore) is present -> leave the file verbatim.
  // Both return [] so VS Code applies no edit and the file is byte-identical.
  // (REGION-level ignore is handled later, around the engine call, via masking.)
  // Capture the lookup so the record carries WHICH .soukformatignore excluded the
  // file: "Explain last format" turns that into a one-click "Open" action. Same
  // call, same position in the pipeline: the formatting decision is unchanged.
  const ignoreLookup = resolveDocumentIgnore(document);
  if (ignoreLookup.ignored) {
    recordOutcome(document, languageId, scope, 'ignored-file', {
      detail: ignoreLookup.path
    });
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
    // English per the v0.3.0 string migration; the button opens the Settings UI
    // filtered to the size limit (opens UI only, never writes the setting).
    void vscode.window
      .showInformationMessage(
        `Tidy skipped this file: it is larger than ${maxKb} KB (tidy.maxFileSizeKB).`,
        ACTION_OPEN_SETTINGS_LABEL
      )
      .then((picked: string | undefined) => {
        if (picked === ACTION_OPEN_SETTINGS_LABEL) {
          void vscode.commands.executeCommand(
            OPEN_SETTINGS_COMMAND_ID,
            'tidy.maxFileSizeKB'
          );
        }
      });
    return [];
  }

  let options: ResolvedOptions;
  try {
    options = readResolvedOptions(document, languageId, formattingOptions);
  } catch (error: unknown) {
    // Same content-free discipline as the engine/guard paths: keep the first line
    // only, so a multi-line payload can never reach the record or the channel.
    recordOutcome(document, languageId, scope, 'config-error', {
      engineId: 'config',
      detail: firstLineOf(error)
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

  // Build the protect-and-restore plan:
  //   - in-source ignore REGIONS: full-document js-beautify path only (range
  //     formatting keeps its pre-existing no-region-masking behaviour: region
  //     semantics are ambiguous inside a user selection);
  //   - HTML TEMPLATE ISLANDS ({{ }}, {% %}, <% %>, head front matter): both
  //     scopes, because an engine reflow INSIDE an island is whitespace-only in
  //     a text node and therefore invisible to the guard (CFG-04).
  // A placeholder collision means no clean restore can be guaranteed, so the
  // only safe move is to decline formatting entirely (zero edits, file intact).
  const plan = buildMaskPlan(languageId, input, range ? 'selection' : 'document');
  if (plan.abortReason !== undefined) {
    return outcomeToEdits(document, languageId, scope, startOffset, endOffset, {
      applied: false,
      aborted: true,
      reason: plan.abortReason,
      engineId: pickEngine(languageId).id
    });
  }

  const outcome = await runFormat(
    languageId,
    input,
    options,
    requestRange,
    token,
    plan.mask
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
