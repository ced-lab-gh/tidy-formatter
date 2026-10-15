// Lazy chunk loader (ADD-11).
//
// In the PACKAGED extension the heavy parser/printer libraries live in four
// standalone CommonJS bundles next to dist/extension.js:
//   chunk-prettier.js    prettier/standalone + babel/estree/typescript/postcss plugins
//   chunk-guard-js.js    @babel/parser + @babel/types
//   chunk-guard-css.js   postcss + postcss-scss + postcss-less
//   chunk-guard-html.js  parse5
// The esbuild plugin 'tidy-chunk-rewrite' (see esbuild.js) rewrites the
// require('./xxxChunk') specifiers below into external './chunk-xxx.js'
// runtime requires resolved next to extension.js, so none of that code is
// parsed at activation. Under mocha + tsx (and under `tsc -p ./` for the
// integration suite) no plugin runs: the same require resolves the plain
// source module, so tests exercise byte-for-byte the same parser code; only
// the loading site differs.
//
// Loading semantics (the safety story depends on these):
//   - VALIDATED then memoized: a load is only accepted once the module really
//     exposes the entry points its callers destructure AND, for the three
//     verifier chunks, once those entry points have been shown to BEHAVE like
//     parsers. An empty or truncated chunk is a LOAD FAILURE, never a cached
//     half-module that would turn every later format into a mislabeled parse
//     failure;
//   - BEHAVIOURAL CANARY (why a typeof check is not enough): the guard proves
//     equivalence by comparing two parse trees, so a chunk exporting callable
//     but DEGENERATE parsers (say `() => undefined`, or anything returning a
//     constant) passes a structural check and then makes every comparison
//     compare nothing: guard.check('html','<b>A</b>','<i>TOTALLY DIFFERENT</i>')
//     answers `equivalent: true` VACUOUSLY, and the guard silently stops being
//     a guard. Substituting a chunk requires write access to dist/, which
//     already means a compromised install, so this is defence in depth and not
//     a security boundary; but the soundness of the verifier must not rest on
//     `typeof value === 'function'`. Each verifier chunk therefore parses two
//     tiny fixed inputs once per session and must return real trees that carry
//     what they were given and DIFFER from each other. The canary can only
//     REJECT: it never produces a verdict, never feeds the guard, and no path
//     through it can turn into an "equivalent" answer;
//   - memoized: the first successful load wins; every later call returns the
//     exact same module instance;
//   - a load FAILURE is thrown to the caller as a ChunkLoadError and is NOT
//     memoized, so a transient failure can retry; callers turn the throw into an
//     abort with the file left intact (the guard is never bypassed);
//   - loads are synchronous (CommonJS require IS synchronous); the promise
//     API simply wraps the same slot for async call sites (preload,
//     PrettierEngine.format).
//
// Preloading is LANGUAGE-AWARE (see chunksForLanguages / scheduleChunkPreload):
// warming a chunk no language on screen can use would evaporate the whole point
// of the split, so a CSS-only session never evaluates the TypeScript printer.
// MUST NOT import 'vscode' (testable under mocha + tsx).
import type * as PrettierChunk from './prettierChunk';
import type * as GuardJsChunk from './guardJsChunk';
import type * as GuardCssChunk from './guardCssChunk';
import type * as GuardHtmlChunk from './guardHtmlChunk';
import type { LangId } from '../types';

export type PrettierChunkModule = typeof PrettierChunk;
export type GuardJsChunkModule = typeof GuardJsChunk;
export type GuardCssChunkModule = typeof GuardCssChunk;
export type GuardHtmlChunkModule = typeof GuardHtmlChunk;

/** Stable public chunk names; also the dist/ file basenames. */
export type ChunkName =
  | 'chunk-prettier'
  | 'chunk-guard-js'
  | 'chunk-guard-css'
  | 'chunk-guard-html';

// --- load failures ---------------------------------------------------------

/**
 * A chunk could not be loaded, or loaded with a shape its callers cannot use.
 *
 * This type exists so that a failure of the VERIFIER is never reported as a
 * statement about the USER'S FILE. Callers (guard.ts above all) rethrow it out
 * of every catch that would otherwise map an exception to "input did not parse",
 * so it surfaces as an engine/load error, with ZERO edits either way.
 */
export class ChunkLoadError extends Error {
  /**
   * Structural brand. `instanceof` is the primary test, but the loader and its
   * callers can end up in two different module instances (tsx transpiles per
   * entry point, and the packaged bundle keeps chunks external), so the brand
   * keeps the classification correct even then.
   */
  readonly isChunkLoadError = true;
  readonly chunk: ChunkName;

  constructor(chunk: ChunkName, detail: string) {
    super(`failed to load ${chunk}: ${detail}`);
    this.name = 'ChunkLoadError';
    this.chunk = chunk;
  }
}

/** True when `error` reports a chunk that could not be loaded or is unusable. */
export function isChunkLoadError(error: unknown): error is ChunkLoadError {
  if (error instanceof ChunkLoadError) {
    return true;
  }
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { isChunkLoadError?: unknown }).isChunkLoadError === true
  );
}

// --- slots -----------------------------------------------------------------

type ExportKind = 'function' | 'object';

interface ExpectedExport {
  readonly key: string;
  readonly kind: ExportKind;
}

/**
 * A behavioural check run ONCE, on a freshly loaded module, after its shape has
 * been validated. Returns a human-readable problem, or undefined when the
 * module behaves. It may only reject: it produces no value any caller consumes.
 */
type ChunkCanary = (module: unknown) => string | undefined;

interface ChunkSlot<T> {
  readonly name: ChunkName;
  /** The entry points callers destructure; validated before any memoization. */
  readonly expects: readonly ExpectedExport[];
  /**
   * Behavioural canary for the verifier chunks; undefined for a chunk whose
   * output the guard re-verifies anyway (see the prettier slot).
   */
  readonly canary?: ChunkCanary;
  /** Production loader, restored by __resetChunksForTests. */
  readonly productionLoad: () => T;
  /** Active loader; only the test seam ever swaps it. */
  load: () => T;
  /** Memoized module; undefined until the first VALID load. */
  module: T | undefined;
}

function fn(key: string): ExpectedExport {
  return { key, kind: 'function' };
}

function ns(key: string): ExpectedExport {
  return { key, kind: 'object' };
}

function createSlot<T>(
  name: ChunkName,
  expects: readonly ExpectedExport[],
  load: () => T,
  canary?: ChunkCanary
): ChunkSlot<T> {
  return { name, expects, canary, productionLoad: load, load, module: undefined };
}

// --- behavioural canaries --------------------------------------------------
//
// COST. Two parses of a ~20 character input per parser entry point, once per
// chunk per session, plus a bounded digest of the resulting trees. Measured on
// Windows 11 / Node 24 as the whole validated load with the module cache warm,
// which is the shape check plus the canary and nothing else. Over repeated
// runs (200 to 2000 rounds each): chunk-guard-js 21 to 40 us, chunk-guard-css
// 43 to 66 us (SIX parses: two per dialect), chunk-guard-html 26 to 36 us, so
// 0.09 to 0.20 ms once per session for all three. The spread is JIT warm-up and
// OS scheduling, not the canary: the same loop over the un-canaried prettier
// slot costs ~1 us, so what is being read really is this work. It happens
// inside a load that was going to happen anyway, so nothing is added to any
// later format. The loader test pins the order of magnitude.

/** Recursion/So-far-visited bounds for the digest. Inputs are tiny by design. */
const CANARY_MAX_NODES = 400;
const CANARY_MAX_DEPTH = 12;

/** The token each canary input carries and expects to find in its own tree. */
const CANARY_MARKER = 'canaryAlpha';

const CANARY_JS_A = 'canaryAlpha = 1;';
const CANARY_JS_B = 'canaryBeta = 22;';
const CANARY_CSS_A = '.canaryAlpha{color:red}';
const CANARY_CSS_B = '.canaryBeta{width:2px}';
const CANARY_HTML_DOC_A = '<!doctype html><title>canaryAlpha</title>';
const CANARY_HTML_DOC_B = '<!doctype html><title>canaryBeta</title>';
const CANARY_HTML_FRAGMENT_A = '<b id="canaryAlpha">A</b>';
const CANARY_HTML_FRAGMENT_B = '<i id="canaryBeta">B</i>';

function describeThrow(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isObjectLike(value: unknown): boolean {
  return typeof value === 'object' && value !== null;
}

/**
 * A bounded, cycle-safe structural digest of a parse tree.
 *
 * It exists only to answer two questions cheaply: does this tree carry the text
 * it was built from, and is it DIFFERENT from the tree of a different input.
 * It is deliberately not a canonical form and is never compared against
 * anything the guard computes: the guard has its own, much stricter shapes.
 * Bounds keep the cost flat even if a parser hands back something enormous, and
 * the visited set makes parent back-references (parse5, postcss) terminate.
 */
function canaryDigest(value: unknown): string {
  const parts: string[] = [];
  const seen = new WeakSet<object>();
  let budget = CANARY_MAX_NODES;

  const visit = (node: unknown, depth: number): void => {
    if (budget <= 0) {
      return;
    }
    budget -= 1;
    if (node === null) {
      parts.push('null');
      return;
    }
    const kind = typeof node;
    if (kind === 'string' || kind === 'number' || kind === 'boolean') {
      parts.push(`v:${String(node)}`);
      return;
    }
    if (kind !== 'object') {
      parts.push(`t:${kind}`);
      return;
    }
    const object = node as object;
    if (seen.has(object)) {
      parts.push('seen');
      return;
    }
    seen.add(object);
    if (depth >= CANARY_MAX_DEPTH) {
      parts.push('deep');
      return;
    }
    if (Array.isArray(object)) {
      parts.push('[');
      for (const item of object) {
        if (budget <= 0) {
          break;
        }
        visit(item, depth + 1);
      }
      parts.push(']');
      return;
    }
    parts.push('{');
    for (const key of Object.keys(object as Record<string, unknown>)) {
      if (budget <= 0) {
        break;
      }
      parts.push(`k:${key}`);
      visit((object as Record<string, unknown>)[key], depth + 1);
    }
    parts.push('}');
  };

  visit(value, 0);
  return parts.join('');
}

/**
 * The heart of the canary: two DIFFERENT inputs must produce two real trees
 * that are not the same tree, and the first must still contain the marker its
 * input carried.
 *
 * A parser collapsing every input to one value (the vacuous-guard attack) fails
 * the inequality; a parser returning a constant, undefined or a primitive fails
 * the tree test; a parser that throws away its input fails the marker test.
 */
function discriminationProblem(
  label: string,
  first: unknown,
  second: unknown
): string | undefined {
  if (!isObjectLike(first) || !isObjectLike(second)) {
    return `${label} did not return a parse tree for a trivial input`;
  }
  const digestFirst = canaryDigest(first);
  if (!digestFirst.includes(CANARY_MARKER)) {
    return `${label} returned a tree that does not carry the input it parsed`;
  }
  if (digestFirst === canaryDigest(second)) {
    return `${label} returned the same tree for two different inputs`;
  }
  return undefined;
}

/** Run one parser on the canary pair and report why it is not a parser. */
function parserProblem(
  label: string,
  parse: (source: string) => unknown,
  sourceA: string,
  sourceB: string
): string | undefined {
  let first: unknown;
  let second: unknown;
  try {
    first = parse(sourceA);
    second = parse(sourceB);
  } catch (error: unknown) {
    return `${label} threw on a trivial input (${describeThrow(error)})`;
  }
  return discriminationProblem(label, first, second);
}

/**
 * @babel/parser + @babel/types. Besides parsing, `traverseFast` must really
 * WALK the tree: a traversal that visits nothing would make every guard check
 * built on it vacuous in exactly the same way a degenerate parser would.
 */
function guardJsCanary(module: unknown): string | undefined {
  const chunk = module as {
    parse: (code: string, options?: unknown) => unknown;
    traverseFast: (node: unknown, enter: (node: unknown) => void) => void;
  };
  const options = {
    sourceType: 'unambiguous',
    errorRecovery: false
  };
  const parse = (source: string): unknown => chunk.parse(source, options);

  let first: unknown;
  let second: unknown;
  try {
    first = parse(CANARY_JS_A);
    second = parse(CANARY_JS_B);
  } catch (error: unknown) {
    return `parse threw on a trivial statement (${describeThrow(error)})`;
  }
  const problem = discriminationProblem('parse', first, second);
  if (problem !== undefined) {
    return problem;
  }

  const program = (first as { program?: unknown }).program ?? first;
  let visited = 0;
  try {
    chunk.traverseFast(program, () => {
      visited += 1;
    });
  } catch (error: unknown) {
    return `traverseFast threw on a trivial program (${describeThrow(error)})`;
  }
  if (visited < 2) {
    return `traverseFast visited ${visited} node(s) of a program that has several`;
  }
  return undefined;
}

/** postcss + postcss-scss + postcss-less: all three dialects verify files. */
function guardCssCanary(module: unknown): string | undefined {
  const chunk = module as Record<string, (css: string) => unknown>;
  for (const label of ['parseCss', 'parseScss', 'parseLess'] as const) {
    const problem = parserProblem(
      label,
      (source) => chunk[label](source),
      CANARY_CSS_A,
      CANARY_CSS_B
    );
    if (problem !== undefined) {
      return problem;
    }
  }
  return undefined;
}

/** parse5: both entry points are used by the guard (documents and fragments). */
function guardHtmlCanary(module: unknown): string | undefined {
  const chunk = module as Record<string, (html: string) => unknown>;
  return (
    parserProblem(
      'parseHtml',
      (source) => chunk.parseHtml(source),
      CANARY_HTML_DOC_A,
      CANARY_HTML_DOC_B
    ) ??
    parserProblem(
      'parseHtmlFragment',
      (source) => chunk.parseHtmlFragment(source),
      CANARY_HTML_FRAGMENT_A,
      CANARY_HTML_FRAGMENT_B
    )
  );
}

// The require calls MUST stay static './<base>' string literals: the esbuild
// plugin matches these exact specifiers (see CHUNK_SOURCE_FILTER in esbuild.js)
// and rewrites them to the external './chunk-*.js' runtime requires. A computed
// specifier would silently re-absorb the library into the host bundle.
const prettierSlot = createSlot<PrettierChunkModule>(
  'chunk-prettier',
  [
    fn('format'),
    ns('pluginBabel'),
    ns('pluginEstree'),
    ns('pluginTypescript'),
    ns('pluginPostcss')
  ],
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  () => require('./prettierChunk') as PrettierChunkModule
  // NO canary: this chunk PRINTS, it does not verify. A degenerate printer
  // produces output the guard then refuses (zero edits), so its failure mode is
  // "Tidy does nothing", never "Tidy accepts a corrupted file". Running a real
  // Prettier format at load time would also cost milliseconds, not microseconds.
);
const guardJsSlot = createSlot<GuardJsChunkModule>(
  'chunk-guard-js',
  [fn('parse'), fn('traverseFast')],
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  () => require('./guardJsChunk') as GuardJsChunkModule,
  guardJsCanary
);
const guardCssSlot = createSlot<GuardCssChunkModule>(
  'chunk-guard-css',
  [fn('parseCss'), fn('parseScss'), fn('parseLess')],
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  () => require('./guardCssChunk') as GuardCssChunkModule,
  guardCssCanary
);
const guardHtmlSlot = createSlot<GuardHtmlChunkModule>(
  'chunk-guard-html',
  [fn('parseHtml'), fn('parseHtmlFragment')],
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  () => require('./guardHtmlChunk') as GuardHtmlChunkModule,
  guardHtmlCanary
);

function slotByName(name: ChunkName): ChunkSlot<unknown> {
  switch (name) {
    case 'chunk-prettier':
      return prettierSlot as ChunkSlot<unknown>;
    case 'chunk-guard-js':
      return guardJsSlot as ChunkSlot<unknown>;
    case 'chunk-guard-css':
      return guardCssSlot as ChunkSlot<unknown>;
    case 'chunk-guard-html':
      return guardHtmlSlot as ChunkSlot<unknown>;
    default: {
      // Exhaustiveness guard: a new ChunkName must get an explicit slot rather
      // than silently resolving to undefined at runtime.
      const exhaustive: never = name;
      throw new Error(`unknown chunk '${String(exhaustive)}'`);
    }
  }
}

/**
 * Describe why a loaded module cannot be used, or undefined when it is usable.
 *
 * A `require` that resolves is NOT proof the chunk is intact: a truncated or
 * half-written dist/chunk-*.js can evaluate to `{}` or to a module missing one
 * parser. Memoizing that would poison the whole session and degrade every later
 * format into a mislabeled failure, so the shape is checked before the module is
 * ever cached or handed to a caller.
 */
function shapeProblem(
  module: unknown,
  expects: readonly ExpectedExport[]
): string | undefined {
  if (
    module === null ||
    (typeof module !== 'object' && typeof module !== 'function')
  ) {
    return `expected a module object, got ${module === null ? 'null' : typeof module}`;
  }
  const record = module as Record<string, unknown>;
  const invalid: string[] = [];
  for (const expected of expects) {
    const value = record[expected.key];
    const usable =
      expected.kind === 'function'
        ? typeof value === 'function'
        : typeof value === 'function' || (typeof value === 'object' && value !== null);
    if (!usable) {
      invalid.push(expected.key);
    }
  }
  if (invalid.length > 0) {
    return `incomplete chunk, missing or unusable export(s): ${invalid.join(', ')}`;
  }
  return undefined;
}

/**
 * Synchronous memoized load. Throws a ChunkLoadError on failure; the failure is
 * NOT memoized, so a later call can retry (a transient FS error must not wedge
 * the extension until reload).
 */
function requireSlot<T>(slot: ChunkSlot<T>): T {
  if (slot.module !== undefined) {
    return slot.module;
  }
  let loaded: T;
  try {
    loaded = slot.load();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ChunkLoadError(slot.name, message);
  }
  const problem = shapeProblem(loaded, slot.expects);
  if (problem !== undefined) {
    // Deliberately NOT memoized: a bad load must be retried, never cached.
    throw new ChunkLoadError(slot.name, problem);
  }
  const behaviour = canaryProblem(slot, loaded);
  if (behaviour !== undefined) {
    // Same rule: a chunk whose parsers do not parse is never memoized, so it is
    // never handed to the guard, and every caller aborts with ZERO edits.
    throw new ChunkLoadError(slot.name, behaviour);
  }
  slot.module = loaded;
  return loaded;
}

/**
 * Run the slot's behavioural canary, if it has one.
 *
 * A canary that itself throws is treated as a FAILED canary, never as a pass:
 * the only way out of this function without a problem is a canary that ran to
 * completion and found nothing wrong.
 */
function canaryProblem<T>(slot: ChunkSlot<T>, module: T): string | undefined {
  if (slot.canary === undefined) {
    return undefined;
  }
  try {
    return slot.canary(module);
  } catch (error: unknown) {
    return `behavioural canary threw (${describeThrow(error)})`;
  }
}

export function requirePrettierChunk(): PrettierChunkModule {
  return requireSlot(prettierSlot);
}

export function requireGuardJsChunk(): GuardJsChunkModule {
  return requireSlot(guardJsSlot);
}

export function requireGuardCssChunk(): GuardCssChunkModule {
  return requireSlot(guardCssSlot);
}

export function requireGuardHtmlChunk(): GuardHtmlChunkModule {
  return requireSlot(guardHtmlSlot);
}

/**
 * Async facade over the same memoized slot, for async call sites
 * (PrettierEngine.format, the idle preload). Same failure semantics.
 */
export function loadPrettierChunk(): Promise<PrettierChunkModule> {
  try {
    return Promise.resolve(requireSlot(prettierSlot));
  } catch (error: unknown) {
    return Promise.reject(error);
  }
}

// --- preload ---------------------------------------------------------------

export interface ChunkPreloadFailure {
  chunk: ChunkName;
  message: string;
}

export interface PreloadReport {
  loaded: ChunkName[];
  failed: ChunkPreloadFailure[];
  elapsedMs: number;
}

/** Preload order: biggest first-use win first. Also the canonical chunk list. */
export const CHUNK_PRELOAD_ORDER: readonly ChunkName[] = [
  'chunk-prettier',
  'chunk-guard-js',
  'chunk-guard-css',
  'chunk-guard-html'
];

/**
 * What a FIRST format of each language actually loads, and nothing more.
 *
 * This table is the honesty contract behind the "fast startup" claim: warming a
 * chunk that the languages on screen cannot reach would silently undo the split
 * a few seconds after activation. Derived from the real routing:
 *   - css/scss/less  : js-beautify prints (host bundle), postcss verifies;
 *   - html           : js-beautify prints, parse5 verifies. An embedded
 *                      <script>/<style> pulls the JS/CSS verifier ON DEMAND,
 *                      only for a document that actually contains one;
 *   - json/jsonc     : printer and jsonc-parser both ship in the host bundle,
 *                      so the most frequently formatted family needs NO chunk;
 *   - javascript     : js-beautify prints, babel verifies. Prettier is reached
 *                      only when the file really contains JSX, which is content
 *                      dependent and stays a first-use load;
 *   - ts/tsx/jsx     : prettier prints, babel verifies.
 * A language absent from this table (markdown, a settings editor, anything the
 * user also has open) contributes nothing.
 */
const CHUNKS_BY_LANGUAGE: Readonly<Record<LangId, readonly ChunkName[]>> = {
  css: ['chunk-guard-css'],
  scss: ['chunk-guard-css'],
  less: ['chunk-guard-css'],
  html: ['chunk-guard-html'],
  json: [],
  jsonc: [],
  javascript: ['chunk-guard-js'],
  typescript: ['chunk-prettier', 'chunk-guard-js'],
  typescriptreact: ['chunk-prettier', 'chunk-guard-js'],
  javascriptreact: ['chunk-prettier', 'chunk-guard-js'],
  // Vue SFC: parse5 splits and verifies the template, postcss verifies the
  // styles; <script> is verbatim so it needs no JS verifier.
  vue: ['chunk-guard-html', 'chunk-guard-css']
};

// A Map, not the record itself: languageIds arrive from the host as arbitrary
// strings, and a plain object lookup would answer for 'constructor' or
// '__proto__'. Built once from the exhaustive record above so adding a LangId
// without a routing decision is a compile error.
const CHUNKS_BY_LANGUAGE_LOOKUP: ReadonlyMap<string, readonly ChunkName[]> =
  new Map(Object.entries(CHUNKS_BY_LANGUAGE));

/**
 * The chunks worth warming for a set of languageIds, in preload order and with
 * no duplicates. Unknown languages are ignored; an empty or fully unknown input
 * yields an empty list, i.e. "preload nothing".
 *
 * Pure: it reads no host state and mutates none of its inputs.
 */
export function chunksForLanguages(
  languageIds: Iterable<string>
): ChunkName[] {
  const wanted = new Set<ChunkName>();
  for (const languageId of languageIds) {
    const chunks = CHUNKS_BY_LANGUAGE_LOOKUP.get(languageId);
    if (chunks === undefined) {
      continue;
    }
    for (const chunk of chunks) {
      wanted.add(chunk);
    }
  }
  return CHUNK_PRELOAD_ORDER.filter((name) => wanted.has(name));
}

function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * Preload the given chunks, one macrotask apart so the extension host event loop
 * can breathe between two multi-hundred-KB parses. NEVER throws or rejects:
 * a failing chunk is reported in the result and simply falls back to normal
 * lazy loading on first use. An empty list loads nothing and returns at once.
 */
export async function preloadChunks(
  names: readonly ChunkName[]
): Promise<PreloadReport> {
  const started = Date.now();
  const loaded: ChunkName[] = [];
  const failed: ChunkPreloadFailure[] = [];
  for (const name of names) {
    try {
      requireSlot(slotByName(name));
      loaded.push(name);
    } catch (error: unknown) {
      failed.push({
        chunk: name,
        message: error instanceof Error ? error.message : String(error)
      });
    }
    await yieldToLoop();
  }
  return { loaded, failed, elapsedMs: Date.now() - started };
}

/** Cancels a scheduled preload. Idempotent; safe after the preload has fired. */
export interface ChunkPreloadSchedule {
  dispose(): void;
}

/**
 * Schedule a ONE-SHOT, language-aware preload and return its canceller.
 *
 * ANTI-HIJACK, and the reason this lives here rather than behind a host API:
 * it is a bare `setTimeout`. It registers no listener, no watcher and no
 * subscription; `readLanguageIds` is called exactly ONCE, when the timer fires,
 * and never again. Disposing before then cancels the timer and leaves ZERO work
 * behind; disposing after it fired is a no-op. The timer cannot fire twice.
 *
 * `readLanguageIds` is injected so this module stays free of 'vscode'; the
 * caller supplies the single read of what the user currently has open. A throw
 * from it degrades to "preload nothing", never to a broken activation.
 */
export function scheduleChunkPreload(
  delayMs: number,
  readLanguageIds: () => readonly string[],
  onReport: (report: PreloadReport) => void
): ChunkPreloadSchedule {
  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    // Clear the handle FIRST: from here on the schedule has fired and dispose()
    // must be a no-op rather than cancelling an already-elapsed timer.
    timer = undefined;
    let languageIds: readonly string[];
    try {
      languageIds = readLanguageIds();
    } catch {
      languageIds = [];
    }
    void preloadChunks(chunksForLanguages(languageIds)).then(onReport);
  }, delayMs);

  return {
    dispose(): void {
      if (timer === undefined) {
        return;
      }
      clearTimeout(timer);
      timer = undefined;
    }
  };
}

// --- test-only seams --------------------------------------------------------
// Reserved for unit tests (failure paths, memoization, laziness assertions).
// They must never be referenced by production code: lazyBoundary.test.ts
// asserts that no file under src/ outside this module mentions them.

export function __setChunkLoadForTests(
  name: ChunkName,
  load: (() => unknown) | undefined
): void {
  const slot = slotByName(name);
  slot.load = load ?? slot.productionLoad;
  slot.module = undefined;
}

export function __isChunkLoadedForTests(name: ChunkName): boolean {
  return slotByName(name).module !== undefined;
}

export function __resetChunksForTests(): void {
  for (const name of CHUNK_PRELOAD_ORDER) {
    const slot = slotByName(name);
    slot.load = slot.productionLoad;
    slot.module = undefined;
  }
}
