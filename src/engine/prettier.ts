// Prettier engine adapter.
// Handles typescript/typescriptreact/javascriptreact (real-parser path) per the
// MVP engine decision; also used for .js files containing JSX that js-beautify
// would corrupt. dprint-ts is the swappable alternative tracked for later (§13).
// MUST NOT import 'vscode' (testable under mocha + tsx).
import type { Options as PrettierOptions } from 'prettier';
// ADD-11: prettier's STANDALONE build and its EXPLICIT plugins now live in
// dist/chunk-prettier.js, loaded on demand through the memoized chunk loader
// (see src/chunks/prettierChunk.ts for why standalone + explicit plugins is the
// only shape that survives bundling). Nothing here is evaluated at activation.
// A load failure is surfaced as a typed engine error: the provider aborts and
// the file stays intact; the engine NEVER degrades to a partial printer.
//
// WHITESPACE POLICY: this adapter owns NONE of it. Both of its paths finish
// through src/engine/postProcess.ts, the same module the js-beautify family
// uses, so the final-newline rule and the EOL rule have ONE implementation for
// the whole extension. Until v0.4.1 the TS/JSX path returned prettier's output
// straight to the provider, and prettier's own endOfLine default ('lf') then
// rewrote a whole CRLF document whenever files.eol was unset or "auto": nothing
// was corrupted and the endings were never left MIXED, but a CRLF project got
// one answer for a .css and a different one for a .ts, which is the exact
// inconsistency a local copy of the policy caused in the first place (C-04).
import { loadPrettierChunk, type PrettierChunkModule } from '../chunks/loader';
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
 * Map our endOfLine contract onto prettier's, or undefined when the caller
 * resolved no concrete EOL. EVERY call site turns that undefined into 'auto'
 * (see resolveEndOfLine): prettier's OWN default is 'lf', which rewrites a whole
 * CRLF document the user never asked to convert.
 */
function mapEndOfLine(eol: ResolvedOptions['endOfLine']): 'lf' | 'crlf' | undefined {
  if (eol === 'lf' || eol === 'crlf') {
    return eol;
  }
  return undefined;
}

/**
 * The prettier `endOfLine` to use for a resolved option bag. ONE rule for BOTH
 * paths (TS/JSX and the CSS fallback): an EXPLICIT setting is honoured, and
 * "the user has not said" means KEEP WHAT THE DOCUMENT ALREADY HAS.
 *
 * Prettier's own default is 'lf'. Leaving the key unset therefore rewrote a
 * whole CRLF document to LF whenever files.eol was unset or "auto": measured at
 * 6 of 36 (files.eol x insertFinalNewline x document shape) combinations for
 * each of typescript, typescriptreact and javascriptreact, and 0 for the seven
 * js-beautify languages, which had already been aligned on the document's own
 * line endings (defect C-04). Nothing was ever corrupted, and the result was
 * never MIXED, so the guard rightly accepted it; but the same extension gave a
 * CRLF project two different answers for a .css and a .ts, which is precisely
 * the inconsistency a single shared whitespace policy exists to prevent.
 */
