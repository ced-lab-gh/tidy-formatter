// F5 : CSS WHITE-SPACE BLINDNESS. The guard modelled only two of the three
// mechanisms that make HTML whitespace significant.
//
// The tag list (F1) keys on the TAG and xml:space (F4) on an ATTRIBUTE the SVG
// spec defines. Neither could see the property both of them are DEFINED in terms
// of, so an ordinary <div> or <span> carrying `style="white-space:pre"` was
// treated as reflowable flow text. Proven, applied=true, at document AND
// selection scope:
//
//   <span style="white-space:pre">NAME      QTY\nfoo         1</span>
//     was WRITTEN as <span style="white-space:pre">NAME QTY\n  foo 1</span>
//   <div style="white-space:pre-wrap">Hello\n\n    Bob,   how are you?</div>
//     lost its indentation
//   <div style="white-space:pre">def f():\n    return 1</div>
//     had its 4-space Python indent rewritten to 2
//
// This suite is the CLASS closed, not the three reports patched. It sweeps every
// white-space value, from every source, inline and through a <style> block,
// declared and inherited and overridden, at both scopes. The model itself is
// pinned separately in htmlWhitespaceModel.test.ts; here we only care what
// verdict a real document gets.
//
// TWO DELIBERATE DECISIONS ARE LOCKED HERE.
//   (a) `pre-line` is modelled ACCURATELY rather than lumped in with `pre`: it
//       collapses spaces and tabs but DRAWS newlines, so reflowing its spaces is
//       accepted and losing or gaining a line break is rejected.
//   (b) The `<style>` + class route FAILS CLOSED. Deciding which elements a
//       selector matches is CSS selector matching against the tree, a second
//       parser this guard deliberately does not carry, so a document whose
//       embedded CSS sets a preserving white-space value anywhere is REJECTED
//       with the file untouched instead of being reflowed on a bet.
import assert from 'node:assert/strict';
import { dispatchFormat } from '../../../src/engine/dispatcher';
import { guard, htmlTreeEqual } from '../../../src/safety/guard';
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
 * Format a SELECTION exactly the way src/providers/formattingProvider.ts does:
 * the engine is handed only the span (with a range), the result is spliced back
 * into the document, and the guard is asked about the whole document. Returns
 * the guard's verdict on that edit.
 *
 * This is what makes the "at both scopes" claim a measurement rather than an
 * assumption: the same textual change is put to the guard twice, once as a whole
 * document and once as a selection inside one.
 */
async function verdictForSelection(
  document: string,
  span: string
): Promise<{ equivalent: boolean; changed: boolean }> {
  const start = document.indexOf(span);
  assert.ok(start >= 0, `span not found in document: ${span}`);
  const prefix = document.slice(0, start);
  const suffix = document.slice(start + span.length);
  const formatted = await dispatchFormat({
    languageId: 'html',
    code: span,
    options: OPTS,
    range: { startOffset: 0, endOffset: span.length }
  });
  return {
    equivalent: guard.check('html', prefix + span + suffix, prefix + formatted + suffix)
      .equivalent,
    changed: formatted !== span
  };
}

/* -------------------------------------------------------------------------- */
/* 1. the three reported cases, as guard questions and as real formats         */
/* -------------------------------------------------------------------------- */

