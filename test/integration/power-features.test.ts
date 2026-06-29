// Headless power-features integration tests — ROADMAP Axe 4 (T1–T5 + T6 preview).
//
// These run inside a REAL VS Code Electron host (via @vscode/test-cli) on the
// public extension surface — the registered formatting providers (file ignore /
// region masking / native prettier-ignore), the registered tidy.previewFormat
// command, and the PURE deference decision — proving the "strictly better than
// lonefy" differentiators WITHOUT ever weakening the safety guard or the
// anti-hijack contract end to end.
//
// The six guarantees this suite locks down (mapping the task's (a)–(f)):
//   (a) a file matched by .soukformatignore (at the workspace root) is NOT
//       modified by Format Document (byte-identical);
//   (b) a file with a head ignore marker stays intact (whole-file ignore);
//   (c) a REGION between tidy-ignore-start/end is preserved VERBATIM while the
//       rest is reformatted (js-beautify path = CSS; mask/restore + guard);
//   (d) for a TSX file, // prettier-ignore preserves the FOLLOWING node verbatim
//       (native Prettier directive — the documented node-level ignore path);
//   (e) tidy.previewFormat runs READ-ONLY (opening the diff applies no edit), and
//       applying the planned format (one WorkspaceEdit = one undo entry) DOES
//       produce the formatted text — and a single undo restores the original;
//   (f) the deference decision is ONE-SHOT: decide(...) a first time surfaces the
//       notification, a second time (alreadyPrompted) returns 'none'.
//
// SAFETY / ANTI-HIJACK invariants exercised implicitly throughout:
//   - the ignore/region paths return the input VERBATIM, so guard.check accepts
//     and the file can never be corrupted;
//   - nothing here ever writes editor.defaultFormatter as a Tidy reaction — the
//     only defaultFormatter writes are the test harness opting Tidy in (which is
//     exactly the explicit-user-action contract), cleaned up afterwards.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  decide,
  formatDeferenceMessage,
  type DeferenceSetting
} from '../../src/deference/decide';
import { FORMATTER_PRETTIER } from '../../src/deference/detect';
import {
  activateExtension,
  clearTouchedConfig,
  flushEventLoop,
  openFixture,
  runFormatDocument,
  workspaceRoot
} from './helpers';

/** Relative dir holding every fixture this suite writes (cleaned in after()). */
const FIXTURE_DIR = 'power-features';

