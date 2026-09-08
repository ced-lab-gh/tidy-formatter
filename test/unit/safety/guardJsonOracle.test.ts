// Differential oracle for the guard's JSON verdict.
//
// `parseJsonValue` streams a document into canonical form with jsonc-parser's
// `visit`. That streaming pass is what buys the size-invariant, duplicate-faithful
// verdict (see test/unit/safety/guardSizeInvariance.test.ts), but a hand-rolled
// state machine over a callback API is exactly the kind of code that goes subtly
// wrong: a mislaid `pendingKey`, a frame closed against the wrong parent, a
// member attached to the container above it.
//
// So this file re-derives the verdict a SECOND, independent way: it walks
// jsonc-parser's syntax TREE (`parseTree`, the API the guard deliberately does
// NOT use) into its own value shape and compares that. The two implementations
// share the scanner and nothing else - no data structure, no traversal, no
// comparison function - so agreement on thousands of generated pairs is real
// evidence, and a disagreement is a bug in one of them.
//
// The corpus is generated from a seeded PRNG so any failure reproduces exactly,
// and it deliberately includes the shapes that have each cost this guard a false
// accept: duplicate members, `__proto__` keys, and arrays of two-element arrays
// (which is what an OBJECT looks like once it is canonicalized into sorted
// `[key, value]` pairs).
import assert from 'node:assert/strict';
import { parseTree, type Node } from 'jsonc-parser';
import { guard, jsonEqual } from '../../../src/safety/guard';

// --- the independent reference implementation ------------------------------

/**
 * Reference canonical value, built from the syntax TREE. Objects and arrays are
 * different variants of a tagged union, so the reference cannot confuse them
 * even in principle: it does not need the guard's `CanonicalObject` trick, it
 * simply never represents an object as an array.
 */
type RefValue =
  | { readonly kind: 'object'; readonly members: ReadonlyArray<readonly [string, RefValue]> }
  | { readonly kind: 'array'; readonly items: readonly RefValue[] }
  | { readonly kind: 'literal'; readonly value: unknown };

const REF_NULL: RefValue = { kind: 'literal', value: null };

function refFromNode(node: Node): RefValue {
  if (node.type === 'object') {
    const members: Array<readonly [string, RefValue]> = [];
    for (const property of node.children ?? []) {
      const nameNode = property.children?.[0];
      const valueNode = property.children?.[1];
      members.push([
        typeof nameNode?.value === 'string' ? nameNode.value : '',
        valueNode === undefined ? REF_NULL : refFromNode(valueNode)
      ]);
    }
    // Stable sort by key only: duplicates keep their source order, which is what
    // decides which member wins.
    members.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return { kind: 'object', members };
  }
  if (node.type === 'array') {
    return { kind: 'array', items: (node.children ?? []).map(refFromNode) };
  }
  return { kind: 'literal', value: node.value === undefined ? null : node.value };
}

function refParse(code: string): RefValue | undefined {
  const errors: Array<{ error: number; offset: number; length: number }> = [];
  const tree = parseTree(code, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0 || tree === undefined) {
    return undefined;
  }
  return refFromNode(tree);
}

function refEqual(a: RefValue, b: RefValue): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  if (a.kind === 'object' && b.kind === 'object') {
    return (
      a.members.length === b.members.length &&
      a.members.every((member, index) => {
        const other = b.members[index];
        return member[0] === other[0] && refEqual(member[1], other[1]);
      })
    );
  }
  if (a.kind === 'array' && b.kind === 'array') {
    return (
      a.items.length === b.items.length &&
      a.items.every((item, index) => refEqual(item, b.items[index]))
    );
  }
  // `===`, matching the guard: JSON numbers are decimal values with no signed
  // zero, so `-0` and `0` denote the same number and a formatter that
  // round-trips through a parser legitimately turns one into the other.
  return (a as { value: unknown }).value === (b as { value: unknown }).value;
}

/** The verdict the tree path says the guard should reach. */
function referenceVerdict(input: string, output: string): boolean {
  const left = refParse(input);
  const right = refParse(output);
  if (left === undefined || right === undefined) {
    return false;
  }
  return refEqual(left, right);
}

