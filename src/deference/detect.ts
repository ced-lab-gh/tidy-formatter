// Detect competing/concurrent formatters configured in the workspace so Tidy can
// SURFACE (never silently disable) a deference notification (Axe 4 / 4.T4 + 4.T5).
//
// ANTI-HIJACK (ARCH-01/02, SPEC §5/§10/§12) — NON-NEGOTIABLE:
//   - This module only DETECTS that another formatter is configured. It writes no
//     setting, changes no `editor.defaultFormatter`, and triggers no formatting.
//     The decision of what to do with the detection lives in `decide.ts`; surfacing
//     it lives in the host layer. Detection alone changes nothing.
//
// SPLIT OF CONCERNS: `detectFromFilenames` is a PURE function (no 'vscode', no I/O)
// that maps a flat list of workspace-root entry names to the set of competing
// formatters they imply, so the recognition table is unit-testable under mocha+tsx.
// The thin `detectCompetingFormatters` wrapper loads 'vscode' lazily and reads the
// workspace (Workspace Trust gated) only in the extension host.
//
// CFG-07: a `.prettierignore` on its own DOES NOT imply Prettier is configured as a
// formatter (it only narrows what Prettier would touch IF it were configured), so it
// never activates deference by itself.

/**
 * Canonical labels for the competing formatters Tidy recognises. Stable strings
 * (surfaced verbatim in the deference message and asserted in tests); never
 * localised here so the host owns presentation.
 */
export const FORMATTER_PRETTIER = 'Prettier';
export const FORMATTER_BIOME = 'Biome';
export const FORMATTER_DPRINT = 'dprint';

/**
 * Recognised Prettier config filenames (the variants Prettier itself honours).
 * `.prettierrc` with any of the documented extensions, plus the bare file and the
 * explicit `prettier.config.*` forms. `.prettierignore` is deliberately ABSENT
 * (CFG-07): an ignore file alone does not configure Prettier as a formatter.
 */
const PRETTIER_CONFIG_FILES: ReadonlySet<string> = new Set([
  '.prettierrc',
  '.prettierrc.json',
  '.prettierrc.json5',
  '.prettierrc.yaml',
  '.prettierrc.yml',
  '.prettierrc.js',
  '.prettierrc.cjs',
  '.prettierrc.mjs',
  '.prettierrc.ts',
  '.prettierrc.cts',
  '.prettierrc.mts',
  '.prettierrc.toml',
  'prettier.config.js',
  'prettier.config.cjs',
  'prettier.config.mjs',
  'prettier.config.ts',
  'prettier.config.cts',
  'prettier.config.mts'
]);

/** Biome's config filenames (current `biome.json` and the JSONC variant). */
const BIOME_CONFIG_FILES: ReadonlySet<string> = new Set(['biome.json', 'biome.jsonc']);

/** dprint's config filenames (canonical and dotfile/JSONC variants). */
const DPRINT_CONFIG_FILES: ReadonlySet<string> = new Set([
  'dprint.json',
  'dprint.jsonc',
  '.dprint.json',
  '.dprint.jsonc'
]);

/**
 * The conventional name of a package manifest whose `prettier` key (when present)
 * also configures Prettier as a formatter, exactly like a `.prettierrc*` file.
 */
export const PACKAGE_JSON_FILENAME = 'package.json';

/**
 * PURE detection: given the list of entry names found at a workspace-folder root
 * (filenames only, not full paths), return the distinct competing formatters they
 * imply, in a stable order (Prettier, Biome, dprint).
 *
 * No 'vscode', no I/O, no throw. Unknown / unrelated names are ignored. A
 * `.prettierignore` alone yields nothing (CFG-07). Inputs that are not strings are
 * skipped defensively so a malformed directory listing can never break detection.
 *
 * The `package.json` `prettier` key is detected separately by the host (it requires
 * reading the file), and merged in via `mergeDetected`; pass `packageJsonHasPrettier`
 * to fold that signal into a single sorted result here.
 *
 * @param filenames               entry names at one or more workspace roots.
 * @param packageJsonHasPrettier  whether a package.json declares a `prettier` key.
 */
