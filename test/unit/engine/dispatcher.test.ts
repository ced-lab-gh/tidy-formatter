// Unit tests for the engine dispatcher + engines (SPEC ENG-01/ENG-02, §4).
// Verifies: (1) each languageId routes to the right engine; (2) a .js file
// containing JSX re-routes to the prettier engine; (3) the dispatched format
// preserves the modern-syntax tokens the incumbent corrupted AND the output
// round-trips through the safety guard as equivalent.
import assert from 'node:assert/strict';
import { pickEngine, dispatchFormat } from '../../../src/engine/dispatcher';
import { guard } from '../../../src/safety/guard';
import { preserveFixtures, routingFixtures } from '../../fixtures/engineFixtures';
import { resolved } from '../../helpers/options';

describe('engine/dispatcher — static routing (SPEC §4 matrix)', () => {
  for (const f of routingFixtures) {
    it(`${f.note}`, () => {
      const engine = pickEngine(f.lang);
      assert.equal(engine.id, f.expectedEngineId);
      assert.ok(engine.supports(f.lang), `${engine.id} must support ${f.lang}`);
    });
  }
});

describe('engine/dispatcher — JSX re-routing for plain .js (SPEC §4 note)', () => {
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
    assert.equal(guard.check('javascript', 'const a = <App />;', out).equivalent, true);
  });

  it('does NOT mis-route plain JS with comparison operators as JSX', async () => {
    // `a < b > c` looks JSX-ish to a regex but is not JSX; must stay on js-beautify
    // and round-trip safely.
    const code = 'const r = (a < b) > c;';
    const out = await dispatchFormat({ languageId: 'javascript', code, options: resolved() });
    assert.equal(guard.check('javascript', code, out).equivalent, true);
  });
});

describe('engine/dispatcher — modern-syntax preservation + guard round-trip', () => {
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
      const verdict = guard.check(f.lang, f.input, out);
      assert.equal(
        verdict.equivalent,
        true,
        `guard rejected a correct format: ${verdict.reason ?? ''}`
      );
    });
  }
});

describe('engine/dispatcher — defensive errors', () => {
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
