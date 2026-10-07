// Fixtures for the six OPTIONS-6 style options, written so that each option
// REALLY has something to do. The general corpus cannot exercise them: probe P16
// found that none of its 113 JS/TS snippets holds an object literal written with a
// line break after its opening brace, which is the only shape on which
// objectWrap 'preserve' and 'collapse' differ, so objectWrap showed 0 changed
// outputs on it and proved nothing about the option.
//
// Every fixture states the outcome it expects (`changes`): whether the option set
// to its NON-default value changes the output, given the default print width of 80.
// A `changes: false` entry is a control, there on purpose: the option must leave
// it alone, and a test that only ever saw changes could not tell a working option
// from one that rewrites everything.
import type { LangId } from '../../src/types';

export interface OptionFixture {
  readonly id: string;
  readonly lang: LangId;
  readonly input: string;
  /** Does the option, at its non-default value, change this output? */
  readonly changes: boolean;
  readonly note: string;
}

// --- objectWrap: 'collapse' (default 'preserve'), Prettier path ------------------

export const objectWrapFixtures: readonly OptionFixture[] = [
  {
    id: 'OW-01',
    lang: 'typescript',
    input: 'const config = {\n  retries: 3, timeout: 1000 };\n',
    changes: true,
    note: 'a flat literal that fits on one line'
  },
  {
    id: 'OW-02',
    lang: 'typescript',
    input: 'const a = {\n  b: {\n    c: 1 }, d: 2 };\n',
    changes: true,
    note: 'nested literals, both written expanded'
  },
  {
    id: 'OW-03',
    lang: 'typescript',
    input: 'call({\n  a: 1, b: 2 });\n',
    changes: true,
    note: 'a literal as the only call argument'
  },
  {
    id: 'OW-04',
    lang: 'typescript',
    input: 'const xs = [{\n  id: 1 }, {\n  id: 2 }];\n',
    changes: true,
    note: 'literals inside an array'
  },
  {
    id: 'OW-05',
    lang: 'typescript',
    input: 'type T = {\n  a: number; b: string };\n',
    changes: true,
    note: 'a type literal follows the same rule'
  },
  {
    id: 'OW-06',
    lang: 'typescript',
    input: 'function f() {\n  return {\n    a: 1 };\n}\n',
    changes: true,
    note: 'a returned literal'
  },
  {
    id: 'OW-07',
    lang: 'typescript',
    input: 'class K {\n  opts = {\n    a: 1, b: 2 };\n}\n',
    changes: true,
    note: 'a class property initialiser'
  },
  {
    id: 'OW-08',
    lang: 'typescriptreact',
    input: 'const C = () => <div style={{\n  color: "red" }}>x</div>;\n',
    changes: true,
    note: 'the double braces of a JSX style prop'
  },
  {
    id: 'OW-09',
    lang: 'typescriptreact',
    input: 'const [s] = useState({\n  a: 1 });\n',
    changes: true,
    note: 'a hook argument in a .tsx file'
  },
  {
    id: 'OW-10',
    lang: 'javascriptreact',
    input: 'const style = {\n  color: "red" };\nexport const B = () => <b style={style}>x</b>;\n',
    changes: true,
    note: 'a .jsx file'
  },
  {
    id: 'OW-11',
    lang: 'javascript',
    input: 'const style = {\n  color: "red" };\nexport const B = () => <b style={style}>x</b>;\n',
    changes: true,
    note: 'a .js file that contains JSX, so Prettier prints it'
  },
  {
    id: 'OW-12',
    lang: 'typescript',
    input: 'const a = { b: 1 };\n',
    changes: false,
    note: 'control: already on one line'
  },
  {
    id: 'OW-13',
    lang: 'typescript',
    input:
      'const a = {\n  alphaValue: computeTheFirstValue(1), betaValue: computeTheSecondValue(2), gammaValue: 3 };\n',
    changes: false,
    note: 'control: too long to fit on one line either way'
  },
  {
    id: 'OW-14',
    lang: 'typescript',
    input: 'const a = {\n  // note\n  a: 1 };\n',
    changes: false,
    note: 'control: a line comment forces the break'
  },
  {
    id: 'OW-15',
    lang: 'typescript',
    input: 'const {\n  a, b } = o;\n',
    changes: false,
    note: 'control: a destructuring pattern is not an object literal'
  },
  {
    id: 'OW-16',
    lang: 'typescript',
    input: 'interface I {\n  a: number }\n',
    changes: false,
    note: 'control: an interface body is always expanded'
  },
  {
    id: 'OW-17',
    lang: 'typescript',
    input: 'import {\n  a, b } from "x";\nexport {\n  a, b };\n',
    changes: false,
    note: 'control: import and export lists are not object literals'
  }
];

// --- singleAttributePerLine: true (default false), Prettier path -----------------

