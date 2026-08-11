// Unit tests for the vscode-free last-format store + channel-line formatter.
import assert from 'node:assert/strict';
import {
  recordLastFormat,
  getLastFormat,
  clearLastFormat,
  formatChannelLine,
  sanitizeDetail,
  setLastFormatListener,
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
