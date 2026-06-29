// Large POLYGLOT fixtures for the host-level integration suite
// (test/integration/polyglot.test.ts). These are deliberately BIG, single files
// that pack every embedded-language dimension into one document so the
// end-to-end assertion "Tidy actually ran in the real packaged host AND kept
// every embedded/verbatim zone intact" exercises the whole
// format -> guard -> edit pipeline on inputs that mirror real-world pages.
//
//   - polyglotHtml: a full HTML document carrying TWO <style> blocks, a JS
//     <script>, a <script type="module">, THREE data scripts
//     (application/json, importmap, application/ld+json), an opaque
//     type="text/x-template" body, template islands ({{ }} / {% %} / <% %> /
//     <%= %>), a <pre> with significant whitespace, a <textarea> with a tab,
//     boolean/data attrs, void elements, and an inline namespaced <svg>.
//   - polyglotTsx: a big .tsx component with CSS-in-JS (styled-components
//     styled.div / styled.button.attrs / createGlobalStyle), a GraphQL gql``
//     template, generics, hooks, nested JSX with fragments/conditional/map,
//     optional chaining + nullish, an enum, and a type-only import.
//
// `verbatim` holds the EXACT substrings (probed against the real
// dispatchFormat + guard before authoring) that MUST survive byte-for-byte in
// the formatted output. They pin the embedded/template-literal/<pre>/<textarea>
// zones a broken formatter would corrupt. `mustChange` need only be non-empty:
// its presence in the output proves the formatter actually ran on the wrapper
// (so the test is never vacuously green on a no-op).
//
// This module must stay 'vscode'-free so the host test can import it without
// dragging extra deps into the bundle.

export interface PolyglotHostFixture {
  /** Stable id used in the test title. */
  id: string;
  /** Relative path (under the integration workspace) the fixture is written to. */
  relPath: string;
  /** Human-readable description. */
  desc: string;
  /** VS Code languageId the file resolves to (asserted by openFixture). */
  lang: string;
  /** The messy-but-valid polyglot source. */
  input: string;
  /**
   * Substrings that MUST survive VERBATIM (byte-for-byte) after formatting.
   * These are the embedded-language / template-literal / <pre> / <textarea> /
   * template-island zones the host must never corrupt. A regression that
   * reflows or mangles any of them fails loudly here even if the tree/AST guard
   * somehow let it through.
   */
  verbatim: string[];
  /**
   * Substrings that appear ONLY after the wrapper was reformatted (e.g. the
   * engine added spaces / reindented). Their presence proves Tidy actually ran
   * on the document, so neither (a) nor the verbatim checks are vacuous.
   */
  mustChange: string[];
}

const lines = (...l: string[]): string => l.join('\n');

// --- A big polyglot HTML page ------------------------------------------------
const POLYGLOT_HTML = lines(
  '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">',
  '<title>Polyglot Dashboard</title>',
  '<style>:root{--brand:#3366ff;--gap:12px}body{margin:0;font-family:system-ui}.card{padding:var(--gap);color:var(--brand)}.card:hover{color:#000}@media (max-width:600px){.card{padding:calc(var(--gap) / 2)}}</style>',
  '<style>.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.grid>.cell{min-width:0}</style>',
  '<script type="application/json" id="boot">{"locale":"en","flags":{"beta":true,"n":null},"items":[1,2,3],"unicode":"caf\\u00e9 \\u2764"}</script>',
  '<script type="importmap">{"imports":{"app":"/app.js","lib":"/lib.js"}}</script>',
  '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Person","name":"Max"}</script>',
  '</head><body>',
  '<nav class="top" data-role="navigation"><a href="/home">Home</a><a href="/about">About</a></nav>',
  '<main>',
  '<section class="card" data-count="{{count}}"><h1>{{ user.name }}</h1>',
  '{% for badge in user.badges %}<span class="badge">{{ badge }}</span>{% endfor %}',
  '<% if (showBanner) { %><div class="banner"><%= bannerText %></div><% } %>',
  '<img src="/logo.png" alt="logo"><hr><input type="checkbox" checked disabled></section>',
  '<pre>  line one',
  '    line two (indented)',
  '  line three</pre>',
  '<textarea name="snippet">  leading-space-kept',
  '\ttab-kept',
  '  </textarea>',
  '<svg viewBox="0 0 100 100" width="48" height="48" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g1"><stop offset="0%" stop-color="#f00"/></linearGradient></defs><circle cx="50" cy="50" r="40" fill="url(#g1)"></circle><use xlink:href="#g1"></use></svg>',
  '<script type="text/x-template" id="tpl"><li class="row" data-id="{{ id }}">{{ label }}</li></script>',
  '</main>',
  '<script>',
  'const items=[1,2,3];function total(xs){let s=0;for(const x of xs){s+=x}return s}',
  'document.querySelector(".card")?.addEventListener("click",()=>{console.log(total(items)??0)});',
  'const cfg=window.__CFG__?.api?.url??"/";',
  '</script>',
  '<script type="module">import {x} from "./m.js";export const y=x?.z??0;</script>',
  '</body></html>'
);

// --- A big polyglot TSX (CSS-in-JS + GraphQL + generics + JSX) ----------------
const POLYGLOT_TSX = lines(
  'import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";',
  'import type { ReactNode } from "react";',
  'import styled, { createGlobalStyle } from "styled-components";',
  'import gql from "graphql-tag";',
  '',
  'enum Status { Idle = "idle", Loading = "loading", Done = "done" }',
  '',
  'const GlobalStyle = createGlobalStyle`',
  '  body { margin: 0;   padding:0; }',
  '`;',
  '',
  'const Box=styled.div`',
  '  color: red;',
  '  padding:   8px;',
  '   margin: 0;',
  '`;',
  '',
  'const Button = styled.button.attrs({type:"button"})`',
  '  border: none;',
  '  cursor:   pointer;',
  '`;',
  '',
  'const USER_QUERY = gql`',
  '  query GetUser($id: ID!) {',
  '      user(id: $id) {   name email }',
  '  }',
  '`;',
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
  'return (',
  '<Box ref={containerRef} className="table" data-status={status}>',
  '<GlobalStyle />',
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
  '{status === Status.Loading && <Button>{/* spinner */}…</Button>}',
  '</Box>',
  ');',
  '}'
);

export const polyglotHostFixtures: PolyglotHostFixture[] = [
  {
    id: 'PGH-HTML-KITCHEN-SINK',
    relPath: 'polyglot/dashboard.html',
    desc: 'big HTML doc: 2 <style>, JS+module <script>, json/importmap/ld+json data, x-template, islands, <pre>, <textarea>, void/boolean attrs, namespaced SVG',
    lang: 'html',
    input: POLYGLOT_HTML,
    verbatim: [
      // Embedded CSS values (re-indented around them, but the values are intact).
      '--brand: #3366ff',
      'calc(var(--gap) / 2)',
      'repeat(3, 1fr)',
      // Embedded data scripts — values preserved, importmap stays opaque-inline.
      '"unicode": "caf\\u00e9 \\u2764"',
      '<script type="importmap">{"imports":{"app":"/app.js","lib":"/lib.js"}}</script>',
      '"@context": "https://schema.org"',
      // Template islands in text + attributes — preserved literally.
      'data-count="{{count}}"',
      '{{ user.name }}',
      '{% for badge in user.badges %}',
      '<% if (showBanner) { %>',
      '<%= bannerText %>',
      // Opaque x-template body — kept byte-identical (single line).
      '<script type="text/x-template" id="tpl"><li class="row" data-id="{{ id }}">{{ label }}</li></script>',
      // <pre> body — every space/newline is significant and must be verbatim.
      '<pre>  line one\n    line two (indented)\n  line three</pre>',
      // <textarea> — the literal tab survives.
      '\ttab-kept',
      // Namespaced SVG attribute + a url() reference.
      'xlink:href="#g1"',
      'fill="url(#g1)"',
      'viewBox="0 0 100 100"',
      // Embedded JS modern operators preserved (re-spaced around, value intact).
      'total(items) ?? 0',
      'window.__CFG__?.api?.url ?? "/"',
      'x?.z ?? 0'
    ],
    // js-beautify pretty-prints the doc: indented <head> children + multi-line
    // <style>/<script> bodies that the compact input did not have.
    mustChange: ['\n  <meta charset="utf-8">', '\n      --brand: #3366ff', '\n    const items = [1, 2, 3];']
  },
  {
    id: 'PGH-TSX-CSS-IN-JS-GQL',
    relPath: 'polyglot/DataTable.tsx',
    desc: 'big TSX: styled-components (styled.div/.attrs/createGlobalStyle) + gql`` + generics + hooks + nested JSX + optional chaining/nullish + enum',
    lang: 'typescriptreact',
    input: POLYGLOT_TSX,
    verbatim: [
      // CSS-in-JS bodies are opaque template-literal text: preserved byte-for-byte,
      // INCLUDING the irregular interior spacing prettier must NOT touch.
      '`\n  body { margin: 0;   padding:0; }\n`',
      '`\n  color: red;\n  padding:   8px;\n   margin: 0;\n`',
      '`\n  border: none;\n  cursor:   pointer;\n`',
      // GraphQL template body — verbatim, including the messy indentation/spacing.
      '`\n  query GetUser($id: ID!) {\n      user(id: $id) {   name email }\n  }\n`',
      // Generics / TS type syntax not split or mangled.
      'function DataTable<T>',
      'Row<T>[]',
      'useState<Status>',
      'useRef<HTMLDivElement | null>',
      'clamp<N extends number>',
      // Optional chaining + nullish preserved.
      'r?.value != null',
      'onPick?.(id)',
      'r.label ?? r.id',
      // JSX fragment + comment-only child + custom-component tag boundaries intact.
      '<></>',
      '{/* spinner */}',
      'Status.Loading &&'
    ],
    // prettier reflows the wrapper JS/TSX: exploded named imports, enum members
    // on their own lines, and the messy single-line interface bodies expanded.
    mustChange: ['const Box = styled.div`', 'const Button = styled.button.attrs({ type: "button" })`', '\n  Idle = "idle",']
  }
];
