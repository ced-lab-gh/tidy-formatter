// Step of "Tidy: Use Tidy as my formatter": guided, consent-first format-on-save
// opt-in (ADD-04, v0.3.0).
//
// ANTI-HIJACK (ARCH-02, SPEC §5/§12) : NON-NEGOTIABLE:
//   - Tidy NEVER hooks the save event. This step only writes the stock VS Code
//     setting `editor.formatOnSave` (overrideInLanguage) for the exact languages
//     the user just opted in, and ONLY after the user confirms a modal recap
//     listing every key and the scope. Cancelling at ANY point writes NOTHING.
//   - The success message offers a "Revert" button restoring each written key to
//     its previous value; keys the user modified in the meantime are left
//     untouched (a later user decision is never clobbered).
//   - This step runs ONLY inside the tidy.useAsFormatter flow, after the
//     default-formatter write the user already confirmed. Never at boot, never
//     from any listener, never from a hook.
//
// Split of concerns (same as useAsFormatter.ts): this module's TOP LEVEL imports
// NO 'vscode', neither directly nor transitively, so the pure planner (write
// list, recap text, revert decision) is unit-testable under plain mocha+tsx.
// The host surface takes `vscode` as a parameter (like setDefaultFormatterForLangs)
// or requires it lazily, and is exercised by the integration suite plus
// mock-driven unit tests.
import type { LangId } from '../types';
import { toConfigurationTarget, type WriteTarget } from './setDefaultFormatter';
// The shared, 'vscode'-free detail sanitizer: a settings-write failure can carry
// a multi-line payload, which must never reach a notification verbatim.
import { sanitizeDetail } from '../diagnostics/lastFormat';

/* -------------------------------------------------------------------------- */
/* Pure planner (no 'vscode' : unit-testable under mocha + tsx)                */
/* -------------------------------------------------------------------------- */

/** One key this step would write (or has written), with its prior value. */
export interface FormatOnSaveWrite {
  /** The language whose `editor.formatOnSave` override is written. */
  lang: LangId;
  /**
   * The language-scoped value at the target scope BEFORE our write (undefined,
   * false or true). "Revert" restores exactly this value, never a blind unset.
   */
  priorValue: boolean | undefined;
}

/** The concrete writes the recap promises: exactly these keys, or nothing. */
export interface FormatOnSaveWritePlan {
  /** Scope the overrides are written at (inherited from the formatter write). */
  target: WriteTarget;
  /** Keys to write (value is always `true`, overrideInLanguage). */
  writes: readonly FormatOnSaveWrite[];
  /** Languages already at `true` for this scope: listed, never re-written. */
  alreadyEnabled: readonly LangId[];
}

/**
 * Build the exact write list from the user's opted-in languages and the current
 * language-scoped values at the target scope. PURE: no I/O, no 'vscode',
 * fully unit-testable. Order of `langs` is preserved; inputs are never mutated.
 *
 * A language whose current value is already `true` is skipped (alreadyEnabled):
 * re-writing it would make "Revert" lie about what Tidy changed.
 */
export function planFormatOnSaveWrites(
  langs: readonly LangId[],
  target: WriteTarget,
  existingValues: ReadonlyMap<LangId, boolean | undefined>
): FormatOnSaveWritePlan {
  const writes: FormatOnSaveWrite[] = [];
  const alreadyEnabled: LangId[] = [];
  for (const lang of langs) {
    const existing = existingValues.get(lang);
    if (existing === true) {
      alreadyEnabled.push(lang);
    } else {
      writes.push({ lang, priorValue: existing });
    }
  }
  return { target, writes, alreadyEnabled };
}

/** Human-readable scope label used verbatim in the recap. PURE. */
export function scopeLabelOf(target: WriteTarget): 'Workspace' | 'User' {
  return target === 'workspace' ? 'Workspace' : 'User';
}

