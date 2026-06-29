// Command: "Tidy: Show Effective Configuration".
// Surfaces EVERY effective formatting option together with the SOURCE of each key
// (the direct antidote to lonefy review #2 "not enough options" + the "spent N
// hours debugging why 4 spaces" pain): the report lists every catalogue option
// that applies to the active language — whether the user set it or it fell back to
// a default — and where the winning value came from (VS Code global / per-language
// `tidy.<lang>` / .editorconfig / .soukformatrc / .soukformatrc glob override).
//
// Split of concerns (so the report builder is unit-testable without an Electron
// host): this module's TOP LEVEL imports NO 'vscode' — neither directly nor
// transitively. The pure report functions take plain data (a ReportInput), import
// only the pure optionCatalog + types, and are covered by a plain mocha+tsx test.
// The VS Code surface ('vscode', vscodeConfig) is required lazily INSIDE the
// handler, which only ever runs inside the extension host. A regression that
// re-introduces a top-level 'vscode' import would make the pure test fail to load
// (which is the point: commands/* touch 'vscode', but this report stays testable).
import type { LangId, ResolvedOptions } from '../types';
import {
  OPTION_CATALOG,
  appliesToLanguage,
  type CatalogLang,
  type OptionEntry
} from '../config/optionCatalog';

export const SHOW_CONFIG_COMMAND_ID = 'tidy.showEffectiveConfiguration';

const OUTPUT_CHANNEL_NAME = 'Tidy Formatter — Effective Configuration';

/**
 * The languageIds Tidy can resolve options for. Mirrors the provider list; kept
 * local so this command stays self-contained.
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

/** Placeholder shown when no precedence layer attributed a value. */
const DEFAULT_SOURCE = '(default)';

/* -------------------------------------------------------------------------- */
/* Pure report builder (no 'vscode' — unit-testable under mocha + tsx)         */
/* -------------------------------------------------------------------------- */

/**
 * The plain data the pure report builder needs. No 'vscode' types leak here so
 * the builder stays host-free and directly testable.
 */
export interface ReportInput {
  /** Display path of the formatted document (fsPath or a URI string). */
  readonly documentPath: string;
  /** The active document's languageId (already validated as supported). */
  readonly languageId: LangId;
  /** The resolved options + per-key source attribution from the pure resolver. */
  readonly options: ResolvedOptions;
  /** Absolute path of the .soukformatrc that contributed, if any. */
  readonly soukformatrcPath?: string;
  /** Non-fatal .soukformatrc warnings to surface (never throws). */
  readonly warnings: readonly string[];
  /** Injected only by tests for a deterministic header timestamp. */
  readonly now?: string;
}

/**
 * The resolver-facing source key for a catalogue entry. Mirrors the convention
 * shared by vscodeConfig/soukformatrc/resolver: prettier options are attributed
 * under the flat `prettier.<engineKey>` source key (kept even after the value is
 * nested into engineOptions.prettier); js-beautify/core options under their bare
 * engineKey. This is the key looked up in ResolvedOptions.sources.
 */
function sourceKeyFor(entry: OptionEntry): string {
  return entry.engine === 'prettier'
    ? `prettier.${entry.engineKey}`
    : entry.engineKey;
}

/**
 * Look up the recorded source for a key, defaulting to a clear placeholder when
 * the resolver did not attribute it (so the user always sees an origin — a value
 * with no attributed layer is, by definition, the built-in catalogue default).
 */
function sourceOf(options: ResolvedOptions, key: string): string {
  const source = options.sources[key];
  return source && source.length > 0 ? source : DEFAULT_SOURCE;
}

/**
 * The effective value of a catalogue entry for this resolution: the value the
 * winning layer set (read from engineOptions, or engineOptions.prettier for
 * prettier entries), else the catalogue default. PURE: pure lookups only.
 */
