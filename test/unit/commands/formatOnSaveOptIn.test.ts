// Unit tests for the guided, consent-first format-on-save opt-in (ADD-04).
//
// These tests import ONLY from src/commands/formatOnSaveOptIn, a module written
// with NO top-level 'vscode' import: a regression that re-introduced one would
// make this very file fail to load, which is the point. The host functions take
// `vscode` as a parameter (same idiom as setDefaultFormatterForLangs), so the
// write / rollback / revert paths are exercised here against an in-memory mock,
// with no Electron host.
//
// What is locked here (the consent contract is the product moat):
//   - the recap shows the EXACT keys that will be written, and nothing else;
//   - a language already at `true` is never re-written (so Revert cannot lie);
//   - a mid-loop write failure rolls back what was written and reports the REAL
//     state (rolled back vs stuck);
//   - Revert restores each key's PRIOR value (an explicit `false` comes back as
//     `false`, never a blind unset) and NEVER clobbers a value the user changed
//     after the opt-in.
import assert from 'node:assert/strict';
import {
  applyFormatOnSavePlan,
  buildFormatOnSaveRevert,
  formatOnSaveRecapDetail,
  planFormatOnSaveWrites,
  readCurrentFormatOnSaveValues,
  revertFormatOnSaveWrites,
  scopeLabelOf,
  REVERT_BUTTON_LABEL,
  type FormatOnSaveWrite
} from '../../../src/commands/formatOnSaveOptIn';
import type { LangId } from '../../../src/types';
import type { WriteTarget } from '../../../src/commands/setDefaultFormatter';

// Never the raw character in sources: the repo forbids U+2014 in shipped text.
const EM_DASH = String.fromCharCode(0x2014);

interface UpdateCall {
  lang: string;
  key: string;
  value: unknown;
  target: unknown;
  overrideInLanguage: boolean;
}

/**
 * Minimal in-memory stand-in for the `vscode` module surface the host functions
 * touch: getConfiguration(...).update / .inspect and ConfigurationTarget. The
 * per-language stores make inspect() reflect earlier update() calls, so revert
 * paths can be exercised end-to-end without an Electron host.
 * `failOnUpdateCalls` makes the Nth update() call (1-based, global) reject.
 */
function makeVscodeMock(options?: { failOnUpdateCalls?: readonly number[] }) {
  const calls: UpdateCall[] = [];
  const workspaceStore = new Map<string, unknown>();
  const globalStore = new Map<string, unknown>();
  let updateCount = 0;
  const failSet = new Set(options?.failOnUpdateCalls ?? []);
  return {
    calls,
    workspaceStore,
    globalStore,
    ConfigurationTarget: { Workspace: 'WS', Global: 'GLOBAL' },
    workspace: {
      getConfiguration(_section: string, scope: { languageId: string }) {
        return {
          update: async (
            key: string,
            value: unknown,
            target: unknown,
            overrideInLanguage: boolean
          ) => {
            updateCount += 1;
            if (failSet.has(updateCount)) {
              throw new Error('simulated write failure');
            }
            calls.push({
              lang: scope.languageId,
              key,
              value,
              target,
              overrideInLanguage
            });
            const store = target === 'GLOBAL' ? globalStore : workspaceStore;
            if (value === undefined) {
              store.delete(scope.languageId);
            } else {
              store.set(scope.languageId, value);
            }
          },
          inspect: (_key: string) => ({
            workspaceLanguageValue: workspaceStore.get(scope.languageId),
            globalLanguageValue: globalStore.get(scope.languageId)
          })
        };
      }
    }
  };
}

function values(
  entries: Record<string, boolean | undefined>
): ReadonlyMap<LangId, boolean | undefined> {
  return new Map(Object.entries(entries)) as ReadonlyMap<
    LangId,
    boolean | undefined
  >;
}

