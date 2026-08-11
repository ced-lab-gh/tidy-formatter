# Changelog

All notable changes to **Tidy Formatter : JS/CSS/HTML** are documented in this
file. The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

Work towards 0.3.0. The safety guard remains the final judge on every write path,
including the two new ones below.

### Added

- **CSS/SCSS/LESS: a second engine now rescues files the first one could not format safely.** When js-beautify produces output the equivalence guard rejects, Tidy retries once through Prettier's PostCSS parser and **re-runs the full guard on that second result**. If it passes, the file is formatted and `Explain last format` names the engine that actually ran; if it fails, the original rejection stands and nothing is written. Measured on a corpus of fifteen files built from the incumbent's own bug reports: ten already formatted correctly, the fallback rescues one more, and four remain rejected and are reported as such. The corpus ships as a test harness with the expected status of every file pinned, so any future change to this path is visible instead of silent.
- **Template islands are protected in HTML.** `{{ … }}`, `{% … %}`, `<% … %>` and a leading `---` front matter block are masked before formatting and restored afterwards, byte for byte, before the guard runs on the restored document. If a placeholder collides with real content or fails to come back exactly as it left, Tidy reports the failure and writes **nothing**. This makes `templates.ts` a live part of the pipeline: it shipped in 0.1.0, was announced in that CHANGELOG entry, and had never actually been wired into the formatting path.

- **Guided, consent-first format-on-save opt-in.** After you confirm your languages in **Tidy: Use Tidy as my Formatter**, an optional step now asks what to do about format on save: keep formatting manual (the default, nothing preselected), open the stock `editor.formatOnSave` setting, or let Tidy enable it for exactly those languages. Choosing the last option shows a modal recap of every key that would be written (for example `"[css]": { "editor.formatOnSave": true }`) and the scope (Workspace by default, User if that is what you chose); nothing is written until you confirm, and cancelling at any step writes nothing. The success message offers a one-click **Revert** that restores each key to its previous value and never overwrites a value you changed in the meantime. If a write fails mid-way, what was already written is rolled back and the message reports the real state. Every decision and write is traced in the **Tidy Formatter** output channel (languages, scope and keys only, never your source).
  - **Anti-hijack unchanged.** Tidy still never hooks the save event and still registers only as an on-demand formatting provider; VS Code core owns the entire save lifecycle. This feature only writes the stock VS Code setting, per language, after an explicit confirmation, exactly like the existing `editor.defaultFormatter` opt-in.
- **Tidy status bar item: every no-op finally has a visible reason.** A single status bar entry (right side) now shows, for the active file, whether Tidy is ready, turned off (`tidy.<lang>.enable`), excluded by `.soukformatignore`, over the `tidy.maxFileSizeKB` limit, or superseded by another default formatter (named in the tooltip). After each format attempt it briefly shows the outcome: `formatted`, `already tidy`, `guard blocked` (with a warning background), or the short reason for any other skip, then falls back to the passive state. Clicking it opens a small menu over the existing commands: *Explain last format*, *Preview format (diff)*, *Show Effective Configuration*.
  - **Purely observational, anti-hijack safe.** It adds no save/change hook, never formats, never edits, and never writes a setting; its only refresh triggers are the active-editor switch and configuration changes, both read-only. A dedicated test locks these invariants at the source level.
  - **Content-free by contract.** The bar and its tooltip only ever carry language, engine, status, timestamps and sanitized one-line reasons, never your source.
  - Disable it with `tidy.statusBar.enable: false`; formatting behavior is unchanged either way.
