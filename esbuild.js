// esbuild bundle config for the Tidy Formatter extension.
// Bundles src/extension.ts -> dist/extension.js as a CommonJS Node module,
// keeping the 'vscode' module external (provided by the VS Code runtime).
const esbuild = require('esbuild');

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
  logLevel: 'info'
};

async function main() {
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log('[esbuild] watching...');
  } else {
    await esbuild.build(options);
    console.log('[esbuild] build complete');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
