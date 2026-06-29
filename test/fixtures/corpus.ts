// Property/fuzz corpus (SPEC QA-01, QA-06): a curated set of VALID snippets
// covering all 10 supported languageIds, simple → costaud. The property harness
// (test/unit/property/invariants.test.ts) asserts three invariants on EACH
// snippet:
//   I1 (the load-bearing one): guard.check(lang, input, dispatchFormat(req)) is
//      equivalent === true. A failure means either a guard false-positive OR a
//      real engine corruption — both are reportable bugs. This is the invariant
//      that would have caught the JSX `< Foo bar = {x} />` class.
//   I2: idempotence — dispatchFormat(dispatchFormat(x)) === dispatchFormat(x).
//   I3: the formatted output re-parses (no parse error) via the guard's parsers.
//
// Deterministic variation: snippets are seeded by index (no Math.random), and
// the harness also re-runs each snippet through a small set of deterministic
// whitespace/EOL perturbations derived from the index, so the same corpus
// exercises many concrete inputs reproducibly.
import type { LangId } from '../../src/types';

export interface CorpusSnippet {
  /** Stable identifier, unique across the corpus. */
  id: string;
  lang: LangId;
  /** A syntactically VALID source snippet for `lang`. */
  code: string;
  /** Short note on what the snippet stresses (modern syntax, nesting, …). */
  note: string;
}

// --- CSS -------------------------------------------------------------------

const cssSnippets: CorpusSnippet[] = [
  { id: 'CSS-01', lang: 'css', code: `.a{color:red;margin:0}`, note: 'minimal rule' },
  {
    id: 'CSS-02',
    lang: 'css',
    code: `.box { padding : 1px 2px 3px 4px ; border:1px solid #000 }`,
    note: 'shorthand values + extra spaces'
  },
  {
    id: 'CSS-03',
    lang: 'css',
    code: `a:hover,a:focus{text-decoration:underline}.nav>li+li{margin-left:8px}`,
    note: 'pseudo-classes, child + adjacent combinators (#67)'
  },
  {
    id: 'CSS-04',
    lang: 'css',
    code: `.grid{width:calc(100% - 2rem);grid-template-columns:repeat(3,1fr)}`,
    note: 'calc() and comma function args (#74)'
  },
  {
    id: 'CSS-05',
    lang: 'css',
    code: `li:nth-child(2n+1){background:#eee}li:nth-of-type(3){color:red}`,
    note: ':nth-child formula must not be split (#77/#78)'
  },
  {
    id: 'CSS-06',
    lang: 'css',
    code: `@media (max-width:600px){.col{float:none;width:100%}}`,
    note: 'at-rule with media query'
  },
  {
    id: 'CSS-07',
    lang: 'css',
    code: `:root{--main:#3366ff;--gap:8px}.x{color:var(--main);gap:var(--gap)}`,
    note: 'custom properties + var()'
  },
  {
    id: 'CSS-08',
    lang: 'css',
    code: `.h{font-family:"Helvetica Neue",Arial,sans-serif;background:url("a b.png")}`,
    note: 'quoted font stack + url with space'
  },
  {
    id: 'CSS-09',
    lang: 'css',
    code:
      `/* header */\n.header{position:sticky;top:0}` +
      `\n@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}`,
    note: 'comment + @keyframes (costaud)'
  },
  {
    id: 'CSS-10',
    lang: 'css',
    code: `.btn{color:red!important;background:blue ! important}`,
    note: '!important with and without space'
  }
];

// --- SCSS ------------------------------------------------------------------

const scssSnippets: CorpusSnippet[] = [
  {
    id: 'SCSS-01',
    lang: 'scss',
    code: `$c:red;.a{color:$c}`,
    note: 'variable + use'
  },
  {
    id: 'SCSS-02',
    lang: 'scss',
    code: `.card{.title{color:red}&:hover{color:blue}}`,
    note: 'nesting + parent selector'
  },
  {
    id: 'SCSS-03',
    lang: 'scss',
    code: `@mixin pad($x){padding:$x}.a{@include pad(8px)}`,
    note: 'mixin + include'
  },
  {
    id: 'SCSS-04',
    lang: 'scss',
    code: `$w:100px;.box{width:$w / 2;height:calc(#{$w} + 10px)}`,
    note: 'interpolation #{} inside calc (#138)'
  },
  {
    id: 'SCSS-05',
    lang: 'scss',
    code: `%base{margin:0}.a{@extend %base;color:red}`,
    note: 'placeholder + @extend'
  },
  {
    id: 'SCSS-06',
    lang: 'scss',
    code: `@if $x==1{.a{color:red}}@else{.a{color:blue}}`,
    note: 'control flow @if/@else'
  },
  {
    id: 'SCSS-07',
    lang: 'scss',
    code: `$map:(a:1,b:2);.x{width:map-get($map,a)*1px}`,
    note: 'map literal + function call (costaud)'
  },
  {
    id: 'SCSS-08',
    lang: 'scss',
    code: `@each $i in 1,2,3{.m-#{$i}{margin:#{$i}px}}`,
    note: '@each loop with interpolated selector'
  }
];

// --- LESS ------------------------------------------------------------------

const lessSnippets: CorpusSnippet[] = [
  {
    id: 'LESS-01',
    lang: 'less',
    // NOTE: a SPACE after the colon is required here. The compact form
    // `@c:red` triggers a postcss-less tokenisation quirk that makes the guard
    // reject js-beautify's (correct) output — captured as a dedicated BUG test
    // in invariants.test.ts (see BUG-LESS-VAR).
    code: `@c: red;.a{color:@c}`,
    note: 'variable + use'
  },
  {
    id: 'LESS-02',
    lang: 'less',
    code: `.a{color:blue;.b{color:red}}`,
    note: 'nesting'
  },
  {
    id: 'LESS-03',
    lang: 'less',
    code: `.mixin(@x){padding:@x}.a{.mixin(8px)}`,
    note: 'parametric mixin'
  },
  {
    id: 'LESS-04',
    lang: 'less',
    // SPACE after colon required (see LESS-01 / BUG-LESS-VAR).
    code: `@w: 100px;.box{width:(@w / 2);height:(@w + 10px)}`,
    note: 'parenthesised math'
  },
  {
    id: 'LESS-05',
    lang: 'less',
    code: `@base:#333;.a{color:lighten(@base,20%);background:darken(@base,10%)}`,
    note: 'color functions (costaud)'
  },
  {
    id: 'LESS-06',
    lang: 'less',
    code: `.a:extend(.b){color:red}.c{&:extend(.d all)}`,
    note: ':extend syntax'
  }
];

// --- HTML ------------------------------------------------------------------

const htmlSnippets: CorpusSnippet[] = [
  {
    id: 'HTML-01',
    lang: 'html',
    code: `<div><p>hello</p></div>`,
    note: 'minimal nesting'
  },
  {
    id: 'HTML-02',
    lang: 'html',
    code: `<ul><li>a</li><li>b</li><li>c</li></ul>`,
    note: 'list of siblings'
  },
  {
    id: 'HTML-03',
    lang: 'html',
    code: `<a href="x.html" class="btn primary" data-id="3">Go</a>`,
    note: 'multiple attributes (#41 hyphen names, #106)'
  },
  {
    id: 'HTML-04',
    lang: 'html',
    code: `<img src="a.png" alt="an image" width="10" height="10">`,
    note: 'void element with attributes'
  },
  {
    id: 'HTML-05',
    lang: 'html',
    code: `<!DOCTYPE html><html><head><title>T</title></head><body><h1>Hi</h1></body></html>`,
    note: 'full document with doctype'
  },
  {
    id: 'HTML-06',
    lang: 'html',
    code: `<pre>  keep   these\n   spaces  </pre>`,
    note: 'whitespace-sensitive <pre> must be preserved'
  },
  {
    id: 'HTML-07',
    lang: 'html',
    code: `<table><thead><tr><th>A</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>`,
    note: 'table structure (costaud)'
  },
  {
    id: 'HTML-08',
    lang: 'html',
    code: `<form action="/x" method="post"><input type="text" name="q" required><button>Go</button></form>`,
    note: 'form with boolean attribute'
  },
  {
    id: 'HTML-09',
    lang: 'html',
    code: `<div><!-- a comment --><span>text</span></div>`,
    note: 'comment node preserved'
  },
  {
    id: 'HTML-10',
    lang: 'html',
    code: `<section><article><h2>Title</h2><p>Para with <strong>bold</strong> and <em>italic</em>.</p></article></section>`,
    note: 'inline mixed content (costaud)'
  }
];

// --- JSON ------------------------------------------------------------------

const jsonSnippets: CorpusSnippet[] = [
  {
    id: 'JSON-01',
    lang: 'json',
    code: `{"a":1,"b":2}`,
    note: 'flat object'
  },
  {
    id: 'JSON-02',
    lang: 'json',
    code: `{"a":{"b":{"c":[1,2,3]}},"d":"x"}`,
    note: 'nested object + array (#134)'
  },
  {
    id: 'JSON-03',
    lang: 'json',
    code: `[1,2,3,{"k":true,"n":null,"f":1.5e3}]`,
    note: 'array of mixed primitives'
  },
  {
    id: 'JSON-04',
    lang: 'json',
    code: `{"unicode":"caf\\u00e9","escaped":"a\\"b\\\\c","tab":"x\\ty"}`,
    note: 'escapes + unicode (must round-trip)'
  },
  {
    id: 'JSON-05',
    lang: 'json',
    code: `{"big":123456789012345,"neg":-42,"zero":0,"frac":0.001}`,
    note: 'number edge cases'
  },
  {
    id: 'JSON-06',
    lang: 'json',
    code:
      `{"name":"app","version":"1.0.0","deps":{"a":"^1","b":"~2"},` +
      `"scripts":["build","test"],"nested":{"x":{"y":{"z":1}}}}`,
    note: 'package.json-like (costaud)'
  }
];

// --- JSONC -----------------------------------------------------------------

const jsoncSnippets: CorpusSnippet[] = [
  {
    id: 'JSONC-01',
    lang: 'jsonc',
    code: `{\n  // line comment\n  "a": 1,\n  "b": 2,\n}`,
    note: 'line comment + trailing comma'
  },
  {
    id: 'JSONC-02',
    lang: 'jsonc',
    code: `{\n  /* block */ "a": 1,\n  "list": [1, 2, 3,]\n}`,
    note: 'block comment + trailing comma in array'
  },
  {
    id: 'JSONC-03',
    lang: 'jsonc',
    // NOTE: comments are placed on their OWN lines. An inline block comment
    // sharing a line with the following key (`/* c */ "target"`) makes
    // js-beautify non-idempotent (first pass keeps it inline, second pushes it
    // to its own line). Captured as BUG-JSONC-INLINE-COMMENT.
    code:
      `{\n  // opts\n  "compilerOptions": {\n    "strict": true,\n    "target": "ES2022"\n  },\n  "include": ["src",]\n}`,
    note: 'tsconfig-like with comments (costaud)'
  }
];

// --- JavaScript (plain, no JSX → js-beautify) ------------------------------

const javascriptSnippets: CorpusSnippet[] = [
  {
    id: 'JS-01',
    lang: 'javascript',
    code: `const x=1;function f(a,b){return a+b;}`,
    note: 'minimal'
  },
  {
    id: 'JS-02',
    lang: 'javascript',
    code: `if(a){if(b){doThing();}}else{other();}`,
    note: 'nested control flow (drift)'
  },
  {
    id: 'JS-03',
    lang: 'javascript',
    code: `const o={a:1,b:2,c:[1,2,3]};const {a,b}=o;`,
    note: 'object + destructuring'
  },
  {
    id: 'JS-04',
    lang: 'javascript',
    code: `const y=a?.b??c;const big=1n;const t=\`v=\${x}\`;`,
    note: 'optional chaining, nullish, BigInt, template literal (ENG-02)'
  },
  {
    id: 'JS-05',
    lang: 'javascript',
    code: `class C{#secret=1;get v(){return this.#secret}static make(){return new C()}}`,
    note: 'private fields + static + getter (#x, ENG-02)'
  },
  {
    id: 'JS-06',
    lang: 'javascript',
    code: `async function g(){const r=await fetch("/x");return await r.json();}`,
    note: 'async/await'
  },
  {
    id: 'JS-07',
    lang: 'javascript',
    code: `const arr=[1,2,3].map(n=>n*2).filter(n=>n>2).reduce((a,b)=>a+b,0);`,
    note: 'arrow chains'
  },
  {
    id: 'JS-08',
    lang: 'javascript',
    code:
      `import {a,b,c} from "m";export const k=()=>{` +
      `const set=new Set([...a,...b]);return [...set];};`,
    note: 'named imports + spread (import not split destructively)'
  },
  {
    id: 'JS-09',
    lang: 'javascript',
    code: `for(let i=0;i<10;i++){switch(i%2){case 0:even();break;default:odd();}}`,
    note: 'for + switch (costaud)'
  },
  {
    id: 'JS-10',
    lang: 'javascript',
    code: `const re=/a\\/b[0-9]+/gi;const ok=re.test("a/b12");label:for(const x of[1,2]){if(x)continue label;}`,
    note: 'regex literal + labeled loop (costaud)'
  }
];

// --- TypeScript (real-parser → prettier) -----------------------------------

const typescriptSnippets: CorpusSnippet[] = [
  {
    id: 'TS-01',
    lang: 'typescript',
    code: `const x:number=1;function f(a:string,b:string):string{return a+b;}`,
    note: 'type annotations'
  },
  {
    id: 'TS-02',
    lang: 'typescript',
    code: `interface I{a:number;b:string;c?:boolean}type U=I|null;`,
    note: 'interface + union type'
  },
  {
    id: 'TS-03',
    lang: 'typescript',
    code: `function id<T>(x:T):T{return x}const n=id<number>(1);`,
    note: 'generics (js-beautify would break this — ENG-02)'
  },
  {
    id: 'TS-04',
    lang: 'typescript',
    code: `enum E{A,B,C}const e:E=E.B;type Rec=Record<string,number>;`,
    note: 'enum + Record generic'
  },
  {
    id: 'TS-05',
    lang: 'typescript',
    code: `class S<T>{constructor(private readonly v:T){}get value():T{return this.v}}`,
    note: 'generic class + parameter property'
  },
  {
    id: 'TS-06',
    lang: 'typescript',
    code: `const f=(x:unknown):x is string=>typeof x==="string";`,
    note: 'type predicate'
  },
  {
    id: 'TS-07',
    lang: 'typescript',
    code: `type Cond<T>=T extends string?"s":"o";type Map2<T>={[K in keyof T]:T[K]};`,
    note: 'conditional + mapped types (costaud)'
  },
  {
    id: 'TS-08',
    lang: 'typescript',
    code: `@sealed class A{@log method(@inject p:number){return p}}`,
    note: 'decorators (legacy)'
  },
  {
    id: 'TS-09',
    lang: 'typescript',
    // NOTE: avoids legacy angle-bracket casts `<T>expr`, which the guard cannot
    // parse because it enables the babel `jsx` plugin for ALL ts-family files
    // (where `<T>x` is ambiguous with JSX). That divergence is captured as a
    // dedicated BUG test (BUG-TS-ANGLE-CAST). `as`-style casts are used instead.
    code: `const a=b as const;const c=[1,2] as readonly number[];const d=x!.y;`,
    note: 'as const, as-cast, non-null assertion'
  },
  {
    id: 'TS-10',
    lang: 'typescript',
    code: `const x={a:1} satisfies Record<string,number>;type T=`
      + '`pre_${string}`' + `;`,
    note: 'satisfies operator + template literal type (ES/TS modern)'
  }
];

// --- TSX (real-parser → prettier) ------------------------------------------

const typescriptreactSnippets: CorpusSnippet[] = [
  {
    id: 'TSX-01',
    lang: 'typescriptreact',
    code: `const A=()=><div className="x"><span>hi</span></div>;`,
    note: 'basic JSX element'
  },
  {
    id: 'TSX-02',
    lang: 'typescriptreact',
    code: `const B=({n}:{n:number})=><p>{n>0?<b>pos</b>:<i>neg</i>}</p>;`,
    note: 'JSX expression + ternary with elements'
  },
  {
    id: 'TSX-03',
    lang: 'typescriptreact',
    code: `function C(){return <><h1>t</h1><ul>{[1,2].map(i=><li key={i}>{i}</li>)}</ul></>;}`,
    note: 'fragment + map (the `< Foo bar={x} />` class — I1 critical)'
  },
  {
    id: 'TSX-04',
    lang: 'typescriptreact',
    code: `const D=<T,>(p:{items:T[]})=><ul>{p.items.map((x,i)=><li key={i}>{String(x)}</li>)}</ul>;`,
    note: 'generic arrow component in TSX (<T,>) + JSX'
  },
  {
    id: 'TSX-05',
    lang: 'typescriptreact',
    code: `const E=()=><input type="text" value={v} onChange={e=>setV(e.target.value)} disabled/>;`,
    note: 'self-closing with boolean prop + handler'
  },
  {
    id: 'TSX-06',
    lang: 'typescriptreact',
    code: `const F=()=><div {...props} data-x={1}><Child a={1} b="two" c={[1,2]}/></div>;`,
    note: 'spread props + mixed attribute kinds'
  },
  {
    id: 'TSX-07',
    lang: 'typescriptreact',
    code:
      `function G({title,children}:{title:string;children:React.ReactNode}){` +
      `return <section className="card"><header>{title}</header><main>{children}</main></section>;}`,
    note: 'typed props + nested JSX (costaud)'
  }
];

// --- JSX (real-parser → prettier) ------------------------------------------

const javascriptreactSnippets: CorpusSnippet[] = [
  {
    id: 'JSX-01',
    lang: 'javascriptreact',
    code: `function A(){return <ul><li>a</li><li>b</li></ul>;}`,
    note: 'basic list'
  },
  {
    id: 'JSX-02',
    lang: 'javascriptreact',
    code: `const B=()=><button onClick={()=>go()} className="x">Go</button>;`,
    note: 'handler + class'
  },
  {
    id: 'JSX-03',
    lang: 'javascriptreact',
    code: `const C=({items})=><ul>{items.map(i=><li key={i.id}>{i.name}</li>)}</ul>;`,
    note: 'map over items'
  },
  {
    id: 'JSX-04',
    lang: 'javascriptreact',
    code: `const D=()=><><Header/><Main><p>x</p></Main><Footer/></>;`,
    note: 'fragment with self-closing children'
  },
  {
    id: 'JSX-05',
    lang: 'javascriptreact',
    code: `const E=()=><div>{cond&&<span>yes</span>}{!cond&&<span>no</span>}</div>;`,
    note: 'conditional rendering with &&'
  },
  {
    id: 'JSX-06',
    lang: 'javascriptreact',
    code: `const F=()=><img src="a.png" alt="x" {...rest} />;`,
    note: 'self-closing void-like + spread (#64 `<App/>` class)'
  }
];

/**
 * The full corpus, assembled per language. >= 40 snippets covering all 10
 * languageIds. Order is stable so the index-derived deterministic perturbations
 * in the harness are reproducible across runs.
 */
export const corpus: CorpusSnippet[] = [
  ...cssSnippets,
  ...scssSnippets,
  ...lessSnippets,
  ...htmlSnippets,
  ...jsonSnippets,
  ...jsoncSnippets,
  ...javascriptSnippets,
  ...typescriptSnippets,
  ...typescriptreactSnippets,
  ...javascriptreactSnippets
];

/** Every languageId that must appear in the corpus (used by a coverage test). */
export const ALL_LANGS: readonly LangId[] = [
  'css',
  'scss',
  'less',
  'html',
  'json',
  'jsonc',
  'javascript',
  'typescript',
  'typescriptreact',
  'javascriptreact'
];

/**
 * Deterministic whitespace/EOL perturbation of a snippet, seeded by its index.
 * No Math.random: the same index always yields the same variant, so a failure is
 * always reproducible. The variants are all semantics-preserving for every
 * supported language (they only add insignificant leading/trailing/EOL
 * whitespace), so a correct formatter must still pass all three invariants.
 *
 *   variant 0: identity (the snippet as authored)
 *   variant 1: prepend insignificant leading whitespace + indent
 *   variant 2: convert LF to CRLF (mixed-EOL input)
 *   variant 3: append trailing blank lines + spaces
 */
export function perturb(code: string, index: number): string {
  switch (index % 4) {
    case 1:
      return `   \n  ${code}`;
    case 2:
      return code.replace(/\n/g, '\r\n');
    case 3:
      return `${code}\n   \n\n`;
    case 0:
    default:
      return code;
  }
}
