// Unit tests for the PURE deference decision logic (Axe 4 / 4.T5).
//
// PURE (no 'vscode'): the whole module is host-free, so this just imports + asserts.
//
// Coverage focus (anti-hijack + anti-nag, ROADMAP 4.T5 acceptance):
//   - default setting is 'notify';
//   - notify once per workspace, then dedup (alreadyPrompted => 'none');
//   - 'off' => no detection acted on at all;
//   - 'silent-defer' => 'defer', never a notification, never a write;
//   - no competitor => 'none' regardless of setting;
//   - the message never instructs disabling anything and surfaces the names + the
//     "your default formatter is unchanged" promise;
//   - normalizeSetting maps unknown/missing values to the default.
import assert from 'node:assert/strict';
import {
  decide,
  normalizeSetting,
  formatDeferenceMessage,
  DEFAULT_DEFERENCE_SETTING,
  DEFERENCE_SETTING_KEY,
  DEFERENCE_PROMPTED_KEY,
  type DeferenceSetting
} from '../../../src/deference/decide';
import { FORMATTER_PRETTIER, FORMATTER_BIOME, FORMATTER_DPRINT } from '../../../src/deference/detect';

const PRETTIER_ONLY = [FORMATTER_PRETTIER];

describe('deference/decide — constants', () => {
  it('defaults to notify (surface, never silently disable)', () => {
    assert.equal(DEFAULT_DEFERENCE_SETTING, 'notify');
  });

  it('exposes stable setting + globalState keys', () => {
    assert.equal(DEFERENCE_SETTING_KEY, 'tidy.deferToOtherFormatters');
    assert.equal(DEFERENCE_PROMPTED_KEY, 'tidy.deference.prompted');
  });
});

describe('deference/decide — no competitor', () => {
  it('returns none for an empty list, for every setting', () => {
    const settings: DeferenceSetting[] = ['notify', 'silent-defer', 'off'];
    for (const setting of settings) {
      assert.deepEqual(decide([], setting, false), { action: 'none' });
      assert.deepEqual(decide([], setting, true), { action: 'none' });
    }
  });

  it('returns none defensively for a non-array detected input', () => {
    assert.deepEqual(
      decide(undefined as unknown as string[], 'notify', false),
      { action: 'none' }
    );
  });
});

describe('deference/decide — notify (one-shot)', () => {
  it('notifies with a message when a competitor is present and not yet prompted', () => {
    const decision = decide(PRETTIER_ONLY, 'notify', false);
    assert.equal(decision.action, 'notify');
    assert.ok(typeof decision.message === 'string' && decision.message.length > 0);
  });

  it('does NOT notify again once already prompted (dedup => none)', () => {
    assert.deepEqual(decide(PRETTIER_ONLY, 'notify', true), { action: 'none' });
  });
});

describe('deference/decide — silent-defer (never notifies, never writes)', () => {
  it('returns defer when a competitor is present', () => {
    assert.deepEqual(decide(PRETTIER_ONLY, 'silent-defer', false), { action: 'defer' });
  });

  it('returns defer regardless of the prompted flag (no notification involved)', () => {
    assert.deepEqual(decide(PRETTIER_ONLY, 'silent-defer', true), { action: 'defer' });
  });

  it('carries no message (nothing is surfaced)', () => {
    assert.equal(decide(PRETTIER_ONLY, 'silent-defer', false).message, undefined);
  });
});

describe('deference/decide — off (detection ignored entirely)', () => {
  it('returns none even with competitors present, unprompted', () => {
    assert.deepEqual(decide([FORMATTER_BIOME], 'off', false), { action: 'none' });
  });
});

describe('deference/decide — full truth table', () => {
  it('matches the documented matrix', () => {
    const table: Array<[boolean, DeferenceSetting, boolean, 'notify' | 'defer' | 'none']> = [
      // hasCompetitor, setting, alreadyPrompted, expectedAction
      [false, 'notify', false, 'none'],
      [false, 'silent-defer', false, 'none'],
      [false, 'off', false, 'none'],
      [true, 'off', false, 'none'],
      [true, 'silent-defer', false, 'defer'],
      [true, 'silent-defer', true, 'defer'],
      [true, 'notify', false, 'notify'],
      [true, 'notify', true, 'none']
    ];
    for (const [hasCompetitor, setting, prompted, expected] of table) {
      const detected = hasCompetitor ? PRETTIER_ONLY : [];
      assert.equal(
        decide(detected, setting, prompted).action,
        expected,
        `competitor=${hasCompetitor}, setting=${setting}, prompted=${prompted}`
      );
    }
  });
});

describe('deference/decide — formatDeferenceMessage', () => {
  it('names a single formatter and promises the default formatter is unchanged', () => {
    const message = formatDeferenceMessage(PRETTIER_ONLY);
    assert.ok(message.includes('Prettier'));
    assert.ok(message.includes('default formatter is unchanged'));
    assert.ok(message.includes('Tidy will not take over'));
  });

  it('joins two formatters with "and"', () => {
    const message = formatDeferenceMessage([FORMATTER_PRETTIER, FORMATTER_BIOME]);
    assert.ok(message.includes('Prettier and Biome'));
  });

  it('joins three formatters with an Oxford comma', () => {
    const message = formatDeferenceMessage([
      FORMATTER_PRETTIER,
      FORMATTER_BIOME,
      FORMATTER_DPRINT
    ]);
    assert.ok(message.includes('Prettier, Biome, and dprint'));
  });

  it('never instructs disabling another extension or formatOnSave', () => {
    const message = formatDeferenceMessage(PRETTIER_ONLY).toLowerCase();
    // Anti-hijack: deference never touches defaultFormatter / formatOnSave, and
    // never claims to disable the competitor — it only offers stepping Tidy back.
    assert.ok(!message.includes('formatonsave'));
    assert.ok(!message.includes('defaultformatter'));
    assert.ok(!message.includes('uninstall'));
  });
});

describe('deference/decide — normalizeSetting', () => {
  it('passes through the three known values', () => {
    assert.equal(normalizeSetting('notify'), 'notify');
    assert.equal(normalizeSetting('silent-defer'), 'silent-defer');
    assert.equal(normalizeSetting('off'), 'off');
  });

  it('defaults unknown / missing values to the default (notify)', () => {
    assert.equal(normalizeSetting('whatever'), DEFAULT_DEFERENCE_SETTING);
    assert.equal(normalizeSetting(undefined), DEFAULT_DEFERENCE_SETTING);
    assert.equal(normalizeSetting(null), DEFAULT_DEFERENCE_SETTING);
    assert.equal(normalizeSetting(42), DEFAULT_DEFERENCE_SETTING);
    assert.equal(normalizeSetting('Notify'), DEFAULT_DEFERENCE_SETTING); // case-sensitive
  });
});
