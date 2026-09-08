// Adversarial suite for the LAST CHECK BEFORE ANY WRITE in "Tidy: Preview
// format": evaluateApplyGate. PURE (no 'vscode'), so it runs under plain
// mocha + tsx.
//
// THE MOAT HOLE THIS LOCKS SHUT: the diff pane is read-only, but the ORIGINAL
// document is not. "Apply" used to write text that the guard had proved
// equivalent to the buffer AS IT WAS when the preview was computed, over a range
// recomputed from the CURRENT document, with no version check at all. A user who
// kept typing while the read-only diff was open therefore had their edits
// overwritten by content the guard never compared against the buffer being
// written. That directly contradicts Tidy's core promise: output is only ever
// written once it is PROVEN equivalent to the input it replaces.
//
// The gate re-checks (version, text) at the very last moment. A refusal means
// ZERO edits: no partial write, no best effort.
import assert from 'node:assert/strict';
import {
  evaluateApplyGate,
  STALE_PREVIEW_MESSAGE,
  type PreviewApplyGateInput
} from '../../../src/commands/previewFormat';

const ORIGINAL = 'a{color:red}\n';

/** A document that has not moved at all since the preview was computed. */
const UNCHANGED: PreviewApplyGateInput = {
  previewVersion: 7,
  currentVersion: 7,
  previewInput: ORIGINAL,
  currentText: ORIGINAL
};

describe('commands/previewFormat : evaluateApplyGate accepts only an untouched buffer', () => {
  it('allows the write when both the version and the text are unchanged', () => {
    assert.deepEqual(evaluateApplyGate(UNCHANGED), { ok: true });
  });

  it('allows the write when the host reports no version at all', () => {
    // Some hosts (and our own defensive reader) surface undefined. Then the
    // byte comparison alone decides, and it is sufficient on its own.
    assert.deepEqual(
      evaluateApplyGate({
        ...UNCHANGED,
        previewVersion: undefined,
        currentVersion: undefined
      }),
      { ok: true }
    );
  });
});

describe('commands/previewFormat : evaluateApplyGate refuses a stale preview', () => {
  it('refuses when the user edited the buffer while the diff was open', () => {
    const verdict = evaluateApplyGate({
      previewVersion: 7,
      currentVersion: 8,
      previewInput: ORIGINAL,
      currentText: 'a{color:red}\nb{color:blue}\n'
    });
    assert.equal(verdict.ok, false);
    assert.equal(
      (verdict as { reason: string }).reason,
      STALE_PREVIEW_MESSAGE,
      'the user must be told, in plain English, to preview again'
    );
  });

  it('refuses on a version bump even when the text looks identical', () => {
    // Type-then-undo lands back on the same text with a higher version. VS Code
    // is authoritative about "this document changed", so we do not second-guess
    // it: refusing costs one re-run, applying could cost the user their work.
    const verdict = evaluateApplyGate({ ...UNCHANGED, currentVersion: 9 });
    assert.equal(verdict.ok, false);
    assert.equal((verdict as { reason: string }).reason, STALE_PREVIEW_MESSAGE);
  });

  it('refuses on a text change even when the version looks identical', () => {
    // Belt and braces: a host that fails to bump its counter must not be able to
    // get unverified text written.
    const verdict = evaluateApplyGate({
      ...UNCHANGED,
      currentText: 'a{color:GREEN}\n'
    });
    assert.equal(verdict.ok, false);
    assert.equal((verdict as { reason: string }).reason, STALE_PREVIEW_MESSAGE);
  });

  it('refuses on a whitespace-only change (byte comparison, not a fuzzy one)', () => {
    const verdict = evaluateApplyGate({
      ...UNCHANGED,
      currentVersion: 8,
      currentText: ORIGINAL + '\n'
    });
    assert.equal(verdict.ok, false);
  });

  it('refuses when the document was emptied under the preview', () => {
    const verdict = evaluateApplyGate({
      ...UNCHANGED,
      currentVersion: 12,
      currentText: ''
    });
    assert.equal(verdict.ok, false);
  });

  it('refuses when only one side reports a version (a mismatch is a mismatch)', () => {
    assert.equal(
      evaluateApplyGate({ ...UNCHANGED, currentVersion: undefined }).ok,
      false
    );
    assert.equal(
      evaluateApplyGate({ ...UNCHANGED, previewVersion: undefined }).ok,
      false
    );
  });

  it('gives exactly one refusal reason, never a partial-write hint', () => {
    const verdict = evaluateApplyGate({
      previewVersion: 1,
      currentVersion: 2,
      previewInput: ORIGINAL,
      currentText: 'x'
    });
    assert.equal(verdict.ok, false);
    const reason = (verdict as { reason: string }).reason;
    assert.match(reason, /nothing was applied/i);
    assert.doesNotMatch(reason, /partial|partially|some of/i);
  });
});

describe('commands/previewFormat : evaluateApplyGate is pure', () => {
  it('never mutates a frozen input and is deterministic', () => {
    const frozen = Object.freeze({ ...UNCHANGED, currentVersion: 8 });
    const first = evaluateApplyGate(frozen);
    const second = evaluateApplyGate(frozen);
    assert.deepEqual(first, second);
    assert.equal(frozen.currentVersion, 8);
    assert.equal(frozen.previewInput, ORIGINAL);
  });
});

describe('commands/previewFormat : STALE_PREVIEW_MESSAGE is a shippable English string', () => {
  it('is English, actionable, and names Tidy', () => {
    assert.match(STALE_PREVIEW_MESSAGE, /^Tidy: /);
    assert.match(STALE_PREVIEW_MESSAGE, /changed while the preview was open/i);
    assert.match(STALE_PREVIEW_MESSAGE, /run the preview again/i);
  });

  it('states plainly that nothing was written', () => {
    assert.match(STALE_PREVIEW_MESSAGE, /nothing was applied/i);
  });

  it('contains no em dash (U+2014) and no non-ASCII character', () => {
    assert.ok(!STALE_PREVIEW_MESSAGE.includes('\u2014'), 'em dash present');
    assert.match(STALE_PREVIEW_MESSAGE, /^[\x20-\x7E]*$/);
  });
});
