// Unit tests for the PURE part of the "Show Effective Configuration" command
// (Axe 3.T9 — Show Config surfaces every effective option + its source).
//
// These tests import ONLY the pure report builder + helpers — never the VS Code
// handler — so they run under plain mocha+tsx with no Electron host. The module
// is written with NO top-level 'vscode' import (it requires 'vscode' lazily inside
// the handler), so importing it here does not pull in 'vscode'. A regression that
// re-introduces a top-level 'vscode' import would make this very file fail to load
// (which is the point: the report builder must stay host-free).
//
// What we prove:
//   - the header carries the document path, language, and the .soukformatrc path;
//   - EVERY catalogue option that applies to the active language is listed (set or
//     defaulted) — the direct fix for "not enough options" being invisible;
//   - the SOURCE of each key is surfaced, including the .soukformatrc and the glob
//     override layers (resolved through the real pure resolver);
//   - options that don't apply to a language are omitted from that language's view;
//   - the prettier bag (engineOptions.prettier) is read by engineKey, not flat;
//   - non-fatal warnings are surfaced; defaults show "(default)"; the builder is
//     pure (no I/O, deterministic with an injected timestamp).
import assert from 'node:assert/strict';
import {
  SHOW_CONFIG_COMMAND_ID,
  buildEffectiveConfigReport,
  effectiveValueFor,
  renderLine,
  type ReportInput
} from '../../../src/commands/showConfig';
import { resolveOptions, type ConfigLayer } from '../../../src/config/resolver';
import { OPTION_CATALOG, appliesToLanguage, type CatalogLang } from '../../../src/config/optionCatalog';
import type { LangId, ResolvedOptions } from '../../../src/types';
import { resolved } from '../../helpers/options';

const FIXED_NOW = '2026-06-29T00:00:00.000Z';

function reportFor(
  languageId: LangId,
  options: ResolvedOptions,
  extra: Partial<ReportInput> = {}
): string {
  return buildEffectiveConfigReport({
    documentPath: '/proj/src/file',
    languageId,
    options,
    warnings: [],
    now: FIXED_NOW,
    ...extra
  });
}

/** Resolve options for a language through the REAL pure resolver, layered. */
function resolveFor(languageId: LangId, layers: ConfigLayer[]): ResolvedOptions {
  return resolveOptions({ languageId, layers });
}

describe('commands/showConfig — constants', () => {
  it('exposes the stable command id', () => {
    assert.equal(SHOW_CONFIG_COMMAND_ID, 'tidy.showEffectiveConfiguration');
  });
});

describe('commands/showConfig — header', () => {
  it('shows the document path, language, fixed timestamp and (none found) soukformatrc', () => {
    const report = reportFor('css', resolved({ tabSize: 2 }));
    assert.match(report, /^Tidy Formatter — Effective Configuration$/m);
    assert.match(report, /^Document : \/proj\/src\/file$/m);
    assert.match(report, /^Language : css$/m);
    assert.match(report, new RegExp(`^Resolved : ${FIXED_NOW}$`, 'm'));
    assert.match(report, /^\.soukformatrc : \(none found\)$/m);
  });

  it('resolves the .soukformatrc path in the header when one contributed', () => {
    const report = reportFor('css', resolved(), {
      soukformatrcPath: '/proj/.soukformatrc'
    });
    assert.match(report, /^\.soukformatrc : \/proj\/\.soukformatrc$/m);
  });
});

describe('commands/showConfig — indentation block', () => {
  it('renders tabSize / insertSpaces with their attributed source', () => {
    const options = resolveFor('css', [
      { source: 'FormattingOptions (live, per call)', values: { tabSize: 2, insertSpaces: true } }
    ]);
    const report = reportFor('css', options);
    assert.match(report, /tabSize = 2 .*← FormattingOptions \(live, per call\)/);
    assert.match(report, /insertSpaces = true .*← FormattingOptions \(live, per call\)/);
  });

  it('marks optional editor fields unset when no layer set them', () => {
    const report = reportFor('css', resolved());
    assert.match(report, /endOfLine = \(unset\) .*← \(no layer set this\)/);
    assert.match(report, /trimTrailingWhitespace = \(unset\)/);
    assert.match(report, /insertFinalNewline = \(unset\)/);
  });

  it('shows endOfLine value + source once a layer sets it', () => {
    const options = resolveFor('css', [
      { source: '.editorconfig', values: { end_of_line: 'crlf' } }
    ]);
    const report = reportFor('css', options);
    assert.match(report, /endOfLine = crlf .*← \.editorconfig/);
  });
});

describe('commands/showConfig — full option surface (catalogue-driven)', () => {
  it('lists EVERY js-beautify + core + prettier option that applies to the language', () => {
    // javascript is in all three families (js-beautify js, core, prettier).
    const lang: LangId = 'javascript';
    const report = reportFor(lang, resolved());
    const expected = OPTION_CATALOG.filter((e) =>
      appliesToLanguage(e, lang as CatalogLang)
    );
    assert.ok(expected.length > 0, 'sanity: js has applicable options');
    for (const entry of expected) {
      assert.ok(
        report.includes(entry.settingKey),
        `report must list ${entry.settingKey} for ${lang}`
      );
    }
  });

  it('omits options that do not apply to the active language', () => {
    // CSS-only options (e.g. selector_separator_newline) must not appear for TS,
    // and prettier-only options must not appear for CSS.
    const cssOnly = OPTION_CATALOG.find(
      (e) => e.settingKey === 'tidy.selector_separator_newline'
    );
    const prettierOnly = OPTION_CATALOG.find(
      (e) => e.settingKey === 'tidy.prettier.singleQuote'
    );
    assert.ok(cssOnly && prettierOnly, 'sanity: fixtures present in catalogue');

    const tsReport = reportFor('typescript', resolved());
    assert.ok(!tsReport.includes('tidy.selector_separator_newline'));

    const cssReport = reportFor('css', resolved());
    assert.ok(!cssReport.includes('tidy.prettier.singleQuote'));
  });

  it('shows a defaulted option with its catalogue default and (default) source', () => {
    const entry = OPTION_CATALOG.find((e) => e.settingKey === 'tidy.brace_style');
    assert.ok(entry, 'sanity: brace_style in catalogue');
    const report = reportFor('javascript', resolved());
    const line = report
      .split('\n')
      .find((l) => l.includes('tidy.brace_style ='));
    assert.ok(line, 'brace_style line present');
    assert.match(line as string, /tidy\.brace_style = collapse .*← \(default\)/);
  });

  it('renders the core wrap_line_length family section', () => {
    const report = reportFor('css', resolved());
    assert.match(report, /Cross-engine options \(core\)/);
    assert.ok(report.includes('tidy.wrap_line_length'));
  });
});

describe('commands/showConfig — source attribution per layer', () => {
  it('attributes a global tidy.* value to the VS Code global layer', () => {
    const options = resolveFor('javascript', [
      { source: 'VS Code settings (tidy.*)', values: { brace_style: 'expand' } }
    ]);
    const report = reportFor('javascript', options);
    assert.match(
      report,
      /tidy\.brace_style = expand .*← VS Code settings \(tidy\.\*\)/
    );
  });

  it('attributes a per-language override to the tidy.* [lang] layer (wins over global)', () => {
    const options = resolveFor('javascript', [
      { source: 'VS Code settings (tidy.*)', values: { brace_style: 'collapse' } },
      {
        source: 'VS Code settings (tidy.* [javascript])',
        values: { brace_style: 'expand' }
      }
    ]);
    const report = reportFor('javascript', options);
    assert.match(
      report,
      /tidy\.brace_style = expand .*← VS Code settings \(tidy\.\* \[javascript\]\)/
    );
  });

  it('attributes a .soukformatrc language-section value to that layer', () => {
    const options = resolveFor('css', [
      { source: '.soukformatrc[css]', values: { indent_size: 8 } }
    ]);
    const report = reportFor('css', options, {
      soukformatrcPath: '/proj/.soukformatrc'
    });
    // indent_size maps to the typed tabSize field via the resolver alias.
    assert.match(report, /tabSize = 8 .*← \.soukformatrc\[css\]/);
  });

  it('attributes a .soukformatrc glob override (layer 5) and shows it winning', () => {
    const options = resolveFor('css', [
      { source: '.editorconfig', values: { indent_size: 2 } },
      { source: '.soukformatrc[css]', values: { indent_size: 4 } },
      {
        source: ".soukformatrc overrides[0] (src/**/*.css)",
        values: { indent_size: 8 }
      }
    ]);
    const report = reportFor('css', options);
    assert.match(
      report,
      /tabSize = 8 .*← \.soukformatrc overrides\[0\] \(src\/\*\*\/\*\.css\)/
    );
  });

  it('attributes a prettier stylistic value via its prettier.<engineKey> source', () => {
    const options = resolveFor('typescript', [
      {
        source: 'VS Code settings (tidy.* [typescript])',
        values: { 'prettier.singleQuote': true }
      }
    ]);
    const report = reportFor('typescript', options);
    // The value is nested under engineOptions.prettier but still attributed.
    assert.match(
      report,
      /tidy\.prettier\.singleQuote = true .*← VS Code settings \(tidy\.\* \[typescript\]\)/
    );
  });
});

