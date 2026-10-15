// The .soukformatignore walk goes up to the ROOT of the disk, like git and like
// v0.4.2 (v0.5.0 briefly bounded it to the workspace folder).
//
// Reading an exclusion file can only make Tidy format LESS, so a .soukformatignore
// above the opened folder (a parent directory, a shared checkout root, the user's
// home) is safe to honour, and a document outside every workspace folder is checked
// too. The nearest file wins. The gates around the walk (Workspace Trust, the
// opt-out setting, the file scheme) are covered by ignoreGate.test.ts; the 1 MiB cap
// and the fail-closed reason are covered here and in soukformatignoreFailClosed.test.ts.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_SOUKFORMATIGNORE_BYTES,
  SOUKFORMATIGNORE_FILENAME,
  findSoukformatignore,
  resolveIgnore
} from '../../../src/ignore/soukformatignore';

// The real, mutable 'node:fs' module object (an ES namespace import is a frozen
// copy, and the reader under test calls the live functions).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fsModule = require('node:fs') as Record<string, unknown>;

/** Count the statSync calls made while `body` runs; always restores the original. */
function countStats(body: () => void): number {
  const original = fsModule.statSync as (...args: unknown[]) => unknown;
  let count = 0;
  fsModule.statSync = (...args: unknown[]): unknown => {
    count += 1;
    return original(...args);
  };
  try {
    body();
  } finally {
    fsModule.statSync = original;
  }
  return count;
}

describe('ignore/soukformatignore : the walk goes up to the root of the disk', () => {
  let root: string; // a parent of the "workspace"
  let ws: string; // the opened folder
  let file: string; // root/ws/src/a.css

  function ignoreIn(dir: string, body = '*.css\n'): string {
    const target = join(dir, SOUKFORMATIGNORE_FILENAME);
    writeFileSync(target, body);
    return target;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tidy-ignore-walk-'));
    ws = join(root, 'ws');
    mkdirSync(join(ws, 'src'), { recursive: true });
    file = join(ws, 'src', 'a.css');
    writeFileSync(file, '');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe('above the opened folder: APPLIES', () => {
    it('an ignore file in the parent of the opened folder is found and applied', () => {
      const above = ignoreIn(root);
      assert.equal(findSoukformatignore(file), above);
      const lookup = resolveIgnore(file);
      assert.equal(lookup.path, above);
      assert.equal(lookup.ignored, true);
    });

    it('a pattern in a file above is evaluated relative to THAT file', () => {
      ignoreIn(root, 'ws/src/\n');
      assert.equal(resolveIgnore(file).ignored, true);
      writeFileSync(join(root, SOUKFORMATIGNORE_FILENAME), 'other/\n');
      assert.equal(resolveIgnore(file).ignored, false);
    });

    it('a file several levels up (grandparent) is found too', () => {
      const deep = join(ws, 'a', 'b', 'c');
      mkdirSync(deep, { recursive: true });
      const deepFile = join(deep, 'x.css');
      writeFileSync(deepFile, '');
      const above = ignoreIn(root);
      assert.equal(findSoukformatignore(deepFile), above);
    });

    it('a file more than 64 folders deep still finds the ignore file at the top', () => {
      // 0.5.0 stopped after 64 levels; the walk is lexical and always ends at the root.
      let deep = ws;
      for (let level = 0; level < 70; level += 1) {
        deep = join(deep, 'd');
      }
      mkdirSync(deep, { recursive: true });
      const deepFile = join(deep, 'x.css');
      writeFileSync(deepFile, '');
      const above = ignoreIn(root);
      assert.equal(findSoukformatignore(deepFile), above);
      assert.equal(resolveIgnore(deepFile).ignored, true);
    });

    it('a directory named .soukformatignore is not a file: the walk goes past it', () => {
      mkdirSync(join(ws, 'src', SOUKFORMATIGNORE_FILENAME));
      const above = ignoreIn(root);
      assert.equal(findSoukformatignore(file), above);
    });

    it('an oversized ignore file above fails closed, with the reason', () => {
      writeFileSync(join(root, SOUKFORMATIGNORE_FILENAME), Buffer.alloc(MAX_SOUKFORMATIGNORE_BYTES + 1, 0x23));
      const lookup = resolveIgnore(file);
      assert.equal(lookup.ignored, true);
      assert.ok(lookup.failClosed?.detail.includes('too large to read'));
    });
  });

  describe('a document in no workspace folder is checked', () => {
    it('a file in a folder of its own, with its own ignore file, is governed by it', () => {
      const other = join(root, 'other');
      mkdirSync(other);
      const own = ignoreIn(other);
      const otherFile = join(other, 'a.css');
      writeFileSync(otherFile, '');
      assert.equal(findSoukformatignore(otherFile), own);
      assert.equal(resolveIgnore(otherFile).ignored, true);
    });

    it('a sibling folder does not lend its ignore file (only ancestors count)', () => {
      const sibling = join(root, 'sibling');
      mkdirSync(sibling);
      const lent = ignoreIn(sibling);
      assert.notEqual(findSoukformatignore(file), lent);
      assert.notEqual(resolveIgnore(file).path, lent);
    });

    it('a document above the opened folder is governed by the file beside it', () => {
      const beside = ignoreIn(root);
      const top = join(root, 'top.css');
      writeFileSync(top, '');
      assert.equal(findSoukformatignore(top), beside);
    });
  });

  describe('the nearest ignore file wins', () => {
    it('one at the opened folder shadows one above it', () => {
      ignoreIn(root, '*.css\n');
      const inside = ignoreIn(ws, 'dist/\n');
      const lookup = resolveIgnore(file);
      assert.equal(lookup.path, inside);
      assert.equal(lookup.ignored, false, 'the nearer file decides alone, no cascade');
    });

    it('one nearer the file shadows both', () => {
      ignoreIn(root, '*.css\n');
      ignoreIn(ws, '*.css\n');
      const nearest = ignoreIn(join(ws, 'src'), 'dist/\n');
      const lookup = resolveIgnore(file);
      assert.equal(lookup.path, nearest);
      assert.equal(lookup.ignored, false);
    });

    it('a file directly beside the ignore file is governed by it', () => {
      const inside = ignoreIn(ws);
      const top = join(ws, 'top.css');
      writeFileSync(top, '');
      assert.equal(resolveIgnore(top).path, inside);
    });
  });

  describe('fail-safe and cost', () => {
    it('no ignore file between the file and the root of the disk: not ignored', () => {
      // An ignore file that the machine itself keeps above the temp folder would
      // make this test meaningless; that is a configuration this suite cannot own.
      const lookup = resolveIgnore(file);
      if (lookup.path === undefined) {
        assert.deepEqual(lookup, { ignored: false });
      }
    });

    it('a blank or non-string start is not searched, not even one stat', () => {
      ignoreIn(root);
      assert.equal(findSoukformatignore(''), undefined);
      assert.equal(findSoukformatignore('   '), undefined);
      assert.equal(countStats(() => findSoukformatignore('')), 0);
      assert.deepEqual(resolveIgnore(42 as unknown as string), { ignored: false });
    });

    it('one stat per level, and the walk stops at the first ignore file found', () => {
      const deep = join(ws, 'a', 'b', 'c');
      mkdirSync(deep, { recursive: true });
      const deepFile = join(deep, 'x.css');
      writeFileSync(deepFile, '');
      ignoreIn(root);
      // c, b, a, ws, root: five levels, the last one finds the file.
      assert.equal(countStats(() => resolveIgnore(deepFile)), 5);
    });
  });
});
