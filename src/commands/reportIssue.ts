// Command: "Tidy: Report an Issue".
// Opens a prefilled GitHub "new issue" page for this repo with the environment
// details a good bug report needs (extension + VS Code version, OS, and the
// active document's languageId) already filled in — the actionable counterpart
// to the README's "a reproducible input is worth a thousand stars". It only ever
// READS host state and opens an external URL: it writes no file and changes no
// setting, so it carries none of the anti-hijack risk of the onboarding commands.
//
// Split of concerns (mirrors commands/showConfig.ts): this module's TOP LEVEL
// imports NO 'vscode'. The pure URL builder takes a plain IssueEnv and is covered
// by a plain mocha+tsx test; the thin 'vscode' surface (active editor, version,
// env.openExternal) is required lazily INSIDE the handler, which only ever runs
// inside the extension host. A regression that re-introduces a top-level 'vscode'
// import would make the pure test fail to load — which is the point.

export const REPORT_ISSUE_COMMAND_ID = 'tidy.reportIssue';

/** The repository's "new issue" endpoint. Kept local so this module is self-contained. */
const ISSUES_NEW_URL = 'https://github.com/ced-lab-gh/tidy-formatter/issues/new';

/**
 * Plain, `vscode`-free description of the environment a bug report should carry.
 * Every field is optional so the builder degrades gracefully when the host cannot
 * supply one (for example, no active editor => no languageId).
 */
export interface IssueEnv {
  readonly extensionVersion?: string;
  readonly vscodeVersion?: string;
  readonly platform?: string;
  readonly languageId?: string;
}

/**
 * Map a raw `process.platform` value to a human label. Unknown values pass
 * through unchanged so we never hide what the reporter is actually running on.
 */
export function platformLabel(platform?: string): string {
  switch (platform) {
    case 'win32':
      return 'Windows';
    case 'darwin':
      return 'macOS';
    case 'linux':
      return 'Linux';
    default:
      return platform && platform.length > 0 ? platform : 'unknown';
  }
}

/**
 * Build the prefilled GitHub "new issue" URL. Pure: no 'vscode', no I/O. The body
 * carries an environment block plus empty "what happened / reproduce / expected"
 * scaffolding, so the reporter only has to paste a snippet. Every field is
 * URL-encoded exactly once via URLSearchParams.
 */
export function buildIssueUrl(env: IssueEnv): string {
  const body = [
    '<!-- Thanks for reporting! A minimal, reproducible snippet is worth a thousand stars. -->',
    '',
    '### What happened',
    '',
    '',
    '### Minimal input to reproduce',
    '',
    '```',
    '',
    '```',
    '',
    '### Expected vs. actual',
    '',
    '',
    '### Environment',
    '',
    `- Tidy Formatter: ${env.extensionVersion ?? 'unknown'}`,
    `- VS Code: ${env.vscodeVersion ?? 'unknown'}`,
    `- OS: ${platformLabel(env.platform)}`,
    `- Active language: ${env.languageId ?? 'n/a'}`,
    ''
  ].join('\n');

  const params = new URLSearchParams({
    title: '[bug] ',
    labels: 'bug',
    body
  });
  return `${ISSUES_NEW_URL}?${params.toString()}`;
}

/**
 * Command handler. Gathers the environment from the extension host and opens the
 * prefilled issue page in the user's browser. Read-only with respect to the
 * workspace: it opens an external URL and does nothing else. Never throws in a way
 * that reaches the user — any failure is reported as a non-blocking message.
 */
export async function reportIssue(): Promise<void> {
  const vscode = require('vscode');
  try {
    const extension = vscode.extensions.getExtension('ced-lab.tidy-formatter');
    const version = extension?.packageJSON?.version;
    const env: IssueEnv = {
      extensionVersion: typeof version === 'string' ? version : undefined,
      vscodeVersion: vscode.version,
      platform: process.platform,
      languageId: vscode.window.activeTextEditor?.document.languageId
    };
    await vscode.env.openExternal(vscode.Uri.parse(buildIssueUrl(env)));
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : 'unknown error';
    void vscode.window.showWarningMessage(
      `Tidy: could not open the issue page (${detail}). ` +
        'You can file one manually at github.com/ced-lab-gh/tidy-formatter/issues.'
    );
  }
}
