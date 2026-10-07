// .soukformatrc: the overrides[].files globs now use the SAME linear gitignore
// matcher as .soukformatignore (LOW-04), a glob that cannot be evaluated is
// reported instead of guessed, and reading the file is bounded (LOW-07): a size
// cap, one stat per directory level, and a memo of the parsed file.
//
// The adversarial TIMING of the glob path lives in ignore/globLinear.test.ts.
import assert from 'node:assert/strict';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_SOUKFORMATRC_BYTES,
  SOUKFORMATRC_FILENAME,
  clearSoukformatrcCache,
  parseSoukformatrc,
  readSoukformatrcLayers,
  setSoukformatrcClock
} from '../../../src/config/soukformatrc';
import { resolveOptions } from '../../../src/config/resolver';

const ONE_HOUR_MS = 3_600_000;

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

// LOW-07 and C1. fs is counted by patching the real module object for the duration
// of one call: src/config/soukformatrc.ts reads statSync / readFileSync through it.
//
// The memo is keyed by the file's whole IDENTITY (size, mtime and ctime in
// nanoseconds, inode, device) and only trusted when freshness can be PROVED: the
// rule is absolute, a stale config is never served. Files are made "settled" by
// moving the clock the freshness window reads (setSoukformatrcClock), not by
// waiting; a test that needs the real clock restores it.
describe('config/soukformatrc : LOW-07 bounded read (size cap, one stat per level, memo)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'souk-low07-'));
    clearSoukformatrcCache();
    setSoukformatrcClock(() => Date.now() + ONE_HOUR_MS);
  });
  afterEach(() => {
    setSoukformatrcClock();
    rmSync(root, { recursive: true, force: true });
    clearSoukformatrcCache();
  });

  interface FsCounts {
    readonly stat: number;
    readonly read: number;
  }

  function counted<T>(
    run: () => T,
    override?: { statSync?: (original: (...args: unknown[]) => unknown, args: unknown[]) => unknown }
  ): { value: T; counts: FsCounts } {
    const realFs = require('node:fs') as Record<string, (...args: unknown[]) => unknown>;
    const originalStat = realFs.statSync;
    const originalRead = realFs.readFileSync;
    let stat = 0;
    let read = 0;
    realFs.statSync = (...args: unknown[]) => {
      stat += 1;
      return override?.statSync !== undefined
        ? override.statSync(originalStat, args)
        : originalStat(...args);
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

  /** A timestamp with a fractional second (never a whole one), `n` seconds apart. */
  function stamp(n: number): Date {
    const base = Math.floor(Date.now() / 1000) * 1000 - 86_400_000;
    return new Date(base + n * 1000 + 123);
  }

  /** Let real time pass, so two writes cannot share a file-system timestamp tick. */
  function pause(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  }

  function indentOf(file: string): number | undefined {
    return readSoukformatrcLayers(file, 'css', root).layers[0]?.values.indent_size as
      | number
      | undefined;
  }

  /** A file `depth` directories below the workspace root, and the root config. */
  function deepFile(depth: number, config: string): string {
    writeFileSync(join(root, SOUKFORMATRC_FILENAME), config);
    let dir = root;
    for (let level = 1; level <= depth; level += 1) {
      dir = join(dir, `d${level}`);
    }
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'a.css');
    writeFileSync(file, '.x{}');
    return file;
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
    const file = deepFile(10, CONFIG);
    const { value, counts } = counted(() => readSoukformatrcLayers(file, 'css', root));
    assert.equal(value.layers[0].values.indent_size, 6);
    // 10 sub-directories + the workspace root = 11 levels; the walk stats each once
    // and the size check reuses the winning stat. Before: 11 stat + 1 read as well;
    // a naive cap would have made it 12.
    assert.equal(counts.stat, 11);
    assert.equal(counts.read, 1);
  });

  it('a settled config is read ONCE, then served from memory (stat per level only)', () => {
    const file = deepFile(10, CONFIG);
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
    const file = deepFile(2, CONFIG);
    assert.equal(indentOf(file), 6);

    pause(40);
    writeFileSync(join(root, SOUKFORMATRC_FILENAME), '{ "css": {   "indent": 4   } }');

    const { value, counts } = counted(() => readSoukformatrcLayers(file, 'css', root));
    assert.equal(value.layers[0].values.indent_size, 4);
    assert.equal(counts.read, 1);
  });

  it('a file modified "just now" is never memoised, however its timestamps look', () => {
    const file = deepFile(1, CONFIG);
    const rc = join(root, SOUKFORMATRC_FILENAME);
    const stats = statSync(rc, { bigint: true });
    // The local clock reads 100 ms after the file's last change: inside the window.
    const justAfter = Number(stats.ctimeNs / 1_000_000n) + 100;
    setSoukformatrcClock(() => justAfter);

    const first = counted(() => readSoukformatrcLayers(file, 'css', root));
    const second = counted(() => readSoukformatrcLayers(file, 'css', root));
    assert.deepEqual([first.counts.read, second.counts.read], [1, 1], 'read every time');

    // One hour later the same unchanged file is settled, and is memoised.
    setSoukformatrcClock(() => justAfter + ONE_HOUR_MS);
    const third = counted(() => readSoukformatrcLayers(file, 'css', root));
    const fourth = counted(() => readSoukformatrcLayers(file, 'css', root));
    assert.deepEqual([third.counts.read, fourth.counts.read], [1, 0]);
  });

  it('never serves a stale config across 40 quick same-size rewrites on the REAL clock', () => {
    setSoukformatrcClock();
    const file = deepFile(1, CONFIG);
    const rc = join(root, SOUKFORMATRC_FILENAME);
    for (let i = 0; i < 40; i += 1) {
      const indent = (i % 8) + 1; // always one digit: the size never changes
      writeFileSync(rc, `{ "css": { "indent": ${indent} } }`);
      assert.equal(indentOf(file), indent, `rewrite ${i}`);
    }
  });

  it('the memo holds the parsed FILE, never a per-document verdict', () => {
    const rc = join(root, SOUKFORMATRC_FILENAME);
    writeFileSync(rc, withOverride('src/**/*.css'));
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
    const file = deepFile(1, '{ "css": { "indent": }');
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
      writeFileSync(join(dir, SOUKFORMATRC_FILENAME), `{ "css": { "indent": ${(i % 8) + 1} } }`);
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

  // C1 (audit etape 10): the exact cases that served a STALE config when the key
  // was (path, size, mtimeMs) and freshness was judged by the local clock.
  describe('C1 never serves a stale config', () => {
    const SAME_SIZE_A = '{ "css": { "indent": 2 } }';
    const SAME_SIZE_B = '{ "css": { "indent": 7 } }';

    it('C3 a same-size rewrite whose mtime is restored (cp -p, rsync -t, touch -r)', () => {
      const file = deepFile(1, SAME_SIZE_A);
      const rc = join(root, SOUKFORMATRC_FILENAME);
      utimesSync(rc, stamp(1), stamp(1));
      assert.equal(indentOf(file), 2);
      assert.equal(counted(() => indentOf(file)).counts.read, 0, 'memoised: the test is sound');

      pause(40);
      writeFileSync(rc, SAME_SIZE_B);
      utimesSync(rc, stamp(1), stamp(1)); // same size AND same mtime as before
      assert.equal(indentOf(file), 7, 'the ctime moved: the memo must not be served');
    });

    it('C4 the file is deleted and recreated with the same size and the same mtime (mv)', () => {
      const file = deepFile(1, SAME_SIZE_A);
      const rc = join(root, SOUKFORMATRC_FILENAME);
      utimesSync(rc, stamp(2), stamp(2));
      assert.equal(indentOf(file), 2);

      pause(40);
      rmSync(rc);
      writeFileSync(rc, SAME_SIZE_B);
      utimesSync(rc, stamp(2), stamp(2));
      assert.equal(indentOf(file), 7, 'a new file (inode or ctime differs) is read afresh');
    });

    it('C5 coarse timestamps (whole seconds, a lagging server clock) are never memoised', () => {
      const file = deepFile(1, SAME_SIZE_A);
      const rc = join(root, SOUKFORMATRC_FILENAME);
      const wholeSecond = new Date(Math.floor(Date.now() / 1000) * 1000 - 5000);
      utimesSync(rc, wholeSecond, wholeSecond);

      const first = counted(() => readSoukformatrcLayers(file, 'css', root));
      const second = counted(() => readSoukformatrcLayers(file, 'css', root));
      assert.deepEqual([first.counts.read, second.counts.read], [1, 1], 'freshness cannot be proved');

      writeFileSync(rc, SAME_SIZE_B);
      utimesSync(rc, wholeSecond, wholeSecond); // same size, same whole-second mtime
      assert.equal(indentOf(file), 7);
    });

    it('C8 a same-size file copied over the config, carrying the same mtime', () => {
      const file = deepFile(1, SAME_SIZE_A);
      const rc = join(root, SOUKFORMATRC_FILENAME);
      utimesSync(rc, stamp(3), stamp(3));
      assert.equal(indentOf(file), 2);

      const source = join(root, 'replacement.json');
      writeFileSync(source, SAME_SIZE_B);
      utimesSync(source, stamp(3), stamp(3));
      pause(40);
      copyFileSync(source, rc);
      utimesSync(rc, stamp(3), stamp(3));
      assert.equal(indentOf(file), 7);
    });

    it('a file system that reports no inode is never memoised', () => {
      const file = deepFile(1, SAME_SIZE_A);
      const withoutInode = {
        statSync: (original: (...args: unknown[]) => unknown, args: unknown[]): unknown => {
          const stats = original(...args) as { ino?: bigint } | undefined;
          return stats === undefined
            ? stats
            : Object.assign(Object.create(Object.getPrototypeOf(stats) as object), stats, { ino: 0n });
        }
      };
      const first = counted(() => readSoukformatrcLayers(file, 'css', root), withoutInode);
      const second = counted(() => readSoukformatrcLayers(file, 'css', root), withoutInode);
      assert.deepEqual([first.counts.read, second.counts.read], [1, 1]);
      assert.equal(first.value.layers[0].values.indent_size, 2);
    });
  });
});

