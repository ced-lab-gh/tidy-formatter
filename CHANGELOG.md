# Changelog

All notable changes to **Tidy** are documented in this
file. The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.5.1] - 2026-10-15

A patch release that closes four of the known limitations listed for 0.5.0. Nothing changes for an ordinary project.

### Fixed

- **A `.soukformatrc` whose `overrides` are too costly to evaluate no longer formats with guessed options.** The remaining overrides used to be skipped, with a warning only in *Show Effective Configuration*, so a file could be formatted with options you did not set. Tidy now leaves the file alone and says why, in the output channel, *Explain Last Format* and the status bar; *Preview Format* refuses too.
- **The search for a `.soukformatignore` now always reaches the root of the drive.** It stopped 64 folders above the file.
- **On Linux and macOS, a backslash in a file name is part of the name**, as git treats it. It was read as a folder separator, so a pattern could miss the file.

### Changed

- **A `.soukformatignore` is read once and kept until it changes**, instead of on every format. Tidy checks the file's size, timestamps and identity before reusing it, and reads it again when it cannot prove the file is unchanged (a file changed in the last two seconds, or a file system with coarse timestamps). At most 1 MiB of ignore files is kept in memory at once. For a 1 MiB file of ordinary patterns, a format after the first one went from about 200 ms to about 10 to 40 ms; a file full of character classes still costs about a quarter of a second to evaluate.

### Known limitations

- On a network share modified from another machine, the cached `.soukformatrc` or `.soukformatignore` can stay stale for as long as the share caches file attributes (a few seconds on SMB, up to a minute on NFS by default).
- If this machine's clock runs more than two seconds ahead of the clock of the disk holding the file, two same-size rewrites in quick succession can leave the cached version in use until the file changes again.

## [0.5.0] - 2026-10-15

The release that makes Tidy's settings do what their descriptions say, lets the
migration read the incumbent's real configuration, and adds a command that shows
which formatter VS Code would use on a file and what happens when you save it. It also hardens the exclusion
patterns and the safety guard, and removes the one documented deviation from the
layer order (line width). **Several changes below alter the output of projects
that are already configured: read Changed before you update.**

### Added

- **`Tidy: Who Formats This File?` (`tidy.whoFormats`).** When a file gets reformatted and you cannot tell which extension is doing it, this command answers for the active file, read-only. It writes a five-section report to the **Tidy Formatter** output channel and shows a short answer as a notification: which `editor.defaultFormatter` applies to the file's language, which settings scope set it, and whether that extension is installed and enabled; what happens on save (`editor.formatOnSave`, `editor.formatOnSaveMode` and `editor.codeActionsOnSave`, each with the scope that set it, and the three `files.*` settings that edit a file on every save, named with their scope when they are on); whether the incumbent JS-CSS-HTML Formatter is running or left a `.vscode/formatter.json`; which other formatters the workspace is configured for; and what no API can show. A scope is named only when it can be established, and the report says so when it cannot.
  - **It cannot see an extension that formats on save through its own save hook**, because VS Code gives extensions no way to observe that. The report says so on every run and points to the built-in *Help: Start Extension Bisect*.
  - **Strictly read-only.** It writes no setting and no file, opens no connection and hooks no event. The notification's buttons only open the Settings UI or the Extensions view. The command is listed in the Command Palette whatever language is focused.
- **The migration now reads the incumbent's real configuration.** JS-CSS-HTML Formatter reads `.vscode/formatter.json` (a file with `javascript`, `css` and `html` sections), not `.jsbeautifyrc`, and until 0.4.3 Tidy looked only for `.jsbeautifyrc`, so `Tidy: Migrate from JS-CSS-HTML Formatter` could not find the settings you had given the incumbent. It now looks, in this order, for `.vscode/formatter.json` in the first workspace folder, the global `formatter.json` in the incumbent's own install folder (only while the incumbent is installed and enabled), and `.jsbeautifyrc` at a workspace root. The first one found is used, and the recap names it.
  - **Sections become language-specific settings, the way the incumbent applied them**: `css` to `[css]` and `[scss]`, `javascript` to `[javascript]` and `[json]`, `html` to `[html]`. There is no `[less]` or `[jsonc]` block, because the incumbent never formatted those languages.
  - **A key is imported only when Tidy has a setting with the same meaning and the same range of values**, and only for a language where that setting does something and where the incumbent's own js-beautify read it. Every other key is listed as not carried over, except a recognised key whose value is out of range, which is reported in the recap's notes and dropped.
  - **Scope and consent are unchanged in spirit.** Settings from `.vscode/formatter.json` or `.jsbeautifyrc` are written at Workspace scope; settings from the incumbent's global file are written at User scope, never into a repository's `settings.json`. Nothing is written until you confirm a recap of every key and value, and the batch is all or nothing: if a write fails part-way, what was already written is restored and any key that cannot be restored is named. Nothing is read in Restricted Mode, and the files are parsed as data, never executed.
  - **`onSave` is recognised and never proposed.** `true` is the incumbent's own default, so its presence says nothing about what you chose, and the migration never enables Format on Save.
  - **One nuance**: the incumbent's `eol` becomes `tidy.end_of_line`, which yields to `files.eol` and `.editorconfig`, whereas the incumbent applied `eol` absolutely.
  - **The migration no longer depends on the incumbent being enabled.** VS Code's extension API cannot see a disabled extension, so Tidy reads the config file, which outlives it. The advice to disable the incumbent is shown only when it is installed and enabled.
