// OPTIONS-6 at the seam where a user actually meets them: the VS Code settings, a
// .soukformatrc and a .prettierrc on disk, read by src/config/vscodeConfig.ts through
// a 'vscode' stub that answers workspace.getConfiguration().inspect() with the
// per-scope shape the real host returns, then printed by the real engine.
//
// It pins what no pure test can see from either side:
//   - each of the six settings reaches the engine bag for the languages it is declared
//     for, attributed to the right layer, and is NOT read for any other language;
//   - a [lang] block beats the global value, and a project config beats both;
//   - the two tag lists are replaced as a whole by a higher layer (a setting can never
//     "half merge" two lists), and what the engine adds is always ON TOP of the built-ins;
//   - a value of the wrong shape is refused, an entry that is not a tag name reaches the
//     engine and is dropped there;
//   - a .prettierrc carrying singleAttributePerLine / objectWrap governs a trusted
//     workspace's JSX/TS files and is ignored in Restricted Mode.
//
// Stub idiom copied from test/unit/config/vscodeConfigLayers.test.ts: patch
// Module._load inside before(), require the module under test, then remove the patch
// and every module it pulled in inside after(), so nothing leaks.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import Module from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { LangId, ResolvedOptions } from '../../../src/types';

interface Inspected {
  globalValue?: unknown;
  workspaceFolderValue?: unknown;
  globalLanguageValue?: unknown;
}

const LANGUAGE_FIELDS = ['globalLanguageValue', 'workspaceLanguageValue', 'workspaceFolderLanguageValue'];

