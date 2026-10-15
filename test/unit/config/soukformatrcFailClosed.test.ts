// F4: when the work budget of the overrides runs out, the options this
// .soukformatrc yields may be wrong, so the read result carries a fail-closed
// reason (the caller then formats nothing). The warning in "Show Effective
// Configuration" stays; the reason is additional. An ordinary config carries none.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SOUKFORMATRC_FILENAME,
  clearSoukformatrcCache,
  parseSoukformatrc,
  readSoukformatrcLayers
} from '../../../src/config/soukformatrc';
import { resolveOptions } from '../../../src/config/resolver';
import {
  isFailClosedDetail,
  isSoukformatrcFailClosedDetail
} from '../../../src/ignore/soukformatignore';

/** Reviewer's multiX(k) from soukformatrcGlob.test.ts: a 1024-character glob that is costly to match. */
function costlyGlob(): string {
  const unit = `**/*${'a'.repeat(60)}c`;
  let glob = '';
  while (glob.length + unit.length <= 1024) {
    glob += unit;
  }
  return glob;
}

const DEEP_REL = Array.from({ length: 16 }, () => `${'a'.repeat(254)}c`).join('/');

/** 20 costly overrides: enough to run the 2 000 000-step budget out, and ~20 KB. */
const EXHAUSTING = JSON.stringify({
  css: { indent: 4 },
  overrides: Array.from({ length: 20 }, () => ({ files: costlyGlob(), options: { indent: 8 } }))
});

const ORDINARY = JSON.stringify({
  css: { indent: 4 },
  overrides: [{ files: '*.css', options: { indent: 8 } }]
});

describe('config/soukformatrc : F4 an exhausted override budget fails closed', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'souk-f4-'));
    clearSoukformatrcCache();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    clearSoukformatrcCache();
  });

  it('the parsed result carries the reason, one line, and keeps its warning', () => {
    const result = parseSoukformatrc(EXHAUSTING, 'css', '/p/.soukformatrc', DEEP_REL);
    assert.ok(result.failClosed !== undefined, 'the budget ran out');
    assert.ok(isSoukformatrcFailClosedDetail(result.failClosed));
    assert.match(result.failClosed, /^\.soukformatrc overrides: matching 20 patterns/);
    assert.match(result.failClosed, /needs more than \d+ steps; Tidy left the file alone$/);
    assert.ok(!result.failClosed.includes('\n'));
    assert.ok(result.failClosed.length < 200, 'fits the 200 characters a record keeps');
    assert.ok(
      result.warnings.some((w) => /are skipped/.test(w.message)),
      'Show Effective Configuration keeps its warning'
    );
  });

  it('an ordinary config carries no reason at all', () => {
    const result = parseSoukformatrc(ORDINARY, 'css', '/p/.soukformatrc', 'a/b.css');
    assert.equal(result.failClosed, undefined);
    assert.equal('failClosed' in result, false);
    assert.deepEqual(result.warnings, []);
  });

  it('without a path to match there is nothing to evaluate, so nothing to fail', () => {
    assert.equal(parseSoukformatrc(EXHAUSTING, 'css', '/p/.soukformatrc').failClosed, undefined);
  });

  it('the reason survives the read from disk, and is absent for an ordinary file', () => {
    const configPath = join(root, SOUKFORMATRC_FILENAME);
    writeFileSync(configPath, EXHAUSTING);
    const closed = readSoukformatrcLayers(join(root, DEEP_REL, 'x.css'), 'css', root);
    assert.equal(closed.path, configPath);
    assert.ok(isSoukformatrcFailClosedDetail(closed.failClosed), String(closed.failClosed));

    writeFileSync(configPath, ORDINARY);
    const ordinary = readSoukformatrcLayers(join(root, 'a', 'x.css'), 'css', root);
    assert.equal(ordinary.failClosed, undefined);
    assert.equal(ordinary.layers.length, 2);
  });

  it('the resolver carries the reason to the options, and only when there is one', () => {
    const reason = '.soukformatrc overrides: something';
    assert.equal(resolveOptions({ languageId: 'css', layers: [], failClosed: reason }).failClosed, reason);
    const plain = resolveOptions({ languageId: 'css', layers: [] });
    assert.equal(plain.failClosed, undefined);
    assert.equal('failClosed' in plain, false);
  });

  it('a recorded .soukformatrc reason is told from a path, like a .soukformatignore one', () => {
    const reason = parseSoukformatrc(EXHAUSTING, 'css', '/p/.soukformatrc', DEEP_REL).failClosed;
    assert.equal(isFailClosedDetail(reason), true);
    assert.equal(isFailClosedDetail('/w/project/.soukformatrc'), false);
    assert.equal(isFailClosedDetail(undefined), false);
  });
});
