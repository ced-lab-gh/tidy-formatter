// Corpus of Vue template bodies for the differential test against the real Vue
// compiler (vueCompiledOracle.test.ts). Three sources: the cases of the Opus
// audit (21-verif-100-opus.md), hand-written templates, and a seeded generator
// (inline components, text, <pre>, comments, interpolations).
import { VUE_BASIC } from '../fixtures/vueFixtures';

export type CorpusKind = 'report' | 'ordinary' | 'special' | 'generated-inline' | 'generated-block';

export interface CorpusEntry {
  readonly id: string;
  readonly kind: CorpusKind;
  readonly template: string;
}

const REPORT: readonly string[] = [
  // V1
  '\n<div><MyBtn>A</MyBtn> <MyBtn>B</MyBtn></div>\n',
  '\n<div><Star /> <Star /> <Star /></div>\n',
  '\n<div><el-button>A</el-button> <div>x</div></div>\n',
  '\n<div><pre>a\n  b</pre>   <p>c  d</p></div>\n',
  '\n<p><b>aaaaaaaaaa</b> <b>bbbbbbbbbb</b> <b>cccccccccc</b> <b>dddddddddd</b> <b>eeeeeeeeee</b></p>\n',
  '\n<p><NuxtLink to="/a">A</NuxtLink> <NuxtLink to="/b">B</NuxtLink></p>\n',
  '\n<p><b>x</b> <MyIcon /></p>\n',
  // V2
  '\n  <h2>Inbox<Badge :count="n" /></h2>\n',
  '\n<p>(<Count :n="n" />)</p>\n',
  // V5
  "\n<p>{{ x === 'a  b' }}</p>\n",
  '\n<p>{{   spaced   }} and {{tight}}</p>\n',
  // V6
  '\n<my-comp/><span>x</span>\n',
  '\n<div><my-comp /><span>x</span></div>\n',
  // V3
  '\n<comp :fooBar="x" /><MyComp />\n',
  '\n<div><Comp :fooBar="x"></Comp><MyComp></MyComp></div>\n'
];

