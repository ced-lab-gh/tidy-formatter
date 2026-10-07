// "Tidy: Who Formats This File?" : the PURE half (scope model + report builder).
// No 'vscode', no host: plain data in, text out. The host half is covered by
// whoFormatsHost.test.ts and the read-only guarantee by whoFormatsReadOnly.test.ts.
import assert from 'node:assert/strict';
import {
  OPEN_ONLY_COMMAND_IDS,
  OPEN_SETTINGS_COMMAND_ID,
  SAVE_TIME_EDIT_KEYS,
  SEARCH_EXTENSIONS_COMMAND_ID,
  buildActions,
  buildHeadline,
  buildWhoFormatsReport,
  type WhoFormatsFacts
} from '../../../src/commands/whoFormatsReport';
import {
  foldFolderIntoWorkspace,
  narrowLayers,
  renderValue,
  resolveKeyedSources,
  resolveScalarSource,
  type LayerKey,
  type SettingLayers,
  type SettingProbe
} from '../../../src/commands/whoFormatsScopes';

const EM_DASH = String.fromCharCode(0x2014);

/* -------------------------------------------------------------------------- */
/* Builders                                                                    */
/* -------------------------------------------------------------------------- */

function read(effective: unknown, layers: SettingLayers | undefined): SettingProbe {
  return { state: 'read', effective, layers };
}

function facts(over: Partial<WhoFormatsFacts> = {}): WhoFormatsFacts {
  return {
    fileName: 'app.css',
    languageId: 'css',
    workspaceKind: 'folder',
    defaultFormatter: read(null, { defaultValue: null }),
    formatterExtension: { state: 'none' },
    formatOnSave: read(false, { defaultValue: false }),
    formatOnSaveMode: read('file', { defaultValue: 'file' }),
    codeActionsOnSave: read({}, { defaultValue: {} }),
    saveTimeEdits: SAVE_TIME_EDIT_KEYS.map((key) => ({ key, probe: read(false, { defaultValue: false }) })),
    incumbentVisible: false,
    incumbentConfig: { state: 'absent' },
    competing: { state: 'scanned', names: [] },
    now: '2026-09-30T10:00:00.000Z',
    ...over
  };
}

function reportText(over: Partial<WhoFormatsFacts> = {}): string {
  return buildWhoFormatsReport(facts(over)).lines.join('\n');
}

/* -------------------------------------------------------------------------- */
/* The scope model                                                             */
/* -------------------------------------------------------------------------- */

describe('whoFormats : which scope set a scalar setting', () => {
  // Every one of the eight scopes, named for the language it was read for.
  const CASES: ReadonlyArray<readonly [LayerKey, string]> = [
    ['workspaceFolderLanguageValue', 'Workspace Folder settings ([css] block)'],
    ['workspaceLanguageValue', 'Workspace settings ([css] block)'],
    ['globalLanguageValue', 'User settings ([css] block)'],
    ['defaultLanguageValue', 'default ([css] block, from VS Code or an extension)'],
    ['workspaceFolderValue', 'Workspace Folder settings'],
    ['workspaceValue', 'Workspace settings'],
    ['globalValue', 'User settings'],
    ['defaultValue', 'default (VS Code or an extension)']
  ];

  for (const [key, label] of CASES) {
    it(`names ${key} as "${label}"`, () => {
      const source = resolveScalarSource('x', { [key]: 'x' }, 'css');
      assert.equal(source.kind, 'layer');
      assert.equal(source.kind === 'layer' && source.winner.label, label);
    });
  }

  it('uses the language of the file in the [lang] label', () => {
    const source = resolveScalarSource('x', { workspaceLanguageValue: 'x' }, 'typescriptreact');
    assert.equal(source.kind === 'layer' && source.winner.label, 'Workspace settings ([typescriptreact] block)');
  });

  it('a language-specific value beats every plain one, whatever the scope (the host rule)', () => {
    // User [css] block vs Workspace plain value: the [css] block wins in VS Code.
    const source = resolveScalarSource('user-css', { globalLanguageValue: 'user-css', workspaceValue: 'ws' }, 'css');
    assert.equal(source.kind === 'layer' && source.winner.label, 'User settings ([css] block)');
  });

  it('an extension [lang] default beats a plain User setting', () => {
    const source = resolveScalarSource('ext', { defaultLanguageValue: 'ext', globalValue: 'mine' }, 'css');
    assert.equal(source.kind === 'layer' && source.winner.key, 'defaultLanguageValue');
  });

  it('within a kind, the narrower scope wins: folder over workspace over user', () => {
    const plain = resolveScalarSource('f', { workspaceFolderValue: 'f', workspaceValue: 'w', globalValue: 'u' }, 'css');
    assert.equal(plain.kind === 'layer' && plain.winner.key, 'workspaceFolderValue');
    const lang = resolveScalarSource(
      'w',
      { workspaceLanguageValue: 'w', globalLanguageValue: 'u', defaultLanguageValue: 'd' },
      'css'
    );
    assert.equal(lang.kind === 'layer' && lang.winner.key, 'workspaceLanguageValue');
  });

  it('lists the other scopes that hold a value, marking same value versus not in effect', () => {
    const source = resolveScalarSource(
      'a',
      { workspaceLanguageValue: 'a', globalValue: 'b', workspaceValue: 'a', defaultValue: null },
      'css'
    );
    assert.equal(source.kind, 'layer');
    if (source.kind === 'layer') {
      // Plain built-in default left out: it is always there and never interesting.
      assert.deepEqual(
        source.others.map((o) => [o.key, o.value]),
        [
          ['workspaceValue', 'a'],
          ['globalValue', 'b']
        ]
      );
    }
  });

  it('an explicit null at a scope is a value (it unsets a lower scope)', () => {
    const source = resolveScalarSource(null, { workspaceValue: null, globalValue: 'x', defaultValue: null }, 'css');
    assert.equal(source.kind === 'layer' && source.winner.key, 'workspaceValue');
  });

  it('nothing set anywhere and a null effective value is "unset", not a scope', () => {
    assert.deepEqual(resolveScalarSource(null, { defaultValue: null }, 'css'), { kind: 'unset' });
    assert.deepEqual(resolveScalarSource(undefined, {}, 'css'), { kind: 'unset' });
  });

  it('a default that is a real value (formatOnSave false) is attributed to the default', () => {
    const source = resolveScalarSource(false, { defaultValue: false }, 'css');
    assert.equal(source.kind === 'layer' && source.winner.key, 'defaultValue');
  });

  describe('degrades instead of guessing', () => {
    it('no per-scope details at all (an old host, or inspect failed)', () => {
      const source = resolveScalarSource('x', undefined, 'css');
      assert.equal(source.kind, 'undetermined');
      assert.match(source.kind === 'undetermined' ? source.reason : '', /did not return per-scope details/);
    });

    it('a value but no scope holding it', () => {
      const source = resolveScalarSource('x', {}, 'css');
      assert.equal(source.kind, 'undetermined');
    });

    it('the top scope disagrees with the effective value and ONE other scope holds it: that one, no ordering claim', () => {
      // A host whose precedence differs from ours: the value still points at one scope.
      const source = resolveScalarSource('ws', { globalLanguageValue: 'u', workspaceValue: 'ws' }, 'css');
      assert.equal(source.kind === 'layer' && source.winner.key, 'workspaceValue');
    });

    it('the top scope disagrees and SEVERAL scopes hold the value: undetermined, candidates listed', () => {
      const source = resolveScalarSource(
        'same',
        { globalLanguageValue: 'other', workspaceValue: 'same', globalValue: 'same' },
        'css'
      );
      assert.equal(source.kind, 'undetermined');
      assert.deepEqual(
        source.kind === 'undetermined' ? source.candidates.map((c) => c.key) : [],
        ['workspaceValue', 'globalValue']
      );
    });

    it('the effective value matches no scope at all', () => {
      const source = resolveScalarSource('mystery', { workspaceValue: 'a', globalValue: 'b' }, 'css');
      assert.equal(source.kind, 'undetermined');
      assert.match(source.kind === 'undetermined' ? source.reason : '', /matches none of the scopes/);
    });
  });
});

describe('whoFormats : foldFolderIntoWorkspace (one folder open: the same file under two fields)', () => {
  it('folds the folder fields into the workspace ones, so one file is never two scopes', () => {
    const folded = foldFolderIntoWorkspace({
      workspaceFolderLanguageValue: 'x',
      workspaceLanguageValue: 'x',
      workspaceFolderValue: 'y',
      workspaceValue: 'y',
      globalValue: 'u',
      defaultValue: null
    });
    assert.deepEqual(folded, { workspaceLanguageValue: 'x', workspaceValue: 'y', globalValue: 'u', defaultValue: null });
  });

  it('the mirrored real-host shape names ONE scope and lists no duplicate', () => {
    const mirrored = {
      workspaceFolderLanguageValue: 'fmt',
      workspaceLanguageValue: 'fmt',
      workspaceFolderValue: 'plain',
      workspaceValue: 'plain',
      defaultValue: null
    };
    const unfolded = resolveScalarSource('fmt', mirrored, 'css');
    const folded = resolveScalarSource('fmt', foldFolderIntoWorkspace(mirrored), 'css');
    assert.equal(unfolded.kind === 'layer' && unfolded.winner.label, 'Workspace Folder settings ([css] block)');
    assert.equal(folded.kind === 'layer' && folded.winner.label, 'Workspace settings ([css] block)');
    assert.deepEqual(
      folded.kind === 'layer' && folded.others.map((o) => o.label),
      ['Workspace settings'],
      'only the plain value, which the [css] block overrides'
    );
  });

  it('keeps an explicit null and an absent field as they are, and does not invent fields', () => {
    assert.deepEqual(foldFolderIntoWorkspace({ workspaceFolderValue: null }), { workspaceValue: null });
    assert.deepEqual(foldFolderIntoWorkspace({ workspaceValue: 1 }), { workspaceValue: 1 });
    assert.deepEqual(foldFolderIntoWorkspace({ globalValue: 1 }), { globalValue: 1 });
    assert.deepEqual(foldFolderIntoWorkspace({}), {});
  });

  it('the folder value wins when both are set and differ (the precedence VS Code applies)', () => {
    assert.deepEqual(foldFolderIntoWorkspace({ workspaceFolderValue: 'f', workspaceValue: 'w' }), { workspaceValue: 'f' });
  });
});

describe('whoFormats : narrowLayers', () => {
  it('keeps the eight scope fields and drops everything else', () => {
    const layers = narrowLayers({ key: 'editor.x', languageIds: ['css'], workspaceValue: 1, globalValue: undefined });
    assert.deepEqual(layers, { workspaceValue: 1 });
  });

  it('anything that is not an object is "no details"', () => {
    assert.equal(narrowLayers(undefined), undefined);
    assert.equal(narrowLayers(null), undefined);
    assert.equal(narrowLayers('x'), undefined);
  });
});

describe('whoFormats : which scope set each key of codeActionsOnSave', () => {
  it('attributes each key on its own: objects merge key by key across scopes', () => {
    const keyed = resolveKeyedSources(
      { 'source.fixAll.eslint': 'explicit', 'source.organizeImports': 'always' },
      {
        globalLanguageValue: { 'source.fixAll.eslint': 'explicit' },
        workspaceFolderLanguageValue: { 'source.organizeImports': 'always' },
        defaultValue: {}
      },
      'css'
    );
    assert.equal(keyed.kind, 'entries');
    if (keyed.kind === 'entries') {
      assert.deepEqual(
        keyed.entries.map((e) => [e.key, e.value, e.source]),
        [
          ['source.fixAll.eslint', 'explicit', 'User settings ([css] block)'],
          ['source.organizeImports', 'always', 'Workspace Folder settings ([css] block)']
        ]
      );
    }
  });

  it('the narrower scope owns a key two scopes define with the same value', () => {
    const keyed = resolveKeyedSources(
      { 'source.fixAll': 'explicit' },
      { workspaceValue: { 'source.fixAll': 'explicit' }, globalValue: { 'source.fixAll': 'explicit' } },
      'css'
    );
    assert.equal(keyed.kind === 'entries' && keyed.entries[0].source, 'Workspace settings');
  });

  it('a key whose value matches no scope has no source (never a guess)', () => {
    const keyed = resolveKeyedSources({ 'source.fixAll': 'explicit' }, { globalValue: { 'source.fixAll': 'never' } }, 'css');
    assert.equal(keyed.kind === 'entries' && keyed.entries[0].source, undefined);
  });

  it('without per-scope details every source is unknown', () => {
    const keyed = resolveKeyedSources({ 'source.fixAll': 'explicit' }, undefined, 'css');
    assert.equal(keyed.kind === 'entries' && keyed.entries[0].source, undefined);
  });

  it('reads the legacy array form as "run it", attributed to the scope that lists it', () => {
    const keyed = resolveKeyedSources(['source.organizeImports'], { globalValue: ['source.organizeImports'] }, 'css');
    assert.deepEqual(keyed.kind === 'entries' && keyed.entries.map((e) => [e.key, e.value, e.source]), [
      ['source.organizeImports', true, 'User settings']
    ]);
  });

  it('nothing configured is "none"; a value of another shape is "unrecognised"', () => {
    assert.deepEqual(resolveKeyedSources({}, { defaultValue: {} }, 'css'), { kind: 'none' });
    assert.deepEqual(resolveKeyedSources([], undefined, 'css'), { kind: 'none' });
    assert.deepEqual(resolveKeyedSources(null, undefined, 'css'), { kind: 'none' });
    assert.deepEqual(resolveKeyedSources(42, undefined, 'css'), { kind: 'unrecognised', rendered: '42' });
  });
});