/**
 * Render the modal recap detail: every exact key the confirm would write, the
 * scope, the already-enabled list, and the zero-writes-until-confirm promise.
 * PURE (plain string) so the exact wording is locked by unit tests.
 */
export function formatOnSaveRecapDetail(plan: FormatOnSaveWritePlan): string {
  const lines: string[] = [];
  lines.push(
    `Tidy will write exactly these keys at the ${scopeLabelOf(plan.target)} scope:`
  );
  lines.push('');
  for (const write of plan.writes) {
    lines.push(`  "[${write.lang}]": { "editor.formatOnSave": true }`);
  }
  if (plan.alreadyEnabled.length > 0) {
    lines.push('');
    lines.push(
      'Already enabled at this scope (nothing to write): ' +
        plan.alreadyEnabled.map((lang) => `"[${lang}]"`).join(', ')
    );
  }
  lines.push('');
  lines.push(
    'Nothing has been changed yet. Tidy writes only the keys above if you ' +
      'confirm, and the success message offers a one-click Revert restoring ' +
      'each key to its previous value. Tidy itself never hooks the save ' +
      'event: VS Code core runs your default formatter on save.'
  );
  return lines.join('\n');
}

/** What "Revert" decides per written key: restore it, or keep a user change. */
export interface FormatOnSaveRevertDecision {
  /** Writes whose key still holds OUR value (true): safe to restore. */
  revert: readonly FormatOnSaveWrite[];
  /** Languages the user modified since our write: never clobbered. */
  kept: readonly LangId[];
}

/**
 * Decide which written keys "Revert" may restore. PURE. A key is restored ONLY
 * when its current language-scoped value is still exactly `true` (what we
 * wrote); anything else means the user acted after us and wins.
 */
export function buildFormatOnSaveRevert(
  writes: readonly FormatOnSaveWrite[],
  currentValues: ReadonlyMap<LangId, boolean | undefined>
): FormatOnSaveRevertDecision {
  const revert: FormatOnSaveWrite[] = [];
  const kept: LangId[] = [];
  for (const write of writes) {
    if (currentValues.get(write.lang) === true) {
      revert.push(write);
    } else {
      kept.push(write.lang);
    }
  }
  return { revert, kept };
}

/** Result of applying a plan: full success, or real state after a failure. */
export type ApplyFormatOnSaveResult =
  | { readonly ok: true; readonly written: readonly FormatOnSaveWrite[] }
  | {
      readonly ok: false;
      /** Sanitized first-line cause of the failed update. */
      readonly cause: string;
      /** Keys written before the failure that the rollback restored. */
      readonly rolledBack: readonly LangId[];
      /** Keys written before the failure that the rollback could NOT restore. */
      readonly stuck: readonly LangId[];
    };

/**
 * Turn an unknown thrown value into a SAFE, single-line cause string. A settings
 * write can reject with a multi-line Error; `sanitizeDetail` is the shared last
 * line of defence for the content-free contract, so no unsanitized error text
 * can ever reach a notification.
 */
function safeCause(error: unknown): string {
  return error instanceof Error ? sanitizeDetail(error.message) : 'unknown error';
}

/* -------------------------------------------------------------------------- */
/* VS Code surface. `vscode` is a parameter (mock-testable) or lazily required. */
/* -------------------------------------------------------------------------- */
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */

/** Label of the revert button on the success toast (exported for tests). */
export const REVERT_BUTTON_LABEL = 'Revert';

const OPEN_FORMAT_ON_SAVE_LABEL = 'Open formatOnSave setting';
const ACTION_CONFIRM_ENABLE = 'Enable format on save';
const CHOICE_DO_NOTHING = 'No, keep formatting manual';
const CHOICE_OPEN_SETTING = 'Open the formatOnSave setting';
const CHOICE_ENABLE = 'Enable format on save for the selected languages';

/**
 * Append one content-free line to the shared "Tidy Formatter" output channel.
 * Never logs document source (there is none here: only languages, scope, keys).
 * Tracing must never break the flow, so any failure is swallowed.
 */
