// Headless integration test for "Tidy: Show Format History" (ADD-14).
// Proves, inside a REAL VS Code host, that the command is registered and that
// invoking it is READ-ONLY: it modifies no document and leaves nothing dirty.
// When the history is non-empty the QuickPick blocks; it is dismissed
// programmatically via workbench.action.closeQuickOpen. We deliberately do NOT
// import src/* store internals here: the test bundle's module instance is not
// the extension bundle's, so store state is only assertable in unit tests.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  activateExtension,
  flushEventLoop,
  openFixture,
  workspaceRoot
} from './helpers';
import { SHOW_FORMAT_HISTORY_COMMAND_ID } from '../../src/commands/showFormatHistory';

/** Relative dir holding every fixture this suite writes (cleaned in after()). */
const FIXTURE_DIR = 'history';

describe('Tidy format history (ADD-14) : registration + read-only', function () {
  // CI-aware: generous on slow/shared CI runners, strict locally.
  this.timeout(process.env.CI ? 180000 : 30000);

  before(async () => {
    await activateExtension();
  });

  after(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await flushEventLoop();
    // Windows keeps the fixture handle open for a beat after the editor closes
    // (file watcher / hot-exit backup), so a bare rmSync loses the race with
    // EPERM. Node's own retry loop covers exactly that case; the call still
    // throws if the directory is genuinely stuck, so a real leak stays loud.
    fs.rmSync(path.join(workspaceRoot(), FIXTURE_DIR), {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100
    });
  });

  it('tidy.showFormatHistory is registered in the host', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes(SHOW_FORMAT_HISTORY_COMMAND_ID),
      'command must be registered at activation'
    );
  });

  it('invoking the command never modifies the open document (read-only)', async () => {
    const document = await openFixture(
      `${FIXTURE_DIR}/readonly-probe.css`,
      'a{color:red}\n',
      'css'
    );
    await vscode.window.showTextDocument(document);
    const before = document.getText();

    // Fire WITHOUT awaiting: with a non-empty history (earlier suites format
    // in this same host) the handler blocks on the QuickPick. Dismiss any
    // picker, then await the command promise. With an EMPTY history the
    // command resolves immediately and closeQuickOpen is a harmless no-op:
    // the assertion holds on both paths.
    const invocation = vscode.commands.executeCommand(
      SHOW_FORMAT_HISTORY_COMMAND_ID
    );
    await flushEventLoop();
    await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
    await invocation;
    await flushEventLoop();

    assert.equal(document.getText(), before, 'document must stay byte-identical');
    assert.equal(document.isDirty, false, 'no pending edit is allowed');
  });
});
