// End-to-end test of the REAL "Tidy: Preview format" handler, driven through a
// 'vscode' stub faithful on the ONE point that matters here: a
// TextDocumentContentProvider is honoured ONCE PER URI. The host resolves a
// virtual document the first time that exact URI string is opened, caches it, and
// asks the provider again only when an `onDidChange` event names it.
//
// THE DEFECT THIS LOCKS (C-10, fixed in v0.4.1). Every preview of a given file
// reused one URI, and the module registered no onDidChange at all. So previewing
// the same file a second time showed the FIRST preview's text in the diff while
// "Apply" wrote the second, current one : Tidy wrote a text the user had never
// seen, which is precisely what this command exists to prevent. Measured before
// the fix: preview 2 displayed ".a {\n  color: red\n}" while Apply wrote the
// whole two-rule document.
//
// The v0.4.0 apply gate did NOT close this: it closes the different bug of the
// buffer moving under an open diff (there, Apply refuses). Here the buffer is
// perfectly in sync with what Apply writes : only the DISPLAY was stale, so the
// gate had nothing to complain about.
//
// Stub idiom copied from test/unit/providers/formattingProvider.test.ts: patch
// Module._load inside before(), require the module under test, then remove the
// patch and every module it pulled in inside after(), so nothing leaks.
import assert from 'node:assert/strict';
import Module from 'node:module';
// The module's TOP LEVEL is 'vscode'-free, so the pure URI helpers import
// statically here; only the HANDLER needs the stub, and it is required inside
// before() below.
import {
  buildPreviewUriString,
  previewContentKey,
  PREVIEW_SCHEME,
  PREVIEW_STORE_LIMIT
} from '../../../src/commands/previewFormat';

/* -------------------------------------------------------------------------- */
/* A 'vscode' stub that caches virtual documents the way the real host does     */
/* -------------------------------------------------------------------------- */

class FakeUri {
  constructor(
    readonly scheme: string,
    readonly path: string,
    readonly query: string
  ) {}
  get fsPath(): string {
    return this.path;
  }
  toString(): string {
    return `${this.scheme}:${this.path}${this.query ? `?${this.query}` : ''}`;
  }
}

/** Minimal `Uri.parse` for `scheme:path?query`, which is all this module builds. */
function parseUri(raw: string): FakeUri {
  const colon = raw.indexOf(':');
  const scheme = raw.slice(0, colon);
  const rest = raw.slice(colon + 1);
  const mark = rest.indexOf('?');
  return mark === -1
    ? new FakeUri(scheme, rest, '')
    : new FakeUri(scheme, rest.slice(0, mark), rest.slice(mark + 1));
}

class FakeDocument {
  version = 1;
  readonly uri = new FakeUri('file', '/w/sample.css', '');
  constructor(
    readonly languageId: string,
    private text: string
  ) {}
  getText(): string {
    return this.text;
  }
  positionAt(offset: number): { offset: number } {
    return { offset };
  }
  /** A user edit: new text, new version, exactly like the real host. */
  edit(next: string): void {
    this.text = next;
    this.version += 1;
  }
}

class FakeWorkspaceEdit {
  readonly edits: Array<{ uri: FakeUri; newText: string }> = [];
  replace(uri: FakeUri, _range: unknown, newText: string): void {
    this.edits.push({ uri, newText });
  }
}

interface HostState {
  /** Virtual documents the host has already resolved, keyed by FULL URI string. */
  readonly resolved: Map<string, string>;
  readonly providers: Map<string, any>;
  /** Text shown on the modified side of each vscode.diff call, in order. */
  readonly displayed: string[];
  /** URI of the modified side of each vscode.diff call, in order. */
  readonly diffUris: FakeUri[];
  /** Text each applyEdit wrote, in order. */
  readonly applied: string[];
  readonly messages: string[];
  /** Answer the Apply toast gives: 'Apply' to apply, undefined to dismiss. */
  answer: string | undefined;
}

const state: HostState = {
  resolved: new Map(),
  providers: new Map(),
  displayed: [],
  diffUris: [],
  applied: [],
  messages: [],
  answer: 'Apply'
};

let document = new FakeDocument('css', '.a{color:red}');

