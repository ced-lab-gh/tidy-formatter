// Semantics of the shared linear glob matcher: the defects it fixes (I-L08,
// I-L09, I-L10), the "**" edge cases, an independent regex oracle, and the
// FAIL-CLOSED rule for a pattern that cannot be evaluated. The timing of the
// adversarial patterns lives in globLinear.test.ts.
import assert from 'node:assert/strict';
import {
  DEFAULT_IGNORE_CASE,
  MAX_GLOB_LENGTH,
  MatchBudget,
  compileFilesGlob,
  compileIgnorePattern,
  describeUnevaluable,
  evaluatePatterns,
  patternMatches,
  type IgnorePattern
} from '../../../src/ignore/glob';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SOUKFORMATIGNORE_FILENAME,
  decideIgnore,
  evaluateIgnore,
  isFailClosedDetail,
  isIgnoredFile,
  parseIgnorePatterns,
  resolveIgnore
} from '../../../src/ignore/soukformatignore';

function match(line: string, path: string): boolean {
  const pattern = compileIgnorePattern(line);
  assert.ok(pattern, `pattern "${line}" should compile`);
  return patternMatches(pattern as IgnorePattern, path);
}

describe('ignore/glob : I-L08 directory-only patterns', () => {
  it('"build/" matches the directory and everything under it, at any depth', () => {
    const pattern = compileIgnorePattern('build/') as IgnorePattern;
    assert.equal(patternMatches(pattern, 'build', true), true, 'the directory itself');
    assert.equal(patternMatches(pattern, 'build/x.js'), true);
    assert.equal(patternMatches(pattern, 'build/a/b/x.js'), true);
    assert.equal(patternMatches(pattern, 'src/build/x.js'), true);
    assert.equal(patternMatches(pattern, 'src/build', true), true, 'a nested directory');
  });

  it('"build/" never matches a FILE named build', () => {
    const pattern = compileIgnorePattern('build/') as IgnorePattern;
    assert.equal(patternMatches(pattern, 'build'), false);
    assert.equal(patternMatches(pattern, 'src/build'), false);
    assert.equal(patternMatches(pattern, 'src/build', false), false);
  });

  it('a name-only pattern without a slash still matches a file of that name', () => {
    assert.equal(match('build', 'build'), true);
    assert.equal(match('build', 'src/build'), true);
  });

  it('an anchored directory-only pattern keeps both rules', () => {
    const pattern = compileIgnorePattern('/out/gen/') as IgnorePattern;
    assert.equal(patternMatches(pattern, 'out/gen/a.js'), true);
    assert.equal(patternMatches(pattern, 'out/gen'), false, 'a file');
    assert.equal(patternMatches(pattern, 'out/gen', true), true, 'a directory');
    assert.equal(patternMatches(pattern, 'x/out/gen/a.js'), false, 'anchored');
  });
});

describe('ignore/glob : I-L09 escaped wildcards', () => {
  it('foo\\*bar matches the literal text foo*bar and nothing else', () => {
    assert.equal(match('foo\\*bar', 'foo*bar'), true);
    assert.equal(match('foo\\*bar', 'fooXbar'), false, 'the star is not a wildcard');
    assert.equal(match('foo\\*bar', 'foobar'), false);
    assert.equal(match('foo\\*bar', 'foo\\Xbar'), false, 'no literal backslash either');
    assert.equal(match('foo\\*bar', 'sub/foo*bar'), true, 'name-only: any depth');
  });

  it('an escaped "?" is a literal question mark', () => {
    assert.equal(match('a\\?b', 'a?b'), true);
    assert.equal(match('a\\?b', 'aXb'), false);
  });

  it('an escaped backslash is a literal backslash', () => {
    assert.equal(match('a\\\\b', 'a\\b'), true);
    assert.equal(match('a\\\\b', 'ab'), false);
  });

  it('an escaped "*" is not a globstar either: \\*\\* is the literal "**"', () => {
    assert.equal(match('a/\\*\\*/b', 'a/**/b'), true);
    assert.equal(match('a/\\*\\*/b', 'a/x/y/b'), false);
  });

  it('an escaped "!" or "#" at the start is a literal character', () => {
    assert.equal(match('\\!keep.css', '!keep.css'), true);
    assert.equal(match('\\!keep.css', 'keep.css'), false);
    assert.equal((compileIgnorePattern('\\!keep.css') as IgnorePattern).negated, false);
  });

  it('an escaped slash is a separator', () => {
    assert.equal(match('a\\/b', 'a/b'), true);
    assert.equal(match('a\\/b', 'x/a/b'), false, 'a separator anchors, like a plain slash');
  });
});

describe('ignore/glob : I-L10 "**" that is not a whole segment is a plain "*"', () => {
  it('src**min behaves as src*min and does not cross a slash', () => {
    assert.equal(match('src**min', 'srcXmin'), true);
    assert.equal(match('src**min', 'src-min'), true);
    assert.equal(match('src**min', 'srcmin'), true);
    assert.equal(match('src**min', 'src/x/min'), false);
    assert.equal(match('src**min', 'src/min'), false);
  });

  it('a trailing "**" glued to a name stays inside its segment', () => {
    assert.equal(match('lib**', 'library'), true);
    assert.equal(match('lib**', 'lib/sub/x.js'), true, 'lib is a directory: its contents');
    assert.equal(match('a/b**', 'a/bc'), true);
    assert.equal(match('a/b**', 'a/x/bc'), false);
  });

  // G5 (audit etape 10): git reads a segment made only of two OR MORE stars as a
  // globstar. The first round folded "***" into a single star, which excluded
  // less than git, and a test pinned that. Verified against git in globGit.test.ts.
  it('a segment of three stars IS a globstar, like git', () => {
    assert.equal(match('a/***/b', 'a/x/b'), true);
    assert.equal(match('a/***/b', 'a/x/y/b'), true);
    assert.equal(match('a/***/b', 'a/b'), true, 'zero directories, like **');
    assert.equal(match('***/b', 'x/y/b'), true);
    assert.equal(match('/****/.a', 'x/y/.a'), true);
  });

  it('a run of stars glued to other characters is still one plain star', () => {
    assert.equal(match('a/b***c/d', 'a/bxc/d'), true);
    assert.equal(match('a/b***c/d', 'a/bx/y/c/d'), false);
  });

  it('a whole-segment "**" is still a globstar', () => {
    assert.equal(match('a/**/b', 'a/b'), true);
    assert.equal(match('a/**/b', 'a/x/y/b'), true);
    assert.equal(match('**/b', 'x/y/b'), true);
  });
});

describe('ignore/glob : "**" edge cases', () => {
  it('a trailing "/**" needs at least one segment beneath: it is not the directory', () => {
    assert.equal(match('a/**', 'a'), false, 'a FILE named a is not "inside" a');
    assert.equal(match('a/**', 'a/b'), true);
    assert.equal(match('a/**', 'a/b/c'), true);
  });

  it('consecutive globstars mean one', () => {
    assert.equal(match('a/**/**/b', 'a/b'), true);
    assert.equal(match('a/**/**/b', 'a/x/y/b'), true);
    assert.equal(match('**/**/b', 'b'), true);
  });

  it('a lone "**" matches every path', () => {
    assert.equal(match('**', 'a.css'), true);
    assert.equal(match('**', 'a/b/c.css'), true);
  });

  it('globstars in the middle keep zero-or-more semantics around a literal', () => {
    assert.equal(match('a/**/b/**/c', 'a/b/c'), true);
    assert.equal(match('a/**/b/**/c', 'a/x/b/y/z/c'), true);
    assert.equal(match('a/**/b/**/c', 'a/x/c'), false);
  });
});

// The regex oracle that used to live here modelled the matcher's OWN rules, so it
// shared the matcher's blind spots (audit etape 10). It is replaced by REAL git:
// see globGit.test.ts (frozen corpus, named findings, generated differential).

