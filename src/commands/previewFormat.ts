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
//     syntax), NO diff is shown and the file is left intact — we surface a
//     non-blocking message instead. Corruption is therefore impossible here too.
//   - The preview side is served by a read-only TextDocumentContentProvider
//     (scheme 'tidy-preview'); the user can never edit it, and nothing is written
//     to disk by opening the diff.
//   - Applying happens ONLY on an explicit "Apply" click, via a single
//     applyEdit(WorkspaceEdit) so one Ctrl+Z fully reverts it. No save hook, no
//     auto-apply, no defaultFormatter write.
//
// Split of concerns (so the decision logic is unit-testable without an Electron
// host): this module's TOP LEVEL imports NO 'vscode' — neither directly nor
// transitively. The pure planner `buildPreviewPlan` takes plain data (input,
// formatted, a GuardVerdict) and is covered by a plain mocha+tsx test. The VS
// Code surface ('vscode', dispatcher, guard, vscodeConfig) is required lazily
// INSIDE the handler, which only ever runs inside the extension host. A
// regression that re-introduces a top-level 'vscode' import would make the pure
// test fail to load (which is the point: commands/* touch 'vscode', but the
// planner stays testable).
import type { GuardVerdict, LangId } from '../types';

/** Command id (registered by extension.ts; this module owns only the constant). */
export const PREVIEW_FORMAT_COMMAND_ID = 'tidy.previewFormat';

/** URI scheme of the read-only virtual document holding the formatted preview. */
export const PREVIEW_SCHEME = 'tidy-preview';

/** Label of the single action button shown on the diff (explicit apply only). */
export const APPLY_BUTTON_LABEL = 'Apply';

/**
 * Surfaced verbatim when the guard rejects the formatted output: the file is
 * left intact and no diff is opened. Mirrors the provider's wording so the user
 * sees one consistent message across the format and preview paths.
 */
export const GUARD_REJECTED_REASON =
  'aucun changement applique (la sortie aurait casse la syntaxe)';

/**
 * Surfaced verbatim when formatting would change nothing: the document is
 * already tidy, so there is nothing to preview or apply.
 */
export const NO_CHANGE_REASON = 'le document est deja formate — aucun changement';

/* -------------------------------------------------------------------------- */
/* Pure planner (no 'vscode' — unit-testable under mocha + tsx)                 */
/* -------------------------------------------------------------------------- */

/**
 * The decision produced by {@link buildPreviewPlan}: whether the formatted
 * output may be previewed/applied, and (when it may not) the user-facing reason.
 * PURE data — no 'vscode' types leak here.
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
 *      fallback). This is the exact gate the providers use — the preview can
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

/**
 * Compose the user-facing rejection message. The guard's `reason` is a short,
 * code-free summary (the guard never embeds source); we prepend a stable,
 * consistent prefix so the message reads the same regardless of which guard
 * strategy fired, while still surfacing the specific cause when present.
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
  'javascriptreact'
]);

function toSupportedLangId(languageId: string): LangId | undefined {
  return SUPPORTED_LANGUAGE_SET.has(languageId)
    ? (languageId as LangId)
    : undefined;
}

/**
 * A read-only content provider for the 'tidy-preview' scheme. It serves the
 * formatted text for exactly one preview at a time, keyed by the preview URI's
 * path, so the diff's right-hand side is virtual and never written to disk. The
 * user cannot edit it (VS Code treats provider-backed documents as read-only).
 */
interface PreviewContentProvider {
  set(uriPath: string, content: string): void;
  provideTextDocumentContent(uri: { path: string }): string;
}

let previewProvider: (PreviewContentProvider & { registered: boolean }) | undefined;

/**
 * Lazily create + register the read-only preview content provider, once per
 * session. Subsequent previews reuse it and just swap the served content.
 */
function ensurePreviewProvider(vscode: any): PreviewContentProvider {
  if (previewProvider && previewProvider.registered) {
    return previewProvider;
  }

  const store = new Map<string, string>();
  const provider: PreviewContentProvider & { registered: boolean } = {
    registered: false,
    set(uriPath: string, content: string): void {
      store.set(uriPath, content);
    },
    provideTextDocumentContent(uri: { path: string }): string {
      return store.get(uri.path) ?? '';
    }
  };

  // The disposable is owned by VS Code for the session; we never unregister
  // mid-session (one provider serves every preview). This adds no save/change
  // hook — a content provider only answers reads for its own scheme.
  vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, provider);
  provider.registered = true;
  previewProvider = provider;
  return provider;
}

/**
 * Apply the formatted text to the document as a SINGLE undo entry: one
 * WorkspaceEdit replacing the whole document range. One Ctrl+Z fully reverts it.
 * Returns whether the edit was applied.
 */
async function applyFormatted(
  vscode: any,
  document: any,
  formatted: string
): Promise<boolean> {
  const fullRange = new vscode.Range(
    document.positionAt(0),
    document.positionAt(document.getText().length)
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
  formatted: string
): Promise<void> {
  const provider = ensurePreviewProvider(vscode);

  // A per-document preview path keeps the served content addressable and keeps
  // the diff title readable. We carry the languageId as a query so VS Code picks
  // the right syntax highlighting for the preview pane.
  const baseName = basenameOf(document.uri.path) || 'document';
  const previewUri = vscode.Uri.parse(
    `${PREVIEW_SCHEME}:${document.uri.path}?lang=${encodeURIComponent(languageId)}`
  );
  provider.set(previewUri.path, formatted);

  const title = `Tidy preview: ${baseName} (read-only)`;
  await vscode.commands.executeCommand(
    'vscode.diff',
    document.uri,
    previewUri,
    title,
    { preview: true }
  );

  const picked = await vscode.window.showInformationMessage(
    `Tidy: apercu pret pour ${baseName}. Cliquez "${APPLY_BUTTON_LABEL}" pour appliquer (un seul Ctrl+Z annule).`,
    APPLY_BUTTON_LABEL
  );

  if (picked !== APPLY_BUTTON_LABEL) {
    return; // dismissed — nothing written, file intact.
  }

  let applied = false;
  try {
    applied = await applyFormatted(vscode, document, formatted);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'unknown error';
    void vscode.window.showErrorMessage(
      `Tidy: impossible d'appliquer l'apercu (${message}).`
    );
    return;
  }

  if (!applied) {
    void vscode.window.showWarningMessage(
      'Tidy: l\'apercu n\'a pas pu etre applique (le document a peut-etre change).'
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
 *   2. resolve options + format via the SAME pipeline as the providers;
 *   3. run the safety guard and the pure `buildPreviewPlan`;
 *   4. if not applicable (guard rejected or no change) -> non-blocking message;
 *   5. otherwise open a read-only diff + offer a single "Apply" button writing
 *      one WorkspaceEdit (one undo entry).
 *
 * Never throws: any engine/guard/config failure is surfaced as a non-blocking
 * message so the command can't break the editor and the file stays intact.
 */
export async function previewFormat(): Promise<void> {
  const vscode = require('vscode');
  const { dispatchFormat } = require('../engine/dispatcher');
  const { guard } = require('../safety/guard');
  const { readResolvedOptions } = require('../config/vscodeConfig');

  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showInformationMessage(
      'Tidy: ouvrez un fichier pour previsualiser son formatage.'
    );
    return;
  }

  const document = editor.document;
  const languageId = toSupportedLangId(document.languageId);
  if (!languageId) {
    void vscode.window.showInformationMessage(
      `Tidy: le langage "${document.languageId}" n'est pas pris en charge.`
    );
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

  const input = document.getText();

  let formatted: string;
  let verdict: GuardVerdict;
  try {
    const options = readResolvedOptions(document, languageId, formattingOptions);
    formatted = await dispatchFormat({ languageId, code: input, options });
    // input === output short-circuits inside the guard to "equivalent"; the
    // pure planner then reports the no-change case explicitly.
    verdict = guard.check(languageId, input, formatted);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'unknown error';
    void vscode.window.showErrorMessage(
      `Tidy: impossible de preparer l'apercu (${message}).`
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

  await showDiffAndOfferApply(vscode, document, languageId, formatted);
}
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */
