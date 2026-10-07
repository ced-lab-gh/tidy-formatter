// Mock-driven tests of the HOST flow of "Tidy: Migrate from JS-CSS-HTML Formatter"
// (`runMigrationWith` in src/migration/runMigration.ts, v0.5.0), using the in-memory
// fake `vscode`. This is the coverage the v0.4.1 header of runMigration.test.ts said
// was missing: the trust check, the reads, the modal recap, the settings write after
// consent, the rollback and the closing messages.
//
// Locks, end to end through the real flow:
//   - on the REAL lonefy shape the migration now proposes settings (it proposed none);
//   - NOTHING is written before confirmation; cancel and skip write nothing;
//   - onSave is never proposed, in any dialog or any command;
//   - the final "cannot disable" message appears ONLY when the incumbent is installed;
//   - LOW-13: the config file is found although the extension is disabled/uninstalled;
//   - sources and their precedence, named in the recap;
//   - a failure part-way restores what was written and names any stuck key.
import assert from 'node:assert/strict';
import { runMigrationWith } from '../../../src/migration/runMigration';
import {
  LONEFY_DEFAULT_FORMATTER_JSON,
  LONEFY_DEFAULT_WRITES,
  LONEFY_CONTRIBUTOR_FORMATTER_JSON
} from './lonefyFixtures';

/** The recap-modal line of a fixture write (`[css] tidy.indent = 4`). */
function modalLineOf(fixtureLine: string): string {
  return fixtureLine.replace(/^\[(\w+)\] (\S+) = (.*)$/, '  "[$1]": { "$2": $3 }');
}

/** The update call a fixture write must produce, as the fake records it. */
function updateOf(fixtureLine: string): string {
  return fixtureLine.replace(/^\[(\w+)\] (\S+) = (.*)$/, 'WS [$1] $2=$3 override=true');
}
import {
  makeFakeVscode,
  type FakeOptions,
  type FakeVscode,
  type ShownMessage
} from './fakeVscode';

const LOCAL = '/ws/.vscode/formatter.json';
const RC = '/ws/.jsbeautifyrc';
const INSTALL = '/ext/lonefy.vscode-JS-CSS-HTML-formatter-0.2.3';
const GLOBAL = `${INSTALL}/out/src/formatter.json`;

const CONFIRM = 'Import settings';
const SKIP = 'Skip import';
const OFFER_PREFIX = 'Do you also want to make Tidy your default formatter';
const GUIDE_PREFIX = 'Tidy cannot disable JS-CSS-HTML Formatter';

type Choices = {
  modal?: string | undefined;
  offer?: string | undefined;
  guide?: string | undefined;
};

/** Build a fake whose notifications answer per kind of dialog. */
function fake(options: FakeOptions, choices: Choices = {}) {
  const updatesSeenByModal: number[] = [];
  const answer = (shown: ShownMessage): string | undefined => {
    if (shown.options?.modal) {
      updatesSeenByModal.push(vscode.updates.length);
      return choices.modal;
    }
    if (shown.message.startsWith(OFFER_PREFIX)) {
      return choices.offer;
    }
    if (shown.message.startsWith(GUIDE_PREFIX)) {
      return choices.guide;
    }
    return undefined;
  };
  const vscode: FakeVscode = makeFakeVscode({ ...options, answer });
  return { vscode, updatesSeenByModal };
}

const modalOf = (vscode: FakeVscode) =>
  vscode.shown.find((m) => m.options?.modal);

describe('migration flow : the REAL lonefy shape is now imported', () => {
  it('proposes the mappable settings in a MODAL recap, before writing anything', async () => {
    const { vscode, updatesSeenByModal } = fake(
      { files: { [LOCAL]: LONEFY_DEFAULT_FORMATTER_JSON } },
      { modal: CONFIRM }
    );
    await runMigrationWith(vscode);

    const modal = modalOf(vscode);
    assert.ok(modal, 'a modal recap must be shown');
    assert.equal(modal.message, 'Import your JS-CSS-HTML Formatter settings into Tidy?');
    assert.deepEqual(modal.actions, [CONFIRM, SKIP]);
    const detail = modal.options?.detail ?? '';
    for (const line of LONEFY_DEFAULT_WRITES.map(modalLineOf)) {
      assert.ok(detail.includes(line), `recap must list ${line}\n${detail}`);
    }
    assert.ok(detail.includes('at the Workspace scope'), detail);
    assert.ok(detail.includes('.vscode/formatter.json'), detail);
    assert.deepEqual(updatesSeenByModal, [0], 'NOTHING was written when the modal was shown');
  });

  it('writes exactly the recap after confirmation, at Workspace scope, language-scoped', async () => {
    const { vscode } = fake(
      { files: { [LOCAL]: LONEFY_DEFAULT_FORMATTER_JSON } },
      { modal: CONFIRM }
    );
    await runMigrationWith(vscode);

    assert.deepEqual(
      vscode.updates.map((u) => `${u.target} [${u.language}] ${u.section}.${u.key}=${JSON.stringify(u.value)} override=${u.overrideInLanguage}`),
      LONEFY_DEFAULT_WRITES.map(updateOf)
    );
    const toast = vscode.shown.find((m) => m.message.startsWith('Tidy imported'));
    assert.equal(
      toast?.message,
      `Tidy imported ${LONEFY_DEFAULT_WRITES.length} settings from .vscode/formatter.json at the Workspace scope.`
    );
  });

  it('proposes the contributor shape (indent 2, brace_style) too', async () => {
    const { vscode } = fake(
      { files: { [LOCAL]: LONEFY_CONTRIBUTOR_FORMATTER_JSON } },
      { modal: CONFIRM }
    );
    await runMigrationWith(vscode);
    assert.equal(vscode.workspaceStore.get('[javascript] tidy.indent'), 2);
    assert.equal(vscode.workspaceStore.get('[javascript] tidy.brace_style'), 'collapse-preserve-inline');
    assert.equal(vscode.workspaceStore.get('[css] tidy.indent'), 2);
  });
});

