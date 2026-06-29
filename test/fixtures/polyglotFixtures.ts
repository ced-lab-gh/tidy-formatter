// Adversarial POLYGLOT corpus for the SAFETY GUARD on multi-language HTML files
// (SPEC SAFE-02 + §3 + §5 + §12).
//
// HTML documents routinely embed *other* languages: CSS in <style>, JavaScript in
// <script>, JSON data in <script type="application/json">, verbatim text in
// <pre>/<textarea>, and event-handler JS in inline attributes (onclick, ...).
// The guard (`htmlTreeEqual`) canonicalises those embedded bodies through THEIR
// OWN language (cssShape / canonicalizeAst / canonicalizeJsonForEmbed) so that a
// pure reindent is accepted but a real value/instruction change is not.
//
// This corpus attacks exactly that seam: every pair below keeps the surrounding
// HTML structurally identical and corrupts ONLY the embedded payload — a CSS
// value, a JS instruction, a JSON key/value, verbatim <pre>/<textarea> text, or
// an inline handler/attribute. Each MUST be rejected (`equivalent === false`)
// with a non-empty reason.
//
// The danger these prove: every corrupted `output` is itself a WELL-FORMED HTML
// document (parse5 parses it without error — `htmlParses: true`), and for the
// embedded-code cases the corrupted PAYLOAD is also well-formed in its own
// language (`embeddedWellFormed: true`). A naive guard that only re-parsed the
// HTML, or only re-parsed the embedded snippet, would therefore ACCEPT the
// corruption. Only the deep, per-language tree/value diff catches it.
import type { LangId } from '../../src/types';

/** Which embedded language the corrupted payload lives in (drives the oracle). */
export type EmbeddedLang = 'css' | 'js' | 'json' | 'verbatim' | 'attr';

export interface PolyglotFixture {
  /** Stable id used in the test title. */
  id: string;
  /** What the embedded corruption does and why it must be rejected. */
  desc: string;
  /** The embedded language whose payload was corrupted. */
  embedded: EmbeddedLang;
  /** Always 'html' — the file as a whole is an HTML document. */
  lang: LangId;
  /** Clean, valid HTML input. */
  input: string;
  /** Output where ONLY the embedded payload was semantically corrupted. */
  output: string;
  /**
   * Whether the corrupted `output` is a well-formed HTML document (parse5 throws
   * nothing). Always expected `true` here: the whole point is that a re-parse-only
   * guard would accept it.
   */
  htmlParses: boolean;
  /**
   * For embedded-code cases (css/js/json), whether the corrupted PAYLOAD by itself
   * is well-formed in its own language. `true` means a guard that only checked the
   * embedded snippet's parseability would ALSO accept the corruption — so the deep
   * value diff is what actually saves the file. `undefined` for verbatim/attr
   * cases (no separable embedded-language body to parse independently).
   */
  embeddedWellFormed?: boolean;
  /** The corrupted payload body, isolated, for the independent embedded oracle. */
  corruptedPayload?: string;
}

export const polyglotFixtures: PolyglotFixture[] = [
  // ======================================================================
  // (a) VALUE changed inside an embedded <style>
  // ======================================================================
  {
    id: 'POLY-STYLE-COLOR-RED-TO-BLUE',
    desc: '<style> color:red -> color:blue (the canonical embedded-value change)',
    embedded: 'css',
    lang: 'html',
    input: '<html><head><style>.btn{color:red}</style></head><body></body></html>',
    output: '<html><head><style>.btn{color:blue}</style></head><body></body></html>',
    htmlParses: true,
    embeddedWellFormed: true,
    corruptedPayload: '.btn{color:blue}'
  },
  {
    id: 'POLY-STYLE-DISPLAY-NONE-TO-BLOCK',
    desc: '<style> in a full doc: display:none -> display:block (visibility flips)',
    embedded: 'css',
    lang: 'html',
    input:
      '<!DOCTYPE html><html><head><style>\nbody{margin:0}\n.hidden{display:none}\n</style></head><body><p>hi</p></body></html>',
    output:
      '<!DOCTYPE html><html><head><style>\nbody{margin:0}\n.hidden{display:block}\n</style></head><body><p>hi</p></body></html>',
    htmlParses: true,
    embeddedWellFormed: true,
    corruptedPayload: 'body{margin:0}.hidden{display:block}'
  },
  {
    id: 'POLY-STYLE-UNIT-MAGNITUDE',
    desc: '<style> height:20px -> height:200px (layout magnitude changed)',
    embedded: 'css',
    lang: 'html',
    input: '<head><style>.box{width:10px;height:20px}</style></head>',
    output: '<head><style>.box{width:10px;height:200px}</style></head>',
    htmlParses: true,
    embeddedWellFormed: true,
    corruptedPayload: '.box{width:10px;height:200px}'
  },
  {
    id: 'POLY-STYLE-COMBINATOR-CHANGED',
    desc: '<style> descendant ".a .b" -> child ".a>.b" (different selector match)',
    embedded: 'css',
    lang: 'html',
    input: '<head><style>.a .b{color:red}</style></head>',
    output: '<head><style>.a>.b{color:red}</style></head>',
    htmlParses: true,
    embeddedWellFormed: true,
    corruptedPayload: '.a>.b{color:red}'
  },
  {
    id: 'POLY-STYLE-IMPORTANT-DROPPED',
    desc: '<style> "!important" silently dropped (cascade priority lost)',
    embedded: 'css',
    lang: 'html',
    input: '<head><style>p{color:red!important}</style></head>',
    output: '<head><style>p{color:red}</style></head>',
    htmlParses: true,
    embeddedWellFormed: true,
    corruptedPayload: 'p{color:red}'
  },

  // ======================================================================
  // (b) INSTRUCTION changed inside an embedded <script>
  // ======================================================================
  {
    id: 'POLY-SCRIPT-VAR-1-TO-2',
    desc: '<script> var a=1 -> var a=2 (the canonical embedded-instruction change)',
    embedded: 'js',
    lang: 'html',
    input: '<body><script>var a=1;</script></body>',
    output: '<body><script>var a=2;</script></body>',
    htmlParses: true,
    embeddedWellFormed: true,
    corruptedPayload: 'var a=2;'
  },
  {
    id: 'POLY-SCRIPT-LINE-DELETED',
    desc: '<script> a whole statement deleted (bar() lost between foo() and baz())',
    embedded: 'js',
    lang: 'html',
    input: '<body><script>\nfoo();\nbar();\nbaz();\n</script></body>',
    output: '<body><script>\nfoo();\nbaz();\n</script></body>',
    htmlParses: true,
    embeddedWellFormed: true,
    corruptedPayload: 'foo();\nbaz();'
  },
  {
    id: 'POLY-SCRIPT-OPERATOR-SWAP',
    desc: '<script> total / count -> total - count (different computed value)',
    embedded: 'js',
    lang: 'html',
    input: '<body><script>const r = total / count;</script></body>',
    output: '<body><script>const r = total - count;</script></body>',
    htmlParses: true,
    embeddedWellFormed: true,
    corruptedPayload: 'const r = total - count;'
  },
  {
    id: 'POLY-SCRIPT-STRICT-EQ-LOOSENED',
    desc: '<script> === loosened to == (coercion semantics changed)',
    embedded: 'js',
    lang: 'html',
    input: '<body><script>if (a === b) run();</script></body>',
    output: '<body><script>if (a == b) run();</script></body>',
    htmlParses: true,
    embeddedWellFormed: true,
    corruptedPayload: 'if (a == b) run();'
  },
  {
    id: 'POLY-SCRIPT-NEGATION-DROPPED',
    desc: '<script> "if (!ok)" -> "if (ok)" (branch condition inverted)',
    embedded: 'js',
    lang: 'html',
    input: '<body><script>if (!ok) abort();</script></body>',
    output: '<body><script>if (ok) abort();</script></body>',
    htmlParses: true,
    embeddedWellFormed: true,
    corruptedPayload: 'if (ok) abort();'
  },
  {
    id: 'POLY-SCRIPT-STRING-ENDPOINT-CHANGED',
    desc: '<script> fetch("/api/safe") -> fetch("/api/evil") (request retargeted)',
    embedded: 'js',
    lang: 'html',
    input: '<body><script>fetch("/api/safe");</script></body>',
    output: '<body><script>fetch("/api/evil");</script></body>',
    htmlParses: true,
    embeddedWellFormed: true,
    corruptedPayload: 'fetch("/api/evil");'
  },

  // ======================================================================
  // (c) VALUE/KEY changed inside <script type="application/json">
  // ======================================================================
  {
    id: 'POLY-JSON-VALUE-MAGNITUDE',
    desc: '<script type=application/json> price 10 -> 100 (data value changed)',
    embedded: 'json',
    lang: 'html',
    input: '<body><script type="application/json">{"price":10}</script></body>',
    output: '<body><script type="application/json">{"price":100}</script></body>',
    htmlParses: true,
    embeddedWellFormed: true,
    corruptedPayload: '{"price":100}'
  },
  {
    id: 'POLY-JSON-KEY-RENAMED',
    desc: '<script type=application/json> key "isAdmin" -> "admin" (field renamed)',
    embedded: 'json',
    lang: 'html',
    input: '<body><script type="application/json">{"isAdmin":true}</script></body>',
    output: '<body><script type="application/json">{"admin":true}</script></body>',
    htmlParses: true,
    embeddedWellFormed: true,
    corruptedPayload: '{"admin":true}'
  },
  {
    id: 'POLY-JSON-BOOL-FLIPPED',
    desc: '<script type=application/json> enabled:false -> true (flag flipped)',
    embedded: 'json',
    lang: 'html',
    input: '<body><script type="application/json" id="cfg">{"enabled":false}</script></body>',
    output: '<body><script type="application/json" id="cfg">{"enabled":true}</script></body>',
    htmlParses: true,
    embeddedWellFormed: true,
    corruptedPayload: '{"enabled":true}'
  },
  {
    id: 'POLY-JSON-ARRAY-ELEM-DROPPED',
    desc: '<script type=application/ld+json> items [1,2,3] -> [1,3] (element lost)',
    embedded: 'json',
    lang: 'html',
    input: '<body><script type="application/ld+json">{"items":[1,2,3]}</script></body>',
    output: '<body><script type="application/ld+json">{"items":[1,3]}</script></body>',
    htmlParses: true,
    embeddedWellFormed: true,
    corruptedPayload: '{"items":[1,3]}'
  },
  {
    id: 'POLY-JSON-NULL-TO-VALUE',
    desc: '<script type=application/json> token:null -> "abc" (null replaced)',
    embedded: 'json',
    lang: 'html',
    input: '<body><script type="application/json">{"token":null}</script></body>',
    output: '<body><script type="application/json">{"token":"abc"}</script></body>',
    htmlParses: true,
    embeddedWellFormed: true,
    corruptedPayload: '{"token":"abc"}'
  },

  // ======================================================================
  // (d) TEXT altered in verbatim <pre> / <textarea>
  // ======================================================================
  {
    id: 'POLY-PRE-TEXT-CHANGED',
    desc: '<pre> "reset --soft" -> "reset --hard" (a destructive command swap)',
    embedded: 'verbatim',
    lang: 'html',
    input: '<pre>git reset --soft HEAD~1</pre>',
    output: '<pre>git reset --hard HEAD~1</pre>',
    htmlParses: true
  },
  {
    id: 'POLY-PRE-WHITESPACE-COLLAPSED',
    desc: '<pre> "a    b" -> "a b" (significant verbatim whitespace collapsed)',
    embedded: 'verbatim',
    lang: 'html',
    input: '<pre>a    b</pre>',
    output: '<pre>a b</pre>',
    htmlParses: true
  },
  {
    id: 'POLY-TEXTAREA-TEXT-CHANGED',
    desc: '<textarea> default value text changed (user-visible content altered)',
    embedded: 'verbatim',
    lang: 'html',
    input: '<textarea>Default note</textarea>',
    output: '<textarea>Changed note</textarea>',
    htmlParses: true
  },
  {
    id: 'POLY-TEXTAREA-LEADING-WS-DROPPED',
    desc: '<textarea> leading spaces dropped (verbatim indentation is meaningful)',
    embedded: 'verbatim',
    lang: 'html',
    input: '<textarea>  indented value</textarea>',
    output: '<textarea>indented value</textarea>',
    htmlParses: true
  },

  // ======================================================================
  // (e) INLINE attribute / event handler modified
  // ======================================================================
  {
    id: 'POLY-ONCLICK-HANDLER-CHANGED',
    desc: 'inline onclick="save()" -> onclick="del()" (handler retargeted)',
    embedded: 'attr',
    lang: 'html',
    input: '<button onclick="save()">Go</button>',
    output: '<button onclick="del()">Go</button>',
    htmlParses: true
  },
  {
    id: 'POLY-ONCLICK-ARG-CHANGED',
    desc: 'inline onclick="transfer(100)" -> "transfer(1000)" (handler arg changed)',
    embedded: 'attr',
    lang: 'html',
    input: '<button onclick="transfer(100)">Pay</button>',
    output: '<button onclick="transfer(1000)">Pay</button>',
    htmlParses: true
  },
  {
    id: 'POLY-HREF-RETARGETED',
    desc: 'href="https://safe.example/login" -> "https://evil.example/login"',
    embedded: 'attr',
    lang: 'html',
    input: '<a href="https://safe.example/login">Login</a>',
    output: '<a href="https://evil.example/login">Login</a>',
    htmlParses: true
  },
  {
    id: 'POLY-ONERROR-INJECTED',
    desc: 'a new onerror="steal()" handler injected onto an <img> (attr added)',
    embedded: 'attr',
    lang: 'html',
    input: '<img src="x.png" alt="x">',
    output: '<img src="x.png" alt="x" onerror="steal()">',
    htmlParses: true
  }
];
