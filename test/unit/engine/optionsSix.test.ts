// OPTIONS-6: six style options, proved end to end through the real engines.
//
//   JavaScript (js-beautify)   tidy.space_before_conditional, tidy.jslint_happy
//   HTML (js-beautify)         tidy.content_unformatted, tidy.void_elements
//   TSX / JSX / .js with JSX   tidy.prettier.singleAttributePerLine,
//   (Prettier)                 tidy.prettier.objectWrap
//
// What is pinned here, and why each block exists:
//   1. DEFAULTS ARE TODAY'S BEHAVIOUR. An option set explicitly to its default, all
//      six together, must print byte for byte what an unset option prints, on the
//      whole general corpus (all ten languages). A user who touches none of them
//      must not see a single character move.
//   2. EACH OPTION DOES SOMETHING, on fixtures built so it has something to do (the
//      general corpus cannot exercise objectWrap: see test/fixtures/optionsSixFixtures.ts),
//      and the CONTROLS it must leave alone stay alone.
//   3. THE TWO TAG LISTS ARE ADDITIVE ONLY. What the user writes is added to the
//      built-in list; the built-ins survive whatever is written, which is what keeps
//      the guard's verbatim elements verbatim (probe P16c) and the standard void
//      elements void.
//   4. NO NEW GUARD REJECTION. Every variant, on every corpus snippet of its
//      languages, still passes the equivalence guard, and formats to a fixed point.
import assert from 'node:assert/strict';
import { dispatchFormat } from '../../../src/engine/dispatcher';
import { STANDARD_VOID_ELEMENTS } from '../../../src/engine/jsbeautify';
import { htmlPreformattedTags } from '../../../src/safety/htmlPreformatted';
import type { LangId } from '../../../src/types';
import { guardCheckNoFastPath } from '../../helpers/guardCheck';
import { corpus } from '../../fixtures/corpus';
import {
  EXTRA_CONTENT_UNFORMATTED,
  EXTRA_VOID_ELEMENTS,
  contentUnformattedFixtures,
  jslintHappyFixtures,
  objectWrapFixtures,
  singleAttributePerLineFixtures,
  spaceBeforeConditionalFixtures,
  voidElementsFixtures,
  type OptionFixture
} from '../../fixtures/optionsSixFixtures';

type EngineOptions = Record<string, unknown>;

/** Format through the real dispatcher (engine choice, JSX re-routing included). */
function run(lang: LangId, code: string, engineOptions: EngineOptions): Promise<string> {
  return dispatchFormat({
    languageId: lang,
    code,
    options: { tabSize: 2, insertSpaces: true, engineOptions, sources: {} }
  });
}

/** One option under test: how to spell its default and a non-default value. */
interface Variant {
  readonly name: string;
  readonly fixtures: readonly OptionFixture[];
  readonly defaults: EngineOptions;
  readonly nonDefault: EngineOptions;
}

const VARIANTS: readonly Variant[] = [
  {
    name: 'tidy.space_before_conditional',
    fixtures: spaceBeforeConditionalFixtures,
    defaults: { space_before_conditional: true },
    nonDefault: { space_before_conditional: false }
  },
  {
    name: 'tidy.jslint_happy',
    fixtures: jslintHappyFixtures,
    defaults: { jslint_happy: false },
    nonDefault: { jslint_happy: true }
  },
  {
    name: 'tidy.content_unformatted',
    fixtures: contentUnformattedFixtures,
    defaults: { content_unformatted: [] },
    nonDefault: { content_unformatted: [...EXTRA_CONTENT_UNFORMATTED] }
  },
  {
    name: 'tidy.void_elements',
    fixtures: voidElementsFixtures,
    defaults: { void_elements: [] },
    nonDefault: { void_elements: [...EXTRA_VOID_ELEMENTS] }
  },
  {
    name: 'tidy.prettier.singleAttributePerLine',
    fixtures: singleAttributePerLineFixtures,
    defaults: { prettier: { singleAttributePerLine: false } },
    nonDefault: { prettier: { singleAttributePerLine: true } }
  },
  {
    name: 'tidy.prettier.objectWrap',
    fixtures: objectWrapFixtures,
    defaults: { prettier: { objectWrap: 'preserve' } },
    nonDefault: { prettier: { objectWrap: 'collapse' } }
  }
];

