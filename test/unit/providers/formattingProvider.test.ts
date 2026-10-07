// End-to-end tests for the REAL formatting providers, driven through a faithful
// 'vscode' stub. These lock three defects that only ever appeared at the
// provider seam, where no pure unit test could see them:
//
//   FIX-A  Format Selection over HTML template islands formatted a PREFIX of the
//          selection (sometimes nothing at all) because the range handed to the
//          engine was measured on the caller's text while the engine received a
//          LONGER masked text. Nothing was corrupted, but the user asked for a
//          format and silently got a partial one.
//   FIX-B  tidy-ignore regions were ignored during Format Selection in every
//          language, and on the Prettier path (ts/tsx/jsx) in every scope, with
//          no word to the user. Selections are now protected like documents; the
//          Prettier path still defers to prettier-ignore but SAYS SO.
//   FIX-C  json/jsonc are printed by jsonc-parser, not js-beautify, so the
//          status bar / output channel / Explain no longer name a library that
//          never ran.
//   FIX-D  a guard verdict depended on the SCOPE of the request: a selection was
//          judged as a context-free fragment, so Format Selection over the inner
//          text of <pre>/<textarea>/<pre><code> collapsed rendered whitespace and
//          the edit was APPLIED, while the same textual change was correctly
//          rejected at document scope. A selection is now spliced back into its
//          document before the guard runs, so both scopes ask one question.
//   FIX-E  the reported engine was content-blind: a .js containing JSX is really
//          printed by Prettier, and every surface still said js-beautify.
//   FIX-F  HTML front matter was masked at DOCUMENT scope only, so Format
//          Selection -- and editor.formatOnSaveMode "modifications", which sends
//          ranges on every save -- handed the YAML to js-beautify, which promoted
//          nested keys to top level and flattened block scalars. The guard
//          accepted it: the block reads as one HTML text node whose whitespace it
//          normalises. The provider now passes the document text to the mask
//          plan, which locates the block in the DOCUMENT and clips it to the span.
//
// Stub idiom copied from test/unit/diagnostics/statusBarHost.test.ts: patch
// Module._load inside before(), require the module under test, then remove the
// patch and every module it pulled in inside after(), so nothing leaks. The stub
// reports an UNTRUSTED workspace, which is what keeps the suite hermetic: the
// .editorconfig / .soukformatrc / .prettierrc / .soukformatignore layers all
// decline to touch the disk in that state.
import assert from 'node:assert/strict';
import Module from 'node:module';
import {
  clearLastFormat,
  getLastFormatFor,
  type LastFormatRecord
} from '../../../src/diagnostics/lastFormat';
import {
  UNHONOURED_IGNORE_PREFIX,
  UNHONOURED_IGNORE_PRETTIER_PATH
} from '../../../src/engine/maskPlan';
import { JSX_TEXT_WHITESPACE_REASON } from '../../../src/safety/guard';

/* -------------------------------------------------------------------------- */
/* A minimal but faithful 'vscode' stub                                        */
/* -------------------------------------------------------------------------- */

interface FakePosition {
  readonly offset: number;
}

class FakeRange {
  constructor(readonly start: FakePosition, readonly end: FakePosition) {}
}

interface FakeTextEdit {
  readonly range: FakeRange;
  readonly newText: string;
}

class FakeUri {
  constructor(readonly path: string) {}
  get fsPath(): string {
    return this.path;
  }
  toString(): string {
    return `file://${this.path}`;
  }
}

/** A TextDocument faithful to the four APIs the provider consumes. */
class FakeDocument {
  readonly uri: FakeUri;

  constructor(
    readonly languageId: string,
    private readonly text: string,
    path: string
  ) {
    this.uri = new FakeUri(path);
  }

  getText(range?: FakeRange): string {
    return range === undefined
      ? this.text
      : this.text.slice(range.start.offset, range.end.offset);
  }

  offsetAt(position: FakePosition): number {
    return position.offset;
  }

  positionAt(offset: number): FakePosition {
    return { offset };
  }
}

interface StubState {
  channelLines: string[];
  warnings: string[];
  /** The action buttons offered with each warning, in the same order. */
  warningActions: string[][];
  infos: string[];
  /**
   * EXPLICITLY set `files.*` settings for the next format, as
   * `inspect().globalValue` (the shape readExplicit consumes). Empty by default
   * and cleared before every test, so the suite stays as hermetic as it was: an
   * unset key still answers "not set" and no on-disk layer is consulted.
   */
  files: Record<string, unknown>;
  /**
   * Forces the M3-1 prettier-ignore check to fail in one of the two ways it can:
   * it answers "unchecked", or it throws. Neither happens organically, because
   * the check parses the document with the guard's own plugin set and the guard
   * has accepted the write before the check is asked; the seam exists so the
   * fail-safe path is exercised rather than trusted.
   */
  ignoreCheckFault: 'unchecked' | 'throw' | undefined;
}

const state: StubState = {
  channelLines: [],
  warnings: [],
  warningActions: [],
  infos: [],
  files: {},
  ignoreCheckFault: undefined
};

const vscodeStub = {
  Range: FakeRange,
  TextEdit: {
    replace(range: FakeRange, newText: string): FakeTextEdit {
      return { range, newText };
    }
  },
  window: {
    createOutputChannel(): { appendLine(line: string): void; dispose(): void } {
      return {
        appendLine(line: string): void {
          state.channelLines.push(line);
        },
        dispose(): void {
          /* nothing to release in the stub */
        }
      };
    },
    showWarningMessage(message: string, ...actions: string[]): Promise<undefined> {
      state.warnings.push(message);
      state.warningActions.push(actions);
      return Promise.resolve(undefined);
    },
    showInformationMessage(message: string): Promise<undefined> {
      state.infos.push(message);
      return Promise.resolve(undefined);
    }
  },
  commands: {
    executeCommand(): Promise<undefined> {
      return Promise.resolve(undefined);
    }
  },
  workspace: {
    // Untrusted on purpose: every on-disk config layer declines, so the suite
    // never depends on the machine it runs on.
    isTrusted: false,
    getConfiguration(section?: string): {
      get(key: string, fallback?: unknown): unknown;
      inspect(key: string): { globalValue: unknown } | undefined;
    } {
      return {
        get(_key: string, fallback?: unknown): unknown {
          return fallback;
        },
        inspect(key: string): { globalValue: unknown } | undefined {
          // Only the `files` section is answerable, and only for a key a test
          // set. Everything else stays "not set", which is what keeps the
          // .editorconfig / .soukformatrc / .prettierrc layers out of the suite.
          if (section !== 'files') {
            return undefined;
          }
          const value = state.files[key];
          return value === undefined ? undefined : { globalValue: value };
        }
      };
    },
    getWorkspaceFolder(): undefined {
      return undefined;
    }
  }
};

const token = {
  isCancellationRequested: false,
  onCancellationRequested(): { dispose(): void } {
    return { dispose: () => undefined };
  }
};

const FORMATTING_OPTIONS = { tabSize: 2, insertSpaces: true };

interface ProviderModule {
  TidyDocumentFormattingProvider: new () => {
    provideDocumentFormattingEdits(
      document: unknown,
      options: unknown,
      token: unknown
    ): Promise<FakeTextEdit[]>;
  };
  TidyRangeFormattingProvider: new () => {
    provideDocumentRangeFormattingEdits(
      document: unknown,
      range: unknown,
      options: unknown,
      token: unknown
    ): Promise<FakeTextEdit[]>;
  };
  /** The verdict-carrying abort message (guard rejection / failed restore). */
  ABORT_WARNING_MESSAGE: string;
  /** The no-verdict-exists abort message (engine error / guard threw). */
  ENGINE_ERROR_WARNING_MESSAGE: string;
  /** The refusal message for an HTML selection whose boundary cuts a tag. */
  TAG_SPLIT_WARNING_MESSAGE: string;
  /** The refusal message for a selection over a node a prettier-ignore outside it protects. */
  IGNORE_OUTSIDE_SELECTION_WARNING_MESSAGE: string;
  /** The reason recorded for that refusal. */
  IGNORE_OUTSIDE_SELECTION_REASON: string;
  /** The notice when that refusal could not be decided (the file does not parse). */
  IGNORE_UNCHECKED_NOTICE: string;
}

type LoadFn = (request: string, parent: unknown, isMain: boolean) => unknown;

type PrettierIgnoreModule = typeof import('../../../src/engine/prettierIgnore');

/** The real module, except that the selection check can be made to fail on demand. */
function withIgnoreCheckFault(real: PrettierIgnoreModule): PrettierIgnoreModule {
  return {
    ...real,
    checkSelectionAgainstPrettierIgnore: (...args) => {
      if (state.ignoreCheckFault === 'throw') {
        throw new Error('forced by the test');
      }
      if (state.ignoreCheckFault === 'unchecked') {
        return 'unchecked';
      }
      return real.checkSelectionAgainstPrettierIgnore(...args);
    }
  };
}

