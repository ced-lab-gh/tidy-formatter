// F3: the parsed .soukformatignore is memoised by the file's identity (size, mtime
// and ctime in nanoseconds, inode, device), with the same trust rule as
// .soukformatrc (src/config/fileIdentity.ts): an unchanged file is not read again,
// a rewrite of the same size is, and so is a file that cannot be proved settled
// (modified less than 2 s ago, whole-second timestamps, no inode). Only the
// patterns are kept, never a verdict. Files are made "settled" by moving the clock
// the freshness window reads, not by waiting.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SOUKFORMATIGNORE_FILENAME,
  clearSoukformatignoreCache,
  resolveIgnore,
  setSoukformatignoreClock
} from '../../../src/ignore/soukformatignore';

const ONE_HOUR_MS = 3_600_000;

// The real, mutable 'node:fs' module object (the reader calls the live functions).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fsModule = require('node:fs') as Record<string, unknown>;

/** Count the file reads made while `body` runs; always restores the original. */
function countReads<T>(body: () => T): { value: T; reads: number } {
  const original = fsModule.readFileSync as (...args: unknown[]) => unknown;
  let reads = 0;
  fsModule.readFileSync = (...args: unknown[]): unknown => {
    reads += 1;
    return original(...args);
  };
  try {
    return { value: body(), reads };
  } finally {
    fsModule.readFileSync = original;
  }
}

/** Let the file system clock move on, so a rewrite cannot share the previous timestamps. */
function tick(): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
}

describe('ignore/soukformatignore : F3 the parsed file is memoised by identity', () => {
  let root: string;
  let file: string;
  let ignoreFile: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tidy-ignore-cache-'));
    file = join(root, 'a.css');
    ignoreFile = join(root, SOUKFORMATIGNORE_FILENAME);
    writeFileSync(file, '');
    writeFileSync(ignoreFile, '*.css\n');
    clearSoukformatignoreCache();
    setSoukformatignoreClock(() => Date.now() + ONE_HOUR_MS);
  });

  afterEach(() => {
    setSoukformatignoreClock();
    clearSoukformatignoreCache();
    rmSync(root, { recursive: true, force: true });
  });

  it('a second resolveIgnore on an unchanged file does not read it again', () => {
    const first = countReads(() => resolveIgnore(file));
    const second = countReads(() => resolveIgnore(file));
    assert.equal(first.reads, 1);
    assert.equal(second.reads, 0);
    assert.deepEqual(second.value, first.value);
    assert.equal(second.value.ignored, true);
  });

  it('keeps the patterns, not the verdicts: another path gets its own answer', () => {
    const other = join(root, 'b.less');
    writeFileSync(other, '');
    const css = countReads(() => resolveIgnore(file));
    const less = countReads(() => resolveIgnore(other));
    assert.equal(css.value.ignored, true);
    assert.equal(less.value.ignored, false);
    assert.equal(less.reads, 0, 'the second path is judged from the memoised patterns');
  });

  it('a rewrite of the same size is read again', () => {
    assert.equal(resolveIgnore(file).ignored, true);
    const sizeBefore = statSync(ignoreFile).size;
    tick();
    writeFileSync(ignoreFile, '*.sss\n'); // same 6 bytes, a different rule.
    assert.equal(statSync(ignoreFile).size, sizeBefore);
    const after = countReads(() => resolveIgnore(file));
    assert.equal(after.reads, 1);
    assert.equal(after.value.ignored, false, 'never the stale verdict');
  });

  it('a file modified less than 2 s ago is read again every time', () => {
    setSoukformatignoreClock(); // the real clock: the file was just written.
    const first = countReads(() => resolveIgnore(file));
    const second = countReads(() => resolveIgnore(file));
    assert.equal(first.reads, 1);
    assert.equal(second.reads, 1);
    assert.equal(second.value.ignored, true);
  });

  it('a file with a whole-second timestamp is read again every time', () => {
    const whole = new Date(Math.floor(Date.now() / 1000) * 1000);
    utimesSync(ignoreFile, whole, whole);
    resolveIgnore(file);
    assert.equal(countReads(() => resolveIgnore(file)).reads, 1);
  });

  it('a file system without inode numbers is read again every time', () => {
    const original = fsModule.statSync as (...args: unknown[]) => unknown;
    fsModule.statSync = (...args: unknown[]): unknown => {
      const stats = original(...args) as
        | {
            isFile(): boolean;
            size: bigint;
            mtimeNs: bigint;
            ctimeNs: bigint;
            dev: bigint;
          }
        | undefined;
      if (stats === undefined) {
        return stats;
      }
      return {
        isFile: () => stats.isFile(),
        size: stats.size,
        mtimeNs: stats.mtimeNs,
        ctimeNs: stats.ctimeNs,
        dev: stats.dev,
        ino: 0n
      };
    };
    try {
      resolveIgnore(file);
      assert.equal(countReads(() => resolveIgnore(file)).reads, 1);
    } finally {
      fsModule.statSync = original;
    }
  });

  it('forgets the oldest entry once 32 files are held', () => {
    const documents: string[] = [];
    for (let index = 0; index < 33; index += 1) {
      const dir = join(root, `d${index}`);
      mkdirSync(dir);
      writeFileSync(join(dir, SOUKFORMATIGNORE_FILENAME), '*.css\n');
      documents.push(join(dir, 'a.css'));
    }
    for (const document of documents) {
      resolveIgnore(document);
    }
    assert.equal(countReads(() => resolveIgnore(documents[32])).reads, 0, 'newest is held');
    assert.equal(countReads(() => resolveIgnore(documents[0])).reads, 1, 'oldest was evicted');
  });

  it('bounds memory by source bytes: two large ignore files are not held together', () => {
    // 600 KiB each: one fits under the 1 MiB byte bound, both do not.
    const big = '*.css\n' + '# padding line for the byte bound\n'.repeat(18_000);
    const documents = ['b1', 'b2'].map((name) => {
      const dir = join(root, name);
      mkdirSync(dir);
      writeFileSync(join(dir, SOUKFORMATIGNORE_FILENAME), big);
      return join(dir, 'a.css');
    });
    resolveIgnore(documents[0]);
    resolveIgnore(documents[1]);
    assert.equal(countReads(() => resolveIgnore(documents[1])).reads, 0, 'the newest is held');
    assert.equal(countReads(() => resolveIgnore(documents[0])).reads, 1, 'the older was evicted');
  });

  it('an ignore file that disappears is not served from the memo', () => {
    resolveIgnore(file);
    rmSync(ignoreFile);
    assert.notEqual(resolveIgnore(file).path, ignoreFile);
  });
});
