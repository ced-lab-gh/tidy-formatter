// DIFFERENTIAL PROOF for the AST-position JSX boundary fingerprint.
//
// The guard's fingerprint (`jsxBoundaryFingerprint` in src/safety/guard.ts) used
// to be computed from a second parse with `tokens: true`, which is quadratic in
// @babel/parser 7.29 on scripts dense in template literals (1 MiB: 4.6 s -> 70 s
// in an HTML document). It is now read from the AST `parseJs` already produced.
// That is only acceptable if it never marks FEWER tags than before: a
// fingerprint that did would let the guard accept a detached `<` it used to
// refuse.
//
// test/helpers/jsxFingerprintReference.ts keeps the token version verbatim. This
// file runs both on every input below and demands, for each one:
//   - the same outcome: both produce a fingerprint, or both refuse the source;
//   - when both produce one, the same string, byte for byte.
// Any single disagreement fails the test and names the input. The one known
// difference (a generic arrow after `if (...)`, `while (...)`, a block or
// `yield`, where only the AST version marks the `<`) is stricter, is absent
// from these inputs, and is pinned by its own test below.
//
// Inputs: hand-written edge cases (a comment or a line break between `<` and the
// name, fragments, member expressions, namespaced names, templates, `#private`
// names, TypeScript generics that share the `<`), every string in every fixture
// module of the repo, the JSX files of the repo, the `<script>` bodies of the
// HTML fixtures, and seeded generated programs (grammar-based and mutated).
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { guard, jsxBoundaryFingerprintOfSource } from '../../../src/safety/guard';
import { referenceJsxBoundaryFingerprint } from '../../helpers/jsxFingerprintReference';
import {
  EDGE_CASES,
  generateGrammarCases,
  mutateCases
} from '../../helpers/jsxFingerprintCases';
import * as corpusModule from '../../fixtures/corpus';
import * as guardFixturesModule from '../../fixtures/guardFixtures';
import * as corruptionModule from '../../fixtures/corruptionFixtures';
import * as jsTsJsxModule from '../../fixtures/complex/jsTsJsx';
import * as hostComplexModule from '../../fixtures/complex/hostComplex';
import * as polyglotHostModule from '../../fixtures/complex/polyglotHost';
import * as htmlEmbeddedModule from '../../fixtures/polyglot/htmlEmbedded';
import * as cssInJsModule from '../../fixtures/polyglot/cssInJs';
import * as polyglotModule from '../../fixtures/polyglotFixtures';
import * as engineModule from '../../fixtures/engineFixtures';
import * as idempotenceModule from '../../fixtures/idempotenceFixtures';
import * as templateModule from '../../fixtures/templateFixtures';

const REPO_ROOT = join(__dirname, '..', '..', '..');

type Outcome = { readonly produced: true; readonly fingerprint: string } | { readonly produced: false };

function viaReference(code: string): Outcome {
  try {
    return { produced: true, fingerprint: referenceJsxBoundaryFingerprint(code) };
  } catch {
    return { produced: false };
  }
}

function viaAst(code: string): Outcome {
  try {
    return { produced: true, fingerprint: jsxBoundaryFingerprintOfSource(code) };
  } catch {
    return { produced: false };
  }
}

interface Tally {
  compared: number;
  jsxBearing: number;
  refusedByBoth: number;
  disagreements: string[];
}

const totals: Tally = { compared: 0, jsxBearing: 0, refusedByBoth: 0, disagreements: [] };

function show(code: string): string {
  const clipped = code.length > 160 ? `${code.slice(0, 160)}...` : code;
  return JSON.stringify(clipped);
}

