// Shared contracts for the Tidy Formatter extension.
// Every engine/*, safety/*, and pure config module respects these to the letter.
// This file must NOT import 'vscode' so it stays testable outside the Electron host.

export type LangId =
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

export interface ResolvedOptions {
  tabSize: number;
  insertSpaces: boolean;
  endOfLine?: 'lf' | 'crlf';
  trimTrailingWhitespace?: boolean;
  insertFinalNewline?: boolean;
  engineOptions: Record<string, unknown>;
  sources: Record<string, string>;
}

export interface FormatRequest {
  languageId: LangId;
  code: string;
  options: ResolvedOptions;
  range?: { startOffset: number; endOffset: number };
}

export interface Engine {
  id: string;
  supports(lang: LangId): boolean;
  format(req: FormatRequest): Promise<string>; // throws on engine error
}

export interface GuardVerdict {
  equivalent: boolean;
  reason?: string;
}

export interface Guard {
  // semantic-equivalence-modulo-whitespace
  check(lang: LangId, input: string, output: string): GuardVerdict;
}

export interface FormatOutcome {
  applied: boolean;
  output?: string;
  aborted?: boolean;
  reason?: string;
  engineId?: string;
}
