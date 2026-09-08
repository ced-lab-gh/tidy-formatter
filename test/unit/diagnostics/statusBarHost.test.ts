// Regression tests for the "one store, one answer" invariant of the Tidy status
// bar (ADD-05 host on top of the ADD-14 per-file history).
//
// THE BUG THIS LOCKS: ADD-14 turned the single last-format slot into a 50-entry
// ring buffer plus getLastFormatFor(uri). The Explain command was migrated, the
// status bar host was not: it still read the GLOBAL newest record and then
// filtered it by uri. Formatting a second file therefore blanked out the first
// file's tooltip verdict, while "Tidy: Explain Last Format" still reported it.
// The same store gave two different answers about the same file. Tidy's whole
// promise is that it never tells the user something untrue about their code, so
// that contradiction is a product defect, not a cosmetic one.
//
// This is the only unit test that loads a vscode-bound module. It answers the
// bundle's require('vscode') with a FAITHFUL stub (not a permissive proxy) for
// exactly the handful of APIs statusBarHost consumes, installs the patch inside
// before(), and removes both the patch and every module it pulled in inside
// after(), so nothing leaks into the rest of the suite. Mocha has already loaded
// every spec file by the time before() runs, so no other file can be resolved
// through the stub.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import Module from 'node:module';
import * as path from 'node:path';
import {
  clearLastFormat,
  getLastFormatFor,
  recordLastFormat,
  setLastFormatListener,
  type FormatStatus,
  type LastFormatRecord
} from '../../../src/diagnostics/lastFormat';
import { statusShortLabel } from '../../../src/diagnostics/statusBar';

const ROOT = path.resolve(__dirname, '../../..');

// ---------------------------------------------------------------------------
// A minimal but faithful 'vscode' stub: only what statusBarHost really touches.
// ---------------------------------------------------------------------------

interface FakeUri {
  readonly scheme: string;
  readonly fsPath: string;
  toString(): string;
}

interface FakeDocument {
  readonly uri: FakeUri;
  readonly languageId: string;
  getText(): string;
}

interface FakeStatusBarItem {
  name: string | undefined;
  command: string | undefined;
  text: string;
  tooltip: { value: string } | undefined;
  backgroundColor: unknown;
  visible: boolean;
  show(): void;
  hide(): void;
  dispose(): void;
}

interface StubState {
  activeDocument: FakeDocument | undefined;
  item: FakeStatusBarItem | undefined;
  editorListeners: (() => void)[];
}

const state: StubState = {
  activeDocument: undefined,
  item: undefined,
  editorListeners: []
};

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

class FakeMarkdownString {
  value: string;
  isTrusted = false;

  constructor(value?: string) {
    this.value = value ?? '';
  }
}

class FakeThemeColor {
  constructor(readonly id: string) {}
}

function fakeConfiguration(section: string): {
  get(key: string, fallback?: unknown): unknown;
  inspect(): undefined;
} {
  return {
    get(key: string, fallback?: unknown): unknown {
      // Keeps the test hermetic: with the opt-out off, the ignore gate returns
      // "not ignored" without walking the real disk for a .soukformatignore.
      if (section === 'tidy' && key === 'respectSoukformatignore') {
        return false;
      }
      // Every other key behaves like an unset setting: the caller's own default.
      return fallback;
    },
    inspect(): undefined {
      return undefined;
    }
  };
}

