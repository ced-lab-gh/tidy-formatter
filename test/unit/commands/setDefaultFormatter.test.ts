// Unit tests for the shared `editor.defaultFormatter` write core, and for the
// write-with-rollback mechanism it now owns (v0.4.1, C-11).
//
// THE DEFECT THESE LOCK. Before v0.4.1 `setDefaultFormatterForLangs` was a bare
// `for` loop with no try/catch. A failure on the third language left the first
// two written as `editor.defaultFormatter` while the caller's toast said Tidy
// "could not save the default formatter" : a partial write announced as no write,
// contradicting the modal recap's promise that Tidy "will write exactly these
// keys". The format-on-save path already did this correctly (rollback plus a
// rolledBack/stuck report); that mechanism now lives here and BOTH keys' write
// loops can use it.
//
// These tests drive the module through a mock `vscode` passed as a parameter
// (the same idiom as useAsFormatter.test.ts), so they run under plain mocha+tsx
// with no Electron host, and they assert on the SETTINGS STORE, not only on the
// message: "the toast is honest" is only worth anything if the store agrees.
import assert from 'node:assert/strict';
import {
  EXTENSION_ID,
  applyOverridesWithRollback,
  defaultFormatterFailureDetail,
  DefaultFormatterWriteError,
  setDefaultFormatterForLangs
} from '../../../src/commands/setDefaultFormatter';
import type { LangId } from '../../../src/types';

/** The em dash that must never appear in a shipped string. */
const EM_DASH_CHAR = String.fromCharCode(0x2014);

/* -------------------------------------------------------------------------- */
/* A settings host whose writes can fail exactly where a test wants them to     */
/* -------------------------------------------------------------------------- */

interface HostOptions {
  /** Seed values for the workspace-language scope. */
  readonly seed?: Record<string, unknown>;
  /** Language whose `update` to Tidy throws (simulating a failed write). */
  readonly failWriteOn?: string;
  /** Languages whose ROLLBACK update throws (simulating an unrestorable key). */
  readonly failRestoreOn?: readonly string[];
  /** Make `inspect` throw, so no prior value can be read. */
  readonly throwOnInspect?: boolean;
}

function makeHost(options: HostOptions = {}) {
  const store = new Map<string, unknown>(Object.entries(options.seed ?? {}));
  const updates: Array<{ lang: string; key: string; value: unknown }> = [];
  return {
    store,
    updates,
    ConfigurationTarget: { Workspace: 'WS', Global: 'GLOBAL' },
    workspace: {
      getConfiguration(_section: string, scope: { languageId: string }) {
        return {
          inspect: (_key: string) => {
            if (options.throwOnInspect === true) {
              throw new Error('simulated inspect failure');
            }
            return {
              workspaceLanguageValue: store.get(scope.languageId),
              globalLanguageValue: undefined
            };
          },
          update: async (key: string, value: unknown) => {
            const isOurWrite = value === EXTENSION_ID;
            if (isOurWrite && scope.languageId === options.failWriteOn) {
              throw new Error('EACCES: settings.json is read-only');
            }
            if (
              !isOurWrite &&
              (options.failRestoreOn ?? []).includes(scope.languageId)
            ) {
              throw new Error('EROFS: read-only file system');
            }
            updates.push({ lang: scope.languageId, key, value });
            if (value === undefined) {
              store.delete(scope.languageId);
            } else {
              store.set(scope.languageId, value);
            }
          }
        };
      }
    }
  };
}

const FOUR: readonly LangId[] = ['css', 'scss', 'html', 'json'];

/* -------------------------------------------------------------------------- */

