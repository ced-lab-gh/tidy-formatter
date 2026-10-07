// Headless integration test of "Tidy: Who Formats This File?" in a REAL VS Code host.
// The unit suites drive the command through a faithful stand-in for `vscode`; this is
// the proof against the real thing, for the parts the stand-in can only imitate:
//   - the real `inspect()` per-scope fields (probe P15) for a language-specific value
//     written at Workspace scope, and the real precedence between a plain and a
//     `[css]` value;
//   - the real `getExtension` for an installed and enabled extension (Tidy itself)
//     and for one that is not there;
//   - the real `workspace.fs.stat` of `.vscode/formatter.json` and the real
//     directory scan of the workspace root;
//   - the command registered by the packaged extension, its toast, and the promise
//     that running it changes NOTHING.
//
// Method: the facts and the report are built by the SAME functions the command
// uses, called here with the real `vscode` module (this file runs inside the host),
// so the report text can be asserted. The command itself is then run for real with
// the two notification functions replaced by recorders (the method of the audit
// probes and of migration.test.ts): every answer is explicit, and a button is
// "clicked" only by returning its label.
//
// Every Workspace-scoped key and file this suite creates is removed in afterEach.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  activateExtension,
  EXTENSION_ID,
  flushEventLoop,
  openFixture,
  removeFixtureDir,
  waitUntil,
  workspaceRoot
} from './helpers';
import { collectWhoFormatsFacts } from '../../src/commands/whoFormats';
import { buildWhoFormatsReport, type WhoFormatsFacts } from '../../src/commands/whoFormatsReport';
import { resolveScalarSource } from '../../src/commands/whoFormatsScopes';

const FIXTURE_DIR = 'who-formats';
const FIXTURE = `${FIXTURE_DIR}/app.css`;
const INCUMBENT_ID = 'lonefy.vscode-JS-CSS-HTML-formatter';
const PRETTIER_ID = 'esbenp.prettier-vscode';
const EDITOR_KEYS = ['defaultFormatter', 'formatOnSave', 'formatOnSaveMode', 'codeActionsOnSave'] as const;

interface Shown {
  readonly kind: 'info' | 'warning';
  readonly message: string;
  readonly buttons: readonly string[];
}

/** Write a Workspace value (plain, or in a language block) and wait until the host has seen it. */
async function setWorkspace(key: string, value: unknown, languageId?: string): Promise<void> {
  const changed = new Promise<void>((resolve) => {
    const sub = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(`editor.${key}`)) {
        sub.dispose();
        resolve();
      }
    });
    setTimeout(() => {
      sub.dispose();
      resolve();
    }, 2000);
  });
  await vscode.workspace
    .getConfiguration('editor', languageId === undefined ? undefined : { languageId })
    .update(key, value, vscode.ConfigurationTarget.Workspace, languageId !== undefined);
  await changed;
}

describe('Tidy: Who Formats This File? : in a real host', function () {
  this.timeout(process.env.CI ? 180000 : 30000);

  const settingsPath = (): string => path.join(workspaceRoot(), '.vscode', 'settings.json');
  const incumbentConfigPath = (): string => path.join(workspaceRoot(), '.vscode', 'formatter.json');
  const biomePath = (): string => path.join(workspaceRoot(), 'biome.json');

  let document: vscode.TextDocument;
  let shown: Shown[] = [];
  let restoreDialogs: (() => void) | undefined;
  let restoreCommands: (() => void) | undefined;
  // The REAL executeCommand, kept before any test replaces it with a recorder.
  const realExecuteCommand = vscode.commands.executeCommand.bind(vscode.commands);

  /** Replace the two notification functions with recorders that answer with `pick`. */
  function scriptDialogs(pick?: (buttons: readonly string[]) => string | undefined): void {
    const windowApi = vscode.window as unknown as Record<string, unknown>;
    const originalInfo = windowApi.showInformationMessage;
    const originalWarning = windowApi.showWarningMessage;
    const record =
      (kind: Shown['kind']) =>
      (message: string, ...buttons: string[]): Promise<string | undefined> => {
        shown.push({ kind, message, buttons });
        return Promise.resolve(pick?.(buttons));
      };
    windowApi.showInformationMessage = record('info');
    windowApi.showWarningMessage = record('warning');
    restoreDialogs = () => {
      windowApi.showInformationMessage = originalInfo;
      windowApi.showWarningMessage = originalWarning;
    };
  }

  /** Record every command the extension runs, and run none of them (a click must stay hermetic). */
  function recordCommands(): Array<{ command: string; args: unknown[] }> {
    const commandsApi = vscode.commands as unknown as Record<string, unknown>;
    const original = commandsApi.executeCommand;
    const calls: Array<{ command: string; args: unknown[] }> = [];
    commandsApi.executeCommand = (command: string, ...args: unknown[]) => {
      calls.push({ command, args });
      return Promise.resolve(undefined);
    };
    restoreCommands = () => {
      commandsApi.executeCommand = original;
    };
    return calls;
  }

  async function factsForActiveFile(): Promise<WhoFormatsFacts> {
    return collectWhoFormatsFacts(vscode, document);
  }

  async function reportText(): Promise<string> {
    return buildWhoFormatsReport(await factsForActiveFile()).lines.join('\n');
  }

  /** Run the command through the REAL executeCommand; it resolves once the toast has been shown. */
  async function runCommand(): Promise<void> {
    await realExecuteCommand('tidy.whoFormats');
    await waitUntil(() => shown.length > 0, 5000);
  }

  before(async () => {
    await activateExtension();
    assert.equal(
      vscode.extensions.getExtension(INCUMBENT_ID),
      undefined,
      'precondition: the incumbent is not installed and enabled in the hermetic host'
    );
    assert.equal(fs.existsSync(incumbentConfigPath()), false, 'precondition: no .vscode/formatter.json');
    assert.equal(fs.existsSync(biomePath()), false, 'precondition: no biome.json at the workspace root');
  });

  beforeEach(async () => {
    shown = [];
    document = await openFixture(FIXTURE, 'a{color:red}\n', 'css');
    await vscode.window.showTextDocument(document);
    await flushEventLoop();
  });

  afterEach(async () => {
    restoreDialogs?.();
    restoreDialogs = undefined;
    restoreCommands?.();
    restoreCommands = undefined;
    for (const key of EDITOR_KEYS) {
      await vscode.workspace.getConfiguration('editor').update(key, undefined, vscode.ConfigurationTarget.Workspace);
      await vscode.workspace
        .getConfiguration('editor', { languageId: 'css' })
        .update(key, undefined, vscode.ConfigurationTarget.Workspace, true);
    }
    fs.rmSync(incumbentConfigPath(), { force: true });
    fs.rmSync(biomePath(), { force: true });
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await flushEventLoop();
  });

  after(() => {
    removeFixtureDir(FIXTURE_DIR);
  });

  it('is registered by the packaged extension, next to the commands it is a sibling of', async () => {
    const all = await vscode.commands.getCommands(true);
    assert.ok(all.includes('tidy.whoFormats'), 'tidy.whoFormats must be registered at activation');
    // The two built-in commands its buttons run must exist in this host, or a click would fail.
    assert.ok(all.includes('workbench.action.openSettings'));
    assert.ok(all.includes('workbench.extensions.search'));
  });

  describe('spec 1 and 2: the default formatter, its scope, and its extension (real inspect and getExtension)', () => {
    it('a [css] value written at Workspace scope is attributed to the Workspace [css] block', async () => {
      await setWorkspace('defaultFormatter', EXTENSION_ID, 'css');

      const facts = await factsForActiveFile();
      assert.equal(facts.languageId, 'css');
      assert.equal(facts.fileName, 'app.css');
      assert.equal(facts.defaultFormatter.state, 'read');
      if (facts.defaultFormatter.state === 'read') {
        assert.equal(facts.defaultFormatter.effective, EXTENSION_ID);
        assert.equal(facts.defaultFormatter.layers?.workspaceLanguageValue, EXTENSION_ID);
        const source = resolveScalarSource(facts.defaultFormatter.effective, facts.defaultFormatter.layers, 'css');
        assert.equal(source.kind === 'layer' && source.winner.label, 'Workspace settings ([css] block)');
      }
      // Tidy is installed and enabled in this host, and is recognised as Tidy.
      assert.equal(facts.formatterExtension.state, 'found');
      assert.equal(facts.formatterExtension.state === 'found' && facts.formatterExtension.isTidy, true);

      const text = await reportText();
      assert.match(text, /editor\.defaultFormatter = "ced-lab\.tidy-formatter"/);
      assert.ok(text.includes('set by: Workspace settings ([css] block)'));
      assert.match(text, /is installed and enabled\. That is Tidy\./);
    });

    it('a [css] block wins over a plain Workspace value, as VS Code resolves it, and the loser is listed', async () => {
      await setWorkspace('defaultFormatter', PRETTIER_ID);
      await setWorkspace('defaultFormatter', EXTENSION_ID, 'css');

      const text = await reportText();
      assert.match(text, /editor\.defaultFormatter = "ced-lab\.tidy-formatter"/);
      assert.ok(text.includes('set by: Workspace settings ([css] block)'));
      assert.ok(text.includes('also set: Workspace settings = "esbenp.prettier-vscode" (not in effect)'), text);
    });

    it('a plain Workspace value alone is attributed to Workspace settings, and its extension is not visible here', async () => {
      await setWorkspace('defaultFormatter', PRETTIER_ID);

      const facts = await factsForActiveFile();
      assert.deepEqual(facts.formatterExtension, { state: 'not-visible', id: PRETTIER_ID, isTidy: false });
      const text = await reportText();
      assert.ok(text.includes('set by: Workspace settings\n'), text);
      assert.match(text, /esbenp\.prettier-vscode is not visible to VS Code's extension API/);
    });

    it('nothing set: no default formatter, no scope', async () => {
      const text = await reportText();
      assert.match(text, /editor\.defaultFormatter = null \(no default formatter\)/);
      assert.match(text, /set by: no scope sets it/);
    });
  });

  describe('spec 3: format on save, its mode and the code actions (real inspect)', () => {
    it('reads all three with their scopes', async () => {
      await setWorkspace('formatOnSave', true);
      await setWorkspace('formatOnSaveMode', 'modifications', 'css');
      await setWorkspace('codeActionsOnSave', { 'source.fixAll': 'explicit' });

      const text = await reportText();
      assert.ok(text.includes('editor.formatOnSave = true\n     set by: Workspace settings\n'), text);
      assert.ok(text.includes('editor.formatOnSaveMode = "modifications"'), text);
      assert.ok(text.includes('set by: Workspace settings ([css] block)'), text);
      assert.ok(text.includes('source.fixAll = "explicit" (set by: Workspace settings)'), text);
      assert.match(text, /format on save is ON for this file/);
    });

    it('a [css] override of format on save wins, and the plain value is listed as not in effect', async () => {
      await setWorkspace('formatOnSave', true);
      await setWorkspace('formatOnSave', false, 'css');

      const text = await reportText();
      assert.ok(text.includes('editor.formatOnSave = false\n     set by: Workspace settings ([css] block)'), text);
      assert.ok(text.includes('also set: Workspace settings = true (not in effect)'), text);
      assert.match(text, /format on save is OFF for this file/);
    });
  });

  describe('spec 4 and 5: the incumbent and the other formatters (real fs.stat and directory scan)', () => {
    it('no extension and no config file: nothing points to the incumbent', async () => {
      const facts = await factsForActiveFile();
      assert.equal(facts.incumbentVisible, false);
      assert.deepEqual(facts.incumbentConfig, { state: 'absent' });
    });

    it('DISABLED or absent (invisible to the API) but .vscode/formatter.json present: the file is the trace', async () => {
      fs.mkdirSync(path.dirname(incumbentConfigPath()), { recursive: true });
      fs.writeFileSync(incumbentConfigPath(), '{"onSave":true}', 'utf8');

      const facts = await factsForActiveFile();
      assert.equal(facts.incumbentVisible, false);
      assert.deepEqual(facts.incumbentConfig, { state: 'found' });
      const text = await reportText();
      assert.ok(text.includes('formatter.json in the first workspace folder: found.'), text);
      assert.match(text, /If it is installed but disabled, it formats nothing\./);
    });

    it('reuses the workspace scan: a biome.json at the root is reported as Biome', async () => {
      fs.writeFileSync(biomePath(), '{}', 'utf8');
      const facts = await factsForActiveFile();
      assert.deepEqual(facts.competing, { state: 'scanned', names: ['Biome'] });
    });

    it('one folder is open: its settings file is the Workspace scope, and the report says so', async () => {
      const facts = await factsForActiveFile();
      assert.equal(facts.workspaceKind, 'folder');
      assert.ok((await reportText()).includes('Workspace: one folder is open. Its .vscode/settings.json is the "Workspace settings" scope.'));
    });
  });

  describe('the command itself', () => {
    it('answers in one toast: default formatter, its scope, format on save, and buttons that only open', async () => {
      await setWorkspace('defaultFormatter', EXTENSION_ID, 'css');
      await setWorkspace('formatOnSave', false);
      scriptDialogs();

      await runCommand();

      assert.equal(shown.length, 1, JSON.stringify(shown));
      assert.equal(shown[0].kind, 'info');
      assert.ok(
        shown[0].message.startsWith(
          'Who formats app.css? Default formatter: ced-lab.tidy-formatter, set by Workspace settings ([css] block). Format on save: off.'
        ),
        shown[0].message
      );
      assert.deepEqual(shown[0].buttons, ['Open Default Formatter Setting', 'Open Format on Save Settings']);
    });

    it('offers the installed-extensions search for the incumbent when its config file is present', async () => {
      fs.mkdirSync(path.dirname(incumbentConfigPath()), { recursive: true });
      fs.writeFileSync(incumbentConfigPath(), '{}', 'utf8');
      scriptDialogs();

      await runCommand();

      assert.ok(shown[0].buttons.includes('Find JS-CSS-HTML Formatter'), JSON.stringify(shown[0].buttons));
    });

    it('with no active editor it asks for a file, and reports nothing', async () => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await flushEventLoop();
      scriptDialogs();

      await runCommand();

      assert.deepEqual(
        shown.map((s) => s.message),
        ['Tidy: open a file to see who formats it.']
      );
    });

    it('CHANGES NOTHING: no setting, no file, before and after', async () => {
      await setWorkspace('defaultFormatter', EXTENSION_ID, 'css');
      await setWorkspace('formatOnSave', true);
      fs.mkdirSync(path.dirname(incumbentConfigPath()), { recursive: true });
      fs.writeFileSync(incumbentConfigPath(), '{"onSave":true}', 'utf8');
      const fixturePath = path.join(workspaceRoot(), FIXTURE);
      const snapshot = (): string =>
        JSON.stringify({
          settings: fs.readFileSync(settingsPath(), 'utf8'),
          incumbent: fs.readFileSync(incumbentConfigPath(), 'utf8'),
          fixture: fs.readFileSync(fixturePath, 'utf8'),
          fixtureDir: fs.readdirSync(path.dirname(fixturePath)).sort(),
          rootDir: fs.readdirSync(workspaceRoot()).sort(),
          vscodeDir: fs.readdirSync(path.join(workspaceRoot(), '.vscode')).sort(),
          editorKeys: EDITOR_KEYS.map((key) => {
            const info = vscode.workspace.getConfiguration('editor', { uri: document.uri, languageId: 'css' }).inspect(key);
            return [key, info?.globalValue, info?.workspaceValue, info?.workspaceLanguageValue, info?.globalLanguageValue];
          })
        });
      const before = snapshot();
      scriptDialogs();
      const calls = recordCommands();

      await runCommand();

      assert.equal(snapshot(), before, 'the command must leave every setting and file as it found it');
      assert.equal(document.isDirty, false, 'and the document untouched');
      assert.deepEqual(calls, [], 'and it runs no command of its own until a button is clicked');
    });

    it('a click runs only a built-in open command, with a plain-string argument', async () => {
      fs.mkdirSync(path.dirname(incumbentConfigPath()), { recursive: true });
      fs.writeFileSync(incumbentConfigPath(), '{}', 'utf8');
      const labels = ['Open Default Formatter Setting', 'Open Format on Save Settings', 'Find JS-CSS-HTML Formatter'];
      const expected: Record<string, [string, string]> = {
        'Open Default Formatter Setting': ['workbench.action.openSettings', '@lang:css editor.defaultFormatter'],
        'Open Format on Save Settings': ['workbench.action.openSettings', '@lang:css editor.formatOnSave'],
        'Find JS-CSS-HTML Formatter': ['workbench.extensions.search', '@installed JS-CSS-HTML Formatter']
      };
      for (const label of labels) {
        shown = [];
        scriptDialogs((buttons) => buttons.find((b) => b === label));
        const calls = recordCommands();

        await runCommand();
        await waitUntil(() => calls.length > 0, 5000);

        assert.deepEqual(calls, [{ command: expected[label][0], args: [expected[label][1]] }], label);
        assert.ok(!shown.some((s) => s.kind === 'warning'), `${label} raised a warning`);
        restoreDialogs?.();
        restoreCommands?.();
      }
    });
  });
});