// FAIL CLOSED. A pattern the matcher cannot evaluate must never disappear: the
// files it might cover stay excluded, and the reason is available to report.
describe('ignore/glob : fail closed on a pattern that cannot be evaluated', () => {
  const overCap = 'a'.repeat(MAX_GLOB_LENGTH + 1);

  it('an over-long pattern compiles to an unevaluable pattern, not to undefined', () => {
    const pattern = compileIgnorePattern(overCap);
    assert.ok(pattern, 'it must not be dropped');
    assert.match((pattern as IgnorePattern).unevaluable ?? '', /over the 1024-character limit/);
  });

  it('a pattern of exactly the cap length is still evaluated normally', () => {
    const atCap = 'a'.repeat(MAX_GLOB_LENGTH);
    const pattern = compileIgnorePattern(atCap) as IgnorePattern;
    assert.equal(pattern.unevaluable, undefined);
    assert.equal(patternMatches(pattern, atCap), true);
    assert.equal(patternMatches(pattern, 'other.css'), false);
  });

  it('a lone trailing backslash is unevaluable', () => {
    const pattern = compileIgnorePattern('src/vendor\\') as IgnorePattern;
    assert.ok(pattern);
    assert.match(pattern.unevaluable ?? '', /lone backslash/);
    // An even number of trailing backslashes is an escaped backslash: fine.
    assert.equal((compileIgnorePattern('src\\\\') as IgnorePattern).unevaluable, undefined);
  });

  it('an unevaluable pattern covers EVERY path (the file stays excluded)', () => {
    const pattern = compileIgnorePattern(overCap) as IgnorePattern;
    assert.equal(patternMatches(pattern, 'src/app.css'), true);
    assert.equal(patternMatches(pattern, 'a.js'), true);
    assert.equal(patternMatches(pattern, 'deep/er/x.ts'), true);
    assert.equal(patternMatches(pattern, 'dir', true), true);
  });

  it('an unevaluable NEGATED pattern never re-includes anything', () => {
    const pattern = compileIgnorePattern(`!${overCap}`) as IgnorePattern;
    assert.equal(pattern.negated, true);
    assert.ok(pattern.unevaluable);
    assert.equal(patternMatches(pattern, 'src/app.css'), false);
  });

  it('end to end: a .soukformatignore line that cannot be evaluated excludes the files', () => {
    const patterns = parseIgnorePatterns(`# generated\n${overCap}\n`);
    assert.equal(patterns.length, 1, 'the line is kept, not silently dropped');
    assert.equal(isIgnoredFile('src/app.css', patterns), true);
    assert.equal(isIgnoredFile('README.md', patterns), true);
  });

  it('end to end: an unevaluable negation does not re-include an excluded file', () => {
    const patterns = parseIgnorePatterns(`*.css\n!${overCap}\n!broken\\\n`);
    assert.equal(patterns.length, 3);
    assert.equal(isIgnoredFile('a.css', patterns), true);
    assert.equal(isIgnoredFile('src/b.css', patterns), true);
  });

  it('end to end: a later valid negation still re-includes (last match wins)', () => {
    const patterns = parseIgnorePatterns(`${overCap}\n!keep.css\n`);
    assert.equal(isIgnoredFile('a.css', patterns), true);
    assert.equal(isIgnoredFile('keep.css', patterns), false);
  });

  it('describeUnevaluable names the pattern, the reason and the consequence', () => {
    const message = describeUnevaluable(compileIgnorePattern('src/vendor\\') as IgnorePattern);
    assert.ok(message);
    assert.match(message as string, /"src\/vendor\\"/);
    assert.match(message as string, /lone backslash/);
    assert.match(message as string, /every file it might cover is excluded/);

    const negated = describeUnevaluable(compileIgnorePattern('!x\\') as IgnorePattern);
    assert.match(negated as string, /re-include is not applied/);

    assert.equal(describeUnevaluable(compileIgnorePattern('*.css') as IgnorePattern), undefined);
  });

  it('describeUnevaluable never echoes a huge pattern in full', () => {
    const message = describeUnevaluable(compileIgnorePattern('a'.repeat(5000)) as IgnorePattern);
    assert.ok(message);
    assert.ok((message as string).length < 300, `report is ${(message as string).length} chars`);
  });
});

