// Records the outcome of the MOST RECENT Tidy format attempt on any document, so
// the "Tidy: Explain last format" command can tell the user exactly what happened
// and, crucially, WHY nothing changed. This is the antidote to the "safe but does
// nothing" confusion: every no-op has a reason, and this makes it visible.
//
// vscode-free by design: the formatting provider (which is vscode-bound) writes a
// plain record here; the command reads it and renders an explanation. Both the
// store and the channel-line formatter are covered by plain mocha+tsx tests.

/**
 * The distinct outcomes of a Tidy format attempt. Each maps 1:1 to an exit point in
 * the formatting provider, so the explanation builder can switch exhaustively.
 */
export type FormatStatus =
  | 'applied' // edits were applied
  | 'already-tidy' // engine ran; output identical to input (nothing to change)
  | 'guard-rejected' // output not provably equivalent to input, discarded, file intact
  | 'engine-error' // the formatting engine (or guard) threw
  | 'restore-failed' // an in-source ignore region could not be restored verbatim
  | 'config-error' // options could not be resolved
  | 'too-large' // document exceeds tidy.maxFileSizeKB
  | 'ignored-file' // excluded by a .soukformatignore rule
  | 'ignored-marker' // a top-of-file tidy-ignore / prettier-ignore marker
  | 'disabled' // tidy.<lang>.enable is false
  | 'unsupported' // a languageId Tidy does not handle
  | 'cancelled'; // the format was cancelled before finishing

/** Whether the attempt was a whole-document format or a selection (range) format. */
export type FormatScope = 'document' | 'selection';

/**
 * A plain, vscode-free snapshot of one format attempt. `detail` carries the
 * status-specific specifics (guard reason, error message, the KB limit, ...); by
 * contract it never contains any document content.
 */
export interface LastFormatRecord {
  readonly uri: string;
  readonly fileName: string;
  readonly languageId: string;
  readonly status: FormatStatus;
  readonly scope: FormatScope;
  readonly engineId?: string;
  readonly detail?: string;
  readonly at: string; // ISO 8601 timestamp
}

/**
 * Guarantee a `detail` is safe to STORE, LOG and DISPLAY: single-line and bounded.
 * This is the last line of defence for the content-free contract: engine/parser
 * errors (e.g. Prettier) can embed a multi-line code frame containing the user's
 * SOURCE, so we keep only the first line and cap the length. Pure.
 */
export function sanitizeDetail(detail: string): string {
  const oneLine = detail.split('\n', 1)[0].trim();
  return oneLine.length > 200 ? `${oneLine.slice(0, 197)}...` : oneLine;
}

// Single-slot store: we only ever care about the MOST RECENT attempt. Module state
// is the right shape for a per-session singleton; it resets when the host reloads.
let lastRecord: LastFormatRecord | undefined;

/**
 * Record the most recent format attempt (overwrites any previous record). Any
 * `detail` is sanitized here too, so no caller can ever persist multi-line content.
 */
export function recordLastFormat(record: LastFormatRecord): void {
  lastRecord =
    record.detail !== undefined
      ? { ...record, detail: sanitizeDetail(record.detail) }
      : record;
}

/** The most recent format attempt, or undefined if none has run this session. */
export function getLastFormat(): LastFormatRecord | undefined {
  return lastRecord;
}

/** Clear the stored record. Primarily for tests. */
export function clearLastFormat(): void {
  lastRecord = undefined;
}

/**
 * A concise, single-line channel entry for a record. Pure and content-free: only
 * timestamp, file name, language, engine, status and a short detail. Never uses an
 * em dash.
 */
export function formatChannelLine(record: LastFormatRecord): string {
  const engine = record.engineId ? ` [${record.engineId}]` : '';
  const scope = record.scope === 'selection' ? ' (selection)' : '';
  const detail = record.detail ? `: ${record.detail}` : '';
  return `[${record.at}] ${record.fileName} [${record.languageId}]${engine} ${record.status}${scope}${detail}`;
}
