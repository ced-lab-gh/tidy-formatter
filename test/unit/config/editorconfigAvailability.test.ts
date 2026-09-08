// The .editorconfig layer's own availability, and the one message that states
// it when the layer is missing.
//
// THE DEFECT THIS LOCKS DOWN. Deleting dist/one_ini_bg.wasm from an installed
// extension (an antivirus quarantine, a partial install) leaves formatting
// working, which is the intended fail-safe, but it silently removed the WHOLE
// .editorconfig layer: with a real .editorconfig saying indent_size = 8, the
// healthy install indented by 8 and the degraded one by 2, with nothing
// anywhere saying so and the output channel still logging "applied". A
// formatter that quietly stops honouring the project's configuration is the
// broken promise this product is sold against, so the degraded state is now
// STATED (once, in English, through the diagnostics surfaces that already
// exist) while formatting keeps working.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  EDITORCONFIG_UNAVAILABLE_MESSAGE,
  editorConfigUnavailableWarnings,
  isEditorConfigParserAvailable
} from '../../../src/config/editorconfigAvailability';
import {
  loadBundledParseSync,
  readEditorConfigLayer,
  type ParseSyncFn,
  type ParseSyncLoader
} from '../../../src/config/editorconfig';
import { buildEffectiveConfigReport } from '../../../src/commands/showConfig';
import { resolveOptions } from '../../../src/config/resolver';

/** A loader whose parser resolves normally (the healthy install). */
const healthy: ParseSyncLoader = () =>
  (() => ({ indent_style: 'space', indent_size: 8 })) as unknown as ParseSyncFn;

/** The degraded install: the @one-ini/wasm asset is gone, so the require throws. */
const quarantined: ParseSyncLoader = () => {
  throw new Error("ENOENT: no such file or directory, open 'one_ini_bg.wasm'");
};

/** A package whose shape changed: it resolves, but exposes no parseSync. */
const shapeChanged: ParseSyncLoader = () => undefined;

describe('config/editorconfigAvailability : the healthy install', () => {
  it('reports the parser as available', () => {
    assert.equal(isEditorConfigParserAvailable(healthy), true);
  });

  it('says nothing at all: there is nothing wrong to report', () => {
    assert.deepEqual(editorConfigUnavailableWarnings(healthy), []);
  });

  it('and the layer really is applied, so indent_size 8 governs', () => {
    const layer = readEditorConfigLayer('/proj/src/app.css', healthy);
    assert.ok(layer, 'a healthy parser must produce the .editorconfig layer');
    assert.equal(layer.values.indent_size, 8);
    assert.equal(layer.source, '.editorconfig');
  });
});

describe('config/editorconfigAvailability : the degraded install', () => {
  it('reports the parser as unavailable when its asset is quarantined', () => {
    assert.equal(isEditorConfigParserAvailable(quarantined), false);
  });

  it('reports it unavailable when the package resolves without parseSync', () => {
    assert.equal(isEditorConfigParserAvailable(shapeChanged), false);
  });

  it('never throws, whatever the loader does', () => {
    assert.doesNotThrow(() => isEditorConfigParserAvailable(quarantined));
    assert.doesNotThrow(() => editorConfigUnavailableWarnings(quarantined));
  });

  it('produces exactly ONE warning, and it is the message', () => {
    const warnings = editorConfigUnavailableWarnings(quarantined);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0], EDITORCONFIG_UNAVAILABLE_MESSAGE);
  });

  // The counterfactual the auditor demonstrated: same .editorconfig, same
  // document, one install indents by 8 and the other does not. The ONLY
  // difference the user can see must be this message.
  it('is the silent half of the auditor s counterfactual: no layer, but a warning', () => {
    assert.equal(readEditorConfigLayer('/proj/src/app.css', quarantined), undefined);
    assert.deepEqual(editorConfigUnavailableWarnings(quarantined), [
      EDITORCONFIG_UNAVAILABLE_MESSAGE
    ]);
  });
});

