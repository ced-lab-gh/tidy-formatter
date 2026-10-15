// Vue template equivalence: the template compared the way Vue COMPILES it.
//
// HTML treats a space and a line break as the same gap. Vue does not: its
// compiler (whitespace: 'condense', the default) deletes a whitespace-only text
// node that holds a line break between two elements, keeps one made of plain
// spaces as a single space, and keeps the edges of every other text. A
// reformat that moves `<A/> <B/>` onto two lines therefore changes the render,
// which the HTML comparison cannot see (audit 21, V1 and V2).
//
// This module builds a small Vue-shaped tree from parse5 (plus source offsets)
// and applies the `condenseWhitespace` rules of @vue/compiler-core 3.5. The
// rules are copied from its parser, not guessed; see condenseList below.
//
// WHAT IS PROVED, AND WHAT IS REFUSED. parse5 and Vue's tokenizer are different
// parsers. Whenever parse5 had to repair the markup, or reads it differently
// from Vue, the tree cannot be trusted and the template is UNSUPPORTED: the
// verdict is "not equivalent" and the engine leaves the block verbatim.
//   - an element without both tags in the source, a node out of source order
//     (implied end tags, foster parenting, adoption agency);
//   - a start or end tag written in the source that the tree does not hold
//     (stray end tags, `<td>` outside a table, `<body>`): parse5 ignores them;
//   - `{{` with no `}}` in the same text (Vue's interpolation runs across markup);
//   - braces spelled as entities (parse5 decodes them, Vue's tokenizer does not);
//   - elements parse5 reads as raw text but Vue as markup (xmp, iframe, ...);
//   - duplicate attributes (parse5 keeps the first, Vue keeps both);
//   - a lone carriage return (parse5 turns it into a line feed, Vue keeps it).
// The one repair it undoes is the `<tbody>` parse5 invents for `<table><tr>`.
// Two more facts parse5 hides are put back in the shape: the line break right
// after `<pre>` or `<textarea>` (Vue keeps an empty text where parse5 drops it)
// and whether an attribute was written with an `=` (`:foo` is not `:foo=""`).
// Names are compared with the case written in the source (V3), attributes in
// source order (order decides `v-bind` overriding), interpolations verbatim
// (V5), and the `/>` of a non-void tag is part of the shape (V6): Vue closes the
// element there, parse5 does not, so the siblings parse5 nests inside it are
// lifted back out before the whitespace rules run.
//
// Comments: compiler-core keeps them in development builds and drops them in
// production builds, and the whitespace rules see them as neighbours in one
// case only. Both readings must agree.
//
// PURE: MUST NOT import 'vscode' or the guard (guard.ts imports this module).
import { isChunkLoadError, requireGuardHtmlChunk } from '../chunks/loader';
import type { GuardVerdict } from '../types';
import { rawAttrNameAt, rawTagNameAt } from '../vue/sfcBlocks';
import {
  childWhitespaceContext,
  ROOT_WHITESPACE_CONTEXT,
  significanceOf,
  type WhitespaceContext
} from './htmlWhitespace';

// compiler-core NodeTypes used by condenseWhitespace.
const ELEMENT = 1;
const TEXT = 2;
const COMMENT = 3;
const INTERPOLATION = 5;

interface VElement {
  readonly type: typeof ELEMENT;
  readonly tag: string;
  readonly attrs: ReadonlyArray<readonly [string, string, boolean]>;
  readonly selfClosing: boolean;
  /** The line break written right after `<pre>` or `<textarea>`: parse5 drops it, Vue keeps an empty text. */
  readonly lead: string;
  readonly children: VNode[];
}
interface VText {
  readonly type: typeof TEXT;
  readonly text: string;
  /** Compared byte for byte: a preformatted, xml:space or white-space context. */
  readonly raw: boolean;
}
interface VLeaf {
  readonly type: typeof COMMENT | typeof INTERPOLATION;
  readonly text: string;
}
type VNode = VElement | VText | VLeaf;

