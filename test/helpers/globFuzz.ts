// Deterministic generator of .gitignore files and paths for the git differential
// test (globGit.test.ts). The same seed always produces the same cases, so a
// disagreement found in CI can be replayed exactly.
//
// The "wide" alphabet deliberately covers what the matcher got wrong before:
// character classes (every spelling git knows), runs of stars, escapes, negation,
// a BOM, CRLF, a lone CR (not a line break, as in git), leading and trailing
// blanks, a trailing tab, non-ASCII, and mixed case. It does NOT generate the three
// forms on which this matcher is knowingly stricter than git (a lone trailing backslash, `\/`, a `**` followed by `\/`):
// they are pinned by name in globSemantics.test.ts.
import type { OracleCase } from './gitIgnoreOracle';

export type FuzzMode = 'simple' | 'wide';

export interface FuzzCase extends OracleCase {
  readonly ignoreFile: string;
}

const SIMPLE_TOKENS = ['a', 'b', 'a', 'b', 'A', 'B', '.', '-', '?', '*', '**', '/', '/'];

const WIDE_TOKENS = [
  ...SIMPLE_TOKENS,
  '***',
  '[ab]',
  '[!a]',
  '[^b]',
  '[a-b]',
  '[A-B]',
  '[]a]',
  '[[:alpha:]]',
  '[[:upper:]]',
  '[[:digit:]]',
  '[[:foo:]]',
  '[',
  ']',
  '[a',
  '\\*',
  '\\?',
  '\\[',
  '\\\\',
  '\\ ',
  '\\a',
  '\\!',
  '\\#',
  ' ',
  '\r',
  '!',
  '#',
  'é',
  '[é]',
  '[/]',
  '[!/]',
  '[a-]',
  '[-a]'
];

const NAMES = [
  'a',
  'b',
  'ab',
  'ba',
  'aab',
  'A',
  'B',
  'aB',
  'Ab',
  'a.b',
  '-',
  'a-b',
  '[a]',
  'a b',
  ' a',
  '*',
  '?',
  'é',
  'a*',
  '1',
  'x.js',
  'B.js',
  '!a',
  '#a'
];

const BOM = String.fromCharCode(0xfeff);

/** Generate `count` ignore files, each with `pathsPerCase` paths to ask about. */
export function generateFuzzCases(
  seed: number,
  count: number,
  pathsPerCase: number,
  mode: FuzzMode
): FuzzCase[] {
  let state = (seed * 2654435761) >>> 0;
  const next = (bound: number): number => {
    state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff;
    return (state >>> 8) % bound;
  };
  const pick = <T>(items: readonly T[]): T => items[next(items.length)];
  const tokens = mode === 'simple' ? SIMPLE_TOKENS : WIDE_TOKENS;

  const generateLine = (): string => {
    let line = '';
    const length = 1 + next(6);
    for (let i = 0; i < length; i += 1) {
      line += pick(tokens);
    }
    if (next(6) === 0) {
      line = `!${line}`;
    }
    if (next(12) === 0) {
      line = `  ${line}`;
    }
    if (next(10) === 0) {
      line += ' ';
    }
    if (next(25) === 0) {
      line += '\t';
    }
    return line;
  };

  const cases: FuzzCase[] = [];
  for (let n = 0; n < count; n += 1) {
    const lineCount = 1 + next(mode === 'simple' ? 3 : 4);
    const lines: string[] = [];
    for (let i = 0; i < lineCount; i += 1) {
      lines.push(generateLine());
    }
    const eol = next(8) === 0 ? '\r\n' : '\n';
    let text = lines.join(eol) + (next(5) === 0 ? '' : eol);
    if (next(15) === 0) {
      text = BOM + text;
    }
    const paths: string[] = [];
    for (let p = 0; p < pathsPerCase; p += 1) {
      const depth = 1 + next(4);
      paths.push(Array.from({ length: depth }, () => pick(NAMES)).join('/'));
    }
    cases.push({ ignoreFile: text, paths });
  }
  return cases;
}
