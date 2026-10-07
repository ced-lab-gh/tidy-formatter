// "Tidy: Who Formats This File?" : the HOST half, against a faithful recording
// stand-in for `vscode` (whoFormatsFakeHost.ts, modelled on host probes P4 and P15).
//
// The command runs for real: the real `collectWhoFormatsFacts`, the real shared
// detectors it must REUSE (`isLonefyPresentIn`, `scanCompetingFormatters`, which
// `require('vscode')` themselves, hence the loader hook below) and the real
// `whoFormats` handler writing to the real `getTidyOutputChannel` helper.
//
// The hook is installed in before() and removed, with every module it pulled in, in
// after(), so nothing leaks into the rest of the suite (the idiom of
// test/unit/deference/hostBehaviour.test.ts).
import assert from 'node:assert/strict';
import Module from 'node:module';
import {
  DIRECTORY,
  makeFakeHost,
  type FakeHost,
  type FakeHostOptions,
  type ScopeValues
} from './whoFormatsFakeHost';
import { collectWhoFormatsFacts, whoFormats } from '../../../src/commands/whoFormats';
import { buildWhoFormatsReport, type WhoFormatsFacts } from '../../../src/commands/whoFormatsReport';
import { resolveScalarSource } from '../../../src/commands/whoFormatsScopes';

type LoadFn = (request: string, parent: unknown, isMain: boolean) => unknown;

const NOW = '2026-09-30T10:00:00.000Z';
const PRETTIER = 'esbenp.prettier-vscode';
const TIDY = 'ced-lab.tidy-formatter';
const INCUMBENT = 'lonefy.vscode-JS-CSS-HTML-formatter';

const fmt = (id: string): ScopeValues => ({ plain: { 'editor.defaultFormatter': id } });
const fmtLang = (lang: string, id: string): ScopeValues => ({
  languages: { [lang]: { 'editor.defaultFormatter': id } }
});
/** A multi-root workspace: a .code-workspace file, so the folder settings are their own scope. */
const MULTI_ROOT: FakeHostOptions = { workspaceFile: '/ws.code-workspace' };

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe('whoFormats : in a faithful recording host', () => {
  const loader = Module as unknown as { _load: LoadFn };
  let originalLoad: LoadFn;
  let cachedBefore: Set<string>;
  let current: FakeHost | undefined;
  let hosts: FakeHost[] = [];

  /** A fresh fake host, installed as THE `vscode` and remembered for the end-of-test checks. */
  function newHost(options: FakeHostOptions): FakeHost {
    // The shared channel helper caches the channel of the first `vscode` it sees: load it afresh.
    for (const key of Object.keys(require.cache)) {
      if (key.endsWith('outputChannel.ts') || key.endsWith('outputChannel.js')) {
        delete require.cache[key];
      }
    }
    const host = makeFakeHost(options);
    hosts = [...hosts, host];
    current = host;
    return host;
  }

  before(() => {
    originalLoad = loader._load;
    cachedBefore = new Set(Object.keys(require.cache));
    loader._load = function patchedLoad(this: unknown, request: string, parent: unknown, isMain: boolean): unknown {
      if (request === 'vscode') {
        if (!current) {
          throw new Error('no fake host installed');
        }
        return current.vscode;
      }
      return originalLoad.call(this, request, parent, isMain);
    };
  });

  after(() => {
    loader._load = originalLoad;
    for (const key of Object.keys(require.cache)) {
      if (!cachedBefore.has(key)) {
        delete require.cache[key];
      }
    }
  });

  afterEach(() => {
    for (const host of hosts) {
      assert.deepEqual(host.recorded.unexpected, [], 'the command used an API the stub does not model');
      assert.deepEqual(host.recorded.writes, [], 'the command must never write');
    }
    hosts = [];
    current = undefined;
  });

  async function gather(options: FakeHostOptions = {}): Promise<{ host: FakeHost; facts: WhoFormatsFacts; text: string }> {
    const host = newHost(options);
    assert.ok(host.document, 'these scenarios need an active document');
    const facts = { ...(await collectWhoFormatsFacts(host.vscode, host.document)), now: NOW };
    return { host, facts, text: buildWhoFormatsReport(facts).lines.join('\n') };
  }

  /* ---------------------------------------------------------------------- */
  describe('spec 1: editor.defaultFormatter and the scope that set it', () => {
    // One scope at a time, the others left at their defaults.
    const SCOPES: ReadonlyArray<readonly [string, FakeHostOptions, string]> = [
      ['extension default, plain', { defaults: fmt('a.default') }, 'default (VS Code or an extension)'],
      ['extension default, [css] block', { defaults: fmtLang('css', 'a.default') }, 'default ([css] block, from VS Code or an extension)'],
      ['User settings', { user: fmt('a.default') }, 'User settings'],
      ['User settings, [css] block', { user: fmtLang('css', 'a.default') }, 'User settings ([css] block)'],
      ['Workspace settings', { workspace: fmt('a.default') }, 'Workspace settings'],
      ['Workspace settings, [css] block', { workspace: fmtLang('css', 'a.default') }, 'Workspace settings ([css] block)'],
      // The folder scope exists only in a multi-root workspace (a .code-workspace file).
      ['Workspace Folder settings', { ...MULTI_ROOT, folder: fmt('a.default') }, 'Workspace Folder settings'],
      ['Workspace Folder settings, [css] block', { ...MULTI_ROOT, folder: fmtLang('css', 'a.default') }, 'Workspace Folder settings ([css] block)']
    ];

    for (const [name, options, label] of SCOPES) {
      it(`names ${name}`, async () => {
        const { facts, text } = await gather({ ...options, extensions: { 'a.default': {} } });
        assert.equal(facts.defaultFormatter.state === 'read' && facts.defaultFormatter.effective, 'a.default');
        assert.match(text, /editor\.defaultFormatter = "a\.default"/);
        assert.ok(text.includes(`set by: ${label}\n`), `expected "set by: ${label}" in:\n${text}`);
      });
    }

    it('nothing set anywhere: null, "no scope sets it", and VS Code chooses at format time', async () => {
      const { text } = await gather();
      assert.match(text, /editor\.defaultFormatter = null \(no default formatter\)\n {5}set by: no scope sets it/);
      assert.match(text, /VS Code chooses at format time/);
    });

    it('a language-specific default formatter: the css file sees the [css] value, not the [html] one', async () => {
      const { text } = await gather({
        workspace: { languages: { css: { 'editor.defaultFormatter': PRETTIER }, html: { 'editor.defaultFormatter': TIDY } } },
        extensions: { [PRETTIER]: { displayName: 'Prettier - Code formatter' }, [TIDY]: {} }
      });
      assert.match(text, /1\. Default formatter for css/);
      assert.match(text, /editor\.defaultFormatter = "esbenp\.prettier-vscode"/);
      assert.match(text, /set by: Workspace settings \(\[css\] block\)/);
      assert.doesNotMatch(text, /ced-lab\.tidy-formatter/);
    });

    it('the same file seen as html picks the [html] block', async () => {
      const { text } = await gather({
        document: { path: '/ws/index.html', languageId: 'html' },
        workspace: { languages: { css: { 'editor.defaultFormatter': PRETTIER }, html: { 'editor.defaultFormatter': TIDY } } },
        extensions: { [PRETTIER]: {}, [TIDY]: {} }
      });
      assert.match(text, /1\. Default formatter for html/);
      assert.match(text, /editor\.defaultFormatter = "ced-lab\.tidy-formatter"/);
      assert.match(text, /set by: Workspace settings \(\[html\] block\)/);
    });

    it('a [css] block in User settings beats a plain Workspace value, and the overridden one is listed', async () => {
      const { text } = await gather({
        user: fmtLang('css', 'user.css'),
        workspace: fmt('ws.plain'),
        extensions: { 'user.css': {}, 'ws.plain': {} }
      });
      assert.match(text, /editor\.defaultFormatter = "user\.css"\n {5}set by: User settings \(\[css\] block\)/);
      assert.match(text, /also set: Workspace settings = "ws\.plain" \(not in effect\)/);
    });

    it('the folder scope applies only to a document inside the first folder (multi-root)', async () => {
      const inside = await gather({ ...MULTI_ROOT, folder: fmt('folder.fmt'), extensions: { 'folder.fmt': {} } });
      assert.match(inside.text, /set by: Workspace Folder settings\n/);
      const outside = await gather({
        ...MULTI_ROOT,
        folder: fmt('folder.fmt'),
        document: { path: '/elsewhere/app.css', languageId: 'css' }
      });
      assert.match(outside.text, /editor\.defaultFormatter = null/);
    });
  });

  /* ---------------------------------------------------------------------- */
  describe('workspace kinds: one folder, a multi-root workspace, none', () => {
    it('ONE folder: its settings file is the Workspace scope, listed ONCE (the real host mirrors it under two fields)', async () => {
      const { facts, text } = await gather({
        workspace: { plain: { 'editor.defaultFormatter': 'plain.fmt' }, languages: { css: { 'editor.defaultFormatter': 'css.fmt' } } },
        extensions: { 'css.fmt': {}, 'plain.fmt': {} }
      });
      assert.equal(facts.workspaceKind, 'folder');
      assert.ok(text.includes('Workspace: one folder is open. Its .vscode/settings.json is the "Workspace settings" scope.'));
      assert.ok(text.includes('editor.defaultFormatter = "css.fmt"\n     set by: Workspace settings ([css] block)\n'), text);
      assert.ok(text.includes('also set: Workspace settings = "plain.fmt" (not in effect)'), text);
      assert.doesNotMatch(text, /Workspace Folder settings/);
      assert.doesNotMatch(text, /\(same value\)/, 'one file is never listed as two scopes');
    });

    it('a multi-root workspace keeps the workspace file and the folder settings apart', async () => {
      const { facts, text } = await gather({
        ...MULTI_ROOT,
        workspace: fmt('ws.fmt'),
        folder: fmt('folder.fmt'),
        extensions: { 'ws.fmt': {}, 'folder.fmt': {} }
      });
      assert.equal(facts.workspaceKind, 'multi-root');
      assert.ok(text.includes('editor.defaultFormatter = "folder.fmt"\n     set by: Workspace Folder settings\n'), text);
      assert.ok(text.includes('also set: Workspace settings = "ws.fmt" (not in effect)'), text);
      assert.match(text, /Workspace: a multi-root workspace is open\./);
    });

    it('two folders are multi-root even without a workspace file; one folder plus a workspace file too', async () => {
      assert.equal((await gather({ folders: ['/ws', '/other'] })).facts.workspaceKind, 'multi-root');
      assert.equal((await gather({ workspaceFile: '/w.code-workspace' })).facts.workspaceKind, 'multi-root');
      assert.equal((await gather({})).facts.workspaceKind, 'folder');
      assert.equal((await gather({ folders: [] })).facts.workspaceKind, 'none');
    });
  });

  /* ---------------------------------------------------------------------- */
  describe('spec 2: is that formatter installed and enabled, and is it Tidy', () => {
    it('installed and enabled, with its display name', async () => {
      const { facts, text } = await gather({
        workspace: fmt(PRETTIER),
        extensions: { [PRETTIER]: { displayName: 'Prettier - Code formatter' } }
      });
      assert.deepEqual(facts.formatterExtension, {
        state: 'found',
        id: PRETTIER,
        isTidy: false,
        displayName: 'Prettier - Code formatter'
      });
      assert.match(text, /Extension: Prettier - Code formatter \(esbenp\.prettier-vscode\) is installed and enabled\. It is not Tidy\./);
    });

    it('an id typed in another case still finds the extension (the API is case-insensitive)', async () => {
      const { facts } = await gather({ workspace: fmt('ESBENP.Prettier-VSCode'), extensions: { [PRETTIER]: {} } });
      assert.equal(facts.formatterExtension.state, 'found');
    });

    it('an unlocalised "%placeholder%" display name is not used as a name', async () => {
      const { facts, text } = await gather({ workspace: fmt(PRETTIER), extensions: { [PRETTIER]: { displayName: '%extension.name%' } } });
      assert.equal(facts.formatterExtension.state === 'found' && facts.formatterExtension.displayName, undefined);
      assert.match(text, /Extension: esbenp\.prettier-vscode is installed and enabled\./);
    });

    it('Tidy itself is recognised', async () => {
      const { facts, text } = await gather({ workspace: fmt(TIDY), extensions: { [TIDY]: { displayName: 'Tidy HTML Formatter' } } });
      assert.equal(facts.formatterExtension.state === 'found' && facts.formatterExtension.isTidy, true);
      assert.match(text, /is installed and enabled\. That is Tidy\./);
    });

    it('not installed, or disabled (the same thing to the API): "not visible", never "not installed"', async () => {
      const { facts, text } = await gather({ workspace: fmt('gone.formatter') });
      assert.deepEqual(facts.formatterExtension, { state: 'not-visible', id: 'gone.formatter', isTidy: false });
      assert.match(text, /gone\.formatter is not visible to VS Code's extension API\. It is not installed, or it is installed but disabled/);
      assert.doesNotMatch(text, /is not installed\./);
    });

    it('a formatter whose extension lookup throws is reported as unknown, not as missing', async () => {
      const { facts, text } = await gather({ workspace: fmt(PRETTIER), extensionsThrow: true });
      assert.equal(facts.formatterExtension.state, 'unknown');
      assert.match(text, /could not be checked \(simulated extensions failure\)\./);
    });

    it('a value that is not a string names no extension', async () => {
      const { facts } = await gather({ workspace: { plain: { 'editor.defaultFormatter': 42 } } });
      assert.deepEqual(facts.formatterExtension, { state: 'invalid-id', rendered: '42' });
    });
  });

  /* ---------------------------------------------------------------------- */
  describe('spec 3: format on save, its mode and the code actions, each with a scope', () => {
    it('reads all three for the file language, with their scopes', async () => {
      const { facts, text } = await gather({
        user: { plain: { 'editor.formatOnSave': true, 'editor.codeActionsOnSave': { 'source.fixAll.eslint': 'explicit' } } },
        workspace: { languages: { css: { 'editor.formatOnSaveMode': 'modifications', 'editor.codeActionsOnSave': { 'source.organizeImports': 'always' } } } }
      });
      assert.equal(facts.formatOnSave.state === 'read' && facts.formatOnSave.effective, true);
      assert.match(text, /editor\.formatOnSave = true\n {5}set by: User settings/);
      assert.match(text, /editor\.formatOnSaveMode = "modifications" \(only the modified lines/);
      assert.match(text, /set by: Workspace settings \(\[css\] block\)/);
      // codeActionsOnSave merges KEY BY KEY across scopes; each key keeps its own scope.
      assert.match(text, /source\.fixAll\.eslint = "explicit" \(set by: User settings\)/);
      assert.match(text, /source\.organizeImports = "always" \(set by: Workspace settings \(\[css\] block\)\)/);
    });

    it('a language-specific format-on-save override wins over the User value', async () => {
      const { text } = await gather({
        user: { plain: { 'editor.formatOnSave': true } },
        workspace: { languages: { css: { 'editor.formatOnSave': false } } }
      });
      assert.match(text, /editor\.formatOnSave = false\n {5}set by: Workspace settings \(\[css\] block\)/);
      assert.match(text, /format on save is OFF for this file/);
      assert.match(text, /also set: User settings = true \(not in effect\)/);
    });

    it('in a multi-root workspace the same override can come from the folder settings', async () => {
      const { text } = await gather({
        ...MULTI_ROOT,
        user: { plain: { 'editor.formatOnSave': true } },
        folder: { languages: { css: { 'editor.formatOnSave': false } } }
      });
      assert.match(text, /editor\.formatOnSave = false\n {5}set by: Workspace Folder settings \(\[css\] block\)/);
    });

    it('the save-time edits of VS Code core are read through the files section', async () => {
      const { text } = await gather({ user: { plain: { 'files.trimTrailingWhitespace': true } } });
      assert.match(text, /files\.trimTrailingWhitespace = true \(set by: User settings\)/);
    });

    it('a setting that throws is reported unreadable while the others are still read', async () => {
      const { facts, text } = await gather({ user: { plain: { 'editor.formatOnSave': true } }, getThrows: ['formatOnSaveMode'] });
      assert.equal(facts.formatOnSaveMode.state, 'unreadable');
      assert.equal(facts.formatOnSave.state, 'read');
      assert.match(text, /editor\.formatOnSaveMode could not be read \(simulated get failure for formatOnSaveMode\)\./);
      assert.match(text, /editor\.formatOnSave = true/);
    });
  });

  /* ---------------------------------------------------------------------- */
  describe('spec 4: the incumbent, and its config file', () => {
    it('installed and enabled, config file present', async () => {
      const { facts, host, text } = await gather({
        extensions: { [INCUMBENT]: {} },
        files: { '/ws/.vscode/formatter.json': '{}' }
      });
      assert.equal(facts.incumbentVisible, true);
      assert.deepEqual(facts.incumbentConfig, { state: 'found' });
      assert.match(text, /Extension: installed and enabled\./);
      assert.match(text, /formatter\.json in the first workspace folder: found\./);
      assert.match(text, /known example of an extension that formats on save through its own save hook/);
      assert.ok(host.recorded.fsReads.includes('stat /ws/.vscode/formatter.json'));
    });

    it('DISABLED (invisible to the API) but .vscode/formatter.json present: the file is the only trace', async () => {
      const { facts, host, text } = await gather({ files: { '/ws/.vscode/formatter.json': '{"onSave":true}' } });
      assert.equal(facts.incumbentVisible, false);
      assert.deepEqual(facts.incumbentConfig, { state: 'found' });
      assert.match(text, /not installed, or it is installed but disabled \(the API cannot tell these apart\)/);
      assert.match(text, /formatter\.json in the first workspace folder: found\./);
      assert.match(text, /If it is installed but disabled, it formats nothing\./);
      // The config file is only stat'ed: its CONTENT is never read.
      assert.ok(host.recorded.fsReads.includes('stat /ws/.vscode/formatter.json'));
      assert.ok(!host.recorded.fsReads.includes('read /ws/.vscode/formatter.json'), host.recorded.fsReads.join(', '));
    });

    it('neither the extension nor the file: nothing points to it', async () => {
      const { facts, text } = await gather();
      assert.equal(facts.incumbentVisible, false);
      assert.deepEqual(facts.incumbentConfig, { state: 'absent' });
      assert.match(text, /Nothing points to it/);
    });

    it('a formatter.json that is a folder is not called a file', async () => {
      const { facts } = await gather({ files: { '/ws/.vscode/formatter.json': DIRECTORY } });
      assert.deepEqual(facts.incumbentConfig, { state: 'not-a-file' });
    });

    it('checks the FIRST folder only, which is the only one the incumbent reads', async () => {
      const { facts } = await gather({
        folders: ['/a', '/b'],
        document: { path: '/b/app.css', languageId: 'css' },
        files: { '/b/.vscode/formatter.json': '{}' }
      });
      assert.deepEqual(facts.incumbentConfig, { state: 'absent' });
    });
  });

  /* ---------------------------------------------------------------------- */
  describe('spec 5: other formatters configured in the workspace', () => {
    it('reuses the unconditional scan: config files and a package.json key', async () => {
      const { facts, text } = await gather({
        files: {
          '/ws/.prettierrc': '{}',
          '/ws/eslint.config.js': '',
          '/ws/package.json': JSON.stringify({ name: 'x', prettier: {} }),
          '/ws/readme.md': ''
        }
      });
      assert.deepEqual(facts.competing, { state: 'scanned', names: ['Prettier', 'ESLint'] });
      assert.match(text, /Prettier, ESLint \(found through config files at the workspace root\)\./);
    });

    it('none detected is stated as such', async () => {
      const { facts } = await gather({ files: { '/ws/readme.md': '' } });
      assert.deepEqual(facts.competing, { state: 'scanned', names: [] });
    });

    it('does not defer to tidy.deferToOtherFormatters (it is the unconditional scan)', async () => {
      // The fake answers no configuration for tidy.*; an "off" setting must not matter either way.
      const { facts } = await gather({
        user: { plain: { 'tidy.deferToOtherFormatters': 'off' } },
        files: { '/ws/biome.json': '{}' }
      });
      assert.deepEqual(facts.competing, { state: 'scanned', names: ['Biome'] });
    });
  });

  /* ---------------------------------------------------------------------- */
  describe('no workspace folder, and Restricted Mode', () => {
    it('no folder: only User and default scopes apply, nothing is read, nothing is scanned', async () => {
      const { facts, host, text } = await gather({
        folders: [],
        document: { path: '/loose/app.css', languageId: 'css' },
        user: fmt('user.fmt'),
        workspace: fmt('ignored.ws'),
        folder: fmt('ignored.folder'),
        extensions: { 'user.fmt': {} }
      });
      assert.equal(facts.workspaceKind, 'none');
      assert.match(text, /Workspace: no folder is open, so only User settings and defaults can apply\./);
      assert.match(text, /editor\.defaultFormatter = "user\.fmt"\n {5}set by: User settings\n/);
      assert.doesNotMatch(text, /ignored\./);
      assert.deepEqual(facts.incumbentConfig, { state: 'not-checked', reason: 'no-folder' });
      assert.deepEqual(facts.competing, { state: 'not-scanned', reason: 'no-folder' });
      assert.match(text, /not checked: no folder is open\./);
      assert.match(text, /Not scanned: no folder is open\./);
      assert.deepEqual(host.recorded.fsReads, []);
    });

    it('Restricted Mode: workspace files are not read, and the report says so instead of "none"', async () => {
      const { facts, host, text } = await gather({
        trusted: false,
        files: { '/ws/.vscode/formatter.json': '{}', '/ws/.prettierrc': '{}' }
      });
      assert.deepEqual(facts.incumbentConfig, { state: 'not-checked', reason: 'restricted' });
      assert.deepEqual(facts.competing, { state: 'not-scanned', reason: 'restricted' });
      assert.match(text, /Restricted Mode \(Workspace Trust\) blocks reading workspace files\./);
      assert.doesNotMatch(text, /None detected/);
      assert.deepEqual(host.recorded.fsReads, []);
    });
  });

  /* ---------------------------------------------------------------------- */
  describe('older or failing hosts: degrade, and say what could not be determined', () => {
    const CSS_WORKSPACE: FakeHostOptions = { workspace: fmtLang('css', PRETTIER), extensions: { [PRETTIER]: {} } };

    it('no language-specific fields (a host that predates them): the value is known, the scope is not', async () => {
      const { facts, text } = await gather({ ...CSS_WORKSPACE, inspect: 'no-language-fields' });
      assert.equal(facts.defaultFormatter.state === 'read' && facts.defaultFormatter.effective, PRETTIER);
      assert.match(text, /editor\.defaultFormatter = "esbenp\.prettier-vscode"/);
      assert.match(text, /set by: could not be determined \(the effective value matches none of the scopes VS Code reported\)\./);
      assert.doesNotMatch(text, /set by: Workspace settings/);
    });

    it('no inspect at all: same, with its own reason', async () => {
      const { text } = await gather({ ...CSS_WORKSPACE, inspect: 'absent' });
      assert.match(text, /set by: could not be determined \(this VS Code did not return per-scope details\)\./);
    });

    it('inspect throws: the effective value survives, the scope is undetermined', async () => {
      const { facts, text } = await gather({ ...CSS_WORKSPACE, inspect: 'throws' });
      assert.equal(facts.defaultFormatter.state, 'read');
      assert.match(text, /could not be determined \(this VS Code did not return per-scope details\)/);
    });

    it('a value found at several scopes of a host that orders them differently is not attributed', () => {
      assert.equal(
        resolveScalarSource('v', { globalLanguageValue: 'other', workspaceValue: 'v', globalValue: 'v' }, 'css').kind,
        'undetermined'
      );
    });
  });

  /* ---------------------------------------------------------------------- */
  describe('the scenario OBSERVED in real VS Code 1.126.0 and 1.137.0 (host probe, 30/09/2026)', () => {
    // Real host, same facts in both versions: a User [css] block beat a Workspace plain
    // value for editor.defaultFormatter, and an extension's [css] configurationDefaults
    // beat a User plain value for editor.formatOnSaveMode. The stub must say the same.
    it('reports what the real host resolved, with the same scopes', async () => {
      const { text } = await gather({
        user: {
          plain: { 'editor.formatOnSaveMode': 'modifications', 'files.trimTrailingWhitespace': true },
          languages: { css: { 'editor.defaultFormatter': 'user.css.fmt' } }
        },
        workspace: {
          plain: {
            'editor.defaultFormatter': 'ws.plain.fmt',
            'editor.formatOnSave': true,
            'editor.codeActionsOnSave': { 'source.fixAll.eslint': 'explicit' }
          }
        },
        defaults: { languages: { css: { 'editor.formatOnSaveMode': 'modificationsIfAvailable' } } }
      });
      for (const expected of [
        'editor.defaultFormatter = "user.css.fmt"\n     set by: User settings ([css] block)\n     also set: Workspace settings = "ws.plain.fmt" (not in effect)',
        'editor.formatOnSave = true\n     set by: Workspace settings\n',
        'editor.formatOnSaveMode = "modificationsIfAvailable" (only the modified lines when source control is available, else the whole file)\n' +
          '     set by: default ([css] block, from VS Code or an extension)\n' +
          '     also set: User settings = "modifications" (not in effect)',
        'source.fixAll.eslint = "explicit" (set by: Workspace settings)',
        'files.trimTrailingWhitespace = true (set by: User settings)'
      ]) {
        assert.ok(text.includes(expected), `missing:\n${expected}\nin:\n${text}`);
      }
    });
  });

  /* ---------------------------------------------------------------------- */
  describe('the handler', () => {
    async function run(options: FakeHostOptions = {}): Promise<FakeHost> {
      const host = newHost(options);
      await whoFormats();
      await flush();
      return host;
    }

    it('appends the report to the shared channel, reveals it without stealing focus, never clears it', async () => {
      const host = await run({ workspace: fmt(PRETTIER), extensions: { [PRETTIER]: {} } });
      const out = host.recorded.output;
      assert.equal(out[0], '', 'separated from what the channel already holds');
      assert.match(out[1], /^=== Who formats this file\? @ \d{4}-\d\d-\d\dT/);
      assert.ok(out.includes('File: app.css (css)'));
      assert.ok(out.includes('5. What this report cannot see'));
      assert.deepEqual(host.recorded.outputShown, [true]);
      assert.equal(host.recorded.outputCleared, 0, 'the channel also holds the format trace: never cleared');
    });

    it('shows the one-sentence answer with the buttons that only open something', async () => {
      const host = await run({ workspace: fmt(PRETTIER), extensions: { [INCUMBENT]: {}, [PRETTIER]: {} } });
      assert.equal(host.recorded.shown.length, 1);
      const [toast] = host.recorded.shown;
      assert.equal(toast.kind, 'info');
      assert.match(toast.message, /^Who formats app\.css\? Default formatter: esbenp\.prettier-vscode, set by Workspace settings\. Format on save: off\./);
      assert.deepEqual(toast.buttons, [
        'Open Default Formatter Setting',
        'Open Format on Save Settings',
        'Find JS-CSS-HTML Formatter',
        'Find Default Formatter Extension'
      ]);
    });

    it('resolves at once and runs nothing until a button is clicked', async () => {
      const host = await run({ workspace: fmt(PRETTIER) });
      assert.deepEqual(host.recorded.executed, []);
    });

    it('a click runs the matching open command with its plain-string argument', async () => {
      const host = await run({
        extensions: { [INCUMBENT]: {} },
        pick: (_message, buttons) => buttons.find((b) => b === 'Open Format on Save Settings')
      });
      assert.deepEqual(host.recorded.executed, [
        { command: 'workbench.action.openSettings', args: ['@lang:css editor.formatOnSave'] }
      ]);
    });

    it('every button, clicked in turn, runs only an open command', async () => {
      const labels = [
        'Open Default Formatter Setting',
        'Open Format on Save Settings',
        'Find JS-CSS-HTML Formatter',
        'Find Default Formatter Extension'
      ];
      const executed: string[] = [];
      for (const label of labels) {
        const host = await run({
          workspace: fmt(PRETTIER),
          extensions: { [INCUMBENT]: {}, [PRETTIER]: {} },
          pick: (_message, buttons) => buttons.find((b) => b === label)
        });
        assert.equal(host.recorded.executed.length, 1, label);
        executed.push(host.recorded.executed[0].command);
        assert.deepEqual(host.recorded.writes, []);
      }
      assert.deepEqual(executed, [
        'workbench.action.openSettings',
        'workbench.action.openSettings',
        'workbench.extensions.search',
        'workbench.extensions.search'
      ]);
    });

    it('dismissing the toast does nothing', async () => {
      const host = await run({ pick: () => undefined });
      assert.deepEqual(host.recorded.executed, []);
    });

    it('no active editor: one information message, no report', async () => {
      const host = await run({ document: null });
      assert.deepEqual(host.recorded.shown.map((s) => s.message), ['Tidy: open a file to see who formats it.']);
      assert.deepEqual(host.recorded.output, []);
    });

    it('the active editor is an Output panel: it says how to get a useful answer, and reports nothing', async () => {
      const host = await run({ document: { path: '/out/Tidy Formatter', languageId: 'log', scheme: 'output' } });
      assert.match(host.recorded.shown[0].message, /the active editor is an Output panel\. Click inside the file you want to check/);
      assert.deepEqual(host.recorded.output, []);
    });

    it('a failure becomes one warning carrying a sanitised cause, never a thrown error', async () => {
      const host = await run({ activeEditorThrows: true });
      assert.equal(host.recorded.shown.length, 1);
      assert.equal(host.recorded.shown[0].kind, 'warning');
      assert.match(host.recorded.shown[0].message, /^Tidy: could not work out who formats this file \(simulated editor failure\)\.$/);
    });

    it('reports the base name only, for a file deep in the tree and for an untitled one', async () => {
      const deep = await run({ document: { path: '/ws/very/deep/dir/app.css', languageId: 'css' } });
      assert.ok(deep.recorded.output.includes('File: app.css (css)'));
      const untitled = await run({ document: { path: 'Untitled-1', languageId: 'css', scheme: 'untitled' } });
      assert.ok(untitled.recorded.output.includes('File: Untitled-1 (css)'));
      assert.ok(!untitled.recorded.output.join('\n').includes('/ws/'));
    });
  });
});