describe('Tidy power features (Axe 4) — ignore-file / head-marker / region / prettier-ignore / preview / deference', function () {
  this.timeout(30000);

  // The "Tidy does nothing" assertions must go through the REAL Format Document
  // path (editor.action.formatDocument), which honours editor.defaultFormatter —
  // executeFormatDocumentProvider can fall through to another provider when Tidy
  // returns no edits, masking the no-op we mean to prove. So we make Tidy the
  // resolved default formatter for css AND typescriptreact, then compare the
  // document text before/after a real Format Document.
  let restoreDefaultFormatter: () => Promise<void>;
  const createdFiles: string[] = [];

  before(async () => {
    await activateExtension();
    const { ensureTidyDefaultFormatter } = await import('./helpers');
    restoreDefaultFormatter = await ensureTidyDefaultFormatter([
      'css',
      'typescriptreact'
    ]);
  });

  after(async () => {
    await restoreDefaultFormatter();
    // Remove the throwaway fixture tree so it never leaks between runs.
    fs.rmSync(path.join(workspaceRoot(), FIXTURE_DIR), {
      recursive: true,
      force: true
    });
  });

  afterEach(async () => {
    // Each test may write a root .soukformatignore; remove it so the next test
    // starts from a clean workspace (order-independent).
    fs.rmSync(path.join(workspaceRoot(), '.soukformatignore'), { force: true });
    for (const file of createdFiles.splice(0)) {
      fs.rmSync(file, { force: true });
    }
    await clearTouchedConfig();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await flushEventLoop();
  });

  /** Open a fixture under FIXTURE_DIR and track it for afterEach cleanup. */
  async function openTracked(
    relName: string,
    content: string,
    languageId: string
  ): Promise<vscode.TextDocument> {
    const rel = `${FIXTURE_DIR}/${relName}`;
    const doc = await openFixture(rel, content, languageId);
    createdFiles.push(path.join(workspaceRoot(), rel));
    return doc;
  }

  // (a) .soukformatignore at the workspace ROOT excludes a file -> Format Document
  //     leaves it byte-identical. A non-matched sibling still formats (targeted,
  //     not a blanket disable).
  it('(a) a file matched by root .soukformatignore is NOT modified by Format Document', async () => {
    const ignorePath = path.join(workspaceRoot(), '.soukformatignore');
    // Match the whole fixture dir so the ignored fixture is excluded; the sibling
    // proof lives outside that dir to confirm targeting.
    fs.writeFileSync(ignorePath, `${FIXTURE_DIR}/ignored-*.css\n`, 'utf8');

    const ignored = await openTracked('ignored-a.css', 'a{color:red}\n', 'css');
    await vscode.window.showTextDocument(ignored);
    const before = ignored.getText();
    await runFormatDocument();
    assert.equal(
      ignored.getText(),
      before,
      'a file matched by .soukformatignore must be left byte-identical by Format Document'
    );
    assert.ok(
      ignored.getText().includes('a{color:red}'),
      'the unformatted, single-line source must survive verbatim'
    );

    // A sibling NOT matched by the pattern must still reformat (proves the ignore
    // is targeted). We drive the SAME real Format Document path and assert change.
    const formatted = await openTracked('kept-a.css', 'b{color:red}\n', 'css');
    await vscode.window.showTextDocument(formatted);
    const keptBefore = formatted.getText();
    // The provider can be racy on a cold host; poll the real path until it reflows.
    const deadline = Date.now() + 10000;
    while (formatted.getText() === keptBefore && Date.now() < deadline) {
      await runFormatDocument();
    }
    assert.notEqual(
      formatted.getText(),
      keptBefore,
      'a file NOT matched by .soukformatignore must still be formatted'
    );
  });

  // (b) A head ignore marker (whole-file ignore) keeps the document intact.
  it('(b) a file with a head ignore marker stays intact under Format Document', async () => {
    const content = '/* tidy-ignore-file */\nb{color:red}\n';
    const document = await openTracked('head-ignored.css', content, 'css');
    await vscode.window.showTextDocument(document);
    const before = document.getText();
    await runFormatDocument();
    assert.equal(
      document.getText(),
      before,
      'a document with a head ignore marker must be left byte-identical'
    );
    assert.ok(document.getText().includes('b{color:red}'));
  });

  // (c) A REGION between tidy-ignore-start/end is preserved VERBATIM while the
  //     rest of a js-beautify (CSS) document is reformatted.
  it('(c) a tidy-ignore region is preserved verbatim while the rest formats (CSS)', async () => {
    const raw = '.RAW   {  color : blue  ;  margin:0  }';
    const content =
      '.a{color:red}\n' +
      '/* tidy-ignore-start */\n' +
      `${raw}\n` +
      '/* tidy-ignore-end */\n' +
      '.b{color:green}\n';
    const document = await openTracked('region.css', content, 'css');
    await vscode.window.showTextDocument(document);

    await runFormatDocument();
    const result = document.getText();

    assert.ok(
      result.includes(raw),
      'the protected region bytes must survive VERBATIM in the formatted output'
    );
    assert.notEqual(
      result,
      content,
      'the area OUTSIDE the region must be reformatted (protect-AND-restore, not a global no-op)'
    );
  });

  // (d) For a TSX file, // prettier-ignore preserves the FOLLOWING node verbatim
  //     (native Prettier directive), while the rest of the file is reformatted.
  it('(d) // prettier-ignore preserves the next node verbatim in a TSX document', async () => {
    // The ignored node is a matrix literal whose interior spacing Prettier would
    // normally reflow; with the directive, the rows survive byte-for-byte. The
    // surrounding declarations DO get reformatted, proving it is a node-level
    // ignore, not a whole-file one.
    const matrixInterior = '  1,0,0,\n  0,1,0,\n  0,0,1';
    const content =
      'const a={x:1,y:2}\n' +
      '\n' +
      '// prettier-ignore\n' +
      'const matrix=[\n' +
      `${matrixInterior}\n` +
      ']\n' +
      '\n' +
      'const b={p:1,q:2}\n';
    const document = await openTracked('ignore-node.tsx', content, 'typescriptreact');
    await vscode.window.showTextDocument(document);

    // Drive the real Format Document path; poll until Tidy (the resolved default
    // for tsx) reflows the surrounding code on this cold host.
    const before = document.getText();
    const deadline = Date.now() + 10000;
    while (document.getText() === before && Date.now() < deadline) {
      await runFormatDocument();
    }
    const result = document.getText();

    assert.notEqual(
      result,
      before,
      'the TSX document must be reformatted (the rest of the file is not ignored)'
    );
    assert.ok(
      result.includes(matrixInterior),
      'the node after // prettier-ignore must be preserved VERBATIM (native Prettier)'
    );
    assert.ok(
      result.includes('const a = { x: 1, y: 2 }'),
      'a declaration outside the ignored node must actually be reformatted'
    );
  });

  // (e) tidy.previewFormat is read-only (opening the diff writes nothing), and
  //     applying the planned format (one WorkspaceEdit) DOES produce the format,
  //     reversible with a single undo. The "Apply" toast never resolves headless,
  //     so we assert read-only on the command and exercise the SAME single-undo
  //     apply mechanism (one full-range WorkspaceEdit) the command uses on click.
  it('(e) tidy.previewFormat is read-only, then applying produces the format in one undo', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes('tidy.previewFormat'),
      'tidy.previewFormat must be a registered command'
    );

    const original = 'c{color:red}\n';
    const document = await openTracked('preview.css', original, 'css');
    const editor = await vscode.window.showTextDocument(document);
    assert.equal(document.isDirty, false, 'precondition: the document is clean');

    // Fire-and-forget: the handler opens a read-only diff then AWAITS an "Apply"
    // toast that never resolves in a headless host. We must NOT await the command
    // (it would hang). The contract is that merely opening the preview writes
    // NOTHING. Swallow the dangling promise so it is never an unhandled rejection.
    void Promise.resolve(
      vscode.commands.executeCommand('tidy.previewFormat')
    ).catch(() => undefined);
    await flushEventLoop();
    await flushEventLoop();
    assert.equal(
      document.isDirty,
      false,
      'previewing must not modify the document (read-only diff, no write on open)'
    );
    assert.equal(
      document.getText(),
      original,
      'the original document text must be unchanged after opening the preview'
    );

    // Bring the original document back to the foreground (the diff stole focus),
    // then compute what Tidy WOULD apply via the same provider path the preview
    // uses, and apply it as a SINGLE WorkspaceEdit (= one undo entry), mirroring
    // the command's applyFormatted().
    await vscode.window.showTextDocument(document, editor.viewColumn);
    const planned = await vscode.commands.executeCommand<vscode.TextEdit[]>(
      'vscode.executeFormatDocumentProvider',
      document.uri,
      { tabSize: 4, insertSpaces: true }
    );
    assert.ok(
      planned && planned.length > 0,
      'the preview pipeline must have a real, guard-approved change to apply'
    );

    const fullRange = new vscode.Range(
      document.positionAt(0),
      document.positionAt(document.getText().length)
    );
    const formattedText = planned![0].newText;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, fullRange, formattedText);
    const applied = await vscode.workspace.applyEdit(edit);
    await flushEventLoop();

    assert.ok(applied, 'applying the preview WorkspaceEdit must succeed');
    assert.notEqual(
      document.getText(),
      original,
      'applying the preview must PRODUCE the formatted text'
    );
    assert.equal(
      document.getText(),
      formattedText,
      'the applied text must be exactly the formatted output'
    );

    // One undo fully reverts the single WorkspaceEdit (atomic undo guarantee).
    await vscode.commands.executeCommand('undo');
    await flushEventLoop();
    assert.equal(
      document.getText(),
      original,
      'a single undo must restore the original (one WorkspaceEdit = one undo entry)'
    );
  });

  // (f) The deference decision is ONE-SHOT (anti-nag): given a detected competitor
  //     and the default 'notify' preference, the FIRST decide(...) surfaces the
  //     notification; the SECOND (alreadyPrompted=true) returns 'none'. This is
  //     the pure logic the host wires to globalState — proving the dedup contract
  //     deterministically, without depending on globalState in the host.
  it('(f) the deference decision is one-shot: a second decide(...) returns none', async () => {
    const setting: DeferenceSetting = 'notify';
    const detected = [FORMATTER_PRETTIER];

    const first = decide(detected, setting, false);
    assert.equal(first.action, 'notify', 'the first decision must surface a notification');
    assert.equal(
      first.message,
      formatDeferenceMessage(detected),
      'the surfaced message must be the composed deference message'
    );

    // Second time around the one-shot flag is set -> nothing is surfaced (no nag).
    const second = decide(detected, setting, true);
    assert.deepEqual(
      second,
      { action: 'none' },
      'a second decision (already prompted) must surface NOTHING (one-shot dedup)'
    );

    // And no deference path may ever write editor.defaultFormatter (ARCH-02): the
    // decision carries no write instruction and touching the setting here is a
    // user-config write only — confirm Tidy left defaultFormatter untouched by it.
    const before = vscode.workspace
      .getConfiguration('editor')
      .inspect('defaultFormatter');
    await vscode.workspace
      .getConfiguration('tidy')
      .update('deferToOtherFormatters', 'notify', vscode.ConfigurationTarget.Workspace);
    await flushEventLoop();
    const after = vscode.workspace
      .getConfiguration('editor')
      .inspect('defaultFormatter');
    assert.deepEqual(
      { g: after?.globalValue, w: after?.workspaceValue },
      { g: before?.globalValue, w: before?.workspaceValue },
      'no deference path may ever write editor.defaultFormatter (ARCH-02)'
    );
    await vscode.workspace
      .getConfiguration('tidy')
      .update('deferToOtherFormatters', undefined, vscode.ConfigurationTarget.Workspace);
  });
});
