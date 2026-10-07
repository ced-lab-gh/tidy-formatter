// Unit tests for the consented write of the migration, with ROLLBACK
// (src/migration/applyWrites.ts, v0.5.0), driven by the in-memory fake `vscode`.
//
// The defect this closes: the import used to be a bare loop. A failure on the third
// key left the first two written while the toast said the import failed. It now
// uses the shared `applyOverridesWithRollback` mechanism, so a failure part-way
// restores what was already written, restores the PRIOR value (never a blind
// unset), and NAMES any key it could not restore.
import assert from 'node:assert/strict';
import {
  applyMigrationWrites,
  writeUnitOf
} from '../../../src/migration/applyWrites';
import type { MigrationWrite } from '../../../src/migration/types';
import { makeFakeVscode } from './fakeVscode';

const THREE: readonly MigrationWrite[] = [
  { key: 'tidy.indent', language: 'javascript', value: 2 },
  { key: 'tidy.brace_style', language: 'javascript', value: 'expand' },
  { key: 'tidy.indent', language: 'css', value: 3 }
];

/** The settings store as plain data, for before/after comparison. */
function snapshot(store: ReadonlyMap<string, unknown>): Record<string, unknown> {
  return Object.fromEntries([...store.entries()].sort());
}

describe('migration/applyWrites : writeUnitOf', () => {
  it('names a language write with its block and a plain write by its key', () => {
    assert.equal(writeUnitOf(THREE[0]), '[javascript] tidy.indent');
    assert.equal(writeUnitOf({ key: 'tidy.indent', value: 2 }), 'tidy.indent');
  });
});

describe('migration/applyWrites : a fully successful batch', () => {
  it('writes each key in order, language-scoped with overrideInLanguage, at the target', async () => {
    const vscode = makeFakeVscode();
    const result = await applyMigrationWrites(vscode, THREE, 'workspace');
    assert.deepEqual(result, { ok: true, written: 3 });
    assert.deepEqual(
      vscode.updates.map((u) => [u.section, u.language, u.key, u.value, u.target, u.overrideInLanguage]),
      [
        ['tidy', 'javascript', 'indent', 2, 'WS', true],
        ['tidy', 'javascript', 'brace_style', 'expand', 'WS', true],
        ['tidy', 'css', 'indent', 3, 'WS', true]
      ]
    );
    assert.deepEqual(snapshot(vscode.workspaceStore), {
      '[css] tidy.indent': 3,
      '[javascript] tidy.brace_style': 'expand',
      '[javascript] tidy.indent': 2
    });
    assert.equal(vscode.globalStore.size, 0, 'the other scope is untouched');
  });

  it('a plain (non-language) write carries no overrideInLanguage flag', async () => {
    const vscode = makeFakeVscode();
    await applyMigrationWrites(vscode, [{ key: 'tidy.indent', value: 2 }], 'workspace');
    assert.equal(vscode.updates[0].overrideInLanguage, undefined);
    assert.equal(vscode.updates[0].language, undefined);
    assert.equal(vscode.workspaceStore.get('tidy.indent'), 2);
  });

  it('honours the global target', async () => {
    const vscode = makeFakeVscode();
    await applyMigrationWrites(vscode, [THREE[0]], 'global');
    assert.equal(vscode.updates[0].target, 'GLOBAL');
    assert.equal(vscode.globalStore.get('[javascript] tidy.indent'), 2);
    assert.equal(vscode.workspaceStore.size, 0);
  });

  it('an empty batch is a no-op success and touches nothing', async () => {
    const vscode = makeFakeVscode();
    assert.deepEqual(await applyMigrationWrites(vscode, [], 'workspace'), {
      ok: true,
      written: 0
    });
    assert.deepEqual(vscode.updates, []);
  });

  it('writes ONLY the keys it was handed, never a format-on-save key', async () => {
    const vscode = makeFakeVscode();
    await applyMigrationWrites(vscode, THREE, 'workspace');
    for (const call of vscode.updates) {
      assert.equal(call.section, 'tidy');
      assert.ok(!/onSave|formatOnSave/i.test(call.key), call.key);
    }
  });
});

describe('migration/applyWrites : fails closed when the prior values cannot be read', () => {
  it('writes NOTHING and says so', async () => {
    const vscode = makeFakeVscode({ failInspect: true });
    const result = await applyMigrationWrites(vscode, THREE, 'workspace');
    assert.equal(result.ok, false);
    assert.ok(!result.ok);
    assert.ok(result.detail.includes('could not read the current settings'), result.detail);
    assert.ok(result.detail.includes('no key was left written'), result.detail);
    assert.deepEqual(vscode.updates, [], 'not a single update was attempted');
  });
});

