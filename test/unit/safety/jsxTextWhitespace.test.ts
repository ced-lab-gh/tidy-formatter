// JSX TEXT WHITESPACE: the guard is deliberately STRICTER than Prettier here,
// and the rejection has to say so in words a user can act on.
//
// THE FACT THE SUITE IS BUILT ON. @babel/parser keeps an interior run of spaces
// on a single line exactly as written: `<p>hello  there</p>` parses to a JSXText
// whose value is "hello  there", TWO spaces. Only whitespace containing a line
// break is folded. So the run is part of the string the file COMPILES to.
// Prettier 3 prints that source as `<p>hello there</p>`, betting a browser will
// collapse the run on display. The bet is wrong wherever the string is not HTML
// flow text:
//   - an i18n message id (<Trans>Hello  world</Trans>) becomes a different
//     lookup key and the translation silently stops resolving;
//   - React Native <Text> draws every space it is given;
//   - any subtree that ends up inside a preformatted context is drawn verbatim,
//     and whether it does cannot be read off the expression the text sits in:
//     `const label = <span>col1  col2</span>` may be drawn by a
//     `<pre>{label}</pre>` in another file entirely. A guard that decided
//     "preformatted" lexically therefore let every subtree reached through a
//     REFERENCE escape, which is an accept-when-not-equivalent, not a nicety.
// Tidy refuses the output. That is the product working.
//
// WHAT THE SUITE THEN PROTECTS. A correct refusal that reads "AST structure
// changed after formatting" looks like a crash on the single most common
// legitimate rejection in a React file. The guard now labels that exact case in
// plain English, and the label is LABEL ONLY: it is computed after the rejection
// is already decided, from the canonical forms the comparison produced, so it
// can never widen or narrow what is accepted. Both halves are asserted below:
// the label fires where it should, and it does NOT fire for any other kind of
// difference, where the generic sentence must still be the answer.
import assert from 'node:assert/strict';
import { guard, JSX_TEXT_WHITESPACE_REASON } from '../../../src/safety/guard';
import { PrettierEngine } from '../../../src/engine/prettier';
import { resolved } from '../../helpers/options';
import type { LangId } from '../../../src/types';

const LANG: LangId = 'typescriptreact';
const GENERIC_REASON = 'AST structure changed after formatting';

// Built from its code point on purpose: a literal U+00A0 in this file could be
// normalised away by an editor and would silently defang the assertion.
const NBSP = String.fromCharCode(0x00a0);

/* -------------------------------------------------------------------------- */
/* The real printer, on the three sources that were checked by hand            */
/* -------------------------------------------------------------------------- */

describe('safety/guard : Prettier collapsing a JSX text run is REFUSED', () => {
  const engine = new PrettierEngine();

  const SOURCES: ReadonlyArray<readonly [string, string]> = [
    ['plain flow text', 'const a = <p>hello  there</p>;\n'],
    ['an i18n message id', 'const t = <Trans>Hello  world</Trans>;\n'],
    ['a React Native label', 'const n = <Text>col1  col2</Text>;\n']
  ];

  for (const [name, input] of SOURCES) {
    it(`refuses the real Prettier output for ${name}`, async () => {
      const output = await engine.format({
        languageId: LANG,
        code: input,
        options: resolved({})
      });
      assert.notEqual(
        output,
        input,
        `${name}: Prettier must really collapse the run, or the case proves nothing`
      );

      const verdict = guard.check(LANG, input, output);
      assert.equal(
        verdict.equivalent,
        false,
        `${name}: the compiled string changed and must not be written`
      );
      assert.equal(
        verdict.reason,
        JSX_TEXT_WHITESPACE_REASON,
        `${name}: the user must be told what actually happened`
      );
    });
  }

  it('refuses a run reached through a REFERENCE, which no lexical rule can see', async () => {
    // The proven accept-when-not-equivalent of the reverted relaxation: the
    // <span> is written in one expression and drawn by a <pre> in another.
    const input =
      'const label = <span>col1  col2</span>;\nexport const Table = () => <pre>{label}</pre>;\n';
    const output = await engine.format({
      languageId: LANG,
      code: input,
      options: resolved({})
    });
    assert.ok(output.includes('col1 col2'), 'Prettier must collapse the run here too');
    assert.equal(guard.check(LANG, input, output).equivalent, false);
  });
});

/* -------------------------------------------------------------------------- */
/* The label fires on whitespace, and ONLY on whitespace                       */
/* -------------------------------------------------------------------------- */

interface Case {
  readonly id: string;
  readonly input: string;
  readonly output: string;
}

const LABELLED: readonly Case[] = [
  {
    id: 'an interior run collapsed',
    input: 'const a = <p>hello  there</p>;',
    output: 'const a = <p>hello there</p>;'
  },
  {
    id: 'a long interior run collapsed',
    input: 'const a = <p>a     b</p>;',
    output: 'const a = <p>a b</p>;'
  },
  {
    id: 'a leading space stripped',
    input: 'const a = <p> hello</p>;',
    output: 'const a = <p>hello</p>;'
  },
  {
    id: 'a run collapsed inside <pre>, where it is drawn',
    input: 'const a = <pre>col1    col2</pre>;',
    output: 'const a = <pre>col1 col2</pre>;'
  }
];

const NOT_LABELLED: readonly Case[] = [
  {
    id: 'a word changed',
    input: 'const a = <p>hello there</p>;',
    output: 'const a = <p>hello thera</p>;'
  },
  {
    id: 'a word added',
    input: 'const a = <p>hello there</p>;',
    output: 'const a = <p>hello big there</p>;'
  },
  {
    id: 'a whole text child dropped',
    input: 'const a = <p>hello <b>x</b></p>;',
    output: 'const a = <p><b>x</b></p>;'
  },
  {
    id: 'a {" "} spacer dropped (a node, not text)',
    input: 'const a = <p><b>x</b>{" "}<i>y</i></p>;',
    output: 'const a = <p><b>x</b><i>y</i></p>;'
  },
  {
    id: 'a {" "} spacer invented (a node, not text)',
    input: 'const a = <p>read<b>me</b></p>;',
    output: 'const a = <p>read{" "}<b>me</b></p>;'
  },
  {
    id: 'a no-break space downgraded (a rendered character, not whitespace)',
    input: `const a = <p>10${NBSP}km</p>;`,
    output: 'const a = <p>10 km</p>;'
  },
  {
    id: 'an attribute value changed',
    input: 'const a = <Foo bar="x  y" />;',
    output: 'const a = <Foo bar="x y" />;'
  },
  {
    id: 'a statement dropped, with the JSX untouched',
    input: 'const a = 1;\nconst b = <p>x</p>;',
    output: 'const b = <p>x</p>;'
  }
];

describe('safety/guard : the JSX whitespace label is precise', () => {
  for (const c of LABELLED) {
    it(`labels: ${c.id}`, () => {
      const verdict = guard.check(LANG, c.input, c.output);
      assert.equal(verdict.equivalent, false, `${c.id}: must still be refused`);
      assert.equal(verdict.reason, JSX_TEXT_WHITESPACE_REASON, c.id);
    });
  }

  for (const c of NOT_LABELLED) {
    it(`does NOT label: ${c.id}`, () => {
      const verdict = guard.check(LANG, c.input, c.output);
      assert.equal(verdict.equivalent, false, `${c.id}: must still be refused`);
      assert.equal(
        verdict.reason,
        GENERIC_REASON,
        `${c.id}: calling this "whitespace" would be a false explanation`
      );
    });
  }
});

/* -------------------------------------------------------------------------- */
/* The label cannot move the verdict                                           */
/* -------------------------------------------------------------------------- */

describe('safety/guard : labelling changes no verdict', () => {
  const STILL_ACCEPTED: readonly Case[] = [
    {
      id: 'a multi-line JSX reflow (the whitespace JSX itself folds)',
      input: 'const a = <div><h1>a</h1><span>b</span></div>;',
      output: 'const a = (\n  <div>\n    <h1>a</h1>\n    <span>b</span>\n  </div>\n);'
    },
    {
      id: 'a newline plus indentation between two words',
      input: 'const a = <p>hello there</p>;',
      output: 'const a = (\n  <p>\n    hello\n    there\n  </p>\n);'
    },
    {
      id: 'ordinary statement reindentation, no JSX text at all',
      input: 'const a   =   1;',
      output: 'const a = 1;'
    }
  ];

  for (const c of STILL_ACCEPTED) {
    it(`still accepts: ${c.id}`, () => {
      const verdict = guard.check(LANG, c.input, c.output);
      assert.equal(
        verdict.equivalent,
        true,
        `${c.id}: the guard must not have become stricter (${verdict.reason ?? ''})`
      );
    });
  }

  it('a file whose double-spaced JSX text is untouched is still equivalent to itself', () => {
    // guard.check(LANG, src, src) would return on string equality alone, before
    // any parse, so it could not fail. The second side re-spaces only the code
    // AROUND the text, so both sides are really parsed and the untouched
    // `hello  there` run (two spaces) is really compared.
    const src = 'const a = <p>hello  there</p>;';
    const respaced = 'const a   =   <p>hello  there</p>;';
    assert.notEqual(src, respaced);
    assert.equal(guard.check(LANG, src, respaced).equivalent, true);
  });

  it('the sentence is single-line, English and free of an em dash', () => {
    // The output channel, the status bar tooltip and "Explain last format" all
    // carry it through sanitizeDetail, which keeps the first line and clamps at
    // 200 characters.
    assert.ok(!JSX_TEXT_WHITESPACE_REASON.includes('\n'));
    assert.ok(JSX_TEXT_WHITESPACE_REASON.length <= 200);
    assert.ok(!JSX_TEXT_WHITESPACE_REASON.includes(String.fromCharCode(0x2014)));
  });
});
