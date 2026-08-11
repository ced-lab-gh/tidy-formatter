// Tests for the mask plan (ADD-02): the module that composes ignore REGIONS and
// HTML TEMPLATE ISLANDS into the single engine-facing mask the providers use.
//
// The suite runs the REAL js-beautify HTML engine and the REAL guard so it
// proves the product promise rather than a mock of it: an island comes back
// BYTE FOR BYTE, and the guard still judges the restored document.
//
// Why the island layer exists at all is asserted explicitly by the
// "invisible to the guard" case below: an engine reflow inside a `{% %}` tag is
// whitespace in an HTML text node, which the guard normalises away, so without
// masking a corrupted island would be APPLIED.
import assert from 'node:assert/strict';
import {
  buildMaskPlan,
  TEMPLATE_COLLISION_REASON,
  TEMPLATE_RESTORE_FAILED_REASON,
  REGION_RESTORE_FAILED_REASON
} from '../../../src/engine/maskPlan';
import { dispatchFormat } from '../../../src/engine/dispatcher';
import { guard } from '../../../src/safety/guard';
import { resolved } from '../../helpers/options';
import {
  frontMatterFixtures,
  templateFixtures
} from '../../fixtures/templateFixtures';
import type { LangId } from '../../../src/types';

/** Format `input` through the plan exactly as the provider's runFormat does. */
async function formatThroughPlan(
  lang: LangId,
  input: string,
  scope: 'document' | 'selection' = 'document'
): Promise<{ text?: string; abortReason?: string; islands: number }> {
  const plan = buildMaskPlan(lang, input, scope);
  if (plan.abortReason !== undefined) {
    return { abortReason: plan.abortReason, islands: plan.templateIslandCount };
  }
  const raw = await dispatchFormat({
    languageId: lang,
    code: plan.mask ? plan.mask.engineInput : input,
    options: resolved()
  });
  if (!plan.mask) {
    return { text: raw, islands: plan.templateIslandCount };
  }
  const restored = plan.mask.restore(raw);
  return restored.ok
    ? { text: restored.text, islands: plan.templateIslandCount }
    : { abortReason: restored.reason, islands: plan.templateIslandCount };
}

describe('engine/maskPlan : non-HTML languages keep their pre-ADD-02 behaviour', () => {
  for (const lang of ['css', 'scss', 'less', 'json', 'javascript'] as const) {
    it(`${lang}: no regions means no mask and zero islands`, () => {
      const plan = buildMaskPlan(lang, '.a{color:red}', 'document');
      assert.equal(plan.mask, undefined);
      assert.equal(plan.templateIslandCount, 0);
      assert.equal(plan.abortReason, undefined);
    });
  }

  it('typescript is never region-masked (Prettier honours prettier-ignore natively)', () => {
    const input = '/* tidy-ignore-start */\nconst a=1\n/* tidy-ignore-end */\n';
    const plan = buildMaskPlan('typescript', input, 'document');
    assert.equal(plan.mask, undefined);
    assert.equal(plan.templateIslandCount, 0);
  });

  it('css with an ignore region still gets the region mask', () => {
    const input = '/* tidy-ignore-start */\n.keep{color:red}\n/* tidy-ignore-end */\n.b{color:blue}';
    const plan = buildMaskPlan('css', input, 'document');
    assert.ok(plan.mask, 'a region mask was expected');
    assert.equal(plan.templateIslandCount, 0);
    assert.ok(
      !plan.mask.engineInput.includes('.keep{color:red}'),
      'the protected region must be hidden from the engine'
    );
  });

  it('selection scope never masks regions (unchanged behaviour)', () => {
    const input = '/* tidy-ignore-start */\n.keep{color:red}\n/* tidy-ignore-end */';
    assert.equal(buildMaskPlan('css', input, 'selection').mask, undefined);
  });
});

