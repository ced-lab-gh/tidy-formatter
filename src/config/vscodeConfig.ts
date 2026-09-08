// VS Code-facing config reader: gathers the precedence layers from the live
// editor (workspace settings, FormattingOptions injected per call, the
// language-specific [lang] block) and delegates the actual merge/mapping to the
// pure resolveOptions(). This is the ONLY config module that imports 'vscode',
// so the merge logic stays unit-testable outside the Electron host.
//
// Covers the MVP slice of the precedence chain (SPEC §6 layers 1 + 2):
//   (1) builtin defaults            -> seeded inside resolveOptions
//   (2) VS Code settings (global tidy.* + [lang] editor settings)
//       + live FormattingOptions (tabSize / insertSpaces injected per call)
// Layer (3) .editorconfig is wired below (read from disk via the pure
// editorconfig module). Layers (4) .soukformatrc and (5) glob overrides are
// added by later stages; they simply append further ConfigLayers after the ones
// built here, and the pure resolver already merges them deeply by key.
import * as vscode from 'vscode';
import type { LangId, ResolvedOptions } from '../types';
import { resolveOptions, type ConfigLayer } from './resolver';
import { readEditorConfigLayer } from './editorconfig';
import { editorConfigUnavailableWarnings } from './editorconfigAvailability';
// The shared "Tidy Formatter" output channel: the ONE place a degraded install
// is stated, once per session, next to the format trace the user is reading.
import { getTidyOutputChannel } from '../diagnostics/outputChannel';
import {
  OPTION_CATALOG,
  appliesToLanguage,
  validateValue,
  type CatalogLang,
  type OptionEntry
} from './optionCatalog';
import { readSoukformatrcLayers } from './soukformatrc';
import {
  readPrettierrcLayer,
  PRETTIERRC_LANGS,
  type PrintEngineId
} from './prettierrc';
// Routing authority for "which engine will actually print this document".
// Type-only elsewhere in this module; here the value is needed because plain
// 'javascript' is routed on CONTENT (JSX re-routing), not on its languageId.
import { resolveEngineIdForSource } from '../engine/dispatcher';
import { resolveSizeLimit, type EffectiveSizeLimit } from './sizeLimit';

/** Origin labels surfaced verbatim in "Show Effective Configuration". */
const SOURCE_VSCODE_GLOBAL = 'VS Code settings (tidy.*)';
const SOURCE_VSCODE_LANG_PREFIX = 'VS Code settings';
const SOURCE_VSCODE_LANG = 'VS Code settings ([lang] editor)';
const SOURCE_FORMATTING_OPTIONS = 'FormattingOptions (live, per call)';

/**
 * Source label for a per-language `tidy.*` value, e.g.
 * "VS Code settings (tidy.* [typescript])".
 */
function langScopedSource(languageId: LangId): string {
  return `${SOURCE_VSCODE_LANG_PREFIX} (tidy.* [${languageId}])`;
}

/**
 * The bare suffix of a catalogue setting key (drop the leading "tidy.").
 */
function settingSuffix(entry: OptionEntry): string {
  return entry.settingKey.startsWith('tidy.')
    ? entry.settingKey.slice('tidy.'.length)
    : entry.settingKey;
}

/**
 * The resolver-facing key for an entry's value:
 *  - prettier options are carried as flat `prettier.<engineKey>` keys so the pure
 *    resolver merges them by key and then nests them into engineOptions.prettier;
 *  - js-beautify/core options use their engineKey directly.
 */
function resolverKey(entry: OptionEntry): string {
  return entry.engine === 'prettier' ? `prettier.${entry.engineKey}` : entry.engineKey;
}

/**
 * Read a value from a configuration section only when it was explicitly set by
 * the user (any scope), so that an unset key does not inject a default that
 * would shadow a higher-precedence layer. Returns undefined when not set.
 */
