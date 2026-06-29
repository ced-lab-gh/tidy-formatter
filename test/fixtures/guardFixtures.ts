// Anti-incumbent regression corpus for the SAFETY GUARD (SPEC SAFE-01/02/03).
//
// Each fixture is derived from a concrete lonefy bug (GitHub issue or store
// review) and asserts a *property* of guard.check(lang, input, output):
//   - `equivalent: false` cases are real corruptions the incumbent shipped and
//     the guard MUST reject (the file stays intact upstream).
//   - `equivalent: true` cases are legitimate reformattings (whitespace/style
//     only) the guard MUST accept, so the formatter is not a useless no-op.
//
// Source of truth: SPEC.md §3/§4/§7/§9, spec.json pain_clusters,
// data/github_issues_raw.json, data/store_reviews_text.md.
import type { LangId } from '../../src/types';

export interface GuardFixture {
  /** Stable id used in the test title. */
  id: string;
  /** Human-readable description of the bug/property. */
  desc: string;
  /** Evidence reference (issue #, review text, or SPEC requirement). */
  ref: string;
  lang: LangId;
  input: string;
  output: string;
  /** Expected guard verdict: true = accept (equivalent), false = reject. */
  equivalent: boolean;
}

export const guardFixtures: GuardFixture[] = [
  // ---- JS/TS/JSX/TSX: corruptions that MUST be rejected -------------------
  {
    id: 'GUARD-JSX-MANGLE',
    desc: 'mandatory acceptance test: <Foo bar={x} /> mangled to < Foo bar = {x} /> (re-parses but corrupt) must be rejected',
    ref: 'SPEC SAFE-01 / review "It formats <App /> to < App / >" / #26,#64,#76',
    lang: 'typescriptreact',
    input: '<Foo bar={x} />;',
    output: '< Foo bar = {x} />;',
    equivalent: false
  },
  {
    id: 'GUARD-JSX-APP-SPLIT',
    desc: 'JSX <App /> split across lines with broken tag boundary must be rejected',
    ref: 'review "It formats <App /> to <\\nApp / >" / #80',
    lang: 'javascriptreact',
    input: '<App />;',
    output: '<\n  App / >;',
    equivalent: false
  },
  {
    id: 'GUARD-RN-VIEW',
    desc: 'React Native <View style={styles.container}> broken tag-open must be rejected',
    ref: '#26 "Destroying the code with React Native"',
    lang: 'javascriptreact',
    input: '<View style={styles.container}>x</View>;',
    output: '<\n  View style={styles.container}>x</View>;',
    equivalent: false
  },
  {
    id: 'GUARD-NULLISH-SPLIT',
    desc: '?? split into ? ? produces unparsable output, must be rejected',
    ref: '#136,#150 "Null-coalescing operator characters split"',
    lang: 'javascript',
    input: 'const x = a ?? b;',
    output: 'const x = a ? ? b;',
    equivalent: false
  },
  {
    id: 'GUARD-OPTCHAIN-SPLIT',
    desc: '?. split into ? . (or ?.length to ? .length) must be rejected',
    ref: '#128,#146 "Changing my valid ?. to ? . on save"',
    lang: 'javascript',
    input: 'const n = obj?.length;',
    output: 'const n = obj ? .length;',
    equivalent: false
  },
  {
    id: 'GUARD-PRIVATE-FIELD-NEWLINE',
    desc: 'private field #x split with a newline (# then name) is invalid JS, must be rejected',
    ref: '#141 "Unwanted line break in javascript class private fields"',
    lang: 'javascript',
    input: 'class C {\n  #x = 1;\n}',
    output: 'class C {\n  #\n  x = 1;\n}',
    equivalent: false
  },
  {
    id: 'GUARD-BIGINT-SPLIT',
    desc: 'BigInt literal 1n split into 1 n is a syntax error, must be rejected',
    ref: 'review "big integer number like 1n are formatted as 1 n"',
    lang: 'javascript',
    input: 'const big = 1n;',
    output: 'const big = 1 n;',
    equivalent: false
  },
  {
    id: 'GUARD-GENERIC-SPLIT',
    desc: 'TS generic function f<T> spread to f < T > changes meaning / breaks, must be rejected',
    ref: 'SPEC §4 "function f<T> -> function f < T >"',
    lang: 'typescript',
    input: 'function f<T>(x: T): T { return x; }',
    output: 'function f < T > (x) {\n  return x;\n}',
    equivalent: false
  },
  {
    id: 'GUARD-IMPORT-DROPPED',
    desc: 'an import that silently loses a named binding is a semantic change, must be rejected',
    ref: '#9 imports / SAFE-01 semantic equivalence',
    lang: 'javascript',
    input: "import { A, B } from 'm';",
    output: "import { A } from 'm';",
    equivalent: false
  },
  {
    id: 'GUARD-VALUE-CHANGED',
    desc: 'a string literal value silently changed is a semantic change, must be rejected',
    ref: 'reviews "breaks your files" / SAFE-01',
    lang: 'javascript',
    input: "const url = 'https://a.example';",
    output: "const url = 'https://b.example';",
    equivalent: false
  },
  {
    id: 'GUARD-INPUT-INVALID',
    desc: 'input that does not parse cannot be proven equivalent, must be rejected (file left intact)',
    ref: 'SPEC §safety: conservative on unparsable input',
    lang: 'javascript',
    input: 'const x = ;',
    output: 'const x = 1;',
    equivalent: false
  },

  // ---- JS/TS/JSX/TSX: legitimate reformattings that MUST be accepted ------
  {
    id: 'GUARD-JS-WHITESPACE-OK',
    desc: 'pure whitespace reformatting of plain JS is equivalent and accepted',
    ref: 'SAFE-01 "modulo whitespace"',
    lang: 'javascript',
    input: 'const x=1;function f(){return x;}',
    output: 'const x = 1;\n\nfunction f() {\n  return x;\n}\n',
    equivalent: true
  },
  {
    id: 'GUARD-JSX-MULTILINE-OK',
    desc: 'JSX legitimately reflowed onto multiple lines (tag boundaries intact) is accepted',
    ref: 'SPEC §4 note: must not false-positive on real reformat',
    lang: 'typescriptreact',
    input: '<App a={1} b={2} c={3} />;',
    output: '<App\n  a={1}\n  b={2}\n  c={3}\n/>;',
    equivalent: true
  },
  {
    // REGRESSION (fixed): a CONTAINER element (not self-closing) with a long
    // attribute list is exploded by Prettier so the bare closing `>` lands on its
    // OWN line. The earlier jsxBoundaryFingerprint fingerprinted the `>`
    // adjacency too, so it reported close:glued (input) vs close:split (output)
    // and FALSE-POSITIVE-REJECTED this correct reflow — making Tidy a silent
    // no-op on essentially every real .tsx component with wrapped attributes
    // (caught end-to-end by test/integration/complex.test.ts HX-TSX-BIG-COMPONENT).
    // The fingerprint now tracks only the OPENING `<` adjacency, so this is
    // accepted while `< Foo` / `< /Foo>` style corruption is still rejected.
    id: 'GUARD-JSX-CONTAINER-MULTILINE-OK',
    desc: 'container element with exploded attrs whose closing `>` is on its own line is accepted (SPEC §12 faux positif)',
    ref: 'SPEC §12 "faux positif de la garde" / regression: multi-line container tag',
    lang: 'typescriptreact',
    input: '<div a={1} b={2} c={3}>x</div>;',
    output: '<div\n  a={1}\n  b={2}\n  c={3}\n>\n  x\n</div>;',
    equivalent: true
  },
  {
    id: 'GUARD-IMPORT-EXPLODED-OK',
    desc: 'named imports exploded onto multiple lines keep the same bindings, accepted (whitespace only)',
    ref: '#9: the explosion is annoying but semantically equivalent (drift is SAFE-03 territory)',
    lang: 'javascript',
    input: "import { A, B } from 'm';",
    output: "import {\n  A,\n  B\n} from 'm';",
    equivalent: true
  },
  {
    id: 'GUARD-NULLISH-OK',
    desc: '?? preserved exactly is equivalent and accepted',
    ref: 'SPEC ENG-02: js-beautify 1.15.4 keeps ?? intact',
    lang: 'javascript',
    input: 'const x=a??b;',
    output: 'const x = a ?? b;',
    equivalent: true
  },
  {
    id: 'GUARD-TS-OK',
    desc: 'TypeScript with generics reformatted by a real parser engine stays equivalent',
    ref: 'ENG-01 real-parser engine for TS',
    lang: 'typescript',
    input: 'function f<T>(x:T):T{return x;}',
    output: 'function f<T>(x: T): T {\n  return x;\n}\n',
    equivalent: true
  },

  // ---- CSS / SCSS / LESS: corruptions that MUST be rejected ---------------
  {
    id: 'GUARD-CSS-NTH-BROKEN',
    desc: ':nth-child(2n) corrupted to :nth-child(2 n) breaks the selector, must be rejected',
    ref: '#77,#78 SASS selector spacing',
    lang: 'css',
    input: '.s:nth-child(2n) { color: red; }',
    output: '.s:nth-child(2 n) { color: red; }',
    equivalent: false
  },
  {
    id: 'GUARD-CSS-NOT-BROKEN',
    desc: ':not(:first-child) corrupted to :not(: first-child) breaks compile, must be rejected',
    ref: '#17 "css with not and nth-child"',
    lang: 'css',
    input: '.state:not(:first-child) { color: red; }',
    output: '.state:not(: first-child) { color: red; }',
    equivalent: false
  },
  {
    id: 'GUARD-CSS-COMMA-SPLIT-VALUE',
    desc: 'comma value Helvetica,sans-serif with an injected token is a value change, must be rejected',
    ref: '#78 / review 126 comma-value ruination',
    lang: 'css',
    input: 'body { font-family: Helvetica, sans-serif; }',
    output: 'body { font-family: Helvetica, serif; }',
    equivalent: false
  },
  {
    id: 'GUARD-CSS-PROP-CHANGED',
    desc: 'a property value silently changed is rejected',
    ref: 'reviews "ruined my .css"',
    lang: 'css',
    input: '.a { margin: 2rem; }',
    output: '.a { margin: 4rem; }',
    equivalent: false
  },
  {
    id: 'GUARD-SCSS-EXTEND-BROKEN',
    desc: 'SCSS @extend a:hover broken to a: hover changes the params, must be rejected',
    ref: '#77 "@extend a: hover"',
    lang: 'scss',
    input: '.hoverlink { @extend a:hover; }',
    output: '.hoverlink { @extend a: hover; }',
    equivalent: false
  },
  {
    id: 'GUARD-CSS-INVALID-OUTPUT',
    desc: 'output that does not parse as CSS is rejected',
    ref: 'SAFE-02 re-tokenise',
    lang: 'css',
    input: '.a { color: red; }',
    output: '.a { color: red; ',
    equivalent: false
  },

  // ---- CSS / SCSS / LESS: legitimate reformattings accepted ---------------
  {
    id: 'GUARD-CSS-WHITESPACE-OK',
    desc: 'plain CSS reformatted (newlines, indent) is equivalent and accepted',
    ref: 'SAFE-02 must not no-op on valid output',
    lang: 'css',
    input: '.a{color:red;margin:0}',
    output: '.a {\n  color: red;\n  margin: 0\n}',
    equivalent: true
  },
  {
    id: 'GUARD-CSS-COMBINATOR-CHILD-OK',
    desc: 'child combinator #a > #b vs #a>#b are the SAME selector (whitespace around > insignificant), accepted',
    ref: '#67 / FALSE-POSITIVE guard fix: js-beautify emits #a>#b',
    lang: 'css',
    input: '#a > #b { color: red; }',
    output: '#a>#b {\n  color: red;\n}',
    equivalent: true
  },
  {
    id: 'GUARD-CSS-COMBINATOR-SIBLING-OK',
    desc: 'adjacent/general sibling combinators .a + .b / .x ~ .y tightened by js-beautify are equivalent, accepted',
    ref: '#67 combinator false-positive (+ and ~)',
    lang: 'css',
    input: '.a + .b { color: blue; }\n.x ~ .y { color: green; }',
    output: '.a+.b {\n  color: blue;\n}\n\n.x~.y {\n  color: green;\n}',
    equivalent: true
  },
  {
    id: 'GUARD-CSS-DESCENDANT-PRESERVED',
    desc: 'descendant combinator (.a .b) must NOT be confused with child (.a>.b): they are different, reject',
    ref: 'CSS correctness: a meaningful space must stay meaningful',
    lang: 'css',
    input: '.a .b { color: red; }',
    output: '.a>.b {\n  color: red;\n}',
    equivalent: false
  },
  {
    id: 'GUARD-SCSS-NESTED-OK',
    desc: 'SCSS nested rules reformatted are equivalent and accepted',
    ref: 'ENG-05 SCSS compile-safe',
    lang: 'scss',
    input: '.card{.title{color:red}}',
    output: '.card {\n  .title {\n    color: red\n  }\n}',
    equivalent: true
  },
  {
    id: 'GUARD-LESS-OK',
    desc: 'LESS reformatting preserving variables is accepted',
    ref: 'less family support',
    lang: 'less',
    input: '@c: red; .a{color:@c}',
    output: '@c: red;\n\n.a {\n  color: @c\n}',
    equivalent: true
  },

  // ---- HTML: corruptions that MUST be rejected ---------------------------
  {
    id: 'GUARD-HTML-ATTR-VALUE-SPACE',
    desc: 'space injected inside an attribute value (href=" x ") changes the value, must be rejected',
    ref: '#106,#116 "adds spaces inside double quotes", review 116',
    lang: 'html',
    input: '<a href="page.html">y</a>',
    output: '<a href=" page.html ">y</a>',
    equivalent: false
  },
  {
    id: 'GUARD-HTML-TEXT-SPLIT-PRE',
    desc: 'whitespace-significant <pre> text reflowed changes meaning, must be rejected',
    ref: '#88 EOL for inner text / pre is verbatim',
    lang: 'html',
    input: '<pre>line one\nline two</pre>',
    output: '<pre>line one line two</pre>',
    equivalent: false
  },
  {
    id: 'GUARD-HTML-TAG-DROPPED',
    desc: 'a dropped child element is a structural change, must be rejected',
    ref: 'reviews "destroys your HTML anchor points"',
    lang: 'html',
    input: '<ul><li>a</li><li>b</li></ul>',
    output: '<ul>\n  <li>a</li>\n</ul>',
    equivalent: false
  },

  // ---- HTML: legitimate reformattings accepted --------------------------
  {
    id: 'GUARD-HTML-INDENT-OK',
    desc: 'HTML pretty-printed (indented children, collapsed insignificant whitespace) is accepted',
    ref: 'SAFE-02 must not no-op on valid HTML',
    lang: 'html',
    input: '<div><p>hi</p></div>',
    output: '<div>\n  <p>hi</p>\n</div>',
    equivalent: true
  },
  {
    id: 'GUARD-HTML-ATTR-REORDER-OK',
    desc: 'attribute reorder is not semantically meaningful in HTML, accepted',
    ref: 'guard sorts attrs by name',
    lang: 'html',
    input: '<input type="text" name="q">',
    output: '<input name="q" type="text">',
    equivalent: true
  },

  // ---- JSON / JSONC: corruptions that MUST be rejected -------------------
  {
    id: 'GUARD-JSON-VALUE-CHANGED',
    desc: 'a JSON value silently changed is rejected',
    ref: '#134 "ruins package.json" / reviews JSON corruption',
    lang: 'json',
    input: '{"version":"1.0.0"}',
    output: '{"version":"2.0.0"}',
    equivalent: false
  },
  {
    id: 'GUARD-JSON-KEY-DROPPED',
    desc: 'a dropped JSON key is a structural change, rejected',
    ref: '#134 package.json corruption',
    lang: 'json',
    input: '{"a":1,"b":2}',
    output: '{"a":1}',
    equivalent: false
  },
  {
    id: 'GUARD-JSON-ARRAY-REORDER',
    desc: 'JSON array order is meaningful; a reorder must be rejected',
    ref: 'JSON semantics',
    lang: 'json',
    input: '{"deps":[1,2,3]}',
    output: '{"deps":[3,2,1]}',
    equivalent: false
  },
  {
    id: 'GUARD-JSON-INVALID-OUTPUT',
    desc: 'output that is not valid JSON (missing closing brace) is rejected',
    ref: 'SAFE re-parse',
    lang: 'json',
    input: '{"a":1}',
    output: '{"a":1',
    equivalent: false
  },

  // ---- JSON / JSONC: legitimate reformattings accepted ------------------
  {
    id: 'GUARD-JSON-PRETTY-OK',
    desc: 'JSON pretty-printed (whitespace only) is equivalent and accepted',
    ref: 'SAFE must not no-op on valid JSON',
    lang: 'json',
    input: '{"a":1,"b":[1,2]}',
    output: '{\n  "a": 1,\n  "b": [1, 2]\n}',
    equivalent: true
  },
  {
    id: 'GUARD-JSON-KEY-REORDER-OK',
    desc: 'JSON object key order is not semantically meaningful; a reorder is accepted',
    ref: 'JSON semantics: object is unordered',
    lang: 'json',
    input: '{"a":1,"b":2}',
    output: '{"b":2,"a":1}',
    equivalent: true
  },
  {
    id: 'GUARD-JSONC-COMMENTS-OK',
    desc: 'JSONC with comments reformatted keeps the same values, accepted',
    ref: 'jsonc support / comment movement is style',
    lang: 'jsonc',
    input: '{\n  // a comment\n  "a": 1,\n}',
    output: '{\n  "a": 1\n}',
    equivalent: true
  }
];
