// ADD-11 moat suite: the equivalence guard behaves IDENTICALLY when its
// verifiers are loaded lazily, and a verifier that cannot be loaded can never
// be mistaken for a verifier that passed.
//
// Two properties are asserted here, and they are the whole safety argument of
// the lazy split:
//
//   1. SAME VERDICTS. Loading a parser later does not change what it decides.
//      Replayed from a cold loader and again after a full preload.
//   2. FAIL-SHUT, NEVER FAIL-OPEN. When a chunk cannot load, guard.check THROWS
//      (the provider turns that into 'guard error: ...' -> 'engine-error'
//      abort, file byte-identical). It must never return equivalent:true, and
//      it must not return equivalent:false either: a verdict about the user's
//      file is a claim the verifier never earned the right to make. That holds
//      on the JS, CSS and HTML paths alike, embedded <style>/<script> included.
//      `assert.throws` is the strong form: no GuardVerdict is produced at all,
//      so no caller can read a passing verdict out of it.
import assert from 'node:assert/strict';
import {
  CHUNK_PRELOAD_ORDER,
  __resetChunksForTests,
  __setChunkLoadForTests,
  isChunkLoadError,
  preloadChunks
} from '../../../src/chunks/loader';
import { guard } from '../../../src/safety/guard';
import type { LangId } from '../../../src/types';

const ALL_CHUNKS = [
  'chunk-prettier',
  'chunk-guard-js',
  'chunk-guard-css',
  'chunk-guard-html'
] as const;

function breakEveryChunk(): void {
  for (const name of ALL_CHUNKS) {
    __setChunkLoadForTests(name, () => {
      throw new Error('unavailable');
    });
  }
}

interface VerdictCase {
  readonly lang: LangId;
  readonly input: string;
  readonly output: string;
  readonly equivalent: boolean;
  readonly note: string;
}

const VERDICT_CASES: readonly VerdictCase[] = [
  {
    lang: 'css',
    input: '.a{color:red}',
    output: '.a {\n  color: red;\n}',
    equivalent: true,
    note: 'css reindent'
  },
  {
    lang: 'scss',
    input: '.a{&:hover{color:red}}',
    output: '.a {\n  &:hover {\n    color: red;\n  }\n}',
    equivalent: true,
    note: 'scss nesting reindent'
  },
  {
    lang: 'less',
    input: '@c:red;.a{color:@c}',
    output: '@c: red;\n.a {\n  color: @c;\n}',
    equivalent: true,
    note: 'less variable reindent'
  },
  {
    lang: 'html',
    input: '<div><p>x</p></div>',
    output: '<div>\n  <p>x</p>\n</div>',
    equivalent: true,
    note: 'html reindent'
  },
  {
    lang: 'typescript',
    input: 'const a:number=1',
    output: 'const a: number = 1;',
    equivalent: true,
    note: 'typescript respacing'
  },
  {
    lang: 'json',
    input: '{"a":1}',
    output: '{\n  "a": 1\n}',
    equivalent: true,
    note: 'json reindent'
  },
  {
    lang: 'css',
    input: '.a{color:red}',
    output: '.a{color:blue}',
    equivalent: false,
    note: 'css value change is rejected'
  },
  {
    lang: 'typescript',
    input: 'const a = 1;',
    output: 'const a = 2;',
    equivalent: false,
    note: 'typescript value change is rejected'
  },
  {
    lang: 'html',
    input: '<p>a</p>',
    output: '<p>b</p>',
    equivalent: false,
    note: 'html text change is rejected'
  }
];

