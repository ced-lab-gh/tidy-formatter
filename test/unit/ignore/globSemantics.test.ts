// Semantics of the shared linear glob matcher: the defects it fixes (I-L08,
// I-L09, I-L10), the "**" edge cases, an independent regex oracle, and the
// FAIL-CLOSED rule for a pattern that cannot be evaluated. The timing of the
// adversarial patterns lives in globLinear.test.ts.
import assert from 'node:assert/strict';
import {
  MAX_GLOB_LENGTH,
  compileFilesGlob,
  compileIgnorePattern,
  describeUnevaluable,
  patternMatches,
  type IgnorePattern
} from '../../../src/ignore/glob';
import { isIgnoredFile, parseIgnorePatterns } from '../../../src/ignore/soukformatignore';

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

  it('a run of three stars is one star, never a globstar', () => {
    assert.equal(match('a/***/b', 'a/x/b'), true);
    assert.equal(match('a/***/b', 'a/x/y/b'), false);
    assert.equal(match('a/***/b', 'a/b'), false, 'a star needs a segment, a globstar does not');
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

// The linear matcher against an INDEPENDENT backtracking oracle (a RegExp built
// from the same gitignore rules), on small random patterns where the oracle is
// cheap. This is what proves the two-pointer and the segment sweep agree with
// the semantics, not just with the hand-picked examples above.
describe('ignore/glob : agrees with a regex oracle on random small inputs', () => {
  function oracle(pattern: string, isDirectory: boolean): RegExp {
    const directoryOnly = pattern.endsWith('/');
    const segs = pattern.split('/').filter((s) => s !== '');
    const anchored = pattern.startsWith('/') || segs.length > 1;
    const folded = segs.filter((s, i) => !(s === '**' && segs[i - 1] === '**'));
    const wild = (seg: string): string =>
      seg
        .replace(/\*+/g, '*')
        .split('')
        .map((c) => (c === '*' ? '[^/]*' : c === '?' ? '[^/]' : c))
        .join('');

    let head: string;
    if (!anchored) {
      head = `(?:.*/)?${folded[0] === '**' ? '[^/]*' : wild(folded[0])}`;
    } else {
      head = '';
      folded.forEach((seg, i) => {
        const last = i === folded.length - 1;
        if (seg === '**') {
          head += last ? '.+' : '(?:.*/)?';
        } else {
          head += wild(seg) + (last ? '' : '/');
        }
      });
    }
    const tail = directoryOnly && !isDirectory ? '/.+$' : '(?:/.+)?$';
    return new RegExp(`^${head}${tail}`);
  }

  it('matches on 4000 random patterns x 12 paths x 2 kinds', function () {
    this.timeout(20_000);
    let seed = 0x2f6e2b1;
    const next = (bound: number): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
      return (seed >>> 8) % bound;
    };
    const tokens = ['a', 'b', 'a', 'b', '?', '*', '**', '/', '/'];
    const names = ['a', 'b', 'ab', 'ba', 'aab', 'abab', 'bb'];
    let compared = 0;

    for (let n = 0; n < 4000; n += 1) {
      let raw = '';
      const length = 1 + next(6);
      for (let i = 0; i < length; i += 1) {
        raw += tokens[next(tokens.length)];
      }
      const compiled = compileIgnorePattern(raw);
      if (compiled === undefined) {
        continue;
      }
      const asFile = oracle(raw, false);
      const asDirectory = oracle(raw, true);
      for (let p = 0; p < 12; p += 1) {
        const depth = 1 + next(4);
        const path = Array.from({ length: depth }, () => names[next(names.length)]).join('/');
        for (const [isDirectory, expected] of [
          [false, asFile.test(path)],
          [true, asDirectory.test(path)]
        ] as const) {
          assert.equal(
            patternMatches(compiled, path, isDirectory),
            expected,
            `pattern "${raw}" vs "${path}" (directory=${isDirectory})`
          );
          compared += 1;
        }
      }
    }
    assert.ok(compared > 40000, `only ${compared} comparisons ran`);
  });
});

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
