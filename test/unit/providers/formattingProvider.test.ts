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
  infos: string[];
}

const state: StubState = { channelLines: [], warnings: [], infos: [] };

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
    showWarningMessage(message: string): Promise<undefined> {
      state.warnings.push(message);
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
    getConfiguration(): {
      get(key: string, fallback?: unknown): unknown;
      inspect(): undefined;
    } {
      return {
        get(_key: string, fallback?: unknown): unknown {
          return fallback;
        },
        inspect(): undefined {
          return undefined;
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
}

type LoadFn = (request: string, parent: unknown, isMain: boolean) => unknown;

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
      return originalLoad.call(this, request, parent, isMain);
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
    state.infos = [];
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
});