// --- generated documents ---------------------------------------------------

/** Deterministic PRNG (mulberry32) so a failing corpus reproduces exactly. */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type GenNode =
  | { readonly kind: 'object'; readonly members: ReadonlyArray<readonly [string, GenNode]> }
  | { readonly kind: 'array'; readonly items: readonly GenNode[] }
  | { readonly kind: 'literal'; readonly text: string };

// A tiny key alphabet so duplicate members appear on their own, plus the two
// names that have historically vanished during parsing.
const KEYS = ['a', 'b', 'a', '__proto__', 'c', '__proto__', 'constructor', 'a'] as const;
const LITERALS = ['1', '2', '0', '-0', 'true', 'false', 'null', '"x"', '"y"', '1.5', '"a"'] as const;

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length) % items.length];
}

function generate(rng: () => number, depth: number): GenNode {
  const roll = rng();
  if (depth <= 0 || roll < 0.4) {
    return { kind: 'literal', text: pick(rng, LITERALS) };
  }
  if (roll < 0.7) {
    const members: Array<readonly [string, GenNode]> = [];
    const count = Math.floor(rng() * 4);
    for (let i = 0; i < count; i += 1) {
      members.push([pick(rng, KEYS), generate(rng, depth - 1)]);
    }
    return { kind: 'object', members };
  }
  const items: GenNode[] = [];
  const count = Math.floor(rng() * 4);
  for (let i = 0; i < count; i += 1) {
    items.push(generate(rng, depth - 1));
  }
  return { kind: 'array', items };
}

/** Print a generated document, either minified or indented. */
function print(node: GenNode, pretty: boolean, indent = 0): string {
  const pad = pretty ? '\n' + '  '.repeat(indent + 1) : '';
  const close = pretty ? '\n' + '  '.repeat(indent) : '';
  if (node.kind === 'literal') {
    return node.text;
  }
  if (node.kind === 'object') {
    if (node.members.length === 0) {
      return '{}';
    }
    const body = node.members
      .map(([key, value]) => `${pad}${JSON.stringify(key)}:${pretty ? ' ' : ''}${print(value, pretty, indent + 1)}`)
      .join(',');
    return `{${body}${close}}`;
  }
  if (node.items.length === 0) {
    return '[]';
  }
  return `[${node.items.map((item) => `${pad}${print(item, pretty, indent + 1)}`).join(',')}${close}]`;
}

/**
 * Structure-level mutations. Every one keeps the text VALID JSON: the point is
 * to make the two implementations agree on a verdict, not to test error paths.
 * Several are deliberate no-ops on value (a reorder of distinct keys), several
 * are corruptions, and the reference decides which is which.
 */
function mutate(node: GenNode, rng: () => number): GenNode {
  const roll = rng();
  if (node.kind === 'object') {
    if (roll < 0.18 && node.members.length > 0) {
      // Delete a member (deletes a duplicate whenever it picks one).
      const index = Math.floor(rng() * node.members.length);
      return { kind: 'object', members: node.members.filter((_, i) => i !== index) };
    }
    if (roll < 0.32 && node.members.length > 0) {
      // Duplicate a member.
      const index = Math.floor(rng() * node.members.length);
      return { kind: 'object', members: [...node.members, node.members[index]] };
    }
    if (roll < 0.46 && node.members.length > 1) {
      // Reverse the member list: a no-op for distinct keys, a real change as
      // soon as two members share a key.
      return { kind: 'object', members: [...node.members].reverse() };
    }
    if (roll < 0.56) {
      // Rewrite the object as an ARRAY of [key, value] pairs. This is exactly
      // the canonical form the guard builds internally, and accepting it would
      // be the object/array conflation.
      return {
        kind: 'array',
        items: node.members.map(([key, value]) => ({
          kind: 'array' as const,
          items: [{ kind: 'literal' as const, text: JSON.stringify(key) }, value]
        }))
      };
    }
    return {
      kind: 'object',
      members: node.members.map(([key, value]) => [key, mutate(value, rng)] as const)
    };
  }
  if (node.kind === 'array') {
    if (roll < 0.15 && node.items.length > 1) {
      return { kind: 'array', items: [...node.items].reverse() };
    }
    if (roll < 0.25) {
      // An array of pairs rewritten as an object: the conflation, mirrored.
      const members: Array<readonly [string, GenNode]> = [];
      for (const item of node.items) {
        if (item.kind === 'array' && item.items.length === 2 && item.items[0].kind === 'literal') {
          members.push([JSON.parse(item.items[0].text) as string, item.items[1]]);
        }
      }
      if (members.length === node.items.length && members.length > 0) {
        return { kind: 'object', members };
      }
    }
    return { kind: 'array', items: node.items.map((item) => mutate(item, rng)) };
  }
  if (roll < 0.2) {
    return { kind: 'literal', text: pick(rng, LITERALS) };
  }
  return node;
}

// Past the 256 KB threshold the removed fast path used to switch on, and not
// much past it: every padded trial below scans this twice with two different
// implementations, so the constant is a direct multiplier on the suite's time.
const PADDING = `,"pad":"${'x'.repeat(264 * 1024)}"`;

// Padded trials parse ~1 MB each. Under c8 instrumentation that is comfortably
// over mocha's 2 s default, and a safety test that flakes on a slow machine is
// worse than one with an explicit budget.
const PADDED_TIMEOUT_MS = 20_000;
const PADDED_TRIALS = 12;

/** Cross the former threshold without changing what a document means. */
function pad(document: string): string {
  return document.endsWith('}') && document.length > 2
    ? `${document.slice(0, -1)}${PADDING}}`
    : `{"wrapped":${document}${PADDING}}`;
}

// --- the oracle itself -----------------------------------------------------

describe('safety/guard : the streaming JSON canonicalizer agrees with a tree-built oracle', () => {
  const TRIALS = 1200;

  it(`matches the syntax-tree reference on ${TRIALS} generated pairs`, () => {
    const rng = makeRng(0x7d1d1a5);
    let accepted = 0;
    let rejected = 0;
    for (let trial = 0; trial < TRIALS; trial += 1) {
      const document = generate(rng, 4);
      const changed = rng() < 0.65 ? mutate(document, rng) : document;
      const input = print(document, false);
      const output = print(changed, rng() < 0.5);
      const expected = referenceVerdict(input, output);
      const actual = jsonEqual(input, output).equivalent;
      assert.equal(
        actual,
        expected,
        `trial ${trial}: guard says ${String(actual)}, tree oracle says ${String(expected)}\n` +
          `  input : ${input.slice(0, 300)}\n  output: ${output.slice(0, 300)}`
      );
      if (expected) {
        accepted += 1;
      } else {
        rejected += 1;
      }
    }
    // A corpus that only ever produced one verdict would pass vacuously.
    assert.ok(accepted > TRIALS / 20, `corpus produced only ${accepted} accepts`);
    assert.ok(rejected > TRIALS / 20, `corpus produced only ${rejected} rejects`);
  });

  it('still matches the oracle once both documents cross the former threshold', function () {
    this.timeout(PADDED_TIMEOUT_MS);
    const rng = makeRng(0x51ce1);
    for (let trial = 0; trial < PADDED_TRIALS; trial += 1) {
      const document = generate(rng, 3);
      const changed = rng() < 0.7 ? mutate(document, rng) : document;
      const input = pad(print(document, false));
      const output = pad(print(changed, true));
      assert.ok(input.length > 256 * 1024 && output.length > 256 * 1024);
      assert.equal(
        jsonEqual(input, output).equivalent,
        referenceVerdict(input, output),
        `padded trial ${trial}: guard and tree oracle disagree`
      );
    }
  });

  it('the guard verdict is unchanged by padding both documents (size invariance)', function () {
    this.timeout(PADDED_TIMEOUT_MS);
    const rng = makeRng(0xbadc0de);
    for (let trial = 0; trial < PADDED_TRIALS; trial += 1) {
      const document = generate(rng, 3);
      const changed = rng() < 0.7 ? mutate(document, rng) : document;
      const input = print(document, false);
      const output = print(changed, true);
      assert.equal(
        jsonEqual(pad(input), pad(output)).equivalent,
        jsonEqual(input, output).equivalent,
        `padded trial ${trial}: the verdict changed with document size`
      );
    }
  });
});

