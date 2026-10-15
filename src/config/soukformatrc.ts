// .soukformatrc reader (precedence layer 4, with glob overrides as layer 5).
//
// PURE: this module MUST NOT import 'vscode'. It reads a project config file from
// disk via node:fs only (no workspace APIs, no engine code execution), parses it
// as JSONC (jsonc-parser, already a dependency), validates each option against
// the catalogue, and emits ConfigLayer(s) the pure resolver merges deeply by key.
//
// Schema (JSONC):
//   {
//     // top-level keys are language sections; each holds tidy.* options without
//     // the "tidy." prefix (e.g. "indent", "singleQuote", "preserve_newlines").
//     "css":        { "indent": 4 },
//     "typescript": { "singleQuote": true, "semi": false },
//     // optional ordered glob overrides applied AFTER the language section,
//     // earlier entries first so later entries win (deep merge by key).
//     "overrides": [
//       { "files": "src/**/*.css", "options": { "indent": 8 } }
//     ]
//   }
//
// BOUNDED WALK: the upward search stops at the workspace folder root (stopDir,
// inclusive). A .soukformatrc ABOVE the trusted workspace, in a parent
// directory, a shared checkout root, the user's home directory or the
// filesystem root, is a file the user never opened; letting it govern would
// silently change how their code is formatted on the strength of content they
// never chose to trust. The bound is real PATH CONTAINMENT (isWithinDir, shared
// with the .prettierrc layer), never string equality: a case-mismatched drive
// letter, a trailing separator, a mixed separator or a '..' segment must not be
// able to let the walk escape. `stopDir` is REQUIRED: without a trusted
// boundary there is nothing to walk within, so the layer is simply absent.
//
// FAIL-SOFT: a missing file yields no layer; a malformed or oversized file yields
// no layer plus a warning (never a throw) so formatting falls back to the lower
// layers.
//
// COST BOUND (LOW-07): the file is size-capped (MAX_SOUKFORMATRC_BYTES) using the
// stat the upward walk already made, so the cap adds no syscall, and the parsed
// document is memoised by the file's full identity (size, mtime and ctime in
// nanoseconds, inode, device) so an unchanged file is neither re-read nor
// re-parsed on every format, and never served stale: where freshness cannot be
// proved (coarse timestamps, no inode, a file touched a moment ago) it is simply
// re-read. The per-format cost is then only the
// walk's stat per directory level: it cannot be cached without missing a nearer
// .soukformatrc that appeared since. `overrides[].files` globs go through the
// shared LINEAR matcher of ../ignore/glob, never a RegExp.
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parse as parseJsonc, type ParseError, printParseErrorCode } from 'jsonc-parser';
// File identity and the "can an unchanged identity be trusted" rule, shared with
// the .soukformatignore memo.
import {
  canProveFreshness,
  sameIdentity,
  statFileIdentity,
  type FileIdentity
} from './fileIdentity';
import type { ConfigLayer } from './resolver';
// Path containment, REUSED from the .prettierrc layer rather than reinvented:
// one implementation of the workspace bound means one place where it has to be
// proven correct (drive-letter case, trailing separators, mixed separators,
// '..' segments, UNC shares) and no way for the two project-config walks to
// disagree about where the trusted workspace ends. Both modules are pure (no
// 'vscode'), so this adds no host coupling and no import cycle.
import { comparableDir, isWithinDir } from './prettierrc';
// The ONE glob matcher, shared with .soukformatignore: linear, gitignore
// semantics (a slash-less pattern matches at any depth), fail-closed on a
// pattern it cannot evaluate. Pure and dependency-free, so no host coupling.
// The prefix that tells a recorded fail-closed reason from a file path lives with
// the ignore reporting (isFailClosedDetail), which the status surfaces already use.
import { SOUKFORMATRC_FAIL_CLOSED_DETAIL_PREFIX } from '../ignore/soukformatignore';
import {
  MatchBudget,
  compileFilesGlob,
  describeBudgetExceeded,
  describeUnevaluable,
  patternMatches,
  preparePath
} from '../ignore/glob';
import {
  OPTION_CATALOG,
  appliesToLanguage,
  validateValue,
  type CatalogLang,
  type OptionEntry
} from './optionCatalog';

/**
 * The on-disk filename Tidy looks for, walking from a file up to (and
 * including) the workspace folder root, never beyond it.
 */
export const SOUKFORMATRC_FILENAME = '.soukformatrc';

/**
 * Upper bound on the upward walk, mirroring findPrettierConfig's bound. It is a
 * belt-and-braces stop against a pathological path or a symlink loop; the real
 * bound is the workspace containment test.
 */
const MAX_WALK_DEPTH = 64;

/**
 * Largest .soukformatrc that is read at all (1 MiB, the same bound the
 * .prettierrc layer applies). A real config is a few hundred bytes; a larger
 * file is refused with a warning rather than read and parsed synchronously on
 * the extension host's thread on every format.
 */
export const MAX_SOUKFORMATRC_BYTES = 1_048_576;

/** Most parsed configs kept in memory at once (one per distinct file path). */
const MAX_CACHED_CONFIGS = 32;

/** Origin label prefix surfaced verbatim in "Show Effective Configuration". */
export const SOURCE_SOUKFORMATRC = '.soukformatrc';


/**
 * A non-fatal problem encountered while reading/parsing/validating the file.
 * The caller (vscodeConfig) logs these; they never abort formatting.
 */
export interface SoukWarning {
  readonly message: string;
}

/**
 * The result of reading a .soukformatrc for one language: zero or more ordered
 * ConfigLayers (the language section first, then each matching glob override) and
 * any non-fatal warnings. Layers are ordered general -> specific for the resolver.
 */
export interface SoukReadResult {
  /** Absolute path of the file that was read, or undefined when none found. */
  readonly path?: string;
  /** Ordered layers (language section, then matching overrides). */
  readonly layers: ConfigLayer[];
  /** Non-fatal warnings (malformed JSON, unknown keys, invalid values...). */
  readonly warnings: SoukWarning[];
  /**
   * Set only when the overrides could not be fully evaluated (their work budget
   * ran out), so the options this result yields may be wrong: the caller must NOT
   * format with them. One line, starting with `.soukformatrc `, suited to the
   * last-format record (see isSoukformatrcFailClosedDetail in ../ignore/soukformatignore).
   */
  readonly failClosed?: string;
}

/** Strip the "tidy." prefix from a setting key so the file can omit it. */
function bareKey(settingKey: string): string {
  return settingKey.startsWith('tidy.') ? settingKey.slice('tidy.'.length) : settingKey;
}

/**
 * Index catalogue entries by the key(s) a .soukformatrc may use for them. A user
 * may write either the namespaced form (e.g. "prettier.singleQuote") OR the plain
 * option name (e.g. "singleQuote"); both resolve to the same entry. Plain names
 * are unique across the catalogue, so the short form is unambiguous.
 */
const ENTRY_BY_BARE_KEY: ReadonlyMap<string, OptionEntry> = (() => {
  const map = new Map<string, OptionEntry>();
  for (const entry of OPTION_CATALOG) {
    map.set(bareKey(entry.settingKey), entry);
    // Also accept the plain final segment (the engine option name) for prettier
    // options so a section can read { "singleQuote": true } not { "prettier.singleQuote": true }.
    if (entry.engine === 'prettier') {
      map.set(entry.engineKey, entry);
    }
  }
  return map;
})();

