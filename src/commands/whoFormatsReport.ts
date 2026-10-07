// The report of "Tidy: Who Formats This File?" (PURE: no 'vscode', no I/O, no throw).
//
// The plain facts about one file go in (`WhoFormatsFacts`, gathered by whoFormats.ts);
// the text for the output channel, the one-sentence toast headline and the buttons come
// out. CONTENT-FREE by construction: the facts carry the file's BASE NAME and language,
// setting values and extension ids, and nothing from the document itself.
//
// The last section of every report states what no API can reveal: an extension can
// format on save through its OWN save hook. It is printed whatever else was found.
import { LONEFY_EXTENSION_ID } from '../migration/detectLonefy';
import { LONEFY_LOCAL_CONFIG_SEGMENTS } from '../migration/lonefySources';
import {
  isAbsent,
  renderValue,
  resolveKeyedSources,
  resolveScalarSource,
  sameValue,
  type ScalarSource,
  type SettingProbe
} from './whoFormatsScopes';

// VS Code built-in commands the buttons run. Both only OPEN a view: the Settings UI
// (query string) and the Extensions view filtered to what is INSTALLED, so neither
// writes anything nor asks the Marketplace for anything.
export const OPEN_SETTINGS_COMMAND_ID = 'workbench.action.openSettings';
export const SEARCH_EXTENSIONS_COMMAND_ID = 'workbench.extensions.search';

/** The ONLY command ids this feature may ever execute. Everything else is refused. */
export const OPEN_ONLY_COMMAND_IDS: readonly string[] = [
  OPEN_SETTINGS_COMMAND_ID,
  SEARCH_EXTENSIONS_COMMAND_ID
];

const INCUMBENT_NAME = 'JS-CSS-HTML Formatter';
const INCUMBENT_CONFIG_LABEL = LONEFY_LOCAL_CONFIG_SEGMENTS.join('/');

/** The three VS Code core settings that edit a file on EVERY save, formatter or not. */
export const SAVE_TIME_EDIT_KEYS: readonly string[] = [
  'trimTrailingWhitespace',
  'insertFinalNewline',
  'trimFinalNewlines'
];

/* -------------------------------------------------------------------------- */
/* Facts and report (pure)                                                     */
/* -------------------------------------------------------------------------- */

export type FormatterExtension =
  /** editor.defaultFormatter is not set. */
  | { readonly state: 'none' }
  /** editor.defaultFormatter holds something that is not an extension id. */
  | { readonly state: 'invalid-id'; readonly rendered: string }
  | {
      readonly state: 'found';
      readonly id: string;
      readonly displayName?: string;
      readonly isTidy: boolean;
    }
  /** `getExtension` returns undefined for a DISABLED extension too (probe P4). */
  | { readonly state: 'not-visible'; readonly id: string; readonly isTidy: boolean }
  | { readonly state: 'unknown'; readonly id: string; readonly cause: string };

export type ConfigFileState =
  | { readonly state: 'found' }
  | { readonly state: 'absent' }
  | { readonly state: 'not-a-file' }
  | { readonly state: 'not-checked'; readonly reason: 'restricted' | 'no-folder' };

export type CompetingScan =
  | { readonly state: 'scanned'; readonly names: readonly string[] }
  | { readonly state: 'not-scanned'; readonly reason: 'restricted' | 'no-folder' };

export type WorkspaceKind = 'none' | 'folder' | 'multi-root';

/** Everything the report says, as plain data. Gathered by the host section below. */
export interface WhoFormatsFacts {
  /** Base name only, never the full path. */
  readonly fileName: string;
  readonly languageId: string;
  /** `folder` = one folder, no .code-workspace; `multi-root` = a workspace file or several folders. */
  readonly workspaceKind: WorkspaceKind;
  readonly defaultFormatter: SettingProbe;
  readonly formatterExtension: FormatterExtension;
  readonly formatOnSave: SettingProbe;
  readonly formatOnSaveMode: SettingProbe;
  readonly codeActionsOnSave: SettingProbe;
  /** `files.trimTrailingWhitespace` and its two siblings, in SAVE_TIME_EDIT_KEYS order. */
  readonly saveTimeEdits: ReadonlyArray<{ readonly key: string; readonly probe: SettingProbe }>;
  /** isLonefyPresentIn(): true only when the incumbent is installed AND enabled. */
  readonly incumbentVisible: boolean;
  readonly incumbentConfig: ConfigFileState;
  readonly competing: CompetingScan;
  /** Injected only by tests for a deterministic header timestamp. */
  readonly now?: string;
}

