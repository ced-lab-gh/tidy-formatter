// The whitespace-significance MODEL, tested on its own terms.
//
// src/safety/htmlWhitespace.ts answers one question ("is a run of spaces here
// drawn or is it layout") from three sources, and the guard's HTML walk does
// nothing but ask it. Testing the model directly is what makes the guard-level
// sweep in cssWhitespaceSignificance.test.ts readable: the cases here pin the
// classification, the normalizers and the inheritance rule; the cases there pin
// the verdicts those produce on real documents.
//
// The two properties this file exists to lock:
//   P1  `pre-line` is NOT `pre`. It collapses spaces and tabs and PRESERVES
//       segment breaks, so it has its own normalizer. Lumping it in with `pre`
//       would be sound but would reject the reflow it genuinely permits.
//   P2  The `breaks` normalizer REFINES the collapsing one: any two texts it
//       maps together are also mapped together by the collapsing normalizer.
//       That is the proof that turning a subtree from `collapse` into `breaks`
//       can only reject more, never accept more, which is what makes the
//       pre-line branch safe to add to a verifier.
import assert from 'node:assert/strict';
import {
  childWhitespaceContext,
  cssTextPreservesWhitespace,
  cssWhitespaceDeclaration,
  maxSignificance,
  mayDeclareWhiteSpace,
  normalizeHtmlText,
  normalizeHtmlTextPreservingBreaks,
  normalizeTextFor,
  ROOT_WHITESPACE_CONTEXT,
  significanceOf,
  xmlSpaceDeclaration,
  type HtmlAttr,
  type WhitespaceSignificance
} from '../../../src/safety/htmlWhitespace';

/** Shorthand for the one attribute every CSS case needs. */
function style(value: string): HtmlAttr[] {
  return [{ name: 'style', value }];
}

/* -------------------------------------------------------------------------- */
/* 1. every white-space value, classified                                      */
/* -------------------------------------------------------------------------- */

