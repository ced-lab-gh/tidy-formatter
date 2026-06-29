// Unit tests for the pure gitignore-style glob matcher (Axe 4 — extends the
// minimal glob of config/soukformatrc.ts without a new npm dependency).
import assert from 'node:assert/strict';
import {
  compileIgnorePattern,
  patternMatches,
  type IgnorePattern
} from '../../../src/ignore/glob';

function match(line: string, path: string): boolean {
  const pattern = compileIgnorePattern(line);
  assert.ok(pattern, `pattern "${line}" should compile`);
  return patternMatches(pattern as IgnorePattern, path);
}

describe('ignore/glob — compileIgnorePattern + patternMatches', () => {
  it('a name-only pattern matches that file at any depth', () => {
    assert.equal(match('*.min.css', 'a.min.css'), true);
    assert.equal(match('*.min.css', 'src/styles/a.min.css'), true);
    assert.equal(match('*.min.css', 'a.css'), false);
  });

  it('a bare directory name matches at any depth (and its contents)', () => {
    assert.equal(match('node_modules', 'node_modules'), true);
    assert.equal(match('node_modules', 'node_modules/x.js'), true);
    assert.equal(match('node_modules', 'a/node_modules/x.js'), true);
    assert.equal(match('node_modules', 'src/app.js'), false);
  });

  it('an anchored pattern (leading slash) matches only from the root', () => {
    assert.equal(match('/build', 'build/x.js'), true);
    assert.equal(match('/build', 'src/build/x.js'), false);
  });

  it('a pattern with an internal slash is anchored', () => {
    assert.equal(match('src/vendor', 'src/vendor/a.js'), true);
    assert.equal(match('src/vendor', 'app/src/vendor/a.js'), false);
  });

  it('a trailing-slash pattern marks directory-only and matches contents', () => {
    const pattern = compileIgnorePattern('dist/');
    assert.ok(pattern);
    assert.equal((pattern as IgnorePattern).directoryOnly, true);
    assert.equal(match('dist/', 'dist/bundle.js'), true);
    assert.equal(match('dist/', 'dist'), true);
  });

  it('the "**" wildcard crosses path segments, including zero', () => {
    assert.equal(match('src/**/*.css', 'src/a.css'), true);
    assert.equal(match('src/**/*.css', 'src/styles/theme.css'), true);
    assert.equal(match('src/**/*.css', 'src/styles/deep/theme.css'), true);
    assert.equal(match('src/**/*.css', 'other/a.css'), false);
  });

  it('a single "*" does not cross a path separator', () => {
    assert.equal(match('src/*.css', 'src/a.css'), true);
    assert.equal(match('src/*.css', 'src/sub/a.css'), false);
  });

  it('"?" matches exactly one non-separator character', () => {
    assert.equal(match('file?.css', 'file1.css'), true);
    assert.equal(match('file?.css', 'file.css'), false);
    assert.equal(match('file?.css', 'sub/file1.css'), true);
  });

  it('escapes regex metacharacters in literal segments', () => {
    assert.equal(match('a.(b).css', 'a.(b).css'), true);
    assert.equal(match('a.(b).css', 'aX(b)Xcss'), false);
  });

  it('records the negation flag for a "!" prefix and keeps the body', () => {
    const pattern = compileIgnorePattern('!keep.css');
    assert.ok(pattern);
    assert.equal((pattern as IgnorePattern).negated, true);
    assert.equal(match('!keep.css', 'keep.css'), true);
  });

  it('returns undefined for an empty body after stripping markers', () => {
    assert.equal(compileIgnorePattern('!'), undefined);
    assert.equal(compileIgnorePattern('/'), undefined);
  });

  it('treats an escaped leading "#" as a literal filename', () => {
    assert.equal(match('\\#notes.md', '#notes.md'), true);
    assert.equal(match('\\#notes.md', 'notes.md'), false);
  });

  it('a trailing "/**" matches everything beneath a directory', () => {
    assert.equal(match('logs/**', 'logs/today/app.log'), true);
    assert.equal(match('logs/**', 'logs/app.log'), true);
    assert.equal(match('logs/**', 'other/app.log'), false);
  });

  it('a leading "**/" matches a name at any depth', () => {
    assert.equal(match('**/cache.json', 'a/b/cache.json'), true);
    assert.equal(match('**/cache.json', 'cache.json'), true);
  });
});