/** A one-click remedy: a built-in command and plain-string arguments. It only OPENS something. */
export interface WhoFormatsAction {
  readonly label: string;
  readonly commandId: string;
  readonly args: readonly string[];
}

export interface WhoFormatsReport {
  /** One sentence for the toast. */
  readonly headline: string;
  /** The full report, one entry per output-channel line. */
  readonly lines: readonly string[];
  readonly actions: readonly WhoFormatsAction[];
}

const SUB = '     ';

function sourceLines(source: ScalarSource, effective: unknown): readonly string[] {
  switch (source.kind) {
    case 'layer':
      return [
        `${SUB}set by: ${source.winner.label}`,
        ...source.others.map(
          (other) =>
            `${SUB}also set: ${other.label} = ${renderValue(other.value)} ` +
            `(${sameValue(other.value, effective) ? 'same value' : 'not in effect'})`
        )
      ];
    case 'unset':
      return [`${SUB}set by: no scope sets it`];
    case 'undetermined':
      return [
        `${SUB}set by: could not be determined (${source.reason}).`,
        ...source.candidates.map(
          (candidate) => `${SUB}value found at: ${candidate.label} = ${renderValue(candidate.value)}`
        )
      ];
  }
}

/** The scope of a setting in a few words, for one-line uses. */
function shortSource(probe: SettingProbe, languageId: string): string {
  if (probe.state !== 'read') {
    return 'could not be read';
  }
  const source = resolveScalarSource(probe.effective, probe.layers, languageId);
  switch (source.kind) {
    case 'layer':
      return source.winner.label;
    case 'unset':
      return 'no scope sets it';
    case 'undetermined':
      return 'scope could not be determined';
  }
}

function formatterExtensionLines(extension: FormatterExtension, languageId: string): readonly string[] {
  switch (extension.state) {
    case 'none':
      return [
        `   No default formatter is set for ${languageId}. VS Code chooses at format time ` +
          '(it asks you when several formatters could apply).'
      ];
    case 'invalid-id':
      return [`   The value ${extension.rendered} is not an extension id, so it names no formatter.`];
    case 'found': {
      const name = extension.displayName ? `${extension.displayName} (${extension.id})` : extension.id;
      return [
        `   Extension: ${name} is installed and enabled. ` +
          (extension.isTidy ? 'That is Tidy.' : 'It is not Tidy.')
      ];
    }
    case 'not-visible':
      return [
        `   Extension: ${extension.id} is not visible to VS Code's extension API. It is not installed, ` +
          'or it is installed but disabled (the API cannot tell these apart). ' +
          'Either way it cannot be the one formatting this file.'
      ];
    case 'unknown':
      return [`   Extension: ${extension.id} could not be checked (${extension.cause}).`];
  }
}

function defaultFormatterLines(facts: WhoFormatsFacts): readonly string[] {
  const { defaultFormatter: probe, languageId } = facts;
  const head = `1. Default formatter for ${languageId}`;
  if (probe.state === 'unreadable') {
    return [head, `   editor.defaultFormatter could not be read (${probe.cause}).`];
  }
  const valueText = isAbsent(probe.effective) ? 'null (no default formatter)' : renderValue(probe.effective);
  return [
    head,
    `   editor.defaultFormatter = ${valueText}`,
    ...sourceLines(resolveScalarSource(probe.effective, probe.layers, languageId), probe.effective),
    ...formatterExtensionLines(facts.formatterExtension, languageId)
  ];
}

const MODE_GLOSS: Readonly<Record<string, string>> = {
  file: 'the whole file',
  modifications: 'only the modified lines, which needs source control',
  modificationsIfAvailable: 'only the modified lines when source control is available, else the whole file'
};

