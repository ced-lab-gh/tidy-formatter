// .prettierrc project-config reader: the Prettier-path layer inserted between
// .editorconfig (layer 3) and .soukformatrc (layer 4) so a team's existing
// Prettier config governs Tidy's TS/TSX/JSX output without the user copying
// values into VS Code settings (the "two styles fighting" complaint, ADD-13).
//
// PURE: this module MUST NOT import 'vscode'. It reads project files from disk
// via node:fs only, parses DATA formats only, and emits at most one ConfigLayer
// that the pure resolver merges deeply by key like any other layer.
//
// DATA ONLY (non-negotiable): .prettierrc.js/.cjs/.mjs/.ts/.cts/.mts and
// prettier.config.* are NEVER executed, required, or imported. When the nearest
// Prettier config in the walk is code-based, the layer is SKIPPED entirely
// (with a trace warning) rather than falling through to a farther data file
// Prettier itself would not use: honouring the wrong config beats none, never.
//
// AST-SAFE KEYS ONLY: exactly twelve Prettier keys are honoured (printWidth,
// tabWidth, useTabs, semi, singleQuote, jsxSingleQuote, trailingComma,
// bracketSpacing, bracketSameLine, arrowParens, singleAttributePerLine,
// objectWrap). Every one is stylistic and AST-invariant under the equivalence
// guard (same proof as the tidy.prettier.* catalogue entries); the last two only
// decide where line breaks fall. Any other key (parser, plugins, overrides,
// endOfLine...) is ignored with a warning, so a .prettierrc can never change the
// parser, load code, or alter anything the guard does not already accept.
//
// BOUNDED WALK: the upward search stops at the workspace folder root (stopDir,
// inclusive), so a config planted above the trusted workspace can never govern.
// This bound MIRRORS findSoukformatrc's, which has been bounded the same three
// fail-closed ways since v0.4.0 (start inside stopDir, stop after searching
// stopDir, and containment re-checked at every step). Until v0.4.1 this comment
// still described that walk as an open defect, contradicting the sibling comment
// on MAX_WALK_DEPTH below, which already says the bound is shared. The
// bound is real PATH CONTAINMENT (isWithinDir), never string equality: a
// case-mismatched drive letter, a trailing separator, a mixed separator or a
// '..' segment must not be able to let the walk escape to the filesystem root.
//
// COST, and why there is NO CACHE: the walk is synchronous and runs on every
// format call. Measured on Windows (Node 20, NTFS, warm OS cache) with the
// original one-stat-per-search-place probing: 3.4 ms mean at depth 9 and 5.8 ms
// at depth 14 (7.4 ms with a package.json in every directory). One directory
// LISTING per level replaces the 19 stats (~40 us instead of ~320 us per
// level), which removes the cost without introducing any cached state: every
// call still reads the live filesystem, so an edited .prettierrc is honoured on
// the very next format and no invalidation rule can be wrong. A watcher is
// forbidden by the anti-hijack contract and is not needed here.
//
// FAIL-SOFT: a missing config yields no layer; a malformed / oversized /
// unsupported config yields no layer plus a warning (never a throw), so
// formatting falls back to the lower layers (CFG-06 principle).
import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  parse as parseJsonc,
  printParseErrorCode,
  type ParseError
} from 'jsonc-parser';
// js-yaml v4's `load` IS the old `safeLoad`: it runs the DEFAULT_SCHEMA, which
// carries no function/regexp/undefined tags, so a YAML config cannot construct
// or execute anything. An unknown tag raises a parse error we fail soft on.
import { load as loadYaml } from 'js-yaml';
import JSON5 from 'json5';
import { parse as parseToml } from 'smol-toml';
import type { ConfigLayer } from './resolver';
import type { LangId } from '../types';
// The shared, 'vscode'-free detail sanitizer: a parser error can embed a
// multi-line code frame carrying the user's own content, which must never reach
// a warning surfaced in the output channel.
import { sanitizeDetail } from '../diagnostics/lastFormat';

/** Origin label surfaced verbatim in "Show Effective Configuration". */
export const SOURCE_PRETTIERRC = '.prettierrc';

