// Data-driven truth harness for the CSS/SCSS/LESS fallback (ADD-01).
// Replays the provider pipeline WITHOUT vscode: primary dispatch -> guard ->
// (on rejection) postcss fallback dispatch -> guard. Asserts, per corpus entry:
// the manifest's expected status, a fresh guard verdict on whatever would be
// applied, and pipeline idempotence (running the FULL pipeline again on the
// applied output must be a clean no-op). Byte comparisons throughout; never
// guard.check(out, out), whose identity fast path is always true.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  dispatchFormat,
  dispatchCssFallback
} from '../../../src/engine/dispatcher';
import { guard } from '../../../src/safety/guard';
import { resolved } from '../../helpers/options';
import { cssCorpus } from '../../fixtures/css-sass/manifest';
import type { LangId } from '../../../src/types';

const FIXTURE_DIR = join(__dirname, '..', '..', 'fixtures', 'css-sass');

/** Line-ending-agnostic read: git may check fixtures out as CRLF on Windows. */
function readFixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), 'utf8').replace(/\r\n/g, '\n');
}

type PipelineStatus =
  | 'applied-jsbeautify'
  | 'applied-fallback'
  | 'guard-rejected'
  | 'already-tidy';

interface PipelineResult {
  status: PipelineStatus;
  output?: string;
  primaryReason?: string;
  fallbackReason?: string;
}

/** Vscode-free replay of runFormat + tryCssFallback for the CSS family. */
async function runPipeline(
  lang: LangId,
  input: string
): Promise<PipelineResult> {
  const options = resolved();
  const primary = await dispatchFormat({
    languageId: lang,
    code: input,
    options
  });
  if (primary === input) {
    return { status: 'already-tidy', output: input };
  }
  const verdict = guard.check(lang, input, primary);
  if (verdict.equivalent) {
    return { status: 'applied-jsbeautify', output: primary };
  }
  let fallbackOut: string;
  try {
    fallbackOut = await dispatchCssFallback({
      languageId: lang,
      code: input,
      options
    });
  } catch (error: unknown) {
    return {
      status: 'guard-rejected',
      primaryReason: verdict.reason,
      fallbackReason: `engine error: ${
        error instanceof Error ? error.message : String(error)
      }`
    };
  }
  if (fallbackOut === input) {
    return { status: 'already-tidy', output: input };
  }
  const fallbackVerdict = guard.check(lang, input, fallbackOut);
  if (fallbackVerdict.equivalent) {
    return { status: 'applied-fallback', output: fallbackOut };
  }
  return {
    status: 'guard-rejected',
    primaryReason: verdict.reason,
    fallbackReason: fallbackVerdict.reason
  };
}

describe('engine/cssFallback : mined corpus statuses (ADD-01 truth harness)', () => {
  for (const entry of cssCorpus) {
    it(`${entry.id}: ${entry.desc} => ${entry.expected} [${entry.ref}]`, async () => {
      const input = readFixture(entry.file);
      const result = await runPipeline(entry.lang, input);
      assert.equal(
        result.status,
        entry.expected,
        `pipeline status drifted for ${entry.id}` +
          (result.primaryReason ? `\n  primary : ${result.primaryReason}` : '') +
          (result.fallbackReason ? `\n  fallback: ${result.fallbackReason}` : '')
      );
    });
  }

  it('the corpus keeps at least one entry proving the fallback earns its place', () => {
    const rescued = cssCorpus.filter((e) => e.expected === 'applied-fallback');
    assert.ok(
      rescued.length > 0,
      'a corpus with no applied-fallback entry would silently stop measuring ADD-01'
    );
  });
});

describe('engine/cssFallback : applied outputs are guard-verified and pipeline-idempotent', () => {
  for (const entry of cssCorpus.filter((e) => e.expected !== 'guard-rejected')) {
    it(`${entry.id}: guard accepts the applied output and a second full pipeline run is a no-op`, async () => {
      const input = readFixture(entry.file);
      const first = await runPipeline(entry.lang, input);
      assert.ok(first.output !== undefined, 'expected an applied output');
      // Fresh, explicit verdict on exactly what would be written (input vs
      // output, never output vs output).
      const verdict = guard.check(entry.lang, input, first.output);
      assert.equal(
        verdict.equivalent,
        true,
        `guard must accept what the pipeline applies (${verdict.reason ?? 'no reason'})`
      );
      // Idempotence of the WHOLE pipeline: formatting the formatted text again
      // must settle as a clean no-op, whichever engine won the first round.
      const second = await runPipeline(entry.lang, first.output);
      assert.equal(
        second.status,
        'already-tidy',
        `second pipeline run must be a no-op, got '${second.status}'` +
          (second.fallbackReason ? ` (${second.fallbackReason})` : '')
      );
    });
  }
});

describe('engine/cssFallback : rejected entries stay safe no-ops on both candidates', () => {
  for (const entry of cssCorpus.filter((e) => e.expected === 'guard-rejected')) {
    it(`${entry.id}: both candidates rejected, reasons recorded, nothing applied`, async () => {
      const input = readFixture(entry.file);
      const result = await runPipeline(entry.lang, input);
      assert.equal(result.status, 'guard-rejected');
      assert.ok(result.primaryReason, 'primary rejection must carry a reason');
      assert.ok(result.fallbackReason, 'fallback rejection must carry a reason');
      assert.equal(result.output, undefined, 'nothing may be applied');
    });
  }
});