function readExplicit<T>(
  config: vscode.WorkspaceConfiguration,
  key: string
): T | undefined {
  const inspected = config.inspect<T>(key);
  if (!inspected) {
    return undefined;
  }
  const candidate =
    inspected.workspaceFolderLanguageValue ??
    inspected.workspaceLanguageValue ??
    inspected.globalLanguageValue ??
    inspected.defaultLanguageValue ??
    inspected.workspaceFolderValue ??
    inspected.workspaceValue ??
    inspected.globalValue;
  return candidate;
}

/**
 * Read a non-language-scoped value (the plain `tidy.*` setting, any scope) only
 * when explicitly set. Used for the global catalogue layer.
 */
function readGlobalExplicit<T>(
  config: vscode.WorkspaceConfiguration,
  key: string
): T | undefined {
  const inspected = config.inspect<T>(key);
  if (!inspected) {
    return undefined;
  }
  return (
    inspected.workspaceFolderValue ??
    inspected.workspaceValue ??
    inspected.globalValue
  );
}

/**
 * Read a language-scoped value (a `[lang]: { "tidy.x": ... }` override) only when
 * explicitly set for that language. Used for the per-language catalogue layer so
 * the language override wins over (and is attributed separately from) the global
 * value.
 */
function readLanguageExplicit<T>(
  config: vscode.WorkspaceConfiguration,
  key: string
): T | undefined {
  const inspected = config.inspect<T>(key);
  if (!inspected) {
    return undefined;
  }
  return (
    inspected.workspaceFolderLanguageValue ??
    inspected.workspaceLanguageValue ??
    inspected.globalLanguageValue
  );
}

/**
 * Build the global `tidy.*` engine-option layer from the catalogue. Only keys the
 * user actually set (at a non-language scope) AND that apply to this language are
 * included; package.json defaults are intentionally not injected so the resolver's
 * built-in defaults remain the lowest layer. Every value is validated against the
 * catalogue (type/enum) before it is forwarded : an invalid value is dropped, not
 * propagated.
 */
function buildTidyGlobalLayer(
  document: vscode.TextDocument,
  languageId: LangId
): ConfigLayer {
  const config = vscode.workspace.getConfiguration('tidy', document.uri);
  const values: Record<string, unknown> = {};
  for (const entry of OPTION_CATALOG) {
    if (!appliesToLanguage(entry, languageId as CatalogLang)) {
      continue;
    }
    const raw = readGlobalExplicit<unknown>(config, settingSuffix(entry));
    const valid = validateValue(entry, raw);
    if (valid !== undefined) {
      values[resolverKey(entry)] = valid;
    }
  }
  return { source: SOURCE_VSCODE_GLOBAL, values };
}

/**
 * Build the per-language `tidy.*` override layer from the catalogue: values set in
 * a `[lang]` block win over the global `tidy.*` value (CFG per-language). Only
 * `language-overridable` entries can carry a language-scoped value; each is
 * validated before being forwarded.
 */
function buildTidyLanguageLayer(
  document: vscode.TextDocument,
  languageId: LangId
): ConfigLayer {
  const config = vscode.workspace.getConfiguration('tidy', {
    uri: document.uri,
    languageId
  });
  const values: Record<string, unknown> = {};
  for (const entry of OPTION_CATALOG) {
    if (entry.scope !== 'language-overridable') {
      continue;
    }
    if (!appliesToLanguage(entry, languageId as CatalogLang)) {
      continue;
    }
    const raw = readLanguageExplicit<unknown>(config, settingSuffix(entry));
    const valid = validateValue(entry, raw);
    if (valid !== undefined) {
      values[resolverKey(entry)] = valid;
    }
  }
  return { source: langScopedSource(languageId), values };
}

/**
 * Build the language-scoped editor-settings layer: the `[lang]` block plus the
 * file-level newline/whitespace settings VS Code applies per language. These map
 * to the canonical typed fields of ResolvedOptions.
 */