/**
 * Languages for which the .prettierrc layer is built: the three Prettier-native
 * languageIds plus plain 'javascript', whose JSX files the dispatcher re-routes
 * to Prettier. The emitted prettier.* keys are consumed exclusively by the
 * Prettier engine, so a plain JS file formatted by js-beautify is unaffected by
 * them; the two keys that are NOT prettier-only (tabWidth/useTabs, which land
 * on the shared typed fields) are gated on the engine that really prints the
 * document instead (see PrintEngineId).
 */
export const PRETTIERRC_LANGS: readonly LangId[] = [
  'typescript',
  'typescriptreact',
  'javascriptreact',
  'javascript'
];

/**
 * Languages printed by Prettier on the strength of their languageId ALONE: the
 * static half of the dispatcher's routing matrix. Plain 'javascript' is
 * deliberately absent because its engine is CONTENT dependent (js-beautify by
 * default, Prettier when the file really contains JSX), so it cannot be decided
 * from the languageId.
 */
const PRETTIER_NATIVE_LANGS: ReadonlySet<LangId> = new Set<LangId>([
  'typescript',
  'typescriptreact',
  'javascriptreact'
]);

/**
 * Which engine actually PRINTS the document this config is being read for.
 *
 * The .prettierrc layer is a PRETTIER config, so its indentation keys
 * (tabWidth / useTabs) may only govern a file Prettier really prints: mapping
 * them onto the shared typed tabSize/insertSpaces fields for a js-beautify file
 * would leak a Prettier config into the js-beautify path. The engine is passed
 * in as DATA rather than inferred here, so this module keeps a single source of
 * truth for routing (the dispatcher) and stays free of any parser dependency.
 */
export type PrintEngineId = 'prettier' | 'js-beautify';

/**
 * The engine implied by the languageId alone, used as the default when the
 * caller has no document text to route on. For 'javascript' this is the
 * CONSERVATIVE answer (js-beautify): assuming Prettier would apply a Prettier
 * indentation setting to a file js-beautify prints, which is exactly the leak
 * the layer forbids.
 */
export function staticPrintEngine(languageId: LangId): PrintEngineId {
  return PRETTIER_NATIVE_LANGS.has(languageId) ? 'prettier' : 'js-beautify';
}

/** Size cap for any config file read here (1 MiB). */
export const MAX_PRETTIERRC_BYTES = 1_048_576;

/** Upper bound on the upward walk, mirroring findSoukformatrc's bound. */
const MAX_WALK_DEPTH = 64;

/** Max characters of a rejected value echoed into a warning message. */
const MAX_VALUE_ECHO = 80;

/** How a discovered config must be handled. */
export type PrettierConfigKind = 'data' | 'code' | 'package-json';

/**
 * The ordered search places Prettier itself probes in each directory (first
 * hit wins, then the walk stops). Order matters: a package.json "prettier"
 * key wins over a sibling .prettierrc, exactly like Prettier's own resolution.
 */
const SEARCH_PLACES: ReadonlyArray<{
  readonly name: string;
  readonly kind: PrettierConfigKind;
}> = [
  { name: 'package.json', kind: 'package-json' },
  { name: '.prettierrc', kind: 'data' },
  { name: '.prettierrc.json', kind: 'data' },
  { name: '.prettierrc.yaml', kind: 'data' },
  { name: '.prettierrc.yml', kind: 'data' },
  { name: '.prettierrc.json5', kind: 'data' },
  { name: '.prettierrc.js', kind: 'code' },
  { name: 'prettier.config.js', kind: 'code' },
  { name: '.prettierrc.mjs', kind: 'code' },
  { name: 'prettier.config.mjs', kind: 'code' },
  { name: '.prettierrc.cjs', kind: 'code' },
  { name: 'prettier.config.cjs', kind: 'code' },
  { name: '.prettierrc.ts', kind: 'code' },
  { name: 'prettier.config.ts', kind: 'code' },
  { name: '.prettierrc.mts', kind: 'code' },
  { name: 'prettier.config.mts', kind: 'code' },
  { name: '.prettierrc.cts', kind: 'code' },
  { name: 'prettier.config.cts', kind: 'code' },
  { name: '.prettierrc.toml', kind: 'data' }
];

