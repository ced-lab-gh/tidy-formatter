// Command: "Tidy: Who Formats This File?".
//
// The second most frequent need in the incumbent's reviews is a user whose code
// gets reformatted and who cannot tell WHICH extension is doing it. For the ACTIVE
// file this command reports, read-only:
//   1. editor.defaultFormatter for its language, and which scope set it;
//   2. whether that formatter's extension is installed and enabled, and whether it
//      is Tidy;
//   3. editor.formatOnSave, editor.formatOnSaveMode and editor.codeActionsOnSave,
//      each with its scope, plus the save-time edits VS Code itself makes;
//   4. whether the incumbent JS-CSS-HTML Formatter is present, and whether its
//      config file exists (a DISABLED incumbent is invisible to the extension API,
//      probe P4, so the file is the only trace it leaves);
//   5. the other formatters the workspace is configured for;
//   6. what NO API can show: an extension formatting on save through its OWN save
//      hook. The report says so in every run, and never claims to know it.
//
// ANTI-HIJACK (ARCH-01/02, SPEC §5/§10/§12) : NON-NEGOTIABLE: a command that
// explains must never change anything. This module writes no setting, writes no
// file, opens no network connection, hooks no event and sends nothing. Every call
// it makes is a read (`inspect`, `get`, `getExtension`, `fs.stat`, a directory
// listing) and its only output is text for the local "Tidy Formatter" output
// channel plus a toast whose buttons merely OPEN the Settings UI or the Extensions
// view. The button executor refuses any command id outside OPEN_ONLY_COMMAND_IDS.
// test/unit/commands/whoFormatsReadOnly.test.ts fails if any of this changes.
//
// HONESTY about scopes: a scope is named only when its value equals the effective
// value `get()` returns; otherwise the report says it could not tell (see
// whoFormatsScopes.ts for the model and for what a real host was observed to do).
//
// Split of concerns (mirrors commands/showConfig.ts), in three modules:
//   whoFormatsScopes.ts  PURE: which scope set a value.
//   whoFormatsReport.ts  PURE: the facts in, the report text, headline and buttons out.
//   whoFormats.ts       (this file) the host: gathers the facts with READS only, runs
//                       the command. `vscode` is a parameter of the gatherer (the idiom
//                       of setDefaultFormatter.ts) and the handler loads it lazily, so
//                       this module can be imported without a host.
import { isLonefyPresentIn } from '../migration/detectLonefy';
import { LONEFY_LOCAL_CONFIG_SEGMENTS } from '../migration/lonefySources';
import { scanCompetingFormatters } from '../deference/detect';
import { sanitizeDetail } from '../diagnostics/lastFormat';
import {
  buildWhoFormatsReport,
  clampId,
  OPEN_ONLY_COMMAND_IDS,
  SAVE_TIME_EDIT_KEYS,
  type CompetingScan,
  type ConfigFileState,
  type FormatterExtension,
  type WhoFormatsAction,
  type WhoFormatsFacts,
  type WorkspaceKind
} from './whoFormatsReport';
import {
  foldFolderIntoWorkspace,
  isAbsent,
  narrowLayers,
  renderValue,
  type SettingLayers,
  type SettingProbe
} from './whoFormatsScopes';

export const WHO_FORMATS_COMMAND_ID = 'tidy.whoFormats';

/** Marketplace id of Tidy (publisher.name). Pinned to the manifest by a unit test. */
export const TIDY_EXTENSION_ID = 'ced-lab.tidy-formatter';

/* -------------------------------------------------------------------------- */
/* Host: gather the facts (vscode is a parameter; every call is a READ)         */
/* -------------------------------------------------------------------------- */
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */

function causeOf(error: unknown): string {
  return error instanceof Error ? sanitizeDetail(error.message) : 'unknown error';
}

/**
 * Read one setting for this file's language. `get` gives the effective value and
 * `inspect` the per-scope ones; they fail independently, so a missing or throwing
 * `inspect` (feature detection) only costs the scope, never the value. In a
 * single-folder workspace the Workspace Folder fields mirror the Workspace ones (the
 * same file), so they are folded together.
 */
function probeSetting(
  vscode: any,
  section: string,
  key: string,
  scope: unknown,
  workspaceKind: WorkspaceKind
): SettingProbe {
  try {
    const config = vscode.workspace.getConfiguration(section, scope);
    const effective: unknown = config.get(key);
    let layers: SettingLayers | undefined;
    try {
      const narrowed = typeof config.inspect === 'function' ? narrowLayers(config.inspect(key)) : undefined;
      layers = narrowed !== undefined && workspaceKind === 'folder' ? foldFolderIntoWorkspace(narrowed) : narrowed;
    } catch {
      layers = undefined; // no per-scope details: the report says the scope is unknown.
    }
    return { state: 'read', effective, layers };
  } catch (error: unknown) {
    return { state: 'unreadable', cause: causeOf(error) };
  }
}

/** The extension named by editor.defaultFormatter, as far as the API can tell. */
function probeFormatterExtension(vscode: any, effective: unknown): FormatterExtension {
  if (isAbsent(effective)) {
    return { state: 'none' };
  }
  if (typeof effective !== 'string') {
    return { state: 'invalid-id', rendered: renderValue(effective) };
  }
  const id = effective.trim();
  const isTidy = id.toLowerCase() === TIDY_EXTENSION_ID;
  try {
    const extension = vscode.extensions.getExtension(id);
    if (!extension) {
      return { state: 'not-visible', id, isTidy };
    }
    const name: unknown = extension.packageJSON?.displayName;
    // A "%placeholder%" is a manifest string VS Code has not localised: not a name.
    const displayName =
      typeof name === 'string' && name.length > 0 && !name.startsWith('%') ? clampId(name) : undefined;
    return { state: 'found', id, isTidy, displayName };
  } catch (error: unknown) {
    return { state: 'unknown', id, cause: causeOf(error) };
  }
}

/** Does the incumbent's local config file exist? `stat` only: nothing is opened or read. */
async function probeIncumbentConfig(
  vscode: any,
  folders: readonly any[],
  trusted: boolean
): Promise<ConfigFileState> {
  if (!trusted) {
    return { state: 'not-checked', reason: 'restricted' };
  }
  if (folders.length === 0) {
    return { state: 'not-checked', reason: 'no-folder' };
  }
  try {
    // The incumbent reads this file from the FIRST folder only, so that is the one checked.
    const uri = vscode.Uri.joinPath(folders[0].uri, ...LONEFY_LOCAL_CONFIG_SEGMENTS);
    const stat = await vscode.workspace.fs.stat(uri);
    return (stat.type & vscode.FileType.Directory) !== 0 ? { state: 'not-a-file' } : { state: 'found' };
  } catch {
    return { state: 'absent' };
  }
}

/**
 * One folder and no .code-workspace file is a single-folder workspace, whose
 * `.vscode/settings.json` is the Workspace scope. A .code-workspace file (or several
 * folders) is a multi-root workspace, where the workspace file and each folder's
 * `.vscode/settings.json` are different scopes.
 */
function workspaceKindOf(vscode: any, folders: readonly any[]): WorkspaceKind {
  if (folders.length === 0) {
    return 'none';
  }
  const workspaceFile: unknown = vscode.workspace.workspaceFile;
  const hasWorkspaceFile = workspaceFile !== undefined && workspaceFile !== null;
  return folders.length === 1 && !hasWorkspaceFile ? 'folder' : 'multi-root';
}

function baseName(uriPath: string): string {
  const index = uriPath.lastIndexOf('/');
  return index >= 0 ? uriPath.slice(index + 1) : uriPath;
}

/**
 * Gather every fact the report needs for one document. Read-only by construction.
 * Reuses the two shared detectors instead of re-implementing them:
 * `isLonefyPresentIn` (the incumbent, installed and enabled) and
 * `scanCompetingFormatters` (the UNCONDITIONAL scan "Show Effective Configuration"
 * uses, which does not defer to tidy.deferToOtherFormatters).
 */
export async function collectWhoFormatsFacts(vscode: any, document: any): Promise<WhoFormatsFacts> {
  const languageId: string = document.languageId;
  const scope = { uri: document.uri, languageId };
  const folders: readonly any[] = Array.isArray(vscode.workspace.workspaceFolders)
    ? vscode.workspace.workspaceFolders
    : [];
  const trusted = vscode.workspace.isTrusted !== false;

  const kind = workspaceKindOf(vscode, folders);
  const defaultFormatter = probeSetting(vscode, 'editor', 'defaultFormatter', scope, kind);
  const competing: CompetingScan = !trusted
    ? { state: 'not-scanned', reason: 'restricted' }
    : folders.length === 0
      ? { state: 'not-scanned', reason: 'no-folder' }
      : { state: 'scanned', names: await scanCompetingFormatters() };

  return {
    fileName: baseName(String(document.uri.path ?? document.fileName ?? '')),
    languageId,
    workspaceKind: kind,
    defaultFormatter,
    formatterExtension: probeFormatterExtension(
      vscode,
      defaultFormatter.state === 'read' ? defaultFormatter.effective : undefined
    ),
    formatOnSave: probeSetting(vscode, 'editor', 'formatOnSave', scope, kind),
    formatOnSaveMode: probeSetting(vscode, 'editor', 'formatOnSaveMode', scope, kind),
    codeActionsOnSave: probeSetting(vscode, 'editor', 'codeActionsOnSave', scope, kind),
    saveTimeEdits: SAVE_TIME_EDIT_KEYS.map((key) => ({
      key,
      probe: probeSetting(vscode, 'files', key, scope, kind)
    })),
    incumbentVisible: isLonefyPresentIn(vscode),
    incumbentConfig: await probeIncumbentConfig(vscode, folders, trusted),
    competing
  };
}

/**
 * Run one button. The single seam between the pure action data and VS Code, and the
 * last line of the read-only guarantee: a command id outside OPEN_ONLY_COMMAND_IDS is
 * refused, so this feature can never be made to run anything that writes.
 */
async function runAction(vscode: any, action: WhoFormatsAction): Promise<void> {
  if (!OPEN_ONLY_COMMAND_IDS.includes(action.commandId)) {
    return;
  }
  try {
    await vscode.commands.executeCommand(action.commandId, ...action.args);
  } catch (error: unknown) {
    void vscode.window.showWarningMessage(
      `Tidy: could not run "${action.label}" (${causeOf(error)}).`
    );
  }
}

/**
 * Handler for "Tidy: Who Formats This File?". Appends the report to the shared
 * "Tidy Formatter" output channel (never clears it: it also holds the format trace),
 * reveals it without taking focus, and shows the one-sentence answer as a
 * non-blocking toast whose buttons open Settings or the Extensions view. Never
 * throws: a failure becomes one sanitised warning.
 */
export async function whoFormats(): Promise<void> {
  const vscode = require('vscode');
  const { getTidyOutputChannel } = require('../diagnostics/outputChannel');

  try {
    const document = vscode.window.activeTextEditor?.document;
    if (!document) {
      void vscode.window.showInformationMessage('Tidy: open a file to see who formats it.');
      return;
    }
    if (document.uri.scheme === 'output') {
      void vscode.window.showInformationMessage(
        'Tidy: the active editor is an Output panel. Click inside the file you want to check, then run this command again.'
      );
      return;
    }

    const report = buildWhoFormatsReport(await collectWhoFormatsFacts(vscode, document));

    const channel = getTidyOutputChannel();
    channel.appendLine('');
    for (const line of report.lines) {
      channel.appendLine(line);
    }
    channel.show(true);

    // Fire-and-forget (idiom of explainLastFormat): the command resolves at once, so a
    // headless host never hangs on an unclicked toast. A click opens; dismissal does nothing.
    void vscode.window
      .showInformationMessage(report.headline, ...report.actions.map((action) => action.label))
      .then((picked: string | undefined) => {
        const action = report.actions.find((candidate) => candidate.label === picked);
        if (action) {
          void runAction(vscode, action);
        }
      });
  } catch (error: unknown) {
    void vscode.window.showWarningMessage(
      `Tidy: could not work out who formats this file (${causeOf(error)}).`
    );
  }
}
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */
