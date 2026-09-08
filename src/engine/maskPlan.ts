// Mask plan builder: composes the two protect-and-restore layers that shield
// byte spans from the formatting engines, producing a single engine-facing mask:
//   1. in-source ignore REGIONS (tidy-ignore-start/end + node markers), the
//      existing mechanic from ignore/markers + ignore/mask (js-beautify family,
//      DOCUMENT AND SELECTION scope since the FIX-B pass below);
//   2. HTML TEMPLATE ISLANDS ({{ }}, {% %}, <% %>), the CFG-04 promise wired in
//      by ADD-02 (html only; document AND selection scope).
//
// A head YAML FRONT MATTER block is protected too, and it rides layer 1: like an
// ignore region it is a DOCUMENT-LEVEL BYTE SPAN, not a self-delimiting syntax a
// fragment can recognise on its own, so it is located once over the whole
// document and CLIPPED to the span handed to the engine. That is the mechanic
// that already made regions scope-invariant (FIX-B), and it is what makes front
// matter scope-invariant now (see frontMatterRangeFor).
//
// AN ISLAND IS A DOCUMENT-LEVEL SPAN TOO, and it is located the same way (see
// templateIslandSpansFor). It reads as self-delimiting only while both of its
// delimiters are visible: a selection cutting between `<%` and `%>` contains no
// complete pattern, so scanning the FRAGMENT found nothing, left the interior
// exposed, and js-beautify reflowed it into a single line. The guard cannot see
// that (normalizeHtmlText collapses text-node whitespace), so the corruption was
// WRITTEN: `// total is in cents` swallowing the statement below it, `replace("
// ","-")` losing a space inside a string literal. Islands are therefore located
// over context.documentText and CLIPPED to the input, exactly like regions and
// front matter; the clipped part of a straddling island is restored verbatim.
// One located-then-clipped mechanism for all three layers, so they cannot drift.
//
// Masking order: regions AND front matter first (their byte ranges come from
// scanMarkers / findFrontMatter over the caller's document), islands second over
// the region-masked text, so an island inside an ignored region, or inside the
// front matter, is already hidden and never double-masked (throughRegionLayer
// drops any island whose boundary falls inside a span layer 1 already protects,
// and re-expresses the survivors in the masked text's own coordinates). Restore
// order is the exact reverse: islands first, then regions.
//
// WHY ISLANDS NEED THEIR OWN LAYER: the HTML guard normalises whitespace inside
// text nodes, so an engine that reflows the INSIDE of a `{% if x %}` tag makes a
// change the guard cannot see. Mask-then-restore is the only mechanism that can
// promise those bytes come back identical; the guard then judges the whole
// restored document as usual.
//
// WHY MARKERS, FRONT MATTER AND ISLANDS ARE READ ON THE DOCUMENT, NOT ON THE
// SELECTION:
// an ignore REGION is a document-level construct. Its `tidy-ignore-start` can sit
// above a user selection while the span it protects reaches into it, so the
// ranges are computed once over the whole document (the provider already scans it
// for the file-level ignore check and passes that scan in) and then CLIPPED to
// the span actually handed to the engine. FRONT MATTER is the same kind of
// construct and gets the same treatment: a selection that starts inside the
// block, ends inside it, or covers exactly it cannot recognise it on its own (the
// fragment has no head '---' line, or no closing one), so the block is located in
// the DOCUMENT and its overlap with the input is masked. A TEMPLATE ISLAND is
// the same kind of construct once a selection boundary lands between its two
// delimiters, and gets the same treatment. Formatting a selection must never be
// able to destroy what formatting the document preserves.
//
// NO SILENT NO-OP: when a tidy-ignore marker is present in the span being
// formatted but the active path cannot honour it, the plan carries
// `unhonouredIgnore`, an English one-liner the provider surfaces in the Tidy
// output channel and in "Explain Last Format". A documented directive must never
// be ignored in silence.
//
// SAFETY (NON-NEGOTIABLE): every failure path is fail-safe:
//   - placeholder COLLISION -> the plan carries `abortReason` and the caller
//     returns zero edits BEFORE any engine call;
//   - restore FAILURE (placeholder dropped/duplicated by the engine, including
//     the cross case where an island swallowed a region token) -> restore
//     returns { ok:false, reason } and the caller aborts with zero edits;
//   - a SUCCESSFUL restore is still re-validated upstream by
//     guard.check(originalInput, restored): the guard never sees a placeholder
//     and remains the final judge. This module can only ever PRESERVE meaning.
//
// PURE: imports neither 'vscode' nor any engine. Fully unit-testable under
// mocha + tsx (test/unit/engine/maskPlan.test.ts).
import type { LangId } from '../types';
import { scanMarkers, type MarkerScan, type ProtectedRange } from '../ignore/markers';
import { applyMask, restoreMask } from '../ignore/mask';
import {
  findFrontMatter,
  findHtmlTemplateIslandSpans,
  maskTemplateIslandSpans,
  restoreTemplateIslandsChecked,
  type TemplateIslandSpan
} from '../config/templates';

