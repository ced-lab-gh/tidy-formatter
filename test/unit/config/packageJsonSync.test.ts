// Anti-drift sync test (Axe 3.T8, extended by ADD-10): package.json's
// contributes.configuration is an ARRAY of titled, ordered sections. This test
// (1) locks the section layout (titles, order, membership) so the Settings UI
// cannot silently regress to a flat list, (2) flattens the sections and keeps
// the original catalogue sync guarantees (type / default / enum / scope /
// description must match OPTION_CATALOG field by field), and (3) locks the
// markdownDescription rule: EXACTLY description + blank line + the docs link.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OPTION_CATALOG } from '../../../src/config/optionCatalog';

interface PkgProperty {
  type?: string;
  default?: unknown;
  enum?: string[];
  enumDescriptions?: string[];
  minimum?: number;
  maximum?: number;
  scope?: string;
  description?: string;
  markdownDescription?: string;
  order?: number;
}

interface PkgConfigSection {
  title: string;
  order?: number;
  properties: Record<string, PkgProperty>;
}

const ROOT = join(__dirname, '..', '..', '..');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  contributes: { configuration: PkgConfigSection[] };
  keywords: string[];
  categories: string[];
};

const sections = pkg.contributes.configuration;

const README_BASE = 'https://github.com/ced-lab-gh/tidy-formatter';
const DEFAULT_DOC_LINK = `Docs: [Key settings](${README_BASE}#key-settings).`;
const DOC_LINK_OVERRIDES: Record<string, string> = {
  'tidy.respectSoukformatignore': `Docs: [Ignore & coexistence](${README_BASE}#ignore--coexistence).`,
  'tidy.deferToOtherFormatters': `Docs: [Deference behavior](${README_BASE}#deference-behavior-coexisting-with-other-formatters).`
};

function docsLink(settingKey: string): string {
  return DOC_LINK_OVERRIDES[settingKey] ?? DEFAULT_DOC_LINK;
}

/** The exact section layout (title + ordered member keys). Drift fails CI. */
const EXPECTED_SECTIONS: readonly { title: string; keys: readonly string[] }[] = [
  {
    title: 'General & Safety',
    keys: [
      'tidy.css.enable',
      'tidy.scss.enable',
      'tidy.less.enable',
      'tidy.html.enable',
      'tidy.json.enable',
      'tidy.jsonc.enable',
      'tidy.javascript.enable',
      'tidy.typescript.enable',
      'tidy.typescriptreact.enable',
      'tidy.javascriptreact.enable',
      'tidy.maxFileSizeKB'
    ]
  },
  {
    title: 'Indentation & Line Endings',
    keys: [
      'tidy.indent',
      'tidy.end_of_line',
      'tidy.preserve_newlines',
      'tidy.max_preserve_newlines',
      'tidy.indent_empty_lines',
      'tidy.wrap_line_length'
    ]
  },
  {
    title: 'JavaScript (js-beautify)',
    keys: [
      'tidy.brace_style',
      'tidy.space_after_anon_function',
      'tidy.space_in_paren',
      'tidy.space_in_empty_paren',
      'tidy.break_chained_methods',
      'tidy.keep_array_indentation',
      'tidy.comma_first',
      'tidy.operator_position'
    ]
  },
  {
    title: 'CSS, SCSS & LESS',
    keys: [
      'tidy.selector_separator_newline',
      'tidy.newline_between_rules',
      'tidy.space_around_combinator'
    ]
  },
  {
    title: 'HTML',
    keys: [
      'tidy.wrap_attributes',
      'tidy.wrap_attributes_indent_size',
      'tidy.indent_inner_html',
      'tidy.indent_scripts'
    ]
  },
  {
    title: 'TypeScript & JSX (Prettier)',
    keys: [
      'tidy.prettier.printWidth',
      'tidy.prettier.semi',
      'tidy.prettier.singleQuote',
      'tidy.prettier.jsxSingleQuote',
      'tidy.prettier.trailingComma',
      'tidy.prettier.bracketSpacing',
      'tidy.prettier.bracketSameLine',
      'tidy.prettier.arrowParens'
    ]
  },
  {
    title: 'Project & Coexistence',
    keys: [
      'tidy.editorconfig',
      'tidy.soukformatrc',
      'tidy.respectSoukformatignore',
      'tidy.deferToOtherFormatters'
    ]
  }
];

/** Flatten all sections into one record, failing on any duplicate key. */
function flattenProperties(): Record<string, PkgProperty> {
  return sections.reduce<Record<string, PkgProperty>>((acc, section) => {
    for (const key of Object.keys(section.properties)) {
      assert.equal(
        acc[key],
        undefined,
        `setting "${key}" is declared in more than one section`
      );
    }
    return { ...acc, ...section.properties };
  }, {});
}

const props = flattenProperties();

describe('config/packageJsonSync : section layout (ADD-10)', () => {
  it('configuration is an array of exactly the 7 expected sections, in order', () => {
    assert.ok(Array.isArray(sections), 'contributes.configuration must be an array');
    assert.deepEqual(
      sections.map((s) => s.title),
      EXPECTED_SECTIONS.map((s) => s.title)
    );
  });

  it('section order fields are 1..7 ascending', () => {
    assert.deepEqual(
      sections.map((s) => s.order),
      EXPECTED_SECTIONS.map((_, i) => i + 1)
    );
  });

  it('each section contains exactly its expected keys', () => {
    for (let i = 0; i < EXPECTED_SECTIONS.length; i++) {
      assert.deepEqual(
        Object.keys(sections[i].properties).sort(),
        [...EXPECTED_SECTIONS[i].keys].sort(),
        `section "${EXPECTED_SECTIONS[i].title}" membership`
      );
    }
  });

  it('the 7 sections together declare every setting exactly once', () => {
    const declared = sections.flatMap((s) => Object.keys(s.properties));
    assert.equal(declared.length, EXPECTED_SECTIONS.reduce((n, s) => n + s.keys.length, 0));
    assert.equal(new Set(declared).size, declared.length, 'no setting may be duplicated');
  });

  it('every property declares an integer order matching its position (1..n, unique)', () => {
    for (let i = 0; i < EXPECTED_SECTIONS.length; i++) {
      const expected = EXPECTED_SECTIONS[i];
      for (let j = 0; j < expected.keys.length; j++) {
        const prop = sections[i].properties[expected.keys[j]];
        assert.equal(
          prop.order,
          j + 1,
          `${expected.keys[j]} order in "${expected.title}"`
        );
      }
    }
  });

  it('every property markdownDescription is EXACTLY description + blank line + docs link', () => {
    for (const [key, prop] of Object.entries(props)) {
      assert.ok(prop.description, `${key} must keep a plain description`);
      assert.equal(
        prop.markdownDescription,
        `${prop.description}\n\n${docsLink(key)}`,
        `${key} markdownDescription`
      );
    }
  });

  it('the README sections the docs links point at actually exist', () => {
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    assert.ok(readme.includes('## Key settings'));
    assert.ok(readme.includes('## Ignore & coexistence'));
    assert.ok(
      readme.includes('### Deference behavior (coexisting with other formatters)')
    );
  });
});

describe('config/packageJsonSync : catalogue ⇄ package.json', () => {
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
