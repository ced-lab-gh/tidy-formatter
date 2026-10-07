// Unit tests for the migration RECAP (src/migration/recap.ts, v0.5.0): the pure
// data and the exact text the user is asked to confirm. PURE (no 'vscode').
//
// Locks the consent and honesty contracts:
//   - the recap lists every exact key and value and the target scope;
//   - it NAMES the source used, and never presents .jsbeautifyrc as a file the
//     incumbent reads;
//   - onSave is reported as "not migrated: Tidy never enables Format On Save for
//     you" and is never listed as a write;
//   - every sentence is pre-write tense (nothing claims a write happened);
//   - a malformed, unreadable or untrusted source is reported, never presented as
//     "no option maps";
//   - no U+2014 and no French token in the shipped wording.
import assert from 'node:assert/strict';
import {
  ON_SAVE_NOT_MIGRATED,
  buildMigrationRecap,
  formatRecapMessage,
  formatWriteLine,
  hasSettingsToWrite,
  sourceFileNameOf,
  targetOfSource
} from '../../../src/migration/recap';
import type { SourceReadResult } from '../../../src/migration/lonefySources';
import type { MigrationSourceKind } from '../../../src/migration/types';
import {
  LONEFY_DEFAULT_FORMATTER_JSON,
  LONEFY_DEFAULT_UNMAPPED,
  LONEFY_DEFAULT_WRITES
} from './lonefyFixtures';

/** `[css] tidy.indent = 4` (the fixture form) as the recap prints it. */
function recapLineOf(fixtureLine: string): string {
  return fixtureLine.replace(/^\[(\w+)\] (\S+) = (.*)$/, '  "[$1]": { "$2": $3 }');
}

const EM_DASH = String.fromCharCode(0x2014);

function found(kind: MigrationSourceKind, text: string): SourceReadResult {
  return { state: 'found', kind, text };
}

describe('migration/recap : the target scope follows the source', () => {
  it('workspace files import at Workspace scope', () => {
    assert.equal(targetOfSource('workspace-formatter-json'), 'workspace');
    assert.equal(targetOfSource('jsbeautifyrc'), 'workspace');
    assert.equal(targetOfSource(undefined), 'workspace');
  });

  it('the global file imports at User scope (no personal preference pushed onto a repo)', () => {
    assert.equal(targetOfSource('global-formatter-json'), 'global');
  });
});

describe('migration/recap : buildMigrationRecap on the REAL default shape', () => {
  const recap = buildMigrationRecap(
    found('workspace-formatter-json', LONEFY_DEFAULT_FORMATTER_JSON)
  );

  it('proposes every mappable setting, language by language (it used to propose none)', () => {
    assert.equal(recap.state, 'found');
    assert.equal(recap.source, 'workspace-formatter-json');
    assert.equal(recap.target, 'workspace');
    assert.equal(hasSettingsToWrite(recap), true);
    assert.deepEqual(recap.writes.map(formatWriteLine), LONEFY_DEFAULT_WRITES.map(recapLineOf));
    // The two languages the incumbent also formatted with these sections.
    assert.ok(recap.writes.some((w) => w.language === 'json'));
    assert.ok(recap.writes.some((w) => w.language === 'scss'));
  });

  it('carries onSave as seen, and every unmapped key', () => {
    assert.equal(recap.onSaveSeen, true);
    assert.deepEqual([...recap.unmapped], [...LONEFY_DEFAULT_UNMAPPED]);
    assert.equal(recap.unusable, false);
  });

  it('the text lists each exact key and value, the scope and the source', () => {
    const text = formatRecapMessage(recap);
    for (const line of recap.writes.map(formatWriteLine)) {
      assert.ok(text.includes(line), `missing recap line ${line}`);
    }
    assert.ok(text.includes('at the Workspace scope'), text);
    assert.ok(text.includes('.vscode/formatter.json in your first workspace folder'), text);
  });

  it('the text reports onSave as not migrated, in the product owner wording', () => {
    const text = formatRecapMessage(recap);
    assert.equal(
      ON_SAVE_NOT_MIGRATED,
      'onSave: not migrated: Tidy never enables Format On Save for you.'
    );
    assert.ok(text.includes('not migrated: Tidy never enables Format On Save for you'), text);
  });

  it('onSave is never among the lines that would be written', () => {
    const text = formatRecapMessage(recap);
    const writeLines = text.split('\n').filter((l) => l.startsWith('  "'));
    assert.equal(writeLines.length, LONEFY_DEFAULT_WRITES.length);
    assert.ok(writeLines.every((l) => !/onSave|formatOnSave/i.test(l)), writeLines.join('\n'));
  });

  it('the text lists the unmapped keys verbatim and does NOT claim Tidy has no equivalent', () => {
    const text = formatRecapMessage(recap);
    for (const key of LONEFY_DEFAULT_UNMAPPED) {
      assert.ok(text.includes(key), `unmapped key ${key} must be surfaced`);
    }
    assert.ok(!text.includes('no Tidy equivalent'), 'Tidy has settings for several of these keys');
  });
});