function resolveEndOfLine(
  options: ResolvedOptions
): 'lf' | 'crlf' | 'auto' {
  return mapEndOfLine(options.endOfLine) ?? 'auto';
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
  // printWidth is NOT applied here: it is one value chosen by layer order, see
  // resolvePrintWidth (the width used to be assigned twice, defect C-15).
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
 * A width Prettier can be handed: a positive integer, or the unbounded width.
 * Anything else (0, a negative, a fraction, a string) is not a width.
 */
function usableWidth(value: unknown): number | undefined {
  if (value === Number.POSITIVE_INFINITY) {
    return value;
  }
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

/**
 * The ONE print width for Prettier, or undefined when nobody asked for one (so
 * Prettier's own default of 80 applies). Shared by the TS/JSX path and the CSS
 * fallback.
 *
 * The layer-order decision is NOT made here. The resolver (src/config/
 * resolver.ts, unifyPrintWidth) has already collapsed `wrap_line_length` and
 * `prettier.printWidth` into `engineOptions.prettier.printWidth` by the order
 * of the layers that set them, and that value is what this reads first. Before
 * the resolver did so, this adapter assigned the shared width and then
 * overwrote it from the Prettier key, so a VS Code `tidy.prettier.printWidth`
 * beat an .editorconfig `max_line_length` and a .soukformatrc
 * `wrap_line_length` (defect C-15). The shared key is still consulted as a
 * fallback so that an option bag which never went through the resolver (this
 * adapter is called directly by tests and by the CSS fallback, where no
 * Prettier key can exist) still maps its width, the Prettier key winning when
 * both are present.
 *
 * An explicit `wrap_line_length` of 0 means "do not wrap", the same words the
 * setting has always used. Prettier has no off switch, so 0 becomes the
 * unbounded width. It used to fall through to Prettier's default of 80, i.e.
 * the exact opposite of what was asked (defect LOW-03). A width nobody set is
 * still no opinion: undefined.
 */
function resolvePrintWidth(options: ResolvedOptions): number | undefined {
  const fromPrettierKey = usableWidth(readPrettierBag(options).printWidth);
  if (fromPrettierKey !== undefined) {
    return fromPrettierKey;
  }
  const shared = options.engineOptions.wrap_line_length;
  if (typeof shared === 'number' && Number.isInteger(shared)) {
    return shared === 0 ? Number.POSITIVE_INFINITY : usableWidth(shared);
  }
  return undefined;
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
    useTabs: !options.insertSpaces,
    // ALWAYS set, 'auto' when the user resolved no EOL: see resolveEndOfLine.
    // The key used to be omitted in that case, which handed the document to
    // prettier's own 'lf' default and flattened a CRLF file (defect C-04's
    // class, on the Prettier family).
    endOfLine: resolveEndOfLine(options)
  };

  // ONE width, chosen by layer order upstream (see resolvePrintWidth).
  const printWidth = resolvePrintWidth(options);
  if (printWidth !== undefined) {
    prettierOptions.printWidth = printWidth;
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
 *  - tabWidth/useTabs/endOfLine: the layout knobs Tidy owns. endOfLine goes
 *    through the SHARED resolveEndOfLine, so it falls back to 'auto' when
 *    unresolved and a CRLF stylesheet is never rewritten to LF by the fallback
 *    (Prettier's own default is 'lf', which would). The TS/JSX path above asks
 *    the same question through the same function.
 *  - printWidth: the same single width as the TS path (resolvePrintWidth). No
 *    Prettier width key can reach a CSS document (the catalogue does not declare
 *    it for CSS, SCSS or LESS), so in practice this is wrap_line_length, with 0
 *    meaning "do not wrap".
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
    endOfLine: resolveEndOfLine(options)
  };

  const printWidth = resolvePrintWidth(options);
  if (printWidth !== undefined) {
    prettierOptions.printWidth = printWidth;
  }

  return prettierOptions;
}

/**
 * Does this text already end in a line break? Handed to the SHARED
 * post-processor as `originalEndsWithNewline`, so "no opinion"
 * (insertFinalNewline undefined) really means "no edit", in both directions.
 * Same predicate the js-beautify adapter uses, deliberately: one question, one
 * answer. Stateless (no /g flag): safe to reuse across calls.
 */
const ENDS_WITH_NEWLINE = /[\r\n]$/;

/**
 * Hand a prettier result to the SHARED whitespace policy
 * (src/engine/postProcess.ts) : the very pass the js-beautify family runs. Both
 * prettier paths go through here, so this engine carries NO whitespace policy of
 * its own, and there is no third implementation to drift (the drift of a local
 * copy is exactly what defect C-04 was).
 *
 * `applyTrimPolicy` is FALSE for the TS/JSX path and TRUE for the CSS fallback,
 * and that asymmetry is deliberate, not an oversight. Prettier reprints code, so
 * the only per-line trailing whitespace that survives it in a JS/TS file sits
 * INSIDE a template literal, where those spaces are part of the string's value.
 * Trimming them changes what the program means: verified here, `` `line one   \n
 * line two` `` comes back with the spaces gone and the guard answers
 * "AST structure changed after formatting". The format would then abort on every
 * such file : a silent no-op where Tidy works today. The CSS family has no
 * multi-line string literal of that kind, and the trim has been part of that
 * path since ADD-01, so it keeps it.
 *
 * For a RANGE (selection) request the final-newline policy is suppressed and the
 * printed text is declared NOT to end in a newline: a selection is not the end of
 * the document, and the provider puts the slice's own edge whitespace runs back
 * verbatim afterwards (src/engine/sliceEdges.ts).
 *
 * Pure: `req` and its options are never mutated; a NEW option bag is built.
 */
function applyWhitespacePolicy(
  req: FormatRequest,
  printed: string,
  applyTrimPolicy: boolean
): string {
  const effectiveOptions: ResolvedOptions = {
    ...req.options,
    ...(req.range ? { insertFinalNewline: undefined } : {}),
    ...(applyTrimPolicy ? {} : { trimTrailingWhitespace: undefined })
  };
  return postProcess(
    printed,
    effectiveOptions,
    req.range ? false : ENDS_WITH_NEWLINE.test(req.code)
  );
}

export class PrettierEngine implements Engine {
  public readonly id = 'prettier';

  public supports(lang: LangId): boolean {
    return SUPPORTED.has(lang);
  }

  /**
   * Acquire the lazily loaded prettier chunk (ADD-11), normalizing any load
   * failure into a typed engine error. Shared by both format paths so the
   * failure wording is identical wherever the printer is unavailable; the
   * provider turns it into an abort with the file left byte-identical.
   */
  private async loadChunk(): Promise<PrettierChunkModule> {
    try {
      return await loadPrettierChunk();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`prettier engine unavailable: ${message}`);
    }
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

    // Lazy, memoized chunk load (ADD-11). The chunk carries prettier's
    // standalone format plus the exact plugin modules; failure to load MUST
    // abort the format (file intact), never degrade to a partial engine.
    const chunk = await this.loadChunk();

    // Provide parser + printer plugins explicitly (standalone build):
    // 'typescript' parser -> typescript plugin; 'babel' parser -> babel plugin;
    // both require the estree printer.
    const plugins =
      parser === 'typescript'
        ? [chunk.pluginTypescript, chunk.pluginEstree]
        : [chunk.pluginBabel, chunk.pluginEstree];

    let raw: string;
    try {
      raw = await chunk.format(req.code, { ...prettierOptions, plugins });
    } catch (error: unknown) {
      // Never swallow: surface a typed error so the provider can abort with a
      // file-intact outcome and log to the OutputChannel (never the code itself).
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`prettier failed to format ${req.languageId}: ${message}`);
    }

    // SAME shared whitespace policy as the js-beautify family and as the CSS
    // fallback below: the document's own line endings are kept when the user
    // resolved no endOfLine, and the file's final-newline state is restored when
    // the user expressed no opinion. Prettier emits a trailing newline of its
    // own unconditionally, so without this pass a .ts with no final newline grew
    // one byte the user never asked for, and an explicit insertFinalNewline
    // false was ignored outright. The trim policy is deliberately NOT applied
    // here (see applyWhitespacePolicy: it would eat spaces inside a template
    // literal and the guard would then reject every such format).
    return applyWhitespacePolicy(req, raw, false);
  }

  /**
   * CSS-family path (ADD-01): only reachable via the guard-rejection fallback
   * (engine/dispatcher.ts dispatchCssFallback). The output goes through the
   * SAME shared postProcess as the js-beautify family so the fallback is a
   * drop-in for whitespace policy (trim, final newline, EOL). For a selection
   * (range) request the final-newline policy is suppressed, mirroring the
   * js-beautify range path: a selection is not the end of the document.
   *
   * Since v0.4.1 the TS/JSX path above runs the very same pass, through the very
   * same helper, so "which family printed it" no longer decides what happens to
   * a document's line endings.
   */
  private async formatCssFamily(
    req: FormatRequest,
    parser: 'css' | 'scss' | 'less'
  ): Promise<string> {
    const prettierOptions = buildCssPrettierOptions(req, parser);

    // Same lazy chunk as the TS/JSX path (ADD-11): the postcss PRINTER ships
    // with the prettier chunk, not with the guard's postcss PARSERS.
    const chunk = await this.loadChunk();

    let raw: string;
    try {
      raw = await chunk.format(req.code, {
        ...prettierOptions,
        plugins: [chunk.pluginPostcss]
      });
    } catch (error: unknown) {
      // Never swallow: surface a typed error so the provider keeps the primary
      // guard-rejected outcome (file intact, original reason unchanged).
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`prettier failed to format ${req.languageId}: ${message}`);
    }

    // The trim policy HAS applied on this path since ADD-01 and keeps applying:
    // the CSS family has no multi-line string literal whose value a per-line
    // trim could change (see applyWhitespacePolicy).
    return applyWhitespacePolicy(req, raw, true);
  }
}
