// Unit tests for the PURE part of "Tidy: Explain last format" (buildExplanation).
// Imports no 'vscode' (the handler requires it lazily), so this loads under plain
// mocha+tsx. Also asserts the whole point of v0.2.0: every explanation is em-dash-free.
import assert from 'node:assert/strict';
import {
  buildExplanation,
  EXPLAIN_LAST_FORMAT_COMMAND_ID,
  ACTION_REPORT_ISSUE_LABEL,
  ACTION_OPEN_SETTINGS_LABEL,
  ACTION_OPEN_IGNORE_FILE_LABEL,
  ACTION_USE_TIDY_LABEL,
  OPEN_SETTINGS_COMMAND_ID,
  OPEN_FILE_COMMAND_ID,
  type ExplainContext,
  type ExplanationAction
} from '../../../src/commands/explainLastFormat';
import type {
  FormatStatus,
  LastFormatRecord
} from '../../../src/diagnostics/lastFormat';

const ACTIVE_URI = 'file:///w/app.css';

function rec(status: FormatStatus, over: Partial<LastFormatRecord> = {}): LastFormatRecord {
  return {
    uri: ACTIVE_URI,
    fileName: 'app.css',
    languageId: 'css',
    status,
    scope: 'document',
    at: '2026-07-24T00:00:00.000Z',
    ...over
  };
}

function ctx(o: Partial<ExplainContext> = {}): ExplainContext {
  return { activeUri: ACTIVE_URI, activeLanguageId: 'css', ...o };
}

const ALL_STATUSES: FormatStatus[] = [
  'applied',
  'already-tidy',
  'guard-rejected',
  'engine-error',
  'restore-failed',
  'config-error',
  'too-large',
  'ignored-file',
  'ignored-marker',
  'disabled',
  'unsupported',
  'cancelled'
];

describe('commands/explainLastFormat : buildExplanation', () => {
  it('exposes the stable command id', () => {
    assert.equal(EXPLAIN_LAST_FORMAT_COMMAND_ID, 'tidy.explainLastFormat');
  });

  it('asks the user to open a file when there is no active editor', () => {
    const e = buildExplanation(undefined, {});
    assert.match(e.headline, /open a file/i);
  });

  it('every matching status yields a non-empty, em-dash-free explanation', () => {
    for (const s of ALL_STATUSES) {
      const e = buildExplanation(rec(s), ctx());
      assert.ok(e.headline.length > 0, `headline for ${s}`);
      const all = [e.headline, ...e.lines].join(' ');
      assert.ok(!all.includes('\u2014'), `no em dash for ${s}`);
    }
  });

  it('guard-rejected explains the safety guard and surfaces the reason', () => {
    const e = buildExplanation(
      rec('guard-rejected', { detail: 'JSX tag boundary changed' }),
      ctx()
    );
    assert.match(e.headline, /did nothing on purpose/i);
    assert.ok(e.lines.some((l) => l.includes('JSX tag boundary changed')));
    assert.ok(e.lines.some((l) => /safety guard/i.test(l)));
  });

  it('already-tidy says the file was already formatted', () => {
    const e = buildExplanation(rec('already-tidy', { engineId: 'js-beautify' }), ctx());
    assert.match(e.headline, /already formatted/i);
  });

  it('disabled names the per-language enable setting', () => {
    const e = buildExplanation(rec('disabled', { languageId: 'json' }), {
      activeUri: ACTIVE_URI,
      activeLanguageId: 'json'
    });
    assert.match(e.lines.join(' '), /tidy\.json\.enable/);
  });

  it('too-large surfaces the applied cap, its key and its source', () => {
    const e = buildExplanation(
      rec('too-large', { detail: '5120 KB via tidy.maxFileSizeKB (default)' }),
      ctx()
    );
    assert.match(
      e.lines.join(' '),
      /Limit: 5120 KB via tidy\.maxFileSizeKB \(default\)\./
    );
  });

  it('too-large for a json record names the json family cap', () => {
    const e = buildExplanation(
      rec('too-large', {
        languageId: 'json',
        detail: '10240 KB via tidy.json.maxFileSizeKB (default)'
      }),
      ctx()
    );
    assert.match(e.lines.join(' '), /tidy\.json\.maxFileSizeKB/);
    assert.ok(e.lines.some((l) => /set it to 0/.test(l)));
  });

  it('no record + unsupported language explains Tidy does not handle it', () => {
    const e = buildExplanation(undefined, {
      activeUri: 'file:///w/x.md',
      activeLanguageId: 'markdown'
    });
    assert.match(e.headline, /does not handle markdown/i);
  });

  it('no record + another default formatter names it and how to switch', () => {
    const e = buildExplanation(undefined, {
      activeUri: 'file:///w/x.ts',
      activeLanguageId: 'typescript',
      defaultFormatter: 'esbenp.prettier-vscode'
    });
    assert.match(e.headline, /another formatter owns typescript/i);
    assert.ok(e.lines.some((l) => l.includes('esbenp.prettier-vscode')));
    assert.ok(e.lines.some((l) => /Use Tidy as my Formatter/.test(l)));
  });

  it('no record + supported + Tidy is already the default -> not run yet', () => {
    const e = buildExplanation(undefined, {
      activeUri: 'file:///w/x.css',
      activeLanguageId: 'css',
      defaultFormatter: 'ced-lab.tidy-formatter'
    });
    assert.match(e.headline, /not formatted this file yet/i);
  });

  it('a record for a DIFFERENT file is ignored (falls through to no-record path)', () => {
    const e = buildExplanation(rec('applied'), {
      activeUri: 'file:///w/other.css',
      activeLanguageId: 'css'
    });
    assert.match(e.headline, /not formatted this file yet|another formatter/i);
  });
});

// ADD-06: the status -> remedy mapping is the single source of truth for both the
// Explain command and the provider toasts, so it is pinned here status by status.
describe('commands/explainLastFormat : actions mapping (ADD-06)', () => {
  const KNOWN_LABELS = new Set([
    ACTION_REPORT_ISSUE_LABEL,
    ACTION_OPEN_SETTINGS_LABEL,
    ACTION_OPEN_IGNORE_FILE_LABEL,
    ACTION_USE_TIDY_LABEL
  ]);

  function actionsOf(e: {
    actions?: readonly ExplanationAction[];
  }): readonly ExplanationAction[] {
    return e.actions ?? [];
  }

  it('exposes stable English button captions and the host command ids', () => {
    assert.equal(ACTION_REPORT_ISSUE_LABEL, 'Report an Issue');
    assert.equal(ACTION_OPEN_SETTINGS_LABEL, 'Open Settings');
    assert.equal(ACTION_OPEN_IGNORE_FILE_LABEL, 'Open .soukformatignore');
    assert.equal(ACTION_USE_TIDY_LABEL, 'Use Tidy as my Formatter');
    assert.equal(OPEN_SETTINGS_COMMAND_ID, 'workbench.action.openSettings');
    assert.equal(OPEN_FILE_COMMAND_ID, 'vscode.open');
  });

  it('guard-rejected offers exactly one Report an Issue action wired to tidy.reportIssue', () => {
    const e = buildExplanation(rec('guard-rejected', { detail: 'not equivalent' }), ctx());
    const a = actionsOf(e);
    assert.equal(a.length, 1);
    assert.equal(a[0].label, ACTION_REPORT_ISSUE_LABEL);
    assert.equal(a[0].commandId, 'tidy.reportIssue');
    assert.equal(a[0].args, undefined);
  });

  it('engine-error offers Report an Issue', () => {
    const a = actionsOf(buildExplanation(rec('engine-error', { detail: 'boom' }), ctx()));
    assert.equal(a.length, 1);
    assert.equal(a[0].commandId, 'tidy.reportIssue');
  });

  it('restore-failed offers Report an Issue (same remedy class as engine-error)', () => {
    const a = actionsOf(buildExplanation(rec('restore-failed'), ctx()));
    assert.equal(a.length, 1);
    assert.equal(a[0].commandId, 'tidy.reportIssue');
  });

  it('disabled offers Open Settings targeting tidy.<lang>.enable for the record language', () => {
    const e = buildExplanation(rec('disabled', { languageId: 'json' }), {
      activeUri: ACTIVE_URI,
      activeLanguageId: 'json'
    });
    const a = actionsOf(e);
    assert.equal(a.length, 1);
    assert.equal(a[0].label, ACTION_OPEN_SETTINGS_LABEL);
    assert.equal(a[0].commandId, OPEN_SETTINGS_COMMAND_ID);
    assert.deepEqual(a[0].args, ['tidy.json.enable']);
  });

  it('too-large offers Open Settings targeting tidy.maxFileSizeKB', () => {
    const a = actionsOf(
      buildExplanation(
        rec('too-large', { detail: '5120 KB via tidy.maxFileSizeKB (default)' }),
        ctx()
      )
    );
    assert.equal(a.length, 1);
    assert.equal(a[0].commandId, OPEN_SETTINGS_COMMAND_ID);
    assert.deepEqual(a[0].args, ['tidy.maxFileSizeKB']);
  });

  it('too-large on a json record targets the json family cap instead (ADD-08)', () => {
    const a = actionsOf(
      buildExplanation(
        rec('too-large', {
          languageId: 'json',
          detail: '10240 KB via tidy.json.maxFileSizeKB (default)'
        }),
        ctx()
      )
    );
    assert.equal(a.length, 1);
    assert.deepEqual(a[0].args, ['tidy.json.maxFileSizeKB']);
  });

  it('too-large with a legacy or missing detail falls back to the generic key', () => {
    const a = actionsOf(buildExplanation(rec('too-large'), ctx()));
    assert.equal(a.length, 1);
    assert.deepEqual(a[0].args, ['tidy.maxFileSizeKB']);
  });

  it('ignored-file with a stored path offers Open .soukformatignore via vscode.open, and surfaces the path in the lines', () => {
    const p = '/w/project/.soukformatignore';
    const e = buildExplanation(rec('ignored-file', { detail: p }), ctx());
    const a = actionsOf(e);
    assert.equal(a.length, 1);
    assert.equal(a[0].label, ACTION_OPEN_IGNORE_FILE_LABEL);
    assert.equal(a[0].commandId, OPEN_FILE_COMMAND_ID);
    assert.deepEqual(a[0].args, [p]);
    assert.ok(e.lines.some((l) => l.includes(p)));
  });

  it('ignored-file accepts a Windows-style absolute path unchanged (host converts it)', () => {
    const p = 'C:\\w\\project\\.soukformatignore';
    const a = actionsOf(buildExplanation(rec('ignored-file', { detail: p }), ctx()));
    assert.deepEqual(a[0].args, [p]);
  });

  it('ignored-file WITHOUT a stored path offers no action (older record, gate off)', () => {
    const e = buildExplanation(rec('ignored-file'), ctx());
    assert.equal(actionsOf(e).length, 0);
    assert.ok(e.lines.length > 0, 'the textual explanation must still stand alone');
  });

  it('ADVERSARIAL: an ignore path truncated by sanitizeDetail (trailing "...") offers no action', () => {
    const truncated = `/w/${'x'.repeat(194)}...`;
    const a = actionsOf(buildExplanation(rec('ignored-file', { detail: truncated }), ctx()));
    assert.equal(a.length, 0, 'an unusable, truncated path must never become an Open action');
  });

  it('ADVERSARIAL: an empty stored ignore path offers no action', () => {
    const a = actionsOf(buildExplanation(rec('ignored-file', { detail: '' }), ctx()));
    assert.equal(a.length, 0);
  });

  it('no record + another default formatter offers Use Tidy as my Formatter', () => {
    const e = buildExplanation(undefined, {
      activeUri: 'file:///w/x.ts',
      activeLanguageId: 'typescript',
      defaultFormatter: 'esbenp.prettier-vscode'
    });
    const a = actionsOf(e);
    assert.equal(a.length, 1);
    assert.equal(a[0].label, ACTION_USE_TIDY_LABEL);
    assert.equal(a[0].commandId, 'tidy.useAsFormatter');
  });

  it('statuses with no one-click remedy offer no actions (spec: unsupported => none)', () => {
    for (const s of [
      'applied',
      'already-tidy',
      'ignored-marker',
      'config-error',
      'cancelled',
      'unsupported'
    ] as const) {
      const a = actionsOf(buildExplanation(rec(s), ctx()));
      assert.equal(a.length, 0, `no action expected for ${s}`);
    }
  });

  it('the no-editor and not-run-yet paths offer no actions', () => {
    assert.equal(actionsOf(buildExplanation(undefined, {})).length, 0);
    assert.equal(
      actionsOf(
        buildExplanation(undefined, {
          activeUri: 'file:///w/x.css',
          activeLanguageId: 'css',
          defaultFormatter: 'ced-lab.tidy-formatter'
        })
      ).length,
      0
    );
  });

  it('an unsupported active language with no record offers no action either', () => {
    const a = actionsOf(
      buildExplanation(undefined, {
        activeUri: 'file:///w/x.md',
        activeLanguageId: 'markdown',
        defaultFormatter: 'esbenp.prettier-vscode'
      })
    );
    assert.equal(a.length, 0);
  });

  it('every action across every status has a known English label, a non-empty commandId, unique labels, and no em dash', () => {
    for (const s of ALL_STATUSES) {
      const e = buildExplanation(rec(s, { detail: '/w/.soukformatignore' }), ctx());
      const a = actionsOf(e);
      const labels = a.map((x) => x.label);
      assert.equal(new Set(labels).size, labels.length, `duplicate labels for ${s}`);
      for (const action of a) {
        assert.ok(KNOWN_LABELS.has(action.label), `unknown label for ${s}: ${action.label}`);
        assert.ok(action.commandId.length > 0, `empty commandId for ${s}`);
        assert.ok(!action.label.includes('\u2014'), `em dash in label for ${s}`);
      }
    }
  });

  it('action args only ever carry plain strings (the builder stays vscode-free)', () => {
    for (const s of ALL_STATUSES) {
      const e = buildExplanation(rec(s, { detail: '/w/.soukformatignore' }), ctx());
      for (const action of actionsOf(e)) {
        for (const arg of action.args ?? []) {
          assert.equal(typeof arg, 'string', `non-string arg for ${s}`);
        }
      }
    }
  });
});
