// Formatting providers: the ONLY integration surface with VS Code's format
// lifecycle. We never hook save/focus/change and never set a defaultFormatter.
//
// Each provider follows the same safe pipeline:
//   1. respect `tidy.<lang>.enable` (disabled -> [] so VS Code does nothing);
//   2. respect the per-family size cap (tidy.json.maxFileSizeKB for json/jsonc,
//      tidy.maxFileSizeKB otherwise; oversized -> [] + non-blocking notice);
//   3. consult the IGNORE layer (Axe 4): if .soukformatignore matches the file OR
//      an in-source FILE-ignore marker is present -> [] (Tidy does nothing here);
//   4. read the resolved options via vscodeConfig (precedence layers);
//   5. dispatch the format off the UI thread : for the js-beautify path, in-source
//      ignore REGIONS are protected with mask/restore (whole document AND
//      selection), and for HTML, TEMPLATE ISLANDS ({{ }}, {% %}, <% %>, head
//      front matter '---') are masked too so the engine can never reflow inside
//      them (CFG-04); every protected byte is put back VERBATIM, with a checked
//      restore (a dropped or duplicated placeholder aborts with zero edits); for
//      the Prettier path, Prettier honours `// prettier-ignore` natively, so no
//      region masking is done, and a tidy-ignore marker found there is REPORTED
//      to the user (output channel + Explain) instead of being ignored silently;
//   6. run the safety Guard (semantic equivalence modulo whitespace) on the
//      ORIGINAL input vs the (restored) output : so neither a region splice nor
//      an island restore can ever slip a non-equivalent result through. A
//      SELECTION is spliced back into its document first, so the guard judges
//      the edit with the ancestors it really sits under and a verdict cannot
//      depend on how much of the file the user happened to select;
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
  resolveEngineIdForSource,
  dispatchCssFallback,
  CSS_FALLBACK_LANGS
} from '../engine/dispatcher';
import { guard } from '../safety/guard';
import { readResolvedOptions, readSizeLimit } from '../config/vscodeConfig';
import { describeSizeLimit } from '../config/sizeLimit';
import { scanMarkers } from '../ignore/markers';
import {
  buildMaskPlan,
  engineSpanFor,
  engineTextFor,
  type EngineMask
} from '../engine/maskPlan';
import {
  JS_BEAUTIFY_ENGINE_ID,
  reportedEngineIdFor
} from '../engine/jsbeautify';
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
 * Turn the adapter id that will really print into the id to SHOW the user: the
 * js-beautify adapter routes json/jsonc to the jsonc-parser printer, so its
 * adapter id would name a library that never ran. Reporting only: routing still
 * compares the adapter's own `id`.
 */
function displayNameForEngine(engineId: string, languageId: LangId): string {
  return engineId === JS_BEAUTIFY_ENGINE_ID
    ? reportedEngineIdFor(languageId)
    : engineId;
}

/**
 * The engine id to SHOW the user for a language AND the exact source the engine
 * will be handed.
 *
 * Content matters: `pickEngine` is content-blind and always answers js-beautify
 * for `javascript`, but a .js file containing JSX is re-routed to Prettier by
 * the dispatcher, so the status bar, the output channel and "Explain Last
 * Format" all named an engine that did not run. `resolveEngineIdForSource` is
 * the dispatcher's OWN routing answer, so the reported name and the printer that
 * really runs cannot drift.
 *
 * `code` must be the very text handed to the engine (masked text for a masked
 * format, the selection for a selection): the dispatcher routes on that string,
 * so reporting from anything else would re-open the same gap.
 *
 * Known cost, accepted deliberately: for a .js whose content must be inspected,
 * the JSX detector's parse runs here and again inside dispatchFormat (measured
 * at ~12-21 % on top of a JSX .js format, and at nothing at all for every other
 * language, where the answer is O(1)). Naming an engine that did not run is the
 * worse defect of the two. Removing the second parse means memoising the
 * detection inside the dispatcher, which owns that routing.
 */
function reportedEngineId(languageId: LangId, code: string): string {
  return displayNameForEngine(
    resolveEngineIdForSource(languageId, code),
    languageId
  );
}

/**
 * The engine id to SHOW when the source must NOT be inspected: the only caller
 * is the too-large branch, where Tidy has just declined to process the file
 * BECAUSE of its size. Routing a multi-megabyte file through the JSX detector's
 * full Babel parse there, purely to label a format that will not happen, would
 * spend exactly the work the size cap exists to refuse. No engine runs on that
 * path, so the language's default adapter is the honest answer.
 */
function reportedEngineIdForLanguage(languageId: LangId): string {
  return displayNameForEngine(pickEngine(languageId).id, languageId);
}