const vscodeStub = {
  StatusBarAlignment: { Left: 1, Right: 2 },
  Disposable: FakeDisposable,
  MarkdownString: FakeMarkdownString,
  ThemeColor: FakeThemeColor,
  window: {
    get activeTextEditor(): { document: FakeDocument } | undefined {
      return state.activeDocument === undefined
        ? undefined
        : { document: state.activeDocument };
    },
    createStatusBarItem(): FakeStatusBarItem {
      const item: FakeStatusBarItem = {
        name: undefined,
        command: undefined,
        text: '',
        tooltip: undefined,
        backgroundColor: undefined,
        visible: false,
        show(): void {
          item.visible = true;
        },
        hide(): void {
          item.visible = false;
        },
        dispose(): void {
          item.visible = false;
        }
      };
      state.item = item;
      return item;
    },
    onDidChangeActiveTextEditor(listener: () => void): FakeDisposable {
      state.editorListeners.push(listener);
      return new FakeDisposable(() => {
        state.editorListeners = state.editorListeners.filter(
          (l) => l !== listener
        );
      });
    }
  },
  workspace: {
    isTrusted: true,
    getConfiguration(section: string) {
      return fakeConfiguration(section);
    },
    onDidChangeConfiguration(): FakeDisposable {
      return new FakeDisposable();
    }
  }
};

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function doc(fsPath: string, languageId: string): FakeDocument {
  const uri = `file:///${fsPath.replace(/^\/+/, '')}`;
  return {
    uri: {
      scheme: 'file',
      fsPath,
      toString: () => uri
    },
    languageId,
    getText: () => 'a{color:red}'
  };
}

const DOC_A = doc('w/a.css', 'css');
const DOC_B = doc('w/b.css', 'css');
const DOC_C = doc('w/c.css', 'css');

function uriOf(document: FakeDocument): string {
  return document.uri.toString();
}

function record(
  document: FakeDocument,
  status: FormatStatus,
  detail?: string
): LastFormatRecord {
  return {
    uri: uriOf(document),
    fileName: path.basename(document.uri.fsPath),
    languageId: document.languageId,
    status,
    scope: 'document',
    at: '2026-09-07T10:11:12.000Z',
    ...(detail === undefined ? {} : { detail })
  };
}

/** Fire the ONE existing editor listener: forces a passive repaint. */
function repaint(): void {
  for (const listener of state.editorListeners) {
    listener();
  }
}

function tooltipText(): string {
  assert.ok(state.item, 'the host never created a status bar item');
  return state.item!.tooltip?.value ?? '';
}

/** The single "Last attempt ..." tooltip line, or undefined when absent. */
function lastAttemptLine(): string | undefined {
  return tooltipText()
    .split('\n')
    .find((line) => line.startsWith('Last attempt'));
}

/**
 * Force the passive repaint, then read its "Last attempt ..." line.
 *
 * The visibility assertion is load-bearing: repaintPassive swallows any throw
 * and hides the item WITHOUT touching the tooltip, so a broken gather would
 * leave the previous (transient) tooltip in place and a naive read would happily
 * assert on stale text. Refusing to read a hidden item removes that false pass.
 */
function repaintAndReadLastAttempt(): string | undefined {
  repaint();
  assert.ok(state.item, 'the host never created a status bar item');
  assert.equal(
    state.item!.visible,
    true,
    'the passive repaint hid the item: the tooltip below would be stale'
  );
  return lastAttemptLine();
}

interface StatusBarHostModule {
  createTidyStatusBar(): { dispose(): void };
}

type LoadFn = (request: string, parent: unknown, isMain: boolean) => unknown;

