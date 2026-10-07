// Cheap, conservative "could this .js contain JSX?" pre-check (MEDIUM-06, P11).
//
// WHY THIS EXISTS. The dispatcher decides whether a plain .js file is really JSX
// by a full synchronous Babel parse. The regex gate in front of it (`<Identifier`)
// is far too permissive for real code: `a<b` is a comparison and matches it, so a
// 5 MB .js with no JSX at all but a single `a<b` paid 1.9 to 4.8 seconds of parse
// (probe P11), on the extension host's thread, while the editor froze.
//
// WHAT IT DECIDES. JSX can only start where the grammar expects an EXPRESSION.
// `<` after an operand (an identifier, a number, a string, `)`, `]`) is the
// less-than operator, whatever letter follows it. So one linear pass that tracks
// "may an expression start here?" (the same state a JS tokenizer keeps to tell a
// regular expression from a division) answers the question without a parser:
//
//   - a `<` at an expression start                      -> "might be JSX";
//   - every `<` after an operand, no expression start   -> "cannot be JSX".
//
// THE ONE RULE THAT MATTERS: THIS MAY NEVER SAY "NO" FOR A FILE THAT HAS JSX.
// A wrong "no" routes a JSX file to js-beautify, which the guard then rejects
// (fail safe, but a regression). Every uncertainty therefore resolves to "maybe",
// and the caller then runs the same full parse it always ran:
//
//   - anything the scan cannot follow (an unterminated string, template, comment
//     or regular expression, an unbalanced bracket, an HTML-style `<!--` or
//     `-->` comment) answers "maybe";
//   - a `<` on a LATER LINE than the previous token answers "maybe" even after an
//     operand, because automatic semicolon insertion can end a statement there
//     (`import x from 'y'` then a newline then `<div/>`, `let a` then a newline
//     then `<div/>`, `return` then a newline then `<div/>`);
//   - `/` straight after `of`, `yield` or `await` answers "maybe": those words
//     are keywords or ordinary names, and which one decides whether the `/`
//     starts a regular expression that could hide a `<`;
//   - `}` is treated as the end of a BLOCK (an expression may start after it),
//     the only reading that can over-report, never under-report.
//
// What it does NOT try to be: a tokenizer. It never builds tokens, keeps no
// positions and does not validate anything. A file that is not valid JS is still
// answered, and whatever the answer, the caller's parse remains the judge.
//
// PURE and vscode-free. Linear time, O(nesting depth) memory. The hot loop is
// table-driven (one lookup per character) because on a 5 MB file the per-char
// cost is the whole budget.

/** Keywords after which an expression starts (a regex, or JSX, may follow). */
const EXPRESSION_KEYWORDS: ReadonlySet<string> = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'default',
  'extends',
  // `break` / `continue` / `debugger` end a statement, and a line break after
  // them starts the next one, which may be a regex literal or JSX.
  'break',
  'continue',
  'debugger'
]);

/**
 * Words that are a keyword in one position and an ordinary name in another
 * (`for (x of y)`, `await f()`, `yield g()` against `var of = 1`). An expression
 * may start after them, but a `/` is not decided here: see the header.
 */
const AMBIGUOUS_WORDS: ReadonlySet<string> = new Set(['of', 'yield', 'await']);

/** Keywords whose parenthesised head is followed by a STATEMENT, not an operand. */
const HEAD_KEYWORDS: ReadonlySet<string> = new Set(['if', 'while', 'for', 'with']);

/** The longest word in the three sets above (`instanceof`, `debugger`, ...). */
const MAX_KEYWORD_LENGTH = 10;

const CHAR_LF = 10;
const CHAR_CR = 13;
const CHAR_BANG = 33;
const CHAR_DOLLAR = 36;
const CHAR_STAR = 42;
const CHAR_MINUS = 45;
const CHAR_SLASH = 47;
const CHAR_ZERO = 48;
const CHAR_NINE = 57;
const CHAR_EQUALS = 61;
const CHAR_GREATER = 62;
const CHAR_LEFT_BRACKET = 91;
const CHAR_BACKSLASH = 92;
const CHAR_RIGHT_BRACKET = 93;
const CHAR_BACKTICK = 96;
const CHAR_LOWER_A = 97;
const CHAR_LOWER_Z = 122;
const CHAR_LEFT_BRACE = 123;
const CHAR_ASCII_LIMIT = 128;
const CHAR_LINE_SEPARATOR = 0x2028;
const CHAR_PARAGRAPH_SEPARATOR = 0x2029;

/**
 * What a character starts, for the ASCII range. One table lookup replaces a chain
 * of comparisons in the hot loop. A `const enum` so every member is a literal in
 * the emitted code.
 */
const enum Kind {
  Other,
  Space,
  LineBreak,
  Word,
  Digit,
  Slash,
  Quote,
  Backtick,
  Less,
  LeftParen,
  RightParen,
  LeftBracket,
  RightBracket,
  LeftBrace,
  RightBrace,
  Dot,
  Sign,
  Hash,
  NonAscii
}

/** State carried from one token to the next, packed into one integer. */
const enum Carry {
  None = 0,
  /** The previous token was `.` or the `.` of `?.`: the next word is a property name. */
  AfterDot = 1,
  /** The previous token was `of`, `yield` or `await`. */
  AfterAmbiguousWord = 2,
  /** The next `(` opens the head of if/while/for/with, followed by a statement. */
  HeadPending = 4,
  /** The previous token was the word `for` (so `for await (` keeps the head). */
  AfterFor = 8
}

/** Brace-stack markers: an ordinary `{`, or the `${` that opens a template hole. */
const BRACE_BLOCK = 0;
const BRACE_TEMPLATE = 1;

function buildKindTable(): Uint8Array {
  const table = new Uint8Array(CHAR_ASCII_LIMIT);
  const set = (chars: string, kind: Kind): void => {
    for (let i = 0; i < chars.length; i += 1) {
      table[chars.charCodeAt(i)] = kind;
    }
  };
  for (let code = CHAR_LOWER_A; code <= CHAR_LOWER_Z; code += 1) {
    table[code] = Kind.Word;
    table[code - 32] = Kind.Word; // the upper-case letter
  }
  for (let code = CHAR_ZERO; code <= CHAR_NINE; code += 1) {
    table[code] = Kind.Digit;
  }
  set('_$\\', Kind.Word);
  set(' \t\v\f', Kind.Space);
  set('\n\r', Kind.LineBreak);
  set('/', Kind.Slash);
  set('\'"', Kind.Quote);
  set('`', Kind.Backtick);
  set('<', Kind.Less);
  set('(', Kind.LeftParen);
  set(')', Kind.RightParen);
  set('[', Kind.LeftBracket);
  set(']', Kind.RightBracket);
  set('{', Kind.LeftBrace);
  set('}', Kind.RightBrace);
  set('.', Kind.Dot);
  set('+-', Kind.Sign);
  set('#', Kind.Hash);
  return table;
}

/** Kind of each ASCII character; everything not listed is a plain punctuator. */
const KINDS: Uint8Array = buildKindTable();

/** 1 for an ASCII character that can continue an identifier or a number. */
const CONTINUES_WORD: Uint8Array = (() => {
  const table = new Uint8Array(CHAR_ASCII_LIMIT);
  for (let code = 0; code < CHAR_ASCII_LIMIT; code += 1) {
    const kind = KINDS[code];
    table[code] = kind === Kind.Word || kind === Kind.Digit ? 1 : 0;
  }
  return table;
})();

/** Non-ASCII characters ECMAScript treats as white space (line terminators apart). */
function isUnicodeSpace(code: number): boolean {
  return (
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

function isLineTerminator(code: number): boolean {
  return (
    code === CHAR_LF ||
    code === CHAR_CR ||
    code === CHAR_LINE_SEPARATOR ||
    code === CHAR_PARAGRAPH_SEPARATOR
  );
}

/** A character that can continue an identifier (or a number). */
function isWordChar(code: number): boolean {
  if (code >= CHAR_ASCII_LIMIT) {
    return !isUnicodeSpace(code) && !isLineTerminator(code);
  }
  return CONTINUES_WORD[code] === 1;
}

function isDigit(code: number): boolean {
  return code >= CHAR_ZERO && code <= CHAR_NINE;
}

/** Index just past the end of the identifier or number that starts at `from`. */
function skipWord(source: string, from: number): number {
  const length = source.length;
  let index = from + 1;
  while (index < length) {
    const code = source.charCodeAt(index);
    if (code < CHAR_ASCII_LIMIT ? CONTINUES_WORD[code] === 1 : isWordChar(code)) {
      index += 1;
    } else {
      break;
    }
  }
  return index;
}

/** Index just past a numeric literal that starts at `from` (a digit, or `.` and a digit). */
function skipNumber(source: string, from: number): number {
  const length = source.length;
  let index = from + 1;
  while (index < length) {
    const code = source.charCodeAt(index);
    if (isWordChar(code)) {
      index += 1;
    } else if (code === 46 /* . */ && isDigit(source.charCodeAt(index + 1))) {
      index += 1;
    } else {
      break;
    }
  }
  return index;
}

/** Index just past the closing quote of a string literal, or -1 when unterminated. */
function scanString(source: string, from: number, quote: number): number {
  const length = source.length;
  let index = from + 1;
  while (index < length) {
    const code = source.charCodeAt(index);
    if (code === quote) {
      return index + 1;
    }
    if (code === CHAR_BACKSLASH) {
      // `\` escapes the next character, and a CRLF line continuation is one unit.
      const next = source.charCodeAt(index + 1);
      index += next === CHAR_CR && source.charCodeAt(index + 2) === CHAR_LF ? 3 : 2;
      continue;
    }
    if (code === CHAR_LF || code === CHAR_CR) {
      return -1;
    }
    index += 1;
  }
  return -1;
}

/**
 * Index just past the closing `/` and flags of a regular expression literal that
 * starts at `from`, or -1 when this cannot be one (a line break first, or no
 * closing slash). A `/` inside a `[...]` class does not close it.
 */
function scanRegex(source: string, from: number): number {
  const length = source.length;
  let index = from + 1;
  let inClass = false;
  while (index < length) {
    const code = source.charCodeAt(index);
    if (isLineTerminator(code)) {
      return -1;
    }
    if (code === CHAR_BACKSLASH) {
      index += 2;
      continue;
    }
    if (code === CHAR_LEFT_BRACKET) {
      inClass = true;
    } else if (code === CHAR_RIGHT_BRACKET) {
      inClass = false;
    } else if (code === CHAR_SLASH && !inClass) {
      index += 1;
      while (index < length && isWordChar(source.charCodeAt(index))) {
        index += 1;
      }
      return index;
    }
    index += 1;
  }
  return -1;
}

/** Where a template chunk ended: after the closing backtick, or after a `${`. */
interface TemplateStop {
  end: number;
  opensHole: boolean;
}

/**
 * Read template text from `from` up to the closing backtick or the next `${`.
 * Returns false when the template is unterminated. The result goes into `stop`,
 * one object reused for the whole scan.
 */
function scanTemplateChunk(source: string, from: number, stop: TemplateStop): boolean {
  const length = source.length;
  let index = from;
  while (index < length) {
    const code = source.charCodeAt(index);
    if (code === CHAR_BACKTICK) {
      stop.end = index + 1;
      stop.opensHole = false;
      return true;
    }
    if (code === CHAR_BACKSLASH) {
      index += 2;
      continue;
    }
    if (code === CHAR_DOLLAR && source.charCodeAt(index + 1) === CHAR_LEFT_BRACE) {
      stop.end = index + 2;
      stop.opensHole = true;
      return true;
    }
    index += 1;
  }
  return false;
}

/** Index of the end of the line that starts at `from` (the terminator itself is not consumed). */
function skipToLineEnd(source: string, from: number): number {
  const length = source.length;
  let index = from;
  while (index < length && !isLineTerminator(source.charCodeAt(index))) {
    index += 1;
  }
  return index;
}

/** Whether the text between two indexes holds a line terminator. */
function hasLineTerminator(source: string, from: number, to: number): boolean {
  for (let index = from; index < to; index += 1) {
    if (isLineTerminator(source.charCodeAt(index))) {
      return true;
    }
  }
  return false;
}

/**
 * Whether `source` might contain JSX. FALSE means "provably none": no `<` sits
 * where an expression can start. TRUE means "possibly", and the caller must
 * confirm with a real parse. See the file header for why TRUE is the answer to
 * every doubt.
 */
export function mayContainJsx(source: string): boolean {
  const length = source.length;
  const parens: boolean[] = [];
  const braces: number[] = [];
  const templateStop: TemplateStop = { end: 0, opensHole: false };

  let index = 0;
  // An expression may start at the next token: true at the start of the file and
  // after every operator, opening bracket and expression keyword; false after an
  // operand. `++` and `--` leave it as it was, like a tokenizer does.
  let expressionAllowed = true;
  let carry: number = Carry.None;
  // A line terminator lies between the previous token and the next one.
  let lineBreakBefore = false;

  if (source.charCodeAt(0) === 35 /* # */ && source.charCodeAt(1) === CHAR_BANG) {
    index = skipToLineEnd(source, 0);
  }

  while (index < length) {
    const code = source.charCodeAt(index);
    const kind: number = code < CHAR_ASCII_LIMIT ? KINDS[code] : Kind.NonAscii;

    // --- white space and comments: no token, only the line-break flag -----------
    switch (kind) {
      case Kind.Space:
        index += 1;
        continue;
      case Kind.LineBreak:
        lineBreakBefore = true;
        index += 1;
        continue;
      case Kind.NonAscii:
        if (isUnicodeSpace(code)) {
          index += 1;
          continue;
        }
        if (code === CHAR_LINE_SEPARATOR || code === CHAR_PARAGRAPH_SEPARATOR) {
          lineBreakBefore = true;
          index += 1;
          continue;
        }
        break;
      case Kind.Slash: {
        const next = source.charCodeAt(index + 1);
        if (next === CHAR_SLASH) {
          index = skipToLineEnd(source, index + 2);
          continue;
        }
        if (next === CHAR_STAR) {
          const close = source.indexOf('*/', index + 2);
          if (close < 0) {
            return true;
          }
          if (hasLineTerminator(source, index + 2, close)) {
            lineBreakBefore = true;
          }
          index = close + 2;
          continue;
        }
        break;
      }
      default:
        break;
    }

    // --- a token starts here ---------------------------------------------------
    const breakBefore = lineBreakBefore;
    const before = carry;
    lineBreakBefore = false;
    carry = Carry.None;

    switch (kind) {
      case Kind.Less:
        // The one question this scan exists to answer.
        if (expressionAllowed || breakBefore) {
          return true;
        }
        if (
          source.charCodeAt(index + 1) === CHAR_BANG &&
          source.charCodeAt(index + 2) === CHAR_MINUS &&
          source.charCodeAt(index + 3) === CHAR_MINUS
        ) {
          return true; // an HTML-style comment opener: its text is not code
        }
        // `<`, `<<`, `<=`, `<<=`: one operator, so its second `<` is not tested.
        index += 1;
        if (source.charCodeAt(index) === 60 /* < */) {
          index += 1;
        }
        if (source.charCodeAt(index) === CHAR_EQUALS) {
          index += 1;
        }
        expressionAllowed = true;
        break;

      case Kind.Slash:
        // A comment was handled above, so this is a regular expression or a division.
        if ((before & Carry.AfterAmbiguousWord) !== 0) {
          return true;
        }
        if (expressionAllowed) {
          const end = scanRegex(source, index);
          if (end < 0) {
            return true;
          }
          index = end;
          expressionAllowed = false;
        } else {
          index += 1;
          if (source.charCodeAt(index) === CHAR_EQUALS) {
            index += 1;
          }
          expressionAllowed = true;
        }
        break;

      case Kind.Quote: {
        const end = scanString(source, index, code);
        if (end < 0) {
          return true;
        }
        index = end;
        expressionAllowed = false;
        break;
      }

      case Kind.Backtick:
        if (!scanTemplateChunk(source, index + 1, templateStop)) {
          return true;
        }
        index = templateStop.end;
        if (templateStop.opensHole) {
          braces.push(BRACE_TEMPLATE);
          expressionAllowed = true;
        } else {
          expressionAllowed = false;
        }
        break;

      case Kind.Digit:
        index = skipNumber(source, index);
        expressionAllowed = false;
        break;

      case Kind.Word:
      case Kind.NonAscii: {
        const start = index;
        index = skipWord(source, index);
        expressionAllowed = false;
        if ((before & Carry.AfterDot) !== 0) {
          break; // a property name, never a keyword
        }
        // Every keyword is 2 to 10 lowercase ASCII letters: skip the slice for the
        // rest, which is most identifiers of a large file.
        const wordLength = index - start;
        if (
          wordLength < 2 ||
          wordLength > MAX_KEYWORD_LENGTH ||
          code < CHAR_LOWER_A ||
          code > CHAR_LOWER_Z
        ) {
          break;
        }
        const word = source.slice(start, index);
        if (EXPRESSION_KEYWORDS.has(word)) {
          expressionAllowed = true;
        } else if (AMBIGUOUS_WORDS.has(word)) {
          expressionAllowed = true;
          carry = Carry.AfterAmbiguousWord;
          // `for await (` keeps the statement head the `for` opened.
          if (
            word === 'await' &&
            (before & Carry.HeadPending) !== 0 &&
            (before & Carry.AfterFor) !== 0
          ) {
            carry = Carry.AfterAmbiguousWord | Carry.HeadPending;
          }
        } else if (HEAD_KEYWORDS.has(word)) {
          carry = word === 'for' ? Carry.HeadPending | Carry.AfterFor : Carry.HeadPending;
        }
        break;
      }

      case Kind.LeftParen:
        parens.push((before & Carry.HeadPending) !== 0);
        expressionAllowed = true;
        index += 1;
        break;

      case Kind.RightParen: {
        const wasHead = parens.pop();
        if (wasHead === undefined) {
          return true; // unbalanced: the scan lost its place
        }
        // After a statement head an expression (a regex, JSX) may start.
        expressionAllowed = wasHead;
        index += 1;
        break;
      }

      case Kind.LeftBracket:
        expressionAllowed = true;
        index += 1;
        break;

      case Kind.RightBracket:
        expressionAllowed = false;
        index += 1;
        break;

      case Kind.LeftBrace:
        braces.push(BRACE_BLOCK);
        expressionAllowed = true;
        index += 1;
        break;

      case Kind.RightBrace: {
        const brace = braces.pop();
        if (brace === undefined) {
          return true;
        }
        index += 1;
        if (brace === BRACE_TEMPLATE) {
          if (!scanTemplateChunk(source, index, templateStop)) {
            return true;
          }
          index = templateStop.end;
          if (templateStop.opensHole) {
            braces.push(BRACE_TEMPLATE);
            expressionAllowed = true;
          } else {
            expressionAllowed = false;
          }
        } else {
          // Read as the end of a block: an expression may start after it.
          expressionAllowed = true;
        }
        break;
      }

      case Kind.Dot:
        if (isDigit(source.charCodeAt(index + 1))) {
          index = skipNumber(source, index); // `.5`
          expressionAllowed = false;
        } else if (
          source.charCodeAt(index + 1) === 46 &&
          source.charCodeAt(index + 2) === 46
        ) {
          index += 3; // spread: an expression follows
          expressionAllowed = true;
        } else {
          index += 1;
          carry = Carry.AfterDot;
          expressionAllowed = true;
        }
        break;

      case Kind.Sign:
        if (source.charCodeAt(index + 1) === code) {
          // `-->` at the start of a line is an HTML-style comment in a script.
          if (
            code === CHAR_MINUS &&
            source.charCodeAt(index + 2) === CHAR_GREATER &&
            (breakBefore || index === 0)
          ) {
            return true;
          }
          index += 2; // `++` / `--`: prefix or postfix, so the state is unchanged
        } else {
          index += 1;
          expressionAllowed = true;
        }
        break;

      case Kind.Hash:
        index += 1; // a private name: the word after it sets the state
        break;

      default:
        // Every other punctuator (`, ; : ? = ! > & | * % ^ ~ @` and the rest)
        // is followed by an operand.
        index += 1;
        expressionAllowed = true;
        break;
    }
  }
  return false;
}
