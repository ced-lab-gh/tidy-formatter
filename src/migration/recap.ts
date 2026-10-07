// The migration RECAP: what the import found and would write, as pure data plus
// the exact text the user is asked to confirm (v0.5.0, MIGRATION).
//
// PURE: no 'vscode' (the two commands/* helpers imported below have no top-level
// 'vscode' import either), so the recap and its wording are unit-testable.
//
// CONSENT CONTRACT, unchanged: the recap lists every exact key and value that
// WOULD be written and the target scope; nothing is written before the user
// confirms it; cancelling writes nothing. It is rendered in the PRE-write tense
// only ("would", "if you confirm"): no sentence here may claim a write happened.
//
// HONESTY CONTRACT:
//   - it names WHICH file was used (first found wins) and never presents
//     `.jsbeautifyrc` as a file the incumbent reads: it does not;
//   - `onSave` is reported as "not migrated: Tidy never enables Format On Save for
//     you", and no code path proposes it (true is the incumbent's own default, so
//     its presence says nothing about what the user chose);
//   - the closing promise is scoped to THIS import. The follow-up "make Tidy my
//     default formatter" command has its own, separate Format On Save question,
//     and the offer text (runMigration.ts) says so.
import { scopeLabelOf } from '../commands/formatOnSaveOptIn';
import type { WriteTarget } from '../commands/setDefaultFormatter';
import { mapLonefyConfigText } from './lonefyConfig';
import type { SourceReadResult } from './lonefySources';
import type {
  LonefyConfigMapping,
  MigrationSourceKind,
  MigrationWrite
} from './types';

/**
 * What a migration WOULD do, assembled from a source read. Pure data: no 'vscode'
 * types leak here, so it can be built and asserted in a unit test. The host turns
 * it into the recap text and, only on confirmation, the writes.
 */
export interface MigrationRecap {
  /** How the search for a config file ended. */
  readonly state: SourceReadResult['state'];
  /** The file that was used (first found wins); undefined when none was read. */
  readonly source: MigrationSourceKind | undefined;
  /** The scope the writes would go to. */
  readonly target: WriteTarget;
  /** The validated `tidy.*` settings that would be written (may be empty). */
  readonly writes: readonly MigrationWrite[];
  /** Keys this import did not carry over (section keys read `section.key`). */
  readonly unmapped: readonly string[];
  /** Notes about dropped values, or about an unusable file. */
  readonly warnings: readonly string[];
  /** `onSave` was present: recognised and reported, never mapped, never proposed. */
  readonly onSaveSeen: boolean;
  /** The file was found but could not be parsed / was not a JSON object. */
  readonly unusable: boolean;
  /** Why a found file could not be read (state 'unreadable' only). */
  readonly unreadableCause: string | undefined;
}

/** Short name of each source, used inside sentences and in mapper messages. */
const SOURCE_FILE_NAMES: Readonly<Record<MigrationSourceKind, string>> = {
  'workspace-formatter-json': '.vscode/formatter.json',
  'global-formatter-json': 'formatter.json',
  jsbeautifyrc: '.jsbeautifyrc'
};

/**
 * How the "Source:" line names each file. The `.jsbeautifyrc` line says plainly
 * that the incumbent does not read it: presenting it as the incumbent's file was
 * the v0.4.2 mistake.
 */
const SOURCE_DESCRIPTIONS: Readonly<Record<MigrationSourceKind, string>> = {
  'workspace-formatter-json':
    '.vscode/formatter.json in your first workspace folder (the JS-CSS-HTML ' +
    'Formatter local config)',
  'global-formatter-json':
    'formatter.json in the JS-CSS-HTML Formatter install folder (its global ' +
    'config)',
  jsbeautifyrc:
    '.jsbeautifyrc at a workspace root (JS-CSS-HTML Formatter does not read ' +
    'this file; other beautify extensions do)'
};

/** The literal onSave sentence: the product owner's wording, never proposed. */
export const ON_SAVE_NOT_MIGRATED =
  'onSave: not migrated: Tidy never enables Format On Save for you.';

/** The short file name of a source, for toasts and messages (e.g. .vscode/formatter.json). */
export function sourceFileNameOf(kind: MigrationSourceKind): string {
  return SOURCE_FILE_NAMES[kind];
}

/**
 * The scope each source imports to. A workspace file is a project preference and
 * goes to Workspace settings. The global file is the user's own machine-wide
 * config (and needs no open workspace), so it goes to User settings: putting it in
 * a project's settings.json would push a personal preference onto teammates.
 */
export function targetOfSource(kind: MigrationSourceKind | undefined): WriteTarget {
  return kind === 'global-formatter-json' ? 'global' : 'workspace';
}

/** Map a source's text with the vocabulary that source really has. */
function mapSource(kind: MigrationSourceKind, text: string): LonefyConfigMapping {
  return mapLonefyConfigText(text, {
    label: SOURCE_FILE_NAMES[kind],
    // Top-level flat keys are a .jsbeautifyrc thing; the incumbent ignores them.
    allowFlatKeys: kind === 'jsbeautifyrc'
  });
}

