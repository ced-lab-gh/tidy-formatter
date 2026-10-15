// "An option is declared for a language if, and only if, it does something there."
//
// Three defects were the same lie told three ways:
//   C-14   tidy.preserve_newlines was declared for ALL ten languages and was inert
//          on json, jsonc, typescript, typescriptreact and javascriptreact (and its
//          siblings tidy.max_preserve_newlines and tidy.indent_empty_lines with it);
//   LOW-16 tidy.brace_style's description promised an effect outside JavaScript;
//   LOW-19 tidy.editorconfig had no resource scope, so a value set on ONE folder of
//          a multi-root workspace was ignored.
//
// The first block is behavioural, not a snapshot: it forces the option straight into
// the engine (no config layer, nothing that could drop it) and asks whether the
// output changes, then compares that to what the catalogue declares. The catalogue
// can therefore never drift back into over-declaring.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dispatchFormat } from '../../../src/engine/dispatcher';
import {
  OPTION_CATALOG,
  appliesToLanguage,
  findBySettingKey,
  type CatalogLang
} from '../../../src/config/optionCatalog';
import { parseSoukformatrc } from '../../../src/config/soukformatrc';
import { SUPPORTED_LANG_IDS } from '../../../src/types';

const LOREM =
  'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore';
const JS =
  'function f(){\n\n  var x = compute(alphaValue, betaValue, gammaValue, deltaValue, epsilonValue, zetaValue);\n\n\n\n  return x;\n}\nconst y = 1;\n\n\n\nconst z = 2;\n';
const CSS = '.a{color:red;\n\n\n\nbackground:blue}\n\n\n\n.b{color:blue}\n';

/** One sample per language, each with blank lines at depth 0 and inside a block. */
const SAMPLES: Readonly<Record<CatalogLang, string>> = {
  css: CSS,
  scss: CSS,
  less: CSS,
  html: `<div>\n\n\n\n<p>${LOREM}</p>\n\n\n\n<p>y</p>\n</div>\n`,
  javascript: JS,
  json: `{"a":[1,2,3],\n\n\n"b":"${LOREM}"}\n`,
  jsonc: `{"a":1,\n\n\n"b":"${LOREM}"}\n`,
  typescript: JS,
  typescriptreact: JS,
  javascriptreact: JS,
  // A Vue SFC prints its <template> with the html engine and its <style> with
  // the css engine, so it has blank lines at depth 0 and inside a block too.
  vue: `<template>\n<div>\n\n\n\n<p>${LOREM}</p>\n\n\n\n<p>y</p>\n</div>\n</template>\n<style>\n${CSS}</style>\n`
};

const NEWLINE_OPTIONS: ReadonlyArray<{
  settingKey: string;
  engineKey: string;
  off: unknown;
  on: unknown;
}> = [
  { settingKey: 'tidy.preserve_newlines', engineKey: 'preserve_newlines', off: true, on: false },
  { settingKey: 'tidy.max_preserve_newlines', engineKey: 'max_preserve_newlines', off: 10, on: 1 },
  { settingKey: 'tidy.indent_empty_lines', engineKey: 'indent_empty_lines', off: false, on: true }
];

async function engineHonours(
  lang: CatalogLang,
  engineKey: string,
  a: unknown,
  b: unknown
): Promise<boolean> {
  const format = (value: unknown): Promise<string> =>
    dispatchFormat({
      languageId: lang,
      code: SAMPLES[lang],
      options: { tabSize: 4, insertSpaces: true, engineOptions: { [engineKey]: value }, sources: {} }
    });
  return (await format(a)) !== (await format(b));
}