describe('migration flow : consent, cancel and skip', () => {
  it('CANCELLING the modal writes nothing and stops: no further offer, no guide', async () => {
    const { vscode } = fake(
      { incumbentPath: INSTALL, files: { [LOCAL]: LONEFY_DEFAULT_FORMATTER_JSON } },
      { modal: undefined }
    );
    await runMigrationWith(vscode);
    assert.deepEqual(vscode.updates, []);
    assert.equal(vscode.workspaceStore.size, 0);
    assert.equal(vscode.globalStore.size, 0);
    assert.equal(vscode.shown.length, 1, 'only the modal was shown');
    assert.deepEqual(vscode.executedCommands, []);
  });

  it('any answer that is not the confirm action writes nothing', async () => {
    for (const answer of ['Cancel', '', 'import settings', 'Import']) {
      const { vscode } = fake(
        { files: { [LOCAL]: LONEFY_DEFAULT_FORMATTER_JSON } },
        { modal: answer }
      );
      await runMigrationWith(vscode);
      assert.deepEqual(vscode.updates, [], `answer ${JSON.stringify(answer)}`);
    }
  });

  it('SKIPPING the import writes nothing but still offers the formatter step', async () => {
    const { vscode } = fake(
      { files: { [LOCAL]: LONEFY_DEFAULT_FORMATTER_JSON } },
      { modal: SKIP, offer: 'Not now' }
    );
    await runMigrationWith(vscode);
    assert.deepEqual(vscode.updates, []);
    assert.ok(vscode.shown.some((m) => m.message.startsWith(OFFER_PREFIX)));
  });
});

describe('migration flow : onSave is NEVER proposed', () => {
  it('no dialog offers it, no command is run for it, and formatOnSave is never written', async () => {
    const { vscode } = fake(
      { incumbentPath: INSTALL, files: { [LOCAL]: LONEFY_DEFAULT_FORMATTER_JSON } },
      { modal: CONFIRM, offer: 'Not now', guide: 'Cancel' }
    );
    await runMigrationWith(vscode);

    for (const shown of vscode.shown) {
      for (const action of shown.actions) {
        assert.ok(!/save/i.test(action), `no action may mention saving: ${action}`);
      }
    }
    for (const update of vscode.updates) {
      assert.ok(!/onSave|formatOnSave/i.test(update.key), update.key);
      assert.equal(update.section, 'tidy', 'only tidy.* settings are written');
    }
    assert.ok(
      !vscode.executedCommands.some((c) => /save/i.test(c.command)),
      JSON.stringify(vscode.executedCommands)
    );
  });

  it('the recap reports it as not migrated, in the product owner wording', async () => {
    const { vscode } = fake(
      { files: { [LOCAL]: LONEFY_DEFAULT_FORMATTER_JSON } },
      { modal: SKIP }
    );
    await runMigrationWith(vscode);
    assert.ok(
      (modalOf(vscode)?.options?.detail ?? '').includes(
        'not migrated: Tidy never enables Format On Save for you'
      )
    );
  });

  it('a file whose ONLY key is onSave proposes nothing and is reported', async () => {
    const { vscode } = fake({ files: { [LOCAL]: '{"onSave": true}' } });
    await runMigrationWith(vscode);
    assert.equal(modalOf(vscode), undefined, 'nothing to confirm');
    assert.deepEqual(vscode.updates, []);
    assert.ok(
      vscode.shown[0].message.includes('not migrated: Tidy never enables Format On Save for you')
    );
  });

  it('the formatter offer says the next step asks about Format On Save separately', async () => {
    const { vscode } = fake({}, { offer: 'Not now' });
    await runMigrationWith(vscode);
    const offer = vscode.shown.find((m) => m.message.startsWith(OFFER_PREFIX));
    assert.ok(offer, 'the offer is shown');
    assert.ok(offer.message.includes('separate question about Format On Save'), offer.message);
    assert.ok(offer.message.includes('nothing changes until you confirm there'), offer.message);
  });

  it('only a click on "Set Tidy as my formatter" runs the existing consent command', async () => {
    const declined = fake({}, { offer: 'Not now' });
    await runMigrationWith(declined.vscode);
    assert.deepEqual(declined.vscode.executedCommands, []);

    const accepted = fake({}, { offer: 'Set Tidy as my formatter…' });
    await runMigrationWith(accepted.vscode);
    assert.deepEqual(
      accepted.vscode.executedCommands.map((c) => c.command),
      ['tidy.useAsFormatter']
    );
  });
});

