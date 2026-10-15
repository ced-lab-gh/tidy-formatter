// Input for the JSX boundary fingerprint differential test
// (test/unit/safety/jsxFingerprintDifferential.test.ts): hand-written edge cases
// plus seeded, reproducible generators. No Math.random: the same seed always
// yields the same cases, so a disagreement is always reproducible.

/** Small, fast, seedable PRNG (mulberry32). */
export function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- hand-written edge cases -------------------------------------------------

/**
 * Whole programs. Grouped by what they stress; every group is here because the
 * review (or the old implementation's own comment) names it as a way the two
 * implementations could part ways. Programs the parser refuses are welcome: the
 * differential also demands that both implementations refuse them.
 */
export const EDGE_CASES: readonly string[] = [
  // no JSX at all
  '',
  '   \n',
  'const a = 1;',
  'if (a < b && c > d) { go(); }',
  'for (let i = 0; i < n; i++) { x[i] <<= 1; }',
  'const s = "<A />"; const t = \'< B >\'; const r = /<A\\/>/.test(s);',
  'const tpl = `<div>${x}</div>`;',
  '// <A />\n/* < B /> */\nconst z = 1;',
  '<!-- html comment\nconst a = 1;',
  'x = a <!--b\n;',
  '#!/usr/bin/env node\nconst a = <A />;',
  '﻿const a = <A />;',

  // a glued or detached opening `<`, every kind of separator
  'const a = <A />;',
  'const a = < A />;',
  'const a = <\nA />;',
  'const a = <\tA />;',
  'const a = <  \n  A />;',
  'const a = < A />;',
  'const a = < A />;',
  'const a = <　A />;',
  'const a = <﻿A />;',
  'const a = <\u000bA />;',

  // a comment, or a line break, between `<` and the name
  'const a = </*c*/A />;',
  'const a = < /*c*/A />;',
  'const a = </*c*/ A />;',
  'const a = <\n/*c*/A />;',
  'const a = <//c\nA />;',
  'const a = < //c\nA />;',
  'const a = </* a *//* b */A />;',
  'const a = <A></*c*/A>;',

  // closing tags: `</`, `< /`, `</ `, `<//c`
  'const a = <A></A>;',
  'const a = <A></ A>;',
  'const a = <A></A >;',
  'const a = <A>< /A>;',
  'const a = <A><\n/A>;',
  'const a = <A><//c\n/A>;',
  'const a = <A></*c*/ /A>;',
  'const a = <A>< /*c*/ /A>;',
  'const a = <A / >;',
  'const a = <A /\n>;',
  'const a = < A / >;',

  // fragments
  'const a = <></>;',
  'const a = < ></>;',
  'const a = <></ >;',
  'const a = <>< />;',
  'const a = <></*c*/>;',
  'const a = <\n></>;',
  'const a = <><A /><B /></>;',
  'const a = <> <A /> <B /> </>;',
  'export default () => <><A/><B/></>;',

  // member expressions and namespaced names
  'const a = <a.b />;',
  'const a = <a.b.c></a.b.c>;',
  'const a = <a . b />;',
  'const a = < a.b />;',
  'const a = <a\n.b />;',
  'const a = <a:b />;',
  'const a = <a : b />;',
  'const a = < a:b></a:b>;',
  'const a = <a-b c-d="1" />;',
  'const a = <this.x />;',
  'const a = <Ä />;',

  // attributes holding elements, spreads, children holding elements
  'const a = <A x=<B /> />;',
  'const a = <A x={<B />} />;',
  'const a = <A x={< B />} />;',
  'const a = <A {...{ x: <B /> }} />;',
  'const a = <A x="1" y={2} {...p} z />;',
  'const a = <A>\n  text\n  <B />\n  {x}\n  {/* c */}\n</A>;',
  'const a = <A>{cond ? <B /> : < C />}</A>;',
  'const a = <div>a &lt; b &gt; c</div>;',
  "const a = <a b='<c>' />;",
  'const a = <A>{"<B/>"}</A>;',

  // JSX inside templates, private names, decorators, other positions
  'const a = `${<A />}`;',
  'const a = `${< A />}`;',
  'const a = `x${`y${<A />}`}z`;',
  'const a = `${<A />}${< B />}${<C />}`;',
  'class C { #p = <A />; m() { return #p in this; } }',
  'class C { #p = < A />; #q = <B />; m() { return this.#p; } }',
  'class C { accessor x = <A />; }',
  '@dec(<A />) class C {}',
  '@dec class C { @x(< B />) m() {} }',
  'const a = (<A />);',
  'const a = (< A />);',
  '<A />;',
  '< A />;',
  'label: <A />;',
  'function f() { return <A />; }',
  'const a = cond ? <A /> : <B />;',
  'const a = () => <A />;',
  'const a = async () => { await x; return < A />; };',
  'for (const x of xs) { out.push(<li key={x}>{x}</li>); }',
  'export const App = () => { const [a, b] = useState(); return <div className="app"><h1>Hi</h1></div>; };',

  // TypeScript constructs that share the `<` with JSX
  'const f = <T,>(x: T) => x;',
  'const f = <T extends unknown>(x: T) => <A b={x} />;',
  'const f = <const T,>(x: T) => x;',
  'const f = async (x: T) => x;', // the generic form after `async` is pinned in the "MORE than the reference" test
  'f<T>(x); g<T, U>(y); new H<T>();',
  'a < b; c > d; e << f; g >> h;',
  'const x = y as Array<string>;',
  'type A = Array<B<C>>; interface I<T> { m<U>(u: U): T }',
  'class K<T> extends L<T> { m<U>(u: U): T { return u as any; } }',
  'const a = <Foo<string> bar="x" />;',
  'const a = < Foo<string> bar="x" />;',
  'const a = <Foo<string>></Foo>;',
  'const a: Array<number> = [1]; const b = <A />;',
  'const a = x satisfies Y<Z>; const b = <A />;',
  'function g<T>(this: Window, x: T): x is T { return <A /> as any; }',

  // positions after astral characters and line terminators
  'const s = "😀"; const a = < A />;',
  '/* 😀 */ const a = <A />;',
  'const a = <A>😀</A>; const b = < B />;',
  'const a = 1;\r\nconst b = < A />;\r\n',
  'const a = 1; const b = < A />;',

  // deep nesting
  `const a = ${'<A>'.repeat(60)}x${'</A>'.repeat(60)};`,
  `const a = ${'<A>'.repeat(60)}x${'< /A>'.repeat(60)};`,

  // programs the parser refuses: both implementations must refuse them too
  'const a = <A;',
  'const a = <T>x;',
  'const a = <A></B>;',
  'const a = < ;',
  'const a = <A b= />;',
  '<'
];

// --- grammar-based generator --------------------------------------------------

const GAPS: readonly string[] = [
  '', '', '', '', ' ', '\n', '\t', '  ', '/*c*/', ' /*c*/', '/*c*/ ', '//c\n', ' ', ' ', ' \n '
];
const GAPS_AFTER_SLASH: readonly string[] = GAPS.filter((gap) => !gap.startsWith('/'));
/** A gap that separates two names, so it must not be empty. */
const SEPARATORS: readonly string[] = [' ', '\n', '\t', '/*c*/', ' /*c*/ ', '//c\n', ' ', ' '];
const NAMES: readonly (readonly string[])[] = [
  ['A'], ['div'], ['Ä'], ['a', '.', 'b'], ['a', '.', 'b', '.', 'c'], ['A', '.', 'B'], ['a', ':', 'b'], ['this', '.', 'x']
];
const TEXTS: readonly string[] = ['', 'hi ', ' a &lt; b ', 'x\n  y', '{"<"}'];

class Gen {
  constructor(private readonly rng: () => number) {}

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.rng() * items.length)];
  }

  chance(p: number): boolean {
    return this.rng() < p;
  }

  /** A gap right after a `/`: it must not start with `/`, or the pair would read as a comment. */
  gapAfterSlash(): string {
    return this.pick(GAPS_AFTER_SLASH);
  }

  gap(): string {
    return this.pick(GAPS);
  }

  private separator(): string {
    return this.pick(SEPARATORS);
  }

  private name(parts: readonly string[]): string {
    return parts.map((part) => (part === '.' || part === ':' ? `${this.gap()}${part}${this.gap()}` : part)).join('');
  }

  private attributes(depth: number): string {
    let out = '';
    const count = Math.floor(this.rng() * 4);
    for (let i = 0; i < count; i += 1) {
      const sep = this.separator();
      switch (Math.floor(this.rng() * 6)) {
        case 0: out += `${sep}x${this.gap()}=${this.gap()}"v"`; break;
        case 1: out += `${sep}y={1}`; break;
        case 2: out += `${sep}{...p}`; break;
        case 3: out += `${sep}z`; break;
        case 4: out += `${sep}w=${this.element(depth + 1)}`; break;
        default: out += `${sep}u={${this.element(depth + 1)}}`; break;
      }
    }
    return out;
  }

  private children(depth: number): string {
    let out = '';
    const count = Math.floor(this.rng() * 4);
    for (let i = 0; i < count; i += 1) {
      switch (Math.floor(this.rng() * 5)) {
        case 0: out += this.pick(TEXTS); break;
        case 1: out += '{x}'; break;
        case 2: out += '{/* c */}'; break;
        case 3: out += `{cond ? ${this.element(depth + 1)} : null}`; break;
        default: out += this.element(depth + 1); break;
      }
    }
    return out;
  }

  element(depth: number): string {
    const kind = depth >= 3 ? 0 : Math.floor(this.rng() * 3);
    const parts = this.pick(NAMES);
    if (kind === 0) {
      return `<${this.gap()}${this.name(parts)}${this.attributes(depth)}${this.gap()}/${this.gapAfterSlash()}>`;
    }
    if (kind === 1) {
      return (
        `<${this.gap()}${this.name(parts)}${this.attributes(depth)}${this.gap()}>` +
        `${this.children(depth)}<${this.gap()}/${this.gapAfterSlash()}${this.name(parts)}${this.gap()}>`
      );
    }
    return `<${this.gap()}>${this.children(depth)}<${this.gap()}/${this.gapAfterSlash()}>`;
  }

  /** A TypeScript generic arrow function: its `<` is lexed like a JSX tag start, then backed out of. */
  genericArrow(body: string): string {
    const params = this.pick(['T,', 'T extends unknown', 'const T,', 'T, U', 'T = string,', 'T extends X<U>,']);
    return `<${this.gap()}${params}${this.gap()}>(x: T) => ${body}`;
  }

  /** One statement that embeds an element in a context that stresses the tokenizer. */
  statement(): string {
    const el = this.element(0);
    switch (Math.floor(this.rng() * 26)) {
      case 0: return `const a = ${el};`;
      case 1: return `const a = (${el});`;
      case 2: return `function f() { return ${el}; }`;
      case 3: return `const s = \`a\${${el}}b\${${this.element(1)}}\`;`;
      case 4: return `class C { #p = ${el}; m() { return #p in this; } }`;
      case 5: return `${el};`;
      case 6: return `const a = cond ? ${el} : ${this.element(1)};`;
      case 7: return `export default () => ${el};`;
      case 8: return `const f = ${this.genericArrow(el)};`;
      case 9: return `f<T>(a); const b = a < c; const d = ${el};`;
      case 10: return `const t = \`\${x}\`; const a = ${el}; const u = \`\${y}\`;`;
      case 11: return `@dec(${el}) class C { #q = 1; }`;
      case 12: return `const g = async (x: T) => ${el};`;
      case 13: return `foo(${this.genericArrow('x')}, ${el});`;
      case 14: return `const o = { m: ${this.genericArrow(el)}, n: ${el} };`;
      case 15: return `const r = a ? (b) : ${el};`;
      case 16: return `const r = a ? (b) : c => ${el};`;
      case 17: return `const r = a ? ${this.genericArrow('c')} : ${el};`;
      case 18: return `const r = (${this.genericArrow('x')})(1);`;
      case 19: return `class K { p = ${this.genericArrow(el)}; q = ${el}; }`;
      case 20: return `const v = <A x={${this.genericArrow('y')}} />; const w = ${el};`;
      case 21: return `export default ${this.genericArrow(this.genericArrow(el))};`;
      case 22: return `type F = <T,>(x: T) => T; const a = ${el};`;
      case 23: return `const x = y satisfies Z<W>; let v = a < b && c > d; const a = ${el};`;
      case 24: return `const h = ${this.genericArrow(`\`\${${el}}\``)};`;
      default: return `const k = (${this.genericArrow('x')}) as unknown as F<G>; const a = ${el};`;
    }
  }

  program(): string {
    const count = 1 + Math.floor(this.rng() * 3);
    const statements: string[] = [];
    for (let i = 0; i < count; i += 1) {
      statements.push(i === 0 ? this.statement() : `{ ${this.statement()} }`);
    }
    return statements.join('\n');
  }
}

/** `count` generated programs, reproducible from `seed`. */
export function generateGrammarCases(seed: number, count: number): string[] {
  const gen = new Gen(makeRng(seed));
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push(gen.program());
  }
  return out;
}

// --- mutation-based generator --------------------------------------------------

const MUTATION_CHARS: readonly string[] = ['<', '>', '/', '=', '{', '}', ' ', '\n', 'x', '"', '`', '#'];

/** Apply one to three random edits to each seed program. Most mutants stay parseable; the rest must be refused by both sides alike. */
export function mutateCases(seeds: readonly string[], seed: number, count: number): string[] {
  const rng = makeRng(seed);
  const gen = new Gen(rng);
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    let text = seeds[Math.floor(rng() * seeds.length)];
    const edits = 1 + Math.floor(rng() * 3);
    for (let e = 0; e < edits; e += 1) {
      const at = Math.floor(rng() * (text.length + 1));
      switch (Math.floor(rng() * 5)) {
        case 0: text = text.slice(0, at) + gen.pick(GAPS) + text.slice(at); break;
        case 1: text = text.slice(0, at) + text.slice(at + 1); break;
        case 2: text = text.slice(0, at) + gen.pick(MUTATION_CHARS) + text.slice(at + 1); break;
        case 3: text = text.replace(/</g, () => `<${gen.pick(GAPS)}`); break;
        default: text = text.slice(0, at) + text.slice(at, at + 12) + text.slice(at); break;
      }
    }
    out.push(text);
  }
  return out;
}
