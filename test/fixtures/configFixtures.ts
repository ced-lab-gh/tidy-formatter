// Config-resolution fixtures (SPEC CFG-01/CFG-02): resolveOptions honours
// tabSize/insertSpaces, deep-merges layers general->specific, and records the
// source of every winning key in `sources` (for "Show effective configuration").
//
// Source: spec.json P1-config-respect, #3,#31,#57,#73,#85,#100,#134.
import type { LangId } from '../../src/types';
import type { ConfigLayer } from '../../src/config/resolver';

export interface ConfigFixture {
  id: string;
  desc: string;
  ref: string;
  languageId: LangId;
  layers: ConfigLayer[];
  expect: {
    tabSize?: number;
    insertSpaces?: boolean;
    endOfLine?: 'lf' | 'crlf';
    insertFinalNewline?: boolean;
    trimTrailingWhitespace?: boolean;
    /** Expected origin string per resolved key. */
    sources?: Record<string, string>;
    /** Expected engineOptions key/value subset. */
    engineOptions?: Record<string, unknown>;
  };
}

export const configFixtures: ConfigFixture[] = [
  {
    id: 'CFG-DEFAULTS',
    desc: 'with no layers, builtin defaults (4 spaces) govern and are sourced',
    ref: 'CFG-01 fallback',
    languageId: 'css',
    layers: [],
    expect: {
      tabSize: 4,
      insertSpaces: true,
      sources: { tabSize: 'builtin defaults', insertSpaces: 'builtin defaults' }
    }
  },
  {
    id: 'CFG-VSCODE-TABSIZE',
    desc: 'VS Code FormattingOptions tabSize=2/insertSpaces=true is honoured',
    ref: 'CFG-01 / #57,#73,#85,#100',
    languageId: 'javascript',
    layers: [{ source: 'vscode settings', values: { tabSize: 2, insertSpaces: true } }],
    expect: {
      tabSize: 2,
      insertSpaces: true,
      sources: { tabSize: 'vscode settings', insertSpaces: 'vscode settings' }
    }
  },
  {
    id: 'CFG-EDITORCONFIG-OVERRIDES-VSCODE',
    desc: '.editorconfig indent_size=2 overrides vscode tabSize=4 (team config wins, deep merge)',
    ref: 'CFG-02 precedence / SPEC §6 "config d\'équipe gagne"',
    languageId: 'css',
    layers: [
      { source: 'vscode settings', values: { tabSize: 4, insertSpaces: true } },
      { source: '.editorconfig', values: { indent_size: 2 } }
    ],
    expect: {
      tabSize: 2,
      insertSpaces: true,
      sources: { tabSize: '.editorconfig', insertSpaces: 'vscode settings' }
    }
  },
  {
    id: 'CFG-EDITORCONFIG-TABS',
    desc: '.editorconfig indent_style=tab forces tabs (insertSpaces=false) via inverted alias',
    ref: 'CFG-03 / #31 indent_style',
    languageId: 'css',
    layers: [
      { source: 'vscode settings', values: { insertSpaces: true } },
      { source: '.editorconfig', values: { indent_style: 'tab' } }
    ],
    expect: {
      insertSpaces: false,
      sources: { insertSpaces: '.editorconfig' }
    }
  },
  {
    id: 'CFG-DEEP-MERGE-NO-ERASE',
    desc: 'a higher layer setting only tabSize does not erase a lower layer insertSpaces',
    ref: 'CFG-02 "clé absente n\'efface pas la couche inférieure"',
    languageId: 'css',
    layers: [
      { source: 'vscode settings', values: { tabSize: 4, insertSpaces: false } },
      { source: '.soukformatrc', values: { tabSize: 2 } }
    ],
    expect: {
      tabSize: 2,
      insertSpaces: false,
      sources: { tabSize: '.soukformatrc', insertSpaces: 'vscode settings' }
    }
  },
  {
    id: 'CFG-PER-LANG-CSS-4-OTHERS-2',
    desc: 'project file css:indent_size=4 with editorconfig 2 yields css=4 (the §6 matrix example)',
    ref: 'CFG-02 acceptance: ".editorconfig indent_size=2 + .soukformatrc{css:4} => CSS 4"',
    languageId: 'css',
    layers: [
      { source: '.editorconfig', values: { indent_size: 2 } },
      { source: '.soukformatrc[css]', values: { indent_size: 4 } }
    ],
    expect: {
      tabSize: 4,
      sources: { tabSize: '.soukformatrc[css]' }
    }
  },
  {
    id: 'CFG-EOL-FINAL-NEWLINE',
    desc: '.editorconfig end_of_line=lf + insert_final_newline=true are mapped and sourced',
    ref: 'CFG-03 / #62,#82,#88 final-newline/EOL non-destruction',
    languageId: 'javascript',
    layers: [
      {
        source: '.editorconfig',
        values: { end_of_line: 'lf', insert_final_newline: true, trim_trailing_whitespace: true }
      }
    ],
    expect: {
      endOfLine: 'lf',
      insertFinalNewline: true,
      trimTrailingWhitespace: true,
      sources: {
        endOfLine: '.editorconfig',
        insertFinalNewline: '.editorconfig',
        trimTrailingWhitespace: '.editorconfig'
      }
    }
  },
  {
    id: 'CFG-ENGINE-OPTIONS-PASSTHROUGH',
    desc: 'unknown keys (brace_style, wrap_line_length) flow to engineOptions with their source',
    ref: 'ENG-04 js-beautify configurability',
    languageId: 'javascript',
    layers: [
      { source: 'vscode settings', values: { brace_style: 'expand', wrap_line_length: 80 } }
    ],
    expect: {
      engineOptions: { brace_style: 'expand', wrap_line_length: 80 },
      sources: { brace_style: 'vscode settings', wrap_line_length: 'vscode settings' }
    }
  },
  {
    id: 'CFG-MALFORMED-LAYER-IGNORED',
    desc: 'a malformed layer (null values) is skipped, lower layers still govern',
    ref: 'CFG-06 non-blocking fallback',
    languageId: 'css',
    layers: [
      { source: 'vscode settings', values: { tabSize: 3 } },
      { source: 'bad layer', values: null as unknown as Record<string, unknown> }
    ],
    expect: {
      tabSize: 3,
      sources: { tabSize: 'vscode settings' }
    }
  },
  {
    id: 'CFG-COERCE-STRING-TABSIZE',
    desc: 'a string indent_size="2" from a config file is coerced to the number 2',
    ref: 'CFG-03 editorconfig values are strings',
    languageId: 'css',
    layers: [{ source: '.editorconfig', values: { indent_size: '2' } }],
    expect: {
      tabSize: 2,
      sources: { tabSize: '.editorconfig' }
    }
  }
];
