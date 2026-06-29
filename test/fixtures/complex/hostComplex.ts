// Large, real-world COMPLEX fixtures for the end-to-end integration suite
// (test/integration/complex.test.ts). Unlike the unit-level complex fixtures,
// these are deliberately *big* — a full .tsx component, a real .scss stylesheet,
// an .html page with embedded <script>/<style>/template islands, and a deeply
// nested .json — so the assertion that "Tidy actually ran in the real host AND
// stayed safe" exercises the whole format -> guard -> edit pipeline on inputs
// that mirror what a user would actually format.
//
// Each fixture is VALID source the engine reformats. The integration test then
// proves, in a real VS Code Electron host:
//   (a) the document CHANGED (Tidy ran; not the silent no-op of the prettier bug),
//   (b) a second Format Document is a no-op (idempotence / SAFE-03),
//   (c) every `mustContain` token survives verbatim (no corruption; SAFE-01/02).
//
// These modules must stay 'vscode'-free so they can be imported by the test that
// runs inside the host without dragging extra deps into the bundle.

export interface HostComplexFixture {
  /** Stable id used in the test title. */
  id: string;
  /** Relative path (under the integration workspace) the fixture is written to. */
  relPath: string;
  /** Human-readable description. */
  desc: string;
  /** VS Code languageId the file resolves to (asserted by openFixture). */
  lang: string;
  /** Per-language defaultFormatter key VS Code resolves; same as `lang` here. */
  formatterLang: string;
  /** The messy-but-valid source. */
  input: string;
  /**
   * Tokens that MUST survive verbatim after formatting. These pin the exact
   * fragments the incumbent corrupted (generics, JSX, optional chaining, calc(),
   * template islands, deep keys) so a regression that mangles them fails loudly
   * even if the AST/tree guard somehow let it through.
   */
  mustContain: string[];
}

// --- A big, realistic .tsx component ----------------------------------------
// Hooks (useState/useEffect/useMemo/useCallback/useRef), generics on the
// component + a generic helper, nested JSX with fragments/conditional/map,
// spread props, optional chaining + nullish, a tagged template, an enum, and a
// type-only import. This is the kind of file lonefy turned into `< Foo bar = {x} />`.
const BIG_TSX = [
  'import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";',
  'import type { ReactNode } from "react";',
  '',
  'enum Status { Idle = "idle", Loading = "loading", Done = "done" }',
  '',
  'interface Row<T> { id: string; value: T; label?: string }',
  'interface TableProps<T> {',
  'rows: Row<T>[];',
  'title?: string;',
  'onPick: (id: string) => void;',
  'render?: (value: T) => ReactNode;',
  '}',
  '',
  'function clamp<N extends number>(n: N, lo: number, hi: number): number {',
  'return Math.min(hi, Math.max(lo, n));',
  '}',
  '',
  'const css = (strings: TemplateStringsArray, ...v: unknown[]) => strings.join("");',
  '',
  'export function DataTable<T>({ rows, title, onPick, render }: TableProps<T>) {',
  'const [status, setStatus] = useState<Status>(Status.Idle);',
  'const [selected, setSelected] = useState<string | null>(null);',
  'const containerRef = useRef<HTMLDivElement | null>(null);',
  '',
  'useEffect(() => {',
  'setStatus(rows.length === 0 ? Status.Idle : Status.Done);',
  '}, [rows]);',
  '',
  'const visible = useMemo(() => rows.filter((r) => r?.value != null), [rows]);',
  '',
  'const handlePick = useCallback((id: string) => {',
  'setSelected(id);',
  'onPick?.(id);',
  '}, [onPick]);',
  '',
  'const theme = css`color: ${selected ?? "inherit"}; padding: ${clamp(rows.length, 0, 8)}px;`;',
  '',
  'return (',
  '<div ref={containerRef} className="table" data-status={status} title={theme}>',
  '{title ? <h2>{title}</h2> : <></>}',
  '{visible.length === 0 ? (',
  '<p className="empty">No rows</p>',
  ') : (',
  '<table>',
  '<tbody>',
  '{visible.map((r) => (',
  '<tr key={r.id} className={r.id === selected ? "sel" : undefined} onClick={() => handlePick(r.id)}>',
  '<td>{r.label ?? r.id}</td>',
  '<td>{render ? render(r.value) : String(r.value)}</td>',
  '</tr>',
  '))}',
  '</tbody>',
  '</table>',
  ')}',
  '{status === Status.Loading && <span>{/* spinner */}…</span>}',
  '</div>',
  ');',
  '}'
].join('\n');

// --- A real .scss stylesheet -------------------------------------------------
// Variables, nesting with `&`, a @mixin + @include with args, @each loop with
// interpolation #{$x}, calc() with mixed units, a media query, and a multi-value
// comma list. js-beautify reformats this and the PostCSS-SCSS guard must accept
// the whitespace-only reflow while pinning the meaning-bearing tokens.
const BIG_SCSS = [
  '$brand: #3366ff; $radius: 6px; $gap: 12px;',
  '$sizes: (small: 8px, medium: 16px, large: 24px);',
  '@mixin card($pad, $shadow: 0 1px 2px rgba(0,0,0,.2)) {',
  'padding: $pad; box-shadow: $shadow; border-radius: $radius;',
  '}',
  '.panel {',
  'color: $brand; display: flex; gap: $gap;',
  '@include card(16px);',
  '& > .item { flex: 1 1 auto; margin: 0 calc(#{$gap} / 2); }',
  '&:hover { color: darken($brand, 10%); }',
  '.title, .subtitle, .caption { font-family: "Helvetica Neue", Arial, sans-serif; }',
  '@each $name, $val in $sizes {',
  '.pad-#{$name} { padding: $val; width: calc(100% - #{$val}); }',
  '}',
  '@media (max-width: 600px) { & { flex-direction: column; gap: calc(#{$gap} * 2); } }',
  '}'
].join('\n');

// --- An .html page with script + style islands + template islands ------------
// Full document, <style> block, <script> block (valid JS that js-beautify will
// reindent), a <pre> with significant whitespace, mustache/jinja template
// islands that must be preserved literally, data-* + boolean attrs, void
// elements, and an inline SVG.
const BIG_HTML = [
  '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">',
  '<title>Dashboard</title>',
  '<style>body{margin:0;font-family:system-ui}.card{padding:8px;color:#222}.card:hover{color:#000}</style>',
  '</head><body>',
  '<nav class="top" data-role="navigation"><a href="/home">Home</a><a href="/about">About</a></nav>',
  '<main>',
  '<section class="card" data-count="{{count}}"><h1>{{ user.name }}</h1>',
  '{% for badge in user.badges %}<span class="badge">{{ badge }}</span>{% endfor %}',
  '<img src="/logo.png" alt="logo"><hr><input type="checkbox" checked disabled></section>',
  '<pre>  line one\n    line two (indented)\n  line three</pre>',
  '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="url(#g1)"></circle></svg>',
  '</main>',
  '<script>',
  'const items=[1,2,3];function total(xs){let s=0;for(const x of xs){s+=x}return s}',
  'document.querySelector(".card")?.addEventListener("click",()=>{console.log(total(items)??0)});',
  '</script>',
  '</body></html>'
].join('\n');

// --- A deeply nested .json document ------------------------------------------
// Compact (single line) so the formatter has obvious work to do; deep nesting,
// mixed-type arrays, escapes/unicode, big numbers. The JSON guard must preserve
// every value while the formatter pretty-prints.
const BIG_JSON = JSON.stringify({
  name: '@scope/pkg',
  version: '1.2.3',
  config: {
    server: {
      host: 'localhost',
      ports: [8080, 8081, 8082],
      tls: { enabled: true, ciphers: ['TLS_AES_256', 'TLS_CHACHA20'] },
      headers: { 'x-trace': 'a\tb\nc', unicode: 'café ❤' }
    },
    features: { a: true, b: false, c: null },
    matrix: [[1, 2, [3, 4, [5, 6, { deep: 'leaf', flags: [true, false, null] }]]]],
    limits: { max: 1e21, min: 1e-9, ratio: 0.000001, big: 9007199254740991 }
  },
  scripts: { build: 'tsc -p .', test: 'mocha', 'pre:lint': 'eslint .' },
  list: [1, 'two', true, null, { k: 'v' }, [9, 8, 7]]
});

export const hostComplexFixtures: HostComplexFixture[] = [
  {
    id: 'HX-TSX-BIG-COMPONENT',
    relPath: 'complex/DataTable.tsx',
    desc: 'large generic .tsx component: hooks, generics, nested JSX, spread, optional-chaining, tagged template, enum',
    lang: 'typescriptreact',
    formatterLang: 'typescriptreact',
    input: BIG_TSX,
    mustContain: [
      'function DataTable<T>',
      'Row<T>[]',
      'useState<Status>',
      'useRef<HTMLDivElement | null>',
      'r?.value != null',
      'onPick?.(id)',
      'selected ?? "inherit"',
      'key={r.id}',
      'r.label ?? r.id',
      '<></>',
      '{/* spinner */}',
      'Status.Loading &&'
    ]
  },
  {
    id: 'HX-SCSS-BIG-SHEET',
    relPath: 'complex/panel.scss',
    desc: 'real .scss: variables, nesting/&, @mixin+@include, @each with #{} interpolation, calc(), media query, comma list',
    lang: 'scss',
    formatterLang: 'scss',
    input: BIG_SCSS,
    mustContain: [
      '@mixin card(',
      '@include card(16px)',
      'calc(#{$gap} / 2)',
      '@each $name, $val in $sizes',
      '.pad-#{$name}',
      'calc(100% - #{$val})',
      '"Helvetica Neue", Arial, sans-serif',
      '@media (max-width: 600px)',
      'darken($brand, 10%)'
    ]
  },
  {
    id: 'HX-HTML-BIG-PAGE',
    relPath: 'complex/dashboard.html',
    desc: 'full .html page: <style>+<script> islands, template islands {{ }}/{% %}, <pre>, data-*/boolean attrs, void elements, inline SVG',
    lang: 'html',
    formatterLang: 'html',
    input: BIG_HTML,
    mustContain: [
      '<!DOCTYPE html>',
      'lang="en"',
      '{{ user.name }}',
      '{% for badge in user.badges %}',
      'data-count="{{count}}"',
      'viewBox="0 0 100 100"',
      'fill="url(#g1)"',
      '?.addEventListener'
    ]
  },
  {
    id: 'HX-JSON-DEEP',
    relPath: 'complex/manifest.json',
    desc: 'deeply nested .json: nested objects/arrays, mixed-type arrays, escapes/unicode, extreme numbers',
    lang: 'json',
    formatterLang: 'json',
    input: BIG_JSON,
    mustContain: [
      '"@scope/pkg"',
      '"TLS_AES_256"',
      'café',
      '9007199254740991',
      '"pre:lint"',
      '"deep": "leaf"'
    ]
  }
];