/**
 * The text surrounding the span being formatted, inside the document it lives
 * in. Empty on both sides for a whole-document format.
 *
 * This exists because a verdict must not depend on how much of the file the user
 * happened to select. `htmlShape` starts its walk with "not inside a verbatim
 * element", which is true of a document root and FALSE of a selection sitting
 * inside <pre>, <textarea> or <pre><code>: judged as a context-free fragment,
 * a collapse of rendered whitespace looked like insignificant whitespace, the
 * guard said equivalent, and the edit was applied. The very same textual change
 * was correctly rejected when the whole document was formatted.
 *
 * Splicing the candidate back into its document before the guard runs restores
 * the context the ancestors provide, so document scope and selection scope ask
 * the guard the SAME question and can only get the same answer. It is never
 * weaker than the fragment comparison: the fragment's own tree is still fully
 * compared, with the ancestors added on top.
 */
interface GuardContext {
  readonly prefix: string;
  readonly suffix: string;
}

/** Context of a whole-document format: the span already IS the document. */
const WHOLE_DOCUMENT_CONTEXT: GuardContext = { prefix: '', suffix: '' };

/** Place a candidate span back into the document it will be written into. */
function inDocumentContext(context: GuardContext, span: string): string {
  return context.prefix + span + context.suffix;
}

/**
 * Append a content-free notice line to the Tidy output channel, in the same
 * shape as a format record line. Used when a documented directive present in the
 * text is NOT applied by the active path: staying silent there would be the
 * defect, so this is written whatever the format outcome turns out to be.
 */
function appendChannelNotice(
  document: vscode.TextDocument,
  languageId: string,
  notice: string
): void {
  getTidyOutputChannel().appendLine(
    `[${new Date().toISOString()}] ${basenameFromPath(document.uri.path)} ` +
      `[${languageId}] notice: ${sanitizeDetail(notice)}`
  );
}