describe('safety/guardLazy : verdicts are unchanged by lazy loading (ADD-11)', () => {
  beforeEach(() => {
    __resetChunksForTests();
  });
  after(() => {
    __resetChunksForTests();
  });

  for (const testCase of VERDICT_CASES) {
    it(`cold loader, ${testCase.lang}: ${testCase.note}`, () => {
      __resetChunksForTests();
      const verdict = guard.check(testCase.lang, testCase.input, testCase.output);
      assert.equal(verdict.equivalent, testCase.equivalent);
    });
  }

  it('preloaded chunks change no verdict', async () => {
    await preloadChunks(CHUNK_PRELOAD_ORDER);
    for (const testCase of VERDICT_CASES) {
      const verdict = guard.check(testCase.lang, testCase.input, testCase.output);
      assert.equal(
        verdict.equivalent,
        testCase.equivalent,
        `${testCase.lang}: ${testCase.note}`
      );
    }
  });

  it('a corrupting output is still rejected after a cold load (JSX acceptance test)', () => {
    // The mandatory acceptance test from the guard header, replayed with an
    // empty loader: '< Foo bar = {x} />' re-parses as valid TSX, so only the
    // tag-boundary check catches it. Lazy loading must not weaken that.
    __resetChunksForTests();
    const verdict = guard.check('typescriptreact', '<Foo bar={x} />', '< Foo bar = {x} />');
    assert.equal(verdict.equivalent, false);
  });
});

describe('safety/guardLazy : a chunk that cannot load never yields a pass (ADD-11)', () => {
  beforeEach(() => {
    __resetChunksForTests();
  });
  after(() => {
    __resetChunksForTests();
  });

  it('css guard chunk load failure THROWS out of guard.check (never a silent accept)', () => {
    __setChunkLoadForTests('chunk-guard-css', () => {
      throw new Error('unavailable');
    });
    assert.throws(
      () => guard.check('css', '.a{}', '.b{}'),
      /failed to load chunk-guard-css/
    );
  });

  it('js guard chunk load failure throws for typescript', () => {
    __setChunkLoadForTests('chunk-guard-js', () => {
      throw new Error('unavailable');
    });
    assert.throws(
      () => guard.check('typescript', 'const a=1', 'const b=2'),
      /failed to load chunk-guard-js/
    );
  });

  it('html guard chunk load failure throws for html', () => {
    __setChunkLoadForTests('chunk-guard-html', () => {
      throw new Error('unavailable');
    });
    assert.throws(
      () => guard.check('html', '<p>a</p>', '<p>b</p>'),
      /failed to load chunk-guard-html/
    );
  });

  it('never returns equivalent:true for ANY family while every chunk is broken', () => {
    breakEveryChunk();
    const families: ReadonlyArray<[LangId, string, string]> = [
      ['css', '.a{color:red}', '.a { color: blue }'],
      ['scss', '.a{color:red}', '.a { color: blue }'],
      ['less', '.a{color:red}', '.a { color: blue }'],
      ['html', '<p>a</p>', '<p>b</p>'],
      ['javascript', 'const a=1', 'const a=2'],
      ['typescript', 'const a=1', 'const a=2'],
      ['typescriptreact', '<A/>', '<B/>'],
      ['javascriptreact', '<A/>', '<B/>']
    ];
    for (const [lang, input, output] of families) {
      let verdict: { equivalent: boolean } | undefined;
      try {
        verdict = guard.check(lang, input, output);
      } catch {
        // Throwing is the intended, strongest outcome: no verdict at all.
        continue;
      }
      assert.equal(
        verdict.equivalent,
        false,
        `${lang} returned a verdict without a verifier: ${JSON.stringify(verdict)}`
      );
    }
  });

  it('identical output short-circuits BEFORE any chunk load', () => {
    breakEveryChunk();
    // The fast path in guard.check compares strings only. It must keep working
    // with every chunk broken, and it must not be able to hide a failed load on
    // a REAL diff (the cases above prove that half).
    assert.deepEqual(guard.check('css', '.a{}', '.a{}'), { equivalent: true });
    assert.deepEqual(guard.check('html', '<p>a</p>', '<p>a</p>'), { equivalent: true });
    assert.deepEqual(guard.check('typescript', 'const a=1', 'const a=1'), {
      equivalent: true
    });
  });

  it('the json family needs no chunk at all', () => {
    breakEveryChunk();
    // jsonc-parser ships inside the host bundle: the most frequently formatted
    // family must never depend on a chunk being reachable.
    assert.equal(guard.check('json', '{"a":1}', '{\n  "a": 1\n}').equivalent, true);
    assert.equal(guard.check('jsonc', '{"a":1,}', '{\n  "a": 1,\n}').equivalent, true);
    assert.equal(guard.check('json', '{"a":1}', '{"a":2}').equivalent, false);
  });

  // The <style>/<script> bodies are canonicalized deep inside htmlTreeEqual's
  // buildShape, which is wrapped in a try/catch that maps parse errors to a
  // REJECTION. Until the classification fix, a chunk LOAD failure was swallowed
  // by that catch and surfaced as rejected('input did not parse: failed to load
  // chunk-guard-css'), i.e. as 'guard-rejected': the user was told THEIR file
  // could not be proven equivalent when the verifier had never run. That is a
  // false accusation about their code, so these two cases now assert a THROW,
  // exactly like the JS and CSS top-level paths. Both outcomes are equally
  // fail-safe (ZERO edits); only the honesty of the report differs.
  it('embedded <style> load failure THROWS out of the html guard (a load error, not a rejection)', () => {
    __setChunkLoadForTests('chunk-guard-css', () => {
      throw new Error('unavailable');
    });
    assert.throws(
      () =>
        guard.check(
          'html',
          '<style>.a{color:red}</style>',
          '<style>.a { color: red }</style>'
        ),
      (error: unknown) =>
        isChunkLoadError(error) &&
        /failed to load chunk-guard-css/.test(String((error as Error).message)) &&
        // The reason must never be dressed up as a verdict about the input.
        !/did not parse/.test(String((error as Error).message))
    );
  });

  it('embedded <script> load failure THROWS out of the html guard', () => {
    __setChunkLoadForTests('chunk-guard-js', () => {
      throw new Error('unavailable');
    });
    assert.throws(
      () =>
        guard.check(
          'html',
          '<script>const a=1</script>',
          '<script>\n  const a = 1;\n</script>'
        ),
      (error: unknown) =>
        isChunkLoadError(error) &&
        /failed to load chunk-guard-js/.test(String((error as Error).message)) &&
        !/did not parse/.test(String((error as Error).message))
    );
  });

  it('an html document with NO embedded code is unaffected by the css/js chunks', () => {
    // The classification fix must not widen what HTML depends on: a plain
    // document still needs parse5 alone.
    __setChunkLoadForTests('chunk-guard-css', () => {
      throw new Error('unavailable');
    });
    __setChunkLoadForTests('chunk-guard-js', () => {
      throw new Error('unavailable');
    });
    assert.equal(
      guard.check('html', '<div><p>x</p></div>', '<div>\n  <p>x</p>\n</div>')
        .equivalent,
      true
    );
  });

  it('a genuinely unparsable input is still a REJECTION, not a load error', () => {
    // The other half of the contract: the rethrow must not turn ordinary parse
    // failures into engine errors. Every chunk loads normally here.
    __resetChunksForTests();
    const verdict = guard.check('css', '.a{color:red', '.a { color: red; }');
    assert.equal(verdict.equivalent, false);
    assert.match(String(verdict.reason), /did not parse|CSS tree changed/);
    assert.doesNotMatch(String(verdict.reason), /failed to load/);
  });

  it('an html chunk with a TRUNCATED shape is a load error too, never a rejection', () => {
    // A require() that resolves to an incomplete module is a broken verifier,
    // not a broken document (see the loader's shape validation).
    __setChunkLoadForTests('chunk-guard-html', () => ({ parseHtml: () => undefined }));
    assert.throws(
      () => guard.check('html', '<p>a</p>', '<p>b</p>'),
      (error: unknown) =>
        isChunkLoadError(error) &&
        /incomplete chunk/.test(String((error as Error).message))
    );
  });

  it('a retried load after a transient failure produces the normal verdict', () => {
    let firstAttempt = true;
    __setChunkLoadForTests('chunk-guard-css', () => {
      if (firstAttempt) {
        firstAttempt = false;
        throw new Error('transient');
      }
      return require('../../../src/chunks/guardCssChunk');
    });

    assert.throws(() => guard.check('css', '.a{color:red}', '.a { color: red }'));
    assert.equal(
      guard.check('css', '.a{color:red}', '.a {\n  color: red;\n}').equivalent,
      true
    );
  });
});
