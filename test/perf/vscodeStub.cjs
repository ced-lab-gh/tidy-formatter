// vscode API stub, preloaded via `node --require` (ADD-09 startup harness).
//
// Requiring dist/extension.js executes the bundle's top-level code, which does
// `require('vscode')` (the module VS Code injects at runtime). Outside the
// Electron host that require would throw, so this preload patches Module._load
// to answer it with an infinitely-permissive Proxy: every property access
// returns another stub, every call returns another stub. Top-level bundle code
// only STORES vscode namespaces (activate() is never called by the harness),
// so no stubbed value is ever meaningfully consumed.
//
// Invariants (locked by test/unit/tooling/vscodeStub.test.ts, always exercised
// in a CHILD process so the Module._load patch can never leak into mocha):
//   - deep chains never throw and stay callable;
//   - `then` is undefined: a stub must never look thenable, or an `await` on
//     a stubbed namespace would hang the child;
//   - `__esModule` is truthy so esbuild's __toESM interop takes the fast path;
//   - other modules resolve normally (only the exact request 'vscode' is hit);
//   - every interception increments a counter the child reports, proving the
//     measured bundle really went through the vscode require path.
//
// Plain CommonJS on purpose: `--require` preloads run under plain Node, before
// any TypeScript tooling exists in the process.
'use strict';
const Module = require('node:module');

globalThis.__tidyVscodeStubRequests = 0;

function makeStub(path) {
  const fn = function stub() {
    return makeStub(`${path}()`);
  };
  return new Proxy(fn, {
    get(_target, prop) {
      if (prop === Symbol.toPrimitive) {
        return () => `[vscode-stub ${path}]`;
      }
      if (prop === Symbol.toStringTag) {
        return 'VscodeStub';
      }
      if (prop === 'then') {
        // Never thenable (see header).
        return undefined;
      }
      if (typeof prop === 'symbol') {
        return undefined;
      }
      return makeStub(`${path}.${String(prop)}`);
    },
    apply() {
      return makeStub(`${path}()`);
    },
    construct() {
      return makeStub(`new ${path}`);
    }
  });
}

const VSCODE_STUB = makeStub('vscode');

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') {
    globalThis.__tidyVscodeStubRequests += 1;
    return VSCODE_STUB;
  }
  return originalLoad.call(this, request, parent, isMain);
};
