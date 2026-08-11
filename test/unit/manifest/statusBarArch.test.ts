// ARCH-01 extension for the status bar (ADD-05), plus the ADD-04 consent
// contract at the manifest level. PURE (no 'vscode'): we read package.json and
// the relevant sources from disk and lock the invariants a careless edit could
// break: a new activation event, a palette entry for the click menu, a write or
// format call slipping into the status bar host, or a save hook anywhere in the
// two features of this lot.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../../..');

// Never the raw character in sources: the repo forbids U+2014 in shipped text.
const EM_DASH = String.fromCharCode(0x2014);

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

interface Manifest {
  activationEvents: string[];
  contributes: {
    commands: { command: string }[];
    configuration: { properties: Record<string, Record<string, unknown>> }[];
  };
}

const manifest = JSON.parse(read('package.json')) as Manifest;

function findProperty(id: string): Record<string, unknown> | undefined {
  for (const section of manifest.contributes.configuration) {
    if (section.properties[id]) {
      return section.properties[id];
    }
  }
  return undefined;
}

describe('manifest : status bar contribution (ADD-05, ARCH-01 extension)', () => {
  it('declares tidy.statusBar.enable as boolean, default true', () => {
    const prop = findProperty('tidy.statusBar.enable');
    assert.ok(prop, 'tidy.statusBar.enable must be declared');
    assert.equal(prop!.type, 'boolean');
    assert.equal(prop!.default, true);
    assert.ok(String(prop!.description).length > 0);
    assert.ok(!String(prop!.description).includes(EM_DASH), 'no em dash');
  });

  it('adds NO new activation event: every event is onLanguage:*', () => {
    for (const ev of manifest.activationEvents) {
      assert.match(ev, /^onLanguage:/, `unexpected activation event ${ev}`);
    }
  });

  it('does NOT contribute tidy.statusBarMenu to the palette (runtime-only)', () => {
    const ids = manifest.contributes.commands.map((c) => c.command);
    assert.ok(
      !ids.includes('tidy.statusBarMenu'),
      'the click menu is deliberately not a palette entry'
    );
  });
});

describe('source invariants : statusBarHost is read-only (ARCH-01/02)', () => {
  const host = read('src/diagnostics/statusBarHost.ts');

  const FORBIDDEN: readonly string[] = [
    'onDidSaveTextDocument',
    'onWillSaveTextDocument',
    'onDidChangeTextDocument',
    'applyEdit',
    '.update(',
    'dispatchFormat',
    'executeCommand',
    'registerTextDocumentContentProvider'
  ];
  for (const needle of FORBIDDEN) {
    it(`statusBarHost.ts never references ${needle}`, () => {
      assert.ok(
        !host.includes(needle),
        `forbidden API in statusBarHost: ${needle}`
      );
    });
  }

  it('the pure statusBar module imports no vscode', () => {
    const pure = read('src/diagnostics/statusBar.ts');
    assert.ok(!/from 'vscode'|require\('vscode'\)/.test(pure));
  });

  it('the pure statusBarMenu module imports no vscode at top level', () => {
    const menu = read('src/commands/statusBarMenu.ts');
    assert.ok(!/^import .*'vscode'/m.test(menu));
  });

  it('the host only listens to active-editor and configuration changes', () => {
    assert.ok(host.includes('onDidChangeActiveTextEditor'));
    assert.ok(host.includes('onDidChangeConfiguration'));
  });
});

describe('source invariants : the format-on-save opt-in stays consent-first (ADD-04)', () => {
  const optIn = read('src/commands/formatOnSaveOptIn.ts');

  it('installs no save/change hook of any kind', () => {
    for (const needle of [
      'onDidSaveTextDocument',
      'onWillSaveTextDocument',
      'onDidChangeTextDocument',
      'onDidChangeActiveTextEditor'
    ]) {
      assert.ok(!optIn.includes(needle), `forbidden hook: ${needle}`);
    }
  });

  it('writes only editor.formatOnSave, never editor.defaultFormatter', () => {
    assert.ok(optIn.includes("update('formatOnSave'"));
    assert.ok(!optIn.includes("update('defaultFormatter'"));
  });

  it('asks for an explicit modal confirmation before any write', () => {
    assert.ok(optIn.includes('modal: true'));
    assert.ok(optIn.includes('formatOnSaveRecapDetail(plan)'));
  });

  it('never surfaces a raw error.message (the code-frame leak)', () => {
    const lines = optIn.split('\n');
    lines.forEach((line, index) => {
      if (!line.includes('error.message')) {
        return;
      }
      assert.ok(
        line.includes('sanitizeDetail(error.message)'),
        `formatOnSaveOptIn.ts:${index + 1} surfaces a raw error.message`
      );
    });
  });

  it('carries no em dash', () => {
    assert.ok(!optIn.includes(EM_DASH));
  });
});

describe('source invariants : extension.ts registers the status bar once', () => {
  const source = read('src/extension.ts');

  it('pushes exactly one createTidyStatusBar() disposable', () => {
    const matches = source.match(/createTidyStatusBar\(\)/g) ?? [];
    assert.equal(matches.length, 1, 'a single StatusBarItem owner');
    assert.ok(source.includes('context.subscriptions.push(createTidyStatusBar())'));
  });

  it('registers the runtime-only click menu command', () => {
    assert.ok(source.includes('STATUS_BAR_MENU_COMMAND_ID'));
    assert.ok(source.includes('showStatusBarMenu'));
  });

  it('still installs no save/focus/change hook at activation', () => {
    for (const needle of [
      'onDidSaveTextDocument',
      'onWillSaveTextDocument',
      'onDidChangeTextDocument',
      'onDidChangeWindowState'
    ]) {
      assert.ok(!source.includes(needle), `forbidden hook: ${needle}`);
    }
  });
});
