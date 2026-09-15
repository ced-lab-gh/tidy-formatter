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
  restoreTemplateIslandsChecked,
  type TemplateIsland
} from '../../../src/config/templates';
// The OTHER checked restore: the v0.4.1 shape fix is asserted against it, not
// against a hard-coded expectation, so "the two agree" is the thing under test.
import { restoreMask } from '../../../src/ignore/mask';
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

  /* ---------------------------------------------------------------- */
  /* v0.4.1: the two checked restores answer a non-string the same way */
  /* ---------------------------------------------------------------- */

  // The `typeof formatted !== 'string'` branch used to fall through to the
  // sequential reference implementation, which calls result.indexOf(...) on the
  // value and throws a TypeError. Nothing was ever unsafe (a throw is a refusal
  // too: the provider aborts with ZERO edits), and the branch is unreachable
  // from the pipeline, since Engine.format resolves to a string. But the
  // signature says `string | undefined`, and src/ignore/mask.ts:restoreMask
  // returns undefined for exactly the same situation, so one question had two
  // shapes of answer depending on which checked restore you asked.
  const NOT_STRINGS: readonly unknown[] = [
    undefined,
    null,
    42,
    true,
    { text: '<p>x</p>' },
    ['<p>x</p>'],
    Symbol('formatted')
  ];

  for (const value of NOT_STRINGS) {
    const label = typeof value === 'symbol' ? 'a symbol' : JSON.stringify(value) ?? String(value);
    it(`returns undefined (never throws) for ${label}`, () => {
      assert.equal(
        restoreTemplateIslandsChecked(value as unknown as string, islands),
        undefined
      );
    });
  }

  it('agrees with ignore/mask.ts restoreMask on every non-string', () => {
    // The property itself, asserted against the other implementation rather
    // than against a hard-coded `undefined`, so the two cannot drift apart
    // again without this failing.
    const restorations = [
      { token: 'tidytplisland0endisland', original: '{{ a }}', startedLine: false }
    ];
    for (const value of NOT_STRINGS) {
      assert.equal(
        restoreTemplateIslandsChecked(value as unknown as string, islands),
        restoreMask(value as unknown as string, restorations),
        `the two checked restores disagreed for ${String(value)}`
      );
    }
  });

  it('a non-string is refused BEFORE the island set is inspected', () => {
    // Both restore paths (linear and the sequential reference) are behind the
    // check, so an island set that forces the slow path cannot smuggle the
    // value through.
    const forcesSequential: TemplateIsland[] = [
      // A placeholder that is not the one makePlaceholder(0) mints, which is
      // what canRestoreLinearly refuses.
      { placeholder: 'tidytplisland7endisland', original: '{{ a }}' }
    ];
    assert.equal(
      restoreTemplateIslandsChecked(undefined as unknown as string, forcesSequential),
      undefined
    );
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

/* -------------------------------------------------------------------------- */
/* v0.4.1 M3-7 : the checked restore is linear, and identical byte for byte     */
/* -------------------------------------------------------------------------- */

/**
 * The v0.4.0 implementation, kept here as the ORACLE. Every assertion below
 * compares the shipped restore against it: this change is a speed change, so
 * anything it returns differently is a bug, including the undefined verdicts.
 */
function sequentialOracle(
  formatted: string,
  islands: readonly TemplateIsland[]
): string | undefined {
  let result = formatted;
  for (let i = islands.length - 1; i >= 0; i -= 1) {
    const { placeholder, original } = islands[i];
    const first = result.indexOf(placeholder);
    if (first === -1) {
      return undefined;
    }
    if (result.indexOf(placeholder, first + placeholder.length) !== -1) {
      return undefined;
    }
    result =
      result.slice(0, first) + original + result.slice(first + placeholder.length);
  }
  return result;
}

/** Every way an engine could plausibly damage a masked text. */
function damagedForms(
  masked: string,
  islands: readonly TemplateIsland[]
): ReadonlyArray<readonly [string, string]> {
  const forms: Array<readonly [string, string]> = [['pristine', masked]];
  if (islands.length === 0) {
    return forms;
  }
  const first = islands[0].placeholder;
  const last = islands[islands.length - 1].placeholder;
  forms.push(['dropped the first placeholder', masked.replace(first, '')]);
  forms.push(['dropped the last placeholder', masked.replace(last, '')]);
  forms.push(['duplicated a placeholder', `${masked}\n${first}\n`]);
  forms.push([
    'split a placeholder',
    masked.replace(first, `${first.slice(0, 6)} ${first.slice(6)}`)
  ]);
  forms.push(['case-changed a placeholder', masked.replace(first, first.toUpperCase())]);
  forms.push(['re-indented a placeholder', masked.replace(first, `    ${first}`)]);
  forms.push(['reordered the lines', masked.split('\n').reverse().join('\n')]);
  forms.push(['added a foreign index', `${masked}\ntidytplisland9999endisland\n`]);
  forms.push(['added a bare prefix', `${masked}\ntidytplisland\n`]);
  forms.push(['zero-padded an index', masked.replace(first, 'tidytplisland00endisland')]);
  return forms;
}

describe('config/templates : restoreTemplateIslandsChecked is linear (M3-7)', () => {
  it('agrees with the v0.4.0 implementation on every declared fixture, damaged or not', () => {
    const documents = [
      ...templateFixtures.map((fixture) => fixture.html),
      ...frontMatterFixtures.map((fixture) => fixture.html),
      ...nonFrontMatterFixtures.map((fixture) => fixture.html)
    ];
    let compared = 0;
    for (const html of documents) {
      for (const includeFrontMatter of [true, false]) {
        const outcome = maskHtmlTemplateIslands(html, includeFrontMatter);
        if (outcome.kind !== 'masked') {
          continue;
        }
        for (const [damage, text] of damagedForms(outcome.masked, outcome.islands)) {
          compared += 1;
          assert.equal(
            restoreTemplateIslandsChecked(text, outcome.islands),
            sequentialOracle(text, outcome.islands),
            `${damage}: the linear restore must answer exactly what the reference answers`
          );
        }
      }
    }
    assert.ok(compared > 100, `the comparison must actually run, got ${compared}`);
  });

  it('keeps every failure mode: dropped, duplicated, split, case-changed', () => {
    const html = '<div>{{ a }}<p>{% b %}</p><i><% c %></i></div>';
    const outcome = maskHtmlTemplateIslands(html, false);
    assert.equal(outcome.kind, 'masked');
    if (outcome.kind !== 'masked') return;
    const { masked, islands } = outcome;
    const token = islands[1].placeholder;

    assert.equal(restoreTemplateIslandsChecked(masked, islands), html, 'the clean case');
    assert.equal(
      restoreTemplateIslandsChecked(masked.replace(token, ''), islands),
      undefined,
      'dropped'
    );
    assert.equal(
      restoreTemplateIslandsChecked(`${masked}${token}`, islands),
      undefined,
      'duplicated'
    );
    assert.equal(
      restoreTemplateIslandsChecked(masked.replace(token, 'tidytplisland 1endisland'), islands),
      undefined,
      'split'
    );
    assert.equal(
      restoreTemplateIslandsChecked(masked.replace(token, token.toUpperCase()), islands),
      undefined,
      'case-changed'
    );
    assert.equal(
      restoreTemplateIslandsChecked(masked.replace(token, 'tidytplisland01endisland'), islands),
      undefined,
      'a zero-padded index is NOT island 1'
    );
  });

  it('a placeholder-shaped token that is not ours is left exactly where it is', () => {
    const islands = [{ placeholder: 'tidytplisland0endisland', original: '{{ a }}' }];
    assert.equal(
      restoreTemplateIslandsChecked(
        '<p>tidytplisland0endisland</p><p>tidytplisland7endisland</p>',
        islands
      ),
      '<p>{{ a }}</p><p>tidytplisland7endisland</p>'
    );
  });

  it('falls back to the reference when an island could interact with the tokens', () => {
    // Every one of these breaks a precondition of the linear pass; the answer
    // must still be the reference implementation's, byte for byte.
    const cases: ReadonlyArray<readonly [string, string, TemplateIsland[]]> = [
      [
        'an original that contains a placeholder',
        '<p>tidytplisland0endisland</p><p>tidytplisland1endisland</p>',
        [
          { placeholder: 'tidytplisland0endisland', original: 'x tidytplisland1endisland y' },
          { placeholder: 'tidytplisland1endisland', original: '{{ b }}' }
        ]
      ],
      [
        'an original that injects a lower-indexed placeholder',
        '<p>tidytplisland1endisland</p>',
        [
          { placeholder: 'tidytplisland0endisland', original: '{{ a }}' },
          { placeholder: 'tidytplisland1endisland', original: 'tidytplisland0endisland' }
        ]
      ],
      [
        'an empty original',
        '<p>tidytplisland0endisland</p>',
        [{ placeholder: 'tidytplisland0endisland', original: '' }]
      ],
      [
        'a placeholder this module would never mint',
        '<p>ZZZ</p>',
        [{ placeholder: 'ZZZ', original: '{{ a }}' }]
      ],
      [
        'an original made of placeholder characters',
        '<p>tidytplisland0endisland</p>',
        [{ placeholder: 'tidytplisland0endisland', original: 'plain' }]
      ]
    ];
    for (const [label, formatted, islands] of cases) {
      assert.equal(
        restoreTemplateIslandsChecked(formatted, islands),
        sequentialOracle(formatted, islands),
        label
      );
    }
  });

  it('restores a document with 18001 islands without the quadratic freeze', () => {
    // Not a micro-benchmark: the v0.4.0 restore took 13.2 s on this exact shape
    // (727 KB / 18001 islands) and the 5120 KB size cap never came near stopping
    // it. The bound is ~100x the measured linear cost, so only the return of the
    // O(bytes x islands) behaviour can trip it.
    const lines: string[] = ['<div>'];
    for (let i = 0; i < 18000; i += 1) {
      lines.push(`  <p>${'x'.repeat(20)}{{ v${i} }}</p>`);
    }
    lines.push('</div>', '');
    const html = lines.join('\n');
    const outcome = maskHtmlTemplateIslands(html, false);
    assert.equal(outcome.kind, 'masked');
    if (outcome.kind !== 'masked') return;
    assert.ok(outcome.islands.length >= 18000, 'the document really does carry the islands');

    const started = Date.now();
    const restored = restoreTemplateIslandsChecked(outcome.masked, outcome.islands);
    const elapsed = Date.now() - started;
    assert.equal(restored, html, 'and the bytes are the input, exactly');
    assert.ok(elapsed < 2000, `restore must stay linear, took ${elapsed} ms`);
  });
});
