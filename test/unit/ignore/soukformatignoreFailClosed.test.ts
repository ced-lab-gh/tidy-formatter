// Unit tests for the fail-closed REASON of the .soukformatignore reader.
//
// glob.ts fails closed: a line it cannot evaluate (over 1024 characters, or ending
// in a lone backslash) excludes every file the ignore file governs. That is safe,
// but a user who only sees "ignored by .soukformatignore" on every file thinks the
// extension is broken. So the lookup now says which line and why, and an ignore
// file over 1 MiB is refused (fail CLOSED too, with the size named) rather than
// read and parsed on every format.
//
// Pinned here:
//   - parseIgnoreFile numbers the lines the way the file is written (CRLF, CR, blanks
//     and comments included);
//   - evaluateIgnore reports the reason only when the pattern that SETTLED the path
//     is the unevaluable one; a later evaluable "!negation" still re-includes;
//   - resolveIgnore: oversize fails closed with the size named, exactly at the cap
//     it does not, an unreadable file still fails open, and neither the size check
//     nor the walk costs an extra stat (one stat per level, no existsSync);
//   - the wording of both texts (Show Effective Configuration, output channel);
//   - the detail survives sanitizeDetail intact and is told apart from a file path.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatChannelLine, sanitizeDetail, type LastFormatRecord } from '../../../src/diagnostics/lastFormat';
import { MAX_GLOB_LENGTH } from '../../../src/ignore/glob';
import {
  MAX_SOUKFORMATIGNORE_BYTES,
  SOUKFORMATIGNORE_FILENAME,
  decideIgnore,
  evaluateIgnore,
  findSoukformatignore,
  ignoreRecordDetail,
  isFailClosedDetail,
  isIgnoredFile,
  parseIgnoreFile,
  parseIgnorePatterns,
  resolveIgnore
} from '../../../src/ignore/soukformatignore';

// The real, mutable 'node:fs' module object. An ES namespace import is a frozen copy
// whose members cannot be reassigned, and the reader under test calls the live ones.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fsModule = require('node:fs') as Record<string, unknown>;

/** Run `body` with the named fs functions wrapped to count their calls; always restores them. */
function countingFs<T extends string>(
  names: readonly T[],
  body: () => void,
  override?: Partial<Record<T, (...args: unknown[]) => unknown>>
): Record<T, number> {
  const originals = new Map<string, unknown>();
  const counts = {} as Record<T, number>;
  for (const name of names) {
    const original = fsModule[name] as (...args: unknown[]) => unknown;
    originals.set(name, original);
    counts[name] = 0;
    fsModule[name] = (...args: unknown[]): unknown => {
      counts[name] += 1;
      const replacement = override?.[name];
      return replacement !== undefined ? replacement(...args) : original(...args);
    };
  }
  try {
    body();
  } finally {
    for (const name of names) {
      fsModule[name] = originals.get(name);
    }
  }
  return counts;
}

const LONG_LINE = `${'a'.repeat(MAX_GLOB_LENGTH)}b`; // one character over the cap
const OVER_CAP_REASON = `${MAX_GLOB_LENGTH + 1} characters is over the ${MAX_GLOB_LENGTH}-character limit`;

describe('ignore/soukformatignore : parseIgnoreFile (source lines)', () => {
  it('numbers each pattern by its 1-based line, skipping blanks and comments', () => {
    const parsed = parseIgnoreFile('# header\n\n*.min.css\n   \n!keep.css\ndist/\n');
    assert.equal(parsed.patterns.length, 3);
    assert.deepEqual(parsed.lines, [3, 5, 6]);
  });

  it('counts CRLF and lone CR line ends as one line each', () => {
    assert.deepEqual(parseIgnoreFile('a\r\nb\rc\nd').lines, [1, 2, 3, 4]);
  });

  it('keeps parseIgnorePatterns exactly the patterns of parseIgnoreFile', () => {
    const text = '# c\n*.css\n\n!keep.css\n';
    assert.deepEqual(parseIgnorePatterns(text), [...parseIgnoreFile(text).patterns]);
  });

  it('returns nothing for empty or non-string input', () => {
    assert.deepEqual(parseIgnoreFile('').patterns, []);
    assert.deepEqual(parseIgnoreFile(undefined as unknown as string).lines, []);
  });
});

describe('ignore/soukformatignore : decideIgnore (which pattern settled it)', () => {
  it('reports the index of the last matching pattern, and none when nothing matched', () => {
    const patterns = parseIgnorePatterns('*.css\n!keep.css\ndist/\n');
    assert.deepEqual(decideIgnore('a.css', patterns), { ignored: true, decidedBy: 0 });
    assert.deepEqual(decideIgnore('keep.css', patterns), { ignored: false, decidedBy: 1 });
    assert.deepEqual(decideIgnore('a.js', patterns), { ignored: false });
  });

  it('isIgnoredFile is exactly decideIgnore(...).ignored', () => {
    const patterns = parseIgnorePatterns('*.css\n!keep.css\n');
    for (const rel of ['a.css', 'keep.css', 'a.js', '', 'dir/b.css']) {
      assert.equal(isIgnoredFile(rel, patterns), decideIgnore(rel, patterns).ignored, rel);
    }
  });
});

describe('ignore/soukformatignore : evaluateIgnore (fail-closed reason, pure)', () => {
  it('names the line and the reason for a pattern over the length cap', () => {
    const result = evaluateIgnore(`*.min.css\n${LONG_LINE}\n`, 'src/a.css');
    assert.equal(result.ignored, true);
    assert.equal(result.failClosed?.line, 2);
    assert.ok(result.failClosed?.detail.includes(`line 2 cannot be evaluated (${OVER_CAP_REASON})`));
  });

  it('names the line and the reason for a lone trailing backslash', () => {
    const result = evaluateIgnore('# top\n\nvendor\\\n', 'a.css');
    assert.equal(result.ignored, true);
    assert.equal(result.failClosed?.line, 3);
    assert.ok(result.failClosed?.detail.includes('(it ends with a lone backslash)'));
  });

  it('reports NO reason for an ordinary exclusion rule', () => {
    assert.deepEqual(evaluateIgnore('*.css\n', 'a.css'), { ignored: true });
  });

  it('reports NO reason when nothing matched, or when the file is re-included', () => {
    assert.deepEqual(evaluateIgnore('dist/\n', 'a.css'), { ignored: false });
    assert.deepEqual(evaluateIgnore('vendor\\\n!keep.css\n', 'keep.css'), { ignored: false });
  });

  it('reports the reason only while the unevaluable pattern is the one that settled the path', () => {
    // Later evaluable rule wins: the path is excluded by *.css, not by failing closed.
    assert.deepEqual(evaluateIgnore('vendor\\\n*.css\n', 'a.css'), { ignored: true });
    // An earlier evaluable rule loses to the later unevaluable one.
    assert.equal(evaluateIgnore('*.css\nvendor\\\n', 'a.css').failClosed?.line, 2);
  });

  it('reports the LAST unevaluable line when several fail', () => {
    assert.equal(evaluateIgnore('one\\\nok.css\ntwo\\\n', 'a.css').failClosed?.line, 3);
  });

  it('never lets an unevaluable negation re-include, and blames nothing for the earlier rule', () => {
    assert.deepEqual(evaluateIgnore('*.css\n!keep\\\n', 'keep.css'), { ignored: true });
  });

  it('counts the lines of a CRLF file', () => {
    assert.equal(evaluateIgnore('a\r\nb\r\nvendor\\\r\n', 'z.css').failClosed?.line, 3);
  });
});

describe('ignore/soukformatignore : wording of the two reports', () => {
  it('Show Effective Configuration: line, bounded pattern, reason, consequence, one line', () => {
    const { failClosed } = evaluateIgnore('vendor\\\n', 'a.css');
    assert.equal(
      failClosed?.explanation,
      'line 1: pattern "vendor\\" cannot be evaluated (it ends with a lone backslash); ' +
        "every file under this ignore file's folder is excluded until the line is fixed or removed."
    );
  });

  it('echoes at most 80 characters of a huge pattern, so one line cannot flood the report', () => {
    const { failClosed } = evaluateIgnore(`${'x'.repeat(200_000)}\n`, 'a.css');
    assert.ok(failClosed !== undefined);
    assert.ok(failClosed.explanation.length < 400, `${failClosed.explanation.length} chars`);
    assert.ok(failClosed.explanation.includes(`${'x'.repeat(80)}..."`));
    assert.ok(!failClosed.explanation.includes('\n'));
  });

  it('output channel: names the line and reason, not the pattern, in one short line', () => {
    const { failClosed } = evaluateIgnore('vendor\\\n', 'a.css');
    assert.equal(
      failClosed?.detail,
      '.soukformatignore line 1 cannot be evaluated (it ends with a lone backslash); ' +
        'every file it governs is excluded'
    );
  });

  it('the detail is single-line and under the 200 characters sanitizeDetail keeps, even worst case', () => {
    const { failClosed } = evaluateIgnore(`${'\n'.repeat(99_998)}${'x'.repeat(50_000)}\n`, 'a.css');
    assert.equal(failClosed?.line, 99_999);
    const detail = failClosed?.detail ?? '';
    assert.ok(detail.length < 200, `${detail.length} chars`);
    assert.equal(sanitizeDetail(detail), detail, 'sanitizeDetail changes nothing');
    assert.ok(!detail.includes('\n'));
  });

  it('carries through the existing record mechanism into the channel line', () => {
    const { failClosed } = evaluateIgnore('vendor\\\n', 'a.css');
    const record: LastFormatRecord = {
      uri: 'file:///w/a.css',
      fileName: 'a.css',
      languageId: 'css',
      status: 'ignored-file',
      scope: 'document',
      detail: sanitizeDetail(failClosed?.detail ?? ''),
      at: '2026-09-30T10:00:00.000Z'
    };
    assert.equal(
      formatChannelLine(record),
      '[2026-09-30T10:00:00.000Z] a.css [css] ignored-file: ' +
        '.soukformatignore line 1 cannot be evaluated (it ends with a lone backslash); ' +
        'every file it governs is excluded'
    );
  });
});

describe('ignore/soukformatignore : ignoreRecordDetail / isFailClosedDetail', () => {
  it('records the ignore file path for a normal exclusion (the Open action opens it)', () => {
    assert.equal(ignoreRecordDetail({ path: '/w/.soukformatignore', ignored: true }), '/w/.soukformatignore');
    assert.equal(isFailClosedDetail('/w/.soukformatignore'), false);
  });

  it('records the reason instead of the path for a fail-closed exclusion', () => {
    const lookup = {
      path: '/w/.soukformatignore',
      ...evaluateIgnore('vendor\\\n', 'a.css')
    };
    const detail = ignoreRecordDetail(lookup);
    assert.equal(detail, lookup.failClosed?.detail);
    assert.equal(isFailClosedDetail(detail), true);
  });

  it('never mistakes an absolute path for a reason (POSIX or Windows)', () => {
    assert.equal(isFailClosedDetail('C:\\proj\\.soukformatignore'), false);
    assert.equal(isFailClosedDetail('/proj/.soukformatignore'), false);
    assert.equal(isFailClosedDetail(undefined), false);
    assert.equal(isFailClosedDetail(''), false);
  });

  it('has nothing to record when no ignore file was consulted', () => {
    assert.equal(ignoreRecordDetail({ ignored: false }), undefined);
  });
});

