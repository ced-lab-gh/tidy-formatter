// The glob matcher against REAL git (etape 10 of the v0.5.0 audit).
//
// The first round validated the matcher against a model written by the same hand,
// which reproduced the model's blind spots: character classes, negation under an
// excluded directory, a byte order mark, case, runs of three stars and leading
// blanks were all wrong while every test passed. The oracle is now git itself:
// `git check-ignore --no-index` in a throwaway repository (see
// test/helpers/gitIgnoreOracle.ts).
//
// Three tiers:
//   1. a CORPUS of cases whose git verdicts are frozen in
//      test/helpers/globGitCorpus.ts (so the suite protects the matcher even on a
//      machine with no git), replayed against Tidy;
//   2. the same corpus replayed against LIVE git, so a stale frozen row cannot
//      hide, and named tests with the exact inputs of each audit finding;
//   3. a DIFFERENTIAL run on generated ignore files and paths, through both Tidy
//      and git, under EACH value of core.ignorecase.
//
// CASE: Tidy does not follow the platform. A .soukformatignore line is matched in
// both case modes and merged on the safe side (see ./glob, evaluatePatterns), so
// the relation to git, for either core.ignorecase value, is:
//   - git excludes => Tidy excludes (zero tolerance: a file the user excluded must
//     never be formatted);
//   - no ASCII capital in the file or the path (see caseNeutral) => Tidy == git;
//   - otherwise Tidy may exclude MORE (safe): the cases are counted and printed.
//
// Size of the differential: TIDY_GIT_FUZZ_CASES (default 500 ignore files per run,
// 40 paths each, four runs). Raise it for a long soak, e.g. TIDY_GIT_FUZZ_CASES=6000.
import assert from 'node:assert/strict';
import { isIgnoredFile, parseIgnorePatterns } from '../../../src/ignore/soukformatignore';
import { GIT_CORPUS } from '../../helpers/globGitCorpus';
import { generateFuzzCases, type FuzzMode } from '../../helpers/globFuzz';
import { gitAvailable, gitCheckIgnore, gitVersion } from '../../helpers/gitIgnoreOracle';

const BOM = String.fromCharCode(0xfeff);

function tidyVerdicts(file: string, paths: readonly string[]): boolean[] {
  const patterns = parseIgnorePatterns(file);
  return paths.map((path) => isIgnoredFile(path, patterns));
}

/**
 * True when case cannot change git's answer: no ASCII capital in the ignore file or
 * the path, and no `[:upper:]` class (git widens it to lowercase under ignorecase).
 * There Tidy must equal git exactly; elsewhere it may exclude more.
 */
function caseNeutral(file: string, path: string): boolean {
  return !/[A-Z]/.test(file) && !/[A-Z]/.test(path) && !file.includes('[:upper:]');
}

/**
 * Compare Tidy with a git verdict recorded for one (file, path): git excludes =>
 * Tidy excludes; case neutral => equal. Returns true when Tidy excludes MORE than
 * git (the counted, accepted case); throws on any other disagreement.
 */
function checkAgainstGit(file: string, path: string, tidy: boolean, git: boolean, label: string): boolean {
  if (git) {
    assert.equal(tidy, true, `${label}: git excludes ${JSON.stringify(path)}, Tidy must too`);
  } else if (caseNeutral(file, path)) {
    assert.equal(tidy, false, `${label}: no capital anywhere, Tidy must equal git for ${JSON.stringify(path)}`);
  }
  return tidy && !git;
}

describe('ignore/glob vs git : the frozen corpus (verdicts recorded from real git)', () => {
  let overExclusions = 0;
  for (const row of GIT_CORPUS) {
    it(row.id, () => {
      const tidy = tidyVerdicts(row.file, row.paths);
      row.paths.forEach((path, index) => {
        const label = `${JSON.stringify(row.file)} (ignorecase=${row.ignoreCase})`;
        if (checkAgainstGit(row.file, path, tidy[index], row.expected[index], label)) {
          overExclusions += 1;
        }
      });
    });
  }

  after(() => {
    console.log(`      frozen corpus: ${overExclusions} (file, path) pairs excluded by Tidy and not by git (safe)`);
  });

  it('covers every finding of the audit', () => {
    for (const finding of ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7']) {
      assert.ok(
        GIT_CORPUS.some((row) => row.id.startsWith(`${finding} `)),
        `the corpus has no case for ${finding}`
      );
    }
    assert.ok(GIT_CORPUS.length >= 50);
  });
});

describe('ignore/glob vs git : live git (skipped when git is not installed)', function () {
  before(function () {
    this.timeout(30_000);
    if (!gitAvailable()) {
      this.skip();
    }
  });

  it('git still gives the verdicts the corpus froze (no stale row)', function () {
    this.timeout(120_000);
    for (const ignoreCase of [false, true]) {
      const rows = GIT_CORPUS.filter((row) => row.ignoreCase === ignoreCase);
      const answers = gitCheckIgnore(
        rows.map((row) => ({ ignoreFile: row.file, paths: row.paths })),
        ignoreCase
      );
      rows.forEach((row, index) => {
        assert.deepEqual(
          answers[index],
          row.expected,
          `${row.id}: the frozen verdicts no longer match ${gitVersion()}`
        );
      });
    }
  });
});

// The exact inputs of each audit finding. Every probe is asked of git AND of Tidy
// and both must give the recorded answer; the git answers come from two batched
// calls (one per core.ignorecase value), not one git process per probe.
interface Probe {
  readonly finding: string;
  readonly file: string;
  readonly path: string;
  /** What git answers under `ignoreCase`; Tidy must exclude whenever this is true. */
  readonly expected: boolean;
  readonly ignoreCase?: boolean;
}

const VS_TEMPLATE = '[Dd]ebug/\n[Rr]elease/\n[Bb]in/\n[Oo]bj/\n[Ll]og/\n';