// --- objects are not arrays ------------------------------------------------
//
// Canonicalizing an object into sorted `[key, value]` pairs is what makes
// duplicate members and `__proto__` visible, but a BARE pair array gives
// `{"a":1}` and `[["a",1]]` the same canonical value. The guard accepted that
// rewrite until `CanonicalObject` made objects a nominal type.

describe('safety/guard : a JSON object is never equivalent to an array', () => {
  const SHAPES: ReadonlyArray<readonly [label: string, object: string, array: string]> = [
    ['single member', '{"a":1}', '[["a",1]]'],
    ['two members', '{"a":1,"b":2}', '[["a",1],["b",2]]'],
    ['empty container', '{}', '[]'],
    ['duplicate members', '{"a":1,"a":2}', '[["a",1],["a",2]]'],
    ['__proto__ member', '{"__proto__":1}', '[["__proto__",1]]']
  ];

  for (const [label, objectText, arrayText] of SHAPES) {
    it(`rejects '${label}' rewritten from object to array, and back`, () => {
      assert.equal(jsonEqual(objectText, arrayText).equivalent, false, 'object -> array');
      assert.equal(jsonEqual(arrayText, objectText).equivalent, false, 'array -> object');
    });

    it(`rejects '${label}' the same way above the former 256 KB threshold`, () => {
      assert.equal(jsonEqual(pad(objectText), pad(arrayText)).equivalent, false);
      assert.equal(jsonEqual(pad(arrayText), pad(objectText)).equivalent, false);
    });
  }

  it('rejects the rewrite when it happens DEEP inside a document', () => {
    assert.equal(jsonEqual('{"o":{"a":1}}', '{"o":[["a",1]]}').equivalent, false);
    assert.equal(jsonEqual('{"o":[{"a":1}]}', '{"o":[[["a",1]]]}').equivalent, false);
  });

  it('anti-false-rejection: a genuine array of pairs still reformats cleanly', () => {
    assert.equal(jsonEqual('[["a",1],["b",2]]', '[\n  ["a", 1],\n  ["b", 2]\n]').equivalent, true);
  });

  it('anti-false-rejection: an object of objects still reformats cleanly', () => {
    assert.equal(jsonEqual('{"o":{"a":1}}', '{\n  "o": {\n    "a": 1\n  }\n}').equivalent, true);
  });
});

// --- the same canonical form, reached through HTML --------------------------
//
// `<script type="application/json">` bodies are compared by STRINGIFYING the
// same canonical value, so the object/array conflation reached the HTML guard
// too: before `CanonicalObject`, an embedded `{"a":1}` rewritten to `[["a",1]]`
// was accepted there as well. `CanonicalObject.toJSON` is what keeps that
// serialisation injective, and these pin it.

describe('safety/guard : embedded JSON keeps objects and arrays apart', () => {
  function page(body: string): string {
    return `<!doctype html><html><body><script type="application/json">${body}</script></body></html>`;
  }

  it('rejects an embedded object rewritten as an array of pairs', () => {
    assert.equal(guard.check('html', page('{"a":1}'), page('[["a",1]]')).equivalent, false);
    assert.equal(guard.check('html', page('{}'), page('[]')).equivalent, false);
  });

  it('rejects an embedded duplicate member being dropped', () => {
    assert.equal(guard.check('html', page('{"a":1,"a":2}'), page('{"a":2}')).equivalent, false);
  });

  it('anti-false-rejection: an embedded body may still be reindented and reordered', () => {
    assert.equal(
      guard.check('html', page('{"a":1,"b":2}'), page('{\n  "a": 1,\n  "b": 2\n}')).equivalent,
      true
    );
    assert.equal(guard.check('html', page('{"b":2,"a":1}'), page('{"a":1,"b":2}')).equivalent, true);
  });
});
