// Shared core: write Tidy as the per-language `editor.defaultFormatter`.
//
// Factored out of commands/useAsFormatter.ts (Axe 1 / 1.T2) so the migration
// flow (Axe 1 / 1.T4, src/migration/runMigration.ts) can perform the EXACT same
// write through one code path : no duplicated `update('defaultFormatter', …)`.
//
// ANTI-HIJACK (ARCH-02, SPEC §5/§12) : NON-NEGOTIABLE:
//   - This helper writes ONLY `editor.defaultFormatter` (overrideInLanguage) for
//     the explicit languages a caller passes. It NEVER writes
//     `editor.formatOnSave` and NEVER writes anything for a language the caller
//     did not list. Callers MUST only call it in response to an explicit user
//     action, never at boot. Since v0.4.0 the ONE product caller
//     (commands/useAsFormatter.ts) additionally shows a modal recap listing the
//     exact keys, values and scope, and calls this helper ONLY after the user
//     confirms it : cancelling that recap calls nothing here at all.
//
// HOST-ONLY: the value-producing surface ('vscode', the provider's language
// list) is required lazily INSIDE the functions so the PURE planner in
// useAsFormatter.ts can still be imported by a mocha+tsx unit test without
// pulling in 'vscode'. This module is exercised by the integration suite.
import type { LangId } from '../types';
// The shared, 'vscode'-free detail sanitizer: a settings-write failure can carry
// a multi-line payload (an Error with a stack-like message), which must never
// reach a notification verbatim. lastFormat.ts imports nothing at all, so this
// top-level import keeps the module 'vscode'-free.
import { sanitizeDetail } from '../diagnostics/lastFormat';

/**
 * Marketplace identifier (publisher.name) written into `editor.defaultFormatter`.
 * Single source of truth, re-exported by callers that need the same constant.
 */
export const EXTENSION_ID = 'ced-lab.tidy-formatter';

/** Where the per-language `editor.defaultFormatter` override is written. */
export type WriteTarget = 'workspace' | 'global';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */

/**
 * Resolve the VS Code ConfigurationTarget enum value for a WriteTarget, reading
 * it from the lazily-required 'vscode' module so this file never imports it at
 * top level.
 */
export function toConfigurationTarget(vscode: any, target: WriteTarget): unknown {
  return target === 'workspace'
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
}

/**
 * Read the CURRENT language-scoped `editor.defaultFormatter` value at the given
 * scope for each language: the EXACT form our overrideInLanguage write targets.
 *
 * Deliberately mirrors `readCurrentFormatOnSaveValues` in formatOnSaveOptIn.ts,
 * so the two consent paths inspect prior state through the same shape. The
 * caller uses it to build the pre-write recap ("this replaces X"), which is why
 * it does NOT swallow errors: a recap built on unreadable state would be a
 * guess, and this flow must fail closed (no read, no confirmation, no write).
 *
 * A non-string value (a corrupted settings entry) is normalised to undefined:
 * the recap then simply reports no current value rather than rendering junk.
 * Since v0.4.1 this is ALSO the source of the prior values a failed write rolls
 * back to, so that normalisation has one known consequence: rolling back over a
 * corrupted non-string entry removes the override instead of restoring the junk.
 */
export function readCurrentDefaultFormatterValues(
  vscode: any,
  langs: readonly LangId[],
  target: WriteTarget
): Map<LangId, string | undefined> {
  const values = new Map<LangId, string | undefined>();
  for (const lang of langs) {
    const info = vscode.workspace
      .getConfiguration('editor', { languageId: lang })
      .inspect('defaultFormatter');
    const raw =
      target === 'workspace'
        ? info?.workspaceLanguageValue
        : info?.globalLanguageValue;
    values.set(lang, typeof raw === 'string' ? raw : undefined);
  }
  return values;
}

/* -------------------------------------------------------------------------- */
/* THE shared write-with-rollback mechanism (v0.4.1, C-11)                     */
/* -------------------------------------------------------------------------- */

/**
 * One language-scoped settings write, with the value to put back if a LATER
 * write in the same batch fails. Same shape, and the same "restore the prior
 * value, never a blind unset" rule, as `FormatOnSaveWrite` in
 * formatOnSaveOptIn.ts : this module is the one both consent paths depend on.
 */
