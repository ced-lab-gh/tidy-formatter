// POLYGLOT end-to-end safety suite — runs INSIDE a real VS Code Electron host.
//
// This is the host-level counterpart of the pure-unit polyglot suites
// (test/unit/polyglot/*.test.ts). The unit tests prove the engine + guard keep
// embedded sub-languages intact on the *pure* dispatchFormat/guard API. THIS
// suite proves the same promise survives the full PACKAGED path through VS Code:
// the registered DocumentFormatting provider, the resolved editor config, the
// per-language defaultFormatter, and the on-disk document model.
//
// Why a separate host tier for polyglot specifically (the "prettier bundling
// bug" lesson): a polyglot file can format perfectly in unit tests yet NO-OP in
// the real host if the packaged extension fails to load an engine for an
// embedded language path (a bundling / lazy-load failure). Such a file passes
// every unit test but does nothing for the user. So for each big polyglot
// fixture this suite asserts end-to-end:
//   (a) the document CHANGED        -> Tidy actually ran (not a silent no-op);
//   (b) a SECOND Format Document is a no-op -> host-level idempotence (SAFE-03)
//       and a practical proof the output re-parses cleanly;
//   (c) every embedded / template-literal / <pre> / <textarea> / template-island
//       zone survives VERBATIM (no corruption of any sub-language; SAFE-01/02).
//       The applied edit was ALREADY gated by the provider's guard — VS Code
//       only received a TextEdit because guard.check() passed — so anything that
//       lands is semantically equivalent by construction; these verbatim checks
//       independently confirm the most dangerous fragments were not mangled.
//
// Per-language defaultFormatter is set EXACTLY the way a user does it via
// "Format Document With… → Configure Default Formatter… → Tidy".
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  activateExtension,
  ensureTidyDefaultFormatter,
  flushEventLoop,
  openFixture,
  runFormatDocument
} from './helpers';
import { polyglotHostFixtures } from '../fixtures/complex/polyglotHost';

// Every languageId this suite makes Tidy the per-language default for. Cleaned up
// in `after` so we never leak the override into another suite.
const LANGS = Array.from(new Set(polyglotHostFixtures.map((f) => f.lang)));

