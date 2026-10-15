// Unit tests for the Vue SFC engine (ADD-15). Pure: dispatchFormat + guard only.
import assert from 'node:assert/strict';
import { dispatchFormat, pickEngine } from '../../../src/engine/dispatcher';
import { VueSfcEngine } from '../../../src/engine/vueSfc';
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
