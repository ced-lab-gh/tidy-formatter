// The .soukformatignore walk is BOUNDED to the workspace folder.
//
// Decided for v0.5.0, aligning it with .soukformatrc and .prettierrc (bounded in
// v0.4.0): a .soukformatignore ABOVE the workspace folder (a parent directory, a
// shared checkout root, the user's home) is a file the user never opened, and it
// must not silently change what Tidy skips. The bound is the shared isWithinDir
// containment of config/prettierrc, never string equality, so the cases that make
// an equality test fail OPEN are pinned here too: a trailing separator, a '..'
// segment, mixed separators, a drive letter in the other case, a sibling folder
// that merely shares a name prefix, and a UNC share.
//
// Every test that says "not found" also pins that nothing above the bound was even
// searched (a stat count), so the bound cannot be met by luck.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
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

describe('ignore/soukformatignore : the walk stops at the workspace folder', () => {
  let root: string; // the "outside" world: a parent of the workspace
  let ws: string; // the workspace folder
  let file: string; // root/ws/src/a.css

  function ignoreIn(dir: string, body = '*.css\n'): string {
    const target = join(dir, SOUKFORMATIGNORE_FILENAME);
    writeFileSync(target, body);
    return target;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tidy-ignore-bound-'));
    ws = join(root, 'ws');
    mkdirSync(join(ws, 'src'), { recursive: true });
    file = join(ws, 'src', 'a.css');
    writeFileSync(file, '');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe('above the workspace folder: does NOT apply', () => {
    it('an ignore file in the parent of the workspace is not found, and the file is formatted', () => {
      ignoreIn(root);
      assert.equal(findSoukformatignore(file, ws), undefined);
      assert.deepEqual(resolveIgnore(file, ws), { ignored: false });
    });

    it('the same file WAS found before the bound existed (an omitted bound is the old walk)', () => {
      const above = ignoreIn(root);
      assert.equal(findSoukformatignore(file), above);
    });

    it('nothing above the workspace is even searched (exactly the levels inside it)', () => {
      ignoreIn(root);
      // src, then ws itself: two levels, two stats, and the walk stops.
      assert.equal(countStats(() => resolveIgnore(file, ws)), 2);
    });

    it('an oversized ignore file above the workspace does not fail closed either (it is never consulted)', () => {
      writeFileSync(join(root, SOUKFORMATIGNORE_FILENAME), Buffer.alloc(MAX_SOUKFORMATIGNORE_BYTES + 1, 0x23));
      assert.deepEqual(resolveIgnore(file, ws), { ignored: false });
    });

    it('an ignore file further up (grandparent) is not found either', () => {
      const nested = join(root, 'deeper');
      mkdirSync(join(nested, 'ws', 'src'), { recursive: true });
      ignoreIn(root);
      const nestedFile = join(nested, 'ws', 'src', 'a.css');
      writeFileSync(nestedFile, '');
      assert.equal(findSoukformatignore(nestedFile, join(nested, 'ws')), undefined);
    });
  });

  describe('inside the workspace folder: applies', () => {
    it('an ignore file AT the workspace folder applies (the bound is inclusive)', () => {
      const inside = ignoreIn(ws);
      const lookup = resolveIgnore(file, ws);
      assert.equal(lookup.path, inside);
      assert.equal(lookup.ignored, true);
    });

    it('an ignore file between the file and the workspace folder applies, and the nearest wins', () => {
      ignoreIn(ws, '*.css\n');
      const nearer = ignoreIn(join(ws, 'src'), 'dist/\n');
      const lookup = resolveIgnore(file, ws);
      assert.equal(lookup.path, nearer);
      assert.equal(lookup.ignored, false, 'the nearer file shadows the workspace-root one');
    });

    it('a file directly in the workspace folder is governed by the ignore file there', () => {
      const inside = ignoreIn(ws);
      const top = join(ws, 'top.css');
      writeFileSync(top, '');
      assert.equal(resolveIgnore(top, ws).path, inside);
    });

    it('an ignore file inside wins over one above, which stays out of it', () => {
      ignoreIn(root, '*.css\n');
      const inside = ignoreIn(ws, 'dist/\n');
      const lookup = resolveIgnore(file, ws);
      assert.equal(lookup.path, inside);
      assert.equal(lookup.ignored, false);
    });

    it('an oversized ignore file inside the workspace still fails closed, with the reason', () => {
      writeFileSync(join(ws, SOUKFORMATIGNORE_FILENAME), Buffer.alloc(MAX_SOUKFORMATIGNORE_BYTES + 1, 0x23));
      const lookup = resolveIgnore(file, ws);
      assert.equal(lookup.ignored, true);
      assert.ok(lookup.failClosed?.detail.includes('too large to read'));
    });
  });

  describe('the same bound however the workspace folder is written (fails closed, never open)', () => {
    /** For a stopDir spelling: above is invisible, inside is found. */
    function assertBoundedBy(stopDir: string): void {
      const above = join(root, SOUKFORMATIGNORE_FILENAME);
      writeFileSync(above, '*.css\n');
      assert.equal(findSoukformatignore(file, stopDir), undefined, `above must stay out: ${stopDir}`);
      const inside = ignoreIn(ws, 'dist/\n');
      assert.equal(findSoukformatignore(file, stopDir), inside, `inside must be found: ${stopDir}`);
      rmSync(inside);
      rmSync(above);
    }

    it('with a trailing separator', () => {
      assertBoundedBy(ws + sep);
    });

    it('with a repeated trailing separator', () => {
      assertBoundedBy(ws + sep + sep);
    });

    it("with a '.' and a '..' segment", () => {
      assertBoundedBy(join(ws, 'src', '..'));
      assertBoundedBy(ws + sep + '.');
    });

    it('with forward slashes on Windows (mixed separators)', function () {
      if (process.platform !== 'win32') {
        this.skip();
      }
      assertBoundedBy(ws.split('\\').join('/'));
    });

    it('with the drive letter in the other case (Windows)', function () {
      if (process.platform !== 'win32' || !/^[A-Za-z]:/.test(ws)) {
        this.skip();
      }
      const other = ws[0] === ws[0].toLowerCase() ? ws[0].toUpperCase() : ws[0].toLowerCase();
      assertBoundedBy(other + ws.slice(1));
    });

    it('with the whole path in the other case (Windows, case-insensitive)', function () {
      if (process.platform !== 'win32') {
        this.skip();
      }
      assertBoundedBy(ws.toUpperCase());
      assertBoundedBy(ws.toLowerCase());
    });
  });

  describe('a document OUTSIDE the workspace folder is not searched at all', () => {
    it('a file in a sibling folder, with its own ignore file, is not consulted', () => {
      const other = join(root, 'other');
      mkdirSync(other);
      ignoreIn(other);
      const otherFile = join(other, 'a.css');
      writeFileSync(otherFile, '');
      assert.equal(findSoukformatignore(otherFile, ws), undefined);
      assert.equal(countStats(() => resolveIgnore(otherFile, ws)), 0, 'not one stat');
    });

    it('a sibling that merely shares the name prefix is outside (containment, not startsWith)', () => {
      const sibling = `${ws}2`;
      mkdirSync(sibling);
      ignoreIn(sibling);
      const siblingFile = join(sibling, 'a.css');
      writeFileSync(siblingFile, '');
      assert.equal(findSoukformatignore(siblingFile, ws), undefined);
      assert.equal(countStats(() => resolveIgnore(siblingFile, ws)), 0);
    });

    it('a document above the workspace folder is outside it', () => {
      ignoreIn(root);
      const top = join(root, 'top.css');
      writeFileSync(top, '');
      assert.equal(findSoukformatignore(top, ws), undefined);
    });

    it('a workspace folder on a UNC share is not the parent of a local path (Windows)', function () {
      if (process.platform !== 'win32') {
        this.skip();
      }
      ignoreIn(ws);
      const unc = '\\\\server\\share\\ws';
      assert.equal(findSoukformatignore(file, unc), undefined);
      assert.equal(countStats(() => resolveIgnore(file, unc)), 0);
    });
  });

  describe('no usable boundary means no lookup, never an unbounded one', () => {
    for (const [label, stopDir] of [
      ['an empty string', ''],
      ['blank text', '   ']
    ] as const) {
      it(`${label} as the workspace folder: nothing is searched`, () => {
        ignoreIn(ws);
        assert.equal(findSoukformatignore(file, stopDir), undefined);
        assert.deepEqual(resolveIgnore(file, stopDir), { ignored: false });
        assert.equal(countStats(() => resolveIgnore(file, stopDir)), 0);
      });
    }

    it('a non-string workspace folder is treated the same way (no throw)', () => {
      ignoreIn(ws);
      assert.deepEqual(resolveIgnore(file, 42 as unknown as string), { ignored: false });
    });
  });

  describe('cost', () => {
    it('one stat per level inside the workspace, none above it', () => {
      const deep = join(ws, 'a', 'b', 'c');
      mkdirSync(deep, { recursive: true });
      const deepFile = join(deep, 'x.css');
      writeFileSync(deepFile, '');
      ignoreIn(root);
      // c, b, a, ws: four levels and then the bound; root is never stat'ed.
      assert.equal(countStats(() => resolveIgnore(deepFile, ws)), 4);
    });
  });
});
