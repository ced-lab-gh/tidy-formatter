// A faithful, recording stand-in for the parts of the `vscode` API that
// "Tidy: Who Formats This File?" may touch. Not a test file (no `.test.` in the
// name), so mocha's glob skips it.
//
// FAITHFUL means it reproduces what the real host does where the command depends on
// it, as observed by the host probes (_internal/audit-v050/09-sondes-hote.md, P4 and
// P15) and by the real-host integration test of this command, rather than as a guess:
//   - `getConfiguration(section, { uri, languageId }).inspect(key)` returns one field
//     per scope; the four `*LanguageValue` fields exist ONLY when a languageId was given;
//     workspace scopes exist only when a folder is open; the folder scope only for a
//     document inside the first folder. With ONE folder open (no .code-workspace) the
//     folder's settings file is the workspace scope, and `inspect` reports the same
//     values under both the Workspace and the Workspace Folder fields (1.137.0).
//   - `get(key)` resolves the way VS Code does: scopes merge default < user < workspace
//     < folder, then every LANGUAGE block (merged the same way) is laid over the plain
//     result. Objects merge key by key across scopes, anything else is replaced.
//   - `extensions.getExtension` sees an installed AND ENABLED extension only (P4): a
//     disabled one is simply absent, and ids match case-insensitively.
//   - `workspaceFolders` is undefined when no folder is open.
//
// STRICT means anything the command must never do is RECORDED instead of performed,
// and an API that is not modelled at all is reported in `recorded.unexpected`:
//   - `recorded.writes`: every configuration `update`, every file-system write
//     (writeFile/delete/createDirectory/rename/copy), `applyEdit`, `openExternal`.
//   - `recorded.unexpected`: any property read on the namespaces below that this
//     stub does not model (a new API use shows up here and fails the test).
export const DIRECTORY = Symbol('directory');

export type SettingMap = Readonly<Record<string, unknown>>;

/** The values one scope holds: plain keys plus per-language `[lang]` blocks. */
export interface ScopeValues {
  readonly plain?: SettingMap;
  readonly languages?: Readonly<Record<string, SettingMap>>;
}

export interface FakeDocument {
  readonly path: string;
  readonly languageId: string;
  readonly scheme?: string;
}

export interface FakeHostOptions {
  /** Built-in + extension-contributed defaults (merged over BASE_DEFAULTS). */
  readonly defaults?: ScopeValues;
  readonly user?: ScopeValues;
  readonly workspace?: ScopeValues;
  /**
   * The "Workspace Folder" scope, seen only by a document inside the first folder. It
   * exists ONLY in a multi-root workspace (see `workspaceFile`): with one folder open,
   * the folder's settings file IS the workspace scope, and giving `folder` throws.
   */
  readonly folder?: ScopeValues;
  /** Folder fsPaths. Default ['/ws']. An empty array means no folder is open. */
  readonly folders?: readonly string[];
  /** A .code-workspace file: makes this a multi-root workspace, even with one folder. */
  readonly workspaceFile?: string;
  /** Workspace Trust. Default true. */
  readonly trusted?: boolean;
  /** Installed AND ENABLED extensions, by id. */
  readonly extensions?: Readonly<Record<string, { readonly displayName?: unknown }>>;
  /** The file system: path -> text, or DIRECTORY. */
  readonly files?: Readonly<Record<string, string | typeof DIRECTORY>>;
  /** The active document; `null` = no active editor. Default: /ws/app.css (css). */
  readonly document?: FakeDocument | null;
  /** How `inspect` behaves. Default 'full'. */
  readonly inspect?: 'full' | 'no-language-fields' | 'absent' | 'throws';
  /** Keys (short, e.g. 'formatOnSave') whose `get` throws. */
  readonly getThrows?: readonly string[];
  /** Makes `extensions.getExtension` throw. */
  readonly extensionsThrow?: boolean;
  /** Makes reading `window.activeTextEditor` throw. */
  readonly activeEditorThrows?: boolean;
  /** What a notification answers. Default: dismissed (undefined). */
  readonly pick?: (message: string, buttons: readonly string[]) => string | undefined;
}

