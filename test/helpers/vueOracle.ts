// Oracle for the Vue guard: the real Vue compiler (@vue/compiler-dom, a
// devDependency pinned to 3.5.25). TEST ONLY: nothing under src/ may import it.
import { compile } from '@vue/compiler-dom';
import { JsBeautifyEngine } from '../../src/engine/jsbeautify';
import type { ResolvedOptions } from '../../src/types';
import { splitVueSfc } from '../../src/vue/sfcBlocks';

/**
 * The compiled render code of one template body, plus the compiler's error
 * codes, as one comparable string. `comments` selects the development build
 * (comments kept) or the production build (comments dropped) of compiler-core.
 */
export function compiledRender(template: string, comments: boolean): string {
  const key = `${comments ? 'dev' : 'prod'}:${template}`;
  const known = renderCache.get(key);
  if (known !== undefined) {
    return known;
  }
  const errors: number[] = [];
  let result: string;
  try {
    const { code } = compile(template, {
      whitespace: 'condense',
      comments,
      onError: (error) => errors.push(Number(error.code)),
      onWarn: () => undefined
    });
    result = JSON.stringify({ code, errors });
  } catch (error: unknown) {
    result = JSON.stringify({ threw: error instanceof Error ? error.message : String(error) });
  }
  renderCache.set(key, result);
  return result;
}

const renderCache = new Map<string, string>();

/** True when both builds of the compiler agree that the two bodies render alike. */
export function sameRender(a: string, b: string): boolean {
  return compiledRender(a, true) === compiledRender(b, true) && compiledRender(a, false) === compiledRender(b, false);
}

/** `<template>` + body + `</template>`, the unit the engine and the guard see. */
export function outerTemplate(body: string): string {
  return `<template>${body}</template>`;
}

/** The body of the first `<template>` block of an SFC, or undefined. */
export function templateBody(sfc: string): string | undefined {
  const block = splitVueSfc(sfc)?.blocks.find((candidate) => candidate.kind === 'template');
  return block === undefined ? undefined : sfc.slice(block.innerStart, block.innerEnd);
}

export const ORACLE_OPTION_SETS: ReadonlyArray<readonly [string, ResolvedOptions]> = [
  ['default', { tabSize: 2, insertSpaces: true, engineOptions: {}, sources: {} }],
  ['tab4', { tabSize: 4, insertSpaces: true, engineOptions: {}, sources: {} }],
  ['tabs', { tabSize: 2, insertSpaces: false, engineOptions: {}, sources: {} }],
  ['wrap40', { tabSize: 2, insertSpaces: true, engineOptions: { wrap_line_length: 40 }, sources: {} }],
  ['wrap80', { tabSize: 2, insertSpaces: true, engineOptions: { wrap_line_length: 80 }, sources: {} }]
];

const jsBeautify = new JsBeautifyEngine();

/**
 * What js-beautify HTML proposes for a template block BEFORE any check, exactly
 * as formatTemplateBlock asks for it (outer text, trimmed, no trailing newline).
 */
export async function rawCandidate(outer: string, options: ResolvedOptions): Promise<string> {
  const formatted = await jsBeautify.format({
    languageId: 'html',
    code: outer,
    options: { ...options, insertFinalNewline: undefined }
  });
  return formatted.trim().replace(/(?:\r\n|\r|\n)+$/, '');
}