/** editor.formatOnSave is a boolean; anything else is reported as not interpretable. */
function formatOnSaveState(probe: SettingProbe): 'on' | 'off' | 'unknown' {
  if (probe.state !== 'read') {
    return 'unknown';
  }
  if (probe.effective === true) {
    return 'on';
  }
  return probe.effective === false || probe.effective === undefined || probe.effective === null
    ? 'off'
    : 'unknown';
}

function formatOnSaveLines(facts: WhoFormatsFacts): readonly string[] {
  const { formatOnSave: probe, languageId } = facts;
  if (probe.state === 'unreadable') {
    return [`   editor.formatOnSave could not be read (${probe.cause}).`];
  }
  const state = formatOnSaveState(probe);
  const verdict =
    state === 'on'
      ? 'Result: format on save is ON for this file. On save, VS Code formats it with the formatter from section 1.'
      : state === 'off'
        ? 'Result: format on save is OFF for this file. VS Code itself does not reformat it when you save.'
        : 'Result: the value is not a boolean, so it could not be interpreted.';
  return [
    `   editor.formatOnSave = ${renderValue(probe.effective)}`,
    ...sourceLines(resolveScalarSource(probe.effective, probe.layers, languageId), probe.effective),
    `   ${verdict}`
  ];
}

function formatOnSaveModeLines(facts: WhoFormatsFacts): readonly string[] {
  const { formatOnSaveMode: probe, formatOnSave, languageId } = facts;
  if (probe.state === 'unreadable') {
    return [`   editor.formatOnSaveMode could not be read (${probe.cause}).`];
  }
  const gloss = typeof probe.effective === 'string' ? MODE_GLOSS[probe.effective] : undefined;
  const unused = formatOnSaveState(formatOnSave) === 'off';
  return [
    `   editor.formatOnSaveMode = ${renderValue(probe.effective)}${gloss ? ` (${gloss})` : ''}`,
    ...sourceLines(resolveScalarSource(probe.effective, probe.layers, languageId), probe.effective),
    ...(unused ? [`${SUB}(not used while format on save is off)`] : [])
  ];
}

const isRunOnSave = (value: unknown): boolean => value !== false && value !== 'never';

function codeActionsLines(facts: WhoFormatsFacts): readonly string[] {
  const { codeActionsOnSave: probe, languageId } = facts;
  if (probe.state === 'unreadable') {
    return [`   editor.codeActionsOnSave could not be read (${probe.cause}).`];
  }
  const keyed = resolveKeyedSources(probe.effective, probe.layers, languageId);
  switch (keyed.kind) {
    case 'none':
      return ['   editor.codeActionsOnSave: no code action is configured to run on save.'];
    case 'unrecognised':
      return [`   editor.codeActionsOnSave holds a value of an unexpected shape: ${keyed.rendered}.`];
    case 'entries': {
      const lines = keyed.entries.map(
        (entry) =>
          `${SUB}${entry.key} = ${renderValue(entry.value)}${isRunOnSave(entry.value) ? '' : ' (off)'}` +
          ` (set by: ${entry.source ?? 'could not be determined'})`
      );
      const legend = keyed.entries.some((e) => ['explicit', 'always', 'never'].includes(String(e.value)))
        ? [`${SUB}"explicit" runs on a manual save, "always" also on auto-save, "never" is off.`]
        : [];
      return [
        '   editor.codeActionsOnSave: these code actions run on save and can rewrite code:',
        ...lines,
        ...legend
      ];
    }
  }
}

function saveTimeEditLines(facts: WhoFormatsFacts): readonly string[] {
  const { saveTimeEdits, languageId } = facts;
  const on = saveTimeEdits.filter(({ probe }) => probe.state === 'read' && probe.effective === true);
  const unreadable = saveTimeEdits.filter(({ probe }) => probe.state === 'unreadable');
  const head = '   Other save-time edits made by VS Code itself';
  const unreadableLine =
    unreadable.length > 0
      ? [`${SUB}could not be read: ${unreadable.map(({ key }) => `files.${key}`).join(', ')}.`]
      : [];
  if (on.length === 0) {
    return [
      `${head}: none (${SAVE_TIME_EDIT_KEYS.map((k) => `files.${k}`).join(', ')} are off).`,
      ...unreadableLine
    ];
  }
  return [
    `${head}:`,
    ...on.map(({ key, probe }) => `${SUB}files.${key} = true (set by: ${shortSource(probe, languageId)})`),
    ...unreadableLine
  ];
}