- **Six new settings**, each an option that js-beautify or Prettier already had and Tidy did not expose: `tidy.space_before_conditional` and `tidy.jslint_happy` (JavaScript), `tidy.content_unformatted` and `tidy.void_elements` (HTML), `tidy.prettier.singleAttributePerLine` (TSX, JSX and `.js` with JSX) and `tidy.prettier.objectWrap` (those, plus TypeScript). All six are language-overridable, and with their defaults the output is unchanged.
  - **`content_unformatted` and `void_elements` can only add tag names.** The tags the guard relies on (`pre`, `textarea`, `xmp`, `listing`, `plaintext`) stay protected whatever you write, and `void_elements` refuses those five plus `script` and `style`. An invalid entry is ignored and listed in *Show Effective Configuration*.
  - **The two Prettier options are also read from `.prettierrc`**, which now honours twelve keys instead of ten. `objectWrap` needs Prettier 3.5, so the Prettier dependency range is now `^3.5.0`.
- **When an exclusion file cannot be evaluated, Tidy now says why.** The output channel, *Explain Last Format* and *Show Effective Configuration* (a new `.soukformatignore problem` line) name the line or the reason, instead of a bare "ignored by .soukformatignore". *Show Effective Configuration* also gained an *Option value warnings* section for values that are accepted but partly ignored (today, the two HTML tag lists).

### Changed

- **`tidy.indent` now takes effect.** It was always overridden by the tab size VS Code passes on every format. It now beats `editor.tabSize` and the indentation VS Code detected in the file, but still not a project config (`.editorconfig`, `.prettierrc`, `.soukformatrc`). Spaces versus tabs is still decided by `editor.insertSpaces`, and only a value you actually set counts. Projects that carry a `tidy.indent` (a migrated project, for example) can therefore change indentation.
- **Line width follows the layer order on TypeScript, TSX, JSX and a `.js` file with JSX.** `tidy.wrap_line_length` (which is also where an `.editorconfig` `max_line_length` and a `.soukformatrc` `wrap_line_length` land) and `tidy.prettier.printWidth` are now one value, taken from the highest layer that sets either. A `tidy.prettier.printWidth` in plain VS Code settings no longer beats an `.editorconfig` or a `.soukformatrc`: the README no longer carries the "Known deviation, line width" section. Inside a single layer `printWidth` still wins, and a `[lang]` value beats a global one in both vocabularies.
- **`wrap_line_length` set to `0` now means no line limit on TypeScript, TSX, JSX and the PostCSS fallback (an imported `0` included).** Prettier used to receive nothing and print at its own 80, the opposite of what the setting says. A width nobody set is still 80.
- **`.editorconfig` `max_line_length = off` now means no line limit, as in Prettier.** It used to be ignored, so a lower layer's width (or Prettier's 80) applied. If you have `off` under `[*]`, your output can change. `unset`, `0` and unreadable values are still not forwarded.
- **Per-language values that another extension ships as a default are no longer applied** to `files.eol`, `files.insertFinalNewline` and `files.trimTrailingWhitespace`. An extension can contribute `{"[css]": {"files.insertFinalNewline": true}}` as a default, and Tidy used to read it as if you had chosen it. What you set yourself is unchanged.
- **The blank-line options are scoped to the languages that use them.** `preserve_newlines`, `max_preserve_newlines` and `indent_empty_lines` are no longer declared for JSON, JSONC, TypeScript, TSX and JSX, where they had no effect (output is unchanged), so *Show Effective Configuration* no longer lists them there.
- **`tidy.editorconfig` is now `resource`-scoped.** In a multi-root workspace each folder can switch `.editorconfig` off for itself; `false` in a single folder used to be ignored. It joins `tidy.prettier.respectProjectConfig`, `tidy.soukformatrc` and `tidy.respectSoukformatignore`.
- **Setting descriptions were corrected** for `tidy.indent`, `tidy.brace_style`, `tidy.wrap_line_length`, `tidy.prettier.printWidth` and the three blank-line options: they now say what each one does and which languages it affects.
- **Exclusion patterns follow git's rules**, in `.soukformatignore` and in the `overrides[].files` globs of `.soukformatrc`, and matching is linear and bounded.
  - Character classes (`[abc]`, `[!a]`) and ranges work; `[Dd]ebug/` used to be read literally. `***` behaves as `**`.
  - A `!` line re-includes a file, but **a folder that is excluded cannot be re-included file by file**, as in git.
  - A pattern without a `/` applies at any depth and to the contents of a folder. In `overrides[].files`, `src` used to match only a file named `src`. In `.soukformatignore`, `build/` (a trailing slash matches folders only, so a file named `build` is no longer excluded) and `src**min` (a `**` inside a word acts as `*` and no longer crosses folders) now match less than before. In `overrides[].files`, `src**min` matches less, and `build/` now matches the files inside a `build` folder, where it used to match nothing.
  - Leading blanks are kept as part of the pattern. Lines end at a line feed (CRLF files work); a lone carriage return does not end a line, as in git.
  - **Case**: in `.soukformatignore`, on every OS, exclusion patterns ignore case and `!` re-inclusions respect it, so in doubt Tidy leaves the file alone. In the `overrides[].files` of `.soukformatrc` matching is case-sensitive on every OS, as in Prettier and EditorConfig, so a team file gives the same options everywhere.
