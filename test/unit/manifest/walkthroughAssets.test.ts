// Manifest-level asset tests for the walkthrough pages (ADD-03). PURE (no
// 'vscode'): reads package.json + media/walkthrough from disk and locks the
// packaging invariants:
//   - every step the manifest declares has its markdown page on disk;
//   - every image a page embeds is a SIBLING PNG that exists (walkthrough
//     markdown cannot reliably resolve '../' escapes, and the Marketplace
//     rejects a renamed SVG: PNG magic bytes are checked);
//   - every walkthrough PNG stays under the 400 KB budget;
//   - no shipped page carries an em dash (U+2014).
//
// The image assertions are written against whatever the pages REFERENCE, so
// they keep holding as the real captures land (the placeholder PNGs currently
// in the directory are not referenced by any page yet).
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../../..');
const WALKTHROUGH_DIR = path.join(ROOT, 'media', 'walkthrough');
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PER_IMAGE_BUDGET = 400 * 1024;

interface Manifest {
  contributes: {
    walkthroughs: {
      id: string;
      steps: { id: string; media?: { markdown?: string } }[];
    }[];
  };
}

function readManifest(): Manifest {
  return JSON.parse(
    fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')
  ) as Manifest;
}

function walkthroughFiles(extension: string): string[] {
  return fs
    .readdirSync(WALKTHROUGH_DIR)
    .filter((name) => name.endsWith(extension));
}

describe('manifest : walkthrough assets (ADD-03)', () => {
  it('every declared step markdown ships on disk', () => {
    for (const wt of readManifest().contributes.walkthroughs) {
      for (const step of wt.steps) {
        const md = step.media?.markdown;
        assert.ok(md, `step '${step.id}' must reference markdown media`);
        assert.ok(
          fs.existsSync(path.join(ROOT, md!)),
          `walkthrough media '${md}' must exist on disk (it ships in the VSIX)`
        );
      }
    }
  });

  it('ships the Try it now page', () => {
    assert.ok(fs.existsSync(path.join(WALKTHROUGH_DIR, 'tryit.md')));
  });

  it('the Try it now page states the zero-disk-write and guard promises', () => {
    const body = fs.readFileSync(path.join(WALKTHROUGH_DIR, 'tryit.md'), 'utf8');
    assert.ok(body.includes('untitled scratch documents'));
    assert.ok(body.includes('nothing is created on disk'));
    assert.ok(body.includes('Tidy: Preview Format (Diff)'));
    assert.ok(body.includes('semantic equivalence'));
  });

  it('every image referenced by a walkthrough page exists NEXT TO the page', () => {
    for (const name of walkthroughFiles('.md')) {
      const body = fs.readFileSync(path.join(WALKTHROUGH_DIR, name), 'utf8');
      for (const match of body.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
        const ref = match[1];
        assert.ok(
          !ref.includes('/') && !ref.includes('\\'),
          `${name} must reference sibling images only (got '${ref}')`
        );
        assert.ok(ref.endsWith('.png'), `${name} must embed PNG only (got '${ref}')`);
        assert.ok(
          fs.existsSync(path.join(WALKTHROUGH_DIR, ref)),
          `${name} references '${ref}' which does not exist`
        );
      }
    }
  });

  it('every walkthrough PNG is a REAL PNG (magic bytes), not a renamed SVG', () => {
    for (const name of walkthroughFiles('.png')) {
      const head = fs
        .readFileSync(path.join(WALKTHROUGH_DIR, name))
        .subarray(0, 8);
      assert.ok(
        head.equals(PNG_MAGIC),
        `media/walkthrough/${name} must start with the PNG signature`
      );
    }
  });

  it('every walkthrough PNG stays under the 400 KB budget', () => {
    for (const name of walkthroughFiles('.png')) {
      const size = fs.statSync(path.join(WALKTHROUGH_DIR, name)).size;
      assert.ok(
        size < PER_IMAGE_BUDGET,
        `media/walkthrough/${name} is ${size} bytes; budget is ${PER_IMAGE_BUDGET}`
      );
    }
  });

  it('no SVG file ships inside media/walkthrough', () => {
    assert.deepEqual(
      walkthroughFiles('.svg'),
      [],
      'the walkthrough must be PNG only'
    );
  });

  it('the shipped walkthrough pages contain no em dash (U+2014)', () => {
    for (const name of walkthroughFiles('.md')) {
      const body = fs.readFileSync(path.join(WALKTHROUGH_DIR, name), 'utf8');
      assert.ok(!body.includes('\u2014'), `${name} must not contain U+2014`);
    }
  });
});
