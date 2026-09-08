// Idempotence corpus (SPEC SAFE-03): format(format(x)) === format(x).
// Cadrée comme protection "drift uniquement" : the "code creeps right on every
// save" review cluster ("my code moves to right", "adds 4 tabs instead of 2").
// Each entry is a representative input per language; the test formats it once,
// then formats the result again and asserts the second pass is a byte no-op.
//
// IGNORE MARKERS ARE PART OF THIS CORPUS. They were not, and the two defects
// that hid there drifted WITHOUT BOUND, silently, on a promise README.md makes
// in writing:
//   - HTML gained TWO SPACES before `<!-- tidy-ignore-start -->` on every single
//     format (2, 4, 6, 8 ...): the protected bytes carry the marker line's own
//     indentation, and the engine indented the placeholder on top of it;
//   - CSS/SCSS/LESS lost the line break after `/* tidy-ignore-end */`, gluing the
//     next selector onto the marker line, which the pass after that formatted
//     differently again.
// Both are restore-path defects (src/ignore/mask.ts), so a fixture only catches
// them if it is formatted THROUGH THE MASK PLAN, which is what
// test/unit/engine/idempotence.test.ts now does. Every marker shape that can
// change the answer is covered for every masking language (html, css, scss,
// less, javascript, json): head of file, middle, tail, indented, nested inside a
// block, and CRLF line endings, where the region's own '\r' sits inside the
// protected bytes and used to accumulate one per pass.
import type { LangId } from '../../src/types';

export interface IdempotenceFixture {
  id: string;
  lang: LangId;
  input: string;
  ref: string;
  /**
   * The fixture carries in-source tidy-ignore markers, so the test additionally
   * asserts that every marker LINE comes back byte-identical (its original
   * indentation, and nothing else joined onto it). Declared rather than sniffed
   * so a mistyped keyword shows up as a failing fixture instead of quietly
   * downgrading it to an ordinary drift case.
   */
  ignoreMarkers?: true;
}

/** Join lines with LF, the way the sources under test are written. */
const lf = (...lines: readonly string[]): string => lines.join('\n');

/** The same document with CRLF endings, to exercise the '\r' junction. */
const crlf = (...lines: readonly string[]): string => lines.join('\r\n');

/** Shared provenance for the marker fixtures added by the idempotence fix. */
const MARKER_REF = 'ignore-region drift: HTML +2 spaces/pass, CSS ate the break';

