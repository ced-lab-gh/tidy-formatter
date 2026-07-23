# Changelog

All notable changes to **Tidy Formatter — JS/CSS/HTML** are documented in this
file. The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.4] - 2026-07-24

### Added

- **`Tidy: Report an Issue` command.** A new Command Palette entry (under the **Tidy** category) opens a **prefilled GitHub issue** for the repo with the environment details a good bug report needs — Tidy version, VS Code version, OS, and the active document's `languageId` — plus empty *What happened / Minimal input to reproduce / Expected vs. actual* sections, so filing an actionable report takes seconds. This is the actionable counterpart to the README's "a reproducible input is worth a thousand stars", and it feeds the bug → fix → confidence loop that a young extension lives on.
- **Read-only by construction.** The command only *reads* host state and opens an external URL via `env.openExternal`. It writes **no** file and changes **no** setting, so it carries none of the anti-hijack surface of the onboarding/migration commands. The URL builder is a pure, `vscode`-free module (`buildIssueUrl` / `platformLabel`) covered by unit tests; the thin host surface is loaded lazily inside the handler, exactly like the other Tidy commands.

### Changed

- **README / discoverability (SEO).** The new command is documented in the Commands table and the Feedback section, and the FAQ gains two answers to common, generic searches — *"How do I format HTML, CSS and JavaScript in VS Code?"* and *"Is there a VS Code formatter that only runs when I ask — not on save?"* — broadening the listing beyond the incumbent-specific questions already covered.

No change to formatting behaviour, settings, or the safety guard.

## [0.1.3] - 2026-07-16

### Changed

- **Marketplace listing visuals — new "See it in action" section.** The README now opens with two real **before/after** images (CSS and TSX) so the listing shows what Tidy does at a glance. Both are rendered verbatim from this repo's own inputs — `samples/messy.css` / `samples/messy.tsx` (before) next to `samples/out/messy.css` / `samples/out/messy.tsx` (after): collapsed, comma-jammed CSS becomes readable while `calc(100% - 20px)` and the `>` combinator survive, and minified React reflows through a real parser with `<div className="card" … />` staying valid JSX and `n?.toString() ?? "none"` keeping both its `?.` and `??`. Nothing in the visuals is faked.
- **Committed as PNG on purpose.** The pair ships at `media/before-after/css.png` and `media/before-after/tsx.png` because the Marketplace rewrites relative README image paths to raw.githubusercontent.com and renders PNG reliably on the listing, whereas SVG is not guaranteed to render there.
- **Dev-only visuals generator.** A new `scripts/build-visuals.mjs` regenerates the pair from `samples/` using `@resvg/resvg-js` as a **devDependency** only — **no new runtime dependency**, and neither the generator nor `samples/` is packaged into the VSIX (only the produced PNGs are). The extension icon is unchanged (still the 256×256 PNG shipped since 0.1.0).

This is a documentation/asset release only — **no change to formatting behaviour, settings, or the safety guard.**

## [0.1.2] - 2026-07-09

### Changed

- **Docs & discoverability.** Richer README: a per-language section (HTML; CSS/SCSS/LESS; JavaScript/TypeScript; JSX/TSX; JSON) explaining what Tidy formats and how to trigger it, plus an FAQ answering common questions ("why does VS Code format my code on save?", safe alternatives to JS-CSS-HTML Formatter, how Tidy differs from Prettier, and forked-editor support). No behaviour change.

### Added

- **Release guardrail (anti-empty-bump).** A `check:changelog` gate (run in CI and the release pipeline) fails a release unless `CHANGELOG.md` documents the current `package.json` version — enforcing the "never ship an empty version bump" rule.

## [0.1.1] - 2026-07-08

### Added

- **Marketplace metadata / ASO refresh.** Clearer display name ("Tidy — JS/CSS/HTML Formatter & Beautifier"), a description that names every supported language (TypeScript, JSX/TSX, SCSS and LESS now included), and keyword cleanup (added `typescript` and `less`; removed `editorconfig` and `format on save`). No behaviour change.
- **Superiority features — ignore, deference & preview (ROADMAP Axe 4, v1.0).**
  - **In-source ignore directives.** A head `tidy-ignore-file` / `tidy-ignore` /
    `prettier-ignore` comment skips the whole file; `tidy-ignore-start` …
    `tidy-ignore-end` preserves a region **byte-for-byte**; a lone `// tidy-ignore`
    / `// prettier-ignore` protects the next node. On the Prettier path (TS/TSX/JSX)
    `// prettier-ignore` is honoured **natively at the node level**; on the
    js-beautify path (CSS/SCSS/LESS/HTML/JSON/JS) regions are protected via a pure
    mask-and-restore behind the guard (node-level masking is best-effort, with the
    limitation documented — never a corruption risk). The scanner/mask are pure,
    `vscode`-free modules.
  - **`.soukformatignore` (gitignore syntax).** Exclude files project-wide so Tidy
    leaves them byte-identical: `*`, `?`, `**`, anchoring, directory patterns, and
    last-wins `!negation`, cascading up the tree. Trust-gated (ignored in Restricted
    Mode) and fail-safe (unreadable ignore file → format anyway). Opt-out via
    `tidy.respectSoukformatignore`. The matcher **reuses/extends** the dependency-free
    glob from `.soukformatrc` — **no new npm dependency**.
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
- **Configurability — the full option set ("not enough options", ROADMAP Axe 3).**
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
  - **Guard-safe by construction**: the exposed Prettier options are stylistic only —
    toggling each changes the output but yields the same babel AST modulo
    whitespace/style, so the equivalence guard still accepts the result (proven by
    dedicated AST-invariance tests). `quoteProps` is deliberately excluded.
  - **Show Effective Configuration** now groups options by family and attributes
    every value's source (VS Code global / `tidy.<lang>` / `.editorconfig` /
    `.soukformatrc` / glob override), with the resolved `.soukformatrc` path in the header.
  - Anti-hijack unchanged: no `defaultFormatter`/`configurationDefaults`, no
    save/change/startup hook; pure config/engine modules stay `vscode`-free.

## [0.1.0] - 2026-06-28

First MVP build — "publishable and already safer than the incumbent on 100% of
the P0 one-star causes" (SPEC §8).

### Added

- **Safety guard (SAFE-01/02/03/04)** — every format is verified for semantic
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
- **Anti-hijack architecture (ARCH-01/02/03/04)** — integration exclusively via
  `registerDocumentFormattingEditProvider` and
  `registerDocumentRangeFormattingEditProvider`. No save/focus/change hooks,
  never contributes or sets `editor.defaultFormatter`, all registrations
  disposed through `context.subscriptions`. `activationEvents` limited to the
  supported `onLanguage:*` ids. Declares `untrustedWorkspaces` and
  `virtualWorkspaces` support.
- **Hybrid engine dispatcher (ENG-01/02)** — js-beautify for
  css/scss/less/html/json/jsonc/plain-JS; Prettier (real parser) for
  ts/tsx/jsx; plain `.js` that actually contains JSX is re-routed to the real
  parser so JSX/TSX are genuinely formatted, never no-op. Modern ES2022+ syntax
  (`?.`, `??`, `1n`, `#x`, async, decorators, template literals, JSX) preserved.
- **Per-language enable switches** `tidy.<lang>.enable` and a configurable size
  guard `tidy.maxFileSizeKB` (ENG-03).
- **Configuration precedence (CFG-01/02/03)** — built-in defaults < VS Code
  settings + live `FormattingOptions` < `.editorconfig` cascade (`root = true`
  honoured; `indent_style`, `indent_size`/`tab_width`, `end_of_line`,
  `insert_final_newline`, `trim_trailing_whitespace`, `max_line_length` mapped;
  opt-out `tidy.editorconfig`, ignored in Restricted Mode). Deep merged by key,
  with per-key source tracking. js-beautify options (`indent`, `brace_style`,
  `wrap_line_length`, `wrap_attributes`, `space_after_anon_function`) exposed as
  settings (ENG-04). `.soukformatrc` + glob overrides remain for v1.0.
- **Template protection (CFG-04)** — template languageIds are never registered,
  and `{{ }}` / `{% %}` / `<% %>` islands inside `.html` are preserved verbatim
  via mask-then-restore.
- **"Tidy: Show Effective Configuration" command (CFG-05)** — prints every
  resolved option with its exact source, the direct antidote to the incumbent's
  "spent N hours debugging" reviews.
- Distinct, non-impersonating branding (DPB-01/03/04): id `tidy-formatter`,
  publisher `ced-lab`, `Formatters` category, ≤10 honest keywords (no
  `prettier` token), and a safety-front-loaded description.

[Unreleased]: https://github.com/ced-lab-gh/tidy-formatter/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ced-lab-gh/tidy-formatter/releases/tag/v0.1.0
