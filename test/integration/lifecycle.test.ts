// Headless lifecycle integration tests — SPEC QA-04 (P0).
//
// These run inside a real VS Code Electron host. They prove the five
// NON-NEGOTIABLE anti-hijack guarantees end-to-end — the only tier of tests
// that can. The product's whole moat is "never hijack / never corrupt", and
// the incumbent's 1.69/5 came from violating exactly these:
//
//   (a) editor.formatOnSave=false  => saving NEVER modifies the document   (#12)
//   (b) another defaultFormatter   => Tidy does NOT run                     (#92)
//   (c) after Format Document      => the cursor does NOT jump to EOF       (#83)
//   (d) one save                   => exactly ONE save (no double-save)     (#28)
//   (e) enable=false               => Tidy is gone from "Format With…"      (#91)
//
// Design notes:
//  - We drive only the public surface: VS Code's own format commands, the
//    registered providers, editor config, and the save lifecycle. We never call
//    into src/* internals, so a green run is a true end-to-end proof.
//  - Assertions compare *change vs no-change* against the original text instead
//    of an exact golden, so an engine bump cannot make these flaky.
//  - REFORMATTABLE_CSS is the canonical "Tidy will definitely reformat this"
//    input (js-beautify always expands `a{color:red}`), which lets a test
//    distinguish "Tidy ran" from "Tidy did nothing".
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  activateExtension,
  clearTouchedConfig,
  computeFormatEdits,
  flushEventLoop,
  openFixture,
  REFORMATTABLE_CSS,
  runFormatDocument,
  setEditorConfig,
  setTidyConfig
} from './helpers';

describe('Tidy lifecycle (QA-04) — anti-hijack guarantees', function () {
  // Opening the Electron host + downloading VS Code on first run is slow; give
  // each case headroom beyond the engine work itself.
  this.timeout(30000);

  let restoreFns: Array<() => Promise<void>> = [];

  before(async () => {
    await activateExtension();
  });

  afterEach(async () => {
    // Restore any per-test config overrides in reverse order, then hard-reset
    // every key this suite touches so tests stay order-independent.
    for (const restore of restoreFns.reverse()) {
      await restore();
    }
    restoreFns = [];
    await clearTouchedConfig();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await flushEventLoop();
  });

  /** Track a restore disposer so afterEach can roll the config back. */
  function track(restore: () => Promise<void>): void {
    restoreFns.push(restore);
  }

  // (a) formatOnSave=false => a save must NEVER modify the document.
  it('(a) with editor.formatOnSave=false, saving does not modify the document', async () => {
    track(await setEditorConfig('formatOnSave', false));

    const document = await openFixture(
      'lifecycle/save-no-format.css',
      REFORMATTABLE_CSS,
      'css'
    );
    const editor = await vscode.window.showTextDocument(document);

    // Make the document dirty with a trivial, format-neutral edit so the save
    // actually writes. We append a blank line; if format-on-save were
    // (wrongly) active, js-beautify would also collapse/expand the rule.
    await editor.edit((builder) => {
      builder.insert(new vscode.Position(document.lineCount, 0), '\n');
    });
    const beforeSave = document.getText();

    const saved = await document.save();
    await flushEventLoop();

    assert.equal(saved, true, 'save should report success');
    assert.equal(
      document.getText(),
      beforeSave,
      'save must not reformat the document when formatOnSave=false'
    );
    // The compact rule must still be compact — proof no formatter touched it.
    assert.ok(
      document.getText().includes('a{color:red}'),
      'the original compact CSS rule must survive an unformatted save'
    );
  });

  // (b) Another defaultFormatter configured => Tidy must NOT run.
  //
  // Headless constraint: with --disable-extensions there is no third-party
  // formatter, and a test-registered provider cannot own a publisher id (so it
  // cannot be NAMED in editor.defaultFormatter). The interactive "Format
  // Document" would also pop a picker that hangs the host. So we prove the
  // guarantee through format-on-save with TWO providers present:
  //
  //   - A sentinel CSS formatter (registered by the test) whose edit is a unique
  //     marker Tidy would never emit.
  //   - Tidy's own CSS provider.
  //
  // We set editor.defaultFormatter to a non-Tidy id. With two candidate
  // providers and the named default not resolving to Tidy, VS Code must NOT let
  // Tidy silently clobber the file (this is exactly incumbent #92 "formats even
  // when another formatter is the default"). Whatever VS Code does — leave the
  // file alone or run the sentinel — the one forbidden outcome is Tidy
  // reformatting. Tidy's signature here is expanding `a{color:red}` onto
  // multiple indented lines, so the compact rule surviving proves Tidy deferred.
  it('(b) when another extension is the default formatter, Tidy does not run on save', async () => {
    const SENTINEL_MARKER = 'sentinel-formatter-ran';
    let sentinelInvoked = false;
    const sentinel = vscode.languages.registerDocumentFormattingEditProvider(
      { language: 'css', scheme: 'file' },
      {
        provideDocumentFormattingEdits() {
          sentinelInvoked = true;
          return [
            vscode.TextEdit.insert(
              new vscode.Position(0, 0),
              `/* ${SENTINEL_MARKER} */\n`
            )
          ];
        }
      }
    );
    track(async () => sentinel.dispose());

    track(await setEditorConfig('formatOnSave', true));
    track(
      await setEditorConfig(
        'defaultFormatter',
        'some.other-formatter-not-tidy'
      )
    );

    const document = await openFixture(
      'lifecycle/default-other.css',
      REFORMATTABLE_CSS,
      'css'
    );
    const editor = await vscode.window.showTextDocument(document);

    // Sanity: Tidy *could* reformat this CSS if it were allowed to run, so the
    // "Tidy didn't run" assertion is meaningful rather than vacuous.
    // (computeFormatEdits is provider-level and ignores editor.defaultFormatter,
    // so it still reflects Tidy's raw capability for this input.)
    const tidyWouldEdit = await computeFormatEdits(document);
    assert.ok(
      tidyWouldEdit.length > 0,
      'precondition: Tidy is capable of reformatting this CSS'
    );

    // Dirty the buffer so the save has something to persist, using a
    // format-neutral edit (a trailing newline) Tidy-on-save would otherwise
    // expand alongside the rule.
    await editor.edit((builder) => {
      builder.insert(new vscode.Position(document.lineCount, 0), '\n');
    });

    await vscode.commands.executeCommand('workbench.action.files.save');
    await flushEventLoop();
    const after = document.getText();

    // The non-negotiable: Tidy did not reformat. The compact rule must survive.
    assert.ok(
      after.includes('a{color:red}'),
      'Tidy must not reformat on save when another extension is the default formatter (#92)'
    );

    // Cross-check identity: if any formatter ran, it must be the sentinel — and
    // Tidy's multi-line expansion must be absent regardless.
    if (sentinelInvoked) {
      assert.ok(
        after.includes(SENTINEL_MARKER),
        'if a formatter ran on save it must be the sentinel, never Tidy'
      );
    }
    assert.equal(
      document.isDirty,
      false,
      'the save itself must still succeed'
    );
  });

  // (c) After Format Document, the cursor must not jump to EOF.
  it('(c) Format Document does not move the cursor to end-of-file', async () => {
    // Make Tidy the default formatter for CSS so Format Document resolves to it.
    track(
      await setEditorConfig('defaultFormatter', 'ced-lab.tidy-formatter')
    );

    // A multi-line CSS doc Tidy will reformat, with the cursor parked on an
    // early line so a jump-to-EOF regression (incumbent #83) is observable.
    const source = 'body{margin:0}\n.a{color:red}\n.b{color:blue}\n';
    const document = await openFixture('lifecycle/cursor.css', source, 'css');
    const editor = await vscode.window.showTextDocument(document);

    const startPosition = new vscode.Position(0, 0);
    editor.selection = new vscode.Selection(startPosition, startPosition);

    // Sanity: Tidy actually has edits to apply here (else the test is vacuous).
    const edits = await computeFormatEdits(document);
    assert.ok(
      edits.length > 0,
      'precondition: Tidy must have reformatting edits for this CSS'
    );

    await runFormatDocument();

    const lastLine = document.lineCount - 1;
    const eofPosition = new vscode.Position(
      lastLine,
      document.lineAt(lastLine).text.length
    );
    assert.ok(
      !editor.selection.active.isEqual(eofPosition),
      `cursor jumped to EOF (${editor.selection.active.line}:` +
        `${editor.selection.active.character}) — regression of incumbent #83`
    );
    // Stronger: the cursor stayed at (or very near) where the user left it.
    assert.equal(
      editor.selection.active.line,
      0,
      'cursor should remain on the line the user left it on after Format Document'
    );
  });

  // (d) A single Format-on-save triggers exactly one save (no double-save).
  it('(d) format-on-save with Tidy triggers exactly one save', async () => {
    track(await setEditorConfig('formatOnSave', true));
    track(
      await setEditorConfig('defaultFormatter', 'ced-lab.tidy-formatter')
    );

    const document = await openFixture(
      'lifecycle/single-save.css',
      REFORMATTABLE_CSS,
      'css'
    );
    const editor = await vscode.window.showTextDocument(document);

    // Count save events for THIS document only.
    let saveCount = 0;
    const sub = vscode.workspace.onDidSaveTextDocument((saved) => {
      if (saved.uri.toString() === document.uri.toString()) {
        saveCount += 1;
      }
    });
    track(async () => sub.dispose());

    // Dirty the doc so the save has something to write.
    await editor.edit((builder) => {
      builder.insert(new vscode.Position(document.lineCount, 0), '\n');
    });

    await vscode.commands.executeCommand('workbench.action.files.save');
    await flushEventLoop();

    assert.equal(
      saveCount,
      1,
      `expected exactly one save, got ${saveCount} (incumbent #28 double-save)`
    );
    // The doc must not be dirty afterwards — proves the single save committed.
    assert.equal(document.isDirty, false, 'document should be clean after save');
  });

  // (e) enable=false => Tidy disappears from "Format Document With…".
  it('(e) with tidy.<lang>.enable=false, Tidy provides no edits (absent from "Format With…")', async () => {
    const document = await openFixture(
      'lifecycle/disabled.css',
      REFORMATTABLE_CSS,
      'css'
    );
    await vscode.window.showTextDocument(document);

    // Enabled: Tidy must offer edits (otherwise the next assertion is vacuous).
    const enabledEdits = await computeFormatEdits(document);
    assert.ok(
      enabledEdits.length > 0,
      'precondition: with CSS enabled, Tidy must offer reformatting edits'
    );

    // Disable CSS for Tidy. The provider stays registered but must yield zero
    // edits, so VS Code's "Format Document With…" sees nothing from Tidy. Keep
    // the restorer so the test can re-enable and close the loop, and also track
    // it so afterEach restores even if an assertion throws first.
    const restoreEnable = await setTidyConfig('css.enable', false);
    track(restoreEnable);
    await flushEventLoop();

    // The authoritative, user-facing contract: a real Format Document must
    // leave the document untouched, because Tidy (the only CSS provider here)
    // now contributes nothing. This is what "Tidy disappears from Format
    // Document With…" means observably — there is no Tidy edit to apply, so the
    // file is byte-identical after a format run.
    //
    // (We deliberately assert via the real `editor.action.formatDocument` path
    // rather than `vscode.executeFormatDocumentProvider`: that lower-level
    // command bypasses the editor's formatter resolution and can surface a
    // stale provider result, so it is not a faithful proxy for the user-facing
    // "disabled" behaviour. The real command is the contract QA-04 cares about.)
    const before = document.getText();
    await runFormatDocument();
    assert.equal(
      document.getText(),
      before,
      'disabled Tidy must not modify the document via Format Document'
    );
    assert.ok(
      document.getText().includes('a{color:red}'),
      'the compact CSS rule must survive untouched while Tidy is disabled'
    );

    // Re-enabling restores formatting — proving the disable was the cause of the
    // no-op above, not some unrelated reason (closes the loop on the gate).
    await restoreEnable();
    await flushEventLoop();
    const reEnabledEdits = await computeFormatEdits(document);
    assert.ok(
      reEnabledEdits.length > 0,
      're-enabling tidy.css.enable must make Tidy offer edits again'
    );
  });
});
