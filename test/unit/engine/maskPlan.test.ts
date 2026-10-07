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
  engineSpanFor,
  engineTextFor,
  TEMPLATE_COLLISION_REASON,
  TEMPLATE_RESTORE_FAILED_REASON,
  REGION_RESTORE_FAILED_REASON,
  FRONT_MATTER_MASK_FAILED_REASON,
  TEMPLATE_ISLAND_SPANS_UNUSABLE_REASON,
  UNHONOURED_IGNORE_PREFIX,
  UNHONOURED_IGNORE_PRETTIER_PATH,
  UNHONOURED_IGNORE_MASK_UNAVAILABLE,
  type MaskContext
} from '../../../src/engine/maskPlan';
import { dispatchCssFallback, dispatchFormat } from '../../../src/engine/dispatcher';
import { scanMarkers } from '../../../src/ignore/markers';
import { guard } from '../../../src/safety/guard';
import { guardCheckNoFastPath } from '../../helpers/guardCheck';
import { resolved } from '../../helpers/options';
import {
  frontMatterFixtures,
  templateFixtures
} from '../../fixtures/templateFixtures';
import type { LangId } from '../../../src/types';

/**
 * Format `input` through the plan exactly as the provider's runFormat does,
 * INCLUDING the rule that matters most for a selection: the range handed to the
 * engine is derived from the text the engine actually receives (engineSpanFor),
 * never from the caller's input length.
 */
async function formatThroughPlan(
  lang: LangId,
  input: string,
  scope: 'document' | 'selection' = 'document',
  context?: MaskContext
): Promise<{ text?: string; abortReason?: string; islands: number }> {
  const plan = buildMaskPlan(lang, input, scope, context);
  if (plan.abortReason !== undefined) {
    return { abortReason: plan.abortReason, islands: plan.templateIslandCount };
  }
  const raw = await dispatchFormat({
    languageId: lang,
    code: engineTextFor(input, plan.mask),
    options: resolved(),
    range: scope === 'selection' ? engineSpanFor(input, plan.mask) : undefined
  });
  if (!plan.mask) {
    return { text: raw, islands: plan.templateIslandCount };
  }
  const restored = plan.mask.restore(raw);
  return restored.ok
    ? { text: restored.text, islands: plan.templateIslandCount }
    : { abortReason: restored.reason, islands: plan.templateIslandCount };
}

/** The mask context the provider passes for a whole-document format. */
function documentContext(lang: LangId, text: string): MaskContext {
  return { markerScan: scanMarkers(text, lang), inputOffset: 0, documentText: text };
}

/**
 * The mask context the provider passes for a selection of `documentText`. It
 * carries the document text as well as the scan: front matter is a document-level
 * construct, so a fragment can only be protected against the document it came
 * from (see providers/formattingProvider.ts, which passes fullText here).
 */
function selectionContext(
  lang: LangId,
  documentText: string,
  startOffset: number
): MaskContext {
  return {
    markerScan: scanMarkers(documentText, lang),
    inputOffset: startOffset,
    documentText
  };
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

  it('SELECTION scope masks regions too (FIX-B: it used to ignore them silently)', () => {
    const input = '/* tidy-ignore-start */\n.keep{color:red}\n/* tidy-ignore-end */';
    const plan = buildMaskPlan('css', input, 'selection');
    assert.ok(plan.mask, 'a selection must get the same protection as a document');
    assert.ok(
      !plan.mask.engineInput.includes('.keep{color:red}'),
      'the protected region must be hidden from the engine in selection scope'
    );
    assert.equal(
      plan.unhonouredIgnore,
      undefined,
      'a honoured marker needs no notice'
    );
  });
});

/* -------------------------------------------------------------------------- */
/* FIX-A : the engine range lives in the ENGINE's coordinate space             */
/* -------------------------------------------------------------------------- */

describe('engine/maskPlan : the engine range is expressed in the ENGINE\'s coordinates', () => {
  it('engineSpanFor always covers the whole string engineTextFor hands over', () => {
    const cases: readonly string[] = [
      // Placeholder LONGER than what it replaces (positive drift).
      '<div><p>{{a}}</p><span>x</span></div>',
      // Placeholder SHORTER than what it replaces (negative drift).
      '<div>{% for item in a_very_long_collection_name %}<p>y</p>{% endfor %}</div>',
      // No island at all: no mask, so the span is the input itself.
      '<div><p>plain</p></div>'
    ];
    for (const input of cases) {
      const plan = buildMaskPlan('html', input, 'selection');
      const text = engineTextFor(input, plan.mask);
      const span = engineSpanFor(input, plan.mask);
      assert.equal(span.startOffset, 0);
      assert.equal(
        span.endOffset,
        text.length,
        `the range must cover the whole engine text for ${JSON.stringify(input)}`
      );
    }
  });

  it('drift really goes BOTH ways, so clamping the caller length is not enough', () => {
    const longer = buildMaskPlan('html', '<p>{{a}}</p>', 'selection');
    const shorter = buildMaskPlan(
      'html',
      '<p>{% for item in a_very_long_collection_name %}{% endfor %}</p>',
      'selection'
    );
    assert.ok(engineTextFor('<p>{{a}}</p>', longer.mask).length > '<p>{{a}}</p>'.length);
    const shortInput = '<p>{% for item in a_very_long_collection_name %}{% endfor %}</p>';
    assert.ok(engineTextFor(shortInput, shorter.mask).length < shortInput.length);
  });

  it('THE BUG: a caller-space range formats a PREFIX and leaves the tail alone', async () => {
    // Exactly the auditor's probe. The selection is 29 chars, the masked text is
    // 65: a range of [0, 29) over the MASKED text stops in the middle of the
    // second placeholder, so js-beautify reflows nothing and the whole selection
    // comes back untouched. A silent no-op on a format the user asked for.
    const input = '{{a}}{{b}}<div><p>x</p></div>';
    const plan = buildMaskPlan('html', input, 'selection');
    assert.ok(plan.mask, 'the islands must be masked');

    const withCallerRange = await dispatchFormat({
      languageId: 'html',
      code: engineTextFor(input, plan.mask),
      options: resolved(),
      range: { startOffset: 0, endOffset: input.length } // the defect
    });
    const buggy = plan.mask.restore(withCallerRange);
    assert.ok(buggy.ok);
    assert.equal(
      buggy.text,
      input,
      'precondition: the caller-space range really does produce a silent no-op'
    );

    // With the range expressed in the engine's own coordinates, the whole
    // selection is formatted and the islands still come back byte for byte.
    const fixed = await formatThroughPlan('html', input, 'selection');
    assert.equal(fixed.abortReason, undefined);
    assert.ok(fixed.text !== undefined);
    assert.notEqual(fixed.text, input, 'the selection must actually be formatted');
    assert.ok(fixed.text.includes('\n  <p>x</p>\n'), fixed.text);
    assert.ok(fixed.text.startsWith('{{a}}{{b}}'), 'islands stay verbatim');
    assert.equal(guard.check('html', input, fixed.text).equivalent, true);
  });

  it('a selection with SEVERAL islands is formatted to its very last byte', async () => {
    const input = '<ul><li>{{a}}</li><li>{{b}}</li><li>{{c}}</li></ul>';
    const result = await formatThroughPlan('html', input, 'selection');
    assert.ok(result.text !== undefined);
    assert.equal(result.islands, 3);
    for (const island of ['{{a}}', '{{b}}', '{{c}}']) {
      assert.ok(result.text.includes(island), `${island} must survive verbatim`);
    }
    // The tail used to be concatenated unformatted: every <li> is now indented,
    // and the closing tag sits on its own line.
    assert.equal(
      result.text.split('\n').filter((line) => line.includes('<li>')).length,
      3,
      `every list item must be reflowed, got ${JSON.stringify(result.text)}`
    );
    assert.ok(result.text.endsWith('</ul>'));
    assert.equal(guard.check('html', input, result.text).equivalent, true);
  });

  it('a selection boundary landing INSIDE an island keeps the island BYTES', async () => {
    // This test used to assert only "the guard still accepts", which is VACUOUS
    // for an island: the guard is blind inside one BY CONSTRUCTION (the whole
    // block is one HTML text node whose whitespace normalizeHtmlText collapses),
    // and that blindness is precisely why the mask exists. So it passed while
    // the engine was joining the island's interior onto one line and the edit
    // was being WRITTEN. It now asserts the bytes.
    //
    // The document holds a MULTI-LINE island; the selection cuts it in half, so
    // the fragment contains no complete pattern and could never find the island
    // on its own. It is located on the document and clipped instead.
    const island = '{{ value\n   | replace("  ","-")\n   | upper }}';
    const document = `<div>\n  <p>${island}</p>\n  <span>x</span>\n</div>\n`;
    const start = 0;
    const end = document.indexOf('| upper'); // strictly inside the island
    const input = document.slice(start, end);
    const result = await formatThroughPlan(
      'html',
      input,
      'selection',
      selectionContext('html', document, start)
    );
    assert.equal(result.abortReason, undefined);
    assert.ok(result.text !== undefined);
    // The engine must never have seen the island's interior.
    const plan = buildMaskPlan(
      'html',
      input,
      'selection',
      selectionContext('html', document, start)
    );
    assert.ok(plan.mask, 'the clipped island must be masked');
    assert.ok(
      !plan.mask.engineInput.includes('| replace("  ","-")'),
      'the part of the island inside the selection must be hidden from the engine'
    );
    const spliced = result.text + document.slice(end);
    assert.ok(
      spliced.includes('| upper }}'),
      'the tail outside the selection is intact'
    );
    assert.ok(
      spliced.includes(island),
      `the island must come back byte for byte, got ${JSON.stringify(spliced)}`
    );
    assert.equal(
      guardCheckNoFastPath('html', document, spliced).equivalent,
      true,
      'a boundary inside an island must never produce a non-equivalent document'
    );
  });

  it('islands OUTSIDE the selection are untouched while the inside is formatted', async () => {
    const before = '<header>{{ site.title }}</header>\n';
    const selected = '<div><p>{{a}}</p><span>x</span></div>';
    const after = '\n<footer>{{ year }}</footer>';
    const document = before + selected + after;
    const result = await formatThroughPlan(
      'html',
      selected,
      'selection',
      selectionContext('html', document, before.length)
    );
    assert.ok(result.text !== undefined);
    const spliced = before + result.text + after;
    assert.ok(
      spliced.startsWith(before) && spliced.endsWith(after),
      'nothing outside the selection may move'
    );
    assert.ok(result.text.includes('{{a}}'), 'the inside island stays verbatim');
    assert.ok(
      result.text.includes('\n'),
      `the selection must be reflowed, got ${JSON.stringify(result.text)}`
    );
    assert.equal(guard.check('html', document, spliced).equivalent, true);
  });
});

