// Unit tests for the PURE part of "Tidy: Show Format History" (statusIcon,
// relativeAge, neutralizeIconSyntax, buildHistoryItems). Imports no 'vscode'
// (the handler requires it lazily), so this loads under plain mocha+tsx.
// Locks the content-free contract (nothing but name/language/status/age and
// the sanitized detail is rendered), the three-codicon vocabulary, the icon
// anti-spoofing, and the em-dash ban.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import {
  SHOW_FORMAT_HISTORY_COMMAND_ID,
  EMPTY_HISTORY_MESSAGE,
  statusIcon,
  relativeAge,
  neutralizeIconSyntax,
  buildHistoryItems,
  type HistoryIcon
} from '../../../src/commands/showFormatHistory';
import type {
  FormatStatus,
  LastFormatRecord
} from '../../../src/diagnostics/lastFormat';

const EM_DASH = '\u2014';
const NOW = Date.parse('2026-07-29T12:00:00.000Z');

function rec(over: Partial<LastFormatRecord> = {}): LastFormatRecord {
  return {
    uri: 'file:///w/app.css',
    fileName: 'app.css',
    languageId: 'css',
    status: 'applied',
    scope: 'document',
    at: '2026-07-29T11:59:48.000Z', // exactly 12s before NOW
    ...over
  };
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

describe('commands/showFormatHistory : constants', () => {
  it('exposes the stable command id', () => {
    assert.equal(SHOW_FORMAT_HISTORY_COMMAND_ID, 'tidy.showFormatHistory');
  });

  it('the empty-history message is English, actionable and em-dash-free', () => {
    assert.match(EMPTY_HISTORY_MESSAGE, /Format Document/);
    assert.ok(!EMPTY_HISTORY_MESSAGE.includes(EM_DASH), 'no em dash');
  });
});

describe('commands/showFormatHistory : statusIcon', () => {
  it('maps every status to one of the three product codicons', () => {
    const allowed: HistoryIcon[] = ['check', 'shield', 'circle-slash'];
    for (const s of ALL_STATUSES) {
      assert.ok(allowed.includes(statusIcon(s)), `icon for ${s}`);
    }
  });

  it('success bucket: applied and already-tidy render check', () => {
    assert.equal(statusIcon('applied'), 'check');
    assert.equal(statusIcon('already-tidy'), 'check');
  });

  it('safety bucket: guard-rejected and restore-failed render shield', () => {
    assert.equal(statusIcon('guard-rejected'), 'shield');
    assert.equal(statusIcon('restore-failed'), 'shield');
  });

  it('every remaining status renders circle-slash', () => {
    const rest: FormatStatus[] = [
      'engine-error',
      'config-error',
      'too-large',
      'ignored-file',
      'ignored-marker',
      'disabled',
      'unsupported',
      'cancelled'
    ];
    for (const s of rest) {
      assert.equal(statusIcon(s), 'circle-slash', s);
    }
  });
});

describe('commands/showFormatHistory : relativeAge', () => {
  it('sub-second reads "just now"', () => {
    assert.equal(relativeAge(new Date(NOW - 400).toISOString(), NOW), 'just now');
  });

  it('seconds, minutes, hours, days', () => {
    assert.equal(relativeAge(new Date(NOW - 12_000).toISOString(), NOW), '12s ago');
    assert.equal(relativeAge(new Date(NOW - 3 * 60_000).toISOString(), NOW), '3m ago');
    assert.equal(
      relativeAge(new Date(NOW - 2 * 3_600_000).toISOString(), NOW),
      '2h ago'
    );
    assert.equal(
      relativeAge(new Date(NOW - 5 * 86_400_000).toISOString(), NOW),
      '5d ago'
    );
  });

  it('boundaries floor correctly (59s stays seconds, 60s becomes minutes)', () => {
    assert.equal(relativeAge(new Date(NOW - 59_999).toISOString(), NOW), '59s ago');
    assert.equal(relativeAge(new Date(NOW - 60_000).toISOString(), NOW), '1m ago');
  });

  it('ADVERSARIAL: a future timestamp clamps to "just now" (never a negative age)', () => {
    assert.equal(relativeAge(new Date(NOW + 60_000).toISOString(), NOW), 'just now');
  });

  it('ADVERSARIAL: an unparsable timestamp degrades to "unknown time" without throwing', () => {
    assert.equal(relativeAge('not-a-date', NOW), 'unknown time');
  });
});

describe('commands/showFormatHistory : buildHistoryItems', () => {
  it('renders "[icon] file" / "lang, status, age" exactly', () => {
    const [item] = buildHistoryItems([rec()], NOW);
    assert.equal(item.label, '$(check) app.css');
    assert.equal(item.description, 'css, applied, 12s ago');
    assert.equal(item.detail, undefined);
    assert.ok(!('detail' in item), 'detail key omitted when the record has none');
    assert.equal(item.index, 0);
  });

  it('marks selection scope inside the description', () => {
    const [item] = buildHistoryItems([rec({ scope: 'selection' })], NOW);
    assert.equal(item.description, 'css, applied (selection), 12s ago');
  });

  it('a guard rejection renders shield and carries the sanitized reason as detail', () => {
    const [item] = buildHistoryItems(
      [rec({ status: 'guard-rejected', detail: 'comment removed by engine' })],
      NOW
    );
    assert.equal(item.label, '$(shield) app.css');
    assert.equal(item.detail, 'comment removed by engine');
  });

  it('preserves the newest-first order and indexes back into the input array', () => {
    const items = buildHistoryItems(
      [rec({ fileName: 'newest.css' }), rec({ fileName: 'older.css' })],
      NOW
    );
    assert.equal(items[0].label, '$(check) newest.css');
    assert.equal(items[0].index, 0);
    assert.equal(items[1].label, '$(check) older.css');
    assert.equal(items[1].index, 1);
  });

  it('ADVERSARIAL: a file named like a codicon cannot spoof a status icon', () => {
    const [item] = buildHistoryItems(
      [
        rec({
          fileName: '$(check) pwned.css',
          status: 'guard-rejected',
          detail: 'x $(shield) y'
        })
      ],
      NOW
    );
    assert.equal(item.label, '$(shield) $ (check) pwned.css');
    assert.equal(item.detail, 'x $ (shield) y');
  });

  it('ADVERSARIAL: a corrupted timestamp renders "unknown time", never a throw', () => {
    const [item] = buildHistoryItems([rec({ at: 'corrupted' })], NOW);
    assert.equal(item.description, 'css, applied, unknown time');
  });

  it('no rendered text ever contains an em dash or the literal string "undefined"', () => {
    const items = buildHistoryItems(
      ALL_STATUSES.map((status) => rec({ status })),
      NOW
    );
    for (const item of items) {
      const all = `${item.label} ${item.description} ${item.detail ?? ''}`;
      assert.ok(!all.includes(EM_DASH), `no em dash: ${all}`);
      assert.ok(!all.includes('undefined'), `no literal undefined: ${all}`);
    }
  });

  it('an empty history builds no item at all (the handler shows a toast instead)', () => {
    assert.deepEqual(buildHistoryItems([], NOW), []);
  });
});

describe('commands/showFormatHistory : neutralizeIconSyntax', () => {
  it('breaks every "$(" pair, leaves everything else verbatim', () => {
    assert.equal(neutralizeIconSyntax('$(a)$(b) x'), '$ (a)$ (b) x');
    assert.equal(neutralizeIconSyntax('plain.css'), 'plain.css');
    assert.equal(neutralizeIconSyntax('price$100(net)'), 'price$100(net)');
  });
});

describe('commands/showFormatHistory : privacy and anti-hijack (source scan)', () => {
  // Structural guarantees that cannot be asserted through the pure API: the
  // module must never persist, never phone home, and never install a hook.
  const SOURCE = readFileSync(
    path.resolve(__dirname, '../../../src/commands/showFormatHistory.ts'),
    'utf8'
  );

  it('persists nothing (no globalState, no workspaceState, no fs write)', () => {
    for (const forbidden of [
      'globalState',
      'workspaceState',
      'writeFile',
      'writeFileSync'
    ]) {
      assert.ok(!SOURCE.includes(forbidden), `must not use ${forbidden}`);
    }
  });

  it('registers no hook, no listener and writes no setting', () => {
    for (const forbidden of [
      'onDidSave',
      'onWillSave',
      'onDidChange',
      'onDidChangeActiveTextEditor',
      'defaultFormatter',
      '.update('
    ]) {
      assert.ok(!SOURCE.includes(forbidden), `must not use ${forbidden}`);
    }
  });

  it('makes no network call and sends no telemetry', () => {
    for (const forbidden of ['fetch(', 'http', 'telemetry', 'Telemetry']) {
      assert.ok(!SOURCE.includes(forbidden), `must not reference ${forbidden}`);
    }
  });

  it('ships no em dash', () => {
    assert.ok(!SOURCE.includes(EM_DASH), 'no em dash in the shipped source');
  });
});