/**
 * A non-fatal problem encountered while resolving/parsing/mapping the config.
 * Surfaced by "Show Effective Configuration"; never aborts formatting.
 */
export interface PrettierrcWarning {
  readonly message: string;
}

/** The nearest Prettier config found by the bounded walk. */
export interface PrettierConfigProbe {
  readonly path: string;
  readonly kind: PrettierConfigKind;
  /** The package.json "prettier" value; present only when kind='package-json'. */
  readonly packagePrettier?: unknown;
}

/** Result of building the .prettierrc layer for one document. */
export interface PrettierrcReadResult {
  /** Absolute path of the governing config, when one was found. */
  readonly path?: string;
  /** The single ConfigLayer to insert, when usable values were mapped. */
  readonly layer?: ConfigLayer;
  /** Non-fatal warnings (unknown keys, malformed file, code config skipped...). */
  readonly warnings: PrettierrcWarning[];
}

/**
 * AST-invariant boolean keys forwarded verbatim into the prettier.* namespace.
 * MUST stay in sync with the engine's boolean allow-list in engine/prettier.ts
 * (the engine is the consuming side of this contract).
 */
const RC_STYLISTIC_BOOLEAN_KEYS: ReadonlySet<string> = new Set<string>([
  'semi',
  'singleQuote',
  'jsxSingleQuote',
  'bracketSpacing',
  'bracketSameLine',
  'singleAttributePerLine'
]);

/**
 * AST-invariant enum keys; a value outside the enum is dropped with a warning.
 * MUST stay in sync with the engine's string-enum allow-list.
 */
const RC_STYLISTIC_STRING_ENUMS: Readonly<Record<string, readonly string[]>> = {
  trailingComma: ['none', 'es5', 'all'],
  arrowParens: ['always', 'avoid'],
  objectWrap: ['preserve', 'collapse']
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * Short, single-line, bounded description of a rejected value for a warning.
 * JSON.stringify is wrapped (a YAML alias cycle would throw) and the output is
 * truncated so an adversarial config cannot flood the warning channel.
 */
function describeValue(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = '[unserializable]';
  }
  return text.length > MAX_VALUE_ECHO
    ? `${text.slice(0, MAX_VALUE_ECHO)}...`
    : text;
}

/**
 * Map a parsed Prettier config object onto resolver-ready key/values for one
 * language, collecting warnings for every ignored key. PURE.
 *
 * Emission vocabulary (arbitrated by the pure resolver like any other layer):
 *   - tabWidth -> typed 'tabSize'       (files Prettier actually prints)
 *   - useTabs  -> typed 'insertSpaces'  (inverted; same condition)
 *   - printWidth and the nine stylistic keys -> flat 'prettier.<key>' entries,
 *     later nested into engineOptions.prettier by the resolver.
 *
 * The indentation keys are gated on `printEngine`, the engine that REALLY
 * prints the document, not on the languageId: a .js file re-routed to Prettier
 * because it contains JSX gets the project's tabWidth/useTabs like any other
 * Prettier-printed file, and the warning emitted when they are dropped names
 * js-beautify only when js-beautify is genuinely the engine that runs.
 *
 * Only OWN enumerable keys are read (Object.keys), so a __proto__ payload can
 * never smuggle values through the prototype chain.
 */