describe('commands/setDefaultFormatter : the write is all-or-nothing (C-11)', () => {
  it('writes every key when nothing fails', async () => {
    const host = makeHost();
    await setDefaultFormatterForLangs(host, FOUR, 'workspace');
    assert.deepEqual(
      [...host.store.entries()],
      FOUR.map((lang) => [lang, EXTENSION_ID])
    );
  });

  it('a mid-loop failure leaves the settings EXACTLY as they were', async () => {
    // css already points at another formatter: rollback must restore THAT value,
    // not blindly unset the key.
    const host = makeHost({
      seed: { css: 'esbenp.prettier-vscode' },
      failWriteOn: 'html'
    });
    await assert.rejects(() =>
      setDefaultFormatterForLangs(host, FOUR, 'workspace')
    );
    assert.deepEqual(
      [...host.store.entries()],
      [['css', 'esbenp.prettier-vscode']],
      'css restored to its prior value, scss removed, html/json never written'
    );
  });

  it('the thrown message names the real state: rolled back, nothing kept', async () => {
    const host = makeHost({ failWriteOn: 'html' });
    const error = await setDefaultFormatterForLangs(
      host,
      FOUR,
      'workspace'
    ).then(
      () => undefined,
      (thrown: unknown) => thrown
    );
    assert.ok(error instanceof DefaultFormatterWriteError);
    assert.deepEqual(error.rolledBack, ['css', 'scss']);
    assert.deepEqual(error.stuck, []);
    assert.equal(
      error.message,
      'EACCES: settings.json is read-only; no key was left written; ' +
        'rolled back: css, scss'
    );
    // What the caller's toast becomes, verbatim.
    assert.equal(
      `Tidy: could not save the default formatter (${error.message}).`,
      'Tidy: could not save the default formatter (EACCES: settings.json is ' +
        'read-only; no key was left written; rolled back: css, scss).'
    );
  });

  it('a key the rollback could not restore is NAMED, never hidden', async () => {
    const host = makeHost({ failWriteOn: 'html', failRestoreOn: ['scss'] });
    const error = await setDefaultFormatterForLangs(
      host,
      FOUR,
      'workspace'
    ).then(
      () => undefined,
      (thrown: unknown) => thrown
    );
    assert.ok(error instanceof DefaultFormatterWriteError);
    assert.deepEqual(error.rolledBack, ['css']);
    assert.deepEqual(error.stuck, ['scss']);
    assert.match(error.message, /these keys stayed written: scss/);
    // And the message tells the truth about the store.
    assert.deepEqual([...host.store.entries()], [['scss', EXTENSION_ID]]);
  });

  it('fails CLOSED when the prior values cannot be read: zero writes', async () => {
    const host = makeHost({ throwOnInspect: true });
    const error = await setDefaultFormatterForLangs(
      host,
      FOUR,
      'workspace'
    ).then(
      () => undefined,
      (thrown: unknown) => thrown
    );
    assert.ok(error instanceof DefaultFormatterWriteError);
    assert.deepEqual(host.updates, [], 'no readable prior state => no write');
    assert.deepEqual([...host.store.entries()], []);
    assert.match(error.message, /could not read the current settings/);
    assert.match(error.message, /no key was left written/);
  });

  it('an empty language list writes nothing and does not even read', async () => {
    const host = makeHost({ throwOnInspect: true });
    await setDefaultFormatterForLangs(host, [], 'workspace');
    assert.deepEqual(host.updates, []);
  });

  it('writes ONLY editor.defaultFormatter, never formatOnSave (anti-hijack)', async () => {
    const host = makeHost({ failWriteOn: 'html' });
    await assert.rejects(() =>
      setDefaultFormatterForLangs(host, FOUR, 'workspace')
    );
    for (const update of host.updates) {
      assert.equal(
        update.key,
        'defaultFormatter',
        'the rollback must not touch any other key either'
      );
    }
  });

  it('honours the global scope for both the write and the rollback', async () => {
    const host = makeHost({ failWriteOn: 'scss' });
    await assert.rejects(() =>
      setDefaultFormatterForLangs(host, ['css', 'scss'], 'global')
    );
    assert.deepEqual([...host.store.entries()], []);
  });
});

describe('commands/setDefaultFormatter : applyOverridesWithRollback', () => {
  it('reports every written language on success', async () => {
    const written: LangId[] = [];
    const result = await applyOverridesWithRollback<undefined>(
      [
        { lang: 'css', priorValue: undefined },
        { lang: 'scss', priorValue: undefined }
      ],
      async (lang) => {
        written.push(lang);
      },
      async () => {
        throw new Error('rollback must not run on success');
      }
    );
    assert.deepEqual(result, { ok: true, written: ['css', 'scss'] });
    assert.deepEqual(written, ['css', 'scss']);
  });

  it('rolls back in write order and never throws', async () => {
    const restored: Array<[LangId, string]> = [];
    const result = await applyOverridesWithRollback<string>(
      [
        { lang: 'css', priorValue: 'a' },
        { lang: 'scss', priorValue: 'b' },
        { lang: 'html', priorValue: 'c' }
      ],
      async (lang) => {
        if (lang === 'html') {
          throw new Error('boom');
        }
      },
      async (lang, priorValue) => {
        restored.push([lang, priorValue]);
      }
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.failed, 'html');
      assert.equal(result.cause, 'boom');
      assert.deepEqual(result.rolledBack, ['css', 'scss']);
      assert.deepEqual(result.stuck, []);
    }
    assert.deepEqual(restored, [
      ['css', 'a'],
      ['scss', 'b']
    ]);
  });

  it('one unrestorable key does not abort the rest of the rollback', async () => {
    const result = await applyOverridesWithRollback<undefined>(
      [
        { lang: 'css', priorValue: undefined },
        { lang: 'scss', priorValue: undefined },
        { lang: 'html', priorValue: undefined }
      ],
      async (lang) => {
        if (lang === 'html') {
          throw new Error('boom');
        }
      },
      async (lang) => {
        if (lang === 'css') {
          throw new Error('cannot restore');
        }
      }
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.deepEqual(result.stuck, ['css']);
      assert.deepEqual(result.rolledBack, ['scss'], 'scss was still restored');
    }
  });

  it('sanitizes a multi-line failure to a single line', async () => {
    const result = await applyOverridesWithRollback<undefined>(
      [{ lang: 'css', priorValue: undefined }],
      async () => {
        throw new Error('first line\nsecond line with source: const a = 1;');
      },
      async () => undefined
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.cause, 'first line');
      assert.ok(!result.cause.includes('\n'));
    }
  });

  it('a non-Error rejection still yields a safe cause', async () => {
    const result = await applyOverridesWithRollback<undefined>(
      [{ lang: 'css', priorValue: undefined }],
      async () => {
        throw 'a bare string';
      },
      async () => undefined
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.cause, 'unknown error');
    }
  });
});

describe('commands/setDefaultFormatter : defaultFormatterFailureDetail', () => {
  it('says plainly when nothing was left written', () => {
    assert.equal(
      defaultFormatterFailureDetail('EPERM', [], []),
      'EPERM; no key was left written'
    );
  });

  it('lists what was rolled back', () => {
    assert.equal(
      defaultFormatterFailureDetail('EPERM', ['css', 'scss'], []),
      'EPERM; no key was left written; rolled back: css, scss'
    );
  });

  it('names the keys that stayed written', () => {
    assert.equal(
      defaultFormatterFailureDetail('EPERM', ['css'], ['scss']),
      'EPERM; these keys stayed written: scss; rolled back: css'
    );
  });

  it('clamps the CAUSE, never the state clauses', () => {
    const detail = defaultFormatterFailureDetail(
      'x'.repeat(500),
      ['css', 'scss', 'less'],
      ['html', 'json']
    );
    assert.ok(detail.length <= 200, `detail must fit a toast: ${detail.length}`);
    assert.ok(detail.includes('these keys stayed written: html, json'));
    assert.ok(detail.endsWith('rolled back: css, scss, less'));
    assert.match(detail, /^x+\.\.\.;/, 'the cause is the clamped part');
  });

  it('never truncates the state for the widest real language list', () => {
    const all: readonly LangId[] = [
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
    const detail = defaultFormatterFailureDetail(
      'EPERM: operation not permitted',
      all.slice(0, 5),
      all.slice(5)
    );
    assert.ok(detail.length <= 200);
    for (const lang of all) {
      assert.ok(detail.includes(lang), `${lang} must survive in the message`);
    }
  });

  it('keeps a multi-line cause to its first line', () => {
    assert.equal(
      defaultFormatterFailureDetail('line one\nline two', [], []),
      'line one; no key was left written'
    );
  });

  it('falls back to a stable cause when there is none', () => {
    assert.equal(
      defaultFormatterFailureDetail('   ', [], []),
      'unknown error; no key was left written'
    );
  });

  it('is English, ASCII and em-dash-free', () => {
    const samples = [
      defaultFormatterFailureDetail('EPERM', ['css'], ['scss']),
      defaultFormatterFailureDetail('EPERM', [], [])
    ];
    for (const sample of samples) {
      assert.match(sample, /^[\x20-\x7E]*$/, `ASCII only: ${sample}`);
      assert.ok(!sample.includes(EM_DASH_CHAR));
    }
  });
});