function trace(line: string): void {
  try {
    const { getTidyOutputChannel } = require('../diagnostics/outputChannel');
    getTidyOutputChannel().appendLine(`[format-on-save] ${line}`);
  } catch {
    // The channel is diagnostics only; its absence must not affect behaviour.
  }
}

/**
 * Read the CURRENT language-scoped `editor.formatOnSave` value at the given
 * scope for each language, the exact form our overrideInLanguage write targets.
 */
export function readCurrentFormatOnSaveValues(
  vscode: any,
  langs: readonly LangId[],
  target: WriteTarget
): Map<LangId, boolean | undefined> {
  const values = new Map<LangId, boolean | undefined>();
  for (const lang of langs) {
    const info = vscode.workspace
      .getConfiguration('editor', { languageId: lang })
      .inspect('formatOnSave');
    values.set(
      lang,
      target === 'workspace'
        ? (info?.workspaceLanguageValue as boolean | undefined)
        : (info?.globalLanguageValue as boolean | undefined)
    );
  }
  return values;
}

/**
 * Write `editor.formatOnSave: true` (overrideInLanguage) for every planned
 * language at the plan's scope. On a mid-loop failure, best-effort rollback of
 * every key already written (each in its own try) so the recap's promise
 * "exactly these keys, or nothing" holds; the result reports the REAL final
 * state either way. Writes ONLY editor.formatOnSave.
 */
export async function applyFormatOnSavePlan(
  vscode: any,
  plan: FormatOnSaveWritePlan
): Promise<ApplyFormatOnSaveResult> {
  const configurationTarget = toConfigurationTarget(vscode, plan.target);
  const written: FormatOnSaveWrite[] = [];

  for (const write of plan.writes) {
    try {
      await vscode.workspace
        .getConfiguration('editor', { languageId: write.lang })
        .update('formatOnSave', true, configurationTarget, true);
      written.push(write);
      trace(
        `wrote "[${write.lang}]": editor.formatOnSave = true (${plan.target})`
      );
    } catch (error: unknown) {
      const cause = safeCause(error);
      const rolledBack: LangId[] = [];
      const stuck: LangId[] = [];
      for (const done of written) {
        try {
          await vscode.workspace
            .getConfiguration('editor', { languageId: done.lang })
            .update('formatOnSave', done.priorValue, configurationTarget, true);
          rolledBack.push(done.lang);
        } catch {
          // Rollback is best effort: a key we cannot restore is reported as
          // "stuck" so the message never lies about the real state.
          stuck.push(done.lang);
        }
      }
      trace(
        `write failed for "[${write.lang}]"; rolled back: ` +
          `[${rolledBack.join(', ')}]; stuck: [${stuck.join(', ')}]`
      );
      return { ok: false, cause, rolledBack, stuck };
    }
  }

  return { ok: true, written };
}

/**
 * Restore every written key to its prior value, SKIPPING keys the user changed
 * since (their current value is no longer `true`). Returns the real outcome so
 * the caller's toast never lies about what happened.
 */
export async function revertFormatOnSaveWrites(
  vscode: any,
  target: WriteTarget,
  writes: readonly FormatOnSaveWrite[]
): Promise<{ reverted: LangId[]; kept: LangId[]; failed: LangId[] }> {
  const configurationTarget = toConfigurationTarget(vscode, target);
  const current = readCurrentFormatOnSaveValues(
    vscode,
    writes.map((w) => w.lang),
    target
  );
  const decision = buildFormatOnSaveRevert(writes, current);

  const reverted: LangId[] = [];
  const failed: LangId[] = [];
  for (const write of decision.revert) {
    try {
      await vscode.workspace
        .getConfiguration('editor', { languageId: write.lang })
        .update('formatOnSave', write.priorValue, configurationTarget, true);
      reverted.push(write.lang);
      trace(
        `reverted "[${write.lang}]": editor.formatOnSave -> ` +
          `${String(write.priorValue)} (${target})`
      );
    } catch {
      // Report it instead of throwing: the toast lists what could not be undone.
      failed.push(write.lang);
    }
  }
  if (decision.kept.length > 0) {
    trace(`revert kept user-modified keys: [${decision.kept.join(', ')}]`);
  }
  return { reverted, kept: [...decision.kept], failed };
}

