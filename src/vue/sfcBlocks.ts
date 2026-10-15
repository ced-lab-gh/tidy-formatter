// Vue SFC top-level block splitter (ADD-15).
//
// Splits a .vue single-file component into its top-level blocks (<template>,
// <script>, <style>, custom blocks) using parse5 WITH source locations, so both
// the Vue engine (src/engine/vueSfc.ts) and the safety guard (src/safety/guard.ts)
// slice the ORIGINAL bytes of each block instead of trusting a re-serialisation.
//
// Defensive by construction: a block is only reported when parse5 saw a REAL
// start tag AND a REAL end tag, and when every block's source range is strictly
// increasing and non-overlapping. Anything parse5 had to repair (implied end
// tags, self-closing non-void tags, foster parenting such as a top-level
// <table> hoisting a <div> out of itself) yields `undefined`, and the callers
// treat that as a clean whole-file no-op. We never guess offsets.
//
// parse5 lives in the lazily loaded chunk-guard-html (ADD-11), so it is reached
// through the chunk loader and never imported statically. A chunk LOAD failure
// is thrown to the caller (never turned into `undefined`): it is a failure of
// the verifier, not a statement about the user's file.
//
// PURE: MUST NOT import 'vscode', any engine, or the guard, so it stays
// unit-testable under mocha + tsx and usable from src/safety/guard.ts without
// an import cycle.
import { requireGuardHtmlChunk } from '../chunks/loader';

/** The role of a top-level SFC block. Anything unknown is a custom block. */
export type VueBlockKind = 'template' | 'script' | 'style' | 'custom';

/**
 * One parsed attribute of a block tag. `name` is parse5's lower-cased name;
 * `rawName` is the name as written in the source (Vue reads `setup`, `lang`,
 * `scoped` and `src` case-sensitively, so the guard compares `rawName`).
 */
export interface VueBlockAttr {
  readonly name: string;
  readonly rawName: string;
  readonly value: string;
}

/**
 * One top-level SFC block, located by half-open byte offsets into the ORIGINAL
 * source: [outerStart, outerEnd) spans the whole block including its tags,
 * [innerStart, innerEnd) spans the content between the start and end tag.
 */
export interface VueBlock {
  readonly kind: VueBlockKind;
  readonly tagName: string;
  /** The tag name as written in the source (case kept); Vue matches it exactly. */
  readonly rawTagName: string;
  readonly attrs: readonly VueBlockAttr[];
  /** The `lang` attribute, trimmed + lower-cased, or undefined when absent. */
  readonly lang: string | undefined;
  readonly outerStart: number;
  readonly innerStart: number;
  readonly innerEnd: number;
  readonly outerEnd: number;
}

/** The result of a successful split. Blocks are in document order. */
export interface VueSfcSplit {
  readonly blocks: readonly VueBlock[];
}

// Minimal structural view of the parse5 nodes we read. parse5's own types are
// generic over a tree adapter; a local interface keeps this module simple and
// mirrors the approach already used by src/safety/guard.ts for Parse5Node.
interface Parse5Span {
  startOffset: number;
  endOffset: number;
}

interface Parse5NodeLocation extends Parse5Span {
  startTag?: Parse5Span;
  endTag?: Parse5Span;
  /** Location of each attribute, keyed by its lower-cased token name. */
  attrs?: Record<string, Parse5Span>;
}

interface Parse5ChildNode {
  nodeName: string;
  tagName?: string;
  attrs?: Array<{ name: string; value: string }>;
  sourceCodeLocation?: Parse5NodeLocation | null;
}

/** The tag name as written in a start tag span, or undefined if unreadable. */
export function rawTagNameAt(source: string, startTag: Parse5Span): string | undefined {
  const match = /^<([^\s/>]+)/.exec(source.slice(startTag.startOffset, startTag.endOffset));
  return match === null ? undefined : match[1];
}

/**
 * The attribute name as written in the source, or undefined when it cannot be
 * read back or does not match parse5's name once lower-cased (the caller then
 * treats the tag as unsupported rather than guess).
 */
export function rawAttrNameAt(
  source: string,
  spans: Record<string, Parse5Span> | undefined,
  parse5Name: string
): string | undefined {
  // Own keys only: an attribute named `__proto__` must not reach Object.prototype.
  const span =
    spans !== undefined && Object.prototype.hasOwnProperty.call(spans, parse5Name)
      ? spans[parse5Name]
      : undefined;
  if (span === undefined) {
    return undefined;
  }
  const match = /^=?[^\s=/>]*/.exec(source.slice(span.startOffset, span.endOffset));
  if (match === null || match[0].toLowerCase() !== parse5Name.toLowerCase()) {
    return undefined;
  }
  return match[0];
}

/** Vue matches the three standard block names exactly (`<Script>` is custom). */
function kindOf(tagName: string): VueBlockKind {
  switch (tagName) {
    case 'template':
      return 'template';
    case 'script':
      return 'script';
    case 'style':
      return 'style';
    default:
      return 'custom';
  }
}

/**
 * Read the normalised `lang` attribute of a block, or undefined when absent.
 * parse5 already lower-cases attribute NAMES; the VALUE is normalised here
 * (trim + lower-case) so `lang=" SCSS "` classifies as `scss`.
 */
function langOf(attrs: readonly VueBlockAttr[]): string | undefined {
  const langAttr = attrs.find((attr) => attr.name === 'lang');
  return langAttr === undefined ? undefined : langAttr.value.trim().toLowerCase();
}

