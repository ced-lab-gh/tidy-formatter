// Unit tests for the vscode-free last-format store + channel-line formatter.
import assert from 'node:assert/strict';
import {
  recordLastFormat,
  getLastFormat,
  getLastFormatFor,
  getHistory,
  clearLastFormat,
  formatChannelLine,
  sanitizeDetail,
  setLastFormatListener,
  HISTORY_LIMIT,
  type LastFormatRecord
} from '../../../src/diagnostics/lastFormat';

function rec(over: Partial<LastFormatRecord> = {}): LastFormatRecord {
  return {
    uri: 'file:///w/a.css',
    fileName: 'a.css',
    languageId: 'css',
    status: 'applied',
    scope: 'document',
    at: '2026-07-24T00:00:00.000Z',
    ...over
  };
}

describe('diagnostics/lastFormat : store', () => {
  it('starts empty after clear, then records and returns the last record', () => {
    clearLastFormat();
    assert.equal(getLastFormat(), undefined);
    const r = rec();
    recordLastFormat(r);
    assert.deepEqual(getLastFormat(), r);
  });

  it('keeps only the most recent record', () => {
    recordLastFormat(rec({ status: 'applied' }));
    recordLastFormat(rec({ status: 'guard-rejected', detail: 'x' }));
    assert.equal(getLastFormat()?.status, 'guard-rejected');
  });

  it('clear resets it', () => {
    recordLastFormat(rec());
    clearLastFormat();
    assert.equal(getLastFormat(), undefined);
  });
});

describe('diagnostics/lastFormat : sanitizeDetail (privacy: no source leaks)', () => {
  it('keeps only the first line, dropping any embedded code frame', () => {
    // Shape of a Prettier parser error: summary on line 1, then the user's SOURCE.
    const leaky =
      "'}' expected. (3:1)\n" +
      '  1 | const SECRET = "sk-DO-NOT-LEAK";\n' +
      '  2 | function broken( {\n' +
      '> 3 |\n';
    const clean = sanitizeDetail(leaky);
    assert.equal(clean, "'}' expected. (3:1)");
    assert.ok(!clean.includes('SECRET'), 'must not contain source');
    assert.ok(!clean.includes('\n'), 'must be single-line');
  });

  it('caps very long single-line details', () => {
    const long = 'x'.repeat(500);
    const clean = sanitizeDetail(long);
    assert.ok(clean.length <= 200, `got ${clean.length}`);
    assert.ok(clean.endsWith('...'));
  });

  it('recordLastFormat sanitizes the stored detail (defense in depth)', () => {
    clearLastFormat();
    recordLastFormat(rec({ status: 'engine-error', detail: 'boom\nsecret-source-line' }));
    const stored = getLastFormat();
    assert.equal(stored?.detail, 'boom');
    assert.ok(!stored?.detail?.includes('secret-source-line'));
  });
});

describe('diagnostics/lastFormat : formatChannelLine', () => {
  it('is concise, includes file/lang/engine/status, and never uses an em dash', () => {
    const line = formatChannelLine(rec({ engineId: 'js-beautify', status: 'applied' }));
    assert.ok(line.includes('a.css'), line);
    assert.ok(line.includes('[css]'), line);
    assert.ok(line.includes('js-beautify'), line);
    assert.ok(line.includes('applied'), line);
    assert.ok(!line.includes('\u2014'), 'no em dash');
  });

  it('marks selection scope and appends the detail', () => {
    const line = formatChannelLine(
      rec({ status: 'guard-rejected', scope: 'selection', detail: 'not equivalent' })
    );
    assert.ok(line.includes('(selection)'), line);
    assert.ok(line.includes('not equivalent'), line);
  });

  it('omits engine and detail when absent (no literal "undefined")', () => {
    const line = formatChannelLine(
      rec({ status: 'disabled', engineId: undefined, detail: undefined })
    );
    assert.ok(line.includes('disabled'), line);
    assert.ok(!line.includes('undefined'), line);
  });
});

// ADD-05: the status bar feeds its transient result from this single observer
// slot, so recordLastFormat (which only ever runs inside a provider call) stays
// the ONLY trigger surface. The observer must never be able to break a format.
describe('diagnostics/lastFormat : listener (status bar feed, ADD-05)', () => {
  afterEach(() => {
    setLastFormatListener(undefined);
    clearLastFormat();
  });

  it('notifies the listener with the SANITIZED record', () => {
    let seen: LastFormatRecord | undefined;
    setLastFormatListener((r) => {
      seen = r;
    });
    recordLastFormat(
      rec({ status: 'engine-error', detail: 'boom\nsecret-source' })
    );
    assert.equal(seen?.detail, 'boom');
    assert.ok(!seen?.detail?.includes('secret-source'));
  });

  it('a throwing listener never breaks recordLastFormat and the record is stored', () => {
    setLastFormatListener(() => {
      throw new Error('observer bug');
    });
    assert.doesNotThrow(() => recordLastFormat(rec({ status: 'applied' })));
    assert.equal(getLastFormat()?.status, 'applied');
  });

  it('clearing the listener stops notifications', () => {
    let calls = 0;
    setLastFormatListener(() => {
      calls += 1;
    });
    recordLastFormat(rec());
    setLastFormatListener(undefined);
    recordLastFormat(rec());
    assert.equal(calls, 1);
  });
});

// ADD-14: the single slot became a bounded, immutable ring buffer, so an
// explanation survives the next file being formatted. These suites lock the
// per-file lookup, the FIFO window and the immutability of the store.
describe('diagnostics/lastFormat : per-file store (ADD-14)', () => {
  beforeEach(() => clearLastFormat());

  it('getLastFormatFor returns the record for THAT uri even after another file was formatted', () => {
    recordLastFormat(
      rec({
        uri: 'file:///w/a.css',
        fileName: 'a.css',
        status: 'guard-rejected',
        detail: 'r'
      })
    );
    recordLastFormat(
      rec({ uri: 'file:///w/b.css', fileName: 'b.css', status: 'applied' })
    );
    assert.equal(getLastFormatFor('file:///w/a.css')?.status, 'guard-rejected');
    assert.equal(getLastFormatFor('file:///w/a.css')?.detail, 'r');
    assert.equal(getLastFormatFor('file:///w/b.css')?.status, 'applied');
  });

  it('a newer attempt on the same uri replaces its per-file record', () => {
    recordLastFormat(rec({ status: 'guard-rejected', detail: 'x' }));
    recordLastFormat(rec({ status: 'applied' }));
    assert.equal(getLastFormatFor('file:///w/a.css')?.status, 'applied');
  });

  it('returns undefined for a uri never formatted this session', () => {
    recordLastFormat(rec());
    assert.equal(getLastFormatFor('file:///w/never.css'), undefined);
  });
});

describe('diagnostics/lastFormat : bounded history (FIFO eviction)', () => {
  beforeEach(() => clearLastFormat());

  function recAt(i: number): LastFormatRecord {
    return rec({
      uri: `file:///w/f${i}.css`,
      fileName: `f${i}.css`,
      at: new Date(Date.UTC(2026, 6, 29, 0, 0, i)).toISOString()
    });
  }

  it('keeps at most HISTORY_LIMIT entries, evicting the oldest first', () => {
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) recordLastFormat(recAt(i));
    const history = getHistory();
    assert.equal(history.length, HISTORY_LIMIT);
    // Newest first: index 0 is the very last write; the 5 oldest are gone.
    assert.equal(history[0].fileName, `f${HISTORY_LIMIT + 4}.css`);
    assert.equal(history[HISTORY_LIMIT - 1].fileName, 'f5.css');
  });

  it('an evicted uri with no newer attempt also leaves the per-file index', () => {
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) recordLastFormat(recAt(i));
    assert.equal(getLastFormatFor('file:///w/f0.css'), undefined);
    assert.equal(getLastFormatFor('file:///w/f4.css'), undefined);
    assert.ok(
      getLastFormatFor('file:///w/f5.css'),
      'first retained entry stays indexed'
    );
  });

  it('getHistory is newest first and getLastFormat stays the most recent overall', () => {
    recordLastFormat(recAt(1));
    recordLastFormat(recAt(2));
    const history = getHistory();
    assert.equal(history[0].fileName, 'f2.css');
    assert.equal(history[1].fileName, 'f1.css');
    assert.deepEqual(getLastFormat(), history[0]);
  });

  it('multiple attempts on the SAME uri occupy multiple history rows (no dedup)', () => {
    recordLastFormat(rec({ status: 'guard-rejected', detail: 'x' }));
    recordLastFormat(rec({ status: 'applied' }));
    assert.equal(getHistory().length, 2);
    assert.equal(getHistory()[0].status, 'applied');
    assert.equal(getHistory()[1].status, 'guard-rejected');
  });
});

describe('diagnostics/lastFormat : store purity (immutability)', () => {
  beforeEach(() => clearLastFormat());

  it('mutating the caller record AFTER recording does not alter the store', () => {
    const mine = rec() as { fileName: string };
    recordLastFormat(mine as unknown as LastFormatRecord);
    mine.fileName = 'HACKED.css';
    assert.equal(getLastFormat()?.fileName, 'a.css');
    assert.equal(getLastFormatFor('file:///w/a.css')?.fileName, 'a.css');
  });

  it('stored records and the returned history array are frozen', () => {
    recordLastFormat(rec());
    const history = getHistory();
    assert.ok(Object.isFrozen(history), 'history array must be frozen');
    assert.ok(Object.isFrozen(history[0]), 'stored records must be frozen');
  });

  it('each getHistory call returns a fresh array with equal content', () => {
    recordLastFormat(rec());
    const a = getHistory();
    const b = getHistory();
    assert.notEqual(a, b, 'no shared mutable reference');
    assert.deepEqual(a, b);
  });
});

// The ADD-05 status bar feed must survive the ring buffer: recordLastFormat
// still notifies its observer with the SANITIZED, frozen record it stored.
describe('diagnostics/lastFormat : listener still fed by the ring buffer (ADD-05 x ADD-14)', () => {
  afterEach(() => {
    setLastFormatListener(undefined);
    clearLastFormat();
  });

  it('notifies with the record that was actually stored, on every write', () => {
    clearLastFormat();
    const seen: LastFormatRecord[] = [];
    setLastFormatListener((r) => {
      seen.push(r);
    });
    recordLastFormat(rec({ uri: 'file:///w/a.css', fileName: 'a.css' }));
    recordLastFormat(
      rec({ uri: 'file:///w/b.css', fileName: 'b.css', status: 'guard-rejected' })
    );
    assert.equal(seen.length, 2);
    assert.equal(seen[1].fileName, 'b.css');
    assert.ok(Object.isFrozen(seen[1]), 'the observed record is the frozen one');
    assert.deepEqual(seen[1], getLastFormat());
  });
});