describe('config/editorconfigAvailability : the message itself', () => {
  it('states what is happening, in English, without overstating it', () => {
    const message = EDITORCONFIG_UNAVAILABLE_MESSAGE;
    assert.match(message, /^\.editorconfig: /);
    assert.match(message, /could not be loaded/);
    assert.match(message, /NOT applied/);
    // It must NOT claim formatting is broken: formatting still succeeds.
    assert.match(message, /Formatting still works/);
    // It must name what is actually lost, and what still governs.
    assert.match(message, /indent_size/);
    assert.match(message, /\.soukformatrc/);
  });

  it('carries no em dash and no non-ASCII character', () => {
    // Shipped strings stay ASCII: an em dash (U+2014) is a release gate here,
    // and a smart quote breaks the same terminals for the same reason.
    for (const codePoint of EDITORCONFIG_UNAVAILABLE_MESSAGE) {
      const value = codePoint.codePointAt(0) ?? 0;
      assert.notEqual(value, 0x2014, 'no em dash in a shipped string');
      assert.ok(value < 0x80, `non-ASCII character ${codePoint} in a shipped string`);
    }
  });

  it('is a single sentence block: one notice, never a stream of them', () => {
    assert.equal(editorConfigUnavailableWarnings(quarantined).length, 1);
    assert.ok(!EDITORCONFIG_UNAVAILABLE_MESSAGE.includes('\n'));
  });
});

// The notice is worth nothing if it never reaches a surface. It has two, both
// pre-existing: the output channel (written once per session by vscodeConfig,
// which imports 'vscode' and so cannot be exercised here) and the pure "Show
// Effective Configuration" report, which can. This block lives beside the
// availability probe rather than in the showConfig suite because it is the same
// defect: the degraded install must be visible, not inferred.
describe('config/editorconfigAvailability : it reaches Show Effective Configuration', () => {
  const REPORT_BASE = {
    documentPath: '/proj/src/app.css',
    languageId: 'css' as const,
    options: resolveOptions({ languageId: 'css' as const, layers: [] }),
    warnings: [] as string[],
    now: '2026-06-29T00:00:00.000Z'
  };

  it('renders the notice under its own .editorconfig heading', () => {
    const report = buildEffectiveConfigReport({
      ...REPORT_BASE,
      editorconfigWarnings: editorConfigUnavailableWarnings(quarantined)
    });
    assert.match(report, /^\.editorconfig warnings \(non-fatal\)$/m);
    assert.ok(report.includes(EDITORCONFIG_UNAVAILABLE_MESSAGE));
  });

  it('does not attribute it to .soukformatrc or .prettierrc', () => {
    // Filing it under another layer's heading would be a false statement about
    // which config was ignored, which is the same class of defect again.
    const report = buildEffectiveConfigReport({
      ...REPORT_BASE,
      editorconfigWarnings: editorConfigUnavailableWarnings(quarantined)
    });
    assert.ok(!/^\.soukformatrc warnings/m.test(report));
    assert.ok(!/^\.prettierrc warnings/m.test(report));
  });

  it('a healthy install adds no section at all', () => {
    const report = buildEffectiveConfigReport({
      ...REPORT_BASE,
      editorconfigWarnings: editorConfigUnavailableWarnings(healthy)
    });
    assert.ok(!/\.editorconfig warnings/.test(report));
  });

  it('an older caller that passes no field still renders', () => {
    const report = buildEffectiveConfigReport(REPORT_BASE);
    assert.ok(!/\.editorconfig warnings/.test(report));
  });
});

describe('config/editorconfigAvailability : the production probe', () => {
  it('defaults to the SAME memoized loader the layer itself uses', () => {
    // Not a mock: this is the real bundled package in this test process. What
    // matters is that the probe and readEditorConfigLayer can never disagree,
    // because they ask the same memoized loader.
    const available = isEditorConfigParserAvailable();
    assert.equal(available, typeof loadBundledParseSync() === 'function');
    assert.equal(
      editorConfigUnavailableWarnings().length,
      available ? 0 : 1
    );
  });
});

