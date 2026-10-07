// A minimal in-memory stand-in for the parts of the `vscode` API the migration
// touches, so the HOST half of src/migration (source reads, the modal recap, the
// consented write, the rollback, the closing messages) is exercised by plain mocha
// tests. Not a test file itself (no `.test.` in the name): mocha's glob skips it.
//
// It models exactly what the migration uses and nothing else:
//   - workspace: isTrusted, workspaceFolders, fs.stat / fs.readFile (read-only,
//     and it RECORDS every call so a test can prove nothing was read in
//     Restricted Mode), getConfiguration(section, scope).inspect / .update over an
//     in-memory settings store with the real workspace/global x plain/language slots;
//   - Uri.file / Uri.joinPath, FileType, ConfigurationTarget;
//   - extensions.getExtension (an installed-and-ENABLED extension; a disabled one
//     is simply absent, as in the real API, probe P4);
//   - window.showInformationMessage / showErrorMessage, commands.executeCommand.
//
// There is deliberately NO way to write a file: the migration is read-only on the
// file system, and a test that needs to prove it can look at `fsCalls`.
export interface FakeUri {
  readonly scheme: 'file';
  readonly fsPath: string;
  readonly path: string;
}

/** One recorded `update` call, exactly as the migration issued it. */
export interface UpdateCall {
  readonly section: string;
  readonly key: string;
  readonly value: unknown;
  readonly target: string;
  readonly overrideInLanguage: boolean | undefined;
  readonly language: string | undefined;
}

/** One recorded notification. */
export interface ShownMessage {
  readonly kind: 'info' | 'error';
  readonly message: string;
  readonly options: { modal?: boolean; detail?: string } | undefined;
  readonly actions: readonly string[];
}

/** Marks a path as a directory in {@link FakeOptions.files}. */
export const DIRECTORY = Symbol('directory');

export interface FakeOptions {
  /** Workspace Trust. Default true. */
  readonly trusted?: boolean;
  /** Workspace folder fsPaths. Default one folder, '/ws'. */
  readonly folders?: readonly string[];
  /** The file system: fsPath -> text, or DIRECTORY. */
  readonly files?: Readonly<Record<string, string | typeof DIRECTORY>>;
  /** Paths whose `readFile` throws (they still `stat` fine). */
  readonly unreadable?: readonly string[];
  /** Size reported by `stat`, per path, overriding the real byte length. */
  readonly sizes?: Readonly<Record<string, number>>;
  /** The incumbent, installed AND ENABLED, with its install folder. Absent = disabled or uninstalled. */
  readonly incumbentPath?: string;
  /** Initial settings at Workspace scope: `'[css] tidy.indent'` or `'tidy.indent'` -> value. */
  readonly workspaceSettings?: Readonly<Record<string, unknown>>;
  /** Initial settings at User scope, same keys. */
  readonly globalSettings?: Readonly<Record<string, unknown>>;
  /** What each notification answers, by its message. Default: undefined (dismissed). */
  readonly answer?: (message: ShownMessage) => string | undefined;
  /** Makes an `update` throw. Receives the call and its 1-based index. */
  readonly failUpdate?: (call: UpdateCall, index: number) => Error | undefined;
  /** Makes `inspect` throw. */
  readonly failInspect?: boolean;
}

function toUri(fsPath: string): FakeUri {
  const normalised = fsPath.replace(/\\/g, '/');
  return { scheme: 'file', fsPath: normalised, path: normalised };
}

/** The settings-store key of one slot. */
function slotKey(language: string | undefined, key: string): string {
  return language === undefined ? `tidy.${key}` : `[${language}] tidy.${key}`;
}

