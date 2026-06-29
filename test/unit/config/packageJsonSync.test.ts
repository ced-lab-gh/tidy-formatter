// Anti-drift sync test (Axe 3.T8): package.json contributes.configuration MUST
// declare exactly the catalogue's options, with matching type / default / enum /
// scope. This test fails CI if package.json and optionCatalog.ts diverge, so the
// Settings UI always reflects the single source of truth.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OPTION_CATALOG } from '../../../src/config/optionCatalog';

interface PkgProperty {
  type?: string;
  default?: unknown;
  enum?: string[];
  scope?: string;
  description?: string;
}

const pkg = JSON.parse(
  readFileSync(join(__dirname, '..', '..', '..', 'package.json'), 'utf8')
) as {
  contributes: { configuration: { properties: Record<string, PkgProperty> } };
  keywords: string[];
  categories: string[];
};

const props = pkg.contributes.configuration.properties;

describe('config/packageJsonSync — catalogue ⇄ package.json', () => {
  it('every catalogue option is declared in package.json', () => {
    for (const entry of OPTION_CATALOG) {
      assert.ok(props[entry.settingKey], `package.json is missing ${entry.settingKey}`);
    }
  });

  it('declared type / default / scope / description match the catalogue', () => {
    for (const entry of OPTION_CATALOG) {
      const prop = props[entry.settingKey];
      assert.equal(prop.type, entry.type, `${entry.settingKey} type`);
      assert.deepEqual(prop.default, entry.default, `${entry.settingKey} default`);
      assert.equal(prop.scope, entry.scope, `${entry.settingKey} scope`);
      assert.equal(prop.description, entry.description, `${entry.settingKey} description`);
    }
  });

  it('declared enum matches the catalogue enum exactly', () => {
    for (const entry of OPTION_CATALOG) {
      const prop = props[entry.settingKey];
      if (entry.enum) {
        assert.deepEqual(prop.enum, [...entry.enum], `${entry.settingKey} enum`);
      } else {
        assert.equal(prop.enum, undefined, `${entry.settingKey} must not declare an enum`);
      }
    }
  });

  it('no orphan tidy.* engine setting in package.json (besides operational keys)', () => {
    const catalogueKeys = new Set(OPTION_CATALOG.map((e) => e.settingKey));
    // Operational / non-catalogue settings legitimately present in package.json.
    const allowed = new Set([
      'tidy.maxFileSizeKB',
      'tidy.editorconfig',
      'tidy.soukformatrc',
      'tidy.respectSoukformatignore',
      'tidy.deferToOtherFormatters'
    ]);
    for (const key of Object.keys(props)) {
      if (key.endsWith('.enable')) {
        continue; // per-language provider toggles
      }
      if (allowed.has(key) || catalogueKeys.has(key)) {
        continue;
      }
      assert.fail(`package.json declares un-catalogued setting "${key}"`);
    }
  });

  it('declares the .soukformatrc opt-out (default true)', () => {
    const prop = props['tidy.soukformatrc'];
    assert.ok(prop, 'tidy.soukformatrc must be declared');
    assert.equal(prop.type, 'boolean');
    assert.equal(prop.default, true);
  });

  it('keeps keywords <= 10 and categories unchanged', () => {
    assert.ok(pkg.keywords.length <= 10, `keywords must stay <= 10 (got ${pkg.keywords.length})`);
    assert.deepEqual(pkg.categories, ['Formatters']);
  });
});