function buildLanguageEditorLayer(
  document: vscode.TextDocument,
  languageId: LangId
): ConfigLayer {
  const scope = { uri: document.uri, languageId };
  const editorConfig = vscode.workspace.getConfiguration('editor', scope);
  const filesConfig = vscode.workspace.getConfiguration('files', scope);

  const values: Record<string, unknown> = {};

  const tabSize = readExplicit<number>(editorConfig, 'tabSize');
  if (tabSize !== undefined) {
    values.tabSize = tabSize;
  }
  const insertSpaces = readExplicit<boolean>(editorConfig, 'insertSpaces');
  if (insertSpaces !== undefined) {
    values.insertSpaces = insertSpaces;
  }

  const eol = readExplicit<string>(filesConfig, 'eol');
  if (eol !== undefined && eol !== 'auto') {
    // VS Code spells these '\n' / '\r\n'; normalise to the canonical vocabulary.
    if (eol === '\n') {
      values.endOfLine = 'lf';
    } else if (eol === '\r\n') {
      values.endOfLine = 'crlf';
    }
  }
  const insertFinalNewline = readExplicit<boolean>(
    filesConfig,
    'insertFinalNewline'
  );
  if (insertFinalNewline !== undefined) {
    values.insertFinalNewline = insertFinalNewline;
  }
  const trimTrailing = readExplicit<boolean>(
    filesConfig,
    'trimTrailingWhitespace'
  );
  if (trimTrailing !== undefined) {
    values.trimTrailingWhitespace = trimTrailing;
  }

  return { source: SOURCE_VSCODE_LANG, values };
}

/**
 * Build the live FormattingOptions layer. VS Code injects tabSize/insertSpaces
 * on every provider call; per SPEC §6 these sit at the top of layer (2) so they
 * govern in the absence of .editorconfig / project config, yet remain
 * surclassable by those higher layers added later in the chain.
 */
function buildFormattingOptionsLayer(
  formattingOptions: vscode.FormattingOptions
): ConfigLayer {
  const values: Record<string, unknown> = {
    tabSize: formattingOptions.tabSize,
    insertSpaces: formattingOptions.insertSpaces
  };
  return { source: SOURCE_FORMATTING_OPTIONS, values };
}

/**
 * Whether the .editorconfig cascade should be read for this document.
 *
 * Three gates, all must pass (SPEC §6 / CFG-03 / Workspace Trust):
 *   1. opt-out `tidy.editorconfig` (default true) is not disabled;
 *   2. the workspace is trusted : in Restricted Mode we must not read configs
 *      defined by the workspace (a .editorconfig is workspace-authored content);
 *   3. the document has a real on-disk path (scheme 'file'); untitled/virtual
 *      documents have no cascade to walk.
 */
function shouldReadEditorConfig(document: vscode.TextDocument): boolean {
  if (document.uri.scheme !== 'file') {
    return false;
  }
  if (vscode.workspace.isTrusted === false) {
    return false;
  }
  const config = vscode.workspace.getConfiguration('tidy', document.uri);
  // Default true: absent setting must behave as enabled.
  return config.get<boolean>('editorconfig', true) !== false;
}

/**
 * Result of building the .editorconfig layer: the layer itself when there is
 * one, plus any warning that must be surfaced about the layer's own
 * availability (never about the user's file content).
 */
export interface EditorConfigLayerResult {
  readonly layer?: ConfigLayer;
  readonly warnings: string[];
}

/**
 * Whether the "the EditorConfig parser could not be loaded" notice has already
 * been written to the output channel in this extension host session.
 *
 * Session-scoped and one-shot BY DESIGN: the condition is an install-level fact
 * that cannot change until the extension is reinstalled, so repeating it on
 * every format would be a nag rather than information. "Show Effective
 * Configuration" still reports it every time it is asked, because there the
 * user asked.
 */
let editorConfigUnavailableLogged = false;

/**
 * State the degraded .editorconfig layer ONCE, in the output channel the format
 * trace already writes to. Never throws: a diagnostic surface must not be able
 * to break a format, which is precisely the failure mode this notice is about.
 */
function logEditorConfigUnavailableOnce(warnings: readonly string[]): void {
  if (warnings.length === 0 || editorConfigUnavailableLogged) {
    return;
  }
  editorConfigUnavailableLogged = true;
  try {
    const channel = getTidyOutputChannel();
    for (const warning of warnings) {
      channel.appendLine(`[config] ${warning}`);
    }
  } catch {
    // No channel (host teardown, a test double): the notice is still returned
    // to the caller for "Show Effective Configuration".
  }
}

