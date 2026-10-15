// Command: "Tidy: Preview format" (Axe 4 / 4.T6).
//
// Shows a READ-ONLY side-by-side diff of what Tidy WOULD do to the active
// document, without touching the file, and offers an "Apply" button that writes
// the formatted text in a SINGLE undo entry (one WorkspaceEdit). This is the
// power-feature lonefy never had: see-before-you-format with an atomic undo.
//
// SAFETY / ANTI-HIJACK (NON-NEGOTIABLE):
//   - The diff is the SAME pipeline the providers use: dispatchFormat + the
//     semantic guard. If the guard rejects the output (it would have broken the
//     syntax), NO diff is shown and the file is left intact : we surface a
//     non-blocking message instead. Corruption is therefore impossible here too.
//   - The preview side is served by a read-only TextDocumentContentProvider
//     (scheme 'tidy-preview'); the user can never edit it, and nothing is written
//     to disk by opening the diff.
//   - Applying happens ONLY on an explicit "Apply" click, via a single
//     applyEdit(WorkspaceEdit) so one Ctrl+Z fully reverts it. No save hook, no
//     auto-apply, no defaultFormatter write.
//   - The text offered by "Apply" was proven equivalent to the buffer AS IT WAS
//     when the preview was computed. The diff is read-only, but the ORIGINAL
//     document is not: the user can keep typing in it while the diff is open.
//     Applying then would overwrite their edits with text the guard never
//     compared against the current buffer. So the document's version + text are
//     captured with the preview and re-checked at the very last moment before
//     the write (evaluateApplyGate): on ANY mismatch we write NOTHING and ask
//     for a fresh preview.
//
// Split of concerns (so the decision logic is unit-testable without an Electron
// host): this module's TOP LEVEL imports NO 'vscode' : neither directly nor
// transitively. The pure planner `buildPreviewPlan` takes plain data (input,
// formatted, a GuardVerdict) and is covered by a plain mocha+tsx test. The VS
// Code surface ('vscode', dispatcher, guard, vscodeConfig) is required lazily
// INSIDE the handler, which only ever runs inside the extension host. A
// regression that re-introduces a top-level 'vscode' import would make the pure
// test fail to load (which is the point: commands/* touch 'vscode', but the
// planner stays testable).
import type { GuardVerdict, LangId } from '../types';
// Type-only: the per-family size cap shape (ADD-08). src/config/sizeLimit.ts is
// itself 'vscode'-free, and this import erases at compile time either way.
import type { EffectiveSizeLimit } from '../config/sizeLimit';
// The shared, 'vscode'-free detail sanitizer: engine/parser errors (Prettier,
// babel, ...) embed a multi-line code frame carrying the user's SOURCE, which must
// never reach a notification. Every error surfaced below goes through it.
import { sanitizeDetail } from '../diagnostics/lastFormat';

/** Command id (registered by extension.ts; this module owns only the constant). */
export const PREVIEW_FORMAT_COMMAND_ID = 'tidy.previewFormat';

/** URI scheme of the read-only virtual document holding the formatted preview. */
export const PREVIEW_SCHEME = 'tidy-preview';

/* -------------------------------------------------------------------------- */
/* Preview URI identity (pure; the fix for C-10)                               */
/* -------------------------------------------------------------------------- */

/**
 * WHY EVERY PREVIEW GETS ITS OWN URI (v0.4.1, C-10).
 *
 * VS Code resolves a TextDocumentContentProvider ONCE per URI: the virtual
 * document is then cached, and only an `onDidChange` event naming that exact URI
 * makes the editor ask again. Until v0.4.1 every preview of a given file reused
 * one URI and there was no event at all, so previewing the same file twice showed
 * the FIRST preview's text in the diff while "Apply" wrote the second, current
 * one : the one thing this command exists to prevent (measured: preview 2
 * displayed ".a {\n  color: red\n}" while Apply wrote the whole two-rule file).
 *
 * Of the two available fixes, this is the URI-uniqueness one, chosen over an
 * EventEmitter + onDidChange because it cannot race: a URI that has never been
 * resolved before MUST be resolved now, so the diff cannot open on cached text no
 * matter when the host delivers events, whether an older preview of the same file
 * is still open in another tab, or how aggressively the host caches. It also adds
 * no event surface and nothing to dispose. The cost is a small bounded store of
 * recent previews (see {@link PREVIEW_STORE_LIMIT}) instead of exactly one entry.
 */

/**
 * How many recent previews the read-only provider keeps addressable. The diff
 * only ever reads the newest one; older entries are kept so a preview tab the
 * user left open still renders, and evicted beyond that so a long session cannot
 * accumulate document copies. Nothing here feeds "Apply": the text Apply writes
 * is the one captured with the preview, never a store lookup.
 */
export const PREVIEW_STORE_LIMIT = 8;

/**
 * Build the read-only preview URI for ONE invocation. PURE.
 *
 * `token` is what makes it unique, and it rides in the QUERY so the path keeps
 * naming the real file (the diff title and the preview pane's syntax highlighting
 * both read better for it). VS Code keys TextDocuments by the WHOLE URI, query
 * included, so a new token is a new document and therefore a fresh provider call.
 */
export function buildPreviewUriString(
  documentPath: string,
  languageId: string,
  token: number
): string {
  return `${PREVIEW_SCHEME}:${documentPath}?lang=${encodeURIComponent(
    languageId
  )}&v=${token}`;
}

/**
 * The provider's store key for a preview URI. PURE. It must distinguish two URIs
 * that share a path and differ only in query : keying on the path alone is
 * exactly what let one stale entry serve every preview of a file.
 */
export function previewContentKey(uri: {
  readonly path: string;
  readonly query?: string;
}): string {
  return `${uri.path}?${uri.query ?? ''}`;
}

/** Label of the single action button shown on the diff (explicit apply only). */
export const APPLY_BUTTON_LABEL = 'Apply';

/**
 * Surfaced verbatim when the guard rejects the formatted output: the file is
 * left intact and no diff is opened. Mirrors the provider's wording so the user
 * sees one consistent message across the format and preview paths.
 */
export const GUARD_REJECTED_REASON =
  'no change applied: the formatted output was not provably equivalent to your original';

/**
 * Surfaced verbatim when formatting would change nothing: the document is
 * already tidy, so there is nothing to preview or apply.
 */
export const NO_CHANGE_REASON =
  'this document is already formatted : there is nothing to change';

/**
 * Surfaced when the document already contains the template-island placeholder
 * text: masking cannot guarantee a byte-identical restore, so no preview is
 * produced and nothing is ever written (ADD-02).
 */
export const TEMPLATE_COLLISION_MESSAGE =
  'Tidy: this document collides with the template placeholder scheme, so no safe preview is possible. The file is left intact.';

/**
 * Surfaced when the engine dropped or duplicated a protected placeholder (an
 * ignore region or a template island): the restore cannot be trusted, so no
 * preview is produced and nothing is ever written (ADD-02).
 */
export const RESTORE_FAILED_MESSAGE =
  'Tidy: a protected span could not be restored exactly, so no safe preview is possible. The file is left intact.';

/* -------------------------------------------------------------------------- */
/* Pure precondition gate (ADD-03): mirrors the provider's pre-checks           */
/* -------------------------------------------------------------------------- */

/**
 * English, user-facing refusal reasons for the preview pre-gates. The handler
 * prefixes them with "Tidy: ". They mirror, in the SAME order, the pre-checks
 * the formatting provider runs (formattingProvider.ts provideEdits): disabled,
 * too-large, ignored-file, ignored-marker. The preview can therefore never
 * offer a diff that a real Format Document would refuse to produce.
 *
 * ORDER NOTE: the size check sits BEFORE the two ignore checks because ADD-08
 * moved it there in the provider (a rejected document must cost O(1) beyond
 * getText(), so no document-proportional work runs above it). The order here is
 * contractual: both surfaces must always agree on WHY nothing happened.
 */
export const PREVIEW_IGNORED_FILE_REASON =
  'no preview: this file is excluded by .soukformatignore';

export const PREVIEW_IGNORED_MARKER_REASON =
  'no preview: a top-of-file ignore marker excludes this file';

/** Refusal reason when tidy.<lang>.enable is false. */
export function previewDisabledReason(languageId: string): string {
  return `no preview: formatting for '${languageId}' is disabled (tidy.${languageId}.enable is false)`;
}

/**
 * Refusal reason when the document exceeds the effective size cap. Names the
 * cap that ACTUALLY applied (tidy.json.maxFileSizeKB for json/jsonc, the
 * generic key otherwise, ADD-08) so the user turns the right knob.
 */
export function previewTooLargeReason(
  limitKB: number,
  settingKey: string
): string {
  return `no preview: the document is larger than ${limitKB} KB (${settingKey})`;
}

/** Plain inputs to the pure precondition gate. No 'vscode' types leak here. */
export interface PreviewPreconditionInput {
  readonly languageId: string;
  /** tidy.<lang>.enable resolved for the document (default true). */
  readonly languageEnabled: boolean;
  /** UTF-8 byte length of the document text. */
  readonly byteLength: number;
  /** The effective per-family size cap (ADD-08), as the provider resolves it. */
  readonly sizeLimit: EffectiveSizeLimit;
  /** Whether .soukformatignore excludes the document (host-gated lookup). */
  readonly ignoredByFile: boolean;
  /** Whether a top-of-file ignore marker excludes the document. */
  readonly ignoredByMarker: boolean;
}

/** The gate's verdict: ok, or a refusal with its user-facing reason. */
export type PreviewPrecondition =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * Decide whether a preview may run at all. PURE: no I/O, no 'vscode' import.
 * The check ORDER is contractual: it matches provideEdits so both surfaces
 * always agree on WHY nothing happens (disabled beats size beats ignore).
 * Size uses the provider's exact semantics: strict '>' (equality passes), and
 * an undefined `limitBytes` means the cap is disabled.
 */
export function evaluatePreviewPreconditions(
  input: PreviewPreconditionInput
): PreviewPrecondition {
  if (!input.languageEnabled) {
    return { ok: false, reason: previewDisabledReason(input.languageId) };
  }
  if (
    input.sizeLimit.limitBytes !== undefined &&
    input.byteLength > input.sizeLimit.limitBytes
  ) {
    return {
      ok: false,
      reason: previewTooLargeReason(
        input.sizeLimit.limitKB,
        input.sizeLimit.settingKey
      )
    };
  }
  if (input.ignoredByFile) {
    return { ok: false, reason: PREVIEW_IGNORED_FILE_REASON };
  }
  if (input.ignoredByMarker) {
    return { ok: false, reason: PREVIEW_IGNORED_MARKER_REASON };
  }
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* Pure planner (no 'vscode' : unit-testable under mocha + tsx)                 */
/* -------------------------------------------------------------------------- */

/**
 * The decision produced by {@link buildPreviewPlan}: whether the formatted
 * output may be previewed/applied, and (when it may not) the user-facing reason.
 * PURE data : no 'vscode' types leak here.
 */
export interface PreviewPlan {
  /** True only when there is a real, guard-approved change to show + apply. */
  readonly canApply: boolean;
  /**
   * Present only when `canApply` is false: a non-blocking, user-facing
   * explanation (guard rejection summary, or "already formatted").
   */
  readonly reason?: string;
}

/**
 * Decide whether a formatted output can be previewed and applied. PURE: no I/O,
 * no 'vscode' import, fully unit-testable.
 *
 * Rules (in order):
 *   1. The guard is authoritative. If it did NOT find the output equivalent to
 *      the input, the output would change the file's meaning / break its syntax,
 *      so we refuse: `canApply:false` with the guard's own reason (or a stable
 *      fallback). This is the exact gate the providers use : the preview can
 *      never apply something the normal format path would reject.
 *   2. A guard-approved output that is byte-identical to the input is a no-op:
 *      there is nothing to preview, so `canApply:false` with NO_CHANGE_REASON.
 *   3. Otherwise there is a real, safe change: `canApply:true`, no reason.
 *
 * @param input         the document's current text.
 * @param formatted     the engine's output for that text.
 * @param guardVerdict  the safety guard's verdict on (input -> formatted).
 */
export function buildPreviewPlan(
  input: string,
  formatted: string,
  guardVerdict: GuardVerdict
): PreviewPlan {
  if (!guardVerdict.equivalent) {
    return {
      canApply: false,
      reason: guardRejectionReason(guardVerdict)
    };
  }

  if (formatted === input) {
    return { canApply: false, reason: NO_CHANGE_REASON };
  }

  return { canApply: true };
}

/* -------------------------------------------------------------------------- */
/* Pure staleness gate: the last check before ANY write                         */
/* -------------------------------------------------------------------------- */

/**
 * Surfaced verbatim when the document moved on while the read-only diff was
 * open. Nothing is written in that case: the safe action is a fresh preview of
 * the text as it is now.
 */
export const STALE_PREVIEW_MESSAGE =
  'Tidy: the document changed while the preview was open, so nothing was applied. Run the preview again to check and apply a diff of the current text.';

/** What the preview captured, and what the document looks like at Apply time. */
export interface PreviewApplyGateInput {
  /** document.version when the preview was computed (undefined if unavailable). */
  readonly previewVersion: number | undefined;
  /** document.version at the moment "Apply" was clicked. */
  readonly currentVersion: number | undefined;
  /** The exact text the guard proved the formatted output equivalent to. */
  readonly previewInput: string;
  /** The document's text at the moment "Apply" was clicked. */
  readonly currentText: string;
}

/** ok, or a refusal carrying the user-facing reason. */
export type PreviewApplyDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * Decide whether the previewed text may still be written. PURE: no I/O, no
 * 'vscode' import, fully unit-testable.
 *
 * The guard proved `formatted` equivalent to `previewInput`, NOT to whatever the
 * buffer holds now. So this gate refuses unless BOTH still hold:
 *   1. the version counter is unchanged (VS Code's authoritative "did this
 *      document change" signal, which also catches an edit that was typed and
 *      undone), and
 *   2. the text is byte-identical to what was verified (belt and braces: it
 *      stands on its own if a host ever reports no version at all, in which case
 *      both versions are undefined and only the text comparison speaks).
 *
 * A refusal means ZERO edits. Never a partial write, never a "best effort".
 */
export function evaluateApplyGate(
  input: PreviewApplyGateInput
): PreviewApplyDecision {
  if (input.previewVersion !== input.currentVersion) {
    return { ok: false, reason: STALE_PREVIEW_MESSAGE };
  }
  if (input.previewInput !== input.currentText) {
    return { ok: false, reason: STALE_PREVIEW_MESSAGE };
  }
  return { ok: true };
}

/**
 * Compose the user-facing rejection message. The guard's `reason` is a SHORT,
 * single-line summary : it keeps the parser's own first line and drops the
 * multi-line code frame under it, which is where a parser prints an excerpt of
 * the file. It is NOT source-free, and this comment used to claim it was.
 * A parser routinely NAMES the token it choked on in that first line, so the
 * reason really can quote a few characters of the user's document, for example:
 *   "input did not parse: Identifier 'CLIENT_SECRET_abc123' has already been
 *   declared. (2:7)" (babel), or
 *   "input did not parse: <css input>:1:9: Unknown word CLIENT_SECRET_abc123"
 *   (postcss).
 * README ("No silent failures") discloses exactly this, and the two statements
 * must stay in agreement : nothing ELSE of the document is ever recorded, and
 * `sanitizeDetail` still caps the whole thing at one line of 200 characters.
 * Making the redaction stronger would be a behaviour change, not a comment fix.
 *
 * We prepend a stable, consistent prefix so the message reads the same
 * regardless of which guard strategy fired, while still surfacing the specific
 * cause when present.
 */
function guardRejectionReason(verdict: GuardVerdict): string {
  const detail = verdict.reason?.trim();
  return detail && detail.length > 0
    ? `${GUARD_REJECTED_REASON} : ${detail}`
    : GUARD_REJECTED_REASON;
}

/* -------------------------------------------------------------------------- */
/* VS Code handler (loads 'vscode' lazily; runs only in the extension host)     */
/* -------------------------------------------------------------------------- */

// The handler types VS Code values loosely: the module must not import 'vscode'
// statically (that would break the pure test), so we load it (and the
// 'vscode'-free engine/guard/config modules, plus the 'vscode'-bound config
// reader) lazily via require() inside the handler. The integration suite (real
// host) exercises this path end to end.
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */

/**
 * The languageIds Tidy can preview-format. Mirrors the provider list; kept local
 * so this command stays self-contained (importing the provider at top level
 * would pull in 'vscode' and break the pure test).
 */
const SUPPORTED_LANGUAGE_SET: ReadonlySet<string> = new Set<LangId>([
  'css',
  'scss',
  'less',
  'html',
  'json',
  'jsonc',
  'javascript',
  'typescript',
  'typescriptreact',
  'javascriptreact',
  'vue'
]);

function toSupportedLangId(languageId: string): LangId | undefined {
  return SUPPORTED_LANGUAGE_SET.has(languageId)
    ? (languageId as LangId)
    : undefined;
}

/**
 * A read-only content provider for the 'tidy-preview' scheme. It serves the
 * formatted text of the most recent previews, keyed by the preview URI's FULL
 * identity (path + query, see {@link previewContentKey}), so the diff's
 * right-hand side is virtual and never written to disk. The user cannot edit it
 * (VS Code treats provider-backed documents as read-only).
 */
interface PreviewContentProvider {
  set(key: string, content: string): void;
  provideTextDocumentContent(uri: { path: string; query?: string }): string;
}

let previewProvider: (PreviewContentProvider & { registered: boolean }) | undefined;

/**
 * Monotonic per-session counter making each preview URI unique (C-10). A counter
 * rather than a clock: two previews within the same millisecond must still get
 * different URIs, and a deterministic sequence is testable.
 */
let previewToken = 0;

/**
 * Lazily create + register the read-only preview content provider, once per
 * session. Subsequent previews reuse it and add their own entry: entries are
 * never overwritten (each preview owns a unique URI) and the oldest are evicted
 * past {@link PREVIEW_STORE_LIMIT}.
 */
function ensurePreviewProvider(vscode: any): PreviewContentProvider {
  if (previewProvider && previewProvider.registered) {
    return previewProvider;
  }

  const store = new Map<string, string>();
  const provider: PreviewContentProvider & { registered: boolean } = {
    registered: false,
    set(key: string, content: string): void {
      store.set(key, content);
      // Map iterates in insertion order, so the first key is the oldest preview.
      while (store.size > PREVIEW_STORE_LIMIT) {
        const oldest = store.keys().next();
        if (oldest.done === true) {
          break;
        }
        store.delete(oldest.value);
      }
    },
    provideTextDocumentContent(uri: { path: string; query?: string }): string {
      return store.get(previewContentKey(uri)) ?? '';
    }
  };

  // The disposable is owned by VS Code for the session; we never unregister
  // mid-session (one provider serves every preview). This adds no save/change
  // hook : a content provider only answers reads for its own scheme.
  vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, provider);
  provider.registered = true;
  previewProvider = provider;
  return provider;
}

/**
 * Read a document's version counter defensively. VS Code always provides a
 * number; anything else becomes undefined so the gate falls back to comparing
 * the text rather than silently trusting a bogus value.
 */
function readDocumentVersion(document: any): number | undefined {
  return typeof document?.version === 'number' ? document.version : undefined;
}

/**
 * Apply the formatted text to the document as a SINGLE undo entry: one
 * WorkspaceEdit replacing the whole document range. One Ctrl+Z fully reverts it.
 * Returns whether the edit was applied.
 *
 * `verifiedInput` is the text the caller has just re-proved the document still
 * holds (evaluateApplyGate). The replaced range is derived from ITS length, not
 * from a fresh read of the document, so the span written is exactly the span
 * that was verified. There is no await between the gate and this call, so no
 * edit can interleave.
 */
async function applyFormatted(
  vscode: any,
  document: any,
  verifiedInput: string,
  formatted: string
): Promise<boolean> {
  const fullRange = new vscode.Range(
    document.positionAt(0),
    document.positionAt(verifiedInput.length)
  );
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, fullRange, formatted);
  return vscode.workspace.applyEdit(edit);
}

/**
 * Open a read-only side-by-side diff (original vs. formatted) and, on an explicit
 * "Apply" click, write the formatted text in one undo entry. The original side
 * is the real document URI; the formatted side is the virtual 'tidy-preview' URI.
 */
