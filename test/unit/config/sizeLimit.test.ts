// Unit tests for the pure per-family size cap resolver (ADD-08).
// Locks the precedence contract: explicit json key > explicit global key >
// per-family default (10240 KB json/jsonc, 5120 KB otherwise), and the value
// rules (non-finite ignored, <= 0 disables, fractional floored).
import assert from 'node:assert/strict';
import {
  DEFAULT_MAX_FILE_SIZE_KB,
  JSON_DEFAULT_MAX_FILE_SIZE_KB,
  describeSizeLimit,
  resolveSizeLimit,
  settingKeyFromDescription
} from '../../../src/config/sizeLimit';

describe('config/sizeLimit : per-family defaults', () => {
  it('json falls back to the 10240 KB family default when nothing is set', () => {
    const limit = resolveSizeLimit({ languageId: 'json' });
    assert.equal(limit.limitKB, JSON_DEFAULT_MAX_FILE_SIZE_KB);
    assert.equal(limit.limitBytes, 10240 * 1024);
    assert.equal(limit.settingKey, 'tidy.json.maxFileSizeKB');
    assert.equal(limit.source, 'default');
  });

  it('jsonc follows the exact same family default as json', () => {
    const limit = resolveSizeLimit({ languageId: 'jsonc' });
    assert.equal(limit.limitKB, JSON_DEFAULT_MAX_FILE_SIZE_KB);
    assert.equal(limit.settingKey, 'tidy.json.maxFileSizeKB');
  });

  it('css keeps the 5120 KB global default when nothing is set', () => {
    const limit = resolveSizeLimit({ languageId: 'css' });
    assert.equal(limit.limitKB, DEFAULT_MAX_FILE_SIZE_KB);
    assert.equal(limit.settingKey, 'tidy.maxFileSizeKB');
    assert.equal(limit.source, 'default');
  });

  it('typescript keeps the 5120 KB global default (heavy family untouched)', () => {
    const limit = resolveSizeLimit({ languageId: 'typescript' });
    assert.equal(limit.limitKB, DEFAULT_MAX_FILE_SIZE_KB);
  });

  it('the json default is strictly higher than the generic one', () => {
    assert.ok(JSON_DEFAULT_MAX_FILE_SIZE_KB > DEFAULT_MAX_FILE_SIZE_KB);
  });
});

describe('config/sizeLimit : precedence', () => {
  it('an explicit tidy.json.maxFileSizeKB wins over an explicit global for json', () => {
    const limit = resolveSizeLimit({ languageId: 'json', globalKB: 1, jsonKB: 64 });
    assert.equal(limit.limitKB, 64);
    assert.equal(limit.settingKey, 'tidy.json.maxFileSizeKB');
    assert.equal(limit.source, 'user setting');
  });

  it('an explicit tidy.maxFileSizeKB applies to json when the family key is unset', () => {
    const limit = resolveSizeLimit({ languageId: 'json', globalKB: 1 });
    assert.equal(limit.limitKB, 1);
    assert.equal(limit.settingKey, 'tidy.maxFileSizeKB');
    assert.equal(limit.source, 'user setting');
  });

  it('the same precedence holds for jsonc', () => {
    const limit = resolveSizeLimit({ languageId: 'jsonc', globalKB: 1, jsonKB: 64 });
    assert.equal(limit.limitKB, 64);
    assert.equal(limit.settingKey, 'tidy.json.maxFileSizeKB');
  });

  it('an explicit tidy.json.maxFileSizeKB never affects css', () => {
    const limit = resolveSizeLimit({ languageId: 'css', jsonKB: 1 });
    assert.equal(limit.limitKB, DEFAULT_MAX_FILE_SIZE_KB);
    assert.equal(limit.settingKey, 'tidy.maxFileSizeKB');
    assert.equal(limit.source, 'default');
  });

  it('an explicit tidy.json.maxFileSizeKB never affects javascript either', () => {
    const limit = resolveSizeLimit({
      languageId: 'javascript',
      jsonKB: 0,
      globalKB: 256
    });
    assert.equal(limit.limitKB, 256);
    assert.equal(limit.settingKey, 'tidy.maxFileSizeKB');
  });
});

describe('config/sizeLimit : value rules', () => {
  it('0 disables the cap and still names the winning key', () => {
    const limit = resolveSizeLimit({ languageId: 'json', jsonKB: 0 });
    assert.equal(limit.limitKB, 0);
    assert.equal(limit.limitBytes, undefined);
    assert.equal(limit.settingKey, 'tidy.json.maxFileSizeKB');
  });

  it('a negative value disables the cap exactly like 0', () => {
    const limit = resolveSizeLimit({ languageId: 'css', globalKB: -5 });
    assert.equal(limit.limitBytes, undefined);
    assert.equal(limit.limitKB, 0);
  });

  it('a string "5120" is ignored and resolution falls through to the default', () => {
    const limit = resolveSizeLimit({ languageId: 'css', globalKB: '5120' });
    assert.equal(limit.limitKB, DEFAULT_MAX_FILE_SIZE_KB);
    assert.equal(limit.source, 'default');
  });

  it('a non-finite json value falls through to an explicit global for json', () => {
    const limit = resolveSizeLimit({ languageId: 'json', jsonKB: NaN, globalKB: 7 });
    assert.equal(limit.limitKB, 7);
    assert.equal(limit.settingKey, 'tidy.maxFileSizeKB');
  });

  it('Infinity is ignored, never an unlimited cap', () => {
    const limit = resolveSizeLimit({ languageId: 'json', jsonKB: Infinity });
    assert.equal(limit.limitKB, JSON_DEFAULT_MAX_FILE_SIZE_KB);
    assert.equal(limit.source, 'default');
  });

  it('null / undefined / objects are ignored like any other non-number', () => {
    for (const bad of [null, undefined, {}, [], true] as unknown[]) {
      const limit = resolveSizeLimit({ languageId: 'json', jsonKB: bad });
      assert.equal(limit.limitKB, JSON_DEFAULT_MAX_FILE_SIZE_KB, `for ${String(bad)}`);
      assert.equal(limit.source, 'default');
    }
  });

  it('a fractional value is floored', () => {
    const limit = resolveSizeLimit({ languageId: 'json', jsonKB: 6.9 });
    assert.equal(limit.limitKB, 6);
    assert.equal(limit.limitBytes, 6 * 1024);
  });
});

describe('config/sizeLimit : describeSizeLimit', () => {
  it('renders KB, winning key and source for an active cap', () => {
    assert.equal(
      describeSizeLimit(resolveSizeLimit({ languageId: 'json' })),
      '10240 KB via tidy.json.maxFileSizeKB (default)'
    );
    assert.equal(
      describeSizeLimit(resolveSizeLimit({ languageId: 'css', globalKB: 512 })),
      '512 KB via tidy.maxFileSizeKB (user setting)'
    );
  });

  it('renders a disabled cap explicitly', () => {
    assert.equal(
      describeSizeLimit(resolveSizeLimit({ languageId: 'json', jsonKB: 0 })),
      'disabled via tidy.json.maxFileSizeKB (user setting)'
    );
  });

  it('stays content-free and short enough for sanitizeDetail (< 200 chars)', () => {
    const longest = describeSizeLimit(
      resolveSizeLimit({ languageId: 'json', jsonKB: 999999 })
    );
    assert.ok(longest.length < 200);
    assert.ok(!longest.includes('\n'));
  });
});

describe('config/sizeLimit : settingKeyFromDescription', () => {
  it('recovers the json family key from a rendered detail', () => {
    assert.equal(
      settingKeyFromDescription('10240 KB via tidy.json.maxFileSizeKB (default)'),
      'tidy.json.maxFileSizeKB'
    );
  });

  it('recovers the global key from a rendered detail', () => {
    assert.equal(
      settingKeyFromDescription('512 KB via tidy.maxFileSizeKB (user setting)'),
      'tidy.maxFileSizeKB'
    );
  });

  it('recovers the key from a disabled-cap detail too', () => {
    assert.equal(
      settingKeyFromDescription('disabled via tidy.json.maxFileSizeKB (user setting)'),
      'tidy.json.maxFileSizeKB'
    );
  });

  it('returns undefined for an undefined or legacy detail (caller falls back)', () => {
    assert.equal(settingKeyFromDescription(undefined), undefined);
    assert.equal(settingKeyFromDescription('5120'), undefined);
    assert.equal(settingKeyFromDescription(''), undefined);
  });

  it('round-trips every describeSizeLimit output back to its own key', () => {
    for (const input of [
      { languageId: 'json' as const },
      { languageId: 'jsonc' as const, jsonKB: 0 },
      { languageId: 'css' as const },
      { languageId: 'typescript' as const, globalKB: 42 }
    ]) {
      const limit = resolveSizeLimit(input);
      assert.equal(
        settingKeyFromDescription(describeSizeLimit(limit)),
        limit.settingKey
      );
    }
  });
});
