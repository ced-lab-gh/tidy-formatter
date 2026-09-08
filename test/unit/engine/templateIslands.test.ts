// Unit tests for the PIPELINE-facing template-island API added by ADD-02
// (src/config/templates.ts): front matter detection, the explicit collision
// outcome, and the CHECKED restore that supersedes the legacy throwing one.
//
// Lives under test/unit/engine/ with the maskPlan suite because these functions
// exist solely to serve engine/maskPlan.ts; the legacy config-level API keeps
// its own suite in test/unit/config/templates.test.ts.
import assert from 'node:assert/strict';
import {
  findFrontMatter,
  findHtmlTemplateIslandSpans,
  maskHtmlTemplateIslands,
  maskTemplateIslandSpans,
  restoreTemplateIslandsChecked
} from '../../../src/config/templates';
import {
  frontMatterFixtures,
  nonFrontMatterFixtures,
  templateFixtures
} from '../../fixtures/templateFixtures';

describe('config/templates : findFrontMatter (ADD-02, incumbent issue 75)', () => {
  for (const fixture of frontMatterFixtures) {
    it(`${fixture.id}: ${fixture.desc}`, () => {
      const span = findFrontMatter(fixture.html);
      assert.ok(span !== undefined, 'a front matter span was expected');
      assert.equal(
        fixture.html.slice(span.start, span.end),
        fixture.frontMatter,
        'the span must cover the delimiters and nothing past the closing one'
      );
    });
  }

  for (const fixture of nonFrontMatterFixtures) {
    it(`${fixture.id}: ${fixture.desc}`, () => {
      assert.equal(
        findFrontMatter(fixture.html),
        undefined,
        'this input must NOT be treated as front matter'
      );
    });
  }

  it('the closing delimiter terminator stays OUTSIDE the span', () => {
    const html = '---\na: 1\n---\n<p>x</p>';
    const span = findFrontMatter(html);
    assert.ok(span);
    assert.equal(html[span.end], '\n', 'the newline after --- must not be masked');
  });

  it('is linear on a long unterminated block (no catastrophic backtracking)', () => {
    const html = `---\n${'key: value\n'.repeat(20000)}<p>x</p>`;
    const started = Date.now();
    assert.equal(findFrontMatter(html), undefined);
    assert.ok(
      Date.now() - started < 1000,
      'front matter detection must stay linear'
    );
  });
});

describe('config/templates : maskHtmlTemplateIslands (ADD-02)', () => {
  it('reports kind "none" when there is nothing to protect', () => {
    assert.deepEqual(maskHtmlTemplateIslands('<p>plain</p>', true), {
      kind: 'none'
    });
  });

  it('masks every delimiter island and restores it byte for byte', () => {
    for (const fixture of templateFixtures) {
      const outcome = maskHtmlTemplateIslands(fixture.html, false);
      assert.equal(outcome.kind, 'masked', `${fixture.id}: expected a mask`);
      if (outcome.kind !== 'masked') continue;
      assert.deepEqual(
        outcome.islands.map((i) => i.original),
        fixture.islands,
        `${fixture.id}: islands captured in document order`
      );
      for (const island of outcome.islands) {
        assert.ok(
          !outcome.masked.includes(island.original),
          `${fixture.id}: no island text may survive in the engine input`
        );
      }
      assert.equal(
        restoreTemplateIslandsChecked(outcome.masked, outcome.islands),
        fixture.html,
        `${fixture.id}: mask -> restore must be an exact round trip`
      );
    }
  });

  it('counts the front matter as ONE island and never double-masks braces inside it', () => {
    for (const fixture of frontMatterFixtures) {
      const outcome = maskHtmlTemplateIslands(fixture.html, true);
      assert.equal(outcome.kind, 'masked', `${fixture.id}: expected a mask`);
      if (outcome.kind !== 'masked') continue;
      assert.equal(
        outcome.islands[0].original,
        fixture.frontMatter,
        `${fixture.id}: island 0 is the whole front matter block`
      );
      assert.deepEqual(
        outcome.islands.slice(1).map((i) => i.original),
        fixture.islands,
        `${fixture.id}: only body islands follow`
      );
      assert.equal(
        restoreTemplateIslandsChecked(outcome.masked, outcome.islands),
        fixture.html,
        `${fixture.id}: byte-for-byte round trip`
      );
    }
  });

  it('ignores front matter when includeFrontMatter is false (selection scope)', () => {
    const html = '---\ntitle: {{ t }}\n---\n<p>{{ body }}</p>';
    const outcome = maskHtmlTemplateIslands(html, false);
    assert.equal(outcome.kind, 'masked');
    if (outcome.kind !== 'masked') return;
    // Without the front matter layer, the {{ t }} inside it is just an island.
    assert.deepEqual(
      outcome.islands.map((i) => i.original),
      ['{{ t }}', '{{ body }}']
    );
    assert.equal(restoreTemplateIslandsChecked(outcome.masked, outcome.islands), html);
  });

  it('reports a collision (with the island count) instead of silently not masking', () => {
    const outcome = maskHtmlTemplateIslands(
      '<p>tidytplisland is a real word here</p><i>{{ x }}</i>',
      true
    );
    assert.equal(outcome.kind, 'collision');
    if (outcome.kind !== 'collision') return;
    assert.equal(outcome.islandCount, 1);
  });

  it('a document carrying the placeholder text but NO island is simply "none"', () => {
    assert.deepEqual(
      maskHtmlTemplateIslands('<p>tidytplisland</p>', true),
      { kind: 'none' },
      'nothing to protect means nothing to decline'
    );
  });

  it('handles 12+ islands (two-digit indices) without token prefix ambiguity', () => {
    const html = `<div>${'{{ a }}'.repeat(15)}</div>`;
    const outcome = maskHtmlTemplateIslands(html, false);
    assert.equal(outcome.kind, 'masked');
    if (outcome.kind !== 'masked') return;
    assert.equal(outcome.islands.length, 15);
    assert.equal(restoreTemplateIslandsChecked(outcome.masked, outcome.islands), html);
  });

  it('does not match an unterminated island', () => {
    assert.deepEqual(maskHtmlTemplateIslands('<p>{{ oops</p>', false), {
      kind: 'none'
    });
  });
});

