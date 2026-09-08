// Unit tests for the PURE planner of the "Use Tidy as my formatter" command
// (Axe 1 / 1.T2). These tests import ONLY the pure decision function and its
// constants : never the VS Code handler : so they run under plain mocha+tsx with
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
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import {
  planUseAsFormatter,
  NO_WORKSPACE_PENDING_WARNING,
  NO_WORKSPACE_WRITTEN_WARNING,
  pendingWarningTextOf,
  writtenWarningTextOf,
  USE_AS_FORMATTER_COMMAND_ID,
  EXTENSION_ID,
  confirmAndApplyDefaultFormatter,
  defaultFormatterRecapDetail,
  planDefaultFormatterRecap,
  DEFAULT_FORMATTER_CONFIRM_ACTION,
  DEFAULT_FORMATTER_CONFIRM_TITLE,
  type DefaultFormatterRecap,
  type WriteTarget
} from '../../../src/commands/useAsFormatter';
import { readCurrentDefaultFormatterValues } from '../../../src/commands/setDefaultFormatter';
// The drift lock below compares this command's recap with the format-on-save
// recap it reuses, so both modules are imported by the same test.
import {
  formatOnSaveRecapDetail,
  planFormatOnSaveWrites,
  scopeLabelOf
} from '../../../src/commands/formatOnSaveOptIn';
import type { LangId } from '../../../src/types';

describe('commands/useAsFormatter : constants', () => {
  it('exposes the stable command id and extension id', () => {
    assert.equal(USE_AS_FORMATTER_COMMAND_ID, 'tidy.useAsFormatter');
    assert.equal(EXTENSION_ID, 'ced-lab.tidy-formatter');
  });
});

// Audit #16 (v0.3.0 string migration): the only user-facing strings the pure
// planner emits are the two tenses of the no-workspace fallback warning; both
// must be English.
describe('commands/useAsFormatter : user-facing strings are English', () => {
  for (const [name, text] of [
    ['NO_WORKSPACE_PENDING_WARNING', NO_WORKSPACE_PENDING_WARNING],
    ['NO_WORKSPACE_WRITTEN_WARNING', NO_WORKSPACE_WRITTEN_WARNING]
  ] as const) {
    it(`${name} is English, ASCII-only and em-dash-free`, () => {
      assert.match(text, /no workspace folder is open/i);
      assert.match(text, /User settings/);
      assert.doesNotMatch(text, /\b(aucun|dossier|parametres|defaut)\b/i);
      assert.ok(!text.includes('\u2014'), 'no em dash');
      assert.match(text, /^[\x20-\x7E]*$/, 'ASCII only');
    });
  }
});

// THE fix of the final round: the confirmation dialog used to render the
// PAST-TENSE fallback warning ("Tidy was set as your default formatter in your
// User settings") one line above "Nothing has been changed yet." : the dialog
// asserting a write that had not happened. The warning is now a CODE with two
// tense-specific renderings, and each is bound to one moment.
describe('commands/useAsFormatter : the fallback warning has two tenses', () => {
  /** A claim that a write already happened. Forbidden before the write. */
  const PAST_TENSE_WRITE_CLAIM =
    /\b(was|were|has been|have been)\s+(set|written|changed|applied|saved)\b/i;

  it('the pre-write wording is conditional and claims no completed write', () => {
    assert.equal(
      pendingWarningTextOf('workspace-fallback'),
      NO_WORKSPACE_PENDING_WARNING
    );
    assert.match(NO_WORKSPACE_PENDING_WARNING, /if you confirm/i);
    assert.match(NO_WORKSPACE_PENDING_WARNING, /will be set/i);
    assert.doesNotMatch(NO_WORKSPACE_PENDING_WARNING, PAST_TENSE_WRITE_CLAIM);
  });

  it('the post-write wording reports the completed write in the past tense', () => {
    assert.equal(
      writtenWarningTextOf('workspace-fallback'),
      NO_WORKSPACE_WRITTEN_WARNING
    );
    assert.match(NO_WORKSPACE_WRITTEN_WARNING, /was set/i);
    assert.doesNotMatch(NO_WORKSPACE_WRITTEN_WARNING, /if you confirm/i);
  });

  it('the two tenses are different strings (a single one cannot be right twice)', () => {
    assert.notEqual(
      NO_WORKSPACE_PENDING_WARNING,
      NO_WORKSPACE_WRITTEN_WARNING
    );
  });

  it('both name the same fact: the User scope replaced the workspace one', () => {
    for (const text of [
      NO_WORKSPACE_PENDING_WARNING,
      NO_WORKSPACE_WRITTEN_WARNING
    ]) {
      assert.match(text, /User settings instead of the workspace/);
    }
  });
});

