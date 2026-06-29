// Complex HTML corpus — adversarial / real-world acceptance tests for the
// format -> guard -> idempotence pipeline on the `html` languageId.
//
// HTML always routes to JsBeautifyEngine (SPEC §4 matrix); the safety guard for
// HTML is `htmlTreeEqual` (parse5 tree comparison). The contract under test:
//   - ACCEPT: a correctly-formatted complex document must pass the guard
//     (htmlTreeEqual === equivalent) AND be idempotent (format(format(x)) ===
//     format(x)). A false-positive rejection here is the "safe but does nothing"
//     failure the SPEC explicitly forbids (§12 "faux positif de la garde").
//   - REJECT: a tampered output that changes meaning must be rejected by the
//     guard (§ SAFE-02). The guard must NEVER let a meaning change through.
//
// Fixtures live in test/fixtures/html/. Each is a deliberately dense, real-world
// shaped snippet: full documents, embedded <script>/<style>, <pre>/<textarea>,
// special-character attributes, void elements, comments, custom elements, inline
// SVG, template islands ({{ }} / {% %} / <% %>), data-* and boolean attributes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dispatchFormat } from '../../../src/engine/dispatcher';
import { guard, htmlTreeEqual } from '../../../src/safety/guard';
import type { ResolvedOptions } from '../../../src/types';

const OPTS: ResolvedOptions = {
  tabSize: 2,
  insertSpaces: true,
  engineOptions: {},
  sources: {}
};

// Use __dirname (CommonJS) rather than import.meta.url: the project tsconfig
// compiles with `module: "commonjs"`, under which `import.meta` is a typecheck
// error. tsx provides __dirname for ESM-authored test files at runtime.
const FIXTURE_DIR = join(__dirname, '..', '..', 'fixtures', 'html');

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), 'utf8');
}

async function formatHtml(code: string): Promise<string> {
  return dispatchFormat({ languageId: 'html', code, options: OPTS });
}

/**
 * Assert the full safety contract for an ACCEPT case:
 *   1. the formatter produced output (sanity),
 *   2. the guard considers input/output semantically equivalent,
 *   3. a second pass changes nothing (idempotence / no right-drift).
 * Returns the formatted output so individual tests can make extra assertions.
 */
async function assertSafeAndIdempotent(code: string): Promise<string> {
  const out = await formatHtml(code);
  const verdict = guard.check('html', code, out);
  assert.equal(
    verdict.equivalent,
    true,
    `guard wrongly rejected a valid format: ${verdict.reason ?? ''}`
  );
  const out2 = await formatHtml(out);
  assert.equal(out, out2, 'formatting is not idempotent (output drifted on a 2nd pass)');
  return out;
}

describe('complex HTML corpus — format + guard + idempotence', () => {
  describe('whole documents & structure', () => {
    it('formats a complete HTML5 document (doctype, head, body, nav)', async () => {
      const out = await assertSafeAndIdempotent(loadFixture('full-document.html'));
      assert.ok(/<!DOCTYPE html>/i.test(out), 'doctype must survive');
      assert.ok(out.includes('lang="en"'), 'html lang attribute must survive');
    });

    it('formats a deeply nested structure without losing elements', async () => {
      const input =
        '<section><article><header><h2>T</h2></header>' +
        '<div><p><a href="#">link</a></p></div></article></section>';
      await assertSafeAndIdempotent(input);
    });

    it('preserves the document when re-formatting an already-pretty document', async () => {
      const pretty = await formatHtml(loadFixture('full-document.html'));
      // Re-running on the already-formatted output is the most common real case
      // (format-on-save of an unchanged file): it must be a no-op.
      const again = await formatHtml(pretty);
      assert.equal(again, pretty, 'second format of pretty output must be a no-op');
      assert.equal(guard.check('html', pretty, again).equivalent, true);
    });
  });

  describe('whitespace-significant content', () => {
    it('preserves <pre> whitespace exactly (indentation is meaningful)', async () => {
      const input = loadFixture('pre-whitespace.html');
      const out = await assertSafeAndIdempotent(input);
      // The literal indented body of <pre> must be byte-preserved.
      assert.ok(
        out.includes('        return \'deep\';'),
        'inner <pre> indentation must be preserved verbatim'
      );
      assert.ok(
        out.includes('        eight-space-line'),
        'arbitrary leading whitespace inside <pre> must be preserved'
      );
    });

    it('preserves <textarea> content verbatim (spaces, tabs, blank lines)', async () => {
      const input = loadFixture('textarea-verbatim.html');
      const out = await assertSafeAndIdempotent(input);
      assert.ok(
        out.includes('  Leading spaces matter.'),
        'leading spaces in <textarea> must be preserved'
      );
      assert.ok(out.includes('Tabs\ttoo.'), 'tab inside <textarea> must be preserved');
    });

    it('keeps tight inline whitespace meaning (<b>/<i> spacing)', async () => {
      // "Hello <b>bold</b> and" — the single spaces around inline elements carry
      // rendered meaning; the guard must accept a format that keeps them.
      await assertSafeAndIdempotent('<p>Hello <b>bold</b> and <i>italic</i> text.</p>');
    });
  });

  describe('attributes', () => {
    it('preserves special characters, quotes and entities in attributes', async () => {
      const out = await assertSafeAndIdempotent(loadFixture('attributes-special.html'));
      assert.ok(out.includes('&amp;'), 'ampersand entity must survive');
      assert.ok(out.includes('&quot;'), 'quote entity must survive');
    });

    it('collapses only insignificant whitespace between attributes', async () => {
      // Multiple spaces between attributes are insignificant; the guard accepts
      // their collapse, but no attribute may be added/dropped/renamed.
      await assertSafeAndIdempotent('<div   class="a"    id="b"  >x</div>');
    });

    it('handles single-quoted attribute values with embedded JSON', async () => {
      await assertSafeAndIdempotent('<div data-config=\'{"k":1,"v":[2,3]}\'>x</div>');
    });

    it('handles unquoted and empty attribute values', async () => {
      await assertSafeAndIdempotent('<input type=text value=hello>');
      await assertSafeAndIdempotent('<input value="" disabled="">');
    });

    it('keeps data-* attributes intact', async () => {
      const out = await assertSafeAndIdempotent(loadFixture('data-boolean-attrs.html'));
      assert.ok(out.includes('data-user-name="bob"'), 'hyphenated data-* name must survive');
    });

    it('keeps boolean attributes (checked/disabled/required/selected)', async () => {
      const out = await assertSafeAndIdempotent(
        '<input type="checkbox" checked disabled required>'
      );
      assert.ok(/\bchecked\b/.test(out) && /\bdisabled\b/.test(out) && /\brequired\b/.test(out));
    });
  });

  describe('void elements, comments, custom & SVG', () => {
    it('formats void elements without inventing closing tags', async () => {
      const out = await assertSafeAndIdempotent(loadFixture('void-elements.html'));
      assert.ok(!/<\/(img|br|hr|input|meta|link)>/i.test(out), 'no void element may get a close tag');
    });

    it('preserves comments (including conditional comments)', async () => {
      const out = await assertSafeAndIdempotent(loadFixture('comments.html'));
      assert.ok(out.includes('<!--[if lt IE 9]>'), 'conditional comment must survive');
    });

    it('preserves custom / namespaced elements', async () => {
      await assertSafeAndIdempotent(loadFixture('custom-elements.html'));
    });

    it('preserves inline SVG (camelCase attrs, paths, gradients)', async () => {
      const out = await assertSafeAndIdempotent(loadFixture('svg-inline.html'));
      assert.ok(out.includes('viewBox="0 0 100 100"'), 'SVG camelCase attr must survive');
      assert.ok(out.includes('xlink:href="#g1"'), 'namespaced SVG attr must survive');
    });
  });

  describe('template islands (must be preserved literally)', () => {
    it('preserves {{ }}, {% %} and <% %> islands through formatting', async () => {
      const out = await assertSafeAndIdempotent(loadFixture('template-islands.html'));
      assert.ok(out.includes('{{ user.name }}'), 'mustache island must survive');
      assert.ok(out.includes('{% for badge in user.badges %}'), 'jinja island must survive');
      assert.ok(out.includes('<% if (showBanner) { %>'), 'ASP/EJS island must survive');
      assert.ok(out.includes('<%= user.name %>'), 'EJS interpolation island must survive');
    });

    it('preserves template islands embedded inside attribute values', async () => {
      await assertSafeAndIdempotent('<div class="{{cls}}" id="x" data-count="{{count}}">body</div>');
    });

    it('preserves mustache islands as text nodes between elements', async () => {
      await assertSafeAndIdempotent('<div>{{ user.name }}</div><span>{{count}}</span>');
    });
  });

  describe('guard REJECTS meaning-changing output (negative controls)', () => {
    it('rejects a dropped element', () => {
      const input = '<ul><li>a</li><li>b</li></ul>';
      const tampered = '<ul><li>a</li></ul>';
      assert.equal(htmlTreeEqual(input, tampered).equivalent, false);
    });

    it('rejects a changed attribute value', () => {
      const input = '<a href="/safe">x</a>';
      const tampered = '<a href="/evil">x</a>';
      assert.equal(htmlTreeEqual(input, tampered).equivalent, false);
    });

    it('rejects a renamed tag', () => {
      const input = '<button>go</button>';
      const tampered = '<a>go</a>';
      assert.equal(htmlTreeEqual(input, tampered).equivalent, false);
    });

    it('rejects altered visible text', () => {
      const input = '<p>Pay $10</p>';
      const tampered = '<p>Pay $100</p>';
      assert.equal(htmlTreeEqual(input, tampered).equivalent, false);
    });

    it('rejects collapsed whitespace inside <pre> (whitespace is significant)', () => {
      const input = '<pre>a    b</pre>';
      const tampered = '<pre>a b</pre>';
      assert.equal(
        htmlTreeEqual(input, tampered).equivalent,
        false,
        'whitespace inside <pre> is meaningful and must not be collapsible'
      );
    });
  });

  describe('embedded <script>/<style> (whitespace-insensitive code)', () => {
    // FIXED (was a guard bug): htmlTreeEqual used to treat <script>/<style> text
    // as WHITESPACE-SENSITIVE (verbatim byte comparison), so js-beautify's
    // legitimate reindentation of embedded JS/CSS was false-positive-REJECTED,
    // turning HTML formatting into a permanent no-op on any real document. The
    // guard now canonicalises <script> bodies via the JS AST (or JSON value for
    // data scripts) and <style> bodies via the PostCSS shape, so a pure reindent
    // compares equal while a real code/value change is still rejected (see the
    // negative control below). Only <pre>/<textarea> stay truly verbatim.
    // (SPEC §3, §12).
    it('accepts reindented embedded <script> (valid JS reformat)', async () => {
      await assertSafeAndIdempotent(loadFixture('embedded-script.html'));
    });

    it('accepts reindented embedded <style> (valid CSS reformat)', async () => {
      await assertSafeAndIdempotent(loadFixture('embedded-style.html'));
    });

    it('accepts a full document with <style> + <script>', async () => {
      await assertSafeAndIdempotent(loadFixture('full-document-with-assets.html'));
    });

    it('accepts <script type="application/json"> reformatted', async () => {
      await assertSafeAndIdempotent(
        '<script type="application/json">{"a":1,"b":[1,2,3]}</script>'
      );
    });

    // Direct guard-level proof of the fix: reindenting the JS body of a <script>
    // (no token change) must be accepted.
    it('htmlTreeEqual accepts pure reindent of <script> body', () => {
      const input = '<script>var a = 1;</script>';
      const reindented = '<script>\n  var a = 1;\n</script>';
      assert.equal(htmlTreeEqual(input, reindented).equivalent, true);
    });

    // The guard MUST still reject a real change to embedded code even once the
    // verbatim rule is relaxed. This is the safety half of the fix and is asserted
    // here so the eventual fix cannot over-correct into letting code changes pass.
    it('still rejects a real change to embedded <script> code', () => {
      const input = '<script>var a = 1;</script>';
      const tampered = '<script>var a = 2;</script>';
      assert.equal(
        htmlTreeEqual(input, tampered).equivalent,
        false,
        'a genuine change to embedded JS must be rejected'
      );
    });
  });
});
