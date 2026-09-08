// Command: "Tidy: Use Tidy as my formatter" (Axe 1 / 1.T2).
//
// ANTI-HIJACK (ARCH-02, SPEC §5/§12) : NON-NEGOTIABLE:
//   - We ONLY write a setting in response to an explicit user action (the user
//     ticks languages in a QuickPick, confirms a scope, THEN confirms a modal
//     recap listing the exact keys, values and scope). Cancelling at any step
//     writes NOTHING.
//   - We write `editor.defaultFormatter` (overrideInLanguage) per chosen
//     language, and ONLY after that recap is confirmed (v0.4.0: before, this
//     path wrote straight after the two QuickPicks, which made the README's
//     "shows you the exact keys first" promise false for the single most
//     sensitive write the extension performs).
//     `editor.formatOnSave` is written ONLY inside the separate, optional
//     format-on-save step (formatOnSaveOptIn.ts), ONLY after the user confirms
//     its own modal recap, and it ships a one-click Revert. Both recaps share
//     one mechanism (scopeLabelOf + the same header/promise wording) so they
//     cannot drift apart.
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
  EXTENSION_ID,
  readCurrentDefaultFormatterValues,
  setDefaultFormatterForLangs,
  type WriteTarget
} from './setDefaultFormatter';
// The recap mechanism is SHARED with the format-on-save opt-in, not re-invented:
// the same scope wording (`scopeLabelOf`), the same "exactly these keys" header
// and the same "Nothing has been changed yet" promise, so the two consent paths
// cannot drift apart. formatOnSaveOptIn.ts has no top-level 'vscode' import
// either, so importing it here keeps the pure planner unit-testable.
import { scopeLabelOf } from './formatOnSaveOptIn';
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
   * Present only when something the user should know applies, e.g. there is no
   * workspace so the override falls back to the Global (User) scope. A CODE, not
   * a sentence : see {@link PlanWarningCode}.
   */
  warningCode?: PlanWarningCode;
}

/* -------------------------------------------------------------------------- */
/* Warnings: ONE reason code, TWO tenses (before the write, and after it)       */
/* -------------------------------------------------------------------------- */

/**
 * Why a plan carries a warning. A CODE, never a ready-made sentence.
 *
 * The TENSE of a warning belongs to the moment it is rendered, not to the plan.
 * A plan is built BEFORE anything is written and is also the thing the pre-write
 * modal is rendered from, so storing finished-action prose in it is what put the
 * claim "Tidy was set as your default formatter in your User settings" inside
 * the confirmation dialog, one line above "Nothing has been changed yet." : the
 * dialog asserting a write that had not happened, in the one dialog whose whole
 * purpose is to be believed before a write.
 *
 * With a code, the plan states the REASON and each renderer below owns exactly
 * one tense, so the pre-write dialog cannot physically show past-tense text.
 */
export type PlanWarningCode = 'workspace-fallback';

/**
 * PRE-WRITE wording: rendered INSIDE the confirmation modal, where NOTHING has
 * been written yet. Conditional/future : it describes what WOULD happen if the
 * user confirms, and stays true next to "Nothing has been changed yet."
 */
export const NO_WORKSPACE_PENDING_WARNING =
  'No workspace folder is open, so a Workspace write is not possible: if you ' +
  'confirm, Tidy will be set as your default formatter in your User settings ' +
  'instead of the workspace.';

/**
 * POST-WRITE wording: shown ONLY after the confirmed write actually succeeded,
 * so the past tense is a report, not a promise.
 */
export const NO_WORKSPACE_WRITTEN_WARNING =
  'No workspace folder is open : Tidy was set as your default formatter in ' +
  'your User settings instead of the workspace.';

/**
 * The two tenses of every warning code, in one table. A `Record` keyed by the
 * code makes it IMPOSSIBLE to add a warning without giving it both a pre-write
 * and a post-write wording, which is the invariant this whole shape exists for.
 */
const WARNING_TEXTS: Readonly<
  Record<PlanWarningCode, { readonly pending: string; readonly written: string }>
