// ADD-09 vscode stub tests. ALWAYS exercised in a CHILD process: requiring the
// stub patches Module._load globally, and that patch must never leak into the
// mocha process (a stray require('vscode') in a pure unit test MUST keep
// failing loudly). execFileSync passes args as an array (no shell), so the
// embedded probe code needs no Windows quoting care.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

const STUB = path.resolve(__dirname, '../../perf/vscodeStub.cjs');

function probe(expression: string): string {
  return execFileSync(
    process.execPath,
    [
      '--require',
      STUB,
      '-e',
      `const vscode = require('vscode'); process.stdout.write(String(${expression}));`
    ],
    { encoding: 'utf8', timeout: 30_000 }
  );
}

describe('vscodeStub (child process)', () => {
  it('answers deep property chains with callable stubs, never throwing', () => {
    assert.equal(probe("typeof vscode.window.createOutputChannel('x').appendLine"), 'function');
  });

  it('is never thenable: `then` is undefined so an await cannot hang', () => {
    assert.equal(probe('vscode.then'), 'undefined');
  });

  it("survives esbuild's __toESM interop (__esModule truthy, default present)", () => {
    assert.equal(
      probe("[Boolean(vscode.__esModule), typeof vscode.default].join(',')"),
      'true,function'
    );
  });

  it('supports construction (new vscode.Position(...)) without throwing', () => {
    assert.equal(probe('typeof new vscode.Position(1, 2)'), 'function');
  });

  it('counts interceptions for the harness sanity gate', () => {
    assert.equal(probe('globalThis.__tidyVscodeStubRequests >= 1'), 'true');
  });

  it('does not intercept any other module', () => {
    const out = execFileSync(
      process.execPath,
      ['--require', STUB, '-e', "process.stdout.write(typeof require('node:path').join);"],
      { encoding: 'utf8', timeout: 30_000 }
    );
    assert.equal(out, 'function');
  });
});
