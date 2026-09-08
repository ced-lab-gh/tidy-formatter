// Records the outcome of EVERY Tidy format attempt this session in a bounded,
// immutable ring buffer, so "Tidy: Explain Last Format" can explain the ACTIVE
// file exactly (per-file lookup) and "Tidy: Show Format History" can show the
// chronological view. This is the antidote to the "safe but does nothing"
// confusion: every no-op has a reason, and this makes it visible, per file,
// over time. In-memory only: nothing is persisted, nothing leaves the host.
//
// vscode-free by design: the formatting provider (which is vscode-bound) writes a
// plain record here; the commands read it and render an explanation. Both the
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

/**
 * Maximum number of attempts kept in the session history. Oldest entries are
 * evicted first (FIFO). 50 records of ~200 bytes bound the store to ~10 KB of
 * RAM regardless of session length. Exported so tests and the history command
 * share the same truth. Deliberately a constant and NOT a setting: no config
 * surface is added for a session diagnostic.
 */
export const HISTORY_LIMIT = 50;

// Bounded, immutable session store (ADD-14), replacing the former single slot:
//   - `history`     : chronological list of attempts, OLDEST FIRST, length <=
//                     HISTORY_LIMIT;
//   - `latestByUri` : derived index "most recent record per uri", rebuilt from
//                     `history` on every write so the two can never drift and
//                     the map stays bounded by the same window.
// Both are REPLACED (never mutated) on each write; stored records and returned
// arrays are frozen, so no consumer can mutate the store from outside. Module
// state is the right shape for a per-session singleton; it resets when the host
// reloads. Nothing is persisted (no globalState, no file) and nothing is sent.
let history: readonly LastFormatRecord[] = Object.freeze([]);
let latestByUri: ReadonlyMap<string, LastFormatRecord> = new Map();

/** Rebuild the per-uri index from a chronological (oldest-first) history. */
function buildLatestByUri(
  records: readonly LastFormatRecord[]
): ReadonlyMap<string, LastFormatRecord> {
  const index = new Map<string, LastFormatRecord>();
  for (const record of records) {
    index.set(record.uri, record); // later = newer: overwrites older entries
  }
  return index;
}

/**
 * Optional observer notified with the SANITIZED record after each write. This
 * is how the status bar (ADD-05) receives its transient feedback WITHOUT the
 * provider knowing about it: recordLastFormat only ever runs inside a provider
 * call, so the observer inherits exactly that trigger surface and no other.
 * Single slot on purpose: the ADD-14 history command does not subscribe (it
 * reads getHistory() on demand), so one consumer is still enough; if a second
 * PUSH consumer ever appears, upgrade this to a small listener array.
 */
export type LastFormatListener = (record: LastFormatRecord) => void;

let listener: LastFormatListener | undefined;

/** Install (or clear, with undefined) the single record observer. */
export function setLastFormatListener(
  next: LastFormatListener | undefined
): void {
  listener = next;
}

/**
 * Record a format attempt. Appends to the bounded history (FIFO eviction past
 * HISTORY_LIMIT), refreshes the per-uri index, then notifies the observer. The
 * record is defensively cloned and any `detail` is sanitized here too, so no
 * caller can ever persist multi-line content, and no caller (nor observer) can
 * mutate a stored record afterwards.
 */
export function recordLastFormat(record: LastFormatRecord): void {
  const stored: LastFormatRecord = Object.freeze(
    record.detail !== undefined
      ? { ...record, detail: sanitizeDetail(record.detail) }
      : { ...record }
  );
  const appended = [...history, stored];
  history = Object.freeze(
    appended.length > HISTORY_LIMIT
      ? appended.slice(appended.length - HISTORY_LIMIT)
      : appended
  );
  latestByUri = buildLatestByUri(history);
  if (listener !== undefined) {
    try {
      listener(stored);
    } catch {
      // An observer failure must NEVER break a format attempt: the record is
      // already stored, the observer just misses one repaint.
    }
  }
}

/**
 * The most recent format attempt on ANY document, or undefined if none has run
 * this session. Kept with its historical semantics for existing consumers
 * (the ADD-05 status bar transient and the existing unit tests): it equals
 * getHistory()[0].
 */
export function getLastFormat(): LastFormatRecord | undefined {
  return history.length > 0 ? history[history.length - 1] : undefined;
}

/**
 * The most recent format attempt on the document whose `Uri.toString()` equals
 * `uri`, or undefined when the file was never formatted this session OR its
 * only records were evicted from the bounded window. Both honestly mean the
 * same thing: no explainable attempt is retained for this file.
 */
export function getLastFormatFor(uri: string): LastFormatRecord | undefined {
  return latestByUri.get(uri);
}

/**
 * Every attempt retained in the session window, NEWEST FIRST (index 0 is the
 * most recent), ready for a chronological QuickPick. Returns a fresh frozen
 * array on each call: mutating the result can never touch the store.
 */
export function getHistory(): readonly LastFormatRecord[] {
  return Object.freeze([...history].reverse());
}

/** Clear the history and the per-uri index. Primarily for tests. */
export function clearLastFormat(): void {
  history = Object.freeze([]);
  latestByUri = new Map();
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
