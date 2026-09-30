// HIGH-07 / HIGH-11: a glob in a VERSIONED file must never be able to freeze the
// extension host. Both glob paths (.soukformatignore lines and .soukformatrc
// overrides[].files) used to translate the glob to a RegExp and test it
// synchronously: about x4 time per extra star, over 50 seconds for a 31-character
// pattern. They now share one LINEAR matcher, and these tests hold that.
//
// The adversarial patterns run in a CHILD process with a hard kill timeout: if a
// regression ever reintroduces exponential backtracking, the child is killed
// after HARD_TIMEOUT_MS and the tests FAIL with a clear message. They can never
// hang the suite, because the parent never evaluates a pattern itself.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const GLOB_MODULE = path.join(REPO_ROOT, 'src/ignore/glob.ts');
const RC_MODULE = path.join(REPO_ROOT, 'src/config/soukformatrc.ts');

/** The budget each adversarial evaluation must stay under. */
const BUDGET_MS = 50;

/** Hard kill for the whole child: 100 evaluations of 50 ms would be 5 s. */
const HARD_TIMEOUT_MS = 20_000;

interface Sample {
  readonly name: string;
  readonly ms: number;
  readonly result: unknown;
}

/**
 * The child program. It evaluates every case once to warm up, then keeps the
 * BEST of three timed runs, so a scheduling hiccup on a loaded machine cannot
 * fake a regression while a real one (seconds, or never returning) still shows.
 * Module paths arrive as JSON so Windows backslashes need no escaping.
 */
function childProgram(globModule: string, rcModule: string): string {
  return `
    const { compileIgnorePattern, patternMatches } = require(${JSON.stringify(globModule)});
    const { parseSoukformatrc } = require(${JSON.stringify(rcModule)});

    const starSubject = 'a'.repeat(40) + 'b';
    const deepSubject = Array.from({ length: 30 }, (_, i) => 's' + i).join('/');
    const aaaaSubject = Array.from({ length: 40 }, () => 'aaaa').join('/') + '/b';

    const ignoreRun = (pattern, subject) => () => {
      const compiled = compileIgnorePattern(pattern);
      return patternMatches(compiled, subject);
    };
    const rcRun = (pattern, subject) => () => {
      const text = JSON.stringify({ overrides: [{ files: pattern, options: { indent: 8 } }] });
      return parseSoukformatrc(text, 'css', '/p/.soukformatrc', subject).layers.length;
    };

    const stars16 = '*a'.repeat(16);
    const stars200 = '*a'.repeat(200);
    const globstars10 = '**/'.repeat(10) + 'x';
    const globstars200 = '**/'.repeat(200) + 'x';
    const mixed = '**/*a*a*a/'.repeat(30) + 'x';

    const cases = [
      ['ignore star x16', ignoreRun(stars16, starSubject)],
      ['ignore star x200', ignoreRun(stars200, starSubject)],
      ['ignore globstar x10 (no match)', ignoreRun(globstars10, deepSubject)],
      ['ignore globstar x10 (match)', ignoreRun(globstars10, deepSubject + '/x')],
      ['ignore globstar x200', ignoreRun(globstars200, deepSubject)],
      ['ignore mixed', ignoreRun(mixed, aaaaSubject)],
      ['rc star x16', rcRun(stars16, starSubject)],
      ['rc star x200', rcRun(stars200, starSubject)],
      ['rc globstar x10 (no match)', rcRun(globstars10, deepSubject)],
      ['rc globstar x10 (match)', rcRun(globstars10, deepSubject + '/x')],
      ['rc globstar x200', rcRun(globstars200, deepSubject)],
      ['rc mixed', rcRun(mixed, aaaaSubject)]
    ];

    const samples = cases.map(([name, run]) => {
      run();
      let best = Infinity;
      let result;
      for (let i = 0; i < 3; i += 1) {
        const start = performance.now();
        result = run();
        best = Math.min(best, performance.now() - start);
      }
      return { name, ms: best, result };
    });
    process.stdout.write(JSON.stringify(samples));
  `;
}