export interface LanguageOverrideWrite<T> {
  /** The language whose override is written. */
  readonly lang: LangId;
  /**
   * The language-scoped value at the target scope BEFORE our write. Rollback
   * restores exactly this, and `undefined` legitimately means "there was no
   * override here", which VS Code's update(undefined) removes again.
   */
  readonly priorValue: T;
}

/** Full success, or the REAL state of the settings after a failed batch. */
export type ApplyOverridesResult =
  | { readonly ok: true; readonly written: readonly LangId[] }
  | {
      readonly ok: false;
      /** The language whose write failed (never written). */
      readonly failed: LangId;
      /** Sanitized, single-line cause of that failure. */
      readonly cause: string;
      /** Keys written before the failure that the rollback DID restore. */
      readonly rolledBack: readonly LangId[];
      /** Keys written before the failure that the rollback could NOT restore. */
      readonly stuck: readonly LangId[];
    };

/**
 * Turn an unknown thrown value into a SAFE, single-line cause string. Shared by
 * every failure path in this module so no unsanitized error text can reach a
 * notification.
 */
function safeCause(error: unknown): string {
  return error instanceof Error ? sanitizeDetail(error.message) : 'unknown error';
}

/**
 * Apply a batch of language-scoped settings writes with BEST-EFFORT ROLLBACK,
 * and NEVER throw: the caller always learns the real final state.
 *
 * This is the mechanism `applyFormatOnSavePlan` introduced in v0.3.0, lifted here
 * (v0.4.1, C-11) so the `editor.defaultFormatter` path uses the SAME one instead
 * of a bare loop. The write and the restore are supplied as callbacks, so the
 * literal `.update('<key>', ...)` call stays at the call site that owns that key :
 * this helper can never be re-pointed at a settings key nobody consented to.
 *
 * Semantics, identical to the format-on-save path:
 *   - writes run in order; the first failure stops the batch;
 *   - every key already written is then restored to its prior value, EACH in its
 *     own try, so one unrestorable key cannot abort the rest of the rollback;
 *   - a key that could not be restored is reported as `stuck`, never hidden, so
 *     the caller's message can name what is really left in the settings.
 */
export async function applyOverridesWithRollback<T>(
  writes: readonly LanguageOverrideWrite<T>[],
  write: (lang: LangId) => Promise<void>,
  restore: (lang: LangId, priorValue: T) => Promise<void>
): Promise<ApplyOverridesResult> {
  const written: LanguageOverrideWrite<T>[] = [];

  for (const entry of writes) {
    try {
      await write(entry.lang);
      written.push(entry);
    } catch (error: unknown) {
      const cause = safeCause(error);
      const rolledBack: LangId[] = [];
      const stuck: LangId[] = [];
      for (const done of written) {
        try {
          await restore(done.lang, done.priorValue);
          rolledBack.push(done.lang);
        } catch {
          // Rollback is best effort: a key we cannot restore is reported as
          // "stuck" so the message never lies about the real state.
          stuck.push(done.lang);
        }
      }
      return { ok: false, failed: entry.lang, cause, rolledBack, stuck };
    }
  }

  return { ok: true, written: written.map((entry) => entry.lang) };
}

/* -------------------------------------------------------------------------- */
/* The honest failure message (pure: locked by unit tests)                      */
/* -------------------------------------------------------------------------- */

/**
 * Budget for the composed detail. The caller wraps it in its own sentence and
 * runs the whole thing through `sanitizeDetail` (200 chars); staying under that
 * guarantees the state clauses are never the part that gets truncated.
 */
const MAX_FAILURE_DETAIL = 190;

/**
 * Compose the single-line detail that tells the user WHAT IS IN THEIR SETTINGS
 * after a failed batch. PURE, so the exact wording is locked by unit tests.
 *
 * The two state clauses are never truncated: `rolledBack` and `stuck` are
 * disjoint subsets of the languages we attempted, so together they are bounded
 * by the supported-language list. The CAUSE is the only part that can be clamped,
 * because it is the only part of unbounded length : an honest short message beats
 * a long one whose ending ("these keys stayed written: ...") fell off the end.
 */
