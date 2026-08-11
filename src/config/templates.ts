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

/* -------------------------------------------------------------------------- */
/* Pipeline-facing API (ADD-02) : front matter + checked mask/restore           */
/* -------------------------------------------------------------------------- */

/**
 * Byte span [start, end) of a YAML front matter block at the very top of the
 * document: an opening line that is exactly '---' (trailing spaces/tabs
 * tolerated), through the next line that is exactly '---', delimiters included.
 * The closing line's terminator stays OUTSIDE the span. `start` skips a leading
 * BOM when present.
 */
export interface FrontMatterSpan {
  readonly start: number;
  readonly end: number;
}

const FRONT_MATTER_DELIMITER = '---';

/**
 * If the line starting at `lineStart` is exactly '---' plus optional trailing
 * spaces/tabs followed by a line break or EOF, return the index just past the
 * trailing blanks (the exclusive end of the delimiter content). Otherwise return
 * undefined. Linear, no regex: this module must never introduce a backtracking
 * pattern.
 */
function delimiterLineEnd(html: string, lineStart: number): number | undefined {
  if (!html.startsWith(FRONT_MATTER_DELIMITER, lineStart)) {
    return undefined;
  }
  let i = lineStart + FRONT_MATTER_DELIMITER.length;
  while (i < html.length && (html[i] === ' ' || html[i] === '\t')) {
    i += 1;
  }
  const atEof = i === html.length;
  const atBreak = html[i] === '\n' || (html[i] === '\r' && html[i + 1] === '\n');
  if (!atEof && !atBreak) {
    return undefined; // e.g. '----' or '--- title': not a delimiter line.
  }
  return i;
}

/**
 * Locate a front matter block at the head of the document (incumbent issue 75
 * class: a head '---' block reindented or destroyed by the HTML beautifier).
 * Returns undefined when there is none: no opening '---' first line, or no
 * closing '---' line (an unterminated block is NOT treated as front matter; the
 * document formats normally and the guard remains the judge). Pure and linear.
 */
export function findFrontMatter(html: string): FrontMatterSpan | undefined {
  const start = html.charCodeAt(0) === 0xfeff ? 1 : 0;
  const openEnd = delimiterLineEnd(html, start);
  if (openEnd === undefined || openEnd >= html.length) {
    return undefined; // no opening delimiter, or '---' with no body at all.
  }
  // Step past the opening line's terminator (LF or CRLF).
  let lineStart = html[openEnd] === '\r' ? openEnd + 2 : openEnd + 1;
  while (lineStart <= html.length) {
    const closeEnd = delimiterLineEnd(html, lineStart);
    if (closeEnd !== undefined) {
      return { start, end: closeEnd };
    }
    const nextBreak = html.indexOf('\n', lineStart);
    if (nextBreak === -1) {
      return undefined; // unterminated front matter -> not an island.
    }
    lineStart = nextBreak + 1;
  }
  return undefined;
}

/**
 * Outcome of masking template islands (and optionally a front matter block) out
 * of an HTML document, pipeline-grade:
 *  - 'none'      : nothing to protect; the caller formats the input as-is;
 *  - 'collision' : islands exist but the document already contains the
 *                  placeholder text, so a clean restore cannot be guaranteed;
 *                  the caller MUST decline to format (zero edit);
 *  - 'masked'    : the engine-ready text plus the ordered islands to restore.
 */
export type HtmlMaskOutcome =
  | { readonly kind: 'none' }
  | { readonly kind: 'collision'; readonly islandCount: number }
  | {
      readonly kind: 'masked';
      readonly masked: string;
      readonly islands: readonly TemplateIsland[];
    };

/**
 * Pipeline entry point (ADD-02). Masks, in this order:
 *   1. the front matter block (single island, index 0) when `includeFrontMatter`
 *      is true and one exists at the document head;
 *   2. every {{ }} / {% %} / <% %> island in the remainder.
 * A {{ }} inside the front matter is hidden by step 1 and never double-masked.
 * Pure and deterministic. Unlike the legacy maskTemplateIslands, a collision is
 * an EXPLICIT outcome (the caller aborts) instead of a silent no-mask.
 */
export function maskHtmlTemplateIslands(
  html: string,
  includeFrontMatter: boolean
): HtmlMaskOutcome {
  const frontMatter = includeFrontMatter ? findFrontMatter(html) : undefined;
  const remainder = frontMatter ? html.slice(frontMatter.end) : html;
  const delimiterCount = (remainder.match(ISLAND_PATTERN) ?? []).length;
  const islandCount = (frontMatter ? 1 : 0) + delimiterCount;

  if (islandCount === 0) {
    return { kind: 'none' };
  }
  if (hasPlaceholderCollision(html)) {
    return { kind: 'collision', islandCount };
  }

  const islands: TemplateIsland[] = [];
  let prefix = '';
  if (frontMatter) {
    const placeholder = makePlaceholder(0);
    islands.push({
      placeholder,
      original: html.slice(frontMatter.start, frontMatter.end)
    });
    prefix = html.slice(0, frontMatter.start) + placeholder;
  }
  const maskedRemainder = remainder.replace(ISLAND_PATTERN, (match) => {
    const placeholder = makePlaceholder(islands.length);
    islands.push({ placeholder, original: match });
    return placeholder;
  });

  return { kind: 'masked', masked: prefix + maskedRemainder, islands };
}

/**
 * Checked restore, mirroring src/ignore/mask.ts:restoreMask semantics: returns
 * undefined when a placeholder is MISSING from the formatted text (the engine
 * dropped it) or appears MORE THAN ONCE (the engine duplicated it). The caller
 * then aborts with zero edits. Restores in reverse index order so a placeholder
 * token can never be a prefix of another.
 *
 * Supersedes the throwing restoreTemplateIslands for pipeline use: the legacy
 * function is kept for its existing unit tests only, and notably does NOT detect
 * duplication (its split/join would rewrite both occurrences).
 */
export function restoreTemplateIslandsChecked(
  formatted: string,
  islands: readonly TemplateIsland[]
): string | undefined {
  let result = formatted;
  for (let i = islands.length - 1; i >= 0; i -= 1) {
    const { placeholder, original } = islands[i];
    const first = result.indexOf(placeholder);
    if (first === -1) {
      return undefined; // engine dropped the placeholder.
    }
    if (result.indexOf(placeholder, first + placeholder.length) !== -1) {
      return undefined; // engine duplicated the placeholder.
    }
    result =
      result.slice(0, first) + original + result.slice(first + placeholder.length);
  }
  return result;
}
