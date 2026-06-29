# Choose Tidy as your formatter — one click, fully reversible

By design, Tidy does **nothing** on its own after install: it never registers itself as your default formatter and never hooks "save". That is the opposite of the incumbent's "it formats whether you like it or not" — but it also means *you* decide when Tidy takes over.

The fastest way to opt in is the built-in command:

1. Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`).
2. Run **Tidy: Use Tidy as my formatter** (`tidy.useAsFormatter`).
3. Pick the language(s) you want Tidy to format.

Tidy then writes `editor.defaultFormatter` **only for the languages you picked** (using VS Code's per-language override), at **Workspace** scope by default — so the choice is scoped to this project and easy to undo. Tidy writes **nothing** until you confirm, and it **never** touches `editor.formatOnSave`.

Prefer to do it by hand? You can always use the standard VS Code flow instead:

- Right-click in an editor → **Format Document With…** → **Configure Default Formatter…** → choose **Tidy Formatter — JS/CSS/HTML**.

Or set it per language in `settings.json`:

```jsonc
{
  // Example: use Tidy for CSS, keep your other formatter for everything else.
  "[css]": { "editor.defaultFormatter": "ced-lab.tidy-formatter" }
}
```

You can also just run **Format Document** (`Shift+Alt+F`) on any supported file — if another formatter is already your default, pick Tidy once via **Format Document With… → Tidy Formatter**. No default-formatter change required.
