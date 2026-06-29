// Complex JSON / JSONC equivalence + idempotence suite.
//
// Exercises the JSON guard (jsonEqual) and idempotence on the gnarly inputs that
// historically broke the incumbent's JSON path (SPEC §3 "#134 ruins package.json"):
//   - deep nesting (objects/arrays many levels down),
//   - the full escape/unicode surface (\uXXXX, surrogate pairs, \t \n \" \\ /),
//   - large / extreme numbers (1e308, tiny exponents, integer-precision limits),
//   - JSONC with line + block comments AND trailing commas,
//   - heterogeneous ("mixed") arrays of every JSON type.
//
// Two properties are asserted throughout:
//   * jsonEqual(input, prettyPrinted) === equivalent  (formatting preserves value)
//   * idempotence(lang, pass1, pass2)   === equivalent  (a stable second pass)
// plus targeted REJECT cases proving the guard still catches a real value change
// hiding inside the same complex shapes.
//
// Conventions: mocha BDD + node:assert/strict. Pretty-printed "formatter output"
// is produced with JSON.stringify(value, null, n) — a real, deterministic
// reformat — so equivalence is tested against genuine whitespace-only changes.
import assert from 'node:assert/strict';
import { jsonEqual, idempotence } from '../../../src/safety/guard';
import type { LangId } from '../../../src/types';

// Reformat a JSON document the way a formatter would: parse then re-serialize
// with the given indent. Throws if the input is not valid JSON (intentional —
// the fixtures below are all valid JSON, JSONC handled separately).
function reflow(json: string, indent: number): string {
  return JSON.stringify(JSON.parse(json), null, indent);
}

function assertEquivalent(label: string, input: string, output: string): void {
  const v = jsonEqual(input, output);
  assert.equal(v.equivalent, true, `${label}: expected equivalent, got reason='${v.reason ?? ''}'`);
}

function assertRejected(label: string, input: string, output: string): void {
  const v = jsonEqual(input, output);
  assert.equal(v.equivalent, false, `${label}: expected REJECT but guard accepted`);
  assert.ok(v.reason && v.reason.length > 0, `${label}: rejection must carry a reason`);
}

const JSON_LANG: LangId = 'json';
const JSONC_LANG: LangId = 'jsonc';

describe('complex JSON — deep nesting', () => {
  const deep = JSON.stringify({
    level1: {
      level2: {
        level3: {
          level4: {
            level5: {
              data: [1, [2, [3, [4, [5, { leaf: 'bottom', flags: [true, false, null] }]]]]],
              meta: { created: '2026-06-28', tags: ['a', 'b', 'c'] }
            }
          }
        }
      }
    }
  });

  it('pretty-printing a deeply nested object preserves the value (2-space)', () => {
    assertEquivalent('deep 2-space', deep, reflow(deep, 2));
  });

  it('pretty-printing a deeply nested object preserves the value (tab/4-space)', () => {
    assertEquivalent('deep 4-space', deep, reflow(deep, 4));
  });

  it('is idempotent: re-pretty-printing the formatted output changes nothing', () => {
    const pass1 = reflow(deep, 2);
    const pass2 = reflow(pass1, 2);
    const v = idempotence(JSON_LANG, pass1, pass2);
    assert.equal(v.equivalent, true, v.reason);
  });

  it('rejects a value buried five levels deep being changed', () => {
    const corrupted = deep.replace('"bottom"', '"TOP"');
    assert.notEqual(corrupted, deep, 'precondition: corruption actually changed the text');
    assertRejected('deep leaf changed', deep, corrupted);
  });

  it('rejects a boolean flipped deep inside nested arrays', () => {
    const corrupted = deep.replace('[true,false,null]', '[true,true,null]');
    assert.notEqual(corrupted, deep);
    assertRejected('deep flag flipped', deep, corrupted);
  });
});

describe('complex JSON — unicode & escape sequences', () => {
  // Cover: BMP escape, astral surrogate pair, control chars, escaped quote,
  // escaped backslash, escaped solidus, and a raw multi-byte literal.
  const unicode =
    '{' +
    '"bmp":"caf\\u00e9",' +
    '"astral":"\\uD83D\\uDE00",' +
    '"controls":"tab\\tnewline\\ncarriage\\r",' +
    '"quote":"she said \\"hi\\"",' +
    '"backslash":"a\\\\b",' +
    '"solidus":"http:\\/\\/x",' +
    '"rawMultibyte":"naïve — Ω"' +
    '}';

  it('pretty-printing preserves every escape/unicode value', () => {
    assertEquivalent('unicode pretty', unicode, reflow(unicode, 2));
  });

  it('treats an escaped BMP code point and its literal form as equal (\\u00e9 == é)', () => {
    assertEquivalent('escape vs literal', '{"s":"caf\\u00e9"}', '{"s":"café"}');
  });

  it('treats an escaped solidus and a bare solidus as equal (\\/ == /)', () => {
    assertEquivalent('solidus', '{"u":"a\\/b"}', '{"u":"a/b"}');
  });

  it('treats an astral surrogate pair and its literal emoji as equal', () => {
    assertEquivalent('astral', '{"e":"\\uD83D\\uDE00"}', '{"e":"\u{1F600}"}');
  });

  it('is idempotent across the escape surface', () => {
    const pass1 = reflow(unicode, 2);
    const pass2 = reflow(pass1, 2);
    assert.equal(idempotence(JSON_LANG, pass1, pass2).equivalent, true);
  });

  it('rejects a control character silently dropped from a string', () => {
    assertRejected('control dropped', '{"s":"a\\tb"}', '{"s":"ab"}');
  });

  it('rejects a quoted character changed inside an escaped string', () => {
    assertRejected('escaped value changed', '{"q":"she said \\"hi\\""}', '{"q":"she said \\"bye\\""}');
  });
});

describe('complex JSON — large & extreme numbers', () => {
  const numbers =
    '{' +
    '"max":1e308,' +
    '"tiny":1e-300,' +
    '"negZero":-0,' +
    '"frac":0.30000000000000004,' +
    '"expPlus":6.022E+23,' +
    '"negExp":-1.6e-19,' +
    '"safeInt":9007199254740991,' +
    '"leadingFrac":0.5' +
    '}';

  it('pretty-printing preserves large/extreme numbers', () => {
    assertEquivalent('numbers pretty', numbers, reflow(numbers, 2));
  });

  it('treats equal numbers written differently as equal (1e2 == 100, 6.022E+23 == 6.022e23)', () => {
    assertEquivalent('1e2 == 100', '{"n":1e2}', '{"n":100}');
    assertEquivalent('exp form', '{"n":6.022E+23}', '{"n":6.022e23}');
  });

  it('is idempotent for the number set', () => {
    const pass1 = reflow(numbers, 2);
    const pass2 = reflow(pass1, 2);
    assert.equal(idempotence(JSON_LANG, pass1, pass2).equivalent, true);
  });

  it('rejects a number changed by a representable amount (1e308 -> 1e307)', () => {
    assertRejected('1e308 -> 1e307', '{"max":1e308}', '{"max":1e307}');
  });

  it('rejects an exponent sign flip (1.6e-19 -> 1.6e19)', () => {
    assertRejected('exp sign flip', '{"q":-1.6e-19}', '{"q":-1.6e19}');
  });

  it('rejects a fractional value truncated (0.5 -> 5)', () => {
    assertRejected('frac truncated', '{"r":0.5}', '{"r":5}');
  });
});

describe('complex JSONC — comments + trailing commas', () => {
  const jsonc = `{
  // top-level line comment
  "name": "tidy-formatter",
  /* a block comment
     spanning lines */
  "version": "0.1.0",
  "engines": {
    "vscode": "^1.84.0", // trailing comma follows
  },
  "keywords": [
    "formatter",
    "json", // last element has a trailing comma
  ],
  "nested": {
    "deep": {
      "x": 1,
    },
  },
}`;

  const sameValueNoComments =
    '{"name":"tidy-formatter","version":"0.1.0","engines":{"vscode":"^1.84.0"},' +
    '"keywords":["formatter","json"],"nested":{"deep":{"x":1}}}';

  it('treats JSONC (comments + trailing commas) as equal to the comment-free value', () => {
    const v = jsonEqual(jsonc, sameValueNoComments);
    assert.equal(v.equivalent, true, v.reason);
  });

  it('treats reformatting that only moves comments/whitespace as equivalent', () => {
    const reformatted = `{
  "name": "tidy-formatter",
  "version": "0.1.0",
  "engines": { "vscode": "^1.84.0" },
  "keywords": ["formatter", "json"],
  "nested": { "deep": { "x": 1 } }
}`;
    const v = jsonEqual(jsonc, reformatted);
    assert.equal(v.equivalent, true, v.reason);
  });

  it('rejects a value change hidden under comments (port 3000 -> 8080)', () => {
    const input = '{\n  // port\n  "port": 3000,\n}';
    const corrupted = '{\n  "port": 8080\n}';
    const v = jsonEqual(input, corrupted);
    assert.equal(v.equivalent, false);
    assert.ok(v.reason);
  });

  it('rejects a key dropped from a JSONC document with trailing commas', () => {
    const input = '{\n  "a": 1, // keep\n  "b": 2,\n}';
    const corrupted = '{\n  "a": 1\n}';
    assert.equal(jsonEqual(input, corrupted).equivalent, false);
  });

  it('is idempotent for the comment-free reflow of the JSONC value', () => {
    const pass1 = reflow(sameValueNoComments, 2);
    const pass2 = reflow(pass1, 2);
    const v = idempotence(JSONC_LANG, pass1, pass2);
    assert.equal(v.equivalent, true, v.reason);
  });
});

describe('complex JSON — mixed-type arrays', () => {
  // Every JSON type in one array, plus nested mixed arrays/objects.
  const mixed =
    '{"items":[' +
    '1,' +
    '-2.5,' +
    '"three",' +
    'true,' +
    'false,' +
    'null,' +
    '{"k":"v","n":[1,2,3]},' +
    '[10,"ten",[100]],' +
    '1e10,' +
    '""' +
    ']}';

  it('pretty-printing a heterogeneous array preserves order and values', () => {
    assertEquivalent('mixed pretty', mixed, reflow(mixed, 2));
  });

  it('preserves empty object/array members ({} and [] and "")', () => {
    const withEmpties = '{"a":{},"b":[],"c":"","d":[{}],"e":[[]]}';
    assertEquivalent('empties', withEmpties, reflow(withEmpties, 2));
  });

  it('is idempotent for the mixed array', () => {
    const pass1 = reflow(mixed, 2);
    const pass2 = reflow(pass1, 2);
    assert.equal(idempotence(JSON_LANG, pass1, pass2).equivalent, true);
  });

  it('rejects array element REORDER (order is meaningful in JSON arrays)', () => {
    assertRejected('reorder', '{"a":[1,2,3]}', '{"a":[3,2,1]}');
  });

  it('rejects a type change in one element (number 1 -> string "1")', () => {
    assertRejected('type change', '{"a":[1,2,3]}', '{"a":["1",2,3]}');
  });

  it('rejects a single element dropped from a mixed array', () => {
    assertRejected('element dropped', '{"a":[1,"two",true,null]}', '{"a":[1,"two",true]}');
  });

  it('accepts object key REORDER inside an array element (object keys are unordered)', () => {
    assertEquivalent('key reorder', '{"a":[{"x":1,"y":2}]}', '{"a":[{"y":2,"x":1}]}');
  });
});