export interface Shown {
  readonly kind: 'info' | 'warning';
  readonly message: string;
  readonly buttons: readonly string[];
}

export interface Recorded {
  readonly writes: string[];
  readonly unexpected: string[];
  readonly fsReads: string[];
  readonly executed: Array<{ command: string; args: unknown[] }>;
  readonly shown: Shown[];
  readonly output: string[];
  readonly outputShown: boolean[];
  outputCleared: number;
}

/** What VS Code registers for the keys the command reads, before anyone sets them. */
export const BASE_DEFAULTS: ScopeValues = {
  plain: {
    'editor.defaultFormatter': null,
    'editor.formatOnSave': false,
    'editor.formatOnSaveMode': 'file',
    'editor.codeActionsOnSave': {},
    'files.trimTrailingWhitespace': false,
    'files.insertFinalNewline': false,
    'files.trimFinalNewlines': false
  }
};

interface FakeUri {
  readonly scheme: string;
  readonly path: string;
  readonly fsPath: string;
  toString(): string;
}

function makeUri(path: string, scheme = 'file'): FakeUri {
  return { scheme, path, fsPath: path, toString: () => `${scheme}://${path}` };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** VS Code's merge: objects key by key, anything else replaced by the higher scope. */
function merge(base: unknown, over: unknown): unknown {
  if (isObject(base) && isObject(over)) {
    const kept = Object.entries(base).filter(([k]) => !(k in over));
    const laid = Object.entries(over).map(
      ([k, v]): [string, unknown] => [k, k in base ? merge(base[k], v) : v]
    );
    return Object.fromEntries([...kept, ...laid]);
  }
  return over;
}

function mergeScopes(scopes: readonly (SettingMap | undefined)[], key: string): unknown {
  return scopes.reduce<unknown>(
    (acc, scope) => (scope !== undefined && key in scope ? merge(acc, scope[key]) : acc),
    undefined
  );
}

/**
 * A namespace that records any property it does not model instead of inventing it.
 * Symbols and the interop probes of the module loader are not API uses.
 */
function strict<T extends object>(name: string, target: T, unexpected: string[]): T {
  const ignored = new Set(['__esModule', 'default', 'then', 'toJSON', 'constructor', 'inspect']);
  return new Proxy(target, {
    get(obj, prop, receiver) {
      if (typeof prop === 'symbol' || prop in obj || ignored.has(prop)) {
        return Reflect.get(obj, prop, receiver);
      }
      unexpected.push(`${name}.${prop}`);
      return undefined;
    }
  });
}

export function makeFakeHost(options: FakeHostOptions = {}) {
  const recorded: Recorded = {
    writes: [],
    unexpected: [],
    fsReads: [],
    executed: [],
    shown: [],
    output: [],
    outputShown: [],
    outputCleared: 0
  };

  const folderPaths = options.folders ?? ['/ws'];
  const folders = folderPaths.map((p, index) => ({ uri: makeUri(p), name: p, index }));
  const singleFolder = folderPaths.length === 1 && options.workspaceFile === undefined;
  if (singleFolder && options.folder !== undefined) {
    throw new Error('the Workspace Folder scope exists only in a multi-root workspace: give workspaceFile');
  }
  const files = new Map(Object.entries(options.files ?? {}));
  const installed = Object.entries(options.extensions ?? {});
  const documentSpec = options.document === undefined ? { path: '/ws/app.css', languageId: 'css' } : options.document;

  const scopesFor = (languageId: string | undefined, documentPath: string | undefined) => {
    const folderOpen = folderPaths.length > 0;
    const insideFirstFolder =
      folderOpen && documentPath !== undefined && documentPath.startsWith(`${folderPaths[0]}/`);
    const layers = {
      default: [options.defaults],
      user: [options.user],
      workspace: folderOpen ? [options.workspace] : [],
      // One folder open: its settings file IS the workspace scope, so `inspect` reports the
      // same values under both fields (observed in a real host, 1.137.0).
      folder: insideFirstFolder ? [singleFolder ? options.workspace : options.folder] : []
    };
    const plain = (...which: Array<keyof typeof layers>) =>
      which.flatMap((w) => layers[w]).map((s) => s?.plain);
    const lang = (...which: Array<keyof typeof layers>) =>
      which.flatMap((w) => layers[w]).map((s) => (languageId ? s?.languages?.[languageId] : undefined));
    return { plain, lang, folderOpen, insideFirstFolder };
  };

  const getConfiguration = (section: string, scope?: { uri?: FakeUri; languageId?: string }) => {
    const languageId = scope?.languageId;
    const s = scopesFor(languageId, scope?.uri?.path);
    const full = (key: string): string => `${section}.${key}`;
    const base = BASE_DEFAULTS.plain ?? {};

    return {
      get: (key: string, fallback?: unknown): unknown => {
        if (options.getThrows?.includes(key)) {
          throw new Error(`simulated get failure for ${key}`);
        }
        const k = full(key);
        const plainValue = mergeScopes([base, ...s.plain('default', 'user', 'workspace', 'folder')], k);
        const languageValue = mergeScopes(s.lang('default', 'user', 'workspace', 'folder'), k);
        const value = languageValue === undefined ? plainValue : merge(plainValue, languageValue);
        return value === undefined ? fallback : value;
      },
      has: (key: string): boolean => mergeScopes([base, ...s.plain('default', 'user', 'workspace', 'folder')], full(key)) !== undefined,
      ...(options.inspect === 'absent'
        ? {}
        : {
            inspect: (key: string) => {
              if (options.inspect === 'throws') {
                throw new Error('simulated inspect failure');
              }
              const k = full(key);
              const one = (layer: 'default' | 'user' | 'workspace' | 'folder', extra?: SettingMap) =>
                mergeScopes([extra, ...s.plain(layer)], k);
              const oneLang = (layer: 'default' | 'user' | 'workspace' | 'folder') =>
                mergeScopes(s.lang(layer), k);
              const withLanguage = languageId !== undefined && options.inspect !== 'no-language-fields';
              return {
                key: k,
                defaultValue: one('default', base),
                globalValue: one('user'),
                workspaceValue: one('workspace'),
                workspaceFolderValue: one('folder'),
                ...(withLanguage
                  ? {
                      defaultLanguageValue: oneLang('default'),
                      globalLanguageValue: oneLang('user'),
                      workspaceLanguageValue: oneLang('workspace'),
                      workspaceFolderLanguageValue: oneLang('folder'),
                      languageIds: [languageId]
                    }
                  : {})
              };
            }
          }),
      update: (key: string, value: unknown, target: unknown) => {
        recorded.writes.push(`update ${full(key)} = ${JSON.stringify(value)} @ ${String(target)}`);
        return Promise.reject(new Error('the stub refuses configuration writes'));
      }
    };
  };

  const refuseWrite = (what: string) => (...args: unknown[]) => {
    recorded.writes.push(`${what} ${args.map((a) => (a as { path?: string })?.path ?? String(a)).join(' ')}`.trim());
    return Promise.reject(new Error(`the stub refuses ${what}`));
  };

  const fs = strict(
    'workspace.fs',
    {
      stat: (uri: FakeUri) => {
        recorded.fsReads.push(`stat ${uri.path}`);
        const entry = files.get(uri.path);
        if (entry === undefined) {
          return Promise.reject(new Error(`ENOENT ${uri.path}`));
        }
        return Promise.resolve({
          type: entry === DIRECTORY ? 2 : 1,
          size: entry === DIRECTORY ? 0 : Buffer.byteLength(entry)
        });
      },
      readFile: (uri: FakeUri) => {
        recorded.fsReads.push(`read ${uri.path}`);
        const entry = files.get(uri.path);
        return entry === undefined || entry === DIRECTORY
          ? Promise.reject(new Error(`ENOENT ${uri.path}`))
          : Promise.resolve(new Uint8Array(Buffer.from(entry, 'utf8')));
      },
      readDirectory: (uri: FakeUri) => {
        recorded.fsReads.push(`list ${uri.path}`);
        const prefix = `${uri.path.replace(/\/$/, '')}/`;
        const names = [...files.entries()]
          .filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
          .map(([p, e]): [string, number] => [p.slice(prefix.length), e === DIRECTORY ? 2 : 1]);
        return Promise.resolve(names);
      },
      writeFile: refuseWrite('fs.writeFile'),
      delete: refuseWrite('fs.delete'),
      createDirectory: refuseWrite('fs.createDirectory'),
      rename: refuseWrite('fs.rename'),
      copy: refuseWrite('fs.copy')
    },
    recorded.unexpected
  );

  const sharedChannel = {
    appendLine: (line: string) => void recorded.output.push(line),
    append: (text: string) => void recorded.output.push(text),
    show: (preserveFocus?: boolean) => void recorded.outputShown.push(preserveFocus === true),
    clear: () => {
      recorded.outputCleared += 1;
    },
    hide: () => undefined,
    dispose: () => undefined
  };

  const notify = (kind: Shown['kind']) => (message: string, ...buttons: string[]) => {
    recorded.shown.push({ kind, message, buttons });
    return Promise.resolve(options.pick?.(message, buttons));
  };

  const activeEditor =
    documentSpec === null
      ? undefined
      : {
          document: {
            uri: makeUri(documentSpec.path, documentSpec.scheme ?? 'file'),
            languageId: documentSpec.languageId,
            fileName: documentSpec.path
          }
        };

  const namespace = {
    FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
    Uri: {
      file: (p: string) => makeUri(p),
      joinPath: (base: FakeUri, ...segments: string[]) =>
        makeUri([base.path.replace(/\/$/, ''), ...segments].join('/'), base.scheme)
    },
    extensions: strict(
      'extensions',
      {
        getExtension: (id: string) => {
          if (options.extensionsThrow) {
            throw new Error('simulated extensions failure');
          }
          const hit = installed.find(([known]) => known.toLowerCase() === id.toLowerCase());
          return hit ? { id: hit[0], isActive: true, packageJSON: { displayName: hit[1].displayName } } : undefined;
        }
      },
      recorded.unexpected
    ),
    workspace: strict(
      'workspace',
      {
        isTrusted: options.trusted ?? true,
        workspaceFolders: folders.length > 0 ? folders : undefined,
        workspaceFile: options.workspaceFile === undefined ? undefined : makeUri(options.workspaceFile),
        fs,
        getConfiguration,
        applyEdit: refuseWrite('workspace.applyEdit'),
        saveAll: refuseWrite('workspace.saveAll')
      },
      recorded.unexpected
    ),
    window: strict(
      'window',
      {
        get activeTextEditor() {
          if (options.activeEditorThrows) {
            throw new Error('simulated editor failure');
          }
          return activeEditor;
        },
        createOutputChannel: () => sharedChannel,
        showInformationMessage: notify('info'),
        showWarningMessage: notify('warning')
      },
      recorded.unexpected
    ),
    commands: strict(
      'commands',
      {
        executeCommand: (command: string, ...args: unknown[]) => {
          recorded.executed.push({ command, args });
          return Promise.resolve(undefined);
        }
      },
      recorded.unexpected
    ),
    env: strict(
      'env',
      { openExternal: refuseWrite('env.openExternal') },
      recorded.unexpected
    )
  };

  return { vscode: strict('vscode', namespace, recorded.unexpected), recorded, document: activeEditor?.document };
}

export type FakeHost = ReturnType<typeof makeFakeHost>;