describe('ignore/glob : compileFilesGlob (the .soukformatrc overrides[].files entry point)', () => {
  it('uses the same semantics as an ignore line: a slash-less glob matches at any depth', () => {
    const glob = compileFilesGlob('*.css') as IgnorePattern;
    assert.equal(patternMatches(glob, 'a.css'), true);
    assert.equal(patternMatches(glob, 'sub/a.css'), true);
    assert.equal(patternMatches(glob, 'sub/deeper/a.css'), true);
    assert.equal(patternMatches(glob, 'sub/a.less'), false);
  });

  it('a leading "!" is a literal character, never a negation', () => {
    const glob = compileFilesGlob('!a.css') as IgnorePattern;
    assert.equal(glob.negated, false);
    assert.equal(patternMatches(glob, '!a.css'), true);
    assert.equal(patternMatches(glob, 'a.css'), false);
  });

  it('returns undefined for an empty body and an unevaluable pattern for a bad one', () => {
    assert.equal(compileFilesGlob('/'), undefined);
    assert.ok((compileFilesGlob('x\\') as IgnorePattern).unevaluable);
  });
});

// G1 (audit etape 10): bracket expressions. The verdicts below are also asserted
// against real git in globGit.test.ts; these pin the compile and match rules.
describe('ignore/glob : G1 character classes', () => {
  it('[abc] matches exactly one of its members, never a slash, and is a single character', () => {
    assert.equal(match('[ab].js', 'a.js'), true);
    assert.equal(match('[ab].js', 'b.js'), true);
    assert.equal(match('[ab].js', 'c.js'), false);
    assert.equal(match('[ab].js', 'ab.js'), false, 'one character, not two');
    assert.equal(match('a[!x]b', 'a/b'), false, 'a class never matches a slash');
  });

  it('a range [a-z], negation [!a] and [^a], and a leading "]" member', () => {
    assert.equal(match('[a-c]x', 'bx'), true);
    assert.equal(match('[a-c]x', 'dx'), false);
    assert.equal(match('[!a]x', 'bx'), true);
    assert.equal(match('[!a]x', 'ax'), false);
    assert.equal(match('[^a]x', 'bx'), true);
    assert.equal(match('[^a]x', 'ax'), false);
    assert.equal(match('[]a]x', ']x'), true);
    assert.equal(match('[!]a]x', ']x'), false);
  });

  it('POSIX classes [[:alpha:]] work, an unknown [:name:] matches nothing', () => {
    assert.equal(match('[[:digit:]]x', '5x'), true);
    assert.equal(match('[[:digit:]]x', 'ax'), false);
    assert.equal(match('[[:upper:]]x', 'Ax'), true);
    const unknown = compileIgnorePattern('[[:nope:]]x') as IgnorePattern;
    assert.equal(unknown.neverMatches, true);
    assert.equal(unknown.unevaluable, undefined, 'not a fail-closed case: git matches nothing either');
    assert.equal(patternMatches(unknown, 'ax'), false);
  });

  it('an unterminated class matches nothing (git aborts), without failing closed', () => {
    const pattern = compileIgnorePattern('foo[') as IgnorePattern;
    assert.equal(pattern.neverMatches, true);
    assert.equal(pattern.unevaluable, undefined);
    assert.equal(patternMatches(pattern, 'foo['), false);
    assert.equal(patternMatches(pattern, 'foo'), false);
  });

  it('a class is one BYTE wide, like git (so "?" does not match an accented letter)', () => {
    assert.equal(match('?', 'a'), true);
    assert.equal(match('?', 'é'), false, 'é is two UTF-8 bytes');
    assert.equal(match('??', 'é'), true);
    assert.equal(match('é.css', 'é.css'), true);
  });

  it('a "/" inside a class makes the pattern a path pattern, like git', () => {
    const pattern = compileIgnorePattern('a[!/]b') as IgnorePattern;
    assert.equal(pattern.anchored, true);
    assert.equal(patternMatches(pattern, 'axb'), true);
    assert.equal(patternMatches(pattern, 'x/axb'), false, 'anchored');
  });

  it('the classes of the Visual Studio template match', () => {
    for (const [line, path] of [
      ['[Dd]ebug/', 'Debug/site.css'],
      ['[Bb]in/', 'bin/app.js'],
      ['[Oo]bj/', 'src/obj/gen.js'],
      ['*.py[cod]', 'x/a.pyc']
    ]) {
      assert.equal(match(line, path), true, `${line} vs ${path}`);
    }
  });

  it('under ignorecase git folds only the text inside a class (its own quirk)', () => {
    const fold = { ignoreCase: true };
    const check = (line: string, path: string): boolean =>
      patternMatches(compileIgnorePattern(line, fold) as IgnorePattern, path);
    assert.equal(check('[Dd]ebug', 'DEBUG'), true);
    assert.equal(check('[D]ebug', 'Debug'), false, 'git: [D] never matches under ignorecase');
    assert.equal(check('[!D]ebug', 'Debug'), true, 'git: [!D] matches D under ignorecase');
    assert.equal(check('[A-C]x', 'ax'), true);
  });
});

