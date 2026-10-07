// Fixtures for the pure lonefy -> Tidy mapper (ROADMAP Axe 1, 1.T1).
//
// Each fixture is a *synthetic* raw js-beautify / `.jsbeautifyrc` options object
// paired with the LonefyMappingResult we expect. Pure: no disk, no 'vscode'.
// These encode the ROADMAP acceptance cases:
//   `.jsbeautifyrc {indent_size:2, brace_style:"expand", foo:1}`
//      -> settings={tidy.indent:2, tidy.brace_style:'expand'}, unmapped=['foo']
//   out-of-enum value -> warnings, never written
//   non-object input  -> {settings:{}, ...} without throwing
import type { LonefyMappingResult } from '../../src/migration/types';

export interface MigrationFixture {
  id: string;
  desc: string;
  ref: string;
  /** Raw input passed to mapLonefyOptions (deliberately `unknown`). */
  raw: unknown;
  expect: {
    /** Exact settings map expected (compared with deepEqual). */
    settings: Record<string, unknown>;
    /** Exact unmapped key list expected (order-insensitive in the test). */
    unmapped: string[];
    /**
     * Number of warnings expected. We assert the count plus substrings (below)
     * rather than full strings so message wording can evolve without churn.
     */
    warningCount: number;
    /** Substrings each expected warning collectively must contain. */
    warningIncludes?: string[];
  };
}

export const migrationFixtures: MigrationFixture[] = [
  {
    id: 'MIG-ROADMAP-CANONICAL',
    desc: 'ROADMAP example: indent_size+brace_style mapped, foo unmapped',
    ref: '1.T1 acceptance',
    raw: { indent_size: 2, brace_style: 'expand', foo: 1 },
    expect: {
      settings: { 'tidy.indent': 2, 'tidy.brace_style': 'expand' },
      unmapped: ['foo'],
      warningCount: 0
    }
  },
  {
    id: 'MIG-ALL-KEYS',
    desc: 'every recognised key maps to its tidy.* counterpart',
    ref: '1.T1 / package.json tidy.* surface',
    raw: {
      indent_size: 8,
      brace_style: 'collapse-preserve-inline',
      wrap_line_length: 120,
      wrap_attributes: 'force-aligned',
      space_after_anon_function: true
    },
    expect: {
      settings: {
        'tidy.indent': 8,
        'tidy.brace_style': 'collapse-preserve-inline',
        'tidy.wrap_line_length': 120,
        'tidy.wrap_attributes': 'force-aligned',
        'tidy.space_after_anon_function': true
      },
      unmapped: [],
      warningCount: 0
    }
  },
  {
    id: 'MIG-INDENT-STRING',
    desc: 'a numeric-string indent_size is coerced to an integer',
    ref: '1.T1 / .jsbeautifyrc values may be strings',
    raw: { indent_size: '4' },
    expect: {
      settings: { 'tidy.indent': 4 },
      unmapped: [],
      warningCount: 0
    }
  },
  {
    id: 'MIG-INDENT-ZERO-OUT-OF-RANGE',
    desc: 'indent_size=0 is below the [1,16] domain -> warning, not written',
    ref: '1.T1 / out-of-domain dropped',
    raw: { indent_size: 0 },
    expect: {
      settings: {},
      unmapped: [],
      warningCount: 1,
      warningIncludes: ['indent_size']
    }
  },
  {
    id: 'MIG-INDENT-TOO-LARGE',
    desc: 'indent_size=32 is above the [1,16] domain -> warning, not written',
    ref: '1.T1 / out-of-domain dropped',
    raw: { indent_size: 32 },
    expect: {
      settings: {},
      unmapped: [],
      warningCount: 1,
      warningIncludes: ['indent_size']
    }
  },
  {
    id: 'MIG-INDENT-NON-INTEGER',
    desc: 'a non-integer indent_size=2.5 is rejected -> warning',
    ref: '1.T1 / integer validation',
    raw: { indent_size: 2.5 },
    expect: {
      settings: {},
      unmapped: [],
      warningCount: 1,
      warningIncludes: ['indent_size']
    }
  },
  {
    id: 'MIG-BRACE-STYLE-OUT-OF-ENUM',
    desc: 'an out-of-enum brace_style is warned and never written',
    ref: '1.T1 acceptance (value out of enum -> warnings)',
    raw: { brace_style: 'banana' },
    expect: {
      settings: {},
      unmapped: [],
      warningCount: 1,
      warningIncludes: ['brace_style']
    }
  },
  {
    id: 'MIG-BRACE-STYLE-ALL-VALID',
    desc: 'each valid brace_style enum value is accepted',
    ref: '1.T1 / brace_style enum parity with package.json',
    raw: { brace_style: 'end-expand' },
    expect: {
      settings: { 'tidy.brace_style': 'end-expand' },
      unmapped: [],
      warningCount: 0
    }
  },
  {
    id: 'MIG-WRAP-LINE-ZERO-OK',
    desc: 'wrap_line_length=0 is in-domain (disables wrapping) and mapped',
    ref: '1.T1 / wrap_line_length >= 0',
    raw: { wrap_line_length: 0 },
    expect: {
      settings: { 'tidy.wrap_line_length': 0 },
      unmapped: [],
      warningCount: 0
    }
  },
  {
    id: 'MIG-WRAP-LINE-NEGATIVE',
    desc: 'a negative wrap_line_length is rejected -> warning',
    ref: '1.T1 / wrap_line_length non-negative',
    raw: { wrap_line_length: -5 },
    expect: {
      settings: {},
      unmapped: [],
      warningCount: 1,
      warningIncludes: ['wrap_line_length']
    }
  },
  {
    id: 'MIG-WRAP-ATTRIBUTES-OUT-OF-ENUM',
    desc: 'an out-of-enum wrap_attributes is warned, never written',
    ref: '1.T1 / wrap_attributes enum',
    raw: { wrap_attributes: 'sideways' },
    expect: {
      settings: {},
      unmapped: [],
      warningCount: 1,
      warningIncludes: ['wrap_attributes']
    }
  },
  {
    id: 'MIG-SPACE-AFTER-ANON-FALSE',
    desc: 'space_after_anon_function=false is a valid boolean and mapped',
    ref: '1.T1 / boolean validation',
    raw: { space_after_anon_function: false },
    expect: {
      settings: { 'tidy.space_after_anon_function': false },
      unmapped: [],
      warningCount: 0
    }
  },
  {
    id: 'MIG-SPACE-AFTER-ANON-STRING',
    desc: 'a "true" string for the boolean option is coerced',
    ref: '1.T1 / .jsbeautifyrc string booleans',
    raw: { space_after_anon_function: 'true' },
    expect: {
      settings: { 'tidy.space_after_anon_function': true },
      unmapped: [],
      warningCount: 0
    }
  },
  {
    id: 'MIG-SPACE-AFTER-ANON-NON-BOOL',
    desc: 'a non-boolean for the boolean option is rejected -> warning',
    ref: '1.T1 / boolean validation',
    raw: { space_after_anon_function: 1 },
    expect: {
      settings: {},
      unmapped: [],
      warningCount: 1,
      warningIncludes: ['space_after_anon_function']
    }
  },
  {
    id: 'MIG-SPACE-AFTER-ANON-STRING-FALSE',
    desc: 'a "false" string for the boolean option is coerced to false',
    ref: '1.T1 / .jsbeautifyrc string booleans',
    raw: { space_after_anon_function: 'false' },
    expect: {
      settings: { 'tidy.space_after_anon_function': false },
      unmapped: [],
      warningCount: 0
    }
  },
  {
    id: 'MIG-BRACE-STYLE-OBJECT-VALUE',
    desc: 'an object value for a recognised key is described safely in the warning',
    ref: '1.T1 / safe value rendering',
    raw: { brace_style: { nested: true } },
    expect: {
      settings: {},
      unmapped: [],
      warningCount: 1,
      warningIncludes: ['brace_style', 'an object']
    }
  },
  {
    id: 'MIG-INDENT-ARRAY-VALUE',
    desc: 'an array value for a recognised key is described safely in the warning',
    ref: '1.T1 / safe value rendering',
    raw: { indent_size: [2] },
    expect: {
      settings: {},
      unmapped: [],
      warningCount: 1,
      warningIncludes: ['indent_size', 'an array']
    }
  },
  {
    id: 'MIG-MULTIPLE-UNMAPPED',
    desc: 'several keys with no Tidy equivalent are all surfaced in unmapped',
    ref: '1.T1 / unknown keys surfaced',
    // v0.5.0: eol and preserve_newlines have exact Tidy settings now (see the
    // fixtures below); these four have none. The shape is kept, the keys changed.
    raw: { indent_size: 2, indent_char: ' ', end_with_newline: false, unescape_strings: false, e4x: false },
    expect: {
      settings: { 'tidy.indent': 2 },
      unmapped: ['indent_char', 'end_with_newline', 'unescape_strings', 'e4x'],
      warningCount: 0
    }
  },
  // --- v0.5.0: the vocabulary widened to EXACT equivalents ---------------------
  // Each value below is the incumbent's own default (the README screenshot shape),
  // except where a non-default value is needed to show the mapping is not vacuous.
  {
    id: 'MIG-NEWLINES-DEFAULT',
    desc: 'the incumbent default preserve_newlines + max_preserve_newlines (0 = unlimited in js-beautify JS)',
    ref: '0.5.0 / same option name, same domain',
    raw: { preserve_newlines: true, max_preserve_newlines: 0 },
    expect: {
      settings: { 'tidy.preserve_newlines': true, 'tidy.max_preserve_newlines': 0 },
      unmapped: [],
      warningCount: 0
    }
  },
  {
    id: 'MIG-JS-SPACING-DEFAULTS',
    desc: 'the incumbent default JavaScript toggles all map to their tidy.* namesakes',
    ref: '0.5.0 / same option name, same domain',
    raw: {
      space_in_paren: false,
      space_in_empty_paren: false,
      break_chained_methods: false,
      keep_array_indentation: false,
      comma_first: false
    },
    expect: {
      settings: {
        'tidy.space_in_paren': false,
        'tidy.space_in_empty_paren': false,
        'tidy.break_chained_methods': false,
        'tidy.keep_array_indentation': false,
        'tidy.comma_first': false
      },
      unmapped: [],
      warningCount: 0
    }
  },
  {
    id: 'MIG-JS-JSLINT-CONDITIONAL',
    desc: 'the incumbent default jslint_happy (false) and space_before_conditional (true)',
    ref: '0.5.0 / same option name, same domain',
    raw: { jslint_happy: false, space_before_conditional: true },
    expect: {
      settings: { 'tidy.jslint_happy': false, 'tidy.space_before_conditional': true },
      unmapped: [],
      warningCount: 0
    }
  },
  {
    id: 'MIG-JSLINT-NON-BOOL',
    desc: 'a non-boolean jslint_happy is rejected -> warning',
    ref: '0.5.0 / boolean validation',
    raw: { jslint_happy: 1 },
    expect: {
      settings: {},
      unmapped: [],
      warningCount: 1,
      warningIncludes: ['jslint_happy']
    }
  },
  {
    id: 'MIG-CSS-KEYS',
    desc: 'the CSS family keys: newline_between_rules (incumbent default) and the real selector_separator_newline spelling',
    ref: '0.5.0 / same option name, same domain',
    raw: { newline_between_rules: true, selector_separator_newline: false, space_around_combinator: true },
    expect: {
      settings: {
        'tidy.newline_between_rules': true,
        'tidy.selector_separator_newline': false,
        'tidy.space_around_combinator': true
      },
      unmapped: [],
      warningCount: 0
    }
  },
  {
    id: 'MIG-HTML-KEYS',
    desc: 'the HTML keys: indent_inner_html (incumbent default), indent_scripts, wrap_attributes_indent_size',
    ref: '0.5.0 / same option name, same domain',
    raw: { indent_inner_html: false, indent_scripts: 'separate', wrap_attributes_indent_size: 0 },
    expect: {
      settings: {
        'tidy.indent_inner_html': false,
        'tidy.indent_scripts': 'separate',
        'tidy.wrap_attributes_indent_size': 0
      },
      unmapped: [],
      warningCount: 0
    }
  },
  {
    id: 'MIG-OPERATOR-POSITION',
    desc: 'operator_position maps with its js-beautify values',
    ref: '0.5.0 / enum parity with package.json',
    raw: { operator_position: 'after-newline' },
    expect: {
      settings: { 'tidy.operator_position': 'after-newline' },
      unmapped: [],
      warningCount: 0
    }
  },
  {
    id: 'MIG-OPERATOR-POSITION-BAD',
    desc: 'an out-of-enum operator_position is warned, never written',
    ref: '0.5.0 / enum parity with package.json',
    raw: { operator_position: 'sideways' },
    expect: {
      settings: {},
      unmapped: [],
      warningCount: 1,
      warningIncludes: ['operator_position']
    }
  },
  {
    id: 'MIG-INDENT-SCRIPTS-BAD',
    desc: 'an out-of-enum indent_scripts is warned, never written',
    ref: '0.5.0 / enum parity with package.json',
    raw: { indent_scripts: 'all' },
    expect: {
      settings: {},
      unmapped: [],
      warningCount: 1,
      warningIncludes: ['indent_scripts']
    }
  },
  {
    id: 'MIG-MAX-PRESERVE-NEGATIVE',
    desc: 'a negative max_preserve_newlines is out of domain -> warning',
    ref: '0.5.0 / non-negative integer',
    raw: { max_preserve_newlines: -1 },
    expect: {
      settings: {},
      unmapped: [],
      warningCount: 1,
      warningIncludes: ['max_preserve_newlines']
    }
  },
  {
    id: 'MIG-MAX-PRESERVE-STRING',
    desc: 'a numeric-string max_preserve_newlines is parsed like js-beautify does',
    ref: '0.5.0 / parseInt semantics',
    raw: { max_preserve_newlines: '3' },
    expect: {
      settings: { 'tidy.max_preserve_newlines': 3 },
      unmapped: [],
      warningCount: 0
    }
  },
  {
    id: 'MIG-BOOLEAN-FLAT-STRING',
    desc: 'the flat (.jsbeautifyrc) path still reads the string "false" as false',
    ref: '1.T1 / .jsbeautifyrc string booleans kept',
    raw: { comma_first: 'false' },
    expect: {
      settings: { 'tidy.comma_first': false },
      unmapped: [],
      warningCount: 0
    }
  },
  // --- eol: only the two real line endings map; "auto" has no Tidy value -------
  {
    id: 'MIG-EOL-LF',
    desc: 'eol "\\n" (the incumbent css default) is exactly tidy.end_of_line lf',
    ref: '0.5.0 / eol exact values',
    raw: { eol: '\n' },
    expect: { settings: { 'tidy.end_of_line': 'lf' }, unmapped: [], warningCount: 0 }
  },
  {
    id: 'MIG-EOL-CRLF',
    desc: 'eol "\\r\\n" is exactly tidy.end_of_line crlf',
    ref: '0.5.0 / eol exact values',
    raw: { eol: '\r\n' },
    expect: { settings: { 'tidy.end_of_line': 'crlf' }, unmapped: [], warningCount: 0 }
  },
  {
    id: 'MIG-EOL-ESCAPED',
    desc: 'the two-character escaped spellings js-beautify itself converts map the same',
    ref: '0.5.0 / eol exact values',
    raw: { eol: '\\n' },
    expect: { settings: { 'tidy.end_of_line': 'lf' }, unmapped: [], warningCount: 0 }
  },
  {
    id: 'MIG-EOL-AUTO',
    desc: 'eol "auto" (the incumbent JavaScript default) has no tidy.end_of_line value: reported, not guessed',
    ref: '0.5.0 / no exact equivalent stays unmapped',
    raw: { eol: 'auto' },
    expect: { settings: {}, unmapped: ['eol'], warningCount: 0 }
  },
  {
    id: 'MIG-EOL-BAD',
    desc: 'any other eol (a bare CR, lf, a number) is out of domain -> warning',
    ref: '0.5.0 / eol exact values',
    raw: { eol: '\r' },
    expect: { settings: {}, unmapped: [], warningCount: 1, warningIncludes: ['eol'] }
  },
  // --- spellings the incumbent ignored: NOT mapped ------------------------------
  {
    id: 'MIG-CAMELCASE-IGNORED',
    desc: 'indentCharacter / selectorSeparatorNewLine / indent_character are not js-beautify options: reported, not imported',
    ref: '0.5.0 / not a js-beautify option name',
    raw: { indentCharacter: ' ', selectorSeparatorNewLine: false, indent_character: ' ' },
    expect: {
      settings: {},
      unmapped: ['indentCharacter', 'selectorSeparatorNewLine', 'indent_character'],
      warningCount: 0
    }
  },
  {
    id: 'MIG-MIXED-WARN-AND-UNMAPPED',
    desc: 'a bad recognised value warns AND an unknown key is unmapped',
    ref: '1.T1 / orthogonal channels',
    raw: { brace_style: 999, mystery: true },
    expect: {
      settings: {},
      unmapped: ['mystery'],
      warningCount: 1,
      warningIncludes: ['brace_style']
    }
  },
  {
    id: 'MIG-EMPTY-OBJECT',
    desc: 'an empty object maps to an empty result without warnings',
    ref: '1.T1 / no-op input',
    raw: {},
    expect: {
      settings: {},
      unmapped: [],
      warningCount: 0
    }
  }
];

/**
 * Non-object inputs that must NOT throw and must yield an empty mapping plus a
 * single explanatory warning (ROADMAP: "entrée non-objet -> {settings:{},…}").
 */
export const nonObjectInputs: { id: string; raw: unknown }[] = [
  { id: 'null', raw: null },
  { id: 'undefined', raw: undefined },
  { id: 'string', raw: 'indent_size = 2' },
  { id: 'number', raw: 42 },
  { id: 'boolean', raw: true },
  { id: 'array', raw: [{ indent_size: 2 }] }
];

/** Expected shape for a non-object input, reused across assertions. */
export const emptyMappingForNonObject: Omit<LonefyMappingResult, 'warnings'> = {
  settings: {},
  unmapped: []
};
