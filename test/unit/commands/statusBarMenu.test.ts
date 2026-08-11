// Unit tests for the PURE part of the status bar click menu (ADD-05).
// Imports no 'vscode' (the handler requires it lazily), like the sibling
// command tests: the item builder must stay host-free and testable.
import assert from 'node:assert/strict';
import {
  buildStatusBarMenuItems,
  STATUS_BAR_MENU_COMMAND_ID
} from '../../../src/commands/statusBarMenu';

// Never the raw character in sources: the repo forbids U+2014 in shipped text.
const EM_DASH = String.fromCharCode(0x2014);

describe('commands/statusBarMenu : pure items', () => {
  it('exposes the stable command id', () => {
    assert.equal(STATUS_BAR_MENU_COMMAND_ID, 'tidy.statusBarMenu');
  });

  it('offers exactly Explain, Preview diff, Show Config, in that order', () => {
    const ids = buildStatusBarMenuItems().map((i) => i.commandId);
    assert.deepEqual(ids, [
      'tidy.explainLastFormat',
      'tidy.previewFormat',
      'tidy.showEffectiveConfiguration'
    ]);
  });

  it('every item has a codicon label and a description', () => {
    for (const item of buildStatusBarMenuItems()) {
      assert.match(item.label, /^\$\([a-z-]+\) .+$/, item.label);
      assert.ok(item.description.length > 0, item.label);
    }
  });

  it('never emits an em dash', () => {
    const all = buildStatusBarMenuItems()
      .flatMap((i) => [i.label, i.description])
      .join(' ');
    assert.ok(!all.includes(EM_DASH));
  });

  it('returns a fresh array each call (no shared mutable state)', () => {
    assert.notEqual(buildStatusBarMenuItems(), buildStatusBarMenuItems());
  });
});
