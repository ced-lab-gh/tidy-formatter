// Adversarial CORRUPTION corpus for the SAFETY GUARD (SPEC SAFE-01/02 + §5 + §12).
//
// This is the product's core promise stress-tested from the attacker's side:
// every pair below is a (clean input, semantically CORRUPTED output) that a
// formatter must NEVER apply. `guard.check(lang, input, output)` MUST return
// `equivalent: false` with a non-empty reason for ALL of them. A single false
// negative here means Tidy would ship a file whose meaning silently changed —
// exactly the lonefy failure mode (1.69/5, "breaks your files").
//
// Distinct from guardFixtures.ts (the baseline regression set): these are
// harder, more realistic corruptions across the full language matrix, including
// operator swaps, dropped statements, JSX boundary mangling, CSS arithmetic and
// combinator changes, HTML attribute/tag/verbatim-text edits, and JSON value/key
// mutations. They are written to defeat a naive "re-parse only" guard: many of
// the corrupted outputs are themselves syntactically valid (see `stillParses`).
//
// Source of truth: SPEC.md §3/§4/§5/§7/§9/§12, the mandatory acceptance test
// "< Foo bar = {x} />" (SPEC §5), and the empirical js-beautify failure set.
import type { LangId } from '../../src/types';

export interface CorruptionFixture {
  /** Stable id used in the test title. */
  id: string;
  /** What the corruption does and why it must be rejected. */
  desc: string;
  /** Which adversarial class this belongs to (for grouping/reporting). */
  category:
    | 'js'
    | 'jsx'
    | 'ts'
    | 'tsx'
    | 'css'
    | 'scss'
    | 'less'
    | 'html'
    | 'json'
    | 'jsonc';
  lang: LangId;
  input: string;
  /** The semantically-altered output the guard MUST reject. */
  output: string;
  /**
   * Whether the corrupted `output` is itself syntactically valid in its language.
   * `true` marks the dangerous class a parse-only guard would WRONGLY accept —
   * the whole reason the guard compares structure/values, not just parseability.
   * `false` means the corruption also breaks parsing (still must be rejected,
   * but for the easier reason "output did not parse").
   */
  stillParses: boolean;
}

export const corruptionFixtures: CorruptionFixture[] = [
  // ======================================================================
  // JS — statement/operator/literal corruptions
  // ======================================================================
  {
    id: 'CORR-JS-STMT-DROPPED',
    desc: 'a whole statement silently deleted (b() lost) — output still parses, must be rejected',
    category: 'js',
    lang: 'javascript',
    input: 'function run() {\n  a();\n  b();\n  c();\n}',
    output: 'function run() {\n  a();\n  c();\n}',
    stillParses: true
  },
  {
    id: 'CORR-JS-DIV-TO-SUB',
    desc: 'arithmetic operator changed a / b -> a - b (different result) — still valid JS, must be rejected',
    category: 'js',
    lang: 'javascript',
    input: 'const ratio = total / count;',
    output: 'const ratio = total - count;',
    stillParses: true
  },
  {
    id: 'CORR-JS-STRICT-EQ-LOOSENED',
    desc: '=== loosened to == changes coercion semantics — still valid JS, must be rejected',
    category: 'js',
    lang: 'javascript',
    input: 'if (a === b) run();',
    output: 'if (a == b) run();',
    stillParses: true
  },
  {
    id: 'CORR-JS-OPTCHAIN-SPLIT',
    desc: 'optional chaining ?. split to ? . — produces invalid JS, must be rejected',
    category: 'js',
    lang: 'javascript',
    input: 'const name = user?.profile?.name;',
    output: 'const name = user ? .profile ? .name;',
    stillParses: false
  },
  {
    id: 'CORR-JS-BIGINT-SPLIT',
    desc: 'BigInt literal 1n split to 1 n — invalid JS, must be rejected',
    category: 'js',
    lang: 'javascript',
    input: 'const total = 9007199254740993n * 2n;',
    output: 'const total = 9007199254740993 n * 2n;',
    stillParses: false
  },
  {
    id: 'CORR-JS-COMPOUND-ASSIGN-SPLIT',
    desc: 'compound assignment += split to + = — invalid JS, must be rejected',
    category: 'js',
    lang: 'javascript',
    input: 'let acc = 0;\nacc += step;',
    output: 'let acc = 0;\nacc + = step;',
    stillParses: false
  },
  {
    id: 'CORR-JS-NEGATION-DROPPED',
    desc: 'logical negation dropped (!ready -> ready) inverts the branch — still valid JS, must be rejected',
    category: 'js',
    lang: 'javascript',
    input: 'if (!ready) abort();',
    output: 'if (ready) abort();',
    stillParses: true
  },
  {
    id: 'CORR-JS-AWAIT-DROPPED',
    desc: 'await keyword dropped changes async semantics — still valid JS, must be rejected',
    category: 'js',
    lang: 'javascript',
    input: 'async function f() {\n  const r = await fetchData();\n  return r;\n}',
    output: 'async function f() {\n  const r = fetchData();\n  return r;\n}',
    stillParses: true
  },

  // ======================================================================
  // JSX — boundary/structure corruptions (whitespace-insignificant to babel)
  // ======================================================================
  {
    id: 'CORR-JSX-SELFCLOSE-MANGLED',
    desc: '<Foo/> mangled to < Foo / > — re-parses as valid JSX but tag boundary corrupt, must be rejected',
    category: 'jsx',
    lang: 'javascriptreact',
    input: 'const el = <Foo/>;',
    output: 'const el = < Foo / >;',
    stillParses: true
  },
  {
    id: 'CORR-JSX-OPEN-SPLIT',
    desc: '<Foo> open tag split to < Foo> — boundary corrupt, must be rejected',
    category: 'jsx',
    lang: 'javascriptreact',
    input: 'const el = <Foo>x</Foo>;',
    output: 'const el = < Foo>x</Foo>;',
    stillParses: true
  },
  {
    id: 'CORR-JSX-TAG-RENAMED',
    desc: 'JSX element renamed <Foo> -> <Bar> changes the rendered component, must be rejected',
    category: 'jsx',
    lang: 'javascriptreact',
    input: 'const el = <Foo prop={1}>child</Foo>;',
    output: 'const el = <Bar prop={1}>child</Bar>;',
    stillParses: true
  },
  {
    id: 'CORR-JSX-ATTR-DROPPED',
    desc: 'a JSX attribute silently dropped (key removed) changes props, must be rejected',
    category: 'jsx',
    lang: 'javascriptreact',
    input: 'const el = <Item id={id} key={id} label="x" />;',
    output: 'const el = <Item id={id} label="x" />;',
    stillParses: true
  },
  {
    id: 'CORR-JSX-CLOSE-SPLIT',
    desc: 'closing tag </Foo> split to < /Foo> — boundary corrupt, must be rejected',
    category: 'jsx',
    lang: 'javascriptreact',
    input: 'const el = <Foo>x</Foo>;',
    output: 'const el = <Foo>x< /Foo>;',
    stillParses: true
  },

  // ======================================================================
  // TS — type-level corruptions
  // ======================================================================
  {
    id: 'CORR-TS-ANNOTATION-CHANGED',
    desc: 'parameter type annotation changed number -> string is a semantic change, must be rejected',
    category: 'ts',
    lang: 'typescript',
    input: 'function area(n: number): number {\n  return n * n;\n}',
    output: 'function area(n: string): number {\n  return n * n;\n}',
    stillParses: true
  },
  {
    id: 'CORR-TS-GENERIC-MANGLED-ANNOTATION-DROPPED',
    desc: "the real js-beautify generic corruption: function f<T>(x: T) -> f < T > (x) drops the type annotation, must be rejected",
    category: 'ts',
    lang: 'typescript',
    input: 'function f<T>(x: T): T {\n  return x;\n}',
    output: 'function f < T > (x) {\n  return x;\n}',
    stillParses: true
  },
  {
    id: 'CORR-TS-RETURN-TYPE-DROPPED',
    desc: 'return type annotation dropped : number -> (none) is a semantic change, must be rejected',
    category: 'ts',
    lang: 'typescript',
    input: 'function count(): number {\n  return items.length;\n}',
    output: 'function count() {\n  return items.length;\n}',
    stillParses: true
  },
  {
    id: 'CORR-TS-OPTIONAL-DROPPED',
    desc: 'optional marker dropped (x?: T -> x: T) makes a required parameter, must be rejected',
    category: 'ts',
    lang: 'typescript',
    input: 'function greet(name?: string) {\n  return name;\n}',
    output: 'function greet(name: string) {\n  return name;\n}',
    stillParses: true
  },
  {
    id: 'CORR-TS-UNION-NARROWED',
    desc: 'union type narrowed string | number -> string drops a member, must be rejected',
    category: 'ts',
    lang: 'typescript',
    input: 'let v: string | number;',
    output: 'let v: string;',
    stillParses: true
  },

  // ======================================================================
  // TSX — JSX + TS combined
  // ======================================================================
  {
    id: 'CORR-TSX-MANDATORY-ACCEPTANCE',
    desc: 'SPEC §5 mandatory test: <Foo bar={x} /> -> < Foo bar = {x} /> re-parses as TSX yet MUST be rejected',
    category: 'tsx',
    lang: 'typescriptreact',
    input: 'const el = <Foo bar={x} />;',
    output: 'const el = < Foo bar = {x} />;',
    stillParses: true
  },
  {
    id: 'CORR-TSX-GENERIC-COMPONENT-RENAMED',
    desc: 'generic component <Grid<Row> /> renamed to <Table<Row> /> changes the component, must be rejected',
    category: 'tsx',
    lang: 'typescriptreact',
    input: 'const g = <Grid<Row> data={rows} />;',
    output: 'const g = <Table<Row> data={rows} />;',
    stillParses: true
  },
  {
    id: 'CORR-TSX-AS-CAST-CHANGED',
    desc: 'as-cast target type changed (as Foo -> as Bar) is a semantic change, must be rejected',
    category: 'tsx',
    lang: 'typescriptreact',
    input: 'const v = (x as Foo).id;',
    output: 'const v = (x as Bar).id;',
    stillParses: true
  },

  // ======================================================================
  // CSS — value/selector/combinator corruptions
  // ======================================================================
  {
    id: 'CORR-CSS-CALC-SIGN-FLIPPED',
    desc: 'calc(100% + 10px) arithmetic flipped to calc(100% - 10px) changes the computed length, must be rejected',
    category: 'css',
    lang: 'css',
    input: '.box {\n  width: calc(100% + 10px);\n}',
    output: '.box {\n  width: calc(100% - 10px);\n}',
    stillParses: true
  },
  {
    id: 'CORR-CSS-DESCENDANT-TO-COMPOUND',
    desc: 'descendant selector .a .b collapsed to .a.b targets a different element set, must be rejected',
    category: 'css',
    lang: 'css',
    input: '.a .b {\n  color: red;\n}',
    output: '.a.b {\n  color: red;\n}',
    stillParses: true
  },
  {
    id: 'CORR-CSS-NTH-CHILD-BROKEN',
    desc: ':nth-child(2n) split to :nth-child(2 n) breaks the An+B microsyntax, must be rejected',
    category: 'css',
    lang: 'css',
    input: 'li:nth-child(2n) {\n  background: gray;\n}',
    output: 'li:nth-child(2 n) {\n  background: gray;\n}',
    stillParses: true
  },
  {
    id: 'CORR-CSS-DESCENDANT-TO-CHILD',
    desc: 'descendant .a .b rewritten to child .a>.b changes the matched depth, must be rejected',
    category: 'css',
    lang: 'css',
    input: '.a .b {\n  color: red;\n}',
    output: '.a>.b {\n  color: red;\n}',
    stillParses: true
  },
  {
    id: 'CORR-CSS-IMPORTANT-DROPPED',
    desc: '!important dropped changes the cascade priority, must be rejected',
    category: 'css',
    lang: 'css',
    input: '.a {\n  color: red !important;\n}',
    output: '.a {\n  color: red;\n}',
    stillParses: true
  },
  {
    id: 'CORR-CSS-UNIT-CHANGED',
    desc: 'a unit silently changed 16px -> 16em is a different computed value, must be rejected',
    category: 'css',
    lang: 'css',
    input: '.t {\n  font-size: 16px;\n}',
    output: '.t {\n  font-size: 16em;\n}',
    stillParses: true
  },

  // ======================================================================
  // SCSS — nesting/extend/interpolation corruptions
  // ======================================================================
  {
    id: 'CORR-SCSS-EXTEND-MANGLED',
    desc: '@extend .a:hover mangled to @extend .a: hover changes the extended placeholder, must be rejected',
    category: 'scss',
    lang: 'scss',
    input: '.link {\n  @extend .btn:hover;\n}',
    output: '.link {\n  @extend .btn: hover;\n}',
    stillParses: true
  },
  {
    id: 'CORR-SCSS-VAR-VALUE-CHANGED',
    desc: 'a SCSS variable value silently changed $pad: 8px -> 16px is a semantic change, must be rejected',
    category: 'scss',
    lang: 'scss',
    input: '$pad: 8px;\n.a {\n  padding: $pad;\n}',
    output: '$pad: 16px;\n.a {\n  padding: $pad;\n}',
    stillParses: true
  },

  // ======================================================================
  // LESS — variable/operation corruptions
  // ======================================================================
  {
    id: 'CORR-LESS-VAR-RENAMED',
    desc: 'a LESS variable reference renamed @primary -> @secondary resolves to a different color, must be rejected',
    category: 'less',
    lang: 'less',
    input: '@primary: #333;\n.a {\n  color: @primary;\n}',
    output: '@primary: #333;\n.a {\n  color: @secondary;\n}',
    stillParses: true
  },

  // ======================================================================
  // HTML — attribute/tag/verbatim-text corruptions
  // ======================================================================
  {
    id: 'CORR-HTML-ATTR-VALUE-CHANGED',
    desc: 'an href value silently changed (real.html -> evil.html) is a corruption, must be rejected',
    category: 'html',
    lang: 'html',
    input: '<a href="real.html">go</a>',
    output: '<a href="evil.html">go</a>',
    stillParses: true
  },
  {
    id: 'CORR-HTML-TAG-CHANGED',
    desc: 'an element renamed <strong> -> <em> changes semantics, must be rejected',
    category: 'html',
    lang: 'html',
    input: '<p><strong>warn</strong></p>',
    output: '<p><em>warn</em></p>',
    stillParses: true
  },
  {
    id: 'CORR-HTML-PRE-TEXT-COLLAPSED',
    desc: 'whitespace-significant <pre> text reflowed (newlines/indent collapsed) changes meaning, must be rejected',
    category: 'html',
    lang: 'html',
    input: '<pre>line 1\n  indented 2\nline 3</pre>',
    output: '<pre>line 1 indented 2 line 3</pre>',
    stillParses: true
  },
  {
    id: 'CORR-HTML-BOOLEAN-ATTR-DROPPED',
    desc: 'a boolean attribute dropped (disabled removed) changes behavior, must be rejected',
    category: 'html',
    lang: 'html',
    input: '<button disabled>Send</button>',
    output: '<button>Send</button>',
    stillParses: true
  },
  {
    id: 'CORR-HTML-SCRIPT-BODY-CHANGED',
    desc: 'verbatim <script> body altered (var a=1 -> var a=2) changes runtime behavior, must be rejected',
    category: 'html',
    lang: 'html',
    input: '<script>var token = 1;</script>',
    output: '<script>var token = 2;</script>',
    stillParses: true
  },

  // ======================================================================
  // JSON — value/key/number corruptions
  // ======================================================================
  {
    id: 'CORR-JSON-VALUE-CHANGED',
    desc: 'a boolean value flipped true -> false is a corruption, must be rejected',
    category: 'json',
    lang: 'json',
    input: '{ "enabled": true }',
    output: '{ "enabled": false }',
    stillParses: true
  },
  {
    id: 'CORR-JSON-KEY-DROPPED',
    desc: 'a key silently dropped (deep) is a structural change, must be rejected',
    category: 'json',
    lang: 'json',
    input: '{ "config": { "a": 1, "b": 2, "c": 3 } }',
    output: '{ "config": { "a": 1, "c": 3 } }',
    stillParses: true
  },
  {
    id: 'CORR-JSON-NUMBER-MODIFIED',
    desc: 'a number modified by a representable amount (1e308 -> 1e307) is a corruption, must be rejected',
    category: 'json',
    lang: 'json',
    input: '{ "max": 1e308 }',
    output: '{ "max": 1e307 }',
    stillParses: true
  },
  {
    id: 'CORR-JSON-NESTED-ARRAY-VALUE',
    desc: 'a value buried in nested arrays changed ([..,3,..] -> 4) is a corruption, must be rejected',
    category: 'json',
    lang: 'json',
    input: '{ "matrix": [[1, 2], [3, 4]] }',
    output: '{ "matrix": [[1, 2], [9, 4]] }',
    stillParses: true
  },

  // ======================================================================
  // JSONC — value corruption under comments/trailing commas
  // ======================================================================
  {
    id: 'CORR-JSONC-VALUE-CHANGED-UNDER-COMMENTS',
    desc: 'JSONC with comments + trailing commas whose value is changed must still be rejected (comments are not a shield)',
    category: 'jsonc',
    lang: 'jsonc',
    input: '{\n  // app name\n  "name": "tidy",\n  "port": 3000, // dev port\n}',
    output: '{\n  "name": "tidy",\n  "port": 8080\n}',
    stillParses: true
  }
];
