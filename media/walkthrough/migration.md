# Migrating from JS-CSS-HTML Formatter

[JS-CSS-HTML Formatter](https://marketplace.visualstudio.com/items?itemName=lonefy.vscode-JS-CSS-HTML-formatter) (`lonefy.vscode-JS-CSS-HTML-formatter`) is a popular beautifier that has not been updated since 2017. Measured on the Marketplace `extensionquery` API on 2026-09-07: **3,969,079 installs**, a **1.69★ average over 241 ratings**, and a last version (0.2.3) published on **2017-03-31**. We classified every one-star review in our snapshot of that listing (the 100 most recent reviews, retrieved 2026-06-28; 85 of them are one-star and carry text, the most recent dated 2025-02-11). **53 of those 85 are about broken or corrupted output**: mangled JSX, a split `?.`, stray spaces inside class and id names, files that stop parsing. **26 are about a formatter acting without consent**: formatting on save after you turned that off, making itself the default formatter, ignoring your settings, overriding Prettier or ESLint. 10 reviews make both complaints and are counted in both figures, and the remaining 16 are invective with no attributable cause. Broken output is the dominant complaint, so it is the one Tidy answers first: every format is proved equivalent to your input before a single character is written, and when that proof fails Tidy makes zero edits. Acting without consent is the second, and Tidy hooks no save event and writes no setting you have not confirmed. Tidy is a clean-room replacement that keeps the "configurable beautify" niche while removing the destructive behaviour.

**Recommended migration (2 minutes):**

1. **Disable or uninstall JS-CSS-HTML Formatter.**
   Open the **Extensions** view, search for *JS-CSS-HTML*, and choose *Disable* or *Uninstall*. This is the single most important step: while it is enabled it can keep formatting on save regardless of your settings.

   > Tidy cannot disable another extension for you : VS Code provides no API for
   > that, and Tidy will never pretend it did. It can only **guide** you to the
   > Extensions view; the toggle is yours to flip.

2. **Keep Tidy installed.** It will *not* take over on save automatically : that is the point.

3. **Opt in to the behaviour you want.** Run **Tidy: Use Tidy as My Formatter** to choose your languages and confirm the recap of the exact keys, then let its optional last step enable `editor.formatOnSave` for those same languages, or turn that setting on yourself (see the earlier steps).

**Importing your old settings (optional).**
**Tidy: Migrate from JS-CSS-HTML Formatter** does a best-effort import of the settings you gave the incumbent. It reads `.vscode/formatter.json` in your first workspace folder (the file the incumbent really reads), else the incumbent's global `formatter.json` while the incumbent is installed and enabled, else a `.jsbeautifyrc`, and uses the first one it finds. Nothing is written until you confirm a recap of the exact `tidy.*` settings it would import: at Workspace scope, or at User scope for the incumbent's global file. The incumbent's `onSave` is never imported, and the migration never turns on format on save. In Restricted Mode, none of these files is **read** (Workspace Trust gate).

The notification that offers all this is triggered by that extension being **installed**, not by the presence of a config file: when Tidy activates and finds `lonefy.vscode-JS-CSS-HTML-formatter`, it shows one non-modal notice. It is **one-shot and deduplicated**, at most once per machine and profile, carries a *Don't ask again* action, and is never repeated. The command itself is always available from the Command Palette.

In most cases there is nothing to port: Tidy reads your existing VS Code settings (`editor.tabSize`, `editor.insertSpaces`, per-language overrides) directly.