describe('migration/recap : every outcome of the search has an honest message', () => {
  it('none: names the three places it looked, including that the global one needs the extension', () => {
    const text = formatRecapMessage(buildMigrationRecap({ state: 'none' }));
    assert.ok(text.includes('No JS-CSS-HTML Formatter settings file was found'), text);
    assert.ok(text.includes('.vscode/formatter.json in your first workspace folder'), text);
    assert.ok(text.includes('installed and enabled'), text);
    assert.ok(text.includes('.jsbeautifyrc at a workspace root'), text);
    assert.ok(text.includes('You can still make Tidy your default formatter'), text);
  });

  it('untrusted: says the workspace is not trusted instead of "nothing found"', () => {
    const text = formatRecapMessage(buildMigrationRecap({ state: 'untrusted' }));
    assert.ok(text.includes('not trusted'), text);
    assert.ok(!text.includes('No JS-CSS-HTML Formatter settings file was found'), text);
  });

  it('unreadable: names the file and the cause, imports nothing', () => {
    const recap = buildMigrationRecap({
      state: 'unreadable',
      kind: 'workspace-formatter-json',
      cause: 'it is a folder, not a file'
    });
    const text = formatRecapMessage(recap);
    assert.equal(hasSettingsToWrite(recap), false);
    assert.ok(text.includes('.vscode/formatter.json'), text);
    assert.ok(text.includes('could not read it (it is a folder, not a file)'), text);
  });

  it('malformed: says it could not be used, carries the warning, imports nothing', () => {
    const recap = buildMigrationRecap(found('workspace-formatter-json', '{ "onSave": '));
    const text = formatRecapMessage(recap);
    assert.equal(recap.unusable, true);
    assert.equal(hasSettingsToWrite(recap), false);
    assert.ok(text.includes('could not use it'), text);
    assert.ok(!text.includes('none of its options map'), 'a parse failure is not "nothing maps"');
    assert.ok(text.includes('Notes:'), text);
    assert.ok(text.includes('nothing was mapped'), text);
  });

  it('found but nothing maps: says so, and still reports onSave', () => {
    const recap = buildMigrationRecap(found('workspace-formatter-json', '{"onSave":true}'));
    const text = formatRecapMessage(recap);
    assert.ok(text.includes('none of its options map to a Tidy setting'), text);
    assert.ok(text.includes('not migrated: Tidy never enables Format On Save for you'), text);
  });
});

describe('migration/recap : the source is named, and .jsbeautifyrc is never the incumbent file', () => {
  it('file names', () => {
    assert.equal(sourceFileNameOf('workspace-formatter-json'), '.vscode/formatter.json');
    assert.equal(sourceFileNameOf('global-formatter-json'), 'formatter.json');
    assert.equal(sourceFileNameOf('jsbeautifyrc'), '.jsbeautifyrc');
  });

  it('the global source says it is the install-folder config, and imports at User scope', () => {
    const text = formatRecapMessage(
      buildMigrationRecap(found('global-formatter-json', '{"css":{"indent_size":2}}'))
    );
    assert.ok(text.includes('install folder'), text);
    assert.ok(text.includes('at the User scope'), text);
  });

  it('.jsbeautifyrc is presented as a file the incumbent does NOT read', () => {
    const text = formatRecapMessage(
      buildMigrationRecap(found('jsbeautifyrc', '{"indent_size":2}'))
    );
    assert.ok(text.includes('JS-CSS-HTML Formatter does not read this file'), text);
    assert.ok(text.includes('other beautify extensions do'), text);
  });
});

describe('migration/recap : the closing promise is true and pre-write', () => {
  it('with writes: nothing changed yet, scoped to THIS import, no past-tense write claim', () => {
    const text = formatRecapMessage(
      buildMigrationRecap(found('jsbeautifyrc', '{"indent_size":2}'))
    );
    assert.ok(text.includes('Nothing has been changed yet'), text);
    assert.ok(text.includes('This import never enables Format On Save'), text);
    assert.ok(text.includes('never disables any other extension'), text);
    assert.ok(!/\bwas written\b|\bhas been written\b|\bwere written\b|\bimported\b/.test(text), text);
  });

  it('without writes: says nothing was changed', () => {
    const text = formatRecapMessage(buildMigrationRecap({ state: 'none' }));
    assert.ok(text.includes('Nothing was changed'), text);
    assert.ok(!text.includes('Nothing has been changed yet'), text);
  });
});

describe('migration/recap : shipped wording hygiene', () => {
  const samples: SourceReadResult[] = [
    { state: 'none' },
    { state: 'untrusted' },
    { state: 'unreadable', kind: 'jsbeautifyrc', cause: 'x' },
    found('workspace-formatter-json', LONEFY_DEFAULT_FORMATTER_JSON),
    found('global-formatter-json', '{ broken'),
    found('jsbeautifyrc', '{"indent_size":2}')
  ];

  it('carries no U+2014 and no French token', () => {
    for (const sample of samples) {
      const text = formatRecapMessage(buildMigrationRecap(sample));
      assert.ok(!text.includes(EM_DASH), 'no U+2014 in shipped text');
      assert.ok(!/\b(aucun|aucune|fichier|parametres|annule)\b/i.test(text), text);
    }
  });
});