/** The success toast shared by the non-enable branches (former announceSuccess). */
function defaultFormatterSuccessMessage(
  langs: readonly LangId[],
  target: WriteTarget
): string {
  const scopeLabel = target === 'workspace' ? 'workspace' : 'user';
  return (
    `Tidy is now the default formatter for ${langs.join(', ')} ` +
    `(${scopeLabel} scope). It will only run when you format a document; ` +
    `enable "Format On Save" yourself if you want it on save.`
  );
}

/** Non-modal classic success toast, with the passive open-setting button. */
function showClassicSuccess(
  vscode: any,
  langs: readonly LangId[],
  target: WriteTarget,
  withOpenButton: boolean
): void {
  const message = defaultFormatterSuccessMessage(langs, target);
  const buttons = withOpenButton ? [OPEN_FORMAT_ON_SAVE_LABEL] : [];
  void vscode.window
    .showInformationMessage(message, ...buttons)
    .then((picked: string | undefined) => {
      if (picked === OPEN_FORMAT_ON_SAVE_LABEL) {
        void vscode.commands.executeCommand(
          'workbench.action.openSettings',
          'editor.formatOnSave'
        );
      }
    });
}

/** Success toast of the enable branch, with the one-click Revert button. */
function showEnableSuccess(
  vscode: any,
  langs: readonly LangId[],
  target: WriteTarget,
  written: readonly FormatOnSaveWrite[]
): void {
  const scopeLabel = target === 'workspace' ? 'workspace' : 'user';
  const message =
    `Tidy is now the default formatter and format on save is enabled for ` +
    `${langs.join(', ')} (${scopeLabel} scope). Press "${REVERT_BUTTON_LABEL}" ` +
    `to restore the previous format-on-save values.`;

  void vscode.window
    .showInformationMessage(message, REVERT_BUTTON_LABEL)
    .then(async (picked: string | undefined) => {
      if (picked !== REVERT_BUTTON_LABEL) {
        return;
      }
      trace('revert requested');
      let outcome: { reverted: LangId[]; kept: LangId[]; failed: LangId[] };
      try {
        outcome = await revertFormatOnSaveWrites(vscode, target, written);
      } catch (error: unknown) {
        const cause = safeCause(error);
        void vscode.window.showErrorMessage(
          `Tidy: could not revert format on save for ` +
            `${written.map((w) => w.lang).join(', ')}. ` +
            `Check editor.formatOnSave in your settings. (${cause})`
        );
        return;
      }

      if (outcome.failed.length > 0) {
        void vscode.window.showErrorMessage(
          `Tidy: could not revert format on save for ` +
            `${outcome.failed.join(', ')}. Check editor.formatOnSave in your ` +
            `settings.`
        );
        return;
      }
      if (outcome.reverted.length === 0) {
        void vscode.window.showInformationMessage(
          'Tidy: nothing to revert; the format-on-save keys were already ' +
            'changed since.'
        );
        return;
      }
      const keptSuffix =
        outcome.kept.length > 0
          ? ` Left unchanged because you modified them since: ` +
            `${outcome.kept.join(', ')}.`
          : ' Previous values are restored.';
      void vscode.window.showInformationMessage(
        `Tidy: format on save reverted for ${outcome.reverted.join(', ')}.` +
          keptSuffix
      );
    });
}

