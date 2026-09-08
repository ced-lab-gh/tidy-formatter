// Per-family size cap integration tests (ADD-08).
//
// Proves, against the REAL registered providers, that:
//   - the json family cap (tidy.json.maxFileSizeKB) gates json documents;
//   - an explicit global cap still applies to json when the family key is unset;
//   - the family key wins over the global key for json;
//   - the json key never leaks onto other languages;
//   - an adversarial string value never disables nor tightens the guard.
//
// INSTRUMENT (this is load-bearing, do not "simplify" it back):
// every assertion runs `editor.action.formatDocument` on the shown editor with
// editor.defaultFormatter pinned to Tidy, and looks at the document TEXT.
// That command resolves exactly ONE formatter (the configured default) and runs
// only that one, so "the text did not change" really does mean "Tidy produced
// no edits".
//
// It deliberately does NOT use vscode.executeFormatDocumentProvider: that API
// command walks EVERY registered document formatter until one returns a
// non-empty result. json, jsonc and css all have a built-in formatter in the
// host, so when Tidy is gated the built-in one answers in its place. Measured in
// this repo's own host (VS Code 1.136.1): a ~2.3 KB compact json yields 402
// edits with Tidy gated, 402 edits with Tidy fully disabled
// (tidy.json.enable=false), and 402 edits with Tidy enabled. A "zero edits"
// assertion built on that command can therefore never pass and never proves
// anything about Tidy : that is exactly the bug this suite used to have.
//
// This file deliberately creates NO multi-megabyte fixture: the matrix is proven
// with caps of 1 KB / 64 KB against ~2 KB documents. The multi-MB behaviour is
// covered by the perf bench (`npm run perf`, 10 MB JSON, CI-gated).
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  activateExtension,
  clearTouchedConfig,
  ensureTidyDefaultFormatter,
  flushEventLoop,
  openFixture,
  REFORMATTABLE_CSS,
  runFormatDocument,
  setTidyConfig
} from './helpers';

/**
 * json/jsonc also have a built-in VS Code formatter, so the provider selection
 * must be pinned to Tidy: otherwise "unchanged" could mean "the built-in one
 * answered" instead of "Tidy's cap gated the document".
 */
const LANGS: readonly string[] = ['json', 'jsonc', 'css'];

/** A compact single-line JSON document Tidy always expands. */
function compactJson(entries: number): string {
  const value: Record<string, number> = {};
  for (let i = 0; i < entries; i += 1) {
    value[`key_${i}`] = i;
  }
  return `${JSON.stringify(value)}\n`;
}

const BIG_ENOUGH_JSON = compactJson(200); // ~2.3 KB, above a 1 KB cap
const BIG_ENOUGH_CSS = REFORMATTABLE_CSS.repeat(160); // ~2.2 KB of compact rules

/**
 * Run "Format Document" on a fixture through the configured default formatter
 * (pinned to Tidy in `before`) and return the document text afterwards.
 *
 * Mutating the buffer is the point: it is the only host-level signal that says
 * "Tidy, and nobody else, produced edits". Every fixture below is a throwaway
 * file created fresh by openFixture, so the mutation never leaks between tests.
 */
async function formatThroughTidy(
  document: vscode.TextDocument
): Promise<string> {
  await vscode.window.showTextDocument(document, { preview: false });
  await runFormatDocument();
  return document.getText();
}

/**
 * Format until the document actually changes, or fail loudly at the deadline.
 *
 * Used for every POSITIVE control. On a cold or heavily loaded Electron host the
 * first Format Document can land before the per-language defaultFormatter
 * override has propagated, and VS Code then quietly formats nothing. Retrying
 * absorbs that without hiding a real defect: if Tidy genuinely produces no
 * edits, this still fails, with the message the caller passed.
 *
 * The GATED assertions deliberately do NOT retry (one attempt, expect no
 * change); each of them is paired with one of these positive controls, so a host
 * that cannot format at all fails loudly here instead of letting a gate
 * assertion pass for the wrong reason.
 */