export function makeFakeVscode(options: FakeOptions = {}) {
  const files = new Map<string, string | typeof DIRECTORY>(
    Object.entries(options.files ?? {})
  );
  const workspaceStore = new Map<string, unknown>(
    Object.entries(options.workspaceSettings ?? {})
  );
  const globalStore = new Map<string, unknown>(
    Object.entries(options.globalSettings ?? {})
  );
  const fsCalls: string[] = [];
  const updates: UpdateCall[] = [];
  const shown: ShownMessage[] = [];
  const executedCommands: Array<{ command: string; args: unknown[] }> = [];

  const folders = (options.folders ?? ['/ws']).map((fsPath) => ({
    uri: toUri(fsPath)
  }));

  const storeOf = (target: string) =>
    target === 'GLOBAL' ? globalStore : workspaceStore;

  const show = (kind: 'info' | 'error', args: unknown[]): Promise<string | undefined> => {
    const [message, ...rest] = args as [string, ...unknown[]];
    const hasOptions = typeof rest[0] === 'object' && rest[0] !== null;
    const record: ShownMessage = {
      kind,
      message,
      options: hasOptions
        ? (rest[0] as { modal?: boolean; detail?: string })
        : undefined,
      actions: (hasOptions ? rest.slice(1) : rest) as string[]
    };
    shown.push(record);
    return Promise.resolve(options.answer?.(record));
  };

  const vscode = {
    // Recorded state, for assertions.
    fsCalls,
    updates,
    shown,
    executedCommands,
    workspaceStore,
    globalStore,

    ConfigurationTarget: { Global: 'GLOBAL', Workspace: 'WS' },
    FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },

    Uri: {
      file: (fsPath: string): FakeUri => toUri(fsPath),
      joinPath: (base: FakeUri, ...segments: string[]): FakeUri =>
        toUri([base.fsPath.replace(/\/$/, ''), ...segments].join('/'))
    },

    extensions: {
      getExtension: (id: string) =>
        id === 'lonefy.vscode-JS-CSS-HTML-formatter' &&
        options.incumbentPath !== undefined
          ? { id, extensionPath: options.incumbentPath }
          : undefined
    },

    workspace: {
      isTrusted: options.trusted ?? true,
      workspaceFolders: folders,
      fs: {
        stat: (uri: FakeUri) => {
          fsCalls.push(`stat ${uri.fsPath}`);
          const entry = files.get(uri.fsPath);
          if (entry === undefined) {
            return Promise.reject(new Error(`ENOENT ${uri.fsPath}`));
          }
          if (entry === DIRECTORY) {
            return Promise.resolve({ type: 2, size: 0 });
          }
          return Promise.resolve({
            type: 1,
            size: options.sizes?.[uri.fsPath] ?? Buffer.byteLength(entry)
          });
        },
        readFile: (uri: FakeUri) => {
          fsCalls.push(`read ${uri.fsPath}`);
          const entry = files.get(uri.fsPath);
          if (entry === undefined || entry === DIRECTORY) {
            return Promise.reject(new Error(`ENOENT ${uri.fsPath}`));
          }
          if (options.unreadable?.includes(uri.fsPath)) {
            return Promise.reject(new Error(`EACCES ${uri.fsPath}`));
          }
          return Promise.resolve(new Uint8Array(Buffer.from(entry, 'utf8')));
        }
      },
      getConfiguration: (section: string, scope?: { languageId?: string }) => {
        const language = scope?.languageId;
        return {
          inspect: (key: string) => {
            if (options.failInspect) {
              throw new Error('simulated inspect failure');
            }
            const slot = slotKey(language, key);
            return language === undefined
              ? {
                  workspaceValue: workspaceStore.get(slot),
                  globalValue: globalStore.get(slot)
                }
              : {
                  workspaceLanguageValue: workspaceStore.get(slot),
                  globalLanguageValue: globalStore.get(slot)
                };
          },
          update: (
            key: string,
            value: unknown,
            target: string,
            overrideInLanguage?: boolean
          ) => {
            const call: UpdateCall = {
              section,
              key,
              value,
              target,
              overrideInLanguage,
              language
            };
            updates.push(call);
            const failure = options.failUpdate?.(call, updates.length);
            if (failure !== undefined) {
              return Promise.reject(failure);
            }
            const store = storeOf(target);
            const slot = slotKey(language, key);
            if (value === undefined) {
              store.delete(slot);
            } else {
              store.set(slot, value);
            }
            return Promise.resolve();
          }
        };
      }
    },

    window: {
      showInformationMessage: (...args: unknown[]) => show('info', args),
      showErrorMessage: (...args: unknown[]) => show('error', args)
    },

    commands: {
      executeCommand: (command: string, ...args: unknown[]) => {
        executedCommands.push({ command, args });
        return Promise.resolve(undefined);
      }
    }
  };

  return vscode;
}

export type FakeVscode = ReturnType<typeof makeFakeVscode>;
