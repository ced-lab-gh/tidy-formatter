// Idempotence corpus (SPEC SAFE-03): format(format(x)) === format(x).
// Cadrée comme protection "drift uniquement" — the "code creeps right on every
// save" review cluster ("my code moves to right", "adds 4 tabs instead of 2").
// Each entry is a representative input per language; the test formats it once,
// then formats the result again and asserts the second pass is a byte no-op.
import type { LangId } from '../../src/types';

export interface IdempotenceFixture {
  id: string;
  lang: LangId;
  input: string;
  ref: string;
}

export const idempotenceFixtures: IdempotenceFixture[] = [
  {
    id: 'IDEM-JS',
    lang: 'javascript',
    input: 'const x=1;function f(a,b){return a+b;}',
    ref: 'review "my code moves to right"'
  },
  {
    id: 'IDEM-JS-NESTED',
    lang: 'javascript',
    input: 'if(a){if(b){doThing();}}',
    ref: 'review "code moves to right" (nesting drift)'
  },
  {
    id: 'IDEM-CSS',
    lang: 'css',
    input: '.a{color:red;margin:0}.b{padding:1px}',
    ref: 'drift cluster'
  },
  {
    id: 'IDEM-SCSS',
    lang: 'scss',
    input: '.card{.title{color:red}&:hover{color:blue}}',
    ref: 'drift cluster scss'
  },
  {
    id: 'IDEM-LESS',
    lang: 'less',
    input: '@c:red;.a{color:@c;.b{color:blue}}',
    ref: 'drift cluster less'
  },
  {
    id: 'IDEM-HTML',
    lang: 'html',
    input: '<div><ul><li>a</li><li>b</li></ul></div>',
    ref: '#82 "adds 4 tabs instead of 2", drift'
  },
  {
    id: 'IDEM-JSON',
    lang: 'json',
    input: '{"a":1,"b":{"c":[1,2,3]},"d":"x"}',
    ref: '#134 json drift'
  },
  {
    id: 'IDEM-TS',
    lang: 'typescript',
    input: 'interface I{a:number;b:string}function f<T>(x:T){return x}',
    ref: 'modern-syntax drift'
  },
  {
    id: 'IDEM-TSX',
    lang: 'typescriptreact',
    input: 'const A=()=><div className="x"><span>hi</span></div>;',
    ref: 'jsx drift'
  },
  {
    id: 'IDEM-JSX',
    lang: 'javascriptreact',
    input: 'function A(){return <ul><li>a</li><li>b</li></ul>;}',
    ref: 'jsx drift'
  }
];
