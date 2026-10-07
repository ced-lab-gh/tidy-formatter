// Headless integration test of "Tidy: Migrate from JS-CSS-HTML Formatter" in a REAL
// VS Code host (v0.5.0, MIGRATION). The unit suites drive the host flow through a
// mock `vscode`; this is the proof against the real thing: the real
// `workspace.fs` reads of `.vscode/formatter.json`, the real modal, and the real
// language-scoped `tidy.*` writes to the workspace settings.
//
// The defect it guards: on the incumbent's REAL config shape the migration
// imported NOTHING (probe P3(b), reproduced in 1.137.0 and 1.126.0).
//
// Method (the one of the audit probes, _internal/audit-v050/09-sondes-hote.md):
// the test and the extension share one `vscode` module instance, so replacing
// `showInformationMessage` / `showErrorMessage` with recorders that answer a scripted
// choice lets the command run headless. Every answer is explicit: a dialog nobody
// answers cannot write anything. The incumbent is not installed in this hermetic
// host (`--disable-extensions`), which is also what the closing-message assertion
// relies on.
//
// Every Workspace-scoped key and file this suite creates is removed in afterEach.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { activateExtension, flushEventLoop, workspaceRoot } from './helpers';
import { LONEFY_KEYS } from '../../src/migration/lonefyKeys';
import {
  LONEFY_DEFAULT_FORMATTER_JSON,
  LONEFY_DEFAULT_WRITES
} from '../unit/migration/lonefyFixtures';

const CONFIRM = 'Import settings';
// The five languages the incumbent formatted (css also SCSS, javascript also JSON).
const LANGS = ['css', 'scss', 'html', 'javascript', 'json'] as const;
// Every key the migration can write, so cleanup cannot miss one.
const KEYS = Object.values(LONEFY_KEYS).map((spec) => spec.tidyKey.slice('tidy.'.length));

/** A real-shaped incumbent config whose values differ from Tidy's defaults. */
const FORMATTER_JSON = JSON.stringify(
  {
    onSave: true,
    javascript: { indent_size: 3, brace_style: 'expand', eol: 'auto', e4x: false },
    css: { indent_size: 2, indentCharacter: ' ' },
    html: { indent_size: 6 }
  },
  undefined,
  2
);

interface Shown {
  readonly kind: 'info' | 'error';
  readonly message: string;
  readonly modal: boolean;
  readonly detail: string;
}

/** The language-scoped Workspace value of a tidy.* key, the exact slot we write. */
function workspaceLanguageValue(language: string, key: string): unknown {
  return vscode.workspace
    .getConfiguration('tidy', { languageId: language })
    .inspect(key)?.workspaceLanguageValue;
}

function formatOnSaveSlots(language: string): unknown {
  const info = vscode.workspace
    .getConfiguration('editor', { languageId: language })
    .inspect('formatOnSave');
  return {
    globalValue: info?.globalValue,
    workspaceValue: info?.workspaceValue,
    workspaceLanguageValue: info?.workspaceLanguageValue,
    globalLanguageValue: info?.globalLanguageValue
  };
}

