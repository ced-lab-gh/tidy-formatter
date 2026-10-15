// Unit tests for the Vue SFC engine (ADD-15). Pure: dispatchFormat + guard only.
import assert from 'node:assert/strict';
import {
  __resetChunksForTests,
  __setChunkLoadForTests,
  chunksForLanguages,
  isChunkLoadError
} from '../../../src/chunks/loader';
import { dispatchFormat, pickEngine } from '../../../src/engine/dispatcher';
import { VueSfcEngine } from '../../../src/engine/vueSfc';
import {
  buildMaskPlan,
  UNHONOURED_IGNORE_VUE_REGIONS
} from '../../../src/engine/maskPlan';
import { scanMarkers } from '../../../src/ignore/markers';
import { guard } from '../../../src/safety/guard';
import type { ResolvedOptions } from '../../../src/types';
import { vueFixtures, VUE_BASIC } from '../../fixtures/vueFixtures';

const OPTS: ResolvedOptions = {
  tabSize: 2,
  insertSpaces: true,
  engineOptions: {},
  sources: {}
};

const format = (code: string) =>
  dispatchFormat({ languageId: 'vue', code, options: OPTS });

describe('engine/vueSfc : dispatcher routing', () => {
  it('routes languageId vue to the vue-sfc engine', () => {
    assert.equal(pickEngine('vue').id, 'vue-sfc');
    assert.equal(pickEngine('vue').supports('vue'), true);
    assert.equal(pickEngine('vue').supports('html'), false);
  });

  it('preloads only the two verifier chunks a first vue format reaches', () => {
    assert.deepEqual(chunksForLanguages(['vue']), ['chunk-guard-css', 'chunk-guard-html']);
  });
});

describe('engine/vueSfc : corpus behaviour (format + guard + idempotence)', () => {
  for (const fixture of vueFixtures) {
    it(`${fixture.id}: ${fixture.desc}`, async () => {
      const output = await format(fixture.input);

      if (fixture.expectNoop) {
        assert.equal(output, fixture.input, 'expected a clean whole-file no-op');
        return;
      }

      assert.notEqual(output, fixture.input, 'the engine must actually format');
      // I1: the provider-level guard must accept what the engine produced.
      const verdict = guard.check('vue', fixture.input, output);
      assert.equal(
        verdict.equivalent,
        true,
        `guard must accept the engine output (reason: ${verdict.reason ?? 'n/a'})`
      );
      // Verbatim spans (script bodies, custom blocks, skeleton comments).
      for (const span of fixture.verbatimSpans) {
        assert.ok(
          output.includes(span),
          `verbatim span must survive byte-for-byte: ${JSON.stringify(span)}`
        );
      }
      // I2: idempotence, byte-for-byte.
      const second = await format(output);
      assert.equal(second, output, 'second pass must be a fixed point');
    });
  }
});

describe('engine/vueSfc : template details', () => {
  it('normalises template markup but never rewrites Vue directive attributes', async () => {
    const output = await format(VUE_BASIC);
    // Directive names and expressions survive as attributes (values verbatim).
    assert.ok(output.includes('v-if="visible"'));
    assert.ok(output.includes(':title="label"'));
    assert.ok(output.includes('@click="onClick"'));
    // The messy multi-space run inside the template tagging is gone.
    assert.ok(!output.includes('<div   class'));
  });

  it('keeps the script block ENTIRELY byte-identical (tags included)', async () => {
    const output = await format(VUE_BASIC);
    const scriptBlock =
      '<script setup lang="ts">\nconst count = props?.count ?? 0;\n' +
      'function onClick(){emit("pick",count)}\n</script>';
    assert.ok(
      output.includes(scriptBlock),
      'the whole script block must survive byte-for-byte'
    );
  });
});

describe('engine/vueSfc : degraded blocks and defensive paths', () => {
  it('degrades an unparsable style block to verbatim while still formatting the template', async () => {
    const input =
      '<template>\n<p    >x</p>\n</template>\n' +
      '<style>\n.a { color: ;;;\n</style>\n';
    const output = await format(input);
    // The broken css body fails both engines' per-block check: kept verbatim.
    assert.ok(output.includes('.a { color: ;;;'));
    // The template still formats (the file is not a whole-file no-op).
    assert.ok(!output.includes('<p    >'));
    // And the global guard accepts the mixed result.
    assert.equal(guard.check('vue', input, output).equivalent, true);
  });

  it('returns the identity on a range request (v1 is whole-document only)', async () => {
    const engine = new VueSfcEngine();
    const out = await engine.format({
      languageId: 'vue',
      code: VUE_BASIC,
      options: OPTS,
      range: { startOffset: 0, endOffset: 10 }
    });
    assert.equal(out, VUE_BASIC);
  });

  it('honours a resolved crlf endOfLine inside formatted style blocks', async () => {
    const input = '<template>\n<p>x</p>\n</template>\n<style>\n.a{color:red}\n</style>\n';
    const output = await dispatchFormat({
      languageId: 'vue',
      code: input,
      options: { ...OPTS, endOfLine: 'crlf' }
    });
    const styleBody = output.slice(output.indexOf('<style>'), output.indexOf('</style>'));
    assert.ok(styleBody.includes('\r\n'), 'style block joins must use CRLF');
  });
});

describe('engine/vueSfc : Vue whitespace, duplicate attributes, chunk failures', () => {
  afterEach(() => {
    __resetChunksForTests();
  });

  it('leaves a template verbatim when the format would change how Vue renders it (V1, V2)', async () => {
    for (const body of [
      '<div><MyBtn>A</MyBtn> <MyBtn>B</MyBtn></div>',
      '<h2>Inbox<Badge :count="n" /></h2>',
      '<div><Star /> <Star /> <Star /></div>'
    ]) {
      const input = `<template>\n${body}\n</template>\n`;
      assert.equal(await format(input), input, body);
    }
  });

  it('still formats the styles when the template is left verbatim', async () => {
    const input =
      '<template>\n<div><MyBtn>A</MyBtn> <MyBtn>B</MyBtn></div>\n</template>\n<style>\n.a{color:red}\n</style>\n';
    const output = await format(input);
    assert.ok(output.startsWith('<template>\n<div><MyBtn>A</MyBtn> <MyBtn>B</MyBtn></div>\n</template>'));
    assert.ok(output.includes('color: red'));
    assert.equal(guard.check('vue', input, output).equivalent, true);
  });

  it('is a clean no-op when a block tag repeats an attribute (V4)', async () => {
    for (const input of [
      '<template lang="html" lang="pug">\ndiv\n  p   hello\n</template>\n',
      '<template>\n<p   >x</p>\n</template>\n<script setup lang="ts" lang="js">\nlet a  =  1\n</script>\n'
    ]) {
      assert.equal(await format(input), input);
    }
  });

  it('lets a Prettier chunk load failure during the CSS fallback abort the format (V8)', async () => {
    const input =
      '<template>\n<p   >x</p>\n</template>\n' +
      '<style lang="scss">\n@import \'mixins\';\n.a{ @if $x == 1 { color: red } @else { color: blue } }\n</style>\n';
    __setChunkLoadForTests('chunk-prettier', () => {
      throw new Error('unavailable');
    });
    await assert.rejects(format(input), (error: unknown) => {
      assert.match((error as Error).message, /^prettier engine unavailable: failed to load chunk-prettier/);
      return isChunkLoadError(error);
    });
  });

  it('formats a style whose body starts on the opening-tag line idempotently', async () => {
    for (const styleBlock of [
      '<style> .a{color:red}\n.b{color:blue}\n</style>',
      '<style scoped>   \n  .a{color:red}\n  .b{color:blue}\n</style>',
      '<style>\t.a{color:red} .b{color:blue}</style>'
    ]) {
      const input = `<template>\n<p>x</p>\n</template>\n${styleBlock}\n`;
      const first = await format(input);
      assert.notEqual(first, input);
      assert.equal(guard.check('vue', input, first).equivalent, true);
      assert.equal(await format(first), first, 'a second pass must change nothing');
      // The first rule is not left alone in column 0 while the rest is shifted.
      assert.match(first, /\n\.a \{\n {2}color: red;?\n\}\n\n\.b \{/);
    }
  });
});

describe('engine/vueSfc : ignore markers (v1)', () => {
  it('the top-of-file marker is recognised in a .vue file (SGML comments)', () => {
    const doc = '<!-- tidy-ignore-file -->\n<template>\n<p   >x</p>\n</template>\n';
    assert.equal(scanMarkers(doc, 'vue').ignoreFile, true);
  });

  it('a region marker gets the Vue notice, never the Prettier sentence', () => {
    const doc =
      '<template>\n<!-- tidy-ignore-start -->\n<p   >x</p>\n<!-- tidy-ignore-end -->\n</template>\n';
    const plan = buildMaskPlan('vue', doc, 'document');
    assert.equal(plan.unhonouredIgnore, UNHONOURED_IGNORE_VUE_REGIONS);
    assert.ok(!UNHONOURED_IGNORE_VUE_REGIONS.includes('Prettier'));
    assert.match(UNHONOURED_IGNORE_VUE_REGIONS, /^[\x20-\x7e]+$/, 'ASCII only');
  });
});
