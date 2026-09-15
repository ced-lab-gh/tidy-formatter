// Unit tests for the pure in-source marker scanner (Axe 4.T1).
//
// Covers: (a) file-level ignore (tidy-ignore-file / tidy-ignore / prettier-ignore
// at the head), (b) protected regions between tidy-ignore-start/end across
// languages, and (c) best-effort node markers. All assertions verify that the
// reported ranges cover EXACTLY the intended bytes so the provider can splice
// them back verbatim.
import assert from 'node:assert/strict';
import {
  scanMarkers,
  detectFileIgnore,
  type ProtectedRange
} from '../../../src/ignore/markers';

/** Extract the verbatim slices a scan would protect, for readable assertions. */
function slices(text: string, ranges: readonly ProtectedRange[]): string[] {
  return ranges.map((range) => text.slice(range.start, range.end));
}

describe('ignore/markers : detectFileIgnore (whole-file)', () => {
  it('honours a leading // tidy-ignore-file in JS', () => {
    assert.equal(detectFileIgnore('// tidy-ignore-file\nconst a=1\n', 'javascript'), true);
  });

  it('honours a leading // tidy-ignore in TS', () => {
    assert.equal(detectFileIgnore('// tidy-ignore\nconst a:number=1\n', 'typescript'), true);
  });

  it('honours a leading // prettier-ignore for parity', () => {
    assert.equal(detectFileIgnore('// prettier-ignore\nconst a=1\n', 'javascript'), true);
  });

  it('honours a leading /* ... */ block comment in CSS', () => {
    assert.equal(detectFileIgnore('/* tidy-ignore-file */\n.a{color:red}\n', 'css'), true);
  });

  it('honours a leading <!-- ... --> comment in HTML', () => {
    assert.equal(detectFileIgnore('<!-- tidy-ignore-file -->\n<div></div>\n', 'html'), true);
  });

  it('skips a shebang and a BOM before the head comment', () => {
    assert.equal(detectFileIgnore('#!/usr/bin/env node\n// tidy-ignore\nx()\n', 'javascript'), true);
    assert.equal(detectFileIgnore('﻿// tidy-ignore\nx()\n', 'javascript'), true);
  });

  it('does NOT ignore when the keyword is not in the head comment', () => {
    assert.equal(detectFileIgnore('const a=1 // tidy-ignore\n', 'javascript'), false);
    assert.equal(detectFileIgnore('const a=1\n// tidy-ignore-file later\n', 'javascript'), false);
  });

  it('does NOT ignore a file that does not start with a comment', () => {
    assert.equal(detectFileIgnore('const tidyIgnoreFile=1\n', 'javascript'), false);
  });

  it('scanMarkers reports ignoreFile and no ranges for a head file-ignore', () => {
    const scan = scanMarkers('// tidy-ignore-file\nconst a=1\n', 'javascript');
    assert.equal(scan.ignoreFile, true);
    assert.equal(scan.protectedRanges.length, 0);
  });
});

