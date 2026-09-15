// Code-comment accuracy tests (v0.4.1, the "comments that lie" lot).
//
// A false comment is not cosmetic in this repo: comments are quoted as evidence
// in the adversarial review passes, so a wrong one becomes an argument for a
// wrong decision. During v0.4.0 a guard relaxation was justified by a premise
// that a comment asserted and the code did not support, and it had to be
// reverted after it created a real accept-when-not-equivalent.
//
// Each test below therefore does the same thing as readmeClaims.test.ts does for
// prose: it pins a COMMENT to the behaviour that has to hold for it, so the two
// cannot drift apart silently. Nothing here asserts style.
//
// PURE (no 'vscode'): reads repo files from disk and calls pure modules only.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { sanitizeDetail } from '../../../src/diagnostics/lastFormat';
import { findSoukformatrc } from '../../../src/config/soukformatrc';
import {
  UNHONOURED_IGNORE_PREFIX,
  UNHONOURED_IGNORE_PRETTIER_PATH,
  buildMaskPlan
} from '../../../src/engine/maskPlan';

const REPO_ROOT = path.resolve(__dirname, '../../..');

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

/* -------------------------------------------------------------------------- */
/* C-09b : three comments denied what the README honestly discloses             */
/* -------------------------------------------------------------------------- */

describe('comments : the sanitized reason is bounded, NOT source-free', () => {
  // The behaviour these three comments describe, proved once here so the
  // absence-assertions below are not just grep.
  it('sanitizeDetail keeps the parser first line, which can name a token', () => {
    const babelish =
      "Identifier 'CLIENT_SECRET_abc123' has already been declared. (2:7)\n" +
      '> 2 | const CLIENT_SECRET_abc123 = 1;\n' +
      '    |       ^';
    const kept = sanitizeDetail(babelish);
    assert.equal(
      kept,
      "Identifier 'CLIENT_SECRET_abc123' has already been declared. (2:7)",
      'the first line survives verbatim'
    );
    assert.ok(
      kept.includes('CLIENT_SECRET_abc123'),
      'so a token from the user source really can reach a surface'
    );
    assert.ok(
      !kept.includes('const CLIENT_SECRET_abc123 = 1;'),
      'the multi-line code frame is what gets dropped'
    );
    assert.ok(kept.length <= 200 && !kept.includes('\n'));
  });

  const DENIALS: ReadonlyArray<readonly [string, string]> = [
    ['src/commands/previewFormat.ts', 'the guard never embeds source'],
    ['src/diagnostics/lastFormat.ts', 'it never contains any document content'],
    [
      'src/diagnostics/statusBar.ts',
      'Document source can never reach the bar or the tooltip'
    ]
  ];

  for (const [file, denial] of DENIALS) {
    it(`${file} no longer claims "${denial}"`, () => {
      assert.ok(
        !readRepoFile(file).includes(denial),
        `${file} must not deny what the README discloses (see README, "No silent failures")`
      );
    });
  }

  it('each of the three states the bounded contract instead', () => {
    for (const [file] of DENIALS) {
      const source = readRepoFile(file);
      assert.ok(
        /first line/i.test(source),
        `${file} must say what really survives: the parser's first line`
      );
      assert.ok(
        /code frame/i.test(source),
        `${file} must say what is really dropped: the code frame`
      );
    }
  });

  it('the README is the disclosure the three comments now agree with', () => {
    const readmeFlat = readRepoFile('README.md').replace(/\s+/g, ' ');
    assert.ok(
      readmeFlat.includes(
        'that one short line can quote a few characters of the construct that failed'
      ),
      'the README discloses the residual exposure; the comments must not deny it'
    );
  });
});

/* -------------------------------------------------------------------------- */
/* I-5b : prettierrc.ts contradicted itself about findSoukformatrc              */
/* -------------------------------------------------------------------------- */