/**
 * Build the .editorconfig layer (precedence layer 3) for a document, or nothing
 * when it is gated off or yields no usable value. Reading happens in the pure
 * editorconfig module; here we apply the VS Code-level gates AND report the one
 * case the layer cannot report itself: its parser failed to load, so the whole
 * layer is missing from an install that still formats perfectly happily.
 *
 * The warning is produced only when the layer WOULD have been read; a user who
 * turned `tidy.editorconfig` off is told nothing, because nothing is wrong.
 */
function buildEditorConfigLayer(
  document: vscode.TextDocument
): EditorConfigLayerResult {
  if (!shouldReadEditorConfig(document)) {
    return { warnings: [] };
  }
  const warnings = editorConfigUnavailableWarnings();
  logEditorConfigUnavailableOnce(warnings);
  return { layer: readEditorConfigLayer(document.uri.fsPath), warnings };
}

/**
 * Whether the .soukformatrc project config should be read for this document.
 * Same three gates as .editorconfig (SPEC §6 / Workspace Trust):
 *   1. opt-out `tidy.soukformatrc` (default true) is not disabled;
 *   2. the workspace is trusted (a .soukformatrc is workspace-authored content);
 *   3. the document has a real on-disk path (scheme 'file').
 */
function shouldReadSoukformatrc(document: vscode.TextDocument): boolean {
  if (document.uri.scheme !== 'file') {
    return false;
  }
  if (vscode.workspace.isTrusted === false) {
    return false;
  }
  const config = vscode.workspace.getConfiguration('tidy', document.uri);
  return config.get<boolean>('soukformatrc', true) !== false;
}

/**
 * Result of reading the project config layers, with the resolved file path (for
 * the "Show Effective Configuration" header) and any non-fatal warnings.
 */
export interface SoukformatrcLayers {
  readonly path?: string;
  readonly layers: ConfigLayer[];
  readonly warnings: string[];
}

/**
 * Stated when a document has no workspace folder to bound the .soukformatrc
 * walk. Silence here would be the same defect as an unbounded walk seen from
 * the other side: the user would have no way to tell "no config found" from
 * "config deliberately not read".
 */
const SOUKFORMATRC_NO_WORKSPACE_WARNING =
  '.soukformatrc: this document is not inside an open workspace folder, so no ' +
  'project config is read for it. The upward search is bounded to the ' +
  'workspace so a .soukformatrc outside it can never change how your code is ' +
  'formatted. Open the containing folder to have it apply.';

/**
 * Build the .soukformatrc layers (precedence layer 4 + glob overrides as layer 5)
 * for a document, applying the VS Code-level gates. The upward walk is BOUNDED
 * to the document's own workspace folder: a .soukformatrc in a parent of the
 * workspace, in the user's home directory or at the filesystem root is a file
 * the user never opened and must not govern their formatting. A document
 * outside every workspace folder therefore gets no layer at all, and is told
 * so. Reading/parsing happens in the pure soukformatrc module; warnings are
 * surfaced rather than thrown (fail-soft).
 */
function buildSoukformatrcLayers(
  document: vscode.TextDocument,
  languageId: LangId
): SoukformatrcLayers {
  if (!shouldReadSoukformatrc(document)) {
    return { layers: [], warnings: [] };
  }
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (!folder || folder.uri.scheme !== 'file') {
    return { layers: [], warnings: [SOUKFORMATRC_NO_WORKSPACE_WARNING] };
  }
  const result = readSoukformatrcLayers(
    document.uri.fsPath,
    languageId as CatalogLang,
    folder.uri.fsPath
  );
  return {
    path: result.path,
    layers: result.layers,
    warnings: result.warnings.map((w) => w.message)
  };
}