> = {
  'workspace-fallback': {
    pending: NO_WORKSPACE_PENDING_WARNING,
    written: NO_WORKSPACE_WRITTEN_WARNING
  }
};

/**
 * The sentence to show BEFORE any write (inside the modal recap). PURE.
 * Conditional/future by construction: it can only return pre-write wording.
 */
export function pendingWarningTextOf(code: PlanWarningCode): string {
  return WARNING_TEXTS[code].pending;
}

/**
 * The sentence to show AFTER a write that really happened. PURE. Past tense by
 * construction: callers must not reach for it before the write succeeded.
 */
export function writtenWarningTextOf(code: PlanWarningCode): string {
  return WARNING_TEXTS[code].written;
}

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
 *     attach a `warningCode` so the renderers can surface it in the right tense.
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
    return { target: 'global', langs, warningCode: 'workspace-fallback' };
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
/* The pre-write consent recap (pure; mirrors formatOnSaveOptIn's recap)        */
/* -------------------------------------------------------------------------- */

/** A language whose current `editor.defaultFormatter` our write would replace. */
export interface DefaultFormatterReplacement {
  readonly lang: LangId;
  /** The CURRENT value at the target scope, sanitized for display. */
  readonly current: string;
}

/**
 * Exactly what the confirmation dialog promises: the keys that WOULD be written,
 * which existing values they replace, and which languages already point at Tidy
 * (so they are not written at all). PURE data : no 'vscode' types leak here.
 */
export interface DefaultFormatterRecap {
  /** Scope the overrides would be written at. */
  readonly target: WriteTarget;
  /** Languages that would actually be written (value is always EXTENSION_ID). */
  readonly writes: readonly LangId[];
  /** Languages whose current value at this scope would be replaced. */
  readonly replaces: readonly DefaultFormatterReplacement[];
  /** Languages already set to Tidy at this scope: listed, never re-written. */
  readonly alreadyTidy: readonly LangId[];
  /**
   * The plan's warning reason (e.g. the Workspace -> User fallback), if any.
   * A code, so the recap renderer picks the PRE-write tense for it.
   */
  readonly warningCode?: PlanWarningCode;
}

/**
 * A settings value is user-controlled text: it can be multi-line or arbitrarily
 * long, and it is about to be rendered inside a dialog. `sanitizeDetail` is the
 * shared, content-free clamp (first line, capped); we tighten the cap further
 * because this string sits in a list, not on its own.
 */
function sanitizeSettingValue(raw: string): string {
  const oneLine = sanitizeDetail(raw);
  return oneLine.length > 60 ? `${oneLine.slice(0, 57)}...` : oneLine;
}

/**
 * Build the recap from the plan and the CURRENT language-scoped values at the
 * target scope. PURE: no I/O, no 'vscode', fully unit-testable. Order of
 * `plan.langs` is preserved; inputs are never mutated.
 *
 * A language already set to Tidy at this scope is skipped (`alreadyTidy`) so the
 * recap's "exactly these keys" promise stays literally true: we do not write a
 * key whose value would not change.
 */
export function planDefaultFormatterRecap(
  plan: UseAsFormatterPlan,
  existingValues: ReadonlyMap<LangId, string | undefined>
): DefaultFormatterRecap {
  const writes: LangId[] = [];
  const replaces: DefaultFormatterReplacement[] = [];
  const alreadyTidy: LangId[] = [];
  for (const lang of plan.langs) {
    const current = existingValues.get(lang);
    if (current === EXTENSION_ID) {
      alreadyTidy.push(lang);
      continue;
    }
    writes.push(lang);
    if (current !== undefined && current !== '') {
      replaces.push({ lang, current: sanitizeSettingValue(current) });
    }
  }
  return {
    target: plan.target,
    writes,
    replaces,
    alreadyTidy,
    ...(plan.warningCode === undefined
      ? {}
      : { warningCode: plan.warningCode })
  };
}

