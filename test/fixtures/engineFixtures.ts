// Engine + dispatcher regression fixtures (SPEC ENG-01/ENG-02, §4 matrix).
//
// Two property families:
//   - PRESERVE: after formatting through the dispatcher, a syntactic token that
//     the incumbent corrupted (?. ?? 1n #x <App/> f<T>) must still be present
//     AND the output must round-trip through the safety guard as equivalent.
//   - ROUTING: each languageId must resolve to the correct engine id.
//
// Source: spec.json pain_clusters P0-corruption/P1-modern-syntax,
// data/github_issues_raw.json (#128,#136,#141,#146,#150,#64,#76,#80).
import type { LangId } from '../../src/types';

export interface PreserveFixture {
  id: string;
  desc: string;
  ref: string;
  lang: LangId;
  input: string;
  /** Substrings that MUST survive verbatim in the formatted output. */
  mustContain: string[];
}

export const preserveFixtures: PreserveFixture[] = [
  {
    id: 'ENG-OPTCHAIN',
    desc: 'js-beautify preserves optional chaining ?.',
    ref: '#128,#146',
    lang: 'javascript',
    input: 'const n = obj?.prop?.deep;',
    mustContain: ['?.']
  },
  {
    id: 'ENG-NULLISH',
    desc: 'js-beautify preserves nullish coalescing ??',
    ref: '#136,#150',
    lang: 'javascript',
    input: 'const v = a ?? b ?? c;',
    mustContain: ['??']
  },
  {
    id: 'ENG-BIGINT',
    desc: 'js-beautify preserves BigInt literal 1n',
    ref: 'review "1n formatted as 1 n"',
    lang: 'javascript',
    input: 'const big = 9007199254740993n;',
    mustContain: ['9007199254740993n']
  },
  {
    id: 'ENG-PRIVATE-FIELD',
    desc: 'js-beautify preserves class private field #x',
    ref: '#141',
    lang: 'javascript',
    input: 'class C {\n  #secret = 1;\n  get v() { return this.#secret; }\n}',
    mustContain: ['#secret']
  },
  {
    id: 'ENG-ASYNC',
    desc: 'js-beautify preserves async/await',
    ref: '#68',
    lang: 'javascript',
    input: 'async function f() { return await g(); }',
    mustContain: ['async', 'await']
  },
  {
    id: 'ENG-TEMPLATE-LITERAL',
    desc: 'js-beautify preserves template literals',
    ref: 'P1-modern-syntax',
    lang: 'javascript',
    input: 'const s = `hi ${name}!`;',
    mustContain: ['`hi ${name}!`']
  },
  {
    id: 'ENG-JSX-APP',
    desc: 'prettier formats <App /> and keeps it <App />',
    ref: 'SPEC §4 / review "It formats <App />"',
    lang: 'javascriptreact',
    input: 'const a = <App />;',
    mustContain: ['<App />']
  },
  {
    id: 'ENG-TSX-COMPONENT',
    desc: 'prettier formats a TSX component with props without breaking the tag',
    ref: '#64,#76,#80',
    lang: 'typescriptreact',
    input: 'const a = <Foo bar={x} baz="y" />;',
    mustContain: ['<Foo', 'bar={x}', '/>']
  },
  {
    id: 'ENG-TS-GENERIC',
    desc: 'prettier formats function f<T> without inserting spaces in the generic',
    ref: 'SPEC §4 "function f<T>"',
    lang: 'typescript',
    input: 'function f<T>(x:T):T{return x;}',
    mustContain: ['f<T>']
  },
  {
    id: 'ENG-TS-DECORATOR',
    desc: 'prettier formats a decorated class member',
    ref: '#64 decorators',
    lang: 'typescript',
    input: 'class C {\n  @log method() {}\n}',
    mustContain: ['@log']
  }
];

export interface RoutingFixture {
  lang: LangId;
  expectedEngineId: 'js-beautify' | 'prettier';
  /** Optional code; when the languageId is 'javascript' the content decides. */
  code?: string;
  note: string;
}

export const routingFixtures: RoutingFixture[] = [
  { lang: 'css', expectedEngineId: 'js-beautify', note: 'css -> js-beautify' },
  { lang: 'scss', expectedEngineId: 'js-beautify', note: 'scss -> js-beautify' },
  { lang: 'less', expectedEngineId: 'js-beautify', note: 'less -> js-beautify' },
  { lang: 'html', expectedEngineId: 'js-beautify', note: 'html -> js-beautify' },
  { lang: 'json', expectedEngineId: 'js-beautify', note: 'json -> js-beautify' },
  { lang: 'jsonc', expectedEngineId: 'js-beautify', note: 'jsonc -> js-beautify' },
  { lang: 'javascript', expectedEngineId: 'js-beautify', note: 'plain js -> js-beautify' },
  { lang: 'typescript', expectedEngineId: 'prettier', note: 'ts -> prettier (real parser)' },
  { lang: 'typescriptreact', expectedEngineId: 'prettier', note: 'tsx -> prettier' },
  { lang: 'javascriptreact', expectedEngineId: 'prettier', note: 'jsx -> prettier' }
];