// Case: git ignores case where the file system does (Windows, macOS).
describe('ignore/glob : G4 case sensitivity', () => {
  it('folds ASCII case when asked, and only then', () => {
    const fold = compileIgnorePattern('Dist/', { ignoreCase: true }) as IgnorePattern;
    const exact = compileIgnorePattern('Dist/', { ignoreCase: false }) as IgnorePattern;
    assert.equal(patternMatches(fold, 'dist/a.js'), true);
    assert.equal(patternMatches(fold, 'DIST/a.js'), true);
    assert.equal(patternMatches(exact, 'dist/a.js'), false);
    assert.equal(patternMatches(exact, 'Dist/a.js'), true);
  });

  it('defaults to the platform: Windows and macOS ignore case, others do not', () => {
    assert.equal(DEFAULT_IGNORE_CASE, process.platform === 'win32' || process.platform === 'darwin');
    const pattern = compileIgnorePattern('Dist/') as IgnorePattern;
    assert.equal(pattern.ignoreCase, DEFAULT_IGNORE_CASE);
  });

  it('folds ASCII only, as git does (a non-ASCII letter keeps its case)', () => {
    const fold = compileIgnorePattern('\u00c9.css', { ignoreCase: true }) as IgnorePattern;
    assert.equal(patternMatches(fold, '\u00c9.css'), true);
    assert.equal(patternMatches(fold, '\u00e9.css'), false);
  });
});

// G2: git's precedence, not "last match wins" over every prefix.
describe('ignore/glob : G2 negation follows git', () => {
  const evaluate = (file: string, path: string): boolean =>
    isIgnoredFile(path, parseIgnorePatterns(file, { ignoreCase: false }));

  it('a file under an excluded directory cannot be re-included by a later pattern', () => {
    assert.equal(evaluate('dist/\n!dist/keep.css\n', 'dist/keep.css'), true);
    assert.equal(evaluate('generated/\n!*.config.js\n', 'generated/a.config.js'), true);
  });

  it('"!dir/" re-includes the directory, not the files another pattern excludes', () => {
    assert.equal(evaluate('*.min.js\n!vendor/\n', 'vendor/jquery.min.js'), true);
    assert.equal(evaluate('*.generated.ts\npackages/*/\n!packages/core/\n', 'packages/core/api.generated.ts'), true);
  });

  it('the classic whitelist still works', () => {
    const whitelist = '/*\n!/foo\n/foo/*\n!/foo/bar\n';
    assert.equal(evaluate(whitelist, 'foo/bar/x'), false);
    assert.equal(evaluate(whitelist, 'foo/baz/x'), true);
    assert.equal(evaluate('*\n!*/\n!*.js\n', 'd/a.js'), false);
    assert.equal(evaluate('*\n!*/\n!*.js\n', 'd/a.css'), true);
  });

  it('a negation after a file rule re-includes that file (last match wins at the same level)', () => {
    assert.equal(evaluate('*.js\n!keep.js\n', 'keep.js'), false);
    assert.equal(evaluate('*.js\n!keep.js\n', 'src/keep.js'), false);
    assert.equal(evaluate('*.js\n!keep.js\n', 'a.js'), true);
  });
});