/** All six at their defaults, written out: the bag a "nothing configured" user gets. */
const ALL_DEFAULTS: EngineOptions = {
  space_before_conditional: true,
  jslint_happy: false,
  content_unformatted: [],
  void_elements: [],
  prettier: { singleAttributePerLine: false, objectWrap: 'preserve' }
};

describe('engine : OPTIONS-6 defaults are today\'s behaviour', () => {
  it('all six at their defaults print byte for byte what an unset bag prints, on the whole corpus', async () => {
    let compared = 0;
    for (const snippet of corpus) {
      const unset = await run(snippet.lang, snippet.code, {});
      const explicit = await run(snippet.lang, snippet.code, ALL_DEFAULTS);
      assert.equal(explicit, unset, `${snippet.id} (${snippet.lang}) moved at the defaults`);
      compared += 1;
    }
    assert.equal(compared, corpus.length);
    assert.ok(compared >= 70, 'the corpus is the general one, not a token sample');
  });

  for (const variant of VARIANTS) {
    it(`${variant.name}: its default, written out, changes no fixture`, async () => {
      for (const fixture of variant.fixtures) {
        assert.equal(
          await run(fixture.lang, fixture.input, variant.defaults),
          await run(fixture.lang, fixture.input, {}),
          `${fixture.id} moved at the default`
        );
      }
    });
  }

  it('an absent list, an empty list and a list of only built-ins are the same thing', async () => {
    const doc = '<div><pre>  a   b</pre><br><img src="a.png"><p>x</p></div>\n';
    const unset = await run('html', doc, {});
    assert.equal(await run('html', doc, { content_unformatted: [], void_elements: [] }), unset);
    assert.equal(
      await run('html', doc, {
        content_unformatted: [...htmlPreformattedTags()],
        void_elements: [...STANDARD_VOID_ELEMENTS.filter((t) => /^[a-z]/.test(t))]
      }),
      unset
    );
  });
});

describe('engine : each OPTIONS-6 option changes the output where it has something to do', () => {
  for (const variant of VARIANTS) {
    describe(variant.name, () => {
      for (const fixture of variant.fixtures) {
        it(`${fixture.id}: ${fixture.note}`, async () => {
          const before = await run(fixture.lang, fixture.input, {});
          const after = await run(fixture.lang, fixture.input, variant.nonDefault);
          assert.equal(
            after !== before,
            fixture.changes,
            fixture.changes
              ? `${fixture.id} should change under ${variant.name}`
              : `${fixture.id} is a control and must not change under ${variant.name}`
          );
        });
      }

      it('every fixture passes the guard and formats to a fixed point with the option set', async () => {
        for (const fixture of variant.fixtures) {
          const out = await run(fixture.lang, fixture.input, variant.nonDefault);
          const verdict = guardCheckNoFastPath(fixture.lang, fixture.input, out);
          assert.equal(verdict.equivalent, true, `${fixture.id}: ${verdict.reason ?? ''}`);
          assert.equal(
            await run(fixture.lang, out, variant.nonDefault),
            out,
            `${fixture.id} is not idempotent`
          );
        }
      });

      it('has at least one fixture that changes and at least one control that does not', () => {
        assert.ok(variant.fixtures.some((f) => f.changes), 'no fixture exercises the option');
        assert.ok(variant.fixtures.some((f) => !f.changes), 'no control');
      });
    });
  }
});

