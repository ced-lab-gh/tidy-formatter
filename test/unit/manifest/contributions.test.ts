// Manifest tests for the ADD-10 ergonomics pass.
//
// PURE (no 'vscode'): reads package.json from disk and asserts the declarative
// surface added by ADD-10: Title Case command titles, the enablement clause on
// the three active-file diagnostic commands (and ONLY those three), the "Tidy"
// editor context submenu, the no-default-keybindings invariant, and a
// shipped-text hygiene scan (no em dash anywhere in the manifest).
//
// extension.ts publishes the context key via `setContext` at activation. We
// cannot import it here (extension.ts imports 'vscode', which has no mocha
// host), so the contract is locked the other way round: the expected key is
// declared once below and re-checked against the SOURCE TEXT of extension.ts,
// so a rename on either side fails CI instead of silently killing every menu.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../../..');

interface CommandContribution {
  command: string;
  title: string;
  category?: string;
  enablement?: string;
}

interface MenuItem {
  command?: string;
  submenu?: string;
  when?: string;
  group?: string;
}

interface SubmenuContribution {
  id: string;
  label: string;
}

interface Manifest {
  activationEvents: string[];
  contributes: {
    commands: CommandContribution[];
    submenus?: SubmenuContribution[];
    menus?: Record<string, MenuItem[]>;
    keybindings?: unknown;
  };
}

const RAW = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8');
const manifest = JSON.parse(RAW) as Manifest;

const EXTENSION_SOURCE = fs.readFileSync(
  path.join(ROOT, 'src', 'extension.ts'),
  'utf8'
);

const SUPPORTED_LANGUAGES_CONTEXT_KEY = 'tidy.supportedLanguages';
const ENABLEMENT_CLAUSE = `editorLangId in ${SUPPORTED_LANGUAGES_CONTEXT_KEY}`;

/** Exact Title Case titles (ADD-10). Ids are stable; only titles were normalized. */
const EXPECTED_TITLES: Record<string, string> = {
  'tidy.showEffectiveConfiguration': 'Show Effective Configuration',
  'tidy.useAsFormatter': 'Use Tidy as My Formatter',
  'tidy.runMigration': 'Migrate from JS-CSS-HTML Formatter',
  'tidy.previewFormat': 'Preview Format (Diff)',
  'tidy.openPlayground': 'Open Playground',
  'tidy.reportIssue': 'Report an Issue',
  'tidy.explainLastFormat': 'Explain Last Format'
};

/** The three active-file diagnostic commands gated by enablement, and only them. */
const ENABLEMENT_GATED: readonly string[] = [
  'tidy.showEffectiveConfiguration',
  'tidy.previewFormat',
  'tidy.explainLastFormat'
];

function findCommand(id: string): CommandContribution {
  const cmd = manifest.contributes.commands.find((c) => c.command === id);
  assert.ok(cmd, `command '${id}' must be contributed`);
  return cmd!;
}

describe('manifest : command titles are Title Case (ADD-10)', () => {
  it('contributes exactly the 7 known commands, no more, no less', () => {
    assert.deepEqual(
      manifest.contributes.commands.map((c) => c.command).sort(),
      Object.keys(EXPECTED_TITLES).sort()
    );
  });

  it('every command title matches the Title Case table exactly', () => {
    for (const [id, title] of Object.entries(EXPECTED_TITLES)) {
      assert.equal(findCommand(id).title, title, `title of ${id}`);
    }
  });

  it('every command keeps the harmonised "Tidy" category', () => {
    for (const cmd of manifest.contributes.commands) {
      assert.equal(cmd.category, 'Tidy', `category of ${cmd.command}`);
    }
  });
});