export function mapPrettierConfig(
  root: Record<string, unknown>,
  languageId: LangId,
  where: string,
  warnings: PrettierrcWarning[],
  printEngine: PrintEngineId = staticPrintEngine(languageId)
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  const printedByPrettier = printEngine === 'prettier';

  for (const key of Object.keys(root)) {
    const raw = root[key];

    if (key === 'printWidth') {
      if (isPositiveInteger(raw)) {
        values['prettier.printWidth'] = raw;
      } else {
        warnings.push({
          message: `${where}: invalid value for "printWidth" (${describeValue(raw)}); ignored.`
        });
      }
      continue;
    }

    if (key === 'tabWidth') {
      if (!printedByPrettier) {
        warnings.push({
          message: `${where}: "tabWidth" is not applied: this file is printed by js-beautify, not by Prettier; ignored.`
        });
      } else if (isPositiveInteger(raw)) {
        values.tabSize = raw;
      } else {
        warnings.push({
          message: `${where}: invalid value for "tabWidth" (${describeValue(raw)}); ignored.`
        });
      }
      continue;
    }

    if (key === 'useTabs') {
      if (!printedByPrettier) {
        warnings.push({
          message: `${where}: "useTabs" is not applied: this file is printed by js-beautify, not by Prettier; ignored.`
        });
      } else if (typeof raw === 'boolean') {
        // Prettier speaks useTabs; the canonical vocabulary is insertSpaces.
        values.insertSpaces = !raw;
      } else {
        warnings.push({
          message: `${where}: invalid value for "useTabs" (${describeValue(raw)}); ignored.`
        });
      }
      continue;
    }

    if (RC_STYLISTIC_BOOLEAN_KEYS.has(key)) {
      if (typeof raw === 'boolean') {
        values[`prettier.${key}`] = raw;
      } else {
        warnings.push({
          message: `${where}: invalid value for "${key}" (${describeValue(raw)}); ignored.`
        });
      }
      continue;
    }

    const allowedEnum = Object.prototype.hasOwnProperty.call(
      RC_STYLISTIC_STRING_ENUMS,
      key
    )
      ? RC_STYLISTIC_STRING_ENUMS[key]
      : undefined;
    if (allowedEnum !== undefined) {
      if (typeof raw === 'string' && allowedEnum.includes(raw)) {
        values[`prettier.${key}`] = raw;
      } else {
        warnings.push({
          message: `${where}: invalid value for "${key}" (${describeValue(raw)}); ignored.`
        });
      }
      continue;
    }

    if (key === 'overrides') {
      warnings.push({
        message: `${where}: per-glob "overrides" are not applied; only top-level AST-safe keys are honoured.`
      });
      continue;
    }

    warnings.push({
      message: `${where}: key "${key}" is unknown or not AST-safe for Tidy; ignored.`
    });
  }

  return values;
}

/**
 * Parse the text of a DATA Prettier config file according to its filename.
 * PURE (no I/O): directly unit-testable. Never throws: any parse failure (or a
 * non-object root) yields an { error } the caller turns into a warning.
 *
 * Formats, mirroring Prettier's own loaders:
 *   - '.prettierrc'                    YAML (a strict superset of JSON, so
 *                                      JSON content parses identically)
 *   - '.prettierrc.json'               JSONC (comments/trailing commas are
 *                                      tolerated: a superset of what Prettier
 *                                      accepts; a malformed file still fails soft)
 *   - '.prettierrc.json5'              JSON5
 *   - '.prettierrc.yaml' / '.yml'      YAML
 *   - '.prettierrc.toml'               TOML
 *
 * Error messages are truncated to their FIRST LINE so a parser code frame can
 * never leak source content into the warning channel.
 */
export function parsePrettierrcData(
  text: string,
  filename: string
): { root?: Record<string, unknown>; error?: string } {
  let parsed: unknown;
  try {
    if (
      filename === '.prettierrc' ||
      filename.endsWith('.yaml') ||
      filename.endsWith('.yml')
    ) {
      parsed = loadYaml(text);
    } else if (filename.endsWith('.json5')) {
      parsed = JSON5.parse(text);
    } else if (filename.endsWith('.json')) {
      const errors: ParseError[] = [];
      parsed = parseJsonc(text, errors, {
        allowTrailingComma: true,
        disallowComments: false
      });
      if (errors.length > 0) {
        const first = errors[0];
        return {
          error: `malformed JSONC (${printParseErrorCode(first.error)} at offset ${first.offset})`
        };
      }
    } else if (filename.endsWith('.toml')) {
      parsed = parseToml(text);
    } else {
      return { error: `unsupported config filename "${filename}"` };
    }
  } catch (error: unknown) {
    // A parser error can embed a multi-line code frame carrying the user's own
    // config content; the shared sanitizer keeps only the bounded first line.
    const firstLine =
      error instanceof Error ? sanitizeDetail(error.message) : 'parse error';
    return { error: `malformed config (${firstLine})` };
  }

  if (!isPlainObject(parsed)) {
    return { error: 'root must be a plain object of Prettier options' };
  }
  return { root: parsed };
}