// G3 and G6: how the FILE is read.
describe('ignore/glob : G3 byte order mark and G6 whitespace', () => {
  it('a leading UTF-8 BOM is dropped, so the first pattern still applies', () => {
    const bom = String.fromCharCode(0xfeff);
    const patterns = parseIgnorePatterns(`${bom}dist/\nbuild/\n`);
    assert.equal(patterns.length, 2);
    assert.equal(isIgnoredFile('dist/a.js', patterns), true);
    assert.equal(isIgnoredFile('build/a.js', patterns), true);
  });

  it('leading blanks are part of the pattern; an indented "!" is not a negation', () => {
    const patterns = parseIgnorePatterns('*.js\n  !keep.js\n');
    assert.equal(patterns[1].negated, false);
    assert.equal(isIgnoredFile('keep.js', patterns), true);
  });

  it('only SPACES are trimmed at the end, a tab is part of the pattern', () => {
    assert.equal(isIgnoredFile('foo', parseIgnorePatterns('foo  \n')), true);
    assert.equal(isIgnoredFile('foo', parseIgnorePatterns('foo\t\n')), false);
    assert.equal(isIgnoredFile('foo\t', parseIgnorePatterns('foo\t\n')), true);
  });

  it('a tab before a trailing space is kept: only the space goes', () => {
    const patterns = parseIgnorePatterns('foo\t \n');
    assert.equal(isIgnoredFile('foo\t', patterns), true);
    assert.equal(isIgnoredFile('foo', patterns), false);
  });

  it('an escaped trailing space is kept', () => {
    assert.equal(isIgnoredFile('foo ', parseIgnorePatterns('foo\\ \n')), true);
    assert.equal(isIgnoredFile('foo', parseIgnorePatterns('foo\\ \n')), false);
  });

  it('only a "#" in the first column starts a comment', () => {
    assert.equal(parseIgnorePatterns('# comment\n').length, 0);
    assert.equal(parseIgnorePatterns('  # not a comment\n').length, 1);
    assert.equal(isIgnoredFile('#file', parseIgnorePatterns('\\#file\n')), true);
  });
});

// The forms on which this matcher is KNOWINGLY stricter than git: it excludes more,
// never less. Pinned so the choice is deliberate and visible.
describe('ignore/glob : known deviations from git, all in the safe direction', () => {
  it('a globstar followed by an escaped slash also matches zero directories (git needs one)', () => {
    assert.equal(match('a/**\\/b', 'a/x/b'), true);
    assert.equal(match('a/**\\/b', 'a/b'), true, 'git: no match; Tidy excludes more');
  });

  it('a line ending in a lone backslash fails closed (git matches nothing)', () => {
    const pattern = compileIgnorePattern('foo\\') as IgnorePattern;
    assert.match(pattern.unevaluable ?? '', /lone backslash/);
    assert.equal(patternMatches(pattern, 'anything/at/all'), true);
  });

  it('a pattern ending in an escaped slash fails closed (git matches nothing)', () => {
    const pattern = compileIgnorePattern('foo\\/') as IgnorePattern;
    assert.ok(pattern.unevaluable);
  });

  it('doubled slashes can never match, exactly like git', () => {
    assert.equal(match('a//b', 'a/b'), false);
    assert.equal(match('//a', 'a'), false);
    assert.equal(match('d//', 'd/e'), false);
  });
});

