// Unit tests for the .soukformatignore reader (Axe 4.T3).
//
// Two tiers:
//   1. parseIgnorePatterns + isIgnoredFile: PURE matching (no I/O), the public
//      contract isIgnoredFile(relPath, patterns).
//   2. findSoukformatignore / resolveIgnore: on-disk discovery up the tree
//      against real temporary files (node:fs only, no 'vscode').
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseIgnorePatterns,
  isIgnoredFile,
  findSoukformatignore,
  resolveIgnore,
  SOUKFORMATIGNORE_FILENAME
} from '../../../src/ignore/soukformatignore';

describe('ignore/soukformatignore — parseIgnorePatterns + isIgnoredFile (pure)', () => {
  it('ignores a minified file matched by *.min.css', () => {
    const patterns = parseIgnorePatterns('*.min.css\n');
    assert.equal(isIgnoredFile('vendor/lib.min.css', patterns), true);
    assert.equal(isIgnoredFile('src/app.css', patterns), false);
  });

  it('skips blank lines and # comments', () => {
    const patterns = parseIgnorePatterns('# build output\n\n  \ndist/\n');
    assert.equal(patterns.length, 1);
    assert.equal(isIgnoredFile('dist/bundle.js', patterns), true);
  });

  it('honours a "!negation" re-include (last match wins)', () => {
    const patterns = parseIgnorePatterns('*.css\n!keep.css\n');
    assert.equal(isIgnoredFile('a.css', patterns), true);
    assert.equal(isIgnoredFile('keep.css', patterns), false);
  });

  it('a later normal pattern re-excludes a previously negated path', () => {
    const patterns = parseIgnorePatterns('!keep.css\nkeep.css\n');
    assert.equal(isIgnoredFile('keep.css', patterns), true);
  });

  it('returns false when no pattern matches (safe default = format)', () => {
    const patterns = parseIgnorePatterns('dist/\n*.min.js\n');
    assert.equal(isIgnoredFile('src/app.ts', patterns), false);
  });

  it('matches a deep file via a ** override', () => {
    const patterns = parseIgnorePatterns('src/**/*.generated.ts\n');
    assert.equal(isIgnoredFile('src/api/models.generated.ts', patterns), true);
    assert.equal(isIgnoredFile('src/models.generated.ts', patterns), true);
    assert.equal(isIgnoredFile('src/models.ts', patterns), false);
  });

  it('normalises OS-native separators and a leading "./" in the relative path', () => {
    const patterns = parseIgnorePatterns('dist/\n');
    assert.equal(isIgnoredFile('dist\\bundle.js', patterns), true);
    assert.equal(isIgnoredFile('./dist/bundle.js', patterns), true);
  });

  it('honours an escaped trailing space and trims unescaped ones', () => {
    // "foo\ " keeps one trailing space => matches "foo " not "foo".
    const escaped = parseIgnorePatterns('foo\\ \n');
    assert.equal(isIgnoredFile('foo ', escaped), true);
    assert.equal(isIgnoredFile('foo', escaped), false);
    // "bar   " (unescaped) trims to "bar".
    const trimmed = parseIgnorePatterns('bar   \n');
    assert.equal(isIgnoredFile('bar', trimmed), true);
  });

  it('returns false for empty patterns or empty path (no throw)', () => {
    assert.equal(isIgnoredFile('', parseIgnorePatterns('*.css')), false);
    assert.equal(isIgnoredFile('a.css', []), false);
    assert.equal(parseIgnorePatterns('').length, 0);
  });
});

describe('ignore/soukformatignore — on-disk discovery (node:fs)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tidy-ignore-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('finds the nearest .soukformatignore walking up the tree', () => {
    writeFileSync(join(root, SOUKFORMATIGNORE_FILENAME), '*.min.css\n');
    const sub = join(root, 'src', 'styles');
    mkdirSync(sub, { recursive: true });
    const file = join(sub, 'a.min.css');
    writeFileSync(file, '');
    assert.equal(findSoukformatignore(file), join(root, SOUKFORMATIGNORE_FILENAME));
  });

  it('resolveIgnore reports a file ignored by the root ignore file', () => {
    writeFileSync(join(root, SOUKFORMATIGNORE_FILENAME), 'dist/\n');
    const dist = join(root, 'dist');
    mkdirSync(dist, { recursive: true });
    const file = join(dist, 'bundle.js');
    writeFileSync(file, '');
    const result = resolveIgnore(file);
    assert.equal(result.ignored, true);
    assert.equal(result.path, join(root, SOUKFORMATIGNORE_FILENAME));
  });

  it('resolveIgnore returns not-ignored when no file matches', () => {
    writeFileSync(join(root, SOUKFORMATIGNORE_FILENAME), 'dist/\n');
    const file = join(root, 'src.css');
    writeFileSync(file, '');
    assert.equal(resolveIgnore(file).ignored, false);
  });

  it('a sub-directory .soukformatignore shadows the root cascade', () => {
    writeFileSync(join(root, SOUKFORMATIGNORE_FILENAME), '*.css\n');
    const sub = join(root, 'pkg');
    mkdirSync(sub, { recursive: true });
    // The nearest file (in pkg/) is the one consulted; it ignores nothing here.
    writeFileSync(join(sub, SOUKFORMATIGNORE_FILENAME), '# empty\n');
    const file = join(sub, 'styles.css');
    writeFileSync(file, '');
    const result = resolveIgnore(file);
    assert.equal(result.ignored, false);
    assert.equal(result.path, join(sub, SOUKFORMATIGNORE_FILENAME));
  });

  it('resolveIgnore is fail-safe when no ignore file exists (formats)', () => {
    const file = join(root, 'orphan.css');
    writeFileSync(file, '');
    const result = resolveIgnore(file);
    assert.equal(result.ignored, false);
    assert.equal(result.path, undefined);
  });
});
