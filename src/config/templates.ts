// Template-protection policy (pure).
// Template languageIds are never registered/formatted by default, and template
// islands ({{ }} / {% %} / <% %>) inside .html are preserved literally.
// MUST NOT import 'vscode' (testable under mocha + tsx).
//
// Covers CFG-04: `{% if x %}…{% endif %}` and `{{ var }}` stay byte-identical
// after an HTML format. The approach is mask-then-restore: each island is
// replaced by an inert, attribute-safe placeholder before the engine runs and
// restored verbatim afterwards, so the beautifier can never inject whitespace
// inside a template tag (the incumbent's #11/#45/#48/#65/#66/#16 failures).
import type { LangId } from '../types';

/**
 * LangIds the extension actively supports. Template languageIds (vue, jinja,
 * django-html, handlebars, ...) are deliberately NOT in the supported union, so
 * by construction none of the current LangIds is template-protected. The set is
 * kept explicit so that if the union ever grows to include a template language,
 * this check becomes the single place to opt it out of formatting.
 */
const SUPPORTED_NON_TEMPLATE: ReadonlySet<LangId> = new Set<LangId>([
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
]);

/**
 * Returns true when the language must be protected from formatting (e.g. a
 * template languageId). Supported LangIds are not template-protected.
 *
 * Conservative by default: any language that is not an explicitly supported,
 * non-template language is treated as protected ("when in doubt, don't touch").
 */
export function isTemplateProtected(lang: LangId): boolean {
  return !SUPPORTED_NON_TEMPLATE.has(lang);
}

/**
 * The three template island syntaxes Tidy preserves inside HTML:
 *   - `{{ ... }}`  Mustache / Handlebars / Vue / Jinja expressions
 *   - `{% ... %}`  Jinja / Django / Liquid / Twig statements
 *   - `<% ... %>`  EJS / ERB / ASP-style scriptlets
 * Patterns are non-greedy and span newlines so multi-line islands are captured
 * whole. Order matters only in that each alternative is self-delimiting.
 */
const ISLAND_PATTERN = /\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}|<%[\s\S]*?%>/g;

/**
 * A captured island and the placeholder token that temporarily stands in for it.
 */
export interface TemplateIsland {
  /** Stable placeholder token inserted into the masked source. */
  placeholder: string;
  /** Original island text, restored verbatim after formatting. */
  original: string;
}

/**
 * Result of masking template islands out of HTML prior to formatting.
 */
export interface MaskResult {
  /** Source with each island replaced by its placeholder. */
  masked: string;
  /** Ordered islands; pass back to restoreTemplateIslands unchanged. */
  islands: TemplateIsland[];
}

/**
 * Prefix/suffix for placeholders. They are:
 *  - alphanumeric-only at the edges so HTML tokenisers treat them as plain text
 *    (no `<`, `{`, quotes) and never re-wrap or split them;
 *  - unlikely to occur in real markup, lowering collision risk.
 */
const PLACEHOLDER_PREFIX = 'tidytplisland';
const PLACEHOLDER_SUFFIX = 'endisland';

function makePlaceholder(index: number): string {
  return `${PLACEHOLDER_PREFIX}${index}${PLACEHOLDER_SUFFIX}`;
}

/**
 * Decide whether the given HTML already contains a string that would collide
 * with our placeholder scheme. If so the caller must NOT rely on masking (we
 * cannot guarantee a clean restore) and should fall back to not formatting.
 */
export function hasPlaceholderCollision(html: string): boolean {
  // A collision exists if the source already contains the placeholder prefix,
  // since a restore pass would then rewrite genuine document text.
  return html.includes(PLACEHOLDER_PREFIX);
}

/**
 * Replace every template island in `html` with a stable placeholder, returning
 * the masked source and the ordered list of islands needed to restore them.
 *
 * Pure: no I/O, deterministic for a given input. If the source would collide
 * with the placeholder scheme, masking is skipped (islands = []) so the caller
 * can detect the unsafe case via hasPlaceholderCollision and decline to format.
 */
export function maskTemplateIslands(html: string): MaskResult {
  if (hasPlaceholderCollision(html)) {
    return { masked: html, islands: [] };
  }

  const islands: TemplateIsland[] = [];
  const masked = html.replace(ISLAND_PATTERN, (match) => {
    const placeholder = makePlaceholder(islands.length);
    islands.push({ placeholder, original: match });
    return placeholder;
  });

  return { masked, islands };
}

/**
 * Restore previously-masked template islands into formatted HTML, returning the
 * source with each placeholder swapped back to its original island text.
 *
 * Restores in reverse index order so a placeholder token can never be a prefix
 * of another (e.g. `tidytplisland1endisland` vs `tidytplisland12endisland`),
 * guaranteeing each placeholder is matched exactly once.
 */
export function restoreTemplateIslands(
  formatted: string,
  islands: readonly TemplateIsland[]
): string {
  let result = formatted;
  for (let i = islands.length - 1; i >= 0; i -= 1) {
    const { placeholder, original } = islands[i];
    if (!result.includes(placeholder)) {
      // The formatter dropped or mangled a placeholder: restoring would change
      // semantics, so signal the unsafe condition instead of guessing.
      throw new Error(
        `Template island placeholder "${placeholder}" missing after formatting; refusing to restore.`
      );
    }
    result = result.split(placeholder).join(original);
  }
  return result;
}