// P1 at the pattern level: the ignore verdict itself (not only the wording built on
// it) must fail CLOSED when the work budget runs out.
describe('ignore/glob : P1 the work budget fails closed at the verdict', () => {
  function multiX(k: number): string {
    const unit = `**/*${'a'.repeat(k)}c`;
    let glob = '';
    while (glob.length + unit.length <= 1024) {
      glob += unit;
    }
    return glob;
  }
  const deepPath = Array.from({ length: 16 }, () => `${'a'.repeat(254)}c`).join('/');
  const adversarial = Array.from({ length: 1000 }, () => multiX(60)).join('\n');

  it('evaluatePatterns excludes the path and says the budget ran out', () => {
    const patterns = parseIgnorePatterns(adversarial, { ignoreCase: false });
    assert.deepEqual(evaluatePatterns(patterns, deepPath), { ignored: true, budgetExceeded: true });
  });

  it('isIgnoredFile and decideIgnore carry the same fail-closed answer', () => {
    const patterns = parseIgnorePatterns(adversarial, { ignoreCase: false });
    assert.equal(isIgnoredFile(deepPath, patterns), true);
    assert.equal(decideIgnore(deepPath, patterns).budgetExceeded, true);
  });

  it('a later valid negation does not rescue a path whose lookup ran out of budget', () => {
    const patterns = parseIgnorePatterns(`${adversarial}\n!keep.css\n`, { ignoreCase: false });
    assert.equal(isIgnoredFile(`${deepPath}/keep.css`, patterns), true);
  });

  it('a shared MatchBudget is spent across patterns and then answers fail-closed at once', () => {
    const budget = new MatchBudget(40);
    const pattern = compileIgnorePattern('*a*a*a*a*b', { ignoreCase: false }) as IgnorePattern;
    const negated = compileIgnorePattern('!*a*a*a*a*b', { ignoreCase: false }) as IgnorePattern;
    const subject = 'a'.repeat(200);
    assert.equal(patternMatches(pattern, subject, false, budget), true, 'out of budget: excluded');
    assert.equal(budget.exhausted, true);
    assert.equal(patternMatches(negated, subject, false, budget), false, 'a negation never re-includes');
    const before = budget.remaining;
    patternMatches(pattern, subject, false, budget);
    assert.equal(budget.remaining, before, 'an exhausted budget does no further work');
  });

  it('the reason is reported through the same mechanism as an unevaluable line', () => {
    const verdict = evaluateIgnore(adversarial, deepPath, { ignoreCase: false });
    assert.equal(verdict.ignored, true);
    assert.ok(verdict.failClosed, 'a fail-closed reason is attached');
    assert.match(verdict.failClosed?.explanation ?? '', /needs more than \d+ steps/);
    assert.match(verdict.failClosed?.explanation ?? '', /every file under this ignore file's folder is excluded/);
    const detail = verdict.failClosed?.detail ?? '';
    assert.equal(isFailClosedDetail(detail), true);
    assert.ok(detail.length < 200, 'short enough for the one-line record');
    assert.doesNotMatch(detail, /[\r\n]/);
  });

  it('resolveIgnore: a SHORT path does not run the same adversarial file out of budget', () => {
    const root = mkdtempSync(join(tmpdir(), 'souk-budget-'));
    try {
      writeFileSync(join(root, SOUKFORMATIGNORE_FILENAME), adversarial);
      const dir = join(root, 'src');
      mkdirSync(dir, { recursive: true });
      const lookup = resolveIgnore(join(dir, 'a.css'), root);
      // A short path costs little: the same file does NOT run out of budget here.
      assert.equal(lookup.ignored, false);
      assert.equal(lookup.failClosed, undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('an ordinary file of 26 000 lines stays far below the budget', () => {
    const text = Array.from({ length: 26_000 }, (_, i) => `gen_${i}_dist/`).join('\n');
    const patterns = parseIgnorePatterns(text, { ignoreCase: false });
    const verdict = evaluatePatterns(patterns, 'packages/core/src/components/button/Button.tsx');
    assert.deepEqual(verdict, { ignored: false });
  });
});
