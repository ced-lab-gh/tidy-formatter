// Apply the CONFIRMED migration writes, all or nothing (v0.5.0, MIGRATION).
//
// Before v0.5.0 the import was a bare loop: a failure on the third key left the
// first two written while the toast said the import failed. It now runs through the
// SAME rollback mechanism the default-formatter and format-on-save paths use,
// `applyOverridesWithRollback` (src/commands/setDefaultFormatter.ts):
//   - the prior value of every key is read FIRST, and if that read fails NOTHING
//     is written (fail closed);
//   - writes run in order and the first failure stops the batch;
//   - every key already written is then restored to its prior value, each in its
//     own try, so one unrestorable key cannot abort the rest of the rollback;
//   - a key that could not be restored is NAMED in the message, never hidden.
//
// This module writes ONLY the keys it is handed (the confirmed recap's writes, all
// `tidy.*`). It never writes `editor.formatOnSave`, never a key that was not in the
// recap, and never runs before the caller has obtained the user's confirmation.
//
// HOST-ONLY: `vscode` is a PARAMETER, so the module has no 'vscode' import and is
// covered by mock-driven unit tests.
import type { LangId } from '../types';
import {
  applyOverridesWithRollback,
  defaultFormatterFailureDetail,
  toConfigurationTarget,
  type LanguageOverrideWrite,
  type WriteTarget
} from '../commands/setDefaultFormatter';
import { sanitizeDetail } from '../diagnostics/lastFormat';
import type { MigrationWrite } from './types';

/** The outcome of {@link applyMigrationWrites}. Never an exception. */
export type ApplyMigrationResult =
  | { readonly ok: true; readonly written: number }
  | {
      readonly ok: false;
      /** Single-line, honest description: the cause AND the real state left behind. */
      readonly detail: string;
      /** Keys written before the failure that the rollback restored. */
      readonly rolledBack: readonly string[];
      /** Keys written before the failure that the rollback could NOT restore. */
      readonly stuck: readonly string[];
    };

/**
 * The stable name of one write, e.g. `[css] tidy.indent` or `tidy.indent`. It is
 * both what the failure message shows and the handle the rollback mechanism hands
 * back to our callbacks. Unique by construction: the mapper emits one value per
 * (language, key).
 */
export function writeUnitOf(write: MigrationWrite): string {
  return write.language === undefined
    ? write.key
    : `[${write.language}] ${write.key}`;
}

/**
 * The shared mechanism types its unit as a `LangId`, but it only ever echoes that
 * value back to our own callbacks and into its report: it never reads it. Our unit
 * is one settings key (a string), so it is cast ONCE, here, and nowhere else.
 */
function asUnit(unit: string): LangId {
  return unit as LangId;
}

/** The setting id without its `tidy.` section prefix (what getConfiguration expects). */
function suffixOf(key: string): string {
  return key.startsWith('tidy.') ? key.slice('tidy.'.length) : key;
}

/** The `tidy` configuration section, scoped to the write's language when it has one. */
function sectionOf(vscode: any, write: MigrationWrite): any {
  return write.language === undefined
    ? vscode.workspace.getConfiguration('tidy')
    : vscode.workspace.getConfiguration('tidy', { languageId: write.language });
}

/**
 * The value CURRENTLY stored at the target scope for this exact write (the
 * language-scoped slot for a language write), i.e. what a rollback must put back.
 * `undefined` legitimately means "nothing was set here", which `update(undefined)`
 * removes again. Does not swallow errors: the caller fails closed on a throw.
 */
function readPriorValue(
  vscode: any,
  write: MigrationWrite,
  target: WriteTarget
): unknown {
  const info = sectionOf(vscode, write).inspect(suffixOf(write.key));
  if (write.language === undefined) {
    return target === 'workspace' ? info?.workspaceValue : info?.globalValue;
  }
  return target === 'workspace'
    ? info?.workspaceLanguageValue
    : info?.globalLanguageValue;
}

/** One `update` call: the literal settings write stays at this single call site. */
function updateSetting(
  vscode: any,
  write: MigrationWrite,
  value: unknown,
  configurationTarget: unknown
): Thenable<void> {
  const section = sectionOf(vscode, write);
  return write.language === undefined
    ? section.update(suffixOf(write.key), value, configurationTarget)
    : section.update(suffixOf(write.key), value, configurationTarget, true);
}

/** A safe, single-line cause from an unknown thrown value. */
function causeOf(error: unknown): string {
  return error instanceof Error ? sanitizeDetail(error.message) : 'unknown error';
}

/**
 * Write the confirmed `tidy.*` settings at `target`, restoring everything already
 * written if a later write fails. NEVER throws: the caller always learns the real
 * final state.
 *
 * The caller is responsible for having obtained explicit user consent for exactly
 * these writes. An empty list is a no-op success.
 */
export async function applyMigrationWrites(
  vscode: any,
  writes: readonly MigrationWrite[],
  target: WriteTarget
): Promise<ApplyMigrationResult> {
  if (writes.length === 0) {
    return { ok: true, written: 0 };
  }
  const configurationTarget = toConfigurationTarget(vscode, target);

  // Read BEFORE writing anything: without the prior values there is no rollback,
  // so an unreadable scope stops the batch instead of starting an unwindable one.
  let entries: LanguageOverrideWrite<unknown>[];
  try {
    entries = writes.map((write) => ({
      lang: asUnit(writeUnitOf(write)),
      priorValue: readPriorValue(vscode, write, target)
    }));
  } catch (error: unknown) {
    return {
      ok: false,
      detail: defaultFormatterFailureDetail(
        `could not read the current settings (${causeOf(error)})`,
        [],
        []
      ),
      rolledBack: [],
      stuck: []
    };
  }

  const byUnit = new Map<string, MigrationWrite>(
    writes.map((write) => [writeUnitOf(write), write])
  );
  const writeOf = (unit: LangId): MigrationWrite => {
    const write = byUnit.get(unit);
    if (write === undefined) {
      throw new Error(`unknown migration write ${unit}`);
    }
    return write;
  };

  const result = await applyOverridesWithRollback<unknown>(
    entries,
    (unit) => {
      const write = writeOf(unit);
      return Promise.resolve(
        updateSetting(vscode, write, write.value, configurationTarget)
      );
    },
    (unit, priorValue) =>
      Promise.resolve(
        updateSetting(vscode, writeOf(unit), priorValue, configurationTarget)
      )
  );

  if (result.ok) {
    return { ok: true, written: result.written.length };
  }
  return {
    ok: false,
    detail: defaultFormatterFailureDetail(
      `${result.failed}: ${result.cause}`,
      result.rolledBack,
      result.stuck
    ),
    rolledBack: [...result.rolledBack],
    stuck: [...result.stuck]
  };
}
