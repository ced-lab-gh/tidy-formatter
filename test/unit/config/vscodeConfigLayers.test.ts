// End-to-end tests of the VS Code-facing layer builder (src/config/vscodeConfig.ts),
// driven through a 'vscode' stub that answers workspace.getConfiguration().inspect()
// with the full per-scope shape the real host returns. They lock four defects that
// only exist at this seam, where no pure resolver test can see them:
//
//   C-12   tidy.indent was inert: the live FormattingOptions layer always sits
//          above it, and VS Code passes a tab size on every call. An EXPLICIT
//          tidy.indent now wins over the editor, while every project config still
//          wins over it and an UNSET tidy.indent is no opinion at all.
//   C-15   one print width by layer order, end to end, through real .editorconfig,
//          .prettierrc and .soukformatrc files on disk.
//   LOW-03 an explicit tidy.wrap_line_length of 0 reaches the Prettier path as
//          "do not wrap", an unset one does not.
//   LOW-05 a per-language DEFAULT that another extension contributes through
//          configurationDefaults (inspect().defaultLanguageValue) is not the
//          user's choice and must not be read as one.
//
// Stub idiom copied from test/unit/providers/formattingProvider.test.ts: patch
// Module._load inside before(), require the module under test, then remove the
// patch and every module it pulled in inside after(), so nothing leaks.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import Module from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { LangId, ResolvedOptions } from '../../../src/types';

/** The per-scope answer of WorkspaceConfiguration.inspect(), as VS Code shapes it. */
interface Inspected {
  defaultValue?: unknown;
  globalValue?: unknown;
  workspaceValue?: unknown;
  workspaceFolderValue?: unknown;
  defaultLanguageValue?: unknown;
  globalLanguageValue?: unknown;
  workspaceLanguageValue?: unknown;
  workspaceFolderLanguageValue?: unknown;
}

const LANGUAGE_FIELDS = [
  'defaultLanguageValue',
  'globalLanguageValue',
  'workspaceLanguageValue',
  'workspaceFolderLanguageValue'
];

interface StubState {
  trusted: boolean;
  workspaceRoot: string | undefined;
  /** section -> key -> inspect() shape. */
  configuration: Record<string, Record<string, Inspected>>;
}

const state: StubState = { trusted: true, workspaceRoot: undefined, configuration: {} };

class FakeUri {
  readonly scheme = 'file';
  constructor(readonly fsPath: string) {}
}

class FakeDocument {
  readonly uri: FakeUri;
  constructor(
    readonly languageId: string,
    private readonly text: string,
    fsPath: string
  ) {
    this.uri = new FakeUri(fsPath);
  }
  getText(): string {
    return this.text;
  }
}

/** True when the scope argument names a language, as `{ uri, languageId }` does. */
function scopeNamesLanguage(scope: unknown): boolean {
  return (
    typeof scope === 'object' &&
    scope !== null &&
    'languageId' in scope &&
    !('getText' in scope)
  );
}

const vscodeStub = {
  window: {
    createOutputChannel(): { appendLine(line: string): void; dispose(): void } {
      return { appendLine: () => undefined, dispose: () => undefined };
    }
  },
  workspace: {
    get isTrusted(): boolean {
      return state.trusted;
    },
    getConfiguration(section?: string, scope?: unknown) {
      const withLanguage = scopeNamesLanguage(scope);
      const bag = (): Record<string, Inspected> => state.configuration[section ?? ''] ?? {};
      return {
        get(key: string, fallback?: unknown): unknown {
          const shape = (bag()[key] ?? {}) as Record<string, unknown>;
          const order = [
            'workspaceFolderLanguageValue',
            'workspaceFolderValue',
            'workspaceLanguageValue',
            'workspaceValue',
            'globalLanguageValue',
            'globalValue',
            'defaultLanguageValue',
            'defaultValue'
          ];
          for (const field of order) {
            if (!withLanguage && LANGUAGE_FIELDS.includes(field)) {
              continue;
            }
            if (shape[field] !== undefined) {
              return shape[field];
            }
          }
          return fallback;
        },
        inspect(key: string): Record<string, unknown> | undefined {
          const shape = bag()[key];
          if (!shape) {
            return undefined;
          }
          const out: Record<string, unknown> = { key };
          for (const [field, value] of Object.entries(shape)) {
            if (!withLanguage && LANGUAGE_FIELDS.includes(field)) {
              continue; // a scope without a languageId never reports language values
            }
            out[field] = value;
          }
          return out;
        }
      };
    },
    getWorkspaceFolder(): { uri: FakeUri } | undefined {
      return state.workspaceRoot === undefined
        ? undefined
        : { uri: new FakeUri(state.workspaceRoot) };
    }
  }
};

