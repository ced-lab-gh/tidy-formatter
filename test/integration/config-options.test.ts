// Configurability integration tests — Axe 3 ("not enough options"), real host.
//
// These run inside a real VS Code Electron host (via @vscode/test-cli) and prove
// END-TO-END — through the actual provider + config-reading pipeline, not the
// pure unit path — the two configurability claims the roadmap (AXE 3) makes:
//
//   (1) A `tidy.*` option set at WORKSPACE scope actually changes Tidy's output
//       AND the result is idempotent (a second Format Document is a no-op). We
//       prove it for a Prettier stylistic option (tidy.prettier.singleQuote) and
//       for a js-beautify option (tidy.preserve_newlines on JavaScript) —
//       covering both engine families behind a single guard.
//
//   (2) A project `.soukformatrc` (JSONC) at the workspace root drives the style
//       (layer 4) with NO VS Code setting involved, and stays idempotent — the
//       "project config file" deliverable lonefy never had.
//
// Design notes (mirroring lifecycle.test.ts):
//  - We drive only the public surface (Format Document + workspace settings +
//    an on-disk .soukformatrc). A green run is a true end-to-end proof.
//  - Assertions compare a STABLE feature of the output (a single-quote string,
//    a collapsed blank line, an indent width) rather than a brittle golden, so an
//    engine bump cannot make these flaky.
//  - Every throwaway fixture and the root .soukformatrc are removed in `after`,
//    and Workspace settings are restored, so the suite is order-independent and
//    never pollutes the fixture workspace (both are also .gitignored).
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  activateExtension,
  clearTouchedConfig,
  ensureTidyDefaultFormatter,
  flushEventLoop,
  openFixture,
  runFormatDocument,
  setTidyConfig,
  workspaceRoot
} from './helpers';