describe('manifest : enablement clause (ADD-10)', () => {
  it('extension.ts publishes exactly this context key via setContext', () => {
    // The manifest clauses below are worthless if activation publishes another
    // key, so the two are pinned to each other here.
    assert.ok(
      EXTENSION_SOURCE.includes(
        `SUPPORTED_LANGUAGES_CONTEXT_KEY = '${SUPPORTED_LANGUAGES_CONTEXT_KEY}'`
      ),
      'extension.ts must declare SUPPORTED_LANGUAGES_CONTEXT_KEY with the manifest value'
    );
    assert.ok(
      EXTENSION_SOURCE.includes("'setContext'"),
      'extension.ts must publish the key through setContext'
    );
    assert.ok(
      EXTENSION_SOURCE.includes('[...SUPPORTED_LANG_IDS]'),
      'the published value must be a defensive copy of SUPPORTED_LANG_IDS'
    );
  });

  it('the three diagnostic commands declare the exact enablement clause', () => {
    for (const id of ENABLEMENT_GATED) {
      assert.equal(findCommand(id).enablement, ENABLEMENT_CLAUSE, `enablement of ${id}`);
    }
  });

  it('onboarding, migration and report commands declare NO enablement', () => {
    for (const cmd of manifest.contributes.commands) {
      if (ENABLEMENT_GATED.includes(cmd.command)) {
        continue;
      }
      assert.equal(
        cmd.enablement,
        undefined,
        `${cmd.command} must stay invocable without an active editor`
      );
    }
  });
});

describe('manifest : Tidy editor context submenu (ADD-10)', () => {
  it('contributes exactly one submenu: tidy.editorContext labelled "Tidy"', () => {
    assert.deepEqual(manifest.contributes.submenus, [
      { id: 'tidy.editorContext', label: 'Tidy' }
    ]);
  });

  it('editor/context contributes exactly the Tidy submenu, gated by the clause', () => {
    const items = manifest.contributes.menus?.['editor/context'];
    assert.ok(items, 'menus["editor/context"] must exist');
    assert.equal(items!.length, 1, 'exactly one editor/context entry');
    assert.deepEqual(items![0], {
      submenu: 'tidy.editorContext',
      group: '1_modification@99',
      when: ENABLEMENT_CLAUSE
    });
  });

  it('the Tidy submenu contains exactly previewFormat then explainLastFormat', () => {
    const items = manifest.contributes.menus?.['tidy.editorContext'];
    assert.ok(items, 'menus["tidy.editorContext"] must exist');
    assert.deepEqual(items, [
      { command: 'tidy.previewFormat', group: '1_tidy@1' },
      { command: 'tidy.explainLastFormat', group: '1_tidy@2' }
    ]);
  });

  it('every menu item references a contributed command or the contributed submenu', () => {
    const known = new Set(manifest.contributes.commands.map((c) => c.command));
    const submenuIds = new Set((manifest.contributes.submenus ?? []).map((s) => s.id));
    for (const [menuId, items] of Object.entries(manifest.contributes.menus ?? {})) {
      for (const item of items) {
        if (item.command !== undefined) {
          assert.ok(
            known.has(item.command),
            `menu ${menuId} references unknown command ${item.command}`
          );
        } else {
          assert.ok(
            item.submenu && submenuIds.has(item.submenu),
            `menu ${menuId} references unknown submenu ${item.submenu}`
          );
        }
      }
    }
  });

  it('contributes no menu surface beyond editor/context and the submenu itself', () => {
    assert.deepEqual(
      Object.keys(manifest.contributes.menus ?? {}).sort(),
      ['editor/context', 'tidy.editorContext']
    );
  });
});

describe('manifest : anti-hijack invariants held by ADD-10', () => {
  it('contributes NO default keybindings', () => {
    assert.equal(
      manifest.contributes.keybindings,
      undefined,
      'Tidy must never ship a default keybinding'
    );
  });

  it('activationEvents gained nothing from this pass (onLanguage:* only)', () => {
    for (const ev of manifest.activationEvents) {
      assert.match(ev, /^onLanguage:/, `unexpected activation event "${ev}"`);
    }
  });

  it('the whole manifest ships zero em dash characters (U+2014)', () => {
    assert.ok(!RAW.includes('\u005cu2014'), 'package.json must not contain U+2014');
  });
});
