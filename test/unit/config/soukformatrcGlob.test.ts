// .soukformatrc: the overrides[].files globs now use the SAME linear gitignore
// matcher as .soukformatignore (LOW-04), a glob that cannot be evaluated is
// reported instead of guessed, and reading the file is bounded (LOW-07): a size
// cap, one stat per directory level, and a memo of the parsed file.
//
// The adversarial TIMING of the glob path lives in ignore/globLinear.test.ts.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_SOUKFORMATRC_BYTES,
  SOUKFORMATRC_FILENAME,
  clearSoukformatrcCache,
  parseSoukformatrc,
  readSoukformatrcLayers
} from '../../../src/config/soukformatrc';
import { resolveOptions } from '../../../src/config/resolver';

/** JSONC text with one override, built with JSON.stringify so escapes are exact. */
function withOverride(files: string, indent = 8): string {
  return JSON.stringify({
    css: { indent: 4 },
    overrides: [{ files, options: { indent } }]
  });
}

/** Number of layers a document at `rel` gets from a config with one override. */
function overrideApplies(files: string, rel: string): boolean {
  const { layers } = parseSoukformatrc(withOverride(files), 'css', '/p/.soukformatrc', rel);
  return layers.length === 2; // the [css] section + the override
}

describe('config/soukformatrc : LOW-04 an override glob matches like a gitignore line', () => {
  it('"*.css" matches a file in a sub-directory, not only at the config root', () => {
    // This used to fail for every depth but the root (anchored full-match).
    assert.equal(overrideApplies('*.css', 'a.css'), true);
    assert.equal(overrideApplies('*.css', 'sub/a.css'), true);
    assert.equal(overrideApplies('*.css', 'sub/deeper/a.css'), true);
    assert.equal(overrideApplies('*.css', 'sub/a.less'), false);
  });

  it('the override really changes the resolved options for a nested file', () => {
    const { layers } = parseSoukformatrc(
      withOverride('*.css'),
      'css',
      '/p/.soukformatrc',
      'sub/a.css'
    );
    assert.equal(resolveOptions({ languageId: 'css', layers }).tabSize, 8);
  });

  it('a glob with an inner slash stays anchored to the config directory', () => {
    assert.equal(overrideApplies('src/*.css', 'src/a.css'), true);
    assert.equal(overrideApplies('src/*.css', 'other/src/a.css'), false);
    assert.equal(overrideApplies('/a.css', 'a.css'), true);
    assert.equal(overrideApplies('/a.css', 'sub/a.css'), false);
  });

  it('keeps every glob that already worked: src/**/*.css, ** as zero directories', () => {
    assert.equal(overrideApplies('src/**/*.css', 'src/a.css'), true);
    assert.equal(overrideApplies('src/**/*.css', 'src/a/b/c.css'), true);
    assert.equal(overrideApplies('src/**/*.css', 'lib/a.css'), false);
  });

  it('I-L08: "build/" applies under the directory, never to a FILE named build', () => {
    assert.equal(overrideApplies('build/', 'build/x.css'), true);
    assert.equal(overrideApplies('build/', 'src/build/x.css'), true);
    assert.equal(overrideApplies('build/', 'build'), false);
  });

  it('I-L09: "foo\\*bar.css" is the literal foo*bar.css', () => {
    assert.equal(overrideApplies('foo\\*bar.css', 'foo*bar.css'), true);
    assert.equal(overrideApplies('foo\\*bar.css', 'fooXbar.css'), false);
  });

  it('I-L10: "src**min.css" is a plain star and does not cross a slash', () => {
    assert.equal(overrideApplies('src**min.css', 'srcXmin.css'), true);
    assert.equal(overrideApplies('src**min.css', 'src/x/min.css'), false);
  });

  it('a leading "!" is a literal character, not a negation', () => {
    assert.equal(overrideApplies('!a.css', 'a.css'), false);
    assert.equal(overrideApplies('!a.css', '!a.css'), true);
  });

  it('LOW-04 on disk: an override "*.css" reaches a file nested in the workspace', () => {
    const root = mkdtempSync(join(tmpdir(), 'souk-glob-'));
    try {
      writeFileSync(join(root, SOUKFORMATRC_FILENAME), withOverride('*.css'));
      mkdirSync(join(root, 'a', 'b'), { recursive: true });
      const file = join(root, 'a', 'b', 'style.css');
      writeFileSync(file, '.x{}');
      clearSoukformatrcCache();

      const result = readSoukformatrcLayers(file, 'css', root);
      assert.equal(result.layers.length, 2);
      assert.equal(resolveOptions({ languageId: 'css', layers: result.layers }).tabSize, 8);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('config/soukformatrc : an override glob that cannot be evaluated is reported', () => {
  const overCap = 'a'.repeat(2000);

  it('is skipped with a warning that names the entry, the reason and the effect', () => {
    const { layers, warnings } = parseSoukformatrc(
      withOverride(overCap),
      'css',
      '/p/.soukformatrc',
      'a.css'
    );
    assert.equal(layers.length, 1, 'only the [css] section: the override is not applied on a guess');
    const message = warnings.map((w) => w.message).join('\n');
    assert.match(message, /overrides\[0\]\.files/);
    assert.match(message, /cannot be evaluated/);
    assert.match(message, /over the 1024-character limit/);
    assert.match(message, /the override is skipped/);
    assert.ok(message.length < 400, 'a huge glob is not echoed in full');
  });

  it('a trailing backslash is reported, not silently treated as a literal', () => {
    const { layers, warnings } = parseSoukformatrc(
      withOverride('src\\'),
      'css',
      '/p/.soukformatrc',
      'src/a.css'
    );
    assert.equal(layers.length, 1);
    assert.ok(warnings.some((w) => /lone backslash/.test(w.message)));
  });

  it('a warning is raised even when the document would not have matched', () => {
    // Otherwise the problem would only surface on the one file that trips it.
    const { warnings } = parseSoukformatrc(withOverride(overCap), 'css', '/p/.soukformatrc', 'x.js');
    assert.ok(warnings.some((w) => /cannot be evaluated/.test(w.message)));
  });

  it('the other overrides still apply', () => {
    const text = JSON.stringify({
      overrides: [
        { files: overCap, options: { indent: 2 } },
        { files: '*.css', options: { indent: 8 } }
      ]
    });
    const { layers, warnings } = parseSoukformatrc(text, 'css', '/p/.soukformatrc', 'a.css');
    assert.equal(layers.length, 1);
    assert.equal(layers[0].values.indent_size, 8);
    assert.equal(warnings.length, 1);
  });

  it('a glob with nothing to match ("/") keeps the existing "non-empty glob" warning', () => {
    const { layers, warnings } = parseSoukformatrc(withOverride('/'), 'css', '/p/.soukformatrc', 'a.css');
    assert.equal(layers.length, 1);
    assert.ok(warnings.some((w) => /files must be a non-empty glob/.test(w.message)));
  });

  it('reaches the caller of readSoukformatrcLayers (so Show Effective Configuration lists it)', () => {
    const root = mkdtempSync(join(tmpdir(), 'souk-glob-'));
    try {
      writeFileSync(join(root, SOUKFORMATRC_FILENAME), withOverride(overCap));
      const file = join(root, 'a.css');
      writeFileSync(file, '.x{}');
      clearSoukformatrcCache();
      const result = readSoukformatrcLayers(file, 'css', root);
      assert.ok(result.warnings.some((w) => /cannot be evaluated/.test(w.message)));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// LOW-07. fs is counted by patching the real module object for the duration of
// one call: src/config/soukformatrc.ts reads statSync / readFileSync through it.
describe('config/soukformatrc : LOW-07 bounded read (size cap, one stat per level, memo)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'souk-low07-'));
    clearSoukformatrcCache();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    clearSoukformatrcCache();
  });

  interface FsCounts {
    readonly stat: number;
    readonly read: number;
  }

  function counted<T>(run: () => T): { value: T; counts: FsCounts } {
    const realFs = require('node:fs') as Record<string, (...args: unknown[]) => unknown>;
    const originalStat = realFs.statSync;
    const originalRead = realFs.readFileSync;
    let stat = 0;
    let read = 0;
    realFs.statSync = (...args: unknown[]) => {
      stat += 1;
      return originalStat(...args);
    };
    realFs.readFileSync = (...args: unknown[]) => {
      read += 1;
      return originalRead(...args);
    };
    try {
      return { value: run(), counts: { stat, read } };
    } finally {
      realFs.statSync = originalStat;
      realFs.readFileSync = originalRead;
    }
  }

  const CONFIG = '{ "css": { "indent": 6 } }';
  const ONE_HOUR_MS = 3_600_000;

  /** A file `depth` directories below the workspace root, and the root config. */
  function deepFile(depth: number, config: string, settled: boolean): string {
    const rc = join(root, SOUKFORMATRC_FILENAME);
    writeFileSync(rc, config);
    if (settled) {
      backdate(rc, ONE_HOUR_MS);
    }
    let dir = root;
    for (let level = 1; level <= depth; level += 1) {
      dir = join(dir, `d${level}`);
    }
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'a.css');
    writeFileSync(file, '.x{}');
    return file;
  }

  /** Set a file's mtime to `agoMs` before now, so it is "settled". */
  function backdate(path: string, agoMs: number): void {
    const when = new Date(Date.now() - agoMs);
    utimesSync(path, when, when);
  }

  it('a config over the size cap yields no layer and a warning, and is never read', () => {
    const rc = join(root, SOUKFORMATRC_FILENAME);
    writeFileSync(rc, CONFIG + ' '.repeat(MAX_SOUKFORMATRC_BYTES + 1 - CONFIG.length));
    assert.equal(statSync(rc).size, MAX_SOUKFORMATRC_BYTES + 1);
    const file = join(root, 'a.css');
    writeFileSync(file, '.x{}');

    const { value, counts } = counted(() => readSoukformatrcLayers(file, 'css', root));
    assert.equal(value.path, rc);
    assert.deepEqual(value.layers, []);
    assert.equal(value.warnings.length, 1);
    assert.match(value.warnings[0].message, /file too large \(1048577 bytes; the limit is 1048576\)/);
    assert.equal(counts.read, 0, 'an oversized file must not be read');
  });

  it('a config exactly at the cap is still read and applied', () => {
    const rc = join(root, SOUKFORMATRC_FILENAME);
    writeFileSync(rc, CONFIG + ' '.repeat(MAX_SOUKFORMATRC_BYTES - CONFIG.length));
    assert.equal(statSync(rc).size, MAX_SOUKFORMATRC_BYTES);
    const file = join(root, 'a.css');
    writeFileSync(file, '.x{}');

    const result = readSoukformatrcLayers(file, 'css', root);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.layers[0].values.indent_size, 6);
  });

  it('one format 10 directories deep: ONE stat per directory level, the cap adds none', () => {
    const file = deepFile(10, CONFIG, false);
    const { value, counts } = counted(() => readSoukformatrcLayers(file, 'css', root));
    assert.equal(value.layers[0].values.indent_size, 6);
    // 10 sub-directories + the workspace root = 11 levels; the walk stats each once
    // and the size check reuses the winning stat. Before: 11 stat + 1 read as well;
    // a naive cap would have made it 12.
    assert.equal(counts.stat, 11);
    assert.equal(counts.read, 1);
  });

  it('a settled config is read ONCE, then served from memory (stat per level only)', () => {
    const file = deepFile(10, CONFIG, true);
    const runs = [1, 2, 3].map(() => counted(() => readSoukformatrcLayers(file, 'css', root)));

    assert.deepEqual(
      runs.map((r) => r.counts.read),
      [1, 0, 0],
      'read + parse once, never again while the file is unchanged'
    );
    assert.deepEqual(
      runs.map((r) => r.counts.stat),
      [11, 11, 11],
      'the walk still looks for a nearer config on every format'
    );
    assert.deepEqual(runs[1].value, runs[0].value);
    assert.deepEqual(runs[2].value, runs[0].value);
  });

  it('a changed file is re-read (different size)', () => {
    const file = deepFile(2, CONFIG, true);
    assert.equal(readSoukformatrcLayers(file, 'css', root).layers[0].values.indent_size, 6);

    const rc = join(root, SOUKFORMATRC_FILENAME);
    writeFileSync(rc, '{ "css": {   "indent": 4   } }');
    backdate(rc, ONE_HOUR_MS / 2);

    const { value, counts } = counted(() => readSoukformatrcLayers(file, 'css', root));
    assert.equal(value.layers[0].values.indent_size, 4);
    assert.equal(counts.read, 1);
  });

  it('a changed file is re-read (same size, different mtime)', () => {
    const file = deepFile(2, '{ "css": { "indent": 6 } }', true);
    assert.equal(readSoukformatrcLayers(file, 'css', root).layers[0].values.indent_size, 6);

    const rc = join(root, SOUKFORMATRC_FILENAME);
    writeFileSync(rc, '{ "css": { "indent": 8 } }'); // same length
    backdate(rc, ONE_HOUR_MS / 2);

    const { value, counts } = counted(() => readSoukformatrcLayers(file, 'css', root));
    assert.equal(value.layers[0].values.indent_size, 8);
    assert.equal(counts.read, 1);
  });

  it('a file written moments ago is never memoised, even if its mtime does not move', () => {
    // Two writes inside one timestamp tick can leave (mtime, size) identical.
    // Forge exactly that: same length, same mtime, different content.
    const file = deepFile(1, '{ "css": { "indent": 6 } }', false);
    const rc = join(root, SOUKFORMATRC_FILENAME);
    const stamp = new Date(); // a whole-millisecond stamp, so it can be re-applied exactly
    utimesSync(rc, stamp, stamp);
    assert.equal(statSync(rc).mtimeMs, stamp.getTime(), 'the forged stamp must round-trip');
    assert.equal(readSoukformatrcLayers(file, 'css', root).layers[0].values.indent_size, 6);

    writeFileSync(rc, '{ "css": { "indent": 8 } }');
    utimesSync(rc, stamp, stamp);
    assert.equal(statSync(rc).mtimeMs, stamp.getTime());
    assert.equal(statSync(rc).size, CONFIG.length, 'same size, same mtime: only the racy guard helps');

    const { value, counts } = counted(() => readSoukformatrcLayers(file, 'css', root));
    assert.equal(value.layers[0].values.indent_size, 8, 'a stale memo would still say 6');
    assert.equal(counts.read, 1);
  });

  it('the memo holds the parsed FILE, never a per-document verdict', () => {
    const rc = join(root, SOUKFORMATRC_FILENAME);
    writeFileSync(rc, withOverride('src/**/*.css'));
    backdate(rc, ONE_HOUR_MS);
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'lib'), { recursive: true });
    const inSrc = join(root, 'src', 'a.css');
    const inLib = join(root, 'lib', 'b.css');
    writeFileSync(inSrc, '.x{}');
    writeFileSync(inLib, '.x{}');

    const first = counted(() => readSoukformatrcLayers(inSrc, 'css', root));
    const second = counted(() => readSoukformatrcLayers(inLib, 'css', root));
    const third = counted(() => readSoukformatrcLayers(inSrc, 'javascript', root));

    assert.equal(first.value.layers.length, 2, 'src/a.css: section + override');
    assert.equal(second.value.layers.length, 1, 'lib/b.css: section only, from the same memo');
    assert.equal(second.counts.read, 0);
    // Another language, same memo: no [css] section, but the override still matches.
    assert.equal(third.value.layers.length, 1);
    assert.doesNotMatch(third.value.layers[0].source, /\[css\]/);
    assert.equal(third.counts.read, 0);
  });

  it('a settled MALFORMED config keeps warning on every format without being re-read', () => {
    const file = deepFile(1, '{ "css": { "indent": }', true);
    const first = counted(() => readSoukformatrcLayers(file, 'css', root));
    const second = counted(() => readSoukformatrcLayers(file, 'css', root));

    for (const run of [first, second]) {
      assert.deepEqual(run.value.layers, []);
      assert.ok(run.value.warnings.some((w) => /malformed/.test(w.message)));
    }
    assert.equal(first.counts.read, 1);
    assert.equal(second.counts.read, 0);
  });

  it('the memo is bounded: many distinct configs stay correct after eviction', () => {
    const files: string[] = [];
    for (let i = 0; i < 40; i += 1) {
      const dir = join(root, `ws${i}`);
      mkdirSync(dir, { recursive: true });
      const rc = join(dir, SOUKFORMATRC_FILENAME);
      writeFileSync(rc, `{ "css": { "indent": ${(i % 8) + 1} } }`);
      backdate(rc, ONE_HOUR_MS);
      const file = join(dir, 'a.css');
      writeFileSync(file, '.x{}');
      files.push(file);
    }
    for (let i = 0; i < 40; i += 1) {
      const result = readSoukformatrcLayers(files[i], 'css', join(root, `ws${i}`));
      assert.equal(result.layers[0].values.indent_size, (i % 8) + 1);
    }
    // The oldest entries were evicted: reading them again is correct, just a re-read.
    const again = counted(() => readSoukformatrcLayers(files[0], 'css', join(root, 'ws0')));
    assert.equal(again.value.layers[0].values.indent_size, 1);
  });
});
