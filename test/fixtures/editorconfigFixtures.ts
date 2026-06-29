// .editorconfig mapping fixtures (SPEC CFG-03, #31,#34,#62,#88).
//
// Each fixture is a *synthetic* resolved EditorConfig property set (as the
// `editorconfig` package would return after walking the cascade) paired with the
// canonical ResolvedOptions we expect once the pure mapper feeds the resolver.
// Pure: no disk, no 'vscode'. Verifies the mapping AND the `sources` attribution
// (every winning key must be sourced to '.editorconfig').
import type { Props } from 'editorconfig';

export interface EditorConfigFixture {
  id: string;
  desc: string;
  ref: string;
  /** Resolved EditorConfig props for a single file (post-cascade). */
  props: Props;
  expect: {
    tabSize?: number;
    insertSpaces?: boolean;
    endOfLine?: 'lf' | 'crlf';
    insertFinalNewline?: boolean;
    trimTrailingWhitespace?: boolean;
    engineOptions?: Record<string, unknown>;
    /** Origin string expected per resolved key (should be '.editorconfig'). */
    sources?: Record<string, string>;
    /** Keys that must NOT appear as a resolved/typed value or engine option. */
    absentEngineOptions?: string[];
  };
}

export const editorConfigFixtures: EditorConfigFixture[] = [
  {
    id: 'EC-INDENT-STYLE-TAB',
    desc: 'indent_style=tab maps to insertSpaces=false (inverted)',
    ref: 'CFG-03 / #31',
    props: { indent_style: 'tab' },
    expect: {
      insertSpaces: false,
      sources: { insertSpaces: '.editorconfig' }
    }
  },
  {
    id: 'EC-INDENT-STYLE-SPACE',
    desc: 'indent_style=space maps to insertSpaces=true',
    ref: 'CFG-03 / #31',
    props: { indent_style: 'space', indent_size: 2 },
    expect: {
      insertSpaces: true,
      tabSize: 2,
      sources: { insertSpaces: '.editorconfig', tabSize: '.editorconfig' }
    }
  },
  {
    id: 'EC-INDENT-SIZE',
    desc: 'indent_size=2 maps to tabSize=2',
    ref: 'CFG-03 / #34',
    props: { indent_size: 2 },
    expect: { tabSize: 2, sources: { tabSize: '.editorconfig' } }
  },
  {
    id: 'EC-INDENT-SIZE-STRING',
    desc: 'a string indent_size="8" is coerced to 8 (EditorConfig values are strings)',
    ref: 'CFG-03 / #34',
    props: { indent_size: '8' as unknown as number },
    expect: { tabSize: 8, sources: { tabSize: '.editorconfig' } }
  },
  {
    id: 'EC-INDENT-SIZE-TAB-FALLS-BACK-TO-TAB-WIDTH',
    desc: 'indent_size=tab uses tab_width for tabSize and still forces tabs',
    ref: 'CFG-03 / #31,#34 (indent_size=tab sentinel)',
    props: { indent_style: 'tab', indent_size: 'tab', tab_width: 4 },
    expect: {
      insertSpaces: false,
      tabSize: 4,
      sources: { insertSpaces: '.editorconfig', tabSize: '.editorconfig' }
    }
  },
  {
    id: 'EC-INDENT-SIZE-WINS-OVER-TAB-WIDTH',
    desc: 'indent_size takes precedence over tab_width for tabSize',
    ref: 'CFG-03 / #34',
    props: { indent_size: 2, tab_width: 8 },
    expect: { tabSize: 2, sources: { tabSize: '.editorconfig' } }
  },
  {
    id: 'EC-TAB-WIDTH-ONLY',
    desc: 'tab_width alone (no indent_size) maps to tabSize',
    ref: 'CFG-03 / #34',
    props: { tab_width: 3 },
    expect: { tabSize: 3, sources: { tabSize: '.editorconfig' } }
  },
  {
    id: 'EC-END-OF-LINE-LF',
    desc: 'end_of_line=lf maps to endOfLine=lf',
    ref: 'CFG-03 / #62,#88 EOL non-destruction',
    props: { end_of_line: 'lf' },
    expect: { endOfLine: 'lf', sources: { endOfLine: '.editorconfig' } }
  },
  {
    id: 'EC-END-OF-LINE-CRLF',
    desc: 'end_of_line=crlf maps to endOfLine=crlf',
    ref: 'CFG-03 / #62,#88',
    props: { end_of_line: 'crlf' },
    expect: { endOfLine: 'crlf', sources: { endOfLine: '.editorconfig' } }
  },
  {
    id: 'EC-INSERT-FINAL-NEWLINE',
    desc: 'insert_final_newline=true maps to insertFinalNewline=true',
    ref: 'CFG-03 / #62,#88 final-newline',
    props: { insert_final_newline: true },
    expect: {
      insertFinalNewline: true,
      sources: { insertFinalNewline: '.editorconfig' }
    }
  },
  {
    id: 'EC-TRIM-TRAILING',
    desc: 'trim_trailing_whitespace=true maps to trimTrailingWhitespace=true',
    ref: 'CFG-03',
    props: { trim_trailing_whitespace: true },
    expect: {
      trimTrailingWhitespace: true,
      sources: { trimTrailingWhitespace: '.editorconfig' }
    }
  },
  {
    id: 'EC-MAX-LINE-LENGTH',
    desc: 'max_line_length=100 maps to engineOptions.wrap_line_length',
    ref: 'CFG-03 max_line_length',
    props: { max_line_length: 100 } as unknown as Props,
    expect: {
      engineOptions: { wrap_line_length: 100 },
      sources: { wrap_line_length: '.editorconfig' }
    }
  },
  {
    id: 'EC-MAX-LINE-LENGTH-OFF-DROPPED',
    desc: 'max_line_length=off is not forwarded (no bad value reaches the engine)',
    ref: 'CFG-03 / fail-soft',
    props: { max_line_length: 'off' } as unknown as Props,
    expect: { absentEngineOptions: ['wrap_line_length'] }
  },
  {
    id: 'EC-CHARSET-SURFACED',
    desc: 'charset is surfaced as an engine option for inspection only',
    ref: 'CFG-03 charset mapping',
    props: { charset: 'utf-8' },
    expect: {
      engineOptions: { charset: 'utf-8' },
      sources: { charset: '.editorconfig' }
    }
  },
  {
    id: 'EC-UNSET-IGNORED',
    desc: "an 'unset' value falls back to lower layers (not forwarded)",
    ref: 'CFG-03 / EditorConfig unset semantics',
    props: { indent_size: 'unset', end_of_line: 'unset' },
    expect: { absentEngineOptions: ['indent_size', 'end_of_line'] }
  },
  {
    id: 'EC-FULL-SET',
    desc: 'a complete [*] block maps every supported key with .editorconfig sources',
    ref: 'CFG-03 / #31,#34,#62,#88',
    props: {
      indent_style: 'space',
      indent_size: 2,
      end_of_line: 'lf',
      insert_final_newline: true,
      trim_trailing_whitespace: true,
      charset: 'utf-8',
      max_line_length: 80
    } as unknown as Props,
    expect: {
      tabSize: 2,
      insertSpaces: true,
      endOfLine: 'lf',
      insertFinalNewline: true,
      trimTrailingWhitespace: true,
      engineOptions: { wrap_line_length: 80, charset: 'utf-8' },
      sources: {
        tabSize: '.editorconfig',
        insertSpaces: '.editorconfig',
        endOfLine: '.editorconfig',
        insertFinalNewline: '.editorconfig',
        trimTrailingWhitespace: '.editorconfig',
        wrap_line_length: '.editorconfig',
        charset: '.editorconfig'
      }
    }
  }
];
