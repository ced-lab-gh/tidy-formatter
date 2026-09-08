// Idempotence tests (SPEC SAFE-03): format(format(x)) === format(x) on the
// whole corpus. Covers the "code creeps right on every save" drift cluster.
//
// The pass is run through the SAME two steps the provider runs (buildMaskPlan ->
// dispatchFormat -> mask.restore) rather than through the dispatcher alone. That
// is not cosmetic: an in-source ignore region only exists once the mask plan has
// built it, so a corpus formatted through the bare dispatcher could never see the
// two restore-path defects that drifted WITHOUT BOUND behind that plan (HTML
// gaining two spaces before `<!-- tidy-ignore-start -->` on every format, CSS
// eating the line break after `/* tidy-ignore-end */`). Everything else about
// the corpus is unchanged: each language still uses its real engine, and a
// marker-free fixture gets no mask at all, so it takes the exact path it took
// before.
//
// Two assertions per fixture:
//   1. the second pass is a byte-for-byte no-op (the fixed point exists);
//   2. for a fixture with markers, every marker LINE comes back byte-identical,
//      indentation included and with nothing joined onto it, so a region that
//      merely stopped MOVING while sitting glued to the next selector would
//      still fail.
import assert from 'node:assert/strict';
import { dispatchFormat } from '../../../src/engine/dispatcher';
import { buildMaskPlan, engineTextFor } from '../../../src/engine/maskPlan';
import { scanMarkers } from '../../../src/ignore/markers';
import type { LangId, ResolvedOptions } from '../../../src/types';
import { idempotenceFixtures } from '../../fixtures/idempotenceFixtures';
import { resolved } from '../../helpers/options';

/**
 * One whole-document format through the real pipeline: plan the mask over the
 * document, hand the engine the text the plan says to hand it, then restore the
 * protected spans verbatim. Mirrors runFormat in the formatting provider, minus
 * the 'vscode' layer (edits, cancellation, notifications).
 */
async function formatDocument(
  lang: LangId,
  input: string,
  options: ResolvedOptions
): Promise<string> {
  const plan = buildMaskPlan(lang, input, 'document', {
    markerScan: scanMarkers(input, lang),
    inputOffset: 0,
    documentText: input
  });
  assert.equal(plan.abortReason, undefined, 'the plan must not abort');

  const output = await dispatchFormat({
    languageId: lang,
    code: engineTextFor(input, plan.mask),
    options
  });
  if (!plan.mask) {
    return output;
  }
  const restored = plan.mask.restore(output);
  assert.ok(restored.ok, `restore failed: ${restored.ok ? '' : restored.reason}`);
  return restored.text;
}

/** Every line carrying a tidy-ignore directive, verbatim (indentation kept). */
function markerLines(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => line.includes('tidy-ignore'));
}

describe('engine : idempotence (SPEC SAFE-03, drift protection)', () => {
  for (const f of idempotenceFixtures) {
    it(`${f.id}: format(format(x)) == format(x) for ${f.lang} [${f.ref}]`, async () => {
      const opts = resolved();
      const first = await formatDocument(f.lang, f.input, opts);
      const second = await formatDocument(f.lang, first, opts);
      assert.equal(second, first, `second pass drifted for ${f.id}`);
    });
  }

  // The marker fixtures exist for a defect that was invisible to a "did the
  // second pass change anything" test alone: CSS reached a fixed point on pass 3
  // with the next selector permanently glued onto the end-marker line. So the
  // marker lines are checked as bytes too.
  for (const f of idempotenceFixtures.filter((fixture) => fixture.ignoreMarkers)) {
    it(`${f.id}: keeps its marker lines byte-identical [${f.lang}]`, async () => {
      const expected = markerLines(f.input);
      assert.ok(expected.length > 0, `${f.id} declares markers but carries none`);

      const first = await formatDocument(f.lang, f.input, resolved());
      assert.deepEqual(
        markerLines(first),
        expected,
        `${f.id}: a marker line lost its indentation or gained a neighbour`
      );
    });
  }
});