/**
 * Normalise a directory path so two forms of the same directory compare equal:
 * resolve() folds separators, '.'/'..' segments and trailing separators, and on
 * win32 the case is folded too (C:\ vs c:\), matching the filesystem. Shared by
 * sameDir and by the containment test below. This is the same precaution the
 * .soukformatrc bounded-walk correction needs; when that correction lands,
 * extract this helper (with isWithinDir) into a shared module and use it on
 * both sides instead of duplicating it.
 */
export function comparableDir(dir: string): string {
  const resolved = resolve(dir);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Whether two paths denote the same directory, after normalisation. */
function sameDir(a: string, b: string): boolean {
  return comparableDir(a) === comparableDir(b);
}

/**
 * Whether `child` IS `parent` or lies inside it: real path containment, never
 * string equality.
 *
 * String equality against the workspace root is a walk bound that fails OPEN:
 * any normalisation mismatch (drive-letter case, a trailing separator, mixed
 * '/' and '\\', a '..' segment, a UNC share) makes the equality test miss and
 * the walk then continues all the way to the filesystem root, reading configs
 * from OUTSIDE the trusted workspace. Containment fails CLOSED instead: on the
 * same mismatch the walk stops.
 *
 * resolve() (inside comparableDir) normalises separators, '.'/'..' segments and
 * trailing separators, and folds case on win32; path.relative then answers
 * containment. An ABSOLUTE result means the two paths share no root at all
 * (different drive, or a UNC share vs a local path) and a '..'-prefixed result
 * means `child` is above `parent`: both are "outside". A directory merely
 * NAMED '..something' is not, hence the separator-aware prefix test.
 */
export function isWithinDir(child: string, parent: string): boolean {
  const from = comparableDir(parent);
  const to = comparableDir(child);
  if (from === to) {
    return true;
  }
  const rel = relative(from, to);
  if (rel === '') {
    return true;
  }
  if (isAbsolute(rel)) {
    return false;
  }
  // Separator-aware so a directory called '..cache' is inside, while '../x' and
  // a bare '..' are not. Both separators are tested because a caller may hand
  // us a posix-style path on win32.
  return rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\');
}

/** Whether a path exists and is a regular file; stat errors are fail-soft. */
function isFile(candidate: string): boolean {
  try {
    return statSync(candidate, { throwIfNoEntry: false })?.isFile() === true;
  } catch {
    return false;
  }
}

/**
 * Filesystem name comparison form. On win32 the filesystem itself matches names
 * case-insensitively, so the directory listing must too: probing by stat used
 * to inherit that for free, and losing it would silently stop honouring a
 * '.PRETTIERRC' that Prettier itself would read.
 */
function comparableName(name: string): string {
  return process.platform === 'win32' ? name.toLowerCase() : name;
}

/**
 * One directory's entries, split by what a single listing can prove.
 *
 * ONE readdir per level replaces one stat per search place (19 of them), which
 * is where the walk's cost lived (see the COST note in the module header). It
 * is a pure read of live state: no cache, so a config created or edited between
 * two format calls is seen by the next one.
 *
 * `files` are proven regular files. `links` are symlinks, whose dirent reports
 * the LINK's type and not the target's: a symlinked config (a shared config in
 * a monorepo) therefore costs ONE extra stat rather than being ignored.
 * Anything else (directories, sockets, fifos) is absent from both, exactly as
 * `statSync(...).isFile()` rejected them before.
 *
 * Fail-soft: an unreadable or vanished directory yields an empty listing, so
 * the walk continues upward just as unreadable candidates did before.
 */
interface DirListing {
  readonly files: ReadonlySet<string>;
  readonly links: ReadonlySet<string>;
}

const EMPTY_LISTING: DirListing = { files: new Set(), links: new Set() };

function listDir(dir: string): DirListing {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return EMPTY_LISTING;
  }
  const files = new Set<string>();
  const links = new Set<string>();
  for (const entry of entries) {
    if (entry.isFile()) {
      files.add(comparableName(entry.name));
    } else if (entry.isSymbolicLink()) {
      links.add(comparableName(entry.name));
    }
  }
  return { files, links };
}