/**
 * The canonical engineOptions key the resolver/engines expect for an entry:
 *  - prettier options are namespaced under engineOptions.prettier, so the file
 *    value is mapped onto the bare prettier key here and re-nested by vscodeConfig
 *    : but for the pure layer we forward the prettier key prefixed so the resolver
 *    keeps it in engineOptions and vscodeConfig nesting is unnecessary. To keep
 *    this module pure AND consistent with the VS Code path, we emit prettier keys
 *    as `prettier.<engineKey>` so the consumer can lift them into the object.
 *  - js-beautify/core options use their engineKey directly.
 *
 * NOTE: the resolver treats any non-typed key as a flat engineOptions entry, so a
 * dotted "prettier.semi" key lands in engineOptions["prettier.semi"]. vscodeConfig
 * (and showConfig) understand this convention and nest it into engineOptions.prettier
 * before dispatch. This keeps soukformatrc.ts free of any engine-shape coupling.
 */
function engineLayerKey(entry: OptionEntry): string {
  return entry.engine === 'prettier' ? `prettier.${entry.engineKey}` : entry.engineKey;
}

/**
 * Validate one language section ({ option: value, ... }) into a flat record of
 * resolver-ready key/values, collecting warnings for unknown keys / bad values /
 * options that do not apply to the language. PURE.
 */
function mapSection(
  section: Record<string, unknown>,
  lang: CatalogLang,
  warnings: SoukWarning[],
  where: string
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [rawKey, rawValue] of Object.entries(section)) {
    const entry = ENTRY_BY_BARE_KEY.get(rawKey);
    if (!entry) {
      warnings.push({ message: `${where}: unknown option "${rawKey}" ignored.` });
      continue;
    }
    if (!appliesToLanguage(entry, lang)) {
      warnings.push({
        message: `${where}: option "${rawKey}" does not apply to ${lang}; ignored.`
      });
      continue;
    }
    const valid = validateValue(entry, rawValue);
    if (valid === undefined) {
      warnings.push({
        message: `${where}: invalid value for "${rawKey}" (${JSON.stringify(rawValue)}); ignored.`
      });
      continue;
    }
    values[engineLayerKey(entry)] = valid;
  }
  return values;
}

/**
 * Build the ordered override layers that match `relativePosixPath`, validating
 * each override's options against the catalogue for `lang`. Non-array `overrides`
 * or malformed entries are skipped with a warning (fail-soft). When the work
 * budget runs out the options may be wrong, so `failClosed` carries the reason.
 */
function mapOverrides(
  overrides: unknown,
  lang: CatalogLang,
  relativePosixPath: string | undefined,
  warnings: SoukWarning[]
): { layers: ConfigLayer[]; failClosed?: string } {
  if (overrides === undefined) {
    return { layers: [] };
  }
  if (!Array.isArray(overrides)) {
    warnings.push({ message: `${SOURCE_SOUKFORMATRC}: "overrides" must be an array; ignored.` });
    return { layers: [] };
  }
  if (relativePosixPath === undefined) {
    // No on-disk path to match globs against (e.g. untitled doc): skip silently.
    return { layers: [] };
  }

  const layers: ConfigLayer[] = [];
  let failClosed: string | undefined;
  // ONE work budget for the whole lookup: many overrides times long globs times a
  // deep path must not add up to a freeze, however each one is bounded alone.
  const budget = new MatchBudget();
  const path = preparePath(relativePosixPath);
  for (let index = 0; index < overrides.length; index += 1) {
    const entry: unknown = overrides[index];
    if (entry === null || typeof entry !== 'object') {
      warnings.push({
        message: `${SOURCE_SOUKFORMATRC}: overrides[${index}] is not an object; ignored.`
      });
      continue;
    }
    const record = entry as Record<string, unknown>;
    const files = record.files;
    const options = record.options;
    if (typeof files !== 'string' || files.trim() === '') {
      warnings.push({
        message: `${SOURCE_SOUKFORMATRC}: overrides[${index}].files must be a non-empty glob; ignored.`
      });
      continue;
    }
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      warnings.push({
        message: `${SOURCE_SOUKFORMATRC}: overrides[${index}].options must be an object; ignored.`
      });
      continue;
    }
    // Exact case on every OS, like Prettier and EditorConfig: "*.CSS" never matches a.css.
    const glob = compileFilesGlob(files, { ignoreCase: false });
    if (glob === undefined) {
      warnings.push({
        message: `${SOURCE_SOUKFORMATRC}: overrides[${index}].files must be a non-empty glob; ignored.`
      });
      continue;
    }
    const problem = describeUnevaluable(glob, 'the override is skipped');
    if (problem !== undefined) {
      // An override only carries OPTIONS, it cannot exclude a file, so it is
      // skipped rather than applied to a guess. Never silently: the warning is
      // listed in "Show Effective Configuration".
      warnings.push({
        message: `${SOURCE_SOUKFORMATRC}: overrides[${index}].files ${problem}`
      });
      continue;
    }
    const covered = patternMatches(glob, path, false, budget);
    if (budget.exhausted) {
      // Out of work budget: this and every later override is skipped, and the
      // user is told. The options left may be wrong, so the file is not formatted
      // (failClosed), like a .soukformatignore that cannot be evaluated.
      const skipped = overrides.length - index;
      warnings.push({
        message:
          `${SOURCE_SOUKFORMATRC}: overrides[${index}].files: ` +
          describeBudgetExceeded(
            overrides.length,
            `overrides[${index}] and the ${skipped - 1} after it are skipped`
          )
      });
      // No final full stop, so a caller can append its own punctuation.
      failClosed =
        `${SOUKFORMATRC_FAIL_CLOSED_DETAIL_PREFIX}overrides: ` +
        describeBudgetExceeded(overrides.length, 'Tidy left the file alone').replace(/\.$/, '');
      break;
    }
    if (!covered) {
      continue;
    }
    const where = `${SOURCE_SOUKFORMATRC} overrides[${index}] (${files})`;
    const values = mapSection(options as Record<string, unknown>, lang, warnings, where);
    if (Object.keys(values).length > 0) {
      layers.push({ source: where, values });
    }
  }
  return failClosed === undefined ? { layers } : { layers, failClosed };
}

