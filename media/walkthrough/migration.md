# Migrating from JS-CSS-HTML Formatter

[JS-CSS-HTML Formatter](https://marketplace.visualstudio.com/items?itemName=lonefy.vscode-JS-CSS-HTML-formatter) (`lonefy.vscode-JS-CSS-HTML-formatter`) is a popular beautifier (~3.95M installs) that has not been updated since 2017 and sits at roughly 1.7★. Most of its one-star reviews are not about *bad* formatting — they are about a formatter that acts **without consent**: it formats on save even when you disabled it, makes itself the default formatter, overrides your editor settings, and occasionally breaks valid code. Tidy is a clean-room replacement that keeps the "configurable beautify" niche while removing the destructive behaviour.

**Recommended migration (2 minutes):**

1. **Disable or uninstall JS-CSS-HTML Formatter.**
   Open the **Extensions** view, search for *JS-CSS-HTML*, and choose *Disable* or *Uninstall*. This is the single most important step: while it is enabled it can keep formatting on save regardless of your settings.

   > Tidy cannot disable another extension for you — VS Code provides no API for
   > that, and Tidy will never pretend it did. It can only **guide** you to the
   > Extensions view; the toggle is yours to flip.

2. **Keep Tidy installed.** It will *not* take over on save automatically — that is the point.

3. **Opt in to the behaviour you want.** Run **Tidy: Use Tidy as my formatter** to choose your languages, then turn on `editor.formatOnSave` yourself if you want it (see the earlier steps).

**Importing your old settings (optional).**
If your project has a `.jsbeautifyrc`, Tidy can offer a one-time, best-effort import of the options it understands. This is **opt-in and one-shot**: Tidy shows a single, non-intrusive notification, never repeats it, and offers a *Don't ask again* action. Nothing is written until you confirm a summary of what will change. In Restricted Mode, `.jsbeautifyrc` is **not read** (Workspace Trust gate).

In most cases there is nothing to port: Tidy reads your existing VS Code settings (`editor.tabSize`, `editor.insertSpaces`, per-language overrides) directly.
