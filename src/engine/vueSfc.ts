// Vue SFC engine (ADD-15, v1): "template and style under guard, script verbatim".
//
// Formats the <template> block with js-beautify html and every <style> block
// with the matching CSS-family engine (js-beautify css, with the ADD-01
// Prettier postcss fallback), while every <script> block, custom block, and
// the text between blocks is restored byte-for-byte through the hardened
// mask/restore splice (src/ignore/mask.ts).
//
// SAFETY: this engine performs per-block PRE-checks (vueSfcEqual /
// cssTreeEqual) only to DEGRADE a mangled block to verbatim instead of aborting
// the whole file. The authoritative accept/reject decision stays in the
// provider's guard.check('vue', input, output) -> vueSfcEqual, which re-splits
// both sides and re-verifies every block plus the skeleton. A bug here can at
// worst produce a no-op, never a corruption.
//
// Clean no-op contract (returns the input UNCHANGED, so the provider records
// 'already-tidy' and applies zero edits): unsplittable SFC, unsupported
// template/style language (pug, stylus, ...), empty blocks only, placeholder
// collision, or a range request (v1 is whole-document only; no range provider
// is registered for 'vue').
//
// A verifier chunk LOAD failure (chunk-guard-html/css) is NOT swallowed by the
// defensive catches below: the per-block checks rethrow it, so the provider
// aborts with the file intact, exactly as for every other language.
//
// PURE: MUST NOT import 'vscode' (testable under mocha + tsx).
import { isChunkLoadError } from '../chunks/loader';
import type { Engine, FormatRequest, LangId, ResolvedOptions } from '../types';
import { JsBeautifyEngine } from './jsbeautify';
import { PrettierEngine } from './prettier';
import { applyMask, restoreMask, type Restoration } from '../ignore/mask';
import type { ProtectedRange } from '../ignore/markers';
import { cssTreeEqual, vueSfcEqual } from '../safety/guard';
import {
  isSupportedTemplateBlock,
  splitVueSfc,
  styleGuardLangFor,
  type VueBlock,
  type VueSfcSplit
} from '../vue/sfcBlocks';

// Stateless adapters, safe as module singletons (same pattern as dispatcher.ts).
const jsBeautifyEngine = new JsBeautifyEngine();
const prettierEngine = new PrettierEngine();

/** Trailing newlines of an engine's block output (block joins are explicit). */
const TRAILING_NEWLINES = /(?:\r\n|\r|\n)+$/;

/** Spaces and tabs before the first line break of a style body. */
const LEADING_BLANKS = /^[ \t]+/;

/**
 * Options for a block-level sub-format: identical to the document's resolved
 * options except the final-newline policy, which is neutralised exactly like
 * the range path in jsbeautify.ts does (a block is not the end of the file;
 * the engine controls block-boundary newlines itself).
 */
function blockOptions(options: ResolvedOptions): ResolvedOptions {
  return { ...options, insertFinalNewline: undefined };
}

/** First EOL sequence of a text, normalising a bare CR to LF, or undefined. */
function firstEol(text: string): string | undefined {
  const match = /\r\n|\r|\n/.exec(text);
  if (match === null) {
    return undefined;
  }
  return match[0] === '\r' ? '\n' : match[0];
}

/**
 * The newline used around a rebuilt <style> body: the resolved endOfLine when
 * the user/project pinned one, else the block's own dominant EOL, else the
 * document's, else LF. Deterministic so a second pass reproduces it exactly.
 */
function blockNewline(
  options: ResolvedOptions,
  inner: string,
  source: string
): string {
  if (options.endOfLine === 'crlf') {
    return '\r\n';
  }
  if (options.endOfLine === 'lf') {
    return '\n';
  }
  return firstEol(inner) ?? firstEol(source) ?? '\n';
}

/**
 * Whether v1 can format EVERY block of this SFC. One unsupported template or
 * style language makes the whole file a clean no-op ("no-op propre"): we do
 * not half-format a file whose main body we cannot verify. Script and custom
 * blocks are always acceptable because they stay verbatim.
 */