/**
 * Whether one search place is present in `dir` as a usable regular file.
 * A listed symlink is resolved with a single stat (target may be a directory or
 * dangling, both of which must NOT count as a hit).
 */
function placeIsFile(listing: DirListing, dir: string, name: string): boolean {
  const key = comparableName(name);
  if (listing.files.has(key)) {
    return true;
  }
  return listing.links.has(key) && isFile(join(dir, name));
}

/** Whether a search place appears in the listing at all (file or symlink). */
function placeIsPresent(listing: DirListing, name: string): boolean {
  const key = comparableName(name);
  return listing.files.has(key) || listing.links.has(key);
}

/**
 * Best-effort probe of a package.json for an OWN "prettier" key. Returns the
 * raw value when present; undefined when the file is absent, oversized,
 * malformed, or carries no "prettier" key. In the malformed/oversized cases a
 * warning is recorded and the walk continues on the directory's other search
 * places, exactly like Prettier skipping an unusable candidate.
 */
function probePackageJson(
  candidate: string,
  warnings: PrettierrcWarning[]
): { value: unknown } | undefined {
  // One stat answers existence, regular-file-ness (following a symlink) AND the
  // size cap, instead of the three separate syscalls this used to cost.
  let stats: ReturnType<typeof statSync> | undefined;
  try {
    stats = statSync(candidate, { throwIfNoEntry: false });
  } catch {
    return undefined;
  }
  if (stats === undefined || !stats.isFile()) {
    return undefined;
  }
  try {
    const size = stats.size;
    if (size > MAX_PRETTIERRC_BYTES) {
      warnings.push({
        message: `${SOURCE_PRETTIERRC}: ${candidate} is too large (${size} bytes) to check its "prettier" key; skipped.`
      });
      return undefined;
    }
    const parsed: unknown = JSON.parse(readFileSync(candidate, 'utf8'));
    if (
      isPlainObject(parsed) &&
      Object.prototype.hasOwnProperty.call(parsed, 'prettier')
    ) {
      return { value: parsed.prettier };
    }
    return undefined;
  } catch {
    warnings.push({
      message: `${SOURCE_PRETTIERRC}: ${candidate} could not be parsed to check its "prettier" key; skipped.`
    });
    return undefined;
  }
}

/**
 * Walk up from the formatted file's directory to the workspace root (stopDir,
 * INCLUSIVE) looking for the nearest Prettier config, probing each directory's
 * search places in Prettier's own order. Returns the first hit or undefined.
 *
 * The walk NEVER crosses stopDir: a config above the trusted workspace is
 * invisible. The bound is checked THREE ways, all of them fail-closed:
 *   1. the starting directory must be contained in stopDir, else nothing is
 *      searched at all (a document outside the workspace has no trusted
 *      boundary to walk within);
 *   2. the walk stops after searching stopDir itself;
 *   3. every step upward must stay contained, so even if (2) failed to
 *      recognise the root the walk cannot leave the workspace.
 */
