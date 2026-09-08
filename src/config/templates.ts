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
 * A fresh matcher for ISLAND_PATTERN. A /g regex carries `lastIndex` state, so a
 * shared instance driven by `exec` would leak position between calls and make
 * this module non-reentrant; every scan gets its own.
 */
function islandMatcher(): RegExp {
  return new RegExp(ISLAND_PATTERN.source, 'g');
}

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
 * Byte span [start, end) of one protected template construct. Shares the shape
 * of FrontMatterSpan on purpose: both are located over a text and then handed to
 * the same span-based masker.
 */
export interface TemplateIslandSpan {
  readonly start: number;
  readonly end: number;
}

/**
 * Every {{ }} / {% %} / <% %> island in `html`, as byte spans in document order.
 * Matches are non-overlapping and sorted by construction (a single left-to-right
 * regex scan), which is exactly what maskTemplateIslandSpans requires.
 *
 * SEPARATED FROM THE MASKING ON PURPOSE (the island scope fix): an island is a
 * DOCUMENT-LEVEL byte span. A selection whose boundary falls between `<%` and
 * `%>` contains no complete pattern, so a fragment can never find its own
 * islands; the caller locates them over the WHOLE document and clips the spans
 * to the fragment, the same mechanic that already makes ignore regions and front
 * matter scope-invariant. Pure and linear.
 */
export function findHtmlTemplateIslandSpans(
  html: string
): readonly TemplateIslandSpan[] {
  const spans: TemplateIslandSpan[] = [];
  const matcher = islandMatcher();
  let match = matcher.exec(html);
  while (match !== null) {
    spans.push({ start: match.index, end: match.index + match[0].length });
    match = matcher.exec(html);
  }
  return spans;
}

/**
 * Outcome of masking template islands (and optionally a front matter block) out
 * of an HTML document, pipeline-grade:
 *  - 'none'      : nothing to protect; the caller formats the input as-is;
 *  - 'collision' : islands exist but the document already contains the
 *                  placeholder text, so a clean restore cannot be guaranteed;
 *                  the caller MUST decline to format (zero edit);
 *  - 'unusable'  : the spans handed over are not a maskable set (out of bounds,
 *                  empty, unsorted or overlapping). Unreachable from the spans
 *                  this module produces; it exists so a caller that computes its
 *                  own spans can only ever be told "decline", never handed a
 *                  half-applied mask;
 *  - 'masked'    : the engine-ready text plus the ordered islands to restore.
 */
export type HtmlMaskOutcome =
  | { readonly kind: 'none' }
  | { readonly kind: 'collision'; readonly islandCount: number }
  | { readonly kind: 'unusable'; readonly islandCount: number }
  | {
      readonly kind: 'masked';
      readonly masked: string;
      readonly islands: readonly TemplateIsland[];
    };

/**
 * Mask the GIVEN spans of `html`, in document order, each behind its own
 * placeholder. Mirrors src/ignore/mask.ts:applyMask: the spans are re-validated
 * (in bounds, non-empty, strictly increasing, non-overlapping) so a malformed
 * set can never produce a corrupt mask, and the splice runs from the end so
 * earlier offsets stay valid.
 *
 * This is the single masking primitive: maskHtmlTemplateIslands below and the
 * document-located, clipped spans the mask plan computes both go through it.
 */
export function maskTemplateIslandSpans(
  html: string,
  spans: readonly TemplateIslandSpan[]
): HtmlMaskOutcome {
  if (spans.length === 0) {
    return { kind: 'none' };
  }
  if (hasPlaceholderCollision(html)) {
    return { kind: 'collision', islandCount: spans.length };
  }
  let previousEnd = 0;
  for (const span of spans) {
    if (
      !Number.isInteger(span.start) ||
      !Number.isInteger(span.end) ||
      span.start < previousEnd ||
      span.end <= span.start ||
      span.end > html.length
    ) {
      return { kind: 'unusable', islandCount: spans.length };
    }
    previousEnd = span.end;
  }

  // ONE pass, and one string build. Splicing span by span would re-copy the
  // whole document per island, which is O(bytes x islands): on a 350 KB page
  // with 8000 islands that is seconds, not milliseconds.
  const islands: TemplateIsland[] = [];
  const parts: string[] = [];
  let cursor = 0;
  for (const span of spans) {
    const island = {
      placeholder: makePlaceholder(islands.length),
      original: html.slice(span.start, span.end)
    };
    islands.push(island);
    parts.push(html.slice(cursor, span.start), island.placeholder);
    cursor = span.end;
  }
  parts.push(html.slice(cursor));

  return { kind: 'masked', masked: parts.join(''), islands };
}

/**
 * Pipeline entry point (ADD-02). Masks, in this order:
 *   1. the front matter block (single island, index 0) when `includeFrontMatter`
 *      is true and one exists at the document head;
 *   2. every {{ }} / {% %} / <% %> island in the remainder.
 * A {{ }} inside the front matter is hidden by step 1 and never double-masked.
 * Pure and deterministic. Unlike the legacy maskTemplateIslands, a collision is
 * an EXPLICIT outcome (the caller aborts) instead of a silent no-mask.
 *
 * Whole-text entry point: it locates the islands in the very text it masks, so
 * it is correct only when that text IS the document. A caller formatting a
 * FRAGMENT must locate spans over the document with findHtmlTemplateIslandSpans,
 * clip them, and call maskTemplateIslandSpans instead.
 */
export function maskHtmlTemplateIslands(
  html: string,
  includeFrontMatter: boolean
): HtmlMaskOutcome {
  const frontMatter = includeFrontMatter ? findFrontMatter(html) : undefined;
  const head: readonly TemplateIslandSpan[] = frontMatter
    ? [{ start: frontMatter.start, end: frontMatter.end }]
    : [];
  // Islands are looked for in the REMAINDER only, so one inside the front matter
  // is hidden by the block's own placeholder and never double-masked.
  const remainderStart = frontMatter ? frontMatter.end : 0;
  const tail = findHtmlTemplateIslandSpans(html.slice(remainderStart)).map(
    (span) => ({
      start: span.start + remainderStart,
      end: span.end + remainderStart
    })
  );
  return maskTemplateIslandSpans(html, [...head, ...tail]);
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
