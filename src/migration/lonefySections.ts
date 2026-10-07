// How the incumbent applies each section of its `formatter.json` (v0.5.0, MIGRATION).
// The FACTS here are the incumbent's; the Tidy side lives in tidyApplicability.ts.
//
// SOURCE (cited, not recalled):
//   Lonefy/vscode-JS-CSS-HTML-formatter, commit e2a6ca0de2082aee9c5262f759acb7036962cad4
//   ("version 0.2.3", 2017-03-31), file src/extension.ts,
//   https://github.com/Lonefy/vscode-JS-CSS-HTML-formatter/blob/e2a6ca0de2082aee9c5262f759acb7036962cad4/src/extension.ts
//   - L41-58, the `switch (languageId)` in `beatify()`:
//       L42-43 `case 'scss': languageId = 'css';` then falls through to
//       L44-45 `case 'css': beatiFunc = jsbeautify.css;`   => the `css` section also formats SCSS;
//       L47-48 `case 'json': languageId = 'javascript';` then falls through to
//       L49-50 `case 'javascript': beatiFunc = jsbeautify.js;` => the `javascript` section also formats JSON;
//       L52-53 `case 'html': beatiFunc = jsbeautify.html;`;
//       L55-56 `default:` "Sorry, this language is not supported. Only support Javascript, CSS and HTML."
//   - L62-70, the options of a language are `require(local)[languageId]`, with the
//     already-mapped `languageId` ('css' for SCSS, 'javascript' for JSON);
//   - L79, `docType = ['css', 'scss', 'javascript', 'html', 'json']`: the five
//     languages it registers. LESS, JSONC, TypeScript and JSX are NOT among them, so
//     the incumbent never formatted them and no section feeds `[less]` or `[jsonc]`.
//   (L41-58 re-read in this pass; L79 and the other line numbers are those recorded
//   by the audit probe P3(a), _internal/audit-v050/09-sondes-hote.md section 1.)
//
// WHICH KEYS EACH SECTION REALLY HONOURS. The incumbent hands a section unchanged
// to `js-beautify` (package.json: "js-beautify": "^1.6.4", so at most 1.6.12, the
// last 1.6.x). A key the library does not read in that family did NOTHING there, so
// importing it would add a behaviour the user never had. The sets below are the
// option names read by, in js-beautify v1.6.12:
//   js/lib/beautify.js      (the `javascript` section)
//   js/lib/beautify-css.js  (the `css` section)
//   js/lib/beautify-html.js (the `html` section)
// https://github.com/beautify-web/js-beautify/tree/v1.6.12/js/lib
// Only keys that also have a Tidy equivalent are listed; a key missing from a set is
// reported as "not carried over". Facts that drive the sets: CSS does not read
// `max_preserve_newlines`, `wrap_line_length`, `brace_style` or `wrap_attributes`;
// `indent_empty_lines` does not exist in 1.6.12 at all.
//
// PURE: data only, no 'vscode'.
import type { LangId } from '../types';

/** One section of the incumbent's file. */
export interface LonefySection {
  /** The Tidy languages whose `[language]` block this section feeds. */
  readonly languages: readonly LangId[];
  /** The keys the incumbent's js-beautify reads for this section (that Tidy can map). */
  readonly honoured: ReadonlySet<string>;
}

/** The sections of the incumbent's file, by name. */
export const LONEFY_SECTIONS: Readonly<Record<string, LonefySection>> = {
  // L49-50 (javascript) and L47-48 (json falls into it).
  javascript: {
    languages: ['javascript', 'json'],
    honoured: new Set([
      'indent_size',
      'brace_style',
      'wrap_line_length',
      'space_after_anon_function',
      'space_before_conditional',
      'jslint_happy',
      'eol',
      'preserve_newlines',
      'max_preserve_newlines',
      'space_in_paren',
      'space_in_empty_paren',
      'break_chained_methods',
      'keep_array_indentation',
      'comma_first',
      'operator_position'
    ])
  },
  // L44-45 (css) and L42-43 (scss falls into it). LESS is not handled at all.
  css: {
    languages: ['css', 'scss'],
    honoured: new Set([
      'indent_size',
      'eol',
      'preserve_newlines',
      'selector_separator_newline',
      'newline_between_rules',
      'space_around_combinator'
    ])
  },
  // L52-53.
  html: {
    languages: ['html'],
    honoured: new Set([
      'indent_size',
      'brace_style',
      'eol',
      'preserve_newlines',
      'max_preserve_newlines',
      'wrap_line_length',
      'wrap_attributes',
      'wrap_attributes_indent_size',
      'indent_inner_html',
      'indent_scripts'
    ])
  }
};

/** Own-property lookup that cannot be fooled by `__proto__` / inherited names. */
export function isLonefySection(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(LONEFY_SECTIONS, name);
}
