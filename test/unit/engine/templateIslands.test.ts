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
  maskHtmlTemplateIslands,
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