/**
 * Whether the project's Prettier config should be read for this document.
 * Four gates, all must pass (ADD-13):
 *   1. the language is on the Prettier path (ts/tsx/jsx, plus 'javascript'
 *      whose JSX files the dispatcher re-routes to Prettier);
 *   2. opt-out `tidy.prettier.respectProjectConfig` (default true) is enabled;
 *   3. the workspace is trusted: a .prettierrc is workspace-authored content
 *      and must never be honoured in Restricted Mode;
 *   4. the document has a real on-disk path (scheme 'file').
 */
function shouldReadPrettierrc(
  document: vscode.TextDocument,
  languageId: LangId
): boolean {
  if (!PRETTIERRC_LANGS.includes(languageId)) {
    return false;
  }
  if (document.uri.scheme !== 'file') {
    return false;
  }
  if (vscode.workspace.isTrusted === false) {
    return false;
  }
  const config = vscode.workspace.getConfiguration('tidy', document.uri);
  // Default true: absent setting must behave as enabled.
  return config.get<boolean>('prettier.respectProjectConfig', true) !== false;
}

/**
 * Result of reading the project's Prettier config, with the resolved file path
 * (for "Show Effective Configuration") and any non-fatal warnings.
 */
export interface PrettierrcLayer {
  readonly path?: string;
  readonly layer?: ConfigLayer;
  readonly warnings: string[];
}

/**
 * Which engine will really PRINT this document.
 *
 * Asked of the dispatcher, never re-derived here, so there is exactly one
 * routing rule in the codebase. It only ever differs from the languageId's
 * static answer for plain 'javascript', which js-beautify prints unless the
 * file genuinely contains JSX, in which case Prettier does and the project's
 * Prettier indentation must govern it like any other Prettier-printed file.
 *
 * The dispatcher answers the DOCUMENT, not a selection: a selection formatted
 * inside a JSX file may still be printed by js-beautify, and it then keeps the
 * indentation the document as a whole is printed with, which is the consistent
 * result and states nothing false either way.
 */
function documentPrintEngine(
  document: vscode.TextDocument,
  languageId: LangId
): PrintEngineId {
  return resolveEngineIdForSource(languageId, document.getText()) === 'prettier'
    ? 'prettier'
    : 'js-beautify';
}

/**
 * Build the .prettierrc layer (inserted between .editorconfig and
 * .soukformatrc) for a document, applying the VS Code-level gates. The upward
 * walk is BOUNDED to the document's own workspace folder; a document outside
 * every workspace folder gets no layer (there is no trusted boundary to walk
 * within). Reading/parsing happens in the pure prettierrc module; warnings are
 * surfaced rather than thrown (fail-soft).
 */
function buildPrettierrcLayer(
  document: vscode.TextDocument,
  languageId: LangId
): PrettierrcLayer {
  if (!shouldReadPrettierrc(document, languageId)) {
    return { warnings: [] };
  }
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (!folder || folder.uri.scheme !== 'file') {
    return { warnings: [] };
  }
  const result = readPrettierrcLayer(
    document.uri.fsPath,
    languageId,
    folder.uri.fsPath,
    documentPrintEngine(document, languageId)
  );
  return {
    path: result.path,
    layer: result.layer,
    warnings: result.warnings.map((w) => w.message)
  };
}

/**
 * Assemble the ordered precedence layers (general -> specific) for a document,
 * also returning the .soukformatrc path + warnings for diagnostics.
 *
 * Layer order, matching SPEC §6:
 *   0. builtin defaults                      (seeded inside resolveOptions)
 *   1. tidy.* global engine options          ┐ layer (2)
 *   2. tidy.* [lang] overrides               │ VS Code settings
 *   3. [lang] editor settings (eol/newline)  │
 *   4. live FormattingOptions (per call)     ┘ + FormattingOptions
 *   5. .editorconfig cascade        (layer 3) : team config wins over VS Code
 *   6. .prettierrc project config   (layer 3.5, ADD-13, Prettier path only)
 *   7. .soukformatrc language section (layer 4)
 *   8. .soukformatrc glob overrides  (layer 5) : most specific, win last
 *
 * All three project-config families (.editorconfig, .prettierrc, .soukformatrc)
 * are gated by their opt-out setting, Workspace Trust, and an on-disk URI; when
 * gated off (or empty) they are simply omitted so the lower layers govern
 * unchanged.
 */
