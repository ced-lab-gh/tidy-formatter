// ADD-11: what the dispatcher loads, and what it does when it cannot load.
//
// The adversarial case is #4: if the babel chunk backing JSX DETECTION cannot
// load, `containsJsx` must NOT quietly answer false. Answering false would route
// a real JSX file to js-beautify, which provably corrupts JSX (that is the whole
// reason the re-routing exists). Propagating the failure gives the provider an
// explicit abort with the file left byte-identical.
import assert from 'node:assert/strict';
import {
  __isChunkLoadedForTests,
  __resetChunksForTests,
  __setChunkLoadForTests
} from '../../../src/chunks/loader';
import { dispatchFormat } from '../../../src/engine/dispatcher';
import { PrettierEngine } from '../../../src/engine/prettier';
import { resolved } from '../../helpers/options';

describe('engine/dispatcherLazy : nothing loads that is not needed (ADD-11)', () => {
  beforeEach(() => {
    __resetChunksForTests();
  });
  after(() => {
    __resetChunksForTests();
  });

  it('plain css format touches neither the babel nor the prettier chunk', async () => {
    const out = await dispatchFormat({
      languageId: 'css',
      code: '.a{color:red}',
      options: resolved()
    });
    assert.ok(out.length > 0);
    // The dispatcher alone loads nothing for css: js-beautify is in the host
    // bundle and the guard (which would load chunk-guard-css) has not run here.
    assert.equal(__isChunkLoadedForTests('chunk-guard-js'), false);
    assert.equal(__isChunkLoadedForTests('chunk-prettier'), false);
    assert.equal(__isChunkLoadedForTests('chunk-guard-css'), false);
  });

  it('plain json format loads no chunk at all', async () => {
    const out = await dispatchFormat({
      languageId: 'json',
      code: '{"a":1}',
      options: resolved()
    });
    assert.ok(out.length > 0);
    assert.equal(__isChunkLoadedForTests('chunk-guard-js'), false);
    assert.equal(__isChunkLoadedForTests('chunk-prettier'), false);
  });

  it('plain js without JSX-like tokens loads no chunk (the regex pre-filter wins)', async () => {
    const out = await dispatchFormat({
      languageId: 'javascript',
      code: 'const a = 1; function f(x){return x+a}',
      options: resolved()
    });
    assert.ok(out.includes('const a = 1;'));
    assert.equal(__isChunkLoadedForTests('chunk-guard-js'), false);
    assert.equal(__isChunkLoadedForTests('chunk-prettier'), false);
  });

  it('a .js containing real JSX loads chunk-guard-js and re-routes to prettier', async () => {
    const out = await dispatchFormat({
      languageId: 'javascript',
      code: 'const v = <div a={1}>x</div>;',
      options: resolved()
    });
    // js-beautify would have produced '< div': the re-route really happened.
    assert.ok(out.includes('<div a={1}>x</div>'), `got: ${JSON.stringify(out)}`);
    assert.equal(__isChunkLoadedForTests('chunk-guard-js'), true);
    assert.equal(__isChunkLoadedForTests('chunk-prettier'), true);
  });

  it('a JSX-LOOKING comparison-only .js loads no chunk: the lexical scan rules JSX out (MEDIUM-06)', async () => {
    const out = await dispatchFormat({
      languageId: 'javascript',
      code: 'const ok = a<b && c>d;',
      options: resolved()
    });
    // It used to load the babel chunk and run a full parse to learn that `a<b` is
    // a comparison (1.9 to 4.8 s on a 5 MB file, probe P11). No `<` sits where an
    // expression can start, so neither chunk is touched and js-beautify prints it.
    assert.equal(__isChunkLoadedForTests('chunk-guard-js'), false);
    assert.equal(__isChunkLoadedForTests('chunk-prettier'), false);
    assert.ok(out.includes('a < b'), `got: ${JSON.stringify(out)}`);
  });

  it('a .js the scan cannot rule out still loads the detector chunk and stays on js-beautify', async () => {
    // A `<` on the line after its left operand could follow an automatic
    // semicolon, so the scan answers "maybe" and the real parse decides.
    const out = await dispatchFormat({
      languageId: 'javascript',
      code: 'const ok = a\n<b && c>d;',
      options: resolved()
    });
    assert.equal(__isChunkLoadedForTests('chunk-guard-js'), true);
    assert.equal(__isChunkLoadedForTests('chunk-prettier'), false);
    assert.ok(/a\s*<\s*b/.test(out), `got: ${JSON.stringify(out)}`);
  });
});

describe('engine/dispatcherLazy : a chunk that cannot load aborts loudly (ADD-11)', () => {
  beforeEach(() => {
    __resetChunksForTests();
  });
  after(() => {
    __resetChunksForTests();
  });

  it('guard-js chunk load failure during JSX detection propagates (no silent reroute)', async () => {
    __setChunkLoadForTests('chunk-guard-js', () => {
      throw new Error('unavailable');
    });
    // ADVERSARIAL: the alternative behaviour (swallow, return false) would hand
    // real JSX to js-beautify and corrupt it. The abort is the safe answer.
    await assert.rejects(
      dispatchFormat({
        languageId: 'javascript',
        code: 'const v = <div>x</div>;',
        options: resolved()
      }),
      /failed to load chunk-guard-js/
    );
  });

  it('prettier chunk load failure surfaces as a typed engine error', async () => {
    __setChunkLoadForTests('chunk-prettier', () => {
      throw new Error('unavailable');
    });
    const engine = new PrettierEngine();
    await assert.rejects(
      engine.format({
        languageId: 'typescript',
        code: 'const a=1',
        options: resolved()
      }),
      /prettier engine unavailable: failed to load chunk-prettier/
    );
  });

  it('prettier chunk load failure also aborts the CSS fallback path', async () => {
    __setChunkLoadForTests('chunk-prettier', () => {
      throw new Error('unavailable');
    });
    const engine = new PrettierEngine();
    await assert.rejects(
      engine.format({
        languageId: 'css',
        code: '.a{color:red}',
        options: resolved()
      }),
      /prettier engine unavailable: failed to load chunk-prettier/
    );
  });

  it('a failed engine load never returns a partially formatted string', async () => {
    __setChunkLoadForTests('chunk-prettier', () => {
      throw new Error('unavailable');
    });
    let result: string | undefined;
    try {
      result = await dispatchFormat({
        languageId: 'typescript',
        code: 'const  a  =  1',
        options: resolved()
      });
    } catch {
      result = undefined;
    }
    assert.equal(result, undefined, 'a load failure must never yield engine output');
  });
});