function saveLines(facts: WhoFormatsFacts): readonly string[] {
  return [
    `2. Saving this file (${facts.languageId})`,
    ...formatOnSaveLines(facts),
    ...formatOnSaveModeLines(facts),
    ...codeActionsLines(facts),
    ...saveTimeEditLines(facts)
  ];
}

function configFileText(state: ConfigFileState): string {
  switch (state.state) {
    case 'found':
      return 'found.';
    case 'absent':
      return 'not found (or not readable).';
    case 'not-a-file':
      return 'exists but is a folder, not a file.';
    case 'not-checked':
      return state.reason === 'restricted'
        ? 'not checked: Restricted Mode (Workspace Trust) blocks reading workspace files.'
        : 'not checked: no folder is open.';
  }
}

function incumbentConclusion(facts: WhoFormatsFacts): readonly string[] {
  if (facts.incumbentVisible) {
    return [
      '   It is a known example of an extension that formats on save through its own save hook, ' +
        'independently of editor.formatOnSave, so it is a likely cause if this file changes when you save.'
    ];
  }
  if (facts.incumbentConfig.state === 'found') {
    return [
      '   The config file shows it was used in this workspace. If it is installed but disabled, it formats nothing.'
    ];
  }
  if (facts.incumbentConfig.state === 'absent') {
    return ['   Nothing points to it: it is not running in this window and left no config file here.'];
  }
  return [];
}

function incumbentLines(facts: WhoFormatsFacts): readonly string[] {
  return [
    `3. ${INCUMBENT_NAME} (${LONEFY_EXTENSION_ID})`,
    facts.incumbentVisible
      ? '   Extension: installed and enabled.'
      : "   Extension: not visible to VS Code's extension API. It is not installed, " +
        'or it is installed but disabled (the API cannot tell these apart).',
    `   Config file ${INCUMBENT_CONFIG_LABEL} in the first workspace folder: ${configFileText(facts.incumbentConfig)}`,
    ...incumbentConclusion(facts)
  ];
}

function competingLines(competing: CompetingScan): readonly string[] {
  const head = '4. Other formatters configured in this workspace';
  if (competing.state === 'not-scanned') {
    return [
      head,
      competing.reason === 'restricted'
        ? '   Not scanned: Restricted Mode (Workspace Trust) blocks reading workspace files.'
        : '   Not scanned: no folder is open.'
    ];
  }
  if (competing.names.length === 0) {
    return [
      head,
      '   None detected (looked for Prettier, Biome, dprint and ESLint config files at the workspace root).'
    ];
  }
  return [
    head,
    `   ${competing.names.join(', ')} (found through config files at the workspace root).`,
    '   A config file shows the workspace is set up for that tool. It does not prove the extension ' +
      'is installed or that it formats this file.'
  ];
}

function workspaceLine(kind: WorkspaceKind): string {
  switch (kind) {
    case 'none':
      return 'Workspace: no folder is open, so only User settings and defaults can apply.';
    case 'folder':
      return 'Workspace: one folder is open. Its .vscode/settings.json is the "Workspace settings" scope.';
    case 'multi-root':
      return (
        'Workspace: a multi-root workspace is open. "Workspace settings" is the .code-workspace file, ' +
        "and \"Workspace Folder settings\" is each folder's .vscode/settings.json."
      );
  }
}

/** Mandatory, and printed in every run whatever else the report found. */
const CANNOT_SEE_LINES: readonly string[] = [
  '5. What this report cannot see',
  '   An extension can format a file on save through its OWN save hook. VS Code gives extensions no way to observe that, so it can never appear above.',
  '   Apart from what section 2 lists: if this file changes on save while editor.formatOnSave is off for it, the cause is an extension doing that, and the JS-CSS-HTML Formatter is a known example.',
  '   To find the extension responsible, run "Help: Start Extension Bisect" (built into VS Code).',
  '   Tidy itself never hooks save. It formats only when VS Code asks it to: Format Document, or format on save that you turned on.'
];