- **Actionable buttons on every diagnostic.** `Tidy: Explain Last Format` and the guard/size notifications now carry a button mapped to the actual remedy: *Report an Issue* when the guard rejected an output or an engine errored, *Open Settings* for a disabled language or a file over `tidy.maxFileSizeKB`, *Open .soukformatignore* when an ignore rule excluded the file, and *Use Tidy as My Formatter* when another formatter owns the language. The mapping lives in a single pure function, so the notification and the output channel can never disagree. The number of unsolicited notifications is unchanged: buttons were added to the toasts that already existed.
- **ESLint is now part of the deference check.** Tidy already stepped back when it found a Prettier, Biome or dprint configuration; it now also recognises `.eslintrc*` and flat `eslint.config.*` files, plus the `eslintConfig` key in `package.json`. The message is specific: ESLint reformats through `--fix` rather than acting as a formatter, so Tidy stays manual and does not compete. An `.eslintignore` on its own triggers nothing. Reading is Workspace-Trust gated and executes no project code.
- **A Tidy submenu in the editor context menu** (*Preview Format (Diff)*, *Explain Last Format*), shown only for supported languages. No default keybinding is added.

### Changed

- **Settings are now grouped into seven titled sections** (general and safety, indentation and line endings, JavaScript, CSS/SCSS/LESS, HTML, TypeScript and JSX, project and coexistence) with ordering and richer descriptions. **No setting was renamed or removed**: all 44 `tidy.*` identifiers are unchanged, so existing configurations keep working exactly as before.
- **Commands no longer appear for unsupported languages.** `Preview Format`, `Explain Last Format` and `Show Effective Configuration` are now gated on the active language, instead of appearing in the palette and failing when run.
- Command titles are consistently Title Case.

### Fixed

- **Every user-facing string is now in English.** Seventeen notification strings in the preview, configuration, formatter-opt-in and formatting-provider paths were still in French, while the rest of the product was English. A test now fails the build if a French string reappears, and another fails it if an em dash is introduced anywhere in the shipped surface.

## [0.2.2] - 2026-08-11

Safety release. An adversarial audit of the safety guard found five ways a
corrupted output could pass the equivalence check and be written to your file.
All five are closed here, with regression fixtures for each. **This release
changes no formatting behaviour**: the same valid outputs are still applied, the
2045 existing tests are unchanged and green, and 25 new tests pin the fixes.

### Fixed

- **CSS/SCSS/LESS: whitespace next to a parenthesis is significant again.** The guard normalized it away on both sides, so an output that turned `calc(100% - 10px)` into `calc (100% - 10px)` was accepted, even though an identifier must touch `(` to form a function token, making the declaration invalid and silently dropped by the browser. The same hole covered `:nth-child (2n)` (drops the whole rule), `@media (a)and(b)` (malformed query), and `:not(.a) .b` collapsed to `:not(.a).b` (a descendant combinator turned into a compound selector, a different selector). Whitespace *inside* parentheses stays insignificant, so legitimate output such as `calc( 1px + 2px )` reformatted to `calc(1px + 2px)` is still accepted.
- **HTML: `white-space: pre` is now inherited by the whole subtree.** Verbatim text was only detected when the immediate parent was `<pre>` or `<textarea>`. In `<pre><code>...</code></pre>`, the standard code-block markup, the text node's parent is `<code>`, so its indentation and line breaks were normalized away and any reflow of a code block passed unnoticed. Whitespace-only nodes anywhere inside a `<pre>` are likewise no longer dropped.
- **HTML: `&nbsp;` is no longer treated as an ordinary space.** Text normalization used `\s`, which also matches U+00A0, U+202F and the U+2000..U+200A family. These are rendered characters, so degrading `10&nbsp;km` into `10 km` was accepted as equivalent, and a text node made only of `&nbsp;` was considered blank and dropped entirely. Only ASCII whitespace (space, tab, LF, CR, FF) is collapsed now.
- **JavaScript/TypeScript: losing a comment is now rejected.** Comments are excluded from the structural AST comparison because they carry positions, but their *disappearance* was therefore invisible. An output dropping `/* eslint-disable no-console */`, a `/* webpackChunkName */` magic comment (which changes the emitted bundle), or a licence header was accepted. The guard now compares the sorted, whitespace-normalized comment texts: moving and reindenting a comment is still accepted, removing or altering one is not. This applies to embedded `<script>` bodies in HTML too.
- **JSON/JSONC: a `"__proto__"` member is data again, and the verdict no longer depends on file size.** The lenient parser assigned members with `obj[key] = value`, so a `"__proto__"` member hit the prototype setter and left no own property, making its removal invisible; native `JSON.parse`, used as a fast path above 256 KB, kept it. The guard could therefore return two different verdicts for the same corruption depending on the document's size. Objects are now canonicalized from the syntax tree into sorted key/value pair arrays on both paths, so every key is plain data and the verdict is size-invariant.

