// The incumbent's REAL config shape, as data for the migration tests.
//
// Provenance (probe P3(a), _internal/audit-v050/09-sondes-hote.md section 1.5):
// this is the default `formatter.json` transcribed from the README screenshot of
// lonefy.vscode-JS-CSS-HTML-formatter (May 2016, 0.1.x): an `onSave` key plus one
// section per language, in js-beautify vocabulary with the historical camelCase
// and duplicated variants. It is what `Lonefy.formatterCreateLocalConfig` copies
// into `.vscode/formatter.json`, so it is what a real user of the incumbent has.
//
// Not a test file (no `.test.` in the name): mocha's glob skips it.

/** The incumbent's default `formatter.json`, verbatim in shape. */
export const LONEFY_DEFAULT_FORMATTER_JSON = `{
  "onSave": true,
  "javascript": {
    "indent_size": 4, "indent_char": " ", "eol": "auto", "preserve_newlines": true,
    "break_chained_methods": false, "max_preserve_newlines": 0, "space_in_paren": false,
    "space_in_empty_paren": false, "jslint_happy": false, "space_after_anon_function": false,
    "keep_array_indentation": false, "space_before_conditional": true, "unescape_strings": false,
    "wrap_line_length": 0, "e4x": false, "end_with_newline": false, "comma_first": false
  },
  "css": {
    "indent_size": 4, "indentCharacter": " ", "indent_char": " ", "selectorSeparatorNewLine": true,
    "end_with_newline": false, "newline_between_rules": true, "eol": "\\n"
  },
  "html": {
    "indent_inner_html": false, "indent_size": 4, "indent_char": " ", "indent_character": " "
  }
}
`;

/**
 * Every key of {@link LONEFY_DEFAULT_FORMATTER_JSON} that the key mapper does not
 * carry over, in the order the mapper reports them (section by section).
 */
export const LONEFY_DEFAULT_UNMAPPED: readonly string[] = [
  'javascript.indent_char',
  'javascript.eol',
  'javascript.preserve_newlines',
  'javascript.break_chained_methods',
  'javascript.max_preserve_newlines',
  'javascript.space_in_paren',
  'javascript.space_in_empty_paren',
  'javascript.jslint_happy',
  'javascript.keep_array_indentation',
  'javascript.space_before_conditional',
  'javascript.unescape_strings',
  'javascript.e4x',
  'javascript.end_with_newline',
  'javascript.comma_first',
  'css.indentCharacter',
  'css.indent_char',
  'css.selectorSeparatorNewLine',
  'css.end_with_newline',
  'css.newline_between_rules',
  'css.eol',
  'html.indent_inner_html',
  'html.indent_char',
  'html.indent_character'
];

/**
 * The same shape as a contributor edited it (issue/PR #42): `indent_size` 2,
 * `brace_style` added to `javascript`, and `"html": false`.
 */
export const LONEFY_CONTRIBUTOR_FORMATTER_JSON = `{
  "onSave": true,
  "javascript": { "indent_size": 2, "brace_style": "collapse-preserve-inline" },
  "css": { "indent_size": 2 },
  "html": false
}
`;