describe('providers/formattingProvider : the format seam, end to end', () => {
  const loader = Module as unknown as { _load: LoadFn };
  let originalLoad: LoadFn;
  let cachedBefore: Set<string>;
  let providers: ProviderModule;

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
      const loaded = originalLoad.call(this, request, parent, isMain);
      if (request.endsWith('/engine/prettierIgnore')) {
        return withIgnoreCheckFault(loaded as PrettierIgnoreModule);
      }
      return loaded;
    };
    providers = require('../../../src/providers/formattingProvider') as ProviderModule;
  });

  after(() => {
    loader._load = originalLoad;
    for (const key of Object.keys(require.cache)) {
      if (!cachedBefore.has(key)) {
        delete require.cache[key];
      }
    }
    clearLastFormat();
  });

  beforeEach(() => {
    state.channelLines = [];
    state.warnings = [];
    state.warningActions = [];
    state.infos = [];
    state.files = {};
    state.ignoreCheckFault = undefined;
    clearLastFormat();
  });

  /** Format a whole document and return the edits it produced. */
  async function formatDocument(document: FakeDocument): Promise<FakeTextEdit[]> {
    const provider = new providers.TidyDocumentFormattingProvider();
    return provider.provideDocumentFormattingEdits(
      document,
      FORMATTING_OPTIONS,
      token
    );
  }

  /** Format the [start, end) span of a document, as Format Selection does. */
  async function formatSelection(
    document: FakeDocument,
    start: number,
    end: number
  ): Promise<FakeTextEdit[]> {
    const provider = new providers.TidyRangeFormattingProvider();
    return provider.provideDocumentRangeFormattingEdits(
      document,
      new FakeRange({ offset: start }, { offset: end }),
      FORMATTING_OPTIONS,
      token
    );
  }

  function lastRecord(document: FakeDocument): LastFormatRecord {
    const record = getLastFormatFor(document.uri.toString());
    assert.ok(record, 'every attempt must leave an explainable record');
    return record;
  }

  /* ------------------------------------------------------------------ */
  /* FIX-A : a selection is formatted whole, not up to the mask drift     */
  /* ------------------------------------------------------------------ */

  it('formats a WHOLE selection whose template islands drift its length', async () => {
    // 29 caller chars, 65 masked chars: the old range stopped inside the second
    // placeholder, so the engine reflowed nothing and Tidy applied no edit at
    // all. A user asked for a format and got silence.
    const source = '{{a}}{{b}}<div><p>x</p></div>';
    const document = new FakeDocument('html', source, '/w/page.html');

    const edits = await formatSelection(document, 0, source.length);

    assert.equal(edits.length, 1, 'the selection must actually be formatted');
    assert.equal(edits[0].range.start.offset, 0);
    assert.equal(edits[0].range.end.offset, source.length);
    assert.notEqual(edits[0].newText, source);
    assert.ok(
      edits[0].newText.includes('\n  <p>x</p>\n'),
      `the tail must be reflowed, got ${JSON.stringify(edits[0].newText)}`
    );
    assert.ok(
      edits[0].newText.startsWith('{{a}}{{b}}'),
      'both islands must come back byte for byte'
    );
    assert.ok(
      !edits[0].newText.includes('tidytplisland'),
      'no placeholder may ever reach the buffer'
    );
    assert.equal(lastRecord(document).status, 'applied');
  });

  it('replaces exactly the selected span and leaves the rest of the file alone', async () => {
    const before = '<header>{{ site.title }}</header>\n';
    const selected = '<ul><li>{{a}}</li><li>{{b}}</li><li>{{c}}</li></ul>';
    const after = '\n<footer>{{ year }}</footer>';
    const document = new FakeDocument(
      'html',
      before + selected + after,
      '/w/list.html'
    );

    const edits = await formatSelection(
      document,
      before.length,
      before.length + selected.length
    );

    assert.equal(edits.length, 1);
    assert.equal(edits[0].range.start.offset, before.length);
    assert.equal(edits[0].range.end.offset, before.length + selected.length);
    // Every list item reflowed: the drift-length tail is no longer left as-is.
    assert.equal(
      edits[0].newText.split('\n').filter((line) => line.includes('<li>')).length,
      3,
      `every item must be reflowed, got ${JSON.stringify(edits[0].newText)}`
    );
    for (const island of ['{{a}}', '{{b}}', '{{c}}']) {
      assert.ok(edits[0].newText.includes(island), `${island} must stay verbatim`);
    }
    assert.equal(lastRecord(document).scope, 'selection');
  });

  it('a selection with no island keeps its plain behaviour', async () => {
    const source = '<div><p>x</p></div>';
    const document = new FakeDocument('html', source, '/w/plain.html');
    const edits = await formatSelection(document, 0, source.length);
    assert.equal(edits.length, 1);
    assert.ok(edits[0].newText.includes('\n  <p>x</p>\n'));
  });

  /* ------------------------------------------------------------------ */
  /* FIX-B : regions in a selection, and no silent unhonoured marker      */
  /* ------------------------------------------------------------------ */

  it('honours a tidy-ignore region inside a SELECTION (it used to be dropped)', async () => {
    const source =
      '.a{color:red}\n/* tidy-ignore-start */\n.keep{color:red;background:blue}\n/* tidy-ignore-end */\n.b{color:green}';
    const document = new FakeDocument('css', source, '/w/app.css');
    const start = source.indexOf('/* tidy-ignore-start */');

    const edits = await formatSelection(document, start, source.length);

    assert.equal(edits.length, 1, 'the rest of the selection is still formatted');
    assert.ok(
      edits[0].newText.includes('.keep{color:red;background:blue}'),
      `the marked region must keep its exact bytes, got ${JSON.stringify(
        edits[0].newText
      )}`
    );
    assert.ok(
      edits[0].newText.includes('.b {'),
      'the unmarked rule must still be reflowed'
    );
    assert.equal(
      lastRecord(document).detail,
      undefined,
      'a honoured marker needs no notice'
    );
  });

  it('honours a region whose START marker sits ABOVE the selection', async () => {
    const source =
      '/* tidy-ignore-start */\n.keep{color:red}\n.also{color:blue}\n/* tidy-ignore-end */\n.b{color:green}';
    const document = new FakeDocument('css', source, '/w/clip.css');
    const start = source.indexOf('.also');

    const edits = await formatSelection(document, start, source.length);

    assert.equal(edits.length, 1);
    assert.ok(
      edits[0].newText.startsWith('.also{color:blue}'),
      `the clipped region must stay verbatim, got ${JSON.stringify(
        edits[0].newText
      )}`
    );
  });

  it('SAYS SO when a tidy-ignore region is not applied on the Prettier path', async () => {
    const source = 'const  z=0\n/* tidy-ignore-start */\nconst  a=1\n/* tidy-ignore-end */\n';
    const document = new FakeDocument('typescript', source, '/w/app.ts');

    const edits = await formatDocument(document);

    // The behaviour is unchanged (Prettier prints the whole file, including the
    // marked region); what changed is that Tidy no longer keeps quiet about it.
    assert.equal(edits.length, 1);
    assert.ok(
      edits[0].newText.includes('const a = 1;'),
      `the marked region is still printed, got ${JSON.stringify(edits[0].newText)}`
    );

    const notice = state.channelLines.find((line) =>
      line.includes(UNHONOURED_IGNORE_PREFIX)
    );
    assert.ok(notice, `no notice in the channel: ${JSON.stringify(state.channelLines)}`);
    assert.ok(notice.includes('app.ts'), 'the notice names the file');
    assert.ok(notice.includes('prettier-ignore'), 'and names what to use instead');

    const record = lastRecord(document);
    assert.equal(record.status, 'applied');
    assert.ok(
      record.detail?.includes(UNHONOURED_IGNORE_PREFIX),
      `Explain must repeat the notice, got ${JSON.stringify(record.detail)}`
    );
    assert.equal(record.detail, UNHONOURED_IGNORE_PRETTIER_PATH);
  });

  it('stays quiet about a prettier-ignore marker, which Prettier really applies', async () => {
    const source = 'const  z=0\n// prettier-ignore\nconst  a   =   1\n';
    const document = new FakeDocument('typescript', source, '/w/pi.ts');

    await formatDocument(document);

    assert.equal(
      state.channelLines.filter((line) => line.includes(UNHONOURED_IGNORE_PREFIX))
        .length,
      0,
      'nothing is unhonoured here, so nothing may be reported'
    );
  });

  /* ------------------------------------------------------------------ */
  /* FIX-C : the reported engine is the engine that ran                   */
  /* ------------------------------------------------------------------ */

  it('reports jsonc-parser for json and jsonc, the printer that really runs', async () => {
    for (const [languageId, path] of [
      ['json', '/w/data.json'],
      ['jsonc', '/w/data.jsonc']
    ] as const) {
      const document = new FakeDocument(languageId, '{"a":1,"b":[2,3]}', path);
      const edits = await formatDocument(document);
      assert.equal(edits.length, 1, `${languageId} must format`);
      const record = lastRecord(document);
      assert.equal(record.engineId, 'jsonc-parser');
      assert.ok(
        state.channelLines.some((line) => line.includes('[jsonc-parser]')),
        `the channel must name the real printer: ${JSON.stringify(state.channelLines)}`
      );
      assert.ok(
        !state.channelLines.some((line) => line.includes('[js-beautify]')),
        'js-beautify never ran for this file'
      );
      state.channelLines = [];
    }
  });

  it('still reports js-beautify for the families it really prints', async () => {
    const document = new FakeDocument('css', '.a{color:red}', '/w/id.css');
    await formatDocument(document);
    assert.equal(lastRecord(document).engineId, 'js-beautify');
  });

  it('reports prettier for the Prettier path', async () => {
    const document = new FakeDocument('typescript', 'const  a=1\n', '/w/id.ts');
    await formatDocument(document);
    assert.equal(lastRecord(document).engineId, 'prettier');
  });

  /* ------------------------------------------------------------------ */
  /* FIX-D : the verdict does not depend on how much the user selected    */
  /* ------------------------------------------------------------------ */

  /** Apply the single edit a format returned and return the resulting buffer. */
  function bufferAfter(source: string, edits: FakeTextEdit[]): string {
    if (edits.length === 0) {
      return source;
    }
    assert.equal(edits.length, 1, 'the pipeline returns at most one edit');
    return (
      source.slice(0, edits[0].range.start.offset) +
      edits[0].newText +
      source.slice(edits[0].range.end.offset)
    );
  }

  // One tab-indented line inside an element the HTML Rendering spec renders
  // preformatted. Collapsing that tab changes what a reader sees.
  const VERBATIM_BODY = 'alpha\n\tTABBED\n    spaced';

  const VERBATIM_SELECTIONS: Array<[string, string, string, string]> = [
    ['pre', '<div>\n<pre>', VERBATIM_BODY, '</pre>\n</div>'],
    ['textarea', '<div>\n<textarea>', VERBATIM_BODY, '</textarea>\n</div>'],
    // The standard code-block markup: the verbatim ancestor is the GRANDparent.
    ['pre><code', '<pre><code>', VERBATIM_BODY, '</code></pre>'],
    ['xmp', '<div>\n<xmp>', VERBATIM_BODY, '</xmp>\n</div>'],
    ['listing', '<div>\n<listing>', VERBATIM_BODY, '</listing>\n</div>'],
    // <plaintext> consumes the rest of the file: no closing tag, no tail.
    ['plaintext', '<div>\n<plaintext>', VERBATIM_BODY, '']
  ];

  for (const [name, before, body, after] of VERBATIM_SELECTIONS) {
    it(`refuses a SELECTION that collapses rendered whitespace inside <${name}>`, async () => {
      // Before the fix, htmlShape started the walk with "not inside a verbatim
      // element", which is a lie for a selection whose ancestors are <pre>. The
      // engine returned 'alpha\nTABBED\nspaced', the guard called it equivalent,
      // and Format Selection silently destroyed the indentation of a code block.
      const source = before + body + after;
      const slug = name.replace(/[^a-z]+/g, '-');
      const document = new FakeDocument('html', source, `/w/sel-${slug}.html`);

      const edits = await formatSelection(
        document,
        before.length,
        before.length + body.length
      );

      const result = bufferAfter(source, edits);
      assert.ok(
        result.includes(body),
        `the rendered text changed: ${JSON.stringify(result)}`
      );
      assert.ok(
        !result.includes('alpha\nTABBED'),
        'the exact pre-fix corruption must be impossible'
      );
      if (edits.length > 0) {
        return; // an edit that kept the body byte-for-byte is fine.
      }
      const record = lastRecord(document);
      assert.equal(record.status, 'guard-rejected');
      assert.equal(record.scope, 'selection');
      assert.equal(state.warnings.length, 1, 'the user is told, once');
    });

    it(`gives <${name}> the SAME answer at document scope and at selection scope`, async () => {
      // The scope-independence property itself: the same file, the same rendered
      // text, whichever command the user reached for.
      const source = before + body + after;
      const slug = name.replace(/[^a-z]+/g, '-');
      const document = new FakeDocument('html', source, `/w/both-${slug}.html`);

      const documentResult = bufferAfter(source, await formatDocument(document));
      const selectionResult = bufferAfter(
        source,
        await formatSelection(document, before.length, before.length + body.length)
      );

      assert.ok(
        documentResult.includes(body),
        `document scope changed the rendered text: ${JSON.stringify(documentResult)}`
      );
      assert.ok(
        selectionResult.includes(body),
        `selection scope changed the rendered text: ${JSON.stringify(selectionResult)}`
      );
    });
  }

  it('still formats a selection that is NOT in a verbatim context', async () => {
    // The fix must not degenerate into "refuse selections": the same document
    // carries a <pre> the selection does not sit in, and the selection formats.
    const before = '<pre>keep\n\tme</pre>\n<section>\n';
    const selected = '<ul><li>a</li><li>b</li></ul>';
    const after = '\n</section>';
    const source = before + selected + after;
    const document = new FakeDocument('html', source, '/w/ok-selection.html');

    const edits = await formatSelection(
      document,
      before.length,
      before.length + selected.length
    );

    assert.equal(edits.length, 1, 'a legitimate selection must still be formatted');
    assert.ok(
      edits[0].newText.includes('\n  <li>a</li>\n'),
      `the selection must be reflowed, got ${JSON.stringify(edits[0].newText)}`
    );
    assert.equal(lastRecord(document).status, 'applied');
    assert.equal(state.warnings.length, 0, 'nothing to warn about here');
    // And the untouched <pre> above it is outside the replaced span, so it
    // cannot have moved.
    assert.equal(edits[0].range.start.offset, before.length);
  });

  it('a whole-document format is handed the guard exactly what it always was', async () => {
    // Document scope has no surrounding context, so the guard question is
    // byte-for-byte the pre-fix one: this locks the fix to selections only.
    const source = '<div><p>x</p></div>';
    const document = new FakeDocument('html', source, '/w/doc-context.html');
    const edits = await formatDocument(document);
    assert.equal(edits.length, 1);
    assert.equal(edits[0].range.start.offset, 0);
    assert.equal(edits[0].range.end.offset, source.length);
    assert.equal(lastRecord(document).status, 'applied');
  });

  /* ------------------------------------------------------------------ */
  /* FIX-G : JSX text whitespace, and xml:space, at BOTH scopes           */
  /* ------------------------------------------------------------------ */

  // Prettier collapses an interior run of spaces inside JSX text. Babel keeps
  // that run verbatim, so the collapse changes the string the file COMPILES to
  // (an i18n key, a React Native <Text>, anything a <pre> later draws). Tidy
  // refuses it. What is asserted here is not only THAT it refuses but that it
  // refuses the same way whichever command the user reached for, and that the
  // sentence the user reads names the real cause instead of "AST structure
  // changed".
  const JSX_DOUBLE_SPACE = 'export const A = () => <Trans>Hello  world</Trans>;\n';

  for (const scope of ['document', 'selection'] as const) {
    it(`refuses a ${scope} format that collapses a run of spaces in JSX text`, async () => {
      const document = new FakeDocument(
        'typescriptreact',
        JSX_DOUBLE_SPACE,
        `/w/jsx-${scope}.tsx`
      );

      const edits =
        scope === 'document'
          ? await formatDocument(document)
          : await formatSelection(document, 0, JSX_DOUBLE_SPACE.length);

      assert.equal(bufferAfter(JSX_DOUBLE_SPACE, edits), JSX_DOUBLE_SPACE);
      const record = lastRecord(document);
      assert.equal(record.status, 'guard-rejected');
      assert.equal(record.scope, scope);
      assert.equal(
        record.detail,
        JSX_TEXT_WHITESPACE_REASON,
        'the rejection must name JSX text whitespace, not "AST structure changed"'
      );
    });
  }

  it('the JSX whitespace sentence survives the sanitizer whole', () => {
    // sanitizeDetail keeps the first line and clamps at 200 characters with a
    // trailing "...". A sentence that got truncated would stop being an
    // explanation, so the constant is held under the clamp on purpose.
    assert.ok(
      JSX_TEXT_WHITESPACE_REASON.length <= 200,
      `the reason must fit the 200-character clamp (got ${JSX_TEXT_WHITESPACE_REASON.length})`
    );
    assert.ok(
      !JSX_TEXT_WHITESPACE_REASON.includes('\n'),
      'the reason must stay single-line'
    );
  });

  it('still applies a JSX format that touches no text run', async () => {
    // The strictness must not degenerate into "refuse every .tsx": the same
    // language, a real reformat, applied.
    const source = 'export const A = ()=>   <Trans>Hello world</Trans>;\n';
    const document = new FakeDocument('typescriptreact', source, '/w/jsx-ok.tsx');
    const edits = await formatDocument(document);
    assert.equal(edits.length, 1, 'a legitimate JSX reformat must still be applied');
    assert.equal(lastRecord(document).status, 'applied');
  });

  // SVG 1.1 §5.9 draws EVERY space character under xml:space="preserve", and no
  // tag list can see that: the tag is an ordinary <text>. js-beautify collapses
  // the run, so this is a correct REJECTION (the attribute cannot be expressed
  // in js-beautify's tag-keyed content_unformatted).
  const SVG_PRESERVE_HEAD = '<div>\n<svg><text x="0" y="10" xml:space="preserve">';
  const SVG_PRESERVE_BODY = 'A  B';
  const SVG_PRESERVE_TAIL = '</text></svg>\n</div>';
  const SVG_PRESERVE =
    SVG_PRESERVE_HEAD + SVG_PRESERVE_BODY + SVG_PRESERVE_TAIL;

  it('refuses a DOCUMENT format that collapses a run under xml:space="preserve"', async () => {
    const document = new FakeDocument('html', SVG_PRESERVE, '/w/svg-doc.html');
    const result = bufferAfter(SVG_PRESERVE, await formatDocument(document));
    assert.ok(
      result.includes(SVG_PRESERVE_BODY),
      `the drawn text changed: ${JSON.stringify(result)}`
    );
  });

  it('refuses a SELECTION of the preserved text itself (context comes from the document)', async () => {
    // The selection is just "A  B": read as a context-free fragment it is a
    // bare text node whose whitespace looks insignificant. The provider splices
    // it back under its <text xml:space="preserve"> before asking, so selection
    // scope and document scope get the same answer.
    const document = new FakeDocument('html', SVG_PRESERVE, '/w/svg-sel.html');
    const edits = await formatSelection(
      document,
      SVG_PRESERVE_HEAD.length,
      SVG_PRESERVE_HEAD.length + SVG_PRESERVE_BODY.length
    );
    const result = bufferAfter(SVG_PRESERVE, edits);
    assert.ok(
      result.includes(SVG_PRESERVE_BODY),
      `the drawn text changed: ${JSON.stringify(result)}`
    );
  });

  it('still formats an SVG whose text is NOT under xml:space="preserve"', async () => {
    // xml:space="default" is the collapsing behaviour, so nothing here is
    // byte-significant and the file must still format.
    const source = '<div>\n<svg><text xml:space="default">A  B</text></svg>\n</div>';
    const document = new FakeDocument('html', source, '/w/svg-default.html');
    const edits = await formatDocument(document);
    assert.equal(lastRecord(document).status, edits.length > 0 ? 'applied' : 'already-tidy');
    assert.notEqual(
      lastRecord(document).status,
      'guard-rejected',
      'xml:space="default" must not be treated as preserved'
    );
  });

  /* ------------------------------------------------------------------ */
  /* FIX-E : the reported engine is content-aware, like the routing       */
  /* ------------------------------------------------------------------ */

  // A .js file whose JSX makes the dispatcher re-route to Prettier. The old
  // reportedEngineId asked the content-BLIND pickEngine, so the output channel,
  // the status bar and Explain Last Format all named js-beautify, a library that
  // did not run on this file.
  const JSX_IN_A_JS_FILE =
    'const  App=()=>{\nreturn <div className="x">{items.map(i=><Item key={i} />)}</div>\n}\n';

  it('reports prettier for a .js that really is printed by Prettier (JSX)', async () => {
    const document = new FakeDocument('javascript', JSX_IN_A_JS_FILE, '/w/app.js');

    const edits = await formatDocument(document);

    assert.equal(edits.length, 1, 'the file must format');
    assert.equal(
      lastRecord(document).engineId,
      'prettier',
      'js-beautify never touched this file'
    );
    assert.ok(
      state.channelLines.some((line) => line.includes('[prettier]')),
      `the channel must name the real printer: ${JSON.stringify(state.channelLines)}`
    );
    assert.ok(
      !state.channelLines.some((line) => line.includes('[js-beautify]')),
      'and must not name the one that did not run'
    );
  });

  it('reports the same engine for a SELECTION of that same .js', async () => {
    const document = new FakeDocument('javascript', JSX_IN_A_JS_FILE, '/w/app2.js');
    await formatSelection(document, 0, JSX_IN_A_JS_FILE.length);
    assert.equal(lastRecord(document).engineId, 'prettier');
  });

  /* ------------------------------------------------------------------ */
  /* FIX-F : front matter is protected whatever the scope of the request  */
  /* ------------------------------------------------------------------ */

  it('keeps HTML front matter byte for byte during Format SELECTION', async () => {
    // The auditor's reproduction, at the seam where it actually bites: a range
    // request. Nested keys and a block scalar are exactly what js-beautify
    // destroys, and exactly what the HTML guard cannot see.
    const frontMatter =
      '---\nauthor:\n  name: Ada\n  role: admin\nbody: |\n  line one\n    indented two\n---';
    const source = frontMatter + '\n<div>\n<p>x</p>\n</div>\n';
    const document = new FakeDocument('html', source, '/w/post.html');

    const edits = await formatSelection(document, 0, source.length);

    assert.equal(edits.length, 1, 'the selection is still formatted');
    assert.ok(
      edits[0].newText.startsWith(frontMatter),
      `the front matter must survive a selection format, got ${JSON.stringify(
        edits[0].newText.slice(0, 90)
      )}`
    );
    assert.ok(
      edits[0].newText.includes('<p>x</p>'),
      'and the body must still be reflowed'
    );
    assert.ok(
      !edits[0].newText.includes('__TIDY_IGNORE_PLACEHOLDER_'),
      'no placeholder may ever reach the buffer'
    );
    assert.equal(lastRecord(document).status, 'applied');
  });

  it('protects the front matter of a selection that starts INSIDE it', async () => {
    // formatOnSaveMode "modifications" sends exactly this shape after an edit in
    // the YAML: a range with no head '---' line of its own. Only the DOCUMENT
    // knows these bytes are front matter, which is why the provider passes it.
    const frontMatter = '---\nauthor:\n  name: Ada\n  role: admin\n---';
    const source = frontMatter + '\n<div>\n<p>x</p>\n</div>\n';
    const document = new FakeDocument('html', source, '/w/inside.html');
    const start = source.indexOf('  name: Ada');

    const edits = await formatSelection(document, start, source.length);

    const applied =
      edits.length === 0
        ? source
        : source.slice(0, start) + edits[0].newText + source.slice(source.length);
    assert.ok(
      applied.startsWith(frontMatter),
      `the clipped block must stay verbatim, got ${JSON.stringify(
        applied.slice(0, 90)
      )}`
    );
  });

  it('still formats a selection whose head --- is not the document front matter', async () => {
    // The mirror image: over-protecting would silently freeze real markup. A ---
    // block below the first line is not front matter, and the document says so.
    const source = '<h1>hi</h1>\n---\na: 1\n---\n<div>\n<p>x</p>\n</div>';
    const document = new FakeDocument('html', source, '/w/notfm.html');
    const start = source.indexOf('---');

    const edits = await formatSelection(document, start, source.length);

    assert.equal(edits.length, 1, 'this selection must still be formatted');
    assert.notEqual(edits[0].newText, source.slice(start));
  });

  it('still reports js-beautify for a plain .js with no JSX', async () => {
    const document = new FakeDocument(
      'javascript',
      'const  a=1\nfunction  f( ){return  a}\n',
      '/w/plain.js'
    );
    await formatDocument(document);
    assert.equal(lastRecord(document).engineId, 'js-beautify');
  });

  it('reports js-beautify for JSX-LOOKING but non-JSX .js (a<b comparison)', async () => {
    // The detector confirms with a real parse, and the report follows it: no
    // over-correction into "anything with an angle bracket is Prettier".
    const document = new FakeDocument(
      'javascript',
      'const  ok = a < b && c > d;\n',
      '/w/cmp.js'
    );
    await formatDocument(document);
    assert.equal(lastRecord(document).engineId, 'js-beautify');
  });

  /* ------------------------------------------------------------------ */
  /* G3-4 / M3-3 : a selection keeps its OWN edge whitespace              */
  /* ------------------------------------------------------------------ */
  //
  // The one rank-1 defect of v0.4.0 that was reachable AND wrote a
  // non-equivalent result. js-beautify trims the edges of the slice it is
  // handed; the bytes on either side stay in the buffer, so the trim JOINS the
  // slice to its neighbour. The HTML guard cannot see it: a whitespace-only
  // text node between two inline elements is exactly what it normalises away,
  // so it says EQUIVALENT and the edit is applied. Measured end to end before
  // the fix:
  //
  //   DOC  "<p>hello <b>x</b> \n<i>y</i></p>"   selection [0,19)
  //   engine gets "<p>hello <b>x</b>"
  //   RESULT      "<p>hello <b>x</b><i>y</i></p>"   guard ACCEPT
  //   renders     "hello x y"  ->  "hello xy"
  //
  // 353 of 7266 plausible selections over five ordinary HTML snippets wrote a
  // changed rendering; 0 at document scope. So it is purely a range-path
  // defect, and it is closed on the PROVIDER side: the guard is untouched.

  /** Apply the edits of a format to the document text they were built from. */
  function applyEdits(text: string, edits: FakeTextEdit[]): string {
    let out = text;
    for (const edit of [...edits].sort(
      (a, b) => b.range.start.offset - a.range.start.offset
    )) {
      out =
        out.slice(0, edit.range.start.offset) +
        edit.newText +
        out.slice(edit.range.end.offset);
    }
    return out;
  }

  /** Offsets of whole lines [firstLine, lastLine], including the final EOL. */
  function lineSpan(
    text: string,
    firstLine: number,
    lastLine: number
  ): { start: number; end: number } {
    const starts: number[] = [0];
    for (let i = 0; i < text.length; i += 1) {
      if (text[i] === '\n') {
        starts.push(i + 1);
      }
    }
    const start = starts[Math.min(firstLine, starts.length - 1)];
    const end = lastLine + 1 < starts.length ? starts[lastLine + 1] : text.length;
    return { start, end };
  }

  it('THE FINDING: a trimmed trailing run used to render "hello x y" as "hello xy"', async () => {
    const source = '<p>hello <b>x</b> \n<i>y</i></p>';
    const document = new FakeDocument('html', source, '/w/edge.html');

    const edits = await formatSelection(document, 0, 19);
    const applied = applyEdits(source, edits);

    assert.ok(
      applied.includes('</b> \n<i>') || applied.includes('</b> \n  <i>'),
      `the whitespace between the two inline elements must survive, got ${JSON.stringify(applied)}`
    );
    assert.ok(
      !applied.includes('</b><i>'),
      `the two inline elements were joined: ${JSON.stringify(applied)}`
    );
  });

  it('THE FINDING: a slice with a leading AND a trailing space keeps both', async () => {
    const source = '<p>hello <b>x</b> world</p>';
    const document = new FakeDocument('html', source, '/w/edge2.html');

    const edits = await formatSelection(document, 8, 18);
    const applied = applyEdits(source, edits);

    assert.equal(
      applied,
      source,
      `nothing to reflow here, so nothing may be written: ${JSON.stringify(applied)}`
    );
  });

  it('a whitespace-only selection is never collapsed', async () => {
    // That run IS a rendered space. Collapsing it changes what the reader sees
    // and the guard calls it equivalent.
    const source = '<p>a <b>x</b>   <i>y</i> b</p>';
    const start = source.indexOf('</b>') + '</b>'.length;
    const end = source.indexOf('<i>');
    const document = new FakeDocument('html', source, '/w/blank.html');

    const edits = await formatSelection(document, start, end);

    assert.equal(applyEdits(source, edits), source);
  });

  it('the selection is still really formatted: the edge rule is not a no-op switch', async () => {
    const source = '<div>\n<div><p>x</p></div>\n</div>';
    const start = source.indexOf('<div><p>');
    const end = source.indexOf('</div>\n</div>') + '</div>'.length;
    const document = new FakeDocument('html', source, '/w/live.html');

    const edits = await formatSelection(document, start, end);

    assert.equal(edits.length, 1, 'a reflowable selection must still be formatted');
    assert.ok(
      edits[0].newText.includes('\n  <p>x</p>\n'),
      `the content must be reflowed, got ${JSON.stringify(edits[0].newText)}`
    );
    assert.equal(lastRecord(document).status, 'applied');
  });

  it('composes with the mask coordinate mapping: islands AND edges both survive', async () => {
    // The edge rule runs AFTER the island restore, in the CALLER's coordinate
    // space, so engineSpanFor is untouched by it (FIX-A stays fixed).
    const before = '<p>head</p>\n';
    const selected = ' {{a}}<div><p>x</p></div>{{b}} \n';
    const after = '<p>tail</p>\n';
    const source = before + selected + after;
    const document = new FakeDocument('html', source, '/w/islands.html');

    const edits = await formatSelection(
      document,
      before.length,
      before.length + selected.length
    );

    const written = edits.length === 0 ? selected : edits[0].newText;
    assert.ok(
      written.startsWith(' '),
      `the leading run must survive, got ${JSON.stringify(written)}`
    );
    assert.ok(
      written.endsWith(' \n'),
      `the trailing run must survive, got ${JSON.stringify(written)}`
    );
    for (const island of ['{{a}}', '{{b}}']) {
      assert.ok(written.includes(island), `${island} must stay verbatim`);
    }
    assert.ok(
      !written.includes('tidytplisland'),
      'no placeholder may ever reach the buffer'
    );
  });

  it('composes with a selection that STARTS inside a protected island', async () => {
    const source =
      '<div>\n  <%\n    out.write(total);\n  %> \n  <p>tail</p>\n</div>\n';
    const start = source.indexOf('    out.write');
    const end = source.indexOf('  <p>tail');
    const document = new FakeDocument('html', source, '/w/cut.html');

    const edits = await formatSelection(document, start, end);
    const applied = applyEdits(source, edits);

    assert.ok(
      applied.includes('<%\n    out.write(total);\n  %>'),
      `the island must survive verbatim, got ${JSON.stringify(applied)}`
    );
    assert.ok(
      applied.includes('%> \n'),
      `the slice trailing run must survive, got ${JSON.stringify(applied)}`
    );
  });

  it('composes with a selection that ENDS inside a protected ignore region', async () => {
    const source =
      '<p>a</p>\n<!-- tidy-ignore-start -->\n<div   >keep</div   >\n<!-- tidy-ignore-end -->\n<p>b</p>\n';
    const start = 0;
    const end = source.indexOf('keep');
    const document = new FakeDocument('html', source, '/w/region.html');

    const edits = await formatSelection(document, start, end);
    const applied = applyEdits(source, edits);

    assert.ok(
      applied.includes('<div   >keep</div   >'),
      `the protected bytes must be verbatim, got ${JSON.stringify(applied)}`
    );
  });

  it('leaves a whole-DOCUMENT format alone: the rule is scoped to a selection', async () => {
    // A document's edges ARE the file's edges; the final-newline policy owns
    // them, and this rule must not fight it.
    const source = '\n<div><p>x</p></div>\n\n';
    const document = new FakeDocument('html', source, '/w/doc.html');

    const edits = await formatDocument(document);

    assert.equal(edits.length, 1, 'the document is still formatted');
    assert.ok(
      !edits[0].newText.startsWith('\n'),
      `a document format still trims its own head, got ${JSON.stringify(edits[0].newText)}`
    );
  });

  const CONVERGENCE_FRAMINGS: ReadonlyArray<{
    lang: string;
    id: string;
    source: string;
    firstLine: number;
    lastLine: number;
  }> = [
    {
      lang: 'javascript',
      id: 'first line',
      source: 'const a={x:1};\nconst b=2;\n',
      firstLine: 0,
      lastLine: 0
    },
    {
      lang: 'javascript',
      id: 'inner line, framed both sides',
      source: 'let z=0;\nfunction f(){return 1;}\nlet w=1;\n',
      firstLine: 1,
      lastLine: 1
    },
    {
      lang: 'html',
      id: 'first line',
      source: '<div><p>a</p></div>\n<span>b</span>\n',
      firstLine: 0,
      lastLine: 0
    },
    {
      lang: 'json',
      id: 'first line',
      source: '{"a":1,\n"b":2}\n',
      firstLine: 0,
      lastLine: 0
    },
    {
      lang: 'css',
      id: 'first line',
      source: '.a{color:red}\n.b{color:blue}\n',
      firstLine: 0,
      lastLine: 0
    },
    {
      lang: 'css',
      id: 'inner line, framed both sides',
      source: 'body{margin:0}\n.a{color:red}\n.b{color:blue}\n',
      firstLine: 1,
      lastLine: 1
    }
  ];

  for (const framing of CONVERGENCE_FRAMINGS) {
    it(`M3-3 ${framing.lang} (${framing.id}): Format Selection converges on pass 2`, async () => {
      // A LINE-ANCHORED selection is what Format Selection on whole lines and
      // editor.formatOnSaveMode "modifications" both send, so the slice keeps
      // ending in a line break on every pass. Before the fix the printer kept
      // stripping it and the splice kept gluing the next line on: edits
      // 1,1,1,1,1,1 with pass3 == pass5 and pass4 == pass6.
      let text = framing.source;
      const states: string[] = [];
      const editCounts: number[] = [];
      for (let pass = 0; pass < 6; pass += 1) {
        const span = lineSpan(text, framing.firstLine, framing.lastLine);
        const document = new FakeDocument(
          framing.lang,
          text,
          `/w/converge-${framing.lang}`
        );
        // eslint-disable-next-line no-await-in-loop
        const edits = await formatSelection(document, span.start, span.end);
        editCounts.push(edits.length);
        text = applyEdits(text, edits);
        states.push(text);
      }
      assert.deepEqual(
        editCounts.slice(1),
        [0, 0, 0, 0, 0],
        `pass 2 onwards must produce no edit, got ${editCounts.join(',')} ` +
          `with states ${JSON.stringify(states)}`
      );
      for (let pass = 1; pass < states.length; pass += 1) {
        assert.equal(states[pass], states[0], `pass ${pass + 1} drifted`);
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* v0.4.1 : the EOL a write really carries, at the provider seam        */
  /* ------------------------------------------------------------------ */

  // The engine-level matrix lives in test/unit/engine/prettierEol.test.ts. What
  // is asserted HERE is the byte that would reach the buffer: the stub reports
  // an untrusted workspace and answers every configuration read with its
  // fallback, which is exactly the defect configuration (files.eol unset, so
  // endOfLine undefined, and insertFinalNewline unset).

  /** Lone LF: the only kind that can make a CRLF document mixed. */
  const countLoneLf = (text: string): number =>
    (text.match(/(?<!\r)\n/g) ?? []).length;

  const CRLF_DOCUMENTS: Array<[string, string, string]> = [
    ['typescript', 'const  a:number=1\r\nfunction  f(){\r\nreturn a\r\n}\r\n', '.ts'],
    [
      'typescriptreact',
      'const  a=<div>hi</div>\r\nfunction  g(){\r\nreturn a\r\n}\r\nexport default g\r\n',
      '.tsx'
    ],
    [
      'javascriptreact',
      'const  a=<div>hi</div>\r\nfunction  g(){\r\nreturn a\r\n}\r\nexport default g\r\n',
      '.jsx'
    ],
    ['css', '.a  {\r\ncolor:red\r\n}\r\n.b{\r\ncolor:blue\r\n}\r\n', '.css']
  ];

  for (const [lang, source, extension] of CRLF_DOCUMENTS) {
    it(`writes CRLF back into a CRLF ${extension} when files.eol is unset`, async () => {
      // Before the fix the three Prettier languages returned the WHOLE document
      // rewritten to LF here, and the .css beside them did not: one extension,
      // two answers for one project.
      const document = new FakeDocument(lang, source, `/w/crlf${extension}`);

      const edits = await formatDocument(document);
      const result = bufferAfter(source, edits);

      assert.equal(
        countLoneLf(result),
        0,
        `the document was rewritten to LF: ${JSON.stringify(result)}`
      );
      assert.ok(result.includes('\r\n'), 'the CRLFs must still be there');
      assert.notEqual(
        lastRecord(document).status,
        'guard-rejected',
        'and the file must still actually format'
      );
    });
  }

  /* ------------------------------------------------------------------ */
  /* v0.4.1 : the abort toast stops accusing a file the verifier never    */
  /*          looked at                                                   */
  /* ------------------------------------------------------------------ */

  // One shared ABORT_WARNING_MESSAGE used to cover BOTH a guard rejection and an
  // engine error. So a TypeScript selection that straddles a template literal,
  // which Prettier cannot parse as a standalone unit, told the user "the result
  // could not be proven equivalent to your original" while the output channel
  // correctly recorded engine-error with "Unterminated template literal". The
  // verifier never ran; claiming a verdict about the user's code is a false
  // accusation, the same defect class v0.4.0 fixed for chunk-load failures.
  //
  // ZERO edits happen on either branch, so what is under test here is WORDING,
  // not behaviour: the edit counts and the recorded statuses below are exactly
  // what they were before.

  /** A document whose first line opens a template literal the next line closes. */
  const STRADDLED_TEMPLATE =
    'const message = `hello\nworld`;\nconst other = 1;\n';
  /** The selection: line 1 only, so the literal is cut in half. */
  const STRADDLE_SELECTION_END = STRADDLED_TEMPLATE.indexOf('\n');

  it('an ENGINE error says the formatter could not read the code, not that the file failed verification', async () => {
    const document = new FakeDocument(
      'typescript',
      STRADDLED_TEMPLATE,
      '/w/straddle.ts'
    );

    const edits = await formatSelection(document, 0, STRADDLE_SELECTION_END);

    // Unchanged behaviour: nothing is written, and the record is what it was.
    assert.equal(edits.length, 0, 'an engine error must still write nothing');
    const record = lastRecord(document);
    assert.equal(record.status, 'engine-error');
    assert.equal(record.scope, 'selection');
    assert.ok(
      record.detail?.startsWith('engine error:'),
      `the channel must still record the real cause, got ${JSON.stringify(record.detail)}`
    );

    // The fix: the toast now matches the record.
    assert.equal(state.warnings.length, 1, 'the user is told, once');
    assert.equal(state.warnings[0], providers.ENGINE_ERROR_WARNING_MESSAGE);
    assert.notEqual(
      state.warnings[0],
      providers.ABORT_WARNING_MESSAGE,
      'an engine error must not claim an equivalence verdict exists'
    );
    assert.ok(
      !state.warnings[0].includes('could not be proven equivalent'),
      'the false accusation must be gone from this branch entirely'
    );
    // And it names the normal, innocent cause the user most likely hit.
    assert.ok(
      /selection/i.test(state.warnings[0]),
      `the message must explain a partial selection, got ${JSON.stringify(state.warnings[0])}`
    );
  });

  it('a real GUARD rejection still says the result could not be proven equivalent', async () => {
    // The other branch, unchanged: here the guard really did return a verdict.
    const document = new FakeDocument(
      'typescriptreact',
      JSX_DOUBLE_SPACE,
      '/w/verdict-branch.tsx'
    );

    const edits = await formatDocument(document);

    assert.equal(edits.length, 0);
    assert.equal(lastRecord(document).status, 'guard-rejected');
    assert.equal(state.warnings.length, 1);
    assert.equal(state.warnings[0], providers.ABORT_WARNING_MESSAGE);
  });

  it('the engine-error toast never carries a byte of the user code', async () => {
    // The engine message names the offending token from the file (Prettier's
    // first line is "Unterminated template literal. (1:23)"), which is why the
    // detail goes through sanitizeDetail to the output channel and the toast
    // stays a constant. A leak here would be a privacy regression, not a
    // wording one.
    const document = new FakeDocument(
      'typescript',
      'const secretName = `topsecret\nvalue`;\n',
      '/w/leak.ts'
    );

    await formatSelection(document, 0, 'const secretName = `topsecret'.length);

    assert.equal(state.warnings.length, 1);
    for (const leak of ['secretName', 'topsecret', 'Unterminated', '`']) {
      assert.ok(
        !state.warnings[0].includes(leak),
        `the toast leaked ${JSON.stringify(leak)}: ${JSON.stringify(state.warnings[0])}`
      );
    }
  });

  it('both abort branches keep the same two action buttons', async () => {
    // ADD-06's one-click remedies are wording-independent: splitting the message
    // must not have dropped a remedy on either branch.
    const engineError = new FakeDocument(
      'typescript',
      STRADDLED_TEMPLATE,
      '/w/buttons-engine.ts'
    );
    await formatSelection(engineError, 0, STRADDLE_SELECTION_END);
    assert.deepEqual(state.warningActions[0], ['Explain', 'Report Issue']);

    const guardRejection = new FakeDocument(
      'typescriptreact',
      JSX_DOUBLE_SPACE,
      '/w/buttons-guard.tsx'
    );
    await formatDocument(guardRejection);
    assert.deepEqual(state.warningActions[1], ['Explain', 'Report Issue']);
  });

  it('the four messages are distinct, English, em-dash-free and all reassure', () => {
    const engine = providers.ENGINE_ERROR_WARNING_MESSAGE;
    const verdict = providers.ABORT_WARNING_MESSAGE;
    const tagSplit = providers.TAG_SPLIT_WARNING_MESSAGE;
    const ignoreOutside = providers.IGNORE_OUTSIDE_SELECTION_WARNING_MESSAGE;
    assert.equal(
      new Set([engine, verdict, tagSplit, ignoreOutside]).size,
      4,
      'splitting them is the whole point'
    );
    for (const message of [engine, verdict, tagSplit, ignoreOutside]) {
      assert.ok(
        message.startsWith('Tidy did not apply the format:'),
        `both must open the same way, got ${JSON.stringify(message)}`
      );
      assert.ok(
        message.endsWith('Your file is intact.'),
        `both must still reassure, got ${JSON.stringify(message)}`
      );
      // The escape, never the codepoint: this repository ships ZERO real U+2014
      // bytes, and a test asserting their absence must not be the file that
      // introduces one.
      assert.ok(
        !message.includes('\u2014'),
        'no em dash may reach a shipped string'
      );
      // Printable ASCII only: the v0.3.0 string migration's practical test.
      assert.ok(/^[\x20-\x7e]+$/.test(message), 'the message must be plain ASCII');
    }
  });

  /* ------------------------------------------------------------------ */
  /* A SELECTION whose boundary falls inside a TAG is refused outright    */
  /* ------------------------------------------------------------------ */
  //
  // The regression this patch created. Putting the slice's own leading
  // whitespace run back (the G3-4 rule above) REPAIRS a start tag the selection
  // cut in half, so the engine's repair is no longer a tree change for the guard
  // to reject. What reaches the guard instead is a line break the engine
  // inserted between two ADJACENT INLINE elements: a whitespace-only text node,
  // exactly what the HTML guard normalises away. Accept, write, and the reader
  // sees a different text.
  //
  //   DOC  '<div class="row"><button\n  class="btn">Save</button><button ...'
  //   Format Selection [24,53)
  //   at 4a72a32 : guard-rejected, "HTML tree changed after formatting", 0 edits
  //   with the edge rule and no refusal : APPLIED, writing '...Save</button>\n<button'
  //   Chromium innerText 'SaveCancel' -> 'Save Cancel' (box 103.89px -> 111.59px)
  //
  // Sweeping every selection of four ordinary snippets: 14 cells of 10141 turned
  // from a rejection into a write that changed the rendered text (5/4560, 1/1326,
  // 3/1770, 5/2485), and all 441 rendering-changing writes in that corpus have a
  // boundary inside a tag. The refusal removes every one of them and removes NO
  // write whose two boundaries were well formed.

  const ROW_BUTTONS =
    '<div class="row"><button\n  class="btn">Save</button><button\n  class="btn">Cancel</button></div>';

  it('THE REGRESSION: a selection that cuts a tag is refused, with zero edits', async () => {
    const document = new FakeDocument('html', ROW_BUTTONS, '/w/row.html');

    const edits = await formatSelection(document, 24, 53);

    assert.equal(edits.length, 0, 'zero edits: the file must stay byte-identical');
    const record = lastRecord(document);
    assert.equal(record.scope, 'selection');
    // No engine ran and no guard verdict exists: the record must not claim one.
    assert.equal(record.status, 'engine-error');
    assert.ok(
      record.detail?.startsWith('selection boundary inside a tag'),
      `the reason must be explainable, got ${JSON.stringify(record.detail)}`
    );
  });

  it('THE REGRESSION: and the two inline elements are never joined by a break', async () => {
    const document = new FakeDocument('html', ROW_BUTTONS, '/w/row2.html');

    const applied = applyEdits(ROW_BUTTONS, await formatSelection(document, 24, 53));

    assert.equal(applied, ROW_BUTTONS, 'nothing may be written at all');
    assert.ok(
      !/<\/button>\s+<button/.test(applied),
      `the buttons were separated by whitespace: ${JSON.stringify(applied)}`
    );
  });

  it('says WHICH selection to make, with the usual two remedies', async () => {
    const document = new FakeDocument('html', ROW_BUTTONS, '/w/row3.html');

    await formatSelection(document, 24, 53);

    assert.deepEqual(state.warnings, [providers.TAG_SPLIT_WARNING_MESSAGE]);
    assert.deepEqual(state.warningActions[0], ['Explain', 'Report Issue']);
    assert.ok(
      providers.TAG_SPLIT_WARNING_MESSAGE.includes('Select whole elements'),
      'the message must say what to do instead'
    );
  });

  it('reproduces on <nav><a> and <p><span>, the other two shapes', async () => {
    const shapes: ReadonlyArray<[string, string, number, number]> = [
      ['nav', '<nav><a\n href="/a1">A</a><a\n href="/b1">B</a></nav>', 7, 26],
      ['spans', '<p><span\n class="xx">a</span><span\n class="yy">b</span></p>', 8, 30]
    ];
    for (const [name, source, start, end] of shapes) {
      const document = new FakeDocument('html', source, `/w/${name}.html`);
      // eslint-disable-next-line no-await-in-loop
      const edits = await formatSelection(document, start, end);
      assert.equal(edits.length, 0, `${name} must be refused`);
      assert.equal(lastRecord(document).status, 'engine-error');
    }
  });

  it('leaves DOCUMENT scope alone: the same file still formats', async () => {
    // The defect is a statement about a selection BOUNDARY, and a whole document
    // has none of its own. Refusing here would break Format Document on any file
    // with a multi-line tag, which is most real HTML.
    const document = new FakeDocument('html', ROW_BUTTONS, '/w/row-doc.html');

    const edits = await formatDocument(document);

    assert.equal(edits.length, 1, 'the document must still be formatted');
    assert.equal(lastRecord(document).status, 'applied');
    assert.ok(
      edits[0].newText.includes('Save</button><button'),
      `the buttons must stay adjacent, got ${JSON.stringify(edits[0].newText)}`
    );
    assert.equal(state.warnings.length, 0, 'nothing to warn about at document scope');
  });

  it('is not a "refuse selections" switch: a well-formed one still formats', async () => {
    const source = '<div><p>x</p></div>';
    const document = new FakeDocument('html', source, '/w/wellformed.html');

    const edits = await formatSelection(document, 0, source.length);

    assert.equal(edits.length, 1);
    assert.ok(edits[0].newText.includes('\n  <p>x</p>\n'));
    assert.equal(lastRecord(document).status, 'applied');
    assert.equal(state.warnings.length, 0);
  });

  it('refuses a boundary in a TAG only when the format would really write', async () => {
    // Two conditions, and BOTH are needed. Refusing on the boundary alone was
    // over-broad: most boundaries inside markup produce no edit at all, and
    // turning those into a warning toast is noise on a silent no-op. Only a
    // format that would write can carry the defect the rule exists for.
    const inText = new FakeDocument('html', ROW_BUTTONS, '/w/in-text.html');
    await formatSelection(inText, 40, 52); // inside 'Save', then just past '</button>'
    assert.notEqual(lastRecord(inText).status, 'engine-error');

    // Boundary inside a tag AND the pipeline wants to write: refused, zero edits.
    const inTag = new FakeDocument('html', ROW_BUTTONS, '/w/in-tag.html');
    const refused = await formatSelection(inTag, 24, 53);
    assert.equal(lastRecord(inTag).status, 'engine-error');
    assert.equal(refused.length, 0, 'a refusal writes nothing');

    // Boundary inside a tag but nothing to change: stays a silent no-op, with no
    // warning, exactly as it behaved before the rule existed.
    const quiet = new FakeDocument('html', ROW_BUTTONS, '/w/quiet.html');
    const before = state.warnings.length;
    const noEdits = await formatSelection(quiet, 24, 52);
    assert.equal(noEdits.length, 0);
    assert.notEqual(lastRecord(quiet).status, 'engine-error');
    assert.equal(
      state.warnings.length,
      before,
      'a selection that changes nothing must not raise a toast'
    );
  });

  it('is scoped to HTML: a JSX selection cutting a tag gets the engine answer', async () => {
    // Other languages have their own "not a complete piece of code" path, and it
    // must not be overwritten by a statement about markup.
    const source = 'const a = <div\n  className="x">hi</div>;\n';
    const document = new FakeDocument('typescriptreact', source, '/w/cut.tsx');

    await formatSelection(document, source.indexOf('\n  className'), source.indexOf('hi'));

    assert.ok(
      !state.warnings.includes(providers.TAG_SPLIT_WARNING_MESSAGE),
      'the HTML refusal must not fire on a JSX file'
    );
    assert.ok(
      !lastRecord(document).detail?.startsWith('selection boundary inside a tag'),
      'nor may it be recorded there'
    );
  });

  /* ------------------------------------------------------------------ */
  /* M3-1: a selection never drops a prettier-ignore it cannot see        */
  /* ------------------------------------------------------------------ */
  //
  // Prettier honours `// prettier-ignore` natively, but a selection format hands
  // it ONLY the selected text. A directive above the node it protects, outside
  // the selection, is not in what Prettier parses, so the node was reprinted as
  // if it had none, and the guard said "equivalent" (the change is whitespace).
  // Interim rule until a selection is formatted against the whole document:
  // REFUSE that one shape, zero edits, and tell the user to use Format Document.
  // Only a format that would WRITE is refused; everything that does not involve a
  // prettier-ignore node behaves exactly as before.

  const IGNORED_MATRIX =
    'const matrix = [\n  1,0,0,\n  0,1,0,\n  0,0,1\n];';
  const IGNORE_SOURCE =
    'const  a   =   1;\n// prettier-ignore\n' + IGNORED_MATRIX + '\nconst  b   =   2;\n';
  const ignoreAt = IGNORE_SOURCE.indexOf('// prettier-ignore');
  const matrixAt = IGNORE_SOURCE.indexOf('const matrix');
  const matrixEnd = matrixAt + IGNORED_MATRIX.length;

  it('M3-1: refuses a selection over the node, with the directive left outside', async () => {
    const document = new FakeDocument('typescriptreact', IGNORE_SOURCE, '/w/ig1.tsx');

    const edits = await formatSelection(document, matrixAt, IGNORE_SOURCE.length);

    assert.equal(edits.length, 0, 'zero edits: the protected node must stay as written');
    const record = lastRecord(document);
    assert.equal(record.scope, 'selection');
    // The provider decided this itself: no guard verdict exists to report.
    assert.equal(record.status, 'engine-error');
    assert.equal(record.detail, providers.IGNORE_OUTSIDE_SELECTION_REASON);
    assert.equal(record.engineId, 'prettier');
  });

  it('M3-1: the buffer is byte-identical afterwards, protected node included', async () => {
    const document = new FakeDocument('typescriptreact', IGNORE_SOURCE, '/w/ig2.tsx');

    const applied = applyEdits(
      IGNORE_SOURCE,
      await formatSelection(document, matrixAt, matrixEnd)
    );

    assert.equal(applied, IGNORE_SOURCE);
    assert.ok(applied.includes(IGNORED_MATRIX));
  });

  it('M3-1: says to use Format Document, with the usual two remedies', async () => {
    const document = new FakeDocument('typescriptreact', IGNORE_SOURCE, '/w/ig3.tsx');

    await formatSelection(document, matrixAt, IGNORE_SOURCE.length);

    assert.deepEqual(state.warnings, [providers.IGNORE_OUTSIDE_SELECTION_WARNING_MESSAGE]);
    assert.deepEqual(state.warningActions[0], ['Explain', 'Report Issue']);
    assert.ok(
      providers.IGNORE_OUTSIDE_SELECTION_WARNING_MESSAGE.includes('Use Format Document'),
      'the message must say what to do instead'
    );
  });

  it('M3-1: the same file still formats at DOCUMENT scope, and the node survives', async () => {
    // The directive is in view of a whole-document format, which is the remedy.
    const document = new FakeDocument('typescriptreact', IGNORE_SOURCE, '/w/ig4.tsx');

    const edits = await formatDocument(document);

    assert.equal(edits.length, 1, 'the document must still be formatted');
    assert.ok(edits[0].newText.includes(IGNORED_MATRIX), 'the node stays as written');
    assert.ok(edits[0].newText.includes('const a = 1;'), 'and the rest is formatted');
    assert.equal(state.warnings.length, 0);
  });

  it('M3-1: a selection that includes the directive is left to Prettier and keeps the node', async () => {
    const document = new FakeDocument('typescriptreact', IGNORE_SOURCE, '/w/ig5.tsx');

    const edits = await formatSelection(document, ignoreAt, IGNORE_SOURCE.length);

    assert.equal(edits.length, 1, 'nothing to refuse: the directive is in the text');
    assert.ok(edits[0].newText.includes(IGNORED_MATRIX), 'Prettier honours it');
    assert.ok(edits[0].newText.includes('const b = 2;'));
    assert.equal(state.warnings.length, 0);
    assert.equal(lastRecord(document).status, 'applied');
  });

  it('M3-1: a selection that does not touch the node is not refused', async () => {
    const document = new FakeDocument('typescriptreact', IGNORE_SOURCE, '/w/ig6.tsx');

    const edits = await formatSelection(document, 0, IGNORE_SOURCE.indexOf('\n') + 1);

    assert.equal(edits.length, 1);
    assert.ok(edits[0].newText.includes('const a = 1;'));
    assert.equal(state.warnings.length, 0);
    assert.equal(lastRecord(document).status, 'applied');
  });

  it('M3-1: a selection after the node is not refused either', async () => {
    const document = new FakeDocument('typescriptreact', IGNORE_SOURCE, '/w/ig7.tsx');

    const edits = await formatSelection(document, IGNORE_SOURCE.indexOf('const  b'), IGNORE_SOURCE.length);

    assert.equal(edits.length, 1);
    assert.ok(edits[0].newText.includes('const b = 2;'));
    assert.equal(state.warnings.length, 0);
  });

  it('M3-1: only a WRITE is refused: a selection that changes nothing stays a quiet no-op', async () => {
    const source = 'const  z   =   0;\n// prettier-ignore\nconst b = 2;\n';
    const document = new FakeDocument('typescript', source, '/w/ig8.ts');

    const edits = await formatSelection(
      document,
      source.indexOf('const b'),
      source.indexOf('const b') + 'const b = 2;'.length
    );

    assert.equal(edits.length, 0);
    assert.equal(lastRecord(document).status, 'already-tidy');
    assert.equal(state.warnings.length, 0, 'no toast for a format that writes nothing');
  });

  it('M3-1: an abort keeps its own, more specific reason', async () => {
    // A selection that cannot be parsed stays an engine error, not a refusal.
    const source =
      'const  z   =   0;\n// prettier-ignore\nconst  a   =   [1,\n 2];\nconst  b   =   [3,\n 4];\n';
    const document = new FakeDocument('typescript', source, '/w/ig9.ts');

    const edits = await formatSelection(document, source.indexOf(' 2];'), source.length);

    assert.equal(edits.length, 0);
    assert.equal(lastRecord(document).status, 'engine-error');
    assert.notEqual(lastRecord(document).detail, providers.IGNORE_OUTSIDE_SELECTION_REASON);
    assert.ok(!state.warnings.includes(providers.IGNORE_OUTSIDE_SELECTION_WARNING_MESSAGE));
  });

  it('M3-1: a selection INSIDE the protected node is refused when it would write', async () => {
    const source =
      'const  z   =   1;\n// prettier-ignore\nfunction keep() {\n  const  p   =   [1,0,\n     0,1];\n  return   p\n}\n';
    const document = new FakeDocument('typescript', source, '/w/ig10.ts');
    const start = source.indexOf('const  p');
    const end = source.indexOf('return   p') + 'return   p'.length;

    const edits = await formatSelection(document, start, end);

    assert.equal(edits.length, 0);
    assert.equal(applyEdits(source, edits), source);
    assert.ok(
      lastRecord(document).detail === providers.IGNORE_OUTSIDE_SELECTION_REASON ||
        lastRecord(document).status === 'engine-error',
      'refused by this rule, or by the engine if the slice does not parse'
    );
  });

  it('M3-1: a trailing directive governs the node before it', async () => {
    const source = 'const  a   =   [1,0,\n 0,1]; // prettier-ignore\nconst  b   =   2;\n';
    const document = new FakeDocument('typescript', source, '/w/ig11.ts');

    const edits = await formatSelection(document, 0, source.indexOf('// prettier-ignore') - 1);

    assert.equal(edits.length, 0, 'the directive is outside the selection: refused');
    assert.equal(lastRecord(document).detail, providers.IGNORE_OUTSIDE_SELECTION_REASON);
  });

  it('M3-1: a .jsx is on the Prettier path too', async () => {
    const jsxSource =
      'const  a   =   <div/>;\n// prettier-ignore\n' +
      IGNORED_MATRIX +
      '\nconst  z   =   <p   x = "1">y</p>;\n';
    const document = new FakeDocument('javascriptreact', jsxSource, '/w/ig12.jsx');

    const edits = await formatSelection(
      document,
      jsxSource.indexOf('const matrix'),
      jsxSource.length
    );

    assert.equal(edits.length, 0, 'javascriptreact must be refused');
    assert.equal(lastRecord(document).engineId, 'prettier');
    assert.equal(lastRecord(document).detail, providers.IGNORE_OUTSIDE_SELECTION_REASON);
  });

  it('M3-1: a .js on the Prettier path keeps a node its own mask already protects', async () => {
    // A .js selection masks the marker line and the first line of the node it
    // marks, whichever printer runs. A one-line node is therefore put back byte
    // for byte even with the directive outside the selection, so refusing it
    // would be a false refusal of something that works.
    const source =
      'const  a   =   <div/>;\n// prettier-ignore\nconst   keep   =   [1,0,  0,1];\nconst  z   =   <p   x = "1">y</p>;\n';
    const document = new FakeDocument('javascript', source, '/w/ig12.js');

    const edits = await formatSelection(
      document,
      source.indexOf('const   keep'),
      source.length
    );

    assert.equal(edits.length, 1);
    assert.equal(lastRecord(document).engineId, 'prettier', 'the JSX in the selection routes it');
    assert.ok(edits[0].newText.includes('const   keep   =   [1,0,  0,1];'), 'verbatim');
    assert.ok(edits[0].newText.includes('<p x="1">y</p>'), 'and the JSX is formatted');
    assert.equal(state.warnings.length, 0);
  });

  it('M3-1: a .js selection that js-beautify prints is untouched by the rule', async () => {
    // No JSX in the selected text, so the printer that runs is js-beautify, whose
    // own mask handles in-source markers. Behaviour is exactly what it was.
    const source = 'var  a   =   1;\n// prettier-ignore\nvar  keep   =   [1,0,\n 0,1];\nvar  b   =   2;\n';
    const document = new FakeDocument('javascript', source, '/w/ig13.js');

    await formatSelection(document, source.indexOf('var  keep'), source.length);

    assert.ok(!state.warnings.includes(providers.IGNORE_OUTSIDE_SELECTION_WARNING_MESSAGE));
    assert.notEqual(lastRecord(document).engineId, 'prettier');
    assert.notEqual(lastRecord(document).detail, providers.IGNORE_OUTSIDE_SELECTION_REASON);
  });

  it('M3-1: a comment that only mentions prettier-ignore does not refuse anything', async () => {
    const source =
      'const  a   =   1;\n// prettier-ignore because the matrix reads better\n' +
      IGNORED_MATRIX +
      '\n';
    const document = new FakeDocument('typescript', source, '/w/ig14.ts');

    const edits = await formatSelection(document, source.indexOf('const matrix'), source.length);

    assert.equal(edits.length, 1, 'not a directive, so the node is formatted as usual');
    assert.equal(state.warnings.length, 0);
  });

  it('M3-1: CSS and the other js-beautify families never meet the rule', async () => {
    const source = '.a{color:red}\n/* prettier-ignore */\n.b{color:blue}\n';
    const document = new FakeDocument('css', source, '/w/ig15.css');

    await formatSelection(document, source.indexOf('.b'), source.length);

    assert.ok(!state.warnings.includes(providers.IGNORE_OUTSIDE_SELECTION_WARNING_MESSAGE));
    assert.notEqual(lastRecord(document).detail, providers.IGNORE_OUTSIDE_SELECTION_REASON);
  });

  for (const fault of ['unchecked', 'throw'] as const) {
    it(`M3-1: a check that cannot run (${fault}) is reported, never silently trusted`, async () => {
      // The directive lies outside the selection and the check could not tell
      // what it governs. The format goes ahead exactly as before the rule
      // existed (fail-open on the new rule only: the guard has already judged the
      // write), and the user is told why it was not checked.
      state.ignoreCheckFault = fault;
      const source =
        'const  z   =   0;\n// prettier-ignore\nconst  a   =   [1,\n 2];\nconst  b   =   3;\n';
      const document = new FakeDocument('typescript', source, `/w/ig16-${fault}.ts`);

      const edits = await formatSelection(
        document,
        source.indexOf('const  b'),
        source.length
      );

      assert.equal(edits.length, 1, 'behaviour unchanged when the check cannot run');
      assert.equal(lastRecord(document).status, 'applied');
      assert.ok(
        lastRecord(document).detail?.includes(providers.IGNORE_UNCHECKED_NOTICE),
        `Explain must repeat the notice, got ${JSON.stringify(lastRecord(document).detail)}`
      );
      assert.ok(
        state.channelLines.some((line) => line.includes(providers.IGNORE_UNCHECKED_NOTICE)),
        'and the output channel carries it'
      );
      assert.equal(state.warnings.length, 0, 'a notice, not a toast');
    });
  }

  it('M3-1: a document the guard cannot parse is the guards call, before the rule is asked', async () => {
    // The check parses with the guard's own plugin set, so a document it cannot
    // read is one the guard has already rejected: no write, no refusal, no notice.
    const source =
      'const  z   =   0;\n// prettier-ignore\nconst  a   =   1;\nconst  b   =   2;\n}}}\n';
    const document = new FakeDocument('typescript', source, '/w/ig16-guard.ts');

    const edits = await formatSelection(
      document,
      source.indexOf('const  b'),
      source.indexOf('\n}}}')
    );

    assert.equal(edits.length, 0);
    assert.equal(lastRecord(document).status, 'guard-rejected');
    assert.ok(
      !state.channelLines.some((line) => line.includes(providers.IGNORE_UNCHECKED_NOTICE))
    );
  });

  it('M3-1: a file without the directive pays nothing and behaves as before', async () => {
    const source = 'const  a   =   1;\nconst  b   =   2;\n';
    const document = new FakeDocument('typescript', source, '/w/ig17.ts');

    const edits = await formatSelection(document, 0, source.length);

    assert.equal(edits.length, 1);
    assert.equal(lastRecord(document).detail, undefined);
    assert.equal(state.warnings.length, 0);
  });

  it('M3-1: the refusal text is English, ASCII, em-dash free and content-free', () => {
    for (const text of [
      providers.IGNORE_OUTSIDE_SELECTION_WARNING_MESSAGE,
      providers.IGNORE_OUTSIDE_SELECTION_REASON,
      providers.IGNORE_UNCHECKED_NOTICE
    ]) {
      assert.ok(/^[\x20-\x7e]+$/.test(text), `plain ASCII only: ${text}`);
      assert.ok(!text.includes(String.fromCharCode(0x2014)));
      assert.ok(text.length < 400);
    }
    assert.ok(providers.IGNORE_OUTSIDE_SELECTION_REASON.length < 200, 'survives sanitizeDetail');
    assert.ok(providers.IGNORE_UNCHECKED_NOTICE.length < 200, 'survives sanitizeDetail');
  });

  /* ------------------------------------------------------------------ */
  /* A CR-only document is never left MIXED (both engine families)        */
  /* ------------------------------------------------------------------ */
  //
  // The final-newline terminator was chosen with /\r\n/ alone, so a bare-CR
  // document got an LF glued onto its last line: a whitespace-only difference,
  // "equivalent" to the guard, WRITTEN. New for the Prettier family with this
  // patch (it used to return uniform LF) and pre-existing for js-beautify.

  const CR_ONLY: ReadonlyArray<[string, string, string]> = [
    ['js-beautify', 'css', '.a{color:red}\r.b{color:blue}'],
    ['prettier', 'typescript', 'const  a=1\rconst  b=2']
  ];

  for (const [family, lang, source] of CR_ONLY) {
    it(`keeps a CR-only document uniform on the ${family} path`, async () => {
      state.files.insertFinalNewline = true;
      const document = new FakeDocument(lang, source, `/w/cr-${lang}`);

      const edits = await formatDocument(document);
      const applied = applyEdits(source, edits);

      assert.ok(
        !applied.includes('\n'),
        `a lone LF was glued onto a CR-only file: ${JSON.stringify(applied)}`
      );
      assert.ok(
        applied.endsWith('\r'),
        `insertFinalNewline must still add one: ${JSON.stringify(applied)}`
      );
    });
  }

  it('restores a CR-only final newline as CR when nobody asked for one', async () => {
    const source = '.a{color:red}\r';
    const document = new FakeDocument('css', source, '/w/cr-restore.css');

    const applied = applyEdits(source, await formatDocument(document));

    assert.ok(!applied.includes('\n'), `got ${JSON.stringify(applied)}`);
    assert.ok(applied.endsWith('\r'), `got ${JSON.stringify(applied)}`);
  });

  /* ------------------------------------------------------------------ */
  /* An EXPLICIT files.eol owns the restored slice edges too              */
  /* ------------------------------------------------------------------ */
  //
  // The edge rule put the slice's own runs back byte for byte, which is right
  // when the user has said nothing and wrong when they have: the engine converts
  // the slice's INTERIOR to the requested ending and a verbatim edge keeps the
  // old one, so a full-span Format Selection wrote a MIXED slice. That is
  // defect C-04's shape, and the guard cannot see it. 251 of 7491 selections
  // over seven documents x three settings, 9 of 21 of them full-span.

  /** Distinct line-ending styles in a text. */
  function eolStyles(text: string): string[] {
    return [...new Set(text.match(/\r\n|\r|\n/g) ?? [])];
  }

  const EOL_CASES: ReadonlyArray<[string, string, string, string, number, number]> = [
    ['js-beautify full span, crlf file, files.eol lf', 'css', '.a{color:red}\r\n.b{color:blue}\r\n', '\n', 0, 31],
    ['js-beautify full span, lf file, files.eol crlf', 'css', '.a{color:red}\n.b{color:blue}\n', '\r\n', 0, 29],
    ['js-beautify partial, crlf file, files.eol lf', 'css', '.a{color:red}\r\n.b{color:blue}\r\n', '\n', 0, 15],
    ['html full span, crlf file, files.eol lf', 'html', '<div>\r\n<p>x</p>\r\n</div>\r\n', '\n', 0, 25],
    ['prettier full span, crlf file, files.eol lf', 'typescript', 'const  a=1\r\nconst  b=2\r\n', '\n', 0, 24],
    ['prettier full span, lf file, files.eol crlf', 'typescript', 'const  a=1\nconst  b=2\n', '\r\n', 0, 22],
    ['prettier partial, crlf file, files.eol lf', 'typescript', 'const  a=1\r\nconst  b=2\r\n', '\n', 0, 12]
  ];

  for (const [name, lang, source, eol, start, end] of EOL_CASES) {
    it(`writes ONE line-ending style: ${name}`, async () => {
      state.files.eol = eol;
      const document = new FakeDocument(lang, source, `/w/eol-${name.replace(/W+/g, "-")}`);

      const edits = await formatSelection(document, start, end);

      assert.equal(edits.length, 1, 'the selection must still be formatted');
      assert.deepEqual(
        eolStyles(edits[0].newText),
        [eol],
        `the written span is mixed: ${JSON.stringify(edits[0].newText)}`
      );
    });
  }

  it('an UNSET files.eol still puts the edge bytes back verbatim', async () => {
    // "The user has not said" is exactly when keeping the document's own bytes
    // is the right rule, and that half of the edge promise must not move.
    const source = '.a{color:red}\r\n.b{color:blue}\r\n';
    const document = new FakeDocument('css', source, '/w/eol-unset.css');

    const edits = await formatSelection(document, 0, source.length);

    assert.equal(edits.length, 1);
    assert.ok(
      edits[0].newText.endsWith('\r\n'),
      `the slice trailing run must survive: ${JSON.stringify(edits[0].newText)}`
    );
  });

  it('an explicit files.eol does not disturb a whitespace-only selection', async () => {
    // No content was printed, so there is no converted interior for a restored
    // edge to disagree with, and in HTML that run IS a rendered space.
    const source = '<p>a <b>x</b>\r\n<i>y</i> b</p>';
    const start = source.indexOf('</b>') + '</b>'.length;
    const end = source.indexOf('<i>');
    state.files.eol = '\n';
    const document = new FakeDocument('html', source, '/w/eol-blank.html');

    const edits = await formatSelection(document, start, end);

    assert.equal(applyEdits(source, edits), source);
  });

  /* ------------------------------------------------------------------ */
  /* ...but an explicit files.eol stops at a PROTECTED span               */
  /* ------------------------------------------------------------------ */
  //
  // The rule above owns the slice's OWN whitespace. When a slice edge run
  // reaches into a span the mask restored VERBATIM moments earlier, normalising
  // it rewrote line endings INSIDE an ignore region or a template island:
  //
  //   src        "<div>\n<!-- tidy-ignore-start -->\n  <b>  k  </b>\n" ...
  //   selection  [0,48), files.eol = crlf
  //   before     "...</b>\n<!-- tidy-ignore-end -->"    protected bytes verbatim
  //   the defect "...</b>\r\n<!-- tidy-ignore-end -->"  an LF rewritten INSIDE
  //
  // No meaning changed, so it was not a corruption and the guard accepted it.
  // README and CHANGELOG both promise those bytes come back BYTE FOR BYTE, and a
  // documented guarantee that is quietly false is the defect class v0.4.0 was
  // spent eliminating. 54 occurrences over two documents in the campaign; an
  // exhaustive paired sweep of 27 705 selection x files.eol cells (all three
  // settings) found 242 and now finds none, with the same 507 guard rejections
  // and the same 17 556 refusals on both sides.

  /** The document of the defect report: a tidy-ignore region, LF throughout. */
  const REGION_DOC =
    '<div>\n<!-- tidy-ignore-start -->\n  <b>  k  </b>\n<!-- tidy-ignore-end -->\n</div>';
  /** The bytes that region PROMISES to hand back untouched. */
  const REGION_BYTES = '<!-- tidy-ignore-start -->\n  <b>  k  </b>\n';
  /** A multi-line <% %> island: the same defect, the other protecting layer. */
  const ISLAND_DOC = '<div>\n<% if (x) {\n  go();\n} %>\n</div>';

  it('THE DEFECT: a trailing run INSIDE an ignore region keeps its line ending', async () => {
    state.files.eol = '\r\n';
    const document = new FakeDocument('html', REGION_DOC, '/w/protected-region.html');

    const edits = await formatSelection(document, 0, 48);

    assert.equal(edits.length, 1, 'the selection is still formatted');
    assert.ok(
      edits[0].newText.includes(REGION_BYTES),
      `the protected bytes must come back verbatim, got ${JSON.stringify(
        edits[0].newText
      )}`
    );
    assert.ok(
      edits[0].newText.endsWith('</b>\n'),
      `the edge run inside the region must stay LF, got ${JSON.stringify(
        edits[0].newText
      )}`
    );
    // ...and the line ending OUTSIDE the region still follows the user: the fix
    // is not "skip normalisation whenever a mask exists".
    assert.ok(
      edits[0].newText.startsWith('<div>\r\n'),
      `the slice own line ending must follow files.eol, got ${JSON.stringify(
        edits[0].newText
      )}`
    );
  });

  it('the mirror case: an explicit LF leaves a protected CRLF alone', async () => {
    const source =
      '<div>\r\n<!-- tidy-ignore-start -->\r\n  <b>  k  </b>\r\n<!-- tidy-ignore-end -->\r\n</div>';
    state.files.eol = '\n';
    const document = new FakeDocument('html', source, '/w/protected-region-crlf.html');

    const edits = await formatSelection(document, 0, 51);

    assert.equal(edits.length, 1);
    assert.ok(
      edits[0].newText.includes('<!-- tidy-ignore-start -->\r\n  <b>  k  </b>\r\n'),
      `the protected CRLFs must survive, got ${JSON.stringify(edits[0].newText)}`
    );
    assert.ok(
      edits[0].newText.startsWith('<div>\n'),
      `the slice own line ending must follow files.eol, got ${JSON.stringify(
        edits[0].newText
      )}`
    );
  });

  for (const eol of ['\n', undefined]) {
    const label = eol === undefined ? 'unset' : 'lf';
    it(`leaves the region untouched with files.eol ${label}`, async () => {
      if (eol !== undefined) state.files.eol = eol;
      const document = new FakeDocument(
        'html',
        REGION_DOC,
        `/w/protected-region-${label}.html`
      );

      const edits = await formatSelection(document, 0, 48);

      assert.ok(
        applyEdits(REGION_DOC, edits).includes(REGION_BYTES),
        'the protected bytes must survive whatever the setting says'
      );
    });
  }

  for (const [label, eol] of [
    ['crlf', '\r\n'],
    ['lf', '\n'],
    ['unset', undefined]
  ] as const) {
    it(`a trailing run inside a TEMPLATE ISLAND keeps its bytes (files.eol ${label})`, async () => {
      // [0,18) cuts the island: its clipped part is masked and restored
      // verbatim, and the slice's trailing run is the LF inside it.
      if (eol !== undefined) state.files.eol = eol;
      const document = new FakeDocument(
        'html',
        ISLAND_DOC,
        `/w/protected-island-${label}.html`
      );

      const edits = await formatSelection(document, 0, 18);

      assert.equal(edits.length, 1, 'the selection is still formatted');
      assert.ok(
        edits[0].newText.includes('<% if (x) {\n'),
        `the island bytes must come back verbatim, got ${JSON.stringify(
          edits[0].newText
        )}`
      );
    });
  }

  it('ADJACENT BUT OUTSIDE: the line ending after an island still follows files.eol', async () => {
    // The proof that the fix is precise rather than blunt. The trailing run is
    // the LF just PAST '%>', so it is the slice's own whitespace and the user's
    // setting owns it, while the island's interior stays byte for byte.
    state.files.eol = '\r\n';
    const document = new FakeDocument('html', ISLAND_DOC, '/w/island-adjacent.html');

    const edits = await formatSelection(document, 0, 31);

    assert.equal(edits.length, 1);
    assert.ok(
      edits[0].newText.endsWith('} %>\r\n'),
      `the run outside the island must be normalised, got ${JSON.stringify(
        edits[0].newText
      )}`
    );
    assert.ok(
      edits[0].newText.includes('<% if (x) {\n  go();\n} %>'),
      `the island itself must stay verbatim, got ${JSON.stringify(edits[0].newText)}`
    );
  });

  for (const [label, eol, expected] of [
    ['crlf', '\r\n', '<div>\r\n  <p>x</p>\r\n'],
    ['lf', '\n', '<div>\n  <p>x</p>\n'],
    ['unset', undefined, '<div>\n  <p>x</p>\n']
  ] as const) {
    it(`NO protected span: the edge rule is exactly what it was (files.eol ${label})`, async () => {
      const source = '<div>\n<p>x</p>\n</div>';
      if (eol !== undefined) state.files.eol = eol;
      const document = new FakeDocument('html', source, `/w/no-protection-${label}.html`);

      const edits = await formatSelection(document, 0, 15);

      assert.equal(edits.length, 1);
      assert.equal(edits[0].newText, expected);
    });
  }
});