/** Compare the two implementations on one input and record any disagreement. */
function compareOne(code: string, tally: Tally): void {
  const reference = viaReference(code);
  const actual = viaAst(code);
  tally.compared += 1;
  totals.compared += 1;
  if (!reference.produced && !actual.produced) {
    tally.refusedByBoth += 1;
    totals.refusedByBoth += 1;
    return;
  }
  if (reference.produced && actual.produced && reference.fingerprint === actual.fingerprint) {
    if (reference.fingerprint !== '') {
      tally.jsxBearing += 1;
      totals.jsxBearing += 1;
    }
    return;
  }
  const detail =
    reference.produced && actual.produced
      ? `reference=${JSON.stringify(reference.fingerprint)} ast=${JSON.stringify(actual.fingerprint)}`
      : `reference ${reference.produced ? 'produced' : 'refused'}, ast ${actual.produced ? 'produced' : 'refused'}`;
  const line = `${detail} on ${show(code)}`;
  tally.disagreements.push(line);
  totals.disagreements.push(line);
}

function runAll(inputs: Iterable<string>): Tally {
  const tally: Tally = { compared: 0, jsxBearing: 0, refusedByBoth: 0, disagreements: [] };
  for (const code of inputs) {
    compareOne(code, tally);
  }
  return tally;
}

function assertNoDisagreement(tally: Tally): void {
  assert.equal(
    tally.disagreements.length,
    0,
    `${tally.disagreements.length} disagreement(s), first: ${tally.disagreements.slice(0, 3).join(' || ')}`
  );
}

/** Every string reachable from a fixture module's exports. */
function stringsOf(value: unknown, into: Set<string>, depth = 0): void {
  if (depth > 8 || value === null || value === undefined) {
    return;
  }
  if (typeof value === 'string') {
    if (value.includes('<')) {
      into.add(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      stringsOf(item, into, depth + 1);
    }
    return;
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) {
      stringsOf(item, into, depth + 1);
    }
  }
}

function scriptBodies(html: string): string[] {
  const bodies: string[] = [];
  const pattern = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  for (let match = pattern.exec(html); match !== null; match = pattern.exec(html)) {
    bodies.push(match[1]);
  }
  return bodies;
}

function filesUnder(dir: string, extensions: readonly string[]): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...filesUnder(full, extensions));
    } else if (extensions.some((ext) => entry.endsWith(ext))) {
      found.push(full);
    }
  }
  return found;
}

const FIXTURE_MODULES: readonly unknown[] = [
  corpusModule,
  guardFixturesModule,
  corruptionModule,
  jsTsJsxModule,
  hostComplexModule,
  polyglotHostModule,
  htmlEmbeddedModule,
  cssInJsModule,
  polyglotModule,
  engineModule,
  idempotenceModule,
  templateModule
];

const GENERATED_COUNT = Number(process.env.JSX_FP_FUZZ_N ?? '3000');