interface Span {
  startOffset: number;
  endOffset: number;
}
interface P5Location extends Span {
  startTag?: Span;
  endTag?: Span;
  attrs?: Record<string, Span>;
}
interface P5Node {
  nodeName: string;
  tagName?: string;
  value?: string;
  data?: string;
  attrs?: Array<{ name: string; value: string; prefix?: string }>;
  childNodes?: P5Node[];
  content?: P5Node;
  sourceCodeLocation?: P5Location | null;
}

/** Thrown for markup the guard cannot prove; the message is a fixed phrase. */
class UnsupportedTemplate extends Error {}

function unsupported(reason: string): never {
  throw new UnsupportedTemplate(reason);
}

// Vue's void list is case-sensitive; parse5's is wider (frame, keygen, ...).
const VUE_VOID = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr'
]);
const PARSE5_VOID = new Set([
  ...VUE_VOID, 'basefont', 'bgsound', 'frame', 'keygen'
]);
// parse5 reads these as raw text (or drops them); Vue reads their content as markup.
const REFUSED_TAG_SOURCE =
  /<(?:html|head|body|frameset|frame|plaintext|xmp|iframe|noscript|noembed|noframes|listing)[\s/>]/i;
const LEADING_NEWLINE_TAGS = new Set(['pre', 'textarea']);
const TEXT_ONLY_TAGS = new Set(['script', 'style', 'textarea', 'title']);

const isVueWhitespace = (code: number): boolean =>
  code === 32 || code === 10 || code === 9 || code === 12 || code === 13;

function isAllWhitespace(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    if (!isVueWhitespace(text.charCodeAt(i))) {
      return false;
    }
  }
  return true;
}

function hasNewline(text: string): boolean {
  return text.includes('\n') || text.includes('\r');
}

/** compiler-core `condense`: every run of whitespace becomes one space. */
function condenseText(text: string): string {
  let out = '';
  let previousWasSpace = false;
  for (let i = 0; i < text.length; i += 1) {
    if (isVueWhitespace(text.charCodeAt(i))) {
      if (!previousWasSpace) {
        out += ' ';
        previousWasSpace = true;
      }
    } else {
      out += text[i];
      previousWasSpace = false;
    }
  }
  return out;
}

function trimVueWhitespace(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && isVueWhitespace(text.charCodeAt(start))) {
    start += 1;
  }
  while (end > start && isVueWhitespace(text.charCodeAt(end - 1))) {
    end -= 1;
  }
  return text.slice(start, end);
}

function countChar(text: string, char: string): number {
  return text.split(char).length - 1;
}

// --- parse5 -> Vue-shaped tree -----------------------------------------------

interface Walk {
  readonly source: string;
  /** End of the last node read: nodes must come in source order. */
  cursor: number;
  /** Start and end tags the tree accounts for, by lower-case name. */
  readonly startTags: Map<string, number>;
  readonly endTags: Map<string, number>;
  /** Comments and attributes: text there is not markup (see tagCounts). */
  readonly masks: Span[];
}

interface Scope {
  readonly ws: WhitespaceContext;
  readonly vPre: boolean;
  readonly textOnly: boolean;
}

const ROOT_SCOPE: Scope = { ws: ROOT_WHITESPACE_CONTEXT, vPre: false, textOnly: false };

function advance(walk: Walk, start: number, end: number): void {
  if (start < walk.cursor) {
    unsupported('is not in source order');
  }
  walk.cursor = end;
}

/** Text and `{{ }}` pieces of one parse5 text node, as Vue's tokenizer cuts them. */
function splitText(value: string, raw: boolean, interpolate: boolean): VNode[] {
  if (!interpolate) {
    return [{ type: TEXT, text: value, raw }];
  }
  const pieces: VNode[] = [];
  let from = 0;
  for (;;) {
    const open = value.indexOf('{{', from);
    if (open < 0) {
      break;
    }
    const close = value.indexOf('}}', open + 2);
    if (close < 0) {
      unsupported('has an unterminated interpolation');
    }
    if (open > from) {
      pieces.push({ type: TEXT, text: value.slice(from, open), raw });
    }
    pieces.push({ type: INTERPOLATION, text: trimVueWhitespace(value.slice(open + 2, close)) });
    from = close + 2;
  }
  if (from < value.length) {
    pieces.push({ type: TEXT, text: value.slice(from), raw });
  }
  return pieces;
}

function convertText(node: P5Node, scope: Scope, walk: Walk, out: VNode[]): void {
  const location = node.sourceCodeLocation;
  if (!location) {
    unsupported('has text without a source position');
  }
  advance(walk, location.startOffset, location.endOffset);
  const value = node.value ?? '';
  const written = walk.source.slice(location.startOffset, location.endOffset);
  // An entity that decodes to a brace could form a `{{` only parse5 sees.
  if (countChar(written, '{') !== countChar(value, '{') || countChar(written, '}') !== countChar(value, '}')) {
    unsupported('spells a brace as an entity');
  }
  const raw = scope.textOnly || significanceOf(scope.ws) !== 'collapse';
  out.push(...splitText(value, raw, !scope.vPre && !scope.textOnly));
}

function endTagMatches(source: string, endTag: Span, tag: string): boolean {
  const match = /^<\/([^\s/>]+)/.exec(source.slice(endTag.startOffset, endTag.endOffset));
  return match !== null && match[1].toLowerCase() === tag;
}

function ownSpan(spans: Record<string, Span> | undefined, key: string): Span | undefined {
  return spans !== undefined && Object.prototype.hasOwnProperty.call(spans, key) ? spans[key] : undefined;
}

/**
 * Name as written, value, and whether a `=` was written: Vue reads `:foo` (the
 * same-name shorthand) and `:foo=""` (an error) differently, parse5 does not.
 */
function readAttrs(node: P5Node, location: P5Location, walk: Walk): Array<[string, string, boolean]> {
  const attrs: Array<[string, string, boolean]> = [];
  for (const attr of node.attrs ?? []) {
    const key = attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name;
    const rawName =
      rawAttrNameAt(walk.source, location.attrs, key) ??
      rawAttrNameAt(walk.source, location.attrs, key.toLowerCase());
    const span = ownSpan(location.attrs, key) ?? ownSpan(location.attrs, key.toLowerCase());
    if (rawName === undefined || span === undefined) {
      unsupported('has an attribute whose written name cannot be read');
    }
    const written = walk.source.slice(span.startOffset, span.endOffset);
    attrs.push([rawName, attr.value, written.slice(rawName.length).trimStart().startsWith('=')]);
  }
  return attrs;
}

function convertElement(node: P5Node, scope: Scope, walk: Walk, out: VNode[]): void {
  const location = node.sourceCodeLocation;
  const tag = node.tagName ?? '';
  if (!location || !location.startTag) {
    unsupported('has an element without a start tag in the source');
  }
  const startTag = location.startTag;
  advance(walk, startTag.startOffset, startTag.endOffset);
  const rawTag = rawTagNameAt(walk.source, startTag);
  if (rawTag === undefined || rawTag.toLowerCase() !== tag.toLowerCase()) {
    unsupported('has a tag name that cannot be read back');
  }
  bump(walk.startTags, tag.toLowerCase());
  walk.masks.push(...Object.values(location.attrs ?? {}));

  const isVoid = PARSE5_VOID.has(tag);
  if (isVoid && !VUE_VOID.has(rawTag)) {
    unsupported('has a void element Vue reads differently');
  }
  const written = walk.source.slice(startTag.startOffset, startTag.endOffset);
  const selfClosing = !isVoid && written.endsWith('/>');
  if (!isVoid) {
    if (selfClosing ? location.endTag !== undefined : !location.endTag || !endTagMatches(walk.source, location.endTag, tag.toLowerCase())) {
      unsupported('has an element whose end tag is missing or misplaced');
    }
  }

  const attrs = readAttrs(node, location, walk);
  const childScope: Scope = {
    ws: childWhitespaceContext(scope.ws, tag, node.attrs),
    vPre: scope.vPre || attrs.some(([name]) => name === 'v-pre'),
    textOnly: TEXT_ONLY_TAGS.has(tag)
  };
  const children: VNode[] = [];
  const lead = LEADING_NEWLINE_TAGS.has(tag)
    ? (/^(?:\r\n|\r|\n)/.exec(walk.source.slice(startTag.endOffset))?.[0] ?? '')
    : '';
  const element: VElement = { type: ELEMENT, tag: rawTag, attrs, selfClosing, lead, children };
  out.push(element);
  // parse5 nests what follows `<A />` inside A; Vue closes A at the slash.
  convertChildren(node, selfClosing ? scope : childScope, walk, selfClosing ? out : children);
  if (location.endTag) {
    bump(walk.endTags, tag.toLowerCase());
    walk.cursor = Math.max(walk.cursor, location.endTag.endOffset);
  }
}