describe('htmlWhitespace : every white-space value maps to the right point of the lattice', () => {
  // Left: the declaration exactly as it appears in a style attribute.
  // Right: undefined means "declares nothing, the inherited value stands".
  const VALUES: ReadonlyArray<readonly [string, WhitespaceSignificance | undefined]> = [
    // --- the shorthand, every legal keyword -------------------------------
    ['white-space:normal', 'collapse'],
    ['white-space:nowrap', 'collapse'],
    ['white-space:pre', 'verbatim'],
    ['white-space:pre-wrap', 'verbatim'],
    ['white-space:pre-line', 'breaks'],
    ['white-space:break-spaces', 'verbatim'],
    // --- the CSS Text 4 longhand ------------------------------------------
    ['white-space-collapse:collapse', 'collapse'],
    ['white-space-collapse:discard', 'collapse'],
    ['white-space-collapse:preserve', 'verbatim'],
    ['white-space-collapse:preserve-breaks', 'breaks'],
    ['white-space-collapse:preserve-spaces', 'verbatim'],
    ['white-space-collapse:break-spaces', 'verbatim'],
    // --- the multi-keyword shorthand form ---------------------------------
    ['white-space:preserve nowrap', 'verbatim'],
    ['white-space:collapse wrap', 'collapse'],
    ['white-space:preserve-breaks wrap', 'breaks'],
    // --- CSS-wide keywords -------------------------------------------------
    ['white-space:inherit', undefined],
    ['white-space:unset', undefined],
    ['white-space:revert', undefined],
    ['white-space:revert-layer', undefined],
    ['white-space:initial', 'collapse'],
    // --- spelling, casing, importance, neighbours --------------------------
    ['WHITE-SPACE:PRE', 'verbatim'],
    ['  white-space :  pre-wrap  ', 'verbatim'],
    ['white-space:pre !important', 'verbatim'],
    ['white-space:pre!IMPORTANT', 'verbatim'],
    ['color:red;white-space:pre;margin:0', 'verbatim'],
    ['background:url(a;b.png);white-space:pre', 'verbatim'],
    ['white-space:pre;/* a comment */color:red', 'verbatim'],
    ['/* white-space:pre */color:red', undefined],
    ["content:'white-space:pre';color:red", undefined],
    // CSS escapes in the PROPERTY NAME are decoded, because missing a
    // declaration is the one direction that is not safe. `\77 ` is the hex
    // escape for `w` (its trailing space is part of the escape), `\w` is the
    // identity escape, and an out-of-range code point becomes U+FFFD, which is
    // NOT this property and so leaves the inherited value standing.
    ['\\77 hite-space:pre', 'verbatim'],
    ['\\w\\h\\i\\te-space:pre', 'verbatim'],
    ['color:red;\\w\\hite-space:pre-line', 'breaks'],
    ['\\110000hite-space:pre', undefined],
    // --- last valid declaration wins, exactly as the cascade does ----------
    ['white-space:pre;white-space:normal', 'collapse'],
    ['white-space:normal;white-space:pre', 'verbatim'],
    ['white-space-collapse:preserve;white-space:normal', 'collapse'],
    ['white-space:pre;white-space-collapse:collapse', 'collapse'],
    ['white-space:pre;white-space:inherit', undefined],
    // --- FAIL CLOSED: anything unreadable is treated as preserving ---------
    ['white-space:var(--ws)', 'verbatim'],
    ['white-space:env(--ws)', 'verbatim'],
    ['white-space:-moz-pre-wrap', 'verbatim'],
    ['white-space:-o-pre-wrap', 'verbatim'],
    ['white-space:a-keyword-css-adds-in-2030', 'verbatim'],
    // --- not a white-space declaration at all ------------------------------
    // An empty value is not a declaration CSS keeps, so the parent value stands.
    ['white-space:', undefined],
    ['color:red', undefined],
    ['-webkit-white-space:pre', undefined],
    ['', undefined]
  ];

  for (const [declaration, expected] of VALUES) {
    it(`[${declaration}] -> ${expected ?? 'no declaration'}`, () => {
      assert.equal(cssWhitespaceDeclaration(style(declaration)), expected);
    });
  }

  it('no attributes and no style attribute declare nothing', () => {
    assert.equal(cssWhitespaceDeclaration(undefined), undefined);
    assert.equal(cssWhitespaceDeclaration([]), undefined);
    assert.equal(cssWhitespaceDeclaration([{ name: 'class', value: 'log' }]), undefined);
  });

  it('reads the attribute whatever case the name arrives in', () => {
    assert.equal(
      cssWhitespaceDeclaration([{ name: 'STYLE', value: 'white-space:pre' }]),
      'verbatim'
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 2. the lattice and the three sources                                        */
/* -------------------------------------------------------------------------- */

describe('htmlWhitespace : three sources, one answer', () => {
  it('the root preserves nothing', () => {
    assert.equal(significanceOf(ROOT_WHITESPACE_CONTEXT), 'collapse');
  });

  it('any source alone makes the text verbatim', () => {
    assert.equal(significanceOf({ tag: true, xmlSpace: false, css: 'collapse' }), 'verbatim');
    assert.equal(significanceOf({ tag: false, xmlSpace: true, css: 'collapse' }), 'verbatim');
    assert.equal(significanceOf({ tag: false, xmlSpace: false, css: 'verbatim' }), 'verbatim');
  });

  it('only CSS can produce the middle point', () => {
    assert.equal(significanceOf({ tag: false, xmlSpace: false, css: 'breaks' }), 'breaks');
    // A tag or an xml:space ancestor is all-or-nothing verbatim, so it wins.
    assert.equal(significanceOf({ tag: true, xmlSpace: false, css: 'breaks' }), 'verbatim');
    assert.equal(significanceOf({ tag: false, xmlSpace: true, css: 'breaks' }), 'verbatim');
  });

  it('maxSignificance orders the lattice collapse < breaks < verbatim', () => {
    assert.equal(maxSignificance('collapse', 'breaks'), 'breaks');
    assert.equal(maxSignificance('breaks', 'collapse'), 'breaks');
    assert.equal(maxSignificance('breaks', 'verbatim'), 'verbatim');
    assert.equal(maxSignificance('verbatim', 'collapse'), 'verbatim');
    assert.equal(maxSignificance('collapse', 'collapse'), 'collapse');
  });

  it('xml:space reads both spellings and only the two enumerated keywords', () => {
    assert.equal(xmlSpaceDeclaration([{ name: 'xml:space', value: 'preserve' }]), 'preserve');
    assert.equal(
      xmlSpaceDeclaration([{ prefix: 'xml', name: 'space', value: 'preserve' }]),
      'preserve'
    );
    assert.equal(xmlSpaceDeclaration([{ name: 'xml:space', value: 'default' }]), 'default');
    assert.equal(xmlSpaceDeclaration([{ name: 'xml:space', value: 'wat' }]), undefined);
    assert.equal(xmlSpaceDeclaration(undefined), undefined);
  });
});

/* -------------------------------------------------------------------------- */
/* 3. inheritance: each source switches off only its own kind                  */
/* -------------------------------------------------------------------------- */

describe('htmlWhitespace : inheritance, and what may switch what off', () => {
  it('a preformatted tag turns the tag source on for the whole subtree', () => {
    const inPre = childWhitespaceContext(ROOT_WHITESPACE_CONTEXT, 'pre', undefined);
    assert.equal(inPre.tag, true);
    const deeper = childWhitespaceContext(inPre, 'code', undefined);
    assert.equal(significanceOf(deeper), 'verbatim');
  });

  it('CSS turns CSS off, which is what the cascade does', () => {
    const preserving = childWhitespaceContext(
      ROOT_WHITESPACE_CONTEXT,
      'div',
      style('white-space:pre')
    );
    assert.equal(significanceOf(preserving), 'verbatim');
    const off = childWhitespaceContext(preserving, 'span', style('white-space:normal'));
    assert.equal(significanceOf(off), 'collapse');
    // And it can be narrowed rather than cleared.
    const narrowed = childWhitespaceContext(preserving, 'span', style('white-space:pre-line'));
    assert.equal(significanceOf(narrowed), 'breaks');
  });

  it('CSS can NOT switch off the tag source', () => {
    const inPre = childWhitespaceContext(ROOT_WHITESPACE_CONTEXT, 'pre', undefined);
    const tryOff = childWhitespaceContext(inPre, 'span', style('white-space:normal'));
    assert.equal(significanceOf(tryOff), 'verbatim');
  });

  it('CSS can NOT switch off the xml:space source', () => {
    const preserved = childWhitespaceContext(ROOT_WHITESPACE_CONTEXT, 'text', [
      { name: 'xml:space', value: 'preserve' }
    ]);
    const tryOff = childWhitespaceContext(preserved, 'tspan', style('white-space:normal'));
    assert.equal(significanceOf(tryOff), 'verbatim');
  });

  it('xml:space can NOT switch off the CSS source', () => {
    const preserving = childWhitespaceContext(
      ROOT_WHITESPACE_CONTEXT,
      'div',
      style('white-space:pre')
    );
    const tryOff = childWhitespaceContext(preserving, 'span', [
      { name: 'xml:space', value: 'default' }
    ]);
    assert.equal(significanceOf(tryOff), 'verbatim');
  });

  it('an element that declares nothing hands its own context straight through', () => {
    const context = childWhitespaceContext(
      ROOT_WHITESPACE_CONTEXT,
      'div',
      style('white-space:pre-line')
    );
    assert.equal(childWhitespaceContext(context, 'span', undefined), context);
  });
});

/* -------------------------------------------------------------------------- */
/* 4. the normalizers, and the refinement proof (P2)                           */
/* -------------------------------------------------------------------------- */

describe('htmlWhitespace : normalizers', () => {
  it('the collapsing normalizer folds every ASCII space, and only those', () => {
    assert.equal(normalizeHtmlText('  a \t\n\r\f b  '), 'a b');
    // U+00A0 and friends are RENDERED characters, never folded.
    assert.equal(normalizeHtmlText('10 km'), '10 km');
    assert.equal(normalizeHtmlText(' '), ' ');
  });

  it('the breaks normalizer keeps line structure and collapses the rest (P1)', () => {
    assert.equal(normalizeHtmlTextPreservingBreaks('a    b'), 'a b');
    assert.equal(normalizeHtmlTextPreservingBreaks('a\tb'), 'a b');
    assert.equal(normalizeHtmlTextPreservingBreaks('a\nb'), 'a\nb');
    assert.equal(normalizeHtmlTextPreservingBreaks('a\n\nb'), 'a\n\nb');
    // Spaces adjacent to a preserved break are removed, per CSS Text.
    assert.equal(normalizeHtmlTextPreservingBreaks('a   \n   b'), 'a\nb');
    // CRLF and CR are the same one break as LF.
    assert.equal(normalizeHtmlTextPreservingBreaks('a\r\nb'), 'a\nb');
    assert.equal(normalizeHtmlTextPreservingBreaks('a\rb'), 'a\nb');
    // and U+00A0 survives here too.
    assert.equal(normalizeHtmlTextPreservingBreaks('10 km'), '10 km');
  });

  it('the module-level /g regexes are stateless across calls', () => {
    // The normalizers hold their regexes as module constants, and a /g regex
    // that leaked `lastIndex` between calls would make the guard's answer depend
    // on how many nodes it had already seen. String.replace rewinds one, but the
    // invariant is worth a test rather than a memory.
    for (let i = 0; i < 5; i += 1) {
      assert.equal(normalizeHtmlText('  a   b  '), 'a b', `collapse call ${i}`);
      assert.equal(
        normalizeHtmlTextPreservingBreaks('  a \n  b  '),
        'a\nb',
        `breaks call ${i}`
      );
    }
  });

  it('normalizeTextFor picks the normalizer the significance asks for', () => {
    assert.equal(normalizeTextFor('verbatim', ' a \n b '), ' a \n b ');
    assert.equal(normalizeTextFor('breaks', ' a \n b '), 'a\nb');
    assert.equal(normalizeTextFor('collapse', ' a \n b '), 'a b');
  });

  it('P2: the breaks normalizer REFINES the collapsing one (exhaustive)', () => {
    // If two texts are indistinguishable under `breaks` they must also be
    // indistinguishable under `collapse`. That is the whole safety argument for
    // adding the middle point: `breaks` can only ever split a class that
    // `collapse` had merged, so it rejects more and never accepts more.
    //
    // Enumerated over the alphabet that actually matters (each kind of ASCII
    // space, plus two ordinary characters) up to length 3.
    const alphabet = [' ', '\t', '\n', '\r', '\f', 'a', 'b'];
    const strings: string[] = [''];
    for (let length = 1; length <= 3; length += 1) {
      for (const base of strings.filter((s) => s.length === length - 1)) {
        for (const char of alphabet) {
          strings.push(base + char);
        }
      }
    }
    const collapsesByBreaksClass = new Map<string, Set<string>>();
    for (const text of strings) {
      const key = normalizeHtmlTextPreservingBreaks(text);
      const bucket = collapsesByBreaksClass.get(key) ?? new Set<string>();
      bucket.add(normalizeHtmlText(text));
      collapsesByBreaksClass.set(key, bucket);
    }
    for (const [key, collapses] of collapsesByBreaksClass) {
      assert.equal(
        collapses.size,
        1,
        `breaks-class ${JSON.stringify(key)} spans several collapse forms: ${JSON.stringify([
          ...collapses
        ])}`
      );
    }
    // 1 + 7 + 7^2 + 7^3: the assertion above is worthless if the enumeration
    // silently shrinks to a handful of strings.
    assert.equal(strings.length, 400, 'the enumeration must actually be large');
    // And the refinement is STRICT: `breaks` really does separate texts that
    // `collapse` merges, otherwise the middle point would be pointless.
    assert.equal(normalizeHtmlText('a\nb'), normalizeHtmlText('a b'));
    assert.notEqual(
      normalizeHtmlTextPreservingBreaks('a\nb'),
      normalizeHtmlTextPreservingBreaks('a b')
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 5. the embedded <style> scan, which decides the fail-closed rule            */
/* -------------------------------------------------------------------------- */

describe('htmlWhitespace : scanning a stylesheet for a preserving white-space', () => {
  const PRESERVING: readonly string[] = [
    '.log{white-space:pre}',
    '.log{white-space:pre-wrap}',
    '.log{white-space:pre-line}',
    '.log{white-space:break-spaces}',
    '.log{white-space-collapse:preserve}',
    '.log{white-space-collapse:preserve-breaks}',
    '.log{color:red;white-space:pre}',
    '.log{ WHITE-SPACE : PRE-WRAP ; }',
    '.log{white-space:pre !important}',
    '@media print{.log{white-space:pre}}',
    'pre{white-space:pre}',
    '.log{white-space:var(--ws)}',
    // An ESCAPED property name spells the same property, so the scan decodes
    // and looks again rather than matching the literal text only.
    '.log{\\77 hite-space:pre}',
    // A stylesheet the CSS parser would reject is scanned all the same.
    '@media{.a{white-space:pre'
  ];
  for (const css of PRESERVING) {
    it(`fails closed on: ${css}`, () => {
      assert.equal(cssTextPreservesWhitespace(css), true);
    });
  }

  const HARMLESS: readonly string[] = [
    '',
    '.log{color:red}',
    '.log{white-space:normal}',
    '.log{white-space:nowrap}',
    '.log{white-space-collapse:collapse}',
    '.log{white-space:inherit}',
    '.log{white-space:initial}',
    // A vendor-prefixed PROPERTY is a different property, not this one.
    '.log{-webkit-white-space:pre}',
    // A backslash with no white-space behind it: an icon font must not cost a
    // page its formatting, which is why the decode runs instead of a refusal.
    '.icon:before{content:"\\f101"}'
  ];
  for (const css of HARMLESS) {
    it(`leaves formatting available for: ${JSON.stringify(css)}`, () => {
      assert.equal(cssTextPreservesWhitespace(css), false);
    });
  }

  it('is stateless across calls (the shared regex is rewound)', () => {
    const css = '.log{white-space:pre}';
    for (let i = 0; i < 5; i += 1) {
      assert.equal(cssTextPreservesWhitespace(css), true, `call ${i}`);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 6. the pre-filter: a proof of absence, never a guess                        */
/* -------------------------------------------------------------------------- */

describe('htmlWhitespace : the cheap pre-filter only ever skips provable absence', () => {
  // Both readers skip their full analysis when this says no. A false negative
  // here would be a silent hole, so the two spellings CSS allows are pinned.
  it('says no only when the property cannot be spelled at all', () => {
    assert.equal(mayDeclareWhiteSpace(''), false);
    assert.equal(mayDeclareWhiteSpace('color:red;margin:0'), false);
    assert.equal(mayDeclareWhiteSpace('<div class="log">a b</div>'), false);
  });

  it('says yes to the literal name in ANY case, since properties are case-insensitive', () => {
    for (const spelling of [
      'white-space',
      'WHITE-SPACE',
      'White-Space',
      'white-space-collapse',
      'x{white-space:pre}'
    ]) {
      assert.equal(mayDeclareWhiteSpace(spelling), true, spelling);
    }
  });

  it('says yes to ANY backslash, the one other way to spell an ident', () => {
    // `\77 hite-space` is `white-space`, so a text with an escape must be read
    // properly even when the literal name is nowhere in it.
    assert.equal(mayDeclareWhiteSpace('\\77 hite-space:pre'), true);
    assert.equal(mayDeclareWhiteSpace("font-family:'\\5FAE'"), true);
  });

  it('and the readers agree with it on the case that made it necessary', () => {
    // The escaped spelling survives the shortcut end to end.
    assert.equal(cssWhitespaceDeclaration(style('\\77 hite-space:pre')), 'verbatim');
    assert.equal(cssTextPreservesWhitespace('.log{\\77 hite-space:pre}'), true);
    // and a stylesheet that cannot spell it is skipped, with the same answer.
    assert.equal(cssTextPreservesWhitespace('.log{color:red}'), false);
  });
});

// Two holes an adversarial audit found in this module after it first landed.
// Both were accept-when-not-equivalent: Tidy WROTE text whose drawn result
// changed. They are pinned here because each has a permissive failure mode that
// a plausible refactor would reintroduce.
describe('htmlWhitespace : the two audit holes', () => {
  // HOLE 1. The sheet scan needs a boundary character before the property name,
  // and a comment glued to it supplies `/`, which is not one. A browser's
  // tokenizer drops the comment and applies the declaration, so the fail-closed
  // scan has to see it too.
  it('sees a declaration a comment is glued to', () => {
    assert.equal(cssTextPreservesWhitespace('.log{color:red;/*x*/white-space:pre-wrap}'), true);
    assert.equal(cssTextPreservesWhitespace('.log{color:red;/*x*/white-space-collapse:preserve}'), true);
    assert.equal(cssTextPreservesWhitespace('@media print{.log{/*x*/white-space:pre}}'), true);
    assert.equal(cssTextPreservesWhitespace('.log{/*a*/color:red;/*b*/white-space:pre}'), true);
    // A comment between the name and the colon is legal CSS and still matches.
    assert.equal(cssTextPreservesWhitespace('.log{white-space/*x*/:pre}'), true);
    // The two evasions compose: escaped spelling behind a comment.
    assert.equal(cssTextPreservesWhitespace('.log{color:red;/*x*/\\77 hite-space:pre}'), true);
  });

  it('keeps the RAW pass, so stripping comments cannot hide a match', () => {
    // Here `/* white-space:pre */` is INSIDE a string, so it is not a comment at
    // all. Scanning only the stripped copy would remove it and answer false;
    // scanning both keeps the conservative answer.
    assert.equal(cssTextPreservesWhitespace('.a::after{content:"/* white-space:pre */"}'), true);
  });

  it('still says no to a sheet that declares nothing', () => {
    assert.equal(cssTextPreservesWhitespace('.log{/*x*/color:red}'), false);
    assert.equal(cssTextPreservesWhitespace('.log{color:red}/* nothing here */'), false);
    // An unterminated comment is left alone on purpose: a browser swallows the
    // rest of the sheet, but reading it as live text can only over-reject.
    assert.equal(cssTextPreservesWhitespace('.log{color:red;/*x white-space:pre}'), true);
  });

  // HOLE 2. `white-space-trim` keywords are not values any shipping renderer
  // accepts for `white-space`, so the declaration is DROPPED and the inherited
  // value stands. Reading them as `collapse` cancelled a `<pre>` or a preserving
  // inline style on an ancestor, and a run of drawn spaces was rewritten.
  it('answers inherit for a trim keyword, so an ancestor keeps preserving', () => {
    // `cssWhitespaceDeclaration` reports "nothing declared" as undefined, which
    // is what `inherit` resolves to at this seam.
    for (const value of ['none', 'discard-before', 'discard-after', 'discard-inner', 'nowrap none']) {
      assert.equal(cssWhitespaceDeclaration(style(`white-space:${value}`)), undefined, value);
    }
    // `discard` is NOT one of them: it is a valid collapse-component keyword, so
    // it really does collapse and must keep saying so.
    assert.equal(cssWhitespaceDeclaration(style('white-space:discard')), 'collapse');
    assert.equal(cssWhitespaceDeclaration(style('white-space-collapse:discard')), 'collapse');
    // An ill-formed combination of otherwise valid keywords is not a value
    // either, so nothing is declared.
    assert.equal(cssWhitespaceDeclaration(style('white-space:nowrap wrap')), undefined);
    assert.equal(cssWhitespaceDeclaration(style('white-space:pre nowrap')), undefined);
    // `collapse preserve` is ill-formed the same way, but a preserving keyword
    // short-circuits to `verbatim` before the arity is counted. That is the
    // stricter answer, so it stays: it can only cost a correct rejection.
    assert.equal(cssWhitespaceDeclaration(style('white-space:collapse preserve')), 'verbatim');
    // The property that DOES take the trim keywords is not one this module reads.
    assert.equal(cssWhitespaceDeclaration(style('white-space-trim:discard-inner')), undefined);
  });

  it('does not let a trim keyword cancel a preserving ancestor', () => {
    const pre = childWhitespaceContext(ROOT_WHITESPACE_CONTEXT, 'div', style('white-space:pre'));
    assert.equal(significanceOf(pre), 'verbatim');
    for (const value of ['none', 'discard-inner', 'nowrap wrap']) {
      const child = childWhitespaceContext(pre, 'span', style(`white-space:${value}`));
      assert.equal(significanceOf(child), 'verbatim', value);
    }
    // The contrast that makes the fix load-bearing: a VALID collapsing value on
    // the same descendant DOES take effect, because a renderer applies it. So
    // `inherit` and `collapse` are genuinely different answers here, and reading
    // an invalid value as `collapse` was rewriting drawn spaces.
    const normal = childWhitespaceContext(pre, 'span', style('white-space:normal'));
    assert.equal(significanceOf(normal), 'collapse');
  });

  it('leaves the valid collapsing keywords collapsing', () => {
    for (const value of [
      'normal',
      'nowrap',
      'wrap',
      'collapse',
      'collapse wrap',
      'discard nowrap',
      'initial'
    ]) {
      assert.equal(cssWhitespaceDeclaration(style(`white-space:${value}`)), 'collapse', value);
    }
    // and the preserving ones keep preserving, alone or with a wrap keyword.
    assert.equal(cssWhitespaceDeclaration(style('white-space:pre')), 'verbatim');
    assert.equal(cssWhitespaceDeclaration(style('white-space:pre-line')), 'breaks');
    assert.equal(cssWhitespaceDeclaration(style('white-space:preserve nowrap')), 'verbatim');
    assert.equal(cssWhitespaceDeclaration(style('white-space:preserve-breaks wrap')), 'breaks');
  });
});
