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

/** Stateless (no /g): safe to share across calls. */
const HAS_CRLF = /\r\n/;
/** Any CR. Only ever consulted AFTER HAS_CRLF said no, so a match means BARE CR. */
const HAS_CR = /\r/;

/**
 * The line ending to APPEND to `text`: what the user explicitly asked for, and
 * otherwise the one the text already uses.
 *
 * The third answer is the one that was missing. Bare-CR (classic Mac) documents
 * still turn up, and NOTHING in this pipeline normalises them: with `files.eol`
 * unset or "auto" the EOL pass at the end of postProcess is a no-op, so such a
 * document keeps its CRs from end to end. Deciding the terminator from
 * `/\r\n/` alone therefore answered LF for them and glued a lone LF onto a
 * CR-only file. That is exactly defect C-04's shape : a whitespace-only
 * difference, so the guard says "equivalent" and the MIXED result is WRITTEN.
 * Asking CRLF first and bare CR second makes the appended byte match the
 * document in all three styles.
 */
function terminatorFor(
  text: string,
  endOfLine: ResolvedOptions['endOfLine']
): string {
  if (endOfLine === 'crlf') return '\r\n';
  if (endOfLine === 'lf') return '\n';
  if (HAS_CRLF.test(text)) return '\r\n';
  if (HAS_CR.test(text)) return '\r';
  return '\n';
}

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
    // Append the DOCUMENT's own EOL, never a hard-coded LF, and never an LF for
    // a bare-CR document either (terminatorFor).
    result += terminatorFor(result, resolved.endOfLine);
  } else if (resolved.insertFinalNewline === false) {
    result = result.replace(/[\r\n]+$/, '');
  } else {
    // No explicit opinion: restore the input's final-newline state so a format
    // never adds nor removes the file's last byte on its own.
    const hasNewline = /[\r\n]$/.test(result);
    if (originalEndsWithNewline && !hasNewline) {
      result += terminatorFor(result, resolved.endOfLine);
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
