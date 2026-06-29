// POLYGLOT HTML corpus — fixtures mixing several embedded languages inside ONE
// HTML document, exercising the guard's per-embedded-language canonicalisation:
//   - several <script> blocks of modern JS,
//   - a <script type="application/json"> data block,
//   - several <style> blocks (CSS with @media / var() / calc()),
//   - inline event handlers (onclick="..."),
//   - inline style="..." attributes,
//   - inline <svg> with camelCase + namespaced attrs,
//   - template islands {{ }} / {% %} / <% %> (must be preserved literally),
//   - <pre>/<textarea> verbatim content.
//
// Every fixture is VALID HTML the engine reformats. The acceptance contract
// asserted by the unit suite (test/unit/polyglot/html-embedded.test.ts) is:
//   1. htmlTreeEqual(input, dispatchFormat('html', input)) === equivalent
//      (the embedded JS/CSS/JSON is re-indented but stays semantically identical;
//       template islands + <pre>/<textarea> stay intact). A false-positive
//       rejection here is the "safe but does nothing" failure SPEC §12 forbids.
//   2. format(format(x)) === format(x) (idempotence / SAFE-03, no right-drift).
//
// The module is 'vscode'-free so it imports cleanly under mocha + tsx.

export interface PolyglotFixture {
  /** Stable id used in the test title. */
  id: string;
  /** Human-readable description of what languages this fixture mixes. */
  desc: string;
  /** The messy-but-valid polyglot HTML source. */
  input: string;
  /**
   * Tokens that MUST survive verbatim after formatting. These pin the exact
   * fragments most at risk of corruption (template islands, <pre> bodies,
   * verbatim data, namespaced SVG attrs, modern-JS operators) so a regression
   * fails loudly even if the tree guard somehow let it through.
   */
  mustContain: string[];
}

const lines = (...l: string[]): string => l.join('\n');

// --- 1. Two <script> + two <style> + JSON data block -------------------------
const MULTI_SCRIPT_STYLE = lines(
  '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Multi</title>',
  '<style>:root{--brand:#3366ff;--gap:12px}body{margin:0;color:var(--brand)}</style>',
  '<style>@media (max-width:600px){.card{width:calc(100% - var(--gap))}}</style>',
  '</head><body>',
  '<main class="card"><h1>Hello</h1></main>',
  '<script type="application/json" id="data">{"items":[1,2,3],"meta":{"ok":true,"n":null}}</script>',
  '<script>const xs=[1,2,3];function sum(a){let s=0;for(const x of a){s+=x}return s}console.log(sum(xs))</script>',
  '<script type="module">import {x} from "./m.js";export const y=x?.z??0;</script>',
  '</body></html>'
);

// --- 2. Inline onclick + inline style + a <script> ---------------------------
const INLINE_HANDLERS = lines(
  '<div class="wrap" style="display:flex;  gap:10px;color:#222">',
  '<button onclick="doThing(event); return false;" style="padding:4px 8px">Go</button>',
  '<button onmouseover="hover(this)" onfocus="track(\'btn\')">Focus</button>',
  '<a href="#x" style="text-decoration:none" onclick="nav(event)">Link</a>',
  '</div>',
  '<script>function doThing(e){e.preventDefault();const v=e.target?.value??"";console.log(v)}</script>'
);

// --- 3. Inline <svg> + CSS var()/calc() in <style> ---------------------------
const SVG_AND_STYLE = lines(
  '<section>',
  '<style>.icon{width:calc(2 * var(--u, 8px));fill:var(--brand,#000)}</style>',
  '<svg viewBox="0 0 100 100" width="48" height="48" xmlns="http://www.w3.org/2000/svg">',
  '<defs><linearGradient id="g1"><stop offset="0%" stop-color="#f00"/><stop offset="100%" stop-color="#00f"/></linearGradient></defs>',
  '<circle cx="50" cy="50" r="40" fill="url(#g1)" class="icon"></circle>',
  '<use xlink:href="#g1"></use>',
  '</svg>',
  '</section>'
);

