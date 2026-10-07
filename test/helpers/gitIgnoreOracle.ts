// REAL git as the oracle for gitignore semantics.
//
// The glob matcher used to be checked against a RegExp model written by the same
// hand that wrote the matcher, so the two shared their blind spots (character
// classes, negation under an excluded directory, a BOM, "***", case). The only
// oracle that is not a model of git is git: `git check-ignore` in a throwaway
// repository.
//
// One git process answers MANY cases: each case gets its own sub-directory with
// its own .gitignore (written byte for byte, so a BOM, CRLF or a leading space
// reaches git exactly as authored), and the paths of every case go through a
// single `git check-ignore --no-index -z --stdin`. The paths need not exist: git
// evaluates the parent directories of a path as directories, and the leaf as a
// file (an unknown type), which is exactly how Tidy evaluates a formatted document.
//
// The user's own git configuration must never leak into the verdict (a global
// core.excludesFile would), so the process runs with an empty global config.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** One ignore file and the paths (relative to it) whose verdict is wanted. */
export interface OracleCase {
  /** The exact bytes of the .gitignore (a string is written as UTF-8). */
  readonly ignoreFile: string | Uint8Array;
  readonly paths: readonly string[];
}

/** Whether a usable `git` is on the PATH. */
export function gitAvailable(): boolean {
  try {
    const result = spawnSync('git', ['--version'], { encoding: 'utf8', timeout: 15_000 });
    return result.status === 0;
  } catch {
    return false;
  }
}

/** `git --version` output, for the assertion messages of a failing run. */
export function gitVersion(): string {
  try {
    return execFileSync('git', ['--version'], { encoding: 'utf8', timeout: 15_000 }).trim();
  } catch {
    return 'git unavailable';
  }
}

/**
 * Ask git which paths of each case are ignored. Returns, per case, one boolean per
 * path (same order). `ignoreCase` sets core.ignorecase, which git defaults to true
 * on Windows and macOS.
 */
export function gitCheckIgnore(cases: readonly OracleCase[], ignoreCase: boolean): boolean[][] {
  const root = mkdtempSync(join(tmpdir(), 'tidy-git-oracle-'));
  try {
    const emptyConfig = join(root, 'empty.gitconfig');
    writeFileSync(emptyConfig, '');
    const repo = join(root, 'repo');
    mkdirSync(repo);
    const env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: emptyConfig,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0'
    };
    const git = (args: string[], input?: Buffer): Buffer =>
      execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
        cwd: repo,
        env,
        input,
        maxBuffer: 512 * 1024 * 1024,
        timeout: 240_000
      });

    git(['init', '-q']);
    git(['config', 'core.ignorecase', ignoreCase ? 'true' : 'false']);
    git(['config', 'core.excludesFile', emptyConfig]);

    const stdin: Buffer[] = [];
    cases.forEach((testCase, index) => {
      const dir = join(repo, `c${index}`);
      mkdirSync(dir);
      writeFileSync(join(dir, '.gitignore'), testCase.ignoreFile);
      for (const path of testCase.paths) {
        stdin.push(Buffer.from(`c${index}/${path}\0`, 'utf8'));
      }
    });

    const out = git(['check-ignore', '--no-index', '-z', '--stdin'], Buffer.concat(stdin));
    const ignored = new Set(out.toString('utf8').split('\0').filter((p) => p !== ''));
    return cases.map((testCase, index) =>
      testCase.paths.map((path) => ignored.has(`c${index}/${path}`))
    );
  } catch (error) {
    // `git check-ignore` exits 1 when NOTHING is ignored: execFileSync throws then,
    // but the verdict (nobody ignored) is a valid answer, not a failure.
    const failure = error as { status?: number; stdout?: Buffer };
    if (failure.status === 1 && failure.stdout !== undefined) {
      const ignored = new Set(
        failure.stdout
          .toString('utf8')
          .split('\0')
          .filter((p) => p !== '')
      );
      return cases.map((testCase, index) =>
        testCase.paths.map((path) => ignored.has(`c${index}/${path}`))
      );
    }
    throw error;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** The verdict of git for ONE ignore file and ONE path. */
export function gitIgnores(ignoreFile: string | Uint8Array, path: string, ignoreCase = false): boolean {
  return gitCheckIgnore([{ ignoreFile, paths: [path] }], ignoreCase)[0][0];
}
