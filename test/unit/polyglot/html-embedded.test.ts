// POLYGLOT HTML corpus — HTML documents that embed SEVERAL languages at once and
// must survive the format -> guard -> idempotence pipeline on the `html`
// languageId.
//
// What "polyglot" means here: a single .html file mixing
//   - several <script> blocks of modern JS (private fields, bigint, optional
//     chaining, nullish, async/await, destructuring, template literals),
//   - a <script type="application/json"> (and importmap / ld+json) data block,
//   - several <style> blocks (CSS with @media / var() / calc() / @supports / @keyframes),
//   - inline event handlers (onclick="...", onmouseover="...", onfocus="..."),
//   - inline style="..." attributes (with var()/calc()),
//   - inline <svg> (camelCase + namespaced xlink:href + gradients),
//   - template islands {{ }} / {% %} / <% %> / <%= %>,
//   - <pre>/<textarea> verbatim content.
//
// HTML always routes to JsBeautifyEngine (SPEC §4). The guard for HTML is
// `htmlTreeEqual` (parse5 tree comparison) which canonicalises EACH embedded
// body through ITS OWN language: <script> JS via the babel AST, <script
// type=*json*> via the JSON value, <style> via the PostCSS shape, and treats
// <pre>/<textarea> + opaque-type scripts VERBATIM (guard.ts:
// canonicalizeEmbeddedCode / cssShape / canonicalizeJsonForEmbed). Template
// islands in text/attributes are plain HTML text/attr strings, preserved as-is.
//
// The ACCEPT contract (per fixture):
//   1. CHANGED     — the engine actually reformatted the input (not a vacuous
//                    no-op pass that would make the guard assertion meaningless),
//   2. EQUIVALENT  — guard.check('html', input, output).equivalent === true
//                    (embedded JS/CSS/JSON re-indented but semantically identical;
//                     islands + verbatim blocks intact). A false rejection here is
//                    the "safe but does nothing" failure SPEC §12 forbids,
//   3. IDEMPOTENT  — format(format(x)) === format(x) (SAFE-03, no right-drift),
//   4. PRESERVED   — every pinned `mustContain` token survives in the output.
//
// The REJECT block is the security half: a meaning change in ANY embedded
// language (JS / CSS / JSON / inline handler / inline style / SVG attr / island
// text / <pre>/<textarea> whitespace) MUST be rejected by the guard — the guard
// must never let a meaning change through, even when the tampered output is itself
// well-formed HTML (the parse-only trap).
//
// Ground truth for every assertion below was probed against the REAL
// dispatchFormat + guard before the assertions were written.
import assert from 'node:assert/strict';
import { dispatchFormat } from '../../../src/engine/dispatcher';
import { guard, htmlTreeEqual } from '../../../src/safety/guard';
import type { ResolvedOptions } from '../../../src/types';
import { polyglotFixtures } from '../../fixtures/polyglot/htmlEmbedded';

const OPTS: ResolvedOptions = {
  tabSize: 2,
  insertSpaces: true,
  engineOptions: {},
  sources: {}
};

async function formatHtml(code: string): Promise<string> {
  return dispatchFormat({ languageId: 'html', code, options: OPTS });
}