type LoadFn = (request: string, parent: unknown, isMain: boolean) => unknown;

interface VscodeConfigModule {
  readResolvedOptions(
    document: unknown,
    languageId: LangId,
    formattingOptions: { tabSize: number; insertSpaces: boolean }
  ): ResolvedOptions;
}

const VS_CODE_GLOBAL = 'VS Code settings (tidy.*)';
const FORMATTING_OPTIONS_SOURCE = 'FormattingOptions (live, per call)';

describe('config/vscodeConfig : the layers built from the host (C-12, C-15, LOW-03, LOW-05)', () => {
  const loader = Module as unknown as { _load: LoadFn };
  let originalLoad: LoadFn;
  let cachedBefore: Set<string>;
  let vscodeConfig: VscodeConfigModule;
  let workspace: string;

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
        return vscodeStub;
      }
      return originalLoad.call(this, request, parent, isMain);
    };
    vscodeConfig = require('../../../src/config/vscodeConfig') as VscodeConfigModule;
  });

  after(() => {
    loader._load = originalLoad;
    for (const key of Object.keys(require.cache)) {
      if (!cachedBefore.has(key)) {
        delete require.cache[key];
      }
    }
  });

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'tidy-vscodecfg-'));
    state.trusted = true;
    state.workspaceRoot = workspace;
    state.configuration = {};
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  /** Write project files into the temporary workspace. */
  function write(files: Record<string, string>): void {
    for (const [rel, content] of Object.entries(files)) {
      const target = join(workspace, ...rel.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
  }

  function resolve(
    languageId: LangId,
    relPath: string,
    formatting = { tabSize: 2, insertSpaces: true }
  ): ResolvedOptions {
    const fsPath = join(workspace, ...relPath.split('/'));
    mkdirSync(dirname(fsPath), { recursive: true });
    writeFileSync(fsPath, '');
    return vscodeConfig.readResolvedOptions(
      new FakeDocument(languageId, '', fsPath),
      languageId,
      formatting
    );
  }

  function tidy(settings: Record<string, Inspected>): void {
    state.configuration.tidy = settings;
  }

  /* ------------------------------------------------------------------ */
  /* C-12 : tidy.indent                                                   */
  /* ------------------------------------------------------------------ */

  describe('C-12 : an explicit tidy.indent takes effect', () => {
    it('an UNSET tidy.indent leaves the editor tab size in charge', () => {
      const r = resolve('css', 'a.css');
      assert.equal(r.tabSize, 2);
      assert.equal(r.sources.tabSize, FORMATTING_OPTIONS_SOURCE);
    });

    it('a global tidy.indent beats the live FormattingOptions', () => {
      tidy({ indent: { globalValue: 8 } });
      const r = resolve('css', 'a.css', { tabSize: 2, insertSpaces: true });
      assert.equal(r.tabSize, 8);
      assert.equal(r.sources.tabSize, VS_CODE_GLOBAL);
    });

    it('a workspace-folder value wins over the workspace and user values', () => {
      tidy({ indent: { globalValue: 8, workspaceValue: 6, workspaceFolderValue: 3 } });
      assert.equal(resolve('css', 'a.css').tabSize, 3);
    });

    it('a [lang] tidy.indent beats the global one, and is attributed to [lang]', () => {
      tidy({ indent: { globalValue: 8, globalLanguageValue: 6 } });
      const r = resolve('css', 'a.css');
      assert.equal(r.tabSize, 6);
      assert.match(r.sources.tabSize, /\[css\]/);
    });

    it('applies to every language, JSON included', () => {
      tidy({ indent: { globalValue: 6 } });
      assert.equal(resolve('json', 'a.json').tabSize, 6);
      assert.equal(resolve('html', 'a.html').tabSize, 6);
      assert.equal(resolve('typescript', 'src/a.ts').tabSize, 6);
    });

    it('beats an explicit [lang] editor.tabSize as well', () => {
      state.configuration.editor = { tabSize: { globalLanguageValue: 2 } };
      tidy({ indent: { globalValue: 8 } });
      assert.equal(resolve('css', 'a.css', { tabSize: 2, insertSpaces: true }).tabSize, 8);
    });

    it('a project .editorconfig still wins over it', () => {
      write({ '.editorconfig': 'root = true\n[*]\nindent_size = 3\n' });
      tidy({ indent: { globalValue: 8 } });
      const r = resolve('css', 'a.css');
      assert.equal(r.tabSize, 3);
      assert.equal(r.sources.tabSize, '.editorconfig');
    });

    it('a .soukformatrc still wins over it', () => {
      write({ '.soukformatrc': '{"css": {"indent": 5}}' });
      tidy({ indent: { globalValue: 8 } });
      assert.equal(resolve('css', 'a.css').tabSize, 5);
    });

    it('a .prettierrc tabWidth still wins over it on a Prettier-printed file', () => {
      write({ '.prettierrc': '{"tabWidth": 7}' });
      tidy({ indent: { globalValue: 8 } });
      assert.equal(resolve('typescript', 'src/a.ts').tabSize, 7);
    });

    it('does not touch insertSpaces: tabs stay in charge of tabs', () => {
      tidy({ indent: { globalValue: 8 } });
      const r = resolve('css', 'a.css', { tabSize: 2, insertSpaces: false });
      assert.equal(r.insertSpaces, false);
      assert.equal(r.tabSize, 8);
    });

    it('an out-of-type value is dropped, not propagated', () => {
      tidy({ indent: { globalValue: 'eight' } });
      assert.equal(resolve('css', 'a.css').tabSize, 2);
    });

    it('does not leak into the engine options', () => {
      tidy({ indent: { globalValue: 8 } });
      const r = resolve('css', 'a.css');
      assert.equal(r.engineOptions.indent_size, undefined);
      assert.equal(r.engineOptions.tabSize, undefined);
    });
  });

  /* ------------------------------------------------------------------ */
  /* C-15 + LOW-03 : one print width, end to end                          */
  /* ------------------------------------------------------------------ */

  describe('C-15 : one print width by layer order, through real project files', () => {
    const printWidth = (r: ResolvedOptions): unknown =>
      (r.engineOptions.prettier as Record<string, unknown> | undefined)?.printWidth;

    it('a VS Code tidy.prettier.printWidth no longer beats an .editorconfig max_line_length', () => {
      write({ '.editorconfig': 'root = true\n[*]\nmax_line_length = 120\n' });
      tidy({ 'prettier.printWidth': { globalValue: 40 } });
      const r = resolve('typescript', 'src/a.ts');
      assert.equal(printWidth(r), 120);
      assert.equal(r.sources['prettier.printWidth'], '.editorconfig');
    });

    it('nor a .soukformatrc wrap_line_length', () => {
      write({ '.soukformatrc': '{"typescript": {"wrap_line_length": 120}}' });
      tidy({ 'prettier.printWidth': { globalValue: 40 } });
      const r = resolve('typescript', 'src/a.ts');
      assert.equal(printWidth(r), 120);
      assert.match(r.sources['prettier.printWidth'], /\.soukformatrc/);
    });

    it('but a .soukformatrc printWidth beats an .editorconfig max_line_length', () => {
      write({
        '.editorconfig': 'root = true\n[*]\nmax_line_length = 120\n',
        '.soukformatrc': '{"typescript": {"printWidth": 40}}'
      });
      assert.equal(printWidth(resolve('typescript', 'src/a.ts')), 40);
    });

    it('a .prettierrc printWidth beats a VS Code width and an .editorconfig one', () => {
      write({
        '.editorconfig': 'root = true\n[*]\nmax_line_length = 100\n',
        '.prettierrc': '{"printWidth": 90}'
      });
      tidy({ 'prettier.printWidth': { globalValue: 40 } });
      assert.equal(printWidth(resolve('typescript', 'src/a.ts')), 90);
    });

    it('a [lang] width beats a global one in either vocabulary', () => {
      tidy({
        wrap_line_length: { globalValue: 120 },
        'prettier.printWidth': { globalLanguageValue: 40 }
      });
      assert.equal(printWidth(resolve('typescript', 'src/a.ts')), 40);
      tidy({
        wrap_line_length: { globalLanguageValue: 120 },
        'prettier.printWidth': { globalValue: 40 }
      });
      assert.equal(printWidth(resolve('typescript', 'src/a.ts')), 120);
    });

    it('with no width set anywhere, none is produced (Prettier keeps its own default)', () => {
      const r = resolve('typescript', 'src/a.ts');
      assert.equal(printWidth(r), undefined);
    });
  });

  describe('LOW-03 : an explicit wrap_line_length of 0 is a choice, an unset one is not', () => {
    const printWidth = (r: ResolvedOptions): unknown =>
      (r.engineOptions.prettier as Record<string, unknown> | undefined)?.printWidth;

    it('an explicit 0 reaches the Prettier path as the unbounded width', () => {
      tidy({ wrap_line_length: { globalValue: 0 } });
      const r = resolve('typescriptreact', 'src/a.tsx');
      assert.equal(printWidth(r), Number.POSITIVE_INFINITY);
      assert.equal(r.sources['prettier.printWidth'], VS_CODE_GLOBAL);
    });

    it('an UNSET wrap_line_length produces no width at all', () => {
      tidy({ wrap_line_length: { defaultValue: 0 } });
      assert.equal(printWidth(resolve('typescriptreact', 'src/a.tsx')), undefined);
    });

    it('a positive .editorconfig width beats an earlier 0 from VS Code settings', () => {
      write({ '.editorconfig': 'root = true\n[*]\nmax_line_length = 100\n' });
      tidy({ wrap_line_length: { globalValue: 0 } });
      assert.equal(printWidth(resolve('typescript', 'src/a.ts')), 100);
    });
  });

  /* ------------------------------------------------------------------ */
  /* LOW-05 : defaults contributed by another extension                   */
  /* ------------------------------------------------------------------ */

  describe('LOW-05 : configurationDefaults from another extension are not the user choice', () => {
    it('files.insertFinalNewline / eol / trimTrailingWhitespace defaults are not read', () => {
      state.configuration.files = {
        insertFinalNewline: { defaultValue: false, defaultLanguageValue: true },
        eol: { defaultValue: 'auto', defaultLanguageValue: '\r\n' },
        trimTrailingWhitespace: { defaultValue: false, defaultLanguageValue: true }
      };
      const r = resolve('css', 'a.css');
      assert.equal(r.insertFinalNewline, undefined);
      assert.equal(r.endOfLine, undefined);
      assert.equal(r.trimTrailingWhitespace, undefined);
      assert.equal(r.sources.insertFinalNewline, undefined, 'no layer is credited');
    });

    it('an editor.tabSize default is not read either (FormattingOptions is the channel)', () => {
      state.configuration.editor = { tabSize: { defaultValue: 4, defaultLanguageValue: 2 } };
      const r = resolve('css', 'a.css', { tabSize: 4, insertSpaces: true });
      assert.equal(r.tabSize, 4);
      assert.equal(r.sources.tabSize, FORMATTING_OPTIONS_SOURCE);
    });

    it('the same keys set by the USER at any scope are still honoured', () => {
      state.configuration.files = {
        insertFinalNewline: { defaultLanguageValue: false, globalLanguageValue: true },
        eol: { workspaceValue: '\n' },
        trimTrailingWhitespace: { workspaceFolderValue: true }
      };
      const r = resolve('css', 'a.css');
      assert.equal(r.insertFinalNewline, true);
      assert.equal(r.endOfLine, 'lf');
      assert.equal(r.trimTrailingWhitespace, true);
      assert.equal(r.sources.insertFinalNewline, 'VS Code settings ([lang] editor)');
    });

    it('a user value wins over the extension default for the same key', () => {
      state.configuration.files = {
        insertFinalNewline: { defaultLanguageValue: true, workspaceLanguageValue: false }
      };
      assert.equal(resolve('css', 'a.css').insertFinalNewline, false);
    });
  });
});
