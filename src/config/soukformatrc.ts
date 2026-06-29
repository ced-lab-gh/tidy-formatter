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
// FAIL-SOFT: a missing file yields no layer; a malformed file yields no layer
// plus a warning (never a throw) so formatting falls back to the lower layers.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { parse as parseJsonc, type ParseError, printParseErrorCode } from 'jsonc-parser';
import type { ConfigLayer } from './resolver';
import {
  OPTION_CATALOG,
  appliesToLanguage,
  validateValue,
  type CatalogLang,
  type OptionEntry
} from './optionCatalog';

/** The on-disk filename Tidy looks for, walking from a file up to the FS root. */
export const SOUKFORMATRC_FILENAME = '.soukformatrc';

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
 *    — but for the pure layer we forward the prettier key prefixed so the resolver
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
 * Convert a glob pattern (gitignore-lite, supporting ** / * / ?) into a RegExp
 * matched against a POSIX-style relative path. Kept minimal and dependency-free
 * (no new npm dep this pass): `**` matches any path segments, `*` any run within
 * a segment, `?` a single char. Anchored full-match.
 */
function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        // `**` => any characters including path separators.
        out += '.*';
        i += 1;
        // Skip a trailing slash after ** so `src/**/x` matches `src/x` too.
        if (glob[i + 1] === '/') {
          i += 1;
        }
      } else {
        // single `*` => any chars except a path separator.
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(`^${out}$`);
}

/**
 * Whether a glob matches the file's path relative to the config file's directory.
 * Both are normalised to forward slashes so patterns are portable across OSes.
 */
function globMatches(glob: string, relativePosixPath: string): boolean {
  try {
    return globToRegExp(glob).test(relativePosixPath);
  } catch {
    return false;
  }
}

/**
 * Build the ordered override layers that match `relativePosixPath`, validating
 * each override's options against the catalogue for `lang`. Non-array `overrides`
 * or malformed entries are skipped with a warning (fail-soft).
 */
function mapOverrides(
  overrides: unknown,
  lang: CatalogLang,
  relativePosixPath: string | undefined,
  warnings: SoukWarning[]
): ConfigLayer[] {
  if (overrides === undefined) {
    return [];
  }
  if (!Array.isArray(overrides)) {
    warnings.push({ message: `${SOURCE_SOUKFORMATRC}: "overrides" must be an array; ignored.` });
    return [];
  }
  if (relativePosixPath === undefined) {
    // No on-disk path to match globs against (e.g. untitled doc): skip silently.
    return [];
  }

  const layers: ConfigLayer[] = [];
  overrides.forEach((entry, index) => {
    if (entry === null || typeof entry !== 'object') {
      warnings.push({
        message: `${SOURCE_SOUKFORMATRC}: overrides[${index}] is not an object; ignored.`
      });
      return;
    }
    const record = entry as Record<string, unknown>;
    const files = record.files;
    const options = record.options;
    if (typeof files !== 'string' || files.trim() === '') {
      warnings.push({
        message: `${SOURCE_SOUKFORMATRC}: overrides[${index}].files must be a non-empty glob; ignored.`
      });
      return;
    }
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      warnings.push({
        message: `${SOURCE_SOUKFORMATRC}: overrides[${index}].options must be an object; ignored.`
      });
      return;
    }
    if (!globMatches(files, relativePosixPath)) {
      return;
    }
    const where = `${SOURCE_SOUKFORMATRC} overrides[${index}] (${files})`;
    const values = mapSection(options as Record<string, unknown>, lang, warnings, where);
    if (Object.keys(values).length > 0) {
      layers.push({ source: where, values });
    }
  });
  return layers;
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
): { layers: ConfigLayer[]; warnings: SoukWarning[] } {
  const warnings: SoukWarning[] = [];
  const errors: ParseError[] = [];
  const parsed = parseJsonc(text, errors, {
    allowTrailingComma: true,
    disallowComments: false
  });

  if (errors.length > 0) {
    const first = errors[0];
    warnings.push({
      message: `${SOURCE_SOUKFORMATRC} at ${sourcePath}: malformed JSONC (${printParseErrorCode(
        first.error
      )} at offset ${first.offset}); file ignored.`
    });
    return { layers: [], warnings };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    warnings.push({
      message: `${SOURCE_SOUKFORMATRC} at ${sourcePath}: root must be a JSON object; file ignored.`
    });
    return { layers: [], warnings };
  }

  const root = parsed as Record<string, unknown>;
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

  // Glob overrides (layer 5) — appended after the language section so they win.
  layers.push(...mapOverrides(root.overrides, lang, relativePosixPath, warnings));

  return { layers, warnings };
}

/**
 * Walk up from a file's directory looking for the nearest .soukformatrc.
 * Returns its absolute path, or undefined if none exists up to the FS root.
 * Bounded: stops at the filesystem root (parent === current).
 */
export function findSoukformatrc(startFsPath: string): string | undefined {
  let dir = dirname(startFsPath);
  // Guard against pathological inputs / symlink loops with a generous bound.
  for (let depth = 0; depth < 64; depth += 1) {
    const candidate = join(dir, SOUKFORMATRC_FILENAME);
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // Ignore stat/permission errors and keep walking up (fail-soft).
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
  return undefined;
}

/**
 * Read the nearest .soukformatrc for an on-disk file and produce ordered
 * ConfigLayers for the given language. Never throws: any I/O or parse failure
 * yields no layer plus a warning so the lower precedence layers still govern
 * (fail-soft, CFG-06).
 *
 * `fsPath` MUST be a real absolute filesystem path (e.g. document.uri.fsPath).
 */
export function readSoukformatrcLayers(fsPath: string, lang: CatalogLang): SoukReadResult {
  if (typeof fsPath !== 'string' || fsPath.trim() === '') {
    return { layers: [], warnings: [] };
  }

  const configPath = findSoukformatrc(fsPath);
  if (configPath === undefined) {
    return { layers: [], warnings: [] };
  }

  let text: string;
  try {
    text = readFileSync(configPath, 'utf8');
  } catch {
    return {
      path: configPath,
      layers: [],
      warnings: [{ message: `${SOURCE_SOUKFORMATRC} at ${configPath}: unreadable; ignored.` }]
    };
  }

  // Path of the formatted file relative to the config file's directory, in POSIX
  // form, for glob matching of overrides.
  const configDir = dirname(configPath);
  const rel = relative(configDir, fsPath);
  const relativePosixPath = rel.split(sep).join('/');

  const { layers, warnings } = parseSoukformatrc(text, lang, configPath, relativePosixPath);
  return { path: configPath, layers, warnings };
}
