// Lazy chunk loader (ADD-11): memoization, shape validation, failure
// propagation, retry after a failure, and the LANGUAGE-AWARE idle preload.
//
// Every suite that touches a test seam resets the loader in beforeEach AND in
// after, so a swapped loader can never leak into another file's expectations.
import assert from 'node:assert/strict';
import {
  CHUNK_PRELOAD_ORDER,
  ChunkLoadError,
  __isChunkLoadedForTests,
  __resetChunksForTests,
  __setChunkLoadForTests,
  chunksForLanguages,
  isChunkLoadError,
  loadPrettierChunk,
  preloadChunks,
  requireGuardCssChunk,
  requireGuardHtmlChunk,
  requireGuardJsChunk,
  requirePrettierChunk,
  scheduleChunkPreload,
  type ChunkName,
  type PreloadReport
} from '../../../src/chunks/loader';

const ALL_CHUNKS = [
  'chunk-guard-css',
  'chunk-guard-html',
  'chunk-guard-js',
  'chunk-prettier'
] as const;

/**
 * A minimal tree carrying the source it was built from, so a stubbed parser
 * DISCRIMINATES two different inputs exactly as a real one does. Callable but
 * degenerate parsers are the thing the loader's behavioural canary rejects, so
 * a stub that wants to load must actually behave.
 */
function fakeTree(kind: string, source: string): Record<string, unknown> {
  return { type: kind, children: [{ type: `${kind}-node`, source }] };
}

/** A tiny real walk, so a stubbed traverseFast visits more than nothing. */
function fakeTraverse(node: unknown, enter: (node: unknown) => void): void {
  const visit = (candidate: unknown): void => {
    if (candidate === null || typeof candidate !== 'object') {
      return;
    }
    enter(candidate);
    for (const value of Object.values(candidate as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        value.forEach(visit);
      } else if (value !== null && typeof value === 'object') {
        visit(value);
      }
    }
  };
  visit(node);
}

/**
 * A module with exactly the exports the loader validates, and nothing heavy.
 * Used wherever a test needs a chunk to "load" without paying for the real
 * parser: an INVALID stub would now be rejected by the loader itself, which is
 * the point of the shape check AND of the behavioural canary. The verifier
 * stubs therefore parse in the only sense the canary cares about: they return a
 * real tree that carries their input and differs for a different input.
 */
function validStub(name: ChunkName): Record<string, unknown> {
  const noop = (): undefined => undefined;
  switch (name) {
    case 'chunk-prettier':
      return {
        format: noop,
        pluginBabel: {},
        pluginEstree: {},
        pluginTypescript: {},
        pluginPostcss: {}
      };
    case 'chunk-guard-js':
      return {
        parse: (code: string) => ({
          type: 'File',
          program: fakeTree('Program', code)
        }),
        traverseFast: fakeTraverse
      };
    case 'chunk-guard-css':
      return {
        parseCss: (css: string) => fakeTree('root', css),
        parseScss: (css: string) => fakeTree('root', css),
        parseLess: (css: string) => fakeTree('root', css)
      };
    case 'chunk-guard-html':
      return {
        parseHtml: (html: string) => fakeTree('#document', html),
        parseHtmlFragment: (html: string) => fakeTree('#document-fragment', html)
      };
    default:
      throw new Error(`unknown chunk ${String(name)}`);
  }
}

function stubEveryChunk(record?: ChunkName[]): void {
  for (const name of CHUNK_PRELOAD_ORDER) {
    __setChunkLoadForTests(name, () => {
      record?.push(name);
      return validStub(name);
    });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe('chunks/loader : memoization', () => {
  beforeEach(() => {
    __resetChunksForTests();
  });
  after(() => {
    __resetChunksForTests();
  });

  it('memoizes: two sync requires return the same module instance', () => {
    const first = requireGuardCssChunk();
    const second = requireGuardCssChunk();
    assert.equal(first, second, 'the second call must return the memoized module');
    assert.equal(typeof first.parseCss, 'function');
    assert.equal(typeof first.parseScss, 'function');
    assert.equal(typeof first.parseLess, 'function');
  });

  it('sync and async facades share one instance', async () => {
    const viaPromise = await loadPrettierChunk();
    assert.equal(viaPromise, requirePrettierChunk());
    assert.equal(typeof viaPromise.format, 'function');
  });

  it('exposes the exact verifier entry points each guard family needs', () => {
    assert.equal(typeof requireGuardJsChunk().parse, 'function');
    assert.equal(typeof requireGuardJsChunk().traverseFast, 'function');
    assert.equal(typeof requireGuardHtmlChunk().parseHtml, 'function');
    assert.equal(typeof requireGuardHtmlChunk().parseHtmlFragment, 'function');
  });
});

describe('chunks/loader : failure semantics', () => {
  beforeEach(() => {
    __resetChunksForTests();
  });
  after(() => {
    __resetChunksForTests();
  });

  it('a load failure propagates with the chunk name', () => {
    __setChunkLoadForTests('chunk-guard-html', () => {
      throw new Error('boom');
    });
    assert.throws(
      () => requireGuardHtmlChunk(),
      /failed to load chunk-guard-html: boom/
    );
  });

  it('a load failure is a typed, recognisable ChunkLoadError', () => {
    // guard.ts keys the whole "a verifier that could not load is NOT a statement
    // about the user's file" rule on this classification, so it is part of the
    // loader's contract, not an implementation detail.
    __setChunkLoadForTests('chunk-guard-css', () => {
      throw new Error('boom');
    });
    let captured: unknown;
    try {
      requireGuardCssChunk();
    } catch (error: unknown) {
      captured = error;
    }
    assert.ok(captured instanceof ChunkLoadError);
    assert.ok(isChunkLoadError(captured));
    assert.equal((captured as ChunkLoadError).chunk, 'chunk-guard-css');
  });

  it('isChunkLoadError says no to an ordinary parse error', () => {
    assert.equal(isChunkLoadError(new Error('Unexpected token (1:3)')), false);
    assert.equal(isChunkLoadError(undefined), false);
    assert.equal(isChunkLoadError(null), false);
    assert.equal(isChunkLoadError('failed to load chunk-guard-css'), false);
  });

  it('a non-Error throw is still reported with the chunk name', () => {
    __setChunkLoadForTests('chunk-guard-css', () => {
      throw 'ENOENT';
    });
    assert.throws(
      () => requireGuardCssChunk(),
      /failed to load chunk-guard-css: ENOENT/
    );
  });

  it('a load failure is NOT memoized: the next attempt retries', () => {
    let firstAttempt = true;
    __setChunkLoadForTests('chunk-guard-html', () => {
      if (firstAttempt) {
        firstAttempt = false;
        throw new Error('transient');
      }
      // A transient failure (EMFILE, an antivirus holding the file) must not
      // wedge the extension until the window is reloaded.
      return require('../../../src/chunks/guardHtmlChunk');
    });

    assert.throws(() => requireGuardHtmlChunk(), /failed to load chunk-guard-html/);
    assert.equal(__isChunkLoadedForTests('chunk-guard-html'), false);

    const recovered = requireGuardHtmlChunk();
    assert.equal(typeof recovered.parseHtml, 'function');
    assert.equal(__isChunkLoadedForTests('chunk-guard-html'), true);
  });

  it('the async facade rejects with the same chunk-scoped message', async () => {
    __setChunkLoadForTests('chunk-prettier', () => {
      throw new Error('nope');
    });
    await assert.rejects(loadPrettierChunk(), /failed to load chunk-prettier: nope/);
  });
});

// A require() that RESOLVES is not proof the chunk is intact: a truncated or
// half-written dist/chunk-*.js evaluates to an empty or partial module. Caching
// that would poison the session and turn every later format into a mislabeled
// failure, so the shape is proven before anything is memoized or handed out.
describe('chunks/loader : a chunk with the wrong shape is a LOAD FAILURE', () => {
  beforeEach(() => {
    __resetChunksForTests();
  });
  after(() => {
    __resetChunksForTests();
  });

  it('an empty module is rejected and never memoized', () => {
    let calls = 0;
    __setChunkLoadForTests('chunk-guard-css', () => {
      calls += 1;
      return {};
    });

    assert.throws(
      () => requireGuardCssChunk(),
      /failed to load chunk-guard-css: incomplete chunk, missing or unusable export\(s\): parseCss, parseScss, parseLess/
    );
    assert.equal(__isChunkLoadedForTests('chunk-guard-css'), false);

    // Not memoized: the second attempt really re-runs the loader.
    assert.throws(() => requireGuardCssChunk());
    assert.equal(calls, 2);
  });

  it('a truncated module names the exports it is missing', () => {
    __setChunkLoadForTests('chunk-guard-css', () => ({
      parseCss: () => undefined,
      parseScss: () => undefined
    }));
    assert.throws(
      () => requireGuardCssChunk(),
      /missing or unusable export\(s\): parseLess/
    );
  });

  it('an export of the wrong kind is rejected too', () => {
    __setChunkLoadForTests('chunk-guard-html', () => ({
      parseHtml: 'not a function',
      parseHtmlFragment: () => undefined
    }));
    assert.throws(
      () => requireGuardHtmlChunk(),
      /failed to load chunk-guard-html: incomplete chunk, missing or unusable export\(s\): parseHtml/
    );
    assert.equal(__isChunkLoadedForTests('chunk-guard-html'), false);
  });

  it('a non-module value is rejected with what it actually was', () => {
    __setChunkLoadForTests('chunk-guard-js', () => undefined);
    assert.throws(
      () => requireGuardJsChunk(),
      /failed to load chunk-guard-js: expected a module object, got undefined/
    );

    __setChunkLoadForTests('chunk-guard-js', () => null);
    assert.throws(
      () => requireGuardJsChunk(),
      /failed to load chunk-guard-js: expected a module object, got null/
    );
  });

  it('an invalid shape is a ChunkLoadError, so the guard classifies it as a load failure', () => {
    __setChunkLoadForTests('chunk-guard-html', () => ({}));
    let captured: unknown;
    try {
      requireGuardHtmlChunk();
    } catch (error: unknown) {
      captured = error;
    }
    assert.ok(isChunkLoadError(captured));
    assert.equal((captured as ChunkLoadError).chunk, 'chunk-guard-html');
  });

  it('the prettier chunk must carry its printer AND all four plugins', () => {
    __setChunkLoadForTests('chunk-prettier', () => ({
      format: () => undefined,
      pluginBabel: {},
      pluginEstree: {}
    }));
    assert.throws(
      () => requirePrettierChunk(),
      /missing or unusable export\(s\): pluginTypescript, pluginPostcss/
    );
  });

  it('the real chunks all pass their own shape check', () => {
    __resetChunksForTests();
    for (const name of CHUNK_PRELOAD_ORDER) {
      assert.doesNotThrow(() => {
        switch (name) {
          case 'chunk-prettier':
            requirePrettierChunk();
            break;
          case 'chunk-guard-js':
            requireGuardJsChunk();
            break;
          case 'chunk-guard-css':
            requireGuardCssChunk();
            break;
          case 'chunk-guard-html':
            requireGuardHtmlChunk();
            break;
        }
      }, `${name} must satisfy the shape the loader validates`);
    }
  });
});

// A chunk that EXPORTS callable parsers still has to PARSE. The moat auditor's
// attack was precisely this: swap dist/chunk-guard-html.js for a module whose
// parseHtml/parseHtmlFragment are callable but degenerate, and the shape check
// (a typeof test) waves it through; guard.check then compares nothing and
// answers `equivalent: true` for two completely different documents, i.e. the
// guard silently stops being a guard. Substituting a chunk needs write access
// to dist/, which already means a compromised install, so this is defence in
// depth: but the verifier's soundness must not rest on `typeof x === 'function'`.
describe('chunks/loader : a chunk whose parsers do not parse is a LOAD FAILURE', () => {
  beforeEach(() => {
    __resetChunksForTests();
  });
  after(() => {
    __resetChunksForTests();
  });

  it('THE attack: degenerate html parsers never reach the guard, and are not cached', () => {
    let calls = 0;
    __setChunkLoadForTests('chunk-guard-html', () => {
      calls += 1;
      return {
        // Callable. Typed correctly. Utterly degenerate: every document parses
        // to the same nothing, so any comparison built on it is vacuous.
        parseHtml: () => undefined,
        parseHtmlFragment: () => undefined
      };
    });

    assert.throws(
      () => requireGuardHtmlChunk(),
      (error: unknown) =>
        isChunkLoadError(error) &&
        /did not return a parse tree/.test(String((error as Error).message))
    );
    assert.equal(
      __isChunkLoadedForTests('chunk-guard-html'),
      false,
      'a chunk that failed its canary must never be memoized'
    );
    // Not memoized: the second attempt really re-runs the loader.
    assert.throws(() => requireGuardHtmlChunk());
    assert.equal(calls, 2);
  });

  it('a parser that collapses every input to ONE tree is rejected', () => {
    const constant = { nodeName: '#document', childNodes: [] };
    __setChunkLoadForTests('chunk-guard-html', () => ({
      parseHtml: () => constant,
      parseHtmlFragment: () => constant
    }));
    assert.throws(
      () => requireGuardHtmlChunk(),
      /does not carry the input it parsed|same tree for two different inputs/
    );
  });

  it('a parser that answers a plausible but INPUT-FREE tree is rejected', () => {
    // Different objects each call (so identity differs) and even different
    // content per call, but nothing derived from the source: the tree cannot
    // carry what it was given, so it cannot witness equivalence either.
    let n = 0;
    __setChunkLoadForTests('chunk-guard-css', () => ({
      parseCss: () => ({ type: 'root', nodes: [{ type: 'rule', id: (n += 1) }] }),
      parseScss: () => ({ type: 'root', nodes: [] }),
      parseLess: () => ({ type: 'root', nodes: [] })
    }));
    assert.throws(
      () => requireGuardCssChunk(),
      /parseCss returned a tree that does not carry the input it parsed/
    );
  });

  it('every CSS dialect is canaried, not just the first one', () => {
    const real = require('../../../src/chunks/guardCssChunk');
    __setChunkLoadForTests('chunk-guard-css', () => ({
      parseCss: real.parseCss,
      parseScss: real.parseScss,
      // A single degenerate dialect is enough to make SCSS/LESS formatting
      // unverified, so it must fail the load like any other.
      parseLess: () => undefined
    }));
    assert.throws(() => requireGuardCssChunk(), /parseLess did not return a parse tree/);
  });

  it('a traverseFast that walks nothing is rejected', () => {
    const real = require('../../../src/chunks/guardJsChunk');
    __setChunkLoadForTests('chunk-guard-js', () => ({
      parse: real.parse,
      traverseFast: () => undefined
    }));
    assert.throws(
      () => requireGuardJsChunk(),
      /traverseFast visited 0 node\(s\)/
    );
  });

  it('a parser that THROWS on a trivial input is a load failure, not a pass', () => {
    __setChunkLoadForTests('chunk-guard-js', () => ({
      parse: () => {
        throw new Error('nope');
      },
      traverseFast: () => undefined
    }));
    assert.throws(
      () => requireGuardJsChunk(),
      (error: unknown) =>
        isChunkLoadError(error) &&
        /parse threw on a trivial statement \(nope\)/.test(
          String((error as Error).message)
        )
    );
  });

  it('a tree that explodes while it is inspected still fails CLOSED', () => {
    // The canary itself throwing must be a FAILED canary, never a pass: the
    // only way out without a problem is a canary that ran to completion.
    const hostile = (): unknown => {
      const tree: Record<string, unknown> = { type: 'root' };
      Object.defineProperty(tree, 'nodes', {
        enumerable: true,
        get: () => {
          throw new Error('boom');
        }
      });
      return tree;
    };
    __setChunkLoadForTests('chunk-guard-css', () => ({
      parseCss: hostile,
      parseScss: hostile,
      parseLess: hostile
    }));
    assert.throws(
      () => requireGuardCssChunk(),
      (error: unknown) =>
        isChunkLoadError(error) &&
        /behavioural canary threw \(boom\)/.test(String((error as Error).message))
    );
    assert.equal(__isChunkLoadedForTests('chunk-guard-css'), false);
  });

  it('the prettier chunk is deliberately NOT canaried (it prints, it does not verify)', () => {
    // A degenerate printer produces output the guard then refuses, so its
    // failure mode is "Tidy does nothing", never "Tidy accepts a corrupted
    // file". Paying a real Prettier format at load time would cost
    // milliseconds for no safety gain.
    __setChunkLoadForTests('chunk-prettier', () => ({
      format: () => undefined,
      pluginBabel: {},
      pluginEstree: {},
      pluginTypescript: {},
      pluginPostcss: {}
    }));
    assert.doesNotThrow(() => requirePrettierChunk());
  });

  it('the REAL verifier chunks all pass their own canary', () => {
    __resetChunksForTests();
    assert.doesNotThrow(() => requireGuardJsChunk());
    assert.doesNotThrow(() => requireGuardCssChunk());
    assert.doesNotThrow(() => requireGuardHtmlChunk());
  });

  // "Genuinely cheap, once per chunk per session" is a claim, so it is measured.
  // The require() itself is already in Node's module cache here, so what this
  // times is the shape check plus the canary: two ~20 character parses per
  // parser entry point, on the load that was going to happen anyway.
  it('the canary costs microseconds, not milliseconds', () => {
    const requireByName: Record<string, () => unknown> = {
      'chunk-guard-js': requireGuardJsChunk,
      'chunk-guard-css': requireGuardCssChunk,
      'chunk-guard-html': requireGuardHtmlChunk
    };
    for (const [name, load] of Object.entries(requireByName)) {
      __resetChunksForTests();
      load(); // warm the module cache and the parsers' own lazy init.

      const rounds = 200;
      const started = process.hrtime.bigint();
      for (let i = 0; i < rounds; i += 1) {
        __resetChunksForTests();
        load();
      }
      const perLoadMs =
        Number(process.hrtime.bigint() - started) / 1e6 / rounds;
      assert.ok(
        perLoadMs < 2,
        `${name}: validated load must stay far below a millisecond, measured ${perLoadMs.toFixed(
          3
        )} ms`
      );
    }
  });
});

describe('chunks/loader : preloadChunks', () => {
  beforeEach(() => {
    __resetChunksForTests();
  });
  after(() => {
    __resetChunksForTests();
  });

  it('loads the requested chunks and never rejects', async () => {
    const report = await preloadChunks(CHUNK_PRELOAD_ORDER);
    assert.deepEqual(report.failed, []);
    assert.deepEqual([...report.loaded].sort(), [...ALL_CHUNKS]);
    for (const name of ALL_CHUNKS) {
      assert.equal(__isChunkLoadedForTests(name), true, `${name} must be loaded`);
    }
    assert.ok(report.elapsedMs >= 0);
  });

  it('an empty list loads nothing at all', async () => {
    const report = await preloadChunks([]);
    assert.deepEqual(report.loaded, []);
    assert.deepEqual(report.failed, []);
    for (const name of ALL_CHUNKS) {
      assert.equal(__isChunkLoadedForTests(name), false, `${name} must stay cold`);
    }
  });

  it('reports a failing chunk and still loads the others', async () => {
    __setChunkLoadForTests('chunk-guard-css', () => {
      throw new Error('disk gone');
    });

    const report = await preloadChunks(CHUNK_PRELOAD_ORDER);

    assert.equal(report.failed.length, 1);
    assert.equal(report.failed[0].chunk, 'chunk-guard-css');
    assert.match(report.failed[0].message, /failed to load chunk-guard-css/);
    assert.deepEqual(
      [...report.loaded].sort(),
      ['chunk-guard-html', 'chunk-guard-js', 'chunk-prettier']
    );
    assert.equal(__isChunkLoadedForTests('chunk-guard-css'), false);
  });

  it('an invalid shape is reported as a preload failure, never a silent cache', async () => {
    __setChunkLoadForTests('chunk-guard-html', () => ({}));
    const report = await preloadChunks(CHUNK_PRELOAD_ORDER);
    assert.equal(report.failed.length, 1);
    assert.equal(report.failed[0].chunk, 'chunk-guard-html');
    assert.match(report.failed[0].message, /incomplete chunk/);
    assert.equal(__isChunkLoadedForTests('chunk-guard-html'), false);
  });

  it('a chunk that failed during preload still lazy-loads later', async () => {
    __setChunkLoadForTests('chunk-guard-css', () => {
      throw new Error('disk gone');
    });
    const report = await preloadChunks(CHUNK_PRELOAD_ORDER);
    assert.equal(report.failed.length, 1);

    // Restore the production loader: the failure was never memoized, so the
    // first real use loads the chunk normally.
    __setChunkLoadForTests('chunk-guard-css', undefined);
    const chunk = requireGuardCssChunk();
    assert.equal(typeof chunk.parseCss, 'function');
    assert.equal(__isChunkLoadedForTests('chunk-guard-css'), true);
  });

  it('preloads in the frozen order: biggest first-use win first', async () => {
    const order: ChunkName[] = [];
    stubEveryChunk(order);
    await preloadChunks(CHUNK_PRELOAD_ORDER);
    assert.deepEqual(order, [
      'chunk-prettier',
      'chunk-guard-js',
      'chunk-guard-css',
      'chunk-guard-html'
    ]);
  });
});

// The honesty contract behind the README's "opening a stylesheet never evaluates
// the TypeScript printer": the preload may only warm what the languages ON
// SCREEN can actually reach. Warming everything would undo the lazy split five
// seconds after activation, for every user.
describe('chunks/loader : chunksForLanguages picks only what a language needs', () => {
  it('a CSS-family editor set needs the postcss verifier and nothing else', () => {
    assert.deepEqual(chunksForLanguages(['css']), ['chunk-guard-css']);
    assert.deepEqual(chunksForLanguages(['scss']), ['chunk-guard-css']);
    assert.deepEqual(chunksForLanguages(['less']), ['chunk-guard-css']);
    assert.deepEqual(chunksForLanguages(['css', 'scss', 'less']), [
      'chunk-guard-css'
    ]);
  });

  it('a CSS-only editor set never asks for the prettier chunk', () => {
    // chunk-prettier carries the TypeScript printer; this single assertion is
    // what makes the README sentence literally true.
    assert.ok(!chunksForLanguages(['css', 'scss', 'less']).includes('chunk-prettier'));
  });

  it('html needs parse5 only: an embedded script/style loads on first use', () => {
    assert.deepEqual(chunksForLanguages(['html']), ['chunk-guard-html']);
  });

  it('the JSON family needs no chunk at all', () => {
    assert.deepEqual(chunksForLanguages(['json']), []);
    assert.deepEqual(chunksForLanguages(['jsonc']), []);
    assert.deepEqual(chunksForLanguages(['json', 'jsonc']), []);
  });

  it('plain javascript needs the babel verifier, not the prettier printer', () => {
    // Prettier is reached only when the file really contains JSX, which is
    // content dependent and stays a first-use load.
    assert.deepEqual(chunksForLanguages(['javascript']), ['chunk-guard-js']);
  });

  it('the TS/JSX family needs the printer and the babel verifier', () => {
    for (const lang of ['typescript', 'typescriptreact', 'javascriptreact']) {
      assert.deepEqual(
        chunksForLanguages([lang]),
        ['chunk-prettier', 'chunk-guard-js'],
        lang
      );
    }
  });

  it('deduplicates and always answers in preload order', () => {
    assert.deepEqual(
      chunksForLanguages(['html', 'typescript', 'css', 'typescript', 'html']),
      ['chunk-prettier', 'chunk-guard-js', 'chunk-guard-css', 'chunk-guard-html']
    );
  });

  it('ignores languages Tidy does not handle, and prototype keys', () => {
    assert.deepEqual(chunksForLanguages(['markdown', 'plaintext', 'rust']), []);
    assert.deepEqual(chunksForLanguages(['constructor', '__proto__', 'toString']), []);
    assert.deepEqual(chunksForLanguages(['markdown', 'css']), ['chunk-guard-css']);
  });

  it('an empty editor set asks for nothing', () => {
    assert.deepEqual(chunksForLanguages([]), []);
  });

  it('does not mutate the caller\'s array', () => {
    const languages = ['css', 'typescript'];
    chunksForLanguages(languages);
    assert.deepEqual(languages, ['css', 'typescript']);
  });
});

describe('chunks/loader : the idle preload is one-shot and language-aware', () => {
  beforeEach(() => {
    __resetChunksForTests();
  });
  after(() => {
    __resetChunksForTests();
  });

  it('a CSS-only editor set warms ONLY the CSS chunk', async () => {
    const loadedOrder: ChunkName[] = [];
    stubEveryChunk(loadedOrder);
    const reports: PreloadReport[] = [];

    const schedule = scheduleChunkPreload(1, () => ['css', 'scss'], (report) => {
      reports.push(report);
    });
    await delay(80);
    schedule.dispose();

    assert.equal(reports.length, 1);
    assert.deepEqual(reports[0].loaded, ['chunk-guard-css']);
    assert.deepEqual(reports[0].failed, []);
    assert.deepEqual(loadedOrder, ['chunk-guard-css']);
    assert.equal(
      __isChunkLoadedForTests('chunk-prettier'),
      false,
      'a stylesheet session must never evaluate the TypeScript printer'
    );
    assert.equal(__isChunkLoadedForTests('chunk-guard-js'), false);
    assert.equal(__isChunkLoadedForTests('chunk-guard-html'), false);
  });

  it('a TypeScript editor set warms the prettier chunk', async () => {
    const loadedOrder: ChunkName[] = [];
    stubEveryChunk(loadedOrder);
    const reports: PreloadReport[] = [];

    const schedule = scheduleChunkPreload(1, () => ['typescriptreact'], (report) => {
      reports.push(report);
    });
    await delay(80);
    schedule.dispose();

    assert.equal(reports.length, 1);
    assert.deepEqual(reports[0].loaded, ['chunk-prettier', 'chunk-guard-js']);
    assert.equal(__isChunkLoadedForTests('chunk-prettier'), true);
    assert.equal(__isChunkLoadedForTests('chunk-guard-css'), false);
    assert.equal(__isChunkLoadedForTests('chunk-guard-html'), false);
  });

  it('an empty editor set warms nothing', async () => {
    const loadedOrder: ChunkName[] = [];
    stubEveryChunk(loadedOrder);
    const reports: PreloadReport[] = [];

    const schedule = scheduleChunkPreload(1, () => [], (report) => {
      reports.push(report);
    });
    await delay(80);
    schedule.dispose();

    assert.equal(reports.length, 1);
    assert.deepEqual(reports[0].loaded, []);
    assert.deepEqual(reports[0].failed, []);
    assert.deepEqual(loadedOrder, []);
    for (const name of CHUNK_PRELOAD_ORDER) {
      assert.equal(__isChunkLoadedForTests(name), false, `${name} must stay cold`);
    }
  });

  it('reads the open languages exactly once, when the timer fires', async () => {
    stubEveryChunk();
    let reads = 0;

    const schedule = scheduleChunkPreload(
      1,
      () => {
        reads += 1;
        return ['css'];
      },
      () => undefined
    );
    assert.equal(reads, 0, 'nothing may be read before the timer fires');
    await delay(80);
    schedule.dispose();
    assert.equal(reads, 1, 'a single read: this is not a listener');
  });

  it('a failing language read degrades to preloading nothing', async () => {
    stubEveryChunk();
    const reports: PreloadReport[] = [];

    const schedule = scheduleChunkPreload(
      1,
      () => {
        throw new Error('host unavailable');
      },
      (report) => {
        reports.push(report);
      }
    );
    await delay(80);
    schedule.dispose();

    assert.equal(reports.length, 1);
    assert.deepEqual(reports[0].loaded, []);
    for (const name of CHUNK_PRELOAD_ORDER) {
      assert.equal(__isChunkLoadedForTests(name), false);
    }
  });

  it('disposing before the delay cancels it: nothing is read and nothing loads', async () => {
    stubEveryChunk();
    let reads = 0;
    const reports: PreloadReport[] = [];

    const schedule = scheduleChunkPreload(
      20,
      () => {
        reads += 1;
        return ['typescript'];
      },
      (report) => {
        reports.push(report);
      }
    );
    schedule.dispose();
    // Disposal is idempotent: deactivate after an explicit dispose must not throw.
    schedule.dispose();
    await delay(90);

    assert.equal(reads, 0);
    assert.deepEqual(reports, []);
    for (const name of CHUNK_PRELOAD_ORDER) {
      assert.equal(__isChunkLoadedForTests(name), false, `${name} must stay cold`);
    }
  });

  it('cannot fire twice, and disposing after it fired is a no-op', async () => {
    stubEveryChunk();
    let reads = 0;
    const reports: PreloadReport[] = [];

    const schedule = scheduleChunkPreload(
      1,
      () => {
        reads += 1;
        return ['css'];
      },
      (report) => {
        reports.push(report);
      }
    );
    await delay(80);
    assert.equal(reports.length, 1);

    // deactivate() disposes the subscription long after the timer elapsed.
    schedule.dispose();
    schedule.dispose();
    await delay(80);

    assert.equal(reads, 1, 'the language read must not happen a second time');
    assert.equal(reports.length, 1, 'the preload must not run a second time');
  });

  it('a chunk that fails to preload is reported, not thrown', async () => {
    stubEveryChunk();
    __setChunkLoadForTests('chunk-guard-css', () => {
      throw new Error('disk gone');
    });
    const reports: PreloadReport[] = [];

    const schedule = scheduleChunkPreload(1, () => ['css'], (report) => {
      reports.push(report);
    });
    await delay(80);
    schedule.dispose();

    assert.equal(reports.length, 1);
    assert.deepEqual(reports[0].loaded, []);
    assert.equal(reports[0].failed.length, 1);
    assert.match(reports[0].failed[0].message, /failed to load chunk-guard-css/);
  });
});
