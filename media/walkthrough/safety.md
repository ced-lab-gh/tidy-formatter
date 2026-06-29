# Safety first — Tidy never corrupts your file

Tidy's core promise: **it will never write a file that fails an equivalence check against your original.** This is the behaviour that the abandoned *JS-CSS-HTML Formatter* got wrong — Tidy is built to make file corruption impossible.

After every format, Tidy compares the input and the output before writing anything:

- **AST-equivalence guard (JS / TS / JSX / TSX).** Tidy parses both the input and the output and compares them modulo whitespace and style. If they are not semantically equivalent, Tidy returns **zero edits** and your file is left exactly as it was. A mangled `< Foo bar = {x} />` is rejected *even though it still re-parses as valid TSX* — a parse-only check would let that corruption through; Tidy does not.
- **Re-tokenise + tree compare (CSS / SCSS / LESS / HTML).** Tidy compares a PostCSS tree (CSS family) or a parse5 tree (HTML). Any output whose tree differs from the input's is discarded.
- **Value-level check (JSON / JSONC).** The parsed value must be unchanged.
- **Idempotence.** `format(format(x))` equals `format(x)`, so your code never drifts to the right.
- **No silent failures.** When the guard aborts, you get a non-blocking notice and a line in the *Tidy Formatter* output channel — and that detail **never contains your source code**.

If the guard ever aborts a format you expected to succeed, that is by design: the file is intact, and the alternative (writing potentially corrupted output) is exactly the failure mode Tidy exists to prevent.

> **Want to see what Tidy would actually do?**
> Run **Tidy: Show Effective Configuration** from the Command Palette
> (`tidy.showEffectiveConfiguration`) to see every resolved option and the exact
> source of each one — the antidote to "why is this 4 spaces and not 2?".
