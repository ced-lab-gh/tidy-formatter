// ADD-11 lazy chunk boundary, proven INSIDE a real VS Code Electron host.
//
// This is the tier that catches the one failure mode the unit suites are
// structurally blind to. Under mocha + tsx the loader resolves a TypeScript
// SOURCE module, so require('./guardCssChunk') can never fail. In the packaged
// extension the same call becomes require('./chunk-guard-css.js'), resolved next
// to dist/extension.js by the host's own module loader. If that resolution were
// broken, every unit test would still be green while the guard could not run at
// all, and Tidy would refuse to format anything for every user.
//
// So each case here formats a document of a family whose chunk differs, through
// the SAME public path a user drives (editor.action.formatDocument), and asserts
// the document actually changed. A chunk that failed to load would surface as a
// guard/engine abort, which produces ZERO edits: the "document unchanged"
// assertion is exactly the tripwire.
//
// The formats run immediately after activation, well inside the five-second idle
// preload delay, so they exercise the LAZY path rather than the preloaded one.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  activateExtension,
  ensureTidyDefaultFormatter,
  openFixture,
  runFormatDocument
} from './helpers';

// One family per chunk, plus JSON which must need no chunk at all.
const LANGS = ['typescript', 'css', 'html', 'json'];

interface LazyCase {
  readonly note: string;
  readonly lang: string;
  readonly relPath: string;
  readonly content: string;
  /** A token that must survive verbatim: proves the format did not corrupt. */
  readonly preserved: string;
}

const CASES: readonly LazyCase[] = [
  {
    note: 'typescript (chunk-prettier + chunk-guard-js)',
    lang: 'typescript',
    relPath: 'lazy/first.ts',
    content: 'const  a:number=1;\nfunction  f(x:number){return x+a}\n',
    preserved: 'function f(x: number)'
  },
  {
    note: 'css (chunk-guard-css)',
    lang: 'css',
    relPath: 'lazy/first.css',
    content: '.a{color:red}\n',
    preserved: 'color: red'
  },
  {
    // The input MUST be something the formatter really changes. It used to be
    // '<div><span>x</span></div>\n', which is the formatter's exact fixed point:
    // that case only ever produced an edit because js-beautify was dropping the
    // final newline, and this suite was silently asserting on that defect. Once
    // the newline is preserved the format is a legitimate no-op, the pipeline
    // short-circuits before the guard runs, and chunk-guard-html is never
    // loaded, so the case could no longer prove the thing it exists to prove.
    note: 'html (chunk-guard-html)',
    lang: 'html',
    relPath: 'lazy/first.html',
    content: '<div   ><span>x</span></div>\n',
    preserved: '<span>x</span>'
  },
  {
    note: 'json (no chunk at all: jsonc-parser ships in the host bundle)',
    lang: 'json',
    relPath: 'lazy/first.json',
    content: '{"a":1,"b":[2,3]}\n',
    preserved: '"a": 1'
  }
];

describe('ADD-11 : the packaged extension can reach its lazy chunks', () => {
  let restoreFormatters: (() => Promise<void>) | undefined;

  before(async function beforeAll() {
    this.timeout(process.env.CI ? 180000 : 60000);
    await activateExtension();
    restoreFormatters = await ensureTidyDefaultFormatter(LANGS);
  });

  after(async () => {
    if (restoreFormatters) {
      await restoreFormatters();
    }
  });

  for (const testCase of CASES) {
    it(`formats ${testCase.note} right after activation, before the idle preload`, async function run() {
      this.timeout(process.env.CI ? 60000 : 20000);

      const document = await openFixture(
        testCase.relPath,
        testCase.content,
        testCase.lang
      );
      await vscode.window.showTextDocument(document);
      await runFormatDocument();

      const formatted = document.getText();
      // A chunk that could not load means an abort, which means ZERO edits.
      assert.notEqual(
        formatted,
        testCase.content,
        `${testCase.lang}: the document was not changed, which is what a failed ` +
          'chunk load looks like from the outside (guard/engine abort, no edits)'
      );
      assert.ok(
        formatted.includes(testCase.preserved),
        `${testCase.lang}: expected '${testCase.preserved}' to survive, got: ` +
          JSON.stringify(formatted)
      );
    });
  }

  it('a second format is a no-op: the lazily loaded engines are stable', async function run() {
    this.timeout(process.env.CI ? 60000 : 20000);

    const document = await openFixture(
      'lazy/idempotent.css',
      '.a{color:red}\n',
      'css'
    );
    await vscode.window.showTextDocument(document);
    await runFormatDocument();
    const first = document.getText();
    await runFormatDocument();
    assert.equal(document.getText(), first, 'formatting must be idempotent');
  });
});