async function showDiffAndOfferApply(
  vscode: any,
  document: any,
  languageId: LangId,
  input: string,
  formatted: string,
  previewVersion: number | undefined
): Promise<void> {
  const provider = ensurePreviewProvider(vscode);

  // A per-document preview path keeps the served content addressable and keeps
  // the diff title readable. We carry the languageId as a query so VS Code picks
  // the right syntax highlighting for the preview pane, plus a per-invocation
  // token so THIS preview is a document the host has never resolved before and
  // must therefore read from us now (C-10: without it, preview 2 of a file showed
  // preview 1's cached text while Apply wrote preview 2's).
  const baseName = basenameOf(document.uri.path) || 'document';
  previewToken += 1;
  const previewUri = vscode.Uri.parse(
    buildPreviewUriString(document.uri.path, languageId, previewToken)
  );
  provider.set(previewContentKey(previewUri), formatted);

  const title = `Tidy preview: ${baseName} (read-only)`;
  await vscode.commands.executeCommand(
    'vscode.diff',
    document.uri,
    previewUri,
    title,
    { preview: true }
  );

  const picked = await vscode.window.showInformationMessage(
    `Tidy: preview ready for ${baseName}. Click "${APPLY_BUTTON_LABEL}" to apply it (a single Ctrl+Z reverts it).`,
    APPLY_BUTTON_LABEL
  );

  if (picked !== APPLY_BUTTON_LABEL) {
    return; // dismissed : nothing written, file intact.
  }

  // LAST CHECK BEFORE ANY WRITE. The diff is read-only, the ORIGINAL document is
  // not: the user may have kept typing while it was open. `formatted` was proven
  // equivalent to `input`, so applying it over a buffer that has moved on would
  // destroy their edits with text the guard never validated against it. On any
  // mismatch we write NOTHING and ask for a fresh preview.
  const gate = evaluateApplyGate({
    previewVersion,
    currentVersion: readDocumentVersion(document),
    previewInput: input,
    currentText: document.getText()
  });
  if (!gate.ok) {
    void vscode.window.showWarningMessage(gate.reason);
    return; // ZERO edits.
  }

  let applied = false;
  try {
    applied = await applyFormatted(vscode, document, input, formatted);
  } catch (error: unknown) {
    const detail =
      error instanceof Error ? sanitizeDetail(error.message) : 'unknown error';
    void vscode.window.showErrorMessage(
      `Tidy: could not apply the preview (${detail}).`
    );
    return;
  }

  if (!applied) {
    void vscode.window.showWarningMessage(
      'Tidy: the preview could not be applied (the document may have changed).'
    );
  }
}

/** The trailing path segment of a URI path, for a human-readable diff title. */
function basenameOf(path: string): string {
  const segments = path.split('/');
  return segments[segments.length - 1] ?? '';
}

/**
 * Handler for "Tidy: Preview format".
 *
 * Flow (every apply step user-initiated; opening the diff writes nothing):
 *   1. resolve the active editor's language (bail with a notice if unsupported);
 *   1b. run the SAME pre-gates as the providers, in the same order (enable,
 *      size, .soukformatignore, head marker); any refusal ends here with a
 *      non-blocking reason and no diff (ADD-03);
 *   2. resolve options + format via the SAME pipeline as the providers;
 *   3. run the safety guard and the pure `buildPreviewPlan`;
 *   4. if not applicable (guard rejected or no change) -> non-blocking message;
 *   5. otherwise open a read-only diff + offer a single "Apply" button writing
 *      one WorkspaceEdit (one undo entry), AFTER re-checking that the document
 *      is still exactly the text the guard validated; if it moved on, nothing
 *      is written and the user is asked to preview again.
 *
 * Never throws: any engine/guard/config failure is surfaced as a non-blocking
 * message so the command can't break the editor and the file stays intact.
 */
