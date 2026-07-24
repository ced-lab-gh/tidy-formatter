// Unit tests for the PURE part of "Tidy: Explain last format" (buildExplanation).
// Imports no 'vscode' (the handler requires it lazily), so this loads under plain
// mocha+tsx. Also asserts the whole point of v0.2.0: every explanation is em-dash-free.
import assert from 'node:assert/strict';
import {
  buildExplanation,
  EXPLAIN_LAST_FORMAT_COMMAND_ID,
  type ExplainContext
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

describe('commands/explainLastFormat — buildExplanation', () => {
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
      assert.ok(!all.includes('—'), `no em dash for ${s}`);
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

  it('too-large surfaces the KB limit', () => {
    const e = buildExplanation(rec('too-large', { detail: '5120' }), ctx());
    assert.match(e.lines.join(' '), /5120 KB/);
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
