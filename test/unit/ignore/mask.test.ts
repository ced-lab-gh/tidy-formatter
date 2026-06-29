// Unit tests for the PURE protect-and-restore region mask (Axe 4.T2).
//
// PURE (no 'vscode', no engine): masks the protected ranges scanMarkers returns,
// then restores the verbatim originals after a (simulated) format. Proves:
//   - a round-trip with no formatting yields the exact original bytes;
//   - masking is byte-stable for the protected spans regardless of reflow;
//   - a placeholder collision in the input refuses to mask (undefined);
//   - a restore whose placeholder was dropped/duplicated by the engine fails
//     (undefined) so the caller leaves the file intact;
//   - malformed / overlapping / out-of-bounds ranges refuse to mask.
import assert from 'node:assert/strict';
import { applyMask, restoreMask } from '../../../src/ignore/mask';
import { scanMarkers } from '../../../src/ignore/markers';
import type { ProtectedRange } from '../../../src/ignore/markers';

/** Convenience: mask using the ranges scanMarkers finds for a real snippet. */
function maskFromMarkers(input: string, lang: Parameters<typeof scanMarkers>[1]) {
  const scan = scanMarkers(input, lang);
  return { scan, mask: applyMask(input, scan.protectedRanges) };
}

describe('ignore/mask — applyMask + restoreMask (pure round-trip)', () => {
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
    // masker would use for index 0 — masking must back off rather than risk it.
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
