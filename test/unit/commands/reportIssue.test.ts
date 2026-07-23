// Unit tests for the PURE part of the "Report an Issue" command.
//
// These import ONLY the pure URL builder + helpers — never the VS Code handler —
// so they run under plain mocha+tsx with no Electron host. The module is written
// with NO top-level 'vscode' import (it requires 'vscode' lazily inside the
// handler), so importing it here does not pull in 'vscode'. A regression that
// re-introduces a top-level 'vscode' import would make this very file fail to
// load — which is the point.
import assert from 'node:assert/strict';
import {
  REPORT_ISSUE_COMMAND_ID,
  buildIssueUrl,
  platformLabel,
  type IssueEnv
} from '../../../src/commands/reportIssue';

const FULL_ENV: IssueEnv = {
  extensionVersion: '0.1.4',
  vscodeVersion: '1.90.0',
  platform: 'win32',
  languageId: 'typescriptreact'
};

describe('commands/reportIssue — pure URL builder', () => {
  it('exposes the stable command id', () => {
    assert.equal(REPORT_ISSUE_COMMAND_ID, 'tidy.reportIssue');
  });

  it('targets the repo new-issue endpoint', () => {
    const url = buildIssueUrl(FULL_ENV);
    assert.ok(
      url.startsWith(
        'https://github.com/ced-lab-gh/tidy-formatter/issues/new?'
      ),
      `unexpected base: ${url}`
    );
  });

  it('produces a valid, parseable URL', () => {
    const url = new URL(buildIssueUrl(FULL_ENV));
    assert.equal(url.hostname, 'github.com');
    assert.equal(url.pathname, '/ced-lab-gh/tidy-formatter/issues/new');
  });

  it('carries title + labels query params', () => {
    const params = new URL(buildIssueUrl(FULL_ENV)).searchParams;
    assert.equal(params.get('labels'), 'bug');
    assert.ok(params.get('title')?.startsWith('[bug]'));
  });

  it('embeds every environment field in the decoded body', () => {
    const body = new URL(buildIssueUrl(FULL_ENV)).searchParams.get('body') ?? '';
    assert.match(body, /Tidy Formatter: 0\.1\.4/);
    assert.match(body, /VS Code: 1\.90\.0/);
    assert.match(body, /OS: Windows/);
    assert.match(body, /Active language: typescriptreact/);
  });

  it('scaffolds the report sections', () => {
    const body = new URL(buildIssueUrl(FULL_ENV)).searchParams.get('body') ?? '';
    assert.match(body, /### What happened/);
    assert.match(body, /### Minimal input to reproduce/);
    assert.match(body, /### Environment/);
  });

  it('degrades gracefully when fields are missing', () => {
    const body = new URL(buildIssueUrl({})).searchParams.get('body') ?? '';
    assert.match(body, /Tidy Formatter: unknown/);
    assert.match(body, /VS Code: unknown/);
    assert.match(body, /OS: unknown/);
    assert.match(body, /Active language: n\/a/);
  });

  it('does not leak raw newlines/spaces into the query string (encoded once)', () => {
    const raw = buildIssueUrl(FULL_ENV).split('?')[1] ?? '';
    // A correctly-encoded query never contains a literal space or newline.
    assert.ok(!/[\s]/.test(raw), 'query string must be URL-encoded');
  });
});

describe('commands/reportIssue — platformLabel', () => {
  it('maps the three known platforms', () => {
    assert.equal(platformLabel('win32'), 'Windows');
    assert.equal(platformLabel('darwin'), 'macOS');
    assert.equal(platformLabel('linux'), 'Linux');
  });

  it('passes unknown platforms through unchanged', () => {
    assert.equal(platformLabel('freebsd'), 'freebsd');
  });

  it('falls back to "unknown" for empty/undefined', () => {
    assert.equal(platformLabel(undefined), 'unknown');
    assert.equal(platformLabel(''), 'unknown');
  });
});
