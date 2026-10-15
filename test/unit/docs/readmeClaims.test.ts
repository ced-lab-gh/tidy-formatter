// README accuracy tests.
//
// Tidy's whole value proposition is that it never overstates what it does, so a
// README sentence that is not literally true is a product defect, not a
// cosmetic one. These tests therefore do NOT check prose for its own sake: each
// one pins a README claim to the CODE that has to be true for it, so the
// sentence and the behaviour can never drift apart silently.
//
// Every assertion is written so that changing the behaviour fails here and
// forces the sentence to be rewritten (or the change reverted), which is
// exactly the coupling the product promise needs.
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { chunksForLanguages } from '../../../src/chunks/loader';
import {
  HISTORY_LIMIT,
  clearLastFormat,
  formatChannelLine,
  getLastFormatFor,
  recordLastFormat,
  sanitizeDetail,
  type LastFormatRecord
} from '../../../src/diagnostics/lastFormat';
import { evaluateApplyGate } from '../../../src/commands/previewFormat';
import { OPTION_CATALOG } from '../../../src/config/optionCatalog';
import { resolveOptions } from '../../../src/config/resolver';
import {
  dispatchFormat,
  resolveEngineIdForSource
} from '../../../src/engine/dispatcher';
import { buildMaskPlan } from '../../../src/engine/maskPlan';
import { renderPassive } from '../../../src/diagnostics/statusBar';
import { guard } from '../../../src/safety/guard';
import { buildStatusBarMenuItems } from '../../../src/commands/statusBarMenu';
import {
  JSON_ENGINE_ID,
  reportedEngineIdFor
} from '../../../src/engine/jsbeautify';
import {
  evaluateIgnore,
  findSoukformatignore,
  resolveIgnore
} from '../../../src/ignore/soukformatignore';
import { detectionCanChangeOutcome } from '../../../src/deference/setting';
import { mapLonefyConfigText } from '../../../src/migration/lonefyConfig';
import { LONEFY_SECTIONS } from '../../../src/migration/lonefySections';
import { LONEFY_LOCAL_CONFIG_SEGMENTS } from '../../../src/migration/lonefySources';
import { detectFileIgnore } from '../../../src/ignore/markers';
import {
  EXTENSION_ID,
  NO_WORKSPACE_PENDING_WARNING,
  NO_WORKSPACE_WRITTEN_WARNING,
  defaultFormatterRecapDetail,
  planDefaultFormatterRecap,
  planUseAsFormatter
} from '../../../src/commands/useAsFormatter';
import type { LangId } from '../../../src/types';
import {
  PRETTIERRC_LANGS,
  mapPrettierConfig,
  type PrettierrcWarning
} from '../../../src/config/prettierrc';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const README = readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');

function readSource(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

/** Every .ts file under src/, recursively. */
function listSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSources(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* House style                                                                 */
/* -------------------------------------------------------------------------- */

describe('README : house style', () => {
  it('contains no em dash (U+2014)', () => {
    // Written as an escape ON PURPOSE: this file asserts the absence of the
    // real character, so it must not contain one itself.
    assert.ok(
      !README.includes(String.fromCharCode(0x2014)),
      'README.md must not contain the em dash character'
    );
  });
});

/* -------------------------------------------------------------------------- */
/* "Fast startup, by design": the preloader is LANGUAGE-AWARE                   */
/* -------------------------------------------------------------------------- */

describe('README : "Fast startup, by design" matches the real preloader', () => {
  it('does not claim the preloader warms everything', () => {
    // The pre-ADD-11-audit wording ("warms everything a few seconds after
    // activation") was false once the preload became language-aware.
    assert.ok(
      !/warms everything/i.test(README),
      'the preloader is language-aware: it never warms everything'
    );
  });

  it('the per-language table states exactly what chunksForLanguages returns', () => {
    // CSS family: the PostCSS verifier and NOTHING else. This single fact is
    // what makes the "never evaluates the TypeScript printer" claim true.
    assert.deepEqual(chunksForLanguages(['css', 'scss', 'less']), [
      'chunk-guard-css'
    ]);
    // HTML: parse5 only; an embedded island loads its verifier on first use.
    assert.deepEqual(chunksForLanguages(['html']), ['chunk-guard-html']);
    // JSON family: nothing at all, as the README claims.
    assert.deepEqual(chunksForLanguages(['json', 'jsonc']), []);
    // Plain JS: the Babel verifier, NOT the printer.
    assert.deepEqual(chunksForLanguages(['javascript']), ['chunk-guard-js']);
    // TS/TSX/JSX: printer + verifier.
    for (const lang of ['typescript', 'typescriptreact', 'javascriptreact']) {
      assert.deepEqual(
        chunksForLanguages([lang]),
        ['chunk-prettier', 'chunk-guard-js'],
        lang
      );
    }
  });

  it('a stylesheet-only session provably never PRELOADS the prettier chunk', () => {
    assert.ok(
      !chunksForLanguages(['css', 'scss', 'less']).includes('chunk-prettier'),
      'a CSS-only editor set must not warm the chunk carrying the TS printer'
    );
    assert.ok(
      /never [*]preloaded[*]/.test(README),
      'the README must claim only what this test proves: no PRELOAD'
    );
    // The pre-audit wording claimed that chunk is never EVALUATED for such a
    // session. That is false, and the paragraph then contradicted itself two
    // sentences later: dispatchCssFallback routes a guard-rejected stylesheet
    // through prettierEngine, which lives in chunk-prettier. The overclaim
    // must stay gone.
    assert.ok(
      !/never evaluates the chunk that carries the TypeScript printer/.test(
        README
      ),
      'a guard-rejected stylesheet CAN evaluate that chunk via the CSS fallback'
    );
  });

  it('discloses the CSS fallback, because the TS printer and the PostCSS printer share one chunk', () => {
    // The honesty caveat: chunk-prettier exports BOTH the typescript plugin and
    // the postcss printer used by the CSS guard-rejection fallback, so
    // formatting a stylesheet CAN pull in the chunk the paragraph above says
    // opening one never touches. If the two ever stop sharing a chunk, this
    // test fails and the caveat can be dropped.
    const chunk = readSource('src/chunks/prettierChunk.ts');
    assert.ok(chunk.includes("prettier/plugins/typescript"));
    assert.ok(chunk.includes("prettier/plugins/postcss"));
    assert.ok(
      /second-chance\s+fallback/.test(README),
      'the README must disclose the CSS fallback path to that same chunk'
    );
  });

  it('the stated delay is the delay the code uses', () => {
    const source = readSource('src/extension.ts');
    const match = /IDLE_PRELOAD_DELAY_MS\s*=\s*(\d+)/.exec(source);
    assert.ok(match, 'IDLE_PRELOAD_DELAY_MS must exist');
    assert.equal(Number(match[1]), 5000, 'README says "Five seconds"');
    assert.ok(/Five seconds after activation/.test(README));
  });
});

/* -------------------------------------------------------------------------- */
/* Anti-hijack: what Tidy actually listens to                                  */
/* -------------------------------------------------------------------------- */

describe('README : the event-listener claims are exact', () => {
  const CALL_PATTERN =
    /(?:vscode\.)?(?:window|workspace)\.(on(?:Did|Will)[A-Za-z]+|createFileSystemWatcher)\s*\(/g;

  it('src registers exactly the two repaint-only listeners the README names', () => {
    const found: string[] = [];
    for (const file of listSources(path.join(REPO_ROOT, 'src'))) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(CALL_PATTERN)) {
        found.push(`${path.relative(REPO_ROOT, file)}:${match[1]}`);
      }
    }
    assert.deepEqual(
      found.sort(),
      [
        'src\\diagnostics\\statusBarHost.ts:onDidChangeActiveTextEditor',
        'src\\diagnostics\\statusBarHost.ts:onDidChangeConfiguration'
      ]
        .map((entry) => entry.split('\\').join(path.sep))
        .sort(),
      'the only event subscriptions in the extension must be the two status bar repaints'
    );
  });

  it('the false "no focus trigger" wording is gone, replaced by the exact guarantee', () => {
    assert.ok(
      !/no save\/focus\/file-watcher triggers/.test(README),
      'Tidy does subscribe to the active-editor event; the README must not deny it'
    );
    assert.ok(
      /no editor event can make Tidy format, edit or write anything/i.test(
        README
      ),
      'the README must state the guarantee that actually holds'
    );
    for (const api of [
      'window.onDidChangeActiveTextEditor',
      'workspace.onDidChangeConfiguration'
    ]) {
      assert.ok(
        README.includes(api),
        `the status bar section must name ${api}`
      );
    }
  });

  it('no save hook and no file watcher exists anywhere in src', () => {
    const forbidden = [
      'onWillSaveTextDocument',
      'onDidSaveTextDocument',
      'createFileSystemWatcher'
    ];
    for (const file of listSources(path.join(REPO_ROOT, 'src'))) {
      const text = readFileSync(file, 'utf8');
      for (const api of forbidden) {
        assert.ok(
          !new RegExp(`\\.${api}\\s*\\(`).test(text),
          `${path.relative(REPO_ROOT, file)} must not call ${api}`
        );
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/* "Explain Last Format" is per-file, but bounded                               */
/* -------------------------------------------------------------------------- */

describe('README : the Explain Last Format bound is the real one', () => {
  afterEach(() => {
    clearLastFormat();
  });

  function record(uri: string): LastFormatRecord {
    return {
      uri,
      fileName: uri,
      languageId: 'css',
      status: 'applied',
      scope: 'document',
      at: new Date().toISOString()
    };
  }

  it('states the 50-attempt window instead of promising unbounded exactness', () => {
    assert.equal(HISTORY_LIMIT, 50, 'the README quotes this number');
    assert.ok(
      !/stays exact however many files you have open/.test(README),
      'that promise is not true past the bounded window'
    );
    assert.ok(
      /50 most recent attempts/.test(README),
      'the README must state the real bound'
    );
  });

  it('a file IS forgotten once HISTORY_LIMIT later attempts land elsewhere', () => {
    clearLastFormat();
    recordLastFormat(record('file:///a.css'));
    assert.ok(getLastFormatFor('file:///a.css'), 'freshly recorded');
    for (let i = 0; i < HISTORY_LIMIT; i += 1) {
      recordLastFormat(record(`file:///other-${i}.css`));
    }
    assert.equal(
      getLastFormatFor('file:///a.css'),
      undefined,
      'evicted: this is exactly what the README now discloses'
    );
  });

  it('is still exact for a file inside the window, whatever else is open', () => {
    clearLastFormat();
    recordLastFormat(record('file:///a.css'));
    recordLastFormat(record('file:///b.css'));
    assert.equal(getLastFormatFor('file:///a.css')?.uri, 'file:///a.css');
  });
});

/* -------------------------------------------------------------------------- */
/* Preview: Apply can legitimately write nothing                                */
/* -------------------------------------------------------------------------- */

describe('README : the preview Apply staleness gate is documented', () => {
  it('Apply refuses when the buffer moved on, and the README says so', () => {
    const stale = evaluateApplyGate({
      previewVersion: 4,
      currentVersion: 5,
      previewInput: 'a{}',
      currentText: 'a{ }'
    });
    assert.equal(stale.ok, false);
    assert.ok(
      /nothing is written\*\* and Tidy asks you to preview again/i.test(README),
      'the README must not promise that Apply always writes'
    );
  });

  it('Apply writes when the buffer is untouched', () => {
    assert.deepEqual(
      evaluateApplyGate({
        previewVersion: 4,
        currentVersion: 4,
        previewInput: 'a{}',
        currentText: 'a{}'
      }),
      { ok: true }
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The .prettierrc layer                                                        */
/* -------------------------------------------------------------------------- */

describe('README : the .prettierrc layer is described exactly', () => {
  it('covers plain .js, because the layer really does', () => {
    assert.ok(
      PRETTIERRC_LANGS.includes('javascript'),
      'the layer is built for plain javascript too (JSX re-routing)'
    );
    assert.ok(
      !/On the TypeScript\/TSX\/JSX path, Tidy also honours/.test(README),
      'that wording omitted the .js-with-JSX case the code covers'
    );
    assert.ok(
      /a plain `\.js` file that turns out to contain JSX/.test(README),
      'the README must name the .js-with-JSX case'
    );
  });

  it('does not claim the resolution is exactly Prettier\'s', () => {
    // Tidy stops at the workspace folder, never executes code configs and never
    // resolves a shareable config, so "resolved exactly like Prettier does" was
    // an overstatement. The search ORDER is Prettier's; the resolution is not.
    assert.ok(!/resolved exactly like Prettier does/.test(README));
    assert.ok(/found in Prettier's own search order/.test(README));
  });

  it('the twelve keys the README lists are exactly the twelve the mapper honours', () => {
    const listed = /Only twelve AST-safe stylistic keys are read \(([^)]+)\)/.exec(
      README
    );
    assert.ok(listed, 'the README must list the honoured keys');
    const readmeKeys = [...listed[1].matchAll(/`([A-Za-z]+)`/g)]
      .map((m) => m[1])
      .sort();
    assert.equal(readmeKeys.length, 12, 'the README says twelve');

    const sample: Record<string, unknown> = {
      printWidth: 100,
      tabWidth: 2,
      useTabs: false,
      semi: false,
      singleQuote: true,
      jsxSingleQuote: true,
      trailingComma: 'all',
      bracketSpacing: false,
      bracketSameLine: true,
      arrowParens: 'avoid',
      singleAttributePerLine: true,
      objectWrap: 'collapse'
    };
    assert.deepEqual(
      Object.keys(sample).sort(),
      readmeKeys,
      'the README list must match the keys this test feeds the mapper'
    );

    const warnings: PrettierrcWarning[] = [];
    const values = mapPrettierConfig(
      sample,
      'typescript',
      'test',
      warnings,
      'prettier'
    );
    assert.deepEqual(warnings, [], 'every listed key must be honoured');
    assert.equal(
      Object.keys(values).length,
      12,
      'twelve keys in, twelve resolved values out'
    );
  });

  it('an unlisted key is ignored with a warning, as the README claims', () => {
    for (const key of ['parser', 'plugins', 'overrides', 'endOfLine']) {
      const warnings: PrettierrcWarning[] = [];
      const values = mapPrettierConfig(
        { [key]: 'whatever' },
        'typescript',
        'test',
        warnings,
        'prettier'
      );
      assert.deepEqual(values, {}, `${key} must contribute nothing`);
      assert.equal(warnings.length, 1, `${key} must be reported`);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The claim audit of 2026-09: every sentence below was false as written.       */
/* Each test pins the corrected sentence to the code that makes it true.        */
/* -------------------------------------------------------------------------- */

const PACKAGE_JSON = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')
) as {
  activationEvents: string[];
  contributes: {
    commands: { command: string; title: string }[];
    configuration:
      | { properties?: Record<string, Record<string, unknown>> }
      | { properties?: Record<string, Record<string, unknown>> }[];
    configurationDefaults?: Record<string, unknown>;
  };
};

/** README text with every run of whitespace collapsed, for wrapped phrases. */
const README_FLAT = README.replace(/\s+/g, ' ');

/**
 * Every `tidy.*` property VS Code actually contributes, with its scope.
 * The manifest splits them across several titled sections, so flatten them:
 * a property missed here would silently weaken every scope assertion below.
 */
function manifestProperties(): Record<string, Record<string, unknown>> {
  const config = PACKAGE_JSON.contributes.configuration;
  const sections = Array.isArray(config) ? config : [config];
  const flat: Record<string, Record<string, unknown>> = {};
  for (const section of sections) {
    for (const [key, value] of Object.entries(section.properties ?? {})) {
      assert.ok(!(key in flat), `${key} is declared in two sections`);
      flat[key] = value;
    }
  }
  assert.ok(Object.keys(flat).length > 0, "the manifest must contribute settings");
  return flat;
}

/* --- 1. "the complete js-beautify surface" was false ---------------------- */

describe('README : the option-surface claim is a count, not a boast', () => {
  /** Every option name js-beautify itself declares, across its four modules. */
  function jsBeautifyDeclaredOptions(): Set<string> {
    const names = new Set<string>();
    for (const mod of ['core', 'css', 'html', 'javascript']) {
      const source = readFileSync(
        path.join(REPO_ROOT, 'node_modules/js-beautify/js/src', mod, 'options.js'),
        'utf8'
      );
      for (const m of source.matchAll(/this\._get_[a-z_]+\(['"]([a-z_0-9]+)['"]/g)) {
        names.add(m[1]);
      }
    }
    return names;
  }

  it('does NOT claim to expose the complete js-beautify surface', () => {
    assert.ok(
      !/exposes the complete js-beautify surface/.test(README),
      'Tidy exposes a curated subset; that sentence was false'
    );
  });

  it('the numbers in the README are the numbers in the catalogue', () => {
    const prettier = OPTION_CATALOG.filter((e) => e.engine === 'prettier');
    const beautify = OPTION_CATALOG.filter((e) => e.engine !== 'prettier');
    assert.equal(beautify.length, 25, 'README says 25 js-beautify options');
    assert.equal(prettier.length, 10, 'README says 10 Prettier options');
    assert.equal(OPTION_CATALOG.length, 35, 'README says 35 style settings');
    assert.ok(/\*\*25\*\* js-beautify options/.test(README));
    assert.ok(/\*\*10\*\* AST-safe Prettier stylistic options/.test(README));
    assert.ok(/35 style settings in all/.test(README));
    assert.ok(
      README.includes('from `tidy.indent` through `tidy.prettier.objectWrap`'),
      'the language-overridable range must end at the last catalogue entry'
    );
    assert.equal(
      OPTION_CATALOG[OPTION_CATALOG.length - 1].settingKey,
      'tidy.prettier.objectWrap',
      'the README range names the last catalogue entry'
    );
  });

  it('js-beautify really declares 47 options; the README names the ones still missing and the ones now exposed', () => {
    const declared = jsBeautifyDeclaredOptions();
    assert.equal(declared.size, 47, 'the README quotes this number');
    assert.ok(/declares 47 options/.test(README));

    const exposed = new Set(OPTION_CATALOG.map((e) => e.engineKey));
    // Still missing: js-beautify declares them, Tidy does not expose them, and
    // the README says so by name.
    for (const missing of [
      'end_with_newline',
      'wrap_attributes_min_attrs',
      'templating'
    ]) {
      assert.ok(declared.has(missing), `js-beautify must declare ${missing}`);
      assert.ok(!exposed.has(missing), `Tidy must not expose ${missing} yet`);
      assert.ok(
        README.includes('`' + missing + '`'),
        `the README must name ${missing} among the options it does NOT expose`
      );
    }
    // Exposed since 0.5.0: the README must no longer list them as missing, and
    // must name their Tidy setting.
    const missingSentence =
      /keys such as ([^.]*) are \*\*not\*\* exposed today/.exec(README)?.[1] ?? '';
    for (const added of [
      'space_before_conditional',
      'content_unformatted',
      'void_elements',
      'jslint_happy'
    ]) {
      assert.ok(declared.has(added), `js-beautify must declare ${added}`);
      assert.ok(exposed.has(added), `Tidy must now expose ${added}`);
      assert.ok(
        !missingSentence.includes(added),
        `${added} is exposed, so the "not exposed" sentence must not list it`
      );
      assert.ok(
        README.includes('`tidy.' + added + '`'),
        `the README must name tidy.${added}`
      );
    }
    for (const added of ['singleAttributePerLine', 'objectWrap']) {
      assert.ok(
        exposed.has(added),
        `the Prettier option ${added} is in the catalogue`
      );
      assert.ok(
        README.includes('`tidy.prettier.' + added + '`'),
        `the README must name tidy.prettier.${added}`
      );
    }
  });
});

/* --- 2. "Every option above is language-overridable" was false ------------ */

describe('README : the per-language override claim names the real exceptions', () => {
  it('every catalogue (style) option really is language-overridable', () => {
    const props = manifestProperties();
    for (const entry of OPTION_CATALOG) {
      assert.equal(
        entry.scope,
        'language-overridable',
        `${entry.settingKey} is documented as language-overridable`
      );
      assert.equal(
        props[entry.settingKey]?.scope,
        'language-overridable',
        `${entry.settingKey} must carry that scope in the manifest too`
      );
    }
  });

  it('the behaviour switches the README excludes really lack that scope', () => {
    const props = manifestProperties();
    const excluded = [
      'tidy.maxFileSizeKB',
      'tidy.json.maxFileSizeKB',
      'tidy.editorconfig',
      'tidy.prettier.respectProjectConfig',
      'tidy.soukformatrc',
      'tidy.respectSoukformatignore',
      'tidy.deferToOtherFormatters',
      'tidy.statusBar.enable'
    ];
    for (const key of excluded) {
      assert.ok(props[key], `${key} must exist in the manifest`);
      assert.notEqual(
        props[key].scope,
        'language-overridable',
        `${key} is NOT language-overridable, so the README must exclude it`
      );
      assert.ok(
        README.includes('`' + key + '`'),
        `the README must name ${key} as an exception`
      );
    }
    for (const [key, value] of Object.entries(props)) {
      if (/^tidy\.[a-z]+\.enable$/.test(key)) {
        assert.notEqual(
          value.scope,
          'language-overridable',
          `${key} is per-language by construction, not language-overridable`
        );
      }
    }
    assert.ok(
      !/\*\*Per-language overrides\.\*\* Every option above is/.test(README),
      'that blanket sentence covered 18 properties for which it was false'
    );
  });
});

/* --- 3. defaultFormatter: the product's single most important claim ------- */

describe('README : the editor.defaultFormatter claim is exact and consistent', () => {
  it('the manifest contributes no default-formatter setting at all', () => {
    assert.equal(
      PACKAGE_JSON.contributes.configurationDefaults,
      undefined,
      'contributing configurationDefaults would set editor.* on install'
    );
    for (const key of Object.keys(manifestProperties())) {
      assert.ok(key.startsWith('tidy.'), `${key} escapes the tidy.* namespace`);
    }
  });

  it('but the code DOES write it, so no README sentence may deny that', () => {
    const writer = readSource('src/commands/setDefaultFormatter.ts');
    assert.ok(
      /\.update\('defaultFormatter', EXTENSION_ID/.test(writer),
      'setDefaultFormatterForLangs really writes editor.defaultFormatter'
    );
    for (const denial of [
      'never contributes or sets `editor.defaultFormatter`',
      'does not contribute or write `editor.defaultFormatter`',
      'It never registers itself as your default formatter'
    ]) {
      assert.ok(
        !README.includes(denial),
        `"${denial}" is false: the opt-in command writes that key`
      );
    }
  });

  it('every occurrence uses the one defensible wording', () => {
    const canonical = 'never contributes `editor.defaultFormatter` in its manifest';
    const consent = 'never writes it without an explicit confirmation from you';
    const canonicalCount = README.split(canonical).length - 1;
    assert.ok(
      canonicalCount >= 4,
      `expected the canonical claim throughout, got ${canonicalCount}`
    );
    assert.equal(
      README.split(consent).length - 1,
      canonicalCount,
      'the manifest half and the consent half must always travel together'
    );
  });
});

/* --- 5. deference detects ESLint too ------------------------------------- */

describe('README : deference lists every detector the code has', () => {
  it('the code really detects ESLint, and both docs say so', () => {
    const detect = readSource('src/deference/detect.ts');
    for (const name of ['.eslintrc', 'eslint.config.js', 'eslintConfig']) {
      assert.ok(detect.includes(name), `detect.ts must know ${name}`);
    }
    assert.ok(
      /`\.eslintrc\*` \/ `eslint\.config\.\*`/.test(README),
      'the deference section must list the ESLint config forms'
    );
    const deferSetting = manifestProperties()['tidy.deferToOtherFormatters'];
    for (const field of ['description', 'markdownDescription']) {
      assert.ok(
        String(deferSetting[field]).includes('ESLint'),
        `tidy.deferToOtherFormatters ${field} must mention ESLint`
      );
    }
  });

  it('.eslintignore alone is excluded, exactly as the README says', () => {
    const detect = readSource('src/deference/detect.ts');
    assert.ok(
      !/'\.eslintignore'/.test(detect),
      '.eslintignore must not be a detector'
    );
    assert.ok(/`\.eslintignore` is excluded for the same reason/.test(README));
  });
});

/* --- 6. idempotence is a corpus property, not a per-format check ---------- */

describe('README : idempotence is described as what it is', () => {
  it('the idempotence check has NO production caller', () => {
    const callers: string[] = [];
    for (const file of listSources(path.join(REPO_ROOT, 'src'))) {
      if (path.basename(file) === 'guard.ts') continue; // the definition itself
      if (/\bidempotence\s*\(/.test(readFileSync(file, 'utf8'))) {
        callers.push(path.relative(REPO_ROOT, file));
      }
    }
    assert.deepEqual(
      callers,
      [],
      'if idempotence ever runs per format, the README must stop saying it does not'
    );
    // And it is not wired into the guard's own dispatch either.
    const guardSource = readSource('src/safety/guard.ts');
    const dispatch = guardSource.slice(guardSource.indexOf('function checkByLang'));
    assert.ok(
      !/\bidempotence\s*\(/.test(dispatch),
      'checkByLang must not call idempotence'
    );
  });

  it('the README says corpus-verified, not enforced-per-format', () => {
    assert.ok(
      /\*\*Idempotence, verified in the test corpus, not per format\.\*\*/.test(
        README
      )
    );
    assert.ok(
      /this is a property the test\s+suite proves, \*\*not\*\* a check run on each format/.test(
        README
      )
    );
  });
});

/* --- 7. the before/after blocks are byte-exact engine output -------------- */

describe('README : the before/after blocks are the real engine output', () => {
  /** engineOptions exactly as VS Code produces them when nothing is configured. */
  function defaultEngineOptions(): Record<string, unknown> {
    const engineOptions: Record<string, unknown> = {};
    const prettier: Record<string, unknown> = {};
    for (const entry of OPTION_CATALOG) {
      if (entry.engine === 'prettier') prettier[entry.engineKey] = entry.default;
      else engineOptions[entry.engineKey] = entry.default;
    }
    engineOptions.prettier = prettier;
    return engineOptions;
  }

  /** Every fenced block of the given language, normalised to LF. */
  function fencedBlocks(lang: string): string[] {
    const out: string[] = [];
    const re = new RegExp('```' + lang + '\\r?\\n([\\s\\S]*?)```', 'g');
    for (const m of README.matchAll(re)) out.push(m[1].replace(/\r\n/g, '\n'));
    return out;
  }

  const CASES = [
    { lang: 'css' as const, fence: 'css', sample: 'messy.css' },
    { lang: 'typescriptreact' as const, fence: 'tsx', sample: 'messy.tsx' }
  ];

  for (const c of CASES) {
    it(`the ${c.fence} "after" block equals dispatchFormat at tabSize 4`, async () => {
      const input = readFileSync(
        path.join(REPO_ROOT, 'samples', c.sample),
        'utf8'
      );
      const output = await dispatchFormat({
        languageId: c.lang,
        code: input,
        options: {
          tabSize: 4,
          insertSpaces: true,
          engineOptions: defaultEngineOptions(),
          sources: {}
        }
      });
      assert.equal(
        guard.check(c.lang, input, output).equivalent,
        true,
        'the documented output must itself pass the guard'
      );

      // Drop each block's leading "// after" comment line before comparing.
      const blocks = fencedBlocks(c.fence).map((b) =>
        b.split('\n').slice(1).join('\n')
      );
      assert.ok(
        blocks.some((b) => b.trim() === output.trim()),
        `no ${c.fence} block in the README matches the real output.\n` +
          `--- real output ---\n${output}\n--- README blocks ---\n` +
          blocks.map((b) => JSON.stringify(b)).join('\n')
      );
    });
  }

  it('the CSS block is 4-space indented, as the default tab size implies', () => {
    const after = fencedBlocks('css').find((b) =>
      /after, at the default tab size of 4/.test(b)
    );
    assert.ok(after, 'the CSS "after" block must be labelled with its tab size');
    assert.ok(
      /\n {4}display: flex;/.test(after as string),
      'the documented default tabSize is 4, so the block must use four spaces'
    );
    assert.ok(
      !/\n {3}display: flex;/.test(after as string),
      'the stale 3-space block must stay gone'
    );
  });
});

/* --- 8. the output-channel line is a PRIVACY claim: make it exhaustive ---- */

describe('README : the output-channel detail is described exhaustively', () => {
  it('the channel line carries exactly the fields the README lists', () => {
    const line = formatChannelLine({
      uri: 'file:///w/app.css',
      fileName: 'app.css',
      languageId: 'css',
      status: 'ignored-file',
      scope: 'selection',
      engineId: 'jsbeautify',
      detail: '/w/.soukformatignore',
      at: '2026-09-07T10:00:00.000Z'
    });
    // Timestamp, file NAME, language, engine, status, scope, reason: seven
    // things, not the "language, engine and a short reason" the README claimed.
    for (const field of [
      '2026-09-07T10:00:00.000Z',
      'app.css',
      'css',
      'jsbeautify',
      'ignored-file',
      '(selection)',
      '/w/.soukformatignore'
    ]) {
      assert.ok(line.includes(field), `the channel line carries ${field}`);
    }
    assert.ok(
      !/only the language, engine, and a short\s+reason/.test(README),
      'that list omitted the timestamp, the file name and the ignore path'
    );
    for (const disclosed of [
      'an ISO timestamp',
      "the file's name",
      'its language id',
      'the engine id',
      'the path of the `.soukformatignore`'
    ]) {
      assert.ok(
        README.includes(disclosed),
        `the README must disclose ${disclosed}`
      );
    }
  });

  it('the sanitizer really bounds the reason to one line and 200 chars', () => {
    const nasty =
      'boom: const secret = 1;\n  at Object.<anonymous> (/w/app.ts:1:1)';
    assert.equal(sanitizeDetail(nasty), 'boom: const secret = 1;');
    assert.equal(sanitizeDetail('x'.repeat(500)).length, 200);
    assert.ok(/capped at 200 characters/.test(README));
  });
});

/* --- 9. "editors you have open" was really visibleTextEditors ------------- */

describe('README : the preloader reads VISIBLE editors', () => {
  it('the code reads window.visibleTextEditors and the README says so', () => {
    const extension = readSource('src/extension.ts');
    assert.ok(
      /vscode\.window\.visibleTextEditors/.test(extension),
      'the preloader must read visibleTextEditors'
    );
    assert.ok(
      !/vscode\.workspace\.textDocuments/.test(extension),
      'it does NOT read every open document'
    );
    assert.ok(/`window\.visibleTextEditors`/.test(README));
    assert.ok(
      /a file\s*\r?\nsitting in a background tab is not among them/.test(README),
      'the README must spell out what "visible" excludes'
    );
    assert.ok(
      !/editors you have open \*\*at that instant\*\*/.test(README),
      'that wording promised more editors than the code reads'
    );
  });
});

/* --- 10. activationEvents plus the implicit onCommand of VS Code 1.74+ ---- */

describe('README : activation is described including implicit command activation', () => {
  it('the manifest declares only onLanguage events', () => {
    for (const event of PACKAGE_JSON.activationEvents) {
      assert.ok(
        event.startsWith('onLanguage:'),
        `${event} is not an onLanguage activation`
      );
    }
    assert.equal(PACKAGE_JSON.activationEvents.length, 11);
  });

  it('the README does not claim languages are the ONLY way Tidy activates', () => {
    // VS Code 1.74+ activates an extension when one of its contributed commands
    // runs, whether or not onCommand:* is declared (implicit activation events,
    // shipped in the November 2022 release). Tidy contributes commands, so an
    // "only on these languages" claim would be false.
    assert.ok(
      PACKAGE_JSON.contributes.commands.length > 0,
      'Tidy contributes commands, so implicit onCommand activation applies'
    );
    assert.ok(
      /since VS Code 1\.74 an extension is additionally activated when one of its contributed commands is invoked/.test(
        README
      ),
      'the README must disclose implicit command activation'
    );
    assert.ok(
      !/never activates except on these languages/i.test(README),
      'that claim would ignore implicit command activation'
    );
  });
});

/* --- 11. no rasterised em dash can ship inside the VSIX ------------------- */

describe('house style : the generated visuals carry no em dash either', () => {
  const EM_DASH = String.fromCharCode(0x2014);

  it('the generator never renders one, so the PNG cannot contain one', () => {
    const generator = readFileSync(
      path.join(REPO_ROOT, 'scripts/build-visuals.mjs'),
      'utf8'
    );
    assert.ok(
      !generator.includes(EM_DASH),
      'build-visuals.mjs rasterises its strings into a shipped PNG'
    );
    assert.ok(
      generator.includes("title: 'After : Tidy'"),
      'the panel title must use the separator the SVG siblings already use'
    );
  });

  it('the committed SVGs (the exact source of the PNGs) carry none', () => {
    for (const name of ['css.svg', 'tsx.svg']) {
      const svg = readFileSync(
        path.join(REPO_ROOT, 'media/before-after', name),
        'utf8'
      );
      assert.ok(!svg.includes(EM_DASH), `${name} must not render an em dash`);
      assert.ok(svg.includes('After : Tidy'), `${name} must be regenerated`);
    }
  });
});

/* --- 12. every quoted incumbent review must be verbatim ------------------- */

describe('README : every quoted review is verbatim in the mining corpus', () => {
  const MINING_DIR = path.join(REPO_ROOT, '_internal/mining/data');

  /** Collapse runs of whitespace, exactly as the README says it renders quotes. */
  function normalise(text: string): string {
    return text.replace(/\s+/g, ' ');
  }

  function corpus(): string | undefined {
    const files = [
      'store_reviews_text.md',
      'store_reviews_raw.json',
      'github_issues_raw.json',
      'github_issues_index.csv'
    ];
    const parts: string[] = [];
    for (const name of files) {
      try {
        parts.push(
          readFileSync(path.join(MINING_DIR, name), 'utf8').replace(/^﻿/, '')
        );
      } catch {
        return undefined; // _internal/ is gitignored: absent on a fresh clone
      }
    }
    // The JSON dumps store quotes as \" and newlines as \n inside strings;
    // unescape so an issue title containing quotation marks matches literally.
    return normalise(
      parts.join('\n').split('\\"').join('"').split('\\n').join(' ')
    );
  }

  /**
   * Every quoted incumbent string in the comparison table, verified by hand
   * against _internal/mining/ on 2026-09-07. Two of them were ALTERED before
   * that audit ("package.json" for the reviewer's "packages.json", and
   * "adds whitespace" for "add whitespaces"); this list keeps them honest.
   */
  const QUOTES = [
    'Does not respect onSave: false.',
    'Always formats on save regardless of "editor.formatOnSave"',
    'Formats code when you save it, regardless of your default formatter.',
    'Prevents every other formatter from working.',
    'It formats <App /> to < App / >',
    'Changing my valid "?." to "? ." on save',
    'breaks Null coalescing operator',
    'big integer number like 1n are formatted as 1 n by it, which results in a syntax error',
    'When saving using 2 spaces instead of tabs, it changes to 4 spaces.',
    'cannot set to 2 spaces',
    'every time I save the file it just randomly add space to some class name or id name.',
    'randomly add space to some class name or id name',
    'it would add whitespaces after all of my ids and classes',
    'SASS interpolation breaks CSS calc() statement',
    'It keeps re-formatting my packages.json, which is the last file you ever want to re-format.',
    'Json formatting is set to true by default!',
    'rewrites another files after copy-paste',
    'Reproducible bug, copying contents of files on file save',
    'plugin ignores all other editor settings'
  ];

  it('the README still quotes exactly the strings this test verifies', () => {
    // Backticks are rendering, not content: strip them before looking a quote
    // up, but never change a character of the words themselves.
    const rendered = normalise(README.split('`').join(''));
    for (const quote of QUOTES) {
      assert.ok(
        rendered.includes(normalise(quote)),
        `the README no longer contains the verified quote: ${quote}`
      );
    }
  });

  it('each quote is a verbatim substring of the mined source', function () {
    const haystack = corpus();
    if (haystack === undefined) {
      // Local-only data (_internal/ is gitignored). Never silently pass on a
      // machine that HAS it.
      this.skip();
      return;
    }
    for (const quote of QUOTES) {
      assert.ok(
        haystack.includes(normalise(quote)),
        `NOT VERBATIM in the mining corpus: ${quote}`
      );
    }
  });

  it('the two altered quotes the audit caught can never come back', () => {
    for (const altered of [
      'It keeps re-formatting my package.json',
      'adds whitespace after all of my ids and classes'
    ]) {
      assert.ok(
        !README.includes(altered),
        `"${altered}" is NOT what the reviewer wrote`
      );
    }
    // Issue #92 is titled "Please consider withdrawing this extension from VS
    // Code Marketplace", so a review quote must never be attributed to it.
    assert.ok(
      !/issues\/92\), "prevents every other formatter from working"/.test(README),
      'that quote is a Marketplace review, not the text of issue #92'
    );
  });

  it('the README states the exact normalisation it applies to quotes', () => {
    assert.ok(
      /Everything inside quotation marks is \*\*verbatim\*\*/.test(README),
      'the promise this whole suite enforces must be written down'
    );
    assert.ok(
      !/Where a quote is shortened, the meaning is preserved\./.test(README),
      '"the meaning is preserved" licensed exactly the alterations found'
    );
  });
});

/* --- 13. the incumbent's numbers are dated and match the mining note ------ */

describe('README : the incumbent figures are the dated, measured ones', () => {
  it('quotes the 2026-09-07 measurement and nothing else', () => {
    assert.ok(
      /Measured on the Marketplace `extensionquery` API on 2026-09-07/.test(README)
    );
    assert.ok(/\*\*3,969,079 installs\*\*/.test(README));
    assert.ok(/\*\*1\.69★ average over 241 ratings\*\*/.test(README));
    assert.ok(/last version \(0\.2\.3\) published on \*\*2017-03-31\*\*/.test(README));
    for (const stale of ['~3.95M installs', 'roughly 1.7']) {
      assert.ok(!README.includes(stale), `${stale} was undated and approximate`);
    }
  });

  it('the mining note carries the same dated figures', function () {
    let note: string;
    try {
      note = readFileSync(
        path.join(REPO_ROOT, '_internal/mining/MINING.md'),
        'utf8'
      );
    } catch {
      this.skip();
      return;
    }
    for (const fact of ['2026-09-07', '3 969 079', '1,6929', '241', '2017-03-31']) {
      assert.ok(note.includes(fact), `MINING.md must record ${fact}`);
    }
  });
});

/* --- 14. command titles: one source of truth, the manifest --------------- */

describe('README : command titles match the manifest exactly', () => {
  it('every title the README uses is a title the manifest declares', () => {
    for (const command of PACKAGE_JSON.contributes.commands) {
      assert.ok(
        README.includes(command.title),
        `the README must use the manifest title for ${command.command}: "${command.title}"`
      );
    }
    for (const wrong of ['Use Tidy as my Formatter', 'Preview Format (diff)']) {
      assert.ok(!README.includes(wrong), `"${wrong}" is not the manifest title`);
    }
  });

  it('the status bar menu is quoted with ITS labels, not the command titles', () => {
    for (const item of buildStatusBarMenuItems()) {
      const label = item.label.replace(/^\$\([a-z-]+\)\s*/, '');
      assert.ok(
        README_FLAT.includes(label),
        `the status bar section must use the real menu label "${label}"`
      );
    }
  });

  it('the .prettierrc setting description covers plain .js with JSX', () => {
    const prop = manifestProperties()['tidy.prettier.respectProjectConfig'];
    for (const field of ['description', 'markdownDescription']) {
      assert.ok(
        String(prop[field]).includes(
          'a plain .js file that turns out to contain JSX'
        ),
        `${field} must not claim the layer is TypeScript/TSX/JSX only`
      );
    }
    assert.ok(
      PRETTIERRC_LANGS.includes('javascript'),
      'because the layer really does cover plain javascript'
    );
  });
});

/* --- 15. the last false claims of the 0.4.0 audit ------------------------- */

/*
 * Everything below was written down in README.md or in a shipped walkthrough
 * page and was NOT true of the code. Each test pins the corrected sentence to
 * the behaviour that makes it true, so the prose cannot drift back.
 */

describe('README : .soukformatignore is NEAREST-only, not a cascade', () => {
  it('the resolver reads exactly one ignore file: the nearest', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tidy-ignore-'));
    try {
      const sub = path.join(root, 'sub');
      mkdirSync(sub);
      // Root excludes *.css; the sub-folder file says nothing about it. If the
      // two "both applied", app.css would still be ignored.
      writeFileSync(path.join(root, '.soukformatignore'), '*.css\n', 'utf8');
      writeFileSync(path.join(sub, '.soukformatignore'), '*.min.js\n', 'utf8');

      const target = path.join(sub, 'app.css');
      assert.equal(
        findSoukformatignore(target),
        path.join(sub, '.soukformatignore'),
        'the walk must stop at the first ignore file it meets'
      );
      const lookup = resolveIgnore(target);
      assert.equal(lookup.path, path.join(sub, '.soukformatignore'));
      assert.equal(
        lookup.ignored,
        false,
        'the ROOT pattern must not apply once a nearer ignore file exists'
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('the README describes shadowing, never a merged cascade', () => {
    assert.ok(
      !README.includes(
        'a root `.soukformatignore` and a sub-folder one both apply'
      ),
      'they do not both apply: the nearest one shadows the root'
    );
    assert.ok(
      /stops at the \*\*first\*\* `\.soukformatignore` it finds/.test(README),
      'the README must say the lookup stops at the nearest file'
    );
    assert.ok(
      README_FLAT.includes('is **not** merged into it'),
      'and must say the outer file is not merged in'
    );
  });
});

describe('README : JSON/JSONC are printed by jsonc-parser, not js-beautify', () => {
  it('the adapter reports jsonc-parser for both JSON languages', () => {
    assert.equal(reportedEngineIdFor('json'), JSON_ENGINE_ID);
    assert.equal(reportedEngineIdFor('jsonc'), JSON_ENGINE_ID);
    assert.equal(JSON_ENGINE_ID, 'jsonc-parser');
  });

  it('no README table row or sentence names js-beautify for JSON', () => {
    assert.ok(
      !README.includes('| JSON, JSONC | js-beautify |'),
      'that row named a library that never runs for JSON'
    );
    assert.ok(
      README.includes('| JSON, JSONC | jsonc-parser (**not** js-beautify) |'),
      'the supported-languages table must name the printer that really runs'
    );
    assert.ok(
      !README.includes('For CSS/SCSS/LESS/HTML/JSON and plain JS (the js-beautify path)'),
      'the ignore-directive section put JSON on "the js-beautify path" too'
    );
    assert.ok(
      README_FLAT.includes('and jsonc-parser for JSON/JSONC'),
      'the ignore-directive section must name jsonc-parser for JSON'
    );
  });
});

describe('README : the defaultFormatter recap is the one the code shows', () => {
  it('the recap really lists the exact keys, scope and replacements', () => {
    const plan = planUseAsFormatter(['css', 'html', 'json'], true, 'workspace');
    const recap = planDefaultFormatterRecap(
      plan,
      new Map([
        ['css', 'esbenp.prettier-vscode'],
        ['html', undefined],
        ['json', EXTENSION_ID]
      ] as [LangId, string | undefined][])
    );
    // A language already pointing at Tidy is listed, never re-written.
    assert.deepEqual([...recap.writes], ['css', 'html']);
    assert.deepEqual([...recap.alreadyTidy], ['json']);

    const detail = defaultFormatterRecapDetail(recap);
    assert.ok(detail.includes('Tidy will write exactly these keys at the Workspace scope:'));
    assert.ok(
      detail.includes(`"[css]": { "editor.defaultFormatter": "${EXTENSION_ID}" }`),
      'the dialog must print the literal key it will write'
    );
    assert.ok(detail.includes('esbenp.prettier-vscode'), 'and what it replaces');
    assert.ok(detail.includes('Nothing has been changed yet.'));
  });

  it('the README promises a MODAL recap of those exact keys', () => {
    assert.ok(
      README_FLAT.includes(
        'before writing anything it shows you a **modal recap** of the exact'
      ),
      'the README must describe the recap the code actually shows'
    );
    assert.ok(
      README_FLAT.includes(
        'a language already pointing at Tidy is listed as such and is not rewritten'
      ),
      'including the skip the recap really performs'
    );
  });
});

describe('README : embedded <script>/<style> bodies are REFORMATTED', () => {
  it('the guard accepts a reindented <style> body and rejects a changed one', () => {
    const before = '<html><body><style>a{color:red}</style></body></html>';
    const reindented =
      '<html><body><style>\n  a {\n    color: red\n  }\n</style></body></html>';
    assert.equal(
      guard.check('html', before, reindented).equivalent,
      true,
      'a pure reindent of an embedded stylesheet must pass'
    );
    assert.equal(
      guard.check(
        'html',
        before,
        '<html><body><style>a{color:blue}</style></body></html>'
      ).equivalent,
      false,
      'but a changed declaration must not'
    );
  });

  it('the guard accepts a reindented <script> body and rejects a changed one', () => {
    const before = '<html><body><script>var a=1;</script></body></html>';
    assert.equal(
      guard.check(
        'html',
        before,
        '<html><body><script>\n  var a = 1;\n</script></body></html>'
      ).equivalent,
      true
    );
    assert.equal(
      guard.check('html', before, '<html><body><script>var a=2;</script></body></html>')
        .equivalent,
      false
    );
  });

  it('the README no longer says the islands are left intact', () => {
    assert.ok(
      !README.includes(
        'leaving embedded `<script>` / `<style>` islands and templating syntax intact'
      ),
      'both bodies are reformatted; only template syntax is byte-preserved'
    );
    assert.ok(
      README_FLAT.includes(
        'Embedded `<script>` and `<style>` bodies are **not** left alone: they are reformatted too'
      ),
      'the README must say the embedded bodies are reformatted'
    );
    assert.ok(
      README_FLAT.includes(
        '**Templating syntax** (`{{ … }}`, `{% … %}` and `<% … %>`) is preserved **byte-for-byte**'
      ),
      'and name what really is byte-preserved'
    );
    assert.ok(
      README_FLAT.includes('a `<style>` body is compared as a PostCSS tree'),
      'and how the guard covers them instead of a mask'
    );
  });
});

describe('README : the sanitized reason is a bounded, not a content-free, claim', () => {
  it('the sanitizer drops the code frame but keeps the parser first line', () => {
    const babelish =
      'Unexpected token, expected ";" (1:10)\n> 1 | const apiKey = "s3cr3t";\n    |          ^';
    const kept = sanitizeDetail(babelish);
    assert.equal(kept, 'Unexpected token, expected ";" (1:10)');
    assert.ok(
      !kept.includes('apiKey'),
      'the multi-line code frame must never survive'
    );
    // ...but the first line is forwarded verbatim, so an absolute "never
    // contains your source code" is not a claim this code can back.
    assert.equal(
      sanitizeDetail('Unknown word `apiKey`\n> 1 | apiKey {}'),
      'Unknown word `apiKey`'
    );
  });

  it('the README states exactly that, not an absolute', () => {
    assert.ok(
      !README.includes('It **never contains your source code**'),
      'only the code frame is stripped, so the absolute was not true'
    );
    assert.ok(
      README_FLAT.includes('**Tidy never copies your document into it**'),
      'the true, narrower promise must be the one printed'
    );
    assert.ok(
      README_FLAT.includes(
        'that one short line can quote a few characters of the construct that failed'
      ),
      'and the residual exposure must be disclosed'
    );
    assert.ok(
      !README.includes('the output-channel diagnostics never include your source'),
      'the FAQ carried the same absolute'
    );
  });
});

describe('README : the preloader is named as the one chunk load without a format', () => {
  it('activation really schedules an idle preload', () => {
    const extension = readSource('src/extension.ts');
    assert.ok(
      /scheduleIdleChunkPreload\(\)/.test(extension),
      'activate() schedules the preloader, so "only the host bundle" needed a caveat'
    );
  });

  it('the README caveats the sentence instead of leaving it absolute', () => {
    assert.ok(
      !/Opening a file evaluates only the small\s+host bundle\.\s*\n/.test(README),
      'the bare sentence ignored the 5-second preloader'
    );
    assert.ok(
      README_FLAT.includes(
        'The one thing that can evaluate a chunk without a format is the idle preloader'
      )
    );
  });
});

describe('README : a head region marker is not a whole-file ignore', () => {
  it('detectFileIgnore refuses to treat a head tidy-ignore-start as file-ignore', () => {
    assert.equal(detectFileIgnore('/* tidy-ignore-start */\n.a{}\n', 'css'), false);
    assert.equal(detectFileIgnore('/* tidy-ignore-end */\n.a{}\n', 'css'), false);
    // The genuine file-ignore keywords still work.
    assert.equal(detectFileIgnore('/* tidy-ignore-file */\n.a{}\n', 'css'), true);
    assert.equal(detectFileIgnore('/* tidy-ignore */\n.a{}\n', 'css'), true);
  });

  it('the README documents the exception', () => {
    assert.ok(
      README_FLAT.includes(
        'a head comment that carries `tidy-ignore-start` or `tidy-ignore-end` is read as a **region** marker, never as a file-ignore'
      ),
      'the whole-file bullet must carry the region-marker exception'
    );
  });
});

describe('README : the behaviour switches do not all have the same reach', () => {
  const RESOURCE_SCOPED = [
    'tidy.editorconfig',
    'tidy.prettier.respectProjectConfig',
    'tidy.soukformatrc',
    'tidy.respectSoukformatignore'
  ];

  it('four of them are declared resource-scoped in the manifest', () => {
    const props = manifestProperties();
    for (const key of RESOURCE_SCOPED) {
      assert.equal(
        props[key].scope,
        'resource',
        `${key} is per-resource, so "the whole window or workspace" was false`
      );
    }
    for (const key of [
      'tidy.css.enable',
      'tidy.maxFileSizeKB',
      'tidy.json.maxFileSizeKB',
      'tidy.deferToOtherFormatters',
      'tidy.statusBar.enable'
    ]) {
      assert.equal(
        props[key].scope,
        undefined,
        `${key} must stay window-scoped (no explicit scope) for the README split`
      );
    }
  });

  it('the README splits them instead of lumping them together', () => {
    assert.ok(
      !README.includes(
        'apply to the whole window or workspace and cannot be put inside a `[language]` block'
      ),
      'that sentence was false for the three resource-scoped keys'
    );
    assert.ok(
      README_FLAT.includes(
        RESOURCE_SCOPED.map((key) => `\`${key}\``).join(', ').replace(
          /, ([^,]+)$/,
          ' and $1'
        ) + ' are declared `resource`-scoped'
      ),
      'the README must name the four resource-scoped keys together'
    );
    assert.ok(
      README_FLAT.includes('are window-scoped: one value for the whole window'),
      'and must say the rest are window-scoped'
    );
  });
});

/* --- 16. the shipped walkthrough pages (they ride inside the VSIX) -------- */

/*
 * media/walkthrough/*.md is packaged and rendered inside VS Code's "Get
 * started" view, so every sentence there is as user-facing as the README and
 * had never been audited. These tests give the pages the same treatment.
 */

const WALKTHROUGH_DIR = path.join(REPO_ROOT, 'media', 'walkthrough');

function walkthroughPages(): Record<string, string> {
  const pages: Record<string, string> = {};
  for (const name of readdirSync(WALKTHROUGH_DIR)) {
    if (name.endsWith('.md')) {
      pages[name] = readFileSync(path.join(WALKTHROUGH_DIR, name), 'utf8');
    }
  }
  assert.ok(Object.keys(pages).length >= 5, 'the five walkthrough pages must ship');
  return pages;
}

/**
 * One page, flattened for phrase matching: blockquote markers are dropped and
 * every run of whitespace collapsed, so a sentence that wraps across lines (or
 * across a '>' quote prefix) still matches as it was written.
 */
function page(name: string): string {
  return walkthroughPages()
    [name].replace(/^\s*>\s?/gm, '')
    .replace(/\s+/g, ' ');
}

describe('walkthrough : the pages use the manifest command titles', () => {
  it('no page invents a command title', () => {
    const titles = PACKAGE_JSON.contributes.commands.map((c) => c.title);
    for (const [name, body] of Object.entries(walkthroughPages())) {
      for (const wrong of [
        'Tidy: Use Tidy as my formatter',
        'Tidy: Use Tidy as my Formatter',
        'Use Tidy as my Formatter',
        'Preview Format (diff)',
        'Tidy: Open playground'
      ]) {
        assert.ok(
          !body.includes(wrong),
          `${name} uses "${wrong}", which no command declares`
        );
      }
    }
    for (const name of ['choose.md', 'formatonsave.md', 'migration.md']) {
      assert.ok(
        page(name).includes('Tidy: Use Tidy as My Formatter'),
        `${name} must name the command by its manifest title`
      );
    }
    // The palette shows "<category>: <title>"; the manifest stores the two
    // apart, so the page's "Tidy: Use Tidy as My Formatter" is exactly what a
    // user reads there.
    const useAsFormatter = PACKAGE_JSON.contributes.commands.find(
      (command) => command.command === 'tidy.useAsFormatter'
    );
    assert.ok(useAsFormatter, 'the opt-in command must be declared');
    assert.equal(useAsFormatter!.title, 'Use Tidy as My Formatter');
    assert.ok(
      titles.includes('Use Tidy as My Formatter'),
      'and that title must really be the manifest one'
    );
  });

  it('choose.md names the extension by its real displayName', () => {
    const body = page('choose.md');
    assert.ok(
      !body.includes('Tidy Formatter : JS/CSS/HTML'),
      'that product name does not exist'
    );
    const displayName = (
      JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
        displayName: string;
      }
    ).displayName;
    // The displayName is an EXPERIMENT VARIABLE (the v0.4.2 title test, see
    // _internal/growth/TEST_TITRE_A1.md) and may be rolled back, so it is not
    // pinned to a literal here. What is pinned is the invariant that matters:
    // every place that tells the user what to click agrees with the manifest.
    assert.ok(displayName.startsWith('Tidy'), 'the brand stays the first token');
    assert.ok(
      body.includes(displayName),
      'the "Configure Default Formatter" step must use the picker name'
    );
  });

  it('README names the extension by its real displayName', () => {
    const displayName = (
      JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
        displayName: string;
      }
    ).displayName;
    const firstLine = README.split(/\r?\n/, 1)[0];
    assert.equal(firstLine, `# ${displayName}`);
  });
});

describe('walkthrough : choose.md tells the truth about editor.formatOnSave', () => {
  it('the command really chains into the format-on-save opt-in', () => {
    const source = readSource('src/commands/useAsFormatter.ts');
    assert.ok(
      /runFormatOnSaveStep\(vscode, plan\.langs, plan\.target\)/.test(source),
      'useAsFormatter hands off to the format-on-save step'
    );
    assert.ok(
      /\.update\('formatOnSave', true,/.test(
        readSource('src/commands/formatOnSaveOptIn.ts')
      ),
      'and that step really writes editor.formatOnSave'
    );
  });

  it('choose.md no longer claims the command never touches it', () => {
    const body = page('choose.md');
    assert.ok(
      !body.includes('it **never** touches `editor.formatOnSave`'),
      'ADD-04 made that false: the command chains into the opt-in step'
    );
    assert.ok(
      body.includes('Format on save is then offered as a **separate, optional step**'),
      'the page must describe the step that exists'
    );
    assert.ok(
      body.includes('one-click **Revert**'),
      'including the revert the code offers'
    );
  });

  it('choose.md and formatonsave.md agree with each other', () => {
    for (const name of ['choose.md', 'formatonsave.md']) {
      const body = page(name);
      assert.ok(
        /never hooks|hooks no "save" event|never hook/.test(body),
        `${name} must keep the no-save-hook promise`
      );
      assert.ok(
        body.includes('editor.formatOnSave'),
        `${name} must name the stock setting`
      );
    }
  });

  it('choose.md does not deny the defaultFormatter write the code performs', () => {
    // The exact denial the README audit banned, in the page that opts you in.
    assert.ok(
      !page('choose.md').includes('it never registers itself as your default formatter'),
      'the command writes editor.defaultFormatter once you confirm'
    );
  });
});

describe('walkthrough : safety.md states the guard exactly', () => {
  it('drops the absolute corruption claim', () => {
    const body = page('safety.md');
    for (const absolute of [
      'built to make file corruption impossible',
      'File corruption is impossible',
      'Tidy never corrupts your file'
    ]) {
      assert.ok(!body.includes(absolute), `safety.md must not claim "${absolute}"`);
    }
    assert.ok(
      body.includes('a format Tidy cannot prove safe produces **zero edits**'),
      'the true, still-strong promise must replace it'
    );
  });

  it('describes idempotence as a corpus property with no runtime caller', () => {
    const body = page('safety.md');
    assert.ok(
      !/- \*\*Idempotence\.\*\* `format\(format\(x\)\)` equals `format\(x\)`, so your code never drifts/.test(
        body
      ),
      'that was stated as an unconditional runtime guarantee'
    );
    assert.ok(
      body.includes('**Idempotence, proven in the test corpus, not on your file.**')
    );
    assert.ok(
      body.includes('**not** a check that runs at format time'),
      'the page must say it does not run per format'
    );
    // Pinned to the same fact section 6 pins for the README: no caller in src/.
    const callers: string[] = [];
    for (const file of listSources(path.join(REPO_ROOT, 'src'))) {
      if (path.basename(file) === 'guard.ts') continue;
      if (/\bidempotence\s*\(/.test(readFileSync(file, 'utf8'))) {
        callers.push(path.relative(REPO_ROOT, file));
      }
    }
    assert.deepEqual(callers, [], 'still no production caller');
  });

  it('carries the same bounded privacy claim as the README', () => {
    const body = page('safety.md');
    assert.ok(
      !body.includes('that detail **never contains your source code**'),
      'only the code frame is stripped'
    );
    assert.ok(body.includes('**Tidy never copies your document into that line**'));
    assert.ok(body.includes('capped at 200 characters'));
  });
});

describe('walkthrough : migration.md carries the measured incumbent figures', () => {
  it('no page keeps the stale, undated numbers', () => {
    for (const [name, body] of Object.entries(walkthroughPages())) {
      for (const stale of ['~3.95M installs', '3.95M', 'roughly 1.7']) {
        assert.ok(
          !body.includes(stale),
          `${name} still quotes the stale figure "${stale}"`
        );
      }
    }
  });

  it('migration.md quotes the same dated measurement as the README', () => {
    const body = page('migration.md');
    for (const fact of [
      'Measured on the Marketplace `extensionquery` API on 2026-09-07',
      '**3,969,079 installs**',
      '**1.69★ average over 241 ratings**',
      '**2017-03-31**'
    ]) {
      assert.ok(body.includes(fact), `migration.md must carry ${fact}`);
      assert.ok(README_FLAT.includes(fact), `and the README must agree on ${fact}`);
    }
  });

  it('migration.md attributes the one-shot notice to the right trigger', () => {
    const body = page('migration.md');
    assert.ok(
      !body.includes(
        'If your project has a `.jsbeautifyrc`, Tidy can offer a one-time, best-effort import'
      ),
      'the notice is triggered by the extension being installed, not by the file'
    );
    assert.ok(
      body.includes('triggered by the abandoned extension being **installed**'),
      'the page must name the real trigger'
    );
    // Pinned to the predicate that decides it.
    const detect = readSource('src/migration/detectLonefy.ts');
    assert.ok(
      /return extensionPresent && !alreadyPrompted;/.test(detect),
      'shouldPromptMigration keys off the installed extension only'
    );
  });
});

describe('walkthrough : tryit.md does not promise a gate untitled buffers skip', () => {
  it('the ignore gate really needs an on-disk file', () => {
    const gate = readSource('src/ignore/ignoreGate.ts');
    assert.ok(
      /document\.uri\.scheme !== 'file'/.test(gate),
      'a non-file document is never consulted against .soukformatignore'
    );
  });

  it('tryit.md says so instead of listing "the ignore rules"', () => {
    const body = page('tryit.md');
    assert.ok(
      !body.includes('the size guard, the ignore rules, the engine'),
      '.soukformatignore never runs on the untitled playground buffers'
    );
    assert.ok(
      body.includes(
        'a `.soukformatignore` is never consulted for an untitled buffer'
      ),
      'the page must name the gate that cannot apply'
    );
    assert.ok(
      body.includes('in-source `tidy-ignore` markers'),
      'and keep the gate that does apply'
    );
  });
});

describe('walkthrough : formatonsave.md claims only what the design gives', () => {
  it('drops "not implementable" for a statement about the code', () => {
    const body = page('formatonsave.md');
    assert.ok(
      !body.includes('is simply **not implementable** here'),
      'an absolute about a whole bug class is not a claim code can back'
    );
    assert.ok(
      body.includes('have no code path to happen in'),
      'the page must say why instead: there is no save handler'
    );
  });

  it('no save hook and no file watcher exist anywhere in src/', () => {
    // The anti-hijack half of the promise the page makes, checked at the source.
    for (const file of listSources(path.join(REPO_ROOT, 'src'))) {
      const source = readFileSync(file, 'utf8');
      const relative = path.relative(REPO_ROOT, file);
      for (const banned of [
        'onWillSaveTextDocument',
        'onDidSaveTextDocument',
        'createFileSystemWatcher'
      ]) {
        assert.ok(
          !new RegExp(`\\b${banned}\\s*\\(`).test(source),
          `${relative} must not call ${banned}`
        );
      }
    }
  });
});

describe('walkthrough : the manifest step descriptions match the pages', () => {
  it('no step description makes an absolute corruption claim', () => {
    const steps = (
      PACKAGE_JSON as unknown as {
        contributes: { walkthroughs: { steps: { id: string; description: string }[] }[] };
      }
    ).contributes.walkthroughs.flatMap((w) => w.steps);
    assert.ok(steps.length >= 5, 'the walkthrough must declare its five steps');
    for (const step of steps) {
      assert.ok(
        !/corruption is impossible/i.test(step.description),
        `step '${step.id}' claims corruption is impossible, which no verifier can promise`
      );
    }
    const safety = steps.find((s) => s.id === 'tidy.gettingStarted.safety');
    assert.ok(safety, 'the safety step must exist');
    assert.ok(
      safety!.description.includes(
        'it makes zero edits and your file is left byte-identical'
      ),
      'and must state the guarantee the guard really gives'
    );
  });
});

/* ========================================================================== */
/* FINAL ROUND : the claims about the incumbent match the PRIMARY data         */
/* ========================================================================== */

/**
 * The one-star corpus, recounted here rather than trusted. `_internal/` is
 * gitignored, so every assertion that needs the raw files skips when they are
 * absent, exactly like the verbatim-quote suite above; on a machine that HAS
 * them, nothing is allowed to pass silently.
 */
const MINING_DATA_DIR = path.join(REPO_ROOT, '_internal/mining/data');

interface MinedReview {
  readonly rating: number;
  readonly text: string;
}

/** Split store_reviews_text.md into its "[N*] ..." blocks, in file order. */
function minedReviews(): readonly MinedReview[] | undefined {
  let raw: string;
  try {
    raw = readFileSync(
      path.join(MINING_DATA_DIR, 'store_reviews_text.md'),
      'utf8'
    ).replace(/^﻿/, '');
  } catch {
    return undefined; // _internal/ is gitignored: absent on a fresh clone
  }
  const out: MinedReview[] = [];
  let current: MinedReview | undefined;
  for (const line of raw.split(/\r?\n/)) {
    const head = /^\[(\d)\*\]\s?(.*)$/.exec(line);
    if (head) {
      if (current) {
        out.push(current);
      }
      current = { rating: Number(head[1]), text: head[2] };
    } else if (current) {
      current = { rating: current.rating, text: `${current.text}\n${line}` };
    }
  }
  if (current) {
    out.push(current);
  }
  return out;
}

/**
 * The hand classification of the 85 one-star reviews that carry text, made on
 * 2026-09-08 by reading every one of them. Two NON-EXCLUSIVE axes:
 *
 *   - "broken output" : corrupted code, output that stops parsing, mangled
 *     JSX / optional chaining / bigint literals, stray spaces in class and id
 *     names, deleted newlines or whitespace, formatting judged wrong or
 *     non-idempotent;
 *   - "no consent"    : formats on save after you disabled it, makes itself the
 *     default formatter, ignores VS Code settings, fights Prettier or ESLint,
 *     writes files you never asked it to touch.
 *
 * A review can carry both, or neither (pure invective, off-topic, a missing
 * option). These four numbers are the ONLY source the shipped sentences may
 * quote, and _internal/mining/MINING.md records the same table.
 */
const ONE_STAR_SPLIT = {
  brokenOutputOnly: 43,
  noConsentOnly: 16,
  both: 10,
  neither: 16
} as const;

const BROKEN_OUTPUT_TOTAL =
  ONE_STAR_SPLIT.brokenOutputOnly + ONE_STAR_SPLIT.both; // 53
const NO_CONSENT_TOTAL = ONE_STAR_SPLIT.noConsentOnly + ONE_STAR_SPLIT.both; // 26
const ONE_STAR_TOTAL =
  ONE_STAR_SPLIT.brokenOutputOnly +
  ONE_STAR_SPLIT.noConsentOnly +
  ONE_STAR_SPLIT.both +
  ONE_STAR_SPLIT.neither; // 85

describe('README : the one-star split is the corpus count, not an editorial line', () => {
  it('the arithmetic of the published split closes', () => {
    assert.equal(ONE_STAR_TOTAL, 85);
    assert.equal(BROKEN_OUTPUT_TOTAL, 53);
    assert.equal(NO_CONSENT_TOTAL, 26);
    // 53 + 26 - 10 = 69 attributed, 85 - 69 = 16 with no attributable cause.
    assert.equal(
      BROKEN_OUTPUT_TOTAL + NO_CONSENT_TOTAL - ONE_STAR_SPLIT.both,
      ONE_STAR_TOTAL - ONE_STAR_SPLIT.neither
    );
    assert.ok(
      BROKEN_OUTPUT_TOTAL > NO_CONSENT_TOTAL,
      'broken output is the DOMINANT complaint; the old sentence had it backwards'
    );
  });

  it('the corpus really holds the 85 one-star reviews the README counts', function () {
    const reviews = minedReviews();
    if (reviews === undefined) {
      this.skip();
      return;
    }
    const withText = reviews.filter((r) => r.text.trim().length > 0);
    assert.equal(
      withText.length,
      96,
      'store_reviews_text.md holds 96 reviews with text (spec.json agrees)'
    );
    assert.equal(
      withText.filter((r) => r.rating === 1).length,
      ONE_STAR_TOTAL,
      'the published denominator must be the corpus denominator'
    );
  });

  it('the raw dump explains the 89 to 85 gap: four one-star reviews are textless', function () {
    let raw: string;
    try {
      raw = readFileSync(
        path.join(MINING_DATA_DIR, 'store_reviews_raw.json'),
        'utf8'
      ).replace(/^﻿/, '');
    } catch {
      this.skip();
      return;
    }
    const dump = JSON.parse(raw) as {
      reviews: { rating: number; text: string | null; updatedDate: string }[];
      totalReviewCount: number;
    };
    assert.equal(dump.reviews.length, 100, 'the snapshot is the first 100 reviews');
    assert.equal(dump.totalReviewCount, 241, 'of 241 ratings in all');
    const ones = dump.reviews.filter((r) => r.rating === 1);
    assert.equal(ones.length, 89);
    assert.equal(
      ones.filter((r) => (r.text ?? '').trim().length === 0).length,
      89 - ONE_STAR_TOTAL,
      'the four rating-only reviews cannot be classified, so they are excluded'
    );
    const dates = dump.reviews.map((r) => r.updatedDate).sort();
    assert.ok(
      dates[dates.length - 1].startsWith('2025-02-11'),
      'the README dates the newest review in the snapshot'
    );
  });

  it('every bucket is anchored to review text that is really in the corpus', function () {
    const reviews = minedReviews();
    if (reviews === undefined) {
      this.skip();
      return;
    }
    const flat = reviews
      .filter((r) => r.rating === 1)
      .map((r) => r.text.replace(/\s+/g, ' '))
      .join('\n');
    // broken output only
    assert.ok(flat.includes('Breaks JSX'));
    assert.ok(flat.includes('destroys your HTML anchor points'));
    // no consent only
    assert.ok(flat.includes('Prevents every other formatter from working'));
    assert.ok(flat.includes('Overrides basic VSCode behaviour'));
    // both at once
    assert.ok(
      flat.includes('Breaks jinja2 templates and forcibly formats on save')
    );
    // neither
    assert.ok(flat.includes('Not enough options for formatting code'));
  });

  it('the README publishes those counts with the snapshot date', () => {
    for (const claim of [
      'the 100 most recent reviews, retrieved 2026-06-28',
      '85 of them are one-star and carry text, the most recent dated 2025-02-11',
      '**53 of those 85 are about broken or corrupted output**',
      '**26 are about a formatter acting without consent**',
      '10 reviews make both complaints and are counted in both figures, and the remaining 16 are invective with no attributable cause',
      'Broken output is the dominant complaint, so it is the one Tidy answers first'
    ]) {
      assert.ok(README_FLAT.includes(claim), `the README must state: ${claim}`);
    }
  });

  it('the reversed claim can never come back, in the README or in a page', () => {
    const banned = [
      'Most of its one-star reviews are not about',
      'they are about a formatter that acts **without consent**',
      '#1 complaint was its intrusiveness',
      'The #1 complaint about the abandoned'
    ];
    for (const phrase of banned) {
      assert.ok(
        !README_FLAT.includes(phrase),
        `the README must not claim: ${phrase}`
      );
      for (const [name, body] of Object.entries(walkthroughPages())) {
        assert.ok(
          !body.replace(/\s+/g, ' ').includes(phrase),
          `${name} must not claim: ${phrase}`
        );
      }
    }
  });

  it('the intrusiveness sentence now ranks the complaint instead of crowning it', () => {
    assert.ok(
      README_FLAT.includes(
        'Acting without consent is the second most common complaint in that review corpus (26 of the 85 one-star reviews, behind 53 about broken output), so Tidy will not nag.'
      ),
      'the no-nag rationale must carry the real ranking'
    );
  });

  it('migration.md repeats the README sentence word for word', () => {
    const body = page('migration.md');
    for (const claim of [
      'the 100 most recent reviews, retrieved 2026-06-28',
      '**53 of those 85 are about broken or corrupted output**',
      '**26 are about a formatter acting without consent**',
      'Broken output is the dominant complaint, so it is the one Tidy answers first'
    ]) {
      assert.ok(body.includes(claim), `migration.md must state: ${claim}`);
      assert.ok(
        README_FLAT.includes(claim),
        `and the README must agree on: ${claim}`
      );
    }
  });

  it('formatonsave.md ranks format-on-save second, with the counts', () => {
    const body = page('formatonsave.md');
    assert.ok(
      body.includes(
        'is the second most common complaint about the abandoned *JS-CSS-HTML Formatter*'
      ),
      'the page must not crown this complaint any more'
    );
    assert.ok(
      body.includes(
        'of the 85 one-star reviews carrying text in our 2026-06-28 snapshot, 26 are about a formatter acting without consent, behind the 53 about broken or corrupted output'
      ),
      'and must carry the counts that make the ranking checkable'
    );
  });

  it('the mining note records the same table as the shipped text', function () {
    let note: string;
    try {
      note = readFileSync(
        path.join(REPO_ROOT, '_internal/mining/MINING.md'),
        'utf8'
      );
    } catch {
      this.skip();
      return;
    }
    for (const fact of [
      '2026-06-28',
      '2025-02-11',
      String(ONE_STAR_TOTAL),
      String(BROKEN_OUTPUT_TOTAL),
      String(NO_CONSENT_TOTAL)
    ]) {
      assert.ok(note.includes(fact), `MINING.md must record ${fact}`);
    }
    assert.ok(
      note.includes('root_cause'),
      'MINING.md must flag the editorial root_cause of spec.json as contradicted'
    );
  });
});

/* --- region masking is a LANGUAGE list, not "what Prettier does not print" - */

describe('README : the region-masking list is by language id, not by engine', () => {
  it('a JSX-bearing .js is printed by Prettier AND still region-masked', () => {
    const jsx = 'const App = () => <div className="a">hi</div>;\n';
    assert.equal(
      resolveEngineIdForSource('javascript', jsx),
      'prettier',
      'dispatcher: a .js containing JSX goes to Prettier'
    );
    const guarded =
      '/* tidy-ignore-start */\nconst keep = <b>x</b>;\n/* tidy-ignore-end */\n' +
      jsx;
    const plan = buildMaskPlan('javascript', guarded, 'document');
    assert.ok(
      plan.mask,
      'javascript is in REGION_MASKING_LANGUAGES, so Tidy masks it itself'
    );
    assert.ok(
      !plan.mask.engineInput.includes('const keep = <b>x</b>;'),
      'the protected region is hidden from whichever engine prints the file'
    );
    // The contrast that makes the corrected README sentence necessary.
    assert.equal(
      buildMaskPlan('typescript', guarded, 'document').mask,
      undefined,
      'typescript is NOT region-masked: Prettier honours the marker natively'
    );
  });

  it('the README no longer equates that list with "every path Prettier does not print"', () => {
    assert.ok(
      !README_FLAT.includes('every path Prettier does not print: js-beautify'),
      'that parenthetical was false for a .js file containing JSX'
    );
    assert.ok(
      README_FLAT.includes(
        'That list is a list of **language ids**, not of engines'
      ),
      'the README must say what the list really is'
    );
    assert.ok(
      README_FLAT.includes(
        'a `.js` file that contains JSX is routed to Prettier and is still region-masked by Tidy'
      ),
      'and must name the path that breaks the old wording'
    );
  });
});

/* --- the status bar: repaint scope and the exhaustive payload ------------- */

describe('README : the status bar claims are scoped and exhaustive', () => {
  it('the config listener repaints for two sections only', () => {
    const host = readSource('src/diagnostics/statusBarHost.ts');
    const sections = [
      ...host.matchAll(/affectsConfiguration\('([^']+)'\)/g)
    ].map((m) => m[1]);
    assert.deepEqual(
      sections.sort(),
      ['editor.defaultFormatter', 'tidy'],
      'a third watched section would make the README sentence wrong again'
    );
    assert.ok(
      README_FLAT.includes(
        'a setting in the `tidy` section or `editor.defaultFormatter` changes (a change to any other setting is ignored)'
      ),
      'the README must scope the repaint instead of saying "a setting changes"'
    );
  });

  it('the tooltip really emits the rival id, the cap in KB and a setting key', () => {
    const rival = renderPassive({
      kind: 'other-default',
      languageId: 'css',
      otherFormatterId: 'esbenp.prettier-vscode'
    });
    assert.ok(rival.tooltipMarkdown.includes('esbenp.prettier-vscode'));

    const tooLarge = renderPassive({
      kind: 'too-large',
      languageId: 'json',
      maxFileSizeKB: 512,
      sizeLimitSettingKey: 'tidy.json.maxFileSizeKB'
    });
    assert.ok(tooLarge.tooltipMarkdown.includes('512 KB'));
    assert.ok(tooLarge.tooltipMarkdown.includes('tidy.json.maxFileSizeKB'));

    const disabled = renderPassive({ kind: 'disabled', languageId: 'scss' });
    assert.ok(disabled.tooltipMarkdown.includes('tidy.scss.enable'));

    // And nothing that would break the privacy half of the claim.
    for (const view of [rival, tooLarge, disabled]) {
      assert.ok(
        !view.tooltipMarkdown.includes('app.css'),
        'the bar never carries a file name'
      );
    }
  });

  it('the README lists all of that, and drops the old short list', () => {
    assert.ok(
      !README_FLAT.includes(
        'carry only language, engine, status, timestamps and the same short sanitized reasons'
      ),
      'that list omitted the rival formatter id, the KB cap and the setting key'
    );
    for (const disclosed of [
      'the extension id of the formatter that owns the language instead of Tidy',
      'the size cap in KB',
      'the name of the setting key involved (`tidy.<lang>.enable`, `tidy.maxFileSizeKB` or `tidy.json.maxFileSizeKB`)',
      'never a line of its content'
    ]) {
      assert.ok(
        README_FLAT.includes(disclosed),
        `the status bar section must disclose: ${disclosed}`
      );
    }
  });
});

/* --- the Command Palette claim, and the three gated commands -------------- */

describe('README : "in the Command Palette" names the three gated commands', () => {
  const ENABLEMENT = 'editorLangId in tidy.supportedLanguages';

  function manifestCommands(): {
    command: string;
    title: string;
    enablement?: string;
  }[] {
    return PACKAGE_JSON.contributes.commands as unknown as {
      command: string;
      title: string;
      enablement?: string;
    }[];
  }

  it('exactly three manifest commands carry the language enablement', () => {
    const gated = manifestCommands().filter((c) => c.enablement !== undefined);
    assert.deepEqual(
      gated.map((c) => c.command).sort(),
      [
        'tidy.explainLastFormat',
        'tidy.previewFormat',
        'tidy.showEffectiveConfiguration'
      ],
      'the README names exactly these three'
    );
    for (const command of gated) {
      assert.equal(
        command.enablement,
        ENABLEMENT,
        `${command.command} must use the documented enablement clause`
      );
    }
    assert.equal(manifestCommands().length, 9, 'the README says nine commands');
  });

  it('the README says so instead of "All Tidy commands are in the Command Palette"', () => {
    assert.ok(
      !README_FLAT.includes(
        'All Tidy commands are in the Command Palette (`Ctrl+Shift+P`) under the **Tidy** category:'
      ),
      'three of them are gated on the active language'
    );
    assert.ok(
      README_FLAT.includes('All nine Tidy commands live in the Command Palette')
    );
    assert.ok(
      README_FLAT.includes(
        'three of them are **gated on the active language** and are listed only while a file Tidy supports is focused'
      )
    );
    assert.ok(README_FLAT.includes(ENABLEMENT), 'and must quote the real clause');
    assert.ok(
      README_FLAT.includes('The other six are always listed.'),
      'nine commands minus the three gated ones'
    );
    for (const title of [
      '*Show Effective Configuration*',
      '*Preview Format (Diff)*',
      '*Explain Last Format*'
    ]) {
      assert.ok(README_FLAT.includes(title), `the README must name ${title}`);
    }
  });

  it('implicit command activation is dated to the release that shipped it', () => {
    assert.ok(
      README_FLAT.includes(
        'since VS Code 1.74 an extension is additionally activated'
      )
    );
    assert.ok(
      !README_FLAT.includes('since VS Code 1.84 an extension'),
      'implicit activation events landed in 1.74, not 1.84'
    );
  });
});

/* --- the deference enum descriptions must name every detector ------------- */

describe('package.json : the deference enum lists the same detectors as the code', () => {
  it('enumDescriptions[0] names ESLint, like the description and the README', () => {
    const property = manifestProperties()['tidy.deferToOtherFormatters'];
    const descriptions = property.enumDescriptions as string[];
    assert.equal(descriptions.length, 3);
    for (const detector of ['Prettier', 'Biome', 'dprint', 'ESLint']) {
      assert.ok(
        descriptions[0].includes(detector),
        `the notify enum description must name ${detector}`
      );
      assert.ok(
        (property.description as string).includes(detector),
        `the setting description must name ${detector}`
      );
    }
    assert.ok(
      !descriptions[0].includes('(Prettier, Biome, dprint).'),
      'that list silently dropped the fourth detector'
    );
    const decide = readSource('src/deference/decide.ts');
    assert.ok(decide.includes('ESLint'), 'decide.ts really handles ESLint');
    assert.ok(
      README_FLAT.includes(
        'naming the formatters and fixers it found (Prettier, Biome, dprint, ESLint)'
      ),
      'and the README already listed all four'
    );
  });
});

/* --- the last unsanitized output-channel write --------------------------- */

describe('extension.ts : every output-channel write is clamped by sanitizeDetail', () => {
  it('the preload-failure line no longer interpolates a raw message', () => {
    const source = readSource('src/extension.ts');
    assert.ok(
      !source.includes('failed to preload (${failure.message})'),
      'a chunk-load error can be multi-line and unbounded'
    );
    assert.ok(
      source.includes('sanitizeDetail(failure.message)'),
      'the clamp must be uniform across every channel write'
    );
    assert.ok(
      source.includes(
        "import { sanitizeDetail } from './diagnostics/lastFormat';"
      ),
      'and imported from the one module that owns it'
    );
  });

  it('no appendLine in extension.ts interpolates an unsanitized message', () => {
    const source = readSource('src/extension.ts');
    let checked = 0;
    for (const call of source.matchAll(/appendLine\(([\s\S]*?)\r?\n\s*\);/g)) {
      const body = call[1];
      if (body.includes('.message')) {
        checked += 1;
        assert.ok(
          body.includes('sanitizeDetail('),
          `an unclamped message reaches the channel:\n${body}`
        );
      }
    }
    assert.ok(checked > 0, 'the preload failure line must still be found');
  });

  it('the clamp really is one line and 200 characters', () => {
    const nasty = 'Cannot find module prettier\n    at require (/w/x.js:1:1)';
    assert.equal(sanitizeDetail(nasty), 'Cannot find module prettier');
    assert.equal(sanitizeDetail('y'.repeat(400)).length, 200);
  });
});

/* --- the incumbent citations obey the README's own ellipsis rule ---------- */

describe('README : the incumbent citations are attributed to the right source', () => {
  it('issue #41 is no longer cited under the HTML class/id row', () => {
    assert.ok(
      !README.includes('vscode-js-css-html-formatter/issues/41'),
      'issue #41 is about a JS variable name, not an HTML class or id'
    );
    assert.ok(
      README_FLAT.includes(
        '"HTML file auto add unexpected spaces in double quotes string value"'
      ),
      'the row now quotes the title of the issue it really rests on (#106)'
    );
  });

  it('issue #110 is quoted by its whole title, so nothing is omitted', () => {
    assert.ok(
      README_FLAT.includes(
        '"Reproducible bug, copying contents of files on file save"'
      )
    );
    assert.ok(
      !README_FLAT.includes('/ "copying contents of files on file save"'),
      'the old citation dropped the first two words without an ellipsis'
    );
  });

  it('every quoted fragment that starts mid-sentence carries an ellipsis', () => {
    for (const fragment of [
      '"… every time I save the file it just randomly add space to some class name or id name."',
      '"… randomly add space to some class name or id name …"',
      '"… it would add whitespaces after all of my ids and classes …"',
      '"… big integer number like 1n are formatted as 1 n by it, which results in a syntax error"'
    ]) {
      assert.ok(README_FLAT.includes(fragment), `unmarked omission: ${fragment}`);
    }
  });

  it('the README states the ellipsis rule the table actually follows', () => {
    assert.ok(
      README_FLAT.includes(
        'a quoted fragment that starts or stops mid-sentence carries an ellipsis at that end (a quote that is one or more whole sentences lifted from a longer review carries none)'
      ),
      'the stated rule must match the practice it governs'
    );
  });

  it('every issue number the README cites is a real issue in the mined index', function () {
    let csv: string;
    try {
      csv = readFileSync(
        path.join(MINING_DATA_DIR, 'github_issues_index.csv'),
        'utf8'
      ).replace(/^﻿/, '');
    } catch {
      this.skip();
      return;
    }
    const known = new Set(
      csv
        .split(/\r?\n/)
        .map((line) => /^"(\d+)"/.exec(line))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => m[1])
    );
    const cited = [
      ...README.matchAll(/vscode-js-css-html-formatter\/issues\/(\d+)/g)
    ].map((m) => m[1]);
    assert.ok(cited.length >= 15, 'the comparison table cites many issues');
    for (const num of cited) {
      assert.ok(known.has(num), `issue #${num} is not in the mined index`);
    }
  });
});

/* --- the 0.3.0 changelog entry counted the settings wrong ----------------- */

describe('CHANGELOG : the 0.3.0 settings count is the count that shipped', () => {
  const CHANGELOG = readFileSync(path.join(REPO_ROOT, 'CHANGELOG.md'), 'utf8');

  /** Settings added to the manifest AFTER the 0.3.0 release commit (d8d4549). */
  const ADDED_AFTER_030 = [
    'tidy.prettier.respectProjectConfig',
    // 0.5.0 (OPTIONS-6): the six options js-beautify and Prettier already had.
    'tidy.space_before_conditional',
    'tidy.jslint_happy',
    'tidy.content_unformatted',
    'tidy.void_elements',
    'tidy.prettier.singleAttributePerLine',
    'tidy.prettier.objectWrap',
    // 0.5.0 (ADD-15): the per-language switch for Vue single-file components.
    'tidy.vue.enable'
  ];

  it('the manifest declares 54 settings today', () => {
    assert.equal(Object.keys(manifestProperties()).length, 54);
  });

  it('today minus what landed after 0.3.0 is the 46 the entry now states', () => {
    const today = Object.keys(manifestProperties());
    for (const key of ADDED_AFTER_030) {
      assert.ok(today.includes(key), `${key} must exist in the manifest`);
    }
    assert.equal(today.length - ADDED_AFTER_030.length, 46);
    assert.ok(
      CHANGELOG.includes(
        '**No setting was renamed or removed**: all 46 `tidy.*` setting identifiers are unchanged,'
      ),
      'the historical entry must carry the number that was true when it shipped'
    );
  });

  it('the wrong number can never come back', () => {
    assert.ok(
      !CHANGELOG.includes('all 44 `tidy.*` identifiers are unchanged'),
      '44 was already wrong on the day 0.3.0 shipped'
    );
  });

  it('the 0.5.0 entry sits above 0.4.3 and has its four sections', () => {
    const start = CHANGELOG.indexOf('## [0.5.0] - 2026-10-15');
    const next = CHANGELOG.indexOf('## [0.4.3]');
    assert.ok(start >= 0, 'the 0.5.0 entry must exist');
    assert.ok(start < next, 'and sit above 0.4.3');
    const entry = CHANGELOG.slice(start, next);
    let last = -1;
    for (const heading of [
      '### Added',
      '### Changed',
      '### Fixed',
      '### Known limitations'
    ]) {
      const at = entry.indexOf(heading);
      assert.ok(at > last, `${heading} must follow the previous section`);
      last = at;
    }
  });

  it('the 0.5.0 entry names the six new settings and the new command', () => {
    const start = CHANGELOG.indexOf('## [0.5.0]');
    const entry = CHANGELOG.slice(start, CHANGELOG.indexOf('## [0.4.3]'));
    for (const key of ADDED_AFTER_030.slice(1)) {
      assert.ok(entry.includes('`' + key + '`'), `0.5.0 must name ${key}`);
    }
    assert.ok(entry.includes('`tidy.whoFormats`'));
    assert.ok(entry.includes('Who Formats This File?'));
  });

  it('the 0.5.0 entry carries no unverified figure from the audit reports', () => {
    const start = CHANGELOG.indexOf('## [0.5.0]');
    const entry = CHANGELOG.slice(start, CHANGELOG.indexOf('## [0.4.3]'));
    // The differential test compares ~6 600 entries by default, not 412 000,
    // and the worst case is minutes before and seconds after, not "1 to 4 s".
    assert.ok(!/412[\s,]?000/.test(entry), 'the 412 000 figure is not the committed test');
    assert.ok(!/1 to 4 s/.test(entry), 'the "1 to 4 s" figure was not verified');
  });

  it('the historical 0.4.x entries still say what was true on their date', () => {
    assert.ok(
      CHANGELOG.includes(
        '`// prettier-ignore` is not honoured during *Format Selection* on the TypeScript path'
      ),
      'the 0.4.0 and 0.4.1 known limitation stays as written; 0.5.0 states the change'
    );
  });

  // This assertion used to say the opposite: it stopped the agents that wrote
  // the 0.4.0 work from also writing its release entry, so the entry could be
  // composed once, from the finished tree, instead of being grown a claim at a
  // time by whoever happened to touch the file last. The entry now exists, so
  // the guard becomes what it was always protecting: the version in the
  // manifest and the version documented in the changelog cannot drift apart.
  it('every shipped version has an entry, and the manifest version has one too', () => {
    const { version } = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')
    ) as { version: string };
    assert.ok(
      CHANGELOG.includes(`## [${version}]`),
      `CHANGELOG.md must document the version package.json declares (${version})`
    );
    assert.ok(CHANGELOG.includes('## [0.3.0]'), 'the 0.3.0 entry must stay');
  });
});

/* --- the consent flow the prose describes is the flow the code runs ------- */

describe('README : the consent flow prose matches useAsFormatter as it stands', () => {
  it('the no-workspace fallback is disclosed, in the conditional the modal uses', () => {
    // The plan carries a CODE; the pre-write renderer owns the conditional tense.
    const plan = planUseAsFormatter(['css'], false, 'workspace');
    assert.equal(
      plan.warningCode,
      'workspace-fallback',
      'asking for Workspace with no folder open must fall back to User'
    );
    assert.ok(
      NO_WORKSPACE_PENDING_WARNING.startsWith('No workspace folder is open'),
      'the pre-write wording is the one the README quotes'
    );
    assert.ok(
      README_FLAT.includes(NO_WORKSPACE_PENDING_WARNING),
      'the README must quote the fallback warning verbatim, not paraphrase it'
    );
    assert.ok(
      !README_FLAT.includes(NO_WORKSPACE_WRITTEN_WARNING),
      'the past-tense wording belongs to the post-write toast, never to the recap'
    );
  });

  it('the format-on-save step is described by its real first answer', () => {
    const optIn = readSource('src/commands/formatOnSaveOptIn.ts');
    const label = 'No, keep formatting manual';
    assert.ok(
      optIn.includes(`const CHOICE_DO_NOTHING = '${label}';`),
      'the declined branch keeps this exact label'
    );
    // It is the FIRST item offered, which is what "first and recommended" means.
    const quickPick = optIn.slice(optIn.indexOf('showQuickPick('));
    assert.ok(
      quickPick.indexOf('CHOICE_DO_NOTHING') <
        quickPick.indexOf('CHOICE_OPEN_SETTING'),
      'the do-nothing choice must be offered first'
    );
    assert.ok(
      README_FLAT.includes(
        'its first and recommended answer is *No, keep formatting manual*'
      ),
      'the README must name the answer the user really sees'
    );
    assert.ok(
      page('formatonsave.md').includes(
        'whose first and recommended answer is *No, keep formatting manual*'
      )
    );
    assert.ok(
      page('choose.md').includes(
        'whose first and recommended choice is *No, keep formatting manual*'
      )
    );
    for (const [name, body] of Object.entries(walkthroughPages())) {
      assert.ok(
        !body.includes('*Do nothing*'),
        `${name} quoted a label the command never shows`
      );
    }
    assert.ok(!README_FLAT.includes('*Do nothing*'));
  });
});

/* -------------------------------------------------------------------------- */
/* Line width follows the layer order (C-15, fixed in v0.5.0)                   */
/* -------------------------------------------------------------------------- */

describe('README : line width follows the layer order, whichever key spelled it', () => {
  // An 88-character line: it fits under a width of 120 and not under 40, so the
  // shape of the output says which width actually reached the printer.
  const LONG =
    'const aVeryLongVariableName = someFunctionCall(argumentOne, argumentTwo, argumentThree);\n';

  async function widthUsed(
    layers: { source: string; values: Record<string, unknown> }[]
  ): Promise<'wide' | 'narrow'> {
    const options = resolveOptions({ languageId: 'typescript', layers });
    const out = await dispatchFormat({
      languageId: 'typescript',
      code: LONG,
      options
    });
    return out.split('\n').length > 2 ? 'narrow' : 'wide';
  }

  it('a width from a HIGHER layer beats tidy.prettier.printWidth from a lower one', async () => {
    // Control: the shared width alone governs, so the assertions below are not
    // measuring prettier's default.
    assert.equal(
      await widthUsed([
        { source: '.editorconfig', values: { wrap_line_length: 120 } }
      ]),
      'wide',
      'a 120 width leaves the 88-character line alone'
    );
    assert.equal(
      await widthUsed([
        { source: 'VS Code', values: { 'prettier.printWidth': 40 } },
        { source: '.editorconfig', values: { wrap_line_length: 120 } }
      ]),
      'wide',
      '.editorconfig max_line_length (layer 3) beats a VS Code tidy.prettier.printWidth'
    );
    assert.equal(
      await widthUsed([
        { source: 'VS Code', values: { 'prettier.printWidth': 40 } },
        { source: '.soukformatrc[typescript]', values: { wrap_line_length: 120 } }
      ]),
      'wide',
      'a .soukformatrc wrap_line_length beats a VS Code tidy.prettier.printWidth'
    );
  });

  it('it works the other way round too: a higher layer can ask for a NARROWER width', async () => {
    assert.equal(
      await widthUsed([
        { source: 'VS Code', values: { 'prettier.printWidth': 120 } },
        { source: '.editorconfig', values: { wrap_line_length: 40 } }
      ]),
      'narrow',
      'a lower printWidth of 120 must not keep a higher layer from wrapping at 40'
    );
    assert.equal(
      await widthUsed([
        { source: 'VS Code', values: { wrap_line_length: 120 } },
        { source: '.soukformatrc[typescript]', values: { 'prettier.printWidth': 40 } }
      ]),
      'narrow',
      'a .soukformatrc printWidth beats a VS Code wrap_line_length'
    );
  });

  it('inside ONE layer the Prettier-specific key wins, as the README says', async () => {
    assert.equal(
      await widthUsed([
        {
          source: 'VS Code',
          values: { wrap_line_length: 120, 'prettier.printWidth': 40 }
        }
      ]),
      'narrow'
    );
  });

  it('a [lang] value beats a global one in both vocabularies', async () => {
    assert.equal(
      await widthUsed([
        { source: 'VS Code', values: { 'prettier.printWidth': 120 } },
        { source: 'VS Code [typescript]', values: { 'prettier.printWidth': 40 } }
      ]),
      'narrow'
    );
    assert.equal(
      await widthUsed([
        { source: 'VS Code', values: { wrap_line_length: 120 } },
        { source: 'VS Code [typescript]', values: { wrap_line_length: 40 } }
      ]),
      'narrow'
    );
  });

  it('a width of 0 means no limit on the Prettier path, as the README says', async () => {
    assert.equal(
      await widthUsed([
        { source: 'VS Code', values: { 'prettier.printWidth': 40 } },
        { source: '.editorconfig', values: { wrap_line_length: 0 } }
      ]),
      'wide',
      'a higher 0 lifts the limit a lower layer asked for'
    );
    assert.equal(
      await widthUsed([{ source: '.editorconfig', values: { wrap_line_length: 0 } }]),
      'wide',
      '0 is "no limit", not "fall back to 80"'
    );
  });

  it('the README states the unified rule and no longer states a deviation', () => {
    assert.ok(
      !README_FLAT.includes('Known deviation, line width'),
      'the deviation was fixed, so the section is gone'
    );
    assert.ok(
      !README_FLAT.includes('with one documented exception for line width'),
      'the layer-order sentence no longer carries an exception'
    );
    assert.ok(
      !README_FLAT.includes('express the width in the same vocabulary'),
      'the workaround for the deviation is gone with it'
    );
    assert.ok(
      README_FLAT.includes('**Line width follows the layer order too.**'),
      'the rule is stated where the layer order is described'
    );
    assert.ok(
      README_FLAT.includes(
        'Tidy takes the width from the highest layer that sets either, whichever key spelled it'
      )
    );
    assert.ok(
      README_FLAT.includes(
        'Inside a single layer, `tidy.prettier.printWidth` wins over `wrap_line_length`'
      )
    );
    assert.ok(
      README_FLAT.includes('a `.soukformatrc` `wrap_line_length`'),
      'it names the layers that no longer lose'
    );
  });

  it('the engine no longer carries the deviation warning', () => {
    const engine = readSource('src/engine/prettier.ts');
    assert.ok(
      !/KNOWN DEVIATION/.test(engine),
      'the code must not warn about a deviation the README no longer states'
    );
    assert.ok(
      /ONE width, chosen by layer order/.test(engine),
      'the code must say what it now does'
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 0.5.0: the exclusion-pattern rules the README states are the ones applied    */
/* -------------------------------------------------------------------------- */

describe('README : the .soukformatignore pattern rules are the ones the matcher applies', () => {
  const ignored = (text: string, rel: string): boolean =>
    evaluateIgnore(text, rel).ignored;

  it('character classes, negated classes and ranges follow git', () => {
    assert.equal(ignored('f[abc]', 'fb'), true);
    assert.equal(ignored('f[abc]', 'fd'), false);
    assert.equal(ignored('f[!a]', 'fb'), true);
    assert.equal(ignored('f[!a]', 'fa'), false);
    assert.equal(ignored('f[a-c]', 'fb'), true);
    assert.equal(ignored('f[a-c]', 'fd'), false);
  });

  it('`***` behaves as `**`', () => {
    assert.equal(ignored('***/x', 'a/b/x'), ignored('**/x', 'a/b/x'));
    assert.equal(ignored('***/x', 'a/b/x'), true);
  });

  it('a pattern without a slash applies at any depth and to a folder contents', () => {
    assert.equal(ignored('src', 'a/src/b.js'), true);
    assert.equal(ignored('*.min.css', 'a/b/c.min.css'), true);
  });

  it('a trailing slash matches folders only, and `**` inside a word acts as `*`', () => {
    assert.equal(ignored('build/', 'build'), false);
    assert.equal(ignored('build/', 'build/x.js'), true);
    assert.equal(ignored('src**min', 'srcXmin'), true);
    assert.equal(ignored('src**min', 'src/a.min'), false);
  });

  it('an excluded folder cannot be re-included file by file; its contents can', () => {
    assert.equal(ignored('dist/\n!dist/keep.js', 'dist/keep.js'), true);
    assert.equal(ignored('dist/*\n!dist/keep.js', 'dist/keep.js'), false);
    assert.equal(ignored('dist/*\n!dist/keep.js', 'dist/other.js'), true);
  });

  it('the README example still behaves as its comment says', () => {
    const example = '*.min.css\ndist/\nvendor/**/*.js\n!vendor/keep.js\n';
    assert.equal(ignored(example, 'vendor/a/b.js'), true);
    assert.equal(ignored(example, 'vendor/keep.js'), false);
    assert.ok(README.includes('!vendor/keep.js'));
  });

  it('exclusions ignore case, re-inclusions respect it', () => {
    assert.equal(ignored('DIST/', 'dist/a.js'), true);
    assert.equal(ignored('*.js\n!KEEP.js', 'keep.js'), true, 'a re-inclusion must match exactly');
    assert.equal(ignored('*.js\n!keep.js', 'keep.js'), false);
  });

  it('a byte-order mark, CRLF and leading blanks are read as stated', () => {
    assert.equal(ignored('\ufeff*.css', 'a.css'), true);
    assert.equal(ignored('*.css\r\n', 'a.css'), true);
    assert.equal(ignored('  *.css', 'a.css'), false, 'leading blanks are part of the pattern');
    assert.equal(ignored('  *.css', '  a.css'), true);
  });

  it('an unevaluable line excludes, with a reason, as the README says', () => {
    const verdict = evaluateIgnore('x'.repeat(1100) + '\n', 'a/b.js');
    assert.equal(verdict.ignored, true);
    assert.ok(verdict.failClosed !== undefined, 'the reason must be carried');
    assert.ok(README.includes('over 1 024 characters'));
  });

  it('the README states the case rules in both files', () => {
    assert.ok(
      README_FLAT.includes('exclusion patterns ignore case (`DIST/` excludes `dist/`), while `!` re-inclusions respect it'),
    );
    assert.ok(
      README_FLAT.includes('matching is **case-sensitive on every OS**, as in Prettier and EditorConfig'),
    );
    assert.ok(
      README_FLAT.includes('**a folder that is excluded cannot be re-included file by file**'),
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 0.5.0: the migration prose is the migration the code runs                    */
/* -------------------------------------------------------------------------- */

describe('README : the migration reads the sources and sections the code reads', () => {
  it('the incumbent config file is the one the README names', () => {
    assert.equal(LONEFY_LOCAL_CONFIG_SEGMENTS.join('/'), '.vscode/formatter.json');
    assert.ok(README.includes('`.vscode/formatter.json`'));
  });

  it('each section feeds the languages the README table says', () => {
    assert.deepEqual([...LONEFY_SECTIONS.css.languages], ['css', 'scss']);
    assert.deepEqual([...LONEFY_SECTIONS.javascript.languages], ['javascript', 'json']);
    assert.deepEqual([...LONEFY_SECTIONS.html.languages], ['html']);
    assert.ok(README.includes('| `css` | `[css]` and `[scss]` |'));
    assert.ok(README.includes('| `javascript` | `[javascript]` and `[json]` |'));
    assert.ok(README.includes('| `html` | `[html]` |'));
    for (const absent of ['less', 'jsonc']) {
      assert.ok(
        !Object.values(LONEFY_SECTIONS).some((section) =>
          (section.languages as readonly string[]).includes(absent)
        ),
        `no section feeds ${absent}`
      );
    }
  });

  it('the keys the README lists per section are the keys that really carry over', () => {
    const text = JSON.stringify({
      onSave: true,
      javascript: Object.fromEntries([...LONEFY_SECTIONS.javascript.honoured].map((k) => [k, sampleFor(k)])),
      css: Object.fromEntries([...LONEFY_SECTIONS.css.honoured].map((k) => [k, sampleFor(k)])),
      html: Object.fromEntries([...LONEFY_SECTIONS.html.honoured].map((k) => [k, sampleFor(k)]))
    });
    const mapping = mapLonefyConfigText(text, {
      label: '.vscode/formatter.json',
      allowFlatKeys: false
    });
    assert.equal(mapping.unusable, false);
    assert.equal(mapping.onSaveSeen, true, 'onSave is recognised');
    assert.ok(
      !mapping.writes.some((w) => /formatOnSave/i.test(w.key)),
      'and never proposed'
    );
    const written = (language: string): string[] =>
      mapping.writes
        .filter((w) => w.language === language)
        .map((w) => w.key.replace(/^tidy\./, ''));
    // The README lists these per section (the keys of the "same name" rows).
    const readmeLines = README.split(/\r?\n/);
    for (const section of ['javascript', 'css', 'html'] as const) {
      const row = readmeLines.find(
        (line) =>
          line.startsWith('| `' + section + '` | ') &&
          line.endsWith('| the `tidy.*` setting of the same name |')
      );
      assert.ok(row, `the README must have a keys row for ${section}`);
      const listed = [...row.split('|')[2].matchAll(/`([a-z_]+)`/g)].map(
        (m) => m[1]
      );
      const really = written(section).filter(
        (key) => key !== 'indent' && key !== 'end_of_line'
      );
      assert.deepEqual(
        [...listed].sort(),
        [...really].sort(),
        `the README keys for the ${section} section are the ones written into [${section}]`
      );
    }
    // [json] only receives what applies to JSON.
    assert.deepEqual(written('json').sort(), ['end_of_line', 'indent']);
  });

  function sampleFor(key: string): unknown {
    switch (key) {
      case 'indent_size':
      case 'wrap_line_length':
      case 'max_preserve_newlines':
      case 'wrap_attributes_indent_size':
        return 2;
      case 'brace_style':
        return 'expand';
      case 'wrap_attributes':
        return 'force';
      case 'operator_position':
        return 'before-newline';
      case 'indent_scripts':
        return 'keep';
      case 'eol':
        return '\n';
      default:
        return true;
    }
  }

  it('the global file is written at User scope and the others at Workspace scope', () => {
    const recap = readSource('src/migration/recap.ts');
    assert.ok(
      /kind === 'global-formatter-json' \? 'global' : 'workspace'/.test(recap),
      'only the incumbent global file is written at the User scope'
    );
    assert.ok(README_FLAT.includes('written at User scope and never into a repository'));
  });
});

/* -------------------------------------------------------------------------- */
/* 0.5.0: silent-defer reads nothing                                            */
/* -------------------------------------------------------------------------- */

describe('README : silent-defer reads nothing at activation', () => {
  it('detection cannot change an outcome in silent-defer or off', () => {
    assert.equal(detectionCanChangeOutcome('silent-defer', false), false);
    assert.equal(detectionCanChangeOutcome('off', false), false);
    assert.equal(detectionCanChangeOutcome('notify', false), true);
  });

  it('the README no longer says silent-defer "acknowledges" the competitor', () => {
    assert.ok(!README_FLAT.includes('Acknowledge the competitor'));
    assert.ok(
      README_FLAT.includes('Tidy does not scan the workspace for a competitor at activation in this mode')
    );
  });
});
