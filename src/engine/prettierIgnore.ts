// Where a `// prettier-ignore` directive applies, for the selection-scope refusal
// (M3-1): "does this selection touch a node that a directive OUTSIDE it protects?"
//
// THE PROBLEM. Prettier honours `// prettier-ignore` natively, but a selection
// format hands it ONLY the selected text. A directive that sits above the node
// it protects, outside the selection, is not in the text Prettier parses, so the
// protected node is reprinted as if it had no directive at all. The guard cannot
// object: the change is whitespace, which is exactly what it normalises away. The
// full fix (hand Prettier the whole document and map the answer back to a range)
// is deferred; until then the provider REFUSES that one shape, and this module
// supplies the facts it needs.
//
// WHICH NODE A DIRECTIVE GOVERNS. It is whichever node Prettier attaches the
// comment to, because Prettier then prints that node verbatim from the source.
// Prettier's attachment, reduced to what this needs:
//
//   - the ENCLOSING node is the deepest node that contains the comment; the
//     PRECEDING and FOLLOWING nodes are its neighbouring children;
//   - a comment on a line of its own governs the FOLLOWING node (the usual
//     `// prettier-ignore` above a statement, a property, a JSX attribute, a
//     class member); with nothing following it, the PRECEDING one;
//   - a comment that ends a line of code governs the PRECEDING node;
//   - a comment with code on both sides (`/* prettier-ignore */ x`) is reported
//     as governing BOTH neighbours, the one place this over-reports;
//   - JSX has its own form: `{/* prettier-ignore */}` governs the next JSX
//     element among its siblings, white space aside.
//
// Only a comment whose whole text is `prettier-ignore` counts, as in Prettier.
// Prettier's special re-routing of a few comment positions (before `else`, in a
// few function-argument shapes) is not reproduced: there this can name a
// neighbouring node, and the worst outcome is today's behaviour (no refusal), not
// a wrong write that is new.
//
// HOW IT READS THE CODE. One Babel parse of the DOCUMENT, in error-recovery mode,
// through the chunk the guard already loaded. The caller only asks when the
// document text mentions the directive, so a file without one pays nothing. A
// document that does not parse at all answers "unchecked" and the caller says so
// instead of staying silent.
//
// PURE and vscode-free.
import type { ParserOptions, ParserPlugin } from '@babel/parser';
import { requireGuardJsChunk } from '../chunks/loader';
import type { LangId } from '../types';

/** The whole text of a directive comment, once trimmed. */
const DIRECTIVE_TEXT = 'prettier-ignore';

/** What the selection check concluded. */
export type SelectionIgnoreCheck =
  /** No directive outside the selection governs a node the selection touches. */
  | 'safe'
  /** A directive OUTSIDE the selection governs a node the selection overlaps. */
  | 'exposes'
  /** A directive lies outside but the document could not be parsed to tell. */
  | 'unchecked';

/** A directive and the node Prettier would print verbatim because of it. */
export interface IgnoredNode {
  readonly directiveStart: number;
  readonly directiveEnd: number;
  readonly nodeStart: number;
  readonly nodeEnd: number;
}

/** The slice of a Babel node this module reads. */
interface AstNode {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly [key: string]: unknown;
}