/* -------------------------------------------------------------------------- */
/* FIX-B : regions in a selection, and NO silent unhonoured marker             */
/* -------------------------------------------------------------------------- */

describe('engine/maskPlan : ignore regions are honoured for a SELECTION (FIX-B)', () => {
  it('a region opened ABOVE the selection still protects the part inside it', () => {
    const document =
      '/* tidy-ignore-start */\n.keep{color:red}\n.also{color:blue}\n/* tidy-ignore-end */\n.b{color:green}';
    const start = document.indexOf('.also');
    const input = document.slice(start);
    const plan = buildMaskPlan(
      'css',
      input,
      'selection',
      selectionContext('css', document, start)
    );
    assert.ok(plan.mask, 'the clipped region must still be masked');
    assert.ok(
      !plan.mask.engineInput.includes('.also{color:blue}'),
      'the protected bytes inside the selection must be hidden from the engine'
    );
    assert.ok(
      plan.mask.engineInput.includes('.b{color:green}'),
      'the unprotected tail of the selection must still reach the engine'
    );
    const roundTrip = plan.mask.restore(plan.mask.engineInput);
    assert.ok(roundTrip.ok);
    assert.equal(roundTrip.text, input, 'the clipped span restores byte for byte');
  });

  it('a selection whose FIRST line is a marker keeps its protection (document scan)', () => {
    // scanMarkers reads a head "tidy-ignore" comment as a FILE-level directive.
    // Scanning the selection alone would therefore return zero ranges and drop
    // the protection silently; scanning the DOCUMENT (what the provider passes)
    // sees the same comment as the node marker it really is.
    const document = '.a{color:red}\n/* tidy-ignore */\n.keep{color:red}\n.b{color:blue}';
    const start = document.indexOf('/* tidy-ignore */');
    const input = document.slice(start);
    const withContext = buildMaskPlan(
      'css',
      input,
      'selection',
      selectionContext('css', document, start)
    );
    assert.ok(withContext.mask, 'the node marker must be honoured');
    assert.ok(!withContext.mask.engineInput.includes('.keep{color:red}'));
    assert.equal(withContext.unhonouredIgnore, undefined);
  });

  it('a real format of a selection keeps the marked region byte for byte', async () => {
    const input =
      '/* tidy-ignore-start */\n.keep{color:red;background:blue}\n/* tidy-ignore-end */\n.b{color:green}';
    const result = await formatThroughPlan(
      'css',
      input,
      'selection',
      documentContext('css', input)
    );
    assert.equal(result.abortReason, undefined);
    assert.ok(result.text !== undefined);
    assert.ok(
      result.text.includes('.keep{color:red;background:blue}'),
      `the marked region must keep its exact bytes, got ${JSON.stringify(result.text)}`
    );
    assert.equal(guard.check('css', input, result.text).equivalent, true);
  });
});