function convertChildren(parent: P5Node, scope: Scope, walk: Walk, out: VNode[]): void {
  const list = [...(parent.content?.childNodes ?? []), ...(parent.childNodes ?? [])];
  for (const child of list) {
    if (child.nodeName === '#text') {
      convertText(child, scope, walk, out);
    } else if (child.nodeName === '#comment') {
      const location = child.sourceCodeLocation;
      if (!location) {
        unsupported('has a comment without a source position');
      }
      advance(walk, location.startOffset, location.endOffset);
      walk.masks.push(location);
      out.push({ type: COMMENT, text: child.data ?? '' });
    } else if (child.tagName === 'tbody' && !child.sourceCodeLocation && parent.tagName === 'table') {
      // `<table><tr>` : parse5 invents the <tbody> (no position in the source),
      // Vue keeps the rows as written. Its children are the table's own.
      convertChildren(child, scope, walk, out);
    } else if (child.tagName !== undefined) {
      convertElement(child, scope, walk, out);
    } else {
      unsupported('has a node that is neither text, comment nor element');
    }
  }
}

function bump(counts: Map<string, number>, name: string): void {
  counts.set(name, (counts.get(name) ?? 0) + 1);
}

/** Start or end tags written in the source, comments and attributes blanked out. */
function tagCounts(source: string, masks: readonly Span[], closing: boolean): Map<string, number> {
  const chars = source.split('');
  for (const span of masks) {
    chars.fill(' ', span.startOffset, span.endOffset);
  }
  const counts = new Map<string, number>();
  const pattern = closing ? /<\/([A-Za-z][^\s/>]*)/g : /<([A-Za-z][^\s/>]*)/g;
  for (const match of chars.join('').matchAll(pattern)) {
    bump(counts, match[1].toLowerCase());
  }
  return counts;
}

function sameCounts(a: Map<string, number>, b: Map<string, number>): boolean {
  return a.size === b.size && [...a].every(([name, count]) => b.get(name) === count);
}

function buildTree(source: string): VNode[] {
  if (REFUSED_TAG_SOURCE.test(source)) {
    unsupported('contains a tag parse5 and Vue read differently');
  }
  if (/\r(?!\n)/.test(source)) {
    // parse5 turns a lone CR into LF, Vue keeps it (inside <pre> it is drawn).
    unsupported('contains a lone carriage return');
  }
  const { parseHtmlFragment } = requireGuardHtmlChunk();
  let duplicate = false;
  const fragment = parseHtmlFragment(source, {
    sourceCodeLocationInfo: true,
    onParseError: (error: { code: string }) => {
      duplicate = duplicate || error.code === 'duplicate-attribute';
    }
  }) as unknown as P5Node;
  if (duplicate) {
    unsupported('has an element with a duplicate attribute');
  }
  const walk: Walk = { source, cursor: 0, startTags: new Map(), endTags: new Map(), masks: [] };
  const root: VNode[] = [];
  convertChildren(fragment, ROOT_SCOPE, walk, root);
  // A tag parse5 ignored (a stray end tag, a <td> outside a table, <body>) leaves
  // no trace in the tree: every tag written in the source must be in it.
  if (
    !sameCounts(tagCounts(source, walk.masks, false), walk.startTags) ||
    !sameCounts(tagCounts(source, walk.masks, true), walk.endTags)
  ) {
    unsupported('has a tag parse5 dropped or invented');
  }
  return root;
}

// --- compiler-core condenseWhitespace ---------------------------------------

/**
 * Port of compiler-core 3.5 `condenseWhitespace` (whitespace: 'condense', not
 * inside <pre>). `nodes[i - 1]` may be a removed (null) node, exactly as in the
 * original: a missing neighbour removes the whitespace node too.
 */
function condenseList(input: VNode[], keepComments: boolean): VNode[] {
  let nodes: Array<VNode | null> = input;
  if (!keepComments) {
    // Production builds never create the comment node, so the texts around it merge.
    const merged: VNode[] = [];
    for (const node of input) {
      const last = merged[merged.length - 1];
      if (node.type === COMMENT) {
        continue;
      }
      if (node.type === TEXT && last?.type === TEXT && last.raw === node.raw) {
        merged[merged.length - 1] = { ...last, text: last.text + node.text };
      } else {
        merged.push(node);
      }
    }
    nodes = merged;
  }
  const result = [...nodes];
  for (let i = 0; i < result.length; i += 1) {
    const node = result[i];
    if (node === null || node.type !== TEXT || node.raw) {
      continue;
    }
    if (isAllWhitespace(node.text)) {
      const prev = result[i - 1]?.type;
      const next = result[i + 1]?.type;
      const removable =
        !prev ||
        !next ||
        (prev === COMMENT && (next === COMMENT || next === ELEMENT)) ||
        (prev === ELEMENT && (next === COMMENT || (next === ELEMENT && hasNewline(node.text))));
      result[i] = removable ? null : { ...node, text: ' ' };
    } else {
      result[i] = { ...node, text: condenseText(node.text) };
    }
  }
  return result.filter((node): node is VNode => node !== null);
}

type Shape = string | boolean | Shape[];

function shapeOf(nodes: VNode[], keepComments: boolean): Shape[] {
  return condenseList(nodes, keepComments).map((node): Shape => {
    if (node.type === ELEMENT) {
      return [
        'e', node.tag, node.attrs.map(([name, value, hasValue]) => [name, value, hasValue]),
        node.selfClosing, node.lead, shapeOf(node.children, keepComments)
      ];
    }
    return [node.type === TEXT ? (node.raw ? 'r' : 't') : node.type === COMMENT ? 'c' : 'i', node.text];
  });
}

/** The template as Vue compiles it, in development and production builds. */
function compiledShape(source: string): string {
  const tree = buildTree(source);
  return JSON.stringify([shapeOf(tree, true), shapeOf(tree, false)]);
}

function rejected(reason: string): GuardVerdict {
  return { equivalent: false, reason };
}

/**
 * Whether two Vue template bodies compile to the same render tree. A chunk LOAD
 * failure propagates (it is the verifier failing, not a statement about the
 * file); anything else that stops the comparison is a rejection.
 */
export function vueTemplateEqual(input: string, output: string): GuardVerdict {
  const shapes: string[] = [];
  for (const [side, source] of [['input', input], ['output', output]] as const) {
    try {
      shapes.push(compiledShape(source));
    } catch (error: unknown) {
      if (isChunkLoadError(error)) {
        throw error;
      }
      if (error instanceof UnsupportedTemplate) {
        return rejected(`${side} Vue template ${error.message}; Tidy cannot prove the format keeps it`);
      }
      return rejected(`${side} Vue template did not parse`);
    }
  }
  return shapes[0] === shapes[1]
    ? { equivalent: true }
    : rejected('Vue template changed after formatting (as Vue condenses whitespace, names, attributes or interpolations)');
}
