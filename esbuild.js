// esbuild bundle config for the Tidy Formatter extension (ADD-11 chunk layout).
//
// Output layout (all CommonJS, node18):
//   dist/extension.js        host bundle: extension + providers + dispatcher
//                            + js-beautify + jsonc-parser + editorconfig
//                            (+ one_ini_bg.wasm, emitted by the wasm loader)
//   dist/chunk-prettier.js   prettier/standalone + babel/estree/typescript/postcss plugins
//   dist/chunk-guard-js.js   @babel/parser + @babel/types
//   dist/chunk-guard-css.js  postcss + postcss-scss + postcss-less
//   dist/chunk-guard-html.js parse5
//
// The host bundle NEVER contains a chunk-only package: the tidy-chunk-rewrite
// plugin (a) rewrites the loader's require('./xxxChunk') specifiers into
// external './chunk-xxx.js' runtime requires resolved next to extension.js,
// and (b) FAILS THE BUILD if any host module imports a chunk-only package
// directly, so the split is enforced structurally, not by convention.
// scripts/check-chunks.mjs re-proves both facts on the emitted artifacts.
const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

/** Chunk registry: source entry module -> emitted dist file basename. */
const CHUNKS = [
  {
    name: 'chunk-prettier',
    sourceBase: 'prettierChunk',
    entry: 'src/chunks/prettierChunk.ts'
  },
  {
    name: 'chunk-guard-js',
    sourceBase: 'guardJsChunk',
    entry: 'src/chunks/guardJsChunk.ts'
  },
  {
    name: 'chunk-guard-css',
    sourceBase: 'guardCssChunk',
    entry: 'src/chunks/guardCssChunk.ts'
  },
  {
    name: 'chunk-guard-html',
    sourceBase: 'guardHtmlChunk',
    entry: 'src/chunks/guardHtmlChunk.ts'
  }
];

// Packages that must ONLY be reachable through a chunk. 'jsonc-parser',
// 'js-beautify', 'editorconfig' and the prettierrc data parsers (js-yaml,
// json5, smol-toml) deliberately stay in the host bundle. Type-only TS imports
// are erased before resolution and never hit this filter.
const CHUNK_ONLY_FILTER =
  /^(prettier|prettier\/.+|@babel\/parser|@babel\/types|postcss|postcss-scss|postcss-less|parse5)$/;

// Matches the loader's relative './<sourceBase>' specifiers, and nothing else.
const CHUNK_SOURCE_FILTER =
  /^\.\/(prettierChunk|guardJsChunk|guardCssChunk|guardHtmlChunk)$/;

const chunkRewritePlugin = {
  name: 'tidy-chunk-rewrite',
  setup(build) {
    build.onResolve({ filter: CHUNK_SOURCE_FILTER }, (args) => {
      const base = args.path.slice('./'.length);
      const chunk = CHUNKS.find((c) => c.sourceBase === base);
      if (!chunk) {
        return {
          errors: [
            {
              text:
                `'${args.path}' matched the chunk specifier filter but has no ` +
                `entry in the CHUNKS registry (imported from ${args.importer})`
            }
          ]
        };
      }
      // Kept external: the host bundle emits a literal runtime
      // require('./chunk-xxx.js'), resolved relative to dist/extension.js.
      return { path: `./${chunk.name}.js`, external: true };
    });
    build.onResolve({ filter: CHUNK_ONLY_FILTER }, (args) => ({
      errors: [
        {
          text:
            `'${args.path}' is chunk-only and must not be imported by the host bundle ` +
            `(imported from ${args.importer}); route it through src/chunks/ instead`
        }
      ]
    }));
  }
};

/** Options shared by the host and every chunk build. */
const shared = {
  bundle: true,
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
  // (scripts/check-bundle-size.mjs), the chunk-layout gate
  // (scripts/check-chunks.mjs) and `npm run analyze`
  // (scripts/analyze-bundle.mjs) can attribute every byte of each artifact to
  // its source module. Dev/watch builds skip it (nothing consumes it there).
  metafile: production,
  logLevel: 'info'
};

/** @type {import('esbuild').BuildOptions[]} */
const builds = [
  {
    ...shared,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    plugins: [chunkRewritePlugin]
  },
  ...CHUNKS.map((chunk) => ({
    ...shared,
    entryPoints: [chunk.entry],
    outfile: `dist/${chunk.name}.js`
  }))
];

// dist/extension.js -> dist/meta.json (the ADD-09 contract every gate reads);
// dist/chunk-x.js   -> dist/meta.chunk-x.json (per-chunk attribution).
// All of them are dev tooling: gitignored via dist/ and VSIX-excluded via
// .vscodeignore (locked by test/unit/manifest/perfTooling.test.ts).
function metafileNameFor(outfile) {
  const base = path.basename(outfile, '.js');
  return base === 'extension' ? 'meta.json' : `meta.${base}.json`;
}

// Runtime assets esbuild cannot see. @one-ini/wasm (pulled in by editorconfig)
// loads its payload with a plain readFileSync(`${__dirname}/one_ini_bg.wasm`),
// which is invisible to the bundler: without this copy the file is absent from
// a freshly built dist/, the .editorconfig layer silently stops working, and
// scripts/check-bundle-size.mjs reds on its "budgeted file present in dist/"
// rule (which exists for exactly this failure).
//
// A BUILD must therefore still ship the asset, and we fail loudly here if it
// cannot be copied. What must NEVER fail loudly is the RUNTIME: an antivirus
// quarantine or a partial install can remove the file from an already-installed
// extension, so src/config/editorconfig.ts loads the package lazily behind a
// guard and degrades to "no .editorconfig layer" instead of breaking every
// format (locked by test/unit/config/editorconfigFailSafe.test.ts).
const RUNTIME_ASSETS = ['@one-ini/wasm/one_ini_bg.wasm'];

function copyRuntimeAssets(outDir) {
  for (const request of RUNTIME_ASSETS) {
    let source;
    let target;
    try {
      source = require.resolve(request);
      target = path.join(outDir, path.basename(source));
      fs.copyFileSync(source, target);
    } catch (err) {
      throw new Error(
        `[esbuild] could not ship the runtime asset '${request}': ${err.message}. ` +
          `The build must not produce a dist/ missing it (the runtime degrades ` +
          `gracefully, but the shipped extension would lose .editorconfig support).`
      );
    }
    console.log(`[esbuild] runtime asset copied to ${target}`);
  }
}

async function main() {
  const outDir = path.join(__dirname, 'dist');
  fs.mkdirSync(outDir, { recursive: true });

  if (watch) {
    const contexts = await Promise.all(
      builds.map((options) => esbuild.context(options))
    );
    await Promise.all(contexts.map((ctx) => ctx.watch()));
    copyRuntimeAssets(outDir);
    console.log(`[esbuild] watching host + ${CHUNKS.length} chunks...`);
    return;
  }

  const results = await Promise.all(builds.map((options) => esbuild.build(options)));
  copyRuntimeAssets(outDir);
  if (production) {
    results.forEach((result, index) => {
      if (result.metafile) {
        const metaPath = path.join(
          __dirname,
          'dist',
          metafileNameFor(builds[index].outfile)
        );
        fs.writeFileSync(metaPath, JSON.stringify(result.metafile));
        console.log(`[esbuild] metafile written to ${metaPath}`);
      }
    });
  }
  console.log(`[esbuild] build complete (host + ${CHUNKS.length} chunks)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