describe('config/optionCatalog : a blank-line option is declared exactly where it works (C-14)', () => {
  for (const option of NEWLINE_OPTIONS) {
    describe(option.settingKey, () => {
      const entry = findBySettingKey(option.settingKey);

      it('is in the catalogue', () => {
        assert.ok(entry, `${option.settingKey} must exist`);
      });

      for (const lang of SUPPORTED_LANG_IDS) {
        it(`${lang}: declared <=> the engine output changes`, async () => {
          const works = await engineHonours(lang, option.engineKey, option.off, option.on);
          assert.equal(
            appliesToLanguage(entry!, lang),
            works,
            works
              ? `${option.settingKey} changes ${lang} output, so it must be declared for it`
              : `${option.settingKey} does nothing on ${lang}, so it must NOT be declared for it`
          );
        });
      }
    });
  }

  it('names the languages it is restricted to in every description', () => {
    for (const option of NEWLINE_OPTIONS) {
      const description = findBySettingKey(option.settingKey)!.description;
      assert.match(description, /Applies to CSS, SCSS, LESS, HTML and JavaScript/);
      assert.match(description, /no effect on JSON/);
      assert.match(description, /Prettier prints/);
    }
  });

  it('a .soukformatrc section for a language it does not serve says so, instead of going quiet', () => {
    for (const lang of ['json', 'typescript'] as const) {
      const { layers, warnings } = parseSoukformatrc(
        `{"${lang}": {"preserve_newlines": false}}`,
        lang,
        '/p/.soukformatrc'
      );
      assert.equal(layers.length, 0, `${lang}: nothing is forwarded`);
      assert.ok(
        warnings.some((w) => /preserve_newlines.*does not apply to/.test(w.message)),
        `${lang}: the user is told the option does not apply`
      );
    }
  });

  it('the option still works, and is still accepted, where it really does something', () => {
    const { layers, warnings } = parseSoukformatrc(
      '{"css": {"preserve_newlines": false}}',
      'css',
      '/p/.soukformatrc'
    );
    assert.equal(warnings.length, 0);
    assert.equal(layers[0].values.preserve_newlines, false);
  });
});

describe('config/optionCatalog : tidy.brace_style says where it applies (LOW-16)', () => {
  const entry = findBySettingKey('tidy.brace_style')!;

  it('is declared for JavaScript only', () => {
    for (const lang of SUPPORTED_LANG_IDS) {
      assert.equal(appliesToLanguage(entry, lang), lang === 'javascript', lang);
    }
  });

  it('its description no longer promises an effect outside JavaScript', () => {
    assert.match(entry.description, /JavaScript files printed by js-beautify/);
    assert.match(entry.description, /no effect on CSS, HTML or JSON/);
    assert.match(entry.description, /TypeScript, TSX, JSX/);
    assert.match(entry.description, /Prettier prints those with its own brace placement/);
  });

  for (const [lang, code] of [
    ['css', '.a{color:red}\n@media (min-width:1px){.b{margin:0}}\n'],
    ['html', '<div><script>function f(a){if(a){return 1}else{return 2}}</script></div>\n'],
    ['typescript', 'function f(a: number){if(a){return 1}else{return 2}}\nclass K{m(){return 1}}\n']
  ] as const) {
    it(`${lang}: expand really changes nothing, which is what the description says`, async () => {
      const format = (engineOptions: Record<string, unknown>): Promise<string> =>
        dispatchFormat({
          languageId: lang,
          code,
          options: { tabSize: 2, insertSpaces: true, engineOptions, sources: {} }
        });
      assert.equal(await format({}), await format({ brace_style: 'expand' }));
    });
  }

  it('javascript: expand really changes the output (the positive control)', async () => {
    const code = 'function f(a){if(a){return 1}else{return 2}}\n';
    const format = (engineOptions: Record<string, unknown>): Promise<string> =>
      dispatchFormat({
        languageId: 'javascript',
        code,
        options: { tabSize: 2, insertSpaces: true, engineOptions, sources: {} }
      });
    assert.notEqual(await format({}), await format({ brace_style: 'expand' }));
  });
});

