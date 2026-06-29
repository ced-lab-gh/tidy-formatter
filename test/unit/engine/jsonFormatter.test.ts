// Unit tests for the fast JSON / JSONC formatter (SPEC QA-03 / §9) and the
// size-aware guard fast path it pairs with.
//
// What these prove:
//   - the formatter pretty-prints JSON deterministically and IDEMPOTENTLY,
//   - it PRESERVES comments + trailing commas for JSONC (the #134 cluster),
//   - tabs / spaces indentation mapping matches ResolvedOptions,
//   - the engine still reports id 'js-beautify' for json/jsonc (engineFixtures),
//   - and — the load-bearing safety property — a LARGE document that triggers the
//     guard's native-JSON.parse fast path is still REJECTED when a value changes,
//     so the optimisation never weakens the guarantee.
import assert from 'node:assert/strict';
import { JsBeautifyEngine } from '../../../src/engine/jsbeautify';
import { dispatchFormat } from '../../../src/engine/dispatcher';
import { jsonEqual, guard } from '../../../src/safety/guard';
import { resolved } from '../../helpers/options';
import type { LangId } from '../../../src/types';

const engine = new JsBeautifyEngine();

describe('engine/jsonFormatter — JSON pretty-print', () => {
  it('pretty-prints a compact object with 2-space indent', async () => {
    const out = await engine.format({
      languageId: 'json',
      code: '{"a":1,"b":2}',
      options: resolved({ tabSize: 2, insertSpaces: true })
    });
    assert.equal(out, '{\n  "a": 1,\n  "b": 2\n}');
  });

  it('uses tab indentation when insertSpaces=false', async () => {
    const out = await engine.format({
      languageId: 'json',
      code: '{"a":{"b":1}}',
      options: resolved({ insertSpaces: false })
    });
    assert.ok(out.includes('\n\t"a"'), `expected tab indent, got ${JSON.stringify(out)}`);
    assert.ok(out.includes('\n\t\t"b"'), 'nested level indented with two tabs');
  });

  it('clamps a malformed tabSize (0) to a safe default rather than 0-width indent', async () => {
    const out = await engine.format({
      languageId: 'json',
      code: '{"a":1}',
      options: resolved({ tabSize: 0, insertSpaces: true })
    });
    // 4-space fallback: the key is indented by some spaces, never flush-left.
    assert.ok(/\n {2,}"a"/.test(out), `expected indented output, got ${JSON.stringify(out)}`);
  });

  it('is idempotent: a second format is a byte-for-byte no-op', async () => {
    const input = '{"a":{"b":{"c":[1,2,3]}},"d":"x"}';
    const first = await dispatchFormat({ languageId: 'json', code: input, options: resolved() });
    const second = await dispatchFormat({ languageId: 'json', code: first, options: resolved() });
    assert.equal(second, first);
  });

  it('preserves the document EOL when no endOfLine policy is set (CRLF stays CRLF)', async () => {
    const out = await engine.format({
      languageId: 'json',
      code: '{"a":1,\r\n"b":2}',
      options: resolved()
    });
    assert.ok(out.includes('\r\n'), `expected CRLF preserved, got ${JSON.stringify(out)}`);
    // ...and the resulting value still round-trips.
    assert.deepStrictEqual(JSON.parse(out), { a: 1, b: 2 });
  });
});

describe('engine/jsonFormatter — JSONC comment & trailing-comma preservation', () => {
  it('keeps a line comment and a block comment after formatting', async () => {
    const input = '{\n// line\n"a":1,\n/* block */\n"b":2,\n}';
    const out = await engine.format({ languageId: 'jsonc', code: input, options: resolved() });
    assert.ok(out.includes('// line'), `line comment lost: ${JSON.stringify(out)}`);
    assert.ok(out.includes('/* block */'), `block comment lost: ${JSON.stringify(out)}`);
  });

  it('is idempotent for an inline block comment before a key (BUG-JSONC-INLINE-COMMENT)', async () => {
    const input = `{"compilerOptions":{"strict":true,/* c */ "target":"ES2022"},"include":["src",]}`;
    const first = await dispatchFormat({ languageId: 'jsonc', code: input, options: resolved() });
    const second = await dispatchFormat({ languageId: 'jsonc', code: first, options: resolved() });
    assert.equal(second, first, 'JSONC formatting drifted on the second pass');
  });

  it('still passes the semantic guard (comments are style, not value)', async () => {
    const input = '{\n// keep\n"port": 3000,\n}';
    const out = await dispatchFormat({ languageId: 'jsonc', code: input, options: resolved() });
    assert.equal(guard.check('jsonc', input, out).equivalent, true);
  });
});

describe('engine/jsonFormatter — routing keeps the js-beautify engine id', () => {
  it("json/jsonc still report engine id 'js-beautify' (engineFixtures contract)", () => {
    // The JSON path lives inside JsBeautifyEngine, so its public id is unchanged;
    // this protects the dispatcher engineFixtures expectation.
    assert.equal(engine.id, 'js-beautify');
    assert.equal(engine.supports('json'), true);
    assert.equal(engine.supports('jsonc'), true);
  });
});

// ---------------------------------------------------------------------------
// The load-bearing safety test for the guard's large-document fast path: a
// document big enough to trigger native JSON.parse (>= 256 KB) must still be
// rejected when a value changes. If the fast path ever weakened the guarantee,
// THIS test fails.
// ---------------------------------------------------------------------------
describe('safety/guard — large-JSON fast path never weakens the guarantee', () => {
  // Build a > 256 KB strict-JSON document so parseJsonValue takes the native path.
  function bigJson(entries: number): string {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < entries; i += 1) {
      obj[`key_${i}`] = { id: i, name: `name-${i}`, tags: [`a${i}`, `b${i}`], nested: { x: i } };
    }
    return JSON.stringify({ count: entries, items: obj });
  }

  const LANG: LangId = 'json';
  const input = bigJson(4000);

  it('the test document actually exceeds the fast-path threshold (>= 256 KB)', () => {
    assert.ok(input.length >= 256 * 1024, `doc is only ${input.length} bytes`);
  });

  it('accepts a pure whitespace reformat of a large document', async () => {
    const out = await dispatchFormat({ languageId: LANG, code: input, options: resolved() });
    assert.notEqual(out, input, 'precondition: the formatter changed the layout');
    assert.equal(jsonEqual(input, out).equivalent, true);
  });

  it('REJECTS a large document whose value was changed (corruption)', async () => {
    const out = await dispatchFormat({ languageId: LANG, code: input, options: resolved() });
    const corrupted = out.replace('"name-0"', '"HACKED"');
    assert.notEqual(corrupted, out, 'precondition: corruption changed the text');
    const verdict = jsonEqual(input, corrupted);
    assert.equal(verdict.equivalent, false, 'guard MUST reject a changed value on the fast path');
    assert.ok(verdict.reason && verdict.reason.length > 0);
  });

  it('REJECTS a large document with a dropped key', () => {
    const corrupted = input.replace('"key_1":', '"DROPPED_DIFFERENT_KEY":');
    const verdict = jsonEqual(input, corrupted);
    assert.equal(verdict.equivalent, false);
  });

  it('REJECTS large output that is no longer valid JSON', () => {
    const broken = input.slice(0, input.length - 1); // drop the final brace
    const verdict = jsonEqual(input, broken);
    assert.equal(verdict.equivalent, false);
    assert.ok(verdict.reason);
  });
});