async function formatUntilChanged(
  document: vscode.TextDocument,
  original: string,
  message: string
): Promise<string> {
  // Two positive controls can run in one test case, so the per-control budget
  // must stay well under this suite's own this.timeout on both machines.
  const deadline = Date.now() + (process.env.CI ? 45000 : 8000);
  let text = await formatThroughTidy(document);
  while (text === original && Date.now() < deadline) {
    await flushEventLoop();
    text = await formatThroughTidy(document);
  }
  assert.notEqual(text, original, message);
  return text;
}

describe('Tidy size limit (ADD-08) : per-family caps', function () {
  this.timeout(process.env.CI ? 180000 : 30000);

  let restoreFns: Array<() => Promise<void>> = [];
  let restoreFormatter: (() => Promise<void>) | undefined;

  before(async () => {
    await activateExtension();
    restoreFormatter = await ensureTidyDefaultFormatter(LANGS);
  });

  after(async () => {
    if (restoreFormatter) {
      await restoreFormatter();
      restoreFormatter = undefined;
    }
  });

  afterEach(async () => {
    for (const restore of restoreFns.reverse()) {
      await restore();
    }
    restoreFns = [];
    await clearTouchedConfig();
    // Format Document applies its edit to the BUFFER and never saves, so every
    // fixture this suite formatted is left dirty. Revert and close them one by
    // one: a bare closeAllEditors would face dirty buffers and can raise a save
    // prompt in the host, which would wedge the run. The loop is bounded so a
    // stuck editor fails as a timeout rather than spinning forever.
    for (let i = 0; i < 8 && vscode.window.activeTextEditor; i += 1) {
      await vscode.commands.executeCommand(
        'workbench.action.revertAndCloseActiveEditor'
      );
      await flushEventLoop();
    }
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await flushEventLoop();
  });

  function track(restore: () => Promise<void>): void {
    restoreFns.push(restore);
  }

  it('a json document above tidy.json.maxFileSizeKB is left byte-identical, and formats again once the cap is restored', async () => {
    // Positive control first: with defaults the ~2.3 KB document formats. Each
    // phase gets its own fixture because formatting rewrites the buffer, so a
    // shared document would be "already formatted" by the second phase and the
    // gate assertion would pass for the wrong reason.
    const admitted = await openFixture(
      'size-limit/admitted.json',
      BIG_ENOUGH_JSON,
      'json'
    );
    await formatUntilChanged(
      admitted,
      BIG_ENOUGH_JSON,
      'precondition: Tidy reformats this json by default'
    );

    const restore = await setTidyConfig('json.maxFileSizeKB', 1);
    track(restore);
    const gated = await openFixture(
      'size-limit/gated.json',
      BIG_ENOUGH_JSON,
      'json'
    );
    assert.equal(
      await formatThroughTidy(gated),
      BIG_ENOUGH_JSON,
      'a 2 KB json must be gated by a 1 KB family cap: not one byte may change'
    );

    await restore();
    await flushEventLoop();
    const readmitted = await openFixture(
      'size-limit/readmitted.json',
      BIG_ENOUGH_JSON,
      'json'
    );
    await formatUntilChanged(
      readmitted,
      BIG_ENOUGH_JSON,
      'restoring the cap must re-admit the document'
    );
  });

  it('an explicit tidy.maxFileSizeKB gates json when the family key is unset', async () => {
    const control = await openFixture(
      'size-limit/global-control.json',
      BIG_ENOUGH_JSON,
      'json'
    );
    await formatUntilChanged(
      control,
      BIG_ENOUGH_JSON,
      'precondition: this json formats while no cap is set'
    );

    track(await setTidyConfig('maxFileSizeKB', 1));
    const document = await openFixture(
      'size-limit/global-gated.json',
      BIG_ENOUGH_JSON,
      'json'
    );
    assert.equal(
      await formatThroughTidy(document),
      BIG_ENOUGH_JSON,
      'an explicit global cap of 1 KB must still gate a 2 KB json document'
    );
  });

  it('the json family cap wins over the global cap for json', async () => {
    track(await setTidyConfig('maxFileSizeKB', 1));
    track(await setTidyConfig('json.maxFileSizeKB', 64));
    const document = await openFixture(
      'size-limit/family-wins.json',
      BIG_ENOUGH_JSON,
      'json'
    );
    await formatUntilChanged(
      document,
      BIG_ENOUGH_JSON,
      'with json.maxFileSizeKB=64 the 2 KB json must format even though the global cap is 1 KB'
    );
  });

  it('the json cap never gates css', async () => {
    track(await setTidyConfig('json.maxFileSizeKB', 1));
    const document = await openFixture(
      'size-limit/untouched.css',
      BIG_ENOUGH_CSS,
      'css'
    );
    await formatUntilChanged(
      document,
      BIG_ENOUGH_CSS,
      'a 2 KB css document must keep formatting: tidy.json.maxFileSizeKB is json/jsonc only'
    );
  });

  it('a string value for tidy.maxFileSizeKB is ignored and the default applies', async () => {
    track(await setTidyConfig('maxFileSizeKB', '1'));
    const document = await openFixture(
      'size-limit/string-value.json',
      BIG_ENOUGH_JSON,
      'json'
    );
    await formatUntilChanged(
      document,
      BIG_ENOUGH_JSON,
      'a non-number cap value must fall back to the defaults, never gate nor disable'
    );
  });

  it('jsonc follows the json family cap', async () => {
    const control = await openFixture(
      'size-limit/control.jsonc',
      BIG_ENOUGH_JSON,
      'jsonc'
    );
    await formatUntilChanged(
      control,
      BIG_ENOUGH_JSON,
      'precondition: this jsonc formats while no cap is set'
    );

    track(await setTidyConfig('json.maxFileSizeKB', 1));
    const document = await openFixture(
      'size-limit/gated.jsonc',
      BIG_ENOUGH_JSON,
      'jsonc'
    );
    assert.equal(
      await formatThroughTidy(document),
      BIG_ENOUGH_JSON,
      'jsonc must be governed by tidy.json.maxFileSizeKB'
    );
  });

  it('setting the json cap to 0 disables it for json (nothing is gated)', async () => {
    track(await setTidyConfig('maxFileSizeKB', 1));
    track(await setTidyConfig('json.maxFileSizeKB', 0));
    const document = await openFixture(
      'size-limit/disabled-cap.json',
      BIG_ENOUGH_JSON,
      'json'
    );
    await formatUntilChanged(
      document,
      BIG_ENOUGH_JSON,
      'json.maxFileSizeKB=0 must disable the cap for json, overriding the global 1 KB'
    );
  });

  // The instrument's own guarantee. Without this, every "unchanged" assertion
  // above could be passing because SOME other provider silently answered, or
  // because no formatter ran at all. With Tidy switched off for json, the
  // pinned default formatter has nothing to offer, and the document must stay
  // byte-identical : which is exactly the shape of a gated document. Pair that
  // with the positive controls above (same instrument, text DOES change) and
  // "unchanged" can only mean "Tidy, the only formatter that ran, produced no
  // edits".
  it('the instrument runs Tidy and nobody else: with Tidy disabled for json, Format Document changes nothing', async () => {
    track(await setTidyConfig('json.enable', false));
    const document = await openFixture(
      'size-limit/instrument.json',
      BIG_ENOUGH_JSON,
      'json'
    );
    assert.equal(
      await formatThroughTidy(document),
      BIG_ENOUGH_JSON,
      'with tidy.json.enable=false and Tidy pinned as the default formatter, no formatter may rewrite the document'
    );
  });
});