describe('Tidy migration (MIGRATION v0.5.0) : the real lonefy config shape, in a real host', function () {
  this.timeout(process.env.CI ? 180000 : 30000);

  const configPath = (): string => path.join(workspaceRoot(), '.vscode', 'formatter.json');
  let shown: Shown[] = [];
  let valuesSeenByModal: unknown[] = [];
  let restoreDialogs: (() => void) | undefined;
  let existedBefore = false;

  /** Replace the two notification functions with recorders answering `modalChoice`. */
  function scriptDialogs(modalChoice: string | undefined): void {
    const windowApi = vscode.window as unknown as Record<string, unknown>;
    const originalInfo = windowApi.showInformationMessage;
    const originalError = windowApi.showErrorMessage;
    windowApi.showInformationMessage = (message: string, ...rest: unknown[]) => {
      const options =
        typeof rest[0] === 'object' && rest[0] !== null
          ? (rest[0] as { modal?: boolean; detail?: string })
          : undefined;
      shown.push({ kind: 'info', message, modal: options?.modal === true, detail: options?.detail ?? '' });
      if (options?.modal) {
        // What is in the settings at the instant the user is asked to confirm?
        valuesSeenByModal = LANGS.map((language) => workspaceLanguageValue(language, 'indent'));
        return Promise.resolve(modalChoice);
      }
      return Promise.resolve('Not now'); // the formatter offer: decline it.
    };
    windowApi.showErrorMessage = (message: string) => {
      shown.push({ kind: 'error', message, modal: false, detail: '' });
      return Promise.resolve(undefined);
    };
    restoreDialogs = () => {
      windowApi.showInformationMessage = originalInfo;
      windowApi.showErrorMessage = originalError;
    };
  }

  before(async () => {
    await activateExtension();
  });

  beforeEach(() => {
    shown = [];
    valuesSeenByModal = [];
    existedBefore = fs.existsSync(configPath());
    assert.equal(existedBefore, false, 'precondition: no .vscode/formatter.json in the fixture workspace');
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  });

  afterEach(async () => {
    restoreDialogs?.();
    restoreDialogs = undefined;
    fs.rmSync(configPath(), { force: true });
    for (const language of LANGS) {
      const config = vscode.workspace.getConfiguration('tidy', { languageId: language });
      for (const key of KEYS) {
        await config.update(key, undefined, vscode.ConfigurationTarget.Workspace, true);
      }
    }
    await flushEventLoop();
  });

  it('imports the per-language sections as [language] overrides, after confirmation only', async () => {
    fs.writeFileSync(configPath(), FORMATTER_JSON, 'utf8');
    scriptDialogs(CONFIRM);

    await vscode.commands.executeCommand('tidy.runMigration');
    await flushEventLoop();

    // The recap named the source and every exact key, in a MODAL.
    const modal = shown.find((entry) => entry.modal);
    assert.ok(modal, 'a modal recap must be shown');
    for (const line of [
      '  "[javascript]": { "tidy.indent": 3 }',
      '  "[javascript]": { "tidy.brace_style": "expand" }',
      '  "[json]": { "tidy.indent": 3 }',
      '  "[css]": { "tidy.indent": 2 }',
      '  "[scss]": { "tidy.indent": 2 }',
      '  "[html]": { "tidy.indent": 6 }'
    ]) {
      assert.ok(modal.detail.includes(line), `recap must list ${line}\n${modal.detail}`);
    }
    assert.ok(modal.detail.includes('.vscode/formatter.json'), modal.detail);
    assert.ok(modal.detail.includes('at the Workspace scope'), modal.detail);
    assert.ok(
      modal.detail.includes('not migrated: Tidy never enables Format On Save for you'),
      'onSave is reported, not proposed'
    );

    // NOTHING was written when the user was asked.
    assert.deepEqual(valuesSeenByModal, LANGS.map(() => undefined));

    // After confirmation, the real settings hold exactly the recap.
    assert.equal(workspaceLanguageValue('javascript', 'indent'), 3);
    assert.equal(workspaceLanguageValue('javascript', 'brace_style'), 'expand');
    assert.equal(workspaceLanguageValue('json', 'indent'), 3, 'the incumbent formatted JSON with this section');
    assert.equal(workspaceLanguageValue('css', 'indent'), 2);
    assert.equal(workspaceLanguageValue('scss', 'indent'), 2, 'the incumbent formatted SCSS with the css section');
    assert.equal(workspaceLanguageValue('html', 'indent'), 6);
    for (const key of KEYS) {
      assert.equal(workspaceLanguageValue('less', key), undefined, 'LESS was never formatted by the incumbent');
      assert.equal(workspaceLanguageValue('jsonc', key), undefined, 'nor JSONC');
    }

    // The keys it did not carry over were reported, and onSave never became a setting.
    assert.ok(modal.detail.includes('javascript.eol'), 'unmapped keys are surfaced');
    assert.ok(shown.some((entry) => entry.message.startsWith('Tidy imported 6 settings')), 'a success toast');

    // Probe P3 showed the "cannot disable" advice even with no incumbent installed.
    assert.ok(
      !shown.some((entry) => entry.message.includes('Tidy cannot disable')),
      'the incumbent is not installed here, so its disable advice must not appear'
    );
  });

  it('the incumbent DEFAULT formatter.json: every proposed key lands in the real [language] settings', async () => {
    fs.writeFileSync(configPath(), LONEFY_DEFAULT_FORMATTER_JSON, 'utf8');
    scriptDialogs(CONFIRM);

    await vscode.commands.executeCommand('tidy.runMigration');
    await flushEventLoop();

    const modal = shown.find((entry) => entry.modal);
    assert.ok(modal, 'a modal recap must be shown');
    for (const fixtureLine of LONEFY_DEFAULT_WRITES) {
      const match = /^\[(\w+)\] tidy\.(\w+) = (.*)$/.exec(fixtureLine);
      assert.ok(match, fixtureLine);
      const [, language, key, json] = match;
      const expected: unknown = JSON.parse(json);
      assert.ok(
        modal.detail.includes(`  "[${language}]": { "tidy.${key}": ${json} }`),
        `the recap must list ${fixtureLine}`
      );
      assert.deepEqual(
        workspaceLanguageValue(language, key),
        expected,
        `[${language}] tidy.${key} must be written exactly as listed`
      );
    }
    assert.ok(
      shown.some((entry) => entry.message.startsWith(`Tidy imported ${LONEFY_DEFAULT_WRITES.length} settings`)),
      'the success toast counts every write'
    );
  });

  it('CANCELLING the modal writes nothing and never touches editor.formatOnSave', async () => {
    fs.writeFileSync(configPath(), FORMATTER_JSON, 'utf8');
    const before = LANGS.map(formatOnSaveSlots);
    scriptDialogs(undefined);

    await vscode.commands.executeCommand('tidy.runMigration');
    await flushEventLoop();

    for (const language of LANGS) {
      for (const key of KEYS) {
        assert.equal(workspaceLanguageValue(language, key), undefined, `${language} ${key}`);
      }
    }
    assert.deepEqual(LANGS.map(formatOnSaveSlots), before, 'editor.formatOnSave is byte-identical');
    assert.equal(shown.length, 1, 'only the modal was shown: a cancel stops the flow');
  });

  it('CONFIRMING never touches editor.formatOnSave either, although onSave is in the file', async () => {
    fs.writeFileSync(configPath(), FORMATTER_JSON, 'utf8');
    const before = LANGS.map(formatOnSaveSlots);
    scriptDialogs(CONFIRM);

    await vscode.commands.executeCommand('tidy.runMigration');
    await flushEventLoop();

    assert.equal(workspaceLanguageValue('css', 'indent'), 2, 'non-vacuous: the import did write');
    assert.deepEqual(LANGS.map(formatOnSaveSlots), before, 'onSave is never turned into formatOnSave');
  });

  it('a malformed .vscode/formatter.json is reported and writes nothing', async () => {
    fs.writeFileSync(configPath(), '{ "onSave": true, "css": ', 'utf8');
    scriptDialogs(CONFIRM);

    await vscode.commands.executeCommand('tidy.runMigration');
    await flushEventLoop();

    assert.ok(!shown.some((entry) => entry.modal), 'nothing to confirm, so no modal');
    assert.ok(
      shown.some((entry) => entry.message.includes('could not use it')),
      JSON.stringify(shown.map((entry) => entry.message))
    );
    for (const language of LANGS) {
      assert.equal(workspaceLanguageValue(language, 'indent'), undefined);
    }
  });
});