const PROBES: readonly Probe[] = [
  // G1: character classes were read as literal text.
  { finding: 'G1', file: VS_TEMPLATE, path: 'Debug/site.css', expected: true },
  { finding: 'G1', file: VS_TEMPLATE, path: 'debug/x.js', expected: true },
  { finding: 'G1', file: VS_TEMPLATE, path: 'bin/app.js', expected: true },
  { finding: 'G1', file: VS_TEMPLATE, path: 'src/obj/gen.js', expected: true },
  { finding: 'G1', file: VS_TEMPLATE, path: 'DEBUG/x.js', expected: false },
  { finding: 'G1', file: '*.py[cod]\n', path: 'a.pyc', expected: true },
  { finding: 'G1', file: '*.py[cod]\n', path: 'x/a.pyo', expected: true },
  { finding: 'G1', file: '*.py[cod]\n', path: 'a.pyx', expected: false },
  { finding: 'G1', file: '*.min.[cj]s\n', path: 'lib/a.min.js', expected: true },
  { finding: 'G1', file: '[a-c].js\n', path: 'b.js', expected: true },
  { finding: 'G1', file: '[a-c].js\n', path: 'd.js', expected: false },
  { finding: 'G1', file: '[!a].js\n', path: 'b.js', expected: true },
  { finding: 'G1', file: '[!a].js\n', path: 'a.js', expected: false },
  { finding: 'G1', file: '[^a].js\n', path: 'b.js', expected: true },
  // G2: a file under an excluded directory cannot be re-included.
  { finding: 'G2', file: '*.generated.ts\npackages/*/\n!packages/core/\n', path: 'packages/core/api.generated.ts', expected: true },
  { finding: 'G2', file: '*.min.js\n!vendor/\n', path: 'vendor/jquery.min.js', expected: true },
  { finding: 'G2', file: 'dist/\n!dist/keep.css\n', path: 'dist/keep.css', expected: true },
  { finding: 'G2', file: 'generated/\n!*.config.js\n', path: 'generated/a.config.js', expected: true },
  { finding: 'G2', file: '*\n!*/\n!*.js\n', path: 'd/a.css', expected: true },
  { finding: 'G2', file: '*\n!*/\n!*.js\n', path: 'd/a.js', expected: false },
  { finding: 'G2', file: '/*\n!/foo\n', path: 'foo/a', expected: false },
  // G3: a UTF-8 byte order mark erased the first pattern.
  { finding: 'G3', file: `${BOM}dist/\nbuild/\n`, path: 'dist/a.js', expected: true },
  { finding: 'G3', file: `${BOM}dist/\nbuild/\n`, path: 'build/a.js', expected: true },
  { finding: 'G3', file: `${BOM}*.css\r\n!keep.css\r\n`, path: 'keep.css', expected: false },
  // G4: case, under core.ignorecase (Windows, macOS default) and without it.
  { finding: 'G4', file: 'Dist/\n', path: 'dist/a.js', expected: true, ignoreCase: true },
  { finding: 'G4', file: 'Dist/\n', path: 'dist/a.js', expected: false, ignoreCase: false },
  { finding: 'G4', file: '*.JS\n', path: 'a.js', expected: true, ignoreCase: true },
  { finding: 'G4', file: '*.JS\n', path: 'a.js', expected: false, ignoreCase: false },
  { finding: 'G4', file: '[Dd]ebug\n', path: 'DEBUG', expected: true, ignoreCase: true },
  // git folds only the TEXT inside a class: [D] never matches under ignorecase, [!D] always does.
  { finding: 'G4', file: '[D]ebug\n', path: 'Debug', expected: false, ignoreCase: true },
  { finding: 'G4', file: '[!D]ebug\n', path: 'Debug', expected: true, ignoreCase: true },
  // G5: a segment of three or more stars is a globstar (a regression of round one).
  { finding: 'G5', file: 'src/***/gen\n', path: 'src/a/b/gen', expected: true },
  { finding: 'G5', file: 'src/***/gen\n', path: 'src/gen', expected: true },
  { finding: 'G5', file: 'a/***/b\n', path: 'a/x/y/b', expected: true },
  { finding: 'G5', file: '***/b\n', path: 'x/y/b', expected: true },
  { finding: 'G5', file: '/****/.a\n', path: 'x/y/.a', expected: true },
  // G6: leading blanks are part of the pattern, a trailing TAB too.
  { finding: 'G6', file: '*.js\n  !keep.js\n', path: 'keep.js', expected: true },
  { finding: 'G6', file: '  #note\n', path: '  #note', expected: true },
  { finding: 'G6', file: '  #note\n', path: 'note', expected: false },
  { finding: 'G6', file: 'foo\t\n', path: 'foo', expected: false },
  { finding: 'G6', file: 'foo \n', path: 'foo', expected: true },
  // G7: a lone CR is not a line break (git splits on LF and drops one CR before it).
  { finding: 'G7', file: '*.js\n!keep.js\rjunk\n', path: 'keep.js', expected: true },
  { finding: 'G7', file: '*.js\r\n!keep.js\r\n', path: 'keep.js', expected: false },
  { finding: 'G7', file: 'a\rb\n', path: 'a\rb', expected: true },
  { finding: 'G7', file: 'a\rb\n', path: 'a', expected: false }
];

