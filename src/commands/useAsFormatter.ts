// Command: "Tidy: Use Tidy as my formatter" (Axe 1 / 1.T2).
//
// ANTI-HIJACK (ARCH-02, SPEC §5/§12) : NON-NEGOTIABLE:
//   - We ONLY write a setting in response to an explicit user action (the user
//     ticks languages in a QuickPick and confirms a scope). Cancelling at any
//     step writes NOTHING.
//   - We write `editor.defaultFormatter` (overrideInLanguage) per chosen
//     language. `editor.formatOnSave` is written ONLY inside the separate,
//     optional format-on-save step (formatOnSaveOptIn.ts), ONLY after the user
//     confirms a modal recap of the exact keys, and it ships a one-click Revert.
//   - There is no auto-set at boot, no save/change/watcher hook : this command
//     is invoked only from the Command Palette.
//
// Split of concerns (so the decision logic is unit-testable without an Electron
// host): this module's TOP LEVEL imports NO 'vscode' : neither directly nor
// transitively : so `planUseAsFormatter` can be imported by a pure mocha+tsx
// test. The VS Code surface (`vscode`, and the provider's SUPPORTED_LANGUAGES)
// is required lazily INSIDE the handler functions, which only ever run inside the
// extension host. This keeps the codebase rule intact: commands/* are the layer
// that touches 'vscode', but the pure planner stays testable.
import type { LangId } from '../types';
import {
  setDefaultFormatterForLangs,
  type WriteTarget
} from './setDefaultFormatter';
// The shared, 'vscode'-free detail sanitizer: a settings-write failure can carry a
// multi-line payload, which must never reach a notification verbatim.
import { sanitizeDetail } from '../diagnostics/lastFormat';

/** Command id (registered by extension.ts; this module owns only the constant). */
export const USE_AS_FORMATTER_COMMAND_ID = 'tidy.useAsFormatter';

// Re-export the shared identifier + scope type so existing importers (the pure
// unit test) keep their import path. The single source of truth lives in
// ./setDefaultFormatter, shared with the migration flow (1.T4).
export { EXTENSION_ID, type WriteTarget } from './setDefaultFormatter';

/**
 * The languages Tidy can be made the default formatter for. This MUST mirror
 * `SUPPORTED_LANGUAGES` from providers/formattingProvider.ts; the integration
 * suite asserts the two lists are identical so they can never drift. It is
 * duplicated here (rather than imported) only because importing the provider at
 * module top level would pull in 'vscode' and break the pure unit test : the
 * provider's list remains the single runtime source the QuickPick is built from.
 */
const SUPPORTED_LANGUAGES: readonly LangId[] = [
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
 * The plan produced by {@link planUseAsFormatter}: the concrete writes the
 * handler should perform. PURE data : no 'vscode' types leak here.
 */
export interface UseAsFormatterPlan {
  /** Scope the override is written at. */
  target: WriteTarget;
  /** Languages to set Tidy as the default formatter for (validated, de-duped). */
  langs: LangId[];
  /**
   * Present only when something the user should know happened, e.g. there is no
   * workspace so the override falls back to the Global (User) scope.
   */
  warning?: string;
}

/** Surfaced verbatim when a chosen Workspace scope is impossible (no folder). */
export const NO_WORKSPACE_WARNING =
  'No workspace folder is open : Tidy was set as your default formatter in your ' +
  'User settings instead of the workspace.';

/**
 * Decide the concrete write plan from the user's raw choices. PURE: no I/O, no
 * 'vscode' import, fully unit-testable.
 *
 * Rules:
 *   - `picked` is filtered to genuinely supported languageIds and de-duplicated
 *     (order preserved) so an unexpected/duplicate entry can never widen the
 *     write surface.
 *   - `target` is the caller's requested scope when a workspace exists; with no
 *     workspace, a Workspace write is impossible so we fall back to Global and
 *     attach a `warning` so the handler can surface it.
 *   - A caller asking for Global explicitly keeps Global with no warning (it is
 *     not a surprising fallback, it was the request).
 *
 * @param picked          languageIds the user ticked (may contain junk/dupes).
 * @param hasWorkspace    whether a workspace folder is open.
 * @param requestedTarget the scope the user chose ('workspace' default).
 */
export function planUseAsFormatter(
  picked: readonly string[],
  hasWorkspace: boolean,
  requestedTarget: WriteTarget = 'workspace'
): UseAsFormatterPlan {
  const langs = dedupeSupported(picked);

  // Workspace scope is only meaningful with an open folder. Falling back from a
  // *requested* Workspace write to Global is the only case worth warning about.
  if (requestedTarget === 'workspace' && !hasWorkspace) {
    return { target: 'global', langs, warning: NO_WORKSPACE_WARNING };
  }

  return { target: requestedTarget, langs };
}

/**
 * Keep only supported languageIds, preserving first-seen order and dropping
 * duplicates. Returns a fresh array (never mutates the input).
 */
function dedupeSupported(picked: readonly string[]): LangId[] {
  const seen = new Set<string>();
  const result: LangId[] = [];
  for (const candidate of picked) {
    if (!SUPPORTED_LANGUAGE_SET.has(candidate) || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    result.push(candidate as LangId);
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/* VS Code handler (loads 'vscode' lazily; runs only in the extension host)     */
/* -------------------------------------------------------------------------- */

// The handler types VS Code values as `any` deliberately: the module must not
// import 'vscode' statically (that would break the pure test), so we cannot name
// its types here. The integration suite (real host) is what exercises this path.
// We load 'vscode' (and the provider) lazily via require(); both no-require-imports
// and no-var-requires are disabled for this host-only section.
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */

interface ScopeChoice {
  label: string;
  description: string;
  target: WriteTarget;
}

/**
 * Ask the user which languages Tidy should become the default formatter for.
 * Pre-ticks the active editor's language when it is supported. Returns the
 * chosen languageIds, or undefined if the user cancelled (Escape / dismiss).
 *
 * The QuickPick is built from the provider's SUPPORTED_LANGUAGES (the single
 * runtime source of truth), required lazily here.
 */
async function pickLanguages(
  vscode: any,
  activeLanguageId: string | undefined
): Promise<string[] | undefined> {
  const provider = require('../providers/formattingProvider');
  const languages: readonly string[] = provider.SUPPORTED_LANGUAGES;

  const items = languages.map((lang) => ({
    label: lang,
    picked: lang === activeLanguageId
  }));

  const selection = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: 'Use Tidy as your default formatter',
    placeHolder:
      'Select the languages Tidy should format by default (Space to toggle, Enter to confirm)'
  });

  if (!selection) {
    return undefined;
  }
  return (selection as Array<{ label: string }>).map((item) => item.label);
}

/**
 * Ask the user where the override should be written. Workspace is the default
 * (least intrusive). Returns the chosen scope, or undefined if cancelled.
 */
async function pickScope(vscode: any): Promise<WriteTarget | undefined> {
  const choices: ScopeChoice[] = [
    {
      label: 'Workspace',
      description: 'This project only (recommended)',
      target: 'workspace'
    },
    {
      label: 'User',
      description: 'All your projects',
      target: 'global'
    }
  ];

  const choice = (await vscode.window.showQuickPick(choices, {
    title: 'Where should this apply?',
    placeHolder: 'Choose the scope for the default-formatter setting'
  })) as ScopeChoice | undefined;

  return choice?.target;
}

/**
 * Write Tidy as the per-language `editor.defaultFormatter` for the planned
 * languages. Delegates to the shared core so the migration flow (1.T4) writes
 * the formatter through the EXACT same path. Sets ONLY defaultFormatter.
 */
async function applyPlan(vscode: any, plan: UseAsFormatterPlan): Promise<void> {
  await setDefaultFormatterForLangs(vscode, plan.langs, plan.target);
}

/**
 * Handler for "Tidy: Use Tidy as my formatter".
 *
 * Flow (every step user-initiated; any cancel = zero writes):
 *   1. multi-select QuickPick of supported languages (active language pre-ticked);
 *   2. QuickPick of scope (Workspace default / User);
 *   3. plan via the pure planner;
 *   4. write `editor.defaultFormatter` per chosen language (overrideInLanguage);
 *   5. optional format-on-save step (QuickPick, modal recap, confirmed write,
 *      revert button); every branch ends on a non-modal success message.
 *
 * Never throws: any write failure is surfaced as a non-blocking error so the
 * command can't break the editor.
 */
export async function useAsFormatter(): Promise<void> {
  const vscode = require('vscode');

  const activeLanguageId = vscode.window.activeTextEditor?.document.languageId;

  const picked = await pickLanguages(vscode, activeLanguageId);
  if (picked === undefined) {
    return; // cancelled : no write
  }
  if (picked.length === 0) {
    void vscode.window.showInformationMessage(
      'Tidy: no language selected : nothing was changed.'
    );
    return;
  }

  const requestedTarget = await pickScope(vscode);
  if (requestedTarget === undefined) {
    return; // cancelled : no write
  }

  const hasWorkspace =
    (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
  const plan = planUseAsFormatter(picked, hasWorkspace, requestedTarget);

  // The planner only keeps supported languages; if every pick was filtered out
  // there is nothing to write.
  if (plan.langs.length === 0) {
    void vscode.window.showInformationMessage(
      'Tidy: no supported language selected : nothing was changed.'
    );
    return;
  }

  try {
    await applyPlan(vscode, plan);
  } catch (error: unknown) {
    const detail =
      error instanceof Error ? sanitizeDetail(error.message) : 'unknown error';
    void vscode.window.showErrorMessage(
      `Tidy: could not save the default formatter (${detail}).`
    );
    return;
  }

  if (plan.warning) {
    void vscode.window.showWarningMessage(plan.warning);
  }

  // Optional, separately-confirmed format-on-save step (ADD-04). It owns the
  // success toast for every branch and writes editor.formatOnSave ONLY after
  // its own modal recap is confirmed; cancelling it writes nothing further.
  const { runFormatOnSaveStep } = require('./formatOnSaveOptIn');
  await runFormatOnSaveStep(vscode, plan.langs, plan.target);
}
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */
