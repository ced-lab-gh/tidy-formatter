// MEDIUM-06 (probe P11): the cheap JSX pre-check in front of the dispatcher's
// full Babel parse.
//
// The contract has two halves and they are not symmetrical:
//   - "no" (false) must be PROVABLE: a `<` only ever follows an operand;
//   - "maybe" (true) is always allowed, because the caller then runs the same
//     full parse it always ran.
// The first half is the one that can hurt: a wrong "no" routes a JSX file to
// js-beautify, which the guard then rejects. So most of this file is JSX written
// the way it is HARD TO SPOT (inside ternaries, after return, fragments, names
// starting with _ or $, after a statement that ended by ASI), each one also
// proved against the real Babel parse, so the test cannot drift from the truth it
// stands in for.
import assert from 'node:assert/strict';
import type { ParserPlugin } from '@babel/parser';
import { requireGuardJsChunk } from '../../../src/chunks/loader';
import { mayContainJsx } from '../../../src/engine/jsxScan';

const JS_PLUGINS: ParserPlugin[] = [
  'jsx',
  ['decorators', { decoratorsBeforeExport: false }],
  'classProperties',
  'classPrivateProperties',
  'classPrivateMethods'
];

/** The dispatcher's own ground truth: does Babel find a JSX node? (undefined: not valid JS.) */
function babelFindsJsx(code: string): boolean | undefined {
  const { parse, traverseFast } = requireGuardJsChunk();
  let ast;
  try {
    ast = parse(code, {
      sourceType: 'unambiguous',
      errorRecovery: false,
      plugins: JS_PLUGINS
    });
  } catch {
    return undefined;
  }
  let found = false;
  traverseFast(ast, (node) => {
    if (node.type === 'JSXElement' || node.type === 'JSXFragment') {
      found = true;
    }
  });
  return found;
}

describe('engine/jsxScan : JSX in every position it can hide in is never ruled out', () => {
  // [label, code]. Every one of these really contains JSX (asserted below).
  const JSX_SHAPES: ReadonlyArray<readonly [string, string]> = [
    ['a bare element at the start of the file', '<div/>;'],
    ['a fragment at the start of the file', '<></>;'],
    ['after `=`', 'const a = <div/>;'],
    ['a ternary, both arms', 'const a = c ? <A/> : <B/>;'],
    ['a ternary split over lines', 'const a = c\n  ? <A/>\n  : <B/>;'],
    ['after return', 'function f() { return <div/>; }'],
    ['after return and an open paren', 'function f() {\n  return (\n    <div/>\n  );\n}'],
    ['after return and a line break (ASI)', 'function f() {\n  return\n<div/>\n}'],
    ['a fragment with children', 'const a = <><b/>text</>;'],
    ['a component named with a leading underscore', 'const a = <_Foo bar="1"/>;'],
    ['a component named with a leading dollar', 'const a = <$Bar/>;'],
    ['a member-expression tag', 'const a = <ui.Button/>;'],
    ['a namespaced tag', 'const a = <svg:rect/>;'],
    ['an arrow body', 'const f = () => <A/>;'],
    ['an arrow body in parens', 'const f = (a) => (<A a={a}/>);'],
    ['after &&', 'const a = x && <A/>;'],
    ['after ||', 'const a = x || <A/>;'],
    ['after ??', 'const a = x ?? <A/>;'],
    ['a call argument', 'render(<A/>, root);'],
    ['a second call argument', 'render(root, <A/>);'],
    ['an array element', 'const a = [<A key="1"/>, <B key="2"/>];'],
    ['an object value', 'const a = { view: <A/> };'],
    ['a computed key', 'const a = { [<A/>]: 1 };'],
    ['a spread argument', 'f(...<A/>);'],
    ['a template hole', 'const a = `${<A/>}`;'],
    ['a template hole after other text', 'const a = `x ${y} z ${<A/>}`;'],
    ['a class property', 'class C { view = <A/>; }'],
    ['export default', 'export default <A/>;'],
    ['a statement after a block', 'if (x) {}\n<A/>;'],
    ['a statement after a semicolon', 'foo();\n<A/>;'],
    ['a bare if body', 'if (x) <A/>;'],
    ['a bare while body', 'while (x) <A/>;'],
    ['a bare for body', 'for (;;) <A/>;'],
    ['a bare for-of body', 'for (const a of b) <A/>;'],
    ['a bare else body', 'if (x) y(); else <A/>;'],
    ['a bare do body', 'do <A/>; while (x);'],
    ['a case clause', 'switch (x) { case 1: <A/>; }'],
    ['a case value', 'switch (x) { case <A/>: y(); }'],
    ['yield', 'function* g() { yield <A/>; }'],
    ['await', 'async function f() { await <A/>; }'],
    ['of', 'for (const a of <A/>) {}'],
    ['in', 'for (const a in <A/>) {}'],
    ['typeof', 'typeof <A/>;'],
    ['void', 'void <A/>;'],
    ['throw', 'function f() { throw <A/>; }'],
    ['after a label', 'foo: <A/>;'],
    ['an import followed by a bare element (ASI)', "import x from 'y'\n<A/>;"],
    ['a declaration without initialiser followed by a bare element (ASI)', 'let a\n<A/>;'],
    ['a break followed by a bare element (ASI)', 'for (;;) {\n  break\n<A/>\n}'],
    ['after a line comment', '// c\n<A/>;'],
    ['after a block comment', '/* c */ <A/>;'],
    ['after a block comment spanning lines after an identifier (ASI)', 'let a /*\n*/ <A/>;'],
    ['after a regular expression statement', 'x = /re/g;\n<A/>;'],
    ['after a regular expression holding a quote', 'x = /"/;\nconst a = <A/>;'],
    ['after a string holding a slash', 'x = "a/b";\nconst a = <A/>;'],
    ['after a division that looks like a regex start', 'x = a / b; y = c / d;\nconst a = <A/>;'],
    ['after a template literal', 'x = `a`;\nconst a = <A/>;'],
    ['after a nested template', 'x = `a ${`b ${c}`} d`;\nconst a = <A/>;'],
    ['after a shebang', '#!/usr/bin/env node\nconst a = <A/>;'],
    ['after a no-break space', 'const a = <A/>;'],
    ['after a line separator', 'const a = <A/>;'],
    ['with CRLF line endings', 'function f() {\r\n  return (\r\n    <A/>\r\n  );\r\n}\r\n'],
    ['text with an apostrophe inside', "const a = <p>it's</p>;"],
    ['a comparison first, JSX later', 'if (a<b) {}\nconst v = <A/>;'],
    ['JSX nested in a comparison-looking expression', 'const a = x < y ? <A/> : null;'],
    ['a less-than followed by an element', 'const a = x < <A/>;'],
    ['a decorator then a class holding JSX', '@dec class C { render() { return <A/>; } }']
  ];

  for (const [label, code] of JSX_SHAPES) {
    it(`${label}`, () => {
      // The claim is only meaningful if the snippet is real JSX.
      assert.equal(babelFindsJsx(code), true, 'not JSX, fix the test: ' + code);
      assert.equal(mayContainJsx(code), true, `ruled out real JSX: ${JSON.stringify(code)}`);
    });
  }
});

describe('engine/jsxScan : code with `<` that cannot be JSX is ruled out without a parse', () => {
  const COMPARISONS: ReadonlyArray<readonly [string, string]> = [
    ['a<b', 'x = a<b;'],
    ['a < b', 'x = a < b;'],
    ['a<=b', 'x = a<=b;'],
    ['a<<b (shift)', 'x = a<<b;'],
    ['a<<=b', 'x <<= 2; y = a<<=b;'],
    ['an if head', 'if (a<b) { c(); }'],
    ['a for head', 'for (var i = 0; i<n; i++) {}'],
    ['postfix increment then <', 'while (i++<n) {}'],
    ['a call result', 'x = f(a)<g(b);'],
    ['a parenthesised sum', 'x = (a+b)<c;'],
    ['an index', 'x = arr[i]<arr[j];'],
    ['a number', 'x = 1<y;'],
    ['a string', 'x = "a"<y;'],
    ['a property', 'x = a.b<c.d;'],
    ['a keyword used as a property name', 'x = a.return<b.in;'],
    ['this', 'x = this<y;'],
    ['a generic-looking comparison chain', 'const ok = a<b && c>d;'],
    ['a comparison after a regex', 'x = /a/.test(s)<2;'],
    ['a division then a comparison', 'x = a / b < c;'],
    ['a postfix then a division', 'x = i++ / 2 < 3;'],
    ['a template then a comparison', 'x = `t`<y;'],
    ['a comparison inside a template hole', 'x = `${a<b}`;'],
    ['an arrow returning a comparison', 'const f = (a, b) => a<b;'],
    ['a minified run', 'function f(a,b){for(var i=0;i<b.length;i++)if(a[i]<b[i]||(a+b)<3||a()<1)return a<b;return/x</.test(a)?1:2}'],
    ['a unicode identifier', 'x = café<y;'],
    ['an escaped identifier', 'x = \\u0061<y;'],
    ['a shebang first', '#!/usr/bin/env node\nx = a<b;']
  ];

  for (const [label, code] of COMPARISONS) {
    it(`${label}`, () => {
      assert.equal(babelFindsJsx(code), false, 'fix the test, this must parse and hold no JSX');
      assert.equal(mayContainJsx(code), false, `should be ruled out: ${JSON.stringify(code)}`);
    });
  }

  const INERT_TEXT: ReadonlyArray<readonly [string, string]> = [
    ['a double-quoted string', 'x = "<div/>";'],
    ['a single-quoted string', "x = '<div/>';"],
    ['an escaped quote in a string', 'x = "a\\"<div/>";'],
    ['a template', 'x = `<div/>`;'],
    ['a template with a hole then markup', 'x = `${a} <div/>`;'],
    ['a line comment', 'x = 1; // <div/>\ny = 2;'],
    ['a block comment', 'x = 1; /* <div/> */ y = 2;'],
    ['a regular expression', 'x = /<div\\/>/g;'],
    ['a regex character class holding a slash', 'x = /[/]<div/.test(s);'],
    ['a string holding an HTML comment opener', 'x = "<!-- a -->";']
  ];

  for (const [label, code] of INERT_TEXT) {
    it(`markup-looking text in ${label} is not code`, () => {
      assert.equal(babelFindsJsx(code), false, 'fix the test, this must parse and hold no JSX');
      assert.equal(mayContainJsx(code), false, `should be ruled out: ${JSON.stringify(code)}`);
    });
  }
});

describe('engine/jsxScan : every doubt is answered "maybe" (the caller then parses)', () => {
  const DOUBTS: ReadonlyArray<readonly [string, string]> = [
    ['an unterminated string', 'x = "abc\ny = a<b;'],
    ['an unterminated template', 'x = `abc'],
    ['an unterminated block comment', 'x = 1; /* a<b'],
    ['an unterminated regular expression', 'x = /abc\ny = a<b;'],
    ['an unbalanced closing paren', 'x = a) < b;'],
    ['an unbalanced closing brace', 'x = a } < b;'],
    ['an HTML-style comment opener in code', 'x = 1; <!-- a\ny = 2;'],
    ['an HTML-style comment closer at a line start', 'x = 1;\n--> a\ny = 2;'],
    ['a slash straight after `of`', 'for (const a of /x/) {}'],
    ['a slash straight after `await`', 'await /x/.test(s);'],
    ['a slash straight after `yield`', 'yield /x/;'],
    ['a `<` on a later line than the operand it follows', 'x = a\n<b;']
  ];

  for (const [label, code] of DOUBTS) {
    it(`${label}`, () => {
      assert.equal(mayContainJsx(code), true, `should defer to the parser: ${JSON.stringify(code)}`);
    });
  }

  it('the empty file and whitespace-only files hold no `<`', () => {
    assert.equal(mayContainJsx(''), false);
    assert.equal(mayContainJsx('   \n\t\n'), false);
  });

  it('is pure: the same input gives the same answer twice', () => {
    const code = 'if (a<b) {}\nconst v = <A/>;';
    assert.equal(mayContainJsx(code), mayContainJsx(code));
  });
});

describe('engine/jsxScan : a wrong "no" is the only failure that matters, so prove it does not occur', () => {
  // A small corpus of realistic prefixes (the constructs that make a tokenizer
  // lose its place: regex against division, templates, comments, strings with
  // markup), each followed by a hard-to-spot JSX tail. Whatever the prefix, the
  // tail's element must still be seen.
  const PREFIXES: readonly string[] = [
    '',
    "'use strict';\n",
    'const re = /"/;\n',
    "const re = /'/;\n",
    'const re = /[/]/;\n',
    'const re = /`/;\n',
    'const s = "a // b";\n',
    "const s = 'a /* b';\n",
    'const t = `a ${`b ${c} /* `} d`;\n',
    'const d = a / b / c;\n',
    'const d = (a + b) / 2;\n',
    'const d = arr[0] / 2;\n',
    'const d = i++ / 2;\n',
    'if (x) /re/.test(y);\n',
    'const o = { a: 1 }\n',
    'function f() {}\n/re/.test(s);\n',
    'label: for (;;) { break label }\n',
    '/* a */ // b\n',
    'x = a ? b : c\n',
    'var a = 1, b = a<2;\n',
    'for (const k of list) { if (k<2) continue }\n'
  ];
  const TAILS: readonly string[] = [
    'const __v = <A/>;',
    'const __v = c ? <A/> : <B/>;',
    'function __f() { return <_Foo/>; }',
    'const __v = <></>;',
    'const __v = <$Bar/>;'
  ];

  for (const prefix of PREFIXES) {
    it(`after ${JSON.stringify(prefix)}`, () => {
      for (const tail of TAILS) {
        const code = prefix + tail;
        if (babelFindsJsx(code) !== true) {
          continue; // the combination is not valid JS: nothing to prove
        }
        assert.equal(mayContainJsx(code), true, `lost the JSX in ${JSON.stringify(code)}`);
      }
    });
  }

  it('at least one prefix is valid JS with JSX (the loop above is not vacuous)', () => {
    const valid = PREFIXES.filter((prefix) => babelFindsJsx(prefix + TAILS[0]) === true);
    assert.ok(valid.length >= 15, `only ${valid.length} prefixes parse`);
  });
});

describe('engine/jsxScan : the point of it, speed on a big JSX-free file (P11)', () => {
  it('rules out 2 MB of comparison-laden JS in well under the old parse cost', () => {
    const chunk =
      'function fn(a, b) {\n  if (a<b) { return a + 1; }\n  var s = "x < y", r = /a<b/g;\n' +
      '  for (var k = 0; k<b; k++) { s += k; }\n  return b * 2; // a<b here\n}\n';
    const code = chunk.repeat(Math.ceil((2 * 1024 * 1024) / chunk.length));
    const started = process.hrtime.bigint();
    const answer = mayContainJsx(code);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(answer, false);
    // Typical: 20 to 40 ms. The bound is deliberately loose (a loaded CI box)
    // and still an order of magnitude under the 1.9 to 4.8 s the parse needed
    // for 5 MB (about 0.8 to 2 s for this size).
    assert.ok(elapsedMs < 400, `took ${elapsedMs.toFixed(0)} ms`);
  });
});