export const singleAttributePerLineFixtures: readonly OptionFixture[] = [
  {
    id: 'SAPL-01',
    lang: 'typescriptreact',
    input: 'const a = <Foo a="1" b="2" c="3" />;\n',
    changes: true,
    note: 'three attributes'
  },
  {
    id: 'SAPL-02',
    lang: 'typescriptreact',
    input: 'const a = <Foo a="1" b="2" />;\n',
    changes: true,
    note: 'two attributes are already "more than one"'
  },
  {
    id: 'SAPL-03',
    lang: 'typescriptreact',
    input:
      'const a = <div className="x" id="y"><span title="t" lang="en">hi</span></div>;\n',
    changes: true,
    note: 'nested elements, each with several attributes'
  },
  {
    id: 'SAPL-04',
    lang: 'typescriptreact',
    input: 'const a = <div {...props} data-x={1}>x</div>;\n',
    changes: true,
    note: 'a spread attribute counts'
  },
  {
    id: 'SAPL-05',
    lang: 'javascriptreact',
    input: 'const a = <Foo\n  a="1"\n  b="2"\n/>;\n',
    changes: true,
    note: 'already one per line in the source: Prettier puts it back on one line by default'
  },
  {
    id: 'SAPL-06',
    lang: 'javascriptreact',
    input: 'const a = items.map(i => <li key={i.id} className="i">{i.name}</li>);\n',
    changes: true,
    note: 'an element returned from a callback'
  },
  {
    id: 'SAPL-07',
    lang: 'typescriptreact',
    input: 'const a = <button onClick={() => go(1)} disabled type="button">x</button>;\n',
    changes: true,
    note: 'a handler, a boolean attribute and a string attribute'
  },
  {
    id: 'SAPL-08',
    lang: 'javascript',
    input: 'const a = <Foo a="1" b="2" c="3" />;\n',
    changes: true,
    note: 'a .js file that contains JSX, so Prettier prints it'
  },
  {
    id: 'SAPL-09',
    lang: 'typescriptreact',
    input: 'const a = <><Foo a="1" b="2" /><Bar c="3" /></>;\n',
    changes: true,
    note: 'a fragment holding one element with two attributes and one with a single attribute'
  },
  {
    id: 'SAPL-10',
    lang: 'typescriptreact',
    input: 'const a = <Foo a="1" />;\n',
    changes: false,
    note: 'control: a single attribute stays inline'
  },
  {
    id: 'SAPL-11',
    lang: 'typescriptreact',
    input: 'const a = <Foo />;\n',
    changes: false,
    note: 'control: no attribute'
  },
  {
    id: 'SAPL-12',
    lang: 'typescriptreact',
    input: 'const a = <p>hello</p>;\n',
    changes: false,
    note: 'control: text only'
  },
  {
    id: 'SAPL-13',
    lang: 'typescript',
    input: 'const a = <T,>(v: T) => v;\nconst b = <number>x;\n',
    changes: false,
    note: 'control: a .ts file has no JSX, angle brackets there are generics and assertions'
  }
];

// --- HTML: the two tag lists ------------------------------------------------------

/** The user list tried for content_unformatted: one tag the document holds. */
export const EXTRA_CONTENT_UNFORMATTED: readonly string[] = ['code'];

export const contentUnformattedFixtures: readonly OptionFixture[] = [
  {
    id: 'CU-01',
    lang: 'html',
    input: '<div><code>a    b\n   c</code></div>\n',
    changes: true,
    note: 'runs of spaces and a line break inside an added tag are kept as written'
  },
  {
    id: 'CU-02',
    lang: 'html',
    input: '<p>plain    text   here</p>\n',
    changes: false,
    note: 'control: the document holds no <code>'
  },
  {
    id: 'CU-03',
    lang: 'html',
    input: '<div><pre>  a   b\n   c</pre></div>\n',
    changes: false,
    note: 'control: <pre> was already preserved, adding <code> changes nothing there'
  }
];

/** The user list tried for void_elements: a custom element written without a closing tag. */
export const EXTRA_VOID_ELEMENTS: readonly string[] = ['my-icon'];

export const voidElementsFixtures: readonly OptionFixture[] = [
  {
    id: 'VE-01',
    lang: 'html',
    input: '<div><my-icon><p>x</p></div>\n',
    changes: true,
    note: 'an unclosed custom element: without the option its sibling is indented under it'
  },
  {
    id: 'VE-02',
    lang: 'html',
    input: '<ul><li><img src="a.png"><span>x</span></li><li>y</li></ul>\n',
    changes: false,
    note: 'control: the standard void elements behave the same with or without the option'
  },
  {
    id: 'VE-03',
    lang: 'html',
    input: '<div><p>one<br>two</p><hr><input type="text"></div>\n',
    changes: false,
    note: 'control: br, hr and input are still void while the option adds my-icon'
  }
];

// --- JavaScript, js-beautify path --------------------------------------------------

export const spaceBeforeConditionalFixtures: readonly OptionFixture[] = [
  {
    id: 'SBC-01',
    lang: 'javascript',
    input: 'if (a) { b() }\nfor (var i = 0; i < 2; i++) {}\nwhile (x) {}\nswitch (x) { case 1: y(); }\n',
    changes: true,
    note: 'if, for, while and switch all lose their space'
  },
  {
    id: 'SBC-02',
    lang: 'javascript',
    input: 'try { a() } catch (e) { b() }\nvar x = f(1);\n',
    changes: false,
    note: 'control: catch and a plain call are not conditionals'
  }
];

export const jslintHappyFixtures: readonly OptionFixture[] = [
  {
    id: 'JLH-01',
    lang: 'javascript',
    input: 'var f = function() { return 1 };\n',
    changes: true,
    note: 'a space appears after the function keyword'
  },
  {
    id: 'JLH-02',
    lang: 'javascript',
    input: 'switch (x) { case 1: y(); break; default: z(); }\n',
    changes: true,
    note: 'case labels move level with their switch'
  },
  {
    id: 'JLH-03',
    lang: 'javascript',
    input: 'var x = 1;\nfunction named(a) { return a }\n',
    changes: false,
    note: 'control: a named function declaration keeps its own spacing'
  }
];