// G3 (audit etape 10): a UTF-8 byte order mark made JSONC report an invalid symbol
// at offset 0, which discarded the WHOLE file.
describe('config/soukformatrc : G3 a leading byte order mark', () => {
  const BOM = String.fromCharCode(0xfeff);

  it('parseSoukformatrc reads a config that starts with a BOM', () => {
    const { layers, warnings } = parseSoukformatrc(
      `${BOM}{ "css": { "indent": 4 } }`,
      'css',
      '/p/.soukformatrc'
    );
    assert.deepEqual(warnings, []);
    assert.equal(layers[0].values.indent_size, 4);
  });

  it('readSoukformatrcLayers reads a BOM file from disk', () => {
    const root = mkdtempSync(join(tmpdir(), 'souk-bom-'));
    try {
      writeFileSync(join(root, SOUKFORMATRC_FILENAME), `${BOM}{ "css": { "indent": 6 } }`);
      const file = join(root, 'a.css');
      writeFileSync(file, '.x{}');
      clearSoukformatrcCache();
      const result = readSoukformatrcLayers(file, 'css', root);
      assert.deepEqual(result.warnings, []);
      assert.equal(result.layers[0].values.indent_size, 6);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// P1 (audit etape 10): each glob was linear alone, but nothing bounded the TOTAL:
// 1000 overrides of long globs against a 4095-character path took 60 s. One work
// budget now covers the whole lookup. The timing of the reviewer's exact case is in
// ignore/globLinear.test.ts; here is the behaviour.
describe('config/soukformatrc : P1 one work budget for all the overrides of a lookup', () => {
  /** Reviewer's multiX(k): "**" + "/*" + k "a" + "c", repeated while it fits in 1024 characters. */
  function multiX(k: number): string {
    const unit = `**/*${'a'.repeat(k)}c`;
    let glob = '';
    while (glob.length + unit.length <= 1024) {
      glob += unit;
    }
    return glob;
  }
  const deepRel = Array.from({ length: 16 }, () => `${'a'.repeat(254)}c`).join('/');

  it('an adversarial set of overrides is cut off with a warning, not evaluated for a minute', () => {
    const text = JSON.stringify({
      css: { indent: 4 },
      overrides: Array.from({ length: 1000 }, () => ({ files: multiX(60), options: { indent: 8 } }))
    });
    const started = Date.now();
    const { layers, warnings } = parseSoukformatrc(text, 'css', '/p/.soukformatrc', deepRel);
    assert.ok(Date.now() - started < 5000, 'finished');
    // The first overrides match before the budget runs out and apply; the other
    // ~1000 are skipped, not evaluated.
    assert.ok(layers.length >= 1 && layers.length < 50, `layers: ${layers.length}`);
    const message = warnings.map((w) => w.message).join('\n');
    assert.match(message, /overrides\[\d+\]\.files/);
    assert.match(message, /needs more than \d+ steps/);
    assert.match(message, /are skipped/);
    assert.equal(warnings.length, 1, 'one warning, not one per override');
  });

  it('an ordinary config never comes near the budget', () => {
    const text = JSON.stringify({
      overrides: Array.from({ length: 300 }, (_, i) => ({
        files: `src/module${i}/**/*.css`,
        options: { indent: 8 }
      }))
    });
    const { layers, warnings } = parseSoukformatrc(text, 'css', '/p/.soukformatrc', 'src/module7/a/b.css');
    assert.deepEqual(warnings, []);
    assert.equal(layers.length, 1);
  });

  it('overrides matched BEFORE the budget ran out still apply', () => {
    const text = JSON.stringify({
      overrides: [
        { files: '*.css', options: { indent: 8 } },
        ...Array.from({ length: 1000 }, () => ({ files: multiX(60), options: { indent: 2 } }))
      ]
    });
    const { layers, warnings } = parseSoukformatrc(text, 'css', '/p/.soukformatrc', `${deepRel}.css`);
    assert.ok(layers.length < 50, `layers: ${layers.length}`);
    assert.equal(layers[0].values.indent_size, 8, 'the first override applied before the cut-off');
    assert.ok(warnings.some((w) => /are skipped/.test(w.message)));
  });
});

// G4: case. Exact on EVERY OS, like Prettier and EditorConfig (never the platform's).
describe('config/soukformatrc : G4 override globs are case-sensitive on every OS', () => {
  it('"*.CSS" does NOT apply to "a.css"', () => {
    assert.equal(overrideApplies('*.CSS', 'a.css'), false);
    assert.equal(overrideApplies('*.css', 'a.css'), true);
  });

  it('"*.css" does NOT apply to "A.CSS", and "A.CSS" applies to itself', () => {
    assert.equal(overrideApplies('*.css', 'A.CSS'), false);
    assert.equal(overrideApplies('A.CSS', 'A.CSS'), true);
  });
});

// G1: character classes in an override glob.
describe('config/soukformatrc : G1 character classes in overrides[].files', () => {
  it('"[Ll]egacy/**" reaches legacy/ and Legacy/ (it used to be skipped SILENTLY)', () => {
    const { layers, warnings } = parseSoukformatrc(
      withOverride('[Ll]egacy/**'),
      'css',
      '/p/.soukformatrc',
      'legacy/a.css'
    );
    assert.equal(layers.length, 2, 'the override applies');
    assert.deepEqual(warnings, []);
    assert.equal(overrideApplies('[Ll]egacy/**', 'Legacy/a.css'), true);
    assert.equal(overrideApplies('[Ll]egacy/**', 'modern/a.css'), false);
  });
});