export async function previewFormat(): Promise<void> {
  const vscode = require('vscode');
  const { dispatchFormat } = require('../engine/dispatcher');
  const { guard } = require('../safety/guard');
  const { readResolvedOptions, readSizeLimit } = require('../config/vscodeConfig');
  const { buildMaskPlan } = require('../engine/maskPlan');
  const { resolveDocumentIgnore } = require('../ignore/ignoreGate');
  const { scanMarkers } = require('../ignore/markers');

  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showInformationMessage(
      'Tidy: open a file to preview how it would be formatted.'
    );
    return;
  }

  const document = editor.document;
  const languageId = toSupportedLangId(document.languageId);
  if (!languageId) {
    void vscode.window.showInformationMessage(
      `Tidy: the language "${document.languageId}" is not supported.`
    );
    return;
  }

  // ADD-03 prerequisite: honour the SAME pre-gates as the providers
  // (enable / size / ignore-file / ignore-marker), in the SAME order, BEFORE any
  // engine or config work, so the diff can only ever show what a real Format
  // Document would do. READ-ONLY: a preview is an inspection, not a format
  // attempt, so nothing is recorded (overwriting the lastFormat record would
  // falsify "Explain last format") and nothing is written.
  const input = document.getText();
  // Captured TOGETHER with `input`: the pair (version, text) is what the guard's
  // verdict is about, and what evaluateApplyGate re-checks just before writing.
  const previewVersion = readDocumentVersion(document);
  const tidyConfig = vscode.workspace.getConfiguration('tidy', document.uri);
  const precondition = evaluatePreviewPreconditions({
    languageId,
    // Truthiness, exactly like the provider's isLanguageEnabled: any falsy
    // value disables, so a hand-edited settings.json cannot make the preview
    // and Format Document disagree.
    languageEnabled: Boolean(tidyConfig.get(`${languageId}.enable`, true)),
    byteLength: Buffer.byteLength(input, 'utf8'),
    sizeLimit: readSizeLimit(document, languageId),
    ignoredByFile: resolveDocumentIgnore(document).ignored === true,
    ignoredByMarker: scanMarkers(input, languageId).ignoreFile === true
  });
  if (!precondition.ok) {
    void vscode.window.showInformationMessage(`Tidy: ${precondition.reason}`);
    return;
  }

  // Synthesize the FormattingOptions VS Code would inject, from the editor.
  const tabSize =
    typeof editor.options.tabSize === 'number' ? editor.options.tabSize : 4;
  const insertSpaces =
    typeof editor.options.insertSpaces === 'boolean'
      ? editor.options.insertSpaces
      : true;
  const formattingOptions = { tabSize, insertSpaces };

  let formatted: string;
  let verdict: GuardVerdict;
  try {
    const options = readResolvedOptions(document, languageId, formattingOptions);
    if (options.failClosed !== undefined) {
      // Same refusal as Format Document: the .soukformatrc overrides could not be
      // fully evaluated, so the options may be wrong.
      void vscode.window.showInformationMessage(
        'Tidy: the overrides of the .soukformatrc could not be fully evaluated, so the file is left alone.'
      );
      return;
    }
    // Same protect-and-restore plan as the providers (ignore regions + HTML
    // template islands): without it, previewing a template file would SHOW, and
    // Apply would WRITE, islands reflowed in ways the guard cannot see, because
    // whitespace inside an HTML text node is normalised away before comparison
    // (CFG-04 / ADD-02).
    const plan = buildMaskPlan(languageId, input, 'document');
    if (plan.abortReason !== undefined) {
      void vscode.window.showInformationMessage(TEMPLATE_COLLISION_MESSAGE);
      return;
    }
    const rawOutput = await dispatchFormat({
      languageId,
      code: plan.mask ? plan.mask.engineInput : input,
      options
    });
    if (plan.mask) {
      const restored = plan.mask.restore(rawOutput);
      if (!restored.ok) {
        void vscode.window.showInformationMessage(RESTORE_FAILED_MESSAGE);
        return;
      }
      formatted = restored.text;
    } else {
      formatted = rawOutput;
    }
    // input === output short-circuits inside the guard to "equivalent"; the
    // pure planner then reports the no-change case explicitly.
    verdict = guard.check(languageId, input, formatted);
  } catch (error: unknown) {
    // NEVER surface a raw engine message: a Prettier/babel parse error carries a
    // code frame with the user's own source. sanitizeDetail keeps the first line
    // only and caps its length.
    const detail =
      error instanceof Error ? sanitizeDetail(error.message) : 'unknown error';
    void vscode.window.showErrorMessage(
      `Tidy: could not prepare the preview (${detail}).`
    );
    return;
  }

  const plan = buildPreviewPlan(input, formatted, verdict);
  if (!plan.canApply) {
    void vscode.window.showInformationMessage(
      `Tidy: ${plan.reason ?? GUARD_REJECTED_REASON}`
    );
    return;
  }

  await showDiffAndOfferApply(
    vscode,
    document,
    languageId,
    input,
    formatted,
    previewVersion
  );
}
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */
