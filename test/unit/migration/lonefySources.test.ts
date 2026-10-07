// Unit tests for the config-file reader of the migration
// (src/migration/lonefySources.ts, v0.5.0), driven by the in-memory fake `vscode`.
//
// Locks: the three sources and their ORDER (first found wins), the first-folder
// rule for the incumbent's local file, the global file being reachable only while
// the incumbent is installed and enabled, the Workspace Trust gate (NOTHING is
// read in Restricted Mode), that every read is read-only and local, and that an
// unusable file (folder, too large, unreadable, BOM) is handled as a value.
import assert from 'node:assert/strict';
import {
  JSBEAUTIFYRC_FILENAME,
  LONEFY_GLOBAL_CONFIG_SEGMENTS,
  LONEFY_LOCAL_CONFIG_SEGMENTS,
  MAX_CONFIG_BYTES,
  readMigrationSource
} from '../../../src/migration/lonefySources';
import { DIRECTORY, makeFakeVscode } from './fakeVscode';

const LOCAL = '/ws/.vscode/formatter.json';
const RC = '/ws/.jsbeautifyrc';
const INSTALL = '/home/u/.vscode/extensions/lonefy.vscode-JS-CSS-HTML-formatter-0.2.3';
const GLOBAL = `${INSTALL}/out/src/formatter.json`;

describe('migration/lonefySources : constants', () => {
  it('names the three places the incumbent and the beautify family really use', () => {
    assert.deepEqual([...LONEFY_LOCAL_CONFIG_SEGMENTS], ['.vscode', 'formatter.json']);
    assert.deepEqual([...LONEFY_GLOBAL_CONFIG_SEGMENTS], ['out', 'src', 'formatter.json']);
    assert.equal(JSBEAUTIFYRC_FILENAME, '.jsbeautifyrc');
  });
});

describe('migration/lonefySources : each source is found', () => {
  it('(a) .vscode/formatter.json in the first workspace folder', async () => {
    const vscode = makeFakeVscode({ files: { [LOCAL]: '{"a":1}' } });
    assert.deepEqual(await readMigrationSource(vscode), {
      state: 'found',
      kind: 'workspace-formatter-json',
      text: '{"a":1}'
    });
  });

  it('(b) the global formatter.json in the incumbent install folder', async () => {
    const vscode = makeFakeVscode({
      incumbentPath: INSTALL,
      files: { [GLOBAL]: '{"g":1}' }
    });
    assert.deepEqual(await readMigrationSource(vscode), {
      state: 'found',
      kind: 'global-formatter-json',
      text: '{"g":1}'
    });
  });

  it('(c) .jsbeautifyrc at a workspace root', async () => {
    const vscode = makeFakeVscode({ files: { [RC]: '{"indent_size":2}' } });
    assert.deepEqual(await readMigrationSource(vscode), {
      state: 'found',
      kind: 'jsbeautifyrc',
      text: '{"indent_size":2}'
    });
  });

  it('none of them exist: state none', async () => {
    assert.deepEqual(await readMigrationSource(makeFakeVscode()), { state: 'none' });
  });
});

describe('migration/lonefySources : order of precedence, first found wins', () => {
  const everything = {
    [LOCAL]: '{"from":"local"}',
    [GLOBAL]: '{"from":"global"}',
    [RC]: '{"from":"rc"}'
  };

  it('a beats b and c', async () => {
    const vscode = makeFakeVscode({ incumbentPath: INSTALL, files: everything });
    const read = await readMigrationSource(vscode);
    assert.equal(read.state === 'found' && read.kind, 'workspace-formatter-json');
  });

  it('b beats c when a is missing', async () => {
    const { [LOCAL]: _a, ...withoutLocal } = everything;
    const vscode = makeFakeVscode({ incumbentPath: INSTALL, files: withoutLocal });
    const read = await readMigrationSource(vscode);
    assert.equal(read.state === 'found' && read.kind, 'global-formatter-json');
  });

  it('c is used only when a and b are both missing', async () => {
    const vscode = makeFakeVscode({ incumbentPath: INSTALL, files: { [RC]: '{}' } });
    const read = await readMigrationSource(vscode);
    assert.equal(read.state === 'found' && read.kind, 'jsbeautifyrc');
  });

  it('stops at the first source that exists: later files are never read', async () => {
    const vscode = makeFakeVscode({ incumbentPath: INSTALL, files: everything });
    await readMigrationSource(vscode);
    assert.ok(!vscode.fsCalls.some((c) => c.includes(GLOBAL)), vscode.fsCalls.join(' | '));
    assert.ok(!vscode.fsCalls.some((c) => c.includes(RC)), vscode.fsCalls.join(' | '));
  });

  it('a malformed first file still wins (it is reported, not skipped for a later one)', async () => {
    const vscode = makeFakeVscode({
      files: { [LOCAL]: '{ not json', [RC]: '{"indent_size":2}' }
    });
    const read = await readMigrationSource(vscode);
    assert.equal(read.state === 'found' && read.kind, 'workspace-formatter-json');
  });
});

