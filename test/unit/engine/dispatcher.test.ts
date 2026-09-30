// Unit tests for the engine dispatcher + engines (SPEC ENG-01/ENG-02, §4).
// Verifies: (1) each languageId routes to the right engine; (2) a .js file
// containing JSX re-routes to the prettier engine; (3) the dispatched format
// preserves the modern-syntax tokens the incumbent corrupted AND the output
// round-trips through the safety guard as equivalent.
import assert from 'node:assert/strict';
import {
  pickEngine,
  dispatchFormat,
  resolveEngineIdForSource
} from '../../../src/engine/dispatcher';
import { guardCheckNoFastPath } from '../../helpers/guardCheck';
import { preserveFixtures, routingFixtures } from '../../fixtures/engineFixtures';
import { resolved } from '../../helpers/options';

describe('engine/dispatcher : static routing (SPEC §4 matrix)', () => {
  for (const f of routingFixtures) {
    it(`${f.note}`, () => {
      const engine = pickEngine(f.lang);
      assert.equal(engine.id, f.expectedEngineId);
      assert.ok(engine.supports(f.lang), `${engine.id} must support ${f.lang}`);
    });
  }
});

describe('engine/dispatcher : JSX re-routing for plain .js (SPEC §4 note)', () => {
  it('routes plain JS to js-beautify', async () => {
    const out = await dispatchFormat({
      languageId: 'javascript',
      code: 'const x=1;',
      options: resolved()
    });
    // js-beautify spaces the assignment; prettier would add a trailing newline.
    assert.ok(out.includes('const x = 1;'));
  });

  it('re-routes a .js file that actually contains JSX to prettier (no broken tag)', async () => {
    const out = await dispatchFormat({
      languageId: 'javascript',
      code: 'const a = <App />;',
      options: resolved()
    });
    // If js-beautify had handled it, we would see '< App' corruption.
    assert.ok(out.includes('<App />'), `expected intact JSX, got: ${JSON.stringify(out)}`);
    assert.ok(!/<\s+App/.test(out), 'tag-open must not be split');
    // And the guard must accept the result.
    assert.equal(guardCheckNoFastPath('javascript', 'const a = <App />;', out).equivalent, true);
  });

  it('does NOT mis-route plain JS with comparison operators as JSX', async () => {
    // `a < b > c` looks JSX-ish to a regex but is not JSX; must stay on js-beautify
    // and round-trip safely.
    const code = 'const r = (a < b) > c;';
    const out = await dispatchFormat({ languageId: 'javascript', code, options: resolved() });
    assert.equal(guardCheckNoFastPath('javascript', code, out).equivalent, true);
  });
});

// M3-5 (v0.4.1): the cheap JSX pre-filter only accepted a LETTER after `<`, so
// a component whose name starts with `_` or `$` never reached the confirming
// parse. The file stayed on js-beautify, which printed
// "const a = < _Foo bar = {\n  x\n}\n/>;", and the guard then rejected the whole
// format with "JSX tag boundaries were altered": a FALSE REJECT on valid code,
// surfaced to the user as a warning toast and no format at all.
describe('engine/dispatcher : JSX names may start with _ or $ (M3-5)', () => {
  for (const [label, code] of [
    ['underscore component', 'const a = <_Foo bar={x} />;'],
    ['dollar component', 'const a = <$Bar bar={x} />;'],
    // The control: a lower-case intrinsic tag must keep working exactly as before.
    ['lower-case intrinsic tag', 'const a = <div bar={x} />;']
  ] as const) {
    it(`${label}: routes to prettier and the guard accepts the output`, async () => {
      assert.equal(
        resolveEngineIdForSource('javascript', code),
        'prettier',
        `${label} must reach the real-parser engine`
      );
      const out = await dispatchFormat({
        languageId: 'javascript',
        code,
        options: resolved()
      });
      assert.ok(
        !/<\s+[A-Za-z_$]/.test(out),
        `tag-open must not be split, got: ${JSON.stringify(out)}`
      );
      const verdict = guardCheckNoFastPath('javascript', code, out);
      assert.equal(
        verdict.equivalent,
        true,
        `guard rejected a valid format: ${JSON.stringify(verdict)}`
      );
    });
  }

  // The widened class must not drag anything NEW onto prettier: the confirming
  // parse is still what decides, so `<_` / `<$` that are not JSX stay put.
  for (const [label, code] of [
    ['plain assignment', 'const x = 1;'],
    ['comparison against an _ identifier', 'const r = a <_b;'],
    ['comparison against a $ identifier', 'const r = a <$b;'],
    ['left shift onto an _ identifier', 'const r = a <<_b;'],
    ['a JSX-looking string literal', 'const s = "<_Foo/>";'],
    ['a JSX-looking line comment', '// <$Bar/>\nconst s = 1;'],
    ['generic-looking comparison chain', 'const r = (a < b) > c;']
  ] as const) {
    it(`${label}: still routes to js-beautify`, () => {
      assert.equal(resolveEngineIdForSource('javascript', code), 'js-beautify');
    });
  }
});

describe('engine/dispatcher : modern-syntax preservation + guard round-trip', () => {
  for (const f of preserveFixtures) {
    it(`${f.id}: ${f.desc} [${f.ref}]`, async () => {
      const out = await dispatchFormat({
        languageId: f.lang,
        code: f.input,
        options: resolved()
      });
      for (const needle of f.mustContain) {
        assert.ok(
          out.includes(needle),
          `expected output to preserve "${needle}", got: ${JSON.stringify(out)}`
        );
      }
      // The whole point: a correct engine output must pass the safety guard.
      const verdict = guardCheckNoFastPath(f.lang, f.input, out);
      assert.equal(
        verdict.equivalent,
        true,
        `guard rejected a correct format: ${verdict.reason ?? ''}`
      );
    });
  }
});

describe('engine/dispatcher : defensive errors', () => {
  it('propagates an engine error rather than swallowing it', async () => {
    await assert.rejects(
      dispatchFormat({
        languageId: 'typescript',
        code: 'function f<T>(x: T): T { return', // unterminated -> prettier throws
        options: resolved()
      }),
      /prettier failed/
    );
  });
});