describe('commands/formatOnSaveOptIn : planFormatOnSaveWrites (pure)', () => {
  it('all languages unset produce one write each, prior undefined, order kept', () => {
    const plan = planFormatOnSaveWrites(
      ['css', 'scss', 'html'],
      'workspace',
      values({})
    );
    assert.equal(plan.target, 'workspace');
    assert.deepEqual(
      plan.writes.map((w) => w.lang),
      ['css', 'scss', 'html']
    );
    for (const write of plan.writes) {
      assert.equal(write.priorValue, undefined);
    }
    assert.deepEqual(plan.alreadyEnabled, []);
  });

  it('a language already true is skipped and reported, never re-written', () => {
    const plan = planFormatOnSaveWrites(
      ['css', 'scss'],
      'workspace',
      values({ scss: true })
    );
    assert.deepEqual(plan.writes, [{ lang: 'css', priorValue: undefined }]);
    assert.deepEqual(plan.alreadyEnabled, ['scss']);
  });

  it('an explicit false prior is written AND recorded', () => {
    const plan = planFormatOnSaveWrites(['css'], 'workspace', values({ css: false }));
    assert.deepEqual(plan.writes, [{ lang: 'css', priorValue: false }]);
  });

  it('an empty language list yields an empty plan (nothing to confirm)', () => {
    const plan = planFormatOnSaveWrites([], 'workspace', values({}));
    assert.deepEqual(plan.writes, []);
    assert.deepEqual(plan.alreadyEnabled, []);
  });

  it('never mutates its inputs and returns fresh arrays', () => {
    const langs = Object.freeze(['css', 'scss']) as readonly LangId[];
    const existing = values({ scss: true });
    const first = planFormatOnSaveWrites(langs, 'workspace', existing);
    const second = planFormatOnSaveWrites(langs, 'workspace', existing);
    assert.deepEqual(langs, ['css', 'scss']);
    assert.notEqual(first.writes, second.writes);
    assert.notEqual(first.alreadyEnabled, second.alreadyEnabled);
  });
});

describe('commands/formatOnSaveOptIn : scopeLabelOf + recap detail (pure)', () => {
  it('scopeLabelOf maps workspace to Workspace and global to User', () => {
    assert.equal(scopeLabelOf('workspace'), 'Workspace');
    assert.equal(scopeLabelOf('global'), 'User');
  });

  it('lists every exact key line and names the Workspace scope', () => {
    const plan = planFormatOnSaveWrites(['css', 'scss'], 'workspace', values({}));
    const detail = formatOnSaveRecapDetail(plan);
    assert.ok(detail.includes('at the Workspace scope'), detail);
    assert.ok(detail.includes('  "[css]": { "editor.formatOnSave": true }'));
    assert.ok(detail.includes('  "[scss]": { "editor.formatOnSave": true }'));
  });

  it('names the User scope for a global target', () => {
    const plan = planFormatOnSaveWrites(['css'], 'global', values({}));
    assert.ok(formatOnSaveRecapDetail(plan).includes('at the User scope'));
  });

  it('shows the already-enabled line only when that list is non-empty', () => {
    const withAlready = formatOnSaveRecapDetail(
      planFormatOnSaveWrites(['css', 'less'], 'workspace', values({ less: true }))
    );
    assert.ok(
      withAlready.includes(
        'Already enabled at this scope (nothing to write): "[less]"'
      ),
      withAlready
    );
    const without = formatOnSaveRecapDetail(
      planFormatOnSaveWrites(['css'], 'workspace', values({}))
    );
    assert.ok(!without.includes('Already enabled at this scope'));
  });

  it('promises zero writes until confirm and restates the no-save-hook contract', () => {
    const detail = formatOnSaveRecapDetail(
      planFormatOnSaveWrites(['css'], 'workspace', values({}))
    );
    assert.ok(detail.includes('Nothing has been changed yet'));
    assert.ok(detail.includes('never hooks the save event'));
    assert.ok(detail.includes('one-click Revert'));
  });

  it('contains no em dash and no French (adversarial, gates the release)', () => {
    const detail = formatOnSaveRecapDetail(
      planFormatOnSaveWrites(['css', 'scss'], 'workspace', values({ less: true }))
    );
    assert.ok(!detail.includes(EM_DASH), 'no U+2014 in shipped text');
    assert.ok(!/[àâçéèêëîïôùûœ]/i.test(detail));
  });
});

describe('commands/formatOnSaveOptIn : buildFormatOnSaveRevert (pure)', () => {
  const writes: readonly FormatOnSaveWrite[] = [
    { lang: 'css', priorValue: undefined },
    { lang: 'scss', priorValue: false }
  ];

  it('still-true keys are reverted', () => {
    const decision = buildFormatOnSaveRevert(
      writes,
      values({ css: true, scss: true })
    );
    assert.deepEqual(
      decision.revert.map((w) => w.lang),
      ['css', 'scss']
    );
    assert.deepEqual(decision.kept, []);
  });

  it('user-modified keys are kept, never clobbered', () => {
    const decision = buildFormatOnSaveRevert(
      writes,
      values({ css: false, scss: undefined })
    );
    assert.deepEqual(decision.revert, []);
    assert.deepEqual(decision.kept, ['css', 'scss']);
  });

  it('mixed current values split correctly', () => {
    const decision = buildFormatOnSaveRevert(
      writes,
      values({ css: true, scss: false })
    );
    assert.deepEqual(
      decision.revert.map((w) => w.lang),
      ['css']
    );
    assert.deepEqual(decision.kept, ['scss']);
  });
});

describe('commands/formatOnSaveOptIn : readCurrentFormatOnSaveValues (host)', () => {
  it('reads the language-scoped value at the requested scope only', async () => {
    const vscode = makeVscodeMock();
    vscode.workspaceStore.set('css', true);
    vscode.globalStore.set('scss', true);

    const ws = readCurrentFormatOnSaveValues(vscode, ['css', 'scss'], 'workspace');
    assert.equal(ws.get('css'), true);
    assert.equal(ws.get('scss'), undefined);

    const global = readCurrentFormatOnSaveValues(
      vscode,
      ['css', 'scss'],
      'global'
    );
    assert.equal(global.get('css'), undefined);
    assert.equal(global.get('scss'), true);
  });
});

describe('commands/formatOnSaveOptIn : applyFormatOnSavePlan (host)', () => {
  it('writes true overrideInLanguage for every planned language, in order', async () => {
    const vscode = makeVscodeMock();
    const plan = planFormatOnSaveWrites(['css', 'scss'], 'workspace', values({}));
    const result = await applyFormatOnSavePlan(vscode, plan);

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.written.length, 2);
    assert.equal(vscode.calls.length, 2);
    assert.deepEqual(
      vscode.calls.map((c) => c.lang),
      ['css', 'scss']
    );
    for (const call of vscode.calls) {
      assert.equal(call.key, 'formatOnSave');
      assert.equal(call.value, true);
      assert.equal(call.target, 'WS');
      assert.equal(call.overrideInLanguage, true);
    }
  });

  it('a global target resolves ConfigurationTarget.Global', async () => {
    const vscode = makeVscodeMock();
    const plan = planFormatOnSaveWrites(['css'], 'global', values({}));
    await applyFormatOnSavePlan(vscode, plan);
    assert.equal(vscode.calls[0].target, 'GLOBAL');
  });

  it('a mid-loop failure rolls back what was already written', async () => {
    const vscode = makeVscodeMock({ failOnUpdateCalls: [2] });
    const plan = planFormatOnSaveWrites(['css', 'scss'], 'workspace', values({}));
    const result = await applyFormatOnSavePlan(vscode, plan);

    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.equal(result.cause, 'simulated write failure');
    assert.deepEqual(result.rolledBack, ['css']);
    assert.deepEqual(result.stuck, []);
    // Calls: 1 = css true, 2 = scss (rejected, not recorded), 3 = css rollback.
    const rollback = vscode.calls[vscode.calls.length - 1];
    assert.equal(rollback.lang, 'css');
    assert.equal(rollback.value, undefined);
    assert.equal(vscode.workspaceStore.has('css'), false, 'css must be unset again');
  });

  it('a failing rollback reports the stuck keys honestly (adversarial)', async () => {
    const vscode = makeVscodeMock({ failOnUpdateCalls: [2, 3] });
    const plan = planFormatOnSaveWrites(['css', 'scss'], 'workspace', values({}));
    const result = await applyFormatOnSavePlan(vscode, plan);

    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.deepEqual(result.rolledBack, []);
    assert.deepEqual(result.stuck, ['css']);
  });

  it('rollback restores an explicit false prior, not a blind unset', async () => {
    const vscode = makeVscodeMock({ failOnUpdateCalls: [2] });
    vscode.workspaceStore.set('css', false);
    const existing = readCurrentFormatOnSaveValues(
      vscode,
      ['css', 'scss'],
      'workspace'
    );
    const plan = planFormatOnSaveWrites(['css', 'scss'], 'workspace', existing);
    const result = await applyFormatOnSavePlan(vscode, plan);

    assert.equal(result.ok, false);
    const rollback = vscode.calls[vscode.calls.length - 1];
    assert.equal(rollback.lang, 'css');
    assert.equal(rollback.value, false, 'the explicit false must come back');
    assert.equal(vscode.workspaceStore.get('css'), false);
  });
});

describe('commands/formatOnSaveOptIn : revertFormatOnSaveWrites (host)', () => {
  it('restores prior values for keys still holding our true', async () => {
    const vscode = makeVscodeMock();
    vscode.workspaceStore.set('scss', false);
    const existing = readCurrentFormatOnSaveValues(
      vscode,
      ['css', 'scss'],
      'workspace'
    );
    const plan = planFormatOnSaveWrites(['css', 'scss'], 'workspace', existing);
    const applied = await applyFormatOnSavePlan(vscode, plan);
    assert.equal(applied.ok, true);

    const outcome = await revertFormatOnSaveWrites(
      vscode,
      'workspace',
      applied.ok ? applied.written : []
    );
    assert.deepEqual(outcome.reverted, ['css', 'scss']);
    assert.deepEqual(outcome.kept, []);
    assert.deepEqual(outcome.failed, []);
    assert.equal(vscode.workspaceStore.has('css'), false, 'css back to unset');
    assert.equal(vscode.workspaceStore.get('scss'), false, 'scss back to false');
  });

  it('skips keys the user changed since the opt-in (adversarial)', async () => {
    const vscode = makeVscodeMock();
    const plan = planFormatOnSaveWrites(['css'], 'workspace', values({}));
    const applied = await applyFormatOnSavePlan(vscode, plan);
    assert.equal(applied.ok, true);

    // The user flips it OFF after our write, before pressing Revert.
    vscode.workspaceStore.set('css', false);
    const callsBefore = vscode.calls.length;

    const outcome = await revertFormatOnSaveWrites(
      vscode,
      'workspace',
      applied.ok ? applied.written : []
    );
    assert.deepEqual(outcome.kept, ['css']);
    assert.deepEqual(outcome.reverted, []);
    assert.equal(vscode.calls.length, callsBefore, 'no write during the revert');
    assert.equal(vscode.workspaceStore.get('css'), false, 'the user value survives');
  });

  it('reports a failing restore instead of throwing', async () => {
    const vscode = makeVscodeMock({ failOnUpdateCalls: [2] });
    const plan = planFormatOnSaveWrites(['css'], 'workspace', values({}));
    const applied = await applyFormatOnSavePlan(vscode, plan);
    assert.equal(applied.ok, true);

    const outcome = await revertFormatOnSaveWrites(
      vscode,
      'workspace',
      applied.ok ? applied.written : []
    );
    assert.deepEqual(outcome.failed, ['css']);
    assert.deepEqual(outcome.reverted, []);
  });
});

describe('commands/formatOnSaveOptIn : constants', () => {
  it('exposes the stable Revert button label', () => {
    assert.equal(REVERT_BUTTON_LABEL, 'Revert');
    assert.ok(!REVERT_BUTTON_LABEL.includes(EM_DASH));
  });

  it('the WriteTarget union is the one shared with setDefaultFormatter', () => {
    const targets: readonly WriteTarget[] = ['workspace', 'global'];
    assert.deepEqual(targets.map(scopeLabelOf), ['Workspace', 'User']);
  });
});