// The OTHER surface, and the one no unit test can execute: src/config/
// vscodeConfig.ts imports 'vscode', so mocha cannot load it. The wiring that
// carries this notice to the output channel therefore has no behavioural test,
// and a future refactor could delete it while every test above still passes,
// putting the install straight back into the silent state the auditor found.
// These checks read the SOURCE from disk (same idiom as lazyBoundary.test.ts
// and the manifest suites) and fail in `npm test` the moment the wiring goes.
describe('config/editorconfigAvailability : the host wiring is present', () => {
  const VSCODE_CONFIG_PATH = join(
    __dirname,
    '../../../src/config/vscodeConfig.ts'
  );
  const source = readFileSync(VSCODE_CONFIG_PATH, 'utf8');

  it('asks the availability probe when the layer would have been read', () => {
    assert.match(
      source,
      /import\s*\{[^}]*editorConfigUnavailableWarnings[^}]*\}\s*from\s*'\.\/editorconfigAvailability'/,
      'vscodeConfig must import the availability probe'
    );
    assert.match(
      source,
      /editorConfigUnavailableWarnings\(\)/,
      'vscodeConfig must call the probe when it builds the .editorconfig layer'
    );
  });

  it('writes the notice to the shared output channel', () => {
    assert.match(
      source,
      /from\s*'\.\.\/diagnostics\/outputChannel'/,
      'the notice needs the output channel the format trace already uses'
    );
    assert.match(source, /getTidyOutputChannel\(\)/);
    assert.match(source, /\.appendLine\(/);
  });

  // "Once, in the diagnostics surface" is the whole design: a line per format
  // would be the nag the fix deliberately refuses to be.
  it('states it ONCE per session, behind a one-shot flag', () => {
    // Module-scoped `let X = false`, read in an early return, set before the
    // line is written: that ordering IS "once per session". Asserted on the
    // source because the module cannot be loaded here to observe it running.
    const flags = [...source.matchAll(/let\s+(\w+)\s*=\s*false;/g)].map(
      (match) => match[1]
    );
    const flag = flags.find((name) => source.includes(`${name} = true;`));
    assert.ok(
      flag,
      'no module-scoped one-shot flag found (declared flags: ' +
        (flags.join(', ') || 'none') +
        ')'
    );
    const readIndex = source.indexOf(`${flag})`);
    const guardReturn = source.indexOf('return;', readIndex);
    const setIndex = source.indexOf(`${flag} = true;`);
    const logIndex = source.indexOf('appendLine', setIndex);

    assert.ok(readIndex > 0, `${flag} must be READ in a guard, not only set`);
    assert.ok(
      guardReturn > readIndex && guardReturn < setIndex,
      `${flag} must short-circuit with an early return before it is set`
    );
    assert.ok(
      logIndex > setIndex,
      'the channel line must be written after the flag is set, so a throw ' +
        'inside the channel cannot turn the notice into a per-format nag'
    );
  });

  it('adds NO notification and NO setting for the degraded state', () => {
    // A toast on every session of a degraded install is a nag the user cannot
    // act on from there, and there is nothing here to configure.
    assert.ok(
      !/showWarningMessage|showInformationMessage|showErrorMessage/.test(source),
      'vscodeConfig must not raise a notification'
    );
    const manifest = readFileSync(
      join(__dirname, '../../../package.json'),
      'utf8'
    );
    assert.ok(
      !/editorconfigUnavailable|editorconfigWarning/i.test(manifest),
      'the degraded state must not introduce a user setting'
    );
  });

  it('returns the notice to "Show Effective Configuration" as well', () => {
    assert.match(
      source,
      /editorconfigWarnings:\s*editorconfig\.warnings/,
      'readResolvedOptionsWithDiagnostics must forward the warnings'
    );
  });
});