describe('migration flow : the closing "cannot disable" message is true', () => {
  it('is NOT shown when the incumbent is not installed (probe P3 showed it was)', async () => {
    const { vscode } = fake({ files: { [LOCAL]: LONEFY_DEFAULT_FORMATTER_JSON } }, { modal: CONFIRM, offer: 'Not now' });
    await runMigrationWith(vscode);
    assert.ok(!vscode.shown.some((m) => m.message.includes('Tidy cannot disable')));
    assert.ok(!vscode.shown.some((m) => m.message.includes('keep formatting on save')));
  });

  it('is NOT shown on the nothing-found path either', async () => {
    const { vscode } = fake({}, { offer: 'Not now' });
    await runMigrationWith(vscode);
    assert.ok(!vscode.shown.some((m) => m.message.startsWith(GUIDE_PREFIX)));
  });

  it('IS shown when the incumbent is installed and enabled, and its button opens the Extensions view', async () => {
    const { vscode } = fake({ incumbentPath: INSTALL }, { offer: 'Not now', guide: 'Open Extensions view' });
    await runMigrationWith(vscode);
    const guide = vscode.shown.find((m) => m.message.startsWith(GUIDE_PREFIX));
    assert.ok(guide, 'the guide is shown');
    assert.deepEqual(guide.actions, ['Open Extensions view', 'Cancel']);
    assert.deepEqual(vscode.executedCommands, [
      {
        command: 'workbench.extensions.search',
        args: ['@id:lonefy.vscode-JS-CSS-HTML-formatter']
      }
    ]);
  });

  it('Cancel on the guide does nothing', async () => {
    const { vscode } = fake({ incumbentPath: INSTALL }, { offer: 'Not now', guide: 'Cancel' });
    await runMigrationWith(vscode);
    assert.deepEqual(vscode.executedCommands, []);
  });
});

describe('migration flow : LOW-13, the config FILE is what matters', () => {
  it('imports .vscode/formatter.json although the incumbent is disabled or uninstalled', async () => {
    // No incumbentPath: getExtension(...) is undefined, exactly as for a disabled one.
    const { vscode } = fake(
      { files: { [LOCAL]: LONEFY_DEFAULT_FORMATTER_JSON } },
      { modal: CONFIRM, offer: 'Not now' }
    );
    assert.equal(vscode.extensions.getExtension('lonefy.vscode-JS-CSS-HTML-formatter'), undefined);
    await runMigrationWith(vscode);
    assert.equal(
      vscode.updates.length,
      LONEFY_DEFAULT_WRITES.length,
      'every setting was still proposed and written'
    );
  });
});

describe('migration flow : sources, precedence and scope', () => {
  const all = { [LOCAL]: '{"css":{"indent_size":2}}', [GLOBAL]: '{"css":{"indent_size":3}}', [RC]: '{"indent_size":5}' };

  it('a wins: the recap names the local file and the value comes from it', async () => {
    const { vscode } = fake({ incumbentPath: INSTALL, files: all }, { modal: CONFIRM, offer: 'Not now', guide: 'Cancel' });
    await runMigrationWith(vscode);
    assert.ok((modalOf(vscode)?.options?.detail ?? '').includes('.vscode/formatter.json in your first workspace folder'));
    assert.equal(vscode.workspaceStore.get('[css] tidy.indent'), 2);
  });

  it('b when a is missing: names the install-folder file and writes at USER scope', async () => {
    const { [LOCAL]: _a, ...rest } = all;
    const { vscode } = fake({ incumbentPath: INSTALL, files: rest }, { modal: CONFIRM, offer: 'Not now', guide: 'Cancel' });
    await runMigrationWith(vscode);
    const detail = modalOf(vscode)?.options?.detail ?? '';
    assert.ok(detail.includes('install folder'), detail);
    assert.ok(detail.includes('at the User scope'), detail);
    assert.equal(vscode.updates[0].target, 'GLOBAL');
    assert.equal(vscode.globalStore.get('[css] tidy.indent'), 3);
    assert.equal(vscode.workspaceStore.size, 0, 'a personal global config never lands in the project');
  });

  it('c last: .jsbeautifyrc is named as a file the incumbent does not read, plain tidy.* setting', async () => {
    const { vscode } = fake({ files: { [RC]: all[RC] } }, { modal: CONFIRM, offer: 'Not now' });
    await runMigrationWith(vscode);
    const modal = modalOf(vscode);
    assert.equal(modal?.message, 'Import your .jsbeautifyrc settings into Tidy?');
    assert.ok((modal?.options?.detail ?? '').includes('JS-CSS-HTML Formatter does not read this file'));
    assert.equal(vscode.workspaceStore.get('tidy.indent'), 5);
  });
});