- **An exclusion file that Tidy cannot evaluate now excludes the files it governs, and the reason is shown.** A `.soukformatignore` larger than 1 MiB, or too costly to evaluate (pathological patterns), excludes every file it governs. A line that cannot be evaluated (for example one over 1 024 characters, or ending in a lone backslash) excludes them too, except the files that a later valid `!` line re-includes; a `!` line that cannot be evaluated excludes nothing and re-includes nothing. Tidy does not format the file, and the reason appears in the output channel, *Explain Last Format* and *Show Effective Configuration*. The nearest `.soukformatignore` still wins, walking up to the root of the drive (at most 64 folders), including for a file opened outside any folder, as in 0.4.x.
- **`tidy.deferToOtherFormatters: silent-defer` no longer reads the workspace at activation.** It used to list the workspace root and read `package.json` for a result nothing used. The behaviour you see is unchanged: no notification, no setting written. *Show Effective Configuration* still lists the formatters it finds, whatever the setting says.
- **Format Selection now refuses instead of dropping a `// prettier-ignore`.** 0.4.0 and 0.4.1 listed this as a known limitation: during Format Selection on the Prettier path, Prettier is handed only the selected lines and cannot see a directive outside them. When the selection covers code that a `prettier-ignore` comment outside the selection protects, Tidy now writes nothing and says to use *Format Document* for that code. If the document cannot be parsed to decide, Tidy says so and formats the selection as before.

### Fixed

- **Deciding whether a large `.js` file contains JSX no longer freezes the editor.** The check that routes a plain `.js` file to Prettier or to js-beautify took several seconds on a multi-megabyte file with many `<` comparisons. It now answers "no JSX" only when it is certain, and routing is unchanged.
- **JSX inside an HTML `<script>` could be mangled and accepted.** The guard compared the tag boundaries of JSX in `.jsx` and `.tsx` files but not in an executable `<script>` of an HTML file, so a format that detached an opening `<` from its tag name (`< App x = {`) was accepted. It is now refused with zero edits. Valid JSX such as `<Foo / >` is still accepted, and the new check refuses none of the 14 HTML files tracked in this repository.
- **Verifying a large JavaScript file dense in template literals no longer takes close to a minute** (1 MB: about 55 s in 0.4.3, about 5 s now). The JSX tag check re-tokenised the file; it now reads the tag positions from the syntax tree the guard already builds. The same check, added for HTML `<script>` bodies, does not slow down a large `<script>`.
- **A failed load of the guard's engine while it checks JSX tags is reported as an engine failure**, not as a rejection of your code.
- **A `.soukformatrc` with a byte-order mark was ignored in full.** It is now read, and `.soukformatignore` accepts a byte-order mark too.
- **A pathological exclusion pattern could keep the extension host busy for minutes or far longer.** Matching is now linear and bounded by a work budget; see Changed for what happens when the budget runs out.

### Known limitations

- A `.soukformatignore` close to its maximum size (1 MiB) is read again on every format, which costs from about 50 ms (ordinary patterns) to about half a second (many character classes) for a 1 MiB file.
- If evaluating the `overrides` of a `.soukformatrc` exceeds its work budget, the remaining overrides are ignored, and the warning appears only in *Show Effective Configuration*.
- On a network share modified from another machine, the cached configuration can stay stale for a few seconds (the share's attribute cache).
- The search for a `.soukformatignore` stops 64 folders above the file, not at the root of the drive, for a file nested more deeply than that. Unchanged from 0.4.x.
- On Linux and macOS, where a file name may contain a backslash, such a name is split as if the backslash were a folder separator, so a pattern may not exclude it. Unchanged from 0.4.x.
- Unchanged from 0.4.1, and still true: a line-scoped directive comment (`// @ts-expect-error`, `// eslint-disable-next-line`) can end up governing a different line when reflow splits the statement it covered. Comments are compared as a position-free multiset, so the guard does not see it. Runtime semantics are unchanged; only what the type checker or linter suppresses moves.

## [0.4.3] - 2026-10-07

A metadata-only release. **No code changed**: the extension formats exactly as 0.4.1 and 0.4.2 do.

### Changed

- **The extension is listed again as `Tidy: JS/CSS/HTML Formatter & Beautifier`**, the name it had before 0.4.2. The shorter `Tidy HTML Formatter` made it harder to find for people searching for a JS, CSS or beautifier tool, so it goes back. The extension id `ced-lab.tidy-formatter` is unchanged, so your installation, your settings and your updates are unaffected.
- If you pick a formatter by hand through *Format Document With...* or *Configure Default Formatter...*, look for **Tidy: JS/CSS/HTML Formatter & Beautifier** in the list. The walkthrough and README use that name again.

## [0.4.2] - 2026-09-30

A metadata-only release. **No code changed**: the extension formats exactly as 0.4.1 does.

### Changed

- **The extension is now listed as `Tidy HTML Formatter`**, shorter than the previous `Tidy: JS/CSS/HTML Formatter & Beautifier`. Nothing about what it does has changed: it still formats JavaScript, TypeScript, JSX/TSX, CSS, SCSS, LESS, HTML and JSON, as the description says. The extension id `ced-lab.tidy-formatter` is unchanged, so your installation, your settings and your updates are unaffected.
- If you pick a formatter by hand through *Format Document With...* or *Configure Default Formatter...*, look for **Tidy HTML Formatter** in the list. The walkthrough and README use the new name.

## [0.4.1] - 2026-09-15

A patch release, fixes only. It closes fourteen verified defects, every one of
them reproduced with a probe against the shipped code before being touched, and
it does so WITHOUT changing a single line of logic in the safety guard: the whole
diff for `src/safety/guard.ts` is comments. The rule for this release was to stop
handing the guard a bad input rather than to change what the guard believes.

Measured against 0.4.0 by a paired campaign (every selection boundary on a corpus
of documents, plus a large random sweep, run through both builds and judged by an
oracle built from the parsers rather than from the guard): **2 029 writes that
corrupt on 0.4.0 no longer do, and nothing new does.**

### Fixed : what Tidy writes

- **Format Selection could silently change what your HTML renders.** js-beautify trims the edges of the slice it is handed, and the guard does not see a whitespace-only text node disappear, so `<p>hello <b>x</b> <i>y</i></p>` could be written back as `hello xy`. Measured on five ordinary snippets: 353 of 7 266 possible selections wrote a changed rendering; now 0. Whole-document formatting was never affected.
- **A selection ending in a line break never stopped changing the file.** The printer stripped the final break and the splice glued the next line on, so each format produced another edit, for ever: passes 1 through 6 gave 1, 1, 1, 1, 1, 1 edits in JavaScript, HTML, JSON and CSS alike. They now settle on pass 2, which is what the README has always promised.
- **A selection cutting through a tag could write mangled markup.** Such a range is not a formattable unit: Tidy now refuses it explicitly, with zero edits and a message saying to select whole elements, instead of relying on a guard rejection that happened to fire by accident.
  - **This refusal is deliberately WIDER than the defect, and you may notice it.** Of the selections it declines, roughly seven percent were the ones that corrupted; the rest would have reformatted safely. Telling them apart needs the guard to model which whitespace a browser actually draws, which is a design change scheduled for 0.5.0, so until then Tidy refuses the whole class rather than guess. Selecting whole lines or whole elements, which is what an editor's line and block selections give you, is unaffected; a drag that starts or ends in the middle of `<button` now ends in a message instead of a reformat.
- **An apostrophe in HTML text silently destroyed `tidy-ignore` protection.** One `'` anywhere before the markers made the scanner treat the rest of the file as a string, so the protected region was never masked AND no notice was shown: the formatter then rewrote bytes you had explicitly fenced. The marker scanner now models markup properly (character data, inside a tag, raw text inside `<script>` and `<style>`) and quotes bind only where the language really quotes.
- **Line endings.** Several paths wrote a file with mixed endings. With `insertFinalNewline` on and no explicit `files.eol`, the js-beautify family appended a bare LF to a CRLF document; the Prettier family rewrote a whole CRLF document to LF; a CR-only document got an LF terminator; and a full-span selection with an explicit `files.eol` converted the interior while restoring the edge verbatim. The rule is now one rule everywhere: when you have said what you want, Tidy writes that, and when you have not, it keeps what the document already uses.
- **Protected spans stay byte for byte, even against an explicit `files.eol`.** An explicit end-of-line setting applies to the whitespace of your own selection, never to bytes inside a `tidy-ignore` region or a template island. That was the documented promise and it is now true in this case too.

### Fixed : commands

- **`Tidy: Use Tidy as my Formatter` could leave a partial write behind.** If the settings write failed part-way, the languages already written stayed written while the message said nothing had been saved. It now rolls back, reusing the mechanism the format-on-save path already had, and if a key genuinely cannot be restored the message names it instead of claiming a clean failure.
- **`Preview Format (Diff)` showed a stale diff on a second preview.** VS Code resolves a read-only document URI once, so previewing the same file twice displayed the FIRST result while *Apply* wrote the current one. Each preview now gets its own URI.
- **A component named `_Foo` or `$Bar` no longer breaks formatting.** The check that routes a `.js` file containing JSX to Prettier ignored those two leading characters, so the file went to js-beautify, came back mangled, and was correctly rejected by the guard: a warning and no format, on perfectly ordinary code.

### Fixed : other

- **A `tidy-ignore` region no longer disables the CSS second chance.** The placeholder was not valid CSS, so the PostCSS fallback threw and a file the first engine had rejected ended up formatted by nobody. The placeholder is now comment-shaped and survives both engines.
- **Formatting a large template file is no longer quadratic.** Restoring protected islands was O(bytes x islands): 727 KB with 18 001 islands took 13.2 seconds. It now takes 10 milliseconds, with byte-identical output verified over 54 608 differential comparisons and every damage check (a dropped, duplicated, split or case-changed placeholder) still refused.
- **An engine failure no longer says your file could not be verified.** A selection that is not a complete piece of code makes the printer fail, which is a normal thing to happen; it was being reported with the guard's wording, which accuses the file of something the verifier never got to check.

### Fixed : packaging and release

- **Scratch files could be packaged into the extension.** Directories named `_probe*` were in neither `.gitignore` nor `.vscodeignore`, and `vsce ls` really did list their non-TypeScript contents among the packaged files. They are excluded now, verified by planting one and checking the package listing, nested directories included. No released version is known to have shipped one.
- **A manual workflow run can no longer publish.** The release workflow only checked that the ref was a tag, not that the run came from a push, so a `workflow_dispatch` on an existing tag would really publish to both registries. It now requires both. The publishing tokens were also being passed on the command line, where they are visible in the process list; they stay in the environment.

### Documentation

- **Three comments denied something the README discloses honestly.** The guard keeps the first line of a parser error and drops only the code frame, and that first line names the offending token, so a diagnostic can read `Identifier 'CLIENT_SECRET_abc123' has already been declared`. README says so; `previewFormat.ts`, `lastFormat.ts` and `statusBar.ts` each claimed the opposite, as did a comment inside the guard itself. Corrected to match the behaviour, which is unchanged.
- The notice shown when `tidy-ignore` cannot be honoured on the Prettier path advised using `// prettier-ignore` "which it honours natively". That is not true during *Format Selection*, where Prettier is handed only the selected lines and cannot see a directive outside them.
- README now states a real deviation instead of denying it: `tidy.prettier.printWidth` currently overrides `.editorconfig` `max_line_length` and `.soukformatrc`, which the documented layer order says it should not. The code fix is scheduled for 0.5.0.
- Corrected a comment claiming the `.soukformatrc` upward-walk defect was still open (0.4.0 fixed it) and a test header claiming coverage of a migration write path that has none.

### Tests

- 4 074 to 4 401 unit tests, and 63 of 63 integration tests in a real VS Code host.
- **One integration test was passing only because of a defect.** Its HTML fixture was the formatter's exact fixed point, so the only reason it ever produced an edit was the final-newline bug fixed in this release. Worse, at zero edits the pipeline short-circuits, so the case could not prove the thing it existed to prove. The fixture was replaced and the missing assertion added: nothing anywhere asserted that formatting HTML loads the HTML guard chunk, which is how the drift went unnoticed for two releases.

### Known limitations

Unchanged from 0.4.0, and still true:

- A line-scoped directive comment (`// @ts-expect-error`, `// eslint-disable-next-line`) can end up governing a different line when reflow splits the statement it covered. Comments are compared as a position-free multiset, so the guard does not see it. Runtime semantics are unchanged; only what the type checker or linter suppresses moves. The fix is a new guard rule, which measured two false rejects over the 174 files of this repository, so it needs a wider corpus than one project before it ships.
- `// prettier-ignore` is not honoured during *Format Selection* on the TypeScript path, because Prettier is handed only the selected span and cannot see a directive that sits outside it.

## [0.4.0] - 2026-09-08

The release that makes Tidy start fast, read your project's Prettier config, and
tell you what it did. It is also the release in which the safety guard was
audited adversarially, end to end, for the first time: nine independent passes
found eleven cases where Tidy could write output that was NOT equivalent to your
original, every one of them present in 0.3.0 and earlier. All eleven are closed
below, each with a test that fails against the previous code.

### Added

- **Tidy reads your project's Prettier config.** On the TypeScript/TSX/JSX path (and a `.js` file containing JSX, which Prettier prints too), Tidy now honours the data variants of your Prettier configuration: `.prettierrc`, `.prettierrc.json`/`.json5`/`.yaml`/`.yml`/`.toml`, or the `prettier` key of `package.json`, found in Prettier's own search order (nearest wins, `package.json` first) but never above your workspace folder. Exactly ten AST-safe stylistic keys are read (`printWidth`, `tabWidth`, `useTabs`, `semi`, `singleQuote`, `jsxSingleQuote`, `trailingComma`, `bracketSpacing`, `bracketSameLine`, `arrowParens`); everything else, including `parser`, `plugins` and per-glob `overrides`, is ignored and listed in *Show Effective Configuration*.
  - **Code-based configs are never executed.** When the nearest config is `.prettierrc.js`, `prettier.config.mjs` or any other executable form, Tidy skips the layer entirely rather than guessing, and says so. Running a workspace file to decide how to format it would be arbitrary code execution from a folder you only opened.
  - The layer sits between `.editorconfig` and `.soukformatrc`, so your `.soukformatrc` still has the last word. Opt out with `tidy.prettier.respectProjectConfig: false`. Always ignored in Restricted Mode.
- **`Tidy: Show Format History`.** A chronological view of this session's format attempts (the fifty most recent, newest first, across all files): status icon, file, language and age. Picking an entry writes the full explanation to the **Tidy Formatter** output channel. In memory only, content-free, read-only, and cleared when the window reloads.
- **The output channel now names the engine that actually ran.** JSON and JSONC are formatted by jsonc-parser, not js-beautify, and a `.js` file containing JSX is printed by Prettier; both were previously reported under the wrong engine in the status bar, the channel and *Explain Last Format*.

### Changed

- **The bundle no longer loads at startup.** The Prettier printer and the three parsers backing the safety guard now ship as four on-demand chunks. Opening a file loads only the host bundle: **399 876 bytes instead of 2 818 641**, a cold `require` median of **22 ms instead of 44 ms**, and **1.3 MB retained instead of 11.2 MB**. Each engine loads the first time it is genuinely needed, and an idle preloader, five seconds after activation, warms only the chunks the languages you actually have open will need: a session with only stylesheets open never loads the TypeScript printer at all. Verified on the packaged VSIX, not just in development: zero chunks are in the module cache after `activate()`.
  - **The guard is never lazier than the write.** The verifier is always loaded before any edit is produced. If a chunk fails to load, that format is abandoned with zero edits and is reported as an engine failure, never as a rejection of your code.
- **Setting `editor.defaultFormatter` now shows you the exact keys first.** *Tidy: Use Tidy as my Formatter* previously wrote it after two quick picks. It now shows a modal listing the exact keys and values it would write, the target scope, what it would replace, and the line "Nothing has been changed yet"; only the confirm button writes, and cancelling writes nothing. This matches what the README had been promising and what the format-on-save path already did.
- `.soukformatrc` is no longer read from outside your workspace folder. The upward search previously ran to the filesystem root, so a file you never opened could govern how your code was formatted.

### Fixed : the safety guard

Every item below is a case where Tidy could WRITE output that differs from your
original. Each is closed with a test that fails against the previous code.

- **JSON verdicts depended on the size of the document.** Above 262 144 characters the guard switched to native `JSON.parse`, which keeps only the last member of a duplicated key, while smaller documents were parsed with jsonc-parser, which keeps them all. Deleting a duplicate member from a large document was therefore accepted as equivalent, and a large document that legitimately kept its duplicates was rejected. The fast path is gone; the verdict is now the same at every size, proven by a differential oracle of 1 200 pairs against an independent reference implementation.
- **`<xmp>`, `<listing>` and `<plaintext>` were reflowed.** The guard knew only `<pre>` and `<textarea>`, so a tab inside these three could be rewritten as spaces and accepted, changing the rendered text.
- **A selection was judged out of context.** *Format Selection* over text inside a `<pre>`, `<textarea>` or `<pre><code>` collapsed its whitespace and was accepted, while the identical change was correctly rejected on the whole document. Selections are now spliced back into their document before the guard is asked, so the verdict no longer depends on how much of the file you selected.
- **HTML front matter was unprotected in a selection.** The leading `---` block was masked at document scope only, so *Format Selection* (and `editor.formatOnSaveMode: "modifications"`, which formats ranges) reflowed the YAML: nested keys were promoted to the top level and block scalars were destroyed.
- **Template islands were unprotected in a selection.** An island whose delimiters straddled the selection boundary was never masked, so its interior was reflowed: a statement could be pulled onto a `//` comment line, after which the template emitted nothing, and string literals lost runs of spaces.
- **`xml:space="preserve"` was ignored.** SVG draws every space character under it, so `<text xml:space="preserve">A  B</text>` was silently rewritten to a single space.
- **CSS `white-space` was ignored.** An element carrying `white-space: pre`, `pre-wrap`, `pre-line` or `break-spaces` had its drawn whitespace reflowed and accepted: column-aligned tables, indented code samples and pre-wrap prose all lost their layout. Whitespace significance is now one model with three sources (the preformatted tags, `xml:space` and CSS `white-space`), inherited down the tree the way the cascade inherits it. Because deciding which elements an embedded stylesheet applies to would require matching CSS selectors against the tree, a document whose `<style>` sets a preserving value anywhere is now **refused with the file untouched** rather than reflowed on the bet that the rule matches nothing.
- **The CSS guard treated twenty non-CSS code points as whitespace.** It used JavaScript's `\s` class while the printer rewrites U+00A0, U+2000 and eighteen others to an ordinary space. A no-break space inside a selector therefore turned one class into a **descendant combinator**, changing which elements the rule matches, and the guard folded both sides so it could not see it. A sweep of 2 635 probes across nine languages found 519 such cases; all are now refused, and 514 of them are rescued outright by the PostCSS fallback, which preserves the code point.
- **A failed chunk load was reported as a rejection of your code.** On the HTML path it surfaced as "could not be proven equivalent" instead of an engine failure. Zero edits either way, but the message accused your file of something the verifier had simply not run to check.
- **A malformed engine chunk could make the guard answer vacuously.** The loader validated only the type of each export, so a chunk exporting callable but degenerate parsers loaded cleanly and made every comparison trivially true. Each guard chunk now runs a behavioural canary at load (0.09 to 0.20 ms once per session) and a chunk that fails it is never cached.
- **`Preview Format (Diff)` could overwrite an edit made while the diff was open.** *Apply* wrote text verified before the preview, over a range recomputed from the current document, with no version check. It now re-checks the document version and its full text immediately before writing, and refuses with zero edits if the buffer moved.

### Fixed

- **Formatting a file with `tidy-ignore` markers is idempotent again.** In HTML every format added two more spaces before `<!-- tidy-ignore-start -->`, without bound; in CSS, SCSS and LESS the newline after `/* tidy-ignore-end */` was eaten and the next selector glued onto the marker line. The repository's idempotence corpus had no marker fixtures, which is why it was never caught; it now has thirty-six, across six languages and CRLF.
- **`Format Selection` no longer stops halfway.** When a selection contained a masked span, the range handed to the engine was expressed in the wrong coordinate space, so the tail of the selection came back unformatted, and in some cases nothing was formatted at all.
- **`tidy-ignore` regions are honoured in a selection**, and on the Prettier path, where they cannot be honoured, their presence is now reported instead of silently ignored.
- **A missing or quarantined `one_ini_bg.wasm` no longer breaks all formatting.** The EditorConfig parser is loaded lazily behind a guarded call: if the asset is unavailable, the `.editorconfig` layer is skipped, formatting continues, and the reason is stated once in the output channel and in *Show Effective Configuration*.
- **`<template>` elements no longer break HTML formatting.** Every document containing one was permanently rejected with a warning, which affected web components, Vue, Alpine and htmx alike.
- The status bar and *Explain Last Format* no longer disagree about the same file.

### Documentation

- **Every user review quoted in the README was verified against its source.** Two had no source at all and were removed (one attributed a quote to an issue that does not contain it), four were altered rather than merely shortened and have been restored to their exact wording, and one was credited to an issue whose title is about something else entirely.
- **The README's central claim about the incumbent was backwards and has been corrected.** It said most one-star reviews were about a formatter acting without consent. Counting the corpus: of 85 one-star reviews, **53 are about broken or corrupted output** and **26 are about acting without consent** (10 are both, 16 neither). Broken output dominates, which is what the equivalence guard exists to answer. The figures for the incumbent are now dated and measured (3 969 079 installs, 1.69 stars over 241 ratings, last updated 2017-03-31, as of 2026-09-07).
- Several other claims that were not literally true have been corrected, including the size of the exposed option surface, which options are language-overridable, what the output channel records, and what `.soukformatignore` cascading actually does. A test suite now pins each documented claim to the code that makes it true.

### Known limitations

- A line-scoped directive comment (`// @ts-expect-error`, `// eslint-disable-next-line`) can end up governing a different line when reflow splits the statement it covered. Comments are compared as a position-free multiset, so the guard does not see it. Runtime semantics are unchanged; only what the type checker or linter suppresses moves.
- `// prettier-ignore` is not honoured during *Format Selection* on the TypeScript path, because Prettier is handed only the selected span and cannot see a directive that sits outside it.
- A `tidy-ignore` region in a CSS file disables the second-chance PostCSS fallback for that file.

## [0.3.0] - 2026-08-11

The release that makes Tidy explain itself, format more of what you actually
write, and let you opt in to format on save without editing JSON by hand. The
safety guard remains the final judge on every write path, including the two new
ones below, and Tidy still never hooks the save event.

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
- **Per-family size cap: `tidy.json.maxFileSizeKB` (default `10240`).** Large JSON and JSONC documents such as `package-lock.json` now format instead of being skipped as too large. JSON gets its own, higher cap because Tidy formats it on a fast linear path (jsonc-parser, about 13x faster than js-beautify on big documents) and verifies it with a cheap value-equality check, so multi-megabyte JSON stays well within the performance budget: a ~10 MB document is format-plus-guard benchmarked and CI-gated under 4 seconds. An explicitly set `tidy.json.maxFileSizeKB` wins over `tidy.maxFileSizeKB` for JSON/JSONC; when it is unset, an explicit `tidy.maxFileSizeKB` still applies; `0` disables the cap. Heavier families (js-beautify, Prettier, AST guard) keep the stricter `5120` KB cap. The safety guard is unchanged and still verifies every applied edit.
- **`Tidy: Open Playground` and a "Try it now" walkthrough step.** The getting-started walkthrough gains a second step that opens **two untitled scratch documents** (the repository's real `messy.css` and `messy.tsx` samples, embedded in the bundle) and invites you to run **Tidy: Preview Format (Diff)** on them. The first look at what Tidy does now takes 30 seconds, on buffers that **never touch your disk**: opening the playground creates zero files, writes no setting and adds no hook, and the step completes only once you have actually previewed a format. The samples are locked byte for byte against `samples/` by a unit test, so the playground, the listing visuals and the integration demo all showcase the same inputs.
- **Performance instrumentation, gated in CI (developer tooling; zero runtime change).** Three new gates freeze today's numbers before the lazy-loading work planned for 0.4.0, so that any drift becomes a red build instead of a silent slide.
  - **Startup harness** (`npm run perf:startup`): measures the cold `require` of the production bundle in a child Node process with a stubbed `vscode` module, five samples, median reported. Fails when the median exceeds its budget (400 ms locally, x3 on CI; calibrated on measured medians of 207.7 ms idle and 256.5 ms under load) or when the heap retained at load exceeds 40 MB (measured: 10.7 MB). It also asserts the bundle still exports `activate`/`deactivate`, that the `vscode` require path was really exercised, and, once code splitting lands, that zero lazy chunks load at require time.
  - **Bundle size budgets** (`npm run check:bundle`): the production build now emits `dist/meta.json` (esbuild metafile, excluded from the VSIX and from git); every shipped executable in `dist/` must stay under its frozen budget in `scripts/bundle-baseline.json` (`extension.js` 2 900 000 bytes against a measured 2 818 641; `one_ini_bg.wasm` 120 000 against 89 224), no budgeted file may disappear, and no unbudgeted executable may appear. `npm run analyze` prints the top 20 size contributors so a size increase can be attributed to a module instead of guessed at.
  - **Perf regression baseline** (`npm run perf:check`): `npm run perf` now writes `test/perf/results.json` (p50, p95, guard share and the guard verdict per language, uploaded as a CI artifact); the gate fails when any p95 drifts beyond the versioned `test/perf/baseline.json` x1.35 (x3 more on CI). `npm run perf:baseline` regenerates that baseline deliberately, is refused on CI, and produces a diff a reviewer can read.
  - No change to formatting behaviour, to any decision the safety guard makes, or to the provider-only integration surface: nothing under `src/` was touched. The results file is designed to accept future scenarios (memory, configuration, pathological guard inputs) as additional sections without any coordination between harnesses.
- **Clearer "too large" diagnostics.** The skip notification, the status bar tooltip, the Output channel line and `Tidy: Explain last format` now name the applied cap, its exact setting key and whether it came from your settings or the default, and the *Open Settings* button targets that exact key. `Tidy: Show Effective Configuration` gained a `Size limit` line for the active document.

### Changed

- **Settings are now grouped into seven titled sections** (general and safety, indentation and line endings, JavaScript, CSS/SCSS/LESS, HTML, TypeScript and JSX, project and coexistence) with ordering and richer descriptions. **No setting was renamed or removed**: all 46 `tidy.*` setting identifiers are unchanged, so existing configurations keep working exactly as before.
- **Commands no longer appear for unsupported languages.** `Preview Format`, `Explain Last Format` and `Show Effective Configuration` are now gated on the active language, instead of appearing in the palette and failing when run.
- Command titles are consistently Title Case.
- **`Tidy: Preview Format (Diff)` now honours the full formatting pipeline.** Before doing any work, the preview applies the same pre-checks as *Format Document*, in the same order: `tidy.<lang>.enable`, the effective size cap (`tidy.json.maxFileSizeKB` for JSON/JSONC, `tidy.maxFileSizeKB` otherwise), `.soukformatignore`, and top-of-file ignore markers. When a check refuses, Tidy says which one in a non-blocking message and opens no diff, so the preview can never offer a change that a real format would refuse to produce. The preview stays read-only: it records nothing, so `Explain last format` keeps describing your last real format.

### Fixed

- **Every user-facing string is now in English.** Seventeen notification strings in the preview, configuration, formatter-opt-in and formatting-provider paths were still in French, while the rest of the product was English. A test now fails the build if a French string reappears, and another fails it if an em dash is introduced anywhere in the shipped surface.
- **The size guard now runs before any document-proportional work** (ignore-file lookup, in-source marker scan), so skipping an oversized document is immediate. A non-number value in `tidy.maxFileSizeKB` no longer silently disables the guard: it falls back to the default instead.
- **A cancelled format no longer runs the safety guard.** The provider now yields once before the guard and re-checks the cancellation token, so pressing Escape on a multi-megabyte document stops the work instead of paying for the whole equivalence check first. Cancelling still writes nothing: without an `equivalent` verdict no edit is ever produced.

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
