// M3-1: where a `// prettier-ignore` directive applies, and whether a selection
// touches a node whose directive lies outside it.
//
// Two things are proved here. (1) The node each directive is said to govern is
// the node REAL Prettier prints verbatim: every shape below is also run through
// Prettier on the whole document, and the reported node must come back
// byte-for-byte from it, so this module cannot drift into naming a node Prettier
// would in fact reformat. (2) The selection rule: a directive outside the
// selection whose node the selection overlaps is the refused shape; everything
// else is not.
import assert from 'node:assert/strict';
import {
  __isChunkLoadedForTests,
  __resetChunksForTests
} from '../../../src/chunks/loader';
import { PrettierEngine } from '../../../src/engine/prettier';
import {
  checkSelectionAgainstPrettierIgnore,
  findPrettierIgnoredNodes,
  selectionExposesIgnoredNode,
  type IgnoredNode
} from '../../../src/engine/prettierIgnore';
import type { LangId } from '../../../src/types';
import { resolved } from '../../helpers/options';

interface Shape {
  readonly label: string;
  readonly lang: LangId;
  readonly source: string;
  /** The exact text of each node that must be reported as governed. */
  readonly nodes: readonly string[];
}

const SHAPES: readonly Shape[] = [
  {
    label: 'a statement',
    lang: 'typescriptreact',
    source:
      'const  a   =   1;\n// prettier-ignore\nconst matrix = [\n  1,0,0,\n  0,1,0\n];\nconst  b   =   2;\n',
    nodes: ['const matrix = [\n  1,0,0,\n  0,1,0\n];']
  },
  {
    label: 'a block-comment directive',
    lang: 'typescript',
    source: 'const  a   =   1;\n/* prettier-ignore */\nconst   x   =   [1,0,\n 0,1];\n',
    nodes: ['const   x   =   [1,0,\n 0,1];']
  },
  {
    label: 'an object property',
    lang: 'typescript',
    source:
      'const o = {\n  // prettier-ignore\n  key:   [1,0,\n          0,1],\n  other:   2\n};\n',
    nodes: ['key:   [1,0,\n          0,1]']
  },
  {
    label: 'a class member',
    lang: 'typescript',
    source:
      'class A {\n  // prettier-ignore\n  method( a,b ) { return   a+b }\n  other( ) {}\n}\n',
    nodes: ['method( a,b ) { return   a+b }']
  },
  {
    label: 'an exported declaration',
    lang: 'typescript',
    source: '// first\n// prettier-ignore\nexport const  a   =   [1,0,\n0,1];\nconst  b   =   2;\n',
    nodes: ['export const  a   =   [1,0,\n0,1];']
  },
  {
    label: 'a JSX attribute',
    lang: 'typescriptreact',
    source:
      'const v = (\n  <div\n    // prettier-ignore\n    style  =  {{a:1}}\n    id = "x"\n  />\n);\n',
    nodes: ['style  =  {{a:1}}']
  },
  {
    label: 'a JSX child behind {/* prettier-ignore */}',
    lang: 'typescriptreact',
    source:
      'const v = (\n  <div>\n    {/* prettier-ignore */}\n    <span   a = "1"   b = "2"   />\n    <p   x = "1"   >x</p>\n  </div>\n);\n',
    nodes: ['<span   a = "1"   b = "2"   />']
  },
  {
    label: 'a trailing comment, which governs the node before it',
    lang: 'typescript',
    source: 'const  a   =   [1,0,\n 0,1]; // prettier-ignore\nconst  b   =   2;\n',
    nodes: ['const  a   =   [1,0,\n 0,1];']
  },
  {
    label: 'a directive with nothing after it in the block',
    lang: 'typescript',
    source: 'function f() {\n  foo( 1,2 );\n  // prettier-ignore\n}\n',
    nodes: ['foo( 1,2 );']
  },
  {
    label: 'a TypeScript interface member',
    lang: 'typescript',
    source: 'interface I {\n  // prettier-ignore\n  a:   string;\n  b:   number;\n}\n',
    nodes: ['a:   string;']
  },
  {
    label: 'two directives',
    lang: 'typescript',
    source:
      '// prettier-ignore\nconst  a   =   [1,0,\n0,1];\nconst  m   =   3;\n// prettier-ignore\nconst  b   =   [2,\n 3];\n',
    nodes: ['const  a   =   [1,0,\n0,1];', 'const  b   =   [2,\n 3];']
  },
  {
    label: 'a decorated class',
    lang: 'typescript',
    source: 'const  m   =   3;\n// prettier-ignore\n@dec()\nclass  A  {  x  =  1  }\n',
    nodes: ['@dec()\nclass  A  {  x  =  1  }']
  },
  {
    label: 'a .jsx statement',
    lang: 'javascriptreact',
    source: 'const  a   =   1;\n// prettier-ignore\nconst   b   =   [1,0,\n 0,1];\n',
    nodes: ['const   b   =   [1,0,\n 0,1];']
  }
];

