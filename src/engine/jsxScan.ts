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
// PURE and vscode-free. Linear time, O(nesting depth) memory.

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

const CHAR_TAB = 9;
const CHAR_LF = 10;
const CHAR_VT = 11;
const CHAR_FF = 12;
const CHAR_CR = 13;
const CHAR_SPACE = 32;
const CHAR_BANG = 33;
const CHAR_DOUBLE_QUOTE = 34;
const CHAR_HASH = 35;
const CHAR_DOLLAR = 36;
const CHAR_SINGLE_QUOTE = 39;
const CHAR_LEFT_PAREN = 40;
const CHAR_RIGHT_PAREN = 41;
const CHAR_STAR = 42;
const CHAR_PLUS = 43;
const CHAR_MINUS = 45;
const CHAR_DOT = 46;
const CHAR_SLASH = 47;
const CHAR_ZERO = 48;
const CHAR_NINE = 57;
const CHAR_LESS = 60;
const CHAR_EQUALS = 61;
const CHAR_GREATER = 62;
const CHAR_UPPER_A = 65;
const CHAR_UPPER_Z = 90;
const CHAR_LEFT_BRACKET = 91;
const CHAR_BACKSLASH = 92;
const CHAR_RIGHT_BRACKET = 93;
const CHAR_UNDERSCORE = 95;
const CHAR_BACKTICK = 96;
const CHAR_LOWER_A = 97;
const CHAR_LOWER_Z = 122;
const CHAR_LEFT_BRACE = 123;
const CHAR_RIGHT_BRACE = 125;
const CHAR_ASCII_LIMIT = 127;
const CHAR_LINE_SEPARATOR = 0x2028;
const CHAR_PARAGRAPH_SEPARATOR = 0x2029;

/** Brace-stack markers: an ordinary `{`, or the `${` that opens a template hole. */
const BRACE_BLOCK = 0;
const BRACE_TEMPLATE = 1;

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
  if (code > CHAR_ASCII_LIMIT) {
    return !isUnicodeSpace(code) && !isLineTerminator(code);
  }
  return (
    (code >= CHAR_LOWER_A && code <= CHAR_LOWER_Z) ||
    (code >= CHAR_UPPER_A && code <= CHAR_UPPER_Z) ||
    (code >= CHAR_ZERO && code <= CHAR_NINE) ||
    code === CHAR_UNDERSCORE ||
    code === CHAR_DOLLAR ||
    code === CHAR_BACKSLASH
  );
}

function isDigit(code: number): boolean {
  return code >= CHAR_ZERO && code <= CHAR_NINE;
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
  // The previous token was `.` (or the `.` of `?.`): the next word is a property name.
  let afterDot = false;
  // The next `(` opens the head of if/while/for/with, followed by a statement.
  let headPending = false;
  let lastWordWasFor = false;
  // The previous token was `of`, `yield` or `await`.
  let afterAmbiguousWord = false;
  // A line terminator lies between the previous token and the next one.
  let lineBreakBefore = false;

  if (source.charCodeAt(0) === CHAR_HASH && source.charCodeAt(1) === CHAR_BANG) {
    index = skipToLineEnd(source, 0);
  }

  while (index < length) {
    const code = source.charCodeAt(index);

    // --- white space and comments: no token, only the line-break flag -----------
    if (code === CHAR_SPACE || code === CHAR_TAB || code === CHAR_VT || code === CHAR_FF) {
      index += 1;
      continue;
    }
    if (isLineTerminator(code)) {
      lineBreakBefore = true;
      index += 1;
      continue;
    }
    if (code > CHAR_ASCII_LIMIT && isUnicodeSpace(code)) {
      index += 1;
      continue;
    }
    if (code === CHAR_SLASH) {
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
    }

    // --- a token starts here ---------------------------------------------------
    const breakBefore = lineBreakBefore;
    const wasAfterDot = afterDot;
    const wasAfterAmbiguous = afterAmbiguousWord;
    const head = headPending;
    const wasLastWordFor = lastWordWasFor;
    lineBreakBefore = false;
    afterDot = false;
    afterAmbiguousWord = false;
    headPending = false;
    lastWordWasFor = false;

    if (code === CHAR_LESS) {
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
      if (source.charCodeAt(index) === CHAR_LESS) {
        index += 1;
      }
      if (source.charCodeAt(index) === CHAR_EQUALS) {
        index += 1;
      }
      expressionAllowed = true;
      continue;
    }

    if (code === CHAR_SLASH) {
      // A comment was handled above, so this is a regular expression or a division.
      if (wasAfterAmbiguous) {
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
      continue;
    }

    if (code === CHAR_SINGLE_QUOTE || code === CHAR_DOUBLE_QUOTE) {
      const end = scanString(source, index, code);
      if (end < 0) {
        return true;
      }
      index = end;
      expressionAllowed = false;
      continue;
    }

    if (code === CHAR_BACKTICK) {
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
      continue;
    }

    if (isDigit(code) || (code === CHAR_DOT && isDigit(source.charCodeAt(index + 1)))) {
      index += 1;
      while (index < length) {
        const inner = source.charCodeAt(index);
        if (isWordChar(inner)) {
          index += 1;
        } else if (inner === CHAR_DOT && isDigit(source.charCodeAt(index + 1))) {
          index += 1;
        } else {
          break;
        }
      }
      expressionAllowed = false;
      continue;
    }

    if (isWordChar(code)) {
      const start = index;
      index += 1;
      while (index < length && isWordChar(source.charCodeAt(index))) {
        index += 1;
      }
      if (wasAfterDot) {
        expressionAllowed = false; // a property name, never a keyword
        continue;
      }
      // Every keyword is 2 to 10 lowercase ASCII letters: skip the slice for the
      // rest, which is most identifiers of a large file.
      const wordLength = index - start;
      if (wordLength < 2 || wordLength > MAX_KEYWORD_LENGTH || code < CHAR_LOWER_A || code > CHAR_LOWER_Z) {
        expressionAllowed = false;
        continue;
      }
      const word = source.slice(start, index);
      if (EXPRESSION_KEYWORDS.has(word)) {
        expressionAllowed = true;
      } else if (AMBIGUOUS_WORDS.has(word)) {
        expressionAllowed = true;
        afterAmbiguousWord = true;
        // `for await (` keeps the statement head the `for` opened.
        headPending = word === 'await' && head && wasLastWordFor;
      } else if (HEAD_KEYWORDS.has(word)) {
        expressionAllowed = false;
        headPending = true;
        lastWordWasFor = word === 'for';
      } else {
        expressionAllowed = false;
      }
      continue;
    }

    switch (code) {
      case CHAR_LEFT_PAREN:
        parens.push(head);
        expressionAllowed = true;
        index += 1;
        break;
      case CHAR_RIGHT_PAREN: {
        const wasHead = parens.pop();
        if (wasHead === undefined) {
          return true; // unbalanced: the scan lost its place
        }
        // After a statement head an expression (a regex, JSX) may start.
        expressionAllowed = wasHead;
        index += 1;
        break;
      }
      case CHAR_LEFT_BRACKET:
        expressionAllowed = true;
        index += 1;
        break;
      case CHAR_RIGHT_BRACKET:
        expressionAllowed = false;
        index += 1;
        break;
      case CHAR_LEFT_BRACE:
        braces.push(BRACE_BLOCK);
        expressionAllowed = true;
        index += 1;
        break;
      case CHAR_RIGHT_BRACE: {
        const kind = braces.pop();
        if (kind === undefined) {
          return true;
        }
        index += 1;
        if (kind === BRACE_TEMPLATE) {
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
      case CHAR_DOT:
        if (
          source.charCodeAt(index + 1) === CHAR_DOT &&
          source.charCodeAt(index + 2) === CHAR_DOT
        ) {
          index += 3; // spread: an expression follows
        } else {
          index += 1;
          afterDot = true;
        }
        expressionAllowed = true;
        break;
      case CHAR_PLUS:
      case CHAR_MINUS:
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
      case CHAR_HASH:
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