export function findPrettierConfig(
  startFsPath: string,
  stopDir: string,
  warnings: PrettierrcWarning[]
): PrettierConfigProbe | undefined {
  if (typeof startFsPath !== 'string' || startFsPath.trim() === '') {
    return undefined;
  }
  if (typeof stopDir !== 'string' || stopDir.trim() === '') {
    return undefined;
  }

  let dir = dirname(resolve(startFsPath));
  if (!isWithinDir(dir, stopDir)) {
    return undefined; // the document is not inside the trusted workspace.
  }

  for (let depth = 0; depth < MAX_WALK_DEPTH; depth += 1) {
    const listing = listDir(dir);
    for (const place of SEARCH_PLACES) {
      if (place.kind === 'package-json') {
        // Probed through its own stat: it must follow a symlink, read the size
        // cap and parse, and a package.json WITHOUT a "prettier" key does not
        // stop the walk.
        if (!placeIsPresent(listing, place.name)) {
          continue;
        }
        const candidate = join(dir, place.name);
        const probe = probePackageJson(candidate, warnings);
        if (probe !== undefined) {
          return {
            path: candidate,
            kind: 'package-json',
            packagePrettier: probe.value
          };
        }
      } else if (placeIsFile(listing, dir, place.name)) {
        return { path: join(dir, place.name), kind: place.kind };
      }
    }
    if (sameDir(dir, stopDir)) {
      return undefined; // workspace root reached (and searched): stop.
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined; // filesystem root
    }
    if (!isWithinDir(parent, stopDir)) {
      return undefined; // one step further would leave the workspace.
    }
    dir = parent;
  }
  return undefined;
}

/**
 * Build the .prettierrc ConfigLayer for an on-disk file. Never throws.
 *
 * `fsPath` MUST be a real absolute filesystem path (document.uri.fsPath) and
 * `stopDir` MUST be the containing workspace folder's fsPath: the caller
 * (vscodeConfig) resolves and gates both. The layer is only built for the
 * Prettier-path languages; any other languageId yields an empty result so the
 * caller may invoke this unconditionally.
 *
 * `printEngine` is the engine that will really print this document. It matters
 * only for plain 'javascript', whose engine is content dependent: the caller
 * that holds the document text passes the dispatcher's answer, and callers that
 * do not fall back to the conservative static default.
 */
export function readPrettierrcLayer(
  fsPath: string,
  languageId: LangId,
  stopDir: string,
  printEngine: PrintEngineId = staticPrintEngine(languageId)
): PrettierrcReadResult {
  if (!PRETTIERRC_LANGS.includes(languageId)) {
    return { warnings: [] };
  }

  const warnings: PrettierrcWarning[] = [];
  const hit = findPrettierConfig(fsPath, stopDir, warnings);
  if (hit === undefined) {
    return { warnings };
  }

  if (hit.kind === 'code') {
    warnings.push({
      message: `${SOURCE_PRETTIERRC}: found ${basename(hit.path)} at ${hit.path}; code-based Prettier configs are never executed (data files only); layer skipped.`
    });
    return { path: hit.path, warnings };
  }

  const where = `${SOURCE_PRETTIERRC} at ${hit.path}`;
  let root: Record<string, unknown>;

  if (hit.kind === 'package-json') {
    if (!isPlainObject(hit.packagePrettier)) {
      warnings.push({
        message: `${where}: the "prettier" key must be a plain object of options; shareable config references are never resolved; ignored.`
      });
      return { path: hit.path, warnings };
    }
    root = hit.packagePrettier;
  } else {
    let text: string;
    try {
      const size = statSync(hit.path).size;
      if (size > MAX_PRETTIERRC_BYTES) {
        warnings.push({
          message: `${where}: file too large (${size} bytes); ignored.`
        });
        return { path: hit.path, warnings };
      }
      text = readFileSync(hit.path, 'utf8');
    } catch {
      warnings.push({ message: `${where}: unreadable; ignored.` });
      return { path: hit.path, warnings };
    }
    const parsed = parsePrettierrcData(text, basename(hit.path));
    if (parsed.error !== undefined || parsed.root === undefined) {
      warnings.push({
        message: `${where}: ${parsed.error ?? 'unusable config'}; ignored.`
      });
      return { path: hit.path, warnings };
    }
    root = parsed.root;
  }

  const values = mapPrettierConfig(
    root,
    languageId,
    where,
    warnings,
    printEngine
  );
  if (Object.keys(values).length === 0) {
    return { path: hit.path, warnings };
  }
  return {
    path: hit.path,
    layer: { source: SOURCE_PRETTIERRC, values },
    warnings
  };
}