/** A recap that found and read nothing. */
function emptyRecap(state: SourceReadResult['state']): MigrationRecap {
  return {
    state,
    source: undefined,
    target: 'workspace',
    writes: [],
    unmapped: [],
    warnings: [],
    onSaveSeen: false,
    unusable: false,
    unreadableCause: undefined
  };
}

/**
 * Build a {@link MigrationRecap} from what {@link readMigrationSource} found.
 * PURE: maps the text (as data) and copies everything, never aliasing the input.
 */
export function buildMigrationRecap(read: SourceReadResult): MigrationRecap {
  if (read.state === 'unreadable') {
    return {
      ...emptyRecap(read.state),
      source: read.kind,
      target: targetOfSource(read.kind),
      unreadableCause: read.cause
    };
  }
  if (read.state !== 'found') {
    return emptyRecap(read.state);
  }

  const mapping = mapSource(read.kind, read.text);
  return {
    ...emptyRecap(read.state),
    source: read.kind,
    target: targetOfSource(read.kind),
    writes: mapping.writes.map((write) => ({ ...write })),
    unmapped: [...mapping.unmapped],
    warnings: [...mapping.warnings],
    onSaveSeen: mapping.onSaveSeen,
    unusable: mapping.unusable
  };
}

/**
 * Whether a recap has any concrete setting to write. PURE. Used by the host to
 * decide whether the "import settings" branch is even worth confirming.
 */
export function hasSettingsToWrite(recap: MigrationRecap): boolean {
  return recap.writes.length > 0;
}

/** One write as it would appear in settings.json: exact key, exact value. */
export function formatWriteLine(write: MigrationWrite): string {
  const value = JSON.stringify(write.value);
  return write.language === undefined
    ? `  "${write.key}": ${value}`
    : `  "[${write.language}]": { "${write.key}": ${value} }`;
}

/** The lines of the recap that describe the outcome of the search itself. */
function headlineLines(recap: MigrationRecap): string[] {
  if (recap.state === 'untrusted') {
    return [
      'This workspace is not trusted, so Tidy did not read any settings file. ' +
        'Trust the workspace and run this command again to import your ' +
        'JS-CSS-HTML Formatter settings. You can still make Tidy your default ' +
        'formatter.'
    ];
  }
  if (recap.state === 'none' || recap.source === undefined) {
    return [
      'No JS-CSS-HTML Formatter settings file was found, so there is nothing ' +
        'to import. Tidy looked for .vscode/formatter.json in your first ' +
        "workspace folder, for the extension's own global formatter.json " +
        '(readable only while the extension is installed and enabled), and for ' +
        'a .jsbeautifyrc at a workspace root. You can still make Tidy your ' +
        'default formatter.'
    ];
  }

  const name = SOURCE_FILE_NAMES[recap.source];
  const lines = [`Source: ${SOURCE_DESCRIPTIONS[recap.source]}.`];
  if (recap.state === 'unreadable') {
    lines.push(
      `Tidy found ${name} but could not read it (${recap.unreadableCause ?? 'unknown error'}), ` +
        'so nothing would be imported.'
    );
  } else if (recap.unusable) {
    lines.push(
      `Tidy found ${name} but could not use it, so nothing would be imported.`
    );
  } else if (hasSettingsToWrite(recap)) {
    lines.push(
      `Tidy would write these settings at the ${scopeLabelOf(recap.target)} scope:`
    );
    lines.push('');
    for (const write of recap.writes) {
      lines.push(formatWriteLine(write));
    }
  } else {
    lines.push(
      `Tidy found ${name}, but none of its options map to a Tidy setting, so ` +
        'nothing would be imported.'
    );
  }
  return lines;
}

/**
 * Render the human-readable recap of what the migration would do. PURE (returns a
 * plain string), so the exact wording is unit-testable and can be shown as the
 * modal detail by the host.
 *
 * TENSE INVARIANT: shown BEFORE any write, so every sentence is conditional or a
 * statement about what is NOT being changed. The closing promise is scoped to this
 * import: the follow-up formatter command has its own confirmation and its own
 * Format On Save question.
 */
export function formatRecapMessage(recap: MigrationRecap): string {
  const lines = headlineLines(recap);

  const leftOut: string[] = [];
  if (recap.onSaveSeen) {
    leftOut.push(ON_SAVE_NOT_MIGRATED);
  }
  if (recap.unmapped.length > 0) {
    leftOut.push(
      'Not carried over (this import does not map these keys): ' +
        `${recap.unmapped.join(', ')}.`
    );
  }
  if (leftOut.length > 0) {
    lines.push('');
    lines.push(...leftOut);
  }

  if (recap.warnings.length > 0) {
    lines.push('');
    lines.push('Notes:');
    for (const warning of recap.warnings) {
      lines.push(`  • ${warning}`);
    }
  }

  lines.push('');
  lines.push(
    hasSettingsToWrite(recap)
      ? 'Nothing has been changed yet. Tidy will only write the settings listed ' +
          'above if you confirm. This import never enables Format On Save and ' +
          'never disables any other extension for you.'
      : 'Nothing was changed. This import never enables Format On Save and ' +
          'never disables any other extension for you.'
  );
  return lines.join('\n');
}
