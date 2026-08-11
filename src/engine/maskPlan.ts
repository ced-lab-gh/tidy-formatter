// Mask plan builder: composes the two protect-and-restore layers that shield
// byte spans from the formatting engines, producing a single engine-facing mask:
//   1. in-source ignore REGIONS (tidy-ignore-start/end + node markers), the
//      existing mechanic from ignore/markers + ignore/mask (js-beautify family,
//      document scope only);
//   2. HTML TEMPLATE ISLANDS ({{ }}, {% %}, <% %>, and a head front matter
//      '---' block), the CFG-04 promise wired in by ADD-02 (html only; document
//      AND selection scope, front matter in document scope only).
//
// Masking order: regions first (their byte ranges come from scanMarkers over the
// caller's input), islands second over the region-masked text, so an island
// inside an ignored region is already hidden and never double-masked. Restore
// order is the exact reverse: islands first, then regions.
//
// WHY ISLANDS NEED THEIR OWN LAYER: the HTML guard normalises whitespace inside
// text nodes, so an engine that reflows the INSIDE of a `{% if x %}` tag makes a
// change the guard cannot see. Mask-then-restore is the only mechanism that can
// promise those bytes come back identical; the guard then judges the whole
// restored document as usual.
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
import { scanMarkers } from '../ignore/markers';
import { applyMask, restoreMask } from '../ignore/mask';
import {
  maskHtmlTemplateIslands,
  restoreTemplateIslandsChecked
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
 * The full plan for one format attempt:
 *  - `mask`               : absent when the engine can format the input as-is;
 *  - `templateIslandCount`: islands protected by this plan (front matter counts
 *                           as one), for diagnostics;
 *  - `abortReason`        : present when formatting CANNOT proceed safely
 *                           (placeholder collision); the caller must return zero
 *                           edits without calling any engine.
 */
export interface MaskPlan {
  readonly mask?: EngineMask;
  readonly templateIslandCount: number;
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
 * Build the region mask for the full-document js-beautify path, or undefined
 * when there is nothing to protect (no regions) or region masking is unsafe
 * (collision / malformed ranges): in those cases the caller formats normally,
 * exactly the pre-ADD-02 behaviour. PURE orchestration over the mask module.
 */
function buildRegionMask(
  languageId: LangId,
  input: string
): EngineMask | undefined {
  if (!REGION_MASKING_LANGUAGES.has(languageId)) {
    return undefined; // Prettier path honours `// prettier-ignore` natively.
  }
  const scan = scanMarkers(input, languageId);
  if (scan.protectedRanges.length === 0) {
    return undefined;
  }
  const masked = applyMask(input, scan.protectedRanges);
  if (masked === undefined) {
    return undefined; // collision / malformed ranges -> format normally.
  }
  return {
    engineInput: masked.masked,
    restore: (engineOutput: string): RestoreOutcome => {
      const restored = restoreMask(engineOutput, masked.restorations);
      return restored === undefined
        ? { ok: false, reason: REGION_RESTORE_FAILED_REASON }
        : { ok: true, text: restored };
    }
  };
}

/**
 * Build the complete mask plan for one format attempt.
 *
 *  - non-HTML languages: the existing region mask (document scope only),
 *    template island count 0: byte-for-byte the pre-ADD-02 behaviour;
 *  - HTML: regions (document scope only) composed with template islands (both
 *    scopes; front matter in document scope only). A placeholder collision
 *    yields `abortReason` and no mask: the caller must decline.
 */
export function buildMaskPlan(
  languageId: LangId,
  input: string,
  scope: MaskScope
): MaskPlan {
  const regionMask =
    scope === 'document' ? buildRegionMask(languageId, input) : undefined;

  if (languageId !== 'html') {
    return { mask: regionMask, templateIslandCount: 0 };
  }

  const base = regionMask ? regionMask.engineInput : input;
  const outcome = maskHtmlTemplateIslands(base, scope === 'document');

  if (outcome.kind === 'collision') {
    return {
      templateIslandCount: outcome.islandCount,
      abortReason: TEMPLATE_COLLISION_REASON
    };
  }
  if (outcome.kind === 'none') {
    return { mask: regionMask, templateIslandCount: 0 };
  }

  const islands = outcome.islands;
  return {
    templateIslandCount: islands.length,
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