describe('diagnostics/statusBarHost : one store, one answer (ADD-14)', () => {
  const loader = Module as unknown as { _load: LoadFn };
  let originalLoad: LoadFn;
  let cachedBefore: Set<string>;
  let host: StatusBarHostModule;
  let disposable: { dispose(): void } | undefined;

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
    host = require('../../../src/diagnostics/statusBarHost') as StatusBarHostModule;
  });

  after(() => {
    loader._load = originalLoad;
    for (const key of Object.keys(require.cache)) {
      if (!cachedBefore.has(key)) {
        delete require.cache[key];
      }
    }
    setLastFormatListener(undefined);
    clearLastFormat();
  });

  beforeEach(() => {
    clearLastFormat();
    state.item = undefined;
    state.editorListeners = [];
    state.activeDocument = DOC_A;
    disposable = host.createTidyStatusBar();
  });

  afterEach(() => {
    disposable?.dispose(); // also clears the 6 s transient timer
    disposable = undefined;
    setLastFormatListener(undefined);
    clearLastFormat();
  });

  it('installs exactly one editor listener and no more', () => {
    // ADD-05 contract: the fix must not add a second repaint trigger.
    assert.equal(state.editorListeners.length, 1);
  });

  it('keeps each file own verdict after another file is formatted', () => {
    recordLastFormat(record(DOC_A, 'guard-rejected', 'JSX tag boundary changed'));
    recordLastFormat(record(DOC_B, 'applied'));

    // Back to the passive view of the still-active a.css.
    const line = repaintAndReadLastAttempt();
    assert.ok(
      line !== undefined,
      'a.css lost its verdict after b.css was formatted (the ADD-14 regression)'
    );
    assert.ok(
      line!.includes(statusShortLabel('guard-rejected')),
      `expected the guard verdict of a.css, got: ${line}`
    );
    assert.ok(
      line!.includes('JSX tag boundary changed'),
      `expected the guard reason of a.css, got: ${line}`
    );
    assert.ok(
      !line!.includes(statusShortLabel('applied')),
      `b.css verdict leaked into the a.css tooltip: ${line}`
    );
  });

  it('agrees with getLastFormatFor for BOTH files', () => {
    recordLastFormat(record(DOC_A, 'guard-rejected', 'JSX tag boundary changed'));
    recordLastFormat(record(DOC_B, 'applied'));

    for (const document of [DOC_A, DOC_B]) {
      state.activeDocument = document;
      const line = repaintAndReadLastAttempt();

      const stored = getLastFormatFor(uriOf(document));
      assert.ok(stored, `the store lost ${document.uri.fsPath}`);
      assert.ok(line !== undefined, `no last attempt line for ${document.uri.fsPath}`);
      assert.ok(
        line!.includes(statusShortLabel(stored!.status)),
        `status bar and getLastFormatFor disagree on ${document.uri.fsPath}: ` +
          `store says "${statusShortLabel(stored!.status)}", bar says "${line}"`
      );
    }
  });

  it('shows no verdict for a file that was never formatted', () => {
    recordLastFormat(record(DOC_B, 'applied'));
    state.activeDocument = DOC_C;
    const line = repaintAndReadLastAttempt();

    assert.equal(
      getLastFormatFor(uriOf(DOC_C)),
      undefined,
      'c.css was never formatted'
    );
    assert.equal(
      line,
      undefined,
      'the bar invented a verdict for a file it never formatted'
    );
  });

  it('still repaints transiently on every format (ADD-05 listener intact)', () => {
    recordLastFormat(record(DOC_A, 'guard-rejected', 'JSX tag boundary changed'));

    assert.ok(state.item, 'no status bar item');
    assert.ok(
      state.item!.text.includes(`Tidy: ${statusShortLabel('guard-rejected')}`),
      `expected the transient text, got: ${state.item!.text}`
    );
    assert.equal(state.item!.visible, true);
  });

  it('never repaints the active file for a background format', () => {
    // DOC_A stays active while b.css is formatted elsewhere.
    recordLastFormat(record(DOC_B, 'applied'));

    assert.ok(state.item, 'no status bar item');
    assert.ok(
      !state.item!.text.includes(`Tidy: ${statusShortLabel('applied')}`),
      `a background format hijacked the bar: ${state.item!.text}`
    );
  });
});

describe('diagnostics/statusBarHost : source invariants', () => {
  const source = fs.readFileSync(
    path.join(ROOT, 'src/diagnostics/statusBarHost.ts'),
    'utf8'
  );

  it('reads the per-uri record, never the global newest one', () => {
    assert.ok(
      source.includes('getLastFormatFor('),
      'the host must resolve the record of the ACTIVE file'
    );
    assert.ok(
      !source.includes('getLastFormat('),
      'the host must not read the global newest record and filter it by uri'
    );
  });

  it('carries no em dash', () => {
    assert.ok(!source.includes(String.fromCharCode(0x2014)));
  });
});