describe('engine/prettierIgnore : the node a directive governs is the node Prettier keeps verbatim', () => {
  for (const shape of SHAPES) {
    it(`${shape.label}: reported, and really preserved by Prettier`, async () => {
      const found = findPrettierIgnoredNodes(shape.lang, shape.source);
      assert.ok(found, 'the document must parse');
      const texts = found.map((node) => shape.source.slice(node.nodeStart, node.nodeEnd));
      assert.deepEqual(texts, shape.nodes);

      // The ground truth: format the WHOLE document with real Prettier.
      const out = await new PrettierEngine().format({
        languageId: shape.lang,
        code: shape.source,
        options: resolved()
      });
      for (const text of shape.nodes) {
        assert.ok(
          out.includes(text),
          `Prettier did not keep ${JSON.stringify(text)} verbatim; got ${JSON.stringify(out)}`
        );
      }
    });
  }
});

describe('engine/prettierIgnore : what is NOT a directive', () => {
  const NOT_DIRECTIVES: ReadonlyArray<readonly [string, string]> = [
    ['extra words in the comment', 'const  a   =   1;\n// prettier-ignore because it is a matrix\nconst  b   =   2;\n'],
    ['a doc comment', 'const  a   =   1;\n/** prettier-ignore */\nconst  b   =   2;\n'],
    ['a mention inside a longer sentence', 'const  a   =   1;\n// do not use prettier-ignore here\nconst  b   =   2;\n'],
    ['a string literal', 'const  a   =   "// prettier-ignore";\nconst  b   =   2;\n'],
    ['a template literal', 'const  a   =   `/* prettier-ignore */`;\nconst  b   =   2;\n'],
    ['no mention at all', 'const  a   =   1;\nconst  b   =   2;\n']
  ];

  for (const [label, source] of NOT_DIRECTIVES) {
    it(`${label} governs nothing`, () => {
      assert.deepEqual(findPrettierIgnoredNodes('typescript', source), []);
    });
  }

  it('a document that does not parse answers undefined, not an empty list', () => {
    assert.equal(
      findPrettierIgnoredNodes('typescript', '// prettier-ignore\nconst = = ;\n}}}\n'),
      undefined
    );
  });

  it('error recovery keeps a document with a small mistake analysable', () => {
    const found = findPrettierIgnoredNodes(
      'typescript',
      '// prettier-ignore\nconst  a   =   [1,0,\n0,1];\nlet x = 1; let x = 2;\n'
    );
    assert.ok(found, 'a duplicate declaration is recoverable');
    assert.equal(found.length, 1);
  });
});

