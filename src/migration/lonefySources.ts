// Locate and read the config file the migration imports from (v0.5.0, MIGRATION).
//
// SOURCES, in this order, FIRST FOUND WINS (the recap names which one was used):
//   (a) `.vscode/formatter.json` in the FIRST workspace folder: the incumbent's
//       local config. The incumbent only ever looks in the first folder, so so do we.
//   (b) the global `formatter.json` inside the incumbent's OWN install folder
//       (`<extensionPath>/out/src/formatter.json`). Reachable ONLY when the
//       incumbent is installed AND enabled: `extensions.getExtension` cannot see a
//       disabled one (probe P4). It is also absent from the Open VSX package, so a
//       miss here is normal and silent.
//   (c) `.jsbeautifyrc` at a workspace root. The incumbent NEVER reads it (probe
//       P3(a)); it is kept because OTHER beautify extensions do, and the recap no
//       longer presents it as the incumbent's file.
//
// Detecting (a) does not depend on the incumbent being installed or enabled: what
// matters for a migration is the CONFIG FILE, which outlives the extension (LOW-13).
//
// GUARANTEES, all kept from the previous `.jsbeautifyrc`-only reader:
//   - every read is gated on a TRUSTED workspace (Restricted Mode reads nothing);
//   - every read is LOCAL and READ-ONLY (`workspace.fs.stat` / `readFile`, no
//     network, no write);
//   - the text is returned as a string and parsed elsewhere as DATA. Nothing here
//     `require`s or evaluates it: the incumbent loads its file with `require`,
//     Tidy must not.
//   - this module never throws: a failure is a value in the result.
//
// HOST-ONLY: `vscode` is a PARAMETER (the idiom of setDefaultFormatter.ts), so this
// module imports nothing from 'vscode' and is exercised by mock-driven unit tests
// as well as by the integration suite.
import type { MigrationSourceKind } from './types';
import { LONEFY_EXTENSION_ID } from './detectLonefy';

/** Conventional filename of the js-beautify config OTHER beautify extensions read. */
export const JSBEAUTIFYRC_FILENAME = '.jsbeautifyrc';

/** Path segments of the incumbent's local config, under a workspace folder. */
export const LONEFY_LOCAL_CONFIG_SEGMENTS: readonly string[] = [
  '.vscode',
  'formatter.json'
];

/** Path segments of the incumbent's global config, under its install folder. */
export const LONEFY_GLOBAL_CONFIG_SEGMENTS: readonly string[] = [
  'out',
  'src',
  'formatter.json'
];

/**
 * Largest config file we will read. The incumbent's own file is under 2 KiB; a
 * larger one is not a formatter config and is reported instead of being loaded.
 */
export const MAX_CONFIG_BYTES = 256 * 1024;

/** What {@link readMigrationSource} found. Never an exception. */
export type SourceReadResult =
  /** Restricted Mode: no workspace file was read. */
  | { readonly state: 'untrusted' }
  /** None of the three sources exists. */
  | { readonly state: 'none' }
  /** The first source that exists, with its text (parsed elsewhere, as data). */
  | {
      readonly state: 'found';
      readonly kind: MigrationSourceKind;
      readonly text: string;
    }
  /** The first source that exists could not be used (a folder, too large, unreadable). */
  | {
      readonly state: 'unreadable';
      readonly kind: MigrationSourceKind;
      readonly cause: string;
    };

interface Candidate {
  readonly kind: MigrationSourceKind;
  readonly uri: unknown;
}

type FileRead =
  | { readonly state: 'absent' }
  | { readonly state: 'text'; readonly text: string }
  | { readonly state: 'unusable'; readonly cause: string };

/** A single-line, bounded cause: a read error may carry a long path or a stack. */
function causeOf(error: unknown): string {
  const raw = error instanceof Error ? error.message : 'unknown error';
  const oneLine = raw.split('\n', 1)[0].trim();
  return oneLine.length > 120 ? `${oneLine.slice(0, 117)}...` : oneLine;
}

/** Drop a leading UTF-8 byte-order mark (Node's `require` does; Windows editors write one). */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Read one candidate file: `absent` when it does not exist (the normal case), the
 * text when it does, and `unusable` (with a reason) when it exists but is a
 * folder, too large, or unreadable. `stat` first so a huge file is never loaded.
 */
async function readCandidate(vscode: any, uri: unknown): Promise<FileRead> {
  let stat: { type: number; size?: number };
  try {
    stat = await vscode.workspace.fs.stat(uri);
  } catch {
    return { state: 'absent' };
  }
  if ((stat.type & vscode.FileType.Directory) !== 0) {
    return { state: 'unusable', cause: 'it is a folder, not a file' };
  }
  if (typeof stat.size === 'number' && stat.size > MAX_CONFIG_BYTES) {
    return {
      state: 'unusable',
      cause: `it is larger than ${MAX_CONFIG_BYTES / 1024} KiB`
    };
  }
  try {
    const bytes: Uint8Array = await vscode.workspace.fs.readFile(uri);
    return { state: 'text', text: stripBom(Buffer.from(bytes).toString('utf8')) };
  } catch (error: unknown) {
    return { state: 'unusable', cause: causeOf(error) };
  }
}

/**
 * The candidate files in precedence order. Building the list does no I/O.
 * (b) exists only when the incumbent is installed and enabled.
 */
function buildCandidates(vscode: any): Candidate[] {
  const candidates: Candidate[] = [];
  const folders: readonly { uri: unknown }[] =
    vscode.workspace.workspaceFolders ?? [];

  if (folders.length > 0) {
    candidates.push({
      kind: 'workspace-formatter-json',
      uri: vscode.Uri.joinPath(folders[0].uri, ...LONEFY_LOCAL_CONFIG_SEGMENTS)
    });
  }

  const incumbent = vscode.extensions.getExtension(LONEFY_EXTENSION_ID);
  if (incumbent && typeof incumbent.extensionPath === 'string') {
    candidates.push({
      kind: 'global-formatter-json',
      uri: vscode.Uri.joinPath(
        vscode.Uri.file(incumbent.extensionPath),
        ...LONEFY_GLOBAL_CONFIG_SEGMENTS
      )
    });
  }

  for (const folder of folders) {
    candidates.push({
      kind: 'jsbeautifyrc',
      uri: vscode.Uri.joinPath(folder.uri, JSBEAUTIFYRC_FILENAME)
    });
  }
  return candidates;
}

/**
 * Find the first config file that exists, in the order documented at the top of
 * this file, and return its text. Trust-gated, local, read-only, never throws.
 */
export async function readMigrationSource(
  vscode: any
): Promise<SourceReadResult> {
  try {
    if (vscode.workspace.isTrusted === false) {
      return { state: 'untrusted' }; // Restricted Mode: do not read workspace content.
    }
    for (const candidate of buildCandidates(vscode)) {
      const read = await readCandidate(vscode, candidate.uri);
      if (read.state === 'absent') {
        continue; // not here: try the next source.
      }
      return read.state === 'text'
        ? { state: 'found', kind: candidate.kind, text: read.text }
        : { state: 'unreadable', kind: candidate.kind, cause: read.cause };
    }
    return { state: 'none' };
  } catch {
    // Belt and braces: locating a file must never break the migration command.
    return { state: 'none' };
  }
}
