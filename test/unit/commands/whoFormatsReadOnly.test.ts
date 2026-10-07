// "Tidy: Who Formats This File?" must NEVER change anything. This is the
// anti-hijack contract of the product (ARCH-01/02): a command that explains writes no
// setting, writes no file, opens no connection and sends nothing.
//
// Three independent locks, so that no single edit can remove the guarantee quietly:
//   1. STATIC: neither whoFormats.ts nor any module it can reach contains a
//      configuration update, a file write, an edit/save, a network API, an event
//      hook, persistent state or telemetry. The import allowlist pins the graph.
//   2. BEHAVIOURAL: the real command runs across every scenario against a recording
//      `vscode` (any write is recorded and refused) while Node's network, process
//      and file-write APIs are replaced by tripwires. Nothing may trip.
//   3. THE DETECTORS THEMSELVES: each lock is shown to FAIL on a violating input, so
//      a test that can no longer fail cannot pass for the guarantee.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import Module from 'node:module';
import * as path from 'node:path';
import { EXTENSION_ID } from '../../../src/commands/setDefaultFormatter';
import { TIDY_EXTENSION_ID, whoFormats } from '../../../src/commands/whoFormats';
import { OPEN_ONLY_COMMAND_IDS } from '../../../src/commands/whoFormatsReport';
import { makeFakeHost, DIRECTORY, type FakeHost, type FakeHostOptions } from './whoFormatsFakeHost';

const ROOT = path.resolve(__dirname, '../../..');
const EM_DASH = String.fromCharCode(0x2014);
const SOURCE_FILE = 'src/commands/whoFormats.ts';
/** The three modules of the feature: the host command, the report, the scope model. */
const FEATURE_FILES: readonly string[] = [
  SOURCE_FILE,
  'src/commands/whoFormatsReport.ts',
  'src/commands/whoFormatsScopes.ts'
];