/**
 * Split a Vue SFC into its top-level blocks, or return `undefined` when the
 * document cannot be split SAFELY:
 *   - parse5 throws (defensive; parse5 is error-tolerant by design),
 *   - a top-level element lacks a real start or end tag in the source
 *     (implied/auto-closed tags, self-closing `<template/>`),
 *   - block offsets are not strictly increasing and non-overlapping
 *     (foster parenting or any other tree repair parse5 performed).
 *
 * `{ blocks: [] }` (a document with no top-level element at all) is a VALID
 * result: the caller treats it as "nothing to format".
 *
 * parse5's parseFragment uses the <template> element as its default fragment
 * context, which is exactly the permissive content model an SFC needs
 * (top-level <template>/<script>/<style>/custom tags all parse as siblings,
 * and <script>/<style> bodies stay raw text).
 */
export function splitVueSfc(source: string): VueSfcSplit | undefined {
  if (typeof source !== 'string') {
    return undefined;
  }

  // Outside the try on purpose: a chunk LOAD failure must propagate.
  const { parseHtmlFragment } = requireGuardHtmlChunk();

  let childNodes: Parse5ChildNode[];
  // parse5 keeps the FIRST of two same-named attributes, Vue the LAST: a block
  // tag with a duplicate cannot be read the same way by both (V4).
  const duplicateAttrOffsets: number[] = [];
  try {
    const fragment = parseHtmlFragment(source, {
      sourceCodeLocationInfo: true,
      onParseError: (error: { code: string; startOffset: number }) => {
        if (error.code === 'duplicate-attribute') {
          duplicateAttrOffsets.push(error.startOffset);
        }
      }
    }) as unknown as { childNodes?: Parse5ChildNode[] };
    childNodes = Array.isArray(fragment.childNodes) ? fragment.childNodes : [];
  } catch {
    return undefined;
  }

  const blocks: VueBlock[] = [];
  let previousEnd = 0;

  for (const node of childNodes) {
    // Non-element nodes (#text, #comment) between blocks belong to the
    // skeleton, which is sliced from the raw source by offset gaps: they need
    // no location bookkeeping here.
    if (node.tagName === undefined) {
      continue;
    }

    const location = node.sourceCodeLocation;
    // A block is only trustworthy when parse5 saw BOTH tags in the source.
    if (!location || !location.startTag || !location.endTag) {
      return undefined;
    }

    const outerStart = location.startTag.startOffset;
    const innerStart = location.startTag.endOffset;
    const innerEnd = location.endTag.startOffset;
    const outerEnd = location.endTag.endOffset;

    const wellFormed =
      Number.isInteger(outerStart) &&
      Number.isInteger(innerStart) &&
      Number.isInteger(innerEnd) &&
      Number.isInteger(outerEnd) &&
      outerStart >= previousEnd &&
      innerStart > outerStart &&
      innerEnd >= innerStart &&
      outerEnd > innerEnd &&
      outerEnd <= source.length;
    if (!wellFormed) {
      // Overlapping or out-of-order ranges mean parse5 repaired the tree
      // (e.g. foster parenting): the source cannot be sliced safely.
      return undefined;
    }

    const rawTagName = rawTagNameAt(source, location.startTag);
    if (rawTagName === undefined || rawTagName.toLowerCase() !== node.tagName) {
      return undefined;
    }
    const attrs: VueBlockAttr[] = [];
    for (const attr of node.attrs ?? []) {
      const rawName = rawAttrNameAt(source, location.attrs, attr.name);
      if (rawName === undefined) {
        return undefined;
      }
      attrs.push({ name: attr.name, rawName, value: attr.value });
    }

    blocks.push({
      kind: kindOf(rawTagName),
      tagName: node.tagName,
      rawTagName,
      attrs,
      lang: langOf(attrs),
      outerStart,
      innerStart,
      innerEnd,
      outerEnd
    });
    previousEnd = outerEnd;
  }

  for (const offset of duplicateAttrOffsets) {
    if (blocks.some((block) => offset >= block.outerStart && offset < block.innerStart)) {
      return undefined;
    }
  }
  return { blocks };
}

/**
 * The document text OUTSIDE the blocks, in order: segment before the first
 * block, segments between consecutive blocks, segment after the last block
 * (always blocks.length + 1 entries). This is the "skeleton" that v1 never
 * formats; the guard requires it byte-identical between input and output.
 */
export function skeletonSegments(
  source: string,
  blocks: readonly VueBlock[]
): string[] {
  const segments: string[] = [];
  let previousEnd = 0;
  for (const block of blocks) {
    segments.push(source.slice(previousEnd, block.outerStart));
    previousEnd = block.outerEnd;
  }
  segments.push(source.slice(previousEnd));
  return segments;
}

/**
 * Whether a template block's content language is one v1 can format and verify
 * (plain HTML). `lang="pug"` and friends are NOT: the whole file becomes a
 * clean no-op (the engine cannot format what the guard cannot verify).
 */
export function isSupportedTemplateBlock(block: VueBlock): boolean {
  return block.kind === 'template' && (block.lang === undefined || block.lang === 'html');
}

/**
 * The guard/engine CSS dialect for a style block, or undefined when the block
 * is not a style block or uses a dialect v1 cannot verify (stylus, sass
 * indented, ...). A missing `lang` means plain CSS. Implemented as a switch,
 * NOT a record lookup, so a hostile `lang="__proto__"` can never walk the
 * prototype chain into a false positive (same defence class as the audit's
 * __proto__ findings).
 */
export function styleGuardLangFor(
  block: VueBlock
): 'css' | 'scss' | 'less' | undefined {
  if (block.kind !== 'style') {
    return undefined;
  }
  switch (block.lang) {
    case undefined:
    case 'css':
      return 'css';
    case 'scss':
      return 'scss';
    case 'less':
      return 'less';
    default:
      return undefined;
  }
}
