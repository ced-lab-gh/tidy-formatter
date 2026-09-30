// Option catalogue: the SINGLE SOURCE OF TRUTH for every configurable Tidy
// formatting option (Axe 3 : "not enough options").
//
// PURE: this module MUST NOT import 'vscode' so it stays unit-testable under
// mocha + tsx outside the Electron host. Every consumer derives from this list:
//   - vscodeConfig.ts reads each `settingKey` from VS Code (per-language for the
//     `language-overridable` entries) and injects the value into the right place
//     of ResolvedOptions (engineOptions.<engineKey> for js-beautify/core, or
//     engineOptions.prettier.<engineKey> for prettier);
//   - package.json's contributes.configuration mirrors these entries (type /
//     default / enum / description / scope), kept in sync by a CI test;
//   - the catalogue's validation helpers reject any out-of-type / out-of-enum
//     value so an invalid setting is never propagated to an engine.
//
// Indentation (tabSize / insertSpaces) is NOT redeclared here as such: it flows
// through the typed fields of ResolvedOptions (see resolver.ts), and the only
// indentation entry, tidy.indent, is an ALIAS of the typed tabSize field (its
// engineKey `indent_size` is resolved into tabSize), never a second copy of it.
// vscodeConfig.ts places an explicitly set tidy.indent ABOVE the live
// FormattingOptions layer so it can actually take effect (defect C-12).

/**
 * Which part of the format pipeline an option drives.
 *  - 'jsbeautify' : a js-beautify option (css/scss/less/html/json/jsonc/js).
 *                   Injected as engineOptions.<engineKey>.
 *  - 'prettier'   : a Prettier stylistic option (ts/tsx/jsx). Injected as
 *                   engineOptions.prettier.<engineKey>. AST-INVARIANT only.
 *  - 'core'       : a cross-engine option already understood by the resolver /
 *                   post-processing (currently the shared wrap_line_length).
 */
export type OptionEngine = 'jsbeautify' | 'prettier' | 'core';

/**
 * The value type of an option, used both for VS Code's `type` field and for
 * runtime validation before a value reaches an engine.
 */
export type OptionType = 'boolean' | 'integer' | 'string';

/**
 * VS Code configuration scope. `language-overridable` is what allows a
 * `[typescript]: { "tidy.singleQuote": true }` block to override the global
 * value for a single language (per-language configurability, deliverable §5).
 */
export type OptionScope = 'window' | 'resource' | 'language-overridable';

/**
 * The set of languageIds Tidy supports, mirrored from types.ts LangId. Kept as a
 * plain string list here so the catalogue stays import-light and can declare
 * which families an option applies to.
 */
export type CatalogLang =
  | 'css'
  | 'scss'
  | 'less'
  | 'html'
  | 'json'
  | 'jsonc'
  | 'javascript'
  | 'typescript'
  | 'typescriptreact'
  | 'javascriptreact';

/**
 * One catalogue entry. The shape is deliberately flat and JSON-serialisable so a
 * CI test can compare it field-by-field with the matching package.json property.
 */
export interface OptionEntry {
  /** Full VS Code setting key, always `tidy.*` (e.g. 'tidy.semi'). */
  readonly settingKey: string;
  /** Which engine consumes the value. */
  readonly engine: OptionEngine;
  /**
   * The key handed to the engine. For js-beautify this is the native option name
   * (e.g. 'preserve_newlines'); for prettier the camelCase Prettier option name
   * (e.g. 'singleQuote'); for 'core' the canonical engineOptions key.
   */
  readonly engineKey: string;
  /** Value type (drives VS Code `type` and runtime validation). */
  readonly type: OptionType;
  /** Default value. Mirrors package.json `default`. */
  readonly default: boolean | number | string;
  /** Allowed values for a string enum; absent for free strings/numbers/bools. */
  readonly enum?: readonly string[];
  /** Which languages this option affects: 'all' or an explicit list. */
  readonly languages: 'all' | readonly CatalogLang[];
  /** VS Code configuration scope. */
  readonly scope: OptionScope;
  /** Human-readable description mirrored into package.json. */
  readonly description: string;
}

// js-beautify CSS-family languages.
const CSS_LANGS: readonly CatalogLang[] = ['css', 'scss', 'less'];
// js-beautify JS family (plain js only; ts/tsx/jsx go through prettier).
const JSBEAUTIFY_JS_LANGS: readonly CatalogLang[] = ['javascript'];
// Prettier stylistic options apply to the real-parser languages.
//
// Exported because the resolver needs the same answer to "can Prettier print
// this language": it collapses the two width keys into one only there (see
// resolver.ts). 'javascript' is included because a plain .js file that contains
// JSX is re-routed to Prettier; the resolver cannot tell which .js files those
// are, and for the rest the extra value is simply never read by js-beautify.
export const PRETTIER_LANGS: readonly CatalogLang[] = [
  'typescript',
  'typescriptreact',
  'javascriptreact',
  'javascript'
];
// The blank-line and empty-line options below are js-beautify options with no
// Prettier and no jsonc-parser equivalent. Declaring them for 'all' made them
// silently inert on json, jsonc, typescript, typescriptreact and javascriptreact
// (defect C-14), so they are declared for the families that really read them.
const JSBEAUTIFY_NEWLINE_LANGS: readonly CatalogLang[] = [
  'css',
  'scss',
  'less',
  'html',
  'javascript'
];
// Shared sentence for the three descriptions that use JSBEAUTIFY_NEWLINE_LANGS,
// so the caveat cannot drift between them.
const NEWLINE_OPTION_SCOPE_NOTE =
  'Applies to CSS, SCSS, LESS, HTML and JavaScript; it has no effect on JSON, or on files Prettier prints (TypeScript, TSX, JSX, and JavaScript that contains JSX).';

/**
 * The complete, curated catalogue. Ordering groups by family for readability;
 * consumers never depend on order.
 *
 * The first five js-beautify entries (indent / brace_style / wrap_line_length /
 * wrap_attributes / space_after_anon_function) are the options already exposed by
 * the shipped extension; they are re-declared here so the catalogue is the SINGLE
 * source of truth and the CI sync test covers them too. The remainder are new.
 */
export const OPTION_CATALOG: readonly OptionEntry[] = [
  // --- js-beautify: shared / core (the 5 already shipped) -------------------
  {
    settingKey: 'tidy.indent',
    engine: 'jsbeautify',
    engineKey: 'indent_size',
    type: 'integer',
    default: 4,
    languages: 'all',
    scope: 'language-overridable',
    description:
      'Indentation size in spaces. When you set it, it overrides the editor tab size (editor.tabSize, or the size VS Code detected in the file); a project config (.editorconfig, .prettierrc, .soukformatrc) still wins over it. Spaces versus tabs stays governed by editor.insertSpaces.'
  },
  {
    settingKey: 'tidy.brace_style',
    engine: 'jsbeautify',
    engineKey: 'brace_style',
    type: 'string',
    default: 'collapse',
    enum: ['collapse', 'expand', 'end-expand', 'none', 'collapse-preserve-inline'],
    languages: JSBEAUTIFY_JS_LANGS,
    scope: 'language-overridable',
    description:
      'Brace placement style for JavaScript files printed by js-beautify (js-beautify brace_style). It has no effect on CSS, HTML or JSON, nor on TypeScript, TSX, JSX or a JavaScript file that contains JSX: Prettier prints those with its own brace placement.'
  },
  {
    settingKey: 'tidy.wrap_line_length',
    engine: 'core',
    engineKey: 'wrap_line_length',
    type: 'integer',
    default: 0,
    languages: 'all',
    scope: 'language-overridable',
    description:
      "Maximum characters per line before wrapping; 0 disables wrapping. Used for HTML and JavaScript (js-beautify wrap_line_length) and, as the print width, for TypeScript, TSX and JSX (Prettier). It has no effect on JSON, and js-beautify does not wrap CSS, SCSS or LESS by width. For the Prettier languages an unset value keeps Prettier's default of 80. It shares one value with tidy.prettier.printWidth: whichever is set in the higher layer wins."
  },
  {
    settingKey: 'tidy.wrap_attributes',
    engine: 'jsbeautify',
    engineKey: 'wrap_attributes',
    type: 'string',
    default: 'auto',
    enum: [
      'auto',
      'force',
      'force-aligned',
      'force-expand-multiline',
      'aligned-multiple',
      'preserve',
      'preserve-aligned'
    ],
    languages: ['html'],
    scope: 'language-overridable',
    description: 'How HTML attributes are wrapped (js-beautify wrap_attributes).'
  },
  {
    settingKey: 'tidy.space_after_anon_function',
    engine: 'jsbeautify',
    engineKey: 'space_after_anon_function',
    type: 'boolean',
    default: false,
    languages: JSBEAUTIFY_JS_LANGS,
    scope: 'language-overridable',
    description:
      'Add a space after an anonymous function keyword (js-beautify space_after_anon_function).'
  },

  // --- js-beautify: shared newline handling (css/html/js) -------------------
  {
    settingKey: 'tidy.end_of_line',
    engine: 'jsbeautify',
    engineKey: 'end_of_line',
    type: 'string',
    default: 'lf',
    enum: ['lf', 'crlf'],
    languages: 'all',
    scope: 'language-overridable',
    description:
      'Line-ending style applied to formatted output when no editor/project setting governs (lf or crlf).'
  },
  {
    settingKey: 'tidy.preserve_newlines',
    engine: 'jsbeautify',
    engineKey: 'preserve_newlines',
    type: 'boolean',
    default: true,
    languages: JSBEAUTIFY_NEWLINE_LANGS,
    scope: 'language-overridable',
    description: `Keep existing blank lines between statements/rules (js-beautify preserve_newlines). ${NEWLINE_OPTION_SCOPE_NOTE}`
  },
  {
    settingKey: 'tidy.max_preserve_newlines',
    engine: 'jsbeautify',
    engineKey: 'max_preserve_newlines',
    type: 'integer',
    default: 10,
    languages: JSBEAUTIFY_NEWLINE_LANGS,
    scope: 'language-overridable',
    description: `Maximum number of consecutive blank lines to keep (js-beautify max_preserve_newlines). ${NEWLINE_OPTION_SCOPE_NOTE}`
  },
  {
    settingKey: 'tidy.indent_empty_lines',
    engine: 'jsbeautify',
    engineKey: 'indent_empty_lines',
    type: 'boolean',
    default: false,
    languages: JSBEAUTIFY_NEWLINE_LANGS,
    scope: 'language-overridable',
    description: `Keep indentation on otherwise-empty lines (js-beautify indent_empty_lines). ${NEWLINE_OPTION_SCOPE_NOTE}`
  },

  // --- js-beautify: JavaScript-specific ------------------------------------
  {
    settingKey: 'tidy.space_in_paren',
    engine: 'jsbeautify',
    engineKey: 'space_in_paren',
    type: 'boolean',
    default: false,
    languages: JSBEAUTIFY_JS_LANGS,
    scope: 'language-overridable',
    description:
      'Add padding spaces inside parentheses, e.g. f( a ) (js-beautify space_in_paren).'
  },
  {
    settingKey: 'tidy.space_in_empty_paren',
    engine: 'jsbeautify',
    engineKey: 'space_in_empty_paren',
    type: 'boolean',
    default: false,
    languages: JSBEAUTIFY_JS_LANGS,
    scope: 'language-overridable',
    description:
      'Keep a space inside an empty parentheses pair, e.g. f( ) (js-beautify space_in_empty_paren).'
  },
  {
    settingKey: 'tidy.break_chained_methods',
    engine: 'jsbeautify',
    engineKey: 'break_chained_methods',
    type: 'boolean',
    default: false,
    languages: JSBEAUTIFY_JS_LANGS,
    scope: 'language-overridable',
    description:
      'Break chained method calls across lines (js-beautify break_chained_methods).'
  },
  {
    settingKey: 'tidy.keep_array_indentation',
    engine: 'jsbeautify',
    engineKey: 'keep_array_indentation',
    type: 'boolean',
    default: false,
    languages: JSBEAUTIFY_JS_LANGS,
    scope: 'language-overridable',
    description:
      'Preserve array element indentation as authored (js-beautify keep_array_indentation).'
  },
  {
    settingKey: 'tidy.comma_first',
    engine: 'jsbeautify',
    engineKey: 'comma_first',
    type: 'boolean',
    default: false,
    languages: JSBEAUTIFY_JS_LANGS,
    scope: 'language-overridable',
    description:
      'Put commas at the start of the next line rather than the end (js-beautify comma_first).'
  },
  {
    settingKey: 'tidy.operator_position',
    engine: 'jsbeautify',
    engineKey: 'operator_position',
    type: 'string',
    default: 'before-newline',
    enum: ['before-newline', 'after-newline', 'preserve-newline'],
    languages: JSBEAUTIFY_JS_LANGS,
    scope: 'language-overridable',
    description:
      'Where line-breaking operators are placed relative to the newline (js-beautify operator_position).'
  },

  // --- js-beautify: CSS-specific -------------------------------------------
  {
    settingKey: 'tidy.selector_separator_newline',
    engine: 'jsbeautify',
    engineKey: 'selector_separator_newline',
    type: 'boolean',
    default: true,
    languages: CSS_LANGS,
    scope: 'language-overridable',
    description:
      'Put each selector in a comma-separated group on its own line (js-beautify selector_separator_newline).'
  },
  {
    settingKey: 'tidy.newline_between_rules',
    engine: 'jsbeautify',
    engineKey: 'newline_between_rules',
    type: 'boolean',
    default: true,
    languages: CSS_LANGS,
    scope: 'language-overridable',
    description:
      'Insert a blank line between CSS rules (js-beautify newline_between_rules).'
  },
  {
    settingKey: 'tidy.space_around_combinator',
    engine: 'jsbeautify',
    engineKey: 'space_around_combinator',
    type: 'boolean',
    default: false,
    languages: CSS_LANGS,
    scope: 'language-overridable',
    description:
      'Put spaces around selector combinators, e.g. a > b (js-beautify space_around_combinator).'
  },

  // --- js-beautify: HTML-specific ------------------------------------------
  {
    settingKey: 'tidy.indent_inner_html',
    engine: 'jsbeautify',
    engineKey: 'indent_inner_html',
    type: 'boolean',
    default: false,
    languages: ['html'],
    scope: 'language-overridable',
    description:
      'Indent <head> and <body> sections inside <html> (js-beautify indent_inner_html).'
  },
  {
    settingKey: 'tidy.indent_scripts',
    engine: 'jsbeautify',
    engineKey: 'indent_scripts',
    type: 'string',
    default: 'normal',
    enum: ['keep', 'separate', 'normal'],
    languages: ['html'],
    scope: 'language-overridable',
    description:
      'How <script>/<style> contents are indented inside HTML (js-beautify indent_scripts).'
  },
  {
    settingKey: 'tidy.wrap_attributes_indent_size',
    engine: 'jsbeautify',
    engineKey: 'wrap_attributes_indent_size',
    type: 'integer',
    default: 4,
    languages: ['html'],
    scope: 'language-overridable',
    description:
      'Indent size for wrapped HTML attributes (js-beautify wrap_attributes_indent_size).'
  },

  // --- Prettier: AST-invariant stylistic options (ts/tsx/jsx) --------------
  // SAFETY: every option below is STYLISTIC ONLY. Toggling it changes Prettier's
  // output (quote style, semicolons, trailing commas, parens, line width) but
  // produces the SAME babel AST modulo whitespace/style, so the equivalence guard
  // still accepts it. STRUCTURAL_IGNORE_KEYS in guard.ts strips `extra`/`raw`,
  // which is where quote-style/numeric-literal raw text lives. Tests in
  // test/unit/safety/guard.test.ts PROVE each toggle stays guard-equivalent.
  {
    settingKey: 'tidy.prettier.printWidth',
    engine: 'prettier',
    engineKey: 'printWidth',
    type: 'integer',
    default: 80,
    languages: PRETTIER_LANGS,
    scope: 'language-overridable',
    description:
      'Target line width before Prettier wraps TS/JSX code (Prettier printWidth). Stylistic only. It shares one value with tidy.wrap_line_length: whichever is set in the higher layer wins.'
  },
  {
    settingKey: 'tidy.prettier.semi',
    engine: 'prettier',
    engineKey: 'semi',
    type: 'boolean',
    default: true,
    languages: PRETTIER_LANGS,
    scope: 'language-overridable',
    description:
      'Print semicolons at the end of statements (Prettier semi). Stylistic only; does not change the AST.'
  },
  {
    settingKey: 'tidy.prettier.singleQuote',
    engine: 'prettier',
    engineKey: 'singleQuote',
    type: 'boolean',
    default: false,
    languages: PRETTIER_LANGS,
    scope: 'language-overridable',
    description:
      'Use single quotes instead of double quotes (Prettier singleQuote). Stylistic only.'
  },
  {
    settingKey: 'tidy.prettier.jsxSingleQuote',
    engine: 'prettier',
    engineKey: 'jsxSingleQuote',
    type: 'boolean',
    default: false,
    languages: PRETTIER_LANGS,
    scope: 'language-overridable',
    description:
      'Use single quotes in JSX attributes (Prettier jsxSingleQuote). Stylistic only.'
  },
  {
    settingKey: 'tidy.prettier.trailingComma',
    engine: 'prettier',
    engineKey: 'trailingComma',
    type: 'string',
    default: 'all',
    enum: ['none', 'es5', 'all'],
    languages: PRETTIER_LANGS,
    scope: 'language-overridable',
    description:
      'Where trailing commas are printed (Prettier trailingComma). Stylistic only.'
  },
  {
    settingKey: 'tidy.prettier.bracketSpacing',
    engine: 'prettier',
    engineKey: 'bracketSpacing',
    type: 'boolean',
    default: true,
    languages: PRETTIER_LANGS,
    scope: 'language-overridable',
    description:
      'Print spaces inside object braces, e.g. { a } (Prettier bracketSpacing). Stylistic only.'
  },
  {
    settingKey: 'tidy.prettier.bracketSameLine',
    engine: 'prettier',
    engineKey: 'bracketSameLine',
    type: 'boolean',
    default: false,
    languages: PRETTIER_LANGS,
    scope: 'language-overridable',
    description:
      'Put the > of a multi-line element on the last attribute line (Prettier bracketSameLine). Stylistic only.'
  },
  {
    settingKey: 'tidy.prettier.arrowParens',
    engine: 'prettier',
    engineKey: 'arrowParens',
    type: 'string',
    default: 'always',
    enum: ['always', 'avoid'],
    languages: PRETTIER_LANGS,
    scope: 'language-overridable',
    description:
      'Include parentheses around a sole arrow-function parameter (Prettier arrowParens). Stylistic only.'
  }
  // NOTE: Prettier's `quoteProps` is intentionally NOT exposed. Changing an
  // object key from `a` to `"a"` switches its babel AST node from Identifier to
  // StringLiteral : a STRUCTURAL change the equivalence guard (correctly) rejects.
  // It is therefore not AST-invariant under our guard and would either no-op the
  // formatter or require relaxing the guard, which the safety contract forbids.
  // Re-evaluate only if/when the guard learns to treat Identifier⇔StringLiteral
  // object keys as equivalent.
];

/**
 * Fast lookup by setting key.
 */
const BY_SETTING_KEY: ReadonlyMap<string, OptionEntry> = new Map(
  OPTION_CATALOG.map((entry) => [entry.settingKey, entry])
);

/**
 * Find a catalogue entry by its full `tidy.*` setting key, or undefined.
 */
export function findBySettingKey(settingKey: string): OptionEntry | undefined {
  return BY_SETTING_KEY.get(settingKey);
}

/**
 * Whether an option applies to a given languageId. 'all' matches every language;
 * otherwise the language must be in the explicit list.
 */
export function appliesToLanguage(entry: OptionEntry, lang: CatalogLang): boolean {
  return entry.languages === 'all' || entry.languages.includes(lang);
}

/**
 * Validate and coerce a raw setting value against an entry's declared type/enum.
 * Returns the validated value, or undefined when the value is missing or invalid
 * (so an invalid setting is never propagated to an engine : contract §3).
 *
 * PURE: no side effects, no I/O. Numbers must be finite; integers must be whole.
 * Strings constrained by `enum` must be one of the allowed values.
 */
export function validateValue(entry: OptionEntry, rawValue: unknown): boolean | number | string | undefined {
  if (rawValue === undefined || rawValue === null) {
    return undefined;
  }
  switch (entry.type) {
    case 'boolean':
      return typeof rawValue === 'boolean' ? rawValue : undefined;
    case 'integer': {
      if (typeof rawValue !== 'number' || !Number.isFinite(rawValue) || !Number.isInteger(rawValue)) {
        return undefined;
      }
      return rawValue;
    }
    case 'string': {
      if (typeof rawValue !== 'string') {
        return undefined;
      }
      if (entry.enum && !entry.enum.includes(rawValue)) {
        return undefined;
      }
      return rawValue;
    }
    default: {
      // Exhaustiveness guard: a new OptionType must get explicit handling.
      const exhaustive: never = entry.type;
      throw new Error(`optionCatalog: unhandled option type '${String(exhaustive)}'`);
    }
  }
}
