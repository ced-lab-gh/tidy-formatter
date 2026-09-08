// HTML guard soundness: the three ways the parse5 tree comparison could answer
// the wrong thing about a real document. Each suite here is a REPRODUCED defect,
// not a hypothetical.
//
//   F1  VERBATIM DRIFT. The guard knew only <pre> and <textarea>, while the HTML
//       Rendering spec renders <xmp>, <listing> and <plaintext> with the same
//       `white-space: pre`. js-beautify was never told otherwise either, so it
//       reflowed those three: a TAB inside <xmp> came back as four spaces, the
//       RENDERED TEXT changed, and the guard said "equivalent". "Our engine
//       would never produce that" is not a defence for a verifier, so both the
//       verdict and the printer now read ONE list.
//   F2  SCOPE-DEPENDENT VERDICT. htmlShape starts its walk with "not inside a
//       verbatim element", which is true of a document root and false of a
//       selection sitting inside <pre>. The provider now splices a selection
//       back into its document before asking, so the two scopes ask the same
//       question (the provider seam is locked in
//       test/unit/providers/formattingProvider.test.ts; here we lock the guard
//       fact that makes it work).
//   F3  TEMPLATE FALSE REJECT. The <template>.content walk lacked the
//       whitespace-only #text filter the sibling walk has, so any formatter that
//       indents a template's children changed the child count and EVERY document
//       containing a <template> was rejected for good.
//   F4  XML:SPACE BLINDNESS. "Whitespace is drawn here" was decided from the TAG
//       alone, and SVG 1.1 §5.9 decides it from an ATTRIBUTE: every space under
//       xml:space="preserve" is drawn. The tag is an ordinary <text>, so
//       normalizeHtmlText collapsed the run and
//       <text xml:space="preserve">A  B</text> was WRITTEN as A B, applied=true,
//       two drawn spaces reduced to one. The declaration is inherited by the
//       whole subtree, and xml:space="default" turns it back off.
//   F5  CSS WHITE-SPACE BLINDNESS, the sibling of F1 and F4 and the reason all
//       three now live in ONE model (src/safety/htmlWhitespace.ts): the tag list
//       and xml:space could not see the property they are both DEFINED in terms
//       of, so style="white-space:pre" on an ordinary <div> was reflowed and
//       written. Its own suite is cssWhitespaceSignificance.test.ts, which
//       sweeps every value, every source and both scopes; what stays HERE is F1
//       and F4, which that fix must not disturb.
import assert from 'node:assert/strict';
import { dispatchFormat } from '../../../src/engine/dispatcher';
import { guard, htmlTreeEqual } from '../../../src/safety/guard';
import {
  HTML_PREFORMATTED_TAGS,
  HTML_PREFORMATTED_TAG_SET,
  htmlPreformattedTags
} from '../../../src/safety/htmlPreformatted';
import type { ResolvedOptions } from '../../../src/types';

const OPTS: ResolvedOptions = {
  tabSize: 2,
  insertSpaces: true,
  engineOptions: {},
  sources: {}
};

async function formatHtml(code: string): Promise<string> {
  return dispatchFormat({ languageId: 'html', code, options: OPTS });
}

/**
 * A snippet whose whitespace is RENDERED inside `tag`: one tab-indented line and
 * one space-indented line. Turning the tab into spaces (what js-beautify did)
 * changes what a reader sees, which is exactly what the guard must catch.
 *
 * <plaintext> is special-cased: the HTML parser treats everything after it as
 * raw text to end of file, so it takes no closing tag and no trailing markup.
 */
function verbatimSnippet(tag: string, indent: string): string {
  const body = `alpha\n${indent}TABBED\n    spaced`;
  return tag === 'plaintext'
    ? `<div>\n<plaintext>${body}`
    : `<div>\n<${tag}>${body}</${tag}>\n</div>`;
}

/* -------------------------------------------------------------------------- */
/* F1 : ONE list, and it is the spec's list                                    */
/* -------------------------------------------------------------------------- */