describe('config/optionCatalog : the width and indent descriptions state the real behaviour', () => {
  it('tidy.indent says it overrides the editor and that project configs still win', () => {
    const d = findBySettingKey('tidy.indent')!.description;
    assert.match(d, /overrides the editor tab size/);
    assert.match(d, /project config/);
    assert.ok(
      !/used when neither the editor nor a project config provides one/.test(d),
      'the old "fallback only" wording described an inert setting'
    );
  });

  it('tidy.wrap_line_length and tidy.prettier.printWidth point at each other', () => {
    const wrap = findBySettingKey('tidy.wrap_line_length')!.description;
    const width = findBySettingKey('tidy.prettier.printWidth')!.description;
    assert.match(wrap, /shares one value with tidy\.prettier\.printWidth/);
    assert.match(width, /shares one value with tidy\.wrap_line_length/);
    assert.match(wrap, /higher layer wins/);
    assert.match(width, /higher layer wins/);
  });

  it('tidy.wrap_line_length keeps "0 disables wrapping" and says what unset means for Prettier', () => {
    const d = findBySettingKey('tidy.wrap_line_length')!.description;
    assert.match(d, /0 disables wrapping/);
    assert.match(d, /unset value keeps Prettier's default of 80/);
  });

  it('no description contains an em dash', () => {
    for (const entry of OPTION_CATALOG) {
      assert.ok(!entry.description.includes(String.fromCharCode(0x2014)), entry.settingKey);
    }
  });
});

describe('package.json : every setting that gates a per-file project config is resource-scoped (LOW-19)', () => {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, '..', '..', '..', 'package.json'), 'utf8')
  ) as {
    contributes: {
      configuration: Array<{ properties: Record<string, { scope?: string }> }>;
    };
  };
  const props = Object.assign({}, ...pkg.contributes.configuration.map((s) => s.properties)) as Record<
    string,
    { scope?: string }
  >;

  // The four switches that decide whether a project's own config file is read for
  // the file being formatted. All four are read with getConfiguration('tidy',
  // document.uri), so the read is already per resource; only the declared scope
  // can stop a folder of a multi-root workspace from carrying its own value.
  const PROJECT_CONFIG_GATES = [
    'tidy.editorconfig',
    'tidy.soukformatrc',
    'tidy.prettier.respectProjectConfig',
    'tidy.respectSoukformatignore'
  ];

  for (const key of PROJECT_CONFIG_GATES) {
    it(`${key} is declared with resource scope`, () => {
      assert.ok(props[key], `${key} must exist`);
      assert.equal(props[key].scope, 'resource');
    });
  }

  it('each of them is read scoped to the document being formatted', () => {
    const read = (file: string): string => readFileSync(join(__dirname, '..', '..', '..', file), 'utf8');
    assert.match(read('src/config/vscodeConfig.ts'), /getConfiguration\('tidy', document\.uri\)/);
    assert.match(read('src/ignore/ignoreGate.ts'), /getConfiguration\('tidy', document\.uri\)/);
  });

  it('the behaviour switches the README keeps window-scoped are unchanged', () => {
    // Out of scope for this fix, and pinned so a change is a decision, not a drift.
    for (const key of ['tidy.maxFileSizeKB', 'tidy.json.maxFileSizeKB', 'tidy.css.enable']) {
      assert.equal(props[key].scope, undefined, `${key} stays window-scoped`);
    }
  });
});

// ---------------------------------------------------------------------------------
// OPTIONS-6: the same rule for the six newest options, "declared <=> it does something
// there", checked against the engines instead of asserted from a table. Each option
// gets samples that really contain what it acts on (an `if`, a `<code>` element, a
// JSX element with several attributes, an object literal written expanded); the test
// formats them at the option's default and at a non-default value in every language
// and compares what changed with what the catalogue declares. A language is also
// pinned explicitly (`expected`), so a change of declaration is a decision, not a drift.
// ---------------------------------------------------------------------------------

const JS_CONTROL =
  'if (a) { b() }\nfor (var i = 0; i < 2; i++) {}\nwhile (x) {}\nswitch (x) { case 1: y(); }\nvar f = function() { return 1 };\n';
const HTML_TAGS = '<div><code>a    b\n   c</code><my-icon><p>x</p></div>\n';
const JSX_AND_OBJECT = 'const a = <Foo a="1" b="2" c="3" />;\nconst o = {\n  b: 1, c: 2 };\n';
const TS_OBJECT = 'const o = {\n  b: 1, c: 2 };\n';
const TS_ANGLE = 'const id = <T,>(v: T) => v;\nconst n = <number>x;\n';

type SampleKind = 'js' | 'html' | 'jsx-attrs' | 'objects';

/** A Vue SFC whose template holds the given markup (the style part is not needed here). */
const inTemplate = (markup: string): string => `<template>${markup}</template>\n`;

/** Samples per language; an option changes a language if ANY of its samples changes. */
function samplesFor(kind: SampleKind): Readonly<Record<CatalogLang, readonly string[]>> {
  const others = {
    css: [CSS],
    scss: [CSS],
    less: [CSS],
    json: [SAMPLES.json],
    jsonc: [SAMPLES.jsonc]
  };
  switch (kind) {
    case 'js':
      return {
        ...others,
        html: [`<div><script>${JS_CONTROL}</script><p>${LOREM}</p></div>\n`],
        vue: [inTemplate(`<div><script>${JS_CONTROL}</script><p>${LOREM}</p></div>\n`)],
        javascript: [JS_CONTROL],
        typescript: [JS_CONTROL],
        typescriptreact: [JS_CONTROL],
        javascriptreact: [JS_CONTROL]
      };
    case 'html':
      return {
        ...others,
        html: [HTML_TAGS],
        vue: [inTemplate(HTML_TAGS)],
        javascript: [JS_CONTROL],
        typescript: [JS_CONTROL],
        typescriptreact: [JS_CONTROL],
        javascriptreact: [JS_CONTROL]
      };
    case 'jsx-attrs':
    case 'objects':
      return {
        ...others,
        html: [HTML_TAGS],
        vue: [inTemplate(HTML_TAGS)],
        // A .js file is printed by Prettier only when it holds JSX, so both shapes
        // are tried: the option works on a .js file if it works on either.
        javascript: [JSX_AND_OBJECT, JS_CONTROL],
        // A .ts file cannot hold JSX, so its samples have none.
        typescript: [TS_OBJECT, TS_ANGLE],
        typescriptreact: [JSX_AND_OBJECT],
        javascriptreact: [JSX_AND_OBJECT]
      };
  }
}

interface SixOption {
  readonly settingKey: string;
  readonly kind: SampleKind;
  /** How the value travels in the engine's option bag. */
  readonly bag: (value: unknown) => Record<string, unknown>;
  readonly dflt: unknown;
  readonly nonDefault: unknown;
  readonly expected: readonly CatalogLang[];
}

const SIX: readonly SixOption[] = [
  {
    settingKey: 'tidy.space_before_conditional',
    kind: 'js',
    bag: (v) => ({ space_before_conditional: v }),
    dflt: true,
    nonDefault: false,
    expected: ['javascript']
  },
  {
    settingKey: 'tidy.jslint_happy',
    kind: 'js',
    bag: (v) => ({ jslint_happy: v }),
    dflt: false,
    nonDefault: true,
    expected: ['javascript']
  },
  {
    settingKey: 'tidy.content_unformatted',
    kind: 'html',
    bag: (v) => ({ content_unformatted: v }),
    dflt: [],
    nonDefault: ['code'],
    expected: ['html', 'vue']
  },
  {
    settingKey: 'tidy.void_elements',
    kind: 'html',
    bag: (v) => ({ void_elements: v }),
    dflt: [],
    nonDefault: ['my-icon'],
    expected: ['html', 'vue']
  },
  {
    settingKey: 'tidy.prettier.singleAttributePerLine',
    kind: 'jsx-attrs',
    bag: (v) => ({ prettier: { singleAttributePerLine: v } }),
    dflt: false,
    nonDefault: true,
    expected: ['typescriptreact', 'javascriptreact', 'javascript']
  },
  {
    settingKey: 'tidy.prettier.objectWrap',
    kind: 'objects',
    bag: (v) => ({ prettier: { objectWrap: v } }),
    dflt: 'preserve',
    nonDefault: 'collapse',
    expected: ['typescript', 'typescriptreact', 'javascriptreact', 'javascript']
  }
];

async function changesOutput(
  lang: CatalogLang,
  samples: readonly string[],
  bags: { readonly off: Record<string, unknown>; readonly on: Record<string, unknown> }
): Promise<boolean> {
  for (const code of samples) {
    const format = (engineOptions: Record<string, unknown>): Promise<string> =>
      dispatchFormat({
        languageId: lang,
        code,
        options: { tabSize: 2, insertSpaces: true, engineOptions, sources: {} }
      });
    if ((await format(bags.off)) !== (await format(bags.on))) {
      return true;
    }
  }
  return false;
}