describe('safety/guard : JSX boundary fingerprint, AST positions against the token reference', function () {
  // The first parse loads the verifier chunk; the reference is slow by design.
  this.timeout(180000);

  it('agrees on the hand-written edge cases (comments and line breaks after `<`, fragments, members, namespaces, templates, #private, TS generics)', () => {
    const tally = runAll(EDGE_CASES);
    assertNoDisagreement(tally);
    assert.ok(tally.jsxBearing >= 90, `expected at least 90 JSX-bearing edge cases, got ${tally.jsxBearing}`);
    assert.ok(tally.refusedByBoth >= 4, 'the refused programs must be refused by both sides');
  });

  it('agrees on the glued/detached cases whose expected marks are known (the reference is not silently wrong)', () => {
    const expected: ReadonlyArray<readonly [string, string]> = [
      ['const a = <A />;', 'open:glued'],
      ['const a = < A />;', 'open:split'],
      ['const a = <\nA />;', 'open:split'],
      ['const a = < A />;', 'open:split'],
      ['const a = </*c*/A />;', 'open:glued'],
      ['const a = <\n/*c*/A />;', 'open:split'],
      ['const a = <A></A>;', 'open:glued|open:glued'],
      ['const a = <A></ A>;', 'open:glued|open:glued'],
      ['const a = <A>< /A>;', 'open:glued|open:split'],
      ['const a = <></>;', 'open:glued|open:glued'],
      ['const a = < ></ >;', 'open:split|open:glued'],
      ['const a = <A / >;', 'open:glued'],
      ['const a = <a . b />;', 'open:glued'],
      ['const a = `${< A />}`;', 'open:split'],
      // a generic arrow is not JSX, but its `<` is a jsxTagStart token babel leaves behind
      ['const f = <T,>(x: T) => x;', 'open:glued'],
      ['const f = < T,>(x: T) => x;', 'open:split'],
      ['const f = <T,>(x: T) => < A />;', 'open:glued|open:split'],
      // (the async form is not here: only the AST version marks it, see the test below)
      ['f<T>(x); a < b;', '']
    ];
    for (const [code, marks] of expected) {
      const want = { produced: true, fingerprint: marks };
      assert.deepEqual(viaAst(code), want, `ast: ${show(code)}`);
      assert.deepEqual(viaReference(code), want, `reference: ${show(code)}`);
    }
  });

  it('marks MORE than the reference, never fewer, where babel leaves no jsxTagStart for a generic arrow', () => {
    // Found by the adversarial review (audit-v050/13, D1): after `if (...)`,
    // `while (...)`, `for (...)`, `with (...)`, a block or `yield`, the tokenizer
    // reads the `<` of a generic arrow as a plain `<` token, so the reference has
    // nothing to mark, while the AST still holds the arrow and its type
    // parameters and the walk marks that `<`. The difference only ever refuses a
    // detached `< T,>` the reference let through: stricter, never looser. It is
    // pinned here so that nobody "fixes" it back to equality by dropping the mark.
    //
    // D3 adds the generic arrow after `async`: babel lexes that `<` as a plain
    // token too (the arrow starts at `async`, its type parameters at the `<`), so
    // the reference marked nothing and `async < T,>(x: T) => x` was accepted. It is
    // marked like every other generic arrow now.
    const stricter: ReadonlyArray<readonly [string, string]> = [
      ['if (a) <T,>(x: T) => x;', 'if (a) < T,>(x: T) => x;'],
      ['while (a) <T,>(x: T) => x;', 'while (a) < T,>(x: T) => x;'],
      ['function* g() { yield <T,>(y: T) => y; }', 'function* g() { yield < T,>(y: T) => y; }'],
      ['const f = async <T,>(x: T) => x;', 'const f = async < T,>(x: T) => x;'],
      ['const f = async <T extends unknown>(x: T) => x;', 'const f = async < T extends unknown>(x: T) => x;'],
      ['foo(async <T,>(x: T) => x);', 'foo(async < T,>(x: T) => x);'],
      ['const f = (async <T,>(x: T) => x);', 'const f = (async < T,>(x: T) => x);'],
      ['class K { p = async <T,>(x: T) => x; }', 'class K { p = async < T,>(x: T) => x; }']
    ];
    for (const [glued, detached] of stricter) {
      assert.deepEqual(viaReference(glued), { produced: true, fingerprint: '' }, `reference: ${show(glued)}`);
      assert.deepEqual(viaAst(glued), { produced: true, fingerprint: 'open:glued' }, `ast: ${show(glued)}`);
      assert.equal(
        guard.check('typescriptreact', glued, detached).equivalent,
        false,
        `the detached generic arrow must be refused: ${show(detached)}`
      );
    }
  });

  it('leaves the `<` of a generic in TYPE position unmarked, the reference and the AST alike (D3 does not reach them)', () => {
    const typePosition: readonly string[] = [
      'type F = <T,>(x: T) => T;',
      'type F = < T,>(x: T) => T;',
      'interface I { f: <T,>(x: T) => void }',
      'declare function f<T,>(x: T): void;',
      'class C { async m<T,>(x: T) {} }',
      'async function f<T,>(x: T) {}'
    ];
    for (const code of typePosition) {
      assert.deepEqual(viaReference(code), { produced: true, fingerprint: '' }, `reference: ${show(code)}`);
      assert.deepEqual(viaAst(code), { produced: true, fingerprint: '' }, `ast: ${show(code)}`);
    }
    assert.equal(
      guard.check('typescriptreact', 'type F = <T,>(x: T) => T;', 'type F = < T,>(x: T) => T;').equivalent,
      true
    );
  });

  it('agrees on every string in every fixture module of the repo', () => {
    const strings = new Set<string>();
    for (const fixtureModule of FIXTURE_MODULES) {
      stringsOf(fixtureModule, strings);
    }
    const tally = runAll(strings);
    assertNoDisagreement(tally);
    assert.ok(tally.compared >= 300, `expected at least 300 fixture strings, got ${tally.compared}`);
    assert.ok(tally.jsxBearing >= 40, `expected at least 40 JSX-bearing fixture strings, got ${tally.jsxBearing}`);
  });

  it('agrees on the `<script>` bodies of every HTML fixture string and every .html fixture file', () => {
    const htmlTexts = new Set<string>();
    for (const fixtureModule of FIXTURE_MODULES) {
      stringsOf(fixtureModule, htmlTexts);
    }
    for (const file of filesUnder(join(REPO_ROOT, 'test', 'fixtures', 'html'), ['.html'])) {
      htmlTexts.add(readFileSync(file, 'utf8'));
    }
    const bodies: string[] = [];
    for (const text of htmlTexts) {
      if (/<script\b/i.test(text)) {
        bodies.push(...scriptBodies(text));
      }
    }
    const tally = runAll(bodies);
    assertNoDisagreement(tally);
    assert.ok(tally.compared >= 40, `expected at least 40 script bodies, got ${tally.compared}`);
  });

  it('agrees on the JSX files of the repo (samples and integration workspaces)', () => {
    const files = [
      ...filesUnder(join(REPO_ROOT, 'samples'), ['.tsx', '.jsx', '.ts', '.js']),
      ...filesUnder(join(REPO_ROOT, 'test', 'integration', 'workspace'), ['.tsx', '.jsx', '.ts', '.js'])
    ];
    const tally = runAll(files.map((file) => readFileSync(file, 'utf8')));
    assertNoDisagreement(tally);
    // Thresholds count only the files git tracks (four .tsx): a clean CI checkout
    // has nothing else here, while a local tree may hold untracked extras.
    assert.ok(tally.compared >= 4, `expected at least 4 repo files, got ${tally.compared}`);
    assert.ok(tally.jsxBearing >= 4, `expected at least 4 JSX-bearing repo files, got ${tally.jsxBearing}`);
  });

  it('agrees on generated programs (random separators, comments and line breaks at every gap of a tag)', () => {
    const tally = runAll(generateGrammarCases(20260930, GENERATED_COUNT));
    assertNoDisagreement(tally);
    assert.ok(tally.jsxBearing >= GENERATED_COUNT * 0.5, `too few JSX-bearing generated programs: ${tally.jsxBearing}`);
  });

  it('agrees on mutated programs (insertions, deletions, substitutions; refusals must match too)', () => {
    const seeds = [...EDGE_CASES.filter((code) => code.includes('<')), ...generateGrammarCases(7, 200)];
    const tally = runAll(mutateCases(seeds, 20261001, GENERATED_COUNT));
    assertNoDisagreement(tally);
    assert.ok(tally.jsxBearing >= GENERATED_COUNT * 0.2, `too few JSX-bearing mutants: ${tally.jsxBearing}`);
  });

  after(() => {
    // The size of the proof, for the record (and for the CHANGELOG-side reader).
    // eslint-disable-next-line no-console
    console.log(
      `      jsx fingerprint differential: ${totals.compared} inputs compared, ` +
        `${totals.jsxBearing} with at least one JSX tag, ${totals.refusedByBoth} refused by both, ` +
        `${totals.disagreements.length} disagreements`
    );
  });
});
