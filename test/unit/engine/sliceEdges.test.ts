// Unit tests for the edge-whitespace rule of a RANGE format
// (src/engine/sliceEdges.ts), the single implementation shared by the
// js-beautify range branch and the formatting provider.
//
// The rule exists because a printer trims the edges of the slice it is handed,
// and at selection scope that silently JOINS the slice to the bytes still
// sitting on either side of it in the buffer:
//   defect G3-4 : "hello x y" was written as "hello xy", and the HTML guard
//                 cannot see it (a whitespace-only text node between two inline
//                 elements is exactly what it normalises away);
//   defect M3-3 : a selection whose last character is a line break came back one
//                 line longer, so the next pass formatted a DIFFERENT slice and
//                 format(format(x)) never reached a fixed point.
import assert from 'node:assert/strict';
import {
  cutsThroughMarkup,
  splitSliceEdges,
  withSliceEdges
} from '../../../src/engine/sliceEdges';

describe('engine/sliceEdges : splitSliceEdges', () => {
  it('splits a slice into leading run / content / trailing run', () => {
    assert.deepEqual(splitSliceEdges(' <b>x</b> \n'), {
      leading: ' ',
      core: '<b>x</b>',
      trailing: ' \n'
    });
  });

  it('reassembles the original slice byte for byte', () => {
    for (const slice of [
      '<p>a</p>',
      '\n  <p>a</p>\n',
      ' \t<p>a</p>\r\n',
      'x',
      '\r\n'
    ]) {
      const parts = splitSliceEdges(slice);
      assert.equal(
        parts.leading + parts.core + parts.trailing,
        slice,
        `lossy split for ${JSON.stringify(slice)}`
      );
    }
  });

  it('reports core === "" for a slice that is nothing but whitespace', () => {
    for (const blank of [' ', '\n', '\r\n', ' \t \n  ']) {
      const parts = splitSliceEdges(blank);
      assert.equal(parts.core, '', `${JSON.stringify(blank)} has no content`);
      assert.equal(parts.leading, blank, 'the whole run is the leading one');
      assert.equal(parts.trailing, '');
    }
  });

  it('never lets the two runs overlap on a one-character slice', () => {
    const parts = splitSliceEdges('x');
    assert.deepEqual(parts, { leading: '', core: 'x', trailing: '' });
  });

  it('keeps interior whitespace inside the core', () => {
    const parts = splitSliceEdges(' a  b \n');
    assert.equal(parts.core, 'a  b');
  });
});

describe('engine/sliceEdges : withSliceEdges', () => {
  it('THE DEFECT (G3-4): a trimmed trailing run is put back verbatim', () => {
    // The engine was handed "<p>hello <b>x</b> \n" and printed
    // "<p>hello <b>x</b>". Splicing that trimmed result is what turned the
    // rendered "hello x y" into "hello xy".
    assert.equal(
      withSliceEdges('<p>hello <b>x</b> \n', '<p>hello <b>x</b>'),
      '<p>hello <b>x</b> \n'
    );
  });

  it('THE DEFECT (G3-4): a trimmed LEADING run is put back verbatim too', () => {
    assert.equal(withSliceEdges(' <b>x</b> ', '<b>x</b>'), ' <b>x</b> ');
  });

  it('keeps the printed CONTENT: only the two edge runs come from the slice', () => {
    assert.equal(
      withSliceEdges('\n  .a{color:red}\n', '.a {\n  color: red\n}'),
      '\n  .a {\n  color: red\n}\n'
    );
  });

  it('hands back a whitespace-only slice verbatim, whatever the printer said', () => {
    // In HTML that run IS a rendered space; there is no content to print.
    assert.equal(withSliceEdges(' \n ', ''), ' \n ');
    assert.equal(withSliceEdges('\r\n', '\n'), '\r\n');
  });

  it('leaves a whitespace-only RESULT alone so the guard judges the real output', () => {
    // The engine printing nothing for a slice that had content is a fault the
    // guard must see, not one this rule papers over.
    assert.equal(withSliceEdges(' <b>x</b> ', '   '), '   ');
  });

  it('is idempotent, so a second layer applying it changes nothing', () => {
    const slice = '\n  <b>x</b> \n';
    const once = withSliceEdges(slice, '<b>x</b>');
    assert.equal(withSliceEdges(slice, once), once);
  });

  it('is a no-op when the printer already honoured the edges', () => {
    const printed = '\n  <b>x</b> \n';
    assert.equal(withSliceEdges('\n  <b>y</b> \n', printed), printed);
  });

  it('preserves CRLF edges exactly when the user set no endOfLine', () => {
    // With no explicit setting "keep the bytes that were there" is the rule, so
    // putting them back can only restore the EOL the document already had.
    const out = withSliceEdges('\r\n.a{color:red}\r\n', '.a {\r\n  color: red\r\n}');
    assert.ok(out.startsWith('\r\n'), `got ${JSON.stringify(out)}`);
    assert.ok(out.endsWith('\r\n'), `got ${JSON.stringify(out)}`);
    assert.ok(!/[^\r]\n/.test(out.slice(0, 2)), 'the leading run stays CRLF');
  });

  it('mutates neither argument', () => {
    const slice = ' a ';
    const printed = 'b';
    withSliceEdges(slice, printed);
    assert.equal(slice, ' a ');
    assert.equal(printed, 'b');
  });
});