describe('engine : js-beautify JavaScript options (concrete output)', () => {
  it('space_before_conditional false drops the space after if, for, while and switch, and only there', async () => {
    const out = await run(
      'javascript',
      'if (a) { b() }\nfor (var i = 0; i < 2; i++) {}\nwhile (x) {}\nswitch (x) { case 1: y(); }\ntry {} catch (e) {}\n',
      { space_before_conditional: false }
    );
    assert.match(out, /^if\(a\) \{/m);
    assert.match(out, /^for\(var i = 0; i < 2; i\+\+\) \{\}/m);
    assert.match(out, /^while\(x\) \{\}/m);
    assert.match(out, /^switch\(x\) \{/m);
    assert.match(out, /catch \(e\)/, 'catch is not a conditional');
  });

  it('jslint_happy puts a space after an anonymous function and levels case with switch', async () => {
    const out = await run(
      'javascript',
      'var f = function() { return 1 };\nswitch (x) { case 1: y(); }\n',
      { jslint_happy: true }
    );
    assert.match(out, /var f = function \(\) \{/);
    assert.match(out, /^case 1:/m, 'case is level with switch');
  });

  it('neither option reaches a TypeScript file: Prettier prints it the same either way', async () => {
    const code = 'if (a) { b() }\nconst f = function() { return 1 };\nswitch (x) { case 1: y(); }\n';
    const base = await run('typescript', code, {});
    assert.equal(await run('typescript', code, { space_before_conditional: false }), base);
    assert.equal(await run('typescript', code, { jslint_happy: true }), base);
  });

  it('neither option reaches the JavaScript embedded in an HTML <script>', async () => {
    const code = '<div><script>if (a) { b() }\nvar f = function() { return 1 }</script></div>\n';
    const base = await run('html', code, {});
    assert.equal(await run('html', code, { space_before_conditional: false, jslint_happy: true }), base);
  });
});

describe('engine : tidy.content_unformatted is ADDITIVE ONLY', () => {
  const XMP = '<xmp>\tx   y\n   z</xmp>';
  const TEXTAREA = '<textarea>  a   b\n   c</textarea>';
  const CODE = '<code>a    b\n   c</code>';
  const DOC = `<div>${XMP}${TEXTAREA}${CODE}</div>\n`;
  const PRE_TEXT = '\tx   y\n   z';

  it('an added tag is kept as written', async () => {
    const out = await run('html', DOC, { content_unformatted: ['code'] });
    assert.ok(out.includes(CODE), 'the added tag keeps its spaces and its line break');
    const base = await run('html', DOC, {});
    assert.ok(!base.includes(CODE), 'control: without the option the same tag is reflowed');
  });

  it('the built-in tags survive a list that does not name them', async () => {
    for (const list of [[], ['code'], ['pre'], ['textarea'], ['p', 'li'], ['my-tag']]) {
      const out = await run('html', DOC, { content_unformatted: list });
      assert.ok(out.includes(XMP), `<xmp> reflowed under ${JSON.stringify(list)}`);
      assert.ok(out.includes(TEXTAREA), `<textarea> reflowed under ${JSON.stringify(list)}`);
      assert.ok(out.includes(PRE_TEXT));
    }
  });

  it('a list that tries to be the printer\'s own default does not re-open <xmp>', async () => {
    // js-beautify's default is ['pre', 'textarea']: writing exactly that is the
    // "shrink the list" the option must not allow (probe P16c).
    const out = await run('html', DOC, { content_unformatted: ['pre', 'textarea'] });
    assert.ok(out.includes(XMP));
    assert.equal(guardCheckNoFastPath('html', DOC, out).equivalent, true);
  });

  it('every built-in tag stays preserved with the user list empty, long or hostile', async () => {
    for (const tag of htmlPreformattedTags()) {
      const doc = `<div><${tag}>  a   b\n   c</${tag}></div>\n`;
      for (const list of [[], ['code'], Array.from({ length: 50 }, (_, i) => `t${i}`), ['(', 'a b']]) {
        const out = await run('html', doc, { content_unformatted: list });
        assert.ok(out.includes('  a   b\n   c'), `<${tag}> reflowed under ${JSON.stringify(list).slice(0, 40)}`);
      }
    }
  });

  it('invalid entries are dropped and the valid ones still apply', async () => {
    const valid = await run('html', DOC, { content_unformatted: ['code'] });
    for (const hostile of ['a b', '<code>', 'a(', '[', '\\', 'x+', '', ' ', '1a', 'é', 'a'.repeat(200)]) {
      assert.equal(
        await run('html', DOC, { content_unformatted: [hostile, 'code'] }),
        valid,
        `${JSON.stringify(hostile)} must be dropped without costing the rest of the list`
      );
    }
  });

  it('tag names are case-insensitive: Code is code, in the list and in the document', async () => {
    assert.equal(
      await run('html', DOC, { content_unformatted: ['CODE'] }),
      await run('html', DOC, { content_unformatted: ['code'] })
    );
    const upper = '<div><CODE>a    b\n   c</CODE></div>\n';
    const out = await run('html', upper, { content_unformatted: ['code'] });
    assert.ok(out.includes('<CODE>a    b\n   c</CODE>'), 'an upper-case tag in the document is matched too');
    assert.equal(guardCheckNoFastPath('html', upper, out).equivalent, true);
  });

  it('a value that is not a list is ignored, never fatal', async () => {
    const base = await run('html', DOC, {});
    for (const bad of ['code', 7, true, { code: 1 }, null]) {
      assert.equal(await run('html', DOC, { content_unformatted: bad }), base);
    }
  });
});

describe('engine : tidy.void_elements is ADDITIVE ONLY', () => {
  const STANDARD_DOC =
    '<div><p>one<br>two</p><hr><img src="a.png"><input type="text"><link rel="x"><meta charset="utf-8"></div>\n';

  it('the standard void elements stay void whatever the list says', async () => {
    const base = await run('html', STANDARD_DOC, {});
    for (const list of [[], ['my-icon'], ['span'], ['foo', 'bar'], ['img'], ['br', 'hr']]) {
      assert.equal(
        await run('html', STANDARD_DOC, { void_elements: list }),
        base,
        `the standard elements moved under ${JSON.stringify(list)}`
      );
    }
  });

  it('an added custom element is printed as void', async () => {
    const doc = '<div><my-icon><p>x</p></div>\n';
    const base = await run('html', doc, {});
    const out = await run('html', doc, { void_elements: ['my-icon'] });
    assert.notEqual(out, base);
    assert.match(out, /^ {2}<p>x<\/p>$/m, 'the sibling sits at the same depth as the void element');
    assert.match(base, /^ {4}<p>x<\/p>$/m, 'control: without the option it is indented under it');
  });

  it('elements whose text must stay as written cannot be made void', async () => {
    const doc =
      '<div><pre>  a   b\n   c</pre><textarea>  a   b</textarea><xmp>\tx   y</xmp><script>var a  =  1;</script><style>.a   { color : red }</style><p>x</p></div>\n';
    const base = await run('html', doc, {});
    for (const tag of ['pre', 'textarea', 'xmp', 'listing', 'plaintext', 'script', 'style']) {
      const out = await run('html', doc, { void_elements: [tag] });
      assert.equal(out, base, `${tag} must be refused as a void element`);
      assert.equal(guardCheckNoFastPath('html', doc, out).equivalent, true);
    }
  });

  it('invalid entries are dropped and the valid ones still apply', async () => {
    const doc = '<div><my-icon><p>x</p></div>\n';
    const valid = await run('html', doc, { void_elements: ['my-icon'] });
    for (const hostile of ['a b', '<x>', 'a(', '[', '\\', 'x+', '', '1a', 'a'.repeat(200)]) {
      assert.equal(await run('html', doc, { void_elements: [hostile, 'my-icon'] }), valid);
    }
  });

  it('a value that is not a list is ignored, never fatal', async () => {
    const doc = '<div><my-icon><p>x</p></div>\n';
    const base = await run('html', doc, {});
    for (const bad of ['my-icon', 7, true, { a: 1 }, null]) {
      assert.equal(await run('html', doc, { void_elements: bad }), base);
    }
  });
});

describe('engine : STANDARD_VOID_ELEMENTS is js-beautify\'s own default list', () => {
  it('equals the void_elements default of the installed js-beautify, entry for entry', () => {
    // Passing void_elements REPLACES js-beautify's list, so the engine must hand the
    // standard list back in full. This pins the copy to the installed version: an
    // upgrade that changes the default fails here instead of silently diverging.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Options } = require('js-beautify/js/src/html/options') as {
      Options: new (raw: Record<string, unknown>) => { void_elements: string[] };
    };
    assert.deepEqual([...STANDARD_VOID_ELEMENTS], new Options({}).void_elements);
  });

  it('is frozen, so nothing can grow or shrink it at runtime', () => {
    assert.ok(Object.isFrozen(STANDARD_VOID_ELEMENTS));
  });
});

describe('engine : Prettier options are read, validated and never invented', () => {
  it('singleAttributePerLine puts every attribute of a multi-attribute element on its own line', async () => {
    const out = await run('typescriptreact', 'const a = <Foo a="1" b="2" c="3" />;\n', {
      prettier: { singleAttributePerLine: true }
    });
    assert.match(out, /^ {4}a="1"$/m);
    assert.match(out, /^ {4}b="2"$/m);
    assert.match(out, /^ {4}c="3"$/m);
  });

  it('objectWrap collapse joins an expanded literal that fits; preserve keeps it', async () => {
    const code = 'const o = {\n  a: 1, b: 2 };\n';
    assert.equal(await run('typescript', code, { prettier: { objectWrap: 'collapse' } }), 'const o = { a: 1, b: 2 };\n');
    assert.equal(await run('typescript', code, { prettier: { objectWrap: 'preserve' } }), 'const o = {\n  a: 1,\n  b: 2,\n};\n');
  });

  it('a value of the wrong type or outside the enum never reaches Prettier', async () => {
    const tsx = 'const a = <Foo a="1" b="2" />;\nconst o = {\n  a: 1 };\n';
    const base = await run('typescriptreact', tsx, {});
    for (const prettier of [
      { singleAttributePerLine: 'true' },
      { singleAttributePerLine: 1 },
      { singleAttributePerLine: null },
      { objectWrap: 'wrap' },
      { objectWrap: true },
      { objectWrap: 'COLLAPSE' },
      { objectWrap: ['collapse'] }
    ]) {
      assert.equal(await run('typescriptreact', tsx, { prettier }), base, JSON.stringify(prettier));
    }
  });

  it('a .js file WITHOUT JSX is printed by js-beautify, which ignores both Prettier options', async () => {
    const code = 'var o = {\n  a: 1, b: 2 };\nvar s = "x";\n';
    assert.equal(
      await run('javascript', code, { prettier: { singleAttributePerLine: true, objectWrap: 'collapse' } }),
      await run('javascript', code, {})
    );
  });

  it('quoteProps is still not readable: the allow-list did not grow past the two new keys', async () => {
    const code = 'const o = { a: 1, "b-c": 2 };\n';
    assert.equal(
      await run('typescript', code, { prettier: { quoteProps: 'consistent' } }),
      await run('typescript', code, {})
    );
  });
});

describe('engine : no new guard rejection on the general corpus, every option at a non-default value', () => {
  // The HTML variants are deliberately aggressive: a list that hits tags the corpus
  // really holds (p, li, a, span, div, h1, td), and one that adds span as a void
  // element. P16 measured both at 0 rejections; this keeps it that way.
  const CORPUS_VARIANTS: ReadonlyArray<{ name: string; options: EngineOptions; langs: readonly LangId[] }> = [
    { name: 'space_before_conditional=false', options: { space_before_conditional: false }, langs: ['javascript'] },
    { name: 'jslint_happy=true', options: { jslint_happy: true }, langs: ['javascript'] },
    {
      name: 'content_unformatted=code',
      options: { content_unformatted: ['code'] },
      langs: ['html']
    },
    {
      name: 'content_unformatted=p,li,a,span,div,h1,td',
      options: { content_unformatted: ['p', 'li', 'a', 'span', 'div', 'h1', 'td'] },
      langs: ['html']
    },
    { name: 'void_elements=my-icon', options: { void_elements: ['my-icon'] }, langs: ['html'] },
    { name: 'void_elements=span', options: { void_elements: ['span'] }, langs: ['html'] },
    {
      name: 'singleAttributePerLine=true',
      options: { prettier: { singleAttributePerLine: true } },
      langs: ['typescriptreact', 'javascriptreact', 'javascript', 'typescript']
    },
    {
      name: 'objectWrap=collapse',
      options: { prettier: { objectWrap: 'collapse' } },
      langs: ['typescriptreact', 'javascriptreact', 'javascript', 'typescript']
    }
  ];

  for (const variant of CORPUS_VARIANTS) {
    it(`${variant.name}: every ${variant.langs.join('/')} corpus snippet is accepted and idempotent`, async () => {
      let checked = 0;
      for (const snippet of corpus) {
        if (!variant.langs.includes(snippet.lang)) {
          continue;
        }
        const out = await run(snippet.lang, snippet.code, variant.options);
        const verdict = guardCheckNoFastPath(snippet.lang, snippet.code, out);
        assert.equal(verdict.equivalent, true, `${snippet.id}: ${verdict.reason ?? ''}`);
        assert.equal(
          await run(snippet.lang, out, variant.options),
          out,
          `${snippet.id} is not a fixed point under ${variant.name}`
        );
        checked += 1;
      }
      assert.ok(checked >= 5, `only ${checked} snippets exercised ${variant.name}`);
    });
  }
});