function read(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

/** Source without block and line comments, so prose never counts as code. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/* -------------------------------------------------------------------------- */
/* 1. STATIC                                                                   */
/* -------------------------------------------------------------------------- */

const FORBIDDEN: ReadonlyArray<readonly [string, RegExp]> = [
  ['a configuration update', /\.update\(/],
  [
    'a file write',
    /\b(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|createDirectory|mkdir|mkdirSync|rmSync|unlinkSync|renameSync|copyFileSync)\b/
  ],
  ['a delete, rename or copy', /\.(delete|rename|copy)\(/],
  ['an edit or a save', /\b(applyEdit|WorkspaceEdit|saveAll|showSaveDialog|showOpenDialog)\b/],
  ['a network API', /\b(fetch|XMLHttpRequest|WebSocket|EventSource|openExternal|asExternalUri)\b/],
  [
    'a network or process module',
    /(?:from|require\()\s*'(?:node:)?(?:https?|http2|net|tls|dns|dgram|child_process|worker_threads|cluster)'/
  ],
  ['a node fs import', /(?:from|require\()\s*'(?:node:)?fs(?:\/promises)?'/],
  ['an event hook', /\bon(?:Did|Will)[A-Z]\w*/],
  ['a file watcher', /\bcreateFileSystemWatcher\b/],
  ['persistent state', /\b(globalState|workspaceState|secrets)\b/],
  ['telemetry', /telemetry/i]
];

/** Names of every forbidden construct found in a piece of source (comments ignored). */
function findForbidden(source: string): string[] {
  const code = withoutComments(source);
  return FORBIDDEN.filter(([, pattern]) => pattern.test(code)).map(([name]) => name);
}

/** The relative modules a source file imports (static or lazy), as repo paths. */
function relativeImports(file: string): string[] {
  const code = withoutComments(read(file));
  const specifiers = [
    ...[...code.matchAll(/from\s+'(\.[^']+)'/g)].map((m) => m[1]),
    ...[...code.matchAll(/require\('(\.[^']+)'\)/g)].map((m) => m[1])
  ];
  return specifiers.map((spec) => path.posix.join(path.posix.dirname(file), `${spec}.ts`));
}

/** Every repo module reachable from `entry` through relative imports. */
function reachableModules(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file)) {
      continue;
    }
    seen.add(file);
    queue.push(...relativeImports(file));
  }
  return [...seen].sort();
}

describe('whoFormats is read-only : static locks', () => {
  const source = read(SOURCE_FILE);

  it('no module of the feature has a write, network, hook, state or telemetry construct', () => {
    for (const file of FEATURE_FILES) {
      assert.deepEqual(findForbidden(read(file)), [], file);
    }
  });

  it('nor does any module it can reach', () => {
    for (const file of reachableModules(SOURCE_FILE)) {
      assert.deepEqual(findForbidden(read(file)), [], `${file} carries a forbidden construct`);
    }
  });

  it('the host imports only its two siblings, the two shared detectors, the sanitiser, the lonefy constants and the channel helper', () => {
    // A new import is a new way to write or send: it must be a decision, made here.
    assert.deepEqual(relativeImports(SOURCE_FILE).sort(), [
      'src/commands/whoFormatsReport.ts',
      'src/commands/whoFormatsScopes.ts',
      'src/deference/detect.ts',
      'src/diagnostics/lastFormat.ts',
      'src/diagnostics/outputChannel.ts',
      'src/migration/detectLonefy.ts',
      'src/migration/lonefySources.ts'
    ]);
    // The two pure modules import no host API, no detector and nothing that can write.
    assert.deepEqual(relativeImports('src/commands/whoFormatsScopes.ts'), []);
    assert.deepEqual(relativeImports('src/commands/whoFormatsReport.ts').sort(), [
      'src/commands/whoFormatsScopes.ts',
      'src/migration/detectLonefy.ts',
      'src/migration/lonefySources.ts'
    ]);
    for (const file of FEATURE_FILES.slice(1)) {
      assert.doesNotMatch(withoutComments(read(file)), /require\(|from 'vscode'/, `${file} must stay pure`);
    }
    const code = withoutComments(source);
    const packages = [...code.matchAll(/(?:from\s+|require\()\s*'([^.'][^']*)'/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(packages)], ['vscode'], 'only the host API, required lazily');
  });

  it('REUSES the shared detectors instead of duplicating them', () => {
    assert.match(source, /import \{ isLonefyPresentIn \} from '\.\.\/migration\/detectLonefy';/);
    assert.match(source, /import \{ scanCompetingFormatters \} from '\.\.\/deference\/detect';/);
    assert.match(source, /isLonefyPresentIn\(vscode\)/);
    assert.match(source, /await scanCompetingFormatters\(\)/);
    for (const file of FEATURE_FILES) {
      assert.ok(!read(file).includes('getExtension(LONEFY_EXTENSION_ID)'), `${file}: lonefy presence has ONE implementation`);
    }
  });

  it('has exactly one executeCommand, behind the open-only allowlist', () => {
    const code = withoutComments(source);
    assert.equal((code.match(/executeCommand\(/g) ?? []).length, 1);
    assert.ok(
      code.indexOf('OPEN_ONLY_COMMAND_IDS.includes(action.commandId)') < code.indexOf('executeCommand('),
      'the allowlist check must come before the call'
    );
    assert.deepEqual(
      [...OPEN_ONLY_COMMAND_IDS].sort(),
      ['workbench.action.openSettings', 'workbench.extensions.search']
    );
  });

  it('takes the ONE string it shares with the product from the truth: Tidy\'s own extension id', () => {
    assert.equal(TIDY_EXTENSION_ID, EXTENSION_ID);
    const manifest = JSON.parse(read('package.json')) as { publisher: string; name: string };
    assert.equal(TIDY_EXTENSION_ID, `${manifest.publisher}.${manifest.name}`);
  });

  it('is registered by extension.ts, and only registered: no listener, no write at registration', () => {
    const extension = read('src/extension.ts');
    assert.match(extension, /from '\.\/commands\/whoFormats'/);
    assert.match(extension, /registerCommand\(WHO_FORMATS_COMMAND_ID, whoFormats\)/);
  });

  it('ships English only, and no U+2014, in every module of the feature', () => {
    for (const file of FEATURE_FILES) {
      assert.ok(!read(file).includes(EM_DASH), `${file} contains an em dash`);
      for (const token of ['aucun', 'aucune', 'fichier', 'ouvrez', 'cliquez', 'parametres', 'selectionne']) {
        assert.doesNotMatch(read(file), new RegExp(`\\b${token}\\b`, 'i'), `${file}: ${token}`);
      }
    }
  });

  it('never surfaces a raw error.message (the code-frame leak)', () => {
    for (const file of FEATURE_FILES) {
      read(file).split('\n').forEach((line, index) => {
        if (line.includes('error.message')) {
          assert.ok(line.includes('sanitizeDetail(error.message)'), `${file}:${index + 1}: ${line.trim()}`);
        }
      });
    }
  });

  it('every module of the feature stays under the 800-line file budget', () => {
    for (const file of FEATURE_FILES) {
      assert.ok(read(file).split('\n').length <= 800, `${file} is over 800 lines`);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 3a. The static detector can fail                                            */
/* -------------------------------------------------------------------------- */

describe('whoFormats is read-only : the static detector really detects', () => {
  const VIOLATIONS: ReadonlyArray<readonly [string, string, string]> = [
    ['a configuration update', "vscode.workspace.getConfiguration('editor').update('formatOnSave', true, 1);", 'a configuration update'],
    ['a workspace.fs write', 'await vscode.workspace.fs.writeFile(uri, bytes);', 'a file write'],
    ['a directory creation', 'await vscode.workspace.fs.createDirectory(uri);', 'a file write'],
    ['a delete', 'await vscode.workspace.fs.delete(uri);', 'a delete, rename or copy'],
    ['an applyEdit', 'await vscode.workspace.applyEdit(edit);', 'an edit or a save'],
    ['a fetch', "await fetch('https://example.com');", 'a network API'],
    ['openExternal', 'await vscode.env.openExternal(uri);', 'a network API'],
    ['an https import', "import * as https from 'node:https';", 'a network or process module'],
    ['a lazy net require', "const net = require('net');", 'a network or process module'],
    ['a node fs import', "import * as fs from 'node:fs';", 'a node fs import'],
    ['a save hook', 'vscode.workspace.onWillSaveTextDocument(() => undefined);', 'an event hook'],
    ['persistent state', 'context.globalState.get(key);', 'persistent state'],
    ['telemetry', 'sendTelemetryEvent("x");', 'telemetry']
  ];

  for (const [name, snippet, expected] of VIOLATIONS) {
    it(`flags ${name}`, () => {
      assert.ok(findForbidden(snippet).includes(expected), `${snippet} -> ${findForbidden(snippet).join(', ')}`);
    });
  }

  it('flags a violation appended to the REAL source, and ignores the same text in a comment', () => {
    const real = read(SOURCE_FILE);
    assert.deepEqual(findForbidden(real), []);
    assert.deepEqual(findForbidden(`${real}\nvscode.workspace.getConfiguration().update('a', 1);`), ['a configuration update']);
    assert.deepEqual(findForbidden(`${real}\n// vscode.workspace.getConfiguration().update('a', 1);`), []);
  });
});

/* -------------------------------------------------------------------------- */
/* 2. BEHAVIOURAL                                                              */
/* -------------------------------------------------------------------------- */

type Patchable = Record<string, unknown>;

// The REAL module objects, through require(): an `import * as` namespace is a copy made of
// getters, and patching a copy would leave the real API armed with nothing.
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */
const childProcess: Patchable = require('node:child_process');
const dns: Patchable = require('node:dns');
const realFs: Patchable = require('node:fs');
const http: Patchable = require('node:http');
const https: Patchable = require('node:https');
const net: Patchable = require('node:net');
const tls: Patchable = require('node:tls');
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */

/** Every Node API through which a command could reach the network, spawn a process or write a file. */
const TRIPWIRES: ReadonlyArray<readonly [string, Patchable, readonly string[]]> = [
  ['globalThis', globalThis as unknown as Patchable, ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest']],
  ['http', http, ['request', 'get']],
  ['https', https, ['request', 'get']],
  ['net', net, ['connect', 'createConnection']],
  ['tls', tls, ['connect']],
  ['dns', dns, ['lookup', 'resolve', 'resolve4', 'resolve6']],
  ['child_process', childProcess, ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']],
  [
    'fs',
    realFs,
    [
      'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'createWriteStream', 'mkdir', 'mkdirSync',
      'rm', 'rmSync', 'unlink', 'unlinkSync', 'rename', 'renameSync', 'copyFile', 'copyFileSync', 'truncate', 'truncateSync'
    ]
  ],
  ['fs.promises', realFs.promises as Patchable, ['writeFile', 'appendFile', 'mkdir', 'rm', 'unlink', 'rename', 'copyFile']]
];

/**
 * Run `body` with every tripwire armed, then disarm. A tripwire records the call and
 * throws, so a forbidden call can neither succeed nor be swallowed unseen.
 */
async function withTripwires<T>(body: () => Promise<T>): Promise<{ result: T; tripped: string[] }> {
  const tripped: string[] = [];
  const restores: Array<() => void> = [];
  for (const [owner, target, names] of TRIPWIRES) {
    for (const name of names) {
      if (!(name in target)) {
        continue;
      }
      const original = target[name];
      target[name] = function tripwire(): never {
        tripped.push(`${owner}.${name}`);
        throw new Error(`tripwire: ${owner}.${name} must never be called`);
      };
      restores.push(() => {
        target[name] = original;
      });
    }
  }
  try {
    return { result: await body(), tripped };
  } finally {
    for (const restore of restores.reverse()) {
      restore();
    }
  }
}

describe('whoFormats is read-only : behavioural locks', () => {
  type LoadFn = (request: string, parent: unknown, isMain: boolean) => unknown;
  const loader = Module as unknown as { _load: LoadFn };
  let originalLoad: LoadFn;
  let cachedBefore: Set<string>;
  let current: FakeHost | undefined;

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

  /**
   * Install a fresh fake host as THE `vscode` and load the shared channel helper against
   * it NOW, so that no module is first loaded (and compiled) while the tripwires are armed.
   */
  function install(options: FakeHostOptions): FakeHost {
    for (const key of Object.keys(require.cache)) {
      if (key.endsWith('outputChannel.ts') || key.endsWith('outputChannel.js')) {
        delete require.cache[key];
      }
    }
    const host = makeFakeHost(options);
    current = host;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('../../../src/diagnostics/outputChannel');
    return host;
  }

  /** Every situation the command can meet. `pick` answers the toast. */
  const SCENARIOS: ReadonlyArray<readonly [string, FakeHostOptions]> = [
    ['a plain file', {}],
    [
      'a language-specific default formatter, format on save, code actions',
      {
        workspace: {
          plain: { 'editor.formatOnSave': true, 'editor.codeActionsOnSave': { 'source.fixAll.eslint': 'explicit' } },
          languages: { css: { 'editor.defaultFormatter': 'esbenp.prettier-vscode' } }
        },
        extensions: { 'esbenp.prettier-vscode': { displayName: 'Prettier - Code formatter' } },
        files: { '/ws/.prettierrc': '{}', '/ws/package.json': '{"eslintConfig":{}}' }
      }
    ],
    [
      'the incumbent installed and enabled, with its config file',
      { extensions: { 'lonefy.vscode-JS-CSS-HTML-formatter': {} }, files: { '/ws/.vscode/formatter.json': '{}' } }
    ],
    ['the incumbent disabled but its config file present', { files: { '/ws/.vscode/formatter.json': '{}' } }],
    ['the incumbent config path being a folder', { files: { '/ws/.vscode/formatter.json': DIRECTORY } }],
    ['no workspace folder', { folders: [], document: { path: '/loose/a.css', languageId: 'css' } }],
    ['Restricted Mode', { trusted: false, files: { '/ws/.vscode/formatter.json': '{}' } }],
    ['a host without inspect', { inspect: 'absent', workspace: { plain: { 'editor.defaultFormatter': 'a.b' } } }],
    ['a host whose inspect throws', { inspect: 'throws' }],
    ['settings that cannot be read', { getThrows: ['defaultFormatter', 'formatOnSave'] }],
    ['an extension lookup that throws', { extensionsThrow: true, workspace: { plain: { 'editor.defaultFormatter': 'a.b' } } }],
    ['no active editor', { document: null }],
    ['an Output panel as the active editor', { document: { path: '/out/x', languageId: 'log', scheme: 'output' } }],
    ['a failure while reading the editor', { activeEditorThrows: true }],
    ['a language Tidy does not handle', { document: { path: '/ws/a.py', languageId: 'python' } }]
  ];

  for (const [name, options] of SCENARIOS) {
    it(`writes nothing, reads nothing it should not, sends nothing : ${name}`, async () => {
      const host = install({ ...options, pick: (_message, buttons) => buttons[0] });
      const { tripped } = await withTripwires(async () => {
        await whoFormats();
        for (let i = 0; i < 5; i += 1) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      });
      current = undefined;

      assert.deepEqual(host.recorded.writes, [], 'no configuration update, file write, edit or openExternal');
      assert.deepEqual(tripped, [], 'no network, process or file-write API');
      assert.deepEqual(host.recorded.unexpected, [], 'no API the stub does not model');
      assert.equal(host.recorded.outputCleared, 0, 'the shared channel is never cleared');
      for (const call of host.recorded.executed) {
        assert.ok(OPEN_ONLY_COMMAND_IDS.includes(call.command), `${call.command} is not an open command`);
      }
      // What it does read is local, read-only file-system metadata only.
      for (const read of host.recorded.fsReads) {
        assert.match(read, /^(stat|list|read) /);
      }
    });
  }

  it('every button, clicked, runs only an open command and still writes nothing', async () => {
    const labels = [
      'Open Default Formatter Setting',
      'Open Format on Save Settings',
      'Find JS-CSS-HTML Formatter',
      'Find Default Formatter Extension'
    ];
    for (const label of labels) {
      const host = install({
        workspace: { plain: { 'editor.defaultFormatter': 'esbenp.prettier-vscode' } },
        extensions: { 'esbenp.prettier-vscode': {}, 'lonefy.vscode-JS-CSS-HTML-formatter': {} },
        pick: (_message, buttons) => buttons.find((b) => b === label)
      });
      const { tripped } = await withTripwires(async () => {
        await whoFormats();
        for (let i = 0; i < 5; i += 1) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      });
      current = undefined;
      assert.equal(host.recorded.executed.length, 1, label);
      assert.ok(OPEN_ONLY_COMMAND_IDS.includes(host.recorded.executed[0].command), label);
      assert.deepEqual(host.recorded.writes, [], label);
      assert.deepEqual(tripped, [], label);
    }
  });

  /* ---------------------------------------------------------------------- */
  /* 3b. The behavioural detectors can fail                                  */
  /* ---------------------------------------------------------------------- */

  describe('the behavioural detectors really detect', () => {
    it('the recording host records and refuses a configuration update', async () => {
      const host = makeFakeHost();
      await assert.rejects(() => host.vscode.workspace.getConfiguration('editor').update('formatOnSave', true, 1));
      assert.deepEqual(host.recorded.writes, ['update editor.formatOnSave = true @ 1']);
    });

    it('the recording host records and refuses every file-system write', async () => {
      const host = makeFakeHost();
      const uri = host.vscode.Uri.file('/ws/x');
      for (const write of ['writeFile', 'delete', 'createDirectory', 'rename', 'copy'] as const) {
        await assert.rejects(() => (host.vscode.workspace.fs[write] as (u: unknown) => Promise<void>)(uri));
      }
      await assert.rejects(() => host.vscode.workspace.applyEdit());
      await assert.rejects(() => host.vscode.env.openExternal(uri));
      assert.equal(host.recorded.writes.length, 7);
    });

    it('the recording host reports an API it does not model', () => {
      const host = makeFakeHost();
      void (host.vscode.workspace as unknown as Record<string, unknown>).openTextDocument;
      void (host.vscode as unknown as Record<string, unknown>).languages;
      assert.deepEqual(host.recorded.unexpected, ['workspace.openTextDocument', 'vscode.languages']);
    });

    it('the tripwires trip on a network call, a process spawn and a file write, and are disarmed after', async () => {
      const originalFetch = globalThis.fetch;
      const { tripped } = await withTripwires(async () => {
        for (const call of [
          () => fetch('http://127.0.0.1:1/'),
          () => (https.get as (u: string) => unknown)('https://127.0.0.1:1/'),
          () => (net.connect as (p: number, h: string) => unknown)(1, '127.0.0.1'),
          () => (childProcess.spawn as (c: string) => unknown)('node'),
          () => fs.writeFileSync(path.join(ROOT, 'never-written.txt'), 'x')
        ]) {
          try {
            await call();
          } catch {
            // the tripwire throws on purpose; what matters is that it recorded the call.
          }
        }
      });
      assert.deepEqual(tripped, ['globalThis.fetch', 'https.get', 'net.connect', 'child_process.spawn', 'fs.writeFileSync']);
      assert.equal(globalThis.fetch, originalFetch, 'disarmed');
      assert.ok(!fs.existsSync(path.join(ROOT, 'never-written.txt')));
    });
  });
});