### Notes

No new setting, no new command, no change to when Tidy runs. The safety guard
remains the final judge before any edit: when it cannot prove the output is
equivalent to the input, nothing is written.

## [0.2.1] - 2026-07-27

### Fixed

- **Packaging safety: the VSIX now excludes secret files.** `.vscodeignore` gained the secret patterns that `.gitignore` already had (`*.env`, `*.pat`, `*.pem`, `*.key`, `*.p12`, `*secret*.json`). This is not redundant: `vsce` packages from the working directory and **never reads `.gitignore`**, so an untracked local `.env` holding a publishing token would previously have been baked into a published VSIX. Verified empirically: such a file is now excluded while git still ignores it.
- **Em dash removal completed.** The 0.2.0 entry below claimed the walkthrough was covered; it was not. The four shipped walkthrough pages, the *Effective Configuration* output-channel name, and the preview command's "already formatted" notice still contained the character. All are clean now.

### Changed

- **Removed an obsolete duplicate integration suite** (`powerFeatures.test.ts`). Every guarantee it asserted, including the ARCH-02 check that deference never writes `editor.defaultFormatter`, is covered by the fuller `power-features.test.ts`. Test-only change.

## [0.2.0] - 2026-07-24

### Added

- **`Tidy: Explain last format` command + a structured Output channel.** The antidote to "I installed Tidy and Format Document does nothing." Run it (Command Palette, **Tidy** category) and Tidy tells you, for the active file, exactly what its most recent format attempt did, or **why it did nothing**: the safety guard rejected a non-equivalent result (file left intact), a `.soukformatignore` rule or an in-source `tidy-ignore` / `prettier-ignore` marker excluded the file, the file exceeded `tidy.maxFileSizeKB`, the language is disabled, or the run was cancelled. When Tidy has not run on the file at all, it says whether **another formatter owns the language** (naming it) and how to switch to Tidy. Every attempt is also traced in the shared **Tidy Formatter** output channel.
  - **Privacy by construction.** The stored record and the channel carry only language, engine, status and a short reason, never your source. Engine/parser error messages are truncated to their first line and sanitized, so a code frame can never leak into the record, the channel, or a copied bug report.
  - **Observational and anti-hijack safe.** It adds no save/change hook, sets no `editor.defaultFormatter`, and changes no formatting behaviour.

### Changed

- **Marketplace listing copy: em dashes removed.** The title, description, README and settings text no longer use the em dash character, per a style preference. Copy only. (The walkthrough pages and two notification strings were missed here and are fixed in 0.2.1.)

No change to the formatting engine or to any decision the safety guard makes.

## [0.1.4] - 2026-07-24

### Added

