// Headless onboarding / migration integration tests — ROADMAP Axe 1 (1.T2/1.T3/
// 1.T4). These run inside a real VS Code Electron host (via @vscode/test-cli),
// so they can prove the consent-first onboarding contract end-to-end the way no
// pure unit test can.
//
// What this suite locks down (the anti-hijack guarantees that make Axe 1 safe):
//   (a) opting Tidy in as the formatter writes editor.defaultFormatter
//       (overrideInLanguage) for the chosen language(s) at Workspace scope, and
//       resolves to 'ced-lab.tidy-formatter';
//   (b) CRITICAL — editor.formatOnSave is NEVER touched by that opt-in (inspect
//       before == inspect after). The #1 complaint about the incumbent was that
//       it hijacked save; Tidy must not, even while making itself the formatter;
//   (c) the migration prompt decision (shouldPromptMigration) is one-shot:
//       true while lonefy is present and unprompted, false forever after the
//       globalState dedup flag is set;
//   (d) the packaged VSIX ships media/walkthrough/* (the getting-started
//       walkthrough assets), verified via vsce's programmatic listFiles;
//   (e) once Tidy is the resolved default formatter, a real Format Document
//       through that default actually produces edits (it is not a silent no-op —
//       the "safe but does nothing" failure mode Axe 1 exists to kill).
//
// Design notes:
//  - We drive the SAME core the `tidy.useAsFormatter` command delegates to
//    (setDefaultFormatterForLangs) rather than popping the command's interactive
//    QuickPick, which would hang a headless host. That core is the exact write
//    path applyPlan() calls, so this is a faithful proof of the command's effect
//    without UI piloting.
//  - Every Workspace-scoped key we write is restored in afterEach via tracked
//    disposers plus a hard reset (clearTouchedConfig + per-language clears), so
//    the suite is order-independent and leaks no config into the other suites.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { listFiles } from '@vscode/vsce';
import {
  activateExtension,
  clearTouchedConfig,
  computeFormatEdits,
  flushEventLoop,
  openFixture,
  REFORMATTABLE_CSS
} from './helpers';
import {
  setDefaultFormatterForLangs,
  EXTENSION_ID
} from '../../src/commands/setDefaultFormatter';
import { shouldPromptMigration } from '../../src/migration/detectLonefy';

/**
 * Read the language-scoped Workspace value of editor.defaultFormatter for a
 * language, the exact form overrideInLanguage writes. Returns undefined when no
 * override is set for that language at Workspace scope.
 */
function inspectDefaultFormatter(languageId: string): string | undefined {
  return vscode.workspace
    .getConfiguration('editor', { languageId })
    .inspect<string>('defaultFormatter')?.workspaceLanguageValue;
}

/**
 * Snapshot every observable scope of editor.formatOnSave so a test can prove the
 * onboarding flow left it byte-identical. We capture the global + workspace +
 * (language-scoped, for the languages under test) values because "never touched"
 * must hold at every scope, not just one.
 */
function inspectFormatOnSave(languageId?: string): {
  globalValue: unknown;
  workspaceValue: unknown;
  workspaceLanguageValue: unknown;
} {
  const info = vscode.workspace
    .getConfiguration('editor', languageId ? { languageId } : undefined)
    .inspect('formatOnSave');
  return {
    globalValue: info?.globalValue,
    workspaceValue: info?.workspaceValue,
    workspaceLanguageValue: info?.workspaceLanguageValue
  };
}

/** Clear a per-language editor.defaultFormatter Workspace override. */
async function clearLanguageDefaultFormatter(languageId: string): Promise<void> {
  await vscode.workspace
    .getConfiguration('editor', { languageId })
    .update(
      'defaultFormatter',
      undefined,
      vscode.ConfigurationTarget.Workspace,
      true
    );
}

