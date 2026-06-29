// Shared helpers for the headless lifecycle integration tests (SPEC QA-04).
//
// These run INSIDE a real VS Code Electron host (via @vscode/test-cli /
// @vscode/test-electron), so unlike the pure unit tests they may import
// 'vscode'. They drive the public extension surface only — the registered
// DocumentFormatting providers, the editor config, and the save lifecycle —
// because that is exactly the contract QA-04 must prove end-to-end.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

/** Marketplace identifier of the extension under test (publisher.name). */
export const EXTENSION_ID = 'ced-lab.tidy-formatter';

/**
 * A compact CSS snippet js-beautify always expands onto multiple lines. We use
 * it as the canonical "Tidy WILL reformat this" input: any version of
 * js-beautify turns `a{color:red}` into an indented, multi-line block, so the
 * test asserts *change vs no-change* rather than an exact golden string (which
 * would be brittle across engine bumps).
 */
export const REFORMATTABLE_CSS = 'a{color:red}\n';

/**
 * Absolute path to the fixture workspace folder opened by the test host
 * (configured as `workspaceFolder` in .vscode-test.mjs).
 */
export function workspaceRoot(): string {
  const folders = vscode.workspace.workspaceFolders;
  assert.ok(
    folders && folders.length > 0,
    'integration tests must run with a workspace folder open (see .vscode-test.mjs)'
  );
  return folders![0].uri.fsPath;
}

/**
 * Activate the extension under test and return its exports. Activation is
 * idempotent, so calling this from several tests is safe.
 */
export async function activateExtension(): Promise<vscode.Extension<unknown>> {
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(ext, `extension '${EXTENSION_ID}' is not present in the test host`);
  if (!ext!.isActive) {
    await ext!.activate();
  }
  return ext!;
}

/**
 * Create a fresh fixture file inside the workspace, open it as a TextDocument,
 * and return the document. Writing to disk (rather than `openTextDocument({
 * content })`) gives the file a real on-disk URI so save-lifecycle assertions
 * (dirty -> save -> clean) are meaningful. The languageId is derived from the
 * extension by VS Code; we assert it matched the expectation.
 */
export async function openFixture(
  relPath: string,
  content: string,
  expectedLanguageId: string
): Promise<vscode.TextDocument> {
  const absPath = path.join(workspaceRoot(), relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content, 'utf8');

  const uri = vscode.Uri.file(absPath);
  const document = await vscode.workspace.openTextDocument(uri);
  assert.equal(
    document.languageId,
    expectedLanguageId,
    `expected '${relPath}' to be detected as '${expectedLanguageId}' ` +
      `but VS Code reported '${document.languageId}'`
  );
  return document;
}

/**
 * Update a setting at Workspace scope and resolve only once the extension host
 * has actually observed the change via onDidChangeConfiguration. `config.update`
 * resolves when the value is written, but the providers read config lazily and
 * the change event can land a tick later — waiting for it removes the race that
 * makes "I just disabled it but it still ran" flaky. Falls back to a short flush
 * if no event arrives (e.g. setting the same value).
 */
async function updateConfigAndAwait(
  fullSection: string,
  root: string,
  key: string,
  value: unknown
): Promise<void> {
  const changed = new Promise<void>((resolve) => {
    const sub = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(fullSection)) {
        sub.dispose();
        resolve();
      }
    });
    // Safety net: never hang if the event does not fire.
    setTimeout(() => {
      sub.dispose();
      resolve();
    }, 2000);
  });

  const config = vscode.workspace.getConfiguration(root);
  await config.update(key, value, vscode.ConfigurationTarget.Workspace);
  await changed;
}

/**
 * Set a `tidy.*` setting at Workspace scope and wait until the change is
 * observed by the host. Returns a disposer that restores the previous value, so
 * a test never leaks config into the next one.
 */
export async function setTidyConfig(
  section: string,
  value: unknown
): Promise<() => Promise<void>> {
  const previous = vscode.workspace
    .getConfiguration('tidy')
    .inspect(section)?.workspaceValue;
  await updateConfigAndAwait(`tidy.${section}`, 'tidy', section, value);
  return async () => {
    await updateConfigAndAwait(`tidy.${section}`, 'tidy', section, previous);
  };
}

/**
 * Set an `editor.*` setting at Workspace scope (e.g. formatOnSave,
 * defaultFormatter) and wait until the change is observed. Returns a disposer
 * restoring the previous value.
 */
export async function setEditorConfig(
  section: string,
  value: unknown
): Promise<() => Promise<void>> {
  const previous = vscode.workspace
    .getConfiguration('editor')
    .inspect(section)?.workspaceValue;
  await updateConfigAndAwait(`editor.${section}`, 'editor', section, value);
  return async () => {
    await updateConfigAndAwait(`editor.${section}`, 'editor', section, previous);
  };
}

/**
 * Ask VS Code core to compute the format edits Tidy's provider would apply to a
 * whole document, exactly the way "Format Document" does. Returns the edits
 * (possibly empty) so a test can assert change vs no-change WITHOUT mutating the
 * document. This isolates "does Tidy run / what would it do" from "does saving
 * write to disk", which the lifecycle assertions test separately.
 */
export async function computeFormatEdits(
  document: vscode.TextDocument
): Promise<vscode.TextEdit[]> {
  const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
    'vscode.executeFormatDocumentProvider',
    document.uri,
    { tabSize: 4, insertSpaces: true }
  );
  return edits ?? [];
}

/**
 * Run "Format Document" through VS Code core (the same command bound to the
 * editor action), operating on the active editor. This DOES honour
 * editor.defaultFormatter, applying whatever the resolved default returns and
 * mutating the document if there are edits. The caller must have shown the
 * target editor first. Returns once the edit has settled on the model.
 */
