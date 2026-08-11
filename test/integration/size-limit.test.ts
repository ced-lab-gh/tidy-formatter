// Per-family size cap integration tests (ADD-08).
//
// Proves, against the REAL registered providers, that:
//   - the json family cap (tidy.json.maxFileSizeKB) gates json documents;
//   - an explicit global cap still applies to json when the family key is unset;
//   - the family key wins over the global key for json;
//   - the json key never leaks onto other languages;
//   - an adversarial string value never disables nor tightens the guard.
// Assertions are change vs no-change via computeFormatEdits (provider-level),
// mirroring lifecycle: a gated document yields ZERO edits, an admitted one
// yields at least one.
//
// This file deliberately creates NO multi-megabyte fixture: the matrix is proven
// with caps of 1 KB / 64 KB against ~2 KB documents. The multi-MB behaviour is
// covered by the perf bench (`npm run perf`, 10 MB JSON, CI-gated).
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  activateExtension,
  clearTouchedConfig,
  computeFormatEdits,
  ensureTidyDefaultFormatter,
  flushEventLoop,
  openFixture,
  REFORMATTABLE_CSS,
  setTidyConfig
} from './helpers';

/**
 * json/jsonc also have a built-in VS Code formatter, so the provider selection
 * must be pinned to Tidy: otherwise "zero edits" could mean "the built-in one
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
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await flushEventLoop();
  });

  function track(restore: () => Promise<void>): void {
    restoreFns.push(restore);
  }

  it('a json document above tidy.json.maxFileSizeKB yields zero edits, and formats again once the cap is restored', async () => {
    const document = await openFixture(
      'size-limit/gated.json',
      BIG_ENOUGH_JSON,
      'json'
    );

    // Positive control first: with defaults the ~2.3 KB document formats.
    const before = await computeFormatEdits(document);
    assert.ok(before.length > 0, 'precondition: Tidy reformats this json by default');

    const restore = await setTidyConfig('json.maxFileSizeKB', 1);
    track(restore);
    const gated = await computeFormatEdits(document);
    assert.equal(gated.length, 0, 'a 2 KB json must be gated by a 1 KB family cap');

    await restore();
    await flushEventLoop();
    const after = await computeFormatEdits(document);
    assert.ok(after.length > 0, 'restoring the cap must re-admit the document');
  });

  it('an explicit tidy.maxFileSizeKB gates json when the family key is unset', async () => {
    track(await setTidyConfig('maxFileSizeKB', 1));
    const document = await openFixture(
      'size-limit/global-gated.json',
      BIG_ENOUGH_JSON,
      'json'
    );
    const edits = await computeFormatEdits(document);
    assert.equal(
      edits.length,
      0,
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
    const edits = await computeFormatEdits(document);
    assert.ok(
      edits.length > 0,
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
    const edits = await computeFormatEdits(document);
    assert.ok(
      edits.length > 0,
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
    const edits = await computeFormatEdits(document);
    assert.ok(
      edits.length > 0,
      'a non-number cap value must fall back to the defaults, never gate nor disable'
    );
  });

  it('jsonc follows the json family cap', async () => {
    track(await setTidyConfig('json.maxFileSizeKB', 1));
    const document = await openFixture(
      'size-limit/gated.jsonc',
      BIG_ENOUGH_JSON,
      'jsonc'
    );
    const edits = await computeFormatEdits(document);
    assert.equal(edits.length, 0, 'jsonc must be governed by tidy.json.maxFileSizeKB');
  });

  it('setting the json cap to 0 disables it for json (nothing is gated)', async () => {
    track(await setTidyConfig('maxFileSizeKB', 1));
    track(await setTidyConfig('json.maxFileSizeKB', 0));
    const document = await openFixture(
      'size-limit/disabled-cap.json',
      BIG_ENOUGH_JSON,
      'json'
    );
    const edits = await computeFormatEdits(document);
    assert.ok(
      edits.length > 0,
      'json.maxFileSizeKB=0 must disable the cap for json, overriding the global 1 KB'
    );
  });
});
