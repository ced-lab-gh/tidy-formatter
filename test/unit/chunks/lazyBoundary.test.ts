// Static guard-rail for the ADD-11 lazy boundary.
//
// The esbuild plugin `tidy-chunk-rewrite` already FAILS THE BUILD when a host
// module imports a chunk-only package, and scripts/check-chunks.mjs re-proves it
// on the emitted metafile. Both of those need a production build. This suite is
// the third lock and the fastest one: it reads the SOURCES from disk and fails
// in `npm test`, seconds after someone writes the offending import, with the
// exact file and line.
//
// Same idiom as the manifest suites (they read package.json from disk): pure
// Node, no 'vscode'.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../../..');
const SRC_DIR = path.join(ROOT, 'src');
const CHUNKS_DIR = path.join(SRC_DIR, 'chunks');
const LOADER_PATH = path.join(CHUNKS_DIR, 'loader.ts');

/** Every .ts file under src/, excluding ambient declarations. */
function walkSources(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...walkSources(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      found.push(full);
    }
  }
  return found;
}

function relative(file: string): string {
  return path.relative(ROOT, file).replace(/\\/g, '/');
}

const ALL_SOURCES = walkSources(SRC_DIR);
const OUTSIDE_CHUNKS = ALL_SOURCES.filter(
  (file) => !file.startsWith(CHUNKS_DIR + path.sep)
);

// A VALUE import of one of these pulls the package into the host bundle. The
// negative lookahead on `type` is what keeps `import type { ParserOptions } from
// '@babel/parser'` legal everywhere: type-only imports are erased before esbuild
// ever resolves them and cost nothing at activation.
const VALUE_IMPORT_RE =
  /^\s*import\s+(?!type[\s{])[^;]*?from\s+['"](prettier|prettier\/[^'"]+|@babel\/parser|@babel\/types|postcss|postcss-scss|postcss-less|parse5)['"]/;
const REQUIRE_RE = /require\(\s*['"](prettier|@babel\/|postcss|parse5)/;
const EXPORT_FROM_RE =
  /^\s*export\s+(?!type[\s{])[^;]*?from\s+['"](prettier|prettier\/[^'"]+|@babel\/parser|@babel\/types|postcss|postcss-scss|postcss-less|parse5)['"]/;

const TEST_SEAMS = [
  '__setChunkLoadForTests',
  '__isChunkLoadedForTests',
  '__resetChunksForTests'
];

describe('chunks/lazyBoundary : no chunk-only package leaks into the host', () => {
  it('finds the source tree it is supposed to police', () => {
    // A silently empty walk would make every assertion below vacuously true.
    assert.ok(ALL_SOURCES.length > 30, `only ${ALL_SOURCES.length} sources found`);
    assert.ok(OUTSIDE_CHUNKS.length > 30);
    assert.ok(fs.existsSync(LOADER_PATH));
  });

  it('no value import of a chunk-only package outside src/chunks/', () => {
    const offenders: string[] = [];
    for (const file of OUTSIDE_CHUNKS) {
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, index) => {
        if (VALUE_IMPORT_RE.test(line) || EXPORT_FROM_RE.test(line)) {
          offenders.push(`${relative(file)}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    assert.deepEqual(
      offenders,
      [],
      `chunk-only packages must be reached through src/chunks/, not imported directly:\n${offenders.join('\n')}`
    );
  });

  it('no runtime require of a chunk-only package anywhere in src/', () => {
    const offenders: string[] = [];
    for (const file of ALL_SOURCES) {
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, index) => {
        if (REQUIRE_RE.test(line)) {
          offenders.push(`${relative(file)}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    assert.deepEqual(offenders, [], offenders.join('\n'));
  });

  it('test seams are never referenced by production code', () => {
    const offenders: string[] = [];
    for (const file of ALL_SOURCES) {
      if (file === LOADER_PATH) {
        continue;
      }
      const content = fs.readFileSync(file, 'utf8');
      for (const seam of TEST_SEAMS) {
        if (content.includes(seam)) {
          offenders.push(`${relative(file)} references ${seam}`);
        }
      }
    }
    assert.deepEqual(offenders, [], offenders.join('\n'));
  });
});

describe('chunks/lazyBoundary : chunk entries stay single-purpose', () => {
  const EXPECTED: Readonly<Record<string, RegExp>> = {
    'prettierChunk.ts': /^prettier(\/.+)?$/,
    'guardJsChunk.ts': /^@babel\/(parser|types)$/,
    'guardCssChunk.ts': /^postcss(-scss|-less)?$/,
    'guardHtmlChunk.ts': /^parse5$/
  };

  for (const [name, allowed] of Object.entries(EXPECTED)) {
    it(`${name} only re-exports its own libraries`, () => {
      const content = fs.readFileSync(path.join(CHUNKS_DIR, name), 'utf8');
      const specifiers = [...content.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(
        (match) => match[1]
      );
      assert.ok(specifiers.length > 0, `${name} re-exports nothing`);
      for (const specifier of specifiers) {
        assert.match(
          specifier,
          allowed,
          `${name} must not pull '${specifier}' into its chunk`
        );
      }
    });
  }

  it('no chunk entry imports vscode (they must stay testable under mocha)', () => {
    for (const file of walkSources(CHUNKS_DIR)) {
      const content = fs.readFileSync(file, 'utf8');
      assert.doesNotMatch(
        content,
        /from\s+['"]vscode['"]/,
        `${relative(file)} must not import vscode`
      );
    }
  });

  it('the loader targets exactly the four chunk entry modules', () => {
    // Comment lines are dropped first: the loader's header documents the
    // rewrite with a placeholder require('./xxxChunk') that is prose, not code.
    const loader = fs
      .readFileSync(LOADER_PATH, 'utf8')
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    const specifiers = [...loader.matchAll(/require\(\s*'(\.\/[A-Za-z]+)'\s*\)/g)].map(
      (match) => match[1]
    );
    assert.deepEqual(specifiers.sort(), [
      './guardCssChunk',
      './guardHtmlChunk',
      './guardJsChunk',
      './prettierChunk'
    ]);
  });
});