describe('safety/guard : the reported CSS white-space corruptions', () => {
  const REPORTED: ReadonlyArray<readonly [string, string, string]> = [
    [
      'a column-aligned table in a white-space:pre span',
      '<span style="white-space:pre">NAME      QTY\nfoo         1</span>',
      '<span style="white-space:pre">NAME QTY\n  foo 1</span>'
    ],
    [
      'a pre-wrap letter losing its indentation',
      '<div style="white-space:pre-wrap">Hello\n\n    Bob,   how are you?</div>',
      '<div style="white-space:pre-wrap">Hello\n\n  Bob, how are you?</div>'
    ],
    [
      'a Python snippet reindented from 4 spaces to 2',
      '<div style="white-space:pre">def f():\n    return 1</div>',
      '<div style="white-space:pre">def f():\n  return 1</div>'
    ]
  ];

  for (const [name, before, after] of REPORTED) {
    it(`rejects ${name}, whatever produced it`, () => {
      const verdict = htmlTreeEqual(before, after);
      assert.equal(verdict.equivalent, false, `${name}: the drawn text changed`);
      assert.ok(
        typeof verdict.reason === 'string' && verdict.reason.length > 0,
        'a rejection must carry a reason for the output channel'
      );
    });

    it(`and the real format of ${name} is not applied`, async () => {
      const out = await formatHtml(before);
      assert.notEqual(out, before, 'the printer really does still reflow it');
      assert.equal(
        guard.check('html', before, out).equivalent,
        false,
        'so the guard is what stops the write, and the file stays intact'
      );
    });
  }

  it('the same three are rejected at BOTH scopes', async () => {
    // The verdict must depend on the CHANGE, never on how much of the file the
    // user happened to select. Three framings of the identical change:
    //   (a) the fragment on its own,
    //   (b) the same change inside the document a selection is spliced into,
    //   (c) the real selection path, engine included.
    const PREFIX = '<section>\n';
    const SUFFIX = '\n</section>';
    for (const [name, before, after] of REPORTED) {
      assert.equal(htmlTreeEqual(before, after).equivalent, false, `${name}: fragment`);
      assert.equal(
        guard.check('html', PREFIX + before + SUFFIX, PREFIX + after + SUFFIX).equivalent,
        false,
        `${name}: the same change, inside a document`
      );
      const asSelection = await verdictForSelection(PREFIX + before + SUFFIX, before);
      assert.equal(asSelection.changed, true, `${name}: the printer reflowed the selection`);
      assert.equal(asSelection.equivalent, false, `${name}: selection scope`);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 2. THE SWEEP: every value, inline, own element and inherited, both scopes   */
/* -------------------------------------------------------------------------- */

/**
 * A body in which every kind of whitespace is visible if it is drawn: a run of
 * spaces, a blank line and a tab-indented line.
 */
const BODY = 'NAME      QTY\n\n\tfoo         1';

/** The reflow a formatter performs on that body when it is free to. */
const REFLOWED = 'NAME QTY\n\n foo 1';

/** What each value means: what the guard must compare the text as. */
type Significance = 'collapse' | 'breaks' | 'verbatim';

const SWEEP: ReadonlyArray<readonly [string, Significance]> = [
  ['white-space:normal', 'collapse'],
  ['white-space:nowrap', 'collapse'],
  ['white-space:pre', 'verbatim'],
  ['white-space:pre-wrap', 'verbatim'],
  ['white-space:pre-line', 'breaks'],
  ['white-space:break-spaces', 'verbatim'],
  ['white-space-collapse:collapse', 'collapse'],
  ['white-space-collapse:discard', 'collapse'],
  ['white-space-collapse:preserve', 'verbatim'],
  ['white-space-collapse:preserve-breaks', 'breaks'],
  ['white-space-collapse:preserve-spaces', 'verbatim'],
  ['white-space-collapse:break-spaces', 'verbatim'],
  ['white-space:preserve nowrap', 'verbatim'],
  ['white-space:collapse wrap', 'collapse'],
  ['white-space:PRE', 'verbatim'],
  ['white-space:pre !important', 'verbatim'],
  ['color:red;white-space:pre', 'verbatim'],
  ['background:url(a;b.png);white-space:pre', 'verbatim'],
  ['white-space:normal;white-space:pre', 'verbatim'],
  ['white-space:pre;white-space:normal', 'collapse'],
  ['white-space:var(--ws)', 'verbatim'],
  ['white-space:-moz-pre-wrap', 'verbatim'],
  ['white-space:initial', 'collapse'],
  ['white-space:inherit', 'collapse']
];

/**
 * The verdict a given significance must produce for a whitespace-only reflow of
 * BODY: `verbatim` rejects everything, `breaks` accepts a space reflow that
 * keeps the line structure, `collapse` accepts it all.
 */
function expectedForReflow(significance: Significance): boolean {
  return significance !== 'verbatim';
}

describe('safety/guard : every white-space value, declared on the element', () => {
  for (const [declaration, significance] of SWEEP) {
    it(`[${declaration}] is compared as ${significance}`, () => {
      const before = `<div style="${declaration}">${BODY}</div>`;
      const after = `<div style="${declaration}">${REFLOWED}</div>`;
      assert.equal(
        htmlTreeEqual(before, after).equivalent,
        expectedForReflow(significance),
        `a space/tab reflow under ${declaration}`
      );
      // Every value must also reject a change that is drawn at ITS level: a
      // lost line break for `breaks`, a lost space for `verbatim`. `collapse`
      // is the one point of the lattice where neither is drawn.
      const lostBreak = `<div style="${declaration}">${REFLOWED.replace('\n\n', '\n')}</div>`;
      assert.equal(
        htmlTreeEqual(after, lostBreak).equivalent,
        significance === 'collapse',
        `a lost line break under ${declaration}`
      );
    });
  }
});

describe('safety/guard : the same values, INHERITED by a descendant', () => {
  // white-space is an inherited CSS property, so a text node several elements
  // below the declaration is drawn by the same rule. A parent-only test is the
  // shape of the <pre><code> defect, reproduced here for the CSS source.
  for (const [declaration, significance] of SWEEP) {
    it(`[${declaration}] reaches a nested <span><b>`, () => {
      const before = `<div style="${declaration}"><span><b>${BODY}</b></span></div>`;
      const after = `<div style="${declaration}"><span><b>${REFLOWED}</b></span></div>`;
      assert.equal(
        htmlTreeEqual(before, after).equivalent,
        expectedForReflow(significance)
      );
    });
  }
});

describe('safety/guard : the CSS source at document AND selection scope', () => {
  // The provider splices a selection back into its document before asking, so
  // the two scopes ask the SAME question. This walks the sweep through both and
  // asserts they agree, case by case: a verdict that depended on how much of the
  // file the user selected would be the F2 defect all over again.
  for (const [declaration, significance] of SWEEP) {
    it(`[${declaration}] gets the same verdict at both scopes`, async () => {
      const element = `<div style="${declaration}">${BODY}</div>`;
      const document = `<section>\n${element}\n</section>`;

      const documentOut = await formatHtml(document);
      const atDocument = guard.check('html', document, documentOut).equivalent;
      const atSelection = await verdictForSelection(document, element);

      assert.equal(
        atSelection.equivalent,
        atDocument,
        `${declaration}: scope changed the verdict`
      );
      // And the shared verdict is the one the significance calls for. The
      // printer knows nothing about the style attribute, so it reflows the body
      // in both scopes and a verbatim value is refused in both.
      assert.equal(
        atDocument,
        significance !== 'verbatim',
        `${declaration}: wrong verdict at both scopes`
      );
    });
  }
});

/* -------------------------------------------------------------------------- */
/* 3. pre-line is NOT pre                                                      */
/* -------------------------------------------------------------------------- */

describe('safety/guard : pre-line draws newlines and collapses spaces', () => {
  const PRE_LINE = 'style="white-space:pre-line"';

  const REJECTED: ReadonlyArray<readonly [string, string, string]> = [
    [
      'a drawn line break removed',
      `<div ${PRE_LINE}>alpha\nbeta</div>`,
      `<div ${PRE_LINE}>alpha beta</div>`
    ],
    [
      'a line break ADDED by wrapping',
      `<div ${PRE_LINE}>alpha beta</div>`,
      `<div ${PRE_LINE}>alpha\nbeta</div>`
    ],
    [
      'a blank line collapsed (two breaks into one)',
      `<div ${PRE_LINE}>alpha\n\nbeta</div>`,
      `<div ${PRE_LINE}>alpha\nbeta</div>`
    ],
    [
      'a whitespace-only node that CARRIES a break, dropped',
      `<div ${PRE_LINE}><b>a</b>\n<b>b</b></div>`,
      `<div ${PRE_LINE}><b>a</b><b>b</b></div>`
    ],
    [
      'a break inserted between two inline children',
      `<div ${PRE_LINE}><b>a</b><b>b</b></div>`,
      `<div ${PRE_LINE}><b>a</b>\n<b>b</b></div>`
    ],
    [
      'inherited by a descendant that declares nothing',
      `<div ${PRE_LINE}><span><b>alpha\nbeta</b></span></div>`,
      `<div ${PRE_LINE}><span><b>alpha beta</b></span></div>`
    ],
    [
      'a rendered no-break space degraded, which no reflow explains',
      // Escaped ON PURPOSE: an invisible byte has no place in a test that
      // asserts about it, and U+00A0 is a drawn character, never a blank.
      `<div ${PRE_LINE}>10\u00a0km</div>`,
      `<div ${PRE_LINE}>10 km</div>`
    ]
  ];
  for (const [name, before, after] of REJECTED) {
    it(`rejects: ${name}`, () => {
      assert.equal(htmlTreeEqual(before, after).equivalent, false);
    });
  }

  const ACCEPTED: ReadonlyArray<readonly [string, string, string]> = [
    [
      'a run of spaces collapsed, which pre-line really does collapse',
      `<div ${PRE_LINE}>alpha    beta</div>`,
      `<div ${PRE_LINE}>alpha beta</div>`
    ],
    [
      'a tab folded into a space',
      `<div ${PRE_LINE}>alpha\tbeta</div>`,
      `<div ${PRE_LINE}>alpha beta</div>`
    ],
    [
      'reindentation around a preserved break (spaces beside a break are removed)',
      `<div ${PRE_LINE}>alpha\nbeta</div>`,
      `<div ${PRE_LINE}>alpha\n    beta</div>`
    ],
    [
      'a whitespace-only node with no break, dropped',
      `<div ${PRE_LINE}><b>a</b>   <b>b</b></div>`,
      `<div ${PRE_LINE}><b>a</b><b>b</b></div>`
    ]
  ];
  for (const [name, before, after] of ACCEPTED) {
    it(`accepts: ${name}`, () => {
      assert.equal(
        htmlTreeEqual(before, after).equivalent,
        true,
        'lumping pre-line in with pre would reject this and be a false reject'
      );
    });
  }
});

/* -------------------------------------------------------------------------- */
/* 4. no mechanism may switch off another                                      */
/* -------------------------------------------------------------------------- */

describe('safety/guard : each source switches off only its own kind', () => {
  it('white-space:normal can NOT unlock a <pre> ancestor', () => {
    // The UA sheet's `white-space: pre` on <pre> is what the tag source models.
    // A real cascade would let an author declaration beat it; the guard refuses
    // to, because the permissive direction is the one that writes to disk.
    assert.equal(
      htmlTreeEqual(
        '<pre><span style="white-space:normal">A\tB</span></pre>',
        '<pre><span style="white-space:normal">A    B</span></pre>'
      ).equivalent,
      false
    );
  });

  it('white-space:pre-line can NOT downgrade a <pre> ancestor', () => {
    assert.equal(
      htmlTreeEqual(
        '<pre><span style="white-space:pre-line">A  B</span></pre>',
        '<pre><span style="white-space:pre-line">A B</span></pre>'
      ).equivalent,
      false
    );
  });

  it('white-space:normal can NOT unlock an xml:space="preserve" ancestor', () => {
    assert.equal(
      htmlTreeEqual(
        '<svg><text xml:space="preserve"><tspan style="white-space:normal">A  B</tspan></text></svg>',
        '<svg><text xml:space="preserve"><tspan style="white-space:normal">A B</tspan></text></svg>'
      ).equivalent,
      false
    );
  });

  it('xml:space="default" can NOT unlock a CSS white-space:pre ancestor', () => {
    assert.equal(
      htmlTreeEqual(
        '<div style="white-space:pre"><span xml:space="default">A  B</span></div>',
        '<div style="white-space:pre"><span xml:space="default">A B</span></div>'
      ).equivalent,
      false
    );
  });

  it('but CSS DOES switch off CSS, which is what the cascade does', () => {
    // Without this the fix would degenerate into "refuse every styled page":
    // `white-space: normal` on a descendant really is the collapsing behaviour
    // the default normalizer already models.
    assert.equal(
      htmlTreeEqual(
        '<div style="white-space:pre"><span style="white-space:normal">a  b</span></div>',
        '<div style="white-space:pre"><span style="white-space:normal">a b</span></div>'
      ).equivalent,
      true
    );
    // and it switches off only the subtree it sits on: the ancestor's own text
    // is still drawn verbatim.
    assert.equal(
      htmlTreeEqual(
        '<div style="white-space:pre">A  B<span style="white-space:normal">a  b</span></div>',
        '<div style="white-space:pre">A B<span style="white-space:normal">a b</span></div>'
      ).equivalent,
      false
    );
  });

  it('a CSS declaration can be narrowed, not only cleared', () => {
    // pre -> pre-line on a descendant: spaces become reflowable again, breaks
    // stay drawn. Both halves are asserted so the narrowing is not just "off".
    assert.equal(
      htmlTreeEqual(
        '<div style="white-space:pre"><span style="white-space:pre-line">a  b</span></div>',
        '<div style="white-space:pre"><span style="white-space:pre-line">a b</span></div>'
      ).equivalent,
      true
    );
    assert.equal(
      htmlTreeEqual(
        '<div style="white-space:pre"><span style="white-space:pre-line">a\nb</span></div>',
        '<div style="white-space:pre"><span style="white-space:pre-line">a b</span></div>'
      ).equivalent,
      false
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 5. the <style> route: a deliberate fail-closed                              */
/* -------------------------------------------------------------------------- */

describe('safety/guard : embedded CSS that preserves whitespace is refused, not guessed', () => {
  const REFUSED: readonly string[] = [
    '<style>.log{white-space:pre-wrap}</style><div class="log">a\n    b</div>',
    '<style>.log{white-space:pre}</style><div class="log">a\n    b</div>',
    '<style>.log{white-space:pre-line}</style><div class="log">a\n    b</div>',
    '<style>.log{white-space:break-spaces}</style><div class="log">a\n    b</div>',
    '<style>.log{white-space-collapse:preserve}</style><div class="log">a\n    b</div>',
    '<style>#id > .log:hover{white-space:pre}</style><div class="log">a\n    b</div>',
    '<style>@media print{.log{white-space:pre}}</style><div class="log">a\n    b</div>',
    // Inside a <template>, and inside an <svg>: both child lists are walked.
    '<template><style>.log{white-space:pre}</style></template><div>a\n    b</div>',
    '<svg><style>text{white-space:pre}</style><text>A  B</text></svg>'
  ];

  for (const input of REFUSED) {
    it(`refuses: ${input.slice(0, 60)}`, async () => {
      const out = await formatHtml(input);
      assert.notEqual(out, input, 'the printer really does change this document');
      const verdict = guard.check('html', input, out);
      assert.equal(verdict.equivalent, false);
      assert.match(
        verdict.reason ?? '',
        /embedded CSS sets a preserving white-space value/,
        'the channel must say WHY, so the refusal is actionable'
      );
    });
  }

  it('a <style> the CSS parser cannot read is scanned all the same', async () => {
    // The scan reads RAW text on purpose, so a stylesheet that fails to parse
    // cannot smuggle a preserving rule past it. Such a body is ALSO held to a
    // byte-identical comparison by canonicalizeEmbeddedCode, so either half of
    // the guard may be the one that speaks first; what matters is that nothing
    // is written.
    const input = '<style>@media{.a{white-space:pre</style><div>a\n    b</div>';
    const out = await formatHtml(input);
    assert.notEqual(out, input);
    const verdict = guard.check('html', input, out);
    assert.equal(verdict.equivalent, false);
    assert.ok((verdict.reason ?? '').length > 0, 'a rejection must carry a reason');
    // And the scan itself really does see it, whichever check fires first.
    assert.equal(
      htmlTreeEqual(input, input.replace('a\n    b', 'a b')).equivalent,
      false
    );
  });

  it('a stylesheet whose white-space is collapsing does NOT block formatting', async () => {
    // The fail-closed rule keys on the VALUE, so the very common `nowrap` and
    // `normal` declarations leave ordinary pages formattable.
    const HARMLESS: readonly string[] = [
      '<style>.log{white-space:nowrap}</style>\n<p>a   b</p>',
      '<style>.log{white-space:normal}</style>\n<p>a   b</p>',
      '<style>.log{white-space-collapse:collapse}</style>\n<p>a   b</p>',
      '<style>.log{color:red;margin:0}</style>\n<p>a   b</p>'
    ];
    for (const input of HARMLESS) {
      const out = await formatHtml(input);
      assert.equal(
        guard.check('html', input, out).equivalent,
        true,
        `must still format: ${input}`
      );
    }
  });

  it('the refusal holds at selection scope too', async () => {
    const element = '<div class="log">a\n    b</div>';
    const document = `<style>.log{white-space:pre-wrap}</style>\n${element}`;
    const asSelection = await verdictForSelection(document, element);
    assert.equal(
      asSelection.equivalent,
      false,
      'selecting only the element must not hide the stylesheet that styles it'
    );
  });

  it('a stylesheet the OUTPUT gained is exactly as unprovable as one the input had', () => {
    assert.equal(
      htmlTreeEqual(
        '<div>a\n b</div>',
        '<style>.log{white-space:pre}</style><div>a b</div>'
      ).equivalent,
      false
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 6. anti-false-reject: the fix must not freeze ordinary pages                */
/* -------------------------------------------------------------------------- */

describe('safety/guard : ordinary documents still format', () => {
  const CLEAN: ReadonlyArray<readonly [string, string]> = [
    ['a plain page', '<div>\n<p>hello   world</p>\n<span>a</span>\n</div>'],
    ['a nowrap element', '<div style="white-space:nowrap">a   b</div>'],
    ['a normal element', '<div style="white-space:normal">a   b</div>'],
    ['an element with an unrelated style', '<div style="color:red;margin:0">a   b</div>'],
    ['an empty style attribute', '<div style="">a   b</div>'],
    // A CSS escape in an unrelated value must not be read as an unresolvable
    // white-space: font stacks written with escapes are ordinary markup.
    ['a font stack written with CSS escapes', "<div style=\"font-family:'\\5FAE\\8F6F'\">a   b</div>"],
    ['a <template>', '<div><template><p>a</p><p>b</p></template></div>'],
    ['an SVG label with no declaration', '<svg><text x="0">A  B</text></svg>'],
    ['a <pre> the printer already protects', '<section>\n<pre>a  b</pre>\n</section>']
  ];

  for (const [name, input] of CLEAN) {
    it(`accepts the real format of ${name}`, async () => {
      const out = await formatHtml(input);
      assert.equal(
        guard.check('html', input, out).equivalent,
        true,
        `a false reject on ${name} would make Tidy look broken`
      );
    });
  }

  it('a white-space:pre element whose body the printer did not touch is accepted', () => {
    // The rejection must be about the CHANGE, not about the declaration: an
    // identical body compares equal however verbatim the context is.
    assert.equal(
      htmlTreeEqual(
        '<section><div style="white-space:pre">a  b</div></section>',
        '<section>\n  <div style="white-space:pre">a  b</div>\n</section>'
      ).equivalent,
      true
    );
  });
});

// The two holes an adversarial audit found in this model AFTER it first landed.
// Both were accept-when-not-equivalent: the reflow below was WRITTEN. They live
// here, next to the corruptions that motivated the model, because that is where
// anyone changing the model will look.
describe('safety/guard : the two holes found after the model landed', () => {
  it('refuses a sheet whose declaration is glued to a comment', () => {
    // `/*x*/` before the property name defeated the scan's boundary character,
    // so the fail-closed rule never fired and the drawn spaces were collapsed.
    const before =
      '<style>.log{color:red;/*x*/white-space:pre-wrap}</style>\n<div class="log">a      b</div>';
    const after =
      '<style>.log{color:red;/*x*/white-space:pre-wrap}</style>\n<div class="log">a b</div>';
    assert.equal(htmlTreeEqual(before, after).equivalent, false);
    // The same sheet without the comment was already refused; both must agree.
    assert.equal(
      htmlTreeEqual(
        '<style>.log{white-space:pre-wrap}</style>\n<div class="log">a      b</div>',
        '<style>.log{white-space:pre-wrap}</style>\n<div class="log">a b</div>'
      ).equivalent,
      false
    );
  });

  it('does not let an unimplemented trim keyword cancel a preserving ancestor', () => {
    // `white-space: none` names a `white-space-trim` value no shipping renderer
    // accepts, so the declaration is dropped and the <div>'s `pre` still draws
    // every space. Reading it as `collapse` rewrote them.
    const before = '<div style="white-space:pre"><span style="white-space:none">a      b</span></div>';
    const after = '<div style="white-space:pre"><span style="white-space:none">a b</span></div>';
    assert.equal(htmlTreeEqual(before, after).equivalent, false);
  });

  it('still lets a VALID collapsing value on the same element take effect', () => {
    // The contrast that makes the fix a fix rather than a blanket refusal: a
    // renderer really does apply `white-space: normal` here, so the reflow is
    // equivalent and must stay accepted.
    const before = '<div style="white-space:pre"><span style="white-space:normal">a      b</span></div>';
    const after = '<div style="white-space:pre"><span style="white-space:normal">a b</span></div>';
    assert.equal(htmlTreeEqual(before, after).equivalent, true);
  });
});