describe('Tidy configurability (AXE 3) — options drive output end-to-end', function () {
  // Cold Electron host + per-language formatter readiness needs headroom.
  this.timeout(30000);

  const LANGS = ['css', 'typescript', 'javascript'];

  let restoreFormatter: (() => Promise<void>) | undefined;
  let restoreFns: Array<() => Promise<void>> = [];

  before(async () => {
    await activateExtension();
    // Make Tidy the resolved per-language default formatter (and wait until it is
    // actually resolvable) so Format Document drives Tidy, not a no-op.
    restoreFormatter = await ensureTidyDefaultFormatter(LANGS);
  });

  afterEach(async () => {
    for (const restore of restoreFns.reverse()) {
      await restore();
    }
    restoreFns = [];
    await clearTouchedConfig();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await flushEventLoop();
  });

  after(async () => {
    if (restoreFormatter) {
      await restoreFormatter();
    }
  });

  /** Track a restore disposer so afterEach can roll the setting back. */
  function track(restore: () => Promise<void>): void {
    restoreFns.push(restore);
  }

  /**
   * Show the document, run Format Document, and return the resulting text.
   * Re-reads the live document text from the model after the edit settles.
   */
  async function formatAndRead(
    document: vscode.TextDocument
  ): Promise<string> {
    await vscode.window.showTextDocument(document);
    await runFormatDocument();
    return document.getText();
  }

  // (1a) A Prettier stylistic option set at Workspace scope changes the output
  //      AND the result is idempotent. singleQuote=true must turn the double-
  //      quoted string literal into a single-quoted one (guard-safe: same AST).
  it('(1a) tidy.prettier.singleQuote=true at Workspace scope yields single quotes and is idempotent', async () => {
    const source = 'const greeting = "hello world";\n';
    const document = await openFixture(
      'config-options/single-quote.ts',
      source,
      'typescript'
    );

    track(await setTidyConfig('prettier.singleQuote', true));
    await flushEventLoop();

    const formatted = await formatAndRead(document);

    // The option took effect: the literal is now single-quoted, the double-quoted
    // form is gone. (Stable feature assertion, not a brittle golden.)
    assert.ok(
      formatted.includes("'hello world'"),
      `singleQuote=true must single-quote the string literal; got:\n${formatted}`
    );
    assert.ok(
      !formatted.includes('"hello world"'),
      `the double-quoted form must be gone after singleQuote=true; got:\n${formatted}`
    );

    // Idempotence: a second Format Document is a no-op (re-parse stable).
    const again = await formatAndRead(document);
    assert.equal(
      again,
      formatted,
      'a second Format Document must be a no-op (idempotent) with singleQuote=true'
    );
  });

  // (1b) A js-beautify option set at Workspace scope changes the output AND the
  //      result is idempotent. preserve_newlines=false must collapse the blank
  //      lines between two JavaScript statements (js-beautify's documented effect).
  it('(1b) tidy.preserve_newlines=false at Workspace scope collapses blank lines and is idempotent', async () => {
    // Two statements separated by blank lines; with preserve_newlines=false the
    // blank lines between them must disappear from the formatted output.
    const source = 'const a = 1;\n\n\nconst b = 2;\n';
    const document = await openFixture(
      'config-options/preserve-newlines.js',
      source,
      'javascript'
    );

    // Baseline: with the default (preserve_newlines=true) the blank lines survive.
    const defaultFormatted = await formatAndRead(document);
    assert.ok(
      /;\n\s*\n/.test(defaultFormatted),
      `precondition: with the default, blank lines between statements survive; got:\n${defaultFormatted}`
    );

    // Now disable newline preservation at Workspace scope and re-format.
    track(await setTidyConfig('preserve_newlines', false));
    await flushEventLoop();

    const collapsed = await formatAndRead(document);

    // The option took effect: no blank line remains between the two statements.
    assert.ok(
      !/;\n\s*\n/.test(collapsed),
      `preserve_newlines=false must collapse the blank lines between statements; got:\n${collapsed}`
    );
    assert.notEqual(
      collapsed,
      defaultFormatted,
      'preserve_newlines=false must change the output vs the default'
    );

    // Idempotence: a second Format Document is a no-op.
    const again = await formatAndRead(document);
    assert.equal(
      again,
      collapsed,
      'a second Format Document must be a no-op (idempotent) with preserve_newlines=false'
    );
  });

  // (2) A project .soukformatrc (JSONC) at the WORKSPACE ROOT drives the style as
  //     layer 4 — WITHOUT any VS Code tidy.* setting — and stays idempotent.
  //     We use the css section to force a 2-space indent (the default is 4) so the
  //     assertion is unambiguous, and JSONC comments to prove the JSONC parser
  //     path is exercised end-to-end.
  it('(2) a root .soukformatrc (JSONC) drives CSS indent and is idempotent — no VS Code setting', async () => {
    const root = workspaceRoot();
    const rcPath = path.join(root, '.soukformatrc');

    // JSONC: line comment + trailing comma, css section sets a 2-space indent.
    const rc =
      '{\n' +
      '  // project formatting config (Axe 3 .soukformatrc, JSONC)\n' +
      '  "css": {\n' +
      '    "indent": 2,\n' + // trailing comma below proves JSONC tolerance
      '  },\n' +
      '}\n';
    fs.writeFileSync(rcPath, rc, 'utf8');
    track(async () => {
      fs.rmSync(rcPath, { force: true });
    });
    // Give the host a tick to settle the new on-disk file before formatting.
    await flushEventLoop();

    // A compact CSS rule Tidy will expand; the indent of the declaration line is
    // what the .soukformatrc must drive to 2 spaces. The trailing ';' is kept so
    // the assertion can anchor on the full "color: red;" declaration.
    const source = 'a{color:red;}\n';
    const document = await openFixture(
      'config-options/souk-indent.css',
      source,
      'css'
    );

    const formatted = await formatAndRead(document);

    // The .soukformatrc took effect: the declaration is indented exactly 2 spaces
    // (not the built-in default of 4), with no VS Code tidy.* setting involved.
    assert.ok(
      /\n {2}color: red;/.test(formatted),
      `.soukformatrc css.indent=2 must produce a 2-space indent; got:\n${formatted}`
    );
    assert.ok(
      !/\n {4}color: red;/.test(formatted),
      `the built-in 4-space default must be overridden by .soukformatrc; got:\n${formatted}`
    );

    // Idempotence: a second Format Document is a no-op.
    const again = await formatAndRead(document);
    assert.equal(
      again,
      formatted,
      'a second Format Document must be a no-op (idempotent) under .soukformatrc'
    );
  });
});