export function detectFromFilenames(
  filenames: readonly string[],
  packageJsonHasPrettier = false
): string[] {
  const found = new Set<string>();

  if (Array.isArray(filenames)) {
    for (const raw of filenames) {
      if (typeof raw !== 'string') {
        continue;
      }
      const name = raw.trim();
      if (PRETTIER_CONFIG_FILES.has(name)) {
        found.add(FORMATTER_PRETTIER);
      } else if (BIOME_CONFIG_FILES.has(name)) {
        found.add(FORMATTER_BIOME);
      } else if (DPRINT_CONFIG_FILES.has(name)) {
        found.add(FORMATTER_DPRINT);
      }
    }
  }

  if (packageJsonHasPrettier === true) {
    found.add(FORMATTER_PRETTIER);
  }

  return sortDetected(found);
}

/**
 * Order a set of detected formatter labels into the stable surfacing order. PURE.
 * Keeps notifications deterministic regardless of filesystem listing order.
 */
function sortDetected(found: ReadonlySet<string>): string[] {
  const order = [FORMATTER_PRETTIER, FORMATTER_BIOME, FORMATTER_DPRINT];
  return order.filter((label) => found.has(label));
}

/**
 * Merge several detection results (e.g. one per workspace folder) into a single
 * de-duplicated, stably ordered list. PURE.
 */
export function mergeDetected(...results: ReadonlyArray<readonly string[]>): string[] {
  const found = new Set<string>();
  for (const result of results) {
    if (!Array.isArray(result)) {
      continue;
    }
    for (const label of result) {
      if (typeof label === 'string') {
        found.add(label);
      }
    }
  }
  return sortDetected(found);
}

/**
 * Whether a parsed package.json object declares a top-level `prettier` key (the
 * inline Prettier config form). PURE: takes already-parsed JSON, no I/O. Any
 * non-object input yields false (fail-soft).
 */
export function packageJsonDeclaresPrettier(parsed: unknown): boolean {
  return (
    parsed !== null &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    Object.prototype.hasOwnProperty.call(parsed, 'prettier')
  );
}

/* -------------------------------------------------------------------------- */
/* VS Code wrapper (loads 'vscode' lazily; runs only in the extension host)      */
/* -------------------------------------------------------------------------- */
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */

/**
 * Whether the workspace is trusted enough to read workspace-authored config files.
 * Mirrors vscodeConfig.shouldReadEditorConfig / runMigration.isWorkspaceTrusted:
 * in Restricted Mode we do NOT read workspace content, so detection yields nothing.
 */
function isWorkspaceTrusted(vscode: any): boolean {
  return vscode.workspace.isTrusted !== false;
}

/**
 * Best-effort: does a package.json at this folder root declare a `prettier` key?
 * Reads + parses the file; any failure (absent / unreadable / malformed JSON)
 * yields false so detection never throws and never blocks activation.
 */
async function rootPackageJsonHasPrettier(vscode: any, folderUri: any): Promise<boolean> {
  try {
    const uri = vscode.Uri.joinPath(folderUri, PACKAGE_JSON_FILENAME);
    const bytes = await vscode.workspace.fs.readFile(uri);
    const text = Buffer.from(bytes).toString('utf8');
    return packageJsonDeclaresPrettier(JSON.parse(text));
  } catch {
    return false;
  }
}

/**
 * List the entry names directly under a workspace folder root. Returns [] on any
 * failure (fail-soft): detection must never break boot.
 */
async function listRootEntries(vscode: any, folderUri: any): Promise<string[]> {
  try {
    const entries = await vscode.workspace.fs.readDirectory(folderUri);
    // entries is Array<[name, FileType]>; we only need the names.
    return entries.map((entry: [string, number]) => entry[0]);
  } catch {
    return [];
  }
}

/**
 * Host-only: scan the workspace folders for competing-formatter configuration and
 * return the distinct formatters detected, stably ordered. Workspace-Trust gated
 * (Restricted Mode => [], no reads). Never throws: any failure yields [].
 *
 * Reads only directory listings + (best-effort) package.json `prettier` keys; it
 * executes no workspace code and writes nothing.
 */
export async function detectCompetingFormatters(): Promise<string[]> {
  try {
    const vscode = require('vscode');
    if (!isWorkspaceTrusted(vscode)) {
      return []; // Restricted Mode: do not read workspace content.
    }
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return [];
    }
    const perFolder: string[][] = [];
    for (const folder of folders) {
      const names = await listRootEntries(vscode, folder.uri);
      const hasPrettierKey = await rootPackageJsonHasPrettier(vscode, folder.uri);
      perFolder.push(detectFromFilenames(names, hasPrettierKey));
    }
    return mergeDetected(...perFolder);
  } catch {
    return [];
  }
}
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */
