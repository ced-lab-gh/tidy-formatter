// Host-level proof for tidy.deferToOtherFormatters (LOW-18) and for what "Show
// Effective Configuration" tells the user about a fail-closed .soukformatignore.
//
// LOW-18. With tidy.deferToOtherFormatters = "silent-defer", activation used to
// list the workspace root and read package.json (2 reads per folder) and then
// throw the answer away: decide() returns 'defer', the host acts on nothing but
// 'notify', and 'defer' is read nowhere else (probe P14, 30/09/2026). "off" already
// did 0 reads. These tests run the REAL extension.ts activate() against a
// faithful, recording 'vscode' stub and pin, for every setting:
//   - how many workspace reads activation performs;
//   - that nothing observable changed: notifications shown, settings written,
//     globalState written;
//   - that the report Show Effective Configuration writes still lists the
//     competing formatters whatever the setting (a user-invoked read, kept).
//
// This is one of the few unit tests that load a vscode-bound module. The stub is
// installed in before() and removed, together with every module it pulled in, in
// after(), so nothing leaks into the rest of the suite (mocha has already loaded
// every spec file when before() runs).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import Module from 'node:module';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DEFERENCE_PROMPTED_KEY, DEFERENCE_SETTING_KEY } from '../../../src/deference/decide';

type LoadFn = (request: string, parent: unknown, isMain: boolean) => unknown;

/* -------------------------------------------------------------------------- */
/* A recording 'vscode' stub: faithful for what activation and the report use  */
/* -------------------------------------------------------------------------- */

interface Recorder {
  readDirectory: number;
  readFile: number;
  statOrOtherFs: number;
  fsWrites: number;
  informations: string[];
  configUpdates: unknown[];
  globalStateUpdates: [string, unknown][];
  outputLines: string[];
}

interface Scenario {
  /** Raw value of tidy.deferToOtherFormatters; undefined = never set. */
  readonly setting: string | undefined;
  readonly trusted: boolean;
  readonly alreadyPrompted: boolean;
}

/** What the fake workspace root holds: two competitors, one through package.json. */
const ROOT_ENTRIES: [string, number][] = [
  ['.prettierrc', 1],
  ['biome.json', 1],
  ['package.json', 1],
  ['a.css', 1]
];
const ROOT_PACKAGE_JSON = JSON.stringify({ name: 'demo', prettier: { semi: false } });

let rec: Recorder;
let scenario: Scenario;
let activeEditor: unknown;
/** The workspace folder the stub reports for the active document (undefined: none). */
let documentFolder: string | undefined;

function freshRecorder(): Recorder {
  return {
    readDirectory: 0,
    readFile: 0,
    statOrOtherFs: 0,
    fsWrites: 0,
    informations: [],
    configUpdates: [],
    globalStateUpdates: [],
    outputLines: []
  };
}

function makeUri(fsPath: string): { scheme: string; fsPath: string; path: string; toString(): string } {
  const posix = fsPath.split(path.sep).join('/');
  return { scheme: 'file', fsPath, path: posix, toString: () => `file://${posix}` };
}

class FakeDisposable {
  private readonly onDispose: (() => void) | undefined;
  constructor(onDispose?: () => void) {
    this.onDispose = onDispose;
  }
  dispose(): void {
    this.onDispose?.();
  }
  static from(...items: { dispose(): void }[]): FakeDisposable {
    return new FakeDisposable(() => {
      for (const item of items) {
        item.dispose();
      }
    });
  }
}

const noopEvent = (): FakeDisposable => new FakeDisposable();

function makeConfiguration(section: string | undefined): Record<string, unknown> {
  const fullKey = (key: string): string => (section ? `${section}.${key}` : key);
  return {
    get(key: string, fallback?: unknown): unknown {
      const full = fullKey(key);
      if (full === DEFERENCE_SETTING_KEY) {
        return scenario.setting !== undefined ? scenario.setting : fallback;
      }
      return fallback;
    },
    has: () => false,
    inspect: () => undefined,
    async update(...args: unknown[]): Promise<void> {
      rec.configUpdates.push(args);
    }
  };
}

