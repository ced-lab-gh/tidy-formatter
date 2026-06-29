// COMPLEX JS / TS / JSX / TSX acceptance corpus.
//
// Every fixture here is a *correct* piece of modern JS/TS/JSX/TSX that the real
// dispatcher (prettier for ts/tsx/jsx, js-beautify for plain js) reformats, and
// whose output MUST pass the safety guard as semantically equivalent AND be
// idempotent (format(format(x)) === format(x)).
//
// This is the inverse of the guard's anti-corruption corpus: there we prove the
// guard REJECTS mangled output; here we prove it does NOT false-positive on the
// hard, real-world syntax the incumbent (lonefy) corrupted — generics, nested
// JSX + fragments, conditional rendering, spread props, JSX expressions/comments,
// template literals (tagged + nested), legacy decorators, enums/namespaces,
// function overloads, type-only imports, `satisfies`, optional-chaining +
// nullish chains, regex literals, numeric separators, BigInt, private `#x`
// fields, async generators, and class accessors.
//
// SPEC refs: ENG-01/ENG-02 (modern syntax not corrupted), SAFE-01 (AST
// equivalence guard, no false positives — §12 "faux positif de la garde"),
// SAFE-03 (idempotence). Issue clusters: #64,#76,#80,#128,#136,#141,#146,#150.
import type { LangId } from '../../../src/types';

export interface ComplexAcceptFixture {
  /** Stable id used in the test title. */
  id: string;
  /** Human description of the syntax under test. */
  desc: string;
  /** SPEC / issue reference. */
  ref: string;
  /** languageId routed through the real dispatcher. */
  lang: LangId;
  /** Messy / compact but VALID input. */
  input: string;
  /**
   * Substrings that MUST survive verbatim in the formatted output. These pin the
   * exact tokens the incumbent corrupted (e.g. `<T extends`, `?.`, `1_000`, `10n`,
   * `#x`, `{...props}`) so a regression that mangles them fails loudly even if the
   * AST guard somehow accepted it.
   */
  mustContain: string[];
}

