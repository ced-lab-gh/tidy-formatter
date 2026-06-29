// COMPLEX end-to-end safety suite — runs INSIDE a real VS Code Electron host.
//
// The product's whole moat is SAFETY: the guard must never let a meaning-changing
// output through, and must never reject a correct one (which would make Tidy a
// silent no-op — the "safe but does nothing" failure the SPEC forbids, §12). The
// unit suites prove this on the *pure* engine + guard. This suite proves the same
// promise survives the full packaged path through VS Code: the registered
// DocumentFormatting provider, the resolved editor config, the per-language
// defaultFormatter, and the on-disk document model.
//
// Why this tier matters (the "prettier bug" lesson): an engine that formats
// correctly in unit tests can still NO-OP in the real host if the packaged
// extension fails to load its engine (e.g. a bundling problem). Such a file would
// pass every unit test yet do nothing for the user. So for each big, real-world
// fixture we assert end-to-end:
//   (a) the document CHANGED  -> Tidy actually ran (not a silent no-op);
//   (b) a SECOND Format Document is a no-op -> the output is stable / re-parses
//       cleanly (host-level idempotence, SAFE-03);
//   (c) NO LOSS -> every meaning-bearing token survives verbatim, and for JSON
//       the parsed value is deep-equal to the input (host-level semantic
//       equivalence via a stable comparison, SAFE-01/02). Note the applied edit
//       was ALREADY gated by the provider's guard — VS Code only received a
//       TextEdit because guard.check() passed — so anything that lands is
//       equivalent by construction; these assertions independently confirm it.
//
// Per-language defaultFormatter is set EXACTLY the way a user does it via
// "Format Document With… → Configure Default Formatter… → Tidy":
//   getConfiguration('editor', { languageId }).update('defaultFormatter',
//     'ced-lab.tidy-formatter', Workspace, /*overrideInLanguage*/ true)
// This makes editor.action.formatDocument route unambiguously to Tidy even for
// languages that ship a built-in formatter (TS/TSX, CSS, HTML, JSON).
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  activateExtension,
  ensureTidyDefaultFormatter,
  flushEventLoop,
  openFixture,
  runFormatDocument
} from './helpers';
import { hostComplexFixtures } from '../fixtures/complex/hostComplex';

// Every languageId this suite makes Tidy the per-language default for. Cleaned up
// in `after` so we never leak the override into another suite.
const LANGS = ['typescriptreact', 'scss', 'html', 'json'];

/**
 * Open a fixture, show it, run Format Document through VS Code core, and return
 * the resulting document text. The caller asserts on it. Centralised so every
 * case drives the exact same user-facing path.
 */
async function formatFixtureInHost(
  relPath: string,
  content: string,
  lang: string
): Promise<{ document: vscode.TextDocument; formatted: string }> {
  const document = await openFixture(relPath, content, lang);
  await vscode.window.showTextDocument(document);
  await runFormatDocument();
  return { document, formatted: document.getText() };
}

