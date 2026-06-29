// Unit tests for template-island protection (SPEC CFG-04).
// Template islands ({{ }}, {% %}, <% %>) inside HTML must survive a real
// js-beautify format byte-identical via mask -> format -> restore. Also covers
// the template-languageId protection policy and placeholder-collision safety.
import assert from 'node:assert/strict';
import { html as htmlBeautify } from 'js-beautify';
import {
  isTemplateProtected,
  maskTemplateIslands,
  restoreTemplateIslands,
  hasPlaceholderCollision
} from '../../../src/config/templates';
import { templateFixtures } from '../../fixtures/templateFixtures';

describe('config/templates — island preservation across a real HTML format', () => {
  for (const f of templateFixtures) {
    it(`${f.id}: ${f.desc} [${f.ref}]`, () => {
      const { masked, islands } = maskTemplateIslands(f.html);

      // The mask must remove every island from the formatter's view.
      for (const island of f.islands) {
        assert.ok(!masked.includes(island), `island still present in masked source: ${island}`);
      }

      // Run the actual beautifier on the masked source, then restore.
      const beautified = htmlBeautify(masked, { indent_size: 2 });
      const restored = restoreTemplateIslands(beautified, islands);

      // Every original island must reappear verbatim (byte-identical).
      for (const island of f.islands) {
        assert.ok(
          restored.includes(island),
          `island not preserved after format: ${JSON.stringify(island)} in ${JSON.stringify(restored)}`
        );
      }
      // No placeholder leftovers.
      assert.ok(!restored.includes('tidytplisland'), 'no placeholder may leak into output');
    });
  }
});

describe('config/templates — protection policy', () => {
  it('supported non-template languages are NOT protected', () => {
    for (const lang of [
      'css',
      'scss',
      'less',
      'html',
      'json',
      'jsonc',
      'javascript',
      'typescript',
      'typescriptreact',
      'javascriptreact'
    ] as const) {
      assert.equal(isTemplateProtected(lang), false, `${lang} must be formattable`);
    }
  });
});

describe('config/templates — safety on placeholder collision', () => {
  it('detects a collision when the source already contains the placeholder prefix', () => {
    const collidingHtml = '<div>tidytplisland0endisland</div>';
    assert.equal(hasPlaceholderCollision(collidingHtml), true);
    // Masking must be a no-op (islands empty) so the caller can decline to format.
    const { islands } = maskTemplateIslands(collidingHtml);
    assert.equal(islands.length, 0);
  });

  it('restore throws (never guesses) when a placeholder went missing', () => {
    const { islands } = maskTemplateIslands('<div>{{ x }}</div>');
    assert.throws(() => restoreTemplateIslands('<div></div>', islands), /missing after formatting/);
  });

  it('restore is unambiguous with 10+ islands (no prefix overlap)', () => {
    const parts = Array.from({ length: 12 }, (_, i) => `{{ v${i} }}`);
    const html = `<div>${parts.join('')}</div>`;
    const { masked, islands } = maskTemplateIslands(html);
    const restored = restoreTemplateIslands(masked, islands);
    assert.equal(restored, html);
  });
});