describe('engine/prettierIgnore : the selection rule', () => {
  const SOURCE =
    'const  a   =   1;\n// prettier-ignore\nconst matrix = [\n  1,0,0,\n  0,1,0\n];\nconst  b   =   2;\n';
  const directiveAt = SOURCE.indexOf('// prettier-ignore');
  const directiveEnd = directiveAt + '// prettier-ignore'.length;
  const nodeStart = SOURCE.indexOf('const matrix');
  const nodeEnd = SOURCE.indexOf('];') + 2;
  const nodes: readonly IgnoredNode[] = [
    { directiveStart: directiveAt, directiveEnd, nodeStart, nodeEnd }
  ];

  const check = (start: number, end: number) =>
    checkSelectionAgainstPrettierIgnore('typescript', SOURCE, start, end);

  it('the refused shape: the node, without the directive above it', () => {
    assert.equal(check(nodeStart, nodeEnd), 'exposes');
    assert.equal(check(nodeStart, SOURCE.length), 'exposes');
  });

  it('a selection that also covers the directive is left to Prettier', () => {
    assert.equal(check(directiveAt, nodeEnd), 'safe');
    assert.equal(check(0, SOURCE.length), 'safe');
  });

  it('a selection inside the node exposes it too', () => {
    assert.equal(check(SOURCE.indexOf('  1,0,0'), SOURCE.indexOf('  0,1,0')), 'exposes');
  });

  it('a selection that reaches into the node from above, stopping short of the directive', () => {
    assert.equal(check(0, directiveAt), 'safe', 'it ends before the directive and the node');
    assert.equal(check(0, nodeStart), 'safe', 'it ends where the node starts: no overlap');
  });

  it('a selection that only starts where the node ends is unrelated', () => {
    assert.equal(check(nodeEnd, SOURCE.length), 'safe');
  });

  it('a selection elsewhere is safe', () => {
    assert.equal(check(0, SOURCE.indexOf('\n') + 1), 'safe');
    assert.equal(check(SOURCE.indexOf('const  b'), SOURCE.length), 'safe');
  });

  it('a selection cutting the directive itself does not hold it', () => {
    assert.equal(check(directiveAt + 3, nodeEnd), 'exposes');
  });

  it('selectionExposesIgnoredNode is the pure half of that rule', () => {
    assert.equal(selectionExposesIgnoredNode(nodes, nodeStart, nodeEnd), true);
    assert.equal(selectionExposesIgnoredNode(nodes, directiveAt, nodeEnd), false);
    assert.equal(selectionExposesIgnoredNode([], nodeStart, nodeEnd), false);
  });

  it('a node the mask layer already hands back verbatim is not exposed', () => {
    // A .js selection masks the marker line and the first line of the node; those
    // bytes never reach Prettier, so there is nothing to lose.
    assert.equal(
      selectionExposesIgnoredNode(nodes, nodeStart, nodeEnd, [{ start: nodeStart, end: nodeEnd }]),
      false
    );
    assert.equal(
      selectionExposesIgnoredNode(nodes, nodeStart, nodeEnd, [
        { start: nodeStart - 5, end: nodeStart + 20 },
        { start: nodeStart + 20, end: nodeEnd + 5 }
      ]),
      false,
      'adjoining spans add up'
    );
  });

  it('a node the mask only partly covers is still exposed', () => {
    assert.equal(
      selectionExposesIgnoredNode(nodes, nodeStart, nodeEnd, [
        { start: nodeStart, end: nodeStart + 10 }
      ]),
      true
    );
    assert.equal(
      selectionExposesIgnoredNode(nodes, nodeStart, nodeEnd, [
        { start: nodeStart, end: nodeStart + 10 },
        { start: nodeStart + 12, end: nodeEnd }
      ]),
      true,
      'a gap between two spans is not covered'
    );
    assert.equal(
      selectionExposesIgnoredNode(nodes, nodeStart, nodeEnd, [{ start: 0, end: nodeStart }]),
      true,
      'spans elsewhere cover nothing'
    );
  });

  it('coverage is judged on the part of the node the selection overlaps', () => {
    const inside = SOURCE.indexOf('  1,0,0');
    assert.equal(
      selectionExposesIgnoredNode(nodes, inside, SOURCE.indexOf('  0,1,0'), [
        { start: inside, end: SOURCE.indexOf('  0,1,0') }
      ]),
      false
    );
  });

  it('an unparsable document with a directive outside the selection answers unchecked', () => {
    const broken = '// prettier-ignore\nconst = = ;\n}}}\nconst  b   =   2;\n';
    assert.equal(
      checkSelectionAgainstPrettierIgnore('typescript', broken, broken.indexOf('const  b'), broken.length),
      'unchecked'
    );
  });

  it('a non-JS language is out of scope', () => {
    assert.equal(
      checkSelectionAgainstPrettierIgnore('css', '/* prettier-ignore */\n.a{color:red}\n', 22, 36),
      'safe'
    );
  });
});

describe('engine/prettierIgnore : a document with nothing to check never loads the parser', () => {
  beforeEach(() => {
    __resetChunksForTests();
  });
  after(() => {
    __resetChunksForTests();
  });

  it('no directive anywhere', () => {
    const text = 'const  a   =   1;\nconst  b   =   2;\n';
    assert.equal(checkSelectionAgainstPrettierIgnore('typescript', text, 0, text.length), 'safe');
    assert.equal(__isChunkLoadedForTests('chunk-guard-js'), false);
  });

  it('a mentioned directive does load it (only the parse can tell what it governs)', () => {
    const text = '// prettier-ignore\nconst  a   =   [1,\n 2];\nconst  c   =   3;\n';
    const start = text.indexOf('const  c');
    assert.equal(checkSelectionAgainstPrettierIgnore('typescript', text, start, text.length), 'safe');
    assert.equal(__isChunkLoadedForTests('chunk-guard-js'), true);
  });
});
