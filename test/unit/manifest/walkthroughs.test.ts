// Manifest tests for the onboarding contributions (Axe 1 / 1.T3 + 1.T6).
//
// PURE (no 'vscode'): we read package.json + the referenced media files from
// disk and assert the manifest shape. This locks the anti-hijack-relevant
// invariants at the manifest level so a careless edit can't reintroduce a `*`
// activation, a missing walkthrough asset, or a drifted command title.
//
// Asserts:
//   - the two onboarding commands exist with the harmonised "Tidy" category;
//   - the walkthrough has id `tidy.gettingStarted` with 4 steps, each pointing
//     at an EXISTING media markdown file (no SVG referenced);
//   - the completion events match the ROADMAP (onCommand:tidy.useAsFormatter,
//     onSettingChanged:editor.formatOnSave);
//   - activationEvents contain no `*` and no `onStartupFinished` (ARCH-01/03);
//   - keywords stay <= 10 (DPB-03).
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../../..');

interface CommandContribution {
  command: string;
  title: string;
  category?: string;
}

interface WalkthroughStep {
  id: string;
  title: string;
  description?: string;
  media?: { markdown?: string; image?: string; svg?: string };
  completionEvents?: string[];
}

interface Walkthrough {
  id: string;
  title: string;
  description?: string;
  steps: WalkthroughStep[];
}

interface Manifest {
  activationEvents: string[];
  keywords: string[];
  contributes: {
    commands: CommandContribution[];
    walkthroughs: Walkthrough[];
  };
}

function readManifest(): Manifest {
  const raw = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8');
  return JSON.parse(raw) as Manifest;
}

describe('manifest — onboarding commands (1.T6)', () => {
  const manifest = readManifest();
  const commands = manifest.contributes.commands;

  function find(id: string): CommandContribution {
    const cmd = commands.find((c) => c.command === id);
    assert.ok(cmd, `command '${id}' must be contributed`);
    return cmd!;
  }

  it('declares tidy.useAsFormatter with category Tidy', () => {
    const cmd = find('tidy.useAsFormatter');
    assert.equal(cmd.title, 'Use Tidy as my Formatter');
    assert.equal(cmd.category, 'Tidy');
  });

  it('declares tidy.runMigration with category Tidy', () => {
    const cmd = find('tidy.runMigration');
    assert.equal(cmd.title, 'Migrate from JS-CSS-HTML Formatter');
    assert.equal(cmd.category, 'Tidy');
  });

  it('keeps the existing Show Effective Configuration command under category Tidy', () => {
    const cmd = find('tidy.showEffectiveConfiguration');
    assert.equal(cmd.category, 'Tidy');
  });
});

describe('manifest — walkthrough (1.T3)', () => {
  const manifest = readManifest();
  const walkthroughs = manifest.contributes.walkthroughs;

  it('contributes exactly the tidy.gettingStarted walkthrough', () => {
    assert.ok(Array.isArray(walkthroughs), 'walkthroughs array present');
    const wt = walkthroughs.find((w) => w.id === 'tidy.gettingStarted');
    assert.ok(wt, "walkthrough 'tidy.gettingStarted' must exist");
  });

  it('has 4 steps', () => {
    const wt = walkthroughs.find((w) => w.id === 'tidy.gettingStarted')!;
    assert.equal(wt.steps.length, 4);
  });

  it('each step references an existing markdown media file (no SVG)', () => {
    const wt = walkthroughs.find((w) => w.id === 'tidy.gettingStarted')!;
    for (const step of wt.steps) {
      const md = step.media?.markdown;
      assert.ok(md, `step '${step.id}' must reference markdown media`);
      assert.ok(
        !md!.toLowerCase().endsWith('.svg'),
        `step '${step.id}' must not reference an SVG`
      );
      const abs = path.join(ROOT, md!);
      assert.ok(
        fs.existsSync(abs),
        `walkthrough media '${md}' must exist on disk (it ships in the VSIX)`
      );
    }
  });

  it('completes step 2 on tidy.useAsFormatter and step 3 on editor.formatOnSave', () => {
    const wt = walkthroughs.find((w) => w.id === 'tidy.gettingStarted')!;
    const events = wt.steps.flatMap((s) => s.completionEvents ?? []);
    assert.ok(
      events.includes('onCommand:tidy.useAsFormatter'),
      'a step must complete on the useAsFormatter command'
    );
    assert.ok(
      events.includes('onSettingChanged:editor.formatOnSave'),
      'a step must complete on the editor.formatOnSave setting change'
    );
  });

  it('also completes a step on the migration command', () => {
    const wt = walkthroughs.find((w) => w.id === 'tidy.gettingStarted')!;
    const events = wt.steps.flatMap((s) => s.completionEvents ?? []);
    assert.ok(events.includes('onCommand:tidy.runMigration'));
  });
});

describe('manifest — anti-hijack invariants (ARCH-01/03, DPB-03)', () => {
  const manifest = readManifest();

  it('has no wildcard or onStartupFinished activation event', () => {
    for (const ev of manifest.activationEvents) {
      assert.notEqual(ev, '*', 'activationEvents must not contain "*"');
      assert.notEqual(
        ev,
        'onStartupFinished',
        'activationEvents must not contain "onStartupFinished"'
      );
    }
  });

  it('keeps keywords at 10 or fewer', () => {
    assert.ok(
      manifest.keywords.length <= 10,
      `keywords must be <= 10 (got ${manifest.keywords.length})`
    );
  });
});