describe('ignore/soukformatignore : resolveIgnore on disk (fail-closed reason, size cap)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tidy-ignore-fc-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function ignoreFile(): string {
    return join(root, SOUKFORMATIGNORE_FILENAME);
  }

  function target(name = 'a.css'): string {
    const file = join(root, name);
    writeFileSync(file, '');
    return file;
  }

  it('excludes the file and names the line when a line cannot be evaluated', () => {
    writeFileSync(ignoreFile(), '*.min.css\nvendor\\\n');
    const lookup = resolveIgnore(target());
    assert.equal(lookup.ignored, true);
    assert.equal(lookup.path, ignoreFile());
    assert.equal(lookup.failClosed?.line, 2);
  });

  it('gives an ordinary exclusion no fail-closed reason', () => {
    writeFileSync(ignoreFile(), '*.css\n');
    const lookup = resolveIgnore(target());
    assert.equal(lookup.ignored, true);
    assert.equal(lookup.failClosed, undefined);
  });

  it('fails CLOSED on an ignore file over the cap, naming the size, without reading it', () => {
    const size = MAX_SOUKFORMATIGNORE_BYTES + 1;
    writeFileSync(ignoreFile(), Buffer.alloc(size, 0x23)); // "#" only: nothing to exclude if it WERE read
    const file = target();
    let lookup: ReturnType<typeof resolveIgnore> | undefined;
    const counts = countingFs(['readFileSync'], () => {
      lookup = resolveIgnore(file);
    });
    assert.equal(counts.readFileSync, 0, 'an oversized ignore file is never read');
    assert.ok(lookup !== undefined);
    assert.equal(lookup.ignored, true);
    assert.equal(lookup.path, ignoreFile());
    assert.equal(lookup.failClosed?.line, undefined, 'the whole file is refused, not one line');
    assert.equal(
      lookup.failClosed?.detail,
      `.soukformatignore is too large to read (${size} bytes; the limit is ${MAX_SOUKFORMATIGNORE_BYTES}); ` +
        'every file it governs is excluded'
    );
    assert.equal(
      lookup.failClosed?.explanation,
      `the file is too large to read (${size} bytes; the limit is ${MAX_SOUKFORMATIGNORE_BYTES}); ` +
        "every file under this ignore file's folder is excluded until it is shortened or removed."
    );
  });

  it('reads a file of exactly the cap (the limit is inclusive)', () => {
    const line = 'dist/\n';
    const filler = '#'.repeat(MAX_SOUKFORMATIGNORE_BYTES - line.length - 1) + '\n';
    writeFileSync(ignoreFile(), filler + line);
    assert.equal(statSync(ignoreFile()).size, MAX_SOUKFORMATIGNORE_BYTES);
    const lookup = resolveIgnore(target());
    assert.equal(lookup.ignored, false, 'read and evaluated: a.css is not under dist/');
    assert.equal(lookup.failClosed, undefined);
  });

  it('an oversized ignore file governs only its own folder: a nearer one wins', () => {
    writeFileSync(ignoreFile(), Buffer.alloc(MAX_SOUKFORMATIGNORE_BYTES + 1, 0x23));
    const sub = join(root, 'pkg');
    mkdirSync(sub);
    writeFileSync(join(sub, SOUKFORMATIGNORE_FILENAME), 'dist/\n');
    const file = join(sub, 'a.css');
    writeFileSync(file, '');
    const lookup = resolveIgnore(file);
    assert.equal(lookup.path, join(sub, SOUKFORMATIGNORE_FILENAME));
    assert.equal(lookup.ignored, false);
  });

  it('a directory called .soukformatignore is not an ignore file', () => {
    mkdirSync(ignoreFile());
    assert.equal(findSoukformatignore(target()), undefined);
    assert.deepEqual(resolveIgnore(target()), { ignored: false });
  });

  it('stays fail-safe (formats) when the ignore file cannot be read', () => {
    writeFileSync(ignoreFile(), 'a.css\n');
    const file = target();
    let lookup: ReturnType<typeof resolveIgnore> | undefined;
    countingFs(
      ['readFileSync'],
      () => {
        lookup = resolveIgnore(file);
      },
      {
        readFileSync: () => {
          throw new Error('EACCES');
        }
      }
    );
    assert.deepEqual(lookup, { path: ignoreFile(), ignored: false });
  });

  it('costs one stat per directory level, no existsSync, and one read', () => {
    writeFileSync(ignoreFile(), 'dist/\n');
    const deep = join(root, 'a', 'b', 'c');
    mkdirSync(deep, { recursive: true });
    const file = join(deep, 'x.css');
    writeFileSync(file, '');

    let lookup: ReturnType<typeof resolveIgnore> | undefined;
    const counts = countingFs(['statSync', 'existsSync', 'readFileSync'], () => {
      lookup = resolveIgnore(file);
    });
    assert.equal(lookup?.path, ignoreFile());
    // c, b, a, root: four levels walked, one stat each; the size came from that stat.
    assert.deepEqual(counts, { statSync: 4, existsSync: 0, readFileSync: 1 });
  });
});