describe('config/optionCatalog : the six OPTIONS-6 options are declared exactly where they work', () => {
  for (const option of SIX) {
    describe(option.settingKey, () => {
      const entry = findBySettingKey(option.settingKey);

      it("is in the catalogue, language-overridable, with the engine's own default", () => {
        assert.ok(entry, `${option.settingKey} must exist`);
        assert.equal(entry!.scope, 'language-overridable');
        assert.deepEqual(entry!.default, option.dflt);
      });

      for (const lang of SUPPORTED_LANG_IDS) {
        it(`${lang}: declared <=> the engine output changes`, async () => {
          const works = await changesOutput(lang, samplesFor(option.kind)[lang], {
            off: option.bag(option.dflt),
            on: option.bag(option.nonDefault)
          });
          assert.equal(
            appliesToLanguage(entry!, lang),
            works,
            works
              ? `${option.settingKey} changes ${lang} output, so it must be declared for it`
              : `${option.settingKey} does nothing on ${lang}, so it must NOT be declared for it`
          );
        });
      }

      it(`is declared for exactly ${option.expected.join(', ')}`, () => {
        const declared = SUPPORTED_LANG_IDS.filter((lang) => appliesToLanguage(entry!, lang));
        assert.deepEqual([...declared].sort(), [...option.expected].sort());
      });
    });
  }

  it('plain typescript is NOT declared for singleAttributePerLine: a .ts file holds no JSX', () => {
    assert.equal(
      appliesToLanguage(findBySettingKey('tidy.prettier.singleAttributePerLine')!, 'typescript'),
      false
    );
    assert.equal(
      appliesToLanguage(findBySettingKey('tidy.prettier.objectWrap')!, 'typescript'),
      true
    );
  });

  it('each description says where the option applies and where it does not', () => {
    const d = (key: string): string => findBySettingKey(key)!.description;
    for (const key of ['tidy.space_before_conditional', 'tidy.jslint_happy']) {
      assert.match(d(key), /no effect on CSS, HTML or JSON/, key);
      assert.match(d(key), /TypeScript, TSX, JSX or a JavaScript file that contains JSX/, key);
      assert.match(d(key), /Prettier/, key);
    }
    assert.match(
      d('tidy.prettier.singleAttributePerLine'),
      /Applies to TSX, JSX and a JavaScript file that contains JSX/
    );
    assert.match(d('tidy.prettier.singleAttributePerLine'), /no effect on plain TypeScript/);
    assert.match(
      d('tidy.prettier.objectWrap'),
      /Applies to TypeScript, TSX, JSX and a JavaScript file that contains JSX/
    );
    assert.match(d('tidy.prettier.objectWrap'), /no effect on JavaScript that js-beautify prints/);
    for (const key of ['tidy.content_unformatted', 'tidy.void_elements']) {
      assert.match(d(key), /always stay|which stay whatever you write/, `${key} says it is additive`);
      assert.match(d(key), /Show Effective Configuration/, `${key} says where invalid entries go`);
    }
  });

  it('an option set in a .soukformatrc section for a language it does not serve says so', () => {
    const cases: ReadonlyArray<readonly [CatalogLang, string, string]> = [
      ['css', 'jslint_happy', 'true'],
      ['typescript', 'space_before_conditional', 'false'],
      ['typescript', 'singleAttributePerLine', 'true'],
      ['html', 'objectWrap', '"collapse"'],
      ['javascript', 'content_unformatted', '["code"]'],
      ['css', 'void_elements', '["my-icon"]']
    ];
    for (const [lang, key, value] of cases) {
      const { layers, warnings } = parseSoukformatrc(
        `{"${lang}": {"${key}": ${value}}}`,
        lang,
        '/p/.soukformatrc'
      );
      assert.equal(layers.length, 0, `${lang}.${key}: nothing is forwarded`);
      assert.ok(
        warnings.some((w) => new RegExp(`${key}.*does not apply to ${lang}`).test(w.message)),
        `${lang}.${key}: the user is told the option does not apply`
      );
    }
  });

  it('a .soukformatrc section forwards the six options where they apply', () => {
    const read = (lang: CatalogLang, body: string): Record<string, unknown> => {
      const { layers, warnings } = parseSoukformatrc(`{"${lang}": ${body}}`, lang, '/p/.soukformatrc');
      assert.deepEqual(warnings, [], `${lang}: no warning`);
      return layers[0].values;
    };
    assert.deepEqual(read('javascript', '{"space_before_conditional": false, "jslint_happy": true}'), {
      space_before_conditional: false,
      jslint_happy: true
    });
    assert.deepEqual(read('html', '{"content_unformatted": ["code"], "void_elements": ["my-icon"]}'), {
      content_unformatted: ['code'],
      void_elements: ['my-icon']
    });
    assert.deepEqual(
      read('typescriptreact', '{"singleAttributePerLine": true, "prettier.objectWrap": "collapse"}'),
      { 'prettier.singleAttributePerLine': true, 'prettier.objectWrap': 'collapse' }
    );
    assert.deepEqual(read('typescript', '{"objectWrap": "collapse"}'), {
      'prettier.objectWrap': 'collapse'
    });
  });

  it('a .soukformatrc value of the wrong shape is refused whole, through the existing warning', () => {
    for (const body of [
      '{"content_unformatted": "code"}',
      '{"content_unformatted": ["code", 5]}',
      '{"void_elements": {"a": 1}}'
    ]) {
      const { layers, warnings } = parseSoukformatrc(`{"html": ${body}}`, 'html', '/p/.soukformatrc');
      assert.equal(layers.length, 0, body);
      assert.ok(
        warnings.some((w) => /invalid value for/.test(w.message)),
        body
      );
    }
    const { layers, warnings } = parseSoukformatrc(
      '{"typescript": {"objectWrap": "wrap"}}',
      'typescript',
      '/p/.soukformatrc'
    );
    assert.equal(layers.length, 0);
    assert.ok(warnings.some((w) => /invalid value for "objectWrap"/.test(w.message)));
  });
});