/** Combine two content-free details into one single-line string. */
function joinDetail(
  first: string | undefined,
  second: string | undefined
): string | undefined {
  if (first === undefined) return second;
  if (second === undefined) return first;
  return `${first}; ${second}`;
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
 * `scope` decides whether the engine is given a RANGE. A selection is formatted
 * as a range covering the whole engine-facing text (which keeps the engines'
 * "not the end of the document" rules, e.g. no final-newline policy). Both the
 * text and the range are derived HERE from the same (input, mask) pair, so the
 * engine can never be handed a range expressed in a different string's
 * coordinate space (see engineSpanFor).
 *
 * `guardContext` carries the text on either side of the span inside the real
 * document, so the guard judges the EDIT in the document it lands in rather than
 * an out-of-context fragment (see GuardContext). It is empty for a whole
 * document, where the span already is the document.
 *
 * Never throws: any engine/guard failure is captured and reported as a
 * non-applied outcome so VS Code leaves the file untouched.
 */
async function runFormat(
  languageId: LangId,
  input: string,
  options: ResolvedOptions,
  scope: FormatScope,
  token: vscode.CancellationToken,
  guardContext: GuardContext,
  mask?: EngineMask
): Promise<FormatOutcome> {
  // The engine routes on the text it is handed, so the reported name is derived
  // from that same text and never from the language alone.
  const engineText = engineTextFor(input, mask);
  const engineId = reportedEngineId(languageId, engineText);

  if (token.isCancellationRequested) {
    return { applied: false, aborted: true, reason: 'cancelled', engineId };
  }

  const range =
    scope === 'selection' ? engineSpanFor(input, mask) : undefined;

  const request: FormatRequest = {
    languageId,
    code: engineText,
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

  // Yield once so the cancellation RPC macrotask can be processed, THEN check
  // the token: on the synchronous engine path the await continuation is a
  // microtask, so without this yield isCancellationRequested can never turn
  // true before the CPU-bound guard runs. On a 5-10 MB JSON document the guard
  // is the second largest cost after the engine; skipping it on cancel keeps
  // the extension host responsive. Cancelling here writes NOTHING: without an
  // `equivalent` verdict no edit is ever produced (see outcomeToEdits).
  await new Promise<void>((resolve) => setImmediate(resolve));
  if (token.isCancellationRequested) {
    return { applied: false, aborted: true, reason: 'cancelled', engineId };
  }

  // Safety guard: never apply output that is not semantically equivalent to the
  // ORIGINAL input (modulo whitespace/style). This is the product's core promise,
  // and it validates the restored output : corruption is therefore impossible.
  // Both sides are put back into the surrounding document first, so a selection
  // is judged with the ancestors it really sits under (GuardContext).
  let verdict;
  try {
    verdict = guard.check(
      languageId,
      inDocumentContext(guardContext, input),
      inDocumentContext(guardContext, output)
    );
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
      scope,
      token,
      guardContext,
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
  scope: FormatScope,
  token: vscode.CancellationToken,
  guardContext: GuardContext,
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
    // Same coordinate-space rule as runFormat: the range is derived from the
    // very text handed to the fallback engine, never from the caller's input.
    rawOutput = await dispatchCssFallback({
      languageId,
      code: engineTextFor(input, mask),
      options,
      range: scope === 'selection' ? engineSpanFor(input, mask) : undefined
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
    // Same document context as the primary check: the second candidate is asked
    // exactly the same question, never a laxer one.
    verdict = guard.check(
      languageId,
      inDocumentContext(guardContext, input),
      inDocumentContext(guardContext, output)
    );
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

  // Size guard, resolved PER FAMILY and BEFORE any work proportional to the
  // document (ignore lookup, marker scan, engine, guard). json/jsonc get their
  // own, higher cap because their format path is linear and their guard is a
  // cheap value equality (see src/config/sizeLimit.ts). A rejected document
  // costs O(1) beyond getText().
  const fullText = document.getText();
  const sizeLimit = readSizeLimit(document, languageId);
  const maxKb = sizeLimit.limitKB;
  if (
    sizeLimit.limitBytes !== undefined &&
    byteLength(fullText) > sizeLimit.limitBytes
  ) {
    recordOutcome(document, languageId, scope, 'too-large', {
      engineId: reportedEngineIdForLanguage(languageId),
      detail: describeSizeLimit(sizeLimit)
    });
    // English per the v0.3.0 string migration; the button opens the Settings UI
    // filtered to the cap that actually applied (opens UI only, never writes).
    void vscode.window
      .showInformationMessage(
        `Tidy skipped this file: it is larger than ${maxKb} KB ` +
          `(${sizeLimit.settingKey}). Raise that setting, or set it to 0, to format it.`,
        ACTION_OPEN_SETTINGS_LABEL
      )
      .then((picked: string | undefined) => {
        if (picked === ACTION_OPEN_SETTINGS_LABEL) {
          void vscode.commands.executeCommand(
            OPEN_SETTINGS_COMMAND_ID,
            sizeLimit.settingKey
          );
        }
      });
    return [];
  }

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
  // ONE marker scan per attempt, over the WHOLE document: it answers the
  // file-level question here and is handed to the mask plan below, so a
  // selection sees the region markers that live outside it and no document is
  // ever scanned twice.
  const markerScan = scanMarkers(fullText, languageId);
  if (markerScan.ignoreFile) {
    recordOutcome(document, languageId, scope, 'ignored-marker');
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

  // Build the protect-and-restore plan:
  //   - in-source ignore REGIONS: the js-beautify path, BOTH scopes. The marker
  //     ranges come from the document scan above and are clipped to the span
  //     being formatted, so a selection is protected by the same mechanic as a
  //     whole document (a region opened above the selection still protects the
  //     part of it that reaches inside);
  //   - HTML TEMPLATE ISLANDS ({{ }}, {% %}, <% %>) and the head FRONT MATTER
  //     block: both scopes, because an engine reflow INSIDE an island is
  //     whitespace-only in a text node and therefore invisible to the guard
  //     (CFG-04). BOTH are located in the DOCUMENT and clipped to the span
  //     exactly like a region range: an island is only self-delimiting while
  //     both delimiters are visible, so a selection cutting between `<%` and
  //     `%>` used to find nothing and let the engine reflow the interior, and
  //     the guard accepted it. Passing `fullText` here is what makes the promise
  //     scope-invariant, so Format Selection and formatOnSaveMode
  //     "modifications" protect exactly what Format Document protects.
  // A placeholder collision means no clean restore can be guaranteed, so the
  // only safe move is to decline formatting entirely (zero edits, file intact).
  const plan = buildMaskPlan(languageId, input, scope, {
    markerScan,
    inputOffset: startOffset,
    documentText: fullText
  });

  // A tidy-ignore marker the active path cannot apply is reported, never passed
  // over in silence: the channel line lands whatever the outcome below is, and
  // the same sentence is carried into the record so "Explain Last Format" and
  // "Show Format History" repeat it.
  if (plan.unhonouredIgnore !== undefined) {
    appendChannelNotice(document, languageId, plan.unhonouredIgnore);
  }

  if (plan.abortReason !== undefined) {
    return outcomeToEdits(document, languageId, scope, startOffset, endOffset, {
      applied: false,
      aborted: true,
      reason: plan.abortReason,
      // The mask could not be built, so the engine text does not exist: the span
      // the user asked for is the closest honest basis for the routing answer.
      engineId: reportedEngineId(languageId, input)
    });
  }

  // A selection is judged inside its document, never as a free-standing fragment
  // (GuardContext). For a whole document both sides are empty, so the guard is
  // handed byte-for-byte what it was handed before.
  const guardContext: GuardContext =
    range === undefined
      ? WHOLE_DOCUMENT_CONTEXT
      : {
          prefix: fullText.slice(0, startOffset),
          suffix: fullText.slice(endOffset)
        };

  const outcome = await runFormat(
    languageId,
    input,
    options,
    scope,
    token,
    guardContext,
    plan.mask
  );

  if (token.isCancellationRequested) {
    recordOutcome(document, languageId, scope, 'cancelled', {
      engineId: outcome.engineId
    });
    return [];
  }

  // New object, never a mutation of the outcome the pipeline returned.
  const reported: FormatOutcome =
    plan.unhonouredIgnore === undefined
      ? outcome
      : { ...outcome, detail: joinDetail(outcome.detail, plan.unhonouredIgnore) };

  return outcomeToEdits(document, languageId, scope, startOffset, endOffset, reported);
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
