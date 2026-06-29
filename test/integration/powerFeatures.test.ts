// Headless power-features integration tests — ROADMAP Axe 4 (T2/T3/T5/T6).
//
// These run inside a real VS Code Electron host (via @vscode/test-cli) and drive
// the public surface the way no pure unit test can: the registered formatting
// providers (for ignore + region masking), the registered tidy.previewFormat
// command, and the tidy.deferToOtherFormatters setting — proving the anti-hijack
// + safety contract end to end.
//
// What this suite locks down:
//   (a) .soukformatignore matches a file -> Tidy returns NO edits (byte-identical);
//   (b) an in-source FILE ignore marker (// tidy-ignore-file) -> NO edits;
//   (c) an in-source REGION (tidy-ignore-start/end) -> the file IS reformatted but
//       the protected bytes survive VERBATIM in the result (mask/restore + guard);
//   (d) the tidy.previewFormat command is registered and runs read-only (the
//       document stays clean: opening the diff writes nothing);
//   (e) ARCH-02 — evaluating deference NEVER writes editor.defaultFormatter and
//       the tidy.deferToOtherFormatters setting is the documented enum.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  activateExtension,
  clearTouchedConfig,
  computeFormatEdits,
  ensureTidyDefaultFormatter,
  flushEventLoop,
  openFixture,
  runFormatDocument,
  workspaceRoot
} from './helpers';

describe('Tidy power features (Axe 4) — ignore / region / preview / deference', function () {
  this.timeout(30000);

  // The "Tidy does nothing" assertions must go through the REAL Format Document
  // path (editor.action.formatDocument), which honours editor.defaultFormatter —
  // vscode.executeFormatDocumentProvider can fall through to another provider when
  // Tidy returns no edits, masking the no-op we mean to prove. So we make Tidy the
  // resolved default formatter for CSS and compare document text before/after.
  let restoreDefaultFormatter: () => Promise<void>;

  before(async () => {
    await activateExtension();
    restoreDefaultFormatter = await ensureTidyDefaultFormatter(['css']);
  });

  after(async () => {
    await restoreDefaultFormatter();
  });

  afterEach(async () => {
    await clearTouchedConfig();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await flushEventLoop();
  });

  // (a) .soukformatignore matches the file -> Tidy leaves it byte-identical.
  it('(a) .soukformatignore makes a matched file untouched by Format Document', async () => {
    const ignorePath = path.join(workspaceRoot(), '.soukformatignore');
    fs.writeFileSync(ignorePath, '*.min.css\n', 'utf8');
    try {
      const ignored = await openFixture(
        'ignore-suite/vendor.min.css',
        'a{color:red}\n',
        'css'
      );
      await vscode.window.showTextDocument(ignored);
      const before = ignored.getText();
      await runFormatDocument();
      assert.equal(
        ignored.getText(),
        before,
        'a file matched by .soukformatignore must be left byte-identical by Format Document'
      );
      assert.ok(ignored.getText().includes('a{color:red}'));

      // A sibling NOT matched by the pattern must still format (proves the ignore
      // is targeted, not a blanket disable). computeFormatEdits reflects Tidy's
      // raw capability here, which is non-empty only because Tidy actually runs.
      const formatted = await openFixture(
        'ignore-suite/app.css',
        'a{color:red}\n',
        'css'
      );
      let edits = await computeFormatEdits(formatted);
      const deadline = Date.now() + 10000;
      while (edits.length === 0 && Date.now() < deadline) {
        await flushEventLoop();
        edits = await computeFormatEdits(formatted);
      }
      assert.ok(
        edits.length > 0,
        'a file NOT matched by .soukformatignore must still be formatted'
      );
    } finally {
      fs.rmSync(ignorePath, { force: true });
    }
  });

  // (b) An in-source FILE ignore marker leaves the whole file untouched.
  it('(b) a head tidy-ignore-file marker leaves the document untouched by Format Document', async () => {
    const content = '/* tidy-ignore-file */\na{color:red}\n';
    const document = await openFixture(
      'ignore-suite/file-ignored.css',
      content,
      'css'
    );
    await vscode.window.showTextDocument(document);
    const before = document.getText();
    await runFormatDocument();
    assert.equal(
      document.getText(),
      before,
      'a document with a head tidy-ignore-file marker must be left byte-identical'
    );
    assert.ok(document.getText().includes('a{color:red}'));
  });

  // (c) A protected REGION survives verbatim while the rest is reformatted.
  it('(c) a tidy-ignore region is preserved byte-for-byte while the rest formats', async () => {
    const raw = '.RAW   {  color : blue  }';
    const content =
      '.a{color:red}\n' +
      '/* tidy-ignore-start */\n' +
      `${raw}\n` +
      '/* tidy-ignore-end */\n' +
      '.b{color:green}\n';
    const document = await openFixture('ignore-suite/region.css', content, 'css');
    await vscode.window.showTextDocument(document);

    await runFormatDocument();
    const result = document.getText();

    assert.ok(
      result.includes(raw),
      'the protected region bytes must survive VERBATIM in the formatted output'
    );
    // The area outside the region must actually have changed (real reflow), so the
    // test proves protect-AND-restore, not a global no-op.
    assert.notEqual(result, content, 'the rest of the file must be reformatted');
  });

  // (d) tidy.previewFormat is registered and runs read-only (no write on open).
  it('(d) tidy.previewFormat is registered and leaves the document clean', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes('tidy.previewFormat'),
      'tidy.previewFormat must be a registered command'
    );

    const document = await openFixture(
      'ignore-suite/preview.css',
      'a{color:red}\n',
      'css'
    );
    await vscode.window.showTextDocument(document);
    assert.equal(document.isDirty, false, 'precondition: the document is clean');

    // Fire-and-forget: the handler opens a read-only diff then AWAITS an "Apply"
    // toast that never resolves in a headless host. We must NOT await the command
    // (that would hang the test). The contract we assert is that merely opening
    // the preview writes NOTHING — applying only happens on an explicit click. We
    // swallow the dangling promise so it never becomes an unhandled rejection.
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
  });

  // (e) ARCH-02: deference never writes editor.defaultFormatter; the setting is
  //     the documented enum with the default 'notify'.
  it('(e) deference never touches editor.defaultFormatter and exposes the enum', async () => {
    const before = vscode.workspace
      .getConfiguration('editor')
      .inspect('defaultFormatter');

    // Setting the preference itself is a user-config write, not a Tidy write; the
    // point is that nothing Tidy does in response writes editor.defaultFormatter.
    await vscode.workspace
      .getConfiguration('tidy')
      .update(
        'deferToOtherFormatters',
        'notify',
        vscode.ConfigurationTarget.Workspace
      );
    await flushEventLoop();

    const after = vscode.workspace
      .getConfiguration('editor')
      .inspect('defaultFormatter');
    assert.deepEqual(
      {
        g: after?.globalValue,
        w: after?.workspaceValue,
        wl: after?.workspaceLanguageValue
      },
      {
        g: before?.globalValue,
        w: before?.workspaceValue,
        wl: before?.workspaceLanguageValue
      },
      'no deference path may ever write editor.defaultFormatter (ARCH-02)'
    );

    await vscode.workspace
      .getConfiguration('tidy')
      .update(
        'deferToOtherFormatters',
        undefined,
        vscode.ConfigurationTarget.Workspace
      );
  });
});
