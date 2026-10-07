// The VS Code gate of the .soukformatignore lookup (resolveDocumentIgnore). The
// walk goes up to the root of the disk, like git (soukformatignoreBound.test.ts
// proves the PURE walk); this file proves it through the REAL gate, which is what
// the provider, the preview, the status bar and Show Effective Configuration call:
//   - an ignore file ABOVE the opened workspace folder IS applied to a document;
//   - the nearest one wins, inside the folder or above it;
//   - a document in no workspace folder is checked too;
//   - multi-root: only the ancestors of the document count;
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

describe('ignore/ignoreGate : resolveDocumentIgnore (walk to the root)', () => {
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

  describe('the walk goes up to the root, through the gate', () => {
    it('an ignore file ABOVE the opened workspace folder IS applied to the document', () => {
      const above = ignoreIn(root);
      const lookup = gate.resolveDocumentIgnore(documentAt(file));
      assert.equal(lookup.ignored, true);
      assert.equal(lookup.path, above);
    });

    it('an ignore file INSIDE the workspace folder IS applied', () => {
      const inside = ignoreIn(ws);
      const lookup = gate.resolveDocumentIgnore(documentAt(file));
      assert.equal(lookup.ignored, true);
      assert.equal(lookup.path, inside);
    });

    it('the nearest wins: one nearer the file shadows the one at the workspace folder', () => {
      ignoreIn(ws, '*.css\n');
      const nearer = ignoreIn(join(ws, 'src'), 'dist/\n');
      const lookup = gate.resolveDocumentIgnore(documentAt(file));
      assert.equal(lookup.path, nearer);
      assert.equal(lookup.ignored, false);
    });

    it('the nearest wins over one above the workspace folder too', () => {
      ignoreIn(root, '*.css\n');
      const inside = ignoreIn(ws, 'dist/\n');
      const lookup = gate.resolveDocumentIgnore(documentAt(file));
      assert.equal(lookup.path, inside);
      assert.equal(lookup.ignored, false);
    });

    it('the gate never asks the host for a workspace folder (it needs none)', () => {
      ignoreIn(ws);
      host.getWorkspaceFolderThrows = true;
      assert.equal(gate.resolveDocumentIgnore(documentAt(file)).ignored, true);
      assert.equal(host.getWorkspaceFolderCalls, 0);
    });

    it('an oversized ignore file fails closed through the gate, inside the folder or above it', () => {
      const big = Buffer.alloc(MAX_SOUKFORMATIGNORE_BYTES + 1, 0x23);
      writeFileSync(join(ws, SOUKFORMATIGNORE_FILENAME), big);
      const inside = gate.resolveDocumentIgnore(documentAt(file));
      assert.equal(inside.ignored, true);
      assert.ok(inside.failClosed?.detail.includes('too large to read'));
      rmSync(join(ws, SOUKFORMATIGNORE_FILENAME));
      writeFileSync(join(root, SOUKFORMATIGNORE_FILENAME), big);
      const above = gate.resolveDocumentIgnore(documentAt(file));
      assert.equal(above.ignored, true);
      assert.ok(above.failClosed?.detail.includes('too large to read'));
    });
  });

  describe('a document in no workspace folder is checked too', () => {
    it('an ignore file beside it applies, with no workspace folder at all', () => {
      host.folders = [];
      const beside = ignoreIn(join(ws, 'src'));
      const lookup = gate.resolveDocumentIgnore(documentAt(file));
      assert.equal(lookup.ignored, true);
      assert.equal(lookup.path, beside);
      assert.equal(host.getWorkspaceFolderCalls, 0);
    });

    it('so does one above it, and a folder that is not its own changes nothing', () => {
      const elsewhere = join(root, 'elsewhere');
      mkdirSync(elsewhere);
      const above = ignoreIn(ws);
      host.folders = [elsewhere];
      const lookup = gate.resolveDocumentIgnore(documentAt(file));
      assert.equal(lookup.ignored, true);
      assert.equal(lookup.path, above);
    });
  });

  describe('multi-root: only the ancestors of the document count', () => {
    it('an ignore file in one folder does not reach a document in a sibling folder', () => {
      const other = join(root, 'other');
      mkdirSync(join(other, 'src'), { recursive: true });
      const otherFile = join(other, 'src', 'b.css');
      writeFileSync(otherFile, '');
      ignoreIn(ws);
      host.folders = [ws, other];
      assert.equal(gate.resolveDocumentIgnore(documentAt(file)).ignored, true);
      assert.deepEqual(gate.resolveDocumentIgnore(documentAt(otherFile)), { ignored: false });
    });

    it('a file shared by both folders (their common parent) governs both', () => {
      const other = join(root, 'other');
      mkdirSync(join(other, 'src'), { recursive: true });
      const otherFile = join(other, 'src', 'b.css');
      writeFileSync(otherFile, '');
      ignoreIn(root);
      host.folders = [ws, other];
      assert.equal(gate.resolveDocumentIgnore(documentAt(file)).ignored, true);
      assert.equal(gate.resolveDocumentIgnore(documentAt(otherFile)).ignored, true);
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
    });

    it('a directory named .soukformatignore is not an ignore file: not ignored, no throw', () => {
      mkdirSync(join(ws, SOUKFORMATIGNORE_FILENAME));
      assert.equal(gate.resolveDocumentIgnore(documentAt(file)).ignored, false);
    });
  });
});
