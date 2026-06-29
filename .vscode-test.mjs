// Configuration for @vscode/test-cli (headless lifecycle integration tests).
//
// Pipeline:
//   1. `npm run pretest:integration` runs `tsc -p ./`, compiling
//      test/integration/**/*.test.ts  ->  out/test/integration/**/*.test.js
//      (tsconfig.json: rootDir ".", outDir "out", includes test/**/*.ts).
//   2. `npm run test:integration` runs `vscode-test`, which reads this file,
//      downloads/caches a real VS Code build, loads the extension under test
//      from `extensionDevelopmentPath` (defaults to this file's directory),
//      opens the fixture `workspaceFolder`, and runs the compiled tests.
//
// SPEC QA-04: the five anti-hijack guarantees (no format on save when disabled;
// defer to another defaultFormatter; cursor not at EOF; single save; disable
// unregisters) can only be proven inside a real Electron host — that is what
// this config drives. It is CI-friendly under xvfb on Linux.
import { defineConfig } from '@vscode/test-cli';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // Compiled JS emitted by `tsc -p ./` (pretest:integration). The matching
  // sources live in test/integration/**/*.test.ts.
  files: 'out/test/integration/**/*.test.js',
  version: 'stable',
  // Open a clean, minimal fixture workspace so workspace-scoped settings
  // (editor.formatOnSave, editor.defaultFormatter, tidy.<lang>.enable) and
  // real on-disk save lifecycle are exercised deterministically.
  workspaceFolder: resolve(here, 'test/integration/workspace'),
  mocha: {
    ui: 'bdd',
    timeout: 30000,
    color: true
  },
  // Disable OTHER extensions for a hermetic host. The extension under test is
  // still loaded via extensionDevelopmentPath, so its providers are active.
  launchArgs: ['--disable-extensions']
});