export async function runFormatDocument(): Promise<void> {
  await vscode.commands.executeCommand('editor.action.formatDocument');
  // Let the edit settle on the document model before assertions read it.
  await flushEventLoop();
}

// A tiny per-language snippet js-beautify/prettier ALWAYS reflows, used only as a
// readiness probe: while Tidy is the resolved default formatter for the language,
// executeFormatDocumentProvider returns non-empty edits for these. A genuine
// engine-load failure would keep returning empty, so the readiness poll times out
// and fails loudly rather than masking a real no-op bug.
const READINESS_PROBE: Partial<Record<string, { ext: string; code: string }>> = {
  css: { ext: 'css', code: 'a{color:red}\n' },
  scss: { ext: 'scss', code: '.a{.b{color:red}}\n' },
  less: { ext: 'less', code: '.a{.b{color:red}}\n' },
  html: { ext: 'html', code: '<div><span>x</span></div>\n' },
  json: { ext: 'json', code: '{"a":1,"b":2}\n' },
  jsonc: { ext: 'jsonc', code: '{"a":1,"b":2}\n' },
  javascript: { ext: 'js', code: 'const a={x:1,y:2}\n' },
  typescript: { ext: 'ts', code: 'const a:number=1;const b={x:1}\n' },
  typescriptreact: { ext: 'tsx', code: 'const a=()=><div className="x">{1}</div>\n' },
  javascriptreact: { ext: 'jsx', code: 'const a=()=><div className="x">{1}</div>\n' }
};

/**
 * Make Tidy the per-language default formatter for each language AND deterministic-
 * ally wait until it is actually RESOLVABLE before any test formats a real fixture.
 *
 * Why this exists: setting editor.defaultFormatter (overrideInLanguage) and then
 * formatting immediately is racy on a COLD Electron host — the config change and
 * the provider registration have not propagated yet, so the very first
 * Format Document resolves to no formatter and is a silent no-op. That made the
 * first run of the host suites fail with "produced no change" while warm reruns
 * passed (a classic cold-start flake). Polling a tiny reformattable probe per
 * language until edits appear removes the race without masking a real bug: if an
 * engine truly fails to load, the probe never returns edits and this throws.
 *
 * Returns a disposer that clears the per-language overrides (call in `after`).
 */
export async function ensureTidyDefaultFormatter(
  langs: readonly string[],
  // CI-aware readiness budget: a cold, loaded/shared CI runner can take a long
  // time for the FIRST executeFormatDocumentProvider to resolve to Tidy (config
  // propagation + lazy engine load: prettier dynamic import, TS compiler). 10s is
  // plenty on a fast local machine but flakes under CI load, so the poll gets a
  // far larger ceiling there. The poll still fails loudly if edits never appear,
  // so a genuine engine-load failure is not masked — only slowness is tolerated.
  timeoutMs = process.env.CI ? 90000 : 10000
): Promise<() => Promise<void>> {
  for (const lang of langs) {
    await vscode.workspace
      .getConfiguration('editor', { languageId: lang })
      .update(
        'defaultFormatter',
        EXTENSION_ID,
        vscode.ConfigurationTarget.Workspace,
        true
      );
  }
  await flushEventLoop();

  for (const lang of langs) {
    const probe = READINESS_PROBE[lang];
    assert.ok(probe, `no readiness probe configured for language '${lang}'`);

    const absPath = path.join(
      workspaceRoot(),
      `.tidy-readiness/probe-${lang}.${probe!.ext}`
    );
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, probe!.code, 'utf8');
    const uri = vscode.Uri.file(absPath);
    const document = await vscode.workspace.openTextDocument(uri);

    const deadline = Date.now() + timeoutMs;
    let edits = await computeFormatEdits(document);
    while (edits.length === 0 && Date.now() < deadline) {
      await flushEventLoop();
      edits = await computeFormatEdits(document);
    }
    assert.ok(
      edits.length > 0,
      `Tidy did not become the resolved formatter for '${lang}' within ` +
        `${timeoutMs}ms — the packaged extension provides no edits for a ` +
        `trivially reformattable ${lang} document (engine load / registration ` +
        `failure, the prettier-bundling-bug class).`
    );
  }

  return async () => {
    for (const lang of langs) {
      await vscode.workspace
        .getConfiguration('editor', { languageId: lang })
        .update(
          'defaultFormatter',
          undefined,
          vscode.ConfigurationTarget.Workspace,
          true
        );
    }
    // Remove the throwaway readiness-probe files so they never pollute the
    // workspace between runs.
    fs.rmSync(path.join(workspaceRoot(), '.tidy-readiness'), {
      recursive: true,
      force: true
    });
  };
}

/**
 * Yield to the macrotask queue a couple of times so VS Code's async edit / save
 * pipeline can settle before assertions read document or dirty state. Avoids
 * arbitrary fixed sleeps.
 */
export function flushEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 50));
}

/**
 * Reset every Workspace-scoped setting this suite touches back to "unset". Used
 * in a global afterEach so tests are order-independent.
 */
export async function clearTouchedConfig(): Promise<void> {
  const editor = vscode.workspace.getConfiguration('editor');
  await editor.update(
    'formatOnSave',
    undefined,
    vscode.ConfigurationTarget.Workspace
  );
  await editor.update(
    'defaultFormatter',
    undefined,
    vscode.ConfigurationTarget.Workspace
  );

  const tidy = vscode.workspace.getConfiguration('tidy');
  for (const key of [
    'css.enable',
    'html.enable',
    'json.enable',
    'javascript.enable'
  ]) {
    await tidy.update(key, undefined, vscode.ConfigurationTarget.Workspace);
  }
}
