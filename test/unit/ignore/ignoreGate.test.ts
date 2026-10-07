// The VS Code gate of the .soukformatignore lookup (resolveDocumentIgnore), with
// the workspace bound the walk now has.
//
// soukformatignoreBound.test.ts proves the PURE walk is bounded. This file proves
// the bound takes effect through the REAL gate, which is what the provider, the
// preview, the status bar and Show Effective Configuration all call: the gate
// must hand the walk the document's workspace folder, or the bound is dead code.
//   - an ignore file ABOVE the workspace folder is NOT applied to a document;
//   - one INSIDE it (at the folder, or nearer the file) IS;
//   - a document in no workspace folder consults no ignore file at all;
//   - multi-root: a folder's ignore file does not reach a sibling folder;
//   - the gates that were there before are unchanged: Restricted Mode, the
//     tidy.respectSoukformatignore opt-out, non-file documents, a throwing host.
//
// One of the few unit tests that load a vscode-bound module: the stub answers only
// the handful of calls the gate makes, is installed in before() and removed, with
// every module it pulled in, in after(), so nothing leaks into the suite.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import Module from 'node:module';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import {
  MAX_SOUKFORMATIGNORE_BYTES,
  SOUKFORMATIGNORE_FILENAME,
  type IgnoreLookup
} from '../../../src/ignore/soukformatignore';

type LoadFn = (request: string, parent: unknown, isMain: boolean) => unknown;

interface HostState {
  trusted: boolean;
  respectSetting: boolean | undefined;
  /** Workspace folders, as fsPaths (written however the test wants them spelled). */
  folders: string[];
  getWorkspaceFolderThrows: boolean;
  getWorkspaceFolderCalls: number;
}

const host: HostState = {
  trusted: true,
  respectSetting: undefined,
  folders: [],
  getWorkspaceFolderThrows: false,
  getWorkspaceFolderCalls: 0
};

// The real, mutable 'node:fs' module object, to count the stats the lookup makes.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fsModule = require('node:fs') as Record<string, unknown>;

function countStats(body: () => void): number {
  const original = fsModule.statSync as (...args: unknown[]) => unknown;
  let count = 0;
  fsModule.statSync = (...args: unknown[]): unknown => {
    count += 1;
    return original(...args);
  };
  try {
    body();
  } finally {
    fsModule.statSync = original;
  }
  return count;
}

/**
 * What VS Code's getWorkspaceFolder does: find the folder that contains the path,
 * and report it spelled the way the test configured it (so a test can hand the
 * gate a folder with another case, a trailing separator or forward slashes).
 */
function containing(fsPath: string): string | undefined {
  const norm = (p: string): string =>
    process.platform === 'win32' ? p.toLowerCase().split('/').join(sep) : p;
  return host.folders.find((folder) => {
    const f = norm(folder.replace(/[\\/]+$/, ''));
    const p = norm(fsPath);
    return p === f || p.startsWith(f + sep);
  });
}

const vscodeStub = {
  workspace: {
    get isTrusted(): boolean {
      return host.trusted;
    },
    getConfiguration: () => ({
      get(key: string, fallback?: unknown): unknown {
        return key === 'respectSoukformatignore' && host.respectSetting !== undefined
          ? host.respectSetting
          : fallback;
      }
    }),
    getWorkspaceFolder(uri: { fsPath: string }): { uri: { fsPath: string } } | undefined {
      host.getWorkspaceFolderCalls += 1;
      if (host.getWorkspaceFolderThrows) {
        throw new Error('host failure');
      }
      const folder = containing(uri.fsPath);
      return folder === undefined ? undefined : { uri: { fsPath: folder } };
    }
  }
};

interface GateModule {
  resolveDocumentIgnore(document: unknown): IgnoreLookup;
}

function documentAt(fsPath: string, scheme = 'file'): unknown {
  return { uri: { scheme, fsPath } };
}

