// The vocabulary of the key mapper: which js-beautify key becomes which `tidy.*`
// setting, and in what value domain (v0.5.0, MIGRATION).
//
// THE RULE, decided by the conductor: a key is mapped IF AND ONLY IF an existing
// `tidy.*` setting has the SAME semantics and the SAME value domain. A key with no
// exact equivalent is NOT mapped and is reported as "not carried over". Leaving a
// real preference behind when Tidy has a setting that means the same thing would
// defeat the migration; inventing an approximate one would change the user's output
// on the strength of a guess.
//
// KEYS THAT ARE MAPPED, and why each is exact (js-beautify is the engine on both
// sides: the incumbent passes a section straight to `js-beautify` ^1.6.4, Tidy
// passes its `tidy.*` value to `js-beautify` for the same option name):
//   indent_size -> tidy.indent                  brace_style -> tidy.brace_style
//   wrap_line_length, wrap_attributes, space_after_anon_function (shipped since v0.1)
//   preserve_newlines, max_preserve_newlines    same option name, same domain
//   space_in_paren, space_in_empty_paren, break_chained_methods,
//   keep_array_indentation, comma_first, operator_position,
//   space_before_conditional, jslint_happy                      (JavaScript)
//   selector_separator_newline, newline_between_rules,
//   space_around_combinator                                     (CSS family)
//   indent_inner_html, indent_scripts, wrap_attributes_indent_size (HTML)
//   eol -> tidy.end_of_line, for the two real line endings only (see below).
//
// One corner of one mapped key is not byte-identical across js-beautify versions, and
// is stated rather than hidden: with `space_before_conditional: false`, js-beautify
// 1.6.12 also printed `catch(e)` (its code path covers `catch`), while 1.15.4, which
// Tidy ships, keeps `catch (e)` and applies the option to if, for, while and switch
// only (measured on both sides). The option, its meaning and its domain are the
// same; only that whitespace in a `catch` clause differs.
//
// KEYS THAT ARE NOT MAPPED, and why (each stays in "Not carried over"):
//   indent_char, indentCharacter, indent_character
//       No `tidy.*` setting: Tidy takes the indent character from the editor
//       (insertSpaces / tabSize). The camelCase and `indent_character` spellings are
//       not option names js-beautify reads at all (verified against v1.6.12 and the
//       installed 1.15.4), so the incumbent ignored them.
//   selectorSeparatorNewLine
//       Not a js-beautify option name (the real one is `selector_separator_newline`,
//       which IS mapped). The incumbent ignored the camelCase spelling, so importing
//       it would create a preference the user never actually had.
//   end_with_newline
//       Tidy's final-newline policy comes from `files.insertFinalNewline` and
//       `.editorconfig`, not from a `tidy.*` setting. Writing an editor-core key is
//       outside what the migration may write.
//   unescape_strings, e4x
//       No `tidy.*` setting exists for them.
//   content_unformatted, void_elements
//       Tidy's settings of these names are ADDITIVE (extra tags on top of a fixed
//       list); js-beautify's `content_unformatted` REPLACES its default list, and
//       `void_elements` does not exist in js-beautify 1.6.12 at all. Not the same
//       meaning, so neither is mapped (they are reported as unknown keys).
//   eol = "auto"
//       `tidy.end_of_line` has no `auto` value. (Tidy already keeps each file's own
//       line endings when nothing is set, which is what `auto` meant.)
//
// `eol` needs a special word, because it touches line endings. Its two real values
// map exactly: "\n" is `lf` and "\r\n" is `crlf` (js-beautify also accepts the
// two-character escaped spellings, which it converts itself, so they map the same).
// What stays different, and is the same for EVERY `tidy.*` setting, is precedence:
// `tidy.end_of_line` is the lowest layer, so an explicit `files.eol` or
// `.editorconfig` value wins over it, where the incumbent's `eol` was absolute.
//
// PURE: no 'vscode', no I/O. The domains below are checked against package.json
// by a unit test, so a change to a setting's enum or range cannot drift silently.

/** The value domain of one mapped key. */
export type KeyDomain =
  | { readonly type: 'boolean' }
  | { readonly type: 'integer'; readonly min: number; readonly max?: number }
  | { readonly type: 'enum'; readonly values: readonly string[] }
  | { readonly type: 'eol' };

/** One mapped key: the `tidy.*` setting it becomes and the domain it is checked in. */
export interface KeySpec {
  readonly tidyKey: string;
  readonly domain: KeyDomain;
}

/** What coercing one raw value produced. */
export type Coerced =
  /** A value in the domain, ready to write. */
  | { readonly kind: 'value'; readonly value: unknown }
  /** A legitimate incumbent value that Tidy cannot express (for example `eol: "auto"`). */
  | { readonly kind: 'no-equivalent' }
  /** Out of domain: reported, never written. `expected` completes the warning. */
  | { readonly kind: 'invalid'; readonly expected: string };

/** How strictly values are read. */
export interface CoerceContext {
  /**
   * Whether the strings "true" / "false" count as booleans. A `.jsbeautifyrc` (read
   * by several tools) may carry them, so they are accepted there. In the
   * incumbent's own file they are NOT: it hands the value to js-beautify, where any
   * non-empty string is truthy, so `"false"` means TRUE there. Importing it as
   * false would invert the user's actual behaviour, so it is reported instead.
   */
  readonly stringBooleans: boolean;
}

const BRACE_STYLES = [
  'collapse',
  'expand',
  'end-expand',
  'none',
  'collapse-preserve-inline'
] as const;

const WRAP_ATTRIBUTES = [
  'auto',
  'force',
  'force-aligned',
  'force-expand-multiline',
  'aligned-multiple',
  'preserve',
  'preserve-aligned'
] as const;

const OPERATOR_POSITIONS = ['before-newline', 'after-newline', 'preserve-newline'] as const;

const INDENT_SCRIPTS = ['keep', 'separate', 'normal'] as const;

const BOOLEAN: KeyDomain = { type: 'boolean' };
const NON_NEGATIVE: KeyDomain = { type: 'integer', min: 0 };

/** js-beautify key -> Tidy setting. The single table the mapper reads. */
export const LONEFY_KEYS: Readonly<Record<string, KeySpec>> = {
  indent_size: { tidyKey: 'tidy.indent', domain: { type: 'integer', min: 1, max: 16 } },
  brace_style: { tidyKey: 'tidy.brace_style', domain: { type: 'enum', values: BRACE_STYLES } },
  wrap_line_length: { tidyKey: 'tidy.wrap_line_length', domain: NON_NEGATIVE },
  wrap_attributes: { tidyKey: 'tidy.wrap_attributes', domain: { type: 'enum', values: WRAP_ATTRIBUTES } },
  space_after_anon_function: { tidyKey: 'tidy.space_after_anon_function', domain: BOOLEAN },
  space_before_conditional: { tidyKey: 'tidy.space_before_conditional', domain: BOOLEAN },
  jslint_happy: { tidyKey: 'tidy.jslint_happy', domain: BOOLEAN },
  eol: { tidyKey: 'tidy.end_of_line', domain: { type: 'eol' } },
  preserve_newlines: { tidyKey: 'tidy.preserve_newlines', domain: BOOLEAN },
  max_preserve_newlines: { tidyKey: 'tidy.max_preserve_newlines', domain: NON_NEGATIVE },
  space_in_paren: { tidyKey: 'tidy.space_in_paren', domain: BOOLEAN },
  space_in_empty_paren: { tidyKey: 'tidy.space_in_empty_paren', domain: BOOLEAN },
  break_chained_methods: { tidyKey: 'tidy.break_chained_methods', domain: BOOLEAN },
  keep_array_indentation: { tidyKey: 'tidy.keep_array_indentation', domain: BOOLEAN },
  comma_first: { tidyKey: 'tidy.comma_first', domain: BOOLEAN },
  operator_position: {
    tidyKey: 'tidy.operator_position',
    domain: { type: 'enum', values: OPERATOR_POSITIONS }
  },
  selector_separator_newline: { tidyKey: 'tidy.selector_separator_newline', domain: BOOLEAN },
  newline_between_rules: { tidyKey: 'tidy.newline_between_rules', domain: BOOLEAN },
  space_around_combinator: { tidyKey: 'tidy.space_around_combinator', domain: BOOLEAN },
  indent_inner_html: { tidyKey: 'tidy.indent_inner_html', domain: BOOLEAN },
  indent_scripts: { tidyKey: 'tidy.indent_scripts', domain: { type: 'enum', values: INDENT_SCRIPTS } },
  wrap_attributes_indent_size: { tidyKey: 'tidy.wrap_attributes_indent_size', domain: NON_NEGATIVE }
};

/** Own-property lookup that cannot be fooled by `__proto__` / inherited names. */
export function isMappedKey(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(LONEFY_KEYS, key);
}

/** The incumbent key a `tidy.*` setting is imported from, for messages. */
export function lonefyKeyOfTidy(tidyKey: string): string | undefined {
  return Object.keys(LONEFY_KEYS).find((key) => LONEFY_KEYS[key].tidyKey === tidyKey);
}

/**
 * Coerce a js-beautify numeric option to an integer. js-beautify parses with
 * `parseInt`, so a real number and a numeric string are both accepted; only genuine
 * integers are. Anything else is undefined so a malformed value is reported.
 */
function coerceInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim());
    if (Number.isInteger(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

/** Coerce a boolean option; see {@link CoerceContext.stringBooleans} for strings. */
function coerceBoolean(value: unknown, context: CoerceContext): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }
  if (context.stringBooleans && typeof value === 'string') {
    const lower = value.trim().toLowerCase();
    if (lower === 'true') {
      return true;
    }
    if (lower === 'false') {
      return false;
    }
  }
  return undefined;
}

const EOL_EXPECTED = 'a line ending ("\\n" or "\\r\\n") or "auto"';

/** Coerce an `eol` value: the two real line endings, or `auto`, which has no equivalent. */
function coerceEol(value: unknown): Coerced {
  if (value === '\n' || value === '\\n') {
    return { kind: 'value', value: 'lf' };
  }
  if (value === '\r\n' || value === '\\r\\n') {
    return { kind: 'value', value: 'crlf' };
  }
  if (value === 'auto') {
    return { kind: 'no-equivalent' };
  }
  return { kind: 'invalid', expected: EOL_EXPECTED };
}

/** Render an enum for a warning: a stable, quoted, comma-separated list. */
function listEnum(values: readonly string[]): string {
  return values.map((v) => `'${v}'`).join(', ');
}

/** What a warning says a value should have been, per domain. */
function expectedOf(domain: KeyDomain): string {
  switch (domain.type) {
    case 'boolean':
      return 'a boolean';
    case 'integer':
      if (domain.max !== undefined) {
        return `an integer in [${domain.min}, ${domain.max}]`;
      }
      return domain.min === 0 ? 'a non-negative integer' : `an integer >= ${domain.min}`;
    case 'enum':
      return `one of ${listEnum(domain.values)}`;
    case 'eol':
      return EOL_EXPECTED;
  }
}

/**
 * Coerce one raw value into its key's domain. PURE, never throws.
 *
 * `undefined` is never a value, so an absent key is never written; a value outside
 * the domain is `invalid` (reported), so nothing VS Code would reject is proposed.
 */
export function coerceValue(
  domain: KeyDomain,
  raw: unknown,
  context: CoerceContext
): Coerced {
  const invalid: Coerced = { kind: 'invalid', expected: expectedOf(domain) };
  switch (domain.type) {
    case 'boolean': {
      const value = coerceBoolean(raw, context);
      return value === undefined ? invalid : { kind: 'value', value };
    }
    case 'integer': {
      const value = coerceInteger(raw);
      const inRange =
        value !== undefined &&
        value >= domain.min &&
        (domain.max === undefined || value <= domain.max);
      return inRange ? { kind: 'value', value } : invalid;
    }
    case 'enum':
      return typeof raw === 'string' && domain.values.includes(raw)
        ? { kind: 'value', value: raw }
        : invalid;
    case 'eol':
      return coerceEol(raw);
  }
}
