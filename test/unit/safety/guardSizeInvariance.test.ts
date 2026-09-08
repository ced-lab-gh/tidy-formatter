// The guard's JSON verdict must NOT depend on the document's size.
//
// Two size-dependent false verdicts have been closed here, both caused by the
// same shortcut: `parseJsonValue` used to short-circuit documents of at least
// 256 KB to native `JSON.parse` instead of the lenient jsonc-parser, on the
// claim that the two were value-identical.
//
//   v0.2.2 : `__proto__`. jsonc-parser assembled members with `obj[key] = value`,
//     which hits the prototype setter and leaves no own property, while
//     JSON.parse creates a real one. Below the threshold, DROPPING a
//     `"__proto__"` member was accepted. Fixed by canonicalizing objects into
//     sorted `[key, value]` pair arrays built from the syntax tree.
//
//   v0.4.0 : DUPLICATE members. Native `JSON.parse` keeps only the LAST member
//     of a duplicated key; the jsonc path keeps both. So `{"a":1,"a":2}` had one
//     member above the threshold and two below it, which produced BOTH
//     directions of wrong answer:
//       - false ACCEPT: with both sides over 256 KB, deleting one of two
//         duplicate members was accepted as equivalent;
//       - false REJECT: a minified document under the threshold, correctly
//         formatted to an output over it, was rejected as "JSON value changed".
//     Fixed by deleting the native fast path: one streaming parser at every size.
//
// These tests pin the invariant: same pair, same verdict, on both sides of the
// threshold and across it. The threshold no longer exists in the source, and the
// constant below deliberately outlives it: any future size-dependent
// optimisation of the JSON guard has to keep passing these.
import assert from 'node:assert/strict';
import { jsonEqual } from '../../../src/safety/guard';

/** The fast-path threshold that used to change the verdict (256 KB). */
const FORMER_FAST_PATH_MIN_CHARS = 256 * 1024;

// Comfortably above FORMER_FAST_PATH_MIN_CHARS.
const PADDING = `,"pad":"${'x'.repeat(300 * 1024)}"`;

/**
 * Append the big padding member to a top-level object so the document crosses
 * the former threshold WITHOUT changing anything else about it. Applied to both
 * sides of a pair, it must leave the verdict untouched.
 */
function pad(document: string): string {
  const padded = document.endsWith('}')
    ? `${document.slice(0, -1)}${PADDING}}`
    : // A deliberately unparsable fixture has no closing brace to insert into.
      // Trailing whitespace crosses the threshold without changing what the
      // text means (it stays exactly as unparsable as it was).
      `${document}${' '.repeat(300 * 1024)}`;
  assert.ok(padded.length > FORMER_FAST_PATH_MIN_CHARS, 'padded fixture must cross the threshold');
  return padded;
}

function assertRejected(label: string, input: string, output: string): void {
  const verdict = jsonEqual(input, output);
  assert.equal(verdict.equivalent, false, `${label}: expected REJECT but the guard accepted`);
  assert.ok(verdict.reason && verdict.reason.length > 0, `${label}: rejection must carry a reason`);
}

function assertAccepted(label: string, input: string, output: string): void {
  const verdict = jsonEqual(input, output);
  assert.equal(
    verdict.equivalent,
    true,
    `${label}: expected EQUIVALENT, got reason='${verdict.reason ?? ''}'`
  );
}

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

// --- duplicate members -----------------------------------------------------
//
// `{"a":1,"a":2}` is a legal JSON TEXT with two members. A formatter may move
// them and reindent them; it may not add one, delete one, or swap the order that
// decides which one wins. The guard is the last line of defence and must hold
// that line on its own terms: "our engine preserves duplicates, so it would
// never emit that output" is not a proof of equivalence.

describe('safety/guard : JSON duplicate members survive the verdict', () => {
  it('rejects a DELETED duplicate member below the former threshold', () => {
    assertRejected('dup deleted (small)', '{"a":1,"a":2}', '{"a":2}');
  });

  it('rejects a DELETED duplicate member above the former threshold', () => {
    // The false accept: before v0.4.0 both sides took native JSON.parse, which
    // collapsed the two members on the input side too, so the deletion was
    // invisible and the corrupted output would have been written to the file.
    assertRejected('dup deleted (large)', pad('{"a":1,"a":2}'), pad('{"a":2}'));
  });

  it('rejects an ADDED duplicate member on both sides of the former threshold', () => {
    assertRejected('dup added (small)', '{"a":2}', '{"a":1,"a":2}');
    assertRejected('dup added (large)', pad('{"a":2}'), pad('{"a":1,"a":2}'));
  });

  it('rejects REORDERING two duplicate members, which changes which one wins', () => {
    assertRejected('dup reordered (small)', '{"a":1,"a":2}', '{"a":2,"a":1}');
    assertRejected('dup reordered (large)', pad('{"a":1,"a":2}'), pad('{"a":2,"a":1}'));
  });

  it('rejects a duplicate member deleted DEEP inside the document', () => {
    const input = '{"outer":{"list":[{"a":1,"a":2},{"b":1}]}}';
    const output = '{"outer":{"list":[{"a":2},{"b":1}]}}';
    assertRejected('nested dup deleted (small)', input, output);
    assertRejected('nested dup deleted (large)', pad(input), pad(output));
  });

  it('rejects deleting a duplicate whose value is identical (conservative, both sizes)', () => {
    // Under last-wins semantics `{"a":1,"a":1}` and `{"a":1}` denote the same
    // value, but RFC 8259 leaves duplicate-name behaviour unspecified and Tidy
    // never rewrites the member list. Refusing to write is the safe direction:
    // the file is left byte-identical and the user is told why.
    assertRejected('identical dup deleted (small)', '{"a":1,"a":1}', '{"a":1}');
    assertRejected('identical dup deleted (large)', pad('{"a":1,"a":1}'), pad('{"a":1}'));
  });

  it('rejects a dropped duplicate "__proto__" member on both sides of the threshold', () => {
    assertRejected('dup __proto__ (small)', '{"__proto__":1,"__proto__":2}', '{"__proto__":2}');
    assertRejected(
      'dup __proto__ (large)',
      pad('{"__proto__":1,"__proto__":2}'),
      pad('{"__proto__":2}')
    );
  });

  it('anti-false-rejection: reindenting a document with duplicates stays accepted', () => {
    const input = '{"a":1,"a":2,"b":3}';
    const output = '{\n  "a": 1,\n  "a": 2,\n  "b": 3\n}';
    assertAccepted('dup reformat (small)', input, output);
    assertAccepted('dup reformat (large)', pad(input), pad(output));
  });

  it('anti-false-rejection: reordering DISTINCT keys around a duplicate stays accepted', () => {
    assertAccepted('dup + key reorder', '{"b":3,"a":1,"a":2}', '{"a":1,"a":2,"b":3}');
    assertAccepted(
      'dup + key reorder (large)',
      pad('{"b":3,"a":1,"a":2}'),
      pad('{"a":1,"a":2,"b":3}')
    );
  });

  it('rejects a duplicate member whose VALUE changed, on both sides of the threshold', () => {
    assertRejected('dup value changed (small)', '{"a":1,"a":2}', '{"a":1,"a":3}');
    assertRejected('dup value changed (large)', pad('{"a":1,"a":2}'), pad('{"a":1,"a":3}'));
  });

  it('keeps duplicates visible through the JSONC path (comments + trailing commas)', () => {
    const jsonc = '{\n  // first\n  "a": 1,\n  /* second */ "a": 2,\n}';
    assertAccepted('jsonc dup preserved', jsonc, '{"a":1,"a":2}');
    assertRejected('jsonc dup dropped', jsonc, '{"a":2}');
  });
});

// --- the invariance property itself ----------------------------------------

describe('safety/guard : the same JSON pair gets the same verdict at any size', () => {
  const PAIRS: ReadonlyArray<readonly [label: string, input: string, output: string]> = [
    ['pure reformat', '{"a":1,"b":[1,2]}', '{\n  "a": 1,\n  "b": [1, 2]\n}'],
    ['key reorder', '{"b":2,"a":1}', '{"a":1,"b":2}'],
    ['value changed', '{"a":1}', '{"a":2}'],
    ['key dropped', '{"a":1,"b":2}', '{"a":1}'],
    ['array reordered', '{"a":[1,2]}', '{"a":[2,1]}'],
    ['duplicate preserved', '{"a":1,"a":2}', '{\n  "a": 1,\n  "a": 2\n}'],
    ['duplicate deleted', '{"a":1,"a":2}', '{"a":2}'],
    ['duplicate added', '{"a":2}', '{"a":1,"a":2}'],
    ['duplicate reordered', '{"a":1,"a":2}', '{"a":2,"a":1}'],
    ['__proto__ preserved', '{"__proto__":{"p":1}}', '{\n  "__proto__": { "p": 1 }\n}'],
    ['__proto__ dropped', '{"__proto__":1,"a":2}', '{"a":2}'],
    ['__proto__ duplicated', '{"__proto__":1}', '{"__proto__":1,"__proto__":1}'],
    ['nested duplicate deleted', '{"o":{"a":1,"a":2}}', '{"o":{"a":2}}'],
    ['output not parsable', '{"a":1}', '{"a":1'],
    ['input not parsable', '{"a":1', '{"a":1}']
  ];

  for (const [label, input, output] of PAIRS) {
    it(`'${label}' gets the same verdict small and large`, () => {
      const small = jsonEqual(input, output);
      // Padding is added to BOTH sides, so it cannot change what the pair means;
      // it only pushes the documents past the old 256 KB fast-path threshold.
      const large = jsonEqual(pad(input), pad(output));
      assert.equal(
        large.equivalent,
        small.equivalent,
        `'${label}': verdict flipped with document size ` +
          `(small=${String(small.equivalent)}, large=${String(large.equivalent)})`
      );
    });
  }
});

// --- crossing the threshold, not sitting on one side of it ------------------

describe('safety/guard : a JSON pair that STRADDLES the former threshold', () => {
  /**
   * A minified document that stays UNDER the former threshold and a faithful
   * 4-space reformat of it that lands OVER it, both carrying the same duplicate
   * member. This is the shape the old code got wrong in the other direction: it
   * parsed the input with jsonc (two members) and the output natively (one), and
   * rejected a perfectly correct format as "JSON value changed after formatting".
   */
  function straddlingPair(): { minified: string; pretty: string } {
    let members = 6000;
    for (;;) {
      const list: string[] = [];
      for (let i = 0; i < members; i += 1) {
        list.push(`"key_${i}":"value_${i}"`);
      }
      list.push('"dup":1', '"dup":2');
      const minified = `{${list.join(',')}}`;
      const pretty = `{\n${list.map((member) => `    ${member.replace(':', ': ')}`).join(',\n')}\n}`;
      if (pretty.length >= FORMER_FAST_PATH_MIN_CHARS) {
        return { minified, pretty };
      }
      members += 500;
    }
  }

  const { minified, pretty } = straddlingPair();

  it('the fixture really does straddle the threshold', () => {
    assert.ok(
      minified.length < FORMER_FAST_PATH_MIN_CHARS,
      `input must stay under the threshold (was ${minified.length})`
    );
    assert.ok(
      pretty.length >= FORMER_FAST_PATH_MIN_CHARS,
      `output must cross the threshold (was ${pretty.length})`
    );
  });

  it('accepts the faithful reformat (the old code rejected it)', () => {
    assertAccepted('straddling reformat', minified, pretty);
  });

  it('still rejects the same reformat once the duplicate is dropped from it', () => {
    const corrupted = pretty.replace('    "dup": 1,\n', '');
    assert.notEqual(corrupted, pretty, 'precondition: the corruption changed the text');
    assertRejected('straddling reformat, duplicate dropped', minified, corrupted);
  });

  it('gives the same verdict with the two documents swapped', () => {
    assertAccepted('straddling reformat reversed', pretty, minified);
  });
});