describe('migration flow : nothing to import is reported, not silently ignored', () => {
  it('no file: a plain message names the places looked at, no modal, no write', async () => {
    const { vscode } = fake({}, { offer: 'Not now' });
    await runMigrationWith(vscode);
    assert.equal(modalOf(vscode), undefined);
    assert.deepEqual(vscode.updates, []);
    assert.ok(vscode.shown[0].message.includes('No JS-CSS-HTML Formatter settings file was found'));
  });

  it('Restricted Mode: reads nothing, says the workspace is not trusted, writes nothing', async () => {
    const { vscode } = fake(
      { trusted: false, incumbentPath: INSTALL, files: { [LOCAL]: LONEFY_DEFAULT_FORMATTER_JSON } },
      { offer: 'Not now', guide: 'Cancel' }
    );
    await runMigrationWith(vscode);
    assert.deepEqual(vscode.fsCalls, [], 'not one file was touched');
    assert.deepEqual(vscode.updates, []);
    assert.equal(modalOf(vscode), undefined);
    assert.ok(vscode.shown[0].message.includes('not trusted'), vscode.shown[0].message);
  });

  it('a malformed file is reported and nothing is written, with no modal', async () => {
    const { vscode } = fake({ files: { [LOCAL]: '{ "onSave": true, "css": ' } }, { offer: 'Not now' });
    await runMigrationWith(vscode);
    assert.equal(modalOf(vscode), undefined);
    assert.deepEqual(vscode.updates, []);
    const message = vscode.shown[0].message;
    assert.ok(message.includes('could not use it'), message);
    assert.ok(message.includes('.vscode/formatter.json'), message);
  });

  it('a file present but unreadable is reported with its cause', async () => {
    const { vscode } = fake({ files: { [LOCAL]: '{}' }, unreadable: [LOCAL] }, { offer: 'Not now' });
    await runMigrationWith(vscode);
    assert.deepEqual(vscode.updates, []);
    assert.ok(vscode.shown[0].message.includes('could not read it'), vscode.shown[0].message);
  });
});

describe('migration flow : a failure part-way restores what was written', () => {
  const failOnThird = (_call: unknown, index: number) =>
    index === 3 ? new Error('disk full') : undefined;

  it('restores every key, tells the user exactly that, and stops (no offer, no guide)', async () => {
    const { vscode } = fake(
      {
        incumbentPath: INSTALL,
        files: { [LOCAL]: LONEFY_DEFAULT_FORMATTER_JSON },
        failUpdate: failOnThird
      },
      { modal: CONFIRM }
    );
    await runMigrationWith(vscode);

    assert.equal(vscode.workspaceStore.size, 0, 'the settings are exactly as before');
    const error = vscode.shown.find((m) => m.kind === 'error');
    assert.ok(error, 'an error message is shown');
    assert.ok(error.message.includes('could not import all settings'), error.message);
    assert.ok(error.message.includes('disk full'), error.message);
    assert.ok(error.message.includes('no key was left written'), error.message);
    assert.ok(!vscode.shown.some((m) => m.message.startsWith(OFFER_PREFIX)), 'the flow stops');
    assert.ok(!vscode.shown.some((m) => m.message.startsWith('Tidy imported')), 'no success toast');
  });

  it('names a key that could not be restored', async () => {
    const { vscode } = fake(
      {
        files: { [LOCAL]: LONEFY_DEFAULT_FORMATTER_JSON },
        failUpdate: (_call, index) =>
          index === 3 ? new Error('disk full') : index === 4 ? new Error('locked') : undefined
      },
      { modal: CONFIRM }
    );
    await runMigrationWith(vscode);

    const error = vscode.shown.find((m) => m.kind === 'error');
    assert.ok(error?.message.includes('these keys stayed written: [javascript] tidy.indent'), error?.message);
    assert.equal(vscode.workspaceStore.get('[javascript] tidy.indent'), 4, 'really still written');
  });
});