describe('safety/htmlPreformatted : the spec list, held once', () => {
  it('is exactly the tags the HTML Rendering spec renders preformatted', () => {
    // pre / xmp / plaintext / listing  -> white-space: pre      (flow content)
    // textarea                         -> white-space: pre-wrap (form controls)
    assert.deepEqual(
      [...HTML_PREFORMATTED_TAGS],
      ['listing', 'plaintext', 'pre', 'textarea', 'xmp'],
      'the membership rule is the spec, not the set of tags our printer avoids'
    );
  });

  it('names the three tags whose omission was a proven false accept', () => {
    for (const tag of ['xmp', 'listing', 'plaintext']) {
      assert.ok(
        HTML_PREFORMATTED_TAG_SET.has(tag),
        `${tag} renders as white-space: pre and was silently reflowed`
      );
    }
  });

  it('excludes nowrap-only elements, which really are reflowable', () => {
    // `white-space: nowrap` collapses whitespace exactly like normal text, so a
    // reflow there is invisible to a reader. Rejecting it would be a false
    // reject, and this test is what stops the list growing by superstition.
    assert.ok(!HTML_PREFORMATTED_TAG_SET.has('nobr'));
    assert.equal(
      htmlTreeEqual('<nobr>a\n\tb</nobr>', '<nobr>a b</nobr>').equivalent,
      true
    );
  });

  it('hands out a COPY, so a library cannot mutate the source of truth', () => {
    const handed = htmlPreformattedTags();
    handed.push('div');
    handed.sort();
    assert.deepEqual(
      [...HTML_PREFORMATTED_TAGS],
      ['listing', 'plaintext', 'pre', 'textarea', 'xmp'],
      'js-beautify receives its own array; ours is untouched'
    );
    assert.notEqual(htmlPreformattedTags(), htmlPreformattedTags());
  });
});

describe('safety/guard : verbatim tags, verdict and printer cannot drift', () => {
  // This loop is the anti-drift lock: for EVERY tag in the single list, both
  // sides must hold. Adding a tag to the list without teaching one of the two
  // sides about it fails here.
  for (const tag of HTML_PREFORMATTED_TAGS) {
    it(`<${tag}> : the guard REJECTS a tab rewritten as spaces`, () => {
      const before = verbatimSnippet(tag, '\t');
      const after = verbatimSnippet(tag, '    ');
      const verdict = htmlTreeEqual(before, after);
      assert.equal(
        verdict.equivalent,
        false,
        `a tab turned into spaces inside <${tag}> changes the rendered text`
      );
    });

    it(`<${tag}> : the engine does not reflow it in the first place`, async () => {
      const input = verbatimSnippet(tag, '\t');
      const out = await formatHtml(input);
      assert.ok(
        out.includes('alpha\n\tTABBED\n    spaced'),
        `js-beautify reflowed inside <${tag}>: ${JSON.stringify(out)}`
      );
      assert.equal(
        guard.check('html', input, out).equivalent,
        true,
        'and the untouched body must still pass the guard'
      );
    });
  }

  it('the auditor reproduction: <xmp> loses a TAB and is caught / prevented', async () => {
    // Verbatim from the audit: default settings, document scope.
    const input = '<div>\n<xmp>alpha\n\tTABBED\n    spaced</xmp>\n</div>';
    const corrupted = '<div>\n  <xmp>alpha\n    TABBED\n    spaced</xmp>\n</div>';

    // 1. the guard alone now rejects that exact output, whatever produced it;
    assert.equal(guard.check('html', input, corrupted).equivalent, false);
    // 2. and the engine no longer produces it.
    const out = await formatHtml(input);
    assert.notEqual(out, corrupted);
    assert.ok(out.includes('\tTABBED'), 'the tab survives the format');
  });
});

/* -------------------------------------------------------------------------- */
/* F2 : the same textual change gets the same verdict at any scope             */
/* -------------------------------------------------------------------------- */

describe('safety/guard : a verbatim context is inherited, at any depth', () => {
  // The provider hands the guard the whole document for a selection too, so
  // these are the verdicts a selection inherits. A fragment judged WITHOUT its
  // ancestors is the bug; these cases prove the ancestors decide.
  const collapsed: Array<[string, string, string]> = [
    ['pre', '<pre>alpha\n\tTABBED</pre>', '<pre>alpha\n    TABBED</pre>'],
    [
      'textarea',
      '<textarea>alpha\n\tTABBED</textarea>',
      '<textarea>alpha\n    TABBED</textarea>'
    ],
    [
      'pre > code',
      '<pre><code>alpha\n\tTABBED</code></pre>',
      '<pre><code>alpha\n    TABBED</code></pre>'
    ],
    [
      'pre > code > span (deep)',
      '<pre><code><span>alpha\n\tTABBED</span></code></pre>',
      '<pre><code><span>alpha\n    TABBED</span></code></pre>'
    ],
    ['xmp', '<xmp>alpha\n\tTABBED</xmp>', '<xmp>alpha\n    TABBED</xmp>'],
    [
      'listing',
      '<listing>alpha\n\tTABBED</listing>',
      '<listing>alpha\n    TABBED</listing>'
    ],
    ['plaintext', '<plaintext>alpha\n\tTABBED', '<plaintext>alpha\n    TABBED']
  ];

  for (const [name, before, after] of collapsed) {
    it(`${name} : rejected wherever the text sits`, () => {
      assert.equal(htmlTreeEqual(before, after).equivalent, false);
      // Wrapped one level deeper, the answer must not change: verbatim-ness is
      // inherited by the whole subtree, not read off the immediate parent.
      assert.equal(
        htmlTreeEqual(`<div>${before}</div>`, `<div>${after}</div>`).equivalent,
        false
      );
    });
  }

  it('the SAME text is freely reflowable when no ancestor is preformatted', () => {
    // The mirror image: without a verbatim ancestor this is ordinary
    // insignificant whitespace and rejecting it would be a false reject.
    assert.equal(
      htmlTreeEqual('<div>alpha\n\tTABBED</div>', '<div>alpha\n    TABBED</div>')
        .equivalent,
      true
    );
    assert.equal(
      htmlTreeEqual('<code>alpha\n\tTABBED</code>', '<code>alpha\n    TABBED</code>')
        .equivalent,
      true
    );
  });
});

