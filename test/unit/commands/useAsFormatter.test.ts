// Unit tests for the PURE planner of the "Use Tidy as my formatter" command
// (Axe 1 / 1.T2). These tests import ONLY the pure decision function and its
// constants — never the VS Code handler — so they run under plain mocha+tsx with
// no Electron host. The module is written with no top-level 'vscode' import, so
// this import does not pull in 'vscode'; a regression that re-introduces a
// top-level 'vscode' import would make this very file fail to load (which is the
// point: the planner must stay host-free).
//
// Coverage focus (the anti-hijack contract lives in the handler + integration
// suite; here we lock the decisions the handler relies on):
//   - scope: requested Workspace with a workspace => workspace, no warning;
//   - scope: requested Workspace without a workspace => global + warning;
//   - scope: requested Global is honoured verbatim (no warning), with/without ws;
//   - default requestedTarget is 'workspace';
//   - languages: unsupported entries dropped, duplicates collapsed, order kept;
//   - empty / all-unsupported input => empty langs (handler then writes nothing);
//   - the input array is never mutated (immutability rule).
import assert from 'node:assert/strict';
import {
  planUseAsFormatter,
  NO_WORKSPACE_WARNING,
  USE_AS_FORMATTER_COMMAND_ID,
  EXTENSION_ID,
  type WriteTarget
} from '../../../src/commands/useAsFormatter';

describe('commands/useAsFormatter — constants', () => {
  it('exposes the stable command id and extension id', () => {
    assert.equal(USE_AS_FORMATTER_COMMAND_ID, 'tidy.useAsFormatter');
    assert.equal(EXTENSION_ID, 'ced-lab.tidy-formatter');
  });
});

describe('commands/useAsFormatter — planUseAsFormatter scope selection', () => {
  it('requested Workspace with a workspace open => workspace, no warning', () => {
    const plan = planUseAsFormatter(['css'], true, 'workspace');
    assert.equal(plan.target, 'workspace');
    assert.equal(plan.warning, undefined);
    assert.deepEqual(plan.langs, ['css']);
  });

  it('requested Workspace with NO workspace => falls back to global + warning', () => {
    const plan = planUseAsFormatter(['css', 'html'], false, 'workspace');
    assert.equal(plan.target, 'global');
    assert.equal(plan.warning, NO_WORKSPACE_WARNING);
    assert.deepEqual(plan.langs, ['css', 'html']);
  });

  it('requested Global with a workspace => global, no warning', () => {
    const plan = planUseAsFormatter(['json'], true, 'global');
    assert.equal(plan.target, 'global');
    assert.equal(plan.warning, undefined);
  });

  it('requested Global with NO workspace => global, no warning (it was the request)', () => {
    const plan = planUseAsFormatter(['json'], false, 'global');
    assert.equal(plan.target, 'global');
    assert.equal(plan.warning, undefined);
  });

  it('defaults requestedTarget to Workspace when omitted (workspace present)', () => {
    const plan = planUseAsFormatter(['scss'], true);
    assert.equal(plan.target, 'workspace');
    assert.equal(plan.warning, undefined);
  });

  it('defaults requestedTarget to Workspace when omitted (no workspace => warn)', () => {
    const plan = planUseAsFormatter(['scss'], false);
    assert.equal(plan.target, 'global');
    assert.equal(plan.warning, NO_WORKSPACE_WARNING);
  });
});

describe('commands/useAsFormatter — planUseAsFormatter language validation', () => {
  it('keeps every supported language in the given order', () => {
    const input = [
      'css',
      'scss',
      'less',
      'html',
      'json',
      'jsonc',
      'javascript',
      'typescript',
      'typescriptreact',
      'javascriptreact'
    ];
    const plan = planUseAsFormatter(input, true);
    assert.deepEqual(plan.langs, input);
  });

  it('drops unsupported / junk languageIds without throwing', () => {
    const plan = planUseAsFormatter(
      ['css', 'python', '', 'rust', 'html', 'vue'],
      true
    );
    assert.deepEqual(plan.langs, ['css', 'html']);
  });

  it('collapses duplicates, preserving the first-seen order', () => {
    const plan = planUseAsFormatter(
      ['html', 'css', 'html', 'css', 'json'],
      true
    );
    assert.deepEqual(plan.langs, ['html', 'css', 'json']);
  });

  it('empty selection => empty langs (handler writes nothing)', () => {
    const plan = planUseAsFormatter([], true, 'workspace');
    assert.deepEqual(plan.langs, []);
    // Scope decision is still well-formed even with no languages.
    assert.equal(plan.target, 'workspace');
  });

  it('all-unsupported selection => empty langs', () => {
    const plan = planUseAsFormatter(['python', 'go', 'ruby'], true);
    assert.deepEqual(plan.langs, []);
  });

  it('empty selection with no workspace still reports the fallback + warning', () => {
    const plan = planUseAsFormatter([], false, 'workspace');
    assert.deepEqual(plan.langs, []);
    assert.equal(plan.target, 'global');
    assert.equal(plan.warning, NO_WORKSPACE_WARNING);
  });
});

describe('commands/useAsFormatter — planUseAsFormatter is pure', () => {
  it('never mutates the input array', () => {
    const input = Object.freeze(['css', 'css', 'python', 'html']);
    // A frozen array would throw on any in-place mutation attempt.
    const plan = planUseAsFormatter(input as readonly string[], true);
    assert.deepEqual(plan.langs, ['css', 'html']);
    assert.deepEqual([...input], ['css', 'css', 'python', 'html']);
  });

  it('returns a fresh langs array each call (no shared reference)', () => {
    const a = planUseAsFormatter(['css'], true);
    const b = planUseAsFormatter(['css'], true);
    assert.notEqual(a.langs, b.langs);
    assert.deepEqual(a.langs, b.langs);
  });

  it('produces only the documented WriteTarget values', () => {
    const targets: WriteTarget[] = [
      planUseAsFormatter(['css'], true, 'workspace').target,
      planUseAsFormatter(['css'], false, 'workspace').target,
      planUseAsFormatter(['css'], true, 'global').target,
      planUseAsFormatter(['css'], false, 'global').target
    ];
    for (const t of targets) {
      assert.ok(t === 'workspace' || t === 'global', `unexpected target: ${t}`);
    }
  });
});