describe('polyglot HTML (embedded JS/CSS/JSON + islands) — format + guard + idempotence', () => {
  describe('ACCEPT: each polyglot fixture reformats safely and idempotently', () => {
    for (const fixture of polyglotFixtures) {
      describe(`${fixture.id} — ${fixture.desc}`, () => {
        let out = '';
        let out2 = '';

        before(async () => {
          out = await formatHtml(fixture.input);
          out2 = await formatHtml(out);
        });

        it('actually reformats the input (not a vacuous no-op)', () => {
          assert.notEqual(
            out,
            fixture.input,
            'the engine must change the messy input, otherwise the guard assertion is vacuous'
          );
        });

        it('passes the guard (embedded code re-indented but semantically equal)', () => {
          const verdict = guard.check('html', fixture.input, out);
          assert.equal(
            verdict.equivalent,
            true,
            `guard wrongly rejected a valid polyglot format: ${verdict.reason ?? ''}`
          );
        });

        it('is idempotent (second pass changes nothing)', () => {
          assert.equal(
            out,
            out2,
            'formatting drifted on a second pass (right-drift / non-idempotent)'
          );
        });

        it('preserves every pinned token verbatim', () => {
          for (const token of fixture.mustContain) {
            assert.ok(
              out.includes(token),
              `expected token to survive formatting: ${JSON.stringify(token)}`
            );
          }
        });
      });
    }
  });

  describe('ACCEPT: targeted polyglot guarantees', () => {
    it('re-indents embedded JS in multiple <script> blocks while keeping JSON data exact', async () => {
      const input = polyglotFixtures.find((f) => f.id === 'PG-MULTI-SCRIPT-STYLE')!.input;
      const out = await formatHtml(input);
      // The JS bodies were reflowed (proves the embedded code was actually touched)...
      assert.ok(out.includes('const xs = [1, 2, 3];'), 'JS body should be re-indented');
      assert.ok(out.includes('x?.z ?? 0'), 'module script optional-chaining must survive');
      // ...yet the guard still considers the whole document equivalent.
      assert.equal(guard.check('html', input, out).equivalent, true);
    });

    it('keeps the JSON data block value-identical after pretty-printing', async () => {
      const input = '<script type="application/json">{"a":1,"b":[1,2,3],"c":{"d":true}}</script>';
      const out = await formatHtml(input);
      assert.notEqual(out, input, 'engine should pretty-print the JSON');
      assert.equal(
        guard.check('html', input, out).equivalent,
        true,
        'a pure JSON pretty-print of a data script must be accepted'
      );
    });

    it('preserves inline event handlers byte-identical (engine does not touch attr JS)', async () => {
      const input = polyglotFixtures.find((f) => f.id === 'PG-INLINE-HANDLERS')!.input;
      const out = await formatHtml(input);
      assert.ok(out.includes('onclick="doThing(event); return false;"'));
      assert.ok(out.includes('onfocus="track(\'btn\')"'));
      assert.equal(guard.check('html', input, out).equivalent, true);
    });

    it('preserves inline style attribute values (var()/calc() inside style="")', async () => {
      const input = polyglotFixtures.find((f) => f.id === 'PG-INLINE-STYLE-RICH')!.input;
      const out = await formatHtml(input);
      assert.ok(out.includes('width:calc(100% - 2 * var(--pad,4px))'));
      assert.equal(guard.check('html', input, out).equivalent, true);
    });

    it('preserves template islands {{ }} / {% %} / <% %> / <%= %> in text and attributes', async () => {
      const input = polyglotFixtures.find((f) => f.id === 'PG-TEMPLATE-ISLANDS')!.input;
      const out = await formatHtml(input);
      assert.ok(out.includes('{{ user.name }}'), 'mustache island in text');
      assert.ok(out.includes('{% for badge in user.badges %}'), 'jinja island');
      assert.ok(out.includes('<% if (showBanner) { %>'), 'ASP/EJS scriptlet island');
      assert.ok(out.includes('<%= bannerText %>'), 'EJS interpolation island');
      assert.ok(out.includes('data-count="{{count}}"'), 'island inside an attribute value');
      assert.equal(guard.check('html', input, out).equivalent, true);
    });

    it('keeps <pre> and <textarea> bodies byte-verbatim while reformatting siblings', async () => {
      const input = polyglotFixtures.find((f) => f.id === 'PG-VERBATIM-BLOCKS')!.input;
      const out = await formatHtml(input);
      assert.ok(out.includes('        return \'kept\';'), '<pre> deep indentation kept');
      assert.ok(out.includes('  leading-space-kept'), '<textarea> leading spaces kept');
      assert.ok(out.includes('\ttab-kept'), '<textarea> tab kept');
      // sibling <style>/<script> were still reformatted -> document changed
      assert.notEqual(out, input);
      assert.equal(guard.check('html', input, out).equivalent, true);
    });

    it('preserves inline SVG (camelCase viewBox + namespaced xlink:href + gradient url)', async () => {
      const input = polyglotFixtures.find((f) => f.id === 'PG-SVG-STYLE')!.input;
      const out = await formatHtml(input);
      assert.ok(out.includes('viewBox="0 0 100 100"'), 'SVG camelCase attr survives');
      assert.ok(out.includes('xlink:href="#g1"'), 'namespaced SVG attr survives');
      assert.equal(guard.check('html', input, out).equivalent, true);
    });

    it('keeps an opaque type="text/x-template" script body verbatim (islands intact)', async () => {
      const input = polyglotFixtures.find((f) => f.id === 'PG-TEMPLATED-SCRIPT')!.input;
      const out = await formatHtml(input);
      // Opaque-type body is byte-preserved; the {{ }} islands survive untouched.
      assert.ok(out.includes('<li class="row" data-id="{{ id }}">{{ label }}</li>'));
      assert.equal(
        guard.check('html', input, out).equivalent,
        true,
        'an opaque-type template script with a byte-preserved body must be accepted'
      );
    });
  });

  describe('REJECT: a meaning change in ANY embedded language is caught', () => {
    // Each tampered output below is itself well-formed HTML (parse5 accepts it),
    // so a parse-only HTML guard would ship the corruption. htmlTreeEqual must
    // reject every one because the embedded payload's MEANING changed.

    it('rejects a changed value in embedded <script> JS', () => {
      const input = '<div><script>var a = 1;</script><style>.x{color:red}</style></div>';
      const tampered = '<div><script>var a = 2;</script><style>.x{color:red}</style></div>';
      assert.equal(htmlTreeEqual(input, tampered).equivalent, false);
    });

    it('rejects a changed value in embedded <style> CSS', () => {
      const input = '<div><script>var a = 1;</script><style>.x{color:red}</style></div>';
      const tampered = '<div><script>var a = 1;</script><style>.x{color:blue}</style></div>';
      assert.equal(htmlTreeEqual(input, tampered).equivalent, false);
    });

    it('rejects a changed value in a <script type="application/json"> data block', () => {
      const input = '<script type="application/json">{"a":1,"b":2}</script>';
      const tampered = '<script type="application/json">{"a":1,"b":3}</script>';
      assert.equal(htmlTreeEqual(input, tampered).equivalent, false);
    });

    it('rejects a changed inline event-handler (onclick) value', () => {
      const input = '<button onclick="save()">x</button>';
      const tampered = '<button onclick="del()">x</button>';
      assert.equal(htmlTreeEqual(input, tampered).equivalent, false);
    });

    it('rejects a changed inline style declaration', () => {
      const input = '<div style="color:red">x</div>';
      const tampered = '<div style="color:blue">x</div>';
      assert.equal(htmlTreeEqual(input, tampered).equivalent, false);
    });

    it('rejects a changed inline SVG attribute (fill gradient ref)', () => {
      const input = '<svg><circle r="40" fill="url(#g1)"></circle></svg>';
      const tampered = '<svg><circle r="40" fill="url(#g2)"></circle></svg>';
      assert.equal(htmlTreeEqual(input, tampered).equivalent, false);
    });

    it('rejects altered template-island text', () => {
      const input = '<h1>{{ user.name }}</h1>';
      const tampered = '<h1>{{ user.email }}</h1>';
      assert.equal(htmlTreeEqual(input, tampered).equivalent, false);
    });

    it('rejects collapsed <pre> whitespace (whitespace is significant)', () => {
      const input = '<pre>a    b</pre>';
      const tampered = '<pre>a b</pre>';
      assert.equal(htmlTreeEqual(input, tampered).equivalent, false);
    });

    it('rejects collapsed <textarea> whitespace', () => {
      const input = '<textarea>  x  y  </textarea>';
      const tampered = '<textarea> x y </textarea>';
      assert.equal(htmlTreeEqual(input, tampered).equivalent, false);
    });
  });

  describe('SECURITY: a {{ }} island in a default <script> is conservatively rejected, never silently corrupted', () => {
    // `const tpl={{ jsonData }}` is NOT valid JS (`{{` after `=` is a syntax
    // error). js-beautify still reflows the body into `const tpl = { { jsonData } }`,
    // changing the bytes. The guard cannot prove the reflow is meaning-preserving
    // (the body does not JS-parse), so canonicalizeEmbeddedCode falls back to a
    // VERBATIM comparison: input-verbatim != reflowed-output-verbatim => REJECT.
    // The file is therefore left intact upstream — the correct safe outcome for an
    // ambiguous templated script (SPEC §12 "faux négatif"/conservative-by-default).
    it('the engine reflows the templated default-script body (bytes change)', async () => {
      const input = '<div><script>const tpl={{ jsonData }};render(tpl)</script></div>';
      const out = await formatHtml(input);
      assert.notEqual(out, input, 'js-beautify reflows the (invalid-JS) script body');
    });

    it('the guard rejects the reflowed templated default-script (no silent corruption)', async () => {
      const input = '<div><script>const tpl={{ jsonData }};render(tpl)</script></div>';
      const out = await formatHtml(input);
      const verdict = guard.check('html', input, out);
      assert.equal(
        verdict.equivalent,
        false,
        'a default <script> whose body is not valid JS must not be silently reflowed'
      );
      assert.ok(verdict.reason && verdict.reason.length > 0, 'a reject must carry a reason');
    });
  });
});