describe('engine/maskPlan : HTML template islands survive a REAL format byte for byte', () => {
  for (const fixture of templateFixtures) {
    it(`${fixture.id}: ${fixture.desc}`, async () => {
      const result = await formatThroughPlan('html', fixture.html);
      assert.equal(result.abortReason, undefined, 'no abort expected');
      assert.equal(
        result.islands,
        fixture.islands.length,
        'every island must be counted'
      );
      assert.ok(result.text !== undefined);
      for (const island of fixture.islands) {
        assert.ok(
          result.text.includes(island),
          `${fixture.id}: island ${JSON.stringify(island)} must come back verbatim`
        );
      }
    });
  }

  for (const fixture of frontMatterFixtures) {
    it(`${fixture.id}: front matter survives a real HTML format byte for byte`, async () => {
      const result = await formatThroughPlan('html', fixture.html);
      assert.equal(result.abortReason, undefined);
      assert.ok(result.text !== undefined);
      assert.ok(
        result.text.startsWith(
          fixture.html.charCodeAt(0) === 0xfeff
            ? `﻿${fixture.frontMatter}`
            : fixture.frontMatter
        ),
        `${fixture.id}: the head block must be byte-identical, got ${JSON.stringify(
          result.text.slice(0, 80)
        )}`
      );
    });
  }

  it('the guard still judges the restored document (islands never reach it as placeholders)', async () => {
    const input = '<div>{% if u %}<p>{{ u.name }}</p>{% endif %}</div>';
    const result = await formatThroughPlan('html', input);
    assert.ok(result.text !== undefined);
    const verdict = guard.check('html', input, result.text);
    assert.equal(verdict.equivalent, true, verdict.reason);
    assert.ok(
      !result.text.includes('tidytplisland'),
      'no placeholder may leak into the applied text'
    );
  });

  it('THE HAZARD: front matter corruption is invisible to the guard, so only masking can stop it', async () => {
    // Reproduces incumbent issue 75 against the REAL engine and the REAL guard.
    // The YAML block below carries significant leading and inner whitespace.
    const input = '---\n  title:   Home\n---\n<div><p>x</p></div>\n';

    // 1. WITHOUT the mask, the beautifier rewrites the YAML ('  title:   Home'
    //    becomes 'title: Home'), destroying meaning-bearing whitespace.
    const unmasked = await dispatchFormat({
      languageId: 'html',
      code: input,
      options: resolved()
    });
    assert.ok(
      !unmasked.includes('  title:   Home'),
      'precondition: the bare engine really does rewrite the front matter'
    );

    // 2. And the guard ACCEPTS that rewrite, because the whole block lands in an
    //    HTML text node whose whitespace the guard normalises away. So without
    //    ADD-02 this corruption would have been APPLIED to the user's file.
    assert.equal(
      guard.check('html', input, unmasked).equivalent,
      true,
      'this is the whole point: the guard cannot see front matter corruption'
    );

    // 3. WITH the plan, the block comes back byte for byte and the rest of the
    //    document is still formatted.
    const planned = await formatThroughPlan('html', input);
    assert.equal(planned.abortReason, undefined);
    assert.ok(planned.text !== undefined);
    assert.ok(
      planned.text.startsWith('---\n  title:   Home\n---'),
      `front matter must be byte-identical, got ${JSON.stringify(planned.text)}`
    );
    assert.ok(
      planned.text.includes('<p>x</p>'),
      'the body must still be formatted'
    );
  });

  it('islands are masked in SELECTION scope too, but front matter is not', () => {
    const input = '---\na: 1\n---\n<p>{{ x }}</p>';
    const selection = buildMaskPlan('html', input, 'selection');
    assert.equal(selection.templateIslandCount, 1, 'only the {{ x }} island');
    const document = buildMaskPlan('html', input, 'document');
    assert.equal(
      document.templateIslandCount,
      2,
      'document scope adds the front matter island'
    );
  });

  it('plain HTML with no island and no region needs no mask at all', () => {
    const plan = buildMaskPlan('html', '<p>plain</p>', 'document');
    assert.equal(plan.mask, undefined);
    assert.equal(plan.templateIslandCount, 0);
  });
});

