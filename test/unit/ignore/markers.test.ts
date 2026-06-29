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

describe('ignore/markers — detectFileIgnore (whole-file)', () => {
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

describe('ignore/markers — protected regions (multi-language)', () => {
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

describe('ignore/markers — best-effort node markers', () => {
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

describe('ignore/markers — no markers / edge cases', () => {
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