describe('migration/lonefySources : workspace folders', () => {
  it('(a) looks ONLY in the first folder, as the incumbent does', async () => {
    const vscode = makeFakeVscode({
      folders: ['/ws', '/other'],
      files: { '/other/.vscode/formatter.json': '{"x":1}' }
    });
    assert.deepEqual(await readMigrationSource(vscode), { state: 'none' });
  });

  it('(c) scans every folder root, in order, and takes the first .jsbeautifyrc', async () => {
    const vscode = makeFakeVscode({
      folders: ['/ws', '/second', '/third'],
      files: {
        '/second/.jsbeautifyrc': '{"from":"second"}',
        '/third/.jsbeautifyrc': '{"from":"third"}'
      }
    });
    const read = await readMigrationSource(vscode);
    assert.deepEqual(read, {
      state: 'found',
      kind: 'jsbeautifyrc',
      text: '{"from":"second"}'
    });
  });

  it('with no folder open, only the global file can be found', async () => {
    const vscode = makeFakeVscode({
      folders: [],
      incumbentPath: INSTALL,
      files: { [GLOBAL]: '{"g":1}' }
    });
    const read = await readMigrationSource(vscode);
    assert.equal(read.state === 'found' && read.kind, 'global-formatter-json');
  });
});

describe('migration/lonefySources : LOW-13, the CONFIG FILE matters, not the extension', () => {
  it('finds .vscode/formatter.json when the incumbent is disabled or uninstalled', async () => {
    // A disabled incumbent is invisible to getExtension (probe P4): no incumbentPath.
    const vscode = makeFakeVscode({ files: { [LOCAL]: '{"css":{"indent_size":2}}' } });
    assert.equal(vscode.extensions.getExtension('lonefy.vscode-JS-CSS-HTML-formatter'), undefined);
    const read = await readMigrationSource(vscode);
    assert.equal(read.state === 'found' && read.kind, 'workspace-formatter-json');
  });

  it('the global file is unreachable without the extension, even if a copy lies on disk', async () => {
    const vscode = makeFakeVscode({ files: { [GLOBAL]: '{"g":1}' } });
    assert.deepEqual(await readMigrationSource(vscode), { state: 'none' });
    assert.ok(!vscode.fsCalls.some((c) => c.includes(GLOBAL)), 'no path was even tried');
  });
});

describe('migration/lonefySources : Workspace Trust gate', () => {
  it('reads NOTHING in Restricted Mode, not even a stat', async () => {
    const vscode = makeFakeVscode({
      trusted: false,
      incumbentPath: INSTALL,
      files: { [LOCAL]: '{}', [GLOBAL]: '{}', [RC]: '{}' }
    });
    assert.deepEqual(await readMigrationSource(vscode), { state: 'untrusted' });
    assert.deepEqual(vscode.fsCalls, []);
  });

  it('the global file is gated too (all reads stay gated on a trusted workspace)', async () => {
    const vscode = makeFakeVscode({
      trusted: false,
      incumbentPath: INSTALL,
      files: { [GLOBAL]: '{}' }
    });
    await readMigrationSource(vscode);
    assert.ok(!vscode.fsCalls.some((c) => c.includes(GLOBAL)));
  });
});

describe('migration/lonefySources : read-only and local', () => {
  it('only ever stats and reads: the fake offers no other file operation', async () => {
    const vscode = makeFakeVscode({ incumbentPath: INSTALL, files: { [RC]: '{}' } });
    await readMigrationSource(vscode);
    assert.ok(
      vscode.fsCalls.every((call) => /^(stat|read) /.test(call)),
      vscode.fsCalls.join(' | ')
    );
    assert.deepEqual(vscode.updates, [], 'reading files writes no setting');
  });

  it('stats before reading, so a huge file is never loaded', async () => {
    const vscode = makeFakeVscode({
      files: { [LOCAL]: '{}' },
      sizes: { [LOCAL]: MAX_CONFIG_BYTES + 1 }
    });
    const read = await readMigrationSource(vscode);
    assert.equal(read.state, 'unreadable');
    assert.ok(!vscode.fsCalls.some((c) => c.startsWith('read ')), 'never read');
  });
});

describe('migration/lonefySources : unusable files are values, not exceptions', () => {
  it('a folder named like the file is reported, not read', async () => {
    const vscode = makeFakeVscode({ files: { [LOCAL]: DIRECTORY } });
    const read = await readMigrationSource(vscode);
    assert.equal(read.state, 'unreadable');
    assert.ok(read.state === 'unreadable' && read.cause.includes('folder'));
  });

  it('a read failure is reported with a single-line cause', async () => {
    const vscode = makeFakeVscode({ files: { [LOCAL]: '{}' }, unreadable: [LOCAL] });
    const read = await readMigrationSource(vscode);
    assert.equal(read.state, 'unreadable');
    assert.ok(read.state === 'unreadable' && !read.cause.includes('\n'));
  });

  it('strips a UTF-8 byte-order mark (Node require does; Windows editors write one)', async () => {
    const vscode = makeFakeVscode({ files: { [LOCAL]: '﻿{"a":1}' } });
    const read = await readMigrationSource(vscode);
    assert.deepEqual(read, {
      state: 'found',
      kind: 'workspace-formatter-json',
      text: '{"a":1}'
    });
  });

  it('never throws, even when the vscode API itself misbehaves', async () => {
    const hostile = {
      workspace: {
        get isTrusted(): boolean {
          throw new Error('boom');
        }
      }
    };
    assert.deepEqual(await readMigrationSource(hostile), { state: 'none' });
  });
});
