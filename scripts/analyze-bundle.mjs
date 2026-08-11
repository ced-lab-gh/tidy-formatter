#!/usr/bin/env node
// analyze-bundle.mjs - bundle composition report (ADD-09). NOT a gate.
//
// Reads dist/meta.json (esbuild metafile, written by the production build) and
// prints, for every .js output, its top 20 size contributors with bytes and
// share. This is the observability half of the bundle budget: check-bundle-size
// says WHETHER the bundle grew, this says WHY. The heavy hitters it surfaces
// (prettier's typescript/babel/estree plugins, @babel/parser, parse5) are the
// ADD-11 lazy-chunk targets.
//
// Does NOT recompile: fails with an actionable message when dist/meta.json is
// missing. Pure Node, ESM, zero dependencies.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = dirname(scriptDir);
const metaPath = join(rootDir, "dist", "meta.json");

export const TOP_CONTRIBUTORS = 20;

/**
 * Pure extraction: top `limit` inputs of `outputName` by bytesInOutput.
 * Returns [{ file, bytes, share }] sorted descending; throws when the output
 * is absent from the metafile.
 */
export function topContributors(metafile, outputName, limit = TOP_CONTRIBUTORS) {
  const output = metafile?.outputs?.[outputName];
  if (output === undefined) {
    throw new Error(`output '${outputName}' not found in the metafile`);
  }
  const total = output.bytes;
  return Object.entries(output.inputs ?? {})
    .map(([file, input]) => ({ file, bytes: input.bytesInOutput }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, limit)
    .map((entry) => ({
      ...entry,
      share: total > 0 ? entry.bytes / total : 0,
    }));
}

function main() {
  if (!existsSync(metaPath)) {
    console.error(
      "analyze FAILED - dist/meta.json not found. Run `npm run compile` first " +
        "(the production build writes the esbuild metafile).",
    );
    process.exit(1);
  }
  const metafile = JSON.parse(readFileSync(metaPath, "utf8"));
  const jsOutputs = Object.keys(metafile.outputs ?? {}).filter((name) =>
    name.endsWith(".js"),
  );
  if (jsOutputs.length === 0) {
    console.error("analyze FAILED - the metafile lists no .js output.");
    process.exit(1);
  }
  for (const outputName of jsOutputs) {
    const total = metafile.outputs[outputName].bytes;
    console.log(
      `\n${outputName} (${total} bytes) - top ${TOP_CONTRIBUTORS} contributors:`,
    );
    for (const entry of topContributors(metafile, outputName)) {
      const kb = (entry.bytes / 1024).toFixed(1).padStart(8);
      const pct = (entry.share * 100).toFixed(1).padStart(5);
      console.log(`  ${kb} KB  ${pct} %  ${entry.file}`);
    }
  }
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main();
}