/* -------------------------------------------------------------------------- */
/* F3 : <template> is an element like any other                                */
/* -------------------------------------------------------------------------- */

describe('safety/guard : <template> is handled like any other element', () => {
  it('accepts the reindent every formatter performs on a template', async () => {
    // The reproduction: content children counted 1 vs 3, so this rejected and
    // warned. Web components, Vue, Alpine and htmx all ship this shape.
    const input = '<div><template><p>a</p><p>b</p></template></div>';
    const out = await formatHtml(input);
    assert.notEqual(out, input, 'the formatter really does reindent it');
    assert.equal(
      guard.check('html', input, out).equivalent,
      true,
      'a document containing a <template> must be formattable'
    );
  });

  it('accepts a whole page whose <template> gains insignificant whitespace', async () => {
    const input =
      '<!DOCTYPE html>\n<html lang="en">\n<head><title>T</title></head>\n' +
      '<body><my-list><template id="row"><li class="r"><slot></slot></li></template>' +
      '</my-list></body>\n</html>';
    const out = await formatHtml(input);
    assert.equal(guard.check('html', input, out).equivalent, true);
  });

  it('accepts nested templates being reindented', () => {
    assert.equal(
      htmlTreeEqual(
        '<template><template><p>x</p></template></template>',
        '<template>\n  <template>\n    <p>x</p>\n  </template>\n</template>'
      ).equivalent,
      true
    );
  });

  it('still REJECTS real content changes inside a template', () => {
    const cases: Array<[string, string, string]> = [
      [
        'a dropped element',
        '<template><p>a</p><p>b</p></template>',
        '<template><p>a</p></template>'
      ],
      ['changed text', '<template><p>a</p></template>', '<template><p>z</p></template>'],
      [
        'a changed attribute',
        '<template><p id="a">x</p></template>',
        '<template><p id="b">x</p></template>'
      ],
      [
        'a collapsed no-break space',
        // Escaped ON PURPOSE: a RENDERED U+00A0 must never become a plain space,
        // and an invisible byte has no place in a test that asserts about it.
        '<template><p>10\u00a0km</p></template>',
        '<template><p>10 km</p></template>'
      ]
    ];
    for (const [name, before, after] of cases) {
      assert.equal(
        htmlTreeEqual(before, after).equivalent,
        false,
        `${name} must never pass`
      );
    }
  });

  it('a <template> inside a verbatim context keeps the byte-exact comparison', () => {
    // Conservative direction on purpose: inside <pre>, whitespace is compared
    // verbatim all the way down, template content included.
    assert.equal(
      htmlTreeEqual(
        '<pre><template>a\n\tb</template></pre>',
        '<pre><template>a\n    b</template></pre>'
      ).equivalent,
      false
    );
    // And the significant whitespace really is kept, not merely rejected by
    // accident: an identical body still compares equal.
    assert.equal(
      htmlTreeEqual(
        '<pre><template>a\n\tb</template></pre>',
        '<pre><template>a\n\tb</template></pre>'
      ).equivalent,
      true
    );
  });
});

/* -------------------------------------------------------------------------- */
/* F4 : xml:space="preserve" is the OTHER source of byte-significant text      */
/* -------------------------------------------------------------------------- */

describe('safety/guard : xml:space="preserve" is compared verbatim (SVG 1.1 §5.9)', () => {
  const REJECTED: ReadonlyArray<readonly [string, string, string]> = [
    [
      'the reported case: a run of spaces in an SVG <text>',
      '<svg width="100" height="20"><text x="0" y="10" xml:space="preserve">A  B</text></svg>',
      '<svg width="100" height="20"><text x="0" y="10" xml:space="preserve">A B</text></svg>'
    ],
    [
      'the same inside a <tspan> that declares it',
      '<svg><text><tspan xml:space="preserve">A  B</tspan></text></svg>',
      '<svg><text><tspan xml:space="preserve">A B</tspan></text></svg>'
    ],
    [
      'INHERITED: the <tspan> declares nothing, its <text> ancestor does',
      '<svg><text xml:space="preserve">A<tspan>B  C</tspan></text></svg>',
      '<svg><text xml:space="preserve">A<tspan>B C</tspan></text></svg>'
    ],
    [
      'a tab rewritten as a space',
      '<svg><text xml:space="preserve">A\tB</text></svg>',
      '<svg><text xml:space="preserve">A B</text></svg>'
    ],
    [
      'a leading space stripped',
      '<svg><text xml:space="preserve">  A B</text></svg>',
      '<svg><text xml:space="preserve">A B</text></svg>'
    ],
    [
      'a full document, not only a fragment',
      '<!doctype html><html><body><svg><text xml:space="preserve">A  B</text></svg></body></html>',
      '<!doctype html><html><body><svg><text xml:space="preserve">A B</text></svg></body></html>'
    ],
    [
      // parse5 ADJUSTS foreign attributes: in the SVG namespace xml:space
      // arrives as { prefix: 'xml', name: 'space' }. On an ordinary HTML element
      // it keeps the single name 'xml:space'. Both spellings must be read.
      'on an ordinary HTML element, where parse5 does NOT split the prefix',
      '<div xml:space="preserve">A  B</div>',
      '<div xml:space="preserve">A B</div>'
    ]
  ];

  for (const [name, before, after] of REJECTED) {
    it(`rejects: ${name}`, () => {
      const verdict = htmlTreeEqual(before, after);
      assert.equal(verdict.equivalent, false, `${name}: the drawn text changed`);
      assert.ok(
        typeof verdict.reason === 'string' && verdict.reason.length > 0,
        'a rejection must carry a reason for the output channel'
      );
    });
  }

  it('accepts an identical body, so the rejections are about the CHANGE', () => {
    const html = '<svg><text xml:space="preserve">A  B</text></svg>';
    assert.equal(htmlTreeEqual(html, html).equivalent, true);
  });

  it('xml:space="default" turns preservation back OFF for its subtree', () => {
    // Without this the fix would degenerate into "refuse every SVG": the
    // enumerated value 'default' is the collapsing behaviour, which is exactly
    // what normalizeHtmlText already models.
    assert.equal(
      htmlTreeEqual(
        '<svg><text xml:space="default">A  B</text></svg>',
        '<svg><text xml:space="default">A B</text></svg>'
      ).equivalent,
      true
    );
    // Inherited preserve, switched off by a descendant declaration.
    assert.equal(
      htmlTreeEqual(
        '<svg><text xml:space="preserve">A B<tspan xml:space="default">C  D</tspan></text></svg>',
        '<svg><text xml:space="preserve">A B<tspan xml:space="default">C D</tspan></text></svg>'
      ).equivalent,
      true
    );
  });

  it('xml:space="default" can NOT switch off a <pre> ancestor', () => {
    // white-space: pre is CSS and knows nothing about XML, so an xml:space
    // declaration must never be able to unlock a preformatted element. This is
    // why the two sources are inherited as separate bits.
    assert.equal(
      htmlTreeEqual(
        '<pre><span xml:space="default">A  B</span></pre>',
        '<pre><span xml:space="default">A B</span></pre>'
      ).equivalent,
      false
    );
  });

  it('an unrecognised xml:space value is read as NO declaration', () => {
    // Only the two enumerated keywords count. Anything else leaves the
    // inherited context standing, which can only keep preservation ON.
    assert.equal(
      htmlTreeEqual(
        '<svg><text xml:space="preserve"><tspan xml:space="wat">A  B</tspan></text></svg>',
        '<svg><text xml:space="preserve"><tspan xml:space="wat">A B</tspan></text></svg>'
      ).equivalent,
      false
    );
  });

  it('an ordinary SVG label with no declaration still formats', () => {
    // The fix must stay scoped to the attribute: nothing else in an SVG becomes
    // byte-significant.
    assert.equal(
      htmlTreeEqual(
        '<svg><text x="0">A  B</text></svg>',
        '<svg>\n  <text x="0">A B</text>\n</svg>'
      ).equivalent,
      true
    );
  });

  it('the ENGINE still collapses it, which is why this is a correct REJECTION', async () => {
    // js-beautify's content_unformatted is keyed on TAG NAMES, so it cannot be
    // told "leave this element alone because of an attribute". The printer is
    // therefore still wrong here and the guard is what stops the write. If a
    // future js-beautify (or a fourth mask layer) ever preserves it, this test
    // fails loudly and the pairing above can be revisited.
    const html = '<svg><text x="0" y="10" xml:space="preserve">A  B</text></svg>';
    const formatted = await formatHtml(html);
    assert.ok(
      !formatted.includes('A  B'),
      'if the printer now preserves the run, promote this from rejection to format'
    );
    assert.equal(guard.check('html', html, formatted).equivalent, false);
  });
});
