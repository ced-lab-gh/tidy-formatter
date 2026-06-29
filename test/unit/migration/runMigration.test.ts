// Unit tests for the PURE pieces of the migration flow (Axe 1 / 1.T4).
//
// PURE (no 'vscode'): we import only the recap builders + message formatter +
// constants. The host handler (`runMigration`, `showMigrationNotification`) loads
// 'vscode' lazily inside its body, so importing this module does NOT pull in
// 'vscode'. The host flow itself is covered by the integration suite.
//
// Coverage focus:
//   - buildMigrationRecap copies (does not alias) the mapper result;
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
import { mapLonefyOptions } from '../../../src/migration/lonefyOptions';

describe('migration/runMigration — constants', () => {
  it('exposes the stable command id and legacy filename', () => {
    assert.equal(RUN_MIGRATION_COMMAND_ID, 'tidy.runMigration');
    assert.equal(JSBEAUTIFYRC_FILENAME, '.jsbeautifyrc');
  });
});

describe('migration/runMigration — buildMigrationRecap', () => {
  it('carries the mapper settings / unmapped / warnings through', () => {
    const mapping = mapLonefyOptions({
      indent_size: 2,
      brace_style: 'expand',
      foo: 1
    });
    const recap = buildMigrationRecap(true, mapping);

    assert.equal(recap.rcFound, true);
    assert.deepEqual(recap.settings, {
      'tidy.indent': 2,
      'tidy.brace_style': 'expand'
    });
    assert.deepEqual(recap.unmapped, ['foo']);
    assert.deepEqual(recap.warnings, []);
  });

  it('copies the mapper data (mutating the recap never affects the mapping)', () => {
    const mapping = mapLonefyOptions({ indent_size: 2, foo: 1 });
    const recap = buildMigrationRecap(true, mapping);

    recap.settings['tidy.indent'] = 999;
    recap.unmapped.push('extra');

    assert.equal(mapping.settings['tidy.indent'], 2, 'mapping settings untouched');
    assert.deepEqual(mapping.unmapped, ['foo'], 'mapping unmapped untouched');
  });

  it('records rcFound=false with an empty mapping', () => {
    const recap = buildMigrationRecap(false, {
      settings: {},
      unmapped: [],
      warnings: []
    });
    assert.equal(recap.rcFound, false);
    assert.equal(hasSettingsToWrite(recap), false);
  });
});

describe('migration/runMigration — hasSettingsToWrite', () => {
  it('is true when there is at least one setting', () => {
    const recap = buildMigrationRecap(true, mapLonefyOptions({ indent_size: 2 }));
    assert.equal(hasSettingsToWrite(recap), true);
  });

  it('is false for an empty settings map', () => {
    const recap = buildMigrationRecap(true, mapLonefyOptions({ foo: 1 }));
    assert.equal(hasSettingsToWrite(recap), false);
  });
});

describe('migration/runMigration — formatRecapMessage', () => {
  it('always states nothing has changed yet and never enables Format On Save', () => {
    const recap = buildMigrationRecap(true, mapLonefyOptions({ indent_size: 2 }));
    const message = formatRecapMessage(recap);
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
    const recap = buildMigrationRecap(
      true,
      mapLonefyOptions({ indent_size: 2, brace_style: 'expand' })
    );
    const message = formatRecapMessage(recap);
    assert.ok(message.includes('tidy.indent'));
    assert.ok(message.includes('tidy.brace_style'));
  });

  it('surfaces unmapped keys verbatim', () => {
    const recap = buildMigrationRecap(true, mapLonefyOptions({ foo: 1, bar: 2 }));
    const message = formatRecapMessage(recap);
    assert.ok(message.includes('foo'));
    assert.ok(message.includes('bar'));
  });

  it('reports when no .jsbeautifyrc was found', () => {
    const recap = buildMigrationRecap(false, {
      settings: {},
      unmapped: [],
      warnings: []
    });
    const message = formatRecapMessage(recap);
    assert.ok(message.includes('No .jsbeautifyrc was found'));
  });

  it('reports when a file was found but nothing maps', () => {
    const recap = buildMigrationRecap(true, mapLonefyOptions({ foo: 1 }));
    const message = formatRecapMessage(recap);
    assert.ok(message.includes('none of its options map'));
  });

  it('includes out-of-domain warnings', () => {
    const recap = buildMigrationRecap(
      true,
      mapLonefyOptions({ indent_size: 999 })
    );
    const message = formatRecapMessage(recap);
    assert.ok(message.includes('indent_size'), 'warning text surfaced');
  });
});