describe('comments : prettierrc.ts no longer calls findSoukformatrc unbounded', () => {
  it('findSoukformatrc really is bounded by stopDir', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'tidy-walk-'));
    try {
      const workspace = path.join(tmp, 'ws');
      const nested = path.join(workspace, 'src', 'deep');
      mkdirSync(nested, { recursive: true });
      // A config ABOVE the workspace must stay invisible.
      writeFileSync(path.join(tmp, '.soukformatrc'), '{}', 'utf8');
      assert.equal(
        findSoukformatrc(path.join(nested, 'a.css'), workspace),
        undefined,
        'the walk must never leave the workspace folder'
      );
      // The same call finds a config INSIDE the bound, so the test is not vacuous.
      const inside = path.join(workspace, '.soukformatrc');
      writeFileSync(inside, '{}', 'utf8');
      assert.equal(findSoukformatrc(path.join(nested, 'a.css'), workspace), inside);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('the file does not describe that walk as an open defect', () => {
    const source = readRepoFile('src/config/prettierrc.ts');
    assert.ok(
      !/findSoukformatrc unbounded-walk defect/.test(source),
      'v0.4.0 bounded that walk; the comment contradicted the MAX_WALK_DEPTH one below it'
    );
    assert.ok(
      /mirroring findSoukformatrc's bound/.test(source),
      'the sibling comment still states the bound is shared, so both must agree'
    );
  });
});

/* -------------------------------------------------------------------------- */
/* I-22 (comment half) : runMigration.test.ts claimed coverage it does not have */
/* -------------------------------------------------------------------------- */

describe('comments : the runMigration test header states what is really covered', () => {
  const header = readRepoFile('test/unit/migration/runMigration.test.ts');

  it('it no longer claims the integration suite covers the host flow', () => {
    assert.ok(
      !/The host flow itself is covered by the integration suite/.test(header),
      'the host path of src/migration/runMigration.ts is at 0 % line coverage'
    );
  });

  it('and that claim was false: no test anywhere exercises the host flow', () => {
    const suites = [
      'test/integration/onboarding.test.ts',
      'test/integration/lifecycle.test.ts',
      'test/integration/power-features.test.ts'
    ];
    for (const suite of suites) {
      assert.ok(
        !readRepoFile(suite).includes('runMigration'),
        `${suite} does not exercise runMigration, so the header must not say it does`
      );
    }
  });

  it('the header names the untested write path explicitly', () => {
    assert.ok(
      /settings WRITE/.test(header),
      'the write-after-consent path is the one a reader must not assume is tested'
    );
  });
});

/* -------------------------------------------------------------------------- */
/* M3-1 (notice half) : the tidy-ignore advice must be true at BOTH scopes      */
/* -------------------------------------------------------------------------- */

describe('messages : the Prettier-path tidy-ignore notice is true for a selection too', () => {
  it('it no longer promises unconditional native support', () => {
    assert.ok(
      !UNHONOURED_IGNORE_PRETTIER_PATH.includes('which it honours natively'),
      'a range format hands Prettier only the selected span, so a directive outside it does nothing'
    );
  });

  it('it names the condition that makes the advice true', () => {
    assert.ok(UNHONOURED_IGNORE_PRETTIER_PATH.includes('// prettier-ignore'));
    assert.ok(
      /inside the text you format/.test(UNHONOURED_IGNORE_PRETTIER_PATH),
      'the directive only works when it is inside what Prettier is given'
    );
    assert.ok(
      /selection format/.test(UNHONOURED_IGNORE_PRETTIER_PATH),
      'and the selection scope is the case that surprised users'
    );
  });

  it('it still satisfies every constraint a stored notice has', () => {
    assert.ok(UNHONOURED_IGNORE_PRETTIER_PATH.startsWith(UNHONOURED_IGNORE_PREFIX));
    assert.ok(!UNHONOURED_IGNORE_PRETTIER_PATH.includes('\n'));
    assert.ok(
      UNHONOURED_IGNORE_PRETTIER_PATH.length < 200,
      'must survive sanitizeDetail without truncation'
    );
    assert.equal(
      sanitizeDetail(UNHONOURED_IGNORE_PRETTIER_PATH),
      UNHONOURED_IGNORE_PRETTIER_PATH
    );
    // Written as an escape ON PURPOSE: this asserts the absence of the real
    // character, so this file must not contain one itself.
    assert.ok(
      !UNHONOURED_IGNORE_PRETTIER_PATH.includes(String.fromCharCode(0x2014)),
      'no em dash in a shipped string'
    );
    assert.match(UNHONOURED_IGNORE_PRETTIER_PATH, /^[\x20-\x7e]+$/);
  });

  it('the reworded notice is the one the Prettier path really emits', () => {
    // Both scopes: the sentence has to be true wherever it can appear.
    const document = 'const a=1\n// tidy-ignore\nconst b=2\nconst c=3\n';
    for (const scope of ['document', 'selection'] as const) {
      assert.equal(
        buildMaskPlan('typescriptreact', document, scope).unhonouredIgnore,
        UNHONOURED_IGNORE_PRETTIER_PATH,
        scope
      );
    }
  });
});
