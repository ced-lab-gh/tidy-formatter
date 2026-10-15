# Format on save : always your call

Formatting on save **even when you had turned that off** is the second most common complaint about *JS-CSS-HTML Formatter*, not updated since 2017: of the 85 one-star reviews carrying text in our 2026-06-28 snapshot, 26 are about a formatter acting without consent, behind the 53 about broken or corrupted output. Tidy makes that impossible by design: **Tidy never hooks the save event at all, and never enables `editor.formatOnSave` behind your back.** The **Tidy: Use Tidy as My Formatter** command can enable it for you, per language, but only as an optional step whose first and recommended answer is *No, keep formatting manual*, and only after you confirm a modal recap of the exact `"[lang]": { "editor.formatOnSave": true }` keys it will write; the success message then offers a one-click **Revert**.

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

Because Tidy delegates the save lifecycle entirely to VS Code, the incumbent's save-mechanics bugs have no code path to happen in: formatting with `formatOnSave` off, double saves and the cursor jumping to end-of-file all come from an extension running its own handler on save, and Tidy registers none, anywhere. The cross-file variant (content leaking between panes) is ruled out separately, by construction: a format call returns edits for the single document you invoked it on, and can address no other.