describe('migration/applyWrites : a failure part-way restores what was written', () => {
  it('restores the PRIOR value of a key that had one, and removes a key that had none', async () => {
    const vscode = makeFakeVscode({
      workspaceSettings: { '[javascript] tidy.indent': 8 }, // had a value
      failUpdate: (_call, index) => (index === 3 ? new Error('disk full') : undefined)
    });
    const before = snapshot(vscode.workspaceStore);
    const result = await applyMigrationWrites(vscode, THREE, 'workspace');

    assert.ok(!result.ok);
    assert.deepEqual(result.rolledBack, ['[javascript] tidy.indent', '[javascript] tidy.brace_style']);
    assert.deepEqual(result.stuck, []);
    assert.deepEqual(snapshot(vscode.workspaceStore), before, 'the settings are exactly as before');
    assert.equal(vscode.workspaceStore.get('[javascript] tidy.indent'), 8, 'the prior value came back');
    assert.ok(!vscode.workspaceStore.has('[javascript] tidy.brace_style'), 'an unset key is removed again');
  });

  it('the message names the cause, the failed key and the real state', async () => {
    const vscode = makeFakeVscode({
      failUpdate: (_call, index) => (index === 3 ? new Error('disk full') : undefined)
    });
    const result = await applyMigrationWrites(vscode, THREE, 'workspace');
    assert.ok(!result.ok);
    assert.ok(result.detail.includes('[css] tidy.indent: disk full'), result.detail);
    assert.ok(result.detail.includes('no key was left written'), result.detail);
    assert.ok(result.detail.includes('rolled back: [javascript] tidy.indent'), result.detail);
  });

  it('a failure on the very first key leaves nothing to roll back', async () => {
    const vscode = makeFakeVscode({ failUpdate: () => new Error('read-only') });
    const result = await applyMigrationWrites(vscode, THREE, 'workspace');
    assert.ok(!result.ok);
    assert.deepEqual(result.rolledBack, []);
    assert.deepEqual(result.stuck, []);
    assert.equal(vscode.updates.length, 1, 'the batch stops at the first failure');
    assert.equal(vscode.workspaceStore.size, 0);
  });

  it('rolls back in the global scope too', async () => {
    const vscode = makeFakeVscode({
      globalSettings: { '[css] tidy.indent': 6 },
      failUpdate: (call, index) => (index === 2 ? new Error('nope') : undefined)
    });
    const before = snapshot(vscode.globalStore);
    const result = await applyMigrationWrites(vscode, [THREE[2], THREE[0]], 'global');
    assert.ok(!result.ok);
    assert.deepEqual(snapshot(vscode.globalStore), before);
  });

  it('the cause is single-line even if the error carries a stack-like message', async () => {
    const vscode = makeFakeVscode({
      failUpdate: (_call, index) =>
        index === 2 ? new Error('first line\n    at secret/path.ts:1:1') : undefined
    });
    const result = await applyMigrationWrites(vscode, THREE, 'workspace');
    assert.ok(!result.ok);
    assert.ok(!result.detail.includes('\n'), result.detail);
    assert.ok(!result.detail.includes('secret/path'), result.detail);
  });
});

describe('migration/applyWrites : a key that cannot be restored is NAMED', () => {
  it('reports it as stuck, keeps restoring the others, and the message says it stayed written', async () => {
    // Writes are updates #1, #2; update #3 fails; the rollback then runs restore of
    // the first written key (#4) and of the second (#5). Restore #4 fails.
    const vscode = makeFakeVscode({
      failUpdate: (_call, index) =>
        index === 3 ? new Error('disk full') : index === 4 ? new Error('locked') : undefined
    });
    const result = await applyMigrationWrites(vscode, THREE, 'workspace');

    assert.ok(!result.ok);
    assert.deepEqual(result.stuck, ['[javascript] tidy.indent']);
    assert.deepEqual(result.rolledBack, ['[javascript] tidy.brace_style']);
    assert.ok(
      result.detail.includes('these keys stayed written: [javascript] tidy.indent'),
      result.detail
    );
    assert.ok(result.detail.includes('rolled back: [javascript] tidy.brace_style'), result.detail);
    assert.equal(vscode.workspaceStore.get('[javascript] tidy.indent'), 2, 'really still written');
    assert.ok(
      !vscode.workspaceStore.has('[javascript] tidy.brace_style'),
      'the other key was still restored: one stuck key does not abort the rollback'
    );
  });

  it('names EVERY stuck key when several cannot be restored', async () => {
    const vscode = makeFakeVscode({
      failUpdate: (_call, index) => (index >= 3 ? new Error('broken') : undefined)
    });
    const result = await applyMigrationWrites(vscode, THREE, 'workspace');
    assert.ok(!result.ok);
    assert.deepEqual(result.stuck, ['[javascript] tidy.indent', '[javascript] tidy.brace_style']);
    assert.ok(
      result.detail.includes(
        'these keys stayed written: [javascript] tidy.indent, [javascript] tidy.brace_style'
      ),
      result.detail
    );
  });
});
