# Try it now : a scratch playground, zero risk

Click **Open the playground** (or run **Tidy: Open Playground** from the Command Palette) and Tidy opens **two untitled scratch documents**: a messy CSS file and a messy TSX component, the same real samples shown on the Marketplace listing. They live only in memory: **nothing is created on disk**, and closing them leaves no trace.

Then see Tidy work, without committing to anything:

1. With the playground CSS tab active, run **Tidy: Preview Format (Diff)** (`tidy.previewFormat`).
2. Tidy shows a **read-only side-by-side diff** of exactly what it would change. Opening the diff writes nothing.
3. Click **Apply** if you like what you see (a single undo reverts it), or simply close the diff.

Try the TSX tab too: the JSX stays valid, `?.` and `??` survive, and the result is verified for **semantic equivalence** before anything can be applied. If a format ever failed that check, Tidy would show you the refusal instead of writing a broken file.

> The playground goes through the exact same pipeline as your real files: the
> per-language enable settings, the size guard, the ignore rules, the engine,
> and the equivalence guard. What you see here is what Format Document does.