export const idempotenceFixtures: IdempotenceFixture[] = [
  {
    id: 'IDEM-JS',
    lang: 'javascript',
    input: 'const x=1;function f(a,b){return a+b;}',
    ref: 'review "my code moves to right"'
  },
  {
    id: 'IDEM-JS-NESTED',
    lang: 'javascript',
    input: 'if(a){if(b){doThing();}}',
    ref: 'review "code moves to right" (nesting drift)'
  },
  {
    id: 'IDEM-CSS',
    lang: 'css',
    input: '.a{color:red;margin:0}.b{padding:1px}',
    ref: 'drift cluster'
  },
  {
    id: 'IDEM-SCSS',
    lang: 'scss',
    input: '.card{.title{color:red}&:hover{color:blue}}',
    ref: 'drift cluster scss'
  },
  {
    id: 'IDEM-LESS',
    lang: 'less',
    input: '@c:red;.a{color:@c;.b{color:blue}}',
    ref: 'drift cluster less'
  },
  {
    id: 'IDEM-HTML',
    lang: 'html',
    input: '<div><ul><li>a</li><li>b</li></ul></div>',
    ref: '#82 "adds 4 tabs instead of 2", drift'
  },
  {
    id: 'IDEM-JSON',
    lang: 'json',
    input: '{"a":1,"b":{"c":[1,2,3]},"d":"x"}',
    ref: '#134 json drift'
  },
  {
    id: 'IDEM-TS',
    lang: 'typescript',
    input: 'interface I{a:number;b:string}function f<T>(x:T){return x}',
    ref: 'modern-syntax drift'
  },
  {
    id: 'IDEM-TSX',
    lang: 'typescriptreact',
    input: 'const A=()=><div className="x"><span>hi</span></div>;',
    ref: 'jsx drift'
  },
  {
    id: 'IDEM-JSX',
    lang: 'javascriptreact',
    input: 'function A(){return <ul><li>a</li><li>b</li></ul>;}',
    ref: 'jsx drift'
  },

  // ---------------------------------------------------------------- html
  {
    id: 'IDEM-HTML-IGNORE-HEAD',
    lang: 'html',
    ignoreMarkers: true,
    input: lf(
      '<!-- tidy-ignore-start -->',
      '<pre>   keep   me   </pre>',
      '<!-- tidy-ignore-end -->',
      '<div><p>x</p></div>',
      ''
    ),
    ref: MARKER_REF
  },
  {
    id: 'IDEM-HTML-IGNORE-MIDDLE',
    lang: 'html',
    ignoreMarkers: true,
    input: lf(
      '<div><p>x</p></div>',
      '<!-- tidy-ignore-start -->',
      '<pre>   keep   me   </pre>',
      '<!-- tidy-ignore-end -->',
      '<div><p>y</p></div>',
      ''
    ),
    ref: MARKER_REF
  },
  {
    id: 'IDEM-HTML-IGNORE-TAIL',
    lang: 'html',
    ignoreMarkers: true,
    input: lf(
      '<div><p>x</p></div>',
      '<!-- tidy-ignore-start -->',
      '<pre>   keep   me   </pre>',
      '<!-- tidy-ignore-end -->',
      ''
    ),
    ref: MARKER_REF
  },
  {
    id: 'IDEM-HTML-IGNORE-INDENTED',
    lang: 'html',
    ignoreMarkers: true,
    input: lf(
      '<div>',
      '    <!-- tidy-ignore-start -->',
      '    <pre>   keep   me   </pre>',
      '    <!-- tidy-ignore-end -->',
      '<p>y</p>',
      '</div>',
      ''
    ),
    ref: MARKER_REF
  },
  {
    id: 'IDEM-HTML-IGNORE-NESTED',
    lang: 'html',
    ignoreMarkers: true,
    input: lf(
      '<section>',
      '<div>',
      '  <!-- tidy-ignore-start -->',
      '  <table><tr><td>  1  </td></tr></table>',
      '  <!-- tidy-ignore-end -->',
      '<span>z</span>',
      '</div>',
      '</section>',
      ''
    ),
    ref: MARKER_REF
  },
  {
    id: 'IDEM-HTML-IGNORE-CRLF',
    lang: 'html',
    ignoreMarkers: true,
    input: crlf(
      '<div><p>x</p></div>',
      '<!-- tidy-ignore-start -->',
      '<pre>   keep   me   </pre>',
      '<!-- tidy-ignore-end -->',
      '<div><p>y</p></div>',
      ''
    ),
    ref: MARKER_REF
  },

  // ----------------------------------------------------------------- css
  {
    id: 'IDEM-CSS-IGNORE-HEAD',
    lang: 'css',
    ignoreMarkers: true,
    input: lf(
      '/* tidy-ignore-start */',
      '.raw   {   color : blue   }',
      '/* tidy-ignore-end */',
      '.b{color:green}',
      ''
    ),
    ref: MARKER_REF
  },
  {
    id: 'IDEM-CSS-IGNORE-MIDDLE',
    lang: 'css',
    ignoreMarkers: true,
    input: lf(
      '.a{color:red}',
      '/* tidy-ignore-start */',
      '.raw   {   color : blue   }',
      '/* tidy-ignore-end */',
      '.b{color:green}',
      ''
    ),
    ref: MARKER_REF
  },
  {
    id: 'IDEM-CSS-IGNORE-TAIL',
    lang: 'css',
    ignoreMarkers: true,
    input: lf(
      '.a{color:red}',
      '/* tidy-ignore-start */',
      '.raw   {   color : blue   }',
      '/* tidy-ignore-end */',
      ''
    ),
    ref: MARKER_REF
  },
  {
    id: 'IDEM-CSS-IGNORE-INDENTED',
    lang: 'css',
    ignoreMarkers: true,
    input: lf(
      '.a{color:red}',
      '    /* tidy-ignore-start */',
      '    .raw   {   color : blue   }',
      '    /* tidy-ignore-end */',
      '.b{color:green}',
      ''
    ),
    ref: MARKER_REF
  },
  {
    id: 'IDEM-CSS-IGNORE-NESTED',
    lang: 'css',
    ignoreMarkers: true,
    input: lf(
      '@media screen{',
      '.a{color:red}',
      '  /* tidy-ignore-start */',
      '  .raw   {   color : blue   }',
      '  /* tidy-ignore-end */',
      '.b{color:green}',
      '}',
      ''
    ),
    ref: MARKER_REF
  },
  {
    id: 'IDEM-CSS-IGNORE-CRLF',
    lang: 'css',
    ignoreMarkers: true,
    input: crlf(
      '.a{color:red}',
      '/* tidy-ignore-start */',
      '.raw   {   color : blue   }',
      '/* tidy-ignore-end */',
      '.b{color:green}',
      ''
    ),
    ref: MARKER_REF
  },

  // ---------------------------------------------------------------- scss
  {
    id: 'IDEM-SCSS-IGNORE-HEAD',
    lang: 'scss',
    ignoreMarkers: true,
    input: lf(
      '// tidy-ignore-start',
      '.raw   {   color : blue   }',
      '// tidy-ignore-end',
      '.card{.title{color:red}}',
      ''
    ),
    ref: MARKER_REF
  },
  {
    id: 'IDEM-SCSS-IGNORE-MIDDLE',
    lang: 'scss',
    ignoreMarkers: true,
    input: lf(
      '.card{.title{color:red}}',
      '/* tidy-ignore-start */',
      '.raw   {   color : blue   }',
      '/* tidy-ignore-end */',
      '.b{color:green}',
      ''
    ),
    ref: MARKER_REF
  },
  {
    id: 'IDEM-SCSS-IGNORE-TAIL',
    lang: 'scss',
    ignoreMarkers: true,
    input: lf(
      '.card{.title{color:red}}',
      '// tidy-ignore-start',
      '.raw   {   color : blue   }',
      '// tidy-ignore-end',
      ''
    ),
    ref: MARKER_REF
  },
  {
    id: 'IDEM-SCSS-IGNORE-INDENTED',
    lang: 'scss',
    ignoreMarkers: true,
    input: lf(
      '.a{color:red}',
      '  /* tidy-ignore-start */',
      '  .raw   {   color : blue   }',
      '  /* tidy-ignore-end */',
      '.b{color:green}',
      ''
    ),
    ref: MARKER_REF
  },
  {
    id: 'IDEM-SCSS-IGNORE-NESTED',
    lang: 'scss',
    ignoreMarkers: true,
    input: lf(
      '.card{',
      '.title{color:red}',
      '  /* tidy-ignore-start */',
      '  .raw   {   color : blue   }',
      '  /* tidy-ignore-end */',
      '&:hover{color:blue}',
      '}',
      ''
    ),
    ref: MARKER_REF
  },
  {
    id: 'IDEM-SCSS-IGNORE-CRLF',
    lang: 'scss',
    ignoreMarkers: true,
    input: crlf(
      '.card{.title{color:red}}',
      '/* tidy-ignore-start */',
      '.raw   {   color : blue   }',
      '/* tidy-ignore-end */',
      '.b{color:green}',
      ''
    ),
    ref: MARKER_REF
  },

  // ---------------------------------------------------------------- less
  {
    id: 'IDEM-LESS-IGNORE-HEAD',
    lang: 'less',
    ignoreMarkers: true,
    input: lf(
      '// tidy-ignore-start',
      '.raw   {   color : blue   }',
      '// tidy-ignore-end',
      '@c:red;.a{color:@c}',
      ''
    ),
    ref: MARKER_REF
  },
  {
    id: 'IDEM-LESS-IGNORE-MIDDLE',
    lang: 'less',
    ignoreMarkers: true,
    input: lf(
      '@c:red;',
      '/* tidy-ignore-start */',
      '.raw   {   color : @c   }',
      '/* tidy-ignore-end */',
      '.b{color:green}',
      ''
    ),
    ref: MARKER_REF
  },
  {
    id: 'IDEM-LESS-IGNORE-TAIL',
    lang: 'less',
    ignoreMarkers: true,
    input: lf(
      '@c:red;',
      '// tidy-ignore-start',
      '.raw   {   color : @c   }',
      '// tidy-ignore-end',
      ''
    ),
    ref: MARKER_REF
  },
  {
    id: 'IDEM-LESS-IGNORE-INDENTED',
    lang: 'less',
    ignoreMarkers: true,
    input: lf(
      '@c:red;',
      '   /* tidy-ignore-start */',
      '   .raw   {   color : @c   }',
      '   /* tidy-ignore-end */',
      '.b{color:green}',
      ''
    ),
    ref: MARKER_REF
  },
  {
    id: 'IDEM-LESS-IGNORE-NESTED',
    lang: 'less',
    ignoreMarkers: true,
    input: lf(
      '.card{',
      '.t{color:red}',
      '  // tidy-ignore-start',
      '  .raw   {   color : blue   }',
      '  // tidy-ignore-end',
      '.u{color:green}',
      '}',
      ''
    ),
    ref: MARKER_REF
  },
  {
    id: 'IDEM-LESS-IGNORE-CRLF',
    lang: 'less',
    ignoreMarkers: true,
    input: crlf(
      '@c:red;',
      '/* tidy-ignore-start */',
      '.raw   {   color : @c   }',
      '/* tidy-ignore-end */',
      '.b{color:green}',
      ''
    ),
    ref: MARKER_REF
  },

  // ------------------------------------------------------------ javascript
  {
    id: 'IDEM-JS-IGNORE-HEAD',
    lang: 'javascript',
    ignoreMarkers: true,
    input: lf(
      '// tidy-ignore-start',
      'const   RAW  =  [ 1,2 ]',
      '// tidy-ignore-end',
      'const x=1;function f(a,b){return a+b;}',
      ''
    ),
    ref: MARKER_REF
  },
  {
    id: 'IDEM-JS-IGNORE-MIDDLE',
    lang: 'javascript',
    ignoreMarkers: true,
    input: lf(
      'const a=1;',
      '// tidy-ignore-start',
      'const   RAW  =  [ 1,2 ]',
      '// tidy-ignore-end',
      'const b=3;',
      ''
    ),
    ref: MARKER_REF
  },
  {
    id: 'IDEM-JS-IGNORE-TAIL',
    lang: 'javascript',
    ignoreMarkers: true,
    input: lf(
      'const a=1;',
      '/* tidy-ignore-start */',
      'const   RAW  =  [ 1,2 ]',
      '/* tidy-ignore-end */',
      ''
    ),
    ref: MARKER_REF
  },
  {
    id: 'IDEM-JS-IGNORE-INDENTED',
    lang: 'javascript',
    ignoreMarkers: true,
    input: lf(
      'const a=1;',
      '    // tidy-ignore-start',
      '    const   RAW  =  [ 1,2 ]',
      '    // tidy-ignore-end',
      'const b=3;',
      ''
    ),
    ref: MARKER_REF
  },
  {
    id: 'IDEM-JS-IGNORE-NESTED',
    lang: 'javascript',
    ignoreMarkers: true,
    input: lf(
      'function f(){',
      'if(a){',
      '    // tidy-ignore-start',
      '    const   RAW  =  [ 1,2 ]',
      '    // tidy-ignore-end',
      'g();',
      '}',
      '}',
      ''
    ),
    ref: MARKER_REF
  },
  {
    id: 'IDEM-JS-IGNORE-CRLF',
    lang: 'javascript',
    ignoreMarkers: true,
    input: crlf(
      'const a=1;',
      '// tidy-ignore-start',
      'const   RAW  =  [ 1,2 ]',
      '// tidy-ignore-end',
      'const b=3;',
      ''
    ),
    ref: MARKER_REF
  },

  // ---------------------------------------------------------------- json
  {
    id: 'IDEM-JSON-IGNORE-HEAD',
    lang: 'json',
    ignoreMarkers: true,
    input: lf(
      '{',
      '// tidy-ignore-start',
      '"raw"   :   [ 1,2,   3 ],',
      '// tidy-ignore-end',
      '"b":2',
      '}',
      ''
    ),
    ref: MARKER_REF
  },
  {
    id: 'IDEM-JSON-IGNORE-MIDDLE',
    lang: 'json',
    ignoreMarkers: true,
    input: lf(
      '{',
      '"a":1,',
      '// tidy-ignore-start',
      '"raw"   :   [ 1,2,   3 ],',
      '// tidy-ignore-end',
      '"b":2',
      '}',
      ''
    ),
    ref: MARKER_REF
  },
  {
    id: 'IDEM-JSON-IGNORE-TAIL',
    lang: 'json',
    ignoreMarkers: true,
    input: lf(
      '{',
      '"a":1,',
      '// tidy-ignore-start',
      '"raw"   :   [ 1,2,   3 ]',
      '// tidy-ignore-end',
      '}',
      ''
    ),
    ref: MARKER_REF
  },
  {
    id: 'IDEM-JSON-IGNORE-INDENTED',
    lang: 'json',
    ignoreMarkers: true,
    input: lf(
      '{',
      '"a":1,',
      '    // tidy-ignore-start',
      '    "raw"   :   [ 1,2,   3 ],',
      '    // tidy-ignore-end',
      '"b":2',
      '}',
      ''
    ),
    ref: MARKER_REF
  },
  {
    id: 'IDEM-JSON-IGNORE-NESTED',
    lang: 'json',
    ignoreMarkers: true,
    input: lf(
      '{',
      '"outer":{',
      '  /* tidy-ignore-start */',
      '  "raw"   :   [ 1,2,   3 ],',
      '  /* tidy-ignore-end */',
      '"b":2',
      '}',
      '}',
      ''
    ),
    ref: MARKER_REF
  },
  {
    id: 'IDEM-JSON-IGNORE-CRLF',
    lang: 'json',
    ignoreMarkers: true,
    input: crlf(
      '{',
      '"a":1,',
      '"raw"   :   [ 1,2,   3 ],',
      '// tidy-ignore-start',
      '"kept"   :   4,',
      '// tidy-ignore-end',
      '"b":2',
      '}',
      ''
    ),
    ref: MARKER_REF
  }
];