describe('engine/maskPlan : an unhonoured tidy-ignore marker is REPORTED, never silent', () => {
  const PRETTIER_LANGS = ['typescript', 'typescriptreact', 'javascriptreact'] as const;

  for (const lang of PRETTIER_LANGS) {
    it(`${lang}: a tidy-ignore-start region is reported as not applied`, () => {
      const input = '/* tidy-ignore-start */\nconst a=1\n/* tidy-ignore-end */\n';
      const plan = buildMaskPlan(lang, input, 'document');
      assert.equal(plan.mask, undefined, 'the Prettier path is still not masked');
      assert.equal(plan.unhonouredIgnore, UNHONOURED_IGNORE_PRETTIER_PATH);
    });

    it(`${lang}: a lone // tidy-ignore node marker is reported too`, () => {
      // NOT at the head: a head marker is a FILE-level ignore, which the
      // provider honours before it ever builds a plan.
      const plan = buildMaskPlan(
        lang,
        'const z=0\n// tidy-ignore\nconst a=1\nconst b=2\n',
        'document'
      );
      assert.equal(plan.unhonouredIgnore, UNHONOURED_IGNORE_PRETTIER_PATH);
    });

    it(`${lang}: a // prettier-ignore marker is NOT reported (Prettier applies it)`, () => {
      const plan = buildMaskPlan(lang, 'const z=0\n// prettier-ignore\nconst a=1\n', 'document');
      assert.equal(
        plan.unhonouredIgnore,
        undefined,
        'prettier-ignore is honoured natively, so there is nothing to report'
      );
    });
  }

  it('a selection of a TSX file reports its markers too', () => {
    const document = 'const a=1\n// tidy-ignore\nconst b=2\nconst c=3\n';
    const start = document.indexOf('// tidy-ignore');
    const plan = buildMaskPlan(
      'typescriptreact',
      document.slice(start),
      'selection',
      selectionContext('typescriptreact', document, start)
    );
    assert.equal(plan.unhonouredIgnore, UNHONOURED_IGNORE_PRETTIER_PATH);
  });

  it('a placeholder collision on the js-beautify path is reported, not swallowed', () => {
    // applyMask refuses to mask when its token already occurs in the text; the
    // document is then formatted with NO region protection at all, which used to
    // happen in complete silence.
    const input =
      '/* tidy-ignore-start */\n.keep{color:red}\n/* tidy-ignore-end */\n.b{content:"__TIDY_IGNORE_PLACEHOLDER_0__"}';
    const plan = buildMaskPlan('css', input, 'document');
    assert.equal(plan.mask, undefined, 'no mask can be built safely here');
    assert.equal(plan.unhonouredIgnore, UNHONOURED_IGNORE_MASK_UNAVAILABLE);
  });

  it('says nothing when there is nothing to say', () => {
    assert.equal(
      buildMaskPlan('css', '.a{color:red}', 'document').unhonouredIgnore,
      undefined
    );
    assert.equal(
      buildMaskPlan('typescript', 'const a = 1;\n', 'document').unhonouredIgnore,
      undefined
    );
    assert.equal(
      buildMaskPlan('html', '<p>{{ x }}</p>', 'selection').unhonouredIgnore,
      undefined
    );
  });

  it('every notice is English, single-line, em-dash free and short enough to store', () => {
    for (const notice of [
      UNHONOURED_IGNORE_PRETTIER_PATH,
      UNHONOURED_IGNORE_MASK_UNAVAILABLE
    ]) {
      assert.ok(notice.startsWith(UNHONOURED_IGNORE_PREFIX));
      assert.ok(!notice.includes('\n'), 'a notice must survive sanitizeDetail intact');
      // Written as an escape ON PURPOSE: this asserts the absence of the real
      // character, so the file must not contain one itself.
      assert.ok(
        !notice.includes(String.fromCharCode(0x2014)),
        'no em dash in a shipped string'
      );
      assert.ok(notice.length < 200, 'must not be truncated by sanitizeDetail');
      assert.match(notice, /^[\x20-\x7e]+$/, 'plain ASCII English only');
    }
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
    const verdict = guardCheckNoFastPath('html', input, result.text);
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

  it('islands AND front matter are masked in BOTH scopes (this used to pin the gap)', () => {
    // This test used to assert that front matter was protected at document scope
    // ONLY. That asymmetry WAS the bug: Format Selection, and the very common
    // editor.formatOnSaveMode "modifications", handed the YAML straight to
    // js-beautify, which reflowed it, and the HTML guard accepted the result
    // because the whole block reads as one text node whose whitespace it
    // normalises. What is protected is now decided by the DOCUMENT, never by the
    // scope of the request.
    const input = '---\na: 1\n---\n<p>{{ x }}</p>';
    const selection = buildMaskPlan('html', input, 'selection');
    const document = buildMaskPlan('html', input, 'document');
    assert.equal(
      selection.templateIslandCount,
      2,
      'the front matter block and the {{ x }} island are both protected'
    );
    assert.equal(
      document.templateIslandCount,
      selection.templateIslandCount,
      'the count must not depend on the scope of the request'
    );
    for (const plan of [selection, document]) {
      assert.ok(plan.mask, 'both scopes must build a mask');
      assert.ok(
        !plan.mask.engineInput.includes('a: 1'),
        'the front matter must be hidden from the engine in BOTH scopes'
      );
      assert.ok(
        !plan.mask.engineInput.includes('{{ x }}'),
        'the island must be hidden from the engine in BOTH scopes'
      );
    }
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

  it('a dropped REGION placeholder fails the restore (css, no island layer)', () => {
    // Only the region layer exists here, so the failure this asserts is the
    // ignore-region one, not the island one: the two reasons must stay distinct
    // because statusFromReason routes them by prefix.
    const input = '/* tidy-ignore-start */\n.a{color:red}\n/* tidy-ignore-end */\n.b{color:blue}';
    const plan = buildMaskPlan('css', input, 'document');
    assert.ok(plan.mask, 'a css ignore region must be masked');
    // Simulate an engine that DROPPED the placeholder entirely.
    const restored = plan.mask.restore('.b {\n  color: blue\n}\n');
    assert.equal(restored.ok, false, 'a dropped region placeholder must abort');
    if (restored.ok) return;
    assert.equal(restored.reason, REGION_RESTORE_FAILED_REASON);
  });

  it('a duplicated REGION placeholder fails the restore too (css)', () => {
    const input = '/* tidy-ignore-start */\n.a{color:red}\n/* tidy-ignore-end */\n.b{color:blue}';
    const plan = buildMaskPlan('css', input, 'document');
    assert.ok(plan.mask);
    const restored = plan.mask.restore(
      `${plan.mask.engineInput}\n${plan.mask.engineInput}`
    );
    assert.equal(restored.ok, false);
    if (restored.ok) return;
    assert.equal(restored.reason, REGION_RESTORE_FAILED_REASON);
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


/* -------------------------------------------------------------------------- */
/* THE LAST FALSE ACCEPT : front matter was protected at DOCUMENT scope only    */
/* -------------------------------------------------------------------------- */

/**
 * The auditor's reproduction, byte for byte. Nested keys and a block scalar: the
 * two YAML shapes the beautifier destroys most visibly, because it strips the
 * leading indentation that carries their meaning.
 */
const NESTED_FRONT_MATTER =
  '---\n' +
  'author:\n' +
  '  name: Ada\n' +
  '  role: admin\n' +
  'body: |\n' +
  '  line one\n' +
  '    indented two\n' +
  '---';
const NESTED_FM_DOCUMENT = NESTED_FRONT_MATTER + '\n<div>\n<p>x</p>\n</div>\n';

describe('engine/maskPlan : front matter is protected in EVERY scope', () => {
  it('THE FINDING: the same bytes come back identical at document AND at selection scope', async () => {
    // Before the fix this was the only scope-dependent result in the corpus: at
    // selection scope the nested keys were PROMOTED TO TOP LEVEL and the block
    // scalar was flattened, and the guard accepted it (see the hazard test below).
    const document = await formatThroughPlan(
      'html',
      NESTED_FM_DOCUMENT,
      'document',
      documentContext('html', NESTED_FM_DOCUMENT)
    );
    const selection = await formatThroughPlan(
      'html',
      NESTED_FM_DOCUMENT,
      'selection',
      selectionContext('html', NESTED_FM_DOCUMENT, 0)
    );
    for (const [label, result] of [
      ['document', document],
      ['selection', selection]
    ] as const) {
      assert.equal(result.abortReason, undefined, label);
      assert.ok(result.text !== undefined, label);
      assert.ok(
        result.text.startsWith(NESTED_FRONT_MATTER),
        `${label} scope must keep the block byte for byte, got ${JSON.stringify(
          result.text.slice(0, 90)
        )}`
      );
      assert.ok(result.text.includes('<p>x</p>'), `${label}: body still formatted`);
    }
  });

  it('THE HAZARD at selection scope: the guard accepts the corruption, so only the mask stops it', async () => {
    // Same proof as the document-scope hazard test, run at SELECTION scope: the
    // bare engine destroys the YAML and guard.check says "equivalent", because to
    // the HTML guard the whole block is one text node whose whitespace it
    // normalises. Masking is the only thing standing between the user and this.
    const unmasked = await dispatchFormat({
      languageId: 'html',
      code: NESTED_FM_DOCUMENT,
      options: resolved(),
      range: { startOffset: 0, endOffset: NESTED_FM_DOCUMENT.length }
    });
    assert.ok(
      !unmasked.includes('  name: Ada'),
      'precondition: the bare engine really does promote the nested keys'
    );
    assert.equal(
      guard.check('html', NESTED_FM_DOCUMENT, unmasked).equivalent,
      true,
      'this is the whole point: the guard cannot see front matter corruption'
    );

    const planned = await formatThroughPlan(
      'html',
      NESTED_FM_DOCUMENT,
      'selection',
      selectionContext('html', NESTED_FM_DOCUMENT, 0)
    );
    assert.ok(planned.text !== undefined);
    assert.ok(
      planned.text.startsWith(NESTED_FRONT_MATTER),
      'the plan must keep at selection scope what the engine alone destroys'
    );
  });

  /**
   * Every way a selection can meet the block. The document is the same in all
   * four; only the span changes. The clipped overlap must always come back
   * verbatim, which is exactly the promise ignore regions already make.
   */
  const SPANS: ReadonlyArray<{
    readonly id: string;
    readonly start: (doc: string) => number;
    readonly end: (doc: string) => number;
  }> = [
    {
      id: 'spans the block entirely',
      start: () => 0,
      end: (doc) => doc.length
    },
    {
      id: 'starts INSIDE the block',
      start: (doc) => doc.indexOf('  name: Ada'),
      end: (doc) => doc.length
    },
    {
      id: 'ends INSIDE the block',
      start: () => 0,
      end: (doc) => doc.indexOf('body: |')
    },
    {
      id: 'covers exactly the block',
      start: () => 0,
      end: () => NESTED_FRONT_MATTER.length
    },
    {
      id: 'never touches the block',
      start: (doc) => doc.indexOf('<div>'),
      end: (doc) => doc.length
    }
  ];

  for (const span of SPANS) {
    it(`a selection that ${span.id} never rewrites a protected byte`, async () => {
      const start = span.start(NESTED_FM_DOCUMENT);
      const end = span.end(NESTED_FM_DOCUMENT);
      const input = NESTED_FM_DOCUMENT.slice(start, end);
      const result = await formatThroughPlan(
        'html',
        input,
        'selection',
        selectionContext('html', NESTED_FM_DOCUMENT, start)
      );
      assert.equal(result.abortReason, undefined);
      assert.ok(result.text !== undefined);
      // Splice the edit back exactly as the provider does, then read the block.
      const applied =
        NESTED_FM_DOCUMENT.slice(0, start) + result.text + NESTED_FM_DOCUMENT.slice(end);
      assert.ok(
        applied.startsWith(NESTED_FRONT_MATTER),
        `${span.id}: the block must survive, got ${JSON.stringify(
          applied.slice(0, 90)
        )}`
      );
    });
  }

  it('the block is located in the DOCUMENT, so an unrelated --- inside a selection is still formatted', async () => {
    // NFM-NOT-FIRST-LINE: a --- block below the first line is NOT front matter.
    // Reading the fragment instead of the document would freeze it and silently
    // stop formatting real markup; the document is the only honest reference.
    const document = '<h1>hi</h1>\n---\na: 1\n---\n<div>\n<p>x</p>\n</div>';
    const start = document.indexOf('---');
    const plan = buildMaskPlan(
      'html',
      document.slice(start),
      'selection',
      selectionContext('html', document, start)
    );
    assert.equal(plan.templateIslandCount, 0, 'nothing here is front matter');
    assert.equal(plan.mask, undefined, 'so nothing needs masking');
  });

  it('a --- head block is front matter in HTML only, never in css or javascript', () => {
    const source = '---\na: 1\n---\n.b{color:red}';
    for (const lang of ['css', 'scss', 'less', 'javascript'] as const) {
      const plan = buildMaskPlan(lang, source, 'selection', {
        markerScan: scanMarkers(source, lang),
        inputOffset: 0,
        documentText: source
      });
      assert.equal(plan.templateIslandCount, 0, lang);
      assert.equal(plan.mask, undefined, `${lang} must keep formatting its own source`);
    }
  });

  it('front matter alone never raises an unhonoured-marker notice', () => {
    const plan = buildMaskPlan(
      'html',
      NESTED_FM_DOCUMENT,
      'selection',
      selectionContext('html', NESTED_FM_DOCUMENT, 0)
    );
    assert.equal(
      plan.unhonouredIgnore,
      undefined,
      'the block is not a user directive, so there is nothing to report'
    );
  });

  it('front matter, an ignore region and an island compose in one selection', async () => {
    const document =
      '---\nk:   v\n---\n' +
      '<!-- tidy-ignore-start -->\n<b>{{  frozen  }}</b>\n<!-- tidy-ignore-end -->\n' +
      '<p>{{ live }}</p>\n<div>\n<p>x</p>\n</div>';
    const result = await formatThroughPlan(
      'html',
      document,
      'selection',
      selectionContext('html', document, 0)
    );
    assert.equal(result.abortReason, undefined);
    assert.ok(result.text !== undefined);
    assert.ok(result.text.startsWith('---\nk:   v\n---'), 'front matter verbatim');
    assert.ok(
      result.text.includes('<b>{{  frozen  }}</b>'),
      'the ignore region keeps its exact bytes'
    );
    assert.ok(result.text.includes('{{ live }}'), 'the island keeps its exact bytes');
    assert.ok(
      !result.text.includes('tidytplisland') &&
        !result.text.includes('__TIDY_IGNORE_PLACEHOLDER_'),
      'no placeholder of either layer may leak'
    );
  });

  it('an ignore region that OVERLAPS the front matter is absorbed into one protected span', async () => {
    // applyMask only accepts sorted, disjoint ranges, so the front matter range
    // and a marker range reaching out of it must be merged rather than handed
    // over as an overlapping pair (which would refuse the mask, and then abort).
    // Absorbing protects the union: more bytes verbatim, never fewer.
    const document =
      '---\nnote: <!-- tidy-ignore-start -->\n---\n' +
      '<div>   <p>frozen</p>   </div>\n' +
      '<!-- tidy-ignore-end -->\n' +
      '<div>\n<p>x</p>\n</div>';
    const frozen = document.slice(0, document.indexOf('<!-- tidy-ignore-end -->'));
    for (const scope of ['document', 'selection'] as const) {
      const result = await formatThroughPlan(
        'html',
        document,
        scope,
        documentContext('html', document)
      );
      assert.equal(result.abortReason, undefined, scope);
      assert.ok(result.text !== undefined, scope);
      assert.ok(
        result.text.startsWith(frozen),
        `${scope}: the merged span must come back verbatim, got ${JSON.stringify(
          result.text.slice(0, 110)
        )}`
      );
      assert.ok(result.text.includes('<p>x</p>'), `${scope}: the tail is formatted`);
    }
  });

  it('FAIL-SAFE: front matter that cannot be masked aborts with zero edits, in both scopes', () => {
    // The region placeholder already occurs in the file, so no clean restore can
    // be promised. Formatting anyway would hand the YAML to the engine, and the
    // guard cannot see it reflow: the only safe answer is no edit at all.
    const document =
      '---\na: 1\n---\n<p>__TIDY_IGNORE_PLACEHOLDER_0__</p>\n<div>\n<p>x</p>\n</div>';
    for (const scope of ['document', 'selection'] as const) {
      const plan = buildMaskPlan('html', document, scope, {
        markerScan: scanMarkers(document, 'html'),
        inputOffset: 0,
        documentText: document
      });
      assert.equal(plan.abortReason, FRONT_MATTER_MASK_FAILED_REASON, scope);
      assert.equal(plan.mask, undefined, `${scope}: no mask may reach any engine`);
      assert.equal(plan.templateIslandCount, 1, scope);
    }
  });

  it('the front matter abort reason maps to the restore-failed status and is a shippable string', () => {
    // statusFromReason routes by prefix, so this one must keep the family prefix
    // rather than fall through to 'guard-rejected', which would misname it.
    assert.ok(FRONT_MATTER_MASK_FAILED_REASON.startsWith('template-island'));
    assert.ok(!FRONT_MATTER_MASK_FAILED_REASON.includes(String.fromCharCode(10)));
    // Written as a code point ON PURPOSE: this asserts the absence of the real
    // character, so the file must not contain one itself.
    assert.ok(
      !FRONT_MATTER_MASK_FAILED_REASON.includes(String.fromCharCode(0x2014)),
      'no em dash in a shipped string'
    );
    assert.match(FRONT_MATTER_MASK_FAILED_REASON, /^[\x20-\x7e]+$/, 'plain ASCII English only');
    assert.ok(FRONT_MATTER_MASK_FAILED_REASON.length < 200);
  });
});

/* -------------------------------------------------------------------------- */
/* THE ISLAND SCOPE DEFECT : islands were located on the SELECTION, not the doc */
/* -------------------------------------------------------------------------- */

/**
 * An island is self-delimiting only while BOTH delimiters are visible. A
 * selection cutting between `<%` and `%>` hands the engine a fragment in which
 * no pattern matches, so nothing was masked and js-beautify reflowed the
 * interior: a line comment swallowed the statement under it, a string literal
 * lost a run of spaces. guard.check then returned EQUIVALENT (island text is one
 * HTML text node whose whitespace it normalises) and the edit was WRITTEN.
 *
 * The suite below runs every syntax against every way a selection can meet an
 * island, line-aligned (the shape editor.formatOnSaveMode "modifications" hands
 * the range provider) and arbitrary.
 */
const ISLAND_SYNTAXES: ReadonlyArray<{
  readonly id: string;
  readonly open: string;
  readonly close: string;
}> = [
  { id: '{{ }}', open: '{{', close: '}}' },
  { id: '{% %}', open: '{%', close: '%}' },
  { id: '<% %>', open: '<%', close: '%>' }
];

/**
 * A document with TWO multi-line islands of one syntax, each carrying a string
 * literal with a run of spaces (the engine collapses those, and the guard cannot
 * see it), plus markup no selection shape below ever protects.
 */
function islandDocument(syntax: (typeof ISLAND_SYNTAXES)[number]): {
  readonly doc: string;
  readonly islands: readonly [string, string];
} {
  const first =
    `${syntax.open} first\n` +
    '     // total is in cents\n' +
    `     | replace("  ","-") ${syntax.close}`;
  const second =
    `${syntax.open} second\n` +
    `     t("a","two  spaces")\n  ${syntax.close}`;
  const doc =
    '<div>\n' +
    `  <p>${first}</p>\n` +
    '  <span>middle</span>\n' +
    `  <b>${second}</b>\n` +
    '  <p>tail</p>\n' +
    '</div>\n';
  return { doc, islands: [first, second] };
}

/** The offset of the start of the line `offset` sits on. */
function lineStartAt(doc: string, offset: number): number {
  return doc.lastIndexOf('\n', Math.max(offset - 1, 0)) + 1;
}

/** The offset just past the end of the line `offset` sits on (or EOF). */
function lineEndAt(doc: string, offset: number): number {
  const nextBreak = doc.indexOf('\n', offset);
  return nextBreak === -1 ? doc.length : nextBreak + 1;
}

/** Every way a selection can meet the two islands, in document coordinates. */
function islandSpans(
  doc: string,
  islands: readonly [string, string]
): ReadonlyArray<{ readonly id: string; readonly start: number; readonly end: number }> {
  const firstAt = doc.indexOf(islands[0]);
  const secondAt = doc.indexOf(islands[1]);
  const insideFirst = doc.indexOf('| replace', firstAt);
  const insideSecond = doc.indexOf('two  spaces', secondAt);
  return [
    { id: 'starts INSIDE an island', start: insideFirst, end: doc.length },
    { id: 'ends INSIDE an island', start: 0, end: insideSecond },
    {
      id: 'spans one island entirely',
      start: 0,
      end: firstAt + islands[0].length + '</p>'.length
    },
    { id: 'straddles TWO islands', start: insideFirst, end: insideSecond },
    {
      id: 'never touches an island',
      start: doc.indexOf('  <p>tail</p>'),
      end: doc.length
    }
  ];
}

describe('engine/maskPlan : template islands are protected in EVERY scope', () => {
  it('THE FINDING: a line-aligned selection used to destroy the code inside an island', async () => {
    // A line-aligned selection that STARTS inside the `<% ... %>` island cuts it
    // open. Unmasked, the engine re-indents the island's own lines: the closing
    // `  %>` comes back as `    %>`, so the template's delimiter no longer lines
    // up with the code it closes. The guard says EQUIVALENT - an island is one
    // HTML text node, and it normalises that node's whitespace - so the edit is
    // applied.
    //
    // The fixture used to cut at `    out.write` and rely on the range path
    // TRIMMING the slice's trailing line break, which glued the statement onto
    // the comment line. v0.4.1 made the slice's own edge whitespace survive
    // verbatim (defects G3-4 / M3-3), so that cut is no longer corrupted at all
    // and could no longer establish the precondition. The hazard is unchanged;
    // only the cut that exposes it moved inside the slice, where the edge rule
    // has nothing to say.
    const doc =
      '<div>\n' +
      '  <%\n' +
      '    // total is in cents\n' +
      '    out.write(total);\n' +
      '  %>\n' +
      '  <p>tail</p>\n' +
      '</div>\n';
    const island = '<%\n    // total is in cents\n    out.write(total);\n  %>';
    // Line-aligned, opening boundary strictly inside the island: exactly the
    // range shape editor.formatOnSaveMode "modifications" hands the provider.
    const start = doc.indexOf('    // total is in cents');
    const end = doc.indexOf('</div>');
    const input = doc.slice(start, end);

    // 1. The hazard is real: unmasked, the engine breaks the code AND the guard
    //    accepts the break. Masking is the only thing standing in the way.
    const unmasked = await dispatchFormat({
      languageId: 'html',
      code: input,
      options: resolved(),
      range: { startOffset: 0, endOffset: input.length }
    });
    const brokenDoc = doc.slice(0, start) + unmasked + doc.slice(end);
    assert.ok(
      !brokenDoc.includes(island),
      'precondition: the bare engine really does rewrite the island interior'
    );
    assert.ok(
      brokenDoc.includes('    %>'),
      `precondition: the island's closing delimiter is re-indented, got ${JSON.stringify(brokenDoc)}`
    );
    assert.equal(
      guard.check('html', doc, brokenDoc).equivalent,
      true,
      'this is the whole point: the guard cannot see inside an island'
    );

    // 2. Through the plan, the island comes back byte for byte.
    const result = await formatThroughPlan(
      'html',
      input,
      'selection',
      selectionContext('html', doc, start)
    );
    assert.equal(result.abortReason, undefined);
    assert.ok(result.text !== undefined);
    const applied = doc.slice(0, start) + result.text + doc.slice(end);
    assert.ok(
      applied.includes(island),
      `the island must survive the selection format, got ${JSON.stringify(applied)}`
    );
  });

  it('a cut island keeps its string literals: no run of spaces is ever collapsed', async () => {
    // The second shape the auditor reported: the engine rewrites the CONTENTS of
    // a string literal inside an island, which changes what the template emits.
    const doc =
      '<div>\n' +
      '  {{ x\n     | replace("  ","-") }}\n' +
      '  <%= t("a","two  spaces")\n      %>\n' +
      '  <p>tail</p>\n' +
      '</div>\n';
    const islands = [
      '{{ x\n     | replace("  ","-") }}',
      '<%= t("a","two  spaces")\n      %>'
    ];
    const start = doc.indexOf('  {{ x');
    const end = doc.indexOf('  <p>tail');
    const result = await formatThroughPlan(
      'html',
      doc.slice(start, end),
      'selection',
      selectionContext('html', doc, start)
    );
    assert.equal(result.abortReason, undefined);
    assert.ok(result.text !== undefined);
    const applied = doc.slice(0, start) + result.text + doc.slice(end);
    for (const island of islands) {
      assert.ok(
        applied.includes(island),
        `${island} must survive verbatim, got ${JSON.stringify(applied)}`
      );
    }
  });

  for (const syntax of ISLAND_SYNTAXES) {
    const { doc, islands } = islandDocument(syntax);

    for (const span of islandSpans(doc, islands)) {
      for (const aligned of [true, false] as const) {
        const start = aligned ? lineStartAt(doc, span.start) : span.start;
        const end = aligned ? lineEndAt(doc, span.end) : span.end;
        const label = aligned ? 'line-aligned' : 'arbitrary';

        it(`${syntax.id}: a ${label} selection that ${span.id} rewrites no island byte`, async () => {
          const input = doc.slice(start, end);
          const result = await formatThroughPlan(
            'html',
            input,
            'selection',
            selectionContext('html', doc, start)
          );
          assert.equal(result.abortReason, undefined);
          assert.ok(result.text !== undefined);
          const applied = doc.slice(0, start) + result.text + doc.slice(end);
          for (const island of islands) {
            assert.ok(
              applied.includes(island),
              `${island} must survive, got ${JSON.stringify(applied)}`
            );
          }
          assert.ok(
            !applied.includes('tidytplisland') &&
              !applied.includes('__TIDY_IGNORE_PLACEHOLDER_'),
            'no placeholder of either layer may leak into the file'
          );
        });

        it(`${syntax.id}: a ${label} selection that ${span.id} protects the same bytes at both scopes`, () => {
          // The verdict must never depend on WHICH command the user ran. Same
          // input, same context, two scopes: byte-for-byte the same mask.
          const input = doc.slice(start, end);
          const context = selectionContext('html', doc, start);
          const asSelection = buildMaskPlan('html', input, 'selection', context);
          const asDocument = buildMaskPlan('html', input, 'document', context);
          assert.equal(
            asSelection.mask?.engineInput,
            asDocument.mask?.engineInput,
            'the masked bytes must not depend on the scope of the request'
          );
          assert.equal(
            asSelection.templateIslandCount,
            asDocument.templateIslandCount
          );
          assert.equal(asSelection.abortReason, asDocument.abortReason);
        });
      }
    }

    it(`${syntax.id}: a selection that never touches an island needs no island mask`, () => {
      const start = doc.indexOf('  <p>tail</p>');
      const plan = buildMaskPlan(
        'html',
        doc.slice(start),
        'selection',
        selectionContext('html', doc, start)
      );
      assert.equal(plan.templateIslandCount, 0, 'no island overlaps this span');
      assert.equal(plan.mask, undefined, 'so nothing needs masking');
    });

    it(`${syntax.id}: formatting the whole document keeps both islands verbatim`, async () => {
      const result = await formatThroughPlan(
        'html',
        doc,
        'document',
        documentContext('html', doc)
      );
      assert.equal(result.abortReason, undefined);
      assert.ok(result.text !== undefined);
      assert.equal(result.islands, 2);
      for (const island of islands) {
        assert.ok(result.text.includes(island), `${island} must survive`);
      }
    });
  }

  it('islands are located in the DOCUMENT, so a lone delimiter inside a selection is masked too', () => {
    // The fragment holds the island's TAIL and nothing else of it: read on its
    // own that is ordinary text, and that is exactly how it used to be handed to
    // the engine. Read against the document it is part of an island.
    const doc = '<div>\n  {% if a %}\n  <p>x</p>\n</div>\n';
    const start = doc.indexOf('a %}') + 'a '.length;
    const plan = buildMaskPlan(
      'html',
      doc.slice(start),
      'selection',
      selectionContext('html', doc, start)
    );
    assert.equal(plan.templateIslandCount, 1, 'the clipped island still counts');
    assert.ok(plan.mask, 'and it is still masked');
    assert.ok(
      !plan.mask.engineInput.startsWith('%}'),
      'the island tail must be hidden from the engine'
    );
    const roundTrip = plan.mask.restore(plan.mask.engineInput);
    assert.ok(roundTrip.ok);
    assert.equal(roundTrip.text, doc.slice(start), 'restoring reproduces the bytes');
  });

  it('a caller with no document context still masks the islands it can see', () => {
    // Pure callers (and many unit tests) hand no context: the input IS the
    // document, so the located-then-clipped path degenerates to scanning it.
    const plan = buildMaskPlan('html', '<p>{{ x }}</p>', 'selection');
    assert.equal(plan.templateIslandCount, 1);
    assert.ok(plan.mask);
    assert.ok(!plan.mask.engineInput.includes('{{ x }}'));
  });

  it('an island inside an ignore region is still masked exactly once, at both scopes', () => {
    // The two layers must not double-mask: the region placeholder already hides
    // the island, so only the one outside the region is an island.
    const doc =
      '<!-- tidy-ignore-start -->\n<b>{{  frozen  }}</b>\n<!-- tidy-ignore-end -->\n<p>{{ live }}</p>';
    for (const scope of ['document', 'selection'] as const) {
      const plan = buildMaskPlan('html', doc, scope, documentContext('html', doc));
      assert.ok(plan.mask, scope);
      assert.equal(plan.templateIslandCount, 1, scope);
      assert.ok(!plan.mask.engineInput.includes('{{  frozen  }}'), scope);
      assert.ok(!plan.mask.engineInput.includes('{{ live }}'), scope);
      const roundTrip = plan.mask.restore(plan.mask.engineInput);
      assert.ok(roundTrip.ok, scope);
      assert.equal(roundTrip.text, doc, `${scope}: restore reproduces the input`);
    }
  });

  it('an island BEFORE an ignore region is masked at its own offset, not the shifted one', async () => {
    // The island is located in the caller's coordinates but masked in the
    // REGION-MASKED text, whose offsets drift wherever a placeholder replaced a
    // span. Only placeholders standing ENTIRELY BEFORE an island may shift it:
    // this document puts the region AFTER, so the shift must be zero. Masking at
    // a shifted offset here would splice over ordinary markup.
    const doc =
      '<p>{{  live  }}</p>\n' +
      '<!-- tidy-ignore-start -->\n<b>keep   me</b>\n<!-- tidy-ignore-end -->\n' +
      '<div>\n<p>x</p>\n</div>';
    for (const scope of ['document', 'selection'] as const) {
      const plan = buildMaskPlan('html', doc, scope, documentContext('html', doc));
      assert.ok(plan.mask, scope);
      assert.equal(plan.templateIslandCount, 1, scope);
      assert.ok(!plan.mask.engineInput.includes('{{  live  }}'), scope);
      assert.ok(!plan.mask.engineInput.includes('<b>keep   me</b>'), scope);
      const roundTrip = plan.mask.restore(plan.mask.engineInput);
      assert.ok(roundTrip.ok, scope);
      assert.equal(roundTrip.text, doc, `${scope}: restore reproduces the input`);
    }
    const result = await formatThroughPlan(
      'html',
      doc,
      'document',
      documentContext('html', doc)
    );
    assert.ok(result.text !== undefined);
    assert.ok(result.text.includes('{{  live  }}'), 'the island keeps its bytes');
    assert.ok(result.text.includes('<b>keep   me</b>'), 'the region keeps its bytes');
  });

  it('an island inside the FRONT MATTER is not masked twice either', () => {
    // Front matter rides the region layer, so an island inside it is already
    // hidden; counting it again would double-mask the same span.
    const doc = '---\ntitle: {{ x }}\n---\n<p>{{ live }}</p>';
    const plan = buildMaskPlan('html', doc, 'selection', documentContext('html', doc));
    assert.ok(plan.mask);
    assert.equal(
      plan.templateIslandCount,
      2,
      'the front matter block plus the ONE island outside it'
    );
    assert.ok(!plan.mask.engineInput.includes('title: {{ x }}'));
    const roundTrip = plan.mask.restore(plan.mask.engineInput);
    assert.ok(roundTrip.ok);
    assert.equal(roundTrip.text, doc);
  });

  it('the unusable-spans reason is a shippable English string with the family prefix', () => {
    assert.ok(TEMPLATE_ISLAND_SPANS_UNUSABLE_REASON.startsWith('template-island'));
    assert.ok(!TEMPLATE_ISLAND_SPANS_UNUSABLE_REASON.includes(String.fromCharCode(10)));
    // Written as a code point ON PURPOSE: this asserts the absence of the real
    // character, so the file must not contain one itself.
    assert.ok(
      !TEMPLATE_ISLAND_SPANS_UNUSABLE_REASON.includes(String.fromCharCode(0x2014)),
      'no em dash in a shipped string'
    );
    assert.match(
      TEMPLATE_ISLAND_SPANS_UNUSABLE_REASON,
      /^[\x20-\x7e]+$/,
      'plain ASCII English only'
    );
    assert.ok(TEMPLATE_ISLAND_SPANS_UNUSABLE_REASON.length < 200);
  });
});

/* -------------------------------------------------------------------------- */
/* v0.4.1 M3-4 : an apostrophe must not cost the user their protection         */
/* -------------------------------------------------------------------------- */

describe('engine/maskPlan : an apostrophe in HTML text never disarms a region', () => {
  const doc = [
    '<div>',
    "  <p>don't touch the block below</p>",
    '  <!-- tidy-ignore-start -->',
    '        <pre>KEEP   ME</pre>',
    '  <!-- tidy-ignore-end -->',
    '  <p>x</p>',
    '</div>',
    ''
  ].join('\n');
  const region = doc.slice(
    doc.indexOf('  <!-- tidy-ignore-start -->'),
    doc.indexOf('-end -->') + '-end -->'.length
  );

  it('THE FINDING: v0.4.0 rewrote the protected bytes with no mask and no notice', async () => {
    // The exact v0.4.0 state: the pseudo-string opened at the apostrophe ate the
    // whole comment scan, so the provider handed the plan an EMPTY range list.
    // Reproduced by passing that empty scan, which is what the scanner returned.
    const plan = buildMaskPlan('html', doc, 'document', {
      markerScan: { ignoreFile: false, protectedRanges: [] },
      inputOffset: 0,
      documentText: doc
    });
    assert.equal(plan.mask, undefined, 'no ranges means no mask');
    assert.equal(
      plan.unhonouredIgnore,
      undefined,
      'and no notice either: the user was never told'
    );
    const raw = await dispatchFormat({
      languageId: 'html',
      code: engineTextFor(doc, plan.mask),
      options: resolved()
    });
    assert.ok(!raw.includes(region), 'the engine really does re-indent the marked lines');
    assert.equal(
      guard.check('html', doc, raw).equivalent,
      true,
      'and the guard accepts it, so the edit reaches the file'
    );
  });

  it('the scan now finds the region, so the protected bytes come back verbatim', async () => {
    const scan = scanMarkers(doc, 'html');
    assert.equal(scan.protectedRanges.length, 1, 'the apostrophe no longer hides the markers');
    const result = await formatThroughPlan('html', doc, 'document', documentContext('html', doc));
    assert.equal(result.abortReason, undefined);
    assert.ok(result.text !== undefined);
    assert.ok(
      result.text.includes(region),
      `the marked span must survive byte for byte, got ${JSON.stringify(result.text)}`
    );
    assert.equal(guardCheckNoFastPath('html', doc, result.text).equivalent, true);
  });

  it('protection does not depend on apostrophe parity, in either scope', async () => {
    for (const count of [0, 1, 2, 3]) {
      const text = doc.replace("don't", `it${"'".repeat(count)}s`);
      const marked = text.slice(
        text.indexOf('  <!-- tidy-ignore-start -->'),
        text.indexOf('-end -->') + '-end -->'.length
      );
      assert.equal(
        scanMarkers(text, 'html').protectedRanges.length,
        1,
        `count=${count}: the region must be found`
      );
      const whole = await formatThroughPlan(
        'html',
        text,
        'document',
        documentContext('html', text)
      );
      assert.ok(whole.text?.includes(marked), `count=${count}: document scope`);

      // Same bytes, selection scope: the verdict must not depend on it.
      const start = text.indexOf('  <!-- tidy-ignore-start -->');
      const fragment = text.slice(start);
      const selection = await formatThroughPlan(
        'html',
        fragment,
        'selection',
        selectionContext('html', text, start)
      );
      assert.ok(selection.text?.includes(marked), `count=${count}: selection scope`);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* v0.4.1 M3-2 : a masked region must not cost the CSS family its rescue path   */
/* -------------------------------------------------------------------------- */

describe('engine/maskPlan : the ADD-01 second chance survives a masked region', () => {
  // `.m(@c:red){color:@c}.a{.m()}` is the corpus case the js-beautify candidate
  // is REJECTED on and the postcss fallback rescues (test/fixtures/css-sass,
  // less-mixin-default.less). With a tidy-ignore region in the same file, the
  // old bare-identifier placeholder made postcss throw "Unknown word" and the
  // whole format became a silent no-op: the primary was already refused, so the
  // second chance WAS the user's last one.
  const body = '.m(@c:red){color:@c}.a{.m()}';
  const region = [
    '/* tidy-ignore-start */',
    '   .keep  {  color : red  }',
    '/* tidy-ignore-end */'
  ].join('\n');
  const marked = '   .keep  {  color : red  }';

  const positions: ReadonlyArray<readonly [string, string]> = [
    ['above the rule', `${region}\n${body}\n`],
    ['LAST in the file', `${body}\n${region}\n`],
    [
      'INSIDE a declaration block',
      `.a {\n/* tidy-ignore-start */\n   color : red ;\n/* tidy-ignore-end */\n}\n${body}\n`
    ],
    ['second region at end of file', `${region}\n${body}\n${region.replace('.keep', '.keep2')}\n`]
  ];

  /** The provider's pipeline: primary -> guard -> postcss second chance -> guard. */
  async function pipeline(doc: string) {
    const plan = buildMaskPlan('less', doc, 'document', documentContext('less', doc));
    assert.equal(plan.abortReason, undefined, 'a plain region must not abort');
    const engineInput = engineTextFor(doc, plan.mask);
    const restoreOf = (raw: string) =>
      plan.mask ? plan.mask.restore(raw) : { ok: true as const, text: raw };

    const primary = restoreOf(
      await dispatchFormat({ languageId: 'less', code: engineInput, options: resolved() })
    );
    if (primary.ok && guard.check('less', doc, primary.text).equivalent) {
      return { status: 'applied-jsbeautify' as const, text: primary.text };
    }
    const second = restoreOf(
      await dispatchCssFallback({ languageId: 'less', code: engineInput, options: resolved() })
    );
    if (!second.ok) {
      return { status: 'restore-failed' as const, text: undefined };
    }
    return guard.check('less', doc, second.text).equivalent
      ? { status: 'applied-fallback' as const, text: second.text }
      : { status: 'guard-rejected' as const, text: undefined };
  }

  for (const [name, doc] of positions) {
    it(`rescues a file whose region sits ${name}`, async () => {
      // The precondition that makes this test meaningful: the primary engine is
      // really refused here, so only the second chance can produce an edit.
      const plan = buildMaskPlan('less', doc, 'document', documentContext('less', doc));
      const primaryRaw = await dispatchFormat({
        languageId: 'less',
        code: engineTextFor(doc, plan.mask),
        options: resolved()
      });
      const primary = plan.mask ? plan.mask.restore(primaryRaw) : { ok: true, text: primaryRaw };
      assert.equal(
        primary.ok && guard.check('less', doc, primary.text).equivalent,
        false,
        'precondition: the js-beautify candidate must be rejected here'
      );

      const result = await pipeline(doc);
      assert.equal(result.status, 'applied-fallback', 'the second chance must produce an edit');
      assert.ok(
        result.text?.includes(marked) || result.text?.includes('   color : red ;'),
        `the protected bytes must come back verbatim, got ${JSON.stringify(result.text)}`
      );
    });
  }

  it('the fallback engine never throws on the masked text, in any position', async () => {
    for (const [name, doc] of positions) {
      const plan = buildMaskPlan('less', doc, 'document', documentContext('less', doc));
      await assert.doesNotReject(
        dispatchCssFallback({
          languageId: 'less',
          code: engineTextFor(doc, plan.mask),
          options: resolved()
        }),
        `postcss must parse the masked text (${name})`
      );
    }
  });

  it('a region that is the ONLY content of a css file also parses', async () => {
    const doc = `${region}\n`;
    const plan = buildMaskPlan('css', doc, 'document', documentContext('css', doc));
    await assert.doesNotReject(
      dispatchCssFallback({
        languageId: 'css',
        code: engineTextFor(doc, plan.mask),
        options: resolved()
      })
    );
  });
});

/* -------------------------------------------------------------------------- */
/* EngineMask.protectedSpans : WHICH bytes of the input come back verbatim     */
/* -------------------------------------------------------------------------- */
//
// "These bytes were restored verbatim" was a fact only this module knew, and the
// slice-edge rule downstream had to guess at it: with an explicit files.eol it
// normalised every line ending of a restored edge run, INCLUDING the ones inside
// an ignore region or a template island, which README and CHANGELOG both promise
// come back byte for byte. It changed no meaning, so the guard accepted it and
// nothing else could catch it. The plan now states the fact instead.
//
// The coordinate space is the INPUT's own, never the engine text's: the mask
// makes the engine text a different length, and the edge rule works on the
// caller's slice.

describe('engine/maskPlan : the spans the mask restores verbatim', () => {
  /** The bytes a span points at, in the input it was measured on. */
  function textOf(input: string, span: { start: number; end: number }): string {
    return input.slice(span.start, span.end);
  }

  it('a css ignore region is reported in INPUT coordinates', () => {
    const input =
      '/* tidy-ignore-start */\n.keep{color:red}\n/* tidy-ignore-end */\n.b{color:blue}';
    const plan = buildMaskPlan('css', input, 'document', documentContext('css', input));

    assert.ok(plan.mask, 'a region mask was expected');
    assert.equal(plan.mask.protectedSpans.length, 1);
    assert.equal(
      textOf(input, plan.mask.protectedSpans[0]),
      '/* tidy-ignore-start */\n.keep{color:red}\n/* tidy-ignore-end */'
    );
  });

  it('a SELECTION gets the same span, clipped and in the slice own coordinates', () => {
    // The marker opens ABOVE the selection: the region still protects the part
    // of it that reaches inside, and the span says exactly which part.
    const document =
      '/* tidy-ignore-start */\n.keep{color:red}\n/* tidy-ignore-end */\n.b{color:blue}';
    const startOffset = 24; // the first byte of ".keep{color:red}"
    const input = document.slice(startOffset);
    const plan = buildMaskPlan(
      'css',
      input,
      'selection',
      selectionContext('css', document, startOffset)
    );

    assert.ok(plan.mask, 'a selection must be protected like a document');
    assert.equal(plan.mask.protectedSpans.length, 1);
    assert.equal(plan.mask.protectedSpans[0].start, 0, 'clipped to the slice head');
    assert.equal(
      textOf(input, plan.mask.protectedSpans[0]),
      '.keep{color:red}\n/* tidy-ignore-end */'
    );
  });

  it('an html template island is reported too', () => {
    const input = '<div>\n<% if (x) {\n  go();\n} %>\n</div>';
    const plan = buildMaskPlan('html', input, 'document', documentContext('html', input));

    assert.ok(plan.mask, 'an island mask was expected');
    assert.equal(plan.mask.protectedSpans.length, 1);
    assert.equal(textOf(input, plan.mask.protectedSpans[0]), '<% if (x) {\n  go();\n} %>');
  });

  it('head front matter is reported, like the layer it rides on', () => {
    const input = '---\ntitle: x\n---\n<p>a</p>';
    const plan = buildMaskPlan('html', input, 'document', documentContext('html', input));

    assert.ok(plan.mask, 'front matter must be masked');
    assert.equal(plan.mask.protectedSpans.length, 1);
    assert.ok(
      textOf(input, plan.mask.protectedSpans[0]).includes('title: x'),
      `the front matter block must be covered, got ${JSON.stringify(
        textOf(input, plan.mask.protectedSpans[0])
      )}`
    );
  });

  it('both layers at once come back as ONE sorted, disjoint list', () => {
    const input =
      '<div>\n<!-- tidy-ignore-start -->\n  <b>  k  </b>\n<!-- tidy-ignore-end -->\n<% if (x) {\n  go();\n} %>\n</div>';
    const plan = buildMaskPlan('html', input, 'document', documentContext('html', input));

    assert.ok(plan.mask, 'both layers must build a mask');
    const spans = plan.mask.protectedSpans;
    assert.equal(spans.length, 2, `got ${JSON.stringify(spans)}`);
    assert.ok(
      textOf(input, spans[0]).startsWith('<!-- tidy-ignore-start -->'),
      'the region comes first'
    );
    assert.equal(textOf(input, spans[1]), '<% if (x) {\n  go();\n} %>');
    for (let i = 1; i < spans.length; i += 1) {
      assert.ok(
        spans[i].start >= spans[i - 1].end,
        `spans must be sorted and disjoint: ${JSON.stringify(spans)}`
      );
    }
  });

  it('an island INSIDE a region is one merged span, never two nested ones', () => {
    const input =
      '<div>\n<!-- tidy-ignore-start -->\n<% keep() %>\n<!-- tidy-ignore-end -->\n</div>';
    const plan = buildMaskPlan('html', input, 'document', documentContext('html', input));

    assert.ok(plan.mask);
    assert.equal(plan.mask.protectedSpans.length, 1, 'one span, not a nest');
    assert.ok(textOf(input, plan.mask.protectedSpans[0]).includes('<% keep() %>'));
  });

  it('every reported span survives a REAL format byte for byte', async () => {
    const input =
      '<div>\n<!-- tidy-ignore-start -->\n  <b>  k  </b>\n<!-- tidy-ignore-end -->\n<% if (x) {\n  go();\n} %>\n</div>';
    const context = documentContext('html', input);
    const plan = buildMaskPlan('html', input, 'document', context);
    assert.ok(plan.mask);

    const result = await formatThroughPlan('html', input, 'document', context);

    for (const span of plan.mask.protectedSpans) {
      assert.ok(
        result.text?.includes(textOf(input, span)),
        `a reported span was not restored verbatim: ${JSON.stringify(
          textOf(input, span)
        )}`
      );
    }
  });

  it('no mask means nothing was protected, so there is nothing to report', () => {
    const plan = buildMaskPlan('html', '<div><p>x</p></div>', 'document');
    assert.equal(plan.mask, undefined);
  });
});
