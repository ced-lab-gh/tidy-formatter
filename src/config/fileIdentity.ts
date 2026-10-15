// File identity and the rule that decides when it can be trusted, shared by the
// two memos that avoid re-reading a project file on every format (.soukformatrc
// and .soukformatignore). PURE: node:fs only, no 'vscode'.
import { statSync } from 'node:fs';

/**
 * A file modified (mtime or ctime) less than this long before it was read is NOT
 * memoised. Two writes inside one timestamp tick can leave the identity
 * unchanged, so a fresh file could otherwise be served stale; waiting until it has
 * settled (the same idea as git's "racily clean" entries) closes that window.
 */
const RACY_WINDOW_MS = 2000;

/**
 * What identifies the CONTENT GENERATION of a file, taken from one stat in
 * nanoseconds (bigint): a rewrite that keeps the size and even the mtime
 * (cp -p, rsync -t, unzip, touch -r, a copy on Windows) still changes the ctime,
 * and replacing the file changes its inode, so none of them can be mistaken for
 * the file that was memoised.
 */
export interface FileIdentity {
  readonly size: number;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly ino: bigint;
  readonly dev: bigint;
}

/**
 * Stat a candidate ONCE: it answers "is it a regular file" and, for the file
 * that wins, hands its identity on to the cap and the memo so neither needs a
 * second syscall. Stat errors are fail-soft (no such file).
 */
export function statFileIdentity(candidate: string): FileIdentity | undefined {
  try {
    const stats = statSync(candidate, { throwIfNoEntry: false, bigint: true });
    if (stats?.isFile() !== true) {
      return undefined;
    }
    return {
      size: Number(stats.size),
      mtimeNs: stats.mtimeNs,
      ctimeNs: stats.ctimeNs,
      ino: stats.ino,
      dev: stats.dev
    };
  } catch {
    return undefined;
  }
}

export function sameIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return (
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs &&
    a.ino === b.ino &&
    a.dev === b.dev
  );
}

const NANOSECONDS_PER_SECOND = 1_000_000_000n;
const NANOSECONDS_PER_MILLISECOND = 1_000_000n;

/**
 * Whether this platform and this file let us PROVE that an unchanged identity
 * means unchanged content. If not, the answer is no and the file is simply read
 * again: a stale file is never served.
 *
 *   - the file system must identify files (a non-zero inode);
 *   - its timestamps must be finer than a second: a whole-second mtime or ctime
 *     means a coarse clock (FAT, HFS+, SMB1, NFS), where two writes of the same
 *     size inside one second are indistinguishable;
 *   - the file must have SETTLED: neither timestamp is within RACY_WINDOW_MS of
 *     the local clock (or in its future), so a rewrite inside the same timestamp
 *     tick cannot hide behind the identity already stored.
 */
export function canProveFreshness(identity: FileIdentity, nowMs: number): boolean {
  if (identity.ino === 0n) {
    return false;
  }
  if (
    identity.mtimeNs % NANOSECONDS_PER_SECOND === 0n ||
    identity.ctimeNs % NANOSECONDS_PER_SECOND === 0n
  ) {
    return false;
  }
  const newestMs = Number(
    (identity.mtimeNs > identity.ctimeNs ? identity.mtimeNs : identity.ctimeNs) /
      NANOSECONDS_PER_MILLISECOND
  );
  return nowMs - newestMs > RACY_WINDOW_MS;
}