const ORDINARY: readonly string[] = [
  VUE_BASIC.slice(VUE_BASIC.indexOf('<template>') + 10, VUE_BASIC.indexOf('</template>')),
  '\n<div class="card">\n<h1>{{ title }}</h1>\n<p>{{ body }}</p>\n</div>\n',
  '\n  <ul>\n    <li v-for="item in items" :key="item.id">{{ item.name }}</li>\n  </ul>\n',
  '\n<form @submit.prevent="save"><label>Name <input v-model="name"></label><button type="submit">Save</button></form>\n',
  '\n<header><nav><a href="/">Home</a><a href="/about">About</a></nav></header>\n<main><router-view /></main>\n',
  '\n<div v-if="loading">Loading...</div>\n<div v-else-if="error">{{ error }}</div>\n<div v-else>{{ data }}</div>\n',
  '\n<section>\n  <h2>Title</h2>\n  <p>Some <strong>bold</strong> and <em>italic</em> text.</p>\n</section>\n',
  '\n<table>\n<thead><tr><th>A</th><th>B</th></tr></thead>\n<tbody><tr v-for="r in rows"><td>{{ r.a }}</td><td>{{ r.b }}</td></tr></tbody>\n</table>\n',
  '\n<transition name="fade"><div v-if="show" class="modal">Hi</div></transition>\n',
  '\n<MyList :items="items">\n<template #item="{ row }"><span>{{ row.label }}</span></template>\n<template #empty><em>none</em></template>\n</MyList>\n',
  '\n<div><slot name="header" /><slot /><slot name="footer"></slot></div>\n',
  '\n<button class="btn" :disabled="busy" @click="go">\nGo\n</button>\n',
  '\n<div id="app">\n<!-- header -->\n<Header />\n<!-- body -->\n<Body>content</Body>\n</div>\n',
  '\n<p>\n  Line one\n  Line two   with   gaps\n</p>\n',
  '\n<div><span>a</span><span>b</span></div>\n',
  '\n<div>\n<span>a</span>\n<span>b</span>\n</div>\n',
  '\n<div><span>a</span> <span>b</span></div>\n',
  '\n<div><a href="#">one</a>, <a href="#">two</a> and <a href="#">three</a></div>\n',
  '\n<label for="x">Label</label><input id="x" type="text" v-model="v"><span class="hint">hint</span>\n',
  '\n<img src="a.png" alt="a"><img src="b.png" alt="b">\n',
  '\n<div><br><br/><hr></div>\n',
  '\n<el-row :gutter="20"><el-col :span="12"><el-card>One</el-card></el-col><el-col :span="12"><el-card>Two</el-card></el-col></el-row>\n',
  '\n<v-app><v-main><v-container><v-btn color="primary">Go</v-btn> <v-btn>Stop</v-btn></v-container></v-main></v-app>\n',
  '\n<q-page padding><q-btn label="A" /><q-btn label="B" /></q-page>\n',
  '\n<teleport to="body"><div class="m">modal</div></teleport>\n',
  '\n<Suspense><template #default><Async /></template><template #fallback>Loading</template></Suspense>\n',
  '\n<component :is="current" v-bind="props" @change="onChange" />\n',
  '\n<div :class="{ active: isActive, \'text-danger\': hasError }" :style="{ color: c }">{{ msg }}</div>\n',
  '\n<p v-html="raw"></p><p v-text="txt"></p>\n',
  '\n<div v-for="(v, k, i) in obj" :key="k">{{ i }}. {{ k }}: {{ v }}</div>\n',
  '\n<input type="checkbox" v-model="checked"> <label>{{ checked ? "on" : "off" }}</label>\n',
  '\n<nav><router-link to="/a">A</router-link> | <router-link to="/b">B</router-link></nav>\n',
  '\n<h1>Hello, {{ name }}!</h1>\n',
  '\n<span>{{ a }}</span>{{ b }}<span>{{ c }}</span>\n',
  '\n<div>\n  {{ a }}\n  {{ b }}\n</div>\n',
  '\n<ul><li>one</li><li>two</li><li>three</li></ul>\n',
  '\n<div><p>first</p><p>second</p></div>\n'
];

