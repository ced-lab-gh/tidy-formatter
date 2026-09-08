// Adversarial CORRUPTION corpus for the SAFETY GUARD (SPEC SAFE-01/02 + §5 + §12).
//
// This is the product's core promise stress-tested from the attacker's side:
// every pair below is a (clean input, semantically CORRUPTED output) that a
// formatter must NEVER apply. `guard.check(lang, input, output)` MUST return
// `equivalent: false` with a non-empty reason for ALL of them. A single false
// negative here means Tidy would ship a file whose meaning silently changed , 
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
   * `true` marks the dangerous class a parse-only guard would WRONGLY accept , 
   * the whole reason the guard compares structure/values, not just parseability.
   * `false` means the corruption also breaks parsing (still must be rejected,
   * but for the easier reason "output did not parse").
   */
  stillParses: boolean;
}

export const corruptionFixtures: CorruptionFixture[] = [
  // ======================================================================
  // JS : statement/operator/literal corruptions
  // ======================================================================
  {
    id: 'CORR-JS-STMT-DROPPED',
    desc: 'a whole statement silently deleted (b() lost) : output still parses, must be rejected',
    category: 'js',
    lang: 'javascript',
    input: 'function run() {\n  a();\n  b();\n  c();\n}',
    output: 'function run() {\n  a();\n  c();\n}',
    stillParses: true
  },
  {
    id: 'CORR-JS-DIV-TO-SUB',
    desc: 'arithmetic operator changed a / b -> a - b (different result) : still valid JS, must be rejected',
    category: 'js',
    lang: 'javascript',
    input: 'const ratio = total / count;',
    output: 'const ratio = total - count;',
    stillParses: true
  },
  {
    id: 'CORR-JS-STRICT-EQ-LOOSENED',
    desc: '=== loosened to == changes coercion semantics : still valid JS, must be rejected',
    category: 'js',
    lang: 'javascript',
    input: 'if (a === b) run();',
    output: 'if (a == b) run();',
    stillParses: true
  },
  {
    id: 'CORR-JS-OPTCHAIN-SPLIT',
    desc: 'optional chaining ?. split to ? . : produces invalid JS, must be rejected',
    category: 'js',
    lang: 'javascript',
    input: 'const name = user?.profile?.name;',
    output: 'const name = user ? .profile ? .name;',
    stillParses: false
  },
  {
    id: 'CORR-JS-BIGINT-SPLIT',
    desc: 'BigInt literal 1n split to 1 n : invalid JS, must be rejected',
    category: 'js',
    lang: 'javascript',
    input: 'const total = 9007199254740993n * 2n;',
    output: 'const total = 9007199254740993 n * 2n;',
    stillParses: false
  },
  {
    id: 'CORR-JS-COMPOUND-ASSIGN-SPLIT',
    desc: 'compound assignment += split to + = : invalid JS, must be rejected',
    category: 'js',
    lang: 'javascript',
    input: 'let acc = 0;\nacc += step;',
    output: 'let acc = 0;\nacc + = step;',
    stillParses: false
  },
  {
    id: 'CORR-JS-NEGATION-DROPPED',
    desc: 'logical negation dropped (!ready -> ready) inverts the branch : still valid JS, must be rejected',
    category: 'js',
    lang: 'javascript',
    input: 'if (!ready) abort();',
    output: 'if (ready) abort();',
    stillParses: true
  },
  {
    id: 'CORR-JS-AWAIT-DROPPED',
    desc: 'await keyword dropped changes async semantics : still valid JS, must be rejected',
    category: 'js',
    lang: 'javascript',
    input: 'async function f() {\n  const r = await fetchData();\n  return r;\n}',
    output: 'async function f() {\n  const r = fetchData();\n  return r;\n}',
    stillParses: true
  },

  // ======================================================================
  // JSX : boundary/structure corruptions (whitespace-insignificant to babel)
  // ======================================================================
  {
    id: 'CORR-JSX-SELFCLOSE-MANGLED',
    desc: '<Foo/> mangled to < Foo / > : re-parses as valid JSX but tag boundary corrupt, must be rejected',
    category: 'jsx',
    lang: 'javascriptreact',
    input: 'const el = <Foo/>;',
    output: 'const el = < Foo / >;',
    stillParses: true
  },
  {
    id: 'CORR-JSX-OPEN-SPLIT',
    desc: '<Foo> open tag split to < Foo> : boundary corrupt, must be rejected',
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
    desc: 'closing tag </Foo> split to < /Foo> : boundary corrupt, must be rejected',
    category: 'jsx',
    lang: 'javascriptreact',
    input: 'const el = <Foo>x</Foo>;',
    output: 'const el = <Foo>x< /Foo>;',
    stillParses: true
  },

  // JSX TEXT : @babel/parser keeps an interior run of spaces on a single line
  // exactly as written, so the run is part of the string the file COMPILES to.
  // Prettier collapses it, betting a browser will collapse it on display; that
  // bet is wrong for an i18n key, for React Native, and for anything a <pre>
  // ends up drawing. Every pair below therefore MUST be rejected, whether the
  // change adds, removes or collapses whitespace.
  {
    id: 'CORR-JSX-TEXT-RUN-COLLAPSED',
    desc: 'an interior run of spaces collapsed changes the compiled string, must be rejected',
    category: 'jsx',
    lang: 'javascriptreact',
    input: 'const el = <p>hello  there</p>;',
    output: 'const el = <p>hello there</p>;',
    stillParses: true
  },
  {
    id: 'CORR-TSX-I18N-KEY-COLLAPSED',
    desc: 'an i18n message id loses a space and silently becomes a different lookup key, must be rejected',
    category: 'tsx',
    lang: 'typescriptreact',
    input: 'const t = <Trans>Hello  world</Trans>;',
    output: 'const t = <Trans>Hello world</Trans>;',
    stillParses: true
  },
  {
    id: 'CORR-TSX-RN-TEXT-COLLAPSED',
    desc: 'React Native <Text> draws every space, so a collapsed run is visible on the device, must be rejected',
    category: 'tsx',
    lang: 'typescriptreact',
    input: 'const n = <Text>col1  col2</Text>;',
    output: 'const n = <Text>col1 col2</Text>;',
    stillParses: true
  },
  {
    id: 'CORR-TSX-TEXT-THROUGH-A-REFERENCE',
    desc: 'a run collapsed in a <span> that a <pre> renders through a reference, must be rejected',
    category: 'tsx',
    lang: 'typescriptreact',
    input:
      'const label = <span>col1  col2</span>;\nexport const Table = () => <pre>{label}</pre>;\n',
    output:
      'const label = <span>col1 col2</span>;\nexport const Table = () => <pre>{label}</pre>;\n',
    stillParses: true
  },
  {
    id: 'CORR-JSX-TEXT-SPACE-INVENTED',
    desc: 'a space inserted between two glued inline elements changes the text, must be rejected',
    category: 'jsx',
    lang: 'javascriptreact',
    input: 'const el = <p><b>x</b><i>y</i></p>;',
    output: 'const el = <p><b>x</b> <i>y</i></p>;',
    stillParses: true
  },
  {
    id: 'CORR-JSX-TEXT-SPACE-LOST',
    desc: 'the space between two inline elements deleted glues the words together, must be rejected',
    category: 'jsx',
    lang: 'javascriptreact',
    input: 'const el = <p><b>x</b> <i>y</i></p>;',
    output: 'const el = <p><b>x</b><i>y</i></p>;',
    stillParses: true
  },
  {
    id: 'CORR-JSX-TEXT-SPACER-INVENTED',
    desc: 'a {" "} spacer added where no space existed adds a character, must be rejected',
    category: 'jsx',
    lang: 'javascriptreact',
    input: 'const el = <p>read<b>me</b></p>;',
    output: 'const el = <p>read{" "}<b>me</b></p>;',
    stillParses: true
  },
  {
    id: 'CORR-JSX-TEXT-NBSP-DOWNGRADED',
    desc: 'a &nbsp; downgraded to an ordinary space lets the line break where it must not, must be rejected',
    category: 'jsx',
    lang: 'javascriptreact',
    input: 'const el = <p>10&nbsp;km</p>;',
    output: 'const el = <p>10 km</p>;',
    stillParses: true
  },
  {
    id: 'CORR-TSX-PRE-TEXT-COLLAPSED',
    desc: 'a run of spaces collapsed inside <pre> is visible to a reader, must be rejected',
    category: 'tsx',
    lang: 'typescriptreact',
    input: 'const el = <pre>col1    col2</pre>;',
    output: 'const el = <pre>col1 col2</pre>;',
    stillParses: true
  },

  // HTML : SVG draws ALL space characters under xml:space="preserve" (SVG 1.1
  // §5.9). The preformatted TAG list keys on the TAG and the tag here is an
  // ordinary <text>/<tspan>, so the collapsing normalizer flattened the run and
  // the change was WRITTEN with applied=true. Two drawn spaces became one.
  {
    id: 'CORR-HTML-SVG-XMLSPACE-COLLAPSED',
    desc: 'a run of spaces collapsed under xml:space="preserve" changes what SVG draws, must be rejected',
    category: 'html',
    lang: 'html',
    input: '<svg width="100" height="20"><text x="0" y="10" xml:space="preserve">A  B</text></svg>',
    output: '<svg width="100" height="20"><text x="0" y="10" xml:space="preserve">A B</text></svg>',
    stillParses: true
  },
  {
    id: 'CORR-HTML-SVG-XMLSPACE-TAB',
    desc: 'a tab rewritten as a space under xml:space="preserve" changes what SVG draws, must be rejected',
    category: 'html',
    lang: 'html',
    input: '<svg><text xml:space="preserve">A\tB</text></svg>',
    output: '<svg><text xml:space="preserve">A B</text></svg>',
    stillParses: true
  },
  {
    id: 'CORR-HTML-SVG-XMLSPACE-INHERITED',
    desc: 'xml:space is inherited, so a nested <tspan> with no declaration of its own is preserved too, must be rejected',
    category: 'html',
    lang: 'html',
    input: '<svg><text xml:space="preserve">A<tspan>B  C</tspan></text></svg>',
    output: '<svg><text xml:space="preserve">A<tspan>B C</tspan></text></svg>',
    stillParses: true
  },

  // ======================================================================
  // TS : type-level corruptions
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
  // TSX : JSX + TS combined
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
  // CSS : value/selector/combinator corruptions
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

  // ----------------------------------------------------------------------
  // CSS : space-LOOKING code points that CSS does not read as whitespace.
  //
  // js-beautify's CSS printer rewrites fifteen of them to U+0020. CSS Syntax
  // Level 3 counts only U+0009, U+000A, U+000C, U+000D and U+0020 as
  // whitespace (§4.2, plus the §3.3 preprocessing that folds CR and FF into
  // the newline), so every rewrite below splits one token into two and
  // retargets the rule. The guard used to fold the JavaScript \s class on
  // BOTH sides and could not see any of it, so these were APPLIED with
  // equivalent=true. The last three carry the same class through an HTML
  // <style> element and an embedded JSON body, whose bodies used to be
  // pre-trimmed with ECMAScript's whitespace set instead of their own.
  //
  // Every exotic code point is spelled as an ESCAPE on purpose: a literal one
  // is invisible in review and U+2028 is a line terminator to some tooling.
  // ----------------------------------------------------------------------
  {
    id: 'CORR-CSS-NBSP-SELECTOR-SPLIT',
    desc:
      'U+00A0 inside a class name rewritten to a space turns ONE class selector into a descendant combinator, must be rejected',
    category: 'css',
    lang: 'css',
    input: '.a\u00a0b {\n  color: red;\n}',
    output: '.a b {\n  color: red;\n}',
    stillParses: true
  },
  {
    id: 'CORR-CSS-NBSP-VALUE-SPLIT',
    desc:
      'U+00A0 in font-family rewritten to a space turns one font name into two, must be rejected',
    category: 'css',
    lang: 'css',
    input: '.x {\n  font-family: Helvetica\u00a0Neue;\n}',
    output: '.x {\n  font-family: Helvetica Neue;\n}',
    stillParses: true
  },
  {
    id: 'CORR-CSS-VT-SELECTOR-SPLIT',
    desc:
      'U+000B is NOT CSS whitespace (CSS Syntax L3 never lists it) so rewriting it to a space splits the selector, must be rejected',
    category: 'css',
    lang: 'css',
    input: '.a\u000bb {\n  color: red;\n}',
    output: '.a b {\n  color: red;\n}',
    stillParses: true
  },
  {
    id: 'CORR-CSS-FEFF-CUSTOM-PROP-NAME',
    desc:
      'U+FEFF inside a custom property NAME rewritten to a space breaks the declaration outright, so the corrupted output no longer parses, must be rejected',
    category: 'css',
    lang: 'css',
    input: ':root {\n  --a\ufeffb: 1px;\n}',
    output: ':root {\n  --a b: 1px;\n}',
    stillParses: false
  },
  {
    id: 'CORR-CSS-IDEOGRAPHIC-SPACE-VALUE',
    desc:
      'U+3000 in a custom property VALUE rewritten to a space changes the token stream the value expands to, must be rejected',
    category: 'css',
    lang: 'css',
    input: ':root {\n  --gap: 1px\u30002px;\n}',
    output: ':root {\n  --gap: 1px 2px;\n}',
    stillParses: true
  },
  {
    id: 'CORR-CSS-NARROW-NBSP-ATRULE-PARAMS',
    desc:
      'U+202F in @supports params rewritten to a space changes the condition text, must be rejected',
    category: 'css',
    lang: 'css',
    input: '@supports (display:grid\u202f) {\n  .a {\n    color: red;\n  }\n}',
    output: '@supports (display:grid ) {\n  .a {\n    color: red;\n  }\n}',
    stillParses: true
  },
  {
    id: 'CORR-CSS-LINE-SEP-COMBINATOR-NEIGHBOUR',
    desc:
      'U+2028 next to a child combinator rewritten to a space changes the compound selector on its left, must be rejected',
    category: 'css',
    lang: 'css',
    input: '.a\u2028>.b {\n  color: red;\n}',
    output: '.a >.b {\n  color: red;\n}',
    stillParses: true
  },
  {
    id: 'CORR-CSS-THIN-SPACE-PROP-NAME',
    desc:
      'U+2009 inside a property NAME rewritten to a space breaks the declaration outright, so the corrupted output no longer parses, must be rejected',
    category: 'css',
    lang: 'css',
    input: '.x {\n  colo\u2009r: red;\n}',
    output: '.x {\n  colo r: red;\n}',
    stillParses: false
  },
  {
    id: 'CORR-SCSS-NBSP-SELECTOR-SPLIT',
    desc:
      'the CSS U+00A0 selector split, reproduced through the SCSS syntax, must be rejected',
    category: 'scss',
    lang: 'scss',
    input: '.a\u00a0b {\n  color: red;\n}',
    output: '.a b {\n  color: red;\n}',
    stillParses: true
  },
  {
    id: 'CORR-SCSS-NBSP-VARIABLE-VALUE',
    desc:
      'U+00A0 inside a SCSS variable value rewritten to a space changes the list the variable holds, must be rejected',
    category: 'scss',
    lang: 'scss',
    input: '$g: 1px\u00a02px;\n.a {\n  margin: $g;\n}',
    output: '$g: 1px 2px;\n.a {\n  margin: $g;\n}',
    stillParses: true
  },
  {
    id: 'CORR-LESS-NBSP-SELECTOR-SPLIT',
    desc:
      'the CSS U+00A0 selector split, reproduced through the LESS syntax, must be rejected',
    category: 'less',
    lang: 'less',
    input: '.a\u00a0b {\n  color: red;\n}',
    output: '.a b {\n  color: red;\n}',
    stillParses: true
  },
  {
    id: 'CORR-LESS-NBSP-VARIABLE-VALUE',
    desc:
      'U+00A0 inside a LESS variable value rewritten to a space changes the value the variable holds, must be rejected',
    category: 'less',
    lang: 'less',
    input: '@g: 1px\u00a02px;\n.a {\n  margin: @g;\n}',
    output: '@g: 1px 2px;\n.a {\n  margin: @g;\n}',
    stillParses: true
  },
  {
    id: 'CORR-HTML-STYLE-NBSP-SELECTOR-SPLIT',
    desc:
      'the CSS U+00A0 selector split reached through an HTML <style> element, must be rejected',
    category: 'html',
    lang: 'html',
    input: '<style>\n  .a\u00a0b {\n    color: red;\n  }\n</style>',
    output: '<style>\n  .a b {\n    color: red;\n  }\n</style>',
    stillParses: true
  },
  {
    id: 'CORR-HTML-STYLE-NBSP-LEADING',
    desc:
      'a U+00A0 leading an embedded stylesheet belongs to the first compound selector, so dropping it makes an invalid rule apply, must be rejected',
    category: 'html',
    lang: 'html',
    input: '<style>\u00a0.a {\n  color: red;\n}</style>',
    output: '<style>\n  .a {\n    color: red;\n  }\n</style>',
    stillParses: true
  },
  {
    id: 'CORR-HTML-JSON-NBSP-LEADING',
    desc:
      'a U+00A0 leading an application/json body is not JSON whitespace, so dropping it turns a body JSON.parse rejects into one it accepts, must be rejected',
    category: 'html',
    lang: 'html',
    input: '<script type="application/json">\u00a0{"a":1}</script>',
    output: '<script type="application/json">\n  {\n    "a": 1\n  }\n</script>',
    stillParses: true
  },
  // ======================================================================
  // SCSS : nesting/extend/interpolation corruptions
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
  // LESS : variable/operation corruptions
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
  // HTML : attribute/tag/verbatim-text corruptions
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

  // HTML : the THIRD source of "whitespace is drawn here" is the CSS property
  // `white-space`. The tag list keys on the TAG and xml:space on an ATTRIBUTE
  // the SVG spec defines; neither could see `style="white-space:pre"` on an
  // ordinary <div>, so a column-aligned table, a wrapped letter and a Python
  // snippet were all reflowed and WRITTEN with applied=true. See
  // src/safety/htmlWhitespace.ts for the one model the three sources share.
  {
    id: 'CORR-HTML-CSS-PRE-INLINE-COLLAPSED',
    desc: 'a column-aligned table under style="white-space:pre" reflowed, the reader sees different text, must be rejected',
    category: 'html',
    lang: 'html',
    input: '<span style="white-space:pre">NAME      QTY\nfoo         1</span>',
    output: '<span style="white-space:pre">NAME QTY\n  foo 1</span>',
    stillParses: true
  },
  {
    id: 'CORR-HTML-CSS-PRE-WRAP-INDENT-LOST',
    desc: 'style="white-space:pre-wrap" draws its indentation, so losing it is a content change, must be rejected',
    category: 'html',
    lang: 'html',
    input: '<div style="white-space:pre-wrap">Hello\n\n    Bob,   how are you?</div>',
    output: '<div style="white-space:pre-wrap">Hello\n\n  Bob, how are you?</div>',
    stillParses: true
  },
  {
    id: 'CORR-HTML-CSS-PRE-PYTHON-INDENT',
    desc: 'a 4-space Python indent under style="white-space:pre" rewritten to 2 changes the code a reader copies, must be rejected',
    category: 'html',
    lang: 'html',
    input: '<div style="white-space:pre">def f():\n    return 1</div>',
    output: '<div style="white-space:pre">def f():\n  return 1</div>',
    stillParses: true
  },
  {
    id: 'CORR-HTML-CSS-PRE-INHERITED',
    desc: 'white-space is an INHERITED property, so a descendant with no declaration of its own is drawn verbatim too, must be rejected',
    category: 'html',
    lang: 'html',
    input: '<div style="white-space:pre"><span><b>A  B</b></span></div>',
    output: '<div style="white-space:pre"><span><b>A B</b></span></div>',
    stillParses: true
  },
  {
    id: 'CORR-HTML-CSS-BREAK-SPACES-COLLAPSED',
    desc: 'white-space:break-spaces preserves every space exactly like pre-wrap, must be rejected',
    category: 'html',
    lang: 'html',
    input: '<div style="white-space:break-spaces">A  B</div>',
    output: '<div style="white-space:break-spaces">A B</div>',
    stillParses: true
  },
  {
    id: 'CORR-HTML-CSS-COLLAPSE-LONGHAND',
    desc: 'the longhand white-space-collapse:preserve says the same thing as pre, must be rejected',
    category: 'html',
    lang: 'html',
    input: '<div style="white-space-collapse:preserve">A  B</div>',
    output: '<div style="white-space-collapse:preserve">A B</div>',
    stillParses: true
  },
  {
    id: 'CORR-HTML-CSS-PRE-LINE-BREAK-LOST',
    desc: 'pre-line collapses spaces but DRAWS newlines, so losing a line break is a content change, must be rejected',
    category: 'html',
    lang: 'html',
    input: '<div style="white-space:pre-line">alpha\nbeta</div>',
    output: '<div style="white-space:pre-line">alpha beta</div>',
    stillParses: true
  },
  {
    id: 'CORR-HTML-CSS-PRE-LINE-BREAK-ADDED',
    desc: 'the mirror image: wrapping a pre-line paragraph ADDS a drawn line break, must be rejected',
    category: 'html',
    lang: 'html',
    input: '<div style="white-space:pre-line">alpha beta</div>',
    output: '<div style="white-space:pre-line">alpha\nbeta</div>',
    stillParses: true
  },
  {
    id: 'CORR-HTML-CSS-NORMAL-CANNOT-UNLOCK-PRE',
    desc: 'a CSS declaration may only switch off what CSS turned on: white-space:normal must not unlock a <pre> ancestor, must be rejected',
    category: 'html',
    lang: 'html',
    input: '<pre><span style="white-space:normal">A\tB</span></pre>',
    output: '<pre><span style="white-space:normal">A    B</span></pre>',
    stillParses: true
  },
  {
    id: 'CORR-HTML-CSS-XMLSPACE-CANNOT-UNLOCK-CSS',
    desc: 'and the reverse: xml:space="default" must not unlock a CSS white-space:pre ancestor, must be rejected',
    category: 'html',
    lang: 'html',
    input: '<div style="white-space:pre"><span xml:space="default">A  B</span></div>',
    output: '<div style="white-space:pre"><span xml:space="default">A B</span></div>',
    stillParses: true
  },
  {
    id: 'CORR-HTML-CSS-VALUE-UNREADABLE',
    desc: 'a white-space value the guard cannot resolve (var()) may well be preserving, so it fails closed, must be rejected',
    category: 'html',
    lang: 'html',
    input: '<div style="white-space:var(--ws)">A  B</div>',
    output: '<div style="white-space:var(--ws)">A B</div>',
    stillParses: true
  },
  {
    id: 'CORR-HTML-CSS-STYLE-BLOCK-FAIL-CLOSED',
    desc: 'an embedded <style> can set a preserving white-space through a class; matching selectors is out of scope, so the format is refused rather than guessed, must be rejected',
    category: 'html',
    lang: 'html',
    input: '<style>.log{white-space:pre-wrap}</style><div class="log">A  B</div>',
    output: '<style>.log{white-space:pre-wrap}</style><div class="log">A B</div>',
    stillParses: true
  },

  // ======================================================================
  // JSON : value/key/number corruptions
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
  // JSONC : value corruption under comments/trailing commas
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