describe('commands/useAsFormatter : planUseAsFormatter scope selection', () => {
  it('requested Workspace with a workspace open => workspace, no warning', () => {
    const plan = planUseAsFormatter(['css'], true, 'workspace');
    assert.equal(plan.target, 'workspace');
    assert.equal(plan.warningCode, undefined);
    assert.deepEqual(plan.langs, ['css']);
  });

  it('requested Workspace with NO workspace => falls back to global + warning', () => {
    const plan = planUseAsFormatter(['css', 'html'], false, 'workspace');
    assert.equal(plan.target, 'global');
    assert.equal(plan.warningCode, 'workspace-fallback');
    assert.deepEqual(plan.langs, ['css', 'html']);
  });

  it('requested Global with a workspace => global, no warning', () => {
    const plan = planUseAsFormatter(['json'], true, 'global');
    assert.equal(plan.target, 'global');
    assert.equal(plan.warningCode, undefined);
  });

  it('requested Global with NO workspace => global, no warning (it was the request)', () => {
    const plan = planUseAsFormatter(['json'], false, 'global');
    assert.equal(plan.target, 'global');
    assert.equal(plan.warningCode, undefined);
  });

  it('defaults requestedTarget to Workspace when omitted (workspace present)', () => {
    const plan = planUseAsFormatter(['scss'], true);
    assert.equal(plan.target, 'workspace');
    assert.equal(plan.warningCode, undefined);
  });

  it('defaults requestedTarget to Workspace when omitted (no workspace => warn)', () => {
    const plan = planUseAsFormatter(['scss'], false);
    assert.equal(plan.target, 'global');
    assert.equal(plan.warningCode, 'workspace-fallback');
  });
});

describe('commands/useAsFormatter : planUseAsFormatter language validation', () => {
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
    assert.equal(plan.warningCode, 'workspace-fallback');
  });
});

describe('commands/useAsFormatter : planUseAsFormatter is pure', () => {
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

/* ========================================================================== *
 * ADD (v0.4.0): the pre-write consent recap for `editor.defaultFormatter`.
 *
 * Until v0.4.0 this command wrote `editor.defaultFormatter` straight after the
 * two QuickPicks, with NO list of the keys it was about to write and NO
 * confirmation : while the README promised, in four places, that Tidy "shows you
 * the exact keys first". That is the single most sensitive write the extension
 * performs (it is the exact behaviour the incumbent was condemned for), so the
 * gate below is the product's moat, not a nicety.
 *
 * What is locked here:
 *   - the recap lists the EXACT keys, values and scope that would be written;
 *   - a language already pointing at Tidy is never re-written (so the recap's
 *     "exactly these keys" promise stays literally true);
 *   - a foreign formatter being replaced is named, sanitized (no multi-line
 *     settings value can reach a dialog);
 *   - CANCELLING WRITES NOTHING : Escape, the dialog's Cancel, and any other
 *     button all leave ZERO update() calls behind;
 *   - the read fails closed: no readable prior state => no dialog, no write;
 *   - the recap grammar is the SAME as the format-on-save recap, so the two
 *     consent paths cannot drift apart.
 * ========================================================================== */

// Never the raw character in sources: the repo forbids U+2014 in shipped text.
const EM_DASH_CHAR = String.fromCharCode(0x2014);

interface DefaultFormatterUpdateCall {
  lang: string;
  key: string;
  value: unknown;
  target: unknown;
  overrideInLanguage: boolean;
}

interface ShownMessage {
  message: string;
  options: unknown;
  actions: string[];
}

/**
 * Minimal in-memory stand-in for the `vscode` surface the consent gate touches:
 * getConfiguration(...).inspect / .update, ConfigurationTarget and
 * window.showInformationMessage. `answer` is what the modal returns (undefined
 * models Escape / the dialog's own Cancel button).
 */
function makeVscodeMock(options?: {
  workspaceValues?: Record<string, unknown>;
  globalValues?: Record<string, unknown>;
  answer?: string | undefined;
  throwOnInspect?: boolean;
  throwOnUpdate?: boolean;
}) {
  const calls: DefaultFormatterUpdateCall[] = [];
  const shown: ShownMessage[] = [];
  const workspaceStore = new Map<string, unknown>(
    Object.entries(options?.workspaceValues ?? {})
  );
  const globalStore = new Map<string, unknown>(
    Object.entries(options?.globalValues ?? {})
  );
  return {
    calls,
    shown,
    workspaceStore,
    globalStore,
    ConfigurationTarget: { Workspace: 'WS', Global: 'GLOBAL' },
    window: {
      showInformationMessage: async (
        message: string,
        modalOptions: unknown,
        ...actions: string[]
      ) => {
        shown.push({ message, options: modalOptions, actions });
        return options?.answer;
      }
    },
    workspace: {
      getConfiguration(_section: string, scope: { languageId: string }) {
        return {
          inspect: (_key: string) => {
            if (options?.throwOnInspect) {
              throw new Error('simulated inspect failure');
            }
            return {
              workspaceLanguageValue: workspaceStore.get(scope.languageId),
              globalLanguageValue: globalStore.get(scope.languageId)
            };
          },
          update: async (
            key: string,
            value: unknown,
            target: unknown,
            overrideInLanguage: boolean
          ) => {
            if (options?.throwOnUpdate) {
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
            store.set(scope.languageId, value);
          }
        };
      }
    }
  };
}

function currentValues(
  entries: Record<string, string | undefined>
): ReadonlyMap<LangId, string | undefined> {
  return new Map(Object.entries(entries)) as ReadonlyMap<
    LangId,
    string | undefined
  >;
}

describe('commands/useAsFormatter : planDefaultFormatterRecap (pure)', () => {
  it('every language unset => one write each, order kept, nothing replaced', () => {
    const plan = planUseAsFormatter(['css', 'scss', 'html'], true, 'workspace');
    const recap = planDefaultFormatterRecap(plan, currentValues({}));
    assert.equal(recap.target, 'workspace');
    assert.deepEqual(recap.writes, ['css', 'scss', 'html']);
    assert.deepEqual(recap.replaces, []);
    assert.deepEqual(recap.alreadyTidy, []);
    assert.equal(recap.warningCode, undefined);
  });

  it('a language already pointing at Tidy is NEVER re-written', () => {
    const plan = planUseAsFormatter(['css', 'html'], true, 'workspace');
    const recap = planDefaultFormatterRecap(
      plan,
      currentValues({ css: EXTENSION_ID })
    );
    assert.deepEqual(recap.writes, ['html']);
    assert.deepEqual(recap.alreadyTidy, ['css']);
    assert.deepEqual(recap.replaces, []);
  });

  it('a foreign formatter is named as a replacement, and still written', () => {
    const plan = planUseAsFormatter(['css'], true, 'workspace');
    const recap = planDefaultFormatterRecap(
      plan,
      currentValues({ css: 'esbenp.prettier-vscode' })
    );
    assert.deepEqual(recap.writes, ['css']);
    assert.deepEqual(recap.replaces, [
      { lang: 'css', current: 'esbenp.prettier-vscode' }
    ]);
  });

  it('sanitizes a hostile settings value (multi-line, overlong)', () => {
    const plan = planUseAsFormatter(['css', 'html'], true, 'workspace');
    const recap = planDefaultFormatterRecap(
      plan,
      currentValues({
        css: 'evil.formatter\nSECOND LINE THAT MUST NOT SHOW',
        html: 'x'.repeat(500)
      })
    );
    const css = recap.replaces.find((item) => item.lang === 'css');
    const html = recap.replaces.find((item) => item.lang === 'html');
    assert.ok(css !== undefined && html !== undefined);
    assert.equal(css.current, 'evil.formatter');
    assert.ok(!css.current.includes('\n'), 'no newline may reach the dialog');
    assert.ok(!css.current.includes('SECOND LINE'));
    assert.ok(html.current.length <= 60, `capped, got ${html.current.length}`);
  });

  it('an empty-string current value is not reported as a replacement', () => {
    const plan = planUseAsFormatter(['css'], true, 'workspace');
    const recap = planDefaultFormatterRecap(plan, currentValues({ css: '' }));
    assert.deepEqual(recap.writes, ['css']);
    assert.deepEqual(recap.replaces, []);
  });

  it('carries the plan warning CODE through (and omits it when absent)', () => {
    const fallback = planUseAsFormatter(['css'], false, 'workspace');
    assert.equal(
      planDefaultFormatterRecap(fallback, currentValues({})).warningCode,
      'workspace-fallback'
    );
    const plain = planUseAsFormatter(['css'], true, 'workspace');
    assert.equal(
      planDefaultFormatterRecap(plain, currentValues({})).warningCode,
      undefined
    );
  });

  it('is pure: never mutates the plan and returns fresh arrays', () => {
    const plan = planUseAsFormatter(['css', 'html'], true, 'workspace');
    const before = [...plan.langs];
    const a = planDefaultFormatterRecap(plan, currentValues({}));
    const b = planDefaultFormatterRecap(plan, currentValues({}));
    assert.deepEqual([...plan.langs], before);
    assert.notEqual(a.writes, b.writes);
    assert.notEqual(a.writes, plan.langs);
    assert.deepEqual(a.writes, b.writes);
  });
});

describe('commands/useAsFormatter : defaultFormatterRecapDetail (pure)', () => {
  const recapOf = (
    langs: readonly string[],
    target: WriteTarget,
    values: Record<string, string | undefined> = {},
    hasWorkspace = true
  ): DefaultFormatterRecap =>
    planDefaultFormatterRecap(
      planUseAsFormatter(langs, hasWorkspace, target),
      currentValues(values)
    );

  it('lists every exact key AND its value, and names the Workspace scope', () => {
    const detail = defaultFormatterRecapDetail(
      recapOf(['css', 'html'], 'workspace')
    );
    assert.ok(detail.includes('at the Workspace scope'), detail);
    assert.ok(
      detail.includes(
        `  "[css]": { "editor.defaultFormatter": "${EXTENSION_ID}" }`
      ),
      detail
    );
    assert.ok(
      detail.includes(
        `  "[html]": { "editor.defaultFormatter": "${EXTENSION_ID}" }`
      ),
      detail
    );
  });

  it('names the User scope for a global target', () => {
    assert.ok(
      defaultFormatterRecapDetail(recapOf(['css'], 'global')).includes(
        'at the User scope'
      )
    );
  });

  it('names what it replaces, only when something is replaced', () => {
    const withReplace = defaultFormatterRecapDetail(
      recapOf(['css'], 'workspace', { css: 'esbenp.prettier-vscode' })
    );
    assert.ok(
      withReplace.includes(
        'Would replace the formatter currently set at this scope: ' +
          '"[css]" (esbenp.prettier-vscode).'
      ),
      withReplace
    );
    // Conditional, never "Replaces": this line is read BEFORE the write.
    assert.ok(
      !withReplace.includes('\nReplaces the formatter'),
      'the pre-write dialog must not state the replacement as done'
    );
    const without = defaultFormatterRecapDetail(recapOf(['css'], 'workspace'));
    assert.ok(!without.includes('replace the formatter currently set'));
  });

  it('shows the already-set line only when that list is non-empty', () => {
    const withAlready = defaultFormatterRecapDetail(
      recapOf(['css', 'html'], 'workspace', { html: EXTENSION_ID })
    );
    assert.ok(
      withAlready.includes(
        'Already set to Tidy at this scope (nothing to write): "[html]"'
      ),
      withAlready
    );
    const without = defaultFormatterRecapDetail(recapOf(['css'], 'workspace'));
    assert.ok(!without.includes('Already set to Tidy at this scope'));
  });

  it('surfaces the no-workspace fallback BEFORE the write, in the PENDING tense', () => {
    const detail = defaultFormatterRecapDetail(
      recapOf(['css'], 'workspace', {}, false)
    );
    assert.ok(detail.includes('at the User scope'), detail);
    assert.ok(detail.includes(NO_WORKSPACE_PENDING_WARNING), detail);
    // The bug this locks: the past-tense wording claimed the write had already
    // happened, immediately above "Nothing has been changed yet."
    assert.ok(
      !detail.includes(NO_WORKSPACE_WRITTEN_WARNING),
      'the pre-write dialog must never carry the post-write wording'
    );
    assert.ok(
      !/Tidy was set as your default formatter/.test(detail),
      'no sentence in the modal may assert a write that has not happened'
    );
  });

  it('NO sentence of the modal claims a completed write (every branch)', () => {
    // A claim that a write already happened, in any of the recap's optional
    // sections. The only past tense allowed is the promise "Nothing has been
    // changed yet", which asserts the opposite.
    const PAST_TENSE_WRITE_CLAIM =
      /\b(was|were|has been|have been)\s+(set|written|applied|saved|replaced)\b/i;
    const details = [
      defaultFormatterRecapDetail(recapOf(['css'], 'workspace')),
      defaultFormatterRecapDetail(recapOf(['css'], 'global')),
      defaultFormatterRecapDetail(
        recapOf(['css'], 'workspace', { css: 'esbenp.prettier-vscode' })
      ),
      defaultFormatterRecapDetail(
        recapOf(['css', 'html'], 'workspace', { html: EXTENSION_ID })
      ),
      defaultFormatterRecapDetail(recapOf(['css'], 'workspace', {}, false)),
      defaultFormatterRecapDetail(
        recapOf(
          ['css', 'html', 'json'],
          'workspace',
          { css: 'esbenp.prettier-vscode', json: EXTENSION_ID },
          false
        )
      )
    ];
    for (const detail of details) {
      for (const line of detail.split('\n')) {
        if (line.includes('Nothing has been changed yet')) {
          continue; // the promise that nothing happened, not a claim it did
        }
        assert.doesNotMatch(
          line,
          PAST_TENSE_WRITE_CLAIM,
          `pre-write dialog line claims a completed write: ${line}`
        );
      }
      // Every acting sentence is conditional or future.
      assert.match(detail, /Tidy will write exactly these keys/);
    }
  });

  it('promises zero writes until confirm and restates the anti-hijack contract', () => {
    const detail = defaultFormatterRecapDetail(recapOf(['css'], 'workspace'));
    assert.ok(detail.includes('Nothing has been changed yet'));
    assert.ok(detail.includes('does not touch editor.formatOnSave'));
    assert.ok(detail.includes('no save hook and no file watcher'));
    assert.ok(detail.includes('Cancel and nothing at all is written'));
  });

  it('never leaks a multi-line settings value into the dialog', () => {
    const detail = defaultFormatterRecapDetail(
      recapOf(['css'], 'workspace', { css: 'evil\nINJECTED' })
    );
    assert.ok(!detail.includes('INJECTED'), detail);
  });

  it('contains no em dash and no French (adversarial, gates the release)', () => {
    const detail = defaultFormatterRecapDetail(
      recapOf(['css', 'html'], 'workspace', {
        css: 'esbenp.prettier-vscode',
        html: EXTENSION_ID
      })
    );
    assert.ok(!detail.includes(EM_DASH_CHAR), 'no U+2014 in shipped text');
    assert.ok(!/[àâçéèêëîïôùûœ]/i.test(detail));
  });
});

describe('commands/setDefaultFormatter : readCurrentDefaultFormatterValues', () => {
  it('reads the workspace language value for a workspace target', () => {
    const vscode = makeVscodeMock({
      workspaceValues: { css: 'esbenp.prettier-vscode' },
      globalValues: { css: 'other.formatter' }
    });
    const values = readCurrentDefaultFormatterValues(
      vscode,
      ['css', 'html'],
      'workspace'
    );
    assert.equal(values.get('css'), 'esbenp.prettier-vscode');
    assert.equal(values.get('html'), undefined);
  });

  it('reads the global language value for a global target', () => {
    const vscode = makeVscodeMock({
      workspaceValues: { css: 'esbenp.prettier-vscode' },
      globalValues: { css: 'other.formatter' }
    });
    const values = readCurrentDefaultFormatterValues(vscode, ['css'], 'global');
    assert.equal(values.get('css'), 'other.formatter');
  });

  it('normalises a non-string settings value to undefined', () => {
    const vscode = makeVscodeMock({ workspaceValues: { css: 42 } });
    const values = readCurrentDefaultFormatterValues(
      vscode,
      ['css'],
      'workspace'
    );
    assert.equal(values.get('css'), undefined);
  });
});

describe('commands/useAsFormatter : confirmAndApplyDefaultFormatter (consent gate)', () => {
  const planFor = (
    langs: readonly string[],
    target: WriteTarget = 'workspace'
  ) => planUseAsFormatter(langs, true, target);

  it('shows a MODAL recap listing the exact keys BEFORE writing anything', async () => {
    const vscode = makeVscodeMock({
      answer: DEFAULT_FORMATTER_CONFIRM_ACTION
    });
    await confirmAndApplyDefaultFormatter(vscode, planFor(['css', 'html']));
    assert.equal(vscode.shown.length, 1);
    const dialog = vscode.shown[0];
    assert.equal(dialog.message, DEFAULT_FORMATTER_CONFIRM_TITLE);
    assert.deepEqual(dialog.actions, [DEFAULT_FORMATTER_CONFIRM_ACTION]);
    const opts = dialog.options as { modal?: boolean; detail?: string };
    assert.equal(opts.modal, true, 'the recap must be modal');
    assert.ok(
      (opts.detail ?? '').includes(
        `  "[css]": { "editor.defaultFormatter": "${EXTENSION_ID}" }`
      ),
      opts.detail
    );
  });

  it('the MODAL it really shows carries the PENDING wording, never the written one', async () => {
    // End-to-end on the dialog the user actually reads: a no-workspace plan
    // falls back to the User scope, and the modal must say what WOULD happen.
    const vscode = makeVscodeMock({ answer: undefined });
    const fallbackPlan = planUseAsFormatter(['css'], false, 'workspace');
    const result = await confirmAndApplyDefaultFormatter(vscode, fallbackPlan);
    assert.equal(result.outcome, 'cancelled');
    assert.deepEqual(vscode.calls, [], 'still zero writes');
    const detail =
      (vscode.shown[0].options as { detail?: string }).detail ?? '';
    assert.ok(detail.includes(NO_WORKSPACE_PENDING_WARNING), detail);
    assert.ok(
      !detail.includes(NO_WORKSPACE_WRITTEN_WARNING),
      'the dialog asserted a write that had not happened'
    );
    assert.ok(detail.includes('Nothing has been changed yet'), detail);
  });

  it('CANCELLING (Escape / the dialog Cancel) writes NOTHING', async () => {
    const vscode = makeVscodeMock({ answer: undefined });
    const result = await confirmAndApplyDefaultFormatter(
      vscode,
      planFor(['css', 'html', 'json'])
    );
    assert.equal(result.outcome, 'cancelled');
    assert.deepEqual(vscode.calls, [], 'a cancelled recap must write NOTHING');
    assert.equal(vscode.workspaceStore.size, 0);
    assert.equal(vscode.globalStore.size, 0);
  });

  it('any answer other than the confirm action writes NOTHING', async () => {
    const answers = ['Cancel', 'Not now', '', 'set tidy as default formatter'];
    for (const answer of answers) {
      const vscode = makeVscodeMock({ answer });
      const result = await confirmAndApplyDefaultFormatter(
        vscode,
        planFor(['css'])
      );
      assert.equal(result.outcome, 'cancelled', `answer: ${answer}`);
      assert.deepEqual(
        vscode.calls,
        [],
        `answer "${answer}" must write nothing`
      );
    }
  });

  it('confirming writes exactly one defaultFormatter key per language', async () => {
    const vscode = makeVscodeMock({ answer: DEFAULT_FORMATTER_CONFIRM_ACTION });
    const result = await confirmAndApplyDefaultFormatter(
      vscode,
      planFor(['css', 'html'])
    );
    assert.equal(result.outcome, 'written');
    assert.deepEqual(vscode.calls, [
      {
        lang: 'css',
        key: 'defaultFormatter',
        value: EXTENSION_ID,
        target: 'WS',
        overrideInLanguage: true
      },
      {
        lang: 'html',
        key: 'defaultFormatter',
        value: EXTENSION_ID,
        target: 'WS',
        overrideInLanguage: true
      }
    ]);
  });

  it('writes at the Global target for a User-scope plan', async () => {
    const vscode = makeVscodeMock({ answer: DEFAULT_FORMATTER_CONFIRM_ACTION });
    await confirmAndApplyDefaultFormatter(vscode, planFor(['css'], 'global'));
    assert.equal(vscode.calls.length, 1);
    assert.equal(vscode.calls[0].target, 'GLOBAL');
  });

  it('writes ONLY the keys the recap listed (already-Tidy skipped)', async () => {
    const vscode = makeVscodeMock({
      answer: DEFAULT_FORMATTER_CONFIRM_ACTION,
      workspaceValues: { css: EXTENSION_ID }
    });
    const result = await confirmAndApplyDefaultFormatter(
      vscode,
      planFor(['css', 'html'])
    );
    assert.equal(result.outcome, 'written');
    assert.deepEqual(
      vscode.calls.map((call) => call.lang),
      ['html']
    );
  });

  it('asks nothing and writes nothing when every language is already Tidy', async () => {
    const vscode = makeVscodeMock({
      answer: DEFAULT_FORMATTER_CONFIRM_ACTION,
      workspaceValues: { css: EXTENSION_ID, html: EXTENSION_ID }
    });
    const result = await confirmAndApplyDefaultFormatter(
      vscode,
      planFor(['css', 'html'])
    );
    assert.equal(result.outcome, 'nothing-to-write');
    assert.deepEqual(vscode.calls, []);
    assert.deepEqual(
      vscode.shown,
      [],
      'no dialog when there is nothing to write'
    );
  });

  it('fails CLOSED when the current settings cannot be read', async () => {
    const vscode = makeVscodeMock({
      answer: DEFAULT_FORMATTER_CONFIRM_ACTION,
      throwOnInspect: true
    });
    const result = await confirmAndApplyDefaultFormatter(
      vscode,
      planFor(['css'])
    );
    assert.equal(result.outcome, 'read-failed');
    assert.deepEqual(vscode.calls, [], 'no readable state => no write');
    assert.deepEqual(vscode.shown, [], 'no recap can be shown, so none is');
    if (result.outcome === 'read-failed') {
      assert.equal(result.cause, 'simulated inspect failure');
      assert.ok(!result.cause.includes('\n'));
    }
  });

  it('reports a failed write instead of throwing', async () => {
    const vscode = makeVscodeMock({
      answer: DEFAULT_FORMATTER_CONFIRM_ACTION,
      throwOnUpdate: true
    });
    const result = await confirmAndApplyDefaultFormatter(
      vscode,
      planFor(['css'])
    );
    assert.equal(result.outcome, 'write-failed');
    if (result.outcome === 'write-failed') {
      assert.equal(result.cause, 'simulated write failure');
    }
  });

  it('the confirm strings are English, ASCII and em-dash-free', () => {
    for (const label of [
      DEFAULT_FORMATTER_CONFIRM_ACTION,
      DEFAULT_FORMATTER_CONFIRM_TITLE
    ]) {
      assert.match(label, /^[\x20-\x7E]*$/, `ASCII only: ${label}`);
      assert.ok(!label.includes(EM_DASH_CHAR));
    }
    assert.match(
      DEFAULT_FORMATTER_CONFIRM_ACTION,
      /Set Tidy as default formatter/
    );
  });
});

describe('commands/useAsFormatter : both consent recaps share ONE grammar', () => {
  // Drift lock: the defaultFormatter recap was added in v0.4.0 by reusing the
  // format-on-save recap mechanism. If either wording moves without the other,
  // the two consent paths have drifted and this test says so.
  for (const target of ['workspace', 'global'] as const) {
    it(`both name the ${scopeLabelOf(target)} scope with the same header`, () => {
      const header = `Tidy will write exactly these keys at the ${scopeLabelOf(
        target
      )} scope:`;
      const formatterDetail = defaultFormatterRecapDetail(
        planDefaultFormatterRecap(
          planUseAsFormatter(['css'], true, target),
          currentValues({})
        )
      );
      const onSaveDetail = formatOnSaveRecapDetail(
        planFormatOnSaveWrites(['css'], target, new Map())
      );
      assert.ok(formatterDetail.startsWith(header), formatterDetail);
      assert.ok(onSaveDetail.startsWith(header), onSaveDetail);
    });
  }

  it('both make the same zero-writes-until-confirm promise', () => {
    const formatterDetail = defaultFormatterRecapDetail(
      planDefaultFormatterRecap(
        planUseAsFormatter(['css'], true, 'workspace'),
        currentValues({})
      )
    );
    const onSaveDetail = formatOnSaveRecapDetail(
      planFormatOnSaveWrites(['css'], 'workspace', new Map())
    );
    for (const detail of [formatterDetail, onSaveDetail]) {
      assert.ok(detail.includes('Nothing has been changed yet'), detail);
    }
  });

  it('both render one key per line in the same shape', () => {
    const formatterDetail = defaultFormatterRecapDetail(
      planDefaultFormatterRecap(
        planUseAsFormatter(['css'], true, 'workspace'),
        currentValues({})
      )
    );
    const onSaveDetail = formatOnSaveRecapDetail(
      planFormatOnSaveWrites(['css'], 'workspace', new Map())
    );
    assert.ok(
      formatterDetail.includes(
        `  "[css]": { "editor.defaultFormatter": "${EXTENSION_ID}" }`
      )
    );
    assert.ok(
      onSaveDetail.includes('  "[css]": { "editor.formatOnSave": true }')
    );
  });
});

describe('commands/useAsFormatter : source invariants (anti-hijack)', () => {
  const REPO_ROOT = path.resolve(__dirname, '../../..');
  const read = (relativePath: string): string =>
    readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
  const source = read('src/commands/useAsFormatter.ts');
  const core = read('src/commands/setDefaultFormatter.ts');

  it('the ONLY defaultFormatter write goes through the confirmed core', () => {
    // The write literal lives in setDefaultFormatter.ts and nowhere else, and
    // this module reaches it through a single call site.
    assert.ok(core.includes(".update('defaultFormatter', EXTENSION_ID"));
    assert.ok(!source.includes(".update('defaultFormatter'"));
    assert.equal(
      source.split('setDefaultFormatterForLangs(').length - 1,
      1,
      'exactly one call site for the formatter write'
    );
  });

  it('asks for an explicit modal recap before that write', () => {
    assert.ok(source.includes('modal: true'));
    assert.ok(source.includes('defaultFormatterRecapDetail(recap)'));
    // The write helper is invoked only after the confirm comparison.
    const confirmIndex = source.indexOf(
      'confirmed !== DEFAULT_FORMATTER_CONFIRM_ACTION'
    );
    const applyIndex = source.indexOf('await applyPlan(vscode, recap)');
    assert.ok(
      confirmIndex > 0 && applyIndex > confirmIndex,
      'the confirm check must precede the write'
    );
  });

  it('the past-tense warning is reachable ONLY after a successful write', () => {
    // The pre-write dialog renders pendingWarningTextOf; the post-write toast
    // renders writtenWarningTextOf, and only inside the `outcome === 'written'`
    // branch. Neither renderer may appear on the other side of the write.
    assert.equal(
      source.split('pendingWarningTextOf(').length - 1,
      2,
      'one declaration + exactly one call site (the modal recap)'
    );
    assert.equal(
      source.split('writtenWarningTextOf(').length - 1,
      2,
      'one declaration + exactly one call site (the post-write toast)'
    );
    assert.ok(
      source.includes('lines.push(pendingWarningTextOf(recap.warningCode));'),
      'the modal must render the conditional wording'
    );
    const writtenGuard = source.indexOf(
      "consent.outcome === 'written' && plan.warningCode !== undefined"
    );
    const writtenCall = source.indexOf(
      'writtenWarningTextOf(plan.warningCode)'
    );
    assert.ok(
      writtenGuard > 0 && writtenCall > writtenGuard,
      'the past-tense toast must sit inside the written-outcome guard'
    );
    // And the plan itself stores a code, never ready-made prose.
    assert.ok(
      source.includes("warningCode: 'workspace-fallback'"),
      'the planner must store a reason code, not a sentence'
    );
    assert.ok(
      !source.includes('warning?: string'),
      'a plan holding prose is what let a past-tense claim into the dialog'
    );
  });

  it('installs no save hook and no file watcher of any kind', () => {
    for (const needle of [
      'onDidSaveTextDocument',
      'onWillSaveTextDocument',
      'onDidChangeTextDocument',
      'createFileSystemWatcher'
    ]) {
      assert.ok(!source.includes(needle), `forbidden hook: ${needle}`);
      assert.ok(!core.includes(needle), `forbidden hook in core: ${needle}`);
    }
  });

  it('never writes editor.formatOnSave from this path', () => {
    assert.ok(!source.includes("update('formatOnSave'"));
    assert.ok(!core.includes("update('formatOnSave'"));
  });

  it('carries no em dash (U+2014)', () => {
    assert.ok(!source.includes(EM_DASH_CHAR));
    assert.ok(!core.includes(EM_DASH_CHAR));
  });
});