/** The host's read of a virtual document: provider called once per URI string. */
function openVirtual(uri: FakeUri): string {
  const key = uri.toString();
  if (!state.resolved.has(key)) {
    const provider = state.providers.get(uri.scheme);
    assert.ok(provider, `no content provider registered for ${uri.scheme}`);
    state.resolved.set(key, provider.provideTextDocumentContent(uri));
  }
  return state.resolved.get(key) as string;
}

const vscodeStub: any = {
  Uri: { parse: parseUri },
  Range: class {
    constructor(
      readonly start: unknown,
      readonly end: unknown
    ) {}
  },
  WorkspaceEdit: FakeWorkspaceEdit,
  window: {
    get activeTextEditor() {
      return { document, options: { tabSize: 2, insertSpaces: true } };
    },
    showInformationMessage: async (message: string, ...actions: string[]) => {
      state.messages.push(message);
      return actions.includes('Apply') ? state.answer : undefined;
    },
    showWarningMessage: async (message: string) => {
      state.messages.push(`WARN ${message}`);
      return undefined;
    },
    showErrorMessage: async (message: string) => {
      state.messages.push(`ERROR ${message}`);
      return undefined;
    },
    createOutputChannel: () => ({
      appendLine: () => undefined,
      dispose: () => undefined
    })
  },
  commands: {
    executeCommand: async (command: string, _left: unknown, right: FakeUri) => {
      if (command === 'vscode.diff') {
        state.diffUris.push(right);
        state.displayed.push(openVirtual(right));
      }
      return undefined;
    }
  },
  workspace: {
    // Untrusted on purpose: every on-disk config layer declines, so the suite
    // never depends on the machine it runs on.
    isTrusted: false,
    getConfiguration: () => ({
      get: (_key: string, fallback?: unknown) => fallback,
      inspect: () => undefined
    }),
    getWorkspaceFolder: () => undefined,
    registerTextDocumentContentProvider(scheme: string, provider: any) {
      state.providers.set(scheme, provider);
      // The host subscribes to onDidChange if the provider exposes one; an
      // event naming a URI invalidates that document's cached content.
      provider.onDidChange?.((uri: FakeUri) =>
        state.resolved.delete(uri.toString())
      );
      return { dispose: () => undefined };
    },
    applyEdit: async (edit: FakeWorkspaceEdit) => {
      for (const one of edit.edits) {
        state.applied.push(one.newText);
        document.edit(one.newText);
      }
      return true;
    }
  }
};

type LoadFn = (request: string, parent: unknown, isMain: boolean) => unknown;

interface PreviewModule {
  previewFormat(): Promise<void>;
  PREVIEW_SCHEME: string;
  PREVIEW_STORE_LIMIT: number;
  buildPreviewUriString(
    documentPath: string,
    languageId: string,
    token: number
  ): string;
  previewContentKey(uri: { path: string; query?: string }): string;
}