- **`Tidy: Report an Issue` command.** A new Command Palette entry (under the **Tidy** category) opens a **prefilled GitHub issue** for the repo with the environment details a good bug report needs (Tidy version, VS Code version, OS, and the active document's `languageId`), plus empty *What happened / Minimal input to reproduce / Expected vs. actual* sections, so filing an actionable report takes seconds. This is the actionable counterpart to the README's "a reproducible input is worth a thousand stars", and it feeds the bug → fix → confidence loop that a young extension lives on.
- **Read-only by construction.** The command only *reads* host state and opens an external URL via `env.openExternal`. It writes **no** file and changes **no** setting, so it carries none of the anti-hijack surface of the onboarding/migration commands. The URL builder is a pure, `vscode`-free module (`buildIssueUrl` / `platformLabel`) covered by unit tests; the thin host surface is loaded lazily inside the handler, exactly like the other Tidy commands.

### Changed

- **README / discoverability (SEO).** The new command is documented in the Commands table and the Feedback section, and the FAQ gains two answers to common, generic searches (*"How do I format HTML, CSS and JavaScript in VS Code?"* and *"Is there a VS Code formatter that only runs when I ask, not on save?"*), broadening the listing beyond the incumbent-specific questions already covered.

No change to formatting behaviour, settings, or the safety guard.

## [0.1.3] - 2026-07-16

### Changed

- **Marketplace listing visuals : new "See it in action" section.** The README now opens with two real **before/after** images (CSS and TSX) so the listing shows what Tidy does at a glance. Both are rendered verbatim from this repo's own inputs : `samples/messy.css` / `samples/messy.tsx` (before) next to `samples/out/messy.css` / `samples/out/messy.tsx` (after): collapsed, comma-jammed CSS becomes readable while `calc(100% - 20px)` and the `>` combinator survive, and minified React reflows through a real parser with `<div className="card" … />` staying valid JSX and `n?.toString() ?? "none"` keeping both its `?.` and `??`. Nothing in the visuals is faked.
- **Committed as PNG on purpose.** The pair ships at `media/before-after/css.png` and `media/before-after/tsx.png` because the Marketplace rewrites relative README image paths to raw.githubusercontent.com and renders PNG reliably on the listing, whereas SVG is not guaranteed to render there.
- **Dev-only visuals generator.** A new `scripts/build-visuals.mjs` regenerates the pair from `samples/` using `@resvg/resvg-js` as a **devDependency** only : **no new runtime dependency**, and neither the generator nor `samples/` is packaged into the VSIX (only the produced PNGs are). The extension icon is unchanged (still the 256×256 PNG shipped since 0.1.0).

This is a documentation/asset release only : **no change to formatting behaviour, settings, or the safety guard.**

## [0.1.2] - 2026-07-09

### Changed

- **Docs & discoverability.** Richer README: a per-language section (HTML; CSS/SCSS/LESS; JavaScript/TypeScript; JSX/TSX; JSON) explaining what Tidy formats and how to trigger it, plus an FAQ answering common questions ("why does VS Code format my code on save?", safe alternatives to JS-CSS-HTML Formatter, how Tidy differs from Prettier, and forked-editor support). No behaviour change.

### Added

- **Release guardrail (anti-empty-bump).** A `check:changelog` gate (run in CI and the release pipeline) fails a release unless `CHANGELOG.md` documents the current `package.json` version, enforcing the "never ship an empty version bump" rule.

## [0.1.1] - 2026-07-08

### Added

- **Marketplace metadata / ASO refresh.** Clearer display name ("Tidy : JS/CSS/HTML Formatter & Beautifier"), a description that names every supported language (TypeScript, JSX/TSX, SCSS and LESS now included), and keyword cleanup (added `typescript` and `less`; removed `editorconfig` and `format on save`). No behaviour change.
- **Superiority features : ignore, deference & preview (ROADMAP Axe 4, v1.0).**
  - **In-source ignore directives.** A head `tidy-ignore-file` / `tidy-ignore` /
    `prettier-ignore` comment skips the whole file; `tidy-ignore-start` …
    `tidy-ignore-end` preserves a region **byte-for-byte**; a lone `// tidy-ignore`
    / `// prettier-ignore` protects the next node. On the Prettier path (TS/TSX/JSX)
    `// prettier-ignore` is honoured **natively at the node level**; on the
    js-beautify path (CSS/SCSS/LESS/HTML/JSON/JS) regions are protected via a pure
    mask-and-restore behind the guard (node-level masking is best-effort, with the
    limitation documented, never a corruption risk). The scanner/mask are pure,
    `vscode`-free modules.
  - **`.soukformatignore` (gitignore syntax).** Exclude files project-wide so Tidy
    leaves them byte-identical: `*`, `?`, `**`, anchoring, directory patterns, and
    last-wins `!negation`, cascading up the tree. Trust-gated (ignored in Restricted
    Mode) and fail-safe (unreadable ignore file → format anyway). Opt-out via
    `tidy.respectSoukformatignore`. The matcher **reuses/extends** the dependency-free
    glob from `.soukformatrc` : **no new npm dependency**.
  - **Deference to competing formatters.** Detects Prettier (`.prettierrc*` or a
    `package.json` `prettier` key), Biome (`biome.json`), and dprint (`dprint.json`)
    and **surfaces** a one-time, deduplicated (`globalState`) notification.
    Controlled by `tidy.deferToOtherFormatters` (`notify` default / `silent-defer` /
    `off`). Anti-hijack: deference **never** changes `editor.defaultFormatter`,
    never disables Tidy silently, and writes no setting on its own. A `.prettierignore`
    alone does not trigger it (CFG-07). Detection is Trust-gated.
  - **`Tidy: Preview Format (diff)` command.** Read-only side-by-side diff of what
    Tidy would change (opening it writes nothing / leaves dirty state intact), driven
    by the same pipeline + equivalence guard; a guard rejection shows no diff. An
    explicit **Apply** writes the result as a **single undo entry** (one `Ctrl+Z`
    reverts). The decision planner is a pure, `vscode`-free module.
  - **Show Effective Configuration** now reports the active document's ignore &
    coexistence status: whether it is skipped (`.soukformatignore` / in-source
    marker), the consulted `.soukformatignore` path, the count of protected regions,
    the detected competing formatters, and the effective `deferToOtherFormatters`.
  - Guard + anti-hijack preserved end to end: every ignore/region path returns the
    input verbatim (so `guard.check` accepts), any non-parsable splice is rejected
    (file intact), and no `defaultFormatter`/`configurationDefaults`/save·change·startup
    hook is added (ARCH-01/02 integration tests stay green).
- **Configurability : the full option set ("not enough options", ROADMAP Axe 3).**
  - **24 new formatting options** on top of the 5 already shipped (29 total): the
    complete js-beautify surface by family (`preserve_newlines`,
    `max_preserve_newlines`, `space_in_paren`, `break_chained_methods`,
    `keep_array_indentation`, `comma_first`, `operator_position`,
    `selector_separator_newline`, `newline_between_rules`,
    `space_around_combinator`, `indent_inner_html`, `indent_scripts`,
    `wrap_attributes_indent_size`, …) plus **AST-safe Prettier stylistic options**
    for TS/JSX (`singleQuote`, `semi`, `jsxSingleQuote`, `trailingComma`,
    `bracketSpacing`, `bracketSameLine`, `arrowParens`, `printWidth`).
  - **Per-language overrides**: every option is `language-overridable`, so
    `[typescript]: { "tidy.prettier.singleQuote": true }` scopes it to one language.
  - **Project config `.soukformatrc` (JSONC)** as precedence layers 4/5: per-language
    sections + ordered glob `overrides`, layered above `.editorconfig`. Fail-soft on
    malformed input (warning + fallback, never aborts), Trust-gated, opt-out via
    `tidy.soukformatrc`. JSONC only this release (YAML deferred); no new npm dependency.
  - **Guard-safe by construction**: the exposed Prettier options are stylistic only , 
    toggling each changes the output but yields the same babel AST modulo
    whitespace/style, so the equivalence guard still accepts the result (proven by
    dedicated AST-invariance tests). `quoteProps` is deliberately excluded.
  - **Show Effective Configuration** now groups options by family and attributes
    every value's source (VS Code global / `tidy.<lang>` / `.editorconfig` /
    `.soukformatrc` / glob override), with the resolved `.soukformatrc` path in the header.
  - Anti-hijack unchanged: no `defaultFormatter`/`configurationDefaults`, no
    save/change/startup hook; pure config/engine modules stay `vscode`-free.

