// Shared post-processing pass applied AFTER an engine produced its output:
// per-line trailing-whitespace trim, final-newline policy, EOL normalisation.
//
// Introduced by ADD-01 so the Prettier postcss fallback path applies EXACTLY the
// same whitespace policy as the js-beautify family: the fallback must be a
// drop-in replacement for the primary engine as far as blank bytes go, otherwise
// a rescued stylesheet would drift from the house style on every save.
//
// PURE: this module MUST NOT import 'vscode' (testable under mocha + tsx).
import type { ResolvedOptions } from '../types';

const EOL_REGEX = /\r\n|\r|\n/g;
const TRAILING_WS_PER_LINE = /[^\S\r\n]+(?=\r\n|\r|\n|$)/g;

/**
 * Normalise line endings, optionally strip per-line trailing whitespace, and
 * apply the final-newline policy. Pure string transform: no mutation of inputs.
 *
 * Ordering matters: trailing-whitespace trimming runs before the final-newline
 * decision so a file ending in spaces still gets exactly one (or zero) newline.
 *
 * `originalEndsWithNewline` carries the INPUT's own final-newline state so that
 * "no opinion" (insertFinalNewline undefined) truly means "no edit": the state
 * is restored in BOTH directions. This matters specifically on the Prettier
 * path, which unconditionally emits a trailing newline of its own; without the
 * restore, formatting a stylesheet with no final newline would silently add a
 * byte the user never asked for.
 */
export function postProcess(
  text: string,
  resolved: ResolvedOptions,
  originalEndsWithNewline: boolean
): string {
  let result = text;

  if (resolved.trimTrailingWhitespace === true) {
    result = result.replace(TRAILING_WS_PER_LINE, '');
  }

  if (resolved.insertFinalNewline === true) {
    result = result.replace(/[\r\n]+$/, '');
    // Append the DOCUMENT's EOL, never a hard-coded LF.
    const eol =
      resolved.endOfLine === 'crlf'
        ? '\r\n'
        : resolved.endOfLine === 'lf'
          ? '\n'
          : /\r\n/.test(result)
            ? '\r\n'
            : '\n';
    result += eol;
  } else if (resolved.insertFinalNewline === false) {
    result = result.replace(/[\r\n]+$/, '');
  } else {
    // No explicit opinion: restore the input's final-newline state so a format
    // never adds nor removes the file's last byte on its own.
    const hasNewline = /[\r\n]$/.test(result);
    if (originalEndsWithNewline && !hasNewline) {
      result +=
        resolved.endOfLine === 'crlf' || /\r\n/.test(result) ? '\r\n' : '\n';
    } else if (!originalEndsWithNewline && hasNewline) {
      result = result.replace(/[\r\n]+$/, '');
    }
  }

  // Apply EOL last so every newline introduced above gets the right style.
  if (resolved.endOfLine === 'crlf') {
    result = result.replace(EOL_REGEX, '\r\n');
  } else if (resolved.endOfLine === 'lf') {
    result = result.replace(EOL_REGEX, '\n');
  }

  return result;
}