describe('Tidy onboarding & migration (Axe 1) — consent-first guarantees', function () {
  // First run downloads/opens the Electron host; give each case headroom.
  // CI-aware: shared/slow CI runners (cold VS Code download + Electron boot +
  // readiness poll) get a generous ceiling; local stays strict to keep the bar high.
  this.timeout(process.env.CI ? 180000 : 30000);

  let restoreFns: Array<() => Promise<void>> = [];

  before(async () => {
    await activateExtension();
  });

  afterEach(async () => {
    // Restore tracked per-test writes in reverse, then hard-reset every key the
    // onboarding flow could have touched so the suite is order-independent and
    // never leaks defaultFormatter / per-language overrides into other suites.
    for (const restore of restoreFns.reverse()) {
      await restore();
    }
    restoreFns = [];
    for (const lang of ['css', 'scss', 'html', 'typescriptreact']) {
      await clearLanguageDefaultFormatter(lang);
    }
    await clearTouchedConfig();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await flushEventLoop();
  });

  /** Track a restore disposer so afterEach can roll the write back. */
  function track(restore: () => Promise<void>): void {
    restoreFns.push(restore);
  }

  // (a) Opting Tidy in writes editor.defaultFormatter (overrideInLanguage) for
  //     the chosen language at Workspace scope and resolves to Tidy's id.
  it('(a) useAsFormatter core sets editor.defaultFormatter per language at Workspace scope', async () => {
    const langs = ['css', 'scss'] as const;

    // Precondition: no Workspace override exists for these languages yet, so the
    // post-write assertion is meaningful and not vacuously already-true.
    for (const lang of langs) {
      assert.equal(
        inspectDefaultFormatter(lang),
        undefined,
        `precondition: '${lang}' must have no Workspace defaultFormatter before opt-in`
      );
    }

    // Drive the exact core the tidy.useAsFormatter command's applyPlan() calls.
    await setDefaultFormatterForLangs(vscode, [...langs], 'workspace');
    track(async () => {
      for (const lang of langs) {
        await clearLanguageDefaultFormatter(lang);
      }
    });
    await flushEventLoop();

    for (const lang of langs) {
      assert.equal(
        inspectDefaultFormatter(lang),
        EXTENSION_ID,
        `'${lang}' must resolve to Tidy as its language-scoped Workspace defaultFormatter`
      );
    }

    // A language NOT chosen must remain untouched — the write surface is exactly
    // the requested languages, never wider (anti-hijack: no incidental writes).
    assert.equal(
      inspectDefaultFormatter('html'),
      undefined,
      'a language not passed to the core must keep no Workspace defaultFormatter'
    );
  });

  // (b) CRITICAL: opting Tidy in must NOT touch editor.formatOnSave at any scope.
  it('(b) opting Tidy in NEVER changes editor.formatOnSave (inspect before == after)', async () => {
    const lang = 'css';

    const beforeGlobalWs = inspectFormatOnSave();
    const beforeLang = inspectFormatOnSave(lang);

    await setDefaultFormatterForLangs(vscode, [lang], 'workspace');
    track(async () => clearLanguageDefaultFormatter(lang));
    await flushEventLoop();

    const afterGlobalWs = inspectFormatOnSave();
    const afterLang = inspectFormatOnSave(lang);

    // Sanity: the opt-in actually did its (only) job, so "formatOnSave unchanged"
    // is a real guarantee about a flow that wrote something — not a no-op test.
    assert.equal(
      inspectDefaultFormatter(lang),
      EXTENSION_ID,
      'precondition: the opt-in wrote defaultFormatter (so the test is non-vacuous)'
    );

    assert.deepEqual(
      afterGlobalWs,
      beforeGlobalWs,
      'editor.formatOnSave (global/workspace) must be byte-identical after opting Tidy in (#12 anti-hijack)'
    );
    assert.deepEqual(
      afterLang,
      beforeLang,
      'editor.formatOnSave (language-scoped) must be byte-identical after opting Tidy in (#12 anti-hijack)'
    );
  });

  // (c) The migration prompt decision is one-shot, deduplicated via globalState.
  it('(c) shouldPromptMigration is one-shot: true while unprompted, false after the dedup flag', async () => {
    // Mirror exactly the activation predicate: prompt only when the incumbent is
    // present AND we have not prompted before. We model globalState as the single
    // boolean the activation path persists (MIGRATION_PROMPTED_KEY).
    const lonefyPresent = true;

    let alreadyPrompted = false; // fresh machine+profile: never prompted yet.
    assert.equal(
      shouldPromptMigration(lonefyPresent, alreadyPrompted),
      true,
      'first encounter with the incumbent must offer the migration once'
    );

    // The activation flow records the dedup flag the moment the prompt is shown
    // (showMigrationNotification calls markPrompted() before awaiting the user),
    // so any subsequent decision must be false — the nag never repeats.
    alreadyPrompted = true;
    assert.equal(
      shouldPromptMigration(lonefyPresent, alreadyPrompted),
      false,
      'after the globalState dedup flag is set, the prompt must never be offered again (one-shot)'
    );

    // And it must also be false when the incumbent is simply absent, regardless
    // of the flag — nothing to migrate from.
    assert.equal(
      shouldPromptMigration(false, false),
      false,
      'with no incumbent installed, no migration prompt is offered'
    );
  });

  // (d) The packaged VSIX ships the walkthrough assets (media/walkthrough/*).
  it('(d) the VSIX includes media/walkthrough/* (getting-started walkthrough)', async () => {
    // vsce's programmatic listFiles honours .vscodeignore and yields exactly the
    // files that would be packed into the VSIX — proving the walkthrough markdown
    // + images ship, without building the .vsix or spawning a child process.
    const files = await listFiles({ cwd: extensionRoot() });
    const walkthrough = files.filter((f) =>
      f.replace(/\\/g, '/').includes('media/walkthrough/')
    );

    assert.ok(
      walkthrough.length > 0,
      'the VSIX must include media/walkthrough/* assets for the getting-started walkthrough'
    );

    // The four walkthrough steps each reference a markdown file in package.json;
    // all four must actually ship or the walkthrough renders broken.
    const shippedMarkdown = new Set(
      walkthrough.map((f) => f.replace(/\\/g, '/'))
    );
    for (const step of [
      'safety.md',
      'choose.md',
      'formatonsave.md',
      'migration.md'
    ]) {
      assert.ok(
        [...shippedMarkdown].some((f) => f.endsWith(`media/walkthrough/${step}`)),
        `walkthrough step asset media/walkthrough/${step} must ship in the VSIX`
      );
    }
  });

  // (e) Once Tidy is the resolved default formatter, Format Document via that
  //     default actually produces edits (kills the "safe but does nothing" mode).
  it('(e) after opting in, Format Document via Tidy as default produces edits', async () => {
    const lang = 'css';

    await setDefaultFormatterForLangs(vscode, [lang], 'workspace');
    track(async () => clearLanguageDefaultFormatter(lang));
    await flushEventLoop();

    assert.equal(
      inspectDefaultFormatter(lang),
      EXTENSION_ID,
      'precondition: Tidy is the resolved default formatter for CSS after opting in'
    );

    const document = await openFixture(
      'onboarding/opted-in.css',
      REFORMATTABLE_CSS,
      'css'
    );
    await vscode.window.showTextDocument(document);

    // computeFormatEdits asks VS Code core to compute the edits Tidy's provider
    // would apply — non-empty proves the opt-in produced a WORKING formatter, not
    // a silent no-op. Cold-host races are absorbed by a short readiness poll.
    let edits = await computeFormatEdits(document);
    const deadline = Date.now() + 10000;
    while (edits.length === 0 && Date.now() < deadline) {
      await flushEventLoop();
      edits = await computeFormatEdits(document);
    }
    assert.ok(
      edits.length > 0,
      'after opting Tidy in as the default formatter, Format Document must produce edits (not "safe but does nothing")'
    );
  });
});

/**
 * The extension's own root (where package.json / .vscodeignore live), which is
 * what vsce.listFiles must run against. The integration host opens a *fixture*
 * workspace folder (test/integration/workspace), so workspaceRoot() points there
 * — not at the extension. We derive the extension root from the activated
 * extension's URI instead.
 */
function extensionRoot(): string {
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(ext, `extension '${EXTENSION_ID}' must be present to locate its root`);
  return ext!.extensionPath;
}