/* -------------------------------------------------------------------------- */
/* An EXPLICIT endOfLine also owns the restored edges                          */
/* -------------------------------------------------------------------------- */
//
// The first version of this rule put the edge runs back byte for byte and said
// that could "never introduce a foreign EOL". True byte-locally, false at
// document level: with an explicit `files.eol` the engine converts the slice's
// INTERIOR to the requested ending while a verbatim edge keeps the old one, so a
// full-span Format Selection wrote a slice that was itself MIXED. Whitespace
// only, therefore "equivalent" to the guard, therefore WRITTEN: defect C-04's
// exact shape. Measured over seven documents x three settings, 251 of 7491
// selections wrote a mixed span, 9 of 21 of them full-span.

describe('engine/sliceEdges : withSliceEdges under an explicit endOfLine', () => {
  // What the engine prints for ".a{color:red}" once files.eol says LF.
  const PRINTED_LF = '.a {\n  color: red\n}';
  const PRINTED_CRLF = '.a {\r\n  color: red\r\n}';

  it('THE DEFECT: a verbatim trailing run left a full-span slice MIXED', () => {
    assert.equal(
      withSliceEdges('.a{color:red}\r\n', PRINTED_LF),
      '.a {\n  color: red\n}\r\n'
    );
    assert.equal(
      withSliceEdges('.a{color:red}\r\n', PRINTED_LF, { endOfLine: 'lf' }),
      '.a {\n  color: red\n}\n'
    );
  });

  it('normalises the LEADING run as well as the trailing one', () => {
    assert.equal(
      withSliceEdges('\r\n.a{color:red}\r\n', PRINTED_LF, { endOfLine: 'lf' }),
      '\n.a {\n  color: red\n}\n'
    );
  });

  it('crlf turns every restored line ending into CRLF', () => {
    assert.equal(
      withSliceEdges('\n.a{color:red}\n', PRINTED_CRLF, { endOfLine: 'crlf' }),
      '\r\n.a {\r\n  color: red\r\n}\r\n'
    );
  });

  it('normalises a bare CR edge too, so no document style is special', () => {
    assert.equal(
      withSliceEdges('\r.a{color:red}\r', PRINTED_LF, { endOfLine: 'lf' }),
      '\n.a {\n  color: red\n}\n'
    );
  });

  it('keeps the spaces and tabs of the run: only line endings are rewritten', () => {
    assert.equal(
      withSliceEdges('\r\n  .a{color:red}\t\r\n', PRINTED_LF, { endOfLine: 'lf' }),
      '\n  .a {\n  color: red\n}\t\n'
    );
  });

  it('NO explicit setting still means byte for byte', () => {
    const slice = '\r\n.a{color:red}\r\n';
    assert.equal(
      withSliceEdges(slice, PRINTED_LF, {}),
      '\r\n.a {\n  color: red\n}\r\n'
    );
    assert.equal(withSliceEdges(slice, PRINTED_LF), withSliceEdges(slice, PRINTED_LF, {}));
  });

  it('never rewrites half a CRLF the selection boundary cut in two', () => {
    // The byte before the slice is a CR, so the slice's leading LF completes
    // THAT pair; the byte after it is an LF, so the trailing CR opens the next
    // one. Rewriting either would not change a line ending, it would ADD a line
    // break to the document.
    assert.equal(
      withSliceEdges('\n.a{color:red}\r', PRINTED_CRLF, {
        endOfLine: 'crlf',
        before: 'x\r',
        after: '\ny'
      }),
      '\n' + PRINTED_CRLF + '\r'
    );
  });

  it('rewrites those same bytes when they are NOT half of a pair', () => {
    assert.equal(
      withSliceEdges('\n.a{color:red}\r', PRINTED_CRLF, {
        endOfLine: 'crlf',
        before: 'x',
        after: 'y'
      }),
      '\r\n' + PRINTED_CRLF + '\r\n'
    );
  });

  it('is idempotent with a rule, like it is without one', () => {
    const slice = '\r\n.a{color:red}\r\n';
    const rule = { endOfLine: 'lf' } as const;
    const once = withSliceEdges(slice, PRINTED_LF, rule);
    assert.equal(withSliceEdges(slice, once, rule), once);
  });

  it('leaves a whitespace-only slice verbatim even under an explicit setting', () => {
    // Nothing was printed, so there is no converted interior for a restored edge
    // to disagree with: no mixed span to prevent, and in HTML that run IS a
    // rendered space.
    assert.equal(withSliceEdges('\r\n', '\n', { endOfLine: 'lf' }), '\r\n');
  });

  it('mutates neither argument', () => {
    const slice = '\r\n a \r\n';
    const printed = 'b';
    withSliceEdges(slice, printed, { endOfLine: 'lf' });
    assert.equal(slice, '\r\n a \r\n');
    assert.equal(printed, 'b');
  });
});

/* -------------------------------------------------------------------------- */
/* A PROTECTED span owns its bytes, whatever the explicit endOfLine says       */
/* -------------------------------------------------------------------------- */
//
// The rule above rewrites EVERY line ending of a restored edge run. When the run
// reaches into a span the mask layer had just put back VERBATIM (an ignore
// region, a head front matter block, a template island), that rewrote bytes
// README and CHANGELOG both promise come back byte for byte:
//
//   src        "<div>\n<!-- tidy-ignore-start -->\n  <b>  k  </b>\n" ...
//   selection  [0,48), files.eol = crlf
//   before     "...</b>\n"    the protected bytes verbatim
//   the defect "...</b>\r\n"  an LF rewritten INSIDE the region
//
// It changes no meaning, so it is not a corruption and the guard accepts it,
// which is precisely why it has to be refused here: a documented guarantee that
// is quietly false is the defect class this project spent v0.4.0 eliminating.

describe('engine/sliceEdges : withSliceEdges over a PROTECTED span', () => {
  const PRINTED = '<b>k</b>';
  /** The slice of the defect report, in miniature: content then a protected LF. */
  const SLICE = '<b>k</b>\n';

  it('THE DEFECT: a trailing run INSIDE a protected span keeps its bytes', () => {
    assert.equal(
      withSliceEdges(SLICE, PRINTED, {
        endOfLine: 'crlf',
        protectedSpans: [{ start: 0, end: SLICE.length }]
      }),
      SLICE
    );
  });

  it('the very same run IS rewritten when no span protects it', () => {
    // The control: without the spans this is the behaviour that shipped, and it
    // is the RIGHT behaviour for bytes that are the slice's own.
    assert.equal(
      withSliceEdges(SLICE, PRINTED, { endOfLine: 'crlf' }),
      '<b>k</b>\r\n'
    );
  });

  it('protects a LEADING run the same way', () => {
    const slice = '\n<b>k</b>';
    assert.equal(
      withSliceEdges(slice, PRINTED, {
        endOfLine: 'crlf',
        protectedSpans: [{ start: 0, end: 1 }]
      }),
      slice
    );
  });

  it('ADJACENT BUT OUTSIDE: a span that stops where the run starts protects nothing', () => {
    // Half-open spans: [0,8) ends exactly at the trailing run, so the run is the
    // slice's own whitespace and the explicit setting owns it.
    assert.equal(
      withSliceEdges(SLICE, PRINTED, {
        endOfLine: 'crlf',
        protectedSpans: [{ start: 0, end: 8 }]
      }),
      '<b>k</b>\r\n'
    );
  });

  it('decides PER LINE ENDING, not per run', () => {
    // Two line endings in one trailing run, only the second protected: the first
    // is the slice's own and follows the setting, the second goes back verbatim.
    const slice = '<b>k</b>\n\n';
    assert.equal(
      withSliceEdges(slice, PRINTED, {
        endOfLine: 'crlf',
        protectedSpans: [{ start: 9, end: 10 }]
      }),
      '<b>k</b>\r\n\n'
    );
  });

  it('never splits a CRLF pair that only half-overlaps a protected span', () => {
    // The span covers the LF alone. Rewriting the CR that precedes it would not
    // change a line ending, it would ADD one, so the pair is one token.
    const slice = '<b>k</b>\r\n';
    assert.equal(
      withSliceEdges(slice, PRINTED, {
        endOfLine: 'lf',
        protectedSpans: [{ start: 9, end: 10 }]
      }),
      slice
    );
  });

  it('keeps spaces and tabs of a protected run exactly as it keeps them elsewhere', () => {
    const slice = '<b>k</b>\n  \t';
    assert.equal(
      withSliceEdges(slice, PRINTED, {
        endOfLine: 'crlf',
        protectedSpans: [{ start: 8, end: 12 }]
      }),
      slice
    );
  });

  it('an UNSET endOfLine is unaffected: the runs were already verbatim', () => {
    const slice = '\r\n<b>k</b>\r\n';
    const spans = [{ start: 0, end: 2 }];
    assert.equal(
      withSliceEdges(slice, PRINTED, { protectedSpans: spans }),
      withSliceEdges(slice, PRINTED)
    );
    assert.equal(withSliceEdges(slice, PRINTED, { protectedSpans: spans }), slice);
  });

  it('composes with the boundary rule: a half pair stays half, protected or not', () => {
    assert.equal(
      withSliceEdges('\n<b>k</b>\r', PRINTED, {
        endOfLine: 'crlf',
        before: 'x\r',
        after: '\ny',
        protectedSpans: [{ start: 0, end: 1 }]
      }),
      '\n<b>k</b>\r'
    );
  });

  it('a whitespace-only slice is verbatim with protected spans too', () => {
    assert.equal(
      withSliceEdges('\r\n', '\n', {
        endOfLine: 'lf',
        protectedSpans: [{ start: 0, end: 2 }]
      }),
      '\r\n'
    );
  });

  it('is idempotent with protected spans, like it is without them', () => {
    const rule = {
      endOfLine: 'crlf' as const,
      protectedSpans: [{ start: 8, end: 9 }]
    };
    const once = withSliceEdges(SLICE, PRINTED, rule);
    assert.equal(withSliceEdges(SLICE, once, rule), once);
  });

  it('mutates neither the slice nor the span list', () => {
    const spans = [{ start: 8, end: 9 }];
    const snapshot = JSON.stringify(spans);
    withSliceEdges(SLICE, PRINTED, { endOfLine: 'crlf', protectedSpans: spans });
    assert.equal(JSON.stringify(spans), snapshot);
    assert.equal(SLICE, '<b>k</b>\n');
  });

  it('an EMPTY span list behaves exactly like no list at all', () => {
    assert.equal(
      withSliceEdges(SLICE, PRINTED, { endOfLine: 'crlf', protectedSpans: [] }),
      withSliceEdges(SLICE, PRINTED, { endOfLine: 'crlf' })
    );
  });
});

/* -------------------------------------------------------------------------- */
/* A slice whose EDGES are not well formed is not a formattable unit           */
/* -------------------------------------------------------------------------- */
//
// Restoring the slice's own leading whitespace run REPAIRS a tag the selection
// cut in half before the guard ever sees it, and what is left is a line break
// the engine inserted between two ADJACENT INLINE elements: a whitespace-only
// text node, exactly what the HTML guard normalises away. A rejection that
// happened by luck became a write that changes the rendered text. The refusal is
// now explicit, and this is the predicate it rests on.

describe('engine/sliceEdges : cutsThroughMarkup', () => {
  // The audit's reproduction. '<div class="row">' ends at 16, so '<button'
  // opens at 17 and its '>' is at 38; offset 24 is the line break BETWEEN two
  // attributes, and offset 53 sits just inside the second '<button'.
  const ROW =
    '<div class="row"><button\n  class="btn">Save</button><button\n  class="btn">Cancel</button></div>';

  it('THE REGRESSION CELL: [24,53) has BOTH boundaries inside a start tag', () => {
    assert.equal(cutsThroughMarkup(ROW, 24, 53), true);
  });

  it('refuses a boundary inside a tag whichever end it is', () => {
    assert.equal(cutsThroughMarkup(ROW, 24, 52), true, 'start inside the tag');
    assert.equal(cutsThroughMarkup(ROW, 17, 53), true, 'end inside the tag');
  });

  it('refuses a boundary inside a CLOSING tag', () => {
    // '</button>' spans 43..51.
    assert.equal(cutsThroughMarkup(ROW, 0, 45), true);
  });

  it('accepts a boundary AT a "<" and just past a ">"', () => {
    assert.equal(cutsThroughMarkup(ROW, 0, ROW.length), false, 'the whole document');
    assert.equal(cutsThroughMarkup(ROW, 17, 52), false, 'a whole element');
  });

  it('accepts a boundary inside ordinary text', () => {
    // 'Save' spans 39..42.
    assert.equal(cutsThroughMarkup(ROW, 40, 52), false);
  });

  it('reproduces on the other two shapes the audit found', () => {
    const nav = '<nav><a\n href="/a1">A</a><a\n href="/b1">B</a></nav>';
    const spans = '<p><span\n class="xx">a</span><span\n class="yy">b</span></p>';
    assert.equal(cutsThroughMarkup(nav, 7, 26), true);
    assert.equal(cutsThroughMarkup(spans, 8, 30), true);
  });

  it('refuses a boundary inside an HTML comment', () => {
    const source = '<p>a</p><!-- keep me --><p>b</p>';
    assert.equal(cutsThroughMarkup(source, 12, source.length), true);
    assert.equal(cutsThroughMarkup(source, 8, source.length), false, 'AT the comment');
    assert.equal(cutsThroughMarkup(source, 24, source.length), false, 'just past it');
  });

  it('refuses a boundary inside a doctype or another declaration', () => {
    const source = '<!DOCTYPE html>\n<p>a</p>';
    assert.equal(cutsThroughMarkup(source, 5, source.length), true);
    assert.equal(cutsThroughMarkup(source, 15, source.length), false);
  });

  it('does not let a quoted ">" end a tag early', () => {
    // Without quote tracking the tag would look like it ended at index 11, and a
    // boundary at 12 would be called safe while it sits inside the attribute.
    const source = '<a title="a>b">x</a>';
    assert.equal(cutsThroughMarkup(source, 12, source.length), true);
    assert.equal(cutsThroughMarkup(source, 15, source.length), false);
  });

  it('treats the CONTENT of script/style/textarea/title as text, not markup', () => {
    // 'a < b' and 'a <b' inside a <script> are comparisons. Scanning them as
    // markup would refuse honest selections.
    const source = '<div>\n<script>\nif (a <b && c> d) {}\n</script>\n</div>';
    const start = source.indexOf('if (');
    const end = source.indexOf('</script>');
    assert.equal(cutsThroughMarkup(source, start, end), false);
  });

  it('treats an UNCLOSED raw-text element as text to the end of the file', () => {
    const source = '<script>let a = 1';
    assert.equal(cutsThroughMarkup(source, 9, source.length), false);
  });

  it('still sees the tags AFTER a raw-text element', () => {
    const source = '<script>x</script><button\n class="b">go</button>';
    const inside = source.indexOf('\n class');
    assert.equal(cutsThroughMarkup(source, inside, source.length), true);
  });

  it('treats a "<" that opens no tag as text (a template island)', () => {
    const source = '<div><% out.write(total) %></div>';
    const start = source.indexOf('out.write');
    assert.equal(cutsThroughMarkup(source, start, source.length), false);
  });

  it('treats an UNTERMINATED tag as markup a boundary can only cut through', () => {
    const source = '<p>a</p><div class="x';
    assert.equal(
      cutsThroughMarkup(source, 12, source.length),
      true,
      'a boundary inside the broken tag'
    );
    assert.equal(cutsThroughMarkup(source, 0, 8), false, 'the well formed part is fine');
    assert.equal(
      cutsThroughMarkup(source, 0, source.length),
      false,
      'the end of the file is an edge of the document, not a cut'
    );
  });

  it('is symmetric: the order of the two offsets does not matter', () => {
    assert.equal(cutsThroughMarkup(ROW, 53, 24), cutsThroughMarkup(ROW, 24, 53));
  });

  it('accepts an empty document and a zero-length span', () => {
    assert.equal(cutsThroughMarkup('', 0, 0), false);
    assert.equal(cutsThroughMarkup('<p>a</p>', 3, 3), false);
  });
});