/**
 * Open a fixture, show it, run Format Document through VS Code core, and return
 * the resulting document text. Centralised so every case drives the exact same
 * user-facing path (the same command bound to the editor "Format Document"
 * action), routing unambiguously to Tidy via the per-language defaultFormatter.
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

describe('POLYGLOT integration — embedded sub-languages stay intact in a real VS Code host', function () {
  // First run downloads/opens the Electron host; these are the largest fixtures
  // in the suite and prettier (TSX) is heavy, so give generous headroom.
  // CI-aware: slow/shared CI runners get a much larger ceiling; local stays strict.
  this.timeout(process.env.CI ? 180000 : 60000);

  let restoreFormatter: (() => Promise<void>) | undefined;

  before(async () => {
    await activateExtension();
    // Make Tidy the per-language default formatter AND wait until it is actually
    // resolvable, so the very first Format Document on a cold host is never a
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

  for (const f of polyglotHostFixtures) {
    describe(`${f.id} — ${f.desc}`, () => {
      // (a) Tidy actually RAN on this polyglot file in the packaged host. A no-op
      // here is the exact "prettier bundling bug" class: a file that passes every
      // unit test but does nothing in the real host because an engine failed to
      // load / dispatch. We assert BOTH that the document changed AND that the
      // markers only the formatter could introduce are present.
      it('(a) reformats the polyglot document in the host (not a silent no-op)', async () => {
        const { formatted } = await formatFixtureInHost(f.relPath, f.input, f.lang);
        assert.notEqual(
          formatted,
          f.input,
          `${f.id}: Format Document produced no change in the real host — the ` +
            `packaged extension is a no-op for this polyglot file (engine load / ` +
            `dispatch failure, like the prettier bundling bug). If this same ` +
            `fixture formats in the unit suite, this is a PACKAGED-EXTENSION bug.`
        );
        for (const marker of f.mustChange) {
          assert.ok(
            formatted.includes(marker),
            `${f.id}: the formatter ran but did not produce the expected ` +
              `reformatting marker ${JSON.stringify(marker)} — the wrapper was ` +
              `not actually reflowed (possible partial / wrong-engine format).`
          );
        }
      });

      // (b) The formatted output is STABLE: a second Format Document changes
      // nothing. Host-level idempotence (SAFE-03) — and a practical proof every
      // embedded body re-parses cleanly, since an unstable/invalid output would
      // either keep drifting or be re-touched on the second pass.
      it('(b) a second Format Document is a no-op (host-level idempotence / re-parse)', async () => {
        const { document, formatted } = await formatFixtureInHost(
          f.relPath,
          f.input,
          f.lang
        );
        assert.notEqual(formatted, f.input, 'precondition: first pass reformatted');

        await runFormatDocument();
        const secondPass = document.getText();
        assert.equal(
          secondPass,
          formatted,
          `${f.id}: second Format Document drifted — output is not idempotent in ` +
            `the host (SAFE-03), which means an embedded zone is being re-touched.`
        );
      });

      // (c) NO CORRUPTION of any embedded / verbatim zone: every pinned substring
      // (embedded CSS values, embedded JS operators, JSON data, template islands,
      // <pre>/<textarea> bodies, opaque x-template, CSS-in-JS template-literal
      // bodies, GraphQL bodies, generics, JSX boundaries) survives byte-for-byte.
      it('(c) preserves every embedded/template/verbatim zone byte-for-byte', async () => {
        const { formatted } = await formatFixtureInHost(f.relPath, f.input, f.lang);
        for (const zone of f.verbatim) {
          assert.ok(
            formatted.includes(zone),
            `${f.id}: embedded/verbatim zone ${JSON.stringify(zone)} was ` +
              `lost or corrupted by the host format.\n--- formatted ---\n${formatted}`
          );
        }
      });
    });
  }

  // Cross-file isolation under a real "Format Document" (SAFE-04): formatting one
  // open polyglot document must leave the other open polyglot document
  // byte-identical. Proves the packaged provider only ever edits its target even
  // when both files carry several embedded languages.
  describe('cross-file isolation between two polyglot docs (SAFE-04)', () => {
    it('formatting the polyglot HTML leaves the open polyglot TSX byte-identical', async () => {
      const html = polyglotHostFixtures.find((f) => f.lang === 'html')!;
      const tsx = polyglotHostFixtures.find((f) => f.lang === 'typescriptreact')!;

      // Open both; only format the HTML one.
      const tsxDoc = await openFixture(
        'polyglot/isolation.tsx',
        tsx.input,
        'typescriptreact'
      );
      const htmlDoc = await openFixture(
        'polyglot/isolation.html',
        html.input,
        'html'
      );

      const tsxBefore = tsxDoc.getText();

      await vscode.window.showTextDocument(htmlDoc);
      await runFormatDocument();

      assert.notEqual(
        htmlDoc.getText(),
        html.input,
        'precondition: the polyglot HTML doc was actually reformatted'
      );
      assert.equal(
        tsxDoc.getText(),
        tsxBefore,
        'formatting the HTML document must not modify the open TSX document (SAFE-04)'
      );
    });
  });

  // A pinned regression: the opaque <script type="text/x-template"> body and the
  // CSS-in-JS / GraphQL template-literal bodies must be IDENTICAL substrings of
  // the formatted output — i.e. the host did not reindent a foreign body it is
  // not allowed to touch. This is the precise corruption class the incumbents hit
  // ("formatted my styled-components / my embedded template"), proven dead in the
  // packaged host.
  describe('foreign-body verbatim preservation in the host', () => {
    it('HTML x-template body and TSX styled/gql bodies are unchanged substrings', async () => {
      const html = polyglotHostFixtures.find((f) => f.id === 'PGH-HTML-KITCHEN-SINK')!;
      const tsx = polyglotHostFixtures.find((f) => f.id === 'PGH-TSX-CSS-IN-JS-GQL')!;

      const { formatted: htmlOut } = await formatFixtureInHost(
        'polyglot/foreign.html',
        html.input,
        'html'
      );
      assert.ok(
        htmlOut.includes(
          '<script type="text/x-template" id="tpl"><li class="row" data-id="{{ id }}">{{ label }}</li></script>'
        ),
        'opaque x-template body must be kept byte-identical by the host format'
      );

      const { formatted: tsxOut } = await formatFixtureInHost(
        'polyglot/foreign.tsx',
        tsx.input,
        'typescriptreact'
      );
      assert.ok(
        tsxOut.includes('`\n  color: red;\n  padding:   8px;\n   margin: 0;\n`'),
        'styled.div`` body (with irregular interior spacing) must be verbatim'
      );
      assert.ok(
        tsxOut.includes(
          '`\n  query GetUser($id: ID!) {\n      user(id: $id) {   name email }\n  }\n`'
        ),
        'gql`` GraphQL body (with irregular spacing) must be verbatim'
      );
    });
  });
});
