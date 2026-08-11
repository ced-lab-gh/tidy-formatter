# Format on save : always your call

The #1 complaint about the abandoned *JS-CSS-HTML Formatter* was that it formatted on save **even when you had turned that off**. Tidy makes that impossible by design: **Tidy never hooks the save event at all, and never enables `editor.formatOnSave` behind your back.** The *Use Tidy as my Formatter* command can enable it for you, per language, but only after you confirm a recap of the exact keys it will write, and the success message offers a one-click **Revert**.

The entire save lifecycle : *when* a save happens, *whether* it formats, which formatter runs, where the cursor lands : is owned **100% by VS Code core**, not by Tidy. There is deliberately no Tidy-specific "format on save" toggle: the opt-in flow writes the stock VS Code setting, nothing custom. You can also turn it on yourself at any time:

```jsonc
{
  "editor.formatOnSave": true
}
```

You can scope it per language, so Tidy only runs where you want it:

```jsonc
{
  "[css][scss][less]": {
    "editor.formatOnSave": true,
    "editor.defaultFormatter": "ced-lab.tidy-formatter"
  }
}
```

> **"I installed Tidy and saving no longer reformats."**
> That is expected : Tidy never auto-formats. Set `editor.formatOnSave` yourself
> (above) and make Tidy your default formatter for the languages you want
> (see the previous step) to get the behaviour you choose.

Because Tidy delegates the save lifecycle entirely to VS Code, the incumbent's whole class of save-mechanics bugs : formatting with `formatOnSave` off, double saves, the cursor jumping to end-of-file, content leaking between panes : is simply **not implementable** here.
