// Regression guard for audit #16 (v0.3.0 string migration): every user-facing
// string Tidy can surface must be ENGLISH. Most of them live inside handler
// bodies (showInformationMessage / showWarningMessage / showErrorMessage calls)
// with no exported constant to assert on, so this test scans the sources that own
// them for French tokens.
//
// Idiom follows test/unit/manifest/contributions.test.ts: read the file from disk
// and assert on its text. Deliberately scoped to the modules that carried the 17
// French strings, so it can never fail because of an unrelated file.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../..');

/** Sources that used to carry French user-facing strings (audit #16). */
const SCANNED_SOURCES: readonly string[] = [
  'src/commands/previewFormat.ts',
  'src/commands/showConfig.ts',
  'src/commands/useAsFormatter.ts',
  'src/commands/explainLastFormat.ts',
  'src/providers/formattingProvider.ts',
  // v0.3.0 additions: every string they ship is user-facing from day one, so
  // they join the scan rather than waiting for a future audit.
  'src/commands/formatOnSaveOptIn.ts',
  'src/commands/openPlayground.ts',
  'src/commands/statusBarMenu.ts',
  'src/diagnostics/statusBar.ts',
  'src/diagnostics/statusBarHost.ts',
  // ADD-13: every .prettierrc warning it builds is surfaced verbatim by
  // "Show Effective Configuration", so its strings are user-facing too.
  'src/config/prettierrc.ts',
  // ADD-14: every string it builds lands in a QuickPick or the output channel.
  'src/commands/showFormatHistory.ts',
  // v0.4.1 (C-11): the shared defaultFormatter write now composes the failure
  // detail the "could not save the default formatter" toast shows verbatim, so
  // its strings are user-facing too.
  'src/commands/setDefaultFormatter.ts'
];

/**
 * Unambiguously French tokens. Each one appeared verbatim in the strings audit
 * #16 flagged; none of them is an English word, so a match means a French string
 * (or a French comment) crept back in.
 */
const FRENCH_TOKENS: readonly string[] = [
  'aucun',
  'aucune',
  'apercu',
  'annule',
  'fichier',
  'langage',
  'ouvrez',
  'parametres',
  'previsualiser',
  'selectionne',
  'effectue',
  'au-dela',
  'cliquez',
  'formatage'
];

function readSource(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

describe('commands + provider : every shipped user string is English (audit #16)', () => {
  for (const relativePath of SCANNED_SOURCES) {
    it(`${relativePath} carries no French token`, () => {
      const source = readSource(relativePath);
      for (const token of FRENCH_TOKENS) {
        const pattern = new RegExp(`\\b${token}\\b`, 'i');
        assert.doesNotMatch(
          source,
          pattern,
          `French token "${token}" found in ${relativePath}`
        );
      }
    });

    it(`${relativePath} contains no em dash (U+2014)`, () => {
      assert.ok(
        !readSource(relativePath).includes('\u2014'),
        `em dash found in ${relativePath}`
      );
    });
  }

  it('the abort toast and its buttons are English and em-dash-free', () => {
    const source = readSource('src/providers/formattingProvider.ts');
    assert.match(source, /Tidy did not apply the format/);
    assert.match(source, /const ABORT_ACTION_EXPLAIN = 'Explain';/);
    assert.match(source, /const ABORT_ACTION_REPORT_ISSUE = 'Report Issue';/);
  });

  it('the too-large toast is English and offers the Open Settings remedy', () => {
    const source = readSource('src/providers/formattingProvider.ts');
    assert.match(source, /Tidy skipped this file: it is larger than \$\{maxKb\} KB/);
    assert.match(source, /ACTION_OPEN_SETTINGS_LABEL/);
    // ADD-08: the toast and the Open Settings target now name the cap that
    // actually applied (tidy.json.maxFileSizeKB for json/jsonc), resolved once
    // into sizeLimit.settingKey rather than hard-coded to the generic key.
    assert.match(source, /\$\{sizeLimit\.settingKey\}/);
    assert.match(source, /OPEN_SETTINGS_COMMAND_ID,\s*sizeLimit\.settingKey/);
  });

  it('no handler surfaces a raw error.message (the code-frame leak)', () => {
    // Prettier/babel errors embed a code frame carrying the user's SOURCE, so a
    // sanitizer must sit between the error and anything stored or displayed:
    // either the shared `sanitizeDetail(...)` on the same line, or the provider's
    // own first-line helper whose very next line splits on the newline.
    for (const relativePath of SCANNED_SOURCES) {
      const lines = readSource(relativePath).split('\n');
      lines.forEach((line, index) => {
        if (!line.includes('error.message')) {
          return;
        }
        const sanitizedHere = line.includes('sanitizeDetail(error.message)');
        const sanitizedNext = (lines[index + 1] ?? '').includes(".split('\\n', 1)");
        assert.ok(
          sanitizedHere || sanitizedNext,
          `${relativePath}:${index + 1} surfaces a raw error.message: ${line.trim()}`
        );
      });
    }
  });
});
