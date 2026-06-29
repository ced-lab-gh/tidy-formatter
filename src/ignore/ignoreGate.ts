// VS Code-facing gate for the .soukformatignore file lookup (Axe 4.T3).
//
// This is the single thin seam that lets the provider consult the project-level
// .soukformatignore while honouring the same two policy gates the .editorconfig /
// .soukformatrc readers use:
//   1. opt-out  `tidy.respectSoukformatignore` (default true) is not disabled;
//   2. Workspace Trust — a .soukformatignore is workspace-authored content, so in
//      Restricted Mode we must not read it (the file is formatted, fail-safe);
//   3. the document has a real on-disk path (scheme 'file'); virtual / untitled
//      documents have no tree to walk and are never ignored by this path.
//
// The matching itself lives in the PURE soukformatignore module (resolveIgnore);
// this module only applies the VS Code policy gates, so the ignore logic stays
// unit-testable outside the Electron host. Never throws: any failure is fail-SAFE
// (treated as "not ignored", so formatting proceeds — Axe 4.T3 "lecture echoue ->
// on formate").
import * as vscode from 'vscode';
import { resolveIgnore, type IgnoreLookup } from './soukformatignore';

/** The opt-out setting key (declared in package.json; default true). */
export const RESPECT_SOUKFORMATIGNORE_KEY = 'respectSoukformatignore';

/**
 * Whether the .soukformatignore lookup should run for this document. All three
 * gates must pass; any failing gate yields false (so the file is NOT treated as
 * ignored and formatting proceeds).
 */
function shouldConsultIgnore(document: vscode.TextDocument): boolean {
  if (document.uri.scheme !== 'file') {
    return false;
  }
  if (vscode.workspace.isTrusted === false) {
    return false; // Restricted Mode: do not read workspace-authored content.
  }
  const config = vscode.workspace.getConfiguration('tidy', document.uri);
  // Default true: an absent setting must behave as enabled.
  return config.get<boolean>(RESPECT_SOUKFORMATIGNORE_KEY, true) !== false;
}

/**
 * Resolve whether a document is excluded by the nearest .soukformatignore,
 * applying the VS Code policy gates. Returns a non-ignored verdict (no read) when
 * any gate fails. Never throws: any unexpected error is fail-safe (not ignored).
 */
export function resolveDocumentIgnore(document: vscode.TextDocument): IgnoreLookup {
  if (!shouldConsultIgnore(document)) {
    return { ignored: false };
  }
  try {
    return resolveIgnore(document.uri.fsPath);
  } catch {
    // Defensive: the pure resolver is already fail-safe, but never let an
    // unexpected error block formatting — treat as "not ignored".
    return { ignored: false };
  }
}