describe('whoFormats : renderValue', () => {
  it('prints a value as it would be typed in settings.json, single line', () => {
    assert.equal(renderValue('a.b'), '"a.b"');
    assert.equal(renderValue(true), 'true');
    assert.equal(renderValue(null), 'null');
    assert.equal(renderValue(undefined), '(unset)');
    assert.equal(renderValue({ a: 1 }), '{"a":1}');
  });

  it('bounds a long or multi-line value to one short line', () => {
    const long = renderValue('x'.repeat(500));
    assert.ok(long.length <= 80 && long.endsWith('...'));
    assert.ok(!renderValue('line1\nline2').includes('\n'));
  });
});

/* -------------------------------------------------------------------------- */
/* The report                                                                  */
/* -------------------------------------------------------------------------- */

describe('whoFormats : the report, line by line', () => {
  it('opens with a header naming the file (base name) and the language', () => {
    const { lines } = buildWhoFormatsReport(facts());
    assert.equal(lines[0], '=== Who formats this file? @ 2026-09-30T10:00:00.000Z ===');
    assert.equal(lines[1], 'File: app.css (css)');
    assert.equal(
      lines[2],
      'Workspace: one folder is open. Its .vscode/settings.json is the "Workspace settings" scope.'
    );
  });

  it('says so when no folder is open', () => {
    assert.ok(
      reportText({ workspaceKind: 'none' }).includes(
        'Workspace: no folder is open, so only User settings and defaults can apply.'
      )
    );
  });

  it('explains the two workspace scopes of a multi-root workspace, where they are different files', () => {
    assert.ok(
      reportText({ workspaceKind: 'multi-root' }).includes(
        'Workspace: a multi-root workspace is open. "Workspace settings" is the .code-workspace file, ' +
          "and \"Workspace Folder settings\" is each folder's .vscode/settings.json."
      )
    );
  });

  describe('spec 1: default formatter', () => {
    it('shows the effective value and the scope that set it', () => {
      const text = reportText({
        defaultFormatter: read('esbenp.prettier-vscode', { workspaceLanguageValue: 'esbenp.prettier-vscode', defaultValue: null }),
        formatterExtension: { state: 'found', id: 'esbenp.prettier-vscode', displayName: 'Prettier - Code formatter', isTidy: false }
      });
      assert.match(text, /1\. Default formatter for css/);
      assert.match(text, /editor\.defaultFormatter = "esbenp\.prettier-vscode"/);
      assert.match(text, /set by: Workspace settings \(\[css\] block\)/);
    });

    it('lists the scopes it overrides as "not in effect"', () => {
      const text = reportText({
        defaultFormatter: read('a.b', { workspaceValue: 'a.b', globalValue: 'ced-lab.tidy-formatter', defaultValue: null })
      });
      assert.match(text, /also set: User settings = "ced-lab\.tidy-formatter" \(not in effect\)/);
    });

    it('marks a lower scope holding the SAME value as "same value"', () => {
      const text = reportText({
        defaultFormatter: read('a.b', { workspaceLanguageValue: 'a.b', workspaceValue: 'a.b', defaultValue: null })
      });
      assert.ok(text.includes('also set: Workspace settings = "a.b" (same value)'), text);
    });

    it('names a User-scope language default when that is what applies', () => {
      const text = reportText({ defaultFormatter: read('a.b', { globalLanguageValue: 'a.b', defaultValue: null }) });
      assert.match(text, /set by: User settings \(\[css\] block\)/);
    });

    it('an unset default formatter says so and says VS Code chooses at format time', () => {
      const text = reportText();
      assert.match(text, /editor\.defaultFormatter = null \(no default formatter\)/);
      assert.match(text, /set by: no scope sets it/);
      assert.match(text, /No default formatter is set for css\. VS Code chooses at format time/);
    });

    it('an explicit null at the workspace is attributed, not reported as unset', () => {
      const text = reportText({ defaultFormatter: read(null, { workspaceValue: null, globalValue: 'a.b', defaultValue: null }) });
      assert.match(text, /set by: Workspace settings/);
    });

    it('reports a scope it cannot determine instead of guessing one', () => {
      const text = reportText({ defaultFormatter: read('a.b', undefined) });
      assert.match(text, /set by: could not be determined \(this VS Code did not return per-scope details\)\./);
    });

    it('a failed read is stated, never rendered as "not set"', () => {
      const text = reportText({ defaultFormatter: { state: 'unreadable', cause: 'boom' } });
      assert.match(text, /editor\.defaultFormatter could not be read \(boom\)\./);
      assert.doesNotMatch(text, /no default formatter/);
    });
  });

  describe('spec 2: the formatter extension', () => {
    it('installed and enabled, and not Tidy', () => {
      const text = reportText({
        defaultFormatter: read('esbenp.prettier-vscode', { workspaceValue: 'esbenp.prettier-vscode' }),
        formatterExtension: { state: 'found', id: 'esbenp.prettier-vscode', displayName: 'Prettier - Code formatter', isTidy: false }
      });
      assert.match(text, /Extension: Prettier - Code formatter \(esbenp\.prettier-vscode\) is installed and enabled\. It is not Tidy\./);
    });

    it('installed and enabled, and Tidy', () => {
      const text = reportText({
        defaultFormatter: read('ced-lab.tidy-formatter', { workspaceValue: 'ced-lab.tidy-formatter' }),
        formatterExtension: { state: 'found', id: 'ced-lab.tidy-formatter', isTidy: true }
      });
      assert.match(text, /Extension: ced-lab\.tidy-formatter is installed and enabled\. That is Tidy\./);
    });

    it('not visible: not installed OR disabled, and the API cannot tell which', () => {
      const text = reportText({
        defaultFormatter: read('gone.formatter', { workspaceValue: 'gone.formatter' }),
        formatterExtension: { state: 'not-visible', id: 'gone.formatter', isTidy: false }
      });
      assert.match(text, /Extension: gone\.formatter is not visible to VS Code's extension API\./);
      assert.match(text, /not installed, or it is installed but disabled \(the API cannot tell these apart\)/);
      assert.match(text, /cannot be the one formatting this file/);
    });

    it('a value that is not an extension id', () => {
      const text = reportText({
        defaultFormatter: read(42, { workspaceValue: 42 }),
        formatterExtension: { state: 'invalid-id', rendered: '42' }
      });
      assert.match(text, /The value 42 is not an extension id/);
    });

    it('an extension that could not be checked says so', () => {
      const text = reportText({
        defaultFormatter: read('a.b', { workspaceValue: 'a.b' }),
        formatterExtension: { state: 'unknown', id: 'a.b', cause: 'nope' }
      });
      assert.match(text, /Extension: a\.b could not be checked \(nope\)\./);
    });
  });

  describe('spec 3: saving', () => {
    it('format on save ON, with its scope and the consequence', () => {
      const text = reportText({ formatOnSave: read(true, { globalValue: true, defaultValue: false }) });
      assert.match(text, /2\. Saving this file \(css\)/);
      assert.match(text, /editor\.formatOnSave = true/);
      assert.match(text, /set by: User settings/);
      assert.match(text, /format on save is ON for this file/);
    });

    it('format on save OFF says VS Code itself will not reformat on save', () => {
      const text = reportText();
      assert.match(text, /editor\.formatOnSave = false/);
      assert.match(text, /set by: default \(VS Code or an extension\)/);
      assert.match(text, /format on save is OFF for this file\. VS Code itself does not reformat it when you save\./);
    });

    it('a language-specific format-on-save override is attributed to its block', () => {
      const text = reportText({
        formatOnSave: read(false, { globalValue: true, workspaceFolderLanguageValue: false, defaultValue: false })
      });
      assert.match(text, /editor\.formatOnSave = false\n {5}set by: Workspace Folder settings \(\[css\] block\)/);
      assert.match(text, /also set: User settings = true \(not in effect\)/);
    });

    it('formatOnSaveMode is glossed, and flagged as unused while format on save is off', () => {
      const off = reportText({ formatOnSaveMode: read('modifications', { workspaceValue: 'modifications' }) });
      assert.match(off, /editor\.formatOnSaveMode = "modifications" \(only the modified lines, which needs source control\)/);
      assert.match(off, /\(not used while format on save is off\)/);

      const on = reportText({
        formatOnSave: read(true, { globalValue: true }),
        formatOnSaveMode: read('file', { defaultValue: 'file' })
      });
      assert.match(on, /editor\.formatOnSaveMode = "file" \(the whole file\)/);
      assert.doesNotMatch(on, /not used while format on save is off/);
    });

    it('lists every code action that runs on save, each with its scope', () => {
      const text = reportText({
        codeActionsOnSave: read(
          { 'source.fixAll.eslint': 'explicit', 'source.organizeImports': 'never' },
          { workspaceValue: { 'source.fixAll.eslint': 'explicit' }, globalValue: { 'source.organizeImports': 'never' } }
        )
      });
      assert.match(text, /editor\.codeActionsOnSave: these code actions run on save and can rewrite code:/);
      assert.match(text, /source\.fixAll\.eslint = "explicit" \(set by: Workspace settings\)/);
      assert.match(text, /source\.organizeImports = "never" \(off\) \(set by: User settings\)/);
      assert.match(text, /"explicit" runs on a manual save, "always" also on auto-save, "never" is off\./);
    });

    it('no code action configured is stated', () => {
      assert.match(reportText(), /editor\.codeActionsOnSave: no code action is configured to run on save\./);
    });

    it('a code action whose scope cannot be told says so', () => {
      const text = reportText({ codeActionsOnSave: read({ 'source.fixAll': 'explicit' }, undefined) });
      assert.match(text, /source\.fixAll = "explicit" \(set by: could not be determined\)/);
    });

    it('the save-time edits VS Code makes itself are listed when on, with their scope', () => {
      const text = reportText({
        saveTimeEdits: [
          { key: 'trimTrailingWhitespace', probe: read(true, { globalValue: true }) },
          { key: 'insertFinalNewline', probe: read(false, { defaultValue: false }) },
          { key: 'trimFinalNewlines', probe: read(true, { workspaceLanguageValue: true }) }
        ]
      });
      assert.match(text, /Other save-time edits made by VS Code itself:/);
      assert.match(text, /files\.trimTrailingWhitespace = true \(set by: User settings\)/);
      assert.match(text, /files\.trimFinalNewlines = true \(set by: Workspace settings \(\[css\] block\)\)/);
      assert.doesNotMatch(text, /files\.insertFinalNewline = true/);
    });

    it('says none when all three are off', () => {
      assert.match(
        reportText(),
        /Other save-time edits made by VS Code itself: none \(files\.trimTrailingWhitespace, files\.insertFinalNewline, files\.trimFinalNewlines are off\)\./
      );
    });

    it('a setting that could not be read is stated for each of the four', () => {
      const text = reportText({
        formatOnSave: { state: 'unreadable', cause: 'a' },
        formatOnSaveMode: { state: 'unreadable', cause: 'b' },
        codeActionsOnSave: { state: 'unreadable', cause: 'c' },
        saveTimeEdits: [{ key: 'trimTrailingWhitespace', probe: { state: 'unreadable', cause: 'd' } }]
      });
      assert.match(text, /editor\.formatOnSave could not be read \(a\)\./);
      assert.match(text, /editor\.formatOnSaveMode could not be read \(b\)\./);
      assert.match(text, /editor\.codeActionsOnSave could not be read \(c\)\./);
      assert.match(text, /could not be read: files\.trimTrailingWhitespace\./);
    });

    it('a non-boolean formatOnSave is not interpreted', () => {
      assert.match(reportText({ formatOnSave: read('yes', { workspaceValue: 'yes' }) }), /the value is not a boolean, so it could not be interpreted\./);
    });
  });

  describe('spec 4: the incumbent JS-CSS-HTML Formatter', () => {
    it('installed and enabled: present, its config file, and why it matters', () => {
      const text = reportText({ incumbentVisible: true, incumbentConfig: { state: 'found' } });
      assert.match(text, /3\. JS-CSS-HTML Formatter \(lonefy\.vscode-JS-CSS-HTML-formatter\)/);
      assert.match(text, /Extension: installed and enabled\./);
      assert.match(text, /Config file \.vscode\/formatter\.json in the first workspace folder: found\./);
      assert.match(text, /known example of an extension that formats on save through its own save hook/);
    });

    it('disabled (invisible to the API) but its config file exists: the file is the trace', () => {
      const text = reportText({ incumbentVisible: false, incumbentConfig: { state: 'found' } });
      assert.match(text, /Extension: not visible to VS Code's extension API\. It is not installed, or it is installed but disabled/);
      assert.match(text, /formatter\.json in the first workspace folder: found\./);
      assert.match(text, /The config file shows it was used in this workspace\. If it is installed but disabled, it formats nothing\./);
      assert.doesNotMatch(text, /likely cause if this file changes/);
    });

    it('absent and no config file: nothing points to it', () => {
      const text = reportText();
      assert.match(text, /formatter\.json in the first workspace folder: not found \(or not readable\)\./);
      assert.match(text, /Nothing points to it/);
    });

    it('config file not checked in Restricted Mode, and with no folder', () => {
      assert.match(
        reportText({ incumbentConfig: { state: 'not-checked', reason: 'restricted' } }),
        /not checked: Restricted Mode \(Workspace Trust\) blocks reading workspace files\./
      );
      assert.match(reportText({ incumbentConfig: { state: 'not-checked', reason: 'no-folder' } }), /not checked: no folder is open\./);
      assert.doesNotMatch(reportText({ incumbentConfig: { state: 'not-checked', reason: 'no-folder' } }), /Nothing points to it/);
    });

    it('a config path that is a folder is not called a file', () => {
      assert.match(reportText({ incumbentConfig: { state: 'not-a-file' } }), /exists but is a folder, not a file\./);
    });
  });

  describe('spec 5: other formatters configured in the workspace', () => {
    it('lists the detected tools and says a config file is not proof', () => {
      const text = reportText({ competing: { state: 'scanned', names: ['Prettier', 'ESLint'] } });
      assert.match(text, /4\. Other formatters configured in this workspace/);
      assert.match(text, /Prettier, ESLint \(found through config files at the workspace root\)\./);
      assert.match(text, /does not prove the extension is installed or that it formats this file/);
    });

    it('none detected', () => {
      assert.match(reportText(), /None detected \(looked for Prettier, Biome, dprint and ESLint config files at the workspace root\)\./);
    });

    it('not scanned in Restricted Mode is never reported as "none detected"', () => {
      const text = reportText({ competing: { state: 'not-scanned', reason: 'restricted' } });
      assert.match(text, /Not scanned: Restricted Mode \(Workspace Trust\) blocks reading workspace files\./);
      assert.doesNotMatch(text, /None detected/);
    });

    it('not scanned with no folder open', () => {
      assert.match(reportText({ competing: { state: 'not-scanned', reason: 'no-folder' } }), /Not scanned: no folder is open\./);
    });
  });

  describe('spec 6: honesty, what no API can show', () => {
    // The mandatory statement. It must be present whatever else the report found.
    const VARIANTS: ReadonlyArray<readonly [string, Partial<WhoFormatsFacts>]> = [
      ['a plain file', {}],
      ['format on save on', { formatOnSave: read(true, { globalValue: true }) }],
      ['the incumbent visible', { incumbentVisible: true, incumbentConfig: { state: 'found' } }],
      ['everything unreadable', {
        defaultFormatter: { state: 'unreadable', cause: 'x' },
        formatOnSave: { state: 'unreadable', cause: 'x' },
        formatOnSaveMode: { state: 'unreadable', cause: 'x' },
        codeActionsOnSave: { state: 'unreadable', cause: 'x' },
        saveTimeEdits: []
      }],
      ['no workspace', { workspaceKind: 'none', incumbentConfig: { state: 'not-checked', reason: 'no-folder' }, competing: { state: 'not-scanned', reason: 'no-folder' } }]
    ];

    for (const [name, over] of VARIANTS) {
      it(`is stated in full for ${name}`, () => {
        const text = reportText(over);
        assert.match(text, /5\. What this report cannot see/);
        assert.match(text, /An extension can format a file on save through its OWN save hook\./);
        assert.match(text, /VS Code gives extensions no way\s+to observe that, so it can never appear above\./);
        assert.match(text, /if this file changes on save while editor\.formatOnSave is off for it,/);
        assert.match(text, /the cause is an extension doing that, and the JS-CSS-HTML Formatter is a known example\./);
        assert.match(text, /Help: Start Extension Bisect/);
        assert.match(text, /Tidy itself never hooks save\./);
      });
    }

    it('never claims to know what it cannot know', () => {
      const text = reportText();
      assert.doesNotMatch(text, /no other extension|nothing else formats|only (the|this) formatter/i);
    });
  });

  it('is content-free: it carries the file base name and settings, nothing from the document', () => {
    const text = reportText({ fileName: 'secret-plan.css' });
    assert.match(text, /File: secret-plan\.css \(css\)/);
    assert.ok(!/[\\/]/.test(text.split('\n')[1]), 'no directory in the File line');
  });

  it('contains no em dash (U+2014) in any variant', () => {
    const texts = [
      reportText(),
      reportText({ incumbentVisible: true, incumbentConfig: { state: 'found' }, competing: { state: 'scanned', names: ['Prettier'] } }),
      reportText({ formatterExtension: { state: 'not-visible', id: 'a.b', isTidy: false } })
    ];
    for (const text of texts) {
      assert.ok(!text.includes(EM_DASH));
    }
  });
});

describe('whoFormats : the notification headline and its buttons', () => {
  it('answers in one sentence: default formatter, its scope, format on save', () => {
    const headline = buildHeadline(
      facts({
        defaultFormatter: read('esbenp.prettier-vscode', { workspaceLanguageValue: 'esbenp.prettier-vscode' }),
        formatOnSave: read(true, { globalValue: true })
      })
    );
    assert.match(headline, /^Who formats app\.css\? Default formatter: esbenp\.prettier-vscode, set by Workspace settings \(\[css\] block\)\. Format on save: on\./);
    assert.match(headline, /The full report is in the Tidy Formatter output\.$/);
  });

  it('says when there is no default formatter, when format on save is off, and when it could not be read', () => {
    assert.match(buildHeadline(facts()), /No default formatter is set for css\. Format on save: off\./);
    assert.match(
      buildHeadline(facts({ defaultFormatter: { state: 'unreadable', cause: 'x' }, formatOnSave: { state: 'unreadable', cause: 'x' } })),
      /Default formatter: could not be read\. Format on save: unknown\./
    );
  });

  it('mentions the incumbent only when it is installed and enabled', () => {
    assert.match(buildHeadline(facts({ incumbentVisible: true })), /JS-CSS-HTML Formatter is installed and enabled\./);
    assert.doesNotMatch(buildHeadline(facts()), /JS-CSS-HTML Formatter/);
  });

  it('opens Settings at the two keys for THIS language, always', () => {
    const actions = buildActions(facts({ languageId: 'typescriptreact' }));
    assert.deepEqual(
      actions.slice(0, 2).map((a) => [a.label, a.commandId, a.args]),
      [
        ['Open Default Formatter Setting', OPEN_SETTINGS_COMMAND_ID, ['@lang:typescriptreact editor.defaultFormatter']],
        ['Open Format on Save Settings', OPEN_SETTINGS_COMMAND_ID, ['@lang:typescriptreact editor.formatOnSave']]
      ]
    );
  });

  it('offers the INSTALLED extensions list for the incumbent (visible, or only its config file found)', () => {
    const visible = buildActions(facts({ incumbentVisible: true }));
    const fileOnly = buildActions(facts({ incumbentConfig: { state: 'found' } }));
    const neither = buildActions(facts());
    for (const actions of [visible, fileOnly]) {
      assert.deepEqual(actions[2], {
        label: 'Find JS-CSS-HTML Formatter',
        commandId: SEARCH_EXTENSIONS_COMMAND_ID,
        args: ['@installed JS-CSS-HTML Formatter']
      });
    }
    assert.equal(neither.length, 2);
  });

  it('offers the default formatter extension, unless it is Tidy or there is none', () => {
    const other = buildActions(facts({ formatterExtension: { state: 'found', id: 'esbenp.prettier-vscode', isTidy: false } }));
    assert.deepEqual(other[2], {
      label: 'Find Default Formatter Extension',
      commandId: SEARCH_EXTENSIONS_COMMAND_ID,
      args: ['@installed prettier-vscode']
    });
    const missing = buildActions(facts({ formatterExtension: { state: 'not-visible', id: 'gone.fmt', isTidy: false } }));
    assert.equal(missing[2]?.args[0], '@installed fmt');
    assert.equal(buildActions(facts({ formatterExtension: { state: 'found', id: 'ced-lab.tidy-formatter', isTidy: true } })).length, 2);
    // A built-in formatter (publisher "vscode") is not in the installed list: no button for it.
    assert.equal(
      buildActions(facts({ formatterExtension: { state: 'found', id: 'vscode.css-language-features', isTidy: false } })).length,
      2
    );
    assert.equal(buildActions(facts()).length, 2);
  });

  it('every button only OPENS something: built-in open commands, never a Tidy or write command', () => {
    const all = buildActions(
      facts({
        incumbentVisible: true,
        formatterExtension: { state: 'found', id: 'esbenp.prettier-vscode', isTidy: false }
      })
    );
    assert.equal(all.length, 4);
    for (const action of all) {
      assert.ok(OPEN_ONLY_COMMAND_IDS.includes(action.commandId), `${action.commandId} is not open-only`);
    }
    assert.deepEqual([...OPEN_ONLY_COMMAND_IDS].sort(), ['workbench.action.openSettings', 'workbench.extensions.search']);
  });

  it('the report lists the buttons under "Suggested actions" and stays free of em dashes', () => {
    const { lines, actions } = buildWhoFormatsReport(facts({ incumbentVisible: true }));
    const text = lines.join('\n');
    assert.match(text, /Suggested actions \(buttons on the notification; they only open a view\):/);
    for (const action of actions) {
      assert.ok(text.includes(`> ${action.label}`));
    }
    assert.ok(!text.includes(EM_DASH));
  });
});
