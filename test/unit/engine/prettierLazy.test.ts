// ADD-11: the Prettier engine produces byte-identical output whether its
// printer was loaded eagerly (pre-ADD-11) or lazily, and a failed load leaves
// no partial state behind.
import assert from 'node:assert/strict';
import {
  __isChunkLoadedForTests,
  __resetChunksForTests,
  __setChunkLoadForTests
} from '../../../src/chunks/loader';
import { PrettierEngine } from '../../../src/engine/prettier';
import { resolved } from '../../helpers/options';

// The eager baseline: exactly what the pre-split engine returned for this input
// with the project defaults (tabSize 2, spaces). Hard-coded on purpose so a
// silent behaviour change in the chunk boundary cannot be absorbed by
// recomputing the expectation from the same code path under test.
const TS_INPUT = 'const  a = {b:1,c:2}';
const TS_EXPECTED = 'const a = { b: 1, c: 2 };\n';

describe('engine/prettierLazy : lazy output equals the eager baseline (ADD-11)', () => {
  beforeEach(() => {
    __resetChunksForTests();
  });
  after(() => {
    __resetChunksForTests();
  });

  it('format output through the lazy chunk is byte-identical to the eager baseline', async () => {
    const engine = new PrettierEngine();
    assert.equal(__isChunkLoadedForTests('chunk-prettier'), false);

    const first = await engine.format({
      languageId: 'typescript',
      code: TS_INPUT,
      options: resolved()
    });
    assert.equal(first, TS_EXPECTED);
    assert.equal(__isChunkLoadedForTests('chunk-prettier'), true);

    // Second call reads the memo; the output must not drift.
    const second = await engine.format({
      languageId: 'typescript',
      code: TS_INPUT,
      options: resolved()
    });
    assert.equal(second, TS_EXPECTED);
  });

  it('the tsx path uses the same chunk and keeps JSX intact', async () => {
    const engine = new PrettierEngine();
    const out = await engine.format({
      languageId: 'typescriptreact',
      code: 'const v=<Foo bar={x} />;',
      options: resolved()
    });
    assert.ok(out.includes('<Foo bar={x} />'), `got: ${JSON.stringify(out)}`);
    assert.equal(__isChunkLoadedForTests('chunk-prettier'), true);
  });

  it('the CSS fallback path shares the same chunk and needs no other', async () => {
    const engine = new PrettierEngine();
    const out = await engine.format({
      languageId: 'scss',
      code: '.a{&:hover{color:red}}',
      options: resolved()
    });
    assert.ok(out.includes('&:hover'), `got: ${JSON.stringify(out)}`);
    assert.equal(__isChunkLoadedForTests('chunk-prettier'), true);
    // The postcss PRINTER travels with the prettier chunk; the guard's postcss
    // PARSERS are a different chunk and are not needed to print.
    assert.equal(__isChunkLoadedForTests('chunk-guard-css'), false);
  });
});

describe('engine/prettierLazy : a failed load leaves no partial state (ADD-11)', () => {
  beforeEach(() => {
    __resetChunksForTests();
  });
  after(() => {
    __resetChunksForTests();
  });

  it('retry after a transient failure succeeds with the same output', async () => {
    let firstAttempt = true;
    __setChunkLoadForTests('chunk-prettier', () => {
      if (firstAttempt) {
        firstAttempt = false;
        throw new Error('transient');
      }
      return require('../../../src/chunks/prettierChunk');
    });

    const engine = new PrettierEngine();
    await assert.rejects(
      engine.format({ languageId: 'typescript', code: TS_INPUT, options: resolved() }),
      /prettier engine unavailable: failed to load chunk-prettier/
    );
    assert.equal(__isChunkLoadedForTests('chunk-prettier'), false);

    const recovered = await engine.format({
      languageId: 'typescript',
      code: TS_INPUT,
      options: resolved()
    });
    assert.equal(recovered, TS_EXPECTED);
  });

  it('a load failure is reported as an engine error, never as formatted output', async () => {
    __setChunkLoadForTests('chunk-prettier', () => {
      throw new Error('unavailable');
    });
    const engine = new PrettierEngine();
    await assert.rejects(
      engine.format({ languageId: 'typescript', code: TS_INPUT, options: resolved() }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        // The message must name the boundary, not leak user code.
        assert.match(error.message, /^prettier engine unavailable: failed to load chunk-prettier/);
        assert.ok(!error.message.includes(TS_INPUT));
        return true;
      }
    );
  });
});
