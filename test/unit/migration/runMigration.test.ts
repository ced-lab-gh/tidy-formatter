// Unit tests for the PURE pieces of the migration flow (Axe 1 / 1.T4), ported in
// v0.5.0 to the new recap API (buildMigrationRecap now takes what the source reader
// found, not a pre-mapped result).
//
// PURE (no 'vscode'): we import only the recap builders + message formatter +
// constants, through the re-exports of src/migration/runMigration. The host handler
// (`runMigration`, `showMigrationNotification`) loads 'vscode' lazily inside its
// body, so importing this module does NOT pull in 'vscode'.
//
// WHAT IS COVERED ELSEWHERE, stated plainly. (Corrected in v0.4.1: this header used
// to claim "the host flow itself is covered by the integration suite", and it was
// not: no test named `runMigration`. Since v0.5.0 it is covered, and this header
// says where.) The host flow (the trust check, the file reads, the modal recap, the
// settings WRITE after consent, the rollback, the "use as formatter" follow-up and
// the closing messages) is exercised by mock-driven tests of `runMigrationWith` in
// runMigrationFlow.test.ts, of the reader in lonefySources.test.ts and of the write
// in applyWrites.test.ts, and end to end in a real host by
// test/integration/migration.test.ts. `showMigrationNotification` (the one-shot
// activation notice) is still not exercised by any test.
//
// Coverage focus of THIS file, each block ported from the flat-key era:
//   - buildMigrationRecap copies (does not alias) what it reads;
//   - hasSettingsToWrite reflects whether anything would be written;
//   - formatRecapMessage states "nothing changed yet" + the no-formatOnSave /
//     guide-only contract, and lists settings / unmapped / warnings.
import assert from 'node:assert/strict';
import {
  buildMigrationRecap,
  hasSettingsToWrite,
  formatRecapMessage,
  RUN_MIGRATION_COMMAND_ID,
  JSBEAUTIFYRC_FILENAME
} from '../../../src/migration/runMigration';
import type { SourceReadResult } from '../../../src/migration/lonefySources';

/** A `.jsbeautifyrc` read, the flat-key shape this file's ported tests used. */
function rc(text: string): SourceReadResult {
  return { state: 'found', kind: 'jsbeautifyrc', text };
}

describe('migration/runMigration : constants', () => {
  it('exposes the stable command id and legacy filename', () => {
    assert.equal(RUN_MIGRATION_COMMAND_ID, 'tidy.runMigration');
    assert.equal(JSBEAUTIFYRC_FILENAME, '.jsbeautifyrc');
  });
});

describe('migration/runMigration : buildMigrationRecap', () => {
  it('carries the mapper settings / unmapped / warnings through', () => {
    const recap = buildMigrationRecap(
      rc('{"indent_size":2,"brace_style":"expand","foo":1}')
    );

    assert.equal(recap.state, 'found');
    assert.deepEqual(
      recap.writes.map((write) => [write.key, write.value]),
      [
        ['tidy.indent', 2],
        ['tidy.brace_style', 'expand']
      ]
    );
    assert.deepEqual([...recap.unmapped], ['foo']);
    assert.deepEqual([...recap.warnings], []);
  });

  // Old form: "mutating the recap never affects the mapping". The mapping object is
  // no longer shared with the caller (the recap builds it itself from the read), so
  // the equivalent guarantee is: two recaps of one read are independent, and the
  // read result is never touched.
  it('copies the mapper data (mutating a recap never affects another recap or the read)', () => {
    const read = rc('{"indent_size":2,"foo":1}');
    const snapshot = JSON.stringify(read);
    const a = buildMigrationRecap(read);
    const b = buildMigrationRecap(read);

    (a.writes[0] as { value: unknown }).value = 999;
    (a.unmapped as string[]).push('extra');

    assert.equal(b.writes[0].value, 2, 'another recap untouched');
    assert.deepEqual([...b.unmapped], ['foo'], 'another recap unmapped untouched');
    assert.equal(JSON.stringify(read), snapshot, 'the read result untouched');
  });

  // Old form: rcFound=false. The recap now says HOW the search ended.
  it('records "nothing found" with an empty mapping', () => {
    const recap = buildMigrationRecap({ state: 'none' });
    assert.equal(recap.state, 'none');
    assert.equal(recap.source, undefined);
    assert.equal(hasSettingsToWrite(recap), false);
  });
});

describe('migration/runMigration : hasSettingsToWrite', () => {
  it('is true when there is at least one setting', () => {
    assert.equal(hasSettingsToWrite(buildMigrationRecap(rc('{"indent_size":2}'))), true);
  });

  it('is false for an empty settings map', () => {
    assert.equal(hasSettingsToWrite(buildMigrationRecap(rc('{"foo":1}'))), false);
  });
});

describe('migration/runMigration : formatRecapMessage', () => {
  it('always states nothing has changed yet and never enables Format On Save', () => {
    const message = formatRecapMessage(buildMigrationRecap(rc('{"indent_size":2}')));
    assert.ok(
      message.includes('Nothing has been changed yet'),
      'must reassure: nothing written yet'
    );
    assert.ok(
      message.includes('Format On Save'),
      'must mention it never enables Format On Save'
    );
  });

  it('lists each setting it would import', () => {
    const message = formatRecapMessage(
      buildMigrationRecap(rc('{"indent_size":2,"brace_style":"expand"}'))
    );
    assert.ok(message.includes('tidy.indent'));
    assert.ok(message.includes('tidy.brace_style'));
  });

  it('surfaces unmapped keys verbatim', () => {
    const message = formatRecapMessage(buildMigrationRecap(rc('{"foo":1,"bar":2}')));
    assert.ok(message.includes('foo'));
    assert.ok(message.includes('bar'));
  });

  // Old form: the message contained the literal 'No .jsbeautifyrc was found'. That
  // sentence was the v0.4.2 defect (it claimed the incumbent's only file was
  // .jsbeautifyrc, which it never reads), so the literal no longer applies. The
  // assertion it carried, "a search that finds nothing says so", is kept, against
  // the new wording that names every place looked at.
  it('reports when no settings file was found', () => {
    const message = formatRecapMessage(buildMigrationRecap({ state: 'none' }));
    assert.ok(message.includes('No JS-CSS-HTML Formatter settings file was found'));
    assert.ok(message.includes('.jsbeautifyrc'), 'it still says .jsbeautifyrc was looked for');
    assert.ok(!message.includes('No .jsbeautifyrc was found'), 'the v0.4.2 sentence is gone');
  });

  it('reports when a file was found but nothing maps', () => {
    const message = formatRecapMessage(buildMigrationRecap(rc('{"foo":1}')));
    assert.ok(message.includes('none of its options map'));
  });

  it('includes out-of-domain warnings', () => {
    const message = formatRecapMessage(buildMigrationRecap(rc('{"indent_size":999}')));
    assert.ok(message.includes('indent_size'), 'warning text surfaced');
  });
});
