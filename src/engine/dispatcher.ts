// Engine dispatcher: routes a languageId to the correct engine and performs
// the actual format call. js-beautify for css/scss/less/html/json/jsonc/javascript,
// prettier for typescript/typescriptreact/javascriptreact. If a .js (languageId
// 'javascript') contains JSX that js-beautify would break, this dispatcher
// switches to the prettier engine instead (SPEC §4 note).
// MUST NOT import 'vscode' (testable under mocha + tsx).
import type { ParserPlugin } from '@babel/parser';
import type { Node } from '@babel/types';
// ADD-11: the babel toolchain lives in dist/chunk-guard-js.js, the SAME chunk
// the JS-family safety guard uses, so JSX detection and verification share one
// load. Type-only imports above are erased at compile time.
import { requireGuardJsChunk } from '../chunks/loader';
import type { Engine, FormatRequest, LangId } from '../types';
import { JsBeautifyEngine } from './jsbeautify';
import { PrettierEngine } from './prettier';

// Engines are stateless adapters, so a single shared instance per engine is safe
// and avoids per-call allocation. The actual parser/library load is lazy inside
// each engine's format() call (see SPEC §5 "moteurs lazy-loadés").
const jsBeautifyEngine = new JsBeautifyEngine();
const prettierEngine = new PrettierEngine();

// SPEC §4 matrix: these languages always go through the real-parser engine
// because js-beautify provably corrupts JSX/TSX and generics.
const PRETTIER_LANGS: ReadonlySet<LangId> = new Set<LangId>([
  'typescript',
  'typescriptreact',
  'javascriptreact'
]);

// @babel/parser plugins covering modern JS that may appear in a .js file. 'jsx'
// is what lets us tell real JSX apart from comparison operators / TS generics , 
// the exact distinction that defeats js-beautify (SPEC §4, ENG-02).
const JS_PARSER_PLUGINS: readonly ParserPlugin[] = [
  'jsx',
  ['decorators', { decoratorsBeforeExport: false }],
  'classProperties',
  'classPrivateProperties',
  'classPrivateMethods'
];

// Cheap pre-filter: only worth a full parse if the source contains something that
// could be a JSX opening tag. Matches `<Identifier`, `<namespace:`, `<member.`,
// or a JSX fragment `<>`. This is intentionally permissive (false positives are
// fine : they only trigger the confirming parse below; false negatives are what
// we must avoid, and a real JSX element always begins with one of these forms).
//
// FIRST-CHARACTER CLASS (v0.4.1, M3-5): a JSXIdentifier starts with any JS
// identifier-start character, so `_` and `$` are as legal as a letter. Omitting
// them made `<_Foo/>` and `<$Bar/>` miss this gate: the confirming parse never
// ran, the file stayed on js-beautify, which printed `< _Foo bar = {`, and the
// guard then REJECTED the result ("JSX tag boundaries were altered") : a false
// reject on valid code. The trailing class is deliberately left alone: this gate
// only has to MATCH, never to consume a whole tag, so a `$` further inside a name
// (`<Foo$Bar`) is already covered by the `<Foo` prefix that precedes it.
const JSX_HINT = /<(?:[A-Za-z_$][\w.:-]*|>)/;

/**
 * Pick the engine for a language, ignoring code content.
 * For 'javascript' the default is js-beautify; JSX-aware re-routing happens in
 * dispatchFormat where the code is available.
 */
export function pickEngine(lang: LangId): Engine {
  if (PRETTIER_LANGS.has(lang)) {
    return prettierEngine;
  }
  return jsBeautifyEngine;
}

/**
 * Languages eligible for the guard-rejection fallback (ADD-01): when the
 * js-beautify candidate for one of these is REJECTED by the safety guard, the
 * provider makes ONE independent second attempt through Prettier's postcss
 * parsers, and the guard re-checks that second candidate. The PRIMARY routing
 * matrix (pickEngine/resolveEngine) is untouched.
 */
export const CSS_FALLBACK_LANGS: ReadonlySet<LangId> = new Set<LangId>([
  'css',
  'scss',
  'less'
]);

/**
 * Second-chance dispatch for the CSS family. NEVER used as primary routing.
 * Throws on any non-CSS language so a future refactor cannot silently widen the
 * fallback surface.
 */
export async function dispatchCssFallback(req: FormatRequest): Promise<string> {
  if (!CSS_FALLBACK_LANGS.has(req.languageId)) {
    throw new Error(
      `css fallback does not support languageId '${req.languageId}'`
    );
  }
  return prettierEngine.format(req);
}

/**
 * Detect whether a 'javascript' document actually contains JSX that js-beautify
 * would corrupt, in which case the prettier engine must be used.
 *
 * Two-stage strategy (SPEC §4: "heuristique + tentative"):
 *   1. A cheap regex gate skips the parse for the overwhelmingly common case of
 *      plain JS with no JSX-looking tokens.
 *   2. A real @babel/parser pass with the `jsx` plugin confirms the presence of
 *      genuine JSX nodes, distinguishing them from comparison operators (`a < b`)
 *      and TypeScript-style generics that merely look similar.
 *
 * Conservative on uncertainty: if the source cannot be parsed at all, we do NOT
 * claim JSX. The default js-beautify route still applies and the downstream
 * semantic Guard remains the ultimate safety net : re-routing is an optimization
 * to produce a *correct* result, never a correctness guarantee on its own.
 */
function containsJsx(code: string): boolean {
  // Stage 1 : cheap gate. No JSX-looking token => certainly no JSX.
  if (!JSX_HINT.test(code)) {
    return false;
  }

  // Stage 2 : confirm with a real parse. We scan for an actual JSX AST node
  // rather than trusting the regex, so `x < y > z` or `Array<Foo>` do not
  // mis-route plain JS to the prettier engine. parse() returns a File node,
  // which is itself a @babel/types Node accepted by traverseFast.
  //
  // ADD-11: the chunk load sits OUTSIDE the try/catch below ON PURPOSE. A PARSE
  // failure means "not provably JSX" (fall back to the default route; the guard
  // still protects the file), but a chunk LOAD failure must PROPAGATE so the
  // provider aborts explicitly: answering `false` there would silently re-route
  // real JSX to js-beautify, which provably corrupts it.
  const { parse, traverseFast } = requireGuardJsChunk();
  let ast: Node;
  try {
    ast = parse(code, {
      sourceType: 'unambiguous',
      errorRecovery: false,
      plugins: [...JS_PARSER_PLUGINS]
    });
  } catch {
    // Unparsable as JSX-enabled JS: do not assert JSX presence. The default
    // route handles it and the Guard will reject any corrupting output.
    return false;
  }

  let hasJsx = false;
  traverseFast(ast, (node: Node) => {
    if (node.type === 'JSXElement' || node.type === 'JSXFragment') {
      hasJsx = true;
    }
  });
  return hasJsx;
}

/**
 * Format a request end-to-end: choose the engine (with JSX re-routing for plain
 * JS) and return the engine's output. Throws on engine error.
 */
export async function dispatchFormat(req: FormatRequest): Promise<string> {
  const engine = resolveEngine(req.languageId, req.code);

  // Defensive: the resolved engine must actually support the language. This
  // guards against future routing changes silently producing wrong output.
  if (!engine.supports(req.languageId)) {
    throw new Error(
      `Engine '${engine.id}' does not support language '${req.languageId}'`
    );
  }

  // Engine errors propagate to the caller (the provider layer), which converts
  // them into a safe abort. We never swallow them here.
  return engine.format(req);
}

/**
 * Resolve the concrete engine for a language + its source code.
 * Plain 'javascript' is re-routed to the prettier engine when it actually
 * contains JSX; every other language follows the static SPEC §4 matrix.
 */
function resolveEngine(lang: LangId, code: string): Engine {
  if (lang === 'javascript' && containsJsx(code)) {
    return prettierEngine;
  }
  return pickEngine(lang);
}

/**
 * The id of the engine that WILL print this language + source, without
 * formatting anything. This dispatcher stays the single source of truth for
 * routing: the .prettierrc layer needs the answer (a Prettier config's
 * indentation keys may only govern a file Prettier really prints, and a warning
 * about a dropped key must name the engine that really ran), and duplicating
 * the JSX rule in the config module would let the two drift apart.
 *
 * Same conservatism as resolveEngine, plus one difference that matters at the
 * call site: a chunk LOAD failure is answered with the default engine here
 * rather than propagated. Config resolution must not fail on it; the format
 * itself still hits the same load through resolveEngine and aborts explicitly
 * there, with the file left intact.
 */
export function resolveEngineIdForSource(lang: LangId, code: string): string {
  try {
    return resolveEngine(lang, code).id;
  } catch {
    return pickEngine(lang).id;
  }
}