const SPECIAL: readonly string[] = [
  '\n<pre>\n  keep   this\n    as is\n</pre>\n',
  '\n<div><pre><code>if (x) {\n    y();\n}</code></pre></div>\n',
  // A line break right after the start tag: parse5 drops it, Vue keeps an empty text.
  '\n<pre>\n<b>x</b></pre>\n',
  '\n<pre>\n</pre>\n',
  '\n<div><pre>\n<code>x</code>\n</pre></div>\n',
  '\n<textarea>\n</textarea>\n',
  '\n<textarea>\nfoo</textarea>\n',
  '\n<pre>a\rb</pre>\n',
  '\n<comp :foo />\n<comp :foo="" />\n',
  '\n<input disabled>\n<input disabled="">\n<input v-else>\n',
  '\n<title>{{ a  b }}</title>\n<textarea>{{ a  b }}</textarea>\n',
  '\n<textarea>\n  some   text\n</textarea>\n',
  '\n<p>a <!-- c --> b</p>\n',
  '\n<div><a>x</a> <!-- c --> <b>y</b></div>\n',
  '\n<div>\n<a>x</a>\n<!-- c -->\n<b>y</b>\n</div>\n',
  '\n<div><!-- only comment --></div>\n',
  '\n<div v-pre>{{ raw   text }} <b>x</b> <i>y</i></div>\n',
  '\n<svg viewBox="0 0 10 10"><path d="M0 0L1 1" /><circle r="1" /></svg>\n',
  '\n<svg><text x="1"> a   b </text><g><rect /> <rect /></g></svg>\n',
  '\n<p>a &nbsp; b &amp;&amp; c &lt; d</p>\n',
  '\n<p>&#123;&#123; not   interp }}</p>\n',
  '\n<p>{{ unterminated <b>x</b> }}</p>\n',
  '\n<p>{{ a < b }} and {{ c > d }}</p>\n',
  '\n<div><a><a>nested</a></a></div>\n',
  '\n<div class="a" class="b">dup</div>\n',
  '\n<PRE>  upper   </PRE>\n',
  '\n<div><BR> <b>x</b></div>\n',
  '\n<ul><li>a<li>b</ul>\n',
  '\n<table><tr><td>a</td><td>b</td></tr></table>\n',
  '\n<div><td>stray</td></div>\n',
  '\n<table>\n<tr><td>a</td></tr>\n<tr><td>b</td></tr>\n</table>\n',
  '\n<table><thead><tr><th>h</th></tr></thead><tr><td>x</td></tr></table>\n',
  '\n<table><caption>c</caption><tr><td>a</td> <td>b</td></tr> </table>\n',
  '\n<table><tr><td>a</td></tr><!-- c --><tr><td>b</td></tr></table>\n',
  '\n<table><tbody><tr><td>a</td></tr></tbody></table>\n',
  '\n<table><tr><td><table><tr><td>n</td></tr></table></td></tr></table>\n',
  '\n<table>text<tr><td>a</td></tr></table>\n',
  '\n<select v-model="s"><option value="1">One</option><option value="2">Two</option></select>\n',
  '\n<template v-if="ok"><span>a</span> <span>b</span></template>\n',
  '\n<div style="white-space: pre">a   b\n  c</div>\n',
  '\n<div>\r\n<span>a</span>\r\n<span>b</span>\r\n</div>\r\n',
  '\n<p>tab\tseparated\ttext</p>\n',
  '\n<div> </div>\n',
  '\n<div>\n</div>\n',
  '\n<span> </span> <span> </span>\n',
  '\n<p>\xa0<b>x</b>\xa0</p>\n',
  '\n<iframe src="x"></iframe>\n',
  '\n<div><script>var a  =  1;</script> <b>x</b></div>\n',
  '\n<button>OK</button> <button>Cancel</button>\n',
  '\n<p>{{ a }} {{ b }}</p>\n',
  '\n<p> {{ a }} </p>\n',
  '\n<A /><B /><C />\n',
  '\n<div><Foo /></div>\n',
  '\n<div>text <Foo /> text</div>\n',
  '\n<div>text<Foo />text</div>\n',
  '\n<span>x</span>\n\n\n<span>y</span>\n'
];

// --- seeded generator -------------------------------------------------------

type Rng = () => number;

/** mulberry32: small, deterministic, good enough for a corpus. */
export function seededRng(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)];
}

const HTML_TAGS = ['div', 'span', 'p', 'b', 'a', 'i', 'section', 'label', 'button', 'em', 'h2', 'ul', 'li'];
const COMPONENTS = ['MyBtn', 'Badge', 'NuxtLink', 'my-btn', 'el-tag', 'v-icon', 'Star'];
const SELF_CLOSING = ['Star', 'Badge', 'MyIcon', 'Count', 'my-icon'];
const ATTRS = ['', '', ' class="a b"', ' :class="{ a: b }"', ' @click="go()"', ' v-if="ok"', ' :count="n"', ' to="/x"', ' :fooBar="x"'];
const WORDS = ['Hello', 'world', 'Inbox', 'x', '(', ')', ':', 'a  b', 'one two', 'end.'];
const RARE_NODES = [
  'a&nbsp;b',
  'x &amp;&amp; y',
  '<br>',
  '<img src="a.png">',
  '<input v-model="v">',
  '<textarea>x  y</textarea>',
  '<textarea>\n</textarea>',
  '<pre>\n<b>t</b></pre>',
  '<div v-pre>{{ raw   }} <b>x</b> <i>y</i></div>',
  '<template v-if="ok"><b>t</b> <i>u</i></template>',
  '<table><tr><td>c</td> <td>d</td></tr></table>',
  '<svg viewBox="0 0 1 1"><path d="M0 0" /> <g><rect /></g></svg>',
  '<button>OK</button> <button>No</button>'
];
const INTERPOLATIONS =['{{ a }}', '{{b}}', "{{ c + ' d' }}", '{{  e.f  }}'];

interface Style {
  readonly gaps: readonly string[];
}

const INLINE_STYLE: Style = { gaps: ['', '', ' ', ' ', '  '] };
const BLOCK_STYLE: Style = { gaps: ['\n  ', '\n    ', '\n', '\n\n'] };
const MIXED_STYLE: Style = { gaps: ['', ' ', '\n  ', '\n', ' \n '] };

function generateNode(rng: Rng, depth: number, style: Style): string {
  const roll = rng();
  if (depth <= 0 || roll < 0.18) {
    return pick(rng, WORDS);
  }
  if (roll < 0.28) {
    return pick(rng, INTERPOLATIONS);
  }
  if (roll < 0.34) {
    return `<!-- ${pick(rng, WORDS)} -->`;
  }
  if (roll < 0.46) {
    const name = pick(rng, SELF_CLOSING);
    return `<${name}${pick(rng, ATTRS)} />`;
  }
  if (roll < 0.5) {
    return `<pre>${pick(rng, WORDS)}\n  ${pick(rng, WORDS)}</pre>`;
  }
  if (roll < 0.56) {
    return pick(rng, RARE_NODES);
  }
  const name = pick(rng, rng() < 0.6 ? HTML_TAGS : COMPONENTS);
  const count = Math.floor(rng() * 4);
  let inner = '';
  for (let i = 0; i < count; i += 1) {
    inner += (i === 0 && rng() < 0.5 ? '' : pick(rng, style.gaps)) + generateNode(rng, depth - 1, style);
  }
  inner += rng() < 0.5 ? '' : pick(rng, style.gaps);
  return `<${name}${pick(rng, ATTRS)}>${inner}</${name}>`;
}

function generateTemplate(rng: Rng, style: Style): string {
  const roots = 1 + Math.floor(rng() * 3);
  const parts: string[] = [];
  for (let i = 0; i < roots; i += 1) {
    parts.push(generateNode(rng, 3, style));
  }
  return `\n${parts.join(pick(rng, style.gaps))}\n`;
}

/** Number of generated templates per style; 3 styles, so 3x this many. */
const GENERATED_PER_STYLE = 100;

export function buildVueTemplateCorpus(): CorpusEntry[] {
  const entries: CorpusEntry[] = [];
  const add = (kind: CorpusKind, templates: readonly string[]): void => {
    templates.forEach((template, index) => {
      entries.push({ id: `${kind}-${index}`, kind, template });
    });
  };
  add('report', REPORT);
  add('ordinary', ORDINARY);
  add('special', SPECIAL);

  const styles: ReadonlyArray<readonly [CorpusKind, Style, number]> = [
    ['generated-inline', INLINE_STYLE, 11],
    ['generated-block', BLOCK_STYLE, 22],
    ['generated-inline', MIXED_STYLE, 33]
  ];
  for (const [kind, style, seed] of styles) {
    const rng = seededRng(seed);
    const generated: string[] = [];
    for (let i = 0; i < GENERATED_PER_STYLE; i += 1) {
      generated.push(generateTemplate(rng, style));
    }
    generated.forEach((template, index) => {
      entries.push({ id: `${kind}-${seed}-${index}`, kind, template });
    });
  }
  return entries;
}

// --- markup mutants: names, `/>`, interpolation text (V3, V5, V6) ------------

const SELF_CLOSED = /<([A-Za-z][\w-]*)((?:\s[^<>]*?)?)\s*\/>/g;
const EMPTY_PAIR = /<([A-Za-z][\w-]*)((?:\s[^<>]*?)?)><\/\1>/g;
const OPEN_OR_CLOSE = /<\/?([A-Za-z][\w-]*)/g;
const OPEN_TAG = /<[A-Za-z][^<>]*>/g;
const MIXED_CASE_ATTR =/(\s[:@#]?)([a-z]+[A-Z][A-Za-z]*)(=)/g;

/** Replace the n-th match of a global regex; undefined when there is none. */
function replaceNth(text: string, pattern: RegExp, n: number, replacer: (match: RegExpMatchArray) => string): string | undefined {
  const matches = [...text.matchAll(pattern)];
  if (matches.length === 0) {
    return undefined;
  }
  const match = matches[n % matches.length];
  const at = match.index ?? 0;
  return text.slice(0, at) + replacer(match) + text.slice(at + match[0].length);
}

/** Templates that differ from `template` in a name, a `/>`, or interpolation text. */
export function markupMutants(template: string, rng: Rng): string[] {
  const n = Math.floor(rng() * 1000);
  const candidates: Array<string | undefined> = [
    // `<A x />` -> `<A x></A>` : same element for Vue, different tag text.
    replaceNth(template, SELF_CLOSED, n, (m) => `<${m[1]}${m[2]}></${m[1]}>`),
    // `<A x></A>` -> `<A x />`
    replaceNth(template, EMPTY_PAIR, n, (m) => `<${m[1]}${m[2]} />`),
    // a tag name written in another case (opening tag only, closing kept)
    replaceNth(template, OPEN_OR_CLOSE, n, (m) =>
      m[0].replace(m[1], m[1] === m[1].toLowerCase() ? m[1].toUpperCase() : m[1].toLowerCase())
    ),
    // `:fooBar=` -> `:foobar=`
    replaceNth(template, MIXED_CASE_ATTR, n, (m) => `${m[1]}${m[2].toLowerCase()}${m[3]}`),
    // an attribute losing its value, or a bare one gaining `=""`
    replaceNth(template, OPEN_TAG, n, (m) => m[0].replace(/="[^"]*"/, '')),
    replaceNth(template, OPEN_TAG, n, (m) => m[0].replace(/(\s[:@a-z][\w:.@-]*)(?=\s|\/?>)/, '$1=""')),
    // the blanks between attributes (and, by accident, inside a value)
    replaceNth(template, OPEN_TAG, n, (m) =>
      m[0].replace(/(\S)\s+(?=\S)/, (_all, last: string) => last + (n % 2 === 0 ? '\n  ' : '   '))
    ),
    // blanks inside an interpolation, edge and middle
    replaceNth(template, /\{\{[^}]*\}\}/g, n, (m) => m[0].replace(/\{\{\s*/, '{{').replace(/\s*\}\}/, '}}')),
    replaceNth(template, /\{\{[^}]*\}\}/g, n, (m) => m[0].replace(/(\w) (\w)/, '$1  $2').replace(/\+ /, '+  '))
  ];
  return candidates.filter((c): c is string => c !== undefined && c !== template);
}

// --- whitespace mutants (what a formatter COULD do, not only what ours does) --

const GAP_VARIANTS = ['', ' ', '  ', '\n', '\n  ', ' \n', '\t', '\r\n', '\r'];

/** Up to `count` distinct templates differing from `template` only by whitespace outside tags. */
export function whitespaceMutants(template: string, rng: Rng, count: number): string[] {
  const results = new Set<string>();
  for (let attempt = 0; attempt < count * 4 && results.size < count; attempt += 1) {
    const parts = template.split(/(<[^>]*>)/);
    const edits = 1 + Math.floor(rng() * 3);
    for (let e = 0; e < edits; e += 1) {
      const index = 2 * Math.floor(rng() * Math.ceil(parts.length / 2));
      if (index >= parts.length) {
        continue;
      }
      const text = parts[index];
      const runs = [...text.matchAll(/[ \t\r\n]+/g)];
      if (runs.length > 0 && rng() < 0.7) {
        const run = pick(rng, runs);
        const at = run.index ?? 0;
        parts[index] = text.slice(0, at) + pick(rng, GAP_VARIANTS) + text.slice(at + run[0].length);
      } else {
        const at = rng() < 0.5 ? 0 : text.length;
        parts[index] = text.slice(0, at) + pick(rng, GAP_VARIANTS.slice(1)) + text.slice(at);
      }
    }
    const mutant = parts.join('');
    if (mutant !== template) {
      results.add(mutant);
    }
  }
  return [...results];
}