describe('ignore/ignoreGate : resolveDocumentIgnore and the workspace bound', () => {
  const loader = Module as unknown as { _load: LoadFn };
  let originalLoad: LoadFn;
  let cachedBefore: Set<string>;
  let gate: GateModule;

  let root: string; // the world above the workspace
  let ws: string; // the workspace folder
  let file: string; // root/ws/src/a.css

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
    gate = require('../../../src/ignore/ignoreGate') as GateModule;
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
    root = mkdtempSync(join(tmpdir(), 'tidy-gate-'));
    ws = join(root, 'ws');
    mkdirSync(join(ws, 'src'), { recursive: true });
    file = join(ws, 'src', 'a.css');
    writeFileSync(file, '');
    host.trusted = true;
    host.respectSetting = undefined;
    host.folders = [ws];
    host.getWorkspaceFolderThrows = false;
    host.getWorkspaceFolderCalls = 0;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function ignoreIn(dir: string, body = '*.css\n'): string {
    const target = join(dir, SOUKFORMATIGNORE_FILENAME);
    writeFileSync(target, body);
    return target;
  }

  describe('the workspace bound takes effect through the gate', () => {
    it('an ignore file ABOVE the workspace folder is NOT applied to the document', () => {
      ignoreIn(root);
      assert.deepEqual(gate.resolveDocumentIgnore(documentAt(file)), { ignored: false });
    });

    it('an ignore file INSIDE the workspace folder IS applied', () => {
      const inside = ignoreIn(ws);
      const lookup = gate.resolveDocumentIgnore(documentAt(file));
      assert.equal(lookup.ignored, true);
      assert.equal(lookup.path, inside);
    });

    it('one nearer the file applies too, and shadows the one at the workspace folder', () => {
      ignoreIn(ws, '*.css\n');
      const nearer = ignoreIn(join(ws, 'src'), 'dist/\n');
      const lookup = gate.resolveDocumentIgnore(documentAt(file));
      assert.equal(lookup.path, nearer);
      assert.equal(lookup.ignored, false);
    });

    it('with both, the one inside applies and the one above stays out of it', () => {
      ignoreIn(root, '*.css\n');
      const inside = ignoreIn(ws, 'dist/\n');
      const lookup = gate.resolveDocumentIgnore(documentAt(file));
      assert.equal(lookup.path, inside);
      assert.equal(lookup.ignored, false);
    });

    it('nothing above the workspace folder is even looked at (2 levels, 2 stats)', () => {
      ignoreIn(root);
      assert.equal(countStats(() => gate.resolveDocumentIgnore(documentAt(file))), 2);
    });

    it('an oversized ignore file inside fails closed through the gate, with the reason', () => {
      writeFileSync(join(ws, SOUKFORMATIGNORE_FILENAME), Buffer.alloc(MAX_SOUKFORMATIGNORE_BYTES + 1, 0x23));
      const lookup = gate.resolveDocumentIgnore(documentAt(file));
      assert.equal(lookup.ignored, true);
      assert.ok(lookup.failClosed?.detail.includes('too large to read'));
    });

    it('an oversized ignore file above is not consulted, so it does not exclude anything', () => {
      writeFileSync(join(root, SOUKFORMATIGNORE_FILENAME), Buffer.alloc(MAX_SOUKFORMATIGNORE_BYTES + 1, 0x23));
      assert.deepEqual(gate.resolveDocumentIgnore(documentAt(file)), { ignored: false });
    });

    it('the bound holds whatever the case or separators of the folder the host reports (Windows)', function () {
      if (process.platform !== 'win32') {
        this.skip();
      }
      ignoreIn(root);
      const spellings = [ws.toUpperCase(), ws.split('\\').join('/'), ws + '\\'];
      for (const spelling of spellings) {
        host.folders = [spelling];
        assert.deepEqual(gate.resolveDocumentIgnore(documentAt(file)), { ignored: false }, spelling);
      }
      const inside = ignoreIn(ws);
      for (const spelling of spellings) {
        host.folders = [spelling];
        assert.equal(gate.resolveDocumentIgnore(documentAt(file)).path, inside, spelling);
      }
    });
  });

  describe('a document in no workspace folder', () => {
    it('consults no ignore file at all: not one stat, even with one right beside it', () => {
      host.folders = [];
      ignoreIn(join(ws, 'src'));
      let lookup: IgnoreLookup | undefined;
      const stats = countStats(() => {
        lookup = gate.resolveDocumentIgnore(documentAt(file));
      });
      assert.deepEqual(lookup, { ignored: false });
      assert.equal(stats, 0);
      assert.equal(host.getWorkspaceFolderCalls, 1, 'the folder was asked for');
    });

    it('a document in a folder that is not its own workspace folder is not governed by it either', () => {
      const elsewhere = join(root, 'elsewhere');
      mkdirSync(elsewhere);
      ignoreIn(ws);
      host.folders = [elsewhere];
      assert.deepEqual(gate.resolveDocumentIgnore(documentAt(file)), { ignored: false });
    });
  });

  describe('multi-root: each folder is its own bound', () => {
    it('an ignore file in one workspace folder does not reach a document in a sibling folder', () => {
      const other = join(root, 'other');
      mkdirSync(join(other, 'src'), { recursive: true });
      const otherFile = join(other, 'src', 'b.css');
      writeFileSync(otherFile, '');
      ignoreIn(ws);
      host.folders = [ws, other];
      assert.equal(gate.resolveDocumentIgnore(documentAt(file)).ignored, true);
      assert.deepEqual(gate.resolveDocumentIgnore(documentAt(otherFile)), { ignored: false });
    });

    it('an ignore file at the root of a folder nested inside another applies to its own folder only', () => {
      const inner = join(ws, 'packages', 'inner');
      mkdirSync(join(inner, 'src'), { recursive: true });
      const innerFile = join(inner, 'src', 'c.css');
      writeFileSync(innerFile, '');
      ignoreIn(ws, 'dist/\n');
      host.folders = [inner];
      // The host reports `inner` as this document's folder: the ignore file in the
      // outer folder lies above it and is not consulted.
      assert.deepEqual(gate.resolveDocumentIgnore(documentAt(innerFile)), { ignored: false });
    });
  });

  describe('the gates that were already there are unchanged', () => {
    it('Restricted Mode: nothing is read and the document is not ignored', () => {
      ignoreIn(ws);
      host.trusted = false;
      let lookup: IgnoreLookup | undefined;
      const stats = countStats(() => {
        lookup = gate.resolveDocumentIgnore(documentAt(file));
      });
      assert.deepEqual(lookup, { ignored: false });
      assert.equal(stats, 0);
      assert.equal(host.getWorkspaceFolderCalls, 0, 'the gate stops before anything else');
    });

    it('tidy.respectSoukformatignore = false: not ignored, nothing read', () => {
      ignoreIn(ws);
      host.respectSetting = false;
      let lookup: IgnoreLookup | undefined;
      const stats = countStats(() => {
        lookup = gate.resolveDocumentIgnore(documentAt(file));
      });
      assert.deepEqual(lookup, { ignored: false });
      assert.equal(stats, 0);
    });

    it('tidy.respectSoukformatignore = true behaves as the default', () => {
      ignoreIn(ws);
      host.respectSetting = true;
      assert.equal(gate.resolveDocumentIgnore(documentAt(file)).ignored, true);
    });

    it('a non-file document (untitled, virtual) is never consulted', () => {
      ignoreIn(ws);
      assert.deepEqual(gate.resolveDocumentIgnore(documentAt(file, 'untitled')), { ignored: false });
      assert.deepEqual(gate.resolveDocumentIgnore(documentAt(file, 'vscode-vfs')), { ignored: false });
      assert.equal(host.getWorkspaceFolderCalls, 0);
    });

    it('a host that throws while looking up the folder is fail-safe: not ignored, no throw', () => {
      ignoreIn(ws);
      host.getWorkspaceFolderThrows = true;
      assert.deepEqual(gate.resolveDocumentIgnore(documentAt(file)), { ignored: false });
    });
  });
});
