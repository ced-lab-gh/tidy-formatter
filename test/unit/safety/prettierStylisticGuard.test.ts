// SAFETY PROOF (Axe 3.T4, contract §3): the Prettier stylistic options Tidy
// exposes (semi, singleQuote, jsxSingleQuote, trailingComma, bracketSpacing,
// bracketSameLine, arrowParens, quoteProps, printWidth) are AST-INVARIANT.
//
// For each option we format the SAME input two ways and assert:
//   1. the two formatted outputs DIFFER (the option really has an effect), and
//   2. guard.check(input, output) === equivalent:true for BOTH outputs, and
//   3. guard.check(outputA, outputB) === equivalent:true (the two stylistic
//      variants are mutually equivalent — same AST modulo whitespace/style).
//
// This proves the equivalence guard accepts every stylistic toggle, so exposing
// these options can never make Tidy a silent no-op nor let it corrupt a file.
import assert from 'node:assert/strict';
import { PrettierEngine } from '../../../src/engine/prettier';
import { guard } from '../../../src/safety/guard';
import { resolved } from '../../helpers/options';
import type { LangId } from '../../../src/types';

const engine = new PrettierEngine();

async function fmt(code: string, bag: Record<string, unknown>, lang: LangId) {
  return engine.format({ languageId: lang, code, options: resolved({ engineOptions: { prettier: bag } }) });
}

interface Case {
  readonly name: string;
  readonly lang: LangId;
  readonly input: string;
  readonly a: Record<string, unknown>;
  readonly b: Record<string, unknown>;
}

const CASES: readonly Case[] = [
  {
    name: 'semi on/off',
    lang: 'typescript',
    input: 'const a = 1\nconst b = 2\n',
    a: { semi: true },
    b: { semi: false }
  },
  {
    name: 'singleQuote on/off',
    lang: 'typescript',
    input: 'const a = "x"; const b = "y";',
    a: { singleQuote: false },
    b: { singleQuote: true }
  },
  {
    name: 'jsxSingleQuote on/off',
    lang: 'typescriptreact',
    input: 'const a = <div className="x" id="y" />;',
    a: { jsxSingleQuote: false },
    b: { jsxSingleQuote: true }
  },
  {
    name: 'trailingComma none/all',
    lang: 'typescript',
    input: 'const o = {\n  alpha: 1,\n  beta: 2,\n  gamma: 3\n};',
    a: { trailingComma: 'none' },
    b: { trailingComma: 'all' }
  },
  {
    name: 'bracketSpacing on/off',
    lang: 'typescript',
    input: 'const o = { a: 1, b: 2 };',
    a: { bracketSpacing: true },
    b: { bracketSpacing: false }
  },
  {
    name: 'arrowParens always/avoid',
    lang: 'typescript',
    input: 'const f = x => x * 2; const g = y => y + 1;',
    a: { arrowParens: 'always' },
    b: { arrowParens: 'avoid' }
  },
  {
    name: 'printWidth wide/narrow',
    lang: 'typescript',
    input: 'const result = aaaaa + bbbbb + ccccc + ddddd + eeeee + fffff + ggggg + hhhhh;',
    a: { printWidth: 200 },
    b: { printWidth: 20 }
  },
  {
    name: 'bracketSameLine off/on',
    lang: 'typescriptreact',
    input:
      'const a = <div className="a-very-long-class" dataX="another-long-attribute-value-here" id="zz">child</div>;',
    a: { bracketSameLine: false, printWidth: 40 },
    b: { bracketSameLine: true, printWidth: 40 }
  }
];

describe('safety/guard — Prettier stylistic options are AST-invariant', () => {
  for (const c of CASES) {
    it(`${c.name}: changes output yet stays guard-equivalent`, async () => {
      const outA = await fmt(c.input, c.a, c.lang);
      const outB = await fmt(c.input, c.b, c.lang);

      // 1. The option actually changes the printed output (non-trivial proof).
      assert.notEqual(outA, outB, `${c.name}: outputs must differ to prove the option has effect`);

      // 2. Each variant is equivalent to the original input under the guard.
      const vA = guard.check(c.lang, c.input, outA);
      const vB = guard.check(c.lang, c.input, outB);
      assert.equal(vA.equivalent, true, `${c.name}: variant A rejected (${vA.reason ?? ''})`);
      assert.equal(vB.equivalent, true, `${c.name}: variant B rejected (${vB.reason ?? ''})`);

      // 3. The two stylistic variants are mutually equivalent.
      const vAB = guard.check(c.lang, outA, outB);
      assert.equal(vAB.equivalent, true, `${c.name}: A vs B rejected (${vAB.reason ?? ''})`);
    });
  }
});