const namespace: Record<string, unknown> = {
  version: '1.84.0',
  Disposable: FakeDisposable,
  Position: class {},
  Range: class {},
  Selection: class {},
  MarkdownString: class {
    value = '';
  },
  ThemeColor: class {},
  TextEdit: { replace: (range: unknown, newText: string) => ({ range, newText }) },
  EndOfLine: { LF: 1, CRLF: 2 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  ViewColumn: { Active: -1, Beside: -2, One: 1 },
  Uri: {
    file: (p: string) => makeUri(p),
    parse: (p: string) => makeUri(p),
    joinPath: (base: { fsPath: string }, ...parts: string[]) =>
      makeUri(path.join(base.fsPath, ...parts))
  },
  languages: {
    registerDocumentFormattingEditProvider: () => new FakeDisposable(),
    registerDocumentRangeFormattingEditProvider: () => new FakeDisposable(),
    getDiagnostics: () => []
  },
  commands: {
    registerCommand: () => new FakeDisposable(),
    registerTextEditorCommand: () => new FakeDisposable(),
    executeCommand: () => Promise.resolve(undefined)
  },
  window: {
    get activeTextEditor(): unknown {
      return activeEditor;
    },
    visibleTextEditors: [],
    createOutputChannel(name: string) {
      return {
        name,
        appendLine: (line: string) => rec.outputLines.push(line),
        append: (text: string) => rec.outputLines.push(text),
        clear: () => {
          rec.outputLines.length = 0;
        },
        show: () => undefined,
        hide: () => undefined,
        dispose: () => undefined
      };
    },
    createStatusBarItem: () => ({
      text: '',
      tooltip: undefined,
      command: undefined,
      backgroundColor: undefined,
      show: () => undefined,
      hide: () => undefined,
      dispose: () => undefined
    }),
    showInformationMessage(message: string): Promise<undefined> {
      rec.informations.push(String(message));
      return Promise.resolve(undefined);
    },
    showWarningMessage: () => Promise.resolve(undefined),
    showErrorMessage: () => Promise.resolve(undefined),
    onDidChangeActiveTextEditor: noopEvent,
    onDidChangeTextEditorSelection: noopEvent,
    onDidChangeVisibleTextEditors: noopEvent
  },
  workspace: {
    get isTrusted(): boolean {
      return scenario.trusted;
    },
    get workspaceFolders(): unknown {
      return [{ uri: makeUri(path.join(path.sep, 'ws')), name: 'ws', index: 0 }];
    },
    getConfiguration: (section?: string) => makeConfiguration(section),
    getWorkspaceFolder: () =>
      documentFolder === undefined ? undefined : { uri: makeUri(documentFolder), name: 'ws', index: 0 },
    asRelativePath: (value: unknown) => String(value),
    onDidChangeConfiguration: noopEvent,
    onDidGrantWorkspaceTrust: noopEvent,
    onDidChangeWorkspaceFolders: noopEvent,
    fs: {
      readDirectory(): Promise<[string, number][]> {
        rec.readDirectory += 1;
        return Promise.resolve(ROOT_ENTRIES);
      },
      readFile(uri: { fsPath: string }): Promise<Uint8Array> {
        rec.readFile += 1;
        return path.basename(uri.fsPath) === 'package.json'
          ? Promise.resolve(Buffer.from(ROOT_PACKAGE_JSON, 'utf8'))
          : Promise.reject(new Error('ENOENT'));
      },
      stat(): Promise<never> {
        rec.statOrOtherFs += 1;
        return Promise.reject(new Error('ENOENT'));
      },
      writeFile(): Promise<void> {
        rec.fsWrites += 1;
        return Promise.resolve();
      },
      delete(): Promise<void> {
        rec.fsWrites += 1;
        return Promise.resolve();
      },
      createDirectory(): Promise<void> {
        rec.fsWrites += 1;
        return Promise.resolve();
      }
    }
  },
  extensions: { all: [], getExtension: () => undefined },
  env: {
    appName: 'Tidy unit stub',
    language: 'en',
    uriScheme: 'vscode',
    openExternal: () => Promise.resolve(true)
  }
};

interface FakeContext {
  subscriptions: { dispose(): unknown }[];
  globalState: {
    get<T>(key: string, fallback?: T): T | undefined;
    update(key: string, value: unknown): Promise<void>;
  };
}

function makeContext(): FakeContext {
  const store = new Map<string, unknown>();
  if (scenario.alreadyPrompted) {
    store.set(DEFERENCE_PROMPTED_KEY, true);
  }
  return {
    subscriptions: [],
    globalState: {
      get<T>(key: string, fallback?: T): T | undefined {
        return store.has(key) ? (store.get(key) as T) : fallback;
      },
      update(key: string, value: unknown): Promise<void> {
        rec.globalStateUpdates.push([key, value]);
        store.set(key, value);
        return Promise.resolve();
      }
    }
  };
}

/** Let the fire-and-forget activation tasks (all promise-resolved) finish. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

interface ExtensionModule {
  activate(context: FakeContext): void;
}
interface ShowConfigModule {
  showEffectiveConfiguration(): Promise<void>;
}

describe('deference + Show Effective Configuration in a recording host (LOW-18)', () => {
  const loader = Module as unknown as { _load: LoadFn };
  let originalLoad: LoadFn;
  let cachedBefore: Set<string>;
  let extension: ExtensionModule;
  let showConfig: ShowConfigModule;

  before(() => {
    originalLoad = loader._load;
    cachedBefore = new Set(Object.keys(require.cache));
    loader._load = function patchedLoad(
      this: unknown,
      request: string,
      parent: unknown,
      isMain: boolean
    ): unknown {
      if (request === 'vscode') {
        return namespace;
      }
      return originalLoad.call(this, request, parent, isMain);
    };
    extension = require('../../../src/extension') as ExtensionModule;
    showConfig = require('../../../src/commands/showConfig') as ShowConfigModule;
  });

  after(() => {
    loader._load = originalLoad;
    for (const key of Object.keys(require.cache)) {
      if (!cachedBefore.has(key)) {
        delete require.cache[key];
      }
    }
  });

  /** Run the real activate() for a scenario and report what it did. */
  async function activateWith(next: Partial<Scenario>): Promise<Recorder> {
    scenario = { setting: undefined, trusted: true, alreadyPrompted: false, ...next };
    rec = freshRecorder();
    activeEditor = undefined;
    documentFolder = undefined;
    const context = makeContext();
    extension.activate(context);
    await settle();
    // Disposing cancels the idle-preload timer, so nothing outlives the test.
    for (const subscription of context.subscriptions) {
      subscription.dispose();
    }
    return rec;
  }

  describe('activation reads', () => {
    it('silent-defer: no workspace read at all (was 2: readDirectory + readFile)', async () => {
      const r = await activateWith({ setting: 'silent-defer' });
      assert.equal(r.readDirectory, 0, 'no directory listing');
      assert.equal(r.readFile, 0, 'no package.json read');
    });

    it('silent-defer keeps every observable behaviour: no toast, no setting, no globalState, no write', async () => {
      const r = await activateWith({ setting: 'silent-defer' });
      assert.deepEqual(r.informations, [], 'no notification');
      assert.deepEqual(r.configUpdates, [], 'no setting written');
      assert.deepEqual(r.globalStateUpdates, [], 'the one-shot flag is untouched');
      assert.equal(r.fsWrites, 0, 'no file written');
    });

    it('silent-defer leaves the one-shot flag alone, so switching to notify later still notifies once', async () => {
      await activateWith({ setting: 'silent-defer' });
      const later = await activateWith({ setting: 'notify' });
      assert.equal(later.informations.length, 1);
      assert.deepEqual(later.globalStateUpdates, [[DEFERENCE_PROMPTED_KEY, true]]);
    });

    it('off: still 0 reads and nothing observable', async () => {
      const r = await activateWith({ setting: 'off' });
      assert.equal(r.readDirectory, 0);
      assert.equal(r.readFile, 0);
      assert.deepEqual(r.informations, []);
      assert.deepEqual(r.globalStateUpdates, []);
    });

    it('notify (the default): unchanged, 2 reads and ONE notification naming the competitors', async () => {
      const r = await activateWith({ setting: 'notify' });
      assert.equal(r.readDirectory, 1);
      assert.equal(r.readFile, 1);
      assert.equal(r.informations.length, 1);
      assert.match(r.informations[0], /already configures Prettier and Biome/);
      assert.match(r.informations[0], /your default formatter is unchanged/);
      assert.deepEqual(r.globalStateUpdates, [[DEFERENCE_PROMPTED_KEY, true]]);
      assert.deepEqual(r.configUpdates, [], 'the notification never writes a setting');
    });

    it('an unset setting behaves as notify', async () => {
      const r = await activateWith({ setting: undefined });
      assert.equal(r.readDirectory, 1);
      assert.equal(r.readFile, 1);
      assert.equal(r.informations.length, 1);
    });

    it('an unknown value behaves as notify', async () => {
      const r = await activateWith({ setting: 'sometimes' });
      assert.equal(r.readDirectory, 1);
      assert.equal(r.informations.length, 1);
    });

    it('notify after the one-shot was shown: 0 reads, no second toast', async () => {
      const r = await activateWith({ setting: 'notify', alreadyPrompted: true });
      assert.equal(r.readDirectory, 0);
      assert.equal(r.readFile, 0);
      assert.deepEqual(r.informations, []);
    });

    it('Restricted Mode: notify reads nothing and shows nothing', async () => {
      const r = await activateWith({ setting: 'notify', trusted: false });
      assert.equal(r.readDirectory, 0);
      assert.equal(r.readFile, 0);
      assert.deepEqual(r.informations, []);
    });
  });

  describe('Show Effective Configuration', () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(path.join(tmpdir(), 'tidy-host-'));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    /**
     * Open a real CSS file on disk as the active editor and return the report.
     * `folder` is the workspace folder the host reports for it (the temp dir by default).
     */
    async function reportFor(
      file: string,
      next: Partial<Scenario>,
      folder: string = dir
    ): Promise<string> {
      scenario = { setting: undefined, trusted: true, alreadyPrompted: false, ...next };
      rec = freshRecorder();
      documentFolder = folder;
      const text = '.a{color:red}\n';
      activeEditor = {
        options: { tabSize: 2, insertSpaces: true },
        document: {
          uri: makeUri(file),
          languageId: 'css',
          getText: () => text
        }
      };
      await showConfig.showEffectiveConfiguration();
      return rec.outputLines.join('\n');
    }

    for (const setting of ['silent-defer', 'off', 'notify']) {
      it(`still lists the competing formatters with the setting at ${setting} (a user-invoked read)`, async () => {
        const file = path.join(dir, 'a.css');
        writeFileSync(file, '.a{color:red}\n');
        const report = await reportFor(file, { setting });
        assert.match(report, /competing formatters : Prettier, Biome/);
        assert.match(report, new RegExp(`deferToOtherFormatters : ${setting}`));
      });
    }

    it('names the line and the reason when a .soukformatignore line cannot be evaluated', async () => {
      writeFileSync(path.join(dir, '.soukformatignore'), '# generated\n*.min.css\nlonely\\\n');
      const file = path.join(dir, 'a.css');
      writeFileSync(file, '.a{color:red}\n');
      const report = await reportFor(file, { setting: 'notify' });
      assert.match(report, /\.soukformatignore excludes this file : yes/);
      assert.match(
        report,
        /\.soukformatignore problem : line 3: pattern "lonely\\" cannot be evaluated \(it ends with a lone backslash\); every file under this ignore file's folder is excluded until the line is fixed or removed\./
      );
    });

    it('names the size limit when the .soukformatignore is too large to read', async () => {
      writeFileSync(path.join(dir, '.soukformatignore'), `${'# filler\n'.repeat(120_000)}`);
      const file = path.join(dir, 'a.css');
      writeFileSync(file, '.a{color:red}\n');
      const report = await reportFor(file, { setting: 'notify' });
      assert.match(report, /\.soukformatignore excludes this file : yes/);
      assert.match(
        report,
        /\.soukformatignore problem : the file is too large to read \(1080000 bytes; the limit is 1048576\); every file under this ignore file's folder is excluded until it is shortened or removed\./
      );
    });

    it('reports an ignore file that lies ABOVE the workspace folder (the walk goes to the root)', async () => {
      const workspace = path.join(dir, 'ws');
      mkdirSync(workspace);
      const above = path.join(dir, '.soukformatignore');
      writeFileSync(above, '*.css\n');
      const file = path.join(workspace, 'a.css');
      writeFileSync(file, '.a{color:red}\n');
      const report = await reportFor(file, { setting: 'notify' }, workspace);
      assert.ok(report.includes(`.soukformatignore : ${above}`), report);
      assert.match(report, /\.soukformatignore excludes this file : yes/);
    });

    it('prints no problem line for an ordinary exclusion rule', async () => {
      writeFileSync(path.join(dir, '.soukformatignore'), '*.css\n');
      const file = path.join(dir, 'a.css');
      writeFileSync(file, '.a{color:red}\n');
      const report = await reportFor(file, { setting: 'notify' });
      assert.match(report, /\.soukformatignore excludes this file : yes/);
      assert.ok(!report.includes('.soukformatignore problem'));
    });

    it('prints no problem line when the file is simply not ignored', async () => {
      mkdirSync(path.join(dir, 'src'));
      writeFileSync(path.join(dir, '.soukformatignore'), 'dist/\n');
      const file = path.join(dir, 'src', 'a.css');
      writeFileSync(file, '.a{color:red}\n');
      const report = await reportFor(file, { setting: 'notify' });
      assert.match(report, /\.soukformatignore excludes this file : no/);
      assert.ok(!report.includes('.soukformatignore problem'));
    });
  });
});