// --- 4. Template islands {{ }} / {% %} / <% %> in text + attributes ----------
// NB: islands live in TEXT and ATTRIBUTES only — never inside a default <script>
// body, where `{{ }}` is invalid JS that js-beautify reflows and the guard then
// (correctly) rejects. That conservative reject is exercised separately as a
// negative control in the test file.
const TEMPLATE_ISLANDS = lines(
  '<article data-count="{{count}}">',
  '<h1>{{ user.name }}</h1>',
  '{% for badge in user.badges %}<span class="badge">{{ badge }}</span>{% endfor %}',
  '<% if (showBanner) { %><div class="banner"><%= bannerText %></div><% } %>',
  '<footer>{{ year }} — <%= owner %></footer>',
  '</article>',
  '<style>.badge{display:inline-block;margin:0 calc(var(--gap,4px) / 2)}</style>',
  '<script>render(document.getElementById("data")?.textContent)</script>'
);

// --- 5. <pre> + <textarea> verbatim alongside formatted code -----------------
const VERBATIM_BLOCKS = lines(
  '<div>',
  '<style>code{font-family:"Courier New",monospace}</style>',
  '<pre>  function deep() {',
  '        return \'kept\';',
  '  }</pre>',
  '<textarea name="snippet">  leading-space-kept',
  '\ttab-kept',
  '  </textarea>',
  '<script>function deep(){return"kept"}</script>',
  '</div>'
);

// --- 6. Modern JS in <script>: optional chaining / nullish / private / bigint -
const MODERN_JS = lines(
  '<div id="app"></div>',
  '<script>',
  'class Counter{#n=0;inc(){this.#n+=1n;return this.#n}get value(){return this.#n}}',
  'const c=new Counter();const r=c?.inc?.()??0n;',
  'const cfg=window.__CFG__?.api?.url??"/";',
  'console.log(r,cfg);',
  '</script>',
  '<script type="application/json">{"big":9007199254740991,"u":"caf\\u00e9 \\u2764"}</script>'
);

// --- 7. SCSS-ish kept literal: only valid CSS in <style> (HTML style is css) --
const CSS_MEDIA_VAR_CALC = lines(
  '<head>',
  '<style>',
  ':root{--space:8px;--cols:3}',
  '.grid{display:grid;grid-template-columns:repeat(var(--cols),1fr);gap:var(--space)}',
  '@media screen and (min-width:900px){.grid{gap:calc(var(--space) * 2)}}',
  '@supports (display:grid){.grid>.cell{min-width:0}}',
  '</style>',
  '</head>',
  '<body><div class="grid"><div class="cell">a</div><div class="cell">b</div></div></body>'
);

// --- 8. Nested structure: SVG inside button, JSON script, inline style --------
const DENSE_MIX = lines(
  '<!DOCTYPE html><html><head>',
  '<style>button{border:0;background:var(--bg,#eee)}button:hover{background:#ddd}</style>',
  '<script type="application/json" id="cfg">{"theme":"dark","langs":["en","fr","de"]}</script>',
  '</head><body>',
  '<button type="button" style="cursor:pointer" onclick="toggle()">',
  '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M1 1 L15 15" stroke="currentColor"/></svg>',
  '<span>Menu</span></button>',
  '<script>function toggle(){document.body.classList?.toggle("dark")}</script>',
  '</body></html>'
);

// --- 9. Multiple data scripts (json + importmap-like opaque) ------------------
const DATA_SCRIPTS = lines(
  '<head>',
  '<script type="importmap">{"imports":{"app":"/app.js","lib":"/lib.js"}}</script>',
  '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Person","name":"Max"}</script>',
  '</head>',
  '<body>',
  '<script type="application/json">{"nested":{"a":[{"b":1},{"b":2}]},"flag":false}</script>',
  '<script>const ready=()=>document.readyState==="complete";ready()&&init?.();</script>',
  '</body>'
);

// --- 10. Opaque-type <script> template (x-template) kept verbatim -------------
// `type="text/x-template"` is opaque to the engine: the guard compares its body
// VERBATIM (canonicalizeEmbeddedCode -> `verbatim:`). For the format to be
// ACCEPTED the body must come back byte-identical, so it is authored on a single
// line js-beautify leaves untouched. The {{ }} island therefore survives intact,
// while the surrounding HTML and the <style> are still reformatted.
const TEMPLATED_SCRIPT = lines(
  '<div>',
  '<style>.t{color:var(--c,#333)}</style>',
  '<script type="text/x-template" id="tpl"><li class="row" data-id="{{ id }}">{{ label }}</li></script>',
  '<p class="t">{{ heading }}</p>',
  '</div>'
);

// --- 11. CSS with comments + multi-value + pseudo, JS with template literal ---
const CSS_COMMENTS_JS_TEMPLATE = lines(
  '<head>',
  '<style>',
  '/* layout */',
  '.row{display:flex;flex-wrap:wrap;gap:8px 16px}',
  '.row:nth-child(2n){background:#f5f5f5}',
  'a[href^="https://"]{color:var(--link,#06c)}',
  '</style>',
  '</head>',
  '<body>',
  '<script>const name="x";const msg=`hello ${name}, n=${1+2}`;console.log(msg)</script>',
  '</body>'
);

// --- 12. Inline style with var()/calc() + boolean/data attrs + void elements --
const INLINE_STYLE_RICH = lines(
  '<form>',
  '<input type="text" name="q" value="" required style="width:calc(100% - 2 * var(--pad,4px))">',
  '<input type="checkbox" checked disabled data-group="filters">',
  '<img src="/a.png" alt="a" style="object-fit:cover" loading="lazy">',
  '<br>',
  '<button type="submit" style="background:var(--ok,#0a0);color:#fff">Send</button>',
  '</form>',
  '<script>document.forms[0]?.addEventListener("submit",e=>{e.preventDefault()})</script>'
);

// --- 13. Whole page: every dimension at once (the kitchen sink) ---------------
const KITCHEN_SINK = lines(
  '<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8">',
  '<title>Tout</title>',
  '<style>:root{--g:10px}body{margin:0;font-family:system-ui}.box{padding:var(--g)}</style>',
  '<style>@media (max-width:480px){.box{padding:calc(var(--g) / 2)}}</style>',
  '<script type="application/json" id="boot">{"locale":"fr","flags":{"beta":true}}</script>',
  '</head>',
  '<body>',
  '<nav class="box" style="display:flex;gap:8px" data-role="nav">',
  '{% for item in menu %}<a href="{{ item.url }}" onclick="go(event)">{{ item.label }}</a>{% endfor %}',
  '</nav>',
  '<main>',
  '<% if (loggedIn) { %><span class="hi">Bonjour <%= userName %></span><% } %>',
  '<svg viewBox="0 0 24 24" width="24" height="24"><path d="M2 2 L22 22" stroke="url(#lg)"/></svg>',
  '<pre>  raw  text\n    keeps   spacing</pre>',
  '<textarea>verbatim\t<b>not parsed</b></textarea>',
  '</main>',
  '<script>function go(e){e.preventDefault();const u=e.currentTarget?.href??"#";location.assign(u)}</script>',
  '<script>const cfg=JSON.parse(document.getElementById("boot").textContent);console.log(cfg?.locale)</script>',
  '</body></html>'
);

// --- 14. Empty + whitespace-only embedded blocks (edge: nothing to format) ----
const EMPTY_EMBEDS = lines(
  '<head>',
  '<style></style>',
  '<style>   </style>',
  '<script></script>',
  '<script type="application/json">{}</script>',
  '</head>',
  '<body><div style=""></div><span onclick="">x</span></body>'
);

// --- 15. CSS @keyframes/@font-face + JS arrow/destructuring + JSON array root --
const ATRULES_AND_JS = lines(
  '<head>',
  '<style>',
  '@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}',
  '@font-face{font-family:"My";src:url("/f.woff2") format("woff2")}',
  '.s{animation:spin 1s linear infinite}',
  '</style>',
  '</head>',
  '<body>',
  '<script type="application/json">[{"id":1},{"id":2},{"id":3}]</script>',
  '<script>const {a,b=2,...rest}={a:1,c:3,d:4};const f=(...xs)=>xs.reduce((p,c)=>p+c,0);console.log(a,b,rest,f(1,2,3))</script>',
  '</body>'
);

// --- 16. Mustache island inside inline style + handler + data attr ------------
const ISLANDS_IN_ATTRS = lines(
  '<ul>',
  '<li class="item" style="--row:{{i}}" data-id="{{ id }}" onclick="pick({{ id }})">{{ label }}</li>',
  '{% for row in rows %}<li data-k="{{ row.k }}">{{ row.v }}</li>{% endfor %}',
  '</ul>',
  '<style>.item{grid-row:var(--row,auto)}</style>',
  '<script>function pick(id){selected=id}</script>'
);

// --- 17. Two scripts where one is JSON-with-special-chars, one is async JS ----
const JSON_SPECIALS_AND_ASYNC = lines(
  '<body>',
  '<script type="application/json">{"path":"a\\\\b\\\\c","tab":"x\\ty","quote":"she said \\"hi\\"","arr":[true,false,null]}</script>',
  '<script>',
  'async function load(url){const r=await fetch(url);if(!r.ok)throw new Error("bad");return r.json()}',
  'load("/api")?.then?.(d=>console.log(d))',
  '</script>',
  '</body>'
);

// --- 18. Conditional comments + embedded code + SVG (legacy-IE shaped) --------
const CONDITIONAL_COMMENTS = lines(
  '<head>',
  '<!--[if lt IE 9]><script src="/html5shiv.js"></script><![endif]-->',
  '<style>.legacy{zoom:1}</style>',
  '</head>',
  '<body>',
  '<!-- a normal comment -->',
  '<svg viewBox="0 0 10 10"><rect x="0" y="0" width="10" height="10" fill="var(--c,#000)"/></svg>',
  '<script>var supports=("ontouchstart" in window);console.log(supports)</script>',
  '</body>'
);

export const polyglotFixtures: PolyglotFixture[] = [
  {
    id: 'PG-MULTI-SCRIPT-STYLE',
    desc: 'two <style> + JS <script> + module <script> + JSON data script in one document',
    input: MULTI_SCRIPT_STYLE,
    mustContain: ['--brand: #3366ff', 'var(--brand)', '"items":', 'x?.z ?? 0', '@media (max-width:600px)']
  },
  {
    id: 'PG-INLINE-HANDLERS',
    desc: 'inline onclick/onmouseover/onfocus handlers + inline style + a <script>',
    input: INLINE_HANDLERS,
    mustContain: ['onclick="doThing(event); return false;"', 'onmouseover="hover(this)"', 'e.target?.value ?? ""']
  },
  {
    id: 'PG-SVG-STYLE',
    desc: 'inline <svg> (gradient, namespaced xlink:href) + CSS var()/calc() in <style>',
    input: SVG_AND_STYLE,
    mustContain: ['viewBox="0 0 100 100"', 'xlink:href="#g1"', 'calc(2 * var(--u, 8px))', 'url(#g1)']
  },
  {
    id: 'PG-TEMPLATE-ISLANDS',
    desc: '{{ }} / {% %} / <% %> / <%= %> islands mixed with <style> and <script>',
    input: TEMPLATE_ISLANDS,
    mustContain: ['{{ user.name }}', '{% for badge in user.badges %}', '<% if (showBanner) { %>', '<%= bannerText %>']
  },
  {
    id: 'PG-VERBATIM-BLOCKS',
    desc: '<pre> + <textarea> verbatim content next to formatted <style>/<script>',
    input: VERBATIM_BLOCKS,
    mustContain: ['        return \'kept\';', '  leading-space-kept', '\ttab-kept']
  },
  {
    id: 'PG-MODERN-JS',
    desc: 'modern JS in <script>: private fields #n, bigint 1n, optional chaining, nullish; + JSON unicode',
    input: MODERN_JS,
    mustContain: ['#n', '1n', 'c?.inc?.() ?? 0n', '9007199254740991', 'caf\\u00e9']
  },
  {
    id: 'PG-CSS-MEDIA-VAR-CALC',
    desc: 'CSS with :root vars, @media, @supports, grid repeat(var()), calc()',
    input: CSS_MEDIA_VAR_CALC,
    mustContain: ['--cols: 3', '@media screen and (min-width:900px)', 'calc(var(--space) * 2)', '@supports (display:grid)']
  },
  {
    id: 'PG-DENSE-MIX',
    desc: 'full doc: <style> hover, JSON config script, SVG-in-button, inline style, JS toggle',
    input: DENSE_MIX,
    mustContain: ['"theme": "dark"', 'viewBox="0 0 16 16"', 'classList?.toggle', 'style="cursor:pointer"']
  },
  {
    id: 'PG-DATA-SCRIPTS',
    desc: 'importmap + ld+json + application/json data scripts + a JS bootstrap script',
    input: DATA_SCRIPTS,
    mustContain: ['"importmap"', '"@context":', 'application/ld+json', 'init?.()']
  },
  {
    id: 'PG-TEMPLATED-SCRIPT',
    desc: 'opaque type="text/x-template" script body kept verbatim (single line); islands survive',
    input: TEMPLATED_SCRIPT,
    mustContain: ['type="text/x-template"', 'data-id="{{ id }}"', '{{ label }}', '{{ heading }}']
  },
  {
    id: 'PG-CSS-COMMENTS-JS-TEMPLATE',
    desc: 'CSS comments + :nth-child + attribute selector; JS with a template literal',
    input: CSS_COMMENTS_JS_TEMPLATE,
    mustContain: ['/* layout */', '.row:nth-child(2n)', 'a[href^="https://"]', '`hello ${name}, n=${1+2}`']
  },
  {
    id: 'PG-INLINE-STYLE-RICH',
    desc: 'inline style with var()/calc(), boolean + data attrs, void elements, form submit handler',
    input: INLINE_STYLE_RICH,
    mustContain: ['width:calc(100% - 2 * var(--pad,4px))', 'data-group="filters"', 'forms[0]?.addEventListener']
  },
  {
    id: 'PG-KITCHEN-SINK',
    desc: 'every dimension at once: 2 <style>, JSON script, islands, inline handler+style, SVG, <pre>, <textarea>, 2 <script>',
    input: KITCHEN_SINK,
    mustContain: [
      '{% for item in menu %}',
      'href="{{ item.url }}"',
      '<% if (loggedIn) { %>',
      '<%= userName %>',
      '  raw  text',
      'verbatim\t<b>not parsed</b>',
      'currentTarget?.href ?? "#"'
    ]
  },
  {
    id: 'PG-EMPTY-EMBEDS',
    desc: 'empty / whitespace-only <style>/<script>, empty JSON {}, empty inline style + handler',
    input: EMPTY_EMBEDS,
    mustContain: ['<style></style>', 'style=""', 'onclick=""']
  },
  {
    id: 'PG-ATRULES-AND-JS',
    desc: 'CSS @keyframes/@font-face + JSON array root + JS destructuring/rest/arrow',
    input: ATRULES_AND_JS,
    mustContain: ['@keyframes spin', '@font-face', 'format("woff2")', '...rest']
  },
  {
    id: 'PG-ISLANDS-IN-ATTRS',
    desc: 'mustache islands inside inline style, data-* and onclick attribute values',
    input: ISLANDS_IN_ATTRS,
    mustContain: ['style="--row:{{i}}"', 'data-id="{{ id }}"', 'onclick="pick({{ id }})"', '{% for row in rows %}']
  },
  {
    id: 'PG-JSON-SPECIALS-ASYNC',
    desc: 'JSON with escaped backslashes/tabs/quotes + async/await JS with optional chaining',
    input: JSON_SPECIALS_AND_ASYNC,
    mustContain: ['"path": "a\\\\b\\\\c"', 'she said \\"hi\\"', 'await fetch(url)', 'load("/api")?.then?.']
  },
  {
    id: 'PG-CONDITIONAL-COMMENTS',
    desc: 'IE conditional comment + normal comment + <style> + inline SVG + <script>',
    input: CONDITIONAL_COMMENTS,
    mustContain: ['<!--[if lt IE 9]>', '<!-- a normal comment -->', 'fill="var(--c,#000)"', '"ontouchstart" in window']
  }
];