/** Whether the mask protects a whole-document format or a selection format. */
export type MaskScope = 'document' | 'selection';

/** Result of mapping an engine output back to the verbatim-restored text. */
export type RestoreOutcome =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: string };

/**
 * The engine-facing mask: the text actually sent to the engine, and the checked
 * restore mapping its output back to the caller's world. Replaces the provider's
 * previous private RegionMask (same shape, checked restore result).
 */
export interface EngineMask {
  readonly engineInput: string;
  readonly restore: (engineOutput: string) => RestoreOutcome;
}

/**
 * Where the text being formatted sits inside its document, plus the marker scan
 * of that document. Supplied by the provider, which already scans the document
 * for the file-level ignore check: passing it here means a document is never
 * scanned twice, and a SELECTION sees the markers that live outside it.
 *
 * When omitted (pure callers and unit tests), the input IS the document and the
 * markers are scanned from it.
 */
export interface MaskContext {
  /** Marker scan of the WHOLE document the input was taken from. */
  readonly markerScan: MarkerScan;
  /** Offset of `input` inside that document (0 for a whole-document format). */
  readonly inputOffset: number;
  /**
   * The WHOLE document text the input was taken from. Front matter and template
   * islands are document-level constructs: a selection cannot tell whether the
   * '---' at its head opens a block, closes one, or is ordinary markup, and it
   * cannot see an island whose closing `%}` lies past its own last byte. Both
   * are located HERE and clipped to the input. Optional for callers that have no
   * document to offer, in which case the input is treated as its own document
   * (the same convention as omitting the context entirely).
   */
  readonly documentText?: string;
}

/**
 * The full plan for one format attempt:
 *  - `mask`               : absent when the engine can format the input as-is;
 *  - `templateIslandCount`: islands protected by this plan (front matter counts
 *                           as one), for diagnostics;
 *  - `unhonouredIgnore`   : present when the span carries a tidy-ignore marker
 *                           this path will NOT apply; the caller must SAY SO
 *                           (output channel + Explain), never stay silent;
 *  - `abortReason`        : present when formatting CANNOT proceed safely
 *                           (placeholder collision); the caller must return zero
 *                           edits without calling any engine.
 */
export interface MaskPlan {
  readonly mask?: EngineMask;
  readonly templateIslandCount: number;
  readonly unhonouredIgnore?: string;
  readonly abortReason?: string;
}

/**
 * Exact abort/restore reason strings. `statusFromReason` in the formatting
 * provider maps the 'template-island' prefix to the 'restore-failed' status;
 * keep prefixes stable.
 */
export const TEMPLATE_COLLISION_REASON =
  'template-island collision: document already contains the placeholder text';
export const TEMPLATE_RESTORE_FAILED_REASON =
  'template-island restore failed (placeholder dropped or duplicated by engine)';
export const REGION_RESTORE_FAILED_REASON =
  'ignore-region restore failed (placeholder altered by engine)';
/**
 * Front matter was found but could not be masked (a placeholder token already
 * occurs in the span). Formatting unprotected would let the engine reflow the
 * YAML, and the HTML guard cannot see that, so the only safe move is zero edits.
 * Prefixed 'template-island' so `statusFromReason` keeps mapping it to the
 * existing 'restore-failed' status: a protected span could not be guaranteed.
 */
export const FRONT_MATTER_MASK_FAILED_REASON =
  'template-island front matter could not be masked (placeholder text already present)';
/**
 * The located island spans were not a maskable set (out of bounds, empty,
 * unsorted or overlapping once mapped onto the engine input). Unreachable by
 * construction: the spans come from one left-to-right scan, are clipped by
 * clipRanges and mapped monotonically, so they stay sorted and disjoint. It
 * exists so the ONLY thing a broken span set can ever cause is zero edits, never
 * a half-applied mask. Same 'template-island' prefix, same status mapping.
 */