/**
 * The outcome of parsing a config's TEXT, independent of language and file path:
 * either the JSON object at its root, or the warning explaining why the file is
 * ignored. This is what is memoised, so it holds no per-format state.
 */
type ParsedRoot =
  | { readonly root: Readonly<Record<string, unknown>> }
  | { readonly failure: string };

/** The UTF-8 byte order mark, as it reads back from a file decoded as UTF-8. */
const BYTE_ORDER_MARK = '\uFEFF';

/** Parse JSONC text into its root object, or the reason the file is ignored. */
function parseRoot(rawText: string, sourcePath: string): ParsedRoot {
  // Windows editors routinely save UTF-8 with a byte order mark, which JSONC
  // reports as an invalid symbol and would discard the whole file.
  const text = rawText.startsWith(BYTE_ORDER_MARK) ? rawText.slice(BYTE_ORDER_MARK.length) : rawText;
  const errors: ParseError[] = [];
  const parsed = parseJsonc(text, errors, {
    allowTrailingComma: true,
    disallowComments: false
  });

  if (errors.length > 0) {
    const first = errors[0];
    return {
      failure: `${SOURCE_SOUKFORMATRC} at ${sourcePath}: malformed JSONC (${printParseErrorCode(
        first.error
      )} at offset ${first.offset}); file ignored.`
    };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      failure: `${SOURCE_SOUKFORMATRC} at ${sourcePath}: root must be a JSON object; file ignored.`
    };
  }
  return { root: parsed as Record<string, unknown> };
}

/**
 * Turn a parsed root into ordered ConfigLayers for one language (the language
 * section, then each matching glob override), appending any warnings. Reads
 * `root` and never mutates it, so a memoised root can be shared across formats.
 */