/** Run the adversarial cases in a child that is killed if it does not return. */
function runAdversarialCases(): Sample[] {
  const out = execFileSync(
    process.execPath,
    ['--require', 'tsx', '-e', childProgram(GLOB_MODULE, RC_MODULE)],
    { cwd: REPO_ROOT, encoding: 'utf8', timeout: HARD_TIMEOUT_MS, killSignal: 'SIGKILL' }
  );
  return JSON.parse(out) as Sample[];
}

describe('ignore/glob : adversarial patterns complete in linear time on BOTH paths', function () {
  let samples: Map<string, Sample>;

  before(function () {
    this.timeout(HARD_TIMEOUT_MS + 10_000);
    try {
      samples = new Map(runAdversarialCases().map((sample) => [sample.name, sample]));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      assert.fail(
        `the adversarial glob cases did not finish within ${HARD_TIMEOUT_MS} ms ` +
          `(exponential backtracking is back, or the child failed): ${reason}`
      );
    }
  });

  function sample(name: string): Sample {
    const found = samples.get(name);
    assert.ok(found, `no sample named "${name}"`);
    return found as Sample;
  }

  function assertFast(name: string, expected: unknown): void {
    const { ms, result } = sample(name);
    assert.ok(ms < BUDGET_MS, `"${name}" took ${ms.toFixed(2)} ms (budget ${BUDGET_MS} ms)`);
    assert.equal(result, expected, `"${name}" gave the wrong answer`);
  }

  describe('.soukformatignore (compileIgnorePattern + patternMatches)', () => {
    it('"*a" x 16 against 40 "a" then "b" (was about 80 hours)', () => {
      assertFast('ignore star x16', false);
    });
    it('"*a" x 200 (a 400-character pattern)', () => {
      assertFast('ignore star x200', false);
    });
    it('"**/" x 10 + "x" against 30 segments, no match (was over 50 s)', () => {
      assertFast('ignore globstar x10 (no match)', false);
    });
    it('"**/" x 10 + "x" against 30 segments, and the file exists (still a match)', () => {
      assertFast('ignore globstar x10 (match)', true);
    });
    it('"**/" x 200', () => {
      assertFast('ignore globstar x200', false);
    });
    it('a mixed globstar and star pattern against a deep path', () => {
      assertFast('ignore mixed', false);
    });
  });

  describe('.soukformatrc overrides[].files (parseSoukformatrc)', () => {
    it('"*a" x 16 against 40 "a" then "b"', () => {
      assertFast('rc star x16', 0);
    });
    it('"*a" x 200', () => {
      assertFast('rc star x200', 0);
    });
    it('"**/" x 10 + "x" against 30 segments, no match', () => {
      assertFast('rc globstar x10 (no match)', 0);
    });
    it('"**/" x 10 + "x" against 30 segments, and the file exists (the override applies)', () => {
      assertFast('rc globstar x10 (match)', 1);
    });
    it('"**/" x 200', () => {
      assertFast('rc globstar x200', 0);
    });
    it('a mixed globstar and star pattern against a deep path', () => {
      assertFast('rc mixed', 0);
    });
  });
});

// One implementation, not two: the regression came from two hand-written
// glob-to-RegExp translators. Reading the sources keeps a second translator, or
// a RegExp evaluation of a user glob, from coming back unnoticed.
describe('ignore/glob : one shared linear implementation, no RegExp translation', () => {
  const globSource = readFileSync(GLOB_MODULE, 'utf8');
  const rcSource = readFileSync(RC_MODULE, 'utf8');

  it('neither module builds a RegExp', () => {
    assert.doesNotMatch(globSource, /new RegExp\(|RegExp\(/);
    assert.doesNotMatch(rcSource, /new RegExp\(|RegExp\(/);
  });

  it('the old translators are gone', () => {
    assert.doesNotMatch(rcSource, /function globToRegExp|function globMatches/);
    assert.doesNotMatch(globSource, /globBodyToRegExpSource/);
  });

  it('soukformatrc.ts matches its overrides through the shared module', () => {
    assert.match(rcSource, /from '\.\.\/ignore\/glob'/);
    assert.match(rcSource, /compileFilesGlob\(/);
    assert.match(rcSource, /patternMatches\(/);
  });
});
