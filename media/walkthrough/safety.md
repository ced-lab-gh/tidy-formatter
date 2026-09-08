# Safety first : nothing is written until it is proven equivalent

Tidy's core promise: **it will never write a file that fails an equivalence check against your original.** This is the behaviour that the abandoned *JS-CSS-HTML Formatter* got wrong. Every write is gated on that check, and a check that could not be completed counts as a failure, never as a pass : a format Tidy cannot prove safe produces **zero edits** rather than a rewritten file.

After every format, Tidy compares the input and the output before writing anything:

- **AST-equivalence guard (JS / TS / JSX / TSX).** Tidy parses both the input and the output and compares them modulo whitespace and style. If they are not semantically equivalent, Tidy returns **zero edits** and your file is left exactly as it was. A mangled `< Foo bar = {x} />` is rejected *even though it still re-parses as valid TSX* : a parse-only check would let that corruption through; Tidy does not.
- **Re-tokenise + tree compare (CSS / SCSS / LESS / HTML).** Tidy compares a PostCSS tree (CSS family) or a parse5 tree (HTML). Any output whose tree differs from the input's is discarded.
- **Value-level check (JSON / JSONC).** The parsed value must be unchanged.
- **Idempotence, proven in the test corpus, not on your file.** `format(format(x))` equals `format(x)` for every fixture in Tidy's test suite, so reformatting does not walk your code to the right. Be exact about what that is: a property the tests prove, **not** a check that runs at format time. Nothing is formatted twice at runtime to verify it, and no output is ever rejected for failing it. The checks that do run before every write are the equivalence checks above.
- **No silent failures.** When the guard aborts, you get a non-blocking notice and a line in the *Tidy Formatter* output channel. **Tidy never copies your document into that line**: the reason is cut to its first line and capped at 200 characters, so a parser error's multi-line code frame can never reach it. What survives that cut is the parser's own first line, which sometimes names the token it choked on, so treat that one short line as able to quote a few characters of the construct that failed. Nothing is persisted and nothing leaves your machine.

If the guard ever aborts a format you expected to succeed, that is by design: the file is intact, and the alternative (writing potentially corrupted output) is exactly the failure mode Tidy exists to prevent.

> **Want to see what Tidy would actually do?**
> Run **Tidy: Show Effective Configuration** from the Command Palette
> (`tidy.showEffectiveConfiguration`) to see every resolved option and the exact
> source of each one : the antidote to "why is this 4 spaces and not 2?".
