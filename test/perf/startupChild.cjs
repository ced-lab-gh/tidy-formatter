// Startup measurement child (ADD-09). Run as:
//   node --expose-gc --require test/perf/vscodeStub.cjs \
//        test/perf/startupChild.cjs <absolute path to dist/extension.js>
//
// Measures, in a process whose module cache is genuinely cold (which the
// parent process could never guarantee for itself):
//   - requireMs: wall-clock cost of require('dist/extension.js'), i.e. read +
//     parse + execute of all top-level bundle code, exactly what the extension
//     host pays at activation before activate() even runs;
//   - heapUsedDeltaBytes: heap RETAINED by the loaded module, measured between
//     two forced GCs (--expose-gc; without it the delta would mostly measure
//     allocation noise, so the parent treats a missing gc as a violation);
//   - require.cache: module count and any dist/chunk-*.js entries (must stay
//     empty at require time once ADD-11 splits the bundle);
//   - exportsActivate/exportsDeactivate: bundle sanity (did we really load the
//     extension entry point?);
//   - vscodeRequests: interceptions counted by vscodeStub.cjs (must be >= 1,
//     proving the vscode require path was actually exercised).
//
// Prints ONE JSON line on stdout and nothing else; the parent (startup.ts)
// parses it. Plain CommonJS: must run under plain Node with no TS tooling.
'use strict';
const { performance } = require('node:perf_hooks');

const target = process.argv[2];
if (!target) {
  process.stderr.write(
    'usage: node --expose-gc --require vscodeStub.cjs startupChild.cjs <bundle>\n'
  );
  process.exit(2);
}

const gcExposed = typeof global.gc === 'function';
if (gcExposed) {
  global.gc();
}
const heapBefore = process.memoryUsage().heapUsed;

const start = performance.now();
const loaded = require(target);
const requireMs = performance.now() - start;

if (gcExposed) {
  global.gc();
}
const heapAfter = process.memoryUsage().heapUsed;

const cacheKeys = Object.keys(require.cache);
const chunkModules = cacheKeys.filter((key) =>
  /[\\/]dist[\\/]chunk-[^\\/]+\.js$/.test(key)
);

process.stdout.write(
  `${JSON.stringify({
    requireMs,
    heapUsedDeltaBytes: heapAfter - heapBefore,
    moduleCount: cacheKeys.length,
    chunkModules,
    exportsActivate: typeof loaded.activate,
    exportsDeactivate: typeof loaded.deactivate,
    gcExposed,
    vscodeRequests: globalThis.__tidyVscodeStubRequests ?? 0
  })}\n`
);