function buildLayers(
  document: vscode.TextDocument,
  languageId: LangId,
  formattingOptions: vscode.FormattingOptions
): {
  layers: ConfigLayer[];
  souk: SoukformatrcLayers;
  prettierrc: PrettierrcLayer;
  editorconfig: EditorConfigLayerResult;
} {
  const layers: ConfigLayer[] = [
    buildTidyGlobalLayer(document, languageId),
    buildTidyLanguageLayer(document, languageId),
    buildLanguageEditorLayer(document, languageId),
    buildFormattingOptionsLayer(formattingOptions)
  ];

  const editorconfig = buildEditorConfigLayer(document);
  if (editorconfig.layer) {
    layers.push(editorconfig.layer);
  }

  // .prettierrc project config (ADD-13): inserted between .editorconfig and
  // .soukformatrc, so a team Prettier config beats editor/EditorConfig values
  // while an explicit .soukformatrc still has the last word.
  const prettierrc = buildPrettierrcLayer(document, languageId);
  if (prettierrc.layer) {
    layers.push(prettierrc.layer);
  }

  const souk = buildSoukformatrcLayers(document, languageId);
  layers.push(...souk.layers);

  return { layers, souk, prettierrc, editorconfig };
}

/**
 * Build ResolvedOptions for a document, reading VS Code configuration (global +
 * per-language `tidy.*`), the per-call FormattingOptions, the on-disk
 * .editorconfig cascade and the .soukformatrc project config, then resolving
 * through the pure resolver. See buildLayers for the full precedence order.
 */
export function readResolvedOptions(
  document: vscode.TextDocument,
  languageId: LangId,
  formattingOptions: vscode.FormattingOptions
): ResolvedOptions {
  const { layers } = buildLayers(document, languageId, formattingOptions);
  return resolveOptions({ languageId, layers });
}

/**
 * Like readResolvedOptions but also returns the resolved .soukformatrc and
 * .prettierrc paths plus every layer's non-fatal warnings (.editorconfig's
 * included: an install whose EditorConfig parser failed to load has no such
 * layer at all, which the user can otherwise only discover by noticing their
 * indentation is wrong), for the "Show Effective Configuration" command and the
 * provider's diagnostic logging. The ResolvedOptions are identical.
 */
export function readResolvedOptionsWithDiagnostics(
  document: vscode.TextDocument,
  languageId: LangId,
  formattingOptions: vscode.FormattingOptions
): {
  options: ResolvedOptions;
  soukformatrcPath?: string;
  warnings: string[];
  prettierrcPath?: string;
  prettierrcWarnings: string[];
  editorconfigWarnings: string[];
} {
  const { layers, souk, prettierrc, editorconfig } = buildLayers(
    document,
    languageId,
    formattingOptions
  );
  const options = resolveOptions({ languageId, layers });
  return {
    options,
    soukformatrcPath: souk.path,
    warnings: souk.warnings,
    prettierrcPath: prettierrc.path,
    prettierrcWarnings: prettierrc.warnings,
    editorconfigWarnings: editorconfig.warnings
  };
}

/**
 * Resolve the effective per-family size cap for a document (ADD-08). Reads the
 * two governing settings ONLY when explicitly set by the user (any scope, via
 * inspect) and delegates precedence + validation to the pure resolveSizeLimit.
 * Used by the formatting provider (too-large gate), the status bar and
 * "Show Effective Configuration" so all three always agree.
 */
export function readSizeLimit(
  document: vscode.TextDocument,
  languageId: LangId
): EffectiveSizeLimit {
  const config = vscode.workspace.getConfiguration('tidy', document.uri);
  return resolveSizeLimit({
    languageId,
    globalKB: readExplicit<unknown>(config, 'maxFileSizeKB'),
    jsonKB: readExplicit<unknown>(config, 'json.maxFileSizeKB')
  });
}