describe('ignore/glob vs git : the exact inputs of each audit finding', function () {
  let gitVerdicts: Map<string, boolean>;

  const keyOf = (probe: Probe): string =>
    `${probe.ignoreCase === true}|${probe.file}|${probe.path}`;

  before(function () {
    this.timeout(120_000);
    if (!gitAvailable()) {
      gitVerdicts = new Map();
      return;
    }
    gitVerdicts = new Map();
    for (const ignoreCase of [false, true]) {
      const probes = PROBES.filter((probe) => (probe.ignoreCase === true) === ignoreCase);
      const answers = gitCheckIgnore(
        probes.map((probe) => ({ ignoreFile: probe.file, paths: [probe.path] })),
        ignoreCase
      );
      probes.forEach((probe, index) => gitVerdicts.set(keyOf(probe), answers[index][0]));
    }
  });

  for (const probe of PROBES) {
    const label = `${probe.finding}: ${JSON.stringify(probe.file)} asks ${JSON.stringify(probe.path)}${
      probe.ignoreCase === true ? ' (ignorecase)' : ''
    }`;
    it(label, function () {
      const tidy = tidyVerdicts(probe.file, [probe.path])[0];
      checkAgainstGit(probe.file, probe.path, tidy, probe.expected, 'Tidy');
      const git = gitVerdicts.get(keyOf(probe));
      if (git === undefined) {
        return; // no git on this machine: the recorded answer above is what is checked.
      }
      assert.equal(git, probe.expected, `${gitVersion()} itself no longer says so`);
    });
  }
});

describe('ignore/glob vs git : differential on generated ignore files', function () {
  const cases = Number(process.env.TIDY_GIT_FUZZ_CASES ?? 500);
  const pathsPerCase = 40;

  before(function () {
    this.timeout(30_000);
    if (!gitAvailable()) {
      this.skip();
    }
  });

  /** Runs: [seed, mode, ignoreCase]. Both case modes, the plain and the wide alphabet. */
  const runs: ReadonlyArray<readonly [number, FuzzMode, boolean]> = [
    [101, 'wide', false],
    [102, 'wide', true],
    [103, 'simple', false],
    [104, 'simple', true]
  ];

  let totalPairs = 0;
  let totalOver = 0;

  for (const [seed, mode, ignoreCase] of runs) {
    it(`seed ${seed}, ${mode} alphabet, ignorecase=${ignoreCase}: Tidy excludes whatever git excludes`, function () {
      this.timeout(600_000);
      const generated = generateFuzzCases(seed, cases, pathsPerCase, mode);
      const gitAnswers = gitCheckIgnore(generated, ignoreCase);

      const less: string[] = [];
      const neutral: string[] = [];
      let over = 0;
      let pairs = 0;
      generated.forEach((testCase, index) => {
        const file = testCase.ignoreFile as string;
        const tidy = tidyVerdicts(file, testCase.paths);
        testCase.paths.forEach((path, pathIndex) => {
          pairs += 1;
          const git = gitAnswers[index][pathIndex];
          if (tidy[pathIndex] === git) {
            return;
          }
          const row = `${JSON.stringify(file)} path=${JSON.stringify(path)}`;
          if (!tidy[pathIndex]) {
            less.push(row);
          } else if (caseNeutral(file, path)) {
            neutral.push(row);
          } else {
            over += 1;
          }
        });
      });

      totalPairs += pairs;
      totalOver += over;
      assert.equal(
        less.length,
        0,
        `Tidy EXCLUDES LESS than ${gitVersion()} on ${less.length} of ${pairs} pairs (a file the ` +
          `user excluded would be formatted), e.g. ${less.slice(0, 4).join(' | ')}`
      );
      assert.equal(
        neutral.length,
        0,
        `Tidy excludes MORE than git where case cannot matter, on ${neutral.length} of ${pairs} ` +
          `pairs (a real defect, not a case effect), e.g. ${neutral.slice(0, 4).join(' | ')}`
      );
    });
  }

  after(() => {
    // One line, so a run records how large the differential was.
    console.log(
      `      git differential: ${totalPairs} (ignore file, path) pairs compared with ${gitVersion()}, ` +
        `${totalOver} over-exclusions (Tidy excludes, git does not, case involved; safe)`
    );
  });
});