function layersFromRoot(
  root: Readonly<Record<string, unknown>>,
  lang: CatalogLang,
  relativePosixPath: string | undefined
): { layers: ConfigLayer[]; warnings: SoukWarning[]; failClosed?: string } {
  const warnings: SoukWarning[] = [];
  const layers: ConfigLayer[] = [];

  // Language section (layer 4).
  const section = root[lang];
  if (section !== undefined) {
    if (section === null || typeof section !== 'object' || Array.isArray(section)) {
      warnings.push({
        message: `${SOURCE_SOUKFORMATRC}: section "${lang}" must be an object; ignored.`
      });
    } else {
      const where = `${SOURCE_SOUKFORMATRC}[${lang}]`;
      const values = mapSection(section as Record<string, unknown>, lang, warnings, where);
      if (Object.keys(values).length > 0) {
        layers.push({ source: where, values });
      }
    }
  }

  // Glob overrides (layer 5) : appended after the language section so they win.
  const overrides = mapOverrides(root.overrides, lang, relativePosixPath, warnings);
  layers.push(...overrides.layers);

  return overrides.failClosed === undefined
    ? { layers, warnings }
    : { layers, warnings, failClosed: overrides.failClosed };
}

/**
 * Parse already-read JSONC text into ordered ConfigLayers for one language.
 * PURE: takes the raw text (no I/O), so it is directly unit-testable.
 *
 * `relativePosixPath` is the file's path relative to the config dir, used only to
 * evaluate glob overrides; pass undefined to skip override matching.
 */
export function parseSoukformatrc(
  text: string,
  lang: CatalogLang,
  sourcePath: string,
  relativePosixPath?: string
): { layers: ConfigLayer[]; warnings: SoukWarning[]; failClosed?: string } {
  const parsed = parseRoot(text, sourcePath);
  if ('failure' in parsed) {
    return { layers: [], warnings: [{ message: parsed.failure }] };
  }
  return layersFromRoot(parsed.root, lang, relativePosixPath);
}

/** A .soukformatrc found by the walk, with the stat that found it. */
interface LocatedConfig extends FileIdentity {
  readonly path: string;
}

/**
 * Walk up from a file's directory to the workspace root (`stopDir`, INCLUSIVE)
 * looking for the nearest .soukformatrc, and return it with the stat that found
 * it. See findSoukformatrc for the bound, which is enforced here.
 */
function locateSoukformatrc(startFsPath: string, stopDir: string): LocatedConfig | undefined {
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

  // Guard against pathological inputs / symlink loops with a generous bound.
  for (let depth = 0; depth < MAX_WALK_DEPTH; depth += 1) {
    const candidate = join(dir, SOUKFORMATRC_FILENAME);
    const found = statFileIdentity(candidate);
    if (found !== undefined) {
      return { path: candidate, ...found };
    }
    if (comparableDir(dir) === comparableDir(stopDir)) {
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
 * Walk up from a file's directory to the workspace root (`stopDir`, INCLUSIVE)
 * looking for the nearest .soukformatrc. Returns its absolute path, or
 * undefined when there is none inside the bound.
 *
 * The walk NEVER crosses stopDir: a .soukformatrc above the trusted workspace
 * is invisible, so a file the user never opened cannot change how their code is
 * formatted. The bound is checked THREE ways, all of them fail-CLOSED:
 *   1. the starting directory must be contained in stopDir, else nothing is
 *      searched at all (a document outside the workspace has no trusted
 *      boundary to walk within);
 *   2. the walk stops after searching stopDir itself;
 *   3. every step upward must stay contained, so even if (2) failed to
 *      recognise the root the walk still cannot leave the workspace.
 *
 * A missing or blank `stopDir` searches NOTHING, for the same reason: the
 * absence of a boundary is not a licence to read the whole filesystem.
 */
export function findSoukformatrc(
  startFsPath: string,
  stopDir: string
): string | undefined {
  return locateSoukformatrc(startFsPath, stopDir)?.path;
}

/** A parsed config kept in memory, valid while its identity is unchanged. */
interface CachedConfig {
  readonly identity: FileIdentity;
  readonly parsed: ParsedRoot;
}

/** Insertion-ordered, so the oldest entry is the first key (evicted first). */
const configCache = new Map<string, CachedConfig>();

/** Forget every memoised config. Tests use it; a normal session never needs it. */
export function clearSoukformatrcCache(): void {
  configCache.clear();
}

/** The clock the freshness window reads. */
let clock: () => number = Date.now;

/**
 * Replace the clock the freshness window reads (a test moves it forward to make a
 * file "settled" without waiting); call with no argument to restore the real one.
 */
export function setSoukformatrcClock(now?: () => number): void {
  clock = now ?? Date.now;
}

/**
 * The parsed root of a located config: from the memo when its identity is exactly
 * the one memoised AND freshness can be proved (see canProveFreshness), otherwise
 * read and parsed once. Returns undefined when the file cannot be read. A config
 * whose freshness cannot be proved is never memoised, so it is read every time.
 */
function loadRoot(located: LocatedConfig): ParsedRoot | undefined {
  const cached = configCache.get(located.path);
  if (cached !== undefined && sameIdentity(cached.identity, located)) {
    return cached.parsed;
  }

  let text: string;
  try {
    text = readFileSync(located.path, 'utf8');
  } catch {
    configCache.delete(located.path);
    return undefined;
  }

  const parsed = parseRoot(text, located.path);
  configCache.delete(located.path);
  if (canProveFreshness(located, clock())) {
    if (configCache.size >= MAX_CACHED_CONFIGS) {
      const oldest = configCache.keys().next();
      if (oldest.done !== true) {
        configCache.delete(oldest.value);
      }
    }
    const { size, mtimeNs, ctimeNs, ino, dev } = located;
    configCache.set(located.path, { identity: { size, mtimeNs, ctimeNs, ino, dev }, parsed });
  }
  return parsed;
}

/**
 * Read the nearest .soukformatrc for an on-disk file and produce ordered
 * ConfigLayers for the given language. Never throws: any I/O or parse failure
 * yields no layer plus a warning so the lower precedence layers still govern
 * (fail-soft, CFG-06).
 *
 * `fsPath` MUST be a real absolute filesystem path (e.g. document.uri.fsPath)
 * and `stopDir` MUST be the containing workspace folder's fsPath: the caller
 * (vscodeConfig) resolves and gates both. The walk never leaves `stopDir`, so a
 * .soukformatrc outside the trusted workspace can never govern.
 */
export function readSoukformatrcLayers(
  fsPath: string,
  lang: CatalogLang,
  stopDir: string
): SoukReadResult {
  if (typeof fsPath !== 'string' || fsPath.trim() === '') {
    return { layers: [], warnings: [] };
  }

  const located = locateSoukformatrc(fsPath, stopDir);
  if (located === undefined) {
    return { layers: [], warnings: [] };
  }
  const configPath = located.path;

  // The cap uses the stat the walk already made: no extra syscall, and an
  // oversized file is never read.
  if (located.size > MAX_SOUKFORMATRC_BYTES) {
    return {
      path: configPath,
      layers: [],
      warnings: [
        {
          message:
            `${SOURCE_SOUKFORMATRC} at ${configPath}: file too large ` +
            `(${located.size} bytes; the limit is ${MAX_SOUKFORMATRC_BYTES}); file ignored.`
        }
      ]
    };
  }

  const parsed = loadRoot(located);
  if (parsed === undefined) {
    return {
      path: configPath,
      layers: [],
      warnings: [{ message: `${SOURCE_SOUKFORMATRC} at ${configPath}: unreadable; ignored.` }]
    };
  }
  if ('failure' in parsed) {
    return { path: configPath, layers: [], warnings: [{ message: parsed.failure }] };
  }

  // Path of the formatted file relative to the config file's directory, in POSIX
  // form, for glob matching of overrides.
  const configDir = dirname(configPath);
  const rel = relative(configDir, fsPath);
  const relativePosixPath = rel.split(sep).join('/');

  const { layers, warnings, failClosed } = layersFromRoot(parsed.root, lang, relativePosixPath);
  return failClosed === undefined
    ? { path: configPath, layers, warnings }
    : { path: configPath, layers, warnings, failClosed };
}