interface StubState {
  trusted: boolean;
  workspaceRoot: string | undefined;
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

function scopeNamesLanguage(scope: unknown): boolean {
  return typeof scope === 'object' && scope !== null && 'languageId' in scope && !('getText' in scope);
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
          for (const field of ['globalLanguageValue', 'workspaceFolderValue', 'globalValue']) {
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
              continue;
            }
            out[field] = value;
          }
          return out;
        }
      };
    },
    getWorkspaceFolder(): { uri: FakeUri } | undefined {
      return state.workspaceRoot === undefined ? undefined : { uri: new FakeUri(state.workspaceRoot) };
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

describe('config/vscodeConfig : the six OPTIONS-6 settings, from the settings to the engine bag', () => {
  const loader = Module as unknown as { _load: LoadFn };
  let originalLoad: LoadFn;
  let cachedBefore: Set<string>;
  let vscodeConfig: VscodeConfigModule;
  let dispatchFormat: typeof import('../../../src/engine/dispatcher').dispatchFormat;
  let workspace: string;

  before(() => {
    originalLoad = loader._load;
    cachedBefore = new Set(Object.keys(require.cache));
    loader._load = function patchedLoad(this: unknown, request: string, parent: unknown, isMain: boolean): unknown {
      if (request === 'vscode') {
        return vscodeStub;
      }
      return originalLoad.call(this, request, parent, isMain);
    };
    vscodeConfig = require('../../../src/config/vscodeConfig') as VscodeConfigModule;
    dispatchFormat = (require('../../../src/engine/dispatcher') as typeof import('../../../src/engine/dispatcher'))
      .dispatchFormat;
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
    workspace = mkdtempSync(join(tmpdir(), 'tidy-options6-'));
    state.trusted = true;
    state.workspaceRoot = workspace;
    state.configuration = {};
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  function write(files: Record<string, string>): void {
    for (const [rel, content] of Object.entries(files)) {
      const target = join(workspace, ...rel.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
  }

  function resolve(languageId: LangId, relPath: string, text = ''): ResolvedOptions {
    const fsPath = join(workspace, ...relPath.split('/'));
    mkdirSync(dirname(fsPath), { recursive: true });
    writeFileSync(fsPath, text);
    return vscodeConfig.readResolvedOptions(new FakeDocument(languageId, text, fsPath), languageId, {
      tabSize: 2,
      insertSpaces: true
    });
  }

  function tidy(settings: Record<string, Inspected>): void {
    state.configuration.tidy = settings;
  }

  const prettierBag = (r: ResolvedOptions): Record<string, unknown> =>
    (r.engineOptions.prettier ?? {}) as Record<string, unknown>;

  describe('a global setting reaches the bag for the languages it is declared for', () => {
    it('js-beautify JavaScript options', () => {
      tidy({ space_before_conditional: { globalValue: false }, jslint_happy: { globalValue: true } });
      const r = resolve('javascript', 'a.js');
      assert.equal(r.engineOptions.space_before_conditional, false);
      assert.equal(r.engineOptions.jslint_happy, true);
      assert.equal(r.sources.space_before_conditional, VS_CODE_GLOBAL);
      assert.equal(r.sources.jslint_happy, VS_CODE_GLOBAL);
    });

    it('the two HTML lists', () => {
      tidy({
        content_unformatted: { globalValue: ['code', 'my-snippet'] },
        void_elements: { globalValue: ['my-icon'] }
      });
      const r = resolve('html', 'a.html');
      assert.deepEqual(r.engineOptions.content_unformatted, ['code', 'my-snippet']);
      assert.deepEqual(r.engineOptions.void_elements, ['my-icon']);
      assert.equal(r.sources.content_unformatted, VS_CODE_GLOBAL);
    });

    it('the two Prettier options, nested under engineOptions.prettier', () => {
      tidy({
        'prettier.singleAttributePerLine': { globalValue: true },
        'prettier.objectWrap': { globalValue: 'collapse' }
      });
      const r = resolve('typescriptreact', 'a.tsx');
      assert.equal(prettierBag(r).singleAttributePerLine, true);
      assert.equal(prettierBag(r).objectWrap, 'collapse');
      assert.equal(r.sources['prettier.singleAttributePerLine'], VS_CODE_GLOBAL);
    });
  });

  describe('it is NOT read for a language the option does not serve', () => {
    const everything: Record<string, Inspected> = {
      space_before_conditional: { globalValue: false },
      jslint_happy: { globalValue: true },
      content_unformatted: { globalValue: ['code'] },
      void_elements: { globalValue: ['my-icon'] },
      'prettier.singleAttributePerLine': { globalValue: true },
      'prettier.objectWrap': { globalValue: 'collapse' }
    };

    const cases: ReadonlyArray<readonly [LangId, string, readonly string[]]> = [
      // language, file, the engine keys that MAY appear for it
      ['css', 'a.css', []],
      ['json', 'a.json', []],
      ['html', 'a.html', ['content_unformatted', 'void_elements']],
      // A .js file may hold JSX (then Prettier prints it), so the Prettier options are
      // declared for it as well; the resolver cannot tell the two kinds of .js apart.
      [
        'javascript',
        'a.js',
        [
          'space_before_conditional',
          'jslint_happy',
          'prettier.singleAttributePerLine',
          'prettier.objectWrap'
        ]
      ],
      ['typescript', 'a.ts', ['prettier.objectWrap']],
      ['typescriptreact', 'a.tsx', ['prettier.singleAttributePerLine', 'prettier.objectWrap']],
      ['javascriptreact', 'a.jsx', ['prettier.singleAttributePerLine', 'prettier.objectWrap']]
    ];

    for (const [lang, file, allowed] of cases) {
      it(`${lang}: only ${allowed.length === 0 ? 'nothing' : allowed.join(', ')}`, () => {
        tidy(everything);
        const r = resolve(lang, file);
        const present = [
          ...Object.keys(r.engineOptions).filter((k) => k !== 'prettier'),
          ...Object.keys(prettierBag(r)).map((k) => `prettier.${k}`)
        ].filter((k) => Object.keys(everything).includes(k));
        assert.deepEqual(present.sort(), [...allowed].sort());
      });
    }

    it('plain typescript gets objectWrap but not singleAttributePerLine: a .ts file holds no JSX', () => {
      tidy(everything);
      const r = resolve('typescript', 'a.ts');
      assert.equal(prettierBag(r).objectWrap, 'collapse');
      assert.equal(prettierBag(r).singleAttributePerLine, undefined);
    });
  });

  describe('layering', () => {
    it('a [lang] block beats the global value and is attributed to the language', () => {
      tidy({
        jslint_happy: { globalValue: false, globalLanguageValue: true },
        content_unformatted: { globalValue: ['a'], globalLanguageValue: ['b'] }
      });
      const js = resolve('javascript', 'a.js');
      assert.equal(js.engineOptions.jslint_happy, true);
      assert.match(js.sources.jslint_happy, /\[javascript\]/);
      const html = resolve('html', 'a.html');
      assert.deepEqual(html.engineOptions.content_unformatted, ['b'], 'the list is replaced, never merged');
      assert.match(html.sources.content_unformatted, /\[html\]/);
    });

    it('a .soukformatrc beats the VS Code setting, and replaces a list whole', () => {
      tidy({ void_elements: { globalValue: ['from-settings'] } });
      write({ '.soukformatrc': '{"html": {"void_elements": ["my-icon", "my-badge"]}}' });
      const r = resolve('html', 'a.html');
      assert.deepEqual(r.engineOptions.void_elements, ['my-icon', 'my-badge']);
      assert.match(r.sources.void_elements, /\.soukformatrc/);
    });

    it('a .soukformatrc section reaches the bag for the Prettier options, namespaced or not', () => {
      write({ '.soukformatrc': '{"typescriptreact": {"singleAttributePerLine": true, "prettier.objectWrap": "collapse"}}' });
      const r = resolve('typescriptreact', 'a.tsx');
      assert.equal(prettierBag(r).singleAttributePerLine, true);
      assert.equal(prettierBag(r).objectWrap, 'collapse');
    });

    it('a .prettierrc beats the VS Code setting for both Prettier options', () => {
      tidy({
        'prettier.singleAttributePerLine': { globalValue: false },
        'prettier.objectWrap': { globalValue: 'preserve' }
      });
      write({ '.prettierrc': 'singleAttributePerLine: true\nobjectWrap: collapse\n' });
      const r = resolve('typescriptreact', 'a.tsx');
      assert.equal(prettierBag(r).singleAttributePerLine, true);
      assert.equal(prettierBag(r).objectWrap, 'collapse');
      assert.equal(r.sources['prettier.objectWrap'], '.prettierrc');
    });

    it('a .prettierrc is ignored in Restricted Mode', () => {
      state.trusted = false;
      write({ '.prettierrc': 'singleAttributePerLine: true\nobjectWrap: collapse\n' });
      const r = resolve('typescriptreact', 'a.tsx');
      assert.equal(prettierBag(r).singleAttributePerLine, undefined);
      assert.equal(prettierBag(r).objectWrap, undefined);
    });
  });

  describe('invalid values', () => {
    it('a list of the wrong shape is refused whole; a list with a bad tag name is not (the engine drops the entry)', () => {
      tidy({ content_unformatted: { globalValue: 'code' }, void_elements: { globalValue: ['ok', 5] } });
      const refused = resolve('html', 'a.html');
      assert.equal(refused.engineOptions.content_unformatted, undefined);
      assert.equal(refused.engineOptions.void_elements, undefined);
      tidy({ content_unformatted: { globalValue: ['a b', 'code'] } });
      assert.deepEqual(resolve('html', 'a.html').engineOptions.content_unformatted, ['a b', 'code']);
    });

    it('a value outside the enum or of the wrong type is refused', () => {
      tidy({
        'prettier.objectWrap': { globalValue: 'wrap' },
        'prettier.singleAttributePerLine': { globalValue: 'yes' }
      });
      const r = resolve('typescriptreact', 'a.tsx');
      assert.equal(prettierBag(r).objectWrap, undefined);
      assert.equal(prettierBag(r).singleAttributePerLine, undefined);
    });
  });

  describe('end to end: the resolved bag drives the real engine', () => {
    const HTML = '<div><pre>  a   b</pre><code>a    b\n   c</code><my-icon><p>x</p></div>\n';

    function format(lang: LangId, relPath: string, code: string): Promise<string> {
      const r = resolve(lang, relPath, code);
      return dispatchFormat({ languageId: lang, code, options: r });
    }

    it('content_unformatted keeps an added tag verbatim, and the built-in <pre> with it', async () => {
      const base = await format('html', 'a.html', HTML);
      tidy({ content_unformatted: { globalValue: ['code'] } });
      const out = await format('html', 'a.html', HTML);
      assert.notEqual(out, base);
      assert.ok(out.includes('<code>a    b\n   c</code>'));
      assert.ok(out.includes('<pre>  a   b</pre>'));
    });

    it('a list full of bad entries formats the same as its one good entry, and never throws', async () => {
      tidy({ content_unformatted: { globalValue: ['code'] } });
      const good = await format('html', 'a.html', HTML);
      tidy({ content_unformatted: { globalValue: ['a b', '(', '<x>', 'code', '', 'x+', '1a'] } });
      assert.equal(await format('html', 'a.html', HTML), good);
    });

    it('void_elements lets a custom element go unclosed without indenting its sibling', async () => {
      const base = await format('html', 'a.html', HTML);
      tidy({ void_elements: { globalValue: ['my-icon'] } });
      const out = await format('html', 'a.html', HTML);
      assert.notEqual(out, base);
      assert.match(out, /^ {2}<p>x<\/p>$/m);
    });

    it('a .prettierrc governs the printed TSX', async () => {
      const tsx = 'const a = <Foo a="1" b="2" c="3" />;\nconst o = {\n  b: 1, c: 2 };\n';
      const base = await format('typescriptreact', 'a.tsx', tsx);
      write({ '.prettierrc': 'singleAttributePerLine: true\nobjectWrap: collapse\n' });
      const out = await format('typescriptreact', 'a.tsx', tsx);
      assert.notEqual(out, base);
      assert.match(out, /^ {4}a="1"$/m);
      assert.match(out, /^const o = \{ b: 1, c: 2 \};$/m);
    });

    it('with none of the six set, the printed output is what it was before they existed', async () => {
      const cases: ReadonlyArray<readonly [LangId, string, string]> = [
        ['html', 'a.html', HTML],
        ['javascript', 'a.js', 'if (a) { b() }\nvar f = function() { return 1 };\nswitch (x) { case 1: y(); }\n'],
        ['typescriptreact', 'a.tsx', 'const a = <Foo a="1" b="2" c="3" />;\nconst o = {\n  b: 1, c: 2 };\n']
      ];
      for (const [lang, file, code] of cases) {
        const fromSettings = await format(lang, file, code);
        const bare = await dispatchFormat({
          languageId: lang,
          code,
          options: { tabSize: 2, insertSpaces: true, engineOptions: {}, sources: {} }
        });
        assert.equal(fromSettings, bare, `${lang}: an unset option must add nothing to the bag`);
      }
    });
  });
});
