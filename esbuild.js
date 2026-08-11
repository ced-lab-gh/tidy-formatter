// esbuild bundle config for the Tidy Formatter extension.
// Bundles src/extension.ts -> dist/extension.js as a CommonJS Node module,
// keeping the 'vscode' module external (provided by the VS Code runtime).
const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  // Prefer each dependency's ESM ("module") entry over its CommonJS ("main")
  // entry. Some deps (e.g. jsonc-parser) ship a UMD CommonJS build whose inner
  // require("./impl/...") calls esbuild cannot statically inline, leaving broken
  // runtime requires in the bundle. Their ESM build uses static imports that
  // esbuild fully resolves, so selecting it produces a self-contained bundle.
  mainFields: ['module', 'main'],
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
  // ADD-09: in production, emit the esbuild metafile so the bundle-size gate
  // (scripts/check-bundle-size.mjs) and `npm run analyze`
  // (scripts/analyze-bundle.mjs) can attribute every byte of dist/extension.js
  // to its source module. Dev/watch builds skip it (nothing consumes it there).
  metafile: production,
  logLevel: 'info'
};

async function main() {
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log('[esbuild] watching...');
  } else {
    const result = await esbuild.build(options);
    if (production) {
      // dist/meta.json is dev tooling: gitignored via dist/, excluded from the
      // VSIX via .vscodeignore (locked by test/unit/manifest/perfTooling.test.ts).
      const metaPath = path.join(__dirname, 'dist', 'meta.json');
      fs.writeFileSync(metaPath, JSON.stringify(result.metafile));
      console.log(`[esbuild] metafile written to ${metaPath}`);
    }
    console.log('[esbuild] build complete');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
