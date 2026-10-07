// Unit tests for the deference setting module and the rule that decides when
// scanning the workspace can change anything (LOW-18).
//
// PURE (no 'vscode'): setting.ts and decide.ts are host-free. The host-level
// proof (real activate(), recorded workspace reads) is hostBehaviour.test.ts;
// this file pins the RULE and the premise it stands on:
//   - detectionCanChangeOutcome is true only for 'notify' before the one-shot;
//   - it agrees with decide() for EVERY setting, flag and detection: whenever it
//     says a scan cannot matter, decide() can never answer 'notify', and whenever
//     it says a scan can matter, some detection does produce a 'notify';
//   - the premise for silent-defer: no host code reads the 'defer' action, so a
//     scan in that mode really is unobservable. If a host ever starts to act on
//     'defer', the last test fails and says which rule to revisit.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import * as decideModule from '../../../src/deference/decide';
import { decide, normalizeSetting, type DeferenceSetting } from '../../../src/deference/decide';
import {
  DEFAULT_DEFERENCE_SETTING,
  DEFERENCE_SETTING_KEY,
  detectionCanChangeOutcome,
  normalizeSetting as normalizeFromSetting
} from '../../../src/deference/setting';
import { FORMATTER_BIOME, FORMATTER_PRETTIER } from '../../../src/deference/detect';

const SETTINGS: readonly DeferenceSetting[] = ['notify', 'silent-defer', 'off'];
const DETECTIONS: readonly (readonly string[])[] = [
  [],
  [FORMATTER_PRETTIER],
  [FORMATTER_PRETTIER, FORMATTER_BIOME]
];

describe('deference/setting : one source of truth, still importable from decide', () => {
  it('decide re-exports the very same setting members', () => {
    assert.equal(decideModule.normalizeSetting, normalizeFromSetting);
    assert.equal(decideModule.DEFERENCE_SETTING_KEY, DEFERENCE_SETTING_KEY);
    assert.equal(decideModule.DEFAULT_DEFERENCE_SETTING, DEFAULT_DEFERENCE_SETTING);
    assert.equal(decideModule.detectionCanChangeOutcome, detectionCanChangeOutcome);
  });

  it('keeps the shipped key and default', () => {
    assert.equal(DEFERENCE_SETTING_KEY, 'tidy.deferToOtherFormatters');
    assert.equal(DEFAULT_DEFERENCE_SETTING, 'notify');
    assert.equal(normalizeSetting(undefined), 'notify');
  });
});

describe('deference/setting : detectionCanChangeOutcome', () => {
  it('is true only for notify before the one-shot has been shown', () => {
    assert.equal(detectionCanChangeOutcome('notify', false), true);
    assert.equal(detectionCanChangeOutcome('notify', true), false);
  });

  it('is false for silent-defer, whatever the one-shot flag (was 2 reads for nothing)', () => {
    assert.equal(detectionCanChangeOutcome('silent-defer', false), false);
    assert.equal(detectionCanChangeOutcome('silent-defer', true), false);
  });

  it('is false for off', () => {
    assert.equal(detectionCanChangeOutcome('off', false), false);
    assert.equal(detectionCanChangeOutcome('off', true), false);
  });
});

describe('deference/setting : the rule agrees with decide() for every input', () => {
  it('a scan that cannot matter never leads to a notification', () => {
    for (const setting of SETTINGS) {
      for (const alreadyPrompted of [false, true]) {
        if (detectionCanChangeOutcome(setting, alreadyPrompted)) {
          continue;
        }
        for (const detected of DETECTIONS) {
          assert.notEqual(
            decide(detected, setting, alreadyPrompted).action,
            'notify',
            `${setting}, prompted=${alreadyPrompted}, detected=[${detected.join(',')}]`
          );
        }
      }
    }
  });

  it('a scan that can matter really can lead to a notification', () => {
    for (const setting of SETTINGS) {
      for (const alreadyPrompted of [false, true]) {
        if (!detectionCanChangeOutcome(setting, alreadyPrompted)) {
          continue;
        }
        const notifies = DETECTIONS.some(
          (detected) => decide(detected, setting, alreadyPrompted).action === 'notify'
        );
        assert.equal(notifies, true, `${setting}, prompted=${alreadyPrompted}`);
      }
    }
  });

  it('silent-defer keeps its decision: defer with a competitor, none without, never a message', () => {
    assert.deepEqual(decide([FORMATTER_PRETTIER], 'silent-defer', false), { action: 'defer' });
    assert.deepEqual(decide([], 'silent-defer', false), { action: 'none' });
    assert.equal(decide([FORMATTER_PRETTIER], 'silent-defer', false).message, undefined);
  });
});

/** Every .ts file under a directory, recursively. */
function tsFilesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...tsFilesUnder(full));
    } else if (full.endsWith('.ts')) {
      found.push(full);
    }
  }
  return found;
}

/** Source without block and line comments, so prose never counts as code. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

describe("deference/setting : the premise, nothing outside src/deference reads the 'defer' action", () => {
  it("has no 'defer' literal in code outside src/deference (so a silent-defer scan is unobservable)", () => {
    const srcRoot = path.resolve(__dirname, '../../../src');
    const deferenceRoot = path.join(srcRoot, 'deference');
    const offenders = tsFilesUnder(srcRoot)
      .filter((file) => !file.startsWith(deferenceRoot + path.sep))
      .filter((file) => /['"`]defer['"`]/.test(withoutComments(readFileSync(file, 'utf8'))))
      .map((file) => path.relative(srcRoot, file));
    assert.deepEqual(
      offenders,
      [],
      "a host now acts on the 'defer' action: detectionCanChangeOutcome must become true " +
        "for 'silent-defer', or the scan it skips is no longer free of consequences"
    );
  });
});