## [0.1.0] - 2026-06-28

First MVP build : "publishable and already safer than the incumbent on 100% of
the P0 one-star causes" (SPEC §8).

### Added

- **Safety guard (SAFE-01/02/03/04)** : every format is verified for semantic
  equivalence modulo whitespace before it is applied:
  - AST-equivalence check for JS / TS / JSX / TSX via `@babel/parser`, including
    the mandatory JSX tag-boundary integrity check so a mangled
    `< Foo bar = {x} />` that still re-parses is rejected.
  - Re-tokenise + tree comparison for CSS / SCSS / LESS (PostCSS) and HTML
    (parse5).
  - Value-level comparison for JSON / JSONC (jsonc-parser).
  - Idempotence helper (drift protection, distinct from corruption).
  - If the output is not provably equivalent, zero edits are returned and the
    file is left intact, with a non-blocking notice and an OutputChannel detail
    line that never contains source code.
- **Anti-hijack architecture (ARCH-01/02/03/04)** : integration exclusively via
  `registerDocumentFormattingEditProvider` and
  `registerDocumentRangeFormattingEditProvider`. No save/focus/change hooks,
  never contributes or sets `editor.defaultFormatter`, all registrations
  disposed through `context.subscriptions`. `activationEvents` limited to the
  supported `onLanguage:*` ids. Declares `untrustedWorkspaces` and
  `virtualWorkspaces` support.
- **Hybrid engine dispatcher (ENG-01/02)** : js-beautify for
  css/scss/less/html/json/jsonc/plain-JS; Prettier (real parser) for
  ts/tsx/jsx; plain `.js` that actually contains JSX is re-routed to the real
  parser so JSX/TSX are genuinely formatted, never no-op. Modern ES2022+ syntax
  (`?.`, `??`, `1n`, `#x`, async, decorators, template literals, JSX) preserved.
- **Per-language enable switches** `tidy.<lang>.enable` and a configurable size
  guard `tidy.maxFileSizeKB` (ENG-03).
- **Configuration precedence (CFG-01/02/03)** : built-in defaults < VS Code
  settings + live `FormattingOptions` < `.editorconfig` cascade (`root = true`
  honoured; `indent_style`, `indent_size`/`tab_width`, `end_of_line`,
  `insert_final_newline`, `trim_trailing_whitespace`, `max_line_length` mapped;
  opt-out `tidy.editorconfig`, ignored in Restricted Mode). Deep merged by key,
  with per-key source tracking. js-beautify options (`indent`, `brace_style`,
  `wrap_line_length`, `wrap_attributes`, `space_after_anon_function`) exposed as
  settings (ENG-04). `.soukformatrc` + glob overrides remain for v1.0.
- **Template protection (CFG-04)** : template languageIds are never registered,
  and `{{ }}` / `{% %}` / `<% %>` islands inside `.html` are preserved verbatim
  via mask-then-restore.
- **"Tidy: Show Effective Configuration" command (CFG-05)** : prints every
  resolved option with its exact source, the direct antidote to the incumbent's
  "spent N hours debugging" reviews.
- Distinct, non-impersonating branding (DPB-01/03/04): id `tidy-formatter`,
  publisher `ced-lab`, `Formatters` category, ≤10 honest keywords (no
  `prettier` token), and a safety-front-loaded description.

[Unreleased]: https://github.com/ced-lab-gh/tidy-formatter/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ced-lab-gh/tidy-formatter/releases/tag/v0.1.0