export const complexAcceptFixtures: ComplexAcceptFixture[] = [
  // --- Generics ------------------------------------------------------------
  {
    id: 'CX-GEN-EXTENDS',
    desc: 'generic with constraint <T extends ...>',
    ref: 'SPEC §4 "function f<T>" / #64,#76',
    lang: 'typescript',
    input: 'function id<T extends object>(x:T):T{return x;}',
    mustContain: ['<T extends object>']
  },
  {
    id: 'CX-GEN-DEFAULT',
    desc: 'generic with default type param <T = string>',
    ref: 'ENG-02 generics',
    lang: 'typescript',
    input: 'type Box<T = string> = { v: T };const b:Box={v:"x"};',
    mustContain: ['<T = string>']
  },
  {
    id: 'CX-GEN-MULTI-CONSTRAINT',
    desc: 'multiple generic params each constrained',
    ref: 'ENG-02 generics',
    lang: 'typescript',
    input: 'function merge<A extends object, B extends object>(a:A,b:B):A & B{return {...a,...b};}',
    mustContain: ['<A extends object, B extends object>']
  },
  {
    id: 'CX-GEN-ARROW-TSX',
    desc: 'generic arrow function in TSX needs the trailing-comma <T,> disambiguator',
    ref: 'ENG-02 generics in TSX',
    lang: 'typescriptreact',
    input: 'const identity = <T,>(x: T): T => x;const v=identity<number>(3);',
    mustContain: ['identity<number>(3)']
  },

  // --- JSX nesting, fragments, conditional, spread, expressions, comments ---
  {
    id: 'CX-JSX-FRAGMENT',
    desc: 'fragment shorthand <>...</> wrapping siblings',
    ref: 'ENG-02 JSX',
    lang: 'typescriptreact',
    input: 'const A=()=><><span>a</span><span>b</span></>;',
    mustContain: ['<>', '</>']
  },
  {
    id: 'CX-JSX-CONDITIONAL',
    desc: 'conditional rendering ternary returning JSX',
    ref: 'ENG-02 JSX',
    lang: 'typescriptreact',
    input: 'const A=({ok}:{ok:boolean})=>ok?<Yes/>:<No/>;',
    mustContain: ['<Yes />', '<No />']
  },
  {
    id: 'CX-JSX-SPREAD-PROPS',
    desc: 'spread props {...props} alongside explicit props',
    ref: 'ENG-02 JSX spread',
    lang: 'typescriptreact',
    input: 'const A=(p:any)=><Comp {...p} extra={1}/>;',
    mustContain: ['{...p}', 'extra={1}']
  },
  {
    id: 'CX-JSX-COMMENT',
    desc: 'JSX comment {/* ... */} as a child',
    ref: 'ENG-02 JSX comments',
    lang: 'typescriptreact',
    input: 'const A=()=><div>{/* hi */}<span>x</span></div>;',
    mustContain: ['{/* hi */}']
  },
  {
    id: 'CX-JSX-EXPR-MAP',
    desc: 'JSX expression children with .map + key',
    ref: 'ENG-02 JSX expressions',
    lang: 'typescriptreact',
    input: 'const A=({items}:{items:string[]})=><ul>{items.map(i=><li key={i}>{i}</li>)}</ul>;',
    mustContain: ['key={i}', '{i}']
  },
  {
    id: 'CX-JSX-MEMBER-ELEMENT',
    desc: 'member-expression JSX element <Foo.Bar.Baz />',
    ref: 'ENG-02 JSX',
    lang: 'typescriptreact',
    input: 'const A = () => <Foo.Bar.Baz prop={1} />;',
    mustContain: ['<Foo.Bar.Baz', 'prop={1}']
  },
  {
    id: 'CX-JSX-DEEP-NESTED',
    desc: 'deeply nested JSX table with mapped rows',
    ref: 'ENG-02 JSX nesting',
    lang: 'typescriptreact',
    input:
      'const T=({rows}:{rows:{id:string;a:string;b:string}[]})=>(<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody>{rows.map((r)=>(<tr key={r.id}><td>{r.a}</td><td>{r.b}</td></tr>))}</tbody></table>);',
    mustContain: ['<table>', 'key={r.id}', '</table>']
  },
  {
    id: 'CX-JSX-SPREAD-NESTED-COND',
    desc: 'spread + nested fragment + logical-and + ternary mix',
    ref: 'ENG-02 JSX adversarial',
    lang: 'typescriptreact',
    input:
      'const A=(p:any)=><div {...p}>{p.show?(<><b>x</b>{p.n>0&&<span>{p.n}</span>}</>):(<i>none</i>)}</div>;',
    mustContain: ['{...p}', '&&', '<i>none</i>']
  },
  {
    id: 'CX-JSX-FULL-COMPONENT',
    desc: 'realistic React.FC component: props, conditional, map, comment, empty-state',
    ref: 'ENG-02 JSX real-world',
    lang: 'typescriptreact',
    input: [
      'import React from "react";',
      'interface Props { items: string[]; title?: string; onClick:(i:string)=>void }',
      'export const List: React.FC<Props> = ({items,title,onClick}) => {',
      'return (<section className="list">{title && <h2>{title}</h2>}<ul>{items.map((it)=>(<li key={it} onClick={()=>onClick(it)}>{/* item */}{it}</li>))}</ul>{items.length===0?<p>empty</p>:null}</section>);',
      '};'
    ].join('\n'),
    mustContain: ['React.FC<Props>', 'key={it}', '{/* item */}', '&&']
  },

  // --- Template literals (incl. tagged + nested) ---------------------------
  {
    id: 'CX-TPL-INTERP',
    desc: 'plain template literal with interpolation',
    ref: 'P1-modern-syntax',
    lang: 'javascript',
    input: 'const s = `hi ${name}!`;',
    mustContain: ['`hi ${name}!`']
  },
  {
    id: 'CX-TPL-TAGGED',
    desc: 'tagged template literal (gql)',
    ref: 'P1-modern-syntax tagged',
    lang: 'typescript',
    input: 'const q=gql`query{ a b }`;',
    mustContain: ['gql`query{ a b }`']
  },
  {
    id: 'CX-TPL-NESTED',
    desc: 'nested template literals `a${`b${c}d`}e`',
    ref: 'P1-modern-syntax nested',
    lang: 'typescript',
    input: 'const s=`a${`b${c}d`}e`;',
    mustContain: ['`a${`b${c}d`}e`']
  },
  {
    id: 'CX-TPL-TYPE',
    desc: 'template literal TYPES (`#${string}`, `/${string}/${number}`)',
    ref: 'ENG-02 TS template literal types',
    lang: 'typescript',
    input: 'type Hex = `#${string}`;\ntype Route = `/${string}/${number}`;',
    mustContain: ['`#${string}`', '`/${string}/${number}`']
  },
  {
    id: 'CX-TPL-STYLED-MULTILINE',
    desc: 'multiline tagged template (styled-components) with interpolations',
    ref: 'P1-modern-syntax tagged multiline',
    lang: 'typescript',
    input: 'const css = styled.div`\n  color: ${(p) => p.color};\n  padding: ${4}px;\n`;',
    mustContain: ['styled.div`', '${(p) => p.color}']
  },

  // --- Decorators (legacy) -------------------------------------------------
  {
    id: 'CX-DEC-CLASS-METHOD',
    desc: 'legacy class decorator + method decorator',
    ref: '#64 decorators',
    lang: 'typescript',
    input: '@sealed class Foo { @log() bar(){} }',
    mustContain: ['@sealed', '@log()']
  },
  {
    id: 'CX-DEC-FACTORY-FIELDS',
    desc: 'decorator factory on class + field decorators (Angular-style)',
    ref: '#64 decorators',
    lang: 'typescript',
    input:
      '@Component({ selector: "app" })\nexport class AppComponent { @Input() name: string = ""; @Output() ev = new EventEmitter(); }',
    mustContain: ['@Component(', '@Input()', '@Output()']
  },
  {
    id: 'CX-DEC-PARAM-PROPS',
    desc: 'constructor parameter decorators + parameter properties',
    ref: '#64 decorators + TS param props',
    lang: 'typescript',
    input: 'class S{constructor(@inject("a") private a:number, public readonly b:string){}}',
    mustContain: ['@inject("a")', 'private a', 'public readonly b']
  },

  // --- Enums / namespaces --------------------------------------------------
  {
    id: 'CX-ENUM-NUMERIC',
    desc: 'numeric enum with explicit member value',
    ref: 'ENG-02 TS enum',
    lang: 'typescript',
    input: 'enum Color{Red,Green=2,Blue}',
    mustContain: ['enum Color', 'Green = 2']
  },
  {
    id: 'CX-ENUM-STRING-CONST',
    desc: 'const string enum',
    ref: 'ENG-02 TS const enum',
    lang: 'typescript',
    input: 'const enum Dir { Up = "UP", Down = "DOWN" }',
    mustContain: ['const enum Dir', 'Up = "UP"']
  },
  {
    id: 'CX-NAMESPACE',
    desc: 'TS namespace with exported members',
    ref: 'ENG-02 TS namespace',
    lang: 'typescript',
    input: 'namespace NS{export const x=1;export function f(){return x;}}',
    mustContain: ['namespace NS', 'export const x = 1']
  },

  // --- Function overloads --------------------------------------------------
  {
    id: 'CX-OVERLOAD-FN',
    desc: 'standalone function overload signatures + implementation',
    ref: 'ENG-02 TS overloads',
    lang: 'typescript',
    input:
      'function f(a:number):number;function f(a:string):string;function f(a:any){return a;}',
    mustContain: ['function f(a: number): number;', 'function f(a: string): string;']
  },
  {
    id: 'CX-OVERLOAD-METHOD',
    desc: 'method overload signatures inside a class',
    ref: 'ENG-02 TS overloads',
    lang: 'typescript',
    input: 'class C { f(x: number): number; f(x: string): string; f(x: any): any { return x; } }',
    mustContain: ['f(x: number): number;', 'f(x: string): string;']
  },

  // --- Type-only imports / exports -----------------------------------------
  {
    id: 'CX-IMPORT-TYPE-ONLY',
    desc: 'type-only import + inline type specifier',
    ref: 'ENG-02 TS type-only imports',
    lang: 'typescript',
    input: 'import type {Foo} from "./foo";import {type Bar, baz} from "./bar";',
    mustContain: ['import type { Foo }', 'type Bar']
  },
  {
    id: 'CX-EXPORT-TYPE-ONLY',
    desc: 'type-only export + inline type specifier in export',
    ref: 'ENG-02 TS type-only exports',
    lang: 'typescript',
    input: 'export type { Foo, Bar } from "./types";\nexport { type Baz, qux } from "./mix";',
    mustContain: ['export type { Foo, Bar }', 'type Baz']
  },
  {
    id: 'CX-IMPORT-ATTRIBUTES',
    desc: 'import attributes with the modern `with` keyword',
    ref: 'ENG-02 import attributes',
    lang: 'typescript',
    input: 'import data from "./data.json" with { type: "json" };',
    mustContain: ['with { type: "json" }']
  },

  // --- satisfies -----------------------------------------------------------
  {
    id: 'CX-SATISFIES',
    desc: 'satisfies operator',
    ref: 'ENG-02 TS satisfies',
    lang: 'typescript',
    input: 'const cfg={a:1}satisfies Record<string,number>;',
    mustContain: ['satisfies Record<string, number>']
  },
  {
    id: 'CX-SATISFIES-AS-CHAIN',
    desc: 'satisfies followed by an as-assertion',
    ref: 'ENG-02 TS satisfies + as',
    lang: 'typescript',
    input:
      'const config = { port: 3000, host: "localhost" } satisfies ServerConfig as Readonly<ServerConfig>;',
    mustContain: ['satisfies ServerConfig', 'as Readonly<ServerConfig>']
  },

  // --- Optional chaining + nullish chains ----------------------------------
  {
    id: 'CX-OPTCHAIN-NULLISH',
    desc: 'optional chaining + nullish coalescing in one chain',
    ref: '#128,#136,#146,#150',
    lang: 'typescript',
    input: 'const v=a?.b?.c??d?.e??f;',
    mustContain: ['?.', '??']
  },
  {
    id: 'CX-OPTCHAIN-CALL-INDEX',
    desc: 'optional call ?.() and optional index ?.[ ]',
    ref: '#128,#146',
    lang: 'typescript',
    input: 'const r=obj?.method?.()?.value;\nconst x=arr?.[0]?.foo;',
    mustContain: ['?.method', '?.()', '?.[0]']
  },

  // --- Regex literals ------------------------------------------------------
  {
    id: 'CX-REGEX-LITERALS',
    desc: 'regex literals with flags + regex argument to a call',
    ref: 'ENG-02 regex',
    lang: 'javascript',
    input: 'const re=/ab+c/gi;const s="x".replace(/\\d+/g,"#");',
    mustContain: ['/ab+c/gi', '/\\d+/g']
  },
  {
    id: 'CX-REGEX-TERNARY',
    desc: 'regex literals in a ternary + split (division vs regex disambiguation)',
    ref: 'ENG-02 regex disambiguation',
    lang: 'javascript',
    input: 'const r = cond ? /a/g : /b/i;\nconst t = str.split(/\\s*,\\s*/);',
    mustContain: ['/a/g', '/b/i', '/\\s*,\\s*/']
  },

  // --- Numeric separators / BigInt -----------------------------------------
  {
    id: 'CX-NUMERIC-SEPARATORS',
    desc: 'numeric separators across decimal/hex/binary/octal/float',
    ref: 'ENG-02 numeric separators',
    lang: 'javascript',
    input: 'const a = 1_000, b = 0xDE_AD_BE_EF, c = 0b1111_0000, d = 1_000.000_1, e = 1_000n;',
    mustContain: ['1_000', '0xDE_AD_BE_EF', '0b1111_0000', '1_000.000_1', '1_000n']
  },
  {
    id: 'CX-BIGINT-ARITH',
    desc: 'BigInt literals in arithmetic',
    ref: 'review "1n formatted as 1 n"',
    lang: 'javascript',
    input: 'const b=10n+20n;',
    mustContain: ['10n', '20n']
  },

  // --- Private fields / methods --------------------------------------------
  {
    id: 'CX-PRIVATE-FIELDS',
    desc: 'private field, private method, static private field',
    ref: '#141 private fields',
    lang: 'typescript',
    input: 'class C{#x=1;#m(){return this.#x;}static #s=2;}',
    mustContain: ['#x', '#m()', 'this.#x', 'static #s']
  },
  {
    id: 'CX-PRIVATE-ASYNC-CACHE',
    desc: 'private async method using a private field cache',
    ref: '#141 private + async',
    lang: 'typescript',
    input:
      'class C { #cache = new Map(); async #load(k: string) { return this.#cache.get(k); } async get(k: string) { return this.#load(k); } }',
    mustContain: ['#cache', 'async #load', 'this.#load']
  },

  // --- Async generators ----------------------------------------------------
  {
    id: 'CX-ASYNC-GENERATOR',
    desc: 'async generator with yield + await',
    ref: 'ENG-02 async generators',
    lang: 'typescript',
    input: 'async function* g(){yield 1;yield await Promise.resolve(2);}',
    mustContain: ['async function*', 'yield', 'await Promise.resolve(2)']
  }
];

// --- Previously-known-bug fixtures (now fixed; tests assert ACCEPT) ----------
// These are VALID modern syntax the guard used to false-positive REJECT because
// its @babel/parser plugin set was missing 'decoratorAutoAccessors'. The engine
// (prettier) formats them correctly; the guard now parses them and accepts the
// correct format (SPEC §12 "faux positif de la garde" fixed in src/safety/guard.ts).
export const complexKnownBugFixtures: ComplexAcceptFixture[] = [
  {
    id: 'CX-BUG-ACCESSOR',
    desc: 'class auto-accessor field (`accessor x = ...`)',
    ref: 'SPEC §12 faux positif de la garde / ENG-02 accessors',
    lang: 'typescript',
    input: 'class C{get x(){return 1;}set x(v){}accessor y=2;}',
    mustContain: ['accessor y']
  }
];