interface AstComment {
  readonly type: string;
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

/** Where a comment sits among the nodes around it. */
interface Surroundings {
  /** Root to enclosing node, inclusive. */
  readonly chain: readonly AstNode[];
  readonly preceding?: AstNode;
  readonly following?: AstNode;
}

/** Node kinds a comment is never attached to: their children are used instead. */
const NON_ATTACHING_TYPES: ReadonlySet<string> = new Set([
  'EmptyStatement',
  'TemplateElement',
  'Import',
  'TSEmptyBodyFunctionExpression',
  'ChainExpression',
  'CommentBlock',
  'CommentLine'
]);

/** Babel node properties that hold no child node of the tree. */
const NON_CHILD_KEYS: ReadonlySet<string> = new Set([
  'loc',
  'range',
  'extra',
  'leadingComments',
  'trailingComments',
  'innerComments',
  'comments',
  'tokens',
  'errors'
]);

/**
 * The parser plugins, the SAME set the equivalence guard parses the document with
 * (safety/guard.ts): the provider only asks once the guard has accepted the
 * write, and that acceptance means the guard parsed this very document with this
 * very set, so this parse cannot fail where the guard's succeeded. `jsx` is left
 * out for plain `typescript` only, where an angle-bracket cast `<T>x` would be
 * read as an element.
 */
const BASE_PLUGINS: readonly ParserPlugin[] = [
  'typescript',
  'decorators-legacy',
  'decoratorAutoAccessors'
];
const JSX_PLUGINS: readonly ParserPlugin[] = [...BASE_PLUGINS, 'jsx'];

/** The languages this module can answer for: the JS family Prettier prints. */
const LANGUAGE_PLUGINS: Readonly<Partial<Record<LangId, readonly ParserPlugin[]>>> = {
  typescript: BASE_PLUGINS,
  typescriptreact: JSX_PLUGINS,
  javascriptreact: JSX_PLUGINS,
  javascript: JSX_PLUGINS
};

/** Whether this module can answer for the language at all. */
export function isPrettierIgnoreLanguage(languageId: LangId): boolean {
  return LANGUAGE_PLUGINS[languageId] !== undefined;
}

function isAstNode(value: unknown): value is AstNode {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as { type?: unknown; start?: unknown; end?: unknown };
  return (
    typeof candidate.type === 'string' &&
    typeof candidate.start === 'number' &&
    typeof candidate.end === 'number'
  );
}

/**
 * The child nodes a comment can attach to, in source order. A node kind that
 * cannot take a comment is replaced by its own children, as Prettier does.
 * Memoised per analysis: a file with many directives asks the same parents again
 * and again.
 */
function childNodesOf(node: AstNode, memo: Map<AstNode, readonly AstNode[]>): readonly AstNode[] {
  const cached = memo.get(node);
  if (cached !== undefined) {
    return cached;
  }
  const found: AstNode[] = [];
  for (const key of Object.keys(node)) {
    if (NON_CHILD_KEYS.has(key)) {
      continue;
    }
    const value = node[key];
    const candidates: readonly unknown[] = Array.isArray(value) ? value : [value];
    for (const candidate of candidates) {
      if (!isAstNode(candidate)) {
        continue;
      }
      if (NON_ATTACHING_TYPES.has(candidate.type)) {
        for (const inner of childNodesOf(candidate, memo)) {
          found.push(inner);
        }
      } else {
        found.push(candidate);
      }
    }
  }
  const sorted = found.sort((a, b) => a.start - b.start);
  memo.set(node, sorted);
  return sorted;
}

/** Descend from the root to the deepest node containing the comment. */
function locateComment(
  root: AstNode,
  comment: AstComment,
  memo: Map<AstNode, readonly AstNode[]>
): Surroundings {
  const chain: AstNode[] = [root];
  let enclosing = root;
  for (;;) {
    const children = childNodesOf(enclosing, memo);
    const containing = children.find(
      (child) => child.start <= comment.start && comment.end <= child.end
    );
    if (containing !== undefined) {
      chain.push(containing);
      enclosing = containing;
      continue;
    }
    let preceding: AstNode | undefined;
    let following: AstNode | undefined;
    for (const child of children) {
      if (child.end <= comment.start) {
        preceding = child;
      } else if (child.start >= comment.end && following === undefined) {
        following = child;
      }
    }
    return { chain, preceding, following };
  }
}

/** Only spaces and tabs lie between the start of the line and `index`. */
function startsItsLine(text: string, index: number): boolean {
  let cursor = index - 1;
  while (cursor >= 0 && (text[cursor] === ' ' || text[cursor] === '\t')) {
    cursor -= 1;
  }
  return cursor < 0 || text[cursor] === '\n' || text[cursor] === '\r';
}

/** Only spaces and tabs lie between `index` and the end of the line. */
function endsItsLine(text: string, index: number): boolean {
  let cursor = index;
  while (cursor < text.length && (text[cursor] === ' ' || text[cursor] === '\t')) {
    cursor += 1;
  }
  return text[cursor] === '\n' || text[cursor] === '\r';
}

function defined(...nodes: readonly (AstNode | undefined)[]): AstNode[] {
  return nodes.filter((node): node is AstNode => node !== undefined);
}

/**
 * Whitespace-only JSX text that holds a line break: Prettier skips it when it
 * looks for the sibling a `{/* prettier-ignore *\/}` container protects.
 */
function isSkippableJsxText(text: string, node: AstNode): boolean {
  if (node.type !== 'JSXText') {
    return false;
  }
  const raw = text.slice(node.start, node.end);
  return /^[ \n\r\t]*$/.test(raw) && raw.includes('\n');
}

/** The JSX element a `{/* prettier-ignore *\/}` container protects, if any. */
function jsxIgnoredSibling(text: string, chain: readonly AstNode[]): AstNode[] {
  const container = chain[chain.length - 2];
  const parent = chain[chain.length - 3];
  if (
    container === undefined ||
    parent === undefined ||
    container.type !== 'JSXExpressionContainer' ||
    (parent.type !== 'JSXElement' && parent.type !== 'JSXFragment')
  ) {
    return [];
  }
  const siblings = parent.children;
  if (!Array.isArray(siblings)) {
    return [];
  }
  const index = siblings.indexOf(container);
  if (index < 0) {
    return [];
  }
  for (let next = index + 1; next < siblings.length; next += 1) {
    const sibling: unknown = siblings[next];
    if (!isAstNode(sibling) || isSkippableJsxText(text, sibling)) {
      continue;
    }
    return sibling.type === 'JSXElement' || sibling.type === 'JSXFragment' ? [sibling] : [];
  }
  return [];
}

/** The nodes one directive comment governs (see the file header). */
function nodesGovernedBy(
  text: string,
  comment: AstComment,
  surroundings: Surroundings
): AstNode[] {
  const { chain, preceding, following } = surroundings;
  const enclosing = chain[chain.length - 1];
  if (enclosing.type === 'JSXEmptyExpression') {
    return jsxIgnoredSibling(text, chain);
  }
  if (enclosing.type === 'TSMappedType' && following?.type === 'TSTypeParameter') {
    return [enclosing]; // Prettier ignores the whole mapped type here
  }
  if (startsItsLine(text, comment.start)) {
    return defined(following ?? preceding);
  }
  if (endsItsLine(text, comment.end)) {
    return defined(preceding ?? following);
  }
  return defined(preceding, following);
}

/** The first byte of the node as Prettier prints it verbatim: decorators included. */
function startOfNode(node: AstNode): number {
  let start = node.start;
  const own = node.decorators;
  const declaration = node.declaration;
  const inherited = isAstNode(declaration) ? declaration.decorators : undefined;
  for (const list of [own, inherited]) {
    if (Array.isArray(list) && list.length > 0 && isAstNode(list[0])) {
      start = Math.min(start, list[0].start);
    }
  }
  return start;
}

/** Parse the document for the language, or undefined when it does not parse. */
function parseDocument(
  languageId: LangId,
  text: string
): { program: AstNode; comments: AstComment[] } | undefined {
  const plugins = LANGUAGE_PLUGINS[languageId];
  if (plugins === undefined) {
    return undefined;
  }
  // A chunk LOAD failure propagates, like everywhere the guard's chunk is used:
  // the caller reports it instead of treating "could not look" as "safe".
  const { parse } = requireGuardJsChunk();
  const options: ParserOptions = {
    sourceType: 'unambiguous',
    errorRecovery: true,
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    allowSuperOutsideMethod: true,
    allowUndeclaredExports: true,
    plugins: [...plugins]
  };
  try {
    const file = parse(text, options);
    return {
      program: file as unknown as AstNode,
      comments: (file.comments ?? []) as unknown as AstComment[]
    };
  } catch {
    return undefined; // not parseable as a whole: the caller says "unchecked"
  }
}

function isDirective(comment: AstComment): boolean {
  return (
    (comment.type === 'CommentLine' || comment.type === 'CommentBlock') &&
    comment.value.trim() === DIRECTIVE_TEXT
  );
}

/**
 * Every directive of the document with the node Prettier would print verbatim
 * because of it, or undefined when the document cannot be parsed. Exported for
 * the tests; the provider goes through {@link checkSelectionAgainstPrettierIgnore}.
 */
export function findPrettierIgnoredNodes(
  languageId: LangId,
  text: string
): readonly IgnoredNode[] | undefined {
  if (!text.includes(DIRECTIVE_TEXT)) {
    return [];
  }
  const parsed = parseDocument(languageId, text);
  if (parsed === undefined) {
    return undefined;
  }
  const memo = new Map<AstNode, readonly AstNode[]>();
  const found: IgnoredNode[] = [];
  for (const comment of parsed.comments) {
    if (!isDirective(comment)) {
      continue;
    }
    const surroundings = locateComment(parsed.program, comment, memo);
    for (const node of nodesGovernedBy(text, comment, surroundings)) {
      found.push({
        directiveStart: comment.start,
        directiveEnd: comment.end,
        nodeStart: startOfNode(node),
        nodeEnd: node.end
      });
    }
  }
  return found;
}

/**
 * A span of the DOCUMENT whose bytes are handed back verbatim by something other
 * than Prettier (the mask layer of a .js selection). Half-open.
 */
export interface CoveredSpan {
  readonly start: number;
  readonly end: number;
}

/** Whether [from, to) lies entirely inside the union of the (sorted) spans. */
function isCovered(from: number, to: number, covered: readonly CoveredSpan[]): boolean {
  let cursor = from;
  for (const span of covered) {
    if (span.start > cursor) {
      return false; // a gap no span reaches
    }
    cursor = Math.max(cursor, span.end);
    if (cursor >= to) {
      return true;
    }
  }
  return cursor >= to;
}

/**
 * Whether the selection overlaps a node whose directive is NOT inside the
 * selection, and whose overlapping bytes nothing else protects. A directive
 * inside the selection is in the text Prettier will parse, so it protects there
 * and is none of this module's business. A node the mask layer already puts
 * back byte for byte (`covered`) is protected too: a .js selection masks the
 * marker line and the first line of the node it marks, whichever printer runs.
 */
export function selectionExposesIgnoredNode(
  nodes: readonly IgnoredNode[],
  selectionStart: number,
  selectionEnd: number,
  covered: readonly CoveredSpan[] = []
): boolean {
  const sorted = [...covered].sort((a, b) => a.start - b.start);
  return nodes.some((node) => {
    if (selectionStart <= node.directiveStart && node.directiveEnd <= selectionEnd) {
      return false;
    }
    const from = Math.max(node.nodeStart, selectionStart);
    const to = Math.min(node.nodeEnd, selectionEnd);
    return from < to && !isCovered(from, to, sorted);
  });
}

/**
 * The refusal question for one selection. Cheap when it can be: a document that
 * never mentions the directive is answered "safe" before any parse. (The scan is
 * not narrowed to "outside the selection": a comment cut by the selection edge
 * has its keyword inside and its delimiter outside, and only the parse can tell.)
 */
export function checkSelectionAgainstPrettierIgnore(
  languageId: LangId,
  documentText: string,
  selectionStart: number,
  selectionEnd: number,
  covered: readonly CoveredSpan[] = []
): SelectionIgnoreCheck {
  if (!isPrettierIgnoreLanguage(languageId)) {
    return 'safe';
  }
  if (!documentText.includes(DIRECTIVE_TEXT)) {
    return 'safe';
  }
  const nodes = findPrettierIgnoredNodes(languageId, documentText);
  if (nodes === undefined) {
    return 'unchecked';
  }
  return selectionExposesIgnoredNode(nodes, selectionStart, selectionEnd, covered)
    ? 'exposes'
    : 'safe';
}