/** A bounded single-line id or name. */
export function clampId(id: string): string {
  return id.length > 60 ? `${id.slice(0, 57)}...` : id;
}

/** One sentence for the toast: the answer, without the detail. */
export function buildHeadline(facts: WhoFormatsFacts): string {
  const lang = facts.languageId;
  const { defaultFormatter: probe } = facts;
  let defaultPart: string;
  if (probe.state === 'unreadable') {
    defaultPart = 'Default formatter: could not be read.';
  } else if (isAbsent(probe.effective)) {
    defaultPart = `No default formatter is set for ${lang}.`;
  } else {
    const source = resolveScalarSource(probe.effective, probe.layers, lang);
    const where = source.kind === 'layer' ? `, set by ${source.winner.label}` : '';
    const shown = typeof probe.effective === 'string' ? probe.effective : renderValue(probe.effective);
    defaultPart = `Default formatter: ${clampId(shown)}${where}.`;
  }
  const saveWord = formatOnSaveState(facts.formatOnSave);
  const incumbent = facts.incumbentVisible ? ` ${INCUMBENT_NAME} is installed and enabled.` : '';
  return (
    `Who formats ${facts.fileName}? ${defaultPart} Format on save: ${saveWord}.${incumbent} ` +
    'The full report is in the Tidy Formatter output.'
  );
}

/** Buttons that only OPEN something, in display order. */
export function buildActions(facts: WhoFormatsFacts): readonly WhoFormatsAction[] {
  const lang = facts.languageId;
  const extension = facts.formatterExtension;
  const findInstalled = (label: string, text: string): WhoFormatsAction => ({
    label,
    commandId: SEARCH_EXTENSIONS_COMMAND_ID,
    args: [`@installed ${text}`]
  });
  const incumbentRelevant = facts.incumbentVisible || facts.incumbentConfig.state === 'found';
  // The text after the publisher matches the extension's own name in the installed list.
  // Tidy itself is not worth a search, and a built-in (publisher "vscode") is not in the
  // installed list at all, so neither gets the button.
  const named = extension.state === 'found' || extension.state === 'not-visible' ? extension : undefined;
  const defaultExtensionName =
    named !== undefined && !named.isTidy && !named.id.toLowerCase().startsWith('vscode.')
      ? named.id.split('.').slice(1).join('.')
      : '';
  return [
    {
      label: 'Open Default Formatter Setting',
      commandId: OPEN_SETTINGS_COMMAND_ID,
      args: [`@lang:${lang} editor.defaultFormatter`]
    },
    {
      label: 'Open Format on Save Settings',
      commandId: OPEN_SETTINGS_COMMAND_ID,
      args: [`@lang:${lang} editor.formatOnSave`]
    },
    ...(incumbentRelevant ? [findInstalled(`Find ${INCUMBENT_NAME}`, INCUMBENT_NAME)] : []),
    ...(defaultExtensionName !== ''
      ? [findInstalled('Find Default Formatter Extension', defaultExtensionName)]
      : [])
  ];
}

/**
 * Build the whole report. PURE: no 'vscode', no I/O, no throw. Content-free by
 * construction: it carries the file's BASE NAME and language, setting values and
 * extension ids, and nothing from the document itself.
 */
export function buildWhoFormatsReport(facts: WhoFormatsFacts): WhoFormatsReport {
  const actions = buildActions(facts);
  const lines: readonly string[] = [
    `=== Who formats this file? @ ${facts.now ?? new Date().toISOString()} ===`,
    `File: ${facts.fileName} (${facts.languageId})`,
    workspaceLine(facts.workspaceKind),
    '',
    ...defaultFormatterLines(facts),
    '',
    ...saveLines(facts),
    '',
    ...incumbentLines(facts),
    '',
    ...competingLines(facts.competing),
    '',
    ...CANNOT_SEE_LINES,
    ...(actions.length > 0
      ? ['', 'Suggested actions (buttons on the notification; they only open a view):']
      : []),
    ...actions.map((action) => `   > ${action.label}`)
  ];
  return { headline: buildHeadline(facts), lines, actions };
}
