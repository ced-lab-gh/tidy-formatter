# Choose Tidy as your formatter : one click, fully reversible

By design, Tidy does **nothing** on its own after install: it contributes no `editor.defaultFormatter` in its manifest, writes that setting only from the command below and only after you confirm it, and hooks no "save" event anywhere. That is the opposite of the incumbent's "it formats whether you like it or not" : but it also means *you* decide when Tidy takes over.

The fastest way to opt in is the built-in command:

1. Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`).
2. Run **Tidy: Use Tidy as My Formatter** (`tidy.useAsFormatter`).
3. Pick the language(s) you want Tidy to format.
4. Pick the scope: **Workspace** (this project only, the default) or **User** (all your projects).
5. Read the modal recap and confirm it. The recap lists the exact `"[lang]": { "editor.defaultFormatter": "ced-lab.tidy-formatter" }` keys, the scope they go to, and the name of any formatter each key would replace; a language already pointing at Tidy is listed as such and is not rewritten.

Tidy then writes `editor.defaultFormatter` **only for the languages you confirmed** (using VS Code's per-language override), at the scope you chose, **Workspace** by default : so the choice stays scoped to this project and is easy to undo. Tidy writes **nothing** before that confirmation: cancel at any step, the recap included, and not one setting changes.

That write touches `editor.defaultFormatter` and nothing else. Format on save is then offered as a **separate, optional step**, whose first and recommended choice is *No, keep formatting manual*. Choose to enable it and you get a **second** modal recap listing the exact `"[lang]": { "editor.formatOnSave": true }` keys for those same languages; it is written only after you confirm that one too, and the success message carries a one-click **Revert** that restores the previous values. Either way Tidy installs no save hook: VS Code core owns the save lifecycle (see the *Format on save* step).

Prefer to do it by hand? You can always use the standard VS Code flow instead:

- Right-click in an editor → **Format Document With…** → **Configure Default Formatter…** → choose **Tidy HTML Formatter** (the name the picker and the Marketplace both show).

Or set it per language in `settings.json`:

```jsonc
{
  // Example: use Tidy for CSS, keep your other formatter for everything else.
  "[css]": { "editor.defaultFormatter": "ced-lab.tidy-formatter" }
}
```

You can also just run **Format Document** (`Shift+Alt+F`) on any supported file : if another formatter is already your default, pick Tidy once via **Format Document With… → Tidy HTML Formatter**. No default-formatter change required.
