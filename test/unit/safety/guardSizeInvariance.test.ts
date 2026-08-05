// The guard's JSON verdict must NOT depend on the document's size.
//
// `parseJsonValue` short-circuits large strict-JSON documents with native
// JSON.parse instead of the lenient jsonc-parser. Before v0.2.2 the two parsers
// disagreed on a `"__proto__"` member (jsonc-parser assigned members with
// `obj[key] = value`, which hits the prototype setter and leaves no own
// property, while JSON.parse creates a real own property). The guard therefore
// returned a DIFFERENT verdict for the same corruption depending on whether the
// document crossed the 256 KB fast-path threshold, and below it the removal of a
// `"__proto__"` member was silently accepted.
//
// These tests pin the invariant: same corruption, same verdict, both sides of
// the threshold.
import assert from 'node:assert/strict';
import { jsonEqual } from '../../../src/safety/guard';

// Comfortably above JSON_FAST_PATH_MIN_BYTES (256 * 1024).
const PADDING = `,"pad":"${'x'.repeat(300 * 1024)}"`;

describe('safety/guard : JSON verdict is invariant by document size', () => {
  it('rejects a dropped "__proto__" member below the fast-path threshold', () => {
    const verdict = jsonEqual('{"__proto__":{"p":1},"a":1}', '{"a":1}');
    assert.equal(verdict.equivalent, false);
    assert.ok(verdict.reason && verdict.reason.length > 0);
  });

  it('rejects the same dropped "__proto__" member above the fast-path threshold', () => {
    const input = `{"__proto__":{"p":1},"a":1${PADDING}}`;
    const output = `{"a":1${PADDING}}`;
    assert.ok(input.length > 256 * 1024, 'fixture must exercise the fast path');
    const verdict = jsonEqual(input, output);
    assert.equal(verdict.equivalent, false);
  });

  it('rejects a MODIFIED "__proto__" value on both sides of the threshold', () => {
    assert.equal(
      jsonEqual('{"__proto__":{"p":1}}', '{"__proto__":{"p":2}}').equivalent,
      false
    );
    assert.equal(
      jsonEqual(
        `{"__proto__":{"p":1},"a":1${PADDING}}`,
        `{"__proto__":{"p":2},"a":1${PADDING}}`
      ).equivalent,
      false
    );
  });

  it('accepts a pure reformat containing "__proto__" on both sides of the threshold', () => {
    assert.equal(
      jsonEqual('{"__proto__":{"p":1},"a":1}', '{\n  "a": 1,\n  "__proto__": { "p": 1 }\n}')
        .equivalent,
      true
    );
    assert.equal(
      jsonEqual(`{"a":1${PADDING}}`, `{\n  "a": 1${PADDING}\n}`).equivalent,
      true
    );
  });

  it('control: an ordinary key reorder stays accepted on both sides of the threshold', () => {
    assert.equal(jsonEqual('{"b":2,"a":1}', '{"a":1,"b":2}').equivalent, true);
    assert.equal(
      jsonEqual(`{"b":2,"a":1${PADDING}}`, `{"a":1,"b":2${PADDING}}`).equivalent,
      true
    );
  });

  it('control: an ordinary dropped key is still rejected above the threshold', () => {
    assert.equal(
      jsonEqual(`{"b":2,"a":1${PADDING}}`, `{"a":1${PADDING}}`).equivalent,
      false
    );
  });
});
