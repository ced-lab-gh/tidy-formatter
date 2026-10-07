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
const IGNORE_MODULE = path.join(REPO_ROOT, 'src/ignore/soukformatignore.ts');

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
 * BEST of seven timed runs, measured in CPU time, so a scheduling hiccup on a loaded machine cannot
 * fake a regression while a real one (seconds, or never returning) still shows.
 * Module paths arrive as JSON so Windows backslashes need no escaping.
 */
function childProgram(globModule: string, rcModule: string, ignoreModule: string): string {
  return `
    const { compileIgnorePattern, patternMatches } = require(${JSON.stringify(globModule)});
    const { parseSoukformatrc } = require(${JSON.stringify(rcModule)});
    const { evaluateIgnore } = require(${JSON.stringify(ignoreModule)});

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

    // P1, the audit's exact worst case: multiX(k) is "**/*" + k "a" + "c" repeated while
    // it fits in 1024 characters; 1000 of them, against a path of 16 directories of
    // 255 characters (4095 characters in all, the Linux PATH_MAX).
    const multiX = (k) => {
      const unit = '**/*' + 'a'.repeat(k) + 'c';
      let glob = '';
      while (glob.length + unit.length <= 1024) glob += unit;
      return glob;
    };
    const newline = String.fromCharCode(10);
    const deepPath = Array.from({ length: 16 }, () => 'a'.repeat(254) + 'c').join('/');
    const rcBig = (k) => {
      const text = JSON.stringify({
        css: { indent: 4 },
        overrides: Array.from({ length: 1000 }, () => ({ files: multiX(k), options: { indent: 8 } }))
      });
      return () => {
        const result = parseSoukformatrc(text, 'css', '/p/.soukformatrc', deepPath);
        return result.warnings.length === 1 && result.layers.length < 50;
      };
    };
    const ignoreBig = (k) => {
      const text = Array.from({ length: 1000 }, () => multiX(k)).join(newline);
      return () => {
        const verdict = evaluateIgnore(text, deepPath);
        return verdict.ignored === true && verdict.failClosed !== undefined;
      };
    };
    // Many SHORT overrides that each fail on their first character, against a very
    // long path (128 directories of 255 characters): they spend almost no matching
    // steps, so only the fixed per-override cost counts. Encoding the path once per
    // lookup (and charging the sweep) took this from over a second to a few dozen ms.
    const veryLongPath = Array.from({ length: 128 }, () => 'a'.repeat(254) + 'c').join('/');
    const manyShort = (() => {
      const text = JSON.stringify({
        overrides: Array.from({ length: 20000 }, (_, i) => ({ files: 'z' + i, options: { indent: 8 } }))
      });
      return () => parseSoukformatrc(text, 'css', '/p/.soukformatrc', veryLongPath).layers.length === 0;
    })();
    const benignText = Array.from({ length: 5000 }, (_, i) => 'module_' + i + '/dist/').join(newline);
    const benignIgnore = () => {
      const verdict = evaluateIgnore(benignText, 'packages/core/src/components/button/Button.tsx');
      return verdict.ignored === false && verdict.failClosed === undefined;
    };

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
      ['rc mixed', rcRun(mixed, aaaaSubject)],
      ['P1 rc 1000 x multiX(60), 4095-char path', rcBig(60)],
      ['P1 rc 1000 x multiX(30), 4095-char path', rcBig(30)],
      ['P1 rc 1000 x multiX(127), 4095-char path', rcBig(127)],
      ['P1 ignore 1000 x multiX(60), 4095-char path', ignoreBig(60)],
      ['P1 ignore 1000 x multiX(30), 4095-char path', ignoreBig(30)],
      ['P1 ignore 1000 x multiX(127), 4095-char path', ignoreBig(127)],
      ['P1 ignore 5000 ordinary lines is NOT cut off', benignIgnore],
      ['P1 rc 20000 short overrides, 32767-char path', manyShort]
    ];

    const samples = cases.map(([name, run]) => {
      run();
      let best = Infinity;
      let result;
      for (let i = 0; i < 7; i += 1) {
        // CPU time of the process (user + system), not wall time: other work on a
        // busy machine inflates the wall clock but not the CPU the code spends.
        const start = process.cpuUsage();
        result = run();
        const spent = process.cpuUsage(start);
        best = Math.min(best, (spent.user + spent.system) / 1000);
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
    ['--require', 'tsx', '-e', childProgram(GLOB_MODULE, RC_MODULE, IGNORE_MODULE)],
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

  function assertFast(name: string, expected: unknown, budgetMs = BUDGET_MS): void {
    const { ms, result } = sample(name);
    assert.ok(ms < budgetMs, `"${name}" took ${ms.toFixed(2)} ms of CPU (budget ${budgetMs} ms)`);
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

  // P1 (audit etape 10). Every pattern above is linear ALONE; what was missing was a
  // bound on the TOTAL. 1000 overrides (or ignore lines) of long globs against a deep
  // path, in a file under the 1 MiB cap, took 60.3 s for ONE parseSoukformatrc call
  // before the work budget. They must now finish in well under 50 ms and fail
  // closed (the ignore file excludes the path, the overrides are skipped and reported).
  describe('P1 the audit worst case: 1000 long globs against a 4095-character path', () => {
    for (const k of [60, 30, 127]) {
      it(`.soukformatrc, 1000 overrides of multiX(${k}): cut off with one warning`, () => {
        assertFast(`P1 rc 1000 x multiX(${k}), 4095-char path`, true);
      });
      it(`.soukformatignore, 1000 lines of multiX(${k}): excluded (fail closed), with the reason`, () => {
        assertFast(`P1 ignore 1000 x multiX(${k}), 4095-char path`, true);
      });
    }
    it('20 000 short overrides against a 32 KB path: the per-override cost is bounded too', () => {
      // A looser budget: 830 KB of JSONC has to be parsed, and the regression here was
      // over a second, not a few milliseconds.
      assertFast('P1 rc 20000 short overrides, 32767-char path', true, 250);
    });
    it('a large ORDINARY ignore file is not cut off: the budget is not too tight', () => {
      assertFast('P1 ignore 5000 ordinary lines is NOT cut off', true);
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