/**
 * The optional format-on-save step of "Tidy: Use Tidy as my formatter", run
 * AFTER the confirmed defaultFormatter write.
 *
 * Flow (any cancel at any point = zero format-on-save writes):
 *   1. QuickPick with 3 choices (do nothing / open the setting / enable);
 *   2. on "enable": read current values, plan via the pure planner;
 *   3. modal recap listing every exact key + scope; explicit confirm required;
 *   4. write overrideInLanguage `editor.formatOnSave: true` per language, with
 *      best-effort rollback on a mid-loop failure;
 *   5. success toast with a "Revert" button restoring the previous values.
 *
 * Never throws: any failure is surfaced as a non-blocking toast so the command
 * can never break the editor.
 */
export async function runFormatOnSaveStep(
  vscode: any,
  langs: readonly LangId[],
  target: WriteTarget
): Promise<void> {
  try {
    trace(`opt-in offered for: ${langs.join(', ')} (${target})`);

    const choice = (await vscode.window.showQuickPick(
      [
        {
          label: CHOICE_DO_NOTHING,
          description:
            'Tidy runs only when you invoke Format Document (recommended default)'
        },
        {
          label: CHOICE_OPEN_SETTING,
          description:
            'Inspect or change the stock VS Code setting yourself; Tidy writes nothing'
        },
        {
          label: CHOICE_ENABLE,
          description:
            'Shows the exact settings first; nothing is written until you confirm'
        }
      ],
      {
        title: 'Format on save (optional)',
        placeHolder:
          'Tidy never hooks the save event; VS Code runs your default ' +
          'formatter on save when editor.formatOnSave is on'
      }
    )) as { label: string } | undefined;

    if (choice === undefined || choice.label === CHOICE_DO_NOTHING) {
      trace('user chose: none');
      showClassicSuccess(vscode, langs, target, true);
      return;
    }

    if (choice.label === CHOICE_OPEN_SETTING) {
      trace('user chose: open-setting');
      void vscode.commands.executeCommand(
        'workbench.action.openSettings',
        'editor.formatOnSave'
      );
      showClassicSuccess(vscode, langs, target, false);
      return;
    }

    // choice === CHOICE_ENABLE
    trace('user chose: enable');
    const existing = readCurrentFormatOnSaveValues(vscode, langs, target);
    const plan = planFormatOnSaveWrites(langs, target, existing);

    if (plan.writes.length === 0) {
      trace(`already enabled, nothing to write: [${langs.join(', ')}]`);
      const scopeLabel = target === 'workspace' ? 'workspace' : 'user';
      void vscode.window.showInformationMessage(
        `Tidy is now the default formatter for ${langs.join(', ')} ` +
          `(${scopeLabel} scope). Format on save was already enabled for ` +
          `these languages at this scope; nothing was written.`
      );
      return;
    }

    const confirmed = await vscode.window.showInformationMessage(
      'Enable format on save for the selected languages?',
      { modal: true, detail: formatOnSaveRecapDetail(plan) },
      ACTION_CONFIRM_ENABLE
    );
    if (confirmed !== ACTION_CONFIRM_ENABLE) {
      trace('recap cancelled: zero writes');
      showClassicSuccess(vscode, langs, target, true);
      return;
    }

    const result = await applyFormatOnSavePlan(vscode, plan);
    if (!result.ok) {
      const suffix =
        result.stuck.length === 0
          ? 'No setting was kept.'
          : `These keys stayed written: ` +
            `${result.stuck.map((lang) => `"[${lang}]"`).join(', ')}.`;
      void vscode.window.showErrorMessage(
        `Tidy: could not enable format on save (${result.cause}). ${suffix}`
      );
      return;
    }

    showEnableSuccess(vscode, langs, target, result.written);
  } catch (error: unknown) {
    // Belt-and-braces: this step must never break the command that hosts it.
    const cause = safeCause(error);
    void vscode.window.showErrorMessage(
      `Tidy: the format-on-save step failed (${cause}). No setting was changed ` +
        `unless a success message said otherwise.`
    );
  }
}
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */
