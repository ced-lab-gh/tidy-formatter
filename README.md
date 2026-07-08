# Tidy — JS/CSS/HTML Formatter & Beautifier

**Format & beautify JavaScript, TypeScript, JSX/TSX, CSS, SCSS, LESS, HTML & JSON — safely. Tidy respects your VS Code config and never auto-formats or hijacks your files unless you ask.**

[![Version](https://img.shields.io/visual-studio-marketplace/v/ced-lab.tidy-formatter?label=Marketplace&color=168F7D)](https://marketplace.visualstudio.com/items?itemName=ced-lab.tidy-formatter)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/ced-lab.tidy-formatter?label=installs&color=168F7D)](https://marketplace.visualstudio.com/items?itemName=ced-lab.tidy-formatter)
[![Rating](https://img.shields.io/visual-studio-marketplace/r/ced-lab.tidy-formatter?label=rating&color=168F7D)](https://marketplace.visualstudio.com/items?itemName=ced-lab.tidy-formatter&ssr=false#review-details)
[![License: MIT](https://img.shields.io/badge/License-MIT-168F7D.svg)](./LICENSE)

Tidy is a configurable beautifier for JavaScript, TypeScript, JSX/TSX, CSS, SCSS, LESS, HTML and JSON. It does exactly one thing: it reformats a file **when you ask it to** — via *Format Document* or *Format Selection* — and it refuses to write a file back unless the result is provably equivalent to what you started with. It never registers itself as your default formatter, never hooks "save", and never touches a file you didn't tell it to.

If you arrived here after a formatter quietly rewrote your code on save, that is the exact behaviour Tidy is built to make impossible.

---

## Migrating from JS-CSS-HTML Formatter

[JS-CSS-HTML Formatter](https://marketplace.visualstudio.com/items?itemName=lonefy.vscode-JS-CSS-HTML-formatter) (`lonefy.vscode-JS-CSS-HTML-formatter`) is a popular beautifier (~3.95M installs) that has not been updated since 2017 and sits at roughly 1.7★. Most of its one-star reviews are not about *bad* formatting — they are about a formatter that acts **without consent**: it formats on save even when you disabled it, makes itself the default formatter, overrides your editor settings, and occasionally breaks valid code. Tidy is a clean-room replacement that keeps the "configurable beautify" niche while removing the destructive behaviour.

**Recommended migration (2 minutes), in this order:**

1. **Disable or uninstall** JS-CSS-HTML Formatter
   (Extensions view → search "JS-CSS-HTML" → *Disable* / *Uninstall*).
   This is the single most important step: while it is enabled it can keep
   formatting on save regardless of your settings. Tidy **cannot** disable
   another extension for you (no VS Code API allows it), so it only *guides* you
   here — it never claims to have turned lonefy off.
2. **Install Tidy Formatter.** It will *not* take over on save automatically and
   it writes **no** settings at install time.
3. **Opt in** to the behaviour you actually want — see
   [60-second opt-in setup](#60-second-opt-in-setup) below, or use the guided
   commands described next.

> **Tidy never enables `editor.formatOnSave` or sets `editor.defaultFormatter`
> without an explicit action from you.** Nothing is written at startup, on save,
> or in the background. The two commands below are the *only* way Tidy writes a
> setting, and each writes only after you confirm exactly what will change.

### Guided migration commands

Both commands live in the Command Palette (`Ctrl+Shift+P`) under the **Tidy**
category, and both are also reachable from the *Get started with Tidy Formatter*
walkthrough:

- **`tidy.useAsFormatter`** — *“Tidy: Use Tidy as my Formatter”*. Pick the
  languages you want, choose a scope (**Workspace** by default, **User**
  optional), and Tidy writes `editor.defaultFormatter` (override-in-language)
  for just those languages. It writes **nothing else** — never
  `editor.formatOnSave` — and cancelling the picker writes nothing at all. The
  success message offers a passive button that *opens* the `editor.formatOnSave`
  setting so you can decide for yourself.
- **`tidy.runMigration`** — *“Tidy: Migrate from JS-CSS-HTML Formatter”*. Reads
  your project’s `.jsbeautifyrc` (best-effort, and **only** when the workspace is
  trusted — ignored in Restricted Mode), shows a recap of exactly which `tidy.*`
  settings it would import, and writes them at Workspace scope **only after you
  confirm**. It then offers (separately, opt-in) to run `tidy.useAsFormatter`,
  and a button to open the Extensions view on lonefy so you can disable it.

If lonefy is detected when Tidy activates, you may also see a single, non-modal
notification offering to migrate. It is **one-shot and deduplicated**: it appears
at most once per machine/profile, has a **“Don’t ask again”** action, and is
never repeated — the incumbent’s #1 complaint was its intrusiveness, so Tidy will
not nag.

### What gets imported from `.jsbeautifyrc`

`tidy.runMigration` maps the legacy js-beautify options the incumbent read to
their Tidy equivalents. Five keys carry over faithfully; any unrecognised key is
surfaced as *“not carried over”* (never written), and any recognised key with an
out-of-range value is reported and dropped (never written):

| `.jsbeautifyrc` key (lonefy) | Tidy setting | Notes |
|---|---|---|
| `indent_size` | `tidy.indent` | Integer in `[1, 16]`; out-of-range values are dropped with a note. |
| `brace_style` | `tidy.brace_style` | One of `collapse`, `expand`, `end-expand`, `none`, `collapse-preserve-inline`. |
| `wrap_line_length` | `tidy.wrap_line_length` | Non-negative integer; `0` disables wrapping. |
| `wrap_attributes` | `tidy.wrap_attributes` | One of `auto`, `force`, `force-aligned`, `force-expand-multiline`, `aligned-multiple`, `preserve`, `preserve-aligned`. |
| `space_after_anon_function` | `tidy.space_after_anon_function` | Boolean. |

`.jsbeautifyrc` import is a **best-effort convenience, not a marketing promise** —
most lonefy users ran it with no config at all. Tidy also reads your existing VS
Code settings (`editor.tabSize`, `editor.insertSpaces`, per-language overrides)
directly, so in most cases there is nothing to port over.

---

## What lonefy breaks → what Tidy fixes

Every row below is sourced from a real Marketplace review or GitHub issue on the incumbent. Where a quote is shortened, the meaning is preserved.

| What JS-CSS-HTML Formatter does | What Tidy does instead | Source |
|---|---|---|
| Formats on save **even when you turned `formatOnSave` off** — "Does not respect onSave: false." / "Always formats on save regardless of `editor.formatOnSave`". | Tidy never hooks save at all. Format-on-save is owned entirely by VS Code; if `editor.formatOnSave` is off, nothing happens on save. | Review "Does not respect onSave: false"; issue [#143](https://github.com/lonefy/vscode-js-css-html-formatter/issues/143), [#131](https://github.com/lonefy/vscode-js-css-html-formatter/issues/131) |
| Makes itself the default formatter and **overrides other formatters** — "Formats code when you save it, regardless of your default formatter." / "Prevents every other formatter from working." | Tidy never contributes or sets `editor.defaultFormatter`. If another formatter is your default, Tidy stays out of the way and works alongside it. | Reviews "Completely broken… regardless of your default formatter", "Prevents every other formatter from working"; issue [#92](https://github.com/lonefy/vscode-js-css-html-formatter/issues/92) |
| Breaks JSX — "It formats `<App />` to `< App / >`". | Tidy formats JSX/TSX with a real parser (Prettier under the hood for those languages), and a safety guard rejects any output where a JSX tag boundary was mangled — even when the broken output still happens to re-parse. | Review "It formats `<App />` to `< App / >`"; issues [#64](https://github.com/lonefy/vscode-js-css-html-formatter/issues/64), [#76](https://github.com/lonefy/vscode-js-css-html-formatter/issues/76) |
| Corrupts modern operators — "Changing my valid `?.` to `? .` on save" and big-int literals like `1n` turned into `1 n`, producing syntax errors. | These are preserved exactly. If any engine ever produced output that changed program meaning, the AST-equivalence guard discards it and leaves the file untouched. | Issue [#146](https://github.com/lonefy/vscode-js-css-html-formatter/issues/146) ("`?.` → `? .`"), [#150](https://github.com/lonefy/vscode-js-css-html-formatter/issues/150); review about `1n` → `1 n` |
| Ignores your indent settings — "When saving using 2 spaces instead of tabs, it changes to 4 spaces." / "cannot set to 2 spaces". | Tidy honours `editor.tabSize` / `editor.insertSpaces` and the live `FormattingOptions` VS Code passes in, so 2-space projects stay 2-space with no config file. | Issues [#31](https://github.com/lonefy/vscode-js-css-html-formatter/issues/31), [#100](https://github.com/lonefy/vscode-js-css-html-formatter/issues/100), [#73](https://github.com/lonefy/vscode-js-css-html-formatter/issues/73) |
| Adds stray spaces in HTML attributes / class & id names — "every time I save the file it just randomly add space to some class name or id name." | The HTML guard re-tokenises and tree-compares output (parse5); any change that alters the tree is rejected, so attribute and identifier text cannot drift. | Reviews "randomly add space to some class name or id name", "adds whitespace after all of my ids and classes"; issues [#106](https://github.com/lonefy/vscode-js-css-html-formatter/issues/106), [#41](https://github.com/lonefy/vscode-js-css-html-formatter/issues/41) |
| Breaks SCSS/CSS — "SASS interpolation breaks CSS `calc()` statement", and wraps mixins with `+`. | CSS/SCSS/LESS output is verified against a PostCSS tree before it is applied; structurally different output is dropped rather than written. | Issue [#74](https://github.com/lonefy/vscode-js-css-html-formatter/issues/74); review about `calc(#{…})` interpolation |
| Reformats files you never want touched — "It keeps re-formatting my package.json". | Tidy only ever formats the document you explicitly invoke it on; it has no save/focus/file-watcher triggers, so nothing is reformatted in the background. | Review "keeps re-formatting my package.json"; issue [#134](https://github.com/lonefy/vscode-js-css-html-formatter/issues/134) |
| Cross-file corruption — "rewrites another files after copy-paste" / "copying contents of files on file save". | Each format call returns edits for a single document only; there is no path by which one file's content can land in another. | Issues [#56](https://github.com/lonefy/vscode-js-css-html-formatter/issues/56), [#29](https://github.com/lonefy/vscode-js-css-html-formatter/issues/29), [#102](https://github.com/lonefy/vscode-js-css-html-formatter/issues/102), [#110](https://github.com/lonefy/vscode-js-css-html-formatter/issues/110) |

---

## Before / after

These are real inputs from this repo's [`samples/`](./samples) folder, run through *Format Document*. The point is not just that the output is tidy — it is that nothing in your code changed meaning along the way.

**CSS** — collapsed, comma-jammed rules become readable, and the combinator and `calc()` survive intact:

```css
/* before — samples/messy.css */
.card{display:flex;padding:8px;color:red}
   #main   >   .item:nth-child(2n){margin:calc(100% - 20px);background:blue}
a:hover{text-decoration:underline}    .footer    {   gap : 12px  }
```

```css
/* after */
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

**TSX** — note what does **not** happen: `<div className="card" … />` stays a valid JSX element (no `< div / >`), and `n?.toString() ?? "none"` keeps its optional-chaining and nullish-coalescing operators exactly:

```tsx
// before — samples/messy.tsx
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

If either output had altered the parse tree — a mangled JSX tag, a `?.` split into `? .` — the equivalence guard would have discarded it and left your file untouched (see [Safety guarantees](#safety-guarantees) below).

---

## Safety guarantees

Tidy's core promise: **we will never write a file that fails an equivalence check against your original.** Concretely:

- **AST-equivalence guard (JS / TS / JSX / TSX).** After formatting, Tidy parses
  both the input and the output and compares them modulo whitespace and style.
  If they are not semantically equivalent, Tidy returns **zero edits** and your
  file is left exactly as it was. This includes a dedicated JSX tag-boundary
  check, so a mangled `< Foo bar = {x} />` is rejected *even though it still
  re-parses as valid TSX* — a parse-only check would let that corruption
  through; Tidy does not.
- **Re-tokenise + tree compare (CSS / SCSS / LESS / HTML).** For languages
  without a strict parse-or-fail AST, Tidy compares a PostCSS tree (CSS family)
  or a parse5 tree (HTML). Any output whose tree differs from the input's is
  discarded.
- **Value-level check (JSON / JSONC).** The parsed value must be unchanged.
- **Idempotence.** `format(format(x))` equals `format(x)`, so your code does not
  drift to the right every time you reformat.
- **Single-document isolation.** A format call only ever produces edits for the
  document you invoked it on. No background watchers, no cross-pane copying.
- **No silent failures.** When the guard aborts, you get a non-blocking notice
  and a line in the *Tidy Formatter* output channel explaining why. That detail
  **never contains your source code** — only the language, engine, and a short
  reason.

If the guard ever aborts a format you expected to succeed, that is by design: the file is intact, and the alternative (writing potentially corrupted output) is exactly the failure mode Tidy exists to prevent.

---

## 60-second opt-in setup

Tidy does nothing on save until **you** opt in. That is deliberate — it is the opposite of the incumbent's "it formats whether you like it or not". Two independent choices:

**1. Format manually (no setup needed).**
Open any supported file and run **Format Document** (`Shift+Alt+F`) or select code and run **Format Selection**. If Tidy is the only formatter for that language it just works; otherwise pick it once via **Format Document With… → Tidy Formatter**.

**2. Make Tidy your default formatter (optional).**
Right-click in an editor → **Format Document With…** → **Configure Default Formatter…** → choose **Tidy Formatter — JS/CSS/HTML**. Or in `settings.json`, per language:

```jsonc
{
  // Example: use Tidy for CSS, keep Prettier for everything else.
  "[css]": { "editor.defaultFormatter": "ced-lab.tidy-formatter" }
}
```

**3. Turn on format-on-save yourself (optional).**
This is a stock VS Code setting that Tidy never sets for you:

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

That's it — there is no Tidy-specific "format on save" toggle, because Tidy delegates the entire save lifecycle to VS Code.

> **"It does nothing?"** If you installed Tidy and saving no longer reformats,
> that is expected: Tidy never auto-formats. Complete steps 2 and 3 above to
> choose the behaviour you want.

---

## Supported languages

| Language | Engine | Safety guard |
|---|---|---|
| CSS, SCSS, LESS | js-beautify | PostCSS tree compare |
| HTML | js-beautify | parse5 tree compare + template-island preservation |
| JSON, JSONC | js-beautify | parsed-value compare |
| JavaScript | js-beautify (real parser if JSX is detected) | AST equivalence (`@babel/parser`) |
| TypeScript | real parser (Prettier) | AST equivalence |
| TSX (TypeScript React) | real parser (Prettier) | AST equivalence |
| JSX (JavaScript React) | real parser (Prettier) | AST equivalence |

Plain `.js` files are formatted with js-beautify for familiarity, but if Tidy detects JSX inside them it automatically re-routes to the real parser rather than emit broken output.

Tidy also reads your project's **`.editorconfig`** cascade (honouring `root = true`) and maps `indent_style`, `indent_size` / `tab_width`, `end_of_line`, `insert_final_newline`, `trim_trailing_whitespace` and `max_line_length`. A team `.editorconfig` therefore wins over plain VS Code settings. Opt out with `"tidy.editorconfig": false`. In Restricted Mode the workspace `.editorconfig` is ignored (it is workspace-authored content), falling back to built-in and user settings.

`.sass` (indented syntax) and Vue/Astro single-file components are **not** in this build; see [the spec](./SPEC.md) for the v1.0/v2 roadmap.

---

## Languages & how Tidy formats each

Tidy handles every language below the same consent-first way: it reformats a file only when you run *Format Document* (`Shift+Alt+F`), *Format Selection*, or **Tidy: Preview Format (diff)** — and you can make it the default for any subset of these languages in one step with **Tidy: Use Tidy as my Formatter** (`tidy.useAsFormatter`). Here is what each family covers.

### HTML

Tidy is a full HTML formatter and beautifier: it re-indents tags, normalises attribute spacing, and wraps long attribute lists the way you configure them (`tidy.wrap_attributes`), while leaving embedded `<script>` / `<style>` islands and templating syntax intact. Trigger it with *Format Document* on any `.html` file, or set it as your HTML default via **Tidy: Use Tidy as my Formatter**. What separates it from the old JS-CSS-HTML Formatter is the parse5 tree comparison that runs after every format — if beautifying would add a stray space to a class or id name, or otherwise alter the document tree, Tidy discards the result and leaves your file untouched.

### CSS, SCSS & LESS

CSS, SCSS and LESS are all first-class: Tidy beautifies collapsed rules into readable blocks, aligns declarations, and controls selector and rule spacing (`tidy.selector_separator_newline`, `tidy.newline_between_rules`, `tidy.space_around_combinator`). Run *Format Document* on a `.css`, `.scss` or `.less` file, or opt in per language with **Tidy: Use Tidy as my Formatter**. Every result is checked against a PostCSS tree before it is written, so fragile constructs like `calc()` and SCSS interpolation (`#{…}`) survive formatting instead of being mangled.

### JavaScript & TypeScript

For JavaScript, Tidy uses js-beautify for a familiar layout and honours your indent settings (`editor.tabSize` / `editor.insertSpaces`) with no config file needed; TypeScript is formatted by Prettier under the hood. Format either with *Format Document*, or assign Tidy as the default formatter for those languages with **Tidy: Use Tidy as my Formatter**. Whichever engine runs, an AST-equivalence guard compares the parse tree before and after — so modern syntax such as optional chaining (`?.`), nullish coalescing (`??`) and BigInt literals (`1n`) is preserved exactly, and any output that would change program meaning is thrown away rather than written.

### JSX & TSX (React)

React files — `.jsx` and `.tsx` — are formatted with Prettier, the same engine most React teams already trust, so JSX elements reflow correctly instead of `<App />` turning into `< App / >`. Use *Format Document*, or pick these languages in **Tidy: Use Tidy as my Formatter** to make Tidy their default. On top of the AST check, a dedicated JSX tag-boundary guard rejects any output where a tag boundary was mangled — even when the broken result still happens to re-parse as valid TSX — and a plain `.js` file that actually contains JSX is automatically re-routed to the real parser rather than risk broken output.

### JSON & JSONC

Tidy formats both strict JSON and JSON-with-comments (JSONC): it re-indents and normalises structure while keeping comments intact for JSONC. Trigger it with *Format Document*, or enable it as your JSON default through **Tidy: Use Tidy as my Formatter**. Because the parsed value is compared before and after, formatting can never change the data your JSON represents — and since Tidy only ever touches the file you invoke it on, it will not reformat `package.json` behind your back.

---

## Works alongside Prettier

Tidy is a *configurable beautifier*, not an opinionated replacement for Prettier — and it is built to sit next to it, not on top of it.

- **Tidy never declares itself your default formatter.** It does not contribute or write `editor.defaultFormatter`, so it never silently takes over a language Prettier already owns. (The incumbent did the opposite — see issue [#92](https://github.com/lonefy/vscode-js-css-html-formatter/issues/92), "prevents every other formatter from working".)
- **You assign each language yourself.** A common setup is Prettier for JS/TS and Tidy for CSS/HTML/JSON. Because nothing competes for the default slot, that split is just two per-language `editor.defaultFormatter` entries — both formatters stay installed and active, each on the languages you chose.
- **For TS, JSX and TSX, Tidy *is* Prettier under the hood.** Those languages are formatted by the same Prettier engine, then checked by Tidy's AST-equivalence guard. So even when Tidy is the formatter you invoked, the actual reflow on your React/TypeScript code is Prettier's — there is no second, conflicting style to reconcile.

In short: keep Prettier exactly as it is. Tidy only ever runs on the languages you explicitly hand it, and it gets out of the way everywhere else.

---

## Ignore & coexistence

Tidy gives you fine-grained control over *what* it touches and gets out of the way when another formatter already owns the project — three things the abandoned incumbent never did. None of this can corrupt a file: every protected span is restored **verbatim**, so the equivalence guard sees output equal to the input and accepts it; if a splice ever produced non-parsable output the guard rejects it and your file is left intact.

| Capability | lonefy (#16, abandoned 2017) | Tidy |
|---|---|---|
| Skip a region / node in-source | ✗ none ([#16](https://github.com/lonefy/vscode-js-css-html-formatter/issues/16)) | `tidy-ignore-start/end`, `// tidy-ignore`, `// prettier-ignore` |
| Exclude files project-wide | ✗ none | `.soukformatignore` (gitignore syntax) |
| Step back for Prettier/Biome/dprint | ✗ hijacks the default slot ([#92](https://github.com/lonefy/vscode-js-css-html-formatter/issues/92)) | one-shot deference notice; **never** changes `editor.defaultFormatter` |

### In-source ignore directives

Write a comment (in the host language's syntax) to keep part of a file exactly as authored:

```css
/* tidy-ignore-start */
.keep   {  color : red ;  }   /* this block is preserved BYTE-for-BYTE */
/* tidy-ignore-end */

.rest { color: blue; }        /* …while everything else is reformatted */
```

- **Whole file** — a head comment containing `tidy-ignore-file`, `tidy-ignore`, or `prettier-ignore` (the first significant comment at the top) leaves the entire document untouched.
- **A region** — `tidy-ignore-start` … `tidy-ignore-end` preserves everything in between, verbatim (markers included). An unterminated region protects to end-of-file (conservative — it protects more, never less).
- **The next node** — a lone `// tidy-ignore` or `// prettier-ignore` comment protects the node on the following line (best-effort, conservative line heuristic).

**Engine coverage.** For TS/TSX/JSX (the Prettier path) `// prettier-ignore` is honoured **natively at the node level** by Prettier itself — the richer, syntax-aware behaviour. For CSS/SCSS/LESS/HTML/JSON and plain JS (the js-beautify path) Tidy protects `tidy-ignore-*` **regions** itself via a mask-and-restore step behind the guard. Node-level masking on the js-beautify path is best-effort: if a coarse span can't be spliced back safely, the guard simply rejects and the file stays intact (never corruption). Node-level directives are richest on the Prettier path; this js-beautify limitation is documented rather than risked.

### `.soukformatignore`

Drop a `.soukformatignore` at your project root (or any sub-folder) to exclude files from formatting entirely — Tidy leaves them **byte-identical**. It uses familiar **gitignore syntax**:

```gitignore
# vendored / generated — never reformat
*.min.css
dist/
vendor/**/*.js

# …but DO keep this one tidy (negation re-includes it)
!vendor/keep.css
```

- Last matching pattern wins; a trailing `!negation` re-includes a previously-excluded path (git semantics).
- The cascade walks up from the file: a root `.soukformatignore` and a sub-folder one both apply.
- It is read only in **trusted** workspaces (ignored in Restricted Mode → the file is formatted). If the ignore file can't be read, Tidy fails **safe** and formats normally.
- Turn it off entirely with `"tidy.respectSoukformatignore": false`.

### Preview command (read-only diff + atomic undo)

Run **Tidy: Preview Format (diff)** (`tidy.previewFormat`) from the Command Palette to see *exactly* what Tidy would change before committing to it:

- Opens a **read-only** side-by-side diff (original vs. formatted). Opening it writes nothing — your file's dirty state is unchanged.
- The preview runs the **same** pipeline as a normal format, including the equivalence guard. If the guard would reject the output, no diff opens and you get a non-blocking notice (file intact).
- Click **Apply** to write the result as a **single undo entry** — one `Ctrl+Z` fully reverts it. Dismiss the prompt and nothing is written.

### Deference behavior (coexisting with other formatters)

When a workspace already configures another formatter — Prettier (`.prettierrc*` or a `prettier` key in `package.json`), Biome (`biome.json`), or dprint (`dprint.json`) — Tidy **surfaces** that fact once, and otherwise stays out of the way. Controlled by `tidy.deferToOtherFormatters` (default `notify`):

| Value | Behavior |
|---|---|
| `notify` *(default)* | Show a **one-time**, informational notification per workspace that another formatter is configured. Deduplicated via `globalState` — never a repeat nag. |
| `silent-defer` | Acknowledge the competitor without notifying. Still writes nothing and disables nothing. |
| `off` | Ignore detection entirely (no read, no notification). |

**The anti-hijack contract (non-negotiable):** deference **never** changes `editor.defaultFormatter`, **never** disables Tidy silently, and **never** writes any setting on its own. The notification is purely informational — it reminds you that you can disable Tidy per language (`tidy.<lang>.enable`) for this workspace if you prefer the other tool to own formatting. The choice, and any write, is always yours. A `.prettierignore` on its own does **not** trigger deference (it only narrows what Prettier would touch, it doesn't configure Prettier as a formatter). Detection reads workspace files only in **trusted** workspaces.

> Tip: run **Tidy: Show Effective Configuration** to see, for the active document, whether it would be skipped (`.soukformatignore` / in-source marker), how many regions are protected, and which competing formatters were detected.

---

## Key settings

All settings live under the `tidy.*` namespace. Indentation defaults come from your editor (`editor.tabSize` / `editor.insertSpaces`); the `tidy.*` values below are fallbacks used only when neither the editor nor a project config provides one.

| Setting | Default | What it does |
|---|---|---|
| `tidy.<lang>.enable` | `true` | Per-language switch (`tidy.css.enable`, `tidy.typescript.enable`, …). Set to `false` to remove Tidy as a formatter for that language. |
| `tidy.indent` | `4` | Fallback indent size (js-beautify `indent_size`) when the editor provides none. |
| `tidy.brace_style` | `collapse` | Brace placement (`collapse`, `expand`, `end-expand`, `none`, `collapse-preserve-inline`). |
| `tidy.wrap_line_length` | `0` | Max characters per line before wrapping; `0` disables wrapping. |
| `tidy.wrap_attributes` | `auto` | How HTML attributes wrap (`auto`, `force`, `force-aligned`, `force-expand-multiline`, `aligned-multiple`, `preserve`, `preserve-aligned`). |
| `tidy.space_after_anon_function` | `false` | Add a space after an anonymous `function` keyword. |
| `tidy.maxFileSizeKB` | `5120` | Skip (with a notice) documents larger than this, so huge files never freeze the editor. `0` disables the guard. |
| `tidy.editorconfig` | `true` | Read the project's `.editorconfig` cascade and let it override plain VS Code settings. Set to `false` to ignore `.editorconfig`. |
| `tidy.soukformatrc` | `true` | Read the project's `.soukformatrc` file (JSONC) for per-language options and glob overrides, layered above `.editorconfig`. Set to `false` to ignore it. Always ignored in Restricted Mode. |
| `tidy.respectSoukformatignore` | `true` | Skip files matched by a project `.soukformatignore` (gitignore syntax), leaving them byte-identical. Set to `false` to format every file regardless. Always ignored in Restricted Mode. See [Ignore & coexistence](#ignore--coexistence). |
| `tidy.deferToOtherFormatters` | `notify` | How Tidy reacts when another formatter (Prettier/Biome/dprint) is already configured: `notify` (one-time notice), `silent-defer` (no notice), or `off`. **Never** changes your default formatter. See [Deference behavior](#deference-behavior-coexisting-with-other-formatters). |

**The full option set ("not enough options" — fixed).** Beyond the headline knobs above, Tidy exposes the complete js-beautify surface by family and the AST-safe Prettier stylistic options for TS/JSX. A few highlights:

| Setting | Applies to | What it does |
|---|---|---|
| `tidy.preserve_newlines` / `tidy.max_preserve_newlines` | all | Keep existing blank lines (and cap how many). |
| `tidy.space_in_paren`, `tidy.break_chained_methods`, `tidy.keep_array_indentation`, `tidy.comma_first`, `tidy.operator_position` | JavaScript | Fine-grained js-beautify JS layout. |
| `tidy.selector_separator_newline`, `tidy.newline_between_rules`, `tidy.space_around_combinator` | CSS/SCSS/LESS | CSS rule + selector spacing. |
| `tidy.indent_inner_html`, `tidy.indent_scripts`, `tidy.wrap_attributes_indent_size` | HTML | HTML structure + attribute wrapping. |
| `tidy.prettier.singleQuote`, `tidy.prettier.semi`, `tidy.prettier.jsxSingleQuote`, `tidy.prettier.trailingComma`, `tidy.prettier.bracketSpacing`, `tidy.prettier.bracketSameLine`, `tidy.prettier.arrowParens`, `tidy.prettier.printWidth` | TS/TSX/JSX/JS | **Stylistic only** — quote style, semicolons, trailing commas, parens, line width. Each is AST-invariant, so the equivalence guard still accepts the result. |

**Per-language overrides.** Every option above is `language-overridable`, so you can scope it to one language in your `settings.json`:

```jsonc
{
  "tidy.brace_style": "collapse",
  "[javascript]": { "tidy.brace_style": "expand" },
  "[typescript]": { "tidy.prettier.singleQuote": true }
}
```

**Project config — `.soukformatrc` (JSONC).** Drop a `.soukformatrc` at your project root to drive style per language (and per glob), shared across the team and layered above `.editorconfig`:

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

A malformed `.soukformatrc` never breaks formatting — it is ignored with a warning and Tidy falls back to the lower layers. It is read only in trusted workspaces.

**Diagnosing your config:** run **Tidy: Show Effective Configuration** from the Command Palette to see every resolved option *and the exact source of each value* (VS Code global, `tidy.<lang>`, `.editorconfig`, `.soukformatrc`, or a glob override). This is the direct answer to "why is it indenting with 4 spaces?" — no guesswork, no hours of debugging.

### Commands

All Tidy commands are in the Command Palette (`Ctrl+Shift+P`) under the **Tidy** category:

| Command id | Title | What it does |
|---|---|---|
| `tidy.showEffectiveConfiguration` | Tidy: Show Effective Configuration | Shows every resolved option and the exact source of each value. |
| `tidy.useAsFormatter` | Tidy: Use Tidy as my Formatter | Opt in per language: writes `editor.defaultFormatter` (Workspace by default) for the languages you pick. Never writes `editor.formatOnSave`; cancelling writes nothing. |
| `tidy.runMigration` | Tidy: Migrate from JS-CSS-HTML Formatter | Imports a legacy `.jsbeautifyrc` into `tidy.*` settings after a confirmation recap (trusted workspaces only), then optionally runs *Use Tidy as my Formatter*. |
| `tidy.previewFormat` | Tidy: Preview Format (diff) | Opens a **read-only** diff of what Tidy would change, then applies it on an explicit *Apply* click as a **single undo entry**. Opening the diff writes nothing. See [Preview command](#preview-command-read-only-diff--atomic-undo). |

---

## FAQ

**Why does VS Code keep formatting my code on save?**
Something in your setup has `editor.formatOnSave` enabled and a default formatter assigned for that language — often an extension that made itself the default without asking. VS Code, not the extension, owns the save trigger, so the fix is to turn off `editor.formatOnSave` (globally or per language) or change `editor.defaultFormatter`. If code is *still* reformatted with format-on-save off, an extension is hooking save itself; disabling or uninstalling it is the only reliable fix. Tidy deliberately never hooks save, so it can never be the cause.

**How do I stop an extension from formatting on save?**
Start by setting `"editor.formatOnSave": false` — you can scope it per language, e.g. `"[javascript]": { "editor.formatOnSave": false }`. If code is still reformatted on save, the culprit is an extension that registers its own save handler instead of relying on VS Code's (the JS-CSS-HTML Formatter is a well-known example), and you have to disable or uninstall that extension from the Extensions view. No other extension — Tidy included — can turn off a save hook that a different extension installed.

**Is there a safe alternative to JS-CSS-HTML Formatter?**
That is exactly why Tidy exists. It covers the same languages — JavaScript, TypeScript, JSX/TSX, CSS, SCSS, LESS, HTML and JSON — but never formats on save, never makes itself the default formatter, and never writes a setting unless you confirm it. Every format is verified against your original (AST for JS/TS/JSX/TSX, tree compare for CSS/HTML, value compare for JSON), so it cannot produce the corrupted output the incumbent was reported for. See [Migrating from JS-CSS-HTML Formatter](#migrating-from-js-css-html-formatter) for a two-minute switch.

**How is Tidy different from Prettier?**
Prettier is opinionated: it enforces one canonical style with very few knobs. Tidy is a *configurable* beautifier that respects your VS Code and project settings, so it fills the "lots of options" niche the JS-CSS-HTML Formatter used to. The two are built to coexist — a common setup is Prettier for JS/TS and Tidy for CSS/HTML/JSON — and for TypeScript, JSX and TSX Tidy actually runs Prettier under the hood, then adds its own equivalence guard on top. See [Works alongside Prettier](#works-alongside-prettier).

**Does Tidy work in Cursor, Windsurf or VSCodium?**
Tidy is a standard VS Code extension with no proprietary Marketplace dependencies, so it runs in editors built on VS Code — Cursor, Windsurf, VSCodium and similar — as long as you can install it. It is currently published on the Visual Studio Marketplace; Open-VSX-only builds such as VSCodium may need you to install the packaged `.vsix` manually until an Open VSX release lands (that release is on the roadmap in [SPEC.md](./SPEC.md)). Nothing in the formatting pipeline is tied to a specific distribution.

**Will Tidy break my JSX or modern JS?**
No. JSX, TSX and TypeScript are formatted with a real parser (Prettier), not a token-level find-and-replace, so `<App />` stays `<App />`. On top of that, the AST-equivalence guard — plus a dedicated JSX tag-boundary check — compares the parse tree before and after and discards any output that changed meaning, so optional chaining (`?.`), nullish coalescing (`??`) and BigInt literals (`1n`) are always preserved. If a format ever couldn't be proven safe, you get zero edits and an intact file.

**Will Tidy format my files on save?**
Only if *you* enable `editor.formatOnSave` and select Tidy as the default formatter for that language. Out of the box it does nothing on save.

**Will it override Prettier / ESLint / my chosen formatter?**
No. Tidy never sets or contributes `editor.defaultFormatter`. If another formatter is your default, Tidy does not run unless you explicitly invoke it.

**I installed it and nothing happens when I save. Is it broken?**
No — that is the intended default. See [60-second opt-in setup](#60-second-opt-in-setup) to choose the behaviour you want.

**Can it corrupt my code?**
Tidy refuses to apply any output that fails its equivalence guard (AST for JS/TS/JSX/TSX, tree compare for CSS/HTML, value compare for JSON). If formatting would change meaning, you get zero edits and an intact file plus a notice.

**Does it support JSX and TypeScript?**
Yes — JSX, TSX, and TypeScript are formatted with a real parser, not a token mangler, and are covered by the AST guard.

**Does it send my code anywhere?**
No. Tidy is 100% client-side. It does not phone home, and the output-channel diagnostics never include your source.

**Does it work in Restricted Mode / virtual workspaces / Codespaces?**
It declares support for untrusted and virtual workspaces. In Restricted Mode it falls back to built-in and user settings rather than workspace-defined config.

**How do I stop Tidy from formatting a specific language?**
Set `tidy.<lang>.enable` to `false` (e.g. `"tidy.json.enable": false`), or simply don't choose it as the default formatter for that language.

**How do I stop Tidy from touching a specific file or region?**
Three ways, all covered in [Ignore & coexistence](#ignore--coexistence): a `.soukformatignore` (gitignore syntax) excludes files project-wide; `tidy-ignore-start`/`tidy-ignore-end` comments preserve a region byte-for-byte; and a head `tidy-ignore-file` / `// prettier-ignore` comment skips the whole file.

**Another formatter (Prettier/Biome) is already set up — will Tidy fight it?**
No. Tidy detects it and shows a one-time, informational notice (`tidy.deferToOtherFormatters`, default `notify`). It never changes `editor.defaultFormatter` and never disables itself silently — see [Deference behavior](#deference-behavior-coexisting-with-other-formatters).

**Can I preview a format before applying it?**
Yes — run **Tidy: Preview Format (diff)** for a read-only side-by-side diff, then *Apply* it as a single undo entry. See [Preview command](#preview-command-read-only-diff--atomic-undo).

**Does it read `.editorconfig`?**
Yes. Tidy reads the `.editorconfig` cascade (respecting `root = true`) and maps the common keys (`indent_style`, `indent_size`/`tab_width`, `end_of_line`, `insert_final_newline`, `trim_trailing_whitespace`, `max_line_length`). Disable with `"tidy.editorconfig": false`.

**Can I configure it with a project file?**
Yes. Tidy reads a `.soukformatrc` (JSONC) from your project root — per-language sections plus ordered glob `overrides`, layered above `.editorconfig` and shared across the team. See [Key settings](#key-settings) for the schema. (YAML support is on the roadmap.)

**Where's the indented-`.sass` / Vue support?**
Not in this build. The remaining roadmap (`.soukformatrc` YAML, real CSS-in-JS reformatting, Vue SFCs, Open VSX, more languages) is described in [SPEC.md](./SPEC.md). Ignore directives, `.soukformatignore`, the preview diff, and deference notifications **are** shipped — see [Ignore & coexistence](#ignore--coexistence).

---

## Feedback

Found a bug or a file Tidy got wrong? A reproducible input is worth a thousand stars — open an issue with the smallest snippet that reproduces it. If Tidy has saved you from a save-on-format disaster, you're welcome to [leave a review](https://marketplace.visualstudio.com/items?itemName=ced-lab.tidy-formatter). No in-product nagging, ever.

## License

[MIT](./LICENSE). See [CHANGELOG.md](./CHANGELOG.md) for release history.
