// Prettier engine adapter.
// Handles typescript/typescriptreact/javascriptreact (real-parser path) per the
// MVP engine decision; also used for .js files containing JSX that js-beautify
// would corrupt. dprint-ts is the swappable alternative tracked for later (§13).
// MUST NOT import 'vscode' (testable under mocha + tsx).
import type { Options as PrettierOptions } from 'prettier';
// Use prettier's STANDALONE build + EXPLICIT plugins so esbuild can bundle the
// extension into a single file. The full 'prettier' entry lazy-loads its parser
// plugins via runtime dynamic import; once bundled, those imports fail to
// resolve, the parser silently doesn't load, and the engine no-ops on every
// TS/JSX file (caught in a real VS Code host). Standalone takes the plugins
// explicitly, so static imports bundle cleanly and the parser is always present.
import { format as prettierFormat } from 'prettier/standalone';
import * as prettierBabel from 'prettier/plugins/babel';
import * as prettierEstree from 'prettier/plugins/estree';
import * as prettierTypescript from 'prettier/plugins/typescript';
// CSS family fallback parsers (ADD-01). Same standalone/static-import pattern as
// the babel/typescript plugins above so esbuild bundles them cleanly.
import * as prettierPostcss from 'prettier/plugins/postcss';
import type { Engine, FormatRequest, LangId, ResolvedOptions } from '../types';
import { postProcess } from './postProcess';

const SUPPORTED: ReadonlySet<LangId> = new Set<LangId>([
  'typescript',
  'typescriptreact',
  'javascriptreact',
  // js with JSX is dispatched here as well (see dispatcher JSX re-routing)
  'javascript',
  // CSS family: reachable ONLY through the guard-rejection fallback
  // (dispatchCssFallback); primary routing still goes to js-beautify.
  'css',
  'scss',
  'less'
]);

// Prettier's built-in parser name per languageId.
// - 'typescript' parser handles both .ts and .tsx (it accepts JSX) : keeps the
//   guard's reference parser (typescript) and the engine aligned (§4).
// - 'babel' parser is used for JSX/JS so the .js JSX-fallback and .jsx share one path.
const PARSER_BY_LANG: Readonly<Record<string, 'typescript' | 'babel'>> = {
  typescript: 'typescript',
  typescriptreact: 'typescript',
  javascriptreact: 'babel',
  javascript: 'babel'
};

/**
 * Prettier postcss parser per CSS-family languageId (ADD-01 fallback path).
 * Kept separate from PARSER_BY_LANG so the two routing tables can never be
 * confused: the CSS family is NEVER primary routing for this engine.
 */
const CSS_PARSER_BY_LANG: Readonly<Record<string, 'css' | 'scss' | 'less'>> = {
  css: 'css',
  scss: 'scss',
  less: 'less'
};

/**
 * Map our endOfLine contract onto prettier's. We never pass 'auto' here because
 * the caller already resolved a concrete EOL (or left it undefined, in which
 * case prettier's default 'lf' applies).
 */
function mapEndOfLine(eol: ResolvedOptions['endOfLine']): 'lf' | 'crlf' | undefined {
  if (eol === 'lf' || eol === 'crlf') {
    return eol;
  }
  return undefined;
}

/**
 * Stylistic Prettier options Tidy exposes (Axe 3). EVERY key here is
 * AST-INVARIANT: toggling it changes Prettier's printed output (quotes,
 * semicolons, trailing commas, parens, line width) but yields the SAME babel AST
 * modulo whitespace/style, so the equivalence guard still accepts the result.
 * Each is validated for type before being applied so a malformed value never
 * reaches Prettier. Layout-affecting options Tidy already owns (tabWidth /
 * useTabs / endOfLine / range) are handled separately above.
 */
const PRETTIER_BOOLEAN_KEYS = [
  'semi',
  'singleQuote',
  'jsxSingleQuote',
  'bracketSpacing',
  'bracketSameLine'
] as const;

// NOTE: `quoteProps` is deliberately absent : it changes an object key's AST node
// type (Identifier ⇔ StringLiteral), which the equivalence guard rejects, so it
// is not AST-invariant and must not be exposed (see optionCatalog.ts). The
// allow-list design below means a stray `quoteProps` in the bag is silently
// dropped (it matches no boolean key and no string enum), and
// `DENIED_AST_CHANGING_KEYS` documents that exclusion so it can never be relaxed
// by accident. The engine/prettier.test.ts "quoteProps is deliberately NOT
// consumed" cases PROVE both halves: the engine ignores it, and the guard would
// reject the key-quoting it performs.
const PRETTIER_STRING_ENUMS: Readonly<Record<string, readonly string[]>> = {
  trailingComma: ['none', 'es5', 'all'],
  arrowParens: ['always', 'avoid']
};

// Explicit denylist of Prettier options that LOOK stylistic but mutate the babel
// AST (so the equivalence guard would reject their output, turning Tidy into a
// silent no-op). They are never read by `applyStylisticOptions`; this set exists
// purely as a guarded boundary so a value supplied for one of these keys is
// provably dropped (asserted by the engine test) rather than accidentally wired
// up later. `quoteProps` flips Identifier ⇔ StringLiteral on object keys.
const DENIED_AST_CHANGING_KEYS: ReadonlySet<string> = new Set<string>(['quoteProps']);

/**
 * Read the nested `engineOptions.prettier` bag, when present, as a record.
 */
function readPrettierBag(options: ResolvedOptions): Record<string, unknown> {
  const bag = options.engineOptions.prettier;
  return bag !== null && typeof bag === 'object' ? (bag as Record<string, unknown>) : {};
}

/**
 * Apply the validated stylistic Prettier options from engineOptions.prettier onto
 * the prettier option object. Invalid values are dropped (never propagated).
 */
function applyStylisticOptions(target: PrettierOptions, bag: Record<string, unknown>): void {
  const printWidth = bag.printWidth;
  if (typeof printWidth === 'number' && Number.isInteger(printWidth) && printWidth > 0) {
    target.printWidth = printWidth;
  }
  for (const key of PRETTIER_BOOLEAN_KEYS) {
    if (DENIED_AST_CHANGING_KEYS.has(key)) {
      continue;
    }
    const value = bag[key];
    if (typeof value === 'boolean') {
      (target as Record<string, unknown>)[key] = value;
    }
  }
  for (const [key, allowed] of Object.entries(PRETTIER_STRING_ENUMS)) {
    if (DENIED_AST_CHANGING_KEYS.has(key)) {
      continue;
    }
    const value = bag[key];
    if (typeof value === 'string' && allowed.includes(value)) {
      (target as Record<string, unknown>)[key] = value;
    }
  }
}

/**
 * Build prettier options from our ResolvedOptions + the request's parser/range.
 * Whitespace/layout knobs Tidy owns (tabWidth/useTabs/endOfLine/range) plus the
 * AST-invariant stylistic options from engineOptions.prettier are mapped; any
 * stylistic key the user did not set is left to prettier's own default so the
 * guard's "semantic-equivalence-modulo-whitespace" contract still holds.
 */
function buildPrettierOptions(
  req: FormatRequest,
  parser: 'typescript' | 'babel'
): PrettierOptions {
  const { options, range } = req;

  const prettierOptions: PrettierOptions = {
    parser,
    tabWidth: options.tabSize,
    useTabs: !options.insertSpaces
  };

  const endOfLine = mapEndOfLine(options.endOfLine);
  if (endOfLine) {
    prettierOptions.endOfLine = endOfLine;
  }

  // A shared wrap_line_length (js-beautify vocabulary) maps to prettier printWidth
  // only when no explicit prettier.printWidth was set, so the cross-engine "core"
  // option still influences TS/JSX width.
  const sharedWrap = options.engineOptions.wrap_line_length;
  if (typeof sharedWrap === 'number' && Number.isInteger(sharedWrap) && sharedWrap > 0) {
    prettierOptions.printWidth = sharedWrap;
  }

  applyStylisticOptions(prettierOptions, readPrettierBag(options));

  if (range) {
    prettierOptions.rangeStart = range.startOffset;
    prettierOptions.rangeEnd = range.endOffset;
  }

  return prettierOptions;
}

/**
 * Prettier options for the CSS-family fallback (ADD-01). STYLISTIC ONLY, and
 * deliberately much narrower than the TS/JSX path:
 *  - tabWidth/useTabs/endOfLine: the layout knobs Tidy owns. endOfLine falls
 *    back to 'auto' when unresolved so a CRLF stylesheet is never rewritten to
 *    LF by the fallback (Prettier's own default is 'lf', which would).
 *  - printWidth: shared wrap_line_length first, then an explicit
 *    engineOptions.prettier.printWidth (same precedence as the TS path).
 *  - NOTHING else from the prettier bag. singleQuote would rewrite quoted CSS
 *    strings ("x" -> 'x'), which the guard compares VERBATIM, so every fallback
 *    attempt would be rejected and the whole feature would silently never apply.
 *  - rangeStart/rangeEnd are NEVER set: the verified behaviour of the postcss
 *    parser is to return the input UNCHANGED when a range is passed, which would
 *    no-op the fallback. The provider only ever sends whole-snippet ranges
 *    ({0, input.length}), so formatting req.code entirely is exact.
 */
function buildCssPrettierOptions(
  req: FormatRequest,
  parser: 'css' | 'scss' | 'less'
): PrettierOptions {
  const { options } = req;

  const prettierOptions: PrettierOptions = {
    parser,
    tabWidth: options.tabSize,
    useTabs: !options.insertSpaces,
    endOfLine: mapEndOfLine(options.endOfLine) ?? 'auto'
  };

  const sharedWrap = options.engineOptions.wrap_line_length;
  if (
    typeof sharedWrap === 'number' &&
    Number.isInteger(sharedWrap) &&
    sharedWrap > 0
  ) {
    prettierOptions.printWidth = sharedWrap;
  }

  const printWidth = readPrettierBag(options).printWidth;
  if (
    typeof printWidth === 'number' &&
    Number.isInteger(printWidth) &&
    printWidth > 0
  ) {
    prettierOptions.printWidth = printWidth;
  }

  return prettierOptions;
}

export class PrettierEngine implements Engine {
  public readonly id = 'prettier';

  public supports(lang: LangId): boolean {
    return SUPPORTED.has(lang);
  }

  public async format(req: FormatRequest): Promise<string> {
    const cssParser = CSS_PARSER_BY_LANG[req.languageId];
    if (cssParser) {
      return this.formatCssFamily(req, cssParser);
    }

    const parser = PARSER_BY_LANG[req.languageId];
    if (!parser) {
      // Defensive: the dispatcher should never route an unsupported language
      // here, but fail loudly rather than silently mis-parse.
      throw new Error(
        `PrettierEngine does not support languageId '${req.languageId}'`
      );
    }

    const prettierOptions = buildPrettierOptions(req, parser);

    // Provide parser + printer plugins explicitly (standalone build):
    // 'typescript' parser -> typescript plugin; 'babel' parser -> babel plugin;
    // both require the estree printer.
    const plugins =
      parser === 'typescript'
        ? [prettierTypescript, prettierEstree]
        : [prettierBabel, prettierEstree];

    try {
      return await prettierFormat(req.code, { ...prettierOptions, plugins });
    } catch (error: unknown) {
      // Never swallow: surface a typed error so the provider can abort with a
      // file-intact outcome and log to the OutputChannel (never the code itself).
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`prettier failed to format ${req.languageId}: ${message}`);
    }
  }

  /**
   * CSS-family path (ADD-01): only reachable via the guard-rejection fallback
   * (engine/dispatcher.ts dispatchCssFallback). The output goes through the
   * SAME shared postProcess as the js-beautify family so the fallback is a
   * drop-in for whitespace policy (trim, final newline, EOL). For a selection
   * (range) request the final-newline policy is suppressed, mirroring the
   * js-beautify range path: a selection is not the end of the document.
   */
  private async formatCssFamily(
    req: FormatRequest,
    parser: 'css' | 'scss' | 'less'
  ): Promise<string> {
    const prettierOptions = buildCssPrettierOptions(req, parser);

    let raw: string;
    try {
      raw = await prettierFormat(req.code, {
        ...prettierOptions,
        plugins: [prettierPostcss]
      });
    } catch (error: unknown) {
      // Never swallow: surface a typed error so the provider keeps the primary
      // guard-rejected outcome (file intact, original reason unchanged).
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`prettier failed to format ${req.languageId}: ${message}`);
    }

    const effectiveOptions: ResolvedOptions = req.range
      ? { ...req.options, insertFinalNewline: undefined }
      : req.options;
    return postProcess(
      raw,
      effectiveOptions,
      req.range ? false : /\r?\n$/.test(req.code)
    );
  }
}
