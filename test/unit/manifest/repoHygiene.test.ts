// Repo-level hygiene locks (v0.4.1), in the same shape as perfTooling.test.ts:
// PURE (no 'vscode'), reads repo files from disk, needs no built dist/.
//
// Locks three things a gate cannot otherwise see, because none of them is code:
//
//   I-5a  the audit scratch directories (_probe*/) are excluded from BOTH git
//         and the VSIX. Reproduced before the fix: with a planted _probe_x/,
//         `npx @vscode/vsce ls` listed _probe_x/NOTES.md and _probe_x/fixture.css
//         among the 22 packaged files, and only the blanket **/*.ts rule kept
//         the rest of such a directory out. After the fix the same command lists
//         neither, and neither for a nested media/_probe_y/NOTES.md.
//
//   I-16  release.yml cannot publish on a manual dispatch, and passes no token
//         in argv. `github.ref_type` is NOT an event test: a workflow_dispatch
//         started from a tag ref reports ref_type 'tag' exactly like a tag push,
//         so before this both publish steps really ran, irreversibly, on a run
//         the workflow's own header calls a dry run.
//
//   I-5c  no shipped script carries a real U+2014. The repo rule is zero, and
//         check-changelog.mjs was the only one of the six that broke it.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../..');

// Never the raw character in sources: the repo forbids U+2014 in shipped text.
const EM_DASH = String.fromCharCode(0x2014);

function read(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

function lines(relativePath: string): string[] {
  return read(relativePath)
    .split(/\r?\n/)
    .map((line) => line.trim());
}

/* -------------------------------------------------------------------------- */
/* I-5a : the audit scratch directories are ignored by git AND by vsce          */
/* -------------------------------------------------------------------------- */

describe('repo hygiene : _probe*/ can reach neither git nor the VSIX', () => {
  it('.gitignore ignores every probe directory', () => {
    assert.ok(
      lines('.gitignore').includes('_probe*/'),
      'an audit pass creates _probe_bh/, _probe_x/, ... next to the sources'
    );
  });

  it('.vscodeignore excludes them at the root and nested', () => {
    const patterns = lines('.vscodeignore');
    assert.ok(
      patterns.includes('_probe*/**'),
      'vsce packages from the working directory and never reads .gitignore'
    );
    assert.ok(
      patterns.includes('**/_probe*/**'),
      'a probe directory dropped under media/ must be excluded too'
    );
  });

  it('the two files stay mirrored, which is the whole point of the block', () => {
    // The mirror is load-bearing and NOT redundant: git-ignored is not
    // VSIX-excluded, exactly as the secrets block below it already documents.
    assert.ok(read('.gitignore').includes('_probe'));
    assert.ok(read('.vscodeignore').includes('_probe'));
    assert.ok(
      /MIRROR of \.gitignore/.test(read('.vscodeignore')),
      '.vscodeignore must say why the duplication exists'
    );
  });
});

/* -------------------------------------------------------------------------- */
/* I-16 : a manual dispatch cannot publish, and no token rides in argv          */
/* -------------------------------------------------------------------------- */

describe('repo hygiene : release.yml cannot publish on a workflow_dispatch', () => {
  const workflow = read('.github/workflows/release.yml');

  /** The YAML block of one named step, up to the next step's "- name:". */
  function step(name: string): string {
    const start = workflow.indexOf(`- name: ${name}`);
    assert.notEqual(start, -1, `step "${name}" must exist`);
    const next = workflow.indexOf('\n      - name:', start + 1);
    return workflow.slice(start, next === -1 ? undefined : next);
  }

  const PUBLISH_STEPS = ['Publish to VS Marketplace', 'Publish to Open VSX'];

  for (const name of PUBLISH_STEPS) {
    it(`"${name}" is gated on the push event, not only on the ref type`, () => {
      const body = step(name);
      assert.ok(
        body.includes("github.event_name == 'push'"),
        'a dispatch from a tag ref reports ref_type tag, so ref_type alone gates nothing'
      );
      assert.ok(
        body.includes("github.ref_type == 'tag'"),
        'the tag condition stays: both are required'
      );
    });

    it(`"${name}" passes its token through env only, never in argv`, () => {
      // COMMENT LINES ARE EXCLUDED ON PURPOSE: the step explains WHY the flag
      // was removed and therefore quotes it. Only what the runner executes can
      // leak into a process listing.
      const executable = step(name)
        .split(/\r?\n/)
        .filter((line) => !line.trim().startsWith('#'))
        .join('\n');
      assert.ok(
        !/-p\s+"\$(VSCE|OVSX)_PAT"/.test(executable),
        'a token in argv is readable in any process listing on the runner'
      );
      assert.ok(
        /^\s+run: npx /m.test(executable),
        'the step must still run its publish command'
      );
      assert.ok(
        /_PAT: \$\{\{ secrets\./.test(executable),
        'the secret must still reach the step, through env:'
      );
    });
  }

  it('the workflow still declares both triggers and both publishes', () => {
    // Guard against "fixing" the dispatch hole by deleting the trigger, which
    // would take the rehearsal path with it.
    assert.ok(/^on:/m.test(workflow));
    assert.ok(workflow.includes('workflow_dispatch:'));
    assert.ok(workflow.includes("tags:"));
    for (const name of PUBLISH_STEPS) {
      assert.ok(workflow.includes(`- name: ${name}`));
    }
  });

  it('the load-bearing structure around the publishes is untouched', () => {
    // The idempotence probes, the decoupled publishes and the result gate were
    // fixed deliberately after a partial v0.2.2 publish; a later edit must not
    // quietly drop them while tidying the conditions.
    assert.ok(workflow.includes('- name: Probe registries for this version'));
    assert.ok(workflow.includes('- name: Publish result gate'));
    assert.equal(
      (workflow.match(/continue-on-error: true/g) || []).length >= 2,
      true,
      'both publishes stay independent'
    );
    assert.ok(
      workflow.includes('always()'),
      'the Open VSX path must stay reachable after a Marketplace failure'
    );
  });
});

/* -------------------------------------------------------------------------- */
/* I-5c : no real em dash in the repo scripts                                   */
/* -------------------------------------------------------------------------- */

describe('repo hygiene : the build scripts carry no U+2014', () => {
  const scripts = readdirSync(path.join(REPO_ROOT, 'scripts'))
    .filter((name) => name.endsWith('.mjs'))
    .sort();

  it('there are scripts to check (the test is not vacuous)', () => {
    assert.ok(scripts.length >= 5, `expected the script set, got ${scripts.length}`);
  });

  for (const name of scripts) {
    it(`scripts/${name} contains no em dash`, () => {
      assert.ok(
        !read(path.posix.join('scripts', name)).includes(EM_DASH),
        `scripts/${name} must not contain the em dash character`
      );
    });
  }
});