function allBlocksSupported(split: VueSfcSplit): boolean {
  return split.blocks.every((block) => {
    if (block.kind === 'template') {
      return isSupportedTemplateBlock(block);
    }
    if (block.kind === 'style') {
      return styleGuardLangFor(block) !== undefined;
    }
    return true;
  });
}

/**
 * Guard-verdict helper that treats a throwing comparison as "not equivalent",
 * except a chunk LOAD failure, which is the verifier's failure and propagates.
 */
function cssTreeEqualSafe(
  lang: 'css' | 'scss' | 'less',
  input: string,
  output: string
): boolean {
  try {
    return cssTreeEqual(lang, input, output).equivalent;
  } catch (error: unknown) {
    if (isChunkLoadError(error)) {
      throw error;
    }
    return false;
  }
}

/**
 * Same, for a template block: the whole `<template>` outer text goes through
 * the guard's SFC comparison, so the pre-check IS the Vue-compiled comparison.
 */
function templateEqualSafe(input: string, output: string): boolean {
  try {
    return vueSfcEqual(input, output).equivalent;
  } catch (error: unknown) {
    if (isChunkLoadError(error)) {
      throw error;
    }
    return false;
  }
}

/**
 * Run one engine on a block body; undefined when the engine throws. The output
 * is trimmed: block joins (newlines, indentation context) are owned by the
 * caller, never by the sub-engine. A chunk LOAD failure (Prettier) propagates.
 */
async function tryEngine(
  engine: Engine,
  languageId: LangId,
  code: string,
  options: ResolvedOptions
): Promise<string | undefined> {
  try {
    const formatted = await engine.format({
      languageId,
      code,
      options: blockOptions(options)
    });
    return formatted.trim();
  } catch (error: unknown) {
    if (isChunkLoadError(error)) {
      throw error;
    }
    return undefined;
  }
}

/**
 * Format a <style> body with the js-beautify CSS family engine, falling back to
 * the ADD-01 Prettier postcss path when js-beautify's output fails the
 * per-block tree check. Returns the accepted body, or undefined when no engine
 * produced a verifiable result (block stays verbatim).
 */
async function formatCssBody(
  cssLang: 'css' | 'scss' | 'less',
  inner: string,
  options: ResolvedOptions
): Promise<string | undefined> {
  // Blanks on the opening-tag line are not part of the first rule: js-beautify
  // would take them as the base indent of every later line (not idempotent).
  const body = inner.replace(LEADING_BLANKS, '');
  const first = await tryEngine(jsBeautifyEngine, cssLang, body, options);
  if (first !== undefined && cssTreeEqualSafe(cssLang, inner, first)) {
    return first;
  }
  if (prettierEngine.supports(cssLang)) {
    const second = await tryEngine(prettierEngine, cssLang, body, options);
    if (second !== undefined && cssTreeEqualSafe(cssLang, inner, second)) {
      return second;
    }
  }
  return undefined;
}

/**
 * Format a template block. The OUTER slice (tags included) goes through the
 * js-beautify html engine so the content indentation relative to <template> is
 * owned end-to-end by js-beautify: that is what makes a second pass a fixed
 * point (idempotence) without any hand-rolled reindentation. Returns the new
 * outer text, or undefined to keep the block verbatim (engine error, engine
 * output failing the per-block tree check, or no change).
 */
async function formatTemplateBlock(
  source: string,
  block: VueBlock,
  options: ResolvedOptions
): Promise<string | undefined> {
  const outer = source.slice(block.outerStart, block.outerEnd);
  const formatted = await tryEngine(jsBeautifyEngine, 'html', outer, options);
  if (formatted === undefined) {
    return undefined;
  }
  const candidate = formatted.replace(TRAILING_NEWLINES, '');
  if (candidate === outer) {
    return undefined;
  }
  // Pre-check with the same comparison the global guard will run, so a mangled
  // template degrades to verbatim (styles still format) instead of aborting
  // the whole file at the provider's guard.
  if (!templateEqualSafe(outer, candidate)) {
    return undefined;
  }
  return candidate;
}

/**
 * Format a style block. The INNER body is formatted at column 0 (the standard
 * Vue convention, matching Prettier's vueIndentScriptAndStyle: false) and the
 * block is re-emitted as startTag + NL + body + NL + endTag, with the tags
 * byte-identical to the source. Returns the new outer text, or undefined to
 * keep the block verbatim.
 */
async function formatStyleBlock(
  source: string,
  block: VueBlock,
  inner: string,
  options: ResolvedOptions
): Promise<string | undefined> {
  const cssLang = styleGuardLangFor(block);
  if (cssLang === undefined) {
    return undefined; // unreachable behind allBlocksSupported; defensive.
  }
  const body = await formatCssBody(cssLang, inner, options);
  if (body === undefined || body === '') {
    return undefined;
  }
  const newline = blockNewline(options, inner, source);
  const startTagRaw = source.slice(block.outerStart, block.innerStart);
  const endTagRaw = source.slice(block.innerEnd, block.outerEnd);
  const replacement = startTagRaw + newline + body + newline + endTagRaw;
  return replacement === source.slice(block.outerStart, block.outerEnd)
    ? undefined
    : replacement;
}

/**
 * Compute the replacement outer text for one block, or undefined to keep it
 * verbatim. Script blocks and custom blocks are ALWAYS undefined: that is the
 * v1 contract, enforced again by the guard (byte-identical body required).
 */
async function formatBlock(
  source: string,
  block: VueBlock,
  options: ResolvedOptions
): Promise<string | undefined> {
  if (block.kind === 'script' || block.kind === 'custom') {
    return undefined;
  }
  const inner = source.slice(block.innerStart, block.innerEnd);
  if (inner.trim() === '') {
    return undefined; // empty or src-only block: nothing to format.
  }
  if (block.kind === 'template') {
    return formatTemplateBlock(source, block, options);
  }
  return formatStyleBlock(source, block, inner, options);
}

/**
 * Reassemble the document through the hardened mask/restore splice: every block
 * outer span is masked with a unique placeholder, then restored with either its
 * formatted replacement or its VERBATIM original bytes. The masked skeleton
 * never goes through any engine, so the text between blocks is byte-identical
 * by construction (and the guard re-proves it). Returns undefined on any
 * placeholder collision or splice anomaly (caller then no-ops cleanly).
 */
function reassemble(
  source: string,
  blocks: readonly VueBlock[],
  replacements: ReadonlyArray<string | undefined>
): string | undefined {
  const ranges: ProtectedRange[] = blocks.map((block) => ({
    start: block.outerStart,
    end: block.outerEnd,
    kind: 'region' as const
  }));
  const masked = applyMask(source, ranges);
  if (masked === undefined) {
    return undefined;
  }
  const restorations: Restoration[] = masked.restorations.map((entry, index) => {
    const replacement = replacements[index];
    return replacement === undefined
      ? entry
      : { ...entry, original: replacement };
  });
  return restoreMask(masked.masked, restorations);
}

export class VueSfcEngine implements Engine {
  public readonly id = 'vue-sfc';

  public supports(lang: LangId): boolean {
    return lang === 'vue';
  }

  public async format(req: FormatRequest): Promise<string> {
    // v1 is whole-document only. No range provider is registered for 'vue';
    // if a range request arrives anyway, the identity result keeps the
    // document intact (mirrors the degenerate-range convention upstream).
    if (req.range) {
      return req.code;
    }

    const split = splitVueSfc(req.code);
    if (split === undefined || split.blocks.length === 0) {
      return req.code;
    }
    if (!allBlocksSupported(split)) {
      return req.code; // pug template, stylus style, ...: clean whole-file no-op.
    }

    const replacements: Array<string | undefined> = [];
    for (const block of split.blocks) {
      replacements.push(await formatBlock(req.code, block, req.options));
    }
    if (replacements.every((replacement) => replacement === undefined)) {
      return req.code;
    }

    return reassemble(req.code, split.blocks, replacements) ?? req.code;
  }
}
