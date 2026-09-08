// Unit tests for the PURE protect-and-restore region mask (Axe 4.T2).
//
// PURE (no 'vscode', no engine): masks the protected ranges scanMarkers returns,
// then restores the verbatim originals after a (simulated) format. Proves:
//   - a round-trip with no formatting yields the exact original bytes;
//   - masking is byte-stable for the protected spans regardless of reflow;
//   - a placeholder collision in the input refuses to mask (undefined);
//   - a restore whose placeholder was dropped/duplicated by the engine fails
//     (undefined) so the caller leaves the file intact;
//   - malformed / overlapping / out-of-bounds ranges refuse to mask;
//   - the restore re-establishes the span's LINE STRUCTURE (second describe
//     block), which is what makes formatting a document with markers idempotent.
import assert from 'node:assert/strict';
import { applyMask, restoreMask } from '../../../src/ignore/mask';
import { scanMarkers } from '../../../src/ignore/markers';
import type { ProtectedRange } from '../../../src/ignore/markers';

/** Convenience: mask using the ranges scanMarkers finds for a real snippet. */
function maskFromMarkers(input: string, lang: Parameters<typeof scanMarkers>[1]) {
  const scan = scanMarkers(input, lang);
  return { scan, mask: applyMask(input, scan.protectedRanges) };
}

describe('ignore/mask : applyMask + restoreMask (pure round-trip)', () => {
  it('round-trips a protected CSS region byte-identically when nothing reflows', () => {
    const input =
      '.a{color:red}\n' +
      '/* tidy-ignore-start */\n' +
      '.RAW   {  color : blue  }\n' +
      '/* tidy-ignore-end */\n' +
      '.b{color:green}\n';
    const { scan, mask } = maskFromMarkers(input, 'css');
    assert.equal(scan.ignoreFile, false);
    assert.equal(scan.protectedRanges.length, 1);
    assert.ok(mask, 'a region should produce a mask');

    // The masked text must NOT contain the raw protected bytes any more.
    assert.ok(!mask!.masked.includes('.RAW   {  color : blue  }'));
    // Restoring the masked text unchanged yields the exact original.
    const restored = restoreMask(mask!.masked, mask!.restorations);
    assert.equal(restored, input);
  });

  it('restores the protected span verbatim even when surrounding text reflows', () => {
    const input =
      'const a=1\n' +
      '// tidy-ignore-start\n' +
      'const   RAW    =    2\n' +
      '// tidy-ignore-end\n' +
      'const b=3\n';
    const { mask } = maskFromMarkers(input, 'javascript');
    assert.ok(mask);

    // Simulate an engine that reflows everything around the placeholder but keeps
    // the placeholder token intact (it is a bare identifier).
    const reflowed = mask!.masked
      .replace('const a=1', 'const a = 1;')
      .replace('const b=3', 'const b = 3;');
    const restored = restoreMask(reflowed, mask!.restorations);
    assert.ok(restored !== undefined);
    assert.ok(restored!.includes('const   RAW    =    2'), 'protected bytes verbatim');
    assert.ok(restored!.includes('const a = 1;'));
    assert.ok(restored!.includes('const b = 3;'));
  });

  it('refuses to mask when a placeholder token already exists in the input (collision)', () => {
    // Craft an input whose protected region happens to also contain the token the
    // masker would use for index 0 : masking must back off rather than risk it.
    const input =
      '.a{color:red}\n' +
      '/* tidy-ignore-start */\n' +
      '.x{content:"__TIDY_IGNORE_PLACEHOLDER_0__"}\n' +
      '/* tidy-ignore-end */\n';
    const scan = scanMarkers(input, 'css');
    assert.equal(scan.protectedRanges.length, 1);
    assert.equal(applyMask(input, scan.protectedRanges), undefined);
  });

  it('returns undefined when there are no ranges to protect', () => {
    assert.equal(applyMask('.a{color:red}\n', []), undefined);
  });

  it('refuses out-of-bounds, empty, or overlapping ranges (defensive)', () => {
    const input = 'abcdef';
    const oob: ProtectedRange[] = [{ start: 0, end: 99, kind: 'region' }];
    const empty: ProtectedRange[] = [{ start: 2, end: 2, kind: 'region' }];
    const overlapping: ProtectedRange[] = [
      { start: 0, end: 4, kind: 'region' },
      { start: 2, end: 6, kind: 'node' }
    ];
    assert.equal(applyMask(input, oob), undefined);
    assert.equal(applyMask(input, empty), undefined);
    assert.equal(applyMask(input, overlapping), undefined);
  });

  it('fails restore (undefined) when the engine dropped a placeholder', () => {
    const input =
      'x\n/* tidy-ignore-start */\nRAW\n/* tidy-ignore-end */\n';
    const { mask } = maskFromMarkers(input, 'css');
    assert.ok(mask);
    // Engine output with the placeholder removed entirely.
    const broken = mask!.masked.replace(mask!.restorations[0].token, '');
    assert.equal(restoreMask(broken, mask!.restorations), undefined);
  });

  it('fails restore (undefined) when the engine duplicated a placeholder', () => {
    const input =
      'x\n/* tidy-ignore-start */\nRAW\n/* tidy-ignore-end */\n';
    const { mask } = maskFromMarkers(input, 'css');
    assert.ok(mask);
    const token = mask!.restorations[0].token;
    const duplicated = `${mask!.masked}\n${token}\n`;
    assert.equal(restoreMask(duplicated, mask!.restorations), undefined);
  });

  it('masks and restores MULTIPLE protected regions in order', () => {
    const input =
      '.a{color:red}\n' +
      '/* tidy-ignore-start */\n' +
      '.R1{x:1}\n' +
      '/* tidy-ignore-end */\n' +
      '.b{color:green}\n' +
      '/* tidy-ignore-start */\n' +
      '.R2{y:2}\n' +
      '/* tidy-ignore-end */\n';
    const { scan, mask } = maskFromMarkers(input, 'css');
    assert.equal(scan.protectedRanges.length, 2);
    assert.ok(mask);
    assert.equal(mask!.restorations.length, 2);
    const restored = restoreMask(mask!.masked, mask!.restorations);
    assert.equal(restored, input);
  });
});

// The engine sees an INLINE token where the input had WHOLE LINES, so it indents
// the token and sometimes swallows the break after it. Splicing the verbatim
// bytes back on top of that produced drift WITHOUT BOUND (HTML gained two spaces
// per format; CSS glued the next selector onto the end-marker line; a CRLF file
// grew one '\r' per format). These tests pin the restore's line-structure
// repair, engine-free: each one hands restoreMask the exact shape a real engine
// produced.
describe('ignore/mask : restoreMask re-establishes the span line structure', () => {
  const cssRegion =
    '.a{color:red}\n' +
    '/* tidy-ignore-start */\n' +
    '.RAW   {  color : blue  }\n' +
    '/* tidy-ignore-end */\n' +
    '.b{color:green}\n';

  it('records the line structure of every masked span', () => {
    const { mask } = maskFromMarkers(cssRegion, 'css');
    assert.ok(mask);
    assert.equal(mask!.restorations[0].startedLine, true);
    assert.equal(mask!.restorations[0].lineBreakAfter, '\n');
  });

  it('drops the indentation the engine added in front of the token (HTML +2/pass)', () => {
    const input =
      '<div>\n' +
      '<!-- tidy-ignore-start -->\n' +
      '<pre>  raw  </pre>\n' +
      '<!-- tidy-ignore-end -->\n' +
      '</div>\n';
    const { mask } = maskFromMarkers(input, 'html');
    assert.ok(mask);
    const token = mask!.restorations[0].token;
    // js-beautify indents the placeholder as a text node inside <div>.
    const formatted = mask!.masked.replace(token, `  ${token}`);
    const restored = restoreMask(formatted, mask!.restorations);
    assert.equal(restored, input, 'the marker must keep its own indentation only');
  });

  it('keeps the ORIGINAL indentation of an indented marker, without stacking', () => {
    const input =
      '<div>\n' +
      '    <!-- tidy-ignore-start -->\n' +
      '    <pre>  raw  </pre>\n' +
      '    <!-- tidy-ignore-end -->\n' +
      '</div>\n';
    const { mask } = maskFromMarkers(input, 'html');
    assert.ok(mask);
    const token = mask!.restorations[0].token;
    const restored = restoreMask(
      mask!.masked.replace(token, `  ${token}`),
      mask!.restorations
    );
    assert.equal(restored, input);
    assert.ok(restored!.includes('\n    <!-- tidy-ignore-start -->\n'));
  });

  it('leaves a non-whitespace prefix alone (that whitespace is a separator)', () => {
    const input = 'const a=1\n// tidy-ignore\nconst   RAW = 2\nconst b=3\n';
    const { mask } = maskFromMarkers(input, 'javascript');
    assert.ok(mask);
    const token = mask!.restorations[0].token;
    // Pathological engine output: something else already sits on the token's
    // line, so the space before it separates two constructs and must survive.
    const formatted = mask!.masked.replace(`\n${token}`, `\n;x = 1; ${token}`);
    const restored = restoreMask(formatted, mask!.restorations);
    assert.ok(restored!.includes(';x = 1; // tidy-ignore'), 'separator kept');
  });

  it('puts back the line break the engine ate after the span (CSS glue defect)', () => {
    const { mask } = maskFromMarkers(cssRegion, 'css');
    assert.ok(mask);
    const token = mask!.restorations[0].token;
    // What js-beautify really prints: `__TOKEN__\n.b {` reads as one descendant
    // selector, so the break becomes a space.
    const formatted = `.a {\n  color: red\n}\n\n${token} .b {\n  color: green\n}`;
    const restored = restoreMask(formatted, mask!.restorations);
    assert.ok(
      restored!.includes('/* tidy-ignore-end */\n.b {'),
      'the next rule must not be glued onto the end-marker line'
    );
    assert.ok(!restored!.includes('*/ .b'));
  });

  it('leaves the engine\'s own blank lines after the span untouched', () => {
    const { mask } = maskFromMarkers(cssRegion, 'css');
    assert.ok(mask);
    const token = mask!.restorations[0].token;
    const formatted = `.a {\n  color: red\n}\n\n${token}\n\n.b {\n  color: green\n}`;
    const restored = restoreMask(formatted, mask!.restorations);
    assert.ok(restored!.includes('/* tidy-ignore-end */\n\n.b {'), 'blank line kept');
  });

  it('consumes the CR the engine duplicates on a CRLF span (one \\r per pass)', () => {
    const input =
      '.a{color:red}\r\n' +
      '/* tidy-ignore-start */\r\n' +
      '.RAW{color:blue}\r\n' +
      '/* tidy-ignore-end */\r\n' +
      '.b{color:green}\r\n';
    const { mask } = maskFromMarkers(input, 'css');
    assert.ok(mask);
    // scanMarkers closes the region at the '\n', so the '\r' is inside the span.
    assert.ok(mask!.restorations[0].original.endsWith('\r'));
    const token = mask!.restorations[0].token;
    // js-beautify normalises the document to CRLF, so it prints its own '\r'.
    const formatted = mask!.masked.replace(`${token}\n`, `${token}\r\n`);
    const restored = restoreMask(formatted, mask!.restorations);
    assert.equal(restored, input);
    assert.ok(!restored!.includes('\r\r'), 'no CR may accumulate');
  });

  it('does not add a line break when the token ends the formatted output', () => {
    const input = '.a{color:red}\n/* tidy-ignore-start */\n.RAW{x:1}\n/* tidy-ignore-end */\n';
    const { mask } = maskFromMarkers(input, 'css');
    assert.ok(mask);
    const token = mask!.restorations[0].token;
    const formatted = `.a {\n  color: red\n}\n\n${token}`;
    const restored = restoreMask(formatted, mask!.restorations);
    assert.ok(restored!.endsWith('/* tidy-ignore-end */'), 'tail left as the engine printed it');
  });

  it('repairs every span independently when several regions are masked', () => {
    const input =
      '/* tidy-ignore-start */\n.R1{x:1}\n/* tidy-ignore-end */\n' +
      '.a{color:red}\n' +
      '/* tidy-ignore-start */\n.R2{y:2}\n/* tidy-ignore-end */\n' +
      '.b{color:green}\n';
    const { mask } = maskFromMarkers(input, 'css');
    assert.ok(mask);
    assert.equal(mask!.restorations.length, 2);
    const [first, second] = mask!.restorations;
    // First span: engine indented it. Second span: engine ate its trailing break.
    const formatted = mask!.masked
      .replace(first.token, `   ${first.token}`)
      .replace(`${second.token}\n.b`, `${second.token} .b`);
    const restored = restoreMask(formatted, mask!.restorations);
    assert.equal(restored, input);
  });
});