describe('ignore/markers : protected regions (multi-language)', () => {
  it('protects a region between // tidy-ignore-start and // tidy-ignore-end (JS)', () => {
    const text = [
      'const before = 1;',
      '// tidy-ignore-start',
      'const   weird   =    2;',
      '// tidy-ignore-end',
      'const after = 3;'
    ].join('\n');
    const scan = scanMarkers(text, 'javascript');
    assert.equal(scan.ignoreFile, false);
    assert.equal(scan.protectedRanges.length, 1);
    const [protectedText] = slices(text, scan.protectedRanges);
    assert.match(protectedText, /tidy-ignore-start/);
    assert.match(protectedText, /const {3}weird {3}= {4}2;/);
    assert.match(protectedText, /tidy-ignore-end/);
    // The lines outside the region are NOT included.
    assert.ok(!protectedText.includes('const before'));
    assert.ok(!protectedText.includes('const after'));
  });

  it('protects a region in CSS using block comments', () => {
    const text = [
      '.a { color: red }',
      '/* tidy-ignore-start */',
      '.b{color:   blue}',
      '/* tidy-ignore-end */',
      '.c { color: green }'
    ].join('\n');
    const scan = scanMarkers(text, 'css');
    assert.equal(scan.protectedRanges.length, 1);
    const [protectedText] = slices(text, scan.protectedRanges);
    assert.match(protectedText, /\.b\{color: {3}blue\}/);
    assert.ok(!protectedText.includes('.a {'));
    assert.ok(!protectedText.includes('.c {'));
  });

  it('protects a region in HTML using SGML comments', () => {
    const text = [
      '<header></header>',
      '<!-- tidy-ignore-start -->',
      '<pre>   keep   this   </pre>',
      '<!-- tidy-ignore-end -->',
      '<footer></footer>'
    ].join('\n');
    const scan = scanMarkers(text, 'html');
    assert.equal(scan.protectedRanges.length, 1);
    const [protectedText] = slices(text, scan.protectedRanges);
    assert.match(protectedText, /keep {3}this/);
    assert.ok(!protectedText.includes('<header>'));
    assert.ok(!protectedText.includes('<footer>'));
  });

  it('an unterminated start protects to end-of-file (conservative)', () => {
    const text = 'a();\n// tidy-ignore-start\nb();\nc();';
    const scan = scanMarkers(text, 'javascript');
    assert.equal(scan.protectedRanges.length, 1);
    const [protectedText] = slices(text, scan.protectedRanges);
    assert.match(protectedText, /tidy-ignore-start[\s\S]*b\(\);[\s\S]*c\(\);$/);
    assert.ok(!protectedText.startsWith('a();'));
  });

  it('does not treat a marker inside a JS string as a comment', () => {
    const text = 'const s = "// tidy-ignore-start";\nconst t = 2;\n';
    const scan = scanMarkers(text, 'javascript');
    assert.equal(scan.protectedRanges.length, 0);
  });

  it('a head region-start is a region, NOT a whole-file ignore', () => {
    // "tidy-ignore-start" contains "tidy-ignore" but must not trip file-ignore.
    const text = ['// tidy-ignore-start', 'const a = 1;', '// tidy-ignore-end', 'const b = 2;'].join(
      '\n'
    );
    assert.equal(detectFileIgnore(text, 'javascript'), false);
    const scan = scanMarkers(text, 'javascript');
    assert.equal(scan.ignoreFile, false);
    assert.equal(scan.protectedRanges.length, 1);
    const [protectedText] = slices(text, scan.protectedRanges);
    assert.ok(!protectedText.includes('const b = 2;'));
  });
});

describe('ignore/markers : best-effort node markers', () => {
  it('protects the node line following a lone // tidy-ignore (JS)', () => {
    const text = ['const a = 1;', '// tidy-ignore', 'const   b   =   2;', 'const c = 3;'].join('\n');
    const scan = scanMarkers(text, 'javascript');
    assert.equal(scan.protectedRanges.length, 1);
    const [protectedText] = slices(text, scan.protectedRanges);
    assert.match(protectedText, /tidy-ignore/);
    assert.match(protectedText, /const {3}b {3}= {3}2;/);
    assert.ok(!protectedText.includes('const c = 3;'));
    assert.equal(scan.protectedRanges[0].kind, 'node');
  });

  it('recognises a // prettier-ignore node marker', () => {
    const text = ['// prettier-ignore', 'const matrix = [1,0,0];', 'const x = 1;'].join('\n');
    const scan = scanMarkers(text, 'javascript');
    // The head comment is a file-ignore keyword candidate; prettier-ignore at the
    // very top means whole-file (parity with Prettier), so assert that branch.
    assert.equal(scan.ignoreFile, true);
  });

  it('a non-head prettier-ignore protects only the next node', () => {
    const text = ['const x = 1;', '// prettier-ignore', 'const matrix = [1,0,0];', 'const y = 2;'].join(
      '\n'
    );
    const scan = scanMarkers(text, 'javascript');
    assert.equal(scan.ignoreFile, false);
    assert.equal(scan.protectedRanges.length, 1);
    const [protectedText] = slices(text, scan.protectedRanges);
    assert.match(protectedText, /const matrix = \[1,0,0\];/);
    assert.ok(!protectedText.includes('const y = 2;'));
  });

  it('skips blank lines to find the node after a node marker', () => {
    const text = ['x();', '// tidy-ignore', '', '', 'const   wide = 1;', 'y();'].join('\n');
    const scan = scanMarkers(text, 'javascript');
    assert.equal(scan.protectedRanges.length, 1);
    const [protectedText] = slices(text, scan.protectedRanges);
    assert.match(protectedText, /const {3}wide = 1;/);
    assert.ok(!protectedText.includes('y();'));
  });

  it('a trailing node marker with no following node protects its own line', () => {
    const text = 'const a = 1;\n// tidy-ignore';
    const scan = scanMarkers(text, 'javascript');
    assert.equal(scan.protectedRanges.length, 1);
    const [protectedText] = slices(text, scan.protectedRanges);
    assert.equal(protectedText, '// tidy-ignore');
  });
});

describe('ignore/markers : no markers / edge cases', () => {
  it('returns no ranges and no file-ignore for plain code', () => {
    const scan = scanMarkers('const a = 1;\nconst b = 2;\n', 'javascript');
    assert.equal(scan.ignoreFile, false);
    assert.equal(scan.protectedRanges.length, 0);
  });

  it('returns empty for empty input without throwing', () => {
    const scan = scanMarkers('', 'css');
    assert.equal(scan.ignoreFile, false);
    assert.equal(scan.protectedRanges.length, 0);
  });

  it('merges overlapping region + node protections into a non-overlapping set', () => {
    // A node marker, then a separate region: the resulting spans stay sorted and
    // non-overlapping. The leading real line keeps the node marker off the head.
    const text = [
      'header();',
      '// tidy-ignore',
      'const a = 1;',
      'gap();',
      '// tidy-ignore-start',
      'const b = 2;',
      '// tidy-ignore-end'
    ].join('\n');
    const scan = scanMarkers(text, 'javascript');
    assert.ok(scan.protectedRanges.length >= 1);
    // Ranges must be sorted and non-overlapping.
    for (let i = 1; i < scan.protectedRanges.length; i += 1) {
      assert.ok(scan.protectedRanges[i].start > scan.protectedRanges[i - 1].end);
    }
  });

  it('a node marker whose node lies inside a region merges into one region span', () => {
    // The node marker's coarse span overlaps the following region; the merged
    // result is a single range labelled "region" (region dominates node). The
    // first line is real code so the node marker is NOT a head file-ignore.
    const text = [
      'header();',
      '// tidy-ignore',
      '// tidy-ignore-start',
      'const a = 1;',
      '// tidy-ignore-end'
    ].join('\n');
    const scan = scanMarkers(text, 'javascript');
    assert.equal(scan.protectedRanges.length, 1);
    assert.equal(scan.protectedRanges[0].kind, 'region');
    const [protectedText] = slices(text, scan.protectedRanges);
    assert.match(protectedText, /tidy-ignore-start[\s\S]*const a = 1;[\s\S]*tidy-ignore-end/);
    assert.ok(!protectedText.includes('header();'));
  });

  it('keeps two separate regions as two distinct ranges', () => {
    const text = [
      '// tidy-ignore-start',
      'a();',
      '// tidy-ignore-end',
      'gap();',
      'gap2();',
      '// tidy-ignore-start',
      'b();',
      '// tidy-ignore-end'
    ].join('\n');
    const scan = scanMarkers(text, 'javascript');
    assert.equal(scan.protectedRanges.length, 2);
    assert.ok(scan.protectedRanges[1].start > scan.protectedRanges[0].end);
    const [first, second] = slices(text, scan.protectedRanges);
    assert.match(first, /a\(\);/);
    assert.match(second, /b\(\);/);
    assert.ok(!first.includes('gap'));
  });
});

/* -------------------------------------------------------------------------- */
/* v0.4.1 M3-4 : quoting is POSITIONAL in markup                               */
/* -------------------------------------------------------------------------- */

describe('ignore/markers : quotes never swallow the marker scan (M3-4)', () => {
  /** The same document, with `text` dropped into its first paragraph. */
  function htmlWith(text: string): string {
    return [
      '<div>',
      `  <p>${text}</p>`,
      '  <!-- tidy-ignore-start -->',
      '      <pre>KEEP  ME</pre>',
      '  <!-- tidy-ignore-end -->',
      '</div>'
    ].join('\n');
  }

  // Every apostrophe count from 0 to 5: parity must not decide protection.
  // Before the fix, an ODD count left protectedRanges EMPTY and the provider
  // had nothing to protect AND nothing to report.
  for (let count = 0; count <= 5; count += 1) {
    it(`protects the region with ${count} apostrophe(s) in the HTML text`, () => {
      const html = htmlWith(`it${"'".repeat(count)}s fine`);
      const scan = scanMarkers(html, 'html');
      assert.equal(
        scan.protectedRanges.length,
        1,
        `an apostrophe in character data is a letter, not a delimiter (count=${count})`
      );
      const [protectedText] = slices(html, scan.protectedRanges);
      assert.match(protectedText, /tidy-ignore-start[\s\S]*KEEP {2}ME[\s\S]*tidy-ignore-end/);
    });
  }

  it('a double quote in HTML text is a character too, at any count', () => {
    for (const text of ['he said "hi', 'he said "hi"', 'a " b " c "']) {
      assert.equal(
        scanMarkers(htmlWith(text), 'html').protectedRanges.length,
        1,
        `unbalanced double quotes must not hide the markers: ${text}`
      );
    }
  });

  it('the marker line itself is reported, not an earlier one', () => {
    const html = htmlWith("don't");
    const scan = scanMarkers(html, 'html');
    const [range] = scan.protectedRanges;
    assert.equal(
      html.slice(range.start, html.indexOf('\n', range.start)),
      '  <!-- tidy-ignore-start -->',
      'the region must open at the START of the marker line, indentation included'
    );
  });

  it('a quoted ATTRIBUTE value still hides what it contains', () => {
    const html = [
      '<div>',
      "  <a href='/x' title='a <!-- tidy-ignore-start --> b'>link</a>",
      '  <p>plain</p>',
      '</div>'
    ].join('\n');
    assert.equal(
      scanMarkers(html, 'html').protectedRanges.length,
      0,
      'a marker inside an attribute value is not a comment'
    );
  });

  it('an attribute value may span lines without losing the markers below it', () => {
    const html = [
      '<div',
      '  title="first',
      '         second">',
      '  <!-- tidy-ignore-start -->',
      '      <pre>KEEP</pre>',
      '  <!-- tidy-ignore-end -->',
      '</div>'
    ].join('\n');
    const scan = scanMarkers(html, 'html');
    assert.equal(scan.protectedRanges.length, 1);
    const [protectedText] = slices(html, scan.protectedRanges);
    assert.match(protectedText, /tidy-ignore-start[\s\S]*KEEP[\s\S]*tidy-ignore-end/);
  });

  it('inside <script> the JS quoting rules DO apply', () => {
    const html = [
      '<div>',
      '  <script>',
      "    var s = 'a <!-- tidy-ignore-start --> b';",
      '  </script>',
      '  <p>x</p>',
      '</div>'
    ].join('\n');
    assert.equal(
      scanMarkers(html, 'html').protectedRanges.length,
      0,
      'a marker inside a JS string literal is not a comment'
    );
  });

  it('inside <style> the CSS quoting rules DO apply', () => {
    const html = [
      '<div>',
      '  <style>',
      '    .a { content: "<!-- tidy-ignore-start -->"; }',
      '  </style>',
      '  <p>x</p>',
      '</div>'
    ].join('\n');
    assert.equal(scanMarkers(html, 'html').protectedRanges.length, 0);
  });

  it('a real marker after a </script> is still found', () => {
    const html = [
      '<div>',
      '  <script>',
      '    var s = "it\'s fine";',
      '  </script>',
      '  <!-- tidy-ignore-start -->',
      '      <pre>KEEP</pre>',
      '  <!-- tidy-ignore-end -->',
      '</div>'
    ].join('\n');
    const scan = scanMarkers(html, 'html');
    assert.equal(scan.protectedRanges.length, 1);
    const [protectedText] = slices(html, scan.protectedRanges);
    assert.match(protectedText, /tidy-ignore-start[\s\S]*KEEP[\s\S]*tidy-ignore-end/);
  });

  it('an apostrophe inside a <script> comment does not hide the markers below', () => {
    const html = [
      '<div>',
      '  <script>',
      "    var a = 1; /* don't worry */",
      '  </script>',
      '  <!-- tidy-ignore-start -->',
      '      <pre>KEEP</pre>',
      '  <!-- tidy-ignore-end -->',
      '</div>'
    ].join('\n');
    assert.equal(scanMarkers(html, 'html').protectedRanges.length, 1);
  });

  it('an apostrophe in text does not turn `a < b` into a tag', () => {
    const html = [
      "<p>don't compare a < b</p>",
      '<!-- tidy-ignore-start -->',
      'KEEP',
      '<!-- tidy-ignore-end -->'
    ].join('\n');
    assert.equal(scanMarkers(html, 'html').protectedRanges.length, 1);
  });

  it('a DOCTYPE with quoted identifiers does not hide the markers', () => {
    const html = [
      '<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01//EN">',
      '<!-- tidy-ignore-start -->',
      'KEEP',
      '<!-- tidy-ignore-end -->'
    ].join('\n');
    assert.equal(scanMarkers(html, 'html').protectedRanges.length, 1);
  });
});

describe('ignore/markers : one stray quote never hides the rest of a file', () => {
  it('CSS: an unterminated quote does not swallow the markers below it', () => {
    const css = [
      '.a { content: "oops; }',
      '/* tidy-ignore-start */',
      '   .keep  {  color : red  }',
      '/* tidy-ignore-end */'
    ].join('\n');
    const scan = scanMarkers(css, 'css');
    assert.equal(scan.protectedRanges.length, 1);
    const [protectedText] = slices(css, scan.protectedRanges);
    assert.match(protectedText, /tidy-ignore-start[\s\S]*\.keep[\s\S]*tidy-ignore-end/);
  });

  it('JS: an unterminated quote does not swallow the markers below it', () => {
    const js = ["const s = 'oops;", '// tidy-ignore-start', 'keep();', '// tidy-ignore-end'].join(
      '\n'
    );
    const scan = scanMarkers(js, 'javascript');
    assert.equal(scan.protectedRanges.length, 1);
    const [protectedText] = slices(js, scan.protectedRanges);
    assert.match(protectedText, /tidy-ignore-start[\s\S]*keep\(\);[\s\S]*tidy-ignore-end/);
  });

  it('JS: a TERMINATED string still hides a marker inside it', () => {
    const js = ["const s = '// tidy-ignore-start';", 'const t = 2;'].join('\n');
    assert.equal(scanMarkers(js, 'javascript').protectedRanges.length, 0);
  });

  it('JS: a multi-line template literal hides its contents but not what follows', () => {
    const js = [
      'const s = `line one',
      '// tidy-ignore-start',
      'line three`;',
      '// tidy-ignore-start',
      'keep();',
      '// tidy-ignore-end'
    ].join('\n');
    const scan = scanMarkers(js, 'javascript');
    assert.equal(scan.protectedRanges.length, 1);
    const [protectedText] = slices(js, scan.protectedRanges);
    assert.ok(
      protectedText.startsWith('// tidy-ignore-start\nkeep();'),
      `the region must open on the REAL marker line, got ${JSON.stringify(protectedText)}`
    );
  });

  it('JSON: an apostrophe cannot open a string there', () => {
    const json = [
      '{',
      "  // it's a comment",
      '  // tidy-ignore-start',
      '  "a": 1,',
      '  // tidy-ignore-end',
      '  "b": 2',
      '}'
    ].join('\n');
    const scan = scanMarkers(json, 'json');
    assert.equal(scan.protectedRanges.length, 1);
    const [protectedText] = slices(json, scan.protectedRanges);
    assert.match(protectedText, /tidy-ignore-start[\s\S]*"a": 1,[\s\S]*tidy-ignore-end/);
  });

  it('CSS: a backtick is not a string delimiter', () => {
    const css = [
      '.a { content: "x`y"; }',
      '/* tidy-ignore-start */',
      '.keep {}',
      '/* tidy-ignore-end */'
    ].join('\n');
    assert.equal(scanMarkers(css, 'css').protectedRanges.length, 1);
  });
});