export const TEMPLATE_ISLAND_SPANS_UNUSABLE_REASON =
  'template-island spans could not be masked (the located ranges were unusable)';

/**
 * Shared prefix of every "a tidy-ignore marker was not applied" notice, so the
 * provider and the tests can recognise one without matching whole sentences.
 */
export const UNHONOURED_IGNORE_PREFIX = 'tidy-ignore markers not applied';

/**
 * The span carries a tidy-ignore marker but the language is printed by Prettier,
 * which has its own node-level directive. Tidy does NOT mask on that path: the
 * placeholder would have to survive a strict parser, and Prettier's own
 * `prettier-ignore` is the syntax-aware mechanism there. So we say it plainly.
 */
export const UNHONOURED_IGNORE_PRETTIER_PATH =
  `${UNHONOURED_IGNORE_PREFIX}: this language is printed by Prettier; use // prettier-ignore, which it honours natively`;

/**
 * The span carries a tidy-ignore marker on a path that normally masks it, but no
 * safe mask could be built (a placeholder token already occurs in the text, or
 * the scanned ranges were malformed). Formatting proceeds unprotected, so the
 * user is told rather than left guessing.
 */
export const UNHONOURED_IGNORE_MASK_UNAVAILABLE =
  `${UNHONOURED_IGNORE_PREFIX}: no safe placeholder could be used for the marked span, so it was formatted normally`;

/**
 * Languages whose engine does NOT natively honour in-source ignore directives,
 * so Tidy protects regions itself via mask/restore (the js-beautify family).
 * The Prettier path honours `// prettier-ignore` natively at the node level.
 * Moved verbatim from providers/formattingProvider.ts (ADD-02).
 */
const REGION_MASKING_LANGUAGES: ReadonlySet<LangId> = new Set<LangId>([
  'css',
  'scss',
  'less',
  'html',
  'json',
  'jsonc',
  'javascript'
]);

/**
 * The protected ranges that fall inside `[offset, offset + length)`, re-expressed
 * in the input's own coordinate space. A range that only partly overlaps the
 * input is clipped: the overlapping bytes are still restored VERBATIM, which is
 * the whole promise. Order and disjointness are preserved, so the result stays
 * acceptable to applyMask. Pure, no mutation of the input array.
 */
function clipRanges(
  ranges: readonly ProtectedRange[],
  offset: number,
  length: number
): ProtectedRange[] {
  const clipped: ProtectedRange[] = [];
  for (const range of ranges) {
    const start = Math.max(range.start, offset) - offset;
    const end = Math.min(range.end, offset + length) - offset;
    if (end > start) {
      clipped.push({ start, end, kind: range.kind });
    }
  }
  return clipped;
}

/**
 * The protected ranges to mask inside `input`, in `input` coordinates. With a
 * context, they come from the document scan (clipped to the input); without one,
 * the input is scanned as if it were the whole document.
 */
function protectedRangesFor(
  languageId: LangId,
  input: string,
  context: MaskContext | undefined
): ProtectedRange[] {
  if (context === undefined) {
    return scanMarkers(input, languageId).protectedRanges;
  }
  return clipRanges(
    context.markerScan.protectedRanges,
    context.inputOffset,
    input.length
  );
}

/**
 * Whether this protected range was opened by a TIDY directive rather than by a
 * `prettier-ignore` one. Regions can only ever come from `tidy-ignore-start`, so
 * they always qualify; a node range is attributed by its marker line, which is
 * the first line of the range by construction (see ignore/markers.ts).
 *
 * Conservative on uncertainty: a range clipped so that its marker line is no
 * longer visible reads as NOT a tidy marker, so this can only under-report and
 * never invent a notice about a directive the user did not write.
 */
function isTidyIgnoreRange(text: string, range: ProtectedRange): boolean {
  if (range.kind === 'region') {
    return true;
  }
  const lineBreak = text.indexOf('\n', range.start);
  const lineEnd =
    lineBreak === -1 ? range.end : Math.min(lineBreak, range.end);
  return text.slice(range.start, lineEnd).includes('tidy-ignore');
}

/**
 * The notice to surface when the span carries a tidy-ignore marker the active
 * path will not apply, or undefined when there is nothing to report (no marker,
 * or the marker IS protected by the mask this plan built).
 */