export function effectiveValueFor(
  options: ResolvedOptions,
  entry: OptionEntry
): boolean | number | string {
  if (entry.engine === 'prettier') {
    const bag = options.engineOptions.prettier;
    if (bag !== null && typeof bag === 'object') {
      const value = (bag as Record<string, unknown>)[entry.engineKey];
      if (value !== undefined) {
        return value as boolean | number | string;
      }
    }
    return entry.default;
  }
  const value = options.engineOptions[entry.engineKey];
  return value !== undefined
    ? (value as boolean | number | string)
    : entry.default;
}

/**
 * Whether a catalogue entry's value was actually set by a precedence layer (vs.
 * left at the built-in catalogue default). Used only to annotate the report.
 */
function isSetByLayer(options: ResolvedOptions, entry: OptionEntry): boolean {
  return options.sources[sourceKeyFor(entry)] !== undefined;
}

/**
 * Render a single "key = value  ← source" aligned line.
 */
export function renderLine(label: string, value: unknown, source: string): string {
  const valueText =
    typeof value === 'object' && value !== null
      ? JSON.stringify(value)
      : String(value);
  const left = `  ${label} = ${valueText}`;
  // Pad so the source column lines up for short keys; long lines just wrap.
  const padded = left.length < 48 ? left.padEnd(48, ' ') : `${left}  `;
  return `${padded}← ${source}`;
}

/**
 * Render the catalogue options of one engine family that apply to a language, in
 * a stable (settingKey-sorted) order. Returns the body lines (without a header);
 * an empty family yields a single "(none)" line so the section is never blank.
 */
function renderFamily(
  options: ResolvedOptions,
  languageId: LangId,
  engine: OptionEntry['engine']
): string[] {
  const entries = OPTION_CATALOG.filter(
    (entry) =>
      entry.engine === engine &&
      appliesToLanguage(entry, languageId as CatalogLang)
  ).sort((a, b) => a.settingKey.localeCompare(b.settingKey));

  if (entries.length === 0) {
    return ['  (none)'];
  }
  return entries.map((entry) => {
    const value = effectiveValueFor(options, entry);
    const source = isSetByLayer(options, entry)
      ? sourceOf(options, sourceKeyFor(entry))
      : DEFAULT_SOURCE;
    return renderLine(entry.settingKey, value, source);
  });
}

/**
 * The set of source keys printed in the catalogue/core sections, so the trailing
 * "other attributed sources" group only shows genuinely un-printed origins.
 */
function printedSourceKeys(languageId: LangId): Set<string> {
  const keys = new Set<string>([
    'tabSize',
    'insertSpaces',
    'endOfLine',
    'trimTrailingWhitespace',
    'insertFinalNewline'
  ]);
  for (const entry of OPTION_CATALOG) {
    if (appliesToLanguage(entry, languageId as CatalogLang)) {
      keys.add(sourceKeyFor(entry));
    }
  }
  return keys;
}

/**
 * Build the human-readable report of every effective option and its source.
 * PURE: no 'vscode', no I/O — fully unit-testable.
 */
export function buildEffectiveConfigReport(input: ReportInput): string {
  const { options, languageId } = input;
  const lines: string[] = [];

  lines.push('Tidy Formatter — Effective Configuration');
  lines.push('========================================');
  lines.push(`Document : ${input.documentPath}`);
  lines.push(`Language : ${languageId}`);
  lines.push(`Resolved : ${input.now ?? new Date().toISOString()}`);
  lines.push(`.soukformatrc : ${input.soukformatrcPath ?? '(none found)'}`);
  lines.push('');

  // Indentation (typed fields, not in the catalogue): the most-asked-about value.
  lines.push('Indentation (editor / FormattingOptions)');
  lines.push('----------------------------------------');
  lines.push(
    renderLine('tabSize', options.tabSize, sourceOf(options, 'tabSize'))
  );
  lines.push(
    renderLine(
      'insertSpaces',
      options.insertSpaces,
      sourceOf(options, 'insertSpaces')
    )
  );
  for (const key of [
    'endOfLine',
    'trimTrailingWhitespace',
    'insertFinalNewline'
  ] as const) {
    const value = options[key];
    lines.push(
      renderLine(
        key,
        value === undefined ? '(unset)' : value,
        value === undefined ? '(no layer set this)' : sourceOf(options, key)
      )
    );
  }

  // Catalogue options, grouped by family. Every option that APPLIES to the active
  // language is shown — set or defaulted — so the user sees the full surface.
  lines.push('');
  lines.push('js-beautify options (this language)');
  lines.push('-----------------------------------');
  lines.push(...renderFamily(options, languageId, 'jsbeautify'));

  lines.push('');
  lines.push('Cross-engine options (core)');
  lines.push('---------------------------');
  lines.push(...renderFamily(options, languageId, 'core'));

  lines.push('');
  lines.push('Prettier options (TS/JSX, stylistic — AST-invariant)');
  lines.push('----------------------------------------------------');
  lines.push(...renderFamily(options, languageId, 'prettier'));

  // Any attributed source the catalogue/core sections did not already print
  // (e.g. an unknown legacy engine key carried by a layer), for full traceability.
  const printed = printedSourceKeys(languageId);
  const extraSourceKeys = Object.keys(options.sources)
    .filter((key) => !printed.has(key))
    .sort();
  if (extraSourceKeys.length > 0) {
    lines.push('');
    lines.push('Other attributed sources');
    lines.push('------------------------');
    for (const key of extraSourceKeys) {
      lines.push(`  ${key}  ← ${options.sources[key]}`);
    }
  }

  if (input.warnings.length > 0) {
    lines.push('');
    lines.push('.soukformatrc warnings (non-fatal)');
    lines.push('----------------------------------');
    for (const warning of input.warnings) {
      lines.push(`  • ${warning}`);
    }
  }

  return lines.join('\n');
}

/* -------------------------------------------------------------------------- */
/* VS Code handler (loads 'vscode' lazily; runs only in the extension host)     */
/* -------------------------------------------------------------------------- */

// The handler types VS Code values loosely: the module must not import 'vscode'
// statically (that would break the pure test), so we load it (and the
// 'vscode'-bound vscodeConfig reader) lazily via require() inside the handler.
// The integration suite (real host) exercises this path end to end.
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */

function toSupportedLangId(languageId: string): LangId | undefined {
  return SUPPORTED_LANGUAGE_SET.has(languageId)
    ? (languageId as LangId)
    : undefined;
}

// Cached output channel (one per session, reused across invocations) so repeated
// runs don't leak channels. Typed loosely because we must not import 'vscode'.
let outputChannel: { clear(): void; appendLine(text: string): void; show(preserveFocus?: boolean): void } | undefined;

function getOutputChannel(vscode: any): {
  clear(): void;
  appendLine(text: string): void;
  show(preserveFocus?: boolean): void;
} {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  }
  return outputChannel as {
    clear(): void;
    appendLine(text: string): void;
    show(preserveFocus?: boolean): void;
  };
}

/**
 * Handler for the Show Effective Configuration command.
 *
 * Resolves the options for the active editor's language and renders every
 * effective key + its source in an output channel. Never throws: failures are
 * surfaced as a non-blocking message so the command can't break the editor.
 */
export async function showEffectiveConfiguration(): Promise<void> {
  const vscode = require('vscode');
  const { readResolvedOptionsWithDiagnostics } = require('../config/vscodeConfig');

  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showInformationMessage(
      'Tidy: ouvrez un fichier pour afficher sa configuration effective.'
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

  let options: ResolvedOptions;
  let soukformatrcPath: string | undefined;
  let warnings: string[] = [];
  try {
    const diag = readResolvedOptionsWithDiagnostics(
      document,
      languageId,
      formattingOptions
    );
    options = diag.options;
    soukformatrcPath = diag.soukformatrcPath;
    warnings = diag.warnings;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'unknown error';
    void vscode.window.showErrorMessage(
      `Tidy: impossible de resoudre la configuration (${message}).`
    );
    return;
  }

  const report = buildEffectiveConfigReport({
    documentPath: document.uri.fsPath || document.uri.toString(),
    languageId,
    options,
    soukformatrcPath,
    warnings
  });

  const channel = getOutputChannel(vscode);
  channel.clear();
  channel.appendLine(report);
  channel.show(true);
}
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */
