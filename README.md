# Tidy: JS/CSS/HTML Formatter & Beautifier

**Format & beautify JavaScript, TypeScript, JSX/TSX, CSS, SCSS, LESS, HTML & JSON, safely. Tidy respects your VS Code config and never auto-formats or hijacks your files unless you ask.**

[![Version](https://img.shields.io/visual-studio-marketplace/v/ced-lab.tidy-formatter?label=Marketplace&color=168F7D)](https://marketplace.visualstudio.com/items?itemName=ced-lab.tidy-formatter)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/ced-lab.tidy-formatter?label=installs&color=168F7D)](https://marketplace.visualstudio.com/items?itemName=ced-lab.tidy-formatter)
[![Rating](https://img.shields.io/visual-studio-marketplace/r/ced-lab.tidy-formatter?label=rating&color=168F7D)](https://marketplace.visualstudio.com/items?itemName=ced-lab.tidy-formatter&ssr=false#review-details)
[![License: MIT](https://img.shields.io/badge/License-MIT-168F7D.svg)](./LICENSE)

Tidy is a configurable beautifier for JavaScript, TypeScript, JSX/TSX, CSS, SCSS, LESS, HTML and JSON. It does exactly one thing: it reformats a file **when you ask it to**, via *Format Document* or *Format Selection*, and it refuses to write a file back unless the result is provably equivalent to what you started with. It never contributes `editor.defaultFormatter` in its manifest and never writes it without an explicit confirmation from you, never hooks "save", and never touches a file you didn't tell it to.

If you arrived here after a formatter quietly rewrote your code on save, that is the exact behaviour Tidy is built to make impossible.

---

## See it in action

<!--
  These three images are generated PNGs committed at media/before-after/html.png,
  media/before-after/css.png and media/before-after/tsx.png. Keep them PNG on purpose: the VS Code
  Marketplace rewrites relative image paths to raw.githubusercontent.com and
  renders PNG reliably on the listing, whereas SVG is NOT guaranteed to render
  there. If a build only produces .svg siblings, point the srcs below at
  html.svg / css.svg / tsx.svg as a fallback, but the committed, Marketplace-safe asset
  must stay PNG. Regenerate the set with `node scripts/build-visuals.mjs` before
  publishing, once samples/out/ matches the real engine output: css and tsx read
  samples/ (before) and samples/out/ (after), and the HTML card has its sample
  inside the script. Until then, the script rewrites css.png with stale samples/out/messy.css.
-->

![HTML before and after: glued attributes get their spaces back, the folded `<ul>` becomes one item per line, and the script is spaced and indented.](media/before-after/html.png)

![CSS before and after: collapsed, comma-jammed rules become readable blocks while the `>` combinator and `calc(100% - 20px)` survive intact.](media/before-after/css.png)

![TSX before and after: minified React reflowed by a real parser, `<div className="card" … />` stays valid JSX and `n?.toString() ?? "none"` keeps both its `?.` and `??` operators.](media/before-after/tsx.png)

The CSS and TSX cards are the real [`samples/`](./samples) inputs run through *Format Document*. The HTML card uses a small sample of the same kind, formatted by the same engine at a tab size of 4. In every card the messy original sits next to Tidy's output. Nothing changed meaning along the way: if a format would mangle a JSX tag or split a `?.` into `? .`, the equivalence guard discards the result and leaves your file untouched.

---

## Migrating from JS-CSS-HTML Formatter

[JS-CSS-HTML Formatter](https://marketplace.visualstudio.com/items?itemName=lonefy.vscode-JS-CSS-HTML-formatter) (`lonefy.vscode-JS-CSS-HTML-formatter`) is a popular beautifier that has not been updated since 2017. Measured on the Marketplace `extensionquery` API on 2026-09-07: **3,969,079 installs**, a **1.69★ average over 241 ratings**, and a last version (0.2.3) published on **2017-03-31**. We classified every one-star review in our snapshot of that listing (the 100 most recent reviews, retrieved 2026-06-28; 85 of them are one-star and carry text, the most recent dated 2025-02-11). **53 of those 85 are about broken or corrupted output**: mangled JSX, a split `?.`, stray spaces inside class and id names, files that stop parsing. **26 are about a formatter acting without consent**: formatting on save after you turned that off, making itself the default formatter, ignoring your settings, overriding Prettier or ESLint. 10 reviews make both complaints and are counted in both figures, and the remaining 16 are invective with no attributable cause. Broken output is the dominant complaint, so it is the one Tidy answers first: every format is proved equivalent to your input before a single character is written, and when that proof fails Tidy makes zero edits. Acting without consent is the second, and Tidy hooks no save event and writes no setting you have not confirmed. Tidy is a clean-room replacement that keeps the "configurable beautify" niche while removing the destructive behaviour.

**Recommended migration (2 minutes), in this order:**

1. **Disable or uninstall** JS-CSS-HTML Formatter
   (Extensions view → search "JS-CSS-HTML" → *Disable* / *Uninstall*).
   This is the single most important step: while it is enabled it can keep
   formatting on save regardless of your settings. Tidy **cannot** disable
   another extension for you (no VS Code API allows it), so it only *guides* you
   here; it never claims to have turned lonefy off.
2. **Install Tidy Formatter.** It will *not* take over on save automatically and
   it writes **no** settings at install time.
3. **Opt in** to the behaviour you actually want; see
   [60-second opt-in setup](#60-second-opt-in-setup) below, or use the guided
   commands described next.

> **Tidy never hooks the save event, and never writes a setting without an
> explicit action from you.** No setting is written at install time, at startup,
> on save, or in the background. The two commands below are the *only* way Tidy
> writes a setting; each shows you the exact keys first and writes only after you
> confirm, and the format-on-save opt-in ships a one-click **Revert**.

### Guided migration commands

Both commands live in the Command Palette (`Ctrl+Shift+P`) under the **Tidy**
category, and both are also reachable from the *Get started with Tidy Formatter*
walkthrough:

- **`tidy.useAsFormatter`**, *“Tidy: Use Tidy as My Formatter”*. Pick the
  languages you want, choose a scope (**Workspace** by default, **User**
  optional), and Tidy writes `editor.defaultFormatter` (override-in-language)
  for just those languages; cancelling the picker writes nothing at all. With no
  workspace folder open a Workspace write is impossible, so the modal recap says
  so in the conditional (*"No workspace folder is open, so a Workspace write is
  not possible: if you confirm, Tidy will be set as your default formatter in
  your User settings instead of the workspace."*) and you can still refuse. An
  optional follow-up step can then enable format on save for those same
  languages: its first and recommended answer is *No, keep formatting manual*,
  and choosing to enable it shows the exact
  `"[lang]": { "editor.formatOnSave": true }` keys and the scope in a second
  modal recap, writes only after you confirm, and the success message offers a
  one-click **Revert** restoring the previous values. Decline that step and you
  still get the passive button that merely *opens* the `editor.formatOnSave`
  setting. Tidy installs no save hook either way: VS Code
  core owns the save lifecycle.
- **`tidy.runMigration`**, *“Tidy: Migrate from JS-CSS-HTML Formatter”*. Reads
  the configuration lonefy really reads (the first found of `.vscode/formatter.json`
  in your first workspace folder and the global `formatter.json` of lonefy’s own
  install folder, else a `.jsbeautifyrc`, which other beautify extensions read;
  best-effort, and **only** when the workspace is trusted, ignored in
  Restricted Mode), shows a recap of exactly
  which `tidy.*` settings it would import and which file they come from, and
  writes them **only after you confirm**: at Workspace scope, except settings
  that come from lonefy’s global file, which are written at User scope and never
  into a repository’s `settings.json`. A write that fails part-way is rolled
  back and any key that cannot be restored is named. It then offers (separately,
  opt-in) to run `tidy.useAsFormatter`, and, only while lonefy is installed and
  enabled, a button to open the Extensions view on it so you can disable it.

If lonefy is detected when Tidy activates, you may also see a single, non-modal
notification offering to migrate. It is **one-shot and deduplicated**: it appears
at most once per machine/profile, has a **“Don’t ask again”** action, and is
never repeated. Acting without consent is the second most common complaint in that
review corpus (26 of the 85 one-star reviews, behind 53 about broken output), so
Tidy will not nag.

### What gets imported

lonefy reads `.vscode/formatter.json`, a JSON file with one section per language
(`{ "javascript": { "indent_size": 2 }, "css": { "indent_size": 2 }, "html": { "indent_size": 2 } }`).
`tidy.runMigration` reads that file (or, failing it, the two other sources above:
the first one found is used and the recap names it) and turns each section into
language-specific settings, the way lonefy applied it:

| Section of the file | Written into |
|---|---|
| `css` | `[css]` and `[scss]` |
| `javascript` | `[javascript]` and `[json]` |
| `html` | `[html]` |

There is no `[less]` or `[jsonc]` block, because lonefy never formatted those
languages. A key is imported only when Tidy has a setting with the same meaning
and the same range of values, and only for a language where that setting does
something and where lonefy’s own js-beautify read it (so `[json]` receives only
`indent_size` and `eol`). Any other key is surfaced as *“not carried over”*
(never written), and any recognised key with an out-of-range value is reported
and dropped (never written). The keys that carry over:

| Section | js-beautify keys (lonefy) | Tidy setting |
|---|---|---|
| all three | `indent_size`, `eol` | `tidy.indent` (integer in `[1, 16]`), `tidy.end_of_line` (`"\n"` is `lf`, `"\r\n"` is `crlf`; `"auto"` has no equivalent and is not carried over) |
| `javascript` | `brace_style`, `wrap_line_length`, `space_after_anon_function`, `space_before_conditional`, `jslint_happy`, `preserve_newlines`, `max_preserve_newlines`, `space_in_paren`, `space_in_empty_paren`, `break_chained_methods`, `keep_array_indentation`, `comma_first`, `operator_position` | the `tidy.*` setting of the same name |
| `css` | `preserve_newlines`, `selector_separator_newline`, `newline_between_rules`, `space_around_combinator` | the `tidy.*` setting of the same name |
| `html` | `preserve_newlines`, `max_preserve_newlines`, `wrap_line_length`, `wrap_attributes`, `wrap_attributes_indent_size`, `indent_inner_html`, `indent_scripts` | the `tidy.*` setting of the same name |

Two things are deliberately not imported. lonefy’s **`onSave`** key is
recognised and never proposed: `true` is lonefy’s own default, so its presence
says nothing about what you chose, and the migration never enables format on
save. And **`eol` is not absolute any more**: `tidy.end_of_line` yields to
`files.eol` and `.editorconfig`, whereas lonefy applied `eol` unconditionally.

A `.jsbeautifyrc` is read last, because lonefy itself never reads that file (other
beautify extensions do); its sections are mapped the same way, and its top-level
flat keys are mapped to the plain `tidy.*` settings. Top-level flat keys in a
`formatter.json` are reported instead, because lonefy ignores them there.

The import is a **best-effort convenience, not a marketing promise**. Most lonefy
users ran it with no config file at all. Tidy also reads your existing VS
Code settings (`editor.tabSize`, `editor.insertSpaces`, per-language overrides)
directly, so in most cases there is nothing to port over.

---

## What lonefy breaks → what Tidy fixes

Every row below is sourced from a real Marketplace review or GitHub issue on the incumbent. Everything inside quotation marks is **verbatim**: line breaks and runs of whitespace inside a review are rendered as a single space, a quoted fragment that starts or stops mid-sentence carries an ellipsis at that end (a quote that is one or more whole sentences lifted from a longer review carries none), and no word, spelling or filename is changed. Anything *not* in quotation marks is Tidy's own summary of the linked source.

| What JS-CSS-HTML Formatter does | What Tidy does instead | Source |
|---|---|---|
| Formats on save **even when you turned `formatOnSave` off**, "Does not respect onSave: false." / “Always formats on save regardless of "editor.formatOnSave"”. | Tidy never hooks save at all. Format-on-save is owned entirely by VS Code; if `editor.formatOnSave` is off, nothing happens on save. | Review "Does not respect onSave: false"; issue [#143](https://github.com/lonefy/vscode-js-css-html-formatter/issues/143), [#131](https://github.com/lonefy/vscode-js-css-html-formatter/issues/131) |
| Makes itself the default formatter and **overrides other formatters**, "Formats code when you save it, regardless of your default formatter." / "Prevents every other formatter from working." | Tidy never contributes `editor.defaultFormatter` in its manifest, and never writes it without an explicit confirmation from you. If another formatter is your default, Tidy stays out of the way and works alongside it. | The two 1★ reviews quoted at left; issue [#57](https://github.com/lonefy/vscode-js-css-html-formatter/issues/57), "plugin ignores all other editor settings" |
| Breaks JSX, "It formats `<App />` to `< App / >`". | Tidy formats JSX/TSX with a real parser (Prettier under the hood for those languages), and a safety guard rejects any output where a JSX tag boundary was mangled, even when the broken output still happens to re-parse. | The 1★ review quoted at left; issues [#64](https://github.com/lonefy/vscode-js-css-html-formatter/issues/64), [#76](https://github.com/lonefy/vscode-js-css-html-formatter/issues/76) |
| Corrupts modern operators, “Changing my valid "?." to "? ." on save” and big-int literals like `1n` turned into `1 n`, producing syntax errors. | These are preserved exactly. If any engine ever produced output that changed program meaning, the AST-equivalence guard discards it and leaves the file untouched. | Issue [#146](https://github.com/lonefy/vscode-js-css-html-formatter/issues/146), title quoted at left; issue [#150](https://github.com/lonefy/vscode-js-css-html-formatter/issues/150), "breaks Null coalescing operator"; a 1★ review: "… big integer number like 1n are formatted as 1 n by it, which results in a syntax error" |
| Ignores your indent settings, "When saving using 2 spaces instead of tabs, it changes to 4 spaces." / "cannot set to 2 spaces". | Tidy honours `editor.tabSize` / `editor.insertSpaces` and the live `FormattingOptions` VS Code passes in, so 2-space projects stay 2-space with no config file. | Issues [#31](https://github.com/lonefy/vscode-js-css-html-formatter/issues/31), [#100](https://github.com/lonefy/vscode-js-css-html-formatter/issues/100), [#73](https://github.com/lonefy/vscode-js-css-html-formatter/issues/73) |
| Adds stray spaces in HTML attributes / class & id names, "… every time I save the file it just randomly add space to some class name or id name." | The HTML guard re-tokenises and tree-compares output (parse5); any change that alters the tree is rejected, so attribute and identifier text cannot drift. | Reviews "… randomly add space to some class name or id name …" and "… it would add whitespaces after all of my ids and classes …"; issue [#106](https://github.com/lonefy/vscode-js-css-html-formatter/issues/106), "HTML file auto add unexpected spaces in double quotes string value" |
| Breaks SCSS/CSS, "SASS interpolation breaks CSS `calc()` statement", and wraps mixins with `+`. | CSS/SCSS/LESS output is verified against a PostCSS tree before it is applied; structurally different output is dropped rather than written. | Issue [#74](https://github.com/lonefy/vscode-js-css-html-formatter/issues/74); review about `calc(#{…})` interpolation |
| Reformats files you never want touched, "It keeps re-formatting my packages.json, which is the last file you ever want to re-format." | Tidy only ever formats the document you explicitly invoke it on. It hooks no save event and creates no file watcher, and **no editor event can make Tidy format, edit or write anything**: the only two listeners it registers anywhere (active editor changed, settings changed) do nothing but repaint the status bar. Nothing is reformatted in the background. | The 1★ review quoted at left; issue [#134](https://github.com/lonefy/vscode-js-css-html-formatter/issues/134), "Json formatting is set to true by default!" |
| Cross-file corruption, "rewrites another files after copy-paste", "Reproducible bug, copying contents of files on file save". | Each format call returns edits for a single document only; there is no path by which one file's content can land in another. | Issues [#56](https://github.com/lonefy/vscode-js-css-html-formatter/issues/56), [#29](https://github.com/lonefy/vscode-js-css-html-formatter/issues/29), [#102](https://github.com/lonefy/vscode-js-css-html-formatter/issues/102), [#110](https://github.com/lonefy/vscode-js-css-html-formatter/issues/110) |

---

## Before / after

These are real inputs from this repo's [`samples/`](./samples) folder, run through *Format Document*. The point is not just that the output is tidy; it is that nothing in your code changed meaning along the way. Both "after" blocks are what Tidy's own `dispatchFormat` really prints at the documented default tab size of 4, character for character (the code fence's own surrounding newlines aside). The unit suite re-runs that pipeline on the same `samples/` files and fails if either block drifts.

**CSS**: collapsed, comma-jammed rules become readable, and the combinator and `calc()` survive intact:

```css
/* before, samples/messy.css */
.card{display:flex;padding:8px;color:red}
   #main   >   .item:nth-child(2n){margin:calc(100% - 20px);background:blue}
a:hover{text-decoration:underline}    .footer    {   gap : 12px  }
```

```css
/* after, at the default tab size of 4 */
.card {
    display: flex;
    padding: 8px;
    color: red
}

#main>.item:nth-child(2n) {
    margin: calc(100% - 20px);
    background: blue
}

a:hover {
    text-decoration: underline
}

.footer {
    gap: 12px
}
```

**TSX**: note what does **not** happen: `<div className="card" … />` stays a valid JSX element (no `< div / >`), and `n?.toString() ?? "none"` keeps its optional-chaining and nullish-coalescing operators exactly:

```tsx
// before, samples/messy.tsx
import {useState,useEffect} from "react"
type Props={title:string,count?:number}
export function Widget({title,count=0}:Props){
const [n,setN]=useState(count);useEffect(()=>{console.log(n?.toString()??"none")},[n])
return <div className="card"   onClick={()=>setN(n+1)}><h1>{title}</h1><span>{n}</span></div>
}
```

```tsx
// after
import { useState, useEffect } from "react";
type Props = { title: string; count?: number };
export function Widget({ title, count = 0 }: Props) {
    const [n, setN] = useState(count);
    useEffect(() => {
        console.log(n?.toString() ?? "none");
    }, [n]);
    return (
        <div className="card" onClick={() => setN(n + 1)}>
            <h1>{title}</h1>
            <span>{n}</span>
        </div>
    );
}
```

If either output had altered the parse tree (a mangled JSX tag, a `?.` split into `? .`), the equivalence guard would have discarded it and left your file untouched (see [Safety guarantees](#safety-guarantees) below).

---

## Safety guarantees

Tidy's core promise: **we will never write a file that fails an equivalence check against your original.** Concretely:

- **AST-equivalence guard (JS / TS / JSX / TSX).** After formatting, Tidy parses
  both the input and the output and compares them modulo whitespace and style.
  If they are not semantically equivalent, Tidy returns **zero edits** and your
  file is left exactly as it was. This includes a dedicated JSX tag-boundary
  check, so a mangled `< Foo bar = {x} />` is rejected *even though it still
  re-parses as valid TSX*. A parse-only check would let that corruption
  through; Tidy does not.
- **Re-tokenise + tree compare (CSS / SCSS / LESS / HTML).** For languages
  without a strict parse-or-fail AST, Tidy compares a PostCSS tree (CSS family)
  or a parse5 tree (HTML). Any output whose tree differs from the input's is
  discarded.
- **Value-level check (JSON / JSONC).** The parsed value must be unchanged.
- **Idempotence, verified in the test corpus, not per format.** `format(format(x))`
  equals `format(x)` for every fixture in the corpus, so your code does not drift
  to the right every time you reformat. To be exact: this is a property the test
  suite proves, **not** a check run on each format. Nothing is formatted twice at
  runtime to verify it, and no output is ever rejected for failing it. The checks
  that do run before every write are the equivalence checks above.
- **Single-document isolation.** A format call only ever produces edits for the
  document you invoked it on. No background watchers, no cross-pane copying.
- **No silent failures.** When the guard aborts, you get a non-blocking notice
  and a line in the *Tidy Formatter* output channel explaining why. That line is
  exhaustively: an ISO timestamp, the file's name, its language id, the engine id,
  the status, whether it was a selection, and one short sanitized reason (which,
  for a file skipped by an ignore rule, is the path of the `.soukformatignore`
  that excluded it, or, when Tidy could not evaluate that file, the reason why). **Tidy never copies your document into it**, and the reason
  is cut to its first line and capped at 200 characters before it is stored or
  printed, so a parser error's multi-line **code frame** (the excerpt of your file
  a parser prints under its message) can never reach it. What that cut keeps is
  the parser's own first line, and a parser sometimes names the token it choked on
  there, so that one short line can quote a few characters of the construct that
  failed. Nothing else of your file is ever recorded. Nothing is persisted and
  nothing leaves your machine.

If the guard ever aborts a format you expected to succeed, that is by design: the file is intact, and the alternative (writing potentially corrupted output) is exactly the failure mode Tidy exists to prevent.

### Fast startup, by design

Tidy's heavy machinery does not ship in the file VS Code loads at activation.
The Prettier printer and the three parser sets backing the safety guard
(`@babel/parser`, PostCSS, parse5) live in four separate chunks, each loaded the
first time a format actually needs it. Opening a file evaluates only the small
host bundle: no chunk is loaded to open, read or scroll a document. The one thing
that can evaluate a chunk without a format is the idle preloader described just
below, five seconds after activation, and only for the languages already on
screen at that instant.

Five seconds after activation, a one-shot timer reads the languages of the
editors **visible on screen at that instant** (`window.visibleTextEditors`: a file
sitting in a background tab is not among them) and warms only the chunks those
languages can reach:

| Visible editor | What the preloader warms |
|---|---|
| CSS, SCSS, LESS | the PostCSS verifier, nothing else |
| HTML | parse5. An embedded `<script>` or `<style>` pulls the JS or CSS verifier on first use, and only for a document that really contains one |
| JSON, JSONC | nothing at all: their printer and their value check are already in the host bundle |
| JavaScript | the Babel verifier |
| TypeScript, TSX, JSX | the Prettier printer and the Babel verifier |
| Vue | parse5 (splits and verifies the template) and the PostCSS verifier (styles). `<script>` stays verbatim and loads nothing |

A session with only stylesheets open therefore warms the PostCSS verifier and
nothing else. The chunk that carries the TypeScript printer is never *preloaded*
for such a session, and it is evaluated only when something really reaches it:
a TypeScript/TSX/JSX file, a `.js` file that turns out to contain JSX, or the CSS
second-chance fallback. That last one is worth spelling out, because it means
opening only stylesheets is not by itself a promise the chunk stays unloaded: if
the guard rejects a js-beautify stylesheet result, Tidy makes one independent
second attempt through Prettier's PostCSS printer, which ships in the very same
chunk as the TypeScript printer, and loading it then is exactly what the design
intends.

The timer is not an event hook: it reads that list of languages once and never
again, and registers no listener and no watcher. Closing or reloading the window
before it fires cancels it and leaves no work behind. Files you open afterwards
are not preloaded; they simply load their chunk on first use, like everything
else.

This changes nothing about safety. The guard runs the exact same verifier code,
always loaded **before** any write. If a chunk fails to load, Tidy aborts that
format and leaves your file untouched, and reports it as an engine failure
rather than as a rejection of your code: a verifier that could not run proves
nothing about what you wrote, and is never treated as a verifier that passed. A
chunk that fails to *preload* is only noted in the **Tidy Formatter** output
channel; it loads normally on first use.

---

## 60-second opt-in setup

Tidy does nothing on save until **you** opt in. That is deliberate: it is the opposite of the incumbent's "it formats whether you like it or not". Two independent choices:

**1. Format manually (no setup needed).**
Open any supported file and run **Format Document** (`Shift+Alt+F`) or select code and run **Format Selection**. If Tidy is the only formatter for that language it just works; otherwise pick it once via **Format Document With… → Tidy Formatter**.

**2. Make Tidy your default formatter (optional).**
Right-click in an editor → **Format Document With…** → **Configure Default Formatter…** → choose **Tidy Formatter**. Or in `settings.json`, per language:

```jsonc
{
  // Example: use Tidy for CSS, keep Prettier for everything else.
  "[css]": { "editor.defaultFormatter": "ced-lab.tidy-formatter" }
}
```

**3. Turn on format-on-save (optional).**
The **Tidy: Use Tidy as My Formatter** command offers this as a guided step: it
lists the exact `editor.formatOnSave` keys it would write for your chosen
languages, writes only after you confirm, and gives you a one-click **Revert**.
Prefer doing it by hand? It is the stock VS Code setting:

```jsonc
{
  "editor.formatOnSave": true
}
```

You can scope it per language so Tidy only runs on the languages you want:

```jsonc
{
  "[css][scss][less]": {
    "editor.formatOnSave": true,
    "editor.defaultFormatter": "ced-lab.tidy-formatter"
  }
}
```

That's it: there is no Tidy-specific "format on save" toggle, because Tidy delegates the entire save lifecycle to VS Code. The guided step above writes that same stock setting, nothing custom, and only for the languages you confirmed.

> **"It does nothing?"** If you installed Tidy and saving no longer reformats,
> that is expected: Tidy never auto-formats. Complete steps 2 and 3 above to
> choose the behaviour you want.

---

## Supported languages

| Language | Engine | Safety guard |
|---|---|---|
| CSS, SCSS, LESS | js-beautify | PostCSS tree compare |
| HTML | js-beautify | parse5 tree compare + template-island preservation |
| JSON, JSONC | jsonc-parser (**not** js-beautify) | parsed-value compare |
| JavaScript | js-beautify (real parser if JSX is detected) | AST equivalence (`@babel/parser`) |
| TypeScript | real parser (Prettier) | AST equivalence |
| TSX (TypeScript React) | real parser (Prettier) | AST equivalence |
| JSX (JavaScript React) | real parser (Prettier) | AST equivalence |
| Vue SFC (v1) | js-beautify html + CSS family per block | per-block parse5/PostCSS compare + whole-document SFC guard; `<script>` kept verbatim |

Plain `.js` files are formatted with js-beautify for familiarity, but if Tidy detects JSX inside them it automatically re-routes to the real parser rather than emit broken output.

Tidy also reads your project's **`.editorconfig`** cascade (honouring `root = true`) and maps `indent_style`, `indent_size` / `tab_width`, `end_of_line`, `insert_final_newline`, `trim_trailing_whitespace` and `max_line_length` (`off` means no limit). A team `.editorconfig` therefore wins over plain VS Code settings. Opt out with `"tidy.editorconfig": false`. In Restricted Mode the workspace `.editorconfig` is ignored (it is workspace-authored content), falling back to built-in and user settings.

For the files Prettier actually prints (TypeScript, TSX, JSX, and a plain `.js` file that turns out to contain JSX), Tidy also honours your project's existing **Prettier config**: the data variants (`.prettierrc`, `.prettierrc.json`/`.json5`/`.yaml`/`.yml`/`.toml`) or the `prettier` key of `package.json`, found in Prettier's own search order (nearest config wins, `package.json` first) but never above the workspace folder the file lives in. Only twelve AST-safe stylistic keys are read (`printWidth`, `tabWidth`, `useTabs`, `semi`, `singleQuote`, `jsxSingleQuote`, `trailingComma`, `bracketSpacing`, `bracketSameLine`, `arrowParens`, `singleAttributePerLine`, `objectWrap`); anything else, including `parser`, `plugins` and per-glob `overrides`, is ignored with a note in *Show Effective Configuration*, and a `prettier` key that names a shareable config instead of spelling out options is not resolved. Code-based configs (`.prettierrc.js`, `prettier.config.mjs`, ...) are **never executed**: when one is the nearest config, Tidy skips the layer entirely rather than guessing. The layer sits between `.editorconfig` and `.soukformatrc`, so your `.soukformatrc` keeps the last word. It applies to saved files inside a workspace folder (an untitled buffer has no project to read). Opt out with `"tidy.prettier.respectProjectConfig": false`. Always ignored in Restricted Mode.

**Line width follows the layer order too.** For the files Prettier prints, `tidy.wrap_line_length` (which is also where `.editorconfig`'s `max_line_length` and a `.soukformatrc` `wrap_line_length` land) and `tidy.prettier.printWidth` are two spellings of one value: Tidy takes the width from the highest layer that sets either, whichever key spelled it. So a `tidy.prettier.printWidth` in plain VS Code settings loses to an `.editorconfig` `max_line_length` and to a `.soukformatrc` `wrap_line_length`, and a `wrap_line_length` in VS Code settings loses to a `.soukformatrc` `printWidth`. Inside a single layer, `tidy.prettier.printWidth` wins over `wrap_line_length`, and a `[lang]` value beats a global one. A width of `0` (or an `.editorconfig` `max_line_length = off`) means no limit; a width nobody set is Prettier's default of 80.

Vue single-file components are supported since 1.0.0 (v1: template and style blocks; `<script>` is kept verbatim, see the Vue section below). `.sass` (indented syntax) and Astro components are **not** in this build; they remain on the roadmap.

---

## Languages & how Tidy formats each

Tidy handles every language below the same consent-first way: it reformats a file only when you run *Format Document* (`Shift+Alt+F`), *Format Selection*, or **Tidy: Preview Format (Diff)**, and you can make it the default for any subset of these languages in one step with **Tidy: Use Tidy as My Formatter** (`tidy.useAsFormatter`). Tidy declares activation on those ten languages and nothing else; since VS Code 1.74 an extension is additionally activated when one of its contributed commands is invoked, which is always something you started from the Command Palette or the status bar menu. Here is what each family covers.

### HTML

Tidy is a full HTML formatter and beautifier: it re-indents tags, normalises attribute spacing, and wraps long attribute lists the way you configure them (`tidy.wrap_attributes`). Trigger it with *Format Document* on any `.html` file, or set it as your HTML default via **Tidy: Use Tidy as My Formatter**. What separates it from the old JS-CSS-HTML Formatter is the parse5 tree comparison that runs after every format: if beautifying would add a stray space to a class or id name, or otherwise alter the document tree, Tidy discards the result and leaves your file untouched.

Two things inside an HTML file get different treatment, and it is worth being exact about which. **Templating syntax** (`{{ … }}`, `{% … %}` and `<% … %>`) is preserved **byte-for-byte**: each island is masked out before the engine runs and restored verbatim, so a beautifier can never inject whitespace inside a template tag. Embedded `<script>` and `<style>` bodies are **not** left alone: they are reformatted too, which is exactly what `tidy.indent_scripts` controls. What protects them is the guard rather than a mask, and it reads them as code: a `<style>` body is compared as a PostCSS tree, a JavaScript `<script>` body as a Babel AST plus its comment list (so a dropped licence header or `eslint-disable` is caught), and a `type="…json…"` body as a parsed value. A pure reindent therefore passes, and any change of meaning is rejected. A body whose declared language will not parse is held to a **byte-identical** comparison instead, never accepted on a guess.

A third thing decides whether Tidy writes at all: whether the whitespace it moved is *drawn*. HTML says so in three ways, and the guard models all three as one rule. The preformatted tags (`<pre>`, `<textarea>`, `<xmp>`, `<listing>`, `<plaintext>`) are handed to the printer as no-go zones and compared byte for byte. `xml:space="preserve"` (SVG) and the CSS property `white-space` (`pre`, `pre-wrap`, `pre-line`, `break-spaces`, or `white-space-collapse: preserve`) are read off the element, inherited by its whole subtree, and switched back off only by a declaration of their own kind: `white-space: normal` on a child cancels an inherited `white-space: pre`, never a `<pre>`. `pre-line` is modelled as what it is, collapsing runs of spaces while drawing newlines, so reflowing its spaces is accepted and losing a line break is not. The printer knows none of this (js-beautify's `content_unformatted` takes tag names only), so wherever whitespace is drawn and the printer moved it, Tidy **declines the format and leaves the file byte-identical** rather than write a page whose text a reader would see change. One case is refused rather than analysed: when an embedded `<style>` sets a preserving `white-space` value, deciding which elements its selectors match would take a CSS selector engine, so Tidy refuses that document instead of betting the rule matched nothing it touched. A stylesheet reached through `<link>` is not in the file at all, and is outside what any file-local check can see.

### CSS, SCSS & LESS

CSS, SCSS and LESS are all first-class: Tidy beautifies collapsed rules into readable blocks, aligns declarations, and controls selector and rule spacing (`tidy.selector_separator_newline`, `tidy.newline_between_rules`, `tidy.space_around_combinator`). Run *Format Document* on a `.css`, `.scss` or `.less` file, or opt in per language with **Tidy: Use Tidy as My Formatter**. Every result is checked against a PostCSS tree before it is written, so fragile constructs like `calc()` and SCSS interpolation (`#{…}`) survive formatting instead of being mangled.

### Vue (v1: template + style)

Tidy formats `.vue` single-file components with the same prove-it-first pipeline as everything else. The `<template>` block goes through the HTML engine and the parse5 tree guard (Vue directives such as `v-if`, `:prop` and `@event` are treated as opaque attributes and never rewritten); each `<style>` block goes through the CSS engine for its `lang` (css, scss or less) and the PostCSS tree guard for that dialect; `<script>` blocks, custom blocks (`<docs>`, `<i18n>`, ...) and everything between blocks are restored byte-for-byte. After reassembly, a dedicated whole-document guard re-splits the output and verifies block structure, block attributes and every block body; any doubt means zero edits.

Explicit v1 limits: `<script>` is not formatted yet (it is provably byte-identical instead); a `pug` template or a style dialect Tidy cannot verify (stylus, indented sass) makes the whole file a clean no-op; region ignore markers are not supported inside `.vue` (the top-of-file `<!-- tidy-ignore-file -->` marker works); formatting is whole-document only. The `vue` language itself comes from your Vue extension (for example Volar): without one, VS Code never activates Tidy for `.vue` files. Disable with `"tidy.vue.enable": false`.

### JavaScript & TypeScript

For JavaScript, Tidy uses js-beautify for a familiar layout and honours your indent settings (`editor.tabSize` / `editor.insertSpaces`) with no config file needed; TypeScript is formatted by Prettier under the hood. Format either with *Format Document*, or assign Tidy as the default formatter for those languages with **Tidy: Use Tidy as My Formatter**. Whichever engine runs, an AST-equivalence guard compares the parse tree before and after, so modern syntax such as optional chaining (`?.`), nullish coalescing (`??`) and BigInt literals (`1n`) is preserved exactly, and any output that would change program meaning is thrown away rather than written.

### JSX & TSX (React)

React files, `.jsx` and `.tsx`, are formatted with Prettier, the same engine most React teams already trust, so JSX elements reflow correctly instead of `<App />` turning into `< App / >`. Use *Format Document*, or pick these languages in **Tidy: Use Tidy as My Formatter** to make Tidy their default. On top of the AST check, a dedicated JSX tag-boundary guard rejects any output where a tag boundary was mangled (even when the broken result still happens to re-parse as valid TSX), and a plain `.js` file that actually contains JSX is automatically re-routed to the real parser rather than risk broken output.

### JSON & JSONC

Tidy formats both strict JSON and JSON-with-comments (JSONC): it re-indents and normalises structure while keeping comments intact for JSONC. Trigger it with *Format Document*, or enable it as your JSON default through **Tidy: Use Tidy as My Formatter**. Because the parsed value is compared before and after, formatting can never change the data your JSON represents, and since Tidy only ever touches the file you invoke it on, it will not reformat `package.json` behind your back.

---

## Works alongside Prettier

Tidy is a *configurable beautifier*, not an opinionated replacement for Prettier, and it is built to sit next to it, not on top of it.

- **Tidy never declares itself your default formatter.** It never contributes `editor.defaultFormatter` in its manifest, and never writes it without an explicit confirmation from you (the one command that writes it is [**Tidy: Use Tidy as My Formatter**](#commands), and before writing anything it shows you a **modal recap** of the exact `"[lang]": { "editor.defaultFormatter": "ced-lab.tidy-formatter" }` keys, the scope they go to, and the name of any formatter each one would replace; a language already pointing at Tidy is listed as such and is not rewritten). So it never silently takes over a language Prettier already owns. (The incumbent did the opposite: a 1★ review reports "Prevents every other formatter from working.", and issue [#57](https://github.com/lonefy/vscode-js-css-html-formatter/issues/57) is titled "plugin ignores all other editor settings".)
- **You assign each language yourself.** A common setup is Prettier for JS/TS and Tidy for CSS/HTML/JSON. Because nothing competes for the default slot, that split is just two per-language `editor.defaultFormatter` entries; both formatters stay installed and active, each on the languages you chose.
- **For TS, JSX and TSX, Tidy *is* Prettier under the hood.** Those languages are formatted by the same Prettier engine, then checked by Tidy's AST-equivalence guard. So even when Tidy is the formatter you invoked, the actual reflow on your React/TypeScript code is Prettier's; there is no second, conflicting style to reconcile.

In short: keep Prettier exactly as it is. Tidy only ever runs on the languages you explicitly hand it, and it gets out of the way everywhere else.

---

## Ignore & coexistence

Tidy gives you fine-grained control over *what* it touches and gets out of the way when another formatter already owns the project (three things the incumbent, not updated since 2017, never did; the leftmost column cites the issue or review that shows it). None of this can corrupt a file: every protected span is restored **verbatim**, so the equivalence guard sees output equal to the input and accepts it; if a splice ever produced non-parsable output the guard rejects it and your file is left intact.

| Capability | lonefy (#16, last updated 2017) | Tidy |
|---|---|---|
| Skip a region / node in-source | ✗ none ([#16](https://github.com/lonefy/vscode-js-css-html-formatter/issues/16)) | `tidy-ignore-start/end`, `// tidy-ignore`, `// prettier-ignore` |
| Exclude files project-wide | ✗ none | `.soukformatignore` (gitignore syntax) |
| Step back for Prettier/Biome/dprint/ESLint | ✗ takes the default slot: a 1★ review reports "Prevents every other formatter from working.", and issue [#57](https://github.com/lonefy/vscode-js-css-html-formatter/issues/57) "plugin ignores all other editor settings" | one-shot deference notice; **never** changes `editor.defaultFormatter` |

### In-source ignore directives

Write a comment (in the host language's syntax) to keep part of a file exactly as authored:

```css
/* tidy-ignore-start */
.keep   {  color : red ;  }   /* this block is preserved BYTE-for-BYTE */
/* tidy-ignore-end */

.rest { color: blue; }        /* …while everything else is reformatted */
```

- **Whole file**: a head comment containing `tidy-ignore-file`, `tidy-ignore`, or `prettier-ignore` (the first significant comment at the top) leaves the entire document untouched. One deliberate exception: a head comment that carries `tidy-ignore-start` or `tidy-ignore-end` is read as a **region** marker, never as a file-ignore, so a file whose very first comment is `/* tidy-ignore-start */` protects that region and formats the rest of the document normally.
- **A region**: `tidy-ignore-start` … `tidy-ignore-end` preserves everything in between, verbatim (markers included). An unterminated region protects to end-of-file (conservative: it protects more, never less).
- **The next node**: a lone `// tidy-ignore` or `// prettier-ignore` comment protects the node on the following line (best-effort, conservative line heuristic).

**Engine coverage.** For TS/TSX/JSX (the Prettier path) `// prettier-ignore` is honoured **natively at the node level** by Prettier itself, the richer, syntax-aware behaviour. For CSS/SCSS/LESS/HTML, JSON/JSONC and `javascript` (js-beautify, and jsonc-parser for JSON/JSONC) Tidy protects `tidy-ignore-*` **regions** itself via a mask-and-restore step behind the guard. That list is a list of **language ids**, not of engines, so it is not the same as "every path Prettier does not print": a `.js` file that contains JSX is routed to Prettier and is still region-masked by Tidy, and on that one path both mechanisms apply. Node-level masking on that path is best-effort: if a coarse span can't be spliced back safely, the guard simply rejects and the file stays intact (never corruption). Node-level directives are richest on the Prettier path; this mask-and-restore limitation is documented rather than risked.

**Format Selection and `// prettier-ignore`.** During *Format Selection* on the Prettier path, Prettier is handed only the selected lines, so it cannot see a `// prettier-ignore` comment that sits outside the selection. When the selection covers code that such a comment protects, Tidy writes nothing and tells you to use *Format Document* for that code; if it cannot parse the document to decide, it says so and formats the selection as before.

### `.soukformatignore`

Drop a `.soukformatignore` at your project root (or any sub-folder) to exclude files from formatting entirely: Tidy leaves them **byte-identical**. It uses familiar **gitignore syntax**:

```gitignore
# vendored / generated, never reformat
*.min.css
dist/
vendor/**/*.js

# …but DO keep this one tidy (negation re-includes it)
!vendor/keep.js
```

- **The patterns follow git's rules.** `*`, `?`, `**` and a trailing `/` (folders only) work as in `.gitignore`, and so do character classes and ranges (`[abc]`, `[!a]`, `[a-z]`); `***` behaves as `**`. A pattern without a `/` applies at any depth and to the contents of a folder. The file may start with a byte-order mark, leading spaces are kept as part of a pattern, and lines end at a line feed (a CRLF file works; a lone carriage return does not end a line, as in git).
- Last matching pattern wins; a later `!negation` re-includes a previously-excluded file. As in git, **a folder that is excluded cannot be re-included file by file**: to keep one file of `dist/`, exclude `dist/*` rather than `dist/`, then re-include the file.
- **Case**: on every OS, exclusion patterns ignore case (`DIST/` excludes `dist/`), while `!` re-inclusions respect it. In doubt, Tidy leaves the file alone.
- The lookup walks up from the file, as far as the root of the drive (a file opened outside any workspace folder included), and stops at the **first** `.soukformatignore` it finds: the nearest one wins outright. A `.soukformatignore` further up (your project root) is **not** merged into it, and is not consulted at all once a nearer one exists. Patterns are always matched relative to the folder holding the file that won.
- It is read only in **trusted** workspaces (ignored in Restricted Mode → the file is formatted). If the ignore file can't be read at all, Tidy fails **safe** and formats normally.
- **If Tidy can read the file but cannot evaluate it, it leaves the files it governs alone, and says why.** A file larger than 1 MiB, or too costly to evaluate (pathological patterns), excludes every file under that `.soukformatignore`'s folder. A line that cannot be evaluated (for example one over 1 024 characters, or ending in a lone backslash) does too, except the files that a later valid `!` line re-includes, until it is fixed or removed; a `!` line that cannot be evaluated excludes nothing and re-includes nothing. The reason appears in the output channel, in *Explain Last Format* and in *Show Effective Configuration*.
- Turn it off entirely with `"tidy.respectSoukformatignore": false`.

### Preview command (read-only diff + atomic undo)

Run **Tidy: Preview Format (Diff)** (`tidy.previewFormat`) from the Command Palette to see *exactly* what Tidy would change before committing to it:

- Opens a **read-only** side-by-side diff (original vs. formatted). Opening it writes nothing; your file's dirty state is unchanged.
- The preview runs the **same** pipeline as a normal format, including the equivalence guard. If the guard would reject the output, no diff opens and you get a non-blocking notice (file intact).
- Click **Apply** to write the result as a **single undo entry** (one `Ctrl+Z` fully reverts it). Dismiss the prompt and nothing is written.
- The diff is read-only, but the original document is not: you can keep typing in it while the diff is open. *Apply* therefore re-checks, at the last moment before writing, that the document is still byte-for-byte the text the guard verified. If it moved on, **nothing is written** and Tidy asks you to preview again, rather than overwriting your edits with output that was never checked against them.
- The preview honours the same pre-checks as *Format Document*, in the same order: the per-language `tidy.<lang>.enable` switch, the size cap, `.soukformatignore`, and top-of-file ignore markers. When one of them applies, Tidy tells you which and opens no diff, so a preview can never promise a change a real format would refuse.

No file at hand? Run **Tidy: Open Playground** first: it opens the two messy samples from this README as untitled scratch buffers, ready to preview.

### Status bar

For supported files, Tidy shows a single status bar item on the right. At rest it reflects the
active file's state: ready, turned off for the language, excluded by `.soukformatignore`, over
the `tidy.maxFileSizeKB` limit, or owned by another default formatter (named in the tooltip,
with how to switch). Right after a format attempt it briefly shows what happened
(`formatted`, `already tidy`, `guard blocked`, or the exact skip reason) before returning to
the passive state, so a silent no-op can no longer look like a broken extension.

Clicking the item opens a menu over three existing commands, under the menu's own
labels: **Explain last format**, **Preview format (diff)** and **Show effective
configuration** (the Command Palette lists the last one under its command title,
*Tidy: Show Effective Configuration*). The item is purely observational: it never
formats, never edits and never writes a setting. After its first paint
when Tidy activates, it repaints on exactly three occasions: you switch to another editor, a
setting in the `tidy` section or `editor.defaultFormatter` changes (a change to any other
setting is ignored), or a format attempt you invoked has just finished (it then shows the transient
result and returns to the passive state on its own). The first two are the **only** editor
events Tidy subscribes to anywhere in the extension
(`window.onDidChangeActiveTextEditor` and `workspace.onDidChangeConfiguration`); both do
nothing but redraw this item, so no editor event can start a format or produce an edit. The bar
and its tooltip carry this and nothing else: the active file’s language id, the engine id,
the status, a timestamp, whether the attempt was a selection, the same short sanitized
reason the output channel gets and, in the states that need one, the extension id of the
formatter that owns the language instead of Tidy, the size cap in KB, and the name of the
setting key involved (`tidy.<lang>.enable`, `tidy.maxFileSizeKB` or
`tidy.json.maxFileSizeKB`). Never your file’s name, never a line of its content, and a
parser message only as its first line, cut at 200 characters. Hide it with `tidy.statusBar.enable: false`.

### Deference behavior (coexisting with other formatters)

When a workspace already configures another formatter or fixer (Prettier via `.prettierrc*` or a `prettier` key in `package.json`, Biome via `biome.json`, dprint via `dprint.json`, or **ESLint** via `.eslintrc*` / `eslint.config.*` or an `eslintConfig` key in `package.json`), Tidy **surfaces** that fact once, and otherwise stays out of the way. ESLint is called out as what it is: it does not compete for the formatter slot, so the notice says its changes arrive through its own `eslint --fix` runs rather than implying a conflict. Controlled by `tidy.deferToOtherFormatters` (default `notify`):

| Value | Behavior |
|---|---|
| `notify` *(default)* | Show a **one-time**, informational notification per workspace naming the formatters and fixers it found (Prettier, Biome, dprint, ESLint). Deduplicated via `globalState`, never a repeat nag. |
| `silent-defer` | No notification, and nothing is read: Tidy does not scan the workspace for a competitor at activation in this mode. Writes nothing and disables nothing. |
| `off` | Ignore detection entirely (no read, no notification). |

**The anti-hijack contract (non-negotiable):** deference **never** changes `editor.defaultFormatter`, **never** disables Tidy silently, and **never** writes any setting on its own. The notification is purely informational: it reminds you that you can disable Tidy per language (`tidy.<lang>.enable`) for this workspace if you prefer the other tool to own formatting. The choice, and any write, is always yours. A `.prettierignore` on its own does **not** trigger deference (it only narrows what Prettier would touch, it doesn't configure Prettier as a formatter), and `.eslintignore` is excluded for the same reason. Detection reads workspace files only in **trusted** workspaces. Detecting a Prettier config and *reading* one are two separate things: the `.prettierrc` layer described under [Supported languages](#supported-languages) shapes Tidy's own output when you invoke it, while detection here only ever produces this one notice.

> Tip: run **Tidy: Show Effective Configuration** to see, for the active document, whether it would be skipped (`.soukformatignore` / in-source marker), how many regions are protected, and which competing formatters were detected.

---

## Key settings

All settings live under the `tidy.*` namespace. Indentation comes from your editor (`editor.tabSize` / `editor.insertSpaces`) unless you set `tidy.indent`, which overrides the editor's tab size; the other `tidy.*` values below are defaults, used when no layer sets them. A project config (`.editorconfig`, `.prettierrc`, `.soukformatrc`) wins over all of them.

| Setting | Default | What it does |
|---|---|---|
| `tidy.<lang>.enable` | `true` | Per-language switch (`tidy.css.enable`, `tidy.typescript.enable`, …). Set to `false` to remove Tidy as a formatter for that language. |
| `tidy.indent` | `4` | Indent size in spaces. When you set it, it overrides `editor.tabSize` (and the size VS Code detected in the file); a project config (`.editorconfig`, `.prettierrc`, `.soukformatrc`) still wins. Spaces versus tabs stays with `editor.insertSpaces`. |
| `tidy.brace_style` | `collapse` | Brace placement for JavaScript printed by js-beautify (`collapse`, `expand`, `end-expand`, `none`, `collapse-preserve-inline`). No effect on CSS, HTML or JSON, nor on TypeScript, TSX, JSX or a `.js` file that contains JSX, which Prettier prints. |
| `tidy.wrap_line_length` | `0` | Max characters per line before wrapping; `0` disables wrapping. Used for HTML and JavaScript (js-beautify) and, as the print width, for TypeScript, TSX and JSX (Prettier), where an unset value keeps Prettier's 80 and `0` means no limit. No effect on JSON, and js-beautify does not wrap CSS, SCSS or LESS by width. It shares one value with `tidy.prettier.printWidth`: whichever is set in the higher layer wins (see **Line width follows the layer order too**). |
| `tidy.wrap_attributes` | `auto` | How HTML attributes wrap (`auto`, `force`, `force-aligned`, `force-expand-multiline`, `aligned-multiple`, `preserve`, `preserve-aligned`). |
| `tidy.space_after_anon_function` | `false` | Add a space after an anonymous `function` keyword. |
| `tidy.maxFileSizeKB` | `5120` | Skip (with a notice) documents larger than this, so huge files never freeze the editor. `0` disables the guard. For JSON and JSONC, `tidy.json.maxFileSizeKB` takes precedence. |
| `tidy.json.maxFileSizeKB` | `10240` | Size cap for JSON/JSONC only; wins over `tidy.maxFileSizeKB` for these two languages. JSON formats on a fast linear path with a cheap value-equality guard, so big files like `package-lock.json` format instead of being skipped. `0` disables the cap. |
| `tidy.editorconfig` | `true` | Read the project's `.editorconfig` cascade and let it override plain VS Code settings. Set to `false` to ignore `.editorconfig`. |
| `tidy.prettier.respectProjectConfig` | `true` | Read the project's Prettier config (data variants of `.prettierrc*` or the `prettier` key in `package.json`) for the files Prettier prints (TypeScript/TSX/JSX, plus a `.js` file containing JSX), layered between `.editorconfig` and `.soukformatrc`. Data files only: code-based configs are never executed. Set to `false` to ignore it. Always ignored in Restricted Mode. |
| `tidy.soukformatrc` | `true` | Read the project's `.soukformatrc` file (JSONC) for per-language options and glob overrides, layered above `.editorconfig`. Set to `false` to ignore it. Always ignored in Restricted Mode. |
| `tidy.respectSoukformatignore` | `true` | Skip files matched by a project `.soukformatignore` (gitignore syntax), leaving them byte-identical. Set to `false` to format every file regardless. Always ignored in Restricted Mode. See [Ignore & coexistence](#ignore--coexistence). |
| `tidy.deferToOtherFormatters` | `notify` | How Tidy reacts when another formatter or fixer (Prettier/Biome/dprint/ESLint) is already configured: `notify` (one-time notice), `silent-defer` (no notice), or `off`. **Never** changes your default formatter. See [Deference behavior](#deference-behavior-coexisting-with-other-formatters). |
| `tidy.statusBar.enable` | `true` | Show the Tidy status bar item (passive file state + a short transient result after each attempt). Purely observational; see [Status bar](#status-bar). |

**The wider option set ("not enough options", fixed).** Beyond the headline knobs above, Tidy exposes **25** js-beautify options by family plus **10** AST-safe Prettier stylistic options for TS/JSX: 35 style settings in all. That is a curated subset, not the whole of js-beautify, which declares 47 options across its core/CSS/HTML/JavaScript modules; keys such as `end_with_newline`, `wrap_attributes_min_attrs` and `templating` are **not** exposed today. If one you need is missing, [open an issue](#feedback) and say which. A few of the 35:

| Setting | Applies to | What it does |
|---|---|---|
| `tidy.preserve_newlines` / `tidy.max_preserve_newlines` | CSS/SCSS/LESS, HTML, JavaScript | Keep existing blank lines (and cap how many). No effect on JSON, or on the files Prettier prints. |
| `tidy.space_in_paren`, `tidy.break_chained_methods`, `tidy.keep_array_indentation`, `tidy.comma_first`, `tidy.operator_position`, `tidy.space_before_conditional`, `tidy.jslint_happy` | JavaScript | Fine-grained js-beautify JS layout. |
| `tidy.selector_separator_newline`, `tidy.newline_between_rules`, `tidy.space_around_combinator` | CSS/SCSS/LESS | CSS rule + selector spacing. |
| `tidy.indent_inner_html`, `tidy.indent_scripts`, `tidy.wrap_attributes_indent_size`, `tidy.content_unformatted`, `tidy.void_elements` | HTML | HTML structure + attribute wrapping. The two tag lists can only **add** tag names: the tags the guard relies on (`pre`, `textarea`, `xmp`, `listing`, `plaintext`) stay protected whatever you write. |
| `tidy.prettier.singleQuote`, `tidy.prettier.semi`, `tidy.prettier.jsxSingleQuote`, `tidy.prettier.trailingComma`, `tidy.prettier.bracketSpacing`, `tidy.prettier.bracketSameLine`, `tidy.prettier.arrowParens`, `tidy.prettier.printWidth`, `tidy.prettier.singleAttributePerLine`, `tidy.prettier.objectWrap` | TS/TSX/JSX/JS | **Stylistic only**, quote style, semicolons, trailing commas, parens, line width, one JSX attribute per line, object-literal wrapping (`singleAttributePerLine` is for TSX, JSX and `.js` with JSX). Each is AST-invariant, so the equivalence guard still accepts the result. |

**Per-language overrides.** All 35 **style** options (the two tables of `tidy.*` formatting knobs above, from `tidy.indent` through `tidy.prettier.objectWrap`) are `language-overridable`, so you can scope any of them to one language in your `settings.json`. The **behaviour** switches are not: `tidy.<lang>.enable` is already per-language by construction, and `tidy.maxFileSizeKB`, `tidy.json.maxFileSizeKB`, `tidy.editorconfig`, `tidy.prettier.respectProjectConfig`, `tidy.soukformatrc`, `tidy.respectSoukformatignore`, `tidy.deferToOtherFormatters` and `tidy.statusBar.enable` cannot be put inside a `[language]` block. Their reach is not uniform, either: `tidy.editorconfig`, `tidy.prettier.respectProjectConfig`, `tidy.soukformatrc` and `tidy.respectSoukformatignore` are declared `resource`-scoped, so in a multi-root workspace each folder can carry its own value and Tidy reads the one belonging to the file being formatted. The rest (`tidy.<lang>.enable`, `tidy.maxFileSizeKB`, `tidy.json.maxFileSizeKB`, `tidy.deferToOtherFormatters` and `tidy.statusBar.enable`) are window-scoped: one value for the whole window, and a folder-level override of them is ignored by VS Code.

```jsonc
{
  "tidy.brace_style": "collapse",
  "[javascript]": { "tidy.brace_style": "expand" },
  "[typescript]": { "tidy.prettier.singleQuote": true }
}
```

**Project config, `.soukformatrc` (JSONC).** Drop a `.soukformatrc` at your project root to drive style per language (and per glob), shared across the team and layered above `.editorconfig`:

```jsonc
{
  // per-language sections (omit the "tidy." prefix)
  "css": { "indent": 2, "newline_between_rules": false },
  "typescript": { "singleQuote": true, "semi": false },
  // optional ordered glob overrides (most specific wins)
  "overrides": [
    { "files": "src/**/*.css", "options": { "indent": 8 } }
  ]
}
```

A malformed `.soukformatrc` never breaks formatting: it is ignored with a warning and Tidy falls back to the lower layers. If its `overrides` are too costly to evaluate (pathological globs), Tidy does not format the file rather than guess its options, and says why (output channel, *Explain Last Format*, status bar). It is read only in trusted workspaces, and it may start with a byte-order mark. The `files` globs of `overrides` follow the same git rules as `.soukformatignore`, with these differences: matching is **case-sensitive on every OS**, as in Prettier and EditorConfig, so a team file gives the same options everywhere; a leading `!` or `#` is an ordinary character (there is no re-include and no comment); trailing spaces are kept.

**Diagnosing your config:** run **Tidy: Show Effective Configuration** from the Command Palette to see every resolved option *and the exact source of each value* (VS Code global, `tidy.<lang>`, `.editorconfig`, `.prettierrc`, `.soukformatrc`, or a glob override). This is the direct answer to "why is it indenting with 4 spaces?", no guesswork, no hours of debugging.

**Finding out who reformats a file:** run **Tidy: Who Formats This File?** when a file changes and you cannot tell which extension is responsible. It reports, read-only, the default formatter for the file's language and the settings scope that set it, what happens on save, whether the JS-CSS-HTML Formatter is present, and which other formatters the workspace is configured for. It cannot see an extension that formats on save through its own save hook, because VS Code gives extensions no way to observe that; the report says so every time and points to *Help: Start Extension Bisect*.

### Commands

All nine Tidy commands live in the Command Palette (`Ctrl+Shift+P`) under the **Tidy**
category, but three of them are **gated on the active language** and are listed only while a
file Tidy supports is focused: *Show Effective Configuration*, *Preview Format (Diff)* and
*Explain Last Format* all carry `"enablement": "editorLangId in tidy.supportedLanguages"` in
the manifest. The other six are always listed.

| Command id | Title | What it does |
|---|---|---|
| `tidy.showEffectiveConfiguration` | Tidy: Show Effective Configuration | Shows every resolved option and the exact source of each value. |
| `tidy.useAsFormatter` | Tidy: Use Tidy as My Formatter | Opt in per language: writes `editor.defaultFormatter` (Workspace by default) for the languages you pick, then optionally `editor.formatOnSave` for the same languages, each only after an explicit confirmation with an exact recap; the format-on-save write has a one-click Revert. Cancelling writes nothing. |
| `tidy.runMigration` | Tidy: Migrate from JS-CSS-HTML Formatter | Imports lonefy's real configuration (its `.vscode/formatter.json`, else its global `formatter.json`, else a `.jsbeautifyrc`) into `tidy.*` settings after a confirmation recap (trusted workspaces only), then optionally runs *Use Tidy as My Formatter*. The import never enables format on save; that follow-up asks about it separately and enables it only after your confirmation. |
| `tidy.previewFormat` | Tidy: Preview Format (Diff) | Opens a **read-only** diff of what Tidy would change, then applies it on an explicit *Apply* click as a **single undo entry**. Opening the diff writes nothing. See [Preview command](#preview-command-read-only-diff--atomic-undo). |
| `tidy.openPlayground` | Tidy: Open Playground | Opens two **untitled** scratch documents (the messy CSS and TSX samples from this README) so you can try **Preview Format (Diff)** in 30 seconds without touching any file on disk. It opens editors and nothing else: no file is created, no setting is written. |
| `tidy.reportIssue` | Tidy: Report an Issue | Opens a **prefilled GitHub issue** with your environment (Tidy version, VS Code version, OS, the active file's language) already filled in, so a bug report takes seconds. Read-only: it opens a browser tab and writes nothing. |
| `tidy.explainLastFormat` | Tidy: Explain Last Format | Tells you what Tidy's most recent format did on the active file, or **why it did nothing** (safety guard, an ignore rule, the size limit, another default formatter, a disabled language). Per-file: it answers for the file you are looking at, not for whatever Tidy formatted last. It reads the same bounded session window as *Show Format History* (the 50 most recent attempts, all files together), so once 50 later attempts have pushed a file's record out of that window, Tidy reports that it has not formatted that file this session. Writes a content-free trace to the **Tidy Formatter** output channel. Read-only. |
| `tidy.whoFormats` | Tidy: Who Formats This File? | Tells you, for the active file, which extension and which settings would format it, and what happens on save: the default formatter and the scope that set it, `editor.formatOnSave` and the other save-time settings, whether lonefy is present, and which other formatters the workspace is configured for. The report goes to the **Tidy Formatter** output channel, with a short answer in a notification. It also states what no API can show: an extension that formats on save through its own save hook (VS Code's *Help: Start Extension Bisect* finds it). Read-only: it writes no setting and no file, and it is listed whatever language is focused. |
| `tidy.showFormatHistory` | Tidy: Show Format History | A chronological view of this session's format attempts (the 50 most recent across all files, newest first): status icon, file, language and age. Older attempts are dropped, and the list starts empty again after a window reload. Picking an entry writes the full explanation to the **Tidy Formatter** output channel. In-memory only, content-free, read-only. |

---

## FAQ

**How do I format HTML, CSS and JavaScript in VS Code?**
Open the file and run **Format Document** (`Shift+Alt+F`), or select a block and run **Format Selection**. VS Code needs a formatter registered for that language; Tidy provides one for HTML, CSS, SCSS, LESS, JavaScript, TypeScript, JSX/TSX and JSON. If more than one formatter is installed, pick which runs with **Format Document With… → Tidy Formatter**, or set it per language via **Tidy: Use Tidy as My Formatter**. Nothing formats automatically until you enable `editor.formatOnSave` yourself.

**Is there a VS Code formatter that only runs when I ask, not on save?**
Yes, that is Tidy's whole design. It registers *only* as an on-demand formatting provider (*Format Document* / *Format Selection*), never hooks the save event, and never sets `editor.formatOnSave` or `editor.defaultFormatter` behind your back: both are written only inside the guided opt-in command, after you confirm an exact recap of the keys, with one-click revert for format on save. So it formats exactly when you invoke it and stays silent otherwise. If you *want* format-on-save later, run that command or enable the stock VS Code setting yourself; see [60-second opt-in setup](#60-second-opt-in-setup).

**Why does VS Code keep formatting my code on save?**
Something in your setup has `editor.formatOnSave` enabled and a default formatter assigned for that language, often an extension that made itself the default without asking. VS Code, not the extension, owns the save trigger, so the fix is to turn off `editor.formatOnSave` (globally or per language) or change `editor.defaultFormatter`. If code is *still* reformatted with format-on-save off, an extension is hooking save itself; disabling or uninstalling it is the only reliable fix. Tidy deliberately never hooks save, so it can never be the cause.

**How do I stop an extension from formatting on save?**
Start by setting `"editor.formatOnSave": false`; you can scope it per language, e.g. `"[javascript]": { "editor.formatOnSave": false }`. If code is still reformatted on save, the culprit is an extension that registers its own save handler instead of relying on VS Code's (the JS-CSS-HTML Formatter is a well-known example), and you have to disable or uninstall that extension from the Extensions view. No other extension, Tidy included, can turn off a save hook that a different extension installed.

**Is there a safe alternative to JS-CSS-HTML Formatter?**
That is exactly why Tidy exists. It covers the same languages (JavaScript, TypeScript, JSX/TSX, CSS, SCSS, LESS, HTML and JSON) but never formats on save unless you turn that on, never makes itself the default formatter without asking, and never writes a setting unless you confirm it. Every format is verified against your original (AST for JS/TS/JSX/TSX, tree compare for CSS/HTML, value compare for JSON), so it cannot produce the corrupted output the incumbent was reported for. See [Migrating from JS-CSS-HTML Formatter](#migrating-from-js-css-html-formatter) for a two-minute switch.

**How is Tidy different from Prettier?**
Prettier is opinionated: it enforces one canonical style with very few knobs. Tidy is a *configurable* beautifier that respects your VS Code and project settings, so it fills the "lots of options" niche the JS-CSS-HTML Formatter used to. The two are built to coexist (a common setup is Prettier for JS/TS and Tidy for CSS/HTML/JSON), and for TypeScript, JSX and TSX Tidy actually runs Prettier under the hood, then adds its own equivalence guard on top. See [Works alongside Prettier](#works-alongside-prettier).

**Does Tidy work in Cursor, Windsurf or VSCodium?**
Tidy is a standard VS Code extension with no proprietary Marketplace dependencies, so it runs in editors built on VS Code (Cursor, Windsurf, VSCodium and similar). It is published on **both** the Visual Studio Marketplace and the [Open VSX Registry](https://open-vsx.org/extension/ced-lab/tidy-formatter), so editors that use Open VSX (VSCodium, Cursor, Windsurf, Gitpod, code-server…) can install it straight from their Extensions view, no manual `.vsix` needed. Nothing in the formatting pipeline is tied to a specific distribution.

**Will Tidy break my JSX or modern JS?**
No. JSX, TSX and TypeScript are formatted with a real parser (Prettier), not a token-level find-and-replace, so `<App />` stays `<App />`. On top of that, the AST-equivalence guard, plus a dedicated JSX tag-boundary check, compares the parse tree before and after and discards any output that changed meaning, so optional chaining (`?.`), nullish coalescing (`??`) and BigInt literals (`1n`) are always preserved. If a format ever couldn't be proven safe, you get zero edits and an intact file.

**Will Tidy format my files on save?**
Only if *you* enable `editor.formatOnSave` and select Tidy as the default formatter for that language, either by hand or through the guided **Tidy: Use Tidy as My Formatter** command, which shows the exact keys it would write and does nothing until you confirm. Out of the box it does nothing on save, and it never installs a save hook of its own.

**Will it override Prettier / ESLint / my chosen formatter?**
No. Tidy never contributes `editor.defaultFormatter` in its manifest, and never writes it without an explicit confirmation from you: the only write happens inside **Tidy: Use Tidy as My Formatter**, for the languages you tick, after you confirm. If another formatter is your default, Tidy does not run unless you explicitly invoke it.

**I installed it and nothing happens when I save. Is it broken?**
No, that is the intended default. If you are not sure what happened, run **Tidy: Explain Last Format** from the Command Palette: it tells you exactly what Tidy did on the active file, or why it did nothing (for example, another formatter owns the language, or the safety guard rejected the result). See [60-second opt-in setup](#60-second-opt-in-setup) to choose the behaviour you want.

**Can it corrupt my code?**
Tidy refuses to apply any output that fails its equivalence guard (AST for JS/TS/JSX/TSX, tree compare for CSS/HTML, value compare for JSON). If formatting would change meaning, you get zero edits and an intact file plus a notice.

**Does it support JSX and TypeScript?**
Yes, JSX, TSX, and TypeScript are formatted with a real parser, not a token mangler, and are covered by the AST guard.

**Does it send my code anywhere?**
No. Tidy is 100% client-side: nothing your file contains is transmitted, persisted or written anywhere but back into your own document. It does not phone home, and the output-channel diagnostics carry no copy of your source (see [Safety guarantees](#safety-guarantees) for exactly what a sanitized reason can contain).

**Does it work in Restricted Mode / virtual workspaces / Codespaces?**
It declares support for untrusted and virtual workspaces. In Restricted Mode it falls back to built-in and user settings rather than workspace-defined config.

**How do I stop Tidy from formatting a specific language?**
Set `tidy.<lang>.enable` to `false` (e.g. `"tidy.json.enable": false`), or simply don't choose it as the default formatter for that language.

**Can Tidy format large files like `package-lock.json`?**
Yes. JSON and JSONC have their own size cap, `tidy.json.maxFileSizeKB` (default `10240` KB), which takes precedence over the generic `tidy.maxFileSizeKB` (default `5120` KB). JSON gets the higher default because Tidy formats it on a fast linear path and verifies the result with a cheap value-equality check, so a 10 MB `package-lock.json` formats well inside the performance budget instead of freezing the editor. Other languages keep the stricter cap because their engines and safety checks are heavier. Precedence in one line: an explicitly set `tidy.json.maxFileSizeKB` wins for JSON/JSONC; if it is unset, an explicitly set `tidy.maxFileSizeKB` still applies; otherwise each family uses its own default. If Tidy skips a file, run **Tidy: Explain Last Format**: it names the applied cap, its setting key and its source, so you know exactly which knob to raise. Set either cap to `0` to disable it.

**How do I stop Tidy from touching a specific file or region?**
Three ways, all covered in [Ignore & coexistence](#ignore--coexistence): a `.soukformatignore` (gitignore syntax) excludes files project-wide; `tidy-ignore-start`/`tidy-ignore-end` comments preserve a region byte-for-byte; and a head `tidy-ignore-file` / `// prettier-ignore` comment skips the whole file.

**Another formatter (Prettier/Biome) is already set up. Will Tidy fight it?**
No. Tidy detects it and shows a one-time, informational notice (`tidy.deferToOtherFormatters`, default `notify`). That detection path writes nothing at all: it never changes `editor.defaultFormatter` and never disables Tidy silently; see [Deference behavior](#deference-behavior-coexisting-with-other-formatters).

**Can I preview a format before applying it?**
Yes, run **Tidy: Preview Format (Diff)** for a read-only side-by-side diff, then *Apply* it as a single undo entry. See [Preview command](#preview-command-read-only-diff--atomic-undo).

**Does it read `.editorconfig`?**
Yes. Tidy reads the `.editorconfig` cascade (respecting `root = true`) and maps the common keys (`indent_style`, `indent_size`/`tab_width`, `end_of_line`, `insert_final_newline`, `trim_trailing_whitespace`, `max_line_length`, where `off` means no limit). Disable with `"tidy.editorconfig": false`.

**Can I configure it with a project file?**
Yes. Tidy reads a `.soukformatrc` (JSONC) from your project root, per-language sections plus ordered glob `overrides`, layered above `.editorconfig` and shared across the team. See [Key settings](#key-settings) for the schema. (YAML support is on the roadmap.)

**Does Tidy read my `.prettierrc`?**
Yes, for the files Prettier prints: TypeScript, TSX, JSX, and a plain `.js` file that contains JSX. Tidy reads the same data config files Prettier does (`.prettierrc`, `.prettierrc.json`/`.json5`/`.yaml`/`.yml`/`.toml`, or the `prettier` key of `package.json`), in Prettier's own search order but never above your workspace folder, and honours the twelve AST-safe stylistic keys, layered between `.editorconfig` and `.soukformatrc`. Code-based configs (`.prettierrc.js` and friends) are never executed, and a shareable config reference is not resolved. Disable with `"tidy.prettier.respectProjectConfig": false`.

**Where's the indented-`.sass` / Vue support?**
Vue SFCs are supported since 1.0.0 (v1: template + style under guard, `<script>` kept verbatim, see [Vue](#vue-v1-template--style)). Indented `.sass` is not in this build. The remaining roadmap covers `.soukformatrc` YAML, real CSS-in-JS reformatting, Vue `<script>` formatting, and more languages. Ignore directives, `.soukformatignore`, the preview diff, deference notifications, and Open VSX distribution **are** shipped, see [Ignore & coexistence](#ignore--coexistence).

---

## Feedback

Found a bug or a file Tidy got wrong? A reproducible input is worth a thousand stars: open an issue with the smallest snippet that reproduces it. The fastest way is the **Tidy: Report an Issue** command (Command Palette → *Tidy: Report an Issue*): it opens a prefilled GitHub issue with your Tidy version, VS Code version, OS and active language already filled in, so you only have to paste the snippet. If Tidy has saved you from a save-on-format disaster, you're welcome to [leave a review](https://marketplace.visualstudio.com/items?itemName=ced-lab.tidy-formatter). No in-product nagging, ever.

## License

[MIT](./LICENSE). See [CHANGELOG.md](./CHANGELOG.md) for release history.