describe('commands/showConfig — prettier bag reading', () => {
  it('reads a nested prettier value by engineKey, not as a flat key', () => {
    const entry = OPTION_CATALOG.find(
      (e) => e.settingKey === 'tidy.prettier.semi'
    );
    assert.ok(entry, 'sanity: prettier.semi in catalogue');
    const options: ResolvedOptions = resolved({
      engineOptions: { prettier: { semi: false } },
      sources: { 'prettier.semi': '.soukformatrc[typescript]' }
    });
    assert.equal(effectiveValueFor(options, entry), false);
    const report = reportFor('typescript', options);
    assert.match(
      report,
      /tidy\.prettier\.semi = false .*← \.soukformatrc\[typescript\]/
    );
  });

  it('falls back to the prettier catalogue default when the bag lacks the key', () => {
    const entry = OPTION_CATALOG.find(
      (e) => e.settingKey === 'tidy.prettier.semi'
    );
    assert.ok(entry, 'sanity');
    const options = resolved({ engineOptions: { prettier: {} } });
    assert.equal(effectiveValueFor(options, entry), entry.default);
  });
});

describe('commands/showConfig — other attributed sources', () => {
  it('surfaces an attributed source not covered by the catalogue sections', () => {
    const options = resolved({
      engineOptions: { legacy_unknown_opt: 1 },
      sources: { legacy_unknown_opt: '.editorconfig' }
    });
    const report = reportFor('css', options);
    assert.match(report, /Other attributed sources/);
    assert.match(report, /legacy_unknown_opt {2}← \.editorconfig/);
  });

  it('does not add the "Other attributed sources" group when nothing is left over', () => {
    const report = reportFor('css', resolved());
    assert.ok(!report.includes('Other attributed sources'));
  });
});

describe('commands/showConfig — warnings', () => {
  it('surfaces non-fatal .soukformatrc warnings', () => {
    const report = reportFor('css', resolved(), {
      warnings: ['.soukformatrc[css]: unknown option "bogus" ignored.']
    });
    assert.match(report, /\.soukformatrc warnings \(non-fatal\)/);
    assert.match(report, /• \.soukformatrc\[css\]: unknown option "bogus" ignored\./);
  });

  it('omits the warnings section when there are none', () => {
    const report = reportFor('css', resolved());
    assert.ok(!report.includes('warnings (non-fatal)'));
  });
});

describe('commands/showConfig — renderLine + purity', () => {
  it('renderLine aligns the source column and stringifies the value', () => {
    const line = renderLine('k', 4, '(default)');
    assert.match(line, /^ {2}k = 4 +← \(default\)$/);
  });

  it('renderLine JSON-stringifies object values', () => {
    const line = renderLine('bag', { a: 1 }, 'x');
    assert.match(line, /bag = \{"a":1\}/);
  });

  it('is deterministic and does not mutate the input options', () => {
    const options = resolved({
      engineOptions: { prettier: { semi: false } },
      sources: { 'prettier.semi': 'x' }
    });
    const snapshot = JSON.stringify(options);
    const a = reportFor('typescript', options);
    const b = reportFor('typescript', options);
    assert.equal(a, b);
    assert.equal(JSON.stringify(options), snapshot);
  });
});
