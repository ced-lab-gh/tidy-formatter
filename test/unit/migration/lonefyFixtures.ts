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
 * Every write the key mapper proposes for {@link LONEFY_DEFAULT_FORMATTER_JSON}, in
 * the order it reports them: section by section (javascript, css, html), languages
 * in the order the incumbent applies the section to them, keys in file order.
 *
 * The incumbent formatted JSON with the `javascript` section and SCSS with the
 * `css` section (extension.ts L41-58), hence [json] and [scss]. [json] carries only
 * the indentation: Tidy's JSON engine reads nothing else (wrap_line_length is
 * declared for every language by the catalogue but is inert on JSON).
 */
export const LONEFY_DEFAULT_WRITES: readonly string[] = [
  '[javascript] tidy.indent = 4',
  '[javascript] tidy.preserve_newlines = true',
  '[javascript] tidy.break_chained_methods = false',
  '[javascript] tidy.max_preserve_newlines = 0',
  '[javascript] tidy.space_in_paren = false',
  '[javascript] tidy.space_in_empty_paren = false',
  '[javascript] tidy.jslint_happy = false',
  '[javascript] tidy.space_after_anon_function = false',
  '[javascript] tidy.keep_array_indentation = false',
  '[javascript] tidy.space_before_conditional = true',
  '[javascript] tidy.wrap_line_length = 0',
  '[javascript] tidy.comma_first = false',
  '[json] tidy.indent = 4',
  '[css] tidy.indent = 4',
  '[css] tidy.newline_between_rules = true',
  '[css] tidy.end_of_line = "lf"',
  '[scss] tidy.indent = 4',
  '[scss] tidy.newline_between_rules = true',
  '[scss] tidy.end_of_line = "lf"',
  '[html] tidy.indent_inner_html = false',
  '[html] tidy.indent = 4'
];

/**
 * Every key of {@link LONEFY_DEFAULT_FORMATTER_JSON} that the key mapper does not
 * carry over, in file order (section by section). Each has a reason, recorded in
 * src/migration/lonefyKeys.ts and asserted one by one in lonefyKeys.test.ts: no
 * `tidy.*` setting exists (indent_char, unescape_strings, e4x, end_with_newline),
 * the spelling is not a js-beautify option (indentCharacter,
 * selectorSeparatorNewLine, indent_character), or the value has no Tidy equivalent
 * (eol "auto").
 */
export const LONEFY_DEFAULT_UNMAPPED: readonly string[] = [
  'javascript.indent_char',
  'javascript.eol',
  'javascript.unescape_strings',
  'javascript.e4x',
  'javascript.end_with_newline',
  'css.indentCharacter',
  'css.indent_char',
  'css.selectorSeparatorNewLine',
  'css.end_with_newline',
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
