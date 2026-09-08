// Headless integration tests for the "Try it now" playground (ADD-03). Run in a
// real VS Code Electron host. What this suite locks down:
//   (a) tidy.openPlayground opens exactly two UNTITLED documents (css active,
//       tsx beside) whose contents are the embedded samples;
//   (b) ZERO files are created anywhere in the workspace by opening it;
//   (c) tidy.previewFormat on the untitled CSS playground opens a read-only
//       'tidy-preview' diff and leaves the buffer text untouched;
//   (d)-(f) the ADD-03 pipeline alignment: preview REFUSES (resolving, without
//       hanging on the Apply toast, and without opening any diff) when the
//       language is disabled, when the size guard trips, and when the file is
//       matched by .soukformatignore.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  activateExtension,
  clearTouchedConfig,
  flushEventLoop,
  openFixture,
  setTidyConfig,
  workspaceRoot
} from './helpers';
import {
  OPEN_PLAYGROUND_COMMAND_ID,
  PLAYGROUND_CSS_SAMPLE,
  PLAYGROUND_TSX_SAMPLE
} from '../../src/commands/openPlayground';
import { PREVIEW_SCHEME } from '../../src/commands/previewFormat';

const FIXTURE_DIR = 'playground';

/** Sorted, root-relative recursive file list of the workspace folder. */
function listWorkspaceFiles(): string[] {
  const root = workspaceRoot();
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else out.push(path.relative(root, abs));
    }
  };
  walk(root);
  return out.sort();
}

/** Number of open diff tabs whose modified side is the tidy-preview scheme. */
function tidyPreviewTabCount(): number {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter(
      (tab) =>
        tab.input instanceof vscode.TabInputTextDiff &&
        (tab.input as vscode.TabInputTextDiff).modified.scheme === PREVIEW_SCHEME
    ).length;
}

/**
 * Await tidy.previewFormat with a hang guard: a REFUSAL path must resolve
 * immediately (it never awaits the Apply toast). A hang means the pre-gates
 * did not fire, which is exactly the regression this helper exposes.
 */
async function runPreviewExpectingRefusal(): Promise<void> {
  const outcome = await Promise.race([
    Promise.resolve(vscode.commands.executeCommand('tidy.previewFormat')).then(
      () => 'resolved'
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 8000))
  ]);
  assert.equal(
    outcome,
    'resolved',
    'a refused preview must resolve without awaiting any Apply toast'
  );
}

describe('Tidy playground & preview pre-gates (ADD-03)', function () {
  this.timeout(process.env.CI ? 180000 : 30000);

  before(async () => {
    await activateExtension();
  });

  after(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await flushEventLoop();
    // Windows keeps the fixture handle open for a beat after the editor closes
    // (file watcher / hot-exit backup); Node's retry loop covers exactly that.
    fs.rmSync(path.join(workspaceRoot(), FIXTURE_DIR), {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100
    });
  });

  afterEach(async () => {
    fs.rmSync(path.join(workspaceRoot(), '.soukformatignore'), { force: true });
    await clearTouchedConfig();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await flushEventLoop();
  });

  it('(a)+(b) openPlayground opens two untitled samples, css active, zero files created', async () => {
    const before = listWorkspaceFiles();

    await vscode.commands.executeCommand(OPEN_PLAYGROUND_COMMAND_ID);
    await flushEventLoop();

    const untitled = vscode.workspace.textDocuments.filter((d) => d.isUntitled);
    const css = untitled.find((d) => d.languageId === 'css');
    const tsx = untitled.find((d) => d.languageId === 'typescriptreact');
    assert.ok(css, 'an untitled css playground document must be open');
    assert.ok(tsx, 'an untitled typescriptreact playground document must be open');
    assert.equal(css!.getText(), PLAYGROUND_CSS_SAMPLE);
    assert.equal(tsx!.getText(), PLAYGROUND_TSX_SAMPLE);

    const active = vscode.window.activeTextEditor;
    assert.ok(active, 'an editor must be active after opening the playground');
    assert.equal(active!.document.languageId, 'css', 'the CSS tab must be focused');
    assert.equal(active!.document.isUntitled, true);

    assert.deepEqual(
      listWorkspaceFiles(),
      before,
      'opening the playground must create ZERO files in the workspace'
    );
  });

  it('(c) previewFormat on the untitled CSS playground opens a read-only diff, text untouched', async () => {
    await vscode.commands.executeCommand(OPEN_PLAYGROUND_COMMAND_ID);
    await flushEventLoop();
    const active = vscode.window.activeTextEditor!;
    assert.equal(active.document.languageId, 'css');

    // Fire-and-forget: on the HAPPY path the handler awaits the Apply toast,
    // which never resolves headless (same idiom as power-features (e)).
    void Promise.resolve(
      vscode.commands.executeCommand('tidy.previewFormat')
    ).catch(() => undefined);

    const deadline = Date.now() + 10000;
    while (tidyPreviewTabCount() === 0 && Date.now() < deadline) {
      await flushEventLoop();
    }
    assert.ok(
      tidyPreviewTabCount() > 0,
      'a tidy-preview diff tab must open for the untitled playground document'
    );
    assert.equal(
      active.document.getText(),
      PLAYGROUND_CSS_SAMPLE,
      'opening the preview must not change the playground buffer'
    );
  });

  it('(d) preview refuses a disabled language: resolves, no diff tab, file untouched', async () => {
    const restore = await setTidyConfig('css.enable', false);
    try {
      const doc = await openFixture(
        `${FIXTURE_DIR}/disabled.css`,
        'a{color:red}\n',
        'css'
      );
      await vscode.window.showTextDocument(doc);
      await runPreviewExpectingRefusal();
      assert.equal(tidyPreviewTabCount(), 0, 'no diff may open for a disabled language');
      assert.equal(doc.getText(), 'a{color:red}\n');
    } finally {
      await restore();
    }
  });

  it('(e) preview refuses an oversized document (tidy.maxFileSizeKB): no diff tab', async () => {
    const restore = await setTidyConfig('maxFileSizeKB', 1);
    try {
      const big = 'a{color:red}\n'.repeat(200); // ~2.5 KB > 1 KB limit
      const doc = await openFixture(`${FIXTURE_DIR}/big.css`, big, 'css');
      await vscode.window.showTextDocument(doc);
      await runPreviewExpectingRefusal();
      assert.equal(tidyPreviewTabCount(), 0, 'no diff may open above the size guard');
      assert.equal(doc.getText(), big);
    } finally {
      await restore();
    }
  });

  it('(f) preview refuses a file matched by .soukformatignore: no diff tab', async () => {
    fs.writeFileSync(
      path.join(workspaceRoot(), '.soukformatignore'),
      `${FIXTURE_DIR}/ignored-*.css\n`,
      'utf8'
    );
    const doc = await openFixture(
      `${FIXTURE_DIR}/ignored-preview.css`,
      'a{color:red}\n',
      'css'
    );
    await vscode.window.showTextDocument(doc);
    await runPreviewExpectingRefusal();
    assert.equal(tidyPreviewTabCount(), 0, 'no diff may open for an ignored file');
    assert.equal(doc.getText(), 'a{color:red}\n');
  });
});