describe('COMPLEX integration — Tidy is safe end-to-end in a real VS Code host', function () {
  // First run downloads/opens the Electron host; large fixtures + prettier are
  // heavier than the lifecycle cases, so give generous headroom.
  this.timeout(60000);

  let restoreFormatter: (() => Promise<void>) | undefined;

  before(async () => {
    await activateExtension();
    // Make Tidy the per-language default formatter AND wait until it is actually
    // resolvable, so the first Format Document on a cold host is never a
    // race-induced no-op (see ensureTidyDefaultFormatter for the rationale).
    restoreFormatter = await ensureTidyDefaultFormatter(LANGS);
  });

  after(async () => {
    if (restoreFormatter) {
      await restoreFormatter();
    }
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await flushEventLoop();
  });

  afterEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await flushEventLoop();
  });

  for (const f of hostComplexFixtures) {
    describe(`${f.id} — ${f.desc}`, () => {
      // (a) Tidy actually RAN: the packaged extension reformatted the document.
      // A no-op here would reproduce the "prettier bug" class — a file that
      // passes unit tests but does nothing in the real host.
      it('(a) reformats the document in the host (not a silent no-op)', async () => {
        const { formatted } = await formatFixtureInHost(
          f.relPath,
          f.input,
          f.lang
        );
        assert.notEqual(
          formatted,
          f.input,
          `${f.id}: Format Document produced no change in the real host — the ` +
            `packaged extension is a no-op for this language (engine load / ` +
            `dispatch failure, like the prettier bundling bug)`
        );
      });

      // (b) The formatted output is STABLE: a second Format Document changes
      // nothing. Host-level idempotence (SAFE-03) — and a practical proof the
      // output re-parses cleanly, since an unstable/invalid output would either
      // keep drifting or be re-touched on the second pass.
      it('(b) a second Format Document is a no-op (host-level idempotence / re-parse)', async () => {
        const { document, formatted } = await formatFixtureInHost(
          f.relPath,
          f.input,
          f.lang
        );
        assert.notEqual(formatted, f.input, 'precondition: first pass reformatted');

        // Second pass on the already-formatted, active document.
        await runFormatDocument();
        const secondPass = document.getText();
        assert.equal(
          secondPass,
          formatted,
          `${f.id}: second Format Document drifted — output is not idempotent ` +
            `in the host (SAFE-03)`
        );
      });

      // (c) NO LOSS: every meaning-bearing token survives verbatim. The provider
      // only emitted a TextEdit because its guard accepted the output as
      // semantically equivalent, so these tokens independently confirm the most
      // dangerous fragments (generics, JSX, optional chaining, calc(), template
      // islands, deep JSON keys) were not corrupted.
      it('(c) preserves every meaning-bearing token verbatim (no corruption)', async () => {
        const { formatted } = await formatFixtureInHost(
          f.relPath,
          f.input,
          f.lang
        );
        for (const token of f.mustContain) {
          assert.ok(
            formatted.includes(token),
            `${f.id}: token \`${token}\` was lost/corrupted by the host format.\n` +
              `--- formatted ---\n${formatted}`
          );
        }
      });
    });
  }

  // Stronger semantic equivalence cross-check for JSON: parse the formatted
  // output and the original input and assert deep value-equality. This is the
  // host-level analogue of the jsonEqual guard — proving the pretty-print was a
  // pure whitespace change with zero value loss, computed without importing any
  // src/* guard (we use the host's own JSON.parse + node:assert deepStrictEqual).
  describe('JSON deep-equality cross-check (semantic equivalence in the host)', () => {
    const jsonFixture = hostComplexFixtures.find((f) => f.lang === 'json');
    assert.ok(jsonFixture, 'expected a json fixture in the host corpus');

    it('formatted JSON parses to a value deep-equal to the input', async () => {
      const { formatted } = await formatFixtureInHost(
        jsonFixture!.relPath,
        jsonFixture!.input,
        jsonFixture!.lang
      );
      const before = JSON.parse(jsonFixture!.input);
      const after = JSON.parse(formatted);
      assert.deepStrictEqual(
        after,
        before,
        'pretty-printing must not change any JSON value (host-level jsonEqual)'
      );
    });
  });

  // Cross-file isolation under a real "Format Document" (SAFE-04): formatting one
  // open document must leave the other open documents byte-identical. The
  // incumbent leaked content across panels (#56,#29,#102,#110); this proves the
  // packaged provider only ever edits its target.
  describe('cross-file isolation under host Format Document (SAFE-04)', () => {
    it('formatting one complex doc leaves the others byte-identical', async () => {
      const tsx = hostComplexFixtures.find((f) => f.lang === 'typescriptreact')!;
      const scss = hostComplexFixtures.find((f) => f.lang === 'scss')!;

      // Open both; only format the SCSS one.
      const tsxDoc = await openFixture(
        'complex/isolation.tsx',
        tsx.input,
        'typescriptreact'
      );
      const scssDoc = await openFixture(
        'complex/isolation.scss',
        scss.input,
        'scss'
      );

      const tsxBefore = tsxDoc.getText();

      await vscode.window.showTextDocument(scssDoc);
      await runFormatDocument();

      assert.notEqual(
        scssDoc.getText(),
        scss.input,
        'precondition: the SCSS doc was actually reformatted'
      );
      // The untouched TSX document must be byte-identical to before — Tidy never
      // edits a document that is not the active format target.
      assert.equal(
        tsxDoc.getText(),
        tsxBefore,
        'formatting the SCSS document must not modify the open TSX document (SAFE-04)'
      );
    });
  });
});