function unhonouredIgnoreFor(
  languageId: LangId,
  input: string,
  ranges: readonly ProtectedRange[],
  regionMask: EngineMask | undefined
): string | undefined {
  if (!ranges.some((range) => isTidyIgnoreRange(input, range))) {
    return undefined;
  }
  if (!REGION_MASKING_LANGUAGES.has(languageId)) {
    return UNHONOURED_IGNORE_PRETTIER_PATH;
  }
  return regionMask === undefined
    ? UNHONOURED_IGNORE_MASK_UNAVAILABLE
    : undefined;
}

/**
 * The DOCUMENT's head front matter block, expressed in `input` coordinates and
 * clipped to the input, or undefined when the input does not overlap one.
 *
 * html only: a '---' head block is front matter in an HTML document; in CSS or
 * JavaScript the same bytes are ordinary source that must keep being formatted.
 *
 * The document is the reference on purpose. Since the block always sits at the
 * head, its clipped overlap is always at the head of the input too, whatever the
 * selection: starting inside it, ending inside it, covering it exactly or
 * spanning it whole all yield the same kind of range, and a selection that never
 * touches it yields none. Clipping reuses `clipRanges`, the same function that
 * makes ignore regions scope-invariant, so both layers cannot drift apart.
 */
function frontMatterRangeFor(
  languageId: LangId,
  input: string,
  context: MaskContext | undefined
): ProtectedRange | undefined {
  if (languageId !== 'html') {
    return undefined;
  }
  const source =
    context === undefined || context.documentText === undefined
      ? { text: input, offset: 0 }
      : { text: context.documentText, offset: context.inputOffset };
  const span = findFrontMatter(source.text);
  if (span === undefined) {
    return undefined;
  }
  const [clipped] = clipRanges(
    [{ start: span.start, end: span.end, kind: 'region' }],
    source.offset,
    input.length
  );
  return clipped;
}

/**
 * The ranges to hand `applyMask`: the marker ranges with the front matter range
 * merged in. Any marker range that overlaps or abuts the front matter is
 * ABSORBED into it (one wider protected span) so the list stays sorted, disjoint
 * and in bounds, which is what applyMask validates. Absorbing can only ever
 * protect MORE bytes verbatim, never fewer, so it cannot lose a protection.
 * Pure: neither input array is mutated.
 */
function withFrontMatter(
  ranges: readonly ProtectedRange[],
  frontMatter: ProtectedRange | undefined
): readonly ProtectedRange[] {
  if (frontMatter === undefined) {
    return ranges;
  }
  let start = frontMatter.start;
  let end = frontMatter.end;
  const after: ProtectedRange[] = [];
  for (const range of ranges) {
    if (range.start <= end) {
      start = Math.min(start, range.start);
      end = Math.max(end, range.end);
    } else {
      after.push(range);
    }
  }
  return [{ start, end, kind: 'region' }, ...after];
}

/**
 * The built region layer: the mask itself, plus what the island layer needs to
 * sit on top of it. `ranges` are the spans actually handed to applyMask, in
 * INPUT coordinates; `deltas[i]` is how much longer the i-th placeholder is than
 * the bytes it replaced, which is what turns an input offset into an offset in
 * `mask.engineInput`.
 */
interface RegionLayer {
  readonly mask: EngineMask;
  readonly ranges: readonly ProtectedRange[];
  readonly deltas: readonly number[];
}

/**
 * Build the region mask for the js-beautify path, or undefined when there is
 * nothing to protect (no regions) or region masking is unsafe (collision /
 * malformed ranges): in those cases the caller formats normally, exactly the
 * pre-ADD-02 behaviour, and `unhonouredIgnoreFor` reports the second case.
 * PURE orchestration over the mask module.
 */
function buildRegionLayer(
  languageId: LangId,
  input: string,
  ranges: readonly ProtectedRange[]
): RegionLayer | undefined {
  if (!REGION_MASKING_LANGUAGES.has(languageId)) {
    return undefined; // Prettier path honours `// prettier-ignore` natively.
  }
  if (ranges.length === 0) {
    return undefined;
  }
  const masked = applyMask(input, ranges);
  if (masked === undefined) {
    return undefined; // collision / malformed ranges -> format normally.
  }
  return {
    ranges,
    deltas: masked.restorations.map(
      (restoration, index) =>
        restoration.token.length - (ranges[index].end - ranges[index].start)
    ),
    mask: {
      engineInput: masked.masked,
      restore: (engineOutput: string): RestoreOutcome => {
        const restored = restoreMask(engineOutput, masked.restorations);
        return restored === undefined
          ? { ok: false, reason: REGION_RESTORE_FAILED_REASON }
          : { ok: true, text: restored };
      }
    }
  };
}