/**
 * Render the modal recap detail: every exact key the confirm would write, its
 * value, the scope, what it replaces, and the zero-writes-until-confirm promise.
 * PURE (plain string) so the exact wording is locked by unit tests.
 *
 * The header sentence, the key-line shape and the "Nothing has been changed yet"
 * promise are deliberately IDENTICAL in form to `formatOnSaveRecapDetail`: one
 * recap grammar for both settings Tidy can write.
 *
 * TENSE INVARIANT: this text is shown BEFORE any write, so EVERY sentence in it
 * is either conditional/future ("will write", "would replace", "if you confirm")
 * or a statement about state that already exists and that we are NOT changing
 * ("Already set to Tidy at this scope"). No sentence here may claim a write has
 * happened : that is why the warning is rendered through
 * {@link pendingWarningTextOf} and never from stored prose.
 */
export function defaultFormatterRecapDetail(
  recap: DefaultFormatterRecap
): string {
  const lines: string[] = [];
  lines.push(
    `Tidy will write exactly these keys at the ${scopeLabelOf(recap.target)} scope:`
  );
  lines.push('');
  for (const lang of recap.writes) {
    lines.push(
      `  "[${lang}]": { "editor.defaultFormatter": "${EXTENSION_ID}" }`
    );
  }
  if (recap.replaces.length > 0) {
    lines.push('');
    lines.push(
      'Would replace the formatter currently set at this scope: ' +
        recap.replaces
          .map((item) => `"[${item.lang}]" (${item.current})`)
          .join(', ') +
        '.'
    );
  }
  if (recap.alreadyTidy.length > 0) {
    lines.push('');
    lines.push(
      'Already set to Tidy at this scope (nothing to write): ' +
        recap.alreadyTidy.map((lang) => `"[${lang}]"`).join(', ')
    );
  }
  if (recap.warningCode !== undefined) {
    lines.push('');
    // Rendered in the PRE-write tense: this dialog is shown before anything is
    // written, so the sentence must describe what WOULD happen, never what did.
    lines.push(pendingWarningTextOf(recap.warningCode));
  }
  lines.push('');
  lines.push(
    'Nothing has been changed yet. Tidy writes only the keys above if you ' +
      'confirm, and nothing else: it does not touch editor.formatOnSave here, ' +
      'it installs no save hook and no file watcher. Cancel and nothing at all ' +
      'is written.'
  );
  return lines.join('\n');
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
 * Write Tidy as the per-language `editor.defaultFormatter` for the CONFIRMED
 * languages (`recap.writes`, never the raw picks). Delegates to the shared core
 * so the migration flow (1.T4) writes the formatter through the EXACT same
 * path. Sets ONLY defaultFormatter.
 */
async function applyPlan(
  vscode: any,
  recap: DefaultFormatterRecap
): Promise<void> {
  await setDefaultFormatterForLangs(vscode, recap.writes, recap.target);
}

/** Label of the one button that authorises the defaultFormatter write. */
export const DEFAULT_FORMATTER_CONFIRM_ACTION = 'Set Tidy as default formatter';

/** Title line of the modal recap (the dialog's main message). */
export const DEFAULT_FORMATTER_CONFIRM_TITLE =
  'Set Tidy as your default formatter for these languages?';

/** What {@link confirmAndApplyDefaultFormatter} actually did. */
export type DefaultFormatterConsentResult =
  /** The recap was confirmed and every listed key was written. */
  | { readonly outcome: 'written'; readonly recap: DefaultFormatterRecap }
  /** Every picked language already points at Tidy: no dialog, no write. */
  | {
      readonly outcome: 'nothing-to-write';
      readonly recap: DefaultFormatterRecap;
    }
  /** The user dismissed the recap (Escape / Cancel / any other button). */
  | { readonly outcome: 'cancelled' }
  /** Current settings could not be read, so no honest recap could be shown. */
  | { readonly outcome: 'read-failed'; readonly cause: string }
  /** The confirmed write itself failed. */
  | { readonly outcome: 'write-failed'; readonly cause: string };

/**
 * THE consent gate for `editor.defaultFormatter`.
 *
 * Reads the current language-scoped values, builds the recap, shows it as a
 * MODAL dialog listing the exact keys, values and scope, and writes ONLY if the
 * user presses {@link DEFAULT_FORMATTER_CONFIRM_ACTION}. Anything else (Escape,
 * the dialog's own Cancel, any other button) writes NOTHING at all.
 *
 * Fails closed: if the current values cannot be read, no recap can be honest,
 * so no dialog is shown and nothing is written.
 *
 * `vscode` is a PARAMETER (the idiom of setDefaultFormatterForLangs and of the
 * format-on-save step) so this gate is exercised by mock-driven unit tests, not
 * only by the integration suite. It shows no toast of its own: the caller owns
 * the user-facing messages for each outcome.
 */
export async function confirmAndApplyDefaultFormatter(
  vscode: any,
  plan: UseAsFormatterPlan
): Promise<DefaultFormatterConsentResult> {
  let recap: DefaultFormatterRecap;
  try {
    const existing = readCurrentDefaultFormatterValues(
      vscode,
      plan.langs,
      plan.target
    );
    recap = planDefaultFormatterRecap(plan, existing);
  } catch (error: unknown) {
    return { outcome: 'read-failed', cause: causeOf(error) };
  }

  // Nothing would change: no consent to ask for, and no write to perform.
  if (recap.writes.length === 0) {
    return { outcome: 'nothing-to-write', recap };
  }

  const confirmed = await vscode.window.showInformationMessage(
    DEFAULT_FORMATTER_CONFIRM_TITLE,
    { modal: true, detail: defaultFormatterRecapDetail(recap) },
    DEFAULT_FORMATTER_CONFIRM_ACTION
  );
  if (confirmed !== DEFAULT_FORMATTER_CONFIRM_ACTION) {
    return { outcome: 'cancelled' }; // ZERO writes
  }

  try {
    await applyPlan(vscode, recap);
  } catch (error: unknown) {
    return { outcome: 'write-failed', cause: causeOf(error) };
  }
  return { outcome: 'written', recap };
}

/** Turn an unknown thrown value into a SAFE, single-line cause string. */
function causeOf(error: unknown): string {
  return error instanceof Error ? sanitizeDetail(error.message) : 'unknown error';
}

/**
 * Handler for "Tidy: Use Tidy as my formatter".
 *
 * Flow (every step user-initiated; any cancel = zero writes):
 *   1. multi-select QuickPick of supported languages (active language pre-ticked);
 *   2. QuickPick of scope (Workspace default / User);
 *   3. plan via the pure planner;
 *   4. MODAL RECAP listing the exact keys, values and scope, plus what they
 *      replace : nothing is written until it is explicitly confirmed;
 *   5. write `editor.defaultFormatter` per confirmed language (overrideInLanguage);
 *   6. optional format-on-save step (QuickPick, modal recap, confirmed write,
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

  // THE consent gate: the exact keys, values and scope are shown FIRST, and
  // nothing is written unless the user confirms them. Cancel = zero writes.
  const consent = await confirmAndApplyDefaultFormatter(vscode, plan);

  if (consent.outcome === 'read-failed') {
    void vscode.window.showErrorMessage(
      `Tidy: could not read your current formatter settings ` +
        `(${consent.cause}) : nothing was changed.`
    );
    return;
  }
  if (consent.outcome === 'cancelled') {
    void vscode.window.showInformationMessage(
      'Tidy: cancelled : no setting was written.'
    );
    return;
  }
  if (consent.outcome === 'write-failed') {
    void vscode.window.showErrorMessage(
      `Tidy: could not save the default formatter (${consent.cause}).`
    );
    return;
  }

  // The scope fallback is only worth reporting when a write really happened :
  // and only HERE may it be phrased in the past tense, because by now it is
  // true. The same reason code was shown in the modal in the conditional tense.
  if (consent.outcome === 'written' && plan.warningCode !== undefined) {
    void vscode.window.showWarningMessage(
      writtenWarningTextOf(plan.warningCode)
    );
  }

  // Optional, separately-confirmed format-on-save step (ADD-04). It owns the
  // success toast for every branch and writes editor.formatOnSave ONLY after
  // its own modal recap is confirmed; cancelling it writes nothing further.
  const { runFormatOnSaveStep } = require('./formatOnSaveOptIn');
  await runFormatOnSaveStep(vscode, plan.langs, plan.target);
}
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */
