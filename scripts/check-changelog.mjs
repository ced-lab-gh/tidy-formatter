#!/usr/bin/env node
// check-changelog.mjs — anti-empty-bump guard.
//
// Enforces the release rule of thumb: never ship a version bump without a
// documented change. Reads the "version" from package.json and asserts that
// CHANGELOG.md carries a matching "## [<version>]" heading. Exits non-zero with
// an actionable message when that entry is missing, so a version can never reach
// the Marketplace/Open VSX without a line saying what changed.
//
// Pure Node, ESM, zero dependencies. Safe to run from any working directory:
// every path is resolved relative to THIS file, not process.cwd().

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
// scripts/ lives one level under the package root.
const rootDir = dirname(scriptDir);
const pkgPath = join(rootDir, "package.json");
const changelogPath = join(rootDir, "CHANGELOG.md");

function fail(message) {
  console.error(`check:changelog FAILED - ${message}`);
  process.exit(1);
}

function readFileOrFail(path, label) {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    fail(`could not read ${label} at ${path}: ${err.message}`);
    return ""; // unreachable — fail() has already exited the process.
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 1. Resolve the version declared in package.json.
let version;
try {
  version = JSON.parse(readFileOrFail(pkgPath, "package.json")).version;
} catch (err) {
  fail(`package.json is not valid JSON: ${err.message}`);
}

if (typeof version !== "string" || version.trim() === "") {
  fail('package.json has no usable "version" field.');
}

// 2. Confirm CHANGELOG.md documents that exact version.
//    Matches a Keep-a-Changelog heading such as "## [1.2.3] - 2026-01-01".
//    The escaped closing bracket keeps "0.1.1" from matching "[0.1.10]".
const changelog = readFileOrFail(changelogPath, "CHANGELOG.md");
const headingPattern = new RegExp(`^##\\s+\\[${escapeRegExp(version)}\\]`, "m");

if (!headingPattern.test(changelog)) {
  fail(
    `no changelog entry for v${version}.\n` +
      `  Expected a heading like:  ## [${version}] - YYYY-MM-DD\n` +
      `  in ${changelogPath}\n` +
      `  Add the entry (Keep a Changelog format) before releasing, ` +
      `or revert the version bump in package.json.`,
  );
}

console.log(`check:changelog OK - CHANGELOG.md documents v${version}.`);