describe('engine/maskPlan : every failure path is fail-safe (zero edit)', () => {
  it('a placeholder collision aborts BEFORE any engine call, with no mask', () => {
    const plan = buildMaskPlan(
      'html',
      '<p>tidytplisland</p><i>{{ x }}</i>',
      'document'
    );
    assert.equal(plan.abortReason, TEMPLATE_COLLISION_REASON);
    assert.equal(plan.mask, undefined, 'no mask may be handed to any engine');
    assert.equal(plan.templateIslandCount, 1);
  });

  it('the collision reason maps to the restore-failed status prefix', () => {
    assert.ok(TEMPLATE_COLLISION_REASON.startsWith('template-island'));
    assert.ok(TEMPLATE_RESTORE_FAILED_REASON.startsWith('template-island'));
    assert.ok(
      REGION_RESTORE_FAILED_REASON.startsWith('ignore-region restore failed')
    );
  });

  it('a dropped island placeholder fails the restore', () => {
    const plan = buildMaskPlan('html', '<p>{{ x }}</p>', 'document');
    assert.ok(plan.mask);
    const restored = plan.mask.restore('<p></p>');
    assert.equal(restored.ok, false);
    if (restored.ok) return;
    assert.equal(restored.reason, TEMPLATE_RESTORE_FAILED_REASON);
  });

  it('a duplicated island placeholder fails the restore', () => {
    const plan = buildMaskPlan('html', '<p>{{ x }}</p>', 'document');
    assert.ok(plan.mask);
    const doubled = `${plan.mask.engineInput}${plan.mask.engineInput}`;
    const restored = plan.mask.restore(doubled);
    assert.equal(restored.ok, false);
  });

  it('an island that swallowed a region token fails the restore (cross case)', async () => {
    // The region placeholder is masked first; an island pattern that then wraps
    // it means the region token would reappear twice at restore time.
    const input =
      '<!-- tidy-ignore-start -->\n<b>keep</b>\n<!-- tidy-ignore-end -->\n<p>{{ x }}</p>';
    const plan = buildMaskPlan('html', input, 'document');
    assert.ok(plan.mask, 'both layers must be present');
    // Simulate an engine that duplicated the whole masked body.
    const restored = plan.mask.restore(
      `${plan.mask.engineInput}\n${plan.mask.engineInput}`
    );
    assert.equal(restored.ok, false, 'a duplicated protected span must abort');
  });

  it('regions and islands compose: an island INSIDE a region is not double-masked', () => {
    const input =
      '<!-- tidy-ignore-start -->\n<b>{{ frozen }}</b>\n<!-- tidy-ignore-end -->\n<p>{{ live }}</p>';
    const plan = buildMaskPlan('html', input, 'document');
    assert.ok(plan.mask);
    assert.equal(
      plan.templateIslandCount,
      1,
      'only the island outside the region is masked as an island'
    );
    assert.ok(
      !plan.mask.engineInput.includes('{{ frozen }}'),
      'the in-region island is already hidden by the region placeholder'
    );
    const roundTrip = plan.mask.restore(plan.mask.engineInput);
    assert.ok(roundTrip.ok, 'an untouched engine input must restore cleanly');
    assert.equal(
      roundTrip.text,
      input,
      'restoring an untouched engine input reproduces the original exactly'
    );
  });

  it('a real format of a region+island document keeps BOTH verbatim', async () => {
    const input =
      '<!-- tidy-ignore-start -->\n<b>{{  frozen  }}</b>\n<!-- tidy-ignore-end -->\n<p>{{ live }}</p>';
    const result = await formatThroughPlan('html', input);
    assert.equal(result.abortReason, undefined);
    assert.ok(result.text !== undefined);
    assert.ok(
      result.text.includes('<b>{{  frozen  }}</b>'),
      'the ignore region keeps its exact bytes'
    );
    assert.ok(
      result.text.includes('{{ live }}'),
      'the template island keeps its exact bytes'
    );
  });
});

describe('engine/maskPlan : idempotence through the plan', () => {
  for (const fixture of [...templateFixtures, ...frontMatterFixtures]) {
    it(`${fixture.id}: mask -> format -> restore twice is stable`, async () => {
      const first = await formatThroughPlan('html', fixture.html);
      assert.ok(first.text !== undefined, 'first pass must produce text');
      const second = await formatThroughPlan('html', first.text);
      assert.equal(
        second.text,
        first.text,
        'a second pass through the plan must be byte-identical'
      );
    });
  }
});