/**
 * The DOCUMENT's template islands, expressed in `input` coordinates and clipped
 * to the input; empty when the input overlaps none. The exact counterpart of
 * frontMatterRangeFor: same source choice, same clipRanges call, so the two
 * document-level layers cannot drift apart. No language test here, unlike
 * frontMatterRangeFor: buildMaskPlan has already returned for every language but
 * html by the time this runs.
 *
 * CLIPPING IS THE POINT. An island the input covers whole is masked whole, as
 * before. An island the selection CUTS keeps the bytes on the input's side of
 * the cut, and those are exactly the bytes the engine used to reflow: masking
 * the clipped overlap restores them verbatim, while the bytes outside the input
 * were never at risk because they were never sent to any engine.
 */
function templateIslandSpansFor(
  input: string,
  context: MaskContext | undefined
): readonly TemplateIslandSpan[] {
  const source =
    context === undefined || context.documentText === undefined
      ? { text: input, offset: 0 }
      : { text: context.documentText, offset: context.inputOffset };
  const located = findHtmlTemplateIslandSpans(source.text).map((span) => ({
    start: span.start,
    end: span.end,
    kind: 'region' as const
  }));
  return clipRanges(located, source.offset, input.length).map((range) => ({
    start: range.start,
    end: range.end
  }));
}

/** Whether the two half-open spans share at least one byte. */
function overlaps(
  span: TemplateIslandSpan,
  range: ProtectedRange
): boolean {
  return range.start < span.end && span.start < range.end;
}

/**
 * An input offset re-expressed in the coordinate space of the region-masked
 * text: shift it by every placeholder that stands entirely before it. Only ever
 * called on an offset that no protected range straddles, which is what
 * throughRegionLayer guarantees below.
 */
function offsetAfterRegionMask(offset: number, region: RegionLayer): number {
  let delta = 0;
  for (let i = 0; i < region.ranges.length; i += 1) {
    // Ranges are sorted and disjoint, so once one ends past the offset every
    // later one does too.
    if (region.ranges[i].end > offset) {
      break;
    }
    delta += region.deltas[i];
  }
  return offset + delta;
}

/**
 * The island spans that still need masking after the region layer ran, in that
 * layer's own coordinates. Two rules, both of which reproduce what scanning the
 * region-masked text used to do, minus the scope defect:
 *
 *  - an island whose START or END falls INSIDE a span the region layer already
 *    protects is DROPPED. Those bytes are restored verbatim by layer 1 already,
 *    and the island's own delimiter is gone from the masked text anyway. This is
 *    what stops the island layer and the front matter layer from double-masking
 *    the same span: front matter rides layer 1, so every island inside it is
 *    dropped here.
 *  - an island that CONTAINS protected spans keeps them: its placeholder simply
 *    swallows the region token, and the reverse restore order (islands first,
 *    then regions) puts both back in the right order.
 */
function throughRegionLayer(
  spans: readonly TemplateIslandSpan[],
  region: RegionLayer | undefined
): readonly TemplateIslandSpan[] {
  if (region === undefined) {
    return spans;
  }
  const kept: TemplateIslandSpan[] = [];
  for (const span of spans) {
    let containsEveryOverlap = true;
    for (const range of region.ranges) {
      if (!overlaps(span, range)) {
        continue;
      }
      if (span.start > range.start || range.end > span.end) {
        containsEveryOverlap = false;
        break;
      }
    }
    if (!containsEveryOverlap) {
      continue;
    }
    kept.push({
      start: offsetAfterRegionMask(span.start, region),
      end: offsetAfterRegionMask(span.end, region)
    });
  }
  return kept;
}

/**
 * Build the complete mask plan for one format attempt.
 *
 *  - non-HTML languages: the region mask (js-beautify family, BOTH scopes),
 *    template island count 0;
 *  - HTML: regions AND the document's front matter block, composed with the
 *    document's template islands. All three are located over the DOCUMENT and
 *    clipped to the input, so every one of those protections applies in BOTH
 *    scopes: `scope` no longer decides WHAT is protected, only how the engine is
 *    called. A placeholder collision yields `abortReason` and no mask: the
 *    caller must decline.
 *
 * `context` lets a SELECTION see the ignore markers, the front matter and the
 * template islands of its document; omit it and the input is treated as the
 * whole document.
 */
export function buildMaskPlan(
  languageId: LangId,
  input: string,
  scope: MaskScope,
  context?: MaskContext
): MaskPlan {
  const ranges = protectedRangesFor(languageId, input, context);
  // Front matter is masked by the REGION layer, so it is protected identically
  // whatever `scope` says. It is deliberately kept OUT of `ranges`: those feed
  // the unhonoured-marker notice, and front matter is not a user directive.
  const frontMatter = frontMatterRangeFor(languageId, input, context);
  const region = buildRegionLayer(
    languageId,
    input,
    withFrontMatter(ranges, frontMatter)
  );
  const regionMask = region?.mask;
  const unhonouredIgnore = unhonouredIgnoreFor(
    languageId,
    input,
    ranges,
    regionMask
  );

  if (languageId !== 'html') {
    return { mask: regionMask, templateIslandCount: 0, unhonouredIgnore };
  }

  // FAIL-SAFE: front matter exists but no mask could be built for it (a
  // placeholder token already occurs in the span). Formatting now would hand the
  // YAML to the engine, and the guard cannot see it reflow. Zero edits instead.
  if (frontMatter !== undefined && regionMask === undefined) {
    return {
      templateIslandCount: 1,
      unhonouredIgnore,
      abortReason: FRONT_MATTER_MASK_FAILED_REASON
    };
  }

  // Counted as one protected span, exactly as when it was an island itself, so
  // the diagnostic keeps its meaning; the masking layer changed, not the promise.
  const frontMatterCount = frontMatter === undefined ? 0 : 1;
  const base = regionMask ? regionMask.engineInput : input;
  // Located over the DOCUMENT and clipped to the input, so a selection sees the
  // islands it cuts through; then carried across the region layer, which also
  // drops anything the front matter placeholder already hides, so no span is
  // ever masked twice.
  const outcome = maskTemplateIslandSpans(
    base,
    throughRegionLayer(templateIslandSpansFor(input, context), region)
  );

  if (outcome.kind === 'collision') {
    return {
      templateIslandCount: frontMatterCount + outcome.islandCount,
      unhonouredIgnore,
      abortReason: TEMPLATE_COLLISION_REASON
    };
  }
  if (outcome.kind === 'unusable') {
    return {
      templateIslandCount: frontMatterCount + outcome.islandCount,
      unhonouredIgnore,
      abortReason: TEMPLATE_ISLAND_SPANS_UNUSABLE_REASON
    };
  }
  if (outcome.kind === 'none') {
    return {
      mask: regionMask,
      templateIslandCount: frontMatterCount,
      unhonouredIgnore
    };
  }

  const islands = outcome.islands;
  return {
    templateIslandCount: frontMatterCount + islands.length,
    unhonouredIgnore,
    mask: {
      engineInput: outcome.masked,
      restore: (engineOutput: string): RestoreOutcome => {
        // Reverse of masking order: islands first, then regions.
        const restored = restoreTemplateIslandsChecked(engineOutput, islands);
        if (restored === undefined) {
          return { ok: false, reason: TEMPLATE_RESTORE_FAILED_REASON };
        }
        return regionMask
          ? regionMask.restore(restored)
          : { ok: true, text: restored };
      }
    }
  };
}

/**
 * The string the engine ACTUALLY receives for this input: the masked text when a
 * mask was built, the input itself otherwise. Single source of truth so a caller
 * can never send one string and describe another.
 */
export function engineTextFor(
  input: string,
  mask: EngineMask | undefined
): string {
  return mask ? mask.engineInput : input;
}

/**
 * The whole-span range to hand the engine, EXPRESSED IN THE COORDINATE SPACE OF
 * THE STRING THE ENGINE RECEIVES.
 *
 * This exists because a mask makes that string a DIFFERENT LENGTH from the
 * caller's input: `tidytplisland0endisland` (23 chars) may stand in for `{{a}}`
 * (5), and a long `{% ... %}` island may be replaced by a SHORTER placeholder.
 * Passing the caller-side length as an engine-side offset made the engine format
 * a PREFIX only and concatenate the drift-length tail unformatted (a silent
 * partial format, sometimes a silent no-op). Deriving the range from the very
 * text being sent makes that class of bug impossible.
 */
export function engineSpanFor(
  input: string,
  mask: EngineMask | undefined
): { readonly startOffset: number; readonly endOffset: number } {
  return { startOffset: 0, endOffset: engineTextFor(input, mask).length };
}