describe('config/templates : restoreTemplateIslandsChecked (ADD-02)', () => {
  const islands = [
    { placeholder: 'tidytplisland0endisland', original: '{{ a }}' },
    { placeholder: 'tidytplisland1endisland', original: '{{ b }}' }
  ];

  it('returns undefined when the engine DROPPED a placeholder', () => {
    assert.equal(
      restoreTemplateIslandsChecked('<p>tidytplisland0endisland</p>', islands),
      undefined
    );
  });

  it('returns undefined when the engine DUPLICATED a placeholder', () => {
    // The legacy split/join restore would happily rewrite BOTH occurrences and
    // silently invent content; the checked restore refuses.
    const formatted =
      '<p>tidytplisland0endisland tidytplisland0endisland tidytplisland1endisland</p>';
    assert.equal(restoreTemplateIslandsChecked(formatted, islands), undefined);
  });

  it('restores verbatim when every placeholder appears exactly once', () => {
    assert.equal(
      restoreTemplateIslandsChecked(
        '<p>tidytplisland0endisland</p><p>tidytplisland1endisland</p>',
        islands
      ),
      '<p>{{ a }}</p><p>{{ b }}</p>'
    );
  });

  it('an empty island list is an identity transform', () => {
    assert.equal(restoreTemplateIslandsChecked('<p>x</p>', []), '<p>x</p>');
  });
});

describe('config/templates : findHtmlTemplateIslandSpans (island scope fix)', () => {
  it('reports every island as a byte span, in document order', () => {
    const html = '<p>{{ a }}</p><b>{% b %}</b><i><% c %></i>';
    const spans = findHtmlTemplateIslandSpans(html);
    assert.equal(spans.length, 3);
    assert.deepEqual(
      spans.map((span) => html.slice(span.start, span.end)),
      ['{{ a }}', '{% b %}', '<% c %>']
    );
    for (let i = 1; i < spans.length; i += 1) {
      assert.ok(spans[i].start >= spans[i - 1].end, 'spans must be sorted and disjoint');
    }
  });

  it('captures a MULTI-LINE island whole, which is the case a fragment cannot see', () => {
    const html = '<div>\n  <%\n    out.write(1);\n  %>\n</div>';
    const spans = findHtmlTemplateIslandSpans(html);
    assert.equal(spans.length, 1);
    assert.equal(
      html.slice(spans[0].start, spans[0].end),
      '<%\n    out.write(1);\n  %>'
    );
  });

  it('reports nothing for an unterminated island or for plain markup', () => {
    assert.deepEqual(findHtmlTemplateIslandSpans('<p>{{ oops</p>'), []);
    assert.deepEqual(findHtmlTemplateIslandSpans('<p>plain</p>'), []);
  });

  it('is reentrant: a second call on a different text starts from the beginning', () => {
    // A shared /g regex would carry lastIndex across calls and skip matches.
    const first = findHtmlTemplateIslandSpans('<p>{{ a }}</p>');
    const second = findHtmlTemplateIslandSpans('{{ b }}');
    assert.equal(first.length, 1);
    assert.equal(second.length, 1, 'the second scan must not inherit a lastIndex');
    assert.equal(second[0].start, 0);
  });
});

