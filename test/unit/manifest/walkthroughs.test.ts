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

describe('manifest : onboarding commands (1.T6)', () => {
  const manifest = readManifest();
  const commands = manifest.contributes.commands;

  function find(id: string): CommandContribution {
    const cmd = commands.find((c) => c.command === id);
    assert.ok(cmd, `command '${id}' must be contributed`);
    return cmd!;
  }

  it('declares tidy.useAsFormatter with category Tidy', () => {
    const cmd = find('tidy.useAsFormatter');
    assert.equal(cmd.title, 'Use Tidy as My Formatter');
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

  it('declares tidy.openPlayground with category Tidy (ADD-03)', () => {
    const cmd = find('tidy.openPlayground');
    assert.equal(cmd.title, 'Open Playground');
    assert.equal(cmd.category, 'Tidy');
  });

  it('leaves tidy.openPlayground palette-available on any language', () => {
    // The playground opens its OWN scratch buffers, so gating it on the active
    // editor's language would hide it exactly when the user has nothing open :
    // the moment the walkthrough targets.
    const cmd = find('tidy.openPlayground');
    assert.equal(
      (cmd as { enablement?: string }).enablement,
      undefined,
      'the playground command must not be gated on editorLangId'
    );
  });
});

describe('manifest : walkthrough (1.T3)', () => {
  const manifest = readManifest();
  const walkthroughs = manifest.contributes.walkthroughs;

  it('contributes exactly the tidy.gettingStarted walkthrough', () => {
    assert.ok(Array.isArray(walkthroughs), 'walkthroughs array present');
    const wt = walkthroughs.find((w) => w.id === 'tidy.gettingStarted');
    assert.ok(wt, "walkthrough 'tidy.gettingStarted' must exist");
  });

  it('has 5 steps in the aha-first order (ADD-03)', () => {
    const wt = walkthroughs.find((w) => w.id === 'tidy.gettingStarted')!;
    assert.deepEqual(
      wt.steps.map((s) => s.id),
      [
        'tidy.gettingStarted.safety',
        'tidy.gettingStarted.tryIt',
        'tidy.gettingStarted.choose',
        'tidy.gettingStarted.formatOnSave',
        'tidy.gettingStarted.migration'
      ]
    );
  });

  it('the Try it now step links the playground and completes on the preview command', () => {
    const wt = walkthroughs.find((w) => w.id === 'tidy.gettingStarted')!;
    const step = wt.steps.find((s) => s.id === 'tidy.gettingStarted.tryIt');
    assert.ok(step, 'the tryIt step must exist');
    assert.equal(step!.title, 'Try it now');
    assert.ok(
      step!.description!.includes('command:tidy.openPlayground'),
      'the step description must carry the playground command link'
    );
    assert.ok(
      step!.description!.includes('command:tidy.previewFormat'),
      'the step must point at the preview command it completes on'
    );
    assert.deepEqual(step!.completionEvents, ['onCommand:tidy.previewFormat']);
    assert.equal(step!.media?.markdown, 'media/walkthrough/tryit.md');
    assert.ok(
      step!.description!.includes('never touch your disk'),
      'the step must state the zero-disk-write promise up front'
    );
  });

  it('every command referenced by a step points at a CONTRIBUTED command', () => {
    // A dead command: link renders as a button that silently does nothing, which
    // is the worst possible first contact. Lock every link against the manifest.
    const contributed = new Set(
      manifest.contributes.commands.map((c) => c.command)
    );
    const wt = walkthroughs.find((w) => w.id === 'tidy.gettingStarted')!;
    for (const step of wt.steps) {
      const description = step.description ?? '';
      for (const match of description.matchAll(/command:([\w.]+)/g)) {
        assert.ok(
          contributed.has(match[1]),
          `step '${step.id}' links command '${match[1]}' which is not contributed`
        );
      }
      for (const event of step.completionEvents ?? []) {
        if (!event.startsWith('onCommand:')) continue;
        const id = event.slice('onCommand:'.length);
        assert.ok(
          contributed.has(id),
          `step '${step.id}' completes on '${id}' which is not contributed`
        );
      }
    }
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

  it('formatOnSave step wording reflects the consent-first opt-in (ADD-04)', () => {
    const wt = walkthroughs.find((w) => w.id === 'tidy.gettingStarted')!;
    const step = wt.steps.find(
      (s) => s.id === 'tidy.gettingStarted.formatOnSave'
    );
    assert.ok(step, 'the formatOnSave walkthrough step must exist');
    const description = step!.description ?? '';
    assert.ok(
      description.includes('confirm'),
      'the step must state that format on save is written only after confirmation'
    );
    assert.ok(
      description.includes('never hooks the save event'),
      'the structural no-save-hook promise must survive verbatim'
    );
    assert.ok(
      !description.includes('never enables Format On Save'),
      'the pre-ADD-04 absolute claim must not survive (the guided opt-in CAN write it, with consent)'
    );
  });

  it('also completes a step on the migration command', () => {
    const wt = walkthroughs.find((w) => w.id === 'tidy.gettingStarted')!;
    const events = wt.steps.flatMap((s) => s.completionEvents ?? []);
    assert.ok(events.includes('onCommand:tidy.runMigration'));
  });
});

describe('manifest : anti-hijack invariants (ARCH-01/03, DPB-03)', () => {
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
