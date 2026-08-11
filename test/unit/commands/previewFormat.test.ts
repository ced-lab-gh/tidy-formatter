// Unit tests for the PURE planner of the "Preview format" command
// (Axe 4 / 4.T6). These tests import ONLY the pure decision function and its
// constants : never the VS Code handler : so they run under plain mocha+tsx with
// no Electron host. The module is written with no top-level 'vscode' import, so
// this import does not pull in 'vscode'; a regression that re-introduces a
// top-level 'vscode' import would make this very file fail to load (which is the
// point: the planner must stay host-free).
//
// What we prove (the diff/apply UI lives in the handler + integration suite;
// here we lock the decisions the handler relies on):
//   - guard rejection (non-equivalent) => canApply:false, reason surfaces the
//     "would have broken the syntax" message AND the guard's own detail;
//   - guard rejection with no detail => canApply:false, stable fallback reason;
//   - guard-approved but byte-identical => canApply:false, "already formatted";
//   - guard-approved AND changed => canApply:true, no reason;
//   - the planner is pure (deterministic, no mutation, no side effects).
import assert from 'node:assert/strict';
import {
  buildPreviewPlan,
  PREVIEW_FORMAT_COMMAND_ID,
  PREVIEW_SCHEME,
  APPLY_BUTTON_LABEL,
  GUARD_REJECTED_REASON,
  NO_CHANGE_REASON,
  type PreviewPlan
} from '../../../src/commands/previewFormat';
import type { GuardVerdict } from '../../../src/types';

const EQUIVALENT: GuardVerdict = { equivalent: true };
function rejected(reason?: string): GuardVerdict {
  return { equivalent: false, reason };
}

describe('commands/previewFormat : constants', () => {
  it('exposes the stable command id', () => {
    assert.equal(PREVIEW_FORMAT_COMMAND_ID, 'tidy.previewFormat');
  });

  it('exposes the read-only preview scheme', () => {
    assert.equal(PREVIEW_SCHEME, 'tidy-preview');
  });

  it('exposes the explicit apply-button label', () => {
    assert.equal(APPLY_BUTTON_LABEL, 'Apply');
  });
});

// Audit #16 (v0.3.0 string migration): every user-facing string this module can
// surface must be English. These constants are the only ones the pure planner
// emits; the handler's own toasts are covered by the source scan in
// test/unit/commands/englishStrings.test.ts.
describe('commands/previewFormat : user-facing strings are English', () => {
  const FRENCH_TOKENS =
    /\b(aucun|aucune|apercu|le document|deja|formate|casse|la sortie|impossible|ouvrez|pris en charge)\b/i;

  it('GUARD_REJECTED_REASON is English and mentions the equivalence failure', () => {
    assert.doesNotMatch(GUARD_REJECTED_REASON, FRENCH_TOKENS);
    assert.match(GUARD_REJECTED_REASON, /no change applied/i);
    assert.match(GUARD_REJECTED_REASON, /equivalent/i);
  });

  it('NO_CHANGE_REASON is English and says the document is already formatted', () => {
    assert.doesNotMatch(NO_CHANGE_REASON, FRENCH_TOKENS);
    assert.match(NO_CHANGE_REASON, /already formatted/i);
  });

  it('no user-facing constant contains an em dash or a non-ASCII character', () => {
    for (const text of [GUARD_REJECTED_REASON, NO_CHANGE_REASON, APPLY_BUTTON_LABEL]) {
      assert.ok(!text.includes('\u2014'), `em dash in: ${text}`);
      // Accented characters are the tell-tale of a leftover French string.
      assert.match(text, /^[\x20-\x7E]*$/, `non-ASCII character in: ${text}`);
    }
  });

  it('a composed rejection reason stays English end to end', () => {
    const plan = buildPreviewPlan('a', 'b', rejected('AST structure changed after formatting'));
    assert.doesNotMatch(plan.reason as string, FRENCH_TOKENS);
  });
});

describe('commands/previewFormat : buildPreviewPlan guard rejection', () => {
  it('non-equivalent verdict => canApply:false with the broken-syntax message', () => {
    const plan = buildPreviewPlan('a', 'b', rejected('AST structure changed after formatting'));
    assert.equal(plan.canApply, false);
    assert.ok(plan.reason);
    // The stable user-facing prefix is always present...
    assert.ok(
      (plan.reason as string).includes(GUARD_REJECTED_REASON),
      'reason must surface the broken-syntax message'
    );
    // ...and the guard's specific detail is appended for traceability.
    assert.ok(
      (plan.reason as string).includes('AST structure changed after formatting'),
      'reason must surface the guard detail'
    );
  });

  it('rejection always trumps a no-change input (guard is authoritative first)', () => {
    // Even if formatted === input, a non-equivalent verdict must reject. This can
    // never happen via guard.check (identical input short-circuits to equivalent),
    // but the planner must not depend on that invariant to stay safe.
    const plan = buildPreviewPlan('same', 'same', rejected('formatted output did not parse'));
    assert.equal(plan.canApply, false);
    assert.ok((plan.reason as string).includes(GUARD_REJECTED_REASON));
    assert.ok((plan.reason as string).includes('formatted output did not parse'));
  });

  it('rejection with NO detail => stable fallback reason, no trailing separator', () => {
    const plan = buildPreviewPlan('a', 'b', rejected());
    assert.equal(plan.canApply, false);
    assert.equal(plan.reason, GUARD_REJECTED_REASON);
  });

  it('rejection with a whitespace-only detail => stable fallback reason', () => {
    const plan = buildPreviewPlan('a', 'b', rejected('   '));
    assert.equal(plan.canApply, false);
    assert.equal(plan.reason, GUARD_REJECTED_REASON);
  });
});

describe('commands/previewFormat : buildPreviewPlan no-change', () => {
  it('equivalent verdict but byte-identical output => canApply:false, already-formatted', () => {
    const text = 'div { color: red; }\n';
    const plan = buildPreviewPlan(text, text, EQUIVALENT);
    assert.equal(plan.canApply, false);
    assert.equal(plan.reason, NO_CHANGE_REASON);
  });

  it('treats an empty document with no change as a no-op', () => {
    const plan = buildPreviewPlan('', '', EQUIVALENT);
    assert.equal(plan.canApply, false);
    assert.equal(plan.reason, NO_CHANGE_REASON);
  });
});

describe('commands/previewFormat : buildPreviewPlan applicable', () => {
  it('equivalent verdict AND a real change => canApply:true, no reason', () => {
    const plan = buildPreviewPlan('div{color:red}', 'div {\n  color: red;\n}\n', EQUIVALENT);
    assert.equal(plan.canApply, true);
    assert.equal(plan.reason, undefined);
  });

  it('a single trailing-newline difference still counts as a change', () => {
    const plan = buildPreviewPlan('x', 'x\n', EQUIVALENT);
    assert.equal(plan.canApply, true);
    assert.equal(plan.reason, undefined);
  });
});

describe('commands/previewFormat : buildPreviewPlan is pure', () => {
  it('is deterministic for the same inputs', () => {
    const a = buildPreviewPlan('a', 'b', EQUIVALENT);
    const b = buildPreviewPlan('a', 'b', EQUIVALENT);
    assert.deepEqual(a, b);
  });

  it('never mutates the verdict it is given', () => {
    const verdict = Object.freeze(rejected('AST structure changed after formatting'));
    // A frozen object throws on any in-place mutation attempt.
    const plan = buildPreviewPlan('a', 'b', verdict as GuardVerdict);
    assert.equal(plan.canApply, false);
    assert.equal(verdict.equivalent, false);
    assert.equal(verdict.reason, 'AST structure changed after formatting');
  });

  it('returns only the documented PreviewPlan shape', () => {
    const plans: PreviewPlan[] = [
      buildPreviewPlan('a', 'b', EQUIVALENT),
      buildPreviewPlan('a', 'a', EQUIVALENT),
      buildPreviewPlan('a', 'b', rejected('x'))
    ];
    for (const plan of plans) {
      assert.equal(typeof plan.canApply, 'boolean');
      if (plan.canApply) {
        assert.equal(plan.reason, undefined);
      } else {
        assert.equal(typeof plan.reason, 'string');
      }
    }
  });
});