describe('commands/previewFormat : the diff shows what Apply writes (C-10)', () => {
  const loader = Module as unknown as { _load: LoadFn };
  let originalLoad: LoadFn;
  let cachedBefore: Set<string>;
  let preview: PreviewModule;

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
    preview = require('../../../src/commands/previewFormat') as PreviewModule;
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
    state.displayed.length = 0;
    state.diffUris.length = 0;
    state.applied.length = 0;
    state.messages.length = 0;
    state.answer = 'Apply';
    state.resolved.clear();
    document = new FakeDocument('css', '.a{color:red}');
  });

  /** Preview once and return what was shown and what Apply wrote. */
  async function previewOnce(): Promise<{ shown: string; wrote: string }> {
    const beforeDiffs = state.displayed.length;
    const beforeEdits = state.applied.length;
    await preview.previewFormat();
    assert.equal(
      state.displayed.length,
      beforeDiffs + 1,
      `a diff must have opened; messages: ${JSON.stringify(state.messages)}`
    );
    assert.equal(
      state.applied.length,
      beforeEdits + 1,
      `Apply must have written; messages: ${JSON.stringify(state.messages)}`
    );
    return {
      shown: state.displayed[state.displayed.length - 1],
      wrote: state.applied[state.applied.length - 1]
    };
  }

  it('preview 1 shows exactly the text Apply writes', async () => {
    const first = await previewOnce();
    assert.equal(first.shown, first.wrote);
    assert.match(first.shown, /\.a \{/);
  });

  it('preview 2 of the SAME file, after an edit, shows the CURRENT text', async () => {
    const first = await previewOnce();
    assert.equal(first.shown, first.wrote);

    // The user edits the file between the two previews : the exact scenario the
    // backlog measured (preview 2 displayed preview 1's one-rule text).
    document.edit('.a{color:red}\n.b{color:blue}');
    const second = await previewOnce();

    assert.equal(
      second.shown,
      second.wrote,
      'the diff must show the text Apply is about to write'
    );
    assert.ok(
      second.shown.includes('.b {'),
      `preview 2 must show the second rule, got: ${JSON.stringify(second.shown)}`
    );
    assert.notEqual(
      second.shown,
      first.shown,
      'preview 2 must not re-serve preview 1'
    );
  });

  it('preview 3, after a further edit, shows the CURRENT text too', async () => {
    await previewOnce();
    document.edit('.a{color:red}\n.b{color:blue}');
    const second = await previewOnce();
    document.edit('.a{color:red}\n.b{color:blue}\n.c{color:lime}');
    const third = await previewOnce();

    assert.equal(third.shown, third.wrote);
    assert.ok(third.shown.includes('.c {'), third.shown);
    assert.notEqual(third.shown, second.shown);
  });

  it('a repeated preview with NO edit in between is still freshly served', async () => {
    const first = await previewOnce();
    // Apply rewrote the buffer to the formatted text, so re-formatting it is a
    // no-op; put the unformatted text back to get a second real preview.
    document.edit('.a{color:red}');
    const second = await previewOnce();
    assert.equal(second.shown, second.wrote);
    assert.equal(second.shown, first.shown, 'same input, same preview');
    assert.notEqual(
      state.diffUris[0].toString(),
      state.diffUris[1].toString(),
      'each preview must own its URI'
    );
  });

  it('every preview URI keeps the scheme, the path and the language', async () => {
    await previewOnce();
    document.edit('.a{color:red}');
    await previewOnce();
    for (const uri of state.diffUris) {
      assert.equal(uri.scheme, preview.PREVIEW_SCHEME);
      assert.equal(uri.path, '/w/sample.css');
      assert.match(uri.query, /(^|&)lang=css(&|$)/);
    }
  });

  it('dismissing the toast writes nothing at all', async () => {
    state.answer = undefined;
    await preview.previewFormat();
    assert.equal(state.displayed.length, 1, 'the diff still opens');
    assert.deepEqual(state.applied, [], 'dismissed => ZERO edits');
    assert.equal(document.getText(), '.a{color:red}', 'buffer untouched');
  });
});

describe('commands/previewFormat : preview URI identity (pure)', () => {
  it('a different token yields a different URI for the same file', () => {
    const first = buildPreviewUriString('/w/a.css', 'css', 1);
    const second = buildPreviewUriString('/w/a.css', 'css', 2);
    assert.notEqual(first, second);
    assert.ok(first.startsWith(`${PREVIEW_SCHEME}:/w/a.css?`));
    assert.ok(second.startsWith(`${PREVIEW_SCHEME}:/w/a.css?`));
  });

  it('carries the languageId, percent-encoded', () => {
    assert.match(
      buildPreviewUriString('/w/a.tsx', 'typescriptreact', 7),
      /lang=typescriptreact/
    );
  });

  it('the store key separates two URIs that differ only in query', () => {
    assert.notEqual(
      previewContentKey({ path: '/w/a.css', query: 'lang=css&v=1' }),
      previewContentKey({ path: '/w/a.css', query: 'lang=css&v=2' })
    );
  });

  it('tolerates a URI with no query at all', () => {
    assert.equal(previewContentKey({ path: '/w/a.css' }), '/w/a.css?');
  });

  it('keeps a bounded number of previews addressable', () => {
    assert.ok(PREVIEW_STORE_LIMIT >= 1 && PREVIEW_STORE_LIMIT <= 64);
  });
});
