// js-beautify engine adapter.
// Handles css/scss/less/html/json/jsonc/javascript per the MVP engine decision.
//
// Responsibilities:
//   - Map ResolvedOptions (tabSize/insertSpaces -> indent_size/indent_char/
//     indent_with_tabs) plus engineOptions (brace_style, wrap_line_length,
//     wrap_attributes, space_after_anon_function, ...) onto js-beautify's
//     css()/html()/js() option objects.
//   - Drive the correct js-beautify entry point per language family.
//   - Apply endOfLine / insertFinalNewline / trimTrailingWhitespace as a pure
//     post-processing pass (js-beautify only partially handles these).
//   - Honour `range`: format the sub-text only and splice it back in.
//
// PURE: this module MUST NOT import 'vscode' so it stays testable under
// mocha + tsx outside the Electron host. All inputs arrive via FormatRequest.
import { css as cssBeautify, html as htmlBeautify, js as jsBeautify } from 'js-beautify';
import type { CSSBeautifyOptions, HTMLBeautifyOptions, JSBeautifyOptions } from 'js-beautify';
import type { Engine, FormatRequest, LangId, ResolvedOptions } from '../types';
import { formatJson } from './jsonFormatter';

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
  // (src/engine/jsonFormatter.ts) — comment-preserving and ~13x faster than
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

const EOL_REGEX = /\r\n|\r|\n/g;
const TRAILING_WS_PER_LINE = /[^\S\r\n]+(?=\r\n|\r|\n|$)/g;

/**
 * Normalise line endings, optionally strip per-line trailing whitespace, and
 * apply the final-newline policy. Pure string transform — no mutation of inputs.
 *
 * Ordering matters: trailing-whitespace trimming runs before the final-newline
 * decision so a file ending in spaces still gets exactly one (or zero) newline.
 */
function postProcess(text: string, resolved: ResolvedOptions): string {
  let result = text;

  if (resolved.trimTrailingWhitespace === true) {
    result = result.replace(TRAILING_WS_PER_LINE, '');
  }

  if (resolved.insertFinalNewline === true) {
    result = result.replace(/[\r\n]+$/, '');
    result += '\n';
  } else if (resolved.insertFinalNewline === false) {
    result = result.replace(/[\r\n]+$/, '');
  }
  // When insertFinalNewline is undefined we leave js-beautify's own trailing
  // newline behaviour untouched (no opinion = no edit).

  // Apply EOL last so every newline introduced above gets the right style.
  if (resolved.endOfLine === 'crlf') {
    result = result.replace(EOL_REGEX, '\r\n');
  } else if (resolved.endOfLine === 'lf') {
    result = result.replace(EOL_REGEX, '\n');
  }

  return result;
}

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
  public readonly id = 'js-beautify';

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
      return postProcess(beautified, req.options);
    }

    // Range path: beautify only the selected slice and splice it back so the
    // surrounding text is preserved byte-for-byte (VS Code applies a TextEdit
    // covering exactly this range). The whole result is post-processed for EOL
    // consistency, but the final-newline policy is intentionally NOT applied to
    // a partial format since the selection is not the end of the document.
    const bounds = normaliseRange(req.code, req.range);
    if (bounds === null) {
      // Degenerate/empty range: nothing to format; return input unchanged so
      // the Guard sees an identity transform and VS Code makes no edit.
      return req.code;
    }

    const before = req.code.slice(0, bounds.start);
    const selected = req.code.slice(bounds.start, bounds.end);
    const after = req.code.slice(bounds.end);

    const beautifiedSelection = beautify(selected);

    // Apply only whitespace-level post-processing (trim + EOL) to the selection;
    // suppress the final-newline policy by clearing it for this sub-format.
    const selectionOptions: ResolvedOptions = {
      ...req.options,
      insertFinalNewline: undefined
    };
    const processedSelection = postProcess(beautifiedSelection, selectionOptions);

    return before + processedSelection + after;
  }
}