describe('config/templates : maskTemplateIslandSpans (island scope fix)', () => {
  it('masks the GIVEN spans and restores them verbatim', () => {
    const html = '<p>{{ a }}</p><b>{{ b }}</b>';
    const spans = findHtmlTemplateIslandSpans(html);
    const outcome = maskTemplateIslandSpans(html, spans);
    assert.equal(outcome.kind, 'masked');
    if (outcome.kind !== 'masked') return;
    assert.ok(!outcome.masked.includes('{{ a }}'));
    assert.ok(!outcome.masked.includes('{{ b }}'));
    assert.equal(restoreTemplateIslandsChecked(outcome.masked, outcome.islands), html);
  });

  it('masks an ARBITRARY span, which is what a clipped island is', () => {
    // The clipped half of an island straddling a selection boundary is not a
    // complete pattern; the masker takes it anyway, because the caller located
    // it on the document.
    const fragment = '  <%\n    out.write(1);\n';
    const outcome = maskTemplateIslandSpans(fragment, [{ start: 2, end: fragment.length }]);
    assert.equal(outcome.kind, 'masked');
    if (outcome.kind !== 'masked') return;
    assert.equal(outcome.masked, '  tidytplisland0endisland');
    assert.equal(
      restoreTemplateIslandsChecked(outcome.masked, outcome.islands),
      fragment
    );
  });

  it('reports none for an empty span list', () => {
    assert.deepEqual(maskTemplateIslandSpans('<p>x</p>', []), { kind: 'none' });
  });

  it('reports a collision instead of masking over existing placeholder text', () => {
    assert.deepEqual(
      maskTemplateIslandSpans('<p>tidytplisland</p>', [{ start: 0, end: 3 }]),
      { kind: 'collision', islandCount: 1 }
    );
  });

  for (const bad of [
    { id: 'overlapping', spans: [{ start: 0, end: 5 }, { start: 3, end: 8 }] },
    { id: 'unsorted', spans: [{ start: 5, end: 8 }, { start: 0, end: 3 }] },
    { id: 'empty span', spans: [{ start: 2, end: 2 }] },
    { id: 'out of bounds', spans: [{ start: 0, end: 999 }] },
    { id: 'negative start', spans: [{ start: -1, end: 3 }] },
    { id: 'non-integer', spans: [{ start: 0.5, end: 3 }] }
  ]) {
    it(`refuses a ${bad.id} span set rather than splicing it (fail-safe)`, () => {
      // The caller turns 'unusable' into ZERO EDITS. Unreachable from the spans
      // this module produces; asserted so it can never become a corrupt mask.
      assert.deepEqual(maskTemplateIslandSpans('<p>{{ a }}</p>', bad.spans), {
        kind: 'unusable',
        islandCount: bad.spans.length
      });
    });
  }

  it('maskHtmlTemplateIslands is the whole-text case of the same primitive', () => {
    // The legacy entry point must keep producing exactly what the span-based one
    // does for the spans it locates, front matter first.
    const html = '---\na: 1\n---\n<p>{{ x }}</p>';
    const viaEntryPoint = maskHtmlTemplateIslands(html, true);
    const front = findFrontMatter(html);
    assert.ok(front);
    const viaSpans = maskTemplateIslandSpans(html, [
      { start: front.start, end: front.end },
      ...findHtmlTemplateIslandSpans(html.slice(front.end)).map((span) => ({
        start: span.start + front.end,
        end: span.end + front.end
      }))
    ]);
    assert.deepEqual(viaEntryPoint, viaSpans);
  });
});
