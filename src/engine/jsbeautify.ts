// js-beautify engine adapter.
// Handles css/scss/less/html/json/jsonc/javascript per the MVP engine decision.
//
// Responsibilities:
//   - Map ResolvedOptions (tabSize/insertSpaces -> indent_size/indent_char/
//     indent_with_tabs) plus engineOptions (brace_style, wrap_line_length,
//     wrap_attributes, space_after_anon_function, ...) onto js-beautify's
//     css()/html()/js() option objects.
//   - Drive the correct js-beautify entry point per language family.
//   - Apply endOfLine / insertFinalNewline / trimTrailingWhitespace through the
//     SHARED post-processing pass (src/engine/postProcess.ts), which every
//     engine uses: this adapter's own copy of that policy drifted and wrote a
//     bare LF into CRLF documents (defect C-04).
//   - Honour `range`: format the sub-text only and splice it back in, leaving
//     the slice's own leading and trailing whitespace runs VERBATIM (defects
//     G3-4 and M3-3: a trimmed edge joins the slice to the bytes still sitting
//     beside it in the buffer, which the guard cannot see).
//
// PURE: this module MUST NOT import 'vscode' so it stays testable under
// mocha + tsx outside the Electron host. All inputs arrive via FormatRequest.
import { css as cssBeautify, html as htmlBeautify, js as jsBeautify } from 'js-beautify';
import type { CSSBeautifyOptions, HTMLBeautifyOptions, JSBeautifyOptions } from 'js-beautify';
import type { Engine, FormatRequest, LangId, ResolvedOptions } from '../types';
import { htmlPreformattedTags } from '../safety/htmlPreformatted';
import { sanitizeTagList } from '../config/tagList';
import { formatJson } from './jsonFormatter';
import { postProcess } from './postProcess';
import { splitSliceEdges } from './sliceEdges';

const SUPPORTED: ReadonlySet<LangId> = new Set<LangId>([
  'css',
  'scss',
  'less',
  'html',
  'json',
  'jsonc',
  'javascript'
]);

/**
 * Format families dispatched from a languageId. `json` is its OWN family (handled
 * by the fast jsonc-parser path, not js-beautify) so that a 5 MB JSON document
 * formats in well under the SPEC §9 budget while still preserving comments and
 * trailing commas. css/html/js continue through js-beautify.
 */
type Family = 'css' | 'html' | 'js' | 'json';

const FAMILY_BY_LANG: Readonly<Record<string, Family>> = {
  css: 'css',
  scss: 'css',
  less: 'css',
  html: 'html',
  // JSON / JSONC are pretty-printed by the dedicated fast formatter
  // (src/engine/jsonFormatter.ts) : comment-preserving and ~13x faster than
  // js-beautify on large documents (SPEC QA-03 / §9).
  json: 'json',
  jsonc: 'json',
  javascript: 'js'
};

/**
 * Read a value from engineOptions only when it has the expected primitive type.
 * Returns undefined otherwise so a malformed layer never overrides a sane
 * js-beautify default (fail-soft: never trust external option blobs blindly).
 */
function readNumber(options: Record<string, unknown>, key: string): number | undefined {
  const value = options[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readBoolean(options: Record<string, unknown>, key: string): boolean | undefined {
  const value = options[key];
  return typeof value === 'boolean' ? value : undefined;
}

function readString(options: Record<string, unknown>, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Indentation mapping shared by every js-beautify family.
 * insertSpaces=false => tabs (indent_with_tabs); js-beautify ignores
 * indent_size when indenting with tabs, so indent_char is set accordingly.
 */
interface IndentMapping {
  indent_size: number;
  indent_char: string;
  indent_with_tabs: boolean;
}

function mapIndent(resolved: ResolvedOptions): IndentMapping {
  const useTabs = resolved.insertSpaces === false;
  // tabSize can arrive as 0/NaN from a malformed layer; clamp to a safe minimum.
  const tabSize =
    Number.isFinite(resolved.tabSize) && resolved.tabSize > 0 ? Math.floor(resolved.tabSize) : 4;
  return {
    indent_size: useTabs ? 1 : tabSize,
    indent_char: useTabs ? '\t' : ' ',
    indent_with_tabs: useTabs
  };
}

/**
 * Core options common to all js-beautify families (indent + line wrapping +
 * final newline). end_with_newline is driven here when insertFinalNewline is
 * explicitly set; otherwise it is left to the post-processing pass for full,
 * deterministic control over the trailing newline.
 */
function mapCoreOptions(resolved: ResolvedOptions): JSBeautifyOptions {
  const engine = resolved.engineOptions;
  const core: JSBeautifyOptions = { ...mapIndent(resolved) };

  const wrap = readNumber(engine, 'wrap_line_length');
  if (wrap !== undefined) {
    core.wrap_line_length = wrap;
  }

  const preserveNewlines = readBoolean(engine, 'preserve_newlines');
  if (preserveNewlines !== undefined) {
    core.preserve_newlines = preserveNewlines;
  }

  const maxPreserveNewlines = readNumber(engine, 'max_preserve_newlines');
  if (maxPreserveNewlines !== undefined) {
    core.max_preserve_newlines = maxPreserveNewlines;
  }

  const indentEmptyLines = readBoolean(engine, 'indent_empty_lines');
  if (indentEmptyLines !== undefined) {
    core.indent_empty_lines = indentEmptyLines;
  }

  return core;
}

const JS_BRACE_STYLES: ReadonlySet<string> = new Set([
  'collapse',
  'expand',
  'end-expand',
  'none',
  // js-beautify accepts the modifier suffix on brace_style (e.g.
  // "collapse,preserve-inline"); the package.json exposes the alias below.
  'collapse-preserve-inline'
]);

function mapJsOptions(resolved: ResolvedOptions): JSBeautifyOptions {
  const engine = resolved.engineOptions;
  const options: JSBeautifyOptions = mapCoreOptions(resolved);

  const braceStyle = readString(engine, 'brace_style');
  if (braceStyle !== undefined && JS_BRACE_STYLES.has(braceStyle)) {
    // The package.json alias "collapse-preserve-inline" maps to js-beautify's
    // documented "collapse,preserve-inline" combined form.
    options.brace_style =
      braceStyle === 'collapse-preserve-inline'
        ? ('collapse,preserve-inline' as JSBeautifyOptions['brace_style'])
        : (braceStyle as JSBeautifyOptions['brace_style']);
  }

  const spaceAfterAnon = readBoolean(engine, 'space_after_anon_function');
  if (spaceAfterAnon !== undefined) {
    options.space_after_anon_function = spaceAfterAnon;
  }

  // Both default to js-beautify's own defaults (true and false) when unset, so a
  // user who sets neither gets exactly the output of every earlier version.
  const spaceBeforeConditional = readBoolean(engine, 'space_before_conditional');
  if (spaceBeforeConditional !== undefined) {
    options.space_before_conditional = spaceBeforeConditional;
  }

  const jslintHappy = readBoolean(engine, 'jslint_happy');
  if (jslintHappy !== undefined) {
    options.jslint_happy = jslintHappy;
  }

  const spaceAfterNamed = readBoolean(engine, 'space_after_named_function');
  if (spaceAfterNamed !== undefined) {
    options.space_after_named_function = spaceAfterNamed;
  }

  const spaceInParen = readBoolean(engine, 'space_in_paren');
  if (spaceInParen !== undefined) {
    options.space_in_paren = spaceInParen;
  }

  const spaceInEmptyParen = readBoolean(engine, 'space_in_empty_paren');
  if (spaceInEmptyParen !== undefined) {
    options.space_in_empty_paren = spaceInEmptyParen;
  }

  const breakChained = readBoolean(engine, 'break_chained_methods');
  if (breakChained !== undefined) {
    options.break_chained_methods = breakChained;
  }

  const keepArrayIndentation = readBoolean(engine, 'keep_array_indentation');
  if (keepArrayIndentation !== undefined) {
    options.keep_array_indentation = keepArrayIndentation;
  }

  const commaFirst = readBoolean(engine, 'comma_first');
  if (commaFirst !== undefined) {
    options.comma_first = commaFirst;
  }

  const operatorPosition = readString(engine, 'operator_position');
  if (
    operatorPosition === 'before-newline' ||
    operatorPosition === 'after-newline' ||
    operatorPosition === 'preserve-newline'
  ) {
    options.operator_position = operatorPosition;
  }

  return options;
}

function mapCssOptions(resolved: ResolvedOptions): CSSBeautifyOptions {
  const engine = resolved.engineOptions;
  const options: CSSBeautifyOptions = mapCoreOptions(resolved);

  const selectorSeparatorNewline = readBoolean(engine, 'selector_separator_newline');
  if (selectorSeparatorNewline !== undefined) {
    options.selector_separator_newline = selectorSeparatorNewline;
  }

  const newlineBetweenRules = readBoolean(engine, 'newline_between_rules');
  if (newlineBetweenRules !== undefined) {
    options.newline_between_rules = newlineBetweenRules;
  }

  const spaceAroundSelectorSeparator = readBoolean(engine, 'space_around_selector_separator');
  if (spaceAroundSelectorSeparator !== undefined) {
    options.space_around_selector_separator = spaceAroundSelectorSeparator;
  }

  const spaceAroundCombinator = readBoolean(engine, 'space_around_combinator');
  if (spaceAroundCombinator !== undefined) {
    options.space_around_combinator = spaceAroundCombinator;
  }

  return options;
}

/**
 * js-beautify's own default `void_elements` (1.15.4), the standard HTML void
 * elements plus the doctype / xml prologue markers and two obsolete tags. It is
 * restated here because a `void_elements` passed to js-beautify REPLACES its
 * default rather than extending it: to add a custom element, the standard list has
 * to be handed back in full. test/unit/engine pins this copy to the installed
 * js-beautify, so an upgrade that changes the default fails a test instead of
 * silently diverging from it.
 */
export const STANDARD_VOID_ELEMENTS: readonly string[] = Object.freeze([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'keygen',
  'link',
  'menuitem',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
  '!doctype',
  '?xml',
  'basefont',
  'isindex'
]);

/** `base` followed by the entries of `extra` it does not already contain. */
function addTags(base: readonly string[], extra: readonly string[]): string[] {
  return [...base, ...extra.filter((tag) => !base.includes(tag))];
}

const HTML_WRAP_ATTRIBUTES: ReadonlySet<string> = new Set([
  'auto',
  'force',
  'force-aligned',
  'force-expand-multiline',
  'aligned-multiple',
  'preserve',
  'preserve-aligned'
]);

function mapHtmlOptions(resolved: ResolvedOptions): HTMLBeautifyOptions {
  const engine = resolved.engineOptions;
  const options: HTMLBeautifyOptions = mapCoreOptions(resolved);

  // SAFETY, not style: js-beautify's own default for `content_unformatted` is
  // ['pre', 'textarea'], so it REFLOWS <xmp>, <listing> and <plaintext> even
  // though the HTML Rendering spec renders all five with `white-space: pre`.
  // A tab inside <xmp> came back as four spaces, which changes what the reader
  // sees. The printer is therefore handed the guard's OWN list (one module, one
  // source of truth: src/safety/htmlPreformatted.ts), so it can never reflow
  // inside a tag the guard compares verbatim.
  //
  // tidy.content_unformatted is ADDITIVE ONLY: the user's tags are appended to
  // that list, which is always present in full. A user list that could shrink it
  // would re-open the hole above (probe P16c: the guard then rejects an <xmp>).
  // Invalid entries are dropped here (and reported by Show Effective
  // Configuration, which asks the same sanitizer).
  options.content_unformatted = addTags(
    htmlPreformattedTags(),
    sanitizeTagList('content_unformatted', engine.content_unformatted).tags
  );

  // tidy.void_elements is ADDITIVE ONLY for the same reason: a standard void
  // element removed from the list makes the printer wait for a closing tag that
  // never comes and mis-indent everything after it. Nothing is passed when the
  // user added nothing new, so the printer keeps its own default untouched.
  const extraVoid = sanitizeTagList('void_elements', engine.void_elements).tags.filter(
    (tag) => !STANDARD_VOID_ELEMENTS.includes(tag)
  );
  if (extraVoid.length > 0) {
    options.void_elements = addTags(STANDARD_VOID_ELEMENTS, extraVoid);
  }

  const wrapAttributes = readString(engine, 'wrap_attributes');
  if (wrapAttributes !== undefined && HTML_WRAP_ATTRIBUTES.has(wrapAttributes)) {
    options.wrap_attributes = wrapAttributes as HTMLBeautifyOptions['wrap_attributes'];
  }

  const wrapAttributesIndentSize = readNumber(engine, 'wrap_attributes_indent_size');
  if (wrapAttributesIndentSize !== undefined) {
    options.wrap_attributes_indent_size = wrapAttributesIndentSize;
  }

  const indentInnerHtml = readBoolean(engine, 'indent_inner_html');
  if (indentInnerHtml !== undefined) {
    options.indent_inner_html = indentInnerHtml;
  }

  const indentScripts = readString(engine, 'indent_scripts');
  if (indentScripts === 'normal' || indentScripts === 'keep' || indentScripts === 'separate') {
    options.indent_scripts = indentScripts;
  }

  const indentHandlebars = readBoolean(engine, 'indent_handlebars');
  if (indentHandlebars !== undefined) {
    options.indent_handlebars = indentHandlebars;
  }

  return options;
}

/**
 * The engine id this adapter reports as an Engine: it is the js-beautify family
 * adapter, and the dispatcher / config layers key off this exact string
 * ('js-beautify' vs 'prettier'), so it must stay stable.
 */
export const JS_BEAUTIFY_ENGINE_ID = 'js-beautify';

/**
 * The id of the printer that ACTUALLY runs for json/jsonc. Those two are routed
 * to src/engine/jsonFormatter.ts (jsonc-parser), not to js-beautify, so naming
 * js-beautify in the status bar, the output channel and "Explain Last Format"
 * was a mislabel: it named a library that never ran.
 */
export const JSON_ENGINE_ID = 'jsonc-parser';

/**
 * The engine id to REPORT to the user for a language handled by this adapter.
 * Reporting only: the Engine.id above (and therefore every routing/config check
 * that compares it) is deliberately left alone.
 */
export function reportedEngineIdFor(lang: LangId): string {
  return FAMILY_BY_LANG[lang] === 'json' ? JSON_ENGINE_ID : JS_BEAUTIFY_ENGINE_ID;
}

function familyFor(lang: LangId): Family {
  const family = FAMILY_BY_LANG[lang];
  if (family === undefined) {
    throw new Error(`JsBeautifyEngine: unsupported languageId '${lang}'`);
  }
  return family;
}

/**
 * Run js-beautify for the given family on a slice of source text.
 * js-beautify itself throws on malformed input; we let that propagate so the
 * caller (and the safety Guard) can abort instead of applying a bad edit.
 */
function runBeautifier(family: Family, source: string, resolved: ResolvedOptions): string {
  switch (family) {
    case 'css':
      return cssBeautify(source, mapCssOptions(resolved));
    case 'html':
      return htmlBeautify(source, mapHtmlOptions(resolved));
    case 'js':
      return jsBeautify(source, mapJsOptions(resolved));
    case 'json':
      // Fast, comment-preserving JSON/JSONC path (jsonc-parser). Idempotent in a
      // single pass, so no fixed-point loop is needed for this family.
      return formatJson(source, resolved);
    default: {
      // Exhaustiveness guard: the union is closed, so this is unreachable, but
      // it keeps the switch total and surfaces any future Family addition.
      const exhaustive: never = family;
      throw new Error(`JsBeautifyEngine: unhandled family '${String(exhaustive)}'`);
    }
  }
}

/**
 * Does this text already end in a line break? Handed to the SHARED
 * post-processor as `originalEndsWithNewline`, so "no opinion"
 * (insertFinalNewline undefined) really means "no edit", in both directions.
 * Stateless (no /g flag): safe to reuse across calls.
 */
const ENDS_WITH_NEWLINE = /[\r\n]$/;

// The whitespace policy (per-line trim, final-newline, EOL normalisation) lives
// in src/engine/postProcess.ts and NOWHERE ELSE. This adapter used to carry its
// own copy, and the copy drifted: its final-newline branch appended a bare LF
// instead of the document's own line ending, so at the DEFAULT configuration
// (files.eol "auto", i.e. endOfLine undetermined, with insertFinalNewline true)
// a CRLF document came back with one lone LF glued to its last line. A
// whitespace-only difference is equivalent to the guard, so that mixed-EOL
// result was WRITTEN (defect C-04). One implementation, one behaviour.

/**
 * Clamp and validate a requested range against the source bounds.
 * Returns the normalised [start, end) slice indices, or null when the range is
 * empty/degenerate (caller then formats nothing meaningful and falls back).
 */
function normaliseRange(
  code: string,
  range: { startOffset: number; endOffset: number }
): { start: number; end: number } | null {
  const length = code.length;
  const start = Math.max(0, Math.min(range.startOffset, length));
  const end = Math.max(0, Math.min(range.endOffset, length));
  if (end <= start) {
    return null;
  }
  return { start, end };
}

export class JsBeautifyEngine implements Engine {
  public readonly id = JS_BEAUTIFY_ENGINE_ID;

  public supports(lang: LangId): boolean {
    return SUPPORTED.has(lang);
  }

  public async format(req: FormatRequest): Promise<string> {
    const family = familyFor(req.languageId);
    // Every family is idempotent in a single pass: css/html/js via js-beautify,
    // json/jsonc via jsonc-parser (which is stable for the inline-comment case
    // that previously made js-beautify drift, BUG-JSONC-INLINE-COMMENT).
    const beautify = (source: string): string => runBeautifier(family, source, req.options);

    // Whole-document path: beautify everything, then post-process.
    if (!req.range) {
      const beautified = beautify(req.code);
      return postProcess(
        beautified,
        req.options,
        ENDS_WITH_NEWLINE.test(req.code)
      );
    }

    // Range path: beautify only the selected slice and splice it back so the
    // surrounding text is preserved byte-for-byte (VS Code applies a TextEdit
    // covering exactly this range). The slice's CONTENT is post-processed for
    // trim and EOL consistency; the final-newline policy is intentionally NOT
    // applied, since the selection is not the end of the document, and the
    // slice's own two edge whitespace runs are excluded from the pass entirely
    // and put back verbatim (see below).
    const bounds = normaliseRange(req.code, req.range);
    if (bounds === null) {
      // Degenerate/empty range: nothing to format; return input unchanged so
      // the Guard sees an identity transform and VS Code makes no edit.
      return req.code;
    }

    const before = req.code.slice(0, bounds.start);
    const selected = req.code.slice(bounds.start, bounds.end);
    const after = req.code.slice(bounds.end);

    // The slice's OWN leading and trailing whitespace runs are not the
    // printer's to rewrite: the bytes on either side of the slice stay in the
    // buffer, so trimming an edge JOINS the slice to its neighbour. In HTML
    // that turns "hello x y" into "hello xy" and the guard cannot see it
    // (defect G3-4); in every family it also means a selection whose last
    // character is a line break comes back one line longer than it went in, so
    // the next pass formats a DIFFERENT slice and format(format(x)) never
    // reaches the fixed point the README promises (defect M3-3). Both runs go
    // back byte for byte below.
    const edges = splitSliceEdges(selected);

    // A slice that is nothing but whitespace has no content to print, and in
    // HTML the run IS a rendered space. Hand the document back untouched
    // rather than letting the printer collapse it.
    if (edges.core === '') {
      return req.code;
    }

    const beautifiedSelection = beautify(selected);

    // Apply only whitespace-level post-processing (trim + EOL) to the selection;
    // suppress the final-newline policy by clearing it for this sub-format. The
    // slice is not the end of the document, and its own trailing run is put
    // back verbatim just below, so "no opinion" is told the printed text does
    // NOT end in a newline: any newline the printer added at the edge is the
    // printer's, not the user's.
    const selectionOptions: ResolvedOptions = {
      ...req.options,
      insertFinalNewline: undefined
    };
    const processedSelection = postProcess(
      beautifiedSelection,
      selectionOptions,
      false
    );

    // Verbatim, line endings included: these bytes come straight from the
    // document, so putting them back can never introduce a foreign EOL.
    const spliced =
      edges.leading + splitSliceEdges(processedSelection).core + edges.trailing;

    return before + spliced + after;
  }
}