export function defaultFormatterFailureDetail(
  cause: string,
  rolledBack: readonly LangId[],
  stuck: readonly LangId[]
): string {
  const clauses: string[] = [
    stuck.length === 0
      ? 'no key was left written'
      : `these keys stayed written: ${stuck.join(', ')}`
  ];
  if (rolledBack.length > 0) {
    clauses.push(`rolled back: ${rolledBack.join(', ')}`);
  }
  const state = clauses.join('; ');

  const oneLineCause = sanitizeDetail(cause) || 'unknown error';
  const budget = MAX_FAILURE_DETAIL - state.length - 2;
  if (budget <= 0) {
    return state;
  }
  const clampedCause =
    oneLineCause.length <= budget
      ? oneLineCause
      : `${oneLineCause.slice(0, Math.max(1, budget - 3))}...`;
  return `${clampedCause}; ${state}`;
}

/**
 * Thrown by {@link setDefaultFormatterForLangs} when the batch could not be
 * completed. Its `message` is ALREADY the honest, single-line detail (cause plus
 * the real state of the settings), so the existing callers : which surface
 * the thrown error's `message` through `sanitizeDetail` : report the truth with
 * no change of their own. It is composed here, and composed single-line and
 * short enough that that clamp can never cut the state clauses off the end.
 * The structured fields are there for tests and future callers.
 */
export class DefaultFormatterWriteError extends Error {
  readonly rolledBack: readonly LangId[];
  readonly stuck: readonly LangId[];

  constructor(
    cause: string,
    rolledBack: readonly LangId[],
    stuck: readonly LangId[]
  ) {
    super(defaultFormatterFailureDetail(cause, rolledBack, stuck));
    this.name = 'DefaultFormatterWriteError';
    this.rolledBack = [...rolledBack];
    this.stuck = [...stuck];
  }
}

/**
 * Write Tidy as the per-language `editor.defaultFormatter` for each given
 * language at the resolved scope, using overrideInLanguage (the language-scoped
 * form). Sets ONLY defaultFormatter : never formatOnSave.
 *
 * ALL OR NOTHING (v0.4.1, C-11). Before v0.4.1 this was a bare loop: a failure on
 * the third language left the first two written while the caller's toast said the
 * default formatter could not be saved, contradicting the modal recap's promise
 * that Tidy "will write exactly these keys". It now runs through
 * {@link applyOverridesWithRollback} : the same mechanism the format-on-save path
 * has used since v0.3.0 : so a mid-batch failure restores every key already
 * written, and the thrown error NAMES what is really left in the settings,
 * including any key the rollback could not restore.
 *
 * Fails closed: the prior values needed to roll back are read FIRST, and if they
 * cannot be read nothing is written at all.
 *
 * The caller is responsible for having obtained explicit user consent and for
 * passing a validated, de-duplicated language list. An empty list is a no-op.
 *
 * @param vscode the lazily-required 'vscode' module.
 * @param langs  the languages to override (already validated by the caller).
 * @param target the scope to write at.
 * @throws {DefaultFormatterWriteError} when the batch could not be completed.
 */
export async function setDefaultFormatterForLangs(
  vscode: any,
  langs: readonly LangId[],
  target: WriteTarget
): Promise<void> {
  if (langs.length === 0) {
    return;
  }
  const configurationTarget = toConfigurationTarget(vscode, target);

  // Read BEFORE writing anything: without the prior values there is no rollback,
  // so an unreadable scope must stop the batch rather than start an unwindable
  // one. Nothing has been written at this point, and the message says so.
  let priorValues: Map<LangId, string | undefined>;
  try {
    priorValues = readCurrentDefaultFormatterValues(vscode, langs, target);
  } catch (error: unknown) {
    throw new DefaultFormatterWriteError(
      `could not read the current settings (${safeCause(error)})`,
      [],
      []
    );
  }

  const result = await applyOverridesWithRollback<string | undefined>(
    langs.map((lang) => ({ lang, priorValue: priorValues.get(lang) })),
    (lang) =>
      vscode.workspace
        .getConfiguration('editor', { languageId: lang })
        .update('defaultFormatter', EXTENSION_ID, configurationTarget, true),
    (lang, priorValue) =>
      vscode.workspace
        .getConfiguration('editor', { languageId: lang })
        .update('defaultFormatter', priorValue, configurationTarget, true)
  );

  if (!result.ok) {
    throw new DefaultFormatterWriteError(
      result.cause,
      result.rolledBack,
      result.stuck
    );
  }
}
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */
