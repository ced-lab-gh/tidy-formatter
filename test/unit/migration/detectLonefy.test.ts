// Unit tests for the PURE migration-prompt predicate (Axe 1 / 1.T4).
//
// PURE (no 'vscode'): we import only `shouldPromptMigration` and the constants.
// The `isLonefyInstalled` wrapper loads 'vscode' lazily INSIDE its body, so this
// import does not pull in 'vscode' at module load — a regression that hoisted a
// top-level 'vscode' import would make this file fail to load (the point).
//
// Coverage focus — the one-shot dedup contract (anti-nag, SPEC §10):
//   - prompt only when lonefy present AND not yet prompted;
//   - never prompt when already prompted (dedup), regardless of presence;
//   - never prompt when lonefy absent.
import assert from 'node:assert/strict';
import {
  shouldPromptMigration,
  LONEFY_EXTENSION_ID,
  MIGRATION_PROMPTED_KEY
} from '../../../src/migration/detectLonefy';

describe('migration/detectLonefy — constants', () => {
  it('targets the abandoned incumbent id', () => {
    assert.equal(LONEFY_EXTENSION_ID, 'lonefy.vscode-JS-CSS-HTML-formatter');
  });

  it('exposes a stable globalState dedup key', () => {
    assert.equal(MIGRATION_PROMPTED_KEY, 'tidy.migration.lonefyPrompted');
  });
});

describe('migration/detectLonefy — shouldPromptMigration', () => {
  it('prompts when lonefy is present and we have not prompted before', () => {
    assert.equal(shouldPromptMigration(true, false), true);
  });

  it('does NOT prompt when already prompted (dedup), even if present', () => {
    assert.equal(shouldPromptMigration(true, true), false);
  });

  it('does NOT prompt when lonefy is absent', () => {
    assert.equal(shouldPromptMigration(false, false), false);
  });

  it('does NOT prompt when absent and already prompted', () => {
    assert.equal(shouldPromptMigration(false, true), false);
  });

  it('is a pure boolean of its two inputs (truth table is total)', () => {
    const table: Array<[boolean, boolean, boolean]> = [
      [true, false, true],
      [true, true, false],
      [false, false, false],
      [false, true, false]
    ];
    for (const [present, prompted, expected] of table) {
      assert.equal(
        shouldPromptMigration(present, prompted),
        expected,
        `present=${present}, prompted=${prompted}`
      );
    }
  });
});
